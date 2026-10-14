// Track freeze: model helpers, event collection (frozen tracks play their render), mixer (no instrument / inserts
// instantiated), render variant and the store edit guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frozenMode, frozenStaleReason, freezeVariant, createFreezeGuard, isFrozen, sampleInUse, FROZEN_HINT,
} from '../src/core/freeze.js';
import { collectEvents } from '../src/audio/scheduler.js';
import { MixGraph } from '../src/audio/mixer.js';
import { Store } from '../src/core/store.js';
import { createProject, createTrack, createEffect, createPattern, createClip, createNote, createBus } from '../src/core/model.js';
import { MockContext, latentEffectFactory } from './lib/mock-audio.js';

function songWithSynth() {
  const p = createProject();
  p.mode = 'song';
  p.bpm = 120;
  const t = createTrack({ name: 'Lead', fx: [createEffect('compressor'), createEffect('reverb')], volume: 0.7, pan: -0.3 });
  const pat = createPattern(t.id, { length: 4, notes: [createNote(60, 0, 1), createNote(64, 1, 1), createNote(67, 2, 1)] });
  p.patterns[pat.id] = pat;
  t.activePatternId = pat.id;
  p.tracks.push(t);
  p.clips.push(createClip(t.id, { patternId: pat.id, start: 0, length: 8 }));
  p.samples.smp_f = { id: 'smp_f', name: 'Lead (frozen)', mime: 'audio/wav', data: '', duration: 6, frozen: true };
  t.frozen = { sampleId: 'smp_f', mode: 'postFx', renderMode: 'song', start: 0, length: 12, gain: 1.2, bpm: 120 };
  return { p, t, pat };
}

test('frozenMode: in effect only with its sample, transport mode and tempo', () => {
  const { p, t } = songWithSynth();
  assert.equal(isFrozen(t), true);
  assert.equal(frozenMode(p, t), 'postFx');
  assert.equal(frozenMode(p, t, 'pattern'), null);
  assert.match(frozenStaleReason({ ...p, mode: 'pattern' }, t), /song mode/);
  assert.equal(frozenMode({ ...p, bpm: 128 }, t), null);
  assert.match(frozenStaleReason({ ...p, bpm: 128 }, t), /tempo changed/);
  assert.equal(frozenMode({ ...p, samples: {} }, t), null);
  assert.equal(frozenMode(p, { ...t, frozen: null }), null);
  assert.equal(sampleInUse(p, 'smp_f'), true);
  assert.equal(sampleInUse(p, 'smp_f', t.id), false);
});

test('collectEvents: a frozen track plays its render instead of notes (song: one clip, jump-in mid-way)', () => {
  const { p, t } = songWithSynth();
  const ev = collectEvents(p, 0, 4, { mode: 'song', jump: true });
  assert.equal(ev.filter((e) => e.type === 'note').length, 0);
  const a = ev.filter((e) => e.type === 'audio');
  assert.equal(a.length, 1);
  assert.equal(a[0].clip.sampleId, 'smp_f');
  assert.equal(a[0].clip.gain, 1.2);
  assert.equal(a[0].dur, 12);
  assert.equal(collectEvents(p, 4, 8, { mode: 'song' }).length, 0);
  const mid = collectEvents(p, 5, 6, { mode: 'song', jump: true });
  assert.equal(mid.length, 1);
  assert.equal(mid[0].offset, 5);
  assert.equal(mid[0].dur, 7);
  // muted -> nothing; stale (tempo) -> live notes again
  assert.equal(collectEvents({ ...p, tracks: [{ ...t, mute: true }] }, 0, 4, { mode: 'song', jump: true }).length, 0);
  const live = collectEvents({ ...p, bpm: 100 }, 0, 4, { mode: 'song', jump: true });
  assert.equal(live.filter((e) => e.type === 'note').length, 3);
});

test('collectEvents: pattern-mode freeze loops its one-cycle render', () => {
  const { p, t } = songWithSynth();
  p.mode = 'pattern';
  t.frozen = { ...t.frozen, renderMode: 'pattern', loop: 4, length: 4 };
  const ev = collectEvents(p, 0, 10, { mode: 'pattern', jump: true });
  assert.deepEqual(ev.map((e) => [e.beat, e.offset, e.dur]), [[0, 0, 4], [4, 0, 4], [8, 0, 4]]);
  const j = collectEvents(p, 6, 9, { mode: 'pattern', jump: true });
  assert.deepEqual(j.map((e) => [e.beat, e.offset, e.dur]), [[6, 2, 2], [8, 0, 4]]);
});

test('freezeVariant: only the track (+ silent key sources), neutral master / fader per mode', () => {
  const { p, t } = songWithSynth();
  const other = createTrack({ name: 'Other' });
  p.tracks.push(other);
  t.sends = { [p.buses[0].id]: 0.4 };
  t.automation = [{ id: 'l1', target: 'volume', points: [{ beat: 0, value: 0.5 }] }, { id: 'l2', target: 'inst:cutoff', points: [{ beat: 0, value: 0.5 }] }];
  const v = freezeVariant(p, t.id, 'postFx');
  assert.deepEqual(v.tracks.map((x) => x.name), ['Lead']);
  const vt = v.tracks[0];
  assert.equal(vt.frozen, undefined);
  assert.equal(vt.volume, 1);
  assert.equal(vt.pan, 0);
  assert.deepEqual(vt.sends, {});
  assert.deepEqual(vt.automation.map((l) => l.target), ['inst:cutoff']);
  assert.equal(vt.fx.length, 2);
  assert.deepEqual(v.master.fx, []);
  assert.equal(v.master.volume, 1);
  assert.deepEqual(v.buses, []);
  const pre = freezeVariant(p, t.id, 'preFx').tracks[0];
  assert.equal(pre.fx.length, 0);
  const post = freezeVariant(p, t.id, 'postFader').tracks[0];
  assert.equal(post.volume, 0.7);
  assert.equal(post.pan, -0.3);
  assert.deepEqual(post.automation.map((l) => l.target), ['volume', 'inst:cutoff']);
});

function graphFor(p) {
  const ctx = new MockContext({ sampleRate: 48000 });
  const created = [];
  const graph = new MixGraph(ctx, {
    destination: ctx.destination, getBpm: () => p.bpm, getBeatAt: () => null,
    getSampleBuffer: () => null, getSampleByName: () => null, onError: (e) => created.push(e), meters: false,
    createEffect: (c, def, env) => { created.push(def.type); return latentEffectFactory(() => (def.type === 'compressor' ? 288 : 0))(c, def, env); },
  });
  graph.sync(p);
  return { graph, created };
}

test('MixGraph: a frozen track instantiates neither instrument nor (post-fx) inserts — the CPU win is real', () => {
  const { p, t } = songWithSynth();
  p.master.fx = [];
  p.buses = [];
  const { graph, created } = graphFor(p);
  const e = graph.tracks.get(t.id);
  assert.equal(e.instrument, null);
  assert.equal(e.code, null);
  assert.equal(e.strip.effects.length, 0);
  assert.ok(!created.includes('compressor'), 'the track inserts were never built'); // (master / bus fx are)
  assert.equal(graph.latency, 0); // the compressor's latency is baked into the (aligned) render
  assert.equal(graph.getInstrument(t.id), null);
  // fader stays live in postFx
  assert.equal(e.strip.vals.volume, 0.7);
  // preFx: inserts live, instrument still not built
  t.frozen.mode = 'preFx';
  graph.sync(p);
  assert.equal(e.strip.effects.length, 2);
  assert.equal(e.instrument, null);
  assert.ok(graph.latency > 0);
  // postFader: unity fader, centre pan
  t.frozen.mode = 'postFader';
  graph.sync(p);
  assert.equal(e.strip.effects.length, 0);
  assert.equal(e.strip.vals.volume, 1);
  assert.equal(e.strip.vals.pan, 0);
});

test('store guard: sound edits to a frozen track are rolled back with a hint; harmless edits pass', () => {
  const { p, t, pat } = songWithSynth();
  const store = new Store(p);
  store.addGuard(createFreezeGuard());
  const blocked = [];
  store.on('blocked', (b) => blocked.push(b));
  const tr = () => store.get().tracks.find((x) => x.id === t.id);
  // instrument edit -> blocked
  store.transact('Param', (pp) => { pp.tracks[0].instrument.params.cutoff = 300; });
  assert.equal(tr().instrument.params.cutoff, undefined);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].message, FROZEN_HINT);
  // note edit -> blocked
  store.transact('Notes', (pp) => { pp.patterns[pat.id].notes.push(createNote(72, 3, 1)); });
  assert.equal(store.get().patterns[pat.id].notes.length, 3);
  // clip move -> blocked
  store.transact('Move clip', (pp) => { pp.clips[0].start = 4; });
  assert.equal(store.get().clips[0].start, 0);
  // insert added -> blocked
  store.transact('Add fx', (pp) => { pp.tracks[0].fx.push(createEffect('eq3')); });
  assert.equal(tr().fx.length, 2);
  assert.equal(blocked.length, 4);
  // mixed edit: the rename survives, the param edit does not
  store.transact('Mixed', (pp) => { pp.tracks[0].name = 'Lead 2'; pp.tracks[0].instrument.params.cutoff = 900; pp.tracks[0].volume = 0.5; });
  assert.equal(tr().name, 'Lead 2');
  assert.equal(tr().volume, 0.5);
  assert.equal(tr().instrument.params.cutoff, undefined);
  // harmless: mute, solo, sends, colour, tempo
  const n = blocked.length;
  store.transact('Mute', (pp) => { pp.tracks[0].mute = true; pp.tracks[0].color = '#fff'; pp.bpm = 125; });
  assert.equal(blocked.length, n);
  assert.equal(tr().mute, true);
  // unfreeze -> editable again
  store.transact('Unfreeze', (pp) => { delete pp.tracks[0].frozen; });
  store.transact('Param', (pp) => { pp.tracks[0].instrument.params.cutoff = 300; });
  assert.equal(tr().instrument.params.cutoff, 300);
  assert.equal(blocked.length, n);
});

test('store guard: post-fader freeze also locks volume / pan; deleting a frozen track is allowed', () => {
  const { p, t } = songWithSynth();
  t.frozen.mode = 'postFader';
  const bus = createBus('B');
  p.buses.push(bus);
  const store = new Store(p);
  store.addGuard(createFreezeGuard());
  let blocked = 0;
  store.on('blocked', () => blocked++);
  store.transact('Vol', (pp) => { pp.tracks[0].volume = 0.2; });
  assert.equal(store.get().tracks[0].volume, 0.7);
  store.transact('Send', (pp) => { pp.tracks[0].sends[bus.id] = 0.5; });
  assert.equal(store.get().tracks[0].sends[bus.id], 0.5);
  assert.equal(blocked, 1);
  store.transact('Delete', (pp) => { pp.tracks = []; pp.clips = []; });
  assert.equal(store.get().tracks.length, 0);
  assert.equal(blocked, 1);
});
