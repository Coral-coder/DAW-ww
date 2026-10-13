import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTarget, targetString, laneDef, encodeParam, decodeParam, mergeParamOverrides, readParam,
  controlOverrides, cableOverrides, hasAutomation, hasControlAutomation, hasMuteLane, automationOwner, createAutomationLane, valueAt,
} from '../src/core/automation.js';
import {
  snapshotTargets, diffTargets, pushThinned, simplifyPoints, mergeTake, AutomationTake, keyOf, splitKey, flattenParams,
} from '../src/core/automation-record.js';
import { createProject, createTrack, createEffect, normalizeProject } from '../src/core/model.js';
import { isTrackPlayable } from '../src/audio/scheduler.js';
import { resolveInstrumentDef } from '../src/audio/presets.js';
import { resolveEffectParams } from '../src/audio/effect-defs.js';
import { targetInfo, targetGroups, laneLabel } from '../src/ui/automation-targets.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('parseTarget: mute / fxen / cable / nested inst keys', () => {
  assert.deepEqual(parseTarget('mute'), { kind: 'mute', key: 'mute' });
  assert.deepEqual(parseTarget('fxen:fx_1'), { kind: 'fxen', fxId: 'fx_1', key: 'enabled' });
  assert.deepEqual(parseTarget('cable:cb_2'), { kind: 'cable', cableId: 'cb_2', key: 'cb_2' });
  assert.deepEqual(parseTarget('inst:pads.kick.tune'), { kind: 'inst', key: 'pads.kick.tune' });
  assert.deepEqual(parseTarget('fx:fx_3:values./a/b'), { kind: 'fx', fxId: 'fx_3', key: 'values./a/b' });
  for (const bad of ['fxen:', 'cable:', 'mutex']) assert.equal(parseTarget(bad), null, bad);
  assert.equal(targetString.fxen('a'), 'fxen:a');
  assert.equal(targetString.cable('c'), 'cable:c');
  assert.equal(targetString.mute(), 'mute');
});

test('encode / decode enum + bool params, laneDef', () => {
  const en = { key: 'type', type: 'enum', options: [{ value: 'lowpass' }, { value: 'highpass' }, { value: 'bandpass' }], default: 'lowpass' };
  assert.equal(encodeParam(en, 'highpass'), 1);
  assert.equal(encodeParam(en, 'nope'), null);
  assert.equal(decodeParam(en, 1.4), 'highpass');
  assert.equal(decodeParam(en, 9), 'bandpass');
  const ld = laneDef(en);
  assert.equal(ld.min, 0); assert.equal(ld.max, 2); assert.equal(ld.stepped, true);
  const b = { key: 'sync', type: 'bool', default: false };
  assert.equal(encodeParam(b, true), 1);
  assert.equal(decodeParam(b, 0.6), true);
  assert.equal(decodeParam(b, 0.2), false);
  assert.equal(encodeParam(null, false), 0);
  assert.equal(encodeParam(null, 0.5), 0.5);
});

test('mergeParamOverrides / readParam handle drum pads and Faust values without mutating', () => {
  const params = { cutoff: 100, pads: { kick: { tune: 1, sampleId: 's' }, snare: { gain: 1 } }, values: { '/x': 1 } };
  const out = mergeParamOverrides(params, { cutoff: 200, 'pads.kick.decay': 2, 'pads.hihat.tune': -3, 'values./y': 0.5 });
  assert.equal(out.cutoff, 200);
  assert.deepEqual(out.pads.kick, { tune: 1, sampleId: 's', decay: 2 });
  assert.deepEqual(out.pads.hihat, { tune: -3 });
  assert.deepEqual(out.values, { '/x': 1, '/y': 0.5 });
  assert.deepEqual(params.pads.kick, { tune: 1, sampleId: 's' }, 'source untouched');
  assert.equal(readParam(out, 'pads.kick.decay'), 2);
  assert.equal(readParam(out, 'values./y'), 0.5);
  assert.equal(readParam(out, 'cutoff'), 200);
});

test('controlOverrides: fxen lanes, cable lanes, bus & master owners', () => {
  const p = createProject();
  const t = createTrack({ name: 'T' });
  const fx = createEffect('filter');
  t.fx.push(fx);
  t.automation = [createAutomationLane(`fxen:${fx.id}`, [{ beat: 0, value: 0 }]), createAutomationLane('cable:c1', [{ beat: 0, value: 0.5 }])];
  p.tracks.push(t);
  const ov = controlOverrides(t, 1);
  assert.equal(ov.fx[fx.id].__en, 0);
  assert.deepEqual(cableOverrides(t, 1), { c1: 0.5 });
  assert.equal(hasControlAutomation(p), true);
  const p2 = normalizeProject(createProject());
  assert.deepEqual(p2.buses[0].automation, []);
  assert.equal(hasAutomation(p2), false);
  p2.buses[0].automation.push(createAutomationLane('volume', [{ beat: 0, value: 0.2 }]));
  assert.equal(hasAutomation(p2), true);
  assert.equal(hasControlAutomation(p2), false);
  p2.master.automation.push(createAutomationLane(`fx:${p2.master.fx[0].id}:threshold`, [{ beat: 0, value: -6 }]));
  assert.equal(hasControlAutomation(p2), true);
  assert.equal(automationOwner(p2, 'master'), p2.master);
  assert.equal(automationOwner(p2, p2.buses[1].id), p2.buses[1]);
});

test('mute lanes keep a muted track playing in song mode only', () => {
  const p = createProject();
  const t = createTrack({ name: 'T' });
  t.mute = true;
  p.tracks.push(t);
  assert.equal(isTrackPlayable(p, t, 'song'), false);
  t.automation = [createAutomationLane('mute', [{ beat: 0, value: 0 }])];
  assert.equal(hasMuteLane(t), true);
  assert.equal(isTrackPlayable(p, t, 'song'), true);
  assert.equal(isTrackPlayable(p, t, 'pattern'), false);
  const other = createTrack({ name: 'O' });
  other.solo = true;
  p.tracks.push(other);
  assert.equal(isTrackPlayable(p, t, 'song'), false, 'solo elsewhere still silences it');
});

function demoProject() {
  const p = createProject();
  const t = createTrack({ name: 'Lead', instrument: { type: 'synth', preset: null, params: {} } });
  t.fx.push(createEffect('filter', { cutoff: 1000 }));
  const d = createTrack({ name: 'Drums', instrument: { type: 'drums', preset: null, params: { pads: { kick: { tune: 0 } } } } });
  p.tracks.push(t, d);
  return p;
}
const snapOpts = { resolveInst: resolveInstrumentDef, resolveFx: resolveEffectParams };

test('snapshot + diff: every kind of setting, one entry per changed target', () => {
  const p = demoProject();
  const [t, d] = p.tracks;
  const s0 = snapshotTargets(p, snapOpts);
  assert.ok(s0.has(keyOf(t.id, 'volume')));
  assert.ok(s0.has(keyOf(t.id, `fx:${t.fx[0].id}:cutoff`)));
  assert.ok(s0.has(keyOf(t.id, `fxen:${t.fx[0].id}`)));
  assert.ok(s0.has(keyOf(t.id, 'inst:cutoff')));
  assert.ok(s0.has(keyOf(d.id, 'inst:pads.kick.tune')));
  assert.ok(s0.has(keyOf(p.buses[0].id, 'volume')));
  assert.ok(s0.has(keyOf('master', 'volume')));
  const q = structuredClone(p);
  const [t2, d2] = q.tracks;
  t2.volume = 0.5; t2.mute = true; t2.sends[q.buses[0].id] = 0.3;
  t2.fx[0].params.cutoff = 400; t2.fx[0].enabled = false;
  t2.instrument.params.cutoff = 900;
  d2.instrument.params.pads.kick.tune = 3;
  q.buses[1].pan = 0.4; q.master.volume = 0.7;
  q.master.fx[0].params.threshold = -6;
  const diffs = diffTargets(s0, snapshotTargets(q, snapOpts));
  const got = new Set(diffs.map((x) => x.key));
  for (const k of [keyOf(t.id, 'volume'), keyOf(t.id, 'mute'), keyOf(t.id, `send:${q.buses[0].id}`), keyOf(t.id, `fx:${t.fx[0].id}:cutoff`),
    keyOf(t.id, `fxen:${t.fx[0].id}`), keyOf(t.id, 'inst:cutoff'), keyOf(d.id, 'inst:pads.kick.tune'), keyOf(q.buses[1].id, 'pan'),
    keyOf('master', 'volume'), keyOf('master', `fx:${q.master.fx[0].id}:threshold`)]) assert.ok(got.has(k), k);
  assert.equal(diffs.length, 10);
  const vol = diffs.find((x) => x.target === 'volume' && x.owner === t.id);
  assert.equal(vol.prev, 0.8); assert.equal(vol.next, 0.5);
});

test('diff ignores new tracks / effects / instrument swaps but sees new Faust values', () => {
  const p = demoProject();
  const s0 = snapshotTargets(p, snapOpts);
  const q = structuredClone(p);
  q.tracks.push(createTrack({ name: 'New' }));
  q.tracks[0].fx.push(createEffect('reverb'));
  q.tracks[1].instrument = { type: 'synth', preset: null, params: { cutoff: 300 } };
  assert.deepEqual(diffTargets(s0, snapshotTargets(q, snapOpts)), []);
  const f = createEffect('faust', { code: 'x', values: {} });
  const r = structuredClone(p);
  r.tracks[0].fx.push(f);
  const s1 = snapshotTargets(r, snapOpts);
  const r2 = structuredClone(r);
  r2.tracks[0].fx[1].params.values['/gain'] = 0.3;
  const d = diffTargets(s1, snapshotTargets(r2, snapOpts));
  assert.equal(d.length, 1);
  assert.equal(d[0].target, `fx:${f.id}:values./gain`);
  assert.equal(d[0].prev, undefined);
  assert.deepEqual(flattenParams({ a: 1, b: { c: 1 }, pads: { k: { t: 2 } } }), { a: 1, 'pads.k.t': 2 });
  assert.deepEqual(splitKey('trk_1|fx:a:b'), { owner: 'trk_1', target: 'fx:a:b' });
});

test('pushThinned drops points closer than 1/32 beat unless the value jumps', () => {
  const pts = [];
  pushThinned(pts, { beat: 0, value: 0 });
  pushThinned(pts, { beat: 0.1, value: 0.1 });
  pushThinned(pts, { beat: 0.11, value: 0.12 }, { jump: 0.05 });
  assert.equal(pts.length, 2);
  near(pts[1].value, 0.12);
  pushThinned(pts, { beat: 0.115, value: 0.9 }, { jump: 0.05 });
  assert.equal(pts.length, 3, 'a jump is kept');
  pushThinned(pts, { beat: 0.5, value: 0.9 });
  assert.equal(pts.length, 4);
});

test('simplifyPoints (RDP) keeps the shape with few points and keeps vertical jumps', () => {
  const line = Array.from({ length: 101 }, (_, i) => ({ beat: i / 10, value: i / 100 }));
  assert.equal(simplifyPoints(line, 0.001).length, 2);
  const vee = Array.from({ length: 101 }, (_, i) => ({ beat: i / 10, value: Math.abs(i - 50) / 50 }));
  const sv = simplifyPoints(vee, 0.001);
  assert.equal(sv.length, 3);
  near(sv[1].beat, 5);
  const sine = Array.from({ length: 400 }, (_, i) => ({ beat: i / 50, value: 0.5 + 0.5 * Math.sin(i / 20) }));
  const ss = simplifyPoints(sine, 0.005);
  assert.ok(ss.length < 100 && ss.length > 5, String(ss.length)); // 400 -> ~80 for 3 full-range cycles
  for (let b = 0; b < 7.9; b += 0.13) near(valueAt(ss, b), valueAt(sine, b), 0.006);
  const jump = [{ beat: 0, value: 0 }, { beat: 1, value: 0 }, { beat: 1, value: 1 }, { beat: 2, value: 1 }];
  assert.equal(simplifyPoints(jump, 0.01).length, 4);
});

test('mergeTake: touch punch replaces only the written span and resumes the lane', () => {
  const base = [{ beat: 0, value: 0 }, { beat: 16, value: 1 }]; // drawn ramp
  const seg = { start: 4, end: 6, points: [{ beat: 4, value: 0.9 }, { beat: 5, value: 0.8 }, { beat: 6, value: 0.7 }] };
  const out = mergeTake(base, [seg], { staticValue: 0.3 });
  near(valueAt(out, 2), 2 / 16); // before: untouched ramp
  near(valueAt(out, 12), 12 / 16); // after: untouched ramp
  near(valueAt(out, 5), 0.8);
  assert.ok(out.some((p) => p.beat === 0) && out.some((p) => p.beat === 16), 'drawn points outside the span are kept');
  // punch-in / punch-out are vertical jumps back to the ramp
  near(valueAt(out, 3.999), 4 / 16, 1e-3);
  near(valueAt(out, 6.001), 6 / 16, 1e-3);
  // new lane: the value before the take is held around the written span
  const fresh = mergeTake([], [seg], { staticValue: 0.3 });
  near(valueAt(fresh, 1), 0.3);
  near(valueAt(fresh, 5), 0.8);
  near(valueAt(fresh, 9), 0.3);
});

test('AutomationTake: touch writes until release, latch until stop', () => {
  const touch = new AutomationTake({ mode: 'touch' });
  touch.advance(0);
  for (let b = 2; b <= 3; b += 0.05) { touch.advance(b); touch.write('o|volume', b, b / 10); }
  assert.equal(touch.release('o|volume', 3), true);
  touch.advance(8);
  touch.finish(8);
  const [r] = touch.result();
  assert.equal(r.owner, 'o'); assert.equal(r.target, 'volume');
  assert.equal(r.segments.length, 1);
  near(r.segments[0].start, 2); near(r.segments[0].end, 3);

  const latch = new AutomationTake({ mode: 'latch' });
  latch.advance(0);
  latch.write('o|volume', 2, 0.5);
  assert.equal(latch.release('o|volume', 2.5), false);
  latch.advance(7);
  latch.finish();
  const s = latch.result()[0].segments[0];
  near(s.start, 2); near(s.end, 7);
  const merged = mergeTake([{ beat: 0, value: 1 }, { beat: 10, value: 1 }], latch.result()[0].segments, { staticValue: 1 });
  near(valueAt(merged, 6.9), 0.5);
  near(valueAt(merged, 8), 1);

  // stepped targets latch even in touch mode, and are written as jumps
  const st = new AutomationTake({ mode: 'touch' });
  st.advance(0);
  st.write('o|mute', 1, 1, { stepped: true });
  assert.equal(st.release('o|mute', 1), false);
  st.write('o|mute', 3, 0, { stepped: true });
  st.finish(5);
  const m = mergeTake([], st.result()[0].segments, { staticValue: 0, stepped: true });
  assert.equal(valueAt(m, 0.5), 0); assert.equal(valueAt(m, 2), 1); assert.equal(valueAt(m, 4), 0);
});

test('AutomationTake: loop wrap starts a new segment; the later pass wins', () => {
  const take = new AutomationTake({ mode: 'latch' });
  take.advance(4);
  take.write('o|pan', 5, -1);
  take.advance(7.9);
  assert.equal(take.advance(4.05), true); // loop 4..8 wrapped
  take.write('o|pan', 6, 1);
  take.advance(7);
  take.finish();
  const r = take.result()[0];
  assert.equal(r.segments.length, 2);
  near(r.segments[0].end, 7.9);
  near(r.segments[1].start, 4.05);
  const merged = mergeTake([], r.segments, { staticValue: 0 });
  near(valueAt(merged, 5.5), -1); // second pass held -1 until the new touch at 6
  near(valueAt(merged, 6.5), 1);
});

test('automation-targets: labels, groups and lane defs for every owner kind', () => {
  const p = demoProject();
  const [t, d] = p.tracks;
  const fx = t.fx[0];
  assert.equal(laneLabel(p, t.id, 'volume'), 'Lead › Volume');
  assert.match(laneLabel(p, t.id, `fx:${fx.id}:cutoff`), /^Lead · .+ › Cutoff/);
  assert.equal(laneLabel(p, 'master', 'volume'), 'Master › Volume');
  assert.equal(targetInfo(p, t.id, 'mute').def.stepped, true);
  const en = targetInfo(p, t.id, `fx:${fx.id}:type`);
  assert.equal(en.def.stepped, true);
  assert.ok(en.def.max >= 1);
  assert.equal(targetInfo(p, d.id, 'inst:pads.kick.tune').missing, false);
  assert.equal(targetInfo(p, 'master', 'pan').missing, true);
  assert.equal(targetInfo(p, p.buses[0].id, 'send:x').missing, true);
  const kinds = targetGroups(p, d.id).map((g) => g.kind);
  assert.deepEqual(kinds.slice(0, 3), ['mixer', 'inst', 'pads']);
  const busGroups = targetGroups(p, p.buses[0].id);
  assert.deepEqual(busGroups[0].items.map((i) => i.target), ['volume', 'pan', 'mute']);
  assert.ok(busGroups.some((g) => g.kind === 'fx'));
});
