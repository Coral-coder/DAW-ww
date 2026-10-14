// Audio inputs for recording: input-source abstraction, per-track channel routing, input monitoring, meters and
// sample-accurate capture. Browser-only, but every browser API is touched lazily (importing under Node is harmless).
//
// Input sources (`listInputSources()`): one per input device —
//   { id, label, kind: 'browser' | 'native', channels?: number }
//   browser: navigator.mediaDevices (getUserMedia device ids; 'default' = the system default input)
//   native:  window.daw3Native.audio (Mac app) when it offers
//              listInputs() -> [{ id, label, channels }]
//              openInput(ctx, id) -> { node: AudioNode (N channels), channels, latency (s), close() }
//            so multi-channel interfaces can expose all their inputs. Ids are prefixed 'native:'.
//
// Track model: track.recInput = { source: id, channels: [0] | [0, 1] | [n] } (absent: default source, first 1–2
// channels), track.monitor = 'off' | 'auto' | 'on' (absent = 'off').
//
// InputManager(engine, store): opens the sources armed / monitored tracks need (one getUserMedia stream + one
// 'daw3-capture' worklet per source), routes each track's channels to its monitor path (the track strip input, or
// straight to the output in low-latency mode), keeps per-track peak / clip meters and records every open source.
import { Emitter } from '../core/util.js';
import { monitorActive } from './timing.js';

const LAT_KEY = 'daw3-rec-latency';
export const DEFAULT_SOURCE = 'default';

export const isCaptureSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const native = () => (typeof window !== 'undefined' ? window.daw3Native?.audio : null) || null;

/** Available input sources (labels need a granted permission in browsers). */
export async function listInputSources() {
  const out = [{ id: DEFAULT_SOURCE, label: 'Default input', kind: 'browser' }];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    for (const d of devs) {
      if (d.kind !== 'audioinput' || d.deviceId === 'default' || !d.deviceId) continue;
      out.push({ id: d.deviceId, label: d.label || `Input ${out.length}`, kind: 'browser' });
    }
  } catch { /* */ }
  try {
    const n = native();
    if (n?.listInputs) for (const d of (await n.listInputs()) || []) out.push({ id: `native:${d.id}`, label: d.label || d.id, kind: 'native', channels: d.channels });
  } catch { /* */ }
  return out;
}

/** Open a source on `ctx` -> { node, channels, latency (s), label, close() }. */
export async function openInputSource(ctx, id) {
  if (String(id).startsWith('native:')) {
    const n = native();
    if (!n?.openInput) throw new Error('This input is only available in the daW³ app.');
    const h = await n.openInput(ctx, String(id).slice(7));
    return { node: h.node, channels: h.channels || h.node.channelCount || 2, latency: h.latency || 0, label: h.label || id, close: () => h.close?.() };
  }
  let stream;
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
  if (id && id !== DEFAULT_SOURCE) audio.deviceId = { exact: id };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
    const none = e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError';
    throw new Error(denied ? 'Microphone access was denied. Allow it in the browser\'s site settings to record audio.'
      : none ? 'That audio input was not found. Plug in a microphone or audio interface, or pick another input.'
      : `Could not open the audio input: ${e?.message || e}`);
  }
  const tr = stream.getAudioTracks()[0];
  const st = tr?.getSettings?.() || {};
  const node = ctx.createMediaStreamSource(stream);
  const channels = Math.max(1, Math.min(32, Number(st.channelCount) || node.channelCount || 1));
  return {
    node, channels, latency: Number(st.latency) > 0 ? Number(st.latency) : 0, label: tr?.label || id, stream,
    close: () => { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* */ } } },
  };
}

// ------------------------------------------------------------------------------------------- latency store
export function loadLatency() { try { return JSON.parse(localStorage.getItem(LAT_KEY) || '{}') || {}; } catch { return {}; } }
/** Per-device latency settings: { calibratedMs?, manualMs?, at? } (calibratedMs null = use the estimate). */
export function deviceLatency(id) { return loadLatency()[id || DEFAULT_SOURCE] || {}; }
export function setDeviceLatency(id, patch) {
  const all = loadLatency();
  const k = id || DEFAULT_SOURCE;
  all[k] = { ...(all[k] || {}), ...patch, at: new Date().toISOString() };
  try { localStorage.setItem(LAT_KEY, JSON.stringify(all)); } catch { /* */ }
  return all[k];
}

const trackSource = (t) => t.recInput?.source || DEFAULT_SOURCE;
/** Channels a track records from a source with `n` channels. */
export function trackChannels(t, n) {
  const want = Array.isArray(t.recInput?.channels) && t.recInput.channels.length ? t.recInput.channels : (n >= 2 ? [0, 1] : [0]);
  const ok = want.filter((c) => c >= 0 && c < n);
  return ok.length ? ok.slice(0, 2) : [0];
}

const workletLoaded = new WeakMap(); // ctx -> Promise<boolean> (true: the capture worklet is usable)
const WORKLET_TIMEOUT = 2500;
/** Load the capture worklet on ctx; resolves false when the browser can't (or stalls) — ScriptProcessor fallback. */
export function loadCaptureWorklet(ctx) {
  if (!workletLoaded.has(ctx)) {
    const add = ctx.audioWorklet && typeof globalThis.AudioWorkletNode === 'function'
      ? ctx.audioWorklet.addModule(new URL('./capture-processor.js', import.meta.url).href).then(() => true, () => false)
      : Promise.resolve(false);
    workletLoaded.set(ctx, Promise.race([add, new Promise((r) => setTimeout(() => r(false), WORKLET_TIMEOUT))]));
  }
  return workletLoaded.get(ctx);
}

const SCRIPT_N = 1024;
const PILOT_LEN = 65536; // frames per pilot ramp cycle
const PILOT_DIV = 131072; // pilot sample i = (i + 1) / PILOT_DIV: never 0 while running, exact in float32
const pilotBuffers = new WeakMap();

/**
 * Absolute context frame of a ScriptProcessor input block from the pilot channel (see createCaptureTap): `v` = the
 * block's first pilot sample, `f0` = frame the pilot started at, `estimate` = rough frame (from playbackTime) that
 * only has to be within ±PILOT_LEN/2. null without a pilot (not started yet). Pure.
 */
export function pilotFrame(v, f0, estimate) {
  if (!(v > 0)) return null;
  const idx = Math.round(v * PILOT_DIV) - 1;
  const k = Math.round((estimate - f0 - idx) / PILOT_LEN);
  return f0 + idx + k * PILOT_LEN;
}

/**
 * Capture tap: an input node + the same message protocol as capture-processor.js (peaks / chunk / stopped), from the
 * AudioWorklet (sample-exact: chunk frames are the render quantum's currentFrame) or — where AudioWorklet is
 * unavailable or stalls — a ScriptProcessorNode. A ScriptProcessor's input is not at a fixed distance from
 * e.playbackTime (Chromium 140: 2·N + 128…256 frames, varying block to block), so the fallback carries a pilot: an
 * extra input channel with a looping frame-index ramp started at a known frame; each block's absolute frame is read
 * from it (pilotFrame) — chunks are exact and contiguous, like the worklet's. tap.close() releases the fallback.
 */
export async function createCaptureTap(ctx, channels, onMessage) {
  if (await loadCaptureWorklet(ctx)) {
    const node = new AudioWorkletNode(ctx, 'daw3-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { channels },
    });
    node.port.onmessage = (e) => onMessage(e.data);
    return { node, kind: 'worklet', start: () => node.port.postMessage({ cmd: 'start' }), stop: () => node.port.postMessage({ cmd: 'stop' }) };
  }
  const N = SCRIPT_N, sr = ctx.sampleRate;
  // input (what callers connect to) -> split -> merge [channels…, pilot] -> ScriptProcessor -> silent sink
  const input = ctx.createGain();
  input.channelCount = channels; input.channelCountMode = 'explicit'; input.channelInterpretation = 'discrete';
  const split = ctx.createChannelSplitter(channels);
  const merge = ctx.createChannelMerger(channels + 1);
  input.connect(split);
  for (let c = 0; c < channels; c++) split.connect(merge, c, c);
  let pb = pilotBuffers.get(ctx);
  if (!pb) {
    pb = ctx.createBuffer(1, PILOT_LEN, sr);
    const d = pb.getChannelData(0);
    for (let i = 0; i < PILOT_LEN; i++) d[i] = (i + 1) / PILOT_DIV;
    pilotBuffers.set(ctx, pb);
  }
  const pilot = ctx.createBufferSource();
  pilot.buffer = pb; pilot.loop = true;
  const f0 = Math.ceil((ctx.currentTime + 0.05) * sr);
  pilot.start(f0 / sr);
  pilot.connect(merge, 0, channels);
  const node = ctx.createScriptProcessor(N, channels + 1, 1);
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'discrete';
  merge.connect(node);
  const mute = ctx.createGain(); mute.gain.value = 0;
  node.connect(mute); mute.connect(ctx.destination);
  let rec = false;
  const peaks = new Float32Array(channels);
  node.onaudioprocess = (e) => {
    const ib = e.inputBuffer;
    const data = [];
    for (let c = 0; c < channels; c++) {
      const d = ib.getChannelData(Math.min(c, ib.numberOfChannels - 1));
      let m = 0;
      for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
      peaks[c] = m;
      if (rec) data.push(d.slice());
    }
    onMessage({ type: 'peaks', peaks: Array.from(peaks) });
    if (!rec) return;
    // the block may skip render quanta (main thread late): read the pilot per quantum, one chunk per contiguous run
    const pc = ib.getChannelData(channels);
    let estimate = Math.round(e.playbackTime * sr) - 2 * N - 128;
    let run = -1, runFrame = 0;
    const emit = (end) => { if (run >= 0) onMessage({ type: 'chunk', frame: runFrame, data: run === 0 && end === N ? data : data.map((d) => d.slice(run, end)) }); };
    for (let q = 0; q < N; q += 128) {
      const f = pilotFrame(pc[q], f0, estimate + q);
      if (f == null) { emit(q); run = -1; continue; }
      if (run >= 0 && f === runFrame + (q - run)) continue;
      emit(q);
      run = q; runFrame = f; estimate = f - q;
    }
    emit(N);
  };
  return {
    node: input, kind: 'script',
    start: () => { rec = true; },
    stop: () => { rec = false; onMessage({ type: 'stopped' }); },
    close: () => { for (const n of [pilot, merge, split, node, mute]) { try { n.disconnect(); } catch { /* */ } } try { pilot.stop(); } catch { /* */ } node.onaudioprocess = null; },
  };
}

export class InputManager extends Emitter {
  constructor(engine, store, { getPrefs = () => ({}) } = {}) {
    super();
    this.engine = engine;
    this.store = store;
    this.getPrefs = getPrefs;
    this.sources = new Map(); // id -> { id, h, cap, sink, channels, peaks:[], hold:[], opening }
    this.routes = new Map(); // trackId -> { sourceId, chans, split, merge, mon, dest, an }
    this.clips = new Map(); // trackId -> clip latch
    this.errors = new Map(); // sourceId -> message
    this.recording = false;
    this.state = { playing: false, recording: false, punched: false, inPunch: true };
    this._ctx = null;
    engine.on?.('context', () => this.rebind());
  }

  get ctx() { return this.engine.ctx; }

  /** Tracks whose input should be open (armed audio tracks + tracks monitoring 'on'). */
  wanted(project = this.store.get()) {
    return project.tracks.filter((t) => t.type === 'audio' && (t.arm || t.monitor === 'on'));
  }

  /** Bring sources / routes in line with the project (called after every change). */
  async sync(project = this.store.get()) {
    if (!this.ctx) return;
    if (this._ctx !== this.ctx) { this._closeAll(); this._ctx = this.ctx; }
    const want = this.wanted(project);
    const need = new Set(want.map(trackSource));
    for (const id of need) if (!this.sources.has(id) && !this.errors.has(id)) await this._open(id).catch(() => {});
    if (!this.recording) for (const id of [...this.sources.keys()]) if (!need.has(id)) this._close(id);
    // routes
    const ids = new Set(want.map((t) => t.id));
    for (const id of [...this.routes.keys()]) if (!ids.has(id) && !this.recording) this._unroute(id);
    for (const t of want) this._route(t);
    this.updateMonitoring();
  }

  async _open(id) {
    if (!isCaptureSupported()) throw new Error('Audio recording needs a browser with microphone access (getUserMedia).');
    const ctx = this.ctx;
    const entry = { id, opening: true, peaks: [], hold: [] };
    this.sources.set(id, entry);
    try {
      const h = await openInputSource(ctx, id);
      if (this.sources.get(id) !== entry || this.ctx !== ctx) { h.close(); return; }
      const tap = await createCaptureTap(ctx, h.channels, (m) => this._onMessage(entry, m));
      if (this.sources.get(id) !== entry || this.ctx !== ctx) { h.close(); return; }
      const cap = tap.node;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      h.node.connect(cap);
      cap.connect(sink);
      sink.connect(ctx.destination);
      Object.assign(entry, { h, cap, tap, sink, channels: h.channels, label: h.label, opening: false, chunks: [] });
      this.errors.delete(id);
      for (const t of h.stream?.getAudioTracks?.() || []) t.addEventListener('ended', () => { this._close(id); this.emit('change'); });
      this.emit('change');
    } catch (e) {
      this.sources.delete(id);
      this.errors.set(id, e.message || String(e));
      this.emit('error', { source: id, message: e.message || String(e) });
      throw e;
    }
  }

  _onMessage(entry, m) {
    if (m.type === 'peaks') {
      entry.peaks = m.peaks;
      for (let c = 0; c < m.peaks.length; c++) entry.hold[c] = Math.max(m.peaks[c], (entry.hold[c] || 0) * 0.85);
      for (const [tid, r] of this.routes) {
        if (r.sourceId !== entry.id) continue;
        if (r.chans.some((c) => (m.peaks[c] || 0) >= 0.999)) this.clips.set(tid, true);
      }
    } else if (m.type === 'chunk') {
      if (entry.chunks) entry.chunks.push(m);
    } else if (m.type === 'stopped') {
      entry.stoppedAt = m.frame;
      entry.onStopped?.();
    }
  }

  _close(id) {
    const s = this.sources.get(id);
    this.sources.delete(id);
    if (!s || s.opening) return;
    for (const [tid, r] of this.routes) if (r.sourceId === id) this._unroute(tid);
    try { s.h.node.disconnect(); } catch { /* */ }
    try { s.cap.disconnect(); s.sink.disconnect(); } catch { /* */ }
    try { s.tap?.close?.(); } catch { /* */ }
    try { s.h.close(); } catch { /* */ }
  }

  _closeAll() {
    for (const id of [...this.routes.keys()]) this._unroute(id);
    for (const id of [...this.sources.keys()]) this._close(id);
  }

  /** The AudioContext was rebuilt (sample-rate change): reopen everything on the new one. */
  rebind() {
    if (this.recording) return;
    this._closeAll();
    this.errors.clear();
    this._ctx = this.ctx;
    this.sync().catch(() => {});
  }

  /** Forget failed sources so the next sync retries them (e.g. after the user granted access). */
  retry() { this.errors.clear(); return this.sync(); }

  _route(t) {
    const s = this.sources.get(trackSource(t));
    if (!s || s.opening) { this._unroute(t.id); return; }
    const chans = trackChannels(t, s.channels);
    const low = !!this.getPrefs().lowLatencyMonitor;
    const strip = this.engine.graph?.tracks?.get(t.id)?.strip;
    const dest = low ? this.ctx.destination : strip?.input || null;
    const key = `${s.id}|${chans.join(',')}|${low}`;
    let r = this.routes.get(t.id);
    if (r && r.key === key && r.src === s) {
      if (r.dest !== dest) { try { r.mon.disconnect(); } catch { /* */ } if (dest) r.mon.connect(dest); r.dest = dest; }
    } else {
      this._unroute(t.id);
      const ctx = this.ctx;
      const split = ctx.createChannelSplitter(Math.max(1, s.channels));
      s.h.node.connect(split);
      const merge = ctx.createChannelMerger(2);
      if (chans.length === 1) { split.connect(merge, chans[0], 0); split.connect(merge, chans[0], 1); }
      else { split.connect(merge, chans[0], 0); split.connect(merge, chans[1], 1); }
      const mon = ctx.createGain();
      mon.gain.value = 0;
      merge.connect(mon);
      if (dest) mon.connect(dest);
      r = { key, src: s, sourceId: s.id, chans, split, merge, mon, dest, on: false };
      this.routes.set(t.id, r);
    }
    r.low = low;
    r.vol = low ? (t.volume ?? 0.8) : 1;
  }

  _unroute(id) {
    const r = this.routes.get(id);
    if (!r) return;
    this.routes.delete(id);
    try { r.src.h.node.disconnect(r.split); } catch { /* */ }
    try { r.split.disconnect(); r.merge.disconnect(); r.mon.disconnect(); } catch { /* */ }
  }

  /** Transport / recording state for 'auto' monitoring. */
  setState(patch) { Object.assign(this.state, patch); this.updateMonitoring(); }

  updateMonitoring() {
    if (!this.ctx) return;
    const p = this.store.get();
    const t0 = this.ctx.currentTime;
    for (const [id, r] of this.routes) {
      const t = p.tracks.find((x) => x.id === id);
      const on = !!t && !t.mute && monitorActive(t.monitor || 'off', { armed: !!t.arm, ...this.state });
      const g = on ? r.vol : 0;
      if (r.on !== on || r.g !== g) { r.mon.gain.setTargetAtTime(g, t0, 0.01); r.on = on; r.g = g; }
    }
  }

  /** Is the input of this track monitored right now? */
  isMonitoring(trackId) { return !!this.routes.get(trackId)?.on; }

  /** Input level of a track: { peak 0..1+, clip (latched until clearClip) } or null when its input isn't open. */
  level(trackId) {
    const r = this.routes.get(trackId);
    if (!r) return null;
    const s = r.src;
    let m = 0;
    for (const c of r.chans) m = Math.max(m, s.hold[c] || 0);
    return { peak: m, clip: !!this.clips.get(trackId) };
  }
  clearClip(trackId) { this.clips.delete(trackId); }

  /** Monitoring latency estimate (ms) for a track: input + output (+ the plugin delay when not low-latency). */
  monitorLatencyMs(trackId) {
    const r = this.routes.get(trackId);
    const ctx = this.ctx;
    if (!r || !ctx) return null;
    const out = (Number(ctx.baseLatency) || 0) + (Number(ctx.outputLatency) || 0);
    return ((r.src.h.latency || 0) + out + (r.low ? 0 : (this.engine.graph?.latency || 0))) * 1000;
  }

  /** Browser estimate of the round trip for a source (s) when it has never been measured. */
  estimateRoundTrip(sourceId) {
    const ctx = this.ctx;
    const s = this.sources.get(sourceId);
    return ((Number(ctx?.baseLatency) || 0) + (Number(ctx?.outputLatency) || 0)) + (s?.h?.latency || 0);
  }

  /** Start capturing every open source. Returns the context frame (approx.) at which capture began. */
  startCapture() {
    this.recording = true;
    for (const s of this.sources.values()) {
      if (s.opening) continue;
      s.chunks = [];
      s.tap.start();
    }
    return Math.round(this.ctx.currentTime * this.ctx.sampleRate);
  }

  /** Stop capturing -> Map(sourceId -> { frame (first frame), channels: Float32Array[], sampleRate }). */
  async stopCapture() {
    const done = [];
    for (const s of this.sources.values()) {
      if (s.opening) continue;
      done.push(new Promise((resolve) => {
        const to = setTimeout(resolve, 1500);
        s.onStopped = () => { clearTimeout(to); s.onStopped = null; resolve(); };
        s.tap.stop();
      }));
    }
    await Promise.all(done);
    this.recording = false;
    const out = new Map();
    for (const s of this.sources.values()) {
      const chunks = s.chunks || [];
      s.chunks = [];
      if (!chunks.length) continue;
      chunks.sort((a, b) => a.frame - b.frame);
      const first = chunks[0].frame;
      const last = chunks[chunks.length - 1];
      const len = last.frame + last.data[0].length - first;
      const channels = Array.from({ length: s.channels }, () => new Float32Array(len));
      for (const ch of chunks) for (let c = 0; c < s.channels; c++) if (ch.data[c]) channels[c].set(ch.data[c], ch.frame - first);
      out.set(s.id, { frame: first, channels, sampleRate: this.ctx.sampleRate });
    }
    this.sync().catch(() => {});
    return out;
  }

  /** Channel data a track recorded (mono or stereo) from a stopCapture() result. */
  trackAudio(track, captured) {
    const sid = trackSource(track);
    const cap = captured.get(sid);
    if (!cap) return null;
    const chans = trackChannels(track, cap.channels.length);
    return { frame: cap.frame, sampleRate: cap.sampleRate, channels: chans.map((c) => cap.channels[c]), sourceId: sid };
  }

  dispose() { this._closeAll(); }
}
