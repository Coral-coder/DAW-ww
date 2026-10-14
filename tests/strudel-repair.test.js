// Strudel repair (src/code/repair.js): TidalCycles-isms AI chatbots put in "Strudel" code -> valid Strudel, each
// repair recorded; mini-notation errors located in the file; "import the parts that work".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadStrudel, codeEngine, evaluate, queryEvents } from '../src/code/strudel.js';
import { repairStrudel, locateError, diagnose, salvageParts, TIDAL_ARP_MODES, TIDAL_TO_STRUDEL_CHORD } from '../src/code/repair.js';
import { splitStrudelToProject, summaryText } from '../src/code/import-split.js';
import { createProject, DRUM_PITCH } from '../src/core/model.js';
import { errorLocation } from '../src/ui/views/code.js';

if (!(await loadStrudel()) || codeEngine() !== 'strudel') throw new Error('vendored Strudel engine failed to load');

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/strudel-split/${name}.strudel`, import.meta.url), 'utf8');
/** Onset haps of the code over [0, cycles) as [begin, value] (sorted by time, then note). */
const haps = (code, cycles = 1) => {
  const res = evaluate(code);
  assert.equal(res.error, null, `${code}: ${res.error}`);
  return queryEvents(res, 0, cycles).filter((e) => e.begin >= 0).map((e) => ({ b: Math.round(e.begin * 1000) / 1000, v: e.value }))
    .sort((a, b) => a.b - b.b || (a.v.note ?? a.v.n ?? 0) - (b.v.note ?? b.v.n ?? 0));
};
const fix = (code, opts) => repairStrudel(code, opts);

test('Tidal chord names: C\'min7 -> Cm7 in chord(), each Strudel symbol is one the vendored voicing() knows', () => {
  const r = fix('chord("<C\'min7 F\'maj7 G\'dom7 A\'dim E\'aug D\'sus4 C\'six B\'min9 c\'major ef\'min7>").voicing()');
  assert.equal(r.code, 'chord("<Cm7 F^7 G7 Ao Eaug Dsus C6 Bm9 C Ebm7>").voicing()');
  assert.equal(r.repairs.length, 1);
  assert.equal(r.repairs[0].line, 1);
  assert.match(r.repairs[0].why, /Tidal chord names/);
  for (let c = 0; c < 10; c++) assert.ok(haps(r.code, 10).some((x) => x.b === c), `chord ${c} plays`);
  // every mapped name is recognised by Strudel's chord() + voicing() (a chord Strudel doesn't know plays nothing)
  for (const [name, to] of Object.entries(TIDAL_TO_STRUDEL_CHORD)) {
    const sym = typeof to === 'object' ? to.to : to;
    const out = haps(`chord("C${sym}").voicing()`);
    assert.ok(out.length >= 2, `${name} -> C${sym} plays notes`);
  }
  // in note(): written out as a stack
  assert.equal(fix('note("c\'maj e4\'min7")').code, 'note("[c3,e3,g3] [e4,g4,b4,d5]")');
});

test('Tidal operators: |+ keeps the left structure (.add.in), +| the right (.add.out), |+| both (.add.mix)', () => {
  const inn = fix('n("0 1" |+ "10 20 30")');
  assert.equal(inn.code, 'n("0 1".add.in("10 20 30"))');
  assert.deepEqual(haps(inn.code).map((x) => [x.b, x.v.n]), [[0, 10], [0.5, 21]]);
  const out = fix('n("0 1" +| "10 20 30")');
  assert.equal(out.code, 'n("0 1".add.out("10 20 30"))');
  assert.deepEqual(haps(out.code).map((x) => [x.b, x.v.n]), [[0, 10], [0.333, 20], [0.667, 31]]);
  const mix = fix('n("0 1" |+| "10 20 30")');
  assert.equal(mix.code, 'n("0 1".add.mix("10 20 30"))');
  assert.deepEqual(haps(mix.code).map((x) => [x.b, x.v.n]), [[0, 10], [0.333, 20], [0.5, 21], [0.667, 31]]);
  // the other operators, and chains (left-associative, like Tidal)
  assert.equal(fix('n("4 8" |- "1")').code, 'n("4 8".sub.in("1"))');
  assert.equal(fix('n("4 8" |* "2" |/ "4")').code, 'n("4 8".mul.in("2").div.in("4"))');
  assert.deepEqual(haps(fix('n("4 8" |* "2" |/ "4")').code).map((x) => x.v.n), [2, 4]);
  assert.equal(fix('s("bd*2") |< n("1 2 3")').code, 's("bd*2").keep.in(n("1 2 3"))');
  assert.equal(fix('s("bd*2") # speed 2').code, 's("bd*2").speed(2)');
  // unrepaired, JS reads `"a" |+ "b"` as a bitwise OR: the notes silently become 0
  const raw = evaluate('note("<c g>" |+ "[0,4,7]")');
  assert.ok(raw.error || queryEvents(raw, 0, 1).every((e) => e.value.note === 0));
  const chord = fix('note("<c g>" |+ "[0,4,7]")');
  assert.deepEqual(haps(chord.code).map((x) => x.v.note), [48, 52, 55]);
  assert.match(chord.repairs[0].why, /bitwise OR/);
});

test('note names: Tidal flats / sharps in notes only, glued notes -> stacks; sample names untouched', () => {
  const r = fix('note("ef4 cs bf2").s("bf")');
  assert.equal(r.code, 'note("eb4 c# bb2").s("bf")');
  assert.equal(fix('n("c4_ef4_g4 b_")').code, 'n("[c4,eb4,g4] b _")');
  assert.deepEqual(haps('note("[c4,eb4,g4]")').map((x) => x.v.note), [60, 63, 67]);
});

test('sounds: synth aliases -> Strudel names, banks in canonical spelling, struct("x o") rests', () => {
  assert.equal(fix('s("saw sin:2 tri sqr bd")').code, 's("sawtooth sine:2 triangle square bd")');
  assert.equal(fix('s("bd sd").bank("rolandtr909")').code, 's("bd sd").bank("RolandTR909")');
  assert.equal(fix('note("c").struct("x o x x")').code, 'note("c").struct("x ~ x x")');
  assert.equal(haps('note("c").struct("x ~ x x")').length, 3);
  assert.equal(fix('note("c").struct("x ~ x x")').repairs.length, 0);
});

test('Tidal arp modes: the documented orders for a 4-note chord, played by Strudel\'s .arp()', () => {
  // Tidal docs (arp): for c'maj'ii … e.g. "pinkyup" plays every note followed by the top note
  const expected = {
    up: 'c e g b', down: 'b g e c', updown: 'c e g b g e', downup: 'b g e c e g', 'up&down': 'c e g b b g e c',
    'down&up': 'b g e c c e g b', converge: 'c b e g', diverge: 'g e b c', disconverge: 'c b e g e b c',
    pinkyup: 'c b e b g b', pinkyupdown: 'c b e b g b g b e b', thumbup: 'c e c g c b', thumbupdown: 'c e c g c b c g c e',
  };
  const NAME = { 48: 'c', 52: 'e', 55: 'g', 59: 'b' };
  assert.deepEqual(Object.keys(TIDAL_ARP_MODES).sort(), Object.keys(expected).sort());
  for (const [mode, want] of Object.entries(expected)) {
    const r = fix(`note("[c,e,g,b]").arp("${mode}")`);
    assert.match(r.repairs[0]?.why || '', /arp mode/, mode);
    assert.equal(haps(r.code).map((x) => NAME[x.v.note]).join(' '), want, mode);
  }
  // two chords per cycle: the whole arpeggio in each (Tidal squeezes it into the chord)
  const two = fix('note("[c,e,g] [f,a,c4]").arp("up")');
  assert.equal(two.code, 'note("[c,e,g] [f,a,c4]").arp("[[0 1 2]]*2")');
  assert.deepEqual(haps(two.code).map((x) => x.v.note), [48, 52, 55, 53, 57, 60]);
  // mode patterns: one per cycle
  assert.equal(fix('note("[c,e,g]").arp("<up down>")').code, 'note("[c,e,g]").arp("<[0 1 2] [2 1 0]>")');
});

test('.voicings() -> .voicing(); .scale() without a root; scale degrees in note() -> n()', () => {
  const v = fix('chord("<Cm7 F7>").voicings()');
  assert.equal(v.code, 'chord("<Cm7 F7>").voicing()');
  assert.equal(haps('chord("<Cm7 F7>").voicings()').length, 0); // what Strudel 1.2 does with it: nothing
  assert.ok(haps(v.code).length >= 3);
  assert.equal(fix('chord("Cm7").voicings("lefthand")').code, 'chord("Cm7").dict("lefthand").voicing()');
  assert.equal(fix('"<C^7 Dm7>".voicings("lefthand")').code, '"<C^7 Dm7>".voicings("lefthand")'); // old API still works
  assert.equal(fix('n("0 2 4").scale("aeolian")').code, 'n("0 2 4").scale("C:aeolian")');
  assert.equal(fix('n("0 2 4").scale("minPent")', { key: 'Eb' }).code, 'n("0 2 4").scale("Eb:minor:pentatonic")');
  assert.equal(fix('n("0").scale("D:minor")\nn("0 2").scale("dorian")').code, 'n("0").scale("D:minor")\nn("0 2").scale("D:dorian")');
  assert.equal(fix('note("0 2 4").scale("C:major")').code, 'n("0 2 4").scale("C:major")');
  assert.deepEqual(haps('n("0 2 4").scale("C:major")').map((x) => x.v.note), [48, 52, 55]);
});

test('Haskell-only syntax is reported with the line and a suggestion, not guessed', () => {
  const r = fix('setcps(1)\nd1 $ sound "bd*2"');
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].line, 2);
  assert.match(r.unresolved[0].suggestion, /\$:/);
  const e = fix('s("bd").every 3 (fast 2)');
  assert.match(e.unresolved[0].suggestion, /firstOf/);
});

test('mini-notation errors are located in the file (the string literal), not "line 1" of the string', () => {
  const code = fixture('breakbeat');
  const res = evaluate(code);
  assert.match(res.error, /\[mini\] parse error at line 1/);
  const loc = locateError(code, res.error);
  assert.equal(loc.line, 30);
  assert.equal(loc.column, 15); // the `'` of C'min7
  assert.equal(code.split('\n')[29][loc.column - 1], "'");
  assert.equal(loc.snippet, '"<C\'min7 F\'min7 G\'min7 G\'dom7>"');
  const d = diagnose('setcps(1)\n\n$: s("bd sd")\n$: note("c [e g")');
  assert.equal(d.line, 4);
  assert.match(d.snippet, /c \[e g/);
  // the Code tab's error banner / highlighted line: errorLocation (same mapping), not the comment on line 1
  const ui = errorLocation(res.error, code);
  assert.deepEqual([ui.line, ui.column, ui.snippet], [30, 15, loc.snippet]);
  assert.equal(errorLocation('boom at line 3', 'a\nb\nc').line, 3); // other messages: their own line
  assert.equal(diagnose('s("bd")'), null);
});

test('import the parts that work: failing stack members / blocks are dropped, the rest kept', () => {
  const code = 'setcps(0.5)\nstack(\n  s("bd*4"),\n  // broken\n  note("c [e g").s("sine"),\n  note("c e").s("sawtooth")\n)';
  const sv = salvageParts(code);
  assert.ok(sv);
  assert.equal(sv.dropped.length, 1);
  assert.equal(sv.dropped[0].line, 5);
  assert.match(sv.dropped[0].label, /broken/);
  assert.equal(evaluate(sv.code).error, null);
  const blocks = salvageParts('$: s("bd*2")\n$: note("c [e")\n$: note("g").s("sine")');
  assert.equal(blocks.dropped.length, 1);
  assert.equal(blocks.dropped[0].line, 2);
  assert.equal(haps(blocks.code).length, 3);
  assert.equal(salvageParts('s("bd")'), null); // nothing fails
});

test('breakbeat fixture (AI-chatbot "Strudel"): repaired, evaluates, splits into drums / acid bass / pads / arp lead', () => {
  const code = fixture('breakbeat');
  const r = fix(code);
  assert.equal(r.unresolved.length, 0);
  assert.equal(diagnose(r.code), null);
  const kinds = r.repairs.map((x) => `${x.line}:${x.to}`);
  for (const want of ['13:"RolandTR909"', '17:"sawtooth"', '18:"<c g f b_>".add.in("[0,4,7,11]")', '19:"x ~ x x ~ x ~ x"',
    '30:"<Cm7 Fm7 Gm7 G7>"', '32:.voicing()', '40:"<[c4,eb4,g4,bb4] [f4,ab4,c5,eb5]>"', '41:"[0 3 1 3 2 3]"']) assert.ok(kinds.includes(want), `${want} in ${kinds.join(' | ')}`);
  assert.ok(r.repairs.every((x) => x.line > 0 && x.from && x.to && x.why));
  assert.equal(r.code.split('\n').length, code.split('\n').length); // the user's lines stay where they were

  const p = createProject();
  const s = splitStrudelToProject(p, code);
  assert.equal(s.error, undefined, s.error);
  assert.equal(p.bpm, 156); // 0.65 cps × 4 × 60
  assert.equal(s.repairs.length, r.repairs.length);
  assert.match(summaryText(s), /Repaired \d+ things/);
  // the repaired code is what the code track keeps; the user's text is kept with the project
  const ct = p.tracks.find((t) => t.type === 'code');
  assert.equal(ct.code, r.code);
  assert.equal(p.importedCode.original, code);
  assert.equal(p.importedCode.code, r.code);

  const inst = p.tracks.filter((t) => t.type === 'instrument');
  const notes = (t) => p.clips.filter((c) => c.trackId === t.id).flatMap((c) => p.patterns[c.patternId].notes);
  const busOf = (t, type) => Object.entries(t.sends || {}).filter(([, v]) => v > 0).map(([id, v]) => ({ bus: p.buses.find((b) => b.id === id), v })).find((x) => x.bus?.fx.some((f) => f.type === type));
  // drums: ONE track, 909 pads kick / snare / hats / clap; the clap's reverb -> a reverb send
  const drums = inst.filter((t) => t.instrument.type === 'drums');
  assert.equal(drums.length, 1);
  assert.equal(drums[0].instrument.params.machine, 'RolandTR909');
  const pads = new Set(notes(drums[0]).map((n) => n.pitch));
  for (const k of ['kick', 'snare', 'hihat', 'clap']) assert.ok(pads.has(DRUM_PITCH[k]), k);
  assert.equal(busOf(drums[0], 'reverb')?.v, 0.4);
  // acid bass: sawtooth, pan .3 (-> -0.4), resonance 2, low-pass automated 400 <-> 2000 Hz over 4 cycles
  const bass = inst.find((t) => /bass/i.test(t.name));
  assert.equal(bass.instrument.params.s, 'sawtooth');
  assert.equal(bass.pan, -0.4);
  const lp = bass.fx.find((f) => f.type === 'filter');
  assert.equal(lp.params.resonance, 2);
  const lane = bass.automation.find((l) => l.target.includes(lp.id) && l.target.endsWith('cutoff'));
  const vals = lane.points.map((x) => x.value);
  assert.ok(Math.min(...vals) <= 410 && Math.max(...vals) >= 1990, `${Math.min(...vals)}..${Math.max(...vals)}`);
  const lo = lane.points.filter((x) => x.value < 420).map((x) => x.beat);
  assert.ok(lo.some((b) => Math.abs(b - 12) < 1) && lo.some((b) => Math.abs(b - 28) < 1), 'the sweep repeats every 4 cycles (16 beats)');
  assert.ok(notes(bass).every((n) => n.pitch >= 36 && n.pitch <= 84), 'bass notes in range');
  // pads: sine, Cm7 Fm7 Gm7 G7 voiced, attack / release, reverb send
  const pads2 = inst.find((t) => /pad/i.test(t.name));
  assert.equal(pads2.instrument.params.s, 'sine');
  assert.equal(pads2.instrument.params.attack, 0.4);
  assert.equal(pads2.instrument.params.release, 1.5);
  assert.ok(busOf(pads2, 'reverb'));
  const pcs = (beat) => [...new Set(notes(pads2).filter((n) => n.start === beat).map((n) => n.pitch % 12))].sort((a, b) => a - b).join(',');
  assert.equal(pcs(0), '0,3,7,10'); // Cm7
  assert.equal(pcs(16), '0,3,5,8'); // Fm7
  assert.equal(pcs(32), '2,5,7,10'); // Gm7
  assert.equal(pcs(48), '2,5,7,11'); // G7
  // arp lead: triangle, pinkyup over Cm7 (c eb g bb -> c bb eb bb g bb), jux -> L / R tracks, delay send .6 fb .4
  const leads = inst.filter((t) => /lead|arp/i.test(t.name));
  assert.equal(leads.length, 2);
  assert.deepEqual(leads.map((t) => t.pan), [-1, 1]);
  for (const t of leads) {
    assert.equal(t.instrument.params.s, 'triangle');
    const d = busOf(t, 'delay');
    assert.equal(d.v, 0.6);
    assert.equal(d.bus.fx.find((f) => f.type === 'delay').params.feedback, 0.4);
  }
  const left = notes(leads[0]).filter((n) => n.start < 4).sort((a, b) => a.start - b.start).map((n) => n.pitch);
  assert.deepEqual(left, [60, 70, 63, 70, 67, 70]);
});

test('earlier fixtures need no repairs', () => {
  for (const f of ['house', 'ambient', 'labels', 'simple-stack', 'live-helpers', 'tech-house']) {
    const r = fix(fixture(f));
    assert.deepEqual(r.repairs.map((x) => `${x.line}: ${x.from} -> ${x.to}`), [], f);
    assert.equal(r.code, fixture(f));
  }
});
