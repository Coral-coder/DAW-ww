// Frequency-response math shared by the dynamics / EQ family (pure, Node-safe, no Web Audio).
//
//  - rbjCoefs / biquadMag: digital biquads from the RBJ Audio-EQ cookbook (bilinear transform). Q is the plain
//    filter Q for every type (0.7071 = Butterworth for low/high-pass) — unlike BiquadFilterNode, whose low/high-pass
//    "Q" is a resonance in dB.
//  - analogMag: the analog prototypes of the same filters, evaluated at s = j·f/f0. No bilinear cramping near
//    Nyquist, which is what a linear-phase (FIR) EQ wants as its target.
//  - logFreqs / interpLog: log-spaced grids and interpolation on them (curves, spectra, match EQ).

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => (x > 1e-12 ? 20 * Math.log10(x) : -240);

/** RBJ cookbook biquad, normalised (a0 = 1). type: peaking|lowshelf|highshelf|lowpass|highpass|bandpass|notch|allpass. */
export function rbjCoefs(type, f0, Q, gainDb, sr) {
  const w0 = (2 * Math.PI * Math.min(Math.max(f0, 1), sr * 0.4999)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const q = Math.max(1e-4, Q);
  const alpha = sw / (2 * q);
  const A = Math.pow(10, (gainDb || 0) / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break; // 0 dB peak
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'allpass': b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
      break;
    }
    case 'peaking':
    default:
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H(e^jw)| of a normalised biquad at frequency f. */
export function biquadMag(c, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
}

/**
 * Analog prototype magnitude (linear) at f for a band {type, freq, gain (dB), q}. Extra types beyond the RBJ set:
 * 'highpass24' / 'lowpass24' / 'highpass48' / 'lowpass48' = Butterworth 4th / 8th order (Q ignored).
 */
export function analogMag(type, f, f0, Q, gainDb) {
  const w = Math.max(f, 1e-6) / Math.max(f0, 1e-6);
  const q = Math.max(1e-4, Q);
  const w2 = w * w;
  const den = (1 - w2) ** 2 + (w / q) ** 2;
  const A = Math.pow(10, (gainDb || 0) / 40);
  switch (type) {
    case 'lowpass': return Math.sqrt(1 / den);
    case 'highpass': return Math.sqrt((w2 * w2) / den);
    case 'bandpass': return Math.sqrt((w / q) ** 2 / den);
    case 'notch': return Math.sqrt((1 - w2) ** 2 / den);
    case 'allpass': return 1;
    case 'lowpass24': return 1 / Math.sqrt(1 + w ** 8);
    case 'highpass24': return 1 / Math.sqrt(1 + w ** -8);
    case 'lowpass48': return 1 / Math.sqrt(1 + w ** 16);
    case 'highpass48': return 1 / Math.sqrt(1 + w ** -16);
    case 'lowshelf': {
      const sa = Math.sqrt(A);
      return Math.sqrt((A * A * ((A - w2) ** 2 + (sa * w / q) ** 2)) / ((1 - A * w2) ** 2 + (sa * w / q) ** 2));
    }
    case 'highshelf': {
      const sa = Math.sqrt(A);
      return Math.sqrt((A * A * ((1 - A * w2) ** 2 + (sa * w / q) ** 2)) / ((A - w2) ** 2 + (sa * w / q) ** 2));
    }
    case 'peaking':
    default:
      return Math.sqrt(((1 - w2) ** 2 + (w * A / q) ** 2) / ((1 - w2) ** 2 + (w / (A * q)) ** 2));
  }
}

/** Combined analog magnitude (linear) of several bands [{on?, type, freq, gain, q}] at f. */
export function bandsMag(bands, f) {
  let m = 1;
  for (const b of bands) if (b && b.on !== false) m *= analogMag(b.type, f, b.freq, b.q, b.gain);
  return m;
}

/** n log-spaced frequencies from fMin to fMax (inclusive). */
export function logFreqs(n, fMin = 20, fMax = 20000) {
  const out = new Float64Array(n);
  const r = Math.log(fMax / fMin);
  for (let i = 0; i < n; i++) out[i] = fMin * Math.exp((r * i) / (n - 1));
  return out;
}

/** Linear interpolation of ys (on ascending xs) at x, in log-x; clamps at both ends. */
export function interpLog(xs, ys, x) {
  const n = xs.length;
  if (!n) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = Math.log(x / xs[lo]) / Math.log(xs[hi] / xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}
