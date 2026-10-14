// Idiomatic leads (src/gen/melody.js writeLead) and producer density (src/gen/orchestra.js): house / trance / pop / dnb /
// r&b hooks are rhythmic cells on the 16th grid, repeated with pitch variation, chord tones on the beats, phrase-end
// cadences; club chord vocabularies keep dominant 7ths for V; drops are full, intros sparse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import { createRng } from '../src/core/util.js';
import { chordPitchClasses, mod12 } from '../src/theory/index.js';
import { LEAD_IDIOMS, makeLeadIdea, writeLead, leadIdiom } from '../src/gen/melody.js';

const GENRE_OF = { house: 'house', deep: 'deep-house', tech: 'tech-house', trance: 'trance', pop: 'pop', dnb: 'liquid-dnb', rnb: 'rnb' };
const near = (x, k) => Math.abs(x * k - Math.round(x * k)) < 1e-6;

test('lead idioms: 16th grid, motif repetition, chord tones on beats, no 3+ repeats, phrase-end cadences', () => {
  const problems = [];
  for (const idiom of Object.keys(LEAD_IDIOMS)) {
    assert.equal(leadIdiom(GENRE_OF[idiom]), idiom);
    for (const seed of [1, 2, 3, 4]) {
      const rng = createRng(seed);
      const progression = G.generateProgression({ key: 0, scale: 'minor', genre: GENRE_OF[idiom], bars: 16, rng });
      const idea = makeLeadIdea({ idiom, rng: createRng(seed * 7), hook: true });
      const notes = writeLead({ progression, key: 0, scale: 'minor', idea, mode: 'hook', length: 64, rng: createRng(seed * 13) });
      const tag = `${idiom} s${seed}`;
      if (notes.length < 24) problems.push(`${tag}: only ${notes.length} notes`);
      // (1) rhythm: every onset on the 16th grid
      const off = notes.filter((n) => !near(n.start, 4));
      if (off.length) problems.push(`${tag}: ${off.length} onsets off the 16th grid`);
      // (2) motif repetition: bar b and bar b+4 share their onset pattern (the cell returns every phrase)
      const sig = (b) => notes.filter((n) => n.start >= b * 4 - 1e-6 && n.start < b * 4 + 4 - 1e-6).map((n) => Math.round((n.start - b * 4) * 4)).join();
      let same = 0, pairs = 0;
      for (let b = 0; b + 4 < 16; b++) { pairs++; if (sig(b) === sig(b + 4)) same++; }
      if (same / pairs < 0.75) problems.push(`${tag}: rhythm repeats in ${same}/${pairs} bar pairs`);
      // (3) no pitch more than three times in a row (idiom writer: at most twice)
      let run = 1, maxRun = 1;
      for (let i = 1; i < notes.length; i++) { run = notes[i].pitch === notes[i - 1].pitch ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
      if (maxRun > 3) problems.push(`${tag}: ${maxRun} same pitches in a row`);
      // (4) strong beats: chord tones
      const chordAt = (t) => progression.find((c) => t >= c.startBeat - 1e-6 && t < c.startBeat + c.durBeats - 1e-6);
      const strong = notes.filter((n) => near(n.start, 1));
      const ct = strong.filter((n) => { const c = chordAt(n.start + 0.01); return chordPitchClasses(c.chord.root, c.chord.type).includes(mod12(n.pitch)); });
      if (strong.length && ct.length / strong.length < 0.85) problems.push(`${tag}: strong-beat chord tones ${ct.length}/${strong.length}`);
      // (5) every 4-bar phrase ends on a chord tone
      for (let p = 0; p < 4; p++) {
        const last = notes.filter((n) => n.start < (p + 1) * 16 - 1e-6 && n.start >= p * 16).pop();
        if (!last) continue;
        const c = chordAt(last.start + 0.01);
        if (!chordPitchClasses(c.chord.root, c.chord.type).includes(mod12(last.pitch))) problems.push(`${tag}: phrase ${p + 1} ends off the chord`);
      }
      // (6) register
      if (notes.some((n) => n.pitch < LEAD_IDIOMS[idiom].range[0] || n.pitch > LEAD_IDIOMS[idiom].range[1])) problems.push(`${tag}: out of range`);
    }
  }
  assert.deepEqual(problems, []);
});

test('lead idioms: house hooks are short syncopated stabs, pop phrases breathe', () => {
  const prog = G.generateProgression({ key: 0, scale: 'minor', genre: 'house', bars: 8, rng: createRng(3) });
  const house = writeLead({ progression: prog, key: 0, scale: 'minor', idea: makeLeadIdea({ idiom: 'house', rng: createRng(5) }), length: 32, rng: createRng(1) });
  const durs = house.map((n) => n.dur).sort((a, b) => a - b);
  assert.ok(durs[Math.floor(durs.length / 2)] <= 0.5, 'median house hook note <= an 8th');
  assert.ok(house.every((n) => n.dur <= 2), 'no note held for most of a bar');
  assert.ok(house.filter((n) => !near(n.start, 1)).length / house.length >= 0.5, 'most hook notes are syncopated (off the beat)');
  const pop = writeLead({ progression: prog, key: 0, scale: 'minor', idea: makeLeadIdea({ idiom: 'pop', rng: createRng(5) }), length: 32, rng: createRng(1) });
  for (let b = 1; b < 8; b += 2) {
    const end = Math.max(...pop.filter((n) => n.start >= b * 4 && n.start < b * 4 + 4).map((n) => n.start + n.dur));
    assert.ok(end <= b * 4 + 4 - 0.4, `pop response bar ${b + 1} leaves a breath`);
  }
});

test('club harmony: dominant 7th chords only on V (no IV7 / bVII7 blues colour in minor house)', () => {
  for (const genre of ['house', 'deep-house', 'tech-house', 'trance']) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = G.generateSong({ genre, seed, key: 0, scale: 'minor', withHarmony: true, production: false });
      for (const h of Object.values(s.patternHarmony)) {
        for (const c of h.harmony) {
          if (['7', '9', '13'].includes(c.type)) assert.equal(mod12(c.root - (h.key?.root ?? 0)), 7, `${genre} s${seed}: ${c.name}`);
        }
      }
    }
  }
});

test('producer density: full drops, sparse intros, layers entering in 8-bar phrases', () => {
  for (const genre of ['house', 'deep-house', 'trance', 'liquid-dnb', 'pop']) {
    const s = G.generateSong({ genre, seed: 2, production: false });
    const melodic = new Set(s.tracks.filter((t) => t.instrument?.type !== 'drums' && t.role !== 'fx' && t.role !== 'sub').map((t) => t.id));
    const layersIn = (sec) => new Set(s.clips.filter((c) => melodic.has(c.trackId) && c.start < sec.start + sec.bars * 4 - 1e-6 && c.start + c.length > sec.start + 1e-6
      && s.patterns[c.patternId]?.notes.length).map((c) => c.trackId)).size;
    const mains = s.sections.filter((x) => x.kind === 'main');
    const intro = s.sections[0];
    assert.ok(Math.max(...mains.map(layersIn)) >= 6, `${genre}: the biggest drop / chorus has >= 6 melodic layers (${mains.map(layersIn)})`);
    assert.ok(layersIn(intro) <= 4, `${genre}: the intro stays sparse (${layersIn(intro)})`);
  }
  // house: the drop's extras don't all start on bar 1 (the second 8-bar phrase adds something)
  const h = G.generateSong({ genre: 'house', seed: 1, production: false });
  const drop = h.sections.find((x) => x.kind === 'main');
  const extras = h.tracks.filter((t) => ['counter', 'organ', 'chop', 'vox'].includes(t.role));
  assert.ok(extras.length >= 3, 'house adds counter / organ / chop / vox layers');
  const firstNote = (t) => {
    const c = h.clips.find((x) => x.trackId === t.id && x.start === drop.start);
    const ns = c ? h.patterns[c.patternId].notes : [];
    return ns.length ? Math.min(...ns.map((n) => n.start)) : Infinity;
  };
  const starts = extras.map(firstNote).filter(Number.isFinite);
  assert.ok(starts.some((x) => x >= 32 - 1e-6), `a layer enters in a later 8-bar phrase (${starts})`);
  assert.ok(starts.some((x) => x < 8), 'and one plays from the downbeat');
});
