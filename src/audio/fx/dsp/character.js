// Character effects DSP: Hilbert-transform frequency shifter, tuned comb resonator, envelope-follower filter
// (auto-wah), waveshaper transfer curves and mid/side matrices. Pure JS (worklets, builders and Node tests).
import { Svf, DcBlock, clamp, midiToHz, onePoleCoef, decayGain, CHORDS, CHORD_NAMES, TAU } from './common.js';

// ------------------------------------------------------------------------------------------- Hilbert pair
/**
 * Allpass pair with a ~90° phase difference over most of the band (Olli Niemitalo's 8th-order design: each path is
 * four 2nd-order sections (a² − z⁻²)/(1 − a² z⁻²); path A is delayed one sample). Within ±1° of 90° from ~0.0006·sr
 * to ~0.4993·sr (≈ 25 Hz – 22 kHz at 44.1 kHz).
 */
export const HILBERT_A = [0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737];
export const HILBERT_B = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278];

class AllpassChain {
  constructor(coefs) {
    this.a2 = coefs.map((a) => a * a);
    this.x1 = new Float64Array(4); this.x2 = new Float64Array(4); this.y1 = new Float64Array(4); this.y2 = new Float64Array(4);
  }
  process(x) {
    for (let i = 0; i < 4; i++) {
      const y = this.a2[i] * (x + this.y2[i]) - this.x2[i];
      this.x2[i] = this.x1[i]; this.x1[i] = x;
      this.y2[i] = this.y1[i]; this.y1[i] = y;
      x = y;
    }
    return x;
  }
}

/** process(x) sets this.i (in-phase) and this.q (quadrature, 90° behind i: i = cos ωt -> q = sin ωt). */
export class Hilbert {
  constructor() { this.A = new AllpassChain(HILBERT_A); this.B = new AllpassChain(HILBERT_B); this.d = 0; this.i = 0; this.q = 0; }
  process(x) {
    const a = this.A.process(x);
    this.i = this.d; this.d = a; // path A, one sample late
    this.q = -this.B.process(x); // path B leads path A by 90°: negated it lags
  }
}

/** Phase (radians) of one allpass path at frequency f (closed form, for tests and plots). */
export function hilbertPhase(coefs, f, sr, delayed = false) {
  const w = (TAU * f) / sr;
  let ph = delayed ? -w : 0;
  for (const a of coefs) {
    const a2 = a * a;
    // H = (a² − e^{-2jw}) / (1 − a² e^{-2jw})
    const nr = a2 - Math.cos(2 * w), ni = Math.sin(2 * w);
    const dr = 1 - a2 * Math.cos(2 * w), di = a2 * Math.sin(2 * w);
    ph += Math.atan2(ni, nr) - Math.atan2(di, dr);
  }
  return ph;
}
/** Phase difference i − q of Hilbert's outputs in degrees, wrapped to (−180, 180] (+90 over the design band). */
export function hilbertPhaseDifference(f, sr) {
  let d = ((hilbertPhase(HILBERT_A, f, sr, true) - hilbertPhase(HILBERT_B, f, sr) - Math.PI) * 180) / Math.PI;
  d = ((d % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

export const SHIFT_DIRECTIONS = ['up', 'down', 'both'];

/**
 * Frequency shifter (single-sideband modulation): every partial moves by `shift` Hz (inharmonic, unlike a pitch
 * shifter). direction: up / down / both (left up, right down). Feedback re-shifts the output (barber-pole spirals).
 * shiftMod: optional per-sample Hz offset (LFO) array.
 */
export class FreqShifterEngine {
  constructor(sr) {
    this.sr = sr;
    this.hL = new Hilbert(); this.hR = new Hilbert();
    this.ph = 0;
    this.fbL = 0; this.fbR = 0;
    this.p = { shift: 0, direction: 'up', feedback: 0 };
  }
  set(p) {
    this.p = { shift: clamp(p.shift ?? 0, -5000, 5000), direction: SHIFT_DIRECTIONS[clamp(Math.round(p.direction ?? 0), 0, 2)], feedback: clamp(p.feedback ?? 0, 0, 0.95) };
  }
  process(inL, inR, outL, outR, n, shiftMod = null) {
    const { p, sr } = this;
    const fb = p.feedback;
    const dir = p.direction;
    for (let s = 0; s < n; s++) {
      const hz = p.shift + (shiftMod ? shiftMod[shiftMod.length > 1 ? s : 0] : 0);
      this.ph += hz / sr;
      this.ph -= Math.floor(this.ph);
      const c = Math.cos(TAU * this.ph), sn = Math.sin(TAU * this.ph);
      this.hL.process(inL[s] + fb * this.fbL);
      this.hR.process(inR[s] + fb * this.fbR);
      const upL = this.hL.i * c - this.hL.q * sn, dnL = this.hL.i * c + this.hL.q * sn;
      const upR = this.hR.i * c - this.hR.q * sn, dnR = this.hR.i * c + this.hR.q * sn;
      let yl, yr;
      if (dir === 'up') { yl = upL; yr = upR; } else if (dir === 'down') { yl = dnL; yr = dnR; } else { yl = upL; yr = dnR; }
      this.fbL = Math.tanh(yl); this.fbR = Math.tanh(yr);
      outL[s] = yl; outR[s] = yr;
    }
  }
}

// ------------------------------------------------------------------------------------------- resonator
/** Phase delay (samples) of the loop low-pass y = (1−b)x + b·y[n−1] at frequency f. */
export function onePolePhaseDelay(b, f, sr) {
  const w = (TAU * f) / sr;
  if (w <= 0 || b <= 0) return 0;
  return Math.atan2(b * Math.sin(w), 1 - b * Math.cos(w)) / w;
}
export function onePoleGain(b, f, sr) {
  const w = (TAU * f) / sr;
  return (1 - b) / Math.sqrt(1 - 2 * b * Math.cos(w) + b * b);
}

/**
 * Tuning of one comb voice: delay (samples, fractional, loop filter phase delay removed) and feedback gain so the
 * fundamental f decays 60 dB in t60 s. odd: negative feedback (only odd harmonics, sounding an octave lower for
 * the same delay — the delay is halved so the voice still sounds at f).
 */
export function combTuning(f, t60, damp, sr, odd = false) {
  const period = sr / f;
  const loop = odd ? period / 2 : period;
  const perLoop = decayGain(loop, t60, sr); // decay per pass
  // a long decay on a high note can need more loop gain than the damping leaves: open the loop filter just enough
  const maxG = 0.9995;
  // the delay line's linear interpolation also loses a little at f (fraction fr of a sample: |1 − fr + fr·e^−jω|)
  const w = (TAU * f) / sr;
  const interp = (d) => { const fr = d - Math.floor(d); return Math.hypot(1 - fr + fr * Math.cos(w), fr * Math.sin(w)); };
  const delayFor = (b) => Math.max(1, loop - onePolePhaseDelay(b, f, sr) - 1); // − the delay line's own sample
  const loss = (b) => onePoleGain(b, f, sr) * interp(delayFor(b));
  if (perLoop / loss(damp) > maxG) {
    let lo = 0, hi = damp;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (perLoop / loss(m) > maxG) hi = m; else lo = m; }
    damp = lo;
  }
  const delay = delayFor(damp);
  const g = Math.min(maxG, perLoop / Math.max(1e-6, loss(damp)));
  return { delay, g: odd ? -g : g, loop, damp };
}

export const RESONATOR_TYPES = ['comb', 'odd'];

export class ResonatorEngine {
  constructor(sr) {
    this.sr = sr;
    this.max = 4;
    const len = Math.ceil(sr / 20) + 8;
    this.lines = Array.from({ length: this.max * 2 }, () => ({ buf: new Float32Array(len), w: 0, lp: 0 }));
    this.len = len;
    this.voices = [];
    this.dcL = new DcBlock(sr, 20); this.dcR = new DcBlock(sr, 20); // the combs also resonate at DC
    this.key = '';
    this.set({});
  }
  /** p: { note (MIDI), chord (index), tune (cents), decay (s), bright (0..1), type (index), spread (0..1) } */
  set(p) {
    const q = {
      note: clamp(p.note ?? 48, 24, 120), chord: CHORD_NAMES[clamp(Math.round(p.chord ?? 0), 0, CHORD_NAMES.length - 1)],
      tune: clamp(p.tune ?? 0, -100, 100), decay: clamp(p.decay ?? 1.5, 0.02, 30), bright: clamp(p.bright ?? 0.6, 0, 1),
      type: RESONATOR_TYPES[clamp(Math.round(p.type ?? 0), 0, 1)], spread: clamp(p.spread ?? 0.5, 0, 1),
    };
    const key = JSON.stringify(q);
    if (key === this.key) return;
    this.key = key;
    this.p = q;
    const damp = 0.92 * (1 - q.bright) ** 1.5;
    const iv = (CHORDS[q.chord] || [0]).slice(0, this.max);
    this.voices = iv.map((st, j) => {
      const f = Math.min(this.sr * 0.4, midiToHz(q.note + st + q.tune / 100));
      // stereo: each voice's right channel is detuned by a few cents for width
      const t = combTuning(f, q.decay, damp, this.sr, q.type === 'odd');
      const tR = combTuning(f * Math.pow(2, (q.spread * 6 * (j % 2 ? -1 : 1)) / 1200), q.decay, damp, this.sr, q.type === 'odd');
      return { f, L: t, R: tR, norm: Math.sqrt(1 - t.g * t.g) };
    });
    this.voiceGain = 1 / Math.sqrt(iv.length);
  }
  _comb(line, x, t, damp) {
    const { buf } = line, n = buf.length;
    const rp = line.w - 1 - t.delay; // the newest sample is at w - 1
    const i0 = Math.floor(rp), fr = rp - i0;
    const a = buf[((i0 % n) + n) % n], b = buf[(((i0 + 1) % n) + n) % n];
    const v = a + (b - a) * fr; // linear interpolation: y[n - 1 - delay]
    line.lp = (1 - damp) * v + damp * line.lp;
    const y = x + t.g * line.lp;
    buf[line.w] = y;
    line.w = (line.w + 1) % n;
    return y;
  }
  process(inL, inR, outL, outR, n) {
    const vs = this.voices, vg = this.voiceGain;
    for (let s = 0; s < n; s++) {
      let yl = 0, yr = 0;
      const xl = this.dcL.process(inL[s]), xr = this.dcR.process(inR[s]);
      for (let j = 0; j < vs.length; j++) {
        const v = vs[j];
        yl += this._comb(this.lines[j * 2], xl * v.norm, v.L, v.L.damp);
        yr += this._comb(this.lines[j * 2 + 1], xr * v.norm, v.R, v.R.damp);
      }
      outL[s] = yl * vg; outR[s] = yr * vg;
    }
  }
}

// ------------------------------------------------------------------------------------------- auto-wah
export const WAH_TYPES = ['lowpass', 'bandpass', 'highpass'];

/** Cutoff of the envelope filter for a (linear) envelope level: base · 2^(range · min(1, env · sens)). */
export function wahCutoff(env, base, rangeOct, sens) {
  return base * Math.pow(2, rangeOct * clamp(env * sens, 0, 1));
}

export class AutoWahEngine {
  constructor(sr) {
    this.sr = sr;
    this.fL = new Svf(); this.fR = new Svf();
    this.env = 0;
    this.cnt = 0;
    this.set({});
  }
  /** p: { sens (dB), attack (s), release (s), cutoff (Hz), range (oct), type (index), q } */
  set(p) {
    this.p = {
      sens: Math.pow(10, clamp(p.sens ?? 0, -24, 36) / 20) * 4, attack: clamp(p.attack ?? 0.005, 0.0002, 1), release: clamp(p.release ?? 0.12, 0.005, 3),
      cutoff: clamp(p.cutoff ?? 300, 20, 18000), range: clamp(p.range ?? 3.5, -6, 8), type: WAH_TYPES[clamp(Math.round(p.type ?? 0), 0, 2)], q: clamp(p.q ?? 4, 0.3, 30),
    };
    this.aA = onePoleCoef(this.p.attack, this.sr); this.aR = onePoleCoef(this.p.release, this.sr);
  }
  process(inL, inR, outL, outR, n) {
    const { p, fL, fR, sr } = this;
    const out = p.type === 'lowpass' ? 'lp' : p.type === 'bandpass' ? 'bp' : 'hp';
    const bpGain = p.type === 'bandpass' ? Math.min(2, Math.pow(p.q, 0.3)) : 1; // band-pass peaks at 0 dB: lift it a little
    for (let s = 0; s < n; s++) {
      const xl = inL[s], xr = inR[s];
      const a = Math.max(Math.abs(xl), Math.abs(xr));
      this.env += (a > this.env ? this.aA : this.aR) * (a - this.env);
      if ((this.cnt++ & 7) === 0) { // update the filter every 8 samples (cheap, still smooth)
        const fc = Math.min(sr * 0.45, wahCutoff(this.env, p.cutoff, p.range, p.sens));
        fL.set(fc, p.q, sr); fR.set(fc, p.q, sr);
      }
      fL.process(xl); fR.process(xr);
      outL[s] = fL[out] * bpGain; outR[s] = fR[out] * bpGain;
    }
  }
  get envelope() { return this.env; }
}

// ------------------------------------------------------------------------------------------- waveshaper curves
export const SHAPES_PLUS = ['soft', 'hard', 'tube', 'halfrect', 'fullrect', 'sinefold', 'wavefold', 'fuzz', 'cubic'];

const foldTri = (x) => { // triangle fold into [-1, 1]
  let t = (x + 1) / 4;
  t -= Math.floor(t);
  return 1 - 4 * Math.abs(t - 0.5);
};

/**
 * Transfer function x ∈ [-1, 1] -> y ∈ [-1, 1] for shape at drive k (linear gain ≥ 1), `stages` (wavefold) and
 * `bias` (asymmetry: the curve is evaluated at x + bias and re-centred so silence stays silent).
 */
export function shapeFn(shape, k = 1, { stages = 2, bias = 0 } = {}) {
  let f;
  switch (shape) {
    case 'hard': f = (x) => clamp(x * k, -1, 1); break;
    case 'tube': f = (x) => { const y = x * k; return y >= 0 ? Math.tanh(y) : Math.tanh(1.7 * y) / Math.tanh(1.7) * 0.85; }; break;
    case 'halfrect': f = (x) => Math.max(0, Math.tanh(x * k)); break;
    case 'fullrect': f = (x) => Math.abs(Math.tanh(x * k)); break;
    case 'sinefold': f = (x) => Math.sin((Math.PI / 2) * x * k); break;
    case 'wavefold': f = (x) => {
      let y = x * k;
      for (let s = 0; s < Math.max(1, stages); s++) y = foldTri(y) * (s < stages - 1 ? 1 + 0.35 * k : 1);
      return y;
    }; break;
    case 'fuzz': f = (x) => { const y = x * k * 2; return Math.sign(y) * (1 - Math.exp(-Math.abs(y))); }; break;
    case 'cubic': f = (x) => { const y = clamp(x * k, -1, 1); return 1.5 * y - 0.5 * y * y * y; }; break;
    case 'soft':
    default: f = (x) => Math.tanh(x * k);
  }
  if (!bias) {
    if (shape === 'soft' || shape === 'fuzz') { const m = Math.abs(f(1)) || 1; return (x) => f(x) / m; }
    return f;
  }
  const off = f(bias);
  let m = Math.abs(f(0) - off); // (x = −bias: the kink of the rectifiers)
  for (let i = 0; i <= 2048; i++) m = Math.max(m, Math.abs(f(-1 + i / 1024 + bias) - off));
  m = Math.max(m, 1e-9);
  return (x) => clamp((f(x + bias) - off) / m, -1, 1);
}

/** Sampled curve for a WaveShaperNode. */
export function shapeCurve(shape, k, o = {}, n = 8192) {
  const f = shapeFn(shape, k, o);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = clamp(f((i / (n - 1)) * 2 - 1), -1, 1);
  return c;
}

// ------------------------------------------------------------------------------------------- mid / side
/**
 * 2x2 mid/side matrices (row-major [a, b, c, d]: out0 = a·in0 + b·in1, out1 = c·in0 + d·in1).
 * encode: L/R -> M = (L+R)/2, S = (L−R)/2; decode: M/S -> L = M+S, R = M−S (decode ∘ encode = identity).
 */
export const MS_ENCODE = [0.5, 0.5, 0.5, -0.5];
export const MS_DECODE = [1, 1, 1, -1];
export const matMul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
export const matApply = (M, x0, x1) => [M[0] * x0 + M[1] * x1, M[2] * x0 + M[3] * x1];

/**
 * Matrices of the M/S tool: input -> (M, S) and (M, S) -> output, for mode 'lr' (L/R in and out), 'encode'
 * (L/R in, M/S out) or 'decode' (M/S in, L/R out); mono folds the output to (L+R)/2 on both sides.
 * Gains / solo apply between the two (on M and S): gainM, gainS linear; solo 'off' | 'mid' | 'side'.
 */
export function msPlan({ mode = 'lr', gainM = 1, gainS = 1, solo = 'off', mono = false, swap = false } = {}) {
  const inM = mode === 'decode' ? [1, 0, 0, 1] : MS_ENCODE;
  let outM = mode === 'encode' ? [1, 0, 0, 1] : MS_DECODE;
  if (swap) outM = matMul([0, 1, 1, 0], outM);
  if (mono) outM = matMul([0.5, 0.5, 0.5, 0.5], outM);
  let gm = gainM, gs = gainS;
  if (solo === 'mid') gs = 0;
  if (solo === 'side') gm = 0;
  return { inM, outM, gm, gs };
}

/** Correlation of two equal-length signals (−1 .. +1; 0 for silence). */
export function correlation(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0;
}

/** First comb-filter notch (Hz) when a signal and its copy delayed by `ms` are summed to mono. */
export const haasFirstNotch = (ms) => 1000 / (2 * ms);
