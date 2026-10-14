// Audio input recording (microphone / line-in) for armed audio tracks. Browser-only: every
// browser API is touched lazily, so importing this module under Node is harmless.
//
//   const rec = new AudioRecorder(engine)
//   await rec.openInput()            getUserMedia (raw: no echo-cancel / noise-suppression / AGC)
//   rec.getLevel()                   input peak 0..1 (for meters, while the input is open)
//   await rec.start()                MediaRecorder running; resolves with the ctx time capture began
//   const take = await rec.stop()    { blob, mime, ctxStart, latency }
//   rec.closeInput()
//   rec.setMonitor(node|null)        route the live input into an AudioNode (e.g. a track strip)
//
// Timing: `ctxStart` is the AudioContext time at which the first captured sample was heard
// in the room, i.e. capture start minus (output + input latency). Callers convert it to a song
// beat with engine.beatAtTime(ctxStart).
import { Emitter } from '../core/util.js';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/wav'];

export function isRecordingSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof globalThis.MediaRecorder === 'function';
}

export function pickRecorderMime() {
  const MR = globalThis.MediaRecorder;
  if (!MR) return '';
  if (typeof MR.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((m) => { try { return MR.isTypeSupported(m); } catch { return false; } }) || '';
}

/** Rough round-trip latency compensation (seconds) for a context + input track. */
export function estimateLatency(ctx, track) {
  // native audio engine: the measured loopback round trip (Audio Settings → Measure) is exact
  const nat = globalThis.daw3NativeAudio;
  if (nat?.config?.enabled && Number(nat.config.latencyMs) > 0) return Math.min(1, nat.config.latencyMs / 1000);
  let lat = 0;
  if (ctx) lat += (Number(ctx.baseLatency) || 0) + (Number(ctx.outputLatency) || 0);
  try {
    const s = track?.getSettings?.();
    if (s && Number(s.latency) > 0) lat += Number(s.latency);
  } catch { /* */ }
  return Math.max(0, Math.min(1, lat));
}

export class AudioRecorder extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.monitorNode = null;
    this._opening = null;
    this._buf = null;
    this._peak = 0;
    this.ctxStart = null;
  }

  get supported() { return isRecordingSupported(); }
  get inputOpen() { return !!this.stream; }
  get isRecording() { return !!this.mediaRecorder && this.mediaRecorder.state !== 'inactive'; }

  /** Ask for the input device (idempotent). Rejects with a user-readable Error on denial. */
  openInput() {
    if (this.stream) return Promise.resolve(this.stream);
    if (this._opening) return this._opening;
    if (!this.supported) return Promise.reject(new Error('Audio recording is not supported in this browser.'));
    this._opening = (async () => {
      await this.engine.init();
      let stream;
      // Mac app with the native audio engine on: record from the chosen interface inputs instead
      const nat = globalThis.daw3NativeAudio;
      if (nat?.config?.enabled && nat.config.inputEnabled) {
        try { stream = await nat.inputStream(this.engine.ctx, { channels: this.nativeChannels || [0, 1] }); } catch (e) { console.warn('[recorder] native input', e); }
      }
      if (!stream) try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
        const none = e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError';
        throw new Error(denied ? 'Microphone access was denied. Allow it in the browser\'s site settings to record audio.'
          : none ? 'No audio input device was found. Plug in a microphone or audio interface.'
          : `Could not open the audio input: ${e?.message || e}`);
      }
      const ctx = this.engine.ctx;
      this.stream = stream;
      this.source = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this._buf = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      // keep the input graph pulled by the renderer (silent tap) so the analyser sees live data
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.analyser.connect(this.sink);
      this.sink.connect(ctx.destination);
      if (this.monitorNode) this.source.connect(this.monitorNode);
      for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => this.closeInput());
      this.emit('input', { open: true });
      return stream;
    })().finally(() => { this._opening = null; });
    return this._opening;
  }

  closeInput() {
    if (this.isRecording) return; // never cut a take short
    try { this.source?.disconnect(); } catch { /* */ }
    try { this.analyser?.disconnect(); } catch { /* */ }
    try { this.sink?.disconnect(); } catch { /* */ }
    this.sink = null;
    for (const t of this.stream?.getTracks() || []) { try { t.stop(); } catch { /* */ } }
    const was = !!this.stream;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this._peak = 0;
    if (was) this.emit('input', { open: false });
  }

  /** Input peak level (0..1, with meter-style decay). 0 while closed. */
  getLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._buf);
    let m = 0;
    for (let i = 0; i < this._buf.length; i++) { const a = Math.abs(this._buf[i]); if (a > m) m = a; }
    this._peak = Math.max(m, this._peak * 0.85);
    return this._peak;
  }

  /** Monitor the live input through `node` (e.g. an audio track's strip input). null = off. */
  setMonitor(node) {
    if (this.source && this.monitorNode) { try { this.source.disconnect(this.monitorNode); } catch { /* */ } }
    this.monitorNode = node || null;
    if (this.source && this.monitorNode) this.source.connect(this.monitorNode);
  }

  /** Start capturing. Resolves with the latency-compensated ctx time of the first sample. */
  async start() {
    if (this.isRecording) return this.ctxStart;
    await this.openInput();
    const ctx = this.engine.ctx;
    const mime = pickRecorderMime();
    const mr = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    this.chunks = [];
    this.mediaRecorder = mr;
    mr.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    const latency = estimateLatency(ctx, this.stream.getAudioTracks()[0]);
    const started = new Promise((resolve, reject) => {
      mr.onstart = () => resolve();
      mr.onerror = (e) => reject(e?.error || new Error('MediaRecorder error'));
    });
    mr.start(250);
    await started;
    this.latency = latency;
    this.ctxStart = ctx.currentTime - latency;
    this.emit('recording', { recording: true });
    return this.ctxStart;
  }

  /** Stop capturing -> { blob, mime, ctxStart, latency } (null when nothing was recorded). */
  stop() {
    const mr = this.mediaRecorder;
    if (!mr || mr.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      mr.onstop = () => {
        const mime = mr.mimeType || this.chunks[0]?.type || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];
        this.mediaRecorder = null;
        this.emit('recording', { recording: false });
        resolve(blob.size ? { blob, mime, ctxStart: this.ctxStart, latency: this.latency } : null);
      };
      try { mr.stop(); } catch { this.mediaRecorder = null; resolve(null); }
    });
  }

  dispose() {
    try { this.mediaRecorder?.stop(); } catch { /* */ }
    this.mediaRecorder = null;
    this.closeInput();
  }
}
