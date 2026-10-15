// Loads the space / character effect processors (worklets/fx-processors.js) into an AudioContext or
// OfflineAudioContext, once per context.
//
// Some browsers stall on addModule() for good, and a stalled addModule blocks an OfflineAudioContext's rendering: an
// offline context therefore only gets the module once it is known to load — after a successful load on any context,
// or after a throwaway one-quantum OfflineAudioContext probe did. Every attempt is bounded by a timeout.
const MODULE_URL = new URL('./worklets/fx-processors.js', import.meta.url).href;
const TIMEOUT_MS = 8000;

const loads = new WeakMap(); // ctx -> Promise<boolean>
let works = false; // the module loaded on some context
let probe = null; // Promise<boolean> of the offline probe

const isOfflineCtx = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

export function fxWorkletsSupported(ctx) {
  return !!(ctx?.audioWorklet && typeof AudioWorkletNode === 'function' && !globalThis.DAW3_NO_FX_WORKLET);
}

function add(ctx) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS); });
  return Promise.race([ctx.audioWorklet.addModule(MODULE_URL).then(() => 'ok'), timeout])
    .then((r) => {
      clearTimeout(timer);
      if (r === 'ok') { works = true; return true; }
      console.warn('[fx] effect worklets did not load in time — using simplified fallbacks');
      return false;
    }, (e) => { clearTimeout(timer); console.warn('[fx] effect worklets unavailable:', e?.message || e); return false; });
}

/** Resolves true once the processors are registered on ctx (false: not available, effects use fallbacks). */
export function loadFxWorklet(ctx) {
  let p = loads.get(ctx);
  if (p) return p;
  if (!fxWorkletsSupported(ctx)) p = Promise.resolve(false);
  else if (isOfflineCtx(ctx) && !works) {
    probe ||= add(new OfflineAudioContext(1, 128, ctx.sampleRate));
    p = probe.then((ok) => (ok || works ? add(ctx) : false));
  } else p = add(ctx);
  loads.set(ctx, p);
  return p;
}
