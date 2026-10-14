// Sound choice per genre & role for generated songs: sampled drum machines for the drum track (synth kit
// fallback inside the same 'drums' instrument), General-MIDI SoundFont instruments for acoustic / band genres
// (with `fallbackPreset` = the closest synth preset if the soundfont can't load), synth presets elsewhere.
import { PRESETS } from '../audio/presets.js';
import { drumInstrumentForGenre } from '../audio/library/drum-machines.js';
import { getGenre } from './genres.js';
import { realInstrument } from './production.js';
import { GENRE_FAUST, faustFor } from './plugins.js';
import { toStrudel, genreStrudel, hookSafe } from './strudel-sounds.js';

export { toStrudel, strudelPatchFor, PRESET_STRUDEL, GM_STRUDEL } from './strudel-sounds.js';

export const SOUNDFONT_LIBRARY = 'FluidR3_GM';

/**
 * Acoustic / band palettes: role -> GM instrument (src/plugins/gm.js names). Roles not listed keep the genre's
 * synth preset (pads, arps, fx and electronic basses usually sound better as synths).
 */
export const GENRE_SOUNDFONTS = {
  jazz: { chords: 'acoustic_grand_piano', bass: 'acoustic_bass', lead: 'vibraphone', pad: 'string_ensemble_1' },
  'bossa-nova': { chords: 'acoustic_guitar_nylon', bass: 'acoustic_bass', lead: 'flute', pad: 'string_ensemble_1' },
  blues: { chords: 'electric_guitar_clean', bass: 'electric_bass_finger', lead: 'overdriven_guitar' },
  gospel: { chords: 'acoustic_grand_piano', bass: 'electric_bass_finger', lead: 'alto_sax', pad: 'choir_aahs' },
  'neo-soul': { chords: 'electric_piano_1', bass: 'electric_bass_finger', lead: 'electric_guitar_jazz', pad: 'string_ensemble_2' },
  rnb: { chords: 'electric_piano_1' },
  soul: { chords: 'electric_piano_1', bass: 'electric_bass_finger' },
  funk: { chords: 'clavinet', bass: 'slap_bass_1', lead: 'trumpet', pad: 'brass_section' },
  disco: { chords: 'electric_guitar_muted', bass: 'electric_bass_finger', lead: 'brass_section', pad: 'string_ensemble_1' },
  rock: { chords: 'overdriven_guitar', bass: 'electric_bass_pick', lead: 'distortion_guitar' },
  punk: { chords: 'distortion_guitar', bass: 'electric_bass_pick', lead: 'overdriven_guitar' },
  metal: { chords: 'distortion_guitar', bass: 'electric_bass_pick', lead: 'distortion_guitar', pad: 'choir_aahs' },
  indie: { chords: 'electric_guitar_clean', bass: 'electric_bass_finger', lead: 'electric_guitar_jazz' },
  country: { chords: 'acoustic_guitar_steel', bass: 'electric_bass_finger', lead: 'fiddle' },
  folk: { chords: 'acoustic_guitar_steel', bass: 'acoustic_bass', lead: 'flute', pad: 'string_ensemble_1', arp: 'orchestral_harp' },
  reggae: { lead: 'electric_guitar_clean', bass: 'electric_bass_finger' },
  salsa: { chords: 'acoustic_grand_piano', bass: 'acoustic_bass', lead: 'trumpet', pad: 'brass_section' },
  afrobeat: { chords: 'electric_guitar_clean', pad: 'brass_section' },
  cinematic: { chords: 'string_ensemble_1', pad: 'choir_aahs', lead: 'french_horn', arp: 'orchestral_harp', bass: 'contrabass' },
  'boom-bap': { chords: 'electric_piano_1', bass: 'acoustic_bass', lead: 'vibraphone', pad: 'string_ensemble_1' },
  'lofi-hip-hop': { chords: 'electric_piano_1', bass: 'acoustic_bass', lead: 'vibraphone' },
  'trip-hop': { chords: 'electric_piano_1', pad: 'string_ensemble_1', lead: 'vibraphone' },
  drill: { chords: 'string_ensemble_1', lead: 'acoustic_grand_piano', pad: 'choir_aahs' },
  'liquid-dnb': { chords: 'electric_piano_1', pad: 'string_ensemble_1' },
  'deep-house': { chords: 'electric_piano_1' },
  amapiano: { chords: 'electric_piano_1' },
  pop: { chords: 'acoustic_grand_piano' },
  downtempo: { chords: 'electric_piano_1', lead: 'flute' },
  jungle: { pad: 'string_ensemble_1' },
};

/** Per-GM-instrument playing params (release / attack in s): sustained strings & choirs breathe, plucks ring. */
const SF_PARAMS = {
  string_ensemble_1: { attack: 0.08, release: 0.6 }, string_ensemble_2: { attack: 0.1, release: 0.7 }, choir_aahs: { attack: 0.12, release: 0.8 },
  brass_section: { attack: 0.02, release: 0.25 }, french_horn: { attack: 0.04, release: 0.4 }, trumpet: { attack: 0.01, release: 0.2 },
  acoustic_grand_piano: { release: 0.5 }, electric_piano_1: { release: 0.45 }, vibraphone: { release: 0.9 }, orchestral_harp: { release: 1 },
  acoustic_bass: { release: 0.12 }, electric_bass_finger: { release: 0.1 }, electric_bass_pick: { release: 0.08 }, slap_bass_1: { release: 0.08 },
  contrabass: { attack: 0.03, release: 0.3 }, alto_sax: { attack: 0.02, release: 0.2 }, flute: { attack: 0.03, release: 0.25 }, fiddle: { attack: 0.03, release: 0.25 },
};

/** Guitar / piano-ish parts get strums or rolls (ms between notes). */
export function strumFor(inst) {
  const name = inst?.type === 'soundfont' ? inst.params?.instrument || '' : inst?.type === 'strudel' ? inst.fallbackPreset || inst.preset || '' : inst?.preset || '';
  if (/guitar|nylon|steel|harp|koto|banjo/.test(name)) return 11;
  if (/piano|clav|epiano|lofi-keys|organ/.test(name)) return 4;
  return 0;
}

/**
 * Instrument def for a role in a genre. Drums: sampled machine + synth kit fallback. Melodic roles: a SoundFont
 * GM instrument where the genre is acoustic (def.fallbackPreset = the genre's synth preset), else the preset.
 * opts.soundfonts === false keeps every role on synth presets. Acoustic defs are upgraded with production.js
 * realInstrument (multisample -> MusyngKite -> FluidR3 -> fallbackPreset).
 */
export function instrumentForRole(role, genreId, opts = {}) {
  const g = getGenre(genreId);
  if (role === 'drums') {
    if (opts.sampledDrums === false) return { type: 'drums', preset: g.drumKit, params: {} };
    const def = drumInstrumentForGenre(g.id, { kit: g.drumKit, family: g.family });
    return { ...def, params: { ...def.params, humanize: 0, roundRobin: true } };
  }
  const preset = g.presets?.[role] || null;
  // Strudel's own audio engine (superdough) for every melodic role it has a patch for — the genre's preset / GM
  // instrument becomes the closest Strudel patch, the preset its fallback (src/gen/strudel-sounds.js).
  // opts.strudel === false (or soundfonts: false = nothing downloaded) keeps the built-in / plugin instruments.
  if (opts.strudel !== false && opts.soundfonts !== false) {
    const own = genreStrudel(role, g); // genre-idiomatic hooks / stabs first
    if (own) return own;
    const gm = GENRE_SOUNDFONTS[g.id]?.[role];
    const sd = hookSafe(toStrudel(gm ? { type: 'soundfont', preset: null, params: { instrument: gm }, fallbackPreset: preset } : { type: PRESETS[preset]?.instrument.type || 'synth', preset, params: {} }), role, g);
    if (sd?.type === 'strudel') return sd;
  }
  // Faust plugin where it beats the preset (supersaw trance leads, analog pads, KS plucks, bells, organs) — the
  // preset is its fallback. opts.plugins === false (or soundfonts: false = nothing downloaded) keeps built-ins.
  if (opts.plugins !== false && opts.soundfonts !== false && GENRE_FAUST[g.id]?.[role] && preset) return faustFor(role, g.id, preset);
  const sf = opts.soundfonts === false ? null : GENRE_SOUNDFONTS[g.id]?.[role];
  const def = sf
    ? { type: 'soundfont', preset: null, params: { library: SOUNDFONT_LIBRARY, instrument: sf, ...(SF_PARAMS[sf] || {}) }, fallbackPreset: preset }
    : { type: PRESETS[preset]?.instrument.type || 'synth', preset, params: {} };
  // best real source: multisampled library (Salamander / VSCO-2 / VCSL / tonejs) -> MusyngKite -> FluidR3 ->
  // fallbackPreset (src/audio/library/instrument-map.js); opts.realInstruments === false keeps plain FluidR3 GM
  return opts.realInstruments === false ? def : realInstrument(def, role, g.id, opts);
}

/** True when an instrument is a sampled / acoustic sound (used by the mixer for EQ / level choices). */
export const isAcoustic = (inst) => inst?.type === 'soundfont';
/** True when an instrument plays through Strudel's audio engine (superdough). */
export const isStrudel = (inst) => inst?.type === 'strudel';
