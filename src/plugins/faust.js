// Faust host: compiles Faust DSP source in the browser with @grame/faustwasm (loaded lazily from
// jsDelivr) and runs it as AudioWorklet nodes — polyphonic instruments (freq/gain/gate voices) and
// stereo effects. Works in AudioContext and OfflineAudioContext. Browser-only.
import { hashString } from './github.js';
import { fetchText } from './fetch-cache.js';
import { setStatus, pluginKey, friendlyError, userError } from './status.js';

export const FAUSTWASM_VERSION = '0.19.0';
export const FAUSTWASM_BASE = `https://cdn.jsdelivr.net/npm/@grame/faustwasm@${FAUSTWASM_VERSION}`;
const ARGS = '-ftz 2';
const VOICE_KEYS = new Set(['freq', 'gain', 'gate', 'key', 'vel', 'velocity']);

let compilerPromise = null;
let queue = Promise.resolve(); // libfaust compiles one program at a time
const factories = new Map(); // `${mode}:${hash}` -> Promise<Factory>

/** Lazy-load the Faust compiler (≈6 MB, cached by the browser). -> { F, compiler, version } */
export function loadFaustCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const F = await import(/* webpackIgnore: true */ `${FAUSTWASM_BASE}/dist/esm/index.js`);
      const mod = await F.instantiateFaustModuleFromFile(`${FAUSTWASM_BASE}/libfaust-wasm/libfaust-wasm.js`);
      const lib = new F.LibFaust(mod);
      return { F, compiler: new F.FaustCompiler(lib), version: lib.version() };
    })();
    compilerPromise.catch(() => { compilerPromise = null; });
  }
  return compilerPromise;
}

const stripComments = (code) => String(code).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
export const hasEffectSection = (code) => /(^|[;\s])effect\s*=/.test(stripComments(code));
export const looksPolyphonic = (code) => {
  const c = stripComments(code);
  return /\(\s*"(?:[^"]*\/)?\s*freq\s*(?:\[|")/.test(c) && /\(\s*"(?:[^"]*\/)?\s*gate\s*(?:\[|")/.test(c);
};

/** Flatten a Faust UI JSON tree into knob descriptors. */
export function faustParams(ui, { skipVoice = false } = {}) {
  const out = [];
  const walk = (items, groups) => {
    for (const it of items || []) {
      if (it.items) { walk(it.items, groups.concat(it.label)); continue; }
      if (!it.address) continue;
      const short = String(it.label || it.address.split('/').pop());
      if (skipVoice && VOICE_KEYS.has(short.toLowerCase())) continue;
      if (/bargraph/.test(it.type)) continue;
      const meta = Object.assign({}, ...(it.meta || []));
      const isBool = it.type === 'button' || it.type === 'checkbox';
      out.push({
        address: it.address,
        label: short,
        type: isBool ? 'bool' : 'number',
        min: isBool ? 0 : Number(it.min ?? 0),
        max: isBool ? 1 : Number(it.max ?? 1),
        step: isBool ? 1 : Number(it.step) || 0.01,
        init: isBool ? 0 : Number(it.init ?? it.min ?? 0),
        unit: meta.unit || '',
        scale: meta.scale || 'lin',
        tooltip: meta.tooltip || '',
        section: groups.slice(1).join(' / ') || 'Parameters',
        button: it.type === 'button',
      });
    }
  };
  for (const root of ui || []) walk([root], []);
  return out;
}

/**
 * Compile (once per source + mode) -> { mode, generator, ui, params, meta, hash }
 * mode: 'poly' (instrument) | 'mono' (effect / generator)
 */
export function getFaustFactory(code, mode = 'poly', { onStage } = {}) {
  const hash = hashString(code);
  const key = `${mode}:${hash}`;
  if (factories.has(key)) return factories.get(key);
  const p = (async () => {
    onStage?.('Loading the Faust compiler…');
    const { F, compiler } = await loadFaustCompiler();
    onStage?.('Compiling…');
    const run = async () => {
      const name = 'dsp' + hash;
      let generator, uiJson;
      try {
        if (mode === 'poly') {
          generator = new F.FaustPolyDspGenerator();
          if (hasEffectSection(code)) {
            await generator.compile(compiler, name, code, ARGS);
          } else {
            generator.voiceFactory = await compiler.createPolyDSPFactory(name, code, ARGS);
            if (!generator.voiceFactory) throw new Error('compilation failed');
            generator.effectFactory = null;
            generator.name = name;
            const isDouble = /-double/.test(JSON.parse(generator.voiceFactory.json).compile_options || '');
            const { mixerBuffer, mixerModule } = await compiler.getAsyncInternalMixerModule(isDouble);
            generator.mixerBuffer = mixerBuffer;
            generator.mixerModule = mixerModule;
          }
          if (!generator.voiceFactory) throw new Error('compilation failed');
          const voice = JSON.parse(generator.voiceFactory.json);
          const fx = generator.effectFactory ? JSON.parse(generator.effectFactory.json) : null;
          uiJson = [...(voice.ui || []), ...(fx?.ui || [])];
          return { mode, generator, hash, meta: voice, ui: uiJson, params: faustParams(uiJson, { skipVoice: true }), inputs: voice.inputs, outputs: voice.outputs };
        }
        generator = new F.FaustMonoDspGenerator();
        const r = await generator.compile(compiler, name, code, ARGS);
        if (!r || !generator.factory) throw new Error('compilation failed');
        const meta = JSON.parse(generator.factory.json);
        return { mode, generator, hash, meta, ui: meta.ui, params: faustParams(meta.ui), inputs: meta.inputs, outputs: meta.outputs };
      } catch (e) {
        const msg = String(e?.message || e).replace(/^Error:\s*/, '').trim();
        throw userError(`Faust compile error: ${msg || 'unknown error'}`);
      }
    };
    const job = queue.then(run, run);
    queue = job.catch(() => {});
    return job;
  })();
  factories.set(key, p);
  p.catch(() => factories.delete(key));
  return p;
}

/** Fetch Faust source from a (CDN) URL. */
export async function fetchFaustSource(url) {
  const text = await fetchText(url);
  if (!/process\s*=/.test(text)) throw userError('That file has no “process = …;” definition — is it a Faust .dsp file?');
  return text;
}

async function resolveCode(params) {
  if (params.code && String(params.code).trim()) return params.code;
  if (params.url) return fetchFaustSource(params.url);
  throw userError('No Faust source code.');
}

function applyValues(node, factory, values, time) {
  if (!node || !values) return;
  const known = new Set(factory.params.map((p) => p.address));
  for (const [addr, v] of Object.entries(values)) {
    if (!known.has(addr) || !Number.isFinite(Number(v))) continue;
    try { node.setParamValue(addr, Number(v), time); } catch { try { node.setParamValue(addr, Number(v)); } catch { /* */ } }
  }
}

// ----------------------------------------------------------------------------- instrument
export class FaustEngine {
  constructor(ctx, output, params, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.out = ctx.createGain();
    this.out.connect(output);
    this.node = null;
    this.factory = null;
    this.voices = [];
    this.error = null;
    this._sig = null;
    this._values = {};
    this.ready = Promise.resolve(false);
    this.setParams(params);
  }

  get key() { return pluginKey({ type: 'faust', params: this.p }); }

  setParams(p) {
    this.p = p || {};
    try { this.out.gain.setTargetAtTime(Math.max(0, Number(this.p.gain ?? 0.8)), this.ctx.currentTime, 0.01); } catch { /* */ }
    const sig = `${hashString(this.p.code || '')}|${this.p.url || ''}|${Math.round(this.p.voices || 8)}`;
    if (sig !== this._sig) {
      this._sig = sig;
      this.ready = this._build(sig);
      return;
    }
    if (this.node && this.factory) {
      const vals = this.p.values || {};
      const changed = {};
      for (const [k, v] of Object.entries(vals)) if (this._values[k] !== v) changed[k] = v;
      applyValues(this.node, this.factory, changed);
      this._values = { ...vals };
    }
  }

  reload() { this._sig = null; this.setParams(this.p); return this.ready; }

  async _build(sig) {
    const key = this.key;
    this.error = null;
    const old = this.node;
    this.node = null;
    if (old) this._retire(old);
    const stage = (message) => setStatus(key, { state: 'loading', progress: null, message });
    stage('Preparing…');
    try {
      const code = await resolveCode(this.p);
      if (!looksPolyphonic(code)) throw userError('Faust instruments need “freq”, “gain” and “gate” controls (the polyphonic voice convention).');
      const factory = await getFaustFactory(code, 'poly', { onStage: stage });
      if (sig !== this._sig) return false;
      const voices = Math.max(1, Math.min(32, Math.round(this.p.voices || 8)));
      const node = await factory.generator.createNode(this.ctx, voices);
      if (!node) throw userError('Faust could not create the audio node.');
      if (sig !== this._sig) { this._retire(node); return false; }
      node.connect(this.out);
      this.node = node;
      this.factory = factory;
      this._values = { ...(this.p.values || {}) };
      applyValues(node, factory, this._values);
      setStatus(key, { state: 'ready', progress: 1, message: `${factory.params.length} controls`, info: { params: factory.params, name: factory.meta?.name || this.p.name } });
      return true;
    } catch (e) {
      const message = friendlyError(e, { url: this.p.url, kind: 'faust' });
      this.error = message;
      setStatus(key, { state: 'error', error: message, message });
      return false;
    }
  }

  _retire(node) {
    try { node.allNotesOff?.(true); } catch { /* */ }
    setTimeout(() => { try { node.disconnect(); } catch { /* */ } try { node.destroy?.(); } catch { /* */ } }, 300);
  }

  _pitch(pitch) { return Math.max(0, Math.min(127, Math.round(pitch + Number(this.p.transpose || 0)))); }
  _time(t) { return Math.max(t ?? this.ctx.currentTime, this.ctx.currentTime); }

  trigger(time, pitch, vel, durSec) {
    if (!this.node) return;
    const k = this._pitch(pitch);
    const t = this._time(time);
    this.node.keyOn(0, k, Math.max(1, Math.round((vel ?? 0.8) * 127)), t);
    this.node.keyOff(0, k, 0, t + Math.max(0.005, durSec));
  }

  noteOn(pitch, vel, time) {
    if (!this.node) return;
    this.node.keyOn(0, this._pitch(pitch), Math.max(1, Math.round((vel ?? 0.8) * 127)), this._time(time));
  }

  noteOff(pitch, time) { this.node?.keyOff(0, this._pitch(pitch), 0, this._time(time)); }

  allNotesOff() { try { this.node?.allNotesOff(true); } catch { /* */ } }

  dispose() {
    this._sig = '#disposed';
    if (this.node) this._retire(this.node);
    this.node = null;
    const out = this.out;
    setTimeout(() => { try { out.disconnect(); } catch { /* */ } }, 350);
  }
}

// ----------------------------------------------------------------------------- effect
/**
 * Effect implementation for src/audio/plugin-fx.js: wires `input` -> faust node -> `output`.
 * Until the node exists (or when it fails) the effect passes audio through unchanged.
 */
export class FaustEffect {
  constructor(ctx, input, output) {
    this.ctx = ctx;
    this.input = input;
    this.output = output;
    this.node = null;
    this.factory = null;
    this.error = null;
    this._sig = null;
    this._values = {};
    this.thru = true;
    input.connect(output);
    this.ready = Promise.resolve(false);
  }

  get key() { return pluginKey({ type: 'faust', params: this.p }); }

  setParams(p) {
    this.p = p || {};
    const sig = `${hashString(this.p.code || '')}|${this.p.url || ''}`;
    if (sig !== this._sig) { this._sig = sig; this.ready = this._build(sig); return; }
    if (this.node && this.factory) {
      const vals = this.p.values || {};
      const changed = {};
      for (const [k, v] of Object.entries(vals)) if (this._values[k] !== v) changed[k] = v;
      applyValues(this.node, this.factory, changed);
      this._values = { ...vals };
    }
  }

  reload() { this._sig = null; this.setParams(this.p); return this.ready; }

  _passThrough(on) {
    if (on === this.thru) return;
    this.thru = on;
    try { if (on) this.input.connect(this.output); else this.input.disconnect(this.output); } catch { /* */ }
  }

  async _build(sig) {
    const key = this.key;
    this.error = null;
    if (this.node) { const n = this.node; this.node = null; this._passThrough(true); setTimeout(() => { try { n.disconnect(); n.destroy?.(); } catch { /* */ } }, 100); }
    const stage = (message) => setStatus(key, { state: 'loading', progress: null, message });
    stage('Preparing…');
    try {
      const code = await resolveCode(this.p);
      const factory = await getFaustFactory(code, 'mono', { onStage: stage });
      if (sig !== this._sig) return false;
      if (!factory.inputs) throw userError('This Faust program has no audio inputs — load it as an instrument instead.');
      const node = await factory.generator.createNode(this.ctx);
      if (!node) throw userError('Faust could not create the audio node.');
      if (sig !== this._sig) { try { node.disconnect(); node.destroy?.(); } catch { /* */ } return false; }
      this.input.connect(node);
      node.connect(this.output);
      this._passThrough(false);
      this.node = node;
      this.factory = factory;
      this._values = { ...(this.p.values || {}) };
      applyValues(node, factory, this._values);
      setStatus(key, { state: 'ready', progress: 1, message: `${factory.params.length} controls`, info: { params: factory.params, name: factory.meta?.name || this.p.name } });
      return true;
    } catch (e) {
      const message = friendlyError(e, { url: this.p.url, kind: 'faust' });
      this.error = message;
      setStatus(key, { state: 'error', error: message, message });
      return false;
    }
  }

  dispose() {
    this._sig = '#disposed';
    const n = this.node;
    this.node = null;
    try { n?.disconnect(); n?.destroy?.(); } catch { /* */ }
  }
}

export { FaustEngine as Engine, FaustEffect as Effect };
