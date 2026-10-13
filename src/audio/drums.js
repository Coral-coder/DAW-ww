// Synthesized drum machine. Each pad voice is described by layer data (see kits.js):
//   { tones:[{wave,freq,pitchStart,pitchDecay,decay,level,attack}],
//     noise:{color,filter,freq,q,decay,level,attack,bursts,gap},
//     metal:{freqs,scale,wave,bp,q,hp,decay,level,attack},
//     click:{level,freq,decay}, drive, crush, lp, hp, gain, choke }
// Pads may instead play a project sample (pads[key].sampleId).
import { clamp } from '../core/util.js';
import { DRUM_PADS } from '../core/model.js';
import { DRUM_KITS } from './kits.js';
import { BaseInstrument, Voice, getCrushCurve, getDriveCurve, getNoiseBuffer, fadeOut, num } from './synth.js';

const PAD_BY_PITCH = new Map(DRUM_PADS.map((p) => [p.pitch, p.key]));
// extra General-MIDI percussion notes -> nearest sensible pad
const GM_EXTRA = {
  35: 'kick', 40: 'snare', 41: 'tomlow', 43: 'tomlow', 44: 'hihat', 48: 'tommid', 52: 'crash', 53: 'ride', 55: 'crash',
  57: 'crash', 59: 'ride', 58: 'shaker', 60: 'conga', 61: 'conga', 62: 'conga', 64: 'conga', 65: 'tomhigh', 66: 'tommid',
  67: 'cowbell', 68: 'cowbell', 69: 'shaker', 71: 'clave', 72: 'clave', 73: 'shaker', 74: 'shaker', 76: 'clave', 77: 'clave',
  78: 'conga', 79: 'conga', 80: 'tambourine', 81: 'tambourine', 82: 'shaker', 34: 'rim', 33: 'rim', 31: 'rim', 27: 'clap', 28: 'snare',
};
/** Map any MIDI pitch to a pad key. */
export function pitchToPad(pitch) {
  const p = Math.round(num(pitch, 36));
  if (PAD_BY_PITCH.has(p)) return PAD_BY_PITCH.get(p);
  if (GM_EXTRA[p]) return GM_EXTRA[p];
  let best = DRUM_PADS[0], bd = Infinity;
  for (const pad of DRUM_PADS) { const d = Math.abs(pad.pitch - p); if (d < bd) { bd = d; best = pad; } }
  return best.key;
}

// Roland TR-808 metallic oscillator frequencies (Hz)
const METAL_808 = [205.3, 304.4, 369.6, 522.7, 540, 800];
const DEFAULT_VOICE = { tones: [{ wave: 'sine', freq: 200, decay: 0.2, level: 0.8 }] };

/** Exponential decay helper on a gain param (attack linear). */
function decayEnv(param, t, level, attack, decay) {
  const a = Math.max(0.0005, attack);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(level, t + a);
  param.exponentialRampToValueAtTime(Math.max(1e-5, level * 0.001), t + a + Math.max(0.005, decay));
  return t + a + Math.max(0.005, decay);
}

/**
 * Play one synthesized drum hit into `dest` at time t.
 * o = { tune (semitones), decay (multiplier), tone (-1..1), gain, pan (-1..1), vel (0..1), fx:{drive,crush,lp} }
 * Returns the Voice (call voice.choke(t) to cut it).
 */
export function playDrumVoice(ctx, dest, t, def, o = {}) {
  def = def || DEFAULT_VOICE;
  const v = new Voice(ctx);
  v.start = t;
  const nyq = ctx.sampleRate / 2 - 200;
  const ratio = Math.pow(2, num(o.tune, 0, -48, 48) / 12);
  const dm = num(o.decay, 1, 0.05, 8);
  const tone = num(o.tone, 0, -1, 1);
  const bright = Math.pow(2, tone);
  const vel = num(o.vel, 0.8, 0, 1);
  const fx = o.fx || {};
  const sum = v.node(ctx.createGain());
  sum.gain.value = 1;
  let end = t + 0.02;

  for (const L of def.tones || []) {
    const f = clamp(num(L.freq, 100) * ratio, 10, nyq);
    const osc = v.src(ctx.createOscillator());
    osc.type = ['sine', 'triangle', 'square', 'sawtooth'].includes(L.wave) ? L.wave : 'sine';
    const ps = num(L.pitchStart, 1, 0.1, 40);
    osc.frequency.setValueAtTime(clamp(f * ps, 10, nyq), t);
    if (Math.abs(ps - 1) > 0.001) osc.frequency.exponentialRampToValueAtTime(f, t + Math.max(0.002, num(L.pitchDecay, 0.03) * Math.sqrt(dm)));
    if (L.pitchEnd) osc.frequency.exponentialRampToValueAtTime(clamp(f * num(L.pitchEnd, 1, 0.1, 4), 10, nyq), t + num(L.decay, 0.3) * dm);
    const g = v.node(ctx.createGain());
    const lvl = num(L.level, 0.8, 0, 2) * Math.pow(2, -tone * 0.25);
    end = Math.max(end, decayEnv(g.gain, t, lvl, num(L.attack, 0.001), num(L.decay, 0.3) * dm));
    osc.connect(g); g.connect(sum);
  }
  const N = def.noise;
  if (N && num(N.level, 0.5) > 0) {
    const ns = v.src(ctx.createBufferSource());
    ns.buffer = getNoiseBuffer(ctx, N.color || 'white');
    ns.loop = true;
    let node = ns;
    if (N.filter && N.filter !== 'none') {
      const fl = v.node(ctx.createBiquadFilter());
      fl.type = { hp: 'highpass', bp: 'bandpass', lp: 'lowpass' }[N.filter] || 'bandpass';
      fl.frequency.value = clamp(num(N.freq, 5000) * Math.sqrt(ratio) * bright, 30, nyq);
      fl.Q.value = num(N.q, fl.type === 'bandpass' ? 1 : 0, -10, 30);
      node.connect(fl); node = fl;
    }
    if (N.hp) {
      const hp = v.node(ctx.createBiquadFilter());
      hp.type = 'highpass'; hp.frequency.value = clamp(num(N.hp, 500) * bright, 20, nyq);
      node.connect(hp); node = hp;
    }
    const g = v.node(ctx.createGain());
    const lvl = num(N.level, 0.5, 0, 2) * Math.pow(2, tone * 0.4);
    const bursts = Math.round(num(N.bursts, 1, 1, 8));
    const dec = num(N.decay, 0.2) * dm;
    if (bursts > 1) {
      const gap = num(N.gap, 0.01, 0.002, 0.05);
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < bursts - 1; i++) {
        const ti = t + i * gap;
        g.gain.setValueAtTime(lvl * (i === 0 ? 0.8 : 1), ti + 0.0003);
        g.gain.exponentialRampToValueAtTime(lvl * 0.08, ti + gap * 0.96);
      }
      const tl = t + (bursts - 1) * gap;
      g.gain.setValueAtTime(lvl, tl + 0.0003);
      g.gain.exponentialRampToValueAtTime(Math.max(1e-5, lvl * 0.001), tl + Math.max(0.01, dec));
      end = Math.max(end, tl + dec);
    } else {
      end = Math.max(end, decayEnv(g.gain, t, lvl, num(N.attack, 0.0008), dec));
    }
    node.connect(g); g.connect(sum);
  }
  const M = def.metal;
  if (M && num(M.level, 0.5) > 0) {
    const freqs = Array.isArray(M.freqs) && M.freqs.length ? M.freqs : METAL_808;
    const scale = num(M.scale, 1, 0.1, 8) * ratio;
    const msum = v.node(ctx.createGain());
    msum.gain.value = 1 / Math.sqrt(freqs.length);
    for (const fr of freqs) {
      const osc = v.src(ctx.createOscillator());
      osc.type = M.wave === 'sine' || M.wave === 'triangle' ? M.wave : 'square';
      osc.frequency.value = clamp(num(fr, 400) * scale, 10, nyq);
      osc.connect(msum);
    }
    let node = msum;
    if (M.bp) {
      const bp = v.node(ctx.createBiquadFilter());
      bp.type = 'bandpass'; bp.frequency.value = clamp(num(M.bp, 8000) * bright, 50, nyq); bp.Q.value = num(M.q, 1, 0.1, 30);
      node.connect(bp); node = bp;
    }
    if (M.hp) {
      const hp = v.node(ctx.createBiquadFilter());
      hp.type = 'highpass'; hp.frequency.value = clamp(num(M.hp, 6000) * bright, 20, nyq);
      node.connect(hp); node = hp;
    }
    const g = v.node(ctx.createGain());
    end = Math.max(end, decayEnv(g.gain, t, num(M.level, 0.5, 0, 2) * Math.pow(2, tone * 0.3), num(M.attack, 0.0008), num(M.decay, 0.1) * dm));
    node.connect(g); g.connect(sum);
  }
  const C = def.click;
  if (C && num(C.level, 0) > 0) {
    const ns = v.src(ctx.createBufferSource());
    ns.buffer = getNoiseBuffer(ctx, 'white');
    ns.loop = true;
    const bp = v.node(ctx.createBiquadFilter());
    bp.type = 'bandpass'; bp.frequency.value = clamp(num(C.freq, 3000) * bright, 100, nyq); bp.Q.value = 0.7;
    const g = v.node(ctx.createGain());
    end = Math.max(end, decayEnv(g.gain, t, num(C.level, 0.3, 0, 2), 0.0003, num(C.decay, 0.006)));
    ns.connect(bp); bp.connect(g); g.connect(sum);
  }

  // post chain: lp -> hp -> drive -> crush -> out -> pan
  let node = sum;
  const lp = num(def.lp ?? fx.lp, 0);
  if (lp > 0) {
    const f = v.node(ctx.createBiquadFilter());
    f.type = 'lowpass'; f.frequency.value = clamp(lp * Math.pow(2, tone * 1.2), 40, nyq); f.Q.value = -3;
    node.connect(f); node = f;
  }
  const hp = num(def.hp, 0);
  if (hp > 0) {
    const f = v.node(ctx.createBiquadFilter());
    f.type = 'highpass'; f.frequency.value = clamp(hp, 20, nyq);
    node.connect(f); node = f;
  }
  const drive = clamp(num(def.drive, 0) + num(fx.drive, 0), 0, 1);
  if (drive > 0.001) {
    const pre = v.node(ctx.createGain()); pre.gain.value = 1 + drive * 2;
    const ws = v.node(ctx.createWaveShaper()); ws.curve = getDriveCurve(drive);
    const post = v.node(ctx.createGain()); post.gain.value = 1 / (1 + drive * 1.2);
    node.connect(pre); pre.connect(ws); ws.connect(post); node = post;
  }
  const crush = num(def.crush ?? fx.crush, 0);
  if (crush >= 1 && crush < 16) {
    const ws = v.node(ctx.createWaveShaper()); ws.curve = getCrushCurve(crush);
    node.connect(ws); node = ws;
  }
  const out = v.node(ctx.createGain());
  out.gain.value = 0.8 * num(def.gain, 1, 0, 4) * num(o.gain, 1, 0, 4) * (0.12 + 0.88 * vel);
  v.amp = out;
  node.connect(out);
  node = out;
  const pan = num(o.pan, 0, -1, 1) + num(def.pan, 0, -1, 1);
  if (Math.abs(pan) > 0.001) {
    const pn = v.node(ctx.createStereoPanner()); pn.pan.value = clamp(pan, -1, 1);
    node.connect(pn); node = pn;
  }
  node.connect(dest);
  v.choke = (tc, fade = 0.012) => {
    if (v.done || tc >= v.end) return;
    fadeOut(out.gain, tc, fade, out.gain.value);
    v.stopAt(tc + fade + 0.005);
  };
  v.startAll(t);
  v.stopAt(end + 0.02);
  return v;
}

/** Play an AudioBuffer as a one-shot drum hit. */
export function playSampleHit(ctx, dest, t, buffer, o = {}) {
  const v = new Voice(ctx);
  v.start = t;
  const src = v.src(ctx.createBufferSource());
  src.buffer = buffer;
  const rate = Math.pow(2, num(o.tune, 0, -48, 48) / 12) * num(o.speed, 1, 0.05, 16);
  src.playbackRate.value = rate;
  const out = v.node(ctx.createGain());
  const lvl = num(o.gain, 1, 0, 4) * (0.12 + 0.88 * num(o.vel, 0.8, 0, 1));
  const len = (buffer.duration / rate) * Math.min(1, num(o.decay, 1, 0.05, 8));
  out.gain.setValueAtTime(lvl, t);
  if (num(o.decay, 1) < 0.999) {
    out.gain.setValueAtTime(lvl, t + len * 0.6);
    out.gain.linearRampToValueAtTime(0, t + len);
  }
  src.connect(out);
  let node = out;
  const pan = num(o.pan, 0, -1, 1);
  if (Math.abs(pan) > 0.001) { const pn = v.node(ctx.createStereoPanner()); pn.pan.value = pan; node.connect(pn); node = pn; }
  node.connect(dest);
  v.amp = out;
  v.choke = (tc, fade = 0.012) => {
    if (v.done || tc >= v.end) return;
    fadeOut(out.gain, tc, fade, lvl);
    v.stopAt(tc + fade + 0.005);
  };
  v.startAll(t);
  v.stopAt(t + len + 0.01);
  return v;
}

export class DrumInstrument extends BaseInstrument {
  constructor(ctx, output, params, opts) {
    super(ctx, output, params, opts);
    this.type = 'drums';
  }
  get polyphony() { return 48; }

  _kit() { return DRUM_KITS[this.params.kit] || DRUM_KITS['808']; }

  trigger(time, pitch, vel = 0.8, durSec, extra = {}) {
    const t = this._t(time);
    return this.hit(t, pitchToPad(pitch), num(vel, 0.8, 0, 1), extra || {});
  }

  hit(t, padKey, vel, extra = {}) {
    const p = this.params;
    const pad = (p.pads && p.pads[padKey]) || {};
    if (pad.mute) return null;
    const kit = this._kit();
    const def = kit.voices[padKey] || DEFAULT_VOICE;
    // choke groups (open hat cut by closed/open hat)
    const group = def.choke || (padKey === 'hihat' || padKey === 'openhat' ? 'hat' : null);
    if (group) for (const v of this.voices) if (v.group === group && v.start < t + 1e-4) v.choke(t);
    this._makeRoom(t);
    const o = {
      tune: num(p.pitch, 0, -24, 24) + num(pad.tune, 0, -24, 24) + num(extra.tune, 0, -48, 48),
      decay: num(p.decay, 1, 0.1, 4) * num(pad.decay, 1, 0.1, 4),
      tone: clamp(num(p.tone, 0, -1, 1) + num(pad.tone, 0, -1, 1), -1, 1),
      gain: num(pad.gain, 1, 0, 2),
      pan: clamp(num(pad.pan, 0, -1, 1) + num(extra.pan, 0, -1, 1), -1, 1),
      vel: vel * 1,
      fx: kit.fx,
    };
    let v = null;
    const buf = pad.sampleId ? this.opts.getSampleBuffer?.(pad.sampleId) : null;
    if (buf) v = playSampleHit(this.ctx, this.out.input, t, buf, o);
    else v = playDrumVoice(this.ctx, this.out.input, t, def, o);
    v.group = group;
    v.pad = padKey;
    v.pitch = padKey;
    return this._register(v);
  }

  _kill(v, t, fade = 0.015) { v.choke?.(Math.max(t, this.ctx.currentTime), fade); }
  noteOn(pitch, vel = 0.8, time) { return this.trigger(time, pitch, vel, 0.1); }
  noteOff() { /* one-shots */ }
}
