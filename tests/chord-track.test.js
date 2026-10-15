// Chord track (src/core/chord-track.js): editing model, detection from MIDI, pad voicings / voice leading and
// non-destructive chord following (scheduler).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addChord, moveChord, removeChord, updateChord, placeChords, chordAt, chordList, normalizeChords, chordLabel,
  conformPitch, followModeFor, detectChordTrack, padChords, padVoicing, chordsToNotes, sequenceChords,
  chordDragPayload, parseChordDrag,
} from '../src/core/chord-track.js';
import { collectEvents } from '../src/audio/scheduler.js';
import { createProject, createTrack, createPattern, createNote, createClip } from '../src/core/model.js';
import { chordPitchClasses, mod12 } from '../src/theory/index.js';

const C = (root, type, beat, length = 4, bass) => ({ root, type, beat, length, ...(bass != null ? { bass } : {}) });
const pcs = (notes) => [...new Set(notes.map(mod12))].sort((a, b) => a - b);

test('chord track model: add / carve / move / resize / remove keep chords sorted and non-overlapping', () => {
  const p = createProject();
  addChord(p, C(0, 'maj', 0, 8));
  addChord(p, C(9, 'min', 8, 8));
  assert.deepEqual(chordList(p).map((c) => [c.beat, c.length, c.root]), [[0, 8, 0], [8, 8, 9]]);
  // a chord dropped inside another splits it
  addChord(p, C(5, 'maj', 2, 2));
  assert.deepEqual(chordList(p).map((c) => [c.beat, c.length, c.root]), [[0, 2, 0], [2, 2, 5], [4, 4, 0], [8, 8, 9]]);
  // moving onto a neighbour trims it
  const f = chordList(p)[1];
  moveChord(p, f.id, 7);
  assert.deepEqual(chordList(p).map((c) => [c.beat, c.length, c.root]), [[0, 2, 0], [4, 3, 0], [7, 2, 5], [9, 7, 9]]);
  updateChord(p, f.id, { type: 'maj7', length: 1 });
  assert.equal(chordList(p).find((c) => c.id === f.id).type, 'maj7');
  assert.equal(chordAt(p, 8.5), null); // gap after the shortened chord
  assert.equal(chordAt(p, 7).root, 5);
  assert.equal(chordAt(p, 3), null);
  assert.equal(chordAt(p, 0).root, 0);
  removeChord(p, f.id);
  assert.equal(chordList(p).length, 3);
  // slash bass equal to the root is dropped; invalid entries are filtered
  p.chordTrack.chords.push({ id: 'x', beat: 30, length: 2, root: 2, type: 'min', bass: 14 }, { id: 'bad', beat: 1, length: 1, root: 1, type: 'nope' });
  normalizeChords(p);
  assert.equal(chordList(p).find((c) => c.id === 'x').bass, undefined);
  assert.ok(!chordList(p).some((c) => c.id === 'bad'));
});

test('placeChords replaces the span a progression covers; labels follow the key spelling', () => {
  const p = createProject();
  addChord(p, C(0, 'maj', 0, 16));
  placeChords(p, 4, sequenceChords([C(10, 'maj'), C(3, 'maj')], 2));
  assert.deepEqual(chordList(p).map((c) => [c.beat, c.length, c.root]), [[0, 4, 0], [4, 2, 10], [6, 2, 3], [8, 8, 0]]);
  assert.equal(chordLabel({ root: 10, type: 'maj' }, { root: 5, scale: 'major' }), 'Bb');
  assert.equal(chordLabel({ root: 6, type: 'min', bass: 9 }, { root: 4, scale: 'major' }), 'F#m/A');
});

test('conformPitch: chord tones / chord scale / parallel transpose', () => {
  const key = { root: 0, scale: 'major' };
  const dm = { root: 2, type: 'min' };
  // chords: nearest D-F-A tone (ties go down)
  assert.equal(conformPitch(60, dm, key, 'chords'), 62); // C4 -> D4 (2 up beats A3, 3 down)
  assert.equal(conformPitch(63, dm, key, 'chords'), 62); // Eb4: D4 / F4 tie -> down
  assert.ok(chordPitchClasses(2, 'min').includes(mod12(conformPitch(64, dm, key, 'chords'))));
  for (let m = 48; m < 72; m++) assert.ok(chordPitchClasses(2, 'min').includes(mod12(conformPitch(m, dm, key, 'chords'))), `pitch ${m}`);
  // a chord tone is never moved
  assert.equal(conformPitch(62, dm, key, 'chords'), 62);
  // scales: key notes that fit stay (E over Dm = 9th), F# (out of key) moves
  assert.equal(conformPitch(64, dm, key, 'scales'), 64);
  assert.notEqual(mod12(conformPitch(66, dm, key, 'scales')), 6);
  // transpose: a C-major line moves with the chord root, voicing kept parallel
  const g = { root: 7, type: 'maj' };
  assert.deepEqual([60, 64, 67].map((m) => conformPitch(m, g, key, 'transpose')), [55, 59, 62]); // up a 5th folds to down a 4th
  const f = { root: 5, type: 'maj' };
  assert.deepEqual([60, 64, 67].map((m) => conformPitch(m, f, key, 'transpose')), [65, 69, 72]);
  // off / no chord: untouched
  assert.equal(conformPitch(61, null, key, 'chords'), 61);
  assert.equal(conformPitch(61, dm, key, 'off'), 61);
});

test('followModeFor: clip overrides track; drum and non-instrument tracks never follow', () => {
  const t = createTrack({ instrument: { type: 'synth', params: {} } });
  t.chordFollow = 'scales';
  assert.equal(followModeFor(t, {}), 'scales');
  assert.equal(followModeFor(t, { chordFollow: 'off' }), 'off');
  assert.equal(followModeFor({ ...t, chordFollow: null }, { chordFollow: 'chords' }), 'chords');
  assert.equal(followModeFor({ ...t, instrument: { type: 'drums' } }, { chordFollow: 'chords' }), 'off');
  assert.equal(followModeFor(createTrack({ type: 'audio' }), { chordFollow: 'chords' }), 'off');
  assert.equal(followModeFor({ ...t, chordFollow: 'bogus' }, {}), 'off');
});

function songWithBass() {
  const p = createProject();
  p.mode = 'song';
  const t = createTrack({ name: 'Bass', instrument: { type: 'synth', params: {} } });
  const pat = createPattern(t.id, { length: 4, notes: [createNote(48, 0, 1), createNote(52, 1, 1), createNote(55, 2, 1), createNote(53, 3, 1)] });
  p.patterns[pat.id] = pat;
  p.tracks = [t];
  p.clips = [createClip(t.id, { patternId: pat.id, start: 0, length: 16 })];
  return { p, t, pat };
}

test('chord following in the scheduler: notes conform at their onset, the pattern is untouched, clip override wins', () => {
  const { p, t, pat } = songWithBass();
  placeChords(p, 0, sequenceChords([C(0, 'maj'), C(9, 'min'), C(5, 'maj'), C(7, 'maj')], 4));
  const before = JSON.stringify(pat);
  const byBeat = (evs) => evs.filter((e) => e.type === 'note').map((e) => [e.beat, e.pitch]).sort((a, b) => a[0] - b[0]);
  const pitchesAt = () => byBeat(collectEvents(p, 0, 16, { mode: 'song' }));
  const plain = pitchesAt();
  assert.deepEqual(plain.slice(0, 4).map((x) => x[1]), [48, 52, 55, 53]);
  t.chordFollow = 'chords';
  const conformed = pitchesAt();
  for (const [beat, pitch] of conformed) {
    const c = chordAt(p, beat);
    assert.ok(chordPitchClasses(c.root, c.type).includes(mod12(pitch)), `beat ${beat}: ${pitch} over ${c.root}/${c.type}`);
  }
  assert.equal(JSON.stringify(pat), before, 'non-destructive');
  // windows are independent: the same result in small windows
  const chunked = [];
  for (let b = 0; b < 16; b += 0.75) chunked.push(...byBeat(collectEvents(p, b, b + 0.75, { mode: 'song' })));
  assert.deepEqual(chunked, conformed);
  p.clips[0].chordFollow = 'off';
  assert.deepEqual(pitchesAt(), plain);
  // pattern mode never follows
  p.clips[0].chordFollow = 'chords';
  assert.deepEqual(collectEvents(p, 0, 4, { mode: 'pattern' }).filter((e) => e.type === 'note').map((e) => e.pitch), []);
});

test('detectChordTrack: finds the chords of a block-chord part (incl. inversions as slash chords) and merges repeats', () => {
  const p = createProject();
  p.mode = 'song';
  const t = createTrack({ name: 'Keys', instrument: { type: 'synth', params: {} } });
  const drums = createTrack({ name: 'Drums', instrument: { type: 'drums', params: {} } });
  const chords = [[60, 64, 67], [60, 64, 69], [60, 65, 69], [55, 59, 62, 65]]; // C, Am/C, F/C, G7
  const notes = [];
  chords.forEach((ch, i) => { for (const m of ch) { notes.push(createNote(m, i * 4, 2)); notes.push(createNote(m, i * 4 + 2, 2)); } });
  const pat = createPattern(t.id, { length: 16, notes });
  const dpat = createPattern(drums.id, { length: 4, notes: [createNote(36, 0), createNote(38, 1), createNote(42, 0.5), createNote(46, 1.5)] });
  p.patterns[pat.id] = pat;
  p.patterns[dpat.id] = dpat;
  p.tracks = [t, drums];
  p.clips = [createClip(t.id, { patternId: pat.id, start: 0, length: 16 }), createClip(drums.id, { patternId: dpat.id, start: 0, length: 16 })];
  const found = detectChordTrack(p);
  assert.deepEqual(found.map((c) => [c.beat, c.length, c.root, c.type, c.bass]), [
    [0, 4, 0, 'maj', undefined], [4, 4, 9, 'min', 0], [8, 4, 5, 'maj', 0], [12, 4, 7, '7', undefined],
  ]);
  assert.deepEqual(detectChordTrack({ ...p, clips: [] }), []);
});

test('pads: diatonic rows in the key, inversions, voicings, voice leading', () => {
  const rows = padChords({ root: 9, scale: 'minor' });
  assert.deepEqual(rows.map((r) => r.id), ['triads', 'sevenths', 'colour', 'borrowed']);
  assert.deepEqual(rows[0].chords.map((c) => c.label), ['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
  assert.equal(rows[1].chords[0].label, 'Am7');
  assert.ok(rows[3].chords.some((c) => c.label === 'E'), 'A major borrowed chords include E (the major V)');
  // every colour chord stays in key
  const keyPcs = new Set(rows[0].chords.flatMap((c) => chordPitchClasses(c.root, c.type)));
  for (const c of rows[2].chords) for (const pc of chordPitchClasses(c.root, c.type)) assert.ok(keyPcs.has(pc), c.label);

  const cmaj = { root: 0, type: 'maj' };
  assert.deepEqual(padVoicing(cmaj), [60, 64, 67]);
  assert.deepEqual(padVoicing(cmaj, { inversion: 1 }), [64, 67, 72]);
  assert.deepEqual(padVoicing(cmaj, { inversion: 2 }), [67, 72, 76]);
  assert.deepEqual(pcs(padVoicing(cmaj, { voicing: 'open' })), [0, 4, 7]);
  assert.deepEqual(padVoicing({ root: 0, type: 'maj', bass: 4 }).slice(0, 1).map(mod12), [4]);
  // voice leading: C -> F -> G7 -> C moves each voice by small steps
  const prog = [cmaj, { root: 5, type: 'maj' }, { root: 7, type: '7' }, cmaj];
  let prev = padVoicing(prog[0]);
  for (const c of prog.slice(1)) {
    const v = padVoicing(c, { prev, voiceLeading: true });
    assert.deepEqual(pcs(v).filter((x) => chordPitchClasses(c.root, c.type).includes(x)).length >= 3, true);
    const moves = v.slice(0, prev.length).map((m, i) => Math.abs(m - prev[i]));
    assert.ok(Math.max(...moves) <= 5, `smooth: ${prev} -> ${v}`);
    prev = v;
  }
});

test('chordsToNotes + drag payload round trip', () => {
  const seq = sequenceChords([{ root: 0, type: 'maj' }, { root: 7, type: 'maj' }], 2);
  const notes = chordsToNotes(seq, 4, { voicing: 'close' });
  assert.deepEqual([...new Set(notes.map((n) => n.start))], [4, 6]);
  assert.ok(notes.every((n) => n.dur === 2));
  const payload = parseChordDrag(chordDragPayload(seq, { voicing: 'drop2', voiceLeading: true, inversion: 1 }));
  assert.equal(payload.voicing, 'drop2');
  assert.equal(payload.voiceLeading, true);
  assert.deepEqual(payload.chords.map((c) => [c.root, c.type, c.beat, c.length]), [[0, 'maj', 0, 2], [7, 'maj', 2, 2]]);
  assert.equal(parseChordDrag('nope'), null);
  assert.equal(parseChordDrag('{"chords":[{"root":0,"type":"zzz"}]}'), null);
});
