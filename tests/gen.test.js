import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import * as T from '../src/theory/index.js';
import { createRng } from '../src/core/util.js';
import { DRUM_PADS, createProject, createTrack, createPattern, createNote, createClip, beatsPerBar } from '../src/core/model.js';

const PAD_PITCHES = new Set(DRUM_PADS.map((p) => p.pitch));
const strip = (notes) => notes.map(({ pitch, start, dur, vel }) => ({ pitch, start, dur, vel }));

function assertNotes(notes, length, label) {
  assert.ok(Array.isArray(notes), label);
  for (const n of notes) {
    assert.ok(n.id, `${label}: note id`);
    assert.ok(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127, `${label}: pitch ${n.pitch}`);
    assert.ok(n.start >= 0 && n.start < length, `${label}: start ${n.start} / ${length}`);
    assert.ok(n.dur > 0 && n.start + n.dur <= length + 1e-6, `${label}: dur ${n.start}+${n.dur} > ${length}`);
    assert.ok(n.vel > 0 && n.vel <= 1, `${label}: vel ${n.vel}`);
  }
}

test('GENRES: 45+ genres with complete, valid definitions', () => {
  const ids = Object.keys(G.GENRES);
  assert.ok(ids.length >= 45, `${ids.length} genres`);
  const required = ['house', 'deep-house', 'tech-house', 'techno', 'minimal', 'trance', 'psytrance', 'progressive-house', 'dubstep', 'brostep',
    'future-bass', 'drum-and-bass', 'liquid-dnb', 'jungle', 'breakbeat', 'uk-garage', 'two-step', 'trap', 'drill', 'boom-bap', 'lofi-hip-hop',
    'phonk', 'rnb', 'neo-soul', 'pop', 'kpop', 'synthwave', 'chillwave', 'ambient', 'downtempo', 'trip-hop', 'idm', 'glitch', 'chiptune', 'rock',
    'punk', 'metal', 'indie', 'funk', 'disco', 'nu-disco', 'jazz', 'bossa-nova', 'blues', 'gospel', 'reggae', 'dub', 'dancehall', 'reggaeton',
    'afrobeat', 'amapiano', 'salsa', 'country', 'folk', 'cinematic', 'industrial', 'hardstyle', 'eurobeat', 'footwork'];
  for (const id of required) assert.ok(G.GENRES[id], `missing genre ${id}`);
  for (const [id, g] of Object.entries(G.GENRES)) {
    assert.equal(g.id, id);
    assert.ok(g.name && g.family, id);
    assert.ok(g.bpm[0] < g.bpm[1] && g.defaultBpm >= g.bpm[0] && g.defaultBpm <= g.bpm[1], `${id} bpm`);
    assert.ok(g.swing >= 0 && g.swing <= 1, id);
    assert.deepEqual(g.timeSig.length, 2);
    for (const s of g.scales) assert.ok(T.SCALES[s], `${id}: scale ${s}`);
    assert.ok(G.DRUM_KIT_IDS.includes(g.drumKit), `${id}: kit ${g.drumKit}`);
    assert.ok(G.DRUM_STYLES[g.drumStyle], `${id}: drum style ${g.drumStyle}`);
    assert.ok(G.BASS_STYLES[g.bassStyle], `${id}: bass style ${g.bassStyle}`);
    assert.ok(g.chordStyle === 'whole' || G.CHORD_RHYTHMS[g.chordStyle], `${id}: chord style ${g.chordStyle}`);
    assert.ok(G.MELODY_STYLES[g.melodyStyle], `${id}: melody style`);
    for (const pid of g.progressions) assert.ok(T.getProgression(pid), `${id}: progression ${pid}`);
    for (const [role, pid] of Object.entries(g.presets)) {
      if (role === 'drums') assert.ok(G.DRUM_KIT_IDS.includes(pid), `${id}: drums preset`);
      else assert.ok(G.ALL_PRESET_IDS.includes(pid), `${id}: preset ${pid}`);
    }
    for (const r of ['bass', 'chords', 'pad', 'lead', 'arp']) assert.ok(g.presets[r], `${id}: preset role ${r}`);
    assert.ok(g.structure.length >= 4, id);
    for (const s of g.structure) {
      assert.ok(s.name && s.bars > 0 && s.energy >= 0 && s.energy <= 1, `${id}: section`);
      for (const r of s.roles) assert.ok(G.ROLES.includes(r), `${id}: role ${r}`);
    }
    assert.ok(g.tips.length >= 2 && g.fx.length >= 1, id);
  }
  assert.equal(G.resolveGenreId('dnb'), 'drum-and-bass');
  assert.equal(G.getGenre('Lo-fi Hip-Hop').id, 'lofi-hip-hop');
});

test('euclidean rhythms', () => {
  const s = (a) => a.map((x) => (x ? 'x' : '.')).join('');
  assert.equal(s(G.euclidean(3, 8)), 'x..x..x.');
  assert.equal(s(G.euclidean(4, 16)), 'x...x...x...x...');
  assert.equal(s(G.euclidean(5, 8)).split('x').length - 1, 5);
  assert.equal(s(G.euclidean(3, 8, 1)), '.x..x..x');
  assert.equal(s(G.euclidean(0, 4)), '....');
});

test('drum patterns: every style yields valid GM pitches within bars', () => {
  for (const id of Object.keys(G.DRUM_STYLES)) {
    for (const fill of [false, true]) {
      const notes = G.generateDrumPattern({ style: id, bars: 2, density: 0.8, variation: 0.5, fill, humanize: 0.3, rng: createRng(3) });
      assert.ok(notes.length > 0, id);
      assertNotes(notes, 8, `drums ${id}`);
      for (const n of notes) assert.ok(PAD_PITCHES.has(n.pitch), `${id}: pitch ${n.pitch}`);
    }
  }
});

test('drum patterns: idioms, density, determinism', () => {
  const house = G.generateDrumPattern({ genre: 'house', bars: 1, density: 1, variation: 0, rng: createRng(1) });
  const kicks = house.filter((n) => n.pitch === 36).map((n) => n.start);
  assert.deepEqual(kicks, [0, 1, 2, 3], 'four on the floor');
  assert.ok(house.some((n) => n.pitch === 39 && n.start === 1), 'clap on 2');
  const trap = G.generateDrumPattern({ genre: 'trap', bars: 4, density: 0.9, variation: 0.8, rng: createRng(9) });
  assert.ok(trap.some((n) => n.pitch === 38 && n.start === 2), 'half-time snare on beat 3');
  assert.ok(trap.some((n) => n.pitch === 42 && n.dur < 0.2), 'hi-hat rolls');
  const dembow = G.generateDrumPattern({ style: 'dembow', bars: 1, variation: 0, rng: createRng(2) });
  assert.deepEqual(dembow.filter((n) => n.pitch === 38).map((n) => n.start), [0.75, 1.5, 2.75, 3.5]);
  const oneDrop = G.generateDrumPattern({ style: 'one-drop', bars: 1, variation: 0, rng: createRng(2) });
  assert.deepEqual(oneDrop.filter((n) => n.pitch === 36).map((n) => n.start), [2], 'one drop kick on 3');
  const metal = G.generateDrumPattern({ style: 'metal', bars: 1, density: 1, variation: 0, rng: createRng(2) });
  assert.ok(metal.filter((n) => n.pitch === 36).length >= 16, 'double kick 16ths');
  const funk = G.generateDrumPattern({ style: 'funk', bars: 2, density: 0.9, rng: createRng(2) });
  assert.ok(funk.some((n) => n.pitch === 38 && n.vel < 0.4), 'ghost notes');
  const jazz = G.generateDrumPattern({ style: 'jazz', bars: 1, variation: 0, rng: createRng(2) });
  assert.ok(jazz.some((n) => n.pitch === 51 && Math.abs(n.start - 5 / 3) < 0.01), 'swung ride skip note');
  const sparse = G.generateDrumPattern({ genre: 'techno', bars: 4, density: 0.15, rng: createRng(4) });
  const dense = G.generateDrumPattern({ genre: 'techno', bars: 4, density: 1, rng: createRng(4) });
  assert.ok(sparse.length < dense.length);
  const a = G.generateDrumPattern({ genre: 'jungle', bars: 4, variation: 0.7, fill: true, rng: createRng(77) });
  const b = G.generateDrumPattern({ genre: 'jungle', bars: 4, variation: 0.7, fill: true, rng: createRng(77) });
  assert.deepEqual(strip(a), strip(b));
  const plain = G.generateDrumPattern({ genre: 'rock', bars: 2, density: 0.9, variation: 0, rng: createRng(5) });
  const filled = G.generateDrumPattern({ genre: 'rock', bars: 2, density: 0.9, variation: 0, fill: true, rng: createRng(5) });
  assert.ok(filled.some((n) => [45, 47, 50].includes(n.pitch) && n.start >= 6), 'tom fill in last bar');
  assert.ok(!plain.some((n) => [45, 47, 50].includes(n.pitch)));
});

test('generateProgression: contiguous chords, voicings in range, genre-appropriate', () => {
  for (const genre of ['pop', 'trap', 'jazz', 'house', 'blues', 'metal', 'neo-soul', 'flamenco-missing']) {
    const prog = G.generateProgression({ key: 9, scale: genre === 'pop' ? 'major' : 'minor', genre, bars: 8, rng: createRng(4) });
    assert.ok(prog.length >= 1, genre);
    let t = 0;
    for (const c of prog) {
      assert.ok(Math.abs(c.startBeat - t) < 1e-9, `${genre} contiguous`);
      assert.ok(c.durBeats > 0);
      assert.ok(c.chord && typeof c.roman === 'string');
      assert.ok(c.notes.length >= 2);
      for (const n of c.notes) assert.ok(n >= 36 && n <= 84, `${genre} voicing ${n}`);
      const cp = T.chordPitchClasses(c.chord.root, c.chord.type);
      for (const n of c.notes) assert.ok(cp.includes(n % 12), `${genre}: voicing tone in chord`);
      t += c.durBeats;
    }
    assert.equal(t, 32, genre);
  }
  const explicit = G.generateProgression({ key: 0, scale: 'major', progression: 'pop-axis', bars: 4, rng: createRng(1) });
  assert.deepEqual(explicit.map((c) => c.chord.name), ['C', 'G', 'Am', 'F']);
  const voices = explicit.map((c) => c.notes);
  for (let i = 1; i < voices.length; i++) {
    const move = voices[i].reduce((s, n, k) => s + Math.abs(n - (voices[i - 1][k] ?? n)), 0);
    assert.ok(move <= 9, `smooth voice leading (${move})`);
  }
  const twoPerBar = G.generateProgression({ key: 0, scale: 'major', progression: 'pop-axis', bars: 2, chordsPerBar: 2, rng: createRng(1) });
  assert.equal(twoPerBar.length, 4);
  assert.equal(twoPerBar[1].startBeat, 2);
  const neo = G.generateProgression({ key: 0, scale: 'major', genre: 'neo-soul', progression: 'pop-axis', bars: 4, rng: createRng(1) });
  assert.ok(neo.every((c) => T.CHORD_TYPES[c.chord.type].intervals.length >= 4), 'neo-soul flavour adds extensions');
});

test('progressionToNotes: all rhythm styles stay inside the progression', () => {
  const prog = G.generateProgression({ key: 2, scale: 'minor', genre: 'house', bars: 4, rng: createRng(8) });
  for (const style of ['whole', ...Object.keys(G.CHORD_RHYTHMS)]) {
    const notes = G.progressionToNotes(prog, { style, rng: createRng(1) });
    assert.ok(notes.length > 0, style);
    assertNotes(notes, 16, `chords ${style}`);
  }
  const skank = G.progressionToNotes(prog, { style: 'skank', rng: createRng(1) });
  assert.ok(skank.every((n) => [1, 1.5, 3, 3.5].includes(n.start % 4)), 'reggae skank on 2 & 4');
});

test('basslines: every style follows the harmony in a low register', () => {
  const prog = G.generateProgression({ key: 5, scale: 'minor', progression: 'aeolian-loop', bars: 4, rng: createRng(2) });
  for (const style of Object.keys(G.BASS_STYLES)) {
    const notes = G.generateBassline({ progression: prog, style, key: 5, scale: 'minor', rng: createRng(5) });
    assert.ok(notes.length > 0, style);
    assertNotes(notes, 16, `bass ${style}`);
    for (const n of notes) assert.ok(n.pitch >= 24 && n.pitch <= 60, `${style} pitch ${n.pitch}`);
    // downbeat of each chord (when played) is the chord root
    if (['root', 'reese', 'rock', 'pop', 'walking', 'disco'].includes(style)) {
      for (const c of prog) {
        const first = notes.find((n) => Math.abs(n.start - c.startBeat) < 1e-6);
        assert.ok(first, `${style}: note at chord start`);
        assert.equal(first.pitch % 12, c.chord.root, `${style}: root at ${c.startBeat}`);
      }
    }
  }
  const kick = [0, 1.5, 2.5, 4, 6.5, 8, 9.5, 12, 14];
  const b808 = G.generateBassline({ progression: prog, style: '808', key: 5, scale: 'minor', kickNotes: kick, rng: createRng(1) });
  for (const t of kick) assert.ok(b808.some((n) => Math.abs(n.start - t) < 1e-6), `808 on kick ${t}`);
  assert.ok(G.generateBass === G.generateBassline);
});

test('melody: scale/chord tones, range, resolution, motif repetition, determinism', () => {
  const prog = G.generateProgression({ key: 0, scale: 'major', progression: 'pop-axis', bars: 4, rng: createRng(2) });
  for (const style of Object.keys(G.MELODY_STYLES)) {
    const range = G.MELODY_STYLES[style].range;
    const m = G.generateMelody({ progression: prog, key: 0, scale: 'major', style, density: 0.7, rng: createRng(12) });
    if (style !== 'ambient') assert.ok(m.length >= 4, style);
    assertNotes(m, 16, `melody ${style}`);
    for (const n of m) {
      assert.ok(n.pitch >= range[0] && n.pitch <= range[1], `${style} range`);
      const c = prog.find((x) => n.start >= x.startBeat && n.start < x.startBeat + x.durBeats);
      const chordPcs = T.chordPitchClasses(c.chord.root, c.chord.type);
      assert.ok(T.inScale(n.pitch, 0, 'major') || chordPcs.includes(n.pitch % 12), `${style} in key`);
      if (n.start % 1 === 0 && n.start % 4 === 0) assert.ok(chordPcs.includes(n.pitch % 12), `${style}: chord tone on downbeat ${n.start}`);
    }
  }
  const lead = G.generateMelody({ progression: prog, key: 0, scale: 'major', style: 'lead', rng: createRng(3) });
  const last = lead[lead.length - 1];
  const lastChord = prog[prog.length - 1];
  assert.ok(T.chordPitchClasses(lastChord.chord.root, lastChord.chord.type).includes(last.pitch % 12), 'phrase ends on a chord tone');
  assert.ok(last.dur >= 1, 'phrase ending is held');
  const riff = G.generateMelody({ progression: prog, key: 0, scale: 'major', style: 'riff', rng: createRng(5) });
  const bar = (b) => riff.filter((n) => n.start >= b * 4 && n.start < b * 4 + 4).map((n) => n.start - b * 4);
  assert.deepEqual(bar(0), bar(1), 'riff rhythm repeats');
  const again = G.generateMelody({ progression: prog, key: 0, scale: 'major', style: 'lead', rng: createRng(3) });
  assert.deepEqual(strip(lead), strip(again));
  const counter = G.generateCounterMelody({ melody: lead, progression: prog, key: 0, scale: 'major', rng: createRng(1) });
  assertNotes(counter, 16, 'counter');
  for (const n of counter) {
    const mel = lead.find((x) => x.start <= n.start && x.start + x.dur > n.start);
    if (mel) assert.ok(n.pitch < mel.pitch, 'counter-melody sits below the melody');
  }
});

test('arpeggiator modes, rate, octaves, gate pattern, progressions', () => {
  const c = [60, 64, 67];
  const up = G.arpeggiate(c, { mode: 'up', rate: 0.25, length: 1 });
  assert.deepEqual(up.map((n) => n.pitch), [60, 64, 67, 60]);
  assert.deepEqual(up.map((n) => n.start), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(G.arpeggiate(c, { mode: 'down', length: 0.75 }).map((n) => n.pitch), [67, 64, 60]);
  assert.deepEqual(G.arpeggiate(c, { mode: 'updown', octaves: 2, length: 2.5 }).map((n) => n.pitch), [60, 64, 67, 72, 76, 79, 76, 72, 67, 64]);
  assert.deepEqual(G.arpeggiate([60, 64, 67, 71], { mode: 'converge', length: 1 }).map((n) => n.pitch), [60, 71, 64, 67]);
  assert.deepEqual(G.arpeggiate(c, { mode: 'pinky', length: 1 }).map((n) => n.pitch), [60, 67, 64, 67]);
  const chord = G.arpeggiate(c, { mode: 'chord', rate: 0.5, length: 1 });
  assert.equal(chord.length, 6);
  const gated = G.arpeggiate(c, { mode: 'up', rate: 0.25, length: 1, pattern: 'x.x.' });
  assert.deepEqual(gated.map((n) => n.start), [0, 0.5]);
  const short = G.arpeggiate(c, { rate: 0.5, gate: 0.5, length: 1 });
  assert.ok(short.every((n) => n.dur === 0.25));
  const prog = G.generateProgression({ key: 0, scale: 'minor', bars: 2, rng: createRng(1) });
  const arp = G.arpeggiate(prog, { mode: 'random', rate: 0.25, octaves: 2, rng: createRng(1) });
  assertNotes(arp, 8, 'arp');
  assert.equal(arp.length, 32);
  for (const n of arp) {
    const ch = prog.find((x) => n.start >= x.startBeat && n.start < x.startBeat + x.durBeats);
    assert.ok(ch.notes.map((p) => p % 12).includes(n.pitch % 12));
  }
});

function checkSong(s, label) {
  const trackIds = new Set(s.tracks.map((t) => t.id));
  assert.ok(s.tracks.length >= 3, label);
  for (const t of s.tracks) {
    assert.ok(t.role, `${label}: role`);
    assert.ok(t.instrument && t.instrument.preset, `${label}: instrument preset`);
    if (t.role === 'drums') assert.equal(t.instrument.type, 'drums');
    else assert.ok(G.ALL_PRESET_IDS.includes(t.instrument.preset), `${label}: ${t.instrument.preset}`);
    assert.ok(t.activePatternId && s.patterns[t.activePatternId], `${label}: active pattern`);
    assert.deepEqual(t.sends, {});
  }
  for (const [id, p] of Object.entries(s.patterns)) {
    assert.equal(p.id, id);
    assert.ok(trackIds.has(p.trackId), `${label}: pattern track`);
    assert.ok(p.length > 0);
    for (const n of p.notes) {
      assert.ok(n.start >= 0 && n.start < p.length, `${label}: note start in ${p.name}`);
      assert.ok(n.dur > 0 && n.start + n.dur <= p.length + 1e-6, `${label}: note end in ${p.name}`);
    }
  }
  for (const c of s.clips) {
    assert.ok(s.patterns[c.patternId], `${label}: clip pattern`);
    assert.ok(trackIds.has(c.trackId), `${label}: clip track`);
    assert.equal(s.patterns[c.patternId].trackId, c.trackId, `${label}: clip/pattern track agree`);
    assert.ok(c.length > 0);
  }
  const g = G.GENRES[s.genre];
  assert.equal(s.markers.length, g.structure.length);
  assert.equal(s.scenes.length, g.structure.length);
  for (const sc of s.scenes) for (const [tid, pid] of Object.entries(sc.slots)) {
    assert.ok(trackIds.has(tid) && s.patterns[pid] && s.patterns[pid].trackId === tid, `${label}: scene slot`);
  }
  const bpb = s.timeSig[0] * (4 / s.timeSig[1]);
  const total = g.structure.reduce((a, x) => a + x.bars, 0) * bpb;
  assert.equal(Math.max(...s.clips.map((c) => c.start + c.length)), total, `${label}: arrangement length`);
}

test('generateSong: consistent ids for every genre', () => {
  for (const id of Object.keys(G.GENRES)) {
    const s = G.generateSong({ genre: id, seed: 11 });
    checkSong(s, id);
    assert.equal(s.genre, id);
    assert.ok(s.bpm >= G.GENRES[id].bpm[0] && s.bpm <= G.GENRES[id].bpm[1]);
    assert.ok(T.SCALES[s.key.scale] && s.key.root >= 0 && s.key.root < 12);
  }
});

test('generateSong: options, section variation and determinism', () => {
  const s = G.generateSong({ genre: 'house', key: 9, scale: 'minor', bpm: 126, seed: 5 });
  assert.equal(s.bpm, 126);
  assert.deepEqual(s.key, { root: 9, scale: 'minor' });
  const drums = s.tracks.find((t) => t.role === 'drums');
  const drumPats = new Set(s.clips.filter((c) => c.trackId === drums.id).map((c) => c.patternId));
  assert.ok(drumPats.size >= 3, 'intro/build/drop get different drum patterns');
  const intro = s.patterns[s.clips.find((c) => c.trackId === drums.id && c.start === 0).patternId];
  const drop = s.patterns[drums.activePatternId];
  assert.ok(intro.notes.length < drop.notes.length, 'intro sparser than drop');
  assert.ok(s.markers.some((m) => m.name === 'Drop') && s.markers.some((m) => m.name === 'Drop 2'));
  const a = G.generateSong({ genre: 'trap', seed: 1234 });
  const b = G.generateSong({ genre: 'trap', seed: 1234 });
  const sig = (x) => JSON.stringify({
    bpm: x.bpm, key: x.key, prog: x.progression,
    tracks: x.tracks.map((t) => [t.name, t.role, t.instrument]),
    patterns: Object.values(x.patterns).map((p) => [p.name, p.length, strip(p.notes)]),
    clips: x.clips.map((c) => [c.start, c.length, x.patterns[c.patternId].name]),
    markers: x.markers.map((m) => [m.beat, m.name]),
  });
  assert.equal(sig(a), sig(b));
  const c = G.generateSong({ genre: 'trap', seed: 999 });
  assert.notEqual(sig(a), sig(c));
  const blues = G.generateSong({ genre: 'blues', seed: 2, scale: 'blues' });
  checkSong(blues, 'blues');
  const byName = G.generateSong({ genre: 'pop', key: 'F#', seed: 1 });
  assert.equal(byName.key.root, 6);
});

test('generatePartNotes follows existing project harmony', () => {
  const song = G.generateSong({ genre: 'pop', key: 0, scale: 'major', seed: 3 });
  const p = { ...createProject(), ...song };
  for (const role of ['drums', 'bass', 'chords', 'pad', 'lead', 'arp']) {
    const notes = G.generatePartNotes(role, { genre: 'pop', key: 0, scale: 'major', bars: 4, beatsPerBar: 4, rng: createRng(1), project: p });
    assert.ok(notes.length, role);
    assertNotes(notes, 16, `part ${role}`);
  }
  const found = G.progressionFromProject(p);
  assert.ok(found && found.progression.length >= 2);
  assert.deepEqual(found.progression.map((c) => c.roman).slice(0, 4), song.progression.slice(0, 4));
});

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

function projectWith(notesByRole, opts = {}) {
  const p = createProject({ bpm: opts.bpm || 120, genre: opts.genre || null });
  p.key = opts.key || { root: 0, scale: 'major' };
  for (const [role, notes] of Object.entries(notesByRole)) {
    const t = createTrack({ name: role, role, instrument: role === 'drums' ? { type: 'drums', preset: '909', params: {} } : { type: 'synth', preset: 'pluck', params: {} } });
    const pat = createPattern(t.id, { name: `${role} pat`, length: opts.length || 16, notes: notes.map(([pitch, start, dur]) => createNote(pitch, start, dur, 0.8)) });
    t.activePatternId = pat.id;
    p.tracks.push(t);
    p.patterns[pat.id] = pat;
  }
  return p;
}

const recShape = (r) => {
  assert.ok(r.id && r.title && r.text, JSON.stringify(r));
  assert.ok(['tip', 'warn', 'idea'].includes(r.level));
  if (r.action) assert.ok(r.action.label && r.action.kind && r.action.payload);
};

test('assistant: empty project and generated song produce well-formed recommendations', () => {
  const empty = createProject();
  const r0 = G.getRecommendations(empty, {});
  assert.ok(r0.length >= 1);
  r0.forEach(recShape);
  const song = { ...createProject(), ...G.generateSong({ genre: 'techno', seed: 4 }) };
  const recs = G.getRecommendations(song, { selectedTrackId: song.tracks[1].id });
  assert.ok(recs.length >= 1);
  recs.forEach(recShape);
  assert.ok(recs.some((r) => r.id.startsWith('genre-tip')));
  const ids = recs.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
});

test('assistant: key mismatch, out-of-scale notes and snapping', () => {
  // A-minor material in a project set to Eb major
  const melody = [57, 60, 64, 57, 59, 60, 62, 64, 65, 64, 62, 60, 59, 57, 56, 57].map((p, i) => [p, i, p % 12 === 9 ? 1 : 0.9]);
  const p = projectWith({ lead: melody }, { key: { root: 3, scale: 'major' } });
  const leadPat = Object.values(p.patterns)[0];
  const recs = G.getRecommendations(p, { selectedPatternId: leadPat.id });
  const km = recs.find((r) => r.action?.kind === 'set-key');
  assert.ok(km, 'key mismatch detected');
  assert.deepEqual(km.action.payload, { root: 9, scale: 'minor' });
  G.applyAssistantAction(p, km.action);
  assert.deepEqual(p.key, { root: 9, scale: 'minor' });
  const recs2 = G.getRecommendations(p, { selectedPatternId: leadPat.id });
  const oos = recs2.find((r) => r.action?.kind === 'snap-to-scale');
  assert.ok(oos, 'G# flagged in A natural minor');
  G.applyAssistantAction(p, oos.action);
  assert.ok(leadPat.notes.every((n) => T.inScale(n.pitch, 9, 'minor')));
});

test('assistant: next-chord suggestion can be applied', () => {
  const chord = (root, type, start) => T.chordNotes(root, type).map((n) => [n, start, 3.9]);
  const p = projectWith({ chords: [...chord(60, 'maj', 0), ...chord(55, 'maj', 4), ...chord(57, 'min', 8)] }, { length: 16 });
  const pat = Object.values(p.patterns)[0];
  const recs = G.getRecommendations(p, { selectedPatternId: pat.id });
  const add = recs.find((r) => r.action?.kind === 'add-chord');
  assert.ok(add, 'chord suggestion');
  assert.equal(add.action.payload.start, 12);
  assert.ok(recs.some((r) => r.id.startsWith('analysis:')));
  const before = pat.notes.length;
  G.applyAssistantAction(p, add.action);
  assert.equal(pat.notes.length, before + add.action.payload.notes.length);
  assert.ok(pat.notes.every((n) => n.start + n.dur <= pat.length + 1e-6));
});

test('assistant: mix/arrangement checks and every action kind applies', () => {
  const p = projectWith({ drums: [[36, 0, 0.25], [36, 1, 0.25]], bass: [[36, 0, 1], [38, 1, 1], [40, 2, 1], [36, 3, 1]], bass2: [[33, 0, 2], [31, 2, 2], [33, 4, 2], [31, 6, 2]], pad: [], lead: [[72, 0, 1]] }, { bpm: 60, genre: 'house' });
  p.tracks.find((t) => t.name === 'bass2').role = 'bass';
  const drums = p.tracks[0];
  const dpat = p.patterns[drums.activePatternId];
  dpat.length = 4;
  p.clips.push(createClip(drums.id, { patternId: dpat.id, start: 0, length: 64 }));
  for (const t of p.tracks) t.volume = 1.3;
  const recs = G.getRecommendations(p, {});
  recs.forEach(recShape);
  const kinds = new Set(recs.map((r) => r.action?.kind).filter(Boolean));
  for (const k of ['set-bpm', 'add-variation', 'set-volume', 'add-effect', 'generate-part', 'set-pan', 'add-send']) assert.ok(kinds.has(k), `missing ${k}`);
  assert.ok(recs.some((r) => r.id === 'low-end-clash'));
  assert.ok(recs.some((r) => r.id.startsWith('empty-track')));
  for (const r of recs) if (r.action) G.applyAssistantAction(p, r.action, { rng: createRng(1) });
  assert.equal(p.bpm, 124);
  assert.ok(p.clips.filter((c) => c.trackId === drums.id).length === 2, 'variation split the long clip');
  const varPat = Object.values(p.patterns).find((x) => x.name.endsWith('(var)'));
  assert.ok(varPat && varPat.notes.length && varPat.notes.every((n) => n.start < varPat.length));
  const pad = p.tracks.find((t) => t.name === 'pad');
  assert.ok(p.patterns[pad.activePatternId].notes.length > 0, 'generate-part filled the empty track');
  assert.ok(p.tracks.some((t) => Object.keys(t.sends).length));
  assert.ok(p.tracks.some((t) => t.fx.length));
  assert.throws(() => G.applyAssistantAction(p, { kind: 'nope', payload: {} }));
  // generate-part creating a new track
  const n = p.tracks.length;
  G.applyAssistantAction(p, { kind: 'generate-part', payload: { role: 'arp', genre: 'trance' } }, { rng: createRng(2) });
  assert.equal(p.tracks.length, n + 1);
  const arpTrack = p.tracks[n];
  assert.equal(arpTrack.role, 'arp');
  assert.ok(p.patterns[arpTrack.activePatternId].notes.length);
  assert.equal(beatsPerBar(p), 4);
});

test('describeGenre returns readable multi-line text', () => {
  const d = G.describeGenre('drum-and-bass');
  assert.ok(typeof d === 'string' && d.includes('BPM') && d.split('\n').length >= 4);
  assert.equal(G.describeGenre('not-a-genre'), '');
});
