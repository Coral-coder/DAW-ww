// Tonewheel-style drawbar organ: additive PeriodicWave per registration, percussion,
// key click, scanner vibrato/chorus and a rotary-speaker simulation (instrument-level).
import { clamp, midiToFreq } from '../core/util.js';
import { BaseInstrument, Voice, envNote, getNoiseBuffer, getPeriodicWave, isOffline, num } from './synth.js';
import { exprStage } from './voice-expression.js';

// harmonic numbers relative to the 16' sub-octave (wave fundamental = f/2)
const DRAWBAR_HARMONICS = [1, 3, 2, 4, 6, 8, 10, 12, 16];
export const DRAWBAR_LABELS = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"];
const VIBRATO = {
  off: null,
  v1: { depth: 0.00025, wet: 1, dry: 0 }, v2: { depth: 0.0005, wet: 1, dry: 0 }, v3: { depth: 0.0009, wet: 1, dry: 0 },
  c1: { depth: 0.00025, wet: 0.7, dry: 0.7 }, c2: { depth: 0.0005, wet: 0.7, dry: 0.7 }, c3: { depth: 0.0009, wet: 0.7, dry: 0.7 },
};
const ROTARY_RATES = { off: [0, 0], slow: [0.8, 0.67], fast: [6.7, 5.8] }; // [horn, drum] Hz

// Hammond tonewheels stop at ~5.9 kHz: higher drawbar pitches fold back an octave ("foldback").
const TOP_WHEEL_HZ = 5920;
function drawbarWave(ctx, levels, f0 = 0) {
  const fold = DRAWBAR_HARMONICS.map((h) => {
    let hh = h;
    while (f0 > 0 && hh > 1 && (f0 / 2) * hh > TOP_WHEEL_HZ && hh % 2 === 0) hh /= 2;
    return hh;
  });
  const key = 'organ:' + levels.map((l) => Math.round(l)).join('') + ':' + fold.join(',');
  return getPeriodicWave(ctx, key, () => {
    const real = new Float32Array(17), imag = new Float32Array(17);
    // tonewheel drawbar steps are ~3 dB apart (level 8 = 0 dB, 1 = -21 dB), not linear
    levels.forEach((l, i) => { const lv = clamp(Math.round(l), 0, 8); if (lv) imag[fold[i]] += Math.pow(10, (-3 * (8 - lv)) / 20) * 0.32; });
    return { real, imag, normalize: false };
  });
}

export class OrganInstrument extends BaseInstrument {
  constructor(ctx, output, params, opts) {
    super(ctx, output, params, opts);
    this.type = 'organ';
    this._buildFx();
    this._applyFx(true);
  }

  _levels() {
    const p = this.params;
    const def = [8, 8, 8, 0, 0, 0, 0, 0, 0];
    return DRAWBAR_HARMONICS.map((_, i) => num(p[`db${i + 1}`], def[i], 0, 8));
  }

  _buildFx() {
    const ctx = this.ctx;
    const f = (this.fx = {});
    f.bus = ctx.createGain(); // voices go here
    // vibrato scanner
    f.dry = ctx.createGain(); f.wet = ctx.createGain();
    f.vDelay = ctx.createDelay(0.05); f.vDelay.delayTime.value = 0.003;
    f.vLfo = ctx.createOscillator(); f.vLfo.type = 'triangle'; f.vLfo.frequency.value = 6.9;
    f.vDepth = ctx.createGain(); f.vDepth.gain.value = 0;
    f.vLfo.connect(f.vDepth); f.vDepth.connect(f.vDelay.delayTime);
    f.bus.connect(f.dry); f.bus.connect(f.vDelay); f.vDelay.connect(f.wet);
    f.vibOut = ctx.createGain();
    f.dry.connect(f.vibOut); f.wet.connect(f.vibOut);
    // rotary: horn (highs) + drum (lows), each with AM tremolo, pan sweep and doppler delay
    f.rotDry = ctx.createGain();
    f.rotWet = ctx.createGain();
    f.vibOut.connect(f.rotDry); f.rotDry.connect(this.out.input);
    f.rotWet.connect(this.out.input);
    const mk = (type, freq, rate, panDepth, ampDepth, dop) => {
      const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = freq; flt.Q.value = -3;
      const am = ctx.createGain(); am.gain.value = 1 - ampDepth;
      const pan = ctx.createStereoPanner();
      const dl = ctx.createDelay(0.05); dl.delayTime.value = 0.004;
      const lfo = ctx.createOscillator(); lfo.frequency.value = rate || 0.01;
      const lfoAm = ctx.createGain(); lfoAm.gain.value = ampDepth;
      const lfoPan = ctx.createGain(); lfoPan.gain.value = panDepth;
      const lfoDop = ctx.createGain(); lfoDop.gain.value = dop;
      lfo.connect(lfoAm); lfoAm.connect(am.gain);
      lfo.connect(lfoPan); lfoPan.connect(pan.pan);
      lfo.connect(lfoDop); lfoDop.connect(dl.delayTime);
      f.vibOut.connect(flt); flt.connect(dl); dl.connect(am); am.connect(pan); pan.connect(f.rotWet);
      return { flt, am, pan, dl, lfo, lfoAm, lfoPan, lfoDop };
    };
    f.horn = mk('highpass', 800, 0.8, 0.85, 0.35, 0.0006);
    f.drum = mk('lowpass', 800, 0.67, 0.4, 0.2, 0.0003);
    for (const o of [f.vLfo, f.horn.lfo, f.drum.lfo]) o.start();
    f.rotarySpeed = null;
  }

  _applyFx(initial = false) {
    const f = this.fx; if (!f) return;
    const p = this.params, t = this.ctx.currentTime;
    const vib = VIBRATO[p.vibrato] || null;
    f.dry.gain.setTargetAtTime(vib ? vib.dry : 1, t, 0.02);
    f.wet.gain.setTargetAtTime(vib ? vib.wet : 0, t, 0.02);
    f.vDepth.gain.setTargetAtTime(vib ? vib.depth : 0, t, 0.02);
    const speed = ROTARY_RATES[p.rotary] ? p.rotary : 'off';
    const depth = num(p.rotaryDepth, 0.7, 0, 1);
    const on = speed !== 'off';
    f.rotDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.05);
    f.rotWet.gain.setTargetAtTime(on ? 1 : 0, t, 0.05);
    if (on) {
      const [hr, dr] = ROTARY_RATES[speed];
      // the drum (heavy rotor) accelerates/brakes slower than the horn
      const tcH = initial ? 0.001 : 0.35, tcD = initial ? 0.001 : 1.2;
      f.horn.lfo.frequency.setTargetAtTime(hr, t, tcH);
      f.drum.lfo.frequency.setTargetAtTime(dr, t, tcD);
      f.horn.lfoAm.gain.setTargetAtTime(0.35 * depth, t, 0.05);
      f.horn.am.gain.setTargetAtTime(1 - 0.35 * depth, t, 0.05);
      f.horn.lfoPan.gain.setTargetAtTime(0.85 * depth, t, 0.05);
      f.drum.lfoAm.gain.setTargetAtTime(0.2 * depth, t, 0.05);
      f.drum.am.gain.setTargetAtTime(1 - 0.2 * depth, t, 0.05);
      f.drum.lfoPan.gain.setTargetAtTime(0.4 * depth, t, 0.05);
    }
  }

  onParams() {
    this._applyFx(false);
    // live drawbar changes on sounding voices
    const lv = this._levels();
    const key = lv.map((l) => Math.round(l)).join('');
    if (key !== this._lastKey && this.voices) {
      this._lastKey = key;
      for (const v of this.voices) if (!v.done && v.osc) { try { v.osc.setPeriodicWave(drawbarWave(this.ctx, lv, v.f0)); } catch { /* */ } }
    }
  }

  disposeExtra() {
    const f = this.fx; if (!f) return;
    for (const o of [f.vLfo, f.horn.lfo, f.drum.lfo]) { try { o.stop(); } catch { /* */ } }
    if (isOffline(this.ctx)) return;
    setTimeout(() => {
      const all = [f.bus, f.dry, f.wet, f.vDelay, f.vLfo, f.vDepth, f.vibOut, f.rotDry, f.rotWet,
        ...Object.values(f.horn), ...Object.values(f.drum)];
      for (const n of all) { try { n.disconnect(); } catch { /* */ } }
    }, 100);
  }

  _createVoice(t, pitch, vel, tOff, extra) {
    const ctx = this.ctx, p = this.params;
    const v = new Voice(ctx);
    v.pitch = pitch; v.vel = vel; v.start = t; v.envs = [];
    const f = midiToFreq(pitch + num(p.transpose, 0, -48, 48));
    const osc = v.src(ctx.createOscillator());
    osc.setPeriodicWave(drawbarWave(ctx, this._levels(), f));
    osc.frequency.value = f / 2;
    v.osc = osc; v.f0 = f;
    const amp = v.node(ctx.createGain());
    amp.gain.value = 0;
    osc.connect(amp);
    v.amp = amp;
    const vs = num(p.velSens, 0, 0, 1);
    const peak = 0.42 * (1 - vs + vs * vel);
    v.ampSt = envNote(amp.gain, t, tOff, { a: num(p.attack, 0.004, 0.001, 5), d: 1, s: 1, r: num(p.release, 0.03, 0.005, 10) }, peak, 0);
    v.envs.push([amp.gain, v.ampSt]);
    // percussion: single decaying harmonic
    // Hammond percussion is single-trigger: it only fires when no other key is already held
    const held = [...this.voices].some((o) => !o.done && o !== v && o.start < t - 0.002 && (o.ampSt?.tOff == null || o.ampSt.tOff > t));
    if (p.perc && !held) {
      const po = v.src(ctx.createOscillator());
      po.type = 'sine';
      po.frequency.value = clamp(f * (p.percHarmonic === 'second' ? 2 : 3), 1, ctx.sampleRate / 2);
      const pg = v.node(ctx.createGain());
      const lvl = num(p.percLevel, 0.6, 0, 1) * 0.35 * (0.6 + 0.4 * vel);
      const dec = num(p.percDecay, 0.35, 0.05, 3);
      pg.gain.setValueAtTime(0, t);
      pg.gain.linearRampToValueAtTime(lvl, t + 0.002);
      pg.gain.setTargetAtTime(0, t + 0.002, dec / 4);
      po.connect(pg); pg.connect(amp);
    }
    // key click: short filtered noise burst
    const click = num(p.click, 0.3, 0, 1);
    if (click > 0.001) {
      const ns = v.src(ctx.createBufferSource());
      ns.buffer = getNoiseBuffer(ctx, 'white');
      ns.loop = true;
      const bp = v.node(ctx.createBiquadFilter());
      bp.type = 'bandpass'; bp.frequency.value = clamp(2500 + f, 100, ctx.sampleRate / 2 - 100); bp.Q.value = 0.8;
      const cg = v.node(ctx.createGain());
      cg.gain.setValueAtTime(0, t);
      cg.gain.linearRampToValueAtTime(click * 0.25, t + 0.0008);
      cg.gain.setTargetAtTime(0, t + 0.0008, 0.0025);
      ns.connect(bp); bp.connect(cg); cg.connect(this.fx.bus);
    }
    v.detuneTargets = v.sources.filter((s) => s.detune).map((s) => s.detune); // MPE per-note bend (oscillators)
    v.xs = exprStage(ctx, v, amp, this.fx.bus); // MPE pressure / timbre stage
    v.startAll(t);
    if (tOff != null) v.stopAt(v.ampSt.tOff + v.ampSt.r + 0.03);
    return v;
  }
}
