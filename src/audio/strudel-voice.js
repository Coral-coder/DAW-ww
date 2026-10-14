// 'strudel' instrument type: plays a superdough patch (src/audio/strudel-patches.js) — Strudel's own audio engine,
// the same one code tracks use — from piano-roll notes and the live keyboard.
//
// Routing / offline rendering are StrudelInstrument's (src/audio/strudel-instrument.js): a per-track superdough
// controller whose output feeds the track's channel strip (mixer, inserts, sends, automation, plugboard apply), and
// renders into an OfflineAudioContext like code tracks do (the MixGraph lists this engine's StrudelInstrument in
// strudelInstruments(), so render.js claims superdough for the render and waits for sample loads).
//
// `ready` resolves true once the patch can play: superdough loaded AND the patch's sound loaded (a muted probe note
// loads its samples / soundfont). If either fails, the track plays its `fallbackPreset` with a built-in engine
// instead (opts.makeFallback, wired by src/audio/instruments.js), so it never goes silent.
//
// AudioWorklet-less contexts (some headless browsers): supersaw becomes three detuned saws, pulse a square, and
// worklet-only controls (shape, crush, coarse) are dropped.
//
// Live edits: superdough fixes each note's controls when it starts, so new notes always use the current params, and a
// small post stage (gain -> low-pass -> high-pass -> pan, AudioParams ramped with setTargetAtTime) makes gain / pan /
// filter moves reach SOUNDING notes too: the patch gain and pan live only there (notes play at superdough's unity
// 0.8, linear — same level), and the post filters close down to a lowered cutoff (raised high-pass) while notes
// started with the old setting still sound, then open again. A new sound (s) loads in the background and plays from
// the next note.
//
// Live keyboard: superdough fixes a note's length when it starts, so held notes play on "lanes" — small pooled
// StrudelInstruments, each behind its own gain — started long and faded out on noteOff with the patch's release.
import { StrudelInstrument, workletsLoaded } from './strudel-instrument.js';
import { strudelValue, WORKLET_SOUNDS, WORKLET_CONTROLS } from './strudel-patches.js';
import { exprStage, applyStage } from './voice-expression.js';

const isOfflineCtx = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
const PROBE_TIMEOUT = 25000;
const LIVE_HOLD = 8; // s: longest held live note
const MAX_LANES = 8;
const UNITY = 0.8; // superdough's default gain
const OPEN = 20000;

let lastWarn = 0;
function warn(e) {
  const now = Date.now();
  if (now - lastWarn < 2000) return;
  lastWarn = now;
  console.warn('[strudel instrument]', e?.message || e);
}

/** Patch params -> the superdough values one note plays (several when a worklet sound is substituted). */
export function noteValues(params, pitch, vel, { worklets = true, post = false } = {}) {
  const v = strudelValue(params);
  const base = { ...v, note: pitch, velocity: Math.max(0, Math.min(1, vel ?? 0.8)) };
  if (post) { base.gain = UNITY; delete base.pan; v.gain = UNITY; } // (the post stage applies gain + pan)
  if (worklets) return [base];
  for (const k of WORKLET_CONTROLS) delete base[k];
  if (base.s === 'pulse') base.s = 'square';
  if (base.s !== 'supersaw' || !WORKLET_SOUNDS.has('supersaw')) return [base];
  // supersaw without its worklet: three detuned saws spread across the stereo field (≈ equal power)
  const det = Math.max(0.05, (v.detune ?? 0.18) * 0.5);
  const spread = v.spread ?? 0.6;
  const g = (v.gain ?? UNITY) / Math.sqrt(3);
  const { unison, detune, spread: _s, ...rest } = base;
  return [-det, 0, det].map((d, i) => ({ ...rest, s: 'sawtooth', note: pitch + d, gain: g, pan: 0.5 + (i - 1) * 0.4 * spread }));
}

export class StrudelVoice {
  /**
   * @param {BaseAudioContext} ctx @param {AudioNode} output track strip input @param {object} params resolved patch
   * @param {{getBpm?, makeFallback?: () => engine|null}} opts
   */
  constructor(ctx, output, params, opts = {}) {
    this.ctx = ctx;
    this.output = output;
    this.params = params || {};
    this.opts = opts;
    this.voices = [];
    this.fallback = null;
    this.fallbackReason = null;
    this.lanes = [];
    this.disposed = false;
    this.sounding = []; // {end, lpf, hpf} of notes handed to superdough (post-stage filter tracking)
    // post stage: gain -> low-pass -> high-pass -> pan -> track strip
    this.postGain = ctx.createGain();
    this.postLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: OPEN, Q: 0.707 });
    this.postHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 10, Q: 0.707 });
    this.postPan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    this.postGain.connect(this.postLp).connect(this.postHp);
    if (this.postPan) this.postHp.connect(this.postPan).connect(output); else this.postHp.connect(output);
    this._applyPost(true);
    this.sdi = new StrudelInstrument(ctx, this.postGain, { onError: warn, fallback: () => this._makeFallback() });
    this.ready = this._init();
  }

  /** Post stage follows gain / pan, and lowers / raises its filters over notes started with another setting. */
  _applyPost(immediate = false) {
    const p = this.params || {};
    const now = this.ctx.currentTime;
    const set = (param, v, tc = 0.02) => {
      if (!Number.isFinite(v)) return;
      try {
        if (immediate) { param.cancelScheduledValues(now); param.setValueAtTime(v, now); } else param.setTargetAtTime(v, now, tc);
      } catch { /* */ }
    };
    set(this.postGain.gain, (Number.isFinite(p.gain) ? p.gain : UNITY) / UNITY);
    if (this.postPan) set(this.postPan.pan, Math.max(-1, Math.min(1, ((Number.isFinite(p.pan) ? p.pan : 0.5) - 0.5) * 2)));
    this.sounding = this.sounding.filter((n) => n.end > now);
    const lpf = p.lpf < OPEN ? p.lpf : OPEN;
    const hpf = p.hpf > 20 ? p.hpf : 10;
    const older = this.sounding.filter((n) => n.lpf > lpf * 1.01);
    const olderHp = this.sounding.filter((n) => n.hpf < hpf * 0.99);
    set(this.postLp.frequency, older.length ? lpf : OPEN, 0.03);
    set(this.postHp.frequency, olderHp.length ? hpf : 10, 0.03);
    // re-open once those notes are over (realtime; offline renders re-check on the next note / param change)
    clearTimeout(this._postTimer);
    const ends = [...older, ...olderHp].map((n) => n.end).filter(Number.isFinite);
    if (ends.length && !isOfflineCtx(this.ctx)) this._postTimer = setTimeout(() => this._applyPost(), (Math.min(...ends) - now) * 1000 + 30);
  }

  _track(time, durSec) {
    const p = this.params;
    const rel = Number.isFinite(p.release) ? p.release : 0.01;
    const n = { end: time + durSec + rel + 0.05, lpf: p.lpf < OPEN ? p.lpf : OPEN, hpf: p.hpf > 20 ? p.hpf : 10 };
    if (this.sounding.length > 256) this.sounding = this.sounding.filter((x) => x.end > this.ctx.currentTime);
    this.sounding.push(n);
    return n;
  }

  get worklets() { return workletsLoaded(this.ctx); }
  _cps() { const bpm = this.opts.getBpm?.() || 120; return bpm / 240; }
  _ev() { return { cps: this._cps(), cycle: 0 }; }
  _values(pitch, vel) { return noteValues(this.params, pitch, vel, { worklets: this.worklets, post: true }); }

  _makeFallback() {
    if (this.fallback) return this.fallback;
    if (this._standIn && !this._settled) { this.fallback = this._standIn; return this.fallback; } // keep the stand-in
    try { this.fallback = this.opts.makeFallback?.() || null; } catch (e) { warn(e); this.fallback = null; }
    return this.fallback;
  }

  async _init() {
    let ok = false;
    try { ok = await this.sdi.whenReady(); } catch { ok = false; }
    if (this.disposed) return false;
    if (!ok || this.sdi.fallback) {
      this.fallbackReason = 'Strudel sound engine unavailable';
      this._makeFallback();
      this._endStandIn();
      return true;
    }
    const sound = await this._probe();
    if (this.disposed) return false;
    if (!sound) {
      this.fallbackReason = `Strudel sound "${this.params.s}" could not be loaded`;
      warn(`${this.fallbackReason} — playing the fallback preset`);
      this._makeFallback();
    }
    this._endStandIn();
    if (!isOfflineCtx(this.ctx)) for (let i = 0; i < 2; i++) this._newLane();
    return true;
  }

  /**
   * Realtime: until the patch is confirmed playable (superdough + its sound loading, a few seconds on the first
   * play), notes play on the fallback preset instead of silence. Not used offline (renders wait for `ready`).
   */
  _standInEngine() {
    if (this._standIn !== undefined || isOfflineCtx(this.ctx) || this.disposed) return this._standIn || null;
    try { this._standIn = this.opts.makeFallback?.() || null; } catch (e) { warn(e); this._standIn = null; }
    return this._standIn;
  }

  /** The patch is playable (or its fallback took over): stop routing notes to the stand-in. */
  _endStandIn() {
    this._settled = true;
    const s = this._standIn;
    if (!s || s === this.fallback) return;
    // let the stand-in's notes ring out, then drop it
    setTimeout(() => { try { s.allNotesOff(); s.dispose(); } catch { /* */ } }, 4000);
  }

  /** Loads the patch's sound with a muted note. Resolves false only when superdough reports a load failure. */
  async _probe() {
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    mute.connect(this.output);
    const probe = new StrudelInstrument(this.ctx, mute, { onError: () => {} });
    try {
      if (!(await probe.whenReady({ sounds: false }))) return true;
      let failed = false;
      const ps = this._values(60, 0.01).map((v) => probe.trigger(this.ctx.currentTime, { ...v, room: undefined, delay: undefined }, 0.05, this._ev()));
      const all = Promise.all(ps.map((p) => Promise.resolve(p).catch(() => { failed = true; })));
      let timer;
      await Promise.race([all, new Promise((r) => { timer = setTimeout(r, PROBE_TIMEOUT); })]);
      clearTimeout(timer);
      return !failed;
    } catch {
      return false;
    } finally {
      probe.dispose();
      setTimeout(() => { try { mute.disconnect(); } catch { /* */ } }, 500);
    }
  }

  /** Live edit: synchronous — the next note uses the new params; gain / pan / filters move sounding notes too. */
  setParams(params) {
    const prevS = this.params?.s;
    this.params = params || {};
    this._applyPost();
    if (params?.s === prevS || !this.sdi.ready || this.sdi.failed) return;
    // a new sound: load it in the background (notes keep playing meanwhile); a sound that fails plays the fallback
    // preset, and a working sound replaces a fallback that was standing in for a sound that failed
    const s = params?.s;
    this._probe().then((ok) => {
      if (this.disposed || this.params?.s !== s) return;
      if (ok && this.fallback && this.fallbackReason) {
        const fb = this.fallback;
        this.fallback = null;
        this.fallbackReason = null;
        try { fb.allNotesOff(); fb.dispose(); } catch { /* */ }
      } else if (!ok && !this.fallback) {
        this.fallbackReason = `Strudel sound "${s}" could not be loaded`;
        warn(`${this.fallbackReason} — playing the fallback preset`);
        this._makeFallback();
      }
    });
  }

  trigger(time, pitch, vel, durSec, extra) {
    if (this.fallback) { this.fallback.trigger(time, pitch, vel, durSec, extra); return; }
    if (this.disposed) return;
    if (!this._settled && !isOfflineCtx(this.ctx)) { this._standInEngine()?.trigger(time, pitch, vel, durSec, extra); return; }
    if (!this.sdi.ready) return;
    const ev = this._ev();
    this._track(time, durSec);
    this._applyPost();
    for (const v of this._values(pitch, vel)) this.sdi.trigger(time, v, durSec, ev);
  }

  // ---------------------------------------------------------------- live keyboard
  _newLane() {
    if (this.lanes.length >= MAX_LANES || this.disposed) return null;
    const gain = this.ctx.createGain();
    // MPE: each held lane has its own expression stage (pressure -> gain, timbre -> low-pass; voice-expression.js)
    const xs = exprStage(this.ctx, { node: (n) => n }, gain, this.postGain);
    const lane = { gain, xs, sdi: new StrudelInstrument(this.ctx, gain, { onError: warn }), pitch: null, held: false, freeAt: 0, timer: null };
    this.lanes.push(lane);
    return lane;
  }

  noteOn(pitch, vel, time) {
    if (this.fallback) { this.fallback.noteOn(pitch, vel, time); return; }
    if (this.disposed) return;
    if (!this._settled && !isOfflineCtx(this.ctx)) { this._standInEngine()?.noteOn(pitch, vel, time); return; }
    if (!this.sdi.ready) return;
    const t = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    const now = this.ctx.currentTime;
    let lane = this.lanes.find((l) => l.sdi.ready && !l.held && l.freeAt <= now);
    if (!lane) {
      this._newLane(); // ready for a later note
      lane = this.lanes.filter((l) => l.sdi.ready).sort((a, b) => a.freeAt - b.freeAt)[0];
    }
    if (!lane) { this.trigger(t, pitch, vel, 0.5); return; } // lanes still loading: a short note
    if (lane.held) this._release(lane, t, 0.01);
    clearTimeout(lane.timer);
    lane.gain.gain.cancelScheduledValues(t);
    lane.gain.gain.setValueAtTime(1, t);
    lane.pitch = pitch;
    lane.held = true;
    if (lane.xs.pressure || lane.xs.timbre !== 0.5) applyStage(lane.xs, { pressure: 0, timbre: 0.5 }, t); // neutral for the new note
    lane.freeAt = Infinity;
    const ev = this._ev();
    lane.track = this._track(t, Infinity);
    this._applyPost();
    for (const v of this._values(pitch, vel)) lane.sdi.trigger(t, v, LIVE_HOLD, ev);
  }

  /**
   * Per-note expression (MPE) of a held live note: pressure -> that lane's gain, timbre (CC74) -> its low-pass.
   * superdough fixes a note's pitch when it starts, so per-note bend is not possible here (returns false: the
   * caller falls back to channel bend). The fallback / stand-in engines get the full expression.
   */
  noteExpression(pitch, x = {}, time) {
    const other = this.fallback || this._standIn;
    if (other?.noteExpression) { try { return other.noteExpression(pitch, x, time); } catch { /* */ } }
    const t = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    for (const lane of this.lanes) if (lane.held && lane.pitch === pitch) applyStage(lane.xs, x, t);
    return !Number.isFinite(x.bend);
  }

  _release(lane, t, rel) {
    lane.held = false;
    if (lane.track) lane.track.end = t + rel + 0.05;
    lane.freeAt = t + rel + 0.05;
    try {
      lane.gain.gain.cancelScheduledValues(t);
      lane.gain.gain.setValueAtTime(lane.gain.gain.value, t);
      lane.gain.gain.setTargetAtTime(0, t, Math.max(0.005, rel / 4));
    } catch { /* */ }
    clearTimeout(lane.timer);
    // after the fade, drop the long note's nodes (a fresh controller + bus for the next note)
    lane.timer = setTimeout(() => { if (!lane.held) lane.sdi.allNotesOff(); }, Math.max(0, (lane.freeAt - this.ctx.currentTime) * 1000));
  }

  noteOff(pitch, time) {
    if (this.fallback) { this.fallback.noteOff(pitch, time); return; }
    if (this._standIn) { try { this._standIn.noteOff(pitch, time); } catch { /* */ } }
    const t = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    const rel = this.params.release > 0 ? Math.min(4, this.params.release) : 0.25;
    for (const lane of this.lanes) if (lane.held && lane.pitch === pitch) this._release(lane, t, rel);
  }

  allNotesOff(time) {
    this.fallback?.allNotesOff(time);
    if (this._standIn && this._standIn !== this.fallback) { try { this._standIn.allNotesOff(time); } catch { /* */ } }
    this.sdi.allNotesOff(time);
    const t = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    for (const lane of this.lanes) if (lane.held) this._release(lane, t, 0.03);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._postTimer);
    const post = [this.postGain, this.postLp, this.postHp, this.postPan];
    if (!isOfflineCtx(this.ctx)) setTimeout(() => { for (const n of post) { try { n?.disconnect(); } catch { /* */ } } }, 300);
    try { this.fallback?.dispose(); } catch { /* */ }
    if (this._standIn && this._standIn !== this.fallback) { try { this._standIn.dispose(); } catch { /* */ } }
    this.sdi.dispose();
    for (const lane of this.lanes) {
      clearTimeout(lane.timer);
      lane.sdi.dispose();
      const g = lane.gain;
      setTimeout(() => { try { g.disconnect(); } catch { /* */ } }, 200);
    }
    this.lanes = [];
  }
}
