// Device-panel editors for plugin instruments / effects (soundfont, faust, wam):
// status (loading / error + retry), auto-generated Faust knobs, "Open plugin UI" for WAMs.
// The plugin runtime is never imported here — only the small pure status registry.
import { h, icon, clear } from './dom.js';
import { knob, toggle, button, modal } from './components.js';
import { getStatus, onStatus, pluginKey, shortUrl } from '../plugins/status.js';

// ---- dialog opener registry (set by plugins-dialog.js; avoids a static import cycle) ----
let opener = null;
export function setPluginDialogOpener(fn) { opener = fn; }
/** openPluginDialog({tab, kind, type, trackId, onPickEffect}) — no-op until the dialog module is installed. */
export function openPluginDialog(opts = {}) {
  if (opener) return opener(opts);
  import('./plugins-dialog.js').then((m) => m.openPluginsDialog(window.daw3, opts)).catch((e) => console.warn('[plugins]', e));
  return null;
}

const KIND_NAMES = { soundfont: 'SoundFont', faust: 'Faust', wam: 'WAM', native: 'Native' };
const FORMAT_NAMES = { vst3: 'VST3', au: 'Audio Unit', clap: 'CLAP' };

/** Native plugin (Mac app) buttons: open its own editor window, keep its state in the project. */
function nativeButtons(app, getPlugin, edit) {
  const save = async (quiet) => {
    const pl = getPlugin();
    const s = await pl?.getState?.().catch(() => null);
    if (s == null) { if (!quiet) app.toast('This plugin does not save a state', { level: 'warn' }); return; }
    edit('Plugin state', (p) => { p.state = s; }, { undo: !quiet });
    if (!quiet) app.toast('Plugin state saved in the project', { level: 'success' });
  };
  const open = button('Open plugin window', async () => {
    try {
      await app.engine.init();
      const pl = getPlugin();
      if (!pl) throw new Error('The plugin is still loading');
      // edits in the plugin's own window flow back into the project (automation / undo see them)
      pl.onValues = (values) => edit('Plugin edit', (p) => { p.values = values; }, { coalesce: true });
      pl.onEditorClosed = () => save(true);
      await pl.openEditor();
    } catch (e) { app.toast(String(e?.message || e), { level: 'error' }); }
  }, { icon: 'sliders', cls: 'small primary', title: 'Show the plugin’s own interface in a separate window' });
  return [open, button('Save state', () => save(false), { icon: 'save', cls: 'small', title: 'Store the plugin’s current settings in the project (saved with it)' })];
}

/** Live plugin engine of a track instrument (FaustEngine / SoundfontEngine / WamEngine) or null. */
export function liveInstrumentPlugin(app, trackId) {
  return app.engine?.graph?.getInstrument?.(trackId)?.engine?.plugin || null;
}

/** Live plugin of an insert effect (by effect id) anywhere in the mixer, or null. */
export function liveEffectPlugin(app, fxId) {
  const g = app.engine?.graph;
  if (!g) return null;
  const strips = [g.master, ...(g.buses?.values?.() || []), ...[...(g.tracks?.values?.() || [])].map((e) => e.strip)];
  for (const s of strips) for (const e of s?.effects || []) if (e.id === fxId) return e.fx?.plugin || null;
  return null;
}

function statusRow(app, getKey, retry) {
  const dot = h('span.plg-dot');
  const msg = h('span.plg-status-msg');
  const bar = h('div.plg-progress', h('div.plg-progress-fill'));
  const retryBtn = button('Retry', () => retry(), { icon: 'undo', cls: 'small', title: 'Try loading the plugin again (re-downloads it)' });
  const startBtn = button('Load', () => app.engine.init().catch(() => {}), { icon: 'power', cls: 'small', title: 'Start the audio engine and load the plugin now' });
  const el = h('div.plg-status', dot, msg, bar, retryBtn, startBtn);
  const update = () => {
    const key = getKey();
    const st = key ? getStatus(key) : { state: 'idle' };
    const noAudio = !app.engine?.ctx;
    const state = st.state === 'idle' && noAudio ? 'idle' : st.state;
    el.dataset.state = state;
    dot.title = state;
    msg.textContent = state === 'error' ? (st.error || 'Failed to load')
      : state === 'loading' ? (st.message || 'Loading…')
        : state === 'ready' ? (st.message ? `Ready · ${st.message}` : 'Ready')
          : noAudio ? 'Loads when audio starts (press Play or a key)' : 'Waiting…';
    msg.title = msg.textContent;
    bar.style.display = state === 'loading' ? '' : 'none';
    bar.firstChild.style.width = st.progress == null ? '100%' : `${Math.round((st.progress || 0) * 100)}%`;
    bar.classList.toggle('indeterminate', st.progress == null);
    retryBtn.style.display = state === 'error' ? '' : 'none';
    startBtn.style.display = noAudio && state === 'idle' ? '' : 'none';
  };
  update();
  return { el, update };
}

/** Subscribe to status changes while `el` is in the document. */
function watch(el, fn) {
  let seen = false;
  const off = onStatus(() => {
    if (el.isConnected) { seen = true; fn(); } else if (seen) off();
  });
  const iv = setInterval(() => { if (el.isConnected) { seen = true; fn(); } else if (seen) { clearInterval(iv); off(); } }, 1000);
}

function faustKnobs(host, params, values, onChange) {
  clear(host);
  const knobs = new Map();
  if (!params?.length) { host.appendChild(h('div.dv-note', 'This program has no adjustable controls.')); return knobs; }
  const sections = new Map();
  for (const p of params) {
    if (!sections.has(p.section)) sections.set(p.section, []);
    sections.get(p.section).push(p);
  }
  for (const [name, list] of sections) {
    const row = h('div.plg-knobs');
    for (const p of list) {
      const v = values?.[p.address] ?? p.init;
      if (p.type === 'bool') {
        const t = toggle({ label: p.label, value: !!v, title: p.tooltip || p.address, onChange: (nv) => onChange(p, nv ? 1 : 0, true) });
        knobs.set(p.address, { set: (x) => t.setValue?.(!!x) });
        row.appendChild(t);
      } else {
        const def = {
          key: p.address, label: p.label, type: 'number', min: p.min, max: p.max, step: p.step, default: p.init,
          unit: p.unit === 'Hz' || p.unit === 'dB' || p.unit === 's' || p.unit === 'ms' ? p.unit : (p.unit || undefined),
          curve: p.scale === 'log' && p.min > 0 ? 'log' : p.scale === 'exp' ? 'exp' : 'lin',
          description: p.tooltip || `${p.label} (${p.address})`,
        };
        const k = knob({ def, value: v, size: 36, onChange: (nv, { final } = {}) => onChange(p, nv, final) });
        knobs.set(p.address, { set: (x) => k.setValue(x) });
        row.appendChild(k);
      }
    }
    host.appendChild(sections.size > 1 ? h('div.plg-section', h('div.plg-section-title', name), row) : row);
  }
  return knobs;
}

/**
 * Instrument editor block. edit(label, fn(params), opts) mutates instrument.params.
 * Returns update(resolvedParams, ctx).
 */
export function pluginInstrumentEditor(app, body, tgt, ins, { edit, resolved }) {
  const trackId = tgt.id;
  let params = resolved || ins.params || {};
  const keyOf = () => pluginKey({ type: ins.type, params });
  const retry = () => {
    const pl = liveInstrumentPlugin(app, trackId);
    if (pl?.reload) pl.reload(); else app.engine.init().catch(() => {});
  };
  const status = statusRow(app, keyOf, retry);
  const src = h('div.plg-source');
  const extra = h('div.plg-extra');
  const wrap = h(`div.plg-device.plg-${ins.type}`, h('div.plg-head', h('span.plg-kind', KIND_NAMES[ins.type] || ins.type), src), status.el, extra);
  body.appendChild(wrap);

  const renderSource = () => {
    clear(src);
    const name = params.name || '';
    if (ins.type === 'soundfont') {
      if (params.url) src.append(h('span.plg-name', name || 'Custom soundfont'), h('a.plg-url', { href: params.url, target: '_blank', rel: 'noopener', title: params.url }, shortUrl(params.url)));
      else src.append(h('span.plg-name', 'General MIDI library'));
    } else {
      src.append(h('span.plg-name', name || (ins.type === 'faust' ? 'Faust program' : ins.type === 'native' ? 'Native plugin' : 'Web Audio Module')));
      if (ins.type === 'native') src.append(h('span.plg-url', `${FORMAT_NAMES[params.format] || ''}${params.vendor ? ` · ${params.vendor}` : ''}`));
      if (params.url) src.append(h('a.plg-url', { href: params.url, target: '_blank', rel: 'noopener', title: params.url }, shortUrl(params.url)));
    }
  };

  let knobsHost = null, knobs = new Map(), knobSig = '';
  const buttons = h('div.plg-buttons');
  extra.appendChild(buttons);
  buttons.appendChild(button('Change…', () => openPluginDialog({ tab: 'catalog', kind: ins.type, type: 'instrument', trackId }), { icon: 'plug', cls: 'small', title: 'Pick another plugin for this track' }));
  if (ins.type === 'soundfont') {
    if (params.url) buttons.appendChild(button('Use GM library', () => edit('SoundFont: GM library', (p) => { delete p.url; delete p.name; }), { cls: 'small', title: 'Forget the custom link and use the Instrument / Library pickers below' }));
  }
  if (ins.type === 'native') {
    for (const b of nativeButtons(app, () => liveInstrumentPlugin(app, trackId), edit)) buttons.appendChild(b);
    knobsHost = h('div.plg-faust-knobs');
    extra.appendChild(knobsHost);
  }
  if (ins.type === 'faust') {
    buttons.appendChild(button('Edit source', () => openPluginDialog({ tab: 'faust', trackId, code: params.code, name: params.name }), { icon: 'code', cls: 'small', title: 'Open the Faust editor with this program; recompile to update the track' }));
    knobsHost = h('div.plg-faust-knobs');
    extra.appendChild(knobsHost);
  }
  if (ins.type === 'wam') {
    buttons.appendChild(button('Open plugin UI', () => openWamGui(app, () => liveInstrumentPlugin(app, trackId), params.name || 'Plugin', (state) => edit('Plugin state', (p) => { p.state = state; }, { undo: false })), { icon: 'sliders', cls: 'small primary', title: 'Show the plugin’s own interface' }));
    buttons.appendChild(button('Save state', async () => {
      const pl = liveInstrumentPlugin(app, trackId);
      const s = await pl?.getState?.().catch(() => null);
      if (s == null) { app.toast('This plugin does not report a state', { level: 'warn' }); return; }
      edit('Save plugin state', (p) => { p.state = s; });
      app.toast('Plugin state saved in the project', { level: 'success' });
    }, { icon: 'save', cls: 'small', title: 'Store the plugin’s current settings in the project (saved with it)' }));
    extra.appendChild(h('div.dv-note', 'Experimental: Web Audio Modules run live. Offline export may render this track silent.'));
  }

  const refreshKnobs = () => {
    if (!knobsHost) return;
    const st = getStatus(keyOf());
    const list = st.info?.params || (st.state === 'ready' ? [] : null);
    const sig = list ? list.map((p) => p.address).join('|') : `#${st.state}`;
    if (sig !== knobSig) {
      knobSig = sig;
      if (list) {
        knobs = faustKnobs(knobsHost, list, params.values || {}, (p, v) => edit(`${params.name || 'Faust'}: ${p.label}`, (pp) => { pp.values = { ...(pp.values || {}), [p.address]: v }; }, { coalesce: true }));
      } else {
        clear(knobsHost);
        knobs = new Map();
        knobsHost.appendChild(h('div.dv-note', ins.type === 'native' ? (st.state === 'error' ? 'Retry above to reload the plugin.' : 'Controls appear once the plugin is loaded.') : st.state === 'error' ? 'Fix the error above (Edit source) to get the controls.' : 'Controls appear once the program is compiled.'));
      }
    } else {
      for (const [addr, k] of knobs) if (params.values && addr in params.values) k.set(params.values[addr]);
    }
  };

  renderSource();
  refreshKnobs();
  watch(wrap, () => { status.update(); refreshKnobs(); });
  return (r) => {
    params = r || params;
    status.update();
    renderSource();
    refreshKnobs();
  };
}

/** Effect editor block (faust knobs / wam GUI). edit(label, fn(params), opts) mutates effect.params. */
export function pluginEffectEditor(app, body, fx, { edit }) {
  let params = fx.params || {};
  const keyOf = () => pluginKey({ type: fx.type, params });
  const retry = () => { const pl = liveEffectPlugin(app, fx.id); if (pl?.reload) pl.reload(); else app.engine.init().catch(() => {}); };
  const status = statusRow(app, keyOf, retry);
  const buttons = h('div.plg-buttons');
  const knobsHost = h('div.plg-faust-knobs');
  const wrap = h(`div.plg-device.plg-fx.plg-${fx.type}`, h('div.plg-head', h('span.plg-kind', KIND_NAMES[fx.type] || fx.type), h('span.plg-name', params.name || '')), status.el, buttons, knobsHost);
  body.appendChild(wrap);
  if (fx.type === 'faust') {
    buttons.appendChild(button('Edit source', () => openPluginDialog({ tab: 'faust', fxId: fx.id, code: params.code, name: params.name, type: 'effect' }), { icon: 'code', cls: 'small' }));
  } else if (fx.type === 'native') {
    for (const b of nativeButtons(app, () => liveEffectPlugin(app, fx.id), edit)) buttons.appendChild(b);
  } else {
    buttons.appendChild(button('Open plugin UI', () => openWamGui(app, () => liveEffectPlugin(app, fx.id), params.name || 'Plugin', (state) => edit('Plugin state', (p) => { p.state = state; }, { undo: false })), { icon: 'sliders', cls: 'small primary' }));
  }
  let knobSig = '', knobs = new Map();
  const refresh = () => {
    status.update();
    if (fx.type !== 'faust' && fx.type !== 'native') return;
    const st = getStatus(keyOf());
    const list = st.info?.params || (st.state === 'ready' ? [] : null);
    const sig = list ? list.map((p) => p.address).join('|') : `#${st.state}`;
    if (sig !== knobSig) {
      knobSig = sig;
      if (list) knobs = faustKnobs(knobsHost, list, params.values || {}, (p, v) => edit(`${params.name || 'Faust'}: ${p.label}`, (pp) => { pp.values = { ...(pp.values || {}), [p.address]: v }; }, { coalesce: true }));
      else { clear(knobsHost); knobs = new Map(); }
    } else {
      for (const [addr, k] of knobs) if (params.values && addr in params.values) k.set(params.values[addr]);
    }
  };
  refresh();
  watch(wrap, refresh);
  return (f) => { params = f?.params || params; refresh(); };
}

/** Show a WAM's own GUI in a modal; saves the plugin state into the project when closed. */
export async function openWamGui(app, getPlugin, title, saveState) {
  const host = h('div.plg-wam-gui', h('div.plg-wam-loading', icon('plug', 18), ' Loading the plugin interface…'));
  let gui = null, plugin = null;
  const m = modal({
    title: `${title} — plugin UI`,
    body: host,
    width: 960,
    cls: 'plg-wam-modal',
    onClose: async () => {
      if (gui && plugin) plugin.destroyGui?.(gui);
      try { const s = await plugin?.getState?.(); if (s != null) saveState?.(s); } catch { /* */ }
    },
  });
  try {
    await app.engine.init();
    plugin = getPlugin();
    for (let i = 0; !plugin && i < 40; i++) { await new Promise((r) => setTimeout(r, 100)); plugin = getPlugin(); }
    if (!plugin) throw new Error('The plugin is not loaded yet.');
    const ok = await plugin.ready;
    if (!ok) throw new Error(plugin.error || 'The plugin failed to load.');
    gui = await plugin.createGui();
    clear(host);
    if (!gui) host.appendChild(h('div.dv-note', 'This plugin has no graphical interface.'));
    else host.appendChild(gui);
  } catch (e) {
    clear(host);
    host.appendChild(h('div.plg-error', String(e?.message || e)));
  }
  return m;
}
