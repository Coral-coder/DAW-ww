// User presets, FX chains, track templates, favorites and recently-used presets (Node-safe; persisted in
// localStorage when available, else in memory), plus the .daw3preset / .daw3bank JSON exchange format.
//
// Kinds and their stored entries ({ id: entry }):
//   instrument  { name, type, preset, params, tags?, created }           (key 'daw3-user-presets' — the original store)
//   effect      { name, type, params, tags?, description?, created }
//   chain       { name, fx: [{ type, enabled, params }], tags?, created }
//   template    { name, track: { type, name, color, volume, pan, instrument, fx, sends, role, macros? }, tags?, created }
// Preset keys (favorites / recents): 'inst:<presetId>', 'inst:user:<id>', 'fx:<type>:<name>', 'fx:user:<id>',
// 'chain:<id>', 'tpl:<id>'.
import { EFFECT_DEFS } from '../audio/effect-defs.js';
import { INSTRUMENT_DEFS } from '../audio/defs.js';

export const PRESET_KINDS = ['instrument', 'effect', 'chain', 'template'];
export const STORE_KEYS = {
  instrument: 'daw3-user-presets', effect: 'daw3-user-fx-presets', chain: 'daw3-fx-chains', template: 'daw3-track-templates',
  favorites: 'daw3-preset-favs', recent: 'daw3-preset-recent',
};
export const BANK_FORMAT = 'daw3-preset-bank';
export const BANK_VERSION = 1;
export const PRESET_FILE_EXT = '.daw3preset';
export const BANK_FILE_EXT = '.daw3bank';
const RECENT_MAX = 30;
const IMPORT_MAX_ENTRIES = 5000;

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
let idSeq = 0;
const newId = (kind) => `${kind[0]}${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** localStorage-backed storage when available, else an in-memory map. */
export function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const k = '__daw3_probe__';
      localStorage.setItem(k, '1'); localStorage.removeItem(k);
      return { get: (key) => localStorage.getItem(key), set: (key, v) => localStorage.setItem(key, v) };
    }
  } catch { /* fall through */ }
  return memoryStorage();
}
export function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); }, dump: () => Object.fromEntries(m) };
}

// ------------------------------------------------------------------ validation / sanitizing
function cleanTags(t) { return Array.isArray(t) ? [...new Set(t.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase().slice(0, 32)))].slice(0, 16) : []; }
const cleanName = (n, fb) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 120) : fb);

function cleanFx(f) {
  if (!isObj(f) || typeof f.type !== 'string' || !EFFECT_DEFS[f.type]) return null;
  return { type: f.type, enabled: f.enabled !== false, params: isObj(f.params) ? clone(f.params) : {} };
}
/** Sanitized entry of a kind (null when unusable). */
export function sanitizeEntry(kind, e) {
  if (!isObj(e)) return null;
  const base = { name: cleanName(e.name, 'Untitled'), tags: cleanTags(e.tags), created: typeof e.created === 'string' ? e.created : new Date().toISOString() };
  if (typeof e.description === 'string' && e.description) base.description = e.description.slice(0, 500);
  if (kind === 'instrument') {
    if (typeof e.type !== 'string' || !INSTRUMENT_DEFS[e.type]) return null;
    return { ...base, type: e.type, preset: typeof e.preset === 'string' ? e.preset : null, params: isObj(e.params) ? clone(e.params) : {} };
  }
  if (kind === 'effect') {
    if (typeof e.type !== 'string' || !EFFECT_DEFS[e.type]) return null;
    return { ...base, type: e.type, params: isObj(e.params) ? clone(e.params) : {} };
  }
  if (kind === 'chain') {
    const fx = (Array.isArray(e.fx) ? e.fx : []).map(cleanFx).filter(Boolean);
    return fx.length ? { ...base, fx } : null;
  }
  if (kind === 'template') {
    const t = e.track;
    if (!isObj(t) || !['instrument', 'audio', 'code'].includes(t.type || 'instrument')) return null;
    const track = {
      type: t.type || 'instrument',
      name: cleanName(t.name, base.name),
      color: typeof t.color === 'string' ? t.color : null,
      volume: Number.isFinite(t.volume) ? Math.min(1.5, Math.max(0, t.volume)) : 0.8,
      pan: Number.isFinite(t.pan) ? Math.min(1, Math.max(-1, t.pan)) : 0,
      role: typeof t.role === 'string' ? t.role : null,
      fx: (Array.isArray(t.fx) ? t.fx : []).map(cleanFx).filter(Boolean),
      sends: isObj(t.sends) ? Object.fromEntries(Object.entries(t.sends).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.min(1, Math.max(0, v))])) : {},
    };
    if (track.type === 'instrument') {
      const ins = t.instrument;
      if (!isObj(ins) || typeof ins.type !== 'string' || !INSTRUMENT_DEFS[ins.type]) return null;
      track.instrument = { type: ins.type, preset: typeof ins.preset === 'string' ? ins.preset : null, params: isObj(ins.params) ? clone(ins.params) : {} };
    }
    if (track.type === 'code' && typeof t.code === 'string') track.code = t.code;
    if (t.macros !== undefined) track.macros = clone(t.macros);
    return { ...base, track };
  }
  return null;
}

// ------------------------------------------------------------------ bank format
/** Build a bank object from entry lists: { instruments, effects, chains, templates } (arrays of entries). */
export function makeBank(parts = {}, meta = {}) {
  const pick = (kind, list) => (list || []).map((e) => sanitizeEntry(kind, e)).filter(Boolean).map(({ id, ...rest }) => rest);
  return {
    format: BANK_FORMAT, version: BANK_VERSION,
    name: cleanName(meta.name, 'daW³ presets'), created: new Date().toISOString(), app: 'daW³',
    instruments: pick('instrument', parts.instruments), effects: pick('effect', parts.effects),
    chains: pick('chain', parts.chains), templates: pick('template', parts.templates),
  };
}
const BANK_LISTS = { instrument: 'instruments', effect: 'effects', chain: 'chains', template: 'templates' };
export const serializeBank = (bank) => JSON.stringify(bank, null, 1);

/**
 * Parse a .daw3preset / .daw3bank (or a plain JSON) text into a sanitized bank. Accepts a single bare preset
 * ({kind, ...entry}) too. Throws Error with a readable message for anything else.
 */
export function parseBank(text) {
  let o;
  try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('Not a preset file (invalid JSON)'); }
  if (!isObj(o)) throw new Error('Not a preset file');
  if (o.format !== BANK_FORMAT) {
    // single preset without the wrapper: { kind: 'effect', type, params, ... }
    if (typeof o.kind === 'string' && BANK_LISTS[o.kind]) return makeBank({ [BANK_LISTS[o.kind]]: [o] }, { name: o.name });
    throw new Error('Not a daW³ preset bank');
  }
  if (Number(o.version) > BANK_VERSION) throw new Error(`Preset bank version ${o.version} is newer than this app supports`);
  const count = Object.values(BANK_LISTS).reduce((s, k) => s + (Array.isArray(o[k]) ? o[k].length : 0), 0);
  if (count > IMPORT_MAX_ENTRIES) throw new Error(`Too many presets in one bank (${count})`);
  return makeBank({ instruments: o.instruments, effects: o.effects, chains: o.chains, templates: o.templates }, { name: o.name });
}

// ------------------------------------------------------------------ store
export function createPresetStore(storage = defaultStorage()) {
  const listeners = new Set();
  const read = (key, fb) => { try { const v = storage.get(key); return v == null ? fb : JSON.parse(v) ?? fb; } catch { return fb; } };
  const write = (key, v) => { try { storage.set(key, JSON.stringify(v)); return true; } catch { return false; } };
  const emit = (what) => { for (const fn of [...listeners]) { try { fn(what); } catch { /* listener errors never break the store */ } } };
  const all = (kind) => { const o = read(STORE_KEYS[kind], {}); return isObj(o) ? o : {}; };

  const api = {
    /** [{ id, ...entry }] of a kind, sorted by name. */
    list(kind) {
      return Object.entries(all(kind)).filter(([, e]) => isObj(e)).map(([id, e]) => ({ id, ...e })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
    get(kind, id) { const e = all(kind)[id]; return isObj(e) ? { id, ...e } : null; },
    /** Save (create or overwrite when id is given) -> id, or null when the entry is invalid / storage failed. */
    save(kind, entry, id = null) {
      const clean = sanitizeEntry(kind, entry);
      if (!clean) return null;
      const o = all(kind);
      const key = id || newId(kind);
      o[key] = clean;
      if (!write(STORE_KEYS[kind], o)) return null;
      emit(kind);
      return key;
    },
    remove(kind, id) {
      const o = all(kind);
      if (!(id in o)) return false;
      delete o[id];
      write(STORE_KEYS[kind], o);
      api.forget(keyOf(kind, id));
      emit(kind);
      return true;
    },
    rename(kind, id, name) {
      const o = all(kind);
      if (!o[id]) return false;
      o[id].name = cleanName(name, o[id].name);
      write(STORE_KEYS[kind], o);
      emit(kind);
      return true;
    },
    // ---- favorites
    favorites() { const f = read(STORE_KEYS.favorites, []); return Array.isArray(f) ? f : []; },
    isFavorite(key) { return api.favorites().includes(key); },
    toggleFavorite(key, on) {
      const f = api.favorites();
      const has = f.includes(key);
      const want = on ?? !has;
      if (want === has) return want;
      write(STORE_KEYS.favorites, want ? [...f, key] : f.filter((k) => k !== key));
      emit('favorites');
      return want;
    },
    // ---- recently used (most recent first)
    recent() { const r = read(STORE_KEYS.recent, []); return Array.isArray(r) ? r : []; },
    touch(key) {
      if (!key) return;
      write(STORE_KEYS.recent, [key, ...api.recent().filter((k) => k !== key)].slice(0, RECENT_MAX));
      emit('recent');
    },
    forget(key) {
      const f = api.favorites();
      if (f.includes(key)) write(STORE_KEYS.favorites, f.filter((k) => k !== key));
      const r = api.recent();
      if (r.includes(key)) write(STORE_KEYS.recent, r.filter((k) => k !== key));
    },
    // ---- banks
    /** Bank of the given user entries: sel = { instrument: [ids] | true, effect: …, chain: …, template: … } (default: everything). */
    exportBank(sel = null, meta = {}) {
      const pick = (kind) => {
        const s = sel ? sel[kind] : true;
        if (!s) return [];
        const list = api.list(kind);
        return s === true ? list : list.filter((e) => s.includes(e.id));
      };
      return makeBank({ instruments: pick('instrument'), effects: pick('effect'), chains: pick('chain'), templates: pick('template') }, meta);
    },
    /**
     * Import a bank (object or text). Identical entries (same kind, name and content) are skipped; a different entry
     * with an existing name gets a " (2)" suffix. -> { added: {kind: n}, skipped, ids: {kind: [ids]} }
     */
    importBank(bankOrText) {
      const bank = parseBank(bankOrText);
      const res = { added: { instrument: 0, effect: 0, chain: 0, template: 0 }, skipped: 0, ids: { instrument: [], effect: [], chain: [], template: [] } };
      for (const kind of PRESET_KINDS) {
        const o = all(kind);
        const sig = (e) => JSON.stringify({ ...e, created: undefined, tags: undefined, description: undefined, name: undefined });
        const existing = Object.values(o).filter(isObj);
        for (const e of bank[BANK_LISTS[kind]] || []) {
          if (existing.some((x) => x.name === e.name && sig(x) === sig(e))) { res.skipped++; continue; }
          let name = e.name, n = 2;
          while (existing.some((x) => x.name === name)) name = `${e.name} (${n++})`;
          const id = newId(kind);
          o[id] = { ...e, name };
          existing.push(o[id]);
          res.added[kind]++;
          res.ids[kind].push(id);
        }
        if (res.added[kind]) write(STORE_KEYS[kind], o);
      }
      emit('import');
      return res;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}

/** Favorite / recent key of a stored user entry. */
export function keyOf(kind, id) {
  return kind === 'instrument' ? `inst:user:${id}` : kind === 'effect' ? `fx:user:${id}` : kind === 'chain' ? `chain:${id}` : `tpl:${id}`;
}

/** File name for an exported bank / single preset. */
export function bankFileName(name, single = false) {
  const base = String(name || 'presets').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'presets';
  return base + (single ? PRESET_FILE_EXT : BANK_FILE_EXT);
}

let shared = null;
/** App-wide store (browser: localStorage). */
export function presetStore() { return shared || (shared = createPresetStore()); }
