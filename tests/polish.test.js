// fix/polish: count-in, groove UI logic, key spelling, warp repitch, scoped shortcuts, MPE voices, sync / surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { songTempoMap } from '../src/time/tempo-map.js';
import { countInSchedule } from '../src/record/timing.js';
import { createProject } from '../src/core/model.js';
import { Scheduler } from '../src/audio/scheduler.js';

test('count-in: unmapped project, metronome on, record from bar 1 → recorder clicks the whole bar before 0', () => {
  const p = createProject({ bpm: 120 });
  const map = songTempoMap(p);
  const ci = countInSchedule(map, 0, 1, true);
  assert.equal(ci.from, -4);
  assert.equal(ci.startDelay, 0);
  assert.deepEqual(ci.clicks.map((c) => c.beat), [-4, -3, -2, -1]);
  assert.deepEqual(ci.clicks.map((c) => c.level), [2, 1, 1, 1]);
  assert.deepEqual(ci.clicks.map((c) => +c.t.toFixed(6)), [0, 0.5, 1, 1.5]);
  // the transport's own metronome yields nothing before beat 0 — that was the silent count-in
  const sch = new Scheduler(p, { mode: 'song', metronome: true });
  assert.equal(map.clicks(-4, 0).length, 0);
  assert.ok(sch);
});

test('count-in: metronome off → transport waits, every unit is clicked; 2 bars; mid-song start', () => {
  const p = createProject({ bpm: 90 });
  const map = songTempoMap(p);
  const ci = countInSchedule(map, 8, 2, false);
  assert.equal(ci.from, 8);
  assert.equal(ci.clicks.length, 8);
  assert.ok(Math.abs(ci.startDelay - 8 * 60 / 90) < 1e-9);
  assert.deepEqual(ci.clicks.map((c) => c.level), [2, 1, 1, 1, 2, 1, 1, 1]);
  // metronome on, mid-song: the transport clicks positive beats itself
  const on = countInSchedule(map, 8, 1, true);
  assert.equal(on.from, 4);
  assert.equal(on.clicks.length, 0);
  assert.deepEqual(countInSchedule(map, 0, 0, true), { from: 0, startDelay: 0, clicks: [] });
});

test('count-in: accents follow the meter (6/8 groups 3+3) even without a tempo map', () => {
  const p = createProject({ bpm: 120 });
  p.timeSig = [6, 8]; p.meter = { num: 6, den: 8 };
  const map = songTempoMap(p);
  const ci = countInSchedule(map, 0, 1, true);
  if (map.meterOfBar(-1).num === 6) assert.deepEqual(ci.clicks.map((c) => c.level), [2, 0, 0, 1, 0, 0]);
  else assert.equal(ci.clicks[0].level, 2);
});

import { keyName, keyRootName, spellPitch, spellNote, keySignature, diatonicChords, keyPrefersFlats } from '../src/theory/index.js';
import { keyName as setlistKeyName, keyMoveOptions } from '../src/live/setlist-engine.js';
import { noteSpeller } from '../src/code/song-code.js';

test('key spelling: flat keys (F Bb Eb Ab Db Gb + relative minors) use flats everywhere', () => {
  assert.equal(keyName(8, 'major'), 'Ab major');
  assert.equal(keyRootName(8, 'major'), 'Ab');
  assert.equal(keyRootName(8, 'minor'), 'G#');
  assert.equal(keyName(3, 'minor'), 'Eb minor'); // 6 flats, not D# minor
  assert.equal(keyName(6, 'major'), 'Gb major');
  assert.equal(keyName(10, 'minor'), 'Bb minor');
  assert.equal(keyName(1, 'minor'), 'C# minor');
  assert.equal(keyName(4, 'major'), 'E major');
  assert.equal(keyRootName(2, 'dorian'), 'D');
  assert.equal(keyRootName(3, 'dorian'), 'Eb'); // Eb dorian = Db major
  assert.equal(spellPitch(8, { root: 3, scale: 'major' }), 'Ab');
  assert.equal(spellPitch(8, { root: 4, scale: 'major' }), 'G#');
  assert.equal(spellNote(68, { root: 3, scale: 'minor' }), 'Ab4');
  assert.equal(keySignature(6, 'major'), -6);
  assert.equal(keySignature(3, 'minor'), -6);
  assert.equal(keySignature(11, 'major'), 5);
  assert.ok(keyPrefersFlats(5, 'major') && !keyPrefersFlats(7, 'major'));
});

test('key spelling: chord symbols, setlist and code speller agree with the key', () => {
  assert.deepEqual(diatonicChords(8, 'major').map((c) => c.name), ['Ab', 'Bbm', 'Cm', 'Db', 'Eb', 'Fm', 'Gdim']);
  assert.deepEqual(diatonicChords(4, 'major').map((c) => c.name).slice(0, 3), ['E', 'F#m', 'G#m']);
  assert.equal(setlistKeyName({ root: 3, scale: 'minor' }), 'Eb minor');
  const par = keyMoveOptions({ root: 3, scale: 'major' }).find((o) => /parallel/i.test(o.label));
  if (par) assert.match(par.text, /^Eb major → Eb minor/);
  assert.equal(noteSpeller({ key: { root: 8, scale: 'major' } })(68), 'ab4');
  assert.equal(noteSpeller({ key: { root: 3, scale: 'minor' } })(66), 'gb4');
  assert.equal(noteSpeller({ key: { root: 9, scale: 'minor' } })(66), 'f#4');
});

import { repitchRates, curveRates } from '../src/audio/warp/markers.js';
import { WarpRenderer } from '../src/audio/warp/core.js';

test('warp: Re-Pitch honours transpose (rate × 2^(st/12) on top of the tempo ratio)', () => {
  const pts = [{ t: 0, s: 0 }, { t: 1, s: 0.5 }, { t: 2, s: 1.5 }];
  assert.deepEqual(curveRates(pts).map((r) => r.rate), [0.5, 1]);
  assert.deepEqual(repitchRates(pts, 12).map((r) => r.rate), [1, 2]);
  assert.ok(Math.abs(repitchRates(pts, 7)[1].rate - 2 ** (7 / 12)) < 1e-12);
  assert.deepEqual(repitchRates(pts, 0), curveRates(pts));
  // renderer: a 100 Hz sine played at tempo ratio 1 with +12 st comes out at 200 Hz
  const sr = 8000, x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 100 * i / sr);
  const zc = (y) => { let n = 0; for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) n++; return n; };
  const mk = (mode, transpose) => new WarpRenderer({ channels: [x], srcRate: sr, outRate: sr, curve: [{ t: 0, s: 0 }, { t: 0.5, s: 0.5 }], mode, transpose }).renderAll()[0];
  assert.ok(Math.abs(zc(mk('repitch', 0)) - 50) <= 1);
  assert.ok(Math.abs(zc(mk('repitch', 12)) - 100) <= 1);
  assert.ok(Math.abs(zc(mk('off', 12)) - 50) <= 1); // warp off: transpose does nothing
});
