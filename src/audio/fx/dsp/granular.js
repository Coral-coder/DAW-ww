// Granular delay / cloud: the input is written into a stereo ring buffer; grains (windowed, optionally pitched or
// reversed snippets) are read from `time` seconds back (± spread) at `density` grains per second. Feedback writes the
// cloud back into the buffer; freeze stops writing so the cloud keeps playing the captured audio.
import { clamp, makeRng, semitonesToRatio } from './common.js';

export const GRAIN_WINDOWS = ['hann', 'tukey', 'triangle'];

/** Grain envelope at position t ∈ [0, 1]. hann: smooth; tukey: flat top with 25 % cosine edges; triangle. */
export function grainEnvelope(t, shape = 'hann') {
  if (t <= 0 || t >= 1) return 0;
  if (shape === 'triangle') return 1 - Math.abs(2 * t - 1);
  if (shape === 'tukey') {
    const e = 0.25;
    if (t < e) return 0.5 - 0.5 * Math.cos((Math.PI * t) / e);
    if (t > 1 - e) return 0.5 - 0.5 * Math.cos((Math.PI * (1 - t)) / e);
    return 1;
  }
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
}

/** Smallest delay (samples) for which a grain of `len` samples at pitch ratio r never reads past the write head. */
export const minGrainDelay = (len, ratio) => Math.max(0, (ratio - 1) * len) + 4;

const MAX_GRAINS = 64;

export class GrainCloud {
  constructor(sr, seed = 12345) {
    this.sr = sr;
    let n = 1 << 16;
    while (n < sr * 8) n <<= 1;
    this.N = n; this.mask = n - 1;
    this.bufL = new Float32Array(n); this.bufR = new Float32Array(n);
    this.w = 0;
    this.rng = makeRng(seed);
    this.grains = Array.from({ length: MAX_GRAINS }, () => ({ on: false, pos: 0, inc: 1, age: 0, len: 1, gl: 0, gr: 0 }));
    this.next = 0; // samples until the next grain
    this.fbL = 0; this.fbR = 0;
    this.lpL = 0; this.lpR = 0;
    this.p = { time: 0.25, size: 0.08, density: 20, pitch: 0, pitchRand: 0, spread: 0.3, pan: 0.6, reverse: 0, feedback: 0.3, freeze: false, window: 'hann', tone: 12000 };
  }
  /** p: { time (s), size (s), density (grains/s), pitch (st), pitchRand (st), spread (0..1), pan (0..1), reverse (0..1),
   *       feedback (0..0.95), freeze (0/1), window (index), tone (Hz) } */
  set(p) {
    const q = this.p;
    q.time = clamp(p.time ?? q.time, 0.001, (this.N / this.sr) * 0.45);
    q.size = clamp(p.size ?? q.size, 0.005, 1);
    q.density = clamp(p.density ?? q.density, 0.2, 200);
    q.pitch = clamp(p.pitch ?? q.pitch, -24, 24);
    q.pitchRand = clamp(p.pitchRand ?? q.pitchRand, 0, 24);
    q.spread = clamp(p.spread ?? q.spread, 0, 1);
    q.pan = clamp(p.pan ?? q.pan, 0, 1);
    q.reverse = clamp(p.reverse ?? q.reverse, 0, 1);
    q.feedback = clamp(p.feedback ?? q.feedback, 0, 0.95);
    q.freeze = (p.freeze ?? 0) >= 0.5;
    q.window = GRAIN_WINDOWS[clamp(Math.round(p.window ?? 0), 0, GRAIN_WINDOWS.length - 1)];
    q.tone = clamp(p.tone ?? q.tone, 200, 20000);
  }
  _spawn() {
    const { p, rng, sr } = this;
    const g = this.grains.find((x) => !x.on);
    if (!g) return;
    const len = Math.max(16, Math.round(p.size * sr * (0.85 + 0.3 * rng())));
    let st = p.pitch + (rng() * 2 - 1) * p.pitchRand;
    if (p.pitchRand >= 1) st = Math.round(st); // wide random pitch: stay on semitones
    const ratio = semitonesToRatio(st);
    const rev = rng() < p.reverse;
    let delay = p.time * sr * (1 + (rng() * 2 - 1) * p.spread * 0.9);
    // a reversed grain starts at its end; while frozen the write head stands still
    if (rev || p.freeze) delay = Math.max(delay, ratio * len + 4);
    else delay = Math.max(delay, minGrainDelay(len, ratio));
    delay = Math.min(delay, this.N - len * Math.max(1, ratio) - 8);
    g.on = true; g.age = 0; g.len = len;
    g.pos = this.w - delay;
    g.inc = rev ? -ratio : ratio;
    const pan = (rng() * 2 - 1) * p.pan;
    g.gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2;
    g.gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
  }
  _read(buf, pos) {
    const i = Math.floor(pos), f = pos - i, m = this.mask;
    const a = buf[i & m], b = buf[(i + 1) & m];
    return a + (b - a) * f;
  }
  process(inL, inR, outL, outR, n) {
    const { p, sr, grains } = this;
    const period = sr / p.density;
    // grain overlap -> loudness: keep the cloud level independent of density x size
    const norm = 1 / Math.sqrt(Math.max(1, p.density * p.size * 0.6));
    const toneA = 1 - Math.exp((-2 * Math.PI * p.tone) / sr);
    const fb = p.feedback;
    const win = p.window;
    for (let s = 0; s < n; s++) {
      if (!p.freeze) {
        this.bufL[this.w & this.mask] = inL[s] + fb * this.fbL;
        this.bufR[this.w & this.mask] = inR[s] + fb * this.fbR;
        this.w++;
      }
      if (--this.next <= 0) {
        this._spawn();
        this.next = Math.max(1, Math.round(period * (0.75 + 0.5 * this.rng())));
      }
      let yl = 0, yr = 0;
      for (let i = 0; i < MAX_GRAINS; i++) {
        const g = grains[i];
        if (!g.on) continue;
        const t = g.age / g.len;
        const e = grainEnvelope(t, win);
        // reversed grains read backwards from their (delayed) end
        const pos = g.pos + (g.inc < 0 ? g.len * -g.inc : 0) + g.age * g.inc;
        yl += this._read(this.bufL, pos) * e * g.gl;
        yr += this._read(this.bufR, pos) * e * g.gr;
        if (++g.age >= g.len) g.on = false;
      }
      yl *= norm; yr *= norm;
      this.lpL += toneA * (yl - this.lpL); this.lpR += toneA * (yr - this.lpR);
      this.fbL = Math.tanh(this.lpL); this.fbR = Math.tanh(this.lpR);
      outL[s] = this.lpL; outR[s] = this.lpR;
    }
  }
  get activeGrains() { return this.grains.reduce((a, g) => a + (g.on ? 1 : 0), 0); }
}
