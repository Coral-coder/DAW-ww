// Scopes panel (docked in the Mixer, like the Loudness panel): any analyzer view — oscilloscope, vectorscope, spectrum,
// spectrogram, tuner — on the master, the selected track or any track / bus, without inserting an effect. Taps the
// strip's post-insert node (src/audio/scope-tap.js; pre-fader, the same point that feeds sidechain keys) and uses the
// same drawing code as the analyzer effect cards (src/ui/scopes). The tap exists only while the panel is shown.
import { h, clear } from '../dom.js';
import { iconButton } from '../components.js';
import { EFFECT_DEFS, getEffectDefaults, resolveEffectParams } from '../../audio/effect-defs.js';
import { createNodeTap } from '../../audio/scope-tap.js';
import { mountAnalyzer, SCOPE_KINDS, loadStyles } from '../scopes/index.js';

const LS = 'daw3-scopes';
const TAB_LABEL = { oscilloscope: 'Scope', vectorscope: 'Vector', spectrum: 'Spectrum', spectrogram: 'Spectrogram', tuner: 'Tuner' };
// quick controls shown per analyzer (the rest keep their defaults / preset values)
const QUICK = {
  oscilloscope: ['trigger', 'cycles', 'time', 'channel', 'auto', 'pitch'],
  vectorscope: ['mode', 'solo', 'persistence', 'auto'],
  spectrum: ['fftSize', 'slope', 'channel', 'average', 'smoothing', 'peakHold', 'showMax'],
  spectrogram: ['view', 'direction', 'scale', 'colormap', 'speed', 'floor', 'range', 'angle'],
  tuner: ['display', 'a4', 'range', 'gate'],
};

/** The node a source id taps in the engine graph: 'master' | 'selected' | track id | bus id. */
export function scopeSourceNode(engine, sourceId, selectedTrackId) {
  const g = engine?.graph;
  if (!g) return null;
  const id = sourceId === 'selected' ? selectedTrackId : sourceId;
  if (!id || id === 'master') return g.master?.post || null;
  return g.tracks?.get(id)?.strip?.post || g.buses?.get(id)?.post || (sourceId === 'selected' ? g.master?.post : null) || null;
}

export function createScopesPanel(app, { onClose } = {}) {
  const { engine, store, ui } = app;
  loadStyles();
  let prefs = { kind: 'spectrum', source: 'selected', params: {} };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { /* */ }
  if (!SCOPE_KINDS.includes(prefs.kind)) prefs.kind = 'spectrum';
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* */ } };
  const params = (kind) => resolveEffectParams({ type: kind, params: { ...getEffectDefaults(kind), ...(prefs.params[kind] || {}) } });

  // ---- source picker
  const srcSel = h('select.sc-src', { title: 'What to analyse: the master, the selected track (follows the selection) or any track / bus — tapped after its inserts, before the fader' });
  function fillSources() {
    const p = store.get?.() || store.state || {};
    clear(srcSel);
    srcSel.append(h('option', { value: 'selected' }, 'Selected track'), h('option', { value: 'master' }, 'Master'));
    for (const t of p.tracks || []) srcSel.append(h('option', { value: t.id }, t.name || 'Track'));
    for (const b of p.buses || []) srcSel.append(h('option', { value: b.id }, `Bus: ${b.name || 'Bus'}`));
    srcSel.value = prefs.source;
    if (srcSel.value !== prefs.source) { prefs.source = 'selected'; srcSel.value = 'selected'; }
  }
  srcSel.addEventListener('pointerdown', fillSources);
  srcSel.addEventListener('focus', fillSources);
  srcSel.addEventListener('change', () => { prefs.source = srcSel.value; save(); });

  // ---- tabs + quick controls
  const tabs = h('div.sc-tabs');
  const ctl = h('div.sc-ctl');
  const body = h('div.sc-body');
  const note = h('div.sc-note');
  const el = h('div.sc-panel.hidden',
    h('div.sc-head', h('span.sc-title', 'Scopes'), srcSel, iconButton('x', () => onClose?.(), 'Close the scopes panel')),
    tabs, ctl, body, note);

  function renderTabs() {
    clear(tabs);
    for (const k of SCOPE_KINDS) {
      const b = h(`button.toggle${k === prefs.kind ? '.on' : ''}`, { type: 'button', title: EFFECT_DEFS[k]?.description || '' }, TAB_LABEL[k] || k);
      b.addEventListener('click', () => { prefs.kind = k; save(); renderTabs(); renderControls(); mount(); });
      tabs.appendChild(b);
    }
  }
  function setParam(key, v) {
    (prefs.params[prefs.kind] ||= {})[key] = v;
    save();
  }
  function renderControls() {
    clear(ctl);
    const def = EFFECT_DEFS[prefs.kind];
    const vals = params(prefs.kind);
    for (const key of QUICK[prefs.kind] || []) {
      const d = def.params.find((x) => x.key === key);
      if (!d) continue;
      if (d.type === 'enum') {
        const s = h('select', { title: d.label }, d.options.map((o) => h('option', { value: String(o.value) }, o.label)));
        s.value = String(vals[key]);
        s.addEventListener('change', () => { const o = d.options.find((x) => String(x.value) === s.value); setParam(key, o ? o.value : s.value); });
        ctl.appendChild(h('label', d.label, s));
      } else if (d.type === 'bool') {
        const c = h('input', { type: 'checkbox', checked: !!vals[key] });
        c.addEventListener('change', () => setParam(key, c.checked));
        ctl.appendChild(h('label', c, d.label));
      } else if (d.type === 'number') {
        // log params move on a log slider
        const lg = d.curve === 'log';
        const toS = (v) => (lg ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min)) * 1000;
        const fromS = (s) => { const t = s / 1000; const v = lg ? d.min * Math.pow(d.max / d.min, t) : d.min + t * (d.max - d.min); return Math.round(v / d.step) * d.step; };
        const out = h('span', fmt(vals[key], d));
        const r = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: toS(vals[key]), title: d.label });
        r.addEventListener('input', () => { const v = fromS(+r.value); out.textContent = fmt(v, d); setParam(key, v); });
        ctl.appendChild(h('label', d.label, r, out));
      }
    }
  }
  const fmt = (v, d) => `${Number(v).toFixed(d.step >= 1 ? 0 : d.step >= 0.1 ? 1 : 2)}${d.unit ? ` ${d.unit}` : ''}`;

  // ---- tap + view
  let tap = null, view = null;
  const getProbe = () => {
    if (!engine?.ctx) { note.textContent = 'Start playback to analyse.'; return null; }
    const node = scopeSourceNode(engine, prefs.source, ui?.get?.('selectedTrackId'));
    if (!node) { dropTap(); note.textContent = 'Nothing to analyse yet.'; return null; }
    if (!tap || tap.node !== node || tap.ctx !== engine.ctx) {
      dropTap();
      try { tap = { ...createNodeTap(engine.ctx, node, 4096), ctx: engine.ctx }; } catch (e) { console.warn('[scopes]', e); return null; }
    }
    note.textContent = '';
    return tap.probe;
  };
  function dropTap() { try { tap?.dispose(); } catch { /* */ } tap = null; }
  function mount() {
    view?.stop();
    clear(body);
    const kind = prefs.kind;
    view = mountAnalyzer(kind, { getProbe, getParams: () => params(kind), popout: { key: `scopes:${kind}`, title: `${EFFECT_DEFS[kind].name} — Scopes` } });
    body.appendChild(view.el);
  }

  return {
    el,
    show() {
      if (!el.classList.contains('hidden') && view) return;
      el.classList.remove('hidden');
      fillSources(); renderTabs(); renderControls(); mount();
    },
    hide() { el.classList.add('hidden'); view?.stop(); view = null; clear(body); dropTap(); },
    dispose() { view?.stop(); view = null; dropTap(); clear(el); },
  };
}
