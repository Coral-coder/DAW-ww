// Notes, pitch classes, intervals and transposition. Pure, dependency-free.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** The spelling most musicians reach for without key context. */
export const COMMON_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const mod12 = (n) => ((Math.round(n) % 12) + 12) % 12;

/** MIDI number -> 'C4' (60 = C4). */
export function noteName(midi, preferFlats = false) {
  const m = Math.round(midi);
  const names = preferFlats ? FLAT_NAMES : NOTE_NAMES;
  return names[mod12(m)] + (Math.floor(m / 12) - 1);
}

/**
 * Pitch class -> name. preferFlats: true = flats, false = sharps,
 * 'common' = the usual mixed spelling (Eb, Ab, Bb, C#, F#).
 */
export function pitchClassName(pc, preferFlats = false) {
  const p = mod12(pc);
  if (preferFlats === 'common') return COMMON_NAMES[p];
  return (preferFlats ? FLAT_NAMES : NOTE_NAMES)[p];
}

const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Parse a pitch-class name ('C#', 'eb', 'Bb', 'F♯') -> 0..11, or null. */
export function parsePitchClass(name) {
  if (typeof name === 'number') return mod12(name);
  const m = /^\s*([a-gA-G])([#♯sb♭]*)/.exec(String(name));
  if (!m) return null;
  let pc = LETTER_PC[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === 'b' || ch === '♭' ? -1 : 1;
  return mod12(pc);
}

/**
 * Parse 'C#4' | 'eb3' | 'c' | 'Bb' | 'c#-1' | 60 -> MIDI number.
 * Without an octave, octave 4 is assumed (so 'c' -> 60). Returns null when unparsable.
 */
export function parseNote(name, defaultOctave = 4) {
  if (typeof name === 'number') return Number.isFinite(name) ? name : null;
  if (name == null) return null;
  const s = String(name).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^([a-gA-G])([#♯sb♭]*)(-?\d+)?$/.exec(s);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === 'b' || ch === '♭' ? -1 : 1;
  const oct = m[3] !== undefined ? parseInt(m[3], 10) : defaultOctave;
  return (oct + 1) * 12 + pc;
}

const INTERVAL_SHORT = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];
const INTERVAL_LONG = [
  'unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th', 'tritone',
  'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th',
];
const COMPOUND_SHORT = { 12: 'P8', 13: 'm9', 14: 'M9', 15: 'm10', 16: 'M10', 17: 'P11', 18: 'A11', 19: 'P12', 20: 'm13', 21: 'M13', 22: 'm14', 23: 'M14', 24: 'P15' };
const COMPOUND_LONG = { 12: 'octave', 13: 'minor 9th', 14: 'major 9th', 15: 'minor 10th', 16: 'major 10th', 17: 'perfect 11th', 18: 'augmented 11th', 19: 'perfect 12th', 20: 'minor 13th', 21: 'major 13th', 22: 'minor 14th', 23: 'major 14th', 24: 'two octaves' };

/**
 * intervalName(semitones) or intervalName(noteA, noteB) -> 'P5', 'm3', 'M9', ...
 * opts.long -> 'perfect 5th'. Negative intervals are named by size (direction ignored).
 */
export function intervalName(a, b, opts = {}) {
  if (typeof b === 'object' && b !== null) { opts = b; b = undefined; }
  let semis = b === undefined ? a : parseNote(b) - parseNote(a);
  semis = Math.abs(Math.round(semis));
  const long = !!opts.long;
  if (semis < 12) return (long ? INTERVAL_LONG : INTERVAL_SHORT)[semis];
  if (semis <= 24) return (long ? COMPOUND_LONG : COMPOUND_SHORT)[semis];
  const oct = Math.floor(semis / 12);
  const base = (long ? INTERVAL_LONG : INTERVAL_SHORT)[semis % 12];
  return long ? `${base} + ${oct} octaves` : `${base}+${oct}oct`;
}

/**
 * Transpose almost anything by semitones:
 *  number (MIDI) -> number, 'C#4' -> 'D4', 'Eb' -> 'E', Note {pitch} -> copy,
 *  chord {root, ...} -> copy with shifted root/notes, arrays -> mapped.
 */
export function transpose(x, semitones) {
  if (Array.isArray(x)) return x.map((v) => transpose(v, semitones));
  if (typeof x === 'number') return x + semitones;
  if (typeof x === 'string') {
    const hasOct = /-?\d+$/.test(x.trim());
    const flats = /b|♭/.test(x.slice(1));
    if (hasOct) {
      const m = parseNote(x);
      return m == null ? x : noteName(m + semitones, flats);
    }
    const pc = parsePitchClass(x);
    return pc == null ? x : pitchClassName(pc + semitones, flats);
  }
  if (x && typeof x === 'object') {
    const out = { ...x };
    if (typeof x.pitch === 'number') out.pitch = x.pitch + semitones;
    if (typeof x.root === 'number') out.root = x.root >= 12 ? x.root + semitones : mod12(x.root + semitones);
    if (Array.isArray(x.notes)) {
      out.notes = x.notes.map((n) => (typeof n === 'number' ? (n < 12 && x.notes.every((v) => v < 12) ? mod12(n + semitones) : n + semitones) : transpose(n, semitones)));
    }
    if (typeof x.bass === 'number') out.bass = mod12(x.bass + semitones);
    return out;
  }
  return x;
}

/** Frequency of a MIDI note (A4 = 440). */
export const midiToFrequency = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);
