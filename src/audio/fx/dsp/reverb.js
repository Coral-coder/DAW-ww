// Algorithmic reverb: an 8-line feedback delay network (FDN) with a Hadamard mixing matrix, per-line two-band decay
// filters (Jot), modulated delay lengths, input diffusion, early reflections, freeze and an optional pitch-shifted
// feedback path (shimmer). Pure JS: run by the 'daw3-fx-reverb' worklet processor and the Node tests.
import { DelayLine, Allpass, clamp, decayGain, TAU } from './common.js';
import { PitchShifter } from './pitch.js';

export const FDN_LINES = 8;

/**
 * Space models. lines: delay-line lengths at size 1 (ms); er: early reflections [ms, gain] at size 1 (alternating
 * sides); diff: input-diffusion scale; low / high: T60 multipliers at DC / Nyquist (before damping); mod: modulation
 * depth (ms) at Modulation 100 %; tone: low-pass on the tail (Hz, 0 = none); chirp: dispersive all-pass stages (spring).
 */
export const REVERB_MODES = {
  room: { lines: [9.1, 11.3, 13.7, 16.1, 18.9, 21.4, 24.2, 27.5], er: [[3.1, 0.8], [5.3, 0.7], [7.9, 0.62], [10.4, 0.55], [13.2, 0.48], [16.9, 0.4], [20.3, 0.33], [24.8, 0.27]], diff: 0.9, low: 1, high: 0.75, mod: 0.25, tone: 0, chirp: 0 },
  chamber: { lines: [15, 18.4, 21.8, 25.6, 29.9, 33.7, 38.3, 43.1], er: [[4.6, 0.7], [8.2, 0.62], [12.1, 0.55], [16.4, 0.5], [21.3, 0.44], [26.8, 0.37], [33, 0.3], [40.2, 0.24]], diff: 1, low: 1.05, high: 0.8, mod: 0.35, tone: 0, chirp: 0 },
  hall: { lines: [31, 37.3, 43.9, 51.6, 59.8, 68.2, 77.7, 89.1], er: [[7, 0.6], [11.5, 0.55], [17, 0.5], [23, 0.45], [29.5, 0.4], [37, 0.33], [46, 0.27], [57, 0.22], [68, 0.18]], diff: 1, low: 1.15, high: 0.7, mod: 0.6, tone: 0, chirp: 0 },
  plate: { lines: [9.7, 12.9, 16.6, 19.9, 23.3, 26.9, 30.6, 35.3], er: [], diff: 1.15, low: 1, high: 1, mod: 0.4, tone: 0, chirp: 0, gain: 1.35 },
  spring: { lines: [21, 23.7, 26.2, 29.9, 33.1, 36.4, 39.8, 44], er: [[15.5, 0.35], [31, 0.2]], diff: 0.6, low: 0.95, high: 0.85, mod: 0.2, tone: 4800, chirp: 28, gain: 2 },
};
export const REVERB_MODE_NAMES = Object.keys(REVERB_MODES);

/** Shimmer intervals (semitones; two entries = two shifted voices). */
export const SHIMMER_INTERVALS = [[12], [7], [5], [-12], [19], [24], [12, 7], [12, -12]];
export const SHIMMER_INTERVAL_LABELS = ['+12 (octave)', '+7 (fifth)', '+5 (fourth)', '−12 (octave down)', '+19 (octave + fifth)', '+24 (two octaves)', '+12 & +7', '+12 & −12'];

/** In-place normalised Hadamard transform of an 8-vector (orthogonal: preserves energy). */
export function hadamard8(v) {
  for (let h = 1; h < 8; h <<= 1) {
    for (let i = 0; i < 8; i += h << 1) {
      for (let j = i; j < i + h; j++) { const a = v[j], b = v[j + h]; v[j] = a + b; v[j + h] = a - b; }
    }
  }
  const s = 1 / Math.sqrt(8);
  for (let i = 0; i < 8; i++) v[i] *= s;
  return v;
}

const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
/** Nearest prime ≥ n (mutually prime line lengths avoid coinciding echoes). */
export function primeAtLeast(n) { let k = Math.max(2, Math.round(n)); while (!isPrime(k)) k++; return k; }

/** Size (0..1) -> length scale of the model's lines and reflections. */
export const sizeScale = (size) => 0.45 + 1.1 * clamp(size, 0, 1);

/** Line lengths (samples) for mode / size. */
export function lineLengths(mode, size, sr) {
  const m = REVERB_MODES[mode] || REVERB_MODES.hall;
  const s = sizeScale(size);
  const out = m.lines.map((ms) => primeAtLeast((ms * s * sr) / 1000));
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) out[i] = primeAtLeast(out[i - 1] + 1);
  return out;
}

/**
 * Two-band decay filter of one line (Jot): y = c·x + a·y[n-1] with DC gain gLow and Nyquist gain gHigh, the
 * per-pass gains that give T60 tLow / tHigh for a loop of `len` samples.
 */
export function dampingFilter(len, tLow, tHigh, sr) {
  const g0 = decayGain(len, tLow, sr), gp = decayGain(len, tHigh, sr);
  const a = g0 + gp > 0 ? (g0 - gp) / (g0 + gp) : 0;
  return { a, c: g0 * (1 - a), g0, gp };
}

export class FdnReverb {
  /** @param {number} sr  @param {{shimmer?:boolean}} o */
  constructor(sr, o = {}) {
    this.sr = sr;
    const maxLen = Math.ceil((89.1 * 1.6 * sr) / 1000) + Math.ceil(0.002 * sr) + 8;
    this.lines = Array.from({ length: FDN_LINES }, () => new DelayLine(maxLen));
    this.len = new Float64Array(FDN_LINES); // current (slewed) lengths
    this.target = new Float64Array(FDN_LINES);
    this.fa = new Float64Array(FDN_LINES); this.fc = new Float64Array(FDN_LINES);
    this.fy = new Float64Array(FDN_LINES); // filter states
    this.v = new Float64Array(FDN_LINES);
    this.modPh = Float64Array.from({ length: FDN_LINES }, (_, i) => (i * 0.137) % 1);
    this.modInc = Float64Array.from({ length: FDN_LINES }, (_, i) => (0.37 + 0.11 * i + 0.013 * i * i) / sr);
    this.pre = new DelayLine(Math.ceil(sr * 0.5) + 4);
    this.preR = new DelayLine(Math.ceil(sr * 0.5) + 4);
    this.erLine = new DelayLine(Math.ceil(sr * 0.2) + 4);
    this.erLineR = new DelayLine(Math.ceil(sr * 0.2) + 4);
    const apMs = [4.77, 3.59, 12.73, 9.3], apMsR = [4.97, 3.83, 11.9, 8.71];
    this.diffL = apMs.map((ms) => new Allpass(Math.round((ms * sr) / 1000)));
    this.diffR = apMsR.map((ms) => new Allpass(Math.round((ms * sr) / 1000)));
    this.chirpL = []; this.chirpR = [];
    for (let i = 0; i < 32; i++) { this.chirpL.push({ x1: 0, y1: 0 }); this.chirpR.push({ x1: 0, y1: 0 }); }
    this.toneL = 0; this.toneR = 0;
    this.er = { tapsL: [], tapsR: [] };
    this.p = {};
    this.key = '';
    if (o.shimmer) {
      this.shim = [new PitchShifter(sr, 'quality'), new PitchShifter(sr, 'quality')];
      this.shimLp = 0; this.shimHp = 0; this.shimOut = 0;
    }
    this.set({});
    this.len.set(this.target);
  }

  /**
   * p: { mode (index or name), size, decay (s), predelay (s), diffusion, damping, mod, balance (0 early .. 1 late),
   *      freeze (0/1), width, shimmer, interval (index), tone (Hz, shimmer loop low-pass) }
   */
  set(p) {
    const mode = typeof p.mode === 'number' ? REVERB_MODE_NAMES[clamp(Math.round(p.mode), 0, REVERB_MODE_NAMES.length - 1)] : (REVERB_MODES[p.mode] ? p.mode : 'hall');
    const q = {
      mode, size: clamp(p.size ?? 0.6, 0, 1), decay: clamp(p.decay ?? 2.5, 0.1, 60), predelay: clamp(p.predelay ?? 0.02, 0, 0.5),
      diffusion: clamp(p.diffusion ?? 0.7, 0, 1), damping: clamp(p.damping ?? 0.4, 0, 1), mod: clamp(p.mod ?? 0.3, 0, 1),
      balance: clamp(p.balance ?? 0.5, 0, 1), freeze: (p.freeze ?? 0) >= 0.5, width: clamp(p.width ?? 1, 0, 2),
      shimmer: clamp(p.shimmer ?? 0, 0, 1), interval: clamp(Math.round(p.interval ?? 0), 0, SHIMMER_INTERVALS.length - 1), tone: clamp(p.tone ?? 6000, 200, 20000),
    };
    this.p = q;
    const key = `${q.mode}|${q.size}|${q.decay}|${q.damping}|${q.freeze}|${q.diffusion}|${q.mod}`;
    if (key === this.key) return;
    this.key = key;
    const m = REVERB_MODES[mode];
    this.m = m;
    const sr = this.sr;
    const lens = lineLengths(mode, q.size, sr);
    this.modDepth = (m.mod * sr) / 1000;
    for (let i = 0; i < FDN_LINES; i++) {
      this.target[i] = lens[i];
      const eff = lens[i] + this.modDepth * q.mod + 1; // average loop length incl. the modulation centre and the matrix
      const tLow = q.decay * m.low, tHigh = Math.max(0.05, q.decay * m.high * (1 - 0.9 * q.damping));
      const f = q.freeze ? { a: 0, c: 1 } : dampingFilter(eff, tLow, tHigh, sr);
      this.fa[i] = f.a; this.fc[i] = f.c;
    }
    const s = sizeScale(q.size);
    this.er.tapsL = []; this.er.tapsR = [];
    m.er.forEach(([ms, g], j) => {
      const dl = Math.min(this.erLine.size - 4, Math.round((ms * s * sr) / 1000));
      const dr = Math.min(this.erLine.size - 4, Math.round((ms * 1.07 * s * sr) / 1000));
      (j % 2 ? this.er.tapsR : this.er.tapsL).push([dl, g * (j % 4 < 2 ? 1 : -1)]);
      (j % 2 ? this.er.tapsL : this.er.tapsR).push([dr, g * 0.55]);
    });
    const dg = clamp(q.diffusion * m.diff, 0, 1.1);
    const gs = [0.75, 0.75, 0.625, 0.625];
    for (let i = 0; i < 4; i++) { this.diffL[i].g = gs[i] * dg; this.diffR[i].g = gs[i] * dg; }
    this.chirpA = m.chirp ? 0.62 : 0;
    this.toneA = m.tone ? 1 - Math.exp((-TAU * m.tone) / sr) : 0;
    // late level: long, dense tails pile up energy — keep the wet level roughly constant across decay times
    this.lateGain = (0.55 * (m.gain || 1)) / Math.sqrt(1 + 0.35 * q.decay * m.low);
    this.erGain = m.er.length ? 0.6 / Math.sqrt(m.er.length / 4) : 0;
  }

  _chirp(st, x) {
    const a = this.chirpA;
    for (let i = 0; i < 32; i++) {
      const s = st[i];
      const y = a * x + s.x1 - a * s.y1;
      s.x1 = x; s.y1 = y; x = y;
    }
    return x;
  }

  /** Process n frames (stereo in / out; arrays may alias for mono input). */
  process(inL, inR, outL, outR, n) {
    const { lines, len, target, fa, fc, fy, v, modPh, modInc, p, sr } = this;
    const freeze = p.freeze;
    const preD = Math.max(0, Math.round(p.predelay * sr));
    const early = Math.min(1, 2 * (1 - p.balance)) * this.erGain, late = Math.min(1, 2 * p.balance) * this.lateGain;
    const wid = p.width * 0.5;
    const modD = this.modDepth * p.mod;
    const shim = this.shim && !freeze ? p.shimmer : 0;
    const shimA = this.shim ? 1 - Math.exp((-TAU * p.tone) / sr) : 0;
    const shimHpA = 1 - Math.exp((-TAU * 120) / sr);
    if (this.shim) {
      const iv = SHIMMER_INTERVALS[p.interval];
      this.shim[0].setSemitones(iv[0]);
      this.shim[1].setSemitones(iv[1] ?? iv[0]);
      this.shimVoices = iv.length;
    }
    for (let s = 0; s < n; s++) {
      const xl = freeze ? 0 : inL[s], xr = freeze ? 0 : inR[s];
      this.pre.write(xl); this.preR.write(xr);
      const pl = this.pre.tap(preD), pr = this.preR.tap(preD);
      // early reflections
      this.erLine.write(pl); this.erLineR.write(pr);
      let el = 0, er = 0;
      for (const [d, g] of this.er.tapsL) el += this.erLine.tap(d) * g;
      for (const [d, g] of this.er.tapsR) er += this.erLineR.tap(d) * g;
      // input diffusion (+ spring dispersion)
      let dl = pl, dr = pr;
      for (let i = 0; i < 4; i++) { dl = this.diffL[i].process(dl); dr = this.diffR[i].process(dr); }
      if (this.chirpA) { dl = this._chirp(this.chirpL, dl); dr = this._chirp(this.chirpR, dr); }
      // shimmer: pitch-shifted tail fed back into the tank
      if (shim > 0) {
        let sv = this.shim[0].process(this.shimOut);
        if (this.shimVoices > 1) sv = 0.6 * (sv + this.shim[1].process(this.shimOut));
        this.shimLp += shimA * (sv - this.shimLp);
        this.shimHp += shimHpA * (this.shimLp - this.shimHp);
        const fb = Math.tanh((this.shimLp - this.shimHp) * 1.2) * 0.5 * shim;
        dl += fb; dr += fb;
      }
      // read lines (modulated), decay filters
      for (let i = 0; i < FDN_LINES; i++) {
        if (len[i] !== target[i]) len[i] += clamp(target[i] - len[i], -0.0625, 0.0625);
        modPh[i] += modInc[i];
        if (modPh[i] >= 1) modPh[i] -= 1;
        const d = len[i] + modD * (1 + Math.sin(TAU * modPh[i]));
        const x = lines[i].readCubic(d);
        fy[i] = fc[i] * x + fa[i] * fy[i];
        v[i] = fy[i];
      }
      // stereo taps from the filtered line outputs (orthogonal sign patterns)
      const tl = v[0] + v[2] + v[4] + v[6] - v[1] * 0.5 + v[3] * 0.5 - v[5] * 0.5 + v[7] * 0.5;
      const tr = v[1] + v[3] + v[5] + v[7] + v[0] * 0.5 - v[2] * 0.5 + v[4] * 0.5 - v[6] * 0.5;
      hadamard8(v);
      const inj = 0.5;
      for (let i = 0; i < FDN_LINES; i++) {
        const src = i & 1 ? dr : dl;
        lines[i].write(v[i] + (i & 2 ? -src : src) * inj);
      }
      let yl = tl * late + el * early, yr = tr * late + er * early;
      if (this.toneA) { this.toneL += this.toneA * (yl - this.toneL); this.toneR += this.toneA * (yr - this.toneR); yl = this.toneL; yr = this.toneR; }
      if (this.shim) this.shimOut = (tl + tr) * 0.5 * 0.7;
      const mid = (yl + yr) * 0.5, side = (yl - yr) * wid;
      outL[s] = mid + side;
      outR[s] = mid - side;
    }
  }
}
