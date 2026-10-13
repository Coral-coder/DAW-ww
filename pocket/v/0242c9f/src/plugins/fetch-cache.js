// Fetch helpers for plugin resources: progress reporting + a persistent Cache Storage layer so
// reloading a project does not re-download soundfonts / Faust sources. Browser-only at call time.

import { rawGitHubUrl } from './github.js';

const CACHE_NAME = 'daw3-plugins-v1';
const memText = new Map(); // url -> Promise<string>

async function openCache() {
  try { return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; } catch { return null; }
}

async function readBody(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    try { onProgress(total ? Math.min(1, got / total) : null, got); } catch { /* */ }
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

/**
 * fetchText(url, {onProgress?(fraction|null, bytes), cache=true}) -> Promise<string>
 * Serves from memory, then Cache Storage, then the network (and stores the response).
 */
export function fetchText(url, { onProgress, cache = true } = {}) {
  if (cache && memText.has(url)) return memText.get(url);
  const p = (async () => {
    const store = cache ? await openCache() : null;
    if (store) {
      try {
        const hit = await store.match(url);
        if (hit) { onProgress?.(1, 0); return await hit.text(); }
      } catch { /* cache unavailable */ }
    }
    let res;
    try {
      res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    } catch (e) {
      // jsDelivr can be blocked on some networks: fall back to raw.githubusercontent.com (CORS-enabled)
      const raw = rawGitHubUrl(url);
      if (!raw || /HTTP 404/.test(e.message)) throw e;
      res = await fetch(raw, { mode: 'cors', credentials: 'omit' }).catch(() => null);
      if (!res || !res.ok) throw e;
    }
    const text = await readBody(res, onProgress);
    if (store) {
      try { await store.put(url, new Response(text, { headers: { 'content-type': res.headers.get('content-type') || 'text/plain' } })); } catch { /* quota */ }
    }
    return text;
  })();
  if (cache) {
    memText.set(url, p);
    p.catch(() => memText.delete(url));
  }
  return p;
}

/** Forget a URL everywhere (used by "Retry"). */
export async function forget(url) {
  memText.delete(url);
  const store = await openCache();
  try { await store?.delete(url); } catch { /* */ }
}

/** Drop the in-memory copy only (keeps Cache Storage) — frees RAM after decoding. */
export function releaseMemory(url) { memText.delete(url); }
