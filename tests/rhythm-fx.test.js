// Rhythm effects: pattern parsing, step envelopes, swing, curve interpolation, the beat clock (tempo maps, loops),
// repeat scheduling and the time-shaper read heads (src/audio/fx/rhythm-dsp.js), plus defs / presets / builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePattern, serializePattern, fitSteps, shiftPattern, invertPattern, randomPattern,
  stepStart, stepAt, shapeCurve, gateConfig, gateEnvAt, gateGain,
  parseCurve, serializeCurve, bend, curveAt, shaperConfig, shaperValueAt,
  beatSegments, BeatClock, hash01, repeatConfig, repeatAt, repeatStarts, sliceEnv,
  timeConfig, timeRead, timeWindowAt, manualWindowAt, speedExp, tapeAmp,
} from '../src/audio/fx/rhythm-dsp.js';
import { GATE_PATTERNS, SHAPER_CURVES, euclid } from '../src/audio/fx/rhythm-library.js';
import { EFFECT_DEFS, resolveEffectParams, divisionToBeats, getEffectDefaults } from '../src/audio/effect-defs.js';
import { TempoMap } from '../src/time/tempo-map.js';
import { createEffect } from '../src/audio/effects.js';
import { MockContext } from './lib/mock-audio.js';
import { ringSeconds } from '../src/audio/fx/builders/rhythm.js';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
const div = (d) => (d === '1/64' ? 1 / 16 : divisionToBeats(d));

// ------------------------------------------------------------------ patterns
test('parsePattern: compact, list and array forms', () => {
  assert.deepEqual(parsePattern('x-5.'), [1, 0, 0.5, 0]);
  assert.deepEqual(parsePattern('X_0x'), [1, 0, 0, 1]);
  assert.deepEqual(parsePattern('100 0 37,50'), [1, 0, 0.37, 0.5]);
  assert.deepEqual(parsePattern('x - 25'), [1, 0, 0.25]);
  assert.deepEqual(parsePattern('37,'), [0.37]);
  assert.deepEqual(parsePattern([1, 0, 0.5]), [1, 0, 0.5]);
  assert.deepEqual(parsePattern([100, 0, 50]), [1, 0, 0.5]);
  assert.deepEqual(parsePattern('250 -20'), [1, 0]); // clamped
  assert.equal(parsePattern(''), null);
  assert.equal(parsePattern('x?x'), null);
  assert.equal(parsePattern('1 a 2'), null);
  assert.equal(parsePattern(42), null);
  assert.equal(parsePattern('x'.repeat(40)).length, 32);
});

test('serializePattern round-trips and picks the compact form when it can', () => {
  assert.equal(serializePattern([1, 0, 0.5, 0.3]), 'x-53');
  assert.equal(serializePattern([1, 0, 0.37]), '100 0 37');
  assert.equal(serializePattern([0.37]), '37,');
  assert.equal(serializePattern([]), '-');
  for (const lv of [[1, 0, 1, 1], [0.12, 0.5, 1], [0.37], [0, 0, 0]]) {
    const back = parsePattern(serializePattern(lv));
    assert.deepEqual(back.map((v) => Math.round(v * 100)), lv.map((v) => Math.round(v * 100)));
  }
});

test('pattern helpers: fitSteps repeats, shift rotates, invert flips', () => {
  assert.deepEqual(fitSteps([1, 0], 5), [1, 0, 1, 0, 1]);
  assert.deepEqual(fitSteps([1, 0, 0.5, 0.2], 2), [1, 0]);
  assert.equal(fitSteps(null, 3).length, 3);
  assert.equal(fitSteps([1], 99).length, 32);
  assert.deepEqual(shiftPattern([1, 0, 0, 0], 1), [0, 1, 0, 0]);
  assert.deepEqual(shiftPattern([1, 0, 0, 0], -1), [0, 0, 0, 1]);
  assert.deepEqual(invertPattern([1, 0, 0.5]), [0, 1, 0]);
  let s = 1;
  const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const r = randomPattern(16, rng);
  assert.equal(r.length, 16);
  assert.ok(r.every((v) => v >= 0 && v <= 1));
});

test('library: at least 20 gate patterns that parse; curves parse', () => {
  assert.ok(Object.keys(GATE_PATTERNS).length >= 20);
  for (const [name, g] of Object.entries(GATE_PATTERNS)) {
    assert.ok(parsePattern(g.pattern), name);
    if (g.patternR) assert.ok(parsePattern(g.patternR), name);
  }
  for (const [name, c] of Object.entries(SHAPER_CURVES)) assert.ok(parseCurve(c), name);
  assert.equal(euclid(5, 16).split('').filter((c) => c === 'x').length, 5);
  assert.equal(euclid(3, 8).split('').filter((c) => c === 'x').length, 3);
  assert.equal(euclid(4, 16), 'x---x---x---x---');
  assert.equal(euclid(4, 16, 2), '--x---x---x---x-');
});

// ------------------------------------------------------------------ swing / step grid
test('swing pushes odd steps late; stepAt inverts stepStart', () => {
  assert.equal(stepStart(0, 0.25, 0.5), 0);
  assert.equal(stepStart(1, 0.25, 0), 0.25);
  near(stepStart(1, 0.25, 0.5), 0.3125);
  near(stepStart(1, 0.25, 1), 0.375);
  assert.equal(stepStart(2, 0.25, 1), 0.5); // even steps stay on the grid
  for (const swing of [0, 0.3, 1]) {
    for (let k = 0; k < 16; k++) {
      const s = stepStart(k, 0.25, swing);
      assert.equal(stepAt(s + 1e-7, 16, 0.25, swing), k, `swing ${swing} step ${k}`);
    }
  }
  // just before the delayed odd step we are still in the (longer) even step
  assert.equal(stepAt(0.3, 16, 0.25, 0.5), 0);
  assert.equal(stepAt(0.32, 16, 0.25, 0.5), 1);
});

test('shapeCurve: endpoints fixed, sign selects fast / slow', () => {
  for (const c of [-1, -0.3, 0, 0.5, 1]) {
    near(shapeCurve(0, c), 0); near(shapeCurve(1, c), 1);
  }
  assert.equal(shapeCurve(0.5, 0), 0.5);
  assert.ok(shapeCurve(0.5, 1) > 0.9);
  assert.ok(shapeCurve(0.5, -1) < 0.1);
});

// ------------------------------------------------------------------ gate envelope
const gcfg = (o = {}) => gateConfig({ pattern: 'x-', steps: 16, division: '1/16', length: 1, attack: 0.001, release: 0.001, curve: 0, swing: 0, depth: 1, ...o }, divisionToBeats);

test('gate envelope: on / off steps, attack ramp and release tail', () => {
  const bps = 2; // 120 bpm
  const g = gcfg({ length: 0.5, attack: 0.01, release: 0.02 });
  assert.equal(g.n, 16);
  assert.equal(g.L.length, 16);
  // step 0 (on): attack over 0.01 s = 0.02 beats
  near(gateEnvAt(0, g.L, g, bps), 0);
  near(gateEnvAt(0.01, g.L, g, bps), 0.5, 1e-9);
  near(gateEnvAt(0.05, g.L, g, bps), 1);
  // hold ends at 0.5 * 0.25 = 0.125 beats, release 0.02 s = 0.04 beats
  near(gateEnvAt(0.125 + 0.02, g.L, g, bps), 0.5, 1e-9);
  near(gateEnvAt(0.125 + 0.05, g.L, g, bps), 0);
  // step 1 is off
  near(gateEnvAt(0.3, g.L, g, bps), 0);
  // the pattern cycle repeats every 16 steps (4 beats) and is anchored to song beat 0, negatives too
  near(gateEnvAt(4.05, g.L, g, bps), gateEnvAt(0.05, g.L, g, bps));
  near(gateEnvAt(-3.95, g.L, g, bps), gateEnvAt(0.05, g.L, g, bps));
});

test('gate envelope: a release tail reaches into the next (off) step', () => {
  const g = gcfg({ length: 1, release: 0.05 }); // release 0.1 beats > 0 so it crosses into step 1
  const v = gateEnvAt(0.25 + 0.05, g.L, g, 2);
  near(v, 0.5, 1e-9);
  // and wraps around the cycle end: last step on
  const g2 = gateConfig({ pattern: '-x', steps: 2, division: '1/4', length: 1, attack: 0.0003, release: 0.5 }, divisionToBeats);
  assert.ok(gateEnvAt(0.25, g2.L, g2, 2) > 0.7); // tail of step 1 (beat 1..2) into step 0 of the next cycle
});

test('gate envelope: per-step levels, legato and depth', () => {
  const g = gateConfig({ pattern: 'x5', steps: 2, division: '1/4', length: 1, attack: 0.0003, release: 0.0003, legato: false }, divisionToBeats);
  near(gateEnvAt(0.5, g.L, g, 2), 1);
  near(gateEnvAt(1.5, g.L, g, 2), 0.5);
  // without legato the gate re-attacks (dips) at the step boundary; with legato it glides from 1 to 0.5
  const gl = gateConfig({ pattern: 'x5', steps: 2, division: '1/4', length: 0.5, attack: 0.1, release: 0.0003, legato: true }, divisionToBeats);
  const atBoundary = gateEnvAt(1 + 1e-6, gl.L, gl, 2);
  assert.ok(atBoundary > 0.99, `legato keeps the level (${atBoundary})`);
  const gn = { ...gl, legato: false };
  assert.ok(gateEnvAt(1 + 0.01, gn.L, gn, 2) < 0.2);
  assert.equal(gateGain(0, 1), 0);
  assert.equal(gateGain(0, 0.25), 0.75);
  assert.equal(gateGain(1, 0.7), 1);
});

test('gate envelope: swing delays the odd step onset', () => {
  const g = gateConfig({ pattern: '-x', steps: 16, division: '1/16', length: 1, attack: 0.0003, release: 0.0003, swing: 0.5 }, divisionToBeats);
  near(gateEnvAt(0.28, g.L, g, 2), 0); // straight onset would be 0.25
  near(gateEnvAt(0.33, g.L, g, 2), 1);
});

test('gate stereo modes', () => {
  const off = gcfg({ stereo: 'offset', stereoOffset: 1 });
  assert.deepEqual(off.R.slice(0, 4), [0, 1, 0, 1]);
  assert.equal(off.stereoSame, false);
  const inv = gcfg({ stereo: 'invert' });
  assert.deepEqual(inv.R.slice(0, 2), [0, 1]);
  const sep = gcfg({ stereo: 'separate', patternR: 'xx--' });
  assert.deepEqual(sep.R.slice(0, 4), [1, 1, 0, 0]);
  const sepEmpty = gcfg({ stereo: 'separate', patternR: '' });
  assert.deepEqual(sepEmpty.R, sepEmpty.L);
  assert.equal(gcfg().stereoSame, true);
});

// ------------------------------------------------------------------ curves
test('parseCurve sorts points (stable for vertical edges) and serializes back', () => {
  const pts = parseCurve('0.5,1 0,0,0.5 0.5,0');
  assert.deepEqual(pts.map((p) => [p.x, p.y]), [[0, 0], [0.5, 1], [0.5, 0]]);
  assert.equal(pts[0].t, 0.5);
  assert.equal(parseCurve('nope'), null);
  assert.equal(parseCurve(''), null);
  assert.deepEqual(parseCurve(serializeCurve(pts)), pts);
  assert.equal(serializeCurve([{ x: 0.123456, y: 1, t: 0 }]), '0.1235,1');
});

test('bend: identity at 0 tension, endpoints fixed, monotonic', () => {
  near(bend(0.3, 0), 0.3);
  for (const t of [-1, -0.4, 0.4, 1]) {
    near(bend(0, t), 0); near(bend(1, t), 1);
    let prev = -1;
    for (let u = 0; u <= 1; u += 0.05) { const v = bend(u, t); assert.ok(v >= prev - 1e-12); prev = v; }
  }
  assert.ok(bend(0.5, 1) < 0.5); // positive tension: slow start
  assert.ok(bend(0.5, -1) > 0.5);
});

test('curveAt: linear interpolation, tension, wrap-around and vertical edges', () => {
  const saw = parseCurve('0,0 1,1');
  near(curveAt(saw, 0.25), 0.25);
  near(curveAt(saw, 1.25), 0.25); // phase wraps
  const tri = parseCurve('0,0 0.5,1');
  near(curveAt(tri, 0.25), 0.5);
  near(curveAt(tri, 0.75), 0.5); // last point back to the first one of the next cycle
  const gate = parseCurve('0.25,1 0.5,1 0.5,0 0.75,0');
  near(curveAt(gate, 0.4), 1);
  near(curveAt(gate, 0.5), 0); // two points at the same x: the later one wins from that x on
  near(curveAt(gate, 0.6), 0);
  near(curveAt(gate, 0.1), 0.7, 1e-9); // wrap segment 0.75 -> 1.25: 0 -> 1
  const tens = parseCurve('0,0,0.8 1,1');
  assert.ok(curveAt(tens, 0.5) < 0.25);
  assert.equal(curveAt(parseCurve('0.3,0.7'), 0.9), 0.7);
  assert.equal(curveAt([], 0.5), 1);
});

test('volume shaper value: length, phase offset and depth', () => {
  const s = shaperConfig({ shape: '0,0 1,1', length: '1/4', depth: 1, offset: 0 }, div);
  near(shaperValueAt(0.5, s), 0.5);
  near(shaperValueAt(3.25, s), 0.25);
  const s2 = shaperConfig({ shape: '0,0 1,1', length: '1/1', depth: 0.5, offset: 0.5 }, div);
  near(shaperValueAt(0, s2), 0.75); // phase 0.5 -> y 0.5 -> 1 - 0.5 * 0.5
  near(shaperValueAt(2, s2), 0.5); // phase 0.5 + 0.5 -> wraps to 0 -> y 0
});

// ------------------------------------------------------------------ beat clock
test('beatSegments: constant tempo is one segment; stopped transport is null', () => {
  const segs = beatSegments((t) => 3 + t * 2, 0.5);
  assert.equal(segs.length, 1);
  near(segs[0].beat, 4); near(segs[0].bps, 2);
  assert.equal(beatSegments(() => null, 0), null);
});

test('beatSegments follows a tempo map exactly (jumps and ramps)', () => {
  const map = new TempoMap({ bpm: 120, points: [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90, curve: 'linear' }, { beat: 16, bpm: 140 }, { beat: 24, bpm: 100 }] });
  const getBeatAt = (t) => map.beatAt(t);
  const segs = beatSegments(getBeatAt, 0, { horizon: 30 });
  assert.ok(segs.length > 3 && segs.length < 4000, `segments ${segs.length}`);
  const clock = new BeatClock(120, 48000);
  clock.set(BeatClock.fromSeconds(segs, 48000));
  for (let t = 0; t < 30; t += 0.0371) {
    near(clock.beatAt(t * 48000), map.beatAt(t), 2e-5, `t=${t.toFixed(3)}`);
  }
  // the tempo jump at beat 8 (4 s) is located within 2 ms
  near(clock.beatAt(4 * 48000), 8, 1e-6);
  near(clock.beatAt(4.001 * 48000), map.beatAt(4.001), 1e-6);
});

test('BeatClock: later syncs replace the future only; free-run continues the beat', () => {
  const sr = 1000;
  const c = new BeatClock(120, sr);
  near(c.beatAt(500), 1); // 120 bpm free from frame 0
  // a loop wrap at t = 2 s jumps back to beat 0
  c.set([{ f: 2000, beat: 0, bpf: 2 / sr }]);
  near(c.beatAt(1999), 3.998);
  near(c.beatAt(2000), 0);
  near(c.beatAt(2500), 1);
  c.free(3000, 60); // stop: continue from beat 2 at 60 bpm
  near(c.beatAt(3000), 2);
  near(c.beatAt(4000), 3);
  c.prune(3500);
  assert.equal(c.segs.length, 1);
  near(c.beatAt(4000), 3);
  // back-in-time lookups after the index moved forward still work
  const d = new BeatClock(120, sr);
  d.set([{ f: 0, beat: 0, bpf: 0.002 }, { f: 1000, beat: 10, bpf: 0.002 }]);
  near(d.beatAt(1500), 11);
  near(d.beatAt(500), 1);
});

test('beat clock round trip with a looping transport (scheduler-like anchors)', () => {
  // loop beats 4..8 at 120 bpm: anchors every 2 s
  const getBeatAt = (t) => (t < 0 ? null : 4 + ((t * 2) % 4));
  const segs = beatSegments(getBeatAt, 0, { horizon: 1.9 });
  assert.equal(segs.length, 1); // until the next wrap (sync() is called at every wrap)
  const after = beatSegments(getBeatAt, 2);
  near(after[0].beat, 4);
});

// ------------------------------------------------------------------ beat repeat
const rcfg = (o = {}) => repeatConfig({ interval: '1/1', offset: 12, gate: 4, grid: '1/16', chance: 1, decay: 0, pitch: 0, mode: 'insert', seed: 0, ...o }, div);

test('repeat scheduling: capture point, slices, gate end', () => {
  const c = rcfg();
  assert.equal(repeatAt(2.9, c), null);
  const a = repeatAt(3, c);
  assert.equal(a.start, 3); assert.equal(a.n, 0); near(a.delay, 0); // first slice = the live signal
  const b = repeatAt(3.3, c); // 1/16 grid: slice 1, pos 0.05
  assert.equal(b.n, 1); near(b.pos, 0.05); near(b.delay, 0.25);
  const d = repeatAt(3.99, c);
  assert.equal(d.n, 3); near(d.delay, 0.75);
  assert.equal(repeatAt(4.01, c), null); // gate (4/16 = 1 beat) over
  assert.equal(repeatAt(7.5, c).start, 7); // next bar
  assert.deepEqual(repeatStarts(0, 12, c), [3, 7, 11]);
  // a gate longer than the interval keeps repeating into the next interval
  const long = rcfg({ interval: '1/4', offset: 0, gate: 8, grid: '1/8' });
  assert.equal(repeatAt(1.6, long).start, 1); // newest repeat wins
});

test('repeat: decay and pitch-down per repeat', () => {
  const c = rcfg({ decay: 0.5, pitch: -12 });
  const s2 = repeatAt(3.5 + 0.1, c); // slice 2, pos 0.1
  assert.equal(s2.n, 2);
  near(s2.gain, 0.25);
  near(s2.rate, 0.25); // two octaves down
  near(s2.delay, 0.6 - 0.1 * 0.25);
  const s1 = repeatAt(3.25, c);
  near(s1.gain, 0.5); near(s1.rate, 0.5);
});

test('repeat chance is deterministic per interval (same live and in exports)', () => {
  const c = rcfg({ chance: 0.5, seed: 3 });
  const hits = repeatStarts(0, 400, c).length;
  assert.ok(hits > 30 && hits < 70, `hits ${hits}`);
  assert.deepEqual(repeatStarts(0, 400, c), repeatStarts(0, 400, c));
  assert.notDeepEqual(repeatStarts(0, 400, c), repeatStarts(0, 400, rcfg({ chance: 0.5, seed: 4 })));
  assert.equal(repeatStarts(0, 40, rcfg({ chance: 0 })).length, 0);
  for (let k = -5; k < 50; k++) { const h = hash01(k, 1); assert.ok(h >= 0 && h < 1); }
});

test('repeat offset is clamped inside the interval; slice envelope declicks', () => {
  const c = rcfg({ interval: '1/4', offset: 12 });
  assert.ok(c.offset < c.interval);
  near(sliceEnv(0, 0.25, 0.01, 0), 1); // first slice continues the live signal: no fade in
  near(sliceEnv(0, 0.25, 0.01, 2), 0);
  near(sliceEnv(0.005, 0.25, 0.01, 2), 0.5);
  near(sliceEnv(0.245, 0.25, 0.01, 2), 0.5);
});

// ------------------------------------------------------------------ time shaper
test('tape stop / start read heads: continuous start, speed curve, lag', () => {
  for (const p of [0.25, 1, 4]) {
    const r0 = timeRead('tapestop', 0, 100, p);
    near(r0.delay, 0); near(r0.rate, 1);
    const r1 = timeRead('tapestop', 1, 100, p);
    near(r1.rate, 0);
    near(r1.delay, 100 - 100 / (p + 1));
    let prev = -1;
    for (let u = 0; u <= 1; u += 0.05) { const d = timeRead('tapestop', u, 100, p).delay; assert.ok(d >= prev - 1e-9); prev = d; }
    // numeric check: d(delay)/du = len * (1 - rate)
    const u = 0.4, h = 1e-5;
    const dd = (timeRead('tapestop', u + h, 100, p).delay - timeRead('tapestop', u - h, 100, p).delay) / (2 * h);
    near(dd, 100 * (1 - timeRead('tapestop', u, 100, p).rate), 1e-3);
    const s0 = timeRead('tapestart', 0, 100, p);
    near(s0.delay, 0); near(s0.rate, 0);
    near(timeRead('tapestart', 1, 100, p).rate, 1);
  }
  near(speedExp(0), 1); near(speedExp(1), 4); near(speedExp(-1), 0.25);
  near(timeRead('reverse', 0.5, 100).delay, 100);
  near(timeRead('halfspeed', 0.5, 100).delay, 25);
  assert.equal(tapeAmp(0), 0); assert.equal(tapeAmp(1), 1);
});

test('time windows: end / start of every N bars, tape start after the stop', () => {
  const c = timeConfig({ mode: 'tapestop', trigger: 'sync', every: 1, length: '1/4', align: 'end', tapeStart: true, startLength: '1/8' }, div);
  assert.equal(c.every, 4);
  assert.equal(timeWindowAt(2.9, c), null);
  const w = timeWindowAt(3.5, c);
  assert.equal(w.mode, 'tapestop'); near(w.u, 0.5); assert.equal(w.start, 3);
  const s = timeWindowAt(4.25, c); // next bar starts with the tape start
  assert.equal(s.mode, 'tapestart'); near(s.u, 0.5);
  assert.equal(timeWindowAt(4.6, c), null);
  const st = timeConfig({ mode: 'halfspeed', every: 2, length: '1/1', align: 'start' }, div);
  assert.equal(timeWindowAt(1, st).start, 0);
  assert.equal(timeWindowAt(5, st), null);
  assert.equal(timeWindowAt(9, st).start, 8);
  // manual trigger ignores the grid windows
  const m = timeConfig({ mode: 'reverse', trigger: 'manual', length: '1/8' }, div);
  assert.equal(timeWindowAt(3.9, m), null);
  assert.equal(manualWindowAt(10.2, 10, m).mode, 'reverse');
  assert.equal(manualWindowAt(10.6, 10, m), null);
  assert.equal(manualWindowAt(9, 10, m), null);
  assert.equal(manualWindowAt(9, null, m), null);
});

// ------------------------------------------------------------------ defs / params / builders
test('rhythm defs: category, pattern params resolve as strings, presets reference real params', () => {
  for (const t of ['trancegate', 'volshaper', 'beatrepeat', 'timeshaper']) {
    const def = EFFECT_DEFS[t];
    assert.equal(def.category, 'Rhythm');
    const keys = new Set(def.params.map((p) => p.key));
    assert.ok(Object.keys(def.presets).length >= 10, `${t} presets`);
    for (const [name, preset] of Object.entries(def.presets)) {
      for (const k of Object.keys(preset)) assert.ok(keys.has(k), `${t} preset ${name}: ${k}`);
      const r = resolveEffectParams({ type: t, params: preset });
      for (const p of def.params) if (p.type === 'enum' && preset[p.key] !== undefined) assert.equal(String(r[p.key]), String(preset[p.key]), `${t}/${name}/${p.key}`);
    }
  }
  assert.ok(Object.keys(EFFECT_DEFS.trancegate.presets).length >= 20);
  const r = resolveEffectParams({ type: 'trancegate', params: { pattern: [100, 0, 50], patternR: null, steps: '8' } });
  assert.equal(r.pattern, '100 0 50');
  assert.equal(r.patternR, '');
  assert.equal(r.steps, 8);
  assert.equal(resolveEffectParams({ type: 'trancegate', params: { pattern: { bad: 1 } } }).pattern, getEffectDefaults('trancegate').pattern);
  assert.equal(resolveEffectParams({ type: 'volshaper', params: { shape: 'x'.repeat(5000) } }).shape.length, 4096);
  // JSON (save / undo / duplicate) keeps the pattern intact
  const fx = { type: 'trancegate', params: { pattern: 'x-5-x--x', steps: 8 } };
  assert.deepEqual(resolveEffectParams(JSON.parse(JSON.stringify(fx))), resolveEffectParams(fx));
});

test('builders: every rhythm effect builds, syncs and exposes a probe (no-worklet fallback)', async () => {
  const ctx = new MockContext();
  let playing = true;
  const getBeatAt = (t) => (playing ? 16 + t * 2 : null);
  for (const t of ['trancegate', 'volshaper', 'beatrepeat', 'timeshaper']) {
    const fx = createEffect(ctx, { type: t, params: {} }, { getBpm: () => 120, getBeatAt });
    assert.equal(await fx.ready, true);
    assert.equal(fx.probe.kind, t);
    assert.equal(fx.probe.mode, 'fallback');
    near(fx.probe.beat(), 16, 0.1);
    fx.sync(1);
    near(fx.probe.beat(), 16, 0.1);
    fx.setTempo(140);
    for (const p of Object.values(EFFECT_DEFS[t].presets)) fx.update({ type: t, params: p, enabled: true });
    fx.dispose();
  }
  const gate = createEffect(ctx, { type: 'trancegate', params: {} }, { getBpm: () => 120, getBeatAt });
  await gate.ready;
  assert.equal(gate.probe.step(), stepAt(0, 16, 0.25, 0));
  // the native fallback loops a gain buffer started at the clock's phase
  const started = ctx.started.filter((s) => s.src.buffer?.numberOfChannels === 2);
  assert.ok(started.length > 0);
  const br = createEffect(ctx, { type: 'beatrepeat', params: { chance: 0 } }, { getBpm: () => 120, getBeatAt });
  await br.ready;
  assert.equal(br.probe.state().active, false);
  br.probe.hold(true);
  assert.equal(br.probe.holding, true);
  br.probe.hold(false);
  assert.equal(br.probe.holding, false);
  playing = false;
  const ts = createEffect(ctx, { type: 'timeshaper', params: { trigger: 'manual' } }, { getBpm: () => 120, getBeatAt });
  await ts.ready;
  ts.probe.trigger();
  assert.equal(ts.probe.playing(), false);
});

test('ring buffer size covers the longest read-back', () => {
  const tc = timeConfig({ mode: 'reverse', every: 8, length: '2/1' }, div);
  assert.ok(ringSeconds('timeshaper', tc, 60) >= 2 * 8 * 1); // reverse reads 2 x 8 beats at 1 s/beat
  assert.ok(ringSeconds('beatrepeat', rcfg({ grid: '1/4' }), 30) >= 2);
  assert.ok(ringSeconds('timeshaper', tc, 5) <= 48);
});

test('song code: rhythm effects become a comment (trance gate with its .struct rhythm) and the code still runs', async () => {
  const { songToCode, applySongCode, rhythmFxComment } = await import('../src/code/song-code.js');
  const { evaluate } = await import('../src/code/strudel.js');
  const { createProject, createEffect: createFx } = await import('../src/core/model.js');
  const { generateSong } = await import('../src/gen/song.js');
  assert.equal(rhythmFxComment({ fx: [] }), '');
  const c = rhythmFxComment({ fx: [createFx('trancegate', { pattern: 'x-x-', steps: 16 }), createFx('beatrepeat', {})] });
  assert.match(c, /Trance Gate ≈ \.struct\("x ~ x ~ x ~ x ~ x ~ x ~ x ~ x ~"\)/);
  assert.match(c, /Beat Repeat/);
  assert.equal(rhythmFxComment({ fx: [{ ...createFx('trancegate', {}), enabled: false }] }), '');
  assert.doesNotMatch(rhythmFxComment({ fx: [createFx('trancegate', { steps: 12, division: '1/8T' })] }), /struct/);
  for (const mode of ['pattern', 'song']) {
    const p = { ...createProject(), ...generateSong({ genre: 'trance', seed: 3 }), mode };
    const t = p.tracks.find((x) => x.type === 'instrument');
    t.fx = [...(t.fx || []), createFx('trancegate', { pattern: 'xx-xx-x-xx-xx-x-' }), createFx('volshaper', {}), createFx('timeshaper', {})];
    const { code } = songToCode(p);
    assert.match(code, /daW³ rhythm FX \(not expressible as code\): Trance Gate/);
    assert.equal(evaluate(code).error, null);
    const r = applySongCode(p, code);
    assert.equal(r.error, null);
    assert.equal(r.changed, false, `${mode}: unchanged code applies as a no-op`);
  }
});
