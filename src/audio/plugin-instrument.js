// Synchronous facade for plugin instruments (soundfont / faust / wam). The real engine lives in
// src/plugins/* and is imported lazily, so the core app never depends on network availability.
// `ready` resolves (never rejects) once the plugin can play: true = loaded, false = failed
// (`error` then holds a user-facing message). Notes arriving before that are dropped.
const LOADERS = {
  soundfont: () => import('../plugins/soundfont.js'),
  faust: () => import('../plugins/faust.js'),
  wam: () => import('../plugins/wam.js'),
  native: () => import('../plugins/native.js'),
};

import { getStatus, setStatus, pluginKey, soundfontSourceUrl } from '../plugins/status.js';

const setStatusInfo = (key, f) => setStatus(key, { ...getStatus(key), info: { params: f.params, name: f.meta?.name } });

export const PLUGIN_TYPES = Object.keys(LOADERS);
export const isPluginType = (type) => Object.prototype.hasOwnProperty.call(LOADERS, type);

export class PluginInstrument {
  constructor(type, ctx, output, params, opts = {}) {
    this.type = type;
    this.ctx = ctx;
    this.output = output;
    this.params = params;
    this.opts = opts;
    this.impl = null;
    this.disposed = false;
    this._error = null;
    this._loaded = LOADERS[type]().then((m) => {
      if (this.disposed) return null;
      this.impl = new m.Engine(ctx, output, this.params, opts);
      return this.impl;
    }, (e) => {
      this._error = `Could not load the ${type} plugin host: ${e?.message || e}`;
      return null;
    });
  }

  /** Resolves true when the plugin is playable, false on failure. Re-read after setParams (a new source reloads). */
  get ready() {
    return this._loaded.then((impl) => (impl ? impl.ready : false));
  }

  get error() { return this._error || this.impl?.error || null; }
  get voices() { return this.impl?.voices || []; }
  /** Latency (s) the plugin reports once loaded (WAM getCompensationDelay), else 0. */
  get latency() { return Number(this.impl?.latency) || 0; }
  /** The live plugin engine (FaustEngine / SoundfontEngine / WamEngine) or null while loading. */
  get plugin() { return this.impl; }

  setParams(params) { this.params = params; this.impl?.setParams(params); }
  reload() { return this.impl?.reload ? this.impl.reload() : this.ready; }
  trigger(time, pitch, vel, durSec, extra) { this.impl?.trigger(time, pitch, vel, durSec, extra); }
  noteOn(pitch, vel, time) { this.impl?.noteOn(pitch, vel, time); }
  noteOff(pitch, time) { this.impl?.noteOff(pitch, time); }
  allNotesOff(time) { this.impl?.allNotesOff(time); }
  dispose() { this.disposed = true; try { this.impl?.dispose(); } catch { /* */ } this.impl = null; }
}

/**
 * Wait until every plugin instrument / effect of a MixGraph can play (offline renders call this
 * before scheduling). Failed plugins stay silent (instrument) or pass audio through (effect); each
 * failure is reported once via onError. Never rejects.
 */
export async function awaitPluginsReady(graph, project, onError = () => {}, timeoutMs = 60000) {
  const jobs = [];
  const name = (id) => project?.tracks?.find((t) => t.id === id)?.name || 'track';
  for (const [id, e] of graph.tracks || []) {
    const inst = e.instrument;
    if (inst?.ready) {
      jobs.push(Promise.resolve(inst.ready).then((ok) => {
        if (!ok) onError(new Error(`“${name(id)}”: ${inst.error || 'plugin instrument failed to load'} — rendered silent.`));
        else if (inst.type === 'wam') onError(new Error(`“${name(id)}” uses a Web Audio Module: WAMs are made for live playback and some are rendered silent in exports — if so, record the track live instead.`));
      }));
    }
  }
  const strips = [graph.master, ...(graph.buses?.values?.() || []), ...[...(graph.tracks?.values?.() || [])].map((e) => e.strip)];
  for (const s of strips) {
    for (const fx of s?.effects || []) {
      const r = fx.fx?.ready;
      if (r) jobs.push(Promise.resolve(r).then((ok) => { if (!ok) onError(new Error(`Plugin effect: ${fx.fx.error || 'failed to load'} — bypassed.`)); }));
    }
  }
  if (!jobs.length) return;
  let timer;
  await Promise.race([
    Promise.all(jobs),
    new Promise((resolve) => { timer = setTimeout(() => { onError(new Error('Some plugins took too long to load — they are silent in this render.')); resolve(); }, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

/** True once a soundfont instrument def ({type:'soundfont', params:{library, instrument}}) is decoded. */
export function isSoundfontReady(def) {
  if (def?.type !== 'soundfont') return false;
  return getStatus(pluginKey({ type: 'soundfont', params: def.params || {} })).state === 'ready';
}

/** Plugin status of any instrument def: {state:'idle'|'loading'|'ready'|'error', progress, error}. */
export function pluginStatus(def) {
  const key = pluginKey(def);
  return key ? getStatus(key) : { state: 'ready', progress: 1 };
}

/**
 * Start downloading / decoding a plugin instrument ahead of playback (e.g. on project load).
 * Soundfonts are fully preloaded (shared bank cache); Faust programs are compiled. Resolves
 * true/false, never rejects. Built-in instrument types resolve true immediately.
 */
export async function preloadInstrument(def, { sampleRate = 44100 } = {}) {
  try {
    if (def?.type === 'soundfont') {
      const m = await import('../plugins/soundfont.js');
      if (def.params?.multisample) {
        // multisampled instrument (falls back to the GM file inside the engine): warm the shared caches
        const ctx = new OfflineAudioContext(1, 1, sampleRate);
        const eng = new m.SoundfontEngine(ctx, ctx.destination, def.params);
        return await eng.ready;
      }
      await m.loadSoundfontWithStatus(soundfontSourceUrl(def.params || {}), sampleRate);
      return true;
    }
    if (def?.type === 'faust' && def.params?.code) {
      const m = await import('../plugins/faust.js');
      const f = await m.getFaustFactory(def.params.code, 'poly');
      const key = pluginKey(def);
      if (getStatus(key).state !== 'ready') setStatusInfo(key, f);
      return true;
    }
    return !isPluginType(def?.type) || def?.type === 'wam' || def?.type === 'native';
  } catch {
    return false;
  }
}

/**
 * Offline renders: AudioWorklet-based plugins receive notes through MessagePorts, which an
 * OfflineAudioContext may not deliver while it renders. Call (and await) this after scheduling and
 * before startRendering()/resume() so every posted note has reached its processor. Never rejects.
 */
export async function flushPlugins(graph) {
  const jobs = [];
  for (const e of graph.tracks?.values?.() || []) {
    const pl = e.instrument?.engine?.plugin;
    if (pl?.flush) jobs.push(pl.flush().catch(() => {}));
  }
  if (jobs.length) await Promise.all(jobs);
}
