// Device-card preset tools for the device panel: preset browse / previous / next, A/B compare, the A–H snapshot bar
// with morphing, randomize (subtle / wild / within preset tags) with per-parameter locks (right-click a knob), and
// saving user presets / FX chains / track templates. Kept apart from device.js, which only places these controls.
import { h, icon } from './dom.js';
import { contextMenu, promptText } from './components.js';
import { deepClone } from '../core/util.js';
import { EFFECT_DEFS, resolveEffectParams } from '../audio/effect-defs.js';
import { INSTRUMENT_DEFS } from '../audio/defs.js';
import { PRESETS, resolveInstrumentDef } from '../audio/presets.js';
import { effectPresetEntries } from '../audio/effect-presets.js';
import { morphParams, randomizeParams, randomizeWithinPresets } from '../audio/preset-tools.js';
import { presetStore } from '../core/preset-store.js';
import { openPresetBrowser, presetItems } from './preset-browser.js';
import { applyFxPreset, fxOwner, chainFromFx, templateFromTrack } from './preset-apply.js';

const SLOTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
/** Instrument params never randomized / morphed (tuning, voice count, sample bindings, output level). */
export const INST_RANDOM_SKIP = new Set(['gain', 'polyphony', 'transpose', 'bendRange', 'rootNote', 'kit', 'machine', 'sampleId', 'start', 'end', 'loopStart', 'loopEnd',
  'slices', 'tune', 'fine', 'velToAmp', 'velSens', 'keyScale', 'mono', 'legato', 'glideAlways', 's', 'n', 'instrument', 'library']);

// ------------------------------------------------------------------ per-device UI state (session only)
const devState = new Map(); // devKey -> { ab: {active, A, B}, snaps: [8], morph: {from, to, t}, locks: Set, presetKey }
export function deviceState(devKey) {
  let s = devState.get(devKey);
  if (!s) devState.set(devKey, (s = { ab: { active: 'A', A: null, B: null }, snaps: Array(8).fill(null), morph: { from: 0, to: 1, t: 0 }, locks: new Set(), presetKey: null }));
  return s;
}
export const fxDevKey = (fxId) => `fx:${fxId}`;
export const insDevKey = (trackId) => `ins:${trackId}`;
export const isLocked = (devKey, key) => !!devState.get(devKey)?.locks.has(key);
export const lockedKeys = (devKey) => [...(devState.get(devKey)?.locks || [])];

/** Device key + param key of an automation target ('fx:<fxId>:<key>' | 'inst:<key>' on owner). */
function parseTarget(owner, target) {
  let m = /^fx:([^:]+):(.+)$/.exec(target || '');
  if (m) return { devKey: fxDevKey(m[1]), key: m[2] };
  m = /^inst:(.+)$/.exec(target || '');
  if (m) return { devKey: insDevKey(owner), key: m[1] };
  return null;
}

/** Outline locked knobs inside root (call after (re)building device cards). */
export function markLocks(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-auto-target]')) {
    const t = parseTarget(el.dataset.autoOwner, el.dataset.autoTarget);
    el.classList.toggle('rnd-locked', !!t && isLocked(t.devKey, t.key));
  }
}

/**
 * Adds "Lock from randomize" to the right-click menu of device knobs (chained onto app.automationContextExtras,
 * whoever installs that hook first).
 */
export function installLockMenu(app) {
  if (app._presetLockMenu) return;
  app._presetLockMenu = true;
  let inner = app.automationContextExtras || null;
  const extras = (owner, target, el) => {
    const base = inner?.(owner, target, el) || [];
    const t = parseTarget(owner, target);
    if (!t) return base;
    const s = deviceState(t.devKey);
    const on = s.locks.has(t.key);
    return [...base, '-', {
      label: on ? 'Unlock (randomize may change it)' : 'Lock from randomize', icon: 'dice',
      onClick: () => { if (on) s.locks.delete(t.key); else s.locks.add(t.key); el.classList.toggle('rnd-locked', !on); app.setStatus?.(on ? 'Unlocked — randomize can change this control again.' : 'Locked — randomize leaves this control alone.'); },
    }];
  };
  Object.defineProperty(app, 'automationContextExtras', { configurable: true, get: () => extras, set: (fn) => { inner = fn; } });
}

// ------------------------------------------------------------------ device adapters
/** Effect device adapter: read / write the effect's params by id. */
function fxAdapter(app, ownerId, fxId) {
  const get = () => fxOwner(app.store.get(), ownerId)?.fx?.find((x) => x.id === fxId) || null;
  return {
    devKey: fxDevKey(fxId),
    kind: 'effect',
    get,
    title: () => { const f = get(); return EFFECT_DEFS[f?.type]?.name || f?.type || 'Effect'; },
    read: () => deepClone(get()?.params || {}),
    write: (params, label, o) => app.store.transact(label, (p) => { const f = fxOwner(p, ownerId)?.fx?.find((x) => x.id === fxId); if (f) f.params = deepClone(params); }, o),
    defs: () => (EFFECT_DEFS[get()?.type]?.params || []).filter((d) => d.type !== 'track'),
    resolved: (params) => resolveEffectParams({ type: get()?.type, params }),
  };
}
/** Instrument adapter: snapshots hold the whole instrument { type, preset, params }. */
function insAdapter(app, trackId) {
  const get = () => app.store.get().tracks.find((x) => x.id === trackId)?.instrument || null;
  return {
    devKey: insDevKey(trackId),
    kind: 'instrument',
    get,
    title: () => INSTRUMENT_DEFS[get()?.type]?.name || 'Instrument',
    read: () => deepClone(get() || {}),
    write: (ins, label, o) => app.store.transact(label, (p) => { const t = p.tracks.find((x) => x.id === trackId); if (t?.instrument) { t.instrument = deepClone(ins); t.instrument.edited = true; } }, o),
    defs: () => (INSTRUMENT_DEFS[get()?.type]?.params || []).filter((d) => ['number', 'enum', 'bool'].includes(d.type) && !INST_RANDOM_SKIP.has(d.key)),
    resolved: (ins) => resolveInstrumentDef(ins).params,
  };
}

// ------------------------------------------------------------------ A/B
function abSwitch(ad, slot) {
  const s = deviceState(ad.devKey).ab;
  if (slot === s.active) return;
  s[s.active] = ad.read();
  if (!s[slot]) s[slot] = ad.read(); // first visit: B starts as a copy of A
  ad.write(s[slot], `A/B: ${slot}`);
  s.active = slot;
}
function abCopy(ad, from, to) {
  const s = deviceState(ad.devKey).ab;
  const src = from === s.active ? ad.read() : s[from] || ad.read();
  if (to === s.active) ad.write(src, `Copy ${from} → ${to}`); else s[to] = deepClone(src);
}
function abControl(ad) {
  const s = deviceState(ad.devKey).ab;
  const mk = (slot) => {
    const b = h(`button.dv-ab-btn${s.active === slot ? '.on' : ''}`, { type: 'button', title: `Compare: ${slot === 'A' ? 'setting A' : 'setting B'} (right-click: copy)` }, slot);
    b.addEventListener('click', (e) => { e.stopPropagation(); abSwitch(ad, slot); refreshAb(); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); contextMenu(e, abMenu(ad, refreshAb)); });
    return b;
  };
  const a = mk('A'), b = mk('B');
  const el = h('span.dv-ab', { title: 'A/B compare — switch between two settings of this device' }, a, b);
  function refreshAb() { a.classList.toggle('on', s.active === 'A'); b.classList.toggle('on', s.active === 'B'); }
  el.refresh = refreshAb;
  return el;
}
function abMenu(ad, after) {
  return [
    { header: 'A/B compare' },
    { label: 'Copy A → B', icon: 'copy', onClick: () => { abCopy(ad, 'A', 'B'); after?.(); } },
    { label: 'Copy B → A', icon: 'copy', onClick: () => { abCopy(ad, 'B', 'A'); after?.(); } },
  ];
}

// ------------------------------------------------------------------ snapshots + morph
let snapPop = null;
/** Floating A–H snapshot bar with a morph slider between two chosen snapshots. */
export function openSnapshots(app, ad, anchor) {
  snapPop?.remove();
  const st = deviceState(ad.devKey);
  const slotBtns = SLOTS.map((name, i) => {
    const b = h('button.sn-slot', { type: 'button' }, name);
    b.addEventListener('click', (e) => {
      if (!st.snaps[i] || e.shiftKey) { st.snaps[i] = ad.read(); app.setStatus?.(`Snapshot ${name} stored`); } else { ad.write(st.snaps[i], `Recall snapshot ${name}`); }
      render();
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e, [{ header: `Snapshot ${name}` },
        { label: 'Store current settings', icon: 'save', onClick: () => { st.snaps[i] = ad.read(); render(); } },
        { label: 'Recall', disabled: !st.snaps[i], onClick: () => ad.write(st.snaps[i], `Recall snapshot ${name}`) },
        { label: 'Clear', icon: 'x', disabled: !st.snaps[i], onClick: () => { st.snaps[i] = null; render(); } }]);
    });
    return b;
  });
  const mkSel = (k) => {
    const s = h('select.sn-sel', { title: k === 'from' ? 'Morph from' : 'Morph to' }, ...SLOTS.map((n, i) => h('option', { value: String(i) }, n)));
    s.value = String(st.morph[k]);
    s.addEventListener('change', () => { st.morph[k] = +s.value; render(); });
    return s;
  };
  const fromSel = mkSel('from'), toSel = mkSel('to');
  const slider = h('input.sn-morph', { type: 'range', min: 0, max: 1, step: 0.001, value: st.morph.t });
  const pct = h('span.sn-pct');
  slider.addEventListener('input', () => {
    st.morph.t = +slider.value;
    pct.textContent = `${Math.round(st.morph.t * 100)}%`;
    const a = st.snaps[st.morph.from], b = st.snaps[st.morph.to];
    if (!a || !b) return;
    ad.write(morphOf(ad, a, b, st.morph.t), 'Morph snapshots', { coalesce: true });
  });
  const note = h('div.sn-note');
  const close = h('button.psb-x', { type: 'button', title: 'Close' }, icon('x', 13));
  const el = h('div.sn-pop', { role: 'dialog', 'aria-label': 'Snapshots' },
    h('div.psb-head', icon('layers', 13), h('b', `Snapshots — ${ad.title()}`), h('div.spacer'), close),
    h('div.sn-slots', slotBtns),
    h('div.sn-morphrow', fromSel, slider, toSel, pct), note);
  close.addEventListener('click', () => done());
  function render() {
    slotBtns.forEach((b, i) => { b.classList.toggle('filled', !!st.snaps[i]); b.title = st.snaps[i] ? `Recall ${SLOTS[i]} (Shift-click: overwrite, right-click: more)` : `Store the current settings in ${SLOTS[i]}`; });
    const ok = st.snaps[st.morph.from] && st.snaps[st.morph.to];
    slider.disabled = !ok;
    pct.textContent = `${Math.round(st.morph.t * 100)}%`;
    note.textContent = ok ? 'Numbers glide between the two snapshots; switches and menus flip at 50%.' : 'Click an empty slot to store the current settings, then pick two snapshots to morph between.';
  }
  const onOutside = (e) => { if (!el.contains(e.target) && !e.target.closest?.('.ctx-menu')) done(); };
  const onKey = (e) => { if (e.key === 'Escape') done(); };
  function done() { el.remove(); snapPop = null; document.removeEventListener('pointerdown', onOutside, true); document.removeEventListener('keydown', onKey, true); }
  document.body.appendChild(el);
  snapPop = el;
  const r = anchor?.getBoundingClientRect?.() || { left: 100, bottom: 100 };
  const W = Math.min(360, window.innerWidth - 16);
  el.style.width = W + 'px';
  el.style.left = Math.max(8, Math.min(window.innerWidth - W - 8, r.left)) + 'px';
  el.style.top = Math.max(8, Math.min(window.innerHeight - 160, r.bottom + 4)) + 'px';
  setTimeout(() => { document.addEventListener('pointerdown', onOutside, true); document.addEventListener('keydown', onKey, true); }, 0);
  render();
  return el;
}

/** Morph two snapshots of a device (instruments of different types switch at 50%). */
export function morphOf(ad, a, b, t) {
  if (ad.kind === 'instrument') {
    if (a.type !== b.type) return deepClone(t < 0.5 ? a : b);
    const ra = ad.resolved(a), rb = ad.resolved(b);
    const near = t < 0.5 ? ra : rb;
    return { type: a.type, preset: (t < 0.5 ? a : b).preset ?? null, params: { ...deepClone(near), ...morphParams(ra, rb, t, ad.defs()) } };
  }
  const ra = ad.resolved(a), rb = ad.resolved(b);
  const near = t < 0.5 ? a : b;
  const out = { ...deepClone(near), ...morphParams(ra, rb, t, ad.defs()) };
  return out;
}

// ------------------------------------------------------------------ randomize
function randomizeFx(app, ad, mode, tag) {
  const f = ad.get();
  if (!f) return;
  const defs = ad.defs();
  const cur = resolveEffectParams(f);
  const locks = deviceState(ad.devKey).locks;
  let out;
  if (mode === 'tag') out = randomizeWithinPresets(defs, cur, effectPresetEntries(f.type).filter((e) => !tag || e.tags.includes(tag)), { locks });
  else out = randomizeParams(defs, cur, { amount: mode === 'wild' ? 0.85 : 0.25, locks });
  ad.write({ ...(f.params || {}), ...out }, `Randomize ${EFFECT_DEFS[f.type]?.name || f.type}`);
  app.setStatus?.(`Randomized${locks.size ? ` (${locks.size} locked)` : ''} — Ctrl+Z to undo. Right-click a knob to lock it.`);
}

/** "Randomize within category": a point between two presets of the instrument's own category. */
export function randomizeInstrumentWithin(app, trackId, category) {
  const ad = insAdapter(app, trackId);
  const ins = ad.get();
  if (!ins) return;
  const pool = Object.values(PRESETS).filter((p) => p.instrument.type === ins.type && (!category || p.category === category)).map((p) => ({ params: p.instrument.params }));
  if (!pool.length) { app.toast?.('No presets of this engine in that category', { level: 'warn' }); return; }
  const cur = ad.resolved(ins);
  const out = randomizeWithinPresets(ad.defs(), cur, pool, { locks: deviceState(ad.devKey).locks, skip: INST_RANDOM_SKIP });
  ad.write({ ...ins, params: { ...(ins.params || {}), ...out } }, 'Randomize within category');
  app.setStatus?.('Randomized between presets of the category — Ctrl+Z to undo.');
}

// ------------------------------------------------------------------ saving
export async function saveFxPreset(app, ownerId, fxId) {
  const f = fxOwner(app.store.get(), ownerId)?.fx?.find((x) => x.id === fxId);
  if (!f) return;
  const name = await promptText(`Save ${EFFECT_DEFS[f.type]?.name || f.type} preset`, 'My preset');
  if (!name) return;
  const tagsIn = await promptText('Tags (optional, comma separated)', '', { placeholder: 'e.g. vocal, warm' });
  const params = deepClone(f.params || {});
  delete params.sourceTrackId; // routing is project-specific
  const id = presetStore().save('effect', { name, type: f.type, params, tags: String(tagsIn || '').split(',') });
  if (!id) { app.toast?.('Could not save preset (browser storage unavailable)', { level: 'error' }); return; }
  deviceState(fxDevKey(fxId)).presetKey = `fx:user:${id}`;
  app.toast?.(`Saved effect preset “${name}”`, { level: 'success' });
}
export async function saveFxChain(app, ownerId) {
  const o = fxOwner(app.store.get(), ownerId);
  const fx = chainFromFx(o?.fx || []);
  if (!fx.length) { app.toast?.('This channel has no effects to save', { level: 'warn' }); return; }
  const name = await promptText('Save FX chain', `${o.name || 'Master'} chain`);
  if (!name) return;
  for (const f of fx) delete f.params.sourceTrackId;
  const id = presetStore().save('chain', { name, fx });
  app.toast?.(id ? `Saved FX chain “${name}” (${fx.length} effects)` : 'Could not save the chain', { level: id ? 'success' : 'error' });
}
export async function saveTrackTemplate(app, trackId) {
  const t = app.store.get().tracks.find((x) => x.id === trackId);
  if (!t) return;
  const name = await promptText('Save track template', `${t.name} template`);
  if (!name) return;
  const track = templateFromTrack(t);
  for (const f of track.fx) delete f.params.sourceTrackId;
  const id = presetStore().save('template', { name, track });
  app.toast?.(id ? `Saved track template “${name}”` : 'Could not save the template', { level: id ? 'success' : 'error' });
}

// ------------------------------------------------------------------ effect card header controls
/**
 * Small preset / compare cluster for an effect card head: ‹ Presets › · A B · ⋯ (save, snapshots, randomize).
 * Returns { el, update(fx) }.
 */
export function fxPresetControls(app, { ownerId, fx, name }) {
  const ad = fxAdapter(app, ownerId, fx.id);
  const st = deviceState(ad.devKey);
  const items = () => presetItems('effect', { type: fx.type });
  const label = h('span.dv-fxp-name');
  const showName = () => { const it = items().find((x) => x.key === st.presetKey); label.textContent = it ? it.name : 'Presets'; };
  const step = (dir) => {
    const list = items();
    if (!list.length) return;
    const i = list.findIndex((x) => x.key === st.presetKey);
    const it = list[(i + dir + list.length) % list.length];
    applyFxPreset(app, ownerId, fx.id, it.preset);
    st.presetKey = it.key;
    showName();
  };
  const prev = h('button.dv-fxp-step', { type: 'button', title: 'Previous preset' }, '‹');
  const next = h('button.dv-fxp-step', { type: 'button', title: 'Next preset' }, '›');
  const browse = h('button.dv-fx-preset', { type: 'button', title: 'Browse presets: search, tags, favorites, user presets' }, label, ' ▾');
  prev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  browse.addEventListener('click', (e) => {
    e.stopPropagation();
    openPresetBrowser(app, { kind: 'effect', anchor: browse, ownerId, fxId: fx.id, type: fx.type, currentKey: st.presetKey, onCommit: (it) => { st.presetKey = it.key; showName(); } });
  });
  const ab = abControl(ad);
  const more = h('button.dv-fxp-more', { type: 'button', title: 'Preset tools: save, snapshots & morph, randomize' }, '⋯');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const f = ad.get();
    const tags = [...new Set(effectPresetEntries(fx.type).flatMap((x) => x.tags))];
    contextMenu(e, [
      { header: `${name} presets` },
      { label: 'Save as user preset…', icon: 'save', onClick: () => saveFxPreset(app, ownerId, fx.id) },
      { label: 'Snapshots & morph (A–H)…', icon: 'layers', onClick: () => openSnapshots(app, ad, more) },
      ...abMenu(ad, ab.refresh).slice(1),
      '-',
      { label: 'Randomize (subtle)', icon: 'dice', onClick: () => randomizeFx(app, ad, 'subtle') },
      { label: 'Randomize (wild)', icon: 'dice', onClick: () => randomizeFx(app, ad, 'wild') },
      { label: 'Randomize within preset tags', icon: 'dice', disabled: !effectPresetEntries(fx.type).length, submenu: [{ label: 'Any preset', onClick: () => randomizeFx(app, ad, 'tag', '') }, ...tags.map((t) => ({ label: t, onClick: () => randomizeFx(app, ad, 'tag', t) }))] },
      { label: `Clear randomize locks${st.locks.size ? ` (${st.locks.size})` : ''}`, disabled: !st.locks.size, onClick: () => { st.locks.clear(); markLocks(more.closest('.device-chain')); } },
      '-',
      { label: 'Reset to defaults', icon: 'undo', onClick: () => { ad.write(EFFECT_DEFS[f?.type]?.plugin ? { name: f.params?.name, code: f.params?.code, url: f.params?.url } : {}, `${name}: reset`); st.presetKey = null; showName(); } },
    ]);
  });
  showName();
  const has = items().length > 0;
  const el = h('span.dv-fxp', has ? prev : null, browse, has ? next : null, ab, more);
  el.addEventListener('dblclick', (e) => e.stopPropagation()); // don't fold the card
  return { el, update() { ab.refresh(); } };
}

// ------------------------------------------------------------------ instrument header controls
/** Browse button, A/B and snapshots for the instrument header. -> { els: [], update() } */
export function instrumentPresetControls(app, { trackId }) {
  const ad = insAdapter(app, trackId);
  const browse = h('button.btn.small.dv-browse', { type: 'button', title: 'Browse presets: search, categories, favorites, recent, user — selecting auditions' }, icon('search', 12), h('span', 'Browse'));
  browse.addEventListener('click', () => openPresetBrowser(app, { kind: 'instrument', anchor: browse, trackId }));
  const ab = abControl(ad);
  const snaps = h('button.btn.small.dv-snaps', { type: 'button', title: 'Snapshots A–H with morphing' }, icon('layers', 12));
  snaps.addEventListener('click', () => openSnapshots(app, ad, snaps));
  return { els: [browse, ab, snaps], update() { ab.refresh(); } };
}
