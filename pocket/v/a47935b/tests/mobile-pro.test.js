// Pocket pro editing: cross-track clip drops, multi-select ops (clips + notes), Mix strip reorder / folders / badges,
// take sections, tempo / meter lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createTrack, createPattern, createClip, createNote } from '../src/core/model.js';
import {
  canDrop, laneShiftOk, dropLanes, resolveLaneShift, clipOrigins, clampShift, moveClips, fixOwnership, clipsInBox, clipsInTrack,
  clipsInRange, sectionAt, toggleSel, duplicateClips, deleteClips, TOP_H,
} from '../src/mobile/arrange-core.js';
import { notesInBox, noteOrigins, moveNotes, transposeNotes, quantizeNotes, setVelocity, duplicateNotes, deleteNotes } from '../src/mobile/roll-core.js';
import { mixStrips, visibleStripIds, reorderVisible, folderAfterMove, channelBadges, lufsReadout, fmtLu } from '../src/mobile/mix-core.js';
import { createFolder, createGroup, createVca, setTrackFolder } from '../src/core/mixer-model.js';
import { takeSections, takeSummary, tempoRows, meterRows } from '../src/mobile/pro-core.js';
import { createTake, addRecordedTakes, setCompRange } from '../src/record/takes.js';
import { setTempoPoint, setMeter } from '../src/time/tempo-edit.js';

function song() {
  const p = createProject();
  const bass = createTrack({ name: 'Bass' });
  const lead = createTrack({ name: 'Lead' });
  const drums = createTrack({ name: 'Drums', instrument: { type: 'drums', preset: 'tr808', params: {} } });
  const mic = createTrack({ name: 'Mic', type: 'audio' });
  const keys = createTrack({ name: 'Keys' });
  p.tracks.push(bass, lead, drums, mic, keys);
  const pb = createPattern(bass.id, { name: 'B', length: 4, notes: [createNote(40, 0, 1)] });
  const pd = createPattern(drums.id, { name: 'D', length: 4, notes: [createNote(36, 0, 0.25)] });
  p.patterns[pb.id] = pb; p.patterns[pd.id] = pd;
  bass.activePatternId = pb.id; drums.activePatternId = pd.id;
  const cb = createClip(bass.id, { patternId: pb.id, start: 0, length: 4 });
  const cb2 = createClip(bass.id, { patternId: pb.id, start: 4, length: 4 });
  const cd = createClip(drums.id, { patternId: pd.id, start: 0, length: 8 });
  const ca = { ...createClip(mic.id, { start: 2, length: 4 }), type: 'audio', sampleId: 'smp1', patternId: null };
  p.clips.push(cb, cb2, cd, ca);
  return { p, bass, lead, drums, mic, keys, pb, pd, cb, cb2, cd, ca };
}

test('cross-track drop rules: pattern → same-kind instrument, audio → audio, frozen tracks refuse', () => {
  const { p, bass, lead, drums, mic, keys, cb, cd, ca } = song();
  assert.equal(canDrop(cb, bass, lead), true);
  assert.equal(canDrop(cb, bass, drums), false, 'melodic pattern not onto drums');
  assert.equal(canDrop(cd, drums, bass), false, 'drum pattern not onto a melodic track');
  assert.equal(canDrop(cb, bass, mic), false);
  assert.equal(canDrop(ca, mic, bass), false);
  const mic2 = createTrack({ name: 'Mic 2', type: 'audio' });
  assert.equal(canDrop(ca, mic, mic2), true);
  assert.equal(canDrop(cb, bass, bass), true, 'own lane always ok');
  assert.equal(canDrop(cb, bass, { ...keys, frozen: { sampleId: 's' } }), false);
  assert.equal(canDrop(cb, bass, null), false);
  // lane shifts for a selection: bass (0) → lead (1) ok, → drums (2) not, keys (4) ok
  assert.equal(laneShiftOk(p, [cb.id], 1), true);
  assert.equal(laneShiftOk(p, [cb.id], 2), false);
  assert.deepEqual([...dropLanes(p, [cb.id], cb.id)].sort(), [0, 1, 4]);
  assert.deepEqual([...dropLanes(p, [ca.id], ca.id)], [3]);
  // mixed selection (bass + drums): only shifts valid for both
  assert.equal(laneShiftOk(p, [cb.id, cd.id], 1), false);
  assert.equal(resolveLaneShift(p, [cb.id], 2, 1), 1, 'invalid lane keeps the last valid one');
  assert.equal(resolveLaneShift(p, [cb.id], 2, 0), 0);
  assert.equal(resolveLaneShift(p, [cb.id], 4, 1), 4);
});

test('moving a pattern clip to another track re-homes or copies its pattern (undoable data, no shared edits)', () => {
  const { p, bass, lead, keys, pb, cb, cb2 } = song();
  const orig = clipOrigins(p, [cb.id]);
  assert.equal(clampShift(orig, -3), 0, 'never before 0');
  moveClips(p, orig, 8, 1);
  assert.equal(cb.trackId, lead.id);
  assert.equal(cb.start, 8);
  fixOwnership(p, [cb.id]);
  // bass still uses pattern B (cb2 + active) → the moved clip gets a copy owned by Lead
  assert.notEqual(cb.patternId, pb.id);
  const np = p.patterns[cb.patternId];
  assert.equal(np.trackId, lead.id);
  assert.equal(np.notes.length, 1);
  assert.notEqual(np.notes[0].id, pb.notes[0].id);
  assert.equal(lead.activePatternId, np.id, 'empty target gets the moved pattern as its active one');
  // a pattern nothing else uses moves with its clip
  const solo = createPattern(keys.id, { name: 'K', length: 4 });
  p.patterns[solo.id] = solo;
  const ck = createClip(keys.id, { patternId: solo.id, start: 0, length: 4 });
  p.clips.push(ck);
  moveClips(p, clipOrigins(p, [ck.id]), 0, -3); // keys (4) → lead (1)
  fixOwnership(p, [ck.id]);
  assert.equal(ck.patternId, solo.id);
  assert.equal(solo.trackId, lead.id);
  void bass; void cb2;
});

test('clip multi-select: lasso box, track / section / range selection, toggle, duplicate and delete as a group', () => {
  const { p, bass, drums, cb, cb2, cd, ca } = song();
  const v = { ppb: 10, x0: 0, y0: 0, laneH: 50 };
  // lasso over lanes 0..2, beats 1..5
  const ids = clipsInBox(p, v, 10, TOP_H + 5, 50, TOP_H + 2 * 50 + 10);
  assert.deepEqual(ids.sort(), [cb.id, cb2.id, cd.id].sort());
  assert.deepEqual(clipsInBox(p, v, 300, TOP_H + 5, 400, TOP_H + 400), []);
  assert.deepEqual(clipsInTrack(p, bass.id).sort(), [cb.id, cb2.id].sort());
  assert.deepEqual(clipsInRange(p, 4, 8).sort(), [cb2.id, cd.id, ca.id].sort());
  assert.deepEqual(clipsInRange(p, 4, 8, [drums.id]), [cd.id]);
  p.markers = [{ id: 'm1', beat: 0, name: 'Intro' }, { id: 'm2', beat: 4, name: 'Verse' }];
  assert.deepEqual(sectionAt(p, 5, 16), { start: 4, end: 16, name: 'Verse' });
  assert.deepEqual(sectionAt(p, 1, 16), { start: 0, end: 4, name: 'Intro' });
  assert.equal(sectionAt({ markers: [] }, 3), null);
  assert.deepEqual(toggleSel([cb.id], cd.id), [cb.id, cd.id]);
  assert.deepEqual(toggleSel([cb.id, cd.id], cb.id), [cd.id]);
  const n0 = p.clips.length;
  const copies = duplicateClips(p, [cb.id, cb2.id]);
  assert.equal(copies.length, 2);
  assert.deepEqual(p.clips.filter((c) => copies.includes(c.id)).map((c) => c.start).sort((a, b) => a - b), [8, 12], 'placed after the group span');
  deleteClips(p, copies);
  assert.equal(p.clips.length, n0);
  // group move keeps relative timing and clamps at 0
  const o = clipOrigins(p, [cb2.id, ca.id]);
  moveClips(p, o, clampShift(o, -10), 0);
  assert.deepEqual([cb2.start, ca.start], [2, 0]);
});

test('note multi-select: lasso, group move / transpose (scale-aware), quantize, velocity, duplicate, delete', () => {
  const pat = { length: 8, notes: [createNote(60, 0.1, 0.9, 0.5), createNote(64, 1.05, 0.4, 0.8), createNote(67, 6, 1, 1), createNote(72, 3, 1)] };
  const [a, b, c, d] = pat.notes;
  assert.deepEqual(notesInBox(pat.notes, 0, 2, 59, 65).sort(), [a.id, b.id].sort());
  assert.deepEqual(notesInBox(pat.notes, 2, 0, 65, 59).sort(), [a.id, b.id].sort(), 'any corner order');
  // move clamps as a group inside the pattern
  const o = noteOrigins(pat, [a.id, c.id]);
  moveNotes(pat, o, 5, 2);
  assert.equal(c.start + c.dur <= 8, true);
  assert.equal(+(c.start - a.start).toFixed(5), 5.9, 'relative timing kept');
  assert.deepEqual([a.pitch, c.pitch], [62, 69]);
  moveNotes(pat, o, -4, 0);
  assert.equal(a.start, 0);
  // scale steps (C major): 60 +1 step = 62, 64 +1 = 65
  transposeNotes(pat, [a.id, b.id], 1, [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([a.pitch, b.pitch], [62, 65]);
  transposeNotes(pat, [a.id], 12);
  assert.equal(a.pitch, 74);
  transposeNotes(pat, [d.id], 100);
  assert.equal(d.pitch, 127);
  b.start = 1.1; b.dur = 0.4;
  quantizeNotes(pat, [b.id], 0.5);
  assert.deepEqual([b.start, b.dur], [1, 0.5]);
  b.start = 1.2;
  quantizeNotes(pat, [b.id], 1, { strength: 0.5, ends: false });
  assert.equal(b.start, 1.1);
  setVelocity(pat, [a.id, b.id], { set: 0.3 });
  assert.deepEqual([a.vel, b.vel], [0.3, 0.3]);
  setVelocity(pat, [a.id], { scale: 10 });
  assert.equal(a.vel, 1);
  setVelocity(pat, [b.id], { add: -1 });
  assert.equal(b.vel, 0.05);
  const before = pat.notes.length;
  const copies = duplicateNotes(pat, [b.id], 1);
  assert.equal(copies.length, 1);
  assert.equal(pat.notes.find((n) => n.id === copies[0]).start, 2.1);
  c.start = 7.5;
  assert.deepEqual(duplicateNotes(pat, [c.id]), [], 'copies past the end are dropped');
  deleteNotes(pat, copies);
  assert.equal(pat.notes.length, before);
});

test('mix strips: folders (collapse), badges, VCA strips, reorder of visible strips = track order', () => {
  const { p, bass, lead, drums, mic, keys } = song();
  const f = createFolder(p, 'Band', [lead.id, drums.id]);
  assert.deepEqual(p.tracks.map((t) => t.name), ['Bass', 'Lead', 'Drums', 'Mic', 'Keys']);
  const g = createGroup(p, 'Rhythm', [bass.id, drums.id]);
  createVca(p, 'All', [bass.id, lead.id]);
  let { rows, vcas } = mixStrips(p);
  assert.deepEqual(rows.map((r) => r.kind === 'folder' ? `[${r.folder.name}]` : r.track.name), ['Bass', '[Band]', 'Lead', 'Drums', 'Mic', 'Keys']);
  assert.equal(vcas.length, 1);
  assert.deepEqual(vcas[0].members, [bass.id, lead.id]);
  const bb = channelBadges(p, bass.id);
  assert.deepEqual(bb.map((x) => `${x.kind}:${x.name}`), ['group:Rhythm', 'vca:All']);
  assert.ok(bb[0].links.includes('volume'));
  // collapse hides members
  f.collapsed = true;
  assert.deepEqual(visibleStripIds(p), [bass.id, mic.id, keys.id]);
  // move Keys (visible 2) to Bass's place (0)
  p.tracks = reorderVisible(p.tracks, visibleStripIds(p), 2, 0);
  assert.deepEqual(p.tracks.map((t) => t.name), ['Keys', 'Bass', 'Lead', 'Drums', 'Mic']);
  // move Bass (visible 1) down past Mic (2): lands after Mic
  p.tracks = reorderVisible(p.tracks, visibleStripIds(p), 1, 2);
  assert.deepEqual(p.tracks.map((t) => t.name), ['Keys', 'Lead', 'Drums', 'Mic', 'Bass']);
  f.collapsed = false;
  // moving a track between two folder members puts it into the folder; moving it out removes it
  p.tracks = reorderVisible(p.tracks, visibleStripIds(p), 4, 2); // Bass between Lead and Drums
  assert.equal(folderAfterMove(p, bass.id), f.id);
  setTrackFolder(p, bass.id, folderAfterMove(p, bass.id));
  assert.equal(bass.folderId, f.id);
  p.tracks = reorderVisible(p.tracks, visibleStripIds(p), 2, 0);
  assert.equal(folderAfterMove(p, bass.id), null);
  assert.deepEqual(reorderVisible(p.tracks, visibleStripIds(p), 1, 1).map((t) => t.id), p.tracks.map((t) => t.id));
  void g;
  assert.equal(fmtLu(-14.234), '−14.2');
  assert.equal(fmtLu(-Infinity), '−∞');
  const r = lufsReadout({ shortTerm: -9, integrated: -10.04, momentary: -8, truePeakDb: -0.5, lra: 4.25 });
  assert.deepEqual([r.short, r.integrated, r.peak, r.hot], ['−9.0', '−10.0', '−0.5', true]);
});

test('take sections follow song markers; choosing a take comps that section; tempo / meter lists', () => {
  const p = createProject();
  const t = createTrack({ name: 'Vox', type: 'audio' });
  p.tracks.push(t);
  const t1 = createTake({ name: 'Take 1', sampleId: 's1', start: 0, length: 16, pass: 1 });
  const t2 = createTake({ name: 'Take 2', sampleId: 's2', start: 0, length: 16, pass: 2 });
  addRecordedTakes(p, t, [t1, t2]);
  p.markers = [{ id: 'a', beat: 0, name: 'Verse' }, { id: 'b', beat: 8, name: 'Chorus' }];
  let secs = takeSections(p, t);
  assert.deepEqual(secs.map((s) => [s.name, s.start, s.end, s.takeId]), [['Verse', 0, 8, t2.id], ['Chorus', 8, 16, t2.id]]);
  assert.deepEqual(secs[0].takes.map((x) => x.id), [t2.id, t1.id], 'newest first');
  assert.ok(secs[0].takes.every((x) => x.covers));
  setCompRange(t, t1.id, secs[1].start, secs[1].end);
  secs = takeSections(p, t);
  assert.deepEqual(secs.map((s) => s.takeId), [t2.id, t1.id]);
  assert.match(takeSummary(p, t), /^2 takes · comp bars 1–4$/);
  p.markers = [];
  assert.deepEqual(takeSections(p, t).map((s) => s.name), ['Part 1', 'Part 2']);
  assert.deepEqual(takeSections(p, createTrack({ type: 'audio' })), []);
  // tempo / meter lists
  p.bpm = 100;
  assert.deepEqual(tempoRows(p).map((r) => [r.beat, r.bpm]), [[0, 100]]);
  setTempoPoint(p, 16, 140, 'linear');
  const tr = tempoRows(p);
  assert.deepEqual(tr.map((r) => [r.i, r.beat, r.bpm, r.curve]), [[0, 0, 100, 'jump'], [1, 16, 140, 'linear']]);
  assert.match(tr[1].bbt, /^5/);
  setMeter(p, 4, 3, 4);
  assert.deepEqual(meterRows(p).map((m) => [m.label, m.num, m.den]), [['Bar 1', 4, 4], ['Bar 5', 3, 4]]);
});
