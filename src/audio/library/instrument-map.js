// Best available sample source per General-MIDI instrument (pure data, Node-safe).
//
// Fallback order for every acoustic instrument the generator (or a user) asks for:
//   1. a real multisampled library from multisample-data.js (velocity layers, round robins, loops) —
//      Salamander Grand, VSCO-2 CE orchestra, VCSL, tonejs-instruments;
//   2. the MusyngKite GM soundfont (gleitz/midi-js-soundfonts — larger, richer than FluidR3);
//   3. the FluidR3_GM soundfont;
//   4. a built-in synth preset (`fallbackPreset`, used when nothing can be downloaded).
// All four are wired into one instrument def: {type:'soundfont', params:{multisample, library:'MusyngKite',
// instrument, range}, fallbackPreset} — the SoundfontEngine walks 1→3, the Instrument wrapper does 4.
import { MS_SETS } from './multisample-data.js';

export const DEFAULT_SOUNDFONT_LIBRARY = 'MusyngKite';
export const SOUNDFONT_FALLBACK_LIBRARY = 'FluidR3_GM';

/** GM instrument -> multisample set ids, best first (only sets that exist in MS_SETS are used). */
export const GM_MULTISAMPLE = {
  // keys
  acoustic_grand_piano: ['salamander', 'vcsl-upright'],
  bright_acoustic_piano: ['salamander', 'vcsl-upright'],
  electric_grand_piano: ['salamander'],
  honkytonk_piano: ['vcsl-upright', 'salamander'],
  harpsichord: ['vcsl-harpsichord'],
  church_organ: ['vcsl-pipe-organ'],
  reed_organ: ['tjs-harmonium'],
  accordion: [],
  harmonica: ['vcsl-harmonica'],
  // chromatic percussion
  vibraphone: ['vcsl-vibraphone'],
  marimba: ['vcsl-marimba'],
  xylophone: ['vcsl-xylophone'],
  glockenspiel: ['vcsl-glockenspiel'],
  tubular_bells: ['vcsl-tubular-bells'],
  kalimba: ['vcsl-kalimba'],
  // guitars
  acoustic_guitar_nylon: ['tjs-guitar-nylon'],
  acoustic_guitar_steel: ['tjs-guitar-acoustic'],
  electric_guitar_clean: ['tjs-guitar-electric'],
  electric_guitar_jazz: ['tjs-guitar-electric'],
  // basses
  acoustic_bass: ['vsco-bass-pizz'],
  electric_bass_finger: ['tjs-bass-electric'],
  contrabass: ['vsco-contrabass'],
  // strings
  violin: ['vsco-violin'],
  fiddle: ['vsco-violin'],
  viola: ['vsco-strings'],
  cello: ['vsco-cello'],
  string_ensemble_1: ['vsco-strings'],
  string_ensemble_2: ['vsco-strings'],
  tremolo_strings: ['vsco-strings-trem'],
  pizzicato_strings: ['vsco-strings-pizz'],
  orchestral_harp: ['vsco-harp'],
  // brass
  trumpet: ['vsco-trumpet'],
  muted_trumpet: [],
  trombone: ['vsco-trombone'],
  tuba: ['vsco-tuba'],
  french_horn: ['vsco-horn'],
  brass_section: ['vsco-brass'],
  // reeds & pipes
  soprano_sax: ['tjs-saxophone'],
  alto_sax: ['tjs-saxophone', 'vcsl-tenor-sax'],
  tenor_sax: ['vcsl-tenor-sax', 'tjs-saxophone'],
  baritone_sax: ['vcsl-tenor-sax'],
  oboe: ['vsco-oboe'],
  english_horn: ['vsco-oboe'],
  bassoon: ['vsco-bassoon'],
  clarinet: ['vsco-clarinet'],
  flute: ['vsco-flute'],
  piccolo: ['vsco-flute'],
  recorder: ['vcsl-recorder'],
};

/**
 * Built-in synth presets that imitate an acoustic instrument -> the GM instrument to stream instead
 * (generated songs use the real samples, keeping the preset as the offline fallback).
 */
export const PRESET_GM = {
  'grand-piano': 'acoustic_grand_piano',
  strings: 'string_ensemble_1',
  vibraphone: 'vibraphone',
  marimba: 'marimba',
  flute: 'flute',
  'upright-bass': 'acoustic_bass',
  'finger-bass': 'electric_bass_finger',
  'guitar-clean': 'electric_guitar_clean',
  'guitar-lead': 'overdriven_guitar',
  'guitar-dist': 'distortion_guitar',
  'power-chord': 'distortion_guitar',
  'brass-section': 'brass_section',
  'brass-lead': 'trumpet',
  harp: 'orchestral_harp',
  kalimba: 'kalimba',
  'choir-pad': 'choir_aahs',
  clav: 'clavinet',
  celesta: 'celesta',
  'steel-drum': 'steel_drums',
  'electric-piano': 'electric_piano_1',
};

/** Role-specific overrides: the same GM name can want a different articulation per role. */
export const ROLE_MULTISAMPLE = {
  bass: { contrabass: 'vsco-bass-pizz' }, // a bass line in a band plays pizzicato, not arco
  arp: { string_ensemble_1: 'vsco-strings-pizz', string_ensemble_2: 'vsco-strings-pizz' },
};

/** Best multisample set for a GM instrument (and role), or null. */
export function multisampleFor(gm, role) {
  const r = ROLE_MULTISAMPLE[role]?.[gm];
  if (r && MS_SETS[r]) return r;
  return (GM_MULTISAMPLE[gm] || []).find((id) => MS_SETS[id]) || null;
}

/**
 * The ordered sources an instrument will try: [{kind:'multisample', id} | {kind:'soundfont', library} | {kind:'preset', id}].
 */
export function sourcesFor(gm, { role, fallbackPreset = null } = {}) {
  const out = [];
  const ms = multisampleFor(gm, role);
  if (ms) out.push({ kind: 'multisample', id: ms });
  out.push({ kind: 'soundfont', library: DEFAULT_SOUNDFONT_LIBRARY, instrument: gm });
  out.push({ kind: 'soundfont', library: SOUNDFONT_FALLBACK_LIBRARY, instrument: gm });
  if (fallbackPreset) out.push({ kind: 'preset', id: fallbackPreset });
  return out;
}

/**
 * Instrument def that streams the best source of a GM instrument.
 * opts: {role, fallbackPreset, range:[lo, hi] (MIDI notes the part plays — limits the download), params (extra soundfont params)}
 */
export function realInstrumentDef(gm, { role, fallbackPreset = null, range = null, params = {} } = {}) {
  const ms = multisampleFor(gm, role);
  const p = { library: DEFAULT_SOUNDFONT_LIBRARY, instrument: gm, ...params };
  if (ms) p.multisample = ms;
  if (range && ms) p.range = [Math.max(0, Math.round(range[0])), Math.min(127, Math.round(range[1]))];
  const def = { type: 'soundfont', preset: null, params: p };
  if (fallbackPreset) def.fallbackPreset = fallbackPreset;
  return def;
}

/** Licence / credit lines of the multisample sets an instrument def uses (for the "About sounds" credits). */
export function creditsFor(defs) {
  const out = new Map();
  for (const d of defs || []) {
    const id = d?.params?.multisample;
    if (id && MS_SETS[id]) out.set(MS_SETS[id].credit, MS_SETS[id].license);
  }
  return [...out].map(([credit, license]) => ({ credit, license }));
}

/**
 * Level match (dB) of every source to the FluidR3_GM bank of the same GM instrument (standard phrase, K-weighted
 * loudness, measured headless — see docs/SAMPLES.md). Keeps the mix's per-instrument level tables valid whichever
 * source ends up playing. multisample: per set (measured on its primary GM instrument); MusyngKite: per GM name.
 */
export const SOURCE_TRIM_DB = {
  multisample: {
    "salamander": 1.2,
    "vsco-bass-pizz": 6.9,
    "vcsl-vibraphone": -6.1,
    "vsco-strings": 4.4,
    "tjs-guitar-nylon": -1.8,
    "vsco-flute": 2.9,
    "tjs-guitar-electric": -3,
    "tjs-bass-electric": 0.6,
    "tjs-saxophone": 0.1,
    "vsco-trumpet": -0.1,
    "vsco-brass": 1.9,
    "tjs-guitar-acoustic": -0.7,
    "vsco-violin": 3.7,
    "vsco-harp": 5.4,
    "vsco-horn": 2.5,
    "vsco-contrabass": 3.5,
    "vcsl-marimba": 3.4,
    "vcsl-kalimba": -0.8,
    "vcsl-upright": 0.5,
    "vcsl-harpsichord": 5.7,
    "vcsl-pipe-organ": 0.9,
    "tjs-harmonium": 4.6,
    "vcsl-harmonica": 2.8,
    "vcsl-xylophone": -4.6,
    "vcsl-glockenspiel": 3.1,
    "vcsl-tubular-bells": 4,
    "vsco-cello": 5.3,
    "vsco-strings-trem": 7.1,
    "vsco-strings-pizz": 7,
    "vsco-trombone": 8.7,
    "vsco-tuba": 6.9,
    "vcsl-tenor-sax": 1.7,
    "vsco-oboe": 1.3,
    "vsco-bassoon": 3.1,
    "vsco-clarinet": 3.3,
    "vcsl-recorder": 4.1,
  },
  MusyngKite: {
    "acoustic_grand_piano": 6.6,
    "acoustic_bass": -0.6,
    "vibraphone": -4.1,
    "string_ensemble_1": -0.6,
    "acoustic_guitar_nylon": 1.3,
    "flute": 3.6,
    "electric_guitar_clean": -3.7,
    "electric_bass_finger": -0.5,
    "overdriven_guitar": 3.3,
    "alto_sax": 4.8,
    "choir_aahs": 0,
    "electric_piano_1": 1.5,
    "electric_guitar_jazz": -1.2,
    "string_ensemble_2": 10.7,
    "clavinet": -2,
    "slap_bass_1": 1.4,
    "trumpet": 0.9,
    "brass_section": 3.1,
    "electric_guitar_muted": -1.2,
    "electric_bass_pick": 4.2,
    "distortion_guitar": -0.5,
    "acoustic_guitar_steel": 2.6,
    "fiddle": 0.1,
    "orchestral_harp": 2.5,
    "french_horn": 0.3,
    "contrabass": 0.4,
    "marimba": 2,
    "kalimba": -1.3,
    "celesta": 2.5,
    "steel_drums": 4,
    "bright_acoustic_piano": 0.5,
    "electric_grand_piano": 1,
    "honkytonk_piano": 0.6,
    "harpsichord": -0.1,
    "church_organ": 3.2,
    "reed_organ": 6.4,
    "harmonica": 0.5,
    "xylophone": -12.2,
    "glockenspiel": 10.6,
    "tubular_bells": -0.3,
    "violin": 4.1,
    "viola": 2.8,
    "cello": 1.3,
    "tremolo_strings": -0.8,
    "pizzicato_strings": 5,
    "trombone": 6.1,
    "tuba": 6.8,
    "soprano_sax": -1.6,
    "tenor_sax": 1.4,
    "baritone_sax": 0.9,
    "oboe": 4.8,
    "english_horn": -2.7,
    "bassoon": 2.4,
    "clarinet": 5.3,
    "piccolo": 4.2,
    "recorder": 2.5,
  },
};

/** Trim (dB) for a source: {multisample, instrument} or {library, instrument}. */
export function sourceTrimDb({ multisample, library, instrument } = {}) {
  const v = multisample ? SOURCE_TRIM_DB.multisample[multisample] : SOURCE_TRIM_DB[library]?.[instrument];
  return Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0;
}
