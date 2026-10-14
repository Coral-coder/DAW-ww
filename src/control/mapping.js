// MIDI learn + controller mappings (Node-safe, no DOM). The UI layer (src/control/index.js) supplies the
// target side (read / write a normalized value of an automation target, run a command); this module decides
// what a hardware move means: absolute / relative encoders (auto-detected), soft takeover (pickup), ranges,
// inversion, button toggle / momentary, 14-bit CC and NRPN.
//
// Mapping (plain JSON — stored in project.controlMappings, or in the global controller template):
//   { id, source: { device: name|null (any), ch: 0-15|null (any), kind: 'cc'|'cc14'|'nrpn'|'note'|'pb'|'cp', num },
//     target: { owner, target } (automation target, owner may be '@sel' / '@t1'… in templates) | { command: id },
//     mode: 'absolute'|'relative-2c'|'relative-bin'|'relative-sm', detect?: true (relative flavour still being
//     confirmed), takeover: 'pickup'|'jump', min: 0..1, max: 0..1, invert: bool, button: 'toggle'|'momentary'|null,
//     sensitivity: number (relative), feedback: bool }
import { Emitter, uid } from '../core/util.js';
import { ControlDecoder, detectCcMode, relativeDelta, RELATIVE_MODES, split14 } from './midi.js';

export const MAPPINGS_FORMAT = 'daw3-midi-mappings';
export const LEARN_WINDOW_MS = 450; // CC values collected after the first one before deciding abs / rel / button
const LEARN_MAX_EVENTS = 6;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function createMapping(source, target, opts = {}) {
  return {
    id: opts.id || uid('map'),
    source: { device: source.device ?? null, ch: source.ch ?? null, kind: source.kind, num: source.num ?? 0 },
    target: { ...target },
    mode: opts.mode || 'absolute',
    ...(opts.detect ? { detect: true } : {}),
    takeover: opts.takeover || 'pickup',
    min: opts.min ?? 0,
    max: opts.max ?? 1,
    invert: !!opts.invert,
    button: opts.button ?? null,
    sensitivity: opts.sensitivity ?? 1,
    feedback: opts.feedback !== false,
    ...(opts.name ? { name: opts.name } : {}),
  };
}

/** Validate / fill a mapping loaded from JSON (returns null when unusable). */
export function normalizeMapping(m) {
  if (!m || typeof m !== 'object' || !m.source || !m.target) return null;
  const kinds = ['cc', 'cc14', 'nrpn', 'note', 'pb', 'cp'];
  if (!kinds.includes(m.source.kind)) return null;
  if (!m.target.command && !(m.target.owner && m.target.target)) return null;
  const modes = ['absolute', ...RELATIVE_MODES];
  return createMapping(m.source, m.target, {
    ...m, mode: modes.includes(m.mode) ? m.mode : 'absolute', takeover: m.takeover === 'jump' ? 'jump' : 'pickup',
    min: clamp01(Number(m.min ?? 0)), max: clamp01(Number(m.max ?? 1)), button: m.button === 'momentary' || m.button === 'toggle' ? m.button : null,
    sensitivity: Number.isFinite(+m.sensitivity) && +m.sensitivity > 0 ? +m.sensitivity : 1,
  });
}

export const sourceKey = (s) => `${s.device ?? '*'}|${s.ch ?? '*'}|${s.kind}|${s.num}`;
const targetKey = (t) => (t.command ? `cmd:${t.command}` : `${t.owner}|${t.target}`);

export function sourceMatches(src, ev) {
  if (src.device != null && src.device !== ev.device) return false;
  if (src.ch != null && src.ch !== ev.ch) return false;
  if (src.num !== ev.num) return false;
  if (src.kind === ev.kind) return true;
  // a 7-bit CC mapping keeps working when the controller turns out to send 14-bit pairs (and vice versa)
  return (src.kind === 'cc' && ev.kind === 'cc14') || (src.kind === 'cc14' && ev.kind === 'cc');
}

export function exportMappings(list) {
  return JSON.stringify({ format: MAPPINGS_FORMAT, version: 1, mappings: list }, null, 2);
}
export function importMappings(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  const list = Array.isArray(j) ? j : j?.mappings;
  if (!Array.isArray(list)) throw new Error('Not a daW³ MIDI mapping file');
  return list.map(normalizeMapping).filter(Boolean);
}

/**
 * MappingEngine — feed it raw MIDI with handle(deviceName, bytes, timeMs).
 *   host.getNorm(target) -> 0..1 | null       current value of the target (null = missing)
 *   host.setNorm(target, norm, ctx)            write it (ctx: {mapping, event, phase})
 *   host.steps?(target) -> number|null         number of discrete steps (enum / bool) or null
 *   host.runCommand?(id, {pressed, value})     command targets
 *   host.send?(deviceName, bytes)              feedback to the device (LED rings, motor faders)
 * Events: 'learned' (mapping), 'learn-start' (target), 'learn-end', 'change' (mappings edited),
 *         'pickup' ({mapping, hw, cur}) when a pickup control has not caught the value yet, 'moved' ({mapping, norm}).
 */
export class MappingEngine extends Emitter {
  constructor(host = {}) {
    super();
    this.host = host;
    this.decoder = new ControlDecoder();
    this.project = []; // project mappings
    this.template = []; // global controller template
    this.learning = null; // { target, scope, key, events:[], first }
    this.state = new Map(); // mapping id -> { picked, lastHw, lastSent, history:[], pressed }
  }

  get mappings() { return [...this.project, ...this.template]; }
  setProjectMappings(list) { this.project = (list || []).map(normalizeMapping).filter(Boolean); this.state.clear(); }
  setTemplate(list) { this.template = (list || []).map(normalizeMapping).filter(Boolean); }

  // ------------------------------------------------------------------ learn
  startLearn(target, { scope = 'project' } = {}) {
    this.learning = { target: { ...target }, scope, key: null, events: [], first: null };
    this.emit('learn-start', target);
  }
  cancelLearn() { if (this.learning) { this.learning = null; this.emit('learn-end', null); } }
  get isLearning() { return !!this.learning; }

  /** Finish a pending CC learn whose window ran out (call from a timer with the current time). */
  flushLearn(now) {
    const L = this.learning;
    if (L?.events.length && now - L.first >= LEARN_WINDOW_MS) this._finishCcLearn();
  }

  _learnEvent(ev) {
    const L = this.learning;
    if (ev.kind === 'note') {
      if (ev.value <= 0) return true; // release of a note pressed before learn started
      return this._learned(ev, { button: L.target.command ? 'momentary' : 'toggle' }, ev);
    }
    if (ev.kind === 'pb' || ev.kind === 'cp' || ev.kind === 'cc14') return this._learned(ev, {}, ev);
    if (ev.kind === 'nrpn') return this._learned(ev, ev.step ? { mode: 'relative-2c' } : {}, ev);
    // 7-bit CC: collect a few values to tell knobs, encoders and buttons apart
    const key = sourceKey({ ...ev, device: ev.device });
    if (L.key && L.key !== key) {
      // another control moved: the first one wins if it already has values
      if (L.events.length) { this._finishCcLearn(); return true; }
    }
    if (!L.key) { L.key = key; L.first = ev.t; }
    L.events.push(ev);
    if (L.events.length >= LEARN_MAX_EVENTS || ev.t - L.first >= LEARN_WINDOW_MS) this._finishCcLearn();
    return true;
  }

  _finishCcLearn() {
    const L = this.learning;
    if (!L?.events.length) return;
    const values = L.events.map((e) => e.value);
    const ev = L.events[L.events.length - 1];
    const det = detectCcMode(values);
    const opts = {};
    if (det.mode === 'button') opts.button = L.target.command ? 'momentary' : 'toggle';
    else if (RELATIVE_MODES.includes(det.mode)) { opts.mode = det.mode; if (!det.sure) opts.detect = true; }
    const m = this._learned(ev, opts, null);
    if (m && opts.detect) this._st(m.id).history = values.slice(-16);
  }

  _learned(ev, opts, applyEv) {
    const L = this.learning;
    this.learning = null;
    const src = { device: ev.device, ch: ev.ch, kind: ev.kind, num: ev.num };
    const list = L.scope === 'template' ? this.template : this.project;
    // one control -> one target (per scope): re-learning replaces older mappings of the same source / target
    const sk = sourceKey(src), tk = targetKey(L.target);
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (sourceKey(m.source) === sk || targetKey(m.target) === tk) list.splice(i, 1);
    }
    const m = createMapping(src, L.target, { ...opts, ...(L.scope === 'template' ? { scope: 'template' } : {}) });
    if (L.scope === 'template') m.scope = 'template';
    list.push(m);
    this._st(m.id).picked = true; // the hand is on the control right now: no pickup needed
    this.emit('learned', m);
    this.emit('learn-end', m);
    this.emit('change', { scope: L.scope });
    if (applyEv && !m.button) this._apply(m, applyEv);
    return m;
  }

  _st(id) {
    let s = this.state.get(id);
    if (!s) { s = { picked: false, lastHw: null, lastSent: null, history: [], pressed: false }; this.state.set(id, s); }
    return s;
  }

  // ------------------------------------------------------------------ input
  /** Raw MIDI in. Returns true when a mapping (or learn) used the message. */
  handle(device, data, t = 0) {
    let used = false;
    for (const ev of this.decoder.decode(device, data, t)) used = this.handleEvent(ev) || used;
    return used;
  }

  handleEvent(ev) {
    if (this.learning) {
      // the learn window of a CC that stopped moving ran out
      if (this.learning.events.length && ev.t - this.learning.first >= LEARN_WINDOW_MS && sourceKey(ev) !== this.learning.key) this._finishCcLearn();
      if (this.learning) return this._learnEvent(ev);
    }
    // project mappings shadow template mappings of the same source
    const hits = this.project.filter((m) => sourceMatches(m.source, ev));
    const list = hits.length ? hits : this.template.filter((m) => sourceMatches(m.source, ev));
    for (const m of list) this._apply(m, ev);
    return list.length > 0;
  }

  _apply(m, ev) {
    const host = this.host;
    const st = this._st(m.id);
    const lo = Math.min(m.min, m.max), hi = Math.max(m.min, m.max);
    if (m.target.command) {
      const pressed = ev.kind === 'note' || m.button ? ev.value > 0 : ev.value > (ev.max || 127) / 2;
      if (pressed === st.pressed && m.button !== null) return;
      st.pressed = pressed;
      if (pressed || m.button === 'momentary') host.runCommand?.(m.target.command, { pressed, value: ev.value / (ev.max || 127) });
      return;
    }
    const cur = host.getNorm?.(m.target);
    if (cur == null) return;
    const steps = host.steps?.(m.target) || null;
    const set = (n, phase = 'move') => {
      n = clamp01(n);
      if (steps) n = Math.round(n * steps) / steps;
      st.lastSent = n;
      host.setNorm?.(m.target, n, { mapping: m, event: ev, phase });
      this.emit('moved', { mapping: m, norm: n });
    };
    // buttons: note on/off, or CC 127/0
    if (m.button || ev.kind === 'note') {
      const pressed = ev.value > 0;
      const onV = m.invert ? lo : hi, offV = m.invert ? hi : lo;
      if (m.button === 'momentary') { if (pressed !== st.pressed) { st.pressed = pressed; set(pressed ? onV : offV, pressed ? 'press' : 'release'); } return; }
      if (!pressed) { st.pressed = false; return; }
      if (st.pressed) return;
      st.pressed = true;
      set(Math.abs(cur - onV) < Math.abs(cur - offV) ? offV : onV, 'press');
      return;
    }
    // relative encoders (and NRPN increment / decrement)
    if (RELATIVE_MODES.includes(m.mode) || ev.step) {
      let delta;
      if (ev.step) delta = ev.value;
      else {
        if (m.detect) {
          st.history.push(ev.value);
          if (st.history.length > 24) st.history.shift();
          const det = detectCcMode(st.history);
          if (RELATIVE_MODES.includes(det.mode) && det.mode !== m.mode) { m.mode = det.mode; this.emit('change', { scope: m.scope || 'project', mapping: m, auto: true }); }
          if (det.sure && RELATIVE_MODES.includes(det.mode)) { delete m.detect; this.emit('change', { scope: m.scope || 'project', mapping: m, auto: true }); }
        }
        delta = relativeDelta(m.mode, ev.value);
      }
      if (!delta) return;
      const accel = Math.abs(delta) > 1 ? Math.abs(delta) * 1.5 : 1; // fast spins move further
      const unit = steps ? 1 / steps : 1 / 200;
      const dir = Math.sign(delta) * (m.invert ? -1 : 1);
      set(Math.max(lo, Math.min(hi, cur + dir * accel * unit * (m.sensitivity || 1))));
      return;
    }
    // absolute
    let x = ev.max ? ev.value / ev.max : 0;
    if (m.invert) x = 1 - x;
    const out = lo + x * (hi - lo);
    if (m.takeover === 'pickup') {
      const tol = Math.max(0.02, 2 / (ev.max || 127));
      // the value moved elsewhere (mouse, automation, another controller) since our last write: catch it again
      if (st.picked && st.lastSent != null && Math.abs(cur - st.lastSent) > tol * 1.5) st.picked = false;
      if (!st.picked) {
        const crossed = st.lastHw != null && (st.lastHw - cur) * (out - cur) <= 0;
        if (Math.abs(out - cur) <= tol || crossed) st.picked = true;
        else {
          st.lastHw = out;
          this.emit('pickup', { mapping: m, hw: out, cur });
          return;
        }
      }
    }
    st.lastHw = out;
    set(out);
  }

  // ------------------------------------------------------------------ feedback
  /** MIDI messages that show `norm` on the mapped control (LED ring / motor fader / button LED). [] when none. */
  feedbackBytes(m, norm) {
    if (!m.feedback || m.target.command) return [];
    const s = m.source;
    const ch = s.ch ?? 0;
    const lo = Math.min(m.min, m.max), hi = Math.max(m.min, m.max);
    let x = hi > lo ? (norm - lo) / (hi - lo) : 0;
    x = clamp01(m.invert ? 1 - x : x);
    if (m.button || s.kind === 'note') {
      const on = x >= 0.5;
      return s.kind === 'note' ? [[0x90 | ch, s.num, on ? 127 : 0]] : [[0xb0 | ch, s.num, on ? 127 : 0]];
    }
    if (RELATIVE_MODES.includes(m.mode)) return []; // most encoders take ring values on a separate CC; not guessed
    switch (s.kind) {
      case 'cc': return [[0xb0 | ch, s.num, Math.round(x * 127)]];
      case 'cc14': { const [l, mm] = split14(x * 16383); return [[0xb0 | ch, s.num, mm], [0xb0 | ch, s.num + 32, l]]; }
      case 'nrpn': { const [l, mm] = split14(x * 16383); return [[0xb0 | ch, 99, s.num >> 7], [0xb0 | ch, 98, s.num & 0x7f], [0xb0 | ch, 6, mm], [0xb0 | ch, 38, l]]; }
      case 'pb': { const [l, mm] = split14(x * 16383); return [[0xe0 | ch, l, mm]]; }
      default: return [];
    }
  }

  // ------------------------------------------------------------------ editing
  find(id) { return this.mappings.find((m) => m.id === id) || null; }
  update(id, patch) {
    const m = this.find(id);
    if (!m) return null;
    Object.assign(m, patch);
    if (patch.mode && !RELATIVE_MODES.includes(patch.mode)) delete m.detect;
    this.state.delete(id);
    this.emit('change', { scope: m.scope || 'project', mapping: m });
    return m;
  }
  remove(id) {
    for (const list of [this.project, this.template]) {
      const i = list.findIndex((m) => m.id === id);
      if (i >= 0) { const [m] = list.splice(i, 1); this.state.delete(id); this.emit('change', { scope: m.scope || 'project' }); return true; }
    }
    return false;
  }
  /** Mappings pointing at an automation target (owner already resolved by the caller). */
  forTarget(owner, target) { return this.mappings.filter((m) => m.target.owner === owner && m.target.target === target); }
  /** Forget pickup state (e.g. after loading a project or when automation moves the value). */
  resetTakeover() { for (const s of this.state.values()) s.picked = false; }
}
