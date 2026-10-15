// Control-rate modulation scheduler of a MixGraph (realtime and offline alike). Each tick(project, t, …) evaluates
// every track's macros and modulators at context time t and applies the routed offsets:
//   instrument params -> MixGraph.setModInst (merged over automation overrides, then Instrument.update)
//   effect params     -> ChannelStrip.setFxMod (merged over automation overrides, then effect.update)
//   volume/pan/sends  -> ConstantSource offsets summed into the AudioParams (automation ramps keep running beneath)
// Base values are what automation plays at that moment (or the static value), so automation sets the base and
// modulation offsets it (core/modulation.js has the math). The realtime engine ticks every ~15 ms; offline renders
// tick at suspend points (render.js). Envelope modulators follow the track's notes (MixGraph forwards note-on/off);
// envelope followers read an analyser on the source track's post-insert tap.
import {
  routesByTarget, routeOffset, combine, targetExtent, modulatorValue, envState, envAdvance, envGate, followStep, MACRO_COUNT,
} from '../../core/modulation.js';
import { toNorm, fromNorm, activeLanes, valueAt, parseTarget } from '../../core/automation.js';
import { modTargetInfo } from './targets.js';

const EPS = 1e-4;

class TrackState {
  constructor() {
    this.gates = []; // [{t, on}] pending note gates (sorted)
    this.held = 0;
    this.noteT = null; // last note-on time
    this.env = new Map(); // modId -> env state
    this.follow = new Map(); // modId -> { src, nodes, level, buf }
    this.inst = null; this.fx = null; this.mix = null; // last applied maps (for release / change detection)
    this.view = null;
  }
}

export class ModRunner {
  constructor(graph) {
    this.graph = graph;
    this.ctx = graph.ctx;
    this.tracks = new Map();
    this.offsets = new WeakMap(); // AudioParam -> ConstantSourceNode
    this.lastT = null;
  }

  _st(id) { let s = this.tracks.get(id); if (!s) { s = new TrackState(); this.tracks.set(id, s); } return s; }

  /** A note of a track starts (on) / ends at context time t (envelope modulators, note-retriggered LFOs). */
  note(trackId, t, on) {
    const s = this._st(trackId);
    const g = s.gates;
    let i = g.length;
    while (i > 0 && g[i - 1].t > t) i--;
    g.splice(i, 0, { t, on });
    if (g.length > 4096) g.splice(0, g.length - 4096);
  }

  /** All notes of a track (or every track) stopped. */
  allOff(trackId = null) {
    for (const [id, s] of this.tracks) {
      if (trackId && id !== trackId) continue;
      s.gates = []; s.held = 0;
      for (const st of s.env.values()) envGate(st, false);
    }
  }

  /** Live view for the UI: { macros:[0..1], mods:{id: 0..1}, targets:{target: {base, norm, lo, hi}} } (normalized). */
  view(trackId) { return this.tracks.get(trackId)?.view || null; }

  /**
   * opts: { beat (transport beat at t, null when stopped), bpm, songAuto (automation lanes play: song mode, transport
   * running), immediate }
   */
  tick(project, t, opts = {}) {
    const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const live = new Set();
    for (const track of project.tracks || []) {
      const e = this.graph.tracks.get(track.id);
      if (!e) continue;
      const routes = routesByTarget(track);
      const s = this.tracks.get(track.id);
      if (!routes.size) {
        if (s && (s.inst || s.fx || s.mix)) this._release(track.id, e, s, t);
        if (s) { s.view = track.mod ? { macros: (track.mod.macros || []).map((m) => m.value), mods: {}, targets: {} } : null; live.add(track.id); }
        continue;
      }
      live.add(track.id);
      try { this._track(project, track, e, this._st(track.id), routes, t, dt, opts); } catch (err) { this.graph.onError?.(err); }
    }
    for (const [id, s] of this.tracks) {
      if (live.has(id)) continue;
      for (const f of s.follow.values()) this._disposeFollow(f);
      this.tracks.delete(id);
    }
  }

  _track(project, track, e, s, routes, t, dt, opts) {
    const mod = track.mod || {};
    const bpm = opts.bpm || project.bpm || 120;
    const lanes = opts.songAuto ? activeLanes(track) : [];
    const laneOf = (target) => lanes.find((l) => l.target === target) || null;
    // ---- gates up to t
    const envMods = (mod.mods || []).filter((m) => m.type === 'env');
    for (const m of envMods) if (!s.env.has(m.id)) s.env.set(m.id, envState());
    while (s.gates.length && s.gates[0].t <= t) {
      const g = s.gates.shift();
      for (const m of envMods) envAdvance(s.env.get(m.id), m, g.t);
      if (g.on) { s.held++; s.noteT = g.t; for (const m of envMods) envGate(s.env.get(m.id), true); }
      else { s.held = Math.max(0, s.held - 1); if (!s.held) for (const m of envMods) envGate(s.env.get(m.id), false); }
    }
    // ---- sources
    const src = new Map();
    const macros = [];
    for (let i = 0; i < MACRO_COUNT; i++) {
      const lane = laneOf(`macro:${i}`);
      const v = lane && opts.beat != null ? valueAt(lane.points, opts.beat) : mod.macros?.[i]?.value ?? 0;
      macros.push(Math.max(0, Math.min(1, Number(v) || 0)));
      src.set(`macro:${i}`, macros[i]);
    }
    const clock = { t, beat: opts.beat ?? null, bpm, noteT: s.noteT };
    const modVals = {};
    for (const m of mod.mods || []) {
      let v = 0;
      if (m.type === 'env') v = envAdvance(s.env.get(m.id), m, t);
      else if (m.type === 'follow') v = this._follow(project, track, m, s, dt);
      else v = modulatorValue(m, clock);
      v = Math.max(0, Math.min(1, v));
      modVals[m.id] = v;
      src.set(m.id, v);
    }
    for (const id of [...s.env.keys()]) if (!envMods.some((m) => m.id === id)) s.env.delete(id);
    for (const [id, f] of [...s.follow]) if (!(mod.mods || []).some((m) => m.id === id && m.type === 'follow')) { this._disposeFollow(f); s.follow.delete(id); }

    // ---- targets
    const inst = {}, fx = {}, mix = { sends: {} };
    let anyInst = false, anyFx = false;
    const targets = {};
    const cache = {};
    for (const [target, list] of routes) {
      const info = modTargetInfo(project, track, target, cache);
      if (!info) continue;
      const tg = parseTarget(target);
      let base = info.value;
      if (tg.kind === 'inst' && e.instOv && Number.isFinite(e.instOv[tg.key])) base = e.instOv[tg.key];
      else if (tg.kind === 'fx') { const ov = e.strip.fxOv.get(tg.fxId); if (ov && Number.isFinite(ov[tg.key])) base = ov[tg.key]; }
      else if (info.kind === 'mixer' && opts.beat != null) { const lane = laneOf(target); if (lane) base = valueAt(lane.points, opts.beat); }
      const baseNorm = toNorm(info.def, base);
      const offsets = list.filter((r) => src.has(r.src)).map((r) => routeOffset(r, src.get(r.src)));
      const norm = combine(baseNorm, offsets);
      let value = fromNorm(info.def, norm);
      if ((info.def.step || 0) >= 1) value = Math.round(value / info.def.step) * info.def.step;
      const [lo, hi] = targetExtent(list);
      targets[target] = { base: baseNorm, norm, lo: Math.max(0, Math.min(1, baseNorm + lo)), hi: Math.max(0, Math.min(1, baseNorm + hi)) };
      if (tg.kind === 'inst') { inst[tg.key] = value; anyInst = true; }
      else if (tg.kind === 'fx') { (fx[tg.fxId] ||= {})[tg.key] = value; anyFx = true; }
      else if (tg.kind === 'volume') mix.volume = value - base;
      else if (tg.kind === 'pan') mix.pan = value - base;
      else if (tg.kind === 'send') mix.sends[tg.busId] = value - base;
    }
    s.view = { macros, mods: modVals, targets };
    // ---- apply
    const instMap = anyInst ? inst : null;
    if (changedMap(s.inst, instMap)) { s.inst = instMap; this.graph.setModInst(track.id, instMap); }
    const fxMap = anyFx ? fx : null;
    if (changedNested(s.fx, fxMap)) { s.fx = fxMap; e.strip.setFxMod(fxMap); }
    this._mix(e.strip, s, mix, t, opts.immediate);
  }

  _mix(strip, s, mix, t, immediate) {
    const prev = s.mix || { sends: {} };
    const set = (param, v, old) => {
      if (!param) return;
      if (v == null && !old) return;
      const node = this._offset(param);
      const val = v ?? 0;
      if (immediate) { node.offset.cancelScheduledValues(0); node.offset.setValueAtTime(val, Math.max(0, t)); }
      else node.offset.setTargetAtTime(val, Math.max(t, this.ctx.currentTime), 0.008);
    };
    set(strip.volume?.gain, mix.volume, prev.volume != null);
    set(strip.panner?.pan, mix.pan, prev.pan != null);
    const busIds = new Set([...Object.keys(mix.sends || {}), ...Object.keys(prev.sends || {})]);
    for (const busId of busIds) set(strip.sends?.get(busId)?.gain, mix.sends[busId], prev.sends?.[busId] != null);
    s.mix = mix.volume != null || mix.pan != null || Object.keys(mix.sends).length ? mix : null;
  }

  _offset(param) {
    let n = this.offsets.get(param);
    if (!n) {
      n = this.ctx.createConstantSource();
      n.offset.value = 0;
      n.connect(param);
      n.start();
      this.offsets.set(param, n);
      (this._nodes ||= []).push(n);
    }
    return n;
  }

  _release(trackId, e, s, t) {
    if (s.inst) { s.inst = null; this.graph.setModInst(trackId, null); }
    if (s.fx) { s.fx = null; e.strip.setFxMod(null); }
    if (s.mix) this._mix(e.strip, s, { sends: {} }, t, false);
    for (const f of s.follow.values()) this._disposeFollow(f);
    s.follow.clear();
  }

  // ---- envelope follower: |x| -> low-pass -> analyser (control-rate read)
  _follow(project, track, m, s, dt) {
    const srcId = m.source && project.tracks.some((x) => x.id === m.source) ? m.source : track.id;
    const strip = this.graph.tracks.get(srcId)?.strip;
    let f = s.follow.get(m.id);
    if (f && f.src !== strip) { this._disposeFollow(f); f = null; s.follow.delete(m.id); }
    if (!f && strip && typeof this.ctx.createAnalyser === 'function') {
      try {
        const ctx = this.ctx;
        const rect = ctx.createWaveShaper();
        const curve = new Float32Array(1025);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.abs((i / 512) - 1);
        rect.curve = curve;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 30; lp.Q.value = 0.5;
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        strip.post.connect(rect); rect.connect(lp); lp.connect(an);
        f = { src: strip, nodes: [rect, lp, an], an, buf: new Float32Array(256), level: 0 };
        s.follow.set(m.id, f);
      } catch { f = null; }
    }
    if (!f) return 0;
    try { f.an.getFloatTimeDomainData(f.buf); } catch { /* */ }
    const raw = Math.abs(f.buf[f.buf.length - 1] || 0) * 1.57 * Math.pow(10, (m.gain || 0) / 20); // mean |sine| = 2/π
    f.level = followStep(f.level, Math.min(1, raw), dt || 0.01, m.attack || 0.01, m.release || 0.15);
    return f.level;
  }

  _disposeFollow(f) {
    if (!f) return;
    try { f.src.post.disconnect(f.nodes[0]); } catch { /* */ }
    for (const n of f.nodes) { try { n.disconnect(); } catch { /* */ } }
  }

  dispose() {
    for (const s of this.tracks.values()) for (const f of s.follow.values()) this._disposeFollow(f);
    for (const n of this._nodes || []) { try { n.stop(); n.disconnect(); } catch { /* */ } }
    this.tracks.clear();
  }
}

function changedMap(a, b) {
  if (!a || !b) return a !== b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (x === undefined || y === undefined) return true;
    if (Math.abs(x - y) > EPS * Math.max(1, Math.abs(x), Math.abs(y))) return true;
  }
  return false;
}
function changedNested(a, b) {
  if (!a || !b) return a !== b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (changedMap(a[k] || null, b[k] || null)) return true;
  return false;
}
