// Synchronous facade for plugin instruments (soundfont / faust / wam). The real engine lives in
// src/plugins/* and is imported lazily, so the core app never depends on network availability.
// `ready` resolves (never rejects) once the plugin can play: true = loaded, false = failed
// (`error` then holds a user-facing message). Notes arriving before that are dropped.
const LOADERS = {
  soundfont: () => import('../plugins/soundfont.js'),
  faust: () => import('../plugins/faust.js'),
  wam: () => import('../plugins/wam.js'),
};

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
  /** The live plugin engine (FaustEngine / SoundfontEngine / WamEngine) or null while loading. */
  get plugin() { return this.impl; }

  setParams(params) { this.params = params; this.impl?.setParams(params); }
  reload() { return this.impl?.reload ? this.impl.reload() : this.ready; }
  trigger(time, pitch, vel, durSec) { this.impl?.trigger(time, pitch, vel, durSec); }
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
