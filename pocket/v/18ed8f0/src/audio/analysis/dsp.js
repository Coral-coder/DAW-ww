// Small DSP helpers for offline track analysis (pure, Node-safe, Float32Array in / out).

/** Average any number of channels into one mono Float32Array. */
export function toMono(channels) {
  const chs = (Array.isArray(channels) ? channels : [channels]).filter(Boolean);
  if (!chs.length) return new Float32Array(0);
  if (chs.length === 1) return chs[0] instanceof Float32Array ? chs[0] : Float32Array.from(chs[0]);
  const n = Math.min(...chs.map((c) => c.length));
  const out = new Float32Array(n);
  const g = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] * g;
  return out;
}

/** RBJ cookbook biquad coefficients, normalised (a0 = 1). type: lowpass|highpass|bandpass|highshelf|lowshelf|peaking */
export function biquadCoeffs(type, sr, f0, Q = Math.SQRT1_2, gainDb = 0) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.49)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; // lowpass
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Run a biquad over x (returns a new array unless inPlace). */
export function biquad(x, c, inPlace = false) {
  const y = inPlace ? x : new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** Low-pass + integer decimation to roughly `target` Hz. Returns { x, sr }. */
export function downsample(x, sr, target = 11025) {
  const D = Math.max(1, Math.floor(sr / target));
  if (D === 1) return { x, sr };
  const lp = biquad(biquad(x, biquadCoeffs('lowpass', sr, (sr / D) * 0.42)), biquadCoeffs('lowpass', sr, (sr / D) * 0.42));
  const n = Math.floor(x.length / D);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lp[i * D];
  return { x: out, sr: sr / D };
}

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Linear interpolation into an array at a fractional index (0 outside). */
export function lerpAt(a, pos) {
  if (pos < 0 || pos > a.length - 1) return 0;
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : a[i];
}

export const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };
export function std(a, m = mean(a)) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return a.length ? Math.sqrt(s / a.length) : 0; }
