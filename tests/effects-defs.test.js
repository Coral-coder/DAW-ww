import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFECT_DEFS, EFFECT_TYPES, EFFECT_CATEGORIES, DIVISIONS, DIVISION_OPTIONS,
  divisionToBeats, getEffectDefaults, resolveEffectParams,
} from '../src/audio/effect-defs.js';

const REQUIRED = ['eq3', 'eq8', 'filter', 'compressor', 'limiter', 'distortion', 'bitcrusher', 'delay', 'reverb',
  'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'widener', 'pump', 'saturator', 'tape', 'utility'];

test('all required effect types exist', () => {
  for (const t of REQUIRED) assert.ok(EFFECT_DEFS[t], `missing ${t}`);
  assert.deepEqual(EFFECT_TYPES, Object.keys(EFFECT_DEFS));
});

test('effect defs are well-formed', () => {
  for (const [type, def] of Object.entries(EFFECT_DEFS)) {
    assert.equal(typeof def.name, 'string', type);
    assert.ok(EFFECT_CATEGORIES.includes(def.category), `${type} category ${def.category}`);
    assert.ok(def.description && def.description.length > 10, `${type} description`);
    assert.ok(Array.isArray(def.params) && def.params.length > 0, `${type} params`);
    const keys = new Set();
    for (const p of def.params) {
      const where = `${type}.${p.key}`;
      assert.ok(p.key && !keys.has(p.key), `duplicate/empty key ${where}`);
      keys.add(p.key);
      assert.equal(typeof p.label, 'string', where);
      assert.equal(typeof p.section, 'string', where);
      assert.ok(['number', 'enum', 'bool', 'track', 'pattern'].includes(p.type), where);
      if (p.type === 'number') {
        assert.ok(p.min < p.max, `${where} range`);
        assert.ok(p.default >= p.min && p.default <= p.max, `${where} default in range`);
        assert.ok(p.step > 0, `${where} step`);
        assert.ok(['lin', 'log', 'exp'].includes(p.curve), `${where} curve`);
        if (p.curve === 'log') assert.ok(p.min > 0, `${where} log needs min > 0`);
      } else if (p.type === 'enum') {
        assert.ok(p.options.length >= 2, `${where} options`);
        assert.ok(p.options.some((o) => o.value === p.default), `${where} default in options`);
        for (const o of p.options) assert.equal(typeof o.label, 'string', where);
      } else if (p.type === 'track' || p.type === 'pattern') {
        assert.equal(typeof p.default, 'string', `${where} ${p.type} default`);
      } else {
        assert.equal(typeof p.default, 'boolean', `${where} bool default`);
      }
    }
  }
});

test('mix param on wet/dry style effects', () => {
  for (const t of ['filter', 'compressor', 'distortion', 'bitcrusher', 'delay', 'reverb', 'chorus', 'flanger', 'phaser', 'saturator', 'tape']) {
    const mix = EFFECT_DEFS[t].params.find((p) => p.key === 'mix');
    assert.ok(mix, `${t} has mix`);
    assert.equal(mix.min, 0);
    assert.equal(mix.max, 1);
  }
});

test('eq8 has 8 complete bands', () => {
  const keys = EFFECT_DEFS.eq8.params.map((p) => p.key);
  for (let i = 1; i <= 8; i++) for (const k of ['On', 'Type', 'Freq', 'Gain', 'Q']) assert.ok(keys.includes(`b${i}${k}`), `b${i}${k}`);
});

test('defaults + resolve', () => {
  const d = getEffectDefaults('delay');
  assert.equal(d.feedback, 0.4);
  assert.deepEqual(getEffectDefaults('nope'), {});
  const r = resolveEffectParams({ type: 'delay', params: { feedback: 5, pingpong: 1, division: 'bogus', time: 'x' } });
  assert.equal(r.feedback, 0.95); // clamped
  assert.equal(r.pingpong, true);
  assert.equal(r.division, d.division);
  assert.equal(r.time, d.time);
  const ph = resolveEffectParams({ type: 'phaser', params: { stages: '8' } });
  assert.equal(ph.stages, 8);
  // model.js default project effects resolve cleanly
  assert.equal(resolveEffectParams({ type: 'reverb', params: { mix: 1, decay: 2.8 } }).decay, 2.8);
  assert.equal(resolveEffectParams({ type: 'limiter', params: { threshold: -1 } }).threshold, -1);
});

test('divisions', () => {
  assert.equal(divisionToBeats('1/4'), 1);
  assert.equal(divisionToBeats('1/8D'), 0.75);
  assert.equal(divisionToBeats('1/1'), 4);
  assert.equal(divisionToBeats(0.5), 0.5);
  assert.equal(divisionToBeats('garbage'), 1);
  assert.equal(DIVISION_OPTIONS.length, Object.keys(DIVISIONS).length);
});
