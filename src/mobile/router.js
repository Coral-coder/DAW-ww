// Pocket page router — pure logic: page list, hash routes, swipe decisions.
export const PAGES = [
  { id: 'home', label: 'Create', icon: 'sparkles' },
  { id: 'tracks', label: 'Tracks', icon: 'layers' },
  { id: 'notes', label: 'Notes', icon: 'piano' },
  { id: 'play', label: 'Play', icon: 'music' },
  { id: 'mix', label: 'Mix', icon: 'mixer' },
  { id: 'setlist', label: 'Setlist', icon: 'timeline' },
];
/** Sub-pages (not in the tab bar): reached from a page, "back" returns to their parent. */
export const SUBPAGES = { track: { parent: 'tracks', label: 'Track' } };

/** '#/notes' | '#/track/trk_1' -> {page, id}; unknown -> home. */
export function parseRoute(hash = '') {
  const parts = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const page = parts[0];
  if (SUBPAGES[page]) return parts[1] ? { page, id: parts[1] } : { page: SUBPAGES[page].parent };
  if (PAGES.some((p) => p.id === page)) return { page };
  return { page: 'home' };
}
export const routeHash = (r) => '#/' + [r.page, r.id].filter(Boolean).map(encodeURIComponent).join('/');

/** The tab a route belongs to (sub-pages highlight their parent). */
export const tabOf = (page) => SUBPAGES[page]?.parent || page;

/** Neighbouring tab page in direction dir (+1 / -1); null at the ends. */
export function neighbour(page, dir, pages = PAGES) {
  const i = pages.findIndex((p) => p.id === tabOf(page));
  const j = i + dir;
  return i < 0 || j < 0 || j >= pages.length ? null : pages[j].id;
}

/**
 * Horizontal swipe decision: +1 = next page (finger moved left), -1 = previous, 0 = none.
 * Needs a mostly horizontal move that is either long (≥ 28 % of the width) or a quick flick (≥ 0.45 px/ms, ≥ 40 px).
 */
export function swipeDecision({ dx = 0, dy = 0, dt = 1, width = 375 } = {}) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 40 || ax < ay * 1.6) return 0;
  const fast = ax / Math.max(1, dt) >= 0.45;
  if (ax >= width * 0.28 || fast) return dx < 0 ? 1 : -1;
  return 0;
}

/** Should a pointer gesture starting at this target be left to the control (not a page swipe)? */
export function isSwipeBlocked(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.dataset?.noswipe !== undefined || n.classList?.contains('mp-noswipe')) return true;
    const tag = n.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'CANVAS') return true;
  }
  return false;
}
