// Sampler: pitched (playbackRate) or sliced playback of a project sample with ADSR + filter.
import { clamp } from '../core/util.js';
import { BaseInstrument, Voice, envNote, getReversedBuffer, num } from './synth.js';

export class SamplerInstrument extends BaseInstrument {
  constructor(ctx, output, params, opts) {
    super(ctx, output, params, opts);
    this.type = 'sampler';
  }

  _buffer() {
    const id = this.params.sampleId;
    if (!id) return null;
    try { return this.opts.getSampleBuffer?.(id) || null; } catch { return null; }
  }

  noteOff(pitch, time) {
    if (this.params.oneShot) { this.held.delete(pitch); return; }
    super.noteOff(pitch, time);
  }

  _createVoice(t, pitch, vel, tOff, extra) {
    const buf0 = this._buffer();
    if (!buf0 || !buf0.length) return null;
    const ctx = this.ctx, p = this.params;
    const reverse = !!p.reverse;
    const buf = reverse ? getReversedBuffer(ctx, buf0) : buf0;
    const dur = buf.duration;
    let s0 = num(p.start, 0, 0, 1), s1 = num(p.end, 1, 0, 1);
    if (s1 <= s0 + 0.001) s1 = Math.min(1, s0 + 0.001);
    const root = num(p.rootNote, 60, 0, 127);
    const fineSemis = num(p.tune, 0, -48, 48) + num(p.fine, 0, -100, 100) / 100;
    const slices = Math.round(num(p.slices, 0, 0, 128));
    let rate;
    if (slices > 0) {
      const idx = Math.round(pitch - root);
      if (idx < 0 || idx >= slices) return null;
      const w = (s1 - s0) / slices;
      s0 = s0 + idx * w; s1 = s0 + w;
      rate = Math.pow(2, fineSemis / 12);
    } else {
      rate = Math.pow(2, (pitch - root + fineSemis) / 12);
    }
    rate = clamp(rate, 0.01, 32);
    // reversed buffer: map the [start,end] window onto the flipped timeline
    const segStart = (reverse ? 1 - s1 : s0) * dur;
    const segLen = (s1 - s0) * dur;

    const v = new Voice(ctx);
    v.pitch = pitch; v.vel = vel; v.start = t; v.envs = [];
    const src = v.src(ctx.createBufferSource());
    src.buffer = buf;
    src.playbackRate.value = rate;
    const loop = !!p.loop && slices === 0 && !p.oneShot;
    if (loop) {
      src.loop = true;
      let ls = num(p.loopStart, 0, 0, 1), le = num(p.loopEnd, 1, 0, 1);
      if (le <= ls + 0.001) le = Math.min(1, ls + 0.001);
      // loop points are fractions of the [start,end] window
      const a = segStart + ls * segLen, b = segStart + le * segLen;
      src.loopStart = reverse ? segStart + (1 - le) * segLen : a;
      src.loopEnd = reverse ? segStart + (1 - ls) * segLen : b;
    }
    let node = src;
    const cutoff = num(extra.cutoff ?? p.cutoff, 20000, 20, 20000);
    if (cutoff < 19000 || num(p.resonance, 0) > 0.05) {
      const f = v.node(ctx.createBiquadFilter());
      f.type = 'lowpass';
      f.frequency.value = clamp(cutoff, 20, ctx.sampleRate / 2 - 100);
      f.Q.value = -3 + num(p.resonance, 0, 0, 1) * 24;
      node.connect(f); node = f;
    }
    const amp = v.node(ctx.createGain());
    amp.gain.value = 0;
    node.connect(amp); node = amp;
    v.amp = amp;
    const vs = num(p.velSens, 0.6, 0, 1);
    const peak = 0.9 * (1 - vs + vs * vel);
    const playLen = segLen / rate; // seconds of output for one pass
    const oneShot = !!p.oneShot || slices > 0 && p.oneShot !== false && tOff == null;
    let off = tOff;
    if (oneShot) off = t + playLen;
    else if (!loop) off = off == null ? null : Math.min(off, t + playLen);
    v.ampSt = envNote(amp.gain, t, off, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, peak, 0);
    v.ampSt.peak0 = peak; v.ampSt.sus0 = peak * clamp(num(p.sustain, 1), 0, 1);
    v.envs.push([amp.gain, v.ampSt]);
    if (extra.pan != null) {
      const pn = v.node(ctx.createStereoPanner());
      pn.pan.value = num(extra.pan, 0, -1, 1);
      node.connect(pn); node = pn;
    }
    node.connect(this.out.input);
    if (loop) src.start(t, segStart);
    else src.start(t, segStart, segLen);
    src.onended = () => v.cleanup();
    if (off != null) v.stopAt(off + v.ampSt.r + 0.02);
    else if (!loop) v.end = t + playLen + 0.02; // ends naturally
    return v;
  }
}
