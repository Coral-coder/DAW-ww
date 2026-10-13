// Sampled drum machine engine. Used for the 'drumsampler' instrument type and for 'drums'
// instruments whose params.machine is set. Extends the synthesized DrumInstrument, so every pad
// whose samples aren't available (still loading, offline, blocked network) transparently plays the
// synthesized voice of params.kit — audio never goes silent.
//
//   ready -> Promise<true> once the samples needed by the current params have loaded or failed
//            (failed pads fall back to the synth kit, so the instrument is always playable).
//   status -> 'loading' | 'ready' | 'partial' | 'fallback'
//
// Per hit: variant (pads[pad].variant or round-robin) -> velocity layer -> round-robin file;
// gain follows velocity (plus a velocity low-pass for single-layer samples); tune/decay/tone/pan per
// pad; closed hat chokes open hat; `humanize` adds tiny deterministic pitch/level variation.
import { clamp } from '../../core/util.js';
import { DrumInstrument, pitchToPad } from '../drums.js';
import { Voice, fadeOut, num } from '../synth.js';
import { library } from './sample-library.js';
import { resolvePadSamples, padVariant, pickLayer, padLoadList, DRUM_MACHINES, canonicalBank } from './drum-machines.js';

const LOAD_TIMEOUT_MS = 45000;

export class DrumSamplerInstrument extends DrumInstrument {
  constructor(ctx, output, params, opts = {}) {
    super(ctx, output, params, opts);
    this.type = 'drumsampler';
    this._rr = new Map(); // pad -> counter
    this._hits = 0;
  }

  /** Machine currently played ('' = synthesized only). */
  get machine() { return canonicalBank(this.params.machine) || ''; }

  setParams(params) {
    const prevKey = this._loadKey;
    super.setParams(params);
    const m = canonicalBank(params?.machine) || '';
    const key = `${this.ctx?.sampleRate}|${m}|${params?.roundRobin ? 1 : 0}|${JSON.stringify(Object.fromEntries(Object.entries(params?.pads || {}).map(([k, v]) => [k, [v?.variant || 0, !!v?.mute]])))}`;
    if (!this.ctx || key === prevKey) return;
    this._loadKey = key;
    this._startLoad(m, params);
  }

  _startLoad(machine, params) {
    if (!machine) { this.status = 'fallback'; this._ready = Promise.resolve(true); return; }
    const urls = padLoadList(machine, params);
    const missing = urls.filter((u) => !library.get(this.ctx, u));
    if (!missing.length) { this.status = 'ready'; this._ready = Promise.resolve(true); return; }
    this.status = 'loading';
    const token = (this._token = (this._token || 0) + 1);
    this._ready = library.preload(this.ctx, missing, { timeoutMs: LOAD_TIMEOUT_MS }).then((r) => {
      if (token === this._token) this.status = r.failed === 0 ? 'ready' : r.loaded ? 'partial' : 'fallback';
      if (r.failed && typeof console !== 'undefined') console.warn(`[drums] ${DRUM_MACHINES[machine]?.name || machine}: ${r.failed}/${r.total} samples unavailable — using the synthesized kit for those pads.`);
      return true;
    }, () => { if (token === this._token) this.status = 'fallback'; return true; });
  }

  /** Resolves true once samples for the current params are loaded (or have fallen back). Never rejects. */
  get ready() { return this._ready || Promise.resolve(true); }
  get error() { return null; }

  hit(t, padKey, vel, extra = {}) {
    const machine = this.machine;
    if (!machine) return super.hit(t, padKey, vel, extra);
    const p = this.params;
    const pad = (p.pads && p.pads[padKey]) || {};
    if (pad.mute) return null;
    if (pad.sampleId && this.opts.getSampleBuffer?.(pad.sampleId)) return super.hit(t, padKey, vel, extra); // user sample wins
    const plan = resolvePadSamples(machine)[padKey];
    if (!plan) return super.hit(t, padKey, vel, extra);
    const rr = this._rr.get(padKey) || 0;
    this._rr.set(padKey, rr + 1);
    const variant = padVariant(plan, pad, rr, !!p.roundRobin);
    const layer = pickLayer(variant, vel);
    let buf = null;
    if (layer?.urls.length) {
      const url = layer.urls[rr % layer.urls.length];
      buf = library.get(this.ctx, url);
      if (!buf) {
        // any loaded file of this variant / pad beats the synth fallback
        for (const L of variant.layers) for (const u of L.urls) if (!buf) buf = library.get(this.ctx, u);
        if (!library.hasFailed(url)) library.load(this.ctx, url);
      }
    }
    if (!buf) return super.hit(t, padKey, vel, extra);
    return this._playSample(t, padKey, buf, vel, pad, variant, layer, extra);
  }

  _playSample(t, padKey, buffer, vel, pad, variant, layer, extra) {
    const ctx = this.ctx, p = this.params;
    // choke groups: closed hat cuts open hat; an open hat cuts the previous open hat
    const group = padKey === 'hihat' || padKey === 'openhat' ? 'hat' : null;
    if (group) for (const v of this.voices) if (v.group === group && v.start < t + 1e-4 && (padKey === 'hihat' || v.pad === 'openhat')) v.choke(t, 0.02);
    this._makeRoom(t);
    const hum = clamp(num(p.humanize, 0.2, 0, 1), 0, 1);
    const h = this._hits++;
    const jitter = (k) => (Math.sin((h + 1) * 12.9898 + k * 78.233) * 43758.5453) % 1; // deterministic -1..1
    const tune = num(p.pitch, 0, -24, 24) + num(pad.tune, 0, -24, 24) + num(variant.tune, 0, -24, 24) + num(extra.tune, 0, -48, 48) + hum * 0.08 * jitter(1);
    const rate = Math.pow(2, tune / 12);
    const decayMul = num(p.decay, 1, 0.1, 4) * num(pad.decay, 1, 0.1, 4) * num(variant.decay, 1, 0.1, 4);
    const tone = clamp(num(p.tone, 0, -1, 1) + num(pad.tone, 0, -1, 1), -1, 1);
    const multiLayer = (variant.layers?.length || 1) > 1;
    // velocity: layered kits already sound softer at low velocity, so use a gentler curve there
    const velGain = multiLayer ? 0.35 + 0.65 * vel : 0.08 + 0.92 * Math.pow(vel, 1.35);
    const level = num(pad.gain, 1, 0, 2) * velGain * (1 + hum * 0.06 * jitter(2));

    const v = new Voice(ctx);
    v.start = t;
    const src = v.src(ctx.createBufferSource());
    src.buffer = buffer;
    src.playbackRate.value = rate;
    let node = src;
    // velocity brightness (single-layer samples) + tone tilt
    const nyq = ctx.sampleRate / 2 - 100;
    let lpHz = multiLayer ? 22000 : 2500 * Math.pow(2, vel * 3.2);
    if (tone < 0) lpHz = Math.min(lpHz, 18000 * Math.pow(2, tone * 5));
    if (lpHz < nyq * 0.95) {
      const f = v.node(ctx.createBiquadFilter());
      f.type = 'lowpass'; f.frequency.value = clamp(lpHz, 60, nyq); f.Q.value = 0.5;
      node.connect(f); node = f;
    }
    if (tone > 0.01) {
      const f = v.node(ctx.createBiquadFilter());
      f.type = 'highshelf'; f.frequency.value = 3500; f.gain.value = tone * 9;
      node.connect(f); node = f;
    }
    const amp = v.node(ctx.createGain());
    node.connect(amp); node = amp;
    const natural = buffer.duration / rate;
    let len = natural;
    amp.gain.setValueAtTime(level, t);
    if (decayMul < 0.995) {
      len = Math.max(0.02, natural * decayMul);
      amp.gain.setValueAtTime(level, t + len * 0.35);
      amp.gain.exponentialRampToValueAtTime(Math.max(1e-4, level * 0.001), t + len);
    } // decay > 1 can't lengthen a one-shot: it keeps its natural length
    const pan = clamp(num(pad.pan, 0, -1, 1) + num(extra.pan, 0, -1, 1), -1, 1);
    if (Math.abs(pan) > 0.001) {
      const pn = v.node(ctx.createStereoPanner()); pn.pan.value = pan;
      node.connect(pn); node = pn;
    }
    node.connect(this.out.input);
    v.amp = amp;
    v.group = group;
    v.pad = padKey;
    v.pitch = padKey;
    v.choke = (tc, fade = 0.015) => {
      if (v.done || tc >= v.end) return;
      fadeOut(amp.gain, tc, fade, level);
      v.stopAt(tc + fade + 0.005);
    };
    v.startAll(t);
    v.stopAt(t + len + 0.02);
    return this._register(v);
  }

  trigger(time, pitch, vel = 0.8, durSec, extra = {}) {
    const t = this._t(time);
    return this.hit(t, pitchToPad(pitch), num(vel, 0.8, 0, 1), extra || {});
  }
}

/** Should a resolved instrument def play through the sampler? */
export function usesDrumSampler(type, params) {
  return type === 'drumsampler' || (type === 'drums' && !!canonicalBank(params?.machine));
}
