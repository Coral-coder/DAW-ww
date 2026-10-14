// Pocket (phone) layout vs desktop layout — pure decision logic + the remembered choice.
export const LAYOUT_KEY = 'daw3-layout'; // 'pocket' | 'desktop' | absent = automatic

/**
 * Should the Pocket shell be used? env: {search, stored, width, height, coarse}.
 * Order: URL (?mobile=1 / ?mobile=0, ?desktop=1) > remembered menu choice > automatic (small or touch screens:
 * width ≤ 820, or a coarse pointer with width ≤ 1024).
 */
export function detectPocket({ search = '', stored = null, width = 1280, coarse = false } = {}) {
  const q = new URLSearchParams(search);
  if (q.has('mobile')) return !/^(0|false|no|off)$/i.test(q.get('mobile'));
  if (q.has('pocket')) return !/^(0|false|no|off)$/i.test(q.get('pocket'));
  if (q.has('desktop')) return false;
  if (stored === 'pocket') return true;
  if (stored === 'desktop') return false;
  return width <= 820 || (!!coarse && width <= 1024);
}

/** Read the environment from a window-like object (safe when storage / matchMedia are unavailable). */
export function readEnv(win = globalThis) {
  let stored = null, coarse = false;
  try { stored = win.localStorage?.getItem(LAYOUT_KEY) ?? null; } catch { /* storage blocked */ }
  try { coarse = !!win.matchMedia?.('(pointer: coarse)').matches; } catch { /* */ }
  return { search: win.location?.search || '', stored, width: win.innerWidth || 1280, coarse };
}

/** Remember the user's choice ('pocket' | 'desktop' | null = automatic). */
export function setLayoutPref(v, win = globalThis) {
  try { if (v) win.localStorage.setItem(LAYOUT_KEY, v); else win.localStorage.removeItem(LAYOUT_KEY); } catch { /* */ }
}

/** Switch layouts: remember and reload without a ?mobile override that would win over the choice. */
export function switchLayout(v, win = globalThis) {
  setLayoutPref(v, win);
  const u = new URL(win.location.href);
  for (const k of ['mobile', 'pocket', 'desktop']) u.searchParams.delete(k);
  win.location.replace(u.href);
}
