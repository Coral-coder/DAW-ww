// Integrated loudness (ITU-R BS.1770 / EBU R128 style, "LUFS-ish": K-weighting, 400 ms blocks,
// absolute -70 LUFS and relative -10 LU gates), plus an energy curve and waveform overview.
import { biquad, biquadCoeffs, toMono } from './dsp.js';

export function kWeight(x, sr) {
  const shelf = biquadCoeffs('highshelf', sr, 1500, Math.SQRT1_2, 4.0);
  const hp = biquadCoeffs('highpass', sr, 38, 0.5);
  return biquad(biquad(x, shelf), hp, true);
}

/** Integrated loudness in LUFS (−Infinity for silence). channels: Float32Array[] */
export function integratedLoudness(channels, sr) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const weighted = chs.map((c) => kWeight(c, sr));
  const n = Math.min(...weighted.map((c) => c.length));
  const block = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
  const z = [];
  for (let s = 0; s + block <= n; s += step) {
    let sum = 0;
    for (const c of weighted) { let acc = 0; for (let i = s; i < s + block; i++) acc += c[i] * c[i]; sum += acc / block; }
    z.push(sum);
  }
  if (!z.length) {
    let sum = 0; for (const c of weighted) { let acc = 0; for (let i = 0; i < n; i++) acc += c[i] * c[i]; sum += acc / Math.max(1, n); }
    z.push(sum);
  }
  const L = (v) => -0.691 + 10 * Math.log10(v);
  const abs = z.filter((v) => v > 0 && L(v) > -70);
  if (!abs.length) return -Infinity;
  const relGate = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((v) => L(v) > relGate);
  return L(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/** RMS energy curve, `perSecond` values per second, normalised to 0..1. */
export function energyCurve(signal, sr, perSecond = 4) {
  const x = Array.isArray(signal) ? toMono(signal) : signal;
  const w = Math.max(1, Math.round(sr / perSecond));
  const n = Math.ceil(x.length / w);
  const out = new Float32Array(n);
  let max = 1e-12;
  for (let b = 0; b < n; b++) {
    let acc = 0; const end = Math.min(x.length, (b + 1) * w);
    for (let i = b * w; i < end; i++) acc += x[i] * x[i];
    out[b] = Math.sqrt(acc / Math.max(1, end - b * w));
    if (out[b] > max) max = out[b];
  }
  for (let b = 0; b < n; b++) out[b] /= max;
  return out;
}

/** Waveform overview: `buckets` absolute peaks (0..1). */
export function waveformPeaks(signal, buckets = 800) {
  const x = Array.isArray(signal) ? toMono(signal) : signal;
  const out = new Float32Array(buckets);
  const w = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0; const end = Math.min(x.length, Math.floor((b + 1) * w));
    for (let i = Math.floor(b * w); i < end; i++) { const v = Math.abs(x[i]); if (v > m) m = v; }
    out[b] = Math.min(1, m);
  }
  return out;
}
