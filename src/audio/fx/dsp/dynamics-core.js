// Dynamics DSP for the multiband compressor, transient shaper, de-esser, expander / gate and dynamic EQ.
// Pure JS (Node-testable); the AudioWorklet processors in ../dynamics-worklet.js wrap these cores.
//
// Every core processes planar blocks: process(ins, outs, n) with ins/outs = [Float32Array L, Float32Array R]
// (a mono input passes the same array twice). Parameters are plain fields set through set({...}); a core keeps
// meters (min gain reduction / max boost since the last readMeter()) for the effect card.
import { rbjCoefs, dbToLin, linToDb } from './curve-math.js';

export { dbToLin, linToDb };

/** One-pole coefficient for a time constant (seconds) at sample rate sr (0 → instant). */
export function timeCoef(sec, sr) { return sec > 0 ? Math.exp(-1 / (sec * sr)) : 0; }

// ------------------------------------------------------------------------------------ gain computers (static curves)
/** Downward compressor: gain change in dB (<= 0) for an input level in dB. Soft knee of width `knee` dB. */
export function compressGain(levelDb, thr, ratio, knee = 0) {
  const slope = 1 - 1 / Math.max(1, ratio);
  const over = levelDb - thr;
  if (knee > 0 && 2 * Math.abs(over) <= knee) return (-slope * (over + knee / 2) ** 2) / (2 * knee);
  return over > 0 ? -slope * over : 0;
}

/**
 * Upward compressor: gain change in dB (>= 0) that lifts levels below the threshold towards it, capped at maxBoost.
 * Below `floor` + 12 dB the boost fades out so silence and noise are never pulled up.
 */
export function upwardGain(levelDb, thr, ratio, knee = 0, maxBoost = 24, floor = -90) {
  const slope = 1 - 1 / Math.max(1, ratio);
  const under = thr - levelDb;
  let g;
  if (knee > 0 && 2 * Math.abs(under) <= knee) g = (slope * (under + knee / 2) ** 2) / (2 * knee);
  else g = under > 0 ? slope * under : 0;
  g = Math.min(g, maxBoost);
  if (levelDb < floor + 12) g *= Math.max(0, (levelDb - floor) / 12);
  return g;
}

/** Downward expander (1:ratio below the threshold): gain change in dB, between `range` (<= 0) and 0. */
export function expandGain(levelDb, thr, ratio, range = -80, knee = 0) {
  const slope = Math.max(1, ratio) - 1;
  const under = thr - levelDb;
  let g;
  if (knee > 0 && 2 * Math.abs(under) <= knee) g = (-slope * (under + knee / 2) ** 2) / (2 * knee);
  else g = under > 0 ? -slope * under : 0;
  return Math.max(Math.min(0, range), g);
}

/**
 * Dynamic-EQ amount: how many dB (>= 0, before the range clamp) a band moves for a detector level.
 * mode 'above': grows as the level rises over the threshold; 'below': as it falls under it. Soft knee.
 */
export function dynamicAmount(levelDb, thr, ratio, mode = 'above', knee = 4) {
  const x = mode === 'below' ? 2 * thr - levelDb : levelDb; // mirror around the threshold
  return -compressGain(x, thr, ratio, knee);
}

// ------------------------------------------------------------------------------------ envelope followers
/** Peak envelope follower on |x| with separate attack / release (seconds). */
export class EnvelopeFollower {
  constructor(sr, attack = 0.001, release = 0.1) { this.sr = sr; this.y = 0; this.set(attack, release); }
  set(attack, release) {
    if (attack === this._at && release === this._rt) return;
    this._at = attack; this._rt = release;
    this.a = timeCoef(attack, this.sr); this.r = timeCoef(release, this.sr);
  }
  process(x) {
    const v = x < 0 ? -x : x;
    const c = v > this.y ? this.a : this.r;
    this.y = c * this.y + (1 - c) * v;
    return this.y;
  }
  reset() { this.y = 0; }
}

/** Smooths a gain (dB): `rise` coefficient when the gain goes up, `fall` when it goes down. */
export class GainSmoother {
  constructor(sr, rise = 0.05, fall = 0.001) { this.sr = sr; this.y = 0; this.set(rise, fall); }
  set(rise, fall) {
    if (rise === this._rt && fall === this._ft) return;
    this._rt = rise; this._ft = fall;
    this.r = timeCoef(rise, this.sr); this.f = timeCoef(fall, this.sr);
  }
  process(target) {
    const c = target > this.y ? this.r : this.f;
    this.y = c * this.y + (1 - c) * target;
    return this.y;
  }
}

// ------------------------------------------------------------------------------------ filters
/** Transposed direct form II biquad (one channel). */
export class Biquad {
  constructor(c) { this.z1 = 0; this.z2 = 0; this.c = c || { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }; }
  setCoefs(c) { this.c = c; }
  process(x) {
    const c = this.c;
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}

const BW_Q = Math.SQRT1_2;

/**
 * Linkwitz-Riley 4th-order (24 dB/oct) two-way split for one channel: low = LP2·LP2, high = HP2·HP2 (Butterworth
 * sections). low + high is the 2nd-order allpass at fc (flat magnitude), so a crossover tree sums back flat.
 */
export class LR4 {
  constructor(sr, fc) { this.sr = sr; this.l1 = new Biquad(); this.l2 = new Biquad(); this.h1 = new Biquad(); this.h2 = new Biquad(); this.fc = 0; this.setFreq(fc); }
  setFreq(fc) {
    if (fc === this.fc) return;
    this.fc = fc;
    const lp = rbjCoefs('lowpass', fc, BW_Q, 0, this.sr), hp = rbjCoefs('highpass', fc, BW_Q, 0, this.sr);
    this.l1.setCoefs(lp); this.l2.setCoefs(lp); this.h1.setCoefs(hp); this.h2.setCoefs(hp);
  }
  /** Returns the low part; the high part is left in this.hi. */
  split(x) {
    this.hi = this.h2.process(this.h1.process(x));
    return this.l2.process(this.l1.process(x));
  }
}

/** The allpass an LR4 split at fc adds to the sum (phase compensation for the bands that skip that split). */
export class LRAllpass {
  constructor(sr, fc) { this.sr = sr; this.bq = new Biquad(); this.fc = 0; this.setFreq(fc); }
  setFreq(fc) { if (fc !== this.fc) { this.fc = fc; this.bq.setCoefs(rbjCoefs('allpass', fc, BW_Q, 0, this.sr)); } }
  process(x) { return this.bq.process(x); }
}

/**
 * N-band (2..4) Linkwitz-Riley crossover for one channel. Split tree: x → (f1) low | rest → (f2) … ; every band is
 * passed through the allpasses of the splits it did not go through, so all bands share the same phase and their
 * sum is allpass (flat magnitude) — the bands can be processed and summed without comb filtering.
 */
export class Crossover {
  constructor(sr, freqs) {
    this.sr = sr;
    this.n = freqs.length + 1;
    this.splits = freqs.map((f) => new LR4(sr, f));
    // band k (k < n-1) needs allpasses for splits k+1 .. n-2
    this.ap = [];
    for (let k = 0; k < this.n; k++) this.ap.push(freqs.map((f, j) => (j > k ? new LRAllpass(sr, f) : null)).filter((a, j) => j > k));
    this.out = new Float64Array(this.n);
  }
  setFreqs(freqs) {
    freqs.forEach((f, j) => {
      this.splits[j].setFreq(f);
      for (let k = 0; k < j; k++) this.ap[k][j - k - 1].setFreq(f);
    });
  }
  /** Splits one sample; returns this.out (length n, band 0 = lowest). */
  process(x) {
    let rest = x;
    const o = this.out;
    for (let j = 0; j < this.splits.length; j++) {
      const s = this.splits[j];
      o[j] = s.split(rest);
      rest = s.hi;
    }
    o[this.n - 1] = rest;
    for (let k = 0; k < this.n - 1; k++) { let v = o[k]; for (const a of this.ap[k]) v = a.process(v); o[k] = v; }
    return o;
  }
}

/** Integer-sample delay line (look-ahead). */
export class DelayLine {
  constructor(max) { this.buf = new Float32Array(Math.max(1, max + 1)); this.i = 0; this.d = 0; }
  setDelay(d) { this.d = Math.max(0, Math.min(this.buf.length - 1, Math.round(d))); }
  process(x) {
    const b = this.buf;
    b[this.i] = x;
    let j = this.i - this.d; if (j < 0) j += b.length;
    const y = b[j];
    this.i = (this.i + 1) % b.length;
    return y;
  }
}

export const MAX_LOOKAHEAD_S = 0.02;
/** Look-ahead in whole frames, truncated like latency.js framesOf() (the reported latency must match exactly). */
export const lookaheadFrames = (sec, sr) => Math.floor(Math.min(MAX_LOOKAHEAD_S, Math.max(0, Number(sec) || 0)) * sr + 1e-6);
const meterInit = () => ({ gr: 0, up: 0 });

// ------------------------------------------------------------------------------------ multiband compressor
/**
 * 3/4-band compressor with Linkwitz-Riley crossovers, per-band downward + upward gain computers (OTT-style),
 * look-ahead, solo / bypass, an internal dry/wet that mixes the phase-matched band sum (no comb filtering).
 * Params (set): bands (3|4), freqs [f1,f2,f3], mode 'down'|'up'|'both', depth (0..1), input / output (dB), mix (0..1),
 * lookahead (s), band[k] = { thr, ratio, upThr, upRatio, attack, release, makeup, solo, bypass }.
 */
export class MultibandCore {
  constructor(sr) {
    this.sr = sr;
    this.p = { bands: 3, freqs: [120, 2500, 8000], mode: 'down', depth: 1, input: 0, output: 0, mix: 1, lookahead: 0, knee: 6, band: [] };
    for (let k = 0; k < 4; k++) this.p.band.push({ thr: -24, ratio: 3, upThr: -40, upRatio: 1, attack: 0.01, release: 0.15, makeup: 0, solo: false, bypass: false });
    this.xo = null; this.nb = 0;
    this.maxLook = Math.ceil(MAX_LOOKAHEAD_S * sr);
    this.env = []; this.dl = [];
    this.meter = Array.from({ length: 4 }, meterInit);
    this.level = new Float64Array(4).fill(-120);
    this._build(3);
  }
  _build(nb) {
    this.nb = nb;
    const f = this.p.freqs.slice(0, nb - 1);
    this.xo = [new Crossover(this.sr, f), new Crossover(this.sr, f)];
    this.env = Array.from({ length: nb }, () => new EnvelopeFollower(this.sr));
    this.dl = Array.from({ length: nb * 2 }, () => new DelayLine(this.maxLook));
  }
  set(p) {
    const { band, ...rest } = p;
    Object.assign(this.p, rest);
    if (band) band.forEach((b, k) => { if (b && this.p.band[k]) Object.assign(this.p.band[k], b); });
    const nb = this.p.bands >= 4 ? 4 : 3;
    // keep crossover points ordered and apart (≥ 1/3 octave)
    const fr = this.p.freqs.slice(0, nb - 1).map((x) => Math.min(Math.max(x, 20), this.sr * 0.45));
    for (let i = 1; i < fr.length; i++) fr[i] = Math.max(fr[i], fr[i - 1] * 1.26);
    if (nb !== this.nb) this._build(nb);
    this.xo[0].setFreqs(fr); this.xo[1].setFreqs(fr);
    const la = lookaheadFrames(this.p.lookahead, this.sr);
    for (const d of this.dl) d.setDelay(la);
    for (let k = 0; k < nb; k++) { const b = this.p.band[k]; this.env[k].set(Math.max(1e-5, b.attack), Math.max(0.001, b.release)); }
  }
  /** Static band gain (dB) for a level: depth × (downward + upward) per the mode. */
  bandGain(k, levelDb) {
    const p = this.p, b = p.band[k];
    let g = 0;
    if (p.mode !== 'up') g += compressGain(levelDb, b.thr, b.ratio, p.knee);
    if (p.mode !== 'down') g += upwardGain(levelDb, b.upThr, b.upRatio, p.knee);
    return g * p.depth;
  }
  process(ins, outs, n) {
    const p = this.p, nb = this.nb;
    const L = ins[0], R = ins[1] || ins[0];
    const oL = outs[0], oR = outs[1] || outs[0];
    const inG = dbToLin(p.input), outG = dbToLin(p.output), mix = Math.min(1, Math.max(0, p.mix));
    const anySolo = p.band.slice(0, nb).some((b) => b.solo);
    const mk = p.band.map((b) => dbToLin(b.makeup));
    const xl = this.xo[0], xr = this.xo[1];
    for (let i = 0; i < n; i++) {
      const bl = xl.process(L[i] * inG), br = xr.process(R[i] * inG);
      let wl = 0, wr = 0, dl = 0, dr = 0;
      for (let k = 0; k < nb; k++) {
        const a = bl[k], c = br[k];
        const pk = Math.max(a < 0 ? -a : a, c < 0 ? -c : c);
        const lvl = linToDb(this.env[k].process(pk));
        const sl = this.dl[2 * k].process(a), sr = this.dl[2 * k + 1].process(c);
        dl += sl; dr += sr;
        const b = p.band[k];
        if (anySolo && !b.solo) continue;
        if (b.bypass) { wl += sl; wr += sr; continue; }
        const gdb = this.bandGain(k, lvl);
        const m = this.meter[k];
        if (gdb < m.gr) m.gr = gdb;
        if (gdb > m.up) m.up = gdb;
        if (lvl > this.level[k]) this.level[k] = lvl;
        const g = dbToLin(gdb) * mk[k];
        wl += sl * g; wr += sr * g;
      }
      oL[i] = outG * (dl + (wl - dl) * mix);
      oR[i] = outG * (dr + (wr - dr) * mix);
    }
  }
  readMeter() {
    const gr = this.meter.slice(0, this.nb).map((m) => m.gr), up = this.meter.slice(0, this.nb).map((m) => m.up);
    const level = Array.from(this.level.slice(0, this.nb));
    this.meter = Array.from({ length: 4 }, meterInit);
    this.level.fill(-120);
    return { gr, up, level };
  }
}

// ------------------------------------------------------------------------------------ transient shaper
/**
 * Envelope-follower difference transient shaper. Attack detector: dB(fast-attack env) − dB(slow-attack env) is
 * positive only on onsets; sustain detector: dB(slow-release env) − dB(fast-release env) is positive only in tails.
 * gain(dB) = attack% · attackDiff + sustain% · sustainDiff (stereo-linked, gated below −70 dBFS), optional soft clip.
 * Params: attack, sustain (−100..100), speed (s: slow-attack time; the sustain release is 6× that), clip, output (dB).
 */
export class TransientCore {
  constructor(sr) {
    this.sr = sr;
    this.p = { attack: 0, sustain: 0, speed: 0.025, clip: false, output: 0 };
    this.aFast = new EnvelopeFollower(sr, 0.0003, 0.12);
    this.aSlow = new EnvelopeFollower(sr, 0.025, 0.12);
    this.sFast = new EnvelopeFollower(sr, 0.0003, 0.03);
    this.sSlow = new EnvelopeFollower(sr, 0.0003, 0.15);
    this.smooth = 0; this.sc = timeCoef(0.0007, sr);
    this.meter = { min: 0, max: 0 };
    this.set({});
  }
  set(p) {
    Object.assign(this.p, p);
    const sp = Math.min(0.2, Math.max(0.002, this.p.speed));
    this.aSlow.set(sp, 0.12);
    this.sFast.set(0.0003, Math.max(0.02, sp * 1.2));
    this.sSlow.set(0.0003, Math.max(0.08, sp * 6));
  }
  /** Gain (dB) for one stereo-linked detector sample (also advances the followers). */
  gainFor(x) {
    const a = this.p.attack / 100, s = this.p.sustain / 100;
    const af = this.aFast.process(x), as = this.aSlow.process(x);
    const sf = this.sFast.process(x), ss = this.sSlow.process(x);
    const ref = linToDb(ss);
    const gate = ref < -70 ? 0 : ref < -60 ? (ref + 70) / 10 : 1;
    const ad = Math.max(0, linToDb(af) - linToDb(as));
    const sd = Math.max(0, linToDb(ss) - linToDb(sf));
    const g = gate * (1.5 * a * ad + 1.2 * s * sd);
    return Math.max(-36, Math.min(24, g));
  }
  process(ins, outs, n) {
    const L = ins[0], R = ins[1] || ins[0];
    const oL = outs[0], oR = outs[1] || outs[0];
    const outG = dbToLin(this.p.output), clip = this.p.clip, m = this.meter;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const target = this.gainFor(Math.max(l < 0 ? -l : l, r < 0 ? -r : r));
      this.smooth = this.sc * this.smooth + (1 - this.sc) * target;
      if (this.smooth < m.min) m.min = this.smooth;
      if (this.smooth > m.max) m.max = this.smooth;
      const g = dbToLin(this.smooth) * outG;
      let yl = l * g, yr = r * g;
      if (clip) { yl = softClip(yl); yr = softClip(yr); }
      oL[i] = yl; oR[i] = yr;
    }
  }
  readMeter() { const r = { min: this.meter.min, max: this.meter.max }; this.meter = { min: 0, max: 0 }; return r; }
}

/** Soft clipper: linear up to 0.7, smoothly saturating to ±1. */
export function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= 0.7) return x;
  const y = 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
  return x < 0 ? -y : y;
}

// ------------------------------------------------------------------------------------ de-esser
/**
 * De-esser. Detector: the band above `freq` (LR4 high part) or a band-pass around it (Q 1.4); level → 4:1 soft-knee
 * reduction above the threshold, limited to `range` dB, 0.5 ms attack / `release`. 'split' reduces only the band above
 * `freq` (low + high·g, phase-matched LR4 split), 'wide' turns the whole signal down. listen = output the detector.
 * Params: freq, thr, range, mode 'split'|'wide', detect 'hp'|'bp', listen, release (s).
 */
export class DeesserCore {
  constructor(sr) {
    this.sr = sr;
    this.p = { freq: 6500, thr: -30, range: 12, mode: 'split', detect: 'hp', listen: false, release: 0.06 };
    this.x = [new LR4(sr, 6500), new LR4(sr, 6500)];
    this.bp = [new Biquad(), new Biquad()];
    this.env = new EnvelopeFollower(sr, 0.0005, 0.06);
    this.meter = 0;
    this.set({});
  }
  set(p) {
    Object.assign(this.p, p);
    const f = Math.min(Math.max(this.p.freq, 1000), this.sr * 0.45);
    this.x[0].setFreq(f); this.x[1].setFreq(f);
    const c = rbjCoefs('bandpass', f, 1.4, 0, this.sr);
    this.bp[0].setCoefs(c); this.bp[1].setCoefs(c);
    this.env.set(0.0005, Math.max(0.005, this.p.release));
  }
  gainDb(levelDb) { return Math.max(-Math.abs(this.p.range), compressGain(levelDb, this.p.thr, 4, 4)); }
  process(ins, outs, n) {
    const L = ins[0], R = ins[1] || ins[0];
    const oL = outs[0], oR = outs[1] || outs[0];
    const { mode, detect, listen } = this.p;
    for (let i = 0; i < n; i++) {
      const ll = this.x[0].split(L[i]), lh = this.x[0].hi;
      const rl = this.x[1].split(R[i]), rh = this.x[1].hi;
      let sl = lh, sr = rh;
      if (detect === 'bp') { sl = this.bp[0].process(L[i]); sr = this.bp[1].process(R[i]); }
      const pk = Math.max(sl < 0 ? -sl : sl, sr < 0 ? -sr : sr);
      const gdb = this.gainDb(linToDb(this.env.process(pk)));
      if (gdb < this.meter) this.meter = gdb;
      if (listen) { oL[i] = sl; oR[i] = sr; continue; }
      const g = dbToLin(gdb);
      if (mode === 'wide') { oL[i] = (ll + lh) * g; oR[i] = (rl + rh) * g; } else { oL[i] = ll + lh * g; oR[i] = rl + rh * g; }
    }
  }
  readMeter() { const r = this.meter; this.meter = 0; return { gr: r }; }
}

// ------------------------------------------------------------------------------------ expander / gate
/**
 * Downward expander / gate with hysteresis, hold, look-ahead and a filtered (optionally external) key.
 * Detector: key (or the input) → high-pass / low-pass (12 dB/oct, off at the range ends) → stereo-linked peak with a
 * 10 ms release → dB. Open/close with hysteresis: the expansion threshold is `thr` while closed and `thr − hyst`
 * once open (opening needs the level to reach thr; closing needs it to fall hyst dB lower), hold keeps it open.
 * Gain (dB) smoothed with attack (opening) / release (closing), applied to the input delayed by the look-ahead.
 * Params: thr, ratio, range (dB <= 0), hyst (dB), knee, attack, hold, release, lookahead (s), hpf, lpf (Hz), keyed, listen.
 */
export class ExpanderCore {
  constructor(sr) {
    this.sr = sr;
    this.p = { thr: -40, ratio: 4, range: -40, hyst: 3, knee: 2, attack: 0.001, hold: 0.02, release: 0.12, lookahead: 0.002, hpf: 20, lpf: 20000, keyed: false, listen: false };
    this.hp = [new Biquad(), new Biquad()]; this.lp = [new Biquad(), new Biquad()];
    this.env = new EnvelopeFollower(sr, 0, 0.01);
    this.gs = new GainSmoother(sr);
    this.gs.y = 0;
    const max = Math.ceil(MAX_LOOKAHEAD_S * sr);
    this.dl = [new DelayLine(max), new DelayLine(max)];
    this.open = true; this.holdN = 0; this.holdLeft = 0;
    this.meter = 0;
    this.set({});
  }
  set(p) {
    Object.assign(this.p, p);
    const q = this.p;
    this.hpOn = q.hpf > 20.5; this.lpOn = q.lpf < 19999;
    const hc = rbjCoefs('highpass', q.hpf, Math.SQRT1_2, 0, this.sr), lc = rbjCoefs('lowpass', Math.min(q.lpf, this.sr * 0.45), Math.SQRT1_2, 0, this.sr);
    for (const b of this.hp) b.setCoefs(hc);
    for (const b of this.lp) b.setCoefs(lc);
    this.gs.set(Math.max(1e-5, q.attack), Math.max(0.001, q.release));
    const la = lookaheadFrames(q.lookahead, this.sr);
    for (const d of this.dl) d.setDelay(la);
    this.holdN = Math.round(Math.max(0, q.hold) * this.sr);
  }
  /** Target gain (dB) for a detector level, advancing the open / hold state by one sample. */
  target(levelDb) {
    const q = this.p;
    const T = this.open ? q.thr - Math.max(0, q.hyst) : q.thr;
    if (levelDb >= T) { this.open = true; this.holdLeft = this.holdN; }
    else if (this.holdLeft > 0) { this.holdLeft--; return 0; }
    else this.open = false;
    return expandGain(levelDb, T, q.ratio, q.range, q.knee);
  }
  _det(x, c) {
    let v = x;
    if (this.hpOn) v = this.hp[c].process(v);
    if (this.lpOn) v = this.lp[c].process(v);
    return v;
  }
  process(ins, outs, n, keys) {
    const L = ins[0], R = ins[1] || ins[0];
    const oL = outs[0], oR = outs[1] || outs[0];
    const useKey = this.p.keyed && keys && keys[0];
    const KL = useKey ? keys[0] : L, KR = useKey ? (keys[1] || keys[0]) : R;
    for (let i = 0; i < n; i++) {
      const kl = this._det(KL[i], 0), kr = this._det(KR[i], 1);
      const lvl = linToDb(this.env.process(Math.max(kl < 0 ? -kl : kl, kr < 0 ? -kr : kr)));
      const g = this.gs.process(this.target(lvl));
      if (g < this.meter) this.meter = g;
      const dl = this.dl[0].process(L[i]), dr = this.dl[1].process(R[i]);
      if (this.p.listen) { oL[i] = kl; oR[i] = kr; continue; }
      const lin = dbToLin(g);
      oL[i] = dl * lin; oR[i] = dr * lin;
    }
  }
  readMeter() { const r = this.meter; this.meter = 0; return { gr: r, open: this.open }; }
}

// ------------------------------------------------------------------------------------ dynamic EQ
const DYN_TYPES = ['peaking', 'lowshelf', 'highshelf'];
/**
 * 4-band dynamic EQ. Each band = an RBJ filter (bell / low shelf / high shelf) whose gain is
 * static gain + dynamic gain; the dynamic part moves towards `range` dB (negative = cut, positive = boost) by
 * (level beyond threshold)·(1 − 1/ratio), mode 'above' (level over thr) or 'below' (level under thr). Detector per
 * band: band-pass (bell) / low-pass (low shelf) / high-pass (high shelf) at the band frequency, peak follower with
 * the band's attack / release. Coefficients are refreshed every 16 samples.
 * Params: output (dB), band[k] = { on, type, freq, gain, q, thr, ratio, attack, release, range, mode }.
 */
export class DynEqCore {
  constructor(sr) {
    this.sr = sr;
    this.p = { output: 0, band: [] };
    for (let k = 0; k < 4; k++) this.p.band.push({ on: false, type: 'peaking', freq: 1000, gain: 0, q: 1, thr: -24, ratio: 3, attack: 0.005, release: 0.12, range: -6, mode: 'above' });
    this.f = Array.from({ length: 4 }, () => [new Biquad(), new Biquad()]);
    this.det = Array.from({ length: 4 }, () => [new Biquad(), new Biquad()]);
    this.env = Array.from({ length: 4 }, () => new EnvelopeFollower(sr));
    this.cur = new Float64Array(4).fill(NaN);
    this.dyn = new Float64Array(4);
    this.meter = Array.from({ length: 4 }, () => ({ min: 0, max: 0 }));
    this.set({});
  }
  set(p) {
    const { band, ...rest } = p;
    Object.assign(this.p, rest);
    if (band) band.forEach((b, k) => { if (b && this.p.band[k]) Object.assign(this.p.band[k], b); });
    this.p.band.forEach((b, k) => {
      if (!DYN_TYPES.includes(b.type)) b.type = 'peaking';
      const f = Math.min(Math.max(b.freq, 20), this.sr * 0.45);
      const dt = b.type === 'lowshelf' ? 'lowpass' : b.type === 'highshelf' ? 'highpass' : 'bandpass';
      const c = rbjCoefs(dt, f, dt === 'bandpass' ? Math.max(0.3, b.q) : Math.SQRT1_2, 0, this.sr);
      this.det[k][0].setCoefs(c); this.det[k][1].setCoefs(c);
      this.env[k].set(Math.max(1e-5, b.attack), Math.max(0.001, b.release));
      this.cur[k] = NaN; // force a coefficient refresh
    });
  }
  /** Dynamic gain (dB) of band k for a detector level. */
  dynGain(k, levelDb) {
    const b = this.p.band[k];
    const amt = dynamicAmount(levelDb, b.thr, b.ratio, b.mode);
    const r = b.range;
    return r < 0 ? Math.max(r, -amt) : Math.min(r, amt);
  }
  process(ins, outs, n) {
    const L = ins[0], R = ins[1] || ins[0];
    const oL = outs[0], oR = outs[1] || outs[0];
    const outG = dbToLin(this.p.output);
    const bands = this.p.band;
    for (let i0 = 0; i0 < n; i0 += 16) {
      const i1 = Math.min(n, i0 + 16);
      // detectors run on the input (pre-EQ) for this sub-block
      for (let k = 0; k < 4; k++) {
        const b = bands[k];
        if (!b.on) continue;
        const d = this.det[k], e = this.env[k];
        for (let i = i0; i < i1; i++) {
          const a = d[0].process(L[i]), c = d[1].process(R[i]);
          e.process(Math.max(a < 0 ? -a : a, c < 0 ? -c : c));
        }
        const dg = this.dynGain(k, linToDb(e.y));
        this.dyn[k] = dg;
        const m = this.meter[k];
        if (dg < m.min) m.min = dg;
        if (dg > m.max) m.max = dg;
        const total = b.gain + dg;
        if (!(Math.abs(total - this.cur[k]) < 0.01)) {
          this.cur[k] = total;
          const c = rbjCoefs(b.type, Math.min(Math.max(b.freq, 20), this.sr * 0.45), Math.max(0.1, b.q), total, this.sr);
          this.f[k][0].setCoefs(c); this.f[k][1].setCoefs(c);
        }
      }
      for (let i = i0; i < i1; i++) {
        let l = L[i], r = R[i];
        for (let k = 0; k < 4; k++) {
          if (!bands[k].on) continue;
          l = this.f[k][0].process(l); r = this.f[k][1].process(r);
        }
        oL[i] = l * outG; oR[i] = r * outG;
      }
    }
  }
  readMeter() {
    const out = this.meter.map((m, k) => (Math.abs(m.min) > Math.abs(m.max) ? m.min : m.max) * (this.p.band[k].on ? 1 : 0));
    this.meter = Array.from({ length: 4 }, () => ({ min: 0, max: 0 }));
    return { dyn: out };
  }
}
