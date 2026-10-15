// Shared bits for Pocket pages.
import { h, icon } from '../../ui/dom.js';
import { PRESETS, DRUM_KITS } from '../../audio/index.js';
import { PRESET_CATEGORIES } from '../../audio/presets.js';
import { actionSheet, haptic } from '../touch.js';
import { presetSheet } from '../preset-sheets.js';

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
  const b = h(`button.pk-ib${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}`, { type: 'button', 'aria-label': label, title: label }, icon(ic, 20), label && cls.includes('labeled') ? h('span', label) : null);
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
 * Sound browser sheet: search, All / Favorites / Recent / User, category chips and a long scrollable list (incl.
 * Strudel sounds and user presets); tapping a sound applies it and plays a preview note (src/mobile/preset-sheets.js).
 */
export function soundBrowser(app, trackId) {
  const t0 = app.store.get().tracks.find((t) => t.id === trackId);
  if (!t0) return;
  presetSheet(app, { kind: 'instrument', trackId, startCategory: PRESETS[t0.instrument?.preset]?.category || '' });
}

export function emptyState(title, text, ...buttons) {
  return h('div.pk-empty', h('h3', title), h('p', text), h('div.pk-col', ...buttons));
}
