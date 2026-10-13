// Autocomplete popup for the code editor (code-editor.js). Context-aware: pattern methods after `.`,
// functions / your consts at expression positions, and inside string arguments sounds, banks, scales,
// chords, notes and mini-notation operators (see src/code/assist.js for the pure logic).
//
// attachAutocomplete(editor, { getCatalog() }) -> { open(force), close(), isOpen(), el }
// Keys: typing an identifier / `.` opens it, Ctrl+Space forces it, ↑/↓ select, Enter/Tab accept, Esc closes.
import { h } from './dom.js';
import { completionsAt, applyCompletion } from '../code/assist.js';

const LS_RECENT = 'daw3-code-ac-recent';
const loadRecent = () => { try { const v = JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); return Array.isArray(v) ? v.slice(0, 40) : []; } catch { return []; } };
const saveRecent = (r) => { try { localStorage.setItem(LS_RECENT, JSON.stringify(r.slice(0, 40))); } catch { /* ignore */ } };

const KIND_ICON = { method: 'ƒ', function: 'ƒ', signal: '∿', const: 'c', keyword: 'k', sound: '♪', preset: '♫', bank: '▦', scale: '♭', chord: '♯', note: '♩', value: '·', mini: '⁂' };
let uid = 0;

export function attachAutocomplete(editor, { getCatalog, getOptions } = {}) {
  const ta = editor.textarea;
  const id = `cac-${++uid}`;
  const list = h('div.cac-list', { role: 'listbox', id, 'aria-label': 'Code suggestions' });
  const doc = h('div.cac-doc', { 'aria-live': 'polite' });
  const el = h('div.cac-pop.hidden', list, doc);
  document.body.appendChild(el);
  let res = null; // completionsAt result
  let sel = 0;
  let open = false;
  let forced = false;
  let recent = loadRecent();
  let suppressNext = false;

  function close() {
    if (!open) return;
    open = false; forced = false; res = null;
    el.classList.add('hidden');
    ta.removeAttribute('aria-activedescendant');
    ta.setAttribute('aria-expanded', 'false');
  }

  function update(force = false) {
    if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { close(); return; }
    const src = ta.value, pos = ta.selectionStart;
    let r;
    try { r = completionsAt(src, pos, getCatalog(), { recent, force: force || forced }); } catch (e) { console.warn('[autocomplete]', e); close(); return; }
    if (!r.items.length) { close(); return; }
    const sameList = open && res && res.items.length === r.items.length && res.items[0] === r.items[0];
    res = r;
    if (!sameList) sel = 0;
    sel = Math.min(sel, r.items.length - 1);
    open = true;
    if (force) forced = true;
    render();
    position();
  }

  function render() {
    list.replaceChildren(...res.items.map((it, i) => {
      const row = h(`div.cac-item${i === sel ? '.on' : ''}`, { role: 'option', id: `${id}-${i}`, 'aria-selected': i === sel ? 'true' : 'false', title: it.desc || it.detail || it.label },
        h(`span.cac-kind.k-${it.kind}`, KIND_ICON[it.kind] || '·'),
        h('span.cac-label', highlightPrefix(it.label, res.ctx.prefix)),
        h('span.cac-detail', it.detail && it.detail !== it.label ? shorten(it.detail.replace(/^pat\./, '.'), 28) : ''));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; accept(); });
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; markSel(); } });
      return row;
    }));
    el.classList.remove('hidden');
    ta.setAttribute('aria-expanded', 'true');
    markSel();
  }
  function markSel() {
    [...list.children].forEach((c, i) => { c.classList.toggle('on', i === sel); c.setAttribute('aria-selected', i === sel ? 'true' : 'false'); });
    const cur = list.children[sel];
    if (cur) {
      cur.scrollIntoView({ block: 'nearest' });
      ta.setAttribute('aria-activedescendant', cur.id);
    }
    renderDoc(res.items[sel]);
  }
  function renderDoc(it) {
    if (!it || (!it.desc && !it.example && !it.detail)) { doc.classList.add('hidden'); return; }
    doc.classList.remove('hidden');
    const fnLike = ['method', 'function', 'const', 'keyword'].includes(it.kind);
    doc.replaceChildren(...[
      it.detail ? h(fnLike ? 'code.cac-sig' : 'span.cac-tag', it.detail) : null,
      it.desc ? h('p', it.desc) : null,
      it.example ? h('pre.cac-ex', it.example) : null,
      h('div.cac-keys', 'Enter / Tab insert · Esc close'),
    ].filter(Boolean));
  }
  function position() {
    const c = editor.coordsAt(res.from);
    const vw = window.innerWidth, vh = window.innerHeight;
    el.style.maxHeight = '';
    const w = el.offsetWidth || 520, hgt = el.offsetHeight || 240;
    let left = Math.min(c.left - 26, vw - w - 8);
    left = Math.max(8, left);
    let top = c.bottom + 2;
    if (top + hgt > vh - 8 && c.top - hgt - 2 > 8) top = c.top - hgt - 2;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function accept() {
    if (!open || !res) return false;
    const r = res;
    const it = r.items[sel];
    if (!it) return false;
    const src = ta.value;
    const out = applyCompletion(src, r, it, getOptions?.() || {});
    recent = [it.label, ...recent.filter((r) => r !== it.label)].slice(0, 40);
    saveRecent(recent);
    close();
    suppressNext = true;
    // one native undo step: replace only the changed span
    editor.replaceRange(r.from, r.to, out.inserted, out.selStart, out.selEnd);
    suppressNext = false;
    return true;
  }

  function stillValid() {
    if (!res || ta.selectionStart !== ta.selectionEnd) return false;
    let r;
    try { r = completionsAt(ta.value, ta.selectionStart, getCatalog(), { recent, force: forced }); } catch { return false; }
    return r.items.length > 0 && r.from === res.from && r.ctx.kind === res.ctx.kind && r.ctx.prefix === res.ctx.prefix;
  }

  function move(d) {
    if (!res) return;
    const n = res.items.length;
    sel = (sel + d + n) % n;
    markSel();
  }

  // capture phase on the editor root: runs before the editor's own key handling (Tab, Enter, Esc)
  editor.el.addEventListener('keydown', (e) => {
    if (e.target !== ta) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault(); e.stopPropagation();
      update(true);
      return;
    }
    if (!open) return;
    // the caret may have moved without an input event (closer skip-over): re-validate before accepting
    if ((e.key === 'Enter' || e.key === 'Tab') && !stillValid()) { close(); return; }
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { stop(); move(1); }
    else if (e.key === 'ArrowUp') { stop(); move(-1); }
    else if (e.key === 'PageDown') { stop(); move(Math.min(8, res.items.length - 1 - sel) || 0); }
    else if (e.key === 'PageUp') { stop(); move(-Math.min(8, sel)); }
    else if ((e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) { stop(); accept(); }
    else if (e.key === 'Escape') { stop(); close(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') close();
  }, true);

  ta.addEventListener('input', (e) => {
    if (suppressNext) return;
    const t = e.inputType || '';
    const data = e.data || '';
    if (t.startsWith('delete')) { if (open) update(); return; }
    if (t === 'insertText' || t === 'insertCompositionText' || t === '') {
      // typing an identifier char or `.` (auto-paired brackets/quotes arrive as two chars)
      if (/^[\w$.:#^]$/.test(data) || (open && data.length === 1 && !/[\s,()[\]{}"'`;]/.test(data))) update();
      else if (open) update();
      return;
    }
    close();
  });
  // caret moved without an input event (typing over an auto-closed quote / bracket, clicks, arrows): re-check
  let selRaf = 0;
  document.addEventListener('selectionchange', () => {
    if (!open || document.activeElement !== ta || selRaf) return;
    selRaf = requestAnimationFrame(() => { selRaf = 0; if (open) update(); });
  });
  ta.addEventListener('keydown', (e) => {
    // keys the editor handles itself by moving the caret (closer skip-over) never fire `input`
    if (open && e.key.length === 1 && /[)\]}"'`]/.test(e.key)) setTimeout(() => { if (open) update(); }, 0);
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) close(); }, 0));
  ta.addEventListener('mousedown', close);
  ta.addEventListener('scroll', () => { if (open) position(); });
  window.addEventListener('resize', close);
  el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the editor

  return { el, open: () => { ta.focus(); update(true); }, close, isOpen: () => open };
}

function highlightPrefix(label, prefix) {
  if (prefix && label.toLowerCase().startsWith(prefix.toLowerCase())) return [h('b', label.slice(0, prefix.length)), label.slice(prefix.length)];
  return label;
}
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
