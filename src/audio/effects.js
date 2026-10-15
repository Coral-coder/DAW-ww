// Effect implementations — native Web Audio nodes only (no AudioWorklet).
//
//   createEffect(ctx, effectDef, { getBpm, getBeatAt }) ->
//     { type, input, output, keyInput|null, update(def), setBypass(bool), setTempo(bpm), sync(time?), dispose(), getReduction?() }
//
// Every effect is wrapped in a "shell":  input ─┬─ thru (bypass path) ───────────────┬─ output
//                                               └─ fxIn ─┬─ dry ─────────┬─ fxOut ──┘
//                                                        └─ [process] ─ wet ┘
// Bypass crossfades thru/fxOut (click-free). `mix` (when the effect defines it) drives dry/wet.
// LFOs are looping one-cycle AudioBufferSources so they can be phase-aligned to the beat grid
// (`sync()`), retimed on tempo change (`setTempo()`), and behave identically offline.
import { EFFECT_DEFS, resolveEffectParams, divisionToBeats } from './effect-defs.js';
import { clamp, dbToGain, createRng } from '../core/util.js';
import { pluginEffectBuilder, PLUGIN_EFFECT_TYPES } from './plugin-fx.js';
import { effectLatencyFrames, lookaheadTime, COMPRESSOR_LOOKAHEAD } from './latency.js';
import { FX_BUILDER_FAMILIES } from './fx/builders/index.js';

const TC = 0.015; // smoothing time-constant for parameter changes

const isOffline = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

function setP(param, value, ctx, immediate) {
  if (!isFinite(value)) return;
  if (immediate) {
    param.cancelScheduledValues(0);
    param.value = value;
  } else {
    param.setTargetAtTime(value, ctx.currentTime, TC);
  }
}

/** Gain node forced to stereo (up-mixes mono so ChannelSplitter always sees 2 channels). */
function stereoGain(ctx, g = 1) {
  const n = ctx.createGain();
  n.gain.value = g;
  n.channelCount = 2;
  n.channelCountMode = 'explicit';
  n.channelInterpretation = 'speakers';
  return n;
}

// ---------------------------------------------------------------------------------------- LFO
const LFO_N = 2048;
const bufCache = new WeakMap(); // ctx -> Map(key -> AudioBuffer)

function cachedBuffer(ctx, key, fill) {
  let m = bufCache.get(ctx);
  if (!m) { m = new Map(); bufCache.set(ctx, m); }
  let b = m.get(key);
  if (!b) {
    b = ctx.createBuffer(1, LFO_N, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < LFO_N; i++) d[i] = fill(i / LFO_N);
    if (m.size > 64) m.delete(m.keys().next().value);
    m.set(key, b);
  }
  return b;
}

const SHAPES = {
  sine: (ph) => Math.sin(2 * Math.PI * ph),
  triangle: (ph) => (ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4),
  square: (ph) => (ph < 0.5 ? 1 : -1),
  saw: (ph) => 2 * ph - 1,
  ramp: (ph) => 1 - 2 * ph,
};
function shapeBuffer(ctx, shape) {
  const fn = SHAPES[shape] || SHAPES.sine;
  return cachedBuffer(ctx, 'shape:' + (SHAPES[shape] ? shape : 'sine'), fn);
}

/** Phase-controllable LFO. `out` emits the waveform (bipolar -1..1 for standard shapes). */
class Lfo {
  constructor(ctx, buffer) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.buffer = buffer;
    this.hz = 1;
    this.sources = [];
    this.t0 = ctx.currentTime;
    this.ph0 = 0;
    this.start(ctx.currentTime, 0);
  }
  _rate(hz) { return (hz * this.buffer.length) / this.buffer.sampleRate; }
  phaseAt(t) { return this.ph0 + (t - this.t0) * this.hz; }
  start(when, phase) {
    const { ctx } = this;
    when = Math.max(when, ctx.currentTime);
    for (const s of this.sources) { try { s.stop(when); } catch { /* not started */ } }
    const s = ctx.createBufferSource();
    s.buffer = this.buffer;
    s.loop = true;
    s.playbackRate.value = this._rate(this.hz);
    s.connect(this.out);
    const ph = ((phase % 1) + 1) % 1;
    s.start(when, ph * this.buffer.duration);
    s.onended = () => {
      try { s.disconnect(); } catch { /* ignore */ }
      this.sources = this.sources.filter((x) => x !== s);
    };
    this.sources.push(s);
    this.t0 = when;
    this.ph0 = ph;
  }
  setHz(hz, immediate) {
    hz = Math.max(0.0001, hz);
    if (Math.abs(hz - this.hz) < 1e-9) return;
    const now = this.ctx.currentTime;
    this.ph0 = this.phaseAt(now); // keep phase bookkeeping continuous
    this.t0 = now;
    this.hz = hz;
    for (const s of this.sources) setP(s.playbackRate, this._rate(hz), this.ctx, true);
  }
  setBuffer(buffer) {
    if (buffer === this.buffer) return;
    const now = this.ctx.currentTime;
    const ph = this.phaseAt(now);
    this.buffer = buffer;
    this.start(now, ph);
  }
  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch { /* */ } try { s.disconnect(); } catch { /* */ } }
    this.sources = [];
    try { this.out.disconnect(); } catch { /* */ }
  }
}

/**
 * LFO rate helper shared by modulation effects: free Hz or tempo-synced division.
 * Returns { hz, cycleBeats|null }.
 */
function lfoRate(p, bpm) {
  if (p.sync) {
    const beats = divisionToBeats(p.division);
    return { hz: bpm / 60 / beats, cycleBeats: beats };
  }
  return { hz: p.rate, cycleBeats: null };
}

// ----------------------------------------------------------------------------- curves / IRs
function makeCurve(fn, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

/** Normalised waveshaper transfer function with drive k (linear gain) baked in. */
function driveFn(type, k) {
  const norm = (f) => {
    const m = Math.max(Math.abs(f(1)), Math.abs(f(-1)), 1e-6);
    return (x) => f(x) / m;
  };
  switch (type) {
    case 'hard': return (x) => clamp(x * k, -1, 1);
    case 'tube': // asymmetric: softer positive half, harder negative half
      return norm((x) => {
        const y = x * k;
        return y >= 0 ? Math.tanh(y) : Math.tanh(y * 1.4) / 1.15;
      });
    case 'fuzz':
      return norm((x) => {
        const y = x * k * 1.5 + 0.08;
        return Math.sign(y) * (1 - Math.exp(-Math.abs(y) * 2.5)) - 0.08 * 0.6;
      });
    case 'foldback':
      return (x) => {
        // triangle-wave folding of the driven signal back into [-1, 1]
        let t = (x * k + 1) / 4;
        t -= Math.floor(t);
        return 1 - 4 * Math.abs(t - 0.5);
      };
    case 'warm':
      return norm((x) => {
        const y = x * k;
        return Math.tanh(y + 0.15 * y * y);
      });
    case 'soft':
    default:
      return norm((x) => Math.tanh(x * k));
  }
}

const irCache = new Map();
/** Algorithmic stereo impulse response (deterministic). */
function makeImpulse(ctx, decay, size, damping) {
  const sr = ctx.sampleRate;
  const key = `${sr}|${decay.toFixed(3)}|${size.toFixed(3)}|${damping.toFixed(3)}`;
  const hit = irCache.get(key);
  if (hit) return hit;
  const len = Math.max(64, Math.floor(sr * (decay + 0.05)));
  const buf = ctx.createBuffer(2, len, sr);
  const fadeIn = Math.floor(sr * (0.002 + size * 0.03));
  const nyq = sr / 2;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = createRng(1234 + ch * 777);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp((-6.907755 * t) / decay); // -60 dB at `decay`
      // damping: low-pass cutoff falls over the tail
      const fc = Math.max(300, nyq * (1 - damping * Math.min(1, t / (decay * 0.5 + 0.05)) * 0.95) * 0.9);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      lp += a * (rng() * 2 - 1 - lp);
      let v = lp * env;
      if (i < fadeIn) v *= i / fadeIn;
      d[i] = v;
    }
    // sparse early reflections, spread by size
    const taps = 6 + Math.floor(size * 10);
    for (let k = 0; k < taps; k++) {
      const pos = Math.floor(sr * (0.004 + rng() * (0.01 + size * 0.07)));
      if (pos < len) d[pos] += (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.5) * (1 - k / taps) * 0.6;
    }
  }
  if (irCache.size > 12) irCache.delete(irCache.keys().next().value);
  irCache.set(key, buf);
  return buf;
}

/**
 * Reverb characters for the realistic impulse generator (makeSpaceImpulse). er: early-reflection taps, erSpan: s over
 * which they arrive (scaled by size), erGain, tail: s before the diffuse tail starts, build: tail density build-up
 * (s), low / high: T60 multipliers of the low (< 400 Hz) and high (> 3.5 kHz) bands (damping pulls highs further
 * down), width: stereo width of the tail, decayMul: decay scaling.
 */
export const REVERB_CHARACTERS = {
  room: { er: 16, erSpan: 0.03, erGain: 0.75, tail: 0.006, build: 0.01, low: 1.05, high: 0.5, width: 0.85, decayMul: 1 },
  chamber: { er: 12, erSpan: 0.045, erGain: 0.55, tail: 0.01, build: 0.025, low: 1.15, high: 0.6, width: 0.95, decayMul: 1 },
  hall: { er: 9, erSpan: 0.075, erGain: 0.42, tail: 0.018, build: 0.055, low: 1.3, high: 0.5, width: 1, decayMul: 1 },
  plate: { er: 0, erSpan: 0, erGain: 0, tail: 0.0015, build: 0.004, low: 0.85, high: 0.85, width: 1, decayMul: 1 },
  ambience: { er: 20, erSpan: 0.028, erGain: 0.9, tail: 0.004, build: 0.006, low: 0.9, high: 0.45, width: 0.8, decayMul: 0.45 },
};

/** 'auto' character from size / decay (rooms are small and short, halls big and long). */
export function reverbCharacter(p) {
  const c = p.character || 'auto';
  if (c !== 'auto') return c;
  if (p.size < 0.33 || p.decay < 0.9) return 'room';
  if (p.decay >= 3.2 || p.size >= 0.75) return 'hall';
  return 'chamber';
}

/**
 * Realistic stereo impulse response (deterministic): early reflections (image-source-like taps, different per
 * channel), then a diffuse tail that builds up and decays per band — lows ring longer, highs die first
 * (frequency-dependent T60, `damping` steepens the highs) — with decorrelated channels for width.
 */
function makeSpaceImpulse(ctx, decay, size, damping, character) {
  const sr = ctx.sampleRate;
  const ch = REVERB_CHARACTERS[character] || REVERB_CHARACTERS.hall;
  const key = `space|${sr}|${character}|${decay.toFixed(3)}|${size.toFixed(3)}|${damping.toFixed(3)}`;
  const hit = irCache.get(key);
  if (hit) return hit;
  const T = Math.max(0.1, decay * ch.decayMul);
  const tLow = T * ch.low, tMid = T, tHigh = T * (ch.high + (1 - ch.high) * (1 - damping) * 0.6) * (1 - 0.35 * damping);
  const len = Math.max(256, Math.floor(sr * (Math.max(tLow, tMid) * 1.05 + ch.tail + 0.02)));
  const buf = ctx.createBuffer(2, len, sr);
  const a = (fc) => 1 - Math.exp((-2 * Math.PI * fc) / sr);
  const aLow = a(400), aHigh = a(3500);
  const k = -6.907755 / sr; // ln(1/1000) per sample: -60 dB at T seconds
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const t0 = Math.floor(ch.tail * (0.5 + size) * sr);
  const build = Math.max(1, ch.build * (0.5 + size) * sr);
  for (let c = 0; c < 2; c++) {
    const d = c ? R : L;
    const rng = createRng(9011 + c * 4049 + Math.round(size * 100));
    let lp = 0, lp2 = 0;
    const dl = 1 + (c ? 0.03 : -0.03); // slightly different decay per side (a living, non-static tail)
    const eL = Math.exp(k / (tLow * dl)), eM = Math.exp(k / (tMid * dl)), eH = Math.exp(k / (tHigh * dl));
    let gL = 1, gM = 1, gH = 1;
    for (let i = 0; i < len; i++) {
      if (i >= t0) {
        const w = rng() * 2 - 1;
        lp += aLow * (w - lp); // low band
        lp2 += aHigh * (w - lp2); // < 3.5 kHz
        const low = lp, high = w - lp2, mid = lp2 - lp;
        const env = 1 - Math.exp(-(i - t0) / build);
        d[i] = (low * gL * 1.4 + mid * gM + high * gH * 0.9) * env;
      }
      gL *= eL; gM *= eM; gH *= eH;
    }
    // early reflections: sparse taps growing denser, quieter and darker with distance
    for (let j = 0; j < ch.er; j++) {
      const x = (j + 0.5) / ch.er;
      const tt = 0.0025 + ch.erSpan * (0.55 + 0.9 * size) * Math.pow(x, 1.35) * (0.85 + rng() * 0.3);
      const pos = Math.floor(tt * sr);
      if (pos + 2 >= len) continue;
      const amp = ch.erGain * Math.pow(1 - x * 0.85, 1.2) * (rng() < 0.5 ? -1 : 1) * (0.7 + rng() * 0.3);
      const sm = 0.25 + 0.5 * x; // later taps are smeared (absorption)
      d[pos] += amp * (1 - sm); d[pos + 1] += amp * sm * 0.7; d[pos + 2] += amp * sm * 0.3;
    }
  }
  // tail width: mid / side
  if (ch.width !== 1) {
    for (let i = 0; i < len; i++) {
      const m = (L[i] + R[i]) * 0.5, sd = (L[i] - R[i]) * 0.5 * ch.width;
      L[i] = m + sd; R[i] = m - sd;
    }
  }
  if (irCache.size > 12) irCache.delete(irCache.keys().next().value);
  irCache.set(key, buf);
  return buf;
}

/** Post-EQ analyser for the EQ cards, created on first read (never in offline renders): {analyser, sampleRate}. */
const eqProbes = new WeakMap();
function eqProbe(ctx, out) {
  if (isOffline(ctx) || !ctx.createAnalyser) return null;
  let pr = eqProbes.get(out);
  if (!pr) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.8;
    out.connect(analyser);
    pr = { analyser, sampleRate: ctx.sampleRate };
    eqProbes.set(out, pr);
  }
  return pr;
}

// ------------------------------------------------------------------------------ shell
function createShell(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const thru = ctx.createGain();
  thru.gain.value = 0;
  const fxIn = ctx.createGain();
  const fxOut = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 0;
  const wet = ctx.createGain();
  input.connect(thru);
  thru.connect(output);
  input.connect(fxIn);
  fxIn.connect(dry);
  dry.connect(fxOut);
  wet.connect(fxOut);
  fxOut.connect(output);
  return { input, output, thru, fxIn, fxOut, dry, wet };
}

// ------------------------------------------------------------------------------ implementations
// Each builder(ctx, sh, env) wires sh.fxIn -> ... -> sh.wet (and optionally sh.dry for latency
// compensation) and returns { apply(p, immediate), setTempo?(bpm), sync?(time), dispose?(), getReduction?() }.

const BUILDERS = {
  eq3(ctx, sh) {
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
    const high = ctx.createBiquadFilter(); high.type = 'highshelf';
    const out = ctx.createGain();
    sh.fxIn.connect(low); low.connect(mid); mid.connect(high); high.connect(out); out.connect(sh.wet);
    return {
      get probe() { return eqProbe(ctx, out); }, // live spectrum for the EQ card (src/ui/fx-ui/eq.js)
      apply(p, im) {
        setP(low.frequency, p.lowFreq, ctx, im); setP(low.gain, p.low, ctx, im);
        setP(mid.frequency, p.midFreq, ctx, im); setP(mid.gain, p.mid, ctx, im); setP(mid.Q, p.midQ, ctx, im);
        setP(high.frequency, p.highFreq, ctx, im); setP(high.gain, p.high, ctx, im);
        setP(out.gain, dbToGain(p.output), ctx, im);
      },
    };
  },

  eq8(ctx, sh) {
    const bands = Array.from({ length: 8 }, () => ctx.createBiquadFilter());
    const out = ctx.createGain();
    out.connect(sh.wet);
    let wiring = '';
    const rewire = (on) => {
      const key = on.join(',');
      if (key === wiring) return;
      wiring = key;
      try { sh.fxIn.disconnect(); } catch { /* */ }
      sh.fxIn.connect(sh.dry);
      bands.forEach((b) => { try { b.disconnect(); } catch { /* */ } });
      let prev = sh.fxIn;
      bands.forEach((b, i) => { if (on[i]) { prev.connect(b); prev = b; } });
      prev.connect(out);
    };
    return {
      get probe() { return eqProbe(ctx, out); }, // live spectrum for the EQ card (src/ui/fx-ui/eq.js)
      apply(p, im) {
        const on = [];
        bands.forEach((b, i) => {
          const n = i + 1;
          on.push(!!p[`b${n}On`]);
          if (b.type !== p[`b${n}Type`]) b.type = p[`b${n}Type`];
          setP(b.frequency, p[`b${n}Freq`], ctx, im);
          setP(b.gain, p[`b${n}Gain`], ctx, im);
          setP(b.Q, p[`b${n}Q`], ctx, im);
        });
        rewire(on);
        setP(out.gain, dbToGain(p.output), ctx, im);
      },
    };
  },

  filter(ctx, sh, env) {
    const f1 = ctx.createBiquadFilter();
    const f2 = ctx.createBiquadFilter();
    const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
    const depth = ctx.createGain();
    depth.gain.value = 0;
    lfo.out.connect(depth);
    depth.connect(f1.detune);
    depth.connect(f2.detune);
    sh.fxIn.connect(f1);
    let slope = null;
    let cur = null;
    const wire = (s) => {
      if (s === slope) return;
      slope = s;
      try { f1.disconnect(); } catch { /* */ }
      try { f2.disconnect(); } catch { /* */ }
      if (s === '24') { f1.connect(f2); f2.connect(sh.wet); } else f1.connect(sh.wet);
    };
    const api = {
      apply(p, im) {
        cur = p;
        for (const f of [f1, f2]) {
          if (f.type !== p.type) f.type = p.type;
          setP(f.frequency, p.cutoff, ctx, im);
          setP(f.Q, p.type === 'lowpass' || p.type === 'highpass' ? p.resonance : Math.max(0.1, p.resonance), ctx, im);
        }
        wire(String(p.slope));
        setP(depth.gain, p.depth * 1200, ctx, im);
        lfo.setBuffer(shapeBuffer(ctx, p.shape));
        api.setTempo(env.getBpm());
      },
      setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
      sync(time) { syncLfo(lfo, cur, env, time); },
      dispose() { lfo.dispose(); },
    };
    return api;
  },

  compressor(ctx, sh) {
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const dryDelay = ctx.createDelay(0.05);
    const look = lookaheadTime(COMPRESSOR_LOOKAHEAD, ctx.sampleRate);
    dryDelay.delayTime.value = look; // DynamicsCompressor look-ahead -> keep parallel mix phase-aligned
    try { sh.fxIn.disconnect(sh.dry); } catch { /* */ }
    sh.fxIn.connect(dryDelay); dryDelay.connect(sh.dry);
    sh.fxIn.connect(comp); comp.connect(makeup); makeup.connect(sh.wet);
    // External sidechain (params.sourceTrackId): the native compressor can't take a key, so a keyed gain computer
    // runs instead — key → mono → |x| → peak follower (attack / release) → static curve (threshold, ratio, knee →
    // gain reduction) → VCA on the signal, delayed by the same look-ahead (constant latency for PDC).
    const keyIn = ctx.createGain();
    keyIn.channelCount = 1; keyIn.channelCountMode = 'explicit';
    let keyed = null;
    let keyedOn = false;
    let curveKey = '';
    let lastRed = 0;
    const buildKeyed = () => {
      const rect = ctx.createWaveShaper(); rect.curve = makeCurve((x) => Math.abs(x), 4097);
      const fast = ctx.createBiquadFilter(); fast.type = 'lowpass'; fast.Q.value = -3;
      const slowIn = ctx.createGain(); slowIn.gain.value = 1.6;
      const slow = ctx.createBiquadFilter(); slow.type = 'lowpass'; slow.Q.value = -3;
      const maxSum = ctx.createGain(); maxSum.gain.value = 0.5;
      const diff = ctx.createGain();
      const neg = ctx.createGain(); neg.gain.value = -1;
      const diffAbs = ctx.createWaveShaper(); diffAbs.curve = makeCurve((x) => Math.abs(x), 4097);
      const gr = ctx.createWaveShaper(); // envelope (0..1 linear) -> -(1 - gain)
      const vca = ctx.createGain(); vca.gain.value = 1;
      const sigDelay = ctx.createDelay(0.05); sigDelay.delayTime.value = look;
      const an = ctx.createAnalyser(); an.fftSize = 256;
      keyIn.connect(rect); rect.connect(fast); rect.connect(slowIn); slowIn.connect(slow);
      fast.connect(maxSum); slow.connect(maxSum);
      fast.connect(diff); slow.connect(neg); neg.connect(diff); diff.connect(diffAbs); diffAbs.connect(maxSum);
      maxSum.connect(gr); gr.connect(vca.gain); gr.connect(an);
      sigDelay.connect(vca);
      return { rect, fast, slowIn, slow, maxSum, diff, neg, diffAbs, gr, vca, sigDelay, an, buf: new Float32Array(256) };
    };
    const route = (on) => {
      if (on === keyedOn) return;
      keyedOn = on;
      if (on) {
        keyed ||= buildKeyed();
        try { sh.fxIn.disconnect(comp); } catch { /* */ }
        sh.fxIn.connect(keyed.sigDelay); keyed.vca.connect(makeup);
      } else {
        try { sh.fxIn.disconnect(keyed.sigDelay); } catch { /* */ }
        try { keyed.vca.disconnect(); } catch { /* */ }
        sh.fxIn.connect(comp);
      }
    };
    return {
      keyInput: keyIn,
      apply(p, im) {
        setP(comp.threshold, p.threshold, ctx, im);
        setP(comp.ratio, p.ratio, ctx, im);
        setP(comp.attack, p.attack, ctx, im);
        setP(comp.release, p.release, ctx, im);
        setP(comp.knee, p.knee, ctx, im);
        setP(makeup.gain, dbToGain(p.makeup), ctx, im);
        route(!!p.sourceTrackId);
        if (keyed) {
          const k = `${p.threshold}|${p.ratio}|${p.knee}`;
          if (k !== curveKey) {
            curveKey = k;
            const slope = 1 - 1 / Math.max(1, p.ratio);
            const knee = Math.max(0.01, p.knee);
            keyed.gr.curve = makeCurve((x) => {
              const lvl = Math.abs(x);
              if (lvl <= 1e-6) return 0;
              const over = 20 * Math.log10(lvl) + 3 - p.threshold; // follower ≈ peak − 3 dB
              let red;
              if (over <= -knee / 2) red = 0;
              else if (over < knee / 2) red = (slope * (over + knee / 2) ** 2) / (2 * knee);
              else red = slope * over;
              return -(1 - Math.pow(10, -red / 20));
            }, 8193);
          }
          setP(keyed.fast.frequency, clamp(1 / (2 * Math.PI * Math.max(0.0005, p.attack)), 2, 800), ctx, im);
          setP(keyed.slow.frequency, clamp(1 / (2 * Math.PI * Math.max(0.01, p.release) * 0.5), 0.3, 100), ctx, im);
        }
      },
      getReduction: () => {
        if (!keyedOn || !keyed) return comp.reduction;
        keyed.an.getFloatTimeDomainData(keyed.buf);
        let m = 0;
        for (let i = 0; i < keyed.buf.length; i++) m = Math.min(m, keyed.buf[i]);
        lastRed = m <= -0.999 ? -60 : 20 * Math.log10(1 + m);
        return lastRed;
      },
      dispose() {
        try { keyIn.disconnect(); } catch { /* */ }
        if (keyed) for (const n of Object.values(keyed)) { try { n.disconnect?.(); } catch { /* */ } }
        for (const n of [comp, makeup, dryDelay]) { try { n.disconnect(); } catch { /* */ } }
      },
    };
  },

  limiter(ctx, sh) {
    const pre = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.ratio.value = 20; comp.knee.value = 0; comp.attack.value = 0.001;
    const inv = ctx.createGain();
    const clip = ctx.createWaveShaper();
    const post = ctx.createGain();
    // gentle knee from 0.9 to 1.0, hard ceiling at 1.0 (scaled by the ceiling)
    clip.curve = makeCurve((x) => {
      const a = Math.abs(x);
      if (a <= 0.9) return x;
      return Math.sign(x) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
    }, 8192);
    sh.fxIn.connect(pre); pre.connect(comp); comp.connect(inv);
    let clipOn = null;
    const wire = (on) => {
      if (on === clipOn) return;
      clipOn = on;
      try { inv.disconnect(); } catch { /* */ }
      try { clip.disconnect(); } catch { /* */ }
      if (on) { inv.connect(clip); clip.connect(post); } else inv.connect(post);
    };
    post.connect(sh.wet);
    return {
      apply(p, im) {
        setP(pre.gain, dbToGain(p.gain), ctx, im);
        setP(comp.threshold, p.threshold, ctx, im);
        setP(comp.release, p.release, ctx, im);
        const c = dbToGain(p.ceiling);
        // (the native compressor applies its own auto make-up gain; the clipper guarantees the ceiling)
        setP(post.gain, c, ctx, im);
        wire(!!p.clip);
      },
      getReduction: () => comp.reduction,
    };
  },

  gate(ctx, sh) {
    // Envelope follower: |x| in dB (normalised 0..1 over -100..0 dB) -> low-pass -> threshold curve
    // -> smoothing -> VCA gain. Signal path delayed slightly as look-ahead.
    const RANGE = 100;
    const det = ctx.createWaveShaper();
    det.curve = makeCurve((x) => clamp((20 * Math.log10(Math.abs(x) + 1e-9) + RANGE) / RANGE, 0, 1), 32768);
    const detMono = ctx.createGain(); detMono.channelCount = 1; detMono.channelCountMode = 'explicit';
    const env = ctx.createBiquadFilter(); env.type = 'lowpass'; env.Q.value = 0.5;
    const thresh = ctx.createWaveShaper();
    const smooth = ctx.createBiquadFilter(); smooth.type = 'lowpass'; smooth.Q.value = 0.5;
    const vca = ctx.createGain(); vca.gain.value = 0;
    const look = ctx.createDelay(0.05); look.delayTime.value = lookaheadTime(0.004, ctx.sampleRate);
    sh.fxIn.connect(detMono); detMono.connect(det); det.connect(env); env.connect(thresh); thresh.connect(smooth);
    smooth.connect(vca.gain);
    sh.fxIn.connect(look); look.connect(vca); vca.connect(sh.wet);
    // external sidechain (params.sourceTrackId): the detector listens to the key instead of the signal
    const keyIn = ctx.createGain();
    let keyedOn = false;
    let key = '';
    return {
      keyInput: keyIn,
      apply(p, im) {
        if (!!p.sourceTrackId !== keyedOn) {
          keyedOn = !!p.sourceTrackId;
          try { (keyedOn ? sh.fxIn : keyIn).disconnect(detMono); } catch { /* */ }
          (keyedOn ? keyIn : sh.fxIn).connect(detMono);
        }
        const k = `${p.threshold}|${p.range}|${p.knee}`;
        if (k !== key) {
          key = k;
          const floor = dbToGain(p.range);
          const knee = Math.max(0.5, p.knee);
          // averaged log|x| of a sine sits ~6 dB below its peak level -> compensate
          thresh.curve = makeCurve((x) => {
            const db = clamp(x, 0, 1) * RANGE - RANGE + 6;
            const t = clamp((db - (p.threshold - knee)) / (2 * knee), 0, 1);
            const s = t * t * (3 - 2 * t);
            return floor + (1 - floor) * s;
          }, 4096);
        }
        setP(env.frequency, clamp(1 / (2 * Math.PI * p.release * 0.5), 2, 200), ctx, im);
        setP(smooth.frequency, clamp(1 / (2 * Math.PI * p.attack), 5, 2000), ctx, im);
      },
    };
  },

  ducker(ctx, sh) {
    // Keyed ducking. KEY (another track, fed by the mixer into `keyInput`, or a patch cable
    // into port 1) → mono → |x| → detector low-pass → threshold curve (0..1 duck amount)
    // → fast (attack) and slow (release) low-passes → max(fast, slow) = (f+s+|f−s|)/2
    // → clamp 0..1 → × −amount → added to the VCA gain (intrinsic 1): gain = 1 − amount·env.
    // max() of the two followers gives a fast attack and a slow release from linear filters.
    const keyIn = ctx.createGain();
    keyIn.channelCount = 1; keyIn.channelCountMode = 'explicit'; keyIn.channelInterpretation = 'speakers';
    const absCurve = makeCurve((x) => Math.abs(x), 4097);
    const rect = ctx.createWaveShaper(); rect.curve = absCurve;
    const det = ctx.createBiquadFilter(); det.type = 'lowpass'; det.Q.value = -3;
    const thr = ctx.createWaveShaper();
    const fast = ctx.createBiquadFilter(); fast.type = 'lowpass'; fast.Q.value = -3;
    const slowIn = ctx.createGain(); slowIn.gain.value = 2; // boosted so the slow follower "holds" after the hit
    const slow = ctx.createBiquadFilter(); slow.type = 'lowpass'; slow.Q.value = -3;
    const maxSum = ctx.createGain(); maxSum.gain.value = 0.5;
    const diff = ctx.createGain();
    const neg = ctx.createGain(); neg.gain.value = -1;
    const diffAbs = ctx.createWaveShaper(); diffAbs.curve = makeCurve((x) => Math.abs(x), 4097);
    const lim = ctx.createWaveShaper(); lim.curve = makeCurve((x) => clamp(x, 0, 1), 4097);
    const amt = ctx.createGain(); amt.gain.value = 0;
    const vca = ctx.createGain(); vca.gain.value = 1;
    keyIn.connect(rect); rect.connect(det); det.connect(thr);
    thr.connect(fast); thr.connect(slowIn); slowIn.connect(slow);
    fast.connect(maxSum); slow.connect(maxSum);
    fast.connect(diff); slow.connect(neg); neg.connect(diff); diff.connect(diffAbs); diffAbs.connect(maxSum);
    maxSum.connect(lim); lim.connect(amt); amt.connect(vca.gain);
    sh.fxIn.connect(vca); vca.connect(sh.wet);
    let thrKey = null;
    return {
      keyInput: keyIn,
      apply(p, im) {
        if (thrKey !== p.threshold) {
          thrKey = p.threshold;
          // detector output ≈ mean |x| (≈ −4 dB below the peak of a tone) → compensate, 6 dB knee
          thr.curve = makeCurve((x) => {
            if (x <= 0) return 0;
            const db = 20 * Math.log10(x) + 4;
            const t = clamp((db - p.threshold) / 6, 0, 1);
            return t * t * (3 - 2 * t);
          }, 4097);
        }
        const att = Math.max(0.0005, p.attack);
        setP(det.frequency, clamp(2 / (2 * Math.PI * att), 20, 400), ctx, im);
        setP(fast.frequency, clamp(1 / (2 * Math.PI * att), 4, 400), ctx, im);
        setP(slow.frequency, clamp(1 / (2 * Math.PI * Math.max(0.01, p.release) * 0.5), 0.3, 100), ctx, im);
        setP(amt.gain, -clamp(p.amount, 0, 1), ctx, im);
      },
      dispose() {
        for (const n of [keyIn, rect, det, thr, fast, slowIn, slow, maxSum, diff, neg, diffAbs, lim, amt, vca]) { try { n.disconnect(); } catch { /* */ } }
      },
    };
  },

  pump(ctx, sh, env) {
    const vca = ctx.createGain(); vca.gain.value = 1;
    const amt = ctx.createGain(); amt.gain.value = 0;
    sh.fxIn.connect(vca); vca.connect(sh.wet);
    let cur = null;
    let lfo = null;
    const bufFor = (p, bpm) => {
      const cycleSec = (divisionToBeats(p.division) * 60) / bpm;
      const att = clamp(p.attack / cycleSec, 0.002, 0.2);
      const rel = Math.max(0.02, p.curve * (1 - att));
      const key = `pump:${p.shape}|${att.toFixed(4)}|${rel.toFixed(3)}`;
      return cachedBuffer(ctx, key, (ph) => {
        if (ph < att) { const x = ph / att; return x * x * (3 - 2 * x); }
        const r = (ph - att) / rel;
        if (r >= 1) return 0;
        switch (p.shape) {
          case 'linear': return 1 - r;
          case 'smooth': return 0.5 * (1 + Math.cos(Math.PI * r));
          case 'hard': return r < 0.8 ? 1 : 1 - (r - 0.8) / 0.2;
          default: return Math.pow(1 - r, 2.2); // classic exponential-ish recovery
        }
      });
    };
    const api = {
      apply(p, im) {
        cur = p;
        const bpm = env.getBpm();
        const b = bufFor(p, bpm);
        if (!lfo) { lfo = new Lfo(ctx, b); lfo.out.connect(amt); amt.connect(vca.gain); } else lfo.setBuffer(b);
        setP(amt.gain, -p.depth, ctx, im);
        api.setTempo(bpm, true);
      },
      setTempo(bpm, noSync) {
        if (!cur || !lfo) return;
        lfo.setBuffer(bufFor(cur, bpm)); // attack is in seconds -> shape depends on tempo
        lfo.setHz(bpm / 60 / divisionToBeats(cur.division));
        if (!noSync) api.sync();
      },
      sync(time) { if (cur && lfo) syncLfo(lfo, { ...cur, sync: true }, env, time, cur.offset); },
      dispose() { lfo?.dispose(); },
    };
    return api;
  },

  distortion(ctx, sh) {
    const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.5;
    const dc = ctx.createBiquadFilter(); dc.type = 'highpass'; dc.frequency.value = 12;
    const out = ctx.createGain();
    sh.fxIn.connect(shaper); shaper.connect(dc); dc.connect(tone); tone.connect(out); out.connect(sh.wet);
    let key = '';
    return {
      apply(p, im) {
        const k = `${p.type}|${p.drive}`;
        if (k !== key) { key = k; shaper.curve = makeCurve(driveFn(p.type, dbToGain(p.drive)), 4096); }
        setP(tone.frequency, p.tone, ctx, im);
        // rough loudness compensation for heavy drive
        setP(out.gain, dbToGain(p.output) * (p.type === 'hard' || p.type === 'fuzz' ? 0.7 : 0.85), ctx, im);
      },
    };
  },

  saturator(ctx, sh) {
    const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.5;
    const dc = ctx.createBiquadFilter(); dc.type = 'highpass'; dc.frequency.value = 10;
    const out = ctx.createGain();
    sh.fxIn.connect(shaper); shaper.connect(dc); dc.connect(tone); tone.connect(out); out.connect(sh.wet);
    let key = '';
    return {
      apply(p, im) {
        const k = `${p.type}|${p.drive}`;
        if (k !== key) {
          key = k;
          const g = dbToGain(p.drive);
          const f = driveFn(p.type, g);
          // keep perceived level roughly constant: normalise by small-signal gain at drive
          const norm = Math.min(1, 1 / Math.max(1e-3, Math.abs(f(0.25)) / 0.25));
          shaper.curve = makeCurve((x) => f(x) * Math.max(norm, 0.35), 4096);
        }
        setP(tone.frequency, p.tone, ctx, im);
        setP(out.gain, dbToGain(p.output), ctx, im);
      },
    };
  },

  tape(ctx, sh, env) {
    const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.6;
    const head = ctx.createBiquadFilter(); head.type = 'peaking'; head.frequency.value = 110; head.gain.value = 1.5; head.Q.value = 0.8;
    const delay = ctx.createDelay(0.1); delay.delayTime.value = lookaheadTime(0.012, ctx.sampleRate);
    const wow = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
    const flutter = new Lfo(ctx, shapeBuffer(ctx, 'triangle'));
    flutter.setHz(7.3);
    const wowAmt = ctx.createGain(); const flAmt = ctx.createGain();
    wow.out.connect(wowAmt); flutter.out.connect(flAmt); wowAmt.connect(delay.delayTime); flAmt.connect(delay.delayTime);
    const out = ctx.createGain();
    sh.fxIn.connect(shaper); shaper.connect(head); head.connect(tone); tone.connect(delay); delay.connect(out); out.connect(sh.wet);
    // dry path delayed by the same base delay to avoid comb filtering when mixing
    const dryDelay = ctx.createDelay(0.1); dryDelay.delayTime.value = lookaheadTime(0.012, ctx.sampleRate);
    try { sh.fxIn.disconnect(sh.dry); } catch { /* */ }
    sh.fxIn.connect(dryDelay); dryDelay.connect(sh.dry);
    let key = '';
    return {
      apply(p, im) {
        if (key !== String(p.drive)) { key = String(p.drive); shaper.curve = makeCurve(driveFn('soft', dbToGain(p.drive)), 4096); }
        setP(tone.frequency, p.tone, ctx, im);
        wow.setHz(p.wowRate);
        setP(wowAmt.gain, p.wow * 0.004, ctx, im);
        setP(flAmt.gain, p.flutter * 0.0004, ctx, im);
        setP(out.gain, dbToGain(p.output), ctx, im);
      },
      dispose() { wow.dispose(); flutter.dispose(); },
    };
  },

  bitcrusher(ctx, sh) {
    const shaper = ctx.createWaveShaper();
    // sample & hold: delay time ramps 0..(k-1) samples, so y[n] = x[n - (n mod k)]
    const hold = ctx.createDelay(0.01); hold.delayTime.value = 0;
    const out = ctx.createGain();
    sh.fxIn.connect(hold); hold.connect(shaper); shaper.connect(out); out.connect(sh.wet);
    let ramp = null;
    let bitsKey = null;
    let dsKey = null;
    return {
      apply(p, im) {
        const bits = Math.round(p.bits);
        if (bits !== bitsKey) {
          bitsKey = bits;
          const steps = Math.pow(2, bits - 1);
          shaper.curve = bits >= 16 ? null : makeCurve((x) => Math.round(x * steps) / steps, Math.min(65536, Math.max(4096, steps * 64)));
        }
        const k = Math.max(1, Math.round(p.downsample));
        if (k !== dsKey) {
          dsKey = k;
          if (ramp) { try { ramp.stop(); ramp.disconnect(); } catch { /* */ } ramp = null; }
          if (k > 1) {
            const b = ctx.createBuffer(1, k, ctx.sampleRate);
            const d = b.getChannelData(0);
            for (let i = 0; i < k; i++) d[i] = i / ctx.sampleRate;
            ramp = ctx.createBufferSource();
            ramp.buffer = b; ramp.loop = true;
            ramp.connect(hold.delayTime);
            ramp.start();
          }
        }
        setP(out.gain, dbToGain(p.output), ctx, im);
      },
      dispose() { if (ramp) { try { ramp.stop(); } catch { /* */ } } },
    };
  },

  delay(ctx, sh, env) {
    const inSt = stereoGain(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const sumL = ctx.createGain(); const sumR = ctx.createGain();
    const dL = ctx.createDelay(4); const dR = ctx.createDelay(4);
    const mk = () => {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.5;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
      const fb = ctx.createGain();
      hp.connect(lp); lp.connect(fb);
      return { hp, lp, fb };
    };
    const L = mk(); const R = mk();
    sh.fxIn.connect(inSt); inSt.connect(split);
    dL.connect(L.hp); dR.connect(R.hp);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    merge.connect(sh.wet);
    sumL.connect(dL); sumR.connect(dR);
    let mode = null;
    let cur = null;
    const wire = (pp) => {
      if (pp === mode) return;
      mode = pp;
      for (const n of [split, L.fb, R.fb]) { try { n.disconnect(); } catch { /* */ } }
      if (pp) {
        // mono-sum into left; L -> R -> L ...
        split.connect(sumL, 0); split.connect(sumL, 1);
        L.fb.connect(sumR); R.fb.connect(sumL);
      } else {
        split.connect(sumL, 0); split.connect(sumR, 1);
        L.fb.connect(sumL); R.fb.connect(sumR);
      }
    };
    const api = {
      apply(p, im) {
        cur = p;
        wire(!!p.pingpong);
        setP(sumL.gain, p.pingpong ? 0.5 : 1, ctx, im);
        for (const s of [L, R]) {
          setP(s.hp.frequency, p.lowcut, ctx, im);
          setP(s.lp.frequency, p.highcut, ctx, im);
          setP(s.fb.gain, p.feedback, ctx, im);
        }
        api.setTempo(env.getBpm(), im);
      },
      setTempo(bpm, im) {
        if (!cur) return;
        const t = clamp(cur.sync ? (divisionToBeats(cur.division) * 60) / bpm : cur.time, 0.001, 3.9);
        setP(dL.delayTime, t, ctx, im);
        setP(dR.delayTime, t, ctx, im);
      },
    };
    return api;
  },

  reverb(ctx, sh) {
    const pre = ctx.createDelay(1);
    const lo = ctx.createBiquadFilter(); lo.type = 'highpass'; lo.Q.value = 0.5;
    const hi = ctx.createBiquadFilter(); hi.type = 'lowpass'; hi.Q.value = 0.5;
    sh.fxIn.connect(pre);
    lo.connect(hi); hi.connect(sh.wet);
    let conv = null; let convGain = null;
    let irKey = '';
    let timer = null;
    const swap = (p) => {
      const character = reverbCharacter(p);
      const buf = character === 'classic' ? makeImpulse(ctx, p.decay, p.size, p.damping) : makeSpaceImpulse(ctx, p.decay, p.size, p.damping, character);
      const c = ctx.createConvolver();
      c.normalize = true;
      c.buffer = buf;
      const g = ctx.createGain();
      pre.connect(c); c.connect(g); g.connect(lo);
      const now = ctx.currentTime;
      if (conv) {
        // crossfade from the old IR to the new one
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(1, now + 0.08);
        const oc = conv; const og = convGain;
        og.gain.setValueAtTime(og.gain.value, now);
        og.gain.linearRampToValueAtTime(0, now + 0.08);
        setTimeout(() => { try { pre.disconnect(oc); oc.disconnect(); og.disconnect(); } catch { /* */ } }, 300);
      }
      conv = c; convGain = g;
    };
    return {
      apply(p, im) {
        setP(pre.delayTime, p.predelay, ctx, im);
        setP(lo.frequency, p.lowcut, ctx, im);
        setP(hi.frequency, p.highcut, ctx, im);
        const k = `${p.decay}|${p.size}|${p.damping}|${p.character}`;
        if (k !== irKey) {
          irKey = k;
          if (!conv || im || isOffline(ctx)) swap(p);
          else { clearTimeout(timer); timer = setTimeout(() => swap(p), 90); }
        }
      },
      dispose() { clearTimeout(timer); },
    };
  },

  chorus(ctx, sh, env) {
    const inSt = stereoGain(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const dL = ctx.createDelay(0.1); const dR = ctx.createDelay(0.1);
    const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
    const mL = ctx.createGain(); const mR = ctx.createGain();
    lfo.out.connect(mL); lfo.out.connect(mR); mL.connect(dL.delayTime); mR.connect(dR.delayTime);
    sh.fxIn.connect(inSt); inSt.connect(split);
    split.connect(dL, 0); split.connect(dR, 1);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    merge.connect(sh.wet);
    let cur = null;
    const api = {
      apply(p, im) {
        cur = p;
        setP(dL.delayTime, p.delay, ctx, im); setP(dR.delayTime, p.delay, ctx, im);
        const amt = p.delay * 0.45 * p.depth;
        setP(mL.gain, amt, ctx, im);
        setP(mR.gain, amt * (1 - 2 * p.spread), ctx, im); // spread 1 -> inverted modulation on R
        api.setTempo(env.getBpm());
      },
      setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
      sync(time) { syncLfo(lfo, cur, env, time); },
      dispose() { lfo.dispose(); },
    };
    return api;
  },

  flanger(ctx, sh, env) {
    const inSt = stereoGain(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const sL = ctx.createGain(); const sR = ctx.createGain();
    const dL = ctx.createDelay(0.1); const dR = ctx.createDelay(0.1);
    const fL = ctx.createGain(); const fR = ctx.createGain();
    const lfo = new Lfo(ctx, shapeBuffer(ctx, 'triangle'));
    const mL = ctx.createGain(); const mR = ctx.createGain();
    lfo.out.connect(mL); lfo.out.connect(mR); mL.connect(dL.delayTime); mR.connect(dR.delayTime);
    sh.fxIn.connect(inSt); inSt.connect(split);
    split.connect(sL, 0); split.connect(sR, 1);
    sL.connect(dL); sR.connect(dR);
    dL.connect(fL); fL.connect(sL); dR.connect(fR); fR.connect(sR);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    merge.connect(sh.wet);
    let cur = null;
    const api = {
      apply(p, im) {
        cur = p;
        setP(dL.delayTime, p.delay, ctx, im); setP(dR.delayTime, p.delay, ctx, im);
        const amt = p.delay * 0.9 * p.depth;
        setP(mL.gain, amt, ctx, im); setP(mR.gain, -amt, ctx, im);
        setP(fL.gain, p.feedback, ctx, im); setP(fR.gain, p.feedback, ctx, im);
        api.setTempo(env.getBpm());
      },
      setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
      sync(time) { syncLfo(lfo, cur, env, time); },
      dispose() { lfo.dispose(); },
    };
    return api;
  },

  phaser(ctx, sh, env) {
    const inSt = stereoGain(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
    const mL = ctx.createGain(); const mR = ctx.createGain();
    lfo.out.connect(mL); lfo.out.connect(mR);
    sh.fxIn.connect(inSt); inSt.connect(split);
    merge.connect(sh.wet);
    const chans = [0, 1].map((ch) => {
      const sum = ctx.createGain();
      const fbDelay = ctx.createDelay(0.01); fbDelay.delayTime.value = 0;
      const fb = ctx.createGain();
      split.connect(sum, ch);
      return { sum, fbDelay, fb, stages: [], mod: ch === 0 ? mL : mR, ch };
    });
    let nStages = 0;
    let cur = null;
    const build = (n) => {
      if (n === nStages) return;
      nStages = n;
      for (const c of chans) {
        for (const s of c.stages) { try { s.disconnect(); } catch { /* */ } try { c.mod.disconnect(s.detune); } catch { /* */ } }
        try { c.sum.disconnect(); } catch { /* */ }
        try { c.fb.disconnect(); } catch { /* */ }
        try { c.fbDelay.disconnect(); } catch { /* */ }
        c.stages = Array.from({ length: n }, () => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; return f; });
        let prev = c.sum;
        for (const s of c.stages) { prev.connect(s); c.mod.connect(s.detune); prev = s; }
        prev.connect(merge, 0, c.ch);
        prev.connect(c.fb); c.fb.connect(c.fbDelay); c.fbDelay.connect(c.sum);
      }
    };
    const api = {
      apply(p, im) {
        cur = p;
        build(Number(p.stages) || 4);
        for (const c of chans) {
          for (const s of c.stages) { setP(s.frequency, p.frequency, ctx, im); setP(s.Q, p.q, ctx, im); }
          setP(c.fb.gain, p.feedback, ctx, im);
        }
        setP(mL.gain, p.depth * 1200, ctx, im);
        setP(mR.gain, p.depth * 1200 * (p.stereo ? -1 : 1), ctx, im);
        api.setTempo(env.getBpm());
      },
      setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
      sync(time) { syncLfo(lfo, cur, env, time); },
      dispose() { lfo.dispose(); },
    };
    return api;
  },

  tremolo(ctx, sh, env) {
    const inSt = stereoGain(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const vL = ctx.createGain(); const vR = ctx.createGain();
    const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
    const mL = ctx.createGain(); const mR = ctx.createGain();
    lfo.out.connect(mL); lfo.out.connect(mR); mL.connect(vL.gain); mR.connect(vR.gain);
    sh.fxIn.connect(inSt); inSt.connect(split);
    split.connect(vL, 0); split.connect(vR, 1);
    vL.connect(merge, 0, 0); vR.connect(merge, 0, 1);
    merge.connect(sh.wet);
    let cur = null;
    const api = {
      apply(p, im) {
        cur = p;
        const base = 1 - p.depth / 2;
        setP(vL.gain, base, ctx, im); setP(vR.gain, base, ctx, im);
        setP(mL.gain, p.depth / 2, ctx, im);
        setP(mR.gain, (p.depth / 2) * (p.stereo ? -1 : 1), ctx, im);
        lfo.setBuffer(shapeBuffer(ctx, p.shape));
        api.setTempo(env.getBpm());
      },
      setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
      sync(time) { syncLfo(lfo, cur, env, time); },
      dispose() { lfo.dispose(); },
    };
    return api;
  },

  autopan(ctx, sh, env) {
    const pan = ctx.createStereoPanner();
    const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
    const m = ctx.createGain();
    lfo.out.connect(m); m.connect(pan.pan);
    sh.fxIn.connect(pan); pan.connect(sh.wet);
    let cur = null;
    const api = {
      apply(p, im) {
        cur = p;
        setP(m.gain, p.depth, ctx, im);
        lfo.setBuffer(shapeBuffer(ctx, p.shape));
        api.setTempo(env.getBpm());
      },
      setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
      sync(time) { syncLfo(lfo, cur, env, time); },
      dispose() { lfo.dispose(); },
    };
    return api;
  },

  widener(ctx, sh) {
    const ms = createMidSide(ctx);
    const out = ctx.createGain();
    sh.fxIn.connect(ms.input); ms.output.connect(out); out.connect(sh.wet);
    return {
      apply(p, im) {
        ms.setWidth(p.width, im);
        ms.setMonoBelow(p.monoBelow, im);
        setP(out.gain, dbToGain(p.output), ctx, im);
      },
    };
  },

  // Mastering chain in one device: tone (low shelf, tilt around 1 kHz, air shelf) -> glue compressor (slow, low
  // ratio; the node's built-in make-up gain is cancelled) -> soft saturation -> stereo width of the highs only
  // (side = side + (w-1)·HP(side), so w = 1 is bit-transparent) -> limiter (native look-ahead compressor at
  // ratio 20 + a 4x-oversampled soft clipper as true-peak safety) -> ceiling.
  mastering(ctx, sh) {
    const lowSh = ctx.createBiquadFilter(); lowSh.type = 'lowshelf'; lowSh.frequency.value = 90;
    const tiltLo = ctx.createBiquadFilter(); tiltLo.type = 'lowshelf'; tiltLo.frequency.value = 900;
    const tiltHi = ctx.createBiquadFilter(); tiltHi.type = 'highshelf'; tiltHi.frequency.value = 1100;
    const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 11000;
    const glue = ctx.createDynamicsCompressor();
    const glueMk = ctx.createGain();
    const drvIn = ctx.createGain();
    const drv = ctx.createWaveShaper(); drv.oversample = '2x';
    drvIn.gain.value = 1;
    const drvOut = ctx.createGain();
    const dry = ctx.createGain(); const wetSat = ctx.createGain();
    const satSum = stereoGain(ctx);
    // highs-only width
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const lToS = ctx.createGain(); lToS.gain.value = 0.5;
    const rToS = ctx.createGain(); rToS.gain.value = -0.5;
    const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.Q.value = Math.SQRT1_2;
    const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.Q.value = Math.SQRT1_2;
    const extra = ctx.createGain(); extra.gain.value = 0; // (width - 1)
    const extraNeg = ctx.createGain(); extraNeg.gain.value = -1;
    const passL = ctx.createGain(); const passR = ctx.createGain();
    // limiter
    const limIn = ctx.createGain();
    const lim = ctx.createDynamicsCompressor();
    lim.ratio.value = 20; lim.knee.value = 0; lim.attack.value = 0.001;
    const limMk = ctx.createGain();
    const clip = ctx.createWaveShaper(); clip.oversample = '4x';
    clip.curve = makeCurve((x) => {
      const a = Math.abs(x), k = 0.89; // knee from -1 dB to the ceiling
      return a <= k ? x : Math.sign(x) * (k + (1 - k) * Math.tanh((a - k) / (1 - k)));
    }, 8192);
    const ceil = ctx.createGain();
    sh.fxIn.connect(lowSh); lowSh.connect(tiltLo); tiltLo.connect(tiltHi); tiltHi.connect(air);
    air.connect(glue); glue.connect(glueMk);
    glueMk.connect(dry); dry.connect(satSum);
    glueMk.connect(drvIn); drvIn.connect(drv); drv.connect(drvOut); drvOut.connect(wetSat); wetSat.connect(satSum);
    satSum.connect(split);
    split.connect(passL, 0); split.connect(passR, 1);
    passL.connect(merge, 0, 0); passR.connect(merge, 0, 1);
    split.connect(lToS, 0); split.connect(rToS, 1); lToS.connect(hp1); rToS.connect(hp1); hp1.connect(hp2); hp2.connect(extra);
    extra.connect(merge, 0, 0); extra.connect(extraNeg); extraNeg.connect(merge, 0, 1);
    merge.connect(limIn); limIn.connect(lim); lim.connect(limMk); limMk.connect(clip); clip.connect(ceil); ceil.connect(sh.wet);
    // compressor make-up per the Web Audio spec: (1 / curve(0 dBFS))^0.6 — cancelled so levels stay predictable
    const autoMakeupDb = (thr, ratio) => 0.6 * Math.max(0, -thr) * (1 - 1 / Math.max(1, ratio));
    let curDrive = null;
    return {
      apply(p, im) {
        setP(lowSh.gain, p.low, ctx, im);
        setP(tiltLo.gain, -p.tilt / 2, ctx, im); setP(tiltHi.gain, p.tilt / 2, ctx, im);
        setP(air.gain, p.air, ctx, im);
        setP(glue.threshold, p.glueThreshold, ctx, im); setP(glue.ratio, p.glueRatio, ctx, im);
        setP(glue.attack, p.glueAttack, ctx, im); setP(glue.release, p.glueRelease, ctx, im); setP(glue.knee, 6, ctx, im);
        setP(glueMk.gain, dbToGain(-autoMakeupDb(p.glueThreshold, p.glueRatio)), ctx, im);
        if (curDrive !== p.drive) {
          curDrive = p.drive;
          const k = dbToGain(p.drive);
          drv.curve = makeCurve((x) => Math.tanh(x * k) / Math.tanh(k), 4096);
        }
        // the saturator is mixed in parallel, deeper with more drive (unity level at the input)
        const sat = clamp(p.drive / 12, 0, 1);
        setP(wetSat.gain, sat, ctx, im); setP(dry.gain, 1 - sat, ctx, im);
        const kd = dbToGain(p.drive);
        setP(drvOut.gain, Math.tanh(kd) / kd, ctx, im); // unity small-signal gain: only the peaks are rounded off
        setP(hp1.frequency, p.widthFreq, ctx, im); setP(hp2.frequency, p.widthFreq, ctx, im);
        setP(extra.gain, p.width - 1, ctx, im);
        setP(limIn.gain, dbToGain(p.gain), ctx, im);
        const thr = p.ceiling - 1;
        setP(lim.threshold, thr, ctx, im); setP(lim.release, p.release, ctx, im);
        setP(limMk.gain, dbToGain(-autoMakeupDb(thr, 20)) / dbToGain(p.ceiling), ctx, im);
        setP(ceil.gain, dbToGain(p.ceiling), ctx, im);
      },
      getReduction: () => lim.reduction + glue.reduction,
    };
  },

  utility(ctx, sh) {
    const g = ctx.createGain();
    const ms = createMidSide(ctx);
    const pan = ctx.createStereoPanner();
    sh.fxIn.connect(g); g.connect(ms.input); ms.output.connect(pan); pan.connect(sh.wet);
    return {
      apply(p, im) {
        setP(g.gain, dbToGain(p.gain) * (p.invert ? -1 : 1), ctx, im);
        ms.setWidth(p.mono ? 0 : p.width, im);
        setP(pan.pan, p.pan, ctx, im);
      },
    };
  },
};

/** Mid/side matrix: L' = M + w*S, R' = M - w*S, with optional high-pass on S (bass mono). */
function createMidSide(ctx) {
  const input = stereoGain(ctx);
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const output = ctx.createGain();
  const mid = ctx.createGain();
  const lToS = ctx.createGain(); lToS.gain.value = 0.5;
  const rToS = ctx.createGain(); rToS.gain.value = -0.5;
  const lToM = ctx.createGain(); lToM.gain.value = 0.5;
  const rToM = ctx.createGain(); rToM.gain.value = 0.5;
  const side = ctx.createGain();
  const sideHp = ctx.createBiquadFilter(); sideHp.type = 'highpass'; sideHp.frequency.value = 10; sideHp.Q.value = 0.7;
  const width = ctx.createGain();
  const sideNeg = ctx.createGain(); sideNeg.gain.value = -1;
  input.connect(split);
  split.connect(lToM, 0); split.connect(rToM, 1); lToM.connect(mid); rToM.connect(mid);
  split.connect(lToS, 0); split.connect(rToS, 1); lToS.connect(side); rToS.connect(side);
  side.connect(sideHp); sideHp.connect(width);
  mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
  width.connect(merge, 0, 0); width.connect(sideNeg); sideNeg.connect(merge, 0, 1);
  merge.connect(output);
  return {
    input, output,
    setWidth(w, im) { setP(width.gain, w, ctx, im); },
    setMonoBelow(f, im) { setP(sideHp.frequency, f <= 21 ? 10 : f, ctx, im); },
  };
}

/** Phase-align a tempo-synced LFO to the transport (no-op when not synced / not playing). */
function syncLfo(lfo, p, env, time, offset = 0) {
  if (!lfo || !p || !p.sync) return;
  const t = time ?? lfo.ctx.currentTime + 0.02;
  const beat = env.getBeatAt?.(t);
  if (beat == null || !isFinite(beat)) return;
  const cycle = divisionToBeats(p.division);
  lfo.start(t, beat / cycle + offset);
}

// Effect families from src/audio/fx/builders get the shared helpers (no import cycle back into this module).
const FX_HELPERS = { isOffline, setP, stereoGain, cachedBuffer, shapeBuffer, lfoRate, makeCurve, driveFn, makeImpulse, makeSpaceImpulse, createMidSide, syncLfo, clamp, dbToGain, createRng, divisionToBeats };
for (const family of FX_BUILDER_FAMILIES) Object.assign(BUILDERS, family(FX_HELPERS));

// ------------------------------------------------------------------------------ factory
/**
 * @param {BaseAudioContext} ctx
 * @param {{id?, type, enabled?, params?}} effectDef
 * @param {{getBpm?:()=>number, getBeatAt?:(time:number)=>number|null}} opts
 */
export function createEffect(ctx, effectDef, opts = {}) {
  const type = effectDef?.type;
  const builder = BUILDERS[type] || (PLUGIN_EFFECT_TYPES.includes(type) ? pluginEffectBuilder(type) : null);
  if (!builder) throw new Error(`Unknown effect type "${type}"`);
  const env = { getBpm: opts.getBpm || (() => 120), getBeatAt: opts.getBeatAt || (() => null) };
  const sh = createShell(ctx);
  const impl = builder(ctx, sh, env);
  const hasMix = EFFECT_DEFS[type].params.some((p) => p.key === 'mix');
  let bypassed = null;
  let lastJson = null;
  let disposed = false;
  let fallbackFx = null;
  let fallbackReady = null;
  let curDef = effectDef;
  // PDC: the bypass path is delayed by the effect's latency, so bypassing never shifts the signal in time
  let thruDelay = null;
  const setThruLatency = (sec) => {
    if (!(sec > 0) && !thruDelay) return;
    if (!thruDelay || sec > thruDelay._max) {
      const old = thruDelay;
      thruDelay = ctx.createDelay(Math.max(0.1, sec * 2));
      thruDelay._max = Math.max(0.1, sec * 2);
      if (old) { try { sh.input.disconnect(old); } catch { /* */ } try { old.disconnect(); } catch { /* */ } } else { try { sh.input.disconnect(sh.thru); } catch { /* */ } }
      sh.input.connect(thruDelay);
      thruDelay.connect(sh.thru);
    }
    thruDelay.delayTime.value = Math.max(0, sec);
  };
  const latencyNow = () => {
    if (Number.isFinite(curDef?.latency) && curDef.latency >= 0) return curDef.latency / ctx.sampleRate; // manual (samples)
    if (fallbackFx) return fallbackFx.latency;
    if (BUILDERS[type]) return effectLatencyFrames({ type, params: curDef?.params }, ctx.sampleRate) / ctx.sampleRate;
    const l = Number(impl.latency); // plugins: reported by the plugin once loaded (seconds)
    return Number.isFinite(l) && l > 0 ? l : 0;
  };
  let lastLatency = -1;

  const fx = {
    type,
    input: sh.input,
    output: sh.output,
    update(def, immediate = false) {
      if (disposed) return;
      curDef = def;
      const json = JSON.stringify(def?.params || {});
      if (json !== lastJson) {
        lastJson = json;
        const p = resolveEffectParams({ type, params: def?.params });
        impl.apply(p, immediate, def);
        if (hasMix) {
          setP(sh.dry.gain, 1 - p.mix, ctx, immediate);
          setP(sh.wet.gain, p.mix, ctx, immediate);
        }
      }
      fx.setBypass(def?.enabled === false, immediate);
      fx.refreshLatency();
    },
    /**
     * Processing latency in seconds (look-ahead, oversampling, plugin-reported, or the def's manual `latency`
     * in samples). Constant whether bypassed or not (the bypass path is delayed to match).
     */
    get latency() { return latencyNow(); },
    /** Re-read the latency (plugins report theirs once loaded); returns true when it changed. */
    refreshLatency() {
      const l = latencyNow();
      if (l === lastLatency) return false;
      lastLatency = l;
      setThruLatency(l);
      return true;
    },
    setBypass(b, immediate = false) {
      b = !!b;
      if (b === bypassed) return;
      bypassed = b;
      setP(sh.thru.gain, b ? 1 : 0, ctx, immediate);
      setP(sh.fxOut.gain, b ? 0 : 1, ctx, immediate);
    },
    get bypassed() { return bypassed; },
    setTempo(bpm) { try { impl.setTempo?.(bpm); fallbackFx?.setTempo(bpm); } catch (e) { console.warn('[fx] setTempo', e); } },
    sync(time) { try { impl.sync?.(time); fallbackFx?.sync(time); } catch (e) { console.warn('[fx] sync', e); } },
    getReduction: impl.getReduction ? () => impl.getReduction() : undefined,
    /** Offline renders: resolves once every message posted to the effect's worklet has arrived (worklet builders). */
    flush: impl.flush ? () => impl.flush() : undefined,
    /** Live data a builder exposes for its custom UI (analyzers, step position…), else null. */
    get probe() { return impl.probe ?? null; },
    /** Sidechain key input (ducker only): connect the key signal here. */
    keyInput: impl.keyInput || null,
    /** Plugin effects (faust/wam): load promise (true/false), error message and live plugin. */
    get ready() { return fallbackReady || (impl.ready ?? null); },
    get error() { return fallbackFx ? null : (impl.error ?? null); },
    /** The built-in effect that replaced a plugin which failed to load (params.fallback), else null. */
    get fallback() { return fallbackFx; },
    get plugin() { return impl.plugin ?? null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { impl.dispose?.(); } catch { /* */ }
      try { fallbackFx?.dispose(); } catch { /* */ }
      for (const n of Object.values(sh)) { try { n.disconnect(); } catch { /* */ } }
      try { thruDelay?.disconnect(); } catch { /* */ }
    },
  };
  if (!fx.getReduction) delete fx.getReduction;
  if (!fx.flush) delete fx.flush;
  fx.update(effectDef, true);
  fx.sync();
  // Plugin effects with params.fallback = {type, params} (generated songs): if the plugin can't load (no network,
  // no AudioWorklet, compile error) the built-in effect takes its place instead of a plain pass-through — a reverb
  // bus keeps its reverb, a tape-echo bus its echo. Until then the plugin's own pass-through is muted (a send bus
  // must never return the dry signal).
  const fb = PLUGIN_EFFECT_TYPES.includes(type) ? effectDef?.params?.fallback : null;
  if (fb && BUILDERS[fb.type]) {
    setP(sh.wet.gain, 0, ctx, true);
    const first = Promise.resolve(impl.ready);
    fallbackReady = first.then((ok) => {
      if (disposed) return ok;
      if (ok) { if (!fallbackFx) setP(sh.wet.gain, resolveEffectParams({ type, params: effectDef.params }).mix, ctx, true); return true; }
      impl.detach?.();
      fallbackFx = createEffect(ctx, { type: fb.type, params: { ...(fb.params || {}) }, enabled: true }, opts);
      sh.fxIn.connect(fallbackFx.input);
      fallbackFx.output.connect(sh.wet);
      setP(sh.wet.gain, 1, ctx, true);
      setP(sh.dry.gain, 0, ctx, true);
      try { fallbackFx.setTempo(env.getBpm()); } catch { /* */ }
      fx.refreshLatency();
      return true;
    }, () => false);
  }
  return fx;
}

export { EFFECT_DEFS };
