// The facade (src/code/strudel.js) backed by the vendored REAL Strudel engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadStrudel, evaluate, queryEvents, codeEngine, setSliderValue, useBuiltinEngine, dslNames,
} from '../src/code/strudel.js';

await loadStrudel();

test('the vendored Strudel engine loads and evaluate() uses it', () => {
  assert.equal(codeEngine(), 'strudel');
  assert.equal(evaluate('s("bd")').engine, 'strudel');
  assert.ok(dslNames().includes('sliderWithID') && dslNames().includes('voicing'));
  useBuiltinEngine(true);
  try { assert.equal(evaluate('s("bd")').engine, 'builtin'); } finally { useBuiltinEngine(false); }
});

test('labels, muted / anonymous patterns, blocks and locations', () => {
  const code = 'setcpm(30)\n$: s("bd sd")\n_$: s("hh*8")\nbass: note("c2 eb2").s("sawtooth")\nall(x => x.gain(.5))';
  const r = evaluate(code);
  assert.equal(r.error, null);
  assert.equal(r.cps, 0.5);
  assert.deepEqual(r.entries.map((e) => [e.name, e.muted, e.block]), [['$1', false, 0], ['$2', true, 1], ['bass', false, 2]]);
  assert.deepEqual(r.labels.map((l) => [l.name, l.muted]), [['$', false], ['$', true], ['bass', false]]);
  assert.equal(r.patterns.length, 2);
  const evs = queryEvents(r, 0, 1);
  assert.equal(evs.length, 4);
  assert.ok(evs.every((e) => e.value.gain === 0.5 && typeof e.begin === 'number'));
  const bass = evs.filter((e) => e.name === 'bass');
  assert.deepEqual(bass.map((e) => e.locations.map((l) => code.slice(l.start, l.end))), [['c2', 'sawtooth'], ['eb2', 'sawtooth']]);
  assert.deepEqual(bass.map((e) => e.value.note), [36, 39]);
});

test('slider() is a live widget', () => {
  const code = 's("bd*2").gain(slider(0.5, 0, 1))';
  const r = evaluate(code);
  assert.equal(r.error, null);
  const w = r.widgets.find((x) => x.type === 'slider');
  assert.deepEqual([w.id, code.slice(w.from, w.to), w.min, w.max], ['slider_22', '0.5', 0, 1]);
  assert.equal(queryEvents(r, 0, 1)[0].value.gain, 0.5);
  setSliderValue(w.id, 0.9); // moves the sound without re-evaluating
  assert.equal(queryEvents(r, 0, 1)[0].value.gain, 0.9);
});

test('REPL idioms: await samples, declarations shadowing Strudel names, object keys, unknown packages', () => {
  const r = evaluate(`await samples("github:tidalcycles/dirt-samples")
const chorus = s("bd")
let x = { "gain": 0.25 }
chorus.set(x).midi().fooBar()`);
  assert.equal(r.error, null, r.error);
  assert.equal(queryEvents(r, 0, 1)[0].value.gain, 0.25);
  assert.match(r.warnings.join(' '), /midi/);
  assert.equal(evaluate('const a = s("bd")').error, null);
  assert.equal(evaluate('// only a comment').entries.length, 0);
  assert.match(evaluate('s("bd"').error, /Unexpected/);
  assert.match(evaluate('nope(').error, /Unexpected/);
  assert.equal(evaluate('n("0 2 4").scale("C:major").s("piano").pianoroll()').error, null);
});
