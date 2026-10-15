// Shared plumbing of the analyzer views (oscilloscope, vectorscope, spectrum, spectrogram, tuner): the visibility-aware
// animation loop, theme colours from CSS variables, the probe reader, small tool buttons and the pop-out window.
import { h, startDrag, icon } from '../dom.js';

// ------------------------------------------------------------------------------------------------ theme
const THEME_VARS = {
  bg: '--bg', bg2: '--bg-2', bg3: '--bg-3', line: '--line', line2: '--line-2', text: '--text', text2: '--text-2', text3: '--text-3',
  accent: '--accent', accent2: '--accent-2', accent3: '--accent-3', good: '--good', warn: '--warn', bad: '--bad', mono: '--mono',
};
const FALLBACK = {
  bg: '#0f1116', bg2: '#151821', bg3: '#1b1f2a', line: '#2a3040', line2: '#363d50', text: '#e6e9f2', text2: '#a7aec2', text3: '#6d7590',
  accent: '#7c5cff', accent2: '#00d4ff', accent3: '#ff4fa3', good: '#2fd17a', warn: '#ffb547', bad: '#ff4d5e', mono: 'ui-monospace, monospace',
};
const themeCache = new WeakMap();
/** Theme colours read from the CSS variables (re-read at most twice a second, so theme switches follow). */
export function readTheme(el) {
  const now = performance.now();
  const c = themeCache.get(el);
  if (c && now - c.t < 500) return c.th;
  const cs = getComputedStyle(el);
  const th = {};
  for (const [k, v] of Object.entries(THEME_VARS)) th[k] = cs.getPropertyValue(v).trim() || FALLBACK[k];
  th.font = (px, w = 400) => `${w} ${px}px ${th.mono}`;
  themeCache.set(el, { t: now, th });
  return th;
}

/** '#rgb' / '#rrggbb' / 'rgb(…)' + alpha -> 'rgba(…)'. */
export function alpha(color, a) {
  const c = String(color).trim();
  let r = 0, g = 0, b = 0;
  if (c[0] === '#') {
    const x = c.length === 4 ? c.slice(1).split('').map((d) => d + d).join('') : c.slice(1, 7);
    r = parseInt(x.slice(0, 2), 16); g = parseInt(x.slice(2, 4), 16); b = parseInt(x.slice(4, 6), 16);
  } else {
    const m = c.match(/[\d.]+/g);
    if (m) [r, g, b] = m.map(Number);
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Channel colours: L / R / M / S / compare. */
export const chColor = (th, ch) => ({ L: th.accent2, R: th.accent3, M: th.accent, S: th.warn, key: th.text3 }[ch] || th.accent);

// ------------------------------------------------------------------------------------------------ animation loop
/**
 * Runs fn(dt, now) at ~fps while `el` is on screen: paused while scrolled out of view (IntersectionObserver) or the
 * tab is hidden, stopped for good once el has been attached and then removed (cards are rebuilt without dispose).
 * Returns stop().
 */
export function animate(el, fn, fps = 40) {
  let raf = 0, last = 0, onScreen = true, wasConnected = false, waits = 0, stopped = false;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
    onScreen = es.some((e) => e.isIntersecting);
    if (onScreen) kick();
  }) : null;
  io?.observe(el);
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVis);
  const stop = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    io?.disconnect();
    document.removeEventListener('visibilitychange', onVis);
  };
  const tick = (now) => {
    raf = 0;
    if (stopped) return;
    if (!el.isConnected) {
      if (wasConnected || ++waits > 600) { stop(); return; }
      raf = requestAnimationFrame(tick); // not mounted yet
      return;
    }
    wasConnected = true;
    if (!onScreen || document.hidden) { last = 0; return; } // resumed by the observer / visibilitychange
    raf = requestAnimationFrame(tick);
    if (last && now - last < 1000 / fps - 3) return;
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 1 / fps;
    last = now;
    try { fn(dt, now); } catch (e) { console.warn('[scope]', e); stop(); }
  };
  function kick() { if (!raf && !stopped) raf = requestAnimationFrame(tick); }
  kick();
  return stop;
}

// ------------------------------------------------------------------------------------------------ probe reader
/**
 * Reads blocks from a probe (see src/audio/scope-tap.js). read(n, which) -> {l, r, sr, fresh} with l / r holding
 * at least the newest n samples at their end (fresh = samples that arrived since the previous read of that input),
 * or null without a probe.
 */
export class TapReader {
  constructor(getProbe) { this.getProbe = getProbe; this.bufs = {}; this.lastTime = {}; }
  get probe() { try { return this.getProbe() || null; } catch { return null; } }
  read(n, which = 'main') {
    const p = this.probe;
    if (!p) return null;
    const size = p.ensure(n);
    let b = this.bufs[which];
    if (!b || b.l.length !== size) b = this.bufs[which] = { l: new Float32Array(size), r: new Float32Array(size) };
    if (!p.read(b.l, b.r, which)) return null;
    const t = p.time;
    const lt = this.lastTime[which];
    this.lastTime[which] = t;
    const fresh = lt == null ? size : Math.max(0, Math.min(size, Math.round((t - lt) * p.sampleRate)));
    return { l: b.l, r: b.r, sr: p.sampleRate, fresh, size };
  }
}

// ------------------------------------------------------------------------------------------------ widgets
/** A small overlay tool button; toggle buttons keep an .on state (get / set via btn.on). */
export function toolButton(label, title, onClick, { toggle = false, on = false } = {}) {
  const b = h('button.an-tool', { type: 'button', title }, label);
  if (toggle) {
    Object.defineProperty(b, 'on', { get: () => b.classList.contains('on'), set: (v) => b.classList.toggle('on', !!v) });
    b.on = on;
  }
  b.addEventListener('click', (e) => { e.stopPropagation(); if (toggle) b.on = !b.on; onClick?.(toggle ? b.on : undefined, e); });
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

/** Message painted in the middle of an empty canvas. */
export function emptyMessage(ctx, w, hh, th, msg) {
  ctx.fillStyle = th.text3;
  ctx.font = th.font(11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, hh / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Text with a translucent backing box (readouts over busy traces). */
export function label(ctx, text, x, y, th, { align = 'left', color = th.text, size = 10, weight = 400, box = true } = {}) {
  ctx.font = th.font(size, weight);
  const w = ctx.measureText(text).width;
  const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  if (box) { ctx.fillStyle = alpha(th.bg, 0.72); ctx.fillRect(x0 - 3, y - size, w + 6, size + 4); }
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(text, x0, y);
}

// ------------------------------------------------------------------------------------------------ pop-out window
const openPops = new Map(); // key -> element
/**
 * A floating, draggable, resizable window holding a bigger analyzer view. build(host) mounts the view and returns
 * {el}. One window per key (a second click brings the existing one to the front).
 */
export function openPopout({ key, title, build, width = 640, height = 400 }) {
  const existing = openPops.get(key);
  if (existing?.isConnected) { existing.style.zIndex = String(nextZ()); return existing; }
  const close = () => { win.remove(); openPops.delete(key); };
  const head = h('div.an-pop-head', h('span.an-pop-title', title), h('button.an-pop-x', { type: 'button', title: 'Close', onClick: close }, icon('x', 13)));
  const body = h('div.an-pop-body');
  const n = openPops.size;
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const W = Math.min(width, vw - 24), H = Math.min(height, vh - 24);
  const win = h('div.an-pop', { style: { left: `${Math.max(8, Math.round((vw - W) / 2) + n * 24)}px`, top: `${Math.max(8, Math.round((vh - H) / 3) + n * 24)}px`, width: `${W}px`, height: `${H}px`, zIndex: String(nextZ()) } }, head, body);
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const x0 = win.offsetLeft, y0 = win.offsetTop;
    win.style.zIndex = String(nextZ());
    startDrag(e, (dx, dy) => {
      win.style.left = `${Math.max(0, Math.min((window.innerWidth || 1200) - 60, x0 + dx))}px`;
      win.style.top = `${Math.max(0, Math.min((window.innerHeight || 800) - 30, y0 + dy))}px`;
    });
  });
  win.addEventListener('pointerdown', () => { win.style.zIndex = String(nextZ()); });
  win.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(win);
  build(body);
  openPops.set(key, win);
  return win;
}
let zTop = 900;
const nextZ = () => ++zTop;
