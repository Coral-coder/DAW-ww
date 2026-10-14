// Ported from origin/mac-app src/audio/analysis/ (shared analysis code).
// Onset-strength envelope (multi-band energy flux) — the input for tempo, beat-grid, downbeat and
// transient detection. Runs on a ~11 kHz mono signal with ~5.8 ms hops (≈172 frames/s).
import { biquad, biquadCoeffs, downsample, toMono } from './dsp.js';

/**
 * @param {Float32Array|Float32Array[]} signal mono samples or channel array
 * @param {number} sr sample rate
 * @returns {{ env: Float32Array, low: Float32Array, fps: number, hop: number, sr: number }}
 *   env = summed band flux, low = bass-band flux (kick-ish, used for downbeats)
 */
export function onsetEnvelope(signal, sr, { targetSr = 11025, fps = 172 } = {}) {
  const mono = Array.isArray(signal) ? toMono(signal) : signal;
  const ds = downsample(mono, sr, targetSr);
  const x = ds.x, rate = ds.sr;
  const hop = Math.max(16, Math.round(rate / fps));
  const n = Math.floor(x.length / hop);
  const bands = [
    biquad(biquad(x, biquadCoeffs('lowpass', rate, 180)), biquadCoeffs('lowpass', rate, 180)),
    biquad(x, biquadCoeffs('bandpass', rate, 800, 0.6)),
    biquad(biquad(x, biquadCoeffs('highpass', rate, 2500)), biquadCoeffs('highpass', rate, 2500)),
  ];
  const weights = [1.2, 1, 0.8];
  const env = new Float32Array(n);
  const low = new Float32Array(n);
  for (let b = 0; b < bands.length; b++) {
    const s = bands[b];
    const e = new Float32Array(n);
    let peak = 1e-12;
    for (let f = 0; f < n; f++) {
      let acc = 0;
      for (let i = f * hop, end = i + hop; i < end; i++) acc += s[i] * s[i];
      e[f] = acc / hop;
      if (e[f] > peak) peak = e[f];
    }
    // log compression relative to the band's peak, then half-wave rectified difference
    const C = 1000 / peak;
    let prev = Math.log1p(C * e[0]);
    for (let f = 1; f < n; f++) {
      const cur = Math.log1p(C * e[f]);
      const d = cur - prev;
      prev = cur;
      if (d > 0) { env[f] += weights[b] * d; if (b === 0) low[f] += d; }
    }
  }
  return { env, low, fps: rate / hop, hop, sr: rate };
}

/** Small gaussian blur (sigma in frames) — makes comb scoring tolerant to sub-frame jitter. */
export function smooth(a, sigma = 1) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) { const ii = i + j; if (ii >= 0 && ii < a.length) s += a[ii] * k[j + r]; }
    out[i] = s / ks;
  }
  return out;
}

/** Peak-picked transient times (seconds) from an onset envelope. */
export function detectTransients(env, fps, { sensitivity = 0.5, minGap = 0.06 } = {}) {
  const w = Math.max(3, Math.round(fps * 0.15));
  const out = [];
  let last = -Infinity;
  // global floor so silence never produces hits
  let max = 0; for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
  const floor = max * (0.04 + 0.25 * (1 - sensitivity));
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    if (v < floor || v < env[i - 1] || v < env[i + 1]) continue;
    let s = 0, c = 0;
    for (let j = Math.max(0, i - w); j < Math.min(env.length, i + w); j++) { s += env[j]; c++; }
    const local = s / c;
    if (v < local * (1.2 + 1.5 * (1 - sensitivity))) continue;
    const t = i / fps;
    if (t - last < minGap) continue;
    out.push(t);
    last = t;
  }
  return out;
}
