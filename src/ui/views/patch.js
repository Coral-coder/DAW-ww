// Plugboard view (7): a modular patch bay for a channel's insert effects, plus a read-only
// "whole project routing" overview (tracks → buses → master, sends and sidechain keys).
//
// The patch lives in track.patch (see src/core/patch.js); effect params stay in track.fx so the
// device panel and automation keep working. Device boxes are DOM (so they can host knobs),
// cables are drawn in an SVG layer on top (pointer events only on the strokes).
import { h, icon, clear, startDrag } from '../dom.js';
import { knob, button, iconButton, contextMenu, trackSelect } from '../components.js';
import { isTyping } from '../keyboard.js';
import { createEffect } from '../../core/model.js';
import { clamp } from '../../core/util.js';
import { EFFECT_DEFS, EFFECT_CATEGORIES, resolveEffectParams } from '../../audio/index.js';
import {
  PATCH_IN, PATCH_OUT, NODE_W, NODE_H, isPatchActive, setPatchEnabled, validateCable, connect, removeNode,
  createPatchNode, createCable, insertBeforeOut, nextNodePosition, autoLayout, applyTemplate, PATCH_TEMPLATES,
  findDrumTrack, patchFxOrder, resolveKeyLinks, canKey, MAX_CABLE_GAIN, patchMatchesFx,
} from '../../core/patch.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};

const CABLE_COLORS = ['#ff4d5e', '#ffc93c', '#2fd17a', '#3ea6ff', '#ff8a3d', '#b38cff', '#ff6fb5', '#3fe0d0'];
const TERM_W = 64, TERM_H = 70, TERM_Y = 150;
const J_W = 96, J_H = 54; // split/mix junction size
const PORT_Y = 36, KEY_Y = 88; // fx node port offsets
const GAIN_DEF = { key: 'gain', label: 'Level', type: 'number', min: 0, max: MAX_CABLE_GAIN, step: 0.01, default: 1, curve: 'lin', description: 'Cable level (1 = unity, 2 = +6 dB). Double-click resets.' };
const fmtGain = (g) => (g <= 0.0001 ? '−∞ dB' : `${(20 * Math.log10(g)) >= 0 ? '+' : '−'}${Math.abs(20 * Math.log10(g)).toFixed(1)} dB`);

function hashColor(id) {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) >>> 0;
  return CABLE_COLORS[x % CABLE_COLORS.length];
}

/** Sagging (gravity) bezier between two points, Reason-style. */
function cablePath(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  const sag = Math.min(140, 8 + dist * 0.3);
  const pull = Math.max(30, Math.abs(dx) * 0.35);
  return `M${x1} ${y1} C${x1 + pull} ${y1 + sag} ${x2 - pull} ${y2 + sag} ${x2} ${y2}`;
}
/** Point on the cubic bezier at t (for gain labels / overlays). */
function cablePoint(x1, y1, x2, y2, t = 0.5) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  const sag = Math.min(140, 8 + dist * 0.3);
  const pull = Math.max(30, Math.abs(dx) * 0.35);
  const p = [[x1, y1], [x1 + pull, y1 + sag], [x2 - pull, y2 + sag], [x2, y2]];
  const u = 1 - t;
  const c = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: c.reduce((s, k, i) => s + k * p[i][0], 0), y: c.reduce((s, k, i) => s + k * p[i][1], 0) };
}

export function createPatchView(app) {
  const { store, ui, actions } = app;
  let visible = false;
  let mode = 'patch'; // 'patch' | 'overview'
  let sel = null; // { type: 'cable' | 'node', id }
  let hoverCable = null;
  let lastStageSig = '';
  let nodeEls = new Map(); // nodeId -> { el, knobs: Map(key -> knobEl), power, select }
  let dragCable = null; // { from:{node}, to?:{node,port}, x, y, lifted?: cableId, reverse?: bool }
  let paletteOpen = true;
  let paletteQuery = '';
  let zoom = 1; // CSS zoom of the board (canvas units = unzoomed px)

  // ---------------------------------------------------------------- skeleton
  const modeSeg = h('div.pb-seg');
  const enableBtn = h('button.toggle.pb-enable', { type: 'button' });
  const addBtn = button('Device', (e) => showAddMenu(e), { icon: 'plus', cls: 'small', title: 'Add an effect, split or mix junction to this board' });
  const tplBtn = button('Templates ▾', (e) => showTemplates(e), { icon: 'layers', cls: 'small', title: 'Ready-made routings: parallel compression, parallel distortion, band split, dry/wet reverb, sidechain' });
  const scBtn = button('Sidechain to Drums', () => sidechainToDrums(), { icon: 'drum', cls: 'small', title: 'Add a Ducker keyed by the drum track: this channel dips on every kick' });
  const tidyBtn = iconButton('grid', () => tidy(), 'Tidy layout — arrange the devices left to right by signal flow');
  const zoomOutBtn = iconButton('zoomOut', () => setZoom(zoom / 1.2), 'Zoom out (Ctrl+wheel)');
  const zoomInBtn = iconButton('zoomIn', () => setZoom(zoom * 1.2), 'Zoom in (Ctrl+wheel)');
  const fitBtn = h('button.btn.small.pb-fit', { type: 'button', title: 'Fit the whole patch in view (click again for 100%)' }, '100%');
  fitBtn.addEventListener('click', () => { const g = geometry(true); const f = clamp(Math.min(stage.clientWidth / g.W, stage.clientHeight / g.H), 0.4, 1); setZoom(Math.abs(zoom - f) < 0.01 ? 1 : f); });
  const palBtn = iconButton('search', () => { paletteOpen = !paletteOpen; render(true); }, 'Show / hide the device palette');
  const hint = h('span.pb-hint');
  const toolbar = h('div.view-toolbar.pb-toolbar',
    h('span.pb-title', icon('plug', 15), 'Plugboard'), modeSeg, h('div.sep'),
    enableBtn, addBtn, tplBtn, scBtn, tidyBtn, h('div.spacer', { style: { flex: 1 } }), hint, zoomOutBtn, fitBtn, zoomInBtn, palBtn);

  const trackList = h('div.pb-tracks');
  const canvas = h('div.pb-canvas');
  const cableLayer = svg('svg', { class: 'pb-cables' });
  const sizer = h('div.pb-sizer', canvas); // scroll extent of the (scaled) board
  const stage = h('div.pb-stage', sizer);
  const overlay = h('div.pb-cable-pop.hidden');
  const palette = h('div.pb-palette');
  const center = h('div.pb-center', stage, overlay);
  const body = h('div.pb-body', trackList, center, palette);
  const el = h('div.pb-view', toolbar, body);

  // ---------------------------------------------------------------- helpers
  const P = () => store.get();
  const curTrack = (p = P()) => p.tracks.find((t) => t.id === ui.get('selectedTrackId')) || null;
  const editTrack = (label, fn, opts) => {
    const id = ui.get('selectedTrackId');
    store.transact(label, (pp) => { const t = pp.tracks.find((x) => x.id === id); if (t) fn(t, pp); }, opts);
  };
  const fxOf = (t, fxId) => t?.fx?.find((f) => f.id === fxId) || null;
  const nodeOf = (t, id) => t?.patch?.nodes?.find((n) => n.id === id) || null;
  const nodeName = (t, n) => (n.kind === 'fx' ? (EFFECT_DEFS[fxOf(t, n.fxId)?.type]?.name || 'Effect') : n.kind === 'split' ? 'Split' : 'Mix');

  function nodeSize(t, n) {
    if (n.kind !== 'fx') return { w: J_W, h: J_H };
    return { w: NODE_W, h: NODE_H };
  }
  /** Board metrics in canvas units. natural: ignore the viewport (content size only). */
  function geometry(natural = false) {
    const vw = natural ? 0 : stage.clientWidth / zoom;
    const vh = natural ? 0 : Math.max(240, stage.clientHeight / zoom);
    const ty = TERM_Y; // fixed board position (devices are laid out around it)
    const t = curTrack();
    let maxR = 0, maxB = 0;
    for (const n of t?.patch?.nodes || []) { const s = nodeSize(t, n); maxR = Math.max(maxR, n.x + s.w); maxB = Math.max(maxB, n.y + s.h); }
    const W = Math.max(vw, maxR + 60 + TERM_W + 30);
    const H = Math.max(vh, maxB + 40, ty + TERM_H + 20);
    return { W, H, inX: 14, outX: W - 14 - TERM_W, ty };
  }
  /** Port position in canvas coordinates. dir: 'in' | 'out'. */
  function portPos(t, g, nodeId, dir, port = 0) {
    if (nodeId === PATCH_IN) return { x: g.inX + TERM_W, y: g.ty + TERM_H / 2 };
    if (nodeId === PATCH_OUT) return { x: g.outX, y: g.ty + TERM_H / 2 };
    const n = nodeOf(t, nodeId);
    if (!n) return null;
    const s = nodeSize(t, n);
    const py = n.kind === 'fx' ? (port === 1 ? KEY_Y : PORT_Y) : J_H / 2;
    return { x: dir === 'out' ? n.x + s.w : n.x, y: n.y + py };
  }
  const toCanvas = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; };
  function setZoom(z) {
    zoom = clamp(Math.round(z * 100) / 100, 0.4, 1.6);
    fitBtn.textContent = `${Math.round(zoom * 100)}%`;
    render();
  }
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || mode !== 'patch') return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // ---------------------------------------------------------------- mode switch
  function renderModeSeg() {
    clear(modeSeg);
    const mk = (id, label, ic, title) => {
      const b = h(`button.pb-seg-btn${mode === id ? '.on' : ''}`, { type: 'button', title }, icon(ic, 13), h('span', label));
      b.addEventListener('click', () => { mode = id; sel = null; render(true); });
      return b;
    };
    modeSeg.append(
      mk('patch', 'Channel patch', 'plug', 'Patch the selected channel’s effects with cables'),
      mk('overview', 'Whole project routing', 'layers', 'See how every track flows into buses and the master (read-only)'));
  }

  // ---------------------------------------------------------------- track list
  function renderTrackList(p) {
    clear(trackList);
    trackList.appendChild(h('div.pb-tracks-head', { title: 'Choose the channel to patch' }, 'Channels'));
    if (!p.tracks.length) { trackList.appendChild(h('div.pb-tracks-empty', 'No tracks yet.')); return; }
    const selId = ui.get('selectedTrackId');
    for (const t of p.tracks) {
      const on = isPatchActive(t);
      const row = h(`button.pb-track${t.id === selId ? '.sel' : ''}`, { type: 'button', style: { '--tc': t.color }, title: `${t.name} — ${on ? 'plugboard routing' : `serial chain (${t.fx.length} effect${t.fx.length === 1 ? '' : 's'})`}` },
        h('span.pb-track-dot'),
        h('span.pb-track-name', t.name),
        h(`span.pb-track-badge${on ? '.on' : ''}`, on ? 'PATCH' : t.fx.length ? `${t.fx.length} fx` : '—'));
      row.addEventListener('click', () => { actions.selectTrack(t.id); if (mode !== 'patch') { mode = 'patch'; render(true); } });
      trackList.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- toolbar state
  function renderToolbar(p, t) {
    const on = isPatchActive(t);
    const patchMode = mode === 'patch';
    enableBtn.classList.toggle('on', on);
    enableBtn.disabled = !t || !patchMode;
    enableBtn.textContent = on ? '● Plugboard ON' : '○ Use plugboard for this channel';
    enableBtn.title = on
      ? 'This channel’s effects run through the patch below. Click to go back to a plain serial chain (best-effort order).'
      : 'Route this channel’s effects with cables. Starts from your current chain (in → fx1 → fx2 → … → out), so nothing changes until you re-patch.';
    for (const b of [addBtn, tplBtn, tidyBtn]) b.disabled = !on || !patchMode;
    for (const b of [enableBtn, addBtn, tplBtn, scBtn, tidyBtn, palBtn, zoomOutBtn, zoomInBtn, fitBtn]) b.classList.toggle('hidden', !patchMode || (!on && [zoomOutBtn, zoomInBtn, fitBtn].includes(b)));

    const drum = t ? findDrumTrack(p, t.id) : null;
    scBtn.disabled = !t || !patchMode || !drum;
    scBtn.title = drum ? `Add a Ducker keyed by “${drum.name}”: this channel dips whenever it plays` : 'Needs a drum track in the project';
    scBtn.querySelector('span:last-child').textContent = drum ? `Sidechain to ${drum.name}` : 'Sidechain to Drums';
    palBtn.classList.toggle('on', paletteOpen);
    palBtn.disabled = !patchMode;
    hint.textContent = !patchMode ? 'Read-only overview · click a track to patch it'
      : on ? 'Drag output ▸ to input ◂ · click a cable to select · Del removes · double-click a device to edit' : '';
  }

  // ---------------------------------------------------------------- palette
  let paletteSig = '';
  function renderPalette() {
    palette.classList.toggle('hidden', !paletteOpen || mode !== 'patch');
    if (palette.classList.contains('hidden')) { paletteSig = ''; return; }
    palette.classList.toggle('disabled', !isPatchActive(curTrack()));
    if (paletteSig === 'built') return;
    paletteSig = 'built';
    const scroll = palette.querySelector('.pb-pal-list')?.scrollTop || 0;
    clear(palette);
    const search = h('input.pb-pal-search', { type: 'search', placeholder: 'Search devices…', value: paletteQuery, title: 'Filter effects by name, category or description' });
    search.addEventListener('input', () => { paletteQuery = search.value; fillList(); });
    const list = h('div.pb-pal-list');
    const fillList = () => {
      clear(list);
      const q = paletteQuery.trim().toLowerCase();
      const types = Object.keys(EFFECT_DEFS);
      const cats = [...new Set([...EFFECT_CATEGORIES, ...types.map((x) => EFFECT_DEFS[x].category || 'Other')])];
      for (const c of cats) {
        const items = types.filter((x) => (EFFECT_DEFS[x].category || 'Other') === c)
          .filter((x) => !q || `${EFFECT_DEFS[x].name} ${c} ${EFFECT_DEFS[x].description}`.toLowerCase().includes(q));
        if (!items.length) continue;
        list.appendChild(h('div.pb-pal-cat', c));
        for (const type of items) {
          const it = h('div.pb-pal-item', { draggable: 'true', title: `${EFFECT_DEFS[type].description}\nDrag onto the board (or onto a cable to insert it) — click to add at the end of the chain` }, h('span.pb-pal-dot'), EFFECT_DEFS[type].name);
          it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-heroic-effect', type); e.dataTransfer.effectAllowed = 'copy'; });
          it.addEventListener('click', () => addDevice(type));
          list.appendChild(it);
        }
      }
      const j = h('div.pb-pal-cat', 'Junctions');
      const split = h('div.pb-pal-item.junction', { title: 'Split: one input feeding several cables (any output can also feed many cables)' }, h('span.pb-pal-dot'), 'Split');
      const mix = h('div.pb-pal-item.junction', { title: 'Mix: sums every cable plugged into it (any input also sums)' }, h('span.pb-pal-dot'), 'Mix');
      split.addEventListener('click', () => addJunction('split'));
      mix.addEventListener('click', () => addJunction('mix'));
      list.append(j, split, mix);
      if (!list.children.length) list.appendChild(h('div.pb-pal-none', 'No match.'));
    };
    fillList();
    palette.append(h('div.pb-pal-head', 'Devices'), search, list);
    list.scrollTop = scroll;
  }

  // ---------------------------------------------------------------- edits
  function enablePatch(on) {
    const t = curTrack();
    if (!t) return;
    editTrack(on ? 'Use plugboard' : 'Plugboard off', (tt) => {
      const fresh = on && !(tt.patch && patchMatchesFx(tt));
      setPatchEnabled(tt, on);
      if (fresh) { autoLayout(tt.patch); centerOnTerminals(tt); }
    });
    app.setStatus?.(on ? `${t.name}: plugboard on — patched from the serial chain` : `${t.name}: back to the serial chain`);
  }

  function addDevice(type, pos = null, intoCable = null) {
    const t = curTrack();
    if (!t) return;
    if (!isPatchActive(t)) enablePatch(true);
    const params = {};
    if (type === 'ducker') { const d = findDrumTrack(P(), t.id); if (d) params.sourceTrackId = d.id; }
    const fx = createEffect(type, params);
    let nodeId = null;
    editTrack(`Add ${EFFECT_DEFS[type]?.name || type}`, (tt) => {
      tt.fx.push(fx);
      const at = pos || nextNodePosition(tt.patch);
      const n = createPatchNode('fx', { fxId: fx.id, x: Math.max(TERM_W + 30, at.x), y: Math.max(8, at.y) });
      nodeId = n.id;
      tt.patch.nodes.push(n);
      if (intoCable) {
        const c = tt.patch.cables.find((x) => x.id === intoCable);
        if (c) {
          const to = { ...c.to };
          c.to = { node: n.id, port: 0 };
          tt.patch.cables.push(createCable(n.id, to.node, { toPort: to.port }));
        }
      } else if (!pos) insertBeforeOut(tt, n.id);
    });
    sel = nodeId ? { type: 'node', id: nodeId } : null;
    if (pos && !intoCable) app.setStatus?.('Device added — drag from its output ▸ to an input to patch it (unconnected devices are silent)');
  }

  function addJunction(kind, pos = null) {
    const t = curTrack();
    if (!t || !isPatchActive(t)) return;
    editTrack(`Add ${kind}`, (tt) => {
      const at = pos || nextNodePosition(tt.patch);
      const n = createPatchNode(kind, { x: Math.max(TERM_W + 30, at.x), y: Math.max(8, at.y) });
      tt.patch.nodes.push(n);
      sel = { type: 'node', id: n.id };
    });
  }

  function removeSelected() {
    const t = curTrack();
    if (!sel || !t?.patch) return false;
    if (sel.type === 'cable') {
      if (!t.patch.cables.some((c) => c.id === sel.id)) return false;
      const id = sel.id;
      editTrack('Remove cable', (tt) => { tt.patch.cables = tt.patch.cables.filter((c) => c.id !== id); });
    } else {
      const n = nodeOf(t, sel.id);
      if (!n) return false;
      deleteNode(n);
    }
    sel = null;
    hideOverlay();
    return true;
  }

  /** Remove a device (and its effect). bridge: reconnect what fed it to what it fed. */
  function deleteNode(n, bridge = true) {
    const t = curTrack();
    editTrack(`Remove ${nodeName(t, n)}`, (tt) => {
      removeNode(tt, n.id, { bridge });
      if (n.kind === 'fx') tt.fx = tt.fx.filter((f) => f.id !== n.fxId);
    });
    if (sel?.id === n.id) sel = null;
  }

  /** After an auto-layout: centre the devices vertically on the IN/OUT terminals. */
  function centerOnTerminals(tt) {
    const nodes = tt.patch?.nodes || [];
    if (!nodes.length) return;
    const g = geometry();
    const top = Math.min(...nodes.map((n) => n.y));
    const bottom = Math.max(...nodes.map((n) => n.y + nodeSize(tt, n).h));
    const mid = g.ty + TERM_H / 2;
    const oneRow = bottom - top <= NODE_H + 1;
    const dy = Math.round(Math.max(8 - top, oneRow ? mid - (top + PORT_Y) : mid - (top + bottom) / 2));
    for (const n of nodes) {
      n.y += dy;
      if (n.kind !== 'fx') n.y += PORT_Y - J_H / 2; // junction ports line up with device ports
    }
  }

  function tidy() {
    editTrack('Tidy plugboard', (tt) => { if (tt.patch) { autoLayout(tt.patch); centerOnTerminals(tt); } });
  }

  function useTemplate(id) {
    const p = P();
    const t = curTrack(p);
    if (!t) return;
    const drum = findDrumTrack(p, t.id);
    if (id === 'sidechain' && !drum) { app.toast('Add a drum track first — the ducker needs a key signal.', { level: 'warn' }); return; }
    const tpl = PATCH_TEMPLATES.find((x) => x.id === id);
    editTrack(`Plugboard: ${tpl?.name || id}`, (tt) => {
      if (!isPatchActive(tt)) setPatchEnabled(tt, true);
      applyTemplate(tt, id, (type, params) => createEffect(type, params), { drumTrackId: drum?.id });
      centerOnTerminals(tt);
    });
    app.toast(`${tpl?.name || id} added to ${t.name}`, { level: 'success' });
  }

  function sidechainToDrums() { useTemplate('sidechain'); }

  function showTemplates(e) {
    const p = P();
    const t = curTrack(p);
    const drum = t ? findDrumTrack(p, t.id) : null;
    const menu = contextMenu(e, [
      { header: 'Insert at the end of the chain' },
      ...PATCH_TEMPLATES.map((tp) => ({
        label: tp.id === 'sidechain' && drum ? `Sidechain to ${drum.name}` : tp.name,
        icon: tp.id === 'sidechain' ? 'drum' : 'layers',
        disabled: tp.id === 'sidechain' && !drum,
        onClick: () => useTemplate(tp.id),
      })),
    ]);
    const rows = menu.querySelectorAll('.ctx-item');
    PATCH_TEMPLATES.forEach((tp, i) => { if (rows[i]) rows[i].title = tp.help; });
  }

  function showAddMenu(e, pos = null) {
    import('../panels/device.js').then((m) => {
      m.showEffectMenu({ clientX: e.clientX, clientY: e.clientY }, (type) => addDevice(type, pos));
    }).catch(() => {});
  }

  function canvasMenu(e) {
    const t = curTrack();
    if (!isPatchActive(t)) return;
    const pos = toCanvas(e);
    contextMenu(e, [
      { header: 'Plugboard' },
      { label: 'Add effect…', icon: 'plus', onClick: () => showAddMenu(e, { x: pos.x - NODE_W / 2, y: pos.y - 16 }) },
      { label: 'Add split junction', icon: 'plug', onClick: () => addJunction('split', { x: pos.x - J_W / 2, y: pos.y - J_H / 2 }) },
      { label: 'Add mix junction', icon: 'plug', onClick: () => addJunction('mix', { x: pos.x - J_W / 2, y: pos.y - J_H / 2 }) },
      '-',
      { label: 'Templates', icon: 'layers', submenu: PATCH_TEMPLATES.map((tp) => ({ label: tp.name, onClick: () => useTemplate(tp.id) })) },
      { label: 'Tidy layout', icon: 'grid', onClick: () => tidy() },
      '-',
      { label: 'Turn plugboard off', icon: 'power', onClick: () => enablePatch(false) },
    ]);
  }

  function openInDevicePanel(fxId) {
    const t = curTrack();
    if (!t) return;
    actions.selectTrack(t.id);
    ui.set({ deviceOpen: true, deviceTarget: null, deviceFocus: fxId });
  }

  // ---------------------------------------------------------------- stage
  function stageSignature(p, t) {
    return JSON.stringify([
      mode, t?.id, isPatchActive(t), t?.name,
      (t?.fx || []).map((f) => [f.id, f.type]),
      (t?.patch?.nodes || []).map((n) => [n.id, n.kind, n.fxId]),
      p.tracks.length,
    ]);
  }

  function renderStage(force) {
    const p = P();
    const t = curTrack(p);
    const sig = stageSignature(p, t);
    if (force || sig !== lastStageSig) {
      lastStageSig = sig;
      buildStage(p, t);
    }
    updateStage(p, t);
  }

  function buildStage(p, t) {
    clear(canvas);
    for (const x of [canvas, sizer]) { x.style.width = ''; x.style.height = ''; }
    canvas.style.transform = '';
    nodeEls = new Map();
    canvas.classList.remove('overview');
    stage.classList.remove('empty');
    if (mode === 'overview') { canvas.classList.add('overview'); return; }
    if (!p.tracks.length) {
      stage.classList.add('empty');
      canvas.appendChild(h('div.empty-state.pb-empty', icon('plug', 34), h('h3', 'No channels yet'),
        h('p', 'The plugboard patches a channel’s effects with cables. Add a track first.'),
        button('Add track', (e) => contextMenu(e, actions.addTrackMenuItems()), { icon: 'plus', primary: true })));
      return;
    }
    if (!t) {
      stage.classList.add('empty');
      canvas.appendChild(h('div.empty-state.pb-empty', icon('plug', 34), h('h3', 'Pick a channel'), h('p', 'Choose a track on the left to patch its effects.')));
      return;
    }
    if (!isPatchActive(t)) {
      stage.classList.add('empty');
      const chain = t.fx.length ? t.fx.map((f) => EFFECT_DEFS[f.type]?.name || f.type).join(' → ') : 'no effects yet';
      canvas.appendChild(h('div.empty-state.pb-empty.pb-intro',
        icon('plug', 34),
        h('h3', `Patch “${t.name}” with cables`),
        h('p', 'A plugboard is a modular patch bay for this channel: instead of a fixed top-to-bottom effect chain, you wire devices together with cables — split the signal into parallel branches, blend a crushed copy under the dry sound, filter bands separately, or duck it under the kick with a sidechain.'),
        h('div.pb-intro-chain', h('span.pb-term-mini', 'IN'), h('span', ` → ${chain} → `), h('span.pb-term-mini', 'OUT')),
        h('p.muted', 'Starting the plugboard keeps your current chain exactly as it sounds; nothing changes until you re-patch. Pan, volume and sends still apply after OUT.'),
        h('div.pb-intro-actions',
          button('Patch this channel', () => enablePatch(true), { icon: 'plug', primary: true, title: 'Turn the plugboard on for this channel' }),
          button('Start from a template ▾', (e) => showTemplates(e), { icon: 'layers', title: 'Parallel compression, distortion blend, band split, dry/wet reverb, sidechain' }))));
      return;
    }
    // terminals
    const termIn = h('div.pb-term.in', { title: `IN — ${t.name}’s instrument / clips signal` }, h('div.pb-term-label', 'IN'), h('div.pb-term-sub', t.name), h('div.pb-port.out', { dataset: { node: PATCH_IN, dir: 'out', port: 0 }, title: 'Output — drag to a device input' }));
    const termOut = h('div.pb-term.out', { title: 'OUT — continues to pan, volume, sends and the master' }, h('div.pb-term-label', 'OUT'), h('div.pb-term-sub', 'to fader'), h('div.pb-port.in', { dataset: { node: PATCH_OUT, dir: 'in', port: 0 }, title: 'Input — everything plugged in here is summed and goes to the channel fader' }));
    canvas.append(termIn, termOut);
    for (const n of t.patch.nodes) canvas.appendChild(buildNode(t, n));
    canvas.appendChild(cableLayer);
  }

  function buildNode(t, n) {
    const rec = { el: null, knobs: new Map(), power: null, select: null };
    const ports = [];
    if (n.kind === 'fx') {
      const fx = fxOf(t, n.fxId);
      const def = EFFECT_DEFS[fx?.type];
      const name = def?.name || fx?.type || 'Effect';
      const power = h('button.pb-power', { type: 'button', title: 'Bypass / enable this device' }, icon('power', 11));
      power.addEventListener('pointerdown', (e) => e.stopPropagation());
      power.addEventListener('click', (e) => { e.stopPropagation(); editTrack(`${fx.enabled ? 'Bypass' : 'Enable'} ${name}`, (tt) => { const f = fxOf(tt, n.fxId); if (f) f.enabled = !f.enabled; }); });
      rec.power = power;
      const more = iconButton('menu', (e) => nodeMenu(e, n), 'More: edit in device panel, disconnect, remove', 'pb-more');
      more.addEventListener('pointerdown', (e) => e.stopPropagation());
      const head = h('div.pb-node-head', power, h('span.pb-node-title', { title: `${name} — ${def?.description || ''}\nDrag to move · double-click to open in the device panel` }, name), more);
      const bodyEl = h('div.pb-node-body');
      if (fx && def) {
        const vals = resolveEffectParams(fx);
        const nums = def.params.filter((d) => d.type === 'number' && !d.advanced);
        let pick;
        if (fx.type === 'ducker') {
          const sl = trackSelect({
            value: vals.sourceTrackId, exclude: t.id, noneLabel: '— key track —', title: 'Key (sidechain) source: this channel ducks whenever that track plays',
            onChange: (v) => {
              if (v && !canKey(P(), t.id, v, fx.id)) { app.toast('That would create a sidechain loop (those tracks already key each other).', { level: 'warn' }); rec.select.setValue(fxOf(curTrack(), fx.id)?.params?.sourceTrackId || ''); return; }
              editTrack('Ducker key track', (tt) => { const f = fxOf(tt, fx.id); if (f) { f.params = f.params || {}; f.params.sourceTrackId = v; } });
            },
          });
          sl.classList.add('pb-key-select');
          sl.addEventListener('pointerdown', (e) => e.stopPropagation());
          rec.select = sl;
          bodyEl.appendChild(sl);
          pick = nums.filter((d) => ['amount', 'threshold'].includes(d.key));
        } else {
          const mix = nums.find((d) => d.key === 'mix');
          pick = nums.filter((d) => d.key !== 'mix' && d.key !== 'output').slice(0, mix ? 2 : 3);
          if (mix) pick.push(mix);
        }
        const row = h('div.pb-knobs');
        for (const d of pick) {
          const k = knob({
            def: d, value: vals[d.key], size: 28,
            onChange: (v) => editTrack(`${name}: ${d.label}`, (tt) => { const f = fxOf(tt, fx.id); if (f) { f.params = f.params || {}; f.params[d.key] = v; } }, { coalesce: true }),
          });
          k.addEventListener('pointerdown', (e) => e.stopPropagation());
          rec.knobs.set(d.key, k);
          row.appendChild(k);
        }
        bodyEl.appendChild(row);
      } else bodyEl.appendChild(h('div.pb-node-missing', 'Missing effect'));
      ports.push(h('div.pb-port.in', { dataset: { node: n.id, dir: 'in', port: 0 }, style: { top: PORT_Y + 'px' }, title: 'Input — drop a cable here (several cables are summed)' }));
      if (fx?.type === 'ducker') ports.push(h('div.pb-port.in.key', { dataset: { node: n.id, dir: 'in', port: 1 }, style: { top: KEY_Y + 'px' }, title: 'Key input — the signal that triggers ducking (set a key track above, or patch a signal from this board)' }, h('span.pb-port-label', 'key')));
      ports.push(h('div.pb-port.out', { dataset: { node: n.id, dir: 'out', port: 0 }, style: { top: PORT_Y + 'px' }, title: 'Output — drag to an input (one output can feed many cables)' }));
      rec.el = h(`div.pb-node.fx${fx?.enabled === false ? '.bypassed' : ''}`, { dataset: { nodeId: n.id, fxType: fx?.type || '' }, style: { width: NODE_W + 'px', height: NODE_H + 'px' } }, head, bodyEl, ...ports);
      rec.el.addEventListener('dblclick', (e) => { if (!e.target.closest('.knob, select, button')) openInDevicePanel(n.fxId); });
    } else {
      const label = n.kind === 'split' ? 'Split' : 'Mix';
      rec.el = h(`div.pb-node.junction.${n.kind}`, { dataset: { nodeId: n.id }, style: { width: J_W + 'px', height: J_H + 'px' }, title: n.kind === 'split' ? 'Split — feeds every cable plugged into its output' : 'Mix — sums every cable plugged into its input' },
        h('div.pb-node-head', h('span.pb-node-title', label)),
        h('div.pb-port.in', { dataset: { node: n.id, dir: 'in', port: 0 }, style: { top: J_H / 2 + 'px' }, title: 'Input' }),
        h('div.pb-port.out', { dataset: { node: n.id, dir: 'out', port: 0 }, style: { top: J_H / 2 + 'px' }, title: 'Output' }));
    }
    rec.el.addEventListener('contextmenu', (e) => { e.stopPropagation(); nodeMenu(e, n); });
    rec.el.addEventListener('pointerdown', (e) => onNodePointerDown(e, n));
    nodeEls.set(n.id, rec);
    return rec.el;
  }

  function nodeMenu(e, n) {
    const t = curTrack();
    const fx = n.kind === 'fx' ? fxOf(t, n.fxId) : null;
    sel = { type: 'node', id: n.id };
    updateStage(P(), t);
    contextMenu(e, [
      { header: nodeName(t, n) },
      fx ? { label: 'Edit in device panel', icon: 'sliders', onClick: () => openInDevicePanel(n.fxId) } : null,
      fx ? { label: fx.enabled ? 'Bypass' : 'Enable', icon: 'power', onClick: () => editTrack('Toggle device', (tt) => { const f = fxOf(tt, n.fxId); if (f) f.enabled = !f.enabled; }) } : null,
      { label: 'Disconnect all cables', icon: 'x', onClick: () => editTrack('Disconnect device', (tt) => { tt.patch.cables = tt.patch.cables.filter((c) => c.from.node !== n.id && c.to.node !== n.id); }) },
      '-',
      { label: 'Remove (keep the signal flowing)', icon: 'trash', shortcut: 'Del', onClick: () => deleteNode(n, true) },
      { label: 'Remove with its cables', icon: 'trash', onClick: () => deleteNode(n, false) },
    ].filter(Boolean));
  }

  function updateStage(p, t) {
    if (mode === 'overview') { renderOverview(p); return; }
    if (!t || !isPatchActive(t)) return;
    const g = geometry();
    canvas.style.width = g.W + 'px';
    canvas.style.height = g.H + 'px';
    canvas.style.transform = zoom !== 1 ? `scale(${zoom})` : '';
    sizer.style.width = Math.ceil(g.W * zoom) + 'px';
    sizer.style.height = Math.ceil(g.H * zoom) + 'px';
    const tin = canvas.querySelector('.pb-term.in');
    const tout = canvas.querySelector('.pb-term.out');
    if (tin) { tin.style.left = g.inX + 'px'; tin.style.top = g.ty + 'px'; }
    if (tout) { tout.style.left = g.outX + 'px'; tout.style.top = g.ty + 'px'; }
    for (const n of t.patch.nodes) {
      const rec = nodeEls.get(n.id);
      if (!rec) continue;
      rec.el.style.left = n.x + 'px';
      rec.el.style.top = n.y + 'px';
      rec.el.classList.toggle('sel', sel?.type === 'node' && sel.id === n.id);
      if (n.kind === 'fx') {
        const fx = fxOf(t, n.fxId);
        if (!fx) continue;
        rec.el.classList.toggle('bypassed', fx.enabled === false);
        rec.power?.classList.toggle('on', fx.enabled !== false);
        const vals = resolveEffectParams(fx);
        for (const [k, kn] of rec.knobs) kn.setValue(vals[k]);
        if (rec.select && document.activeElement !== rec.select) rec.select.setValue(vals.sourceTrackId);
        const connectedIn = t.patch.cables.some((c) => c.to.node === n.id && !c.to.port);
        const connectedOut = t.patch.cables.some((c) => c.from.node === n.id);
        rec.el.classList.toggle('loose', !(connectedIn && connectedOut));
        rec.el.title = connectedIn && connectedOut ? '' : 'Not fully connected — this device is silent until its input and output are patched';
      }
    }
    drawCables(t, g);
  }

  // ---------------------------------------------------------------- cables
  function drawCables(t, g) {
    while (cableLayer.firstChild) cableLayer.firstChild.remove();
    cableLayer.setAttribute('width', g.W);
    cableLayer.setAttribute('height', g.H);
    const defs = svg('defs');
    const f = svg('filter', { id: 'pb-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
    f.appendChild(svg('feGaussianBlur', { stdDeviation: 2.2 }));
    defs.appendChild(f);
    cableLayer.appendChild(defs);
    const links = resolveKeyLinks(P());
    // phantom key cables: another track → ducker key input
    for (const n of t.patch.nodes) {
      if (n.kind !== 'fx') continue;
      const fx = fxOf(t, n.fxId);
      if (fx?.type !== 'ducker') continue;
      const src = fx.params?.sourceTrackId;
      if (!src) continue;
      const st = P().tracks.find((x) => x.id === src);
      const ok = links.get(fx.id) === src;
      const to = portPos(t, g, n.id, 'in', 1);
      const jx = Math.max(6, to.x - 150), jy = Math.min(g.H - 26, to.y + 46);
      const grp = svg('g', { class: `pb-keycable${ok ? '' : ' broken'}` });
      grp.appendChild(svg('path', { d: cablePath(jx + 112, jy + 11, to.x, to.y), class: 'pb-key-path' }));
      const pill = svg('g', { class: 'pb-key-pill', transform: `translate(${jx} ${jy})` });
      const title = svg('title');
      title.textContent = ok ? `Sidechain key from “${st?.name}” (post-effects, pre-fader). Click to open that channel.` : st ? `“${st.name}” can’t key this ducker (it would create a loop)` : 'Key track was deleted — pick another one on the device';
      pill.append(title, svg('rect', { width: 112, height: 22, rx: 11, class: 'pb-key-bg' }), svg('circle', { cx: 12, cy: 11, r: 5, fill: st?.color || '#888' }));
      const tx = svg('text', { x: 22, y: 15, class: 'pb-key-text' });
      tx.textContent = (st ? st.name : 'missing').slice(0, 13) + ' ▸';
      pill.appendChild(tx);
      if (st) pill.addEventListener('click', () => actions.selectTrack(st.id));
      grp.appendChild(pill);
      cableLayer.appendChild(grp);
    }
    for (const c of t.patch.cables) {
      if (dragCable?.lifted === c.id) continue;
      const a = portPos(t, g, c.from.node, 'out');
      const b = portPos(t, g, c.to.node, 'in', c.to.port | 0);
      if (!a || !b) continue;
      const color = c.to.port === 1 ? 'var(--accent-3)' : hashColor(c.id);
      const d = cablePath(a.x, a.y, b.x, b.y);
      const isSel = sel?.type === 'cable' && sel.id === c.id;
      const grp = svg('g', { class: `pb-cable${isSel ? ' sel' : ''}${hoverCable === c.id ? ' hover' : ''}${c.gain <= 0.0001 ? ' muted' : ''}`, style: `--cc:${color}` });
      grp.append(
        svg('path', { d, class: 'pb-c-shadow', filter: 'url(#pb-shadow)', transform: 'translate(2 4)' }),
        svg('path', { d, class: 'pb-c-body' }),
        svg('path', { d, class: 'pb-c-gloss' }),
        svg('path', { d, class: 'pb-c-hit', 'data-cable-id': c.id }),
        svg('circle', { cx: a.x, cy: a.y, r: 6, class: 'pb-c-plug' }),
        svg('circle', { cx: b.x, cy: b.y, r: 6, class: 'pb-c-plug end', 'data-cable-end': c.id }),
      );
      const title = svg('title');
      title.textContent = `${labelOf(t, c.from.node)} → ${labelOf(t, c.to.node)}${c.to.port === 1 ? ' (key)' : ''} · ${fmtGain(c.gain)}\nClick to select · Del removes · drag the plug at the input end to re-patch`;
      grp.querySelector('.pb-c-hit').appendChild(title);
      if (Math.abs(c.gain - 1) > 0.005) {
        const m = cablePoint(a.x, a.y, b.x, b.y, 0.5);
        const lbl = svg('text', { x: m.x, y: m.y - 9, class: 'pb-c-gain' });
        lbl.textContent = fmtGain(c.gain);
        grp.appendChild(lbl);
      }
      cableLayer.appendChild(grp);
    }
    if (dragCable) {
      const a = dragCable.reverse ? { x: dragCable.x, y: dragCable.y } : portPos(t, g, dragCable.from.node, 'out');
      const b = dragCable.reverse ? portPos(t, g, dragCable.to.node, 'in', dragCable.to.port) : { x: dragCable.x, y: dragCable.y };
      if (a && b) {
        const grp = svg('g', { class: `pb-cable temp${dragCable.valid === false ? ' invalid' : ''}`, style: `--cc:${dragCable.color}` });
        const d = cablePath(a.x, a.y, b.x, b.y);
        grp.append(svg('path', { d, class: 'pb-c-body' }), svg('path', { d, class: 'pb-c-gloss' }), svg('circle', { cx: dragCable.reverse ? a.x : b.x, cy: dragCable.reverse ? a.y : b.y, r: 6, class: 'pb-c-plug' }));
        cableLayer.appendChild(grp);
      }
    }
    positionOverlay(t, g);
  }

  function labelOf(t, id) {
    if (id === PATCH_IN) return 'IN';
    if (id === PATCH_OUT) return 'OUT';
    const n = nodeOf(t, id);
    return n ? nodeName(t, n) : '?';
  }

  // cable hover / selection overlay with a gain knob + delete
  let overlayFor = null;
  let overlayKnob = null;
  let hideTimer = 0;
  function hideOverlay() { overlay.classList.add('hidden'); overlayFor = null; }
  function positionOverlay(t, g) {
    const id = sel?.type === 'cable' ? sel.id : hoverCable;
    const c = id && t.patch.cables.find((x) => x.id === id);
    if (!c || dragCable) { hideOverlay(); return; }
    const a = portPos(t, g, c.from.node, 'out');
    const b = portPos(t, g, c.to.node, 'in', c.to.port | 0);
    if (!a || !b) { hideOverlay(); return; }
    if (overlayFor !== c.id) {
      overlayFor = c.id;
      clear(overlay);
      overlayKnob = knob({
        def: GAIN_DEF, value: c.gain, size: 26, label: false,
        onChange: (v) => editTrack('Cable level', (tt) => { const cc = tt.patch.cables.find((x) => x.id === c.id); if (cc) cc.gain = v; }, { coalesce: true }),
      });
      const del = iconButton('trash', () => { sel = { type: 'cable', id: c.id }; removeSelected(); }, 'Remove this cable (Del)', 'pb-pop-del');
      overlay.append(overlayKnob, del);
    } else overlayKnob?.setValue(c.gain);
    const m = cablePoint(a.x, a.y, b.x, b.y, 0.5);
    overlay.style.left = (m.x * zoom - stage.scrollLeft + 6) + 'px';
    overlay.style.top = (m.y * zoom - stage.scrollTop + 8) + 'px';
    overlay.classList.remove('hidden');
  }
  overlay.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  overlay.addEventListener('pointerleave', () => scheduleHoverOff());
  function scheduleHoverOff() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (hoverCable) { hoverCable = null; refreshCables(); } }, 450);
  }
  const refreshCables = () => { const t = curTrack(); if (t && isPatchActive(t) && mode === 'patch') drawCables(t, geometry()); };
  stage.addEventListener('scroll', () => refreshCables());

  canvas.addEventListener('pointermove', (e) => {
    if (dragCable) return;
    const id = e.target.closest?.('[data-cable-id]')?.dataset.cableId || e.target.closest?.('[data-cable-end]')?.dataset.cableEnd || null;
    if (id) {
      clearTimeout(hideTimer);
      if (hoverCable !== id) { hoverCable = id; refreshCables(); }
    } else if (hoverCable && !overlay.contains(e.target)) scheduleHoverOff();
  });

  // ---------------------------------------------------------------- pointer interactions
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'patch' || e.button !== 0) return;
    const t = curTrack();
    if (!isPatchActive(t)) return;
    // ports sit under the cable layer: look through it (a plug end wins over its port = re-patch)
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    const end = stack.find((x) => x.dataset?.cableEnd);
    if (end) { e.preventDefault(); e.stopPropagation(); pickUpCable(e, end.dataset.cableEnd); return; }
    const port = stack.find((x) => x.classList?.contains('pb-port'));
    if (port) { e.preventDefault(); e.stopPropagation(); startPortDrag(e, port); return; }
    const hit = e.target.closest?.('[data-cable-id]');
    if (hit) { e.preventDefault(); sel = { type: 'cable', id: hit.dataset.cableId }; updateStage(P(), t); return; }
    if (!e.target.closest('.pb-node, .pb-term')) { sel = null; updateStage(P(), t); }
  }, true);
  canvas.addEventListener('contextmenu', (e) => {
    const hit = e.target.closest?.('[data-cable-id]');
    if (hit) {
      e.preventDefault();
      const id = hit.dataset.cableId;
      sel = { type: 'cable', id };
      refreshCables();
      contextMenu(e, [{ header: 'Cable' }, { label: 'Reset level (0 dB)', onClick: () => editTrack('Cable level', (tt) => { const c = tt.patch.cables.find((x) => x.id === id); if (c) c.gain = 1; }) }, { label: 'Remove', icon: 'trash', shortcut: 'Del', onClick: () => removeSelected() }]);
      return;
    }
    if (!e.target.closest('.pb-node')) canvasMenu(e);
  });

  /** Resolve a drop point to a port: a port element, a plug end, or a whole device box. */
  function dropTarget(e, wantDir) {
    const t = curTrack();
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    const port = stack.find((x) => x.classList?.contains('pb-port') && x.dataset.dir === wantDir);
    if (port) return { node: port.dataset.node, port: +port.dataset.port };
    const elAt = stack.find((x) => !x.closest?.('.pb-cable:not(.temp)') || x.dataset?.cableEnd) || stack[0];
    if (!elAt) return null;
    const end = elAt.closest?.('[data-cable-end]');
    if (end && wantDir === 'in') { const c = t.patch.cables.find((x) => x.id === end.dataset.cableEnd); if (c) return { node: c.to.node, port: c.to.port | 0 }; }
    const nodeEl = elAt.closest?.('.pb-node');
    if (nodeEl) return { node: nodeEl.dataset.nodeId, port: 0 };
    const term = elAt.closest?.('.pb-term');
    if (term) {
      if (wantDir === 'in' && term.classList.contains('out')) return { node: PATCH_OUT, port: 0 };
      if (wantDir === 'out' && term.classList.contains('in')) return { node: PATCH_IN, port: 0 };
    }
    return null;
  }

  function markTargets(on, wantDir) {
    canvas.classList.toggle('dragging-cable', on);
    canvas.dataset.want = on ? wantDir : '';
  }

  function startPortDrag(e, portEl) {
    const t = curTrack();
    const node = portEl.dataset.node, dir = portEl.dataset.dir, port = +portEl.dataset.port;
    if (dir === 'in') {
      // grab the most recent cable plugged into this input, if any (Reason-style re-patching)
      const existing = [...t.patch.cables].reverse().find((c) => c.to.node === node && (c.to.port | 0) === port);
      if (existing) { pickUpCable(e, existing.id); return; }
      dragCable = { reverse: true, to: { node, port }, color: port === 1 ? 'var(--accent-3)' : CABLE_COLORS[t.patch.cables.length % CABLE_COLORS.length], ...toCanvas(e) };
    } else {
      dragCable = { from: { node, port: 0 }, color: CABLE_COLORS[t.patch.cables.length % CABLE_COLORS.length], ...toCanvas(e) };
    }
    runCableDrag(dir === 'in' ? 'out' : 'in');
  }

  function pickUpCable(e, cableId) {
    const t = curTrack();
    const c = t.patch.cables.find((x) => x.id === cableId);
    if (!c) return;
    dragCable = { from: { ...c.from }, lifted: c.id, gain: c.gain, color: c.to.port === 1 ? 'var(--accent-3)' : hashColor(c.id), origTo: { ...c.to }, ...toCanvas(e) };
    sel = null;
    runCableDrag('in');
  }

  function runCableDrag(wantDir) {
    markTargets(true, wantDir);
    hideOverlay();
    refreshCables();
    const onMove = (ev) => {
      Object.assign(dragCable, toCanvas(ev));
      const tg = dropTarget(ev, wantDir);
      const t = curTrack();
      if (tg) {
        const from = dragCable.reverse ? tg : dragCable.from;
        const to = dragCable.reverse ? dragCable.to : tg;
        dragCable.valid = validateCable(withoutLifted(t), from, to).ok || sameAsOrig(to);
      } else dragCable.valid = null;
      // auto-scroll near the edges
      const r = stage.getBoundingClientRect();
      if (ev.clientX > r.right - 30) stage.scrollLeft += 12; else if (ev.clientX < r.left + 30) stage.scrollLeft -= 12;
      refreshCables();
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const dc = dragCable;
      dragCable = null;
      markTargets(false);
      const tg = ev.type === 'pointerup' ? dropTarget(ev, wantDir) : null;
      const t = curTrack();
      if (dc.lifted) {
        if (tg && sameAsOrig(tg, dc)) { refreshCables(); return; }
        const from = dc.from;
        if (tg) {
          const v = validateCable(withoutLifted(t, dc.lifted), from, tg);
          if (v.ok) {
            editTrack('Re-patch cable', (tt) => {
              tt.patch.cables = tt.patch.cables.filter((c) => c.id !== dc.lifted);
              connect(tt, from, tg, dc.gain);
            });
            return;
          }
          app.toast(v.reason, { level: 'warn' });
          refreshCables();
          return;
        }
        editTrack('Disconnect cable', (tt) => { tt.patch.cables = tt.patch.cables.filter((c) => c.id !== dc.lifted); });
        app.setStatus?.('Cable disconnected');
        return;
      }
      if (!tg) { refreshCables(); return; }
      const from = dc.reverse ? tg : dc.from;
      const to = dc.reverse ? dc.to : tg;
      const v = validateCable(t, from, to);
      if (!v.ok) { if (v.reason !== 'Unknown device') app.toast(v.reason, { level: 'warn' }); refreshCables(); return; }
      let made = null;
      editTrack('Connect cable', (tt) => { made = connect(tt, from, to); });
      if (made) sel = { type: 'cable', id: made.id };
      refreshCables();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  function withoutLifted(t, id = dragCable?.lifted) {
    if (!id) return t;
    return { ...t, patch: { ...t.patch, cables: t.patch.cables.filter((c) => c.id !== id) } };
  }
  function sameAsOrig(to, dc = dragCable) {
    return !!(dc?.origTo && to && dc.origTo.node === to.node && (dc.origTo.port | 0) === (to.port | 0));
  }

  function onNodePointerDown(e, n) {
    if (e.button !== 0 || e.target.closest('.pb-port, .knob, select, button, input')) return;
    const t = curTrack();
    sel = { type: 'node', id: n.id };
    updateStage(P(), t);
    const x0 = n.x, y0 = n.y;
    let moved = false;
    const rec = nodeEls.get(n.id);
    startDrag(e, (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < 3) return;
      dx /= zoom; dy /= zoom;
      moved = true;
      rec?.el.classList.add('moving');
      const nx = Math.round(clamp(x0 + dx, TERM_W + 24, 6000));
      const ny = Math.round(clamp(y0 + dy, 4, 4000));
      editTrack('Move device', (tt) => { const nn = nodeOf(tt, n.id); if (nn) { nn.x = nx; nn.y = ny; } }, { coalesce: true });
    }, () => { rec?.el.classList.remove('moving'); });
  }

  // ---------------------------------------------------------------- drop from the palette / browser
  stage.addEventListener('dragover', (e) => {
    if (mode !== 'patch' || !isPatchActive(curTrack())) return;
    if (![...(e.dataTransfer?.types || [])].includes('application/x-heroic-effect')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-cable-id]');
    canvas.querySelectorAll('.pb-cable.drop').forEach((x) => x.classList.remove('drop'));
    hit?.closest('.pb-cable')?.classList.add('drop');
  });
  stage.addEventListener('dragleave', () => canvas.querySelectorAll('.pb-cable.drop').forEach((x) => x.classList.remove('drop')));
  stage.addEventListener('drop', (e) => {
    const type = e.dataTransfer?.getData('application/x-heroic-effect');
    if (!type || !EFFECT_DEFS[type]) return;
    e.preventDefault();
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-cable-id]');
    const pos = toCanvas(e);
    addDevice(type, { x: Math.round(pos.x - NODE_W / 2), y: Math.round(pos.y - 18) }, hit?.dataset.cableId || null);
  });

  // ---------------------------------------------------------------- overview (whole project)
  function renderOverview(p) {
    clear(canvas);
    canvas.classList.add('overview');
    const W = Math.max(stage.clientWidth - 4, 760);
    const rowH = 54, top = 46;
    const tracks = p.tracks, buses = p.buses || [];
    const H = Math.max(stage.clientHeight - 4, top + Math.max(tracks.length, buses.length * 2, 3) * rowH + 40);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.style.transform = '';
    sizer.style.width = W + 'px';
    sizer.style.height = H + 'px';
    const s = svg('svg', { class: 'pb-ov', width: W, height: H });
    const tx = 70, tw = 230, bx = Math.round(W * 0.52), bw = 190, mx = W - 200, mw = 170;
    const header = (x, label) => { const t = svg('text', { x, y: 26, class: 'pb-ov-head' }); t.textContent = label; s.appendChild(t); };
    header(tx, 'TRACKS'); header(bx, 'RETURN BUSES'); header(mx, 'MASTER');
    const tPos = new Map();
    tracks.forEach((t, i) => tPos.set(t.id, { x: tx, y: top + i * rowH, h: 40 }));
    const bPos = new Map();
    const bStart = top + Math.max(0, (tracks.length * rowH - buses.length * rowH * 1.6) / 2);
    buses.forEach((b, i) => bPos.set(b.id, { x: bx, y: bStart + i * rowH * 1.6, h: 44 }));
    const mPos = { x: mx, y: Math.max(top, H / 2 - 40), h: 80 };
    const links = resolveKeyLinks(p);
    const wire = (x1, y1, x2, y2, cls, color, width, tip) => {
      const pth = svg('path', { d: `M${x1} ${y1} C${x1 + (x2 - x1) * 0.45} ${y1} ${x2 - (x2 - x1) * 0.45} ${y2} ${x2} ${y2}`, class: cls, style: `--cc:${color}; stroke-width:${width}px` });
      if (tip) { const ti = svg('title'); ti.textContent = tip; pth.appendChild(ti); }
      s.appendChild(pth);
    };
    // master feeds
    for (const t of tracks) {
      const a = tPos.get(t.id);
      const audible = !t.mute;
      wire(tx + tw, a.y + a.h / 2, mPos.x, mPos.y + mPos.h / 2, `pb-ov-wire main${audible ? '' : ' dim'}`, t.color, 1.6 + 2 * Math.min(1.5, t.volume ?? 0.8), `${t.name} → Master (volume ${Math.round((t.volume ?? 0.8) * 100)}%)`);
    }
    for (const b of buses) {
      const a = bPos.get(b.id);
      wire(bx + bw, a.y + a.h / 2, mPos.x, mPos.y + mPos.h / 2, `pb-ov-wire bus${b.mute ? ' dim' : ''}`, 'var(--accent-2)', 2.5, `${b.name} → Master`);
    }
    // sends
    for (const t of tracks) {
      for (const [busId, amt] of Object.entries(t.sends || {})) {
        const b = bPos.get(busId);
        if (!b || !(amt > 0)) continue;
        const a = tPos.get(t.id);
        const bus = buses.find((x) => x.id === busId);
        wire(tx + tw, a.y + a.h / 2 + 6, bx, b.y + b.h / 2, 'pb-ov-wire send', t.color, 1 + 4 * amt, `${t.name} → ${bus?.name} send ${Math.round(amt * 100)}% (post-fader)`);
      }
    }
    // sidechain keys (track → track, left side arcs; track → bus/master)
    const reqTracks = [];
    for (const t of tracks) for (const f of t.fx || []) if (f.type === 'ducker' && links.get(f.id)) reqTracks.push({ to: { kind: 'track', id: t.id }, from: links.get(f.id), fx: f });
    for (const b of buses) for (const f of b.fx || []) if (f.type === 'ducker' && links.get(f.id)) reqTracks.push({ to: { kind: 'bus', id: b.id }, from: links.get(f.id), fx: f });
    for (const f of p.master.fx || []) if (f.type === 'ducker' && links.get(f.id)) reqTracks.push({ to: { kind: 'master' }, from: links.get(f.id), fx: f });
    reqTracks.forEach((r, i) => {
      const a = tPos.get(r.from);
      if (!a) return;
      const src = tracks.find((x) => x.id === r.from);
      let d, tip;
      if (r.to.kind === 'track') {
        const b = tPos.get(r.to.id);
        const bend = 26 + (i % 4) * 12;
        d = `M${tx} ${a.y + a.h / 2} C${tx - bend * 2} ${a.y + a.h / 2} ${tx - bend * 2} ${b.y + b.h / 2} ${tx} ${b.y + b.h / 2}`;
        tip = `Sidechain: ${src?.name} ducks ${tracks.find((x) => x.id === r.to.id)?.name}`;
      } else {
        const b = r.to.kind === 'bus' ? bPos.get(r.to.id) : mPos;
        const x2 = r.to.kind === 'bus' ? bx : mx;
        d = `M${tx + tw} ${a.y + a.h / 2 - 8} C${tx + tw + 80} ${a.y - 30} ${x2 - 60} ${b.y - 30} ${x2 + 20} ${b.y}`;
        tip = `Sidechain: ${src?.name} ducks ${r.to.kind === 'bus' ? buses.find((x) => x.id === r.to.id)?.name : 'Master'}`;
      }
      const pth = svg('path', { d, class: 'pb-ov-key', 'marker-end': 'url(#pb-ov-arrow)' });
      const ti = svg('title'); ti.textContent = tip; pth.appendChild(ti);
      s.appendChild(pth);
    });
    const defs = svg('defs');
    const mk = svg('marker', { id: 'pb-ov-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    mk.appendChild(svg('path', { d: 'M0 0 L10 5 L0 10 z', class: 'pb-ov-arrow' }));
    defs.appendChild(mk);
    s.appendChild(defs);
    // boxes
    const box = (x, y, w, hh, color, title, sub, cls, onClick, tip) => {
      const g = svg('g', { class: `pb-ov-box ${cls}`, transform: `translate(${x} ${y})` });
      g.append(svg('rect', { width: w, height: hh, rx: 7, class: 'pb-ov-rect' }), svg('rect', { width: 5, height: hh, rx: 2, fill: color }));
      const t1 = svg('text', { x: 14, y: hh / 2 - 3, class: 'pb-ov-name' }); t1.textContent = title;
      const t2 = svg('text', { x: 14, y: hh / 2 + 12, class: 'pb-ov-sub' }); t2.textContent = sub;
      g.append(t1, t2);
      if (tip) { const ti = svg('title'); ti.textContent = tip; g.appendChild(ti); }
      if (onClick) g.addEventListener('click', onClick);
      s.appendChild(g);
    };
    const chainText = (t) => {
      const names = (isPatchActive(t) ? patchFxOrder(t) : t.fx.map((f) => f.id)).map((id) => EFFECT_DEFS[t.fx.find((f) => f.id === id)?.type]?.name).filter(Boolean);
      const s2 = names.length ? names.join(' › ') : 'no effects';
      return (isPatchActive(t) ? '⚡ patch: ' : '') + (s2.length > 34 ? s2.slice(0, 33) + '…' : s2);
    };
    for (const t of tracks) {
      const a = tPos.get(t.id);
      box(tx, a.y, tw, a.h, t.color, t.name + (t.mute ? ' (muted)' : ''), chainText(t), `track${t.id === ui.get('selectedTrackId') ? ' sel' : ''}${isPatchActive(t) ? ' patched' : ''}`,
        () => { actions.selectTrack(t.id); mode = 'patch'; render(true); }, `${t.name}\nClick to open this channel’s plugboard`);
    }
    for (const b of buses) {
      const a = bPos.get(b.id);
      const feeders = tracks.filter((t) => t.sends?.[b.id] > 0).length;
      box(bx, a.y, bw, a.h, 'var(--accent-2)', b.name, `${(b.fx || []).map((f) => EFFECT_DEFS[f.type]?.name).filter(Boolean).join(' › ') || 'no effects'} · ${feeders} send${feeders === 1 ? '' : 's'}`, 'bus', () => ui.set({ deviceOpen: true, deviceTarget: { kind: 'bus', id: b.id } }), `${b.name} — return bus. Click to edit its effects in the device panel`);
    }
    box(mx, mPos.y, mw, mPos.h, 'var(--accent)', 'Master', (p.master.fx || []).map((f) => EFFECT_DEFS[f.type]?.name).filter(Boolean).join(' › ') || 'no effects', 'master', () => ui.set({ deviceOpen: true, deviceTarget: { kind: 'master' } }), 'Master output. Click to edit the master chain');
    if (!tracks.length) { const t = svg('text', { x: tx, y: top + 20, class: 'pb-ov-sub' }); t.textContent = 'No tracks yet.'; s.appendChild(t); }
    // legend
    const lg = svg('g', { class: 'pb-ov-legend', transform: `translate(${tx} ${H - 18})` });
    const items = [['main', 'channel → master'], ['send', 'send (width = amount)'], ['key', 'sidechain key']];
    items.forEach(([k, label], i) => {
      const g = svg('g', { transform: `translate(${i * 190} 0)` });
      g.append(svg('path', { d: 'M0 -4 L28 -4', class: k === 'key' ? 'pb-ov-key' : `pb-ov-wire ${k}`, style: '--cc: var(--text-3); stroke-width: 3px' }));
      const t = svg('text', { x: 36, y: 0, class: 'pb-ov-sub' }); t.textContent = label;
      g.appendChild(t);
      lg.appendChild(g);
    });
    s.appendChild(lg);
    canvas.appendChild(s);
  }

  // ---------------------------------------------------------------- render orchestration
  function render(force = false) {
    if (!visible) return;
    const p = P();
    if (!curTrack(p) && p.tracks.length) { actions.selectTrack(p.tracks[0].id); return; }
    const t = curTrack(p);
    if (sel?.type === 'cable' && !t?.patch?.cables?.some((c) => c.id === sel.id)) sel = null;
    if (sel?.type === 'node' && !t?.patch?.nodes?.some((n) => n.id === sel.id)) sel = null;
    renderModeSeg();
    renderTrackList(p);
    renderToolbar(p, t);
    renderPalette();
    renderStage(force);
  }

  enableBtn.addEventListener('click', () => enablePatch(!isPatchActive(curTrack())));

  app.subscribe((r) => {
    if (!visible) return;
    if (r.project || 'selectedTrackId' in r.ui || 'theme' in r.ui) render();
  });

  const ro = new ResizeObserver(() => { if (visible) render(); });
  ro.observe(stage);

  // keyboard: Delete / Backspace remove the selection, Escape clears it (capture phase so
  // the global shortcuts don't see keys we handle)
  window.addEventListener('keydown', (e) => {
    if (!visible || isTyping(e) || mode !== 'patch') return;
    if (document.querySelector('.modal-backdrop, .ctx-menu')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      if (removeSelected()) { e.preventDefault(); e.stopImmediatePropagation(); }
    } else if (e.key === 'Escape' && (sel || dragCable)) {
      sel = null;
      e.preventDefault();
      e.stopImmediatePropagation();
      render();
    }
  }, true);

  return {
    el,
    show() { visible = true; render(true); },
    hide() { visible = false; hideOverlay(); },
    /** for automation / tests */
    setMode(m) { mode = m; render(true); },
  };
}
