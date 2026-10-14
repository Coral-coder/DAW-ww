// Plugin delay compensation: pure plan (latency.js), the mixer's compensation delays (impulse alignment on a mock
// LTI Web Audio graph with synthetic latencies), the scheduler's pre-roll and the effect latency table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePdc, effectLatencyFrames, faderOffsets, quantize } from '../src/audio/latency.js';
import { MixGraph } from '../src/audio/mixer.js';
import { Scheduler } from '../src/audio/scheduler.js';
import { createProject, createTrack, createEffect, createBus } from '../src/core/model.js';
import { MockContext, impulseResponse, latentEffectFactory } from './lib/mock-audio.js';

const SR = 48000;
const f = (frames) => frames / SR;

test('computePdc: aligns direct, send and bus routes at the master input', () => {
  const pdc = computePdc({
    sampleRate: SR,
    tracks: [{ id: 'a', latency: 0, sends: ['r'] }, { id: 'b', latency: f(100), sends: ['r'] }, { id: 'c', latency: f(10), sends: [] }],
    buses: [{ id: 'r', latency: f(50) }, { id: 'unused', latency: f(5000) }],
    master: f(20),
  });
  assert.equal(pdc.align, f(150)); // b -> r: 100 + 50
  assert.equal(pdc.total, f(170));
  assert.equal(pdc.trackOut.a, f(150));
  assert.equal(pdc.trackOut.b, f(50));
  assert.equal(pdc.trackOut.c, f(140));
  assert.equal(pdc.trackSend.a.r, f(100));
  assert.equal(pdc.trackSend.b.r, 0);
  // every route arrives at the master input at `align`
  for (const t of ['a', 'b']) {
    assert.equal(quantize(pdc.trackLatency[t] + pdc.trackOut[t], SR), pdc.align);
    assert.equal(quantize(pdc.trackLatency[t] + pdc.trackSend[t].r + pdc.busLatency.r, SR), pdc.align);
  }
  const off = faderOffsets(pdc);
  assert.equal(off.tracks.b, f(100));
  assert.equal(off.bus, f(150));
  assert.equal(off.master, f(170));
});

test('computePdc: disabled -> no compensation; no latency -> zero plan', () => {
  const off = computePdc({ sampleRate: SR, enabled: false, tracks: [{ id: 'a', latency: f(64) }], buses: [], master: f(10) });
  assert.equal(off.total, 0);
  assert.equal(off.trackOut.a, 0);
  const zero = computePdc({ sampleRate: SR, tracks: [{ id: 'a', latency: 0, sends: ['x'] }], buses: [{ id: 'x', latency: 0 }], master: 0 });
  assert.equal(zero.total, 0);
  assert.equal(zero.trackOut.a, 0);
  assert.equal(zero.trackSend.a.x, 0);
});

test('effect latency table (Chromium-measured) + manual override', () => {
  assert.equal(effectLatencyFrames({ type: 'compressor' }, 44100), 264);
  assert.equal(effectLatencyFrames({ type: 'compressor' }, 48000), 288);
  assert.equal(effectLatencyFrames({ type: 'limiter' }, 96000), 576);
  assert.equal(effectLatencyFrames({ type: 'gate' }, 44100), 176);
  assert.equal(effectLatencyFrames({ type: 'tape' }, 44100), 529 + 129);
  assert.equal(effectLatencyFrames({ type: 'mastering' }, 44100), 720);
  assert.equal(effectLatencyFrames({ type: 'eq8' }, 44100), 0);
  assert.equal(effectLatencyFrames({ type: 'reverb' }, 44100), 0);
  assert.equal(effectLatencyFrames({ type: 'faust' }, 44100), 0);
  assert.equal(effectLatencyFrames({ type: 'faust', latency: 512 }, 44100), 512);
});

/** Project: a (dry) and b (latent insert) both send to bus r (latent insert); master has a latent insert. */
function pdcProject() {
  const p = createProject();
  const r = createBus('R', [{ ...createEffect('lat'), params: { frames: 50 } }]);
  p.buses = [r];
  const a = createTrack({ type: 'audio', name: 'A', sends: { [r.id]: 0.5 } });
  const b = createTrack({ type: 'audio', name: 'B', sends: { [r.id]: 0.25 }, fx: [{ ...createEffect('lat'), params: { frames: 100 } }] });
  const c = createTrack({ type: 'audio', name: 'C', fx: [{ ...createEffect('lat'), params: { frames: 30 } }, { ...createEffect('lat'), params: { frames: 12 } }] });
  p.tracks = [a, b, c];
  p.master = { volume: 1, fx: [{ ...createEffect('lat'), params: { frames: 20 } }], automation: [] };
  return { p, a, b, c, r };
}

function buildGraph(p) {
  const ctx = new MockContext({ sampleRate: SR });
  const graph = new MixGraph(ctx, {
    destination: ctx.destination, getBpm: () => p.bpm, getBeatAt: () => null,
    getSampleBuffer: () => null, getSampleByName: () => null, onError: (e) => { throw e; }, meters: false,
    createEffect: latentEffectFactory((def) => def.params?.frames || 0),
  });
  graph.sync(p);
  return { ctx, graph };
}

test('MixGraph PDC: impulses through tracks, sends and buses all arrive together (synthetic latencies)', () => {
  const { p, a, b, c } = pdcProject();
  const { ctx, graph } = buildGraph(p);
  assert.equal(Math.round(graph.latency * SR), 170);
  for (const t of [a, b, c]) {
    const ir = impulseResponse(graph.tracks.get(t.id).strip.input, ctx.destination, SR);
    assert.deepEqual([...ir.keys()], [170], `track ${t.name}: every path (direct + send) lands at frame 170, got ${[...ir.keys()]}`);
  }
  // amplitude: direct (track vol 0.8 · master 1) + send (0.8 · send · bus vol 0.8), all coherent
  const irA = impulseResponse(graph.tracks.get(a.id).strip.input, ctx.destination, SR);
  assert.ok(Math.abs(irA.get(170) - (0.8 + 0.8 * 0.5 * 0.8)) < 1e-9);
  assert.deepEqual(graph.latencyReport().tracks[b.id] * SR, 100);
});

test('MixGraph PDC: disabled per project -> raw (uncompensated) latencies, no pre-roll', () => {
  const { p, a, b } = pdcProject();
  p.pdc = false;
  const { ctx, graph } = buildGraph(p);
  assert.equal(graph.latency, 0);
  const irA = impulseResponse(graph.tracks.get(a.id).strip.input, ctx.destination, SR);
  assert.deepEqual([...irA.keys()].sort((x, y) => x - y), [20, 70]); // direct: master 20; via bus: 50 + 20
  const irB = impulseResponse(graph.tracks.get(b.id).strip.input, ctx.destination, SR);
  assert.deepEqual([...irB.keys()].sort((x, y) => x - y), [120, 170]);
});

test('MixGraph PDC: re-plans when inserts / sends change; removing latency removes compensation', () => {
  const { p, a, b } = pdcProject();
  const { ctx, graph } = buildGraph(p);
  // b's insert removed, master insert removed: only the bus latency is left on the send routes
  b.fx = [];
  p.master.fx = [];
  p.tracks[2].fx = [];
  graph.sync(p);
  assert.equal(Math.round(graph.latency * SR), 50);
  for (const t of [a, b]) assert.deepEqual([...impulseResponse(graph.tracks.get(t.id).strip.input, ctx.destination, SR).keys()], [50]);
  // no sends -> the bus does not count
  a.sends = {}; b.sends = {};
  graph.sync(p);
  assert.equal(graph.latency, 0);
  assert.deepEqual([...impulseResponse(graph.tracks.get(a.id).strip.input, ctx.destination, SR).keys()], [0]);
});

test('MixGraph PDC: plugboard insert latency = longest path in -> out', () => {
  const p = createProject();
  p.master = { volume: 1, fx: [], automation: [] };
  const fx1 = { ...createEffect('lat'), params: { frames: 40 } };
  const fx2 = { ...createEffect('lat'), params: { frames: 90 } };
  const t = createTrack({ type: 'audio', fx: [fx1, fx2] });
  t.patch = {
    enabled: true,
    nodes: [{ id: 'n1', kind: 'fx', fxId: fx1.id, x: 0, y: 0 }, { id: 'n2', kind: 'fx', fxId: fx2.id, x: 0, y: 100 }],
    cables: [
      { id: 'c1', from: { node: 'in', port: 0 }, to: { node: 'n1', port: 0 }, gain: 1 },
      { id: 'c2', from: { node: 'in', port: 0 }, to: { node: 'n2', port: 0 }, gain: 1 },
      { id: 'c3', from: { node: 'n1', port: 0 }, to: { node: 'out', port: 0 }, gain: 1 },
      { id: 'c4', from: { node: 'n2', port: 0 }, to: { node: 'out', port: 0 }, gain: 1 },
    ],
  };
  p.tracks = [t, createTrack({ type: 'audio' })];
  const { graph } = buildGraph(p);
  assert.equal(Math.round(graph.tracks.get(t.id).strip.insertLatency * SR), 90);
  assert.equal(Math.round(graph.latency * SR), 90);
});

test('click is scheduled after the compensated mix (heard on time)', () => {
  const { p } = pdcProject();
  const { ctx, graph } = buildGraph(p);
  const at = [];
  ctx.createOscillator = () => { const n = ctx.createGain(); n.frequency = { value: 0, setValueAtTime() {} }; n.start = (t) => at.push(t); n.stop = () => {}; return n; };
  ctx.createBiquadFilter = () => { const n = ctx.createGain(); n.frequency = { value: 0 }; n.Q = { value: 0 }; return n; };
  graph.playEvent({ type: 'click', beat: 0, accent: false }, 1, 0.5);
  assert.ok(at.length && Math.abs(at[0] - (1 + 170 / SR)) < 1e-9, `click at ${at[0]}`);
});

test('Scheduler pre-rolls every event by the graph latency; anchors stay in heard time', () => {
  const ctx = { currentTime: 10 };
  const p = createProject();
  p.mode = 'song';
  p.bpm = 120;
  p.loop.enabled = false;
  const sent = [];
  const sched = new Scheduler({
    ctx, getProject: () => p, codeCache: null, dispatch: (ev, time) => sent.push({ ev, time }),
    getPreroll: () => 0.2, metronome: true, interval: 1e9,
  });
  p.metronome = true;
  const t0 = sched.start(0);
  clearInterval(sched.timer);
  assert.ok(Math.abs(t0 - (10 + 0.06 + 0.2)) < 1e-9);
  assert.equal(sched.beatAt(t0), 0);
  const click0 = sent.find((s) => s.ev.type === 'click' && s.ev.beat === 0);
  assert.ok(click0 && Math.abs(click0.time - (t0 - 0.2)) < 1e-9, 'beat 0 dispatched 0.2 s before it is heard');
  // horizon includes the pre-roll: the first window reaches lookahead past now + pre-roll
  assert.ok(sent.some((s) => s.ev.beat === 0));
  sched.stop();
});
