// Home-screen install (PWA): offline service worker + iOS audio session.
// Published builds live in v/<sha>/ under a root page whose <base> points there; the service worker sits at the
// site root (scope = whole site) and learns the build folder from its own URL.

/** { version, base } from the document base URL relative to the page ('dev', './' when not in a versioned build). */
export function buildInfo(baseURI, pageURL) {
  const base = new URL(baseURI), page = new URL(pageURL);
  const dir = page.pathname.replace(/[^/]*$/, '');
  const rel = base.pathname.startsWith(dir) ? base.pathname.slice(dir.length) : '';
  const m = /^v\/([^/]+)\/$/.exec(rel);
  return m ? { version: m[1], base: rel } : { version: 'dev', base: './' };
}

/** Service worker URL at the page's directory (never resolved against <base>). */
export function workerURL(baseURI, pageURL) {
  const { version, base } = buildInfo(baseURI, pageURL);
  const u = new URL('sw.js', new URL(pageURL));
  u.searchParams.set('v', version);
  u.searchParams.set('base', base);
  return u.href;
}

export function installPWA() {
  // iOS: play through the ring/silent switch like a music app (Safari 16.4+)
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const url = workerURL(document.baseURI, location.href);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(url, { scope: new URL('./', location.href).pathname }).catch((e) => console.warn('[daw3] offline cache unavailable', e));
  });
}
