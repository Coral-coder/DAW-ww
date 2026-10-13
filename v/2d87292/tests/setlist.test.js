import test from 'node:test';
import assert from 'node:assert/strict';
import {
  camelot, keyFromCamelot, keyMoveTarget, keyMoveOptions, keyName, mapToKey, inScaleRatio, pivotBar, dominantPcs,
  rhythmSimilarity, varyNotes, activeLayers, nextSection, phraseIndexAt, phraseProgress, prepareBeat,
  createSetlist, planPhrase, queueKeyMove, clipWindowNotes, isMinorScale,
} from '../src/live/setlist-engine.js';
import { SetlistRunner } from '../src/live/setlist-runner.js';
import { Store } from '../src/core/store.js';
import { createRng } from '../src/core/util.js';

const mod12 = (x) => ((x % 12) + 12) % 12;

test('camelot math', () => {
  assert.equal(camelot({ root: 9, scale: 'minor' }).code, '8A');
  assert.equal(camelot({ root: 0, scale: 'major' }).code, '8B');
  assert.equal(camelot({ root: 4, scale: 'minor' }).code, '9A');
  assert.equal(camelot({ root: 7, scale: 'major' }).code, '9B');
  assert.equal(camelot({ root: 0, scale: 'minor' }).code, '5A');
  assert.equal(camelot({ root: 2, scale: 'minor' }).code, '7A');
  for (let r = 0; r < 12; r++) for (const scale of ['minor', 'major']) {
    const c = camelot({ root: r, scale });
    assert.deepEqual(keyFromCamelot(c.code), { root: r, scale });
  }
  assert.deepEqual(keyFromCamelot('12A'), { root: 1, scale: 'minor' }); // C#m / Dbm
  assert.deepEqual(keyFromCamelot('1B'), { root: 11, scale: 'major' }); // B major
});

test('key moves produce the right target keys', () => {
  const am = { root: 9, scale: 'minor' };
  const t = (m) => keyMoveTarget(am, m);
  assert.deepEqual(t('relative'), { root: 0, scale: 'major' });
  assert.deepEqual(t('parallel'), { root: 9, scale: 'major' });
  assert.deepEqual(t('dominant'), { root: 4, scale: 'minor' });
  assert.deepEqual(t('subdominant'), { root: 2, scale: 'minor' });
  assert.deepEqual(t('diagonal'), { root: 7, scale: 'major' });
  assert.deepEqual(t('lift1'), { root: 10, scale: 'minor' });
  assert.deepEqual(t('lift2'), { root: 11, scale: 'minor' });
  assert.equal(camelot(t('camelot+1')).code, '9A');
  assert.equal(camelot(t('camelot-1')).code, '7A');
  assert.deepEqual(keyMoveTarget({ root: 0, scale: 'major' }, 'relative'), { root: 9, scale: 'minor' });
  // dominant / subdominant are Camelot ±1, relative is A<->B
  for (let r = 0; r < 12; r++) for (const scale of ['minor', 'major']) {
    const k = { root: r, scale };
    const c = camelot(k);
    assert.equal(camelot(keyMoveTarget(k, 'dominant')).num, (c.num % 12) + 1);
    assert.equal(camelot(keyMoveTarget(k, 'subdominant')).num, ((c.num + 10) % 12) + 1);
    assert.equal(camelot(keyMoveTarget(k, 'relative')).num, c.num);
    assert.notEqual(camelot(keyMoveTarget(k, 'relative')).letter, c.letter);
  }
  const opts = keyMoveOptions(am);
  assert.equal(opts.find((o) => o.id === 'relative').text, 'A minor → C major (relative)');
  assert.equal(keyName({ root: 0, scale: 'minor' }), 'C minor');
  assert.ok(isMinorScale('dorian') && !isMinorScale('mixolydian'));
});

test('mapToKey keeps rhythm and lands in the new scale', () => {
  const cm = { root: 0, scale: 'minor' };
  const notes = [60, 62, 63, 65, 67, 68, 70, 72].map((p, i) => ({ pitch: p, start: i * 0.5, dur: 0.5, vel: 0.8 }));
  for (const move of ['relative', 'parallel', 'dominant', 'subdominant', 'diagonal', 'lift1']) {
    const to = keyMoveTarget(cm, move);
    const out = mapToKey(notes, cm, to);
    assert.equal(inScaleRatio(out, to), 1, move);
    assert.deepEqual(out.map((n) => n.start), notes.map((n) => n.start));
    assert.ok(Math.abs(out[0].pitch - notes[0].pitch) <= 6, `${move}: small shift`);
    assert.equal(mod12(out[0].pitch), to.root, `${move}: tonic -> tonic`);
  }
});

test('pivot bar sits on the dominant of the new key', () => {
  const to = { root: 0, scale: 'major' };
  const pad = [{ pitch: 57, start: 0, dur: 32, vel: 0.6 }, { pitch: 60, start: 0, dur: 32, vel: 0.6 }, { pitch: 64, start: 0, dur: 32, vel: 0.6 }];
  const out = pivotBar(pad, { length: 32, barStart: 28, toKey: to });
  const last = out.filter((n) => n.start >= 28);
  assert.ok(last.length >= 2);
  const V7 = dominantPcs(to);
  assert.deepEqual(V7, [7, 11, 2, 5]);
  for (const n of last) assert.ok(V7.includes(mod12(n.pitch)), `pivot pitch ${n.pitch}`);
  assert.ok(out.filter((n) => n.start < 28).every((n) => n.start + n.dur <= 28 + 1e-6), 'held notes are split at the barline');
  const bass = pivotBar([{ pitch: 33, start: 28.5, dur: 0.5, vel: 0.8 }, { pitch: 33, start: 2, dur: 0.5, vel: 0.8 }], { length: 32, barStart: 28, toKey: to, bass: true });
  assert.ok([7, 2].includes(mod12(bass.find((n) => n.start >= 28).pitch)));
  assert.equal(bass.find((n) => n.start < 28).pitch, 33);
});

test('variation keeps the rhythm similar', () => {
  const { state } = createSetlist({ genre: 'tech-house', key: { root: 0, scale: 'minor' }, seed: 11, phraseBars: 8 });
  const P = 32;
  for (const l of state.layers) {
    const src = l.material.drop || l.material.groove;
    if (!src || src.length < 4 || l.category === 'impact' || l.category === 'fx') continue;
    for (let s = 1; s <= 4; s++) {
      const v = varyNotes(src, { drums: l.drums, category: l.category, mutate: 0.35, density: 1, rng: createRng(s), length: P, bpb: 4, key: state.key });
      const sim = rhythmSimilarity(src, v, { drums: l.drums });
      assert.ok(sim >= 0.7, `${l.name}: rhythm similarity ${sim.toFixed(2)}`);
    }
    const same = varyNotes(src, { drums: l.drums, category: l.category, mutate: 0, density: 1, rng: createRng(1), length: P, bpb: 4, key: state.key });
    assert.equal(rhythmSimilarity(src, same, { drums: l.drums }), 1, `${l.name}: mutate 0 keeps the rhythm`);
  }
});

test('energy arc: sections and active layers', () => {
  const layers = [
    { id: 'd', category: 'drums', mode: 'auto' }, { id: 'b', category: 'bass', mode: 'auto' }, { id: 'p', category: 'pad', mode: 'auto' },
    { id: 'l', category: 'lead', mode: 'auto' }, { id: 'x', category: 'lead', mode: 'off' }, { id: 'o', category: 'fx', mode: 'on' },
  ];
  const drop = activeLayers(layers, 'drop', 0.9);
  assert.ok(drop.has('d') && drop.has('b') && drop.has('l') && drop.has('o') && !drop.has('x'));
  const br = activeLayers(layers, 'breakdown', 0.7);
  assert.ok(!br.has('d') && !br.has('b') && br.has('p'));
  assert.ok(!activeLayers(layers, 'drop', 0.2).has('l'));
  assert.deepEqual(nextSection({ arcIndex: 3, current: 'build' }), { section: 'drop', arcIndex: 4 });
  assert.equal(nextSection({ arcIndex: 3, queued: 'breakdown' }).section, 'breakdown');
  assert.equal(nextSection({ arcIndex: 5, hold: true, current: 'drop' }).section, 'drop');
});

test('phrase scheduling math', () => {
  const P = 32;
  assert.equal(phraseIndexAt(0, P), 0);
  assert.equal(phraseIndexAt(31.99, P), 0);
  assert.equal(phraseIndexAt(32, P), 1);
  assert.equal(phraseProgress(48, P), 0.5);
  // prepare at least one bar + ~2 s before the last bar of the phrase, never before the phrase starts
  const b = prepareBeat(0, P, { bpb: 4, bpm: 125 });
  assert.ok(b <= 32 - 4 - (2 * 125) / 60 && b >= 16, String(b));
  assert.equal(prepareBeat(2, 16, { bpb: 4, bpm: 174 }), 38); // 48 - (1 bar + 6 beats ≈ 2 s)
  assert.equal(prepareBeat(2, 8, { bpb: 4, bpm: 174 }), 16); // short phrase: right at its start
  const win = clipWindowNotes({ length: 4, notes: [{ pitch: 36, start: 0, dur: 0.25 }, { pitch: 36, start: 2, dur: 0.25 }] }, { start: 8, length: 16, offset: 0 }, 12, 20);
  assert.deepEqual(win.map((n) => n.start), [0, 2, 4, 6]);
});

test('continuous phrases: variation of what plays, key move with pivot, harmonic layers in the new key', () => {
  const { state } = createSetlist({ genre: 'tech-house', key: { root: 0, scale: 'minor' }, seed: 3, phraseBars: 4 });
  state.energy = 0.9;
  let cur = {};
  const plans = [];
  for (let i = 0; i < 6; i++) {
    if (i === 4) queueKeyMove(state, 'relative');
    const plan = planPhrase(state, { current: cur });
    plans.push(plan);
    assert.equal(plan.length, 16);
    for (const r of Object.values(plan.layers)) for (const n of r.notes) assert.ok(n.start >= 0 && n.start < 16, 'notes inside the phrase');
    cur = {};
    for (const [id, r] of Object.entries(plan.layers)) cur[id] = r.active ? r.notes : null;
  }
  assert.deepEqual(plans.slice(0, 5).map((p) => p.section), ['intro', 'groove', 'groove', 'build', 'drop']);
  // groove -> groove: drums are a variation of the previous phrase
  const drums = state.layers.find((l) => l.category === 'drums');
  assert.ok(rhythmSimilarity(plans[1].layers[drums.id].notes, plans[2].layers[drums.id].notes, { drums: true }) >= 0.6);
  // key move at phrase 4: Eb major, pivot bar written into phrase 3, harmonic layers in the new scale
  const km = plans[4];
  assert.ok(km.keyChanged);
  assert.deepEqual(km.key, { root: 3, scale: 'major' });
  assert.ok(km.pivot && Object.keys(km.pivot).length > 0, 'pivot present');
  for (const [id, notes] of Object.entries(km.pivot)) {
    const last = notes.filter((n) => n.start >= 12);
    assert.ok(last.length > 0);
    for (const n of last) assert.ok(dominantPcs(km.key).includes(mod12(n.pitch)), `${id} pivot`);
  }
  for (const l of state.layers) {
    if (l.drums || !km.layers[l.id].active || km.layers[l.id].notes.length < 3) continue;
    assert.ok(inScaleRatio(km.layers[l.id].notes, km.key) >= 0.85, `${l.name} in Eb major: ${inScaleRatio(km.layers[l.id].notes, km.key)}`);
  }
  // drums keep going through the key change
  assert.ok(km.layers[drums.id].active);
});

test('lock repeats the phrase exactly; user edits are followed', () => {
  const { state } = createSetlist({ genre: 'house', key: { root: 9, scale: 'minor' }, seed: 5, phraseBars: 4 });
  state.hold = true;
  let plan = planPhrase(state, {});
  const bass = state.layers.find((l) => l.category === 'drums');
  bass.lock = true;
  const cur = Object.fromEntries(Object.entries(plan.layers).map(([id, r]) => [id, r.notes]));
  const p2 = planPhrase(state, { current: cur });
  assert.deepEqual(p2.layers[bass.id].notes.map((n) => [n.pitch, n.start]), cur[bass.id].map((n) => [n.pitch, n.start]));
  // edit: a lead-ish layer's notes replaced by the user -> next phrase derives from the edit
  const other = state.layers.find((l) => !l.drums && l.category !== 'impact');
  other.mutate = 0;
  const edit = [{ pitch: 69, start: 0, dur: 1, vel: 0.8 }, { pitch: 72, start: 2, dur: 1, vel: 0.8 }];
  const p3 = planPhrase(state, { current: { ...cur, [other.id]: edit }, edited: { [other.id]: true } });
  assert.deepEqual(p3.layers[other.id].notes.map((n) => [n.pitch, n.start]), [[69, 0], [72, 2]]);
});

test('runner places phrases at boundaries on the timeline and captures the set', async () => {
  const store = new Store();
  let pos = 0, playing = false;
  const engine = { get isPlaying() { return playing; }, getPosition: () => pos, setPosition: (b) => { pos = b; }, play: async () => { playing = true; }, pause: () => { playing = false; }, stop: () => { playing = false; } };
  const app = { store, engine, actions: { ensureAudio: async () => {} }, toast: () => {} };
  const r = new SetlistRunner(app);
  await r.start({ genre: 'tech-house', key: { root: 0, scale: 'minor' }, bpm: 125, phraseBars: 4, energy: 0.8 });
  r._stopTimer();
  assert.equal(store.get().mode, 'song');
  assert.equal(r.phrases.length, 1);
  assert.ok(store.get().clips.length > 0 && store.get().clips.every((c) => c.start === 0 && c.length === 16));
  assert.ok(store.get().tracks.every((t) => !t.automation.length));
  // walk the playhead through 5 phrases
  const placedAt = [];
  for (pos = 0; pos < 16 * 5; pos += 0.25) {
    const n = r.phrases.length;
    r.tick();
    if (r.phrases.length > n) placedAt.push(pos);
    if (pos === 40) r.keyMove('relative');
  }
  assert.ok(r.phrases.length >= 6);
  r.phrases.forEach((ph, i) => assert.equal(ph.start, i * 16));
  // each phrase is placed before the lookahead reaches its boundary, but not earlier than its predecessor started
  placedAt.forEach((b, i) => { assert.ok(b < (i + 1) * 16 - 4, `placed at ${b}`); assert.ok(b >= i * 16); });
  const p = store.get();
  for (const ph of r.phrases) for (const cid of Object.values(ph.clips)) {
    const c = p.clips.find((x) => x.id === cid);
    assert.ok(c, 'clip exists');
    assert.ok(Math.abs((c.start - ph.start) % 16) < 1e-6 || c.start <= ph.start);
  }
  // key move landed on a phrase boundary with a pivot clip in the bar before it
  const kc = r.phrases.find((ph) => ph.keyChanged);
  assert.ok(kc, 'key change phrase');
  assert.deepEqual(kc.key, { root: 3, scale: 'major' });
  assert.ok(p.clips.some((c) => c.name === 'pivot' && c.start === kc.start - 4 && c.length === 4));
  // build phrase got a filter sweep
  assert.ok(p.tracks.some((t) => t.automation.some((a) => a.target.endsWith(':cutoff') && a.points.length > 2)));
  // no undo steps from automatic placement
  assert.equal(store.canUndo(), false);
  pos = 50;
  const res = r.capture();
  assert.ok(res.sections >= 2);
  const q = store.get();
  assert.ok(q.markers.length >= 2 && q.markers[0].beat === 0);
  assert.ok(q.clips.every((c) => c.start + c.length <= 64 + 1e-6));
  assert.ok(q.clips.every((c) => q.patterns[c.patternId]));
  assert.equal(store.canUndo(), true);
});

// ------------------------------------------------------------------ sound rotation + settings drift
import { soundKey, mixLevel, driftTargets, DRIFT_SPECS, queueNextSound } from '../src/live/setlist-engine.js';
import { INSTRUMENT_DEFS } from '../src/audio/defs.js';

const MAIN_ROLES = new Set(['drums', 'bass', 'chords', 'pad', 'lead', 'arp', 'fx']);
const dB = (r) => 20 * Math.log10(r);
function runSet(genre, n, { seed = 7, phraseBars = 8, before } = {}) {
  const { song, state } = createSetlist({ genre, key: { root: 0, scale: 'minor' }, seed, phraseBars });
  const vol = Object.fromEntries(song.tracks.map((t) => [t.id, t.volume]));
  const used = Object.fromEntries(state.layers.map((l) => [l.id, new Set([soundKey(l.sound.cur)])]));
  const plans = [];
  let cur = {};
  for (let i = 0; i < n; i++) {
    const ctx = { current: cur };
    before?.(i, state, ctx);
    const plan = planPhrase(state, ctx);
    plans.push(plan);
    cur = {};
    for (const [id, r] of Object.entries(plan.layers)) cur[id] = r.active ? r.notes : null;
    for (const [id, s] of Object.entries(plan.sounds)) if (s.swap) { used[id].add(soundKey(s.swap.def)); vol[id] *= 10 ** (s.swap.levelDb / 20); }
  }
  return { song, state, plans, used, vol };
}

test('sound rotation: every rotating melodic layer plays ≥3 sounds over 40 phrases, ≤2 swaps per boundary, levels on target', () => {
  for (const genre of ['tech-house', 'trance', 'lofi-hip-hop']) {
    const { song, state, plans, used, vol } = runSet(genre, 40);
    let rotating = 0;
    for (const l of state.layers) {
      if (l.drums || !l.sound.rotate || l.lock) continue;
      rotating++;
      assert.ok(used[l.id].size >= 3, `${genre} ${l.name}: ${used[l.id].size} sounds`);
    }
    assert.ok(rotating >= 5, `${genre}: ${rotating} rotating layers`);
    for (const p of plans) assert.ok(p.swaps.length <= 2, `${genre} phrase ${p.index}: ${p.swaps.length} swaps`);
    // a new sound carries its fallback preset (like generated songs) and lands at the mix.js level of its role
    for (const p of plans) for (const id of p.swaps) { const d = p.sounds[id].swap.def; if (d.type === 'strudel') assert.ok(d.fallbackPreset, d.preset); }
    let checked = 0;
    for (const l of state.layers) {
      if (!l.sound.swaps) continue;
      const t0 = song.tracks.find((t) => t.id === l.id);
      const start = dB(t0.volume / mixLevel(genre, l.role, t0.instrument));
      const end = dB(vol[l.id] / mixLevel(genre, l.role, l.sound.cur));
      // every swap keeps the track's offset from its mix.js role target (doublings sit a fixed amount under it)…
      assert.ok(Math.abs(end - start) < 0.1, `${genre} ${l.name}: ${start.toFixed(2)} -> ${end.toFixed(2)} dB`);
      // …so the main role tracks stay within ±2 dB of the role target
      if (MAIN_ROLES.has(l.role) && !l.layerOf) { checked++; assert.ok(Math.abs(end) <= 2, `${genre} ${l.name}: ${end.toFixed(2)} dB off`); }
    }
    assert.ok(checked >= 4);
    // doublings follow their source layer's sound
    for (const l of state.layers) if (l.layerOf) assert.equal(soundKey(l.sound.cur), soundKey(state.layers.find((x) => x.id === l.layerOf).sound.cur), l.name);
  }
});

test('Keep / lock prevent swaps; "next sound now" swaps at the next boundary', () => {
  let keep, locked;
  const { plans, state } = runSet('tech-house', 30, {
    before: (i, st) => {
      if (i === 0) {
        keep = st.layers.find((l) => l.role === 'lead'); keep.sound.rotate = false;
        locked = st.layers.find((l) => l.role === 'chords'); locked.lock = true;
      }
    },
  });
  for (const p of plans) { assert.ok(!p.sounds[keep.id].swap, 'keep'); assert.ok(!p.sounds[locked.id].swap, 'lock'); }
  queueNextSound(state, keep.id);
  const p = planPhrase(state, {});
  assert.ok(p.sounds[keep.id].swap, 'next sound now');
  assert.equal(state.layers.find((l) => l.id === keep.id).sound.now, false);
});

test('settings drift: params move within safe ranges, differ across phrases, bigger at section changes; hand-moved params stay put', () => {
  let lead;
  const { plans, state } = runSet('tech-house', 24, {
    before: (i, st, ctx) => {
      lead = st.layers.find((l) => l.role === 'lead');
      if (i >= 6) ctx.overridden = { [lead.id]: ['lpf', 'room'] };
    },
  });
  const seen = {};
  for (const p of plans) for (const [id, s] of Object.entries(p.sounds)) for (const [k, d] of Object.entries(s.drift)) {
    const l = state.layers.find((x) => x.id === id);
    if (d.reset) continue;
    const spec = DRIFT_SPECS.strudel[k] || DRIFT_SPECS.synth[k];
    assert.ok(spec, k);
    for (const v of [d.from, d.to]) {
      assert.ok(Number.isFinite(v), `${l.name} ${k}`);
      assert.ok(v >= spec.lo - 1e-9 && v <= spec.hi + 1e-9, `${l.name} ${k}=${v} outside [${spec.lo}, ${spec.hi}]`);
    }
    ((seen[id] ||= {})[k] ||= new Set()).add(d.to);
    if (id === lead.id && p.index >= 6) assert.ok(k !== 'lpf' && k !== 'room', `${k} drifted after the user moved it`);
  }
  // held sounds evolve: several distinct cutoff values on the pad over the set
  const pad = state.layers.find((l) => l.role === 'pad');
  assert.ok(Object.keys(driftTargets(pad.sound.cur)).length > 0);
  const padVals = Object.values(seen[pad.id] || {});
  assert.ok(padVals.some((s) => s.size >= 4), 'pad params drift across phrases');
  assert.ok(state.layers.find((l) => l.id === lead.id).sound.touched.includes('lpf'));
  // def bounds are respected too
  const defs = Object.fromEntries(INSTRUMENT_DEFS.strudel.params.map((p) => [p.key, p]));
  for (const [, ks] of Object.entries(seen)) for (const [k, vals] of Object.entries(ks)) if (defs[k]) for (const v of vals) assert.ok(v >= defs[k].min && v <= defs[k].max);
  // breakdown starts darker than the drop before it (section bias on the walk)
  const brk = plans.find((p) => p.section === 'breakdown' && p.firstOfSection && p.sounds[pad.id].drift.lpf && !p.sounds[pad.id].swap);
  if (brk) assert.ok(brk.sounds[pad.id].drift.lpf.to <= brk.sounds[pad.id].drift.lpf.from * 1.15, 'breakdown darker');
  // freshness 0: static
  const st2 = createSetlist({ genre: 'tech-house', key: { root: 0, scale: 'minor' }, seed: 7, phraseBars: 8 }).state;
  st2.freshness = 0;
  for (let i = 0; i < 20; i++) { const p = planPhrase(st2, {}); assert.equal(p.swaps.length, 0); for (const s of Object.values(p.sounds)) for (const d of Object.values(s.drift)) assert.equal(d.from, d.to); }
});

test('runner: swaps land at the phrase boundary with the level change, drift lanes on inst params, hand edits win', async () => {
  const store = new Store();
  let pos = 0, playing = false;
  const engine = { get isPlaying() { return playing; }, getPosition: () => pos, setPosition: (b) => { pos = b; }, play: async () => { playing = true; }, pause: () => { playing = false; }, stop: () => { playing = false; } };
  const r = new SetlistRunner({ store, engine, actions: { ensureAudio: async () => {} }, toast: () => {} });
  await r.start({ genre: 'tech-house', key: { root: 0, scale: 'minor' }, bpm: 125, phraseBars: 4, energy: 0.8, seed: 7 });
  r._stopTimer();
  r.setFreshness(1);
  const lead = r.state.layers.find((l) => l.role === 'lead');
  let swapSeen = null;
  for (pos = 0; pos < 16 * 14; pos += 0.25) {
    const before = store.get().tracks.find((t) => t.id === lead.id).instrument.preset;
    const pend = r.pendingSwaps.find((s) => s.id === lead.id);
    r.tick();
    const after = store.get().tracks.find((t) => t.id === lead.id).instrument.preset;
    if (after !== before && !swapSeen) { swapSeen = { pos, pend }; }
    if (pos === 16 * 6) {
      // the user grabs the lead's cutoff knob (automation-recorder marks the lane overridden) and picks a preset for the arp
      store.transact('x', (p) => { const t = p.tracks.find((x) => x.id === lead.id); const lane = t.automation.find((a) => a.target === 'inst:lpf'); if (lane) lane.overridden = true; });
    }
  }
  assert.ok(swapSeen, 'lead swapped');
  assert.ok(Math.abs(swapSeen.pos - (swapSeen.pend.beat - 0.25)) < 1e-9 && swapSeen.pend.beat % 16 === 0, `swap at ${swapSeen.pos}`);
  const t = store.get().tracks.find((x) => x.id === lead.id);
  const lpf = t.automation.find((a) => a.target === 'inst:lpf');
  assert.ok(lpf && lpf.points.length > 4, 'lpf drift lane');
  assert.ok(lpf.overridden && lpf.points.every((q) => q.beat <= 16 * 8 + 1e-6), 'no drift written after the user took the knob');
  assert.ok(r.state.layers.find((l) => l.id === lead.id).sound.touched.includes('lpf'));
  // a preset picked by hand is adopted: rotation stops for that layer
  const arp = r.state.layers.find((l) => l.role === 'arp');
  r._applySwaps(0, true);
  store.transact('Preset', (p) => { p.tracks.find((x) => x.id === arp.id).instrument = { type: 'synth', preset: 'arp-saw', params: {} }; });
  r._placeNext();
  assert.equal(arp.sound.rotate, false);
  assert.equal(arp.sound.cur.preset, 'arp-saw');
  assert.equal(store.canUndo(), true); // only the user's own edits are undo steps
});
