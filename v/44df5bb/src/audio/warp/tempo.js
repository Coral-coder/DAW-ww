// Ported from origin/mac-app src/audio/analysis/ (shared analysis code).
// Tempo + beat grid detection on an onset envelope.
//  1. autocorrelation of the (mean-removed) envelope
//  2. harmonic-sum tempogram over [minBpm, maxBpm] with a mild log-normal tempo prior
//  3. octave check: if the off-beats (half-way between candidate beats) are nearly as strong as the
//     beats, the real pulse is twice as fast (fixes "87 instead of 174" on DnB / plain click tracks)
//  4. fine search ±1.5 BPM (0.02 steps) maximising a comb-filter score over the whole track, which
//     also yields the beat phase
//  5. downbeat: which of the 4 beat phases carries the most bass-band onset energy
// Half/double-time ambiguity is inherent (a 174 track *is* also an 87 track); `alternatives`
// lists both so the UI can offer ×2 / ÷2.
import { lerpAt, mean } from './dsp.js';
import { smooth } from './onset.js';

export function autocorrelate(env, maxLag) {
  const m = mean(env);
  const x = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) x[i] = env[i] - m;
  const out = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0, n = x.length - lag; i < n; i++) s += x[i] * x[i + lag];
    out[lag] = s / Math.max(1, x.length - lag);
  }
  const z = out[0] || 1;
  for (let i = 0; i <= maxLag; i++) out[i] /= z;
  return out;
}

/** Comb score: best phase and mean envelope value on a beat grid of `period` frames. */
export function combScore(env, period, { phaseStep = 0.5 } = {}) {
  let best = -Infinity, bestPhase = 0;
  for (let ph = 0; ph < period; ph += phaseStep) {
    let s = 0, c = 0;
    for (let p = ph; p < env.length - 1; p += period) { s += lerpAt(env, p); c++; }
    const v = c ? s / c : 0;
    if (v > best) { best = v; bestPhase = ph; }
  }
  return { score: best, phase: bestPhase };
}

function phaseMean(env, period, phase) {
  let s = 0, c = 0;
  for (let p = phase; p < env.length - 1; p += period) { s += lerpAt(env, p); c++; }
  return c ? s / c : 0;
}

/**
 * @param {{env:Float32Array, low?:Float32Array, fps:number}} onset from onsetEnvelope()
 * @returns {{ bpm:number, confidence:number, firstBeat:number, downbeat:number, alternatives:number[] }}
 *   firstBeat = time (s) of the earliest beat; downbeat = time (s) of the earliest bar start.
 */
export function detectTempo(onset, { minBpm = 70, maxBpm = 180, beatsPerBar = 4 } = {}) {
  const { fps } = onset;
  const env = smooth(onset.env, 1);
  if (env.length < fps * 2) return { bpm: 120, confidence: 0, firstBeat: 0, downbeat: 0, alternatives: [] };
  const maxLag = Math.min(env.length - 2, Math.ceil((fps * 60 * 4) / minBpm));
  const acf = autocorrelate(env, maxLag);
  const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 125) / 1.4) ** 2);
  let bestT = minBpm, bestS = -Infinity;
  const scores = [];
  for (let T = minBpm; T <= maxBpm + 1e-9; T += 0.25) {
    const P = (fps * 60) / T;
    let s = 0;
    for (let k = 1; k <= 4; k++) if (k * P <= maxLag) s += lerpAt(acf, k * P) / k;
    s *= prior(T);
    scores.push([T, s]);
    if (s > bestS) { bestS = s; bestT = T; }
  }
  // octave check (only upward: harmonic sum already prefers the fastest consistent pulse downward)
  let T0 = bestT;
  for (let guard = 0; guard < 2 && T0 * 2 <= maxBpm + 1; guard++) {
    const P = (fps * 60) / T0;
    const { phase } = combScore(env, P);
    const on = phaseMean(env, P, phase);
    const off = phaseMean(env, P, (phase + P / 2) % P);
    const base = mean(env);
    if (on - base > 0 && (off - base) / (on - base) >= 0.7) T0 *= 2; else break;
  }
  // fine search
  let fineT = T0, fine = { score: -Infinity, phase: 0 };
  for (let T = Math.max(minBpm * 0.9, T0 - 1.5); T <= T0 + 1.5; T += 0.02) {
    const r = combScore(env, (fps * 60) / T);
    if (r.score > fine.score) { fine = r; fineT = T; }
  }
  const bpm = Math.round(fineT * 100) / 100;
  const P = (fps * 60) / bpm;
  // refine phase finely
  let phase = fine.phase, pBest = -Infinity;
  for (let ph = fine.phase - 1; ph <= fine.phase + 1; ph += 0.1) {
    const v = phaseMean(env, P, ((ph % P) + P) % P);
    if (v > pBest) { pBest = v; phase = ((ph % P) + P) % P; }
  }
  // downbeat: bass-band (else full) energy per beat-in-bar phase
  const src = onset.low && onset.low.length === env.length ? smooth(onset.low, 1) : env;
  let dbIdx = 0, dbBest = -Infinity;
  for (let m = 0; m < beatsPerBar; m++) {
    const v = phaseMean(src, P * beatsPerBar, phase + m * P) + 0.25 * phaseMean(env, P * beatsPerBar, phase + m * P);
    if (v > dbBest) { dbBest = v; dbIdx = m; }
  }
  const firstBeat = phase / fps;
  const downbeat = (phase + dbIdx * P) / fps;
  const sorted = scores.slice().sort((a, b) => b[1] - a[1]);
  const confidence = sorted.length > 1 && sorted[0][1] > 0 ? Math.max(0, Math.min(1, 1 - (sorted.find(([t]) => Math.abs(t - bestT) > 3)?.[1] ?? 0) / sorted[0][1])) : 0;
  const alternatives = [bpm / 2, bpm * 2].filter((t) => t >= 50 && t <= 220).map((t) => Math.round(t * 100) / 100);
  return { bpm, confidence, firstBeat, downbeat, alternatives };
}

// ---------------------------------------------------------------- beat grid helpers

/** Beat grid { bpm, anchor (s, a bar start), beatsPerBar }. Beat i is at anchor + i*60/bpm (i may be negative). */
export function makeGrid(bpm, downbeat, beatsPerBar = 4) {
  const spb = 60 / bpm;
  let anchor = downbeat;
  const bar = spb * beatsPerBar;
  while (anchor - bar >= -1e-9) anchor -= bar; // earliest bar start >= 0
  return { bpm, anchor: Math.max(0, anchor), beatsPerBar };
}

export const secondsPerBeat = (grid) => 60 / grid.bpm;
export const beatTime = (grid, i) => grid.anchor + i * secondsPerBeat(grid);
export const beatIndexAt = (grid, t) => (t - grid.anchor) / secondsPerBeat(grid);
export const barTime = (grid, b) => beatTime(grid, b * grid.beatsPerBar);

/** Multiply / divide the grid tempo (×2 / ÷2 fix) keeping the anchor. */
export function scaleGrid(grid, factor) { return { ...grid, bpm: grid.bpm * factor }; }
