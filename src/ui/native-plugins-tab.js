// Plugins dialog › Native: the native plugin manager (desktop app). Installed VST3 / AU / CLAP plugins with search,
// format filter and sorting, favourites, hiding and a blocklist (never scanned or loaded), plus every plugin that
// could not be loaded as a greyed card with the reason (crashed / timed out / quarantined / Intel-only / the
// loader's error), what to do about it, "Retry" and its scan log. Preferences live in the app's userData.
import { h, clear } from './dom.js';
import { button, select } from './components.js';
import { nativePluginsApi } from '../native/client.js';
import { catalogEntries, FORMAT_LABELS } from '../native/plugin-db.js';
import { classifyFailure, cleanErrorMessage, quarantineCommand } from '../native/plugin-diagnostics.js';
import { filterNativePlugins, toggleKey, setBlocked, SORTS, normalizePrefs } from '../native/plugin-prefs.js';
import { scanNativePlugins, refreshNativeCatalog } from './plugins-dialog.js';

const VIEW_KEY = 'daw3.nativePlugins.view';
const SHOW = { all: 'All plugins', favorites: 'Favorites', hidden: 'Hidden', problems: 'Problems', blocked: 'Blocklist' };

function loadView() {
  try { return { query: '', format: '', show: 'all', sort: 'name', ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'), query: '' }; } catch { return { query: '', format: '', show: 'all', sort: 'name' }; }
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ format: v.format, show: v.show, sort: v.sort })); } catch { /* private window */ } }

const baseName = (p) => String(p || '').split(/[\\/]/).pop() || String(p || '');

/** ctx: { app, actionsFor(catalogEntry) -> element (the dialog's Preview / Add buttons) } */
export function renderNativeTab(ctx) {
  const api = nativePluginsApi();
  const view = loadView();
  let data = null; // plugins.list() result
  let prefs = normalizePrefs(null);
  const msg = h('div.plg-msg.nplg-inline');
  const setMsg = (text, level = 'info') => { msg.textContent = text || ''; msg.dataset.level = level; };
  const list = h('div.plg-list.nplg-list');
  const count = h('span.plg-count');

  const search = h('input.plg-search', { type: 'search', placeholder: 'Search installed plugins (name, vendor, format…)', value: view.query });
  search.addEventListener('input', () => { view.query = search.value; draw(); });
  const fmtSel = select({ options: [{ value: '', label: 'All formats' }, ...Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label }))], value: view.format, onChange: (v) => { view.format = v; saveView(view); draw(); }, title: 'Plugin format' });
  const showSel = select({ options: Object.entries(SHOW).map(([value, label]) => ({ value, label })), value: view.show, onChange: (v) => { view.show = v; saveView(view); draw(); }, title: 'Which plugins to list' });
  const sortSel = select({ options: Object.entries(SORTS).map(([value, label]) => ({ value: value, label: `Sort: ${label}` })), value: view.sort, onChange: (v) => { view.sort = v; saveView(view); draw(); }, title: 'Sort order' });

  const scanBtn = (label, force, title) => {
    const b = button(label, async () => {
      b.disabled = true;
      const span = b.querySelector('span');
      try {
        const r = await scanNativePlugins({ force, onProgress: (p) => { if (span) span.textContent = `Scanning ${p.done}/${p.total}…`; } });
        setMsg(`${r.count} plugins${r.added?.length ? ` · ${r.added.length} new` : ''}${r.failed.length ? ` · ${r.failed.length} could not be loaded` : ''}`, r.failed.length ? 'warn' : 'info');
        await reload();
      } catch (e) { report(e); } finally { b.disabled = false; if (span) span.textContent = label; }
    }, { icon: force ? 'refresh' : 'search', cls: 'small', title });
    return b;
  };
  const rescanBtn = scanBtn('Rescan', false, 'Look for new and updated plugins (unchanged plugins are not loaded again)');
  const fullBtn = scanBtn('Full rescan', true, 'Load every plugin again (slow; use after a plugin update that was not picked up)');

  const report = (e) => {
    const text = cleanErrorMessage(e);
    setMsg(text, 'error');
    ctx.app?.toast?.(text, { level: 'error', timeout: 8000 });
  };

  async function savePrefs(next) {
    try {
      const r = await api.setPrefs(next);
      prefs = normalizePrefs(r.prefs);
      if (r.rescan) await scanNativePlugins({ force: false });
      await refreshNativeCatalog().catch(() => {});
      await reload();
    } catch (e) { report(e); }
  }

  async function reload() {
    try {
      data = await api.list();
      prefs = normalizePrefs(data.prefs);
      if ((msg.dataset.level === 'error' && /unavailable|list/i.test(msg.textContent)) || /^Scanning \d/.test(msg.textContent)) setMsg('');
    } catch (e) { data = data || { plugins: [], failed: [], warnings: [] }; report(new Error(`Could not read the plugin list: ${cleanErrorMessage(e)}`)); }
    draw();
  }

  function logButton(format, path) {
    return button('Scan log', async (e) => {
      const card = e.currentTarget.closest('.plg-card');
      card?.querySelector('.nplg-log')?.remove();
      try {
        const r = await api.scanLog(format, path);
        card?.appendChild(h('pre.nplg-log', r.log ? `${r.log}` : 'No scan log yet (the plugin was not scanned in this version).'));
      } catch (err) { report(err); }
    }, { cls: 'small', title: 'What happened when this plugin was last scanned' });
  }

  function pluginCard(p, entry) {
    const fav = prefs.favorites.includes(p.key), hid = prefs.hidden.includes(p.key);
    const star = h('button.nplg-star', { type: 'button', title: fav ? 'Remove from favorites' : 'Add to favorites (listed first)', 'aria-pressed': String(fav) }, fav ? '★' : '☆');
    star.addEventListener('click', () => savePrefs(toggleKey(prefs, 'favorites', p.key)));
    return h(`div.plg-card.plg-kind-native.nplg-card${hid ? '.nplg-hidden' : ''}`,
      h('div.plg-card-top',
        h('span.plg-badge', FORMAT_LABELS[p.format] || p.format),
        h('span.plg-badge.plg-badge-type', p.instrument ? 'Instrument' : 'Effect'),
        p.arch === 'x86_64' ? h('span.plg-badge.plg-badge-exp', { title: 'Intel-only plugin: runs in a separate plugin host translated by Rosetta 2' }, 'Intel · Rosetta') : null,
        p.arch === 'arm64' ? h('span.plg-badge.plg-badge-exp', { title: 'Apple-silicon-only plugin: runs in a separate native plugin host' }, 'Apple silicon') : null,
        p.quarantined ? h('span.plg-badge.plg-badge-exp', { title: `macOS quarantine flag is set. If the plugin misbehaves: ${quarantineCommand(p.path)}` }, 'quarantined') : null,
        h('span.plg-cat', p.category || ''), star),
      h('div.plg-card-name', p.name),
      h('div.plg-card-meta', { title: p.path }, `${p.vendor || 'Unknown vendor'}${p.version ? ` · v${p.version}` : ''} · ${p.format === 'au' ? 'Audio Unit registry' : baseName(p.path)}`),
      entry ? ctx.actionsFor(entry) : null,
      h('div.plg-actions.nplg-manage',
        button(hid ? 'Unhide' : 'Hide', () => savePrefs(toggleKey(prefs, 'hidden', p.key)), { cls: 'small', title: hid ? 'Show it in the plugin browser again' : 'Keep it out of the plugin browser (it stays installed)' }),
        button('Block', () => {
          const what = p.format === 'au' ? p.name : baseName(p.path);
          if (!confirm(`Block ${what}? It will not be scanned or loaded until you unblock it (Plugins › Native › Blocklist).`)) return;
          savePrefs(setBlocked(prefs, p, true));
        }, { cls: 'small', title: 'Never scan or load this plugin (for plugins that crash or misbehave)' }),
        p.format !== 'au' ? logButton(p.format, p.path) : null));
  }

  function failedCard(f) {
    const c = classifyFailure(f);
    const fixCmd = c.reason === 'quarantined' ? quarantineCommand(f.path) : '';
    const retry = button('Retry', async () => {
      retry.disabled = true;
      setMsg(`Retrying ${baseName(f.path)}…`);
      try {
        const r = await api.retry(f.format, f.path);
        setMsg(r.ok ? `${baseName(f.path)} loads now` : `${baseName(f.path)} still fails: ${r.error}`, r.ok ? 'info' : 'warn');
        await refreshNativeCatalog().catch(() => {});
        await reload();
      } catch (e) { report(e); retry.disabled = false; }
    }, { icon: 'refresh', cls: 'small', title: 'Scan this plugin again' });
    return h(`div.plg-card.nplg-failed.nplg-reason-${c.reason}`,
      h('div.plg-card-top',
        h('span.plg-badge', FORMAT_LABELS[f.format] || f.format),
        h('span.plg-badge.nplg-badge-fail', c.label),
        f.archs?.length ? h('span.plg-cat', f.archs.join(' / ')) : null),
      h('div.plg-card-name', { title: f.path }, baseName(f.path)),
      h('div.plg-card-desc.nplg-error', c.detail),
      c.hint ? h('div.nplg-hint', c.hint) : null,
      h('div.plg-actions', retry,
        fixCmd ? button('Copy command', () => { navigator.clipboard?.writeText(fixCmd).then(() => setMsg('Copied. Paste it in Terminal, then press Retry.'), () => setMsg(fixCmd)); }, { cls: 'small', title: fixCmd }) : null,
        button('Block', () => savePrefs(setBlocked(prefs, { format: f.format, path: f.path }, true)), { cls: 'small', title: 'Never scan this bundle again' }),
        f.format !== 'au' ? logButton(f.format, f.path) : null));
  }

  function blockedCard(b) {
    return h('div.plg-card.nplg-failed.nplg-blocked',
      h('div.plg-card-top', h('span.plg-badge', FORMAT_LABELS[b.format] || b.format), h('span.plg-badge.nplg-badge-fail', 'Blocked')),
      h('div.plg-card-name', b.name || baseName(b.path) || b.key),
      h('div.plg-card-meta', { title: b.path || b.key }, b.path || b.key),
      h('div.plg-actions', button('Unblock', () => savePrefs(setBlocked(prefs, b, false)), { cls: 'small', primary: true, title: 'Scan and allow this plugin again' })));
  }

  const section = (title) => h('div.nplg-section', title);

  function draw() {
    clear(list);
    if (!data) { list.appendChild(h('div.plg-empty', 'Loading the plugin list…')); return; }
    const entries = new Map(catalogEntries({ plugins: data.plugins }).map((e) => [e.source.key, e]));
    const q = view.query.trim().toLowerCase();
    const matchQ = (s) => !q || String(s).toLowerCase().includes(q);
    const failed = (data.failed || []).filter((f) => (!view.format || f.format === view.format) && matchQ(`${f.path} ${f.error}`));
    const warnings = (data.warnings || []).filter((w) => (!view.format || w.format === view.format) && matchQ(w.path));
    if (view.show === 'blocked') {
      const bl = prefs.blocked.filter((b) => (!view.format || b.format === view.format) && matchQ(`${b.name} ${b.path} ${b.key}`));
      count.textContent = `${bl.length} blocked`;
      if (!bl.length) list.appendChild(h('div.plg-empty', 'Nothing is blocked. Block a plugin that crashes or misbehaves and daW³ will never scan or load it.'));
      for (const b of bl) list.appendChild(blockedCard(b));
      return;
    }
    const plugins = view.show === 'problems' ? [] : filterNativePlugins(data.plugins, prefs, { ...view, show: view.show === 'problems' ? 'all' : view.show });
    count.textContent = `${plugins.length} of ${data.plugins.length}${failed.length ? ` · ${failed.length} failed` : ''}`;
    const showProblems = view.show === 'all' || view.show === 'problems';
    if (showProblems && failed.length) {
      list.appendChild(section(`Could not be loaded (${failed.length})`));
      for (const f of failed) list.appendChild(failedCard(f));
    }
    if (showProblems && warnings.length && view.show === 'problems') {
      list.appendChild(section(`Loaded, but quarantined by macOS (${warnings.length})`));
      for (const w of warnings) list.appendChild(h('div.plg-card.nplg-failed.nplg-reason-quarantined', h('div.plg-card-top', h('span.plg-badge', FORMAT_LABELS[w.format] || w.format), h('span.plg-badge.nplg-badge-fail', 'Quarantined')), h('div.plg-card-name', { title: w.path }, baseName(w.path)), h('div.nplg-hint', w.message)));
    }
    if (plugins.length) {
      if (showProblems && failed.length) list.appendChild(section(`Installed (${plugins.length})`));
      for (const p of plugins) list.appendChild(pluginCard(p, entries.get(p.key)));
    } else if (view.show !== 'problems') {
      list.appendChild(h('div.plg-empty', data.plugins.length ? 'No plugins match.' : data.scannedAt ? 'No VST3, Audio Unit or CLAP plugins found in the standard plugin folders.' : 'Not scanned yet — press Rescan.'));
    } else if (!failed.length && !warnings.length) list.appendChild(h('div.plg-empty', 'No problems: every plugin loaded.'));
  }

  // live updates while the tab is open (scans started elsewhere, preference changes)
  const el = h('div.plg-tab.plg-catalog.nplg-tab',
    h('div.plg-toolbar', search, fmtSel, showSel, sortSel, count, rescanBtn, fullBtn),
    msg,
    h('div.aprefs-hint.nplg-folders', ''),
    list);
  const off = api.onEvent((ev) => {
    if (!el.isConnected) { off(); return; }
    if (ev?.event === 'plugins-changed' || ev?.event === 'plugin-prefs') reload();
    if (ev?.event === 'scan-progress') setMsg(`Scanning ${ev.done}/${ev.total}: ${baseName(ev.path)}`);
  });
  reload().then(() => {
    const f = data?.folders;
    if (f) el.querySelector('.nplg-folders').textContent = `Folders: ${[...(f.vst3 || []), ...(f.clap || [])].join(' · ')}${f.au?.length ? ' · Audio Units: system registry' : ''}`;
  });
  draw();
  setTimeout(() => search.focus(), 30);
  return el;
}
