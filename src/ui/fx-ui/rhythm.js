// Custom UI for rhythm effects, keyed by effect type. Each entry is (el, api) => ({ update?(fx), dispose?() }).
// el is the effect card body (generic param knobs are already in it); api = { fx, tgt, engine, app, probe(), edit }.
// Animation loops must stop by themselves once el.isConnected is false (cards are rebuilt without a dispose call).
//
//   trancegate  step editor: draw levels (click / drag), right-click toggles a step, pattern library, copy / paste,
//               shift, invert, random, clear; a playhead from the effect's beat clock (probe)
//   volshaper   curve editor: drag points (snap to grid, Shift = free), double-click adds / removes a point,
//               Alt-drag (or drag a segment's middle handle) bends the segment; shape library
//   beatrepeat  "Hold to stutter" button (momentary, not saved) and a repeat timeline
//   timeshaper  speed-curve view with playhead and a manual Trigger button
import { h, fitCanvas, startDrag } from '../dom.js';
import { contextMenu } from '../components.js';
import { resolveEffectParams, divisionToBeats } from '../../audio/effect-defs.js';
import {
  parsePattern, serializePattern, fitSteps, shiftPattern, invertPattern, randomPattern, gateConfig, stepStart,
  parseCurve, serializeCurve, curveAt, bend, repeatConfig, timeConfig, timeRead, speedExp, MAX_POINTS, mod,
} from '../../audio/fx/rhythm-dsp.js';
import { GATE_PATTERNS, SHAPER_CURVES } from '../../audio/fx/rhythm-library.js';

const divBeats = (d) => (d === '1/64' ? 1 / 16 : divisionToBeats(d));

// ------------------------------------------------------------------ shared bits
const CSS = `
.rfx { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 6px; width: 400px; max-width: 100%; }
.rfx-bar { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.rfx-bar select, .rfx-btn { font-size: 10.5px; height: 22px; background: var(--bg); color: var(--text-2); border: 1px solid var(--line); border-radius: 3px; padding: 0 6px; cursor: pointer; }
.rfx-bar select { max-width: 112px; }
.rfx-btn:hover, .rfx-bar select:hover { color: var(--text); border-color: var(--accent); }
.rfx-btn.on { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, var(--bg)); }
.rfx-canvas { width: 100%; height: 96px; display: block; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; touch-action: none; cursor: crosshair; }
.rfx-canvas.small { height: 46px; cursor: default; }
.rfx-hint { font-size: 10px; color: var(--text-3); }
.rfx-big { height: 44px; font-size: 13px; font-weight: 600; border-radius: 6px; border: 1px solid var(--line-2); background: var(--bg-3); color: var(--text); cursor: pointer; user-select: none; touch-action: none; }
.rfx-big:hover { border-color: var(--accent); }
.rfx-big.active { background: color-mix(in srgb, var(--accent) 45%, var(--bg-3)); border-color: var(--accent); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 45%, transparent); }
.rfx-big:disabled { opacity: .45; cursor: default; }
.rfx-bar .rfx-big { flex: 1; }
.rfx-status { font: 10.5px var(--mono); color: var(--text-3); min-height: 14px; }
.rfx-status.on { color: var(--accent); }
`;
function ensureCss() {
  if (document.getElementById('rfx-css')) return;
  document.head.appendChild(h('style#rfx-css', CSS));
}

/** Theme colours for canvases (re-read every couple of seconds: theme switches). */
function themeReader() {
  let t = 0, c = null;
  return () => {
    const now = performance.now();
    if (!c || now - t > 2000) {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      c = { accent: v('--accent', '#7c5cff'), accent2: v('--accent-2', '#3bc9db'), text: v('--text', '#eee'), text3: v('--text-3', '#777'), line: v('--line', '#333'), line2: v('--line-2', '#444'), bg3: v('--bg-3', '#222'), warn: v('--warn', '#ffa94d') };
      t = now;
    }
    return c;
  };
}

/** rAF loop that ends once the element left the document. */
function loop(el, draw) {
  let raf = 0;
  const tick = () => {
    if (!el.isConnected) { raf = 0; return; }
    try { draw(); } catch (e) { console.warn('[fx-ui]', e); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
}

/** The editor goes above the generic knobs (it is the effect's main control; the device panel is short). */
function mount(el, node) {
  const params = [...el.children].find((c) => c.classList?.contains('dv-params'));
  if (params) el.insertBefore(node, params); else el.appendChild(node);
}

const btn = (label, title, onClick) => {
  const b = h('button.rfx-btn', { type: 'button', title }, label);
  b.addEventListener('click', onClick);
  return b;
};

/** Commits at most once per animation frame (drawing gestures), coalesced into one undo step. */
function throttledEdit(api, label) {
  let pending = null, raf = 0;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const fn = pending; pending = null;
    api.edit(label, fn, { coalesce: true });
  };
  return {
    push(fn) { pending = fn; if (!raf) raf = requestAnimationFrame(flush); },
    flush() { if (raf) cancelAnimationFrame(raf); flush(); },
  };
}

let clipboard = null; // { kind: 'steps'|'curve', value }
async function copyText(kind, text) {
  clipboard = { kind, value: text };
  try { await navigator.clipboard?.writeText(text); } catch { /* not allowed: in-app clipboard only */ }
}
async function pasteText(kind, parse) {
  try {
    const t = await navigator.clipboard?.readText();
    if (t && parse(t)) return t.trim();
  } catch { /* permission denied */ }
  return clipboard?.kind === kind ? clipboard.value : null;
}

// ================================================================== trance gate
function tranceGateUi(el, api) {
  ensureCss();
  let p = resolveEffectParams(api.fx);
  let side = 'L';
  const theme = themeReader();
  const keyOf = () => (side === 'R' && p.stereo === 'separate' ? 'patternR' : 'pattern');
  /** All stored levels (may be longer than the step count) for the edited side. */
  const stored = () => {
    const own = parsePattern(p[keyOf()]);
    const base = own || parsePattern(p.pattern) || [1];
    return fitSteps(base, Math.max(base.length, p.steps));
  };
  let draft = null; // levels while drawing (before the store echoes back)
  const levels = () => draft || stored();
  const commitNow = (lv, label) => {
    const key = keyOf();
    const s = serializePattern(lv);
    api.edit(`Trance Gate: ${label}`, (params) => { params[key] = s; });
  };
  const drawEdit = throttledEdit(api, 'Trance Gate: draw steps');
  const pushDraw = (lv) => {
    const key = keyOf();
    const s = serializePattern(lv);
    drawEdit.push((params) => { params[key] = s; });
  };
  const op = (label, fn) => {
    const all = stored();
    const n = p.steps;
    const head = fn(all.slice(0, n));
    commitNow(head.concat(all.slice(n)), label);
  };

  const presetSel = h('select', { title: 'Load a gate pattern (keeps the envelope settings)' },
    h('option', { value: '' }, 'Patterns…'),
    Object.keys(GATE_PATTERNS).map((n) => h('option', { value: n }, n)));
  presetSel.addEventListener('change', () => {
    const g = GATE_PATTERNS[presetSel.value];
    presetSel.value = '';
    if (!g) return;
    api.edit('Trance Gate: pattern', (params) => {
      params.pattern = g.pattern;
      params.steps = g.steps || 16;
      params.division = g.division || '1/16';
      if (g.stereo) { params.stereo = g.stereo; if (g.stereoOffset != null) params.stereoOffset = g.stereoOffset; } else if (params.stereo === 'separate') params.stereo = 'mono';
      if (g.patternR) params.patternR = g.patternR;
    });
  });
  const sideL = btn('L', 'Edit the left / main pattern', () => { side = 'L'; syncBar(); });
  const sideR = btn('R', 'Edit the right-channel pattern (Stereo: Separate R)', () => { side = 'R'; syncBar(); });
  const sides = h('span.rfx-bar', sideL, sideR);
  const bar = h('div.rfx-bar',
    presetSel, sides,
    btn('Copy', 'Copy the pattern', () => copyText('steps', serializePattern(levels().slice(0, p.steps)))),
    btn('Paste', 'Paste a copied pattern', async () => {
      const t = await pasteText('steps', parsePattern);
      const lv = t && parsePattern(t);
      if (lv) op('paste', (cur) => fitSteps(lv, cur.length));
    }),
    btn('◀', 'Shift the pattern one step earlier', () => op('shift left', (cur) => shiftPattern(cur, -1))),
    btn('▶', 'Shift the pattern one step later', () => op('shift right', (cur) => shiftPattern(cur, 1))),
    btn('Invert', 'Swap on and off steps', () => op('invert', invertPattern)),
    btn('Random', 'Random pattern', () => op('randomize', (cur) => randomPattern(cur.length))),
    btn('Clear', 'All steps off', () => op('clear', (cur) => cur.map(() => 0))));
  const syncBar = () => {
    sides.style.display = p.stereo === 'separate' ? '' : 'none';
    sideL.classList.toggle('on', side === 'L');
    sideR.classList.toggle('on', side === 'R');
  };
  syncBar();

  const canvas = h('canvas.rfx-canvas', { title: 'Click / drag: draw step levels · right-click: toggle a step · Shift: snap to 25 %' });
  const hint = h('div.rfx-hint', 'Draw levels · right-click toggles · Shift snaps to 25 %');
  mount(el, h('div.rfx.rfx-gate', bar, canvas, hint));

  const geom = () => {
    const r = canvas.getBoundingClientRect();
    const lane = p.stereo !== 'mono' ? 12 : 0;
    return { r, w: r.width, hMain: r.height - lane - 2, lane };
  };
  const hit = (ev) => {
    const { r, w, hMain } = geom();
    const n = p.steps;
    const i = Math.max(0, Math.min(n - 1, Math.floor(((ev.clientX - r.left) / w) * n)));
    let v = 1 - (ev.clientY - r.top - 2) / hMain;
    v = Math.max(0, Math.min(1, v));
    v = ev.shiftKey ? Math.round(v * 4) / 4 : Math.round(v * 100) / 100;
    if (v < 0.03) v = 0;
    return { i, v };
  };
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const { i } = hit(ev);
    op('toggle step', (cur) => cur.map((x, k) => (k === i ? (x > 0 ? 0 : 1) : x)));
  });
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    draft = stored().slice();
    let last = hit(ev);
    draft[last.i] = last.v;
    pushDraw(draft);
    startDrag(ev, (dx, dy, e) => {
      const cur = hit(e);
      const a = Math.min(last.i, cur.i), b = Math.max(last.i, cur.i);
      for (let k = a; k <= b; k++) draft[k] = b === a ? cur.v : last.v + ((cur.v - last.v) * (k - last.i)) / (cur.i - last.i);
      for (let k = a; k <= b; k++) draft[k] = Math.round(draft[k] * 100) / 100;
      last = cur;
      pushDraw(draft);
    }, () => { drawEdit.flush(); draft = null; });
  });

  const draw = () => {
    const { ctx, w, h: hh } = fitCanvas(canvas);
    const c = theme();
    const n = p.steps;
    const lv = levels();
    const lane = p.stereo !== 'mono' ? 12 : 0;
    const hMain = hh - lane - 2;
    ctx.clearRect(0, 0, w, hh);
    const cfg = gateConfig(p, divBeats);
    const sw = w / n;
    // beat lines
    const beat = cfg.stepBeats;
    for (let k = 0; k <= n; k++) {
      const onBeat = Math.abs((k * beat) % 1) < 1e-6 || Math.abs((k * beat) % 1 - 1) < 1e-6;
      if (!onBeat && k % 4) continue;
      ctx.fillStyle = (k * beat) % 4 < 1e-6 ? c.line2 : c.line;
      ctx.fillRect(Math.round(k * sw), 0, 1, hh);
    }
    const probe = api.probe();
    const cur = probe?.kind === 'trancegate' ? probe.step() : -1;
    for (let k = 0; k < n; k++) {
      const v = lv[k] || 0;
      const x = k * sw + 1;
      // swing: odd steps drawn late by the swing amount
      const off = ((stepStart(k, 1, cfg.swing) - k) * sw) || 0;
      ctx.fillStyle = c.bg3;
      ctx.fillRect(x + off, 2, Math.max(1, sw - 2), hMain);
      if (v > 0) {
        ctx.globalAlpha = k === cur ? 1 : 0.78;
        ctx.fillStyle = side === 'R' && p.stereo === 'separate' ? c.accent2 : c.accent;
        const bh = v * hMain;
        ctx.fillRect(x + off, 2 + hMain - bh, Math.max(1, (sw - 2) * cfg.length), bh);
        ctx.globalAlpha = 1;
      }
      if (k === cur) { ctx.strokeStyle = c.text; ctx.lineWidth = 1; ctx.strokeRect(x + off + 0.5, 2.5, Math.max(1, sw - 3), hMain - 1); }
    }
    // right-channel preview lane
    if (lane) {
      const R = cfg.R;
      for (let k = 0; k < n; k++) {
        const v = R[k] || 0;
        ctx.fillStyle = c.bg3;
        ctx.fillRect(k * sw + 1, hh - lane, Math.max(1, sw - 2), lane - 1);
        if (v > 0) { ctx.fillStyle = c.accent2; ctx.globalAlpha = 0.35 + 0.65 * v; ctx.fillRect(k * sw + 1, hh - lane, Math.max(1, sw - 2), lane - 1); ctx.globalAlpha = 1; }
      }
      ctx.fillStyle = c.text3; ctx.font = '8px sans-serif'; ctx.fillText('R', 2, hh - 3);
    }
  };
  loop(el, draw);
  return {
    update(fx) { p = resolveEffectParams(fx); if (p.stereo !== 'separate') side = 'L'; syncBar(); },
  };
}

// ================================================================== volume shaper
function volumeShaperUi(el, api) {
  ensureCss();
  let p = resolveEffectParams(api.fx);
  const theme = themeReader();
  let draft = null; // points while dragging
  const points = () => draft || parseCurve(p.shape) || [{ x: 0, y: 1, t: 0 }];
  const commit = (pts, label) => { const s = serializeCurve(pts); api.edit(`Volume Shaper: ${label}`, (params) => { params.shape = s; }); };
  const dragEdit = throttledEdit(api, 'Volume Shaper: edit curve');
  const pushDrag = (pts) => { const s = serializeCurve(pts); dragEdit.push((params) => { params.shape = s; }); };

  const sel = h('select', { title: 'Load a shape' }, h('option', { value: '' }, 'Shapes…'), Object.keys(SHAPER_CURVES).map((n) => h('option', { value: n }, n)));
  sel.addEventListener('change', () => { const s = SHAPER_CURVES[sel.value]; sel.value = ''; if (s) api.edit('Volume Shaper: shape', (params) => { params.shape = s; }); });
  const bar = h('div.rfx-bar', sel,
    btn('Copy', 'Copy the curve', () => copyText('curve', serializeCurve(points()))),
    btn('Paste', 'Paste a copied curve', async () => { const t = await pasteText('curve', parseCurve); if (t && parseCurve(t)) commit(parseCurve(t), 'paste'); }),
    btn('Flip', 'Turn the curve upside down', () => commit(points().map((q) => ({ ...q, y: 1 - q.y, t: -q.t })), 'flip')),
    btn('Mirror', 'Play the curve backwards', () => commit(points().map((q) => ({ x: 1 - q.x, y: q.y, t: 0 })).reverse(), 'mirror')),
    btn('Flat', 'Reset to a flat line', () => commit([{ x: 0, y: 1, t: 0 }], 'flat')));
  const canvas = h('canvas.rfx-canvas', { style: { height: '110px' }, title: 'Drag points · double-click adds / removes · Alt-drag or the middle handle bends a segment · Shift: no snap' });
  const hint = h('div.rfx-hint', 'Drag points · double-click to add / remove · Alt-drag bends · Shift = no snap');
  mount(el, h('div.rfx.rfx-shaper', bar, canvas, hint));

  const PAD = 6;
  const toXY = (q, w, hh) => [PAD + q.x * (w - 2 * PAD), PAD + (1 - q.y) * (hh - 2 * PAD)];
  const fromEv = (ev, snap) => {
    const r = canvas.getBoundingClientRect();
    let x = (ev.clientX - r.left - PAD) / (r.width - 2 * PAD);
    let y = 1 - (ev.clientY - r.top - PAD) / (r.height - 2 * PAD);
    x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
    if (snap && p.snap) { const g = Number(p.grid) || 16; x = Math.round(x * g) / g; y = Math.round(y * 20) / 20; }
    return { x, y };
  };
  const segHandles = (pts, w, hh) => pts.map((a, i) => {
    const b = pts[i + 1] || { ...pts[0], x: pts[0].x + 1 };
    if (b.x - a.x < 1e-6) return null;
    const xm = (a.x + b.x) / 2;
    const ym = a.y + (b.y - a.y) * bend(0.5, a.t);
    const [px, py] = toXY({ x: xm > 1 ? xm - 1 : xm, y: ym }, w, hh);
    return { i, px, py };
  });
  const pick = (ev) => {
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const pts = points();
    let best = -1, bd = 9;
    pts.forEach((q, i) => { const [x, y] = toXY(q, r.width, r.height); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) return { kind: 'point', i: best };
    const hs = segHandles(pts, r.width, r.height);
    for (const s of hs) if (s && Math.hypot(s.px - mx, s.py - my) < 7) return { kind: 'tension', i: s.i };
    return null;
  };
  const tensionDrag = (ev, i) => {
    const pts = points().map((q) => ({ ...q }));
    const t0 = pts[i].t || 0;
    const rising = (pts[i + 1] || pts[0]).y >= pts[i].y;
    draft = pts;
    startDrag(ev, (dx, dy) => {
      pts[i].t = Math.max(-1, Math.min(1, t0 + (rising ? dy : -dy) / 60));
      if (Math.abs(pts[i].t) < 0.03) pts[i].t = 0;
      pushDrag(pts);
    }, () => { dragEdit.flush(); draft = null; });
  };
  const pointDrag = (ev, target) => {
    const pts = points().map((q) => ({ ...q }));
    const moving = target != null ? pts[target] : null;
    if (!moving) return;
    draft = pts;
    startDrag(ev, (dx, dy, e) => {
      const { x, y } = fromEv(e, !e.shiftKey);
      moving.x = x; moving.y = y;
      draft = pts.map((q, i) => ({ q, i })).sort((a, b) => a.q.x - b.q.x || a.i - b.i).map((o) => o.q);
      pushDrag(draft);
    }, () => { dragEdit.flush(); draft = null; });
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const hitp = pick(ev);
    if (hitp?.kind === 'tension') return tensionDrag(ev, hitp.i);
    if (ev.altKey) {
      // bend the segment under the cursor
      const { x } = fromEv(ev, false);
      const pts = points();
      let i = pts.length - 1;
      for (let k = 0; k < pts.length; k++) if (pts[k].x <= x) i = k;
      return tensionDrag(ev, i);
    }
    if (hitp?.kind === 'point') return pointDrag(ev, hitp.i);
    if (ev.detail >= 2) return; // dblclick handles adding
    // click on empty space: add a point there and keep dragging it
    const pts = points();
    if (pts.length >= MAX_POINTS) return;
    const np = { ...fromEv(ev, !ev.shiftKey), t: 0 };
    const next = pts.concat([np]).map((q, i) => ({ q, i })).sort((a, b) => a.q.x - b.q.x || a.i - b.i).map((o) => o.q);
    draft = next.map((q) => ({ ...q }));
    pushDrag(draft);
    pointDrag(ev, next.indexOf(np));
  });
  canvas.addEventListener('dblclick', (ev) => {
    const hitp = pick(ev);
    if (hitp?.kind === 'point' && points().length > 1) commit(points().filter((_, i) => i !== hitp.i), 'remove point');
  });
  canvas.addEventListener('contextmenu', (ev) => {
    const hitp = pick(ev);
    if (hitp?.kind !== 'point') { ev.preventDefault(); return; }
    contextMenu(ev, [
      { label: 'Delete point', disabled: points().length <= 1, onClick: () => commit(points().filter((_, i) => i !== hitp.i), 'remove point') },
      { label: 'Straight segment', onClick: () => commit(points().map((q, i) => (i === hitp.i ? { ...q, t: 0 } : q)), 'straighten') },
    ]);
  });

  const draw = () => {
    const { ctx, w, h: hh } = fitCanvas(canvas);
    const c = theme();
    const pts = points();
    ctx.clearRect(0, 0, w, hh);
    const g = Number(p.grid) || 16;
    for (let k = 0; k <= g; k++) {
      const x = PAD + (k / g) * (w - 2 * PAD);
      ctx.fillStyle = k % 4 === 0 ? c.line2 : c.line;
      ctx.fillRect(Math.round(x), 0, 1, hh);
    }
    ctx.fillStyle = c.line;
    ctx.fillRect(0, PAD + (hh - 2 * PAD) / 2, w, 1);
    // effective gain (depth applied) as a filled area, the raw curve as a line
    const N = Math.max(64, Math.floor(w));
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const y = 1 - p.depth * (1 - curveAt(pts, x));
      const [px, py] = toXY({ x, y }, w, hh);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.lineTo(w - PAD, hh - PAD); ctx.lineTo(PAD, hh - PAD); ctx.closePath();
    ctx.fillStyle = c.accent; ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const [px, py] = toXY({ x, y: curveAt(pts, x) }, w, hh);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.strokeStyle = c.accent; ctx.lineWidth = 1.6; ctx.stroke();
    for (const s of segHandles(pts, w, hh)) {
      if (!s) continue;
      ctx.fillStyle = c.text3;
      ctx.fillRect(s.px - 2.5, s.py - 2.5, 5, 5);
    }
    for (const q of pts) {
      const [px, py] = toXY(q, w, hh);
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = c.text; ctx.fill();
      ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5; ctx.stroke();
    }
    const probe = api.probe();
    if (probe?.kind === 'volshaper') {
      const ph = mod(probe.phase(), 1);
      const x = PAD + ph * (w - 2 * PAD);
      ctx.fillStyle = c.warn; ctx.fillRect(Math.round(x), 0, 1.5, hh);
      const [, py] = toXY({ x: ph, y: 1 - p.depth * (1 - curveAt(pts, ph)) }, w, hh);
      ctx.beginPath(); ctx.arc(x, py, 3, 0, Math.PI * 2); ctx.fill();
    }
  };
  loop(el, draw);
  return { update(fx) { p = resolveEffectParams(fx); } };
}

// ================================================================== beat repeat
function beatRepeatUi(el, api) {
  ensureCss();
  let p = resolveEffectParams(api.fx);
  const theme = themeReader();
  const stutter = h('button.rfx-big', { type: 'button', title: 'Hold to repeat the current slice (starts on the next Repeat grid line; not saved)' }, 'Hold to stutter');
  let held = false;
  const down = (ev) => {
    ev.preventDefault();
    stutter.setPointerCapture?.(ev.pointerId);
    held = true;
    api.probe()?.hold?.(true);
  };
  const up = () => { if (!held) return; held = false; api.probe()?.hold?.(false); };
  stutter.addEventListener('pointerdown', down);
  stutter.addEventListener('pointerup', up);
  stutter.addEventListener('pointercancel', up);
  stutter.addEventListener('lostpointercapture', up);
  const status = h('div.rfx-status', '');
  const canvas = h('canvas.rfx-canvas.small', { title: 'One interval: capture point, gate and repeat slices' });
  mount(el, h('div.rfx.rfx-repeat', stutter, status, canvas));
  const draw = () => {
    const probe = api.probe();
    const st = probe?.kind === 'beatrepeat' ? probe.state() : { active: false };
    stutter.classList.toggle('active', !!(st.active && (st.manual || held)));
    status.classList.toggle('on', !!st.active);
    status.textContent = st.active ? `repeating · slice ${st.n + 1}${st.manual ? ' (manual)' : ''}` : (probe?.mode === 'fallback' ? 'AudioWorklet unavailable: pass-through' : 'waiting');
    const { ctx, w, h: hh } = fitCanvas(canvas);
    const c = theme();
    const cfg = repeatConfig(p, divBeats);
    const span = Math.max(cfg.interval, cfg.offset + cfg.gate);
    const X = (b) => (b / span) * w;
    ctx.clearRect(0, 0, w, hh);
    for (let b = 0; b <= span + 1e-9; b += 1) { ctx.fillStyle = b % 4 === 0 ? c.line2 : c.line; ctx.fillRect(Math.round(X(b)), 0, 1, hh); }
    ctx.fillStyle = c.accent; ctx.globalAlpha = cfg.chance > 0 ? 0.25 + 0.5 * cfg.chance : 0.08;
    ctx.fillRect(X(cfg.offset), 4, X(cfg.offset + cfg.gate) - X(cfg.offset), hh - 8);
    ctx.globalAlpha = 1;
    // slices with decay
    for (let k = 0; cfg.offset + k * cfg.grid < cfg.offset + cfg.gate - 1e-9 && k < 256; k++) {
      const x = X(cfg.offset + k * cfg.grid);
      const g = Math.pow(1 - cfg.decay, k);
      ctx.fillStyle = c.accent;
      ctx.fillRect(Math.round(x), hh - 4 - (hh - 10) * g, 1.5, (hh - 10) * g);
    }
    if (probe?.kind === 'beatrepeat') {
      const b = probe.beat();
      const pos = mod(b, cfg.interval);
      ctx.fillStyle = c.warn;
      ctx.fillRect(Math.round(X(pos)), 0, 1.5, hh);
    }
  };
  loop(el, draw);
  return { update(fx) { p = resolveEffectParams(fx); }, dispose() { up(); } };
}

// ================================================================== time shaper
function timeShaperUi(el, api) {
  ensureCss();
  let p = resolveEffectParams(api.fx);
  const theme = themeReader();
  const trig = h('button.rfx-big', { type: 'button', title: 'Fire the effect on the next 1/16 (Trigger: Manual)' }, 'Trigger');
  trig.addEventListener('pointerdown', (ev) => { ev.preventDefault(); api.probe()?.trigger?.(); });
  const toManual = btn('Switch to manual trigger', 'Set Trigger to Manual', () => api.edit('Time Shaper: manual trigger', (params) => { params.trigger = 'manual'; }));
  const status = h('div.rfx-status', '');
  const canvas = h('canvas.rfx-canvas.small', { style: { height: '64px' }, title: 'Playback speed across the effect window' });
  mount(el, h('div.rfx.rfx-time', h('div.rfx-bar', trig, toManual), status, canvas));
  const sync = () => {
    const manual = p.trigger === 'manual';
    trig.disabled = !manual;
    toManual.style.display = manual ? 'none' : '';
  };
  sync();
  const NAMES = { tapestop: 'tape stop', tapestart: 'tape start', reverse: 'reverse', halfspeed: 'half speed' };
  const draw = () => {
    const probe = api.probe();
    const st = probe?.kind === 'timeshaper' ? probe.state() : { active: false };
    trig.classList.toggle('active', !!st.active && p.trigger === 'manual');
    status.classList.toggle('on', !!st.active);
    status.textContent = st.active ? `${NAMES[st.mode] || st.mode} · ${Math.round(st.u * 100)}%` : (probe?.mode === 'fallback' ? 'AudioWorklet unavailable: pass-through' : p.trigger === 'manual' ? 'press Trigger' : `every ${p.every} bar${p.every > 1 ? 's' : ''}`);
    const { ctx, w, h: hh } = fitCanvas(canvas);
    const c = theme();
    const cfg = timeConfig(p, divBeats);
    const pexp = speedExp(cfg.curve);
    const parts = [{ mode: cfg.mode, len: cfg.length }];
    if (cfg.mode === 'tapestop' && cfg.tapeStart) parts.push({ mode: 'tapestart', len: cfg.startLength });
    const total = parts.reduce((s, x) => s + x.len, 0);
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = c.line; ctx.fillRect(0, Math.round(hh / 2), w, 1);
    let x0 = 0;
    for (const part of parts) {
      const pw = (part.len / total) * w;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const u = i / 64;
        const r = timeRead(part.mode, u, 1, pexp).rate;
        const y = hh - 4 - ((r + 1) / 2) * (hh - 8); // speed -1..1
        if (i) ctx.lineTo(x0 + u * pw, y); else ctx.moveTo(x0 + u * pw, y);
      }
      ctx.strokeStyle = part.mode === 'tapestart' ? c.accent2 : c.accent; ctx.lineWidth = 1.6; ctx.stroke();
      if (st.active && st.mode === part.mode) { ctx.fillStyle = c.warn; ctx.fillRect(Math.round(x0 + st.u * pw), 0, 1.5, hh); }
      x0 += pw;
    }
    ctx.fillStyle = c.text3; ctx.font = '8px sans-serif';
    ctx.fillText('1×', 2, 10); ctx.fillText('0', 2, hh / 2 - 2); ctx.fillText('−1×', 2, hh - 3);
  };
  loop(el, draw);
  return { update(fx) { p = resolveEffectParams(fx); sync(); } };
}

export default {
  trancegate: tranceGateUi,
  volshaper: volumeShaperUi,
  beatrepeat: beatRepeatUi,
  timeshaper: timeShaperUi,
};
