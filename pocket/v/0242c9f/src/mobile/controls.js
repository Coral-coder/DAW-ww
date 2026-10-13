// Pocket controls: big drag tiles, vertical faders and the touch control popup ("buttons that pop up when I
// select a control"). Every control edits a *target*:
//   { def (ParamDef), label?, get() -> value, set(v, {final}), auto?: {owner, target}, lock?: {label, get(), set(on)}, color? }
// Targets for instrument / effect / mixer params are built by paramTarget / mixTarget from the same defs the
// desktop knobs use.
import { h, icon } from '../ui/dom.js';
import { formatValue, markAuto, touchStart, touchEnd } from '../ui/components.js';
import { toNorm, fromNorm, automationOwner } from '../core/automation.js';
import { resolveInstrumentDef } from '../audio/presets.js';
import { resolveEffectParams, EFFECT_DEFS } from '../audio/effect-defs.js';
import { nudge, presetsFor, parseTyped, scrubNorm, scrubFactor, repeatDelay, repeatSteps, quantize, defaultOf } from './param-logic.js';
import { openSheet, actionSheet, haptic, holdRepeat, bigButton, promptSheet } from './touch.js';

const fmt = (def, v) => (def.format ? def.format(v) : formatValue(def, v));
const normOf = (def, v) => (def.type === 'number' || !def.type ? toNorm(def, v) : 0);
const valOf = (def, n) => quantize(def, fromNorm(def, n));

// ------------------------------------------------------------------------------------------- targets
/** Instrument param of a track. */
export function instTarget(app, trackId, def) {
  const track = () => app.store.get().tracks.find((t) => t.id === trackId);
  return {
    def, label: def.label, auto: def.type === 'number' ? { owner: trackId, target: `inst:${def.key}` } : null,
    get: () => { const t = track(); return t?.instrument ? resolveInstrumentDef(t.instrument).params[def.key] : def.default; },
    set: (v) => app.store.transact(`${def.label}`, (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t?.instrument) return;
      t.instrument.params = t.instrument.params || {};
      t.instrument.params[def.key] = v;
    }, { coalesce: true }),
  };
}

/** Effect param on a track / bus / master (ownerId = track id | bus id | 'master'). */
export function fxTarget(app, ownerId, fxId, def) {
  const fx = () => automationOwner(app.store.get(), ownerId)?.fx?.find((f) => f.id === fxId);
  return {
    def, label: def.label, auto: def.type === 'number' ? { owner: ownerId, target: `fx:${fxId}:${def.key}` } : null,
    get: () => { const f = fx(); return f ? resolveEffectParams(f)[def.key] : def.default; },
    set: (v) => app.store.transact(`${EFFECT_DEFS[fx()?.type]?.name || 'Effect'}: ${def.label}`, (p) => {
      const f = automationOwner(p, ownerId)?.fx?.find((x) => x.id === fxId);
      if (f) { f.params = f.params || {}; f.params[def.key] = v; }
    }, { coalesce: true }),
  };
}

export const VOLUME_DEF = { key: 'volume', label: 'Volume', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, format: (v) => (v <= 0.0001 ? '−∞ dB' : `${(20 * Math.log10(v / 0.8)).toFixed(1)} dB`) };
export const PAN_DEF = { key: 'pan', label: 'Pan', type: 'number', min: -1, max: 1, step: 0.01, default: 0, format: (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) };
export const SEND_DEF = { key: 'send', label: 'Send', type: 'number', min: 0, max: 1, step: 0.01, default: 0, unit: '%' };

/** Mixer target: what = 'volume' | 'pan' | 'send:<busId>' on a track / bus / master. */
export function mixTarget(app, ownerId, what) {
  const p0 = app.store.get();
  const isSend = what.startsWith('send:');
  const busId = isSend ? what.slice(5) : null;
  const def = what === 'volume' ? VOLUME_DEF : what === 'pan' ? PAN_DEF : { ...SEND_DEF, label: `Send ${p0.buses.find((b) => b.id === busId)?.name || ''}`.trim() };
  const read = (o) => (!o ? def.default : isSend ? (o.sends?.[busId] ?? 0) : (o[what] ?? def.default));
  return {
    def, label: def.label, auto: { owner: ownerId, target: what },
    get: () => read(automationOwner(app.store.get(), ownerId)),
    set: (v) => app.store.transact(def.label, (p) => {
      const o = automationOwner(p, ownerId);
      if (!o) return;
      if (isSend) { o.sends = o.sends || {}; o.sends[busId] = v; } else o[what] = v;
    }, { coalesce: true }),
  };
}

/** Plain value target (tempo, setlist energy…). */
export function valueTarget(def, get, set, extra = {}) { return { def, label: def.label, get, set, ...extra }; }

// ------------------------------------------------------------------------------------------- automation touch
function autoEl(target) {
  if (!target.auto) return null;
  return markAuto(h('div'), target.auto.owner, target.auto.target);
}

// ------------------------------------------------------------------------------------------- popup
/** Open the touch popup for a target. */
export function openParamPopup(app, target, { onChange } = {}) {
  const { def } = target;
  const label = target.label || def.label || def.key;
  let v = target.get();
  const ae = autoEl(target);
  const set = (nv, final = false) => {
    if (def.type === 'number' || !def.type) nv = quantize(def, nv);
    if (nv === v && !final) return;
    v = nv;
    target.set(v, { final });
    render();
    onChange?.(v);
  };
  const valueEl = h('button.pk-pop-value', { type: 'button', title: 'Tap to type a value' });
  const fineEl = h('div.pk-pop-fine');
  const parts = [];

  if (def.type === 'enum' || def.type === 'bool') {
    const opts = presetsFor(def);
    const list = h('div.pk-pop-options');
    const renderOpts = () => list.replaceChildren(...opts.map((o) => {
      const b = h(`button.pk-opt${o.value === v ? '.on' : ''}`, { type: 'button' }, o.label);
      b.addEventListener('click', () => { haptic(6); set(o.value, true); renderOpts(); });
      return b;
    }));
    renderOpts();
    parts.push(valueEl, list);
  } else {
    const fill = h('div.pk-slider-fill');
    const thumb = h('div.pk-slider-thumb');
    const slider = h('div.pk-slider', { 'data-noswipe': '' }, fill, thumb);
    slider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      slider.setPointerCapture?.(e.pointerId);
      const rect = slider.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      let lastX = e.clientX, moved = false;
      let n = normOf(def, v);
      const x0 = e.clientX, t0 = performance.now();
      if (ae) touchStart(ae);
      slider.classList.add('active');
      const move = (ev) => {
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        n = scrubNorm(n, ev.clientX - lastX, rect.width, ev.clientY - cy);
        lastX = ev.clientX;
        const f = scrubFactor(ev.clientY - cy);
        fineEl.textContent = f < 0.99 ? `Fine ×${f >= 0.1 ? f.toFixed(2) : f.toFixed(3)} — slide back up for full speed` : 'Drag sideways · move your finger up / down away from the slider for fine control';
        fineEl.classList.toggle('on', f < 0.99);
        set(valOf(def, n));
      };
      const up = () => {
        slider.removeEventListener('pointermove', move);
        slider.removeEventListener('pointerup', up);
        slider.removeEventListener('pointercancel', up);
        slider.classList.remove('active');
        fineEl.classList.remove('on');
        // a quick tap jumps to the tapped spot
        if (!moved && performance.now() - t0 < 300) set(valOf(def, (x0 - rect.left) / rect.width), true);
        if (ae) touchEnd(ae);
      };
      slider.addEventListener('pointermove', move);
      slider.addEventListener('pointerup', up);
      slider.addEventListener('pointercancel', up);
    });
    const minus = h('button.pk-step', { type: 'button', 'aria-label': 'Decrease' }, icon('minus', 26));
    const plus = h('button.pk-step', { type: 'button', 'aria-label': 'Increase' }, icon('plus', 26));
    const stepper = (dir) => (n) => { let nv = v; for (let i = 0; i < repeatSteps(n); i++) nv = nudge(def, nv, dir); set(nv); };
    holdRepeat(minus, stepper(-1), repeatDelay);
    holdRepeat(plus, stepper(1), repeatDelay);
    const presets = h('div.pk-pop-presets', ...presetsFor(def).map((p) => {
      const b = h(`button.pk-preset${p.tag ? '.' + p.tag : ''}`, { type: 'button' }, p.label);
      b.addEventListener('click', () => { haptic(6); set(p.value, true); });
      return b;
    }));
    parts.push(h('div.pk-pop-row', minus, valueEl, plus), slider, fineEl, presets);
    parts.render = () => {
      const n = normOf(def, v);
      fill.style.width = `${n * 100}%`;
      thumb.style.left = `${n * 100}%`;
    };
    fineEl.textContent = 'Drag sideways · move your finger up / down away from the slider for fine control';
  }

  // footer toggles
  const foot = h('div.pk-pop-foot');
  foot.appendChild(bigButton('Reset', () => set(defaultOf(def), true), { ic: 'undo', title: `Back to the default (${fmt(def, defaultOf(def))})` }));
  if (target.auto) {
    const autoBtn = bigButton('', () => {
      const on = !app.ui.get('autoArm');
      app.ui.set({ autoArm: on });
      if (on && app.store.get().mode !== 'song') app.actions.setMode('song');
      app.toast(on ? 'Automation recording armed: press Play, then move this control — your moves are written into the song.' : 'Automation recording off');
      syncAuto();
    }, { ic: 'record', cls: 'pk-auto' });
    const syncAuto = () => { autoBtn.classList.toggle('on', !!app.ui.get('autoArm')); autoBtn.lastChild.textContent = app.ui.get('autoArm') ? 'Automate: ON' : 'Automate'; };
    autoBtn.append(h('span'));
    syncAuto();
    foot.appendChild(autoBtn);
  }
  if (target.lock) {
    const lockBtn = bigButton('', () => { target.lock.set(!target.lock.get()); syncLock(); }, { cls: 'pk-lock' });
    const syncLock = () => { const on = !!target.lock.get(); lockBtn.classList.toggle('on', on); lockBtn.lastChild.textContent = on ? `${target.lock.label || 'Lock'}: ON` : (target.lock.label || 'Lock'); };
    lockBtn.append(h('span'));
    syncLock();
    foot.appendChild(lockBtn);
  }
  parts.push(foot);

  valueEl.addEventListener('click', async () => {
    if (def.type === 'enum' || def.type === 'bool') return;
    const txt = await promptSheet(`${label} (${def.min ?? 0} – ${def.max ?? 1}${def.unit ? ' ' + def.unit : ''})`, String(+(+v).toFixed(4)), { inputmode: 'decimal' });
    if (txt == null) return;
    const nv = parseTyped(def, txt);
    if (nv == null) { app.toast(`“${txt}” is not a value for ${label}`, { level: 'warn' }); return; }
    set(nv, true);
  });

  function render() {
    valueEl.textContent = fmt(def, v);
    parts.render?.();
  }
  render();
  const sheet = openSheet({ title: label, body: parts, cls: 'pk-param-sheet' });
  if (target.color) sheet.el.style.setProperty('--ctl', target.color);
  return sheet;
}

/** Long-press menu of a control: jump values, reset, open the popup. */
function controlMenu(app, target, after) {
  const { def } = target;
  const items = [{ label: 'Open control…', icon: 'sliders', onClick: () => openParamPopup(app, target, { onChange: after }) }];
  items.push({ label: `Reset (${fmt(def, defaultOf(def))})`, icon: 'undo', onClick: () => { target.set(defaultOf(def), { final: true }); after?.(); } });
  for (const p of presetsFor(def)) items.push({ label: p.label, onClick: () => { target.set(p.value, { final: true }); after?.(); } });
  actionSheet(target.label || def.label, items);
}

// ------------------------------------------------------------------------------------------- tile
/**
 * Big control tile: label + value + level bar. Drag sideways to change (vertical distance = fine), tap for the
 * popup, long-press for quick values. Returns el with .update().
 */
export function ctlTile(app, target, { cls = '' } = {}) {
  const { def } = target;
  const bar = h('div.pk-tile-bar');
  const val = h('div.pk-tile-val');
  const el = h(`div.pk-tile${cls ? '.' + cls : ''}`, { 'data-noswipe': '', role: 'button', tabindex: 0 }, h('div.pk-tile-label', target.label || def.label), val, h('div.pk-tile-track', bar));
  if (target.color) el.style.setProperty('--ctl', target.color);
  const isNum = def.type === 'number' || !def.type;
  const update = () => {
    const v = target.get();
    val.textContent = fmt(def, v);
    if (isNum) {
      const n = normOf(def, v);
      const bip = (def.min ?? 0) < 0 && (def.max ?? 1) > 0;
      if (bip) { const z = normOf(def, 0); bar.style.left = `${Math.min(z, n) * 100}%`; bar.style.width = `${Math.abs(n - z) * 100}%`; } else { bar.style.left = '0'; bar.style.width = `${n * 100}%`; }
    } else if (def.type === 'bool') { bar.style.left = '0'; bar.style.width = v ? '100%' : '0'; } else { const i = (def.options || []).findIndex((o) => o.value === v); bar.style.left = '0'; bar.style.width = `${((i + 1) / Math.max(1, def.options?.length || 1)) * 100}%`; }
  };
  let st = null, lp = 0;
  const ae = autoEl(target);
  el.addEventListener('pointerdown', (e) => {
    st = { x: e.clientX, y: e.clientY, lastX: e.clientX, mode: null, n: isNum ? normOf(def, target.get()) : 0, id: e.pointerId };
    clearTimeout(lp);
    lp = setTimeout(() => { if (st && !st.mode) { st.mode = 'long'; haptic(15); controlMenu(app, target, update); } }, 500);
  });
  el.addEventListener('pointermove', (e) => {
    if (!st || st.id !== e.pointerId || st.mode === 'long') return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.mode) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) && isNum) {
        st.mode = 'drag'; clearTimeout(lp); el.setPointerCapture?.(e.pointerId); el.classList.add('active'); if (ae) touchStart(ae); haptic(4);
      } else if (Math.abs(dy) > 8) { st.mode = 'scroll'; clearTimeout(lp); }
      return;
    }
    if (st.mode === 'drag') {
      const w = el.getBoundingClientRect().width * 1.5;
      st.n = scrubNorm(st.n, e.clientX - st.lastX, w, e.clientY - st.y);
      st.lastX = e.clientX;
      target.set(valOf(def, st.n), { final: false });
      update();
    }
  });
  const end = (e) => {
    clearTimeout(lp);
    if (!st) return;
    const s = st;
    st = null;
    el.classList.remove('active');
    if (s.mode === 'drag') { if (ae) touchEnd(ae); update(); return; }
    if (!s.mode && e.type === 'pointerup') { haptic(6); openParamPopup(app, target, { onChange: update }); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.update = update;
  update();
  return el;
}

// ------------------------------------------------------------------------------------------- vertical fader
/** Tall vertical fader (Mix page): drag up / down anywhere on it (sideways distance = fine), tap = popup. */
export function vFader(app, target, { color = null } = {}) {
  const { def } = target;
  const fill = h('div.pk-vf-fill');
  const cap = h('div.pk-vf-cap');
  const val = h('div.pk-vf-val');
  const el = h('div.pk-vf', { 'data-noswipe': '' }, h('div.pk-vf-track', fill, cap), val);
  if (color) el.style.setProperty('--ctl', color);
  const update = () => {
    const v = target.get();
    const n = normOf(def, v);
    fill.style.height = `${n * 100}%`;
    cap.style.bottom = `${n * 100}%`;
    val.textContent = fmt(def, v);
  };
  const ae = autoEl(target);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const rect = el.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, t0 = performance.now();
    let lastY = e.clientY, n = normOf(def, target.get()), moved = false;
    if (ae) touchStart(ae);
    el.classList.add('active');
    const move = (ev) => {
      if (Math.abs(ev.clientY - y0) > 4) moved = true;
      n = scrubNorm(n, -(ev.clientY - lastY), rect.height, ev.clientX - x0);
      lastY = ev.clientY;
      target.set(valOf(def, n), { final: false });
      update();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('active');
      if (ae) touchEnd(ae);
      if (!moved && performance.now() - t0 < 350) { haptic(6); openParamPopup(app, target, { onChange: update }); }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.update = update;
  update();
  return el;
}
