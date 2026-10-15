// Chord track / chord pad actions shared by the chord lane, the chord pads panel, the Arrange view and the piano roll.
import { toast } from './components.js';
import { createClip, createPattern, createNote, beatsPerBar } from '../core/model.js';
import { placeChords, chordsToNotes, detectChordTrack, chordList, chordLabel, padVoicing, DT_CHORDS, parseChordDrag } from '../core/chord-track.js';

export { DT_CHORDS, parseChordDrag };

const melodic = (t) => t && t.type === 'instrument' && t.instrument?.type !== 'drums';

/** The track chords are auditioned on: the selected melodic track, else the first melodic track (or null). */
export function auditionTrack(app) {
  const p = app.store.get();
  const sel = p.tracks.find((t) => t.id === app.ui.get('selectedTrackId'));
  if (melodic(sel)) return sel;
  return p.tracks.find((t) => melodic(t) && (t.role === 'chords' || t.role === 'pad' || t.role === 'keys')) || p.tracks.find(melodic) || null;
}

let held = null;
/** Play MIDI notes briefly on the audition track (ms), replacing the chord that is still sounding. */
export async function auditionNotes(app, notes, ms = 650) {
  const t = auditionTrack(app);
  if (!t) { toast('Add an instrument track (synth, keys, pad…) to hear chords', { level: 'warn' }); return; }
  try { await app.actions.ensureAudio?.(); } catch { return; }
  if (held) { clearTimeout(held.timer); for (const m of held.notes) { try { app.engine.noteOff(held.trackId, m); } catch { /* */ } } }
  for (const m of notes) { try { app.engine.noteOn(t.id, m, 0.72); } catch { /* */ } }
  const h = { trackId: t.id, notes, timer: 0 };
  h.timer = setTimeout(() => { for (const m of notes) { try { app.engine.noteOff(t.id, m); } catch { /* */ } } if (held === h) held = null; }, ms);
  held = h;
}

export const auditionChord = (app, chord, opts = {}) => auditionNotes(app, padVoicing(chord, opts), opts.ms);

/** Put a dropped chord / progression on the chord track at `beat`. */
export function dropOnChordTrack(app, payload, beat) {
  const p = app.store.get();
  app.store.transact('Place chords', (pp) => { placeChords(pp, beat, payload.chords); });
  const names = payload.chords.map((c) => chordLabel(c, p.key)).join(' ');
  app.setStatus?.(`Chord track: ${names} at bar ${Math.floor(beat / beatsPerBar(p)) + 1}`);
}

/**
 * Write a dropped chord / progression as notes. Onto a pattern clip: into its pattern at the drop beat (the
 * pattern grows when needed — every clip that shares it gets the chords). Onto an empty spot of a melodic track: a
 * new pattern + clip there. -> true when something was written.
 */
export function dropChordsAsNotes(app, payload, { track, clip = null, beat }) {
  const p = app.store.get();
  if (!melodic(track)) { toast('Drop chords on a synth / keys track (not drums, audio or code)', { level: 'warn' }); return false; }
  const span = payload.chords.reduce((m, c) => Math.max(m, c.beat + c.length), 0);
  const opts = { voicing: payload.voicing, inversion: payload.inversion, voiceLeading: payload.voiceLeading, octave: payload.octave };
  if (clip && clip.type === 'pattern' && p.patterns[clip.patternId]) {
    const pat = p.patterns[clip.patternId];
    const rel = Math.max(0, beat - clip.start + (clip.offset || 0));
    const at = pat.length > 0 && rel >= pat.length ? rel % pat.length : rel; // a clip loops its pattern
    const notes = chordsToNotes(payload.chords, at, opts);
    app.store.transact('Drop chords into clip', (pp) => {
      const pt = pp.patterns[pat.id];
      for (const n of notes) pt.notes.push(createNote(n.pitch, n.start, n.dur, n.vel));
      const bpb = beatsPerBar(pp);
      if (at + span > pt.length + 1e-6) pt.length = Math.ceil((at + span) / bpb - 1e-6) * bpb;
      const c = pp.clips.find((x) => x.id === clip.id);
      if (c && beat + span > c.start + c.length + 1e-6) c.length = Math.ceil((beat + span - c.start) / bpb - 1e-6) * bpb;
    });
    return true;
  }
  const bpb = beatsPerBar(p);
  const len = Math.max(bpb, Math.ceil(span / bpb - 1e-6) * bpb);
  const notes = chordsToNotes(payload.chords, 0, opts);
  app.store.transact('Drop chords as clip', (pp) => {
    const pat = createPattern(track.id, { name: 'Chords', length: len, notes: notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
    pp.patterns[pat.id] = pat;
    pp.clips.push(createClip(track.id, { patternId: pat.id, start: beat, length: len }));
    const t = pp.tracks.find((x) => x.id === track.id);
    if (t && !t.activePatternId) t.activePatternId = pat.id;
    if (pp.mode !== 'song') pp.mode = 'song';
  });
  return true;
}

/** Detect the chord track from the arrangement's MIDI (replaces the chord track). -> number of chords. */
export function detectChordsFromMidi(app, opts = {}) {
  const p = app.store.get();
  const found = detectChordTrack(p, opts);
  if (!found.length) { toast('No chords found: the arrangement needs MIDI clips on melodic tracks (song mode)', { level: 'warn' }); return 0; }
  if (chordList(p).length && opts.confirm === false) return 0;
  app.store.transact('Detect chord track', (pp) => { pp.chordTrack = { chords: [] }; placeChords(pp, 0, found); });
  toast(`Chord track: ${found.length} chord${found.length === 1 ? '' : 's'} detected`, { level: 'success' });
  return found.length;
}

/** Set the chord-follow mode of a track (or of clips, when clipIds are given). */
export function setChordFollow(app, { trackId = null, clipIds = null, mode }) {
  app.store.transact('Chord follow', (pp) => {
    if (clipIds?.length) {
      for (const c of pp.clips) if (clipIds.includes(c.id)) { if (mode == null) delete c.chordFollow; else c.chordFollow = mode; }
    } else {
      const t = pp.tracks.find((x) => x.id === trackId);
      if (t) { if (!mode || mode === 'off') delete t.chordFollow; else t.chordFollow = mode; }
    }
  });
}
