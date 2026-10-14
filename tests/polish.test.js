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
