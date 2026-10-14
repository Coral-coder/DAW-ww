import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap, tempoMapFor, meterGroups, hasTempoChanges, spanOf } from '../src/time/tempo-map.js';
import { setTempoPoint, addTempoRamp, setMeter, tapBpm, TapTempo, tempoFromSelection, normalizeTempoMap, removeTempoPoint } from '../src/time/tempo-edit.js';
import { collectEvents, annotateTimes, Scheduler } from '../src/audio/scheduler.js';
import { createProject } from '../src/core/model.js';
import { MidiClockOut, PPQN, MtcOut } from '../src/control/clock.js';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('constant map: seconds = beats · 60/bpm', () => {
  const m = new TempoMap({ bpm: 120 });
  assert.equal(m.isConstant, true);
  close(m.secAt(8), 4);
  close(m.beatAt(4), 8);
  close(m.secAt(-2), -1);
});

test('linear ramp integrates exactly (closed form) and round-trips', () => {
  // 120 -> 140 over 16 beats, then hold
  const m = new TempoMap({ bpm: 120, points: [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 140, curve: 'jump' }] });
  const k = 20 / 16;
  close(m.secAt(16), (60 / k) * Math.log(140 / 120), 1e-12);
  // numeric integration agrees
  let s = 0; const n = 200000;
  for (let i = 0; i < n; i++) { const b = (i + 0.5) * 16 / n; s += (60 / (120 + k * b)) * (16 / n); }
  close(m.secAt(16), s, 1e-9);
  close(m.bpmAt(8), 130, 1e-12);
  close(m.secAt(20) - m.secAt(16), 4 * 60 / 140, 1e-12);
  // round trip + strict monotonicity over a dense sweep
  let prev = -Infinity;
  for (let b = 0; b <= 40; b += 0.013) {
    const t = m.secAt(b);
    assert.ok(t > prev, 'monotonic');
    prev = t;
    close(m.beatAt(t), b, 1e-9, 'round trip');
  }
});

test('ramp down, jumps, several segments: round trip everywhere', () => {
  const m = new TempoMap({ bpm: 90, points: [
    { beat: 0, bpm: 90, curve: 'linear' }, { beat: 8, bpm: 60, curve: 'jump' }, { beat: 12, bpm: 170, curve: 'linear' }, { beat: 13, bpm: 171, curve: 'jump' }, { beat: 20, bpm: 75 },
  ] });
  for (let b = 0; b < 30; b += 0.1) close(m.beatAt(m.secAt(b)), b, 1e-9);
  for (let t = 0; t < 20; t += 0.05) close(m.secAt(m.beatAt(t)), t, 1e-9);
  close(m.bpmAt(12.5), 170.5, 1e-12);
  close(m.bpmAt(25), 75);
  assert.deepEqual(m.breaks(0, 30), [8, 12, 13, 20]);
});

test('meter changes: bar numbering, bar starts, positions', () => {
  // 4/4 x2, then 7/8 from bar 2 (3.5 beats), then 3/4 from bar 3
  const m = new TempoMap({ bpm: 120, timeSig: [4, 4], meters: [{ bar: 2, num: 7, den: 8 }, { bar: 3, num: 3, den: 4 }] });
  assert.equal(m.barStart(2), 8);
  assert.equal(m.barStart(3), 11.5);
  assert.equal(m.barStart(4), 14.5);
  assert.equal(m.barAt(11.4).bar, 2);
  assert.equal(m.barAt(11.5).bar, 3);
  assert.equal(m.barAt(14.49).bar, 3);
  const p = m.position(9.5); // bar 3 (1-based), 4th eighth
  assert.equal(p.bar, 3); assert.equal(p.beat, 4); assert.equal(p.den, 8);
  assert.equal(m.formatBBT(11.5), '4.1.1');
  assert.equal(m.addBars(0, 3), 11.5);
  // clicks: 7/8 bar -> 7 eighth-note clicks grouped 2+2+3
  const cl = m.clicks(8, 11.5);
  assert.equal(cl.length, 7);
  assert.deepEqual(cl.map((c) => c.level), [2, 0, 1, 0, 1, 0, 0]);
  assert.deepEqual(cl.map((c) => c.beat), [8, 8.5, 9, 9.5, 10, 10.5, 11]);
  assert.deepEqual(meterGroups(6, 8), [3, 3]);
  assert.deepEqual(meterGroups(5, 8), [3, 2]);
  assert.deepEqual(meterGroups(4, 4), [1, 1, 1, 1]);
  const grid = m.gridLines(0, 15, { beats: false });
  assert.deepEqual(grid.map((g) => g.beat), [0, 4, 8, 11.5, 14.5]);
});

test('project access: pattern mode ignores the tempo map; song mode uses it', () => {
  const p = createProject({ bpm: 100 });
  addTempoRamp(p, 0, 100, 8, 150);
  assert.ok(hasTempoChanges(p));
  assert.equal(p.tempoMap[0].bpm, 100);
  p.mode = 'pattern';
  assert.equal(tempoMapFor(p).isConstant, true);
  p.mode = 'song';
  const m = tempoMapFor(p);
  assert.equal(m.isConstant, false);
  close(m.bpmAt(4), 125, 1e-9);
  assert.equal(tempoMapFor(p), m, 'cached');
  // project.bpm drives the first point
  p.bpm = 110;
  close(tempoMapFor(p).bpmAt(0), 110);
  setTempoPoint(p, 0, 90);
  assert.equal(p.bpm, 90);
  assert.equal(p.tempoMap[0].bpm, 90);
  removeTempoPoint(p, 1);
  assert.equal(p.tempoMap, undefined, 'trivial map dropped');
  close(spanOf(0.5, 0, 4), 2);
  close(spanOf(tempoMapFor(p), 0, 3), 2);
});

test('scheduler events across a 120->140 ramp land on the exact tempo-map times', () => {
  const p = createProject({ bpm: 120 });
  p.mode = 'song';
  p.loop.enabled = false;
  addTempoRamp(p, 0, 120, 16, 140);
  setMeter(p, 4, 7, 8);
  p.metronome = true;
  // fake ctx: drive the realtime scheduler with a virtual clock
  const ctx = { currentTime: 0 };
  const got = [];
  const s = new Scheduler({ ctx, getProject: () => p, dispatch: (ev, time) => got.push({ beat: ev.beat, time, level: ev.level }), interval: 25, lookahead: 0.1 });
  const realSet = globalThis.setInterval; globalThis.setInterval = () => 0;
  try {
    s.start(0, 0.05);
    for (let t = 0; t < 12; t += 0.025) { ctx.currentTime = t; s.tick(); }
  } finally { globalThis.setInterval = realSet; }
  const m = tempoMapFor(p);
  assert.ok(got.length > 30);
  for (const g of got) close(g.time, 0.05 + m.secAt(g.beat), 1e-9, `click @${g.beat}`);
  // beats strictly increasing, 7/8 bar: eighth clicks between 16 and 19.5
  const in78 = got.filter((g) => g.beat >= 16 && g.beat < 19.5).map((g) => g.beat);
  assert.deepEqual(in78, [16, 16.5, 17, 17.5, 18, 18.5, 19]);
  // playhead mapping is the inverse
  ctx.currentTime = 5;
  close(s.beatAt(0.05 + m.secAt(10.25)), 10.25, 1e-9);
});

test('collectEvents + annotateTimes give exact note durations through a ramp', () => {
  const p = createProject({ bpm: 120 });
  p.mode = 'song';
  addTempoRamp(p, 0, 60, 4, 180);
  const m = tempoMapFor(p);
  const evs = annotateTimes([{ type: 'note', beat: 1, dur: 2 }], m);
  close(evs[0].durSec, m.secAt(3) - m.secAt(1));
  assert.equal(collectEvents(p, 0, 4, { metronome: true }).filter((e) => e.type === 'click').length, 4);
});

test('MIDI clock out follows the tempo map: tick spacing on a ramp', () => {
  const p = createProject({ bpm: 120 });
  p.mode = 'song';
  addTempoRamp(p, 0, 120, 8, 180);
  const m = tempoMapFor(p);
  const sent = [];
  const c = new MidiClockOut({ send: (d, ts) => sent.push([d[0], ts]), lookahead: 50 });
  c.start(0, 120, 1000, m);
  for (let t = 1000; t < 6000; t += 10) c.pump(t);
  const ticks = sent.filter((x) => x[0] === 0xf8).map((x) => x[1]);
  assert.ok(ticks.length > 8 * PPQN);
  for (let k = 0; k < 8 * PPQN; k++) close(ticks[k], 1000 + m.secAt(k / PPQN) * 1000, 1e-6, `tick ${k}`);
  // spacing shrinks along the ramp
  const d0 = ticks[1] - ticks[0], d1 = ticks[8 * PPQN - 1] - ticks[8 * PPQN - 2];
  assert.ok(d0 > d1 * 1.4, `${d0} vs ${d1}`);
  close(c.beatAt(1000 + m.secAt(5) * 1000), 5, 1e-9);
  // MTC follows seconds of the map
  const mtc = new MtcOut({ send: () => {} });
  mtc.start(m.secAt(4), 0);
  close(mtc.frame0 / 25, Math.ceil(m.secAt(4) * 25 - 1e-6) / 25 + ((Math.ceil(m.secAt(4) * 25 - 1e-6)) % 2 ? 1 / 25 : 0), 1e-9);
});

test('tap tempo + tempo from selection length', () => {
  assert.equal(tapBpm([0, 500, 1000, 1500]), 120);
  assert.equal(tapBpm([0, 500, 1000, 1700, 2000]), 120, 'one sloppy tap is ignored');
  const tt = new TapTempo();
  [0, 400, 800, 1200].forEach((t, i) => { const b = tt.tap(t); if (i === 3) assert.equal(b, 150); });
  const p = createProject({ bpm: 120 });
  // 4 bars (16 beats) at 120 = 8 s; a selection of 15 beats that should be 4 bars -> 120·16/15
  const bpm = tempoFromSelection(p, 0, 15);
  close(bpm, 128, 1e-6);
  const p2 = createProject({ bpm: 120 });
  p2.mode = 'song';
  tempoFromSelection(p2, 8, 15.5, 8);
  const m2 = tempoMapFor(p2);
  close(m2.span(8, 16), 3.75, 1e-9, 'selection keeps its duration');
  close(m2.bpmAt(20), 120);
  normalizeTempoMap(p2);
});

import { quantizeWarp, extractGroove, grooveFromNotes, applyGrooveToNotes, quantizeNotes, gridTarget, grooveFromAudio } from '../src/time/groove.js';
import { secAtBeat, beatAtSec } from '../src/audio/warp/markers.js';

test('audio quantize: transients pulled to the grid by strength (with swing)', () => {
  // a loose 120 BPM performance: 16th hits with ±20 ms errors
  const err = [0.012, -0.018, 0.02, -0.006, 0.015, -0.02, 0.004, 0.01];
  const trans = err.map((e, k) => k * 0.125 + 0.002 + e).map((s) => Math.max(0, s));
  const clip = { start: 4, length: 4, offset: 0, warp: { mode: 'beats', markers: [{ beat: 0, sec: 0 }, { beat: 4, sec: 2 }], bpm: 120 } };
  const w = quantizeWarp(clip, trans, { grid: 0.25, strength: 1 });
  for (const s of trans) { const b = beatAtSec(w, s); close(b, Math.round(b / 0.25) * 0.25, 1e-6, 'on grid'); }
  const half = quantizeWarp(clip, trans, { grid: 0.25, strength: 0.5 });
  trans.forEach((s, k) => { const before = s * 2, target = k * 0.25; close(beatAtSec(half, s), before + 0.5 * (target - before), 1e-6, 'half strength'); });
  const sw = quantizeWarp(clip, trans, { grid: 0.25, strength: 1, swing: 0.5 });
  close(beatAtSec(sw, trans[1]), 0.25 + 0.0625, 1e-6, 'odd 16th swung');
  close(gridTarget(1.26, 0.25, 0).target, 1.25);
  // a clip that starts off the bar: grid is the timeline's
  const off = quantizeWarp({ ...clip, start: 5 }, trans, { grid: 0.25 });
  for (const s of trans) { const b = beatAtSec(off, s) + 5; close(b, Math.round(b / 0.25) * 0.25, 1e-6, 'timeline grid'); }
});

test('groove: extract from MIDI / audio, apply to notes', () => {
  // MPC-ish 16th swing: odd 16ths late by 0.04 beats, accents on 8ths
  const notes = [];
  for (let k = 0; k < 32; k++) notes.push({ id: `n${k}`, pitch: 42, start: k * 0.25 + (k % 2 ? 0.04 : 0), dur: 0.1, vel: k % 2 ? 0.5 : 1 });
  const g = grooveFromNotes(notes, { grid: 0.25, length: 1 });
  assert.equal(g.offsets.length, 4);
  g.offsets.forEach((o, i) => close(o, i % 2 ? 0.04 : 0, 1e-9));
  close(g.velocities[1], 0.5, 1e-9);
  const straight = [0, 0.25, 0.5, 0.75, 1, 1.25].map((s, i) => ({ id: `s${i}`, pitch: 60, start: s, dur: 0.2, vel: 0.8 }));
  const grooved = applyGrooveToNotes(straight, g, { strength: 1, velStrength: 1 });
  assert.deepEqual(grooved.map((n) => n.start), [0, 0.29, 0.5, 0.79, 1, 1.29]);
  assert.deepEqual(grooved.map((n) => n.vel), [1, 0.5, 1, 0.5, 1, 0.5]);
  const halfway = applyGrooveToNotes(straight, g, { strength: 0.5 });
  close(halfway[1].start, 0.27, 1e-9);
  // audio: transients through the clip warp
  const clip = { start: 0, offset: 0, warp: { markers: [{ beat: 0, sec: 0 }, { beat: 4, sec: 2 }], bpm: 120 } };
  const ga = grooveFromAudio(clip, notes.map((n) => secAtBeat(clip.warp, n.start)), { grid: 0.25, length: 1 });
  ga.offsets.forEach((o, i) => close(o, i % 2 ? 0.04 : 0, 1e-9));
  assert.deepEqual(quantizeNotes([{ start: 0.3 }, { start: 0.49 }], { grid: 0.25 }).map((n) => n.start), [0.25, 0.5]);
  assert.equal(extractGroove([], { grid: 0.5, length: 2 }).offsets.length, 4);
});
