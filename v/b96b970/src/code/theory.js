// Small, self-contained music-theory helpers used by the Strudel-style code engine.
// Follows Strudel conventions: c4 = 60 (middle C), octave defaults to 3 when omitted ("c" -> 48).

const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_RE = /^([a-gA-G])([#bsf]*)(-?\d+)?$/;
const FLAT_NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

export const DEFAULT_OCTAVE = 3;

export function isNoteName(v) {
  return typeof v === 'string' && NOTE_RE.test(v);
}

/** 'c3' -> 48, 'eb4' -> 63, 'f#' -> 54, 'a' -> 57. Returns null if not a note name. */
export function noteToMidi(name, defaultOctave = DEFAULT_OCTAVE) {
  if (typeof name === 'number') return name;
  const m = NOTE_RE.exec(String(name).trim());
  if (!m) return null;
  let acc = 0;
  for (const ch of m[2]) acc += ch === '#' || ch === 's' ? 1 : -1;
  const oct = m[3] !== undefined ? Number(m[3]) : defaultOctave;
  return (oct + 1) * 12 + LETTER_PC[m[1].toLowerCase()] + acc;
}

/** 60 -> 'c4', 63 -> 'eb4' (lower-case Strudel style). */
export function midiToNoteName(midi) {
  const m = Math.round(midi);
  return FLAT_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** Converts numbers, numeric strings and note names to a number (Strudel `parseNumeral`). */
export function toNumeral(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return toNumeral(v[0]);
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && !Number.isNaN(n)) return n;
    const midi = noteToMidi(v);
    if (midi !== null) return midi;
  }
  return NaN;
}

// ---------------------------------------------------------------------------------- scales

export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'harmonic major': [0, 2, 4, 5, 7, 8, 11],
  'melodic minor': [0, 2, 3, 5, 7, 9, 11],
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'minor blues': [0, 3, 5, 6, 7, 10],
  'major blues': [0, 2, 3, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'whole tone': [0, 2, 4, 6, 8, 10],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11],
  'phrygian dominant': [0, 1, 4, 5, 7, 8, 10],
  'lydian dominant': [0, 2, 4, 6, 7, 9, 10],
  'double harmonic major': [0, 1, 4, 5, 7, 8, 11],
  'hungarian minor': [0, 2, 3, 6, 7, 8, 11],
  bebop: [0, 2, 4, 5, 7, 9, 10, 11],
  hirajoshi: [0, 2, 3, 7, 8],
  'in-sen': [0, 1, 5, 7, 10],
  iwato: [0, 1, 5, 6, 10],
  kumoijoshi: [0, 1, 5, 7, 8],
  egyptian: [0, 2, 5, 7, 10],
  ritusen: [0, 2, 5, 7, 9],
  augmented: [0, 3, 4, 7, 8, 11],
  prometheus: [0, 2, 4, 6, 11],
};

const SCALE_ALIASES = {
  ionian: 'major', aeolian: 'minor', 'natural minor': 'minor', pentatonic: 'major pentatonic',
  'pentatonic major': 'major pentatonic', 'pentatonic minor': 'minor pentatonic', blues: 'minor blues',
  wholetone: 'whole tone', 'whole-tone': 'whole tone', harmonicminor: 'harmonic minor', melodicminor: 'melodic minor',
  'double harmonic': 'double harmonic major', insen: 'in-sen', 'altered': 'super locrian',
  'super locrian': 'super locrian', majpent: 'major pentatonic', minpent: 'minor pentatonic',
};
SCALE_INTERVALS['super locrian'] = [0, 1, 3, 4, 6, 8, 10];

export function scaleIntervals(type) {
  const key = String(type).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return SCALE_INTERVALS[key] || SCALE_INTERVALS[SCALE_ALIASES[key]] || null;
}

/**
 * Parses Strudel scale names: "C:minor", "a2:minor:pentatonic", "D4:dorian", "C major", ["C","major"].
 * Returns { root (midi), intervals, name }.
 */
export function parseScale(name) {
  const parts = (Array.isArray(name) ? name.map(String) : String(name).split(/[:\s]+/)).filter((p) => p !== '');
  let tonic = 'C';
  let typeParts = parts;
  if (parts.length && isNoteName(parts[0])) {
    tonic = parts[0];
    typeParts = parts.slice(1);
  }
  const type = typeParts.join(' ') || 'major';
  const intervals = scaleIntervals(type);
  if (!intervals) throw new Error(`Unknown scale "${type}"`);
  return { root: noteToMidi(tonic), intervals, name: `${tonic}:${type}` };
}

/** Scale degree (0-based, may be negative or > length) -> MIDI note. */
export function scaleStep(step, scale) {
  const sc = typeof scale === 'object' && scale.intervals ? scale : parseScale(scale);
  const s = Math.floor(toNumeral(step));
  if (!Number.isFinite(s)) return NaN;
  const len = sc.intervals.length;
  const oct = Math.floor(s / len);
  return sc.root + oct * 12 + sc.intervals[((s % len) + len) % len];
}

// ---------------------------------------------------------------------------------- chords

const CHORDS = [
  [['', 'M', 'maj', '^', 'major'], [0, 4, 7]],
  [['m', 'min', '-', 'minor'], [0, 3, 7]],
  [['7', 'dom7', 'dom'], [0, 4, 7, 10]],
  [['^7', 'maj7', 'M7', 'Δ', 'Δ7', 'ma7'], [0, 4, 7, 11]],
  [['m7', '-7', 'min7', 'mi7'], [0, 3, 7, 10]],
  [['m^7', 'mM7', '-^7', 'mmaj7', 'minmaj7'], [0, 3, 7, 11]],
  [['dim', 'o', '°'], [0, 3, 6]],
  [['dim7', 'o7', '°7'], [0, 3, 6, 9]],
  [['m7b5', 'h7', 'h', 'ø', 'ø7', '-7b5', 'min7b5'], [0, 3, 6, 10]],
  [['aug', '+', '#5'], [0, 4, 8]],
  [['sus2', '2'], [0, 2, 7]],
  [['sus4', 'sus', '4'], [0, 5, 7]],
  [['7sus4', '7sus'], [0, 5, 7, 10]],
  [['6', 'M6', 'maj6'], [0, 4, 7, 9]],
  [['m6', '-6', 'min6'], [0, 3, 7, 9]],
  [['69', '6/9', '6add9'], [0, 4, 7, 9, 14]],
  [['m69', '-69'], [0, 3, 7, 9, 14]],
  [['9', 'dom9'], [0, 4, 7, 10, 14]],
  [['m9', '-9', 'min9'], [0, 3, 7, 10, 14]],
  [['^9', 'maj9', 'M9'], [0, 4, 7, 11, 14]],
  [['add9', 'add2', 'Madd9'], [0, 4, 7, 14]],
  [['madd9', 'm(add9)', '-add9'], [0, 3, 7, 14]],
  [['11', 'dom11'], [0, 4, 7, 10, 14, 17]],
  [['m11', '-11', 'min11'], [0, 3, 7, 10, 14, 17]],
  [['13', 'dom13'], [0, 4, 7, 10, 14, 21]],
  [['m13', '-13'], [0, 3, 7, 10, 14, 21]],
  [['^13', 'maj13', 'M13'], [0, 4, 7, 11, 14, 21]],
  [['7b9'], [0, 4, 7, 10, 13]],
  [['7#9'], [0, 4, 7, 10, 15]],
  [['7#11', 'lyd7'], [0, 4, 7, 10, 18]],
  [['^7#11', 'maj7#11'], [0, 4, 7, 11, 18]],
  [['7b5'], [0, 4, 6, 10]],
  [['7#5', 'aug7', '+7'], [0, 4, 8, 10]],
  [['7alt', 'alt'], [0, 4, 10, 13, 15]],
  [['5', 'power'], [0, 7]],
];
export const CHORD_INTERVALS = {};
for (const [names, iv] of CHORDS) for (const n of names) CHORD_INTERVALS[n] = iv;

const CHORD_RE = /^([A-Ga-g])([#b]?)(.*)$/;

/** 'Am7' -> { root: pc 9, intervals:[0,3,7,10], symbol } ; throws on unknown chord. */
export function parseChord(symbol) {
  const sym = Array.isArray(symbol) ? symbol.join(':') : String(symbol).trim();
  const m = CHORD_RE.exec(sym);
  if (!m) throw new Error(`Unknown chord "${sym}"`);
  const rootPc = (LETTER_PC[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  let quality = m[3].split('/')[0];
  let intervals = CHORD_INTERVALS[quality];
  if (!intervals) intervals = CHORD_INTERVALS[quality.replace(/^maj/, '^')];
  if (!intervals) throw new Error(`Unknown chord "${sym}"`);
  return { root: rootPc, intervals, symbol: sym };
}

/**
 * Close voicing of a chord symbol relative to an anchor note (default c5 = 72).
 * mode 'below': top note <= anchor (Strudel default); 'above': lowest note >= anchor; 'root': root position from anchor octave.
 */
export function voiceChord(symbol, { anchor = 72, mode = 'below' } = {}) {
  const { root, intervals } = parseChord(symbol);
  const anchorMidi = typeof anchor === 'number' ? anchor : noteToMidi(anchor) ?? 72;
  if (mode === 'root') {
    const base = anchorMidi - (((anchorMidi - root) % 12) + 12) % 12;
    return intervals.map((i) => base + i);
  }
  const pcs = [...new Set(intervals.map((i) => (root + i) % 12))];
  const notes = pcs.map((pc) =>
    mode === 'above'
      ? anchorMidi + (((pc - anchorMidi) % 12) + 12) % 12
      : anchorMidi - (((anchorMidi - pc) % 12) + 12) % 12,
  );
  return notes.sort((a, b) => a - b);
}

export function chordRootMidi(symbol, octave = 2) {
  const { root } = parseChord(symbol);
  return (octave + 1) * 12 + root;
}
