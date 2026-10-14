// Subtractive polysynth + shared voice/DSP helpers used by every instrument engine.
// Browser-only at runtime, but importable in Node (no AudioContext use at import time).
import { clamp, createRng, midiToFreq } from '../core/util.js';
import { padTable, padZone } from './dsp/padsynth.js';
import { pluckTable } from './dsp/pluck.js';
import { pianoTable, PIANO_ZONE } from './dsp/piano.js';
import { warmLater } from './dsp/bufcache.js';

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

/* ---- phase-rotated band-limited waves (free-running oscillator emulation) ---- */
// Web Audio oscillators always start at phase 0; analog/JP-8000 style oscillators are free
// running. We emulate a random start phase with phase-rotated PeriodicWaves (8 phases cached).
const PHASES = 8;
function basicCoeffs(wave, width) {
  const N = wave === 'sine' ? 2 : wave === 'triangle' ? 512 : 2048;
  const real = new Float32Array(N), imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    if (wave === 'saw') imag[n] = (2 / (n * Math.PI)) * (n % 2 ? 1 : -1);
    else if (wave === 'square') imag[n] = n % 2 ? 4 / (n * Math.PI) : 0;
    else if (wave === 'triangle') imag[n] = (8 * Math.sin((n * Math.PI) / 2)) / (n * n * Math.PI * Math.PI);
    else if (wave === 'pulse') real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * width);
    else if (n === 1) imag[n] = 1;
  }
  return { real, imag };
}
function rotate({ real, imag }, frac) {
  const r = new Float32Array(real.length), im = new Float32Array(imag.length);
  for (let n = 1; n < real.length; n++) {
    const th = 2 * Math.PI * n * frac, c = Math.cos(th), s = Math.sin(th);
    r[n] = real[n] * c + imag[n] * s;
    im[n] = imag[n] * c - real[n] * s;
  }
  return { real: r, imag: im };
}
/** Band-limited basic wave ('saw'|'square'|'triangle'|'sine'|'pulse') starting at phase k/8. */
export function getPhasedWave(ctx, wave, width = 0.5, k = 0) {
  const w = wave === 'pulse' ? clamp(Math.round(num(width, 0.5) * 100) / 100, 0.02, 0.98) : 0.5;
  const kk = ((Math.round(k) % PHASES) + PHASES) % PHASES;
  return getPeriodicWave(ctx, `ph:${wave}:${w}:${kk}`, () => rotate(basicCoeffs(wave, w), kk / PHASES));
}

/**
 * Hard-sync approximation: the spectrum of a saw slave reset by the master every cycle, for a
 * fixed slave/master ratio (analytic Fourier series of the piecewise-linear wave, band-limited).
 */
export function getSyncWave(ctx, ratio = 2) {
  const r = clamp(Math.round(num(ratio, 2) * 20) / 20, 1, 8);
  return getPeriodicWave(ctx, `sync:${r}`, () => {
    const N = 1024;
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let k = 0; k < r; k++) {
      const x0 = k / r, x1 = Math.min((k + 1) / r, 1);
      const A = 2 * r, B = -2 * k - 1; // f(x) = A x + B on [x0, x1)
      for (let n = 1; n < N; n++) {
        const w = 2 * Math.PI * n;
        const Ic = (x) => ((A * x + B) * Math.sin(w * x)) / w + (A * Math.cos(w * x)) / (w * w);
        const Is = (x) => (-(A * x + B) * Math.cos(w * x)) / w + (A * Math.sin(w * x)) / (w * w);
        real[n] += 2 * (Ic(x1) - Ic(x0));
        imag[n] += 2 * (Is(x1) - Is(x0));
      }
    }
    return { real, imag };
  });
}
/** osc width knob (0.05..0.95) -> sync ratio 1..4.5 */
export const syncRatio = (width) => 1 + ((clamp(num(width, 0.5), 0.05, 0.95) - 0.05) / 0.9) * 3.5;

/** Configure an OscillatorNode for a waveform name (phaseIdx >= 0 -> free-running start phase). */
export function setOscWave(ctx, osc, wave, width = 0.5, phaseIdx = -1) {
  const basic = { saw: 'saw', sawtooth: 'saw', supersaw: 'saw', square: 'square', triangle: 'triangle', tri: 'triangle', sine: 'sine' }[wave];
  if (wave === 'pulse') { osc.setPeriodicWave(phaseIdx >= 0 ? getPhasedWave(ctx, 'pulse', width, phaseIdx) : getPulseWave(ctx, width)); return; }
  if (wave === 'sync') { osc.setPeriodicWave(getSyncWave(ctx, syncRatio(width))); return; }
  if (phaseIdx >= 0 && basic) { osc.setPeriodicWave(getPhasedWave(ctx, basic, 0.5, phaseIdx)); return; }
  switch (basic) {
    case 'saw': osc.type = 'sawtooth'; break;
    case 'square': osc.type = 'square'; break;
    case 'triangle': osc.type = 'triangle'; break;
    default: osc.type = 'sine';
  }
}

/** Velocity -> gain with a gentle exponential curve (sens 0 = flat, 1 = full range). */
export function velCurve(vel, sens) {
  const v = clamp(num(vel, 0.8), 0, 1), s = clamp(num(sens, 0.6), 0, 1);
  return 1 - s + s * Math.pow(v, 1.5);
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

/**
 * Asymmetric tube-style curve (even harmonics): tanh with a bias, re-centred so 0 -> 0.
 * amount 0..1 -> drive 1..~25.
 */
export function getTubeCurve(amount) {
  const a = Math.round(clamp(num(amount, 0), 0, 1) * 100) / 100;
  const key = `tube:${a}`;
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 4096, curve = new Float32Array(n);
  const k = 1 + a * a * 24, bias = 0.35;
  const off = Math.tanh(bias);
  let mx = 1e-9;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x + bias) - off;
    mx = Math.max(mx, Math.abs(curve[i]));
  }
  for (let i = 0; i < n; i++) curve[i] /= mx;
  curveCache.set(key, curve);
  return curve;
}
/**
 * Guitar-amp gain stage: high gain, harder clipping on the positive half than the negative
 * (asymmetric -> even + odd harmonics, like a cathode-biased triode stack). amount 0..1.
 */
export function getAmpCurve(amount) {
  const a = Math.round(clamp(num(amount, 0), 0, 1) * 100) / 100;
  const key = `amp:${a}`;
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 8192, curve = new Float32Array(n);
  const k = 2 + a * a * 90;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = x >= 0 ? Math.tanh(k * x) : -Math.pow(Math.tanh(-k * x * 0.75), 1.25) * 0.92;
    curve[i] = y;
  }
  curveCache.set(key, curve);
  return curve;
}
/** Gentle per-voice saturation before the filter (unity gain for small signals). */
export function getSatCurve(amount) {
  const a = Math.round(clamp(num(amount, 0), 0, 1) * 50) / 50;
  const key = `sat:${a}`;
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 2048, curve = new Float32Array(n);
  const k = 1 + a * 5; // input range is ±2 (see filter drive): soft knee
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    curve[i] = Math.tanh(k * x) / k;
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

// Analog-style attack: an RC charging towards ~1.5x the target and cut off at the peak gives a
// convex rise (fast start, slowing near the top). Approximated with 4 linear segments.
const ATTACK_SHAPE = [[0.15, 0.32], [0.38, 0.65], [0.66, 0.88], [1, 1]];
function attackFrac(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let px = 0, py = 0;
  for (const [ax, ay] of ATTACK_SHAPE) {
    if (x <= ax) return py + ((ay - py) * (x - px)) / (ax - px);
    px = ax; py = ay;
  }
  return 1;
}
function rampAttack(param, st, tEnd) {
  const pts = st.convex ? ATTACK_SHAPE : [[1, 1]];
  const val = (x) => st.from + (st.peak - st.from) * (st.convex ? attackFrac(x) : Math.min(1, x));
  for (const [x] of pts) {
    const tt = st.t + x * st.a;
    if (tt >= tEnd - 1e-6) { param.linearRampToValueAtTime(val((tEnd - st.t) / st.a), tEnd); return; }
    param.linearRampToValueAtTime(val(x), tt);
  }
}

/**
 * Schedule a full ADSR on `param` starting at `t`. If `tOff` is a number, the release is
 * scheduled too; otherwise the note is held until envRelease(). Returns a state object.
 * env = {a, d, s, r} in seconds (s = 0..1 level fraction). peak may be negative (filter env).
 * Attack is convex (analog RC) for attacks >= 12 ms, decay/release are exponential (RC).
 */
export function envNote(param, t, tOff, env, peak, base = 0, from = base) {
  const a = Math.max(MIN_T, num(env.a, 0.005)), d = Math.max(MIN_T, num(env.d, 0.2));
  const s = clamp(num(env.s, 1), 0, 1), r = Math.max(MIN_T * 2, num(env.r, 0.1));
  const sus = base + (peak - base) * s;
  const st = { t, a, d, s, r, peak, base, from, sus, tOff: null, convex: a >= 0.012 && env.linear !== true };
  param.setValueAtTime(from, t);
  if (tOff != null && tOff < t + a) {
    const te = Math.max(t + 0.0005, tOff);
    rampAttack(param, st, te);
    param.setTargetAtTime(base, te, r / 6);
    st.tOff = te;
    return st;
  }
  rampAttack(param, st, t + a);
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
  const pre = st.fn || ((tm) => {
    if (tm <= st.t) return st.from;
    if (tm < st.t + st.a) {
      const x = (tm - st.t) / st.a;
      return st.from + (st.peak - st.from) * (st.convex ? attackFrac(x) : x);
    }
    return st.sus + (st.peak - st.sus) * Math.exp(-(tm - st.t - st.a) / (st.d / 4));
  });
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
  st.t = time - st.a - 1e3; st.sus = v; st.peak = v; st.from = v; st.tOff = time; st.r = r; st.convex = false; st.fn = null;
  return time + r;
}

/** Re-gate an envelope (mono retrigger / legato). If retrigger, run attack from the current value. */
export function envRegate(param, st, time, tOff, retrigger) {
  const v = envValueAt(st, time);
  holdAt(param, time, v);
  if (retrigger) {
    param.setTargetAtTime(st.peak0 ?? st.peak, time, st.a / 2.5);
    if (Math.abs(st.sus0 - (st.peak0 ?? st.peak)) > 1e-6) param.setTargetAtTime(st.sus0, time + st.a, st.d / 4);
    st.t = time; st.from = v; st.peak = st.peak0 ?? st.peak; st.sus = st.sus0; st.convex = false; st.fn = null;
  } else {
    param.setTargetAtTime(st.sus0, time, st.d / 4);
    st.t = time - st.a; st.from = v; st.peak = v; st.sus = st.sus0; st.convex = false; st.fn = null;
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
      if (s._offset != null) s.start(t, s._offset); else s.start(t);
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
    for (const s of this.lazy || []) { try { s.stop(); } catch { /* ok */ } } // MPE expression sources (noteExpression)
    for (const [src, dest] of this.extConns) { try { src.disconnect(dest); } catch { /* ok */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ok */ } }
    this.nodes.length = 0; this.sources.length = 0; this.extConns.length = 0;
    this.onDone?.(this);
  }
}

/* ------------------------------------------------------------------ */
/* Output stage shared by all instruments: drive -> tone -> gain        */
/* ------------------------------------------------------------------ */

export const DRIVE_TYPES = ['soft', 'tube', 'amp'];

/**
 * input -> pre -> [amp pre-EQ] -> [shaper -> dc-block] -> post -> [cabinet] -> tone -> gain -> output
 * driveType: 'soft' (symmetric tanh), 'tube' (asymmetric, even harmonics), 'amp' (guitar amp:
 * tightening HPF + mid hump into a high-gain asymmetric stage, then a 4x12-ish cabinet:
 * HPF 80 Hz, low resonance ~120 Hz, presence peak ~2.4 kHz, steep roll-off above ~5 kHz).
 */
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
    this.lowCut = ctx.createBiquadFilter(); // mix low-cut (12 dB/oct), ~off at 10 Hz
    this.lowCut.type = 'highpass';
    this.lowCut.frequency.value = 10;
    this.lowCut.Q.value = 0.6;
    this.gain = ctx.createGain();
    this.input.connect(this.pre);
    this._route = null;
    this.tone.connect(this.lowCut);
    this.lowCut.connect(this.gain);
    if (output) this.gain.connect(output);
    this.drive = -1;
    this.curveKey = '';
  }
  _biquad(type, f, q, g = 0) {
    const b = this.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    return b;
  }
  _ampNodes() {
    if (!this.ampPre) {
      this.ampPre = [this._biquad('highpass', 110, 0.6), this._biquad('peaking', 750, 0.8, 5)];
      this.cab = [this._biquad('highpass', 80, 0.7), this._biquad('peaking', 120, 1.2, 3), this._biquad('peaking', 420, 1, -3),
        this._biquad('peaking', 2400, 1.4, 4), this._biquad('lowpass', 5200, 0.9), this._biquad('lowpass', 6500, 0.6)];
      for (const list of [this.ampPre, this.cab]) for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
    }
  }
  _dcNode() {
    if (!this.dc) this.dc = this._biquad('highpass', 18, 0.6);
    return this.dc;
  }
  set(p, time = this.ctx.currentTime) {
    const drive = clamp(num(p.drive, 0), 0, 1);
    const type = DRIVE_TYPES.includes(p.driveType) ? p.driveType : 'soft';
    const on = drive > 0.001;
    const route = `${on}:${type}`;
    if (route !== this._route) {
      for (const n of [this.pre, this.post, this.shaper, this.dc, ...(this.ampPre || []), ...(this.cab || [])]) {
        if (n) { try { n.disconnect(); } catch { /* */ } }
      }
      if (type === 'amp') {
        this._ampNodes();
        for (const list of [this.ampPre, this.cab]) for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
      }
      let node = this.pre;
      const link = (n) => { node.connect(n); node = n; };
      if (type === 'amp') { link(this.ampPre[0]); node = this.ampPre[this.ampPre.length - 1]; }
      if (on) {
        link(this.shaper);
        if (type !== 'soft') link(this._dcNode());
      }
      link(this.post);
      if (type === 'amp') { link(this.cab[0]); node = this.cab[this.cab.length - 1]; }
      node.connect(this.tone);
      this.shaper.oversample = type === 'amp' ? '4x' : '2x';
      this._route = route;
      this.curveKey = '';
    }
    const ck = `${type}:${Math.round(drive * 200)}`;
    if (on && ck !== this.curveKey) {
      this.shaper.curve = type === 'amp' ? getAmpCurve(drive) : type === 'tube' ? getTubeCurve(drive) : getDriveCurve(drive);
      this.curveKey = ck;
      this.drive = drive;
    }
    // more pre-gain hits the shaper harder; post gain compensates loudness
    const preG = !on ? 1 : type === 'amp' ? 1 + drive * 2 : 1 + drive * 3;
    const postG = !on ? 1 : type === 'amp' ? 0.55 / (1 + drive * 0.6) : 1 / (1 + drive * 1.8);
    this.pre.gain.setTargetAtTime(preG, time, 0.02);
    this.post.gain.setTargetAtTime(postG, time, 0.02);
    const nyq = this.ctx.sampleRate / 2 - 100;
    this.tone.frequency.setTargetAtTime(clamp(num(p.toneCut, 20000), 40, nyq), time, 0.02);
    const lc = num(p.lowCut, 20, 20, 2000);
    this.lowCut.frequency.setTargetAtTime(lc <= 21 ? 10 : lc, time, 0.02);
    this.gain.gain.setTargetAtTime(clamp(num(p.gain, 0.8), 0, 2), time, 0.02);
  }
  dispose() {
    for (const n of [this.input, this.pre, this.shaper, this.post, this.tone, this.lowCut, this.gain, this.dc, ...(this.ampPre || []), ...(this.cab || [])]) {
      if (n) { try { n.disconnect(); } catch { /* */ } }
    }
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
    this.rand = createRng(0x5eed1); // deterministic per instance -> reproducible offline renders
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

// JP-8000 supersaw (Adam Szabo, "How to Emulate the Super Saw", 2010): 7 saws with these relative
// offsets scaled by a non-linear detune curve, centre/side mix curves and a pitch-tracked HPF.
const SUPERSAW = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
/** Szabo's measured detune-knob curve (0..1 -> 0..1). */
export function superDetuneCurve(x) {
  x = clamp(num(x, 0.5), 0, 1);
  return 10028.7312891634 * x ** 11 - 50818.8652045924 * x ** 10 + 111363.4808729368 * x ** 9 - 138150.6761080548 * x ** 8
    + 106649.6679158292 * x ** 7 - 53046.9642751875 * x ** 6 + 17019.9518580080 * x ** 5 - 3425.0836591318 * x ** 4
    + 404.2703938388 * x ** 3 - 24.1878824391 * x ** 2 + 0.6717417634 * x + 0.0030115596;
}
/** Szabo's mix curves: [centre gain, side gain] for mix 0..1. */
export function superMixCurve(m) {
  m = clamp(num(m, 0.75), 0, 1);
  return [-0.55366 * m + 0.99785, -0.73764 * m * m + 1.2841 * m + 0.044372];
}

const VOICE_SCALE = 0.3;
const LFO_SCALE = { pitch: 1200, filter: 4800, amp: 1, pan: 1, oscmix: 1, pwm: 1 };
/** Wave names rendered from procedurally generated sample tables (src/audio/dsp). */
export const MODEL_WAVES = ['pad', 'ensemble', 'choir', 'pluck', 'piano'];
const PAD_WAVES = new Set(['pad', 'ensemble', 'choir']);

/**
 * Resonance 0..1 -> Biquad Q. Low/high-pass Q is in dB: a power curve keeps the useful range
 * wide while topping out at +21 dB (a 4-pole ladder "whistles" but never screams).
 */
export function filterQ(type, res) {
  const r = clamp(num(res, 0), 0, 1);
  if (type === 'bp' || type === 'notch') return 0.5 + r * r * 18; // linear Q
  return -3 + Math.pow(r, 1.4) * 24;
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

  /** Per-note expression of a held note (MPE): bend (semitones) on that voice only; timbre (CC74) and pressure
   * open / close its filter. Created lazily so voices without expression cost nothing. */
  noteExpression(pitch, x = {}, time) {
    const v = this._isMono() ? (this.monoStack.at(-1)?.pitch === pitch ? this.mono : null) : this.held.get(pitch);
    if (!v || v.done) return;
    const t = this._t(time);
    const lazy = () => {
      const s = v.node(this.ctx.createConstantSource());
      s.offset.value = 0;
      s.start(t);
      (v.lazy || (v.lazy = [])).push(s);
      return s;
    };
    if (Number.isFinite(x.bend) && v.detuneTargets?.length) {
      if (!v.mpeBend) { v.mpeBend = lazy(); for (const [d] of v.detuneTargets) v.mpeBend.connect(d); }
      v.mpeBend.offset.setTargetAtTime(clamp(x.bend, -96, 96) * 100, t, 0.006);
    }
    if ((Number.isFinite(x.timbre) || Number.isFinite(x.pressure)) && v.filters?.length) {
      if (!v.mpeTone) { v.mpeTone = lazy(); for (const f of v.filters) v.mpeTone.connect(f.detune); }
      const cents = (Number.isFinite(x.timbre) ? (x.timbre - 0.5) * 2400 : 0) + (Number.isFinite(x.pressure) ? x.pressure * 1200 : 0);
      v.mpeTone.offset.setTargetAtTime(cents, t, 0.02);
    }
  }

  onParams() {
    // live-update sounding voices (cheap params only)
    const p = this.params, t = this.ctx.currentTime;
    for (const v of this.voices || []) {
      if (v.done) continue;
      for (let i = 1; i <= 3; i++) {
        const g = v.oscGains?.[i];
        if (g) g.gain.setTargetAtTime(clamp(num(p[`osc${i}Level`], 0), 0, 1), t, 0.02);
      }
      if (v.subGain) v.subGain.gain.setTargetAtTime(clamp(num(p.subLevel, 0), 0, 1), t, 0.02);
      if (v.noiseGain) v.noiseGain.gain.setTargetAtTime(clamp(num(p.noiseLevel, 0), 0, 1) * 0.6, t, 0.02);
      if (v.filters?.length) {
        const f = this._cutoff(v.pitch, v.vel, v.cutoffOverride) * (v.cutVar || 1);
        v.filters.forEach((fl, idx) => {
          fl.frequency.setTargetAtTime(clamp(f, 20, this.ctx.sampleRate / 2 - 100), t, 0.02);
          if (idx === v.filters.length - 1) fl.Q.setTargetAtTime(filterQ(p.filterType, p.resonance), t, 0.02);
        });
      }
    }
    this._warm();
  }

  /** Pre-generate sample-model tables in the background (realtime contexts only). */
  _warm() {
    if (isOffline(this.ctx)) return;
    const p = this.params;
    const waves = [1, 2, 3].map((i) => (num(p[`osc${i}Level`], i === 1 ? 0.8 : 0) > 0.0005 ? p[`osc${i}Wave`] : null)).filter((w) => MODEL_WAVES.includes(w));
    if (!waves.length) return;
    const key = waves.join(',') + `:${p.modelTone}:${p.modelDecay}:${p.padWidth}`;
    if (key === this._warmKey) return;
    this._warmKey = key;
    const sr = this.ctx.sampleRate;
    for (const w of waves) {
      for (let m = 36; m <= 84; m += (w === 'pluck' ? 1 : w === 'piano' ? 3 : 4)) {
        warmLater(() => this._table(w, m, 0.8, sr));
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
    // a voice with a scheduled stop can't be held indefinitely (stop() can't be undone);
    // sample-model voices (one-shot tables) always retrigger
    const alive = v && !v.done && !v.oneShot && v.end > Math.max(t, this.ctx.currentTime) + 0.03 && (tOff != null || v.end === Infinity);
    const glide = num(p.glide, 0, 0, 5);
    if (!alive) {
      if (v && !v.done && tOff == null) this._releaseVoice(v, t);
      else if (v && !v.done && v.oneShot) this._kill(v, t, 0.02);
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
      const f = this._cutoff(pitch, vel, extra.cutoff) * (v.cutVar || 1);
      for (const fl of v.filters) fl.frequency.setTargetAtTime(clamp(f, 20, this.ctx.sampleRate / 2 - 100), t, 0.01);
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

  /** Sample-model table for a wave at an effective MIDI pitch: { buffer, f0 }. */
  _table(wave, midi, vel, sr) {
    const p = this.params;
    const tone = num(p.modelTone, 0, -1, 1), decay = num(p.modelDecay, 1, 0.25, 4);
    const layer = vel < 0.45 ? 0 : vel < 0.78 ? 1 : 2;
    if (PAD_WAVES.has(wave)) return padTable(sr, wave, padZone(midi, wave === 'choir' ? 3 : 4), num(p.padWidth, 1, 0.25, 4), tone, this.ctx);
    if (wave === 'piano') return pianoTable(sr, Math.round(midi / PIANO_ZONE) * PIANO_ZONE, layer, tone, decay, this.ctx);
    return pluckTable(sr, Math.round(midi), layer, tone, decay, this.ctx);
  }

  _createVoice(t, pitch, vel, tOff, extra) {
    const ctx = this.ctx, p = this.params;
    const rnd = this.rand;
    const v = new Voice(ctx);
    v.pitch = pitch; v.vel = vel; v.start = t; v.envs = [];
    v.cutoffOverride = extra.cutoff;
    const transpose = num(p.transpose, 0, -48, 48);
    const freq = midiToFreq(pitch + transpose);
    const glide = num(p.glide, 0, 0, 5);
    // OB-Xd style per-voice "slop": static detune, filter offset, envelope & level variance
    const an = num(p.analog, 0, 0, 1);
    const sl = () => (rnd() - 0.5) * 2;
    const voiceDet = sl() * an * 2.5;
    v.cutVar = Math.pow(2, sl() * an * 0.15);
    const envVar = 1 + sl() * an * 0.08;
    const lvlVar = Math.pow(10, (sl() * an * 0.6) / 20);

    // shared frequency source (Hz) -> every oscillator's frequency input (glide in one place)
    const fsrc = v.src(ctx.createConstantSource());
    v.fsrc = fsrc;
    v.curFreq = freq;
    if (extra.glideFrom != null) {
      const from = midiToFreq(num(extra.glideFrom, pitch, 0, 127) + transpose);
      fsrc.offset.setValueAtTime(from, t);
      fsrc.offset.exponentialRampToValueAtTime(freq, t + (glide > 0 ? glide : num(extra.glideTime, 0.06, 0.005, 2)));
    } else {
      fsrc.offset.setValueAtTime(freq, t);
    }

    const mix = v.node(ctx.createGain());
    mix.gain.value = VOICE_SCALE * lvlVar;
    const detuneTargets = [];
    v.oscGains = [];

    // LFO routing is needed up front (PWM changes how pulse oscillators are built)
    const lfos = [];
    for (let k = 1; k <= 2; k++) {
      const target = p[`lfo${k}Target`] || 'none';
      const depth = num(p[`lfo${k}Depth`], 0, 0, 1);
      if (target === 'none' || depth <= 0.0001) continue;
      lfos.push({ k, target, depth });
    }
    const pwmOn = lfos.some((l) => l.target === 'pwm');
    const pwmTargets = []; // [delayParam, periodSec]

    const unison = Math.round(num(p.unison, 1, 1, 7));
    const uDet = num(p.unisonDetune, 15, 0, 100);
    const spread = num(p.unisonSpread, 0.5, 0, 1);
    const superDet = superDetuneCurve(num(p.superDetune, 0.4, 0, 1));
    const [sCentre, sSide] = superMixCurve(num(p.superMix, 0.75, 0, 1));
    const nyq = ctx.sampleRate / 2;
    v.oneShot = false;

    for (let i = 1; i <= 3; i++) {
      const level = clamp(num(p[`osc${i}Level`], i === 1 ? 0.8 : 0), 0, 1);
      if (level <= 0.0005) continue;
      const wave = p[`osc${i}Wave`] || 'saw';
      const oscVar = i > 1 ? sl() * an * 1.5 : 0;
      const cents = num(p[`osc${i}Octave`], 0, -4, 4) * 1200 + num(p[`osc${i}Semi`], 0, -24, 24) * 100 + num(p[`osc${i}Fine`], 0, -100, 100) + voiceDet + oscVar;
      const g = v.node(ctx.createGain());
      g.connect(mix);
      g.gain.value = level;
      v.oscGains[i] = g;
      const isPad = PAD_WAVES.has(wave);
      const isModel = MODEL_WAVES.includes(wave);
      // build list of (detuneCents, pan, gain)
      const parts = [];
      const uni = wave === 'supersaw' ? Math.min(unison, 2) : isPad ? 1 : unison;
      for (let u = 0; u < uni; u++) {
        const uo = uni > 1 ? (u / (uni - 1) - 0.5) * uDet : 0;
        // Surge-style alternating pan law: neighbours go to opposite sides
        const upan = uni > 1 ? (u % 2 ? -1 : 1) * Math.abs(u / (uni - 1) - 0.5) * 2 * spread : 0;
        if (wave === 'supersaw') {
          SUPERSAW.forEach((r, k) => {
            const dc = 1200 * Math.log2(1 + r * superDet);
            const pan = clamp(((k / 6) - 0.5) * 2 * spread * (k % 2 ? -1 : 1) + upan * 0.5, -1, 1);
            parts.push([uo + dc, pan, k === 3 ? sCentre : sSide]);
          });
        } else parts.push([uo, upan, 1]);
      }
      const partGain = wave === 'supersaw'
        ? 1.45 / Math.sqrt(uni * (sCentre * sCentre + 6 * sSide * sSide))
        : 1 / Math.sqrt(parts.length);
      const sum = v.node(ctx.createGain());
      sum.gain.value = partGain;
      if (wave === 'supersaw') {
        // pitch-tracked 12 dB high-pass at the fundamental (thins the low end like the JP-8000)
        const hp = v.node(ctx.createBiquadFilter());
        hp.type = 'highpass'; hp.Q.value = 0.5; hp.frequency.value = 0;
        const hg = v.node(ctx.createGain()); hg.gain.value = Math.pow(2, cents / 1200);
        fsrc.connect(hg); hg.connect(hp.frequency);
        sum.connect(hp); hp.connect(g);
      } else sum.connect(g);
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
      // free-running phase for stacked / secondary oscillators
      const freePhase = parts.length > 1 || (an > 0.001 && i > 1);
      if (isModel) {
        const effMidi = pitch + transpose + cents / 100;
        const { buffer, f0 } = this._table(wave, effMidi, vel, ctx.sampleRate);
        if (!buffer) continue;
        const rate = v.node(ctx.createGain());
        rate.gain.value = 1 / f0;
        fsrc.connect(rate);
        const mk = (dc, dest, offset) => {
          const s = v.src(ctx.createBufferSource());
          s.buffer = buffer;
          s.playbackRate.value = 0;
          rate.connect(s.playbackRate);
          s.detune.value = cents + dc;
          detuneTargets.push([s.detune, cents + dc]);
          if (isPad) { s.loop = true; s.loopStart = 0; s.loopEnd = buffer.duration; s._offset = offset; }
          s.connect(dest);
          return s;
        };
        if (isPad) {
          // two decorrelated read positions of the same random-phase table = wide stereo
          const o1 = rnd() * buffer.duration;
          if (spread > 0.02) {
            for (const [side, off] of [[-1, o1], [1, (o1 + buffer.duration / 2) % buffer.duration]]) {
              const pn = v.node(ctx.createStereoPanner());
              pn.pan.value = side * spread;
              pn.connect(sum);
              mk(0, pn, off);
            }
            sum.gain.value = partGain * Math.SQRT1_2;
          } else mk(0, sum, o1);
        } else {
          v.oneShot = true;
          for (const [dc, pan] of parts) mk(dc, bucketFor(pan));
        }
        continue;
      }
      for (const [dc, pan, pg] of parts) {
        const osc = v.src(ctx.createOscillator());
        const ph = freePhase ? Math.floor(rnd() * 8) : -1;
        const pwmPulse = pwmOn && (wave === 'pulse' || wave === 'square');
        setOscWave(ctx, osc, pwmPulse ? 'saw' : wave, p[`osc${i}Width`], pwmPulse ? Math.max(0, ph) : ph);
        osc.frequency.value = 0;
        fsrc.connect(osc.frequency);
        osc.detune.value = cents + dc;
        detuneTargets.push([osc.detune, cents + dc]);
        let src = osc;
        if (pg !== 1) { const pgn = v.node(ctx.createGain()); pgn.gain.value = pg; osc.connect(pgn); src = pgn; }
        if (pwmPulse) {
          // band-limited PWM: pulse = saw(t) - saw(t - w*T); the LFO sweeps the delay
          const T = 1 / clamp(freq * Math.pow(2, (cents + dc) / 1200), 1, nyq);
          const w = wave === 'square' ? 0.5 : clamp(num(p[`osc${i}Width`], 0.5), 0.05, 0.95);
          const dl = v.node(ctx.createDelay(0.1));
          dl.delayTime.value = w * T;
          const inv = v.node(ctx.createGain()); inv.gain.value = -1;
          const out = v.node(ctx.createGain()); out.gain.value = 0.7;
          src.connect(out); src.connect(dl); dl.connect(inv); inv.connect(out);
          pwmTargets.push([dl.delayTime, T]);
          src = out;
        }
        src.connect(bucketFor(pan));
      }
    }
    // sub oscillator
    const subLevel = clamp(num(p.subLevel, 0), 0, 1);
    if (subLevel > 0.0005) {
      const sub = v.src(ctx.createOscillator());
      setOscWave(ctx, sub, p.subWave || 'sine');
      sub.frequency.value = 0;
      fsrc.connect(sub.frequency);
      const sc = num(p.subOctave, -1, -2, -1) * 1200 + voiceDet;
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
      ns._offset = rnd() * ns.buffer.duration;
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

    // pitch: bend + pitch envelope + slow analog drift
    for (const [d] of detuneTargets) v.ext(this.bend, d);
    v.detuneTargets = detuneTargets; // per-note (MPE) bend: noteExpression()
    const pe = num(p.pitchEnvAmt, 0, -48, 48);
    if (Math.abs(pe) > 0.01) {
      const ped = Math.max(0.002, num(p.pitchEnvDecay, 0.05, 0, 5));
      for (const [d, base] of detuneTargets) {
        d.setValueAtTime(base + pe * 100, t);
        d.setTargetAtTime(base, t, ped / 4);
      }
    }
    // performance expression (src/audio/mixer.js noteExtra): a bend reached at `at`, delayed vibrato
    if (extra.bend && Number.isFinite(extra.bend.to)) {
      const bt = t + Math.max(0, num(extra.bend.at, 0));
      for (const [d, base] of detuneTargets) d.setTargetAtTime(base + extra.bend.to * 100, bt, num(extra.bend.time, 0.12, 0.01, 2) / 3);
    }
    if (extra.vib && num(extra.vib.depth, 0) > 0) {
      const vo = v.src(ctx.createOscillator());
      vo.frequency.value = num(extra.vib.rate, 5.2, 0.5, 12);
      const vg = v.node(ctx.createGain());
      const d0 = t + num(extra.vib.delay, 0.25, 0, 4);
      vg.gain.setValueAtTime(0, t);
      vg.gain.setValueAtTime(0, d0);
      vg.gain.linearRampToValueAtTime(num(extra.vib.depth, 0, 0, 1) * 100, d0 + 0.35);
      vo.connect(vg);
      for (const [d] of detuneTargets) vg.connect(d);
    }
    if (an > 0.01) {
      // Surge-style drift: a very slow random-rate wobble per voice (±3 cents at analog = 1)
      const dr = v.src(ctx.createOscillator());
      dr.type = 'triangle';
      dr.frequency.value = 0.07 + rnd() * 0.35;
      const dg = v.node(ctx.createGain());
      dg.gain.value = an * 3 * (rnd() < 0.5 ? -1 : 1);
      dr.connect(dg);
      for (const [d] of detuneTargets) dg.connect(d);
    }

    // pre-filter drive (per voice, gentle) -> filter
    let node = mix;
    const fdrive = num(p.filterDrive, 0, 0, 1);
    if (fdrive > 0.005) {
      const pre = v.node(ctx.createGain());
      pre.gain.value = 1 + fdrive * 2.5;
      const sh = v.node(ctx.createWaveShaper());
      sh.curve = getSatCurve(fdrive);
      node.connect(pre); pre.connect(sh);
      const post = v.node(ctx.createGain());
      post.gain.value = 1 / (1 + fdrive * 1.2);
      sh.connect(post);
      node = post;
    }
    const ftype = p.filterType || 'lp24';
    v.filters = [];
    if (ftype !== 'off') {
      const map = { lp12: ['lowpass'], lp24: ['lowpass', 'lowpass'], hp12: ['highpass'], hp24: ['highpass', 'highpass'], bp: ['bandpass'], notch: ['notch'] };
      const types = map[ftype] || map.lp24;
      const fc = clamp(this._cutoff(pitch, vel, extra.cutoff) * v.cutVar, 20, nyq - 100);
      const fmod = v.src(ctx.createConstantSource());
      fmod.offset.value = 0;
      v.fmod = fmod;
      types.forEach((ty, idx) => {
        const f = v.node(ctx.createBiquadFilter());
        f.type = ty;
        f.frequency.value = fc;
        const last = idx === types.length - 1;
        // 4-pole: a soft first stage (Q -1 dB) under the resonant one -> ladder-like rounded knee
        f.Q.value = last ? filterQ(ftype, extra.resonance != null ? num(extra.resonance, 0, 0, 1) : p.resonance) : (ty === 'lowpass' || ty === 'highpass' ? -1 : 0.7);
        fmod.connect(f.detune);
        node.connect(f);
        node = f;
        v.filters.push(f);
      });
      const amt = num(p.fEnvAmount, 0, -8, 8);
      if (Math.abs(amt) > 0.001) {
        const vf = num(p.velToFilter, 0, 0, 1);
        const peak = amt * 1200 * (1 - vf + vf * vel);
        const fe = { a: num(p.fAttack, 0.005) * envVar, d: num(p.fDecay, 0.3) * envVar, s: p.fSustain, r: num(p.fRelease, 0.3) * envVar };
        const st = envNote(fmod.offset, t, tOff, fe, peak, 0);
        st.peak0 = peak;
        st.sus0 = peak * clamp(num(p.fSustain, 0.3), 0, 1);
        v.envs.push([fmod.offset, st]);
      }
    }

    // amp
    const amp = v.node(ctx.createGain());
    amp.gain.value = 0;
    node.connect(amp);
    v.amp = amp;
    const peak = velCurve(vel, num(p.velToAmp, 0.6, 0, 1));
    const ampEnv = { a: num(p.attack, 0.005) * envVar, d: num(p.decay, 0.3) * envVar, s: p.sustain, r: num(p.release, 0.2) * envVar };
    v.ampSt = envNote(amp.gain, t, tOff, ampEnv, peak, 0);
    v.ampSt.peak0 = peak; v.ampSt.sus0 = peak * clamp(num(p.sustain, 0.8), 0, 1);
    v.envs.unshift([amp.gain, v.ampSt]);
    let outNode = amp;

    // LFOs
    let trem = null, panner = null;
    const live = lfos.filter(({ target }) => !(target === 'filter' && !v.fmod) && !(target === 'oscmix' && !(v.oscGains[1] && v.oscGains[2])) && !(target === 'pwm' && !pwmTargets.length));
    if (live.some((l) => l.target === 'amp')) {
      trem = v.node(ctx.createGain());
      trem.gain.value = 1;
      outNode.connect(trem); outNode = trem;
    }
    const pan = extra.pan != null ? num(extra.pan, 0, -1, 1) : null;
    if (pan != null || live.some((l) => l.target === 'pan')) {
      panner = v.node(ctx.createStereoPanner());
      panner.pan.value = pan ?? 0;
      outNode.connect(panner); outNode = panner;
    }
    for (const { k, target, depth } of live) {
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
      } else if (target === 'pwm') {
        // depth 1 sweeps the duty cycle by ±0.42 around the set width
        for (const [dp, T] of pwmTargets) {
          const pg = v.node(ctx.createGain()); pg.gain.value = 0.42 * T; lg.connect(pg); pg.connect(dp);
        }
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
