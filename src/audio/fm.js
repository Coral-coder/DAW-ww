// 4-operator FM synth (DX-style). Operators are sine oscillators; modulators drive the
// carrier's frequency input with deviation = index * modulatorFreq (true FM ≈ PM for sines).
import { clamp, midiToFreq } from '../core/util.js';
import { BaseInstrument, Voice, envNote, num } from './synth.js';

/**
 * DX7-style operator envelope: attack -> L1 (peak), dB-linear decay (exponential ramp, like the
 * DX7's log-domain EG) to the break level L2 in `d` seconds, then an RC approach to the sustain
 * level L3 with time constant d2/4, release with time constant r/6. Without d2 this is the plain
 * ADSR of envNote(). Returns an envelope state usable with envRelease()/envRegate().
 */
export function fmEnv(param, t, tOff, env, peak) {
  const d2 = num(env.d2, 0, 0, 60);
  if (!(d2 > 0.0005) || !(peak > 0)) return envNote(param, t, tOff, env, peak, 0);
  const a = Math.max(0.0008, num(env.a, 0.002)), d = Math.max(0.002, num(env.d, 0.3));
  const brk = Math.max(1e-4, Math.min(1, num(env.brk, 0.5)));
  const s = Math.max(0, Math.min(1, num(env.s, 0))), r = Math.max(0.004, num(env.r, 0.1));
  const vb = peak * brk, vs = peak * s;
  const t1 = t + a, t2 = t1 + d;
  const fn = (tm) => {
    if (tm <= t) return 0;
    if (tm < t1) return (peak * (tm - t)) / a;
    if (tm < t2) return peak * Math.pow(brk, (tm - t1) / d);
    return vs + (vb - vs) * Math.exp(-(tm - t2) / (d2 / 4));
  };
  const st = { t, a, d, s, r, peak, base: 0, from: 0, sus: vs, tOff: null, fn, convex: false };
  param.setValueAtTime(0, t);
  const end = tOff != null ? Math.max(t + 0.0005, tOff) : Infinity;
  if (end <= t1) {
    param.linearRampToValueAtTime(fn(end), end);
  } else {
    param.linearRampToValueAtTime(peak, t1);
    if (end <= t2) param.exponentialRampToValueAtTime(Math.max(1e-9, fn(end)), end);
    else {
      param.exponentialRampToValueAtTime(vb, t2);
      param.setTargetAtTime(vs, t2, d2 / 4);
    }
  }
  if (Number.isFinite(end)) {
    param.setTargetAtTime(0, end, r / 6);
    st.tOff = end;
  }
  return st;
}

/** Algorithms: mods = [src, dst] pairs (1-based op numbers), carriers = audible ops. */
export const FM_ALGORITHMS = [
  { id: 1, name: 'Stack 1→2→3→4', mods: [[1, 2], [2, 3], [3, 4]], carriers: [4] },
  { id: 2, name: '(1+2)→3→4', mods: [[1, 3], [2, 3], [3, 4]], carriers: [4] },
  { id: 3, name: '1→2→4 + 3→4', mods: [[1, 2], [2, 4], [3, 4]], carriers: [4] },
  { id: 4, name: '(1+2+3)→4', mods: [[1, 4], [2, 4], [3, 4]], carriers: [4] },
  { id: 5, name: 'Pairs 1→2, 3→4', mods: [[1, 2], [3, 4]], carriers: [2, 4] },
  { id: 6, name: '1→(2,3,4)', mods: [[1, 2], [1, 3], [1, 4]], carriers: [2, 3, 4] },
  { id: 7, name: '1→2→3 + 4', mods: [[1, 2], [2, 3]], carriers: [3, 4] },
  { id: 8, name: '1→2 + 3 + 4', mods: [[1, 2]], carriers: [2, 3, 4] },
  { id: 9, name: 'Additive 1+2+3+4', mods: [], carriers: [1, 2, 3, 4] },
  { id: 10, name: '1→(3,4) + 2→(3,4)', mods: [[1, 3], [1, 4], [2, 3], [2, 4]], carriers: [3, 4] },
  { id: 11, name: '1→2→3, 1→4', mods: [[1, 2], [2, 3], [1, 4]], carriers: [3, 4] },
];

const MAX_INDEX = 4 * Math.PI; // DX7: a full-level modulator deviates the carrier phase by ±4π rad
const VOICE_SCALE = 0.32;

export class FMInstrument extends BaseInstrument {
  constructor(ctx, output, params, opts) {
    super(ctx, output, params, opts);
    this.type = 'fm';
  }

  _createVoice(t, pitch, vel, tOff, extra) {
    const ctx = this.ctx, p = this.params;
    const v = new Voice(ctx);
    v.pitch = pitch; v.vel = vel; v.start = t; v.envs = [];
    const algo = FM_ALGORITHMS.find((a) => a.id === Math.round(num(p.algorithm, 5))) || FM_ALGORITHMS[4];
    const f0 = midiToFreq(pitch + num(p.transpose, 0, -48, 48));
    const ks = num(p.keyScale, 0.3, 0, 1);
    const timeScale = Math.pow(2, (-(pitch - 60) / 12) * ks * 0.6); // higher keys decay faster
    const levelScale = Math.pow(2, (-(pitch - 60) / 12) * ks * 0.35); // and get a bit less bright
    const nyq = ctx.sampleRate / 2;

    const out = v.node(ctx.createGain());
    out.gain.value = 1;
    v.amp = out;
    const ops = [];
    const detuneTargets = [];
    for (let i = 1; i <= 4; i++) {
      const ratio = num(p[`op${i}Ratio`], 1, 0, 32);
      const fixed = ratio <= 0;
      const freq = clamp((fixed ? 1 : f0 * ratio) * Math.pow(2, num(p[`op${i}Fine`], 0, -100, 100) / 1200), 0.01, nyq);
      const osc = v.src(ctx.createOscillator());
      osc.type = 'sine';
      osc.frequency.value = freq;
      detuneTargets.push(osc.detune);
      const g = v.node(ctx.createGain());
      g.gain.value = 0;
      osc.connect(g);
      ops[i] = { osc, g, freq };
    }
    const carriers = new Set(algo.carriers);
    const cNorm = 1 / Math.max(1, Math.sqrt(algo.carriers.length) * 1.1);
    let maxRel = 0;
    for (let i = 1; i <= 4; i++) {
      const op = ops[i];
      const level = clamp(num(p[`op${i}Level`], i === 4 ? 1 : 0.5), 0, 1);
      const vs = num(p[`op${i}Vel`], 0.5, 0, 1);
      // DX7-like velocity: attenuation in dB grows with (1 - vel)^1.3 (KVS 7 ≈ -4 dB @ vel .8, -12 dB @ .5)
      const velScale = Math.pow(10, (-vs * 30 * Math.pow(1 - vel, 1.3)) / 20);
      const env = {
        a: num(p[`op${i}Attack`], 0.005, 0, 20) * timeScale,
        d: num(p[`op${i}Decay`], 0.5, 0, 30) * timeScale,
        s: num(p[`op${i}Sustain`], 0.7, 0, 1),
        r: num(p[`op${i}Release`], 0.3, 0, 30) * Math.sqrt(timeScale),
        brk: num(p[`op${i}Break`], 0.5, 0, 1),
        d2: num(p[`op${i}Decay2`], 0, 0, 60) * timeScale,
      };
      let peak;
      if (carriers.has(i)) {
        peak = level * velScale * cNorm;
        op.g.connect(out);
      } else {
        peak = level * level * MAX_INDEX * op.freq * velScale * levelScale; // Hz deviation
        for (const [src, dst] of algo.mods) if (src === i) op.g.connect(ops[dst].osc.frequency);
      }
      if (peak <= 1e-7 && carriers.has(i)) continue;
      const st = fmEnv(op.g.gain, t, tOff, env, peak);
      st.peak0 = peak; st.sus0 = peak * env.s;
      v.envs.push([op.g.gain, st]);
      if (carriers.has(i)) maxRel = Math.max(maxRel, st.r);
      if (carriers.has(i) && !v.ampSt) v.ampSt = st;
    }
    // feedback on op1, approximated by an extra same-frequency modulator into op1
    const fb = num(p.feedback, 0, 0, 1);
    if (fb > 0.001) {
      const fbo = v.src(ctx.createOscillator());
      fbo.type = 'sine';
      fbo.frequency.value = ops[1].freq;
      detuneTargets.push(fbo.detune);
      const fg = v.node(ctx.createGain());
      fg.gain.value = fb * fb * 2.2 * ops[1].freq;
      fbo.connect(fg); fg.connect(ops[1].osc.frequency);
    }
    // vibrato
    const vd = num(p.vibDepth, 0, 0, 1);
    if (vd > 0.0001) {
      const lfo = v.src(ctx.createOscillator());
      lfo.frequency.value = num(p.vibRate, 5.5, 0.1, 20);
      const lg = v.node(ctx.createGain());
      const delay = num(p.vibDelay, 0.2, 0, 5);
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(vd * 100, t + delay + 0.001);
      lfo.connect(lg);
      for (const d of detuneTargets) lg.connect(d);
    }
    const mixGain = v.node(ctx.createGain());
    mixGain.gain.value = VOICE_SCALE;
    out.connect(mixGain);
    let node = mixGain;
    const td = num(p.tremDepth, 0, 0, 1);
    if (td > 0.001) {
      const trem = v.node(ctx.createGain());
      trem.gain.value = 1 - td / 2;
      const lfo = v.src(ctx.createOscillator());
      lfo.frequency.value = num(p.tremRate, 4.5, 0.1, 20);
      const lg = v.node(ctx.createGain());
      lg.gain.value = td / 2;
      lfo.connect(lg); lg.connect(trem.gain);
      node.connect(trem); node = trem;
    }
    if (extra.pan != null) {
      const pn = v.node(ctx.createStereoPanner());
      pn.pan.value = num(extra.pan, 0, -1, 1);
      node.connect(pn); node = pn;
    }
    node.connect(this.out.input);
    v.startAll(t);
    if (tOff != null) v.stopAt(tOff + (maxRel || 0.3) + 0.03);
    return v;
  }

  _kill(v, t, fade = 0.012) {
    if (v.done || (v.killedAt != null && v.killedAt <= t)) return;
    v.killedAt = t;
    t = Math.max(t, this.ctx.currentTime);
    // fade the summed output (envelopes keep running underneath)
    const g = v.amp.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0, t + fade);
    v.stopAt(t + fade + 0.01);
  }
}
