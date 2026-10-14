// Shared, dependency-free helpers used across every module.

let idCounter = 0;
/** Short unique id with a readable prefix, e.g. uid('trk') -> "trk_lq3k9a_1". */
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}_${idCounter.toString(36)}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g <= 0.000001 ? -120 : 20 * Math.log10(g));
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

export function deepClone(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

/** Seedable PRNG (mulberry32). Generators accept an optional rng for reproducibility. */
export function createRng(seed = Date.now()) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.weighted = (items, weights) => {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  };
  return rng;
}

export class Emitter {
  constructor() { this._l = new Map(); }
  on(evt, fn) {
    if (!this._l.has(evt)) this._l.set(evt, new Set());
    this._l.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._l.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    for (const fn of [...(this._l.get(evt) || [])]) {
      try { fn(...args); } catch (e) { console.error(`[emitter:${evt}]`, e); }
    }
  }
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
