// Anti-monotony: generated songs must not loop "3 notes, 231 231 231" — every genre (drone genres included) moves
// harmonically, chord / pad parts re-voice, basses answer, arps develop. Measured with monotonyReport (src/gen/monotony.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import { analyzeSong, ratio } from './lib/harmony-check.js';

const SEEDS = [1, 2, 3];

test('monotony: every genre × 3 seeds moves harmonically and in every melodic part', () => {
  const problems = [];
  let total = 0, count = 0;
  for (const genre of Object.keys(G.GENRES)) {
    for (const seed of SEEDS) {
      const t0 = performance.now();
      const s = G.generateSong({ genre, seed, withHarmony: true });
      total += performance.now() - t0; count++;
      const r = G.monotonyReport(s);
      const tag = `${genre} s${seed}`;
      // no one-chord songs (psytrance / techno / minimal included — no genre is exempt)
      if (r.rootCount < 2) problems.push(`${tag}: ${r.rootCount} chord root(s)`);
      for (const p of r.parts) {
        if (p.notes < 8 || p.bars < 2) continue;
        const at = `${tag} ${p.pattern}`;
        if ((p.role === 'chords' || p.role === 'pad') && p.distinct16 < 4) problems.push(`${at}: ${p.distinct16} pitches / 16 bars`);
        if (p.role === 'bass' && p.distinct16 < (G.DRONE_BASS_GENRES.has(genre) ? 2 : 3)) problems.push(`${at}: bass ${p.distinct16} pitches / 16 bars`);
        if (['chords', 'pad', 'arp'].includes(p.role) && p.cellRunBars > 4 + 1e-6) problems.push(`${at}: ≤3-note cell repeats ${p.cellRunBars} bars`);
        if (p.role === 'arp' && p.notes >= 16 && p.entropy < 2.5) problems.push(`${at}: arp entropy ${p.entropy.toFixed(2)}`);
        if (p.role === 'lead' && p.notes >= 16 && p.entropy < 1.5) problems.push(`${at}: lead entropy ${p.entropy.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(problems.slice(0, 20), [], problems.slice(0, 20).join('\n'));
  // < 500 ms per song (averaged: a single song can spike while other test files load the machine)
  assert.ok(total / count < 500, `generation took ${(total / count).toFixed(0)} ms per song`);
});

test('monotony: psytrance is a moving song (the "231 231 231" regression)', () => {
  for (const seed of [1, 2, 3, 4]) {
    const s = G.generateSong({ genre: 'psytrance', seed, withHarmony: true });
    const sec = s.sections.filter((x) => ['build', 'main', 'break'].includes(x.kind));
    // builds / peaks / breaks have chord movement of their own
    for (const x of sec) assert.ok(new Set(x.progression).size >= 2, `s${seed} ${x.name}: ${x.progression.join(' ')}`);
    const r = G.monotonyReport(s);
    const bass = r.parts.filter((p) => p.role === 'bass' && p.bars >= 8);
    assert.ok(bass.every((p) => p.distinct8 >= 3), `s${seed}: rolling bass rides the root but moves (${bass.map((p) => p.distinct8)})`);
    const chordPats = Object.values(s.patterns).filter((p) => s.tracks.find((t) => t.id === p.trackId)?.role === 'chords');
    for (const p of chordPats) {
      // the stab voicing changes from bar to bar somewhere in every 4 bars
      const sig = (b) => [...new Set(p.notes.filter((n) => n.start >= b * 4 && n.start < b * 4 + 4).map((n) => n.pitch))].sort().join();
      for (let b = 0; b + 4 <= p.length / 4; b += 4) assert.ok(new Set([0, 1, 2, 3].map((k) => sig(b + k))).size >= 2, `s${seed} ${p.name} bars ${b + 1}-${b + 4}`);
    }
    assert.ok(ratio(analyzeSong(s).notes) >= 0.95, `s${seed}: still consonant`);
  }
});

test('monotony: band / pop songs change progression between verse, chorus and bridge', () => {
  for (const genre of ['pop', 'funk', 'neo-soul', 'afrobeat', 'rock', 'indie', 'country', 'gospel']) {
    for (const seed of SEEDS) {
      const s = G.generateSong({ genre, seed });
      const prog = (type) => s.sections.find((x) => x.type === type)?.progression.join(' ');
      if (prog('verse') && prog('chorus')) assert.notEqual(prog('verse'), prog('chorus'), `${genre} s${seed}: verse = chorus (${prog('chorus')})`);
      if (prog('bridge')) assert.notEqual(prog('bridge'), prog('chorus'), `${genre} s${seed}: bridge = chorus`);
    }
  }
});

test('monotony: metrics and the guard', () => {
  const N = (pitch, start, dur = 0.25) => ({ pitch, start, dur, vel: 0.8 });
  // one triad stabbed 4× a bar for 8 bars: a 1-token cell for 8 bars, 3 pitches
  const stabs = [];
  for (let i = 0; i < 32; i++) for (const p of [55, 62, 70]) stabs.push(N(p, i, 0.3));
  const st = G.partStats(stabs, { bpb: 4, length: 32, role: 'chords' });
  assert.equal(st.distinct16, 3);
  assert.ok(st.cellRunBars >= 7.5);
  assert.ok(G.isMonotonous(st, 'chords', 'psytrance').length >= 2);
  // the guard re-voices it along inversions (chord tones only)
  const progression = G.generateProgression({ key: 7, scale: 'minor', progression: ['i', 'i'], bars: 8 });
  G.varyPart(stabs, { role: 'chords', genre: 'psytrance', progression, bpb: 4, length: 32 });
  const after = G.partStats(stabs, { bpb: 4, length: 32, role: 'chords' });
  assert.ok(after.distinct16 >= 4 && after.cellRunBars <= 4, JSON.stringify(after));
  assert.ok(stabs.every((n) => [7, 10, 2].includes(n.pitch % 12)));
  // a one-pitch bass gets octave / 5th answers
  const bass = [];
  for (let i = 0; i < 32; i++) bass.push(N(31, i + 0.5, 0.4));
  G.varyPart(bass, { role: 'bass', genre: 'trance', progression, bpb: 4, length: 32 });
  assert.ok(G.partStats(bass, { bpb: 4, length: 32, role: 'bass' }).distinct16 >= 3);
  // entropy: a 2-note toggle is low, a developed line higher
  const toggle = G.partTokens([...Array(32).keys()].map((i) => N(i % 2 ? 67 : 70, i * 0.5)));
  assert.ok(G.ngramEntropy(toggle) <= 1.01);
  const report = G.monotonyReport({ ...G.generateSong({ genre: 'techno', seed: 5, withHarmony: true }) });
  assert.ok(report.rootCount >= 2 && report.parts.length > 0 && report.byRole.bass);
});
