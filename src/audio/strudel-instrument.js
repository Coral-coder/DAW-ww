// "Strudel sound engine" for code tracks: plays code events through superdough — Strudel's own audio
// engine (vendored, AGPL-3.0-or-later; see src/code/strudel-real.js) — so a tune sounds exactly as on
// strudel.cc (its synths, samples, soundfonts, effects and orbits), but into the code track's channel strip:
// mixer volume / pan / mute, insert effects, sends, automation and the plugboard all apply.
//
// Routing: superdough mixes every sound into an "orbit" (its global delay / reverb buses) and hands the orbit
// output to its audio controller. Each StrudelInstrument owns its own controller whose output feeds the track
// strip instead of ctx.destination, and selects its context + controller right before each superdough() call
// (both are read synchronously at the start of a call). Orbits are therefore per track.
//
// Offline (WAV export / bounce): superdough renders into an OfflineAudioContext the same way (Strudel's own
// "export" does this too). While a render runs it owns superdough; realtime code tracks pause their Strudel
// sounds meanwhile. flush() resolves when every triggered sound has finished setting up its nodes (sample /
// soundfont loading included) — the offline renderer waits for it before letting time advance.
//
// Same interface as CodeInstrument: trigger(time, value, durSec, ev), allNotesOff(time), dispose().
import '../code/strudel.js'; // (first: strudel.js <-> strudel-real.js import each other; this order initialises both)
import { loadStrudelAudio, strudelSoundsReady } from '../code/strudel-real.js';

const isOfflineCtx = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
let owner = null; // OfflineAudioContext currently rendering with superdough (realtime triggers pause)
const live = new Set(); // realtime instruments
let ControllerClass = null;
const workletCtx = new WeakMap(); // ctx -> Promise (worklets added)
const workletOk = new WeakMap(); // ctx -> true once superdough's AudioWorklets are added to it
const WORKLET_TIMEOUT = 6000;
/** Did superdough's AudioWorklets load on `ctx` (supersaw, pulse, shape, crush…)? */
export const workletsLoaded = (ctx) => workletOk.get(ctx) === true;

/**
 * Adds superdough's AudioWorklet modules (supersaw, pulse, crush, shape, distort, djf, ladder filter, …)
 * to `ctx`. Never blocks for long: if a browser stalls on addModule, Strudel still plays everything that
 * doesn't need a worklet.
 */
function ensureWorklets(sd, ctx) {
  if (!workletCtx.has(ctx)) {
    const urls = typeof sd.daw3WorkletUrls === 'function' ? sd.daw3WorkletUrls() : [];
    // one module at a time: concurrent addModule() calls on one context can stall forever in Chromium (and a
    // pending addModule blocks an OfflineAudioContext's rendering — WAV export would hang)
    const load = urls.reduce((chain, u) => chain.then(() => ctx.audioWorklet?.addModule(u)), Promise.resolve()).then(() => { if (urls.length && ctx.audioWorklet) workletOk.set(ctx, true); }, (e) => console.warn('[strudel] AudioWorklets unavailable:', e?.message || e));
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { console.warn('[strudel] AudioWorklets are taking long to load — continuing without waiting'); resolve(); }, WORKLET_TIMEOUT); });
    workletCtx.set(ctx, Promise.race([load, timeout]).finally(() => clearTimeout(timer)));
  }
  return workletCtx.get(ctx);
}

/** A superdough audio controller whose output goes into `input` (the track's strip). */
function createController(sd, ctx, input) {
  const dest = ctx.destination;
  const channels = dest.channelCount;
  if (!ControllerClass) {
    sd.setAudioContext(ctx);
    sd.setSuperdoughAudioController(null);
    const probe = sd.getSuperdoughAudioController(); // the class isn't exported; take it from an instance
    ControllerClass = probe.constructor;
    try { probe.output.disconnect(); } catch { /* */ }
  }
  const c = new ControllerClass(ctx);
  try { c.output.disconnect(); } catch { /* */ } // its default output goes straight to the speakers
  dest.channelCount = channels; // (SuperdoughOutput widens the destination to all device channels)
  c.output.connectToDestination = (node) => node.connect(input);
  c.output.reset = () => {};
  c.output.disconnect = () => {};
  return c;
}

export class StrudelInstrument {
  /** @param {BaseAudioContext} ctx @param {AudioNode} output the track strip input @param {{onError?}} opts */
  constructor(ctx, output, opts = {}) {
    this.ctx = ctx;
    this.onError = opts.onError || ((e) => console.warn('[strudel]', e));
    this.output = output;
    this.bus = ctx.createGain();
    this.bus.connect(output);
    this.pending = new Set();
    this.ready = false;
    if (!isOfflineCtx(ctx)) live.add(this);
    this.failed = null;
    this.readyPromise = loadStrudelAudio().then(async (mod) => {
      this.sd = mod.superdough;
      await ensureWorklets(this.sd, ctx);
      this.controller = createController(this.sd, ctx, this.bus);
      this.ready = true;
    }).catch((e) => {
      this.failed = e;
      if (opts.fallback) { try { this.fallback = opts.fallback(); } catch { /* */ } }
      this.onError(new Error(`Strudel sound engine unavailable (${e?.message || e}) — playing with daW³ instruments`));
    });
  }

  /** Resolves when superdough is loaded on this context and the default sound packs are registered. */
  async whenReady({ sounds = true } = {}) {
    await this.readyPromise;
    if (sounds) await strudelSoundsReady();
    return this.ready;
  }

  _select() {
    const sd = this.sd;
    sd.setAudioContext(this.ctx);
    sd.setSuperdoughAudioController(this.controller);
    globalThis.__daw3SuperdoughCtx = this.ctx; // pooled nodes of other contexts are not reused
  }

  /** ev: the scheduler event ({cycle, cps, hapDur}) — superdough wants Strudel's timing. Returns superdough's promise (if any). */
  trigger(time, value, durSec, ev) {
    if (this.fallback) { this.fallback.trigger(time, value, durSec, ev); return; }
    if (!this.ready || this.disposed || !value || typeof value !== 'object') return;
    if (owner && owner !== this.ctx) return; // an offline render owns superdough right now
    if (time < this.ctx.currentTime) return;
    const cps = ev?.cps > 0 ? ev.cps : 0.5;
    const dur = ev?.hapDur > 0 ? ev.hapDur / cps : durSec;
    this._select();
    let p;
    try {
      p = this.sd.superdough({ ...value }, time, dur, cps, ev?.cycle ?? 0);
    } catch (e) {
      this.onError(e);
      return;
    }
    if (p && typeof p.then === 'function') {
      const q = p.catch((e) => this.onError(e)).finally(() => this.pending.delete(q));
      this.pending.add(q);
      return p;
    }
    return undefined;
  }

  /** Resolves when every sound triggered so far has its audio nodes in place (or after timeoutMs). */
  flush(timeoutMs = 30000) {
    if (!this.pending.size) return Promise.resolve();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { this.pending.clear(); resolve(); }, timeoutMs); });
    const all = (async () => { while (this.pending.size) await Promise.all([...this.pending]); })();
    return Promise.race([all, timeout]).finally(() => clearTimeout(timer));
  }

  allNotesOff(time) {
    this.fallback?.allNotesOff(time);
    if (!this.controller) return;
    const t = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    // fade the sounds already handed to superdough out on their own bus, then drop their orbits; sounds
    // triggered from now on (e.g. right after a seek) go to a fresh controller + bus
    const oldBus = this.bus;
    const oldCtl = this.controller;
    try {
      oldBus.gain.cancelScheduledValues(t);
      oldBus.gain.setValueAtTime(oldBus.gain.value, t);
      oldBus.gain.linearRampToValueAtTime(0, t + 0.03);
    } catch { /* */ }
    this.bus = this.ctx.createGain();
    this.bus.connect(this.output);
    this.controller = createController(this.sd, this.ctx, this.bus);
    const drop = () => { try { oldCtl.reset(); } catch { /* */ } try { oldBus.disconnect(); } catch { /* */ } };
    if (isOfflineCtx(this.ctx)) return; // (offline renders stop by ending)
    setTimeout(drop, 120);
  }

  dispose() {
    live.delete(this);
    this.fallback?.dispose();
    this.allNotesOff();
    this.disposed = true;
    const bus = this.bus;
    if (!(isOfflineCtx(this.ctx))) setTimeout(() => { try { bus.disconnect(); } catch { /* */ } }, 150);
  }
}
/**
 * Offline renders: superdough belongs to `ctx` until release() is called (realtime Strudel sounds pause
 * meanwhile). Resolves release() once the realtime sounds still being set up (sample loads) are done, so
 * they don't build their nodes on the offline context.
 */
export async function claimSuperdough(ctx) {
  owner = ctx;
  await Promise.all([...live].map((i) => i.flush(3000)));
  return () => {
    if (owner !== ctx) return;
    owner = null;
    const rt = [...live].find((i) => i.ready);
    if (rt) rt._select(); // the ambient context goes back to the realtime one
  };
}
