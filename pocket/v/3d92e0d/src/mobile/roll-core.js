// Touch piano roll — pure geometry / editing helpers (Node-testable).
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
