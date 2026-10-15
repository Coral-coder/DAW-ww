// Wavetable synth engine (main thread): drives one 'daw3-wavetable' AudioWorkletNode per instrument (realtime and
// OfflineAudioContext alike), ships band-limited mipmaps of the selected tables and timestamped note events, and
// falls back to the subtractive synth where AudioWorklets are unavailable so a track never goes silent.
import { OutputStage, SynthInstrument, num, isOffline } from '../synth.js';
import { buildMipmaps, decodeTable, isUserTable } from './tables.js';
import { factoryFrames } from './factory.js';

const MODULE_URL = new URL('./processor.js', import.meta.url).href;
const modules = new WeakMap(); // ctx -> Promise<boolean>
const MODULE_TIMEOUT_MS = 8000;

/** Load the processor module into a context once (false when worklets are unavailable / it stalls). */
export function loadWavetableModule(ctx) {
  if (!ctx?.audioWorklet || typeof AudioWorkletNode !== 'function' || globalThis.DAW3_NO_WAVETABLE_WORKLET) return Promise.resolve(false);
  if (!modules.has(ctx)) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), MODULE_TIMEOUT_MS); });
    modules.set(ctx, Promise.race([ctx.audioWorklet.addModule(MODULE_URL).then(() => true, (e) => { console.warn('[wavetable] worklet failed to load:', e?.message || e); return false; }), timeout])
      .finally(() => clearTimeout(timer)));
  }
  return modules.get(ctx);
}

// mipmaps are shared by every instrument / context (factory ids and content-hash user ids are immutable)
const mipCache = new Map();
const MIP_CACHE_MAX = 24;
/** Frames of a table id: factory tables by id, user tables through getTable(id) (project.wavetables entry). */
export function tableFrames(id, getTable) {
  if (isUserTable(id)) {
    const e = getTable?.(id);
    const fr = e ? decodeTable(e) : null;
    return fr && fr.length ? fr : factoryFrames('basic');
  }
  return factoryFrames(id) || factoryFrames('basic');
}
export function tableMips(id, getTable) {
  const resolvedId = isUserTable(id) && !getTable?.(id) ? 'basic' : id;
  let m = mipCache.get(resolvedId);
  if (m) { mipCache.delete(resolvedId); mipCache.set(resolvedId, m); return m; }
  m = buildMipmaps(tableFrames(resolvedId, getTable));
  mipCache.set(resolvedId, m);
  while (mipCache.size > MIP_CACHE_MAX) mipCache.delete(mipCache.keys().next().value);
  return m;
}

const NUMERIC_SKIP = new Set(['osc1Table', 'osc2Table']);

/** Subtractive-synth stand-in params for the fallback engine (no AudioWorklet). */
export function fallbackSynthParams(p) {
  const wave = (i) => {
    const t = p[`osc${i}Table`], pos = num(p[`osc${i}Pos`], 0, 0, 1);
    if (t === 'basic') return pos < 0.17 ? 'sine' : pos < 0.5 ? 'triangle' : pos < 0.83 ? 'saw' : 'square';
    if (t === 'pwm' || t === 'nes-pulse') return 'pulse';
    if (/^pad|choir|vox|vowel/.test(t || '')) return 'pad';
    if (/sine|fm-1-1|harm-add/.test(t || '')) return 'triangle';
    return 'saw';
  };
  const ftype = { lp: 'lp', bp: 'bp', hp: 'hp', notch: 'notch' }[p.filterType] || 'off';
  return {
    osc1Wave: wave(1), osc1Level: p.osc1On === false ? 0 : num(p.osc1Level, 0.8), osc1Octave: num(p.osc1Octave, 0, -3, 3), osc1Fine: num(p.osc1Fine, 0, -100, 100),
    osc2Wave: wave(2), osc2Level: p.osc2On ? num(p.osc2Level, 0.6) : 0, osc2Octave: num(p.osc2Octave, 0, -3, 3), osc2Fine: num(p.osc2Fine, 0, -100, 100),
    osc3Level: 0, subLevel: num(p.subLevel, 0), noiseLevel: num(p.noiseLevel, 0),
    unison: Math.min(7, Math.round(num(p.osc1Unison, 1))), unisonDetune: num(p.osc1Detune, 0.2) * 50,
    filterType: ftype === 'off' ? 'off' : ftype === 'notch' ? 'notch' : ftype === 'bp' ? 'bp' : `${ftype}${p.filterSlope === '12' ? '12' : '24'}`,
    cutoff: num(p.cutoff, 12000), resonance: num(p.resonance, 0.1), keytrack: num(p.keytrack, 0.3), velToFilter: num(p.velToFilter, 0.2),
    fEnvAmount: num(p.fEnvAmount, 0), fAttack: num(p.env2Attack, 0.005), fDecay: num(p.env2Decay, 0.4), fSustain: num(p.env2Sustain, 0.2), fRelease: num(p.env2Release, 0.3),
    attack: num(p.env1Attack, 0.005), decay: num(p.env1Decay, 0.4), sustain: num(p.env1Sustain, 0.8), release: num(p.env1Release, 0.25), velToAmp: num(p.velToAmp, 0.6),
    mono: p.voiceMode === 'mono' || p.voiceMode === 'legato', legato: p.voiceMode === 'legato', glide: num(p.glide, 0), glideAlways: !!p.glideAlways,
    polyphony: num(p.polyphony, 8), bendRange: num(p.bendRange, 2), transpose: num(p.transpose, 0),
    drive: num(p.drive, 0), driveType: p.driveType, toneCut: num(p.toneCut, 20000), lowCut: num(p.lowCut, 20), gain: num(p.gain, 0.8), analog: 0,
  };
}

export class WavetableInstrument {
  /** opts: { getBpm, getWavetable(id) -> project.wavetables entry } */
  constructor(ctx, output, params, opts = {}) {
    this.ctx = ctx;
    this.output = output;
    this.opts = opts || {};
    this.type = 'wavetable';
    this.params = {};
    this.node = null;
    this.fallback = null;
    this.pending = []; // events queued before the node exists
    this.held = new Map(); // pitch -> note id (live keyboard)
    this.nextId = 1;
    this.sent = {}; // params already posted
    this.tableIds = [null, null];
    this.liveVoices = 0;
    this.livePos = null;
    this.disposed = false;
    this.out = new OutputStage(ctx, output);
    this.setParams(params || {});
    this.ready = this._init();
  }

  async _init() {
    const ok = await loadWavetableModule(this.ctx);
    if (this.disposed) return false;
    if (!ok) { this._useFallback(); return true; }
    try {
      this.node = new AudioWorkletNode(this.ctx, 'daw3-wavetable', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    } catch (e) {
      console.warn('[wavetable] could not start the processor:', e?.message || e);
      this._useFallback();
      return true;
    }
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.node.connect(this.out.input);
    this.sent = {};
    this.tableIds = [null, null];
    this._push(true);
    const now = this.ctx.currentTime;
    // events queued while the module loaded: recent note-ons (a held live key) still sound, from now on
    const live = new Set(this.held.values());
    const list = this.pending.filter((ev) => ev.type !== 'on' || ev.t >= now - 0.05 || live.has(ev.id)).map((ev) => ({ ...ev, t: Math.max(ev.t, now) }));
    this.pending = [];
    if (list.length) this.node.port.postMessage({ type: 'events', list });
    return true;
  }

  _useFallback() {
    if (this.fallback || this.disposed) return;
    this.fallback = new SynthInstrument(this.ctx, this.out.input, { ...fallbackSynthParams(this.params), gain: 1, drive: 0, toneCut: 20000, lowCut: 20 }, this.opts);
    this.pending = [];
  }

  _onMessage(m) {
    if (!m) return;
    if (m.type === 'state') { this.liveVoices = m.voices || 0; this.livePos = m.pos || null; }
    else if (m.type === 'pong') { const r = this._pongs?.get(m.id); if (r) { this._pongs.delete(m.id); r(); } }
  }

  /** Voices sounding (approximate, from the processor's reports) — Instrument.activeVoices iterates this. */
  get voices() { return Array.from({ length: this.liveVoices }, () => ({ done: false })); }

  setParams(params) {
    this.params = params || {};
    this.out.set({ ...this.params }, this.ctx.currentTime);
    if (this.fallback) { this.fallback.setParams({ ...fallbackSynthParams(this.params), gain: 1, drive: 0, toneCut: 20000, lowCut: 20 }); return; }
    this._push(false);
  }

  /** Post changed params (and tables) to the processor. */
  _push(all) {
    if (!this.node) return;
    const p = this.params;
    const diff = {};
    let any = false;
    for (const [k, v] of Object.entries(p)) {
      if (NUMERIC_SKIP.has(k) || (typeof v === 'object' && v !== null)) continue;
      if (all || this.sent[k] !== v) { diff[k] = v; this.sent[k] = v; any = true; }
    }
    const bpm = num(this.opts.getBpm?.(), 120, 20, 400);
    if (all || this.sent.bpm !== bpm) { diff.bpm = bpm; this.sent.bpm = bpm; any = true; }
    if (any) this.node.port.postMessage({ type: 'params', p: diff });
    for (let o = 0; o < 2; o++) {
      const id = p[`osc${o + 1}Table`] || (o ? 'pwm' : 'basic');
      if (id === this.tableIds[o]) continue;
      this.tableIds[o] = id;
      let mips;
      try { mips = tableMips(id, this.opts.getWavetable); } catch (e) { console.warn('[wavetable] table', id, e); mips = tableMips('basic'); }
      this.node.port.postMessage({ type: 'table', osc: o, mips });
    }
  }

  _send(ev) {
    if (this.fallback) return;
    if (!this.node) { this.pending.push(ev); return; }
    this.node.port.postMessage({ type: 'events', list: [ev] });
  }
  _t(time) { const t = num(time, this.ctx.currentTime); return Math.max(t, this.ctx.currentTime); }

  trigger(time, pitch, vel = 0.8, durSec = 0.25, extra = {}) {
    if (this.fallback) return this.fallback.trigger(time, pitch, vel, durSec, extra);
    // keep the bpm current for tempo-synced LFOs
    if (this.node && num(this.opts.getBpm?.(), 120) !== this.sent.bpm) this._push(false);
    const t = this._t(time);
    const id = this.nextId++;
    const on = { t, type: 'on', id, pitch: num(pitch, 60, 0, 127), vel: num(vel, 0.8, 0, 1) };
    if (extra?.glideFrom != null) { on.glideFrom = num(extra.glideFrom, pitch, 0, 127); on.glideTime = num(extra.glideTime, 0.06, 0.005, 2); }
    const off = { t: t + num(durSec, 0.25, 0.005, 3600), type: 'off', id };
    if (this.node) this.node.port.postMessage({ type: 'events', list: [on, off] });
    else { this.pending.push(on, off); }
    return null;
  }
  noteOn(pitch, vel = 0.8, time) {
    if (this.fallback) return this.fallback.noteOn(pitch, vel, time);
    const t = this._t(time);
    pitch = num(pitch, 60, 0, 127);
    const prev = this.held.get(pitch);
    if (prev) this._send({ t, type: 'off', id: prev });
    const id = this.nextId++;
    this.held.set(pitch, id);
    this._send({ t, type: 'on', id, pitch, vel: num(vel, 0.8, 0, 1) });
    return null;
  }
  noteOff(pitch, time) {
    if (this.fallback) return this.fallback.noteOff(pitch, time);
    const id = this.held.get(pitch);
    if (!id) return;
    this.held.delete(pitch);
    this._send({ t: this._t(time), type: 'off', id });
  }
  allNotesOff(time) {
    if (this.fallback) return this.fallback.allNotesOff(time);
    this.held.clear();
    this.pending = [];
    this._send({ t: this._t(time), type: 'allOff' });
  }
  pitchBend(value, time) {
    if (this.fallback) return this.fallback.pitchBend(value, time);
    this._send({ t: this._t(time), type: 'bend', semis: Math.max(-1, Math.min(1, num(value, 0))) * num(this.params.bendRange, 2, 0, 24) });
  }
  noteExpression(pitch, x = {}, time) {
    if (this.fallback) return this.fallback.noteExpression?.(pitch, x, time);
    const id = this.held.get(pitch);
    if (!id || !Number.isFinite(x.bend)) return !Number.isFinite(x.bend);
    this._send({ t: this._t(time), type: 'expr', id, bend: x.bend });
    return true;
  }

  /** Offline renders: resolve once every posted event has reached the processor (round trip on its port). */
  flush() {
    if (!this.node || !isOffline(this.ctx)) return Promise.resolve();
    this._pongs ||= new Map();
    const id = Math.random();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._pongs.delete(id); resolve(); }, 1500);
      this._pongs.set(id, () => { clearTimeout(timer); resolve(); });
      this.node.port.postMessage({ type: 'ping', id });
    });
  }

  dispose() {
    this.disposed = true;
    if (this.fallback) { try { this.fallback.dispose(); } catch { /* */ } }
    const node = this.node, out = this.out;
    this.node = null;
    if (node) {
      try { node.port.postMessage({ type: 'events', list: [{ t: 0, type: 'allOff' }] }); } catch { /* */ }
      const kill = () => { try { node.disconnect(); } catch { /* */ } try { node.port.close(); } catch { /* */ } };
      if (isOffline(this.ctx)) kill(); else setTimeout(kill, 80);
    }
    if (!isOffline(this.ctx)) setTimeout(() => out.dispose(), 120);
  }
}
