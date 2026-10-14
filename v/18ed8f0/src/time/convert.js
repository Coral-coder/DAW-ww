// Tempo / meter interchange helpers (pure): beat-positioned automation points (DAWproject, MIDI files, legacy
// project.tempoAutomation / project.timeSigAutomation) <-> project.tempoMap / project.meterMap.
import { normalizeTempoMap, normalizeMeterMap } from './tempo-edit.js';
import { songTempoMap } from './tempo-map.js';

/**
 * Tempo points [{beat, bpm, interpolation?: 'linear'|'hold'}] -> sets project.bpm + project.tempoMap.
 * 'linear' ramps to the next point (DAWproject RealPoint interpolation), 'hold' jumps.
 */
export function applyTempoPoints(project, points) {
  const pts = (points || []).filter((p) => Number.isFinite(+p.beat) && p.bpm > 0).map((p) => ({ beat: Math.max(0, +p.beat), bpm: +p.bpm, curve: p.interpolation === 'linear' || p.curve === 'linear' ? 'linear' : 'jump' }))
    .sort((a, b) => a.beat - b.beat);
  if (!pts.length) return project;
  project.bpm = pts[0].bpm;
  if (pts[0].beat > 0) pts.unshift({ beat: 0, bpm: pts[0].bpm, curve: 'jump' });
  project.tempoMap = pts;
  normalizeTempoMap(project);
  return project;
}

/** project -> tempo points for export: [{beat, bpm, interpolation: 'linear'|'hold'}] ([] without changes). */
export function tempoPoints(project) {
  if (!project.tempoMap?.length) return [];
  // a ramp's target is the next segment's start bpm, so segments map 1:1 to points
  return songTempoMap(project).segs.map((g) => ({ beat: g.beat, bpm: g.bpm, interpolation: g.curve === 'linear' && g.end < Infinity ? 'linear' : 'hold' }));
}

/**
 * Meter points [{beat, num, den}] -> project.timeSig + project.meterMap (bar-indexed). A change that is not on a
 * bar line moves to the next bar line (returns the number of moved points).
 */
export function applyMeterPoints(project, points) {
  const pts = (points || []).filter((p) => Number.isFinite(+p.beat) && p.num > 0 && p.den > 0).map((p) => ({ beat: Math.max(0, +p.beat), num: Math.round(p.num), den: Math.round(p.den) }))
    .sort((a, b) => a.beat - b.beat);
  if (!pts.length) return 0;
  let moved = 0;
  const first = pts[0].beat < 1e-6 ? pts.shift() : null;
  if (first) project.timeSig = [first.num, first.den];
  const meters = [];
  let bar = 0, barBeat = 0, bpb = (project.timeSig[0] * 4) / project.timeSig[1];
  for (const p of pts) {
    const n = (p.beat - barBeat) / bpb;
    let k = Math.round(n);
    if (Math.abs(n - k) > 1e-6) { k = Math.ceil(n); moved++; }
    bar += k; barBeat += k * bpb;
    meters.push({ bar, num: p.num, den: p.den });
    bpb = (p.num * 4) / p.den;
  }
  project.meterMap = meters;
  normalizeMeterMap(project);
  return moved;
}

/** project -> meter points [{beat, num, den}] (beat 0 = project.timeSig). */
export function meterPoints(project) {
  return songTempoMap(project).meters.map((m) => ({ beat: m.beat, num: m.num, den: m.den }));
}

/** Legacy fields (project.tempoAutomation / timeSigAutomation from older DAWproject imports) -> maps. */
export function migrateLegacyTempo(project) {
  if (project.tempoAutomation?.length && !project.tempoMap) applyTempoPoints(project, project.tempoAutomation);
  if (project.timeSigAutomation?.length && !project.meterMap) applyMeterPoints(project, project.timeSigAutomation);
  delete project.tempoAutomation;
  delete project.timeSigAutomation;
  return project;
}
