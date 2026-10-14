// Generated songs play their melodic parts through Strudel's own audio engine (superdough): every built-in preset /
// GM instrument the genre tables pick (src/gen/genres.js presets, sound.js GENRE_SOUNDFONTS, orchestra.js extras) maps
// to the closest curated Strudel patch (src/audio/strudel-patches.js). The original preset stays as `fallbackPreset`
// (plays when superdough or the patch's samples can't load). Sounds without a convincing superdough counterpart —
// guitars, brass, saxes, fiddles, orchestral solo instruments — keep their multisampled instruments; drums keep their
// sampled machines.
import { PRESETS } from '../audio/presets.js';

/** Built-in preset -> Strudel patch. */
export const PRESET_STRUDEL = {
  'sub-bass': 'sd-sub-bass', '808-bass': 'sd-808', 'acid-bass': 'sd-acid-bass', 'reese-bass': 'sd-reese-bass', 'saw-bass': 'sd-saw-bass',
  'pluck-bass': 'sd-pluck-bass', 'moog-bass': 'sd-moog-bass', 'fm-bass': 'sd-fm-bass', 'tine-bass': 'sd-fm-bass', 'dub-bass': 'sd-dub-bass',
  'chip-bass': 'sd-square-bass', 'synthwave-bass': 'sd-saw-bass', 'upright-bass': 'sd-acoustic-bass', 'finger-bass': 'sd-finger-bass',
  'supersaw-lead': 'sd-supersaw-lead', 'trance-lead': 'sd-supersaw-lead', 'square-lead': 'sd-square-lead', 'saw-lead': 'sd-saw-lead',
  'sync-lead': 'sd-saw-lead', 'acid-lead': 'sd-acid-lead', 'fm-bell-lead': 'sd-fm-bell', bell: 'sd-fm-bell', 'chip-lead': 'sd-chip-lead', flute: 'sd-flute',
  'grand-piano': 'sd-piano', 'electric-piano': 'sd-rhodes', 'fm-epiano': 'sd-fm-epiano', 'lofi-keys': 'sd-lofi-keys', vibraphone: 'sd-vibraphone',
  marimba: 'sd-marimba', kalimba: 'sd-kalimba', 'organ-drawbar': 'sd-organ', 'organ-rock': 'sd-rock-organ', clav: 'sd-clav',
  'house-stab': 'sd-house-stab', 'future-chords': 'sd-supersaw-chords', celesta: 'sd-glock', 'steel-drum': 'sd-steel-drum', harp: 'sd-harp',
  pluck: 'sd-tri-pluck', 'arp-pluck': 'sd-tri-pluck', 'arp-saw': 'sd-saw-arp',
  'supersaw-pad': 'sd-supersaw-pad', 'warm-pad': 'sd-warm-pad', 'synthwave-pad': 'sd-warm-pad', 'detuned-pad': 'sd-warm-pad', 'dark-pad': 'sd-dark-pad',
  'glass-pad': 'sd-glass-pad', 'ambient-pad': 'sd-ambient-pad', 'juno-strings': 'sd-juno-strings', strings: 'sd-strings', 'string-pad': 'sd-synth-strings',
  'choir-pad': 'sd-choir', 'whistle-lead': 'sd-soft-lead', 'noise-sweep': 'sd-noise-sweep', riser: 'sd-riser', laser: 'sd-laser',
};
/** GM instrument (soundfont / multisample defs) -> Strudel patch. Unlisted GM instruments keep their samples. */
export const GM_STRUDEL = {
  acoustic_grand_piano: 'sd-piano', bright_acoustic_piano: 'sd-piano', electric_piano_1: 'sd-rhodes', electric_piano_2: 'sd-fm-epiano',
  acoustic_bass: 'sd-acoustic-bass', electric_bass_finger: 'sd-finger-bass', vibraphone: 'sd-vibraphone', marimba: 'sd-marimba', kalimba: 'sd-kalimba',
  orchestral_harp: 'sd-harp', glockenspiel: 'sd-glock', celesta: 'sd-glock', string_ensemble_1: 'sd-strings', string_ensemble_2: 'sd-strings',
  synth_strings_1: 'sd-synth-strings', choir_aahs: 'sd-choir', voice_oohs: 'sd-choir', flute: 'sd-flute', clavinet: 'sd-clav', steel_drums: 'sd-steel-drum',
  drawbar_organ: 'sd-organ', rock_organ: 'sd-rock-organ', pizzicato_strings: 'sd-pizzicato',
};
/**
 * Genre-idiomatic patches per role, ahead of the generic preset mapping: house hooks are M1-style piano / organ
 * stabs, plucks and vowel "vocal chop" synths — never a soft e-piano as the lead; deep house keeps the Rhodes for
 * chords with a filtered pluck hook; tech house a muted bleep over short stabs; techno a hypnotic
 * filtered pluck (the 303 acid lead stays with acid-flavoured genres: psytrance, breakbeat); trance the supersaw (generic mapping).
 */
export const GENRE_STRUDEL = {
  house: { lead: 'sd-house-piano' },
  'deep-house': { lead: 'sd-pluck-hook' },
  'tech-house': { lead: 'sd-tech-bleep', chords: 'sd-tech-stab' },
  techno: { lead: 'sd-techno-pluck' },
  'progressive-house': { chords: 'sd-pluck-hook' },
  'uk-garage': { lead: 'sd-vowel-lead', chords: 'sd-house-organ' },
  'two-step': { lead: 'sd-vowel-lead' },
  'nu-disco': { lead: 'sd-pluck-hook' },
  rnb: { lead: 'sd-soft-lead' },
  amapiano: { lead: 'sd-house-piano' },
  breakbeat: { lead: 'sd-vowel-lead' },
  eurobeat: { lead: 'sd-supersaw-lead' },
};
/** Roles that carry the hook: a soft e-piano never plays them in dance music. */
const SOFT_KEYS = new Set(['sd-rhodes', 'sd-fm-epiano', 'sd-lofi-keys']);
const DANCE_FAMILIES = new Set(['house', 'techno', 'trance', 'garage', 'breaks', 'bass', 'dnb', 'hard']);

/** Genre-specific Strudel def for a role (null: use the generic mapping). */
export function genreStrudel(role, genre) {
  const id = GENRE_STRUDEL[genre?.id]?.[role] || null;
  return id ? { type: 'strudel', preset: id, params: {}, fallbackPreset: PRESETS[id].fallbackPreset } : null;
}
/** Guard: a dance-music lead / counter-melody mapped to a soft e-piano becomes a plucky hook synth. */
export function hookSafe(def, role, genre) {
  if (def?.type !== 'strudel' || !['lead', 'counter'].includes(role) || !SOFT_KEYS.has(def.preset) || !DANCE_FAMILIES.has(genre?.family)) return def;
  return { type: 'strudel', preset: 'sd-pluck-hook', params: {}, fallbackPreset: PRESETS['sd-pluck-hook'].fallbackPreset };
}

/** Stylised presets whose patch beats the plain GM instrument the genre names (lofi keys = a filtered, wobbly EP). */
const STYLE_FIRST = new Set(['lofi-keys']);

/** The Strudel patch id an instrument def maps to (null: keep the def). */
export function strudelPatchFor(def) {
  if (!def || def.type === 'drums' || def.type === 'drumsampler' || def.type === 'strudel') return null;
  const preset = def.preset || def.fallbackPreset || null;
  const gm = def.type === 'soundfont' ? String(def.params?.instrument || '') : null;
  if (preset && STYLE_FIRST.has(preset) && PRESET_STRUDEL[preset]) return PRESET_STRUDEL[preset];
  if (gm) return GM_STRUDEL[gm] || null; // a GM instrument without a superdough counterpart keeps its samples
  return (preset && PRESET_STRUDEL[preset]) || null;
}

/**
 * Instrument def -> 'strudel' def {type:'strudel', preset: patch id, params: {}, fallbackPreset} (or the def itself
 * when it has no Strudel counterpart). fallbackPreset = the def's own built-in preset (else the patch's).
 */
export function toStrudel(def) {
  const id = strudelPatchFor(def);
  if (!id || !PRESETS[id]) return def;
  const own = def.preset && PRESETS[def.preset]?.instrument.type !== 'strudel' ? def.preset : def.fallbackPreset;
  const fallbackPreset = own && PRESETS[own] ? own : PRESETS[id].fallbackPreset;
  return { type: 'strudel', preset: id, params: {}, fallbackPreset };
}
