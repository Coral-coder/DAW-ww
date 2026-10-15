// Pitch & voice engines: harmonizer (up to 3 shifted voices, chromatic or scale-aware, optional formant
// preservation), formant shifter (LPC envelope re-synthesis) and channel vocoder. Pure JS (worklets + Node tests).
import { Biquad, clamp, dbToGain, midiToHz, hzToMidi, semitonesToRatio, makeRng, CHORDS, CHORD_NAMES, onePoleCoef } from './common.js';
import { PitchShifter, PitchDetector, scaleInterval, SCALES, shifterLatency } from './pitch.js';
import { EnvelopeTracker, LatticeAnalysis, LatticeSynthesis } from './lpc.js';

export const SCALE_NAMES = Object.keys(SCALES);
export const PRE_EMPH = 0.9;

/** Ring of per-hop reflection-coefficient frames: coefficients from `back` hops ago, interpolated across the hop. */
class KHistory {
  constructor(p, depth) {
    this.p = p; this.depth = Math.max(2, depth);
    this.k = Array.from({ length: this.depth }, () => new Float64Array(p + 1));
    this.g = new Float64Array(this.depth).fill(1);
    this.i = 0;
  }
  push(k, g = 1) { this.i = (this.i + 1) % this.depth; this.k[this.i].set(k); this.g[this.i] = g; }
  /** Interpolated frame `back` hops behind the newest, t ∈ [0,1) through the hop; writes into out, returns gain. */
  at(back, t, out) {
    const d = this.depth;
    const b = Math.min(back, d - 2);
    const ia = (this.i - b - 1 + d * 2) % d, ib = (this.i - b + d * 2) % d;
    const ka = this.k[ia], kb = this.k[ib];
    for (let j = 1; j <= this.p; j++) out[j] = ka[j] + (kb[j] - ka[j]) * t;
    return this.g[ia] + (this.g[ib] - this.g[ia]) * t;
  }
}

// ------------------------------------------------------------------------------------------- harmonizer
/**
 * Harmonizer: voice 1 (stereo) is shifted by semis + cents; voices 2 and 3 (mono, panned) by their intervals —
 * semitones, or scale degrees in key / scale when `scaleMode` is on (the input pitch is tracked). With `formant` on
 * the LPC excitation is shifted and re-synthesised through the (latency-aligned) envelope of the input.
 */
export class HarmonizerEngine {
  constructor(sr) {
    this.sr = sr;
    this.mode = 'low';
    this._build();
    this.det = new PitchDetector(sr, { hop: 512 });
    this.tracker = new EnvelopeTracker(sr, { hop: 256 });
    const p = this.tracker.p;
    this.anaL = new LatticeAnalysis(p); this.anaR = new LatticeAnalysis(p);
    this.syn = [0, 1, 2, 3].map(() => new LatticeSynthesis(p));
    this.kh = new KHistory(p, Math.ceil((0.08 * sr) / 256) + 3);
    this.kNow = new Float64Array(p + 1); this.kDel = new Float64Array(p + 1);
    this.hopPos = 0;
    this.pe = [0, 0]; this.de = [0, 0, 0, 0];
    this.st = [0, 0, 0]; // smoothed semitone shifts per voice
    this.note = 60;
    this.glide = onePoleCoef(0.03, sr);
    this.p = {};
    this.set({});
  }
  _build() {
    this.v1L = new PitchShifter(this.sr, this.mode); this.v1R = new PitchShifter(this.sr, this.mode);
    this.v2 = new PitchShifter(this.sr, this.mode); this.v3 = new PitchShifter(this.sr, this.mode);
  }
  get latency() { return shifterLatency(this.mode, this.sr); }
  /** p: { semis, cents, quality (0/1), formant (0/1), level1, v2On, v2Int, v2Level, v2Pan, v3On, v3Int, v3Level, v3Pan,
   *       scaleMode (0/1), key (0..11), scale (index) } */
  set(p) {
    const mode = (p.quality ?? 0) >= 0.5 ? 'quality' : 'low';
    if (mode !== this.mode) { this.mode = mode; for (const s of [this.v1L, this.v1R, this.v2, this.v3]) s.setMode(mode); }
    this.p = {
      semis: clamp(p.semis ?? 0, -24, 24), cents: clamp(p.cents ?? 0, -100, 100), formant: (p.formant ?? 0) >= 0.5,
      level1: clamp(p.level1 ?? 1, 0, 2),
      v2On: (p.v2On ?? 0) >= 0.5, v2Int: p.v2Int ?? 4, v2Level: clamp(p.v2Level ?? 0.7, 0, 2), v2Pan: clamp(p.v2Pan ?? -0.5, -1, 1),
      v3On: (p.v3On ?? 0) >= 0.5, v3Int: p.v3Int ?? 7, v3Level: clamp(p.v3Level ?? 0.7, 0, 2), v3Pan: clamp(p.v3Pan ?? 0.5, -1, 1),
      scaleMode: (p.scaleMode ?? 0) >= 0.5, key: ((Math.round(p.key ?? 0) % 12) + 12) % 12, scale: SCALE_NAMES[clamp(Math.round(p.scale ?? 0), 0, SCALE_NAMES.length - 1)],
    };
  }
  /** Target semitone shifts [v1, v2, v3] for the current tracked note. */
  targets() {
    const q = this.p;
    const t1 = q.semis + q.cents / 100;
    if (!q.scaleMode) return [t1, q.v2Int, q.v3Int];
    return [t1, scaleInterval(this.note, q.key, q.scale, q.v2Int), scaleInterval(this.note, q.key, q.scale, q.v3Int)];
  }
  process(inL, inR, outL, outR, n) {
    const q = this.p;
    const tr = this.tracker, kh = this.kh, hop = tr.hop;
    const back = Math.round(this.latency / hop);
    const fm = q.formant;
    const panL = (pn) => Math.cos(((pn + 1) * Math.PI) / 4), panR = (pn) => Math.sin(((pn + 1) * Math.PI) / 4);
    const g2L = q.v2On ? q.v2Level * panL(q.v2Pan) * Math.SQRT2 : 0, g2R = q.v2On ? q.v2Level * panR(q.v2Pan) * Math.SQRT2 : 0;
    const g3L = q.v3On ? q.v3Level * panL(q.v3Pan) * Math.SQRT2 : 0, g3R = q.v3On ? q.v3Level * panR(q.v3Pan) * Math.SQRT2 : 0;
    let tg = this.targets();
    for (let s = 0; s < n; s++) {
      const xl = inL[s], xr = inR[s];
      const mono = 0.5 * (xl + xr);
      if (q.scaleMode) {
        this.det.feed(mono);
        if (this.det.since === 0 && this.det.hz > 0 && this.det.confidence > 0.8) { this.note = hzToMidi(this.det.hz); tg = this.targets(); }
      }
      for (let v = 0; v < 3; v++) this.st[v] += this.glide * (tg[v] - this.st[v]);
      this.v1L.setSemitones(this.st[0]); this.v1R.setSemitones(this.st[0]);
      this.v2.setSemitones(this.st[1]); this.v3.setSemitones(this.st[2]);
      let el = xl, er = xr, gain = 1;
      if (fm) {
        // pre-emphasis, envelope tracking on the mono sum, excitation per channel
        const pl = xl - PRE_EMPH * this.pe[0], pr = xr - PRE_EMPH * this.pe[1];
        this.pe[0] = xl; this.pe[1] = xr;
        tr.push(0.5 * (pl + pr));
        if (++this.hopPos >= hop) { this.hopPos = 0; kh.push(tr.analyze(1).k); }
        const t = this.hopPos / hop;
        kh.at(0, t, this.kNow);
        gain = kh.at(back, t, this.kDel);
        el = this.anaL.process(pl, this.kNow); er = this.anaR.process(pr, this.kNow);
      }
      let y1l = this.v1L.process(el), y1r = this.v1R.process(er);
      const em = 0.5 * (el + er);
      let y2 = q.v2On ? this.v2.process(em) : 0, y3 = q.v3On ? this.v3.process(em) : 0;
      if (fm) {
        const syn = (i, e) => { const y = this.syn[i].process(e * gain, this.kDel) + PRE_EMPH * this.de[i]; this.de[i] = y; return y; };
        y1l = syn(0, y1l); y1r = syn(1, y1r);
        if (q.v2On) y2 = syn(2, y2);
        if (q.v3On) y3 = syn(3, y3);
      }
      outL[s] = y1l * q.level1 + y2 * g2L + y3 * g3L;
      outR[s] = y1r * q.level1 + y2 * g2R + y3 * g3R;
    }
  }
}

// ------------------------------------------------------------------------------------------- formant shifter
/**
 * Formant shifter: the input's LPC excitation is re-synthesised through the envelope of the same frame time-scaled
 * by 2^(shift/12) — formants move, the pitch stays. Optional pitch shift of the excitation (formants stay put).
 */
export class FormantEngine {
  constructor(sr) {
    this.sr = sr;
    this.tracker = new EnvelopeTracker(sr, { hop: 256 });
    const p = this.tracker.p;
    this.anaL = new LatticeAnalysis(p); this.anaR = new LatticeAnalysis(p);
    this.synL = new LatticeSynthesis(p); this.synR = new LatticeSynthesis(p);
    this.khX = new KHistory(p, Math.ceil((0.05 * sr) / 256) + 3);
    this.khR = new KHistory(p, Math.ceil((0.05 * sr) / 256) + 3);
    this.kx = new Float64Array(p + 1); this.kr = new Float64Array(p + 1);
    this.shL = new PitchShifter(sr, 'low'); this.shR = new PitchShifter(sr, 'low');
    this.hopPos = 0;
    this.pe = [0, 0]; this.de = [0, 0];
    this.p = { shift: 0, pitch: 0 };
  }
  get latency() { return Math.abs(this.p.pitch) > 0.001 ? this.shL.latency : 0; }
  /** p: { shift (st, formants), pitch (st) } */
  set(p) { this.p = { shift: clamp(p.shift ?? 0, -24, 24), pitch: clamp(p.pitch ?? 0, -24, 24) }; }
  process(inL, inR, outL, outR, n) {
    const tr = this.tracker, hop = tr.hop;
    const warp = semitonesToRatio(clamp(this.p.shift, -12, 12) * 1);
    const pitched = Math.abs(this.p.pitch) > 0.001;
    if (pitched) { this.shL.setSemitones(this.p.pitch); this.shR.setSemitones(this.p.pitch); }
    const back = pitched ? Math.round(this.shL.latency / hop) : 0;
    for (let s = 0; s < n; s++) {
      const xl = inL[s], xr = inR[s];
      const pl = xl - PRE_EMPH * this.pe[0], pr = xr - PRE_EMPH * this.pe[1];
      this.pe[0] = xl; this.pe[1] = xr;
      tr.push(0.5 * (pl + pr));
      if (++this.hopPos >= hop) {
        this.hopPos = 0;
        const a = tr.analyze(1);
        const ex = a.err, rx = a.r0;
        this.khX.push(a.k, 1);
        const b = tr.analyze(warp);
        // excitation power ex drives an envelope whose own prediction gain is r0/err: match the frame power
        const g = ex > 1e-12 && b.err > 1e-12 ? Math.sqrt((b.err / ex) * (rx / Math.max(1e-12, b.r0))) : 1;
        this.khR.push(b.k, clamp(g, 0.1, 8));
      }
      const t = this.hopPos / hop;
      this.khX.at(0, t, this.kx);
      const g = this.khR.at(back, t, this.kr);
      let el = this.anaL.process(pl, this.kx), er = this.anaR.process(pr, this.kx);
      if (pitched) { el = this.shL.process(el); er = this.shR.process(er); }
      let yl = this.synL.process(el * g, this.kr) + PRE_EMPH * this.de[0];
      let yr = this.synR.process(er * g, this.kr) + PRE_EMPH * this.de[1];
      this.de[0] = yl; this.de[1] = yr;
      outL[s] = yl; outR[s] = yr;
    }
  }
}

// ------------------------------------------------------------------------------------------- vocoder
/**
 * Vocoder band layout: n centres spaced geometrically from lo to hi, each band one spacing wide (× bw).
 * Returns { freqs, q, octaves } (q of each 2nd-order section; the bands use two in series).
 */
export function bandLayout(n, lo, hi, bw = 1) {
  n = Math.max(2, Math.round(n));
  const oct = Math.log2(hi / lo) / (n - 1);
  const freqs = Array.from({ length: n }, (_, i) => lo * Math.pow(2, oct * i));
  const b = Math.max(0.05, oct * bw) * 1.5; // two sections in series narrow the band: widen each one
  const q = Math.sqrt(Math.pow(2, b)) / (Math.pow(2, b) - 1);
  return { freqs, q, octaves: oct };
}

export const VOCODER_WAVES = ['saw', 'pulse', 'supersaw', 'noise'];

/** PolyBLEP residual for band-limited saw / pulse edges. */
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

export class VocoderEngine {
  constructor(sr) {
    this.sr = sr;
    this.rng = makeRng(777);
    this.max = 32;
    this.modF = Array.from({ length: this.max }, () => [new Biquad(), new Biquad()]);
    this.carF = Array.from({ length: this.max }, () => [new Biquad(), new Biquad()]);
    this.env = new Float64Array(this.max); this.cenv = new Float64Array(this.max);
    this.gl = new Float64Array(this.max); this.gr = new Float64Array(this.max);
    this.sib = [new Biquad(), new Biquad()];
    this.emph = new Biquad();
    this.osc = new Float64Array(16); // phases
    this.key = '';
    this.p = {};
    this.set({});
  }
  /** p: { bands, lo, hi, bw, attack (s), release (s), formant (st), carrier (0 internal / 1 sidechain), wave (index),
   *       note (MIDI), chord (index), detune (cents), noise (0..1), sibilance (0..1), spread (0..1), emphasis (0..1),
   *       output (dB) } */
  set(p) {
    const q = {
      bands: clamp(Math.round(p.bands ?? 16), 4, this.max), lo: clamp(p.lo ?? 100, 20, 2000), hi: clamp(p.hi ?? 8000, 500, 18000),
      bw: clamp(p.bw ?? 1, 0.25, 4), attack: clamp(p.attack ?? 0.005, 0.0005, 1), release: clamp(p.release ?? 0.05, 0.002, 3),
      formant: clamp(p.formant ?? 0, -12, 12), carrier: (p.carrier ?? 0) >= 0.5 ? 1 : 0,
      wave: VOCODER_WAVES[clamp(Math.round(p.wave ?? 0), 0, VOCODER_WAVES.length - 1)], note: clamp(p.note ?? 48, 12, 108),
      chord: CHORD_NAMES[clamp(Math.round(p.chord ?? 0), 0, CHORD_NAMES.length - 1)], detune: clamp(p.detune ?? 8, 0, 50),
      noise: clamp(p.noise ?? 0.05, 0, 1), sibilance: clamp(p.sibilance ?? 0.3, 0, 1), spread: clamp(p.spread ?? 0.5, 0, 1),
      emphasis: clamp(p.emphasis ?? 0.4, 0, 1), output: clamp(p.output ?? 0, -24, 24),
    };
    if (q.hi < q.lo * 2) q.hi = q.lo * 2;
    this.p = q;
    const key = `${q.bands}|${q.lo}|${q.hi}|${q.bw}|${q.formant}|${q.spread}|${q.emphasis}`;
    if (key !== this.key) {
      this.key = key;
      const { sr } = this;
      const L = bandLayout(q.bands, q.lo, q.hi, q.bw);
      this.layout = L;
      const sh = semitonesToRatio(q.formant);
      for (let i = 0; i < q.bands; i++) {
        const f = L.freqs[i];
        for (const b of this.modF[i]) b.bandpass(f, L.q, sr);
        for (const b of this.carF[i]) b.bandpass(Math.min(sr * 0.45, f * sh), L.q, sr);
        const pan = (i % 2 ? 1 : -1) * q.spread * 0.8;
        this.gl[i] = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
        this.gr[i] = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      }
      this.sib[0].highpass(5000, 0.7, sr); this.sib[1].highpass(5000, 0.7, sr);
      this.emph.highpass(1500, 0.6, sr);
    }
    this.aA = onePoleCoef(q.attack, this.sr); this.aR = onePoleCoef(q.release, this.sr);
    this.cA = onePoleCoef(0.004, this.sr); this.cR = onePoleCoef(0.08, this.sr);
    const notes = (CHORDS[q.chord] || [0]).map((iv) => q.note + iv);
    this.freqs = [];
    notes.forEach((nn, j) => {
      const det = q.wave === 'supersaw' ? [-q.detune, 0, q.detune] : [(j % 2 ? 1 : -1) * q.detune * 0.25];
      for (const c of det) this.freqs.push(midiToHz(nn + c / 100));
    });
    this.oscNorm = 1 / Math.sqrt(this.freqs.length);
  }
  _carrier() {
    const q = this.p, sr = this.sr;
    if (q.wave === 'noise') return this.rng() * 2 - 1;
    let y = 0;
    for (let i = 0; i < this.freqs.length; i++) {
      const dt = this.freqs[i] / sr;
      let t = this.osc[i] + dt;
      if (t >= 1) t -= 1;
      this.osc[i] = t;
      if (q.wave === 'pulse') {
        const pw = 0.35;
        let v = t < pw ? 1 : -1;
        v += blep(t, dt);
        v -= blep((t - pw + 1) % 1, dt);
        y += v;
      } else y += 2 * t - 1 - blep(t, dt);
    }
    return y * this.oscNorm;
  }
  /** key: sidechain carrier (stereo arrays, may be null). */
  process(inL, inR, outL, outR, n, keyL = null, keyR = null) {
    const q = this.p, nb = q.bands;
    const { modF, carF, env, cenv, gl, gr } = this;
    const outG = dbToGain(q.output) * 1.5;
    for (let s = 0; s < n; s++) {
      let m = 0.5 * (inL[s] + inR[s]);
      m += q.emphasis * 1.5 * this.emph.process(m);
      let c = q.carrier && keyL ? 0.5 * (keyL[s] + (keyR || keyL)[s]) : this._carrier();
      c = c * (1 - q.noise) + (this.rng() * 2 - 1) * q.noise * 0.7;
      let yl = 0, yr = 0;
      for (let i = 0; i < nb; i++) {
        const mb = modF[i][1].process(modF[i][0].process(m));
        const am = Math.abs(mb);
        env[i] += (am > env[i] ? this.aA : this.aR) * (am - env[i]);
        const cb = carF[i][1].process(carF[i][0].process(c));
        const ac = Math.abs(cb);
        cenv[i] += (ac > cenv[i] ? this.cA : this.cR) * (ac - cenv[i]);
        // carrier band flattened to unit level, then shaped by the modulator band's envelope
        const v = (cb / Math.max(cenv[i], 1e-3)) * env[i];
        yl += v * gl[i]; yr += v * gr[i];
      }
      const sib = q.sibilance > 0 ? this.sib[1].process(this.sib[0].process(m)) * q.sibilance * 1.5 : 0;
      outL[s] = (yl * 0.7 + sib) * outG;
      outR[s] = (yr * 0.7 + sib) * outG;
    }
  }
}
