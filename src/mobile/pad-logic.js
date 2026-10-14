// Pocket drum pad settings — pure mapping from a drum track + pad to the pad ParamDefs the desktop device panel
// uses (INSTRUMENT_DEFS.drums.padParams: tune / decay / tone / gain / pan / variant / mute), stored in
// track.instrument.params.pads[padKey][key] and automatable as 'inst:pads.<padKey>.<key>'.
import { INSTRUMENT_DEFS } from '../audio/defs.js';
import { resolveInstrumentDef } from '../audio/presets.js';
import { DRUM_PADS } from '../core/model.js';
import { deepClone } from '../core/util.js';

export const PAD_KEYS_ORDER = ['tune', 'decay', 'tone', 'gain', 'pan', 'variant', 'mute'];

const isDrumType = (type) => type === 'drums' || type === 'drumsampler';

/** Resolved instrument of a drum track ({type, params}) or null. */
export function drumInstrument(track) {
  if (track?.type !== 'instrument' || !track.instrument) return null;
  const r = resolveInstrumentDef(track.instrument);
  return isDrumType(r.type) ? r : null;
}

/** Is the kit made of real samples (so a pad has variations to choose from)? */
export const isSampledKit = (r) => !!r && (r.type === 'drumsampler' || !!r.params?.machine);

/** Pad ParamDefs shown in the pad sheet, in display order (Variation only for sampled machines). */
export function padDefs(track) {
  const r = drumInstrument(track);
  if (!r) return [];
  const defs = INSTRUMENT_DEFS[r.type]?.padParams || INSTRUMENT_DEFS.drums.padParams;
  return PAD_KEYS_ORDER.map((k) => defs.find((d) => d.key === k)).filter((d) => d && (d.key !== 'variant' || isSampledKit(r)));
}

export const padAutoTarget = (padKey, key) => `inst:pads.${padKey}.${key}`;
export const padByPitch = (pitch) => DRUM_PADS.find((p) => p.pitch === pitch) || null;

/** Current value of a pad param (resolved, default when unset). */
export function readPad(track, padKey, def) {
  const r = drumInstrument(track);
  const v = r?.params?.pads?.[padKey]?.[def.key];
  return v === undefined || v === null ? def.default : v;
}

/** Mutator: set a pad param on a drum track (pads copied from the resolved kit on first edit, like the desktop). */
export function writePad(track, padKey, key, value) {
  const r = drumInstrument(track);
  if (!r) return false;
  const params = (track.instrument.params = track.instrument.params || {});
  if (!params.pads) params.pads = deepClone(r.params?.pads || {});
  if (!params.pads[padKey]) params.pads[padKey] = {};
  params.pads[padKey][key] = value;
  return true;
}

/** Pads that have non-default settings (a dot on their name). */
export function editedPads(track) {
  const r = drumInstrument(track);
  const out = new Set();
  if (!r) return out;
  const defs = padDefs(track);
  for (const [k, o] of Object.entries(r.params?.pads || {})) if (defs.some((d) => o?.[d.key] !== undefined && o[d.key] !== d.default)) out.add(k);
  return out;
}
