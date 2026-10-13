// Reusable UI controls: knobs, sliders, toggles, selects, menus, modals, toasts,
// and auto-generated parameter panels driven by ParamDef metadata.
import { h, icon, startDrag, clear } from './dom.js';
import { clamp } from '../core/util.js';

// ---------- value mapping helpers ----------
function toNorm(def, v) {
  const { min = 0, max = 1, curve = 'lin' } = def;
  v = clamp(v, min, max);
  if (curve === 'log' && min > 0) return Math.log(v / min) / Math.log(max / min);
  if (curve === 'exp') return Math.sqrt((v - min) / (max - min));
  return (v - min) / (max - min || 1);
}
function fromNorm(def, n) {
  const { min = 0, max = 1, curve = 'lin', step } = def;
  n = clamp(n, 0, 1);
  let v;
  if (curve === 'log' && min > 0) v = min * Math.pow(max / min, n);
  else if (curve === 'exp') v = min + (max - min) * n * n;
  else v = min + (max - min) * n;
  if (step) v = Math.round(v / step) * step;
  return clamp(+v.toFixed(6), min, max);
}

export function formatValue(def, v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '–';
  if (def.type === 'enum') return (def.options || []).find((o) => o.value === v)?.label ?? String(v);
  if (def.type === 'bool') return v ? 'On' : 'Off';
  const unit = def.unit || '';
  const abs = Math.abs(v);
  let s;
  if (unit === 'Hz' && abs >= 1000) return (v / 1000).toFixed(abs >= 10000 ? 1 : 2) + ' kHz';
  if (unit === 's' && abs < 1) return Math.round(v * 1000) + ' ms';
  if (unit === '%') return Math.round(v * (def.max <= 1 ? 100 : 1)) + '%';
  if (def.step && def.step >= 1) s = String(Math.round(v));
  else if (abs >= 100) s = v.toFixed(0);
  else if (abs >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

// ---------- Knob ----------
/**
 * knob({def, value, onChange(v, {final}), size, label, color})
 * Drag vertically (shift = fine), wheel, double-click resets to default.
 */
export function knob({ def, value, onChange, size = 38, label, color, showValue = true }) {
  let v = value ?? def.default ?? def.min ?? 0;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 40 40');
  const track = document.createElementNS(svg.namespaceURI, 'path');
  const arc = document.createElementNS(svg.namespaceURI, 'path');
  const dot = document.createElementNS(svg.namespaceURI, 'line');
  track.setAttribute('class', 'knob-track');
  arc.setAttribute('class', 'knob-arc');
  dot.setAttribute('class', 'knob-dot');
  if (color) arc.style.stroke = color;
  svg.append(track, arc, dot);
  const valEl = h('div.knob-value');
  const el = h('div.knob', { title: def.description || def.label }, svg, label !== false ? h('div.knob-label', label || def.label) : null, showValue ? valEl : null);

  const A0 = -135, A1 = 135;
  const polar = (a, r = 15) => [20 + r * Math.sin((a * Math.PI) / 180), 20 - r * Math.cos((a * Math.PI) / 180)];
  const arcPath = (a, b) => {
    const [x0, y0] = polar(a), [x1, y1] = polar(b);
    const large = Math.abs(b - a) > 180 ? 1 : 0;
    return `M${x0} ${y0} A15 15 0 ${large} ${b > a ? 1 : 0} ${x1} ${y1}`;
  };
  track.setAttribute('d', arcPath(A0, A1));
  const bipolar = (def.min ?? 0) < 0 && (def.max ?? 1) > 0;

  function render() {
    const n = toNorm(def, v);
    const a = A0 + (A1 - A0) * n;
    const from = bipolar ? A0 + (A1 - A0) * toNorm(def, 0) : A0;
    arc.setAttribute('d', Math.abs(a - from) < 0.5 ? '' : arcPath(Math.min(from, a), Math.max(from, a)));
    const [x0, y0] = polar(a, 6), [x1, y1] = polar(a, 13);
    dot.setAttribute('x1', x0); dot.setAttribute('y1', y0); dot.setAttribute('x2', x1); dot.setAttribute('y2', y1);
    valEl.textContent = formatValue(def, v);
  }
  function set(nv, final = false) {
    nv = clamp(nv, def.min ?? 0, def.max ?? 1);
    if (nv === v && !final) return;
    v = nv;
    render();
    onChange && onChange(v, { final });
  }
  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const n0 = toNorm(def, v);
    el.classList.add('active');
    startDrag(e, (dx, dy, ev) => {
      const sens = ev.shiftKey ? 0.0015 : 0.006;
      set(fromNorm(def, n0 + (-dy + dx * 0.3) * sens));
    }, () => { el.classList.remove('active'); onChange && onChange(v, { final: true }); });
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(fromNorm(def, toNorm(def, v) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.03)), true);
  }, { passive: false });
  svg.addEventListener('dblclick', () => set(def.default ?? def.min ?? 0, true));
  render();
  el.setValue = (nv) => { v = nv ?? def.default; render(); };
  return el;
}

// ---------- Fader (vertical or horizontal slider) ----------
export function fader({ def, value, onChange, vertical = true, length = 120, color }) {
  let v = value ?? def.default ?? 0;
  const fill = h('div.fader-fill', { style: color ? { background: color } : {} });
  const thumb = h('div.fader-thumb');
  const el = h(`div.fader.${vertical ? 'vertical' : 'horizontal'}`, { style: vertical ? { height: length + 'px' } : { width: length + 'px' }, title: def.label }, fill, thumb);
  function render() {
    const n = toNorm(def, v) * 100;
    if (vertical) { fill.style.height = n + '%'; thumb.style.bottom = `calc(${n}% - 5px)`; }
    else { fill.style.width = n + '%'; thumb.style.left = `calc(${n}% - 5px)`; }
    el.title = `${def.label}: ${formatValue(def, v)}`;
  }
  function setFromEvent(e) {
    const r = el.getBoundingClientRect();
    const n = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    v = fromNorm(def, n);
    render();
    onChange && onChange(v, { final: false });
  }
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setFromEvent(e);
    startDrag(e, (_dx, _dy, ev) => setFromEvent(ev), () => onChange && onChange(v, { final: true }));
  });
  el.addEventListener('dblclick', () => { v = def.default ?? 0; render(); onChange && onChange(v, { final: true }); });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    v = fromNorm(def, toNorm(def, v) - Math.sign(e.deltaY) * 0.02);
    render();
    onChange && onChange(v, { final: true });
  }, { passive: false });
  render();
  el.setValue = (nv) => { v = nv; render(); };
  return el;
}

// ---------- Simple inputs ----------
export function toggle({ label, value, onChange, title, cls = '' }) {
  const el = h(`button.toggle${cls ? '.' + cls : ''}`, { title: title || label, type: 'button' }, label);
  const render = () => el.classList.toggle('on', !!value);
  el.addEventListener('click', () => { value = !value; render(); onChange && onChange(value); });
  render();
  el.setValue = (nv) => { value = nv; render(); };
  return el;
}

export function select({ options, value, onChange, title, cls = '' }) {
  const el = h(`select${cls ? '.' + cls : ''}`, { title });
  const groups = {};
  for (const o of options) {
    const opt = h('option', { value: String(o.value) }, o.label);
    if (o.group) {
      if (!groups[o.group]) { groups[o.group] = h('optgroup', { label: o.group }); el.appendChild(groups[o.group]); }
      groups[o.group].appendChild(opt);
    } else el.appendChild(opt);
  }
  el.value = String(value);
  el.addEventListener('change', () => {
    const o = options.find((x) => String(x.value) === el.value);
    onChange && onChange(o ? o.value : el.value);
  });
  el.setValue = (nv) => { el.value = String(nv); };
  return el;
}

/** Draggable number field (e.g. BPM). */
export function numberField({ value, min, max, step = 1, onChange, width = 56, format, title }) {
  const el = h('input.numfield', { type: 'text', value: format ? format(value) : value, title, style: { width: width + 'px' } });
  let v = value;
  const commit = (nv, final = true) => {
    nv = clamp(Math.round(nv / step) * step, min, max);
    nv = +nv.toFixed(4);
    v = nv;
    el.value = format ? format(v) : v;
    onChange && onChange(v, { final });
  };
  el.addEventListener('pointerdown', (e) => {
    if (document.activeElement === el) return;
    e.preventDefault();
    const v0 = v;
    let moved = false;
    startDrag(e, (dx, dy, ev) => {
      if (Math.abs(dy) > 2) moved = true;
      if (moved) commit(v0 - dy * step * (ev.shiftKey ? 0.1 : 1) * (step < 1 ? 1 : 0.5), false);
    }, () => { if (!moved) { el.focus(); el.select(); } else commit(v, true); });
  });
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { commit(parseFloat(el.value) || v); el.blur(); }
    if (e.key === 'Escape') { el.value = format ? format(v) : v; el.blur(); }
    if (e.key === 'ArrowUp') commit(v + step);
    if (e.key === 'ArrowDown') commit(v - step);
  });
  el.addEventListener('blur', () => { el.value = format ? format(v) : v; });
  el.setValue = (nv) => { v = nv; if (document.activeElement !== el) el.value = format ? format(v) : v; };
  return el;
}

export function button(label, onClick, { icon: ic, title, cls = '', primary = false } = {}) {
  const el = h(`button.btn${primary ? '.primary' : ''}${cls ? '.' + cls.split(' ').join('.') : ''}`, { type: 'button', title: title || (typeof label === 'string' ? label : '') }, ic ? icon(ic) : null, label ? h('span', label) : null);
  el.addEventListener('click', (e) => onClick && onClick(e));
  return el;
}

export function iconButton(ic, onClick, title, cls = '') {
  const el = h(`button.icon-btn${cls ? '.' + cls.split(' ').join('.') : ''}`, { type: 'button', title }, icon(ic));
  el.addEventListener('click', (e) => onClick && onClick(e));
  return el;
}

// ---------- Param panel (nested sections with Advanced disclosure) ----------
/**
 * paramPanel({defs: ParamDef[], values, onChange(key, value, {final}), color, compact})
 * Groups params by `section`; advanced params go into a nested "Advanced" <details>.
 */
export function paramPanel({ defs, values = {}, onChange, color, sectionsOpen = {}, onSectionToggle }) {
  const root = h('div.param-panel');
  const bySection = new Map();
  for (const d of defs) {
    const s = d.section || 'Main';
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(d);
  }
  const controls = {};
  const makeControl = (d) => {
    const val = values[d.key] ?? d.default;
    const cb = (v, meta = {}) => onChange && onChange(d.key, v, meta);
    let c;
    if (d.type === 'enum') {
      c = h('div.param-enum', h('label', d.label), select({ options: d.options || [], value: val, onChange: (v) => cb(v, { final: true }) }));
    } else if (d.type === 'bool') {
      c = h('div.param-bool', toggle({ label: d.label, value: !!val, onChange: (v) => cb(v, { final: true }) }));
    } else {
      c = knob({ def: d, value: val, onChange: cb, color });
    }
    controls[d.key] = c;
    return c;
  };
  for (const [section, list] of bySection) {
    const basic = list.filter((d) => !d.advanced);
    const adv = list.filter((d) => d.advanced);
    if (!basic.length && !adv.length) continue;
    const open = sectionsOpen[section] ?? true;
    const det = h('details.param-section', { open }, h('summary', section));
    det.addEventListener('toggle', () => onSectionToggle && onSectionToggle(section, det.open));
    const row = h('div.param-row', basic.map(makeControl));
    det.appendChild(row);
    if (adv.length) {
      const advDet = h('details.param-advanced', h('summary', `Advanced (${adv.length})`), h('div.param-row', adv.map(makeControl)));
      det.appendChild(advDet);
    }
    root.appendChild(det);
  }
  root.controls = controls;
  return root;
}

// ---------- Meter ----------
export function meter({ height = 120, stereo = true } = {}) {
  const canvas = h('canvas.meter', { width: stereo ? 10 : 5, height: 100, style: { height: height + 'px' } });
  let peakHold = [0, 0];
  canvas.setLevels = (l, r = l) => {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const lv = [l, r].slice(0, stereo ? 2 : 1);
    const bw = W / lv.length;
    lv.forEach((v, i) => {
      const db = v > 0 ? 20 * Math.log10(v) : -90;
      const n = clamp((db + 60) / 66, 0, 1);
      peakHold[i] = Math.max(peakHold[i] * 0.97, n);
      const grad = ctx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, '#2fd17a'); grad.addColorStop(0.75, '#d6e04a'); grad.addColorStop(0.92, '#ff4d4d');
      ctx.fillStyle = grad;
      ctx.fillRect(i * bw + 0.5, H - n * H, bw - 1, n * H);
      ctx.fillStyle = peakHold[i] > 0.92 ? '#ff4d4d' : '#ddd';
      ctx.fillRect(i * bw + 0.5, H - peakHold[i] * H, bw - 1, 1.5);
    });
  };
  return canvas;
}

// ---------- Overlays: modal, toast, context menu, prompt ----------
let overlayRoot;
function root() {
  if (!overlayRoot) { overlayRoot = h('div.overlay-root'); document.body.appendChild(overlayRoot); }
  return overlayRoot;
}

/** modal({title, body: Node, actions:[{label, primary, onClick -> false to keep open}], width, onClose}) */
export function modal({ title, body, actions = [], width = 520, onClose, cls = '' }) {
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const footer = h('div.modal-footer', actions.map((a) => button(a.label, async () => {
    const r = a.onClick ? await a.onClick() : undefined;
    if (r !== false) close();
  }, { primary: a.primary })));
  const box = h(`div.modal${cls ? '.' + cls : ''}`, { style: { width: `min(${width}px, calc(100vw - 32px))` } },
    h('div.modal-header', h('h2', title), iconButton('x', close, 'Close')),
    h('div.modal-body', body),
    actions.length ? footer : null);
  const backdrop = h('div.modal-backdrop', { onpointerdown: (e) => { if (e.target === backdrop) close(); } }, box);
  root().appendChild(backdrop);
  document.addEventListener('keydown', onKey, true);
  return { close, el: box };
}

export function toast(message, { level = 'info', timeout = 3200 } = {}) {
  let host = document.querySelector('.toast-host');
  if (!host) { host = h('div.toast-host'); document.body.appendChild(host); }
  const t = h(`div.toast.${level}`, message);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, timeout);
}

/** contextMenu(event, items:[{label, onClick, icon, disabled, shortcut, submenu:[...]}|'-']) */
export function contextMenu(ev, items) {
  ev.preventDefault?.();
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = buildMenu(items);
  root().appendChild(menu);
  const x = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
  const off = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); window.removeEventListener('pointerdown', off, true); }
  };
  setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
  menu.closeMenu = () => { menu.remove(); window.removeEventListener('pointerdown', off, true); };
  return menu;
}

function buildMenu(items) {
  const menu = h('div.ctx-menu');
  for (const it of items) {
    if (it === '-' || !it) { menu.appendChild(h('div.ctx-sep')); continue; }
    if (it.header) { menu.appendChild(h('div.ctx-header', it.header)); continue; }
    const row = h(`div.ctx-item${it.disabled ? '.disabled' : ''}`, it.icon ? icon(it.icon, 14) : h('span.icon-spacer'), h('span.ctx-label', it.label), it.shortcut ? h('span.ctx-shortcut', it.shortcut) : null, it.submenu ? icon('chevronRight', 12) : null);
    if (it.submenu) {
      const sub = buildMenu(it.submenu);
      sub.classList.add('submenu');
      row.appendChild(sub);
    } else if (!it.disabled) {
      row.addEventListener('click', () => { document.querySelectorAll('.ctx-menu').forEach((m) => m.remove()); it.onClick && it.onClick(); });
    }
    menu.appendChild(row);
  }
  return menu;
}

export function promptText(title, initial = '', { placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea.prompt-input', { rows: 8, placeholder }) : h('input.prompt-input', { type: 'text', placeholder });
    input.value = initial;
    let result = null;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !multiline) { result = input.value; m.close(); }
    });
    const m = modal({
      title, body: input, width: 420,
      actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    setTimeout(() => { input.focus(); input.select?.(); }, 20);
  });
}

export function confirmDialog(title, text) {
  return new Promise((resolve) => {
    let ok = false;
    modal({ title, body: h('p', text), width: 400, actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { ok = true; } }], onClose: () => resolve(ok) });
  });
}

/** Tabs: tabs([{id,label,icon,render:()=>Node}], activeId, onChange) */
export function tabs(items, active, onChange) {
  const bar = h('div.tabs');
  const body = h('div.tab-body');
  const show = (id) => {
    active = id;
    bar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
    clear(body);
    const it = items.find((i) => i.id === id) || items[0];
    if (it) body.appendChild(it.render());
    onChange && onChange(id);
  };
  for (const it of items) {
    const t = h('button.tab', { type: 'button', dataset: { id: it.id } }, it.icon ? icon(it.icon, 14) : null, h('span', it.label));
    t.addEventListener('click', () => show(it.id));
    bar.appendChild(t);
  }
  const el = h('div.tabs-wrap', bar, body);
  show(active || items[0]?.id);
  el.show = show;
  return el;
}

export function fileInput(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    inp.addEventListener('change', () => { resolve([...inp.files]); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}
