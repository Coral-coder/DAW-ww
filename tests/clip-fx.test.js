// Clip effects (src/audio/clip-fx.js): window spans / gate boundaries, scheduler events, MixGraph routing and PDC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipFxSpans, gateSchedule, hasClipFx, XFADE } from '../src/audio/clip-fx.js';
import { collectEvents } from '../src/audio/scheduler.js';
import { MixGraph } from '../src/audio/mixer.js';
import { createProject, createTrack, createEffect, createClip, createPattern, createNote } from '../src/core/model.js';
import { MockContext, impulseResponse, latentEffectFactory } from './lib/mock-audio.js';

const SR = 48000;
const lat = (frames) => ({ ...createEffect('lat'), params: { frames } });

test('hasClipFx: only enabled effects count', () => {
  assert.equal(hasClipFx({}), false);
  assert.equal(hasClipFx({ fx: [] }), false);
  assert.equal(hasClipFx({ fx: [{ ...createEffect('eq'), enabled: false }] }), false);
  assert.equal(hasClipFx({ fx: [createEffect('eq')] }), true);
});

test('clipFxSpans: pattern clips with fx clipped to the window; audio clips and plain clips ignored', () => {
  const clips = [
    { id: 'a', type: 'pattern', start: 0, length: 4, fx: [createEffect('eq')] },
    { id: 'b', type: 'pattern', start: 4, length: 4 },
    { id: 'c', type: 'pattern', start: 8, length: 8, fx: [createEffect('eq')] },
    { id: 'd', type: 'audio', start: 0, length: 16, fx: [createEffect('eq')] },
  ];
  assert.deepEqual(clipFxSpans(clips, 2, 10), [{ clipId: 'a', start: 2, end: 4 }, { clipId: 'c', start: 8, end: 10 }]);
  assert.deepEqual(clipFxSpans(clips, 4, 8), []);
  assert.deepEqual(clipFxSpans(clips, 4, 8.0000001), []); // a sliver below EPS is no span
});

test('gateSchedule: state at the window start + a point at every boundary inside it', () => {
  const spb = 0.5;
  const pts = gateSchedule([{ clipId: 'a', start: 2, end: 4 }, { clipId: 'c', start: 8, end: 10 }], 2, 10, ['a', 'c'], (b) => (b - 2) * spb);
  assert.deepEqual(pts.map((p) => [p.beat, p.at, p.gates.dry, p.gates.a, p.gates.c]), [
    [2, 0, 0, 1, 0], // window starts inside clip a: chain a only
    [4, 1, 1, 0, 0], // clip a ends: back to dry
    [8, 3, 0, 0, 1], // clip c starts
  ]);
  // a window with no fx clip is all dry
  assert.deepEqual(gateSchedule([], 4, 8, ['a'], () => 0).map((p) => p.gates), [{ dry: 1, a: 0 }]);
});

function midiProject() {
  const p = createProject();
  p.mode = 'song';
  p.master = { volume: 1, fx: [], automation: [] };
  const t = createTrack({ name: 'Keys', instrument: { type: 'synth', preset: null, params: {} } });
  const pat = createPattern(t.id, { length: 4, notes: [createNote(60, 0, 1), createNote(64, 2, 1)] });
  p.patterns[pat.id] = pat;
  p.tracks = [t];
  const plain = createClip(t.id, { patternId: pat.id, start: 0, length: 4 });
  const wet = { ...createClip(t.id, { patternId: pat.id, start: 4, length: 4 }), fx: [createEffect('eq')] };
  p.clips = [plain, wet];
  return { p, t, plain, wet };
}

test('collectEvents: one clipfx event per window on tracks with fx MIDI clips, spans follow the clip boundaries', () => {
  const { p, t, wet } = midiProject();
  const evs = collectEvents(p, 3, 5, { mode: 'song' });
  const g = evs.filter((e) => e.type === 'clipfx');
  assert.equal(g.length, 1);
  assert.deepEqual({ trackId: g[0].trackId, beat: g[0].beat, dur: g[0].dur, spans: g[0].spans }, { trackId: t.id, beat: 3, dur: 2, spans: [{ clipId: wet.id, start: 4, end: 5 }] });
  // contiguous windows cover the clip exactly once
  const covered = [];
  for (let b = 0; b < 12; b += 1.5) for (const e of collectEvents(p, b, b + 1.5, { mode: 'song' })) if (e.type === 'clipfx') for (const s of e.spans) covered.push([s.start, s.end]);
  const total = covered.reduce((s, [a, b]) => s + (b - a), 0);
  assert.ok(Math.abs(total - 4) < 1e-9 && Math.min(...covered.map((c) => c[0])) === 4 && Math.max(...covered.map((c) => c[1])) === 8);
  // no fx anywhere -> no gate events; pattern mode -> none
  p.clips[1].fx = [];
  assert.equal(collectEvents(p, 0, 8, { mode: 'song' }).filter((e) => e.type === 'clipfx').length, 0);
  p.clips[1].fx = [createEffect('eq')];
  assert.equal(collectEvents(p, 0, 8, { mode: 'pattern' }).filter((e) => e.type === 'clipfx').length, 0);
});

function audioGraph(p) {
  const ctx = new MockContext({ sampleRate: SR });
  const buf = ctx.createBuffer(2, SR * 10, SR);
  const graph = new MixGraph(ctx, {
    destination: ctx.destination, getBpm: () => p.bpm, getBeatAt: () => null,
    getSampleBuffer: () => buf, getSampleByName: () => null, onError: (e) => { throw e; }, meters: false,
    createEffect: latentEffectFactory((def) => def.params?.frames || 0),
  });
  graph.sync(p);
  return { ctx, graph };
}

function audioProject() {
  const p = createProject();
  p.mode = 'song';
  p.master = { volume: 1, fx: [], automation: [] };
  p.samples = { s1: { id: 's1', name: 'x', duration: 10 } };
  const t = createTrack({ type: 'audio', name: 'Vox' });
  const other = createTrack({ type: 'audio', name: 'Other' });
  p.tracks = [t, other];
  const a = { ...createClip(t.id, { type: 'audio', sampleId: 's1', start: 0, length: 4 }), fx: [lat(40), lat(20)] };
  const b = { ...createClip(t.id, { type: 'audio', sampleId: 's1', start: 4, length: 4 }), fx: [lat(10)] };
  const c = createClip(t.id, { type: 'audio', sampleId: 's1', start: 8, length: 4 });
  p.clips = [a, b, c];
  return { p, t, other, a, b, c };
}

test('MixGraph: clip chains are padded to the slowest one; PDC counts the rack like an insert', () => {
  const { p, t, other, a, b } = audioProject();
  const { ctx, graph } = audioGraph(p);
  const e = graph.tracks.get(t.id);
  assert.ok(e.strip.clipFx);
  assert.equal(Math.round(e.strip.clipFx.latency * SR), 60);
  assert.equal(Math.round(graph.latency * SR), 60);
  // every path of the track (dry: clip c / instrument, chain a, chain b) lands at the same frame, and the other
  // track is compensated to it
  const at = (node) => [...impulseResponse(node, ctx.destination, SR).keys()];
  assert.deepEqual(at(e.strip.input), [60]);
  assert.deepEqual(at(e.strip.clipFx.inputFor(a.id)), [60]);
  assert.deepEqual(at(e.strip.clipFx.inputFor(b.id)), [60]);
  assert.deepEqual(at(graph.tracks.get(other.id).strip.input), [60]);
});

test('MixGraph: audio clip sources play into their own chain; plain clips into the track input', () => {
  const { p, t, a, c } = audioProject();
  const { ctx, graph } = audioGraph(p);
  const e = graph.tracks.get(t.id);
  graph.playEvent({ type: 'audio', trackId: t.id, beat: 0, clip: a, offset: 0, dur: 4 }, 1, 0.5);
  graph.playEvent({ type: 'audio', trackId: t.id, beat: 8, clip: c, offset: 0, dur: 4 }, 5, 0.5);
  const [sa, sc] = ctx.started.map((s) => s.src);
  assert.ok(sa.outs[0].outs.includes(e.strip.clipFx.inputFor(a.id)));
  assert.ok(sc.outs[0].outs.includes(e.strip.input));
});

test('MixGraph: clipfx gate events switch the dry path and clip chain; stop resets to dry', () => {
  const { p, t, wet } = midiProject();
  const ctx = new MockContext({ sampleRate: SR });
  const graph = new MixGraph(ctx, {
    destination: ctx.destination, getBpm: () => p.bpm, getBeatAt: () => null, getSampleBuffer: () => null, getSampleByName: () => null,
    onError: () => {}, meters: false, createEffect: latentEffectFactory(() => 0),
  });
  graph.sync(p);
  const rack = graph.tracks.get(t.id).strip.clipFx;
  assert.ok(rack);
  const gate = rack.chains.get(wet.id).gate.gain;
  const ramps = [];
  const orig = gate.linearRampToValueAtTime.bind(gate);
  gate.linearRampToValueAtTime = (v, tt) => { ramps.push([v, tt]); return orig(v, tt); };
  for (const ev of collectEvents(p, 3, 5, { mode: 'song' })) if (ev.type === 'clipfx') graph.playEvent(ev, 10, 0.5);
  assert.equal(rack.dryGate.gain.value, 0);
  assert.equal(gate.value, 1);
  assert.deepEqual(ramps, [[1, 10.5]], 'crossfade into the chain ends exactly at the clip start (beat 4 = 0.5 s into the window)');
  assert.ok(XFADE > 0 && XFADE < 0.02);
  graph.allNotesOff(11);
  assert.equal(rack.dryGate.gain.value, 1);
  assert.equal(gate.value, 0);
  // removing the clip fx removes the rack and restores input -> inserts
  p.clips[1].fx = [];
  graph.sync(p);
  assert.equal(graph.tracks.get(t.id).strip.clipFx, null);
  const strip = graph.tracks.get(t.id).strip;
  assert.ok(strip.input.outs.includes(strip.inStage));
});

test('MixGraph: editing clip fx params updates in place; changing the chain rebuilds only that clip', () => {
  const { p, t, a, b } = audioProject();
  const { graph } = audioGraph(p);
  const rack = graph.tracks.get(t.id).strip.clipFx;
  const chainB = rack.chains.get(b.id);
  a.fx[0].params = { frames: 100 };
  graph.sync(p);
  assert.equal(rack.chains.get(b.id), chainB);
  assert.equal(Math.round(graph.latency * SR), 120);
  a.fx = [a.fx[0]];
  graph.sync(p);
  assert.equal(rack.chains.get(b.id), chainB);
  assert.equal(Math.round(rack.latency * SR), 100);
});
