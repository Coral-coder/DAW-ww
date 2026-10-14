// Pocket automation lane (touch): draw with a finger (freehand, thinned), tap to add a point, drag points,
// long-press a point to delete it, presets (clear / ramps / LFOs), lane on/off and the "overridden" state.
// Used docked under the Song page timeline (shares its view) and as a sheet ("Automate this" in the control popup).
import { h, fitCanvas, cssVar } from '../ui/dom.js';
import { formatValue } from '../ui/components.js';
import { valueAt } from '../core/automation.js';
import { beatsPerBar, songLengthBeats } from '../core/model.js';
import { targetInfo, targetGroups, ownerInfo, laneLabel, formatLaneValue } from '../ui/automation-targets.js';
import { strokeToPoints, applyStroke, hitPoint, addPoint, movePoint, deletePoint, presetPoints, ensureLane, laneOf, valueToY, yToValue, LANE_PAD } from './auto-core.js';
import { pinchTime, fitPpb, snapTo } from './arrange-core.js';
import { openSheet, actionSheet, haptic, chips, bigButton } from './touch.js';

const LS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const SS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

/**
 * Lane editor. opts: {ownerId, target, height, getView() -> {ppb, x0}, setView(v) | null, getRange() -> {b0, b1, name}}.
 * Returns {el, draw(), setTarget(ownerId, target)}.
 */
export function createAutoLane(app, opts) {
  const { store, ui, engine } = app;
  const get = () => store.get();
  let ownerId = opts.ownerId, target = opts.target;
  let mode = LS('daw3-pocket-automode', 'draw'); // 'draw' | 'points'
  const canvas = h('canvas.pk-auto-cv', { 'data-noswipe': '' });
  const labelEl = h('button.pk-select.small.pk-auto-target', { type: 'button' });
  const valEl = h('span.pk-auto-val');
  const stateBtn = h('button.pk-chip', { type: 'button' });
  const modeChips = chips([{ value: 'draw', label: '✎ Draw' }, { value: 'points', label: '● Points' }], mode, (v) => { mode = v; SS('daw3-pocket-automode', v); draw(); });
  const presetBtn = h('button.pk-chip', { type: 'button' }, 'Shapes ▾');
  const bar = h('div.pk-auto-bar', labelEl, valEl);
  const tools = h('div.pk-auto-tools', { 'data-noswipe': '' }, modeChips, presetBtn, stateBtn);
  const hint = h('div.pk-auto-hint');
  const el = h('div.pk-auto', bar, tools, h('div.pk-auto-cvwrap', canvas, hint));
  if (opts.height) canvas.style.height = `${opts.height}px`;

  const info = () => targetInfo(get(), ownerId, target);
  const lane = () => laneOf(get(), ownerId, target);
  const view = () => opts.getView();
  const color = () => ownerInfo(get(), ownerId)?.color || cssVar('--accent');

  labelEl.addEventListener('click', () => pickAutomationTarget(app, { ownerId, onPick: (o, t) => setTarget(o, t) }));
  presetBtn.addEventListener('click', () => presetsMenu());
  stateBtn.addEventListener('click', () => {
    const l = lane();
    if (!l) return;
    haptic(6);
    store.transact(l.overridden ? 'Re-enable automation' : 'Toggle automation lane', (p) => {
      const ll = laneOf(p, ownerId, target);
      if (!ll) return;
      if (ll.overridden) { delete ll.overridden; ll.enabled = true; } else ll.enabled = ll.enabled === false;
    });
  });

  function setTarget(o, t) { ownerId = o; target = t; opts.onTarget?.(o, t); sync(); draw(); }

  function sync() {
    const l = lane();
    labelEl.textContent = target ? `${laneLabel(get(), ownerId, target)} ▾` : 'Choose what to automate ▾';
    stateBtn.hidden = !l;
    if (l) {
      stateBtn.textContent = l.overridden ? '↺ Re-enable (you moved it by hand)' : l.enabled === false ? 'Lane off' : 'Lane on';
      stateBtn.classList.toggle('on', l.enabled !== false && !l.overridden);
      stateBtn.classList.toggle('warn', !!l.overridden);
    }
    const songMode = get().mode === 'song';
    hint.textContent = !target ? '' : !l?.points?.length ? (mode === 'draw' ? 'Draw a line with your finger' : 'Tap to add points') : songMode ? '' : 'Automation plays in SONG mode';
    hint.hidden = !hint.textContent;
  }

  function range() {
    if (opts.getRange) return opts.getRange();
    const p = get();
    if (p.loop?.enabled && p.loop.end > p.loop.start) return { b0: p.loop.start, b1: p.loop.end, name: 'the loop' };
    return { b0: 0, b1: songLengthBeats(p), name: 'the whole song' };
  }
  function presetsMenu() {
    if (!target) return;
    const { b0, b1, name } = range();
    const bpb = beatsPerBar(get());
    const write = (kind, label, periodBeats) => edit(label, (l) => { l.points = presetPoints(l.points, kind, { b0, b1, def: info().def, periodBeats }); l.enabled = true; });
    const rates = [[0.5, '½ bar'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars']];
    actionSheet(`Shapes over ${name}`, [
      { label: 'Ramp up', icon: 'sparkles', onClick: () => write('up', 'Automation ramp') },
      { label: 'Ramp down', icon: 'sparkles', onClick: () => write('down', 'Automation ramp') },
      ...[['sine', 'Sine LFO'], ['triangle', 'Triangle LFO'], ['saw', 'Saw LFO'], ['square', 'Square LFO']].map(([k, lbl]) => ({ label: lbl, icon: 'wave', submenu: rates.map(([bars, rl]) => ({ label: `Cycle ${rl}`, onClick: () => write(k, 'Automation LFO', bars * bpb) })) })),
      '-',
      { label: `Clear ${name}`, icon: 'x', onClick: () => write('clear', 'Clear automation') },
      { label: 'Delete this lane', icon: 'trash', onClick: () => store.transact('Delete automation lane', (p) => { const o = p.tracks.find((t) => t.id === ownerId) || p.buses.find((b) => b.id === ownerId) || (ownerId === 'master' ? p.master : null); if (o) o.automation = (o.automation || []).filter((x) => x.target !== target); }) },
    ]);
  }

  /** Edit the lane (created on first edit) inside one transaction; drag = first call records undo, rest coalesce. */
  let dragStarted = false;
  function edit(label, fn, { drag = false } = {}) {
    store.transact(label, (p) => { const l = ensureLane(p, ownerId, target); if (l) fn(l); }, drag && dragStarted ? { undo: false } : {});
    if (drag) dragStarted = true;
  }

  // ------------------------------------------------------------------ drawing
  let W = 300, H = 120, stroke = null, dragIdx = -1;
  function draw() {
    if (!el.isConnected) return;
    const r = fitCanvas(canvas);
    const c = r.ctx;
    W = r.w; H = r.h;
    c.clearRect(0, 0, W, H);
    c.fillStyle = cssVar('--bg-2');
    c.fillRect(0, 0, W, H);
    if (!target) return;
    const v = view();
    const inf = info();
    const def = inf.def;
    const l = lane();
    const bpb = beatsPerBar(get());
    // bars
    for (let b = Math.max(0, Math.floor(v.x0 / bpb) * bpb); (b - v.x0) * v.ppb < W; b += bpb) {
      const x = Math.round((b - v.x0) * v.ppb);
      c.fillStyle = cssVar('--grid-beat') || 'rgba(128,128,128,.2)';
      c.fillRect(x, 0, 1, H);
    }
    // static value line
    c.strokeStyle = 'rgba(128,128,128,.45)';
    c.setLineDash([4, 4]);
    c.beginPath();
    const ys = valueToY(def, inf.staticValue ?? def.default ?? 0, H);
    c.moveTo(0, ys); c.lineTo(W, ys); c.stroke();
    c.setLineDash([]);
    const pts = l?.points || [];
    const off = !l || l.enabled === false || l.overridden;
    const col = color();
    if (pts.length) {
      c.strokeStyle = col;
      c.globalAlpha = off ? 0.35 : 1;
      c.lineWidth = 2.5;
      c.beginPath();
      const X = (b) => (b - v.x0) * v.ppb;
      c.moveTo(0, valueToY(def, valueAt(pts, v.x0), H));
      for (const pt of pts) c.lineTo(X(pt.beat), valueToY(def, pt.value, H));
      c.lineTo(W, valueToY(def, valueAt(pts, v.x0 + W / v.ppb), H));
      c.stroke();
      // fill under
      c.lineTo(W, H); c.lineTo(0, H); c.closePath();
      c.globalAlpha = off ? 0.06 : 0.14;
      c.fillStyle = col;
      c.fill();
      c.globalAlpha = 1;
      if (mode === 'points' || pts.length < 64) {
        pts.forEach((pt, i) => {
          const x = X(pt.beat);
          if (x < -10 || x > W + 10) return;
          c.beginPath();
          c.arc(x, valueToY(def, pt.value, H), i === dragIdx ? 9 : mode === 'points' ? 6 : 3, 0, Math.PI * 2);
          c.fillStyle = i === dragIdx ? cssVar('--text') : col;
          c.fill();
        });
      }
    }
    // live stroke
    if (stroke?.length > 1) {
      c.strokeStyle = cssVar('--text');
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(stroke[0].x, stroke[0].y);
      for (const s of stroke) c.lineTo(s.x, s.y);
      c.stroke();
    }
    // playhead
    if (engine.isPlaying) {
      const x = (engine.getPosition() - v.x0) * v.ppb;
      if (x >= 0 && x <= W) { c.fillStyle = cssVar('--accent-2'); c.fillRect(x, 0, 2, H); }
    }
    const b = engine.getPosition?.() || 0;
    const cur = pts.length ? valueAt(pts, b) : null;
    valEl.textContent = cur == null ? '' : formatLaneValue(def, cur, formatValue);
  }

  // ------------------------------------------------------------------ gestures
  const ptrs = new Map();
  let g = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const beatAt = (x) => Math.max(0, view().x0 + x / view().ppb);
  const snapPt = (b) => snapTo(b, 0.25);
  canvas.addEventListener('pointerdown', (e) => {
    if (!target) { pickAutomationTarget(app, { ownerId, onPick: (o, t) => setTarget(o, t) }); return; }
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) {
      clearTimeout(g?.lp);
      if (g?.type === 'stroke') stroke = null;
      const [a, b] = [...ptrs.values()];
      g = { type: 'pinch', xs: [a.x, b.x], v0: { ...view() } };
      draw();
      return;
    }
    if (ptrs.size > 2) return;
    const geo = { view: view(), h: H, def: info().def };
    const idx = hitPoint(lane()?.points, geo, p.x, p.y, mode === 'points' ? 24 : 14);
    dragStarted = false;
    if (idx >= 0) {
      g = { type: 'point', idx, x: p.x, y: p.y, moved: false, pts0: lane().points.map((q) => ({ ...q })) };
      dragIdx = idx;
      g.lp = setTimeout(() => {
        if (!g || g.moved || g.type !== 'point') return;
        haptic(25);
        edit('Delete automation point', (l) => { l.points = deletePoint(l.points, idx); });
        g = null; dragIdx = -1; draw();
      }, 480);
      draw();
    } else if (mode === 'draw') {
      g = { type: 'stroke' };
      stroke = [p];
    } else {
      g = { type: 'tap', x: p.x, y: p.y, moved: false, v0: { ...view() } };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e);
    ptrs.set(e.pointerId, p);
    if (!g) return;
    if (g.type === 'pinch') {
      if (ptrs.size < 2 || !opts.setView) return;
      const [a, b] = [...ptrs.values()];
      opts.setView(pinchTime(g.v0, g.xs, [a.x, b.x]));
      draw();
      return;
    }
    if (g.type === 'stroke') { stroke.push(p); draw(); return; }
    const dx = p.x - g.x, dy = p.y - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.lp); }
    if (g.type === 'tap') {
      // points mode: a drag on empty space pans the timeline
      if (opts.setView) { opts.setView({ ...g.v0, x0: Math.max(-1, g.v0.x0 - dx / g.v0.ppb) }); draw(); }
      return;
    }
    if (g.type === 'point') {
      const def = info().def;
      const o = g.pts0[g.idx];
      const beat = snapPt(Math.max(0, o.beat + dx / view().ppb));
      const value = yToValue(def, valueToY(def, o.value, H) + dy, H);
      edit('Edit automation', (l) => { l.points = movePoint(g.pts0, g.idx, beat, value); }, { drag: true });
      valEl.textContent = formatLaneValue(def, value, formatValue);
      draw();
    }
  });
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (!g) return;
    clearTimeout(g.lp);
    if (g.type === 'pinch') { if (!ptrs.size) g = null; return; }
    const gg = g;
    g = null;
    dragIdx = -1;
    if (e.type === 'pointercancel') { stroke = null; draw(); return; }
    const def = info().def;
    if (gg.type === 'stroke') {
      const s = stroke;
      stroke = null;
      if (s.length < 3) {
        // a tap in draw mode adds a point
        edit('Add automation point', (l) => { l.points = addPoint(l.points, snapPt(beatAt(s[0].x)), yToValue(def, s[0].y, H)).points; });
      } else {
        const res = strokeToPoints(s, { view: view(), h: H, def });
        edit('Draw automation', (l) => { l.points = applyStroke(l.points, res); l.enabled = true; });
      }
      haptic(8);
    } else if (gg.type === 'tap' && !gg.moved) {
      edit('Add automation point', (l) => { l.points = addPoint(l.points, snapPt(beatAt(gg.x)), yToValue(def, gg.y, H)).points; });
      haptic(8);
    }
    draw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const unsub = app.subscribe(() => { if (el.isConnected) { sync(); draw(); } });
  sync();
  return { el, destroy: unsub, draw: () => { sync(); draw(); }, setTarget, get target() { return target; }, get ownerId() { return ownerId; } };
}

/**
 * Pick an automation target: existing lanes first, then owner ▸ group ▸ parameter (tracks, buses, master).
 * onPick(ownerId, target).
 */
export function pickAutomationTarget(app, { ownerId = null, onPick }) {
  const p = app.store.get();
  const owners = [...p.tracks.map((t) => t.id), ...p.buses.map((b) => b.id), 'master'];
  const existing = [];
  for (const o of owners) for (const l of ownerInfo(p, o)?.owner?.automation || []) existing.push({ label: `${laneLabel(p, o, l.target)}${l.points?.length ? ` · ${l.points.length} pts` : ''}`, icon: 'sliders', onClick: () => onPick(o, l.target) });
  const groupsOf = (o) => targetGroups(p, o).map((g) => ({ label: g.name, submenu: g.items.map((it) => ({ label: it.label, onClick: () => onPick(o, it.target) })) }));
  const ownerItems = owners.map((o) => ({ label: ownerInfo(p, o)?.name || o, checked: o === ownerId, submenu: groupsOf(o) }));
  actionSheet('Automate…', [...(existing.length ? [{ header: 'Lanes in this song' }, ...existing, '-'] : []), { header: 'New lane' }, ...ownerItems]);
}

/** "Automate this": the lane of (owner, target) in a sheet, fitted to the song; creates it on the first edit. */
export function openAutomationSheet(app, ownerId, target) {
  const { store, actions } = app;
  const p = store.get();
  let v = { ppb: 8, x0: 0 };
  const lane = createAutoLane(app, { ownerId, target, height: 200, getView: () => v, setView: (nv) => { v = nv; } });
  const songBtn = bigButton('', () => { actions.setMode(store.get().mode === 'song' ? 'pattern' : 'song'); syncSong(); }, { ic: 'scenes', cls: 'ghost' });
  songBtn.append(h('span'));
  const syncSong = () => { songBtn.lastChild.textContent = store.get().mode === 'song' ? 'Playing: whole song' : 'Switch to Song mode (automation plays there)'; };
  syncSong();
  const help = h('p.pk-hint', 'Draw with a finger · tap to add · drag a point · long-press a point to delete · pinch to zoom');
  const sheet = openSheet({ title: 'Automation', body: [lane.el, help, songBtn], tall: true, cls: 'pk-auto-sheet', onClose: () => lane.destroy() });
  requestAnimationFrame(() => {
    const w = lane.el.querySelector('canvas')?.getBoundingClientRect().width || 340;
    v = { ppb: fitPpb(Math.max(songLengthBeats(p), 16), w), x0: 0 };
    lane.draw();
  });
  return sheet;
}
