// Project chord track (chord symbols over time) + chord following for MIDI tracks / clips + chord pads helpers.
// Pure (Node-safe): the Arrange chord lane (src/ui/chord-lane.js), the chord pads (src/ui/chord-pads.js) and the
// scheduler (non-destructive conforming at playback / render) all use these.
//
// Model (plain JSON, undoable with the project):
//   project.chordTrack = { chords: [{ id, beat, length, root (pc), type (CHORD_TYPES id), bass? (pc) }] }
//     chords are kept sorted and non-overlapping (adding / moving one trims the chord it lands in).
//   track.chordFollow  = 'off' | 'chords' | 'scales' | 'transpose'   (instrument tracks, default off)
//   clip.chordFollow   = same values, overrides the track ('off' excludes one clip of a following track)
//
// Follow modes (applied to note events at their onset beat; the pattern itself is never changed):
//   chords     – every note moves to the nearest chord tone
//   scales     – nearest note of the chord-scale (chord tones + tensions that fit the project key)
//   transpose  – the part is read as written over the key's tonic: shifted by the chord root's distance from the
//                tonic (−5..+6 semitones, voicing kept parallel), then fitted to the chord-scale
import { uid } from './util.js';
import { mod12 } from '../theory/notes.js';
import { CHORD_TYPES, getChordType, chordName, chordNotes, detectChord, chordPitchClasses } from '../theory/chords.js';
import { chordScale, fitToChord, voiceLead } from '../theory/voicing.js';
import { diatonicChords, keyPrefersFlats } from '../theory/keys.js';
import { isMinorScale } from '../theory/scales.js';

export const CHORD_FOLLOW_MODES = [
  { value: 'off', label: 'Off', description: 'Notes play as written' },
  { value: 'chords', label: 'Chord tones', description: 'Every note moves to the nearest tone of the current chord' },
  { value: 'scales', label: 'Chord scale', description: 'Notes snap to the chord-scale: chord tones plus tensions that fit the key' },
  { value: 'transpose', label: 'Transpose', description: 'The part follows the chord root in parallel (written over the tonic), then fits the chord' },
];
const MODES = new Set(CHORD_FOLLOW_MODES.map((m) => m.value));
export const CHORD_VOICINGS = [
  { value: 'close', label: 'Close' }, { value: 'open', label: 'Open' }, { value: 'drop2', label: 'Drop 2' },
  { value: 'drop3', label: 'Drop 3' }, { value: 'spread', label: 'Spread' }, { value: 'shell', label: 'Shell' },
];
const EPS = 1e-6;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// ------------------------------------------------------------------ model
/** The chord list (sorted by beat), [] when the project has no chord track. */
export function chordList(project) {
  const c = project?.chordTrack?.chords;
  return Array.isArray(c) ? c : [];
}

function ensure(project) {
  if (!project.chordTrack || typeof project.chordTrack !== 'object') project.chordTrack = { chords: [] };
  if (!Array.isArray(project.chordTrack.chords)) project.chordTrack.chords = [];
  return project.chordTrack.chords;
}

const validChord = (c) => c && Number.isFinite(c.root) && CHORD_TYPES[c.type];

/** Sort, drop invalid / zero-length chords and trim overlaps (a later chord cuts the one before it). Mutates. */
export function normalizeChords(project) {
  const list = ensure(project).filter((c) => validChord(c) && Number.isFinite(c.beat) && c.length > EPS);
  list.sort((a, b) => a.beat - b.beat);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    c.beat = r4(Math.max(0, c.beat));
    c.root = mod12(c.root);
    if (c.bass != null) { c.bass = mod12(c.bass); if (c.bass === c.root) delete c.bass; }
    const next = list[i + 1];
    if (next && c.beat + c.length > next.beat + EPS) c.length = r4(Math.max(0, next.beat - c.beat));
  }
  project.chordTrack.chords = list.filter((c) => c.length > EPS);
  return project.chordTrack.chords;
}

/**
 * Add a chord {beat, length, root, type, bass?} (mutates; call inside store.transact). A chord already at that
 * spot is cut (or replaced when it starts at the same beat). -> the new chord.
 */
export function addChord(project, chord) {
  const list = ensure(project);
  const c = { id: chord.id || uid('chd'), beat: Math.max(0, chord.beat || 0), length: chord.length > 0 ? chord.length : 4, root: mod12(chord.root ?? 0), type: CHORD_TYPES[chord.type] ? chord.type : 'maj' };
  if (chord.bass != null && mod12(chord.bass) !== c.root) c.bass = mod12(chord.bass);
  carve(list, c.beat, c.beat + c.length, null);
  project.chordTrack.chords.push(c);
  normalizeChords(project);
  return project.chordTrack.chords.find((x) => x.id === c.id) || null;
}

/** Remove the parts of chords (other than `keepId`) inside [a, b): split / trim / delete as needed. */
function carve(list, a, b, keepId) {
  const add = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.id === keepId) continue;
    const cs = c.beat, ce = c.beat + c.length;
    if (ce <= a + EPS || cs >= b - EPS) continue;
    if (cs >= a - EPS && ce <= b + EPS) { list.splice(i, 1); continue; }
    if (cs < a - EPS && ce > b + EPS) { // the new chord sits inside: split around it
      add.push({ ...c, id: uid('chd'), beat: r4(b), length: r4(ce - b) });
      c.length = r4(a - cs);
    } else if (cs < a - EPS) c.length = r4(a - cs);
    else { c.length = r4(ce - b); c.beat = r4(b); }
  }
  list.push(...add);
}

/** Change fields of a chord (root / type / bass / length). Mutates. */
export function updateChord(project, id, patch) {
  const c = chordList(project).find((x) => x.id === id);
  if (!c) return null;
  if (patch.root != null) c.root = mod12(patch.root);
  if (patch.type && CHORD_TYPES[patch.type]) c.type = patch.type;
  if ('bass' in patch) { if (patch.bass == null || mod12(patch.bass) === c.root) delete c.bass; else c.bass = mod12(patch.bass); }
  if (patch.length > 0) { c.length = r4(patch.length); carve(project.chordTrack.chords, c.beat, c.beat + c.length, c.id); }
  normalizeChords(project);
  return c;
}

/** Move a chord to `beat` (it cuts whatever it lands on). Mutates. */
export function moveChord(project, id, beat) {
  const c = chordList(project).find((x) => x.id === id);
  if (!c) return null;
  c.beat = r4(Math.max(0, beat));
  carve(project.chordTrack.chords, c.beat, c.beat + c.length, c.id);
  normalizeChords(project);
  return c;
}

export function removeChord(project, id) {
  if (!project.chordTrack) return;
  project.chordTrack.chords = chordList(project).filter((c) => c.id !== id);
}

/** Replace every chord in [a, b) with `chords` (relative beats), e.g. a dropped progression. Mutates. -> added. */
export function placeChords(project, at, chords) {
  const list = ensure(project);
  const end = chords.reduce((m, c) => Math.max(m, (c.beat || 0) + (c.length || 4)), 0);
  carve(list, at, at + end, null);
  const added = chords.filter(validChord).map((c) => {
    const n = { id: uid('chd'), beat: r4(at + (c.beat || 0)), length: r4(c.length || 4), root: mod12(c.root), type: c.type };
    if (c.bass != null && mod12(c.bass) !== n.root) n.bass = mod12(c.bass);
    return n;
  });
  project.chordTrack.chords.push(...added);
  normalizeChords(project);
  return added;
}

/** The chord sounding at `beat` (start inclusive, end exclusive), or null. */
export function chordAt(project, beat) {
  const list = chordList(project);
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].beat <= beat + EPS) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans < 0) return null;
  const c = list[ans];
  return beat < c.beat + c.length - EPS ? c : null;
}

/** Display name of a chord in the project key's spelling ('Bb', 'F#m7', 'C/E'). */
export function chordLabel(chord, key = null) {
  if (!chord) return '';
  const flats = key ? keyPrefersFlats(key.root ?? 0, key.scale || 'major') : 'common';
  return chordName(chord, { preferFlats: flats });
}

// ------------------------------------------------------------------ following
/** The follow mode of a clip of a track: clip override, else the track's, else 'off'. Drum tracks never follow. */
export function followModeFor(track, clip = null) {
  if (!track || track.type !== 'instrument' || track.instrument?.type === 'drums') return 'off';
  const m = clip?.chordFollow && MODES.has(clip.chordFollow) ? clip.chordFollow : track.chordFollow;
  return MODES.has(m) ? m : 'off';
}

const csCache = new WeakMap();
function scaleOf(chord, key) {
  let byKey = csCache.get(chord);
  const k = `${key.root}|${key.scale}|${chord.root}|${chord.type}|${chord.bass}`;
  if (byKey && byKey.k === k) return byKey.cs;
  const cs = chordScale(chord, key.root ?? 0, key.scale || 'major');
  csCache.set(chord, { k, cs });
  return cs;
}

/**
 * Conform one MIDI pitch to a chord. key = project.key ({root, scale}). -> MIDI pitch (0..127).
 * Ties move down (keeps parts from creeping upward).
 */
export function conformPitch(pitch, chord, key = { root: 0, scale: 'major' }, mode = 'chords') {
  if (!chord || mode === 'off' || !Number.isFinite(pitch)) return pitch;
  const cs = scaleOf(chord, key);
  let p = Math.round(pitch);
  let allow = mode === 'chords' ? 'tones' : 'tensions';
  if (mode === 'transpose') {
    let shift = mod12(chord.root - (key.root ?? 0));
    if (shift > 6) shift -= 12;
    p += shift;
    allow = 'tensions';
  }
  return Math.max(0, Math.min(127, fitToChord(p, cs, { allow, dir: -1 })));
}

/**
 * Conform collected note events (scheduler.collectEvents) of a following track in place. Each event uses the chord
 * at its own onset; notes before the first chord / in gaps play as written. Events of other tracks are untouched.
 */
export function conformNoteEvents(project, events, track, clip, from = 0) {
  const mode = followModeFor(track, clip);
  if (mode === 'off' || !chordList(project).length) return events;
  const key = project.key || { root: 0, scale: 'major' };
  for (let i = from; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'note' || ev.trackId !== track.id) continue;
    const c = chordAt(project, ev.beat);
    if (c) ev.pitch = conformPitch(ev.pitch, c, key, mode);
  }
  return events;
}

// ------------------------------------------------------------------ detection
/**
 * Detect a chord track from the MIDI clips of the arrangement (song mode). The timeline is cut into `step`-beat
 * windows (default: half a bar); each window's duration-weighted pitch-class profile (bass weighted up) is matched
 * with theory/chords.js detectChord; equal neighbours merge and windows with too little harmony inherit the chord
 * before them. opts: { trackIds (default every non-drum instrument track), step, start, end }
 * -> [{ beat, length, root, type, bass? }]
 */
export function detectChordTrack(project, opts = {}) {
  const bpb = (project.timeSig?.[0] || 4) * (4 / (project.timeSig?.[1] || 4));
  const step = opts.step || bpb / 2;
  const tracks = project.tracks.filter((t) => t.type === 'instrument' && t.instrument?.type !== 'drums' && (!opts.trackIds || opts.trackIds.includes(t.id)));
  const ids = new Set(tracks.map((t) => t.id));
  const notes = []; // absolute {start, end, pitch, vel}
  for (const clip of project.clips || []) {
    if (!ids.has(clip.trackId) || clip.type === 'audio') continue;
    const pat = project.patterns?.[clip.patternId];
    if (!pat || !(pat.length > 0)) continue;
    const off = clip.offset || 0;
    for (let rep = Math.floor(off / pat.length) * pat.length; rep < off + clip.length; rep += pat.length) {
      for (const n of pat.notes || []) {
        const s = clip.start + rep + n.start - off;
        const e = Math.min(s + (n.dur || 0.25), clip.start + clip.length);
        if (e <= clip.start + EPS || s >= clip.start + clip.length - EPS) continue;
        notes.push({ start: Math.max(s, clip.start), end: e, pitch: n.pitch, vel: n.vel ?? 0.8 });
      }
    }
  }
  if (!notes.length) return [];
  const start = opts.start ?? Math.floor(Math.min(...notes.map((n) => n.start)) / step) * step;
  const end = opts.end ?? Math.max(...notes.map((n) => n.end));
  const out = [];
  for (let a = start; a < end - EPS; a += step) {
    const b = a + step;
    const w = new Array(12).fill(0);
    let lowest = Infinity, total = 0;
    for (const n of notes) {
      const ov = Math.min(b, n.end) - Math.max(a, n.start);
      if (ov <= EPS) continue;
      const wt = ov * (0.5 + n.vel);
      w[mod12(n.pitch)] += wt;
      total += wt;
      if (n.pitch < lowest) lowest = n.pitch;
    }
    let chord = null;
    if (total > 0) {
      const max = Math.max(...w);
      // the pitch classes that carry the window (≥ 22% of the strongest) + the bass
      const pcs = w.map((v, pc) => (v >= max * 0.22 ? pc : -1)).filter((pc) => pc >= 0);
      const pitches = pcs.map((pc) => 60 + pc);
      if (Number.isFinite(lowest)) pitches.push(lowest - 24);
      const d = pcs.length >= 2 ? detectChord(pitches) : null;
      if (d) {
        chord = { root: d.root, type: d.type };
        if (Number.isFinite(lowest) && mod12(lowest) !== d.root && chordPitchClasses(d.root, d.type).includes(mod12(lowest))) chord.bass = mod12(lowest);
      }
    }
    const prev = out[out.length - 1];
    if (!chord) { if (prev && Math.abs(prev.beat + prev.length - a) < EPS) prev.length = r4(prev.length + step); continue; }
    if (prev && Math.abs(prev.beat + prev.length - a) < EPS && prev.root === chord.root && prev.type === chord.type && prev.bass === chord.bass) prev.length = r4(prev.length + step);
    else out.push({ beat: r4(a), length: r4(step), ...chord });
  }
  return out;
}

// ------------------------------------------------------------------ pads / voicing
/**
 * The chord pad grid for a key: rows of chord objects {root, type, label, roman?, row}.
 *   Triads, Sevenths (diatonic), Colour (sus2 / sus4 / add9 on the diatonic roots, where they stay in key) and
 *   Borrowed (the parallel mode's chords that are not in the key).
 */
export function padChords(key = { root: 0, scale: 'major' }) {
  const root = key.root ?? 0, scale = key.scale || 'major';
  const tri = diatonicChords(root, scale);
  const sev = diatonicChords(root, scale, { sevenths: true });
  const minor = isMinorScale(scale);
  const parallel = diatonicChords(root, minor ? 'major' : 'minor');
  const inKey = new Set(tri.flatMap((c) => chordPitchClasses(c.root, c.type)));
  const fits = (c) => chordPitchClasses(c.root, c.type).every((pc) => inKey.has(pc));
  const colour = tri.map((c) => {
    for (const type of c.type === 'dim' ? ['m7b5'] : c.type === 'min' ? ['madd9', 'sus4'] : ['sus2', 'add9', 'sus4']) {
      const x = { root: c.root, type };
      if (fits(x)) return x;
    }
    return { root: c.root, type: c.type === 'maj' ? '6' : c.type === 'min' ? 'm6' : c.type };
  });
  const borrowed = parallel.filter((c) => !tri.some((t) => t.root === c.root && t.type === c.type));
  const mk = (row) => (c) => ({ root: c.root, type: c.type, roman: c.roman, row, label: chordLabel(c, key) });
  return [
    { id: 'triads', label: 'Triads', chords: tri.map(mk('triads')) },
    { id: 'sevenths', label: 'Sevenths', chords: sev.map(mk('sevenths')) },
    { id: 'colour', label: 'Colour', chords: colour.map(mk('colour')) },
    { id: 'borrowed', label: minor ? 'From major' : 'From minor', chords: borrowed.slice(0, 7).map(mk('borrowed')) },
  ];
}

/**
 * MIDI notes for a pad press. opts: { octave (root octave, default 4 → around C4), inversion, voicing (CHORD_VOICINGS),
 * prev (MIDI[] of the chord before: voice leading when opts.voiceLeading), voiceLeading, range = [48, 79] }
 */
export function padVoicing(chord, opts = {}) {
  if (!chord) return [];
  const range = opts.range || [48, 79];
  if (opts.voiceLeading && opts.prev?.length) {
    const pcs = chordPitchClasses(chord.root, chord.type);
    const ordered = [mod12(chord.root), ...pcs.filter((p) => p !== mod12(chord.root))];
    const v = voiceLead(opts.prev, ordered, range, { voices: Math.max(ordered.length, Math.min(opts.prev.length, ordered.length + 1)) });
    return withBass(v, chord);
  }
  const octave = opts.octave ?? 4;
  let rootMidi = (octave + 1) * 12 + mod12(chord.root);
  if (rootMidi > 66) rootMidi -= 12;
  const n = getChordType(chord.type).intervals.length;
  const inv = Math.max(0, Math.min(n - 1, opts.inversion || 0));
  const v = chordNotes(rootMidi, chord.type, { inversion: inv, voicing: opts.voicing || 'close' });
  return withBass(v, chord);
}

/** Slash chords: the bass note under the voicing (an octave below its lowest note at most). */
function withBass(v, chord) {
  if (chord.bass == null || !v.length) return v;
  const lo = Math.min(...v);
  let b = lo - 12 + mod12(chord.bass - (lo - 12));
  if (b >= lo) b -= 12;
  return [b, ...v.filter((x) => mod12(x) !== mod12(chord.bass) || x > lo + 11)].sort((a, c) => a - c);
}

/**
 * Notes (pattern-relative) for chords dropped into a MIDI clip: [{root, type, bass?, beat, length}] -> note specs
 * [{pitch, start, dur, vel}], voiced with `opts` (padVoicing; voice-led chord to chord when opts.voiceLeading).
 */
export function chordsToNotes(chords, at = 0, opts = {}) {
  const out = [];
  let prev = opts.prev || null;
  for (const c of chords) {
    const v = padVoicing(c, { ...opts, prev });
    const start = r4(at + (c.beat || 0));
    const dur = r4(Math.max(0.0625, (c.length || 4) - (opts.gap ?? 0)));
    for (const pitch of v) out.push({ pitch, start, dur, vel: opts.vel ?? 0.78 });
    prev = v;
  }
  return out;
}

/** Chords of a progression laid out back to back, `length` beats each (pads progression strip). */
export function sequenceChords(chords, length = 4) {
  return chords.map((c, i) => ({ root: c.root, type: c.type, ...(c.bass != null ? { bass: c.bass } : {}), beat: i * length, length }));
}

/** Serialisation of a chord / progression for drag and drop (application/x-daw3-chords). */
export const DT_CHORDS = 'application/x-daw3-chords';
export function chordDragPayload(chords, opts = {}) {
  return JSON.stringify({ chords: chords.map((c) => ({ root: c.root, type: c.type, ...(c.bass != null ? { bass: c.bass } : {}), beat: c.beat || 0, length: c.length || 4 })), voicing: opts.voicing || 'close', inversion: opts.inversion || 0, voiceLeading: !!opts.voiceLeading, octave: opts.octave ?? 4 });
}
export function parseChordDrag(text) {
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j?.chords)) return null;
    const chords = j.chords.filter(validChord).map((c) => ({ root: mod12(c.root), type: c.type, ...(c.bass != null ? { bass: mod12(c.bass) } : {}), beat: Math.max(0, +c.beat || 0), length: c.length > 0 ? +c.length : 4 }));
    return chords.length ? { chords, voicing: j.voicing || 'close', inversion: j.inversion | 0, voiceLeading: !!j.voiceLeading, octave: Number.isFinite(j.octave) ? j.octave : 4 } : null;
  } catch { return null; }
}
