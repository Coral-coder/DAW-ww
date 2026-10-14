// Drag-to-reorder for Pocket lists (tracks, effects): pure index math + a touch helper.
// Press and hold a row's grip (or long-press the row when `holdMs` is set), then drag it up / down.
import { haptic } from './touch.js';

/** Move item `from` to index `to` (the index it ends up at). Returns a new array. */
export function reorder(list, from, to) {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const t = Math.max(0, Math.min(out.length - 1, to));
  const [it] = out.splice(from, 1);
  out.splice(t, 0, it);
  return out;
}

/**
 * Target index while dragging row `from` (rows' [top, height] in px at drag start) with its centre at y.
 * The row moves past a neighbour once its centre crosses the neighbour's middle.
 */
export function dropIndex(rows, from, y) {
  let to = from;
  for (let i = 0; i < rows.length; i++) {
    if (i === from) continue;
    const mid = rows[i].top + rows[i].height / 2;
    if (i < from && y < mid) { to = Math.min(to, i); }
    if (i > from && y > mid) { to = Math.max(to, i); }
  }
  return to;
}

/** Offsets (px) to show for the other rows while row `from` hovers at index `to` (shift by the dragged row's height). */
export function shiftFor(i, from, to, h) {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -h;
  if (from > to && i >= to && i < from) return h;
  return 0;
}

/**
 * Make the rows (direct children) of `container` drag-reorderable by their grip (`grip` selector inside a row):
 * touch the grip and drag up / down. onMove(from, to) commits the new order.
 */
export function dragReorder(container, { grip = '.pk-grip', onMove } = {}) {
  let st = null;
  container.addEventListener('pointerdown', (e) => {
    const g = e.target.closest?.(grip);
    if (!g || !container.contains(g)) return;
    const rows = [...container.children];
    const row = rows.find((c) => c.contains(g));
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const rects = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, height: b.height }; });
    const from = rows.indexOf(row);
    st = { row, rows, rects, from, to: from, y0: e.clientY, id: e.pointerId };
    row.classList.add('pk-dragging');
    container.classList.add('pk-reordering');
    try { container.setPointerCapture?.(e.pointerId); } catch { /* */ }
    haptic(12);
  });
  container.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    e.preventDefault();
    const dy = e.clientY - st.y0;
    const r = st.rects[st.from];
    st.to = dropIndex(st.rects, st.from, r.top + r.height / 2 + dy);
    st.row.style.transform = `translateY(${dy}px)`;
    st.rows.forEach((row, i) => { if (i !== st.from) row.style.transform = `translateY(${shiftFor(i, st.from, st.to, r.height)}px)`; });
  });
  const end = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const s = st;
    st = null;
    for (const row of s.rows) row.style.transform = '';
    s.row.classList.remove('pk-dragging');
    container.classList.remove('pk-reordering');
    if (e.type !== 'pointercancel' && s.to !== s.from) { haptic(8); onMove?.(s.from, s.to); }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}
