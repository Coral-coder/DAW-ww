// Touch piano roll — pure geometry / editing helpers (Node-testable).
import { uid } from '../core/util.js';
const mod12 = (x) => ((x % 12) + 12) % 12;

export const SNAPS = [
  { value: 1, label: '1/4' }, { value: 0.5, label: '1/8' }, { value: 0.25, label: '1/16' }, { value: 0.125, label: '1/32' },
  { value: 1 / 3, label: '1/8T' }, { value: 1 / 6, label: '1/16T' }, { value: 0, label: 'Free' },
];

export const snapFloor = (b, snap) => (snap > 0 ? Math.floor(b / snap + 1e-6) * snap : b);
export const snapRound = (b, snap) => (snap > 0 ? Math.round(b / snap) * snap : b);

/** View transform: {ppb (px per beat), rowH (px per semitone), x0 (beat at the left edge), top (pitch of the top row)}. */
export const beatToX = (v, beat) => (beat - v.x0) * v.ppb;
export const xToBeat = (v, x) => v.x0 + x / v.ppb;
export const pitchToY = (v, pitch) => (v.top - pitch) * v.rowH;
export const yToPitch = (v, y) => Math.ceil(v.top - y / v.rowH);

/**
 * Note under (beat, pitch): {note, zone: 'end' (resize handle: the last quarter, at least `edgeBeats`) | 'body'} or null.
 * Later (top-most drawn) notes win.
 */
export function hitNote(notes, beat, pitch, { edgeBeats = 0.12 } = {}) {
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.pitch !== pitch || beat < n.start || beat > n.start + n.dur) continue;
    const edge = Math.min(n.dur * 0.5, Math.max(edgeBeats, n.dur * 0.25));
    return { note: n, zone: beat >= n.start + n.dur - edge ? 'end' : 'body' };
  }
  return null;
}

/** Move a pitch by `rows` rows; with a scale (pitch classes) only scale tones count as rows. */
export function stepPitch(pitch, rows, pcs = null) {
  if (!pcs || !rows) return pitch + rows;
  const set = new Set(pcs.map(mod12));
  let p = pitch, left = Math.abs(rows);
  const dir = Math.sign(rows);
  while (left > 0) { p += dir; if (set.has(mod12(p))) left--; if (Math.abs(p - pitch) > 48) break; }
  return p;
}

/** Nearest scale tone to a pitch (ties go down). */
export function nearestInScale(pitch, pcs) {
  const set = new Set(pcs.map(mod12));
  for (let d = 0; d <= 6; d++) { if (set.has(mod12(pitch - d))) return pitch - d; if (set.has(mod12(pitch + d))) return pitch + d; }
  return pitch;
}

/**
 * Two-finger pinch: zoom time with the horizontal finger spread, pitch with the vertical spread (independently),
 * keeping the content under the fingers' centre in place. start/now: {x0, y0, x1, y1} (local px), v0: view at start.
 */
export function pinchView(v0, start, now, { minPpb = 12, maxPpb = 640, minRow = 8, maxRow = 64 } = {}) {
  const spanX = (s) => Math.max(1, Math.abs(s.x1 - s.x0)), spanY = (s) => Math.max(1, Math.abs(s.y1 - s.y0));
  const cx0 = (start.x0 + start.x1) / 2, cy0 = (start.y0 + start.y1) / 2;
  const cx = (now.x0 + now.x1) / 2, cy = (now.y0 + now.y1) / 2;
  const sx = spanX(start) > 40 ? spanX(now) / spanX(start) : 1;
  const sy = spanY(start) > 40 ? spanY(now) / spanY(start) : 1;
  const ppb = Math.min(maxPpb, Math.max(minPpb, v0.ppb * sx));
  const rowH = Math.min(maxRow, Math.max(minRow, v0.rowH * sy));
  const beatAtC = v0.x0 + cx0 / v0.ppb;
  const pitchAtC = v0.top - cy0 / v0.rowH;
  return { ppb, rowH, x0: beatAtC - cx / ppb, top: pitchAtC + cy / rowH };
}

/** Keep the view inside the pattern / MIDI range. */
export function clampView(v, { length = 4, width = 300, height = 400 } = {}) {
  const maxX0 = Math.max(0, length - width / v.ppb + 0.5);
  const x0 = Math.min(maxX0, Math.max(-0.25, v.x0));
  const rows = height / v.rowH;
  const top = Math.min(127.5, Math.max(rows + 0.5, v.top));
  return { ...v, x0, top };
}

// ------------------------------------------------------------------------------------------- multi-select (notes)
const r5 = (x) => +(+x).toFixed(5);
const nid = () => uid('n');

/** Note ids touched by a lasso box in beats / pitches (any corner order; pitch rows are inclusive). */
export function notesInBox(notes, b0, b1, p0, p1) {
  const [ba, bb] = [Math.min(b0, b1), Math.max(b0, b1)], [pa, pb] = [Math.min(p0, p1), Math.max(p0, p1)];
  return notes.filter((n) => n.pitch >= pa && n.pitch <= pb && n.start < bb && n.start + n.dur > ba).map((n) => n.id);
}

/**
 * Move the notes of `ids` from their origins (Map id → {start, pitch}) by dBeat / dPitch, clamped as a group so every
 * note stays inside the pattern and MIDI range. pcs (scale) → dPitch counts scale steps. Mutates the pattern.
 */
export function moveNotes(pat, orig, dBeat, dPitch, { pcs = null } = {}) {
  const os = [...orig.values()];
  if (!os.length) return;
  const minS = Math.min(...os.map((o) => o.start)), maxE = Math.max(...os.map((o) => o.start + (o.dur || 0)));
  const d = Math.max(-minS, Math.min(dBeat, Math.max(0, pat.length - Math.max(maxE, minS + 0.0625))));
  for (const n of pat.notes) {
    const o = orig.get(n.id);
    if (!o) continue;
    n.start = r5(o.start + d);
    n.pitch = Math.max(0, Math.min(127, pcs ? stepPitch(o.pitch, dPitch, pcs) : o.pitch + dPitch));
  }
}
export const noteOrigins = (pat, ids) => { const s = new Set(ids); return new Map(pat.notes.filter((n) => s.has(n.id)).map((n) => [n.id, { start: n.start, pitch: n.pitch, dur: n.dur }])); };

/** Transpose by semitones (or by scale steps when pcs is given). */
export function transposeNotes(pat, ids, steps, pcs = null) {
  const s = new Set(ids);
  for (const n of pat.notes) if (s.has(n.id)) n.pitch = Math.max(0, Math.min(127, pcs ? stepPitch(nearestInScale(n.pitch, pcs), steps, pcs) : n.pitch + steps));
}

/** Quantize starts (and lengths, when `ends`) to q beats, `strength` 0..1 of the way. */
export function quantizeNotes(pat, ids, q, { strength = 1, ends = true } = {}) {
  if (!(q > 0)) return;
  const s = new Set(ids);
  for (const n of pat.notes) {
    if (!s.has(n.id)) continue;
    const st = Math.min(Math.max(0, pat.length - q), n.start + (snapRound(n.start, q) - n.start) * strength);
    n.start = r5(st);
    if (ends) { const tgt = Math.max(q, snapRound(n.dur, q)); n.dur = r5(Math.max(0.0625, Math.min(pat.length - n.start, n.dur + (tgt - n.dur) * strength))); }
  }
}

/** Velocity: {set} (absolute 0..1), {scale} (×) or {add}; clamped to 0.05..1. */
export function setVelocity(pat, ids, { set = null, scale = null, add = null } = {}) {
  const s = new Set(ids);
  for (const n of pat.notes) {
    if (!s.has(n.id)) continue;
    let v = n.vel ?? 0.8;
    if (set != null) v = set;
    if (scale != null) v *= scale;
    if (add != null) v += add;
    n.vel = +Math.max(0.05, Math.min(1, v)).toFixed(3);
  }
}

/** Copy the notes right after the selection's span (rounded up to `grid` beats); copies past the end are dropped. */
export function duplicateNotes(pat, ids, grid = 0) {
  const s = new Set(ids);
  const ns = pat.notes.filter((n) => s.has(n.id));
  if (!ns.length) return [];
  let span = Math.max(...ns.map((n) => n.start + n.dur)) - Math.min(...ns.map((n) => n.start));
  if (grid > 0) span = Math.ceil(span / grid - 1e-6) * grid;
  const out = [];
  for (const n of ns) {
    const st = r5(n.start + span);
    if (st >= pat.length - 1e-6) continue;
    const c = { ...n, id: nid(), start: st, dur: r5(Math.min(n.dur, pat.length - st)) };
    pat.notes.push(c);
    out.push(c.id);
  }
  return out;
}
export function deleteNotes(pat, ids) { const s = new Set(ids); pat.notes = pat.notes.filter((n) => !s.has(n.id)); }
