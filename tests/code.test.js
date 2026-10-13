import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mini, evaluate, queryEvents, noteToMidi, transformSource, sequence, stack, fastcat, slowcat, pure, sine,
  dslNames, Pattern, bjork,
} from '../src/code/strudel.js';
import { codeToPatterns, patternsToCode, drumKey } from '../src/code/convert.js';
import { CODE_EXAMPLES } from '../src/code/examples.js';
import { CODE_REFERENCE } from '../src/code/docs.js';
import { createProject, createTrack, createPattern, createNote } from '../src/core/model.js';

const near = (a, b) => Math.abs(a - b) < 1e-6;
const onsets = (pat, b = 0, e = 1) => pat.onsetsBetween(b, e).sort((x, y) => x.whole.begin - y.whole.begin);
const times = (pat, b, e) => onsets(pat, b, e).map((h) => Math.round(h.whole.begin * 1e6) / 1e6);
const vals = (pat, b, e) => onsets(pat, b, e).map((h) => h.value);
const evs = (code, b = 0, e = 1) => {
  const r = evaluate(code);
  assert.equal(r.error, null, r.error);
  return queryEvents(r, b, e);
};

// ------------------------------------------------------------------------------ mini-notation

test('mini: subsequence timing', () => {
  assert.deepEqual(times(mini('bd [sd sd]')), [0, 0.5, 0.75]);
  assert.deepEqual(vals(mini('bd [sd sd]')), ['bd', 'sd', 'sd']);
});

test('mini: <> alternates one per cycle', () => {
  assert.deepEqual(vals(mini('<a b>'), 0, 4), ['a', 'b', 'a', 'b']);
  assert.deepEqual(vals(mini('<a <b c>>'), 0, 4), ['a', 'b', 'a', 'c']);
  assert.deepEqual(vals(mini('[a <b c>]'), 0, 2), ['a', 'b', 'a', 'c']);
});

test('mini: *n, rests and /n', () => {
  assert.deepEqual(times(mini('bd*2 ~ sd')).map((t) => +t.toFixed(4)), [0, 0.1667, 0.6667]);
  assert.deepEqual(times(mini('a b').slow(2), 0, 2), [0, 1]);
  assert.deepEqual(times(mini('[a b]/2'), 0, 2), [0, 1]);
  assert.deepEqual(vals(mini('a - b')), ['a', 'b']);
});

test('mini: euclid', () => {
  assert.deepEqual(times(mini('bd(3,8)')), [0, 3 / 8, 6 / 8]);
  assert.deepEqual(times(mini('bd(3,8,2)')), [1 / 8, 4 / 8, 6 / 8]);
  assert.deepEqual(bjork(5, 8), [1, 0, 1, 1, 0, 1, 1, 0]);
  assert.equal(onsets(mini('hh(5,16)')).length, 5);
});

test('mini: stacks, elongation, replication, hold', () => {
  const st = onsets(mini('[a,b]'));
  assert.equal(st.length, 2);
  assert.ok(st.every((h) => near(h.whole.begin, 0) && near(h.whole.end, 1)));
  assert.deepEqual(times(mini('a@3 b')), [0, 0.75]);
  assert.deepEqual(vals(mini('a!2 b')), ['a', 'a', 'b']);
  assert.deepEqual(times(mini('a!2 b')).map((t) => +t.toFixed(4)), [0, 0.3333, 0.6667]);
  assert.deepEqual(vals(mini('a ! b')), ['a', 'a', 'b']);
  assert.deepEqual(times(mini('a _ _ b')), [0, 0.75]);
  assert.deepEqual(vals(mini('a, b c')), ['a', 'b', 'c']);
});

test('mini: polymeter, grouping, lists, ranges, numbers', () => {
  assert.deepEqual(vals(mini('{a b c}%4'), 0, 2), ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b']);
  assert.deepEqual(vals(mini('{a b c, d e}')).sort(), ['a', 'b', 'c', 'd', 'd', 'e']);
  assert.deepEqual(times(mini('a . b c')), [0, 0.5, 0.75]);
  assert.deepEqual(vals(mini('bd:3 sd')), [['bd', 3], 'sd']);
  assert.deepEqual(vals(mini('0 .. 3')), [0, 1, 2, 3]);
  assert.deepEqual(vals(mini('1 -2 0.5 c#4 eb3')), [1, -2, 0.5, 'c#4', 'eb3']);
});

test('mini: ? degrade and | choice are deterministic', () => {
  const a = vals(mini('hh*16?'), 0, 4);
  const b = vals(mini('hh*16?'), 0, 4);
  assert.deepEqual(a, b);
  assert.ok(a.length > 10 && a.length < 54, `degraded count ${a.length}`);
  assert.ok(vals(mini('hh*16?0.9'), 0, 4).length < vals(mini('hh*16?0.1'), 0, 4).length);
  const choice = vals(mini('[a|b|c]*8'), 0, 4);
  assert.equal(choice.length, 32);
  assert.ok(new Set(choice).size >= 2);
});

test('mini: patterned fast factor and parse errors', () => {
  assert.equal(onsets(mini('a*<2 3>'), 0, 2).length, 5);
  assert.throws(() => mini('[a b'), /Mini-notation/);
});

// ----------------------------------------------------------------------------------- notes

test('note names follow Strudel (c4 = 60, default octave 3)', () => {
  assert.equal(noteToMidi('c4'), 60);
  assert.equal(noteToMidi('c3'), 48);
  assert.equal(noteToMidi('c'), 48);
  assert.equal(noteToMidi('a4'), 69);
  assert.equal(noteToMidi('eb4'), 63);
  assert.equal(noteToMidi('f#'), 54);
  assert.equal(noteToMidi('bb2'), 46);
  assert.equal(noteToMidi('cs3'), 49);
  const e = evs('note("c3 e3 g3 a")');
  assert.deepEqual(e.map((x) => x.value.note), [48, 52, 55, 57]);
});

test('n().scale() maps scale degrees', () => {
  assert.deepEqual(evs('n("0 1 2 3 4 5 6 7").scale("C:major")').map((x) => x.value.note), [48, 50, 52, 53, 55, 57, 59, 60]);
  assert.deepEqual(evs('n("0 2 -1").scale("C4:minor")').map((x) => x.value.note), [60, 63, 58]);
  assert.deepEqual(evs('n("0 1 2 5").scale("a2:minor:pentatonic")').map((x) => x.value.note), [45, 48, 50, 57]);
  assert.deepEqual(evs('n("0 1").scale("D4:dorian")').map((x) => x.value.note), [62, 64]);
  const alt = evs('n("0").scale("<C:major D:major>")', 0, 2).map((x) => x.value.note);
  assert.deepEqual(alt, [48, 50]);
  assert.equal(evs('n("0 2").scale("C:major")')[0].value.n, undefined);
});

test('chord voicing, arp, transpose, add', () => {
  const v = evs('chord("<Am7 C^7>").voicing()', 0, 2);
  assert.deepEqual(v.filter((x) => x.begin === 0).map((x) => x.value.note), [64, 67, 69, 72]);
  assert.deepEqual(v.filter((x) => x.begin === 1).map((x) => x.value.note), [64, 67, 71, 72]);
  assert.deepEqual(evs('note("[c3,e3,g3]").arp("0 2 1")').map((x) => x.value.note), [48, 55, 52]);
  assert.deepEqual(evs('note("c3 e3").transpose(12)').map((x) => x.value.note), [60, 64]);
  assert.deepEqual(evs('n("0 2".add("<0 3>")).scale("C:major")', 0, 2).map((x) => x.value.note), [48, 52, 53, 57]);
  assert.deepEqual(evs('note("c3").add(7)').map((x) => x.value.note), [55]);
});

// -------------------------------------------------------------------------------- evaluate

test('evaluate: $: patterns, muted _$:, setcpm', () => {
  const r = evaluate(`setcpm(120/4)
$: s("bd*4")
$: note("c3 e3")
  .s("sawtooth")
_$: s("hh*8")`);
  assert.equal(r.error, null);
  assert.equal(r.cps, 0.5);
  assert.equal(r.entries.length, 3);
  assert.equal(r.patterns.length, 2);
  assert.ok(r.entries[2].muted);
  const e = queryEvents(r, 0, 1);
  assert.equal(e.filter((x) => x.value.s === 'bd').length, 4);
  assert.equal(e.filter((x) => x.value.s === 'sawtooth').length, 2);
  assert.equal(e.filter((x) => x.value.s === 'hh').length, 0);
  for (let i = 1; i < e.length; i++) assert.ok(e[i].begin >= e[i - 1].begin);
});

test('evaluate: setcps, setbpm, bare expression, comments, await, errors', () => {
  assert.equal(evaluate('setcps(0.7)\ns("bd")').cps, 0.7);
  assert.equal(evaluate('setbpm(120)\ns("bd")').cps, 0.5);
  const r = evaluate(`// a comment with "quotes" and $: inside
await samples('github:tidalcycles/dirt-samples')
const kick = s("bd*2") // trailing comment
stack(kick, s("~ sd"))
  .gain(.8)`);
  assert.equal(r.error, null);
  assert.equal(queryEvents(r, 0, 1).length, 3);
  assert.equal(evaluate('nope(').error !== null, true);
  // unsupported functions/methods are skipped with a warning instead of failing the whole song
  const unk = evaluate('s("bd").fooBar()');
  assert.equal(unk.error, null);
  assert.match(unk.warnings.join(' '), /fooBar/);
  const sl = evaluate('s("bd*2").gain(slider(0.5, 0, 1))');
  assert.equal(sl.error, null);
  assert.equal(queryEvents(sl, 0, 1)[0].value.gain, 0.5);
  assert.match(evaluate('note("c3").scale("C:notascale")').error, /scale/i);
  assert.equal(evaluate('').patterns.length, 0);
  assert.equal(evaluate('').error, null);
});

test('evaluate: named labels, .p(), visual no-ops, semicolons, objects', () => {
  const r = evaluate(`drums: s("bd sd").pianoroll();
bass: note("c2").s("sawtooth")._scope()
$: s("hh").set({ "gain": 0.5 })`);
  assert.equal(r.error, null);
  assert.deepEqual(r.entries.map((x) => x.name), ['drums', 'bass', '$1']);
  assert.equal(queryEvents(r, 0, 1).find((x) => x.value.s === 'hh').value.gain, 0.5);
  const p = evaluate('s("bd").p("k")\nnote("c").p("m")');
  assert.deepEqual(p.entries.map((x) => x.name), ['k', 'm']);
  assert.ok(transformSource('$: s("bd")').body.includes('__reg'));
});

test('controls: chaining, aliases, mini args, compound s', () => {
  const e = evs('s("bd:3 sd").gain(".8 .5").lpf(800).lpq(5).room(.3).delay(.2).pan(sine)');
  assert.deepEqual(e[0].value, { s: 'bd', n: 3, gain: 0.8, cutoff: 800, resonance: 5, room: 0.3, delay: 0.2, pan: 0.5 });
  assert.equal(e[1].value.gain, 0.5);
  const top = evs('stack(s("bd"), note("c3")).velocity(.5).attack(.01).release(.2).legato(.5).bank("RolandTR909")');
  assert.ok(top.every((x) => x.value.velocity === 0.5 && x.value.release === 0.2 && x.value.bank === 'RolandTR909'));
  // structure comes from the left
  assert.equal(evs('s("bd").gain("1 .5")').length, 1);
  assert.equal(evs('gain("1 .5").s("bd")').length, 2);
});

test('time transforms: fast, slow, every, rev, ply, iter, palindrome, off, late', () => {
  assert.equal(evs('s("bd sd").fast(2)').length, 4);
  assert.equal(evs('s("bd sd").slow(2)', 0, 2).length, 2);
  assert.equal(evs('s("bd sd").fast("<1 2>")', 0, 2).length, 6);
  const every = evs('s("bd sd").every(2, x => x.fast(2))', 0, 4);
  assert.deepEqual([0, 1, 2, 3].map((c) => every.filter((x) => Math.floor(x.begin) === c).length), [4, 2, 4, 2]);
  const every2 = evs('s("bd sd").every(3, fast(2))', 0, 3);
  assert.equal(every2.length, 8);
  assert.deepEqual(evs('note("c3 d3 e3").rev()').map((x) => x.value.note), [52, 50, 48]);
  assert.equal(evs('s("bd sd").ply(3)').length, 6);
  assert.deepEqual(evs('note("c3 d3 e3 f3").iter(4)', 1, 2).map((x) => x.value.note), [50, 52, 53, 48]);
  assert.deepEqual(evs('note("c3 d3").palindrome()', 1, 2).map((x) => x.value.note), [50, 48]);
  const off = evs('s("bd").off(0.25, x => x.speed(2))');
  assert.deepEqual(off.map((x) => x.begin), [0, 0.25]);
  assert.equal(off[1].value.speed, 2);
  assert.deepEqual(evs('s("bd").late(.25)').map((x) => x.begin), [0.25]);
  assert.deepEqual(evs('s("bd sd").early(.5)').map((x) => x.value.s), ['sd', 'bd']);
  assert.equal(evs('note("c3 d3 e3 f3").linger(.25)').every((x) => x.value.note === 48), true);
  assert.deepEqual(evs('note("c3 d3 e3 f3").chunk(4, x => x.add(12))', 1, 2).map((x) => x.value.note), [48, 62, 52, 53]);
});

test('structure: struct, mask, euclid, euclidLegato, segment, range, jux, when', () => {
  assert.deepEqual(evs('note("c3").struct("x ~ x x")').map((x) => x.begin), [0, 0.5, 0.75]);
  assert.deepEqual(evs('s("hh*4").mask("1 0 1 1")').map((x) => x.begin), [0, 0.5, 0.75]);
  assert.deepEqual(evs('s("bd").euclid(3,8)').map((x) => x.begin), [0, 0.375, 0.75]);
  const leg = evs('s("bd").euclidLegato(3,8)');
  assert.deepEqual(leg.map((x) => [x.begin, x.end]), [[0, 0.375], [0.375, 0.75], [0.75, 1]]);
  const seg = evs('note(sine.range(48, 72).segment(4))');
  assert.equal(seg.length, 4);
  assert.ok(near(seg[0].value.note, 60) && near(seg[1].value.note, 72));
  const j = evs('s("bd sd").jux(rev)');
  assert.equal(j.length, 4);
  assert.deepEqual(j.filter((x) => x.value.pan === 1).map((x) => x.value.s), ['sd', 'bd']);
  assert.deepEqual(evs('note("c3 c3").when("1 0", x => x.add(12))').map((x) => x.value.note), [60, 48]);
  assert.equal(evs('s("bd*8").superimpose(x => x.speed(2))').length, 16);
});

test('random functions are deterministic', () => {
  const a = evs('s("hh*16").sometimes(x => x.speed(2))', 0, 2);
  const b = evs('s("hh*16").sometimes(x => x.speed(2))', 0, 2);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
  const sped = a.filter((x) => x.value.speed === 2).length;
  assert.ok(sped > 5 && sped < 27, `sped ${sped}`);
  const d = evs('s("hh*16").degradeBy(.5)', 0, 4).length;
  assert.ok(d > 16 && d < 48);
  assert.equal(evs('s("hh*16").degradeBy(0)').length, 16);
  assert.ok(evs('n(irand(8).segment(8))').every((x) => Number.isInteger(x.value.n) && x.value.n >= 0 && x.value.n < 8));
});

test('constructors: stack, cat, seq, timeCat, polymeter, arrange, run', () => {
  assert.deepEqual(vals(fastcat('a', 'b')), ['a', 'b']);
  assert.deepEqual(vals(slowcat('a', 'b'), 0, 2), ['a', 'b']);
  assert.deepEqual(vals(sequence('a', ['b', 'c'])), ['a', 'b', 'c']);
  assert.equal(onsets(stack(pure(1), pure(2))).length, 2);
  assert.deepEqual(evs('timeCat([3, s("bd")], [1, s("sd")])').map((x) => x.begin), [0, 0.75]);
  assert.deepEqual(evs('polymeter(["a","b","c"], ["d","e"]).s()').map((x) => x.value.s).sort(), ['a', 'b', 'c', 'd', 'd', 'e']);
  const arr = evs('arrange([2, s("bd")], [1, s("sd")])', 0, 3);
  assert.deepEqual(arr.map((x) => x.value.s), ['bd', 'bd', 'sd']);
  assert.deepEqual(evs('n(run(4))').map((x) => x.value.n), [0, 1, 2, 3]);
  assert.ok(sine instanceof Pattern);
});

test('queryEvents boundaries do not duplicate onsets', () => {
  const r = evaluate('s("bd*3 sd*5")');
  let total = 0;
  for (let k = 0; k < 80; k++) total += queryEvents(r, k / 10, (k + 1) / 10).length;
  assert.equal(total, queryEvents(r, 0, 8).length);
  assert.equal(total, 64);
  total = 0;
  for (let k = 0; k < 21; k++) total += queryEvents(r, k / 7, (k + 1) / 7).length;
  assert.equal(total, 24);
});

// ------------------------------------------------------------------------------------ convert

test('drumKey resolves aliases and banks', () => {
  assert.equal(drumKey('bd'), 'bd');
  assert.equal(drumKey('kick'), 'bd');
  assert.equal(drumKey('RolandTR808_bd'), 'bd');
  assert.equal(drumKey('808sd'), 'sd');
  assert.equal(drumKey('hh27'), 'hh');
  assert.equal(drumKey('clap'), 'cp');
  assert.equal(drumKey('sawtooth'), null);
});

test('codeToPatterns groups drums and melodic parts', () => {
  const pats = codeToPatterns(`$: s("bd [sd bd] ~ sd, hh*4")
$: note("c3 [e3 g3]").s("sawtooth")`, { cycles: 2 });
  const drums = pats.find((p) => p.kind === 'drums');
  const mel = pats.find((p) => p.kind === 'melodic');
  assert.ok(drums && mel);
  assert.equal(drums.lengthBeats, 4); // repeating -> trimmed to 1 cycle
  assert.deepEqual(drums.notes.filter((n) => n.pitch === 36).map((n) => n.start), [0, 1.5]);
  assert.deepEqual(drums.notes.filter((n) => n.pitch === 38).map((n) => n.start), [1, 3]);
  assert.equal(drums.notes.filter((n) => n.pitch === 42).length, 4);
  assert.equal(mel.sound, 'sawtooth');
  assert.deepEqual(mel.notes.map((n) => [n.pitch, n.start, n.dur]), [[48, 0, 2], [52, 2, 1], [55, 3, 1]]);
});

test('patternsToCode -> codeToPatterns round trip preserves onsets', () => {
  const p = createProject({ bpm: 128 });
  const d = createTrack({ name: 'Drums', instrument: { type: 'drums', preset: null, params: {} } });
  const b = createTrack({ name: 'Bass', role: 'bass' });
  p.tracks.push(d, b);
  const dNotes = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => createNote(36, i)),
    ...[1, 3, 5, 7].map((i) => createNote(38, i)),
    ...Array.from({ length: 16 }, (_, i) => createNote(42, i * 0.5)),
    createNote(36, 7.5), createNote(39, 6.75),
  ];
  const dp = createPattern(d.id, { length: 8, notes: dNotes });
  const bNotes = [createNote(36, 0, 0.5), createNote(36, 0.75, 0.25), createNote(48, 1.5, 1), createNote(39, 3, 0.5), createNote(43, 3, 0.5)];
  const bp = createPattern(b.id, { length: 4, notes: bNotes });
  Object.assign(p.patterns, { [dp.id]: dp, [bp.id]: bp });
  d.activePatternId = dp.id;
  b.activePatternId = bp.id;
  const code = patternsToCode(p);
  assert.match(code, /setcpm\(128\/4\)/);
  assert.match(code, /\$: s\("/);
  assert.match(code, /note\(".*\[eb2,g2\].*"\)\.s\("sawtooth"\)/);
  assert.match(code, /<\[/); // two different bars
  const back = codeToPatterns(code, { cycles: 2 });
  const key = (n) => `${n.pitch}@${n.start}`;
  const drums = back.find((x) => x.kind === 'drums');
  assert.deepEqual(drums.notes.map(key).sort(), dNotes.map(key).sort());
  const bass = back.find((x) => x.kind === 'melodic');
  assert.equal(bass.lengthBeats, 4);
  assert.deepEqual(bass.notes.map(key).sort(), bNotes.map(key).sort());
});

// ---------------------------------------------------------------------------- examples & docs

test('all CODE_EXAMPLES evaluate and produce events', () => {
  assert.ok(CODE_EXAMPLES.length >= 15);
  const ids = new Set();
  for (const ex of CODE_EXAMPLES) {
    assert.ok(ex.id && ex.name && ex.genre && ex.code, `example fields ${ex.id}`);
    assert.ok(!ids.has(ex.id));
    ids.add(ex.id);
    const r = evaluate(ex.code);
    assert.equal(r.error, null, `${ex.id}: ${r.error}`);
    assert.ok(queryEvents(r, 0, 4).length > 0, `${ex.id} produced no events`);
    assert.equal(r.queryError, undefined, `${ex.id}: ${r.queryError}`);
  }
});

test('CODE_REFERENCE covers the DSL', () => {
  const documented = new Set();
  for (const r of CODE_REFERENCE) {
    assert.ok(r.name && r.signature && r.description && r.example, `reference entry ${r.name}`);
    documented.add(r.name);
    for (const a of r.aliases || []) documented.add(a);
  }
  const names = new Set(dslNames());
  for (const n of ['stack', 'cat', 'seq', 'fast', 'slow', 'every', 'scale', 'voicing', 'euclid', 'jux', 'off', 'arp', 'chop',
    'striate', 'sometimesBy', 'degradeBy', 'segment', 'range', 'struct', 'mask', 'chunk', 'linger', 'inside', 'outside',
    'add', 'sub', 'mul', 'div', 'run', 'sine', 'perlin', 'rand', 'irand', 'setcpm', 'setcps', 'lpf', 'gain', 's', 'note', 'n',
    'iter', 'palindrome', 'ply', 'rev', 'early', 'late', 'superimpose', 'layer', 'transpose', 'polymeter', 'timeCat']) {
    assert.ok(documented.has(n), `undocumented: ${n}`);
  }
  for (const r of CODE_REFERENCE) {
    if (['mini', '$:'].includes(r.name)) continue;
    assert.ok(names.has(r.name) || typeof Pattern.prototype[r.name] === 'function', `documented but missing: ${r.name}`);
  }
});
