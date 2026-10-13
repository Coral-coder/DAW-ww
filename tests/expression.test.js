// Performance expression (src/gen/expression.js) + the instrument source map (src/audio/library/instrument-map.js).
import { songFaith } from './lib/song-faith.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSong } from '../src/gen/song.js';
import { GENRES } from '../src/gen/genres.js';
import { applyExpression, expressPattern, pedalSustain, harmonyChanges, chordGroups, phrases, instrumentClass, holdLimit } from '../src/gen/expression.js';
import { createProject, createNote, beatsPerBar } from '../src/core/model.js';
import { createRng } from '../src/core/util.js';
import { analyzeSong, ratio } from './lib/harmony-check.js';
import { songToCode, snapBeat } from '../src/code/song-code.js';
import { evaluate, queryEvents } from '../src/code/strudel.js';
import { drumPitch } from '../src/code/convert.js';
import { collectEvents } from '../src/audio/scheduler.js';
import { noteExtra } from '../src/audio/mixer.js';
import { GM_MULTISAMPLE, PRESET_GM, multisampleFor, sourcesFor, realInstrumentDef, creditsFor, DEFAULT_SOUNDFONT_LIBRARY } from '../src/audio/library/instrument-map.js';
import { MS_SETS, MS_BASES } from '../src/audio/library/multisample-data.js';
import { layerForVelocity, nearestNote, notesForRange, crossfadeLoopPoints, trimWav, msUrl } from '../src/audio/library/multisample.js';
import { GM_INSTRUMENTS } from '../src/plugins/gm.js';
import { PRESETS } from '../src/audio/presets.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const expressed = (genre, seed) => {
  const s = generateSong({ genre, seed, withHarmony: true, production: false });
  const report = applyExpression(s, { genre, seed });
  return { s, report };
};

test('expression: deterministic for a seed, and the input song is otherwise untouched', () => {
  const a = generateSong({ genre: 'pop', seed: 5, production: false });
  const b = clone(a);
  applyExpression(a, { genre: 'pop', seed: 9 });
  applyExpression(b, { genre: 'pop', seed: 9 });
  assert.deepEqual(clone(a), clone(b));
  // regenerating the same song gives the same expression (pattern ids are random, the result is not)
  const c = generateSong({ genre: 'pop', seed: 5, production: false });
  applyExpression(c, { genre: 'pop', seed: 9 });
  const strip = (s) => Object.values(s.patterns).map((p) => p.notes.map(({ id, ...n }) => n));
  assert.deepEqual(strip(clone(c)), strip(clone(a)));
  // only notes change: clips, instruments and mix stay as generated
  const d = generateSong({ genre: 'pop', seed: 5, production: false });
  assert.deepEqual(a.clips.map((x) => [x.start, x.length, x.name]), d.clips.map((x) => [x.start, x.length, x.name]));
  assert.deepEqual(a.tracks.map((t) => t.instrument), d.tracks.map((t) => t.instrument));
});

test('expression: no notes added or removed, pitches never change, notes stay inside their pattern', () => {
  for (const genre of ['pop', 'jazz', 'rock', 'trap', 'trance', 'funk', 'cinematic', 'blues', 'lofi-hip-hop', 'house']) {
    const s = generateSong({ genre, seed: 3, production: false });
    const before = clone(s.patterns);
    applyExpression(s, { genre, seed: 3 });
    for (const [id, p] of Object.entries(s.patterns)) {
      for (const n of p.notes) {
        assert.ok(n.start >= 0 && n.start < p.length, `${genre} ${p.name}: start ${n.start} outside 0..${p.length}`);
        assert.ok(n.dur > 0 && n.start + n.dur <= p.length + 1e-6, `${genre} ${p.name}: end ${n.start + n.dur} > ${p.length}`);
        assert.ok(n.vel > 0 && n.vel <= 1);
      }
      assert.deepEqual(p.notes.map((n) => n.pitch).sort(), before[id].notes.map((n) => n.pitch).sort(), `${genre} ${p.name}: pitches changed`);
    }
  }
});

test('expression: harmony quality holds for every genre (pedal / legato never smear chords)', () => {
  let changed = 0;
  for (const genre of Object.keys(GENRES)) {
    for (const seed of [1, 7]) {
      const { s, report } = expressed(genre, seed);
      changed += report.pedal + report.legato;
      const r = analyzeSong(s);
      const why = `\n  ${r.issues.slice(0, 6).join('\n  ')}`;
      assert.ok(ratio(r.notes) >= 0.95, `${genre} s${seed}: consonant ${r.notes.ok}/${r.notes.total}${why}`);
      assert.equal(ratio(r.voicing), 1, `${genre} s${seed}: voicings${why}`);
      assert.equal(ratio(r.overlap), 1, `${genre} s${seed}: chord overlap ${r.overlap.ok}/${r.overlap.total}${why}`);
      assert.equal(r.notes.clashSustained, 0, `${genre} s${seed}: sustained clash${why}`);
    }
  }
  assert.ok(changed > 200, `pedal + legato applied (${changed})`);
});

test('expression: adds real variety (velocity / length / pitch expression) across genres', () => {
  const tot = { notes: 0, pedal: 0, legato: 0, glide: 0, bend: 0, vib: 0, flam: 0 };
  for (const genre of ['pop', 'blues', 'rock', 'jazz', 'trap', 'funk', 'cinematic', 'synthwave']) {
    const { report } = expressed(genre, 2);
    for (const k of Object.keys(tot)) tot[k] += report[k];
  }
  for (const k of ['pedal', 'legato', 'glide', 'bend', 'vib', 'flam']) assert.ok(tot[k] > 0, `${k} used (${JSON.stringify(tot)})`);
});

test('pedal: holds to the next chord change, lifts before it, re-strikes of the same chord keep ringing', () => {
  const C = [48, 52, 55], F = [53, 57, 60];
  const notes = [
    ...C.map((p) => createNote(p, 0, 0.5, 0.7)), ...C.map((p) => createNote(p, 1, 0.5, 0.7)), // same chord twice
    ...F.map((p) => createNote(p, 2, 0.5, 0.7)),
  ];
  pedalSustain(notes, { length: 4, grid: 2 });
  const at = (t) => notes.filter((n) => n.start === t);
  for (const n of at(0)) assert.equal(n.start + n.dur, 1, 'first C rings until its re-strike');
  for (const n of at(1)) assert.ok(Math.abs(n.start + n.dur - 1.94) < 1e-9, 'second C lifts just before F');
  for (const n of at(2)) assert.ok(Math.abs(n.start + n.dur - 4) < 1e-9, 'F rings to the end of the pattern');
  assert.deepEqual(harmonyChanges(notes), [0, 2]);
  assert.equal(chordGroups(notes).length, 3);
  // a chord that is not followed by another hit cannot ring across a half-bar (an unplayed chord change)
  const lone = C.map((p) => createNote(p, 0, 0.5, 0.7));
  pedalSustain(lone, { length: 8, grid: 2 });
  for (const n of lone) assert.ok(n.start + n.dur <= 2, 'held only to the half bar');
  assert.equal(holdLimit(0, 0.5, 3.5, 2), 1.94);
  assert.equal(holdLimit(0, 1.9, 2.05, 2), 2.05);
});

test('expression: legato / bends / vibrato on a lead; phrases; flams on drum fills', () => {
  const lead = [createNote(72, 0, 0.8, 0.7), createNote(74, 1, 0.8, 0.7), createNote(76, 2, 1.8, 0.7), createNote(79, 6, 1.5, 0.7)];
  assert.equal(phrases(lead).length, 2);
  const st = expressPattern(lead, { role: 'lead', cls: 'strings', genre: 'cinematic', length: 8, bpb: 4, bpm: 90, changes: [0, 4], rng: createRng(4) });
  assert.ok(st.legato >= 2, 'phrase notes are tied');
  assert.ok(Math.abs(lead[0].start + lead[0].dur - 1) < 0.07 && lead[0].start + lead[0].dur > 1, 'legato overlap is tiny');
  assert.ok(lead.filter((n) => n.vib > 0).length >= 2, 'long notes get vibrato');
  const fill = [36, 38, 38, 45, 45, 47, 47, 50].map((p, i) => createNote(p, 12 + i * 0.5, 0.1, 0.8));
  const st2 = expressPattern(fill, { role: 'drums', cls: 'drums', genre: 'rock', length: 16, bpb: 4, bpm: 120, rng: createRng(1) });
  assert.ok(st2.flam >= 1, 'flams in fills');
  assert.ok(fill.every((n) => n.start >= 0 && n.start < 16));
});

test('expression notes -> scheduler events -> trigger extras', () => {
  const p = createProject({ bpm: 120 });
  const s = generateSong({ genre: 'blues', seed: 4, production: false });
  applyExpression(s, { genre: 'blues', seed: 4 });
  const proj = { ...p, ...s, mode: 'song' };
  const evs = collectEvents(proj, 0, 400, { mode: 'song' }).filter((e) => e.type === 'note');
  const withX = evs.filter((e) => e.x);
  assert.ok(withX.length > 0, 'expression reaches the scheduler');
  const ex = noteExtra({ pitch: 64, x: { glide: -2, gt: 0.1, vib: 0.2, bend: -1, bendAt: 0.5 } }, 1);
  assert.equal(ex.glideFrom, 62);
  assert.equal(ex.glideTime, 0.1);
  assert.ok(ex.vib.depth === 0.2 && ex.vib.delay > 0);
  assert.equal(ex.bend.to, -1);
  assert.equal(ex.bend.at, 0.5);
  assert.deepEqual(noteExtra({ pitch: 60, x: {} }, 1), {});
});

// Same faithfulness check as the song-code tests (onset windows allow swing / humanisation).
function roundTrip(p) {
  const { code, blocks } = songToCode(p);
  const labels = Object.fromEntries(blocks.filter((b) => b.label).map((b) => [b.label, b.trackId]));
  return songFaith(p, code, labels);
}

test('expression: songs still round-trip through song code (>= 95%)', () => {
  let all = 0, good = 0;
  for (const genre of ['pop', 'jazz', 'blues', 'trap', 'cinematic', 'funk']) {
    const s = generateSong({ genre, seed: 11, production: false });
    applyExpression(s, { genre, seed: 11 });
    const p = { ...createProject(), ...s, mode: 'song', swing: 0 };
    const { ok, total } = roundTrip(p);
    assert.ok(ok / total >= 0.95, `${genre}: ${ok}/${total}`);
    all += total; good += ok;
  }
  assert.ok(good / all >= 0.97, `overall ${good}/${all}`);
});

test('instrumentClass groups GM names and presets', () => {
  const c = (x) => instrumentClass(x.startsWith('sf:') ? { type: 'soundfont', params: { instrument: x.slice(3) } } : { type: 'synth', preset: x });
  assert.equal(c('sf:acoustic_grand_piano'), 'keys');
  assert.equal(c('sf:electric_guitar_clean'), 'guitar');
  assert.equal(c('sf:acoustic_guitar_steel'), 'guitar');
  assert.equal(c('sf:string_ensemble_1'), 'strings');
  assert.equal(c('sf:orchestral_harp'), 'mallet');
  assert.equal(c('sf:alto_sax'), 'wind');
  assert.equal(c('sf:brass_section'), 'brass');
  assert.equal(c('808-bass'), 'bass');
  assert.equal(c('saw-lead'), 'synthlead');
  assert.equal(c('organ-drawbar'), 'organ');
});

// ------------------------------------------------------------------------------ instrument map / multisample data

test('instrument map: every mapped set exists, sources fall back best -> MusyngKite -> FluidR3 -> preset', () => {
  for (const [gm, ids] of Object.entries(GM_MULTISAMPLE)) {
    assert.ok(GM_INSTRUMENTS.includes(gm), `${gm} is a GM name`);
    for (const id of ids) assert.ok(MS_SETS[id], `${gm}: set ${id} exists`);
  }
  for (const [preset, gm] of Object.entries(PRESET_GM)) {
    assert.ok(PRESETS[preset], `preset ${preset}`);
    assert.ok(GM_INSTRUMENTS.includes(gm), `${preset} -> ${gm}`);
  }
  assert.equal(multisampleFor('acoustic_grand_piano'), 'salamander');
  assert.equal(multisampleFor('contrabass', 'bass'), 'vsco-bass-pizz');
  assert.equal(multisampleFor('contrabass'), 'vsco-contrabass');
  assert.equal(multisampleFor('clavinet'), null);
  assert.deepEqual(sourcesFor('trumpet', { fallbackPreset: 'brass-lead' }).map((s) => s.kind + ':' + (s.id || s.library)),
    ['multisample:vsco-trumpet', 'soundfont:MusyngKite', 'soundfont:FluidR3_GM', 'preset:brass-lead']);
  const d = realInstrumentDef('string_ensemble_1', { role: 'pad', fallbackPreset: 'strings', range: [52.4, 76] });
  assert.deepEqual(d, { type: 'soundfont', preset: null, params: { library: DEFAULT_SOUNDFONT_LIBRARY, instrument: 'string_ensemble_1', multisample: 'vsco-strings', range: [52, 76] }, fallbackPreset: 'strings' });
  assert.equal(realInstrumentDef('clavinet').params.multisample, undefined);
  assert.ok(creditsFor([d]).some((c) => /Versilian/.test(c.credit) && c.license === 'CC0-1.0'));
});

test('multisample data: zones are sorted, in MIDI range, every layer present per note, URLs resolve to GitHub', () => {
  for (const [id, set] of Object.entries(MS_SETS)) {
    assert.ok(set.zones.length > 0 && set.license && set.credit, id);
    const notes = new Set(set.zones.map((z) => z[0]));
    for (const n of notes) {
      assert.ok(n >= 0 && n <= 127, `${id} note ${n}`);
      for (let l = 0; l < set.layers; l++) assert.ok(set.zones.some((z) => z[0] === n && z[1] === l), `${id} note ${n} layer ${l}`);
    }
    for (const z of set.zones) {
      const [repo] = z[2].split(':');
      assert.ok(MS_BASES[repo], `${id}: repo ${repo}`);
      assert.match(msUrl(z[2]), /^https:\/\/raw\.githubusercontent\.com\//);
    }
    assert.ok(['sustain', 'decay'].includes(set.kind));
  }
});

test('multisample helpers: velocity layers, nearest note, range selection, loops, WAV trimming', () => {
  assert.equal(layerForVelocity(0.1, 1), 0);
  assert.deepEqual([0.2, 0.5, 0.7, 0.95].map((v) => layerForVelocity(v, 2)), [0, 0, 1, 1]);
  assert.deepEqual([0.2, 0.5, 0.8].map((v) => layerForVelocity(v, 3)), [0, 1, 2]);
  assert.deepEqual([0.05, 0.4, 0.6, 0.9].map((v) => layerForVelocity(v, 4)), [0, 1, 2, 3]);
  assert.equal(nearestNote([48, 51, 54], 49), 0);
  assert.equal(nearestNote([48, 51, 54], 50), 1);
  assert.equal(nearestNote([48, 51], 49.5), 0, 'ties -> lower sample');
  const sal = MS_SETS.salamander;
  const few = notesForRange(sal, [60, 64]);
  assert.ok(few.length >= 2 && few.length <= 4 && few.every((n) => n >= 55 && n <= 69), few.join(','));
  assert.equal(notesForRange(sal).length, 30);
  const lp = crossfadeLoopPoints(4, { attack: 0.1 });
  assert.ok(lp.start > 0.3 && lp.end < 4 && lp.end - lp.start >= 1 && lp.fade > 0.05);
  assert.equal(crossfadeLoopPoints(0.8), null);
  // a 1 s 16-bit stereo WAV trimmed to 0.25 s keeps a valid header
  const sr = 8000, frames = sr, bytes = new Uint8Array(44 + frames * 4);
  const dv = new DataView(bytes.buffer);
  const w = (o, s) => [...s].forEach((c, i) => { bytes[o + i] = c.charCodeAt(0); });
  w(0, 'RIFF'); dv.setUint32(4, 36 + frames * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, frames * 4, true);
  const t = new DataView(trimWav(bytes.buffer.slice(0, 44 + 3000 * 4), 0.25));
  assert.equal(t.getUint32(40, true), 2000 * 4);
  assert.equal(t.byteLength, 44 + 2000 * 4);
  assert.equal(t.getUint32(4, true), t.byteLength - 8);
});

// ------------------------------------------------------------------------------ production pass (src/gen/production.js)
import { finishSong, realInstrument, presetFxChain, masterChainFor, spaceFor, addLayers, trackRange } from '../src/gen/production.js';
import { EFFECT_DEFS } from '../src/audio/effect-defs.js';

test('production: real instruments + finishSong keep every genre harmonically clean, ranges / fx / master valid', () => {
  for (const genre of Object.keys(GENRES)) {
    const s = generateSong({ genre, seed: 3, withHarmony: true, production: false });
    for (const t of s.tracks) t.instrument = realInstrument(t.instrument, t.role, genre);
    const rep = finishSong(s, { genre, seed: 3 });
    const r = analyzeSong(s);
    const why = `\n  ${r.issues.slice(0, 4).join('\n  ')}`;
    assert.ok(ratio(r.notes) >= 0.95 && ratio(r.voicing) === 1 && ratio(r.overlap) === 1 && r.notes.clashSustained === 0, `${genre}${why}`);
    for (const t of s.tracks) {
      for (const f of t.fx) assert.ok(EFFECT_DEFS[f.type], `${genre} ${t.name}: fx ${f.type}`);
      if (t.instrument?.params?.multisample) {
        assert.ok(MS_SETS[t.instrument.params.multisample], `${genre} ${t.name}: set`);
        assert.deepEqual(t.instrument.params.range, trackRange(s, t.id));
        assert.ok(t.instrument.fallbackPreset !== undefined, `${genre} ${t.name}: fallback`);
      }
      if (t.layerOf) assert.ok(s.clips.some((c) => c.trackId === t.id), `${genre} ${t.name}: layer has clips`);
    }
    assert.equal(s.master.fx[0].type, 'mastering');
    assert.ok(s.buses.some((b) => b.fx.some((f) => f.type === 'reverb' && f.params.character)), `${genre}: reverb character`);
    assert.equal(rep.master, masterChainFor(genre).lufs);
  }
});

test('production: realInstrument keeps synths where they belong, upgrades acoustic imitations', () => {
  assert.equal(realInstrument({ type: 'synth', preset: 'saw-lead', params: {} }, 'lead', 'trance').preset, 'saw-lead');
  const piano = realInstrument({ type: 'synth', preset: 'grand-piano', params: {} }, 'chords', 'pop');
  assert.equal(piano.type, 'soundfont');
  assert.equal(piano.params.multisample, 'salamander');
  assert.equal(piano.fallbackPreset, 'grand-piano');
  assert.equal(realInstrument({ type: 'fm', preset: 'electric-piano', params: {} }, 'chords', 'deep-house').preset, 'electric-piano', 'synth e-piano stays in house');
  const sf = realInstrument({ type: 'soundfont', preset: null, params: { library: 'FluidR3_GM', instrument: 'acoustic_bass', release: 0.12 }, fallbackPreset: 'upright-bass' }, 'bass', 'jazz');
  assert.deepEqual(sf.params, { library: 'MusyngKite', instrument: 'acoustic_bass', multisample: 'vsco-bass-pizz', release: 0.12 });
  assert.equal(realInstrument({ type: 'synth', preset: 'grand-piano', params: {} }, 'chords', 'pop', { soundfonts: false }).preset, 'grand-piano');
  assert.ok(presetFxChain('warm-pad').some(([t]) => t === 'chorus'));
  assert.ok(presetFxChain('808-bass').some(([t]) => t === 'saturator'));
  assert.ok(presetFxChain('pluck').some(([t]) => t === 'delay'));
  assert.deepEqual(presetFxChain('nope'), []);
  assert.equal(masterChainFor('trance').lufs, -9.5);
  assert.equal(masterChainFor('jazz').lufs, -14);
  assert.equal(masterChainFor('cinematic').lufs, -16);
  assert.equal(spaceFor('jazz').character, 'chamber');
  const s = generateSong({ genre: 'trance', seed: 2, production: false });
  const n = s.tracks.length;
  const added = addLayers(s, { genre: 'trance' });
  assert.equal(s.tracks.length, n + added.length);
  assert.ok(added.some((t) => t.name === 'Lead Octave'));
});

test('production: generateSong applies finishSong by default (real instruments, expression, master)', () => {
  const s = generateSong({ genre: 'jazz', seed: 7 });
  const keys = s.tracks.find((t) => t.role === 'chords');
  assert.equal(keys.instrument.params.multisample, 'salamander');
  assert.ok(keys.instrument.params.range && keys.instrument.fallbackPreset);
  assert.equal(s.master.fx[0].type, 'mastering');
  const synth = generateSong({ genre: 'jazz', seed: 7, soundfonts: false, production: false });
  assert.ok(synth.tracks.every((t) => t.instrument.type !== 'soundfont'), 'soundfonts: false keeps synths');
});
