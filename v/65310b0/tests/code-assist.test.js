import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextAt, completionsAt, applyCompletion, buildCatalog, rankItems, computeDrop, minimalEdit, paletteGroups,
  statementSpans, codeMap, functionSnippet,
} from '../src/code/assist.js';
import { evaluate } from '../src/code/strudel.js';

const cat = buildCatalog({ key: { root: 0, scale: 'minor' }, samples: ['myloop'] });
const labels = (src, pos = src.length, o = {}) => completionsAt(src, pos, cat, o).items.map((i) => i.label);
const drop = (src, off, chip) => {
  const r = computeDrop(src, off, chip);
  assert.ok(r, 'drop result');
  return { ...r, sel: r.text.slice(r.selStart, r.selEnd) };
};
const lpf = { kind: 'method', code: '.lpf(800)', name: 'lpf', unique: true };

// ------------------------------------------------------------------ context detection

test('context: method after `.`, also across lines', () => {
  assert.equal(contextAt('s("bd").l', 9).kind, 'method');
  assert.equal(contextAt('s("bd").', 8).kind, 'method');
  assert.equal(contextAt('note("c3")\n  .lp', 16).kind, 'method');
  assert.equal(contextAt('s("bd").lpf(.', 13).kind, 'none'); // typing a number
  assert.equal(contextAt('x = 0.', 6).kind, 'none');
});

test('context: top level / statement start / argument', () => {
  const c = contextAt('$: st', 5);
  assert.equal(c.kind, 'top'); assert.equal(c.prefix, 'st'); assert.equal(c.atStart, true);
  const a = contextAt('s("bd").lpf(si', 14);
  assert.equal(a.kind, 'top'); assert.equal(a.atStart, false); assert.equal(a.argOf, 'lpf');
  assert.equal(contextAt('// s("b', 7).kind, 'none');
});

test('context: string argument knows its function', () => {
  let c = contextAt('s("b', 4);
  assert.equal(c.kind, 'string'); assert.equal(c.fn, 's'); assert.equal(c.isMethod, false); assert.equal(c.prefix, 'b');
  c = contextAt('note("c3").s("sa")', 15);
  assert.equal(c.fn, 's'); assert.equal(c.isMethod, true); assert.equal(c.prefix, 's'); assert.equal(c.to, 16);
  c = contextAt('s("bd").bank("Ro")', 16);
  assert.equal(c.fn, 'bank');
  c = contextAt('n("0").scale("C:mi")', 18);
  assert.equal(c.fn, 'scale'); assert.equal(c.prefix, 'C:mi');
  c = contextAt('s("bd*4 h")', 9);
  assert.equal(c.prefix, 'h'); assert.equal(c.from, 8);
  // closed string: caret after the closing quote is code
  assert.notEqual(contextAt('s("bd")', 7).kind, 'string');
});

// ------------------------------------------------------------------ completions

test('completions: s("b → bd first; .l → lpf; bank/scale/chord/note values', () => {
  assert.equal(labels('s("b')[0], 'bd');
  assert.ok(labels('s("my').includes('myloop'));
  assert.ok(labels('s("bd").l').slice(0, 3).includes('lpf'));
  assert.ok(labels('s("bd").bank("TR9').some((l) => /TR909/.test(l)));
  assert.equal(labels('n("0").scale("C:mi')[0], 'C:minor');
  assert.equal(labels('chord("C')[0], 'Cm7'); // diatonic in C minor ranks first
  assert.ok(labels('note("e').every((l) => l.startsWith('eb'))); // project key: Eb, not E
  assert.ok(labels('note("c3").s("saw').slice(0, 3).includes('sawtooth'));
});

test('completions: const names and $: at statement start; forced shows operators in strings', () => {
  assert.equal(labels('const drums = s("bd")\n$: dr')[0], 'drums');
  assert.ok(labels('$', 1, { force: true }).includes('$:'));
  assert.ok(labels('s("bd ")', 6, { force: true }).includes('<a b>'));
  assert.deepEqual(labels('s("bd")'), []); // nothing without a prefix
});

test('accepting a function inserts a snippet with the argument selected', () => {
  let r = completionsAt('s("bd").lp', 10, cat);
  let out = applyCompletion('s("bd").lp', r, r.items.find((i) => i.label === 'lpf'));
  assert.equal(out.text, 's("bd").lpf(800)');
  assert.equal(out.text.slice(out.selStart, out.selEnd), '800');
  r = completionsAt('$: s', 4, cat);
  out = applyCompletion('$: s', r, r.items.find((i) => i.label === 's'));
  assert.equal(out.text, '$: s("bd*4")');
  assert.equal(out.text.slice(out.selStart, out.selEnd), 'bd*4');
  // a following ( is kept: only the name is replaced
  r = completionsAt('s("bd").lp(300)', 10, cat);
  out = applyCompletion('s("bd").lp(300)', r, r.items.find((i) => i.label === 'lpf'));
  assert.equal(out.text, 's("bd").lpf(300)');
  // string value replaces the whole word under the caret
  r = completionsAt('s("bx sd")', 4, cat, { force: true });
  out = applyCompletion('s("bx sd")', r, { label: 'bd', kind: 'sound' });
  assert.equal(out.text, 's("bd sd")');
  assert.equal(functionSnippet('scale', null, true, { key: { root: 2, scale: 'dorian' } }).text, 'scale("D:dorian")');
});

test('ranking: prefix > case-insensitive > substring > fuzzy; recent first within a tier', () => {
  const items = ['lpf', 'LPF2', 'hlp', 'lxpxf', 'zzz'].map((label) => ({ label, kind: 'method' }));
  assert.deepEqual(rankItems(items, 'lp').map((i) => i.label), ['lpf', 'LPF2', 'hlp', 'lxpxf']);
  const r2 = rankItems([{ label: 'lpq', kind: 'm' }, { label: 'lpf', kind: 'm' }], 'lp', { recent: ['lpq'] });
  assert.equal(r2[0].label, 'lpq');
  assert.equal(rankItems(items, '').length, 5);
});

// ------------------------------------------------------------------ drops

test('drop method: appends to the end of the statement, before a trailing comment', () => {
  const r = drop('$: s("bd*4") // kick\n$: note("c3")', 3, lpf);
  assert.equal(r.text, '$: s("bd*4").lpf(800) // kick\n$: note("c3")');
  assert.equal(r.sel, '800');
});

test('drop method: multi-line chain gets a new line; blank line uses the statement above', () => {
  const src = '$: note("c3 e3")\n  .s("sawtooth")\n  .room(.3)\n\n$: s("hh*8")';
  assert.equal(drop(src, 3, lpf).text, '$: note("c3 e3")\n  .s("sawtooth")\n  .room(.3)\n  .lpf(800)\n\n$: s("hh*8")');
  // dropped on the 2nd line of the chain: same statement
  assert.equal(drop(src, 20, lpf).text, drop(src, 3, lpf).text);
  // blank line 4 -> statement above
  const blankOff = src.indexOf('\n\n') + 1;
  assert.equal(drop(src, blankOff, lpf).text, drop(src, 3, lpf).text);
});

test('drop method: inside stack / arrange -> that layer only; existing method -> its value selected', () => {
  const st = '$: stack(\n  s("bd*4"),\n  note("c2").s("saw")\n)';
  assert.equal(drop(st, 14, lpf).text, '$: stack(\n  s("bd*4").lpf(800),\n  note("c2").s("saw")\n)');
  const ar = '$: arrange(\n  [4, s("bd*4")],\n  [4, s("hh*8")]\n)';
  assert.equal(drop(ar, 16, lpf).text, '$: arrange(\n  [4, s("bd*4").lpf(800)],\n  [4, s("hh*8")]\n)');
  const r = drop('$: s("bd").lpf(300)', 3, lpf);
  assert.equal(r.text, '$: s("bd").lpf(300)');
  assert.equal(r.sel, '300');
  // label "x:" and a const are skipped/kept intact
  assert.equal(drop('const d = s("bd")', 12, lpf).text, 'const d = s("bd").lpf(800)');
});

test('drop sound: into the string at the drop point, or onto the line', () => {
  let r = drop('$: s("bd*4 hh")', 7, { kind: 'sound', value: 'sd', role: 'drum' });
  assert.equal(r.text, '$: s("bd*4 sd hh")'); assert.equal(r.sel, 'sd');
  r = drop('$: s("bd*4")', 2, { kind: 'sound', value: 'cp', role: 'drum' });
  assert.equal(r.text, '$: s("bd*4 cp")');
  r = drop('$: note("c3").s("sine")', 2, { kind: 'sound', value: 'sawtooth', role: 'synth' });
  assert.equal(r.text, '$: note("c3").s("sawtooth")');
  r = drop('$: note("c3 e3")', 2, { kind: 'sound', value: 'supersaw', role: 'synth' });
  assert.equal(r.text, '$: note("c3 e3").s("supersaw")');
  r = drop('$: s("bd")\n', 11, { kind: 'sound', value: 'hh', role: 'drum' });
  assert.equal(r.text, '$: s("bd")\n$: s("hh")');
});

test('drop bank / samples / block / slider / signal', () => {
  let r = drop('$: s("bd*4")', 2, { kind: 'bank', value: 'RolandTR808' });
  assert.equal(r.text, '$: s("bd*4").bank("RolandTR808")'); assert.equal(r.sel, 'RolandTR808');
  r = drop('$: s("bd*4").bank("RolandTR909")', 2, { kind: 'bank', value: 'RolandTR808' });
  assert.equal(r.text, '$: s("bd*4").bank("RolandTR808")');
  const pack = { kind: 'samples', code: "samples('github:tidalcycles/dirt-samples')" };
  r = drop('// song\n$: s("bd*4")', 12, pack);
  assert.equal(r.text, "// song\nsamples('github:tidalcycles/dirt-samples')\n$: s(\"bd*4\")");
  assert.equal(computeDrop(r.text, 30, pack).text, r.text); // only once
  const four = { kind: 'block', code: '$: s("bd*4")' };
  r = drop('$: note("c3")\n\n', 14, four);
  assert.equal(r.text, '$: note("c3")\n$: s("bd*4")\n'); assert.equal(r.sel, 'bd*4');
  r = drop('$: note("c3")', 3, four); // non-empty line -> new block below the statement
  assert.equal(r.text, '$: note("c3")\n$: s("bd*4")');
  r = drop('$: stack(\n  s("bd*4"),\n  s("hh*8")\n)', 3, { kind: 'block', code: '$: s("~ cp")' });
  assert.equal(r.text, '$: stack(\n  s("bd*4"),\n  s("hh*8"),\n  s("~ cp")\n)');
  r = drop('$: stack(s("bd*4"), s("hh*8"))', 14, { kind: 'block', code: '$: s("~ cp")' });
  assert.equal(r.text, '$: stack(s("bd*4"), s("hh*8"), s("~ cp"))');
  r = drop('$: arrange([4, s("bd*4")])', 3, { kind: 'block', code: '$: s("~ cp")' });
  assert.equal(r.text, '$: arrange([4, s("bd*4")], [4, s("~ cp")])');
  const slider = { kind: 'slider', code: 'slider(0.5, 0, 1)', fallback: 'gain' };
  r = drop('$: note("c2").lpf(800)', 19, slider);
  assert.equal(r.text, '$: note("c2").lpf(slider(800, 100, 5000))'); assert.equal(r.sel, '800');
  r = drop('$: note("c2")', 3, slider);
  assert.equal(r.text, '$: note("c2").gain(slider(0.75, 0, 1.5))');
  r = drop('$: note("c2").lpf(800)', 19, { kind: 'arg', code: 'sine.range(200, 2000)', fallback: 'lpf' });
  assert.equal(r.text, '$: note("c2").lpf(sine.range(200, 2000))');
});

test('drops produce code that evaluates', () => {
  let src = '$: s("bd*4")';
  for (const [off, chip] of [[3, lpf], [3, { kind: 'bank', value: 'RolandTR808' }], [6, { kind: 'sound', value: 'sd', role: 'drum' }],
    [src.length + 40, { kind: 'block', code: '$: n("0 2 4").scale("C:minor").s("sawtooth")' }]]) {
    src = computeDrop(src, Math.min(off, src.length), chip).text;
  }
  assert.equal(evaluate(src).error, null, src);
  // every palette chip dropped onto a typical line yields valid code
  for (const g of paletteGroups({ key: { root: 9, scale: 'minor' } })) {
    for (const sec of g.sections) {
      for (const chip of sec.chips) {
        if (chip.kind === 'samples' || chip.role === 'sample') continue;
        const base = '$: note("c3 e3 g3").s("sawtooth")\n';
        const r = computeDrop(base, 3, chip);
        assert.ok(r, chip.label);
        const res = evaluate(r.text);
        assert.equal(res.error, null, `${chip.label}: ${r.text} -> ${res.error}`);
      }
    }
  }
});

test('helpers: statement spans, minimal edit', () => {
  const src = '$: s("bd")\n  .lpf(200)\n\n// c\nx: note("c3")';
  const st = statementSpans(codeMap(src));
  assert.equal(st.length, 2);
  assert.equal(src.slice(st[0].start, st[0].end), '$: s("bd")\n  .lpf(200)');
  assert.deepEqual(minimalEdit('abcXdef', 'abcYYdef'), { from: 3, to: 4, insert: 'YY' });
});
