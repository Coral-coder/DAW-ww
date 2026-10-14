// Tempo-map / meter-map editing (pure mutators on a project inside store.transact) + tap tempo.
// See tempo-map.js for the data contract. Invariants kept here:
//   * project.bpm is the tempo at beat 0; project.tempoMap (when non-empty) starts with {beat:0, bpm: project.bpm}.
//   * project.timeSig is the meter of bar 0; project.meterMap holds only changes (bar > 0).
import { songTempoMap, MIN_BPM, MAX_BPM } from './tempo-map.js';

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const clampBpm = (x) => Math.max(MIN_BPM, Math.min(MAX_BPM, r6(Number(x))));

/** Make tempoMap consistent (sorted, first point at 0 mirrors project.bpm, no NaNs). Removes an empty/trivial map. */
export function normalizeTempoMap(project) {
  let pts = (project.tempoMap || []).filter((p) => p && Number.isFinite(+p.beat) && p.beat >= 0 && p.bpm > 0)
    .map((p) => ({ beat: r6(+p.beat), bpm: clampBpm(p.bpm), curve: p.curve === 'linear' ? 'linear' : 'jump' }))
    .sort((a, b) => a.beat - b.beat);
  if (!pts.length) { delete project.tempoMap; return project; }
  if (pts[0].beat > 0) pts.unshift({ beat: 0, bpm: clampBpm(project.bpm), curve: 'jump' });
  pts[0].bpm = clampBpm(project.bpm);
  if (pts.length === 1) { delete project.tempoMap; return project; } // a lone point is just project.bpm
  project.tempoMap = pts;
  return project;
}

/** Add or update the tempo point at `beat` (beat 0 sets project.bpm). Returns the point index. */
export function setTempoPoint(project, beat, bpm, curve) {
  beat = Math.max(0, r6(beat));
  bpm = clampBpm(bpm);
  if (beat < 1e-9) {
    project.bpm = bpm;
    if (project.tempoMap?.length) { project.tempoMap[0].bpm = bpm; if (curve) project.tempoMap[0].curve = curve; }
    else if (curve === 'linear') project.tempoMap = [{ beat: 0, bpm, curve }];
    normalizeTempoMap(project);
    return 0;
  }
  if (!project.tempoMap?.length) project.tempoMap = [{ beat: 0, bpm: project.bpm, curve: 'jump' }];
  const pts = project.tempoMap;
  let i = pts.findIndex((p) => Math.abs(p.beat - beat) < 1e-6);
  if (i >= 0) { pts[i].bpm = bpm; if (curve) pts[i].curve = curve; }
  else { pts.push({ beat, bpm, curve: curve || 'jump' }); }
  normalizeTempoMap(project);
  i = (project.tempoMap || []).findIndex((p) => Math.abs(p.beat - beat) < 1e-6);
  return i;
}

/** Remove the tempo point at index i (> 0). */
export function removeTempoPoint(project, i) {
  if (!project.tempoMap || i <= 0 || i >= project.tempoMap.length) return false;
  project.tempoMap.splice(i, 1);
  normalizeTempoMap(project);
  return true;
}

/** Move point i to beat / bpm (beat clamped between its neighbours; point 0 stays at beat 0). */
export function moveTempoPoint(project, i, beat, bpm) {
  const pts = project.tempoMap;
  if (!pts?.[i]) return;
  if (i === 0) { setTempoPoint(project, 0, bpm ?? pts[0].bpm); return; }
  const lo = pts[i - 1].beat + 1e-3, hi = pts[i + 1] ? pts[i + 1].beat - 1e-3 : Infinity;
  if (beat != null) pts[i].beat = r6(Math.max(lo, Math.min(hi, beat)));
  if (bpm != null) pts[i].bpm = clampBpm(bpm);
  normalizeTempoMap(project);
}

/** Set the curve of the segment after point i ('jump' | 'linear'). */
export function setTempoCurve(project, i, curve) {
  if (!project.tempoMap?.[i]) return;
  project.tempoMap[i].curve = curve === 'linear' ? 'linear' : 'jump';
  normalizeTempoMap(project);
}

/** Linear ramp from beat b0 (bpm0) to beat b1 (bpm1), then hold bpm1. */
export function addTempoRamp(project, b0, bpm0, b1, bpm1) {
  b0 = Math.max(0, r6(b0)); b1 = r6(b1);
  if (!(b1 > b0)) return;
  if (b0 < 1e-9) project.bpm = clampBpm(bpm0);
  const pts = (project.tempoMap?.length ? project.tempoMap : [{ beat: 0, bpm: project.bpm, curve: 'jump' }])
    .filter((p) => !(p.beat > b0 - 1e-6 && p.beat < b1 + 1e-6)); // points inside the ramp (and its ends) go
  pts.push({ beat: b0, bpm: clampBpm(bpm0), curve: 'linear' }, { beat: b1, bpm: clampBpm(bpm1), curve: 'jump' });
  project.tempoMap = pts;
  normalizeTempoMap(project);
}

// ------------------------------------------------------------------ meters
export function normalizeMeterMap(project) {
  const ms = (project.meterMap || []).filter((m) => m && m.bar > 0 && m.num > 0 && m.den > 0 && [1, 2, 4, 8, 16, 32].includes(+m.den))
    .map((m) => ({ bar: Math.round(m.bar), num: Math.min(32, Math.round(m.num)), den: +m.den, ...(Array.isArray(m.groups) ? { groups: m.groups } : {}) }))
    .sort((a, b) => a.bar - b.bar);
  const out = [];
  let prev = { num: project.timeSig?.[0] || 4, den: project.timeSig?.[1] || 4 };
  for (const m of ms) {
    if (out.length && out[out.length - 1].bar === m.bar) { out[out.length - 1] = m; prev = m; continue; }
    if (m.num === prev.num && m.den === prev.den && !m.groups) continue; // no change
    out.push(m);
    prev = m;
  }
  if (out.length) project.meterMap = out; else delete project.meterMap;
  return project;
}

/** Meter from bar `bar` (0-based) on. bar 0 sets project.timeSig. */
export function setMeter(project, bar, num, den, groups) {
  bar = Math.max(0, Math.round(bar));
  if (bar === 0) { project.timeSig = [num, den]; normalizeMeterMap(project); return; }
  const ms = (project.meterMap || []).filter((m) => m.bar !== bar);
  ms.push({ bar, num, den, ...(groups ? { groups } : {}) });
  project.meterMap = ms;
  normalizeMeterMap(project);
}
export function removeMeter(project, bar) {
  project.meterMap = (project.meterMap || []).filter((m) => m.bar !== bar);
  normalizeMeterMap(project);
}

// ------------------------------------------------------------------ tap tempo / tempo from length
/** Tempo from tap times (ms): median of the last intervals (robust to one sloppy tap). null with < 2 taps. */
export function tapBpm(times, { maxTaps = 8 } = {}) {
  const t = times.slice(-maxTaps);
  if (t.length < 2) return null;
  const iv = [];
  for (let i = 1; i < t.length; i++) iv.push(t[i] - t[i - 1]);
  iv.sort((a, b) => a - b);
  const med = iv.length % 2 ? iv[(iv.length - 1) / 2] : (iv[iv.length / 2 - 1] + iv[iv.length / 2]) / 2;
  const good = iv.filter((x) => Math.abs(x - med) / med < 0.2);
  const avg = good.reduce((a, b) => a + b, 0) / good.length;
  return avg > 0 ? Math.round((60000 / avg) * 100) / 100 : null;
}

/** Tap-tempo state: tap(nowMs) -> bpm | null (resets after a 2 s gap). */
export class TapTempo {
  constructor() { this.times = []; }
  tap(now) {
    if (this.times.length && now - this.times[this.times.length - 1] > 2000) this.times = [];
    this.times.push(now);
    if (this.times.length > 16) this.times.shift();
    return tapBpm(this.times);
  }
  reset() { this.times = []; }
}

/** Tapped tempo into the map at `beat` (beat 0 / no song mode -> project tempo). */
export function tapTempoToMap(project, beat, bpm) {
  if (!(bpm > 0)) return;
  setTempoPoint(project, beat || 0, bpm, 'jump');
}

/**
 * "Set tempo from selection length": the selection [b0, b1) should last `beats` beats (default: the nearest whole
 * number of bars) in the time it lasts now. The tempo inside it becomes beats·60/seconds; beats after the selection
 * keep sounding at their old tempo. Returns the new bpm.
 */
export function tempoFromSelection(project, b0, b1, beats) {
  const map = songTempoMap(project);
  const sec = map.span(b0, b1);
  if (!(sec > 0)) return null;
  const bar = map.barAt(b0).length;
  const target = beats > 0 ? beats : Math.max(bar, Math.round((b1 - b0) / bar) * bar);
  const bpm = clampBpm((target * 60) / sec);
  const after = map.bpmAt(b1);
  if (map.isConstant && b0 < 1e-9) { project.bpm = bpm; normalizeTempoMap(project); return bpm; }
  setTempoPoint(project, b0, bpm, 'jump');
  setTempoPoint(project, b0 + target, after, 'jump');
  return bpm;
}
