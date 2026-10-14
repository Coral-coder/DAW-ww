// AudioWorklet processor 'daw3-warp': one node per warped clip play, streaming WarpRenderer (core.js).
// Sample PCM is shared by every node of the context: the first node of a sample posts
// { type:'sample', id, sr, channels } and it is kept in this (per-context) global scope.
// processorOptions: { sampleId, when (ctx time of output t = 0), mode, curve, transpose, formants, quality, slices, srcRate }
// Messages in: { type:'stop', at } — silence from ctx time `at` on and end; { type:'curve', curve } — live tempo edit
// (new curve, same origin `when`; the renderer carries on seamlessly). Out: { type:'ended' }.
import { WarpRenderer } from './core.js';

const SAMPLES = new Map();

class WarpProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.o = options.processorOptions || {};
    this.r = null;
    this.stopAt = Infinity;
    this.ended = false;
    this.port.onmessage = (m) => {
      const d = m.data || {};
      if (d.type === 'sample') SAMPLES.set(d.id, { sr: d.sr, channels: d.channels });
      else if (d.type === 'stop') this.stopAt = Math.min(this.stopAt, d.at || 0);
      else if (d.type === 'curve' && d.curve?.length) { this.o.curve = d.curve; this.r?.setCurve(d.curve); }
    };
  }
  _end() { if (!this.ended) { this.ended = true; this.port.postMessage({ type: 'ended' }); } return false; }
  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const now = currentTime; // eslint-disable-line no-undef
    const sr = sampleRate; // eslint-disable-line no-undef
    if (now >= this.stopAt) return this._end();
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
    this.r.process(views, frames - first);
    if (this.r.done) return this._end();
    return true;
  }
}

registerProcessor('daw3-warp', WarpProcessor);
