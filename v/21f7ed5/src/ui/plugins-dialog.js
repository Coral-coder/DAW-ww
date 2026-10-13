// Plugins dialog: Catalog (curated open-source plugins), "From GitHub link" and a Faust editor.
// Opened from the main menu, the device panel ("Load plugin…") and the add-effect menu.
// The plugin runtime (src/plugins/index.js) is imported lazily on first use.
import { h, icon, clear } from './dom.js';
import { modal, tabs, button, select } from './components.js';
import { CATALOG, KIND_LABELS, catalogCategories, searchCatalog } from '../plugins/catalog.js';
import { FAUST_TEMPLATE } from '../plugins/faust-library.js';
import { onStatus, shortUrl } from '../plugins/status.js';
import { setPluginDialogOpener } from './plugin-device.js';

const runtime = () => import('../plugins/index.js');

const LINK_EXAMPLES = [
  { label: 'SoundFont · Marimba (FluidR3)', url: 'https://github.com/gleitz/midi-js-soundfonts/blob/gh-pages/FluidR3_GM/marimba-mp3.js' },
  { label: 'Faust · STK flute (instrument)', url: 'https://github.com/grame-cncm/faust/blob/master-dev/examples/physicalModeling/faust-stk/flute.dsp' },
  { label: 'Faust · Freeverb demo (effect)', url: 'https://github.com/grame-cncm/faust/blob/master-dev/examples/reverb/freeverb.dsp' },
  { label: 'WAM · Synth-101 (experimental)', url: 'https://cdn.jsdelivr.net/npm/wam-community@0.4.9/dist/plugins/burns-audio/synth101/index.js' },
];

/** catalog entry -> plugin info used by the runtime helpers */
const entryInfo = (e) => ({
  kind: e.kind, type: e.type, name: e.name, url: e.source?.url || '', code: e.source?.code || '',
  library: e.source?.library, instrument: e.source?.instrument, experimental: !!e.experimental, description: e.description,
});

export function installPluginUi(app) {
  setPluginDialogOpener((opts) => openPluginsDialog(app, opts));
  // friendly toasts for plugin load failures (live) and render problems
  const toasted = new Map();
  onStatus((key, st, prev) => {
    if (st.state !== 'error' || prev.state === 'error') return;
    const now = Date.now();
    if (now - (toasted.get(key) || 0) < 5000) return;
    toasted.set(key, now);
    app.toast(`Plugin failed to load: ${st.error}`, { level: 'error', timeout: 6000 });
  });
  app.engine.on?.('error', (e) => {
    const msg = String(e?.message || e);
    if (/rendered silent|Plugin effect|plugins took too long/.test(msg)) app.toast(msg, { level: 'warn', timeout: 7000 });
  });
}

export function openPluginsDialog(app, opts = {}) {
  const { store, ui, actions } = app;
  const msgEl = h('div.plg-msg');
  const setMsg = (text, level = 'info') => { msgEl.textContent = text || ''; msgEl.dataset.level = level; };

  // ------------------------------------------------------------------ targets
  const selectedInstrumentTrack = () => {
    const id = opts.trackId || ui.get('selectedTrackId');
    const t = store.get().tracks.find((x) => x.id === id);
    return t && t.type === 'instrument' ? t : null;
  };
  const selectedTrack = () => store.get().tracks.find((x) => x.id === (opts.trackId || ui.get('selectedTrackId'))) || null;

  async function addAsTrack(info) {
    const rt = await runtime();
    const t = actions.addTrack('plugin', { instrument: rt.pluginInstrument(info), name: info.name });
    app.engine.init().catch(() => {});
    app.toast(`Added “${t?.name || info.name}” — it loads in the background`, { level: 'success' });
    return t;
  }
  async function loadOnTrack(info) {
    const t = selectedInstrumentTrack();
    if (!t) { setMsg('Select an instrument track first (or use “Add as new track”).', 'warn'); return false; }
    const rt = await runtime();
    const inst = rt.pluginInstrument(info);
    store.transact(`Instrument: ${info.name}`, (p) => { const tt = p.tracks.find((x) => x.id === t.id); if (tt) tt.instrument = inst; });
    app.engine.init().catch(() => {});
    app.toast(`Loaded “${info.name}” on ${t.name}`, { level: 'success' });
    return true;
  }
  async function addEffect(info) {
    const rt = await runtime();
    const params = rt.pluginEffectParams(info);
    if (opts.onPickEffect) { opts.onPickEffect(info.kind, params); app.engine.init().catch(() => {}); return true; }
    const t = selectedTrack();
    if (!t) { setMsg('Select a track to add the effect to.', 'warn'); return false; }
    const { createEffect } = await import('../core/model.js');
    store.transact(`Add ${info.name}`, (p) => { const tt = p.tracks.find((x) => x.id === t.id); if (tt) tt.fx.push(createEffect(info.kind, params)); });
    app.engine.init().catch(() => {});
    app.toast(`Added effect “${info.name}” to ${t.name}`, { level: 'success' });
    return true;
  }
  async function preview(info, btn) {
    const label = btn?.querySelector('span');
    const old = label?.textContent;
    if (btn) btn.disabled = true;
    try {
      const rt = await runtime();
      await rt.previewPlugin(app.engine, info, { onStage: (s) => { if (label) label.textContent = s.replace(/…$/, '…'); setMsg(`${info.name}: ${s}`); } });
      setMsg(`Previewing ${info.name}…`, 'info');
    } catch (e) {
      setMsg(String(e?.message || e), 'error');
    } finally {
      if (btn) { btn.disabled = false; if (label) label.textContent = old; }
    }
  }

  function actionButtons(info, { close, before } = {}) {
    const wrap = h('div.plg-actions');
    const ok = async () => !before || before();
    const prev = button('Preview', async (e) => { const b = e.currentTarget; if (await ok()) preview(info, b); }, { icon: 'play', cls: 'small', title: info.type === 'effect' ? 'Hear a short riff through this effect' : 'Hear a short phrase' });
    wrap.appendChild(prev);
    if (info.type === 'effect') {
      const lbl = opts.onPickEffect ? 'Add effect' : 'Add to selected track';
      wrap.appendChild(button(lbl, async () => { if ((await ok()) && (await addEffect(info))) close?.(); }, { icon: 'plus', cls: 'small', primary: true, title: 'Insert this effect at the end of the track’s effect chain' }));
    } else {
      wrap.appendChild(button('Add as new track', async () => { if (!(await ok())) return; await addAsTrack(info); close?.(); }, { icon: 'plus', cls: 'small', primary: !opts.trackId, title: 'Create a new instrument track that plays this plugin' }));
      const t = selectedInstrumentTrack();
      const b = button(t ? `Load on “${t.name}”` : 'Load on selected track', async () => { if ((await ok()) && (await loadOnTrack(info))) close?.(); }, { icon: 'plug', cls: 'small', primary: !!opts.trackId, title: 'Replace the selected track’s instrument with this plugin (notes are kept)' });
      if (!t) b.disabled = true;
      wrap.appendChild(b);
    }
    return wrap;
  }

  // ------------------------------------------------------------------ catalog tab
  const filt = { query: '', kind: opts.kind || '', type: opts.type || (opts.onPickEffect ? 'effect' : ''), category: '' };
  function renderCatalog() {
    const list = h('div.plg-list');
    const count = h('span.plg-count');
    const search = h('input.plg-search', { type: 'search', placeholder: 'Search plugins (piano, reverb, strings, Faust…)', value: filt.query });
    const kindSel = select({ options: [{ value: '', label: 'All kinds' }, ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))], value: filt.kind, onChange: (v) => { filt.kind = v; filt.category = ''; refreshCats(); draw(); }, title: 'Plugin technology' });
    const typeSel = select({ options: [{ value: '', label: 'Instruments & effects' }, { value: 'instrument', label: 'Instruments' }, { value: 'effect', label: 'Effects' }], value: filt.type, onChange: (v) => { filt.type = v; filt.category = ''; refreshCats(); draw(); }, title: 'Instrument or effect' });
    const catHost = h('span');
    let catSel;
    const refreshCats = () => {
      clear(catHost);
      catSel = select({ options: [{ value: '', label: 'All categories' }, ...catalogCategories({ kind: filt.kind, type: filt.type }).map((c) => ({ value: c, label: c }))], value: filt.category, onChange: (v) => { filt.category = v; draw(); }, title: 'Category' });
      catHost.appendChild(catSel);
    };
    refreshCats();
    search.addEventListener('input', () => { filt.query = search.value; draw(); });
    function draw() {
      clear(list);
      const items = searchCatalog(filt);
      count.textContent = `${items.length} of ${CATALOG.length}`;
      if (!items.length) list.appendChild(h('div.plg-empty', 'No plugins match. Clear the filters, or load your own from a GitHub link.'));
      for (const e of items) list.appendChild(card(e));
    }
    function card(e) {
      const info = entryInfo(e);
      return h(`div.plg-card.plg-kind-${e.kind}`,
        h('div.plg-card-top',
          h(`span.plg-badge.plg-badge-${e.kind}`, KIND_LABELS[e.kind]),
          h('span.plg-badge.plg-badge-type', e.type === 'effect' ? 'Effect' : 'Instrument'),
          e.experimental ? h('span.plg-badge.plg-badge-exp', { title: 'Third-party Web Audio Module: runs live, may not work in offline export' }, 'experimental') : null,
          h('span.plg-cat', e.category)),
        h('div.plg-card-name', e.name),
        h('div.plg-card-desc', e.description),
        h('div.plg-card-meta', `${e.author} · ${e.license} · `, h('a', { href: e.homepage, target: '_blank', rel: 'noopener' }, 'source')),
        actionButtons(info, { close: () => dlg.close() }));
    }
    draw();
    setTimeout(() => search.focus(), 30);
    return h('div.plg-tab.plg-catalog',
      h('div.plg-toolbar', icon('search', 14), search, kindSel, typeSel, catHost, count),
      list);
  }

  // ------------------------------------------------------------------ link tab
  let lastLink = '';
  function renderLink() {
    const input = h('input.plg-url-input', { type: 'url', placeholder: 'https://github.com/<owner>/<repo>/blob/<branch>/synth.dsp', value: lastLink, spellcheck: false });
    const result = h('div.plg-link-result');
    const go = button('Detect', () => detect(), { icon: 'search', primary: true });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') detect(); });
    async function detect() {
      const url = input.value.trim();
      lastLink = url;
      clear(result);
      if (!url) { result.appendChild(h('div.plg-error', 'Paste a link first.')); return; }
      const stage = h('div.plg-stage', h('span.plg-spinner'), h('span', 'Resolving the link…'));
      result.appendChild(stage);
      go.disabled = true;
      try {
        const rt = await runtime();
        try {
          const r = rt.resolveGitHubUrl(url);
          if (r.github && r.url !== url) stage.lastChild.textContent = `Fetching via ${shortUrl(r.url)}…`;
        } catch { /* reported by detectPlugin */ }
        const info = await rt.detectPlugin(url, { onStage: (s) => { stage.lastChild.textContent = s; } });
        clear(result);
        result.appendChild(h('div.plg-detected',
          h('div.plg-card-top',
            h(`span.plg-badge.plg-badge-${info.kind}`, KIND_LABELS[info.kind]),
            h('span.plg-badge.plg-badge-type', info.type === 'effect' ? 'Effect' : 'Instrument'),
            info.experimental ? h('span.plg-badge.plg-badge-exp', 'experimental') : null),
          h('div.plg-card-name', info.name),
          info.description ? h('div.plg-card-desc', info.description) : null,
          h('div.plg-card-meta', 'Loads from ', h('a', { href: info.url, target: '_blank', rel: 'noopener', title: info.url }, shortUrl(info.url))),
          info.kind === 'faust' ? h('div.plg-row',
            h('label', 'Use as '),
            select({ options: [{ value: 'instrument', label: 'Instrument (polyphonic: freq/gain/gate)' }, { value: 'effect', label: 'Effect (audio in → out)' }], value: info.type, onChange: (v) => { info.type = v; redraw(); } }),
            button('Open in Faust editor', () => { faustState.code = info.code; faustState.name = info.name; faustState.type = info.type; faustState.url = info.url; tabsEl.show('faust'); }, { icon: 'code', cls: 'small' })) : null,
          h('div.plg-action-host')));
        const host = result.querySelector('.plg-action-host');
        const redraw = () => { clear(host); host.appendChild(actionButtons(info, { close: () => dlg.close() })); };
        redraw();
      } catch (e) {
        clear(result);
        result.appendChild(h('div.plg-error', String(e?.message || e)));
      } finally {
        go.disabled = false;
      }
    }
    if (lastLink) setTimeout(detect, 0);
    else setTimeout(() => input.focus(), 30);
    return h('div.plg-tab.plg-link',
      h('p.plg-help', 'Paste a link to a plugin on GitHub (or any CORS-enabled https URL). GitHub links are loaded through the jsDelivr CDN so the browser may use them.'),
      h('div.plg-row.plg-url-row', input, go),
      h('div.plg-examples', h('span', 'Examples: '), ...LINK_EXAMPLES.map((x) => {
        const a = h('button.plg-example', { type: 'button', title: x.url }, x.label);
        a.addEventListener('click', () => { input.value = x.url; detect(); });
        return a;
      })),
      result,
      h('details.plg-formats',
        h('summary', 'Supported formats'),
        h('ul',
          h('li', h('b', 'Faust'), ' — a .dsp source file, compiled in your browser. Instruments use the freq / gain / gate convention; anything with audio inputs works as an effect.'),
          h('li', h('b', 'SoundFont'), ' — a midi-js-soundfonts instrument file (…/instrument-mp3.js) like those in gleitz/midi-js-soundfonts.'),
          h('li', h('b', 'Web Audio Module 2.0'), ' — an ES module whose default export is the WAM class (experimental; runs live).'),
          h('li', h('b', 'Repository'), ' — a repo/folder link with a daW3.json or plugin.json manifest: ', h('code', '{"name": "My Synth", "kind": "faust", "entry": "synth.dsp", "type": "instrument"}'), '.'))));
  }

  // ------------------------------------------------------------------ faust tab
  const faustState = { code: opts.code || FAUST_TEMPLATE, name: opts.name || 'My Faust synth', type: opts.type === 'effect' || opts.fxId ? 'effect' : 'instrument', url: '' };
  function renderFaust() {
    const ta = h('textarea.plg-code', { spellcheck: false, wrap: 'off' });
    ta.value = faustState.code;
    ta.addEventListener('input', () => { faustState.code = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); faustState.code = ta.value; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); compile(); }
      e.stopPropagation();
    });
    const nameIn = h('input.plg-name-input', { type: 'text', value: faustState.name, placeholder: 'Name' });
    nameIn.addEventListener('input', () => { faustState.name = nameIn.value; });
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    const typeSel = select({ options: [{ value: 'instrument', label: 'Instrument (poly)' }, { value: 'effect', label: 'Effect' }], value: faustState.type, onChange: (v) => { faustState.type = v; drawActions(); } });
    const out = h('div.plg-faust-out');
    const actionsHost = h('div.plg-faust-actions');
    // live view of the editor state (read when a button is clicked)
    const info = {
      kind: 'faust',
      get type() { return faustState.type; },
      get name() { return faustState.name || 'Faust'; },
      get code() { return faustState.code; },
      get url() { return faustState.url || ''; },
    };

    async function compile() {
      clear(out);
      const st = h('div.plg-stage', h('span.plg-spinner'), h('span', 'Loading the Faust compiler (≈6 MB, first time only)…'));
      out.appendChild(st);
      try {
        const faust = await import('../plugins/faust.js');
        if (faustState.type === 'instrument' && !faust.looksPolyphonic(faustState.code)) {
          throw new Error('Instruments need freq, gain and gate controls, e.g. freq = hslider("freq",440,20,20000,0.01); gate = button("gate");');
        }
        const t0 = performance.now();
        const f = await faust.getFaustFactory(faustState.code, faustState.type === 'effect' ? 'mono' : 'poly', { onStage: (s) => { st.lastChild.textContent = s; } });
        if (faustState.type === 'effect' && !f.inputs) throw new Error('This program has no audio inputs, so it cannot be an effect. Use it as an instrument (with freq/gain/gate).');
        clear(out);
        out.appendChild(h('div.plg-ok', `✓ Compiled in ${Math.round(performance.now() - t0)} ms · ${f.inputs} in / ${f.outputs} out · ${f.params.length} control${f.params.length === 1 ? '' : 's'}`));
        if (f.params.length) out.appendChild(h('div.plg-param-list', f.params.map((p) => h('span.plg-param', { title: p.address }, `${p.label} ${p.type === 'bool' ? '(switch)' : `${+p.min.toFixed(3)}…${+p.max.toFixed(3)}${p.unit ? ' ' + p.unit : ''}`}`))));
        return true;
      } catch (e) {
        clear(out);
        out.appendChild(h('pre.plg-error', String(e?.message || e)));
        return false;
      }
    }

    function drawActions() {
      clear(actionsHost);
      actionsHost.appendChild(button('Compile', () => compile(), { icon: 'wand', title: 'Compile and list the controls (Ctrl+Enter)' }));
      // editing the program of an existing track / effect
      const t = opts.trackId && store.get().tracks.find((x) => x.id === opts.trackId);
      if (t?.instrument?.type === 'faust' && faustState.type === 'instrument') {
        actionsHost.appendChild(button(`Update “${t.name}”`, async () => {
          if (!(await compile())) return;
          store.transact(`Faust: update ${t.name}`, (p) => { const tt = p.tracks.find((x) => x.id === t.id); if (tt?.instrument) tt.instrument.params = { ...tt.instrument.params, code: faustState.code, name: faustState.name }; });
          app.toast('Track updated with the new Faust program', { level: 'success' });
        }, { icon: 'save', primary: true }));
      }
      if (opts.fxId && faustState.type === 'effect') {
        actionsHost.appendChild(button('Update effect', async () => {
          if (!(await compile())) return;
          store.transact('Faust effect: update', (p) => {
            for (const o of [...p.tracks, ...p.buses, p.master]) {
              const f = o.fx?.find((x) => x.id === opts.fxId);
              if (f) f.params = { ...f.params, code: faustState.code, name: faustState.name };
            }
          });
          app.toast('Effect updated with the new Faust program', { level: 'success' });
        }, { icon: 'save', primary: true }));
      }
      // compile first so errors show here instead of as a broken track
      actionsHost.appendChild(actionButtons(info, { close: () => dlg.close(), before: compile }));
    }
    drawActions();
    return h('div.plg-tab.plg-faust',
      h('div.plg-row', h('label', 'Name'), nameIn, h('label', 'Type'), typeSel,
        h('a.plg-doc', { href: 'https://faustdoc.grame.fr/manual/syntax/', target: '_blank', rel: 'noopener' }, 'Faust manual'),
        h('a.plg-doc', { href: 'https://faustlibraries.grame.fr/', target: '_blank', rel: 'noopener' }, 'Libraries')),
      ta, out, actionsHost);
  }

  // ------------------------------------------------------------------ shell
  const tabsEl = tabs([
    { id: 'catalog', label: 'Catalog', icon: 'layers', render: renderCatalog },
    { id: 'link', label: 'From GitHub link', icon: 'download', render: renderLink },
    { id: 'faust', label: 'Faust editor', icon: 'code', render: renderFaust },
  ], opts.tab || 'catalog', () => setMsg(''));
  const body = h('div.plg-dialog-body', tabsEl, msgEl);
  const dlg = modal({
    title: opts.onPickEffect ? 'Add a plugin effect' : 'Plugins — instruments & effects',
    body,
    width: 980,
    cls: 'plg-dialog',
    onClose: () => { runtime().then((rt) => rt.stopPreview()).catch(() => {}); },
  });
  body.addEventListener('keydown', (e) => { if (e.target.matches('input, textarea')) e.stopPropagation(); });
  return dlg;
}
