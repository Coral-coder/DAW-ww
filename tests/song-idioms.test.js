// Idiomatic, compact song code (src/code/idioms.js + song-code.js): idiom detection, faithfulness of the whole
// arranged song across every genre, compactness vs the previous writer, export, and apply-back of section patterns
// and arrangement edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, queryEvents, bjork, splitTopLevel } from '../src/code/strudel.js';
import {
  renderPart, compactSteps, barsText, alternation, toDegree, fromDegree, verifyExpr, quantizePart, detectSwing,
  euclidOf, velocityModel, scaleCandidates,
} from '../src/code/idioms.js';
import { songToCode, applySongCode, noteSpeller, hasArrangement, parseArrange } from '../src/code/song-code.js';
import { patternsToCode } from '../src/code/convert.js';
import { generateSong } from '../src/gen/song.js';
import { GENRES } from '../src/gen/genres.js';
import { createProject, createNote, beatsPerBar } from '../src/core/model.js';
import { songFaith } from './lib/song-faith.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const KEY = { root: 0, scale: 'minor' };
const spell = noteSpeller({ key: KEY });
const CM = [0, 2, 3, 5, 7, 8, 10];
const deg = (d, root = 60) => fromDegree(d, root, CM);
const N = (pitch, start, dur = 0.25, vel = 0.8) => ({ pitch, start, dur, vel });
const song = (genre, seed = 1, extra = {}) => ({ ...createProject(), ...generateSong({ genre, seed }), mode: 'song', ...extra });
const barsOf = (p) => Math.max(...p.clips.map((c) => c.start + c.length)) / beatsPerBar(p);

// ------------------------------------------------------------------------------ idioms

test('scale degrees: conversion round trip; melodies in the key are written as n().scale()', () => {
  for (let d = -9; d <= 16; d++) assert.equal(toDegree(fromDegree(d, 60, CM), 60, CM), d);
  assert.equal(toDegree(61, 60, CM), null); // C# isn't in C minor
  const notes = [0, 2, 4, 2, 6, 4, 3, 1].map((d, i) => N(deg(d), i * 0.5, 0.5));
  const r = renderPart(notes, 4, { kind: 'melodic', bpb: 4, key: KEY, spell });
  assert.ok(r.verified);
  assert.match(r.expr, /^n\("0 2 4 2 6 4 3 1"\)\.scale\("C4:minor"\)$/);
  // a raised 7th (B natural) is still in a related scale: harmonic minor
  const hm = renderPart([N(60, 0), N(63, 1), N(67, 2), N(71, 3)], 4, { kind: 'melodic', bpb: 4, key: KEY, spell });
  assert.match(hm.expr, /scale\("C4:harmonic:minor"\)/);
  // chromatic lines that fit no scale fall back to note names
  const chrom = renderPart([60, 61, 62, 63, 64, 65, 66, 67].map((p, i) => N(p, i * 0.5, 0.5)), 4, { kind: 'melodic', bpb: 4, key: KEY, spell });
  assert.match(chrom.expr, /^note\("/);
  assert.ok(scaleCandidates('minor').some((s) => s.name === 'harmonic:minor'));
});

test('motif + transposition: a cell moved per bar becomes n("cell".add("<offsets>"))', () => {
  const notes = [];
  [0, 3, 5, 4].forEach((o, bar) => [0, 2, 4, 2].forEach((d, i) => notes.push(N(deg(d + o), bar * 4 + i, 1, 0.8))));
  const r = renderPart(notes, 16, { kind: 'melodic', bpb: 4, key: KEY, spell });
  assert.equal(r.expr, 'n("0 2 4 2".add("<0 3 5 4>")).scale("C4:minor")');
  // a chord-following bassline: the alternation carries the line
  const bass = [];
  [0, 5, 3, 4].forEach((o, bar) => { for (let i = 0; i < 8; i++) bass.push(N(deg(o, 36), bar * 4 + i * 0.5, 0.5)); });
  assert.equal(renderPart(bass, 16, { kind: 'melodic', bpb: 4, key: KEY, spell }).expr, 'n("<0 5 3 4>!8").scale("C2:minor")');
  // shifted triads: one stack + the progression
  const pad = [];
  [0, 3, 5, 4].forEach((o, bar) => [0, 2, 4].forEach((d) => pad.push(N(deg(d + o), bar * 4, 4, 0.6))));
  assert.equal(renderPart(pad, 16, { kind: 'melodic', bpb: 4, key: KEY, spell }).expr, 'n("[0,2,4]".add("<0 3 5 4>")).scale("C4:minor").velocity(.6)');
});

test('rhythm × harmony: comped chords become n("<chords>").struct("<rhythm>")', () => {
  const voicings = [[0, 2, 4], [0, 3, 5], [-1, 1, 4], [-1, 2, 4]]; // voice-led inversions: no common shape
  const notes = [];
  voicings.forEach((v, bar) => [0, 0.75, 1.5, 2.5, 3].forEach((t) => v.forEach((d) => notes.push(N(deg(d), bar * 4 + t, 0.5, 0.7)))));
  const r = renderPart(notes, 16, { kind: 'melodic', bpb: 4, key: KEY, spell });
  assert.ok(r.verified);
  assert.match(r.expr, /\.struct\("/);
  assert.match(r.expr, /^n\("<\[0,2,4\] \[0,3,5\] \[-1,1,4\] \[-1,2,4\]>"\)/);
});

test('chord symbols: parts voiced exactly like the engine voices them become chord().voicing()', () => {
  const code = 'chord("<Cm Fm Ab Bb>").voicing()';
  const evs = queryEvents(evaluate(code), 0, 4);
  assert.ok(evs.length >= 12);
  const notes = evs.map((e) => N(e.value.note, e.begin * 4, (e.end - e.begin) * 4, 0.8));
  const r = renderPart(notes, 16, { kind: 'melodic', bpb: 4, key: KEY, spell });
  assert.ok(r.verified);
  assert.equal(r.form, 'chords');
  assert.match(r.expr, /^chord\("<C(m|-) F(m|-) Ab Bb>"\)\.voicing\(\)$/);
});

test('euclid, repetition and <> collapsing in the mini-notation writer', () => {
  const cells = bjork(3, 8).map((x) => (x ? 'bd' : '~'));
  assert.equal(euclidOf(cells), 'bd(3,8)');
  assert.equal(compactSteps(cells), 'bd(3,8)');
  assert.equal(compactSteps(bjork(5, 16).map((x) => (x ? 'hh' : '~'))), 'hh(5,16)');
  assert.equal(compactSteps(['hh', 'hh', 'hh', 'hh', 'hh', 'hh', 'hh', 'hh']), 'hh*8');
  assert.equal(compactSteps(['~', 'cp', '~', 'cp']), '[~ cp]*2');
  const seg = (text) => ({ text, w: 1 });
  assert.equal(alternation(['a', 'a', 'a', 'b'].map(seg)), '<a!3 b>');
  assert.equal(alternation(['a', 'b', 'a', 'b'].map(seg)), '<a b>');
  // a 4-bar phrase three times, then a varied ending: column form
  const bars = [];
  for (let k = 0; k < 4; k++) bars.push('a', 'b', 'c', k === 3 ? 'e' : 'd');
  assert.equal(barsText(bars.map(seg)), '<a b c <d!3 e>>');
  // nested alternations never collapse to a shorter period (they advance once per selection)
  assert.equal(alternation(['<x y>', 'b', '<x y>', 'b'].map(seg)), '<<x y> b <x y> b>');
  // and the column form plays exactly the bar list
  const mini = barsText(bars.map((b, i) => seg(`${b}${i}`.replace(/\d+$/, ''))));
  const vals = queryEvents(evaluate(`s("${mini}")`), 0, 16).map((e) => e.value.s);
  assert.deepEqual(vals, bars);
  // drums: one voice per line of the kit, fills as <…!7 fill>
  const dr = [];
  for (let b = 0; b < 8; b++) {
    for (let i = 0; i < 4; i++) dr.push(N(36, b * 4 + i, 0.25, 0.8));
    for (const t of [1, 3]) dr.push(N(39, b * 4 + t, 0.25, 0.8));
    if (b === 7) for (const t of [3, 3.25, 3.5, 3.75]) dr.push(N(38, b * 4 + t, 0.25, 0.8));
  }
  const d = renderPart(dr, 32, { kind: 'drums', bpb: 4 });
  assert.ok(d.verified);
  // (voices in kit order: kick, snare, clap, hats…)
  assert.equal(d.expr, 's("bd*4, <~!7 [~ ~ ~ sd*4]>, [~ cp]*2")');
});

test('velocities: coarsest faithful pattern (constant, accents, per-bar), within ±0.1 of every note', () => {
  const hats = Array.from({ length: 32 }, (_, i) => ({ t: i * 0.5, vel: i % 2 ? 0.45 + (i % 3) * 0.02 : 0.8 - (i % 5) * 0.01 }));
  assert.equal(velocityModel(hats, 16, 4), '[.8 .45]*4');
  assert.equal(velocityModel(hats.map((h) => ({ ...h, vel: 0.62 })), 16, 4), 0.6);
  assert.equal(velocityModel(hats.map((h) => ({ ...h, vel: 0.84 })), 16, 4), null);
});

test('humanized timing: swing is detected and written as .swingBy(); micro-timing is not printed', () => {
  // 8th-note hats swung to 0.6 of the beat, pushed a few ms late
  const notes = [];
  for (let b = 0; b < 16; b++) for (const x of [0, 0.5]) notes.push(N(42, b + (x ? 0.6 : 0) + ((b * 7) % 3) * 0.008, 0.1, 0.7));
  const g = detectSwing(notes, null);
  assert.equal(g.h, 1);
  assert.ok(Math.abs(g.d - 0.1) < 0.011, `d ${g.d}`);
  const q = quantizePart(notes, 16, { groove: g });
  assert.deepEqual([...new Set(q.map((n) => n.start % 1))].sort(), [0, 0.5]);
  const r = renderPart(notes, 16, { kind: 'drums', bpb: 4, groove: g });
  assert.match(r.expr, /^s\("hh\*8"\)/);
});

test('verifyExpr checks onsets, pitches, durations and velocities through the engine', () => {
  const target = quantizePart([N(60, 0, 1), N(63, 1, 1), N(67, 2, 2)], 4);
  assert.ok(verifyExpr('note("c4 eb4 g4@2")', target, { cycles: 1, bpb: 4, kind: 'melodic' }));
  assert.ok(!verifyExpr('note("c4 e4 g4@2")', target, { cycles: 1, bpb: 4, kind: 'melodic' }));
  assert.ok(!verifyExpr('note("c4 eb4 g4 ~")', target, { cycles: 1, bpb: 4, kind: 'melodic' }));
  assert.ok(!verifyExpr('note("c4 eb4 g4@2").velocity(.3)', target, { cycles: 1, bpb: 4, kind: 'melodic' }));
});

// ------------------------------------------------------------------------------ whole songs

test('the whole arrangement is written (song AND pattern mode), sections as consts, one arrange() per track', () => {
  const p = song('trance', 3);
  for (const mode of ['song', 'pattern']) {
    const { code, mode: m, sections } = songToCode({ ...p, mode });
    assert.equal(m, 'song');
    assert.ok(sections.length >= 8);
    for (const s of p.markers) assert.ok(code.includes(`// —— ${s.name} ·`), `marker ${s.name}`);
    const { blocks } = songToCode({ ...p, mode });
    assert.equal(blocks.filter((b) => b.kind === 'instrument').length, p.tracks.filter((t) => t.type === 'instrument').length);
    for (const b of blocks.filter((x) => x.kind === 'instrument')) assert.match(code, new RegExp(`^_?${b.label}: arrange\\(`, 'm'));
    assert.match(code, /^const \w+_drums\s+= /m);
    assert.match(code, /\.scale\("[A-G]b?\d:/);
    assert.equal(evaluate(code).error, null);
    // every line is readable: no line longer than ~100 characters except inside long alternations
    const long = code.split('\n').filter((l) => l.length > 120);
    assert.ok(long.length <= 3, `long lines: ${long.length}`);
  }
  // a pattern-mode project without clips is a loop
  const loop = songToCode({ ...p, clips: [], mode: 'pattern' });
  assert.equal(loop.mode, 'pattern');
  assert.ok(!/arrange\(/.test(loop.code));
  assert.ok(!hasArrangement({ ...p, clips: [] }));
});

test('faithfulness: every genre × 2 seeds plays >= 95% of the song\'s notes (whole song, after quantization)', () => {
  let all = 0, good = 0;
  const worst = [];
  for (const genre of Object.keys(GENRES)) {
    for (const seed of [7, 21]) {
      const p = song(genre, seed, { swing: 0 });
      const { code, labels } = songToCode(p);
      const f = songFaith(p, code, labels);
      assert.ok(f.total > 0, `${genre} ${seed}: no notes`);
      const ratio = f.ok / f.total;
      worst.push([ratio, `${genre}/${seed}`]);
      assert.ok(ratio >= 0.95, `${genre} ${seed}: only ${f.ok}/${f.total} notes match`);
      all += f.total; good += f.ok;
    }
  }
  worst.sort((a, b) => a[0] - b[0]);
  assert.ok(good / all >= 0.98, `overall ${good}/${all}`);
  console.log(`# faithfulness: ${(100 * good / all).toFixed(2)}% of ${all} notes; lowest ${worst.slice(0, 3).map(([r, n]) => `${n} ${(100 * r).toFixed(1)}%`).join(', ')}`);
});

// chars per bar of the previous writer (per-track consts of note()/s() literals, snapped to a 1/24 grid), seed 1
const BEFORE = { trance: 198, 'lofi-hip-hop': 703, jazz: 399, blues: 730, house: 313, techno: 359, pop: 315, trap: 277, funk: 568, reggae: 383 };

test('compactness: chars per bar of music vs the previous writer (10 genres)', () => {
  const rows = [];
  let before = 0, after = 0;
  for (const [genre, b] of Object.entries(BEFORE)) {
    const p = song(genre, 1);
    const { code } = songToCode(p);
    const cpb = code.length / barsOf(p);
    rows.push(`${genre.padEnd(14)} ${String(b).padStart(4)} -> ${cpb.toFixed(0).padStart(4)} chars/bar (${code.split('\n').length} lines)`);
    // trap: per-bar hi-hat rolls with per-note accents are genuinely different every bar (the anti-monotony generator)
    // and can't be compressed further without losing notes / velocities, so its bound is looser
    const limit = genre === 'trap' ? 0.7 : 0.6;
    assert.ok(cpb <= b * limit, `${genre}: ${cpb.toFixed(0)} chars/bar (before ${b})`);
    before += b; after += cpb;
  }
  assert.ok(after / before <= 0.45, `overall ${after.toFixed(0)} vs ${before}`);
  console.log(`# compactness (before -> after):\n# ${rows.join('\n# ')}`);
  // a ~7 minute trance song (256 bars, every section varied by the generator) fits a handful of screens: < 2 lines/bar
  const t = songToCode(song('trance', 1)).code.split('\n').length;
  assert.ok(t <= 512, `trance: ${t} lines`);
});

test('export: Menu ▸ Export ▸ Strudel code writes the whole arrangement, playable on strudel.cc', () => {
  const p = { ...song('house', 2), mode: 'pattern' };
  const code = patternsToCode(p);
  assert.match(code, /^\/\/ Exported from daW³/m);
  assert.match(code, /arrange\(/);
  assert.match(code, /\.bank\("RolandTR909"\)/);
  assert.ok(!/\.s\("(saw-bass|warm-pad|supersaw-lead)"\)/.test(code), 'DAW preset names are mapped to Strudel sounds');
  const labels = {};
  for (const t of p.tracks) labels[t.name.toLowerCase()] = t.id;
  const f = songFaith(p, code, labels);
  assert.ok(f.ok / f.total >= 0.95, `${f.ok}/${f.total}`);
  // one track only
  const one = patternsToCode(p, { trackIds: [p.tracks[1].id] });
  assert.match(one, new RegExp(`^${p.tracks[1].name.toLowerCase()}: arrange\\(`, 'm'));
  assert.ok(!/^drums: /m.test(one));
});

// ------------------------------------------------------------------------------ apply back

test('apply-back: unchanged code keeps every humanized note; a section edit rewrites only that pattern', () => {
  const p = song('lofi-hip-hop', 4);
  const { code, blocks } = songToCode(p);
  const q = clone(p);
  const r = applySongCode(q, code);
  assert.equal(r.error, null);
  assert.equal(r.changed, false, r.changes.join('; '));
  assert.equal(JSON.stringify(q), JSON.stringify(p));
  // edit one bass section
  const bass = blocks.find((b) => b.kind === 'instrument' && b.name === 'Bass');
  const [cname, meta] = Object.entries(bass.consts)[0];
  const d = splitTopLevel(code).find((it) => it.kind === 'decl' && it.name === cname);
  const edited = code.slice(0, d.start) + `const ${cname} = n("<0 ~ 0 4>*2").scale("G1:major")` + code.slice(d.end);
  const q2 = clone(p);
  const r2 = applySongCode(q2, edited);
  assert.equal(r2.error, null);
  for (const { id, transpose } of meta.patterns) {
    const pat = q2.patterns[id];
    assert.ok(pat.notes.length > 0 && pat.notes.every((n) => [31 + transpose, 38 + transpose].includes(n.pitch)), 'edited pattern'); // G1, D2
  }
  const untouched = Object.keys(p.patterns).filter((id) => !meta.patterns.some((x) => x.id === id));
  for (const id of untouched) assert.deepEqual(q2.patterns[id], p.patterns[id], 'other patterns keep their humanized notes');
});

test('apply-back: arrangement edits (order, lengths, transposition, new patterns) rebuild the clips', () => {
  const p = song('pop', 5);
  const { code, blocks } = songToCode(p);
  const lead = blocks.find((b) => b.kind === 'instrument' && b.name === 'Lead');
  const it = splitTopLevel(code).find((x) => x.kind === 'label' && x.name === lead.label);
  const orig = parseArrange(code.slice(it.start, it.end));
  assert.ok(orig && orig.length >= 3);
  const used = orig.filter((e) => e.ref !== 'silence');
  const a = used[0].ref;
  const b2 = used[used.length - 1].ref;
  const newArr = `${lead.label}: arrange([8, ${b2}], [4, silence], [8, ${a}.transpose(2)], [4, hook])`;
  const tail = code.slice(it.start, it.end).replace(/^[\s\S]*?\)(?=\.s\()/, '');
  const edited = code.slice(0, it.start) + 'const hook = n("0 2 4 7").scale("C5:major")\n' + newArr + tail + code.slice(it.end);
  const q = clone(p);
  const r = applySongCode(q, edited);
  assert.equal(r.error, null, r.error);
  assert.ok(r.changes.some((c) => /Lead: arrangement — 3 clips, 24 bars/.test(c)), r.changes.join('; ') + r.warnings.join('; '));
  const t = q.tracks.find((x) => x.name === 'Lead');
  const clips = q.clips.filter((c) => c.trackId === t.id).sort((x, y) => x.start - y.start);
  assert.deepEqual(clips.map((c) => [c.start, c.length]), [[0, 32], [48, 32], [80, 16]]);
  // the transposed reference is a transposed copy of the section's pattern
  const src = q.patterns[lead.consts[a].patterns[0].id];
  const tr = q.patterns[clips[1].patternId];
  assert.deepEqual(tr.notes.map((n) => n.pitch), src.notes.map((n) => n.pitch + 2));
  // degrees 0 2 4 7 of C5 major: C5 E5 G5 C6 (the new pattern loops over its clip)
  assert.deepEqual(q.patterns[clips[2].patternId].notes.map((n) => n.pitch).slice(0, 4), [72, 76, 79, 84]);
  // other tracks' clips are untouched; regenerated code reflects the new arrangement and re-applies as a no-op
  assert.deepEqual(q.clips.filter((c) => c.trackId !== t.id), p.clips.filter((c) => c.trackId !== t.id));
  const again = songToCode(q).code;
  // (a long arrange() wraps over lines)
  assert.match(again.replace(/arrange\(\n\s+/g, 'arrange(').replace(/\],\n\s+\[/g, '], ['), new RegExp(`^${lead.label}: arrange\\(\\[8, \\w+\\], \\[4, silence\\], \\[8, \\w+(\\.transpose\\(2\\))?\\], \\[4, \\w+\\]`, 'm'));
  const q3 = clone(q);
  assert.equal(applySongCode(q3, again).changed, false);
});
