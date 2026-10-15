// Spectral editing core (pure JS, Node-safe): STFT / ISTFT with weighted overlap-add, a spectrogram for display and
// the edit operations of the spectral editor (src/ui/spectral-editor.js).
//
//   stft(x, {fftSize, hop})            -> Spectrum { N, H, frames, bins, re[k], im[k] (Float64Array, N/2+1 bins), length }
//   istft(spec)                        -> Float64Array (length = spec.length); unedited -> x (perfect reconstruction)
//   applySpectralEdit(spec, sel, op)   -> mutates the spectrum inside a feathered time × frequency selection
//   processRegion(x, sr, sel, op)      -> Float32Array copy of x with the edit applied (only the selection's
//                                         neighbourhood is resynthesised; everything else is copied bit-exact)
//   spectrogram(x, sr, {columns})      -> { cols, bins, db: Float32Array(cols*bins), fftSize, hopSec } for drawing
//
// Framing: frame k covers samples [k·H − N, k·H) shifted by `pad` = N, i.e. the signal is zero-extended by N on both
// sides so every sample is covered by N/H frames. Analysis and synthesis windows are both √(periodic Hann); the
// overlap-add is normalised by the exact per-sample sum of wa·ws, so reconstruction is exact for any hop ≤ N/2.
//
// Selection: { t0, t1 } seconds and { f0, f1 } Hz relative to the analysed signal, plus optional feathering
// { featherSec, featherHz } (soft edges avoid ringing at the selection border).
// Ops: { type: 'gain', db } (attenuate: db < 0; boost: db > 0), { type: 'remove' } (gain −∞),
//      { type: 'heal' } (interpolate magnitudes across the selection from the frames just outside it, keeping the
//      original phase), { type: 'isolate' } (inside the selected time span keep only the selected band).
import { fft, rng32 } from './fft.js';

const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

const winCache = new Map();
/** √(periodic Hann) of length N (analysis = synthesis window: their product is a Hann window). */
export function sqrtHann(N) {
  let w = winCache.get(N);
  if (!w) {
    w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    winCache.set(N, w);
  }
  return w;
}

/**
 * Short-time Fourier transform of a real signal.
 * opts: fftSize (power of two, default 2048), hop (default fftSize/4, must be ≤ fftSize/2).
 */
export function stft(x, opts = {}) {
  const N = opts.fftSize || 2048;
  if (!isPow2(N)) throw new Error('stft: fftSize must be a power of two');
  const H = Math.max(1, Math.min(N >> 1, Math.round(opts.hop || N / 4)));
  const len = x.length;
  const w = sqrtHann(N);
  const bins = (N >> 1) + 1;
  // frame k starts at k·H − N (signal index); frames until the last one that still touches the signal
  const frames = Math.floor((len + N - 1) / H) + 1;
  const re = new Array(frames), im = new Array(frames);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let k = 0; k < frames; k++) {
    const s = k * H - N;
    for (let i = 0; i < N; i++) {
      const j = s + i;
      br[i] = j >= 0 && j < len ? x[j] * w[i] : 0;
      bi[i] = 0;
    }
    fft(br, bi);
    re[k] = br.slice(0, bins);
    im[k] = bi.slice(0, bins);
  }
  return { N, H, frames, bins, re, im, length: len };
}

/** Inverse STFT (weighted overlap-add, exact normalisation). -> Float64Array of spec.length samples. */
export function istft(spec) {
  const { N, H, frames, bins, re, im, length } = spec;
  const w = sqrtHann(N);
  const out = new Float64Array(length);
  const norm = new Float64Array(length);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let k = 0; k < frames; k++) {
    // Hermitian spectrum -> real frame
    const r = re[k], m = im[k];
    for (let b = 0; b < bins; b++) { br[b] = r[b]; bi[b] = m[b]; }
    for (let b = bins; b < N; b++) { br[b] = r[N - b]; bi[b] = -m[N - b]; }
    bi[0] = 0; bi[N >> 1] = 0;
    fft(br, bi, true);
    const s = k * H - N;
    for (let i = 0; i < N; i++) {
      const j = s + i;
      if (j < 0 || j >= length) continue;
      out[j] += (br[i] / N) * w[i];
      norm[j] += w[i] * w[i];
    }
  }
  for (let j = 0; j < length; j++) out[j] = norm[j] > 1e-9 ? out[j] / norm[j] : 0;
  return out;
}

/** Centre time (s) of frame k. */
export const frameTime = (spec, k, sr) => (k * spec.H - spec.N / 2) / sr;
/** Centre frequency (Hz) of bin b. */
export const binFreq = (spec, b, sr) => (b * sr) / spec.N;

/** 0..1 weight of x in [a, b] with a linear feather of width f outside the edges (1 inside). */
function edgeWeight(x, a, b, f) {
  if (x >= a && x <= b) return 1;
  if (!(f > 0)) return 0;
  const d = x < a ? a - x : x - b;
  return d >= f ? 0 : 1 - d / f;
}

/**
 * Normalised selection: seconds / Hz, ordered, with feathering defaults (one hop in time, a quarter of the band or
 * 2 bins, whichever is larger, in frequency — capped at 200 Hz).
 */
export function normalizeSelection(sel, spec, sr) {
  const t0 = Math.max(0, Math.min(sel.t0, sel.t1)), t1 = Math.max(sel.t0, sel.t1);
  const nyq = sr / 2;
  const f0 = Math.max(0, Math.min(sel.f0 ?? 0, sel.f1 ?? nyq)), f1 = Math.min(nyq, Math.max(sel.f0 ?? 0, sel.f1 ?? nyq));
  const binHz = sr / spec.N;
  return {
    t0, t1, f0, f1,
    featherSec: sel.featherSec ?? spec.H / sr,
    featherHz: sel.featherHz ?? Math.min(200, Math.max(2 * binHz, (f1 - f0) * 0.05)),
  };
}

/** Per-frame and per-bin selection weights (Float64Array frames / bins). */
export function selectionWeights(spec, sel, sr) {
  const s = normalizeSelection(sel, spec, sr);
  const wt = new Float64Array(spec.frames), wf = new Float64Array(spec.bins);
  for (let k = 0; k < spec.frames; k++) wt[k] = edgeWeight(frameTime(spec, k, sr), s.t0, s.t1, s.featherSec);
  const full = s.f0 <= 0 && s.f1 >= sr / 2;
  for (let b = 0; b < spec.bins; b++) wf[b] = full ? 1 : edgeWeight(binFreq(spec, b, sr), s.f0, s.f1, s.featherHz);
  return { wt, wf, sel: s };
}

/**
 * Apply an edit op to a spectrum (in place). sr = sample rate of the analysed signal.
 * op: {type:'gain', db} | {type:'remove'} | {type:'heal', context?} | {type:'isolate'}
 */
export function applySpectralEdit(spec, sel, op, sr) {
  const { wt, wf } = selectionWeights(spec, sel, sr);
  const type = op?.type || 'gain';
  if (type === 'gain' || type === 'remove' || type === 'attenuate') {
    const db = type === 'remove' ? -Infinity : Number(op.db ?? (type === 'attenuate' ? -12 : 0));
    const g = db === -Infinity ? 0 : Math.pow(10, db / 20);
    for (let k = 0; k < spec.frames; k++) {
      if (!wt[k]) continue;
      const r = spec.re[k], m = spec.im[k];
      for (let b = 0; b < spec.bins; b++) {
        const w = wt[k] * wf[b];
        if (!w) continue;
        const f = 1 + (g - 1) * w;
        r[b] *= f; m[b] *= f;
      }
    }
    return spec;
  }
  if (type === 'isolate') {
    for (let k = 0; k < spec.frames; k++) {
      if (!wt[k]) continue;
      const r = spec.re[k], m = spec.im[k];
      for (let b = 0; b < spec.bins; b++) {
        const f = 1 - wt[k] * (1 - wf[b]); // out of band -> removed while the selection lasts
        r[b] *= f; m[b] *= f;
      }
    }
    return spec;
  }
  if (type === 'heal') return heal(spec, wt, wf, op);
  throw new Error(`Unknown spectral edit: ${type}`);
}

/**
 * Heal: inside the (fully selected) frames, each selected bin's magnitude is replaced by a log-magnitude
 * interpolation between the average magnitude of `context` frames just before and just after the selection
 * (one side only at the signal edges); frames fully inside the selection continue the
 * surrounding phase (phase-vocoder style), feathered frames keep their own.
 * Feathered edges blend original and healed magnitudes.
 */
function heal(spec, wt, wf, op) {
  const ctxN = Math.max(1, op.context || 4);
  let ka = -1, kb = -1;
  for (let k = 0; k < spec.frames; k++) if (wt[k] >= 1) { if (ka < 0) ka = k; kb = k; }
  if (ka < 0) { // selection narrower than a frame: heal the frames with the strongest weight
    let best = 0;
    for (let k = 0; k < spec.frames; k++) if (wt[k] > best) { best = wt[k]; ka = kb = k; }
    if (ka < 0) return spec;
  }
  // frames touched by the feather count as "inside": context comes from frames with no selection weight at all
  let a = ka, b = kb;
  while (a > 0 && wt[a - 1] > 0) a--;
  while (b < spec.frames - 1 && wt[b + 1] > 0) b++;
  const mag = (k, bin) => Math.hypot(spec.re[k][bin], spec.im[k][bin]);
  const avg = (from, to, bin) => {
    let s = 0, n = 0;
    for (let k = from; k <= to; k++) { if (k < 0 || k >= spec.frames) continue; s += mag(k, bin); n++; }
    return n ? s / n : null;
  };
  const rnd = rng32(0x5eed);
  for (let bin = 0; bin < spec.bins; bin++) {
    if (!wf[bin]) continue;
    const before = a > 0 ? avg(a - ctxN, a - 1, bin) : null;
    const after = b < spec.frames - 1 ? avg(b + 1, b + ctxN, bin) : null;
    if (before == null && after == null) continue;
    const lb = Math.log((before ?? after) + 1e-12), la = Math.log((after ?? before) + 1e-12);
    // phase of the previous frame (propagated at the bin's centre frequency where the original is too weak to use)
    const phase = (k) => Math.atan2(spec.im[k][bin], spec.re[k][bin]);
    let prevPh = a > 0 ? phase(a - 1) : rnd() * 2 * Math.PI;
    // phase advance per hop: measured from the two frames before the selection (phase-vocoder instantaneous
    // frequency), else the bin's centre frequency
    const expected = (2 * Math.PI * bin * spec.H) / spec.N;
    let adv = expected;
    if (a >= 2) {
      const d = phase(a - 1) - phase(a - 2) - expected;
      adv = expected + (d - 2 * Math.PI * Math.round(d / (2 * Math.PI)));
    }
    for (let k = a; k <= b; k++) {
      const r = spec.re[k], m = spec.im[k];
      const w = wt[k] * wf[bin];
      const cur = Math.hypot(r[bin], m[bin]);
      if (!w) { prevPh = Math.atan2(m[bin], r[bin]); continue; }
      const t = b > a ? (k - a) / (b - a) : 0.5;
      const target = Math.exp(lb + (la - lb) * t);
      const next = cur + (target - cur) * w;
      // frames fully inside the selection continue the surrounding sound's phase coherently (so a gap or a burst
      // shorter than a frame is replaced, not just rescaled); feathered frames keep their own phase
      const ph = wt[k] >= 1 || cur < target * 0.25 ? prevPh + adv : Math.atan2(m[bin], r[bin]);
      r[bin] = next * Math.cos(ph); m[bin] = next * Math.sin(ph);
      prevPh = ph;
    }
  }
  return spec;
}

/**
 * Apply a spectral edit to a channel (Float32Array / number[]) -> new Float32Array (the input is not modified).
 * Only the selection ± (feather + 2·fftSize + heal context) is analysed and resynthesised; the rest is copied.
 * opts: { fftSize = 2048, hop = fftSize / 4 }
 */
export function processRegion(x, sr, sel, op, opts = {}) {
  const N = opts.fftSize || 2048;
  const H = opts.hop || N / 4;
  const out = Float32Array.from(x);
  const t0 = Math.max(0, Math.min(sel.t0, sel.t1)), t1 = Math.max(sel.t0, sel.t1);
  const feather = sel.featherSec ?? H / sr;
  const margin = Math.ceil(feather * sr) + 2 * N + (op?.type === 'heal' ? (op.context || 4) * H + N : 0);
  const s0 = Math.max(0, Math.floor(t0 * sr) - margin);
  const s1 = Math.min(x.length, Math.ceil(t1 * sr) + margin);
  if (s1 <= s0) return out;
  const seg = x.subarray ? x.subarray(s0, s1) : x.slice(s0, s1);
  const spec = stft(seg, { fftSize: N, hop: H });
  applySpectralEdit(spec, { ...sel, t0: t0 - s0 / sr, t1: t1 - s0 / sr }, op, sr);
  const y = istft(spec);
  for (let i = 0; i < y.length; i++) out[s0 + i] = y[i];
  return out;
}

/**
 * Display spectrogram: `columns` evenly spaced Hann-windowed FFTs of `x` (mono), magnitude in dBFS
 * (0 dB = a full-scale sine). -> { cols, bins, db: Float32Array(cols * bins) column-major, fftSize, hopSec }
 */
export function spectrogram(x, sr, opts = {}) {
  const N = opts.fftSize || 2048;
  const cols = Math.max(1, Math.min(opts.columns || 800, 8192));
  const bins = (N >> 1) + 1;
  const db = new Float32Array(cols * bins);
  const w = sqrtHann(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  const step = x.length / cols;
  const ref = N / 4; // Hann-windowed full-scale sine peak bin magnitude (sum of the window / 2)
  for (let c = 0; c < cols; c++) {
    const centre = Math.floor((c + 0.5) * step);
    const s = centre - (N >> 1);
    for (let i = 0; i < N; i++) {
      const j = s + i;
      br[i] = j >= 0 && j < x.length ? x[j] * w[i] * w[i] : 0;
      bi[i] = 0;
    }
    fft(br, bi);
    const o = c * bins;
    for (let b = 0; b < bins; b++) db[o + b] = 20 * Math.log10(Math.hypot(br[b], bi[b]) / ref + 1e-9);
  }
  return { cols, bins, db, fftSize: N, hopSec: step / sr, sampleRate: sr };
}
