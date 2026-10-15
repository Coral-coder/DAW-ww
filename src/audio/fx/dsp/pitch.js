// Time-domain pitch shifting (two cross-faded taps sweeping a delay line), scale-aware harmony intervals and a
// light YIN-style pitch detector. Pure JS: used by the pitch / formant / shimmer worklets and the Node tests.
import { DelayLine, clamp, semitonesToRatio } from './common.js';

/**
 * Pitch-shifter modes. window: sweep length of each tap (s); search: max re-alignment of a tap when it restarts
 * (s, 0 = none) — 'quality' picks the restart offset with the best waveform correlation against the sounding tap
 * (WSOLA-like), which removes most of the phasing / flanging of plain delay-line shifters.
 */
export const SHIFTER_MODES = {
  low: { window: 0.02, search: 0.004, corr: 0.004 },
  quality: { window: 0.06, search: 0.009, corr: 0.008 },
};

/** Crossfade window of a tap at phase ph ∈ [0, 1): sin²(πph). Two taps half a cycle apart sum to exactly 1. */
export const grainWindow = (ph) => { const s = Math.sin(Math.PI * ph); return s * s; };

/** Base delay (samples) a tap never goes under: room for the re-alignment search and cubic interpolation. */
export const shifterBase = (mode, sr) => Math.ceil((SHIFTER_MODES[mode] || SHIFTER_MODES.low).search * sr) + 3;

/** Average delay of the shifted signal (samples) — the latency reported for PDC. */
export function shifterLatency(mode, sr) {
  const m = SHIFTER_MODES[mode] || SHIFTER_MODES.low;
  return Math.round(shifterBase(mode, sr) + (m.window * sr) / 2);
}

export class PitchShifter {
  /** @param {number} sr  @param {'low'|'quality'} mode */
  constructor(sr, mode = 'low') {
    this.sr = sr;
    this.line = new DelayLine(Math.ceil(sr * 0.2));
    this.ratio = 1;
    this.ph = 0; // phase of tap A; tap B = ph + 0.5
    this.offA = 0; this.offB = 0;
    this.setMode(mode);
  }
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = SHIFTER_MODES[mode] ? mode : 'low';
    const m = SHIFTER_MODES[this.mode];
    this.W = Math.round(m.window * this.sr);
    this.S = Math.round(m.search * this.sr);
    this.C = Math.round(m.corr * this.sr);
    this.D0 = shifterBase(this.mode, this.sr);
    this.offA = this.offB = 0;
  }
  setRatio(r) { this.ratio = clamp(r, 0.125, 8); }
  setSemitones(st) { this.setRatio(semitonesToRatio(st)); }
  get latency() { return Math.round(this.D0 + this.W / 2); }

  /** Re-alignment offset for a tap restarting at nominal delay dNew, matched against the sounding tap at dRef. */
  _align(dNew, dRef) {
    const { S, C, line } = this;
    if (!S || !C) return 0;
    let best = -Infinity, bestOff = 0;
    const score = (off) => {
      const d = Math.round(dNew + off), r = Math.round(dRef);
      let xy = 0, yy = 1e-9;
      for (let k = 0; k < C; k += 2) {
        const a = line.tap(r + k), b = line.tap(d + k);
        xy += a * b; yy += b * b;
      }
      return xy / Math.sqrt(yy);
    };
    for (let off = -S; off <= S; off += 3) {
      const s = score(off);
      if (s > best) { best = s; bestOff = off; }
    }
    for (let off = bestOff - 2; off <= bestOff + 2; off++) {
      if (off < -S || off > S) continue;
      const s = score(off);
      if (s > best) { best = s; bestOff = off; }
    }
    return bestOff;
  }

  /** Feed one sample, return the shifted sample. */
  process(x) {
    const { line, W, D0 } = this;
    line.write(x);
    const r = this.ratio;
    let step = (1 - r) / W;
    if (Math.abs(r - 1) < 1e-6) { // unity: settle on a single tap (two different delays would comb-filter)
      const target = this.ph < 0.25 ? 0 : this.ph < 0.75 ? 0.5 : 1;
      step = clamp(target - this.ph, -0.5 / W, 0.5 / W);
    }
    let pa = this.ph + step;
    if (pa >= 1 || pa < 0) {
      pa -= Math.floor(pa);
      this.offA = this._align(D0 + pa * W, D0 + ((pa + 0.5) % 1) * W + this.offB);
    }
    const pbOld = (this.ph + 0.5) % 1;
    const pb = (pa + 0.5) % 1;
    if (Math.abs(pb - pbOld) > 0.5) this.offB = this._align(D0 + pb * W, D0 + pa * W + this.offA);
    this.ph = pa;
    const da = D0 + pa * W + this.offA, db = D0 + pb * W + this.offB;
    return grainWindow(pa) * line.readCubic(da) + grainWindow(pb) * line.readCubic(db);
  }
}

// ---------------------------------------------------------------------------------------- harmony
/** Scales as semitone sets (from the key). */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11], pentatonic: [0, 2, 4, 7, 9], minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

/**
 * Semitone interval that moves `note` (MIDI, may be fractional) by `steps` scale degrees in key / scale. The input
 * is first snapped to the nearest scale degree (an off-scale note takes the degree below), so a diatonic third above
 * C in C major is 4 semitones and above D it is 3.
 */
export function scaleInterval(note, key, scale, steps) {
  const sc = SCALES[scale] || SCALES.major;
  const n = Math.round(note);
  const rel = ((n - key) % 12 + 12) % 12;
  let deg = 0;
  for (let i = 0; i < sc.length; i++) if (sc[i] <= rel) deg = i;
  const oct = Math.floor((n - key - rel) / 12);
  const s = Math.round(steps);
  const t = deg + s;
  const tOct = Math.floor(t / sc.length), tDeg = ((t % sc.length) + sc.length) % sc.length;
  const target = key + 12 * (oct + tOct) + sc[tDeg];
  return target - n;
}

/**
 * Monophonic pitch detector: YIN difference function on a 4x-decimated window. feed(x) per sample; `hz` holds the
 * last confident estimate (0 when unvoiced). Runs one analysis every `hop` input samples.
 */
export class PitchDetector {
  constructor(sr, { minHz = 60, maxHz = 1000, hop = 512 } = {}) {
    this.sr = sr;
    this.dec = 4;
    this.dsr = sr / this.dec;
    this.N = 512; // decimated window (~46 ms at 44.1 kHz)
    this.buf = new Float32Array(this.N * 2);
    this.w = 0;
    this.acc = 0; this.cnt = 0;
    this.lp1 = 0; this.lp2 = 0;
    this.lpA = 1 - Math.exp((-2 * Math.PI * Math.min(maxHz * 2, this.dsr * 0.4)) / sr);
    this.tauMin = Math.max(2, Math.floor(this.dsr / maxHz));
    this.tauMax = Math.min(this.N - 2, Math.ceil(this.dsr / minHz));
    this.d = new Float32Array(this.tauMax + 2);
    this.hop = hop; this.since = 0;
    this.hz = 0;
    this.confidence = 0;
  }
  feed(x) {
    this.lp1 += this.lpA * (x - this.lp1);
    this.lp2 += this.lpA * (this.lp1 - this.lp2);
    if (++this.cnt >= this.dec) {
      this.cnt = 0;
      this.buf[this.w] = this.lp2; this.buf[this.w + this.N] = this.lp2; // doubled ring: contiguous reads
      this.w = (this.w + 1) % this.N;
    }
    if (++this.since >= this.hop) { this.since = 0; this.analyze(); }
  }
  analyze() {
    const { buf, N, d, tauMin, tauMax } = this;
    const s = this.w; // oldest sample
    const L = N - tauMax;
    let energy = 0;
    for (let i = 0; i < N; i++) energy += buf[s + i] * buf[s + i];
    if (energy / N < 1e-7) { this.hz = 0; this.confidence = 0; return; }
    d[0] = 1;
    let run = 0, best = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < L; i++) { const df = buf[s + i] - buf[s + i + tau]; sum += df * df; }
      run += sum;
      d[tau] = run > 0 ? (sum * tau) / run : 1; // cumulative-mean normalised difference
      if (best < 0 && tau >= tauMin && tau > 2 && d[tau - 1] < 0.15 && d[tau - 1] <= d[tau] && d[tau - 1] <= d[tau - 2]) best = tau - 1;
    }
    if (best < 0) { this.confidence = 0; this.hz = 0; return; }
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const t = best + (den !== 0 ? (0.5 * (a - c)) / den : 0);
    this.hz = this.dsr / t;
    this.confidence = 1 - b;
  }
}
