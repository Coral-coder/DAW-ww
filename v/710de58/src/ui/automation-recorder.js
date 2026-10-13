// Automation recording (UI side). Arm with the header "A●" button (Shift+A); while armed and the
// transport plays in SONG mode, every change to an automatable setting — from any UI: knobs,
// faders, toggles, selects, mixer, device panel, plugboard, header master volume, assistant… — is
// written into that target's lane (one lane per target; created when missing).
//
// How: after every store transaction the recorder snapshots all automatable values
// (core/automation-record.js snapshotTargets) and diffs them against the previous snapshot. Each
// changed target gets a point at the audible playhead beat in the current AutomationTake. While a
// target is written the engine ignores its lane (engine.setAutomationOverride) so the live value is
// heard. On stop the take is merged into the lanes as ONE undo step ("Record automation").
// Changes from undo / redo / load and the recorder itself are never recorded. Disabled lanes
// (lane "On" toggle off) are left alone — re-enable them to record into them (a toast says so).
//
// Also here: controls follow their automation during song playback (~20 fps, display only), get an
// "automated" marker, and a right-click menu (Show / Add / Clear automation lane) — see markAuto().
import { Emitter } from '../core/util.js';
import { activeLanes, automationOwners, automationOwner, createAutomationLane, decodeParam, encodeParam, toNorm } from '../core/automation.js';
import { AutomationTake, snapshotTargets, diffTargets, mergeTake, keyOf, splitKey } from '../core/automation-record.js';
import { resolveInstrumentDef } from '../audio/presets.js';
import { resolveEffectParams } from '../audio/effect-defs.js';
import { controlEvents, setAutoContextHook, contextMenu, toast } from './components.js';
import { targetInfo, laneLabel, ownerInfo } from './automation-targets.js';
import { h } from './dom.js';

export const AUTO_MODES = [
  { value: 'touch', label: 'Touch', help: 'Touch — writes while you hold a control; when you let go the existing automation resumes' },
  { value: 'latch', label: 'Latch', help: 'Latch — writes from your first touch and keeps the last value until you stop' },
  { value: 'write', label: 'Write', help: 'Write — like Latch, and grabbing a control starts writing its value even before it moves' },
];

/** Labels of store transactions that must never be recorded (history / housekeeping / ourselves). */
const IGNORE = new Set(['undo', 'redo', 'load', 'refresh', 'Record automation', 'Normalize presets', 'Update plugboard', 'Song mode', 'Pattern mode',
  'Add automation lane', 'Delete automation lane', 'Clear automation', 'Toggle automation lane', 'Edit automation', 'Change automation target',
  'Automation ramp', 'Automation LFO', 'Delete automation point', 'Override automation', 'Re-enable automation']);
const BULK = 16; // more changed targets than this in one transaction = preset / auto-mix / generator: not recorded
const VIRTUAL_TOUCH_MS = 700; // wheel / typed / click changes: "released" this long after the last change

const resolveInst = (ins) => resolveInstrumentDef(ins);
const resolveFx = (f) => resolveEffectParams(f);

export function installAutomationRecorder(app) {
  const { store, ui, engine } = app;
  const bus = new Emitter();
  let take = null;
  let prevSnap = null;
  let tickTimer = 0;
  const meta = new Map(); // key -> { owner, target, info, staticValue, label }
  const pointerKeys = new Set();
  const virtualUntil = new Map(); // key -> ms
  let pointerDepth = 0;
  const warned = new Set();

  const armed = () => !!ui.get('autoArm');
  const mode = () => ui.get('autoMode') || 'touch';
  const shouldRecord = () => armed() && engine.isPlaying && store.get().mode === 'song';
  const beatNow = () => (engine.getAudiblePosition ? engine.getAudiblePosition() : engine.getPosition());
  const snap = (p) => snapshotTargets(p, { resolveInst, resolveFx });
  const laneOf = (p, owner, target) => automationOwner(p, owner)?.automation?.find((l) => l.target === target) || null;

  // ------------------------------------------------------------------ take lifecycle
  function begin() {
    if (take || !shouldRecord()) return;
    take = new AutomationTake({ mode: mode() });
    take.advance(beatNow());
    prevSnap = snap(store.get());
    meta.clear(); pointerKeys.clear(); virtualUntil.clear(); warned.clear();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 30);
    badge(true);
    bus.emit('state', true);
    bus.emit('update');
  }

  function end() {
    if (!take) return;
    clearInterval(tickTimer);
    tickTimer = 0;
    const t = take;
    take = null;
    t.finish();
    engine.clearAutomationOverrides?.();
    pointerKeys.clear(); virtualUntil.clear();
    badge(false);
    const res = t.result();
    if (res.length) commit(res);
    meta.clear();
    bus.emit('state', false);
    bus.emit('update');
  }

  /** Merge a finished take into the lanes: one undo step, lanes created where missing. */
  function commit(res) {
    const p0 = store.get();
    const labels = [];
    const plan = [];
    for (const r of res) {
      const m = meta.get(r.key);
      if (!m || !automationOwner(p0, r.owner)) continue;
      const def = m.info.def;
      plan.push({ ...r, def, staticValue: m.staticValue });
      labels.push(laneLabel(p0, r.owner, r.target));
    }
    if (!plan.length) return;
    store.transact('Record automation', (p) => {
      for (const r of plan) {
        const o = automationOwner(p, r.owner);
        if (!o) continue;
        if (!Array.isArray(o.automation)) o.automation = [];
        let lane = o.automation.find((l) => l.target === r.target);
        if (!lane) { lane = createAutomationLane(r.target, []); o.automation.push(lane); }
        delete lane.overridden; // recording into a lane brings it back to life
        lane.points = mergeTake(lane.points, r.segments, {
          staticValue: r.staticValue, stepped: !!r.def.stepped, eps: 0.008,
          norm: (v) => toNorm(r.def, v),
        });
      }
    });
    prevSnap = snap(store.get());
    const n = labels.length;
    const list = labels.slice(0, 6).join(', ') + (n > 6 ? ` +${n - 6} more` : '');
    toast(`Recorded ${n} automation lane${n === 1 ? '' : 's'}: ${list} — Ctrl+Z undoes the whole pass`, { level: 'success', timeout: 5200 });
    app.setStatus?.(`Recorded automation: ${list}`);
  }

  function tick() {
    if (!take) return;
    if (!shouldRecord()) { end(); return; }
    take.advance(beatNow());
    const now = performance.now();
    for (const [key, until] of virtualUntil) {
      if (now < until || pointerKeys.has(key)) continue;
      virtualUntil.delete(key);
      releaseKey(key);
    }
    bus.emit('tick');
  }

  function releaseKey(key) {
    if (!take) return;
    if (take.release(key, take.lastBeat)) {
      const { owner, target } = splitKey(key);
      engine.setAutomationOverride?.(owner, target, false);
    }
    bus.emit('update');
  }

  // ------------------------------------------------------------------ change detection
  function onChange(p, label) {
    if (!take) {
      if (shouldRecord()) begin();
      return;
    }
    if (!shouldRecord()) { end(); return; }
    const next = snap(p);
    if (IGNORE.has(label)) { prevSnap = next; return; }
    const diffs = diffTargets(prevSnap, next);
    prevSnap = next;
    if (!diffs.length) return;
    if (diffs.length > BULK) {
      if (!warned.has('#bulk')) { warned.add('#bulk'); toast(`"${label}" changed ${diffs.length} settings at once — not recorded as automation.`, { level: 'warn' }); }
      return;
    }
    const beat = beatNow();
    take.advance(beat);
    for (const d of diffs) record(p, d, beat);
    bus.emit('update');
  }

  function infoFor(p, key, owner, target) {
    let m = meta.get(key);
    if (!m) {
      const info = targetInfo(p, owner, target);
      if (info.missing) return null;
      m = { owner, target, info, staticValue: info.staticValue, label: laneLabel(p, owner, target) };
      meta.set(key, m);
    }
    return m;
  }

  function encodeFor(m, raw) {
    const pd = m.info.paramDef;
    return encodeParam(pd, raw ?? pd?.default);
  }

  function record(p, d, beat) {
    const lane = laneOf(p, d.owner, d.target);
    if (lane && lane.enabled === false) {
      if (!warned.has(d.key)) { warned.add(d.key); toast(`Automation lane "${laneLabel(p, d.owner, d.target)}" is disabled — enable it (lane "On") to record into it.`, { level: 'warn' }); }
      return;
    }
    const fresh = !meta.has(d.key);
    const m = infoFor(p, d.key, d.owner, d.target);
    if (!m) return;
    const value = encodeFor(m, d.next);
    if (value == null || !Number.isFinite(value)) return;
    if (fresh) {
      // the value before the take (punch-in / resume value of a brand-new lane)
      const prev = encodeFor(m, d.prev);
      if (prev != null && Number.isFinite(prev)) m.staticValue = prev;
    }
    const def = m.info.def;
    take.write(d.key, beat, value, { stepped: !!def.stepped, jump: Math.abs((def.max ?? 1) - (def.min ?? 0)) * 0.02 });
    engine.setAutomationOverride?.(d.owner, d.target, true);
    if (pointerDepth > 0) pointerKeys.add(d.key);
    else if (!def.stepped) virtualUntil.set(d.key, performance.now() + VIRTUAL_TOUCH_MS);
  }

  // ------------------------------------------------------------------ touch signal
  controlEvents.on('touchstart', (el) => {
    pointerDepth++;
    if (!take || mode() !== 'write') return;
    const owner = el?.dataset?.autoOwner, target = el?.dataset?.autoTarget;
    if (!owner || !target) return;
    const p = store.get();
    const key = keyOf(owner, target);
    const lane = laneOf(p, owner, target);
    if (lane && lane.enabled === false) return;
    const m = infoFor(p, key, owner, target);
    if (!m) return;
    // WRITE: grabbing a control writes its current (static) value right away
    const beat = beatNow();
    take.advance(beat);
    take.write(key, beat, m.info.staticValue, { stepped: !!m.info.def.stepped });
    engine.setAutomationOverride?.(owner, target, true);
    pointerKeys.add(key);
    bus.emit('update');
  });
  controlEvents.on('touchend', () => {
    pointerDepth = Math.max(0, pointerDepth - 1);
    if (pointerDepth > 0) return;
    const keys = [...pointerKeys];
    pointerKeys.clear();
    for (const k of keys) releaseKey(k);
  });

  // ------------------------------------------------------------------ override (not recording)
  // Moving an automated control by hand while NOT recording overrides its lane (like Ableton / Bitwig): the lane
  // stops driving the setting so the change is heard right away, during playback too, until "Re-enable automation".
  let grabbed = null; // { owner, target, value, until }
  function grab(e) {
    if (e.type === 'pointerdown' && e.button !== 0) return;
    const el = e.target?.closest?.('[data-auto-target]');
    if (!el) return;
    const owner = el.dataset.autoOwner, target = el.dataset.autoTarget;
    const p = store.get();
    const lane = laneOf(p, owner, target);
    if (!lane || lane.enabled === false || lane.overridden || !lane.points?.length) { grabbed = null; return; }
    const info = targetInfo(p, owner, target);
    if (info.missing) return;
    grabbed = { owner, target, value: info.staticValue, until: performance.now() + 15000 };
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', grab, true);
    document.addEventListener('wheel', grab, { capture: true, passive: true });
    document.addEventListener('focusin', grab, true);
  }
  let toldOverride = false;
  function checkOverride(p, label) {
    if (!grabbed || take || shouldRecord() || IGNORE.has(label)) return;
    if (performance.now() > grabbed.until) { grabbed = null; return; }
    const { owner, target, value } = grabbed;
    const info = targetInfo(p, owner, target);
    if (info.missing || info.staticValue === value) return;
    grabbed = null;
    queueMicrotask(() => {
      store.transact('Override automation', (pp) => { const l = laneOf(pp, owner, target); if (l) l.overridden = true; });
      if (!toldOverride) {
        toldOverride = true;
        toast(`"${laneLabel(store.get(), owner, target)}" now follows your hand instead of its automation lane — the orange ↺ button next to A● (or right-click the control) re-enables automation.`, { level: 'info', timeout: 6000 });
      }
    });
  }
  function reenable(owner, target) {
    store.transact('Re-enable automation', (pp) => {
      for (const o of automationOwners(pp)) for (const l of o?.automation || []) {
        if (l?.overridden && (!target || (l.target === target && automationOwner(pp, owner) === o))) delete l.overridden;
      }
    });
  }

  // ------------------------------------------------------------------ wiring
  store.on('change', (p, label) => {
    try { checkOverride(p, label); } catch (e) { console.error('[automation-override]', e); }
    try { onChange(p, label); } catch (e) { console.error('[automation-rec]', e); }
  });
  store.on('load', () => { if (take) { take = null; clearInterval(tickTimer); engine.clearAutomationOverrides?.(); badge(false); bus.emit('update'); } });
  engine.on?.('state', ({ playing }) => { if (playing) begin(); else end(); });
  ui.on('change', (changed) => {
    if ('autoArm' in changed) {
      if (changed.autoArm) {
        if (store.get().mode !== 'song') {
          app.actions?.setMode?.('song');
          toast('Automation armed — switched to SONG mode (automation is written on the arrangement timeline).', { level: 'info' });
        } else app.setStatus?.('Automation armed: press Play and move any control to record it.');
        begin();
      } else end();
    }
    if ('autoMode' in changed && take) take.mode = changed.autoMode;
  });

  // status-bar badge
  let badgeEl = null;
  function badge(on) {
    if (!badgeEl) {
      const host = document.querySelector('.app-status');
      if (!host) return;
      badgeEl = h('span.auto-rec-badge.hidden', { title: 'Automation is being recorded — stop the transport to finish the pass' }, h('span.auto-rec-dot'), 'REC AUTOMATION');
      host.insertBefore(badgeEl, host.children[2] || null);
    }
    badgeEl.classList.toggle('hidden', !on);
  }

  // ------------------------------------------------------------------ controls follow their lanes
  let laneIndex = new Map();
  let laneIndexOf = null;
  const infoCache = new Map();
  let storeVersion = 0;
  store.on('change', () => { storeVersion++; });
  store.on('load', () => { storeVersion++; });
  function rebuildIndex(p) {
    if (laneIndexOf === storeVersion && laneIndex) return;
    laneIndexOf = storeVersion;
    laneIndex = new Map();
    infoCache.clear();
    const ids = [...p.tracks.map((t) => t.id), ...(p.buses || []).map((b) => b.id), 'master'];
    const owners = automationOwners(p);
    owners.forEach((o, i) => { for (const l of activeLanes(o)) laneIndex.set(keyOf(ids[i], l.target), l); });
  }
  const decodeFor = (p, key, owner, target, v) => {
    let info = infoCache.get(key);
    if (!info) { info = targetInfo(p, owner, target); infoCache.set(key, info); }
    if (info.missing) return null;
    if (info.paramDef) return decodeParam(info.paramDef, v);
    return info.def.boolParam ? v >= 0.5 : v;
  };
  let followN = 0;
  let wasFollowing = false;
  function follow() {
    const p = store.get();
    const playing = engine.isPlaying && p.mode === 'song';
    followN++;
    if (!playing && !wasFollowing && followN % 10) return; // idle: refresh markers at ~2 fps
    rebuildIndex(p);
    let any = false;
    for (const el of document.querySelectorAll('[data-auto-target]')) {
      const owner = el.dataset.autoOwner, target = el.dataset.autoTarget;
      const key = keyOf(owner, target);
      const has = laneIndex.has(key);
      el.classList.toggle('auto-on', has);
      el.classList.toggle('auto-overridden', !has && !!laneOf(p, owner, target)?.overridden);
      el.classList.toggle('auto-rec', !!take?.isWriting(key));
      const setter = el.autoSet || el.setValue;
      const busy = el.classList.contains('active') || el.matches(':focus');
      let v = null;
      if (playing && has && !busy) v = engine.getAutomatedValue?.(owner, target);
      if (v != null) {
        const dv = decodeFor(p, key, owner, target, v);
        if (dv != null && setter) { setter.call(el, dv); el._autoShown = true; any = true; }
      } else if (el._autoShown && !busy) {
        // back to the static (store) value
        el._autoShown = false;
        const info = targetInfo(p, owner, target);
        if (!info.missing && setter) setter.call(el, info.paramDef ? decodeParam(info.paramDef, info.staticValue) : info.def.boolParam ? info.staticValue >= 0.5 : info.staticValue);
      }
    }
    wasFollowing = any;
  }
  setInterval(() => { try { follow(); } catch (e) { console.warn('[automation follow]', e); } }, 50);

  // ------------------------------------------------------------------ right-click on a tagged control
  function revealLane(owner, target) {
    app.showView('arrange');
    let tries = 0;
    const go = () => {
      const v = app.views?.arrange;
      if (v?.revealAutomation) v.revealAutomation(owner, target);
      else if (tries++ < 20) setTimeout(go, 50);
    };
    setTimeout(go, 30);
  }
  function ensureLane(owner, target) {
    const p = store.get();
    if (laneOf(p, owner, target)) return;
    store.transact('Add automation lane', (pp) => {
      const o = automationOwner(pp, owner);
      if (!o) return;
      if (!Array.isArray(o.automation)) o.automation = [];
      if (!o.automation.some((l) => l.target === target)) o.automation.push(createAutomationLane(target, []));
    });
  }
  setAutoContextHook((el, e) => {
    const owner = el.dataset.autoOwner, target = el.dataset.autoTarget;
    const p = store.get();
    if (!ownerInfo(p, owner)) return false;
    const info = targetInfo(p, owner, target);
    if (info.missing) return false;
    const lane = laneOf(p, owner, target);
    const editLane = (label, fn) => store.transact(label, (pp) => { const l = laneOf(pp, owner, target); if (l) fn(l); });
    contextMenu(e, [
      { header: laneLabel(p, owner, target) },
      lane
        ? { label: 'Show automation lane', icon: 'timeline', onClick: () => revealLane(owner, target) }
        : { label: 'Add automation lane', icon: 'plus', onClick: () => { ensureLane(owner, target); revealLane(owner, target); } },
      { label: 'Clear automation', icon: 'x', disabled: !lane?.points?.length, onClick: () => editLane('Clear automation', (l) => { l.points = []; }) },
      lane?.overridden ? { label: 'Re-enable automation', icon: 'refresh', onClick: () => reenable(owner, target) } : null,
      lane ? { label: lane.enabled === false ? 'Enable lane' : 'Disable lane (bypass)', icon: 'power', onClick: () => editLane('Toggle automation lane', (l) => { l.enabled = l.enabled === false; }) } : null,
      '-',
      { label: armed() ? 'Disarm automation recording' : 'Arm automation recording (Shift+A)', icon: 'record', onClick: () => ui.set({ autoArm: !armed() }) },
    ].filter(Boolean));
    return true;
  });

  const api = {
    on: (evt, fn) => bus.on(evt, fn),
    get recording() { return !!take; },
    get armed() { return armed(); },
    toggleArm() { ui.set({ autoArm: !armed() }); },
    setMode(m) { if (AUTO_MODES.some((x) => x.value === m)) ui.set({ autoMode: m }); },
    /** Keys (owner|target) written in the current take. */
    recordingKeys: () => (take ? take.keys() : []),
    /** Written segments of a target in the current take: [{start, end, points}] (for drawing). */
    liveSegments(owner, target) {
      const w = take?.writers.get(keyOf(owner, target));
      return w ? w.segs.map((s) => ({ start: s.start, end: w.cur === s ? take.lastBeat : s.end, points: s.points, open: w.cur === s })) : [];
    },
    isWriting: (owner, target) => !!take?.isWriting(keyOf(owner, target)),
    revealLane,
    finish: end,
    /** Re-enable every overridden lane (or one: owner + target). */
    reenable,
  };
  app.automation = api;
  return api;
}
