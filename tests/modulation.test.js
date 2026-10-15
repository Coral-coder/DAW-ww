// Modulation: model normalization, MSEG / LFO / step / random / envelope math, routing math, the control-rate
// runner (automation base + modulation offsets), macro automation / MIDI targets and project round trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMod, createModState, createModulator, createRoute, msegValue, curveFn, snapPoint, sanitizeMseg, lfoShapeValue,
  stepValue, randomValue, hashRandom, envState, envAdvance, envGate, followStep, routeOffset, routeExtent, combine, targetExtent,
  routesByTarget, cyclePos, modulatorValue, divBeats, hasModulation, pruneRoutes,
} from '../src/core/modulation.js';
import { parseTarget, toNorm, fromNorm, createAutomationLane, hasControlAutomation } from '../src/core/automation.js';
import { modTargetInfo, modTargets } from '../src/audio/mod/targets.js';
import { ModRunner } from '../src/audio/mod/runner.js';
import { targetInfo, targetGroups } from '../src/ui/automation-targets.js';
import { applyNorm, targetNorm } from '../src/control/targets.js';
import { snapshotTargets } from '../src/core/automation-record.js';
import { createProject, createTrack, createEffect } from '../src/core/model.js';
import { serializeProject, parseProjectFile } from '../src/io/project-file.js';
import { Store } from '../src/core/store.js';
import { MIXER_TARGETS } from '../src/core/automation.js';
import { INSTRUMENT_DEFS } from '../src/audio/defs.js';

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`);

function project() {
  const p = createProject();
  const t = createTrack({ type: 'instrument', name: 'Lead' });
  t.instrument = { type: 'synth', preset: null, params: { cutoff: 1000 } };
  const fx = createEffect('filter', {});
  t.fx = [fx];
  p.tracks.push(t);
  return { p, t, fx };
}

test('model: normalizeMod fills 8 macros, validates modulators and drops dangling routes', () => {
  assert.equal(normalizeMod(null), null);
  const m = normalizeMod({
    macros: [{ name: 'Bright', value: 2 }],
    mods: [{ id: 'm1', type: 'lfo', shape: 'zig', rate: 999, mseg: { points: [{ x: 0.5, y: 2 }] } }, { id: 'm2', type: 'bogus' }, { id: 'm3', type: 'step', steps: [2, -1, 0.5] }],
    routes: [{ src: 'm1', target: 'inst:cutoff', amount: 3 }, { src: 'm2', target: 'volume' }, { src: 'macro:0', target: 'pan', amount: 0.5 }, { src: 'macro:9', target: 'pan' }],
  });
  assert.equal(m.macros.length, 8);
  assert.deepEqual(m.macros[0], { name: 'Bright', value: 1 });
  assert.equal(m.macros[3].name, 'Macro 4');
  assert.deepEqual(m.mods.map((x) => x.id), ['m1', 'm3']);
  assert.equal(m.mods[0].shape, 'sine');
  assert.equal(m.mods[0].rate, 50);
  assert.ok(m.mods[0].mseg.points.length >= 2, 'invalid MSEG falls back to the default shape');
  assert.deepEqual(m.mods[1].steps, [1, 0, 0.5]);
  assert.deepEqual(m.routes.map((r) => [r.src, r.amount]), [['m1', 1], ['macro:0', 0.5]]);
  assert.equal(m.routes[1].min, 0, 'macro routes carry a range start');
  const s = createModState();
  assert.equal(s.macros.length, 8);
  assert.equal(createModulator('env').type, 'env');
  assert.equal(createRoute('macro:2', 'volume').min, 0);
});

test('MSEG: segments, curves, snapping and sanitizing', () => {
  const pts = [{ x: 0, y: 0, c: 0 }, { x: 0.5, y: 1, c: 0 }, { x: 1, y: 0, c: 0 }];
  close(msegValue(pts, 0.25), 0.5);
  close(msegValue(pts, 0.75), 0.5);
  close(msegValue(pts, 0.5), 1);
  const bent = [{ x: 0, y: 0 }, { x: 1, y: 1, c: 1 }];
  assert.ok(msegValue(bent, 0.25) > 0.6, 'positive curve rises fast');
  assert.ok(msegValue([{ x: 0, y: 0 }, { x: 1, y: 1, c: -1 }], 0.25) < 0.01, 'negative curve starts slow');
  close(curveFn(0.5, 0), 0.5);
  close(curveFn(1, 0.7), 1); close(curveFn(0, -0.7), 0);
  assert.deepEqual(snapPoint({ x: 0.26, y: 0.49, c: 0 }, 4), { x: 0.25, y: 0.5, c: 0 });
  const san = sanitizeMseg([{ x: 0.7, y: 0.2 }, { x: 0.2, y: 3 }, { x: 'a', y: 1 }]);
  assert.deepEqual(san.map((p) => [p.x, p.y]), [[0, 1], [1, 0.2]]);
  const step = [{ x: 0, y: 1 }, { x: 0.5, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }];
  close(msegValue(step, 0.49), 1); close(msegValue(step, 0.51), 0);
});

test('LFO / step / random / envelope / follower math', () => {
  close(lfoShapeValue('sine', 0), 0); close(lfoShapeValue('sine', 0.5), 1);
  close(lfoShapeValue('triangle', 0.25), 0.5); close(lfoShapeValue('saw', 0.3), 0.3); close(lfoShapeValue('ramp', 0.3), 0.7);
  close(lfoShapeValue('square', 0.2), 1); close(lfoShapeValue('square', 0.7), 0);
  close(lfoShapeValue('sine', 1.5), 1, 1e-9, 'wraps');
  const steps = [0, 1, 0.5, 0.25];
  close(stepValue(steps, 0.3), 1); close(stepValue(steps, 0.99), 0.25);
  close(stepValue(steps, 0.25, 0.5), 0, 1e-9, 'glide starts from the previous step');
  close(stepValue(steps, 0.25 + 0.0625, 0.5), 0.5, 1e-9, 'half way through the glide');
  assert.equal(hashRandom(7, 3), hashRandom(7, 3));
  assert.notEqual(hashRandom(7, 3), hashRandom(8, 3));
  close(randomValue(5, 2.9), randomValue(5, 2.1), 1e-12, 'sample & hold');
  close(randomValue(5, 3, 1), randomValue(5, 2.999, 0), 1e-6, 'smooth random is continuous');
  // tempo sync follows the transport beat; note retrigger restarts
  const lfo = createModulator('lfo', { sync: true, div: '1/4', shape: 'saw' });
  close(cyclePos(lfo, { t: 99, beat: 2.25, bpm: 120 }), 2.25);
  close(modulatorValue(lfo, { t: 0, beat: 2.25, bpm: 120 }), 0.25);
  close(cyclePos({ ...lfo, retrig: 'note' }, { t: 1.25, beat: 9, bpm: 120, noteT: 1 }), 0.5);
  close(cyclePos({ ...lfo, sync: false, rate: 4 }, { t: 0.5, beat: null, bpm: 120 }), 2);
  close(divBeats('1/8d'), 0.75); close(divBeats('1/4t'), 2 / 3);
  // envelope
  const env = { a: 0.1, d: 0.2, s: 0.5, r: 0.3 };
  const st = envState();
  envAdvance(st, env, 0);
  envGate(st, true);
  close(envAdvance(st, env, 0.05), 0.5, 1e-9, 'linear attack');
  close(envAdvance(st, env, 0.1), 1, 1e-9);
  close(envAdvance(st, env, 2), 0.5, 1e-6, 'sustain');
  envGate(st, false);
  assert.ok(envAdvance(st, env, 2.3) < 0.5 * 0.01);
  assert.equal(envAdvance(st, env, 5), 0);
  assert.ok(followStep(0, 1, 0.01, 0.01, 0.5) > 0.6 && followStep(1, 0, 0.01, 0.01, 0.5) > 0.97, 'fast attack, slow release');
});

test('routing math: offsets in normalized space, bipolar, macro ranges, curves, extents, clamping', () => {
  const r = { src: 'm1', amount: 0.5 };
  close(routeOffset(r, 1), 0.5); close(routeOffset(r, 0), 0);
  close(routeOffset({ ...r, bipolar: true }, 0), -0.5); close(routeOffset({ ...r, bipolar: true }, 0.5), 0);
  close(routeOffset({ ...r, curve: -1 }, 0.5), 0.5 * 0.5 ** 8);
  const m = { src: 'macro:0', min: 0.2, amount: -0.2 };
  close(routeOffset(m, 0), 0.2); close(routeOffset(m, 1), -0.2); close(routeOffset(m, 0.5), 0);
  assert.deepEqual(routeExtent(m), [-0.2, 0.2]);
  assert.deepEqual(routeExtent({ ...r, bipolar: true }), [-0.5, 0.5]);
  assert.deepEqual(routeExtent({ src: 'x', amount: -0.3 }), [-0.3, 0]);
  assert.deepEqual(targetExtent([r, { src: 'y', amount: -0.25 }]), [-0.25, 0.5]);
  close(combine(0.8, [0.5]), 1); close(combine(0.2, [-0.5]), 0); close(combine(0.5, [0.1, -0.2]), 0.4);
  // log params: an offset of 0.1 is the same musical interval anywhere on the knob
  const cutoff = INSTRUMENT_DEFS.synth.params.find((d) => d.key === 'cutoff');
  const up = (hz) => fromNorm(cutoff, combine(toNorm(cutoff, hz), [0.1])) / hz;
  close(up(200), up(2000), 1e-3);
  const t = { mod: { routes: [{ id: 'a', target: 'pan', src: 'm' }, { id: 'b', target: 'pan', src: 'n' }, { id: 'c', target: 'volume', src: 'm', enabled: false }] } };
  assert.deepEqual([...routesByTarget(t).keys()], ['pan']);
  assert.equal(routesByTarget(t).get('pan').length, 2);
  const tr = { mod: { routes: [{ target: 'pan' }, { target: 'fx:gone:mix' }] } };
  assert.equal(pruneRoutes(tr, (x) => x === 'pan'), 1);
});

test('targets: numeric instrument / effect / mixer params are modulatable', () => {
  const { p, t, fx } = project();
  const ci = modTargetInfo(p, t, 'inst:cutoff');
  assert.equal(ci.value, 1000);
  assert.equal(ci.kind, 'inst');
  assert.equal(modTargetInfo(p, t, 'inst:filterType'), null, 'enums are not modulated');
  assert.equal(modTargetInfo(p, t, 'inst:nope'), null);
  assert.equal(modTargetInfo(p, t, `fx:${fx.id}:cutoff`).kind, 'fx');
  assert.equal(modTargetInfo(p, t, 'volume').def, MIXER_TARGETS.volume);
  assert.equal(modTargetInfo(p, t, `send:${p.buses[0].id}`).kind, 'mixer');
  assert.equal(modTargetInfo(p, t, 'send:missing'), null);
  const all = modTargets(p, t);
  assert.ok(all.some((x) => x.target === 'inst:cutoff') && all.some((x) => x.target === `fx:${fx.id}:cutoff`) && all.some((x) => x.target === 'pan'));
});

// ---- runner with a minimal graph
function fakeParam(v = 0) { return { value: v, events: [], setTargetAtTime(x, t) { this.value = x; this.events.push(['target', x, t]); }, setValueAtTime(x, t) { this.value = x; this.events.push(['set', x, t]); }, cancelScheduledValues() {} }; }
function fakeGraph(p) {
  const ctx = {
    currentTime: 0,
    createConstantSource() { const n = { offset: fakeParam(0), connected: null, connect(param) { this.connected = param; param.mod = this; }, start() {}, stop() {}, disconnect() {} }; return n; },
  };
  const g = { ctx, tracks: new Map(), inst: new Map(), onError: (e) => { throw e; } };
  for (const t of p.tracks) {
    const strip = { fxOv: new Map(), fxMod: null, setFxMod(m) { this.fxMod = m; }, volume: { gain: fakeParam(t.volume) }, panner: { pan: fakeParam(t.pan) }, sends: new Map(), post: {} };
    g.tracks.set(t.id, { strip, instOv: null });
  }
  g.setModInst = (id, m) => g.inst.set(id, m);
  return g;
}

test('runner: macros and modulators offset instrument, effect and mixer params; automation sets the base', () => {
  const { p, t, fx } = project();
  t.mod = createModState();
  t.mod.macros[0].value = 1;
  const lfo = createModulator('lfo', { id: 'l1', shape: 'square', sync: false, rate: 1 });
  t.mod.mods.push(lfo);
  t.mod.routes.push(createRoute('macro:0', 'inst:cutoff', { amount: 0.1 }), createRoute('l1', 'pan', { amount: 0.5, bipolar: true }),
    createRoute('l1', `fx:${fx.id}:cutoff`, { amount: -0.2 }));
  assert.ok(hasModulation(p));
  const g = fakeGraph(p);
  const run = new ModRunner(g);
  run.tick(p, 0.1, { bpm: 120 }); // square LFO at phase 0.1 -> 1
  const cutoff = INSTRUMENT_DEFS.synth.params.find((d) => d.key === 'cutoff');
  close(g.inst.get(t.id).cutoff, fromNorm(cutoff, toNorm(cutoff, 1000) + 0.1), 0.51, 'macro offset on the instrument (integer-step param rounds)');
  const e = g.tracks.get(t.id);
  close(e.strip.panner.pan.mod.offset.value, 1, 1e-9, 'pan offset: +0.5 of the knob range = +1 (bipolar LFO high)');
  assert.ok(e.strip.fxMod[fx.id].cutoff < 1000 + 1e6, 'effect value present');
  const v = run.view(t.id);
  close(v.macros[0], 1); close(v.mods.l1, 1);
  assert.ok(v.targets['inst:cutoff'].norm > v.targets['inst:cutoff'].base);
  // automation override on the instrument param becomes the base
  e.instOv = { cutoff: 4000 };
  run.tick(p, 0.6, { bpm: 120 }); // LFO low now
  close(g.inst.get(t.id).cutoff, fromNorm(cutoff, toNorm(cutoff, 4000) + 0.1), 0.51, 'automated base + modulation');
  close(e.strip.panner.pan.mod.offset.value, -1, 1e-9);
  // macro automation lane drives the macro while automation plays
  t.automation.push(createAutomationLane('macro:0', [{ beat: 0, value: 0 }, { beat: 4, value: 0 }]));
  run.tick(p, 0.7, { bpm: 120, beat: 1, songAuto: true });
  close(g.inst.get(t.id).cutoff, 4000, 1e-3, 'macro at 0 -> no offset');
  // removing every route releases everything
  t.mod.routes = [];
  run.tick(p, 0.8, { bpm: 120 });
  assert.equal(g.inst.get(t.id), null);
  assert.equal(e.strip.fxMod, null);
  close(e.strip.panner.pan.mod.offset.value, 0);
});

test('runner: envelope modulator follows the track notes (gates queued ahead of time)', () => {
  const { p, t } = project();
  t.mod = createModState();
  t.mod.mods.push(createModulator('env', { id: 'e1', a: 0.1, d: 0.1, s: 0.5, r: 0.1 }));
  t.mod.routes.push(createRoute('e1', 'volume', { amount: -0.5 }));
  const g = fakeGraph(p);
  const run = new ModRunner(g);
  run.note(t.id, 1, true);
  run.note(t.id, 2, false);
  run.tick(p, 0.5, {});
  close(run.view(t.id).mods.e1, 0, 1e-9, 'before the note');
  run.tick(p, 1.05, {});
  close(run.view(t.id).mods.e1, 0.5, 1e-6, 'mid attack');
  run.tick(p, 1.9, {});
  close(run.view(t.id).mods.e1, 0.5, 1e-3, 'sustain');
  run.tick(p, 3, {});
  assert.ok(run.view(t.id).mods.e1 < 1e-3, 'released');
  const vol = g.tracks.get(t.id).strip.volume.gain.mod.offset;
  assert.ok(vol.events.length > 0);
  run.allOff();
});

test('macros: automation / MIDI targets, recorder snapshot, lane plays in offline control steps', () => {
  const { p, t } = project();
  assert.deepEqual(parseTarget('macro:3'), { kind: 'macro', index: 3, key: '3' });
  assert.equal(parseTarget('macro:9'), null);
  const info = targetInfo(p, t.id, 'macro:2');
  assert.equal(info.missing, false);
  assert.equal(info.label, 'Macro 3');
  assert.ok(targetGroups(p, t.id).some((g) => g.kind === 'macro' && g.items.length === 8));
  assert.ok(applyNorm(p, t.id, 'macro:2', 0.75));
  close(t.mod.macros[2].value, 0.75, 1e-3);
  close(targetNorm(p, t.id, 'macro:2'), 0.75, 1e-3);
  assert.equal(snapshotTargets(p).get(`${t.id}|macro:2`), t.mod.macros[2].value);
  t.automation.push(createAutomationLane('macro:2', [{ beat: 0, value: 1 }]));
  assert.ok(hasControlAutomation(p));
});

test('project: modulation and wavetables survive save / load; undo restores edits', () => {
  const { p, t } = project();
  t.mod = createModState();
  t.mod.macros[1] = { name: 'Space', value: 0.3 };
  t.mod.mods.push(createModulator('lfo', { id: 'l1', shape: 'mseg' }), createModulator('step', { id: 's1' }), createModulator('random', { id: 'r1', seed: 9 }), createModulator('follow', { id: 'f1' }));
  t.mod.routes.push(createRoute('l1', 'inst:cutoff', { amount: 0.3, bipolar: true, curve: 0.2 }), createRoute('macro:1', 'volume', { amount: -0.4 }));
  const back = parseProjectFile(serializeProject(p));
  assert.deepEqual(back.tracks[0].mod, normalizeMod(t.mod));
  assert.deepEqual(back.tracks[0].mod.routes.map((r) => r.target), ['inst:cutoff', 'volume']);
  const store = new Store(back);
  store.transact('Macro 2', (pp) => { pp.tracks[0].mod.macros[1].value = 0.9; });
  store.transact('Delete modulator', (pp) => { pp.tracks[0].mod.mods.pop(); });
  store.undo();
  assert.equal(store.get().tracks[0].mod.mods.length, 4);
  store.undo();
  close(store.get().tracks[0].mod.macros[1].value, 0.3);
});
