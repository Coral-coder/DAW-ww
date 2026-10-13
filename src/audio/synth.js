// Subtractive polysynth + shared voice/DSP helpers used by every instrument engine.
// Browser-only at runtime, but importable in Node (no AudioContext use at import time).
import { clamp, midiToFreq } from '../core/util.js';

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

/** Sanitize a number: NaN/undefined -> def, then clamp. */
export function num(v, def = 0, lo = -Infinity, hi = Infinity) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return clamp(Number.isFinite(n) ? n : def, lo, hi);
}

/** Note division -> length in beats. '1/1' = one 4/4 bar, 't' triplet, 'd' dotted. */
export function divisionBeats(div) {
  const m = /^(\d+)\/(\d+)([td]?)$/.exec(String(div || '1/4'));
  if (!m) return 1;
  let beats = (4 * Number(m[1])) / Math.max(1, Number(m[2]));
  if (m[3] === 't') beats *= 2 / 3;
  if (m[3] === 'd') beats *= 1.5;
  return beats;
}
export const LFO_DIVISIONS = ['4/1', '2/1', '1/1', '1/2', '1/2d', '1/4', '1/4d', '1/4t', '1/8', '1/8d', '1/8t', '1/16', '1/16t', '1/32'];

/** OfflineAudioContext? (wall-clock timers must not tear down graphs during offline renders) */
export function isOffline(ctx) {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
}

/* ------------------------------------------------------------------ */
/* Per-context caches (noise buffers, periodic waves)                  */
/* ------------------------------------------------------------------ */

const ctxCache = new WeakMap();
function cacheFor(ctx) {
  let c = ctxCache.get(ctx);
  if (!c) { c = { noise: {}, waves: new Map(), reversed: new WeakMap() }; ctxCache.set(ctx, c); }
  return c;
}

/** 2-second mono looping noise buffer ('white' | 'pink' | 'brown'), cached per context. */
export function getNoiseBuffer(ctx, color = 'white') {
  const c = cacheFor(ctx);
  if (!['white', 'pink', 'brown'].includes(color)) color = 'white';
  if (c.noise[color]) return c.noise[color];
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // deterministic LCG so offline renders are reproducible
  let seed = color === 'white' ? 12345 : color === 'pink' ? 777 : 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  if (color === 'white') {
    for (let i = 0; i < len; i++) d[i] = rnd();
  } else if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * rnd()) / 1.02; d[i] = last * 3.5; }
  }
  c.noise[color] = buf;
  return buf;
}

/** Reversed copy of an AudioBuffer (cached per buffer). */
export function getReversedBuffer(ctx, buf) {
  const c = cacheFor(ctx);
  let r = c.reversed.get(buf);
  if (r) return r;
  r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch), dst = r.getChannelData(ch);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  c.reversed.set(buf, r);
  return r;
}

/** Cached PeriodicWave by key; build() returns {real, imag, normalize?}. */
export function getPeriodicWave(ctx, key, build) {
  const c = cacheFor(ctx);
  let w = c.waves.get(key);
  if (!w) {
    const { real, imag, normalize = true } = build();
    w = ctx.createPeriodicWave(real, imag, { disableNormalization: !normalize });
    c.waves.set(key, w);
  }
  return w;
}

/** Band-limited pulse wave with duty cycle `width` (0.5 = square). */
export function getPulseWave(ctx, width = 0.5) {
  const w = clamp(Math.round(num(width, 0.5) * 100) / 100, 0.02, 0.98);
  return getPeriodicWave(ctx, `pulse:${w}`, () => {
    const N = 256;
    const real = new Float32Array(N), imag = new Float32Array(N);
    // pulse centred at t=0 -> pure cosine series
    for (let n = 1; n < N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * w);
    return { real, imag };
  });
}

/** Configure an OscillatorNode for a waveform name. */
export function setOscWave(ctx, osc, wave, width = 0.5) {
  switch (wave) {
    case 'saw': case 'sawtooth': case 'supersaw': osc.type = 'sawtooth'; break;
    case 'square': osc.type = 'square'; break;
    case 'triangle': case 'tri': osc.type = 'triangle'; break;
    case 'pulse': osc.setPeriodicWave(getPulseWave(ctx, width)); break;
    default: osc.type = 'sine';
  }
}

/* ------------------------------------------------------------------ */
/* Waveshaper curves (context independent)                             */
/* ------------------------------------------------------------------ */

const curveCache = new Map();
/** Soft-clip (tanh) curve. amount 0..1 -> pre-gain 1..~40, output normalised. */
export function getDriveCurve(amount) {
  const a = Math.round(clamp(num(amount, 0), 0, 1) * 100) / 100;
  const key = `drive:${a}`;
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 2048, curve = new Float32Array(n);
  const k = 1 + a * a * 40;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  curveCache.set(key, curve);
  return curve;
}
/** Bit-depth reduction staircase curve. */
export function getCrushCurve(bits) {
  const b = Math.round(clamp(num(bits, 16), 1, 16));
  const key = `crush:${b}`;
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 8192, curve = new Float32Array(n);
  const steps = Math.pow(2, b - 1);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  curveCache.set(key, curve);
  return curve;
}

/* ------------------------------------------------------------------ */
/* Envelope helpers (click-free, offline-safe)                         */
/* ------------------------------------------------------------------ */

const MIN_T = 0.002;

/**
 * cancelAndHoldAtTime when available (Chromium/Safari), else cancel + explicit value.
 * NOTE: in Chromium a linearRamp scheduled right after a hold that lands inside a setTarget
 * segment jumps to a wrong value — only follow a hold with setTargetAtTime / setValueAtTime.
 */
export function holdAt(param, t, fallbackValue) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    try { param.cancelAndHoldAtTime(t); return; } catch { /* fall through */ }
  }
  param.cancelScheduledValues(t);
  param.setValueAtTime(Number.isFinite(fallbackValue) ? fallbackValue : param.value, t);
}

/**
 * Schedule a full ADSR on `param` starting at `t`. If `tOff` is a number, the release is
 * scheduled too; otherwise the note is held until envRelease(). Returns a state object.
 * env = {a, d, s, r} in seconds (s = 0..1 level fraction). peak may be negative (filter env).
 */
export function envNote(param, t, tOff, env, peak, base = 0, from = base) {
  const a = Math.max(MIN_T, num(env.a, 0.005)), d = Math.max(MIN_T, num(env.d, 0.2));
  const s = clamp(num(env.s, 1), 0, 1), r = Math.max(MIN_T * 2, num(env.r, 0.1));
  const sus = base + (peak - base) * s;
  const st = { t, a, d, s, r, peak, base, from, sus, tOff: null };
  param.setValueAtTime(from, t);
  if (tOff != null && tOff < t + a) {
    const v = from + (peak - from) * Math.max(0, (tOff - t) / a);
    param.linearRampToValueAtTime(v, Math.max(t + 0.0005, tOff));
    param.setTargetAtTime(base, Math.max(t + 0.0005, tOff), r / 6);
    st.tOff = Math.max(t + 0.0005, tOff);
    return st;
  }
  param.linearRampToValueAtTime(peak, t + a);
  if (Math.abs(sus - peak) > 1e-6) param.setTargetAtTime(sus, t + a, d / 4);
  if (tOff != null) {
    param.setTargetAtTime(base, tOff, r / 6);
    st.tOff = tOff;
  }
  return st;
}

/** Click-free fast fade to 0 starting at t (exponential, ~-50 dB after `fade`). */
export function fadeOut(param, t, fade = 0.012, fallbackValue) {
  holdAt(param, t, fallbackValue);
  param.setTargetAtTime(0, t, Math.max(0.0005, fade / 6));
  return t + fade;
}

/** Analytic value of an envelope state at `time` (used where cancelAndHold is missing). */
export function envValueAt(st, time) {
  const pre = (tm) => {
    if (tm <= st.t) return st.from;
    if (tm < st.t + st.a) return st.from + (st.peak - st.from) * ((tm - st.t) / st.a);
    return st.sus + (st.peak - st.sus) * Math.exp(-(tm - st.t - st.a) / (st.d / 4));
  };
  if (st.tOff != null && time >= st.tOff) {
    const v0 = pre(st.tOff);
    return st.base + (v0 - st.base) * Math.exp(-(time - st.tOff) / (st.r / 6));
  }
  return pre(time);
}

/** Release a (held) envelope at `time`. Returns the time at which it is effectively silent. */
export function envRelease(param, st, time, r = st.r) {
  if (st.tOff != null && st.tOff <= time) return st.tOff + st.r;
  const v = envValueAt(st, time);
  holdAt(param, time, v);
  param.setTargetAtTime(st.base, time, Math.max(0.001, r / 6));
  // re-base state so later analytics stay sane
  st.t = time - st.a - 1e3; st.sus = v; st.peak = v; st.from = v; st.tOff = time; st.r = r;
  return time + r;
}

/** Re-gate an envelope (mono retrigger / legato). If retrigger, run attack from the current value. */
export function envRegate(param, st, time, tOff, retrigger) {
  const v = envValueAt(st, time);
  holdAt(param, time, v);
  if (retrigger) {
    param.setTargetAtTime(st.peak0 ?? st.peak, time, st.a / 2.5);
    if (Math.abs(st.sus0 - (st.peak0 ?? st.peak)) > 1e-6) param.setTargetAtTime(st.sus0, time + st.a, st.d / 4);
    st.t = time; st.from = v; st.peak = st.peak0 ?? st.peak; st.sus = st.sus0;
  } else {
    param.setTargetAtTime(st.sus0, time, st.d / 4);
    st.t = time - st.a; st.from = v; st.peak = v; st.sus = st.sus0;
  }
  st.tOff = null;
  if (tOff != null) {
    const to = Math.max(tOff, time + 0.001);
    param.setTargetAtTime(st.base, to, st.r / 6);
    st.tOff = to;
  }
}

/* ------------------------------------------------------------------ */
/* Voice bookkeeping                                                    */
/* ------------------------------------------------------------------ */

/** Holds every node of one sounding note; disconnects them all when the sources end. */
export class Voice {
  constructor(ctx) {
    this.ctx = ctx;
    this.sources = [];
    this.nodes = [];
    this.extConns = []; // [srcNode, destParamOrNode] from long-lived nodes into this voice
    this.start = 0;
    this.end = Infinity;
    this.done = false;
    this.onDone = null;
  }
  node(n) { this.nodes.push(n); return n; }
  src(s) { this.sources.push(s); this.nodes.push(s); return s; }
  ext(src, dest) { src.connect(dest); this.extConns.push([src, dest]); }
  startAll(t) {
    let pending = this.sources.length;
    for (const s of this.sources) {
      s.start(t);
      // clean up once every source has ended (sources may stop at different times)
      s.onended = () => { if (--pending <= 0) this.cleanup(); };
    }
  }
  /** Stop every source at t (or at its own earlier stop time if given via stopEach). */
  stopAt(t) {
    this.end = t;
    for (const s of this.sources) {
      const own = s._stopAt;
      try { s.stop(own != null && own < t ? own : t); } catch { /* already stopped */ }
    }
  }
  /** Schedule an individual source to stop early (e.g. a short click layer). */
  stopSource(s, t) { s._stopAt = t; try { s.stop(t); } catch { /* */ } }
  cleanup() {
    if (this.done) return;
    this.done = true;
    for (const s of this.sources) { try { s.stop(); } catch { /* ok */ } s.onended = null; }
    for (const [src, dest] of this.extConns) { try { src.disconnect(dest); } catch { /* ok */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ok */ } }
    this.nodes.length = 0; this.sources.length = 0; this.extConns.length = 0;
    this.onDone?.(this);
  }
}

/* ------------------------------------------------------------------ */
/* Output stage shared by all instruments: drive -> tone -> gain        */
/* ------------------------------------------------------------------ */

export class OutputStage {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.pre = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.post = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = -3; // dB, ~Butterworth
    this.gain = ctx.createGain();
    this.input.connect(this.pre);
    this._driveOn = null;
    this.tone.connect(this.gain);
    if (output) this.gain.connect(output);
    this.drive = -1;
  }
  set(p, time = this.ctx.currentTime) {
    const drive = clamp(num(p.drive, 0), 0, 1);
    const on = drive > 0.001;
    if (on !== this._driveOn) {
      try { this.pre.disconnect(); } catch { /* */ }
      try { this.post.disconnect(); } catch { /* */ }
      try { this.shaper.disconnect(); } catch { /* */ }
      if (on) { this.pre.connect(this.shaper); this.shaper.connect(this.post); this.post.connect(this.tone); }
      else this.pre.connect(this.tone);
      this._driveOn = on;
    }
    if (on && Math.abs(drive - this.drive) > 0.004) {
      this.shaper.curve = getDriveCurve(drive);
      this.drive = drive;
    }
    // more pre-gain hits the shaper harder; post gain compensates loudness
    this.pre.gain.setTargetAtTime(on ? 1 + drive * 3 : 1, time, 0.02);
    this.post.gain.setTargetAtTime(on ? 1 / (1 + drive * 1.8) : 1, time, 0.02);
    const nyq = this.ctx.sampleRate / 2 - 100;
    this.tone.frequency.setTargetAtTime(clamp(num(p.toneCut, 20000), 40, nyq), time, 0.02);
    this.gain.gain.setTargetAtTime(clamp(num(p.gain, 0.8), 0, 2), time, 0.02);
  }
  dispose() {
    for (const n of [this.input, this.pre, this.shaper, this.post, this.tone, this.gain]) { try { n.disconnect(); } catch { /* */ } }
  }
}

/* ------------------------------------------------------------------ */
/* Base polyphonic instrument                                           */
/* ------------------------------------------------------------------ */

export class BaseInstrument {
  constructor(ctx, output, params, opts = {}) {
    this.ctx = ctx;
    this.opts = opts || {};
    this.out = new OutputStage(ctx, output);
    this.voices = new Set();
    this.held = new Map(); // pitch -> voice (live keyboard)
    this.params = {};
    this.setParams(params || {});
  }
  setParams(params) {
    this.params = params;
    this.out.set(params, this.ctx.currentTime);
    this.onParams?.();
  }
  get polyphony() { return Math.round(clamp(num(this.params.polyphony, 8), 1, 32)); }
  bpm() { return clamp(num(this.opts.getBpm?.(), 120), 20, 400); }
  now() { return this.ctx.currentTime; }
  _t(time) { const t = num(time, this.ctx.currentTime); return Math.max(t, this.ctx.currentTime); }

  _register(v) {
    if (!v) return v;
    this.voices.add(v);
    v.onDone = () => { this.voices.delete(v); if (this.held.get(v.pitch) === v) this.held.delete(v.pitch); };
    return v;
  }
  /** Steal oldest voices so a new one fits at time t. */
  _makeRoom(t) {
    const active = [...this.voices].filter((v) => !v.done && v.end > t + 0.001);
    let over = active.length - this.polyphony + 1;
    if (over <= 0) return;
    active.sort((a, b) => a.start - b.start);
    for (const v of active) { if (over-- <= 0) break; this._kill(v, t); }
  }
  _kill(v, t, fade = 0.012) {
    if (v.done || (v.killedAt != null && v.killedAt <= t)) return;
    t = Math.max(t, this.ctx.currentTime);
    v.killedAt = t;
    const g = v.amp?.gain;
    if (g) fadeOut(g, t, fade, v.ampSt ? envValueAt(v.ampSt, t) : g.value);
    v.stopAt(t + fade + 0.01);
  }
  /** Release voice (envelopes). Subclasses may override _releaseVoice. */
  _releaseVoice(v, t) {
    if (v.done) return;
    let end = t;
    for (const [param, st] of v.envs || []) end = Math.max(end, envRelease(param, st, t));
    v.stopAt(end + 0.02);
  }

  trigger(time, pitch, vel = 0.8, durSec = 0.25, extra = {}) {
    const t = this._t(time);
    pitch = num(pitch, 60, 0, 127);
    vel = num(vel, 0.8, 0, 1);
    const dur = num(durSec, 0.25, 0.005, 3600);
    this._makeRoom(t);
    return this._register(this._createVoice(t, pitch, vel, t + dur, extra || {}));
  }
  noteOn(pitch, vel = 0.8, time) {
    const t = this._t(time);
    pitch = num(pitch, 60, 0, 127);
    const prev = this.held.get(pitch);
    if (prev) this._releaseVoice(prev, t);
    this._makeRoom(t);
    const v = this._register(this._createVoice(t, pitch, num(vel, 0.8, 0, 1), null, {}));
    if (v) this.held.set(pitch, v);
    return v;
  }
  noteOff(pitch, time) {
    const t = this._t(time);
    const v = this.held.get(pitch);
    if (!v) return;
    this.held.delete(pitch);
    this._releaseVoice(v, t);
  }
  allNotesOff(time) {
    const t = this._t(time);
    for (const v of this.voices) this._kill(v, t, 0.02);
    this.held.clear();
  }
  dispose() {
    this.allNotesOff();
    this.disposeExtra?.();
    const out = this.out;
    if (!isOffline(this.ctx)) setTimeout(() => out.dispose(), 120);
  }
  // eslint-disable-next-line no-unused-vars
  _createVoice(t, pitch, vel, tOff, extra) { return null; }
}

/* ------------------------------------------------------------------ */
/* Subtractive synth                                                    */
/* ------------------------------------------------------------------ */

// JP-8000-style supersaw detune ratios (relative), centre osc at index 3
const SUPERSAW = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
const VOICE_SCALE = 0.3;
const LFO_SCALE = { pitch: 1200, filter: 4800, amp: 1, pan: 1, oscmix: 1 };

function filterQ(type, res) {
  const r = clamp(num(res, 0), 0, 1);
  if (type === 'bp' || type === 'notch') return 0.5 + r * r * 24; // linear Q
  return -3 + Math.pow(r, 1.2) * 27; // lowpass/highpass Q is in dB
}

export class SynthInstrument extends BaseInstrument {
  constructor(ctx, output, params, opts) {
    super(ctx, output, params, opts);
    this.type = 'synth';
    this.bend = ctx.createConstantSource(); // cents, shared pitch-bend
    this.bend.offset.value = 0;
    this.bend.start();
    this.mono = null; // current mono voice
    this.monoStack = [];
    this.lastPitch = null;
  }
  disposeExtra() { try { this.bend.stop(); this.bend.disconnect(); } catch { /* */ } }

  pitchBend(value, time) {
    const t = this._t(time);
    const cents = clamp(num(value, 0), -1, 1) * num(this.params.bendRange, 2, 0, 24) * 100;
    this.bend.offset.setTargetAtTime(cents, t, 0.01);
  }

  onParams() {
    // live-update sounding voices (cheap params only)
    const p = this.params, t = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.done) continue;
      for (let i = 1; i <= 3; i++) {
        const g = v.oscGains?.[i];
        if (g) g.gain.setTargetAtTime(clamp(num(p[`osc${i}Level`], 0), 0, 1), t, 0.02);
      }
      if (v.subGain) v.subGain.gain.setTargetAtTime(clamp(num(p.subLevel, 0), 0, 1), t, 0.02);
      if (v.noiseGain) v.noiseGain.gain.setTargetAtTime(clamp(num(p.noiseLevel, 0), 0, 1) * 0.6, t, 0.02);
      if (v.filters?.length) {
        const f = this._cutoff(v.pitch, v.vel, v.cutoffOverride);
        v.filters.forEach((fl, idx) => {
          fl.frequency.setTargetAtTime(f, t, 0.02);
          if (idx === v.filters.length - 1) fl.Q.setTargetAtTime(filterQ(p.filterType, p.resonance), t, 0.02);
        });
      }
    }
  }

  _isMono() { return !!this.params.mono; }

  _cutoff(pitch, vel, override) {
    const p = this.params;
    const base = override != null ? num(override, 8000, 20, 20000) : num(p.cutoff, 8000, 20, 20000);
    const kt = num(p.keytrack, 0, 0, 1);
    const vf = num(p.velToFilter, 0, 0, 1);
    const f = base * Math.pow(2, ((pitch - 60) / 12) * kt) * Math.pow(2, vf * (vel - 0.8) * 2.5);
    return clamp(f, 20, this.ctx.sampleRate / 2 - 100);
  }

  _lfoRate(k) {
    const p = this.params;
    if (p[`lfo${k}Sync`]) return clamp((this.bpm() / 60) / divisionBeats(p[`lfo${k}Div`]), 0.01, 50);
    return num(p[`lfo${k}Rate`], 4, 0.01, 50);
  }

  trigger(time, pitch, vel = 0.8, durSec = 0.25, extra = {}) {
    if (!this._isMono()) return super.trigger(time, pitch, vel, durSec, extra);
    const t = this._t(time);
    return this._monoNote(t, num(pitch, 60, 0, 127), num(vel, 0.8, 0, 1), t + num(durSec, 0.25, 0.005, 3600), extra || {});
  }
  noteOn(pitch, vel = 0.8, time) {
    if (!this._isMono()) return super.noteOn(pitch, vel, time);
    const t = this._t(time);
    pitch = num(pitch, 60, 0, 127);
    this.monoStack = this.monoStack.filter((x) => x.pitch !== pitch);
    this.monoStack.push({ pitch, vel: num(vel, 0.8, 0, 1) });
    return this._monoNote(t, pitch, num(vel, 0.8, 0, 1), null, {});
  }
  noteOff(pitch, time) {
    if (!this._isMono()) return super.noteOff(pitch, time);
    const t = this._t(time);
    const top = this.monoStack[this.monoStack.length - 1];
    this.monoStack = this.monoStack.filter((x) => x.pitch !== pitch);
    if (!top || top.pitch !== pitch) return;
    const next = this.monoStack[this.monoStack.length - 1];
    const v = this.mono;
    if (!v || v.done) return;
    if (next) this._monoNote(t, next.pitch, next.vel, null, { _forceLegato: true });
    else this._releaseVoice(v, t);
  }
  allNotesOff(time) {
    super.allNotesOff(time);
    this.monoStack = [];
    this.mono = null;
  }

  _monoNote(t, pitch, vel, tOff, extra) {
    const p = this.params;
    const v = this.mono;
    // a voice with a scheduled stop can't be held indefinitely (stop() can't be undone)
    const alive = v && !v.done && v.end > Math.max(t, this.ctx.currentTime) + 0.03 && (tOff != null || v.end === Infinity);
    const glide = num(p.glide, 0, 0, 5);
    if (!alive) {
      if (v && !v.done && tOff == null) this._releaseVoice(v, t);
      this._makeRoom(t);
      const ex = { ...extra };
      if (ex.glideFrom == null && glide > 0 && p.glideAlways && this.lastPitch != null) ex.glideFrom = this.lastPitch;
      const nv = this._register(this._createVoice(t, pitch, vel, tOff, ex));
      this.mono = nv;
      this.lastPitch = pitch;
      return nv;
    }
    const gateOpen = v.ampSt.tOff == null || v.ampSt.tOff > t + 0.0005;
    const legato = (p.legato !== false && gateOpen) || extra._forceLegato;
    // pitch
    const freq = midiToFreq(pitch + num(p.transpose, 0, -48, 48));
    const fromFreq = extra.glideFrom != null ? midiToFreq(num(extra.glideFrom, pitch) + num(p.transpose, 0, -48, 48)) : null;
    const fp = v.fsrc.offset;
    const curFreq = v.curFreq || freq;
    const gTime = glide > 0 ? glide : extra.glideFrom != null ? 0.06 : 0;
    holdAt(fp, t, curFreq);
    if (fromFreq != null) fp.setValueAtTime(fromFreq, t);
    // exponential (RC-style) portamento; setTarget is exact after a hold (see holdAt note)
    if ((legato || p.glideAlways || fromFreq != null) && gTime > 0) fp.setTargetAtTime(freq, t, gTime / 3);
    else fp.setValueAtTime(freq, t);
    v.curFreq = freq;
    v.pitch = pitch;
    if (extra.cutoff != null && v.filters?.length) {
      const f = this._cutoff(pitch, vel, extra.cutoff);
      for (const fl of v.filters) fl.frequency.setTargetAtTime(f, t, 0.01);
    }
    // envelopes
    let end = t;
    for (const [param, st] of v.envs) {
      envRegate(param, st, t, tOff, !legato);
      end = Math.max(end, (st.tOff ?? Infinity) + st.r);
    }
    v.stopAt(Number.isFinite(end) ? end + 0.05 : Infinity);
    if (!Number.isFinite(end)) v.end = Infinity;
    this.lastPitch = pitch;
    return v;
  }

  _releaseVoice(v, t) {
    if (v.done) return;
    let end = t;
    for (const [param, st] of v.envs || []) end = Math.max(end, envRelease(param, st, t));
    v.stopAt(end + 0.03);
  }

  _createVoice(t, pitch, vel, tOff, extra) {
    const ctx = this.ctx, p = this.params;
    const v = new Voice(ctx);
    v.pitch = pitch; v.vel = vel; v.start = t; v.envs = [];
    v.cutoffOverride = extra.cutoff;
    const transpose = num(p.transpose, 0, -48, 48);
    const freq = midiToFreq(pitch + transpose);
    const glide = num(p.glide, 0, 0, 5);

    // shared frequency source (Hz) -> every oscillator's frequency input (glide in one place)
    const fsrc = v.src(ctx.createConstantSource());
    v.fsrc = fsrc;
    v.curFreq = freq;
    if (extra.glideFrom != null) {
      const from = midiToFreq(num(extra.glideFrom, pitch, 0, 127) + transpose);
      fsrc.offset.setValueAtTime(from, t);
      fsrc.offset.exponentialRampToValueAtTime(freq, t + (glide > 0 ? glide : 0.06));
    } else {
      fsrc.offset.setValueAtTime(freq, t);
    }

    const mix = v.node(ctx.createGain());
    mix.gain.value = VOICE_SCALE;
    const detuneTargets = [];
    v.oscGains = [];

    const unison = Math.round(num(p.unison, 1, 1, 7));
    const uDet = num(p.unisonDetune, 15, 0, 100);
    const spread = num(p.unisonSpread, 0.5, 0, 1);
    const superDet = num(p.superDetune, 0.4, 0, 1);

    for (let i = 1; i <= 3; i++) {
      const level = clamp(num(p[`osc${i}Level`], i === 1 ? 0.8 : 0), 0, 1);
      if (level <= 0.0005) continue;
      const wave = p[`osc${i}Wave`] || 'saw';
      const cents = num(p[`osc${i}Octave`], 0, -4, 4) * 1200 + num(p[`osc${i}Semi`], 0, -24, 24) * 100 + num(p[`osc${i}Fine`], 0, -100, 100);
      const g = v.node(ctx.createGain());
      g.connect(mix);
      v.oscGains[i] = g;
      // build list of (detuneCents, pan)
      const parts = [];
      const uni = wave === 'supersaw' ? Math.min(unison, 2) : unison;
      for (let u = 0; u < uni; u++) {
        const uo = uni > 1 ? (u / (uni - 1) - 0.5) * uDet : 0;
        const upan = uni > 1 ? (u / (uni - 1) - 0.5) * 2 * spread : 0;
        if (wave === 'supersaw') {
          SUPERSAW.forEach((r, k) => {
            const dc = 1200 * Math.log2(1 + r * superDet);
            const pan = clamp(((k / 6) - 0.5) * 2 * spread + upan * 0.5, -1, 1);
            parts.push([uo + dc, uni > 1 ? (u % 2 ? -1 : 1) * Math.abs(pan) : pan]);
          });
        } else parts.push([uo, upan]);
      }
      g.gain.value = level;
      const partGain = 1 / Math.sqrt(parts.length);
      const sum = v.node(ctx.createGain());
      sum.gain.value = partGain * (wave === 'supersaw' ? 1.5 : 1);
      sum.connect(g);
      // stereo: bucket parts into left / centre / right panners (3 nodes instead of one per osc)
      const buckets = {};
      const bucketFor = (pan) => {
        const b = pan < -0.15 ? -1 : pan > 0.15 ? 1 : 0;
        if (b === 0) return sum;
        if (!buckets[b]) {
          const pn = v.node(ctx.createStereoPanner());
          pn.pan.value = b * Math.min(1, spread * 0.9 + 0.1);
          pn.connect(sum);
          buckets[b] = pn;
        }
        return buckets[b];
      };
      for (const [dc, pan] of parts) {
        const osc = v.src(ctx.createOscillator());
        setOscWave(ctx, osc, wave, p[`osc${i}Width`]);
        osc.frequency.value = 0;
        fsrc.connect(osc.frequency);
        osc.detune.value = cents + dc;
        detuneTargets.push([osc.detune, cents + dc]);
        osc.connect(bucketFor(pan));
      }
    }
    // sub oscillator
    const subLevel = clamp(num(p.subLevel, 0), 0, 1);
    if (subLevel > 0.0005) {
      const sub = v.src(ctx.createOscillator());
      setOscWave(ctx, sub, p.subWave || 'sine');
      sub.frequency.value = 0;
      fsrc.connect(sub.frequency);
      const sc = num(p.subOctave, -1, -2, -1) * 1200;
      sub.detune.value = sc;
      detuneTargets.push([sub.detune, sc]);
      const sg = v.node(ctx.createGain());
      sg.gain.value = subLevel;
      sub.connect(sg); sg.connect(mix);
      v.subGain = sg;
    }
    // noise
    const noiseLevel = clamp(num(p.noiseLevel, 0), 0, 1);
    if (noiseLevel > 0.0005) {
      const ns = v.src(ctx.createBufferSource());
      ns.buffer = getNoiseBuffer(ctx, p.noiseType === 'pink' ? 'pink' : 'white');
      ns.loop = true;
      ns.loopStart = 0; ns.loopEnd = ns.buffer.duration;
      const ng = v.node(ctx.createGain());
      ng.gain.value = noiseLevel * 0.6;
      ns.connect(ng); ng.connect(mix);
      v.noiseGain = ng;
    }
    if (v.sources.length <= 1) { // nothing audible configured
      const osc = v.src(ctx.createOscillator());
      osc.type = 'sawtooth'; osc.frequency.value = 0; fsrc.connect(osc.frequency);
      detuneTargets.push([osc.detune, 0]);
      const g = v.node(ctx.createGain()); g.gain.value = 0.8; osc.connect(g); g.connect(mix);
    }

    // pitch: bend + pitch envelope
    for (const [d] of detuneTargets) v.ext(this.bend, d);
    const pe = num(p.pitchEnvAmt, 0, -48, 48);
    if (Math.abs(pe) > 0.01) {
      const ped = Math.max(0.002, num(p.pitchEnvDecay, 0.05, 0, 5));
      for (const [d, base] of detuneTargets) {
        d.setValueAtTime(base + pe * 100, t);
        d.setTargetAtTime(base, t, ped / 4);
      }
    }

    // filter
    let node = mix;
    const ftype = p.filterType || 'lp24';
    v.filters = [];
    if (ftype !== 'off') {
      const map = { lp12: ['lowpass'], lp24: ['lowpass', 'lowpass'], hp12: ['highpass'], hp24: ['highpass', 'highpass'], bp: ['bandpass'], notch: ['notch'] };
      const types = map[ftype] || map.lp24;
      const fc = this._cutoff(pitch, vel, extra.cutoff);
      const fmod = v.src(ctx.createConstantSource());
      fmod.offset.value = 0;
      v.fmod = fmod;
      types.forEach((ty, idx) => {
        const f = v.node(ctx.createBiquadFilter());
        f.type = ty;
        f.frequency.value = fc;
        const last = idx === types.length - 1;
        f.Q.value = last ? filterQ(ftype, extra.resonance != null ? num(extra.resonance, 0, 0, 1) : p.resonance) : (ty === 'lowpass' || ty === 'highpass' ? -3 : 0.7);
        fmod.connect(f.detune);
        node.connect(f);
        node = f;
        v.filters.push(f);
      });
      const amt = num(p.fEnvAmount, 0, -8, 8);
      if (Math.abs(amt) > 0.001) {
        const vf = num(p.velToFilter, 0, 0, 1);
        const peak = amt * 1200 * (1 - vf + vf * vel);
        v.envs.push([fmod.offset, envNote(fmod.offset, t, tOff, { a: p.fAttack, d: p.fDecay, s: p.fSustain, r: p.fRelease }, peak, 0)]);
        v.envs[v.envs.length - 1][1].peak0 = peak;
        v.envs[v.envs.length - 1][1].sus0 = peak * clamp(num(p.fSustain, 0.3), 0, 1);
      }
    }

    // amp
    const amp = v.node(ctx.createGain());
    amp.gain.value = 0;
    node.connect(amp);
    v.amp = amp;
    const va = num(p.velToAmp, 0.6, 0, 1);
    const peak = 1 - va + va * vel;
    const ampEnv = { a: p.attack, d: p.decay, s: p.sustain, r: p.release };
    v.ampSt = envNote(amp.gain, t, tOff, ampEnv, peak, 0);
    v.ampSt.peak0 = peak; v.ampSt.sus0 = peak * clamp(num(p.sustain, 0.8), 0, 1);
    v.envs.unshift([amp.gain, v.ampSt]);
    let outNode = amp;

    // LFOs
    const lfos = [];
    for (let k = 1; k <= 2; k++) {
      const target = p[`lfo${k}Target`] || 'none';
      const depth = num(p[`lfo${k}Depth`], 0, 0, 1);
      if (target === 'none' || depth <= 0.0001) continue;
      if (target === 'filter' && !v.fmod) continue;
      if (target === 'oscmix' && !(v.oscGains[1] && v.oscGains[2])) continue;
      lfos.push({ k, target, depth });
    }
    let trem = null, panner = null;
    if (lfos.some((l) => l.target === 'amp')) {
      trem = v.node(ctx.createGain());
      trem.gain.value = 1;
      outNode.connect(trem); outNode = trem;
    }
    const pan = extra.pan != null ? num(extra.pan, 0, -1, 1) : null;
    if (pan != null || lfos.some((l) => l.target === 'pan')) {
      panner = v.node(ctx.createStereoPanner());
      panner.pan.value = pan ?? 0;
      outNode.connect(panner); outNode = panner;
    }
    for (const { k, target, depth } of lfos) {
      const lfo = v.src(ctx.createOscillator());
      const shape = p[`lfo${k}Shape`] || 'sine';
      lfo.type = shape === 'ramp' ? 'sawtooth' : ['sine', 'triangle', 'square', 'sawtooth'].includes(shape) ? shape : 'sine';
      lfo.frequency.value = this._lfoRate(k);
      const lg = v.node(ctx.createGain());
      let scaled = depth * LFO_SCALE[target] * (shape === 'ramp' ? -1 : 1);
      if (target === 'amp') { scaled = depth / 2; trem.gain.value = Math.min(trem.gain.value, 1 - depth / 2); }
      if (target === 'oscmix') scaled = depth * 0.5;
      const fade = num(p[`lfo${k}Fade`], 0, 0, 10);
      if (fade > 0.001) { lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(scaled, t + fade); } else lg.gain.value = scaled;
      lfo.connect(lg);
      if (target === 'pitch') for (const [d] of detuneTargets) lg.connect(d);
      else if (target === 'filter') for (const f of v.filters) lg.connect(f.detune);
      else if (target === 'amp') lg.connect(trem.gain);
      else if (target === 'pan') lg.connect(panner.pan);
      else if (target === 'oscmix') {
        lg.connect(v.oscGains[2].gain);
        const inv = v.node(ctx.createGain()); inv.gain.value = -1; lg.connect(inv); inv.connect(v.oscGains[1].gain);
      }
    }
    outNode.connect(this.out.input);

    // start / schedule stop
    v.startAll(t);
    if (tOff != null) {
      let end = tOff;
      for (const [, st] of v.envs) end = Math.max(end, st.tOff + st.r);
      v.stopAt(end + 0.03);
    }
    return v;
  }
}
