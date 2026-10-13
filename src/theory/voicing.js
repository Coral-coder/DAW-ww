// Chord-scales (what is consonant over a chord in a key) and constraint-based chord voicing.
// Pure, deterministic. Used by the generators and every UI path that writes chords.
import { mod12 } from './notes.js';
import { scalePitchClasses, resolveScaleId, heptatonicParent } from './scales.js';
import { getChordType, chordPitchClasses } from './chords.js';

const sortNum = (a) => a.slice().sort((x, y) => x - y);
const DOMINANT_TYPES = new Set(['7', '9', '11', '13', '7b9', '7#9', '7#11', '7b5', 'aug7', '7sus4', '9sus4']);

export const isDominantType = (type) => DOMINANT_TYPES.has(type);

/** Pitch classes a melody may draw from in a key (the chromatic "scale" falls back to its parent). */
export function keyPitchClasses(keyRoot, scaleId) {
  const id = resolveScaleId(scaleId);
  return scalePitchClasses(keyRoot, id === 'chromatic' ? heptatonicParent(id) : id);
}

/**
 * Chord-scale of a chord in a key: the notes that sound right over it right now.
 *  tones    – chord tones (incl. the chord's own extensions and a slash bass)
 *  tensions – key notes that colour the chord without clashing (9, 11 on minor, #11, 13, ...)
 *  avoid    – key notes a half step above a chord tone (b9 against it: the 4th over a major 3rd, b6 over a 5th,
 *             b9 over the root) and the minor 3rd over a major chord; fine only as short passing tones
 *  pool     – tones + tensions + avoid, sorted (key notes that contradict an altered chord tone are removed:
 *             over a chord with E#, the key's E is gone)
 * opts.blues: keep the b3 over major chords as a "blue" tension.
 * -> {root, tones, tensions, avoid, pool}
 */
export function chordScale(chord, keyRoot = 0, scaleId = 'major', opts = {}) {
  const root = mod12(chord.root);
  const tones = chordPitchClasses(root, chord.type);
  if (chord.bass != null && !tones.includes(mod12(chord.bass))) tones.push(mod12(chord.bass));
  const key = keyPitchClasses(keyRoot, scaleId);
  const nonKey = tones.filter((t) => !key.includes(t));
  // the blue note (b3 against a major 3rd) survives in blues; any other key note next to an altered chord tone goes
  const blueNote = (p) => opts.blues && mod12(p - root) === 3;
  const conflicts = (p) => !blueNote(p) && nonKey.some((t) => mod12(p - t) === 1 || mod12(t - p) === 1);
  const set = new Set(tones);
  for (const p of key) if (!conflicts(p)) set.add(p);
  const iv = new Set(getChordType(chord.type).intervals.map(mod12));
  const major3 = iv.has(4);
  const avoid = [];
  const tensions = [];
  for (const p of set) {
    if (tones.includes(p)) continue;
    const rel = mod12(p - root);
    const halfAbove = tones.some((t) => mod12(p - t) === 1);
    if (major3 && rel === 3) (opts.blues ? tensions : avoid).push(p);
    else if (halfAbove) avoid.push(p);
    else tensions.push(p);
  }
  const pool = sortNum([...set].map((p) => mod12(p - root))).map((r) => mod12(r + root));
  return { root, tones, tensions, avoid, pool };
}

/**
 * Move a MIDI note to the nearest pitch that fits the chord-scale.
 * opts.allow: 'tones' (chord tones only) | 'tensions' (tones + tensions, default) | 'pool' (incl. avoid notes)
 * opts.dir: preferred direction on ties (1 up, -1 down). opts.range [lo, hi] keeps the result inside.
 */
export function fitToChord(midi, cs, opts = {}) {
  const allow = opts.allow || 'tensions';
  const ok = new Set(allow === 'tones' ? cs.tones : allow === 'pool' ? cs.pool : [...cs.tones, ...cs.tensions]);
  const m = Math.round(midi);
  const [lo, hi] = opts.range || [-Infinity, Infinity];
  const inRange = (x) => x >= lo && x <= hi;
  if (ok.has(mod12(m)) && inRange(m)) return m;
  const dir = opts.dir || 0;
  for (let d = 1; d <= 12; d++) {
    const order = dir > 0 ? [m + d, m - d] : [m - d, m + d];
    for (const x of order) if (ok.has(mod12(x)) && inRange(x)) return x;
  }
  return m;
}

/** Is this pitch class acceptable over the chord? kind: 'tone' | 'tension' | 'avoid' | 'out' */
export function chordScaleRole(pc, cs) {
  const p = mod12(pc);
  if (cs.tones.includes(p)) return 'tone';
  if (cs.tensions.includes(p)) return 'tension';
  if (cs.avoid.includes(p)) return 'avoid';
  return 'out';
}

/**
 * Pitch classes to voice for a chord, at most `max`: drop the (perfect) 5th first, then a clashing 11th,
 * then the root (rootless, only when opts.rootless — a bass plays it), then the 13th, then the 9th.
 * The 3rd and 7th (the chord's identity) always stay. Ordered root-first.
 */
export function chordVoicingPcs(chord, max = 5, opts = {}) {
  const root = mod12(chord.root);
  const t = getChordType(chord.type);
  let ivs = [...new Set(t.intervals.map(mod12))];
  const has = (i) => ivs.includes(i);
  const drop = (i) => { if (ivs.length > max && has(i)) ivs = ivs.filter((x) => x !== i); };
  if (ivs.length > max && (has(3) || has(4) || has(5) || has(2)) && ivs.length > 2) drop(7);
  if (has(4)) drop(5); // natural 11 over a major 3rd
  if (opts.rootless && ivs.length > max && ivs.length > 3) drop(0);
  drop(9); // 13th
  drop(2); // 9th
  drop(5);
  drop(7);
  ivs = ivs.slice(0, Math.max(1, max));
  return ivs.map((i) => mod12(root + i));
}

// ---------------------------------------------------------------------------
// Voicing search
// ---------------------------------------------------------------------------

/** Low-interval limits: why a stack of notes would sound muddy / clashing, or null if fine. */
export function voicingProblem(notes, opts = {}) {
  const v = sortNum(notes);
  const semi = opts.semitoneFloor ?? 60; // no minor 2nds below C4
  const whole = opts.wholeFloor ?? 55; // no major 2nds below G3
  const third = opts.thirdFloor ?? 53; // no 3rds below F3
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1], d = v[i] - a;
    if (d === 0) return 'unison';
    if (d === 1 && a < semi) return 'semitone';
    if (d === 2 && a < whole) return 'whole tone';
    if (d <= 4 && a < third) return 'third';
  }
  // minor 9ths between any two voices (e.g. a major 7th voiced under the root) — unless it is the chord's b9
  if (!opts.allowMinor9) {
    for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if ((v[j] - v[i]) % 12 === 1 && v[j] - v[i] > 1) return 'minor 9th';
  }
  return null;
}

/** Permutations of a small array (deduplicated). */
function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  const seen = new Set();
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) {
      const p = [x, ...rest];
      const k = p.join(',');
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
  });
  return out;
}

function movementCost(v, prev) {
  if (!prev.length) return 0;
  const p = sortNum(prev);
  let cost = 0;
  if (p.length === v.length) for (let i = 0; i < v.length; i++) cost += Math.abs(v[i] - p[i]);
  else {
    for (const n of v) cost += Math.min(...p.map((q) => Math.abs(q - n)));
    for (const q of p) cost += 0.5 * Math.min(...v.map((n) => Math.abs(q - n)));
  }
  // common tones held in place sound smoothest
  for (const n of v) if (p.includes(n)) cost -= 0.6;
  // keep the top voice (the line people hear) smooth
  cost += Math.abs(v[v.length - 1] - p[p.length - 1]) * 0.5;
  return cost;
}

/**
 * Best voicing of pitch classes `pcs` (root = opts.root ?? pcs[0]).
 * opts: {prev: MIDI[], range: [lo, hi], voices (doubles the root when > pcs), center, allowMinor9, chordType}
 */
export function voicePitchClasses(pcs, opts = {}) {
  const uniq = [...new Set(pcs.map(mod12))].slice(0, 6);
  if (!uniq.length) return [];
  const [lo, hi] = opts.range || [52, 76];
  const prev = (opts.prev || []).filter(Number.isFinite);
  const root = mod12(opts.root ?? uniq[0]);
  const voices = Math.max(uniq.length, Math.min(opts.voices || uniq.length, 6));
  const base = uniq.slice();
  while (base.length < voices) base.push(base[(base.length - uniq.length) % uniq.length]);
  const center = opts.center ?? (prev.length ? prev.reduce((s, n) => s + n, 0) / prev.length : (lo + hi) / 2);
  const t = opts.chordType ? getChordType(opts.chordType) : null;
  const relOf = (n) => mod12(n - root);
  let best = null;
  let bestCost = Infinity;
  let fallback = null;
  let fallbackCost = Infinity;
  for (const order of permutations(base)) {
    for (let start = lo - 12 + mod12(order[0] - (lo - 12)); start <= hi; start += 12) {
      const v = [start];
      for (let k = 1; k < order.length; k++) {
        let n = v[k - 1] + 1 + mod12(order[k] - (v[k - 1] + 1));
        if (n === v[k - 1]) n += 12;
        v.push(n);
      }
      let cost = 0;
      for (const n of v) {
        if (n < lo) cost += (lo - n) * 4;
        if (n > hi) cost += (n - hi) * 4;
      }
      cost += prev.length ? movementCost(v, prev) : Math.abs(v.reduce((s, n) => s + n, 0) / v.length - center) * 0.8;
      const span = v[v.length - 1] - v[0];
      if (span > 19) cost += (span - 19) * 1.5;
      // what sits at the bottom: root/3rd/5th are stable, a 7th / 9th less so, a major 7th or b9 rubs
      const bottom = relOf(v[0]);
      if (bottom === 11 || bottom === 1) cost += 4;
      else if (bottom === 2 || bottom === 10) cost += 1.2;
      // mild preference against close minor 2nds even up high
      for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] === 1) cost += 1.5;
      const allowMinor9 = opts.allowMinor9 ?? (t ? t.intervals.includes(13) : false);
      const problem = voicingProblem(v, { allowMinor9 });
      if (problem) {
        if (cost + 50 < fallbackCost) { fallbackCost = cost + 50; fallback = v; }
        continue;
      }
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
  }
  return best || fallback || [];
}

/**
 * A clean voicing for a chord object {root, type}: chord-quality-consistent tones (chordVoicingPcs), low-interval
 * limits respected, voice-led from opts.prev with held common tones.
 * opts: {prev, range=[52,76], maxVoices=5, rootless=false, center}
 */
export function voiceChord(chord, opts = {}) {
  if (!chord) return [];
  const type = chord.type || 'maj';
  if (type === '5') {
    // power chord: root-5th-octave, low and tight is the idiom
    const [lo] = opts.range || [40, 64];
    const r = lo + mod12(chord.root - lo);
    return [r, r + 7, r + 12];
  }
  const max = Math.max(2, Math.min(opts.maxVoices ?? 5, 6));
  const pcs = chordVoicingPcs(chord, max, { rootless: opts.rootless });
  return voicePitchClasses(pcs, { ...opts, root: chord.root, chordType: type, voices: Math.min(max, Math.max(pcs.length, opts.voices || 0)) });
}

/**
 * Repair an arbitrary stacked voicing (e.g. a chord stamped low on the piano roll): lift notes that break the
 * low-interval limits an octave at a time and trim to `max` notes (dropping 5ths / doubled notes first).
 */
export function cleanVoicing(notes, opts = {}) {
  let v = [...new Set(notes.map(Math.round))].sort((a, b) => a - b);
  const max = opts.max ?? 6;
  while (v.length > max) {
    const counts = {};
    for (const n of v) counts[mod12(n)] = (counts[mod12(n)] || 0) + 1;
    const dup = v.findIndex((n, i) => i > 0 && counts[mod12(n)] > 1);
    v.splice(dup > 0 ? dup : v.length - 1, 1);
  }
  for (let guard = 0; guard < 24; guard++) {
    const bad = voicingProblem(v, { allowMinor9: true });
    if (!bad) break;
    // lift the upper note of the lowest offending pair
    let idx = -1;
    for (let i = 1; i < v.length && idx < 0; i++) if (voicingProblem([v[i - 1], v[i]], { allowMinor9: true })) idx = i;
    if (idx < 0) break;
    const n = v.splice(idx, 1)[0];
    let up = n + 12;
    while (v.includes(up)) up += 12;
    v.push(up);
    v = [...new Set(v)].sort((a, b) => a - b);
  }
  return v;
}

/**
 * Voice-lead from a previous voicing to the next chord's pitch classes (root first, by convention).
 * prevNotes: MIDI[] (may be empty), nextPcs: pitch classes, range [lo, hi].
 * Returns MIDI[] with the smoothest motion that respects the low-interval limits, kept inside range.
 * opts.voices forces a voice count (doubling the root); more than 5 pitch classes drop the 5th.
 */
export function voiceLead(prevNotes = [], nextPcs = [], range = [52, 76], opts = {}) {
  let pcs = [...new Set(nextPcs.map(mod12))];
  if (!pcs.length) return [];
  const root = pcs[0];
  if (pcs.length > 5) pcs = pcs.filter((p) => p !== mod12(root + 7));
  const prev = (prevNotes || []).filter(Number.isFinite);
  const voices = opts.voices || Math.max(pcs.length, Math.min(prev.length || pcs.length, pcs.length + 1, 5));
  return voicePitchClasses(pcs, { prev, range, voices, root, center: opts.center });
}
