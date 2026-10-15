// Pure-data checks for the audio instrument metadata, presets and drum kits (Node, no AudioContext).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENT_DEFS, getParamDefaults, sanitizeParams, DRUM_PAD_PARAM_DEFS } from '../src/audio/defs.js';
import { PRESETS, resolveInstrumentDef, listPresets, PRESET_CATEGORIES } from '../src/audio/presets.js';
import { DRUM_KITS } from '../src/audio/kits.js';
import { DRUM_PADS } from '../src/core/model.js';

const TYPES = ['synth', 'fm', 'organ', 'drums', 'sampler', 'drumsampler', 'soundfont', 'faust', 'wam', 'native', 'strudel', 'wavetable'];

test('INSTRUMENT_DEFS covers every instrument type with well-formed ParamDefs', () => {
  assert.deepEqual(Object.keys(INSTRUMENT_DEFS).sort(), [...TYPES].sort());
  for (const type of TYPES) {
    const def = INSTRUMENT_DEFS[type];
    assert.ok(def.name, `${type} has a name`);
    const keys = new Set();
    for (const p of def.params) {
      assert.ok(p.key && p.label && p.type && p.section, `${type}.${p.key} has key/label/type/section`);
      assert.ok(!keys.has(p.key), `${type}.${p.key} is unique`);
      keys.add(p.key);
      if (p.type === 'number') {
        assert.ok(p.min < p.max, `${type}.${p.key} min < max`);
        assert.ok(p.default >= p.min && p.default <= p.max, `${type}.${p.key} default in range`);
        assert.ok(p.step > 0, `${type}.${p.key} step > 0`);
      } else if (p.type === 'enum') {
        assert.ok(p.options.some((o) => o.value === p.default), `${type}.${p.key} default is an option`);
      } else {
        assert.ok(['bool', 'sample', 'wavetable'].includes(p.type), `${type}.${p.key} known type`);
      }
    }
    // both a simple and an advanced view exist
    assert.ok(def.params.some((p) => !p.advanced) && def.params.some((p) => p.advanced), `${type} has simple + advanced params`);
  }
  assert.ok(DRUM_PAD_PARAM_DEFS.find((p) => p.key === 'tune'));
});

test('getParamDefaults returns one value per param', () => {
  for (const type of TYPES) {
    const d = getParamDefaults(type);
    for (const p of INSTRUMENT_DEFS[type].params) assert.ok(p.key in d, `${type}.${p.key}`);
  }
  assert.deepEqual(getParamDefaults('drums').pads, {});
  assert.equal(getParamDefaults('drums').kit, '808');
});

const REQUIRED_PRESETS = [
  'sub-bass', '808-bass', 'reese-bass', 'acid-bass', 'pluck-bass', 'fm-bass', 'wobble-bass', 'moog-bass', 'finger-bass', 'saw-bass',
  'dub-bass', 'upright-bass', 'chip-bass', 'synthwave-bass',
  'supersaw-lead', 'square-lead', 'saw-lead', 'fm-bell-lead', 'chip-lead', 'acid-lead', 'sync-lead', 'whistle-lead', 'guitar-lead',
  'brass-lead', 'flute', 'trance-lead', 'hoover',
  'electric-piano', 'fm-epiano', 'grand-piano', 'organ-drawbar', 'organ-rock', 'clav', 'vibraphone', 'marimba', 'bell', 'celesta',
  'harpsichord', 'music-box', 'lofi-keys',
  'warm-pad', 'string-pad', 'choir-pad', 'ambient-pad', 'dark-pad', 'glass-pad', 'supersaw-pad', 'strings', 'brass-section', 'synthwave-pad',
  'pluck', 'house-stab', 'future-chords', 'guitar-clean', 'guitar-dist', 'power-chord', 'harp', 'koto', 'steel-drum', 'kalimba',
  'arp-pluck', 'arp-saw', 'riser', 'noise-sweep', 'laser',
];

test('PRESETS contains every required id with valid metadata', () => {
  for (const id of REQUIRED_PRESETS) assert.ok(PRESETS[id], `missing preset ${id}`);
  for (const [id, p] of Object.entries(PRESETS)) {
    assert.ok(p.name, `${id} name`);
    assert.ok(PRESET_CATEGORIES.includes(p.category), `${id} category ${p.category}`);
    assert.ok(Array.isArray(p.roles) && p.roles.length, `${id} roles`);
    assert.ok(Array.isArray(p.genres) && p.genres.length, `${id} genres`);
    assert.ok(TYPES.includes(p.instrument.type), `${id} type`);
  }
});

test('every preset param is a known, in-range parameter of its instrument type', () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    const defs = new Map(INSTRUMENT_DEFS[p.instrument.type].params.map((d) => [d.key, d]));
    for (const [k, v] of Object.entries(p.instrument.params)) {
      const d = defs.get(k);
      assert.ok(d, `${id}: unknown param "${k}" for type ${p.instrument.type}`);
      if (d.type === 'number') assert.ok(typeof v === 'number' && v >= d.min && v <= d.max, `${id}.${k}=${v} outside ${d.min}..${d.max}`);
      if (d.type === 'enum') assert.ok(d.options.some((o) => o.value === v), `${id}.${k}=${v} not an option`);
      if (d.type === 'bool') assert.equal(typeof v, 'boolean', `${id}.${k} bool`);
    }
  }
});

test('DRUM_KITS has exactly the required kits, each with a voice for every pad', () => {
  const ids = ['808', '909', 'trap', 'lofi', 'acoustic', 'rock', 'techno', 'house', 'breaks', 'dnb', 'jazz', 'latin', 'afro',
    'reggaeton', 'chip', 'industrial', 'hardstyle', 'phonk', 'garage', 'cinematic'];
  assert.deepEqual(Object.keys(DRUM_KITS).sort(), [...ids].sort());
  for (const [id, kit] of Object.entries(DRUM_KITS)) {
    assert.ok(kit.name && kit.description, `${id} name/description`);
    for (const pad of DRUM_PADS) {
      const v = kit.voices[pad.key];
      assert.ok(v, `${id} missing pad ${pad.key}`);
      assert.ok((v.tones && v.tones.length) || v.noise || v.metal || v.click, `${id}.${pad.key} has a sound layer`);
      for (const t of v.tones || []) assert.ok(t.freq > 0 && t.decay > 0, `${id}.${pad.key} tone freq/decay`);
    }
  }
  // kits are actually distinct
  assert.notDeepEqual(DRUM_KITS['808'].voices.kick, DRUM_KITS['909'].voices.kick);
  assert.ok(DRUM_KITS.chip.fx?.crush, 'chip kit is bit-crushed');
});

test('resolveInstrumentDef merges defaults <- preset <- params and sanitizes', () => {
  const r = resolveInstrumentDef({ type: 'synth', preset: 'acid-bass', params: { cutoff: 900 } });
  assert.equal(r.type, 'synth');
  assert.equal(r.params.cutoff, 900); // def.params override preset
  assert.equal(r.params.resonance, PRESETS['acid-bass'].instrument.params.resonance); // preset overrides default
  assert.equal(r.params.lfo2Target, 'none'); // default fills the rest

  const m = resolveInstrumentDef({ type: 'synth', preset: 'electric-piano', params: {} });
  assert.equal(m.type, 'fm', 'preset type wins on mismatch');

  const s = resolveInstrumentDef({ type: 'synth', params: { cutoff: 'abc', resonance: 99, filterType: 'bogus', mono: 1 } });
  assert.equal(s.params.cutoff, 8000);
  assert.equal(s.params.resonance, 1);
  assert.equal(s.params.filterType, 'lp24');
  assert.equal(s.params.mono, true);

  const d = resolveInstrumentDef({ type: 'drums', params: { kit: 'trap', pads: { kick: { tune: -3 }, snare: { tune: 99 } } } });
  assert.equal(d.params.kit, 'trap');
  assert.equal(d.params.pads.kick.tune, -3);
  assert.equal(d.params.pads.snare.tune, 24);

  assert.equal(resolveInstrumentDef(null).type, 'synth');
  assert.equal(resolveInstrumentDef({ type: 'nope' }).type, 'synth');
  assert.equal(sanitizeParams('sampler', {}).sampleId, null);
});

test('listPresets filters by category, role, genre and type', () => {
  assert.ok(listPresets().length >= REQUIRED_PRESETS.length);
  assert.ok(listPresets({ category: 'Bass' }).every((p) => p.category === 'Bass'));
  assert.ok(listPresets({ role: 'pad' }).some((p) => p.id === 'warm-pad'));
  assert.ok(listPresets({ genre: 'trap' }).some((p) => p.id === '808-bass'));
  assert.ok(listPresets({ type: 'organ' }).every((p) => p.instrument.type === 'organ'));
});
