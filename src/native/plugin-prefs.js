// Native plugin manager preferences (stored by the audio server as plugin-prefs.json in the app's userData):
// favourites, hidden plugins and the blocklist (blocked bundles are never scanned or loaded), plus the Plugins
// dialog's search / sort / filter over installed and failed plugins. Pure, Node-testable.
import { FORMAT_LABELS } from './plugin-db.js';

export const PREFS_VERSION = 1;
export const emptyPrefs = () => ({ version: PREFS_VERSION, favorites: [], hidden: [], blocked: [] });

const str = (v, n = 2048) => (typeof v === 'string' ? v.slice(0, n) : '');
const uniq = (a) => [...new Set(a)];

/** Validate stored / incoming preferences (bad input -> empty). blocked: [{ format, path?, key?, name? }]. */
export function normalizePrefs(p) {
  if (!p || typeof p !== 'object') return emptyPrefs();
  const keys = (a) => uniq((Array.isArray(a) ? a : []).filter((k) => typeof k === 'string' && /^(clap|vst3|au):/.test(k)).map((k) => k.slice(0, 600))).slice(0, 5000);
  const blocked = [];
  const seen = new Set();
  for (const b of Array.isArray(p.blocked) ? p.blocked : []) {
    if (!b || typeof b !== 'object' || !['vst3', 'clap', 'au'].includes(b.format)) continue;
    const e = { format: b.format, path: str(b.path), key: str(b.key, 600), name: str(b.name, 256) };
    if (!e.path && !e.key) continue;
    if (e.format === 'au' && !e.key) continue; // every AU shares the registry "bundle": block by key
    const id = blockId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    blocked.push(e);
  }
  return { version: PREFS_VERSION, favorites: keys(p.favorites), hidden: keys(p.hidden), blocked: blocked.slice(0, 5000) };
}

/** Identity of a blocklist entry: the bundle (VST3 / CLAP: every plugin inside it) or the key (AU). */
export const blockId = (b) => (b.format === 'au' || !b.path ? `key|${b.key}` : `path|${b.format}|${b.path}`);

/** Is this bundle (format + path) blocked from scanning? */
export const isBundleBlocked = (prefs, format, path) => format !== 'au' && !!prefs?.blocked?.some((b) => b.format === format && b.path && b.path === path);

/** Is this plugin (a DB desc) blocked from loading (its key, or the bundle it lives in)? */
export const isPluginBlocked = (prefs, d) => !!d && !!prefs?.blocked?.some((b) => (b.key && b.key === d.key) || (b.path && d.format !== 'au' && b.format === d.format && b.path === d.path));

/** Block entry for a plugin desc or a failed bundle ({ format, path, name? }). */
export function blockEntry(x) {
  if (x.format === 'au') return { format: 'au', key: x.key, path: '', name: x.name || x.key };
  return { format: x.format, path: x.path, key: x.key || '', name: x.name || String(x.path || '').split(/[\\/]/).pop() };
}

/** Immutable toggles (the dialog sends the result back with plugins.setPrefs). */
export function toggleKey(prefs, list, key, on) {
  const p = normalizePrefs(prefs);
  const has = p[list].includes(key);
  const want = on ?? !has;
  if (want && !has) p[list] = [...p[list], key];
  if (!want && has) p[list] = p[list].filter((k) => k !== key);
  return p;
}
export function setBlocked(prefs, entry, on = true) {
  const p = normalizePrefs(prefs);
  const id = blockId(entry);
  p.blocked = p.blocked.filter((b) => blockId(b) !== id);
  if (on) p.blocked.push(blockEntry(entry));
  return normalizePrefs(p);
}

export const SORTS = { name: 'Name', vendor: 'Vendor', format: 'Format', favorites: 'Favorites first' };

/**
 * Installed plugins for the manager list: search (name / vendor / format / category), format filter,
 * show: 'all' | 'favorites' | 'hidden' (hidden plugins appear only there), sort: SORTS key.
 */
export function filterNativePlugins(plugins, prefs, { query = '', format = '', show = 'all', sort = 'name' } = {}) {
  const fav = new Set(prefs?.favorites || []), hid = new Set(prefs?.hidden || []);
  const q = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = (p) => `${p.name} ${p.vendor} ${FORMAT_LABELS[p.format] || p.format} ${p.category} ${p.instrument ? 'instrument synth' : 'effect'} ${p.arch === 'x86_64' ? 'intel rosetta' : ''}`.toLowerCase();
  let out = (plugins || []).filter((p) => {
    if (format && p.format !== format) return false;
    if (show === 'favorites' && !fav.has(p.key)) return false;
    if (show === 'hidden' ? !hid.has(p.key) : hid.has(p.key)) return false;
    if (isPluginBlocked(prefs, p)) return false;
    const t = text(p);
    return q.every((w) => t.includes(w));
  });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.format.localeCompare(b.format);
  const cmp = {
    name: byName,
    vendor: (a, b) => (a.vendor || '￿').localeCompare(b.vendor || '￿', undefined, { sensitivity: 'base' }) || byName(a, b),
    format: (a, b) => a.format.localeCompare(b.format) || byName(a, b),
    favorites: (a, b) => (fav.has(b.key) - fav.has(a.key)) || byName(a, b),
  }[sort] || byName;
  out = out.slice().sort(cmp);
  return out;
}

/** Plugins the catalog / plugin browser should offer: no hidden or blocked ones, favourites first. */
export function catalogPlugins(plugins, prefs) {
  const fav = new Set(prefs?.favorites || []), hid = new Set(prefs?.hidden || []);
  return (plugins || []).filter((p) => !hid.has(p.key) && !isPluginBlocked(prefs, p))
    .map((p, i) => [p, i]).sort((a, b) => (fav.has(b[0].key) - fav.has(a[0].key)) || a[1] - b[1]).map(([p]) => p);
}
