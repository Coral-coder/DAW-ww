// Hardware control (src/control/*): MIDI learn, relative-mode detection, soft takeover, 14-bit CC / NRPN,
// device manager with a fake MIDIAccess, note routing + MPE, MCU / HUI byte streams, grid launching,
// MIDI clock in / out, MTC, shortcuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, applyVelocityCurve, detectCcMode, relativeDelta, ControlDecoder, sourceLabel, bendNorm } from '../src/control/midi.js';
import { MappingEngine, createMapping, exportMappings, importMappings, LEARN_WINDOW_MS } from '../src/control/mapping.js';
import { MidiDeviceManager, channelPasses } from '../src/control/devices.js';
import { NoteRouter } from '../src/control/router.js';
import { McuProtocol, HuiProtocol, mcuSegChar } from '../src/control/surface-protocol.js';
import { SurfaceController, faderToGain, gainToFader } from '../src/control/surface.js';
import { GridController, GRID_LAYOUTS } from '../src/control/grid.js';
import { MidiClockOut, MidiClockIn, MtcOut, sppMessage, slope, quarterFrames, toTimecode, mtcFullFrame } from '../src/control/clock.js';
import { CommandRegistry, ShortcutMap, normalizeChord, eventToChord, formatChord, fuzzyScore } from '../src/control/shortcuts.js';
import { applyNorm, targetNorm, targetSteps, resolveOwner, templateOwner } from '../src/control/targets.js';
import { createProject, createTrack, createEffect } from '../src/core/model.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);

// ------------------------------------------------------------------------------------------- fakes
function fakePort(id, name, type) {
  return { id, name, type, manufacturer: 'Test', state: 'connected', onmidimessage: null, sent: [], send(d, ts) { this.sent.push({ d: [...d], ts }); }, open() {} };
}
function fakeAccess({ inputs = [], outputs = [] } = {}) {
  const acc = { inputs: new Map(), outputs: new Map(), onstatechange: null, sysexEnabled: true };
  for (const p of inputs) acc.inputs.set(p.id, p);
  for (const p of outputs) acc.outputs.set(p.id, p);
  acc.plug = (p) => { (p.type === 'input' ? acc.inputs : acc.outputs).set(p.id, p); acc.onstatechange?.({ port: p }); };
  acc.unplug = (p) => { p.state = 'disconnected'; (p.type === 'input' ? acc.inputs : acc.outputs).delete(p.id); acc.onstatechange?.({ port: p }); };
  return acc;
}
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
/** A target host with plain numbers (norm values per target key). */
function valueHost(init = {}) {
  const vals = { ...init };
  const writes = [];
  return {
    vals, writes,
    getNorm: (t) => (t.command ? 0 : vals[`${t.owner}|${t.target}`] ?? null),
    setNorm: (t, n, ctx) => { vals[`${t.owner}|${t.target}`] = n; writes.push({ key: `${t.owner}|${t.target}`, n, phase: ctx.phase }); },
    steps: (t) => (t.target === 'mute' ? 1 : null),
    commands: [],
    runCommand(id, x) { this.commands.push({ id, ...x }); },
  };
}
const cc = (ch, n, v) => [0xb0 | ch, n, v];

// ------------------------------------------------------------------------------------------- MIDI basics
test('parseMessage: notes, note-on velocity 0 = off, CC, pitch bend, realtime', () => {
  assert.deepEqual(parseMessage([0x91, 60, 100]), { type: 'noteon', ch: 1, note: 60, vel: 100 });
  assert.equal(parseMessage([0x90, 60, 0]).type, 'noteoff');
  assert.deepEqual(parseMessage([0xb2, 7, 99]), { type: 'cc', ch: 2, cc: 7, value: 99 });
  assert.equal(parseMessage([0xe0, 0, 64]).value, 8192);
  near(bendNorm(8192), 0); near(bendNorm(16383), 1); near(bendNorm(0), -1);
  assert.equal(parseMessage([0xf8]).type, 'clock');
  assert.deepEqual(parseMessage([0xf2, 0x10, 0x01]), { type: 'spp', value: 0x10 | (1 << 7) });
});

test('velocity curves: linear identity, soft > linear > hard, fixed', () => {
  near(applyVelocityCurve(127, 'linear'), 1);
  const s = applyVelocityCurve(40, 'soft'), l = applyVelocityCurve(40, 'linear'), hd = applyVelocityCurve(40, 'hard');
  assert.ok(s > l && l > hd);
  assert.equal(applyVelocityCurve(5, 'fixed', { fixed: 0.7 }), 0.7);
  assert.equal(applyVelocityCurve(0, 'linear'), 0);
});

test('relative-mode detection: 2s complement, binary offset, sign-magnitude, absolute, button', () => {
  assert.deepEqual(detectCcMode([1, 1, 1, 2, 1, 127, 127, 126]), { mode: 'relative-2c', sure: true });
  assert.deepEqual(detectCcMode([65, 65, 66, 65, 63, 63]), { mode: 'relative-bin', sure: true });
  assert.deepEqual(detectCcMode([1, 1, 2, 65, 65, 66]), { mode: 'relative-sm', sure: true });
  assert.equal(detectCcMode([1, 1, 1, 1]).mode, 'relative-2c'); // only clockwise so far: 2c vs sign-magnitude unknown
  assert.equal(detectCcMode([1, 1, 1, 1]).sure, false);
  assert.deepEqual(detectCcMode([40, 41, 42, 44, 47, 50]), { mode: 'absolute', sure: true });
  assert.equal(detectCcMode([3, 4, 5, 6, 7]).mode, 'absolute'); // slow absolute knob near the bottom: no repeats
  assert.equal(detectCcMode([127, 0]).mode, 'button');
  assert.equal(relativeDelta('relative-2c', 127), -1);
  assert.equal(relativeDelta('relative-2c', 3), 3);
  assert.equal(relativeDelta('relative-bin', 62), -2);
  assert.equal(relativeDelta('relative-sm', 0x42), -2);
  assert.equal(relativeDelta('relative-sm', 0x02), 2);
});

test('ControlDecoder: 14-bit CC pairs are detected and merged; NRPN 7/14-bit + increment', () => {
  const d = new ControlDecoder();
  // first MSB alone is a plain CC; MSB directly followed by LSB (CC n+32) = 14-bit pair
  assert.deepEqual(d.decode('X', cc(0, 1, 64)).map((e) => e.kind), ['cc']);
  const e = d.decode('X', cc(0, 33, 5));
  assert.equal(e[0].kind, 'cc14'); assert.equal(e[0].num, 1); assert.equal(e[0].value, (64 << 7) | 5); assert.equal(e[0].max, 16383);
  assert.deepEqual(d.decode('X', cc(0, 1, 100)), []); // known pair: the MSB waits for its LSB
  assert.equal(d.decode('X', cc(0, 33, 0))[0].value, 100 << 7);
  // unrelated CC 40 (not after CC 8) stays a plain CC
  assert.equal(d.decode('X', cc(0, 40, 3))[0].kind, 'cc');
  // NRPN 0x01:0x05, 7-bit data first, then the device turns out to send 14-bit
  d.decode('X', cc(2, 99, 1)); d.decode('X', cc(2, 98, 5));
  const n1 = d.decode('X', cc(2, 6, 10));
  assert.equal(n1[0].kind, 'nrpn'); assert.equal(n1[0].num, (1 << 7) | 5); assert.equal(n1[0].value, 10);
  const n2 = d.decode('X', cc(2, 38, 3));
  assert.equal(n2[0].value, (10 << 7) | 3); assert.equal(n2[0].max, 16383);
  assert.deepEqual(d.decode('X', cc(2, 6, 11)), []); // 14-bit NRPN now waits for the LSB
  assert.equal(d.decode('X', cc(2, 96, 1))[0].step, true); // data increment
  // RPN (bend range) does not leak out as a control
  d.decode('X', cc(3, 101, 0)); d.decode('X', cc(3, 100, 0));
  assert.deepEqual(d.decode('X', cc(3, 6, 12)), []);
  assert.equal(sourceLabel({ kind: 'cc14', num: 1, ch: 0 }), 'CC 1/33 (14-bit) · ch 1');
});

// ------------------------------------------------------------------------------------------- learn
test('MIDI learn: absolute knob -> mapping, then moves write the target; re-learn replaces', () => {
  const host = valueHost({ 'trk1|volume': 0.5 });
  const eng = new MappingEngine(host);
  const learned = [];
  eng.on('learned', (m) => learned.push(m));
  eng.startLearn({ owner: 'trk1', target: 'volume' });
  let t = 0;
  for (const v of [60, 62, 64, 66]) eng.handle('Knobs', cc(0, 21, v), (t += 10));
  assert.ok(eng.isLearning); // still collecting (window open, < 6 events)
  eng.flushLearn(t + LEARN_WINDOW_MS);
  assert.equal(learned.length, 1);
  const m = learned[0];
  assert.deepEqual(m.source, { device: 'Knobs', ch: 0, kind: 'cc', num: 21 });
  assert.equal(m.mode, 'absolute');
  // later moves: absolute, already picked up (learn happened with the hand on the knob)
  eng.handle('Knobs', cc(0, 21, 127), t + 600);
  near(host.vals['trk1|volume'], 1);
  eng.handle('Knobs', cc(0, 21, 0), t + 610);
  near(host.vals['trk1|volume'], 0);
  // other devices / channels do not trigger it
  eng.handle('Other', cc(0, 21, 127), t + 620);
  eng.handle('Knobs', cc(1, 21, 127), t + 630);
  near(host.vals['trk1|volume'], 0);
  // learning the same knob for another target replaces the old mapping
  eng.startLearn({ owner: 'trk1', target: 'pan' });
  host.vals['trk1|pan'] = 0.5;
  for (let i = 0; i < 6; i++) eng.handle('Knobs', cc(0, 21, 10 + i), t + 700 + i);
  assert.equal(eng.mappings.length, 1);
  assert.equal(eng.mappings[0].target.target, 'pan');
});

test('MIDI learn: relative encoder (2s complement / sign-magnitude) auto-detected, refines later', () => {
  const host = valueHost({ 'trk1|inst:cutoff': 0.5 });
  const eng = new MappingEngine(host);
  eng.startLearn({ owner: 'trk1', target: 'inst:cutoff' });
  for (let i = 0; i < 6; i++) eng.handle('Enc', cc(0, 30, 1), i * 5); // clockwise ticks
  const m = eng.mappings[0];
  assert.equal(m.mode, 'relative-2c');
  assert.equal(m.detect, true); // not sure yet (no counter-clockwise seen)
  const before = host.vals['trk1|inst:cutoff'];
  eng.handle('Enc', cc(0, 30, 1), 100);
  assert.ok(host.vals['trk1|inst:cutoff'] > before);
  // counter-clockwise arrives as 65 -> it is sign-magnitude
  eng.handle('Enc', cc(0, 30, 65), 110);
  eng.handle('Enc', cc(0, 30, 65), 120);
  assert.equal(m.mode, 'relative-sm');
  assert.equal(m.detect, undefined);
  const v = host.vals['trk1|inst:cutoff'];
  eng.handle('Enc', cc(0, 30, 65), 130);
  assert.ok(host.vals['trk1|inst:cutoff'] < v, 'decrements after detection');

  // binary offset encoder
  const h2 = valueHost({ 'a|pan': 0.5 });
  const e2 = new MappingEngine(h2);
  e2.startLearn({ owner: 'a', target: 'pan' });
  for (const x of [65, 65, 65, 63, 63, 63]) e2.handle('E', cc(0, 1, x), 1);
  assert.equal(e2.mappings[0].mode, 'relative-bin');
});

test('MIDI learn: notes and CC buttons become toggle buttons; momentary option', () => {
  const host = valueHost({ 'trk1|mute': 0 });
  const eng = new MappingEngine(host);
  eng.startLearn({ owner: 'trk1', target: 'mute' });
  eng.handle('Pads', [0x99, 36, 100], 0);
  const m = eng.mappings[0];
  assert.equal(m.button, 'toggle');
  assert.equal(m.source.kind, 'note');
  eng.handle('Pads', [0x89, 36, 0], 10);
  eng.handle('Pads', [0x99, 36, 90], 20); // press: toggles on
  assert.equal(host.vals['trk1|mute'], 1);
  eng.handle('Pads', [0x89, 36, 0], 30); // release: nothing
  assert.equal(host.vals['trk1|mute'], 1);
  eng.handle('Pads', [0x99, 36, 90], 40);
  assert.equal(host.vals['trk1|mute'], 0);
  eng.update(m.id, { button: 'momentary' });
  eng.handle('Pads', [0x99, 36, 90], 50);
  assert.equal(host.vals['trk1|mute'], 1);
  eng.handle('Pads', [0x89, 36, 0], 60);
  assert.equal(host.vals['trk1|mute'], 0);
  // CC button 127 / 0 learned within the window
  const h2 = valueHost({ 'trk1|fxen:fx1': 1 });
  const e2 = new MappingEngine(h2);
  e2.startLearn({ owner: 'trk1', target: 'fxen:fx1' });
  e2.handle('B', cc(0, 80, 127), 0);
  e2.handle('B', cc(0, 80, 0), 80);
  e2.flushLearn(1000);
  assert.equal(e2.mappings[0].button, 'toggle');
  // command target: runs on press
  const e3 = new MappingEngine(host);
  e3.startLearn({ command: 'transport.play' });
  e3.handle('B', [0x90, 94, 127], 0);
  e3.handle('B', [0x80, 94, 0], 5);
  e3.handle('B', [0x90, 94, 127], 10);
  assert.deepEqual(host.commands.map((c) => c.id), ['transport.play']);
});

test('soft takeover (pickup): ignores the knob until it reaches the value, then follows; jump mode follows at once', () => {
  const host = valueHost({ 'trk1|volume': 0.5 });
  const eng = new MappingEngine(host);
  eng.setProjectMappings([createMapping({ device: 'K', ch: 0, kind: 'cc', num: 7 }, { owner: 'trk1', target: 'volume' })]);
  const waits = [];
  eng.on('pickup', (x) => waits.push(x));
  eng.handle('K', cc(0, 7, 10), 0); // knob far below the value
  eng.handle('K', cc(0, 7, 30), 1);
  near(host.vals['trk1|volume'], 0.5);
  assert.equal(waits.length, 2);
  eng.handle('K', cc(0, 7, 70), 2); // crossed 0.5 (63.5): picked up
  near(host.vals['trk1|volume'], 70 / 127);
  eng.handle('K', cc(0, 7, 80), 3);
  near(host.vals['trk1|volume'], 80 / 127);
  // the value changes elsewhere (mouse / automation): the knob has to catch it again
  host.vals['trk1|volume'] = 0.1;
  eng.handle('K', cc(0, 7, 82), 4);
  near(host.vals['trk1|volume'], 0.1);
  eng.handle('K', cc(0, 7, 13), 5); // within tolerance of 0.1 (12.7)
  near(host.vals['trk1|volume'], 13 / 127);
  // jump mode
  const m = eng.mappings[0];
  eng.update(m.id, { takeover: 'jump' });
  eng.handle('K', cc(0, 7, 120), 6);
  near(host.vals['trk1|volume'], 120 / 127);
});

test('mapping range, invert and 14-bit CC / NRPN resolution', () => {
  const host = valueHost({ 'trk1|inst:cutoff': 0.25 });
  const eng = new MappingEngine(host);
  eng.setProjectMappings([createMapping({ device: null, ch: null, kind: 'cc14', num: 1 }, { owner: 'trk1', target: 'inst:cutoff' }, { min: 0.2, max: 0.6, invert: true, takeover: 'jump' })]);
  eng.handle('Any', cc(5, 1, 0), 0); // MSB (first: plain)
  eng.handle('Any', cc(5, 33, 0), 1); // LSB -> pair; value 0 -> inverted -> max
  near(host.vals['trk1|inst:cutoff'], 0.6);
  eng.handle('Any', cc(5, 1, 64), 2);
  eng.handle('Any', cc(5, 33, 0), 3); // 8192/16383 -> inverted ~0.49997 -> 0.2 + 0.4*0.49997
  near(host.vals['trk1|inst:cutoff'], 0.2 + 0.4 * (1 - 8192 / 16383), 1e-9);
  // 14-bit gives finer steps than 7-bit
  eng.handle('Any', cc(5, 1, 64), 4);
  eng.handle('Any', cc(5, 33, 1), 5);
  assert.ok(Math.abs(host.vals['trk1|inst:cutoff'] - (0.2 + 0.4 * (1 - 8193 / 16383))) < 1e-9);
  // NRPN learn picks the parameter number; data entry drives it
  const h2 = valueHost({ 'a|pan': 0.5 });
  const e2 = new MappingEngine(h2);
  e2.startLearn({ owner: 'a', target: 'pan' });
  e2.handle('S', cc(0, 99, 2), 0); e2.handle('S', cc(0, 98, 9), 1); e2.handle('S', cc(0, 6, 64), 2);
  assert.deepEqual(e2.mappings[0].source, { device: 'S', ch: 0, kind: 'nrpn', num: (2 << 7) | 9 });
  e2.handle('S', cc(0, 6, 127), 3);
  near(h2.vals['a|pan'], 1);
});

test('mapping feedback bytes, template shadowing, export / import round trip', () => {
  const host = valueHost({ 'trk1|volume': 0.5, 'master|volume': 0.5 });
  const eng = new MappingEngine(host);
  const m = createMapping({ device: 'K', ch: 2, kind: 'cc', num: 7 }, { owner: 'trk1', target: 'volume' });
  eng.setProjectMappings([m]);
  eng.setTemplate([createMapping({ device: 'K', ch: 2, kind: 'cc', num: 7 }, { owner: 'master', target: 'volume' }, { takeover: 'jump' }), createMapping({ device: 'K', ch: 2, kind: 'cc', num: 8 }, { owner: 'master', target: 'volume' }, { takeover: 'jump' })]);
  assert.deepEqual(eng.feedbackBytes(eng.mappings[0], 1), [[0xb2, 7, 127]]);
  const m14 = createMapping({ device: 'K', ch: 0, kind: 'cc14', num: 3 }, { owner: 'trk1', target: 'volume' });
  assert.deepEqual(eng.feedbackBytes(m14, 1), [[0xb0, 3, 127], [0xb0, 35, 127]]);
  eng.handle('K', cc(2, 7, 64), 0); // project mapping wins (template not touched)
  near(host.vals['master|volume'], 0.5);
  eng.handle('K', cc(2, 8, 127), 1); // template-only source
  near(host.vals['master|volume'], 1);
  const text = exportMappings(eng.project);
  const back = importMappings(text);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].source, m.source);
  assert.throws(() => importMappings('{"nope":1}'));
});

// ------------------------------------------------------------------------------------------- device manager + routing
test('device manager: fake MIDIAccess, hot-plug, per-device enable, sending, partner output', async () => {
  const kb = fakePort('in1', 'KeyLab In', 'input');
  const out = fakePort('out1', 'KeyLab Out', 'output');
  const acc = fakeAccess({ inputs: [kb], outputs: [out] });
  const mgr = new MidiDeviceManager({ requestAccess: async () => acc, storage: memStore() });
  const got = [];
  mgr.on('message', (name, data) => got.push([name, [...data]]));
  let devEvents = 0;
  mgr.on('devices', () => devEvents++);
  await mgr.open();
  assert.equal(mgr.inputs().length, 1);
  kb.onmidimessage({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 1 });
  assert.deepEqual(got, [['KeyLab In', [0x90, 60, 100]]]);
  // hot-plug a second device
  const pad = fakePort('in2', 'Pads', 'input');
  acc.plug(pad);
  assert.ok(devEvents >= 2);
  pad.onmidimessage({ data: [0xb0, 1, 2], timeStamp: 2 });
  assert.equal(got.length, 2);
  // disable: handler detached, setting persisted
  mgr.setInputSettings('Pads', { enabled: false });
  assert.equal(pad.onmidimessage, null);
  assert.equal(mgr.inputSettings('Pads').enabled, false);
  assert.equal(mgr.partnerOutput('KeyLab In'), 'KeyLab Out');
  assert.ok(mgr.send('KeyLab Out', [[0x90, 1, 127], [0x90, 2, 0]], 5));
  assert.deepEqual(out.sent.map((s) => s.d), [[0x90, 1, 127], [0x90, 2, 0]]);
  assert.equal(channelPasses([9], 9), true);
  assert.equal(channelPasses([9], 0), false);
  assert.equal(channelPasses('all', 3), true);
});

test('note router: targets, channel filter, transpose, velocity curve, sustain, thru, MPE expression', () => {
  const log = [];
  const host = {
    targets: () => ['trkA', 'trkB'],
    noteOn: (id, p, v) => log.push(['on', id, p, v]),
    noteOff: (id, p, x) => log.push(['off', id, p, x]),
    pitchBend: (id, v) => log.push(['pb', id, +v.toFixed(3)]),
    expression: (id, p, x) => log.push(['x', id, p, x]),
    thru: (d) => log.push(['thru', [...d]]),
  };
  const r = new NoteRouter(host);
  const s = { notes: true, channels: [0], curve: 'linear', transpose: 12, mpe: false };
  r.handle('K', [0x91, 60, 127], s, 0); // channel 2 filtered out
  assert.equal(log.length, 0);
  r.handle('K', [0x90, 60, 127], s, 0);
  assert.deepEqual(log.slice(0, 2), [['on', 'trkA', 72, 1], ['on', 'trkB', 72, 1]]);
  assert.deepEqual(log[2], ['thru', [0x90, 60, 127]]);
  log.length = 0;
  r.handle('K', [0xb0, 64, 127], s, 1); // sustain down
  r.handle('K', [0x80, 60, 0], s, 2);
  assert.ok(!log.some((l) => l[0] === 'off'));
  r.handle('K', [0xb0, 64, 0], s, 3); // sustain up -> released
  assert.equal(log.filter((l) => l[0] === 'off').length, 2);
  log.length = 0;
  r.handle('K', [0xe0, 0x7f, 0x7f], s, 4);
  assert.deepEqual(log.filter((l) => l[0] === 'pb').map((l) => l[2]), [1, 1]);
  // MPE: member channel bend / pressure / timbre -> per-note expression, recorded as note bend
  log.length = 0;
  const mpe = { notes: true, channels: 'all', curve: 'linear', mpe: true };
  const one = { ...host, targets: () => ['trkA'] };
  const r2 = new NoteRouter(one);
  r2.handle('Seaboard', [0x92, 64, 100], mpe, 0);
  r2.handle('Seaboard', [0xe2, 0x00, 0x50], mpe, 100); // bend up
  r2.handle('Seaboard', [0xd2, 64], mpe, 150);
  r2.handle('Seaboard', [0xb2, 74, 127], mpe, 160);
  r2.handle('Seaboard', [0x82, 64, 0], mpe, 400);
  const xs = log.filter((l) => l[0] === 'x');
  assert.ok(xs.length >= 3);
  const bendSemis = bendNorm(0x50 << 7) * 48;
  near(xs[0][3].bend, bendSemis, 1e-9);
  near(xs[1][3].pressure, 64 / 127);
  near(xs[2][3].timbre, 1);
  const off = log.find((l) => l[0] === 'off');
  near(off[3].bend, +bendSemis.toFixed(2));
  near(off[3].bendAt, 0.25);
});

// ------------------------------------------------------------------------------------------- control surfaces
function surfaceHost() {
  const strips = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, name: `Track ${i + 1}`, volume: 0.8, pan: 0, mute: false, solo: false, arm: false, selected: i === 0 }));
  const calls = [];
  return {
    calls, list: strips,
    strips: () => strips,
    master: () => ({ volume: 0.9 }),
    setVolume: (id, g) => { calls.push(['vol', id, g]); const s = strips.find((x) => x.id === id); if (s) s.volume = g; },
    setPan: (id, p) => { calls.push(['pan', id, p]); strips.find((x) => x.id === id).pan = p; },
    toggle: (id, k) => { calls.push(['toggle', id, k]); const s = strips.find((x) => x.id === id); s[k] = !s[k]; },
    select: (id) => { for (const s of strips) s.selected = s.id === id; calls.push(['select', id]); },
    touch: (id, target, on) => calls.push(['touch', id, target, on]),
    sends: () => [{ busId: 'b1', name: 'Reverb', value: 0.2 }, { busId: 'b2', name: 'Delay', value: 0 }],
    setSend: (id, bus, v) => calls.push(['send', id, bus, v]),
    params: () => [{ label: 'Cutoff', norm: 0.5, set: (n) => calls.push(['param', 'Cutoff', n]) }],
    transport: () => ({ playing: true, recording: false, loop: true, click: false }),
    command: (n) => calls.push(['cmd', n]),
    jog: (d) => calls.push(['jog', d]),
    position: () => ({ bar: 12, beat: 3, sixteenth: 2, tick: 7 }),
    meter: () => 0.5,
  };
}

test('MCU: fader / touch / v-pot / buttons decode; LED, fader, ring, scribble, time display bytes', () => {
  const host = surfaceHost();
  const sent = [];
  const sc = new SurfaceController({ kind: 'mcu', host, send: (msgs) => sent.push(...msgs) });
  // touch strip 2, move its fader to full, release
  sc.handle([0x90, 0x68 + 2, 127]);
  sc.handle([0xe2, 0x7f, 0x7f]);
  sc.handle([0x90, 0x68 + 2, 0]);
  assert.deepEqual(host.calls.slice(0, 3), [['touch', 't2', 'volume', true], ['vol', 't2', 1.5], ['touch', 't2', 'volume', false]]);
  // V-pot 1 clockwise 3 (pan), counter-clockwise (sign-magnitude 0x41)
  sc.handle([0xb0, 0x10, 0x03]);
  near(host.list[0].pan, 0.06);
  sc.handle([0xb0, 0x10, 0x41]);
  near(host.list[0].pan, 0.04);
  // mute strip 4 (note 0x14), solo 1, rec 0, select 5
  sc.handle([0x90, 0x14, 127]); sc.handle([0x90, 0x09, 127]); sc.handle([0x90, 0x00, 127]); sc.handle([0x90, 0x1d, 127]);
  assert.ok(host.list[4].mute && host.list[1].solo && host.list[0].arm && host.list[5].selected);
  sc.handle([0x90, 0x5e, 127]); // play
  sc.handle([0xb0, 0x3c, 0x42]); // jog ccw 2
  assert.deepEqual(host.calls.slice(-2), [['cmd', 'play'], ['jog', -2]]);
  // feedback
  sent.length = 0;
  sc.refresh();
  const has = (m) => sent.some((x) => x.length === m.length && x.every((b, i) => b === m[i]));
  assert.ok(has([0x90, 0x14, 127]), 'mute LED strip 4 on');
  assert.ok(has([0x90, 0x10, 0]), 'mute LED strip 0 off');
  assert.ok(has([0x90, 0x1d, 127]), 'select LED strip 5');
  assert.ok(has([0x90, 0x5e, 127]), 'play LED');
  assert.ok(has([0x90, 0x56, 127]), 'cycle LED (loop on)');
  const unity = Math.round(gainToFader(0.8) * 16383);
  assert.ok(has([0xe3, unity & 0x7f, unity >> 7]), 'fader 3 at unity');
  // scribble strip: SysEx F0 00 00 66 14 12 offset text F7, 7 chars per strip
  const lcd = sent.find((m) => m[0] === 0xf0 && m[6] === 7); // strip 1 row 0 (offset 7)
  assert.deepEqual(lcd.slice(0, 7), [0xf0, 0x00, 0x00, 0x66, 0x14, 0x12, 7]);
  assert.equal(String.fromCharCode(...lcd.slice(7, 14)), 'Trck 2 ');
  assert.equal(lcd[14], 0xf7);
  const row2 = sent.find((m) => m[0] === 0xf0 && m[6] === 56); // strip 0 row 1: pan value
  assert.equal(String.fromCharCode(...row2.slice(7, 14)).trim(), 'R4');
  // time display "BBB.BB.SS.TTT": CC 0x40 = right-most digit
  const time = sent.filter((m) => m[0] === 0xb0 && m[1] >= 0x40 && m[1] <= 0x49);
  assert.equal(time.length, 10);
  assert.deepEqual(time.find((m) => m[1] === 0x40), [0xb0, 0x40, mcuSegChar('7')]);
  assert.deepEqual(time.find((m) => m[1] === 0x49), [0xb0, 0x49, mcuSegChar(' ')]);
  assert.deepEqual(time.find((m) => m[1] === 0x47), [0xb0, 0x47, mcuSegChar('2') | 0x40]); // bar "12" + dot
  // second refresh sends nothing (diffed)
  sent.length = 0;
  sc.refresh();
  assert.equal(sent.length, 0);
  // bank right shifts by 8 but never past the last 8 strips (11 strips -> offset 3)
  sc.handle([0x90, 0x2f, 127]);
  assert.equal(sc.bank, 3);
  assert.ok(sent.length > 0, 'bank change redraws');
  // meters: channel pressure (strip << 4) | level
  sent.length = 0;
  sc.meters();
  assert.deepEqual(sent[1], [0xd0, (1 << 4) | 6]);
  // send mode: V-pot edits the send; second press cycles the bus
  sc.handle([0x90, 0x29, 127]);
  sc.handle([0xb0, 0x10, 0x05]);
  assert.deepEqual(host.calls.at(-1), ['send', 't3', 'b1', 0.25]);
  sc.handle([0x90, 0x29, 127]);
  assert.equal(sc.sendIndex, 1);
  sc.handle([0x90, 0x2b, 127]); // plugin mode: V-pot 1 = first param of the selected track
  sc.handle([0xb0, 0x10, 0x0a]);
  assert.deepEqual(host.calls.at(-1), ['param', 'Cutoff', 0.6]);
  // fader taper: unity gain near 73 % travel
  near(faderToGain(gainToFader(0.8)), 0.8, 1e-3);
  assert.ok(gainToFader(0.8) > 0.7 && gainToFader(0.8) < 0.76);
});

test('HUI: zone/port switches, fader pairs, LEDs, ping, scribble', () => {
  const p = new HuiProtocol();
  assert.deepEqual(p.decode([0xb0, 0x0f, 0x03]), []);
  assert.deepEqual(p.decode([0xb0, 0x2f, 0x42]), [{ type: 'button', name: 'mute', strip: 3, on: true }]);
  p.decode([0xb0, 0x0f, 0x02]);
  assert.deepEqual(p.decode([0xb0, 0x2f, 0x40]), [{ type: 'touch', strip: 2, on: true }]);
  p.decode([0xb0, 0x0f, 0x0e]);
  assert.deepEqual(p.decode([0xb0, 0x2f, 0x44]), [{ type: 'button', name: 'play', strip: null, on: true }]);
  assert.deepEqual(p.decode([0xb0, 0x01, 0x7f]), []);
  assert.equal(p.decode([0xb0, 0x21, 0x7f])[0].value, 1);
  assert.deepEqual(p.decode([0x90, 0x00, 0x7f]), [{ type: 'ping' }]);
  assert.deepEqual(p.led('solo', 5, 1), [[0xb0, 0x0c, 5], [0xb0, 0x2c, 0x43]]);
  assert.deepEqual(p.led('stop', null, 0), [[0xb0, 0x0c, 0x0e], [0xb0, 0x2c, 0x03]]);
  assert.deepEqual(p.fader(1, 1), [[0xb0, 1, 127], [0xb0, 0x21, 127]]);
  assert.deepEqual(p.scribble(2, 0, 'Bass guitar'), [[0xf0, 0, 0, 0x66, 0x05, 0x00, 0x10, 2, 66, 97, 115, 115, 0xf7]]);
  assert.deepEqual(p.ping(), [[0x90, 0, 0]]);
  const m = new McuProtocol({ extender: true });
  assert.equal(m.scribble(0, 0, 'x')[0][4], 0x15);
});

test('grid controller: Launchpad pads launch slots / scenes, LEDs reflect state, setlist mode', () => {
  const tracks = [{ id: 'a', activePatternId: 'p1' }, { id: 'b', activePatternId: null }];
  const scenes = [{ id: 's1', slots: { a: 'p1', b: 'p3' } }, { id: 's2', slots: { a: 'p2' } }];
  const calls = [];
  const host = {
    tracks: () => tracks, scenes: () => scenes, playing: () => true,
    launchSlot: (t, p) => { calls.push(['slot', t, p]); tracks.find((x) => x.id === t).activePatternId = p; },
    launchScene: (s) => calls.push(['scene', s]), stopTrack: (t) => calls.push(['stop', t]),
  };
  const sent = [];
  const g = new GridController({ layout: 'launchpad', host, send: (m) => sent.push(...m) });
  g.refresh();
  const L = GRID_LAYOUTS.launchpad;
  const padMsg = (r, c) => sent.filter((m) => m[0] === 0x90 && m[1] === L.padNote(r, c)).at(-1);
  assert.equal(padMsg(0, 0)[2], L.colors.playing);
  assert.equal(padMsg(0, 1)[2], L.colors.has);
  assert.equal(padMsg(1, 1)[2], L.colors.off);
  g.handle([0x90, L.padNote(1, 0), 127]); // scene 2 / track a
  assert.deepEqual(calls.at(-1), ['slot', 'a', 'p2']);
  assert.equal(padMsg(1, 0)[2], L.colors.playing);
  assert.equal(padMsg(0, 0)[2], L.colors.has);
  g.handle([0x90, L.padNote(1, 1), 127]); // empty slot -> stop track
  assert.deepEqual(calls.at(-1), ['stop', 'b']);
  g.handle([0xb0, 89, 127]); // top scene button (CC in programmer mode)
  assert.deepEqual(calls.at(-1), ['scene', 's1']);
  // APC mini numbering: bottom-left = note 0
  assert.deepEqual(GRID_LAYOUTS['apc-mini'].padOf(0), { r: 7, c: 0 });
  assert.equal(GRID_LAYOUTS.push.padNote(7, 0), 36);
  // setlist mode: row 0 mutes layer, bottom row queues sections
  const sl = [];
  const g2 = new GridController({ layout: 'apc-mini', mode: 'setlist', send: () => {}, host: { layers: () => [{ id: 'L1', mute: false }], layerAction: (id, a) => sl.push([id, a]), sections: () => [{ id: 'intro', current: true }, { id: 'drop' }], queueSection: (id) => sl.push(['q', id]), tracks: () => [], scenes: () => [] } });
  g2.handle([0x90, GRID_LAYOUTS['apc-mini'].padNote(0, 0), 127]);
  g2.handle([0x90, GRID_LAYOUTS['apc-mini'].padNote(7, 1), 127]);
  assert.deepEqual(sl, [['L1', 'mute'], ['q', 'drop']]);
});

// ------------------------------------------------------------------------------------------- sync
test('MIDI clock out: start at 0 / SPP+continue elsewhere, ticks exactly every 1/24 beat, tempo change keeps phase', () => {
  const out = [];
  const clk = new MidiClockOut({ send: (d, ts) => out.push({ d, ts }), lookahead: 100 });
  clk.start(0, 120, 1000); // 120 bpm: 500 ms / beat, 20.8333 ms / tick
  assert.deepEqual(out[0], { d: [0xfa], ts: 1000 });
  clk.pump(1000);
  let ticks = out.filter((x) => x.d[0] === 0xf8);
  assert.equal(ticks.length, 5); // 0, 20.8, 41.7, 62.5, 83.3 < 100
  ticks.forEach((t, k) => near(t.ts, 1000 + k * 500 / 24, 1e-9));
  clk.pump(1500);
  ticks = out.filter((x) => x.d[0] === 0xf8);
  assert.equal(ticks.length, 29); // through 1600 ms (exclusive)
  // tempo change at t=1500 (beat 1): next ticks 250/24 ms apart from the phase they had
  clk.setTempo(240, 1500);
  out.length = 0;
  clk.pump(1600);
  const t2 = out.map((x) => x.ts);
  for (let i = 1; i < t2.length; i++) near(t2[i] - t2[i - 1], 250 / 24, 1e-9);
  clk.stop(1700);
  assert.deepEqual(out.at(-1), { d: [0xfc], ts: 1700 });
  // start mid-song: SPP (16ths) then Continue
  const o2 = [];
  const c2 = new MidiClockOut({ send: (d, ts) => o2.push({ d, ts }) });
  c2.start(9.5, 120, 0);
  assert.deepEqual(o2[0].d, sppMessage(9.5));
  assert.deepEqual(o2[0].d, [0xf2, 38, 0]);
  assert.deepEqual(o2[1].d, [0xfb]);
  c2.pump(0);
  near(o2[2].ts, 0); // the first tick is the SPP position
});

test('MIDI clock in: tempo from jittered ticks (±3 ms) within 0.3 BPM; follows a tempo change; transport + SPP', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cin = new MidiClockIn();
  const tempos = [];
  cin.on('tempo', (b) => tempos.push(b));
  const ev = [];
  cin.on('start', () => ev.push('start'));
  cin.on('stop', (p) => ev.push(['stop', p]));
  cin.on('position', (b) => ev.push(['pos', b]));
  cin.handle([0xfa], 0);
  const iv = 60000 / (128 * 24);
  let t = 0;
  for (let k = 0; k < 24 * 16; k++) { t = 10 + k * iv + (rnd() - 0.5) * 6; cin.handle([0xf8], t); }
  assert.ok(Math.abs(cin.bpm - 128) < 0.3, `bpm ${cin.bpm}`);
  assert.ok(Math.abs(tempos.at(-1) - 128) <= 0.3);
  near(cin.position, 16, 1e-9); // 16 beats of ticks
  // tempo change to 100 bpm: snaps within a couple of beats
  const base = t;
  const iv2 = 60000 / (100 * 24);
  for (let k = 1; k <= 24 * 4; k++) cin.handle([0xf8], base + k * iv2 + (rnd() - 0.5) * 6);
  assert.ok(Math.abs(cin.bpm - 100) < 0.5, `bpm after change ${cin.bpm}`);
  cin.handle([0xfc], base + 2000);
  cin.handle([0xf2, 0x20, 0], base + 2100); // SPP 32 sixteenths = beat 8
  assert.deepEqual(ev.slice(-2), [['stop', 20], ['pos', 8]]);
  near(slope([0, 2, 4, 6]), 2);
});

test('MTC: full frame + quarter frames timing and nibbles', () => {
  assert.deepEqual(toTimecode(3661.5, 25), { h: 1, m: 1, s: 1, f: 12 });
  assert.deepEqual(mtcFullFrame(3661.5, 25), [0xf0, 0x7f, 0x7f, 0x01, 0x01, (1 << 5) | 1, 1, 1, 12, 0xf7]);
  const qf = quarterFrames({ h: 1, m: 2, s: 3, f: 20 }, 30);
  assert.deepEqual(qf, [0x04, 0x11, 0x23, 0x30, 0x42, 0x50, 0x61, 0x70 | (3 << 1)]);
  const out = [];
  const mtc = new MtcOut({ send: (d, ts) => out.push({ d, ts }), fps: 25, lookahead: 100 });
  mtc.start(2, 500); // 2 s = frame 50 (even) -> starts right away
  mtc.pump(500);
  const q = out.filter((x) => x.d[0] === 0xf1);
  assert.equal(q.length, 10); // every 10 ms (25 fps × 4)
  q.forEach((x, k) => near(x.ts, 500 + k * 10, 1e-9));
  assert.deepEqual(q.slice(0, 8).map((x) => x.d[1]), quarterFrames({ h: 0, m: 0, s: 2, f: 0 }, 25));
});

// ------------------------------------------------------------------------------------------- shortcuts
test('shortcuts: normalization, event chords, conflicts (scoped), rebinding with steal, import/export', () => {
  assert.equal(normalizeChord('Ctrl+Shift+K'), 'mod+shift+k');
  assert.equal(normalizeChord('shift + A'), 'shift+a');
  assert.equal(normalizeChord('Cmd+K', { isMac: true }), 'mod+k');
  assert.equal(normalizeChord('Ctrl+K', { isMac: true }), 'ctrl+k');
  assert.equal(eventToChord({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), 'mod+shift+k');
  assert.equal(eventToChord({ key: '!', code: 'Digit1', shiftKey: true }), 'shift+1');
  assert.equal(eventToChord({ key: ' ', code: 'Space' }), 'space');
  assert.equal(eventToChord({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), null);
  assert.equal(formatChord('mod+shift+k'), 'Ctrl+Shift+K');
  assert.equal(formatChord('mod+shift+k', { isMac: true }), '⌘⇧K');
  const reg = new CommandRegistry().registerAll([
    { id: 'play', label: 'Play', keys: ['space'] },
    { id: 'palette', label: 'Command palette', keys: ['mod+k'] },
    { id: 'piano.del', label: 'Delete notes', keys: ['delete'], scope: 'piano' },
    { id: 'arr.del', label: 'Delete clips', keys: ['delete'], scope: 'arrange' },
    { id: 'loop', label: 'Loop', keys: ['l'] },
  ]);
  const map = new ShortcutMap(reg);
  assert.deepEqual(map.conflicts(), []); // same key in different views is fine
  assert.equal(map.match({ key: 'Delete', code: 'Delete' }, { view: 'piano' }).id, 'piano.del');
  assert.equal(map.match({ key: 'Delete', code: 'Delete' }, { view: 'mixer' }), null);
  map.bind('loop', 'space');
  assert.deepEqual(map.conflicts(), [{ chord: 'space', ids: ['play', 'loop'] }]);
  map.bind('loop', 'space', { steal: true });
  assert.deepEqual(map.conflicts(), []);
  assert.deepEqual(map.keysFor('play'), []);
  assert.deepEqual(map.keysFor('loop'), ['l', 'space']);
  assert.equal(map.match('space').id, 'loop');
  const json = map.export();
  const m2 = new ShortcutMap(reg);
  m2.import(json);
  assert.deepEqual(m2.keysFor('loop'), ['l', 'space']);
  m2.reset('play');
  assert.deepEqual(m2.keysFor('play'), ['space']);
  m2.set('loop', ['l']);
  assert.equal(m2.isCustom('loop'), false); // back to the default = not custom
  assert.throws(() => m2.import('{"format":"x"}'));
  assert.ok(fuzzyScore('cpal', 'Command palette') > 0);
  assert.equal(fuzzyScore('zzz', 'Command palette'), 0);
  assert.ok(fuzzyScore('play', 'Play') > fuzzyScore('play', 'Display layout'));
});

// ------------------------------------------------------------------------------------------- targets
test('targets: normalized read / write of mixer, instrument, fx and enum targets; template owners', () => {
  const p = createProject();
  const t = createTrack({ name: 'Lead', instrument: { type: 'synth', preset: null, params: {} } });
  const fx = createEffect('delay', { mix: 0.3 });
  t.fx.push(fx);
  p.tracks.push(t);
  assert.ok(applyNorm(p, t.id, 'volume', 1));
  near(t.volume, 1.5);
  applyNorm(p, t.id, 'pan', 0);
  near(t.pan, -1);
  applyNorm(p, t.id, 'mute', 1);
  assert.equal(t.mute, true);
  applyNorm(p, t.id, `send:${p.buses[0].id}`, 0.5);
  near(t.sends[p.buses[0].id], 0.5);
  applyNorm(p, t.id, `fx:${fx.id}:mix`, 1);
  near(targetNorm(p, t.id, `fx:${fx.id}:mix`), 1);
  applyNorm(p, t.id, `fxen:${fx.id}`, 0);
  assert.equal(fx.enabled, false);
  applyNorm(p, t.id, 'inst:cutoff', 0.5);
  assert.ok(Number.isFinite(t.instrument.params.cutoff));
  near(targetNorm(p, t.id, 'inst:cutoff'), 0.5, 0.01);
  assert.equal(targetSteps(p, t.id, 'mute'), 1);
  assert.equal(targetSteps(p, t.id, 'volume'), null);
  assert.equal(resolveOwner(p, '@t1'), t.id);
  assert.equal(resolveOwner(p, '@sel', { selectedTrackId: t.id }), t.id);
  assert.equal(templateOwner(p, t.id), '@t1');
  assert.equal(applyNorm(p, 'nope', 'volume', 1), false);
});

// ------------------------------------------------------------------------------------------- Link
test('Link client: phase error wrap, tempo follow, start on the next bar, stop sync, phase nudge', async () => {
  const { linkPhaseError, LinkClient } = await import('../src/control/link-client.js');
  near(linkPhaseError(4.1, 0.0, 4), -0.1, 1e-9);
  near(linkPhaseError(3.9, 0.0, 4), 0.1, 1e-9);
  near(linkPhaseError(0, 3, 4), -1, 1e-9);
  let bpm = 120, playing = false, beat = 1.3, t = 0;
  const log = [];
  const host = { bpm: () => bpm, setBpm: (b) => { bpm = b; log.push(['bpm', b]); }, playing: () => playing, beat: () => beat, play: () => { playing = true; log.push(['play', beat]); }, stop: () => { playing = false; log.push(['stop']); }, setBeat: (b) => { beat = b; log.push(['seek', +b.toFixed(3)]); }, now: () => t };
  const lc = new LinkClient(host, { WebSocketImpl: null });
  lc.receive({ type: 'state', tempo: 140, phase: 3.9, quantum: 4, playing: true, beat: 11.9 });
  assert.equal(bpm, 140);
  await new Promise((r) => setTimeout(r, 120)); // 0.1 beat at 140 bpm ≈ 43 ms
  assert.deepEqual(log.slice(1), [['seek', 4], ['play', 4]]);
  // drift: link phase 1.0, local beat 4.5 -> nudged by +0.5 beat
  beat = 4.5;
  lc.receive({ type: 'state', tempo: 140, phase: 1.0, quantum: 4, playing: true, beat: 13 });
  assert.deepEqual(log.at(-1), ['seek', 5]);
  lc.receive({ type: 'state', tempo: 140, phase: 1.1, quantum: 4, playing: false, beat: 13.1 });
  assert.deepEqual(log.at(-1), ['stop']);
});
