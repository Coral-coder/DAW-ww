// Instrument factory: resolves a project Instrument def (type/preset/params) and drives the
// matching engine. Works with AudioContext and OfflineAudioContext.
import { SynthInstrument } from './synth.js';
import { FMInstrument } from './fm.js';
import { OrganInstrument } from './organ.js';
import { DrumInstrument } from './drums.js';
import { SamplerInstrument } from './sampler.js';
import { resolveInstrumentDef, listPresets as _listPresets, PRESETS, PRESET_CATEGORIES } from './presets.js';
import { INSTRUMENT_DEFS, getParamDefaults } from './defs.js';
import { DRUM_KITS } from './kits.js';
import { PluginInstrument, isPluginType } from './plugin-instrument.js';

export { PRESETS, PRESET_CATEGORIES, INSTRUMENT_DEFS, getParamDefaults, DRUM_KITS };

export const INSTRUMENT_TYPES = [
  { type: 'synth', label: 'Subtractive Synth', description: '3 oscillators, unison/supersaw, multimode filter, 2 LFOs, mono/glide' },
  { type: 'fm', label: 'FM Synth', description: '4-operator FM with 11 algorithms — e-pianos, bells, basses' },
  { type: 'organ', label: 'Drawbar Organ', description: '9 drawbars, percussion, key click, scanner vibrato, rotary speaker' },
  { type: 'drums', label: 'Drum Machine', description: '16 synthesized pads, 20 kits, per-pad tune/decay/tone or samples' },
  { type: 'sampler', label: 'Sampler', description: 'Pitched / sliced playback of a project sample with ADSR and filter' },
];

const ENGINES = { synth: SynthInstrument, fm: FMInstrument, organ: OrganInstrument, drums: DrumInstrument, sampler: SamplerInstrument };

/** Merge defaults ← preset ← def.params (preset type wins on mismatch). -> { type, params } */
export function resolveInstrument(def) { return resolveInstrumentDef(def); }

/** listPresets({category, role, genre, type}) -> [{id, name, category, roles, genres, instrument}] */
export function listPresets(filter) { return _listPresets(filter); }

function warn(e) { if (typeof console !== 'undefined') console.warn('[instrument]', e); }

export class Instrument {
  constructor(ctx, output, instrumentDef, opts = {}) {
    this.ctx = ctx;
    this.output = output;
    this.opts = opts || {};
    this.engine = null;
    this.type = null;
    this.params = null;
    this.update(instrumentDef);
  }
  /** Live param change. Changing type swaps the engine (old voices fade out). */
  update(instrumentDef) {
    const { type, params } = resolveInstrument(instrumentDef);
    this.def = instrumentDef;
    if (!this.engine || this.type !== type) {
      const old = this.engine;
      this.engine = isPluginType(type) ? new PluginInstrument(type, this.ctx, this.output, params, this.opts) : new ENGINES[type](this.ctx, this.output, params, this.opts);
      if (old) { try { old.dispose(); } catch (e) { warn(e); } }
    } else {
      try { this.engine.setParams(params); } catch (e) { warn(e); }
    }
    this.type = type;
    this.params = params;
  }
  trigger(time, pitch, vel, durSec, extra) {
    try { this.engine.trigger(time, pitch, vel, durSec, extra || {}); } catch (e) { warn(e); }
  }
  noteOn(pitch, vel, time) { try { this.engine.noteOn(pitch, vel, time); } catch (e) { warn(e); } }
  noteOff(pitch, time) { try { this.engine.noteOff(pitch, time); } catch (e) { warn(e); } }
  allNotesOff(time) { try { this.engine.allNotesOff(time); } catch (e) { warn(e); } }
  /** Plugin instruments (soundfont/faust/wam): resolves true when playable, false on failure. Built-ins: null. */
  get ready() { return this.engine?.ready ?? null; }
  /** User-facing load error of a plugin instrument (null when fine). */
  get error() { return this.engine?.error ?? null; }
  /** value -1..1 (synth only; others ignore). */
  pitchBend(value, time) { try { this.engine.pitchBend?.(value, time); } catch (e) { warn(e); } }
  /** Number of currently allocated voices (for meters/debug). */
  get activeVoices() { return this.engine ? [...this.engine.voices].filter((v) => !v.done).length : 0; }
  dispose() { try { this.engine?.dispose(); } catch (e) { warn(e); } this.engine = null; }
}

export function createInstrument(ctx, output, instrumentDef, opts) {
  return new Instrument(ctx, output, instrumentDef, opts);
}
