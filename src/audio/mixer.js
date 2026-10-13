// Channel strips and the mix graph. Context-agnostic: the realtime engine and the offline
// renderer both build their graph through MixGraph so they sound identical.
//
// Track strip:  instrument/code/audio-clips -> input -> [insert fx...] -> pan -> volume -> mute
//                 -> master input, -> post-fader sends -> bus inputs, -> stereo meter
// Bus strip:    input -> fx -> pan -> volume -> mute -> master input
// Master:       input -> fx -> volume -> analyser -> destination  (metronome joins after master fx)
import { createEffect } from './effects.js';
import { createInstrument } from './instruments.js';
import * as codeInstrumentModule from './code-instrument.js';
import { scheduleClick } from './metronome.js';
import { isTrackAudible } from './scheduler.js';
import { activeLanes, parseTarget, segmentsInWindow, valueAt, controlOverrides } from '../core/automation.js';
import { INSTRUMENT_DEFS } from './defs.js';
import { EFFECT_DEFS } from './effect-defs.js';
import { resolveInstrument } from './instruments.js';

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

/** def with automation param overrides merged in (def unchanged when ov is empty). */
function withParams(def, ov) {
  if (!def || !ov) return def;
  return { ...def, params: { ...(def.params || {}), ...ov } };
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
    this.panner = ctx.createStereoPanner();
    this.volume = ctx.createGain();
    this.muteGain = ctx.createGain();
    this.output = this.muteGain;
    this.panner.connect(this.volume);
    this.volume.connect(this.muteGain);
    if (opts.destination) this.muteGain.connect(opts.destination);
    this.input.connect(this.panner);
    this.effects = []; // [{ id, type, fx }]
    this.fxKey = '';
    this.sends = new Map(); // busId -> GainNode
    this.vals = {};
    this.sendVals = {}; // static send amounts (restored when send automation ends)
    this.fxDefs = new Map(); // fxId -> last static Effect def
    this.fxOv = new Map(); // fxId -> {key: value} automation overrides
    this.auto = { volume: false, pan: false, sends: new Set() }; // AudioParams currently driven by automation
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

  /** Diff the insert chain: rebuild only when ids/order/types change, else update params. */
  setFx(list = []) {
    const key = list.map((f) => `${f.id}:${f.type}`).join('|');
    if (key !== this.fxKey) {
      this.fxKey = key;
      const old = new Map(this.effects.map((e) => [e.id, e]));
      const next = [];
      for (const def of list) {
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
      // rewire input -> fx... -> panner
      try { this.input.disconnect(); } catch { /* */ }
      for (const e of next) { try { e.fx.output.disconnect(); } catch { /* */ } }
      let prev = this.input;
      for (const e of next) { prev.connect(e.fx.input); prev = e.fx.output; }
      prev.connect(this.panner);
      this.effects = next;
    }
    const byId = new Map(list.map((f) => [f.id, f]));
    this.fxDefs = byId;
    for (const e of this.effects) {
      try { e.fx.update(withParams(byId.get(e.id), this.fxOv.get(e.id))); } catch (err) { this.onError(err); }
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
      try { e.fx.update(withParams(def, ov), immediate); } catch (err) { this.onError(err); }
    }
    for (const id of [...this.fxOv.keys()]) if (!this.effects.some((e) => e.id === id)) this.fxOv.delete(id);
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
    if (this.auto.volume || this.auto.pan || this.auto.sends.size) this.automate({}, 0, 0, 0, 0, null, busStrips);
    if (this.fxOv.size) this.setFxOverrides(null);
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
    if (v.muted !== muted) { v.muted = muted; smooth(this.muteGain.gain, muted ? 0 : 1, this.ctx, immediate); }
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
    for (const n of [this.input, this.panner, this.volume, this.muteGain, this.splitter, ...this.sends.values()]) {
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
      e.strip.setFx(track.fx || []);
      e.strip.setMix({ volume: track.volume ?? 0.8, pan: track.pan || 0, muted: !isTrackAudible(project, track) }, im);
      e.strip.setSends(track.sends || {}, this.buses, im);
      this._syncSource(e, track);
    }
    for (const [id, e] of this.tracks) {
      if (!trackIds.has(id)) { this._disposeSources(e); e.strip.dispose(); this.tracks.delete(id); }
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
          try { e.instrument.update(withParams(def, e.instOv)); } catch (err) { this.onError(err); }
        }
      }
    } else if (track.type === 'code') {
      if (!e.code) {
        const Ctor = codeInstrumentModule.CodeInstrument || codeInstrumentModule.default;
        try {
          e.code = new Ctor(this.ctx, e.strip.input, {
            getSampleBuffer: this.o.getSampleBuffer, getSampleByName: this.o.getSampleByName, getBpm: this.o.getBpm,
          });
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
  /** Mixer lanes of an automation owner (track or master) grouped by target. */
  static mixerLanes(owner, allowSends = true) {
    const out = {};
    for (const l of activeLanes(owner)) {
      const t = parseTarget(l.target);
      if (t.kind === 'volume') out.volume ||= l;
      else if (t.kind === 'pan') out.pan ||= l;
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
    try { this.master.automate(MixGraph.mixerLanes(project.master, false), b0, b1, t0, spb, jump, this.buses); } catch (err) { this.onError(err); }
    for (const track of project.tracks) {
      const e = this.tracks.get(track.id);
      if (!e) continue;
      try { e.strip.automate(MixGraph.mixerLanes(track), b0, b1, t0, spb, jump, this.buses); } catch (err) { this.onError(err); }
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
      if (fx) e.strip.setFxOverrides(ov.fx, immediate);
      if (inst && e.instrument && track.instrument) {
        const type = e.instrument.type || resolveInstrument(track.instrument).type;
        if (changed(e.instOv || null, ov.inst, INSTRUMENT_DEFS[type]?.params)) {
          e.instOv = ov.inst;
          try { e.instrument.update(withParams(track.instrument, ov.inst)); } catch (err) { this.onError(err); }
        }
      }
    }
  }

  /** Leave automation: every automated value goes back to the project's static value. */
  endAutomation(project) {
    this.master.endAutomation(this.buses);
    for (const [id, e] of this.tracks) {
      e.strip.endAutomation(this.buses);
      if (e.instOv) {
        e.instOv = null;
        const track = project?.tracks.find((t) => t.id === id);
        if (e.instrument && track?.instrument) { try { e.instrument.update(track.instrument); } catch (err) { this.onError(err); } }
      }
    }
  }

  /** Instrument for live play (null for audio/code tracks). */
  getInstrument(trackId) { return this.tracks.get(trackId)?.instrument || null; }

  /** Play a collected event (see scheduler.collectEvents) at ctx time `time`. */
  playEvent(ev, time, spb) {
    if (ev.type === 'click') { scheduleClick(this.ctx, this.clickOut, time, ev.accent); return; }
    const e = this.tracks.get(ev.trackId);
    if (!e) return;
    if (ev.type === 'note') {
      e.instrument?.trigger(time, ev.pitch, ev.vel, Math.max(0.005, ev.dur * spb));
    } else if (ev.type === 'code') {
      e.code?.trigger(time, ev.value, Math.max(0.005, ev.dur * spb));
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
