// Objective harmony quality: generated songs must "sound right" — bass on chord tones, melodies/arps/pads
// consonant with the chord sounding under them, clean chord voicings, no chords smeared into each other.
// See tests/lib/harmony-check.js for the rules and the explicit genre exceptions (blues, jazz, metal, gospel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import * as T from '../src/theory/index.js';
import { createRng } from '../src/core/util.js';
import { createProject } from '../src/core/model.js';
import { analyzeSong, ratio, chordInfo, genreExceptions, classify } from './lib/harmony-check.js';

const SEEDS = [1, 2, 3, 7, 11];
const pct = (x) => `${(100 * ratio(x)).toFixed(1)}% (${x.ok}/${x.total})`;

test('harmony quality: every genre × several seeds', () => {
  let clashes = 0, notes = 0, sustained = 0;
  for (const genre of Object.keys(G.GENRES)) {
    const agg = { bass: { ok: 0, total: 0 }, notes: { ok: 0, total: 0 }, voicing: { ok: 0, total: 0 }, overlap: { ok: 0, total: 0 } };
    const issues = [];
    for (const seed of SEEDS) {
      const s = G.generateSong({ genre, seed, withHarmony: true });
      assert.ok(s.harmony?.length && s.harmonyLength > 0, `${genre}: harmony exported`);
      const r = analyzeSong(s);
      for (const k of Object.keys(agg)) { agg[k].ok += r[k].ok; agg[k].total += r[k].total; }
      clashes += r.notes.clash; sustained += r.notes.clashSustained; notes += r.notes.total;
      assert.ok(r.voicing.maxNotes <= 6, `${genre} s${seed}: ${r.voicing.maxNotes}-note chord`);
      if (r.register.leadMedian != null && r.register.padMedian != null) {
        assert.ok(r.register.leadMedian > r.register.padMedian, `${genre} s${seed}: lead (${r.register.leadMedian}) above pad (${r.register.padMedian})`);
      }
      issues.push(...r.issues.slice(0, 3).map((i) => `s${seed} ${i}`));
    }
    const why = `\n  ${issues.slice(0, 8).join('\n  ')}`;
    // (a) bass on strong beats / chord starts is a chord tone (or the slash bass)
    assert.ok(ratio(agg.bass) >= 0.9, `${genre}: bass chord tones ${pct(agg.bass)}${why}`);
    // (b) everything sounding with a chord is a chord tone or an available tension
    assert.ok(ratio(agg.notes) >= 0.95, `${genre}: consonant notes ${pct(agg.notes)}${why}`);
    // (c) clean voicings: <= 6 notes, no m2 below C4, no M2 below G3, no 3rds below D3, no major+minor 3rd
    assert.equal(ratio(agg.voicing), 1, `${genre}: clean voicings ${pct(agg.voicing)}${why}`);
    // (d) consecutive chords never overlap (except held common tones / deliberate anticipations)
    assert.equal(ratio(agg.overlap), 1, `${genre}: chord overlap ${pct(agg.overlap)}${why}`);
  }
  assert.equal(sustained, 0, 'no sustained (>= 1/2 beat) b9 / third clashes anywhere');
  assert.ok(clashes / notes < 0.002, `clash rate ${clashes}/${notes}`);
});

test('harmony quality: exotic project scales follow the chords (harmonic minor, bebop, blues, pentatonic)', () => {
  for (const [genre, scale] of [['trap', 'harmonic-minor'], ['jazz', 'bebop-dominant'], ['pop', 'minor'], ['blues', 'blues'],
    ['ambient', 'major-pentatonic'], ['metal', 'phrygian-dominant'], ['cinematic', 'harmonic-minor'], ['jazz', 'melodic-minor']]) {
    for (const seed of [4, 5, 6]) {
      const s = G.generateSong({ genre, scale, seed, withHarmony: true });
      const r = analyzeSong(s);
      assert.ok(ratio(r.notes) >= 0.97, `${genre}/${scale} s${seed}: ${pct(r.notes)}\n  ${r.issues.slice(0, 6).join('\n  ')}`);
      assert.equal(r.notes.clashSustained, 0, `${genre}/${scale} s${seed}: sustained clashes`);
      assert.ok(ratio(r.bass) >= 0.9, `${genre}/${scale} s${seed}: bass ${pct(r.bass)}`);
    }
  }
});

test('generatePartNotes follows the existing chord track exactly', () => {
  for (const [genre, seed] of [['pop', 3], ['lofi-hip-hop', 11], ['house', 2], ['neo-soul', 5], ['trap', 8]]) {
    const song = G.generateSong({ genre, seed });
    const project = { ...createProject(), ...song };
    const found = G.progressionFromProject(project);
    assert.ok(found?.progression?.length, `${genre}: chords detected`);
    // the keys part's inversions are not slash chords for the bass player
    assert.ok(found.progression.every((c) => c.chord.bass == null), `${genre}: no phantom slash basses`);
    const bars = 4;
    const harmony = [];
    const srcLen = Math.max(found.pattern.length || 0, found.progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0));
    for (let off = 0; off < bars * 4; off += srcLen) {
      for (const c of found.progression) if (off + c.startBeat < bars * 4) harmony.push({ startBeat: off + c.startBeat, durBeats: Math.min(c.durBeats, bars * 4 - off - c.startBeat), root: c.chord.root, type: c.chord.type, name: c.chord.name });
    }
    const tracks = [], patterns = {};
    for (const role of ['bass', 'pad', 'lead', 'arp']) {
      const notes = G.generatePartNotes(role, { genre, key: project.key.root, scale: project.key.scale, bars, beatsPerBar: 4, rng: createRng(seed), project });
      tracks.push({ id: role, role });
      patterns[role] = { id: role, trackId: role, name: role, length: bars * 4, notes };
    }
    const r = analyzeSong({ genre, key: project.key, timeSig: [4, 4], harmony, harmonyLength: bars * 4, tracks, patterns });
    assert.ok(ratio(r.bass) >= 0.9, `${genre}: part bass ${pct(r.bass)}\n  ${r.issues.join('\n  ')}`);
    assert.ok(ratio(r.notes) >= 0.95, `${genre}: part notes ${pct(r.notes)}\n  ${r.issues.join('\n  ')}`);
    assert.equal(r.notes.clashSustained, 0, `${genre}: part sustained clashes`);
  }
});

test('progressionToNotes: every rhythm style keeps chords apart and voicings clean', () => {
  for (const [genre, prog, scale] of [['neo-soul', 'neo-soul-251', 'major'], ['jazz', 'jazz-blues', 'major'], ['gospel', 'gospel-walk', 'major'], ['house', 'deep-house-9', 'minor']]) {
    const progression = G.generateProgression({ key: 3, scale, genre, progression: prog, bars: 8, rng: createRng(3) });
    for (const style of ['whole', ...Object.keys(G.CHORD_RHYTHMS)]) {
      const notes = G.progressionToNotes(progression, { style, rng: createRng(5) });
      const harmony = progression.map((c) => ({ startBeat: c.startBeat, durBeats: c.durBeats, root: c.chord.root, type: c.chord.type, name: c.chord.name }));
      const len = progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
      const r = analyzeSong({ genre: style === 'gospel' ? 'gospel' : genre, key: { root: 3, scale }, timeSig: [4, 4], harmony, harmonyLength: len, tracks: [{ id: 'c', role: 'chords' }], patterns: { c: { id: 'c', trackId: 'c', name: style, length: len, notes } } });
      assert.equal(ratio(r.voicing), 1, `${prog}/${style}: voicing\n  ${r.issues.join('\n  ')}`);
      assert.equal(ratio(r.overlap), 1, `${prog}/${style}: overlap\n  ${r.issues.join('\n  ')}`);
      assert.ok(ratio(r.notes) >= 0.98, `${prog}/${style}: chord tones ${pct(r.notes)}`);
    }
  }
});

test('arp follows the chord sounding at each step; melody phrases end on chord tones', () => {
  const progression = G.generateProgression({ key: 7, scale: 'minor', progression: 'trip-hop-noir', bars: 4, rng: createRng(1) });
  const arp = G.arpeggiate(progression, { mode: 'updown', rate: 0.375, octaves: 2, gate: 0.9, rng: createRng(1) });
  for (const n of arp) {
    const c = progression.find((x) => n.start >= x.startBeat - 1e-9 && n.start < x.startBeat + x.durBeats);
    assert.ok(T.chordPitchClasses(c.chord.root, c.chord.type).includes(n.pitch % 12), `arp ${n.pitch} @${n.start} in ${c.chord.name}`);
    assert.ok(n.start + n.dur <= c.startBeat + c.durBeats + 1e-6, `arp step @${n.start} rings into the next chord`);
  }
  for (const style of Object.keys(G.MELODY_STYLES)) {
    if (style === 'riff' || style === 'ambient') continue;
    for (const seed of [1, 2, 3]) {
      const m = G.generateMelody({ progression, key: 7, scale: 'harmonic-minor', style, rng: createRng(seed), length: 16 });
      const last = m[m.length - 1];
      const c = progression.find((x) => last.start >= x.startBeat && last.start < x.startBeat + x.durBeats);
      assert.ok(T.chordPitchClasses(c.chord.root, c.chord.type).includes(last.pitch % 12), `${style} s${seed}: ends on a chord tone of ${c.chord.name}`);
    }
  }
});

test('theory: chord-scales, key-aware colouring and voicing limits', () => {
  // F#m(maj7) in F# minor: the key's E contradicts the chord's E# and is gone; D (b13) is an avoid note
  const cs = T.chordScale({ root: 6, type: 'mMaj7' }, 6, 'minor');
  assert.ok(!cs.pool.includes(4) && cs.tones.includes(5) && cs.avoid.includes(2));
  // the 4th over a major chord is an avoid note, the 9th / 13th are tensions
  const cMaj = T.chordScale({ root: 0, type: 'maj' }, 0, 'major');
  assert.ok(cMaj.avoid.includes(5) && cMaj.tensions.includes(2) && cMaj.tensions.includes(9));
  // A major (bIII) in F# harmonic minor: E natural is a chord tone, the scale's E# is not available
  const bIII = T.chordScale({ root: 9, type: 'maj' }, 6, 'harmonic-minor');
  assert.ok(bIII.tones.includes(4) && !bIII.pool.includes(5));
  assert.equal(T.fitToChord(65, bIII), 64);
  // key-aware colours: iii in major never becomes m9 (F# against C major); IV in dorian is a dominant 7/9, not maj7;
  // minor chords never get a major 3rd
  for (let seed = 1; seed < 30; seed++) {
    const rng = createRng(seed);
    const iii = G.colorChord({ ...T.romanToChord('iii', 0, 'major') }, 'neo-soul', rng, { key: { root: 0, scale: 'major' } });
    assert.ok(['m7', 'min'].includes(iii.type), `iii -> ${iii.type}`);
    const iv = G.colorChord({ ...T.romanToChord('IV', 2, 'dorian') }, 'lofi', rng, { key: { root: 2, scale: 'dorian' } });
    assert.ok(['7', '9', '13'].includes(iv.type), `dorian IV -> ${iv.type}`);
    const i = G.colorChord({ ...T.romanToChord('i', 9, 'harmonic-minor') }, 'gospel', rng, { key: { root: 9, scale: 'harmonic-minor' } });
    assert.ok(!T.CHORD_TYPES[i.type].intervals.includes(4), `minor i -> ${i.type}`);
    const v = G.colorChord({ ...T.romanToChord('V', 9, 'minor'), function: 'dominant' }, 'neo-soul', rng, { key: { root: 9, scale: 'minor' } });
    assert.equal(v.type, '7', 'V in minor: no b9 slipped in as a "9"');
  }
  // voicings: max voices, low-interval limits, no minor 9ths between voices
  for (const type of Object.keys(T.CHORD_TYPES)) {
    if (type === '5') continue;
    for (let root = 0; root < 12; root++) {
      const v = T.voiceChord({ root, type }, { range: [48, 76], maxVoices: 5 });
      assert.ok(v.length >= 2 && v.length <= 5, `${type} ${v}`);
      assert.equal(T.voicingProblem(v, { allowMinor9: T.CHORD_TYPES[type].intervals.includes(13) }), null, `${root} ${type}: ${v}`);
      const pcs = v.map((n) => n % 12);
      const iv = T.CHORD_TYPES[type].intervals.map((x) => x % 12);
      if (iv.includes(3) || iv.includes(4)) assert.ok(pcs.includes((root + (iv.includes(4) ? 4 : 3)) % 12), `${type}: keeps the 3rd`);
    }
  }
  // stamped low chords get cleaned up
  const low = T.cleanVoicing(T.chordNotes(40, 'm9'));
  assert.equal(T.voicingProblem(low, { allowMinor9: true }), null, `${low}`);
  assert.equal(low[0], 40, 'clicked root kept');
});

test('UI insertion helpers produce clean voicings in the key around C3–C5', () => {
  // Chords menu / browser progressions / assistant panel all go through voiceChord / voiceLead
  for (const [root, scale] of [[0, 'major'], [6, 'minor'], [10, 'dorian'], [4, 'harmonic-minor']]) {
    let prev = [];
    for (const c of T.diatonicChords(root, scale, { sevenths: true })) {
      const v = T.voiceChord(c, { prev, range: [52, 76], maxVoices: 5 });
      assert.equal(T.voicingProblem(v), null, `${c.name}: ${v}`);
      assert.ok(v.every((n) => n >= 48 && n <= 79), `${c.name} register ${v}`);
      assert.ok(v.every((n) => c.notes.includes(n % 12)), `${c.name} tones`);
      prev = v;
    }
    for (const pid of ['ii-v-i', 'neo-soul-251', 'aeolian-loop', 'just-the-two']) {
      let p = [];
      for (const pc of T.progressionChords(pid, root, scale)) {
        const v = T.voiceChord(pc.chord, { prev: p, range: [52, 76], maxVoices: 5 });
        assert.equal(T.voicingProblem(v, { allowMinor9: true }), null, `${pid} ${pc.chord.name}: ${v}`);
        if (p.length) assert.ok(v.reduce((s, n) => s + Math.min(...p.map((q) => Math.abs(q - n))), 0) <= 12, `${pid}: smooth into ${pc.chord.name} ${p} -> ${v}`);
        p = v;
      }
    }
  }
  // assistant add-chord action
  const song = { ...createProject(), ...G.generateSong({ genre: 'lofi-hip-hop', seed: 11 }) };
  const recs = G.getRecommendations(song, {});
  const add = recs.filter((r) => r.action?.kind === 'add-chord');
  for (const r of add) assert.equal(T.voicingProblem(r.action.payload.notes, { allowMinor9: true }), null, `${r.title}: ${r.action.payload.notes}`);
});

test('harmony checker itself flags the classic mistakes', () => {
  const ex = genreExceptions('pop');
  const keyPcs = new Set(T.scalePitchClasses(0, 'major'));
  const C = chordInfo({ root: 0, type: 'maj' });
  assert.equal(classify(5, C, keyPcs, ex), 'clash', 'held 4th over a major 3rd');
  assert.equal(classify(3, C, keyPcs, ex), 'clash', 'minor 3rd over a major chord');
  assert.equal(classify(3, C, keyPcs, genreExceptions('blues')), 'tension', 'blue note in blues');
  assert.equal(classify(2, C, keyPcs, ex), 'tension');
  const G7 = chordInfo({ root: 7, type: '7' });
  assert.equal(classify(8, G7, keyPcs, ex), 'clash', 'b9 on V7 outside jazz');
  assert.equal(classify(8, G7, keyPcs, genreExceptions('jazz')), 'tension', 'altered V7 in jazz');
  const Fm = chordInfo({ root: 6, type: 'mMaj7' });
  assert.equal(classify(4, Fm, new Set(T.scalePitchClasses(6, 'minor')), ex), 'clash', 'E against E# (cross relation)');
});
