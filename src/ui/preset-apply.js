// Applying presets, FX chains and track templates to the project (shared by the device panel, the preset browser,
// the Browser panel, drag & drop and Pocket). Effect / chain / template data comes from src/core/preset-store.js
// (user) and src/audio/effect-presets.js (factory).
import { createEffect, createTrack, createPattern, beatsPerBar, TRACK_COLORS } from '../core/model.js';
import { deepClone } from '../core/util.js';
import { EFFECT_DEFS } from '../audio/effect-defs.js';
import { PRESETS } from '../audio/presets.js';
import { DRUM_KITS } from '../audio/kits.js';
import { effectPresetEntries } from '../audio/effect-presets.js';
import { presetStore, makeBank, serializeBank, parseBank, bankFileName } from '../core/preset-store.js';

/** Drag & drop type for presets / chains / templates: JSON { kind: 'inst'|'inst-user'|'fx'|'fx-user'|'chain'|'tpl', … }. */
export const DT_PRESET_REF = 'application/x-daw3-presetref';

/** The fx owner (track / bus / master) of a project by id. */
export function fxOwner(p, ownerId) {
  if (ownerId === 'master') return p.master;
  return p.tracks.find((t) => t.id === ownerId) || p.buses.find((b) => b.id === ownerId) || null;
}
const ownerName = (p, ownerId) => (ownerId === 'master' ? 'Master' : fxOwner(p, ownerId)?.name || '');

// ------------------------------------------------------------------ keys
export const instKey = (id) => `inst:${id}`;
export const fxKey = (type, name) => `fx:${type}:${name}`;

// ------------------------------------------------------------------ resolving refs
/** { type, name, params, tags, description } of an effect preset ref ({ kind:'fx', type, name } | { kind:'fx-user', id }). */
export function resolveFxRef(ref) {
  if (ref?.kind === 'fx-user') {
    const u = presetStore().get('effect', ref.id);
    return u ? { type: u.type, name: u.name, params: u.params || {}, tags: u.tags || [], key: `fx:user:${ref.id}` } : null;
  }
  if (ref?.kind === 'fx') {
    const e = effectPresetEntries(ref.type).find((x) => x.name === ref.name);
    return e ? { ...e, key: fxKey(ref.type, ref.name) } : null;
  }
  return null;
}

// ------------------------------------------------------------------ instruments
/** Load a factory (ref.kind 'inst') or user (ref.kind 'inst-user') instrument preset on a track. */
export function applyInstrumentRef(app, trackId, ref, opts = {}) {
  const store = app.store;
  const t = store.get().tracks.find((x) => x.id === trackId);
  if (!t || t.type !== 'instrument') return false;
  if (ref.kind === 'inst-user') {
    const u = presetStore().get('instrument', ref.id);
    if (!u) return false;
    store.transact(opts.label || `Preset: ${u.name}`, (p) => {
      const tt = p.tracks.find((x) => x.id === trackId);
      if (tt) tt.instrument = { type: u.type, preset: u.preset ?? null, params: deepClone(u.params || {}) };
    }, opts.coalesce ? { coalesce: true } : undefined);
    if (!opts.preview) presetStore().touch(`inst:user:${ref.id}`);
    return true;
  }
  const id = ref.id;
  if (DRUM_KITS[id] && !PRESETS[id]) {
    store.transact(opts.label || `Kit: ${DRUM_KITS[id].name}`, (p) => {
      const tt = p.tracks.find((x) => x.id === trackId);
      if (!tt) return;
      const pads = tt.instrument?.type === 'drums' ? tt.instrument.params?.pads : null;
      tt.instrument = { type: 'drums', preset: id, params: { kit: id, ...(pads ? { pads } : {}) } };
    }, opts.coalesce ? { coalesce: true } : undefined);
    return true;
  }
  const pr = PRESETS[id];
  if (!pr) return false;
  store.transact(opts.label || `Preset: ${pr.name}`, (p) => {
    const tt = p.tracks.find((x) => x.id === trackId);
    if (!tt) return;
    const keepSample = tt.instrument?.type === 'sampler' && pr.instrument.type === 'sampler' ? tt.instrument.params?.sampleId : null;
    tt.instrument = { type: pr.instrument.type, preset: id, params: keepSample ? { sampleId: keepSample } : {} };
    if (!tt.role && pr.roles?.[0]) tt.role = pr.roles[0];
  }, opts.coalesce ? { coalesce: true } : undefined);
  if (!opts.preview) presetStore().touch(instKey(id));
  return true;
}

// ------------------------------------------------------------------ effects
/** Replace an existing effect's params with a preset (merged over defaults: unlisted params reset). */
export function applyFxPreset(app, ownerId, fxId, preset, opts = {}) {
  app.store.transact(opts.label || `${EFFECT_DEFS[preset.type]?.name || preset.type}: ${preset.name}`, (p) => {
    const f = fxOwner(p, ownerId)?.fx?.find((x) => x.id === fxId);
    if (!f) return;
    // keep routing (sidechain key) and plugin source fields
    const keep = {};
    for (const k of ['sourceTrackId', 'name', 'code', 'url', 'state']) if (f.params?.[k] !== undefined && preset.params[k] === undefined) keep[k] = f.params[k];
    f.params = { ...keep, ...deepClone(preset.params) };
  }, opts.coalesce ? { coalesce: true } : undefined);
  if (!opts.preview && preset.key) presetStore().touch(preset.key);
}

/** Add a new effect (optionally from a preset) to an owner's chain; returns the new effect. */
export function addFxToOwner(app, ownerId, type, params = {}, index = null, opts = {}) {
  if (!EFFECT_DEFS[type]) return null;
  const fx = createEffect(type, deepClone(params));
  app.store.transact(opts.label || `Add ${EFFECT_DEFS[type].name}`, (p) => {
    const o = fxOwner(p, ownerId);
    if (!o) return;
    o.fx = o.fx || [];
    if (index == null) o.fx.push(fx); else o.fx.splice(index, 0, fx);
  });
  if (opts.key) presetStore().touch(opts.key);
  return fx;
}

// ------------------------------------------------------------------ chains & templates
/** A storable chain from fx objects (ids dropped). */
export const chainFromFx = (fx = []) => fx.filter((f) => EFFECT_DEFS[f.type]).map((f) => ({ type: f.type, enabled: f.enabled !== false, params: deepClone(f.params || {}) }));

/** Insert a chain's effects (new ids) into an owner: mode 'append' (default) or 'replace'. Returns the new effects. */
export function insertChain(app, ownerId, chain, opts = {}) {
  const fx = (chain.fx || []).filter((f) => EFFECT_DEFS[f.type]).map((f) => ({ ...createEffect(f.type, deepClone(f.params || {})), enabled: f.enabled !== false }));
  if (!fx.length) return [];
  app.store.transact(opts.label || `${opts.mode === 'replace' ? 'Load' : 'Insert'} FX chain: ${chain.name || 'chain'}`, (p) => {
    const o = fxOwner(p, ownerId);
    if (!o) return;
    if (opts.mode === 'replace') o.fx = fx; else if (opts.index == null) o.fx = [...(o.fx || []), ...fx]; else o.fx.splice(opts.index, 0, ...fx);
  });
  if (opts.key) presetStore().touch(opts.key);
  return fx;
}

/** Track template data (instrument + fx chain + mixer settings + macros if the track has them). */
export function templateFromTrack(t) {
  const track = {
    type: t.type, name: t.name, color: t.color, volume: t.volume, pan: t.pan, role: t.role || null,
    fx: chainFromFx(t.fx), sends: deepClone(t.sends || {}),
  };
  if (t.type === 'instrument') track.instrument = deepClone(t.instrument);
  if (t.type === 'code') track.code = t.code;
  if (t.macros !== undefined) track.macros = deepClone(t.macros);
  return track;
}

/** New track from a template (one undo step). Sends to buses missing in this project are dropped. */
export function createTrackFromTemplate(app, tpl, opts = {}) {
  const p = app.store.get();
  const src = tpl.track || tpl;
  const fx = (src.fx || []).filter((f) => EFFECT_DEFS[f.type]).map((f) => ({ ...createEffect(f.type, deepClone(f.params || {})), enabled: f.enabled !== false }));
  const busIds = new Set(p.buses.map((b) => b.id));
  const track = createTrack({
    type: src.type || 'instrument', name: opts.name || src.name || tpl.name || 'Track',
    color: src.color || TRACK_COLORS[p.tracks.length % TRACK_COLORS.length],
    volume: src.volume, pan: src.pan, role: src.role || null, fx,
    sends: Object.fromEntries(Object.entries(src.sends || {}).filter(([k]) => busIds.has(k))),
    instrument: src.instrument ? deepClone(src.instrument) : undefined,
  });
  if (src.type === 'code' && typeof src.code === 'string') track.code = src.code;
  if (src.macros !== undefined) track.macros = deepClone(src.macros);
  let pattern = null;
  if (track.type === 'instrument') {
    pattern = createPattern(track.id, { name: `${track.name} 1`, length: beatsPerBar(p) * (track.role === 'drums' ? 1 : 2) });
    track.activePatternId = pattern.id;
  }
  app.store.transact(`Add ${track.name} (template)`, (pp) => {
    pp.tracks.push(track);
    if (pattern) {
      pp.patterns[pattern.id] = pattern;
      if (pp.scenes?.[0]) pp.scenes[0].slots[track.id] = pattern.id;
    }
  });
  app.ui.set({ selectedTrackId: track.id, selectedPatternId: pattern?.id || null });
  if (opts.key) presetStore().touch(opts.key);
  return track;
}

/** Apply a template's instrument, chain and mixer settings onto an existing track (keeps its notes / clips). */
export function applyTemplateToTrack(app, trackId, tpl) {
  const src = tpl.track || tpl;
  const p = app.store.get();
  const busIds = new Set(p.buses.map((b) => b.id));
  app.store.transact(`Template: ${tpl.name || src.name}`, (pp) => {
    const t = pp.tracks.find((x) => x.id === trackId);
    if (!t) return;
    if (t.type === 'instrument' && src.instrument) t.instrument = deepClone(src.instrument);
    t.fx = (src.fx || []).filter((f) => EFFECT_DEFS[f.type]).map((f) => ({ ...createEffect(f.type, deepClone(f.params || {})), enabled: f.enabled !== false }));
    if (t.patch) t.patch = { ...t.patch, enabled: false }; // plugboard wiring referenced the old effects
    if (Number.isFinite(src.volume)) t.volume = src.volume;
    if (Number.isFinite(src.pan)) t.pan = src.pan;
    t.sends = Object.fromEntries(Object.entries(src.sends || {}).filter(([k]) => busIds.has(k)));
    if (src.macros !== undefined) t.macros = deepClone(src.macros);
  });
}

// ------------------------------------------------------------------ drag & drop
export function encodeRef(ref) { return JSON.stringify(ref); }
export function decodeRef(dt) {
  try { const s = dt?.getData?.(DT_PRESET_REF); return s ? JSON.parse(s) : null; } catch { return null; }
}
export const hasRef = (dt) => [...(dt?.types || [])].includes(DT_PRESET_REF);

/**
 * Apply a dropped preset ref. target = { trackId } (a track lane / header), { ownerId, index } (device chain) or {}
 * (empty area: instrument presets / templates create a new track, effects go to the selected track).
 */
export function dropRef(app, ref, target = {}) {
  if (!ref) return false;
  const p = app.store.get();
  const store = presetStore();
  const trackId = target.trackId || null;
  const ownerId = target.ownerId || trackId || app.ui.get('selectedTrackId');
  const toast = (m, level = 'success') => app.toast?.(m, { level });
  if (ref.kind === 'inst' || ref.kind === 'inst-user') {
    const t = trackId && p.tracks.find((x) => x.id === trackId);
    if (t?.type === 'instrument') return applyInstrumentRef(app, t.id, ref);
    if (ref.kind === 'inst') { app.actions.addTrack(ref.id); return true; }
    const u = store.get('instrument', ref.id);
    if (!u) return false;
    createTrackFromTemplate(app, { name: u.name, track: { type: 'instrument', name: u.name, instrument: { type: u.type, preset: u.preset, params: u.params } } }, { key: `inst:user:${ref.id}` });
    return true;
  }
  if (ref.kind === 'tpl') {
    const tpl = store.get('template', ref.id);
    if (!tpl) return false;
    if (trackId && target.apply) { applyTemplateToTrack(app, trackId, tpl); return true; }
    createTrackFromTemplate(app, tpl, { key: `tpl:${ref.id}` });
    toast(`Added "${tpl.name}" from template`);
    return true;
  }
  if (!ownerId || !fxOwner(p, ownerId)) { toast('Select a track first', 'warn'); return false; }
  if (ref.kind === 'fx' || ref.kind === 'fx-user') {
    const pr = resolveFxRef(ref);
    if (!pr) return false;
    addFxToOwner(app, ownerId, pr.type, pr.params, target.index ?? null, { label: `Add ${EFFECT_DEFS[pr.type]?.name}: ${pr.name}`, key: pr.key });
    toast(`${EFFECT_DEFS[pr.type]?.name}: ${pr.name} → ${ownerName(p, ownerId)}`);
    return true;
  }
  if (ref.kind === 'chain') {
    const ch = store.get('chain', ref.id);
    if (!ch) return false;
    insertChain(app, ownerId, ch, { index: target.index ?? null, key: `chain:${ref.id}` });
    toast(`FX chain "${ch.name}" → ${ownerName(p, ownerId)}`);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ files
/** Download user entries as a bank (.daw3bank) or one entry as .daw3preset. */
export async function exportPresets(parts, name, single = false) {
  const bank = makeBank(parts, { name });
  const { downloadBlob } = await import('../io/project-file.js');
  return downloadBlob(new Blob([serializeBank(bank)], { type: 'application/json' }), bankFileName(name, single));
}

/** Import .daw3preset / .daw3bank files into the user store; returns a summary string. */
export async function importPresetFiles(files) {
  const store = presetStore();
  const tot = { instrument: 0, effect: 0, chain: 0, template: 0 };
  let skipped = 0;
  const errors = [];
  for (const f of files) {
    try {
      const text = await f.text();
      parseBank(text); // readable error before touching the store
      const r = store.importBank(text);
      for (const k of Object.keys(tot)) tot[k] += r.added[k];
      skipped += r.skipped;
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  const parts = [];
  if (tot.instrument) parts.push(`${tot.instrument} instrument preset${tot.instrument > 1 ? 's' : ''}`);
  if (tot.effect) parts.push(`${tot.effect} effect preset${tot.effect > 1 ? 's' : ''}`);
  if (tot.chain) parts.push(`${tot.chain} FX chain${tot.chain > 1 ? 's' : ''}`);
  if (tot.template) parts.push(`${tot.template} track template${tot.template > 1 ? 's' : ''}`);
  return { ok: !errors.length, added: tot, skipped, errors, message: parts.length ? `Imported ${parts.join(', ')}${skipped ? ` (${skipped} already there)` : ''}` : errors.length ? errors.join('; ') : `Nothing new to import${skipped ? ` (${skipped} already there)` : ''}` };
}
/** Describe a favorite / recent key: { ref, name, kind: 'instrument'|'effect'|'chain'|'template' } or null. */
export function describeKey(key) {
  const store = presetStore();
  let m;
  if ((m = /^inst:user:(.+)$/.exec(key))) { const u = store.get('instrument', m[1]); return u ? { kind: 'instrument', name: u.name, ref: { kind: 'inst-user', id: m[1] } } : null; }
  if ((m = /^inst:(.+)$/.exec(key))) { const n = PRESETS[m[1]]?.name || DRUM_KITS[m[1]]?.name; return n ? { kind: 'instrument', name: n, ref: { kind: 'inst', id: m[1] } } : null; }
  if ((m = /^fx:user:(.+)$/.exec(key))) { const u = store.get('effect', m[1]); return u ? { kind: 'effect', name: `${EFFECT_DEFS[u.type]?.name || u.type}: ${u.name}`, ref: { kind: 'fx-user', id: m[1] } } : null; }
  if ((m = /^fx:([^:]+):(.+)$/.exec(key))) { return EFFECT_DEFS[m[1]] && effectPresetEntries(m[1]).some((e) => e.name === m[2]) ? { kind: 'effect', name: `${EFFECT_DEFS[m[1]].name}: ${m[2]}`, ref: { kind: 'fx', type: m[1], name: m[2] } } : null; }
  if ((m = /^chain:(.+)$/.exec(key))) { const c = store.get('chain', m[1]); return c ? { kind: 'chain', name: c.name, ref: { kind: 'chain', id: m[1] } } : null; }
  if ((m = /^tpl:(.+)$/.exec(key))) { const t = store.get('template', m[1]); return t ? { kind: 'template', name: t.name, ref: { kind: 'tpl', id: m[1] } } : null; }
  return null;
}

export const PRESET_FILE_ACCEPT = '.daw3preset,.daw3bank,.json,application/json';
export const isPresetFile = (f) => /\.daw3(preset|bank)$/i.test(f?.name || '');
