// daW³ service worker: the app works offline once installed (Add to Home Screen).
// Build files (v/<sha>/…) never change -> cache-first; the root page -> network-first; sounds fetched from the sample
// CDNs are kept in a runtime cache so instruments you've played also work offline.
const params = new URL(self.location).searchParams;
const VERSION = params.get('v') || 'dev';
const BASE = params.get('base') || './';
// Cache names carry the scope: several builds (e.g. main at /daw3/ and a branch at /daw3/mobile/) can live on one
// origin, and each worker only cleans up its own old versions.
const SCOPE = new URL('./', self.location).pathname;
const APP_PREFIX = `daw3-app-${SCOPE}-`;
const APP_CACHE = APP_PREFIX + VERSION;
const SOUND_CACHE = 'daw3-sounds';
const SOUND_HOSTS = /(^|\.)(githubusercontent\.com|jsdelivr\.net|unpkg\.com|github\.io|strudel\.cc|cdnjs\.cloudflare\.com)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.add(new Request('./', { cache: 'reload' })).catch(() => {});
    try {
      const res = await fetch(new URL(BASE + 'precache.json', self.location), { cache: 'reload' });
      if (res.ok) {
        const list = await res.json();
        // one by one: a single missing file must not fail the install
        await Promise.allSettled(list.map((p) => cache.add(new URL(BASE + p, self.location).href)));
      }
    } catch { /* dev server: files are cached as they load */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(APP_PREFIX) && key !== APP_CACHE) await caches.delete(key); // only this scope's old versions
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(APP_CACHE).then((c) => c.put('./', res.clone())); return res; })
        .catch(async () => (await caches.match(req)) || (await caches.match('./')) || Response.error()));
      return;
    }
    const immutable = /\/v\/[^/]+\//.test(url.pathname);
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached && immutable) return cached; // other same-origin files: network first, cache when offline
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(APP_CACHE)).put(req, res.clone());
        return res;
      } catch { return cached || Response.error(); }
    })());
    return;
  }
  if (SOUND_HOSTS.test(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SOUND_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
  }
});
