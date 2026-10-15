// Loads the dynamics AudioWorklet module (dynamics-worklet.js) into a context, once per context.
// Resolves true when the processors are registered, false when AudioWorklets are unavailable or never load.
// Offline contexts (exports) only get the module when the live context loaded it (or no live load was tried): a
// pending addModule() that never settles would block OfflineAudioContext rendering for good.

const MODULE_URL = new URL('./dynamics-worklet.js', import.meta.url).href;
const TIMEOUT_MS = 8000;
const loads = new WeakMap(); // ctx -> Promise<boolean>
let lastLive = null;

const isOffline = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

function add(ctx) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { console.warn('[fx] dynamics worklet did not load in time'); resolve(false); }, TIMEOUT_MS); });
  const load = ctx.audioWorklet.addModule(MODULE_URL).then(() => true, (e) => { console.warn('[fx] dynamics worklet unavailable:', e?.message || e); return false; });
  return Promise.race([load, timeout]).finally(() => clearTimeout(timer));
}

/** @param {BaseAudioContext} ctx @returns {Promise<boolean>} */
export function loadDynamicsWorklet(ctx) {
  let p = loads.get(ctx);
  if (p) return p;
  if (!ctx?.audioWorklet || typeof AudioWorkletNode !== 'function') p = Promise.resolve(false);
  else if (isOffline(ctx) && lastLive) p = lastLive.then((ok) => (ok ? add(ctx) : false));
  else {
    p = add(ctx);
    if (!isOffline(ctx)) lastLive = p;
  }
  loads.set(ctx, p);
  return p;
}
