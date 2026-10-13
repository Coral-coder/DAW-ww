// Strudel-compatible Pattern core. A Pattern is a function of a time span (in cycles) that
// returns the events ("haps") active during that span. Times are floats; comparisons use EPS.
//
// Hap { whole: {begin,end} | null (continuous), part: {begin,end}, value, context? }
import { mini } from './mini.js';
import {
  noteToMidi, isNoteName, toNumeral, parseScale, scaleStep, parseChord, voiceChord, chordRootMidi,
} from './theory.js';

export const EPS = 1e-9;
const NONE = Symbol('none');

// ------------------------------------------------------------------------------- time helpers

/** Cycle start ("sample") of a time, robust against float error just below an integer. */
export function sam(t) {
  const r = Math.round(t);
  return Math.abs(t - r) < EPS ? r : Math.floor(t);
}
const mod = (n, m) => ((n % m) + m) % m;
export const span = (begin, end) => ({ begin, end });
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Pattern);

/** Splits a span at cycle boundaries. Zero-width spans are returned as-is. */
export function spanCycles(sp) {
  const { begin, end } = sp;
  if (begin === end) return [span(begin, end)];
  const out = [];
  let b = begin;
  while (end - b > EPS) {
    const next = sam(b) + 1;
    out.push(span(b, Math.min(next, end)));
    b = next;
  }
  return out;
}

/** Intersection of two spans (null if they don't overlap). Mirrors Strudel's TimeSpan.intersection. */
export function sect(a, b) {
  const begin = Math.max(a.begin, b.begin);
  const end = Math.min(a.end, b.end);
  if (Math.abs(end - begin) < EPS) {
    if (Math.abs(begin - a.end) < EPS && a.end - a.begin > EPS) return null;
    if (Math.abs(begin - b.end) < EPS && b.end - b.begin > EPS) return null;
    return span(begin, begin);
  }
  if (begin > end) return null;
  return span(begin, end);
}

/**
 * Merges two hap contexts (Strudel semantics): source `locations` are concatenated so an event
 * remembers every mini-notation token that contributed to it (used for live highlighting).
 */
export function combineContext(a, b) {
  if (!a) return b;
  if (!b || a === b) return a;
  const la = a.locations;
  const lb = b.locations;
  const out = { ...a, ...b };
  if (la && lb) out.locations = la.concat(lb);
  else if (la) out.locations = la;
  return out;
}

const spanEq = (a, b) => (!a && !b) || (a && b && Math.abs(a.begin - b.begin) < EPS && Math.abs(a.end - b.end) < EPS);

// ---------------------------------------------------------------------------------------- Hap

export class Hap {
  constructor(whole, part, value, context) {
    this.whole = whole || null;
    this.part = part;
    this.value = value;
    if (context) this.context = context;
  }
  hasOnset() { return !!this.whole && Math.abs(this.whole.begin - this.part.begin) < EPS; }
  wholeOrPart() { return this.whole || this.part; }
  withSpan(f) { return new Hap(this.whole ? f(this.whole) : null, f(this.part), this.value, this.context); }
  withValue(f) { return new Hap(this.whole, this.part, f(this.value), this.context); }
  get duration() { const w = this.wholeOrPart(); return w.end - w.begin; }
}

// ------------------------------------------------------------------------------------ Pattern

export class Pattern {
  constructor(query) { this.query = query; }

  queryArc(begin, end) { return this.query({ span: span(begin, end) }); }

  /** Only events whose onset is inside [begin, end). */
  onsetsBetween(begin, end) {
    return this.queryArc(begin, end).filter((h) => h.hasOnset() && h.whole.begin >= begin - EPS && h.whole.begin < end - EPS);
  }

  splitQueries() {
    const pat = this;
    return new Pattern((st) => spanCycles(st.span).flatMap((sp) => pat.query({ ...st, span: sp })));
  }
  withQuerySpan(f) { const pat = this; return new Pattern((st) => pat.query({ ...st, span: f(st.span) })); }
  withQueryTime(f) { return this.withQuerySpan((sp) => span(f(sp.begin), f(sp.end))); }
  withHapSpan(f) { const pat = this; return new Pattern((st) => pat.query(st).map((h) => h.withSpan(f))); }
  withHapTime(f) { return this.withHapSpan((sp) => span(f(sp.begin), f(sp.end))); }
  withHaps(f) { const pat = this; return new Pattern((st) => f(pat.query(st), st)); }
  withHap(f) { const pat = this; return new Pattern((st) => pat.query(st).map(f)); }
  fmap(f) { const pat = this; return new Pattern((st) => pat.query(st).map((h) => h.withValue(f))); }
  withValue(f) { return this.fmap(f); }
  filterHaps(pred) { const pat = this; return new Pattern((st) => pat.query(st).filter(pred)); }
  filterValues(pred) { return this.filterHaps((h) => pred(h.value)); }
  onsetsOnly() { return this.filterHaps((h) => h.hasOnset()); }
  discreteOnly() { return this.filterHaps((h) => !!h.whole); }
  /** Emits several values for one hap (same timing). */
  flatMapValues(f) {
    const pat = this;
    return new Pattern((st) => pat.query(st).flatMap((h) => f(h.value).map((v) => new Hap(h.whole, h.part, v, h.context))));
  }

  /** Structure from the left (this = pattern of functions). */
  appLeft(patVal) {
    const patFunc = this;
    return new Pattern((st) => {
      const out = [];
      for (const hf of patFunc.query(st)) {
        for (const hv of patVal.query({ ...st, span: hf.wholeOrPart() })) {
          const part = sect(hf.part, hv.part);
          if (part) out.push(new Hap(hf.whole, part, hf.value(hv.value), combineContext(hf.context, hv.context)));
        }
      }
      return out;
    });
  }

  /** Structure from the right. */
  appRight(patVal) {
    const patFunc = this;
    return new Pattern((st) => {
      const out = [];
      for (const hv of patVal.query(st)) {
        for (const hf of patFunc.query({ ...st, span: hv.wholeOrPart() })) {
          const part = sect(hf.part, hv.part);
          if (part) out.push(new Hap(hv.whole, part, hf.value(hv.value), combineContext(hf.context, hv.context)));
        }
      }
      return out;
    });
  }

  /** Pattern of patterns -> pattern; structure comes from the inner patterns. */
  innerJoin() {
    const outer = this;
    return new Pattern((st) => {
      const out = [];
      for (const oh of outer.query(st)) {
        const inner = oh.value instanceof Pattern ? oh.value : pure(oh.value);
        for (const ih of inner.query({ ...st, span: oh.part })) out.push(oh.context ? new Hap(ih.whole, ih.part, ih.value, combineContext(oh.context, ih.context)) : ih);
      }
      return out;
    });
  }

  /** Pattern of patterns -> pattern; structure comes from the outer pattern. */
  outerJoin() {
    const outer = this;
    return new Pattern((st) => {
      const out = [];
      for (const oh of outer.query(st)) {
        const inner = oh.value instanceof Pattern ? oh.value : pure(oh.value);
        const t = oh.wholeOrPart().begin;
        for (const ih of inner.query({ ...st, span: span(t, t) })) out.push(new Hap(oh.whole, oh.part, ih.value, combineContext(oh.context, ih.context)));
      }
      return out;
    });
  }

  /** Each inner pattern is squeezed (one cycle) into the outer event's whole. */
  squeezeJoin() {
    const outer = this;
    return new Pattern((st) => {
      const out = [];
      for (const oh of outer.discreteOnly().query(st)) {
        const inner = (oh.value instanceof Pattern ? oh.value : pure(oh.value))._focusSpan(oh.wholeOrPart());
        for (const ih of inner.query({ ...st, span: oh.part })) {
          let whole = null;
          if (ih.whole && oh.whole) {
            whole = sect(ih.whole, oh.whole);
            if (!whole) continue;
          }
          const part = sect(ih.part, oh.part);
          if (!part) continue;
          out.push(new Hap(whole, part, ih.value, combineContext(oh.context, ih.context)));
        }
      }
      return out;
    });
  }

  /** Groups simultaneous haps (same whole & part) into one hap whose value is an array. */
  collect() {
    const pat = this;
    return new Pattern((st) => {
      const groups = [];
      for (const h of pat.query(st)) {
        const g = groups.find((x) => spanEq(x.whole, h.whole) && spanEq(x.part, h.part));
        if (g) { g.values.push(h.value); g.context = combineContext(g.context, h.context); } else groups.push({ whole: h.whole, part: h.part, values: [h.value], context: h.context });
      }
      return groups.map((g) => new Hap(g.whole, g.part, g.values, g.context));
    });
  }

  // ---- un-patterned primitives (underscore = plain numeric args)
  _fast(factor) {
    factor = toNumeral(factor);
    if (!factor || !Number.isFinite(factor)) return silence;
    if (factor < 0) return this._fast(-factor).rev();
    return this.withQueryTime((t) => t * factor).withHapTime((t) => t / factor);
  }
  _slow(factor) {
    factor = toNumeral(factor);
    if (!factor || !Number.isFinite(factor)) return silence;
    return this._fast(1 / factor);
  }
  _early(offset) {
    offset = toNumeral(offset);
    if (!offset) return this;
    return this.withQueryTime((t) => t + offset).withHapTime((t) => t - offset);
  }
  _late(offset) { return this._early(-toNumeral(offset)); }

  _fastGap(factor) {
    const pat = this;
    if (!(factor > 0)) return silence;
    return new Pattern((st) => {
      const sp = st.span;
      const cycle = sam(sp.begin);
      const bpos = Math.min((sp.begin - cycle) * factor, 1);
      const epos = Math.min((sp.end - cycle) * factor, 1);
      if (bpos >= 1) return [];
      const haps = pat.query({ ...st, span: span(cycle + bpos, cycle + epos) });
      const out = [];
      for (const h of haps) {
        const b = h.part.begin;
        const e = h.part.end;
        const newPart = span(cycle + Math.min((b - cycle) / factor, 1), cycle + Math.min((e - cycle) / factor, 1));
        const newWhole = h.whole
          ? span(newPart.begin - (b - h.whole.begin) / factor, newPart.end + (h.whole.end - e) / factor)
          : null;
        out.push(new Hap(newWhole, newPart, h.value, h.context));
      }
      return out;
    }).splitQueries();
  }

  /** Squeeze each cycle into the [b, e) portion of the cycle, leaving a gap. */
  _compress(b, e) {
    if (b > e || b > 1 || e > 1 || b < 0 || e < 0 || Math.abs(e - b) < EPS) return silence;
    return this._fastGap(1 / (e - b))._late(b);
  }

  /** Like compress, but without the gap (pattern continues outside). */
  _focus(b, e) {
    return this._early(sam(b))._fast(1 / (e - b))._late(b);
  }
  _focusSpan(sp) { return this._focus(sp.begin, sp.end); }

  _zoom(s, e) {
    const d = e - s;
    if (d <= 0) return silence;
    const withCycle = (sp, f) => {
      const c = sam(sp.begin);
      return span(c + f(sp.begin - c), c + f(sp.end - c));
    };
    return this.withQuerySpan((sp) => withCycle(sp, (t) => t * d + s))
      .withHapSpan((sp) => withCycle(sp, (t) => (t - s) / d))
      .splitQueries();
  }

  _degradeByWith(withPat, x) {
    return this.fmap((a) => () => a).appLeft(withPat.filterValues((v) => v >= x));
  }
  _degradeBy(x) { return this._degradeByWith(rand, toNumeral(x)); }
  _undegradeBy(x) { return this._degradeByWith(rand.fmap((r) => 1 - r), toNumeral(x)); }

  rev() {
    const pat = this;
    return new Pattern((st) => {
      const sp = st.span;
      const cycle = sam(sp.begin);
      const next = cycle + 1;
      const reflect = (s) => span(cycle + (next - s.end), cycle + (next - s.begin));
      return pat.query({ ...st, span: reflect(sp) }).map((h) => h.withSpan(reflect));
    }).splitQueries();
  }

  toString() { return '[Pattern]'; }
}

// -------------------------------------------------------------------------------- constructors

export const silence = new Pattern(() => []);

export function pure(value, context) {
  return new Pattern((st) =>
    spanCycles(st.span).map((sp) => {
      const c = sam(sp.begin);
      return new Hap(span(c, c + 1), sp, value, context);
    }),
  );
}

/** Same pattern without source locations (for strings whose positions are unknown). */
export function stripLocations(pat) {
  return new Pattern((st) => pat.query(st).map((h) => (h.context?.locations ? new Hap(h.whole, h.part, h.value, { ...h.context, locations: undefined }) : h)));
}

/** Same pattern, with every hap's source locations shifted by `offset` characters. */
export function shiftLocations(pat, offset) {
  if (!offset) return pat;
  return new Pattern((st) => pat.query(st).map((h) => {
    const locs = h.context?.locations;
    if (!locs) return h;
    return new Hap(h.whole, h.part, h.value, { ...h.context, locations: locs.map((l) => ({ start: l.start + offset, end: l.end + offset })) });
  }));
}

export function isPattern(x) { return x instanceof Pattern; }

/** Turns anything into a pattern: strings are parsed as mini-notation, arrays become sequences. */
export function reify(x) {
  if (x instanceof Pattern) return x;
  if (typeof x === 'string') return mini(x);
  if (Array.isArray(x)) return sequence(...x);
  if (x === undefined) return silence;
  return pure(x);
}

export function stack(...pats) {
  pats = pats.map(reify);
  if (pats.length === 1) return pats[0];
  return new Pattern((st) => pats.flatMap((p) => p.query(st)));
}

/** Concatenation, one pattern per cycle (Strudel `cat`/`slowcat`). */
export function slowcat(...pats) {
  pats = pats.map(reify);
  if (pats.length === 0) return silence;
  if (pats.length === 1) return pats[0];
  const n = pats.length;
  return new Pattern((st) => {
    const sp = st.span;
    const cyc = sam(sp.begin);
    const pat = pats[mod(cyc, n)];
    const offset = cyc - Math.floor(cyc / n);
    if (!offset) return pat.query(st);
    return pat
      .query({ ...st, span: span(sp.begin - offset, sp.end - offset) })
      .map((h) => h.withSpan((s) => span(s.begin + offset, s.end + offset)));
  }).splitQueries();
}

/** Like slowcat but always uses absolute cycle numbers (used by firstOf / lastOf). */
export function slowcatPrime(...pats) {
  pats = pats.map(reify);
  return new Pattern((st) => pats[mod(sam(st.span.begin), pats.length)].query(st)).splitQueries();
}

export function fastcat(...pats) {
  if (pats.length === 0) return silence;
  return slowcat(...pats)._fast(pats.length);
}
export const cat = slowcat;
export function sequence(...xs) { return xs.length === 1 && !Array.isArray(xs[0]) ? reify(xs[0]) : fastcat(...xs); }
export const seq = sequence;

/** timeCat([3, a], [1, b]) — weighted sequence. Plain patterns count as weight 1. */
export function timeCat(...pairs) {
  pairs = pairs.map((p) => (Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' ? p : [1, p]));
  const total = pairs.reduce((s, [w]) => s + w, 0);
  if (!total) return silence;
  let b = 0;
  const pats = [];
  for (const [w, p] of pairs) {
    if (w <= 0) continue;
    const e = b + w;
    pats.push(reify(p)._compress(b / total, e / total));
    b = e;
  }
  return stack(...pats);
}
export const timecat = timeCat;

/** arrange([4, a], [2, b]) — sections lasting n cycles each, looping. */
export function arrange(...sections) {
  const total = sections.reduce((s, [c]) => s + c, 0);
  return timeCat(...sections.map(([c, p]) => [c, reify(p)._fast(c)]))._slow(total);
}

function stepCount(x) {
  if (Array.isArray(x)) return x.length;
  return 1;
}

/** polymeter(["a","b","c"], ["d","e"]) — aligns steps; steps per cycle = first layer (or polymeterSteps). */
export function polymeterSteps(steps, ...layers) {
  layers = layers.filter((l) => stepCount(l) > 0);
  if (!layers.length) return silence;
  return stack(
    ...layers.map((l) => {
      const arr = Array.isArray(l) ? l : [l];
      return fastcat(...arr)._fast(steps / arr.length);
    }),
  );
}
export function polymeter(...layers) {
  layers = layers.filter((l) => stepCount(l) > 0);
  if (!layers.length) return silence;
  return polymeterSteps(stepCount(layers[0]), ...layers);
}
/** polyrhythm("a b c", "d e") — each sequence fills a whole cycle. */
export function polyrhythm(...xs) { return stack(...xs.map((x) => (Array.isArray(x) ? sequence(...x) : reify(x)))); }

export function run(n) {
  return patternifyArgs([n], (k) => fastcat(...Array.from({ length: Math.max(0, Math.floor(toNumeral(k))) }, (_, i) => i)));
}

// ------------------------------------------------------------------------------------- signals

export function signal(f) {
  return new Pattern((st) => [new Hap(null, st.span, f(st.span.begin))]);
}
const xorwise = (x) => {
  const a = (x << 13) ^ x;
  const b = (a >> 17) ^ a;
  return (b << 5) ^ b;
};
const frac = (x) => x - Math.trunc(x);
const timeToIntSeed = (x) => xorwise(Math.trunc(frac(x / 300) * 536870912));
const intSeedToRand = (x) => (x % 536870912) / 536870912;
/** Deterministic pseudo-random number in [0,1) for a time (same algorithm as Strudel). */
export const timeToRand = (x) => Math.abs(intSeedToRand(timeToIntSeed(x)));

export const saw = signal((t) => mod(t, 1));
export const isaw = signal((t) => 1 - mod(t, 1));
export const sine = signal((t) => (Math.sin(Math.PI * 2 * t) + 1) / 2);
export const cosine = sine._early(0.25);
export const square = signal((t) => Math.floor(mod(t, 1) * 2));
export const tri = fastcat(saw, isaw);
export const rand = signal(timeToRand);
const smoother = (x) => 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
export const perlin = signal((t) => {
  const a = Math.floor(t);
  const ra = timeToRand(a);
  const rb = timeToRand(a + 1);
  return ra + smoother(t - a) * (rb - ra);
});
const bipolar = (p) => p.fmap((v) => v * 2 - 1);
export const saw2 = bipolar(saw);
export const isaw2 = bipolar(isaw);
export const sine2 = bipolar(sine);
export const cosine2 = bipolar(cosine);
export const square2 = bipolar(square);
export const tri2 = bipolar(tri);
export const rand2 = bipolar(rand);

export function irand(n) {
  return patternifyArgs([n], (k) => rand.fmap((x) => Math.trunc(x * toNumeral(k))));
}
/** Continuous random choice from the given values. */
export function choose(...xs) {
  return rand.fmap((r) => xs[Math.min(xs.length - 1, Math.floor(r * xs.length))]);
}
/** Picks one of the patterns at random each cycle (Strudel `chooseCycles` / `randcat`). */
export function chooseCycles(...pats) {
  return chooseInWith(rand._segment(1), pats.map(reify));
}
export const randcat = chooseCycles;
export function chooseInWith(randPat, pats) {
  if (!pats.length) return silence;
  return randPat.fmap((r) => pats[Math.min(pats.length - 1, Math.floor(r * pats.length))]).innerJoin();
}

// ------------------------------------------------------------------------- patterned methods

function isPlainArg(a) {
  return !(a instanceof Pattern) && typeof a !== 'string' && !Array.isArray(a);
}

/**
 * Calls fn with plain values. If any argument is a pattern / mini string, the result is
 * patterned over the argument values (Strudel `register` semantics: innerJoin).
 */
export function patternifyArgs(args, fn) {
  if (args.every(isPlainArg)) return fn(...args);
  const pats = args.map(reify);
  let argPat = pats[0].fmap((a) => [a]);
  for (let i = 1; i < pats.length; i++) argPat = argPat.fmap((arr) => (b) => arr.concat([b])).appLeft(pats[i]);
  return argPat.fmap((arr) => fn(...arr)).innerJoin();
}

/** name -> number of leading arguments before the pattern (for curried top-level functions). */
export const METHOD_ARITY = {};
const P = Pattern.prototype;

function method(names, nPat, impl, nFunc = 0) {
  const f = function (...args) {
    const rest = args.slice(nPat);
    return patternifyArgs(args.slice(0, nPat), (...a) => impl.call(this, ...a, ...rest));
  };
  for (const n of [].concat(names)) {
    P[n] = f;
    METHOD_ARITY[n] = nPat + nFunc;
  }
}
function plainMethod(names, arity, impl) {
  for (const n of [].concat(names)) {
    P[n] = impl;
    METHOD_ARITY[n] = arity;
  }
}

/** Accepts a function, or a pattern (meaning "merge these controls"). */
export function asFunc(f) {
  if (typeof f === 'function') return f;
  if (f instanceof Pattern || isObj(f) || typeof f === 'string') return (p) => p.set(f);
  return (p) => p;
}

const toNum = (v) => toNumeral(v);

// time
method(['fast', 'density'], 1, function (f) { return this._fast(f); });
method(['slow', 'sparsity'], 1, function (f) { return this._slow(f); });
method('early', 1, function (t) { return this._early(t); });
method('late', 1, function (t) { return this._late(t); });
method('hurry', 1, function (r) {
  r = toNum(r);
  return this._fast(r).fmap((v) => (isObj(v) ? { ...v, speed: (v.speed ?? 1) * r } : v));
});
method('ply', 1, function (n) { return this.fmap((x) => pure(x)._fast(toNum(n))).squeezeJoin(); });
method(['compress'], 2, function (b, e) { return this._compress(toNum(b), toNum(e)); });
method(['zoom', 'zoomArc'], 2, function (b, e) { return this._zoom(toNum(b), toNum(e)); });
method('fastGap', 1, function (f) { return this._fastGap(toNum(f)); });
method('focus', 2, function (b, e) { return this._focus(toNum(b), toNum(e)); });
method('linger', 1, function (t) {
  t = toNum(t);
  if (!t) return silence;
  if (t < 0) return this._zoom(1 + t, 1)._slow(-t);
  return this._zoom(0, t)._slow(t);
});
method('segment', 1, function (n) { return this._segment(n); });
P._segment = function (n) { return this.struct(pure(true)._fast(toNum(n))); };
method('iter', 1, function (n) {
  n = Math.max(1, Math.floor(toNum(n)));
  return slowcat(...Array.from({ length: n }, (_, i) => this._early(i / n)));
});
method('iterBack', 1, function (n) {
  n = Math.max(1, Math.floor(toNum(n)));
  return slowcat(...Array.from({ length: n }, (_, i) => this._late(i / n)));
});
plainMethod('rev', 0, P.rev);
plainMethod('palindrome', 0, function () { return this.lastOf(2, (p) => p.rev()); });
method('loopAt', 1, function (n) {
  n = toNum(n);
  return this._slow(n).fmap((v) => (isObj(v) ? { ...v, speed: (1 / n) * (v.speed ?? 1), unit: 'c' } : v));
});
method('swingBy', 2, function (x, n) { return this.inside(n, (p) => p.late(fastcat(0, toNum(x) / 2))); });
method('swing', 1, function (n) { return this.swingBy(1 / 3, n); });

// conditionals / randomness
method(['firstOf', 'every'], 1, function (n, f) {
  n = Math.max(1, Math.floor(toNum(n)));
  const pats = Array(n - 1).fill(this);
  pats.unshift(asFunc(f)(this));
  return slowcatPrime(...pats);
}, 1);
method('lastOf', 1, function (n, f) {
  n = Math.max(1, Math.floor(toNum(n)));
  const pats = Array(n - 1).fill(this);
  pats.push(asFunc(f)(this));
  return slowcatPrime(...pats);
}, 1);
plainMethod('when', 2, function (binary, f) {
  const bin = reify(binary);
  const yes = bin.filterValues(truthy).fmap(() => (y) => y).appRight(asFunc(f)(this));
  const no = bin.filterValues((v) => !truthy(v)).fmap(() => (y) => y).appRight(this);
  return stack(yes, no);
});
method('degradeBy', 1, function (x) { return this._degradeBy(x); });
method('undegradeBy', 1, function (x) { return this._undegradeBy(x); });
plainMethod('degrade', 0, function () { return this._degradeBy(0.5); });
method('sometimesBy', 1, function (x, f) {
  x = toNum(x);
  return stack(this._degradeBy(x), asFunc(f)(this._undegradeBy(1 - x)));
}, 1);
const sometimesAlias = (name, x) => plainMethod(name, 1, function (f) { return this.sometimesBy(x, f); });
sometimesAlias('sometimes', 0.5);
sometimesAlias('often', 0.75);
sometimesAlias('rarely', 0.25);
sometimesAlias('almostNever', 0.1);
sometimesAlias('almostAlways', 0.9);
plainMethod('always', 1, function (f) { return asFunc(f)(this); });
plainMethod('never', 1, function () { return this; });
method('someCyclesBy', 1, function (x, f) {
  x = toNum(x);
  return this.when(rand._segment(1).fmap((r) => r < x), f);
}, 1);
plainMethod('someCycles', 1, function (f) { return this.someCyclesBy(0.5, f); });
method('chunk', 1, function (n, f) {
  n = Math.max(1, Math.floor(toNum(n)));
  const bin = fastcat(true, ...Array(n - 1).fill(false)).iterBack(n);
  return this.when(bin, f);
}, 1);
method('chunkBack', 1, function (n, f) {
  n = Math.max(1, Math.floor(toNum(n)));
  const bin = fastcat(true, ...Array(n - 1).fill(false)).iter(n);
  return this.when(bin, f);
}, 1);
plainMethod('brak', 0, function () {
  return this.when(slowcat(false, true), (x) => fastcat(x, silence)._late(0.25));
});

// structure
export function truthy(v) {
  if (v === NONE || v === undefined || v === null) return false;
  if (typeof v === 'string') return !['f', 'false', '0', '~', ''].includes(v.toLowerCase());
  if (typeof v === 'number') return v !== 0;
  return !!v;
}
plainMethod('struct', 1, function (bools) {
  return reify(bools).fmap((b) => (v) => (truthy(b) ? v : NONE)).appLeft(this).filterValues((v) => v !== NONE);
});
plainMethod('mask', 1, function (bools) {
  return this.fmap((v) => (b) => (truthy(b) ? v : NONE)).appLeft(reify(bools)).filterValues((v) => v !== NONE);
});

/** Bjorklund's algorithm (port of Strudel/Tidal). bjork(3,8) -> [1,0,0,1,0,0,1,0]. */
export function bjork(ons, steps) {
  ons = Math.floor(ons);
  steps = Math.floor(steps);
  if (steps <= 0) return [];
  const inverted = ons < 0;
  ons = Math.min(Math.abs(ons), steps);
  const offs = steps - ons;
  const go = (n, x) => {
    const [o, f] = n;
    if (Math.min(o, f) <= 1) return [n, x];
    const [xs, ys] = x;
    if (o > f) {
      const a = xs.slice(0, f), b = xs.slice(f);
      return go([f, o - f], [a.map((v, i) => v.concat(ys[i])), b]);
    }
    const a = ys.slice(0, o), b = ys.slice(o);
    return go([o, f - o], [xs.map((v, i) => v.concat(a[i])), b]);
  };
  const res = go([ons, offs], [Array.from({ length: ons }, () => [1]), Array.from({ length: offs }, () => [0])]);
  const flat = res[1][0].flat().concat(res[1][1].flat());
  return inverted ? flat.map((v) => 1 - v) : flat;
}
const rotateArr = (arr, n) => {
  if (!arr.length) return arr;
  n = mod(n, arr.length);
  return arr.slice(n).concat(arr.slice(0, n));
};
export function euclidBools(k, n, r = 0) {
  return rotateArr(bjork(k, n), Math.floor(r || 0)).map((v) => v === 1);
}
method('euclid', 2, function (k, n) { return this.struct(fastcat(...euclidBools(toNum(k), toNum(n)))); });
method(['euclidRot', 'euclidrot'], 3, function (k, n, r) {
  return this.struct(fastcat(...euclidBools(toNum(k), toNum(n), toNum(r ?? 0))));
});
method('euclidLegato', 2, function (k, n) { return this._euclidLegato(toNum(k), toNum(n), 0); });
method('euclidLegatoRot', 3, function (k, n, r) { return this._euclidLegato(toNum(k), toNum(n), toNum(r ?? 0)); });
P._euclidLegato = function (k, n, r) {
  if (k <= 0) return silence;
  const bools = euclidBools(k, n, r).map((b) => (b ? 1 : 0));
  const first = bools.indexOf(1);
  if (first < 0) return silence;
  const gapless = rotateArr(bools, first).join('').split('1').slice(1).map((s) => [s.length + 1, true]);
  return this.struct(timeCat(...gapless))._late(first / n);
};

// layering
method('off', 1, function (t, f) { return stack(this, asFunc(f)(this._late(t))); }, 1);
plainMethod('superimpose', 1, function (f) { return stack(this, asFunc(f)(this)); });
plainMethod('layer', 1, function (...fs) { return stack(...fs.map((f) => asFunc(f)(this))); });
plainMethod('apply', 1, function (f) { return asFunc(f)(this); });
method('juxBy', 1, function (by, f) {
  by = toNum(by);
  const panned = (d) => this.fmap((v) => ({ ...toObj(v), pan: (toObj(v).pan ?? 0.5) + d }));
  return stack(panned(-by / 2), asFunc(f)(panned(by / 2)));
}, 1);
plainMethod('jux', 1, function (f) { return this.juxBy(1, f); });
method('echo', 3, function (count, time, feedback) {
  count = Math.max(1, Math.floor(toNum(count)));
  return stack(...Array.from({ length: count }, (_, i) => this._late(toNum(time) * i).velocity(Math.pow(toNum(feedback), i))));
});
method('inside', 1, function (n, f) { n = toNum(n); return asFunc(f)(this._slow(n))._fast(n); }, 1);
method('outside', 1, function (n, f) { return this.inside(1 / toNum(n), f); }, 1);
plainMethod('stack', 0, function (...others) { return stack(this, ...others); });
plainMethod('seq', 0, function (...others) { return fastcat(this, ...others); });
plainMethod('cat', 0, function (...others) { return slowcat(this, ...others); });

// arpeggios & sample slicing
plainMethod('arp', 1, function (indices) {
  const idx = reify(indices);
  return this.collect().fmap((group) => idx.fmap((i) => group[mod(Math.floor(toNum(i)) || 0, group.length)])).innerJoin();
});
plainMethod('arpeggiate', 0, function () {
  return this.collect().fmap((g) => fastcat(...g.map((v) => pure(v)))).squeezeJoin();
});
method('chop', 1, function (n) {
  n = Math.max(1, Math.floor(toNum(n)));
  return this.fmap((v) => {
    const o = toObj(v, 's');
    const b = o.begin ?? 0;
    const d = (o.end ?? 1) - b;
    return fastcat(...Array.from({ length: n }, (_, i) => pure({ ...o, begin: b + (d * i) / n, end: b + (d * (i + 1)) / n })));
  }).squeezeJoin();
});
method('striate', 1, function (n) {
  n = Math.max(1, Math.floor(toNum(n)));
  return fastcat(...Array.from({ length: n }, (_, i) => this.set({ begin: i / n, end: (i + 1) / n })));
});

// values / arithmetic
function toObj(v, key = 'value') {
  if (isObj(v)) return v;
  if (v === undefined || v === null) return {};
  return { [key]: v };
}
function mergeValues(a, b) {
  if (!isObj(b)) return isObj(a) ? { ...a, value: b } : b;
  return { ...toObj(a), ...b };
}
plainMethod('set', 1, function (x) {
  return this.fmap((a) => (b) => mergeValues(a, b)).appLeft(reify(x));
});
plainMethod('keep', 1, function (x) {
  return this.fmap((a) => (b) => mergeValues(b, a)).appLeft(reify(x));
});

function numKey(o) {
  for (const k of ['note', 'n', 'freq', 'value']) if (k in o) return k;
  return null;
}
function applyOp(a, b, op) {
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = k in a ? op(toNumeral(a[k]), toNumeral(b[k])) : b[k];
    return out;
  }
  if (isObj(a)) {
    const k = numKey(a);
    return k ? { ...a, [k]: op(toNumeral(a[k]), toNumeral(b)) } : a;
  }
  if (isObj(b)) {
    const k = numKey(b);
    return k ? { ...b, [k]: op(toNumeral(a), toNumeral(b[k])) } : b;
  }
  return op(toNumeral(a), toNumeral(b));
}
const OPS = {
  add: (x, y) => x + y,
  sub: (x, y) => x - y,
  mul: (x, y) => x * y,
  div: (x, y) => x / y,
  mod: (x, y) => mod(x, y),
  pow: (x, y) => Math.pow(x, y),
};
for (const [name, op] of Object.entries(OPS)) {
  plainMethod(name, 1, function (x) {
    return this.fmap((a) => (b) => applyOp(a, b, op)).appLeft(reify(x));
  });
}
const mapNum = (f) => (v) => {
  if (isObj(v)) { const k = numKey(v); return k ? { ...v, [k]: f(toNumeral(v[k])) } : v; }
  return f(toNumeral(v));
};
plainMethod('round', 0, function () { return this.fmap(mapNum(Math.round)); });
plainMethod('floor', 0, function () { return this.fmap(mapNum(Math.floor)); });
plainMethod('ceil', 0, function () { return this.fmap(mapNum(Math.ceil)); });
method('range', 2, function (lo, hi) {
  lo = toNum(lo); hi = toNum(hi);
  return this.fmap(mapNum((v) => v * (hi - lo) + lo));
});
method('rangex', 2, function (lo, hi) {
  lo = Math.log(toNum(lo)); hi = Math.log(toNum(hi));
  return this.fmap(mapNum((v) => Math.exp(v * (hi - lo) + lo)));
});
plainMethod('toBipolar', 0, function () { return this.fmap(mapNum((v) => v * 2 - 1)); });
plainMethod('fromBipolar', 0, function () { return this.fmap(mapNum((v) => (v + 1) / 2)); });

// tonal
method('scale', 1, function (name) {
  const sc = parseScale(name);
  return this.fmap((v) => {
    if (isObj(v)) {
      const step = v.n ?? v.note ?? v.value;
      if (step === undefined || isNoteName(step)) return v;
      const { n, value, ...rest } = v;
      return { ...rest, note: scaleStep(step, sc) };
    }
    return isNoteName(v) ? v : scaleStep(v, sc);
  });
});
method('transpose', 1, function (semis) {
  const t = toNum(semis);
  return this.fmap((v) => {
    if (isObj(v)) {
      const k = 'note' in v ? 'note' : 'n' in v ? 'n' : 'value' in v ? 'value' : null;
      return k ? { ...v, [k]: toNumeral(v[k]) + t } : v;
    }
    return toNumeral(v) + t;
  });
});
plainMethod('voicing', 0, function () {
  return this.flatMapValues((v) => {
    const o = toObj(v, 'chord');
    if (o.chord === undefined) return [v];
    let mode = o.mode ?? 'below';
    let anchor = o.anchor ?? 72;
    if (Array.isArray(mode)) { if (mode[1] !== undefined) anchor = mode[1]; mode = mode[0]; }
    else if (typeof mode === 'string' && mode.includes(':')) { const [m, a] = mode.split(':'); mode = m; if (a) anchor = a; }
    if (Array.isArray(anchor)) anchor = anchor[0];
    const notes = voiceChord(o.chord, { anchor, mode: mode === 'duck' ? 'below' : mode });
    const off = Math.round(toNumeral(o.offset ?? 0)) || 0;
    for (let k = 0; k < Math.abs(off); k++) {
      if (off > 0) notes.push(notes.shift() + 12);
      else notes.unshift(notes.pop() - 12);
    }
    const { chord, anchor: _a, mode: _m, dict, offset, value, ...rest } = o;
    if (rest.n !== undefined) {
      const i = Math.floor(toNumeral(rest.n));
      const { n, ...r2 } = rest;
      const len = notes.length;
      return [{ ...r2, note: notes[mod(i, len)] + 12 * Math.floor(i / len) }];
    }
    return notes.map((note) => ({ ...rest, note }));
  });
});
METHOD_ARITY.rootNotes = 0;
P.rootNotes = function (octave = 2) {
  return patternifyArgs([octave], (oct) => this.fmap((v) => {
    const o = toObj(v, 'chord');
    if (o.chord === undefined) return v;
    const { chord, value, ...rest } = o;
    return { ...rest, note: chordRootMidi(chord, toNum(oct)) };
  }));
};

// misc / visual no-ops
const VISUALS = ['pianoroll', 'punchcard', 'scope', 'tscope', 'fscope', 'spiral', 'pitchwheel', 'spectrum',
  'wordfall', 'markcss', 'analyze', 'draw', 'play', 'log', 'logValues', 'hydra'];
for (const v of VISUALS) {
  plainMethod(v, 0, function () { return this; });
  plainMethod('_' + v, 0, function () { return this; });
}
plainMethod('hush', 0, function () { return silence; });
plainMethod('silence', 0, function () { return silence; });

// registration hook used by `.p("name")` during evaluation (set by strudel.js)
let patternRegistrar = null;
export function setPatternRegistrar(fn) { patternRegistrar = fn; }
plainMethod(['p', 'q'], 1, function (name) {
  if (patternRegistrar) patternRegistrar(name, this);
  return this;
});

// ------------------------------------------------------------------------------------ controls

/** [canonical name, ...aliases]. Values are merged into the hap value object. */
export const CONTROLS = [
  ['s', 'sound'], ['n'], ['note'], ['freq'], ['gain'], ['velocity', 'vel'], ['pan'], ['speed'],
  ['begin'], ['end'], ['cut'], ['bank'], ['vowel'], ['cutoff', 'lpf', 'ctf', 'lp'], ['resonance', 'lpq'],
  ['hcutoff', 'hpf', 'hp'], ['hresonance', 'hpq'], ['bandf', 'bpf', 'bp'], ['bandq', 'bpq'], ['crush'],
  ['coarse'], ['shape'], ['distort', 'dist'], ['room'], ['size', 'roomsize', 'sz'], ['delay'],
  ['delaytime', 'delayt', 'dt'], ['delayfeedback', 'delayfb', 'dfb'], ['attack', 'att'], ['decay', 'dec'],
  ['sustain', 'sus'], ['release', 'rel'], ['legato'], ['clip'], ['orbit'], ['lpenv', 'lpe'],
  ['lpattack', 'lpa'], ['lpdecay', 'lpd'], ['lpsustain', 'lps'], ['lprelease', 'lpr'], ['fm', 'fmi'],
  ['fmh'], ['vib', 'vibrato'], ['vibmod', 'vmod'], ['detune', 'det'], ['unison'], ['postgain'],
  ['duck', 'duckorbit'], ['dry'], ['chord'], ['anchor'], ['mode'], ['dict'], ['offset'], ['unit'], ['loop'],
  ['phaser', 'ph'], ['tremolo'], ['amp'], ['channel'], ['dur'], ['penv'], ['noise'], ['squiz'],
];
// `color` is kept as a visual no-op in Strudel's REPL; we still record it as a value key.
CONTROLS.push(['color', 'colour']);

/** alias -> canonical control name */
export const CONTROL_ALIASES = {};
for (const [name, ...aliases] of CONTROLS) for (const a of [name, ...aliases]) CONTROL_ALIASES[a] = name;

function controlValue(name, v) {
  if (Array.isArray(v)) {
    if (name === 's') {
      const o = { s: v[0] };
      if (v[1] !== undefined) o.n = v[1];
      if (v[2] !== undefined) o.gain = v[2];
      return o;
    }
    if (name === 'note' || name === 'n') {
      const o = { [name]: v[0] };
      if (v[1] !== undefined) o.s = v[1];
      return o;
    }
    if (name === 'mode') return { mode: v };
    return { [name]: v[0] };
  }
  return { [name]: v };
}

/** Top-level control functions: s("bd sd"), note("c3 e3"), gain(.5) ... */
export const controls = {};
for (const [name, ...aliases] of CONTROLS) {
  const ctor = (...args) => {
    const x = args.length > 1 ? sequence(...args) : args[0];
    return reify(x).fmap((v) => (isObj(v) ? v : controlValue(name, v)));
  };
  const meth = function (...args) {
    if (args.length === 0) return this.fmap((v) => (isObj(v) ? v : controlValue(name, v)));
    return this.set(ctor(...args));
  };
  for (const a of [name, ...aliases]) {
    controls[a] = ctor;
    P[a] = meth;
  }
}

// ------------------------------------------------------------------------------ registration

/** Strudel-style `register(name, (arg..., pat) => pattern)`: adds a method + a curried function. */
export function register(name, fn) {
  const arity = Math.max(0, fn.length - 1);
  P[name] = function (...args) { return fn(...args, this); };
  METHOD_ARITY[name] = arity;
  return curried(name);
}

/** Top-level, curried version of a method: fast(2)("bd sd") or fast(2, "bd sd"). */
export function curried(name) {
  return (...args) => {
    const ar = METHOD_ARITY[name] ?? 0;
    if (args.length > ar) return reify(args[args.length - 1])[name](...args.slice(0, -1));
    return (pat) => reify(pat)[name](...args);
  };
}
