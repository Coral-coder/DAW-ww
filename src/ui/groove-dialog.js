// "Apply groove…" dialog: pick a groove from the library (built-in MPC swing presets + grooves extracted from audio
// clips or MIDI patterns, saved in project.grooves), set timing / accent strength and apply it to a MIDI pattern
// (or only its selected notes). Used by the piano roll and the arrange clip menu.
import { h } from './dom.js';
import { modal, select, numberField, button, toast } from './components.js';
import { grooveLibrary, findGroove, grooveFromNotes } from '../time/groove.js';
import { applyGrooveToPattern } from './warp-editor.js';

const LAST = 'daw3-groove-last';
const load = () => { try { return JSON.parse(localStorage.getItem(LAST) || 'null') || {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(LAST, JSON.stringify(o)); } catch { /* */ } };

/** Tiny bar drawing of a groove's per-slot offsets (and accents). */
function grooveSketch(g) {
  const wrap = h('div.groove-sketch', { title: 'Timing offset per slot (bar height = accent)' });
  if (!g) return wrap;
  const n = g.offsets.length;
  g.offsets.forEach((off, i) => {
    const pct = (off / g.grid) * 100; // ±% of a slot
    const vel = g.velocities?.[i] ?? 1;
    wrap.appendChild(h('span.groove-slot', { style: { height: `${Math.round(30 + 60 * vel)}%`, transform: `translateX(${Math.max(-40, Math.min(40, pct))}%)`, width: `${100 / n}%` }, title: `Slot ${i + 1}: ${off >= 0 ? '+' : ''}${Math.round(pct)}% of a ${g.grid === 0.25 ? '16th' : g.grid === 0.5 ? '8th' : 'slot'}${g.velocities?.[i] != null ? `, accent ${Math.round(vel * 100)}%` : ''}` }));
  });
  return wrap;
}

/**
 * Open the dialog for one pattern. noteIds: optional Set of selected note ids (empty / null = all notes).
 * Returns the modal handle.
 */
export function openGrooveDialog(app, { patternId, noteIds = null, where = '' } = {}) {
  const { store } = app;
  const pat = store.get().patterns?.[patternId];
  if (!pat) { toast('Select a MIDI pattern first.', { level: 'warn' }); return null; }
  const last = load();
  let grooveId = findGroove(store.get(), last.id) ? last.id : 'mpc16-58';
  let strength = last.strength ?? 100, vel = last.vel ?? 0;
  const opts = () => grooveLibrary(store.get()).map((g) => ({ value: g.id, label: g.name, group: g.builtin ? 'Built-in (MPC swing)' : 'Saved in this project' }));
  const sketchHost = h('div.groove-sketch-host');
  const sel = select({ options: opts(), value: grooveId, title: 'Groove template', onChange: (v) => { grooveId = v; paint(); } });
  const paint = () => { sketchHost.replaceChildren(grooveSketch(findGroove(store.get(), grooveId))); };
  const refill = () => { sel.replaceChildren(); const fresh = select({ options: opts(), value: grooveId }); sel.append(...fresh.childNodes); sel.value = grooveId; paint(); };
  const str = numberField({ value: strength, min: 0, max: 100, step: 1, width: 52, format: (v) => `${v}%`, title: 'Timing strength: how far note starts move toward the groove', onChange: (v) => { strength = v; } });
  const velF = numberField({ value: vel, min: 0, max: 100, step: 1, width: 52, format: (v) => `${v}%`, title: 'Accent strength: how much velocities follow the groove accents', onChange: (v) => { vel = v; } });
  const extract = button('Extract from this pattern', () => {
    const p = store.get().patterns[patternId];
    if (!p?.notes?.length) { toast('The pattern has no notes.', { level: 'warn' }); return; }
    const g = grooveFromNotes(p.notes, { grid: 0.25, length: Math.min(4, Math.max(1, p.length || 4)), name: `Groove: ${p.name || 'pattern'}` });
    store.transact('Extract groove', (pp) => { pp.grooves = [...(pp.grooves || []), g]; });
    grooveId = g.id; refill();
    toast(`Groove “${g.name}” saved in the project.`, { level: 'success' });
  }, { icon: 'sparkles', cls: 'small', title: 'Save this pattern’s timing and accents as a groove template (kept in the project)' });
  const n = noteIds?.size ? noteIds.size : pat.notes.length;
  const body = h('div.groove-dialog',
    h('p.muted', `Moves ${noteIds?.size ? `${n} selected note${n === 1 ? '' : 's'}` : `all ${n} notes`} of “${pat.name || 'pattern'}”${where ? ` (${where})` : ''} toward the groove. Extract grooves from audio clips in the warp editor or from a pattern here.`),
    h('div.hrow', h('label.hfield', h('span.hlabel', 'Groove'), sel)),
    sketchHost,
    h('div.hrow', h('label.hfield', h('span.hlabel', 'Timing'), str), h('label.hfield', h('span.hlabel', 'Accents'), velF), h('div.spacer'), extract));
  paint();
  return modal({
    title: 'Apply groove', body, width: 480, cls: 'groove-modal',
    actions: [
      { label: 'Cancel' },
      { label: 'Apply', primary: true, onClick: () => {
        save({ id: grooveId, strength, vel });
        const ok = applyGrooveToPattern(app, patternId, grooveId, { strength: strength / 100, velStrength: vel / 100, noteIds: noteIds?.size ? noteIds : null });
        if (ok) { app.setStatus?.(`Groove “${findGroove(store.get(), grooveId)?.name}” applied at ${strength}%.`); return true; }
        toast('Pick a groove.', { level: 'warn' });
        return false;
      } },
    ],
  });
}
