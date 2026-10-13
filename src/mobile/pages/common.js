// Shared bits for Pocket pages.
import { h, icon } from '../../ui/dom.js';
import { PRESETS, DRUM_KITS } from '../../audio/index.js';
import { PRESET_CATEGORIES } from '../../audio/presets.js';
import { actionSheet, openSheet, haptic, chips } from '../touch.js';

export const isDrums = (t) => t?.instrument?.type === 'drums' || t?.instrument?.type === 'drumsampler';
export const isMelodic = (t) => t?.type === 'instrument' && !isDrums(t);

export function soundName(t) {
  if (!t) return '';
  if (t.type === 'audio') return 'Audio';
  if (t.type === 'code') return 'Code';
  const ins = t.instrument || {};
  if (isDrums(t)) return DRUM_KITS[ins.params?.kit || ins.preset]?.name || ins.params?.machine || 'Drums';
  return PRESETS[ins.preset]?.name || ins.params?.instrument || ins.params?.s || ins.type || '—';
}

/** Page skeleton: sticky header (title + buttons) and a scrolling body. */
export function pageShell(title, ...right) {
  const titleEl = h('h2.pk-title', title);
  const head = h('div.pk-head', titleEl, h('div.pk-head-right', ...right));
  const body = h('div.pk-body');
  const el = h('div.pk-pagewrap', head, body);
  return { el, head, body, titleEl };
}

export function iconBtn(ic, onClick, label = '', cls = '') {
  const b = h(`button.pk-ib${cls ? '.' + cls : ''}`, { type: 'button', 'aria-label': label, title: label }, icon(ic, 20), label && cls.includes('labeled') ? h('span', label) : null);
  b.addEventListener('click', (e) => { haptic(5); onClick(e); });
  return b;
}

/** Track picker sheet (instrument tracks by default). */
export function pickTrack(app, { filter = (t) => t.type === 'instrument', title = 'Choose a track', onPick }) {
  const p = app.store.get();
  const items = p.tracks.filter(filter).map((t) => ({ label: `${t.name} · ${soundName(t)}`, checked: t.id === app.ui.get('selectedTrackId'), onClick: () => { app.actions.selectTrack(t.id); onPick?.(t.id); } }));
  items.push('-', { label: 'Add a track…', icon: 'plus', onClick: () => addTrackSheet(app, (t) => onPick?.(t.id)) });
  actionSheet(title, items);
}

/** "Add track" as sheets (drum kits, instrument presets by category, audio). */
export function addTrackSheet(app, after) {
  const add = (kind, opts) => { const t = app.actions.addTrack(kind, opts); after?.(t); };
  actionSheet('Add track', [
    { label: 'Drums', icon: 'drum', submenu: Object.entries(DRUM_KITS).map(([id, k]) => ({ label: k.name, onClick: () => add(id) })) },
    ...PRESET_CATEGORIES.map((c) => ({ label: c === 'Strudel' ? 'Strudel sounds' : c, icon: 'music', submenu: Object.entries(PRESETS).filter(([, pr]) => pr.category === c).map(([id, pr]) => ({ label: pr.name, onClick: () => add(id) })) })),
    { label: 'Audio (microphone)', icon: 'wave', onClick: () => add('audio') },
  ]);
}

/**
 * Sound browser sheet: search + category chips + a long scrollable list (incl. Strudel sounds); tapping a sound
 * applies it and plays a preview note.
 */
export function soundBrowser(app, trackId) {
  const { store, actions, engine } = app;
  const track = () => store.get().tracks.find((t) => t.id === trackId);
  const t0 = track();
  if (!t0) return;
  const drums = isDrums(t0);
  let cat = drums ? 'Kits' : (PRESETS[t0.instrument?.preset]?.category || 'All');
  let q = '';
  const search = h('input.pk-input', { type: 'search', placeholder: drums ? 'Search kits' : 'Search sounds', enterkeyhint: 'search' });
  const list = h('div.pk-list');
  const catChips = drums ? null : chips([{ value: 'All', label: 'All' }, ...PRESET_CATEGORIES.map((c) => ({ value: c, label: c }))], cat, (v) => { cat = v; render(); }, { cls: 'scroll' });
  const apply = (id) => {
    haptic(8);
    if (drums) actions.updateTrack(trackId, (t) => { const params = { ...(t.instrument.params || {}), kit: id }; delete params.machine; t.instrument = { type: 'drums', preset: id, params }; }, `Kit: ${DRUM_KITS[id]?.name}`);
    else { const pr = PRESETS[id]; actions.updateTrack(trackId, (t) => { t.instrument = { type: pr.instrument.type, preset: id, params: {} }; }, `Sound: ${pr.name}`); }
    setTimeout(() => engine.previewNote(trackId, drums ? 36 : 60, 0.85, 1).catch(() => {}), 60);
    render();
  };
  function render() {
    const cur = track()?.instrument;
    const all = drums ? Object.entries(DRUM_KITS).map(([id, k]) => ({ id, name: k.name, sub: 'Drum kit' })) : Object.entries(PRESETS).map(([id, pr]) => ({ id, name: pr.name, sub: pr.category, cat: pr.category, roles: pr.roles }));
    const ql = q.toLowerCase();
    const rows = all.filter((r) => (drums || cat === 'All' || r.cat === cat) && (!ql || r.name.toLowerCase().includes(ql) || String(r.sub).toLowerCase().includes(ql)));
    list.replaceChildren(...rows.map((r) => {
      const on = drums ? (cur?.params?.kit || cur?.preset) === r.id : cur?.preset === r.id;
      const b = h(`button.pk-row-btn${on ? '.on' : ''}`, { type: 'button' }, h('span.pk-row-name', r.name), h('span.pk-row-sub', [r.sub, ...(r.roles || []).slice(0, 2)].join(' · ')), on ? h('span.pk-act-check', '✓') : null);
      b.addEventListener('click', () => apply(r.id));
      return b;
    }));
    if (!rows.length) list.appendChild(h('p.pk-p.muted', 'No sounds match.'));
  }
  search.addEventListener('input', () => { q = search.value; render(); });
  render();
  openSheet({ title: drums ? 'Drum kit' : 'Sound', body: [search, catChips, list].filter(Boolean), tall: true, cls: 'pk-browser' });
}

export function emptyState(title, text, ...buttons) {
  return h('div.pk-empty', h('h3', title), h('p', text), h('div.pk-col', ...buttons));
}
