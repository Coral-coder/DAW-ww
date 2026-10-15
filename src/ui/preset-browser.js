// Preset browser popover for instruments and effects: search, category / tag filters, favorites (star), recently
// used, user vs factory, keyboard stepping and audition-on-select (instrument presets play a note when selected; effect
// presets are applied live so they can be heard on playback). Esc / Cancel reverts to the sound the device had.
import { h, icon } from './dom.js';
import { contextMenu, promptText, confirmDialog } from './components.js';
import { deepClone } from '../core/util.js';
import { PRESETS, PRESET_CATEGORIES } from '../audio/presets.js';
import { DRUM_KITS } from '../audio/kits.js';
import { EFFECT_DEFS } from '../audio/effect-defs.js';
import { effectPresetEntries, EFFECT_PRESET_TAGS } from '../audio/effect-presets.js';
import { presetStore, keyOf } from '../core/preset-store.js';
import { applyInstrumentRef, applyFxPreset, addFxToOwner, insertChain, fxOwner, instKey, fxKey, exportPresets, DT_PRESET_REF, encodeRef } from './preset-apply.js';

const LS_AUDITION = 'daw3-preset-audition';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
const DRUM_TYPES = new Set(['drums', 'drumsampler']);

// ------------------------------------------------------------------ item lists (also used by Pocket and stepping)
/**
 * Browsable items. kind 'instrument' (opts.drums: kits instead of melodic presets), 'effect' (opts.type) or
 * 'effect-add' (every effect preset + FX chains). Item: { key, name, source:'factory'|'user', category, tags[],
 * description, ref } — ref is what preset-apply.js understands.
 */
export function presetItems(kind, opts = {}) {
  const store = presetStore();
  const out = [];
  if (kind === 'instrument') {
    if (opts.drums) {
      for (const [id, k] of Object.entries(DRUM_KITS)) out.push({ key: instKey(id), name: k.name, source: 'factory', category: 'Kits', tags: ['drums'], description: k.description || '', ref: { kind: 'inst', id } });
    } else {
      for (const [id, pr] of Object.entries(PRESETS)) {
        if (DRUM_TYPES.has(pr.instrument?.type)) continue;
        out.push({ key: instKey(id), name: pr.name, source: 'factory', category: pr.category || 'Other', tags: [...(pr.roles || []), ...(pr.genres || [])], description: pr.description || '', type: pr.instrument.type, ref: { kind: 'inst', id } });
      }
    }
    for (const u of store.list('instrument')) {
      if (DRUM_TYPES.has(u.type) !== !!opts.drums) continue;
      out.push({ key: keyOf('instrument', u.id), name: u.name, source: 'user', category: PRESETS[u.preset]?.category || 'User', tags: u.tags || [], description: u.description || '', type: u.type, ref: { kind: 'inst-user', id: u.id }, userId: u.id, userKind: 'instrument' });
    }
  } else if (kind === 'effect') {
    for (const e of effectPresetEntries(opts.type)) out.push({ key: fxKey(opts.type, e.name), name: e.name, source: 'factory', category: e.tags[0] || 'Presets', tags: e.tags, description: e.description, preset: { ...e, key: fxKey(opts.type, e.name) }, ref: { kind: 'fx', type: opts.type, name: e.name } });
    for (const u of store.list('effect').filter((x) => x.type === opts.type)) {
      out.push({ key: keyOf('effect', u.id), name: u.name, source: 'user', category: 'User', tags: u.tags || [], description: u.description || '', preset: { type: u.type, name: u.name, params: u.params, key: keyOf('effect', u.id) }, ref: { kind: 'fx-user', id: u.id }, userId: u.id, userKind: 'effect' });
    }
  } else if (kind === 'effect-add') {
    for (const [type, def] of Object.entries(EFFECT_DEFS)) {
      if (def.plugin) continue;
      for (const e of effectPresetEntries(type)) out.push({ key: fxKey(type, e.name), name: `${def.name}: ${e.name}`, source: 'factory', category: def.category || 'Other', tags: e.tags, description: e.description, preset: { ...e, key: fxKey(type, e.name) }, ref: { kind: 'fx', type, name: e.name } });
    }
    for (const u of store.list('effect')) out.push({ key: keyOf('effect', u.id), name: `${EFFECT_DEFS[u.type]?.name || u.type}: ${u.name}`, source: 'user', category: EFFECT_DEFS[u.type]?.category || 'Other', tags: u.tags || [], description: '', preset: { type: u.type, name: u.name, params: u.params, key: keyOf('effect', u.id) }, ref: { kind: 'fx-user', id: u.id }, userId: u.id, userKind: 'effect' });
    for (const c of store.list('chain')) out.push({ key: keyOf('chain', c.id), name: `Chain: ${c.name}`, source: 'user', category: 'FX chains', tags: c.tags || [], description: c.fx.map((f) => EFFECT_DEFS[f.type]?.name || f.type).join(' → '), chain: c, ref: { kind: 'chain', id: c.id }, userId: c.id, userKind: 'chain' });
  }
  return out;
}

/** Filter items: { q, scope: 'all'|'fav'|'recent'|'user'|'factory', cat }. Recent keeps most-recent-first order. */
export function filterItems(items, { q = '', scope = 'all', cat = '' } = {}) {
  const store = presetStore();
  const favs = new Set(store.favorites());
  const recent = store.recent();
  let list = items;
  if (scope === 'fav') list = list.filter((it) => favs.has(it.key));
  else if (scope === 'user') list = list.filter((it) => it.source === 'user');
  else if (scope === 'factory') list = list.filter((it) => it.source === 'factory');
  else if (scope === 'recent') list = recent.map((k) => list.find((it) => it.key === k)).filter(Boolean);
  if (cat) list = list.filter((it) => it.category === cat || it.tags.includes(cat));
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) list = list.filter((it) => { const hay = `${it.name} ${it.category} ${it.tags.join(' ')} ${it.description}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  return list;
}

/** Category / tag chips for a kind. */
export function filterChips(kind, items) {
  if (kind === 'instrument') {
    const cats = [...new Set(items.map((it) => it.category))];
    return [...PRESET_CATEGORIES.filter((c) => cats.includes(c)), ...cats.filter((c) => !PRESET_CATEGORIES.includes(c))];
  }
  if (kind === 'effect-add') return [...new Set(items.map((it) => it.category))];
  const tags = new Set(items.flatMap((it) => it.tags));
  return [...EFFECT_PRESET_TAGS.filter((t) => tags.has(t)), ...[...tags].filter((t) => !EFFECT_PRESET_TAGS.includes(t))];
}

// ------------------------------------------------------------------ popover
let openPop = null;
export function closePresetBrowser() { openPop?.close(false); }

/**
 * openPresetBrowser(app, { kind, anchor (element or {clientX, clientY}), trackId (instrument), ownerId + fxId + type
 * (effect), ownerId (effect-add), title })
 */
export function openPresetBrowser(app, opts) {
  openPop?.close(false);
  const store = presetStore();
  const kind = opts.kind;
  const p0 = app.store.get();
  let original = null; // what to restore on cancel
  let drums = false;
  if (kind === 'instrument') {
    const t = p0.tracks.find((x) => x.id === opts.trackId);
    if (!t?.instrument) return null;
    original = deepClone(t.instrument);
    drums = DRUM_TYPES.has(t.instrument.type);
  } else if (kind === 'effect') {
    const f = fxOwner(p0, opts.ownerId)?.fx?.find((x) => x.id === opts.fxId);
    if (!f) return null;
    original = deepClone(f.params || {});
  }
  let items = presetItems(kind, { type: opts.type, drums });
  let scope = 'all', cat = '', q = '';
  let sel = -1;
  let shown = [];
  let changed = false;
  let audition = lsGet(LS_AUDITION, true);

  const search = h('input.psb-search', { type: 'search', placeholder: kind === 'instrument' ? 'Search presets, roles, genres…' : 'Search presets, tags…' });
  const scopeRow = h('div.psb-chips');
  const catRow = h('div.psb-chips.psb-cats');
  const list = h('div.psb-list', { tabIndex: -1 });
  const info = h('div.psb-info');
  const audBox = h('input', { type: 'checkbox', checked: audition });
  audBox.addEventListener('change', () => { audition = audBox.checked; lsSet(LS_AUDITION, audition); });
  const footer = h('div.psb-footer',
    kind === 'instrument' ? h('label.psb-aud', { title: 'Play a note when a preset is selected' }, audBox, 'Audition') : h('span.psb-hint.muted', kind === 'effect' ? 'Selecting applies live — press play to hear' : 'Double-click to add'),
    h('div.spacer'),
    h('button.btn.small', { type: 'button', onclick: () => close(false) }, kind === 'effect-add' ? 'Close' : 'Cancel'),
    kind === 'effect-add' ? null : h('button.btn.small.primary', { type: 'button', onclick: () => commit() }, 'Done'));
  const titleText = opts.title || (kind === 'instrument' ? 'Instrument presets' : kind === 'effect' ? `${EFFECT_DEFS[opts.type]?.name || opts.type} presets` : 'Effect presets & chains');
  const el = h('div.psb-pop', { role: 'dialog', 'aria-label': titleText },
    h('div.psb-head', icon('search', 13), h('b', titleText), h('div.spacer'), h('button.psb-x', { type: 'button', title: 'Close (Esc reverts)', onclick: () => close(false) }, icon('x', 13))),
    h('div.psb-searchrow', search), scopeRow, catRow, list, info, footer);

  const SCOPES = [['all', 'All'], ['fav', '★ Favorites'], ['recent', 'Recent'], ['user', 'User'], ['factory', 'Factory']];
  function renderChips() {
    scopeRow.replaceChildren(...SCOPES.map(([v, l]) => {
      const b = h(`button.psb-chip${scope === v ? '.on' : ''}`, { type: 'button' }, l);
      b.addEventListener('click', () => { scope = v; renderChips(); renderList(); });
      return b;
    }));
    const chips = filterChips(kind, items);
    catRow.replaceChildren(...['', ...chips].map((c) => {
      const b = h(`button.psb-chip.small${cat === c ? '.on' : ''}`, { type: 'button' }, c || 'Any');
      b.addEventListener('click', () => { cat = cat === c ? '' : c; renderChips(); renderList(); });
      return b;
    }));
  }

  function renderList() {
    shown = filterItems(items, { q, scope, cat });
    const favs = new Set(store.favorites());
    list.replaceChildren(...shown.map((it, i) => {
      const star = h(`button.psb-star${favs.has(it.key) ? '.on' : ''}`, { type: 'button', title: favs.has(it.key) ? 'Remove from favorites' : 'Add to favorites' }, favs.has(it.key) ? '★' : '☆');
      star.addEventListener('click', (e) => { e.stopPropagation(); store.toggleFavorite(it.key); renderList(); });
      const row = h(`div.psb-row${i === sel ? '.sel' : ''}${it.source === 'user' ? '.user' : ''}`, { draggable: true, title: it.description || it.name, dataset: { i: String(i) } },
        star, h('span.psb-name', it.name), h('span.psb-meta', it.source === 'user' ? 'User' : it.category));
      row.addEventListener('click', () => select(i));
      row.addEventListener('dblclick', () => { select(i, false); commit(); });
      row.addEventListener('contextmenu', (e) => rowMenu(e, it));
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DT_PRESET_REF, encodeRef(it.ref)); e.dataTransfer.setData('text/plain', it.name); e.dataTransfer.effectAllowed = 'copy'; });
      return row;
    }));
    if (!shown.length) list.appendChild(h('div.psb-empty.muted', scope === 'fav' ? 'No favorites yet — click ☆ to star a preset.' : scope === 'recent' ? 'Nothing used yet.' : scope === 'user' ? 'No user presets yet — save one with the disk button.' : 'No presets match.'));
  }

  function rowMenu(e, it) {
    const items2 = [
      { header: it.name },
      { label: store.isFavorite(it.key) ? 'Remove from favorites' : 'Add to favorites', onClick: () => { store.toggleFavorite(it.key); renderList(); } },
    ];
    if (it.source === 'user') {
      items2.push(
        { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptText('Rename preset', it.name.replace(/^[^:]+: /, '')); if (n) { store.rename(it.userKind, it.userId, n); refresh(); } } },
        { label: 'Export (.daw3preset)…', icon: 'download', onClick: () => { const e2 = store.get(it.userKind, it.userId); if (e2) exportPresets({ [{ instrument: 'instruments', effect: 'effects', chain: 'chains' }[it.userKind]]: [e2] }, e2.name, true); } },
        { label: 'Delete', icon: 'trash', onClick: async () => { if (await confirmDialog('Delete preset', `Delete “${it.name}”? This cannot be undone.`)) { store.remove(it.userKind, it.userId); refresh(); } } },
      );
    }
    contextMenu(e, items2);
  }

  function refresh() { items = presetItems(kind, { type: opts.type, drums }); sel = -1; renderChips(); renderList(); }

  let auditionTimer = 0;
  function preview(it) {
    if (kind === 'instrument') {
      applyInstrumentRef(app, opts.trackId, it.ref, { preview: true });
      changed = true;
      if (audition) {
        clearTimeout(auditionTimer);
        const t = app.store.get().tracks.find((x) => x.id === opts.trackId);
        const bass = t?.role === 'bass' || PRESETS[it.ref.id]?.roles?.[0] === 'bass';
        const pitch = drums ? 36 : bass ? 36 : 60;
        auditionTimer = setTimeout(() => { app.actions?.ensureAudio?.(); app.engine?.previewNote?.(opts.trackId, pitch, 0.85, 1)?.catch?.(() => {}); }, 90);
      }
    } else if (kind === 'effect') {
      applyFxPreset(app, opts.ownerId, opts.fxId, it.preset, { preview: true });
      changed = true;
    }
  }
  function select(i, doPreview = true) {
    sel = i;
    for (const r of list.children) r.classList?.toggle('sel', r.dataset?.i === String(i));
    list.children[i]?.scrollIntoView?.({ block: 'nearest' });
    const it = shown[i];
    if (!it) return;
    info.replaceChildren(h('b', it.name), it.description ? h('span', ' — ' + it.description) : null, it.tags.length ? h('div.psb-tags', it.tags.slice(0, 8).join(' · ')) : null);
    if (doPreview) preview(it);
  }

  function commit() {
    const it = shown[sel];
    if (it) {
      if (kind === 'effect-add') {
        if (it.chain) insertChain(app, opts.ownerId, it.chain, { key: it.key });
        else addFxToOwner(app, opts.ownerId, it.preset.type, it.preset.params, null, { label: `Add ${EFFECT_DEFS[it.preset.type]?.name}: ${it.preset.name}`, key: it.key });
      } else store.touch(it.key);
      opts.onCommit?.(it);
    }
    close(true);
  }

  function close(keep) {
    if (openPop !== api) return;
    openPop = null;
    clearTimeout(auditionTimer);
    el.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (!keep && changed && original) {
      if (kind === 'instrument') app.store.transact('Revert preset browse', (p) => { const t = p.tracks.find((x) => x.id === opts.trackId); if (t) t.instrument = deepClone(original); });
      else if (kind === 'effect') app.store.transact('Revert preset browse', (p) => { const f = fxOwner(p, opts.ownerId)?.fx?.find((x) => x.id === opts.fxId); if (f) f.params = deepClone(original); });
    }
    opts.onClose?.(keep);
  }
  // clicking elsewhere keeps the current choice (like a dropdown)
  const onOutside = (e) => { if (!el.contains(e.target) && !e.target.closest?.('.ctx-menu, .modal-backdrop')) close(true); };

  search.addEventListener('input', () => { q = search.value; sel = -1; renderList(); });
  // keys while open (capture on the document: focus may sit on a row control that a re-render removed)
  const onKey = (e) => {
    if (!el.isConnected || document.querySelector('.modal-backdrop')) return;
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Enter'].includes(e.key) || (e.target !== search && e.target.closest?.('input, textarea, select') && !el.contains(e.target))) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) select(Math.max(0, Math.min(shown.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))); }
    else if (e.key === 'Enter') { e.preventDefault(); if (sel < 0 && shown.length) select(0, kind !== 'effect-add'); commit(); }
  };
  document.addEventListener('keydown', onKey, true);

  const api = { close, el };
  openPop = api;
  document.body.appendChild(el);
  // place next to the anchor, inside the viewport
  const r = opts.anchor?.getBoundingClientRect ? opts.anchor.getBoundingClientRect() : { left: opts.anchor?.clientX ?? 100, bottom: opts.anchor?.clientY ?? 100, top: opts.anchor?.clientY ?? 100 };
  const W = Math.min(380, window.innerWidth - 16), H = Math.min(520, window.innerHeight - 16);
  el.style.width = W + 'px';
  el.style.maxHeight = H + 'px';
  let top = r.bottom + 4;
  if (top + H > window.innerHeight - 8) top = Math.max(8, (r.top ?? top) - H - 4);
  el.style.left = Math.max(8, Math.min(window.innerWidth - W - 8, r.left)) + 'px';
  el.style.top = Math.max(8, top) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);

  renderChips();
  renderList();
  // start on the current preset
  const curKey = kind === 'instrument' ? (original?.preset ? instKey(original.preset) : null) : opts.currentKey || null;
  const ci = curKey ? shown.findIndex((it) => it.key === curKey) : -1;
  if (ci >= 0) select(ci, false);
  setTimeout(() => search.focus(), 10);
  return api;
}
