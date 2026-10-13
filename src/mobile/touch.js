// Pocket touch kit: bottom sheets (pull down to close), action sheets, haptics, long-press, press-and-hold repeat.
import { h, icon } from '../ui/dom.js';

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported (iOS Safari ignores it) */ }
}

const sheetStack = [];
/** Close the top-most sheet (back gesture / Escape). Returns true when one was open. */
export function closeTopSheet() { const s = sheetStack[sheetStack.length - 1]; if (s) { s.close(); return true; } return false; }

/**
 * Bottom sheet. {title, body (Node|Node[]), actions?: Node, onClose, cls, tall}. Drag the handle / header down
 * (or tap the backdrop) to close. Returns {el, body, close, setTitle}.
 */
export function openSheet({ title = '', body = null, onClose = null, cls = '', tall = false, actions = null } = {}) {
  const titleEl = h('div.pk-sheet-title', title);
  const closeBtn = h('button.pk-sheet-x', { type: 'button', 'aria-label': 'Close' }, icon('x', 20));
  const grab = h('div.pk-sheet-grab', h('span'));
  const head = h('div.pk-sheet-head', titleEl, closeBtn);
  const bodyEl = h('div.pk-sheet-body');
  if (body) bodyEl.append(...[].concat(body).filter(Boolean));
  const panel = h(`div.pk-sheet${tall ? '.tall' : ''}${cls ? '.' + cls : ''}`, grab, head, bodyEl, actions ? h('div.pk-sheet-actions', actions) : null);
  const back = h('div.pk-sheet-back', panel);
  let closed = false;
  const api = {
    el: panel, body: bodyEl, back,
    setTitle(t) { titleEl.textContent = t; },
    close() {
      if (closed) return;
      closed = true;
      const i = sheetStack.indexOf(api);
      if (i >= 0) sheetStack.splice(i, 1);
      back.classList.add('closing');
      panel.style.transform = 'translateY(100%)';
      setTimeout(() => back.remove(), 220);
      onClose?.();
    },
  };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) { e.preventDefault(); api.close(); } });
  closeBtn.addEventListener('click', () => api.close());
  // pull down to close
  for (const zone of [grab, head]) {
    zone.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const y0 = e.clientY, t0 = performance.now();
      let dy = 0;
      zone.setPointerCapture?.(e.pointerId);
      panel.style.transition = 'none';
      const move = (ev) => { dy = Math.max(0, ev.clientY - y0); panel.style.transform = `translateY(${dy}px)`; };
      const up = () => {
        zone.removeEventListener('pointermove', move);
        zone.removeEventListener('pointerup', up);
        zone.removeEventListener('pointercancel', up);
        panel.style.transition = '';
        const fast = dy / Math.max(1, performance.now() - t0) > 0.5;
        if (dy > 90 || (fast && dy > 30)) api.close(); else panel.style.transform = '';
      };
      zone.addEventListener('pointermove', move);
      zone.addEventListener('pointerup', up);
      zone.addEventListener('pointercancel', up);
    });
  }
  document.body.appendChild(back);
  sheetStack.push(api);
  requestAnimationFrame(() => back.classList.add('open'));
  return api;
}

/**
 * Action sheet (the phone version of a context menu). Items: {label, icon, danger, disabled, checked, onClick,
 * submenu: items[]} | {header} | '-'. Accepts the desktop contextMenu item format as-is.
 */
export function actionSheet(title, items) {
  const list = h('div.pk-actions');
  let sheet;
  for (const it of items || []) {
    if (!it || it === '-') { if (list.lastChild && !list.lastChild.classList.contains('pk-act-sep')) list.appendChild(h('div.pk-act-sep')); continue; }
    if (it.header) { list.appendChild(h('div.pk-act-head', it.header)); continue; }
    const b = h(`button.pk-act${it.danger || /delete|remove|clear/i.test(it.label) ? '.danger' : ''}${it.checked ? '.checked' : ''}`, { type: 'button', disabled: !!it.disabled },
      it.icon ? icon(it.icon, 18) : h('span.pk-act-ic'), h('span.pk-act-label', it.label), it.submenu ? icon('chevronRight', 16) : it.checked ? h('span.pk-act-check', '✓') : null);
    b.addEventListener('click', () => {
      haptic(6);
      if (it.submenu) { actionSheet(it.label, it.submenu); return; }
      sheet.close();
      it.onClick?.();
    });
    list.appendChild(b);
  }
  sheet = openSheet({ title, body: list, cls: 'pk-action-sheet' });
  return sheet;
}

/** Long-press (≈0.5 s without moving) -> fn(e). Returns a cancel function for the pending press. */
export function onLongPress(el, fn, { ms = 480, slop = 10 } = {}) {
  let timer = 0, x0 = 0, y0 = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  el.addEventListener('pointerdown', (e) => {
    fired = false;
    x0 = e.clientX; y0 = e.clientY;
    cancel();
    timer = setTimeout(() => { timer = 0; fired = true; haptic(15); fn(e); }, ms);
  });
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > slop) cancel(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // a click right after a long-press is swallowed
  el.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
  return cancel;
}

/** Press-and-hold repeat: fn(n) immediately, then repeatedly with delays from delayOf(n). */
export function holdRepeat(btn, fn, delayOf) {
  let timer = 0, n = 0;
  const stop = () => { clearTimeout(timer); timer = 0; };
  const tick = () => { fn(n); timer = setTimeout(tick, delayOf(++n)); };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); stop(); n = 0; haptic(5); fn(n); timer = setTimeout(tick, delayOf(++n)); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(t, stop);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** A big touch button. */
export function bigButton(label, onClick, { ic = null, cls = '', title = '' } = {}) {
  const b = h(`button.pk-btn${cls ? '.' + cls.split(' ').join('.') : ''}`, { type: 'button', title }, ic ? icon(ic, 20) : null, label ? h('span', label) : null);
  b.addEventListener('click', (e) => { haptic(5); onClick?.(e); });
  return b;
}

/** Segmented chips: [{value,label}] -> el with .setValue(v). */
export function chips(options, value, onChange, { cls = '' } = {}) {
  const el = h(`div.pk-chips${cls ? '.' + cls : ''}`);
  const render = () => {
    el.replaceChildren(...options.map((o) => {
      const b = h(`button.pk-chip${o.value === value ? '.on' : ''}`, { type: 'button', title: o.title || '' }, o.label);
      b.addEventListener('click', () => { haptic(5); value = o.value; render(); onChange?.(o.value); });
      return b;
    }));
  };
  render();
  el.setValue = (v) => { value = v; render(); };
  return el;
}

/** Text prompt as a sheet (iOS-friendly). Resolves the text or null. */
export function promptSheet(title, initial = '', { placeholder = '', inputmode = 'text' } = {}) {
  return new Promise((resolve) => {
    const input = h('input.pk-input', { type: 'text', value: initial, placeholder, inputmode, enterkeyhint: 'done' });
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); sheet.close(); };
    const ok = bigButton('OK', () => finish(input.value), { cls: 'primary' });
    const sheet = openSheet({ title, body: [input], actions: ok, onClose: () => { if (!done) { done = true; resolve(null); } } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

export function confirmSheet(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; resolve(v); sheet.close(); };
    const sheet = openSheet({ title, body: h('p.pk-p', text), actions: h('div.pk-row', bigButton('Cancel', () => fin(false)), bigButton(okLabel, () => fin(true), { cls: 'primary' })), onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}
