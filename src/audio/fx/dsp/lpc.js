// Linear prediction (LPC) for formant work: autocorrelation + Levinson-Durbin give reflection coefficients; lattice
// filters split a voice into its spectral envelope (all-pole, the formants) and a flat excitation (pitch). Shifting
// the excitation keeps the formants (formant-preserving pitch shift); re-synthesising the excitation through the
// envelope of a time-scaled frame moves the formants without touching the pitch (formant shifter).
import { clamp } from './common.js';

/** Biased autocorrelation r[0..p] of x (length n). */
export function autocorr(x, n, p, out = new Float64Array(p + 1)) {
  for (let k = 0; k <= p; k++) {
    let s = 0;
    for (let i = k; i < n; i++) s += x[i] * x[i - k];
    out[k] = s;
  }
  return out;
}

/**
 * Levinson-Durbin recursion. Predictor A(z) = 1 + Σ a[j] z^-j, error e[n] = x[n] + Σ a[j] x[n-j].
 * Returns { a (length p+1, a[0] = 1), k (reflection coefficients 1..p, k[0] unused), err (final prediction error) }.
 */
export function levinson(r, p, out = null) {
  const a = out?.a || new Float64Array(p + 1), k = out?.k || new Float64Array(p + 1), tmp = out?.tmp || new Float64Array(p + 1);
  a.fill(0); k.fill(0);
  a[0] = 1;
  let err = r[0];
  if (!(err > 0)) return { a, k, tmp, err: 0 };
  for (let m = 1; m <= p; m++) {
    let acc = r[m];
    for (let j = 1; j < m; j++) acc += a[j] * r[m - j];
    const km = clamp(-acc / err, -0.9995, 0.9995);
    k[m] = km;
    for (let j = 1; j < m; j++) tmp[j] = a[j] + km * a[m - j];
    for (let j = 1; j < m; j++) a[j] = tmp[j];
    a[m] = km;
    err *= 1 - km * km;
  }
  return { a, k, tmp, err };
}

/** FIR lattice A(z): x -> prediction error. Reflection coefficients k[1..p] may change every sample. */
export class LatticeAnalysis {
  constructor(p) { this.p = p; this.b = new Float64Array(p + 1); }
  process(x, k) {
    const { p, b } = this;
    let f = x, bPrev = x; // stage 0: f0 = b0 = x
    for (let m = 1; m <= p; m++) {
      const bOld = b[m - 1]; // b_{m-1}[n-1]
      b[m - 1] = bPrev;
      const fm = f + k[m] * bOld;
      bPrev = bOld + k[m] * f;
      f = fm;
    }
    b[p] = bPrev;
    return f;
  }
  reset() { this.b.fill(0); }
}

/** IIR lattice 1/A(z): excitation -> signal. With the same k sequence it exactly inverts LatticeAnalysis. */
export class LatticeSynthesis {
  constructor(p) { this.p = p; this.b = new Float64Array(p + 1); }
  process(e, k) {
    const { p, b } = this;
    let f = e;
    for (let m = p; m >= 1; m--) {
      f -= k[m] * b[m - 1]; // f_{m-1}[n]
      b[m] = b[m - 1] + k[m] * f; // b_m[n]
    }
    b[0] = f;
    // guard against blow-ups from rapidly changing coefficients
    if (!(Math.abs(f) < 1e4)) { this.b.fill(0); return 0; }
    return f;
  }
  reset() { this.b.fill(0); }
}

/**
 * Frame-wise envelope tracker: keeps the recent input; analyze() (called every `hop` samples) windows the last `frame` samples
 * (optionally time-scaled by `warp`: formants of the analysed frame move up by that ratio), and runs Levinson.
 * Callers interpolate the reflection coefficients across the hop (stable: a mix of |k| < 1 stays < 1).
 */
export class EnvelopeTracker {
  constructor(sr, { order = 0, frame = 0, hop = 256 } = {}) {
    this.sr = sr;
    this.p = order || clamp(Math.round(sr / 2000) + 6, 12, 32);
    // Gaussian lag window (~60 Hz formant bandwidth expansion): smoother, more robust envelopes
    this.lag = Float64Array.from({ length: this.p + 1 }, (_, j) => Math.exp(-0.5 * ((2 * Math.PI * 60 * j) / sr) ** 2));
    this.N = frame || (sr > 60000 ? 2048 : 1024);
    this.hop = hop;
    this.hist = new Float32Array(this.N * 4); // up to 2x warp + slack
    this.hw = 0;
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / this.N);
    this.frameBuf = new Float64Array(this.N);
    this.r = new Float64Array(this.p + 1);
    this.lev = { a: new Float64Array(this.p + 1), k: new Float64Array(this.p + 1), tmp: new Float64Array(this.p + 1) };
  }
  push(x) { this.hist[this.hw] = x; this.hw = (this.hw + 1) % this.hist.length; }
  /** Analyse the latest frame time-scaled by warp (1 = as is). Returns { k, err, r0 } (views reused). */
  analyze(warp = 1) {
    const { N, hist, frameBuf, win } = this;
    const L = hist.length;
    const span = (N - 1) * warp;
    const start = this.hw - 1 - span; // oldest needed (fractional)
    for (let i = 0; i < N; i++) {
      const t = start + i * warp;
      const i0 = Math.floor(t), fr = t - i0;
      const a = hist[((i0 % L) + L) % L], b = hist[(((i0 + 1) % L) + L) % L];
      frameBuf[i] = (a + (b - a) * fr) * win[i];
    }
    autocorr(frameBuf, N, this.p, this.r);
    this.r[0] *= 1.0001; // white-noise correction (conditioning)
    for (let j = 1; j <= this.p; j++) this.r[j] *= this.lag[j];
    const res = levinson(this.r, this.p, this.lev);
    return { k: res.k, err: res.err, r0: this.r[0] };
  }
}
