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

const TC = 0.012;

function smooth(param, value, ctx, immediate) {
  if (!isFinite(value)) return;
  if (immediate) { param.cancelScheduledValues(0); param.value = value; } else param.setTargetAtTime(value, ctx.currentTime, TC);
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
    for (const e of this.effects) {
      try { e.fx.update(byId.get(e.id)); } catch (err) { this.onError(err); }
    }
  }

  /** volume (linear), pan (-1..1), muted (bool). */
  setMix({ volume = 0.8, pan = 0, muted = false }, immediate = false) {
    const v = this.vals;
    if (v.volume !== volume) { v.volume = volume; smooth(this.volume.gain, volume, this.ctx, immediate); }
    if (v.pan !== pan) { v.pan = pan; smooth(this.panner.pan, Math.max(-1, Math.min(1, pan)), this.ctx, immediate); }
    if (v.muted !== muted) { v.muted = muted; smooth(this.muteGain.gain, muted ? 0 : 1, this.ctx, immediate); }
  }

  /** sends: {busId: 0..1}; busStrips: Map(busId -> ChannelStrip). Post-fader, post-mute. */
  setSends(sends = {}, busStrips, immediate = false) {
    for (const [busId, g] of this.sends) {
      if (!busStrips.has(busId) || !(sends[busId] > 0)) {
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
      smooth(g.gain, Math.min(1, amt), this.ctx, immediate);
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
        } catch (err) {
          e.instrument = null;
          e.instType = null;
          this.onError(err);
        }
      } else {
        const json = JSON.stringify(def);
        if (json !== e.instJson) {
          e.instJson = json;
          try { e.instrument.update(def); } catch (err) { this.onError(err); }
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
