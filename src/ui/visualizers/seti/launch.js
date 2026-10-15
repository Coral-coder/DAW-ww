// SETI Scope launcher: preferences, the idle screensaver watcher and a lazy openSetiScope() that requests
// fullscreen inside the user's gesture before the (bigger) scope module loads. Node-safe at import time.

const PREFS_KEY = 'daw3-seti-scope';
export const DEFAULT_PREFS = { screensaver: false, idleMinutes: 5, crt: true, retro: false, camera: 'orbit' };

export function loadSetiPrefs() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) || '{}');
    return { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch { return { ...DEFAULT_PREFS }; }
}
export function saveSetiPrefs(patch) {
  const next = { ...loadSetiPrefs(), ...patch };
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  return next;
}

/** Screensaver rule: enabled, playing, scope not already open, page visible and idle for idleMinutes. */
export function shouldStartScreensaver({ enabled, idleMinutes, idleMs, playing, open, hidden }) {
  return !!enabled && !!playing && !open && !hidden && idleMs >= Math.max(0.25, Number(idleMinutes) || 5) * 60000;
}

let host = null; // the overlay element while the scope is open
let scope = null; // its controller once loaded
let opening = null;

/**
 * Open the scope. opts: { screensaver: true } = opened by the idle watcher (no fullscreen request, any input
 * closes), { source: 'master' | trackId }. Safe to call repeatedly (focuses the open one).
 */
export function openSetiScope(app, opts = {}) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  if (host) return opening || Promise.resolve(scope);
  host = document.createElement('div');
  host.className = 'seti-host';
  host.tabIndex = -1;
  host.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#000;';
  document.body.appendChild(host);
  let fs = null;
  if (!opts.screensaver) fs = requestFs(host); // must start inside the click / key event
  const h = host;
  opening = import('./scope.js').then((m) => {
    if (host !== h) return null; // closed while loading
    scope = m.mountSetiScope(h, app, { ...opts, fsRequest: fs, onClose: () => { if (host === h) { host = null; scope = null; } } });
    opening = null;
    return scope;
  }).catch((e) => {
    console.error('[seti]', e);
    try { h.remove(); } catch { /* */ }
    host = null; opening = null;
    app?.toast?.(`SETI Scope failed to load: ${e.message}`, { level: 'error' });
    return null;
  });
  return opening;
}
export function closeSetiScope() {
  if (scope) scope.close();
  else if (host) { host.remove(); host = null; opening = null; }
}
export const isSetiScopeOpen = () => !!host;
export const toggleSetiScope = (app, opts) => (host ? closeSetiScope() : openSetiScope(app, opts));

/** Fullscreen request (prefixed for older Safari); resolves false when refused / unsupported. */
export function requestFs(el) {
  try {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return Promise.resolve(false);
    const r = fn.call(el, { navigationUI: 'hide' });
    return r && r.then ? r.then(() => true, () => false) : Promise.resolve(true);
  } catch { return Promise.resolve(false); }
}

/** Idle watcher for the screensaver mode (desktop and Pocket). Returns an uninstall function. */
export function installSetiScope(app) {
  if (typeof window === 'undefined') return () => {};
  app.openSetiScope = (opts) => openSetiScope(app, opts);
  let last = performance.now();
  const bump = () => { last = performance.now(); };
  const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  for (const e of evs) window.addEventListener(e, bump, { capture: true, passive: true });
  const timer = setInterval(() => {
    const p = loadSetiPrefs();
    if (!p.screensaver) return;
    if (shouldStartScreensaver({ enabled: true, idleMinutes: p.idleMinutes, idleMs: performance.now() - last, playing: app.engine?.isPlaying, open: !!host, hidden: document.hidden })) {
      openSetiScope(app, { screensaver: true });
    }
  }, 5000);
  return () => { clearInterval(timer); for (const e of evs) window.removeEventListener(e, bump, { capture: true }); };
}
