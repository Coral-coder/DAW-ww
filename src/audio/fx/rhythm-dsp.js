// Pure timing / DSP math of the rhythm effects (Trance Gate, Volume Shaper, Beat Repeat, Time Shaper).
// No Web Audio here: shared by the AudioWorklet processor (rhythm-worklet.js), the builders' main-thread mirror
// and native fallback (fx/builders/rhythm.js), the card UIs (ui/fx-ui/rhythm.js) and the Node tests.
//
// Everything is a function of the song's beat position, so the effects stay locked to the grid through seeks,
// loops, tempo-map changes and offline export: the builder turns env.getBeatAt(t) into a piecewise-linear
// beat clock (beatSegments), the worklet evaluates it per sample (BeatClock), and every effect state below is
// computed from that beat alone (no free-running counters that could drift).

export const MAX_STEPS = 32;
export const MAX_POINTS = 64;

export const mod = (x, m) => ((x % m) + m) % m;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ============================================================================== step patterns
// A step pattern is stored in the effect params as a compact string (project JSON, undo, Pocket and collab treat
// it as an opaque string):
//   compact: one character per step   x = 100 %   - . _ 0 = off   1…9 = 10…90 %      e.g. "x-x-xx-x-x5x-x-x"
//   list:    percentages separated by spaces / commas                                 e.g. "100 0 75 0 33 …"
// serializePattern writes the compact form whenever every level is a multiple of 10 %.

/** Pattern string (or array of 0..1 / 0..100 numbers) -> levels 0..1 (1..32 entries), null when unusable. */
export function parsePattern(src) {
  if (Array.isArray(src)) {
    const big = src.some((v) => Number(v) > 1);
    const out = src.slice(0, MAX_STEPS).map((v) => clamp01((Number(v) || 0) / (big ? 100 : 1)));
    return out.length ? out : null;
  }
  if (typeof src !== 'string') return null;
  const s = src.trim();
  if (!s) return null;
  if (/[\s,;]/.test(s)) {
    const toks = s.split(/[\s,;]+/).filter(Boolean).slice(0, MAX_STEPS);
    const out = [];
    for (const t of toks) {
      if (/^[x]$/i.test(t)) { out.push(1); continue; }
      if (/^[-._]$/.test(t)) { out.push(0); continue; }
      const n = parseFloat(t);
      if (!Number.isFinite(n)) return null;
      out.push(clamp01(n / 100));
    }
    return out.length ? out : null;
  }
  const out = [];
  for (const ch of s.slice(0, MAX_STEPS)) {
    if (ch === 'x' || ch === 'X') out.push(1);
    else if (ch === '-' || ch === '.' || ch === '_' || ch === '0') out.push(0);
    else if (ch >= '1' && ch <= '9') out.push((ch.charCodeAt(0) - 48) / 10);
    else return null;
  }
  return out.length ? out : null;
}

/** Levels 0..1 -> canonical pattern string (compact when every level is a multiple of 10 %). */
export function serializePattern(levels) {
  const pct = (levels || []).slice(0, MAX_STEPS).map((v) => Math.round(clamp01(Number(v) || 0) * 100));
  if (!pct.length) return '-';
  if (pct.every((p) => p % 10 === 0)) return pct.map((p) => (p === 100 ? 'x' : p === 0 ? '-' : String(p / 10))).join('');
  return pct.length === 1 ? `${pct[0]},` : pct.join(' ');
}

/** Levels repeated / cut to exactly n steps (a short pattern repeats: "x-" over 16 steps = 8 hits). */
export function fitSteps(levels, n) {
  n = Math.max(1, Math.min(MAX_STEPS, Math.round(n) || 1));
  const src = levels && levels.length ? levels : [1];
  return Array.from({ length: n }, (_, i) => src[i % src.length]);
}

/** Pattern edit helpers (UI): rotate by k steps (positive = later), invert, random. */
export const shiftPattern = (levels, k) => levels.map((_, i) => levels[mod(i - k, levels.length)]);
export const invertPattern = (levels) => levels.map((v) => (v > 0 ? 0 : 1));
export function randomPattern(n, rng = Math.random, density = 0.6) {
  return Array.from({ length: n }, (_, i) => {
    const on = rng() < (i % 4 === 0 ? Math.min(1, density + 0.3) : density);
    if (!on) return 0;
    const r = rng();
    return r < 0.65 ? 1 : r < 0.85 ? 0.7 : 0.4;
  });
}

// ============================================================================== swing / step grid

/** Start (beats from the cycle start) of step k: odd steps are pushed late by swing × half a step. */
export function stepStart(k, stepBeats, swing = 0) {
  return k * stepBeats + (k & 1 ? clamp01(swing) * 0.5 * stepBeats : 0);
}

/** Step index (0..n-1) playing at position pos (beats, 0 <= pos < n*stepBeats) of a swung step grid. */
export function stepAt(pos, n, stepBeats, swing = 0) {
  let k = Math.floor(pos / stepBeats + 1e-9);
  if (k >= n) k = n - 1;
  if (k < 0) k = 0;
  if (k & 1 && pos < stepStart(k, stepBeats, swing) - 1e-12) k -= 1;
  return k;
}

/** Envelope curve: c = 0 linear, c > 0 fast / punchy (exponential-like), c < 0 slow / soft. u in 0..1. */
export function shapeCurve(u, c) {
  u = clamp01(u);
  if (!c) return u;
  return c > 0 ? 1 - Math.pow(1 - u, 1 + 3 * c) : Math.pow(u, 1 - 3 * c);
}

// ============================================================================== trance gate

/**
 * Normalised gate configuration from resolved params.
 * @returns {{L:number[], R:number[], n:number, stepBeats:number, swing:number, length:number, attack:number,
 *            release:number, curve:number, legato:boolean, depth:number}}  attack / release in seconds
 */
export function gateConfig(p, divisionToBeats) {
  const n = Math.max(1, Math.min(MAX_STEPS, Math.round(p.steps) || 16));
  const L = fitSteps(parsePattern(p.pattern) || [1], n);
  let R = L;
  switch (p.stereo) {
    case 'offset': R = shiftPattern(L, Math.round(p.stereoOffset) || 0); break;
    case 'separate': R = fitSteps(parsePattern(p.patternR) || parsePattern(p.pattern) || [1], n); break;
    case 'invert': R = L.map((v) => 1 - v); break;
    default:
  }
  return {
    L, R, n,
    stereoSame: !p.stereo || p.stereo === 'mono',
    stepBeats: divisionToBeats(p.division),
    swing: clamp01(p.swing ?? 0),
    length: Math.max(0.01, Math.min(1, p.length ?? 1)),
    attack: Math.max(0, p.attack ?? 0.002),
    release: Math.max(0, p.release ?? 0.03),
    curve: Math.max(-1, Math.min(1, p.curve ?? 0)),
    legato: !!p.legato,
    depth: clamp01(p.depth ?? 1),
  };
}

const MIN_EDGE = 0.0003; // s: shortest attack / release (keeps step edges click-free)

/** Contribution of step k to the envelope at t beats after its start (attack, hold, release tail). */
function stepContribution(levels, k, t, g, atkB, relB) {
  const n = levels.length;
  const kk = mod(k, n);
  const lvl = levels[kk];
  const end = kk + 1 >= n ? n * g.stepBeats : stepStart(kk + 1, g.stepBeats, g.swing);
  const dur = end - stepStart(kk, g.stepBeats, g.swing);
  const next = levels[mod(k + 1, n)];
  const prev = levels[mod(k - 1, n)];
  const holdEnd = g.legato && next > 0 && lvl > 0 ? dur : g.length * dur;
  const from = g.legato && prev > 0 && lvl > 0 ? prev : 0;
  const attackAt = (tt) => (atkB > 0 ? from + (lvl - from) * shapeCurve(tt / atkB, g.curve) : lvl);
  if (t < holdEnd) return lvl > 0 || from > 0 ? attackAt(t) : 0;
  const vh = lvl > 0 ? attackAt(holdEnd) : 0;
  if (vh <= 0) return 0;
  const r = (t - holdEnd) / relB;
  return r >= 1 ? 0 : vh * (1 - shapeCurve(r, g.curve));
}

/**
 * Gate envelope (0..1) of one channel's levels at song beat `beat`. bps = beats per second (converts the attack /
 * release times). The pattern cycle (n steps) is anchored to beat 0 of the song.
 */
export function gateEnvAt(beat, levels, g, bps) {
  const n = levels.length;
  const cycle = n * g.stepBeats;
  const pos = mod(beat, cycle);
  const k = stepAt(pos, n, g.stepBeats, g.swing);
  const t = pos - stepStart(k, g.stepBeats, g.swing);
  const atkB = Math.max(MIN_EDGE, g.attack) * bps;
  const relB = Math.max(MIN_EDGE, g.release) * bps;
  let env = stepContribution(levels, k, t, g, atkB, relB);
  // release tails of the previous steps can reach into this one
  const s0 = stepStart(k, g.stepBeats, g.swing);
  for (let j = 1; j <= 2 && j < n + 1; j++) {
    const kj = k - j;
    const back = s0 - (kj >= 0 ? stepStart(kj, g.stepBeats, g.swing) : stepStart(kj + n, g.stepBeats, g.swing) - cycle);
    const v = stepContribution(levels, kj < 0 ? kj + n : kj, t + back, g, atkB, relB);
    if (v > env) env = v;
  }
  return env;
}

/** Gain applied by the gate: depth 1 = full chop, 0 = no effect. */
export const gateGain = (env, depth) => 1 - depth * (1 - env);

// ============================================================================== volume shaper curves
// Curve string: points "x,y,t" separated by spaces; x = position in the cycle 0..1, y = level 0..1, t = tension
// -1..1 of the segment that starts at this point (0 = straight). Two points at the same x make a vertical edge.

/** Curve string -> sorted points [{x, y, t}] (max 64), null when unusable. */
export function parseCurve(src) {
  if (Array.isArray(src)) src = src.map((p) => `${p.x},${p.y},${p.t || 0}`).join(' ');
  if (typeof src !== 'string' || !src.trim()) return null;
  const pts = [];
  for (const tok of src.trim().split(/[\s;]+/).slice(0, MAX_POINTS)) {
    const [x, y, t] = tok.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({ x: clamp01(x), y: clamp01(y), t: Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0 });
  }
  if (!pts.length) return null;
  return pts.map((p, i) => ({ p, i })).sort((a, b) => a.p.x - b.p.x || a.i - b.i).map((e) => e.p);
}

const r4 = (v) => +(+v).toFixed(4);
export const serializeCurve = (pts) => (pts || []).slice(0, MAX_POINTS).map((p) => `${r4(p.x)},${r4(p.y)}${p.t ? ',' + r4(p.t) : ''}`).join(' ');

/** Tension bend of u in 0..1: t = 0 linear, t > 0 slow start (exponential rise), t < 0 fast start. */
export function bend(u, t) {
  u = clamp01(u);
  if (!t || Math.abs(t) < 1e-6) return u;
  const c = t * 6;
  return (Math.exp(c * u) - 1) / (Math.exp(c) - 1);
}

/** Curve value at phase x (0..1, wraps): the last point connects to the first one of the next cycle. */
export function curveAt(pts, x) {
  if (!pts || !pts.length) return 1;
  x = mod(x, 1);
  const n = pts.length;
  if (n === 1) return pts[0].y;
  // last point with p.x <= x (binary search)
  let lo = 0, hi = n - 1, i = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pts[m].x <= x) { i = m; lo = m + 1; } else hi = m - 1;
  }
  let a, b, x0, x1;
  if (i < 0) { a = pts[n - 1]; b = pts[0]; x0 = a.x - 1; x1 = b.x; } else if (i === n - 1) { a = pts[n - 1]; b = pts[0]; x0 = a.x; x1 = b.x + 1; } else { a = pts[i]; b = pts[i + 1]; x0 = a.x; x1 = b.x; }
  if (x1 - x0 <= 1e-9) return b.y;
  return a.y + (b.y - a.y) * bend((x - x0) / (x1 - x0), a.t);
}

/** Volume-shaper configuration from resolved params. */
export function shaperConfig(p, divisionToBeats) {
  return {
    pts: parseCurve(p.shape) || [{ x: 0, y: 1, t: 0 }],
    lengthBeats: divisionToBeats(p.length),
    depth: clamp01(p.depth ?? 1),
    offset: Number(p.offset) || 0,
    smooth: Math.max(0, p.smoothing ?? 0), // seconds
    target: p.target || 'volume',
    cutMin: Math.max(20, p.cutoffMin ?? 200),
    cutMax: Math.max(20, p.cutoffMax ?? 12000),
    resonance: Math.max(0.1, p.resonance ?? 0.7),
  };
}

/** Shaper value (0..1, depth applied) at song beat. */
export function shaperValueAt(beat, s) {
  const y = curveAt(s.pts, beat / s.lengthBeats + s.offset);
  return 1 - s.depth * (1 - y);
}

// ============================================================================== beat clock
// A piecewise-linear map from AudioContext time to song beat: segments [{t, beat, bps}] (seconds, beats, beats
// per second), valid from t until the next segment's t. Built on the main thread from env.getBeatAt (scheduler
// anchors / tempo map / offline beatOf) and evaluated per sample by the worklet.

/**
 * Sample getBeatAt(t) from t0 over `horizon` seconds into linear segments. Recursively splits until the beat
 * function is linear within tol beats (constant tempo: one segment; tempo changes: a breakpoint located within
 * minDt). Returns null when the transport is stopped (getBeatAt -> null).
 */
export function beatSegments(getBeatAt, t0, { horizon = 900, tol = 1e-5, minDt = 0.002, maxSegs = 4000 } = {}) {
  const f = (t) => { const b = getBeatAt(t); return b == null || !Number.isFinite(b) ? null : b; };
  const b0 = f(t0);
  if (b0 == null) return null;
  const segs = [];
  let stop = false;
  const linearOn = (ta, ba, tb, bb) => {
    for (const q of [0.25, 0.5, 0.75]) {
      const t = ta + (tb - ta) * q;
      const b = f(t);
      if (b == null) return false;
      if (Math.abs(b - (ba + (bb - ba) * q)) > tol) return false;
    }
    return true;
  };
  const refine = (ta, ba, tb, bb, depth) => {
    if (stop) return;
    if (segs.length >= maxSegs) { stop = true; return; }
    if (linearOn(ta, ba, tb, bb)) {
      segs.push({ t: ta, beat: ba, bps: (bb - ba) / (tb - ta) });
      return;
    }
    if (tb - ta <= minDt || depth > 40) {
      // a tempo change inside a tiny interval: intersect the outer tangents to place the kink exactly
      const h = tb - ta;
      const bl = f(ta - h), br = f(tb + h);
      const sL = bl == null ? null : (ba - bl) / h;
      const sR = br == null ? null : (br - bb) / h;
      const tk = sL != null && sR != null && Math.abs(sL - sR) > 1e-12 ? (bb - ba + sL * ta - sR * tb) / (sL - sR) : NaN;
      if (tk > ta && tk < tb) {
        segs.push({ t: ta, beat: ba, bps: sL });
        segs.push({ t: tk, beat: ba + sL * (tk - ta), bps: sR });
      } else segs.push({ t: ta, beat: ba, bps: (bb - ba) / h });
      return;
    }
    const tm = (ta + tb) / 2;
    const bm = f(tm);
    if (bm == null) { segs.push({ t: ta, beat: ba, bps: (bb - ba) / (tb - ta) }); stop = true; return; }
    refine(ta, ba, tm, bm, depth + 1);
    refine(tm, bm, tb, bb, depth + 1);
  };
  const t1 = t0 + horizon;
  const b1 = f(t1);
  if (b1 == null) {
    // the beat function ends (e.g. a bounded render): extrapolate from a short probe
    const bp = f(t0 + 0.5);
    return [{ t: t0, beat: b0, bps: bp == null ? 2 : (bp - b0) / 0.5 }];
  }
  refine(t0, b0, t1, b1, 0);
  // merge collinear neighbours
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.bps - s.bps) < 1e-9 && Math.abs(last.beat + (s.t - last.t) * last.bps - s.beat) < tol) continue;
    out.push(s);
  }
  return out;
}

/** Per-sample beat clock over frame-based segments [{f, beat, bpf}] (f = frame, bpf = beats per frame). */
export class BeatClock {
  constructor(bpm = 120, sampleRate = 48000) {
    this.sr = sampleRate;
    this.segs = [{ f: 0, beat: 0, bpf: bpm / 60 / sampleRate }];
    this.i = 0;
  }
  static fromSeconds(segs, sr) { return segs.map((s) => ({ f: s.t * sr, beat: s.beat, bpf: s.bps / sr })); }
  /** Replace everything from frameSegs[0].f on (earlier segments stay valid until then). */
  set(frameSegs) {
    if (!frameSegs?.length) return;
    const f0 = frameSegs[0].f;
    const keep = this.segs.filter((s) => s.f < f0);
    this.segs = keep.concat(frameSegs);
    this.i = Math.min(this.i, this.segs.length - 1);
  }
  /** Continue from frame f at a constant tempo (transport stopped: the effect free-runs at the project tempo). */
  free(f, bpm) { this.set([{ f, beat: this.beatAt(f), bpf: bpm / 60 / this.sr }]); }
  /** Drop segments that ended before frame f (keeps the list short while playing). */
  prune(f) {
    let k = 0;
    while (k + 1 < this.segs.length && this.segs[k + 1].f <= f) k++;
    if (k > 0) { this.segs = this.segs.slice(k); this.i = 0; }
  }
  _seg(f) {
    const s = this.segs;
    let i = this.i;
    if (i >= s.length) i = s.length - 1;
    if (s[i].f > f) i = 0;
    while (i + 1 < s.length && s[i + 1].f <= f) i++;
    this.i = i;
    return s[i];
  }
  beatAt(f) { const s = this._seg(f); return s.beat + (f - s.f) * s.bpf; }
  bpfAt(f) { return this._seg(f).bpf; }
}

// ============================================================================== beat repeat

/** Deterministic 0..1 hash of an integer (chance decisions are identical live and in exports). */
export function hash01(k, seed = 0) {
  let h = (Math.imul((k | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Beat-repeat configuration from resolved params (all lengths in beats). */
export function repeatConfig(p, divisionToBeats) {
  const interval = divisionToBeats(p.interval);
  return {
    interval,
    offset: Math.max(0, Math.min(interval - 1e-6, (Number(p.offset) || 0) / 4)),
    gate: Math.max(0.0625, (Number(p.gate) || 4) / 4),
    grid: divisionToBeats(p.grid),
    chance: clamp01(p.chance ?? 1),
    decay: clamp01(p.decay ?? 0),
    pitch: Math.min(0, Math.max(-24, Number(p.pitch) || 0)),
    mode: p.mode || 'insert',
    seed: Math.round(Number(p.seed) || 0),
  };
}

/** Repeat slice state at `beat` for a repeat that captured at `start` (beats). `o` = optional result object
 *  (the worklet reuses one: no allocation per sample). */
export function repeatSlice(beat, start, grid, cfg, o = {}) {
  const rel = beat - start;
  let n = Math.floor(rel / grid + 1e-9);
  if (n < 0) n = 0;
  const pos = rel - n * grid;
  const rate = n > 0 && cfg.pitch ? Math.pow(2, (n * cfg.pitch) / 12) : 1;
  o.start = start; o.n = n; o.pos = pos; o.rate = rate;
  o.gain = n > 0 && cfg.decay ? Math.pow(1 - cfg.decay, n) : 1;
  o.delay = rel - pos * rate;
  return o;
}

/**
 * Scheduled repeat at song beat: every `interval` beats a capture starts `offset` beats in, and (when the chance
 * hash of that interval passes) repeats its first `grid` beats for `gate` beats. Returns null when idle, else
 * { k, start, end, n, pos, rate, gain, delay } (delay = how far behind the live signal the repeat reads, beats).
 */
export function repeatAt(beat, cfg, o = {}) {
  const I = cfg.interval;
  const k = Math.floor(beat / I);
  const back = Math.ceil(cfg.gate / I) + 1;
  for (let kk = k; kk >= k - back; kk--) {
    const start = kk * I + cfg.offset;
    if (beat < start || beat >= start + cfg.gate) continue;
    if (cfg.chance <= 0 || (cfg.chance < 1 && hash01(kk, cfg.seed) >= cfg.chance)) continue;
    o.k = kk; o.end = start + cfg.gate;
    return repeatSlice(beat, start, cfg.grid, cfg, o);
  }
  return null;
}

/** First beats of upcoming repeats in [b0, b1) (UI / scheduling preview). */
export function repeatStarts(b0, b1, cfg) {
  const out = [];
  for (let k = Math.floor((b0 - cfg.offset) / cfg.interval); k * cfg.interval + cfg.offset < b1; k++) {
    const s = k * cfg.interval + cfg.offset;
    if (s >= b0 && cfg.chance > 0 && (cfg.chance >= 1 || hash01(k, cfg.seed) < cfg.chance)) out.push(s);
  }
  return out;
}

/** Declick envelope of a slice at pos (beats) of a slice `len` beats long; fade in beats. */
export const sliceEnv = (pos, len, fade, n) => Math.min(1, n > 0 ? pos / fade : 1, (len - pos) / fade);

// ============================================================================== time shaper (tape stop, reverse, half speed)

export function timeConfig(p, divisionToBeats) {
  const every = Math.max(1, Number(p.every) || 4) * 4; // bars (4/4) -> beats
  return {
    mode: p.mode || 'tapestop',
    trigger: p.trigger || 'sync',
    every,
    length: Math.min(every, divisionToBeats(p.length)),
    align: p.align || 'end',
    curve: Math.max(-1, Math.min(1, Number(p.curve) || 0)),
    tapeStart: !!p.tapeStart,
    startLength: divisionToBeats(p.startLength),
  };
}

/** Speed curve exponent from the curve knob: -1 -> 0.25 (drops late), 0 -> 1 (linear), 1 -> 4 (drops early). */
export const speedExp = (curve) => Math.pow(2, 2 * curve);

/**
 * Read position of a window: given elapsed fraction u (0..1) of a window `len` long (any unit), returns
 * { delay, rate } = how far the read head is behind the live signal (same unit) and the playback speed.
 *   tapestop: speed (1-u)^p     tapestart: speed u^p     reverse: speed -1     halfspeed: speed 0.5
 */
export function timeRead(mode, u, len, p = 1, o = {}) {
  u = clamp01(u);
  const e = u * len;
  switch (mode) {
    case 'tapestop': { const pos = (len * (1 - Math.pow(1 - u, p + 1))) / (p + 1); o.delay = e - pos; o.rate = Math.pow(1 - u, p); break; }
    case 'tapestart': { const pos = (len * Math.pow(u, p + 1)) / (p + 1); o.delay = e - pos; o.rate = Math.pow(u, p); break; }
    case 'reverse': o.delay = 2 * e; o.rate = -1; break;
    case 'halfspeed': o.delay = 0.5 * e; o.rate = 0.5; break;
    default: o.delay = 0; o.rate = 1;
  }
  return o;
}

const win = (o, mode, start, len, beat) => { o.mode = mode; o.start = start; o.len = len; o.u = (beat - start) / len; return o; };

/**
 * Active time-effect window at song beat (synced trigger): the window is the last (align 'end') or first
 * (align 'start') `length` beats of every `every` beats; Tape Start follows a tape stop for `startLength` beats.
 * Returns null or { mode, start, len, u }.
 */
export function timeWindowAt(beat, c, o = {}) {
  if (c.trigger !== 'sync') return null;
  const k = Math.floor(beat / c.every);
  for (let kk = k; kk >= k - 1; kk--) {
    const w0 = c.align === 'start' ? kk * c.every : (kk + 1) * c.every - c.length;
    if (beat >= w0 && beat < w0 + c.length) return win(o, c.mode, w0, c.length, beat);
    if (c.mode === 'tapestop' && c.tapeStart) {
      const s0 = w0 + c.length;
      if (beat >= s0 && beat < s0 + c.startLength) return win(o, 'tapestart', s0, c.startLength, beat);
    }
  }
  return null;
}

/** Window started by hand at beat `at` (the manual trigger button): same shapes as the synced ones. */
export function manualWindowAt(beat, at, c, o = {}) {
  if (at == null || beat < at) return null;
  if (beat < at + c.length) return win(o, c.mode, at, c.length, beat);
  if (c.mode === 'tapestop' && c.tapeStart && beat < at + c.length + c.startLength) return win(o, 'tapestart', at + c.length, c.startLength, beat);
  return null;
}

/** Tape-style amplitude: the signal fades as the tape slows to a halt (no DC thump at standstill). */
export const tapeAmp = (rate) => Math.min(1, Math.abs(rate) * 6);
