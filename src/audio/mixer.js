// Channel strips and the mix graph. Context-agnostic: the realtime engine and the offline
// renderer both build their graph through MixGraph so they sound identical.
//
// Track strip:  instrument/code/audio-clips -> input -> [insert fx... | plugboard patch] -> post
//                 -> pan -> volume -> mute -> master input, -> post-fader sends -> bus inputs, -> meter
//               `post` (after the inserts, before pan/fader/mute) is the sidechain key tap that feeds
//               ducker effects keyed by this track (pre-fader: the key follows the track's
//               processed signal regardless of its fader; a muted track plays no events, so it
//               does not duck anything).
// Plugboard:    when track.patch.enabled, the insert section is built from the patch graph
//               (src/core/patch.js): effect instances wired by cables (one GainNode per cable),
//               split/mix junctions as unity GainNodes, 'in' = input, 'out' = post.
// Bus strip:    input -> fx -> pan -> volume -> mute -> master input
// Master:       input -> fx -> volume -> analyser -> destination  (metronome joins after master fx)
import { createEffect } from './effects.js';
import { createInstrument } from './instruments.js';
import * as codeInstrumentModule from './code-instrument.js';
import { StrudelInstrument } from './strudel-instrument.js';
import { scheduleClick } from './metronome.js';
import { isTrackAudible } from './scheduler.js';
import {
  activeLanes, parseTarget, segmentsInWindow, valueAt, controlOverrides, cableOverrides, decodeParam, mergeParamOverrides, FX_ENABLE_KEY,
} from '../core/automation.js';
import { INSTRUMENT_DEFS } from './defs.js';
import { EFFECT_DEFS } from './effect-defs.js';
import { resolveInstrument } from './instruments.js';
import { sanitizePatch, patchStructureKey, topoOrder, resolveKeyLinks, PATCH_IN, PATCH_OUT } from '../core/patch.js';

const TC = 0.012;

function smooth(param, value, ctx, immediate) {
  if (!isFinite(value)) return;
  if (immediate) { param.cancelScheduledValues(0); param.value = value; } else param.setTargetAtTime(value, ctx.currentTime, TC);
}

/** Hand an automated AudioParam back to its static value (click-free). */
function release(param, value, ctx) {
  if (!isFinite(value)) return;
  const t = ctx.currentTime;
  if (typeof param.cancelAndHoldAtTime === 'function') { try { param.cancelAndHoldAtTime(t); } catch { param.cancelScheduledValues(t); } }
  else param.cancelScheduledValues(t);
  param.setTargetAtTime(value, t, TC);
}

/** ParamDef of a (possibly nested 'pads.<pad>.<key>') param key in an instrument / effect def. */
function paramDefOf(defs, key) {
  if (!defs) return null;
  if (key.startsWith('pads.')) { const k = key.slice(key.indexOf('.', 5) + 1); return defs.padParams?.find((d) => d.key === k) || null; }
  return defs.params?.find((d) => d.key === key) || null;
}

/**
 * def with automation overrides merged in (def unchanged when ov is empty). ov holds lane numbers:
 * enum / bool params are decoded (option index / 0|1), nested keys are written into copies and the
 * effect on/bypass lane (FX_ENABLE_KEY) sets def.enabled. defs: INSTRUMENT_DEFS[type] | EFFECT_DEFS[type].
 */
function withParams(def, ov, defs) {
  if (!def || !ov) return def;
  const dec = {};
  let en;
  for (const [k, v] of Object.entries(ov)) {
    if (k === FX_ENABLE_KEY) { en = v >= 0.5; continue; }
    dec[k] = decodeParam(paramDefOf(defs, k), v);
  }
  const out = { ...def, params: mergeParamOverrides(def.params, dec) };
  if (en !== undefined) out.enabled = en;
  return out;
}

/** Did an override map change enough to be worth an update()? (tiny relative epsilon) */
function changed(a, b, defs) {
  if (!a || !b) return a !== b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (x === undefined || y === undefined) return true;
    const d = defs?.find((p) => p.key === k);
    const range = d && isFinite(d.max - d.min) ? Math.abs(d.max - d.min) : Math.max(1, Math.abs(x), Math.abs(y));
    if (Math.abs(x - y) > range * 1e-4) return true;
  }
  return false;
}

/**
 * Note expression fields (see src/gen/expression.js) -> instrument trigger extras:
 * glide (semitones to slide in from) + gt (s), bend (semitones, reached from bendAt × duration), vib (depth in semitones),
 * flam (grace-stroke level, played by Instrument.trigger).
 */
export function noteExtra(ev, durSec) {
  const x = ev.x || {};
  const out = {};
  if (Number.isFinite(x.glide) && x.glide !== 0) { out.glideFrom = ev.pitch + x.glide; out.glideTime = Number.isFinite(x.gt) ? x.gt : 0.07; }
  if (Number.isFinite(x.bend) && x.bend !== 0) {
    const at = Math.min(0.95, Math.max(0, Number.isFinite(x.bendAt) ? x.bendAt : 0.6)) * durSec;
    out.bend = { to: x.bend, at, time: Math.max(0.03, Math.min(0.4, (durSec - at) * 0.8)) };
  }
  if (Number.isFinite(x.vib) && x.vib > 0 && durSec > 0.3) out.vib = { depth: Math.min(1, x.vib), rate: 5.2, delay: Math.min(0.6, Math.max(0.18, durSec * 0.3)) };
  if (Number.isFinite(x.flam) && x.flam > 0) out.flam = Math.min(1, x.flam);
  return out;
}

export class ChannelStrip {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{destination: AudioNode, env: {getBpm, getBeatAt}, onError?: Function, meter?: boolean}} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.env = opts.env;
    this.onError = opts.onError || ((e) => console.error(e));
    this.input = ctx.createGain();
    this.post = ctx.createGain(); // end of the insert section (sidechain key tap)
    this.panner = ctx.createStereoPanner();
    this.volume = ctx.createGain();
    this.muteGain = ctx.createGain();
    this.output = this.muteGain;
    this.panner.connect(this.volume);
    this.volume.connect(this.muteGain);
    if (opts.destination) this.muteGain.connect(opts.destination);
    this.input.connect(this.post);
    this.post.connect(this.panner);
    this.effects = []; // [{ id, type, fx }]
    this.fxKey = '';
    this.patchNodes = []; // split/mix junction GainNodes of the current patch
    this.cables = new Map(); // cableId -> GainNode (plugboard mode)
    this.sends = new Map(); // busId -> GainNode
    this.vals = {};
    this.sendVals = {}; // static send amounts (restored when send automation ends)
    this.fxDefs = new Map(); // fxId -> last static Effect def
    this.fxOv = new Map(); // fxId -> {key: value} automation overrides
    this.auto = { volume: false, pan: false, mute: false, sends: new Set() }; // AudioParams currently driven by automation
    this.cableOv = new Map(); // cableId -> automated gain (plugboard)
    this.peak = { l: 0, r: 0 };
    if (opts.meter !== false) {
      this.splitter = ctx.createChannelSplitter(2);
      this.anL = ctx.createAnalyser();
      this.anR = ctx.createAnalyser();
      this.anL.fftSize = this.anR.fftSize = 1024;
      this.muteGain.connect(this.splitter);
      this.splitter.connect(this.anL, 0);
      this.splitter.connect(this.anR, 1);
      this._buf = new Float32Array(1024);
    }
  }

  /**
   * Diff the insert section: rebuild only when ids/order/types (or, with a plugboard patch, the
   * patch structure: nodes / cables / enabled) change, else update params and cable gains.
   * patch: track.patch (optional) — used when patch.enabled.
   */
  setFx(list = [], patch = null) {
    const sp = patch && patch.enabled ? sanitizePatch(patch, list) : null;
    const key = list.map((f) => `${f.id}:${f.type}`).join('|') + (sp ? '#' + patchStructureKey(sp) : '');
    if (key !== this.fxKey) {
      this.fxKey = key;
      const old = new Map(this.effects.map((e) => [e.id, e]));
      let defs = list;
      if (sp) {
        // only effects placed on the board exist in the audio graph; order = patch topology
        const placed = new Map(sp.nodes.filter((n) => n.kind === 'fx').map((n) => [n.fxId, n]));
        const order = topoOrder(sp).map((id) => sp.nodes.find((n) => n.id === id)?.fxId).filter(Boolean);
        const byId = new Map(list.map((f) => [f.id, f]));
        defs = order.filter((id) => placed.has(id) && byId.has(id)).map((id) => byId.get(id));
      }
      const next = [];
      for (const def of defs) {
        let e = old.get(def.id);
        if (e && e.type === def.type) {
          old.delete(def.id);
        } else {
          try {
            e = { id: def.id, type: def.type, fx: createEffect(this.ctx, def, this.env) };
          } catch (err) {
            this.onError(err);
            continue;
          }
        }
        next.push(e);
      }
      for (const e of old.values()) e.fx.dispose();
      // tear down the previous wiring (post keeps its own outputs: panner + key taps)
      try { this.input.disconnect(); } catch { /* */ }
      for (const e of next) { try { e.fx.output.disconnect(); } catch { /* */ } }
      for (const g of [...this.patchNodes, ...this.cables.values()]) { try { g.disconnect(); } catch { /* */ } }
      this.patchNodes = [];
      this.cables = new Map();
      this.cableOv.clear(); // fresh cable GainNodes start at their static gain
      if (!sp) {
        let prev = this.input;
        for (const e of next) { prev.connect(e.fx.input); prev = e.fx.output; }
        prev.connect(this.post);
      } else {
        this._wirePatch(sp, next);
      }
      this.effects = next;
    }
    if (sp) {
      for (const c of sp.cables) {
        const g = this.cables.get(c.id);
        if (g && g._v !== c.gain) { g._v = c.gain; if (!this.cableOv.has(c.id)) smooth(g.gain, c.gain, this.ctx, false); }
      }
    }
    const byId = new Map(list.map((f) => [f.id, f]));
    this.fxDefs = byId;
    for (const e of this.effects) {
      try { e.fx.update(withParams(byId.get(e.id), this.fxOv.get(e.id), EFFECT_DEFS[e.type])); } catch (err) { this.onError(err); }
    }
  }

  /** Build the plugboard graph (sp = sanitizePatch result, effects = instances on the board). */
  _wirePatch(sp, effects) {
    const fxOf = new Map(effects.map((e) => [e.id, e.fx]));
    const outs = new Map([[PATCH_IN, this.input]]);
    const ins = new Map([[PATCH_OUT + ':0', this.post]]);
    for (const n of sp.nodes) {
      if (n.kind === 'fx') {
        const fx = fxOf.get(n.fxId);
        if (!fx) continue;
        outs.set(n.id, fx.output);
        ins.set(n.id + ':0', fx.input);
        if (fx.keyInput) ins.set(n.id + ':1', fx.keyInput);
      } else {
        const g = this.ctx.createGain();
        this.patchNodes.push(g);
        outs.set(n.id, g);
        ins.set(n.id + ':0', g);
      }
    }
    for (const c of sp.cables) {
      const src = outs.get(c.from.node);
      const dst = ins.get(`${c.to.node}:${c.to.port}`);
      if (!src || !dst) continue;
      const g = this.ctx.createGain();
      g.gain.value = c.gain;
      g._v = c.gain;
      src.connect(g);
      g.connect(dst);
      this.cables.set(c.id, g);
    }
  }

  /** Automation overrides for insert fx: map {fxId: {key: value}} | null (null = back to static). */
  setFxOverrides(map, immediate = false) {
    for (const e of this.effects) {
      const ov = map?.[e.id] || null;
      const cur = this.fxOv.get(e.id) || null;
      if (!changed(cur, ov, EFFECT_DEFS[e.type]?.params)) continue;
      if (ov) this.fxOv.set(e.id, ov); else this.fxOv.delete(e.id);
      const def = this.fxDefs.get(e.id);
      if (!def) continue;
      try { e.fx.update(withParams(def, ov, EFFECT_DEFS[e.type]), immediate); } catch (err) { this.onError(err); }
    }
    for (const id of [...this.fxOv.keys()]) if (!this.effects.some((e) => e.id === id)) this.fxOv.delete(id);
  }

  /** Automation overrides for plugboard cable gains: {cableId: gain} | null (null = back to static). */
  setCableOverrides(map) {
    for (const [id, g] of this.cables) {
      const v = map?.[id];
      if (v != null && isFinite(v)) {
        const c = Math.max(0, Math.min(2, v));
        if (this.cableOv.get(id) !== c) { this.cableOv.set(id, c); smooth(g.gain, c, this.ctx, false); }
      } else if (this.cableOv.has(id)) {
        this.cableOv.delete(id);
        smooth(g.gain, g._v ?? 1, this.ctx, false);
      }
    }
    for (const id of [...this.cableOv.keys()]) if (!this.cables.has(id)) this.cableOv.delete(id);
  }

  /**
   * Schedule mixer automation (volume / pan / sends) for the beat window [b0, b1) that sounds
   * from ctx time t0. lanes: { volume?, pan?, sends?: {busId: lane} } (lane = AutomationLane).
   * jump: 'seek' (discontinuity: cancel what was scheduled ahead) | 'wrap' (loop wrap) | null.
   */
  automate(lanes, b0, b1, t0, spb, jump, busStrips) {
    const ramp = (param, lane, active, clampFn) => {
      const v0 = clampFn(valueAt(lane.points, b0));
      if (!active || jump === 'seek') {
        if (typeof param.cancelAndHoldAtTime === 'function') { try { param.cancelAndHoldAtTime(t0); } catch { param.cancelScheduledValues(t0); } }
        else param.cancelScheduledValues(t0);
        param.setValueAtTime(v0, t0);
      } else if (jump === 'wrap') {
        param.setValueAtTime(v0, t0);
      }
      for (const seg of segmentsInWindow(lane.points, b0, b1)) {
        param.linearRampToValueAtTime(clampFn(seg.value), t0 + (seg.beat - b0) * spb);
      }
    };
    const vol = (x) => Math.max(0, Math.min(4, x));
    const pan = (x) => Math.max(-1, Math.min(1, x));
    const amt = (x) => Math.max(0, Math.min(1, x));
    if (lanes.volume) { ramp(this.volume.gain, lanes.volume, this.auto.volume, vol); this.auto.volume = true; }
    else if (this.auto.volume) { this.auto.volume = false; release(this.volume.gain, this.vals.volume ?? 0.8, this.ctx); }
    if (lanes.pan) { ramp(this.panner.pan, lanes.pan, this.auto.pan, pan); this.auto.pan = true; }
    else if (this.auto.pan) { this.auto.pan = false; release(this.panner.pan, pan(this.vals.pan ?? 0), this.ctx); }
    // mute lanes are step lanes (value >= 0.5 = muted) driving the mute gain
    if (lanes.mute) { ramp(this.muteGain.gain, lanes.mute, this.auto.mute, (x) => (x >= 0.5 ? 0 : 1)); this.auto.mute = true; }
    else if (this.auto.mute) { this.auto.mute = false; release(this.muteGain.gain, this.vals.muted ? 0 : 1, this.ctx); }
    const sends = lanes.sends || {};
    for (const [busId, lane] of Object.entries(sends)) {
      const g = this._ensureSend(busId, busStrips);
      if (!g) continue;
      ramp(g.gain, lane, this.auto.sends.has(busId), amt);
      this.auto.sends.add(busId);
    }
    for (const busId of [...this.auto.sends]) {
      if (sends[busId]) continue;
      this.auto.sends.delete(busId);
      const g = this.sends.get(busId);
      const stat = this.sendVals[busId] || 0;
      if (g) {
        release(g.gain, Math.min(1, stat), this.ctx);
        if (!(stat > 0)) this.setSends(this.sendVals, busStrips);
      }
    }
  }

  /** Stop all automation on this strip: restore the static values. */
  endAutomation(busStrips) {
    if (this.auto.volume || this.auto.pan || this.auto.mute || this.auto.sends.size) this.automate({}, 0, 0, 0, 0, null, busStrips);
    if (this.fxOv.size) this.setFxOverrides(null);
    if (this.cableOv.size) this.setCableOverrides(null);
  }

  _ensureSend(busId, busStrips) {
    const bus = busStrips?.get(busId);
    if (!bus) return null;
    let g = this.sends.get(busId);
    if (!g) {
      g = this.ctx.createGain();
      g.gain.value = 0;
      this.muteGain.connect(g);
      g.connect(bus.input);
      this.sends.set(busId, g);
    }
    return g;
  }

  /** volume (linear), pan (-1..1), muted (bool). */
  setMix({ volume = 0.8, pan = 0, muted = false }, immediate = false) {
    const v = this.vals;
    if (v.volume !== volume) { v.volume = volume; if (!this.auto.volume) smooth(this.volume.gain, volume, this.ctx, immediate); }
    if (v.pan !== pan) { v.pan = pan; if (!this.auto.pan) smooth(this.panner.pan, Math.max(-1, Math.min(1, pan)), this.ctx, immediate); }
    if (v.muted !== muted) { v.muted = muted; if (!this.auto.mute) smooth(this.muteGain.gain, muted ? 0 : 1, this.ctx, immediate); }
  }

  /** sends: {busId: 0..1}; busStrips: Map(busId -> ChannelStrip). Post-fader, post-mute. */
  setSends(sends = {}, busStrips, immediate = false) {
    this.sendVals = { ...sends };
    for (const [busId, g] of this.sends) {
      if (!busStrips.has(busId) || (!(sends[busId] > 0) && !this.auto.sends.has(busId))) {
        try { g.disconnect(); this.muteGain.disconnect(g); } catch { /* */ }
        this.sends.delete(busId);
      }
    }
    for (const [busId, amt] of Object.entries(sends)) {
      const bus = busStrips.get(busId);
      if (!bus || !(amt > 0)) continue;
      let g = this.sends.get(busId);
      if (!g) {
        g = this.ctx.createGain();
        g.gain.value = 0;
        this.muteGain.connect(g);
        g.connect(bus.input);
        this.sends.set(busId, g);
      }
      if (!this.auto.sends.has(busId)) smooth(g.gain, Math.min(1, amt), this.ctx, immediate);
    }
  }

  setTempo(bpm) { for (const e of this.effects) e.fx.setTempo(bpm); }
  syncLfos(time) { for (const e of this.effects) e.fx.sync(time); }
  getReduction(fxId) { const e = this.effects.find((x) => x.id === fxId); return e?.fx.getReduction ? e.fx.getReduction() : 0; }

  /** Peak level per channel since the last call (with decay for smooth meters). */
  getMeter() {
    if (!this.anL) return { l: 0, r: 0 };
    const peakOf = (an) => {
      an.getFloatTimeDomainData(this._buf);
      let m = 0;
      for (let i = 0; i < this._buf.length; i++) { const a = Math.abs(this._buf[i]); if (a > m) m = a; }
      return m;
    };
    const l = peakOf(this.anL);
    const r = peakOf(this.anR);
    this.peak.l = Math.max(l, this.peak.l * 0.82);
    this.peak.r = Math.max(r, this.peak.r * 0.82);
    return { l: this.peak.l, r: this.peak.r };
  }

  dispose() {
    for (const e of this.effects) e.fx.dispose();
    this.effects = [];
    for (const n of [this.input, this.post, this.panner, this.volume, this.muteGain, this.splitter, ...this.sends.values(), ...this.patchNodes, ...this.cables.values()]) {
      try { n?.disconnect(); } catch { /* */ }
    }
    this.sends.clear();
  }
}

/**
 * The whole mixer + instruments for one AudioContext (realtime or offline).
 * opts: { destination, getBpm, getBeatAt, getSampleBuffer, getSampleByName, onError, meters=true }
 */
export class MixGraph {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.o = opts;
    this.onError = opts.onError || ((e) => console.error(e));
    this.env = { getBpm: opts.getBpm, getBeatAt: opts.getBeatAt };
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.out = ctx.createGain(); // post master volume
    this.out.connect(this.analyser);
    this.out.connect(opts.destination);
    this.master = new ChannelStrip(ctx, { destination: this.out, env: this.env, onError: this.onError, meter: opts.meters !== false });
    this.clickOut = ctx.createGain();
    this.clickOut.connect(this.out);
    this.buses = new Map(); // id -> ChannelStrip
    this.tracks = new Map(); // id -> { strip, type, instrument, instType, instJson, code }
    this.sources = new Set(); // playing audio-clip sources
    this.bpm = null;
    this.firstSync = true;
  }

  sync(project) {
    const im = this.firstSync;
    this.firstSync = false;
    if (this.bpm !== project.bpm) {
      const changed = this.bpm != null;
      this.bpm = project.bpm;
      if (changed) this.setTempo(project.bpm);
    }
    // master
    this.master.setFx(project.master?.fx || []);
    this.master.setMix({ volume: project.master?.volume ?? 0.9, pan: 0, muted: false }, im);
    // buses
    const busIds = new Set();
    for (const bus of project.buses || []) {
      busIds.add(bus.id);
      let s = this.buses.get(bus.id);
      if (!s) {
        s = new ChannelStrip(this.ctx, { destination: this.master.input, env: this.env, onError: this.onError, meter: this.o.meters !== false });
        this.buses.set(bus.id, s);
      }
      s.setFx(bus.fx || []);
      s.setMix({ volume: bus.volume ?? 0.8, pan: bus.pan || 0, muted: !!bus.mute }, im);
    }
    for (const [id, s] of this.buses) if (!busIds.has(id)) { s.dispose(); this.buses.delete(id); }
    // tracks
    const trackIds = new Set();
    for (const track of project.tracks) {
      trackIds.add(track.id);
      let e = this.tracks.get(track.id);
      if (!e) {
        e = {
          strip: new ChannelStrip(this.ctx, { destination: this.master.input, env: this.env, onError: this.onError, meter: this.o.meters !== false }),
          type: track.type, instrument: null, instType: null, instJson: null, code: null,
        };
        this.tracks.set(track.id, e);
      }
      if (e.type !== track.type) { this._disposeSources(e); e.type = track.type; }
      e.strip.setFx(track.fx || [], track.patch);
      e.strip.setMix({ volume: track.volume ?? 0.8, pan: track.pan || 0, muted: !isTrackAudible(project, track) }, im);
      e.strip.setSends(track.sends || {}, this.buses, im);
      this._syncSource(e, track);
    }
    for (const [id, e] of this.tracks) {
      if (!trackIds.has(id)) { this._disposeSources(e); e.strip.dispose(); this.tracks.delete(id); }
    }
    this._syncKeys(project);
  }

  /**
   * Sidechain keys: connect each ducker's key input to its source track's `post` tap
   * (see resolveKeyLinks: self-keying, missing tracks and track↔track loops are skipped).
   */
  _syncKeys(project) {
    const links = resolveKeyLinks(project);
    const want = new Map(); // fxId -> { keyIn, src }
    if (links.size) {
      for (const s of this._strips()) {
        for (const e of s.effects) {
          const srcId = links.get(e.id);
          const keyIn = e.fx.keyInput;
          if (!srcId || !keyIn) continue;
          const src = this.tracks.get(srcId)?.strip;
          if (src && src !== s) want.set(e.id, { keyIn, src: src.post });
        }
      }
    }
    this.keyLinks ||= new Map();
    for (const [id, l] of this.keyLinks) {
      const w = want.get(id);
      if (w && w.keyIn === l.keyIn && w.src === l.src) continue;
      try { l.src.disconnect(l.keyIn); } catch { /* already gone */ }
      this.keyLinks.delete(id);
    }
    for (const [id, w] of want) {
      if (this.keyLinks.has(id)) continue;
      try { w.src.connect(w.keyIn); this.keyLinks.set(id, w); } catch (err) { this.onError(err); }
    }
  }

  _syncSource(e, track) {
    if (track.type === 'instrument' && track.instrument) {
      const def = track.instrument;
      if (!e.instrument || e.instType !== def.type) {
        this._disposeSources(e);
        try {
          e.instrument = createInstrument(this.ctx, e.strip.input, def, {
            getSampleBuffer: this.o.getSampleBuffer, getBpm: this.o.getBpm,
          });
          e.instType = def.type;
          e.instJson = JSON.stringify(def);
          e.instOv = null;
        } catch (err) {
          e.instrument = null;
          e.instType = null;
          this.onError(err);
        }
      } else {
        const json = JSON.stringify(def);
        if (json !== e.instJson) {
          e.instJson = json;
          try { e.instrument.update(withParams(def, e.instOv, INSTRUMENT_DEFS[e.instrument.type || def.type])); } catch (err) { this.onError(err); }
        }
      }
    } else if (track.type === 'code') {
      // sound engine: 'strudel' (default — superdough, Strudel's own) or 'daw3' (CodeInstrument)
      const kind = codeSoundOf(track, this.o.codeSound);
      if (e.code && e.codeKind !== kind) this._disposeSources(e);
      const Ctor = codeInstrumentModule.CodeInstrument || codeInstrumentModule.default;
      const daw3 = () => new Ctor(this.ctx, e.strip.input, {
        getSampleBuffer: this.o.getSampleBuffer, getSampleByName: this.o.getSampleByName, getBpm: this.o.getBpm,
      });
      if (!e.code) {
        e.codeKind = kind;
        try {
          // (if the Strudel engine can't load, the StrudelInstrument plays through a CodeInstrument)
          e.code = kind === 'strudel' ? new StrudelInstrument(this.ctx, e.strip.input, { onError: this.onError, fallback: daw3 }) : daw3();
        } catch (err) {
          this.onError(err);
        }
      }
    } else if (e.instrument || e.code) {
      this._disposeSources(e);
    }
  }

  _disposeSources(e) {
    for (const k of ['instrument', 'code']) {
      if (!e[k]) continue;
      try { e[k].allNotesOff?.(); } catch { /* */ }
      try { e[k].dispose?.(); } catch { /* */ }
      e[k] = null;
    }
    e.instType = null;
    e.instJson = null;
  }

  // ---------------------------------------------------------------- automation
  /** Mixer lanes of an automation owner (track, bus or master) grouped by target. */
  static mixerLanes(owner, allowSends = true, allowMute = true) {
    const out = {};
    for (const l of activeLanes(owner)) {
      const t = parseTarget(l.target);
      if (t.kind === 'volume') out.volume ||= l;
      else if (t.kind === 'pan') out.pan ||= l;
      else if (t.kind === 'mute' && allowMute) out.mute ||= l;
      else if (t.kind === 'send' && allowSends) { out.sends ||= {}; out.sends[t.busId] ||= l; }
    }
    return out;
  }

  /**
   * Schedule volume/pan/send automation (AudioParam ramps) for the beat window [b0, b1) that
   * starts sounding at ctx time t0. jump: 'seek' | 'wrap' | null (see ChannelStrip.automate).
   */
  automateMixer(project, b0, b1, t0, spb, jump) {
    if (!(b1 > b0)) return;
    try { this.master.automate(MixGraph.mixerLanes(project.master, false, false), b0, b1, t0, spb, jump, this.buses); } catch (err) { this.onError(err); }
    for (const bus of project.buses || []) {
      const s = this.buses.get(bus.id);
      if (!s) continue;
      try { s.automate(MixGraph.mixerLanes(bus, false), b0, b1, t0, spb, jump, this.buses); } catch (err) { this.onError(err); }
    }
    const anySolo = project.tracks.some((t) => t.solo);
    for (const track of project.tracks) {
      const e = this.tracks.get(track.id);
      if (!e) continue;
      // a track silenced by another track's solo stays silent whatever its mute lane says
      try { e.strip.automate(MixGraph.mixerLanes(track, true, !(anySolo && !track.solo)), b0, b1, t0, spb, jump, this.buses); } catch (err) { this.onError(err); }
    }
  }

  /**
   * Control-rate automation (instrument / effect params) evaluated at `beat`.
   * which: { inst = true, fx = true } — lets the realtime engine evaluate them at different beats.
   */
  applyControl(project, beat, { inst = true, fx = true, immediate = false } = {}) {
    for (const track of project.tracks) {
      const e = this.tracks.get(track.id);
      if (!e) continue;
      const ov = controlOverrides(track, beat);
      if (fx) { e.strip.setFxOverrides(ov.fx, immediate); e.strip.setCableOverrides(cableOverrides(track, beat)); }
      if (inst && e.instrument && track.instrument) {
        const type = e.instrument.type || resolveInstrument(track.instrument).type;
        if (changed(e.instOv || null, ov.inst, INSTRUMENT_DEFS[type]?.params)) {
          e.instOv = ov.inst;
          try { e.instrument.update(withParams(track.instrument, ov.inst, INSTRUMENT_DEFS[type])); } catch (err) { this.onError(err); }
        }
      }
    }
    if (fx) {
      // bus / master insert effects
      try { this.master.setFxOverrides(controlOverrides(project.master, beat).fx, immediate); } catch (err) { this.onError(err); }
      for (const bus of project.buses || []) {
        const s = this.buses.get(bus.id);
        if (s) { try { s.setFxOverrides(controlOverrides(bus, beat).fx, immediate); } catch (err) { this.onError(err); } }
      }
    }
  }

  /** Leave automation: every automated value goes back to the project's static value. */
  endAutomation(project) {
    this.master.endAutomation(this.buses);
    for (const s of this.buses.values()) s.endAutomation(this.buses);
    for (const [id, e] of this.tracks) {
      e.strip.endAutomation(this.buses);
      if (e.instOv) {
        e.instOv = null;
        const track = project?.tracks.find((t) => t.id === id);
        if (e.instrument && track?.instrument) { try { e.instrument.update(track.instrument); } catch (err) { this.onError(err); } }
      }
    }
  }

  /** The Strudel-engine code instruments of this graph (see strudel-instrument.js). */
  strudelInstruments() {
    const out = [];
    for (const e of this.tracks.values()) {
      if (e.code instanceof StrudelInstrument) out.push(e.code);
      // 'strudel' instrument tracks (src/audio/strudel-voice.js)
      const sdi = e.instrument?.engine?.sdi;
      if (sdi instanceof StrudelInstrument) out.push(sdi);
    }
    return out;
  }

  /** Instrument for live play (null for audio/code tracks). */
  getInstrument(trackId) { return this.tracks.get(trackId)?.instrument || null; }

  /** Play a collected event (see scheduler.collectEvents) at ctx time `time`. */
  playEvent(ev, time, spb) {
    if (ev.type === 'click') { scheduleClick(this.ctx, this.clickOut, time, ev.accent); return; }
    const e = this.tracks.get(ev.trackId);
    if (!e) return;
    if (ev.type === 'note') {
      const durSec = Math.max(0.005, ev.dur * spb);
      e.instrument?.trigger(time, ev.pitch, ev.vel, durSec, ev.x ? noteExtra(ev, durSec) : undefined);
    } else if (ev.type === 'code') {
      e.code?.trigger(time, ev.value, Math.max(0.005, ev.dur * spb), ev);
    } else if (ev.type === 'audio') {
      this._playAudioClip(e, ev, time, spb);
    }
  }

  _playAudioClip(e, ev, time, spb) {
    const clip = ev.clip;
    const buffer = this.o.getSampleBuffer(clip.sampleId);
    if (!buffer) return;
    const offSec = Math.max(0, ((clip.offset || 0) + ev.offset) * spb);
    if (offSec >= buffer.duration) return;
    const dur = Math.min(ev.dur * spb, buffer.duration - offSec);
    if (dur <= 0.002) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    const gain = clip.gain ?? 1;
    const fade = Math.min(0.004, dur / 4);
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gain, time + fade);
    g.gain.setValueAtTime(gain, time + dur - fade);
    g.gain.linearRampToValueAtTime(0, time + dur);
    src.connect(g);
    g.connect(e.strip.input);
    src.start(time, offSec, dur + 0.001);
    const rec = { src, g };
    this.sources.add(rec);
    src.onended = () => { this.sources.delete(rec); try { g.disconnect(); } catch { /* */ } };
  }

  /** Stop everything that is sounding (transport stop / seek). */
  allNotesOff(time) {
    const t = time ?? this.ctx.currentTime;
    for (const e of this.tracks.values()) {
      try { e.instrument?.allNotesOff(t); } catch (err) { this.onError(err); }
      try { e.code?.allNotesOff(t); } catch (err) { this.onError(err); }
    }
    for (const rec of this.sources) {
      try {
        rec.g.gain.cancelScheduledValues(t);
        rec.g.gain.setTargetAtTime(0, t, 0.008);
        rec.src.stop(t + 0.05);
      } catch { /* */ }
    }
  }

  setTempo(bpm) {
    this.bpm = bpm;
    for (const s of this._strips()) s.setTempo(bpm);
  }

  syncLfos(time) { for (const s of this._strips()) s.syncLfos(time); }

  * _strips() {
    yield this.master;
    yield* this.buses.values();
    for (const e of this.tracks.values()) yield e.strip;
  }

  getMeter(id) {
    if (id === 'master') return this.master.getMeter();
    const s = this.tracks.get(id)?.strip || this.buses.get(id);
    return s ? s.getMeter() : { l: 0, r: 0 };
  }

  /** Gain reduction (dB, <= 0) of a compressor/limiter effect anywhere in the graph. */
  getReduction(fxId) {
    for (const s of this._strips()) {
      if (s.effects.some((e) => e.id === fxId)) return s.getReduction(fxId);
    }
    return 0;
  }

  dispose() {
    for (const e of this.tracks.values()) { this._disposeSources(e); e.strip.dispose(); }
    for (const s of this.buses.values()) s.dispose();
    this.master.dispose();
    this.tracks.clear();
    this.buses.clear();
    for (const rec of this.sources) { try { rec.src.stop(); } catch { /* */ } }
    this.sources.clear();
    try { this.out.disconnect(); this.clickOut.disconnect(); } catch { /* */ }
  }
}

/**
 * Sound engine of a code track: track.codeSound 'strudel' (default) | 'daw3'. `force` (MixGraph option
 * codeSound) overrides it, e.g. 'daw3' for exports when superdough can't render offline.
 */
export function codeSoundOf(track, force) {
  if (force === 'daw3' || force === 'strudel') return force;
  return track?.codeSound === 'daw3' ? 'daw3' : 'strudel';
}
