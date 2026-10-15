// Presets: factory effect presets, the user preset store and bank files, snapshot morphing, randomize with locks,
// the extra instrument presets and applying chains / templates to a project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_DEFS, resolveEffectParams } from '../src/audio/effect-defs.js';
import { FACTORY_EFFECT_PRESETS, effectPresetEntries, effectPresetMap, normalizePresetEntry } from '../src/audio/effect-presets.js';
import { morphParams, randomizeParams, randomizeWithinPresets, seededRng, toUnit } from '../src/audio/preset-tools.js';
import { createPresetStore, memoryStorage, parseBank, serializeBank, makeBank, sanitizeEntry, BANK_FORMAT, STORE_KEYS, keyOf, bankFileName } from '../src/core/preset-store.js';
import { PRESETS, PRESET_CATEGORIES } from '../src/audio/presets.js';
import { EXTRA_PRESETS } from '../src/audio/presets-extra.js';
import { EXTRA_STRUDEL_PATCHES } from '../src/audio/strudel-patches-extra.js';
import { STRUDEL_PATCHES } from '../src/audio/strudel-patches.js';
import { INSTRUMENT_DEFS } from '../src/audio/defs.js';
import { PRESET_IDS, ALL_PRESET_IDS } from '../src/gen/genres.js';
import { PRESET_STRUDEL } from '../src/gen/strudel-sounds.js';
import { Store } from '../src/core/store.js';
import { createProject, createTrack, createEffect } from '../src/core/model.js';
import { chainFromFx, insertChain, templateFromTrack, createTrackFromTemplate, applyTemplateToTrack, applyFxPreset, addFxToOwner, dropRef, describeKey } from '../src/ui/preset-apply.js';
import { presetStore } from '../src/core/preset-store.js';

const CORE_TYPES = ['eq3', 'eq8', 'filter', 'compressor', 'limiter', 'mastering', 'gate', 'ducker', 'pump', 'distortion', 'saturator', 'tape',
  'bitcrusher', 'delay', 'reverb', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'widener', 'utility'];

// ------------------------------------------------------------------ factory effect presets
test('every effect type has 10+ factory presets whose keys exist in its param defs and whose values are in range', () => {
  for (const type of CORE_TYPES) {
    assert.ok(EFFECT_DEFS[type], `effect ${type} exists`);
    const list = effectPresetEntries(type);
    assert.ok(list.length >= 10, `${type}: ${list.length} presets`);
    const defs = new Map(EFFECT_DEFS[type].params.map((d) => [d.key, d]));
    for (const p of list) {
      assert.ok(p.tags.length, `${type}/${p.name} has tags`);
      assert.ok(Object.keys(p.params).length, `${type}/${p.name} sets something`);
      for (const [k, v] of Object.entries(p.params)) {
        const d = defs.get(k);
        assert.ok(d, `${type}/${p.name}: unknown param ${k}`);
        if (d.type === 'number') assert.ok(typeof v === 'number' && v >= d.min && v <= d.max, `${type}/${p.name}.${k}=${v} outside ${d.min}..${d.max}`);
        if (d.type === 'enum') assert.ok(d.options.some((o) => o.value === v), `${type}/${p.name}.${k}=${v} not an option`);
        if (d.type === 'bool') assert.equal(typeof v, 'boolean', `${type}/${p.name}.${k}`);
      }
      // a preset resolves to exactly its own values (nothing gets clamped away)
      const r = resolveEffectParams({ type, params: p.params });
      for (const [k, v] of Object.entries(p.params)) assert.equal(r[k], v, `${type}/${p.name}.${k} resolves unchanged`);
    }
  }
  // the table covers no unknown effect types
  for (const t of Object.keys(FACTORY_EFFECT_PRESETS)) assert.ok(EFFECT_DEFS[t], `table type ${t}`);
});

test('effect presets: legacy { name: params } and rich { name: { params, tags, description } } entries both work; def presets are merged', () => {
  assert.deepEqual(normalizePresetEntry({ mix: 0.5 }), { params: { mix: 0.5 }, tags: [], description: '' });
  assert.deepEqual(normalizePresetEntry({ params: { mix: 0.5 }, tags: ['subtle'], description: 'x' }), { params: { mix: 0.5 }, tags: ['subtle'], description: 'x' });
  const defs = {
    reverb: { ...EFFECT_DEFS.reverb, presets: { 'Hall': { mix: 0.9 }, 'Def only': { decay: 1 } } }, // 'Hall' is shadowed by the table
    newfx: { name: 'New', params: [], presets: { 'Old shape': { a: 1 }, 'Rich': { params: { a: 2 }, tags: ['creative'] } } },
  };
  const rev = effectPresetEntries('reverb', defs);
  assert.equal(rev.find((x) => x.name === 'Hall').params.mix, 0.3);
  assert.ok(rev.some((x) => x.name === 'Def only'));
  const nf = effectPresetEntries('newfx', defs);
  assert.deepEqual(nf.map((x) => [x.name, x.params.a, x.tags]), [['Old shape', 1, []], ['Rich', 2, ['creative']]]);
  assert.deepEqual(effectPresetMap('newfx', defs), { 'Old shape': { a: 1 }, 'Rich': { a: 2 } });
  assert.equal(effectPresetMap('nothing', defs), null);
  // families registered through src/audio/fx/defs are picked up from EFFECT_DEFS automatically
  for (const [type, def] of Object.entries(EFFECT_DEFS)) if (def.presets) assert.ok(effectPresetEntries(type).length >= Object.keys(def.presets).length, type);
});

// ------------------------------------------------------------------ store
test('preset store: save / list / rename / remove, favorites, recently used (most recent first, capped)', () => {
  const st = createPresetStore(memoryStorage());
  assert.equal(st.save('effect', { name: 'x', type: 'nope', params: {} }), null, 'unknown effect type rejected');
  const id = st.save('effect', { name: ' Vocal verb ', type: 'reverb', params: { mix: 0.2 }, tags: ['Vocal', 'vocal', ''] });
  assert.ok(id);
  assert.deepEqual(st.get('effect', id).tags, ['vocal']);
  assert.equal(st.get('effect', id).name, 'Vocal verb');
  const iid = st.save('instrument', { name: 'My bass', type: 'synth', preset: 'sub-bass', params: { cutoff: 300 } });
  assert.equal(st.list('instrument')[0].preset, 'sub-bass');
  assert.ok(st.rename('effect', id, 'Plate verb'));
  assert.equal(st.get('effect', id).name, 'Plate verb');
  // favorites
  const k = keyOf('effect', id);
  assert.equal(st.toggleFavorite(k), true);
  assert.equal(st.toggleFavorite('fx:reverb:Hall'), true);
  assert.deepEqual(st.favorites(), [k, 'fx:reverb:Hall']);
  assert.equal(st.toggleFavorite('fx:reverb:Hall'), false);
  // recents
  for (let i = 0; i < 40; i++) st.touch(`inst:p${i}`);
  st.touch('inst:p5');
  const r = st.recent();
  assert.equal(r[0], 'inst:p5');
  assert.equal(r.length, 30);
  assert.equal(new Set(r).size, r.length);
  // removing an entry drops it from favorites / recents
  st.touch(k);
  assert.ok(st.remove('effect', id));
  assert.ok(!st.favorites().includes(k) && !st.recent().includes(k));
  assert.equal(st.get('effect', id), null);
  assert.ok(st.remove('instrument', iid));
});

test('preset store reads the original instrument user presets (localStorage key daw3-user-presets) and survives junk', () => {
  const storage = memoryStorage({ [STORE_KEYS.instrument]: JSON.stringify({ u1: { name: 'Old', type: 'fm', preset: null, params: { feedback: 0.3 }, created: '2025-01-01T00:00:00.000Z' } }), [STORE_KEYS.favorites]: '{not json' });
  const st = createPresetStore(storage);
  assert.equal(st.list('instrument')[0].name, 'Old');
  assert.deepEqual(st.favorites(), []);
  // writes stay in the original shape (id -> entry)
  st.save('instrument', { name: 'New', type: 'organ', params: {} });
  const raw = JSON.parse(storage.get(STORE_KEYS.instrument));
  assert.equal(raw.u1.name, 'Old');
  assert.equal(Object.keys(raw).length, 2);
});

test('bank export / import round trip (instrument + effect presets, FX chains, templates), duplicates skipped, names de-duplicated', () => {
  const a = createPresetStore(memoryStorage());
  a.save('instrument', { name: 'Lead 1', type: 'synth', preset: 'saw-lead', params: { cutoff: 2000 } });
  a.save('effect', { name: 'Big room', type: 'reverb', params: { decay: 4, mix: 0.4 }, tags: ['space'] });
  a.save('chain', { name: 'Vocal chain', fx: [{ type: 'eq8', params: { b1On: true } }, { type: 'compressor', enabled: false, params: { ratio: 3 } }, { type: 'bogus', params: {} }] });
  const track = templateFromTrack(createTrack({ name: 'Keys', volume: 0.6, pan: -0.2, fx: [createEffect('chorus', { depth: 0.4 })], instrument: { type: 'fm', preset: 'electric-piano', params: {} } }));
  track.macros = [{ name: 'Tone', targets: [] }];
  a.save('template', { name: 'Keys tpl', track });
  const bank = a.exportBank(null, { name: 'My bank' });
  assert.equal(bank.format, BANK_FORMAT);
  assert.equal(bank.chains[0].fx.length, 2, 'unknown effect types are dropped from chains');
  assert.equal(bank.chains[0].fx[1].enabled, false);
  const text = serializeBank(bank);

  const b = createPresetStore(memoryStorage());
  const r = b.importBank(text);
  assert.deepEqual(r.added, { instrument: 1, effect: 1, chain: 1, template: 1 });
  const strip = (e) => { const { id, created, ...rest } = e; return rest; };
  for (const kind of ['instrument', 'effect', 'chain', 'template']) assert.deepEqual(b.list(kind).map(strip), a.list(kind).map(strip), kind);
  assert.deepEqual(b.list('template')[0].track.macros, [{ name: 'Tone', targets: [] }]);
  assert.equal(b.list('template')[0].track.volume, 0.6);
  // importing the same bank again adds nothing
  const r2 = b.importBank(text);
  assert.equal(r2.skipped, 4);
  assert.deepEqual(r2.added, { instrument: 0, effect: 0, chain: 0, template: 0 });
  // same name, different content -> renamed
  const other = makeBank({ effects: [{ name: 'Big room', type: 'reverb', params: { decay: 9 } }] });
  b.importBank(other);
  assert.deepEqual(b.list('effect').map((e) => e.name).sort(), ['Big room', 'Big room (2)']);
  // single preset (.daw3preset) and file names
  const single = parseBank(JSON.stringify({ kind: 'effect', name: 'Solo', type: 'delay', params: { feedback: 0.5 } }));
  assert.equal(single.effects[0].name, 'Solo');
  assert.equal(bankFileName('My bank!'), 'My-bank.daw3bank');
  assert.equal(bankFileName('Solo', true), 'Solo.daw3preset');
});

test('bank parsing rejects junk with readable errors', () => {
  assert.throws(() => parseBank('nope'), /invalid JSON/);
  assert.throws(() => parseBank('{"a":1}'), /Not a daW³ preset bank/);
  assert.throws(() => parseBank(JSON.stringify({ format: BANK_FORMAT, version: 99 })), /newer/);
  const b = parseBank(JSON.stringify({ format: BANK_FORMAT, version: 1, effects: [{ name: 'x', type: 'not-an-effect' }, { type: 'reverb', params: [] }], instruments: [{ name: 'y', type: 'nope' }] }));
  assert.equal(b.effects.length, 1);
  assert.equal(b.effects[0].name, 'Untitled');
  assert.deepEqual(b.effects[0].params, {});
  assert.equal(b.instruments.length, 0);
  assert.equal(sanitizeEntry('template', { name: 't', track: { type: 'instrument' } }), null, 'instrument template needs an instrument');
});

// ------------------------------------------------------------------ morph
test('morph: numbers interpolate in the control scale, enums / bools switch at 50%, integers stay integers', () => {
  const defs = EFFECT_DEFS.delay.params;
  const a = resolveEffectParams({ type: 'delay', params: { time: 0.1, feedback: 0.2, pingpong: false, division: '1/4', highcut: 1000 } });
  const b = resolveEffectParams({ type: 'delay', params: { time: 1, feedback: 0.8, pingpong: true, division: '1/8', highcut: 10000 } });
  assert.deepEqual(morphParams(a, b, 0, defs), a);
  assert.deepEqual(morphParams(a, b, 1, defs), b);
  const m = morphParams(a, b, 0.5, defs);
  assert.ok(Math.abs(m.feedback - 0.5) < 1e-9, 'linear param midpoint');
  // log-curve params meet at the geometric mean (the knob's own midpoint)
  assert.ok(Math.abs(m.time - Math.sqrt(0.1 * 1)) < 0.002, `log midpoint ${m.time}`);
  assert.ok(Math.abs(m.highcut - Math.sqrt(1000 * 10000)) < 2, `log midpoint ${m.highcut}`);
  assert.equal(morphParams(a, b, 0.49, defs).pingpong, false);
  assert.equal(morphParams(a, b, 0.5, defs).pingpong, true);
  assert.equal(morphParams(a, b, 0.49, defs).division, '1/4');
  assert.equal(morphParams(a, b, 0.51, defs).division, '1/8');
  // monotonic along t
  let last = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) { const v = morphParams(a, b, t, defs).feedback; assert.ok(v >= last); last = v; }
  const bits = EFFECT_DEFS.bitcrusher.params;
  const mb = morphParams({ bits: 4 }, { bits: 15 }, 0.37, bits);
  assert.equal(mb.bits, Math.round(mb.bits));
  // missing keys fall back to defaults; out-of-range t is clamped
  assert.equal(morphParams({}, {}, 2, defs).feedback, 0.4);
});

// ------------------------------------------------------------------ randomize
test('randomize: locked params never change, results stay in range, seeded runs are reproducible', () => {
  for (const type of CORE_TYPES) {
    const defs = EFFECT_DEFS[type].params;
    const cur = resolveEffectParams({ type, params: {} });
    const locks = new Set(defs.filter((_, i) => i % 2 === 0).map((d) => d.key));
    for (const amount of [0.25, 0.9]) {
      const out = randomizeParams(defs, cur, { amount, locks, rng: seededRng(7) });
      for (const k of Object.keys(out)) assert.ok(!locks.has(k), `${type}: locked ${k} changed`);
      for (const d of defs) {
        if (!(d.key in out)) continue;
        const v = out[d.key];
        if (d.type === 'number') assert.ok(v >= d.min && v <= d.max, `${type}.${d.key}=${v}`);
        if (d.type === 'enum') assert.ok(d.options.some((o) => o.value === v), `${type}.${d.key}=${v}`);
        assert.ok(!['output', 'makeup', 'ceiling', 'sourceTrackId'].includes(d.key), `${type}: ${d.key} is never randomized`);
      }
      assert.deepEqual(randomizeParams(defs, cur, { amount, locks, rng: seededRng(7) }), out);
    }
  }
  // subtle moves less than wild (in control space, summed over many runs)
  const defs = EFFECT_DEFS.reverb.params;
  const cur = resolveEffectParams({ type: 'reverb', params: {} });
  const dist = (amount) => { let s = 0; const rng = seededRng(3); for (let i = 0; i < 50; i++) { const o = randomizeParams(defs, cur, { amount, rng }); for (const d of defs) if (d.type === 'number' && d.key in o) s += Math.abs(toUnit(d, o[d.key]) - toUnit(d, cur[d.key])); } return s; };
  assert.ok(dist(0.25) < dist(0.85) * 0.6);
});

test('randomize within preset tags: lands between presets of the tag, honours locks', () => {
  const type = 'reverb';
  const defs = EFFECT_DEFS[type].params;
  const pool = effectPresetEntries(type).filter((e) => e.tags.includes('drums'));
  assert.ok(pool.length >= 2);
  const cur = resolveEffectParams({ type, params: { decay: 7 } });
  const rng = seededRng(11);
  const full = pool.map((p) => resolveEffectParams({ type, params: p.params }));
  const lo = Math.min(...full.map((p) => p.decay)), hi = Math.max(...full.map((p) => p.decay));
  for (let i = 0; i < 20; i++) {
    const out = randomizeWithinPresets(defs, cur, pool, { rng, locks: ['mix'] });
    assert.ok(!('mix' in out));
    const decay = out.decay ?? cur.decay;
    assert.ok(decay >= lo * 0.75 && decay <= hi * 1.35, `decay ${decay} near the drum presets (${lo}..${hi})`);
  }
});

// ------------------------------------------------------------------ instrument presets / generator palette
test('extra instrument presets: ~100 new sounds with metadata; the generator palette grows without changing genre picks', () => {
  const extra = Object.keys(EXTRA_PRESETS).length + EXTRA_STRUDEL_PATCHES.length;
  assert.ok(extra >= 100, `${extra} new presets`);
  assert.ok(Object.keys(PRESETS).length >= 233);
  for (const [id, p] of Object.entries(EXTRA_PRESETS)) {
    assert.equal(PRESETS[id], p, id);
    assert.ok(p.description && PRESET_CATEGORIES.includes(p.category) && p.roles.length && p.genres.length, id);
    assert.ok(['synth', 'fm', 'organ'].includes(p.instrument.type), id);
    assert.ok(p.instrument.params.gain > 0.02 && p.instrument.params.gain <= 2, `${id} gain ${p.instrument.params.gain}`);
    assert.ok(ALL_PRESET_IDS.includes(id), `${id} in the generator palette`);
  }
  for (const sp of EXTRA_STRUDEL_PATCHES) {
    assert.ok(STRUDEL_PATCHES.includes(sp) && PRESETS[sp.id]?.category === 'Strudel', sp.id);
    assert.ok(PRESETS[sp.fallbackPreset] && PRESETS[sp.fallbackPreset].instrument.type !== 'strudel', `${sp.id} fallback`);
  }
  // original role lists keep their order (genre tables pick by id; tests and saved songs rely on it)
  assert.deepEqual(PRESET_IDS.bass.slice(0, 3), ['sub-bass', '808-bass', 'reese-bass']);
  for (const [preset, patch] of Object.entries(PRESET_STRUDEL)) assert.ok(PRESETS[preset] && PRESETS[patch]?.instrument.type === 'strudel', `${preset} -> ${patch}`);
  for (const [id, p] of Object.entries(EXTRA_PRESETS)) for (const k of Object.keys(p.instrument.params)) assert.ok(INSTRUMENT_DEFS[p.instrument.type].params.some((d) => d.key === k), `${id}.${k}`);
});

// ------------------------------------------------------------------ applying to a project
function mkApp() {
  const project = createProject({});
  const store = new Store(project);
  const ui = { state: {}, set(o) { Object.assign(this.state, o); }, get(k) { return this.state[k]; } };
  return { store, ui, actions: { addTrack() {} }, toast() {} };
}

test('FX chains and track templates: save from a track, insert / create with new ids, mixer settings and macros carried', () => {
  const app = mkApp();
  const t = createTrack({ name: 'Vox', volume: 0.7, pan: 0.3, fx: [createEffect('eq8', { b1On: true }), createEffect('compressor', { ratio: 3 })], instrument: { type: 'synth', preset: 'saw-lead', params: { cutoff: 900 } } });
  t.macros = [{ id: 'm1', name: 'Bright' }];
  const bus = { id: 'bus1', name: 'Verb', fx: [], volume: 1, pan: 0 };
  app.store.transact('setup', (p) => { p.tracks.push(t); p.buses = [bus]; });
  t.sends = { bus1: 0.4, gone: 0.5 };
  app.store.transact('send', (p) => { p.tracks[0].sends = { bus1: 0.4, gone: 0.5 }; });
  const chain = { name: 'c', fx: chainFromFx(app.store.get().tracks[0].fx) };
  assert.deepEqual(chain.fx.map((f) => f.type), ['eq8', 'compressor']);
  const t2 = createTrack({ name: 'Other' });
  app.store.transact('t2', (p) => { p.tracks.push(t2); });
  const added = insertChain(app, t2.id, chain);
  const fx2 = app.store.get().tracks[1].fx;
  assert.deepEqual(fx2.map((f) => f.type), ['eq8', 'compressor']);
  assert.ok(added.every((f) => !t.fx.some((o) => o.id === f.id)), 'new effect ids');
  insertChain(app, t2.id, { name: 'x', fx: [{ type: 'reverb', params: {} }] }, { mode: 'replace' });
  assert.deepEqual(app.store.get().tracks[1].fx.map((f) => f.type), ['reverb']);

  const tpl = { name: 'Vox tpl', track: templateFromTrack(app.store.get().tracks[0]) };
  assert.deepEqual(tpl.track.macros, [{ id: 'm1', name: 'Bright' }]);
  const nt = createTrackFromTemplate(app, tpl);
  const made = app.store.get().tracks.find((x) => x.id === nt.id);
  assert.equal(made.volume, 0.7);
  assert.equal(made.pan, 0.3);
  assert.deepEqual(made.sends, { bus1: 0.4 }, 'sends to missing buses dropped');
  assert.equal(made.instrument.params.cutoff, 900);
  assert.deepEqual(made.fx.map((f) => f.type), ['eq8', 'compressor']);
  assert.deepEqual(made.macros, [{ id: 'm1', name: 'Bright' }]);
  assert.ok(made.activePatternId && app.store.get().patterns[made.activePatternId]);
  assert.equal(app.ui.get('selectedTrackId'), made.id);
  // apply onto an existing track keeps it (and its id) but swaps sound + chain + mixer
  applyTemplateToTrack(app, t2.id, tpl);
  const t2b = app.store.get().tracks.find((x) => x.id === t2.id);
  assert.equal(t2b.instrument.preset, 'saw-lead');
  assert.equal(t2b.volume, 0.7);
  // one undo step per template
  app.store.undo();
  assert.equal(app.store.get().tracks.find((x) => x.id === t2.id).volume, 0.8);
});

test('applying effect presets keeps the sidechain key; dropped refs add effects / chains to the right owner', () => {
  const app = mkApp();
  const comp = createEffect('compressor', { sourceTrackId: 'kick', ratio: 2 });
  const t = createTrack({ name: 'Bass', fx: [comp] });
  app.store.transact('setup', (p) => { p.tracks.push(t); });
  const preset = effectPresetEntries('compressor').find((e) => e.name === 'Bass control');
  applyFxPreset(app, t.id, comp.id, preset);
  const f = app.store.get().tracks[0].fx[0];
  assert.equal(f.params.sourceTrackId, 'kick');
  assert.equal(f.params.ratio, preset.params.ratio);
  assert.ok(dropRef(app, { kind: 'fx', type: 'reverb', name: 'Plate' }, { trackId: t.id }));
  const last = app.store.get().tracks[0].fx.at(-1);
  assert.equal(last.type, 'reverb');
  assert.equal(last.params.decay, 1.6);
  assert.ok(presetStore().recent().includes('fx:reverb:Plate'), 'dropping counts as use');
  const cid = presetStore().save('chain', { name: 'Two', fx: [{ type: 'eq3', params: {} }, { type: 'delay', params: { mix: 0.2 } }] });
  dropRef(app, { kind: 'chain', id: cid }, { ownerId: 'master' });
  assert.deepEqual(app.store.get().master.fx.slice(-2).map((x) => x.type), ['eq3', 'delay']);
  assert.ok(addFxToOwner(app, t.id, 'chorus', { depth: 0.2 }, 0));
  assert.equal(app.store.get().tracks[0].fx[0].type, 'chorus');
  assert.equal(describeKey('fx:reverb:Plate').name, 'Reverb: Plate');
  assert.equal(describeKey(`chain:${cid}`).name, 'Two');
  assert.equal(describeKey('inst:sub-bass').ref.id, 'sub-bass');
  assert.equal(describeKey('fx:reverb:No such preset'), null);
  presetStore().remove('chain', cid);
});
