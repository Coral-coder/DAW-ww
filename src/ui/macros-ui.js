// Action macros in the app (model: src/control/macros.js): stored in user settings (localStorage), each macro is a
// command `macro.<id>` — listed in the command palette (category "Macros"), bindable to a shortcut (its own keys
// field, also rebindable in Preferences → Shortcuts) — plus a manager dialog to record, compose, edit, run, import
// and export them as JSON.
import { h, icon } from './dom.js';
import { modal, button, iconButton, toast, fileInput, confirmDialog, numberField } from './components.js';
import { flattenMenu } from '../control/commands.js';
import { eventToChord, formatChord, fuzzyScore } from '../control/shortcuts.js';
import {
  normalizeMacro, serializeMacros, parseMacros, mergeMacros, createsCycle, runMacro, MacroRecorder, macroCommandId, UNRECORDABLE,
} from '../control/macros.js';
import { downloadBlob } from '../io/project-file.js';

const STORE_KEY = 'daw3-macros';

export function installMacros(app) {
  const reg = app.commands;
  if (!reg) return null;
  let macros = load();
  const recorder = new MacroRecorder();
  const originals = new Map(); // command id -> unwrapped run
  let indicator = null;
  const listeners = new Set();

  function load() { try { return parseMacros(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; } }
  function persist() { try { localStorage.setItem(STORE_KEY, serializeMacros(macros)); } catch { toast('Could not save macros (storage full?)', { level: 'error' }); } }
  const byId = (id) => macros.find((m) => m.id === id) || null;

  // record every command run (keys, palette, menus that go through commands)
  const wrap = (c) => {
    if (originals.has(c.id) || c.id.startsWith('macro.')) return;
    const orig = c.run;
    originals.set(c.id, orig);
    c.run = (...args) => { recorder.record(c.id, c.label); return orig.apply(c, args); };
  };
  for (const c of reg.list()) wrap(c);
  // view-scoped keys are dispatched by the views themselves (matchScope -> app.viewActions): record those too
  if (app.shortcuts?.matchScope && !app.shortcuts._macroWrapped) {
    const ms = app.shortcuts.matchScope.bind(app.shortcuts);
    app.shortcuts.matchScope = (e, scope, ctx) => {
      const c = ms(e, scope, ctx);
      if (c && !(e?.repeat && !c.repeat)) recorder.record(c.id, c.label);
      return c;
    };
    app.shortcuts._macroWrapped = true;
  }

  /** Every action a macro step can name: commands, main / Create / Add-track menu entries, other macros. */
  function entries() {
    const out = [];
    for (const c of reg.list()) if (c.palette !== false && !UNRECORDABLE.has(c.id)) out.push({ id: c.id, label: c.label, category: c.category });
    const menus = [['mainMenuItems', 'Menu'], ['generateMenuItems', 'Create'], ['addTrackMenuItems', 'Add track']];
    for (const [fn, prefix] of menus) { try { out.push(...flattenMenu(app.actions[fn]?.() || [], prefix).map((e) => ({ id: e.id, label: e.label, category: e.category, run: e.run }))); } catch { /* */ } }
    return out;
  }

  function resolve(cmd, depth) {
    if (cmd.startsWith('macro.')) {
      const m = byId(cmd.slice(6));
      return m ? () => runMacro(m, resolve, { depth }) : null;
    }
    const c = reg.get(cmd);
    if (c) { const run = originals.get(cmd) || c.run; return () => run.call(c); }
    if (cmd.startsWith('menu:')) { const e = entries().find((x) => x.id === cmd); return e?.run || null; }
    return null;
  }

  async function run(m) {
    const r = await runMacro(m, resolve, {});
    if (r.missing.length) toast(`Macro “${m.name}”: ${r.missing.length} step(s) are not available right now (${r.missing.slice(0, 2).join(', ')})`, { level: 'warn', timeout: 5000 });
    if (r.errors.length) toast(`Macro “${m.name}” stopped: ${r.errors[0].error?.message || r.errors[0].error}`, { level: 'error' });
    return r;
  }

  function register() {
    for (const c of reg.list()) if (c.id.startsWith('macro.') && !['macro.manager', 'macro.record'].includes(c.id) && !macros.some((m) => macroCommandId(m) === c.id)) reg.commands.delete(c.id);
    for (const m of macros) {
      const id = macroCommandId(m);
      reg.register({ id, label: `Macro: ${m.name}`, category: 'Macros', keys: m.keys || [], run: () => { recorder.record(id, `Macro: ${m.name}`); run(m); } });
    }
    reg.register({ id: 'macro.manager', label: 'Action macros…', category: 'Macros', keys: [], run: () => openManager() });
    reg.register({ id: 'macro.record', label: 'Record a macro (start / stop)', category: 'Macros', keys: [], run: () => (recorder.active ? stopRecording() : startRecording()) });
    for (const fn of listeners) fn();
  }

  function save(list) { macros = list; persist(); register(); }

  // ---------------------------------------------------------------- recording
  function startRecording() {
    recorder.start();
    indicator?.remove();
    const count = h('span.macro-rec-count', '0 steps');
    indicator = h('div.macro-rec', h('span.macro-rec-dot'), h('span', 'Recording macro'), count,
      button('Stop', () => stopRecording(), { cls: 'small', primary: true, title: 'Stop recording and name the macro' }),
      button('Cancel', () => { recorder.stop(); indicator?.remove(); indicator = null; }, { cls: 'small' }));
    indicator.count = count;
    document.body.appendChild(indicator);
    const poll = () => { if (!indicator || !recorder.active) return; count.textContent = `${recorder.steps.length} step${recorder.steps.length === 1 ? '' : 's'}`; setTimeout(poll, 300); };
    poll();
    toast('Recording: run commands with their shortcuts, menus or the command palette (Ctrl/⌘+K), then press Stop.', { timeout: 5000 });
  }
  function stopRecording() {
    const steps = recorder.stop();
    indicator?.remove();
    indicator = null;
    if (!steps.length) { toast('Nothing was recorded'); return; }
    openEditor({ name: `Macro ${macros.length + 1}`, steps, keys: [] }, true);
  }

  // ---------------------------------------------------------------- manager
  let mgr = null;
  function openManager() {
    mgr?.close();
    const list = h('div.macro-list');
    const render = () => {
      list.replaceChildren(...(macros.length ? macros.map((m) => h('div.macro-row',
        h('div.macro-row-main',
          h('div.macro-name', m.name),
          h('div.macro-steps', m.steps.map((s) => s.label.replace(/^Menu › /, '')).join(' → ') || 'No steps')),
        h('kbd.macro-key', app.shortcuts?.label(macroCommandId(m)) || '—'),
        iconButton('play', () => { mgr?.close(); run(m); }, 'Run'),
        iconButton('pencil', () => openEditor(m), 'Edit'),
        iconButton('copy', () => save([...macros, { ...normalizeMacro({ ...m, id: null, name: `${m.name} copy`, keys: [] }) }]) || render(), 'Duplicate'),
        iconButton('trash', async () => { if (await confirmDialog('Delete macro', `Delete “${m.name}”?`)) { save(macros.filter((x) => x.id !== m.id)); render(); } }, 'Delete'),
      )) : [h('div.macro-empty', icon('sparkles', 18), h('p', 'No macros yet. Record one (run commands while recording) or compose one from the list of actions.'))]));
    };
    render();
    const unl = () => render();
    listeners.add(unl);
    const body = h('div.macro-manager',
      h('div.macro-toolbar',
        button('Record', () => { mgr?.close(); startRecording(); }, { icon: 'record', cls: 'small', title: 'Record the commands you run next' }),
        button('New', () => openEditor({ name: `Macro ${macros.length + 1}`, steps: [], keys: [] }, true), { icon: 'plus', cls: 'small', title: 'Compose a macro from the list of actions' }),
        h('span.spacer'),
        button('Import…', () => importJson(), { icon: 'upload', cls: 'small', title: 'Import macros from a JSON file' }),
        button('Export…', () => exportJson(), { icon: 'download', cls: 'small', title: 'Save every macro as a JSON file' })),
      list,
      h('p.macro-hint', 'Macros run their steps in order. They are listed in the command palette (Ctrl/⌘+K) and can have their own shortcut (also in Preferences → Shortcuts). They are saved in this browser’s settings — export them to move them elsewhere.'));
    mgr = modal({ title: 'Action macros', body, width: 640, onClose: () => { listeners.delete(unl); mgr = null; } });
    return mgr;
  }

  async function importJson() {
    const files = await fileInput('.json,application/json');
    const f = files?.[0];
    if (!f) return;
    try {
      const incoming = parseMacros(await f.text());
      save(mergeMacros(macros, incoming));
      toast(`Imported ${incoming.length} macro${incoming.length === 1 ? '' : 's'}`, { level: 'success' });
    } catch (e) { toast(`Could not import: ${e.message}`, { level: 'error' }); }
  }
  function exportJson() {
    if (!macros.length) { toast('No macros to export'); return; }
    downloadBlob(new Blob([serializeMacros(macros)], { type: 'application/json' }), 'daw3-macros.json');
  }

  // ---------------------------------------------------------------- editor
  function openEditor(src, isNew = false) {
    const m = { ...normalizeMacro(src), steps: (src.steps || []).map((s) => ({ ...s })) };
    if (src.id && !isNew) m.id = src.id;
    const nameIn = h('input.macro-name-input', { type: 'text', value: m.name, placeholder: 'Macro name', spellcheck: false });
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    let keys = [...(m.keys || [])];
    const isMac = !!app.shortcuts?.isMac;
    const keyLbl = h('kbd.macro-key');
    const showKeys = () => { keyLbl.textContent = keys.length ? keys.map((k) => formatChord(k, { isMac })).join(' / ') : 'none'; };
    showKeys();
    const keyBtn = button('Set shortcut', () => {
      keyBtn.classList.add('listening');
      keyBtn.querySelector('span').textContent = 'Press keys… (Esc: cancel)';
      const onKey = (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Escape') { done(); return; }
        const chord = eventToChord(e, { isMac });
        if (!chord) return;
        const clash = app.shortcuts?.commandsFor(chord).filter((c) => c.id !== macroCommandId(m)) || [];
        keys = [chord];
        showKeys();
        if (clash.length) toast(`${formatChord(chord, { isMac })} is also bound to “${clash[0].label}” — the macro is used in its place only where that command is not scoped; change one of them in Preferences → Shortcuts.`, { level: 'warn', timeout: 6000 });
        done();
      };
      const done = () => { window.removeEventListener('keydown', onKey, true); keyBtn.classList.remove('listening'); keyBtn.querySelector('span').textContent = 'Set shortcut'; };
      window.addEventListener('keydown', onKey, true);
    }, { cls: 'small', icon: 'keyboard' });
    const clearKey = button('Clear', () => { keys = []; showKeys(); }, { cls: 'small' });

    const stepsEl = h('div.macro-steps-edit');
    const renderSteps = () => {
      stepsEl.replaceChildren(...(m.steps.length ? m.steps.map((s, i) => h('div.macro-step',
        h('span.macro-step-n', String(i + 1)),
        h('span.macro-step-label', { title: s.cmd }, s.label),
        h('span.macro-step-wait', { title: 'Wait before this step (ms)' }, numberField({ value: s.wait || 0, min: 0, max: 10000, step: 50, width: 64, format: (v) => `${v} ms`, onChange: (v) => { if (v > 0) s.wait = v; else delete s.wait; } })),
        iconButton('chevronDown', () => { if (i > 0) { [m.steps[i - 1], m.steps[i]] = [m.steps[i], m.steps[i - 1]]; renderSteps(); } }, 'Move up', `macro-up${i === 0 ? ' invisible' : ''}`),
        iconButton('chevronDown', () => { if (i < m.steps.length - 1) { [m.steps[i + 1], m.steps[i]] = [m.steps[i], m.steps[i + 1]]; renderSteps(); } }, 'Move down', i === m.steps.length - 1 ? 'invisible' : ''),
        iconButton('x', () => { m.steps.splice(i, 1); renderSteps(); }, 'Remove step'),
      )) : [h('div.macro-empty-steps', 'No steps yet — search for actions below and click them to add.')]));
    };
    renderSteps();

    const search = h('input.macro-search', { type: 'text', placeholder: 'Search actions to add (e.g. "mixer", "export stems", "loop")…', spellcheck: false });
    const results = h('div.macro-results');
    const all = () => [...entries(), ...macros.filter((x) => x.id !== m.id).map((x) => ({ id: macroCommandId(x), label: `Macro: ${x.name}`, category: 'Macros' }))];
    const renderResults = () => {
      const q = search.value.trim();
      const pool = all();
      const shown = q ? pool.map((e) => ({ e, s: Math.max(fuzzyScore(q, e.label), fuzzyScore(q, `${e.category} ${e.label}`) * 0.8) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.e) : pool.slice(0, 40);
      results.replaceChildren(...shown.map((e) => {
        const row = h('div.macro-result', h('span.ctl-palette-cat', e.category || ''), h('span', e.label));
        row.addEventListener('click', () => {
          if (createsCycle(m, e.id, byId)) { toast('A macro cannot run itself', { level: 'warn' }); return; }
          m.steps.push({ cmd: e.id, label: e.label });
          renderSteps();
        });
        return row;
      }));
    };
    search.addEventListener('input', renderResults);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    renderResults();

    const body = h('div.macro-editor',
      h('div.macro-ed-row', h('label', 'Name'), nameIn),
      h('div.macro-ed-row', h('label', 'Shortcut'), keyLbl, keyBtn, clearKey),
      h('div.macro-ed-sub', 'Steps'), stepsEl,
      h('div.macro-ed-sub', 'Add actions'), search, results);
    modal({
      title: isNew ? 'New macro' : `Edit macro · ${m.name}`, body, width: 680,
      actions: [{ label: 'Cancel' }, { label: 'Save macro', primary: true, onClick: () => {
        const out = normalizeMacro({ ...m, name: nameIn.value, keys });
        if (!out) { toast('Give the macro a name', { level: 'warn' }); return false; }
        if (!out.steps.length) { toast('Add at least one step', { level: 'warn' }); return false; }
        const i = macros.findIndex((x) => x.id === out.id);
        save(i >= 0 ? macros.map((x, k) => (k === i ? out : x)) : [...macros, out]);
        toast(`Macro “${out.name}” saved${out.keys.length ? ` (${formatChord(out.keys[0], { isMac })})` : ''} — find it in the command palette`, { level: 'success' });
        return true;
      } }],
    });
    setTimeout(() => nameIn.focus(), 30);
  }

  register();
  const api = {
    get list() { return macros; },
    run, openManager, openEditor, startRecording, stopRecording,
    get recording() { return recorder.active; },
    /** Palette hook: record palette entries that are not commands (menus run through their onClick). */
    notePaletteRun(e) { if (e?.menu || String(e?.id || '').startsWith('menu:')) recorder.record(e.id, e.label); },
    /** Commands registered after start-up become recordable too. */
    rewrap() { for (const c of reg.list()) wrap(c); },
    exportJson: () => serializeMacros(macros),
    importJson: (text, opts) => { const inc = parseMacros(text); save(mergeMacros(macros, inc, opts)); return inc.length; },
  };
  app.macros = api;
  return api;
}
