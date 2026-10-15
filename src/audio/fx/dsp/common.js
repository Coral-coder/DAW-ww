// Shared DSP building blocks for the space / character effect worklets (src/audio/fx/worklets/fx-processors.js).
// Plain ES module with no Web Audio or DOM access: runs on the audio thread and in Node tests alike.

export const TAU = 2 * Math.PI;
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const semitonesToRatio = (st) => Math.pow(2, st / 12);
export const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
/** One-pole smoothing coefficient reaching 1 - 1/e after `sec` seconds. */
export const onePoleCoef = (sec, sr) => (sec <= 0 ? 1 : 1 - Math.exp(-1 / (sec * sr)));
/** Feedback gain that decays a loop of `loopSamples` by 60 dB in `t60` seconds. */
export const decayGain = (loopSamples, t60, sr) => (t60 > 0 ? Math.pow(10, (-3 * loopSamples) / (t60 * sr)) : 0);

/** Deterministic PRNG (mulberry32) returning [0, 1): offline renders of grain / noise effects are reproducible. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chord shapes (semitones above the root) shared by the vocoder carrier and the resonator. */
export const CHORDS = {
  single: [0], octave: [0, 12], fifth: [0, 7], power: [0, 7, 12], major: [0, 4, 7], minor: [0, 3, 7],
  sus2: [0, 2, 7], sus4: [0, 5, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10],
  min9: [0, 3, 7, 14], add9: [0, 4, 7, 14], dim: [0, 3, 6], aug: [0, 4, 8],
};
export const CHORD_NAMES = Object.keys(CHORDS);

/**
 * Ring-buffer delay line (power-of-two length). write(x) then read(d) returns x[n - d] (d = 0: the sample just
 * written); fractional delays use linear (read) or 4-point Hermite (readCubic) interpolation.
 */
export class DelayLine {
  constructor(maxSamples) {
    let n = 4;
    while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
    this.w = 0;
  }
  get size() { return this.buf.length; }
  write(x) { this.w = (this.w + 1) & this.mask; this.buf[this.w] = x; }
  /** Integer delay. */
  tap(d) { return this.buf[(this.w - d) & this.mask]; }
  read(d) {
    const i = Math.floor(d), f = d - i;
    const a = this.buf[(this.w - i) & this.mask], b = this.buf[(this.w - i - 1) & this.mask];
    return a + (b - a) * f;
  }
  readCubic(d) {
    const i = Math.floor(d), f = d - i, m = this.mask, w = this.w, b = this.buf;
    const xm1 = b[(w - i + 1) & m], x0 = b[(w - i) & m], x1 = b[(w - i - 1) & m], x2 = b[(w - i - 2) & m];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  clear() { this.buf.fill(0); }
}

/** RBJ biquad (transposed direct form II). */
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this; }
  lowpass(f, q, sr) { const w = (TAU * clamp(f, 1, sr * 0.49)) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  highpass(f, q, sr) { const w = (TAU * clamp(f, 1, sr * 0.49)) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  /** Band-pass with 0 dB peak gain. */
  bandpass(f, q, sr) { const w = (TAU * clamp(f, 1, sr * 0.49)) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set(al, 0, -al, 1 + al, -2 * c, 1 - al); }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
  /** |H(e^jw)| at frequency f. */
  magnitude(f, sr) {
    const w = (TAU * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

/** Zero-delay-feedback state-variable filter (Simper / TPT): lp, bp, hp outputs after process(x). */
export class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.set(1000, 0.707, 48000); }
  set(f, q, sr) {
    const g = Math.tan((Math.PI * clamp(f, 5, sr * 0.48)) / sr);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

/** DC blocker (one-zero / one-pole high-pass around 10 Hz). */
export class DcBlock {
  constructor(sr, f = 10) { this.r = Math.exp((-TAU * f) / sr); this.x1 = 0; this.y1 = 0; }
  process(x) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
}

/** First-order Schroeder allpass with a delay of `len` samples (diffusers). */
export class Allpass {
  constructor(len) { this.d = new DelayLine(len + 2); this.len = len; this.g = 0.5; }
  process(x) {
    const v = this.d.tap(this.len - 1); // x[n - len] after this write
    const w = x + this.g * v;
    this.d.write(w);
    return v - this.g * w;
  }
}

/** Mean-square of a signal (tests / level checks). */
export function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
