// Regression tests for bugs found during QA passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePartNotes, generateSong } from '../src/gen/song.js';
import { generateProgression, pickGenreProgression } from '../src/gen/harmony.js';
import { codeToPatterns } from '../src/code/convert.js';
import { createRng } from '../src/core/util.js';
import { scalePitchClasses, chordPitchClasses } from '../src/theory/index.js';

test('a generated one-bar drum loop has no fill (toms) in it', () => {
  for (const genre of ['pop', 'rock', 'funk', 'house']) {
    for (let seed = 1; seed <= 6; seed++) {
      const notes = generatePartNotes('drums', { genre, root: 0, scale: 'minor', bars: 1, beatsPerBar: 4, rng: createRng(seed) });
      const toms = notes.filter((n) => [41, 43, 45, 47, 48, 50].includes(n.pitch));
      assert.equal(toms.length, 0, `${genre} seed ${seed}: one-bar loop contains a tom fill`);
    }
  }
});

test('progressions are only picked when their plain chords fit a modal scale', () => {
  // 'IVmaj7' read in Lydian became #IVmaj7 (C#maj7 in G lydian) — chromatic garbage.
  for (let seed = 0; seed < 30; seed++) {
    const prog = generateProgression({ key: 7, scale: 'lydian', genre: 'ambient', bars: 4, rng: createRng(seed) });
    const set = new Set(scalePitchClasses(7, 'lydian'));
    for (const c of prog) {
      if (/^[b#]|\//.test(c.roman)) continue;
      const triad = chordPitchClasses(c.chord.root, c.chord.type).slice(0, 3);
      assert.ok(triad.every((pc) => set.has(pc)), `seed ${seed}: ${c.roman} (${c.chord.name}) not diatonic to G lydian`);
    }
  }
  // the Dorian vamp (i7–IV7) is not natural minor
  for (let seed = 0; seed < 30; seed++) {
    const p = pickGenreProgression({ genre: 'house', scale: 'minor', rng: createRng(seed) });
    assert.notEqual(p?.romans.join(' '), 'i7 IV7');
  }
});

test('generated song pattern names are unique per track', () => {
  for (const genre of ['lofi-hip-hop', 'house', 'jazz', 'rock']) {
    const s = generateSong({ genre, seed: 4 });
    for (const t of s.tracks) {
      const names = Object.values(s.patterns).filter((p) => p.trackId === t.id).map((p) => p.name);
      assert.equal(new Set(names).size, names.length, `${genre}/${t.name}: duplicate pattern names ${names}`);
    }
  }
});

test('codeToPatterns names parts after the pattern only (callers add the sound)', () => {
  const parts = codeToPatterns('$: stack(s("bd sd"), note("c3 e3").s("square"))', { cycles: 1 });
  assert.equal(parts.length, 2);
  for (const p of parts) assert.equal(p.name, 'Pattern 1');
});
