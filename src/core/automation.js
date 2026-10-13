// Automation lanes — pure helpers (Node-safe). See docs/ARCHITECTURE.md "Automation".
//
//   AutomationLane { id, target, points:[{beat, value}], enabled }
//   target: 'volume' | 'pan' | 'send:<busId>' | 'inst:<paramKey>' | 'fx:<fxId>:<paramKey>'
//
// Points are kept sorted by beat. Between points the value is interpolated linearly; before the
// first point the first value is held, after the last point the last value is held.
// Automation plays in SONG mode only (lanes are positioned on the arrangement timeline).
import { uid, clamp } from './util.js';

export const MIXER_TARGETS = {
  volume: { key: 'volume', label: 'Volume', type: 'number', min: 0, max: 1.5, default: 0.8, step: 0.01, curve: 'lin' },
  pan: { key: 'pan', label: 'Pan', type: 'number', min: -1, max: 1, default: 0, step: 0.01, curve: 'lin' },
  send: { key: 'send', label: 'Send', type: 'number', min: 0, max: 1, default: 0, step: 0.01, curve: 'lin' },
};

/** 'fx:fx_1:cutoff' -> { kind:'fx', fxId:'fx_1', key:'cutoff' }; unknown -> null. */
export function parseTarget(target) {
  if (typeof target !== 'string' || !target) return null;
  if (target === 'volume' || target === 'pan') return { kind: target, key: target };
  const i = target.indexOf(':');
  if (i < 0) return null;
  const kind = target.slice(0, i);
  const rest = target.slice(i + 1);
  if (kind === 'send' && rest) return { kind: 'send', busId: rest, key: rest };
  if (kind === 'inst' && rest) return { kind: 'inst', key: rest };
  if (kind === 'fx') {
    const j = rest.indexOf(':');
    if (j > 0 && j < rest.length - 1) return { kind: 'fx', fxId: rest.slice(0, j), key: rest.slice(j + 1) };
  }
  return null;
}

export const targetString = {
  volume: () => 'volume',
  pan: () => 'pan',
  send: (busId) => `send:${busId}`,
  inst: (key) => `inst:${key}`,
  fx: (fxId, key) => `fx:${fxId}:${key}`,
};

export function createAutomationLane(target, points = [], opts = {}) {
  return { id: opts.id || uid('aut'), target, points: sortPoints(points.map((p) => ({ beat: +p.beat, value: +p.value }))), enabled: opts.enabled !== false };
}

/** Sort (stable) by beat; drops non-finite points. Returns a new array. */
export function sortPoints(points) {
  return (points || []).filter((p) => p && isFinite(p.beat) && isFinite(p.value))
    .map((p, i) => [p, i]).sort((a, b) => a[0].beat - b[0].beat || a[1] - b[1]).map((x) => x[0]);
}

/** Normalize a lane loaded from JSON (keeps unknown targets, they are ignored at playback). */
export function normalizeLane(l) {
  return {
    id: l?.id || uid('aut'),
    target: typeof l?.target === 'string' ? l.target : 'volume',
    points: sortPoints(Array.isArray(l?.points) ? l.points.map((p) => ({ beat: Math.max(0, Number(p?.beat)), value: Number(p?.value) })) : []),
    enabled: l?.enabled !== false,
  };
}

/** Index of the last point with beat <= b (-1 if none). Binary search; points sorted. */
function lastIndexAtOrBefore(points, b) {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].beat <= b) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Interpolated value at `beat`. Empty lane -> fallback. */
export function valueAt(points, beat, fallback = null) {
  const n = points?.length || 0;
  if (!n) return fallback;
  if (beat <= points[0].beat) return points[0].value;
  if (beat >= points[n - 1].beat) return points[n - 1].value;
  const i = lastIndexAtOrBefore(points, beat);
  const a = points[i], b = points[i + 1];
  const span = b.beat - a.beat;
  if (!(span > 0)) return b.value; // vertical jump: the later point wins once reached
  return a.value + (b.value - a.value) * ((beat - a.beat) / span);
}

/**
 * Breakpoints to ramp through for the half-open window (b0, b1]: every point strictly inside the
 * window, then the interpolated value at b1. Start value = valueAt(points, b0).
 * Vertical jumps (two points at the same beat) inside the window are returned as both points.
 * -> [{beat, value}] (always ends with {beat:b1})
 */
export function segmentsInWindow(points, b0, b1) {
  const out = [];
  if (!points?.length || !(b1 > b0)) return out;
  let i = lastIndexAtOrBefore(points, b0) + 1;
  for (; i < points.length && points[i].beat < b1; i++) out.push({ beat: points[i].beat, value: points[i].value });
  out.push({ beat: b1, value: valueAt(points, b1) });
  return out;
}

/** Lanes that should play (enabled, with points, valid target). */
export function activeLanes(owner) {
  const list = owner?.automation;
  if (!Array.isArray(list) || !list.length) return [];
  return list.filter((l) => l && l.enabled !== false && l.points?.length && parseTarget(l.target));
}

/**
 * Control-rate overrides for one track at `beat`:
 *   { inst: {key: value} | null, fx: { fxId: {key: value} } | null }
 * (mixer targets are handled with AudioParam ramps, see mixer.js)
 */
export function controlOverrides(track, beat) {
  let inst = null, fx = null;
  for (const l of activeLanes(track)) {
    const t = parseTarget(l.target);
    if (t.kind === 'inst') { (inst ||= {})[t.key] = valueAt(l.points, beat); }
    else if (t.kind === 'fx') { fx ||= {}; (fx[t.fxId] ||= {})[t.key] = valueAt(l.points, beat); }
  }
  return { inst, fx };
}

/** Does the project contain inst:/fx: automation that needs control-rate evaluation? */
export function hasControlAutomation(project) {
  return (project?.tracks || []).some((t) => activeLanes(t).some((l) => { const k = parseTarget(l.target).kind; return k === 'inst' || k === 'fx'; }));
}

/** Is any automation (incl. master) active in the project? */
export function hasAutomation(project) {
  return activeLanes(project?.master).length > 0 || (project?.tracks || []).some((t) => activeLanes(t).length > 0);
}

// ---------------------------------------------------------------------------- value mapping
/** ParamDef-aware normalization (matches the knobs: 'log' and 'exp' curves). */
export function toNorm(def, v) {
  const min = def?.min ?? 0, max = def?.max ?? 1, curve = def?.curve || 'lin';
  v = clamp(Number(v), min, max);
  if (curve === 'log' && min > 0) return Math.log(v / min) / Math.log(max / min);
  if (curve === 'exp') return Math.sqrt((v - min) / (max - min || 1));
  return (v - min) / (max - min || 1);
}
export function fromNorm(def, n) {
  const min = def?.min ?? 0, max = def?.max ?? 1, curve = def?.curve || 'lin';
  n = clamp(Number(n), 0, 1);
  let v;
  if (curve === 'log' && min > 0) v = min * Math.pow(max / min, n);
  else if (curve === 'exp') v = min + (max - min) * n * n;
  else v = min + (max - min) * n;
  return clamp(+v.toFixed(6), min, max);
}

// ---------------------------------------------------------------------------- editing helpers
/** Replace all points inside [b0, b1] with `fresh` (keeps the rest). Returns a sorted array. */
export function replaceRange(points, b0, b1, fresh) {
  const keep = (points || []).filter((p) => p.beat < b0 - 1e-9 || p.beat > b1 + 1e-9);
  return sortPoints([...keep, ...fresh]);
}

/** Linear ramp from `from` to `to` over [b0, b1] (two points). */
export function rampPoints(b0, b1, from, to) {
  return [{ beat: b0, value: from }, { beat: b1, value: to }];
}

/**
 * LFO-shaped points over [b0, b1]. shape: 'sine'|'triangle'|'saw'|'ramp'|'square'.
 * periodBeats: cycle length. min/max: value range. Sine uses `perCycle` points per cycle.
 */
export function lfoPoints({ b0, b1, shape = 'sine', periodBeats = 4, min = 0, max = 1, perCycle = 16 }) {
  const out = [];
  if (!(b1 > b0) || !(periodBeats > 0)) return out;
  const val = (ph) => {
    switch (shape) {
      case 'triangle': return ph < 0.5 ? ph * 2 : 2 - ph * 2;
      case 'saw': return ph;
      case 'ramp': return 1 - ph;
      case 'square': return ph < 0.5 ? 1 : 0;
      default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
    }
  };
  const scale = (u) => +(min + (max - min) * u).toFixed(6);
  const cycles = (b1 - b0) / periodBeats;
  const r6 = (x) => +x.toFixed(6);
  if (shape === 'square' || shape === 'saw' || shape === 'ramp') {
    const tiny = Math.min(1 / 64, periodBeats / 64);
    for (let k = 0; k < Math.ceil(cycles - 1e-9); k++) {
      const s = b0 + k * periodBeats;
      const e = Math.min(b1, s + periodBeats);
      if (shape === 'square') {
        const mid = Math.min(e, s + periodBeats / 2);
        out.push({ beat: r6(s), value: scale(1) }, { beat: r6(mid - tiny), value: scale(1) });
        if (mid < e - 1e-9) out.push({ beat: r6(mid), value: scale(0) }, { beat: r6(e - tiny), value: scale(0) });
      } else {
        const u0 = shape === 'saw' ? 0 : 1;
        const frac = (e - s) / periodBeats;
        out.push({ beat: r6(s), value: scale(u0) }, { beat: r6(e - tiny), value: scale(shape === 'saw' ? frac : 1 - frac) });
      }
    }
    return out;
  }
  const n = Math.max(2, Math.ceil(cycles * (shape === 'triangle' ? 2 : perCycle)));
  for (let i = 0; i <= n; i++) {
    const b = b0 + ((b1 - b0) * i) / n;
    const ph = (((b - b0) / periodBeats) % 1 + 1) % 1;
    out.push({ beat: r6(b), value: scale(val(ph)) });
  }
  return out;
}
