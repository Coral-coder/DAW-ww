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
// Pro mixer (core/mixer-model.js): input -> trim/phase -> inserts -> post -> [width M/S] -> preFader -> pan -> volume
//               -> vca -> mute -> direct -> output (master or a bus: folder sum / custom routing). Pre-fader sends and
//               PFL tap `preFader` (sends through a mute-following gain); AFL taps after the VCA. Meters tap after the
//               mute through a PDC delay so they line up with what reaches the master. VCA gain = product of the
//               member's VCAs (automation lanes become ramps on the vca node: they multiply with fader automation).
// Bus strip:    input -> fx -> pan -> volume -> mute -> master input
// Master:       input -> fx -> volume -> analyser -> destination  (metronome joins after master fx)
// PDC:          (see latency.js) every strip reports its insert (+ instrument) latency; MixGraph.updatePdc()
//               puts compensation DelayNodes on the track -> master links and on each send link so all routes
//               reach the master input together. `graph.latency` (seconds) is the resulting overall delay:
//               the realtime scheduler pre-rolls events by it, the offline renderer trims it off the head.
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
import { computePdc, faderOffsets, alignInserts } from './latency.js';
import { needsShapedEnvelope, envelopePoints } from '../record/clips.js';
import { frozenMode, bypassesInserts, bypassesFader, frozenLaneFilter } from '../core/freeze.js';
import { spanOf } from '../time/tempo-map.js';
import { WarpPlayer, needsWarpPlayer, unwarpedInSeconds } from './warp/player.js';
import { MasterAnalysis } from './meters.js';
import { inputGain, widthMatrix, vcaGainFor, vcaCombinedLane, soloState, sendTap, outputOf } from '../core/mixer-model.js';

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

/**
 * A connection src -> dst that can carry a compensation delay. The DelayNode is only created once a delay
 * is needed (most links never get one) and kept afterwards (set to 0) to avoid rewiring clicks.
 */
export class DelayLink {
  constructor(ctx, src, dst) {
    this.ctx = ctx;
    this.src = src;
    this.dst = dst;
    this.node = null;
    this.sec = 0;
    src.connect(dst);
  }
  set(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (sec === this.sec) return;
    this.sec = sec;
    if (sec > 0 && (!this.node || sec > this.node._max)) {
      const max = Math.max(0.5, sec * 2);
      const n = this.ctx.createDelay(max);
      n._max = max;
      n.delayTime.value = sec;
      n.connect(this.dst);
      if (this.node) { try { this.src.disconnect(this.node); } catch { /* */ } try { this.node.disconnect(); } catch { /* */ } }
      else { try { this.src.disconnect(this.dst); } catch { /* */ } }
      this.src.connect(n);
      this.node = n;
    } else if (this.node) {
      this.node.delayTime.value = sec;
    }
  }
  dispose() {
    try { this.src.disconnect(this.node || this.dst); } catch { /* */ }
    try { this.node?.disconnect(); } catch { /* */ }
    this.node = null;
  }
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
    this.inStage = ctx.createGain(); // input trim × polarity (head of the insert section)
    this.post = ctx.createGain(); // end of the insert section (sidechain key tap)
    this.preFader = ctx.createGain(); // after the width stage: pre-fader sends / PFL
    this.panner = ctx.createStereoPanner();
    this.volume = ctx.createGain();
    this.vcaGain = ctx.createGain(); // VCA faders (no audio passes through a VCA: it scales its members here)
    this.muteGain = ctx.createGain();
    this.direct = ctx.createGain(); // main out on/off (stems of a bus keep the sends only)
    this.output = this.muteGain;
    this.preFader.connect(this.panner);
    this.panner.connect(this.volume);
    this.volume.connect(this.vcaGain);
    this.vcaGain.connect(this.muteGain);
    this.muteGain.connect(this.direct);
    this.outDest = opts.destination || null;
    this.outLink = opts.destination ? new DelayLink(ctx, this.direct, opts.destination) : null; // PDC on the main output
    this.preMute = null; // pre-fader send tap (created with the first pre-fader send)
    this.sendTaps = {}; // busId -> 'pre' | 'post'
    this.width = null; // lazily built M/S stage
    this.widthVal = 1;
    this.cueLink = null; // {tap, node, src}
    this.sendLinks = new Map(); // busId -> DelayLink (send gain -> bus input, PDC per send)
    this.sendComp = {}; // busId -> compensation (s)
    this.onLatency = opts.onLatency || null; // called when an effect reports a new latency (plugins, once loaded)
    this.input.connect(this.inStage);
    this.inStage.connect(this.post);
    this.post.connect(this.preFader);
    this.effects = []; // [{ id, type, fx }]
    this.fxKey = '';
    this.patchNodes = []; // split/mix junction GainNodes of the current patch
    this.cables = new Map(); // cableId -> GainNode (plugboard mode)
    this.links = new Map(); // cableId ('s:<fxId>' / 's:out' in serial mode) -> DelayLink (branch / key alignment)
    this.keyArrive = {}; // fxId -> s after the strip input at which its external sidechain key arrives (MixGraph)
    this.sends = new Map(); // busId -> GainNode
    this.vals = {};
    this.sendVals = {}; // static send amounts (restored when send automation ends)
    this.fxDefs = new Map(); // fxId -> last static Effect def
    this.fxOv = new Map(); // fxId -> {key: value} automation overrides
    this.auto = { volume: false, pan: false, mute: false, vca: false, sends: new Set() }; // AudioParams currently driven by automation
    this.cableOv = new Map(); // cableId -> automated gain (plugboard)
    this.peak = { l: 0, r: 0 };
    this.rms = { l: 0, r: 0 };
    if (opts.meter !== false) {
      this.splitter = ctx.createChannelSplitter(2);
      this.anL = ctx.createAnalyser();
      this.anR = ctx.createAnalyser();
      this.anL.fftSize = this.anR.fftSize = 2048; // > one 30 fps frame: meter ballistics (dsp/ballistics.js) see every sample
      // PDC-aware: the meter hears the strip when its signal reaches the master (same compensation as the out link)
      this.meterDelay = ctx.createDelay(1);
      this.muteGain.connect(this.meterDelay);
      this.meterDelay.connect(this.splitter);
      this.splitter.connect(this.anL, 0);
      this.splitter.connect(this.anR, 1);
      this._buf = new Float32Array(2048);
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
            const ent = { id: def.id, type: def.type, heard: 0 };
            // tempo-synced LFOs: the audio passing this effect at ctx time t is HEARD at t + ent.heard (PDC)
            const env = { ...this.env, getBeatAt: (t) => this.env.getBeatAt?.(t + ent.heard) ?? null };
            ent.fx = (this.env.createEffect || createEffect)(this.ctx, def, env);
            e = ent;
            const fx = e.fx;
            if (fx.ready && typeof fx.ready.then === 'function') fx.ready.then(() => { if (fx.refreshLatency?.()) this.onLatency?.(); }, () => {});
          } catch (err) {
            this.onError(err);
            continue;
          }
        }
        next.push(e);
      }
      for (const e of old.values()) e.fx.dispose();
      // tear down the previous wiring (post keeps its own outputs: panner + key taps)
      try { this.inStage.disconnect(); } catch { /* */ }
      for (const e of next) { try { e.fx.output.disconnect(); } catch { /* */ } }
      for (const g of [...this.patchNodes, ...this.cables.values()]) { try { g.disconnect(); } catch { /* */ } }
      for (const l of this.links.values()) { try { l.node?.disconnect(); } catch { /* */ } }
      this.links = new Map();
      this.patchNodes = [];
      this.cables = new Map();
      this.cableOv.clear(); // fresh cable GainNodes start at their static gain
      if (!sp) {
        let prev = this.inStage;
        for (const e of next) { this.links.set('s:' + e.id, new DelayLink(this.ctx, prev, e.fx.input)); prev = e.fx.output; }
        this.links.set('s:out', new DelayLink(this.ctx, prev, this.post));
      } else {
        this._wirePatch(sp, next);
      }
      this.effects = next;
      this._sp = sp;
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
    const outs = new Map([[PATCH_IN, this.inStage]]);
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
      this.links.set(c.id, new DelayLink(this.ctx, g, dst)); // (delayed when its branch must wait: alignment())
      this.cables.set(c.id, g);
    }
  }

  /**
   * The insert section as an alignment graph (latency.js alignInserts): the serial chain (in -> fx… -> out) or the
   * plugboard (port-1 cables = in-board sidechain keys); `keyArrive` = external sidechain keys.
   */
  _alignGraph() {
    const lat = (fx) => { const l = Number(fx?.latency); return Number.isFinite(l) && l > 0 ? l : 0; };
    const sr = this.ctx.sampleRate;
    if (!this._sp) {
      const nodes = this.effects.map((e) => ({ id: e.id, latency: lat(e.fx) }));
      const ids = ['in', ...this.effects.map((e) => e.id), 'out'];
      const cables = ids.slice(1).map((id, i) => ({ id: 's:' + id, from: ids[i], to: id }));
      return { sampleRate: sr, nodes, cables, keys: { ...this.keyArrive }, fxNode: (fxId) => fxId };
    }
    const sp = this._sp;
    const fxOf = new Map(this.effects.map((e) => [e.id, e.fx]));
    const nodeOfFx = new Map();
    const nodes = [];
    for (const n of sp.nodes) {
      if (n.kind === 'fx') { if (!fxOf.has(n.fxId)) continue; nodeOfFx.set(n.fxId, n.id); nodes.push({ id: n.id, latency: lat(fxOf.get(n.fxId)) }); }
      else nodes.push({ id: n.id, latency: 0 });
    }
    const cables = sp.cables.map((c) => ({ id: c.id, from: c.from.node, to: c.to.node, port: c.to.port || 0 }));
    const keys = {};
    for (const [fxId, t] of Object.entries(this.keyArrive)) if (nodeOfFx.has(fxId)) keys[nodeOfFx.get(fxId)] = t;
    return { sampleRate: sr, nodes, cables, keys, fxNode: (fxId) => nodeOfFx.get(fxId) };
  }

  /**
   * Alignment plan of the insert section: { latency (input -> post, s), cable: {cableId: s}, key: {fxId: s} (delay
   * for the external key), at: {fxId: s} (when the effect's aligned inputs arrive, after the strip input) }.
   * Parallel plugboard branches are delayed to the slowest one before they meet; keys meet the audio they key.
   */
  alignment() {
    const g = this._alignGraph();
    const r = alignInserts(g);
    const key = {}, at = {};
    for (const e of this.effects) {
      const nid = g.fxNode(e.id);
      if (nid == null) continue;
      if (nid in r.key) key[e.id] = r.key[nid];
      if (nid in r.arrive) at[e.id] = r.arrive[nid];
    }
    return { latency: r.latency, cable: r.cable, key, at };
  }

  /** Latency (s) of the insert section, input -> post (aligned: the slowest branch / key; see alignment()). */
  get insertLatency() { return this.alignment().latency; }

  /** Put the alignment delays on the cables (MixGraph.updatePdc). -> the plan. */
  applyAlignment(enabled = true) {
    const plan = this.alignment();
    for (const [id, link] of this.links) link.set(enabled ? plan.cable[id] || 0 : 0);
    return plan;
  }

  /** PDC: compensation delays (s) for the main output and per send ({busId: s}). */
  setCompensation(outSec = 0, sends = {}) {
    this.outLink?.set(outSec);
    this.outComp = outSec;
    if (this.meterDelay) this.meterDelay.delayTime.value = Math.min(1, Math.max(0, outSec || 0));
    this.sendComp = { ...sends };
    for (const [busId, link] of this.sendLinks) link.set(sends[busId] || 0);
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
        param.linearRampToValueAtTime(clampFn(seg.value), t0 + spanOf(spb, b0, seg.beat)); // spb: number | TempoMap
      }
    };
    const vol = (x) => Math.max(0, Math.min(4, x));
    const pan = (x) => Math.max(-1, Math.min(1, x));
    const amt = (x) => Math.max(0, Math.min(1, x));
    if (lanes.volume) { ramp(this.volume.gain, lanes.volume, this.auto.volume, vol); this.auto.volume = true; }
    else if (this.auto.volume) { this.auto.volume = false; release(this.volume.gain, this.vals.volume ?? 0.8, this.ctx); }
    if (lanes.vca) { ramp(this.vcaGain.gain, lanes.vca, this.auto.vca, (x) => Math.max(0, Math.min(4, x))); this.auto.vca = true; }
    else if (this.auto.vca) { this.auto.vca = false; release(this.vcaGain.gain, this.vals.vca ?? 1, this.ctx); }
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
    if (this.auto.volume || this.auto.pan || this.auto.mute || this.auto.vca || this.auto.sends.size) this.automate({}, 0, 0, 0, 0, null, busStrips);
    if (this.fxOv.size) this.setFxOverrides(null);
    if (this.cableOv.size) this.setCableOverrides(null);
  }

  _ensureSend(busId, busStrips) {
    const bus = busStrips?.get(busId);
    if (!bus) return null;
    let g = this.sends.get(busId);
    if (g && g._tap !== (this.sendTaps[busId] || 'post')) { this._dropSend(busId); g = null; }
    if (!g) {
      g = this.ctx.createGain();
      g.gain.value = 0;
      g._tap = this.sendTaps[busId] || 'post';
      this._sendSource(g._tap).connect(g);
      const link = new DelayLink(this.ctx, g, bus.input);
      link.set(this.sendComp[busId] || 0);
      this.sendLinks.set(busId, link);
      this.sends.set(busId, g);
      this.onLatency?.(); // a new route: the compensation plan may change
    }
    return g;
  }

  /** Node a send taps: post-fader = after the mute; pre-fader = after the inserts / width through a mute-following gain. */
  _sendSource(tap) {
    if (tap !== 'pre') return this.muteGain;
    if (!this.preMute) {
      this.preMute = this.ctx.createGain();
      this.preMute.gain.value = this.vals.muted ? 0 : 1;
      this.preFader.connect(this.preMute);
    }
    return this.preMute;
  }

  _dropSend(busId) {
    const g = this.sends.get(busId);
    try { (g?._tap === 'pre' ? this.preMute : this.muteGain)?.disconnect(g); } catch { /* */ }
    this.sendLinks.get(busId)?.dispose();
    try { g?.disconnect(); } catch { /* */ }
    this.sendLinks.delete(busId);
    this.sends.delete(busId);
  }

  /** volume (linear), pan (-1..1), muted (bool). */
  setMix({ volume = 0.8, pan = 0, muted = false }, immediate = false) {
    const v = this.vals;
    if (v.volume !== volume) { v.volume = volume; if (!this.auto.volume) smooth(this.volume.gain, volume, this.ctx, immediate); }
    if (v.pan !== pan) { v.pan = pan; if (!this.auto.pan) smooth(this.panner.pan, Math.max(-1, Math.min(1, pan)), this.ctx, immediate); }
    if (v.muted !== muted) { v.muted = muted; if (!this.auto.mute) smooth(this.muteGain.gain, muted ? 0 : 1, this.ctx, immediate); if (this.preMute) smooth(this.preMute.gain, muted ? 0 : 1, this.ctx, immediate); }
  }

  /** Channel extras: input trim (dB) / phase invert, stereo width, VCA gain, main out on/off. */
  setStrip({ trim = 0, phase = false, width = 1, vca = 1, direct = true } = {}, immediate = false) {
    const v = this.vals;
    const ig = inputGain({ trim, phase });
    if (v.inGain !== ig) { v.inGain = ig; smooth(this.inStage.gain, ig, this.ctx, immediate || Math.sign(ig) !== Math.sign(this.inStage.gain.value)); }
    if (v.vca !== vca) { v.vca = vca; if (!this.auto.vca) smooth(this.vcaGain.gain, vca, this.ctx, immediate); }
    const d = direct ? 1 : 0;
    if (v.direct !== d) { v.direct = d; smooth(this.direct.gain, d, this.ctx, immediate); }
    this.setWidth(width, immediate);
  }

  /** Stereo width 0 (mono) … 1 (unchanged) … 2: M/S matrix between `post` and `preFader`, built on first use. */
  setWidth(w = 1, immediate = false) {
    w = Number.isFinite(+w) ? +w : 1;
    if (w === this.widthVal) return;
    this.widthVal = w;
    if (!this.width) {
      if (w === 1) return;
      const ctx = this.ctx;
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const g = { ll: ctx.createGain(), rl: ctx.createGain(), lr: ctx.createGain(), rr: ctx.createGain() };
      split.connect(g.ll, 0); split.connect(g.lr, 0);
      split.connect(g.rl, 1); split.connect(g.rr, 1);
      g.ll.connect(merge, 0, 0); g.rl.connect(merge, 0, 0);
      g.lr.connect(merge, 0, 1); g.rr.connect(merge, 0, 1);
      try { this.post.disconnect(this.preFader); } catch { /* */ }
      this.post.connect(split);
      merge.connect(this.preFader);
      this.width = { split, merge, g };
      immediate = true;
    }
    const m = widthMatrix(w);
    for (const k of ['ll', 'rl', 'lr', 'rr']) smooth(this.width.g[k].gain, m[k], this.ctx, immediate);
  }

  /** Main output destination (master input, or a bus input for folder sums / custom routing). */
  setOutput(dst) {
    if (!dst || dst === this.outDest) return;
    this.outLink?.dispose();
    this.outDest = dst;
    this.outLink = new DelayLink(this.ctx, this.direct, dst);
    this.outLink.set(this.outComp || 0);
    this.onLatency?.();
  }

  /** Cue (AFL / PFL monitor) tap: tap 'pre' | 'post' | null into `cueNode`. */
  setCue(tap, cueNode) {
    const src = tap === 'pre' ? this.preFader : tap === 'post' ? this.vcaGain : null;
    if (this.cueLink && this.cueLink.src === src && this.cueLink.node === cueNode) return;
    if (this.cueLink) { try { this.cueLink.src.disconnect(this.cueLink.node); } catch { /* */ } this.cueLink = null; }
    if (src && cueNode) { src.connect(cueNode); this.cueLink = { src, node: cueNode }; }
  }

  /** sends: {busId: 0..1}; busStrips: Map(busId -> ChannelStrip). Post-fader, post-mute. */
  setSends(sends = {}, busStrips, immediate = false, taps = null) {
    this.sendVals = { ...sends };
    if (taps) this.sendTaps = { ...taps };
    for (const busId of [...this.sends.keys()]) {
      if (!busStrips.has(busId) || (!(sends[busId] > 0) && !this.auto.sends.has(busId))) this._dropSend(busId);
    }
    for (const [busId, amt] of Object.entries(sends)) {
      const bus = busStrips.get(busId);
      if (!bus || !(amt > 0)) continue;
      const g = this._ensureSend(busId, busStrips);
      if (!this.auto.sends.has(busId)) smooth(g.gain, Math.min(1, amt), this.ctx, immediate);
    }
  }

  setTempo(bpm) { for (const e of this.effects) e.fx.setTempo(bpm); }
  syncLfos(time) { for (const e of this.effects) e.fx.sync(time); }
  getReduction(fxId) { const e = this.effects.find((x) => x.id === fxId); return e?.fx.getReduction ? e.fx.getReduction() : 0; }
  getFxProbe(fxId) { return this.effects.find((x) => x.id === fxId)?.fx.probe ?? null; }

  /** Peak level per channel since the last call (with decay for smooth meters). */
  getMeter() {
    if (!this.anL) return { l: 0, r: 0 };
    let sq = 0;
    const peakOf = (an) => {
      an.getFloatTimeDomainData(this._buf);
      let m = 0;
      sq = 0;
      for (let i = 0; i < this._buf.length; i++) { const x = this._buf[i]; const a = Math.abs(x); sq += x * x; if (a > m) m = a; }
      return m;
    };
    const l = peakOf(this.anL);
    const rl = Math.sqrt(sq / this._buf.length);
    const r = peakOf(this.anR);
    const rr = Math.sqrt(sq / this._buf.length);
    this.peak.l = Math.max(l, this.peak.l * 0.82);
    this.peak.r = Math.max(r, this.peak.r * 0.82);
    // RMS: ~300 ms integration (one-pole on the power, read at ~30 fps)
    this.rms.l = Math.sqrt(this.rms.l * this.rms.l * 0.8 + rl * rl * 0.2);
    this.rms.r = Math.sqrt(this.rms.r * this.rms.r * 0.8 + rr * rr * 0.2);
    return { l: this.peak.l, r: this.peak.r, rmsL: this.rms.l, rmsR: this.rms.r, hold: Math.max(l, r) };
  }

  dispose() {
    for (const e of this.effects) e.fx.dispose();
    this.effects = [];
    for (const l of this.sendLinks.values()) l.dispose();
    this.outLink?.dispose();
    if (this.width) { for (const n of [this.width.split, this.width.merge, ...Object.values(this.width.g)]) { try { n.disconnect(); } catch { /* */ } } }
    for (const n of [this.input, this.inStage, this.post, this.preFader, this.panner, this.volume, this.vcaGain, this.muteGain, this.direct, this.preMute, this.meterDelay, this.splitter, ...this.sends.values(), ...this.patchNodes, ...this.cables.values()]) {
      try { n?.disconnect(); } catch { /* */ }
    }
    this.sends.clear();
    this.sendLinks.clear();
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
    this.env = { getBpm: opts.getBpm, getBeatAt: opts.getBeatAt, ...(opts.createEffect ? { createEffect: opts.createEffect } : {}) };
    this.pdc = computePdc({ sampleRate: ctx.sampleRate, tracks: [], buses: [], master: 0 });
    this._onLatency = () => { if (!this._syncing) this.updatePdc(); };
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.out = ctx.createGain(); // post master volume
    this.out.connect(this.analyser);
    // monitor switch: the main mix, or the cue bus while an AFL / PFL solo is active (realtime only)
    this.monitor = ctx.createGain();
    this.out.connect(this.monitor);
    this.monitor.connect(opts.destination);
    this.cue = ctx.createGain();
    this.cue.gain.value = 0;
    this.cue.connect(opts.destination);
    this.cueActive = false;
    this.master = new ChannelStrip(ctx, { destination: this.out, env: this.env, onError: this.onError, meter: opts.meters !== false, onLatency: this._onLatency });
    this.clickOut = ctx.createGain();
    this.clickOut.connect(this.out);
    this.buses = new Map(); // id -> ChannelStrip
    this.tracks = new Map(); // id -> { strip, type, instrument, instType, instJson, code }
    this.sources = new Set(); // playing audio-clip sources
    this.bpm = null;
    this.firstSync = true;
  }

  sync(project) {
    this._syncing = true;
    try { this._sync(project); } finally { this._syncing = false; }
    this.updatePdc(project);
  }

  _sync(project) {
    this._project = project;
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
        s = new ChannelStrip(this.ctx, { destination: this.master.input, env: this.env, onError: this.onError, meter: this.o.meters !== false, onLatency: this._onLatency });
        this.buses.set(bus.id, s);
      }
      s.setFx(bus.fx || []);
      s.setMix({ volume: bus.volume ?? 0.8, pan: bus.pan || 0, muted: !!bus.mute }, im);
      s.setStrip({ trim: bus.trim, phase: bus.phase, width: bus.width ?? 1, vca: vcaGainFor(project, bus.id) }, im);
    }
    for (const [id, s] of this.buses) if (!busIds.has(id)) { s.dispose(); this.buses.delete(id); }
    // tracks
    const trackIds = new Set();
    for (const track of project.tracks) {
      trackIds.add(track.id);
      let e = this.tracks.get(track.id);
      if (!e) {
        e = {
          strip: new ChannelStrip(this.ctx, { destination: this.master.input, env: this.env, onError: this.onError, meter: this.o.meters !== false, onLatency: this._onLatency }),
          type: track.type, instrument: null, instType: null, instJson: null, code: null,
        };
        this.tracks.set(track.id, e);
      }
      if (e.type !== track.type) { this._disposeSources(e); e.type = track.type; }
      // frozen tracks (core/freeze.js): no instrument / code source, and no inserts or fader when baked in
      const fz = frozenMode(project, track);
      e.frozen = fz;
      e.strip.setFx(fz && bypassesInserts(fz) ? [] : (track.fx || []), fz && bypassesInserts(fz) ? null : track.patch);
      const fader = fz && bypassesFader(fz);
      e.strip.setMix({ volume: fader ? 1 : (track.volume ?? 0.8), pan: fader ? 0 : (track.pan || 0), muted: !isTrackAudible(project, track) }, im);
      e.strip.setStrip({ trim: track.trim, phase: track.phase, width: fader ? 1 : (track.width ?? 1), vca: vcaGainFor(project, track.id), direct: !track._noDirect }, im);
      const outId = outputOf(project, track);
      e.strip.setOutput(outId === 'master' ? this.master.input : this.buses.get(outId)?.input || this.master.input);
      const taps = {};
      for (const busId of Object.keys(track.sends || {})) taps[busId] = sendTap(track, busId);
      e.strip.setSends(track.sends || {}, this.buses, im, taps);
      if (fz) { if (e.instrument || e.code) this._disposeSources(e); } else this._syncSource(e, track);
      this._syncPadOutputs(e, track);
    }
    for (const [id, e] of this.tracks) {
      if (!trackIds.has(id)) { this._disposeSources(e); e.strip.dispose(); this.tracks.delete(id); }
    }
    this._syncKeys(project);
    this._syncCue(project);
  }

  /** Drum multi-out: pads listed in track.padOutputs play straight into their bus (a separate mixer channel). */
  _syncPadOutputs(e, track) {
    const inst = e.instrument;
    if (!inst || typeof inst.setPadOutputs !== 'function') return;
    const map = {};
    for (const [pad, busId] of Object.entries(track.padOutputs || {})) { const b = this.buses.get(busId); if (b) map[pad] = b.input; }
    inst.setPadOutputs(map);
  }

  /** AFL / PFL: soloed channels feed the cue bus, which replaces the main mix on the monitor output. */
  _syncCue(project) {
    if (this.o.cue === false || this.o.meters === false) return; // offline renders always hear the main mix
    const st = soloState(project);
    const want = new Map(st.cue.map((c) => [c.id, c.tap]));
    for (const [id, e] of this.tracks) e.strip.setCue(want.get(id) || null, this.cue);
    for (const [id, s] of this.buses) s.setCue(want.get(id) || null, this.cue);
    const active = want.size > 0;
    if (active !== this.cueActive) {
      this.cueActive = active;
      smooth(this.monitor.gain, active ? 0 : 1, this.ctx, false);
      smooth(this.cue.gain, active ? 1 : 0, this.ctx, false);
    }
  }

  /**
   * Sidechain keys: connect each ducker's key input to its source track's `post` tap
   * (see resolveKeyLinks: self-keying, missing tracks and track↔track loops are skipped).
   */
  _syncKeys(project) {
    const links = resolveKeyLinks(project);
    const want = new Map(); // fxId -> { keyIn, src, srcStrip, dstStrip }
    if (links.size) {
      for (const s of this._strips()) {
        for (const e of s.effects) {
          const srcId = links.get(e.id);
          const keyIn = e.fx.keyInput;
          if (!srcId || !keyIn) continue;
          const src = this.tracks.get(srcId)?.strip || this.buses.get(srcId);
          if (src && src !== s) want.set(e.id, { keyIn, src: src.post, srcStrip: src, dstStrip: s });
        }
      }
    }
    this.keyLinks ||= new Map();
    for (const [id, l] of this.keyLinks) {
      const w = want.get(id);
      if (w && w.keyIn === l.keyIn && w.src === l.src) { l.dstStrip = w.dstStrip; l.srcStrip = w.srcStrip; continue; }
      try { l.link.dispose(); } catch { /* already gone */ }
      this.keyLinks.delete(id);
    }
    for (const [id, w] of want) {
      if (this.keyLinks.has(id)) continue;
      // a DelayLink: PDC delays the key when the ducked audio reaches the ducker later (updatePdc)
      try { this.keyLinks.set(id, { ...w, link: new DelayLink(this.ctx, w.src, w.keyIn) }); } catch (err) { this.onError(err); }
    }
  }

  // ---------------------------------------------------------------- PDC
  /**
   * Recompute plugin delay compensation from the strips' current latencies (see latency.js) and set every
   * compensation delay. Called after each sync and whenever a plugin reports its latency.
   */
  updatePdc(project = this._project) {
    const enabled = project?.pdc !== false;
    const keyLinks = [...(this.keyLinks || new Map()).entries()];
    const strips = [...this._strips()];
    // sidechain keys meet the audio they key: a key's arrival (source `post` time) depends on the PDC plan and
    // can lengthen the keyed strip (its audio waits for a late key) — iterate to a fixed point (keys form a DAG)
    for (const s of strips) s.keyArrive = {};
    let plan = null, tIn = null;
    for (let pass = 0; pass < 6; pass++) {
      plan = this._planPdc(project, enabled);
      tIn = this._inputTimes(plan);
      if (!enabled) break;
      let changed = false;
      for (const [fxId, l] of keyLinks) {
        const src = l.srcStrip, dst = l.dstStrip;
        if (!tIn.has(src) || !tIn.has(dst)) continue;
        const arrive = Math.round((tIn.get(src) + src.insertLatency - tIn.get(dst)) * this.ctx.sampleRate) / this.ctx.sampleRate;
        if (dst.keyArrive[fxId] !== arrive) { dst.keyArrive[fxId] = arrive; changed = true; }
      }
      if (!changed) break;
    }
    this.pdc = plan.pdc;
    // apply: in-strip alignment (branches / keys), key link delays, per-route compensation, LFO heard offsets
    const total = this.latency;
    let lfoShift = false;
    for (const s of strips) {
      const a = s.applyAlignment(enabled);
      for (const e of s.effects) {
        const heard = enabled && tIn.has(s) ? total - (tIn.get(s) + (a.at[e.id] || 0)) : 0;
        if (Math.abs((e.heard || 0) - heard) > 1e-9) { e.heard = heard; lfoShift = true; }
      }
    }
    for (const [fxId, l] of keyLinks) l.link.set(enabled ? l.dstStrip.alignment().key[fxId] || 0 : 0);
    for (const t of plan.tracks) {
      const e = this.tracks.get(t.id);
      // a track routed into a bus: its main out is compensated like a send to that bus
      e.strip.setCompensation(t.outBus ? this.pdc.trackSend[t.id]?.[t.outBus] || 0 : this.pdc.trackOut[t.id], this.pdc.trackSend[t.id]);
    }
    if (lfoShift) this.syncLfos(); // (no-op while stopped)
    if (plan.prevTotal !== this.pdc.total) this.o.onLatency?.(this.pdc);
    return this.pdc;
  }

  _planPdc(project, enabled) {
    const tracks = [];
    for (const [id, e] of this.tracks) {
      const inst = Number(e.instrument?.latency);
      const sends = [...e.strip.sends.keys()];
      const outBus = this._busIdOf(e.strip.outDest);
      if (outBus && !sends.includes(outBus)) sends.push(outBus);
      tracks.push({ id, latency: e.strip.insertLatency + (Number.isFinite(inst) && inst > 0 ? inst : 0), sends, outBus, inst: Number.isFinite(inst) && inst > 0 ? inst : 0 });
    }
    const buses = [...this.buses].map(([id, s]) => ({ id, latency: s.insertLatency }));
    const pdc = computePdc({ sampleRate: this.ctx.sampleRate, enabled, tracks, buses, master: this.master.insertLatency });
    return { pdc, tracks, prevTotal: this.pdc?.total };
  }

  /** When each strip's input hears an event dispatched at 0 (compensated graph): Map(strip -> s). */
  _inputTimes({ pdc, tracks }) {
    const m = new Map();
    for (const t of tracks) m.set(this.tracks.get(t.id).strip, t.inst);
    for (const [id, s] of this.buses) m.set(s, pdc.align - (pdc.busLatency[id] || 0));
    m.set(this.master, pdc.align);
    return m;
  }

  _busIdOf(node) {
    if (!node || node === this.master.input) return null;
    for (const [id, s] of this.buses) if (s.input === node) return id;
    return null;
  }

  /** Overall output delay (s) of the compensated graph: events must be dispatched this much early. */
  get latency() { return this.pdc?.enabled ? this.pdc.total : 0; }

  /** Per-track / bus / master latency report for UIs: {total, tracks:{id: s}, buses:{id: s}, master}. */
  latencyReport() {
    const p = this.pdc || {};
    return { enabled: !!p.enabled, total: this.latency, align: p.align || 0, tracks: { ...(p.trackLatency || {}) }, buses: { ...(p.busLatency || {}) }, master: p.master || 0 };
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
          const inst = e.instrument;
          const rd = inst.ready;
          if (rd && typeof rd.then === 'function') rd.then(() => { if (e.instrument === inst && inst.latency > 0) this._onLatency(); }, () => {});
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
    // t0 = when the events of beat b0 are dispatched; each fader hears them after its route's latency (PDC)
    const off = this.pdc?.enabled ? faderOffsets(this.pdc) : { tracks: {}, bus: 0, master: 0 };
    try { this.master.automate(MixGraph.mixerLanes(project.master, false, false), b0, b1, t0 + off.master, spb, jump, this.buses); } catch (err) { this.onError(err); }
    for (const bus of project.buses || []) {
      const s = this.buses.get(bus.id);
      if (!s) continue;
      const lanes = MixGraph.mixerLanes(bus, false);
      const vca = vcaCombinedLane(project, bus.id);
      if (vca) lanes.vca = vca;
      try { s.automate(lanes, b0, b1, t0 + off.bus, spb, jump, this.buses); } catch (err) { this.onError(err); }
    }
    for (const track of project.tracks) {
      const e = this.tracks.get(track.id);
      if (!e) continue;
      // frozen post-fader: volume / pan automation is baked into the audio
      const owner = e.frozen ? { ...track, automation: (track.automation || []).filter(frozenLaneFilter(e.frozen)) } : track;
      // a track silenced by another track's solo stays silent whatever its mute lane says
      const lanes = MixGraph.mixerLanes(owner, true, isTrackAudible(project, { ...track, mute: false }));
      const vca = vcaCombinedLane(project, track.id);
      if (vca) lanes.vca = vca;
      try { e.strip.automate(lanes, b0, b1, t0 + (off.tracks[track.id] || 0), spb, jump, this.buses); } catch (err) { this.onError(err); }
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
  // map: the TempoMap the event was timed with (time/tempo-map.js); events timed through a non-constant map carry
  // durSec (exact seconds across ramps) and audio clips are played through the warp engine (warp/player.js).
  playEvent(ev, time, spb, map) {
    // the click joins after the master section: it skips the compensated mix latency
    if (ev.type === 'click') { scheduleClick(this.ctx, this.clickOut, time + this.latency, ev.level ?? ev.accent); return; }
    const e = this.tracks.get(ev.trackId);
    if (!e) return;
    if (ev.type === 'note') {
      const durSec = Math.max(0.005, ev.durSec ?? ev.dur * spb);
      e.instrument?.trigger(time, ev.pitch, ev.vel, durSec, ev.x ? noteExtra(ev, durSec) : undefined);
    } else if (ev.type === 'code') {
      e.code?.trigger(time, ev.value, Math.max(0.005, ev.durSec ?? ev.dur * spb), ev);
    } else if (ev.type === 'audio') {
      if (needsWarpPlayer(ev.clip)) { this._warpPlayer().play(e, ev, time, spb, map); return; }
      if (map && !map.isConstant) { this._playAudioClip(e, unwarpedInSeconds(ev, map), time, 1); return; } // tempo map: in seconds
      this._playAudioClip(e, ev, time, spb);
    }
  }

  /**
   * Live tempo edit while playing: warped audio clips that span transport `beat` follow `map` from dispatch time
   * `time` on (the scheduler's next window boundary, where its new anchor starts). See WarpPlayer.retime.
   */
  retimeClips(map, time, beat) { return this._warp ? this._warp.retime(map, time, beat) : 0; }

  /** Warp engine for audio clips (warp modes / tempo maps), created on first use. */
  _warpPlayer() {
    return this._warp || (this._warp = new WarpPlayer(this, {
      getSampleBuffer: (id) => this.o.getSampleBuffer(id), getSampleAnalysis: (id) => this.o.getSampleAnalysis?.(id) || null, worklet: this.o.warpWorklet !== false,
      getSampleStream: (id) => this.o.getSampleStream?.(id) || null, isStreamed: (id) => !!this.o.isStreamed?.(id), openStreamPort: this.o.openStreamPort,
    }));
  }

  /** Gain envelope of one audio-clip play: 4 ms de-click ramps + the clip's own fades (fadeIn / fadeOut, beats). */
  _clipEnvelope(g, clip, ev, time, dur, spb) {
    if (needsShapedEnvelope(clip)) { // curved fades / crossfades / gain envelope (src/record/clips.js)
      const pts = envelopePoints(clip, ev.offset, dur, spb);
      g.gain.setValueAtTime(0, time);
      for (let i = 1; i < pts.length; i++) g.gain.linearRampToValueAtTime(pts[i].v, time + pts[i].t);
      return;
    }
    const gain = clip.gain ?? 1;
    const fade = Math.min(0.004, dur / 4);
    if (clip.fadeIn > 0 || clip.fadeOut > 0) {
      // clip fades (beats, e.g. from DAWproject imports): linear in / out over the clip's own timeline
      const t0 = Math.max(0, ev.offset * spb);
      const clipDur = clip.length * spb;
      const fi = Math.max(0, (clip.fadeIn || 0) * spb);
      const fo = Math.max(0, (clip.fadeOut || 0) * spb);
      const env = (tc) => gain * (fi > 0 ? Math.min(1, tc / fi) : 1) * (fo > 0 ? Math.min(1, Math.max(0, clipDur - tc) / fo) : 1);
      const end = time + dur;
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(env(t0 + fade), time + fade);
      if (fi > t0 + fade && time + fi - t0 < end) g.gain.linearRampToValueAtTime(env(fi), time + fi - t0);
      const foStart = time + (clipDur - fo) - t0;
      if (fo > 0 && foStart > time + fade && foStart < end) g.gain.linearRampToValueAtTime(env(clipDur - fo), foStart);
      g.gain.linearRampToValueAtTime(env(t0 + dur - fade), end - fade);
      g.gain.linearRampToValueAtTime(0, end);
    } else {
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(gain, time + fade);
      g.gain.setValueAtTime(gain, time + dur - fade);
      g.gain.linearRampToValueAtTime(0, time + dur);
    }
  }

  _playAudioClip(e, ev, time, spb) {
    const clip = ev.clip;
    // long samples stream from the PCM cache (stream/streamer.js) instead of an AudioBuffer
    const stream = this.o.getSampleStream?.(clip.sampleId);
    if (stream) { this._playStream(e, ev, time, spb, stream); return; }
    if (this.o.isStreamed?.(clip.sampleId)) return; // still being prepared for streaming
    const buffer = this.o.getSampleBuffer(clip.sampleId);
    if (!buffer) return;
    const offSec = Math.max(0, ((clip.offset || 0) + ev.offset) * spb);
    if (offSec >= buffer.duration) return;
    const dur = Math.min(ev.dur * spb, buffer.duration - offSec);
    if (dur <= 0.002) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    this._clipEnvelope(g, clip, ev, time, dur, spb);
    src.connect(g);
    g.connect(e.strip.input);
    src.start(time, offSec, dur + 0.001);
    const rec = { src, g };
    this.sources.add(rec);
    src.onended = () => { this.sources.delete(rec); try { g.disconnect(); } catch { /* */ } };
  }

  _playStream(e, ev, time, spb, stream) {
    const clip = ev.clip;
    const offSec = Math.max(0, ((clip.offset || 0) + ev.offset) * spb);
    if (offSec >= stream.duration) return;
    const dur = Math.min(ev.dur * spb, stream.duration - offSec);
    if (dur <= 0.002) return;
    const g = this.ctx.createGain();
    this._clipEnvelope(g, clip, ev, time, dur, spb);
    g.connect(e.strip.input);
    let voice;
    try { voice = this.o.playStream(stream, g, time, offSec, dur + 0.001); } catch (err) { this.onError(err); try { g.disconnect(); } catch { /* */ } return; }
    const rec = { src: voice, g };
    this.sources.add(rec);
    voice.onended = () => { this.sources.delete(rec); try { g.disconnect(); } catch { /* */ } };
  }

  /** Stop everything that is sounding (transport stop / seek). */
  allNotesOff(time) {
    const t = time ?? this.ctx.currentTime;
    for (const e of this.tracks.values()) {
      try { e.instrument?.allNotesOff(t); } catch (err) { this.onError(err); }
      try { e.code?.allNotesOff(t); } catch (err) { this.onError(err); }
    }
    this._warp?.clear(); // stopped voices must not be retimed (a later stop() would revive them)
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
    if (id === 'cue') return { l: 0, r: 0 };
    const s = this.tracks.get(id)?.strip || this.buses.get(id);
    return s ? s.getMeter() : { l: 0, r: 0 };
  }

  /** Loudness / scope / spectrum analysis of the master (created on first use — see meters.js). */
  masterAnalysis() {
    if (!this.analysis) this.analysis = new MasterAnalysis(this.ctx, this.master.input, this.out);
    return this.analysis;
  }

  /** Gain reduction (dB, <= 0) of a compressor/limiter effect anywhere in the graph. */
  getReduction(fxId) {
    for (const s of this._strips()) {
      if (s.effects.some((e) => e.id === fxId)) return s.getReduction(fxId);
    }
    return 0;
  }

  /** The live probe object of an effect anywhere in the graph (see createEffect), else null. */
  getFxProbe(fxId) {
    for (const s of this._strips()) {
      if (s.effects.some((e) => e.id === fxId)) return s.getFxProbe(fxId);
    }
    return null;
  }

  dispose() {
    try { this.analysis?.dispose(); } catch { /* */ }
    for (const e of this.tracks.values()) { this._disposeSources(e); e.strip.dispose(); }
    for (const s of this.buses.values()) s.dispose();
    this.master.dispose();
    this.tracks.clear();
    this.buses.clear();
    for (const rec of this.sources) { try { rec.src.stop(); } catch { /* */ } }
    this.sources.clear();
    try { this.out.disconnect(); this.clickOut.disconnect(); this.monitor.disconnect(); this.cue.disconnect(); } catch { /* */ }
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
