// Pocket preset picking: one sheet for instrument sounds, effect presets and "add effect from preset" — search,
// All / Favorites / Recent / User scopes, category or tag chips, a star per row. Tapping an instrument preset applies
// it and plays a preview note; tapping an effect preset applies it live.
import { h } from '../ui/dom.js';
import { EFFECT_DEFS } from '../audio/effect-defs.js';
import { presetStore } from '../core/preset-store.js';
import { presetItems, filterItems, filterChips } from '../ui/preset-browser.js';
import { applyInstrumentRef, applyFxPreset, addFxToOwner, insertChain, fxOwner } from '../ui/preset-apply.js';
import { openSheet, haptic, chips } from './touch.js';

const SCOPES = [{ value: 'all', label: 'All' }, { value: 'fav', label: '★ Favorites' }, { value: 'recent', label: 'Recent' }, { value: 'user', label: 'User' }];

/**
 * presetSheet(app, { kind: 'instrument'|'effect'|'effect-add', trackId, fxId, type, title, startCategory, onAdded(fx) })
 */
export function presetSheet(app, opts) {
  const { store, engine } = app;
  const pstore = presetStore();
  const kind = opts.kind;
  const track = () => store.get().tracks.find((t) => t.id === opts.trackId);
  const t0 = track();
  if (!t0) return null;
  const drums = kind === 'instrument' && ['drums', 'drumsampler'].includes(t0.instrument?.type);
  const items = presetItems(kind, { type: opts.type, drums });
  let scope = 'all', cat = opts.startCategory && filterChips(kind, items).includes(opts.startCategory) ? opts.startCategory : '', q = '';
  let current = kind === 'instrument' ? `inst:${t0.instrument?.preset}` : null;
  const search = h('input.pk-input', { type: 'search', placeholder: kind === 'instrument' ? (drums ? 'Search kits' : 'Search sounds, roles, genres') : 'Search presets, tags', enterkeyhint: 'search' });
  const list = h('div.pk-list');
  const scopeChips = chips(SCOPES, scope, (v) => { scope = v; render(); }, { cls: 'scroll' });
  const catChips = drums ? null : chips([{ value: '', label: 'Any' }, ...filterChips(kind, items).map((c) => ({ value: c, label: c }))], cat, (v) => { cat = v; render(); }, { cls: 'scroll' });

  function apply(it) {
    haptic(8);
    if (kind === 'instrument') {
      applyInstrumentRef(app, opts.trackId, it.ref);
      current = it.key;
      const bass = track()?.role === 'bass';
      setTimeout(() => engine.previewNote?.(opts.trackId, drums || bass ? 36 : 60, 0.85, 1)?.catch?.(() => {}), 80);
    } else if (kind === 'effect') {
      applyFxPreset(app, opts.trackId, opts.fxId, it.preset);
      current = it.key;
    } else {
      const fx = it.chain ? insertChain(app, opts.trackId, it.chain, { key: it.key })[0] : addFxToOwner(app, opts.trackId, it.preset.type, it.preset.params, null, { label: `Add ${EFFECT_DEFS[it.preset.type]?.name}: ${it.preset.name}`, key: it.key });
      opts.onAdded?.(fx);
      sheet.close();
      return;
    }
    render();
  }

  function render() {
    const rows = filterItems(items, { q, scope, cat });
    const favs = new Set(pstore.favorites());
    list.replaceChildren(...rows.slice(0, 400).map((it) => {
      const on = it.key === current;
      const b = h(`button.pk-row-btn${on ? '.on' : ''}`, { type: 'button' }, h('span.pk-row-name', it.name),
        h('span.pk-row-sub', [it.source === 'user' ? 'User' : it.category, ...it.tags.slice(0, 2)].filter(Boolean).join(' · ')), on ? h('span.pk-act-check', '✓') : null);
      b.addEventListener('click', () => apply(it));
      const star = h(`button.pk-star${favs.has(it.key) ? '.on' : ''}`, { type: 'button', 'aria-label': favs.has(it.key) ? 'Remove from favorites' : 'Add to favorites' }, favs.has(it.key) ? '★' : '☆');
      star.addEventListener('click', () => { haptic(5); pstore.toggleFavorite(it.key); render(); });
      return h('div.pk-presetrow', b, star);
    }));
    if (!rows.length) list.appendChild(h('p.pk-p.muted', scope === 'fav' ? 'No favorites yet — tap ☆ to star a sound.' : scope === 'recent' ? 'Nothing used yet.' : scope === 'user' ? 'No user presets yet (save them in the desktop layout).' : 'Nothing matches.'));
  }
  search.addEventListener('input', () => { q = search.value; render(); });
  render();
  const title = opts.title || (kind === 'instrument' ? (drums ? 'Drum kit' : 'Sound') : kind === 'effect' ? `${EFFECT_DEFS[opts.type]?.name || 'Effect'} presets` : 'Add effect from preset');
  const sheet = openSheet({ title, body: [search, scopeChips, catChips, list].filter(Boolean), tall: true, cls: 'pk-browser' });
  return sheet;
}

/** Effect presets of an effect on a track (Pocket fx card). */
export function fxPresetSheet(app, trackId, fxId) {
  const f = fxOwner(app.store.get(), trackId)?.fx?.find((x) => x.id === fxId);
  if (!f) return null;
  return presetSheet(app, { kind: 'effect', trackId, fxId, type: f.type });
}
