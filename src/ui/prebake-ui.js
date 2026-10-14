// Prebake UI: helper libraries (Strudel code evaluated before your code — strudel.cc Settings → "prebake").
//
//   installPrebake(app)          app.prebake = manager (src/code/prebake.js), app.prebakeUi = { openManager, checkCode,
//                                rememberFor, button }; the project's prebake refs follow the open project
//   prebakePanel(app)            -> Node  the manager (add URL / paste / upload, enable, reorder, reload, functions)
//   openPrebakeManager(app)      modal around prebakePanel
//   prebakeButton(app)           -> Node  "Prebake ▾" toolbar button with a status dot
//   checkCodeNeedsPrebake(app, code) -> Promise<'ok'|'cancel'>  code calling undefined functions: offer the saved
//                                prebakes that define them, adding one, or going ahead anyway
import { h, icon } from './dom.js';
import { modal, button, confirmDialog, contextMenu, fileInput, toast } from './components.js';
import {
  createPrebakeManager, undefinedCalls, sourcesDefining, mergeProjectPrebake, normalizeProjectPrebake, parsePrebakeDocs, looksLikeHelperName,
} from '../code/prebake.js';
import { setPrebake, prebakeStatus, onPrebake, loadStrudel } from '../code/strudel-real.js';
import { evaluate } from '../code/strudel.js';

const STATE_LABEL = { none: 'No prebake', loading: 'Loading…', ok: 'Prebake loaded', error: 'Prebake has errors' };
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

export function installPrebake(app) {
  if (app.prebake) return app.prebake;
  const mgr = createPrebakeManager({
    engine: { setPrebake, prebakeStatus },
    confirmProjectUrl: (ref) => confirmDialog('Load this project’s prebake?',
      `This project uses the prebake helper library “${ref.name}” from ${ref.url}. Prebake code runs like the code in your tracks — load it only if you trust its source.`),
  });
  app.prebake = mgr;
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { console.warn('[prebake]', e); } } };
  mgr.subscribe(notify);
  // a prebake is there: load the engine now so it runs (and its status / functions show) before the first evaluation
  mgr.subscribe(() => { if (mgr.effective().length) loadStrudel(); });
  onPrebake(notify);
  const sync = () => { mgr.setProject(app.store.get()).catch((e) => console.warn('[prebake] project:', e)); };
  app.store.on?.('load', sync);
  app.store.on?.('change', sync);
  app.prebakeUi = {
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    openManager: () => openPrebakeManager(app),
    checkCode: (code) => checkCodeNeedsPrebake(app, code),
    rememberFor: (code) => rememberFor(app, code),
    button: () => prebakeButton(app),
  };
  mgr.start().catch((e) => console.warn('[prebake] start:', e));
  if (mgr.effective().length) loadStrudel();
  sync();
  return mgr;
}

/** Adds references to the prebakes `code` uses to the project (so the song opens with them). */
export function rememberFor(app, code) {
  const refs = app.prebake?.refsFor(code) || [];
  if (!refs.length) return false;
  const p = app.store.get();
  const next = mergeProjectPrebake(p.prebake, refs);
  if (next === p.prebake) return false;
  app.store.transact('Remember prebake', (pp) => { pp.prebake = next; }, { undo: false });
  return true;
}

// ------------------------------------------------------------------------------------------- toolbar button

export function prebakeButton(app) {
  const dot = h('span.pb-dot');
  const label = h('span', 'Prebake');
  const btn = h('button.btn.code-compact.pb-btn', { type: 'button', title: 'Prebake: helper libraries evaluated before your code (as strudel.cc Settings → prebake)' }, dot, label, icon('chevronDown', 12));
  const update = () => {
    const st = app.prebake.status();
    dot.className = `pb-dot pb-${st.state}`;
    const n = st.engine?.names?.length || 0;
    btn.title = `${STATE_LABEL[st.state]}${st.count ? ` — ${st.count} source${st.count > 1 ? 's' : ''}, ${n} name${n === 1 ? '' : 's'} defined` : ''}. Click to manage.`;
  };
  btn.addEventListener('click', (e) => {
    const st = app.prebake.status();
    const r = btn.getBoundingClientRect();
    const docs = app.prebake.docs();
    const items = [
      { header: `${STATE_LABEL[st.state]}${st.count ? ` · ${st.count} source${st.count > 1 ? 's' : ''}` : ''}` },
      { label: 'Manage prebakes…', icon: 'sliders', onClick: () => openPrebakeManager(app) },
      { label: 'Reload', icon: 'refresh', disabled: !st.count, onClick: () => app.prebake.reload().then(() => toast('Prebake reloaded', { level: 'success' })) },
    ];
    const errs = [...st.fetchErrors.map((x) => `${x.name}: ${x.message}`), ...st.evalErrors.flatMap((s) => s.errors.map((x) => `${s.name}${x.line ? ` line ${x.line}` : ''}: ${x.message}`))];
    if (errs.length) { items.push('-'); for (const x of errs.slice(0, 4)) items.push({ label: x.length > 90 ? `${x.slice(0, 88)}…` : x, icon: 'help', disabled: true }); }
    if (docs.length) {
      items.push('-', { header: `${docs.length} function${docs.length > 1 ? 's' : ''} defined` });
      for (const d of docs.slice(0, 14)) items.push({ label: d.signature, disabled: true });
      if (docs.length > 14) items.push({ label: `…and ${docs.length - 14} more (Manage…)`, disabled: true });
    }
    e.stopPropagation();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, items);
  });
  app.prebakeUi.onChange(update);
  update();
  return btn;
}

// ------------------------------------------------------------------------------------------- manager panel

export function openPrebakeManager(app) {
  const panel = prebakePanel(app);
  return new Promise((resolve) => {
    modal({ title: 'Prebake — helper libraries', body: panel, width: 760, cls: 'pb-modal', actions: [{ label: 'Done', primary: true }], onClose: () => { panel.dispose?.(); resolve(); } });
  });
}

export function prebakePanel(app) {
  const mgr = app.prebake;
  const root = h('div.pb-panel');
  const urlIn = h('input.pb-url', { type: 'url', placeholder: 'https://…/prebake.strudel (GitHub links are turned into raw links)', 'aria-label': 'Prebake URL' });
  const nameIn = h('input.pb-name', { type: 'text', placeholder: 'Name (optional)', 'aria-label': 'Prebake name' });
  const codeIn = h('textarea.pb-code', { rows: 5, placeholder: '// paste prebake code, e.g.\nregister(\'dub\', (x, pat) => pat.delay(x).delayfeedback(.6))', 'aria-label': 'Prebake code', spellcheck: false });
  for (const el of [urlIn, nameIn, codeIn]) el.addEventListener('keydown', (e) => e.stopPropagation());
  let busy = false;
  const run = async (fn) => {
    if (busy) return;
    busy = true; render();
    try { await fn(); } catch (e) { toast(String(e?.message || e), { level: 'error', timeout: 6000 }); } finally { busy = false; render(); }
  };
  const addUrl = () => run(async () => {
    const url = urlIn.value.trim();
    if (!/^https?:\/\//.test(url)) throw new Error('Enter an http(s) URL');
    const s = await mgr.add({ url, name: nameIn.value.trim() || undefined });
    urlIn.value = ''; nameIn.value = '';
    toast(s.error ? `${s.name}: ${s.error}` : `Added “${s.name}”`, { level: s.error ? 'warn' : 'success', timeout: 5000 });
  });
  const addCode = () => run(async () => {
    await mgr.add({ code: codeIn.value, name: nameIn.value.trim() || undefined });
    codeIn.value = ''; nameIn.value = '';
  });
  const upload = () => run(async () => {
    const [f] = await fileInput('.strudel,.js,.txt,text/plain,text/javascript');
    if (!f) return;
    await mgr.add({ code: await f.text(), name: f.name });
  });
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl(); });

  const project = () => app.store.get();
  const inProject = (s) => normalizeProjectPrebake(project().prebake).some((r) => (s.url ? r.url === s.url : r.code === s.code));
  const setInProject = (s, on) => {
    app.store.transact(on ? 'Add prebake to project' : 'Remove prebake from project', (p) => {
      const cur = normalizeProjectPrebake(p.prebake).filter((r) => (s.url ? r.url !== s.url : r.code !== s.code));
      if (on) cur.push(s.url ? { name: s.name, url: s.url } : { name: s.name, code: s.code });
      if (cur.length) p.prebake = cur; else delete p.prebake;
    });
  };

  function sourceRow(s, i, n) {
    const eng = (mgr.status().engine?.sources || []).find((x) => x.id === s.id);
    const docs = s.code ? parsePrebakeDocs(s.code, s.name) : [];
    const en = h('input', { type: 'checkbox', title: 'Enabled (evaluated before your code)', 'aria-label': `Enable ${s.name}` });
    en.checked = !!s.enabled;
    en.addEventListener('change', () => mgr.setEnabled(s.id, en.checked));
    const proj = h('input', { type: 'checkbox', title: 'Save a reference in this project (it opens with this prebake loaded)' });
    proj.checked = inProject(s);
    proj.addEventListener('change', () => setInProject(s, proj.checked));
    const msgs = [];
    if (s.error) msgs.push(h(`div.pb-msg${s.stale ? '.warn' : '.err'}`, s.error));
    for (const x of eng?.errors || []) msgs.push(h('div.pb-msg.err', `${x.line ? `line ${x.line}: ` : ''}${x.message}`));
    for (const w of eng?.warnings || []) msgs.push(h('div.pb-msg.warn', w));
    const fnList = docs.length ? h('details.pb-fns', h('summary', `${docs.length} function${docs.length > 1 ? 's' : ''}: ${docs.slice(0, 8).map((d) => d.name).join(', ')}${docs.length > 8 ? ', …' : ''}`),
      h('div.pb-fn-list', docs.map((d) => h('div.pb-fn', { title: [d.desc, d.example && `e.g. ${d.example}`].filter(Boolean).join('\n') }, h('code', d.signature), d.desc ? h('span.muted', ` — ${d.desc.length > 90 ? `${d.desc.slice(0, 88)}…` : d.desc}`) : null)))) : null;
    return h(`div.pb-row${s.enabled ? '' : '.off'}`,
      h('div.pb-row-main', en,
        h('div.pb-row-text', h('b', s.name), h('span.muted.pb-src', s.kind === 'url' ? s.url : 'pasted code'),
          h('span.muted.pb-when', s.kind === 'url' ? `fetched ${ago(s.fetchedAt)}` : `${s.code.split('\n').length} lines`)),
        h('label.pb-proj', proj, 'in project'),
        h('div.pb-row-btns',
          h('button.btn.small', { type: 'button', title: 'Move up (evaluated earlier)', disabled: i === 0, onclick: () => mgr.move(s.id, -1) }, '↑'),
          h('button.btn.small', { type: 'button', title: 'Move down', disabled: i === n - 1, onclick: () => mgr.move(s.id, 1) }, '↓'),
          s.kind === 'url' ? h('button.btn.small', { type: 'button', title: 'Fetch again', onclick: () => run(() => mgr.reload(s.id)) }, icon('refresh', 12)) : null,
          h('button.btn.small', { type: 'button', title: 'Remove', onclick: () => mgr.remove(s.id) }, icon('trash', 12)))),
      msgs, fnList);
  }

  function render() {
    const st = mgr.status();
    const list = mgr.sources();
    const projOnly = mgr.projectSources().filter((s) => !list.some((u) => (s.url && u.url === s.url) || (u.code && u.code === s.code)));
    const names = st.engine?.names || [];
    root.replaceChildren(...[
      h('p.muted.pb-help', 'A prebake is Strudel code evaluated before your code — helper functions (register(…), window.fn = …) that your patterns can call, as in strudel.cc Settings → prebake. It runs once when it changes, in every code path (Code tab, Song, split import, render, Setlist, Pocket). Errors in a prebake never stop your code.'),
      h(`div.pb-status.pb-${st.state}`, h('span.pb-dot', { class: `pb-${st.state}` }), h('b', STATE_LABEL[st.state]),
        st.count ? h('span.muted', ` — ${st.count} source${st.count > 1 ? 's' : ''} active, ${names.length} name${names.length === 1 ? '' : 's'} defined`) : null,
        h('div.spacer'), h('button.btn.small', { type: 'button', disabled: busy || !list.some((s) => s.kind === 'url'), onclick: () => run(() => mgr.reload()) }, icon('refresh', 12), 'Reload all')),
      list.length ? h('div.pb-list', list.map((s, i) => sourceRow(s, i, list.length))) : h('p.muted.pb-empty', 'No prebakes yet — add one below.'),
      projOnly.length ? h('div.pb-list', h('div.pb-subhead', 'From this project'), projOnly.map((s) => h('div.pb-row', h('div.pb-row-main', h('div.pb-row-text', h('b', s.name), h('span.muted.pb-src', s.url || 'embedded code')),
        h('button.btn.small', { type: 'button', onclick: () => setInProject(s, false) }, 'Remove from project')), s.error ? h('div.pb-msg.err', s.error) : null))) : null,
      h('div.pb-add',
        h('div.pb-subhead', 'Add a prebake'),
        h('div.pb-add-row', urlIn, button('Add URL', addUrl, { icon: 'plus', primary: true })),
        h('div.pb-add-row', nameIn, button('Upload .strudel…', upload, { icon: 'upload' })),
        codeIn,
        h('div.pb-add-row', h('div.spacer'), button('Add pasted code', addCode, { icon: 'plus' }))),
      busy ? h('div.pb-busy.muted', 'Working…') : null].filter(Boolean));
  }
  const off = app.prebakeUi.onChange(() => { if (!root.contains(document.activeElement) || document.activeElement?.type === 'checkbox' || document.activeElement?.tagName === 'BUTTON') render(); });
  const offStore = app.store.on?.('change', () => { if (root.isConnected) render(); });
  root.dispose = () => { off(); if (typeof offStore === 'function') offStore(); };
  render();
  return root;
}

// ------------------------------------------------------------------------------------------- "needs a prebake?"

/**
 * Pasted / imported code that calls functions neither Strudel nor the loaded prebakes define: offers the saved
 * prebakes that define them, adding a prebake, or going ahead (the undefined calls are ignored and reported).
 * -> 'ok' (go ahead) | 'cancel'
 */
export async function checkCodeNeedsPrebake(app, code) {
  if (!(await loadStrudel())) return 'ok';
  let res;
  try { res = evaluate(code); } catch { return 'ok'; }
  const missing = undefinedCalls(res);
  if (!missing.length) return 'ok';
  missing.sort((a, b) => Number(looksLikeHelperName(b)) - Number(looksLikeHelperName(a)));
  const mgr = app.prebake;
  const active = new Set(mgr.effective().map((s) => s.code));
  const candidates = sourcesDefining(missing, mgr.sources().filter((s) => !active.has(s.code)));
  const choice = await new Promise((resolve) => {
    let result = 'cancel';
    const shown = missing.slice(0, 12).join(', ') + (missing.length > 12 ? ', …' : '');
    const body = h('div.col.pb-nudge',
      h('p', 'This code uses functions that aren’t defined: ', h('code', shown), ' — it probably needs a prebake (helper library).'),
      candidates.length ? h('div.pb-cands', h('div.pb-subhead', 'Your saved prebakes that define them'),
        candidates.map((c) => h('button.btn.pb-cand', { type: 'button', onclick: () => { mgr.setEnabled(c.source.id, true); result = 'retry'; m.close(); } },
          icon('plus', 12), `Use “${c.source.name}”`, h('span.muted', ` — defines ${c.names.slice(0, 6).join(', ')}${c.names.length > 6 ? ', …' : ''}${c.names.length < missing.length ? ` (${c.names.length} of ${missing.length})` : ''}`)))) : null,
      h('p.muted', 'Add the prebake by URL, paste or upload it, and the code will be checked again. “Continue anyway” imports the code with the undefined calls ignored (they are listed in the import report).'));
    const m = modal({
      title: 'This code may need a prebake', body, width: 560,
      actions: [
        { label: 'Cancel' },
        { label: 'Continue anyway', onClick: () => { result = 'ok'; } },
        { label: 'Add a prebake…', primary: !candidates.length, onClick: () => { result = 'manage'; } },
      ],
      onClose: () => resolve(result),
    });
  });
  if (choice === 'manage') { await openPrebakeManager(app); return checkCodeNeedsPrebake(app, code); }
  if (choice === 'retry') return checkCodeNeedsPrebake(app, code);
  return choice;
}

/**
 * Inline hint (Code tab) for applied code that calls undefined functions: the same choices as
 * checkCodeNeedsPrebake, without blocking. -> Node | null (nothing missing)
 */
export function prebakeHint(app, evaluated, { onDismiss } = {}) {
  const missing = undefinedCalls(evaluated);
  if (!missing.length || !app.prebake) return null;
  const mgr = app.prebake;
  const active = new Set(mgr.effective().map((s) => s.code));
  const candidates = sourcesDefining(missing, mgr.sources().filter((s) => !active.has(s.code)));
  return h('div.pb-hint',
    h('div.pb-hint-text', icon('help', 13), h('span', 'This code uses functions that aren’t defined: ', h('code', missing.slice(0, 10).join(', ') + (missing.length > 10 ? ', …' : '')), ' — it probably needs a prebake (helper library).')),
    h('div.pb-hint-btns',
      candidates.slice(0, 3).map((c) => h('button.btn.small.primary', { type: 'button', title: `Defines ${c.names.join(', ')}`, onclick: () => mgr.setEnabled(c.source.id, true) }, `Use “${c.source.name}”`)),
      h('button.btn.small', { type: 'button', onclick: () => openPrebakeManager(app) }, 'Add a prebake…'),
      h('button.btn.small', { type: 'button', onclick: () => onDismiss?.(missing) }, 'Dismiss')));
}
