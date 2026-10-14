// 'strudel' instrument type (superdough patches): defs, curated patches, generated-song defaults, patch code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENT_DEFS, getParamDefaults, sanitizeParams } from '../src/audio/defs.js';
import { PRESETS, resolveInstrumentDef } from '../src/audio/presets.js';
import { STRUDEL_PATCHES, STRUDEL_SOUNDS, strudelValue, strudelPatchCode } from '../src/audio/strudel-patches.js';
import { noteValues } from '../src/audio/strudel-voice.js';
import { strudelFallbackPreset } from '../src/audio/instruments.js';
import { generateSong } from '../src/gen/song.js';
import { GENRES } from '../src/gen/genres.js';
import { levelFix } from '../src/gen/mix.js';
import { soundCall } from '../src/code/song-code.js';

const MELODIC = new Set(['bass', 'chords', 'pad', 'lead', 'arp', 'fx', 'sub', 'counter', 'strings', 'color', 'vox', 'texture', 'bells', 'organ', 'chop']);
// sounds with no convincing superdough counterpart keep their (multi)sampled instruments
const KEEPS_SAMPLES = /guitar|brass|trumpet|trombone|horn|sax|fiddle|harmonica|accordion|banjo|sitar|cello|contrabass|electric_bass_pick|slap|koto/;

test('strudel defs: Node-importable, real defaults (no -1 sentinels), patches resolve to in-range params', () => {
  const def = INSTRUMENT_DEFS.strudel;
  assert.ok(def && def.params.length > 20);
  for (const p of def.params) if (p.type === 'number') assert.ok(p.default >= 0 || p.min < 0, `${p.key} default ${p.default}`);
  const d = getParamDefaults('strudel');
  assert.equal(d.s, 'triangle');
  assert.ok(STRUDEL_PATCHES.length >= 40);
  const ids = new Set();
  for (const sp of STRUDEL_PATCHES) {
    assert.ok(!ids.has(sp.id) && sp.id.startsWith('sd-'), sp.id);
    ids.add(sp.id);
    assert.ok(STRUDEL_SOUNDS.includes(sp.patch.s), `${sp.id}: sound ${sp.patch.s}`);
    assert.ok(PRESETS[sp.fallbackPreset] && PRESETS[sp.fallbackPreset].instrument.type !== 'strudel', `${sp.id}: fallback ${sp.fallbackPreset}`);
    assert.equal(PRESETS[sp.id].category, 'Strudel');
    const r = resolveInstrumentDef({ type: 'strudel', preset: sp.id, params: {} });
    assert.equal(r.type, 'strudel');
    assert.equal(r.params.s, sp.patch.s);
    assert.deepEqual(sanitizeParams('strudel', r.params), r.params);
    assert.equal(strudelFallbackPreset({ preset: sp.id }), sp.fallbackPreset);
  }
});

test('strudelValue: superdough control names, untouched defaults not sent, envelope groups sent whole', () => {
  const v = strudelValue(resolveInstrumentDef({ preset: 'sd-acid-bass' }).params);
  assert.equal(v.s, 'sawtooth');
  assert.ok(v.cutoff > 0 && v.resonance > 1 && v.lpenv > 0 && !('lpf' in v));
  for (const k of ['lpattack', 'lpdecay', 'lpsustain', 'lprelease', 'attack', 'decay', 'sustain', 'release']) assert.ok(k in v, k);
  for (const k of ['room', 'delay', 'fmi', 'vib', 'penv', 'unison', 'hcutoff', 'pan', 'vowel']) assert.ok(!(k in v), k);
  const init = strudelValue(resolveInstrumentDef({ type: 'strudel', params: {} }).params);
  assert.deepEqual(Object.keys(init).sort(), ['gain', 's']);
  // post stage: notes play at unity gain, the patch gain / pan live in the post stage
  const [n] = noteValues(resolveInstrumentDef({ preset: 'sd-acid-bass' }).params, 40, 0.7, { post: true });
  assert.equal(n.gain, 0.8);
  assert.equal(n.note, 40);
  // no AudioWorklets: supersaw -> three detuned saws, worklet-only controls dropped
  const layers = noteValues(resolveInstrumentDef({ preset: 'sd-supersaw-lead' }).params, 72, 0.8, { worklets: false });
  assert.equal(layers.length, 3);
  assert.ok(layers.every((l) => l.s === 'sawtooth' && !('unison' in l)));
  assert.ok(noteValues(resolveInstrumentDef({ preset: 'sd-808' }).params, 36, 1, { worklets: false }).every((l) => !('shape' in l)));
});

test('patch code: the same .s() + controls the instrument sends', () => {
  const p = resolveInstrumentDef({ preset: 'sd-supersaw-pad' }).params;
  const code = strudelPatchCode(p, { gain: false });
  assert.match(code, /^\.s\("supersaw"\)\.adsr\("\.4:\.6:\.8:1\.2"\)\.lpf\(2400\)/);
  assert.match(code, /\.room\(\.45\)\.size\(6\)$/);
  assert.equal(soundCall({ instrument: { type: 'strudel', preset: 'sd-piano', params: {} } }), strudelPatchCode(resolveInstrumentDef({ preset: 'sd-piano' }).params, { gain: false }));
});

test('generated songs: melodic tracks play Strudel patches (with a built-in fallback preset); drums stay sampled', () => {
  for (const genre of Object.keys(GENRES)) {
    const s = generateSong({ genre, seed: 4 });
    let sd = 0;
    for (const t of s.tracks) {
      const inst = t.instrument;
      if (!inst || !MELODIC.has(t.role)) continue;
      if (inst.type === 'strudel') {
        sd++;
        assert.ok(PRESETS[inst.preset]?.instrument.type === 'strudel', `${genre}/${t.name}: ${inst.preset}`);
        assert.ok(PRESETS[inst.fallbackPreset] && PRESETS[inst.fallbackPreset].instrument.type !== 'strudel', `${genre}/${t.name}: fallback ${inst.fallbackPreset}`);
        assert.ok(Number.isFinite(levelFix(t.role, inst)));
      } else {
        const name = String(inst.params?.instrument || inst.preset || inst.fallbackPreset || inst.params?.name || '');
        assert.ok(KEEPS_SAMPLES.test(name) || ['hoover', 'wobble-bass', 'guitar-lead', 'koto', 'brass-lead', 'fm-brass', 'brass-section', 'Karplus-Strong Pluck'].includes(name) || inst.type === 'faust' || inst.type === 'drums' || !inst.preset,
          `${genre}/${t.name}: ${inst.type} ${name} has a Strudel patch`);
      }
    }
    assert.ok(sd >= (GENRES[genre].family === 'rock' ? 1 : 2), `${genre}: only ${sd} Strudel tracks`);
    for (const t of s.tracks) if (t.role === 'drums') assert.notEqual(t.instrument.type, 'strudel');
  }
  // opts.strudel === false keeps the built-in instruments
  assert.ok(generateSong({ genre: 'trance', seed: 4, strudel: false }).tracks.every((t) => t.instrument?.type !== 'strudel'));
});

test('genre-idiomatic hooks: no soft e-piano leads in dance music; vox = airy vowel pad; house = piano hook', () => {
  const lead = (genre) => generateSong({ genre, seed: 3 }).tracks.find((t) => t.role === 'lead' && !t.layerOf)?.instrument;
  assert.equal(lead('house').preset, 'sd-house-piano');
  assert.equal(lead('trance').preset, 'sd-supersaw-lead');
  assert.equal(lead('deep-house').preset, 'sd-pluck-hook');
  for (const g of Object.values(GENRES).filter((x) => ['house', 'techno', 'trance', 'garage'].includes(x.family))) {
    const p = lead(g.id)?.preset;
    assert.ok(!['sd-rhodes', 'sd-fm-epiano', 'sd-lofi-keys'].includes(p), `${g.id}: soft EP lead ${p}`);
  }
  const s = generateSong({ genre: 'pop', seed: 2 });
  const vox = s.tracks.find((t) => t.role === 'vox');
  if (vox) assert.equal(vox.instrument.preset, 'sd-vox-pad');
});
