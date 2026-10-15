// Analyzer DSP (pure, Node-safe): everything the oscilloscope, vectorscope, spectrum analyzer, spectrogram and tuner
// compute from raw sample blocks. The drawing lives in src/ui/scopes; the audio taps in src/audio/fx/builders/analysis.js.
//
//   noteOf(freq, {a4, flats})                       nearest equal-tempered note: {name, octave, cents, label, ...}
//   findCrossings / pickTrigger / scopeTrigger      oscilloscope triggering (zero crossing, cycle lock, free run)
//   stereoStats / StereoMeter                       correlation (−1..+1) and balance (−1 = left .. +1 = right)
//   makeWindow / SpectrumAnalyzer                   windowed two-channel FFT -> power spectra (full-scale sine = 0 dB)
//   slopeGains / averageInto / PeakHold / maxInto   tilt, averaging, peak-hold and max traces
//   octaveSmooth / bandEdges / resampleBands        fractional-octave smoothing and display resampling (max per band)
//   freqToNorm / normToFreq                         log / linear / mel frequency axes
//   colormapLUT / mapColor                          spectrogram colour maps (viridis and cividis are colour-blind safe)
//   detectPitch / TunerTracker                      YIN on the newest samples, smoothed tuner readout with a level gate
import { fft, yin, yinGeometry } from './yin.js';

// ------------------------------------------------------------------------------------------------ notes
const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/**
 * Nearest equal-tempered note to `freq` for the reference pitch a4 (Hz).
 * -> {midi, exact (fractional MIDI), name, octave, cents (−50..+50, + = sharp), label ('A4'), ref (Hz of the note)} | null.
 */
export function noteOf(freq, { a4 = 440, flats = false } = {}) {
  if (!(freq > 0) || !Number.isFinite(freq)) return null;
  const exact = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(exact);
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = (flats ? FLATS : SHARPS)[pc];
  return { midi, exact, name, octave, cents: (exact - midi) * 100, label: name + octave, ref: a4 * Math.pow(2, (midi - 69) / 12) };
}

/** '1.23 kHz' / '440 Hz' / '61.7 Hz'. */
export function formatHz(f) {
  if (!Number.isFinite(f)) return '—';
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz`;
  return `${f.toFixed(f >= 100 ? 0 : 1)} Hz`;
}

// ------------------------------------------------------------------------------------------------ oscilloscope
/** Linear interpolation of buf at fractional index pos (clamped). */
export function sampleAt(buf, pos) {
  if (pos <= 0) return buf[0];
  const n = buf.length - 1;
  if (pos >= n) return buf[n];
  const i = Math.floor(pos);
  const f = pos - i;
  return buf[i] + (buf[i + 1] - buf[i]) * f;
}

/**
 * Crossings of `level` in buf[from .. to) with hysteresis: a crossing only counts after the signal was at least
 * `hyst` on the other side (noise on a slow wave can't re-trigger). slope 'rise' | 'fall'. -> fractional indices.
 */
export function findCrossings(buf, { from = 0, to = buf.length, level = 0, hyst = 0, slope = 'rise' } = {}) {
  const out = [];
  const s = slope === 'fall' ? -1 : 1;
  const lv = s * level;
  from = Math.max(1, Math.floor(from));
  to = Math.min(buf.length, Math.ceil(to));
  // armed when the sample before the window was already below the hysteresis band
  let armed = false;
  for (let i = Math.max(0, from - 64); i < from; i++) if (s * buf[i] < lv - hyst) armed = true; else if (s * buf[i] >= lv) armed = false;
  for (let i = from; i < to; i++) {
    const a = s * buf[i - 1], b = s * buf[i];
    if (a < lv - hyst) armed = true;
    if (armed && a < lv && b >= lv) {
      out.push(i - 1 + (b === a ? 0 : (lv - a) / (b - a)));
      armed = false;
    }
  }
  return out;
}

/**
 * Of the candidate trigger positions, the one whose next `len` samples look most like the previous frame
 * (`prev`: the M points last drawn, evenly spaced over len) — keeps complex waves with several crossings per cycle
 * still. Without prev: the newest candidate. Ties go to the newer candidate (fresher data).
 */
export function pickTrigger(buf, cands, len, prev = null) {
  if (!cands.length) return -1;
  if (!prev || !prev.length) return cands[cands.length - 1];
  const M = prev.length;
  let best = cands[cands.length - 1], bestErr = Infinity;
  const first = Math.max(0, cands.length - 96); // newest 96 candidates are plenty
  for (let c = cands.length - 1; c >= first; c--) {
    const p = cands[c];
    let err = 0;
    for (let k = 0; k < M; k++) {
      const d = sampleAt(buf, p + (k * len) / M) - prev[k];
      err += d * d;
      if (err >= bestErr) break;
    }
    if (err < bestErr * 0.999) { bestErr = err; best = p; }
  }
  return best;
}

/**
 * Where to start drawing `len` samples of `buf` (the newest samples are at the end).
 * mode 'free': the newest len samples. 'zero' / 'cycle': a crossing of `level` within the last `search` samples
 * that leaves room for len samples (cycle mode passes len = cycles × pitch period, so periodic waves stand still).
 * -> {pos, triggered}. Without a crossing it falls back to free run (triggered false).
 */
export function scopeTrigger(buf, { mode = 'zero', len, level = 0, hyst = 0, slope = 'rise', prev = null, search } = {}) {
  const N = buf.length;
  len = Math.max(2, Math.min(N - 2, Math.round(len)));
  const free = N - 1 - len;
  if (mode === 'free') return { pos: free, triggered: false };
  const to = N - 1 - len;
  const from = Math.max(1, to - Math.max(16, Math.round(search ?? Math.max(len, 2048))));
  const cands = findCrossings(buf, { from, to, level, hyst, slope });
  if (!cands.length) return { pos: free, triggered: false };
  return { pos: pickTrigger(buf, cands, len, prev), triggered: true };
}

/** Resample buf[pos .. pos + len) to M evenly spaced points (for drawing and as the next frame's `prev`). */
export function resampleWindow(buf, pos, len, M, out = new Float32Array(M)) {
  for (let k = 0; k < M; k++) out[k] = sampleAt(buf, pos + (k * len) / Math.max(1, M - 1));
  return out;
}

/** Channel view of a stereo block: 'L' | 'R' | 'M' ((L+R)/2) | 'S' ((L−R)/2). */
export function channelOf(l, r, ch, out = new Float32Array(l.length)) {
  const n = Math.min(l.length, r.length, out.length);
  if (ch === 'R') { out.set(r.subarray(0, n)); return out; }
  if (ch === 'L') { out.set(l.subarray(0, n)); return out; }
  if (ch === 'S') { for (let i = 0; i < n; i++) out[i] = (l[i] - r[i]) * 0.5; return out; }
  for (let i = 0; i < n; i++) out[i] = (l[i] + r[i]) * 0.5;
  return out;
}

/** Peak |x| of a block. */
export function peakOf(buf, from = 0, to = buf.length) {
  let m = 0;
  for (let i = from; i < to; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  return m;
}

// ------------------------------------------------------------------------------------------------ stereo
/**
 * One block's stereo statistics: corr = Σlr / √(Σl²·Σr²) (+1 mono, 0 uncorrelated / wide, −1 out of phase; 0 when
 * silent), balance = (Er − El) / (Er + El) (−1 hard left .. +1 hard right), balanceDb = level R − level L, RMS of L, R,
 * M = (L+R)/2 and S = (L−R)/2, and the sample peak.
 */
export function stereoStats(l, r, n = Math.min(l.length, r.length)) {
  let ll = 0, rr = 0, lr = 0, pk = 0;
  for (let i = 0; i < n; i++) {
    const a = l[i], b = r[i];
    ll += a * a; rr += b * b; lr += a * b;
    const m = Math.max(Math.abs(a), Math.abs(b));
    if (m > pk) pk = m;
  }
  return statsFromSums(ll, rr, lr, n, pk);
}

function statsFromSums(ll, rr, lr, n, peak = 0) {
  const den = Math.sqrt(ll * rr);
  const tot = ll + rr;
  const N = Math.max(1, n);
  const mm = (ll + rr + 2 * lr) / 4, ss = (ll + rr - 2 * lr) / 4;
  return {
    corr: den > 1e-20 ? Math.max(-1, Math.min(1, lr / den)) : 0,
    balance: tot > 1e-20 ? (rr - ll) / tot : 0,
    balanceDb: ll > 1e-20 && rr > 1e-20 ? 10 * Math.log10(rr / ll) : rr > 1e-20 ? Infinity : ll > 1e-20 ? -Infinity : 0,
    rmsL: Math.sqrt(ll / N), rmsR: Math.sqrt(rr / N),
    rmsM: Math.sqrt(Math.max(0, mm) / N), rmsS: Math.sqrt(Math.max(0, ss) / N),
    peak,
  };
}

/** One-pole coefficient for a frame of dt seconds and time constant tau (0 = no smoothing). */
export const smoothCoef = (dt, tau) => (tau > 0 && dt > 0 ? Math.exp(-dt / tau) : 0);

/**
 * Correlation / balance meter with an integration time: the sums (not the ratios) are smoothed, so the reading is
 * the true correlation of the last ~tau seconds. push(l, r, newSamples, sampleRate) reads the newest newSamples of
 * the blocks.
 */
export class StereoMeter {
  constructor(tau = 0.3) { this.tau = tau; this.reset(); }
  reset() { this.ll = 0; this.rr = 0; this.lr = 0; this.n = 0; }
  push(l, r, count = l.length, sampleRate = 48000) {
    const N = Math.min(l.length, r.length);
    count = Math.max(0, Math.min(N, Math.round(count)));
    if (!count) return this.read();
    let ll = 0, rr = 0, lr = 0;
    for (let i = N - count; i < N; i++) { const a = l[i], b = r[i]; ll += a * a; rr += b * b; lr += a * b; }
    const k = smoothCoef(count / sampleRate, this.tau);
    this.ll = this.ll * k + ll; this.rr = this.rr * k + rr; this.lr = this.lr * k + lr; this.n = this.n * k + count;
    return this.read();
  }
  read() { return statsFromSums(this.ll, this.rr, this.lr, this.n); }
}

// ------------------------------------------------------------------------------------------------ windows / FFT
export const WINDOW_OPTIONS = [
  { value: 'hann', label: 'Hann' }, { value: 'blackman-harris', label: 'Blackman-Harris' }, { value: 'hamming', label: 'Hamming' },
  { value: 'blackman', label: 'Blackman' }, { value: 'flattop', label: 'Flat-top' }, { value: 'rect', label: 'Rectangular' },
];
const winCache = new Map();
/** Periodic window of length n (cached). */
export function makeWindow(name, n) {
  const key = `${name}:${n}`;
  let w = winCache.get(key);
  if (w) return w;
  w = new Float32Array(n);
  const cosSum = (a) => { for (let i = 0; i < n; i++) { const x = (2 * Math.PI * i) / n; let v = 0; for (let k = 0; k < a.length; k++) v += (k % 2 ? -1 : 1) * a[k] * Math.cos(k * x); w[i] = v; } };
  switch (name) {
    case 'rect': w.fill(1); break;
    case 'hamming': cosSum([0.54, 0.46]); break;
    case 'blackman': cosSum([0.42, 0.5, 0.08]); break;
    case 'blackman-harris': cosSum([0.35875, 0.48829, 0.14128, 0.01168]); break;
    case 'flattop': cosSum([0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]); break;
    default: cosSum([0.5, 0.5]); // hann
  }
  if (winCache.size > 24) winCache.delete(winCache.keys().next().value);
  winCache.set(key, w);
  return w;
}

/**
 * Two real channels per complex FFT. analyze(a, b, window) windows the newest `size` samples of a and b and fills
 * this.pa / this.pb (size/2 + 1 bins) with power normalised so a full-scale sine reads 1 (0 dB) whatever the window.
 */
export class SpectrumAnalyzer {
  constructor(size = 4096) {
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.pa = new Float32Array(size / 2 + 1);
    this.pb = new Float32Array(size / 2 + 1);
  }
  analyze(a, b = null, windowName = 'hann') {
    const N = this.size;
    const w = makeWindow(windowName, N);
    let ws = 0;
    for (let i = 0; i < N; i++) ws += w[i];
    const oa = a.length - N, ob = b ? b.length - N : 0;
    for (let i = 0; i < N; i++) {
      this.re[i] = (a[oa + i] || 0) * w[i];
      this.im[i] = b ? (b[ob + i] || 0) * w[i] : 0;
    }
    fft(this.re, this.im);
    const g = 4 / (ws * ws); // amplitude 2|X|/Σw -> power
    const { re, im, pa, pb } = this;
    for (let k = 0; k <= N / 2; k++) {
      const j = (N - k) % N;
      // A = (Z[k] + conj Z[N−k]) / 2,  B = (Z[k] − conj Z[N−k]) / 2i
      const ar = (re[k] + re[j]) * 0.5, ai = (im[k] - im[j]) * 0.5;
      const br = (im[k] + im[j]) * 0.5, bi = (re[j] - re[k]) * 0.5;
      const edge = k === 0 || k === N / 2 ? 0.25 : 1; // DC / Nyquist are not split between ±f
      pa[k] = (ar * ar + ai * ai) * g * edge;
      pb[k] = (br * br + bi * bi) * g * edge;
    }
    return this;
  }
}

export const powToDb = (p) => (p > 1e-20 ? 10 * Math.log10(p) : -200);

/** Per-bin power multipliers for a spectral tilt of `slope` dB/octave around `pivot` Hz (0 = flat). */
export function slopeGains(nBins, binHz, slope, pivot = 1000) {
  const g = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) {
    const f = Math.max(binHz * 0.5, k * binHz);
    g[k] = slope ? Math.pow(10, (slope * Math.log2(f / pivot)) / 10) : 1;
  }
  return g;
}

/** In-place exponential average of power spectra: state = k·state + (1−k)·cur (k from smoothCoef). */
export function averageInto(state, cur, k) {
  const n = Math.min(state.length, cur.length);
  if (!(k > 0)) { for (let i = 0; i < n; i++) state[i] = cur[i]; return state; }
  const j = 1 - k;
  for (let i = 0; i < n; i++) state[i] = state[i] * k + cur[i] * j;
  return state;
}

/** max trace: state = max(state, cur), element-wise. */
export function maxInto(state, cur) {
  const n = Math.min(state.length, cur.length);
  for (let i = 0; i < n; i++) if (cur[i] > state[i]) state[i] = cur[i];
  return state;
}

/**
 * Peak-hold trace (dB values): a new peak holds for holdSec, then falls at decayDb per second (never below the
 * current trace). holdSec = Infinity holds forever (until reset()).
 */
export class PeakHold {
  constructor(n) { this.v = new Float32Array(n).fill(-200); this.age = new Float32Array(n); }
  reset() { this.v.fill(-200); this.age.fill(0); }
  update(cur, dt, holdSec = 2, decayDb = 12) {
    const { v, age } = this;
    for (let i = 0; i < v.length; i++) {
      const c = cur[i];
      if (c >= v[i]) { v[i] = c; age[i] = 0; continue; }
      age[i] += dt;
      if (age[i] > holdSec) v[i] = Math.max(c, v[i] - decayDb * dt);
    }
    return v;
  }
}

/**
 * Fractional-octave smoothing of a power spectrum (bandwidth 1/fraction octave, e.g. 6 -> 1/6 oct): the mean power
 * of the bins within ±1/(2·fraction) octave of each bin (prefix sums: O(n)). fraction 0 = copy.
 */
export function octaveSmooth(power, fraction, out = new Float32Array(power.length)) {
  const n = power.length;
  if (!(fraction > 0)) { out.set(power); return out; }
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + power[i];
  const r = Math.pow(2, 1 / (2 * fraction));
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, Math.floor(k / r)), hi = Math.min(n - 1, Math.ceil(k * r));
    out[k] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ frequency axes
export const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
export const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);

/** Position of f on a 'log' | 'linear' | 'mel' axis from fmin (0) to fmax (1). */
export function freqToNorm(f, scale, fmin, fmax) {
  if (scale === 'linear') return (f - fmin) / (fmax - fmin);
  if (scale === 'mel') return (hzToMel(f) - hzToMel(fmin)) / (hzToMel(fmax) - hzToMel(fmin));
  return Math.log(Math.max(1e-9, f) / fmin) / Math.log(fmax / fmin);
}

/** Inverse of freqToNorm. */
export function normToFreq(t, scale, fmin, fmax) {
  if (scale === 'linear') return fmin + t * (fmax - fmin);
  if (scale === 'mel') return melToHz(hzToMel(fmin) + t * (hzToMel(fmax) - hzToMel(fmin)));
  return fmin * Math.pow(fmax / fmin, t);
}

/** n + 1 band edges (Hz) evenly spaced on the axis. */
export function bandEdges(n, scale, fmin, fmax) {
  const e = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) e[i] = normToFreq(i / n, scale, fmin, fmax);
  return e;
}

/**
 * Power spectrum -> dB per display band (edges in Hz): the loudest bin inside a band (peaks never vanish between
 * pixels); bands narrower than a bin interpolate the dB curve at the band centre instead (smooth low end).
 */
export function resampleBands(power, binHz, edges, out = new Float32Array(edges.length - 1)) {
  const nb = power.length;
  for (let i = 0; i < edges.length - 1; i++) {
    const b0 = edges[i] / binHz, b1 = edges[i + 1] / binHz;
    const k0 = Math.ceil(b0), k1 = Math.floor(b1);
    if (k1 >= k0 && k0 < nb) {
      let m = 0;
      for (let k = Math.max(0, k0); k <= Math.min(nb - 1, k1); k++) if (power[k] > m) m = power[k];
      out[i] = powToDb(m);
    } else {
      const c = Math.min(nb - 1, Math.max(0, (b0 + b1) * 0.5));
      const k = Math.min(nb - 2, Math.floor(c));
      const f = c - k;
      out[i] = powToDb(power[k]) * (1 - f) + powToDb(power[k + 1]) * f;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ colour maps
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const STOPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#e4cf5b', '#fee838'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  heat: ['#000000', '#1c0a4a', '#5a0f8a', '#a8166f', '#e83a2c', '#ff8a12', '#ffd23f', '#ffffff'],
  ice: ['#000000', '#08184a', '#123f8f', '#1f7ac2', '#3fb6e0', '#9be4f2', '#ffffff'],
  gray: ['#000000', '#ffffff'],
};
export const COLORMAP_OPTIONS = [
  { value: 'viridis', label: 'Viridis (colour-blind safe)' }, { value: 'cividis', label: 'Cividis (colour-blind safe)' },
  { value: 'magma', label: 'Magma' }, { value: 'inferno', label: 'Inferno' }, { value: 'heat', label: 'Heat' },
  { value: 'ice', label: 'Ice' }, { value: 'gray', label: 'Grayscale' },
];
export const COLORMAPS = Object.keys(STOPS);

/** [r, g, b] (0..255) of colour map `name` at t (0..1, clamped). */
export function mapColor(name, t) {
  const s = (STOPS[name] || STOPS.viridis).map(hex);
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (s.length - 1);
  const i = Math.min(s.length - 2, Math.floor(t));
  const f = t - i;
  return [0, 1, 2].map((c) => Math.round(s[i][c] + (s[i + 1][c] - s[i][c]) * f));
}

const lutCache = new Map();
/** 256-entry RGBA lookup table (Uint8ClampedArray, 1024 bytes) of a colour map. */
export function colormapLUT(name) {
  let lut = lutCache.get(name);
  if (lut) return lut;
  lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) { const [r, g, b] = mapColor(name, i / 255); lut[i * 4] = r; lut[i * 4 + 1] = g; lut[i * 4 + 2] = b; lut[i * 4 + 3] = 255; }
  lutCache.set(name, lut);
  return lut;
}

/** dB -> 0..1 between floor and floor + range. */
export const dbToNorm = (db, floor, range) => Math.max(0, Math.min(1, (db - floor) / Math.max(1e-6, range)));

// ------------------------------------------------------------------------------------------------ pitch / tuner
const geoCache = new Map();
/** YIN pitch of the newest samples of `mono` -> {freq (0 = none), conf, rms}. */
export function detectPitch(mono, sampleRate, { minFreq = 30, maxFreq = 4200, threshold = 0.12 } = {}) {
  const key = `${sampleRate}:${minFreq}:${maxFreq}`;
  let g = geoCache.get(key);
  if (!g) { g = yinGeometry(sampleRate, { minFreq, maxFreq }); geoCache.set(key, g); }
  const offset = mono.length - g.frameLength;
  if (offset < 0) return { freq: 0, conf: 0, rms: 0 };
  const r = yin(mono, sampleRate, { geometry: g, offset, threshold });
  if (r.freq && (r.freq < minFreq * 0.97 || r.freq > maxFreq * 1.03)) return { ...r, freq: 0 };
  return r;
}

/** Samples YIN needs for a frequency range (size the analysers with this). */
export const pitchFrameLength = (sampleRate, minFreq = 30, maxFreq = 4200) => yinGeometry(sampleRate, { minFreq, maxFreq }).frameLength;

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Tuner readout from successive pitch detections: level gate (dBFS RMS), confidence gate, a short median against
 * octave slips and one-pole smoothing of the cents (restarted on a note change). The last note stays (inactive)
 * for `holdSec` after the signal stops.
 * push({freq, conf, rms}, dt) -> {active, freq, note (noteOf), cents, levelDb, held}
 */
export class TunerTracker {
  constructor(o = {}) { this.o = { a4: 440, gateDb: -60, minConf: 0.8, smooth: 0.12, holdSec: 1.5, flats: false, ...o }; this.reset(); }
  set(o) { Object.assign(this.o, o); }
  reset() { this.hist = []; this.freq = 0; this.note = null; this.cents = 0; this.age = Infinity; }
  push({ freq, conf, rms }, dt = 1 / 30) {
    const o = this.o;
    const levelDb = rms > 0 ? 20 * Math.log10(rms) : -200;
    const ok = freq > 0 && conf >= o.minConf && levelDb >= o.gateDb;
    if (ok) {
      this.hist.push(freq);
      if (this.hist.length > 5) this.hist.shift();
      const f = median(this.hist);
      const nt = noteOf(f, o);
      if (!this.note || nt.midi !== this.note.midi) { this.cents = nt.cents; this.freq = f; } else {
        const k = smoothCoef(dt, o.smooth);
        this.cents = this.cents * k + nt.cents * (1 - k);
        this.freq = this.freq * k + f * (1 - k);
      }
      this.note = nt;
      this.age = 0;
    } else {
      this.age += dt;
      if (this.age > 0.12) this.hist = [];
    }
    const held = !ok && this.age <= o.holdSec && !!this.note;
    return { active: ok, held, freq: ok || held ? this.freq : 0, note: ok || held ? this.note : null, cents: this.cents, levelDb };
  }
}
