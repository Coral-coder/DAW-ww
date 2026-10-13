// Song length (genre forms, length presets) and extending existing songs (src/gen/form.js, src/gen/extend.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import { extendSong, applyExtension, planExtension, removeSection, songEnd, songSections } from '../src/gen/extend.js';
import { createProject, createTrack, createPattern, createClip, createNote, beatsPerBar } from '../src/core/model.js';
import { analyzeSong, ratio } from './lib/harmony-check.js';

const EPS = 1e-6;
const minutesOf = (s) => (Math.max(...s.clips.map((c) => c.start + c.length)) / s.bpm);
const project = (opts) => ({ ...createProject(), ...G.generateSong(opts) });

/** Ids consistent, clips reference patterns of their own track, no overlapping clips on a track, markers sorted. */
function checkProject(p, label) {
  const trackIds = new Set(p.tracks.map((t) => t.id));
  const clipIds = new Set();
  for (const c of p.clips) {
    assert.ok(!clipIds.has(c.id), `${label}: unique clip id`);
    clipIds.add(c.id);
    assert.ok(trackIds.has(c.trackId), `${label}: clip track`);
    assert.ok(c.length > 0 && c.start >= 0, `${label}: clip span`);
    if (c.type === 'pattern') {
      const pat = p.patterns[c.patternId];
      assert.ok(pat, `${label}: clip ${c.id} references an existing pattern`);
      assert.equal(pat.trackId, c.trackId, `${label}: clip/pattern track agree`);
      for (const n of pat.notes) assert.ok(n.start >= 0 && n.start < pat.length && n.dur > 0, `${label}: note in ${pat.name}`);
    }
  }
  for (const [id, pat] of Object.entries(p.patterns)) assert.equal(pat.id, id, `${label}: pattern id`);
  for (const t of p.tracks) {
    const cs = p.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) assert.ok(cs[i].start >= cs[i - 1].start + cs[i - 1].length - 1e-4, `${label}: overlapping clips on ${t.name} @${cs[i].start}`);
  }
  const mb = p.markers.map((m) => m.beat);
  assert.deepEqual(mb, [...mb].sort((a, b) => a - b), `${label}: markers sorted`);
  assert.equal(new Set(p.markers.map((m) => m.id)).size, p.markers.length, `${label}: unique marker ids`);
  for (const o of [...p.tracks, ...(p.buses || []), p.master]) {
    for (const l of o.automation || []) for (let i = 1; i < l.points.length; i++) assert.ok(l.points[i].beat >= l.points[i - 1].beat, `${label}: lane ${l.target} sorted`);
  }
}

test('song length: every genre\'s standard form is within ±15% of its realistic length at the default tempo', () => {
  for (const [id, g] of Object.entries(G.GENRES)) {
    assert.ok(g.minutes > 0, `${id}: minutes`);
    const s = G.generateSong({ genre: id, seed: 1 });
    const min = minutesOf(s);
    assert.ok(Math.abs(min - g.minutes) / g.minutes <= 0.15, `${id}: ${min.toFixed(2)} min vs ${g.minutes}`);
    assert.equal(s.markers.length, g.structure.length, id);
  }
  // the club / DJ genres are long, songs are radio length
  assert.ok(minutesOf(G.generateSong({ genre: 'trance', seed: 1 })) >= 7);
  assert.ok(minutesOf(G.generateSong({ genre: 'psytrance', seed: 1 })) >= 7);
  const house = minutesOf(G.generateSong({ genre: 'house', seed: 1 }));
  assert.ok(house >= 6 && house <= 7.2, `house ${house}`);
  const pop = minutesOf(G.generateSong({ genre: 'pop', seed: 1 }));
  assert.ok(pop >= 3.2 && pop <= 3.9, `pop ${pop}`);
  // the DJ intro starts with drums only; trance has a long breakdown and two drops
  const tr = G.generateSong({ genre: 'trance', seed: 2 });
  assert.deepEqual(tr.sections[0].roles, ['drums']);
  assert.ok(tr.sections.filter((x) => x.kind === 'main').length >= 2);
  assert.ok(tr.sections.some((x) => x.kind === 'break' && x.bars >= 32));
  assert.ok(tr.sections.at(-1).kind === 'outro' && tr.sections.filter((x) => x.kind === 'outro').reduce((a, x) => a + x.bars, 0) >= 32);
});

test('song length: length presets and targetMinutes', () => {
  for (const genre of ['trance', 'pop', 'jazz', 'trap', 'lofi-hip-hop', 'drum-and-bass', 'rock']) {
    const g = G.GENRES[genre];
    const std = minutesOf(G.generateSong({ genre, seed: 4 }));
    const short = minutesOf(G.generateSong({ genre, seed: 4, length: 'short' }));
    const ext = minutesOf(G.generateSong({ genre, seed: 4, length: 'extended' }));
    assert.ok(Math.abs(short / std - 0.6) <= 0.15, `${genre}: short ${short.toFixed(2)} vs ${std.toFixed(2)}`);
    assert.ok(Math.abs(ext / std - 1.4) <= 0.2, `${genre}: extended ${ext.toFixed(2)} vs ${std.toFixed(2)}`);
    const t = minutesOf(G.generateSong({ genre, seed: 4, targetMinutes: 5 }));
    assert.ok(Math.abs(t - 5) / 5 <= 0.15, `${genre}: 5 min target -> ${t.toFixed(2)}`);
    // the preview agrees with the generator
    const plan = G.planSongLength(g, { length: 'extended' });
    assert.ok(Math.abs(plan.minutes - ext) < 1e-6, `${genre}: preview`);
  }
  // club: DJ edit with >= 32-bar intro and outro for dance genres
  const club = G.generateSong({ genre: 'dubstep', seed: 1, length: 'club' });
  const intro = club.sections.filter((s) => s.kind === 'intro').reduce((a, s) => a + s.bars, 0);
  const outro = club.sections.filter((s) => s.kind === 'outro').reduce((a, s) => a + s.bars, 0);
  assert.ok(intro >= 32 && outro >= 32, `club intro ${intro} outro ${outro}`);
  assert.deepEqual(club.sections[0].roles, ['drums']);
  // other tempos are re-fitted to the genre length
  const fast = minutesOf(G.generateSong({ genre: 'house', seed: 1, bpm: 128 }));
  assert.ok(Math.abs(fast - 6.5) / 6.5 <= 0.15, `house @128: ${fast}`);
  // generation stays fast
  const t0 = performance.now();
  G.generateSong({ genre: 'psytrance', seed: 9, length: 'extended' });
  assert.ok(performance.now() - t0 < 1500, 'fast generation');
});

test('long songs keep evolving: per-instance patterns, layers entering, key change in pop', () => {
  const s = G.generateSong({ genre: 'trance', seed: 3 });
  const drums = s.tracks.find((t) => t.role === 'drums');
  const drumClips = s.clips.filter((c) => c.trackId === drums.id);
  assert.equal(new Set(drumClips.map((c) => c.patternId)).size, drumClips.length, 'every section has its own drum pattern');
  assert.ok(s.sections.some((x) => x.enter?.length), 'a layer enters halfway through a long section');
  assert.ok(Object.values(s.patterns).some((p) => / \(enters\)$/.test(p.name)));
  let modulated = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const p = G.generateSong({ genre: 'pop', seed, withHarmony: true });
    if (p.sections.some((x) => x.modulation)) {
      modulated++;
      const last = p.sections.filter((x) => x.type === 'chorus').at(-1);
      assert.ok(last.modulation > 0, 'the last chorus goes up');
      const r = analyzeSong(p);
      assert.ok(ratio(r.notes) >= 0.97 && ratio(r.bass) >= 0.9, `pop s${seed} after key change: ${ratio(r.notes)}`);
    }
  }
  assert.ok(modulated >= 1, 'some pop songs modulate for the last chorus');
});

test('extendSong: every mode adds consistent, harmonically correct material', () => {
  for (const genre of ['trance', 'pop', 'jazz', 'lofi-hip-hop', 'house', 'trap']) {
    for (const mode of ['continue', 'repeat-last', 'extend-outro', 'insert-section']) {
      const p = project({ genre, seed: 7, withHarmony: true });
      const bpb = beatsPerBar(p);
      const oldEnd = songEnd(p);
      const oldPatterns = new Set(Object.keys(p.patterns));
      const mid = p.markers[Math.floor(p.markers.length / 2)];
      const ext = extendSong(p, { mode, bars: 32, seed: 3, markerId: mid.id });
      const label = `${genre}/${mode}`;
      assert.ok(ext.items.length >= 1, `${label}: plan`);
      assert.equal(ext.addBeats, 32 * bpb, `${label}: +32 bars`);
      assert.match(ext.summary, /^Adds .* = \+32 bars \/ \+\d+:\d\d/);
      // new clips reference new pattern variants or existing patterns, on the same tracks
      for (const c of ext.clips) assert.ok(ext.patterns[c.patternId] || p.patterns[c.patternId] || c.type === 'audio', `${label}: clip pattern`);
      applyExtension(p, ext);
      checkProject(p, label);
      assert.equal(songEnd(p), oldEnd + 32 * bpb, `${label}: new length`);
      for (const id of Object.keys(ext.patterns)) assert.ok(!oldPatterns.has(id));
      // every new section has a marker, and markers stay sorted
      for (const it of ext.items) assert.ok(p.markers.some((m) => m.name === it.label && Math.abs(m.beat - it.start) < EPS), `${label}: marker ${it.label}`);
      // the new material follows the song's harmony
      const r = analyzeSong(p);
      assert.ok(ratio(r.notes) >= 0.95, `${label}: notes ${ratio(r.notes)}\n  ${r.issues.slice(0, 5).join('\n  ')}`);
      assert.ok(ratio(r.bass) >= 0.9, `${label}: bass ${ratio(r.bass)}`);
      assert.equal(ratio(r.voicing), 1, `${label}: voicing`);
      assert.equal(ratio(r.overlap), 1, `${label}: overlap`);
      assert.equal(r.notes.clashSustained, 0, `${label}: sustained clashes`);
    }
  }
});

test('extendSong: sounds like the same song (variants of existing patterns) and continues automation', () => {
  const p = project({ genre: 'house', seed: 2, withHarmony: true });
  const oldEnd = songEnd(p);
  const ext = extendSong(p, { mode: 'repeat-last', bars: 32, seed: 1 });
  const drops = Object.values(p.patterns).filter((x) => / – Drop 2$/.test(x.name));
  assert.ok(drops.length);
  const drumNew = Object.values(ext.patterns).find((x) => x.trackId === p.tracks.find((t) => t.role === 'drums').id);
  const drumOld = drops.find((x) => x.trackId === drumNew.trackId);
  const sig = (pat) => new Set(pat.notes.filter((n) => n.pitch === 36).map((n) => n.start));
  const shared = [...sig(drumNew)].filter((t) => sig(drumOld).has(t)).length;
  assert.ok(shared >= sig(drumOld).size * 0.8, 'the kick pattern is the existing one');
  assert.notDeepEqual(drumNew.notes.map((n) => [n.pitch, n.start]), drumOld.notes.map((n) => [n.pitch, n.start]), 'but varied');
  // extend-outro at the end of a song without an outro moves the master fade to the new end
  const q = project({ genre: 'techno', seed: 1 });
  const outroStart = songSections(q).filter((s) => s.kind === 'outro')[0].start;
  removeSection(q, { start: outroStart, end: songEnd(q) });
  q.master.automation = [{ id: 'f', target: 'volume', enabled: true, points: [{ beat: songEnd(q) - 32, value: 0.8 }, { beat: songEnd(q), value: 0 }] }];
  const end0 = songEnd(q);
  const e2 = extendSong(q, { mode: 'extend-outro', bars: 16, seed: 2 });
  assert.equal(e2.shiftFrom, null);
  applyExtension(q, e2);
  const fade = q.master.automation[0].points;
  assert.equal(fade.at(-1).beat, end0 + 64, 'fade ends at the new end');
  assert.equal(fade.at(-1).value, 0);
  assert.ok(fade.some((pt) => pt.beat === end0 - 32 && pt.value === 0.8) && fade.some((pt) => pt.beat === end0 + 32 && pt.value === 0.8), 'held through the new part');
  // only continued lanes (with points in the template section) get points beyond the old end
  for (const t of q.tracks) {
    for (const l of t.automation) {
      const beyond = l.points.filter((pt) => pt.beat > end0 + EPS);
      if (beyond.length) assert.ok(e2.automation.some((a) => a.ownerId === t.id && a.target === l.target), `${t.name} ${l.target}: continued`);
    }
  }
  // the outro peels layers away: fewer tracks play at its end than at its start
  const it = e2.items[0];
  const playingAt = (b) => new Set(q.clips.filter((c) => c.start <= b + EPS && c.start + c.length > b + EPS).map((c) => c.trackId)).size;
  assert.ok(playingAt(it.start + it.beats - 1) < playingAt(it.start + 1), 'layers peel away');
  void oldEnd;
});

test('insert-section shifts later clips, automation, markers; removeSection closes the gap', () => {
  const p = project({ genre: 'trance', seed: 5 });
  const bpb = beatsPerBar(p);
  const m = p.markers.find((x) => x.name === 'Drop');
  const at = m.beat;
  const before = p.clips.filter((c) => c.start >= at).map((c) => [c.id, c.start]);
  const lane = p.tracks.flatMap((t) => t.automation).find((l) => l.points.some((pt) => pt.beat > at + 8));
  const lanePts = lane.points.filter((pt) => pt.beat > at + EPS).map((pt) => pt.beat);
  const ext = extendSong(p, { mode: 'insert-section', markerId: m.id, kind: 'break', bars: 16, seed: 1 });
  assert.equal(ext.items[0].kind, 'break');
  assert.equal(ext.shiftFrom, at);
  applyExtension(p, ext);
  checkProject(p, 'insert');
  for (const [id, start] of before) assert.equal(p.clips.find((c) => c.id === id).start, start + 16 * bpb, 'clip shifted');
  assert.equal(p.markers.find((x) => x.id === m.id).beat, at + 16 * bpb, 'marker shifted');
  for (const b of lanePts) assert.ok(lane.points.some((pt) => Math.abs(pt.beat - (b + 16 * bpb)) < 1e-3), 'automation shifted');
  const ins = p.markers.find((x) => Math.abs(x.beat - at) < EPS);
  assert.ok(/Breakdown/.test(ins.name), ins.name);
  assert.ok(p.clips.some((c) => Math.abs(c.start - at) < EPS), 'new clips at the insert point');
  // a clip that spans the insert point is split, not overlapped
  const q = project({ genre: 'pop', seed: 1 });
  const chords = q.tracks.find((t) => t.role === 'chords');
  const long = q.clips.find((c) => c.trackId === chords.id && c.length >= 32);
  const mid = long.start + 16;
  const e2 = extendSong(q, { mode: 'insert-section', at: mid, kind: 'break', bars: 8, seed: 1 });
  applyExtension(q, e2);
  checkProject(q, 'split');
  assert.equal(long.length, 16);
  const tail = q.clips.find((c) => c.trackId === chords.id && c.patternId === long.patternId && Math.abs(c.start - (mid + 32)) < EPS);
  assert.ok(tail && tail.offset === 16, 'tail continues where the head stopped');
  // remove the inserted section again: the song is back to its old shape
  const len0 = songEnd(p);
  const r = removeSection(p, { markerId: ins.id });
  assert.equal(r.beats, 16 * bpb);
  checkProject(p, 'remove');
  assert.equal(songEnd(p), len0 - 16 * bpb);
  for (const [id, start] of before) assert.equal(p.clips.find((c) => c.id === id).start, start, 'clip back in place');
  assert.equal(p.markers.find((x) => x.id === m.id).beat, at);
});

test('extendSong works on hand-made songs (no markers, no roles)', () => {
  const p = createProject({ bpm: 100 });
  const keys = createTrack({ name: 'Keys', instrument: { type: 'synth', preset: null, params: {} } });
  const beat = createTrack({ name: 'Beat', instrument: { type: 'drums', preset: '808', params: {} } });
  p.tracks = [keys, beat];
  const kp = createPattern(keys.id, { length: 16, notes: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]].flatMap((ch, i) => ch.map((x) => createNote(x, i * 4, 4, 0.7))) });
  const dp = createPattern(beat.id, { length: 4, notes: [0, 1, 2, 3].map((b) => createNote(36, b, 0.25, 0.9)).concat([1, 3].map((b) => createNote(38, b, 0.25, 0.8))) });
  p.patterns = { [kp.id]: kp, [dp.id]: dp };
  p.clips = [createClip(keys.id, { patternId: kp.id, start: 0, length: 128 }), createClip(beat.id, { patternId: dp.id, start: 0, length: 128 })];
  p.markers = [];
  const plan = planExtension(p, { mode: 'repeat-last', bars: 16 });
  assert.equal(plan.addBars, 16);
  const ext = extendSong(p, { mode: 'repeat-last', bars: 16, seed: 2 });
  applyExtension(p, ext);
  checkProject(p, 'hand-made');
  assert.equal(songEnd(p), 48 * 4, 'grew to 48 bars');
  assert.ok(p.clips.filter((c) => c.trackId === keys.id).some((c) => c.start >= 32 * 4 - EPS));
  assert.ok(p.clips.filter((c) => c.trackId === beat.id).some((c) => c.start >= 32 * 4 - EPS));
  // continue also works without markers (8-bar parts)
  const c2 = extendSong(p, { mode: 'continue', bars: 16, seed: 3 });
  applyExtension(p, c2);
  checkProject(p, 'hand-made continue');
  assert.equal(songEnd(p), 64 * 4);
  // keys keep the same chords (pitch classes) — it is the same song
  const newKeys = p.clips.filter((c) => c.trackId === keys.id && c.start >= 128).map((c) => p.patterns[c.patternId]);
  for (const pat of newKeys) assert.deepEqual([...new Set(pat.notes.map((n) => n.pitch % 12))].sort(), [...new Set(kp.notes.map((n) => n.pitch % 12))].sort());
});
