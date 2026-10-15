// Pure preset maths (Node-safe): snapshot morphing and parameter randomization for effects / instruments.
// ParamDefs follow src/audio/effect-defs.js ({ key, type:'number'|'enum'|'bool'|'track', min, max, step, curve, options }).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function quantize(d, v) {
  let out = clamp(v, d.min, d.max);
  if (d.step >= 1) out = Math.round(out);
  return +(+out).toFixed(6);
}
/** Value -> 0..1 position on the control (log params on a log scale, like the knobs). */
export function toUnit(d, v) {
  const lo = d.min, hi = d.max;
  v = clamp(Number(v), lo, hi);
  if (d.curve === 'log' && lo > 0) return Math.log(v / lo) / Math.log(hi / lo);
  return (v - lo) / (hi - lo || 1);
}
export function fromUnit(d, u) {
  const lo = d.min, hi = d.max;
  u = clamp(u, 0, 1);
  if (d.curve === 'log' && lo > 0) return lo * Math.pow(hi / lo, u);
  return lo + (hi - lo) * u;
}

/**
 * Morph between two parameter snapshots: numbers interpolate (in the control's own scale, so log
 * params such as frequencies and times move evenly), enums / bools / track pickers switch at t = 0.5.
 * Keys missing from a snapshot fall back to the def default. Returns a full { key: value } object.
 */
export function morphParams(a = {}, b = {}, t = 0, defs = []) {
  t = clamp(Number(t) || 0, 0, 1);
  const out = {};
  for (const d of defs) {
    const va = a[d.key] ?? d.default;
    const vb = b[d.key] ?? d.default;
    if (d.type === 'number' && typeof va === 'number' && typeof vb === 'number' && isFinite(va) && isFinite(vb)) {
      if (va === vb) { out[d.key] = va; continue; }
      const u = toUnit(d, va) + (toUnit(d, vb) - toUnit(d, va)) * t;
      out[d.key] = t <= 0 ? va : t >= 1 ? vb : quantize(d, fromUnit(d, u));
    } else {
      out[d.key] = t < 0.5 ? va : vb;
    }
  }
  return out;
}

/** Params never touched by effect randomization (levels that could blast, routing). */
export const EFFECT_RANDOM_SKIP = new Set(['output', 'makeup', 'ceiling', 'gain', 'sourceTrackId', 'sync']);

/** Small deterministic PRNG (mulberry32) for reproducible tests. */
export function seededRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Randomize parameters around the current values.
 * opts: { amount 0..1 (0.25 subtle, 0.9 wild), locks: Set|array of keys left alone, rng, skip: Set of keys }
 * Numbers move toward a random point of their range by `amount` (in control space); enums / bools flip with
 * probability ~amount. Returns only the changed { key: value } pairs.
 */
export function randomizeParams(defs, cur = {}, opts = {}) {
  const { amount = 0.4, rng = Math.random } = opts;
  const locks = new Set(opts.locks || []);
  const skip = opts.skip || EFFECT_RANDOM_SKIP;
  const out = {};
  for (const d of defs || []) {
    if (locks.has(d.key) || skip.has(d.key) || d.type === 'track' || d.type === 'sample' || d.hidden) continue;
    const c = cur[d.key] ?? d.default;
    if (d.type === 'number') {
      const u0 = toUnit(d, c);
      const target = rng();
      const u = u0 + (target - u0) * clamp(amount, 0, 1) * (0.5 + rng() * 0.5);
      const v = quantize(d, fromUnit(d, u));
      if (v !== c) out[d.key] = v;
    } else if (d.type === 'enum') {
      const ops = d.options || [];
      if (ops.length > 1 && rng() < amount * 0.7) {
        const v = ops[Math.floor(rng() * ops.length)].value;
        if (v !== c) out[d.key] = v;
      }
    } else if (d.type === 'bool') {
      if (rng() < amount * 0.35) out[d.key] = !c;
    }
  }
  return out;
}

/**
 * "Randomize within preset tags": a new point between two presets of the given pool (e.g. all presets sharing a
 * tag), plus a little jitter. pool = [{ params }]; preset params are merged over the def defaults first.
 * Returns the changed { key: value } pairs (locked keys untouched).
 */
export function randomizeWithinPresets(defs, cur = {}, pool = [], opts = {}) {
  const { rng = Math.random, jitter = 0.08 } = opts;
  const locks = new Set(opts.locks || []);
  if (!pool.length) return randomizeParams(defs, cur, { ...opts, amount: 0.3 });
  const base = Object.fromEntries((defs || []).map((d) => [d.key, d.default]));
  const pick = () => ({ ...base, ...(pool[Math.floor(rng() * pool.length)].params || {}) });
  const a = pick(), b = pick();
  const mixed = morphParams(a, b, rng(), defs);
  const jittered = { ...mixed, ...randomizeParams(defs, mixed, { amount: jitter, rng, locks, skip: opts.skip }) };
  const out = {};
  const skip = opts.skip || EFFECT_RANDOM_SKIP;
  for (const d of defs || []) {
    if (locks.has(d.key) || d.type === 'track' || (skip.has(d.key) && !pool.some((p) => d.key in (p.params || {})))) continue;
    const v = jittered[d.key];
    if (v !== undefined && v !== (cur[d.key] ?? d.default)) out[d.key] = v;
  }
  return out;
}
