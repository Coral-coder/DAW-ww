// Touch automation lanes — pure editing helpers (Node-testable). Works on the lane model of
// src/core/automation.js ({id, target, points:[{beat, value}], enabled, overridden?}).
// Geometry: a lane box of height `h` (px) with `pad` px top/bottom; x via the view {ppb, x0}.
import { toNorm, fromNorm, sortPoints, replaceRange, rampPoints, lfoPoints, createAutomationLane, automationOwner, valueAt } from '../core/automation.js';
import { quantize } from './param-logic.js';

export const LANE_PAD = 8;
const r6 = (x) => +x.toFixed(6);

export const valueToY = (def, v, h, pad = LANE_PAD) => pad + (1 - toNorm(def, v)) * (h - 2 * pad);
export const yToNorm = (y, h, pad = LANE_PAD) => Math.min(1, Math.max(0, 1 - (y - pad) / Math.max(1, h - 2 * pad)));
export const yToValue = (def, y, h, pad = LANE_PAD) => quantize(def, fromNorm(def, yToNorm(y, h, pad)));

/** Ramer–Douglas–Peucker on [{x, y}] (px): indices of the points to keep (first + last always). */
export function rdp(pts, eps = 1.5) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i].x - dx * pts[i].y + B.x * A.y - B.y * A.x) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Freehand stroke -> thinned lane points. stroke: [{x, y}] in lane px (as the finger moved, may wander back),
 * view {ppb, x0}, lane height h, def. The stroke is made a function of time (a later sample wins for the same
 * x column), thinned with RDP (eps px) and mapped to {beat, value}. Returns {b0, b1, points}.
 */
export function strokeToPoints(stroke, { view, h, def, eps = 1.5, pad = LANE_PAD, snapBeat = null }) {
  const cols = new Map();
  for (const s of stroke || []) cols.set(Math.round(s.x), { x: Math.round(s.x), y: s.y });
  const pts = [...cols.values()].sort((a, b) => a.x - b.x);
  if (!pts.length) return { b0: 0, b1: 0, points: [] };
  const kept = rdp(pts, eps).map((i) => pts[i]);
  const beatOf = (x) => Math.max(0, view.x0 + x / view.ppb);
  let points = kept.map((p) => ({ beat: r6(snapBeat ? snapBeat(beatOf(p.x)) : beatOf(p.x)), value: yToValue(def, p.y, h, pad) }));
  // dedupe equal beats (snapping): keep the last value
  const byBeat = new Map();
  for (const p of points) byBeat.set(p.beat, p);
  points = sortPoints([...byBeat.values()]);
  return { b0: points[0].beat, b1: points[points.length - 1].beat, points };
}

/** Write a stroke into lane points: replaces everything between the stroke's first and last beat. */
export function applyStroke(lanePoints, res) {
  if (!res.points.length) return lanePoints.slice();
  return replaceRange(lanePoints, res.b0, res.b1, res.points);
}

/** Index of the point within r px of (x, y), nearest first; -1 if none. */
export function hitPoint(points, { view, h, def, pad = LANE_PAD }, x, y, r = 22) {
  let best = -1, bd = Infinity;
  (points || []).forEach((p, i) => {
    const d = Math.hypot((p.beat - view.x0) * view.ppb - x, valueToY(def, p.value, h, pad) - y);
    if (d <= r && d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Add a point (sorted). -> {points, idx}. */
export function addPoint(points, beat, value) {
  const np = { beat: r6(Math.max(0, beat)), value };
  const next = sortPoints([...(points || []), np]);
  return { points: next, idx: next.indexOf(np) };
}

/** Move point idx to (beat, value), its beat clamped between its neighbours. -> new points. */
export function movePoint(points, idx, beat, value) {
  if (!points?.[idx]) return (points || []).slice();
  const lo = idx > 0 ? points[idx - 1].beat : 0;
  const hi = idx < points.length - 1 ? points[idx + 1].beat : Infinity;
  const out = points.map((p) => ({ ...p }));
  out[idx] = { beat: r6(Math.min(hi, Math.max(lo, beat))), value };
  return out;
}

export const deletePoint = (points, idx) => (points || []).filter((_, i) => i !== idx);

/**
 * Preset shapes over [b0, b1] in the def's range: 'clear' | 'up' | 'down' | 'sine' | 'triangle' | 'saw' | 'square'.
 * periodBeats for the LFOs. -> new lane points.
 */
export function presetPoints(points, kind, { b0, b1, def, periodBeats = 4 }) {
  if (kind === 'clear') return replaceRange(points, b0, b1, []);
  const map = (u) => quantize(def, fromNorm(def, u));
  let pts = kind === 'up' || kind === 'down' ? rampPoints(b0, b1, kind === 'up' ? 0 : 1, kind === 'up' ? 1 : 0) : lfoPoints({ b0, b1, shape: kind, periodBeats, min: 0, max: 1 });
  pts = pts.map((p) => ({ beat: p.beat, value: map(p.value) }));
  return replaceRange(points, b0, b1, pts);
}

/** Find or create the lane for (owner, target) inside a transact; editing a lane re-enables an overridden one. */
export function ensureLane(p, ownerId, target, { reenable = true } = {}) {
  const o = automationOwner(p, ownerId);
  if (!o) return null;
  o.automation = o.automation || [];
  let lane = o.automation.find((l) => l.target === target);
  if (!lane) { lane = createAutomationLane(target, []); o.automation.push(lane); }
  if (reenable && lane.overridden) delete lane.overridden;
  return lane;
}

export const laneOf = (p, ownerId, target) => automationOwner(p, ownerId)?.automation?.find((l) => l.target === target) || null;

/** The value the lane plays at beat (null when empty) — for the readout. */
export const laneValueAt = (lane, beat) => (lane?.points?.length ? valueAt(lane.points, beat) : null);
