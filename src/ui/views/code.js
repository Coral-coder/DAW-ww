// Code view: Strudel-style live coding inside the DAW.
// Left: "Song (live)" — the whole project as Strudel code, always in sync — then the code tracks.
// Main: editor (code-editor.js) with Strudel-style live highlighting of the sounding tokens +
// a live punchcard / piano-roll visualisation. Right (optional): searchable function reference.
import { h, icon, fitCanvas, cssVar, startDrag } from '../dom.js';
import { iconButton, button, contextMenu, toggle, select, toast, promptText, modal } from '../components.js';
import { createCodeEditor, splitBlocks } from '../code-editor.js';
import { attachCodeTools } from '../code-palette.js';
import { beatsPerBar, createProject, createTrack } from '../../core/model.js';
import { deepClone } from '../../core/util.js';
import { isTyping } from '../keyboard.js';
import * as strudel from '../../code/strudel.js';
import { songToCode, applySongCode } from '../../code/song-code.js';
import { songToLiveCode, applyLiveCode } from '../../code/livecoder.js';
import { PRESETS, DRUM_KITS } from '../../audio/index.js';

const LS_AUTO = 'daw3-code-autoapply';
const LS_VIZ_H = 'daw3-code-viz-h';
const LS_REF = 'daw3-code-ref-open';
const LS_WIN = 'daw3-code-viz-window';
const LS_STYLE = 'daw3-code-style'; // 'live' (live-coder sketch, default) | 'exact' (note-exact transcription)
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

const SONG = 'song';
const SONG_DEBOUNCE = 250;
const FADE_SEC = 0.32; // highlight fade-out after an event ends
const PULSE_SEC = 0.28; // gutter pulse after a block triggers
const LABEL_COLORS = ['#ffd43b', '#4dabf7', '#ff6b6b', '#38d9a9', '#9775fa', '#ffa94d', '#f783ac', '#3bc9db', '#a9e34b', '#e599f7'];
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

/** '#rrggbb' -> 'rgba(r,g,b,a)' (falls back to the colour itself). */
function rgba(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

const lineAt = (text, off) => { let n = 0; for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) n++; return n; };

export function createCodeView(app) {
  const { store, ui, engine, actions } = app;
  let visible = false;
  let entry = SONG; // SONG or the id of the code track shown in the editor
  let trackId = null; // code track shown (null while the Song is shown)
  const drafts = new Map(); // trackId -> unapplied editor text
  const localErr = new Map(); // trackId -> {error, line} from local evaluate on apply
  const engineErr = new Map(); // trackId -> error string from engine 'code-error'
  const evalCache = new Map(); // code -> evaluated
  let autoApply = !!lsGet(LS_AUTO, false);
  let renderCycles = 4;
  let vizWindow = lsGet(LS_WIN, 2);
  let refOpen = !!lsGet(LS_REF, false);
  let opt = { examples: [], reference: [], file: {}, convert: {} };

  // song (live) state
  let song = null; // songToCode(project) result
  let songDraft = null; // edited song code, not applied yet
  let songStale = false; // the project changed while the song was being edited
  let songErr = null; // {error, line}
  let songTimer = null;
  let songMeta = null; // derived: { res, labelBlock: [], bars: [] }
  let songBase = null; // the song code an edit started from (live-coder apply diffs against it)
  let codeStyle = lsGet(LS_STYLE, 'live') === 'exact' ? 'exact' : 'live';

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
        // point at the block's `$:` line (or its first real code line), not a leading comment
        const lines = b.text.split('\n');
        let li = lines.findIndex((l) => /^\s*(\$|[A-Za-z_]\w*):(?!:)/.test(l));
        if (li < 0) li = Math.max(0, lines.findIndex((l) => l.trim() && !l.trim().startsWith('//')));
        return code.slice(0, b.start).split('\n').length + li;
      }
    }
    return null;
  }
  const codeTracks = () => store.get().tracks.filter((t) => t.type === 'code');
  const currentTrack = () => (entry === SONG ? null : store.get().tracks.find((t) => t.id === trackId && t.type === 'code') || null);
  const bufferOf = (t) => (drafts.has(t.id) ? drafts.get(t.id) : t.code || '');
  const isDirty = (t) => !!t && drafts.has(t.id) && drafts.get(t.id) !== (t.code || '');
  const isSong = () => entry === SONG;
  const songText = () => songDraft ?? song?.code ?? '';

  // ------------------------------------------------------------ song (live) generation
  function regenSong() {
    clearTimeout(songTimer);
    songTimer = null;
    let next;
    try { next = codeStyle === 'live' ? songToLiveCode(store.get()) : songToCode(store.get()); } catch (e) { console.error('[song code]', e); return; }
    const changed = !song || next.code !== song.code;
    song = next;
    if (!changed) return;
    songMeta = null;
    if (songDraft !== null) {
      songStale = true;
    } else if (visible && isSong() && editor.getValue() !== song.code) {
      editor.setValue(song.code); // keeps scroll position and cursor
      lastQueryKey = '';
      vizDirty = true;
    }
    if (visible) { renderStatus(); renderList(codeTracks()); }
  }
  function scheduleSongRegen() {
    clearTimeout(songTimer);
    songTimer = setTimeout(regenSong, SONG_DEBOUNCE);
  }

  /** Evaluated song + where each labelled block lives (colours, gutter bars). */
  function getSongMeta() {
    if (!song) regenSong();
    if (songMeta && songMeta.code === song.code) return songMeta;
    const res = evaluate(song.code);
    const blocks = song.blocks.filter((b) => b.kind === 'instrument' || b.kind === 'code');
    const bars = blocks.map((b) => ({
      key: b.trackId, color: b.color || '#ffd43b', name: b.name, label: b.label, kind: b.kind,
      line0: lineAt(song.code, b.start + 1), line1: Math.max(lineAt(song.code, b.start + 1), lineAt(song.code, Math.max(b.start, b.end - 2))),
      start: b.start, end: b.end,
    }));
    const labelBar = (res.labels || []).map((l) => bars.findIndex((b) => l.start >= b.start && l.start < b.end));
    // live-coder code: one arrange() plays every part — an event belongs to the (last) part const its tokens come from
    const locBar = (ev) => { let hit = -1; for (const l of ev.locations || []) { const i = bars.findIndex((b) => l.start >= b.start && l.start < b.end); if (i >= 0) hit = i; } return hit; };
    songMeta = { code: song.code, res, bars, labelBar, locBar, live: song.mode === 'live' };
    return songMeta;
  }

  // ------------------------------------------------------------ DOM: toolbar
  const playBtn = iconButton('play', () => actions.togglePlay(), 'Play / pause the whole project (Space)', 'code-play');
  const stopBtn = iconButton('stop', () => actions.stop(), 'Stop (Ctrl+.)');
  const applyBtn = button('Apply', () => applyNow(), { icon: 'play', title: 'Evaluate the code and apply it (Ctrl+Enter / Shift+Enter). Alt+Enter applies only the block under the cursor.', cls: 'code-apply' });
  const revertBtn = button('Discard edits', () => discardSongDraft(), { icon: 'undo', title: 'Throw away your edits and show the project as it is now', cls: 'code-compact hidden' });
  const autoToggle = toggle({ label: 'Auto', value: autoApply, title: 'Auto-apply: re-evaluate 600 ms after you stop typing — only when the code has no errors', onChange: (v) => { autoApply = v; lsSet(LS_AUTO, v); if (v) scheduleAuto(); } });
  const dirtyEl = h('span.code-dirty', { title: 'Editor state' });
  const examplesBtn = button('Examples', (e) => openExamples(e.currentTarget), { icon: 'sparkles', title: 'Load an example pattern (replace this track or open as a new track)', cls: 'code-compact' });
  const refBtn = button('Reference', () => setRefOpen(!refOpen), { icon: 'help', title: 'Function reference: every supported function with examples (click to insert)', cls: 'code-compact' });
  const importBtn = button('Import', (e) => openImportMenu(e.currentTarget), { icon: 'upload', title: 'Import a .strudel / .js / .txt file or paste code / a strudel.cc link (you can also drop files onto this view)', cls: 'code-compact' });
  importBtn.appendChild(icon('chevronDown', 12));
  const exportBtn = button('Export', (e) => openExportMenu(e.currentTarget), { icon: 'download', title: 'Download, copy or export the code', cls: 'code-compact' });
  exportBtn.appendChild(icon('chevronDown', 12));
  examplesBtn.appendChild(icon('chevronDown', 12));
  const cyclesSel = select({ options: [1, 2, 4, 8, 16].map((c) => ({ value: c, label: `${c} cycle${c > 1 ? 's' : ''}` })), value: renderCycles, title: 'How many cycles (bars) to render into patterns', onChange: (v) => { renderCycles = Number(v); } });
  const renderBtn = button('Render to tracks', () => { const t = currentTrack(); if (t) { if (isDirty(t)) applyNow(); actions.renderCodeToTracks(t.id, { cycles: renderCycles }); } }, { icon: 'layers', title: 'Expand this code into editable instrument/drum tracks with patterns (the code track gets muted)' });
  const renderWrap = h('div.code-render', renderBtn, cyclesSel);
  // sound engine of the code track shown: Strudel's own (superdough) or daW³'s instruments
  const soundSel = select({
    options: [{ value: 'strudel', label: 'Sound: Strudel' }, { value: 'daw3', label: 'Sound: daW³ instruments' }],
    value: 'strudel', cls: 'code-sound',
    title: 'Sound engine of this code track — Strudel: exactly as on strudel.cc (superdough: its synths, samples, soundfonts, effects); daW³ instruments: this DAW’s synths, drum kits and presets. Either way the sound runs through the track’s mixer channel, inserts and sends.',
    onChange: (v) => { const t = currentTrack(); if (t) actions.updateTrack(t.id, (tt) => { tt.codeSound = v; }, 'Code sound engine'); },
  });
  const styleSel = select({
    options: [{ value: 'live', label: 'Code style: Live-coder' }, { value: 'exact', label: 'Code style: Exact' }],
    value: codeStyle, cls: 'code-style',
    title: 'Live-coder: the song as a short sketch — one idea per part, one arrange() (applying an edit re-renders the parts you changed). Exact: every note transcribed.',
    onChange: (v) => {
      codeStyle = v === 'exact' ? 'exact' : 'live';
      lsSet(LS_STYLE, codeStyle);
      songDraft = null; songStale = false; songErr = null; song = null; songMeta = null; songBase = null;
      regenSong();
      if (isSong() && song) editor.setValue(song.code);
      lastQueryKey = ''; vizDirty = true; lastHlKey = '';
      renderStatus(); renderList(codeTracks());
    },
  });
  const tempoBtn = button('', () => adoptTempo(), { icon: 'metronome', title: 'This code sets its own tempo with setcps/setcpm — click to set the project BPM to match (1 cycle = 1 bar)', cls: 'code-tempo hidden' });
  const toolbar = h('div.view-toolbar.code-toolbar',
    playBtn, stopBtn, h('div.sep'), applyBtn, revertBtn, autoToggle, dirtyEl, h('div.sep'),
    examplesBtn, refBtn, h('div.sep'), importBtn, exportBtn, h('div.sep'),
    renderWrap, soundSel, styleSel, tempoBtn);

  // ------------------------------------------------------------ DOM: track list
  const songItem = h('div.code-item.code-song', { tabIndex: 0, title: 'The whole project as Strudel code — always in sync. Edit it and press Ctrl+Enter to apply your edits to the project.' });
  songItem.addEventListener('click', () => selectEntry(SONG));
  songItem.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectEntry(SONG); });
  const listBody = h('div.code-list-body');
  const addBtn = iconButton('plus', () => newCodeTrack(), 'New code track');
  const listEl = h('div.code-list',
    h('div.code-list-pinned', songItem),
    h('div.code-list-header', h('span', 'Code tracks'), h('div.spacer'), addBtn), listBody,
    h('div.code-list-foot', h('button.code-link', { type: 'button', onclick: () => actions.importStrudel(), title: 'Import a .strudel file' }, icon('upload', 12), 'Import .strudel')));

  // ------------------------------------------------------------ DOM: editor + viz
  const errBar = h('div.code-errbar.hidden');
  const staleBar = h('div.code-stalebar.hidden');
  const editor = createCodeEditor({
    placeholder: '// Type Strudel code, e.g.\n$: s("bd*4, ~ cp, hh*8")\n$: note("c2 eb2 g2 bb2").s("sawtooth").lpf(800)',
    onChange: onEditorChange,
    onApply: () => applyNow(),
    onApplyBlock: (text, info) => applyBlock(text, info),
    onStop: () => actions.stop(),
  });
  const hint = h('div.code-hint',
    h('span', h('kbd', 'Ctrl+Enter'), ' apply'), h('span.code-hint-block', h('kbd', 'Alt+Enter'), ' apply block'), h('span', h('kbd', 'Ctrl+.'), ' stop'),
    h('span', h('kbd', 'Ctrl+/'), ' comment'), h('span', h('kbd', 'Tab'), ' indent'), h('div.spacer'), h('span.code-hint-info'));
  const hintInfo = hint.querySelector('.code-hint-info');
  const hintBlock = hint.querySelector('.code-hint-block');

  const vizCanvas = h('canvas.code-viz-canvas');
  const vizInfo = h('span.code-viz-info');
  const winSel = select({ options: [1, 2, 4, 8].map((c) => ({ value: c, label: `${c} cycle${c > 1 ? 's' : ''}` })), value: vizWindow, title: 'Visible window', onChange: (v) => { vizWindow = Number(v); lsSet(LS_WIN, vizWindow); lastQueryKey = ''; vizDirty = true; } });
  const vizResizer = h('div.code-viz-resizer', { title: 'Drag to resize' });
  const vizTitle = h('b', 'Live pattern');
  const vizEl = h('div.code-viz', { style: { flexBasis: lsGet(LS_VIZ_H, 190) + 'px' } }, vizResizer,
    h('div.code-viz-head', icon('grid', 13), vizTitle, vizInfo, h('div.spacer'), h('span.muted', 'window'), winSel),
    h('div.code-viz-wrap', vizCanvas));
  vizResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const h0 = vizEl.offsetHeight;
    startDrag(e, (_dx, dy) => { const nh = Math.max(70, Math.min(600, h0 - dy)); vizEl.style.flexBasis = nh + 'px'; vizDirty = true; }, () => lsSet(LS_VIZ_H, vizEl.offsetHeight));
  });

  const editorWrap = h('div.code-editor-wrap', errBar, staleBar, editor.el, hint);
  const mainEl = h('div.code-main', editorWrap, vizEl);

  // ------------------------------------------------------------ DOM: reference drawer
  const refSearch = h('input', { type: 'search', placeholder: 'Search functions…', title: 'Filter the reference' });
  const refList = h('div.code-ref-list');
  const refEl = h('div.code-ref', h('div.code-ref-head', icon('help', 14), h('b', 'Reference'), h('div.spacer'), iconButton('x', () => setRefOpen(false), 'Close reference')), h('div.code-ref-search', refSearch), refList);
  refSearch.addEventListener('input', renderReference);
  refSearch.addEventListener('keydown', (e) => e.stopPropagation());

  const dropOverlay = h('div.code-drop.hidden', h('div', icon('upload', 28), h('b', 'Drop a .strudel / .js / .txt file'), h('span', 'It opens as a new code track')));
  const body = h('div.code-body', listEl, mainEl, refEl);
  const el = h('div.code-view', toolbar, body, dropOverlay);
  attachCodeTools(app, editor, { body, after: refBtn }); // autocomplete + drag-and-drop building blocks

  // ------------------------------------------------------------ entry selection
  function selectEntry(id) {
    if (id !== SONG) { actions.selectTrack(id); return; } // ui change -> subscription switches the entry
    setEntry(SONG);
  }
  function setEntry(id) {
    if (id !== SONG && !codeTracks().some((t) => t.id === id)) id = SONG;
    const changed = id !== entry;
    entry = id;
    trackId = id === SONG ? null : id;
    if (changed) { lastQueryKey = ''; vizDirty = true; lastHlKey = ''; editor.setHighlights([]); }
    if (visible) render();
  }

  function showEntry(changed) {
    if (isSong()) {
      if (!song) regenSong();
      const text = songText();
      if (editor.getValue() !== text) editor.setValue(text);
      return;
    }
    const t = currentTrack();
    if (!t) return;
    if (changed) {
      editor.setValue(bufferOf(t));
    } else if (!isDirty(t) && editor.getValue() !== (t.code || '')) {
      // external change (undo, other view) while editor is clean -> follow it
      drafts.delete(t.id);
      editor.setValue(t.code || '');
      lastQueryKey = '';
      vizDirty = true;
    }
  }

  function newCodeTrack(code, name) {
    const t = actions.addTrack('code', code !== undefined ? { code, name } : {});
    if (t) { actions.selectTrack(t.id); setEntry(t.id); setTimeout(() => editor.focus(), 30); }
    return t;
  }

  // ------------------------------------------------------------ rendering
  let shownEntry = null;
  function render() {
    if (entry !== SONG && !currentTrack()) { entry = SONG; trackId = null; }
    const changed = shownEntry !== entry;
    shownEntry = entry;
    showEntry(changed);
    el.classList.toggle('is-song', isSong());
    renderList(codeTracks());
    renderStatus();
    refEl.classList.toggle('hidden', !refOpen);
    refBtn.classList.toggle('on', refOpen);
    const t = currentTrack();
    for (const b of [renderBtn, autoToggle, cyclesSel]) b.disabled = !t;
    renderWrap.classList.toggle('hidden', isSong());
    soundSel.classList.toggle('hidden', isSong() || !t);
    styleSel.classList.toggle('hidden', !isSong());
    if (t) soundSel.value = t.codeSound === 'daw3' ? 'daw3' : 'strudel';
    autoToggle.classList.toggle('hidden', isSong());
    hintBlock.classList.toggle('hidden', isSong());
    applyBtn.querySelector('span:not(.icon)').textContent = isSong() ? 'Apply to project' : 'Apply';
    vizTitle.textContent = isSong() ? 'Song — live piano roll' : 'Live pattern';
  }

  function renderSongItem() {
    const p = store.get();
    const n = p.tracks.filter((t) => t.type === 'instrument' || t.type === 'code').length;
    const err = songErr?.error;
    const dirty = songDraft !== null && songDraft !== song?.code;
    const dot = h(`span.code-dot${err ? '.err' : dirty ? '.dirty' : '.live'}`, { title: err ? `Error: ${err}` : dirty ? 'Edited — Ctrl+Enter applies it to the project' : 'In sync with the project' });
    songItem.className = `code-item code-song${isSong() ? ' active' : ''}`;
    songItem.replaceChildren(
      h('span.code-song-icon', icon('music', 14)),
      h('div.code-item-main',
        h('div.code-item-name', dot, h('span', 'Song (live)')),
        h('div.code-item-meta', dirty ? `editing${songStale ? ' · project changed' : ''}` : `${n} track${n === 1 ? '' : 's'} · ${p.mode === 'song' ? 'arrangement' : 'patterns'}`)));
  }

  function renderList(tracks) {
    renderSongItem();
    if (!tracks.length) {
      listBody.replaceChildren(h('div.code-list-empty', h('p', 'No code tracks yet.'),
        h('button.btn.small', { type: 'button', onclick: () => newCodeTrack(), title: 'Create an empty code track' }, icon('plus', 12), 'New code track'),
        h('button.btn.small', { type: 'button', onclick: (e) => openExamples(e.currentTarget), title: 'Start from an example' }, icon('sparkles', 12), 'Examples')));
      return;
    }
    listBody.replaceChildren(...tracks.map((t) => {
      const err = localErr.get(t.id)?.error || engineErr.get(t.id);
      const dirty = isDirty(t);
      const m = h(`button.code-ms${t.mute ? '.on' : ''}`, { type: 'button', title: t.mute ? 'Unmute' : 'Mute' }, 'M');
      const s = h(`button.code-ms.solo${t.solo ? '.on' : ''}`, { type: 'button', title: t.solo ? 'Unsolo' : 'Solo' }, 'S');
      m.addEventListener('click', (e) => { e.stopPropagation(); actions.updateTrack(t.id, (tt) => { tt.mute = !tt.mute; }, t.mute ? 'Unmute' : 'Mute'); });
      s.addEventListener('click', (e) => { e.stopPropagation(); actions.updateTrack(t.id, (tt) => { tt.solo = !tt.solo; }, t.solo ? 'Unsolo' : 'Solo'); });
      const statusDot = h(`span.code-dot${err ? '.err' : dirty ? '.dirty' : '.ok'}`, { title: err ? `Error: ${err}` : dirty ? 'Unsaved changes' : 'Applied' });
      const lines = (t.code || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
      const row = h(`div.code-item${t.id === trackId && !isSong() ? '.active' : ''}${t.mute ? '.muted' : ''}`, { title: 'Click to edit · double-click to rename · right-click for more', tabIndex: 0 },
        h('span.track-color', { style: { background: t.color } }),
        h('div.code-item-main', h('div.code-item-name', statusDot, h('span', t.name)), h('div.code-item-meta', `${lines} line${lines === 1 ? '' : 's'}${dirty ? ' · edited' : ''}`)),
        m, s);
      row.addEventListener('click', () => selectEntry(t.id));
      row.addEventListener('dblclick', () => actions.renameTrack(t.id));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Apply code', icon: 'play', onClick: () => { selectEntry(t.id); setTimeout(applyNow, 0); } },
        { label: 'Render to tracks', icon: 'layers', onClick: () => actions.renderCodeToTracks(t.id, { cycles: renderCycles }) },
        { label: 'Download .strudel', icon: 'download', onClick: () => downloadCode(t) },
        '-',
        ...actions.trackMenuItems(t.id),
      ]));
      return row;
    }));
  }

  function setErrBar(err, line, src) {
    if (err) {
      errBar.replaceChildren(icon('x', 13), h('b', line ? `Line ${line}: ` : 'Error: '), h('span', String(err)),
        h('span.code-errbar-src', src),
        h('span.muted', isSong() ? ' — nothing was applied; the project is unchanged.' : ' — the last working version keeps playing.'));
      errBar.classList.remove('hidden');
      editor.setErrorLine(line);
    } else {
      errBar.classList.add('hidden');
      editor.setErrorLine(null);
    }
  }

  function renderStatus() {
    if (isSong()) {
      const dirty = songDraft !== null && songDraft !== song?.code;
      const err = songErr?.error;
      dirtyEl.className = 'code-dirty' + (err ? ' err' : dirty ? ' dirty' : ' ok');
      dirtyEl.textContent = err ? '● Error' : dirty ? '● Editing — Ctrl+Enter to apply to the project' : '● Live — in sync with the project';
      applyBtn.classList.toggle('primary', dirty);
      revertBtn.classList.toggle('hidden', !dirty);
      setErrBar(err, songErr?.line, 'song');
      staleBar.classList.toggle('hidden', !(dirty && songStale));
      if (dirty && songStale) {
        staleBar.replaceChildren(icon('bulb', 13), h('span', 'The project changed while you were editing. Apply to merge your edits, or '),
          h('button.code-link', { type: 'button', onclick: () => discardSongDraft() }, 'discard them'), h('span', ' to see the current project.'));
      }
      tempoBtn.classList.add('hidden');
      const p = store.get();
      hintInfo.textContent = `Song · ${p.bpm} BPM · ${p.mode === 'song' ? 'song mode (arrangement)' : 'pattern mode'}`;
      return;
    }
    staleBar.classList.add('hidden');
    revertBtn.classList.add('hidden');
    const t = currentTrack();
    const dirty = isDirty(t);
    const le = t && localErr.get(t.id);
    const ee = t && engineErr.get(t.id);
    const err = le?.error || ee;
    dirtyEl.className = 'code-dirty' + (err ? ' err' : dirty ? ' dirty' : t ? ' ok' : '');
    dirtyEl.textContent = !t ? '' : err ? '● Error' : dirty ? '● Unsaved changes — Ctrl+Enter to apply' : '● Applied';
    applyBtn.classList.toggle('primary', !!dirty);
    setErrBar(err, err ? (le?.line ?? errorLineOf(err, t.code)) : null, le ? 'evaluation' : 'engine');
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

  // ------------------------------------------------------------ apply (code tracks)
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
    if (isSong()) { applySong(); return; }
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
    if (isSong()) { applySong(); return; }
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

  // ------------------------------------------------------------ apply (song -> project)
  function discardSongDraft() {
    songDraft = null;
    songStale = false;
    songErr = null;
    regenSong();
    if (isSong()) editor.setValue(song.code);
    renderStatus();
    renderList(codeTracks());
  }

  function askKeepAsCode(complex) {
    return new Promise((resolve) => {
      let answer = null;
      modal({
        title: 'Some blocks aren\'t plain notes',
        width: 520,
        body: h('div.col',
          h('p', 'These blocks use randomness, continuous signals or never repeat, so they can\'t be written into a pattern as fixed notes:'),
          h('ul.code-complex-list', complex.map((c) => h('li', h('code', c.label), h('span.muted', ` — ${c.reason}`)))),
          h('p.muted', 'Keep them playing as code tracks (the instrument track gets muted so nothing doubles up), or skip them for now.')),
        actions: [
          { label: 'Cancel', onClick: () => { answer = 'cancel'; } },
          { label: 'Skip them', onClick: () => { answer = 'skip'; } },
          { label: 'Keep as code tracks', primary: true, onClick: () => { answer = 'keep'; } },
        ],
        onClose: () => resolve(answer || 'cancel'),
      });
    });
  }

  /** True when the editor holds a different song: none of the project's track labels / section names remain. */
  function isForeignSong(text) {
    const p = store.get();
    if (!p.tracks.length) return text.trim().length > 0;
    const names = new Set([...Object.keys(song?.labels || {}), ...[...(song?.code || '').matchAll(/\bconst\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])]);
    if (!names.size) return false;
    for (const n of names) if (new RegExp(`(^|[^\\w$])${n.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(text)) return false;
    return true;
  }

  /**
   * One code track per instrument: every labelled block ($:, name:, _$:) becomes its own track, with the
   * shared setup (register / setcpm / samples / const …) copied in front so each track runs on its own.
   */
  function splitCodeIntoTracks(text) {
    const COLORS = ['#ffd43b', '#4dabf7', '#ff5f6d', '#38d9a9', '#9775fa', '#ffa94d', '#f783ac', '#3bc9db'];
    const DRUMS = /^(bd|sd|hh|oh|cp|rim|lt|mt|ht|cr|rd|cb|sh|perc|tb|cl|tbd|kick|snare|hat|clap|breaks?\d*|.*_(bd|sd|hh|oh|cp))$/i;
    let items = [];
    try { items = strudel.splitTopLevel ? strudel.splitTopLevel(text) : []; } catch { items = []; }
    const blocks = items.filter((it) => it.kind === 'label');
    if (blocks.length < 2) return [createTrack({ type: 'code', name: 'Strudel', code: text, role: 'code', color: COLORS[0] })];
    const setup = items.filter((it) => it.kind !== 'label').map((it) => text.slice(it.start, it.end)).join('\n');
    const used = new Map();
    return blocks.map((b, i) => {
      const body = text.slice(b.start, b.end);
      let name = b.name && b.name !== '$' ? b.name : '';
      if (!name) {
        const snd = /(?:^|[.\s(])(?:s|sound)\(\s*["'`]\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
        const isNote = /\b(?:note|n)\(/.test(body);
        name = snd ? (DRUMS.test(snd) && !isNote ? 'Drums' : snd[0].toUpperCase() + snd.slice(1)) : `Part ${i + 1}`;
      }
      const k = used.get(name) || 0;
      used.set(name, k + 1);
      if (k) name = `${name} ${k + 1}`;
      // un-mute the label inside its own track; the track's mute button carries the state instead
      const code = (setup ? setup + '\n\n' : '') + body.replace(/^_(\$|[A-Za-z_][\w]*)\s*:/, '$1:');
      const t = createTrack({ type: 'code', name, code, role: 'code', color: COLORS[i % COLORS.length] });
      if (b.muted) t.mute = true;
      return t;
    });
  }

  /** Replace the whole project with one code track playing `text` (one undo step), keeping buses & master. */
  function replaceProjectWithCode(text) {
    const res = evaluate(text);
    if (res.error) {
      songErr = { error: res.error, line: errorLineOf(res.error, text) ?? locateErrorBlock(text) };
      renderStatus();
      app.setStatus?.(`Code error: ${res.error}`);
      return;
    }
    const fresh = createProject();
    const tracks = splitCodeIntoTracks(text);
    const track = tracks[0];
    store.transact('Replace project with code', (p) => {
      const keep = { buses: p.buses, master: p.master, samples: p.samples };
      for (const k of Object.keys(p)) if (!(k in keep)) delete p[k];
      Object.assign(p, fresh, keep, { id: p.id, name: 'Strudel song', mode: 'pattern', tracks, patterns: {}, clips: [], markers: [] });
      if (res.cps > 0) p.bpm = Math.round(res.cps * 60 * beatsPerBar(p) * 100) / 100;
      for (const s of p.scenes || []) s.slots = {};
    });
    songDraft = null;
    songErr = null;
    ui.set({ selectedTrackId: track.id, selectedPatternId: null });
    regenSong();
    if (isSong()) editor.setValue(song.code);
    renderStatus();
    renderList(codeTracks());
    toast(`Replaced the project with the pasted code: ${tracks.length} track${tracks.length > 1 ? 's' : ''} (${tracks.map((t) => t.name).join(', ')}). Ctrl+Z to undo.`, { level: 'success', timeout: 6000 });
    if (!engine.isPlaying) actions.play?.();
  }

  async function applySong() {
    if (!song) regenSong();
    const text = editor.getValue();
    if (text === song.code && songDraft === null) {
      app.setStatus?.('The song code is already in sync with the project.');
      if (!engine.isPlaying) actions.play?.();
      return;
    }
    // Pasted a different song (none of this project's blocks are left)? Replace the project with it.
    if (isForeignSong(text)) { replaceProjectWithCode(text); return; }
    const opts = { presets: PRESETS, kits: DRUM_KITS };
    const live = song.mode === 'live';
    const original = live && songBase?.mode === 'live' ? songBase : song;
    const applyFn = live ? (p, t, o) => applyLiveCode(p, t, { ...o, original }) : applySongCode;
    let dry;
    try { dry = applyFn(deepClone(store.get()), text, opts); } catch (e) { console.error(e); dry = { error: String(e?.message || e) }; }
    if (dry.error) {
      songErr = { error: dry.error, line: errorLineOf(dry.error, text) ?? locateErrorBlock(text) };
      renderStatus();
      renderList(codeTracks());
      app.setStatus?.(`Song code error: ${dry.error}`);
      return;
    }
    songErr = null;
    let keep = false;
    if (dry.complex.length) {
      const a = await askKeepAsCode(dry.complex);
      if (a === 'cancel') { renderStatus(); return; }
      keep = a === 'keep';
    }
    let rep = dry;
    if (dry.changed || (keep && dry.complex.length)) {
      store.transact('Apply song code', (p) => { rep = applyFn(p, text, { ...opts, keepComplexAsCode: keep }); });
    }
    songDraft = null;
    songStale = false;
    regenSong();
    if (isSong()) editor.setValue(song.code);
    renderStatus();
    renderList(codeTracks());
    // report
    const parts = [];
    if (rep.changes.length) parts.push(rep.changes.slice(0, 4).join(' · ') + (rep.changes.length > 4 ? ` · +${rep.changes.length - 4} more` : ''));
    if (rep.muted.length) parts.push(`Muted (block removed or "_" added): ${rep.muted.join(', ')} — tracks are never deleted from here; unmute or delete them in the mixer.`);
    if (!keep && rep.complex?.length) parts.push(`Skipped: ${rep.complex.map((c) => c.label).join(', ')}`);
    if (!parts.length && !rep.warnings.length) parts.push('Nothing to change — the project already matches the code.');
    if (parts.length) toast(parts.join('\n'), { level: rep.changed ? 'success' : 'info', timeout: 6000 });
    for (const w of rep.warnings) toast(w, { level: 'warn', timeout: 7000 });
    app.setStatus?.(rep.changed ? `Applied song code: ${rep.changes.length + rep.muted.length} change(s).` : 'Song code: nothing changed.');
  }

  let autoTimer = null;
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!autoApply || isSong()) return;
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
    lastHlKey = '';
    editor.setHighlights([]);
    if (isSong()) {
      const was = songDraft !== null;
      if (songDraft === null) songBase = song;
      songDraft = song && text === song.code ? null : text;
      if (songDraft === null) { songStale = false; songErr = null; }
      if (was !== (songDraft !== null)) renderSongItem();
      renderStatus();
      return;
    }
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
    const code = t ? (t.id === trackId && !isSong() ? editor.getValue() : t.code || '') : editor.getValue();
    const name = ((t ? t.name : store.get().name) || 'pattern').replace(/[^\w\- ]+/g, '').trim() || 'pattern';
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
    const song0 = isSong();
    const r = anchor.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {} }, [
      { header: song0 ? 'Song code' : 'This track' },
      { label: 'Download .strudel', icon: 'download', disabled: !t && !song0, onClick: () => downloadCode(t) },
      { label: 'Copy code to clipboard', icon: 'copy', disabled: !t && !song0, onClick: async () => {
        try { await navigator.clipboard.writeText(editor.getValue()); toast('Code copied — paste it into strudel.cc or share it', { level: 'success' }); } catch { toast('Clipboard not available', { level: 'warn' }); }
      } },
      { label: 'Open in strudel.cc', icon: 'code', disabled: !t && !song0, onClick: async () => {
        const o = await loadOptionalModules();
        const code = editor.getValue();
        let url;
        try { url = o.file.codeToShareUrl ? o.file.codeToShareUrl(code) : 'https://strudel.cc/#' + btoa(unescape(encodeURIComponent(code))); } catch { return; }
        window.open(url, '_blank', 'noopener');
      } },
      '-',
      { header: 'Project' },
      { label: 'Save the song code as a new code track', icon: 'layers', onClick: () => { regenSong(); newCodeTrack(song.code, 'Song code'); } },
      { label: 'Export patterns as compact code…', icon: 'code', onClick: () => actions.exportCode() },
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
    refEl.classList.toggle('hidden', !v);
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

  // ------------------------------------------------------------ live source (what's highlighted)
  /**
   * The evaluated code behind the editor, when the editor shows exactly that code:
   * { res, colorOf(ev) -> css colour, barOf(ev) -> index, bars: [{line0, line1, color}] } | null
   */
  const trackMetaCache = new Map();
  function liveSource() {
    if (isSong()) {
      if (!song || songDraft !== null) return null;
      const m = getSongMeta();
      if (m.res.error) return null;
      return {
        res: m.res, bars: m.bars,
        barOf: (ev) => (m.live ? m.locBar(ev) : ev.block !== undefined ? m.labelBar[ev.block] ?? -1 : -1),
        colorOf: (ev) => { const i = m.live ? m.locBar(ev) : ev.block !== undefined ? m.labelBar[ev.block] : -1; return i >= 0 ? m.bars[i].color : '#ffd43b'; },
      };
    }
    const t = currentTrack();
    if (!t || isDirty(t) || t.mute) return null;
    const code = t.code || '';
    let res = evaluate(code);
    if (res.error) res = lastGood.get(t.id) && lastGood.get(t.id).code === code ? lastGood.get(t.id) : null;
    else lastGood.set(t.id, { ...res, code });
    if (!res) return null;
    let meta = trackMetaCache.get(t.id);
    if (!meta || meta.code !== code || meta.color !== t.color) {
      const labels = res.labels || [];
      const bars = labels.map((l, i) => ({
        color: labels.length > 1 ? LABEL_COLORS[i % LABEL_COLORS.length] : (t.color || LABEL_COLORS[0]),
        line0: lineAt(code, l.start), line1: Math.max(lineAt(code, l.start), lineAt(code, Math.max(l.start, l.end - 1))), name: l.name,
      }));
      meta = { code, color: t.color, bars };
      trackMetaCache.set(t.id, meta);
    }
    const bars = meta.bars;
    return {
      res, bars,
      barOf: (ev) => (ev.block !== undefined && ev.block < bars.length ? ev.block : -1),
      colorOf: (ev) => (ev.block !== undefined && bars[ev.block] ? bars[ev.block].color : (t.color || LABEL_COLORS[0])),
    };
  }

  /** Transport position (cycles) that is being HEARD now: scheduler time minus output latency. */
  function audibleCycle() {
    const bpb = beatsPerBar(store.get());
    let beat = null;
    const ctx = engine.ctx;
    if (ctx && engine.isPlaying && engine.beatAtTime) {
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      try { beat = engine.beatAtTime(ctx.currentTime - lat); } catch { beat = null; }
    }
    if (beat == null) { try { beat = engine.getPosition(); } catch { beat = 0; } }
    return beat / bpb;
  }

  /** Events overlapping cycle k (cached per evaluated result). */
  function chunk(res, k) {
    if (!res._chunks) res._chunks = new Map();
    let evs = res._chunks.get(k);
    if (!evs) {
      try { evs = strudel.queryEvents(res, k, k + 1, { active: true }); } catch { evs = []; }
      if (res._chunks.size > 24) res._chunks.delete(res._chunks.keys().next().value);
      res._chunks.set(k, evs);
    }
    return evs;
  }

  // ------------------------------------------------------------ slider() widgets
  // Strudel's slider(value, min, max, step) shows a live range control; dragging it changes the sound at
  // once (no re-evaluation), releasing writes the new value into the code.
  let widgetKey = '';
  function syncWidgets() {
    const t = isSong() ? null : currentTrack();
    const code = t ? t.code || '' : '';
    const res = t && !isDirty(t) ? evaluate(code) : null;
    const list = res && !res.error ? (res.widgets || []).filter((w) => w.type === 'slider' && w.id) : [];
    const key = t ? `${t.id}|${code}|${list.length}` : '';
    if (key === widgetKey) return;
    widgetKey = key;
    editor.setWidgets(list.map((w) => ({
      from: w.from, to: w.to, value: Number(w.value), min: w.min, max: w.max, step: w.step,
      onInput: (v) => strudel.setSliderValue?.(w.id, v),
      onChange: (v) => {
        const cur = currentTrack();
        if (!cur || cur.id !== t.id || (cur.code || '') !== code) return;
        const dec = w.step != null ? Math.max(0, (String(w.step).split('.')[1] || '').length) : 3;
        const text = String(+v.toFixed(dec));
        const next = code.slice(0, w.from) + text + code.slice(w.to);
        editor.setValue(next);
        drafts.set(cur.id, next);
        commit(next, { label: 'Move slider', coalesce: true });
      },
    })));
  }

  let lastHlKey = '';
  let liveActive = []; // events active now (for the viz)
  function updateLive() {
    const src = liveSource();
    const playing = !!engine.isPlaying;
    if (!src) {
      if (lastHlKey !== 'none') { editor.setHighlights([]); editor.setBlockBars([]); lastHlKey = 'none'; }
      liveActive = [];
      return;
    }
    if (!playing) {
      const key = 'idle|' + src.bars.length + '|' + (src.bars[0]?.line0 ?? '');
      if (lastHlKey !== key) {
        editor.setHighlights([]);
        editor.setBlockBars(src.bars.map((b) => ({ line0: b.line0, line1: b.line1, color: b.color, alpha: 0.28 })));
        lastHlKey = key;
      }
      liveActive = [];
      return;
    }
    lastHlKey = 'live';
    const p = store.get();
    const bpb = beatsPerBar(p);
    const cps = p.bpm / 60 / bpb;
    const cyc = audibleCycle();
    const fade = FADE_SEC * cps;
    const pulse = PULSE_SEC * cps;
    const k = Math.floor(cyc);
    const evs = k === Math.floor(cyc - fade) ? chunk(src.res, k) : chunk(src.res, k - 1).concat(chunk(src.res, k));
    const seen = new Set();
    const boxes = [];
    const barAlpha = src.bars.map(() => 0.28);
    const active = [];
    for (const ev of evs) {
      if (ev.begin > cyc + 1e-9 || ev.end + fade < cyc) continue;
      const key = `${ev.begin}|${ev.pattern}|${ev.locations[0]?.start}|${ev.value.note ?? ev.value.s}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const on = cyc < ev.end;
      const alpha = on ? 1 : Math.max(0, 1 - (cyc - ev.end) / fade);
      if (alpha <= 0.02) continue;
      const color = src.colorOf(ev);
      if (on) active.push({ ...ev, color });
      for (const l of ev.locations) boxes.push({ start: l.start, end: l.end, color, alpha });
      const bi = src.barOf(ev);
      if (bi >= 0 && on) {
        const since = cyc - ev.begin;
        const a = since < pulse ? 1 - 0.45 * (since / pulse) : 0.55;
        if (a > barAlpha[bi]) barAlpha[bi] = a;
      }
    }
    // overlapping boxes: keep the brightest per range
    const byRange = new Map();
    for (const b of boxes) { const kk = b.start * 1e6 + b.end; const o = byRange.get(kk); if (!o || o.alpha < b.alpha) byRange.set(kk, b); }
    editor.setHighlights([...byRange.values()]);
    editor.setBlockBars(src.bars.map((b, i) => ({ line0: b.line0, line1: b.line1, color: b.color, alpha: barAlpha[i] })));
    liveActive = active;
  }

  // ------------------------------------------------------------ visualisation
  let vizDirty = true;
  let lastQueryKey = '';
  let cached = { events: [], rows: [], c0: 0, c1: 1 };
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
    if (!res.error) lastGood.set(t.id, { ...res, code: t.code || '' });
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
        return { begin: e.begin, end, key: lab.key, value: e.value, block: e.block };
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

  function drawGrid(ctx, H, xOf, c0, c1, top, bpb) {
    ctx.font = '10px ' + colors.mono;
    for (let c = c0; c <= c1; c++) {
      for (let b = 0; b < bpb && c < c1; b++) {
        const x = Math.round(xOf(c + b / bpb)) + 0.5;
        ctx.strokeStyle = b === 0 ? colors.bar : colors.beat;
        ctx.beginPath(); ctx.moveTo(x, top - 2); ctx.lineTo(x, H); ctx.stroke();
      }
      if (c < c1) { ctx.fillStyle = colors.text3; ctx.fillText(`${isSong() ? 'bar' : 'cycle'} ${c + (isSong() ? 1 : 0)}`, xOf(c) + 4, 11); }
    }
  }

  function drawPlayhead(ctx, H, xOf, cyc, c0, c1, playing) {
    if (cyc >= c0 && cyc <= c1) {
      const x = Math.round(xOf(cyc)) + 0.5;
      ctx.strokeStyle = playing ? colors.accent2 : colors.text3;
      ctx.lineWidth = playing ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  function roundRect(ctx, x, y, w, hh, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r); else ctx.rect(x, y, w, hh);
  }

  /** Song entry: one lane per track (track colour), a mini piano roll inside each lane. */
  let songViz = { key: '', events: [] };
  function drawSongViz(ctx, w, H, cyc, playing) {
    const src = liveSource() || (song && !songDraft ? null : null);
    const meta = song ? getSongMeta() : null;
    if (!meta || meta.res.error) {
      ctx.fillStyle = colors.text3;
      ctx.font = '12px ' + colors.font;
      ctx.fillText(songDraft !== null ? 'Editing — apply (Ctrl+Enter) to see the result here.' : 'Fix the error to see the song.', 12, 30);
      return { rows: 0, events: 0 };
    }
    const bpb = beatsPerBar(store.get());
    const win = vizWindow;
    const c0 = Math.floor(cyc / win) * win;
    const c1 = c0 + win;
    const key = `${meta.code}|${c0}|${c1}`;
    if (songViz.key !== key) {
      let evs = [];
      try { evs = strudel.queryEvents(meta.res, c0, c1, { active: true }); } catch { evs = []; }
      songViz = { key, events: evs };
    }
    const lanes = meta.bars.filter((b) => b.kind !== 'audio');
    const laneOf = new Map(lanes.map((b, i) => [b, i]));
    const nL = Math.max(1, lanes.length);
    const top = 16;
    const labelW = 86;
    const gx = labelW, gw = Math.max(10, w - labelW - 6);
    const laneH = Math.max(8, (H - top - 2) / nL);
    const xOf = (c) => gx + ((c - c0) / (c1 - c0)) * gw;
    drawGrid(ctx, H, xOf, c0, c1, top, bpb);
    // per-lane pitch ranges / drum rows
    const info = lanes.map(() => ({ lo: 127, hi: 0, drums: new Map() }));
    const evLane = (ev) => { const bi = meta.live ? meta.locBar(ev) : ev.block !== undefined ? meta.labelBar[ev.block] : -1; return bi >= 0 ? laneOf.get(meta.bars[bi]) ?? -1 : -1; };
    for (const ev of songViz.events) {
      const li = evLane(ev);
      if (li < 0) continue;
      const v = ev.value;
      if (typeof v.note === 'number') { info[li].lo = Math.min(info[li].lo, v.note); info[li].hi = Math.max(info[li].hi, v.note); } else {
        const k = `${v.s}${v.n !== undefined ? ':' + v.n : ''}`;
        if (!info[li].drums.has(k)) info[li].drums.set(k, info[li].drums.size);
      }
    }
    lanes.forEach((b, i) => {
      const y = top + i * laneH;
      ctx.fillStyle = i % 2 ? (colors.light ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.03)') : 'transparent';
      ctx.fillRect(gx, y, gw, laneH);
      ctx.fillStyle = rgba(b.color, 0.08);
      ctx.fillRect(gx, y, gw, laneH);
    });
    let count = 0;
    const activeLanes = new Set();
    for (const ev of songViz.events) {
      const li = evLane(ev);
      if (li < 0) continue;
      const lane = lanes[li];
      const inf = info[li];
      const v = ev.value;
      const y0 = top + li * laneH + 2;
      const hh = laneH - 4;
      let y, bh;
      if (typeof v.note === 'number') {
        const span = Math.max(1, inf.hi - inf.lo);
        bh = Math.max(2, Math.min(6, hh / (span + 1)));
        y = y0 + (1 - (v.note - inf.lo) / span) * (hh - bh);
        if (inf.hi === inf.lo) y = y0 + (hh - bh) / 2;
      } else {
        const n = Math.max(1, inf.drums.size);
        const k = inf.drums.get(`${v.s}${v.n !== undefined ? ':' + v.n : ''}`) ?? 0;
        bh = Math.max(2, Math.min(6, hh / n - 1));
        y = y0 + (k + 0.5) * (hh / n) - bh / 2;
      }
      const x0 = xOf(Math.max(c0, ev.begin));
      const x1 = xOf(Math.min(c1, ev.end));
      const on = playing && cyc >= ev.begin && cyc < ev.end;
      const past = playing && cyc >= ev.end;
      if (on) activeLanes.add(li);
      ctx.globalAlpha = on ? 1 : past ? 0.4 : 0.8;
      ctx.fillStyle = lane.color;
      roundRect(ctx, x0, y, Math.max(2, x1 - x0 - 1), bh, Math.min(2, bh / 2));
      ctx.fill();
      if (on) { ctx.save(); ctx.shadowColor = lane.color; ctx.shadowBlur = 8; ctx.strokeStyle = colors.light ? '#000' : '#fff'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore(); }
      ctx.globalAlpha = 1;
      count++;
    }
    // labels
    ctx.fillStyle = colors.bg2;
    ctx.fillRect(0, 0, labelW - 2, H);
    lanes.forEach((b, i) => {
      const y = top + i * laneH;
      const hit = activeLanes.has(i);
      ctx.fillStyle = b.color;
      ctx.globalAlpha = hit ? 1 : 0.55;
      ctx.fillRect(0, y + 1, hit ? 4 : 3, laneH - 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = hit ? colors.text : colors.text2;
      ctx.font = `${Math.min(11, Math.max(8, Math.floor(laneH * 0.6)))}px ${colors.font}`;
      if (laneH >= 8) ctx.fillText(String(b.name).slice(0, 12), 8, y + laneH / 2 + 4);
    });
    drawPlayhead(ctx, H, xOf, cyc, c0, c1, playing);
    void src;
    return { rows: lanes.length, events: count };
  }

  function drawViz() {
    if (!colors) readColors();
    const { ctx, w, h: H } = fitCanvas(vizCanvas);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, H);
    const playing = !!engine.isPlaying;
    const cyc = playing ? audibleCycle() : (() => { try { return engine.getPosition() / beatsPerBar(store.get()); } catch { return 0; } })();
    if (isSong()) {
      const r = drawSongViz(ctx, w, H, cyc, playing);
      vizInfo.textContent = `${playing ? '▶' : '■'} bar ${(cyc + 1).toFixed(2)} · ${r.rows} track${r.rows === 1 ? '' : 's'} · ${r.events} event${r.events === 1 ? '' : 's'} in view`;
      return;
    }
    const t = currentTrack();
    if (!t) return;
    const pos = cyc * beatsPerBar(store.get());
    const v = computeView(t, pos);
    const { events, rows, rowIndex, c0, c1 } = v;
    const labelW = Math.min(90, Math.max(48, ...rows.map((r) => r.label.length * 7 + 14)));
    const gx = labelW, gw = Math.max(10, w - labelW - 6);
    const nRows = Math.max(1, rows.length);
    const rowH = Math.max(6, Math.min(22, (H - 18) / nRows));
    const top = 16;
    const xOf = (c) => gx + ((c - c0) / (c1 - c0)) * gw;
    const bpb = beatsPerBar(store.get());
    drawGrid(ctx, H, xOf, c0, c1, top, bpb);
    const monoFont = colors.mono;
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
    // events — coloured per labelled block (the same colours as the editor's gutter bars)
    const src = liveSource();
    const active = [];
    for (const e of events) {
      const i = rowIndex.get(e.key);
      if (i == null) continue;
      const r = rows[i];
      const x0 = xOf(Math.max(c0, e.begin)), x1 = xOf(Math.min(c1, e.end));
      const y = top + i * rowH + 1;
      const hgt = Math.max(3, rowH - 2);
      const on = playing && cyc >= e.begin && cyc < e.end;
      const past = cyc >= e.end;
      if (on) active.push(e);
      const light = colors.light;
      const col = src && src.bars.length > 1 ? src.colorOf(e) : null;
      const hue = r.pitch != null ? (r.pitch % 12) * 30 : hashHue(String(r.sound ?? r.label));
      if (col) { ctx.fillStyle = col; ctx.globalAlpha = on ? 1 : past && playing ? 0.45 : 0.85; } else ctx.fillStyle = on ? `hsl(${hue} 95% ${light ? 45 : 68}%)` : `hsla(${hue} 75% ${light ? 45 : 58}% / ${past && playing ? 0.45 : 0.85})`;
      const ww = Math.max(2, x1 - x0 - 1);
      roundRect(ctx, x0, y, ww, hgt, Math.min(3, hgt / 2));
      ctx.fill();
      ctx.globalAlpha = 1;
      if (on) { ctx.save(); ctx.shadowColor = col || `hsl(${hue} 100% 60%)`; ctx.shadowBlur = 10; ctx.strokeStyle = light ? '#000' : '#fff'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore(); }
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
    drawPlayhead(ctx, H, xOf, cyc, c0, c1, playing);
    vizInfo.textContent = `${playing ? '▶' : '■'} cycle ${cyc.toFixed(2)} · ${rows.length} row${rows.length === 1 ? '' : 's'} · ${events.length} event${events.length === 1 ? '' : 's'} in view`;
  }

  let raf = 0;
  let wasPlaying = false;
  function loop() {
    raf = 0;
    if (!visible) return;
    const playing = !!engine.isPlaying;
    try { updateLive(); } catch (e) { console.error('[code highlight]', e); }
    try { syncWidgets(); } catch (e) { console.error('[code widgets]', e); }
    if (playing || vizDirty || wasPlaying) {
      vizDirty = false;
      try { drawViz(); } catch (e) { console.error('[code viz]', e); }
    }
    wasPlaying = playing;
    raf = requestAnimationFrame(loop);
  }
  const ro = new ResizeObserver(() => { vizDirty = true; });
  ro.observe(vizCanvas);

  // ------------------------------------------------------------ events
  let lastSel = ui.get('selectedTrackId');
  // created by selecting a code track (e.g. an import switching to this view): open that track
  if (codeTracks().some((t) => t.id === lastSel)) { entry = lastSel; trackId = lastSel; }
  app.subscribe((r) => {
    if ('theme' in r.ui) { colors = null; vizDirty = true; }
    if (r.project) scheduleSongRegen();
    if ('selectedTrackId' in r.ui) {
      const sel = ui.get('selectedTrackId');
      // a code track selected anywhere (new / imported / clicked) opens it here
      if (sel !== lastSel && codeTracks().some((t) => t.id === sel)) { entry = sel; trackId = sel; lastHlKey = ''; }
      lastSel = sel;
    }
    if (!visible) return;
    if (r.project || 'selectedTrackId' in r.ui) {
      // drop stale drafts of deleted tracks
      const ids = new Set(codeTracks().map((t) => t.id));
      for (const id of drafts.keys()) if (!ids.has(id)) drafts.delete(id);
      render();
      vizDirty = true;
    }
  });
  // the real Strudel engine finished loading (or failed): everything evaluated so far is re-evaluated
  strudel.onStrudelStatus?.(() => {
    evalCache.clear();
    trackMetaCache.clear();
    lastGood.clear();
    songMeta = null;
    songViz = { key: '', events: [] };
    lastQueryKey = '';
    lastHlKey = '';
    vizDirty = true;
    if (visible) render();
  });
  store.on?.('load', () => { songDraft = null; songStale = false; songErr = null; entry = SONG; trackId = null; song = null; regenSong(); if (visible) render(); });
  engine.on?.('code-error', ({ trackId: id, error }) => {
    engineErr.set(id, error);
    if (visible) { renderStatus(); renderList(codeTracks()); }
  });
  engine.on?.('code-ok', ({ trackId: id }) => {
    if (!engineErr.has(id)) return;
    engineErr.delete(id);
    if (visible) { renderStatus(); renderList(codeTracks()); }
  });
  engine.on?.('state', () => { vizDirty = true; lastHlKey = ''; playBtn.replaceChildren(icon(engine.isPlaying ? 'pause' : 'play')); playBtn.classList.toggle('on', !!engine.isPlaying); });
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
    /** For automation/tests: the current song code and the entry shown. */
    getSongCode: () => { regenSong(); return song.code; },
    getEntry: () => entry,
    selectSong: () => setEntry(SONG),
    show() {
      visible = true;
      colors = null;
      regenSong();
      render();
      if (refOpen) renderReference();
      vizDirty = true;
      lastHlKey = '';
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
