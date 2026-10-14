// Long-audio streaming (main thread side). Audio clips whose sample is longer than STREAM_MIN_SECONDS are not
// decoded into AudioBuffers: their PCM is cached in IndexedDB in chunks (stream-worker.js, a module Worker) and each
// clip play is an AudioWorkletNode ('daw3-stream', stream-processor.js) fed chunk by chunk over a MessagePort from
// the worker — a 10-minute stem costs a few hundred KB of RAM per playing voice instead of ~200 MB.
//
//   SampleStreamer.supported(ctx)                    realtime AudioContext + AudioWorklet + module Worker + IndexedDB
//   const s = new SampleStreamer(ctx, {onError})
//   await s.prepare(sampleId, sample)  -> meta       { key, frames, channels, sampleRate, chunkFrames, duration, peaks }
//                                                     (WAV is parsed in the worker; other formats are decoded once with
//                                                     decodeAudioData and handed over chunk by chunk; cached across
//                                                     sessions under key = id + data length)
//   s.handle(sampleId) -> meta | null                 ready to stream (null while preparing / for short samples)
//   s.play(meta, destination, when, offsetSec, durSec) -> voice { node, stop(time), onended }
//   isLongSample(sample)                              should this sample stream?
// Offline renders (export, freeze) never stream: they decode normally (render.js).
import { sampleToArrayBuffer } from '../../io/samples.js';

export const STREAM_MIN_SECONDS = 30;
const CHUNK_FRAMES = 32768;
const WORKLET_TIMEOUT = 6000;

/** Long enough to stream? Uses sample.duration, else estimates from the payload size (~1.4 MB/s for WAV). */
export function isLongSample(sample) {
  if (!sample) return false;
  if (Number(sample.duration) > 0) return sample.duration >= STREAM_MIN_SECONDS;
  const bytes = typeof sample.data === 'string' ? sample.data.length * 0.75 : (sample.data?.byteLength || 0);
  const wav = /wav/i.test(sample.mime || '') || /\.wav$/i.test(sample.name || '');
  return bytes / (wav ? 176400 : 24000) >= STREAM_MIN_SECONDS;
}

const workletLoaded = new WeakMap(); // ctx -> Promise

export class SampleStreamer {
  static supported(ctx) {
    return !!(ctx && ctx.audioWorklet && typeof AudioWorkletNode === 'function' && typeof Worker === 'function'
      && typeof indexedDB !== 'undefined' && !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext));
  }

  constructor(ctx, { onError } = {}) {
    this.ctx = ctx;
    this.onError = onError || ((e) => console.warn('[stream]', e));
    this.metas = new Map(); // sampleId -> meta
    this.preparing = new Map(); // sampleId -> Promise
    this.failed = new Set();
    this._seq = 0;
    this._calls = new Map();
    this.underruns = 0;
    this.worker = new Worker(new URL('./stream-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const c = this._calls.get(e.data?.id);
      if (!c) return;
      this._calls.delete(e.data.id);
      if (e.data.error) c.reject(new Error(e.data.error)); else c.resolve(e.data);
    };
    this.worker.onerror = (e) => this.onError(new Error(`Stream worker: ${e.message || 'failed'}`));
    if (!workletLoaded.has(ctx)) {
      // never wait forever: some browsers stall on addModule — streaming is then off and samples play from memory
      const add = ctx.audioWorklet.addModule(new URL('./stream-processor.js', import.meta.url).href);
      const stall = new Promise((_, reject) => setTimeout(() => reject(new Error('AudioWorklet did not load')), WORKLET_TIMEOUT));
      workletLoaded.set(ctx, Promise.race([add, stall]));
    }
    this.broken = false;
    this.ready = workletLoaded.get(ctx);
    this.ready.catch(() => { this.broken = true; });
  }

  _call(msg, transfer = []) {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  handle(id) { return this.metas.get(id) || null; }

  /** Is this sample streamed (long, and not failed)? Callers then must not decode it into a buffer for clips. */
  streams(id, sample) { return !this.broken && !this.failed.has(id) && isLongSample(sample); }

  prepare(id, sample) {
    if (this.metas.has(id)) return Promise.resolve(this.metas.get(id));
    if (this.preparing.has(id)) return this.preparing.get(id);
    const len = typeof sample.data === 'string' ? sample.data.length : (sample.data?.byteLength || 0);
    const p = (async () => {
      await this.ready;
      const base = `${id}:${len}`;
      // cached from an earlier session? (WAV keeps its own rate; decoded formats are cached at the context rate)
      for (const key of [base, `${base}@${this.ctx.sampleRate}`]) {
        const { meta } = await this._call({ cmd: 'lookup', key });
        if (meta) return meta;
      }
      const bytes = sampleToArrayBuffer(sample);
      const head = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
      const isWav = head.length >= 12 && String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WAVE';
      if (isWav) {
        try { return (await this._call({ cmd: 'wav', key: base, bytes, chunkFrames: CHUNK_FRAMES }, [bytes])).meta; } catch { /* unusual WAV: decode below */ }
      }
      const src = isWav ? sampleToArrayBuffer(sample) : bytes;
      const key = `${base}@${this.ctx.sampleRate}`;
      const tmp = new OfflineAudioContext(1, 1, this.ctx.sampleRate);
      let buf = await tmp.decodeAudioData(src);
      await this._call({ cmd: 'begin', key, frames: buf.length, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, chunkFrames: CHUNK_FRAMES });
      for (let idx = 0, from = 0; from < buf.length; idx++, from += CHUNK_FRAMES) {
        const data = [];
        for (let c = 0; c < buf.numberOfChannels; c++) data.push(buf.getChannelData(c).slice(from, Math.min(buf.length, from + CHUNK_FRAMES)));
        this.worker.postMessage({ cmd: 'chunk', key, idx, data }, data.map((d) => d.buffer));
      }
      buf = null; // the decoded copy can go now
      return (await this._call({ cmd: 'end', key })).meta;
    })().then((meta) => {
      meta.duration = meta.frames / meta.sampleRate;
      this.metas.set(id, meta);
      this.preparing.delete(id);
      return meta;
    }, (e) => {
      this.preparing.delete(id);
      this.failed.add(id);
      if (!this.broken) this.onError(new Error(`Could not stream "${sample.name}": ${e?.message || e} — it plays from memory instead.`));
      throw e;
    });
    this.preparing.set(id, p);
    return p;
  }

  /** Start a voice: plays [offsetSec, offsetSec + durSec) of the sample at ctx time `when` into `destination`. */
  play(meta, destination, when, offsetSec = 0, durSec = Infinity) {
    const sr = this.ctx.sampleRate;
    const ratio = meta.sampleRate / sr;
    const node = new AudioWorkletNode(this.ctx, 'daw3-stream', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [meta.channels],
      processorOptions: {
        channels: meta.channels, chunkFrames: meta.chunkFrames, frames: meta.frames, ratio,
        startFrame: Math.round(when * sr), offset: Math.round(offsetSec * meta.sampleRate),
        length: Number.isFinite(durSec) ? Math.round(durSec * sr) : undefined,
      },
    });
    const ch = new MessageChannel();
    this.worker.postMessage({ cmd: 'serve', key: meta.key, port: ch.port1 }, [ch.port1]);
    node.port.postMessage({ port: ch.port2 }, [ch.port2]);
    node.connect(destination);
    const voice = {
      node,
      onended: null,
      stop: (t = this.ctx.currentTime) => { node.port.postMessage({ stop: Math.round(t * sr) }); },
    };
    node.port.onmessage = (e) => {
      if (!e.data?.ended) return;
      this.underruns += e.data.underruns || 0;
      try { node.disconnect(); } catch { /* */ }
      voice.onended?.();
    };
    return voice;
  }

  /** Remove cached PCM of samples not in `keepIds` that were not used for a week. */
  evict(keepIds = []) {
    const keep = [];
    for (const id of keepIds) { const m = this.metas.get(id); if (m) keep.push(m.key); }
    return this._call({ cmd: 'evict', keep }).catch(() => ({ removed: 0 }));
  }

  dispose() { try { this.worker.terminate(); } catch { /* */ } }
}
