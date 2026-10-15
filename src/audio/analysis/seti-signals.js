// Signal search for the SETI Scope visualizer (src/ui/visualizers/seti): the classic radio-telescope searches
// mapped onto music, computed from AnalyserNode frames on the main thread. Pure math, Node-testable.
//
//   baseline smoothing  running mean of the power spectrum (spikes are measured against it)
//   spikes              strongest narrow spectral peak above the baseline -> frequency + note name
//   chirp               drift (Hz/s) of that peak over the last moments (linear regression on a continuous run)
//   gaussians           least-squares Gaussian (a·g(mu, sigma) + b) fitted to the loudness envelope
//   pulses              strongest periodicity of the onset (spectral flux) envelope -> BPM + beat phase
//   triplets            three equally spaced onsets, preferring spacings that are triplets of the pulse
//
// Also: colour ramp of the 3D plot, log-frequency band mapping, 4×4 camera / perspective math shared by the
// WebGL and the canvas renderers, and the string formatting of the panels.
import { autocorrelate, combScore } from './tempo.js';
import { PITCH_NAMES, keyFromChroma } from './key.js';

export const STAGES = ['baseline', 'spike', 'gaussian', 'pulse', 'triplet'];
export const STAGE_LABEL = {
  baseline: 'Baseline smoothing',
  spike: 'Searching for spikes',
  gaussian: 'Searching for Gaussians',
  pulse: 'Searching for pulses',
  triplet: 'Searching for triplets',
};
/** Spike power (peak / baseline) that scores 1.0 — the classic client's spike threshold. */
export const SPIKE_THRESHOLD = 24;
/** Hydrogen line (Hz): the "sky frequency" in the Data Info panel is offset from it by the song's tonic. */
export const HI_LINE_HZ = 1420405751.768;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ------------------------------------------------------------------ colour ramp
const RAMP = [
  [0.0, [0.04, 0.10, 0.45]],
  [0.22, [0.08, 0.38, 1.0]],
  [0.48, [0.10, 0.90, 0.32]],
  [0.74, [1.0, 0.92, 0.10]],
  [1.0, [1.0, 0.12, 0.05]],
];
/** Power 0..1 -> [r, g, b] 0..1: deep blue -> blue -> green -> yellow -> red. */
export function colorRamp(t) {
  t = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    if (t <= t1) {
      const [t0, c0] = RAMP[i - 1];
      const u = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return RAMP[RAMP.length - 1][1].slice();
}
export const rampCss = (t, alpha = 1) => { const [r, g, b] = colorRamp(t); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`; };
/** dB -> 0..1 between floor and ceil. */
export const dbToUnit = (db, floor = -96, ceil = -18) => clamp((db - floor) / (ceil - floor), 0, 1);

// ------------------------------------------------------------------ spectrum helpers
/** Log-spaced band edges (bin indices, [start, end) per band, each ≥ 1 bin wide) over [fMin, fMax]. */
export function makeBandMap(nBands, fftSize, sampleRate, fMin = 30, fMax = 16000) {
  const bins = fftSize / 2;
  const hzPerBin = sampleRate / fftSize;
  fMax = Math.min(fMax, sampleRate / 2);
  const edges = new Int32Array(nBands * 2);
  let prev = Math.max(1, Math.floor(fMin / hzPerBin));
  for (let b = 0; b < nBands; b++) {
    const f1 = fMin * (fMax / fMin) ** ((b + 1) / nBands);
    let end = Math.min(bins, Math.round(f1 / hzPerBin));
    if (end <= prev) end = Math.min(bins, prev + 1);
    edges[b * 2] = Math.min(prev, bins - 1);
    edges[b * 2 + 1] = Math.max(end, edges[b * 2] + 1);
    prev = end;
  }
  return edges;
}
/** Max dB per band (bands from makeBandMap). */
export function bandsFromDb(db, edges, out = new Float32Array(edges.length / 2)) {
  for (let b = 0; b < out.length; b++) {
    let m = -Infinity;
    for (let i = edges[b * 2], e = edges[b * 2 + 1]; i < e; i++) if (db[i] > m) m = db[i];
    out[b] = Number.isFinite(m) ? m : -200;
  }
  return out;
}
/** Running mean of `x` over ±halfWidth (edges use the available window). O(n) with a prefix sum. */
export function baselineSmooth(x, halfWidth = 16, out = new Float32Array(x.length)) {
  const n = x.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWidth), b = Math.min(n, i + halfWidth + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

/** Frequency -> { midi, name ('A4'), cents } (A4 = 440 Hz). null for f ≤ 0. */
export function freqToNote(f) {
  if (!(f > 0)) return null;
  const m = 69 + 12 * Math.log2(f / 440);
  const midi = Math.round(m);
  const pc = ((midi % 12) + 12) % 12;
  return { midi, name: `${PITCH_NAMES[pc]}${Math.floor(midi / 12) - 1}`, cents: Math.round((m - midi) * 100) };
}
export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

/**
 * Strongest spike: the local maximum of the power spectrum that is both loud and well above the baseline
 * (power = peak / running-mean baseline ratio, at least 2).
 * db: Float32Array of dB per bin (AnalyserNode.getFloatFrequencyData). Bins quieter than `rangeDb` below the
 * loudest bin are ignored (a "spike" in the noise floor is not a signal).
 * -> { bin, freq, power (ratio), score (power / SPIKE_THRESHOLD), db, note } | null
 */
export function findBestSpike(db, { sampleRate = 48000, fftSize = db.length * 2, minHz = 40, maxHz = 8000, halfWidth = 16, rangeDb = 45, floorDb = -100 } = {}, scratch = null) {
  const hzPerBin = sampleRate / fftSize;
  const i0 = Math.max(1, Math.floor(minHz / hzPerBin)), i1 = Math.min(db.length - 2, Math.ceil(maxHz / hzPerBin));
  if (i1 <= i0) return null;
  const n = db.length;
  const pw = scratch?.pw?.length === n ? scratch.pw : new Float32Array(n);
  let maxDb = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = Number.isFinite(db[i]) ? db[i] : -200;
    pw[i] = 10 ** (d / 10);
    if (i >= i0 && i <= i1 && d > maxDb) maxDb = d;
  }
  if (!(maxDb > floorDb)) return null;
  const base = baselineSmooth(pw, halfWidth, scratch?.base?.length === n ? scratch.base : undefined);
  if (scratch) { scratch.pw = pw; scratch.base = base; }
  // rank peaks by level + prominence (dB + 10·log10(power / baseline)): loud AND narrow wins
  let best = -1, bestR = 0, bestRank = -Infinity;
  for (let i = i0; i <= i1; i++) {
    if (db[i] < maxDb - rangeDb || db[i] < floorDb) continue;
    if (!(pw[i] >= pw[i - 1] && pw[i] >= pw[i + 1])) continue;
    const r = pw[i] / (base[i] || 1e-30);
    if (r < 2) continue;
    const rank = db[i] + 10 * Math.log10(r);
    if (rank > bestRank) { bestRank = rank; bestR = r; best = i; }
  }
  if (best < 0) return null;
  // parabolic interpolation on the dB values around the peak
  const a = db[best - 1], b = db[best], c = db[best + 1];
  const den = a - 2 * b + c;
  const delta = den < 0 ? clamp(0.5 * (a - c) / den, -0.5, 0.5) : 0;
  const freq = (best + delta) * hzPerBin;
  return { bin: best, freq, power: bestR, score: bestR / SPIKE_THRESHOLD, db: b, note: freqToNote(freq) };
}

/** 12-bin chroma (linear power per pitch class) of a dB spectrum between fMin and fMax. */
export function chromaFromDb(db, sampleRate, fftSize, out = new Float32Array(12), fMin = 60, fMax = 2000) {
  out.fill(0);
  const hz = sampleRate / fftSize;
  const i0 = Math.max(1, Math.ceil(fMin / hz)), i1 = Math.min(db.length - 1, Math.floor(fMax / hz));
  for (let i = i0; i <= i1; i++) {
    const p = 10 ** (db[i] / 10);
    if (!(p > 0)) continue;
    const m = 69 + 12 * Math.log2((i * hz) / 440);
    out[((Math.round(m) % 12) + 12) % 12] += p;
  }
  return out;
}
export const detectKeyFromChroma = (chroma) => keyFromChroma(Array.from(chroma));

/**
 * Spectral flux between two dB frames: half-wave rectified rise of the compressed magnitude (|X|^0.5, so the noise
 * floor barely counts and loud partials don't swamp everything), summed over bins i0..i1.
 */
export function spectralFlux(prev, cur, i0 = 1, i1 = Math.min(prev.length, cur.length) - 1) {
  let s = 0;
  for (let i = i0; i <= i1; i++) {
    const d = 10 ** (Math.max(cur[i], -140) / 40) - 10 ** (Math.max(prev[i], -140) / 40);
    if (d > 0) s += d;
  }
  return s;
}

/** RMS of a time-domain block in dBFS (−120 floor). */
export function rmsDb(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const r = Math.sqrt(s / Math.max(1, x.length));
  return r > 1e-6 ? 20 * Math.log10(r) : -120;
}

// ------------------------------------------------------------------ gaussian fit
/** Least-squares a·g + b for a fixed shape g (sums precomputed). */
function linFit(Sg, Sgg, Sy, Sgy, Syy, n) {
  const det = n * Sgg - Sg * Sg;
  if (!(Math.abs(det) > 1e-12)) return null;
  const a = (n * Sgy - Sg * Sy) / det;
  const b = (Sy - a * Sg) / n;
  const sse = Math.max(0, Syy - 2 * a * Sgy - 2 * b * Sy + a * a * Sgg + 2 * a * b * Sg + n * b * b);
  return { a, b, sse };
}
function evalShape(y, mu, sigma, Sy, Syy) {
  const n = y.length;
  let Sg = 0, Sgg = 0, Sgy = 0;
  const k = 1 / (2 * sigma * sigma);
  for (let i = 0; i < n; i++) {
    const d = i - mu;
    const g = Math.exp(-d * d * k);
    Sg += g; Sgg += g * g; Sgy += g * y[i];
  }
  return linFit(Sg, Sgg, Sy, Sgy, Syy, n);
}
/**
 * Fit y[i] ≈ a·exp(−(i−mu)²/(2σ²)) + b (a > 0) by a coarse grid over mu / σ, then three halving refinements.
 * -> { mu, sigma, a, b, r2 (fit score 0..1), chisq (mean squared residual), power (a / mean |y|) } | null
 */
export function fitGaussian(y, { sigmas = [0.06, 0.1, 0.16, 0.24, 0.34], steps = 24 } = {}) {
  const n = y?.length || 0;
  if (n < 8) return null;
  let Sy = 0, Syy = 0;
  for (let i = 0; i < n; i++) { Sy += y[i]; Syy += y[i] * y[i]; }
  const sst = Syy - (Sy * Sy) / n;
  if (!(sst > 1e-12)) return null;
  let best = null;
  const tryFit = (mu, sigma) => {
    if (!(sigma > 0.5)) return;
    const f = evalShape(y, mu, sigma, Sy, Syy);
    if (!f || !(f.a > 0)) return;
    if (!best || f.sse < best.sse) best = { mu, sigma, ...f };
  };
  for (let s = 0; s < sigmas.length; s++) for (let k = 0; k <= steps; k++) tryFit((k / steps) * (n - 1), sigmas[s] * n);
  if (!best) return null;
  let dMu = (n - 1) / steps / 2, dS = best.sigma * 0.25;
  for (let it = 0; it < 3; it++) {
    const { mu, sigma } = best;
    for (const m of [mu - dMu, mu, mu + dMu]) for (const s of [sigma - dS, sigma, sigma + dS]) tryFit(clamp(m, 0, n - 1), s);
    dMu /= 2; dS /= 2;
  }
  const meanAbs = Math.abs(Sy / n) || 1e-9;
  return { mu: best.mu, sigma: best.sigma, a: best.a, b: best.b, r2: clamp(1 - best.sse / sst, 0, 1), chisq: best.sse / n, power: best.a / meanAbs };
}
export const gaussianAt = (fit, i) => (fit ? fit.a * Math.exp(-((i - fit.mu) ** 2) / (2 * fit.sigma * fit.sigma)) + fit.b : 0);

// ------------------------------------------------------------------ pulses (beat)
/**
 * Strongest periodic transient of an onset envelope sampled at `fps`: autocorrelation (+ half the 2× lag, which
 * favours the true beat over its sub-divisions) weighted by a broad tempo prior around 120 BPM.
 * -> { bpm, period (s), lag (frames), power (normalized correlation), score (z-score of the peak), phase (0..1 at the
 *    end of the envelope: 0 = on the beat), lastBeat (frame index) } | null
 */
export function detectPulse(env, fps, { minBpm = 60, maxBpm = 200 } = {}) {
  const n = env?.length || 0;
  const lagMin = Math.max(2, Math.floor((60 * fps) / maxBpm));
  const lagMax = Math.ceil((60 * fps) / minBpm);
  if (n < lagMax * 2 + 2) return null;
  const acf = autocorrelate(env, Math.min(n - 2, lagMax * 2 + 1));
  let best = -1, bestS = -Infinity, sum = 0, sq = 0, cnt = 0;
  const S = new Float32Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const v = (acf[lag] + 0.5 * (acf[2 * lag] ?? 0)) * (0.5 + 0.5 * prior);
    S[lag] = v;
    sum += acf[lag]; sq += acf[lag] * acf[lag]; cnt++;
    if (v > bestS) { bestS = v; best = lag; }
  }
  if (best < 0 || !(acf[best] > 0)) return null;
  let lag = best;
  if (best > lagMin && best < lagMax) {
    const a = S[best - 1], b = S[best], c = S[best + 1];
    const den = a - 2 * b + c;
    if (den < 0) lag = best + clamp(0.5 * (a - c) / den, -0.5, 0.5);
  }
  const mean = sum / cnt;
  const sd = Math.sqrt(Math.max(1e-12, sq / cnt - mean * mean));
  const { phase: ph } = combScore(env, lag, { phaseStep: 0.5 });
  const k = Math.floor((n - 1 - ph) / lag);
  const lastBeat = ph + k * lag;
  return { bpm: (60 * fps) / lag, period: lag / fps, lag, power: acf[best], score: (acf[best] - mean) / sd, phase: clamp((n - 1 - lastBeat) / lag, 0, 1), lastBeat };
}

/** Onsets of an envelope: local maxima above an adaptive (local mean · k + delta) threshold, ≥ minGap apart. */
export function pickOnsets(env, fps, { k = 1.5, delta = 0.02, minGap = 0.07, win = 0.3 } = {}) {
  const n = env?.length || 0;
  const out = [];
  const w = Math.max(2, Math.round(win * fps));
  let gmax = 0;
  for (let i = 0; i < n; i++) if (env[i] > gmax) gmax = env[i];
  if (!(gmax > 0)) return out;
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (!(v > env[i - 1] && v >= env[i + 1])) continue;
    let s = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { s += env[j]; c++; }
    if (v < (s / c) * k + delta * gmax) continue;
    const t = i / fps;
    if (t - last < minGap) {
      if (out.length && v > out[out.length - 1].strength) { out[out.length - 1] = { t, strength: v }; last = t; }
      continue;
    }
    out.push({ t, strength: v });
    last = t;
  }
  return out;
}

// ------------------------------------------------------------------ triplets
const TRIPLET_RATIOS = [1 / 3, 2 / 3, 4 / 3];
/**
 * Best set of three equally spaced onsets. With `beatPeriod`, spacings of 1/3, 2/3 or 4/3 beat (a rhythmic
 * triplet against the pulse) score ×1.6 and are flagged isTriplet.
 * onsets: [{t, strength}] sorted by t. -> { times:[t1,t2,t3], period, power, score, err, isTriplet, ratio } | null
 */
export function findTriplet(onsets, { minSpacing = 0.08, maxSpacing = 1.2, tolerance = 0.06, beatPeriod = 0, maxOnsets = 48 } = {}) {
  const on = (onsets || []).slice(-maxOnsets);
  const n = on.length;
  if (n < 3) return null;
  let best = null;
  let smax = 0;
  for (const o of on) if (o.strength > smax) smax = o.strength;
  smax ||= 1;
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      const d = on[j].t - on[i].t;
      if (d < minSpacing) continue;
      if (d > maxSpacing) break;
      const target = on[j].t + d;
      const tol = Math.max(0.012, tolerance * d);
      // binary search for the onset nearest to target after j
      let lo = j + 1, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (on[mid].t < target) lo = mid + 1; else hi = mid; }
      let k = lo;
      if (k > j + 1 && Math.abs(on[k - 1].t - target) < Math.abs(on[k].t - target)) k--;
      const errAbs = Math.abs(on[k].t - target);
      if (k <= j || errAbs > tol) continue;
      const err = errAbs / tol;
      const power = (on[i].strength + on[j].strength + on[k].strength) / (3 * smax);
      let ratio = 0, isTriplet = false;
      if (beatPeriod > 0) {
        ratio = d / beatPeriod;
        isTriplet = TRIPLET_RATIOS.some((r) => Math.abs(ratio / r - 1) < 0.07);
      }
      const score = power * (1 - 0.5 * err) * (isTriplet ? 1.6 : 1);
      if (!best || score > best.score) best = { times: [on[i].t, on[j].t, on[k].t], period: (on[k].t - on[i].t) / 2, power, score, err, isTriplet, ratio };
    }
  }
  return best;
}

// ------------------------------------------------------------------ chirp
/**
 * Pitch drift (Hz/s) of the most recent continuous run of peak frequencies: points [{t, f}] in time order; a jump
 * of more than `maxSemis` semitones starts a new run. -> { rate, r2, n, span } (rate 0 when there is no usable run)
 */
export function estimateChirp(points, { maxSemis = 1, minPoints = 5, minSpan = 0.2 } = {}) {
  const none = { rate: 0, r2: 0, n: 0, span: 0 };
  const p = points || [];
  if (p.length < minPoints) return none;
  let start = p.length - 1;
  while (start > 0) {
    const a = p[start - 1].f, b = p[start].f;
    if (!(a > 0 && b > 0) || Math.abs(12 * Math.log2(b / a)) > maxSemis) break;
    start--;
  }
  const run = p.slice(start);
  const n = run.length;
  const span = run[n - 1].t - run[0].t;
  if (n < minPoints || span < minSpan) return { ...none, n, span };
  let st = 0, sf = 0;
  for (const q of run) { st += q.t; sf += q.f; }
  const mt = st / n, mf = sf / n;
  let stt = 0, stf = 0, sff = 0;
  for (const q of run) { const dt = q.t - mt, df = q.f - mf; stt += dt * dt; stf += dt * df; sff += df * df; }
  if (!(stt > 0)) return { ...none, n, span };
  const rate = stf / stt;
  const r2 = sff > 0 ? clamp((stf * stf) / (stt * sff), 0, 1) : 1;
  return { rate, r2, n, span };
}

// ------------------------------------------------------------------ 3D math (column-major 4×4, WebGL layout)
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}
export function lookAt(eye, target, up = [0, 1, 0]) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx;
  m[4] = xy; m[5] = yy; m[6] = zy;
  m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}
export function mulMat4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
/** World point -> screen {x, y (pixels, y down), z (NDC depth), w}; null behind the camera. */
export function projectPoint(m, x, y, z, width, height) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(cw > 1e-6)) return null;
  return { x: (cx / cw * 0.5 + 0.5) * width, y: (1 - (cy / cw * 0.5 + 0.5)) * height, z: cz / cw, w: cw };
}

export const CAMERA_MODES = ['orbit', 'fixed', 'fly'];
/**
 * Camera for the plot (the floor spans x ∈ [−1, 1] frequency, z ∈ [−depth, 0] time with now at z = 0).
 * orbit: slow back-and-forth swing around the plot; fixed: the classic three-quarter view; fly: low, gliding along time.
 * Narrow (portrait) viewports pull the camera back so the whole plot stays in frame.
 */
export function cameraPose(mode, t, { depth = 2, aspect = 16 / 9 } = {}) {
  const zoom = Math.max(1, Math.min(3.4, 1.55 / Math.max(0.3, aspect)));
  const away = (target, eye) => [target[0] + (eye[0] - target[0]) * zoom, target[1] + (eye[1] - target[1]) * zoom, target[2] + (eye[2] - target[2]) * zoom];
  const target = [0, 0.18, -depth * 0.45];
  if (mode === 'fixed') return { eye: away(target, [1.55, 1.25, 1.55]), target };
  if (mode === 'fly') {
    const s = Math.sin(t * 0.21);
    const tg = [-0.25 * s, 0.12, -depth * 0.8];
    return { eye: away(tg, [0.75 * s, 0.42 + 0.08 * Math.sin(t * 0.37), 0.9 + 0.25 * Math.cos(t * 0.13)]), target: tg };
  }
  const yaw = 0.62 + 0.55 * Math.sin(t * 0.07);
  const r = 2.35;
  return { eye: away(target, [target[0] + Math.sin(yaw) * r, 1.15 + 0.12 * Math.sin(t * 0.05), target[2] + Math.cos(yaw) * r]), target };
}
export function viewProjection(mode, t, aspect, opts = {}) {
  const { eye, target } = cameraPose(mode, t, { ...opts, aspect });
  return mulMat4(perspective(42 * Math.PI / 180, aspect, 0.05, 60), lookAt(eye, target));
}

// ------------------------------------------------------------------ formatting
export const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
export function formatHz(f) {
  if (!(f > 0)) return '—';
  if (f >= 1e9) return `${(f / 1e9).toFixed(9)} GHz`;
  if (f >= 1e6) return `${(f / 1e6).toFixed(6)} MHz`;
  if (f >= 1000) return `${(f / 1000).toFixed(3)} kHz`;
  return `${f.toFixed(2)} Hz`;
}
export const formatNote = (note) => (note ? `${note.name} ${note.cents >= 0 ? '+' : '−'}${Math.abs(note.cents)}¢` : '');
/** Tongue-in-cheek sky frequency: the hydrogen line, Doppler-shifted by the tonic (1 Hz of tonic = 1 kHz). */
export const skyFrequency = (tonicHz) => HI_LINE_HZ + (tonicHz > 0 ? tonicHz * 1000 : 0);
/** Right ascension from the song position: bar = hours, beat = minutes, 16th = seconds. */
export const formatRA = (bar, beat, sixteenth) => `${bar} hr ${String(beat).padStart(2, '0')}' ${String(sixteenth).padStart(2, '0')}''`;
/** Declination from the key: major keys in the northern sky (+7.5° … +90°), minor keys in the southern. */
export function keyToDec(root, mode) {
  const d = (((root % 12) + 12) % 12 + 1) * 7.5;
  return mode === 'minor' ? -d : d;
}
export const formatDec = (d) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}°`;
export function formatCpuTime(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h} hr ${String(m).padStart(2, '0')} min ${s.toFixed(1).padStart(4, '0')} sec`;
}
export const julianDate = (date) => date.getTime() / 86400000 + 2440587.5;
export function formatRecordedOn(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const s = d.toUTCString().replace(/ GMT$/, '').replace(',', '');
  return `${julianDate(d).toFixed(5)} (${s})`;
}
export const formatChirp = (rate) => `${rate >= 0 ? '+' : '−'}${Math.abs(rate || 0).toFixed(4)} Hz/s`;
export const formatPercent = (x) => `${(clamp(x || 0, 0, 1) * 100).toFixed(3)}%`;
export const formatPower = (p) => (Number.isFinite(p) ? (p >= 1000 ? p.toExponential(2) : p.toFixed(2)) : '—');

/** Text rows of the Data Analysis panel: [[label, value], …]. */
export function analysisRows(st) {
  const s = st.spike, g = st.gaussian, p = st.pulse, tr = st.triplet;
  return [
    ['Doing', STAGE_LABEL[st.stage] || STAGE_LABEL.baseline],
    ['Chirp rate', formatChirp(st.chirp?.rate || 0)],
    ['Fft length', `${st.fftSize || 0}`],
    ['Best spike', s ? `power ${formatPower(s.power)}, score ${fmt(s.score, 3)}` : 'power —, score —'],
    ['', s ? `${formatHz(s.freq)} ${formatNote(s.note)}` : '—'],
    ['Best gaussian', g ? `power ${formatPower(g.power)}, fit ${fmt(g.r2, 3)}` : 'power —, fit —'],
    ['Best pulse', p ? `power ${fmt(p.power, 3)}, score ${fmt(p.score, 2)}` : 'power —, score —'],
    ['', p ? `${fmt(p.bpm, 1)} BPM, period ${fmt(p.period, 3)} s, phase ${fmt(p.phase, 2)}` : '—'],
    ['Best triplet', tr ? `power ${fmt(tr.power, 3)}, score ${fmt(tr.score, 3)}` : 'power —, score —'],
    ['', tr ? `period ${fmt(tr.period, 3)} s${tr.isTriplet ? ' (triplet)' : ' (straight)'}` : '—'],
  ];
}

// ------------------------------------------------------------------ the streaming analyzer
export const ENV_FPS = 50;
const STAGE_DWELL = 0.55; // seconds each search stage stays on screen

/**
 * Feed it AnalyserNode frames (dB spectrum + time-domain block) with a timestamp in seconds; read `state`.
 * Per frame: baseline + spike search, loudness / flux envelopes (resampled to ENV_FPS), chirp, chroma.
 * The Gaussian / pulse / triplet searches run when their stage comes up (one search per stage step).
 */
export class SetiAnalyzer {
  constructor({ sampleRate = 48000, fftSize = 4096, envSeconds = 8 } = {}) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.envLen = Math.round(envSeconds * ENV_FPS);
    this.loud = new Float32Array(this.envLen).fill(-120); // dBFS ring, oldest first after unroll
    this.flux = new Float32Array(this.envLen);
    this.envHead = 0; // number of samples written
    this.nextEnvT = null;
    this.prevDb = null;
    this.pitch = []; // [{t, f}]
    this.chroma = new Float32Array(12);
    this._chromaTmp = new Float32Array(12);
    this._scratch = {};
    this.stageIndex = 0;
    this.stageT = 0;
    this.lastKeyT = -1;
    this.state = { stage: 'baseline', fftSize, spike: null, gaussian: null, pulse: null, triplet: null, chirp: { rate: 0, r2: 0, n: 0, span: 0 }, key: null, loudDb: -120, onsets: [], gaussWindow: null };
  }

  /** The last `seconds` of an envelope ring as a plain array (oldest first). */
  envelope(which = 'loud', seconds = this.envLen / ENV_FPS) {
    const ring = which === 'flux' ? this.flux : this.loud;
    const n = Math.min(this.envHead, this.envLen, Math.round(seconds * ENV_FPS));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ring[(this.envHead - n + i) % this.envLen];
    return out;
  }

  push(db, time, t) {
    const st = this.state;
    const n = db.length;
    // 1) baseline smoothing + spike search (every frame)
    st.spike = findBestSpike(db, { sampleRate: this.sampleRate, fftSize: this.fftSize }, this._scratch);
    // 2) loudness + flux envelopes on a fixed ENV_FPS grid
    const loud = time ? rmsDb(time) : -120;
    st.loudDb = loud;
    const hz = this.sampleRate / this.fftSize;
    const fx = this.prevDb ? spectralFlux(this.prevDb, db, 1, Math.min(n - 1, Math.round(10000 / hz))) : 0;
    if (!this.prevDb || this.prevDb.length !== n) this.prevDb = new Float32Array(n);
    this.prevDb.set(db);
    if (this.nextEnvT === null || t - this.nextEnvT > 3 || t < this.nextEnvT - 1) this.nextEnvT = t; // first frame / long gap / clock reset
    this._fluxAcc = (this._fluxAcc || 0) + fx; // flux accumulates between envelope samples (any frame rate)
    while (this.nextEnvT <= t) {
      const i = this.envHead % this.envLen;
      this.loud[i] = loud;
      this.flux[i] = this._fluxAcc;
      this._fluxAcc = 0;
      this.envHead++;
      this.nextEnvT += 1 / ENV_FPS;
    }
    // 3) chirp: drift of strong spikes
    if (st.spike && st.spike.power > 6 && loud > -70) this.pitch.push({ t, f: st.spike.freq });
    while (this.pitch.length && t - this.pitch[0].t > 1.5) this.pitch.shift();
    st.chirp = estimateChirp(this.pitch);
    // 4) chroma (leaky, ~4 s) -> key once a second
    if (loud > -70) {
      chromaFromDb(db, this.sampleRate, this.fftSize, this._chromaTmp);
      let tot = 0; for (let k = 0; k < 12; k++) tot += this._chromaTmp[k];
      if (tot > 0) for (let k = 0; k < 12; k++) this.chroma[k] = this.chroma[k] * 0.985 + (this._chromaTmp[k] / tot) * 0.015;
    }
    if (t - this.lastKeyT >= 1) {
      this.lastKeyT = t;
      let tot = 0; for (let k = 0; k < 12; k++) tot += this.chroma[k];
      st.key = tot > 0.2 ? detectKeyFromChroma(this.chroma) : null;
    }
    // 5) stage rotation: run the search of the stage that comes up
    if (t - this.stageT >= STAGE_DWELL || t < this.stageT) {
      this.stageT = t;
      this.stageIndex = (this.stageIndex + 1) % STAGES.length;
      st.stage = STAGES[this.stageIndex];
      this.runStage(st.stage);
    }
    return st;
  }

  runStage(stage) {
    const st = this.state;
    if (stage === 'gaussian') {
      const env = this.envelope('loud', 4);
      // power above a −72 dB floor, linear (a Gaussian in power, like the telescope's beam pattern)
      const y = new Float32Array(env.length);
      for (let i = 0; i < y.length; i++) y[i] = 10 ** (Math.max(0, env[i] + 72) / 20) - 1;
      st.gaussian = fitGaussian(y);
      st.gaussWindow = y;
    } else if (stage === 'pulse') {
      st.pulse = detectPulse(this.envelope('flux', 6), ENV_FPS);
    } else if (stage === 'triplet') {
      const env = this.envelope('flux', 4);
      st.onsets = pickOnsets(env, ENV_FPS);
      st.triplet = findTriplet(st.onsets, { beatPeriod: st.pulse?.period || 0 });
    }
  }
}
