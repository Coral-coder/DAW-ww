// Linear-phase FIR design and spectrum matching (pure, Node-safe) for the linear-phase and match EQs.
//
// designLinearPhase: frequency-sampling design. The target magnitude is sampled on an M-point FFT grid with zero
// phase, inverse-transformed (a real, even impulse response), rotated so its centre sits at (taps − 1) / 2 and
// windowed (Kaiser). The kernel is symmetric → exactly linear phase, latency (taps − 1) / 2 samples.
//
// Match EQ: spectra are kept as dB values on MATCH_FREQS (1/12-octave grid, 20 Hz – 20 kHz) — small enough to store
// in a project. bandsFromPower() integrates FFT power into those bands, smoothSpectrum() applies fractional-octave
// smoothing, matchCurve() turns (reference, current) into a bounded correction curve.
import { fft } from '../../dsp/fft.js';
import { logFreqs, interpLog, linToDb } from './curve-math.js';

/** Kernel length (odd) for a quality setting at a sample rate (lengths scale with the rate). */
export const FIR_QUALITY = { low: 2048, medium: 4096, high: 8192, max: 16384 };
export function firTaps(quality, sr = 48000) {
  const base = FIR_QUALITY[quality] || FIR_QUALITY.medium;
  const want = base * (sr / 48000);
  let m = 512;
  while (m < want * 0.999) m *= 2;
  return Math.min(65536, m) - 1;
}
/** Latency (frames) of a linear-phase kernel with `taps` taps. */
export const firLatency = (taps) => (taps - 1) / 2;

function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; }
  return s;
}
/** Kaiser window of length n. */
export function kaiser(n, beta = 6) {
  const w = new Float64Array(n), d = besselI0(beta);
  for (let i = 0; i < n; i++) { const r = (2 * i) / (n - 1) - 1; w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / d; }
  return w;
}

/**
 * Linear-phase FIR kernel for a magnitude target.
 * @param {(f:number)=>number} magAt linear magnitude at f (Hz)
 * @param {number} taps odd kernel length
 * @param {number} sr sample rate
 * @returns {Float32Array}
 */
export function designLinearPhase(magAt, taps, sr, beta = 6) {
  if (!(taps % 2)) taps -= 1;
  const M = taps + 1; // power of two when taps comes from firTaps()
  let N = 1; while (N < M) N *= 2;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const m = magAt((k * sr) / N);
    re[k] = Number.isFinite(m) ? Math.max(0, m) : 0;
    if (k > 0 && k < N / 2) re[N - k] = re[k];
  }
  fft(re, im, true);
  const c = (taps - 1) / 2;
  const w = kaiser(taps, beta);
  const out = new Float32Array(taps);
  for (let i = 0; i < taps; i++) out[i] = (re[((i - c) % N + N) % N] / N) * w[i];
  return out;
}

/** Magnitude response (linear) of a kernel at frequencies fs (direct DTFT; fine for tests and a few hundred points). */
export function kernelResponse(h, fs, sr) {
  return Array.from(fs, (f) => {
    const w = (2 * Math.PI * f) / sr;
    let r = 0, i = 0;
    for (let n = 0; n < h.length; n++) { r += h[n] * Math.cos(w * n); i -= h[n] * Math.sin(w * n); }
    return Math.hypot(r, i);
  });
}

// ------------------------------------------------------------------------------------ spectra / match EQ
/** The match-EQ analysis grid: 1/12 octave from 20 Hz to 20 kHz (120 points). */
export const MATCH_FREQS = logFreqs(120, 20, 20000);

/**
 * Integrate a power spectrum (linear power per FFT bin, bins 0..fftSize/2) into the bands of `freqs` (each band spans
 * half a grid step either side, log scale). Bands narrower than a bin take the interpolated bin power. Returns dB.
 */
export function bandsFromPower(power, sr, fftSize, freqs = MATCH_FREQS) {
  const n = freqs.length;
  const out = new Array(n);
  const step = Math.log(freqs[1] / freqs[0]);
  const binHz = sr / fftSize;
  const last = power.length - 1;
  for (let j = 0; j < n; j++) {
    const lo = freqs[j] * Math.exp(-step / 2), hi = freqs[j] * Math.exp(step / 2);
    const b0 = Math.ceil(lo / binHz), b1 = Math.floor(hi / binHz);
    let s = 0, c = 0;
    for (let b = Math.max(1, b0); b <= Math.min(last, b1); b++) { s += power[b]; c++; }
    if (!c) {
      const x = Math.min(last, freqs[j] / binHz), i0 = Math.floor(x), t = x - i0;
      s = power[i0] * (1 - t) + power[Math.min(last, i0 + 1)] * t; c = 1;
    }
    out[j] = 10 * Math.log10(Math.max(1e-24, s / c));
  }
  return out;
}

/** dB-per-bin (AnalyserNode.getFloatFrequencyData) → linear power per bin. */
export const dbBinsToPower = (db) => Float64Array.from(db, (v) => (Number.isFinite(v) ? Math.pow(10, v / 10) : 0));

/**
 * Average spectrum (dB on `freqs`) of PCM channels: Hann-windowed FFT frames with 50 % overlap, power averaged over
 * frames and channels. Quiet frames (more than 60 dB under the loudest) are skipped so silence does not count.
 */
export function averageSpectrum(channels, sr, { fftSize = 8192, freqs = MATCH_FREQS, maxFrames = 600 } = {}) {
  const len = Math.min(...channels.map((c) => c.length));
  const hop = fftSize / 2;
  const total = Math.max(1, Math.floor((len - fftSize) / hop) + 1);
  const stride = Math.max(1, Math.ceil(total / maxFrames));
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  const frames = [];
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  for (let f = 0; f < total; f += stride) {
    const start = f * hop;
    const p = new Float64Array(fftSize / 2 + 1);
    let e = 0;
    for (const ch of channels) {
      re.fill(0); im.fill(0);
      for (let i = 0; i < fftSize && start + i < len; i++) re[i] = ch[start + i] * win[i];
      fft(re, im);
      for (let k = 0; k <= fftSize / 2; k++) { const v = re[k] * re[k] + im[k] * im[k]; p[k] += v; e += v; }
    }
    frames.push({ p, e });
  }
  const maxE = Math.max(...frames.map((x) => x.e), 1e-30);
  const acc = new Float64Array(fftSize / 2 + 1);
  let used = 0;
  for (const fr of frames) {
    if (fr.e < maxE * 1e-6) continue;
    for (let k = 0; k < acc.length; k++) acc[k] += fr.p[k];
    used++;
  }
  if (used) for (let k = 0; k < acc.length; k++) acc[k] /= used * channels.length;
  return bandsFromPower(acc, sr, fftSize, freqs);
}

/** Fractional-octave smoothing of a dB curve on a log grid: mean (in dB) over ±width/2 octaves. width 0 → copy. */
export function smoothSpectrum(db, freqs = MATCH_FREQS, width = 1 / 6) {
  const n = db.length;
  if (!(width > 0)) return Array.from(db);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = freqs[i] * Math.pow(2, -width / 2), hi = freqs[i] * Math.pow(2, width / 2);
    let s = 0, c = 0;
    for (let j = 0; j < n; j++) if (freqs[j] >= lo - 1e-9 && freqs[j] <= hi + 1e-9) { s += db[j]; c++; }
    out[i] = c ? s / c : db[i];
  }
  return out;
}

/**
 * Match-EQ correction curve (dB on `freqs`): smooth(ref) − smooth(cur), level-aligned (mean difference over
 * 200 Hz – 5 kHz removed: matching tone, not loudness), scaled by `amount`, clamped to [−maxCut, +maxBoost] and faded to
 * 0 dB outside [low, high] over half an octave.
 */
export function matchCurve(ref, cur, { amount = 1, smoothing = 1 / 6, maxBoost = 12, maxCut = 12, low = 30, high = 18000, freqs = MATCH_FREQS } = {}) {
  const n = freqs.length;
  if (!ref || !cur || ref.length !== n || cur.length !== n) return new Array(n).fill(0);
  const r = smoothSpectrum(ref, freqs, smoothing), c = smoothSpectrum(cur, freqs, smoothing);
  const diff = r.map((v, i) => v - c[i]);
  let s = 0, k = 0;
  for (let i = 0; i < n; i++) if (freqs[i] >= 200 && freqs[i] <= 5000) { s += diff[i]; k++; }
  const offset = k ? s / k : 0;
  return diff.map((d, i) => {
    let v = (d - offset) * amount;
    v = Math.max(-Math.abs(maxCut), Math.min(Math.abs(maxBoost), v));
    const f = freqs[i];
    let fade = 1;
    if (f < low) fade = Math.max(0, 1 - Math.log2(low / f) * 2);
    else if (f > high) fade = Math.max(0, 1 - Math.log2(f / high) * 2);
    return v * fade;
  });
}

/** Linear magnitude function of a dB curve on `freqs` (log interpolation, flat beyond the ends). */
export function curveMagFn(curveDb, freqs = MATCH_FREQS) {
  return (f) => Math.pow(10, interpLog(freqs, curveDb, Math.max(f, 1e-3)) / 20);
}

/** Round a dB curve for storage in a project (0.1 dB, clamped to −150..+50). */
export const packCurve = (db) => Array.from(db, (v) => Math.round(Math.max(-150, Math.min(50, Number.isFinite(v) ? v : -150)) * 10) / 10);

export { linToDb };
