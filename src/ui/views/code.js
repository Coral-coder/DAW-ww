// Code view: Strudel-style live coding inside the DAW.
// Left: code tracks list. Main: editor (code-editor.js) + live punchcard visualisation.
// Right (optional): searchable function reference drawer.
import { h, icon, fitCanvas, cssVar, startDrag } from '../dom.js';
import { iconButton, button, contextMenu, toggle, select, toast, promptText } from '../components.js';
import { createCodeEditor, splitBlocks } from '../code-editor.js';
import { beatsPerBar } from '../../core/model.js';
import { isTyping } from '../keyboard.js';
import * as strudel from '../../code/strudel.js';

const LS_AUTO = 'heroic-code-autoapply';
const LS_VIZ_H = 'heroic-code-viz-h';
const LS_REF = 'heroic-code-ref-open';
const LS_WIN = 'heroic-code-viz-window';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

const SYNTH_WAVES = new Set(['sawtooth', 'saw', 'square', 'sine', 'triangle', 'tri', 'supersaw', 'pulse']);
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const midiName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

/** Pull a line number out of an evaluation error message (best effort). */
export function errorLineOf(err, code = '') {
  if (!err) return null;
  const s = String(err);
  let m = /line\s*:?\s*(\d+)/i.exec(s) || /\((\d+):(\d+)\)/.exec(s) || /:(\d+):(\d+)\)?\s*$/.exec(s);
  if (m) return Number(m[1]);
  // "at position N" / "offset N" -> convert char offset to line
  m = /(?:position|offset|index|char(?:acter)?)\s*:?\s*(\d+)/i.exec(s);
  if (m && code) return code.slice(0, Number(m[1])).split('\n').length;
  return null;
}

let modCache = null;
/** Optional modules (examples, reference, file IO) — loaded lazily so the view works without them. */
function loadOptionalModules() {
  if (modCache) return modCache;
  const imp = (p) => import(p).catch(() => ({}));
  modCache = Promise.all([imp('../../code/examples.js'), imp('../../code/docs.js'), imp('../../io/strudel-file.js'), imp('../../code/convert.js')])
    .then(([ex, docs, file, convert]) => ({ examples: ex.CODE_EXAMPLES || [], reference: docs.CODE_REFERENCE || [], file, convert }));
  return modCache;
}

function hashHue(str) {
  let x = 0;
  for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0;
  return ((x % 360) + 360) % 360;
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Small anchored popover; closes on outside click / Escape. Returns {el, close}. */
function popover(anchor, content, { width = 360, cls = '' } = {}) {
  document.querySelectorAll('.code-pop').forEach((p) => p.closePop?.());
  const el = h(`div.code-pop${cls ? '.' + cls : ''}`, { style: { width: width + 'px' } }, content);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  el.style.left = left + 'px';
  const top = r.bottom + 4;
  el.style.top = top + 'px';
  el.style.maxHeight = Math.max(200, window.innerHeight - top - 16) + 'px';
  const off = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() { el.remove(); window.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', key, true); }
  setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
  document.addEventListener('keydown', key, true);
  el.closePop = close;
  return { el, close };
}

export function createCodeView(app) {
  const { store, ui, engine, actions } = app;
  let visible = false;
  let trackId = null; // code track shown in the editor
  let lastCodeTrack = null;
  const drafts = new Map(); // trackId -> unapplied editor text
  const localErr = new Map(); // trackId -> {error, line} from local evaluate on apply
  const engineErr = new Map(); // trackId -> error string from engine 'code-error'
  const evalCache = new Map(); // code -> evaluated
  let autoApply = !!lsGet(LS_AUTO, false);
  let renderCycles = 4;
  let vizWindow = lsGet(LS_WIN, 2);
  let refOpen = !!lsGet(LS_REF, false);
  let opt = { examples: [], reference: [], file: {}, convert: {} };

  // ------------------------------------------------------------ evaluation helpers
  function evaluate(code) {
    if (evalCache.has(code)) return evalCache.get(code);
    let res;
    try {
      res = strudel.evaluate ? strudel.evaluate(code) : { patterns: [], cps: null, error: 'Code engine not available' };
    } catch (e) {
      res = { patterns: [], cps: null, error: String(e?.message || e) };
    }
    if (!res) res = { patterns: [], cps: null, error: 'Evaluation returned nothing' };
    if (evalCache.size > 60) evalCache.delete(evalCache.keys().next().value);
    evalCache.set(code, res);
    return res;
  }
  /** No line in the message? Evaluate growing prefixes of `$:` blocks to find the first failing block. */
  function locateErrorBlock(code) {
    const blocks = splitBlocks(code);
    if (blocks.length < 2) return null;
    for (let i = 0; i < blocks.length; i++) {
      const prefix = blocks.slice(0, i + 1).map((b) => b.text).join('');
      let err = null;
      try { err = strudel.evaluate(prefix)?.error; } catch (e) { err = String(e?.message || e); }
      if (err) {
        const b = blocks[i];
        const offset = b.text.search(/\S/);
        return code.slice(0, b.start + Math.max(0, offset)).split('\n').length;
      }
    }
    return null;
  }
  const codeTracks = () => store.get().tracks.filter((t) => t.type === 'code');
  const currentTrack = () => store.get().tracks.find((t) => t.id === trackId && t.type === 'code') || null;
  const bufferOf = (t) => (drafts.has(t.id) ? drafts.get(t.id) : t.code || '');
  const isDirty = (t) => !!t && drafts.has(t.id) && drafts.get(t.id) !== (t.code || '');

  // ------------------------------------------------------------ DOM: toolbar
  const playBtn = iconButton('play', () => actions.togglePlay(), 'Play / pause the whole project (Space)', 'code-play');
  const stopBtn = iconButton('stop', () => actions.stop(), 'Stop (Ctrl+.)');
  const applyBtn = button('Apply', () => applyNow(), { icon: 'play', title: 'Evaluate the code and apply it to the track (Ctrl+Enter / Shift+Enter). Alt+Enter applies only the block under the cursor.', cls: 'code-apply' });
  const autoToggle = toggle({ label: 'Auto', value: autoApply, title: 'Auto-apply: re-evaluate 600 ms after you stop typing — only when the code has no errors', onChange: (v) => { autoApply = v; lsSet(LS_AUTO, v); if (v) scheduleAuto(); } });
  const dirtyEl = h('span.code-dirty', { title: 'Editor state' });
  const examplesBtn = button('Examples', (e) => openExamples(e.currentTarget), { icon: 'sparkles', title: 'Load an example pattern (replace this track or open as a new track)' });
  const refBtn = button('Reference', () => setRefOpen(!refOpen), { icon: 'help', title: 'Function reference: every supported function with examples (click to insert)' });
  const importBtn = button('Import', (e) => openImportMenu(e.currentTarget), { icon: 'upload', title: 'Import a .strudel / .js / .txt file or paste code / a strudel.cc link (you can also drop files onto this view)' });
  importBtn.appendChild(icon('chevronDown', 12));
  const exportBtn = button('Export', (e) => openExportMenu(e.currentTarget), { icon: 'download', title: 'Download, copy or export the whole project as code' });
  exportBtn.appendChild(icon('chevronDown', 12));
  examplesBtn.appendChild(icon('chevronDown', 12));
  const cyclesSel = select({ options: [1, 2, 4, 8, 16].map((c) => ({ value: c, label: `${c} cycle${c > 1 ? 's' : ''}` })), value: renderCycles, title: 'How many cycles (bars) to render into patterns', onChange: (v) => { renderCycles = Number(v); } });
  const renderBtn = button('Render to tracks', () => { const t = currentTrack(); if (t) { if (isDirty(t)) applyNow(); actions.renderCodeToTracks(t.id, { cycles: renderCycles }); } }, { icon: 'layers', title: 'Expand this code into editable instrument/drum tracks with patterns (the code track gets muted)' });
  const fromProjectBtn = button('From project', () => actions.exportCode(), { icon: 'code', title: 'Convert the project\'s tracks & patterns into Strudel code (open it as a new code track)' });
  const tempoBtn = button('', () => adoptTempo(), { icon: 'metronome', title: 'This code sets its own tempo with setcps/setcpm — click to set the project BPM to match (1 cycle = 1 bar)', cls: 'code-tempo hidden' });
  const toolbar = h('div.view-toolbar.code-toolbar',
    playBtn, stopBtn, h('div.sep'), applyBtn, autoToggle, dirtyEl, h('div.sep'),
    examplesBtn, refBtn, h('div.sep'), importBtn, exportBtn, h('div.sep'),
    h('div.code-render', renderBtn, cyclesSel), fromProjectBtn, tempoBtn);

  // ------------------------------------------------------------ DOM: track list
  const listBody = h('div.code-list-body');
  const addBtn = iconButton('plus', () => newCodeTrack(), 'New code track');
  const listEl = h('div.code-list', h('div.code-list-header', h('span', 'Code tracks'), h('div.spacer'), addBtn), listBody,
    h('div.code-list-foot', h('button.code-link', { type: 'button', onclick: () => actions.importStrudel(), title: 'Import a .strudel file' }, icon('upload', 12), 'Import .strudel')));

  // ------------------------------------------------------------ DOM: editor + viz
  const errBar = h('div.code-errbar.hidden');
  const editor = createCodeEditor({
    placeholder: '// Type Strudel code, e.g.\n$: s("bd*4, ~ cp, hh*8")\n$: note("c2 eb2 g2 bb2").s("sawtooth").lpf(800)',
    onChange: onEditorChange,
    onApply: () => applyNow(),
    onApplyBlock: (text, info) => applyBlock(text, info),
    onStop: () => actions.stop(),
  });
  const hint = h('div.code-hint',
    h('span', h('kbd', 'Ctrl+Enter'), ' apply'), h('span', h('kbd', 'Alt+Enter'), ' apply block'), h('span', h('kbd', 'Ctrl+.'), ' stop'),
    h('span', h('kbd', 'Ctrl+/'), ' comment'), h('span', h('kbd', 'Tab'), ' indent'), h('div.spacer'), h('span.code-hint-info'));
  const hintInfo = hint.querySelector('.code-hint-info');

  const vizCanvas = h('canvas.code-viz-canvas');
  const vizInfo = h('span.code-viz-info');
  const winSel = select({ options: [1, 2, 4, 8].map((c) => ({ value: c, label: `${c} cycle${c > 1 ? 's' : ''}` })), value: vizWindow, title: 'Visible window', onChange: (v) => { vizWindow = Number(v); lsSet(LS_WIN, vizWindow); lastQueryKey = ''; vizDirty = true; } });
  const vizResizer = h('div.code-viz-resizer', { title: 'Drag to resize' });
  const vizEl = h('div.code-viz', { style: { height: lsGet(LS_VIZ_H, 190) + 'px' } }, vizResizer,
    h('div.code-viz-head', icon('grid', 13), h('b', 'Live pattern'), vizInfo, h('div.spacer'), h('span.muted', 'window'), winSel),
    h('div.code-viz-wrap', vizCanvas));
  vizResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const h0 = vizEl.offsetHeight;
    startDrag(e, (_dx, dy) => { const nh = Math.max(80, Math.min(520, h0 - dy)); vizEl.style.height = nh + 'px'; vizDirty = true; }, () => lsSet(LS_VIZ_H, vizEl.offsetHeight));
  });

  const editorWrap = h('div.code-editor-wrap', errBar, editor.el, hint);
  const mainEl = h('div.code-main', editorWrap, vizEl);

  // ------------------------------------------------------------ DOM: reference drawer
  const refSearch = h('input', { type: 'search', placeholder: 'Search functions…', title: 'Filter the reference' });
  const refList = h('div.code-ref-list');
  const refEl = h('div.code-ref', h('div.code-ref-head', icon('help', 14), h('b', 'Reference'), h('div.spacer'), iconButton('x', () => setRefOpen(false), 'Close reference')), h('div.code-ref-search', refSearch), refList);
  refSearch.addEventListener('input', renderReference);
  refSearch.addEventListener('keydown', (e) => e.stopPropagation());

  // ------------------------------------------------------------ DOM: empty state
  const emptyEl = h('div.code-empty');

  const dropOverlay = h('div.code-drop.hidden', h('div', icon('upload', 28), h('b', 'Drop a .strudel / .js / .txt file'), h('span', 'It opens as a new code track')));
  const body = h('div.code-body', listEl, mainEl, refEl, emptyEl);
  const el = h('div.code-view', toolbar, body, dropOverlay);

  // ------------------------------------------------------------ track selection
  function resolveTrack() {
    const tracks = codeTracks();
    const sel = ui.get('selectedTrackId');
    let t = tracks.find((x) => x.id === sel) || tracks.find((x) => x.id === trackId) || tracks.find((x) => x.id === lastCodeTrack) || tracks[0] || null;
    return t;
  }

  function showTrack(t) {
    const changed = (t?.id || null) !== trackId;
    trackId = t?.id || null;
    if (t) lastCodeTrack = t.id;
    if (changed && t) {
      editor.setValue(bufferOf(t));
      lastQueryKey = '';
      vizDirty = true;
    } else if (t && !isDirty(t) && editor.getValue() !== (t.code || '')) {
      // external change (undo, other view) while editor is clean -> follow it
      drafts.delete(t.id);
      editor.setValue(t.code || '');
      lastQueryKey = '';
      vizDirty = true;
    }
  }

  function newCodeTrack(code, name) {
    const t = actions.addTrack('code', code !== undefined ? { code, name } : {});
    if (t) { actions.selectTrack(t.id); setTimeout(() => editor.focus(), 30); }
    return t;
  }

  // ------------------------------------------------------------ rendering
  function render() {
    const tracks = codeTracks();
    const t = resolveTrack();
    showTrack(t);
    const empty = !tracks.length;
    el.classList.toggle('is-empty', empty);
    if (empty) renderEmpty();
    renderList(tracks);
    renderStatus();
    refEl.classList.toggle('hidden', !refOpen || empty);
    refBtn.classList.toggle('on', refOpen);
    for (const b of [applyBtn, renderBtn, exportBtn, autoToggle, cyclesSel]) b.disabled = empty;
  }

  function renderList(tracks) {
    listBody.replaceChildren(...tracks.map((t) => {
      const err = localErr.get(t.id)?.error || engineErr.get(t.id);
      const dirty = isDirty(t);
      const m = h(`button.code-ms${t.mute ? '.on' : ''}`, { type: 'button', title: t.mute ? 'Unmute' : 'Mute' }, 'M');
      const s = h(`button.code-ms.solo${t.solo ? '.on' : ''}`, { type: 'button', title: t.solo ? 'Unsolo' : 'Solo' }, 'S');
      m.addEventListener('click', (e) => { e.stopPropagation(); actions.updateTrack(t.id, (tt) => { tt.mute = !tt.mute; }, t.mute ? 'Unmute' : 'Mute'); });
      s.addEventListener('click', (e) => { e.stopPropagation(); actions.updateTrack(t.id, (tt) => { tt.solo = !tt.solo; }, t.solo ? 'Unsolo' : 'Solo'); });
      const statusDot = h(`span.code-dot${err ? '.err' : dirty ? '.dirty' : '.ok'}`, { title: err ? `Error: ${err}` : dirty ? 'Unsaved changes' : 'Applied' });
      const lines = (t.code || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
      const row = h(`div.code-item${t.id === trackId ? '.active' : ''}${t.mute ? '.muted' : ''}`, { title: 'Click to edit · double-click to rename · right-click for more', tabIndex: 0 },
        h('span.track-color', { style: { background: t.color } }),
        h('div.code-item-main', h('div.code-item-name', statusDot, h('span', t.name)), h('div.code-item-meta', `${lines} line${lines === 1 ? '' : 's'}${dirty ? ' · edited' : ''}`)),
        m, s);
      row.addEventListener('click', () => { actions.selectTrack(t.id); });
      row.addEventListener('dblclick', () => actions.renameTrack(t.id));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Apply code', icon: 'play', onClick: () => { actions.selectTrack(t.id); setTimeout(applyNow, 0); } },
        { label: 'Render to tracks', icon: 'layers', onClick: () => actions.renderCodeToTracks(t.id, { cycles: renderCycles }) },
        { label: 'Download .strudel', icon: 'download', onClick: () => downloadCode(t) },
        '-',
        ...actions.trackMenuItems(t.id),
      ]));
      return row;
    }));
  }

  function renderEmpty() {
    const exList = h('div.code-empty-examples');
    loadOptionalModules().then((o) => {
      exList.replaceChildren(...o.examples.slice(0, 8).map((ex) => {
        const b = h('button.code-ex-card', { type: 'button', title: ex.code }, h('b', ex.name), h('span', ex.genre || ''));
        b.addEventListener('click', () => newCodeTrack(ex.code, ex.name));
        return b;
      }));
    });
    emptyEl.replaceChildren(h('div.empty-state',
      icon('code', 34),
      h('h3', 'Live-code your music'),
      h('p', 'Code tracks play Strudel-style patterns alongside the rest of your project. Write mini-notation like ', h('code', 's("bd*4, ~ cp")'), ', import a .strudel file from strudel.cc, or start from an example.'),
      h('div.row.wrap', { style: { justifyContent: 'center' } },
        button('New code track', () => newCodeTrack(), { icon: 'plus', primary: true, title: 'Create an empty code track' }),
        button('Import .strudel file', () => actions.importStrudel(), { icon: 'upload', title: 'Open a .strudel / .js / .txt file' }),
        button('Project → code', () => actions.exportCode(), { icon: 'code', title: 'Turn the current project into Strudel code' })),
      h('div.section-title', 'Or start from an example'), exList,
      h('p.muted', { style: { fontSize: '12px' } }, 'Tip: drop .strudel files anywhere on this view.')));
  }

  function renderStatus() {
    const t = currentTrack();
    const dirty = isDirty(t);
    const le = t && localErr.get(t.id);
    const ee = t && engineErr.get(t.id);
    const err = le?.error || ee;
    dirtyEl.className = 'code-dirty' + (err ? ' err' : dirty ? ' dirty' : t ? ' ok' : '');
    dirtyEl.textContent = !t ? '' : err ? '● Error' : dirty ? '● Unsaved changes — Ctrl+Enter to apply' : '● Applied';
    applyBtn.classList.toggle('primary', !!dirty);
    if (err) {
      const line = le?.line ?? errorLineOf(err, t.code);
      errBar.replaceChildren(icon('x', 13), h('b', line ? `Line ${line}: ` : 'Error: '), h('span', String(err)),
        h('span.code-errbar-src', le ? 'evaluation' : 'engine'),
        h('span.muted', ' — the last working version keeps playing.'));
      errBar.classList.remove('hidden');
      editor.setErrorLine(line);
    } else {
      errBar.classList.add('hidden');
      editor.setErrorLine(null);
    }
    // tempo adoption
    const res = t ? evaluate(t.code || '') : null;
    const cps = res && !res.error ? res.cps : null;
    if (cps) {
      const bpb = beatsPerBar(store.get());
      const bpm = Math.round(cps * 60 * bpb * 100) / 100;
      tempoBtn.classList.toggle('hidden', Math.abs(bpm - store.get().bpm) < 0.01);
      tempoBtn.querySelector('span:not(.icon)')?.remove();
      tempoBtn.appendChild(h('span', `Adopt ${+cps.toFixed(4)} cps → ${bpm} BPM`));
    } else tempoBtn.classList.add('hidden');
    const nPat = res && !res.error ? (res.patterns?.length || 0) : 0;
    hintInfo.textContent = t ? `${t.name}${t.mute ? ' (muted)' : ''} · ${nPat} pattern${nPat === 1 ? '' : 's'}${cps ? ` · ${+cps.toFixed(3)} cps` : ''}` : '';
  }

  // ------------------------------------------------------------ apply
  function commit(code, { label = 'Edit code', coalesce = false } = {}) {
    const t = currentTrack();
    if (!t) return null;
    const res = evaluate(code);
    if (res.error) localErr.set(t.id, { error: res.error, line: errorLineOf(res.error, code) ?? locateErrorBlock(code) });
    else { localErr.delete(t.id); engineErr.delete(t.id); }
    if ((t.code || '') !== code) actions.updateTrack(t.id, (tt) => { tt.code = code; }, label, { coalesce });
    if (drafts.get(t.id) === code) drafts.delete(t.id);
    lastQueryKey = '';
    vizDirty = true;
    renderStatus();
    renderList(codeTracks());
    return res;
  }

  function applyNow() {
    const t = currentTrack();
    if (!t) return;
    const code = editor.getValue();
    drafts.set(t.id, code);
    const res = commit(code, { label: 'Apply code' });
    if (!res) return;
    if (res.error) {
      app.setStatus?.(`Code error in "${t.name}": ${res.error}`);
    } else {
      app.setStatus?.(`Applied "${t.name}" — ${res.patterns?.length || 0} pattern(s)${t.mute ? ' (track is muted)' : ''}.`);
      if (!engine.isPlaying) actions.play?.();
    }
  }

  function applyBlock(text, { index, blocks }) {
    const t = currentTrack();
    if (!t) return;
    const applied = splitBlocks(t.code || '');
    let code = text;
    if (applied.length === blocks.length) {
      code = applied.map((b, i) => (i === index ? blocks[i].text : b.text)).join('');
    }
    drafts.set(t.id, text);
    const res = commit(code, { label: 'Apply code block' });
    if (res && code !== text) drafts.set(t.id, text);
    if (res && !res.error) {
      app.setStatus?.(`Applied block ${index + 1} of ${blocks.length}${code !== text ? ' — other edits are still pending' : ''}.`);
      if (!engine.isPlaying) actions.play?.();
    }
    renderStatus();
    renderList(codeTracks());
  }

  let autoTimer = null;
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!autoApply) return;
    autoTimer = setTimeout(() => {
      const t = currentTrack();
      if (!t || !isDirty(t)) return;
      const code = editor.getValue();
      const res = evaluate(code);
      if (!res.error) commit(code, { label: 'Edit code', coalesce: true });
      else { hintInfo.textContent = 'Auto-apply paused: ' + res.error; }
    }, 600);
  }

  function onEditorChange(text) {
    const t = currentTrack();
    if (!t) return;
    if (text === (t.code || '')) drafts.delete(t.id); else drafts.set(t.id, text);
    renderStatus();
    // update the tiny "edited" marker without rebuilding on every keystroke
    const row = listBody.querySelector('.code-item.active .code-dot');
    if (row && !row.classList.contains('err')) row.className = 'code-dot' + (isDirty(t) ? ' dirty' : ' ok');
    editor.setMarks([]);
    scheduleAuto();
  }

  function adoptTempo() {
    const t = currentTrack();
    const res = t && evaluate(t.code || '');
    if (!res?.cps) return;
    const bpb = beatsPerBar(store.get());
    const bpm = Math.round(res.cps * 60 * bpb * 100) / 100;
    store.transact('Adopt code tempo', (p) => { p.bpm = Math.max(20, Math.min(400, bpm)); });
    toast(`Project tempo set to ${bpm} BPM (${res.cps} cycles/sec × ${bpb} beats per cycle × 60)`, { level: 'success' });
  }

  // ------------------------------------------------------------ export / examples / reference
  async function downloadCode(t) {
    const o = await loadOptionalModules();
    const code = t.id === trackId ? editor.getValue() : t.code || '';
    const name = (t.name || 'pattern').replace(/[^\w\- ]+/g, '').trim() || 'pattern';
    if (typeof o.file.downloadStrudel === 'function') {
      try { o.file.downloadStrudel(code, name); return; } catch (e) { console.warn(e); }
    }
    downloadText(code, `${name}.strudel`);
  }

  function openImportMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {} }, [
      { header: 'Import as a new code track' },
      { label: 'Open .strudel / .js / .txt file…', icon: 'folder', onClick: () => actions.importStrudel() },
      { label: 'Paste code or strudel.cc link…', icon: 'code', onClick: async () => {
        const text = await promptText('Paste Strudel code or a strudel.cc share link', '', { multiline: true, placeholder: 'https://strudel.cc/#…  or  s("bd sd")' });
        if (text && text.trim()) actions.importStrudel(new File([text.trim()], 'pasted.strudel', { type: 'text/plain' }));
      } },
    ]);
  }

  function openExportMenu(anchor) {
    const t = currentTrack();
    const r = anchor.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {} }, [
      { header: 'This track' },
      { label: 'Download .strudel', icon: 'download', disabled: !t, onClick: () => downloadCode(t) },
      { label: 'Copy code to clipboard', icon: 'copy', disabled: !t, onClick: async () => {
        try { await navigator.clipboard.writeText(editor.getValue()); toast('Code copied — paste it into strudel.cc or share it', { level: 'success' }); } catch { toast('Clipboard not available', { level: 'warn' }); }
      } },
      { label: 'Open in strudel.cc', icon: 'code', disabled: !t, onClick: async () => {
        const o = await loadOptionalModules();
        const code = editor.getValue();
        let url;
        try { url = o.file.codeToShareUrl ? o.file.codeToShareUrl(code) : 'https://strudel.cc/#' + btoa(unescape(encodeURIComponent(code))); } catch { return; }
        window.open(url, '_blank', 'noopener');
      } },
      '-',
      { header: 'Project' },
      { label: 'Export whole project as code…', icon: 'layers', onClick: () => actions.exportCode() },
    ]);
  }

  async function openExamples(anchor) {
    const o = await loadOptionalModules();
    const search = h('input', { type: 'search', placeholder: 'Search examples…' });
    const list = h('div.code-pop-list');
    const t = currentTrack();
    const draw = () => {
      const q = search.value.toLowerCase();
      const items = o.examples.filter((ex) => !q || `${ex.name} ${ex.genre} ${ex.code}`.toLowerCase().includes(q));
      if (!items.length) { list.replaceChildren(h('div.muted.code-pop-empty', o.examples.length ? 'No matches' : 'No examples available yet.')); return; }
      list.replaceChildren(...items.map((ex) => {
        const lines = ex.code.split('\n').map((l) => l.trim());
        const desc = (lines.find((l) => l.startsWith('//')) || '').replace(/^\/\/\s*/, '');
        const preview = lines.find((l) => l && !l.startsWith('//') && !/^(setcp[ms]?|setbpm|samples)\(/.test(l)) || '';
        const replaceB = h('button.btn.small', { type: 'button', title: t ? `Replace the code of "${t.name}" (undoable)` : 'Select a code track first', disabled: !t }, 'Replace');
        const newB = h('button.btn.small.primary', { type: 'button', title: 'Open as a new code track' }, 'New track');
        replaceB.addEventListener('click', () => { pop.close(); editor.setValue(ex.code); drafts.set(t.id, ex.code); commit(ex.code, { label: `Load example ${ex.name}` }); });
        newB.addEventListener('click', () => { pop.close(); newCodeTrack(ex.code, ex.name); });
        return h('div.code-pop-item', h('div.code-pop-text', h('div', h('b', ex.name), ex.genre ? h('span.chip', ex.genre) : null), desc ? h('span.code-pop-desc', desc) : null, h('code', preview.slice(0, 80))), h('div.code-pop-btns', replaceB, newB));
      }));
    };
    search.addEventListener('input', draw);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    draw();
    const pop = popover(anchor, h('div.col', search, list), { width: 420 });
    setTimeout(() => search.focus(), 20);
  }

  function setRefOpen(v) {
    refOpen = v;
    lsSet(LS_REF, v);
    refEl.classList.toggle('hidden', !v || el.classList.contains('is-empty'));
    refBtn.classList.toggle('on', v);
    if (v) { renderReference(); setTimeout(() => refSearch.focus(), 20); }
    vizDirty = true;
  }

  function renderReference() {
    const q = refSearch.value.toLowerCase().trim();
    const items = opt.reference.filter((r) => !q || `${r.name} ${r.signature} ${r.description}`.toLowerCase().includes(q));
    if (!opt.reference.length) { refList.replaceChildren(h('p.muted', 'Reference not available yet.')); return; }
    refList.replaceChildren(...items.slice(0, 200).map((r) => {
      const ex = h('pre.code-ref-ex', { title: 'Click to insert this example at the cursor' }, r.example || '');
      const item = h('details.code-ref-item', h('summary', h('code', r.name), h('span.muted', r.signature && r.signature !== r.name ? r.signature.replace(r.name, '').slice(0, 40) : '')),
        h('p', r.description || ''), r.example ? ex : null,
        r.example ? h('div.row', h('button.btn.small', { type: 'button', onclick: () => editor.insertAtCursor(r.example), title: 'Insert the example at the cursor' }, icon('plus', 12), 'Insert'),
          h('button.btn.small', { type: 'button', onclick: () => editor.insertAtCursor(r.name), title: 'Insert just the function name' }, 'Name')) : null);
      ex.addEventListener('click', () => editor.insertAtCursor(r.example));
      if (q && items.length < 6) item.open = true;
      return item;
    }));
  }

  // ------------------------------------------------------------ visualisation
  let vizDirty = true;
  let lastQueryKey = '';
  let cached = { events: [], rows: [], c0: 0, c1: 1 };
  let lastMarksKey = '';
  let colors = null;
  const readColors = () => {
    colors = { bg: cssVar('--bg'), bg2: cssVar('--bg-2'), bg3: cssVar('--bg-3'), line: cssVar('--line'), text: cssVar('--text'), text2: cssVar('--text-2'), text3: cssVar('--text-3'), accent: cssVar('--accent'), accent2: cssVar('--accent-2'), bar: cssVar('--grid-bar'), beat: cssVar('--grid-beat'), mono: cssVar('--mono') || 'monospace', font: cssVar('--font') || 'sans-serif', light: document.documentElement.dataset.theme === 'light' };
  };

  function eventLabel(v) {
    if (!v || typeof v !== 'object') return { key: String(v), label: String(v), pitch: null };
    const note = typeof v.note === 'number' ? v.note : (typeof v.freq === 'number' ? 69 + 12 * Math.log2(v.freq / 440) : null);
    const s = v.s ?? v.sound;
    if (note != null && Number.isFinite(note)) return { key: 'p' + Math.round(note), label: midiName(note), pitch: Math.round(note), sound: s };
    if (typeof v.note === 'string') return { key: 'n' + v.note, label: v.note, pitch: null, sound: s };
    if (s != null) {
      const n = v.n != null && !SYNTH_WAVES.has(String(s)) ? `:${v.n}` : (v.n != null ? ` ${v.n}` : '');
      return { key: 's' + s + n, label: String(s) + n, pitch: null, sound: s };
    }
    if (v.n != null) return { key: 'n' + v.n, label: 'n ' + v.n, pitch: null };
    return { key: '?', label: '·', pitch: null };
  }

  const lastGood = new Map(); // trackId -> last evaluated result without errors (what the engine keeps playing)
  function queryWindow(t, c0, c1) {
    let res = evaluate(t.code || '');
    if (!res.error) lastGood.set(t.id, res);
    else res = lastGood.get(t.id);
    if (!res || !strudel.queryEvents) return [];
    try { return strudel.queryEvents(res, c0, c1) || []; } catch (e) { return []; }
  }

  function computeView(t, pos) {
    const bpb = beatsPerBar(store.get());
    const cyc = pos / bpb;
    const win = vizWindow;
    const c0 = Math.floor(cyc / win) * win;
    const c1 = c0 + win;
    const key = `${t.id}|${t.code}|${c0}|${c1}`;
    if (key !== lastQueryKey) {
      lastQueryKey = key;
      const raw = queryWindow(t, c0, c1);
      const rowMap = new Map();
      const events = raw.map((e) => {
        const lab = eventLabel(e.value);
        if (!rowMap.has(lab.key)) rowMap.set(lab.key, { ...lab, first: e.begin });
        const end = Number.isFinite(e.end) && e.end > e.begin ? e.end : e.begin + 0.125;
        return { begin: e.begin, end, key: lab.key, value: e.value, locs: e.locations || e.value?.locations || e.context?.locations || null };
      });
      // drums/samples first (by first appearance), then pitched rows high -> low
      const rows = [...rowMap.values()].sort((a, b) => {
        if ((a.pitch == null) !== (b.pitch == null)) return a.pitch == null ? -1 : 1;
        if (a.pitch != null) return b.pitch - a.pitch;
        return a.first - b.first;
      });
      cached = { events, rows, rowIndex: new Map(rows.map((r, i) => [r.key, i])), c0, c1 };
    }
    return { cyc, ...cached };
  }

  function drawViz() {
    const t = currentTrack();
    if (!colors) readColors();
    const { ctx, w, h: H } = fitCanvas(vizCanvas);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, H);
    if (!t) return;
    const pos = (() => { try { return engine.getPosition(); } catch { return 0; } })();
    const playing = !!engine.isPlaying;
    const v = computeView(t, pos);
    const { events, rows, rowIndex, c0, c1, cyc } = v;
    const labelW = Math.min(90, Math.max(48, ...rows.map((r) => r.label.length * 7 + 14)));
    const gx = labelW, gw = Math.max(10, w - labelW - 6);
    const nRows = Math.max(1, rows.length);
    const rowH = Math.max(6, Math.min(22, (H - 18) / nRows));
    const top = 16;
    const xOf = (c) => gx + ((c - c0) / (c1 - c0)) * gw;
    const bpb = beatsPerBar(store.get());
    // grid
    const monoFont = colors.mono;
    ctx.font = '10px ' + monoFont;
    for (let c = c0; c <= c1; c++) {
      for (let b = 0; b < bpb && c < c1; b++) {
        const x = Math.round(xOf(c + b / bpb)) + 0.5;
        ctx.strokeStyle = b === 0 ? colors.bar : colors.beat;
        ctx.beginPath(); ctx.moveTo(x, top - 2); ctx.lineTo(x, H); ctx.stroke();
      }
      if (c < c1) { ctx.fillStyle = colors.text3; ctx.fillText(`cycle ${c}`, xOf(c) + 4, 11); }
    }
    // rows
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      if (i % 2) { ctx.fillStyle = colors.light ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.025)'; ctx.fillRect(gx, y, gw, rowH); }
    });
    if (!events.length) {
      ctx.fillStyle = colors.text3;
      ctx.font = '12px ' + colors.font;
      const res = evaluate(t.code || '');
      ctx.fillText(res.error && !lastGood.has(t.id) ? 'Fix the error to see the pattern.' : (t.code || '').trim() ? 'No events in this window.' : 'Write some code and press Ctrl+Enter.', gx + 10, top + 20);
    }
    // events
    const active = [];
    for (const e of events) {
      const i = rowIndex.get(e.key);
      if (i == null) continue;
      const r = rows[i];
      const x0 = xOf(Math.max(c0, e.begin)), x1 = xOf(Math.min(c1, e.end));
      const y = top + i * rowH + 1;
      const hgt = Math.max(3, rowH - 2);
      const hue = r.pitch != null ? (r.pitch % 12) * 30 : hashHue(String(r.sound ?? r.label));
      const on = cyc >= e.begin && cyc < e.end;
      const past = cyc >= e.end;
      if (on) active.push(e);
      const light = colors.light;
      ctx.fillStyle = on ? `hsl(${hue} 95% ${light ? 45 : 68}%)` : `hsla(${hue} 75% ${light ? 45 : 58}% / ${past && playing ? 0.45 : 0.85})`;
      const ww = Math.max(2, x1 - x0 - 1);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0, y, ww, hgt, Math.min(3, hgt / 2)); else ctx.rect(x0, y, ww, hgt);
      ctx.fill();
      if (on) { ctx.save(); ctx.shadowColor = `hsl(${hue} 100% 60%)`; ctx.shadowBlur = 10; ctx.strokeStyle = light ? '#000' : '#fff'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore(); }
    }
    // labels
    ctx.fillStyle = colors.bg2;
    ctx.fillRect(0, 0, labelW - 2, H);
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      const hit = active.some((e) => e.key === r.key);
      ctx.fillStyle = hit ? colors.text : colors.text2;
      if (rowH >= 6) { ctx.font = `${Math.min(10, Math.floor(rowH))}px ${monoFont}`; ctx.fillText(r.label.slice(0, 12), 6, y + rowH / 2 + Math.min(10, rowH) * 0.35); }
      if (hit) { ctx.fillStyle = colors.accent2; ctx.fillRect(0, y + 1, 3, rowH - 2); }
    });
    // playhead
    if (cyc >= c0 && cyc <= c1) {
      const x = Math.round(xOf(cyc)) + 0.5;
      ctx.strokeStyle = playing ? colors.accent2 : colors.text3;
      ctx.lineWidth = playing ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.lineWidth = 1;
    }
    vizInfo.textContent = `${playing ? '▶' : '■'} cycle ${cyc.toFixed(2)} · ${rows.length} row${rows.length === 1 ? '' : 's'} · ${events.length} event${events.length === 1 ? '' : 's'} in view`;
    // Strudel-style source highlighting (when the engine reports source locations)
    updateMarks(t, playing ? active : []);
  }

  function updateMarks(t, active) {
    if (isDirty(t)) { if (lastMarksKey) { editor.setMarks([]); lastMarksKey = ''; } return; }
    const ranges = [];
    for (const e of active) {
      for (const l of e.locs || []) {
        const start = Array.isArray(l) ? l[0] : (l.start ?? l.from);
        const end = Array.isArray(l) ? l[1] : (l.end ?? l.to);
        if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end });
      }
    }
    const key = ranges.map((r) => r.start + '-' + r.end).join(',');
    if (key !== lastMarksKey) { lastMarksKey = key; editor.setMarks(ranges); }
  }

  let raf = 0;
  function loop() {
    raf = 0;
    if (!visible) return;
    if (engine.isPlaying || vizDirty) {
      vizDirty = false;
      try { drawViz(); } catch (e) { console.error('[code viz]', e); }
    }
    raf = requestAnimationFrame(loop);
  }
  const ro = new ResizeObserver(() => { vizDirty = true; });
  ro.observe(vizCanvas);

  // ------------------------------------------------------------ events
  app.subscribe((r) => {
    if ('theme' in r.ui) { colors = null; vizDirty = true; }
    if (!visible) return;
    if (r.project || 'selectedTrackId' in r.ui) {
      // drop stale drafts of deleted tracks
      const ids = new Set(codeTracks().map((t) => t.id));
      for (const id of drafts.keys()) if (!ids.has(id)) drafts.delete(id);
      render();
      vizDirty = true;
    }
  });
  engine.on?.('code-error', ({ trackId: id, error }) => {
    engineErr.set(id, error);
    if (visible) { renderStatus(); renderList(codeTracks()); }
  });
  engine.on?.('code-ok', ({ trackId: id }) => {
    if (!engineErr.has(id)) return;
    engineErr.delete(id);
    if (visible) { renderStatus(); renderList(codeTracks()); }
  });
  engine.on?.('state', () => { vizDirty = true; playBtn.replaceChildren(icon(engine.isPlaying ? 'pause' : 'play')); playBtn.classList.toggle('on', !!engine.isPlaying); });
  engine.on?.('position', () => { if (!engine.isPlaying) vizDirty = true; });

  // view-level shortcuts when focus is outside the editor
  window.addEventListener('keydown', (e) => {
    if (!visible || isTyping(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); applyNow(); }
    else if (mod && e.key === '.') { e.preventDefault(); e.stopImmediatePropagation(); actions.stop(); }
  });

  // drag & drop files
  let dragDepth = 0;
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; dragDepth++; dropOverlay.classList.remove('hidden'); });
  el.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOverlay.classList.add('hidden'); });
  el.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add('hidden');
    const files = [...e.dataTransfer.files];
    const ok = files.filter((f) => /\.(strudel|str|js|mjs|txt|tidal)$/i.test(f.name) || f.type.startsWith('text/'));
    if (!ok.length) { toast('Drop .strudel, .js or .txt files here (audio files go into the Browser → Samples)', { level: 'warn' }); return; }
    for (const f of ok) await actions.importStrudel(f);
  });

  loadOptionalModules().then((o) => { opt = o; if (refOpen) renderReference(); if (visible) render(); });

  return {
    el,
    editor,
    show() {
      visible = true;
      colors = null;
      render();
      if (refOpen) renderReference();
      vizDirty = true;
      playBtn.replaceChildren(icon(engine.isPlaying ? 'pause' : 'play'));
      if (!raf) raf = requestAnimationFrame(loop);
    },
    hide() {
      visible = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.querySelectorAll('.code-pop').forEach((p) => p.closePop?.());
    },
  };
}
