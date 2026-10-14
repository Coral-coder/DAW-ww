// Pocket ▸ Code: the project as Strudel live code on a phone. Read-only highlighted code by default (the same
// generator + highlighter as the desktop Code view); "Edit" gives a big-font textarea with a snippet bar
// (tap to insert at the cursor) and Apply (= Ctrl+Enter) through the desktop's apply logic (code/song-apply.js).
import { h } from '../../ui/dom.js';
import { highlightCode } from '../../ui/code-editor.js';
import * as strudel from '../../code/strudel.js';
import { songToCode } from '../../code/song-code.js';
import { songToLiveCode } from '../../code/livecoder.js';
import { planSongApply, commitSongApply, songApplySummary } from '../../code/song-apply.js';
import { PRESETS, DRUM_KITS } from '../../audio/index.js';
import { SNIPPETS, insertSnippet, codeEntries } from '../code-core.js';
import { pageShell, iconBtn } from './common.js';
import { actionSheet, haptic, chips, bigButton, confirmSheet, openSheet } from '../touch.js';

const LS_STYLE = 'daw3-code-style'; // shared with the desktop view: 'live' | 'exact'
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

export function createCodePage(app, nav) {
  const { store, ui, actions, engine } = app;
  const get = () => store.get();
  const back = iconBtn('chevronRight', () => nav.back(), 'Back', 'back');
  const editBtn = h('button.pk-btn.small', { type: 'button' }, 'Edit');
  const applyBtn = h('button.pk-btn.small.primary', { type: 'button', hidden: true }, '▶ Apply');
  const moreBtn = iconBtn('menu', () => moreMenu(), 'More');
  const { el, head, body, titleEl } = pageShell('Code', editBtn, applyBtn, moreBtn);
  head.prepend(back);
  body.classList.add('pk-code-body');

  let entry = 'song', editing = false, style = lsGet(LS_STYLE, 'live') === 'exact' ? 'exact' : 'live';
  let song = null, songBase = null, draft = null, errMsg = null, visible = false, regenTimer = 0;
  const entryChips = h('div.pk-chips.scroll.small', { 'data-noswipe': '' });
  const pre = h('pre.pk-code', { 'data-noswipe': '' });
  const ta = h('textarea.pk-code-edit', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off', 'data-noswipe': '' });
  const errBar = h('div.pk-code-err', { hidden: true });
  const snipBar = h('div.pk-snips', { 'data-noswipe': '' });
  const status = h('p.pk-hint');
  body.append(entryChips, errBar, pre, ta, status);
  el.appendChild(snipBar);

  for (const sn of SNIPPETS) {
    const b = h('button.pk-snip', { type: 'button', title: sn.tip }, sn.label);
    // keep the textarea focused (iOS: tapping a button would close the keyboard)
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => { haptic(4); insert(sn); });
    snipBar.appendChild(b);
  }
  function insert(sn) {
    const r = insertSnippet(ta.value, ta.selectionStart, ta.selectionEnd, sn);
    ta.value = r.text;
    ta.focus();
    ta.setSelectionRange(r.selStart, r.selEnd);
    onInput();
  }

  const codeTrack = () => (entry === 'song' ? null : get().tracks.find((t) => t.id === entry && t.type === 'code') || null);
  function regen() {
    try { song = style === 'live' ? songToLiveCode(get()) : songToCode(get()); } catch (e) { console.error('[pocket code]', e); song = { code: `// could not generate the code: ${e.message}`, mode: style }; }
  }
  const shownText = () => (entry === 'song' ? (draft ?? song?.code ?? '') : (draft ?? codeTrack()?.code ?? ''));

  function render() {
    titleEl.textContent = entry === 'song' ? 'Song code' : (codeTrack()?.name || 'Code');
    const es = codeEntries(get());
    if (!es.some((e) => e.id === entry)) { entry = 'song'; draft = null; }
    entryChips.replaceChildren(...es.map((e) => {
      const b = h(`button.pk-chip${e.id === entry ? '.on' : ''}`, { type: 'button' }, e.label);
      b.addEventListener('click', async () => {
        if (e.id === entry) return;
        if (draft !== null && !(await confirmSheet('Discard your edits?', 'You have edits that are not applied yet.', 'Discard'))) return;
        entry = e.id; draft = null; errMsg = null; setEditing(false); render();
      });
      return b;
    }));
    if (entry === 'song' && !song) regen();
    const text = shownText();
    if (!editing) pre.innerHTML = highlightCode(text) + '\n';
    else if (ta.value !== text && document.activeElement !== ta) ta.value = text;
    pre.hidden = editing;
    ta.hidden = !editing;
    snipBar.hidden = !editing;
    editBtn.textContent = editing ? 'Done' : 'Edit';
    applyBtn.hidden = !editing && draft === null;
    errBar.hidden = !errMsg;
    errBar.textContent = errMsg ? `⚠ ${errMsg}` : '';
    status.textContent = editing
      ? 'Tap a snippet to insert it at the cursor · Apply plays your change'
      : entry === 'song' ? `The whole song as Strudel code (${style === 'live' ? 'live-coder sketch' : 'exact notes'}) — tap Edit to change it` : 'A code track — tap Edit to change it';
  }
  function setEditing(on) {
    editing = on;
    if (on) {
      if (entry === 'song') songBase = song;
      ta.value = shownText();
      setTimeout(() => ta.focus(), 30);
    }
    render();
  }
  function onInput() {
    const base = entry === 'song' ? song?.code : codeTrack()?.code;
    draft = ta.value === (base ?? '') ? null : ta.value;
    applyBtn.hidden = false;
  }
  ta.addEventListener('input', onInput);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); apply(); }
    if (e.key === 'Tab') { e.preventDefault(); insert({ text: '  |' }); }
  });
  editBtn.addEventListener('click', () => { haptic(5); setEditing(!editing); });
  applyBtn.addEventListener('click', () => { haptic(10); apply(); });

  // ------------------------------------------------------------------ apply (same paths as the desktop view)
  async function apply() {
    const text = editing ? ta.value : shownText();
    errMsg = null;
    const t = codeTrack();
    if (t) {
      let res;
      try { res = strudel.evaluate(text); } catch (e) { res = { error: String(e?.message || e) }; }
      if (res?.error) { errMsg = res.error; render(); return; }
      if ((t.code || '') !== text) actions.updateTrack(t.id, (tt) => { tt.code = text; }, 'Apply code');
      draft = null;
      app.toast(`Applied “${t.name}”.`, { level: 'success' });
      if (!engine.isPlaying) actions.play?.();
      render();
      return;
    }
    if (!song) regen();
    const plan = planSongApply(get(), text, { song, songBase, songDraft: draft, presets: PRESETS, kits: DRUM_KITS });
    if (plan.kind === 'unchanged') { app.toast('The code already matches the song.'); if (!engine.isPlaying) actions.play?.(); return; }
    if (plan.kind === 'error') { errMsg = plan.error; render(); return; }
    if (plan.kind === 'foreign') {
      // a different song: same importer as desktop — split into instrument tracks with effects (default),
      // one code track per part, or one code track; the choice sheet doubles as the confirmation
      const r = await actions.importStrudelCode(text, { name: 'Strudel', replace: true });
      if (!r?.choice) return;
      draft = null; song = null; regen();
      if (!engine.isPlaying) actions.play?.();
      setEditing(false);
      if (r.choice === 'split') location.hash = '#/arrange';
      return;
    }
    let keep = false;
    if (plan.dry.complex.length) {
      const a = await askKeep(plan.dry.complex);
      if (a === 'cancel') return;
      keep = a === 'keep';
    }
    const rep = commitSongApply(store, plan, text, { keep });
    draft = null;
    regen();
    const parts = songApplySummary(rep, { keep });
    if (parts.length) app.toast(parts.join('\n'), { level: rep.changed ? 'success' : 'info', timeout: 6000 });
    for (const w of rep.warnings) app.toast(w, { level: 'warn', timeout: 7000 });
    if (editing) ta.value = song.code;
    render();
  }
  function askKeep(complex) {
    return new Promise((resolve) => {
      let answer = 'cancel';
      const s = openSheet({
        title: 'Some blocks aren’t plain notes',
        body: [h('p.pk-p', 'These use randomness or continuous signals, so they can’t become fixed notes:'), h('ul.pk-p', ...complex.map((c) => h('li', h('code', c.label), ` — ${c.reason}`)))],
        actions: h('div.pk-col', bigButton('Keep them as code tracks', () => { answer = 'keep'; s.close(); }, { cls: 'primary' }), bigButton('Skip them', () => { answer = 'skip'; s.close(); }), bigButton('Cancel', () => s.close(), { cls: 'ghost' })),
        onClose: () => resolve(answer),
      });
    });
  }

  function moreMenu() {
    actionSheet('Code', [
      { label: `Style: ${style === 'live' ? 'live-coder sketch' : 'exact notes'} (switch)`, icon: 'code', onClick: () => { style = style === 'live' ? 'exact' : 'live'; lsSet(LS_STYLE, style); song = null; draft = null; regen(); render(); } },
      { label: 'Discard my edits', icon: 'undo', disabled: draft === null, onClick: () => { draft = null; errMsg = null; if (editing) ta.value = shownText(); render(); } },
      { label: 'New code track', icon: 'plus', onClick: () => { const t = actions.addTrack('code', { name: 'Code' }); if (t) { entry = t.id; draft = null; setEditing(true); } } },
      { label: 'Copy the code', icon: 'copy', onClick: () => navigator.clipboard?.writeText(shownText()).then(() => app.toast('Copied'), () => app.toast('Copy failed', { level: 'warn' })) },
      { label: engine.isPlaying ? 'Stop' : 'Play', icon: engine.isPlaying ? 'stop' : 'play', onClick: () => actions.togglePlay() },
    ]);
  }

  app.subscribe(() => {
    if (!visible) return;
    clearTimeout(regenTimer);
    regenTimer = setTimeout(() => { if (entry === 'song' && draft === null) regen(); render(); }, 250);
  });
  return {
    el,
    show(route) {
      visible = true;
      if (route?.id && route.id !== entry) { entry = route.id; draft = null; }
      if (draft === null) regen();
      render();
    },
    hide() { visible = false; },
  };
}
