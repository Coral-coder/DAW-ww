// Ported from origin/mac-app src/audio/analysis/ (shared analysis code).
// Offline time-stretch (WSOLA) and resampling for "warp to project tempo" and key shifting.
// WSOLA: Hann-windowed grains at 50% synthesis overlap; each grain's analysis position is searched
// (±tolerance, coarse-to-fine on a decimated signal) for the best waveform match with the natural
// continuation of the previous grain, so transients and pitch survive. Bounded CPU: ~O(n · 150).
import { toMono } from './dsp.js';

/** Resample channels by `rate` (playback-rate semantics: rate 2 = half as long, octave up). Cubic interpolation. */
export function resample(channels, rate) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const inLen = chs[0]?.length || 0;
  const outLen = Math.max(1, Math.round(inLen / rate));
  return chs.map((x) => {
    const y = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i * rate, k = Math.floor(p), f = p - k;
      const xm = x[k - 1] ?? x[k] ?? 0, x0 = x[k] ?? 0, x1 = x[k + 1] ?? x0, x2 = x[k + 2] ?? x1;
      // Catmull-Rom
      y[i] = x0 + 0.5 * f * (x1 - xm + f * (2 * xm - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm)));
    }
    return y;
  });
}

/**
 * Time-stretch keeping pitch. factor = output length / input length (2 = twice as long / half speed).
 * @param {Float32Array[]} channels
 * @returns {Float32Array[]} each exactly round(len * factor) samples
 */
export function timeStretch(channels, factor, { sr = 44100, grain = 0.046, tolerance = 0.012 } = {}) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const inLen = chs[0]?.length || 0;
  const outLen = Math.max(1, Math.round(inLen * factor));
  if (Math.abs(factor - 1) < 1e-4) return chs.map((c) => { const y = new Float32Array(outLen); y.set(c.subarray(0, outLen)); return y; });
  let N = Math.max(256, Math.round(grain * sr));
  N += N % 2;
  const Hs = N / 2, Ha = Hs / factor;
  const tol = Math.max(16, Math.round(tolerance * sr));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mono = chs.length > 1 ? toMono(chs) : chs[0];
  const outs = chs.map(() => new Float32Array(outLen + N));
  const wsum = new Float32Array(outLen + N);
  const at = (x, i) => (i >= 0 && i < x.length ? x[i] : 0);
  const D = 4; // correlation decimation
  const xcorr = (a0, b0) => { let s = 0; for (let i = 0; i < N; i += D) s += at(mono, a0 + i) * at(mono, b0 + i); return s; };
  let prev = 0;
  const frames = Math.ceil(outLen / Hs) + 1;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * Ha);
    let pos = nominal;
    if (k > 0) {
      const target = prev + Hs; // natural continuation of the previous grain
      let best = -Infinity, bestD = 0;
      for (let d = -tol; d <= tol; d += 8) { const v = xcorr(nominal + d, target); if (v > best) { best = v; bestD = d; } }
      const c0 = bestD;
      for (let d = c0 - 7; d <= c0 + 7; d++) { if (d < -tol || d > tol) continue; const v = xcorr(nominal + d, target); if (v > best) { best = v; bestD = d; } }
      pos = nominal + bestD;
    }
    pos = Math.max(-Hs, Math.min(inLen - 1, pos));
    const o = k * Hs;
    for (let c = 0; c < chs.length; c++) {
      const x = chs[c], y = outs[c];
      for (let i = 0; i < N; i++) { const oi = o + i; if (oi >= y.length) break; y[oi] += win[i] * at(x, pos + i); }
    }
    for (let i = 0; i < N && o + i < wsum.length; i++) wsum[o + i] += win[i];
    prev = pos;
  }
  return outs.map((y) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : y[i];
    return r;
  });
}

/**
 * Warp audio from one tempo to another, optionally keeping pitch and/or shifting by semitones.
 * Output length = round(len * srcBpm / dstBpm).
 */
export function warp(channels, { srcBpm, dstBpm, keepPitch = true, semitones = 0, sr = 44100 } = {}) {
  const rate = srcBpm && dstBpm ? dstBpm / srcBpm : 1;
  const P = (keepPitch ? 1 : rate) * Math.pow(2, semitones / 12); // final pitch factor
  const F = P / rate; // stretch factor before resampling by P
  const chs = Array.isArray(channels) ? channels : [channels];
  const target = Math.max(1, Math.round(chs[0].length / rate));
  const stretched = Math.abs(F - 1) < 1e-4 ? chs : timeStretch(chs, F, { sr });
  const out = Math.abs(P - 1) < 1e-6 ? stretched : resample(stretched, P);
  return out.map((y) => { if (y.length === target) return y; const z = new Float32Array(target); z.set(y.subarray(0, target)); return z; });
}

/** Pitch shift keeping length. */
export function pitchShift(channels, semitones, { sr = 44100 } = {}) {
  return warp(channels, { srcBpm: 1, dstBpm: 1, keepPitch: true, semitones, sr });
}
