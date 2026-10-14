// PDC inside the insert section: parallel plugboard branches meet aligned, sidechain keys (in-board and from other
// tracks) meet the audio they key, and tempo-synced LFOs read the beat at the time their audio is HEARD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alignInserts } from '../src/audio/latency.js';
import { MixGraph } from '../src/audio/mixer.js';
import { createProject, createTrack, createEffect } from '../src/core/model.js';
import { MockContext, impulseResponse } from './lib/mock-audio.js';

const SR = 48000;
const f = (frames) => frames / SR;
const frames = (sec) => Math.round(sec * SR);

/** Latent effects (pure delay of params.frames); keyed types get a keyInput summed into the output (mock LTI). */
function factory(envs) {
  return (ctx, def, env) => {
    const input = ctx.createGain(), d = ctx.createDelay(1), output = ctx.createGain();
    input.connect(d); d.connect(output);
    let keyInput = null;
    if (def.type === 'ducker') { keyInput = ctx.createGain(); keyInput.connect(output); }
    let cur = def;
    envs?.set(def.id, env);
    return {
      type: def.type, input, output, keyInput,
      get latency() { return (cur.params?.frames || 0) / ctx.sampleRate; },
      update(dd) { cur = dd || cur; d.delayTime.value = (cur.params?.frames || 0) / ctx.sampleRate; },
      refreshLatency() { return false; }, setBypass() {}, setTempo() {}, sync() {}, dispose() {},
    };
  };
}
const lat = (n) => ({ ...createEffect('lat'), params: { frames: n } });
const ducker = (src, n = 0) => ({ ...createEffect('ducker'), params: { sourceTrackId: src, frames: n } });

function build(p, envs) {
  const ctx = new MockContext({ sampleRate: SR });
  const graph = new MixGraph(ctx, {
    destination: ctx.destination, getBpm: () => 120, getBeatAt: (t) => t * 2, getSampleBuffer: () => null, getSampleByName: () => null,
    onError: (e) => { throw e; }, meters: false, createEffect: factory(envs),
  });
  graph.sync(p);
  return { ctx, graph };
}
const fxOf = (graph, trackId, fxId) => graph.tracks.get(trackId).strip.effects.find((e) => e.id === fxId).fx;

test('alignInserts: branches wait for the slowest, keys meet their audio, unreachable nodes are ignored', () => {
  const r = alignInserts({
    sampleRate: 1000,
    nodes: [{ id: 'a', latency: 0.04 }, { id: 'b', latency: 0.09 }, { id: 'd', latency: 0.01 }, { id: 'x', latency: 1 }],
    cables: [
      { id: 'c1', from: 'in', to: 'a' }, { id: 'c2', from: 'in', to: 'b' }, { id: 'c3', from: 'a', to: 'out' },
      { id: 'c4', from: 'b', to: 'out' }, { id: 'k', from: 'b', to: 'd', port: 1 }, { id: 'c5', from: 'in', to: 'd' },
      { id: 'c6', from: 'd', to: 'out' }, { id: 'c7', from: 'x', to: 'out' },
    ],
  });
  assert.equal(r.latency, 0.1);
  assert.deepEqual([r.cable.c3, r.cable.c4, r.cable.c6, r.cable.c5, r.cable.k], [0.06, 0.01, 0, 0.09, 0]);
  assert.equal(r.arrive.x, undefined);
  // external key later than the audio: the audio waits; earlier: the key waits
  const late = alignInserts({ sampleRate: 1000, nodes: [{ id: 'd', latency: 0 }], cables: [{ id: 'c', from: 'in', to: 'd' }, { id: 'o', from: 'd', to: 'out' }], keys: { d: 0.05 } });
  assert.deepEqual([late.latency, late.cable.c, late.key.d], [0.05, 0.05, 0]);
  const early = alignInserts({ sampleRate: 1000, nodes: [{ id: 'd', latency: 0 }], cables: [{ id: 'c', from: 'in', to: 'd' }, { id: 'o', from: 'd', to: 'out' }], keys: { d: -0.02 } });
  assert.deepEqual([early.latency, early.cable.c, early.key.d], [0, 0, 0.02]);
});

test('plugboard: parallel branches with different latencies sum aligned (one arrival, full amplitude)', () => {
  const p = createProject();
  p.master = { volume: 1, fx: [], automation: [] };
  const fx1 = lat(40), fx2 = lat(90);
  const t = createTrack({ type: 'audio', fx: [fx1, fx2], volume: 1 });
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
  p.tracks = [t];
  const { ctx, graph } = build(p);
  const strip = graph.tracks.get(t.id).strip;
  assert.deepEqual([...impulseResponse(strip.input, strip.post, SR)], [[90, 2]]);
  assert.equal(frames(graph.latency), 90);
  // PDC off: old behaviour (branches not aligned)
  p.pdc = false; graph.sync(p);
  assert.deepEqual([...impulseResponse(strip.input, strip.post, SR).keys()].sort((a, b) => a - b), [40, 90]);
  void ctx;
});

test('plugboard: an in-board key from a latent branch meets the ducked audio', () => {
  const p = createProject();
  p.master = { volume: 1, fx: [], automation: [] };
  const slow = lat(64), dk = ducker('', 0);
  const t = createTrack({ type: 'audio', fx: [slow, dk], volume: 1 });
  t.patch = {
    enabled: true,
    nodes: [{ id: 's', kind: 'fx', fxId: slow.id, x: 0, y: 0 }, { id: 'd', kind: 'fx', fxId: dk.id, x: 0, y: 100 }],
    cables: [
      { id: 'a', from: { node: 'in', port: 0 }, to: { node: 'd', port: 0 }, gain: 1 },
      { id: 'b', from: { node: 'in', port: 0 }, to: { node: 's', port: 0 }, gain: 1 },
      { id: 'k', from: { node: 's', port: 0 }, to: { node: 'd', port: 1 }, gain: 1 },
      { id: 'o', from: { node: 'd', port: 0 }, to: { node: 'out', port: 0 }, gain: 1 },
    ],
  };
  p.tracks = [t];
  const { graph } = build(p);
  const strip = graph.tracks.get(t.id).strip;
  const d = fxOf(graph, t.id, dk.id);
  assert.deepEqual([...impulseResponse(strip.input, d.input, SR).keys()], [64], 'audio waits for the key branch');
  assert.deepEqual([...impulseResponse(strip.input, d.keyInput, SR).keys()], [64]);
  assert.equal(frames(strip.insertLatency), 64);
});

for (const [name, kLat, pre, keyDelay, audioDelay] of [['late key: the ducked track waits', 100, 30, 0, 70], ['early key: the key waits', 10, 30, 20, 0]]) {
  test(`external sidechain (${name}); everything still meets at the master`, () => {
    const p = createProject();
    p.master = { volume: 1, fx: [], automation: [] };
    const kick = createTrack({ type: 'audio', name: 'Kick', fx: [lat(kLat)] });
    const dk = ducker(kick.id, 0);
    const bass = createTrack({ type: 'audio', name: 'Bass', fx: [lat(pre), dk] });
    p.tracks = [kick, bass];
    const { ctx, graph } = build(p);
    const d = fxOf(graph, bass.id, dk.id);
    const ks = graph.tracks.get(kick.id).strip, bs = graph.tracks.get(bass.id).strip;
    const keyAt = [...impulseResponse(ks.input, d.keyInput, SR).keys()];
    const audioAt = [...impulseResponse(bs.input, d.input, SR).keys()];
    assert.deepEqual(keyAt, audioAt, 'key and ducked audio arrive together');
    assert.deepEqual(keyAt, [Math.max(kLat, pre)]);
    assert.equal(frames(graph.keyLinks.get(dk.id).link.sec), keyDelay);
    assert.equal(frames(bs.insertLatency), pre + audioDelay);
    // both tracks (and the key path into the bass output) reach the master input together
    const total = frames(graph.latency);
    assert.deepEqual([...impulseResponse(ks.input, ctx.destination, SR).keys()], [total]);
    assert.deepEqual([...impulseResponse(bs.input, ctx.destination, SR).keys()], [total]);
  });
}

test('tempo-synced LFOs inside compensated inserts read the beat at their heard time', () => {
  const p = createProject();
  p.master = { volume: 1, fx: [lat(20)], automation: [] };
  const envs = new Map();
  const lfoA = lat(0), lfoB = lat(0);
  const a = createTrack({ type: 'audio', fx: [lat(100), lfoA] });
  const b = createTrack({ type: 'audio', fx: [lfoB] });
  p.tracks = [a, b];
  const { graph } = build(p, envs);
  assert.equal(frames(graph.latency), 120);
  // getBeatAt(t) = 2t (120 BPM): an LFO hears its audio `heard` seconds later
  const heardOf = (fx) => (envs.get(fx.id).getBeatAt(1) - 2) / 2;
  assert.equal(frames(heardOf(lfoA)), 20); // after 100 of track latency: 20 to go (master)
  assert.equal(frames(heardOf(lfoB)), 120); // at the strip input: 100 compensation + 20 master
});
