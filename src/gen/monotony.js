// Anti-monotony: measure how repetitive a generated part is (distinct pitches per window, the longest verbatim
// repetition of a short cell, n-gram entropy) and, when a part is too static for its role / genre, develop it the
// way an arranger would — re-voice repeated chords along inversions, displace arp notes by an octave, answer a
// pulsing bass with octaves / 5ths. Pure and deterministic (takes `rng`).
//
//   partStats(notes, {bpb, length, role})            -> {bars, distinct16, distinct8, cellRunBars, entropy, notes}
//   monotonyLimits(role, genre)                       -> {distinct16, cellRunBars, entropy} (thresholds)
//   isMonotonous(stats, role, genre)                  -> string[] (the reasons; empty = fine)
//   varyPart(notes, {role, genre, progression, bpb, length, rng}) -> notes (developed in place when needed)
//   monotonyReport(project)                           -> {chordRoots, rootCount, parts:[…], byRole:{…}}
import { createRng } from '../core/util.js';
import { mod12, chordPitchClasses } from '../theory/index.js';
import { invertVoicing } from './harmony.js';
import { detectPatternChords } from './analyze.js';

const EPS = 1e-6;

/**
 * Genres whose bass is a pedal by idiom (still: octave / rhythm variation, ≥ 2 pitches per 16 bars): ambient / cinematic
 * drones sustain one root under slow chords; metal chugs the riff's root under power chords. Psytrance / techno are
 * NOT exempt — their rolling basses answer with octaves, 5ths and 7ths.
 */
export const DRONE_BASS_GENRES = new Set(['ambient', 'cinematic', 'metal']);

/** Onset groups (block chords become one token): [{start, end, pitches, key}]. Strums / humanized hits stay together. */
export function partTokens(notes, tol = 0.04) {
  const sorted = (notes || []).filter((n) => n.dur > 0).slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && n.start - g.start < tol) { g.pitches.push(n.pitch); g.end = Math.max(g.end, n.start + n.dur); }
    else groups.push({ start: n.start, end: n.start + n.dur, pitches: [n.pitch] });
  }
  for (const g of groups) g.key = [...new Set(g.pitches)].sort((a, b) => a - b).join('.');
  return groups;
}

/** Minimum number of distinct pitches over consecutive `bars`-bar windows (a short tail merges into the window before). */
export function distinctPerWindow(notes, { bpb = 4, length, bars = 16 } = {}) {
  const len = length ?? (notes || []).reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const W = bars * bpb;
  const nw = Math.max(1, Math.ceil(len / W - 0.5 + EPS));
  let min = Infinity;
  for (let w = 0; w < nw; w++) {
    const a = w * W, b = w === nw - 1 ? Infinity : (w + 1) * W;
    const set = new Set(notes.filter((n) => n.start >= a - EPS && n.start < b - EPS).map((n) => n.pitch));
    if (set.size) min = Math.min(min, set.size);
  }
  return min === Infinity ? 0 : min;
}

/** Longest span (in bars) over which a cell of ≤ maxCell tokens repeats verbatim (at least twice). */
export function longestCellRun(groups, { bpb = 4, maxCell = 3 } = {}) {
  let best = 0;
  for (let p = 1; p <= maxCell; p++) {
    let runStart = -1;
    for (let i = p; i <= groups.length; i++) {
      const same = i < groups.length && groups[i].key === groups[i - p].key;
      if (same && runStart < 0) runStart = i - p;
      if (!same && runStart >= 0) {
        const last = i - 1;
        if (last - runStart + 1 >= 2 * p) best = Math.max(best, (groups[last].end - groups[runStart].start) / bpb);
        runStart = -1;
      }
    }
  }
  return best;
}

/** Shannon entropy (bits) of the token n-grams. */
export function ngramEntropy(groups, n = 2) {
  if (groups.length < n) return 0;
  const counts = new Map();
  for (let i = 0; i + n <= groups.length; i++) {
    const k = groups.slice(i, i + n).map((g) => g.key).join('|');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const total = groups.length - n + 1;
  let h = 0;
  for (const c of counts.values()) { const p = c / total; h -= p * Math.log2(p); }
  return h;
}

/** Monotony statistics of one part. */
export function partStats(notes, { bpb = 4, length, role } = {}) {
  const ns = (notes || []).filter((n) => n.dur > 0);
  const len = length ?? ns.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const groups = partTokens(ns, role === 'chords' || role === 'pad' ? 0.1 : 0.04);
  return {
    notes: ns.length,
    bars: len / bpb,
    distinct16: distinctPerWindow(ns, { bpb, length: len, bars: 16 }),
    distinct8: distinctPerWindow(ns, { bpb, length: len, bars: 8 }),
    cellRunBars: longestCellRun(groups, { bpb, maxCell: 3 }),
    entropy: ngramEntropy(groups, 2),
  };
}

/** Thresholds per role (and drone-bass genres). */
export function monotonyLimits(role, genre) {
  const id = typeof genre === 'string' ? genre : genre?.id;
  switch (role) {
    case 'chords': case 'pad': return { distinct16: 4, cellRunBars: 4 };
    case 'arp': return { distinct16: 4, cellRunBars: 4, entropy: 2.5 };
    case 'lead': return { entropy: 1.5 };
    case 'bass': return { distinct16: DRONE_BASS_GENRES.has(id) ? 2 : 3 };
    default: return {};
  }
}

/** Reasons a part is too monotonous for its role (empty = fine). Parts shorter than 2 bars / with < 8 notes are skipped. */
export function isMonotonous(stats, role, genre) {
  const lim = monotonyLimits(role, genre);
  const out = [];
  if (stats.notes < 8 || stats.bars < 2) return out;
  if (lim.distinct16 && stats.distinct16 < lim.distinct16) out.push(`${stats.distinct16} distinct pitches / 16 bars (< ${lim.distinct16})`);
  if (lim.cellRunBars && stats.cellRunBars > lim.cellRunBars + 1e-6) out.push(`a ≤3-note cell repeats for ${stats.cellRunBars.toFixed(1)} bars`);
  if (lim.entropy && stats.notes >= 16 && stats.entropy < lim.entropy) out.push(`bigram entropy ${stats.entropy.toFixed(2)} bits`);
  return out;
}

const chordAtOf = (progression) => (t) => progression?.find((c) => t >= c.startBeat - EPS && t < c.startBeat + c.durBeats - EPS) || progression?.[progression.length - 1];

/**
 * Develop a part that is too monotonous (in place) and return it. Variation techniques by role:
 *  chords / pad — repeated voicings move along an inversion path bar by bar (top-line melody, octave movement);
 *  arp / lead   — octave displacement of alternate half-bars, retrograde of the figure inside a chord in later bars;
 *  bass         — octave / 5th answers on weak notes every other bar (chord tones only).
 * opts: {role, genre, progression, bpb, length, rng, range}
 */
export function varyPart(notes, opts = {}) {
  const { role, genre, progression } = opts;
  const bpb = opts.bpb || 4;
  const length = opts.length ?? notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const rng = opts.rng || createRng(1);
  const stats0 = partStats(notes, { bpb, length, role });
  if (!isMonotonous(stats0, role, genre).length) return notes;
  const chordAt = chordAtOf(progression);
  const bars = Math.ceil(length / bpb - EPS);
  const barOf = (t) => Math.floor(t / bpb + EPS);
  if (role === 'chords' || role === 'pad') {
    const path = [[0, 1, 0, -1], [0, 1, 2, 1], [0, -1, 0, 1]][rng.int(0, 2)];
    const range = opts.range || (role === 'pad' ? [52, 76] : [50, 84]);
    for (const g of partTokens(notes, 0.1)) {
      const k = path[barOf(g.start) % path.length];
      if (!k) continue;
      // only hits that live inside one chord are re-voiced (a tied voice keeps its pitch across the change)
      const c = chordAt(g.start + 0.01);
      const cEnd = c ? c.startBeat + c.durBeats : Infinity;
      const members = notes.filter((n) => n.start >= g.start - EPS && n.start - g.start < 0.1 && g.pitches.includes(n.pitch));
      if (members.some((n) => n.start + n.dur > cEnd + 0.05)) continue;
      const src = [...new Set(members.map((n) => n.pitch))].sort((a, b) => a - b);
      if (src.length < 2) continue;
      const v = invertVoicing(src, k, range) || invertVoicing(src, -k, range);
      if (!v) continue;
      const map = new Map(src.map((p, i) => [p, v[i]]));
      for (const n of members) n.pitch = map.get(n.pitch) ?? n.pitch;
    }
  } else if (role === 'arp' || role === 'lead') {
    const hi = opts.range?.[1] ?? (role === 'arp' ? 98 : 93);
    const lo = opts.range?.[0] ?? 52;
    for (let b = 0; b < bars; b++) {
      const inBar = notes.filter((n) => barOf(n.start) === b).sort((x, y) => x.start - y.start);
      if (b % 4 >= 2) {
        // octave displacement of every other note in the second half of the bar
        inBar.forEach((n, i) => {
          if (n.start - b * bpb < bpb / 2 - EPS || i % 2 === 0) return;
          const up = n.pitch + 12 <= hi ? n.pitch + 12 : n.pitch - 12 >= lo ? n.pitch - 12 : n.pitch;
          n.pitch = up;
        });
      }
      if (b % 8 >= 4 && progression?.length) {
        // retrograde inside each chord segment of the bar (pitch classes stay those of the chord)
        const segs = new Map();
        for (const n of inBar) { const c = chordAt(n.start + 0.01); if (!segs.has(c)) segs.set(c, []); segs.get(c).push(n); }
        for (const seg of segs.values()) {
          const ps = seg.map((n) => n.pitch).reverse();
          seg.forEach((n, i) => { n.pitch = ps[i]; });
        }
      }
    }
  } else if (role === 'bass' && progression?.length) {
    const strong = bpb % 2 === 0 ? [0, bpb / 2] : [0];
    for (let b = 0; b < bars; b++) {
      if (b % 2 === 0) continue;
      const inBar = notes.filter((n) => barOf(n.start) === b).sort((x, y) => x.start - y.start);
      const weak = inBar.filter((n) => !strong.some((s) => Math.abs(n.start - b * bpb - s) < 0.05));
      const pick = weak.length ? weak : inBar.slice(1);
      const n = pick[pick.length - 1];
      if (!n) continue;
      const c = chordAt(n.start + 0.01);
      if (!c?.chord) continue;
      const tones = chordPitchClasses(c.chord.root, c.chord.type);
      const fifth = mod12(c.chord.root + 7);
      const toFifth = (m) => { let p = m.pitch - mod12(m.pitch - fifth); if (p < 28) p += 12; m.pitch = p; };
      if (b % 4 === 3 && tones.includes(fifth)) {
        if (pick.length > 1) toFifth(pick[pick.length - 2]);
        else { toFifth(n); continue; }
      }
      if (n.pitch + 12 <= 60) n.pitch += 12;
    }
    // a bass that never leaves one pitch class: the second half of long notes answers with the octave
    if (partStats(notes, { bpb, length, role }).distinct16 < monotonyLimits('bass', genre).distinct16) {
      for (const n of notes) if (barOf(n.start) % 4 === 3 && n.pitch + 12 <= 60) { n.pitch += 12; break; }
    }
  }
  return notes;
}

/**
 * Monotony of every melodic part of a project (generated or hand-made).
 * -> {chordRoots: pc[], rootCount, parts: [{trackId, track, role, patternId, pattern, bars, distinct16, distinct8,
 *     cellRunBars, entropy, notes, issues[]}], byRole: {role: {minDistinct16, maxCellRunBars, minEntropy, patterns}}}
 */
export function monotonyReport(project) {
  const bpb = project?.timeSig ? project.timeSig[0] * (4 / project.timeSig[1]) : 4;
  const roots = new Set();
  const ph = project?.patternHarmony;
  if (ph) for (const h of Object.values(ph)) for (const c of h.harmony || []) roots.add(mod12(c.root));
  else if (project?.harmony) for (const c of project.harmony) roots.add(mod12(c.root));
  const parts = [];
  for (const t of project?.tracks || []) {
    if (t.role === 'drums' || t.role === 'fx' || t.instrument?.type === 'drums') continue;
    const role = t.role || 'other';
    for (const p of Object.values(project.patterns || {})) {
      if (p.trackId !== t.id || !p.notes?.length) continue;
      if (!ph && !project?.harmony && (role === 'chords' || role === 'pad')) for (const c of detectPatternChords(p, bpb)) roots.add(mod12(c.chord.root));
      const st = partStats(p.notes, { bpb, length: p.length, role });
      parts.push({ trackId: t.id, track: t.name, role, patternId: p.id, pattern: p.name, ...st, issues: isMonotonous(st, role, project.genre) });
    }
  }
  const byRole = {};
  for (const x of parts) {
    const r = (byRole[x.role] ||= { minDistinct16: Infinity, maxCellRunBars: 0, minEntropy: Infinity, patterns: 0 });
    r.patterns++;
    if (x.notes >= 8 && x.bars >= 2) {
      r.minDistinct16 = Math.min(r.minDistinct16, x.distinct16);
      r.maxCellRunBars = Math.max(r.maxCellRunBars, x.cellRunBars);
      if (x.notes >= 16) r.minEntropy = Math.min(r.minEntropy, x.entropy);
    }
  }
  return { chordRoots: [...roots].sort((a, b) => a - b), rootCount: roots.size, parts, byRole };
}
