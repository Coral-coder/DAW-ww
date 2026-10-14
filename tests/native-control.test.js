// Mac app native layer — the JS side that needs no native build: MIDI learn on native plugin parameters
// (targets, controller feedback), sample-accurate automation events for the offline render, the bridge node
// layout (sidechain / multi-out), the new protocol calls, sidechain keying of native effects, Ableton Link
// (LinkClient start hook, the WebSocket server, the daw3-link process when it is built).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MappingEngine } from '../src/control/mapping.js';
import { applyNorm, targetNorm } from '../src/control/targets.js';
import { createProject, createTrack, createEffect } from '../src/core/model.js';
import { setStatus, pluginKey } from '../src/plugins/status.js';
import { controlsFromParams, midiToValue } from '../src/native/params.js';
import { nativeAutomationEvents, laneToPlain } from '../src/native/automation.js';
import { pluginNodeLayout } from '../src/native/client.js';
import { validateCall, validateStreamMessage, PRESET_NAME } from '../src/native/protocol.js';
import { KEYED_FX, resolveKeyLinks } from '../src/core/patch.js';
import { EFFECT_DEFS } from '../src/audio/effect-defs.js';
import { LinkClient, LINK_DEFAULT_URL } from '../src/control/link-client.js';
import { targetGroups } from '../src/ui/automation-targets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);

// a native instrument (CLAP-style Gain 0..2 + a bool "Bypass"-like switch) and a native effect (VST3-style 0..1)
const INST_PARAMS = [
  { id: 1, name: 'Gain', module: 'Main', min: 0, max: 2, default: 1, steps: 0, flags: 1 },
  { id: 7, name: 'Mono', module: 'Main', min: 0, max: 1, default: 0, steps: 1, flags: 1 | 2 },
  { id: 9, name: 'Hidden', min: 0, max: 1, default: 0, flags: 4 },
];
const FX_PARAMS = [{ id: 0, name: 'Threshold', min: 0, max: 1, default: 0.5, steps: 0, flags: 1 }];

function nativeProject() {
  const p = createProject();
  const inst = { type: 'native', params: { key: 'clap:daw3.test.tone', format: 'clap', uid: 'daw3.test.tone', name: 'Tone', values: { 1: 1 }, state: '' } };
  const t = createTrack({ name: 'Synth', instrument: inst });
  const fx = createEffect('native', { key: 'vst3:ABCDEF', format: 'vst3', uid: 'ABCDEF', name: 'Comp', values: { 0: 0.5 }, mix: 1 });
  t.fx.push(fx);
  const kick = createTrack({ name: 'Kick' });
  p.tracks.push(t, kick);
  setStatus(pluginKey(inst), { state: 'ready', info: { params: controlsFromParams(INST_PARAMS), outputBuses: [{ name: 'Main', channels: 2 }, { name: 'Aux', channels: 2 }] } });
  setStatus(pluginKey(fx), { state: 'ready', info: { params: controlsFromParams(FX_PARAMS), sidechain: 2 } });
  return { p, t, fx, kick };
}

test('MIDI learn: native plugin parameters are learnable targets (instrument + effect), with controller feedback', () => {
  const { p, t, fx } = nativeProject();
  // they show up as automation / learn targets of the track
  const groups = targetGroups(p, t.id);
  const all = groups.flatMap((g) => g.items.map((i) => i.target));
  assert.ok(all.includes('inst:values.1') && all.includes('inst:values.7'));
  assert.ok(!all.includes('inst:values.9'), 'hidden parameters are not targets');
  assert.ok(all.includes(`fx:${fx.id}:values.0`));
  near(targetNorm(p, t.id, 'inst:values.1'), 0.5);

  const sent = [];
  const engine = new MappingEngine({
    getNorm: (tg) => targetNorm(p, tg.owner, tg.target),
    setNorm: (tg, n) => applyNorm(p, tg.owner, tg.target, n),
    send: (d, b) => sent.push(b),
  });
  // learn a knob (CC 21) for the plugin's Gain, a button (note 36) for its switch, CC 22 for the effect
  engine.startLearn({ owner: t.id, target: 'inst:values.1' });
  [60, 61, 62, 63, 64, 65].forEach((v, i) => engine.handle('Knobs', [0xb0, 21, v], i * 20));
  assert.equal(engine.mappings.length, 1);
  assert.equal(engine.mappings[0].mode, 'absolute');
  engine.handle('Knobs', [0xb0, 21, 127], 10100);
  near(t.instrument.params.values['1'], 2);
  engine.handle('Knobs', [0xb0, 21, 0], 10200);
  near(t.instrument.params.values['1'], 0);
  engine.startLearn({ owner: t.id, target: 'inst:values.7' });
  engine.handle('Pads', [0x90, 36, 100], 20000); // learns the pad (a toggle button)
  engine.handle('Pads', [0x80, 36, 0], 20050);
  engine.handle('Pads', [0x90, 36, 100], 20100);
  assert.equal(t.instrument.params.values['7'], true, 'bool switch toggles on');
  engine.handle('Pads', [0x80, 36, 0], 20150);
  engine.handle('Pads', [0x90, 36, 100], 20200);
  assert.equal(t.instrument.params.values['7'], false, 'and off');
  engine.startLearn({ owner: t.id, target: `fx:${fx.id}:values.0` });
  [60, 61, 62, 63, 64, 65].forEach((v, i) => engine.handle('Knobs', [0xb0, 22, v], 30000 + i * 20));
  engine.handle('Knobs', [0xb0, 22, 96], 40100);
  near(fx.params.values['0'], 96 / 127, 0.002);
  // the same value midiToValue gives the plugin-device knobs
  near(midiToValue(controlsFromParams(FX_PARAMS)[0], 96), 96 / 127, 0.002);

  // feedback: the plugin's own window moved Gain to 1.5 -> the knob's LED ring follows (CC 21 = 95)
  t.instrument.params.values['1'] = 1.5;
  const gainMap = engine.mappings.find((m) => m.target.target === 'inst:values.1');
  assert.deepEqual(engine.feedbackBytes(gainMap, targetNorm(p, t.id, 'inst:values.1')), [[0xb0, 21, 95]]);
  const fxMap = engine.mappings.find((m) => m.target.target === `fx:${fx.id}:values.0`);
  assert.deepEqual(engine.feedbackBytes(fxMap, targetNorm(p, t.id, `fx:${fx.id}:values.0`)), [[0xb0, 22, 96]]);
});

test('offline render: native parameter automation -> sample-accurate events (ramps, jumps, bool, tempo map)', () => {
  const controls = controlsFromParams(INST_PARAMS);
  const track = {
    automation: [
      // gain: 1 until beat 1, ramp to 2 at beat 2, jump to 0 at beat 3
      { id: 'a', target: 'inst:values.1', enabled: true, points: [{ beat: 1, value: 1 }, { beat: 2, value: 2 }, { beat: 3, value: 2 }, { beat: 3, value: 0 }] },
      { id: 'b', target: 'inst:values.7', enabled: true, points: [{ beat: 0, value: 0 }, { beat: 2.5, value: 0.9 }] },
      { id: 'c', target: 'inst:values.99', enabled: true, points: [{ beat: 0, value: 1 }] }, // unknown parameter
      { id: 'd', target: 'volume', enabled: true, points: [{ beat: 0, value: 1 }] },
    ],
  };
  const frameAt = (b) => b * 24000; // 120 bpm @ 48 kHz
  const { events, initial } = nativeAutomationEvents(track, { controls, startBeat: 0, endBeat: 4, frameAt, step: 1200 });
  assert.deepEqual(initial, { 1: 1, 7: 0 });
  const gain = events.filter((e) => e[1] === 1), mono = events.filter((e) => e[1] === 7);
  assert.ok(events.every((e) => e[1] !== 99), 'unknown parameters are skipped');
  // the ramp: steps every 1200 frames from beat 1 (frame 24000) to beat 2 (48000), then the breakpoint value
  assert.equal(gain[0][0], 25200);
  near(gain[0][2], 1.05);
  assert.deepEqual(gain.at(-2), [48000, 1, 2]);
  assert.deepEqual(gain.at(-1), [72000, 1, 0], 'the jump lands on its frame');
  assert.equal(gain.length, 19 + 1 + 1);
  for (let k = 1; k < gain.length; k++) assert.ok(gain[k][0] >= gain[k - 1][0], 'sorted');
  // bool: snaps to min / max — one event, at the first step after the ramp crosses 0.5 (beat 2.5 * 0.5 / 0.9)
  assert.equal(mono.length, 1);
  assert.deepEqual(mono[0], [33600, 7, 1]);
  // a range starting mid-ramp starts from the interpolated value, frames relative to the range start
  const mid = nativeAutomationEvents(track, { controls, startBeat: 1.5, endBeat: 2, frameAt, step: 1200 });
  near(mid.initial['1'], 1.5);
  assert.equal(mid.events[0][0], 1200);
  assert.deepEqual(mid.events.filter((e) => e[1] === 1).at(-1)?.slice(1), [1, 1.95]);
  // tempo map: frames follow frameAt
  const slow = nativeAutomationEvents(track, { controls, startBeat: 0, endBeat: 4, frameAt: (b) => b * 48000, step: 1e9 });
  assert.deepEqual(slow.events.filter((e) => e[1] === 1).map((e) => e[0]), [96000, 144000]);
  assert.equal(laneToPlain(controls[0], 5), 2, 'clamped to the range');
  assert.equal(laneToPlain(null, 'x'), null);
  assert.deepEqual(nativeAutomationEvents(null, { frameAt, endBeat: 4 }), { events: [], initial: {} });
});

test('bridge node layout: sidechain inputs and one output per plugin bus', () => {
  assert.deepEqual(pluginNodeLayout({ numIn: 2, numOut: 2 }), { numIn: 2, numSc: 0, buses: [2], busIds: [0], totalOut: 2 });
  assert.deepEqual(pluginNodeLayout({ numIn: 2, numSc: 2, numOut: 2 }).numSc, 2);
  const multi = pluginNodeLayout({ numIn: 0, outputBuses: [{ channels: 2 }, { channels: 0 }, { channels: 1 }, { channels: 6 }] });
  assert.deepEqual(multi.buses, [2, 1, 6]);
  assert.deepEqual(multi.busIds, [0, 2, 3]);
  assert.equal(multi.totalOut, 9);
  // never more than 32 channels: buses stop at the first one that no longer fits (the host fills them in order)
  const big = pluginNodeLayout({ outputBuses: Array.from({ length: 20 }, () => ({ channels: 8 })) });
  assert.equal(big.totalOut, 32);
  assert.equal(big.buses.length, 4);
});

test('protocol: presets, render automation, sidechain stream blocks are validated', () => {
  assert.ok(validateCall('plugins.presets', [3]));
  assert.ok(validateCall('plugins.loadPreset', [3, 'program:1:2']));
  assert.throws(() => validateCall('plugins.loadPreset', [3, '']));
  assert.ok(validateCall('plugins.savePreset', [3, 'Warm pad (soft)']));
  for (const bad of ['../x', 'a/b', '.hidden', '', 'x'.repeat(200)]) assert.throws(() => validateCall('plugins.savePreset', [3, bad]), bad);
  assert.ok(PRESET_NAME.test('Café 2'));
  assert.ok(validateCall('plugins.render', [{ inst: 1, frames: 100, events: [], params: [[0, 1, 0.5]] }]));
  assert.throws(() => validateCall('plugins.render', [{ inst: 1, frames: 100, params: {} }]));
  const base = { t: 'proc', inst: 1, block: 0, numIn: 2, numOut: 4, input: new Float32Array(256), midi: new Float64Array(0) };
  assert.ok(validateStreamMessage(base));
  assert.ok(validateStreamMessage({ ...base, numSc: 2, sidechain: new Float32Array(256) }));
  assert.ok(!validateStreamMessage({ ...base, numSc: 2, sidechain: new Float32Array(128) }));
  assert.ok(!validateStreamMessage({ ...base, numSc: 9, sidechain: new Float32Array(9 * 128) }));
  assert.ok(validateStreamMessage({ ...base, numOut: 32 }));
  assert.ok(!validateStreamMessage({ ...base, numOut: 33 }));
});

test('sidechain: a native effect is keyed from the track picker like the built-in compressor', () => {
  const { p, fx, kick } = nativeProject();
  assert.ok(KEYED_FX.has('native'));
  const def = EFFECT_DEFS.native.params.find((d) => d.key === 'sourceTrackId');
  assert.equal(def?.type, 'track');
  fx.params.sourceTrackId = kick.id;
  assert.equal(resolveKeyLinks(p).get(fx.id), kick.id);
  fx.params.sourceTrackId = p.tracks.find((t) => t.fx.includes(fx)).id; // keying itself is dropped
  assert.equal(resolveKeyLinks(p).has(fx.id), false);
});

test('Link: the Mac app starts its built-in Link before connecting (LinkClient start hook)', async () => {
  const opened = [];
  class FakeWS { constructor(url) { this.url = url; opened.push(url); this.readyState = 0; } send() {} close() { this.onclose?.(); } }
  const host = { bpm: () => 120, setBpm() {}, playing: () => false, beat: () => 0, play() {}, stop() {}, setBeat() {}, now: () => Date.now() };
  let starts = 0;
  const c = new LinkClient(host, { WebSocketImpl: FakeWS, start: async () => { starts++; return 'ws://127.0.0.1:40001'; } });
  c.connect(LINK_DEFAULT_URL);
  assert.equal(c.status, 'connecting');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(starts, 1);
  assert.deepEqual(opened, ['ws://127.0.0.1:40001']);
  // a custom bridge URL bypasses the built-in Link
  c.connect('ws://10.0.0.2:20809');
  assert.equal(opened.at(-1), 'ws://10.0.0.2:20809');
  c.disconnect();
  const failing = new LinkClient(host, { WebSocketImpl: FakeWS, start: async () => { throw new Error('nope'); } });
  failing.connect();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(failing.status, 'error');
});

const wsOk = typeof WebSocket !== 'undefined';
async function linkSession(link, fn) {
  const { startLinkServer } = require('../desktop/link-server.cjs');
  const srv = await startLinkServer({ link, port: 0 });
  const states = [];
  const ws = new WebSocket(srv.url);
  ws.onmessage = (e) => states.push(JSON.parse(e.data));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  try { await fn({ srv, ws, states, wait: async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return pred(); } }); }
  finally { ws.close(); srv.close(); }
}

test('Link server: the tools/link-bridge protocol over a local WebSocket (simulated session)', { skip: wsOk ? false : 'no WebSocket in this Node' }, async () => {
  const { simulatedLink } = require('../desktop/link-server.cjs');
  await linkSession(simulatedLink(), async ({ ws, states, wait }) => {
    assert.ok(await wait(() => states.length > 0));
    assert.equal(states[0].type, 'state');
    assert.equal(states[0].link, false);
    ws.send(JSON.stringify({ type: 'tempo', bpm: 128 }));
    ws.send(JSON.stringify({ type: 'quantum', value: 3 }));
    ws.send(JSON.stringify({ type: 'play' }));
    assert.ok(await wait(() => states.at(-1).tempo === 128 && states.at(-1).playing && states.at(-1).quantum === 3));
    assert.ok(states.at(-1).phase >= 0 && states.at(-1).phase < 3);
  });
});

const linkBin = path.join(root, 'desktop', 'native', 'build', 'daw3-link');
test('Link server + daw3-link: Ableton Link built natively, same protocol', { skip: !wsOk ? 'no WebSocket in this Node' : !existsSync(linkBin) ? 'daw3-link not built (sh desktop/native/build.sh)' : false }, async () => {
  const { processLink } = require('../desktop/link-server.cjs');
  let srv = null;
  const link = processLink(linkBin, { onState: () => srv?.broadcast() });
  await link.ready;
  await linkSession(link, async ({ srv: s, ws, states, wait }) => {
    srv = s;
    assert.ok(await wait(() => states.some((x) => x.link === true)), 'real Link session');
    ws.send(JSON.stringify({ type: 'tempo', bpm: 97.5 }));
    ws.send(JSON.stringify({ type: 'play' }));
    assert.ok(await wait(() => Math.abs(states.at(-1).tempo - 97.5) < 1e-6 && states.at(-1).playing === true), JSON.stringify(states.at(-1)));
    ws.send(JSON.stringify({ type: 'stop' }));
    assert.ok(await wait(() => states.at(-1).playing === false));
    const a = states.at(-1);
    await new Promise((r) => setTimeout(r, 120));
    const b = states.at(-1);
    assert.ok(b.beat > a.beat, 'the Link timeline runs');
  });
  assert.ok(await new Promise((r) => { const t0 = Date.now(); const iv = setInterval(() => { if (!link.alive || Date.now() - t0 > 3000) { clearInterval(iv); r(!link.alive); } }, 20); }), 'the process ends with the server');
});
