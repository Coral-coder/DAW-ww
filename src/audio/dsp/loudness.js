// Loudness metering per ITU-R BS.1770-4 / EBU R128 (pure JS, Node-testable; also loaded by the realtime meter).
//
//   kWeighting(sampleRate)              -> [{b0,b1,b2,a1,a2} shelf, {…} high-pass] (exact for any sample rate)
//   measureLoudness(channels, sampleRate, {truePeak=true})
//       -> { integrated (LUFS), momentaryMax, shortTermMax, lra (LU), truePeakDb (dBTP), samplePeakDb, duration }
//   new LoudnessMeter()                 streaming: push(energy) per 100 ms sub-block (sum over channels of the
//                                       K-weighted mean square), read momentary / shortTerm / integrated / lra
//   loudnessOf(energy) = -0.691 + 10·log10(energy)
//
// Gating (BS.1770-4): 400 ms blocks, 75 % overlap (100 ms hop); absolute gate −70 LUFS, relative gate −10 LU.
// Loudness range (EBU Tech 3342): 3 s short-term values every 100 ms, absolute gate −70, relative gate −20 LU,
// LRA = 95th − 10th percentile. Channel weights: 1.0 for L / R (stereo and mono content).
import { truePeak, limitTruePeak } from './truepeak.js';

export const ABS_GATE = -70;
export const REL_GATE_I = -10;
export const REL_GATE_LRA = -20;

/** K-weighting biquads (pre-filter shelf + RLB high-pass) for `sampleRate`, from the BS.1770 analogue prototypes. */
export function kWeighting(sampleRate) {
  // stage 1: high shelf (+4 dB above ~1.5 kHz)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // stage 2: RLB high-pass (~38 Hz)
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

export const loudnessOf = (energy) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);
const energyOf = (lufs) => Math.pow(10, (lufs + 0.691) / 10);

/** K-weighted copy of one channel (Float64Array). */
export function kFilter(data, sampleRate, coeffs = kWeighting(sampleRate)) {
  const out = new Float64Array(data.length);
  let x = data;
  for (let s = 0; s < coeffs.length; s++) {
    const { b0, b1, b2, a1, a2 } = coeffs[s];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
      out[i] = y;
    }
    x = out;
  }
  return out;
}

/** Sum over channels of the K-weighted mean square of each 100 ms sub-block (the last partial block is dropped). */
export function subblockEnergies(channels, sampleRate) {
  const hop = Math.round(sampleRate / 10);
  const n = Math.floor((channels[0]?.length || 0) / hop);
  const e = new Float64Array(n);
  const coeffs = kWeighting(sampleRate);
  for (const ch of channels) {
    const k = kFilter(ch, sampleRate, coeffs);
    for (let b = 0; b < n; b++) {
      let s = 0;
      const o = b * hop;
      for (let i = 0; i < hop; i++) s += k[o + i] * k[o + i];
      e[b] += s / hop;
    }
  }
  // mono content counts as one channel (BS.1770: G = 1 per channel)
  return e;
}

/** Mean energy of windows of `len` sub-blocks ending at each index ≥ len − 1 (hop = 1 sub-block). */
function windows(sub, len) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < sub.length; i++) {
    acc += sub[i];
    if (i >= len) acc -= sub[i - len];
    if (i >= len - 1) out.push(acc / len);
  }
  return out;
}

/** Gated integrated loudness of 400 ms block energies. */
export function integratedOf(blocks) {
  const abs = energyOf(ABS_GATE);
  const g1 = blocks.filter((e) => e > abs);
  if (!g1.length) return -Infinity;
  const rel = loudnessOf(g1.reduce((a, b) => a + b, 0) / g1.length) + REL_GATE_I;
  const relE = energyOf(rel);
  const g2 = g1.filter((e) => e > relE);
  if (!g2.length) return -Infinity;
  return loudnessOf(g2.reduce((a, b) => a + b, 0) / g2.length);
}

/** Loudness range (LU) of 3 s short-term energies. */
export function lraOf(shortTerm) {
  const abs = energyOf(ABS_GATE);
  const g1 = shortTerm.filter((e) => e > abs);
  if (g1.length < 2) return 0;
  const rel = energyOf(loudnessOf(g1.reduce((a, b) => a + b, 0) / g1.length) + REL_GATE_LRA);
  const l = g1.filter((e) => e > rel).map(loudnessOf).sort((a, b) => a - b);
  if (l.length < 2) return 0;
  const pct = (p) => {
    const x = (p / 100) * (l.length - 1);
    const i = Math.floor(x);
    return l[i] + (l[Math.min(l.length - 1, i + 1)] - l[i]) * (x - i);
  };
  return Math.max(0, pct(95) - pct(10));
}

/** Full offline measurement of a finished render (Float32Array per channel). */
export function measureLoudness(channels, sampleRate, { truePeak: tp = true } = {}) {
  const sub = subblockEnergies(channels, sampleRate);
  const mom = windows(sub, 4);
  const st = windows(sub, 30);
  let sp = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > sp) sp = a; }
  const tpl = tp ? truePeak(channels) : sp;
  return {
    integrated: integratedOf(mom),
    momentaryMax: mom.length ? loudnessOf(Math.max(...mom)) : -Infinity,
    shortTermMax: st.length ? loudnessOf(Math.max(...st)) : -Infinity,
    lra: lraOf(st),
    truePeakDb: tpl > 0 ? 20 * Math.log10(tpl) : -Infinity,
    samplePeakDb: sp > 0 ? 20 * Math.log10(sp) : -Infinity,
    duration: (channels[0]?.length || 0) / sampleRate,
  };
}

/**
 * Streaming meter fed with 100 ms sub-block energies (from the loudness worklet or an analyser fallback).
 * momentary = last 400 ms, shortTerm = last 3 s, integrated / lra over everything since reset().
 */
export class LoudnessMeter {
  constructor() { this.reset(); }
  reset() {
    this.sub = [];
    this.blocks = []; // 400 ms energies (gating)
    this.short = []; // 3 s energies (LRA)
    this.maxMomentary = -Infinity;
    this.maxShort = -Infinity;
    this.truePeak = 0;
    this._cacheN = -1;
  }
  push(energy, tpLinear = 0) {
    this.sub.push(Math.max(0, energy || 0));
    if (this.sub.length > 30) this.sub.shift();
    if (tpLinear > this.truePeak) this.truePeak = tpLinear;
    const n = this.sub.length;
    if (n >= 4) {
      const m = (this.sub[n - 1] + this.sub[n - 2] + this.sub[n - 3] + this.sub[n - 4]) / 4;
      this.blocks.push(m);
      this.maxMomentary = Math.max(this.maxMomentary, loudnessOf(m));
    }
    if (n >= 30) {
      const s = this.sub.reduce((a, b) => a + b, 0) / 30;
      this.short.push(s);
      this.maxShort = Math.max(this.maxShort, loudnessOf(s));
    }
  }
  get momentary() {
    const n = this.sub.length;
    if (n < 1) return -Infinity;
    const k = Math.min(4, n);
    let s = 0;
    for (let i = n - k; i < n; i++) s += this.sub[i];
    return loudnessOf(s / k);
  }
  get shortTerm() {
    const n = this.sub.length;
    if (n < 1) return -Infinity;
    return loudnessOf(this.sub.reduce((a, b) => a + b, 0) / n);
  }
  get integrated() { return integratedOf(this.blocks); }
  get lra() { return lraOf(this.short); }
  get truePeakDb() { return this.truePeak > 0 ? 20 * Math.log10(this.truePeak) : -Infinity; }
}

// ------------------------------------------------------------------------------------------------ stereo analysis
/** Phase correlation (−1 … +1) of two equal-length blocks; 0 for silence. */
export function correlation(l, r) {
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < l.length; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
  const d = Math.sqrt(ll * rr);
  return d > 1e-12 ? lr / d : 0;
}

// ------------------------------------------------------------------------------------------------ normalisation
/**
 * Delivery targets: integrated LUFS, true-peak ceiling dBTP, tolerance (± LU) and how the platform plays a file that
 * misses the target (`normalize`: 'both' = turned up or down, 'down' = only turned down, null = played as is;
 * kind 'broadcast' = a hard spec, not playback normalisation). See dsp/loudness-stats.js checkTarget().
 */
export const LOUDNESS_PRESETS = [
  { id: 'spotify', label: 'Spotify (−14 LUFS)', lufs: -14, ceiling: -1, tol: 1, kind: 'stream', normalize: 'both' },
  { id: 'apple', label: 'Apple Music (−16 LUFS)', lufs: -16, ceiling: -1, tol: 1, kind: 'stream', normalize: 'both' },
  { id: 'youtube', label: 'YouTube (−14 LUFS)', lufs: -14, ceiling: -1, tol: 1, kind: 'stream', normalize: 'down' },
  { id: 'tidal', label: 'Tidal (−14 LUFS)', lufs: -14, ceiling: -1, tol: 1, kind: 'stream', normalize: 'down' },
  { id: 'amazon', label: 'Amazon Music (−14 LUFS)', lufs: -14, ceiling: -2, tol: 1, kind: 'stream', normalize: 'both' },
  { id: 'deezer', label: 'Deezer (−15 LUFS)', lufs: -15, ceiling: -1, tol: 1, kind: 'stream', normalize: 'down' },
  { id: 'soundcloud', label: 'SoundCloud (−14 LUFS)', lufs: -14, ceiling: -1, tol: 1, kind: 'stream', normalize: null },
  { id: 'podcast', label: 'Podcast (−16 LUFS)', lufs: -16, ceiling: -1, tol: 1, kind: 'stream', normalize: null },
  { id: 'ebu', label: 'Broadcast EBU R128 (−23 LUFS)', lufs: -23, ceiling: -1, tol: 0.5, kind: 'broadcast', normalize: null },
  { id: 'atsc', label: 'Broadcast ATSC A/85 (−24 LKFS)', lufs: -24, ceiling: -2, tol: 2, kind: 'broadcast', normalize: null },
  { id: 'cd', label: 'CD / loud master (−9 LUFS)', lufs: -9, ceiling: -0.3, tol: 1.5, kind: 'master', normalize: null },
  { id: 'club', label: 'Club (−7 LUFS)', lufs: -7, ceiling: -0.3, tol: 1, kind: 'master', normalize: null },
  { id: 'club-loud', label: 'Club loud (−6 LUFS)', lufs: -6, ceiling: -0.1, tol: 1, kind: 'master', normalize: null },
  { id: 'club-soft', label: 'Club open (−8 LUFS)', lufs: -8, ceiling: -0.5, tol: 1, kind: 'master', normalize: null },
];

/** Linear gain that moves `measured` (LUFS) to `target`. */
export const gainToTarget = (measured, target) => (Number.isFinite(measured) ? Math.pow(10, (target - measured) / 20) : 1);

/**
 * Normalise a finished render (pure; returns new channels).
 *   mode 'off'  : unchanged (still true-peak limited when `ceiling` is given and exceeded)
 *   mode 'peak' : true peak to `target` dBTP
 *   mode 'lufs' : integrated loudness to `target` LUFS, then the true-peak limiter at `ceiling` dBTP; the gain is
 *                 refined (≤ 4 passes) so the limited result still lands on the target (±0.1 LU when reachable).
 * -> { channels, gainDb, before: measurement, after: measurement, limitedDb }
 */
export function normalizeLoudness(channels, sampleRate, { mode = 'off', target = -14, ceiling = null } = {}) {
  const before = measureLoudness(channels, sampleRate);
  const scale = (g) => channels.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; });
  const limit = (chs) => {
    if (ceiling == null || !Number.isFinite(ceiling)) return { channels: chs, gainReductionDb: 0 };
    return limitTruePeak(chs, sampleRate, { ceilingDb: ceiling });
  };
  let g = 1;
  if (mode === 'peak') {
    g = Number.isFinite(before.truePeakDb) ? Math.pow(10, (target - before.truePeakDb) / 20) : 1;
    const out = scale(g);
    const lim = limit(out);
    return { channels: lim.channels, gainDb: 20 * Math.log10(g), before, after: measureLoudness(lim.channels, sampleRate), limitedDb: lim.gainReductionDb || 0 };
  }
  if (mode !== 'lufs' || !Number.isFinite(before.integrated)) {
    const lim = limit(channels.map((c) => Float32Array.from(c)));
    return { channels: lim.channels, gainDb: 0, before, after: measureLoudness(lim.channels, sampleRate), limitedDb: lim.gainReductionDb || 0 };
  }
  g = gainToTarget(before.integrated, target);
  let best = null;
  for (let pass = 0; pass < 4; pass++) {
    const lim = limit(scale(g));
    const after = measureLoudness(lim.channels, sampleRate);
    best = { channels: lim.channels, gainDb: 20 * Math.log10(g), before, after, limitedDb: lim.gainReductionDb || 0 };
    const err = target - after.integrated;
    if (!Number.isFinite(err) || Math.abs(err) <= 0.05) break;
    g *= Math.pow(10, err / 20);
    if (20 * Math.log10(g) > 40) break; // can't get there sensibly
  }
  return best;
}
