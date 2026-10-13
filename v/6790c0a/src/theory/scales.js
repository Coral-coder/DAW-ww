// Scales & modes. Intervals are semitones above the root (ascending, within one octave).
import { mod12 } from './notes.js';

const S = (name, intervals, extra = {}) => ({ name, intervals, ...extra });

/**
 * SCALES {id: {name, intervals, parent?, mood, aliases?}}
 * `parent` names the 7-note scale used for diatonic harmony when the scale itself is not heptatonic.
 */
export const SCALES = {
  major: S('Major (Ionian)', [0, 2, 4, 5, 7, 9, 11], { mood: 'bright, resolved', aliases: ['ionian', 'maj'] }),
  minor: S('Natural Minor (Aeolian)', [0, 2, 3, 5, 7, 8, 10], { mood: 'sad, serious', aliases: ['aeolian', 'min', 'natural-minor'] }),
  'harmonic-minor': S('Harmonic Minor', [0, 2, 3, 5, 7, 8, 11], { mood: 'dramatic, classical, exotic' }),
  'melodic-minor': S('Melodic Minor', [0, 2, 3, 5, 7, 9, 11], { mood: 'jazzy, sophisticated' }),
  ionian: S('Ionian', [0, 2, 4, 5, 7, 9, 11], { mood: 'bright' }),
  dorian: S('Dorian', [0, 2, 3, 5, 7, 9, 10], { mood: 'soulful minor, funky, hopeful' }),
  phrygian: S('Phrygian', [0, 1, 3, 5, 7, 8, 10], { mood: 'dark, Spanish, metal, tense' }),
  lydian: S('Lydian', [0, 2, 4, 6, 7, 9, 11], { mood: 'dreamy, floating, cinematic wonder' }),
  mixolydian: S('Mixolydian', [0, 2, 4, 5, 7, 9, 10], { mood: 'bluesy major, rock, celebratory' }),
  aeolian: S('Aeolian', [0, 2, 3, 5, 7, 8, 10], { mood: 'sad' }),
  locrian: S('Locrian', [0, 1, 3, 5, 6, 8, 10], { mood: 'unstable, dissonant' }),
  'major-pentatonic': S('Major Pentatonic', [0, 2, 4, 7, 9], { parent: 'major', mood: 'open, folk, happy' }),
  'minor-pentatonic': S('Minor Pentatonic', [0, 3, 5, 7, 10], { parent: 'minor', mood: 'bluesy, rock, hip-hop' }),
  blues: S('Blues (Minor)', [0, 3, 5, 6, 7, 10], { parent: 'minor', mood: 'gritty, soulful', aliases: ['minor-blues'] }),
  'major-blues': S('Major Blues', [0, 2, 3, 4, 7, 9], { parent: 'mixolydian', mood: 'country, gospel, sweet bluesy' }),
  'whole-tone': S('Whole Tone', [0, 2, 4, 6, 8, 10], { mood: 'dreamlike, ambiguous' }),
  'diminished-hw': S('Diminished (Half-Whole)', [0, 1, 3, 4, 6, 7, 9, 10], { mood: 'tense, jazz dominant', aliases: ['diminished', 'octatonic'] }),
  'diminished-wh': S('Diminished (Whole-Half)', [0, 2, 3, 5, 6, 8, 9, 11], { mood: 'eerie, suspense' }),
  chromatic: S('Chromatic', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], { parent: 'major', mood: 'atonal / all notes' }),
  'phrygian-dominant': S('Phrygian Dominant', [0, 1, 4, 5, 7, 8, 10], { mood: 'Middle-Eastern, flamenco, metal', aliases: ['spanish', 'freygish'] }),
  'hungarian-minor': S('Hungarian Minor', [0, 2, 3, 6, 7, 8, 11], { mood: 'gypsy, dark, exotic', aliases: ['gypsy-minor'] }),
  'double-harmonic': S('Double Harmonic', [0, 1, 4, 5, 7, 8, 11], { mood: 'Arabic, Byzantine, exotic', aliases: ['byzantine'] }),
  'japanese-in': S('Japanese In', [0, 1, 5, 7, 8], { parent: 'phrygian', mood: 'Japanese, melancholic' }),
  hirajoshi: S('Hirajoshi', [0, 2, 3, 7, 8], { parent: 'minor', mood: 'Japanese, koto' }),
  kumoi: S('Kumoi', [0, 2, 3, 7, 9], { parent: 'dorian', mood: 'Japanese, gentle' }),
  iwato: S('Iwato', [0, 1, 5, 6, 10], { parent: 'locrian', mood: 'Japanese, dark' }),
  arabic: S('Arabic (Major Locrian)', [0, 2, 4, 5, 6, 8, 10], { mood: 'Arabic, mysterious' }),
  'bebop-dominant': S('Bebop Dominant', [0, 2, 4, 5, 7, 9, 10, 11], { parent: 'mixolydian', mood: 'swinging jazz lines' }),
  'bebop-major': S('Bebop Major', [0, 2, 4, 5, 7, 8, 9, 11], { parent: 'major', mood: 'swinging jazz lines' }),
  'lydian-dominant': S('Lydian Dominant', [0, 2, 4, 6, 7, 9, 10], { mood: 'fusion, Simpsons, bright tension', aliases: ['overtone'] }),
  altered: S('Altered (Super Locrian)', [0, 1, 3, 4, 6, 8, 10], { mood: 'maximum dominant tension' }),
  'neapolitan-minor': S('Neapolitan Minor', [0, 1, 3, 5, 7, 8, 11], { mood: 'dark, operatic' }),
  'neapolitan-major': S('Neapolitan Major', [0, 1, 3, 5, 7, 9, 11], { mood: 'dark yet bright, unusual' }),
  'harmonic-major': S('Harmonic Major', [0, 2, 4, 5, 7, 8, 11], { mood: 'bittersweet major' }),
  egyptian: S('Egyptian (Suspended Pentatonic)', [0, 2, 5, 7, 10], { parent: 'mixolydian', mood: 'ancient, open' }),
  prometheus: S('Prometheus', [0, 2, 4, 6, 9, 10], { parent: 'lydian-dominant', mood: 'mystic, Scriabin' }),
  enigmatic: S('Enigmatic', [0, 1, 4, 6, 8, 10, 11], { mood: 'strange, unsettled' }),
  persian: S('Persian', [0, 1, 4, 5, 6, 8, 11], { mood: 'exotic, intense' }),
};

const ALIAS = {};
for (const [id, s] of Object.entries(SCALES)) for (const a of s.aliases || []) ALIAS[a] = id;

/** Resolve a scale id or alias to a canonical SCALES key (falls back to 'major'). */
export function resolveScaleId(id) {
  if (!id) return 'major';
  const k = String(id).toLowerCase().replace(/[\s_]+/g, '-');
  if (SCALES[k]) return k;
  if (ALIAS[k]) return ALIAS[k];
  return 'major';
}

export const getScale = (id) => SCALES[resolveScaleId(id)];
export const scaleIntervals = (id) => getScale(id).intervals;

/** Pitch classes of a scale (array, ascending from root). */
export function scalePitchClasses(root, scaleId) {
  const r = mod12(root);
  return scaleIntervals(scaleId).map((i) => (r + i) % 12);
}

/**
 * MIDI notes of the scale starting at `octave` (default 4 => root in octave 4, C4=60).
 * opts.octaves (default 1) and the octave above the last degree is appended (closing note).
 */
export function scaleNotes(root, scaleId, octave = 4, opts = {}) {
  const r = mod12(root);
  const octs = opts.octaves ?? 1;
  const base = (octave + 1) * 12 + r;
  const iv = scaleIntervals(scaleId);
  const out = [];
  for (let o = 0; o < octs; o++) for (const i of iv) out.push(base + o * 12 + i);
  if (opts.closing !== false) out.push(base + octs * 12);
  return out;
}

/** All MIDI notes of a scale between lo and hi (inclusive). */
export function scaleNotesInRange(root, scaleId, lo, hi) {
  const set = new Set(scalePitchClasses(root, scaleId));
  const out = [];
  for (let m = Math.ceil(lo); m <= hi; m++) if (set.has(mod12(m))) out.push(m);
  return out;
}

export function inScale(midi, root, scaleId) {
  return scalePitchClasses(root, scaleId).includes(mod12(midi));
}

/**
 * Snap to nearest scale tone. direction: 0 nearest (ties go down), 1 up, -1 down.
 */
export function snapToScale(midi, root, scaleId, direction = 0) {
  const set = new Set(scalePitchClasses(root, scaleId));
  const m = Math.round(midi);
  if (set.has(mod12(m))) return m;
  for (let d = 1; d <= 12; d++) {
    if (direction <= 0 && set.has(mod12(m - d))) return m - d;
    if (direction >= 0 && set.has(mod12(m + d))) return m + d;
  }
  return m;
}

/** 0-based scale degree of a note, or -1 when out of scale. */
export function scaleDegreeOf(midi, root, scaleId) {
  return scalePitchClasses(root, scaleId).indexOf(mod12(midi));
}

/** Step `steps` scale degrees from a (in-scale or snapped) note. */
export function stepInScale(midi, steps, root, scaleId) {
  const iv = scaleIntervals(scaleId);
  const n = iv.length;
  const start = snapToScale(midi, root, scaleId);
  const rel = mod12(start - root);
  const baseRoot = start - rel;
  const total = iv.indexOf(rel) + steps;
  const octShift = Math.floor(total / n);
  return baseRoot + octShift * 12 + iv[((total % n) + n) % n];
}

/** Heuristic: does the scale have a minor third (and no major third)? */
export function isMinorScale(scaleId) {
  const iv = scaleIntervals(scaleId);
  return iv.includes(3) && !iv.includes(4);
}

/** The 7-note scale used to build diatonic chords for this scale. */
export function heptatonicParent(scaleId) {
  const id = resolveScaleId(scaleId);
  const s = SCALES[id];
  if (s.parent) return s.parent;
  if (s.intervals.length === 7) return id;
  if (id === 'whole-tone' || id.startsWith('diminished')) return id; // symmetric: stack every other note
  return isMinorScale(id) ? 'minor' : 'major';
}

/** Scales that contain every given pitch class, best (smallest, most common) first. */
export function scalesContaining(pcs, root) {
  const set = [...new Set(pcs.map(mod12))];
  const out = [];
  for (const id of Object.keys(SCALES)) {
    if (id === 'chromatic' || id === 'ionian' || id === 'aeolian') continue;
    const sp = scalePitchClasses(root, id);
    if (set.every((p) => sp.includes(p))) out.push(id);
  }
  return out;
}
