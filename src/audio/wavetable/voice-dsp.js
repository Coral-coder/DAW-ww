// Per-voice DSP building blocks of the wavetable synth (pure, allocation-free in the hot path). Imported by the
// AudioWorklet processor and by the tests.

/** ADSR with an analog-style convex attack (RC towards 1.3, cut at 1), RC decay (τ = d/4) and release (τ = r/6). */
export class Env {
  constructor() { this.stage = 0; this.level = 0; this.a = 0.005; this.d = 0.3; this.s = 0.8; this.r = 0.2; this.sr = 48000; this._coef(); }
  set(a, d, s, r, sr) {
    if (a === this.a && d === this.d && s === this.s && r === this.r && sr === this.sr) return;
    this.a = Math.max(0.0005, a); this.d = Math.max(0.001, d); this.s = Math.max(0, Math.min(1, s)); this.r = Math.max(0.001, r); this.sr = sr;
    this._coef();
  }
  _coef() {
    const sr = this.sr;
    this.ca = 1 - Math.exp(-1 / ((this.a / 1.466) * sr)); // 1.3·(1 − e^(−t/τ)) reaches 1 at t = a
    this.cd = 1 - Math.exp(-1 / ((this.d / 4) * sr));
    this.cr = 1 - Math.exp(-1 / ((this.r / 6) * sr));
  }
  gate(on, retrigger = true) {
    if (on) { if (retrigger || this.stage === 0 || this.stage === 4) this.stage = 1; } else if (this.stage !== 0) this.stage = 4;
  }
  /** Advance one sample; returns the level 0..1. */
  tick() {
    switch (this.stage) {
      case 1: this.level += (1.3 - this.level) * this.ca; if (this.level >= 1) { this.level = 1; this.stage = 2; } break;
      case 2: case 3: this.level += (this.s - this.level) * this.cd; break;
      case 4: this.level += -this.level * this.cr; if (this.level < 1e-5) { this.level = 0; this.stage = 0; } break;
      default: break;
    }
    return this.level;
  }
  /** Advance n samples at once (control-rate envelopes). */
  run(n) {
    for (let i = 0; i < n; i++) this.tick();
    return this.level;
  }
  get idle() { return this.stage === 0; }
}

/**
 * Topology-preserving state-variable filter (Andrew Simper / Cytomic): stable under fast modulation.
 * mode: 0 low, 1 band, 2 high, 3 notch.
 */
export class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1.4; }
  setup(fc, k, sr) {
    const g = Math.tan(Math.PI * Math.min(fc, sr * 0.49) / sr);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  copyCoefs(o) { this.k = o.k; this.a1 = o.a1; this.a2 = o.a2; this.a3 = o.a3; }
  process(v0, mode) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    switch (mode) {
      case 1: return v1;
      case 2: return v0 - this.k * v1 - v2;
      case 3: return v0 - this.k * v1;
      default: return v2;
    }
  }
  reset() { this.ic1 = 0; this.ic2 = 0; }
}

/** SVF damping k for resonance 0..1 (Q 0.707 … ~25). */
export const svfK = (res) => Math.max(0.04, 1.4142 * (1 - 0.975 * Math.max(0, Math.min(1, res))));

/** Feedback comb tuned to `fc` Hz (fractional delay, linear interpolation); fb ±0.97. */
export class Comb {
  constructor(maxDelay) { this.buf = new Float32Array(maxDelay + 2); this.w = 0; this.d = 100; this.fb = 0.5; }
  setup(fc, fb, sr) { this.d = Math.max(2, Math.min(this.buf.length - 2, sr / Math.max(20, fc))); this.fb = fb; }
  process(x) {
    const n = this.buf.length;
    let r = this.w - this.d;
    while (r < 0) r += n;
    const i0 = r | 0, fr = r - i0;
    const y0 = this.buf[i0], y1 = this.buf[(i0 + 1) % n];
    const del = y0 + (y1 - y0) * fr;
    const y = x + this.fb * del;
    this.buf[this.w] = Math.max(-4, Math.min(4, y));
    this.w = (this.w + 1) % n;
    return y * (1 - Math.abs(this.fb) * 0.5);
  }
  reset() { this.buf.fill(0); }
}

/** LFO shapes (phase 0..1 -> -1..1). 5 = sample & hold, 6 = smooth random use the voice's random stream. */
export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'ramp', 'square', 'random', 'smooth'];
export function lfoValue(shape, ph) {
  switch (shape) {
    case 1: return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
    case 2: return 2 * ph - 1;
    case 3: return 1 - 2 * ph;
    case 4: return ph < 0.5 ? 1 : -1;
    default: return Math.sin(2 * Math.PI * ph);
  }
}

/** Unison layout: per-voice detune offset (−1..1), level and pan for n voices, blend and stereo spread. */
export function unisonLayout(n, blend, spread) {
  const out = [];
  if (n <= 1) return [{ k: 0, gain: 1, pan: 0 }];
  let sum = 0;
  for (let u = 0; u < n; u++) {
    const k = (u / (n - 1)) * 2 - 1;
    const centre = n % 2 ? Math.abs(k) < 1e-9 : Math.abs(k) <= 1 / (n - 1) + 1e-9;
    const w = centre ? 1 - 0.7 * blend : 0.15 + 0.85 * blend;
    // alternate sides so neighbouring detunes land left / right (wide but balanced)
    const pan = (u % 2 ? -1 : 1) * Math.abs(k) * spread;
    out.push({ k, gain: w, pan });
    sum += w * w;
  }
  const norm = 1 / Math.sqrt(sum || 1);
  for (const o of out) o.gain *= norm;
  return out;
}

/** Equal-power pan gains for p ∈ [−1, 1] -> [left, right]. */
export function panGains(p) {
  const x = (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4;
  return [Math.cos(x), Math.sin(x)];
}
