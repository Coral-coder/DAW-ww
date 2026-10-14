// Musical key detection: chromagram (FFT, ~11 kHz) + Krumhansl–Kessler key profiles, and the
// Camelot wheel helpers DJs use for harmonic mixing.
import { downsample, hann, toMono } from './dsp.js';
import { fft } from '../dsp/fft.js';

export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Chroma frames (12-bin, L1-normalised) of a signal.
 * @returns {{ frames: Float32Array[], energy: Float32Array, fps: number }}
 */
export function chromagram(signal, sr, { targetSr = 11025, size = 4096, hopSize = 2048, fMin = 60, fMax = 2400 } = {}) {
  const mono = Array.isArray(signal) ? toMono(signal) : signal;
  const { x, sr: rate } = downsample(mono, sr, targetSr);
  const win = hann(size);
  const re = new Float32Array(size), im = new Float32Array(size);
  // bin -> (pitch class, weight) map
  const map = [];
  for (let k = 1; k < size / 2; k++) {
    const f = (k * rate) / size;
    if (f < fMin || f > fMax) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const near = Math.round(midi);
    const d = Math.abs(midi - near);
    if (d > 0.4) continue;
    map.push([k, ((near % 12) + 12) % 12, 1 - d * 2]);
  }
  const frames = [];
  const energies = [];
  for (let start = 0; start + size <= x.length; start += hopSize) {
    let e = 0;
    for (let i = 0; i < size; i++) { const v = x[start + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    fft(re, im);
    const c = new Float32Array(12);
    let sum = 0;
    for (const [k, pc, w] of map) { const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]); c[pc] += w * mag; }
    for (let i = 0; i < 12; i++) sum += c[i];
    if (sum > 0) for (let i = 0; i < 12; i++) c[i] /= sum;
    frames.push(c);
    energies.push(Math.sqrt(e / size));
  }
  return { frames, energy: Float32Array.from(energies), fps: rate / hopSize };
}

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Key from a 12-bin chroma vector -> { tonic, mode, name, camelot, confidence, scores } */
export function keyFromChroma(chroma) {
  const scores = [];
  for (let t = 0; t < 12; t++) {
    const rot = (prof) => Array.from({ length: 12 }, (_, i) => prof[(i - t + 12) % 12]);
    scores.push({ tonic: t, mode: 'major', r: pearson(chroma, rot(KK_MAJOR)) });
    scores.push({ tonic: t, mode: 'minor', r: pearson(chroma, rot(KK_MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  return { tonic: best.tonic, mode: best.mode, name: keyName(best), camelot: camelotOf(best), confidence: Math.max(0, best.r - scores[1].r), scores };
}

/** Detect the key of a whole signal (energy-weighted mean chroma; quiet frames ignored). */
export function detectKey(signal, sr, chroma = null) {
  const cg = chroma || chromagram(signal, sr);
  const acc = new Float32Array(12);
  let maxE = 0; for (const e of cg.energy) maxE = Math.max(maxE, e);
  cg.frames.forEach((c, i) => { const w = cg.energy[i] > maxE * 0.05 ? cg.energy[i] : 0; for (let k = 0; k < 12; k++) acc[k] += c[k] * w; });
  return { ...keyFromChroma(acc), chroma: Array.from(acc) };
}

export const keyName = ({ tonic, mode }) => `${PITCH_NAMES[((tonic % 12) + 12) % 12]} ${mode === 'minor' ? 'minor' : 'major'}`;

// ---------------------------------------------------------------- Camelot wheel
/** { tonic, mode } -> '8A' style code (A = minor, B = major). */
export function camelotOf({ tonic, mode }) {
  const t = ((Math.round(tonic) % 12) + 12) % 12;
  const majorPc = mode === 'minor' ? (t + 3) % 12 : t;
  const num = (((majorPc * 7) % 12) + 7) % 12 + 1;
  return `${num}${mode === 'minor' ? 'A' : 'B'}`;
}

/** '8A' -> { num:8, letter:'A', tonic, mode } (null if invalid). */
export function parseCamelot(code) {
  const m = /^(\d{1,2})([ABab])$/.exec(String(code || '').trim());
  if (!m) return null;
  const num = +m[1];
  if (num < 1 || num > 12) return null;
  const letter = m[2].toUpperCase();
  const majorPc = (((num - 8) * 7) % 12 + 12) % 12; // inverse of the circle-of-fifths walk
  return { num, letter, mode: letter === 'A' ? 'minor' : 'major', tonic: letter === 'A' ? (majorPc + 9) % 12 : majorPc };
}

/**
 * Harmonic-mixing relation between two Camelot codes (or {tonic,mode} keys):
 * 'same' | 'adjacent' (±1, same letter) | 'relative' (same number, A<->B) | 'energy' (+2 same letter / "energy boost") | null
 */
export function camelotRelation(a, b) {
  const pa = typeof a === 'string' ? parseCamelot(a) : a && parseCamelot(camelotOf(a));
  const pb = typeof b === 'string' ? parseCamelot(b) : b && parseCamelot(camelotOf(b));
  if (!pa || !pb) return null;
  const d = (((pb.num - pa.num) % 12) + 12) % 12;
  if (pa.letter === pb.letter) {
    if (d === 0) return 'same';
    if (d === 1 || d === 11) return 'adjacent';
    if (d === 2) return 'energy';
    return null;
  }
  return d === 0 ? 'relative' : null;
}

/** True for the classic compatible moves: same key, ±1 on the wheel, relative major/minor. */
export function camelotCompatible(a, b) {
  const r = camelotRelation(a, b);
  return r === 'same' || r === 'adjacent' || r === 'relative';
}

/**
 * Smallest pitch shift (semitones, |s| <= maxShift) that makes `key` mix harmonically with `target`.
 * Prefers 0, then an exact key match at the same distance, then the smaller upward shift.
 */
export function keyShiftToward(key, target, maxShift = 6) {
  let best = null;
  for (let a = 0; a <= maxShift; a++) {
    for (const s of a === 0 ? [0] : [a, -a]) {
      const shifted = { tonic: (key.tonic + s + 120) % 12, mode: key.mode };
      const rel = camelotRelation(shifted, target);
      if (rel === 'same' || rel === 'adjacent' || rel === 'relative') {
        const rank = rel === 'same' ? 0 : 1;
        if (!best || rank < best.rank) best = { semitones: s, relation: rel, rank };
      }
    }
    if (best) return { semitones: best.semitones, relation: best.relation };
  }
  return { semitones: 0, relation: null };
}
