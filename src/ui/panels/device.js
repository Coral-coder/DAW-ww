// Device panel (bottom): the selected track's instrument + insert-effect chain, or a
// bus / the master chain (ui.deviceTarget). The DOM is rebuilt only when the chain
// *structure* changes (target, instrument type, preset, fx list); parameter edits
// update the existing controls in place, so knob drags stay smooth.
import { h, icon, startDrag, fitCanvas, clear } from '../dom.js';
import { knob, select, toggle, button, iconButton, paramPanel, contextMenu, promptText, confirmDialog, formatValue } from '../components.js';
import { createEffect, DRUM_PADS } from '../../core/model.js';
import { clamp, deepClone } from '../../core/util.js';
import { EFFECT_DEFS, EFFECT_CATEGORIES, INSTRUMENT_DEFS, PRESETS, DRUM_KITS, resolveEffectParams } from '../../audio/index.js';

// ============================================================================ effect presets
/** Small curated starting points per effect type (merged over the defaults). */
export const EFFECT_PRESETS = {
  reverb: {
    'Small Room': { decay: 0.7, size: 0.25, predelay: 0.005, damping: 0.6, mix: 0.18 },
    'Plate': { decay: 1.6, size: 0.5, predelay: 0.015, damping: 0.3, mix: 0.25 },
    'Hall': { decay: 3.2, size: 0.8, predelay: 0.025, damping: 0.45, mix: 0.3 },
    'Huge': { decay: 8, size: 1, predelay: 0.04, damping: 0.35, mix: 0.45 },
    'Send (100% wet)': { mix: 1 },
  },
  delay: {
    'Slapback': { sync: false, time: 0.09, feedback: 0.1, mix: 0.25 },
    '1/8 dotted ping-pong': { sync: true, division: '1/8D', feedback: 0.4, pingpong: true, mix: 0.3 },
    '1/4 dub': { sync: true, division: '1/4', feedback: 0.62, highcut: 2800, lowcut: 250, mix: 0.35 },
    '1/16 shimmer': { sync: true, division: '1/16', feedback: 0.5, pingpong: true, mix: 0.2 },
  },
  compressor: {
    'Gentle glue': { threshold: -14, ratio: 2, attack: 0.03, release: 0.2, makeup: 2 },
    'Punchy drums': { threshold: -20, ratio: 4, attack: 0.012, release: 0.08, makeup: 5 },
    'Vocal leveler': { threshold: -22, ratio: 3.5, attack: 0.005, release: 0.15, makeup: 6 },
    'Squash (parallel)': { threshold: -35, ratio: 12, attack: 0.002, release: 0.1, makeup: 12, mix: 0.4 },
  },
  limiter: { 'Safe': { gain: 0, threshold: -1, ceiling: -0.3 }, 'Loud': { gain: 6, threshold: -3, ceiling: -0.3 }, 'Club': { gain: 9, threshold: -4, release: 0.05, ceiling: -0.2 } },
  distortion: { 'Warm': { type: 'soft', drive: 8, tone: 6000, mix: 0.6 }, 'Crunch': { type: 'tube', drive: 20, tone: 5000 }, 'Destroy': { type: 'fuzz', drive: 40, tone: 3500, output: -8 }, 'Fold': { type: 'foldback', drive: 24, mix: 0.7 } },
  saturator: { 'Subtle': { type: 'warm', drive: 3 }, 'Warm': { type: 'warm', drive: 8 }, 'Hot tube': { type: 'tube', drive: 15, output: -4 } },
  tape: { 'Subtle': { drive: 2, wow: 0.1, flutter: 0.05 }, 'Cassette': { drive: 6, tone: 6000, wow: 0.4, flutter: 0.3 }, 'Warped': { drive: 8, tone: 4500, wow: 0.9, wowRate: 0.4, flutter: 0.5 } },
  bitcrusher: { '12-bit sampler': { bits: 12, downsample: 2, mix: 1 }, '8-bit': { bits: 8, downsample: 4, mix: 1 }, 'Destroyed': { bits: 4, downsample: 12, mix: 0.8 } },
  chorus: { 'Subtle': { depth: 0.3, mix: 0.3 }, 'Wide': { depth: 0.6, mix: 0.5, spread: 1 }, 'Huge': { depth: 0.9, rate: 0.4, mix: 0.6 } },
  flanger: { 'Jet': { depth: 0.8, feedback: 0.7, rate: 0.15 }, 'Metallic': { depth: 0.5, feedback: -0.85, rate: 0.5 } },
  phaser: { 'Slow swirl': { rate: 0.2, depth: 2.5, stages: 6 }, 'Funky': { sync: true, division: '1/4', depth: 3, feedback: 0.6 } },
  filter: {
    'Wobble 1/8': { type: 'lowpass', cutoff: 600, resonance: 6, depth: 3, sync: true, division: '1/8' },
    'Slow sweep': { type: 'lowpass', cutoff: 900, resonance: 4, depth: 2.5, sync: true, division: '2/1' },
    'Telephone': { type: 'bandpass', cutoff: 1500, resonance: 2, depth: 0 },
    'Hi-pass build': { type: 'highpass', cutoff: 300, resonance: 3, depth: 0 },
  },
  eq3: { 'Smile': { low: 4, mid: -3, high: 4 }, 'Warm': { low: 2, high: -3 }, 'Telephone': { low: -24, mid: 6, high: -24 }, 'Cut lows': { low: -18 } },
  tremolo: { 'Gentle 1/8': { sync: true, division: '1/8', depth: 0.4 }, 'Chop 1/16': { sync: true, division: '1/16', depth: 1, shape: 'square' }, 'Stereo': { stereo: true, depth: 0.6 } },
  autopan: { 'Subtle': { depth: 0.4, sync: true, division: '1/2' }, 'Wide 1/4': { depth: 1, sync: true, division: '1/4' } },
  widener: { 'Subtle': { width: 1.2 }, 'Wide': { width: 1.6, monoBelow: 150 }, 'Huge': { width: 2, monoBelow: 200 }, 'Mono': { width: 0 } },
  pump: { 'Classic 1/4': { division: '1/4', depth: 0.8, shape: 'classic' }, 'Gentle': { division: '1/4', depth: 0.4, shape: 'smooth' }, 'Hard 1/8': { division: '1/8', depth: 1, shape: 'hard' } },
  gate: { 'Tight': { threshold: -30, release: 0.04 }, 'Chop': { threshold: -20, range: -80, release: 0.02 } },
  utility: { 'Mono': { mono: true }, '-6 dB': { gain: -6 }, 'Phase flip': { invert: true } },
};

const CAT_ICONS = { 'EQ & Filter': 'sliders', Dynamics: 'volume', Distortion: 'sparkles', 'Delay & Reverb': 'layers', Modulation: 'wave', Stereo: 'headphones', Utility: 'wand' };

/** Open the grouped "add effect" menu at pos; calls onPick(type, params). Shared with the mixer. */
export function showEffectMenu(pos, onPick) {
  const types = Object.keys(EFFECT_DEFS || {});
  const cats = [...new Set([...(EFFECT_CATEGORIES || []), ...types.map((t) => EFFECT_DEFS[t].category || 'Other')])]
    .filter((c) => types.some((t) => (EFFECT_DEFS[t].category || 'Other') === c));
  const titles = {};
  const items = [{ header: 'Add effect' }];
  for (const c of cats) {
    items.push({
      label: c, icon: CAT_ICONS[c] || 'sliders',
      submenu: types.filter((t) => (EFFECT_DEFS[t].category || 'Other') === c).map((t) => {
        titles[EFFECT_DEFS[t].name] = EFFECT_DEFS[t].description || '';
        return { label: EFFECT_DEFS[t].name, onClick: () => onPick(t, {}) };
      }),
    });
  }
  const withPresets = types.filter((t) => EFFECT_PRESETS[t]);
  if (withPresets.length) {
    items.push('-', {
      label: 'From preset', icon: 'sparkles',
      submenu: withPresets.map((t) => ({
        label: `${EFFECT_DEFS[t].name} `,
        submenu: Object.entries(EFFECT_PRESETS[t]).map(([n, params]) => ({ label: n, onClick: () => onPick(t, { ...params }) })),
      })),
    });
  }
  const menu = contextMenu({ clientX: pos.clientX, clientY: pos.clientY, preventDefault() {} }, items);
  for (const it of menu.querySelectorAll('.ctx-item')) {
    const lbl = it.querySelector(':scope > .ctx-label')?.textContent;
    if (lbl && titles[lbl]) it.title = titles[lbl];
  }
  return menu;
}

// ============================================================================ helpers
const USER_PRESET_KEY = 'heroic-user-presets';
function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(USER_PRESET_KEY) || '{}') || {}; } catch { return {}; }
}
function saveUserPresets(all) {
  try { localStorage.setItem(USER_PRESET_KEY, JSON.stringify(all)); return true; } catch { return false; }
}

const instDefs = (type) => INSTRUMENT_DEFS?.[type] || null;
/** Defs that the generic param panel can render (sample pickers / kit are handled by custom UI). */
const panelDefs = (defs, skip = []) => (defs || []).filter((d) => d.type !== 'sample' && !skip.includes(d.key) && !skip.includes(d.section));

function defaultsOf(defs) {
  const o = {};
  for (const d of defs || []) o[d.key] = d.default;
  return o;
}

function setCtl(c, v) {
  if (!c) return;
  if (c.setValue) { c.setValue(v); return; }
  const inner = c.querySelector('select, button.toggle');
  inner?.setValue?.(v);
}

const fmtTime = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const sameVal = (a, b) => a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

// Values used by the "dice" button: musical ranges per key (number keys only).
const RANDOM_RANGES = {
  cutoff: [250, 9000, 'log'], resonance: [0, 0.65], fEnvAmount: [-1, 4.5], fAttack: [0.001, 0.2], fDecay: [0.05, 1.2], fSustain: [0, 0.8], fRelease: [0.05, 1],
  attack: [0.001, 0.25], decay: [0.05, 1.5], sustain: [0.2, 1], release: [0.05, 1.2],
  osc1Level: [0.5, 1], osc2Level: [0, 0.8], osc3Level: [0, 0.6], osc1Octave: [-1, 0, 'int'], osc2Octave: [-1, 1, 'int'], osc3Octave: [-2, 0, 'int'],
  osc1Fine: [-8, 8], osc2Fine: [-15, 15], osc3Fine: [-10, 10], subLevel: [0, 0.6], noiseLevel: [0, 0.12],
  unison: [1, 5, 'int'], unisonDetune: [5, 35], unisonSpread: [0.2, 1], superDetune: [0.1, 0.6],
  lfo1Depth: [0, 0.3], lfo2Depth: [0, 0.3], lfo1Rate: [0.1, 8, 'log'], lfo2Rate: [0.05, 4, 'log'], drive: [0, 0.35], glide: [0, 0.15],
  feedback: [0, 0.5], vibDepth: [0, 0.3],
  pitch: [-3, 3], tone: [-0.5, 0.5],
  percDecay: [0.1, 0.8], percLevel: [0.3, 0.9], click: [0, 0.6], rotaryDepth: [0.3, 1],
};
const RANDOM_SKIP = new Set(['gain', 'polyphony', 'transpose', 'bendRange', 'rootNote', 'kit', 'sampleId', 'start', 'end', 'loopStart', 'loopEnd', 'slices', 'toneCut', 'tune', 'fine', 'velToAmp', 'velSens', 'keyScale', 'pitchEnvAmt']);
const RANDOM_ENUMS = /Wave$|^algorithm$|^vibrato$|^percHarmonic$/;
const OP_RATIOS = [0.5, 1, 1, 1, 2, 2, 3, 4, 5, 7];

// Hammond drawbar colours: brown (sub), white (octaves), black (non-octave harmonics)
const DRAWBAR_COLORS = ['#8b4a2b', '#8b4a2b', '#f2f2f2', '#f2f2f2', '#222', '#f2f2f2', '#222', '#222', '#f2f2f2'];

// ============================================================================ panel
export function createDevicePanel(app) {
  const { store, ui, engine, actions } = app;

  let resolveFn = null;
  import('../../audio/instruments.js').then((m) => { resolveFn = m.resolveInstrument || null; lastSig = ''; render(); }).catch(() => {});

  // UI-only state
  const collapsed = new Set(); // card keys
  const sectionsOpen = {}; // `${scope}:${section}` -> bool
  const selectedPad = new Map(); // trackId -> pad key
  const lastUserPreset = new Map(); // trackId -> user preset id (for the selector)
  let lastSig = '';
  let cards = []; // [{ key, el, update(ctx) }]
  let header = null; // { update(ctx) }
  let grEls = []; // [{ fxId, el }] gain-reduction meters
  let pendingFocus = null;

  // ---- skeleton
  const resizer = h('div.device-resizer', { title: 'Drag to resize the device panel (double-click to toggle)' });
  const headerHost = h('div.device-header');
  const chain = h('div.device-chain');
  const bodyEl = h('div.device-body', chain);
  const el = h('div.device-panel', resizer, headerHost, bodyEl);

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const h0 = ui.get('deviceOpen') ? el.getBoundingClientRect().height : 0;
    if (!ui.get('deviceOpen')) ui.set({ deviceOpen: true });
    let hNow = h0;
    document.body.classList.add('dv-resizing');
    startDrag(e, (_dx, dy) => {
      hNow = clamp(h0 - dy, 120, window.innerHeight * 0.7);
      el.style.height = hNow + 'px';
    }, () => {
      document.body.classList.remove('dv-resizing');
      if (Math.abs(hNow - h0) > 1) ui.set({ deviceHeight: Math.round(hNow) });
    });
  });
  resizer.addEventListener('dblclick', () => ui.set({ deviceOpen: !ui.get('deviceOpen') }));

  function applyHeight() {
    const open = ui.get('deviceOpen');
    el.classList.toggle('closed', !open);
    el.style.height = open ? clamp(ui.get('deviceHeight') || 260, 120, Math.max(120, window.innerHeight * 0.7)) + 'px' : '';
  }
  window.addEventListener('resize', () => { if (ui.get('deviceOpen') && el.getBoundingClientRect().height > window.innerHeight * 0.7) applyHeight(); });

  // horizontal wheel scrolling of the chain when hovering empty areas
  chain.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.target.closest('.knob, .dv-card-body, select, .dv-wave, .dv-drawbars')) chain.scrollLeft += e.deltaY;
  }, { passive: true });

  // ---------------------------------------------------------------- target resolution
  function getTarget(p) {
    const dt = ui.get('deviceTarget');
    if (dt?.kind === 'bus') {
      const b = p.buses.find((x) => x.id === dt.id);
      if (b) return { kind: 'bus', id: b.id, name: b.name, color: 'var(--accent-2)', fx: b.fx || [], owner: (pp) => pp.buses.find((x) => x.id === b.id), bus: b };
    }
    if (dt?.kind === 'master') return { kind: 'master', id: 'master', name: 'Master', color: 'var(--accent)', fx: p.master.fx || [], owner: (pp) => pp.master, master: p.master };
    const t = p.tracks.find((x) => x.id === ui.get('selectedTrackId'));
    if (t) return { kind: 'track', id: t.id, name: t.name, color: t.color, fx: t.fx || [], owner: (pp) => pp.tracks.find((x) => x.id === t.id), track: t };
    return null;
  }

  function resolveInstrumentParams(ins) {
    if (!ins) return {};
    if (resolveFn) {
      try {
        const r = resolveFn(ins);
        if (r && r.params) return r.params;
      } catch { /* fall back */ }
    }
    const defs = instDefs(ins.type);
    const base = defaultsOf(defs?.params);
    if (ins.type === 'drums') base.pads = {};
    let pre = {};
    if (ins.type === 'drums') { if (DRUM_KITS?.[ins.preset]) pre = { kit: ins.preset }; } else pre = PRESETS?.[ins.preset]?.instrument?.params || {};
    const out = { ...base, ...deepClone(pre), ...deepClone(ins.params || {}) };
    if (ins.type === 'drums') out.pads = { ...(pre.pads || {}), ...(ins.params?.pads || {}) };
    return out;
  }

  // ---------------------------------------------------------------- render orchestration
  const fxSig = (fx) => fx.map((f) => `${f.id}:${f.type}:${f.enabled ? 1 : 0}`).join(',');
  function signature(p, tgt) {
    if (!tgt) return `none:${p.tracks.length ? 1 : 0}`;
    const t = tgt.track;
    return JSON.stringify([
      tgt.kind, tgt.id, tgt.name, tgt.color, fxSig(tgt.fx),
      t ? [t.type, t.instrument?.type, t.instrument?.preset] : null,
      [...collapsed].join(','),
      ui.get('deviceOpen'),
    ]);
  }

  function render(force = false) {
    const p = store.get();
    const tgt = getTarget(p);
    const sig = signature(p, tgt);
    if (force || sig !== lastSig) {
      lastSig = sig;
      rebuild(p, tgt);
    } else {
      const ctx = makeCtx(p, tgt);
      header?.update(ctx);
      for (const c of cards) c.update?.(ctx);
    }
    if (pendingFocus) focusCard(pendingFocus);
  }

  function makeCtx(p, tgt) {
    const ins = tgt?.track?.instrument || null;
    return { p, tgt, ins, resolved: ins ? resolveInstrumentParams(ins) : null };
  }

  function rebuild(p, tgt) {
    const scroll = chain.scrollLeft;
    clear(headerHost);
    clear(chain);
    cards = [];
    grEls = [];
    const ctx = makeCtx(p, tgt);
    header = buildHeader(ctx);
    headerHost.appendChild(header.el);
    header.update(ctx);
    if (!tgt) {
      chain.appendChild(h('div.dv-empty',
        icon('sliders', 26),
        h('h3', p.tracks.length ? 'Select a track to edit its instrument and effects' : 'No tracks yet'),
        h('p', p.tracks.length ? 'Click a track name in the arrangement, mixer or step rack. Its instrument and insert effects appear here as a device chain.' : 'Add a track to start shaping its sound here: instrument parameters, effects, presets and more.'),
        button('Add track', (e) => contextMenu(e, actions.addTrackMenuItems()), { icon: 'plus', primary: true })));
      return;
    }
    // first card: instrument / info
    const first = tgt.kind === 'track' ? (tgt.track.type === 'instrument' ? instrumentCard(ctx) : tgt.track.type === 'code' ? codeCard(ctx) : audioCard(ctx)) : busInfoCard(ctx);
    if (first) addCard(first);
    tgt.fx.forEach((fx, i) => {
      chain.appendChild(h('div.dv-arrow', icon('chevronRight', 14)));
      addCard(effectCard(ctx, fx, i));
    });
    chain.appendChild(h('div.dv-arrow', icon('chevronRight', 14)));
    chain.appendChild(addEffectCard(tgt));
    chain.scrollLeft = scroll;
    for (const c of cards) c.update?.(ctx);
    updateGrLoop();
  }

  function addCard(c) {
    cards.push(c);
    chain.appendChild(c.el);
  }

  function focusCard(fxId) {
    const elc = chain.querySelector(`[data-fx-id="${fxId}"]`);
    pendingFocus = null;
    if (!elc) return;
    if (collapsed.has(fxId)) { collapsed.delete(fxId); render(true); return focusCard(fxId); }
    elc.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    elc.classList.remove('flash');
    void elc.offsetWidth;
    elc.classList.add('flash');
  }

  // ---------------------------------------------------------------- edits
  const editTarget = (tgt, label, fn, opts) => store.transact(label, (pp) => { const o = tgt.owner(pp); if (o) fn(o, pp); }, opts);
  const editIns = (tgt, label, fn, opts) => editTarget(tgt, label, (t) => { if (t.instrument) { t.instrument.params = t.instrument.params || {}; fn(t.instrument, t); } }, opts);

  function addEffect(tgt, type, params = {}, index = null) {
    const fx = createEffect(type, params);
    editTarget(tgt, `Add ${EFFECT_DEFS[type]?.name || type}`, (o) => {
      if (index == null) o.fx.push(fx); else o.fx.splice(index, 0, fx);
    });
    pendingFocus = fx.id;
    return fx;
  }
  function moveEffect(tgt, fxId, toIndex) {
    editTarget(tgt, 'Reorder effects', (o) => {
      const i = o.fx.findIndex((x) => x.id === fxId);
      if (i < 0) return;
      const [f] = o.fx.splice(i, 1);
      o.fx.splice(clamp(toIndex > i ? toIndex - 1 : toIndex, 0, o.fx.length), 0, f);
    });
  }

  // ---------------------------------------------------------------- header
  function presetOptions(ins) {
    const opts = [];
    if (ins.type === 'drums') {
      for (const [id, k] of Object.entries(DRUM_KITS || {})) opts.push({ value: id, label: k.name, group: 'Kits' });
    } else {
      opts.push({ value: '', label: '— Init (no preset) —' });
      const entries = Object.entries(PRESETS || {}).filter(([, pr]) => pr.instrument?.type === ins.type);
      entries.sort((a, b) => String(a[1].category).localeCompare(String(b[1].category)) || a[1].name.localeCompare(b[1].name));
      for (const [id, pr] of entries) opts.push({ value: id, label: pr.name, group: pr.category || 'Presets' });
    }
    const user = Object.entries(loadUserPresets()).filter(([, u]) => u.type === ins.type);
    for (const [id, u] of user) opts.push({ value: 'user:' + id, label: u.name, group: 'User' });
    return opts;
  }

  function buildHeader(ctx) {
    const { tgt, ins } = ctx;
    const open = ui.get('deviceOpen');
    const collapseBtn = iconButton(open ? 'chevronDown' : 'chevronRight', () => ui.set({ deviceOpen: !ui.get('deviceOpen') }), open ? 'Collapse the device panel' : 'Expand the device panel', 'dv-collapse');
    const parts = [collapseBtn];
    if (!tgt) {
      parts.push(h('span.dv-title.muted', 'Devices'), h('span.dv-hint', 'No track selected'));
      return { el: h('div.dv-header-row', parts), update() {} };
    }
    const nameEl = h('span.dv-title', { title: tgt.kind === 'track' ? `${tgt.name} — double-click to rename` : tgt.name }, tgt.name);
    if (tgt.kind === 'track') nameEl.addEventListener('dblclick', () => actions.renameTrack(tgt.id));
    parts.push(h('span.dv-swatch', { style: { background: tgt.color } }), nameEl);

    let badge = '';
    if (tgt.kind === 'bus') badge = 'Return bus';
    else if (tgt.kind === 'master') badge = 'Master';
    else if (tgt.track.type === 'code') badge = 'Code track';
    else if (tgt.track.type === 'audio') badge = 'Audio track';
    else badge = instDefs(ins.type)?.name || ins.type;
    parts.push(h('span.dv-badge', { title: 'Device type' }, badge));
    if (tgt.kind !== 'track') {
      const back = button('Back to track', () => ui.set({ deviceTarget: null }), { icon: 'chevronRight', cls: 'small', title: 'Show the selected track’s devices again' });
      parts.push(back);
    }

    let presetSel = null, modDot = null;
    if (ins) {
      const opts = presetOptions(ins);
      const curVal = () => {
        const tr = store.get().tracks.find((x) => x.id === tgt.id);
        const i2 = tr?.instrument || ins;
        if (i2.type === 'drums') return i2.params?.kit || i2.preset || '808';
        if (i2.preset) return i2.preset;
        const u = lastUserPreset.get(tgt.id);
        return u && opts.some((o) => o.value === 'user:' + u) ? 'user:' + u : '';
      };
      if (!opts.some((o) => o.value === curVal())) opts.unshift({ value: curVal(), label: ins.preset ? `${ins.preset} (missing)` : '— Custom —' });
      presetSel = select({ options: opts, value: curVal(), cls: 'dv-preset', title: ins.type === 'drums' ? 'Drum kit — choose the sound set for all 16 pads' : 'Preset — load a sound (your edits override the preset until you choose another)', onChange: (v) => applyPreset(tgt, ins, v) });
      const step = (dir) => {
        const vals = opts.map((o) => o.value).filter((v) => v !== '' || ins.type !== 'drums');
        const i = vals.indexOf(presetSel.value);
        const nv = vals[(i + dir + vals.length) % vals.length];
        presetSel.value = nv;
        applyPreset(tgt, ins, nv);
      };
      modDot = h('button.dv-mod', { type: 'button', title: 'Edited — your changes override the preset. Click to revert to the preset.' }, '● edited');
      modDot.addEventListener('click', () => editIns(tgt, 'Revert to preset', (i) => { i.params = i.type === 'drums' ? { kit: i.params.kit || i.preset } : i.type === 'sampler' && i.params.sampleId ? { sampleId: i.params.sampleId } : {}; }));
      parts.push(
        h('div.dv-preset-group',
          iconButton('chevronRight', () => step(-1), 'Previous preset', 'dv-prev'),
          presetSel,
          iconButton('chevronRight', () => step(1), 'Next preset', 'dv-next')),
        modDot,
        iconButton('dice', (e) => randomize(tgt, ins, e.shiftKey ? 0.9 : 0.4), 'Randomize — mutate the main parameters within musical ranges (Shift-click: wilder). Ctrl+Z undoes.'),
        iconButton('save', () => saveUserPreset(tgt), 'Save these settings as a user preset (stored in this browser)'),
        iconButton('menu', (e) => contextMenu(e, instrumentMenu(tgt, ins)), 'More: init, swap instrument, manage user presets'),
      );
    }
    parts.push(h('div.spacer'));
    if (tgt.kind === 'track') {
      const t = tgt.track;
      if (t.type === 'instrument') {
        parts.push(
          button('Piano roll', () => { actions.selectTrack(t.id); app.showView('piano'); }, { icon: 'piano', cls: 'small', title: 'Edit this track’s notes in the piano roll (4)' }),
          button('Step rack', () => { actions.selectTrack(t.id); app.showView('rack'); }, { icon: 'grid', cls: 'small', title: 'Program this track in the step sequencer (3)' }),
        );
      } else if (t.type === 'code') {
        parts.push(button('Code editor', () => { actions.selectTrack(t.id); app.showView('code'); }, { icon: 'code', cls: 'small', title: 'Open the live-code editor (6)' }));
      }
    }
    parts.push(button('Effect', (e) => showEffectMenu(e, (type, params) => addEffect(tgt, type, params)), { icon: 'plus', cls: 'small', title: 'Add an insert effect to the end of the chain' }));
    const el = h('div.dv-header-row', parts);
    return {
      el,
      update(c) {
        if (!c.ins || !presetSel) return;
        const tr = c.tgt.track;
        const edited = tr.instrument.params && Object.keys(tr.instrument.params).some((k) => (k !== 'pads' && k !== 'kit' && k !== 'sampleId') || (k === 'pads' && Object.keys(tr.instrument.params.pads || {}).length));
        modDot.classList.toggle('hidden', !edited || (!tr.instrument.preset && !lastUserPreset.get(tr.id)));
        nameEl.textContent = c.tgt.name;
      },
    };
  }

  function applyPreset(tgt, ins, v) {
    if (v.startsWith('user:')) {
      const id = v.slice(5);
      const u = loadUserPresets()[id];
      if (!u) return;
      lastUserPreset.set(tgt.id, id);
      editTarget(tgt, `Preset: ${u.name}`, (t) => { t.instrument = { type: u.type, preset: u.preset ?? null, params: deepClone(u.params || {}) }; });
      return;
    }
    lastUserPreset.delete(tgt.id);
    if (ins.type === 'drums') {
      editTarget(tgt, `Kit: ${DRUM_KITS[v]?.name || v}`, (t) => {
        const pads = t.instrument.params?.pads;
        // preset = kit id (contract) + params.kit so the drum engine picks it up either way
        const params = { ...(t.instrument.params || {}), kit: v };
        t.instrument = { type: 'drums', preset: v, params };
        if (pads) t.instrument.params.pads = pads; // keep per-pad samples & tweaks
      });
      return;
    }
    if (!v) { editTarget(tgt, 'Init instrument', (t) => { t.instrument = { type: ins.type, preset: null, params: {} }; }); return; }
    const pr = PRESETS[v];
    if (!pr) return;
    editTarget(tgt, `Preset: ${pr.name}`, (t) => {
      const keepSample = t.instrument?.type === 'sampler' && pr.instrument.type === 'sampler' ? t.instrument.params?.sampleId : null;
      t.instrument = { type: pr.instrument.type, preset: v, params: keepSample ? { sampleId: keepSample } : {} };
    });
  }

  function instrumentMenu(tgt, ins) {
    const user = Object.entries(loadUserPresets()).filter(([, u]) => u.type === ins.type);
    const types = Object.entries(INSTRUMENT_DEFS || {});
    return [
      { header: instDefs(ins.type)?.name || 'Instrument' },
      { label: 'Init (reset all parameters)', icon: 'undo', onClick: () => editTarget(tgt, 'Init instrument', (t) => {
        const kit = t.instrument.params?.kit || t.instrument.preset || '808';
        t.instrument = ins.type === 'drums' ? { type: 'drums', preset: kit, params: { kit } } : { type: ins.type, preset: null, params: {} };
      }) },
      { label: 'Revert to preset (clear my edits)', disabled: !ins.preset, onClick: () => editIns(tgt, 'Revert to preset', (i) => { i.params = i.type === 'drums' ? { kit: i.params.kit || i.preset } : i.type === 'sampler' && i.params.sampleId ? { sampleId: i.params.sampleId } : {}; }) },
      { label: 'Randomize (subtle)', icon: 'dice', onClick: () => randomize(tgt, ins, 0.25) },
      { label: 'Randomize (wild)', icon: 'dice', onClick: () => randomize(tgt, ins, 0.9) },
      '-',
      { label: 'Swap instrument', icon: 'wave', submenu: types.map(([type, d]) => ({ label: d.name, disabled: type === ins.type, onClick: () => editTarget(tgt, `Instrument: ${d.name}`, (t) => { t.instrument = type === 'drums' ? { type, preset: '808', params: { kit: '808' } } : { type, preset: null, params: {} }; }) })) },
      '-',
      { label: 'Save as user preset…', icon: 'save', onClick: () => saveUserPreset(tgt) },
      { label: 'Delete user preset', icon: 'trash', disabled: !user.length, submenu: user.length ? user.map(([id, u]) => ({ label: u.name, onClick: async () => {
        if (!(await confirmDialog('Delete user preset', `Delete “${u.name}”? This cannot be undone.`))) return;
        const all = loadUserPresets(); delete all[id]; saveUserPresets(all); render(true);
      } })) : undefined },
      { label: 'Copy settings as JSON', icon: 'copy', onClick: async () => {
        const json = JSON.stringify({ type: ins.type, params: resolveInstrumentParams(store.get().tracks.find((x) => x.id === tgt.id)?.instrument || ins) }, null, 1);
        try { await navigator.clipboard.writeText(json); app.toast?.('Instrument settings copied to the clipboard'); } catch { promptText('Instrument settings (copy)', json, { multiline: true }); }
      } },
    ];
  }

  async function saveUserPreset(tgt) {
    const t = store.get().tracks.find((x) => x.id === tgt.id);
    if (!t?.instrument) return;
    const ins = t.instrument;
    const base = ins.type === 'drums' ? DRUM_KITS[ins.preset]?.name : PRESETS[ins.preset]?.name;
    const name = await promptText('Save user preset', `${base || t.name} (mine)`);
    if (!name) return;
    const all = loadUserPresets();
    const id = 'u' + Date.now().toString(36);
    // store preset reference + overrides so the preset stays faithful, and a type for filtering
    all[id] = { name, type: ins.type, preset: ins.preset || null, params: deepClone(ins.params || {}), created: new Date().toISOString() };
    if (!saveUserPresets(all)) { app.toast?.('Could not save preset (browser storage unavailable)', { level: 'error' }); return; }
    lastUserPreset.set(t.id, id);
    app.toast?.(`Saved user preset “${name}”`, { level: 'success' });
    render(true);
  }

  function randomize(tgt, ins, amount = 0.4) {
    const defs = instDefs(ins.type)?.params || [];
    const cur = resolveInstrumentParams(store.get().tracks.find((x) => x.id === tgt.id)?.instrument || ins);
    const out = {};
    const rnd = Math.random;
    for (const d of defs) {
      if (RANDOM_SKIP.has(d.key) || (d.advanced && !RANDOM_RANGES[d.key])) continue;
      if (d.type === 'number') {
        let [lo, hi, mode] = RANDOM_RANGES[d.key] || [];
        if (/^op\dRatio$/.test(d.key)) { if (rnd() < amount) out[d.key] = OP_RATIOS[Math.floor(rnd() * OP_RATIOS.length)]; continue; }
        if (lo === undefined) {
          if (/^db\d$/.test(d.key)) { lo = 0; hi = 8; mode = 'int'; } else if (/^op\d(Level|Sustain)$/.test(d.key)) { lo = 0.1; hi = 1; } else if (/^op\d(Attack|Decay|Release)$/.test(d.key)) { lo = 0.002; hi = 1.5; } else continue;
        }
        const c = cur[d.key] ?? d.default;
        let target;
        if (mode === 'log' && lo > 0) target = lo * Math.pow(hi / lo, rnd());
        else target = lo + (hi - lo) * rnd();
        let v = c + (target - c) * amount * (0.5 + rnd());
        if (mode === 'int' || (d.step && d.step >= 1)) v = Math.round(v);
        v = clamp(v, d.min, d.max);
        out[d.key] = +(+v).toFixed(4);
      } else if (d.type === 'enum' && RANDOM_ENUMS.test(d.key) && rnd() < amount) {
        const ops = d.options || [];
        if (ops.length) out[d.key] = ops[Math.floor(rnd() * ops.length)].value;
      }
    }
    if (ins.type === 'synth' && (cur.osc1Level ?? 0.8) + (out.osc2Level ?? cur.osc2Level ?? 0) < 0.3) out.osc1Level = 0.8;
    editIns(tgt, 'Randomize sound', (i) => { Object.assign(i.params, out); });
    app.setStatus?.('Randomized sound — Ctrl+Z to undo, Shift-click the dice for wilder results.');
  }

  // ---------------------------------------------------------------- card shell
  function cardShell({ key, title, iconName, color, cls = '', fxId, headExtras = [], help }) {
    const isCollapsed = collapsed.has(key);
    const toggleCollapse = () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); render(true); };
    const collapseBtn = iconButton(isCollapsed ? 'chevronRight' : 'chevronDown', toggleCollapse, isCollapsed ? 'Expand device' : 'Collapse device', 'dv-card-collapse');
    const titleEl = h('span.dv-card-title', { title: help || title }, title);
    titleEl.addEventListener('dblclick', toggleCollapse);
    const head = h('div.dv-card-head', collapseBtn, iconName ? icon(iconName, 13) : null, titleEl, ...headExtras);
    const body = h('div.dv-card-body');
    const el = h(`div.dv-card${cls ? '.' + cls : ''}${isCollapsed ? '.collapsed' : ''}`, { style: color ? { '--card-color': color } : {}, dataset: fxId ? { fxId } : {} }, head, isCollapsed ? h('div.dv-folded', { title: `${title} — click to expand` }, title) : body);
    if (isCollapsed) el.querySelector('.dv-folded').addEventListener('click', toggleCollapse);
    return { el, head, body, collapsed: isCollapsed };
  }

  /** Generic param panel + in-place updater. */
  function paramsBlock(defs, values, scope, onChange) {
    const panel = paramPanel({
      defs, values, onChange,
      sectionsOpen: Object.fromEntries(defs.map((d) => d.section || 'Main').map((s) => [s, sectionsOpen[`${scope}:${s}`] ?? true])),
      onSectionToggle: (s, o) => { sectionsOpen[`${scope}:${s}`] = o; },
    });
    const last = {};
    for (const d of defs) last[d.key] = values[d.key] ?? d.default;
    return {
      el: panel,
      update(vals) {
        for (const d of defs) {
          const v = vals[d.key] ?? d.default;
          if (!sameVal(v, last[d.key])) { last[d.key] = v; setCtl(panel.controls[d.key], v); }
        }
      },
    };
  }

  // ---------------------------------------------------------------- instrument card
  function instrumentCard(ctx) {
    const { tgt, ins, resolved } = ctx;
    const def = instDefs(ins.type);
    const key = 'ins:' + tgt.id;
    const shell = cardShell({ key, title: def?.name || ins.type, iconName: ins.type === 'drums' ? 'drum' : ins.type === 'sampler' ? 'wave' : 'piano', color: tgt.color, cls: `dv-instrument.dv-ins-${ins.type}`, help: 'Instrument — generates the sound of this track' });
    if (shell.collapsed) return { el: shell.el };
    if (!def) {
      shell.body.appendChild(h('div.dv-note', `Unknown instrument type “${ins.type}”.`));
      return { el: shell.el };
    }
    const updaters = [];
    const label = (k) => def.params.find((d) => d.key === k)?.label || k;
    const onParam = (k, v) => editIns(tgt, `${def.name}: ${label(k)}`, (i) => { i.params[k] = v; }, { coalesce: true });

    let skip = [];
    if (ins.type === 'drums') skip = ['kit'];
    if (ins.type === 'organ') skip = ['Drawbars'];
    if (ins.type === 'sampler') skip = ['start', 'end', 'loopStart', 'loopEnd'];

    // instrument-specific editors
    if (ins.type === 'synth') updaters.push(synthVisuals(shell.body));
    if (ins.type === 'organ') updaters.push(drawbarEditor(shell.body, def, onParam));
    if (ins.type === 'drums') updaters.push(drumEditor(shell.body, tgt));
    if (ins.type === 'sampler') updaters.push(samplerEditor(shell.body, tgt, onParam));

    const pb = paramsBlock(panelDefs(def.params, skip), resolved, ins.type, onParam);
    shell.body.appendChild(h('div.dv-params', pb.el));
    updaters.push(pb.update);
    return {
      el: shell.el,
      update(c) {
        if (!c.ins) return;
        for (const u of updaters) u(c.resolved, c);
      },
    };
  }

  // ---- synth: oscillator preview + ADSR curves
  function synthVisuals(body) {
    const osc = h('canvas.dv-viz-canvas');
    const amp = h('canvas.dv-viz-canvas');
    const flt = h('canvas.dv-viz-canvas');
    const wrap = h('div.dv-viz',
      h('div.dv-viz-item', { title: 'Oscillator mix preview (two cycles of the summed oscillators)' }, h('span', 'Oscillators'), osc),
      h('div.dv-viz-item', { title: 'Amplitude envelope (attack, decay, sustain, release)' }, h('span', 'Amp env'), amp),
      h('div.dv-viz-item', { title: 'Filter envelope (shape × amount in octaves)' }, h('span', 'Filter env'), flt));
    body.appendChild(wrap);
    let lastKey = '';
    let vals = null;
    const draw = () => {
      if (!vals || !wrap.isConnected) return;
      drawOsc(osc, vals);
      drawEnv(amp, vals.attack, vals.decay, vals.sustain, vals.release, 1, 'var(--accent-2)');
      drawEnv(flt, vals.fAttack, vals.fDecay, vals.fSustain, vals.fRelease, clamp((vals.fEnvAmount ?? 0) / 8, -1, 1), 'var(--accent-3)');
    };
    new ResizeObserver(() => draw()).observe(wrap);
    return (r) => {
      const k = ['osc1Wave', 'osc1Level', 'osc1Octave', 'osc1Semi', 'osc1Fine', 'osc1Width', 'osc2Wave', 'osc2Level', 'osc2Octave', 'osc2Semi', 'osc2Fine', 'osc2Width', 'osc3Wave', 'osc3Level', 'osc3Octave', 'osc3Semi', 'osc3Fine', 'osc3Width', 'subLevel', 'subWave', 'subOctave', 'noiseLevel', 'attack', 'decay', 'sustain', 'release', 'fAttack', 'fDecay', 'fSustain', 'fRelease', 'fEnvAmount'].map((x) => r[x]).join('|');
      if (k === lastKey) return;
      lastKey = k;
      vals = r;
      requestAnimationFrame(draw);
    };
  }

  function waveAt(wave, ph, width = 0.5) {
    ph -= Math.floor(ph);
    switch (wave) {
      case 'saw': case 'sawtooth': return 2 * ph - 1;
      case 'supersaw': return (2 * ph - 1) * 0.5 + (2 * ((ph * 1.01) % 1) - 1) * 0.25 + (2 * ((ph * 0.99 + 0.3) % 1) - 1) * 0.25;
      case 'square': return ph < 0.5 ? 1 : -1;
      case 'pulse': return ph < width ? 1 : -1;
      case 'triangle': case 'tri': return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
      case 'sine': return Math.sin(2 * Math.PI * ph);
      default: return 0;
    }
  }

  function drawOsc(canvas, r) {
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    const N = Math.max(64, Math.floor(w));
    const ys = new Float32Array(N);
    let mx = 0;
    let seed = 7;
    const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
    for (let i = 0; i < N; i++) {
      const ph = (i / N) * 2; // two cycles
      let s = 0;
      for (let k = 1; k <= 3; k++) {
        const lvl = r[`osc${k}Level`] ?? 0;
        if (lvl <= 0) continue;
        const mult = Math.pow(2, (r[`osc${k}Octave`] || 0) + (r[`osc${k}Semi`] || 0) / 12 + (r[`osc${k}Fine`] || 0) / 1200);
        s += lvl * waveAt(r[`osc${k}Wave`] || 'saw', ph * mult, r[`osc${k}Width`] ?? 0.5);
      }
      if (r.subLevel > 0) s += r.subLevel * waveAt(r.subWave || 'sine', ph * Math.pow(2, r.subOctave ?? -1));
      if (r.noiseLevel > 0) s += r.noiseLevel * noise() * 0.6;
      ys[i] = s;
      if (Math.abs(s) > mx) mx = Math.abs(s);
    }
    const c = getComputedStyle(canvas);
    ctx.strokeStyle = c.getPropertyValue('--line').trim() || '#333';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(w, H / 2); ctx.stroke();
    ctx.strokeStyle = c.getPropertyValue('--accent').trim() || '#7c5cff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const sc = mx > 0 ? (H / 2 - 4) / mx : 0;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * w, y = H / 2 - ys[i] * sc;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  function drawEnv(canvas, a = 0.01, d = 0.3, s = 0.8, rel = 0.2, amount = 1, colorVar) {
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    const c = getComputedStyle(canvas);
    const color = colorVar.startsWith('var(') ? c.getPropertyValue(colorVar.slice(4, -1)).trim() : colorVar;
    // sqrt-compressed time so short attacks stay visible next to long releases
    const ta = Math.sqrt(Math.max(0, a)), td = Math.sqrt(Math.max(0, d)), tr = Math.sqrt(Math.max(0, rel));
    const hold = 0.35;
    const total = ta + td + hold + tr || 1;
    const pad = 3;
    const W = w - pad * 2, Hh = H - pad * 2;
    const neg = amount < 0;
    const amp = Math.max(0.08, Math.abs(amount));
    const Y = (v) => (neg ? pad + v * Hh * amp : pad + Hh - v * Hh * amp);
    const X = (t) => pad + (t / total) * W;
    const pts = [[X(0), Y(0)], [X(ta), Y(1)]];
    // exponential-ish decay curve
    const steps = 14;
    for (let i = 1; i <= steps; i++) { const f = i / steps; pts.push([X(ta + td * f), Y(s + (1 - s) * Math.pow(1 - f, 2.2))]); }
    pts.push([X(ta + td + hold), Y(s)]);
    for (let i = 1; i <= steps; i++) { const f = i / steps; pts.push([X(ta + td + hold + tr * f), Y(s * Math.pow(1 - f, 2.2))]); }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], Y(0));
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], Y(0));
    ctx.closePath();
    ctx.globalAlpha = 0.18; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
    // labels
    ctx.fillStyle = c.getPropertyValue('--text-3').trim() || '#888';
    ctx.font = '9px ' + (c.getPropertyValue('--mono').trim() || 'monospace');
    ctx.fillText(`A ${fmtTime(a)}`, pad + 2, neg ? H - 4 : 10);
    ctx.textAlign = 'right';
    ctx.fillText(`R ${fmtTime(rel)}`, w - pad - 2, neg ? H - 4 : 10);
    ctx.textAlign = 'left';
  }

  // ---- organ: drawbars
  function drawbarEditor(body, def, onParam) {
    const bars = [];
    const wrap = h('div.dv-drawbars', { title: 'Drawbars — drag a bar down to pull it out (0–8). Double-click to push in.' });
    for (let i = 1; i <= 9; i++) {
      const d = def.params.find((x) => x.key === `db${i}`);
      if (!d) continue;
      const fill = h('div.dv-db-fill', { style: { background: DRAWBAR_COLORS[i - 1] } });
      const val = h('div.dv-db-val');
      const slot = h('div.dv-db-slot', fill);
      const col = h('div.dv-db', h('div.dv-db-label', d.label), slot, val);
      let v = 0;
      const set = (nv, final) => { nv = clamp(Math.round(nv), 0, 8); if (nv === v && !final) return; v = nv; render1(); onParam(d.key, v, { final }); };
      const render1 = () => { fill.style.height = `${(v / 8) * 100}%`; val.textContent = v; };
      slot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const r = slot.getBoundingClientRect();
        set(((e.clientY - r.top) / r.height) * 8.4, false);
        startDrag(e, (_dx, _dy, ev) => set(((ev.clientY - r.top) / r.height) * 8.4, false), () => onParam(d.key, v, { final: true }));
      });
      slot.addEventListener('dblclick', () => set(0, true));
      bars.push({ key: d.key, setV: (nv) => { v = nv; render1(); } });
      wrap.appendChild(col);
    }
    body.appendChild(wrap);
    return (r) => { for (const b of bars) b.setV(r[b.key] ?? 0); };
  }

  // ---- drums: 4x4 pads + selected pad editor
  function drumEditor(body, tgt) {
    const padDefs = instDefs('drums')?.padParams || [];
    const numDefs = padDefs.filter((d) => d.type === 'number');
    const grid = h('div.dv-pads');
    const padEls = new Map();
    const editor = h('div.dv-pad-editor');
    const trackId = tgt.id;
    if (!selectedPad.has(trackId)) selectedPad.set(trackId, 'kick');
    let lastResolved = null;

    const audition = (pad, vel = 0.9) => {
      try {
        engine.noteOn(trackId, pad.pitch, vel);
        setTimeout(() => engine.noteOff(trackId, pad.pitch), 200);
      } catch (e) { console.warn(e); }
    };
    const editPad = (padKey, label, fn, opts) => editIns(tgt, label, (i) => {
      if (!i.params.pads) i.params.pads = deepClone(lastResolved?.pads || {});
      if (!i.params.pads[padKey]) i.params.pads[padKey] = {};
      fn(i.params.pads[padKey]);
    }, opts);
    const assignSample = (padKey, sampleId) => {
      const s = store.get().samples[sampleId];
      editPad(padKey, `Pad sample: ${s?.name || ''}`, (pd) => { pd.sampleId = sampleId; });
      engine.decodeSample?.(sampleId).catch(() => {});
    };
    const loadSample = async (padKey) => {
      const added = await actions.importSamples();
      if (added?.[0]) assignSample(padKey, added[0].id);
    };
    const pickSampleMenu = (e, padKey) => {
      const samples = Object.values(store.get().samples || {});
      contextMenu(e, [
        { header: 'Pad sample' },
        { label: 'Load audio file…', icon: 'upload', onClick: () => loadSample(padKey) },
        { label: 'From project', icon: 'folder', disabled: !samples.length, submenu: samples.length ? samples.map((s) => ({ label: s.name, onClick: () => assignSample(padKey, s.id) })) : undefined },
        { label: 'Clear sample (use synth voice)', icon: 'x', onClick: () => editPad(padKey, 'Clear pad sample', (pd) => { delete pd.sampleId; }) },
      ]);
    };

    for (const pad of DRUM_PADS) {
      const nm = h('span.dv-pad-name', pad.name);
      const sub = h('span.dv-pad-sub', pad.short.toUpperCase());
      const p = h('button.dv-pad', { type: 'button', title: `${pad.name} (MIDI ${pad.pitch}) — click to play & select (higher = louder). Drop an audio file or sample here to load it. Right-click for sample options.` }, nm, sub, h('span.dv-pad-flag'));
      p.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const r = p.getBoundingClientRect();
        const vel = clamp(1 - (e.clientY - r.top) / r.height, 0.25, 1);
        audition(pad, 0.4 + vel * 0.6);
        p.classList.add('hit');
        setTimeout(() => p.classList.remove('hit'), 120);
        if (selectedPad.get(trackId) !== pad.key) { selectedPad.set(trackId, pad.key); renderPadSel(); renderEditor(); }
      });
      p.addEventListener('contextmenu', (e) => { selectedPad.set(trackId, pad.key); renderPadSel(); renderEditor(); pickSampleMenu(e, pad.key); });
      p.addEventListener('dragover', (e) => { if (isSampleDrag(e)) { e.preventDefault(); p.classList.add('drop'); } });
      p.addEventListener('dragleave', () => p.classList.remove('drop'));
      p.addEventListener('drop', (e) => { p.classList.remove('drop'); handleSampleDrop(e, (id) => { selectedPad.set(trackId, pad.key); renderPadSel(); assignSample(pad.key, id); }); });
      padEls.set(pad.key, p);
      grid.appendChild(p);
    }

    const renderPadSel = () => { for (const [k, e] of padEls) e.classList.toggle('selected', k === selectedPad.get(trackId)); };
    let edCtl = {};
    let sampleLbl = null;
    let muteT = null;
    function renderEditor() {
      clear(editor);
      edCtl = {};
      const pad = DRUM_PADS.find((x) => x.key === selectedPad.get(trackId)) || DRUM_PADS[0];
      const vals = lastResolved?.pads?.[pad.key] || {};
      const knobs = numDefs.map((d) => {
        const k = knob({ def: d, value: vals[d.key] ?? d.default, size: 32, onChange: (v, { final }) => editPad(pad.key, `${pad.name}: ${d.label}`, (pd) => { pd[d.key] = v; }, { coalesce: true }) });
        edCtl[d.key] = k;
        return k;
      });
      muteT = toggle({ label: 'Mute', value: !!vals.mute, cls: 'mute', title: 'Mute this pad', onChange: (v) => editPad(pad.key, `${pad.name}: mute`, (pd) => { pd.mute = v; }) });
      sampleLbl = h('span.dv-pad-sample', { title: 'Sample loaded on this pad (otherwise the kit’s synthesized voice plays)' });
      const loadBtn = button('Load sample…', () => loadSample(pad.key), { icon: 'upload', cls: 'small', title: 'Import an audio file and play it on this pad' });
      const pickBtn = iconButton('folder', (e) => pickSampleMenu(e, pad.key), 'Pick a sample already in the project / clear');
      const clearBtn = iconButton('x', () => editPad(pad.key, 'Clear pad sample', (pd) => { delete pd.sampleId; }), 'Clear sample (back to the synthesized kit voice)', 'dv-clear-sample');
      const resetBtn = iconButton('undo', () => editIns(tgt, `Reset ${pad.name}`, (i) => { if (!i.params.pads) i.params.pads = deepClone(lastResolved?.pads || {}); delete i.params.pads[pad.key]; }), 'Reset this pad to the kit defaults');
      editor.append(
        h('div.dv-pad-ed-head', h('b', pad.name), h('span.muted', ` · MIDI ${pad.pitch}`), h('div.spacer'), muteT, resetBtn),
        h('div.dv-pad-knobs', knobs),
        h('div.dv-pad-sample-row', icon('wave', 12), sampleLbl, clearBtn, h('div.spacer'), pickBtn, loadBtn));
      updateEditorVals();
    }
    function updateEditorVals() {
      const pad = selectedPad.get(trackId);
      const vals = lastResolved?.pads?.[pad] || {};
      for (const d of numDefs) edCtl[d.key]?.setValue(vals[d.key] ?? d.default);
      muteT?.setValue(!!vals.mute);
      const s = vals.sampleId ? store.get().samples?.[vals.sampleId] : null;
      if (sampleLbl) {
        sampleLbl.textContent = s ? s.name : vals.sampleId ? 'missing sample' : 'Kit voice (synthesized)';
        sampleLbl.classList.toggle('has', !!s);
        editor.querySelector('.dv-clear-sample')?.classList.toggle('hidden', !vals.sampleId);
      }
    }
    body.appendChild(h('div.dv-drums', grid, editor));
    renderPadSel();
    let edBuilt = false;
    return (r) => {
      lastResolved = r;
      for (const pad of DRUM_PADS) {
        const pv = r.pads?.[pad.key] || {};
        const e = padEls.get(pad.key);
        e.classList.toggle('has-sample', !!pv.sampleId);
        e.classList.toggle('muted-pad', !!pv.mute);
        e.classList.toggle('edited', Object.keys(pv).some((k) => k !== 'sampleId' && k !== 'mute'));
      }
      if (!edBuilt) { edBuilt = true; renderEditor(); } else updateEditorVals();
    };
  }

  function isSampleDrag(e) {
    const t = e.dataTransfer?.types || [];
    return [...t].includes('application/x-heroic-sample') || [...t].includes('Files');
  }
  async function handleSampleDrop(e, onId) {
    e.preventDefault();
    const id = e.dataTransfer.getData('application/x-heroic-sample');
    if (id && store.get().samples[id]) { onId(id); return; }
    const files = [...(e.dataTransfer.files || [])].filter((f) => /^audio\//.test(f.type) || /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(f.name));
    if (!files.length) { app.toast?.('Drop an audio file (wav, mp3, ogg, flac…)', { level: 'warn' }); return; }
    const added = await actions.importSamples(files);
    if (added?.[0]) onId(added[0].id);
  }

  // ---- sampler: waveform with draggable start/end/loop markers
  const peakCache = new Map(); // sampleId -> {min, max (Float32Array), duration}
  function computePeaks(buf, cols = 1200) {
    const d = buf.getChannelData(0);
    const d2 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const min = new Float32Array(cols), max = new Float32Array(cols);
    const per = Math.max(1, Math.floor(d.length / cols));
    for (let c = 0; c < cols; c++) {
      let lo = 1, hi = -1;
      const s0 = c * per, s1 = Math.min(d.length, s0 + per);
      for (let i = s0; i < s1; i += 2) { const v = d2 ? (d[i] + d2[i]) * 0.5 : d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      min[c] = lo > hi ? 0 : lo; max[c] = lo > hi ? 0 : hi;
    }
    return { min, max, duration: buf.duration };
  }

  function samplerEditor(body, tgt, onParam) {
    const canvas = h('canvas.dv-wave-canvas');
    const wave = h('div.dv-wave', { title: 'Drag the markers: S = start, E = end, L = loop points (when Loop is on). Click to audition at the root note. Drop audio here to load it.' }, canvas);
    const info = h('span.dv-sample-info');
    let samples = [];
    const sampleSel = h('select.dv-sample-select', { title: 'Choose a sample from this project' });
    sampleSel.addEventListener('change', () => {
      const id = sampleSel.value;
      editIns(tgt, 'Load sample', (i) => { i.params.sampleId = id || null; });
      if (id) engine.decodeSample?.(id).catch(() => {});
    });
    const loadBtn = button('Load…', async () => { const a = await actions.importSamples(); if (a?.[0]) editIns(tgt, 'Load sample', (i) => { i.params.sampleId = a[0].id; }); }, { icon: 'upload', cls: 'small', title: 'Import an audio file into the sampler' });
    const playBtn = iconButton('play', () => { const id = vals?.sampleId; if (id) engine.auditionSample?.(id); }, 'Audition the raw sample');
    const sliceBtns = [0, 4, 8, 16].map((n) => {
      const b = h('button.toggle.dv-slice-btn', { type: 'button', title: n ? `Chop the sample into ${n} equal slices (one per key from the root note up)` : 'Play the whole sample, pitched across the keyboard' }, n ? String(n) : 'Off');
      b.addEventListener('click', () => onParam('slices', n, { final: true }));
      return { n, b };
    });
    const toolbar = h('div.dv-sample-bar', icon('wave', 13), sampleSel, playBtn, loadBtn, h('div.spacer'), h('span.dv-mini-label', 'Slices'), ...sliceBtns.map((x) => x.b));
    const emptyDrop = h('div.dv-drop', icon('upload', 18), h('div', 'Drop an audio file here'), h('div.muted', 'or'), button('Load sample…', () => loadBtn.click(), { primary: true, cls: 'small' }));
    const box = h('div.dv-sampler', toolbar, wave, emptyDrop, h('div.dv-sample-foot', info));
    body.appendChild(box);

    for (const t of [wave, emptyDrop]) {
      t.addEventListener('dragover', (e) => { if (isSampleDrag(e)) { e.preventDefault(); box.classList.add('drop'); } });
      t.addEventListener('dragleave', () => box.classList.remove('drop'));
      t.addEventListener('drop', (e) => { box.classList.remove('drop'); handleSampleDrop(e, (id) => editIns(tgt, 'Load sample', (i) => { i.params.sampleId = id; })); });
    }

    let vals = null;
    let peaks = null;
    let loadingId = null;
    const markers = () => {
      if (!vals) return [];
      const s = vals.start ?? 0, e = vals.end ?? 1;
      const out = [{ key: 'start', pos: s, label: 'S', cls: 'start' }, { key: 'end', pos: e, label: 'E', cls: 'end' }];
      if (vals.loop && !(vals.slices > 0)) {
        out.push({ key: 'loopStart', pos: s + (vals.loopStart ?? 0) * (e - s), label: 'L', cls: 'loop', rel: true });
        out.push({ key: 'loopEnd', pos: s + (vals.loopEnd ?? 1) * (e - s), label: 'L', cls: 'loop', rel: true });
      }
      return out;
    };
    function draw() {
      if (!wave.isConnected) return;
      const { ctx, w, h: H } = fitCanvas(canvas);
      ctx.clearRect(0, 0, w, H);
      const cs = getComputedStyle(canvas);
      const accent = cs.getPropertyValue('--card-color').trim() || cs.getPropertyValue('--accent-2').trim();
      const dim = cs.getPropertyValue('--text-3').trim();
      if (!peaks) {
        ctx.fillStyle = dim; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(loadingId ? 'Decoding…' : '', w / 2, H / 2);
        ctx.textAlign = 'left';
        return;
      }
      const s = vals.start ?? 0, e = vals.end ?? 1;
      const n = peaks.min.length;
      for (let x = 0; x < w; x++) {
        const c = Math.floor((x / w) * n);
        const f = x / w;
        ctx.fillStyle = f >= s && f <= e ? accent : dim;
        ctx.globalAlpha = f >= s && f <= e ? 0.9 : 0.35;
        const y0 = H / 2 - peaks.max[c] * (H / 2 - 2), y1 = H / 2 - peaks.min[c] * (H / 2 - 2);
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
      ctx.globalAlpha = 1;
      // shade outside the play window
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(0, 0, s * w, H);
      ctx.fillRect(e * w, 0, (1 - e) * w, H);
      // loop region
      if (vals.loop && !(vals.slices > 0)) {
        const ls = s + (vals.loopStart ?? 0) * (e - s), le = s + (vals.loopEnd ?? 1) * (e - s);
        ctx.fillStyle = 'rgba(255,181,71,.12)';
        ctx.fillRect(ls * w, 0, (le - ls) * w, H);
      }
      // slices
      const sl = Math.round(vals.slices || 0);
      if (sl > 0) {
        ctx.fillStyle = cs.getPropertyValue('--text-2').trim();
        ctx.font = '9px ' + (cs.getPropertyValue('--mono').trim() || 'monospace');
        for (let i = 0; i < sl; i++) {
          const x = (s + ((e - s) * i) / sl) * w;
          ctx.globalAlpha = 0.5; ctx.fillRect(x, 0, 1, H); ctx.globalAlpha = 0.8;
          ctx.fillText(String(i + 1), x + 2, H - 3);
        }
        ctx.globalAlpha = 1;
      }
      for (const m of markers()) {
        const x = Math.round(m.pos * w) + 0.5;
        ctx.fillStyle = m.cls === 'start' ? '#2fd17a' : m.cls === 'end' ? '#ff4d5e' : '#ffb547';
        ctx.fillRect(x - 0.5, 0, 1.5, H);
        ctx.beginPath();
        if (m.cls === 'end' || (m.cls === 'loop' && m.key === 'loopEnd')) { ctx.moveTo(x, 0); ctx.lineTo(x - 9, 0); ctx.lineTo(x, 9); }
        else { ctx.moveTo(x, 0); ctx.lineTo(x + 9, 0); ctx.lineTo(x, 9); }
        ctx.fill();
      }
    }
    new ResizeObserver(() => draw()).observe(wave);

    wave.addEventListener('pointerdown', (e) => {
      if (!peaks || e.button !== 0) return;
      const r = wave.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      let best = null, bd = 8 / r.width;
      for (const m of markers()) { const d = Math.abs(m.pos - fx); if (d < bd) { bd = d; best = m; } }
      if (!best) {
        const root = vals.rootNote ?? 60;
        const pitch = vals.slices > 0 ? root + clamp(Math.floor(((fx - (vals.start ?? 0)) / ((vals.end ?? 1) - (vals.start ?? 0))) * vals.slices), 0, vals.slices - 1) : root;
        engine.noteOn(tgt.id, pitch, 0.9);
        setTimeout(() => engine.noteOff(tgt.id, pitch), 450);
        return;
      }
      e.preventDefault();
      wave.classList.add('dragging');
      const move = (ev) => {
        let f = clamp((ev.clientX - r.left) / r.width, 0, 1);
        const s = vals.start ?? 0, en = vals.end ?? 1;
        let v;
        if (best.key === 'start') v = Math.min(f, en - 0.001);
        else if (best.key === 'end') v = Math.max(f, s + 0.001);
        else {
          v = clamp((f - s) / Math.max(0.001, en - s), 0, 1);
          if (best.key === 'loopStart') v = Math.min(v, (vals.loopEnd ?? 1) - 0.001); else v = Math.max(v, (vals.loopStart ?? 0) + 0.001);
        }
        v = +v.toFixed(4);
        vals = { ...vals, [best.key]: v };
        draw();
        onParam(best.key, v, { final: false });
      };
      startDrag(e, (_dx, _dy, ev) => move(ev), () => wave.classList.remove('dragging'));
    });

    function syncSamples() {
      const list = Object.values(store.get().samples || {});
      const sig = list.map((s) => s.id).join(',');
      if (sig !== samples.sig) {
        samples = list; samples.sig = sig;
        clear(sampleSel);
        sampleSel.appendChild(h('option', { value: '' }, list.length ? '— Choose sample —' : '— No samples in project —'));
        for (const s of list) sampleSel.appendChild(h('option', { value: s.id }, s.name));
      }
    }

    return (r) => {
      vals = r;
      syncSamples();
      sampleSel.value = r.sampleId && store.get().samples?.[r.sampleId] ? r.sampleId : '';
      for (const { n, b } of sliceBtns) b.classList.toggle('on', Math.round(r.slices || 0) === n);
      const id = r.sampleId;
      const s = id ? store.get().samples?.[id] : null;
      box.classList.toggle('empty', !s);
      if (!s) { peaks = null; info.textContent = id ? 'Sample missing from project' : 'No sample loaded'; draw(); return; }
      if (peakCache.has(id)) {
        peaks = peakCache.get(id);
      } else if (loadingId !== id) {
        peaks = null;
        loadingId = id;
        engine.decodeSample?.(id).then((buf) => { peakCache.set(id, computePeaks(buf)); loadingId = null; if (vals?.sampleId === id) { peaks = peakCache.get(id); draw(); } }).catch(() => { loadingId = null; info.textContent = 'Could not decode this sample'; });
      }
      const dur = peaks?.duration ?? s.duration ?? 0;
      const win = dur * ((r.end ?? 1) - (r.start ?? 0));
      info.textContent = `${s.name} · ${dur ? dur.toFixed(2) + ' s' : ''}${win && win < dur - 0.001 ? ` (window ${win.toFixed(2)} s)` : ''} · root ${noteLabel(r.rootNote ?? 60)}${r.slices > 0 ? ` · ${r.slices} slices from ${noteLabel(r.rootNote ?? 60)}` : ''}${r.loop ? ' · looping' : ''}`;
      draw();
    };
  }

  const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteLabel = (m) => `${NN[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

  // ---------------------------------------------------------------- code / audio / bus info cards
  function codeCard(ctx) {
    const { tgt } = ctx;
    const shell = cardShell({ key: 'code:' + tgt.id, title: 'Live code', iconName: 'code', color: tgt.color, cls: 'dv-info', help: 'This track is played by Strudel-style code' });
    if (shell.collapsed) return { el: shell.el };
    const pre = h('pre.dv-code');
    const status = h('div.dv-code-status');
    shell.body.append(pre, status, h('div.row',
      button('Open code editor', () => { actions.selectTrack(tgt.id); app.showView('code'); }, { icon: 'code', primary: true, cls: 'small' }),
      button('Render to tracks', () => actions.renderCodeToTracks?.(tgt.id), { icon: 'layers', cls: 'small', title: 'Convert the code’s patterns into editable note tracks' })));
    return {
      el: shell.el,
      update(c) {
        const code = c.tgt.track.code || '';
        const lines = code.split('\n');
        pre.textContent = lines.slice(0, 9).join('\n') + (lines.length > 9 ? `\n… (${lines.length - 9} more lines)` : '');
        const st = engine.getCodeStatus?.(c.tgt.id);
        status.textContent = st ? (st.ok ? `✓ running${st.cps ? ` · ${(st.cps * 60 * 4).toFixed(0)} BPM-equivalent` : ''}` : `⚠ ${st.error || 'error'}`) : 'Press play to hear it. Insert effects on the right process its output.';
        status.classList.toggle('err', !!st && !st.ok);
      },
    };
  }

  function audioCard(ctx) {
    const { tgt } = ctx;
    const shell = cardShell({ key: 'audio:' + tgt.id, title: 'Audio track', iconName: 'wave', color: tgt.color, cls: 'dv-info', help: 'Plays audio clips from the arrangement' });
    if (shell.collapsed) return { el: shell.el };
    const stats = h('div.dv-note');
    shell.body.append(
      h('p.dv-note', 'Audio clips live on the arrangement timeline. Use the effect chain on the right to process them.'),
      stats,
      h('div.row.wrap',
        button('Show arrangement', () => app.showView('arrange'), { icon: 'timeline', cls: 'small' }),
        button('Import audio…', async () => { const a = await actions.importSamples(); if (a?.[0]) actions.placeSample(a[0].id, { trackId: tgt.id, start: 0 }); }, { icon: 'upload', cls: 'small', title: 'Import an audio file and place it at the start of this track' })));
    return {
      el: shell.el,
      update(c) {
        const n = c.p.clips.filter((x) => x.trackId === c.tgt.id).length;
        stats.textContent = `${n} clip${n === 1 ? '' : 's'} on this track`;
      },
    };
  }

  function busInfoCard(ctx) {
    const { tgt } = ctx;
    const isBus = tgt.kind === 'bus';
    const shell = cardShell({ key: 'bus:' + tgt.id, title: isBus ? 'Return' : 'Master out', iconName: isBus ? 'layers' : 'volume', color: isBus ? 'var(--accent-2)' : 'var(--accent)', cls: 'dv-info', help: isBus ? 'Return bus — tracks feed it through their send knobs' : 'Master output — everything ends up here' });
    if (shell.collapsed) return { el: shell.el };
    const volDef = { key: 'volume', label: 'Volume', min: 0, max: 1.5, step: 0.01, default: 0.8, curve: 'exp', description: 'Output level (linear gain; 1 = 0 dB)' };
    const panDef = { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, default: 0 };
    const owner = (pp) => tgt.owner(pp);
    const vol = knob({ def: volDef, value: (isBus ? tgt.bus.volume : tgt.master.volume), size: 40, onChange: (v, { final }) => store.transact(`${tgt.name} volume`, (pp) => { owner(pp).volume = v; }, { coalesce: true }) });
    const pan = isBus ? knob({ def: panDef, value: tgt.bus.pan, size: 40, onChange: (v) => store.transact(`${tgt.name} pan`, (pp) => { owner(pp).pan = v; }, { coalesce: true }) }) : null;
    const mute = isBus ? toggle({ label: 'Mute', value: tgt.bus.mute, cls: 'mute', title: 'Mute this return', onChange: (v) => store.transact('Mute bus', (pp) => { owner(pp).mute = v; }) }) : null;
    const users = h('div.dv-note');
    shell.body.append(h('div.row', vol, pan, mute), users, h('div.row', button('Open mixer', () => app.showView('mixer'), { icon: 'mixer', cls: 'small' })));
    return {
      el: shell.el,
      update(c) {
        const o = c.tgt.kind === 'bus' ? c.tgt.bus : c.tgt.master;
        vol.setValue(o.volume);
        if (pan) pan.setValue(o.pan);
        mute?.setValue(!!o.mute);
        if (isBus) {
          const senders = c.p.tracks.filter((t) => t.sends?.[c.tgt.id] > 0);
          users.textContent = senders.length ? `Fed by: ${senders.map((t) => `${t.name} (${Math.round(t.sends[c.tgt.id] * 100)}%)`).join(', ')}` : 'No tracks send here yet — turn up a send knob in the mixer.';
        } else users.textContent = `${c.p.tracks.length} tracks and ${c.p.buses.length} returns feed the master.`;
      },
    };
  }

  // ---------------------------------------------------------------- effect card
  function effectCard(ctx, fx, index) {
    const { tgt } = ctx;
    const def = EFFECT_DEFS?.[fx.type];
    const name = def?.name || fx.type;
    const power = h(`button.dv-power${fx.enabled ? '.on' : ''}`, { type: 'button', title: fx.enabled ? 'Bypass this effect' : 'Enable this effect' }, icon('power', 12));
    power.addEventListener('click', (e) => { e.stopPropagation(); editTarget(tgt, `${fx.enabled ? 'Bypass' : 'Enable'} ${name}`, (o) => { const f = o.fx.find((x) => x.id === fx.id); if (f) f.enabled = !f.enabled; }); });
    const grip = h('span.dv-grip', { title: 'Drag to reorder' }, '⋮⋮');
    const left = iconButton('chevronRight', () => moveEffect(tgt, fx.id, index - 1), 'Move left', 'dv-move-left');
    const right = iconButton('chevronRight', () => moveEffect(tgt, fx.id, index + 2), 'Move right', 'dv-move-right');
    if (index === 0) left.disabled = true;
    if (index === tgt.fx.length - 1) right.disabled = true;
    const presets = EFFECT_PRESETS[fx.type];
    const presetBtn = presets ? h('button.dv-fx-preset', { type: 'button', title: 'Effect presets' }, 'Presets ▾') : null;
    presetBtn?.addEventListener('click', (e) => contextMenu(e, [
      { header: `${name} presets` },
      ...Object.entries(presets).map(([n, params]) => ({ label: n, onClick: () => editTarget(tgt, `${name}: ${n}`, (o) => { const f = o.fx.find((x) => x.id === fx.id); if (f) f.params = { ...params }; }) })),
      '-',
      { label: 'Reset to defaults', icon: 'undo', onClick: () => editTarget(tgt, `${name}: reset`, (o) => { const f = o.fx.find((x) => x.id === fx.id); if (f) f.params = {}; }) },
    ]));
    const gr = ['compressor', 'limiter', 'gate'].includes(fx.type) ? h('div.dv-gr', { title: 'Gain reduction' }, h('div.dv-gr-fill'), h('span.dv-gr-val')) : null;
    const remove = iconButton('x', () => editTarget(tgt, `Remove ${name}`, (o) => { o.fx = o.fx.filter((x) => x.id !== fx.id); }), 'Remove this effect', 'dv-remove');
    const shell = cardShell({ key: fx.id, fxId: fx.id, title: name, color: null, cls: `dv-fx${fx.enabled ? '' : '.bypassed'}`, help: def?.description || name, headExtras: [gr, h('div.spacer'), presetBtn, left, right, remove] });
    shell.head.insertBefore(power, shell.head.children[1]);
    shell.head.insertBefore(grip, shell.head.firstChild);
    if (gr) grEls.push({ fxId: fx.id, el: gr });

    // context menu
    shell.head.addEventListener('contextmenu', (e) => contextMenu(e, [
      { header: name },
      { label: fx.enabled ? 'Bypass' : 'Enable', icon: 'power', onClick: () => power.click() },
      { label: 'Duplicate', icon: 'copy', onClick: () => editTarget(tgt, `Duplicate ${name}`, (o) => { const i = o.fx.findIndex((x) => x.id === fx.id); if (i >= 0) o.fx.splice(i + 1, 0, createEffect(fx.type, deepClone(fx.params || {}))); }) },
      { label: 'Move left', disabled: index === 0, onClick: () => moveEffect(tgt, fx.id, index - 1) },
      { label: 'Move right', disabled: index === tgt.fx.length - 1, onClick: () => moveEffect(tgt, fx.id, index + 2) },
      { label: 'Reset to defaults', icon: 'undo', onClick: () => editTarget(tgt, `${name}: reset`, (o) => { const f = o.fx.find((x) => x.id === fx.id); if (f) f.params = {}; }) },
      '-',
      { label: 'Remove', icon: 'trash', onClick: () => remove.click() },
    ]));

    // drag to reorder (HTML5 DnD on the header)
    shell.head.draggable = true;
    shell.head.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-heroic-fx', fx.id);
      e.dataTransfer.effectAllowed = 'move';
      shell.el.classList.add('dragging');
    });
    shell.head.addEventListener('dragend', () => { shell.el.classList.remove('dragging'); chain.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
    shell.el.addEventListener('dragover', (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      if (!types.includes('application/x-heroic-fx') && !types.includes('application/x-heroic-effect')) return;
      e.preventDefault();
      const r = shell.el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      shell.el.classList.toggle('drop-after', after);
      shell.el.classList.toggle('drop-before', !after);
    });
    shell.el.addEventListener('dragleave', () => shell.el.classList.remove('drop-before', 'drop-after'));
    shell.el.addEventListener('drop', (e) => {
      const after = shell.el.classList.contains('drop-after');
      shell.el.classList.remove('drop-before', 'drop-after');
      const id = e.dataTransfer.getData('application/x-heroic-fx');
      const newType = e.dataTransfer.getData('application/x-heroic-effect');
      e.preventDefault();
      if (id) { if (id !== fx.id) moveEffect(tgt, id, index + (after ? 1 : 0)); } else if (newType && EFFECT_DEFS[newType]) addEffect(tgt, newType, {}, index + (after ? 1 : 0));
    });

    if (shell.collapsed || !def) {
      if (!def && !shell.collapsed) shell.body.appendChild(h('div.dv-note', `Unknown effect type “${fx.type}”.`));
      return { el: shell.el };
    }
    shell.body.appendChild(h('div.dv-fx-desc', { title: def.description || '' }, def.description || ''));
    const values = resolveEffectParams ? resolveEffectParams(fx) : { ...fx.params };
    const pb = paramsBlock(def.params, values, 'fx:' + fx.type, (k, v) => editTarget(tgt, `${name}: ${def.params.find((d) => d.key === k)?.label || k}`, (o) => {
      const f = o.fx.find((x) => x.id === fx.id);
      if (f) { f.params = f.params || {}; f.params[k] = v; }
    }, { coalesce: true }));
    shell.body.appendChild(h('div.dv-params', pb.el));
    return {
      el: shell.el,
      update(c) {
        const f = c.tgt.fx.find((x) => x.id === fx.id);
        if (f) pb.update(resolveEffectParams ? resolveEffectParams(f) : f.params || {});
      },
    };
  }

  function addEffectCard(tgt) {
    const b = h('button.dv-add-fx', { type: 'button', title: 'Add an insert effect (EQ, compressor, reverb, delay, distortion…)' }, icon('plus', 18), h('span', 'Add effect'));
    b.addEventListener('click', (e) => showEffectMenu(e, (type, params) => addEffect(tgt, type, params)));
    b.addEventListener('dragover', (e) => { const t = [...(e.dataTransfer?.types || [])]; if (t.includes('application/x-heroic-fx') || t.includes('application/x-heroic-effect')) { e.preventDefault(); b.classList.add('drop'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      b.classList.remove('drop');
      e.preventDefault();
      const id = e.dataTransfer.getData('application/x-heroic-fx');
      const type = e.dataTransfer.getData('application/x-heroic-effect');
      if (id) moveEffect(tgt, id, tgt.fx.length);
      else if (type && EFFECT_DEFS[type]) addEffect(tgt, type);
    });
    const quick = h('div.dv-quick');
    for (const t of ['eq8', 'compressor', 'reverb', 'delay', 'saturator']) {
      if (!EFFECT_DEFS?.[t]) continue;
      const q = h('button.dv-quick-btn', { type: 'button', title: `Add ${EFFECT_DEFS[t].name}: ${EFFECT_DEFS[t].description || ''}` }, EFFECT_DEFS[t].name);
      q.addEventListener('click', () => addEffect(tgt, t));
      quick.appendChild(q);
    }
    return h('div.dv-add-col', b, quick);
  }

  // ---------------------------------------------------------------- gain-reduction meters
  let grRaf = 0;
  let grFrame = 0;
  function updateGrLoop() {
    const want = grEls.length && ui.get('deviceOpen');
    if (want && !grRaf) grRaf = requestAnimationFrame(grTick);
    if (!want && grRaf) { cancelAnimationFrame(grRaf); grRaf = 0; }
  }
  function grTick() {
    grRaf = requestAnimationFrame(grTick);
    if (++grFrame % 4) return; // ~15 fps
    if (!grEls.length || !engine.ctx) return;
    for (const g of grEls) {
      if (!g.el.isConnected) continue;
      let db = 0;
      try { db = Math.abs(engine.getReduction?.(g.fxId) || 0); } catch { /* */ }
      g.el.firstChild.style.width = `${clamp(db / 24, 0, 1) * 100}%`;
      g.el.lastChild.textContent = db > 0.1 ? `−${db.toFixed(1)}` : '';
    }
  }

  // ---------------------------------------------------------------- subscriptions
  app.subscribe((r) => {
    if ('deviceOpen' in r.ui || 'deviceHeight' in r.ui) { applyHeight(); updateGrLoop(); }
    if ('selectedTrackId' in r.ui && !('deviceTarget' in r.ui) && ui.get('deviceTarget')) {
      // selecting a track elsewhere switches the panel back to that track
      ui.set({ deviceTarget: null });
      return;
    }
    if ('deviceFocus' in r.ui && ui.get('deviceFocus')) { pendingFocus = ui.get('deviceFocus'); ui.set({ deviceFocus: null }); }
    if (r.project || Object.keys(r.ui).length) render();
  });
  engine.on?.('samples', () => render());
  engine.on?.('code-error', () => render());
  engine.on?.('code-ok', () => render());

  applyHeight();
  render(true);
  return { el, refresh: () => render(true) };
}

// small helper for external use (e.g. browser panel showing values)
export { formatValue };
