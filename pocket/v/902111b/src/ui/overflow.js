// Priority+ overflow for toolbars: when a row is wider than its box, the items marked `data-prio` (higher number =
// hidden first) are hidden one by one until it fits, and a "⋯" button shows them in a popover (the real elements are
// moved there while it is open, so their listeners / state keep working). Used by the top transport and the device
// panel header row. Pure layout logic in fitPlan() (Node-testable).

import { h, icon } from './dom.js';

/**
 * Which items to hide so the row fits: items [{ prio, width }] (prio > 0 = hideable), the row's natural width and
 * the available width (moreWidth = the "⋯" button, needed as soon as anything is hidden).
 * Returns the indices to hide (highest prio first; equal prio: the later item first).
 */
export function fitPlan(items, natural, avail, moreWidth = 32) {
  if (natural <= avail + 0.5) return [];
  const order = items.map((it, i) => ({ ...it, i })).filter((x) => x.prio > 0).sort((a, b) => b.prio - a.prio || b.i - a.i);
  const out = [];
  let w = natural + moreWidth;
  for (const x of order) {
    if (w <= avail + 0.5) break;
    out.push(x.i);
    w -= x.width;
  }
  return out;
}

/**
 * Attach priority+ overflow to `row` (a flex row). The "⋯" button is appended (or placed in `moreHost`).
 * Returns { update, more, destroy }.
 */
export function priorityOverflow(row, { title = 'More controls', moreHost = null, gap = 0 } = {}) {
  const more = h('button.icon-btn.ovf-more.hidden', { type: 'button', title, 'aria-haspopup': 'true' }, icon('more'));
  (moreHost || row).appendChild(more);
  let pop = null;
  const holders = new Map(); // el -> placeholder comment while in the popover
  const items = () => [...row.querySelectorAll('[data-prio]')].filter((e) => !e.closest('.ovf-pop'));

  function closePop() {
    if (!pop) return;
    for (const [el, ph] of holders) { ph.replaceWith(el); }
    holders.clear();
    pop.remove(); pop = null;
    document.removeEventListener('pointerdown', onDoc, true);
    update();
  }
  const onDoc = (e) => { if (pop && !pop.contains(e.target) && !more.contains(e.target) && !e.target.closest?.('.ctx-menu, .modal-backdrop, select')) closePop(); };
  function openPop() {
    if (pop) { closePop(); return; }
    const hidden = items().filter((e) => e.classList.contains('ovf-hidden'));
    if (!hidden.length) return;
    pop = h('div.ovf-pop', { role: 'dialog', 'aria-label': title });
    for (const el of hidden) {
      const ph = document.createComment('ovf');
      el.replaceWith(ph);
      holders.set(el, ph);
      el.classList.remove('ovf-hidden');
      pop.appendChild(el);
    }
    document.body.appendChild(pop);
    const r = more.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)))}px`;
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true));
  }
  more.addEventListener('click', openPop);

  let busy = false;
  function update() {
    if (busy || pop) return;
    busy = true;
    try {
      const its = items();
      for (const e of its) e.classList.remove('ovf-hidden');
      more.classList.add('hidden');
      const avail = row.clientWidth;
      const natural = row.scrollWidth;
      if (natural > avail + 0.5) {
        const cs = getComputedStyle(row);
        const g = gap || parseFloat(cs.columnGap) || 0;
        const plan = fitPlan(its.map((e) => ({ prio: Number(e.dataset.prio) || 0, width: e.getBoundingClientRect().width + g })), natural, avail, moreHost ? 0 : 34);
        for (const i of plan) its[i].classList.add('ovf-hidden');
        if (plan.length) more.classList.remove('hidden');
        // estimates can be off by a few px (gaps, rounding, a group border): hide more until it really fits
        const rest = fitPlan(its.map((e) => ({ prio: Number(e.dataset.prio) || 0, width: 0 })), Infinity, 0).filter((i) => !plan.includes(i));
        while (row.scrollWidth > row.clientWidth && rest.length) { its[rest.shift()].classList.add('ovf-hidden'); more.classList.remove('hidden'); }
      }
    } finally { busy = false; mo?.takeRecords(); }
  }
  let mo = null;
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  if (ro) { ro.observe(row); for (const c of row.children) ro.observe(c); }
  // children appearing / disappearing (e.g. the orange ↺, a new group) change the natural width
  mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => { if (ro) for (const c of row.children) ro.observe(c); schedule(); }) : null;
  mo?.observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  schedule();
  return { update, more, close: closePop, destroy() { ro?.disconnect(); mo?.disconnect(); closePop(); more.remove(); } };
}
