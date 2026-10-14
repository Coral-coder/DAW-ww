// Keys, diatonic harmony, roman numerals, key detection and the circle of fifths.
import { mod12, pitchClassName, parsePitchClass } from './notes.js';
import { SCALES, resolveScaleId, scaleIntervals, scalePitchClasses, heptatonicParent, isMinorScale } from './scales.js';
import { CHORD_TYPES, getChordType, chordPitchClasses, chordName } from './chords.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Identify a chord type from intervals (relative to root). Falls back to the closest triad. */
export function chordTypeFromIntervals(intervals) {
  const key = intervals.join(',');
  for (const [id, t] of Object.entries(CHORD_TYPES)) if (t.intervals.join(',') === key) return id;
  // try without extensions
  const pcsSet = new Set(intervals.map((i) => i % 12));
  const has = (x) => pcsSet.has(x);
  const third = has(4) ? 4 : has(3) ? 3 : has(5) ? 5 : has(2) ? 2 : null;
  const fifth = has(7) ? 7 : has(6) ? 6 : has(8) ? 8 : null;
  const seventh = has(11) ? 11 : has(10) ? 10 : has(9) && third === 3 && fifth === 6 ? 9 : null;
  const tri = third === 4 ? (fifth === 8 ? 'aug' : 'maj') : third === 3 ? (fifth === 6 ? 'dim' : 'min')
    : third === 5 ? 'sus4' : third === 2 ? 'sus2' : 'maj';
  if (seventh == null) return tri;
  const map = {
    'maj,11': 'maj7', 'maj,10': '7', 'min,10': 'm7', 'min,11': 'mMaj7', 'dim,10': 'm7b5', 'dim,9': 'dim7',
    'aug,10': 'aug7', 'aug,11': 'augMaj7', 'sus4,10': '7sus4', 'dim,11': 'mMaj7', 'sus2,10': '7sus4',
  };
  return map[`${tri},${seventh}`] || tri;
}

/** Roman numeral prefix (accidental + numeral) for a semitone offset from the key root, major-relative. */
function numeralFor(interval, preferSharp4 = false) {
  const i = mod12(interval);
  const idx = MAJOR.indexOf(i);
  if (idx >= 0) return NUMERALS[idx];
  if (i === 6) return preferSharp4 ? '#IV' : 'bV';
  return 'b' + NUMERALS[MAJOR.indexOf(i + 1)];
}

/** Roman numeral string for chord root/type in key (e.g. 'bVImaj7', 'iiø7', 'V7'). */
export function chordToRoman(chord, keyRoot = 0) {
  const t = getChordType(chord.type);
  const interval = mod12(chord.root - keyRoot);
  const dimish = chord.type === 'dim' || chord.type === 'dim7';
  let num = numeralFor(interval, dimish);
  if (t.minorish) num = num.toLowerCase();
  return num + t.roman;
}

/**
 * Diatonic chord on a 0-based scale degree.
 * opts.sevenths (bool), opts.extensions (0 = triad/7th as asked, 1 = add 9th, 2 = +11th, 3 = +13th)
 * -> {root (pc), type, roman, notes (pcs), degree, name}
 */
export function diatonicChord(root, scaleId, degree, opts = {}) {
  const id = resolveScaleId(scaleId);
  const parent = heptatonicParent(id);
  const iv = scaleIntervals(parent);
  const n = iv.length;
  const d = ((degree % n) + n) % n;
  const count = 3 + (opts.sevenths || opts.extensions ? 1 : 0) + (opts.extensions || 0);
  const ints = [];
  for (let k = 0; k < count; k++) {
    const idx = d + k * 2;
    const semis = iv[idx % n] + 12 * Math.floor(idx / n) - iv[d];
    ints.push(semis);
  }
  // an 11th over a major 3rd clashes (b9 against the 3rd): drop it, as players do
  const filtered = ints.includes(4) || ints.includes(3) && count > 6 ? ints.filter((i) => i !== 17) : ints;
  const type = chordTypeFromIntervals(filtered);
  const chordRoot = mod12(root + iv[d]);
  const chord = { root: chordRoot, type, degree: d };
  chord.roman = chordToRoman(chord, root);
  chord.preferFlats = keyPrefersFlats(root, id);
  chord.notes = chordPitchClasses(chordRoot, type);
  chord.name = chordName(chord);
  return chord;
}

/** All diatonic chords of a key. */
export function diatonicChords(root, scaleId, opts = {}) {
  const parent = heptatonicParent(scaleId);
  return scaleIntervals(parent).map((_, d) => diatonicChord(root, scaleId, d, opts));
}

// suffix (after numeral) -> chord type, given upper/lower-case numeral
function suffixToType(suffix, upper) {
  const s = suffix.replace(/\s+/g, '');
  const table = {
    '': upper ? 'maj' : 'min',
    '°': 'dim', o: 'dim', dim: 'dim', '°7': 'dim7', o7: 'dim7', dim7: 'dim7',
    'ø': 'm7b5', 'ø7': 'm7b5', m7b5: 'm7b5', '7b5': upper ? '7b5' : 'm7b5',
    '+': 'aug', aug: 'aug', '+7': 'aug7', aug7: 'aug7', '7#5': 'aug7', '+maj7': 'augMaj7', 'maj7#5': 'augMaj7',
    7: upper ? '7' : 'm7',
    maj7: upper ? 'maj7' : 'mMaj7', M7: upper ? 'maj7' : 'mMaj7', 'Δ': upper ? 'maj7' : 'mMaj7', 'Δ7': upper ? 'maj7' : 'mMaj7',
    9: upper ? '9' : 'm9', maj9: 'maj9', 11: upper ? '11' : 'm11', 13: upper ? '13' : 'm13', maj13: 'maj13',
    6: upper ? '6' : 'm6', '6/9': upper ? '69' : 'm69', 69: upper ? '69' : 'm69',
    sus: 'sus4', sus4: 'sus4', sus2: 'sus2', '7sus': '7sus4', '7sus4': '7sus4', '9sus4': '9sus4', '9sus': '9sus4',
    add9: upper ? 'add9' : 'madd9', add2: upper ? 'add9' : 'madd9',
    5: '5', '7b9': '7b9', '7#9': '7#9', '7#11': '7#11', 'maj7#11': 'maj7s11',
    m: 'min', m7: 'm7', M: 'maj',
  };
  return table[s] ?? null;
}

const ROMAN_RE = /^([b#♭♯]*)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/;

/**
 * Roman numeral -> chord in key.
 * Accidentals (b/#) are relative to the MAJOR scale of the key ('bVII' in C = Bb).
 * Plain numerals follow the given scale's degrees (so in C minor 'VI' = Ab, 'III' = Eb),
 * except lowercase vii°/vii°7 which is the leading-tone chord.
 * Supports case for quality, °, ø, +, 7, maj7, 9, 11, 13, 6, sus2/sus4, add9, 5, 7b9 ...
 * and secondary chords: 'V/V', 'V7/vi', 'vii°7/V'.
 * -> {root, type, roman, notes (pcs), name, degree, secondary?} or null.
 */
export function romanToChord(roman, keyRoot = 0, scaleId = 'major') {
  if (!roman) return null;
  const str = String(roman).trim();
  const slash = str.indexOf('/');
  if (slash > 0) {
    const head = str.slice(0, slash);
    const target = str.slice(slash + 1);
    const t = romanToChord(target, keyRoot, scaleId);
    if (!t) return null;
    const minorTarget = CHORD_TYPES[t.type]?.minorish;
    const inner = romanToChord(head, t.root, minorTarget ? 'minor' : 'major');
    if (!inner) return null;
    const chord = { ...inner, roman: str, secondary: true, target: t.root };
    chord.name = chordName(chord);
    return chord;
  }
  const m = ROMAN_RE.exec(str);
  if (!m) return null;
  const [, acc, num, suffixRaw] = m;
  const upper = num === num.toUpperCase();
  const idx = NUMERALS.indexOf(num.toUpperCase());
  const type = suffixToType(suffixRaw, upper);
  if (!type) return null;
  let interval;
  if (acc) {
    interval = MAJOR[idx];
    for (const ch of acc) interval += ch === 'b' || ch === '♭' ? -1 : 1;
  } else {
    const parent = heptatonicParent(scaleId);
    const iv = scaleIntervals(parent);
    interval = iv.length === 7 ? iv[idx] : MAJOR[idx];
    if (idx === 6 && (type === 'dim' || type === 'dim7' || type === 'm7b5') && interval === 10) interval = 11;
  }
  const root = mod12(keyRoot + interval);
  const chord = { root, type, roman: str, degree: idx };
  if (/[b♭]/.test(acc) || keyPrefersFlats(keyRoot, scaleId)) chord.preferFlats = true;
  chord.notes = chordPitchClasses(root, type);
  chord.name = chordName(chord);
  return chord;
}

/** Is every chord tone inside the key's scale? */
export function isDiatonic(chord, keyRoot, scaleId) {
  const set = new Set(scalePitchClasses(keyRoot, heptatonicParent(scaleId)));
  return chordPitchClasses(chord.root, chord.type).every((p) => set.has(p));
}

// ---- Key detection (Krumhansl–Kessler / Krumhansl–Schmuckler) ----
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Pitch-class histogram weighted by duration (and a little by velocity). */
export function pitchClassHistogram(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes || []) {
    if (typeof n === 'number') h[mod12(n)] += 1;
    else if (n && Number.isFinite(n.pitch)) h[mod12(n.pitch)] += (n.dur ?? 1) * (0.5 + 0.5 * (n.vel ?? 0.8));
  }
  return h;
}

/**
 * Krumhansl–Schmuckler key finding.
 * notes: MIDI numbers or {pitch, dur, vel}. -> [{root, scale:'major'|'minor', score, name}] best first.
 */
export function detectKey(notes) {
  const h = pitchClassHistogram(notes);
  const total = h.reduce((s, v) => s + v, 0);
  if (!total) return [];
  // tonic hint: the lowest / first / last note gets a small extra pull
  const list = (notes || []).map((n) => (typeof n === 'number' ? { pitch: n, start: 0 } : n)).filter((n) => n && Number.isFinite(n.pitch));
  const sorted = list.slice().sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const hint = new Array(12).fill(0);
  if (sorted.length) {
    hint[mod12(sorted[0].pitch)] += 0.012;
    hint[mod12(sorted[sorted.length - 1].pitch)] += 0.012;
    const lowest = list.reduce((m, n) => (n.pitch < m.pitch ? n : m), list[0]);
    hint[mod12(lowest.pitch)] += 0.008;
  }
  const out = [];
  for (let r = 0; r < 12; r++) {
    const rot = (p) => p.map((_, i) => p[mod12(i - r)]);
    out.push({ root: r, scale: 'major', score: correlate(h, rot(KK_MAJOR)) + hint[r] });
    out.push({ root: r, scale: 'minor', score: correlate(h, rot(KK_MINOR)) + hint[r] });
  }
  out.sort((a, b) => b.score - a.score);
  for (const k of out) k.name = keyName(k.root, k.scale);
  return out;
}

// ---- Key relations ----
/** Major-key roots written with flats (F Bb Eb Ab Db Gb); minor / modal keys follow their relative major. */
export const FLAT_MAJOR_ROOTS = Object.freeze([5, 10, 3, 8, 1, 6]);
export function keyPrefersFlats(root, scaleId = 'major') {
  // count via relative major: Eb minor (Gb major, 6 flats) — not D# minor; Ab major — not G# major
  return FLAT_MAJOR_ROOTS.includes(relativeMajorRoot(root, scaleId || 'major'));
}

/**
 * THE key-signature-aware spelling: a pitch class named as the key {root, scale} writes it (flat keys -> flats,
 * sharp keys -> sharps). With no key, the common mixed spelling. Used for key names, chord symbols, code comments,
 * MusicXML, setlist and toasts.
 */
export function spellPitch(pc, key = null) {
  if (!key) return pitchClassName(pc, 'common');
  return pitchClassName(pc, keyPrefersFlats(key.root, key.scale));
}
/** The key's own root name: 8 + major -> 'Ab', 3 + minor -> 'Eb', 6 + minor -> 'F#'. */
export const keyRootName = (root, scaleId = 'major') => pitchClassName(root, keyPrefersFlats(root, scaleId));
/** Key-aware MIDI note name ('Ab4' in Eb major, 'G#4' in E major). */
export function spellNote(midi, key = null) {
  const m = Math.round(midi);
  return spellPitch(m, key) + (Math.floor(m / 12) - 1);
}

export function keyName(root, scaleId = 'major') {
  const id = resolveScaleId(scaleId);
  const flats = keyPrefersFlats(root, id);
  const label = id === 'major' ? 'major' : id === 'minor' ? 'minor' : SCALES[id].name;
  // sharp keys keep sharp spelling (G# minor, not "Ab minor" next to its C#m chord); flat keys use flats
  return `${pitchClassName(root, flats)} ${label}`;
}

/** Parse 'C major', 'F# minor', 'Am', 'Eb', 'D dorian' -> {root, scale} | null. */
export function parseKey(text) {
  const m = /^\s*([A-Ga-g][#♯b♭]?)\s*(maj(?:or)?|min(?:or)?|m)?(?![a-z])\s*([a-z][a-z -]*)?\s*$/i.exec(String(text));
  if (!m) return null;
  const root = parsePitchClass(m[1]);
  let scale = 'major';
  if (m[2] && /^m(in(or)?)?$/.test(m[2].toLowerCase()) && m[2] !== 'M') scale = 'minor';
  if (m[3]) scale = resolveScaleId(m[3]);
  return { root, scale };
}

const MODE_OFFSET = { major: 0, ionian: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, minor: 9, aeolian: 9, locrian: 11 };

function relativeMajorRoot(root, scaleId) {
  const id = resolveScaleId(scaleId);
  if (MODE_OFFSET[id] != null) return mod12(root - MODE_OFFSET[id]);
  return isMinorScale(id) ? mod12(root + 3) : mod12(root);
}

/** Relative key: C major <-> A minor; modes map to their parent major (D dorian -> C major). */
export function relativeKey(root, scaleId = 'major') {
  const id = resolveScaleId(scaleId);
  if (id === 'major' || id === 'ionian') return { root: mod12(root + 9), scale: 'minor' };
  if (id === 'minor' || id === 'aeolian' || id === 'harmonic-minor' || id === 'melodic-minor') return { root: mod12(root + 3), scale: 'major' };
  if (id === 'major-pentatonic') return { root: mod12(root + 9), scale: 'minor-pentatonic' };
  if (id === 'minor-pentatonic') return { root: mod12(root + 3), scale: 'major-pentatonic' };
  if (id === 'blues') return { root: mod12(root + 3), scale: 'major-blues' };
  if (id === 'major-blues') return { root: mod12(root + 9), scale: 'blues' };
  return { root: relativeMajorRoot(root, id), scale: 'major' };
}

/** Parallel key: same root, major <-> minor. */
export function parallelKey(root, scaleId = 'major') {
  const minor = isMinorScale(scaleId);
  return { root: mod12(root), scale: minor ? 'major' : 'minor' };
}

/** Pitch classes ordered around the circle of fifths starting at C. */
export const CIRCLE_OF_FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

/** Steps around the circle between two roots (0..6). */
export function fifthsDistance(a, b) {
  const ia = CIRCLE_OF_FIFTHS.indexOf(mod12(a));
  const ib = CIRCLE_OF_FIFTHS.indexOf(mod12(b));
  const d = Math.abs(ia - ib);
  return Math.min(d, 12 - d);
}

/** Number of sharps (+) or flats (-) in the key signature. */
export function keySignature(root, scaleId = 'major') {
  const maj = relativeMajorRoot(root, scaleId);
  const i = CIRCLE_OF_FIFTHS.indexOf(maj);
  return i <= 5 ? i : i - 12; // G=+1 ... B=+5, Gb=-6, Db=-5 ... F=-1 (matches keyPrefersFlats)
}

/**
 * Closely related keys around the circle of fifths.
 * -> {dominant, subdominant, relative, parallel, dominantRelative, subdominantRelative, all:[...]}
 */
export function circleNeighbors(root, scaleId = 'major') {
  const minor = isMinorScale(scaleId);
  const scale = minor ? 'minor' : 'major';
  const r = mod12(root);
  const mk = (rt, sc, label) => ({ root: mod12(rt), scale: sc, name: keyName(rt, sc), label });
  const dominant = mk(r + 7, scale, 'dominant (one sharp more)');
  const subdominant = mk(r + 5, scale, 'subdominant (one flat more)');
  const rel = relativeKey(r, scale);
  const relative = mk(rel.root, rel.scale, 'relative');
  const parallel = mk(r, minor ? 'major' : 'minor', 'parallel');
  const relDom = relativeKey(dominant.root, scale);
  const relSub = relativeKey(subdominant.root, scale);
  const dominantRelative = mk(relDom.root, relDom.scale, 'relative of dominant');
  const subdominantRelative = mk(relSub.root, relSub.scale, 'relative of subdominant');
  return { dominant, subdominant, relative, parallel, dominantRelative, subdominantRelative, all: [dominant, subdominant, relative, parallel, dominantRelative, subdominantRelative] };
}

/** Modes that share a scale with the key, useful for modal interchange (same root). */
export const PARALLEL_MODES = ['minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'harmonic-minor', 'melodic-minor', 'major', 'locrian'];
