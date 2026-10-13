// Plugin load-status registry, shared by every AudioContext (live + offline renders) and the UI.
// Keys identify the *resource* (soundfont URL, Faust source hash, WAM URL), so the device panel
// can show loading / error state for a track's instrument without touching the audio graph.
// Node-safe (no DOM / Web Audio at import time).
import { hashString } from './github.js';
import { soundfontUrl } from './gm.js';

const entries = new Map(); // key -> { state:'idle'|'loading'|'ready'|'error', progress, message, error, info }
const listeners = new Set();

export function getStatus(key) { return entries.get(key) || { state: 'idle', progress: 0 }; }

export function setStatus(key, patch) {
  if (!key) return;
  const prev = entries.get(key) || { state: 'idle', progress: 0 };
  const next = { ...prev, ...patch };
  if (patch.state && patch.state !== 'error') next.error = patch.error ?? null;
  entries.set(key, next);
  for (const fn of [...listeners]) { try { fn(key, next, prev); } catch (e) { console.warn('[plugins] status listener', e); } }
}

export function clearStatus(key) { entries.delete(key); }

/** onStatus((key, status, prevStatus) => …) -> unsubscribe */
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Resolved soundfont file URL of instrument params. */
export function soundfontSourceUrl(params = {}) {
  return params.url || soundfontUrl(params.library, params.instrument, params.format);
}

/** Status key of a plugin instrument / effect def ({type, params}) — null for built-in types. */
export function pluginKey(def) {
  const p = def?.params || {};
  switch (def?.type) {
    case 'soundfont': return 'sf:' + soundfontSourceUrl(p) + (p.multisample ? `|ms:${p.multisample}|${(p.range || []).join(',')}` : '');
    case 'faust': return p.code ? 'faust:' + hashString(p.code) : (p.url ? 'faust-url:' + p.url : null);
    case 'wam': return p.url ? 'wam:' + p.url : null;
    default: return null;
  }
}

/** Turn fetch / compile failures into a short, friendly message. */
export function friendlyError(err, { url, kind } = {}) {
  const msg = String(err?.message || err || 'Unknown error');
  if (err?.friendly) return msg;
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return `Could not download ${url ? `“${shortUrl(url)}”` : 'the plugin'} — you may be offline, or the server blocks cross-origin requests (CORS). GitHub links are fetched through cdn.jsdelivr.net.`;
  }
  if (/HTTP 404/.test(msg)) return `Not found (404): ${url ? shortUrl(url) : 'the file'} — check the link, branch and file name.`;
  if (/HTTP 403|HTTP 429/.test(msg)) return `The CDN refused the request (${msg.match(/HTTP \d+/)[0]}). Try again in a minute.`;
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) {
    return `Could not load the JavaScript module ${url ? `“${shortUrl(url)}”` : ''} (network, CORS or a syntax error in the plugin).`;
  }
  if (kind === 'faust' && !/^Faust/.test(msg)) return `Faust compile error: ${msg}`;
  return msg;
}

export function shortUrl(url) {
  const s = String(url || '');
  return s.length > 72 ? s.slice(0, 30) + '…' + s.slice(-38) : s;
}

/** Error that already carries a user-facing message. */
export function userError(message) {
  const e = new Error(message);
  e.friendly = true;
  return e;
}
