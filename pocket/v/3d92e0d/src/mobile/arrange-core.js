// Pocket ▸ Song (touch arrangement) — pure geometry, hit-testing and clip editing math (Node-testable).
// View: { ppb (px per beat), x0 (beat at the left edge), y0 (vertical scroll, px), laneH (px per track lane) }.
// Mutators (split / duplicate / make unique / add / markers) take the project being edited inside store.transact.
import { uid, deepClone } from '../core/util.js';
import { createClip, beatsPerBar } from '../core/model.js';

export const RULER_H = 26; // bar numbers + playhead scrub
export const MARK_H = 24; // section markers
export const LOOP_H = 20; // loop region
export const TOP_H = RULER_H + MARK_H + LOOP_H;
export const MIN_PPB = 0.5;
export const MAX_PPB = 160;
export const EPS = 1e-6;
const mod = (a, n) => (n > 0 ? ((a % n) + n) % n : a);
const r6 = (x) => +x.toFixed(6);

export const SNAP_MODES = [
  { value: 'bar', label: 'Bar' }, { value: 'beat', label: 'Beat' }, { value: 'off', label: 'Off' },
];
/** Snap step in beats for a snap mode ('bar' | 'beat' | 'off' | number). */
export function snapStep(mode, bpb = 4) {
  if (mode === 'bar') return bpb;
  if (mode === 'beat') return 1;
  if (typeof mode === 'number' && mode > 0) return mode;
  return 0;
}
export const snapTo = (b, step, fn = Math.round) => (step > 0 ? fn(b / step + (fn === Math.floor ? EPS : 0)) * step : b);

export const beatToX = (v, b) => (b - v.x0) * v.ppb;
export const xToBeat = (v, x) => v.x0 + x / v.ppb;
/** Track lane index under y (canvas px), or -1 (top bars / below the last lane). */
export function laneAt(v, y, nTracks, top = TOP_H) {
  if (y < top) return -1;
  const i = Math.floor((y - top + v.y0) / v.laneH);
  return i >= 0 && i < nTracks ? i : -1;
}
export const laneY = (v, i, top = TOP_H) => top + i * v.laneH - v.y0;

/** Which top bar is at y: 'ruler' | 'markers' | 'loop' | null. */
export function topZone(y) {
  if (y < 0) return null;
  if (y < RULER_H) return 'ruler';
  if (y < RULER_H + MARK_H) return 'markers';
  if (y < TOP_H) return 'loop';
  return null;
}

/**
 * Clip under (x, y): { clip, track, ti, zone: 'left' | 'right' | 'body' } or null. Edge zones are `edgePx` wide
 * (shrunk on tiny clips so the body stays grabbable); the right edge wins on very small clips (resize > trim).
 */
export function hitClip(project, v, x, y, { top = TOP_H, edgePx = 18 } = {}) {
  const ti = laneAt(v, y, project.tracks.length, top);
  if (ti < 0) return null;
  const track = project.tracks[ti];
  const beat = xToBeat(v, x);
  const cs = project.clips.filter((c) => c.trackId === track.id && beat >= c.start - edgePx / 2 / v.ppb && beat <= c.start + c.length + edgePx / 2 / v.ppb);
  if (!cs.length) return null;
  // prefer a clip that actually contains the beat; later clips are drawn on top
  const inside = cs.filter((c) => beat >= c.start && beat <= c.start + c.length);
  const clip = (inside.length ? inside : cs)[(inside.length ? inside : cs).length - 1];
  const x0 = beatToX(v, clip.start), x1 = beatToX(v, clip.start + clip.length);
  const w = x1 - x0;
  const e = Math.min(edgePx, w / 3);
  let zone = 'body';
  if (x >= x1 - e) zone = 'right';
  else if (x <= x0 + e && w > 24) zone = 'left';
  return { clip, track, ti, zone };
}

/** New start of a dragged clip (snapped, never before 0). */
export function moveStart(start0, dBeats, step) {
  return r6(Math.max(0, snapTo(start0 + dBeats, step)));
}

/** Right-edge drag: new length (snapped end; ≥ minLen). Longer than the pattern = the pattern loops. */
export function resizeRight(clip, dBeats, step, minLen = step || 0.25) {
  const end = snapTo(clip.start + clip.length + dBeats, step);
  return r6(Math.max(minLen, end - clip.start));
}

/**
 * Left-edge drag (trim): {start, length, offset}. Pattern clips wrap the offset inside the pattern length (so the
 * content stays put on the timeline); audio clips can't be pulled before their sample start.
 */
export function trimLeft(clip, dBeats, step, { minLen = step || 0.25, patternLength = 0 } = {}) {
  let delta = snapTo(clip.start + dBeats, step) - clip.start;
  let lo = -clip.start;
  if (clip.type === 'audio') lo = Math.max(lo, -(clip.offset || 0));
  const hi = clip.length - minLen;
  delta = Math.min(Math.max(delta, lo), Math.max(lo, hi));
  const off = clip.type === 'pattern' ? mod((clip.offset || 0) + delta, patternLength) : (clip.offset || 0) + delta;
  return { start: r6(clip.start + delta), length: r6(clip.length - delta), offset: r6(off) };
}

/** Split a clip at `beat` (inside it). Returns the new (right-hand) clip id or null. */
export function splitClip(p, clipId, beat) {
  const i = p.clips.findIndex((c) => c.id === clipId);
  const c = p.clips[i];
  if (!c || beat <= c.start + EPS || beat >= c.start + c.length - EPS) return null;
  const cut = beat - c.start;
  const L = p.patterns[c.patternId]?.length || 0;
  const second = { ...deepClone(c), id: uid('clip'), start: r6(beat), length: r6(c.length - cut), offset: c.type === 'pattern' ? r6(mod((c.offset || 0) + cut, L)) : r6((c.offset || 0) + cut) };
  c.length = r6(cut);
  p.clips.splice(i + 1, 0, second);
  return second.id;
}

/** Copy a clip right after itself. Returns the copy's id. */
export function duplicateClip(p, clipId) {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return null;
  const copy = { ...deepClone(c), id: uid('clip'), start: r6(c.start + c.length) };
  p.clips.push(copy);
  return copy.id;
}

function uniqueName(p, base) {
  const stem = String(base || '').replace(/\s*\d+$/, '').trim() || 'Pattern';
  const names = new Set(Object.values(p.patterns).map((x) => x.name));
  for (let i = 2; i < 999; i++) if (!names.has(`${stem} ${i}`)) return `${stem} ${i}`;
  return `${stem} copy`;
}
/** Give a pattern clip its own copy of the pattern. Returns the new pattern id (or null). */
export function makeUnique(p, clipId) {
  const c = p.clips.find((x) => x.id === clipId);
  const pat = c && p.patterns[c.patternId];
  if (!pat) return null;
  const np = { ...deepClone(pat), id: uid('pat'), name: uniqueName(p, pat.name) };
  np.notes = (np.notes || []).map((n) => ({ ...n, id: uid('n') }));
  p.patterns[np.id] = np;
  c.patternId = np.id;
  return np.id;
}

/** Rename: the pattern itself when this clip is its only user, else the clip. */
export function renameClip(p, clipId, name) {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return;
  const pat = c.type === 'pattern' ? p.patterns[c.patternId] : null;
  if (pat && !p.clips.some((o) => o !== c && o.patternId === pat.id)) { pat.name = name || pat.name; c.name = null; } else c.name = name || null;
}

/** Clip colour (pattern clips colour their pattern, like the desktop). */
export function colorClip(p, clipId, color) {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return;
  if (c.type === 'pattern' && p.patterns[c.patternId]) p.patterns[c.patternId].color = color; else c.color = color;
}

/**
 * Tap on empty lane space: a clip of the track's active pattern at the snapped beat (floor), as long as the
 * pattern (or one bar), shortened so it doesn't run into the next clip. Returns the clip or null.
 */
export function clipForTap(p, trackId, beat, step, patternId) {
  const pat = p.patterns[patternId];
  if (!pat) return null;
  const start = Math.max(0, snapTo(beat, step, Math.floor));
  if (p.clips.some((c) => c.trackId === trackId && start >= c.start - EPS && start < c.start + c.length - EPS)) return null;
  let length = Math.max(pat.length || 0, step || 0) || beatsPerBar(p);
  const next = p.clips.filter((c) => c.trackId === trackId && c.start > start + EPS).sort((a, b) => a.start - b.start)[0];
  if (next) length = Math.min(length, next.start - start);
  if (length <= EPS) return null;
  return createClip(trackId, { patternId: pat.id, start: r6(start), length: r6(length) });
}

/** Clip label: own name, else the pattern's. */
export function clipLabel(p, c) {
  if (c.name) return c.name;
  if (c.type === 'audio') return p.samples?.[c.sampleId]?.name || 'Audio';
  return p.patterns[c.patternId]?.name || 'Clip';
}

// ------------------------------------------------------------------------------------------- markers & loop
/** Marker whose flag is under x (within slop px), nearest wins. */
export function markerAt(markers, v, x, slop = 22) {
  let best = null, bd = Infinity;
  for (const m of markers || []) {
    const mx = beatToX(v, m.beat);
    // the flag extends to the right of the line (label), so bias the hit zone rightwards
    const d = x < mx ? mx - x : Math.max(0, x - mx - slop * 2);
    if (d <= slop && d < bd) { bd = d; best = m; }
  }
  return best;
}
export function addMarker(p, beat, name) {
  const m = { id: uid('mk'), beat: r6(Math.max(0, beat)), name: name || `Section ${(p.markers?.length || 0) + 1}` };
  p.markers = [...(p.markers || []), m].sort((a, b) => a.beat - b.beat);
  return m;
}
export function moveMarker(p, id, beat) {
  const m = (p.markers || []).find((x) => x.id === id);
  if (!m) return;
  m.beat = r6(Math.max(0, beat));
  p.markers.sort((a, b) => a.beat - b.beat);
}

/** Loop bar hit: 'start' | 'end' (handles, slop px) | 'body' | null. */
export function loopHit(loop, v, x, slop = 20) {
  if (!loop || !(loop.end > loop.start)) return null;
  const xs = beatToX(v, loop.start), xe = beatToX(v, loop.end);
  const ds = Math.abs(x - xs), de = Math.abs(x - xe);
  if (ds <= slop || de <= slop) return ds < de ? 'start' : 'end';
  if (x > xs && x < xe) return 'body';
  return null;
}
/** Loop drag: which = 'start' | 'end' | 'body' | 'new' (anchor = start beat). -> {start, end} (min one step). */
export function dragLoop(loop0, which, dBeats, step, anchor = 0) {
  const min = step || 0.25;
  if (which === 'body') {
    const len = loop0.end - loop0.start;
    const s = Math.max(0, snapTo(loop0.start + dBeats, step));
    return { start: r6(s), end: r6(s + len) };
  }
  if (which === 'start') return { start: r6(Math.max(0, Math.min(loop0.end - min, snapTo(loop0.start + dBeats, step)))), end: loop0.end };
  if (which === 'end') return { start: loop0.start, end: r6(Math.max(loop0.start + min, snapTo(loop0.end + dBeats, step))) };
  // 'new': from the anchor to anchor + d (either direction)
  const a = Math.max(0, snapTo(anchor, step, Math.floor));
  const b = Math.max(0, snapTo(anchor + dBeats, step));
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return { start: r6(lo), end: r6(Math.max(hi, lo + min)) };
}

// ------------------------------------------------------------------------------------------- zoom / follow
/** Horizontal pinch: keeps the beat under the fingers' centre in place. xs = [xa, xb] (canvas px). */
export function pinchTime(v0, startXs, nowXs, { min = MIN_PPB, max = MAX_PPB } = {}) {
  const span = (s) => Math.max(1, Math.abs(s[1] - s[0]));
  const c0 = (startXs[0] + startXs[1]) / 2, c = (nowXs[0] + nowXs[1]) / 2;
  const f = span(startXs) > 30 ? span(nowXs) / span(startXs) : 1;
  const ppb = Math.min(max, Math.max(min, v0.ppb * f));
  const beatAtC = v0.x0 + c0 / v0.ppb;
  return { ...v0, ppb, x0: Math.max(-1, beatAtC - c / ppb) };
}
/** ppb that fits `beats` into `width` px. */
export const fitPpb = (beats, width) => Math.min(MAX_PPB, Math.max(MIN_PPB, (width - 16) / Math.max(1, beats)));
/** Follow-playhead: new x0 when the playhead leaves the visible area (page flip at 85 %), else the same x0. */
export function followX0(v, beat, width) {
  const x = beatToX(v, beat);
  if (x < 0 || x > width * 0.85) return Math.max(0, beat - (width * 0.1) / v.ppb);
  return v.x0;
}
/** Clamp vertical scroll to the content. */
export function clampY0(y0, nTracks, laneH, height, extra = 0) {
  return Math.max(0, Math.min(y0, nTracks * laneH + extra - (height - TOP_H) + 40));
}
