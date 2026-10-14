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
import { DrumSamplerInstrument, usesDrumSampler } from './library/drum-sampler.js';
import { StrudelVoice } from './strudel-voice.js';

export { PRESETS, PRESET_CATEGORIES, INSTRUMENT_DEFS, getParamDefaults, DRUM_KITS };

export const INSTRUMENT_TYPES = [
  { type: 'synth', label: 'Subtractive Synth', description: '3 oscillators, unison/supersaw, multimode filter, 2 LFOs, mono/glide' },
  { type: 'fm', label: 'FM Synth', description: '4-operator FM with 11 algorithms — e-pianos, bells, basses' },
  { type: 'organ', label: 'Drawbar Organ', description: '9 drawbars, percussion, key click, scanner vibrato, rotary speaker' },
  { type: 'drums', label: 'Drum Machine', description: '16 synthesized pads, 20 kits, per-pad tune/decay/tone or samples' },
  { type: 'sampler', label: 'Sampler', description: 'Pitched / sliced playback of a project sample with ADSR and filter' },
  { type: 'drumsampler', label: 'Sampled Drum Machine', description: 'Real samples of 35 classic drum machines (TR-808/909, LinnDrum, SP-12, MPC60…) — synth kit fallback offline' },
  { type: 'strudel', label: 'Strudel Sound', description: 'Strudel\'s own audio engine (superdough): its synths, samples and GM soundfonts with filter envelopes, FM, vowel, room & delay — the fallback preset plays if it can\'t load' },
];

const ENGINES = { synth: SynthInstrument, fm: FMInstrument, organ: OrganInstrument, drums: DrumInstrument, sampler: SamplerInstrument, drumsampler: DrumSamplerInstrument, strudel: StrudelVoice };
/** Built-in preset a 'strudel' instrument falls back to when superdough / its sound can't load. */
export function strudelFallbackPreset(def) {
  const id = def?.fallbackPreset || PRESETS[def?.preset]?.fallbackPreset;
  return id && PRESETS[id] && PRESETS[id].instrument.type !== 'strudel' ? id : 'pluck';
}

/** Merge defaults ← preset ← def.params (preset type wins on mismatch). -> { type, params } */
export function resolveInstrument(def) { return resolveInstrumentDef(def); }

/** listPresets({category, role, genre, type}) -> [{id, name, category, roles, genres, instrument}] */
export function listPresets(filter) { return _listPresets(filter); }

/** What identifies a plugin's source (code / url / soundfont instrument), without its live control values. */
function pluginSourceKey(type, params = {}) {
  const { values, gain, ...rest } = params || {};
  return `${type}:${JSON.stringify(rest)}`;
}

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
    // 'drums' with params.machine plays real drum-machine samples (src/audio/library) — same engine as 'drumsampler'
    const kind = usesDrumSampler(type, params) ? 'drumsampler' : type;
    // A plugin that failed to load and was replaced by its fallback synth: rebuild only if the plugin settings change.
    // (only the plugin's source counts — turning its knobs must not tear down the stand-in synth and re-download)
    const pluginKeyJson = isPluginType(type) ? pluginSourceKey(type, params) : null;
    const retryPlugin = this.fallbackActive && pluginKeyJson !== this._pluginParamsJson;
    if (this.fallbackActive && !retryPlugin && this.type === type) { this.def = instrumentDef; return; }
    if (!this.engine || this.type !== type || this._kind !== kind || retryPlugin) {
      const old = this.engine;
      this._kind = kind;
      this.fallbackActive = false;
      this._fallbackReady = null;
      this.engine = isPluginType(type) ? new PluginInstrument(type, this.ctx, this.output, params, this.opts)
        : kind === 'strudel' ? new StrudelVoice(this.ctx, this.output, params, { ...this.opts, makeFallback: () => this._fallbackEngine(strudelFallbackPreset(instrumentDef)) })
          : new ENGINES[kind](this.ctx, this.output, params, this.opts);
      if (old) { try { old.dispose(); } catch (e) { warn(e); } }
      if (isPluginType(type)) {
        this._pluginParamsJson = pluginKeyJson;
        if (instrumentDef?.fallbackPreset) this._watchFallback(this.engine, instrumentDef.fallbackPreset);
      }
    } else {
      try { this.engine.setParams(params); } catch (e) { warn(e); }
    }
    this.type = type;
    this.params = params;
  }
  /** A built-in engine playing preset `presetId` (fallback of 'strudel' instruments). */
  _fallbackEngine(presetId) {
    const fb = resolveInstrument({ preset: presetId, params: {} });
    const Engine = fb.type !== 'strudel' && ENGINES[fb.type];
    return Engine ? new Engine(this.ctx, this.output, fb.params, this.opts) : null;
  }
  /** If the plugin fails to load, swap in the built-in preset `fallbackPreset` so the track never goes silent. */
  _watchFallback(engine, presetId) {
    this._fallbackReady = Promise.resolve(engine.ready).then((ok) => {
      if (ok || this.engine !== engine) return ok;
      const fb = resolveInstrument({ preset: presetId, params: {} });
      const Engine = ENGINES[fb.type];
      if (!Engine) return false;
      warn(`plugin failed (${engine.error || 'unknown error'}) — using preset "${presetId}" instead`);
      this.engine = new Engine(this.ctx, this.output, fb.params, this.opts);
      this.fallbackActive = true;
      try { engine.dispose(); } catch (e) { warn(e); }
      return true;
    }, () => false);
  }
  trigger(time, pitch, vel, durSec, extra) {
    try {
      // flam: a soft grace stroke, then the main stroke 16 ms later (any engine; used on drum fills)
      if (extra?.flam > 0) {
        const { flam, ...rest } = extra;
        this.engine.trigger(time, pitch, Math.max(0.02, vel * flam), Math.min(durSec, 0.05), rest);
        this.engine.trigger(time + 0.016, pitch, vel, durSec, rest);
        return;
      }
      this.engine.trigger(time, pitch, vel, durSec, extra || {});
    } catch (e) { warn(e); }
  }
  noteOn(pitch, vel, time) { try { this.engine.noteOn(pitch, vel, time); } catch (e) { warn(e); } }
  noteOff(pitch, time) { try { this.engine.noteOff(pitch, time); } catch (e) { warn(e); } }
  allNotesOff(time) { try { this.engine.allNotesOff(time); } catch (e) { warn(e); } }
  /** Plugin instruments (soundfont/faust/wam): resolves true when playable, false on failure. Built-ins: null. */
  get ready() { return this._fallbackReady || (this.engine?.ready ?? null); }
  /** Processing latency (s): the def's manual `latency` (samples) or what the engine / plugin reports (PDC). */
  get latency() {
    const man = Number(this.def?.latency);
    if (Number.isFinite(man) && man >= 0 && this.def?.latency != null) return man / this.ctx.sampleRate;
    const l = Number(this.engine?.latency);
    return Number.isFinite(l) && l > 0 ? l : 0;
  }
  /** User-facing load error of a plugin instrument (null when fine or when the fallback preset is playing). */
  get error() { return this.fallbackActive ? null : (this.engine?.error ?? null); }
  /** value -1..1 (synth only; others ignore). */
  pitchBend(value, time) { try { this.engine.pitchBend?.(value, time); } catch (e) { warn(e); } }
  /** Number of currently allocated voices (for meters/debug). */
  get activeVoices() { return this.engine ? [...this.engine.voices].filter((v) => !v.done).length : 0; }
  dispose() { try { this.engine?.dispose(); } catch (e) { warn(e); } this.engine = null; }
}

export function createInstrument(ctx, output, instrumentDef, opts) {
  return new Instrument(ctx, output, instrumentDef, opts);
}
