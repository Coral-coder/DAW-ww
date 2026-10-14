// AudioWorklet processor 'daw3-warp': one node per warped clip play, streaming WarpRenderer (core.js).
// Sample PCM is shared by every node of the context: the first node of a sample posts
// { type:'sample', id, sr, channels } and it is kept in this (per-context) global scope.
// processorOptions: { sampleId, when (ctx time of output t = 0), mode, curve, transpose, formants, quality, slices, srcRate,
//                     stream? }
// Streamed (long) samples: processorOptions.stream = { frames, channels, chunkFrames } and a { port } message (to the
// stream worker, protocol of stream-processor.js: { need: idx } -> { chunk: idx, data }) instead of the PCM — the
// source lives in a sliding SourceWindow (window.js) that follows renderer.neededRange(); a block whose source is not
// loaded yet renders silence (counted as an underrun) and the clip stays in time.
// Messages in: { type:'stop', at } — silence from ctx time `at` on and end; { type:'curve', curve } — live tempo edit
// (new curve, same origin `when`; the renderer carries on seamlessly). Out: { type:'ended' }.
import { WarpRenderer } from './core.js';
import { SourceWindow } from './window.js';

const SAMPLES = new Map();

class WarpProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.o = options.processorOptions || {};
    this.r = null;
    this.stopAt = Infinity;
    this.ended = false;
    this.underruns = 0;
    const st = this.o.stream;
    if (st) {
      this.win = new SourceWindow({ channels: st.channels, frames: st.frames, chunkFrames: st.chunkFrames, request: (k) => this.worker?.postMessage({ need: k }) });
    }
    this.port.onmessage = (m) => {
      const d = m.data || {};
      if (d.port) {
        this.worker = d.port;
        this.worker.onmessage = (ev) => { if (ev.data?.chunk != null) this.win.onChunk(ev.data.chunk, ev.data.data); };
        for (const k of this.win.requested) this.worker.postMessage({ need: k });
      } else if (d.type === 'sample') SAMPLES.set(d.id, { sr: d.sr, channels: d.channels });
      else if (d.type === 'stop') this.stopAt = Math.min(this.stopAt, d.at || 0);
      else if (d.type === 'curve' && d.curve?.length) { this.o.curve = d.curve; this.r?.setCurve(d.curve); }
    };
  }
  _end() {
    if (!this.ended) { this.ended = true; this.port.postMessage({ type: 'ended', underruns: this.underruns }); try { this.worker?.close(); } catch { /* */ } }
    return false;
  }
  _streamRenderer(sr) {
    const w = this.win;
    const r = new WarpRenderer({ ...this.o, channels: w.channels, window: { mono: w.mono, frames: w.frames }, srcRate: this.o.srcRate, outRate: sr });
    w.ensure(...r.neededRange(Math.round(0.25 * sr))); // prefetch the start
    return r;
  }
  /** Streamed source: load what the next `frames` read; false (silence, renderer still advances) when late. */
  _feed(frames) {
    const w = this.win;
    const ok = w.ensure(...this.r.neededRange(frames)); // (also requests `ahead` chunks beyond)
    this.r.base = w.base;
    return ok;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const now = currentTime; // eslint-disable-line no-undef
    const sr = sampleRate; // eslint-disable-line no-undef
    if (now >= this.stopAt) return this._end();
    if (!this.r && this.win) {
      this.r = this._streamRenderer(sr);
      const late = Math.round((now - this.o.when) * sr); // created after its start: skip ahead (stays in time)
      if (late > 0) { const skip = [new Float32Array(late), new Float32Array(late)]; this.r.process(skip, late); }
    }
    if (!this.r) {
      const smp = SAMPLES.get(this.o.sampleId);
      if (!smp) return now < this.o.when + 2; // PCM not here yet: wait (give up 2 s after the start)
      this.r = new WarpRenderer({ ...this.o, channels: smp.channels, srcRate: smp.sr || this.o.srcRate, outRate: sr });
      // started late (PCM arrived after `when`): skip ahead so the clip stays in time
      const late = Math.round((now - this.o.when) * sr);
      if (late > 0) { const skip = [new Float32Array(late), new Float32Array(late)]; this.r.process(skip, late); }
    }
    let first = 0;
    if (now < this.o.when) {
      first = Math.round((this.o.when - now) * sr);
      if (first >= frames) return true;
    }
    const views = out.map((ch) => ch.subarray(first));
    while (views.length < 2) views.push(new Float32Array(frames - first));
    if (this.win && !this._feed(frames - first)) {
      // source not loaded yet: keep time (render, then silence this block)
      this.underruns++;
      this.r.process(views, frames - first);
      for (const v of views) v.fill(0);
    } else this.r.process(views, frames - first);
    if (this.r.done) return this._end();
    return true;
  }
}

registerProcessor('daw3-warp', WarpProcessor);
