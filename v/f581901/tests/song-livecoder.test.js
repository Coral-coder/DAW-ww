// Live-coder song code (src/code/livecoder.js): every generated song as a short Strudel sketch — one idea per
// part, chord symbols + voicing(), one arrange() — evaluated by the REAL Strudel engine; intent from genMeta
// (form, layers, harmony); applying an edit re-renders exactly the edited part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStrudel, codeEngine, evaluate, queryEvents } from '../src/code/strudel.js';
import { songToLiveCode, applyLiveCode, liveArrangement, cycleMini } from '../src/code/livecoder.js';
import { songToCode } from '../src/code/song-code.js';
import { patternsToCode } from '../src/code/convert.js';
import { STRUDEL_CHORD, barChordTokens, cycleOf } from '../src/gen/livemeta.js';
import { generateSong } from '../src/gen/song.js';
import { GENRES } from '../src/gen/genres.js';
import { createProject, beatsPerBar } from '../src/core/model.js';
import { keyPrefersFlats } from '../src/theory/index.js';

if (!(await loadStrudel()) || codeEngine() !== 'strudel') throw new Error('vendored Strudel engine failed to load');

const song = (genre, seed = 1, opts = {}) => ({ ...createProject(), ...generateSong({ genre, seed, ...opts }), mode: 'song' });
const clone = (x) => JSON.parse(JSON.stringify(x));
const MAIN_TRACK = { drums: 'Drums', bass: 'Bass', chords: 'Chords', pad: 'Pad', lead: 'Lead', arp: 'Arp', fx: 'FX' };

test('every genre (2 seeds): ≤ 70 lines, ≤ 4500 chars, short mini-notation, no rest soup, evaluates in real Strudel', () => {
  const report = [];
  for (const genre of Object.keys(GENRES)) {
    for (const seed of [1, 2]) {
      const p = song(genre, seed);
      const { code } = songToLiveCode(p);
      const lines = code.trimEnd().split('\n').length;
      report.push(`${genre}/${seed}: ${lines} lines ${code.length} chars`);
      assert.ok(lines <= 70, `${genre}/${seed}: ${lines} lines\n${code}`);
      assert.ok(code.length <= 4500, `${genre}/${seed}: ${code.length} chars`);
      for (const m of code.matchAll(/"([^"]*)"/g)) assert.ok(m[1].length <= 100, `${genre}/${seed}: mini-notation too long: ${m[1]}`);
      assert.doesNotMatch(code, /~@\d{2}|(~@\d+\s+){3}/, `${genre}/${seed}: rest soup`);
      assert.match(code, /^\$: arrange\($/m, `${genre}/${seed}: one arrange()`);
      assert.equal((code.match(/\$:/g) || []).length, 1);
      const res = evaluate(code);
      assert.equal(res.error, null, `${genre}/${seed}: ${res.error}\n${code}`);
      assert.ok(queryEvents(res, 32, 33).length > 0, `${genre}/${seed}: silent`);
    }
  }
});

test('deep house reads like a live-coder sketch', () => {
  const { code } = songToLiveCode(song('deep-house', 1));
  assert.match(code, /^setcpm\(\d+\/4\)$/m);
  assert.match(code, /chord\([^)]*\)\.voicing\(\)/);
  assert.match(code, /^const drums\s+= /m);
  assert.match(code, /^const bass\s+= n\(".*\.scale\("[A-G][b#]?\d:minor"\)/m);
  assert.match(code, /\.bank\("RolandTR909"\)/);
  assert.match(code, /\.arp\("/);
  assert.match(code, /\/\/ drop/);
  assert.doesNotMatch(code, /\[[a-g][b#]?\d,/, 'no transcribed chord notes');
});

test('chord symbols in the code are the generator\'s harmony', () => {
  for (const genre of ['deep-house', 'pop', 'jazz', 'techno', 'bossa-nova', 'rock']) {
    const p = song(genre, 3, { withHarmony: true });
    const gm = p.genMeta;
    const { code } = songToLiveCode(p);
    // the code writes each harmony cycle of genMeta
    for (const cyc of new Set(gm.sections.map((s) => s.harmony))) assert.ok(code.includes(`"${cycleMini(gm.harmony[cyc])}"`), `${genre}: ${cyc} ${gm.harmony[cyc]}\n${code}`);
    // genMeta's symbols are the chords the Chords part was written against
    const bpb = beatsPerBar(p);
    const flats = keyPrefersFlats(p.key.root, p.key.scale);
    const chordsTrack = p.tracks.find((t) => t.role === 'chords');
    let start = 0;
    for (const s of gm.sections) {
      const clip = p.clips.find((c) => c.trackId === chordsTrack?.id && Math.abs(c.start - start) < 1e-6);
      const ph = clip && p.patternHarmony[clip.patternId];
      if (ph) assert.deepEqual(cycleOf(barChordTokens(ph.harmony, s.bars, bpb, flats, -(s.mod || 0))), gm.harmony[s.harmony], `${genre} ${s.name}`);
      start += s.bars * bpb;
    }
    // and real Strudel voices every one of them
    for (const k of Object.values(gm.harmony).flat()) {
      for (const sym of k.replace(/[[\]]|@\d+/g, '').split(' ')) {
        const r = evaluate(`chord("${sym}").voicing()`);
        assert.ok(queryEvents(r, 0, 1).length >= 2, `${genre}: Strudel can't voice ${sym}`);
      }
    }
  }
  for (const suf of Object.values(STRUDEL_CHORD)) assert.ok(queryEvents(evaluate(`chord("Eb${suf}").voicing()`), 0, 1).length >= 2, `Eb${suf}`);
});

test('each section of the arrange() plays the layers genMeta planned', () => {
  for (const genre of ['deep-house', 'trance', 'pop', 'drum-and-bass', 'lofi-hip-hop']) {
    const p = song(genre, 1);
    const r = songToLiveCode(p);
    const bpb = beatsPerBar(p);
    const roleOfConst = Object.fromEntries(Object.entries(r.roles).map(([c, id]) => {
      const t = p.tracks.find((x) => x.id === id);
      return [c, MAIN_TRACK[t.role] === t.name ? t.role : null];
    }));
    const entries = liveArrangement(r.code);
    // expand merged entries back to genMeta's sections
    let ei = 0, left = entries[0].bars, start = 0;
    for (const s of p.genMeta.sections) {
      const e = entries[ei];
      const inCode = new Set(e.items.map((x) => roleOfConst[/^\w+/.exec(x)[0]]).filter(Boolean));
      const planned = new Set([...s.layers, ...(s.enter || [])].filter((role) => {
        const t = p.tracks.find((x) => x.role === role && x.name === MAIN_TRACK[role]);
        return t && p.clips.some((c) => c.trackId === t.id && c.start < start + s.bars * bpb - 1e-6 && c.start + c.length > start + 1e-6 && p.patterns[c.patternId]?.notes.length);
      }));
      assert.deepEqual([...inCode].sort(), [...planned].sort(), `${genre} ${s.name}`);
      start += s.bars * bpb;
      left -= s.bars;
      if (left <= 0 && ei < entries.length - 1) { ei++; left = entries[ei].bars; }
    }
  }
});

test('apply: unedited code is a no-op; an edit re-renders only the edited part', () => {
  const p = song('deep-house', 1);
  const r = songToLiveCode(p);
  const before = clone(p);
  const rep0 = applyLiveCode(p, r.code, { original: r });
  assert.equal(rep0.changed, false);
  assert.equal(JSON.stringify(p), JSON.stringify(before));

  const notesOf = (proj, id) => JSON.stringify(Object.values(proj.patterns).filter((x) => x.trackId === id).map((x) => x.notes));
  const edited = r.code.replace(/^(const bass\s+= )n\("[^"]*"/m, '$1n("0*8"');
  assert.notEqual(edited, r.code);
  const rep = applyLiveCode(p, edited, { original: r });
  assert.equal(rep.error, undefined);
  assert.deepEqual(rep.tracks, [r.roles.bass]);
  for (const t of p.tracks) {
    if (t.id === r.roles.bass) assert.notEqual(notesOf(p, t.id), notesOf(before, t.id));
    else assert.equal(notesOf(p, t.id), notesOf(before, t.id), `${t.name} must not change`);
  }
  // the bass now plays eighths on every bar where it played before (sections kept), humanised
  const bass = Object.values(p.patterns).filter((x) => x.trackId === r.roles.bass);
  const drop = bass.find((x) => /Drop/.test(x.name));
  assert.ok(drop && drop.notes.length >= 8 * (drop.length / 4) * 0.95, 'eighths in the drop');
  assert.ok(drop.notes.some((n) => Math.abs(n.start * 2 - Math.round(n.start * 2)) > 1e-4), 'groove re-applied');
  assert.ok(p.clips.filter((c) => c.trackId === r.roles.bass).every((c) => p.patterns[c.patternId]));

  // removing a part from one section of the arrangement re-renders that part only
  const r2 = songToLiveCode(p);
  const lines = r2.code.split('\n');
  const i = lines.findIndex((l) => /\/\/ drop$/.test(l));
  const block = lines.slice(i).join('\n');
  const ed2 = lines.slice(0, i).join('\n') + '\n' + block.replace(/\blead, /, '');
  const rep2 = applyLiveCode(p, ed2, { original: r2 });
  assert.deepEqual(rep2.tracks, [r2.roles.lead], rep2.changes.join());
});

test('Exact style stays available: export follows the chosen style', () => {
  const p = song('house', 2);
  assert.equal(patternsToCode(p), songToCode(p, { export: true }).code);
  assert.equal(patternsToCode(p, { style: 'exact' }), songToCode(p, { export: true }).code);
  const live = patternsToCode(p, { style: 'live' });
  assert.equal(live, songToLiveCode(p, { export: true }).code);
  assert.ok(live.length < songToCode(p, { export: true }).code.length / 3);
});

test('projects without genMeta: sections from markers / clips, chords detected', () => {
  const p = song('pop', 4);
  delete p.genMeta;
  delete p.sections;
  const { code } = songToLiveCode(p);
  assert.ok(code.trimEnd().split('\n').length <= 70, code);
  assert.match(code, /chord\(/);
  assert.equal(evaluate(code).error, null, code);
  // pattern mode (no clips): one stack, no arrange
  const q = { ...song('techno', 1), clips: [] };
  const pc = songToLiveCode(q).code;
  assert.match(pc, /^\$: stack\(/m);
  assert.equal(evaluate(pc).error, null, pc);
});
