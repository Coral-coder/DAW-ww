// Modulation UI (device panel): the macro row in the header, the "Modulation" card (modulator editors incl. the
// MSEG curve editor and the step editor, the mod matrix), drag-to-modulate (drag a modulator / macro handle onto any
// knob) and the modulation rings drawn on modulated knobs. Data model + math: src/core/modulation.js; audio:
// src/audio/mod/runner.js (engine.getModView gives the live values).
import { h, icon, startDrag, fitCanvas, clear } from './dom.js';
import { knob, select, toggle, button, iconButton, contextMenu, promptText, markAuto, trackSelect } from './components.js';
import {
  createModState, createModulator, createRoute, MOD_TYPES, MOD_TYPE_LABELS, LFO_SHAPES, MOD_DIVISIONS, MACRO_COUNT,
  lfoShapeValue, stepValue, randomValue, msegValue, snapPoint, sanitizeMseg, routesByTarget, targetExtent,
} from '../core/modulation.js';
import { toNorm } from '../core/automation.js';
import { modTargets, modTargetInfo } from '../audio/mod/targets.js';

const SHAPE_LABELS = { sine: 'Sine', triangle: 'Triangle', saw: 'Saw up', ramp: 'Saw down', square: 'Square', mseg: 'Drawn (MSEG)' };
const TYPE_ICONS = { lfo: 'wave', env: 'sliders', step: 'grid', random: 'dice', follow: 'volume' };
const num = (key, label, min, max, def, o = {}) => ({ key, label, type: 'number', min, max, default: def, step: o.step ?? 0.001, unit: o.unit, curve: o.curve || 'lin' });
const D = {
  rate: num('rate', 'Rate', 0.01, 50, 2, { unit: 'Hz', curve: 'log', step: 0.01 }),
  phase: num('phase', 'Phase', 0, 1, 0, { step: 0.01 }),
  a: num('a', 'Attack', 0, 10, 0.01, { unit: 's', curve: 'exp' }), d: num('d', 'Decay', 0, 10, 0.4, { unit: 's', curve: 'exp' }),
  s: num('s', 'Sustain', 0, 1, 0.3, { step: 0.01 }), r: num('r', 'Release', 0, 10, 0.3, { unit: 's', curve: 'exp' }),
  glide: num('glide', 'Glide', 0, 1, 0, { step: 0.01 }), smooth: num('smooth', 'Smooth', 0, 1, 0, { step: 0.01 }),
  attack: num('attack', 'Attack', 0.001, 2, 0.01, { unit: 's', curve: 'log' }), release: num('release', 'Release', 0.005, 5, 0.15, { unit: 's', curve: 'log' }),
  gain: num('gain', 'Gain', -24, 24, 0, { unit: 'dB', step: 0.1 }),
  amount: num('amount', 'Amount', -1, 1, 0.25), min: num('min', 'From', -1, 1, 0), curve: num('curve', 'Curve', -1, 1, 0, { step: 0.01 }),
};
const isMacroSrc = (src) => String(src).startsWith('macro:');
const getTrack = (app, id) => app.store.get().tracks.find((t) => t.id === id);

/** Edit a track's modulation block inside one store transaction (creates it on first use). */
export function editMod(app, trackId, label, fn, opts) {
  app.store.transact(label, (p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    if (!t.mod) t.mod = createModState();
    const base = createModState().macros;
    if (!Array.isArray(t.mod.macros) || t.mod.macros.length < MACRO_COUNT) t.mod.macros = base.map((d, i) => t.mod.macros?.[i] || d);
    t.mod.mods ||= [];
    t.mod.routes ||= [];
    fn(t.mod, t, p);
  }, opts);
}

/** Display name of a route source. */
export function sourceLabel(track, src) {
  if (isMacroSrc(src)) { const i = Number(src.slice(6)); return track?.mod?.macros?.[i]?.name || `Macro ${i + 1}`; }
  return track?.mod?.mods?.find((m) => m.id === src)?.name || '(removed)';
}

/** Add src -> target (no duplicates). Returns false when it already exists or the target can't be modulated. */
export function addRoute(app, trackId, src, target) {
  const p = app.store.get();
  const t = getTrack(app, trackId);
  if (!t || !modTargetInfo(p, t, target)) return false;
  if (t.mod?.routes?.some((r) => r.src === src && r.target === target)) { app.setStatus?.('Already modulated by this source — adjust its amount in the Modulation card.'); return false; }
  const mod = t.mod?.mods?.find((m) => m.id === src);
  const bip = mod && (mod.type === 'lfo' || mod.type === 'random');
  const route = createRoute(src, target, { amount: isMacroSrc(src) ? 0.5 : bip ? 0.25 : 0.4, bipolar: !!bip });
  const label = `${sourceLabel(t, src)} → ${modTargetInfo(p, t, target).label}`;
  editMod(app, trackId, `Modulate: ${label}`, (m) => { m.routes.push(route); });
  app.setStatus?.(`${label} — drag its amount in the Modulation card (Matrix tab for curve / range).`);
  return true;
}

// ============================================================================ drag-to-modulate
/** Start dragging a modulation source (macro or modulator) from its handle; drop it on any knob of the track. */
export function beginModDrag(app, trackId, src, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const p = app.store.get();
  const t = getTrack(app, trackId);
  if (!t) return;
  const ghost = h('div.mod-drag-ghost', icon('plug', 12), h('span', sourceLabel(t, src)));
  document.body.appendChild(ghost);
  document.body.classList.add('mod-dragging');
  const ok = [];
  for (const el of document.querySelectorAll('[data-auto-owner][data-auto-target]')) {
    if (el.dataset.autoOwner !== trackId) continue;
    if (!modTargetInfo(p, t, el.dataset.autoTarget)) continue;
    el.classList.add('mod-drop-ok');
    ok.push(el);
  }
  let hover = null;
  const place = (x, y) => { ghost.style.left = `${x + 12}px`; ghost.style.top = `${y + 8}px`; };
  place(e.clientX, e.clientY);
  const cancel = (ev) => { if (ev.key === 'Escape') { hover?.classList.remove('mod-drop-hover'); hover = null; } };
  window.addEventListener('keydown', cancel);
  // dragging near the edge of a horizontally scrolling device chain scrolls it
  const scroller = e.target.closest?.('.device-chain') || document.querySelector('.device-chain');
  startDrag(e, (_dx, _dy, ev) => {
    place(ev.clientX, ev.clientY);
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
        if (ev.clientX > r.right - 48) scroller.scrollLeft += 24;
        else if (ev.clientX < r.left + 48) scroller.scrollLeft -= 24;
      }
    }
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.mod-drop-ok') || null;
    if (under !== hover) { hover?.classList.remove('mod-drop-hover'); hover = under; hover?.classList.add('mod-drop-hover'); }
  }, () => {
    window.removeEventListener('keydown', cancel);
    ghost.remove();
    document.body.classList.remove('mod-dragging');
    for (const el of ok) el.classList.remove('mod-drop-ok', 'mod-drop-hover');
    if (hover) addRoute(app, trackId, src, hover.dataset.autoTarget);
    else if (!ok.length) app.setStatus?.('Nothing to modulate here — open the track’s devices and drop the handle on a knob.');
  });
}

const handle = (app, trackId, src, title) => {
  const el = h('span.mod-handle', { title: title || 'Drag onto a knob to modulate it' }, icon('plug', 11));
  el.addEventListener('pointerdown', (e) => beginModDrag(app, trackId, src, e));
  return el;
};

// ============================================================================ macro row (device panel header)
export function macroRow(app, tgt) {
  const trackId = tgt.id;
  const items = [];
  const row = h('div.dv-macro-row', h('span.dv-macro-title', { title: 'Macros: 8 knobs per track. Drag a macro’s handle onto any knob to map it; right-click a macro knob to automate or MIDI-learn it; double-click a name to rename.' }, 'Macros'));
  const t0 = getTrack(app, trackId);
  for (let i = 0; i < MACRO_COUNT; i++) {
    const def = { key: `macro${i}`, label: `Macro ${i + 1}`, type: 'number', min: 0, max: 1, default: 0, step: 0.001 };
    const k = knob({ def, value: t0?.mod?.macros?.[i]?.value ?? 0, size: 26, label: t0?.mod?.macros?.[i]?.name || def.label,
      onChange: (v) => editMod(app, trackId, `Macro ${i + 1}`, (m) => { m.macros[i].value = v; }, { coalesce: true }) });
    markAuto(k, trackId, `macro:${i}`);
    const lbl = k.querySelector('.knob-label');
    lbl?.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const cur = getTrack(app, trackId)?.mod?.macros?.[i]?.name || def.label;
      const n = await promptText('Rename macro', cur);
      if (n) editMod(app, trackId, 'Rename macro', (m) => { m.macros[i].name = n.slice(0, 40); });
    });
    const badge = h('span.mod-badge');
    const wrap = h('div.mod-macro', handle(app, trackId, `macro:${i}`, 'Drag onto a knob to map this macro (any number of targets)'), k, badge);
    row.appendChild(wrap);
    items.push({ k, lbl, badge, i });
  }
  return {
    el: row,
    update() {
      const t = getTrack(app, trackId);
      for (const it of items) {
        const m = t?.mod?.macros?.[it.i];
        if (!it.k.classList.contains('active')) it.k.setValue(m?.value ?? 0);
        const name = m?.name || `Macro ${it.i + 1}`;
        if (it.lbl && it.lbl.textContent !== name) it.lbl.textContent = name;
        const n = (t?.mod?.routes || []).filter((r) => r.src === `macro:${it.i}`).length;
        it.badge.textContent = n ? String(n) : '';
        it.badge.title = n ? `${n} mapping${n === 1 ? '' : 's'}` : '';
      }
    },
  };
}

// ============================================================================ modulation card
const selected = new Map(); // trackId -> modulator id | 'matrix'

/**
 * The "Modulation" card of a track (device chain). shell = cardShell result from the device panel.
 * Returns { el, update(ctx) }.
 */
export function modulationCard(app, tgt, shell) {
  const trackId = tgt.id;
  const body = shell.body;
  let sig = '';
  let updaters = [];
  let raf = 0;

  const structure = (t) => JSON.stringify([
    (t?.mod?.mods || []).map((m) => [m.id, m.type, m.name, m.shape, m.sync, m.retrig, m.type === 'step' ? m.steps.length : 0, m.source]),
    (t?.mod?.routes || []).map((r) => [r.id, r.src, r.target, r.bipolar, r.enabled !== false]),
    (t?.mod?.macros || []).map((m) => m.name),
    (t?.fx || []).map((f) => f.id), selected.get(trackId) || '',
  ]);

  function addModulator(type) {
    const t = getTrack(app, trackId);
    const n = (t?.mod?.mods || []).filter((m) => m.type === type).length + 1;
    const m = createModulator(type, { name: `${MOD_TYPE_LABELS[type]} ${n}` });
    selected.set(trackId, m.id);
    editMod(app, trackId, `Add ${MOD_TYPE_LABELS[type]}`, (mm) => { mm.mods.push(m); });
  }
  const addMenu = (e) => contextMenu(e, [{ header: 'Add modulator' }, ...MOD_TYPES.map((ty) => ({ label: MOD_TYPE_LABELS[ty], icon: TYPE_ICONS[ty], onClick: () => addModulator(ty) }))]);

  function build() {
    clear(body);
    updaters = [];
    const t = getTrack(app, trackId);
    const mods = t?.mod?.mods || [];
    let sel = selected.get(trackId);
    if (sel !== 'matrix' && !mods.some((m) => m.id === sel)) sel = mods[0]?.id || (t?.mod?.routes?.length ? 'matrix' : null);
    selected.set(trackId, sel);
    // tabs
    const tabs = h('div.mod-tabs');
    for (const m of mods) {
      const meter = h('span.mod-tab-meter');
      const tab = h(`button.mod-tab${m.id === sel ? '.on' : ''}`, { type: 'button', title: `${m.name} — click to edit, drag the plug onto a knob to modulate it` },
        handle(app, trackId, m.id), icon(TYPE_ICONS[m.type] || 'wave', 11), h('span', m.name), meter);
      tab.addEventListener('click', (e) => { if (e.target.closest('.mod-handle')) return; selected.set(trackId, m.id); sig = ''; render(); });
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e, modMenu(m)); });
      updaters.push({ live: (v) => { meter.style.setProperty('--v', String(v?.mods?.[m.id] ?? 0)); } });
      tabs.appendChild(tab);
    }
    const mtab = h(`button.mod-tab.mod-tab-matrix${sel === 'matrix' ? '.on' : ''}`, { type: 'button', title: 'Mod matrix: every source → target with amount, polarity and curve' }, icon('grid', 11), h('span', 'Matrix'));
    mtab.addEventListener('click', () => { selected.set(trackId, 'matrix'); sig = ''; render(); });
    tabs.append(mtab, iconButton('plus', addMenu, 'Add a modulator (LFO, envelope, step sequencer, random, envelope follower)', 'mod-add'));
    body.appendChild(tabs);
    const pane = h('div.mod-pane');
    body.appendChild(pane);
    if (sel === 'matrix') matrixView(pane, t);
    else if (mods.length) modEditor(pane, mods.find((m) => m.id === sel));
    else {
      pane.appendChild(h('div.mod-empty',
        h('p', 'Add a modulator, then drag its plug handle onto any knob — instrument, effect or the macro knobs above. Macros map the same way.'),
        h('div.mod-empty-btns', ...MOD_TYPES.map((ty) => button(MOD_TYPE_LABELS[ty], () => addModulator(ty), { icon: TYPE_ICONS[ty], cls: 'small' })))));
    }
  }

  function modMenu(m) {
    return [
      { header: m.name },
      { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptText('Rename modulator', m.name); if (n) editMod(app, trackId, 'Rename modulator', (mm) => { const x = mm.mods.find((y) => y.id === m.id); if (x) x.name = n.slice(0, 40); }); } },
      { label: 'Duplicate', icon: 'copy', onClick: () => { const c = { ...JSON.parse(JSON.stringify(m)), id: createModulator(m.type).id, name: `${m.name} copy` }; selected.set(trackId, c.id); editMod(app, trackId, 'Duplicate modulator', (mm) => { mm.mods.push(c); }); } },
      { label: 'Delete (and its routes)', icon: 'trash', onClick: () => editMod(app, trackId, 'Delete modulator', (mm) => { mm.mods = mm.mods.filter((x) => x.id !== m.id); mm.routes = mm.routes.filter((r) => r.src !== m.id); }) },
    ];
  }

  // ---- editors -------------------------------------------------------------------------------------------
  const setMod = (id, label, fn, coalesce = true) => editMod(app, trackId, label, (mm) => { const x = mm.mods.find((y) => y.id === id); if (x) fn(x); }, coalesce ? { coalesce: true } : undefined);
  const modKnob = (m, d, key = d.key) => {
    const k = knob({ def: d, value: m[key] ?? d.default, size: 30, onChange: (v) => setMod(m.id, `${m.name}: ${d.label}`, (x) => { x[key] = v; }) });
    updaters.push({ mod: (mm) => { if (!k.classList.contains('active')) k.setValue(mm[key] ?? d.default); } });
    return k;
  };
  const modSelect = (m, key, options, label) => h('label.mod-field', h('span', label), select({ options, value: m[key], onChange: (v) => setMod(m.id, `${m.name}: ${label}`, (x) => { x[key] = v; }, false) }));
  const modToggle = (m, key, label, title) => toggle({ label, value: !!m[key], title, onChange: (v) => setMod(m.id, `${m.name}: ${label}`, (x) => { x[key] = v; }, false) });
  const divOptions = MOD_DIVISIONS.map((d) => ({ value: d, label: d }));

  function modEditor(pane, m) {
    if (!m) return;
    const head = h('div.mod-ed-head', handle(app, trackId, m.id, 'Drag onto a knob to modulate it'), h('b', m.name), h('span.muted', MOD_TYPE_LABELS[m.type]),
      h('div.spacer'), iconButton('more', (e) => contextMenu(e, modMenu(m)), 'Rename, duplicate, delete'));
    head.querySelector('b').addEventListener('dblclick', () => modMenu(m)[1].onClick());
    pane.appendChild(head);
    const ctl = h('div.mod-ed-controls');
    const viz = h('div.mod-ed-viz');
    pane.append(h('div.mod-ed-body', viz, ctl));
    if (m.type === 'lfo') {
      ctl.append(modSelect(m, 'shape', LFO_SHAPES.map((s) => ({ value: s, label: SHAPE_LABELS[s] })), 'Shape'),
        h('div.mod-row', modToggle(m, 'sync', 'Sync', 'Tempo sync (follows the song position while playing)'), modSelect(m, 'retrig', [{ value: 'free', label: 'Free / song' }, { value: 'note', label: 'Note retrigger' }], 'Retrigger')),
        m.sync ? modSelect(m, 'div', divOptions, 'Division') : null,
        h('div.mod-knobs', m.sync ? null : modKnob(m, D.rate), modKnob(m, D.phase)));
      if (m.shape === 'mseg') msegEditor(viz, m); else shapePreview(viz, m);
    } else if (m.type === 'env') {
      ctl.append(h('div.mod-knobs', modKnob(m, D.a), modKnob(m, D.d), modKnob(m, D.s), modKnob(m, D.r)), h('p.mod-hint', 'Triggered by this track’s notes (sequenced and live).'));
      shapePreview(viz, m);
    } else if (m.type === 'step') {
      const counts = [4, 8, 12, 16, 24, 32].map((n) => ({ value: n, label: `${n} steps` }));
      ctl.append(h('label.mod-field', h('span', 'Steps'), select({ options: counts, value: m.steps.length, onChange: (n) => setMod(m.id, `${m.name}: steps`, (x) => { const s = x.steps.slice(0, n); while (s.length < n) s.push(x.steps[s.length % x.steps.length] ?? 0); x.steps = s; }, false) })),
        modSelect(m, 'div', divOptions, 'Step length'), modSelect(m, 'retrig', [{ value: 'free', label: 'Song position' }, { value: 'note', label: 'Note retrigger' }], 'Retrigger'),
        h('div.mod-knobs', modKnob(m, D.glide)));
      stepEditor(viz, m);
    } else if (m.type === 'random') {
      ctl.append(h('div.mod-row', modToggle(m, 'sync', 'Sync', 'Tempo sync'), button('New seed', () => setMod(m.id, `${m.name}: seed`, (x) => { x.seed = (Math.random() * 1e9) >>> 0; }, false), { icon: 'dice', cls: 'small' })),
        m.sync ? modSelect(m, 'div', divOptions, 'Rate') : null, h('div.mod-knobs', m.sync ? null : modKnob(m, D.rate), modKnob(m, D.smooth)));
      shapePreview(viz, m);
    } else if (m.type === 'follow') {
      ctl.append(h('label.mod-field', h('span', 'Source'), trackSelect({ value: m.source, noneLabel: '— this track —', onChange: (v) => setMod(m.id, `${m.name}: source`, (x) => { x.source = v; }, false) })),
        h('div.mod-knobs', modKnob(m, D.attack), modKnob(m, D.release), modKnob(m, D.gain)), h('p.mod-hint', 'Follows the audio level after the source track’s effects (sidechain-style).'));
      shapePreview(viz, m);
    }
    pane.appendChild(routeList(m));
  }

  // value of a modulator over one cycle for previews (0..1)
  const previewFn = (m) => {
    if (m.type === 'lfo') return (x) => lfoShapeValue(m.shape, x + (m.phase || 0), m.mseg);
    if (m.type === 'step') return (x) => stepValue(m.steps, x, m.glide || 0);
    if (m.type === 'random') return (x) => randomValue(m.seed >>> 0, x * 8, m.smooth || 0);
    if (m.type === 'env') {
      const a = m.a || 0.001, d = m.d || 0.001, r = m.r || 0.001, hold = Math.max(0.2, (a + d) * 0.6), T = a + d + hold + r;
      return (x) => {
        const t = x * T;
        if (t < a) return t / a;
        if (t < a + d + hold) return m.s + (1 - m.s) * Math.exp(-(t - a) / (d / 4));
        const v0 = m.s + (1 - m.s) * Math.exp(-(d + hold) / (d / 4));
        return v0 * Math.exp(-(t - a - d - hold) / (r / 6));
      };
    }
    return () => 0;
  };

  function drawCurve(canvas, fn, opts = {}) {
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    const cs = getComputedStyle(canvas);
    const col = cs.getPropertyValue('--accent').trim() || '#7c5cff';
    ctx.strokeStyle = cs.getPropertyValue('--line').trim() || '#333';
    ctx.lineWidth = 1;
    const grid = opts.grid || 4;
    for (let i = 1; i < grid; i++) { const x = (i / grid) * w; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(w, H / 2); ctx.stroke();
    ctx.beginPath();
    const pad = 4;
    for (let i = 0; i <= w; i++) {
      const y = pad + (1 - fn(i / w)) * (H - 2 * pad);
      if (i) ctx.lineTo(i, y); else ctx.moveTo(i, y);
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.lineTo(w, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    return { ctx, w, H, pad };
  }

  function liveLine(canvas, v) {
    const { ctx, w, h: H } = fitCanvas(canvas);
    const y = 4 + (1 - v) * (H - 8);
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--accent-2').trim() || '#3bc9db';
    ctx.beginPath(); ctx.arc(w - 5, y, 3.5, 0, Math.PI * 2); ctx.fill();
  }

  function shapePreview(viz, m) {
    const c = h('canvas.mod-canvas');
    viz.appendChild(c);
    let cur = m;
    const draw = (v) => { if (!c.isConnected) return; drawCurve(c, previewFn(cur)); if (v != null) liveLine(c, v); };
    requestAnimationFrame(() => draw());
    updaters.push({ mod: (mm) => { cur = mm; }, live: (v) => draw(v?.mods?.[m.id]) });
  }

  // ---- MSEG editor: click to add, drag points, double-click / right-click to delete, Alt-drag a segment to bend it
  function msegEditor(viz, m) {
    const c = h('canvas.mod-canvas.mod-mseg', { title: 'Click to add a point · drag to move · double-click or right-click to delete · Alt-drag a segment to bend it' });
    const snapSel = select({ options: [0, 4, 8, 16, 32].map((n) => ({ value: n, label: n ? `Snap 1/${n}` : 'No snap' })), value: m.mseg?.snap ?? 8,
      onChange: (n) => setMod(m.id, `${m.name}: snap`, (x) => { x.mseg = { ...x.mseg, snap: n }; }, false) });
    const presets = h('div.mod-mseg-presets', ...[
      ['Ramp', [{ x: 0, y: 0, c: 0 }, { x: 1, y: 1, c: 0 }]],
      ['Pluck', [{ x: 0, y: 1, c: 0 }, { x: 1, y: 0, c: 0.7 }]],
      ['Gate', [{ x: 0, y: 1, c: 0 }, { x: 0.5, y: 1, c: 0 }, { x: 0.5, y: 0, c: 0 }, { x: 1, y: 0, c: 0 }]],
      ['Swell', [{ x: 0, y: 0, c: 0 }, { x: 0.75, y: 1, c: -0.6 }, { x: 1, y: 0, c: 0.6 }]],
      ['Wobble', [{ x: 0, y: 0, c: 0 }, { x: 0.25, y: 1, c: 0.6 }, { x: 0.5, y: 0.2, c: -0.5 }, { x: 0.75, y: 0.9, c: 0.5 }, { x: 1, y: 0, c: -0.5 }]],
    ].map(([n, pts]) => button(n, () => setMod(m.id, `${m.name}: shape`, (x) => { x.mseg = { ...x.mseg, points: pts.map((p) => ({ ...p })) }; }, false), { cls: 'small' })));
    viz.append(c, h('div.mod-row', snapSel, presets));
    let pts = (m.mseg?.points || []).map((p) => ({ ...p }));
    let snap = m.mseg?.snap ?? 8;
    let drag = null;
    let live = null;
    const geom = () => { const r = c.getBoundingClientRect(); return { r, pad: 4 }; };
    const toPx = (p, g) => [p.x * g.r.width, g.pad + (1 - p.y) * (g.r.height - 2 * g.pad)];
    const fromEv = (e, g) => ({ x: Math.max(0, Math.min(1, (e.clientX - g.r.left) / g.r.width)), y: Math.max(0, Math.min(1, 1 - (e.clientY - g.r.top - g.pad) / (g.r.height - 2 * g.pad))) });
    const draw = () => {
      if (!c.isConnected) return;
      const { ctx, w, H, pad } = drawCurve(c, (x) => msegValue(pts, x), { grid: snap || 4 });
      ctx.fillStyle = getComputedStyle(c).getPropertyValue('--text').trim() || '#eee';
      for (const p of pts) { ctx.beginPath(); ctx.arc(p.x * w, pad + (1 - p.y) * (H - 2 * pad), 3.5, 0, Math.PI * 2); ctx.fill(); }
      if (live != null) liveLine(c, live);
    };
    const commit = (coalesce = true) => setMod(m.id, `${m.name}: draw`, (x) => { x.mseg = { ...(x.mseg || {}), points: sanitizeMseg(pts), snap }; }, coalesce);
    const hit = (e) => {
      const g = geom();
      let best = -1, bd = 9;
      pts.forEach((p, i) => { const [px, py] = toPx(p, g); const d = Math.hypot(px - (e.clientX - g.r.left), py - (e.clientY - g.r.top)); if (d < bd) { bd = d; best = i; } });
      return best;
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const g = geom();
      let i = hit(e);
      if (e.altKey && i < 0) {
        // bend the segment under the pointer
        const x = fromEv(e, g).x;
        const k = pts.findIndex((p) => p.x >= x);
        if (k <= 0) return;
        const c0 = pts[k].c || 0;
        const up = pts[k].y >= pts[k - 1].y ? 1 : -1;
        startDrag(e, (_dx, dy) => { pts[k].c = Math.max(-1, Math.min(1, c0 - (dy / 80) * up)); draw(); commit(); }, () => commit());
        return;
      }
      if (i < 0) {
        const p = snapPoint(fromEv(e, g), snap);
        if (p.x <= 0 || p.x >= 1) return;
        pts.push({ ...p, c: 0 });
        pts.sort((a, b) => a.x - b.x);
        i = pts.findIndex((q) => q.x === p.x && q.y === p.y);
      }
      drag = i;
      startDrag(e, (_dx, _dy, ev) => {
        const p = snapPoint(fromEv(ev, geom()), snap);
        const k = drag;
        const first = k === 0, last = k === pts.length - 1;
        const lo = first ? 0 : pts[k - 1].x, hi = last ? 1 : pts[k + 1].x;
        pts[k] = { ...pts[k], x: first ? 0 : last ? 1 : Math.max(lo, Math.min(hi, p.x)), y: p.y };
        draw(); commit();
      }, () => { drag = null; commit(); });
      draw();
    });
    const del = (e) => {
      const i = hit(e);
      if (i > 0 && i < pts.length - 1) { e.preventDefault(); pts.splice(i, 1); draw(); commit(false); }
    };
    c.addEventListener('dblclick', del);
    c.addEventListener('contextmenu', del);
    requestAnimationFrame(draw);
    updaters.push({
      mod: (mm) => { if (drag == null) { pts = (mm.mseg?.points || []).map((p) => ({ ...p })); snap = mm.mseg?.snap ?? 8; snapSel.setValue(snap); } },
      live: (v) => { live = v?.mods?.[m.id] ?? null; draw(); },
    });
  }

  // ---- step editor: drag over the bars to draw
  function stepEditor(viz, m) {
    const c = h('canvas.mod-canvas.mod-steps', { title: 'Drag over the steps to draw (Shift: fine, no snap)' });
    viz.appendChild(c);
    let steps = m.steps.slice();
    let live = null;
    let dragging = false;
    const draw = () => {
      if (!c.isConnected) return;
      const { ctx, w, h: H } = fitCanvas(c);
      ctx.clearRect(0, 0, w, H);
      const cs = getComputedStyle(c);
      const n = steps.length, bw = w / n;
      for (let i = 0; i < n; i++) {
        const v = steps[i];
        ctx.fillStyle = i % 4 === 0 ? (cs.getPropertyValue('--bg-4').trim() || '#333') : (cs.getPropertyValue('--bg-3').trim() || '#2a2a2a');
        ctx.fillRect(i * bw + 1, 0, bw - 2, H);
        ctx.fillStyle = cs.getPropertyValue('--accent').trim() || '#7c5cff';
        ctx.fillRect(i * bw + 2, H - v * (H - 2), bw - 4, v * (H - 2));
      }
      if (live != null) liveLine(c, live);
    };
    const setAt = (e) => {
      const r = c.getBoundingClientRect();
      const i = Math.max(0, Math.min(steps.length - 1, Math.floor(((e.clientX - r.left) / r.width) * steps.length)));
      let v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      if (!e.shiftKey) v = Math.round(v * 16) / 16;
      steps[i] = v;
      draw();
      setMod(m.id, `${m.name}: steps`, (x) => { x.steps = steps.slice(); });
    };
    c.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); dragging = true; setAt(e); startDrag(e, (_dx, _dy, ev) => setAt(ev), () => { dragging = false; }); });
    requestAnimationFrame(draw);
    updaters.push({ mod: (mm) => { if (!dragging) steps = mm.steps.slice(); }, live: (v) => { live = v?.mods?.[m.id] ?? null; draw(); } });
  }

  // ---- routes of one source
  function routeList(m) {
    const t = getTrack(app, trackId);
    const p = app.store.get();
    const list = (t?.mod?.routes || []).filter((r) => r.src === m.id);
    const wrap = h('div.mod-routes');
    if (!list.length) { wrap.appendChild(h('p.mod-hint', 'No targets yet — drag the plug handle onto a knob.')); return wrap; }
    for (const r of list) wrap.appendChild(routeRow(r, p, t, false));
    return wrap;
  }

  const setRoute = (id, label, fn, coalesce = true) => editMod(app, trackId, label, (mm) => { const r = mm.routes.find((x) => x.id === id); if (r) fn(r); }, coalesce ? { coalesce: true } : undefined);
  function routeRow(r, p, t, full) {
    const info = modTargetInfo(p, t, r.target);
    const amt = knob({ def: D.amount, value: r.amount, size: 24, label: false, onChange: (v) => setRoute(r.id, 'Modulation amount', (x) => { x.amount = v; }) });
    const cur = knob({ def: D.curve, value: r.curve || 0, size: 24, label: false, onChange: (v) => setRoute(r.id, 'Modulation curve', (x) => { x.curve = v; }) });
    updaters.push({ route: (rr) => { if (rr.id !== r.id) return; if (!amt.classList.contains('active')) amt.setValue(rr.amount); if (!cur.classList.contains('active')) cur.setValue(rr.curve || 0); } });
    const macro = isMacroSrc(r.src);
    let minK = null;
    if (macro) {
      minK = knob({ def: D.min, value: r.min ?? 0, size: 24, label: false, onChange: (v) => setRoute(r.id, 'Macro range', (x) => { x.min = v; }) });
      updaters.push({ route: (rr) => { if (rr.id === r.id && !minK.classList.contains('active')) minK.setValue(rr.min ?? 0); } });
    }
    const bip = macro ? null : toggle({ label: '±', value: !!r.bipolar, title: 'Bipolar: the source swings the target both ways around its value', onChange: (v) => setRoute(r.id, 'Modulation polarity', (x) => { x.bipolar = v; }, false) });
    const del = iconButton('x', () => editMod(app, trackId, 'Remove modulation', (mm) => { mm.routes = mm.routes.filter((x) => x.id !== r.id); }), 'Remove this route');
    const tlabel = h(`span.mod-route-target${info ? '' : '.missing'}`, { title: r.target }, info ? info.label : `${r.target} (missing)`);
    const cells = full
      ? [srcSelect(r, t), targetSelect(r, p, t), h('span.mod-k', macro ? minK : h('span.muted', '—')), h('span.mod-k', amt), h('span.mod-k', bip || h('span.muted', '—')), h('span.mod-k', cur),
        toggle({ label: 'On', value: r.enabled !== false, title: 'Enable / disable this route', onChange: (v) => setRoute(r.id, 'Toggle modulation', (x) => { if (v) delete x.enabled; else x.enabled = false; }, false) }), del]
      : [tlabel, macro ? h('span.mod-k', { title: 'Range start (macro at 0)' }, minK) : null, h('span.mod-k', { title: macro ? 'Range end (macro at 1)' : 'Amount' }, amt), bip, h('span.mod-k', { title: 'Curve' }, cur), del];
    return h(`div.mod-route${full ? '.full' : ''}`, cells);
  }

  function srcSelect(r, t) {
    const opts = [
      ...(t?.mod?.mods || []).map((m) => ({ value: m.id, label: m.name, group: 'Modulators' })),
      ...Array.from({ length: MACRO_COUNT }, (_, i) => ({ value: `macro:${i}`, label: t?.mod?.macros?.[i]?.name || `Macro ${i + 1}`, group: 'Macros' })),
    ];
    return select({ options: opts, value: r.src, cls: 'mod-src', onChange: (v) => setRoute(r.id, 'Modulation source', (x) => { x.src = v; if (isMacroSrc(v)) { x.min ??= 0; } else delete x.min; }, false) });
  }
  function targetSelect(r, p, t) {
    const opts = modTargets(p, t).map((o) => ({ value: o.target, label: o.label, group: o.group }));
    if (!opts.some((o) => o.value === r.target)) opts.unshift({ value: r.target, label: `${r.target} (missing)` });
    return select({ options: opts, value: r.target, cls: 'mod-dst', onChange: (v) => setRoute(r.id, 'Modulation target', (x) => { x.target = v; }, false) });
  }

  function matrixView(pane, t) {
    const p = app.store.get();
    const routes = t?.mod?.routes || [];
    const headRow = h('div.mod-route.full.mod-matrix-head', h('span', 'Source'), h('span', 'Target'), h('span', 'From'), h('span', 'Amount'), h('span', 'Bipolar'), h('span', 'Curve'), h('span', ''), h('span', ''));
    const grid = h('div.mod-matrix', headRow, ...routes.map((r) => routeRow(r, p, t, true)));
    const add = button('Add route', () => {
      const src = t?.mod?.mods?.[0]?.id || 'macro:0';
      const first = modTargets(p, t).find((o) => o.target.startsWith('inst:')) || modTargets(p, t)[0];
      if (first) editMod(app, trackId, 'Add modulation', (mm) => { mm.routes.push(createRoute(src, first.target, { amount: 0.25 })); });
    }, { icon: 'plus', cls: 'small' });
    pane.append(grid, h('div.mod-row', add, h('span.mod-hint', routes.length ? 'Offsets add up in each knob’s own scale (log for frequencies); automation sets the base value.' : 'No routes yet. Drag a modulator or macro handle onto a knob, or add one here.')));
  }

  function render() {
    const t = getTrack(app, trackId);
    const s = structure(t);
    if (s !== sig) { sig = s; build(); }
    const mods = new Map((t?.mod?.mods || []).map((m) => [m.id, m]));
    const sel = mods.get(selected.get(trackId));
    for (const u of updaters) {
      if (u.mod && sel) u.mod(sel);
      if (u.route) for (const r of t?.mod?.routes || []) u.route(r);
    }
  }

  const loop = () => {
    raf = 0;
    if (!shell.el.isConnected) return;
    const v = app.engine?.getModView?.(trackId) || null;
    for (const u of updaters) u.live?.(v);
    raf = requestAnimationFrame(() => setTimeout(loop, 40));
  };

  render();
  loop();
  return { el: shell.el, update() { render(); if (!raf) loop(); } };
}

// ============================================================================ knob rings
/**
 * Draw modulation rings on modulated knobs inside `root` (the device panel): the reachable range (base + route
 * extents) as an outer arc and the live value as a dot (engine.getModView), ~25 fps while anything is modulated.
 */
export function installModRings(app, root) {
  const A0 = -135, A1 = 135;
  const polar = (a, r) => [20 + r * Math.sin((a * Math.PI) / 180), 20 - r * Math.cos((a * Math.PI) / 180)];
  const arc = (n0, n1, r) => {
    const a = A0 + (A1 - A0) * n0, b = A0 + (A1 - A0) * n1;
    if (Math.abs(b - a) < 0.5) return '';
    const [x0, y0] = polar(a, r), [x1, y1] = polar(b, r);
    return `M${x0} ${y0} A${r} ${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ns = 'http://www.w3.org/2000/svg';
  const marked = new Set();
  const tick = () => {
    if (!root.isConnected) { setTimeout(tick, 500); return; }
    const p = app.store.get();
    const anyRoutes = p.tracks.some((t) => t.mod?.routes?.length);
    const seen = new Set();
    if (anyRoutes) {
      const byOwner = new Map();
      for (const k of root.querySelectorAll('.knob[data-auto-owner][data-auto-target]')) {
        const owner = k.dataset.autoOwner;
        if (!byOwner.has(owner)) {
          const t = p.tracks.find((x) => x.id === owner);
          byOwner.set(owner, t ? { routes: routesByTarget(t), view: app.engine?.getModView?.(owner) || null } : null);
        }
        const o = byOwner.get(owner);
        const list = o?.routes.get(k.dataset.autoTarget);
        if (!list?.length || !k.def) continue;
        seen.add(k);
        const svg = k.querySelector('svg');
        let ring = k._modRing;
        if (!ring) {
          ring = { arc: document.createElementNS(ns, 'path'), dot: document.createElementNS(ns, 'circle') };
          ring.arc.setAttribute('class', 'knob-mod');
          ring.dot.setAttribute('class', 'knob-mod-dot');
          ring.dot.setAttribute('r', '2.6');
          svg.append(ring.arc, ring.dot);
          k._modRing = ring;
          k.classList.add('mod-on');
        }
        const live = o.view?.targets?.[k.dataset.autoTarget];
        let lo, hi, val = null;
        if (live) { lo = live.lo; hi = live.hi; val = live.norm; } else {
          const base = toNorm(k.def, k.getValue?.() ?? k.def.default);
          const [a, b] = targetExtent(list);
          lo = Math.max(0, Math.min(1, base + a)); hi = Math.max(0, Math.min(1, base + b));
        }
        ring.arc.setAttribute('d', arc(Math.min(lo, hi), Math.max(lo, hi), 19));
        if (val == null) ring.dot.setAttribute('visibility', 'hidden');
        else {
          const [x, y] = polar(A0 + (A1 - A0) * val, 19);
          ring.dot.setAttribute('visibility', 'visible');
          ring.dot.setAttribute('cx', x); ring.dot.setAttribute('cy', y);
        }
        const names = list.map((r) => sourceLabel(p.tracks.find((x) => x.id === owner), r.src)).join(', ');
        if (k._modTitle !== names) { k._modTitle = names; k.title = `${k.dataset.baseTitle ?? (k.dataset.baseTitle = k.title || '')}\nModulated by: ${names}`.trim(); }
      }
    }
    for (const k of marked) {
      if (seen.has(k)) continue;
      k._modRing?.arc.remove(); k._modRing?.dot.remove();
      k._modRing = null; k.classList.remove('mod-on');
      if (k.dataset.baseTitle != null) { k.title = k.dataset.baseTitle; k._modTitle = null; }
    }
    marked.clear();
    for (const k of seen) marked.add(k);
    setTimeout(() => requestAnimationFrame(tick), anyRoutes ? 40 : 300);
  };
  tick();
}
