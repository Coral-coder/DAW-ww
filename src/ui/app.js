// Application shell: layout, view registry, render batching and wiring.
import { Store } from '../core/store.js';
import { UIState } from './state.js';
import { h, icon } from './dom.js';
import { toast, setTrackOptionsProvider } from './components.js';
import { patchNeedsReconcile, reconcilePatch } from '../core/patch.js';
import { AudioEngine, PRESETS } from '../audio/index.js';
import { createActions } from './actions.js';
import { createHeader } from './header.js';
import { installKeyboard } from './keyboard.js';
import { installAutomationRecorder } from './automation-recorder.js';

export const VIEWS = [
  { id: 'arrange', label: 'Arrange', icon: 'timeline', key: '1', module: './views/arrange.js', factory: 'createArrangeView', help: 'Timeline: place pattern & audio clips into a full song.' },
  { id: 'session', label: 'Scenes', icon: 'scenes', key: '2', module: './views/session.js', factory: 'createSessionView', help: 'Clip launcher: trigger pattern combinations live.' },
  { id: 'rack', label: 'Step Rack', icon: 'grid', key: '3', module: './views/rack.js', factory: 'createRackView', help: 'Channel rack / step sequencer for beats and quick ideas.' },
  { id: 'piano', label: 'Piano Roll', icon: 'piano', key: '4', module: './views/piano.js', factory: 'createPianoView', help: 'Edit notes, chords and melodies with scale guides.' },
  { id: 'mixer', label: 'Mixer', icon: 'mixer', key: '5', module: './views/mixer.js', factory: 'createMixerView', help: 'Levels, panning, sends, inserts and buses.' },
  { id: 'code', label: 'Code', icon: 'code', key: '6', module: './views/code.js', factory: 'createCodeView', help: 'Strudel-style live coding; import & expand .strudel files.' },
  { id: 'patch', label: 'Plugboard', icon: 'plug', key: '7', module: './views/patch.js', factory: 'createPatchView', help: 'Plugboard: patch effects with cables — parallel chains, splits, sidechain ducking, whole-song routing.' },
  { id: 'setlist', label: 'Setlist', icon: 'sparkles', key: '8', module: './views/setlist.js', factory: 'createSetlistView', help: 'Setlist: an endless DJ set — pick a genre and key, every layer loops and evolves phrase by phrase; energy arc, key moves, per-layer control.' },
];

export async function createApp(rootEl) {
  const store = new Store();
  const ui = new UIState();
  const engine = new AudioEngine(store);
  const app = { store, ui, engine, views: {}, toast };
  window.daw3 = app; // handy for debugging / automation

  // ---- render batching: components call app.subscribe(fn) and get rAF-batched updates ----
  const subs = new Set();
  let pending = null;
  const flush = () => {
    const reasons = pending;
    pending = null;
    for (const fn of subs) {
      try { fn(reasons); } catch (e) { console.error('[render]', e); }
    }
  };
  const schedule = (kind, detail) => {
    if (!pending) { pending = { project: false, ui: {}, labels: [] }; requestAnimationFrame(flush); }
    if (kind === 'project') { pending.project = true; if (detail) pending.labels.push(detail); }
    else Object.assign(pending.ui, detail);
  };
  // Keep instrument.type consistent with its preset (generators/old files may store a generic 'synth').
  const presetTypeMismatch = (p) => p.tracks.some((t) => t.instrument?.preset && PRESETS[t.instrument.preset] && PRESETS[t.instrument.preset].instrument.type !== t.instrument.type);
  store.on('change', (p) => {
    if (!presetTypeMismatch(p)) return;
    store.transact('Normalize presets', (pp) => {
      for (const t of pp.tracks) {
        const pr = t.instrument?.preset && PRESETS[t.instrument.preset];
        if (pr && pr.instrument.type !== t.instrument.type) t.instrument.type = pr.instrument.type;
      }
    }, { undo: false });
  });
  // Plugboard tracks: effects added/removed elsewhere (device panel, mixer, assistant…) are
  // placed on / taken off the board so the patch always matches track.fx.
  store.on('change', (p) => {
    if (!p.tracks.some(patchNeedsReconcile)) return;
    store.transact('Update plugboard', (pp) => { for (const t of pp.tracks) reconcilePatch(t); }, { undo: false });
  });
  store.on('change', (_p, label) => schedule('project', label));
  setTrackOptionsProvider(() => store.get().tracks.map((t) => ({ value: t.id, label: t.name })));
  ui.on('change', (changed) => schedule('ui', changed));
  app.subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  app.requestRender = () => schedule('project', 'refresh');

  app.actions = createActions(app);
  import('./plugins-dialog.js').then((m) => m.installPluginUi(app)).catch((e) => console.warn('[plugins] UI', e)); // SoundFont / Faust / WAM plugins

  // ---- layout ----
  const header = createHeader(app);
  const viewTabs = h('div.view-tabs');
  const viewHost = h('div.view-host');
  const main = h('main.app-main', viewTabs, viewHost);
  const browserEl = h('aside.app-browser');
  const assistantEl = h('aside.app-assistant');
  const deviceEl = h('section.app-device');
  const status = h('footer.app-status');
  rootEl.append(header.el, browserEl, main, assistantEl, deviceEl, status);

  // ---- views (lazy-loaded so a single failing view can't take down the app) ----
  const viewEls = {};
  for (const v of VIEWS) {
    const tab = h('button.view-tab', { type: 'button', title: `${v.help} (${v.key})`, dataset: { view: v.id } }, icon(v.icon, 15), h('span', v.label), h('kbd', v.key));
    tab.addEventListener('click', () => ui.set({ view: v.id }));
    viewTabs.appendChild(tab);
    const host = h('div.view.hidden', { dataset: { view: v.id } });
    viewHost.appendChild(host);
    viewEls[v.id] = host;
  }
  viewTabs.appendChild(h('div.spacer'));

  async function mountView(v) {
    if (app.views[v.id]) return app.views[v.id];
    try {
      const mod = await import(v.module);
      const view = mod[v.factory](app);
      viewEls[v.id].appendChild(view.el);
      app.views[v.id] = view;
      return view;
    } catch (e) {
      console.error(`[view:${v.id}]`, e);
      viewEls[v.id].appendChild(h('div.empty-state', h('h3', `${v.label} failed to load`), h('code', e.message)));
      app.views[v.id] = { el: null, failed: true };
      return null;
    }
  }

  let currentView = null;
  async function showView(id) {
    const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
    for (const t of viewTabs.querySelectorAll('.view-tab')) t.classList.toggle('active', t.dataset.view === v.id);
    for (const [vid, el] of Object.entries(viewEls)) el.classList.toggle('hidden', vid !== v.id);
    const prev = currentView;
    currentView = v.id;
    if (prev && prev !== v.id) app.views[prev]?.hide?.();
    const view = await mountView(v);
    if (currentView === v.id) view?.show?.();
  }
  app.showView = (id) => ui.set({ view: id });

  // ---- side panels ----
  async function mountPanel(el, modPath, factory, label) {
    try {
      const mod = await import(modPath);
      const panel = mod[factory](app);
      el.appendChild(panel.el);
      return panel;
    } catch (e) {
      console.error(`[panel:${label}]`, e);
      el.appendChild(h('div.empty-state', h('h3', `${label} failed to load`), h('code', e.message)));
      return null;
    }
  }

  const applyPanels = () => {
    rootEl.classList.toggle('browser-closed', !ui.get('browserOpen'));
    rootEl.classList.toggle('assistant-closed', !ui.get('assistantOpen'));
    rootEl.classList.toggle('device-closed', !ui.get('deviceOpen'));
    document.documentElement.dataset.theme = ui.get('theme');
  };
  applyPanels();
  // On narrow windows the assistant is an overlay drawer: start (and switch to) narrow with it closed so it
  // doesn't cover the view; B / A still toggle the panels.
  try {
    const narrow = window.matchMedia('(max-width: 1024px)');
    if (narrow.matches && ui.get('assistantOpen')) ui.set({ assistantOpen: false });
    narrow.addEventListener?.('change', (e) => { if (e.matches && ui.get('assistantOpen')) ui.set({ assistantOpen: false }); });
  } catch { /* matchMedia unavailable */ }

  // ---- status bar ----
  const statusText = h('span');
  const statusRight = h('span');
  status.append(h('span', icon('sparkles', 12)), statusText, h('div.spacer'), statusRight);
  app.setStatus = (t) => { statusText.textContent = t; };
  const updateStatus = () => {
    const p = store.get();
    const pats = Object.keys(p.patterns).length;
    statusRight.textContent = `${p.tracks.length} tracks · ${pats} patterns · ${p.clips.length} clips · ${engine.ctx ? (engine.ctx.sampleRate / 1000).toFixed(1) + ' kHz' : 'audio idle'} · ${store.canUndo() ? 'Ctrl+Z to undo' : ''}`;
  };

  app.subscribe((r) => {
    if (r.ui.view) showView(r.ui.view);
    if ('browserOpen' in r.ui || 'assistantOpen' in r.ui || 'deviceOpen' in r.ui || 'theme' in r.ui) applyPanels();
    updateStatus();
  });

  engine.on?.('error', (e) => { console.error('[engine]', e); });

  installKeyboard(app);
  installAutomationRecorder(app);
  import('../control/index.js').then((m) => m.installControl(app)).catch((e) => console.warn('[control]', e)); // MIDI, surfaces, sync, palette

  await showView(ui.get('view'));
  app.panels = {
    browser: await mountPanel(browserEl, './panels/browser.js', 'createBrowserPanel', 'Browser'),
    assistant: await mountPanel(assistantEl, './panels/assistant.js', 'createAssistantPanel', 'Assistant'),
    device: await mountPanel(deviceEl, './panels/device.js', 'createDevicePanel', 'Device panel'),
  };

  // Restore last session (autosave) or offer the welcome screen.
  await app.actions.boot();
  updateStatus();
  app.setStatus('Ready. Press Space to play, ? for help.');
  return app;
}
