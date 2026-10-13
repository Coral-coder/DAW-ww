import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTarget, targetString, createAutomationLane, sortPoints, normalizeLane, valueAt, segmentsInWindow,
  activeLanes, controlOverrides, hasAutomation, hasControlAutomation, toNorm, fromNorm,
  replaceRange, rampPoints, lfoPoints,
} from '../src/core/automation.js';
import { createProject, createTrack, normalizeProject } from '../src/core/model.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('parseTarget / targetString', () => {
  assert.deepEqual(parseTarget('volume'), { kind: 'volume', key: 'volume' });
  assert.deepEqual(parseTarget('pan'), { kind: 'pan', key: 'pan' });
  assert.deepEqual(parseTarget('send:bus_1'), { kind: 'send', busId: 'bus_1', key: 'bus_1' });
  assert.deepEqual(parseTarget('inst:cutoff'), { kind: 'inst', key: 'cutoff' });
  assert.deepEqual(parseTarget('fx:fx_9:mix'), { kind: 'fx', fxId: 'fx_9', key: 'mix' });
  for (const bad of ['', 'nope', 'fx:', 'fx:abc', 'fx::x', 'inst:', null, 3]) assert.equal(parseTarget(bad), null, String(bad));
  assert.equal(targetString.fx('a', 'b'), 'fx:a:b');
  assert.equal(targetString.send('x'), 'send:x');
  assert.equal(targetString.inst('k'), 'inst:k');
});

test('valueAt: hold before/after, linear between, jumps', () => {
  const pts = [{ beat: 4, value: 0 }, { beat: 8, value: 1 }, { beat: 12, value: 0.5 }];
  assert.equal(valueAt([], 3, 0.7), 0.7);
  assert.equal(valueAt(pts, 0), 0);
  assert.equal(valueAt(pts, 4), 0);
  near(valueAt(pts, 6), 0.5);
  assert.equal(valueAt(pts, 8), 1);
  near(valueAt(pts, 10), 0.75);
  assert.equal(valueAt(pts, 100), 0.5);
  // vertical jump: two points at the same beat
  const jump = [{ beat: 0, value: 0 }, { beat: 4, value: 0 }, { beat: 4, value: 1 }, { beat: 8, value: 1 }];
  assert.equal(valueAt(jump, 3.999), 0);
  assert.equal(valueAt(jump, 4), 1);
  assert.equal(valueAt(jump, 5), 1);
});

test('segmentsInWindow returns interior breakpoints + window end', () => {
  const pts = [{ beat: 0, value: 0 }, { beat: 2, value: 1 }, { beat: 4, value: 0 }];
  assert.deepEqual(segmentsInWindow(pts, 0, 1), [{ beat: 1, value: 0.5 }]);
  assert.deepEqual(segmentsInWindow(pts, 1, 3), [{ beat: 2, value: 1 }, { beat: 3, value: 0.5 }]);
  assert.deepEqual(segmentsInWindow(pts, 2, 3), [{ beat: 3, value: 0.5 }]); // point at b0 is the start value, not a segment
  assert.deepEqual(segmentsInWindow(pts, 5, 6), [{ beat: 6, value: 0 }]);
  assert.deepEqual(segmentsInWindow(pts, 3, 3), []);
  assert.deepEqual(segmentsInWindow([], 0, 1), []);
  // contiguous windows reproduce the curve
  let v = valueAt(pts, 0);
  for (let b = 0; b < 4; b += 0.37) {
    const segs = segmentsInWindow(pts, b, Math.min(4, b + 0.37));
    for (const s of segs) near(s.value, valueAt(pts, s.beat));
    v = segs.at(-1)?.value ?? v;
  }
});

test('sortPoints / normalizeLane / createAutomationLane', () => {
  const s = sortPoints([{ beat: 3, value: 1 }, { beat: 1, value: 0 }, { beat: NaN, value: 1 }, { beat: 1, value: 2 }]);
  assert.deepEqual(s, [{ beat: 1, value: 0 }, { beat: 1, value: 2 }, { beat: 3, value: 1 }]);
  const l = normalizeLane({ target: 'pan', points: [{ beat: '2', value: '0.5' }, { beat: -1, value: 0 }] });
  assert.ok(l.id);
  assert.equal(l.enabled, true);
  assert.deepEqual(l.points, [{ beat: 0, value: 0 }, { beat: 2, value: 0.5 }]);
  const c = createAutomationLane('volume', [{ beat: 4, value: 1 }, { beat: 0, value: 0 }]);
  assert.equal(c.points[0].beat, 0);
});

test('model: tracks and master get automation arrays; normalize keeps lanes', () => {
  const t = createTrack({ name: 'x' });
  assert.deepEqual(t.automation, []);
  const p = createProject();
  assert.deepEqual(p.master.automation, []);
  p.tracks.push({ ...t, automation: [{ id: 'a1', target: 'volume', points: [{ beat: 4, value: 1 }, { beat: 0, value: 0 }] }] });
  delete p.master.automation;
  const n = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(n.tracks[0].automation[0].id, 'a1');
  assert.equal(n.tracks[0].automation[0].points[0].beat, 0);
  assert.deepEqual(n.master.automation, []);
  const old = normalizeProject({ tracks: [{ id: 't', type: 'instrument' }] });
  assert.deepEqual(old.tracks[0].automation, []);
});

test('activeLanes / controlOverrides / hasAutomation', () => {
  const t = createTrack();
  t.automation = [
    createAutomationLane('volume', [{ beat: 0, value: 0 }]),
    createAutomationLane('inst:cutoff', [{ beat: 0, value: 100 }, { beat: 4, value: 500 }]),
    createAutomationLane('fx:f1:mix', [{ beat: 0, value: 1 }]),
    createAutomationLane('fx:f1:time', []),
    { ...createAutomationLane('pan', [{ beat: 0, value: 1 }]), enabled: false },
    createAutomationLane('bogus', [{ beat: 0, value: 1 }]),
  ];
  assert.equal(activeLanes(t).length, 3);
  const ov = controlOverrides(t, 2);
  assert.deepEqual(ov, { inst: { cutoff: 300 }, fx: { f1: { mix: 1 } } });
  const p = createProject();
  assert.equal(hasAutomation(p), false);
  p.tracks.push(t);
  assert.equal(hasAutomation(p), true);
  assert.equal(hasControlAutomation(p), true);
  t.automation = t.automation.slice(0, 1);
  assert.equal(hasControlAutomation(p), false);
  assert.deepEqual(controlOverrides(t, 0), { inst: null, fx: null });
});

test('toNorm / fromNorm respect log & exp curves', () => {
  const log = { min: 20, max: 20000, curve: 'log' };
  near(toNorm(log, 20), 0);
  near(toNorm(log, 20000), 1);
  near(fromNorm(log, toNorm(log, 632.455532)), 632.455532, 1e-3);
  near(toNorm(log, 632.455532), 0.5, 1e-6);
  const lin = { min: -1, max: 1 };
  near(toNorm(lin, 0), 0.5);
  near(fromNorm(lin, 0.25), -0.5);
  const exp = { min: 0, max: 4, curve: 'exp' };
  near(fromNorm(exp, toNorm(exp, 1)), 1, 1e-6);
});

test('ramp / lfo / replaceRange editing helpers', () => {
  assert.deepEqual(rampPoints(0, 16, 0, 1), [{ beat: 0, value: 0 }, { beat: 16, value: 1 }]);
  const sine = lfoPoints({ b0: 0, b1: 8, shape: 'sine', periodBeats: 4, min: 0, max: 1 });
  near(sine[0].value, 0);
  near(valueAt(sine, 2), 1, 1e-6);
  near(valueAt(sine, 4), 0, 1e-6);
  near(sine.at(-1).beat, 8);
  const sq = lfoPoints({ b0: 0, b1: 8, shape: 'square', periodBeats: 4, min: 0.2, max: 0.8 });
  near(valueAt(sq, 1), 0.8);
  near(valueAt(sq, 3), 0.2);
  near(valueAt(sq, 5), 0.8);
  const saw = lfoPoints({ b0: 0, b1: 8, shape: 'saw', periodBeats: 4 });
  near(valueAt(saw, 0), 0);
  assert.ok(valueAt(saw, 3.9) > 0.95);
  near(valueAt(saw, 4), 0);
  const tri = lfoPoints({ b0: 0, b1: 4, shape: 'triangle', periodBeats: 4 });
  near(valueAt(tri, 2), 1);
  near(valueAt(tri, 1), 0.5);
  const merged = replaceRange([{ beat: 0, value: 0 }, { beat: 5, value: 1 }, { beat: 20, value: 0 }], 4, 8, [{ beat: 4, value: 0.3 }, { beat: 8, value: 0.6 }]);
  assert.deepEqual(merged.map((x) => x.beat), [0, 4, 8, 20]);
  for (let i = 1; i < sine.length; i++) assert.ok(sine[i].beat >= sine[i - 1].beat);
  for (let i = 1; i < sq.length; i++) assert.ok(sq[i].beat >= sq[i - 1].beat);
});
