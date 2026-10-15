// Command palette (Ctrl/Cmd+K): fuzzy search over every command, main-menu, Create-menu and add-track entry.
// ↑/↓ select, Enter runs, Esc closes. Recently used entries float to the top of an empty query.
import { h } from '../ui/dom.js';
import { fuzzyScore } from './shortcuts.js';

const RECENT_KEY = 'daw3-palette-recent';
let open = null;

function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function remember(id) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 8))); } catch { /* */ } }

export function openPalette(app, entries) {
  if (open) { open.input.focus(); return open; }
  const input = h('input.ctl-palette-input', { type: 'text', placeholder: 'Type a command… (e.g. "export stems", "mixer", "midi learn")', spellcheck: false, autocomplete: 'off' });
  const list = h('div.ctl-palette-list', { role: 'listbox' });
  const hint = h('div.ctl-palette-hint', `${entries.length} actions · ↑↓ select · Enter run · Esc close · rebind keys in Preferences → Shortcuts`);
  const box = h('div.ctl-palette', { role: 'dialog', 'aria-label': 'Command palette' }, input, list, hint);
  const backdrop = h('div.ctl-palette-backdrop', box);
  let shown = [];
  let sel = 0;
  const rec = recent();

  function render() {
    const q = input.value.trim();
    if (!q) {
      const byId = new Map(entries.map((e) => [e.id, e]));
      const top = rec.map((id) => byId.get(id)).filter(Boolean);
      shown = [...top, ...entries.filter((e) => !rec.includes(e.id))].slice(0, 60);
    } else {
      shown = entries.map((e) => ({ e, s: Math.max(fuzzyScore(q, e.label), fuzzyScore(q, `${e.category} ${e.label}`) * 0.8) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.e);
    }
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((e, i) => {
      const row = h(`div.ctl-palette-item${i === sel ? '.sel' : ''}`, { role: 'option', dataset: { id: e.id } },
        h('span.ctl-palette-cat', e.category || ''), h('span.ctl-palette-label', e.label), e.shortcut ? h('kbd', e.shortcut) : null);
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
      row.addEventListener('click', () => run(i));
      return row;
    }) : [h('div.ctl-palette-empty', 'No matching action')]));
  }
  function mark() {
    [...list.children].forEach((c, i) => c.classList.toggle('sel', i === sel));
    list.children[sel]?.scrollIntoView?.({ block: 'nearest' });
  }
  function run(i) {
    const e = shown[i];
    if (!e) return;
    close();
    remember(e.id);
    app.macros?.notePaletteRun?.(e); // macro recording (src/ui/macros-ui.js): menu entries are not commands
    try { e.run(); } catch (err) { console.error('[palette]', err); app.toast?.(`Could not run "${e.label}": ${err.message}`, { level: 'error' }); }
  }
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    open = null;
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); run(sel); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); close(); }
  }
  input.addEventListener('input', () => { sel = 0; render(); });
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  render();
  input.focus();
  setTimeout(() => input.focus(), 0);
  open = { close, input };
  return open;
}
