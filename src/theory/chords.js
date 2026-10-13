// Chord types, voicings, naming, detection and voice leading.
import { mod12, pitchClassName, parsePitchClass } from './notes.js';

const C = (name, symbol, intervals, roman, minorish = false, complexity = 1) =>
  ({ name, symbol, intervals, roman, minorish, complexity });

/**
 * CHORD_TYPES {id: {name, symbol, intervals, roman (suffix used in roman numerals), minorish, complexity}}
 * Intervals above 12 are extensions (9 = 14, 11 = 17, 13 = 21).
 */
export const CHORD_TYPES = {
  maj: C('Major', '', [0, 4, 7], '', false, 0),
  min: C('Minor', 'm', [0, 3, 7], '', true, 0),
  dim: C('Diminished', 'dim', [0, 3, 6], '°', true, 1),
  aug: C('Augmented', 'aug', [0, 4, 8], '+', false, 1),
  sus2: C('Suspended 2nd', 'sus2', [0, 2, 7], 'sus2', false, 1),
  sus4: C('Suspended 4th', 'sus4', [0, 5, 7], 'sus4', false, 1),
  5: C('Power chord', '5', [0, 7], '5', false, 0.5),
  6: C('Major 6th', '6', [0, 4, 7, 9], '6', false, 1.6),
  m6: C('Minor 6th', 'm6', [0, 3, 7, 9], '6', true, 1.6),
  7: C('Dominant 7th', '7', [0, 4, 7, 10], '7', false, 1),
  maj7: C('Major 7th', 'maj7', [0, 4, 7, 11], 'maj7', false, 1),
  m7: C('Minor 7th', 'm7', [0, 3, 7, 10], '7', true, 1),
  m7b5: C('Half-diminished', 'm7b5', [0, 3, 6, 10], 'ø7', true, 1.2),
  dim7: C('Diminished 7th', 'dim7', [0, 3, 6, 9], '°7', true, 1.2),
  mMaj7: C('Minor-major 7th', 'm(maj7)', [0, 3, 7, 11], 'maj7', true, 1.5),
  9: C('Dominant 9th', '9', [0, 4, 7, 10, 14], '9', false, 2),
  maj9: C('Major 9th', 'maj9', [0, 4, 7, 11, 14], 'maj9', false, 2),
  m9: C('Minor 9th', 'm9', [0, 3, 7, 10, 14], '9', true, 2),
  add9: C('Add 9', 'add9', [0, 4, 7, 14], 'add9', false, 1.5),
  madd9: C('Minor add 9', 'madd9', [0, 3, 7, 14], 'add9', true, 1.5),
  11: C('Dominant 11th', '11', [0, 7, 10, 14, 17], '11', false, 2.5),
  m11: C('Minor 11th', 'm11', [0, 3, 7, 10, 14, 17], '11', true, 2.5),
  13: C('Dominant 13th', '13', [0, 4, 7, 10, 14, 21], '13', false, 2.5),
  maj13: C('Major 13th', 'maj13', [0, 4, 7, 11, 14, 21], 'maj13', false, 2.5),
  m13: C('Minor 13th', 'm13', [0, 3, 7, 10, 14, 21], '13', true, 2.7),
  '7sus4': C('Dominant 7th sus4', '7sus4', [0, 5, 7, 10], '7sus4', false, 1.4),
  '9sus4': C('Dominant 9th sus4', '9sus4', [0, 5, 7, 10, 14], '9sus4', false, 2.2),
  '7b9': C('Dominant 7th flat 9', '7b9', [0, 4, 7, 10, 13], '7b9', false, 2.2),
  '7#9': C('Dominant 7th sharp 9 (Hendrix)', '7#9', [0, 4, 7, 10, 15], '7#9', false, 2.2),
  '7#11': C('Dominant 7th sharp 11', '7#11', [0, 4, 7, 10, 18], '7#11', false, 2.4),
  '7b5': C('Dominant 7th flat 5', '7b5', [0, 4, 6, 10], '7b5', false, 2.4),
  aug7: C('Augmented 7th', 'aug7', [0, 4, 8, 10], '+7', false, 1.8),
  augMaj7: C('Augmented major 7th', 'maj7#5', [0, 4, 8, 11], '+maj7', false, 2.2),
  maj7s11: C('Major 7th sharp 11 (Lydian)', 'maj7#11', [0, 4, 7, 11, 18], 'maj7#11', false, 2.4),
  69: C('6/9', '6/9', [0, 4, 7, 9, 14], '6/9', false, 2.2),
  m69: C('Minor 6/9', 'm6/9', [0, 3, 7, 9, 14], '6/9', true, 2.4),
};

export function getChordType(id) {
  return CHORD_TYPES[id] || CHORD_TYPES.maj;
}

/** Sorted unique pitch classes of a chord root/type. */
export function chordPitchClasses(root, typeId) {
  return [...new Set(getChordType(typeId).intervals.map((i) => mod12(root + i)))];
}

const sortNum = (a) => a.slice().sort((x, y) => x - y);

/** Rotate the lowest note up an octave `n` times. */
export function invert(notes, n = 1) {
  let out = sortNum(notes);
  for (let i = 0; i < n; i++) {
    const [lo, ...rest] = out;
    let up = lo + 12;
    while (rest.length && up <= rest[rest.length - 1] - 12) up += 12;
    out = sortNum([...rest, up]);
  }
  return out;
}

/**
 * MIDI notes for a chord.
 * opts.inversion (0..), opts.voicing: 'close' | 'open' | 'drop2' | 'drop3' | 'spread' | 'shell'
 */
export function chordNotes(rootMidi, typeId = 'maj', opts = {}) {
  const t = getChordType(typeId);
  const inversion = opts.inversion || 0;
  const voicing = opts.voicing || 'close';
  let notes = t.intervals.map((i) => rootMidi + i);
  if (voicing === 'shell') {
    // root, 3rd(or sus), 7th(or 6th/5th) — the jazz "shell"
    const third = t.intervals.find((i) => i >= 2 && i <= 5) ?? 7;
    const seventh = t.intervals.find((i) => i >= 9 && i <= 11) ?? 7;
    notes = [rootMidi, rootMidi + third, rootMidi + seventh];
  }
  if (inversion) notes = invert(notes, inversion % Math.max(1, notes.length) || 0);
  notes = sortNum(notes);
  switch (voicing) {
    case 'open': {
      // keep the bass, lift every other upper voice an octave
      notes = sortNum(notes.map((n, i) => (i > 0 && i % 2 === 1 ? n + 12 : n)));
      break;
    }
    case 'drop2': {
      if (notes.length >= 3) {
        const i = notes.length - 2;
        notes = sortNum(notes.map((n, k) => (k === i ? n - 12 : n)));
      }
      break;
    }
    case 'drop3': {
      if (notes.length >= 4) {
        const i = notes.length - 3;
        notes = sortNum(notes.map((n, k) => (k === i ? n - 12 : n)));
      }
      break;
    }
    case 'spread': {
      // bass note an octave down, upper structure opened up
      const [bass, ...upper] = notes;
      const opened = upper.map((n, i) => (i % 2 === 1 ? n + 12 : n));
      notes = sortNum([bass - 12, ...opened]);
      break;
    }
    default:
      break;
  }
  return notes;
}

/** Root position, n-th inversion helper by name: chordInversions(60,'maj7') -> [[...],[...],...] */
export function chordInversions(rootMidi, typeId) {
  const n = getChordType(typeId).intervals.length;
  return Array.from({ length: n }, (_, i) => chordNotes(rootMidi, typeId, { inversion: i }));
}

/**
 * Name of a chord object {root, type, bass?} -> 'Cmaj7', 'F#m7b5', 'Eb/G'.
 * opts.preferFlats (default 'common' spelling)
 */
export function chordName(chord, opts = {}) {
  if (!chord) return '';
  const spelling = opts.preferFlats ?? chord.preferFlats ?? 'common';
  const root = pitchClassName(chord.root, spelling);
  const sym = getChordType(chord.type).symbol;
  const bass = chord.bass != null && mod12(chord.bass) !== mod12(chord.root)
    ? '/' + pitchClassName(chord.bass, spelling) : '';
  return root + sym + bass;
}

/** Parse 'Cmaj7', 'F#m7b5', 'Bbsus4', 'G7/B', 'Am' -> {root, type, bass?} or null. */
export function parseChordName(name) {
  const m = /^\s*([A-Ga-g][#♯b♭]?)(.*?)(?:\/([A-Ga-g][#♯b♭]?))?\s*$/.exec(String(name));
  if (!m) return null;
  const root = parsePitchClass(m[1]);
  const q = m[2].trim();
  const SYN = {
    '': 'maj', M: 'maj', maj: 'maj', m: 'min', min: 'min', '-': 'min', dim: 'dim', '°': 'dim', o: 'dim',
    aug: 'aug', '+': 'aug', 'm7b5': 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', '-7b5': 'm7b5', dim7: 'dim7', '°7': 'dim7', o7: 'dim7',
    maj7: 'maj7', M7: 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', m7: 'm7', '-7': 'm7', min7: 'm7',
    'm(maj7)': 'mMaj7', mMaj7: 'mMaj7', mmaj7: 'mMaj7', 'maj7#5': 'augMaj7', '+maj7': 'augMaj7', 'maj7#11': 'maj7s11',
    '6/9': '69', 69: '69', 'm6/9': 'm69', '+7': 'aug7', '7#5': 'aug7', aug7: 'aug7', sus: 'sus4', min9: 'm9', min11: 'm11',
  };
  let type = SYN[q];
  if (!type && CHORD_TYPES[q]) type = q;
  if (!type) {
    for (const [id, t] of Object.entries(CHORD_TYPES)) if (t.symbol === q) { type = id; break; }
  }
  if (!type) return null;
  const out = { root, type };
  if (m[3]) out.bass = parsePitchClass(m[3]);
  return out;
}

/**
 * Detect a chord from MIDI notes (numbers or {pitch}).
 * Returns {root, type, name, bass, inversion, notes(pcs), exact} or null.
 */
export function detectChord(midiNotes) {
  const pitches = (midiNotes || []).map((n) => (typeof n === 'number' ? n : n?.pitch)).filter((n) => Number.isFinite(n));
  if (!pitches.length) return null;
  const pcs = [...new Set(pitches.map(mod12))];
  const bass = mod12(Math.min(...pitches));
  if (pcs.length === 1) return { root: pcs[0], type: '5', name: pitchClassName(pcs[0], 'common') + '5', bass, inversion: 0, notes: pcs, exact: false };
  let best = null;
  for (const root of pcs) {
    for (const [id, t] of Object.entries(CHORD_TYPES)) {
      const tpl = [...new Set(t.intervals.map((i) => mod12(root + i)))];
      const matched = tpl.filter((p) => pcs.includes(p)).length;
      const missing = tpl.length - matched;
      const extra = pcs.filter((p) => !tpl.includes(p)).length;
      // the 5th may be omitted without penalty in 4+ note chords
      const fifth = mod12(root + 7);
      const missingFifthOnly = missing === 1 && !pcs.includes(fifth) && tpl.includes(fifth) && tpl.length >= 4;
      // need the 3rd-ish defining tone present
      if (matched < Math.min(2, tpl.length)) continue;
      let score = matched * 2 - (missingFifthOnly ? 0.4 : missing * 2.2) - extra * 2.5 - t.complexity * 0.15;
      if (root === bass) score += 0.9;
      if (!best || score > best.score) best = { root, type: id, score, exact: missing === 0 && extra === 0 };
    }
  }
  if (!best || best.score < 2) return null;
  const tpl = getChordType(best.type).intervals.map((i) => mod12(best.root + i));
  const inversion = Math.max(0, [...new Set(tpl)].indexOf(bass));
  const chord = { root: best.root, type: best.type, bass, inversion, notes: pcs, exact: best.exact };
  chord.name = chordName(chord);
  return chord;
}

/**
 * Voice-lead from previous voicing to the next chord's pitch classes.
 * prevNotes: MIDI[] (may be empty), nextPcs: pitch classes (or chord pcs), range [lo, hi].
 * Returns MIDI[] with the smoothest motion (minimal total movement), kept inside range.
 */
export function voiceLead(prevNotes = [], nextPcs = [], range = [52, 76], opts = {}) {
  const [lo, hi] = range;
  const pcs = [...new Set(nextPcs.map(mod12))];
  if (!pcs.length) return [];
  const voices = opts.voices || Math.max(pcs.length, Math.min(prevNotes.length || pcs.length, pcs.length + 1));
  const center = prevNotes.length ? prevNotes.reduce((s, n) => s + n, 0) / prevNotes.length : (lo + hi) / 2;
  // candidate voicings: every rotation of close position at every octave, plus drop-2 versions
  const candidates = [];
  const base = pcs.slice();
  // add doubling if more voices are wanted than pitch classes (double the first = root by convention)
  while (base.length < voices) base.push(base[base.length - pcs.length]);
  for (let rot = 0; rot < base.length; rot++) {
    const order = base.slice(rot).concat(base.slice(0, rot));
    for (let startOct = Math.floor(lo / 12) - 1; startOct <= Math.ceil(hi / 12); startOct++) {
      const v = [];
      let prev = -Infinity;
      for (const pc of order) {
        let n = startOct * 12 + pc;
        while (n <= prev) n += 12;
        v.push(n);
        prev = n;
      }
      candidates.push(v);
      if (v.length >= 4) {
        const d = v.slice();
        d[d.length - 2] -= 12;
        candidates.push(d.sort((a, b) => a - b));
      }
    }
  }
  let best = null;
  let bestCost = Infinity;
  const prevSorted = sortNum(prevNotes);
  for (const v of candidates) {
    let cost = 0;
    for (const n of v) {
      if (n < lo) cost += (lo - n) * 3;
      if (n > hi) cost += (n - hi) * 3;
    }
    if (prevSorted.length) {
      // pair voices by sorted order; extra voices measured to nearest previous note
      for (let i = 0; i < v.length; i++) {
        const j = Math.round((i * (prevSorted.length - 1)) / Math.max(1, v.length - 1));
        cost += Math.abs(v[i] - prevSorted[j]);
      }
    } else {
      const mean = v.reduce((s, n) => s + n, 0) / v.length;
      cost += Math.abs(mean - center) * 0.8;
    }
    // avoid muddy close intervals in the low register
    for (let i = 1; i < v.length; i++) if (v[i - 1] < 52 && v[i] - v[i - 1] < 3) cost += 6;
    // avoid overly wide spans
    const span = v[v.length - 1] - v[0];
    if (span > 19) cost += (span - 19) * 1.5;
    if (cost < bestCost) { bestCost = cost; best = v; }
  }
  return best;
}
