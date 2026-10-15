// Modulation — pure model + math (Node-safe). Every track can carry
//   track.mod = { macros: [{name, value 0..1}] × 8, mods: Modulator[], routes: Route[] }
// Modulator { id, type:'lfo'|'env'|'step'|'random'|'follow', name, ...settings } — output 0..1 (unipolar):
//   lfo     shape 'sine'|'triangle'|'saw'|'ramp'|'square'|'mseg', rate (Hz) | sync + div, retrig 'free'|'note',
//           phase 0..1, mseg: {points:[{x, y, c}] (x 0..1 sorted, y 0..1, c = curve of the segment ending there −1..1)}, snap
//   env     a, d, s, r (s) — triggered by the track's notes (retrigger on every note-on, release when all are up)
//   step    steps: [0..1] (1..32), div (tempo-synced), glide 0..1, retrig
//   random  sample & hold (smooth 0) … smoothed random (smooth 1) at rate / div, deterministic per seed
//   follow  envelope follower of a track's audio (source '' = this track), attack / release (s), gain (dB)
// Route { id, src: 'macro:<0-7>' | modulatorId, target, amount −1..1, min (macros: range start), bipolar, curve −1..1 }
//   target: 'inst:<key>' | 'fx:<fxId>:<key>' | 'volume' | 'pan' | 'send:<busId>' (numeric params only)
// Math: the target's base value (static, or its automation lane value while automation plays) is normalized with the
// knob's curve (toNorm); each route adds an offset in that normalized space; the sum is clamped to 0..1 and mapped
// back (fromNorm). So automation sets the base and modulation offsets it.
import { uid, clamp } from './util.js';

export const MACRO_COUNT = 8;
export const MOD_TYPES = ['lfo', 'env', 'step', 'random', 'follow'];
export const MOD_TYPE_LABELS = { lfo: 'LFO', env: 'Envelope', step: 'Step sequencer', random: 'Random / S&H', follow: 'Envelope follower' };
export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'ramp', 'square', 'mseg'];
export const MOD_DIVISIONS = ['8/1', '4/1', '2/1', '1/1', '1/2', '1/2d', '1/4', '1/4d', '1/4t', '1/8', '1/8d', '1/8t', '1/16', '1/16t', '1/32'];

/** Note division -> beats ('1/4' = 1 beat, 't' triplet, 'd' dotted). */
export function divBeats(div) {
  const m = /^(\d+)\/(\d+)([td]?)$/.exec(String(div || '1/4'));
  if (!m) return 1;
  let b = (4 * Number(m[1])) / Math.max(1, Number(m[2]));
  if (m[3] === 't') b *= 2 / 3;
  if (m[3] === 'd') b *= 1.5;
  return b;
}

// ------------------------------------------------------------------------------------------- model
export function defaultMacros() {
  return Array.from({ length: MACRO_COUNT }, (_, i) => ({ name: `Macro ${i + 1}`, value: 0 }));
}

const DEFAULT_MSEG = [{ x: 0, y: 0, c: 0 }, { x: 0.25, y: 1, c: 0.5 }, { x: 1, y: 0, c: -0.5 }];

export function createModulator(type, opts = {}) {
  const base = { id: opts.id || uid('mod'), type, name: opts.name || MOD_TYPE_LABELS[type] || type };
  switch (type) {
    case 'lfo': return { ...base, shape: 'sine', rate: 2, sync: true, div: '1/4', retrig: 'free', phase: 0, mseg: { points: DEFAULT_MSEG.map((p) => ({ ...p })), snap: 8 }, ...opts };
    case 'env': return { ...base, a: 0.01, d: 0.4, s: 0.3, r: 0.3, ...opts };
    case 'step': return { ...base, steps: [1, 0.25, 0.75, 0.25, 1, 0.5, 0.75, 0], div: '1/16', glide: 0, retrig: 'free', ...opts };
    case 'random': return { ...base, rate: 4, sync: true, div: '1/8', smooth: 0, seed: (Math.random() * 1e9) >>> 0, ...opts };
    case 'follow': return { ...base, source: '', attack: 0.01, release: 0.15, gain: 0, ...opts };
    default: return { ...base, ...opts };
  }
}

export function createRoute(src, target, opts = {}) {
  return { id: opts.id || uid('mr'), src, target, amount: opts.amount ?? 0.25, ...(String(src).startsWith('macro:') ? { min: opts.min ?? 0 } : {}), bipolar: !!opts.bipolar, curve: opts.curve ?? 0 };
}

/** Empty modulation block. */
export function createModState() { return { macros: defaultMacros(), mods: [], routes: [] }; }

const num = (v, d, lo = -Infinity, hi = Infinity) => { const n = Number(v); return clamp(Number.isFinite(n) ? n : d, lo, hi); };

/** Validate a track.mod loaded from JSON (null when it carries nothing). */
export function normalizeMod(mod) {
  if (!mod || typeof mod !== 'object') return null;
  const macros = defaultMacros().map((d, i) => {
    const m = Array.isArray(mod.macros) ? mod.macros[i] : null;
    return { name: typeof m?.name === 'string' && m.name.trim() ? m.name.slice(0, 40) : d.name, value: num(m?.value, 0, 0, 1) };
  });
  const mods = (Array.isArray(mod.mods) ? mod.mods : []).filter((m) => m && MOD_TYPES.includes(m.type) && typeof m.id === 'string').map((m) => {
    const d = createModulator(m.type, { id: m.id });
    const o = { ...d, ...m };
    if (o.type === 'lfo') {
      o.shape = LFO_SHAPES.includes(o.shape) ? o.shape : 'sine';
      o.rate = num(o.rate, 2, 0.01, 50); o.phase = num(o.phase, 0, 0, 1); o.sync = !!o.sync;
      o.retrig = o.retrig === 'note' ? 'note' : 'free';
      o.div = MOD_DIVISIONS.includes(o.div) ? o.div : '1/4';
      const pts = sanitizeMseg(o.mseg?.points);
      o.mseg = { points: pts.length >= 2 ? pts : DEFAULT_MSEG.map((p) => ({ ...p })), snap: Math.round(num(o.mseg?.snap, 8, 0, 64)) };
    } else if (o.type === 'env') {
      o.a = num(o.a, 0.01, 0, 20); o.d = num(o.d, 0.4, 0, 20); o.s = num(o.s, 0.3, 0, 1); o.r = num(o.r, 0.3, 0, 20);
    } else if (o.type === 'step') {
      o.steps = (Array.isArray(o.steps) ? o.steps : d.steps).slice(0, 32).map((v) => num(v, 0, 0, 1));
      if (!o.steps.length) o.steps = d.steps;
      o.div = MOD_DIVISIONS.includes(o.div) ? o.div : '1/16'; o.glide = num(o.glide, 0, 0, 1); o.retrig = o.retrig === 'note' ? 'note' : 'free';
    } else if (o.type === 'random') {
      o.rate = num(o.rate, 4, 0.01, 50); o.sync = !!o.sync; o.div = MOD_DIVISIONS.includes(o.div) ? o.div : '1/8';
      o.smooth = num(o.smooth, 0, 0, 1); o.seed = Math.floor(num(o.seed, 1, 0, 4294967295));
    } else if (o.type === 'follow') {
      o.source = typeof o.source === 'string' ? o.source : ''; o.attack = num(o.attack, 0.01, 0.001, 2); o.release = num(o.release, 0.15, 0.005, 5); o.gain = num(o.gain, 0, -24, 24);
    }
    o.name = typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, 40) : d.name;
    return o;
  });
  const ids = new Set(mods.map((m) => m.id));
  const routes = (Array.isArray(mod.routes) ? mod.routes : []).filter((r) => r && typeof r.target === 'string' && typeof r.src === 'string'
    && (ids.has(r.src) || /^macro:[0-7]$/.test(r.src))).map((r) => ({
    id: typeof r.id === 'string' ? r.id : uid('mr'), src: r.src, target: r.target, amount: num(r.amount, 0.25, -1, 1),
    ...(r.src.startsWith('macro:') ? { min: num(r.min, 0, -1, 1) } : {}), bipolar: !!r.bipolar, curve: num(r.curve, 0, -1, 1),
    ...(r.enabled === false ? { enabled: false } : {}),
  }));
  return { macros, mods, routes };
}

export function sanitizeMseg(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.y))
    .map((p) => ({ x: clamp(+p.x, 0, 1), y: clamp(+p.y, 0, 1), c: clamp(Number(p.c) || 0, -1, 1) }))
    .sort((a, b) => a.x - b.x);
  if (pts.length) { pts[0].x = 0; pts[pts.length - 1].x = 1; }
  return pts;
}

/** Does the track carry any active route? */
export const hasRoutes = (track) => !!track?.mod?.routes?.some((r) => r.enabled !== false);
/** Does the project use modulation anywhere (offline renders then run control-rate steps)? */
export function hasModulation(project) { return (project?.tracks || []).some(hasRoutes); }

// ------------------------------------------------------------------------------------------- shapes
/** Segment curve: c > 0 rises fast then flattens (convex), c < 0 slow start; 0 = linear. */
export function curveFn(t, c) {
  t = clamp(t, 0, 1);
  if (!c) return t;
  return Math.pow(t, Math.pow(2, -3 * clamp(c, -1, 1)));
}

/** Multi-segment envelope / LFO shape at x 0..1 (points sorted by x; y 0..1; c = curve into that point). */
export function msegValue(points, x) {
  const n = points?.length || 0;
  if (!n) return 0;
  x = clamp(x, 0, 1);
  if (x <= points[0].x) return points[0].y;
  for (let i = 1; i < n; i++) {
    const b = points[i];
    if (x <= b.x) {
      const a = points[i - 1];
      const span = b.x - a.x;
      if (!(span > 0)) return b.y;
      return a.y + (b.y - a.y) * curveFn((x - a.x) / span, b.c || 0);
    }
  }
  return points[n - 1].y;
}

/** Snap a point to the editor grid (snap = divisions per cycle on x; y snaps to 1/snap too). */
export function snapPoint(p, snap) {
  if (!(snap > 0)) return { ...p };
  return { ...p, x: Math.round(p.x * snap) / snap, y: Math.round(p.y * snap) / snap };
}

/** Basic LFO shape at phase 0..1 -> 0..1. */
export function lfoShapeValue(shape, ph, mseg = null) {
  ph -= Math.floor(ph);
  switch (shape) {
    case 'triangle': return ph < 0.5 ? 2 * ph : 2 - 2 * ph;
    case 'saw': return ph;
    case 'ramp': return 1 - ph;
    case 'square': return ph < 0.5 ? 1 : 0;
    case 'mseg': return msegValue(mseg?.points || DEFAULT_MSEG, ph);
    default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
  }
}

/** Deterministic 0..1 value for step n of a random modulator (integer hash). */
export function hashRandom(seed, n) {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Step-sequencer value: cycle position ph 0..1 over `steps`, glide 0..1 = portion of a step spent sliding in. */
export function stepValue(steps, ph, glide = 0) {
  const n = steps.length;
  if (!n) return 0;
  ph -= Math.floor(ph);
  const x = ph * n;
  const i = Math.min(n - 1, Math.floor(x));
  const cur = steps[i];
  if (!(glide > 0)) return cur;
  const prev = steps[(i - 1 + n) % n];
  const f = (x - i) / glide;
  if (f >= 1) return cur;
  return prev + (cur - prev) * (0.5 - 0.5 * Math.cos(Math.PI * f));
}

/** Random modulator at position `pos` (in steps, float): S&H when smooth = 0, cosine-smoothed when 1. */
export function randomValue(seed, pos, smooth = 0) {
  const n = Math.floor(pos);
  const cur = hashRandom(seed, n);
  if (!(smooth > 0)) return cur;
  const prev = hashRandom(seed, n - 1);
  const f = Math.min(1, (pos - n) / smooth);
  return prev + (cur - prev) * (0.5 - 0.5 * Math.cos(Math.PI * f));
}

/**
 * Modulator cycle position for time-based modulators. clock = { t (s), beat (transport beat or null), bpm, noteT
 * (last note-on time or null) }. Synced modulators follow the transport (beat) while it plays.
 */
export function cyclePos(mod, clock, { rateKey = 'rate', divKey = 'div', sync = mod.sync !== false } = {}) {
  const bpm = clock.bpm || 120;
  const beats = divBeats(mod[divKey]);
  const hz = sync ? bpm / 60 / beats : Math.max(0.0001, mod[rateKey] || 1);
  if (mod.retrig === 'note' && clock.noteT != null) return Math.max(0, clock.t - clock.noteT) * hz;
  if (sync && clock.beat != null) return clock.beat / beats;
  return clock.t * hz;
}

/** Value 0..1 of a time-based modulator (lfo / step / random) at `clock`. */
export function modulatorValue(mod, clock) {
  switch (mod.type) {
    case 'lfo': return lfoShapeValue(mod.shape, cyclePos(mod, clock) + (mod.phase || 0), mod.mseg);
    case 'step': return stepValue(mod.steps || [], cyclePos(mod, clock, { sync: true }), mod.glide || 0);
    case 'random': return randomValue(mod.seed >>> 0, cyclePos(mod, clock), mod.smooth || 0);
    default: return 0;
  }
}

// ------------------------------------------------------------------------------------------- envelope
/** Envelope modulator state (time-stepped; times in seconds). */
export function envState() { return { stage: 0, level: 0, t: null }; }
/** Advance an envelope state to time t (stages: 0 idle, 1 attack, 2 decay/sustain, 3 release). */
export function envAdvance(st, env, t) {
  if (st.t == null) { st.t = t; return st.level; }
  let dt = t - st.t;
  st.t = t;
  while (dt > 0) {
    if (st.stage === 1) {
      const a = Math.max(0.0005, env.a || 0);
      const need = (1 - st.level) * a;
      if (dt < need) { st.level += dt / a; dt = 0; } else { st.level = 1; st.stage = 2; dt -= need; }
    } else if (st.stage === 2) {
      const tau = Math.max(0.0005, (env.d || 0) / 4);
      st.level = env.s + (st.level - env.s) * Math.exp(-dt / tau); dt = 0;
    } else if (st.stage === 3) {
      const tau = Math.max(0.0005, (env.r || 0) / 6);
      st.level *= Math.exp(-dt / tau); dt = 0;
      if (st.level < 1e-4) { st.level = 0; st.stage = 0; }
    } else dt = 0;
  }
  return st.level;
}
export function envGate(st, on) { if (on) st.stage = 1; else if (st.stage !== 0) st.stage = 3; }

/** One-pole envelope follower step: level follows `input` with attack / release times (s) over dt. */
export function followStep(level, input, dt, attack, release) {
  const tau = input > level ? attack : release;
  return input + (level - input) * Math.exp(-dt / Math.max(1e-4, tau));
}

// ------------------------------------------------------------------------------------------- routing
const isMacro = (src) => typeof src === 'string' && src.startsWith('macro:');

/** Normalized offset a route adds for a source value 0..1. */
export function routeOffset(route, srcValue) {
  const u = curveFn(clamp(Number(srcValue) || 0, 0, 1), route.curve || 0);
  if (isMacro(route.src)) { const lo = route.min ?? 0; return lo + ((route.amount ?? 0) - lo) * u; }
  const a = route.amount ?? 0;
  return route.bipolar ? a * (2 * u - 1) : a * u;
}

/** [lo, hi] normalized offset a route can add (for the knobs' modulation rings). */
export function routeExtent(route) {
  const a = route.amount ?? 0;
  if (isMacro(route.src)) { const lo = route.min ?? 0; return [Math.min(lo, a), Math.max(lo, a)]; }
  if (route.bipolar) return [-Math.abs(a), Math.abs(a)];
  return [Math.min(0, a), Math.max(0, a)];
}

/** Final normalized value: base + Σ offsets, clamped. */
export function combine(baseNorm, offsets) {
  let n = baseNorm;
  for (const o of offsets) n += o;
  return clamp(n, 0, 1);
}

/** Routes of a track grouped by target: Map(target -> Route[]) (enabled routes only). */
export function routesByTarget(track) {
  const out = new Map();
  for (const r of track?.mod?.routes || []) {
    if (r.enabled === false) continue;
    if (!out.has(r.target)) out.set(r.target, []);
    out.get(r.target).push(r);
  }
  return out;
}

/** Sum of route extents for one target -> [lo, hi]. */
export function targetExtent(routes) {
  let lo = 0, hi = 0;
  for (const r of routes) { const [a, b] = routeExtent(r); lo += a; hi += b; }
  return [lo, hi];
}

/** Drop routes whose target vanished (effect deleted, bus removed…). isValid(target) -> bool. Mutates draft. */
export function pruneRoutes(track, isValid) {
  if (!track?.mod?.routes) return 0;
  const before = track.mod.routes.length;
  track.mod.routes = track.mod.routes.filter((r) => isValid(r.target));
  return before - track.mod.routes.length;
}
