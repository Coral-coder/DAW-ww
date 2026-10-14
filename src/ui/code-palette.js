// "Building blocks" palette for the Code view: categories of chips (sounds, starter patterns, rhythm,
// pitch, FX, signals, structure, widgets) that can be dragged onto a line of the editor or clicked to
// insert at the caret. Drop semantics live in src/code/assist.js (computeDrop): a method chip is appended
// to the pattern on that line, a sound goes into the mini-notation string, a pattern block becomes a new
// `$:` block (or a new layer of a stack), a bank adds .bank(…), a sample pack adds samples(…) at the top …
//
// createCodePalette(app, editor, { onApplied }) -> { el, button, setOpen(v), isOpen(), refresh() }
import { h, icon } from './dom.js';
import { iconButton, button } from './components.js';
import { paletteGroups, computeDrop, minimalEdit, buildCatalog } from '../code/assist.js';
import { dslNames as strudelDslNames } from '../code/strudel.js';
import { attachAutocomplete } from './code-autocomplete.js';

const LS = 'daw3-code-palette';
const MIME = 'application/x-daw3-chip';
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { return {}; } };
const lsSet = (v) => { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* ignore */ } };

const KIND_LABEL = { method: 'method', sound: 'sound', bank: 'drum machine', block: 'pattern block', samples: 'sample pack', arg: 'signal', slider: 'widget' };

export function createCodePalette(app, editor, opts = {}) {
  const state = { open: false, width: 260, closed: {}, ...lsGet() };
  const save = () => lsSet({ open: state.open, width: state.width, closed: state.closed });
  let chips = []; // flat list, index = data-i
  let dragChip = null;
  let groupsKey = '';

  const search = h('input', { type: 'search', placeholder: 'Search blocks…', title: 'Filter the building blocks', 'aria-label': 'Search building blocks' });
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; render(); } });
  search.addEventListener('input', () => render());
  const listEl = h('div.cpal-list');
  const resizer = h('div.cpal-resizer', { title: 'Drag to resize', role: 'separator', 'aria-orientation': 'vertical' });
  const el = h('div.cpal', { style: { width: state.width + 'px' }, 'aria-label': 'Building blocks' }, resizer,
    h('div.cpal-head', icon('layers', 14), h('b', 'Building blocks'), h('div.spacer'), iconButton('x', () => setOpen(false), 'Close building blocks')),
    h('div.cpal-help', 'Drag a block onto a line — or click to add it at the cursor.'),
    h('div.cpal-search', search), listEl);
  const btn = button('Blocks', () => setOpen(!state.open), { icon: 'layers', title: 'Building blocks: drag sounds, effects and pattern snippets onto your code (they hook themselves up)', cls: 'code-compact' });

  // indicator shown over the editor while dragging
  const ind = h('div.cpal-dropline.hidden', { 'aria-hidden': 'true' });
  const indLabel = h('div.cpal-droplabel.hidden', { 'aria-hidden': 'true' });
  document.body.append(ind, indLabel);

  function project() { return app.store.get(); }
  function groups() {
    const p = project();
    const samples = Object.values(p.samples || {}).map((s) => s.name).filter(Boolean).slice(0, 40);
    return paletteGroups({ key: p.key, bpm: p.bpm, samples, prebake: app.prebake?.docs() || [] });
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const gs = groups();
    chips = [];
    const out = [];
    for (const g of gs) {
      const secs = [];
      for (const sec of g.sections) {
        const list = sec.chips.filter((c) => !q || `${c.label} ${c.code || ''} ${c.value || ''} ${c.desc || ''}`.toLowerCase().includes(q));
        if (!list.length) continue;
        const chipEls = list.map((c) => chipEl(c));
        if (sec.title) {
          const k = `${g.id}/${sec.title}`;
          const d = h('details.cpal-sec', h('summary', sec.title, h('span.cpal-count', String(list.length))), h('div.cpal-chips', chipEls));
          d.open = q ? true : (state.closed[k] ?? !!sec.collapsed) === false;
          d.addEventListener('toggle', () => { if (!q) { state.closed[k] = !d.open; save(); } });
          secs.push(d);
        } else secs.push(h('div.cpal-chips', chipEls));
      }
      if (!secs.length) continue;
      const det = h('details.cpal-group', h('summary', { title: g.desc }, h('span', g.title), h('span.cpal-gdesc', g.desc)), secs);
      det.open = q ? true : !state.closed[g.id];
      det.addEventListener('toggle', () => { if (!q) { state.closed[g.id] = !det.open; save(); } });
      out.push(det);
    }
    listEl.replaceChildren(...(out.length ? out : [h('p.muted.cpal-empty', 'No blocks match.')]));
  }

  function chipEl(c) {
    const i = chips.push(c) - 1;
    const tip = [c.desc, c.code ? `\n${c.code}` : '', c.example && c.example !== c.code ? `\nExample: ${c.example}` : '', `\n(${KIND_LABEL[c.kind] || c.kind} — drag onto a line, or click)`].join('');
    const b = h(`button.cpal-chip.k-${c.kind}`, { type: 'button', draggable: 'true', title: tip, dataset: { i } },
      c.kind === 'method' ? h('span.cpal-dot', '.') : null, c.label);
    b.addEventListener('click', () => clickInsert(c));
    b.addEventListener('dragstart', (e) => {
      dragChip = c;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(MIME, String(i));
      e.dataTransfer.setData('text/plain', c.code || c.value || c.label);
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => { dragChip = null; b.classList.remove('dragging'); hideIndicator(); });
    b.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') touchDrag(e, c, b); });
    return b;
  }

  // ---- applying a chip
  function apply(c, offset) {
    const src = editor.getValue();
    let r;
    try { r = computeDrop(src, offset, c); } catch (err) { console.warn('[palette]', err); r = null; }
    if (!r) { app.toast?.('Can\'t place that here — try an empty line or a pattern line', { level: 'warn' }); return; }
    if (r.text === src) {
      editor.setSelection(r.selStart, r.selEnd);
      if (r.message) app.setStatus?.(r.message);
      return;
    }
    // one native undo step: replace just the changed span, then select the new argument
    const ed = minimalEdit(src, r.text);
    editor.replaceRange(ed.from, ed.to, ed.insert, r.selStart, r.selEnd);
    if (r.message) app.setStatus?.(r.message);
    opts.onApplied?.(c, r);
  }
  function clickInsert(c) {
    const ta = editor.textarea;
    const pos = document.activeElement === ta || ta.dataset.cpalCaret == null ? ta.selectionStart : Number(ta.dataset.cpalCaret);
    apply(c, pos);
  }
  // remember the caret when the editor loses focus to a chip click
  editor.textarea.addEventListener('blur', () => { editor.textarea.dataset.cpalCaret = String(editor.textarea.selectionStart); });

  // ---- drop indicator
  function showIndicator(c, offset) {
    const src = editor.getValue();
    let r = null;
    try { r = computeDrop(src, offset, c); } catch { r = null; }
    const er = editor.el.getBoundingClientRect();
    const line = r ? lineOf(src, offset) : lineOf(src, offset);
    const lr = editor.lineRect(line);
    ind.classList.remove('hidden');
    ind.style.cssText = `left:${er.left}px;width:${er.width}px;top:${Math.max(er.top, Math.min(er.bottom - lr.height, lr.top))}px;height:${lr.height}px`;
    ind.classList.toggle('bad', !r);
    indLabel.classList.remove('hidden');
    indLabel.textContent = r ? (r.message || 'Insert here') : 'Can\'t place here';
    const lw = indLabel.offsetWidth || 160;
    indLabel.style.left = Math.max(er.left + 50, er.right - lw - 14) + 'px';
    indLabel.style.top = Math.max(er.top, Math.min(er.bottom - lr.height, lr.top) + 1) + 'px';
  }
  function hideIndicator() { ind.classList.add('hidden'); indLabel.classList.add('hidden'); }
  const lineOf = (src, off) => { let n = 0; for (let i = src.indexOf('\n'); i >= 0 && i < off; i = src.indexOf('\n', i + 1)) n++; return n; };

  // ---- HTML5 drag & drop onto the editor (capture: beats the textarea's own text drop)
  const isChipDrag = (e) => dragChip && [...(e.dataTransfer?.types || [])].includes(MIME);
  editor.el.addEventListener('dragover', (e) => {
    if (!isChipDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    showIndicator(dragChip, editor.offsetAt(e.clientX, e.clientY));
  }, true);
  editor.el.addEventListener('dragleave', (e) => { if (!editor.el.contains(e.relatedTarget)) hideIndicator(); }, true);
  editor.el.addEventListener('drop', (e) => {
    if (!isChipDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    const c = dragChip;
    dragChip = null;
    hideIndicator();
    apply(c, editor.offsetAt(e.clientX, e.clientY));
  }, true);

  // ---- pointer fallback (touch / pen): press, move, release over the editor
  function touchDrag(e, c, b) {
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null;
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
        ghost = h('div.cpal-ghost', c.label);
        document.body.appendChild(ghost);
        b.classList.add('dragging');
      }
      ev.preventDefault();
      ghost.style.left = ev.clientX + 8 + 'px'; ghost.style.top = ev.clientY + 8 + 'px';
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (over && editor.el.contains(over)) showIndicator(c, editor.offsetAt(ev.clientX, ev.clientY)); else hideIndicator();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      b.classList.remove('dragging');
      hideIndicator();
      if (!ghost) return;
      ghost.remove();
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ev.type === 'pointerup' && over && editor.el.contains(over)) apply(c, editor.offsetAt(ev.clientX, ev.clientY));
      // swallow the click that follows a drag
      b.addEventListener('click', (ce) => { ce.stopImmediatePropagation(); ce.preventDefault(); }, { capture: true, once: true });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ---- resize (left edge)
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = el.offsetWidth;
    const move = (ev) => { state.width = Math.max(190, Math.min(560, w0 - (ev.clientX - x0))); el.style.width = state.width + 'px'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  function setOpen(v) {
    state.open = !!v;
    save();
    el.classList.toggle('hidden', !state.open);
    btn.classList.toggle('on', state.open);
    btn.setAttribute('aria-pressed', String(state.open));
    if (state.open) refresh();
    opts.onToggle?.(state.open);
  }
  function refresh() {
    if (!state.open) return;
    const p = project();
    const k = `${p.key?.root}|${p.key?.scale}|${p.bpm}|${Object.keys(p.samples || {}).length}|${(app.prebake?.docs() || []).map((d) => d.name).join(',')}`;
    if (k === groupsKey && listEl.childElementCount) return;
    groupsKey = k;
    render();
  }
  setOpen(state.open);

  return { el, button: btn, setOpen, isOpen: () => state.open, refresh };
}

/**
 * Wire autocomplete + the building-blocks palette into the Code view.
 * body: the view's content row (the palette docks at its right edge); after: toolbar element the "Blocks" button follows.
 */
export function attachCodeTools(app, editor, { body, after } = {}) {
  let cat = null, catKey = '';
  const getCatalog = () => {
    const p = app.store.get();
    let dsl = [];
    try { dsl = strudelDslNames(); } catch { dsl = []; }
    const samples = Object.values(p.samples || {}).map((s) => s.name).filter(Boolean);
    const pb = app.prebake?.docs() || [];
    const k = `${p.key?.root}|${p.key?.scale}|${samples.length}|${dsl.length}|${pb.map((d) => d.name).join(',')}`;
    if (!cat || k !== catKey) { cat = buildCatalog({ key: p.key, samples, dsl, prebake: pb }); catKey = k; }
    return cat;
  };
  const ac = attachAutocomplete(editor, { getCatalog, getOptions: () => ({ key: app.store.get().key }) });
  const palette = createCodePalette(app, editor);
  if (body) body.appendChild(palette.el);
  if (after) after.after(palette.button);
  app.subscribe?.((ch) => { if (ch.project) palette.refresh(); });
  app.prebakeUi?.onChange(() => palette.refresh()); // prebake functions appear in the palette / autocomplete
  return { autocomplete: ac, palette };
}
