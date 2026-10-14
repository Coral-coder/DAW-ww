// Pocket ▸ Notes: touch piano roll (pinch zoom, tap to add, drag to move / resize, long-press to delete, snap,
// scale highlighting / lock) — and a big-cell step grid with swipe-painting for drum tracks.
import { h, icon, fitCanvas, cssVar } from '../../ui/dom.js';
import { DRUM_PADS, beatsPerBar, createNote } from '../../core/model.js';
import { scalePitchClasses, pitchClassName } from '../../theory/index.js';
import { uid } from '../../core/util.js';
import { SNAPS, snapFloor, snapRound, beatToX, xToBeat, pitchToY, yToPitch, hitNote, stepPitch, nearestInScale, pinchView, clampView,
  notesInBox, noteOrigins, moveNotes, transposeNotes, quantizeNotes, setVelocity, duplicateNotes, deleteNotes } from '../roll-core.js';
import { pageShell, iconBtn, pickTrack, isDrums, emptyState, soundName, addTrackSheet } from './common.js';
import { actionSheet, haptic, bigButton, chips, openSheet, holdRepeat } from '../touch.js';
import { ctlTile, valueTarget, openParamPopup } from '../controls.js';
import { openPadSheet } from '../pad-sheet.js';
import { editedPads } from '../pad-logic.js';

const KW = 40; // keyboard strip width
const RULER = 22;
const LS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const SS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (p) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

export function createNotesPage(app, nav) {
  const { store, ui, actions, engine } = app;
  const get = () => store.get();
  const trackBtn = h('button.pk-select.small', { type: 'button' });
  const humBtn = iconBtn('music', () => app.openHum?.({ trackId: ui.get('selectedTrackId') }), 'Hum', 'labeled accent');
  const moreBtn = iconBtn('menu', () => moreMenu(), 'More');
  const { el, body, head, titleEl } = pageShell('Notes', humBtn, moreBtn);
  titleEl.replaceWith(trackBtn);
  trackBtn.addEventListener('click', () => pickTrack(app, { title: 'Edit notes of…', onPick: () => render() }));

  let snap = LS('daw3-pocket-snap', 0.25);
  let scaleLock = LS('daw3-pocket-scalelock', true);
  const snapChips = chips(SNAPS.map((s) => ({ value: s.value, label: s.label })), snap, (v) => { snap = v; SS('daw3-pocket-snap', v); }, { cls: 'scroll small' });
  const lockBtn = h('button.pk-chip', { type: 'button', title: 'Scale lock: new / moved notes stay in the song\'s key' });
  lockBtn.addEventListener('click', () => { scaleLock = !scaleLock; SS('daw3-pocket-scalelock', scaleLock); haptic(5); syncLock(); draw(); });
  const syncLock = () => { const k = get().key; lockBtn.textContent = `${scaleLock ? '🔒' : '🔓'} ${pitchClassName(k.root)} ${k.scale}`; lockBtn.classList.toggle('on', scaleLock); };
  let selectMode = false;
  const selModeBtn = h('button.pk-chip', { type: 'button', title: 'Select mode: tap notes to add / remove them, drag on empty space to lasso, drag a note to move them all' }, '☐ Select');
  selModeBtn.addEventListener('click', () => { selectMode = !selectMode; haptic(5); syncSelBar(); draw(); });
  const toolbar = h('div.pk-notes-tools', selModeBtn, lockBtn, snapChips);
  const host = h('div.pk-notes-host');
  const selBar = h('div.pk-notes-sel', { 'data-noswipe': '', hidden: true });
  body.classList.add('pk-notes-body');
  body.append(toolbar, host, selBar);

  let visible = false, raf = 0;
  let mode = null; // 'roll' | 'drums' | 'none'

  // ============================================================ piano roll
  const canvas = h('canvas.pk-roll', { 'data-noswipe': '' });
  const rollWrap = h('div.pk-roll-wrap', canvas);
  const views = new Map(); // patternId -> view
  let selId = null; // the note last tapped (single selection)
  let selIds = []; // multi-selection
  let lastDur = 0.5;
  let W = 300, H = 400;

  const track = () => get().tracks.find((t) => t.id === ui.get('selectedTrackId'));
  const pattern = () => { const t = track(); return t ? get().patterns[ui.get('selectedPatternId')]?.trackId === t.id ? get().patterns[ui.get('selectedPatternId')] : get().patterns[t.activePatternId] : null; };
  const pcs = () => scalePitchClasses(get().key.root, get().key.scale);
  function view() {
    const pat = pattern();
    if (!pat) return { ppb: 80, rowH: 26, x0: 0, top: 76 };
    if (!views.has(pat.id)) {
      const ps = pat.notes.map((n) => n.pitch);
      const mid = ps.length ? Math.round((Math.min(...ps) + Math.max(...ps)) / 2) : 62;
      const rowH = 26;
      const ppb = Math.max(30, Math.min(160, (W - KW) / Math.min(pat.length, 4)));
      views.set(pat.id, { ppb, rowH, x0: 0, top: mid + (H - RULER) / rowH / 2 });
    }
    return views.get(pat.id);
  }
  const setView = (v) => { const pat = pattern(); if (pat) views.set(pat.id, clampView(v, { length: pat.length, width: W - KW, height: H - RULER })); };

  function draw() {
    if (mode !== 'roll' || !visible) return;
    const r = fitCanvas(canvas);
    const c = r.ctx;
    W = r.w; H = r.h;
    const pat = pattern();
    const t = track();
    c.clearRect(0, 0, W, H);
    if (!pat || !t) return;
    const v = view();
    const bpb = beatsPerBar(get());
    const set = new Set(pcs());
    const root = get().key.root;
    const gx = (b) => KW + beatToX(v, b);
    const gy = (p) => RULER + pitchToY(v, p);
    // rows
    const pTop = Math.ceil(v.top), pBot = Math.floor(v.top - (H - RULER) / v.rowH) - 1;
    for (let p = pTop; p >= pBot; p--) {
      const y = gy(p);
      const pc = ((p % 12) + 12) % 12;
      c.fillStyle = pc === root ? 'rgba(124,92,255,0.16)' : set.has(pc) ? 'rgba(128,140,170,0.10)' : 'rgba(0,0,0,0.16)';
      c.fillRect(KW, y, W - KW, v.rowH);
      c.fillStyle = 'rgba(128,128,128,0.12)';
      c.fillRect(KW, y + v.rowH - 1, W - KW, 1);
    }
    // grid
    const step = snap > 0 ? snap : 0.25;
    const b0 = Math.max(0, Math.floor(v.x0)), b1 = Math.min(pat.length, v.x0 + (W - KW) / v.ppb);
    for (let b = Math.floor(b0 / step) * step; b <= b1 + 1e-6; b += step) {
      const x = Math.round(gx(b));
      const isBar = Math.abs(b / bpb - Math.round(b / bpb)) < 1e-6, isBeat = Math.abs(b - Math.round(b)) < 1e-6;
      if (!isBeat && step * v.ppb < 7) continue;
      c.fillStyle = isBar ? cssVar('--grid-bar') : isBeat ? cssVar('--grid-beat') : cssVar('--grid-step');
      c.fillRect(x, RULER, isBar ? 2 : 1, H - RULER);
    }
    // past the pattern end
    const endX = gx(pat.length);
    if (endX < W) { c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(endX, RULER, W - endX, H - RULER); }
    // notes
    const col = t.color || '#7c5cff';
    const selSet = new Set(selIds);
    for (const n of pat.notes) {
      const x = gx(n.start), y = gy(n.pitch), w = Math.max(4, n.dur * v.ppb - 1);
      if (x > W || x + w < KW || y > H || y + v.rowH < RULER) continue;
      c.globalAlpha = 0.55 + 0.45 * (n.vel ?? 0.8);
      c.fillStyle = col;
      roundRect(c, x + 0.5, y + 1, w, v.rowH - 2, 4);
      c.fill();
      c.globalAlpha = 1;
      if (selSet.has(n.id)) { c.strokeStyle = cssVar('--accent-2'); c.lineWidth = 2.5; roundRect(c, x + 0.5, y + 1, w, v.rowH - 2, 4); c.stroke(); } else if (n.id === selId) { c.strokeStyle = cssVar('--text'); c.lineWidth = 2; roundRect(c, x + 0.5, y + 1, w, v.rowH - 2, 4); c.stroke(); }
      // resize grip
      if (w > 18) { c.fillStyle = 'rgba(255,255,255,0.55)'; c.fillRect(x + w - 6, y + v.rowH * 0.3, 2, v.rowH * 0.4); }
      if (v.rowH >= 18 && w > 30) { c.fillStyle = 'rgba(0,0,0,0.65)'; c.font = '10px system-ui'; c.fillText(noteName(n.pitch), x + 4, y + v.rowH / 2 + 3); }
    }
    // lasso
    if (g?.type === 'lasso' && g.moved) {
      const lx = Math.min(g.x, g.cx), ly = Math.min(g.y, g.cy);
      c.fillStyle = cssVar('--accent'); c.globalAlpha = 0.14; c.fillRect(lx, ly, Math.abs(g.cx - g.x), Math.abs(g.cy - g.y)); c.globalAlpha = 1;
      c.strokeStyle = cssVar('--accent'); c.setLineDash([6, 4]); c.lineWidth = 1.5; c.strokeRect(lx + 0.5, ly + 0.5, Math.abs(g.cx - g.x), Math.abs(g.cy - g.y)); c.setLineDash([]);
    }
    // keyboard strip
    for (let p = pTop; p >= pBot; p--) {
      const y = gy(p);
      const pc = ((p % 12) + 12) % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      c.fillStyle = black ? cssVar('--black-key') : cssVar('--white-key');
      c.fillRect(0, y, KW - 2, v.rowH - 1);
      if (set.has(pc)) { c.fillStyle = pc === root ? cssVar('--accent') : 'rgba(124,92,255,0.45)'; c.fillRect(KW - 6, y, 4, v.rowH - 1); }
      if (pc === 0 || v.rowH >= 20) { c.fillStyle = black ? '#ccc' : '#333'; c.font = `${pc === 0 ? 'bold ' : ''}10px system-ui`; c.fillText(noteName(p), 3, y + v.rowH / 2 + 3); }
    }
    // ruler
    c.fillStyle = cssVar('--bg-2');
    c.fillRect(0, 0, W, RULER);
    c.fillStyle = cssVar('--text-2');
    c.font = '11px system-ui';
    for (let b = Math.ceil(v.x0 / bpb) * bpb; b <= b1; b += bpb) { if (b >= 0) c.fillText(String(b / bpb + 1), gx(b) + 4, 15); }
    // playhead
    const pp = engine.isPlaying ? engine.getPatternPosition(t.id) : null;
    if (pp != null) { c.fillStyle = cssVar('--accent-2'); c.fillRect(gx(pp), 0, 2, H); }
  }
  function roundRect(c, x, y, w, hh, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  // ---------------------------------------------------------- roll gestures
  const pts = new Map(); // pointerId -> {x, y}
  let g = null; // current gesture
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const editNotes = (label, fn) => {
    const pat = pattern();
    if (!pat) return;
    store.transact(label, (p) => { const pt = p.patterns[pat.id]; if (pt) fn(pt); }, { coalesce: true });
  };
  const preview = (pitch) => { const t = track(); if (t) engine.previewNote(t.id, pitch, 0.8, 0.4).catch(() => {}); };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 2) {
      // second finger: pinch / two-finger pan
      clearTimeout(g?.lp);
      const [a, b] = [...pts.values()];
      g = { type: 'pinch', start: { x0: a.x - KW, y0: a.y - RULER, x1: b.x - KW, y1: b.y - RULER }, v0: { ...view() } };
      return;
    }
    if (pts.size > 2) return;
    const pat = pattern();
    if (!pat) return;
    const v = view();
    if (p.y < RULER) { g = { type: 'pan', x: p.x, y: p.y, v0: { ...v }, moved: false, ruler: true }; return; }
    if (p.x < KW) { const pitch = yToPitch(v, p.y - RULER); preview(pitch); g = { type: 'pan', x: p.x, y: p.y, v0: { ...v }, moved: false, keys: true }; return; }
    const beat = xToBeat(v, p.x - KW), pitch = yToPitch(v, p.y - RULER);
    const hit = hitNote(pat.notes, beat, pitch, { edgeBeats: 16 / v.ppb }) || (scaleLock ? hitNote(pat.notes, beat, nearestInScale(pitch, pcs()), { edgeBeats: 16 / v.ppb }) : null);
    g = { type: hit ? (hit.zone === 'end' ? 'resize' : 'move') : 'empty', x: p.x, y: p.y, beat, pitch, moved: false, t0: performance.now(), v0: { ...v } };
    // group drag: a note of the multi-selection (or any note in Select mode) moves the whole selection
    if (hit && (selectMode || (selIds.length > 1 && selIds.includes(hit.note.id)))) {
      g.type = 'group';
      g.note = { ...hit.note };
      g.lastPitch = hit.note.pitch;
      return;
    }
    if (!hit && selectMode) { g.type = 'lasso'; g.additive = true; return; }
    if (hit) {
      g.note = { ...hit.note };
      g.lastPitch = hit.note.pitch;
      g.lp = setTimeout(() => {
        if (!g || g.moved || g.note?.id !== hit.note.id) return;
        haptic(25);
        editNotes('Delete note', (pt) => { pt.notes = pt.notes.filter((n) => n.id !== hit.note.id); });
        if (selId === hit.note.id) selId = null;
        g = null;
        draw();
      }, 450);
    } else {
      // long-press empty space arms the lasso: drag = select notes, release = pattern menu
      g.lp = setTimeout(() => { if (g && !g.moved && g.type === 'empty') { haptic(15); g.type = 'lasso'; g.armed = true; g.additive = selIds.length > 1; } }, 500);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (!g) return;
    if (g.type === 'pinch') {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()];
      setView(pinchView(g.v0, g.start, { x0: a.x - KW, y0: a.y - RULER, x1: b.x - KW, y1: b.y - RULER }));
      draw();
      return;
    }
    const dx = p.x - g.x, dy = p.y - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 8) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.lp); }
    const v = g.v0;
    if (g.type === 'lasso') {
      g.cx = p.x; g.cy = p.y;
      const pat0 = pattern();
      if (!pat0) return;
      const ids = notesInBox(pat0.notes, xToBeat(v, Math.min(g.x, p.x) - KW), xToBeat(v, Math.max(g.x, p.x) - KW), yToPitch(v, Math.max(g.y, p.y) - RULER), yToPitch(v, Math.min(g.y, p.y) - RULER));
      selIds = g.additive ? [...new Set([...(g.base ||= selIds.slice()), ...ids])] : ids;
      syncSelBar();
      draw();
      return;
    }
    if (g.type === 'group') {
      const pat0 = pattern();
      if (!pat0) return;
      if (!g.orig) {
        if (!selIds.includes(g.note.id)) selIds = [...selIds, g.note.id];
        g.orig = noteOrigins(pat0, selIds);
        syncSelBar();
      }
      let db = dx / v.ppb;
      if (snap > 0) db = snapRound(g.note.start + db, snap) - g.note.start;
      const rows = Math.round(-dy / v.rowH);
      const np = scaleLock ? stepPitch(scaleSnap(g.note.pitch), rows, pcs()) : g.note.pitch + rows;
      if (np !== g.lastPitch) { g.lastPitch = np; preview(np); haptic(3); }
      editNotes(selIds.length > 1 ? 'Move notes' : 'Move note', (pt) => moveNotes(pt, g.orig, db, rows, { pcs: scaleLock ? pcs() : null }));
      draw();
      return;
    }
    if (g.type === 'empty' || g.type === 'pan') {
      g.type = 'pan';
      setView({ ...view(), x0: g.v0.x0 - (g.keys ? 0 : dx / v.ppb), top: g.v0.top + (g.ruler ? 0 : dy / v.rowH) });
      draw();
      return;
    }
    const pat = pattern();
    if (!pat || !g.note) return;
    if (g.type === 'move') {
      const db = dx / v.ppb;
      let start = snap > 0 ? snapRound(g.note.start + db, snap) : g.note.start + db;
      start = Math.max(0, Math.min(pat.length - Math.min(g.note.dur, snap || 0.0625), start));
      const rows = Math.round(-dy / v.rowH);
      let pitch = scaleLock ? stepPitch(scaleSnap(g.note.pitch), rows, pcs()) : g.note.pitch + rows;
      pitch = Math.max(0, Math.min(127, pitch));
      if (pitch !== g.lastPitch) { g.lastPitch = pitch; preview(pitch); haptic(3); }
      editNotes('Move note', (pt) => { const n = pt.notes.find((x) => x.id === g.note.id); if (n) { n.start = +start.toFixed(5); n.pitch = pitch; } });
    } else if (g.type === 'resize') {
      const end = g.note.start + g.note.dur + dx / v.ppb;
      const min = snap > 0 ? snap : 0.0625;
      const dur = Math.max(min, (snap > 0 ? snapRound(end, snap) : end) - g.note.start);
      lastDur = dur;
      editNotes('Resize note', (pt) => { const n = pt.notes.find((x) => x.id === g.note.id); if (n) n.dur = +Math.min(dur, pat.length - n.start).toFixed(5); });
    }
    draw();
  });

  const scaleSnap = (pitch) => (scaleLock ? nearestInScale(pitch, pcs()) : pitch);
  const endPointer = (e) => {
    pts.delete(e.pointerId);
    if (!g) return;
    clearTimeout(g.lp);
    if (g.type === 'pinch') { if (pts.size === 0) g = null; return; }
    const gg = g;
    g = null;
    if (e.type === 'pointercancel') return;
    if (gg.type === 'lasso') {
      if (gg.moved) { haptic(8); syncSelBar(); draw(); return; }
      if (gg.armed) { patternMenu(); return; }
      if (selIds.length) { selIds = []; syncSelBar(); draw(); }
      return;
    }
    if (gg.moved) { if (gg.type === 'group') haptic(6); return; }
    const pat = pattern();
    if (!pat) return;
    if (gg.type === 'group') {
      // tap in Select mode / on a multi-selected note: toggle it (Select mode) or make it the only selection
      if (selectMode) selIds = selIds.includes(gg.note.id) ? selIds.filter((x) => x !== gg.note.id) : [...selIds, gg.note.id];
      else { selIds = []; selId = gg.note.id; }
      preview(gg.note.pitch);
      syncSelBar();
      draw();
      return;
    }
    if (gg.type === 'empty' && selIds.length > 1) { selIds = []; syncSelBar(); draw(); return; }
    if (gg.type === 'empty') {
      // tap: add a note
      const start = snap > 0 ? snapFloor(gg.beat, snap) : gg.beat;
      if (start >= pat.length) return;
      const pitch = scaleSnap(gg.pitch);
      const n = createNote(pitch, +start.toFixed(5), Math.min(lastDur, pat.length - start), 0.8);
      editNotes('Add note', (pt) => { pt.notes.push(n); });
      selId = n.id;
      preview(pitch);
      haptic(8);
    } else if (gg.note) {
      // tap a note: select it; tap the selected note again: its popup
      if (selId === gg.note.id) noteSheet(gg.note.id); else { selId = gg.note.id; preview(gg.note.pitch); lastDur = gg.note.dur; }
    }
    draw();
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function noteSheet(id) {
    const pat = pattern();
    const n0 = pat?.notes.find((n) => n.id === id);
    if (!n0) return;
    const nt = () => pattern()?.notes.find((n) => n.id === id);
    const edit = (label, fn) => editNotes(label, (pt) => { const n = pt.notes.find((x) => x.id === id); if (n) fn(n, pt); });
    const vel = ctlTile(app, valueTarget({ key: 'vel', label: 'Velocity', type: 'number', min: 0.05, max: 1, step: 0.01, default: 0.8, unit: '%' }, () => nt()?.vel ?? 0.8, (v) => edit('Velocity', (n) => { n.vel = v; })));
    const len = ctlTile(app, valueTarget({ key: 'dur', label: 'Length (beats)', type: 'number', min: 0.0625, max: Math.max(1, pat.length), step: 0.0625, default: 1 }, () => nt()?.dur ?? 1, (v) => edit('Note length', (n) => { n.dur = v; lastDur = v; })));
    const s = openSheet({
      title: `Note ${noteName(n0.pitch)}`,
      body: [h('div.pk-tiles', vel, len), h('div.pk-grid3',
        bigButton('−1 oct', () => edit('Transpose', (n) => { n.pitch = Math.max(0, n.pitch - 12); }), {}),
        bigButton('+1 oct', () => edit('Transpose', (n) => { n.pitch = Math.min(127, n.pitch + 12); }), {}),
        bigButton('Duplicate', () => { const n = nt(); if (n) { const c = { ...n, id: uid('n'), start: n.start + n.dur }; if (c.start < pat.length) editNotes('Duplicate note', (pt) => pt.notes.push(c)); } s.close(); }, { ic: 'copy' }),
      ), bigButton('Delete note', () => { editNotes('Delete note', (pt) => { pt.notes = pt.notes.filter((x) => x.id !== id); }); selId = null; s.close(); draw(); }, { ic: 'trash', cls: 'danger' })],
    });
  }

  // ---------------------------------------------------------- multi-select action bar
  const selNotes = () => { const pat = pattern(); const s = new Set(selIds); return pat ? pat.notes.filter((n) => s.has(n.id)) : []; };
  const editSel = (label, fn) => editNotes(label, (pt) => fn(pt, selIds));
  function selIb(ic, label, fn, txt = null) {
    const b = h('button.pk-ib', { type: 'button', 'aria-label': label, title: label }, ic ? icon(ic, 18) : null, txt ? h('span.pk-ib-txt', txt) : null);
    b.addEventListener('click', () => { haptic(5); fn(); });
    return b;
  }
  function transposeBtn(dir) {
    const b = h('button.pk-ib', { type: 'button', 'aria-label': dir > 0 ? 'Up' : 'Down', title: dir > 0 ? 'Transpose up (scale step with the lock on; hold to repeat)' : 'Transpose down (hold to repeat)' }, h('span.pk-ib-txt', dir > 0 ? '▲' : '▼'));
    holdRepeat(b, () => { editSel('Transpose', (pt, ids) => transposeNotes(pt, ids, dir, scaleLock ? pcs() : null)); const n = selNotes()[0]; if (n) preview(n.pitch); draw(); }, (n) => (n < 2 ? 380 : 120));
    return b;
  }
  function velocityPopup() {
    const avg = () => { const ns = selNotes(); return ns.length ? ns.reduce((a, n) => a + (n.vel ?? 0.8), 0) / ns.length : 0.8; };
    openParamPopup(app, valueTarget({ key: 'vel', label: `Velocity (${selIds.length} notes)`, type: 'number', min: 0.05, max: 1, step: 0.01, default: 0.8, unit: '%' }, avg, (v) => { editSel('Velocity', (pt, ids) => setVelocity(pt, ids, { set: v })); draw(); }));
  }
  function quantizeMenu() {
    const q = snap || 0.25;
    const lbl = SNAPS.find((x) => x.value === q)?.label || `${q} beat`;
    actionSheet(`Quantize ${selIds.length} notes`, [
      { label: `Start + length to ${lbl}`, icon: 'magnet', onClick: () => editSel('Quantize', (pt, ids) => quantizeNotes(pt, ids, q)) },
      { label: `Starts only to ${lbl}`, onClick: () => editSel('Quantize', (pt, ids) => quantizeNotes(pt, ids, q, { ends: false })) },
      { label: '50 % towards the grid (keep the feel)', onClick: () => editSel('Quantize', (pt, ids) => quantizeNotes(pt, ids, q, { strength: 0.5, ends: false })) },
      { header: 'The grid is the snap setting above' },
    ]);
  }
  function selMoreMenu() {
    const pat = pattern();
    if (!pat) return;
    const bpb = beatsPerBar(get());
    const ns = selNotes();
    const bar0 = ns.length ? Math.floor(Math.min(...ns.map((n) => n.start)) / bpb) : 0;
    actionSheet('Selection', [
      { label: 'Select all notes', icon: 'layers', onClick: () => { selIds = pat.notes.map((n) => n.id); syncSelBar(); draw(); } },
      { label: `All notes in bar ${bar0 + 1}`, onClick: () => { selIds = notesInBox(pat.notes, bar0 * bpb, (bar0 + 1) * bpb, 0, 127); syncSelBar(); draw(); } },
      ns.length ? { label: 'Same pitch as the selection', onClick: () => { const ps = new Set(ns.map((n) => n.pitch)); selIds = pat.notes.filter((n) => ps.has(n.pitch)).map((n) => n.id); syncSelBar(); draw(); } } : null,
      { label: 'Invert selection', onClick: () => { const s = new Set(selIds); selIds = pat.notes.filter((n) => !s.has(n.id)).map((n) => n.id); syncSelBar(); draw(); } },
      '-',
      ns.length ? { label: '+1 octave', onClick: () => { editSel('Transpose', (pt, ids) => transposeNotes(pt, ids, 12)); draw(); } } : null,
      ns.length ? { label: '−1 octave', onClick: () => { editSel('Transpose', (pt, ids) => transposeNotes(pt, ids, -12)); draw(); } } : null,
      ns.length ? { label: 'Softer (−20 %)', onClick: () => editSel('Velocity', (pt, ids) => setVelocity(pt, ids, { scale: 0.8 })) } : null,
      ns.length ? { label: 'Louder (+20 %)', onClick: () => editSel('Velocity', (pt, ids) => setVelocity(pt, ids, { scale: 1.2 })) } : null,
      { label: 'Select none', icon: 'x', disabled: !ns.length, onClick: () => { selIds = []; syncSelBar(); draw(); } },
    ].filter(Boolean));
  }
  function syncSelBar() {
    selModeBtn.classList.toggle('on', selectMode);
    selModeBtn.textContent = selectMode ? '☑ Select' : '☐ Select';
    const pat = pattern();
    if (pat) { const ids = new Set(pat.notes.map((n) => n.id)); selIds = selIds.filter((id) => ids.has(id)); }
    const n = selIds.length;
    const show = mode === 'roll' && (n > 1 || selectMode);
    selBar.hidden = !show;
    if (!show) return;
    const chip = h('button.pk-selcount', { type: 'button', title: n ? 'Clear the selection' : 'Leave Select mode' }, n ? `${n} note${n === 1 ? '' : 's'}` : 'Tap notes', n ? h('span.pk-selcount-x', '×') : null);
    chip.addEventListener('click', () => { haptic(5); if (n) selIds = []; else selectMode = false; syncSelBar(); draw(); });
    selBar.replaceChildren(...[chip,
      n ? transposeBtn(1) : null, n ? transposeBtn(-1) : null,
      n ? selIb('magnet', 'Quantize', quantizeMenu) : null,
      n ? selIb('volume', 'Velocity', velocityPopup) : null,
      n ? selIb('copy', 'Duplicate', () => { let ids; editNotes('Duplicate notes', (pt) => { ids = duplicateNotes(pt, selIds, snap > 0 ? beatsPerBar(get()) : 0); }); if (ids?.length) selIds = ids; else app.toast('No room after the selection — make the pattern longer first.', { level: 'warn' }); syncSelBar(); draw(); }) : null,
      n ? selIb('trash', 'Delete', () => { editSel('Delete notes', (pt, ids) => deleteNotes(pt, ids)); selIds = []; selId = null; syncSelBar(); draw(); }) : null,
      selIb('menu', 'More', selMoreMenu),
      selectMode ? h('button.pk-chip.on.pk-sel-done', { type: 'button', onclick: () => { selectMode = false; haptic(5); syncSelBar(); draw(); } }, 'Done') : null,
    ].filter(Boolean));
  }

  // ============================================================ drum grid
  const gridEl = h('div.pk-drums', { 'data-noswipe': '' });
  const pagerEl = h('div.pk-chips.scroll.small');
  const drumWrap = h('div.pk-drum-wrap', pagerEl, gridEl);
  let drumPage = 0;
  const STEP = 0.25;
  function stepsPerPage() { return host.clientWidth >= 640 ? 16 : 8; }
  function renderDrums() {
    const pat = pattern();
    if (!pat) return;
    const spp = stepsPerPage();
    const total = Math.max(1, Math.round(pat.length / STEP));
    const pagesN = Math.ceil(total / spp);
    drumPage = Math.min(drumPage, pagesN - 1);
    pagerEl.replaceChildren(...Array.from({ length: pagesN }, (_, i) => {
      const b = h(`button.pk-chip${i === drumPage ? '.on' : ''}`, { type: 'button' }, `${i * spp + 1}–${Math.min(total, (i + 1) * spp)}`);
      b.addEventListener('click', () => { drumPage = i; haptic(5); renderDrums(); });
      return b;
    }));
    const used = new Set(pat.notes.map((n) => n.pitch));
    const edited = editedPads(track());
    const pads = DRUM_PADS.filter((d, i) => i < 9 || used.has(d.pitch));
    const first = drumPage * spp;
    const on = new Map();
    for (const n of pat.notes) on.set(`${n.pitch}:${Math.round(n.start / STEP)}`, n);
    gridEl.style.setProperty('--steps', String(spp));
    gridEl.replaceChildren(...pads.map((pad) => {
      const name = h(`button.pk-pad-name${edited.has(pad.key) ? '.edited' : ''}`, { type: 'button', title: 'Tap: pad settings (tune, decay, level…)' }, pad.name);
      name.addEventListener('click', () => { const t = track(); if (!t) return; engine.previewNote(t.id, pad.pitch, 0.9, 0.5); openPadSheet(app, t.id, pad); });
      const cells = [];
      for (let s = first; s < Math.min(total, first + spp); s++) {
        const n = on.get(`${pad.pitch}:${s}`);
        const cell = h(`div.pk-cell${n ? '.on' : ''}${s % 4 === 0 ? '.beat' : ''}`, { dataset: { pitch: pad.pitch, step: s } });
        if (n) cell.style.opacity = String(0.45 + 0.55 * (n.vel ?? 0.8));
        cells.push(cell);
      }
      return h('div.pk-drow', name, ...cells);
    }));
  }
  let paint = null;
  const cellAt = (x, y) => { const c = document.elementFromPoint(x, y); return c?.classList?.contains('pk-cell') ? c : null; };
  const toggleCell = (cell, add) => {
    const pitch = +cell.dataset.pitch, step = +cell.dataset.step;
    const start = step * STEP;
    editNotes(add ? 'Paint steps' : 'Erase steps', (pt) => {
      const i = pt.notes.findIndex((n) => n.pitch === pitch && Math.round(n.start / STEP) === step);
      if (add && i < 0) pt.notes.push(createNote(pitch, start, STEP, 0.8));
      if (!add && i >= 0) pt.notes.splice(i, 1);
    });
    cell.classList.toggle('on', add);
    cell.style.opacity = '';
    if (add) { const t = track(); if (t) engine.previewNote(t.id, pitch, 0.8, 0.25).catch(() => {}); }
    haptic(4);
  };
  gridEl.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest?.('.pk-cell');
    if (!cell) return;
    e.preventDefault();
    e.target.releasePointerCapture?.(e.pointerId);
    const add = !cell.classList.contains('on');
    paint = { add, seen: new Set([cell]), id: e.pointerId, x: e.clientX, y: e.clientY, cell, moved: false };
    if (!add) {
      // long-press a lit step: velocity / delete
      paint.lp = setTimeout(() => { if (paint && !paint.moved) { const c = paint.cell; paint = null; haptic(15); stepMenu(c); } }, 450);
      return;
    }
    toggleCell(cell, true);
  });
  gridEl.addEventListener('pointermove', (e) => {
    if (!paint || e.pointerId !== paint.id) return;
    if (!paint.moved && Math.hypot(e.clientX - paint.x, e.clientY - paint.y) > 6) {
      paint.moved = true; clearTimeout(paint.lp);
      if (!paint.add) toggleCell(paint.cell, false);
    }
    const c = cellAt(e.clientX, e.clientY);
    if (c && !paint.seen.has(c)) { paint.seen.add(c); toggleCell(c, paint.add); }
  });
  const paintEnd = (e) => {
    if (!paint || e.pointerId !== paint.id) return;
    clearTimeout(paint.lp);
    if (!paint.add && !paint.moved && e.type === 'pointerup') toggleCell(paint.cell, false);
    paint = null;
  };
  gridEl.addEventListener('pointerup', paintEnd);
  gridEl.addEventListener('pointercancel', paintEnd);
  gridEl.addEventListener('contextmenu', (e) => e.preventDefault());

  function stepMenu(cell) {
    const pitch = +cell.dataset.pitch, step = +cell.dataset.step;
    const setVel = (v) => editNotes('Step velocity', (pt) => { const n = pt.notes.find((x) => x.pitch === pitch && Math.round(x.start / STEP) === step); if (n) n.vel = v; });
    actionSheet(`${DRUM_PADS.find((d) => d.pitch === pitch)?.name || 'Step'} · step ${step + 1}`, [
      { label: 'Soft (ghost)', onClick: () => setVel(0.4) }, { label: 'Medium', onClick: () => setVel(0.7) }, { label: 'Loud (accent)', onClick: () => setVel(1) },
      { label: 'Delete step', icon: 'trash', onClick: () => editNotes('Erase steps', (pt) => { pt.notes = pt.notes.filter((x) => !(x.pitch === pitch && Math.round(x.start / STEP) === step)); }) },
    ]);
  }

  // ============================================================ menus
  function patternMenu() {
    const pat = pattern();
    const t = track();
    if (!pat || !t) return;
    const bpb = beatsPerBar(get());
    const bars = pat.length / bpb;
    actionSheet(pat.name, [
      { label: `Length: ${bars} bar${bars === 1 ? '' : 's'}`, submenu: [1, 2, 4, 8, 16].map((b) => ({ label: `${b} bar${b > 1 ? 's' : ''}`, checked: b === bars, onClick: () => editNotes('Pattern length', (pt) => { pt.length = b * bpb; pt.notes = pt.notes.filter((n) => n.start < pt.length); }) })) },
      { label: 'Double (copy the notes)', icon: 'copy', onClick: () => editNotes('Double pattern', (pt) => { const L = pt.length; pt.notes = [...pt.notes, ...pt.notes.map((n) => ({ ...n, id: uid('n'), start: n.start + L }))]; pt.length = L * 2; }) },
      { label: 'Quantize to the grid', icon: 'magnet', onClick: () => editNotes('Quantize', (pt) => { const q = snap || 0.25; for (const n of pt.notes) { n.start = Math.min(pt.length - q, snapRound(n.start, q)); n.dur = Math.max(q, snapRound(n.dur, q)); } }) },
      ...(isDrums(t) ? [] : [
        { label: 'Snap all notes to the key', icon: 'music', onClick: () => editNotes('Snap to key', (pt) => { for (const n of pt.notes) n.pitch = nearestInScale(n.pitch, pcs()); }) },
        { label: 'Transpose +1 octave', onClick: () => editNotes('Transpose', (pt) => { for (const n of pt.notes) n.pitch = Math.min(127, n.pitch + 12); }) },
        { label: 'Transpose −1 octave', onClick: () => editNotes('Transpose', (pt) => { for (const n of pt.notes) n.pitch = Math.max(0, n.pitch - 12); }) },
      ]),
      { label: 'Generate…', icon: 'dice', submenu: isDrums(t) ? [{ label: 'Drum beat', onClick: () => actions.generatePart('drums', { trackId: t.id }) }] : ['lead', 'bass', 'chords', 'arp', 'pad'].map((r) => ({ label: r, onClick: () => actions.generatePart(r, { trackId: t.id }) })) },
      { label: 'New empty pattern', icon: 'plus', onClick: () => actions.newPattern(t.id) },
      { label: 'Clear notes', icon: 'trash', onClick: () => editNotes('Clear pattern', (pt) => { pt.notes = []; }) },
    ]);
  }
  function moreMenu() { patternMenu(); }

  // ============================================================ render
  function render() {
    const t = track();
    syncLock();
    trackBtn.replaceChildren(h('span.pk-tc-dot', { style: { background: t?.color || 'var(--text-3)' } }), h('span', t ? `${t.name}` : 'Choose a track'), icon('chevronDown', 16));
    let next = 'none';
    if (t?.type === 'instrument') { actions.ensurePattern(t.id); next = isDrums(t) ? 'drums' : 'roll'; }
    if (next !== mode) {
      mode = next;
      if (mode === 'roll') host.replaceChildren(rollWrap);
      else if (mode === 'drums') host.replaceChildren(drumWrap);
      else host.replaceChildren(emptyState('Pick an instrument track', 'Notes are written into the selected track\'s pattern.', bigButton('Choose a track', () => pickTrack(app, { onPick: () => render() }), { ic: 'layers', cls: 'primary' }), bigButton('Add a track', () => addTrackSheet(app, () => render()), { ic: 'plus' })));
      toolbar.hidden = mode === 'none';
      lockBtn.hidden = mode === 'drums';
      selModeBtn.hidden = mode !== 'roll';
    }
    humBtn.hidden = mode !== 'roll';
    if (mode === 'drums') renderDrums();
    if (mode === 'roll') requestAnimationFrame(draw);
    syncSelBar();
  }
  let lastDrumSig = '';
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (mode === 'roll' && engine.isPlaying) draw();
    if (mode === 'drums') {
      const t = track();
      const pp = engine.isPlaying && t ? engine.getPatternPosition(t.id) : null;
      const s = pp == null ? -1 : Math.floor(pp / STEP);
      const sig = String(s);
      if (sig !== lastDrumSig) {
        lastDrumSig = sig;
        for (const c of gridEl.querySelectorAll('.pk-cell.ph')) c.classList.remove('ph');
        if (s >= 0) for (const c of gridEl.querySelectorAll(`.pk-cell[data-step="${s}"]`)) c.classList.add('ph');
      }
    }
  };
  new ResizeObserver(() => { if (visible && mode === 'roll') draw(); }).observe(rollWrap);
  app.subscribe((r) => {
    if (!visible) return;
    if (r.project || 'selectedTrackId' in r.ui || 'selectedPatternId' in r.ui) {
      if (mode === 'drums' && paint) return; // don't rebuild cells mid-paint
      render();
    }
  });
  void soundName;
  return {
    el,
    show() { visible = true; mode = null; render(); if (!raf) raf = requestAnimationFrame(frame); },
    hide() { visible = false; cancelAnimationFrame(raf); raf = 0; },
  };
}
