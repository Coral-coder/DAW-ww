// Character effect builders: pitch shifter / harmonizer, formant shifter, vocoder, frequency shifter, resonator and
// envelope filter (AudioWorklets, see ../worklets), ring modulator, Distortion+, mid/side tool and Haas widener
// (native nodes). Receives the shared DSP helpers from effects.js and returns { type: builder } entries merged into
// BUILDERS. A builder is (ctx, sh, env) => { apply(p, immediate), setTempo?(bpm), sync?(time), dispose?(),
// getReduction?(), probe?, ready?, keyInput? } — see the comment above BUILDERS in effects.js.
import { makeKit } from '../kit.js';
import { SCALE_NAMES, VOCODER_WAVES } from '../dsp/voice.js';
import { shifterLatency } from '../dsp/pitch.js';
import { CHORD_NAMES, midiToHz } from '../dsp/common.js';
import { SHIFT_DIRECTIONS, RESONATOR_TYPES, WAH_TYPES, shapeCurve, shapeFn, msPlan } from '../dsp/character.js';
import { OVERSAMPLE_FRAMES, lookaheadTime } from '../../latency.js';

export default function characterBuilders(H) {
  const { setP, stereoGain, clamp, dbToGain, lfoRate, syncLfo, shapeBuffer } = H;
  const { Lfo, workletFx, idx } = makeKit(H);

  /** Route the shell's dry path through a delay (latency-matched dry / wet mix). */
  function delayDry(ctx, sh) {
    const d = ctx.createDelay(1);
    try { sh.fxIn.disconnect(sh.dry); } catch { /* */ }
    sh.fxIn.connect(d); d.connect(sh.dry);
    return { set: (frames) => setP(d.delayTime, lookaheadTime(frames / ctx.sampleRate, ctx.sampleRate), ctx, true) };
  }
  /** Fallback for latent worklet effects: a plain delay of the reported latency (keeps PDC truthful). */
  const delayFallback = (ctx, holder) => (i, o) => {
    const d = ctx.createDelay(1);
    holder.d = d;
    i.connect(d); d.connect(o);
    return { dispose: () => { holder.d = null; try { i.disconnect(d); } catch { /* */ } } };
  };
  /** Analyser pair on a stereo node for correlation / balance displays (probe). */
  function stereoProbe(ctx, node) {
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = 2048; aR.fftSize = 2048;
    node.connect(split); split.connect(aL, 0); split.connect(aR, 1);
    return { left: aL, right: aR };
  }

  return {
    // ------------------------------------------------------------------------- Pitch & Voice
    pitchShift(ctx, sh) {
      const hold = {};
      const w = workletFx(ctx, 'daw3-fx-pitch', { fallback: delayFallback(ctx, hold) });
      sh.fxIn.connect(w.input); w.output.connect(sh.wet);
      const dry = delayDry(ctx, sh);
      let mode = null;
      return {
        apply(p, im) {
          const m = p.latency === 'low' ? 'low' : 'quality';
          if (m !== mode) {
            mode = m;
            const frames = shifterLatency(m, ctx.sampleRate);
            dry.set(frames);
            if (hold.d) setP(hold.d.delayTime, frames / ctx.sampleRate, ctx, true);
          }
          w.set('quality', m === 'quality' ? 1 : 0, im, true);
          w.set('semis', p.semis, im);
          w.set('cents', p.cents, im);
          w.set('level1', p.level1, im);
          w.set('formant', p.formant ? 1 : 0, im, true);
          w.set('scaleMode', p.harmony === 'scale' ? 1 : 0, im, true);
          w.set('key', Number(p.key) || 0, im, true);
          w.set('scale', idx(SCALE_NAMES, p.scale), im, true);
          for (const v of [2, 3]) {
            w.set(`v${v}On`, p[`v${v}On`] ? 1 : 0, im, true);
            w.set(`v${v}Int`, p[`v${v}Int`], im, true);
            w.set(`v${v}Level`, p[`v${v}Level`], im);
            w.set(`v${v}Pan`, p[`v${v}Pan`], im);
          }
        },
        ready: w.ready,
        dispose() { w.dispose(); },
      };
    },

    formantShift(ctx, sh) {
      const hold = {};
      const w = workletFx(ctx, 'daw3-fx-formant', { fallback: delayFallback(ctx, hold) });
      const out = ctx.createGain();
      sh.fxIn.connect(w.input); w.output.connect(out); out.connect(sh.wet);
      const dry = delayDry(ctx, sh);
      let lat = null;
      return {
        apply(p, im) {
          const frames = Math.abs(p.pitch) >= 0.5 ? shifterLatency('low', ctx.sampleRate) : 0;
          if (frames !== lat) { lat = frames; dry.set(frames); if (hold.d) setP(hold.d.delayTime, frames / ctx.sampleRate, ctx, true); }
          w.set('shift', p.shift, im);
          w.set('pitch', Math.abs(p.pitch) >= 0.5 ? p.pitch : 0, im, true);
          setP(out.gain, dbToGain(p.output), ctx, im);
        },
        ready: w.ready,
        dispose() { w.dispose(); },
      };
    },

    vocoder(ctx, sh) {
      const w = workletFx(ctx, 'daw3-fx-vocoder');
      sh.fxIn.connect(w.input); w.output.connect(sh.wet);
      return {
        keyInput: w.key,
        apply(p, im) {
          w.set('carrier', p.carrier === 'sidechain' ? 1 : 0, im, true);
          w.set('wave', idx(VOCODER_WAVES, p.wave), im, true);
          w.set('note', p.note, im, true);
          w.set('chord', idx(CHORD_NAMES, p.chord), im, true);
          w.set('detune', p.detune, im, true);
          w.set('bands', Number(p.bands) || 16, im, true);
          w.set('lo', p.lo, im, true);
          w.set('hi', p.hi, im, true);
          w.set('bw', p.bw, im, true);
          w.set('formant', p.formant, im, true);
          w.set('attack', p.attack, im, true);
          w.set('release', p.release, im, true);
          w.set('noise', p.noise, im);
          w.set('sibilance', p.sibilance, im);
          w.set('emphasis', p.emphasis, im);
          w.set('spread', p.spread, im, true);
          w.set('output', p.output, im);
        },
        ready: w.ready,
        dispose() { w.dispose(); },
      };
    },

    // ------------------------------------------------------------------------- Modulation
    freqShift(ctx, sh, env) {
      const w = workletFx(ctx, 'daw3-fx-freqshift');
      sh.fxIn.connect(w.input); w.output.connect(sh.wet);
      const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
      const depth = ctx.createGain(); depth.gain.value = 0;
      lfo.out.connect(depth);
      w.link('mod', depth);
      let cur = null;
      const api = {
        apply(p, im) {
          cur = p;
          w.set('shift', p.shift + p.fine, im);
          w.set('direction', idx(SHIFT_DIRECTIONS, p.direction), im, true);
          w.set('feedback', p.feedback, im);
          setP(depth.gain, p.lfoDepth, ctx, im);
          lfo.setShape(p.shape);
          api.setTempo(env.getBpm());
        },
        setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
        sync(time) { syncLfo(lfo, cur, env, time); },
        ready: w.ready,
        dispose() { lfo.dispose(); w.dispose(); },
      };
      return api;
    },

    ringMod(ctx, sh, env) {
      const inSt = stereoGain(ctx);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      sh.fxIn.connect(inSt); inSt.connect(split);
      const lfo = new Lfo(ctx, shapeBuffer(ctx, 'sine'));
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0;
      lfo.out.connect(lfoAmt);
      const sides = [0, 1].map((c) => {
        const vca = ctx.createGain(); vca.gain.value = 0;
        const osc = ctx.createOscillator();
        const oscAmt = ctx.createGain();
        osc.connect(oscAmt); oscAmt.connect(vca.gain);
        lfoAmt.connect(osc.detune);
        split.connect(vca, c); vca.connect(merge, 0, c);
        osc.start();
        return { vca, osc, oscAmt };
      });
      merge.connect(sh.wet);
      let cur = null;
      const api = {
        apply(p, im) {
          cur = p;
          const base = p.tracking === 'note' ? midiToHz(p.note) : p.freq;
          const f = base * Math.pow(2, p.fine / 1200);
          sides.forEach((s, c) => {
            if (s.osc.type !== p.wave) s.osc.type = p.wave;
            setP(s.osc.frequency, Math.max(0.01, f + (c ? p.spread : 0)), ctx, im);
            // ring: x·carrier; AM: x·(½ + ½·carrier)
            setP(s.vca.gain, p.am * 0.5, ctx, im);
            setP(s.oscAmt.gain, 1 - p.am * 0.5, ctx, im);
          });
          setP(lfoAmt.gain, p.lfoDepth * 100, ctx, im);
          lfo.setShape(p.shape);
          api.setTempo(env.getBpm());
        },
        setTempo(bpm) { if (cur) lfo.setHz(lfoRate(cur, bpm).hz); },
        sync(time) { syncLfo(lfo, cur, env, time); },
        dispose() { lfo.dispose(); for (const s of sides) { try { s.osc.stop(); } catch { /* */ } } },
      };
      return api;
    },

    // ------------------------------------------------------------------------- EQ & Filter
    resonator(ctx, sh) {
      const w = workletFx(ctx, 'daw3-fx-resonator');
      const out = ctx.createGain();
      sh.fxIn.connect(w.input); w.output.connect(out); out.connect(sh.wet);
      return {
        apply(p, im) {
          w.set('note', p.note, im, true);
          w.set('chord', idx(CHORD_NAMES, p.chord), im, true);
          w.set('tune', p.tune, im, true);
          w.set('decay', p.decay, im, true);
          w.set('bright', p.bright, im, true);
          w.set('type', idx(RESONATOR_TYPES, p.type), im, true);
          w.set('spread', p.spread, im, true);
          setP(out.gain, dbToGain(p.output), ctx, im);
        },
        ready: w.ready,
        dispose() { w.dispose(); },
      };
    },

    autoWah(ctx, sh) {
      const w = workletFx(ctx, 'daw3-fx-autowah');
      sh.fxIn.connect(w.input); w.output.connect(sh.wet);
      return {
        apply(p, im) {
          w.set('sens', p.sens, im);
          w.set('attack', p.attack, im, true);
          w.set('release', p.release, im, true);
          w.set('cutoff', p.cutoff, im);
          w.set('range', p.range, im);
          w.set('type', idx(WAH_TYPES, p.type), im, true);
          w.set('q', p.q, im);
        },
        ready: w.ready,
        dispose() { w.dispose(); },
      };
    },

    // ------------------------------------------------------------------------- Distortion
    distortionPlus(ctx, sh) {
      const preHp = ctx.createBiquadFilter(); preHp.type = 'highpass'; preHp.Q.value = 0.6;
      const preLp = ctx.createBiquadFilter(); preLp.type = 'lowpass'; preLp.Q.value = 0.6;
      const shaper = ctx.createWaveShaper();
      const hold = ctx.createDelay(0.01); hold.delayTime.value = 0; // sample & hold (downsample)
      const dc = ctx.createBiquadFilter(); dc.type = 'highpass'; dc.frequency.value = 10;
      const postHp = ctx.createBiquadFilter(); postHp.type = 'highpass'; postHp.Q.value = 0.6;
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.5;
      const out = ctx.createGain();
      sh.fxIn.connect(preHp); preHp.connect(preLp); preLp.connect(shaper); shaper.connect(hold); hold.connect(dc);
      dc.connect(postHp); postHp.connect(tone); tone.connect(out); out.connect(sh.wet);
      const dry = delayDry(ctx, sh);
      let curveKey = '', os = null, dsKey = null, ramp = null, comp = 1;
      return {
        apply(p, im) {
          const k = `${p.shape}|${p.drive}|${p.stages}|${p.bias}`;
          if (k !== curveKey) {
            curveKey = k;
            const o = { stages: Math.round(p.stages), bias: p.bias };
            const g = dbToGain(p.drive);
            shaper.curve = shapeCurve(p.shape, g, o);
            // loudness compensation: RMS of a -9 dBFS sine through the curve vs. the sine itself
            const f = shapeFn(p.shape, g, o);
            let s = 0;
            for (let i = 0; i < 256; i++) { const y = f(0.354 * Math.sin((2 * Math.PI * i) / 256)); s += y * y; }
            comp = clamp(0.25 / Math.max(1e-4, Math.sqrt(s / 256)), 0.08, 1.5);
          }
          if (p.oversample !== os) { os = p.oversample; shaper.oversample = os; dry.set(OVERSAMPLE_FRAMES[os] || 0); }
          const ds = Math.max(1, Math.round(p.downsample));
          if (ds !== dsKey) {
            dsKey = ds;
            if (ramp) { try { ramp.stop(); ramp.disconnect(); } catch { /* */ } ramp = null; }
            if (ds > 1) {
              const b = ctx.createBuffer(1, ds, ctx.sampleRate);
              const d = b.getChannelData(0);
              for (let i = 0; i < ds; i++) d[i] = i / ctx.sampleRate;
              ramp = ctx.createBufferSource(); ramp.buffer = b; ramp.loop = true;
              ramp.connect(hold.delayTime); ramp.start();
            }
          }
          setP(preHp.frequency, p.preHp <= 21 ? 5 : p.preHp, ctx, im);
          setP(preLp.frequency, p.preLp, ctx, im);
          setP(postHp.frequency, p.postHp <= 21 ? 5 : p.postHp, ctx, im);
          setP(tone.frequency, p.tone, ctx, im);
          setP(out.gain, dbToGain(p.output) * comp, ctx, im);
        },
        dispose() { if (ramp) { try { ramp.stop(); } catch { /* */ } } },
      };
    },

    // ------------------------------------------------------------------------- Stereo
    msTool(ctx, sh) {
      const inSt = stereoGain(ctx);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const mid = ctx.createGain(), side = ctx.createGain();
      const sideHp = ctx.createBiquadFilter(); sideHp.type = 'highpass'; sideHp.Q.value = 0.7;
      const gM = ctx.createGain(), gS = ctx.createGain();
      const inG = [0, 1, 2, 3].map(() => ctx.createGain());
      const outG = [0, 1, 2, 3].map(() => ctx.createGain());
      const out = ctx.createGain();
      sh.fxIn.connect(inSt); inSt.connect(split);
      // in matrix: [a b; c d] -> mid = a·L + b·R, side = c·L + d·R
      split.connect(inG[0], 0); split.connect(inG[1], 1); inG[0].connect(mid); inG[1].connect(mid);
      split.connect(inG[2], 0); split.connect(inG[3], 1); inG[2].connect(side); inG[3].connect(side);
      mid.connect(gM); side.connect(sideHp); sideHp.connect(gS);
      // out matrix: out0 = a·M + b·S, out1 = c·M + d·S
      gM.connect(outG[0]); gS.connect(outG[1]); outG[0].connect(merge, 0, 0); outG[1].connect(merge, 0, 0);
      gM.connect(outG[2]); gS.connect(outG[3]); outG[2].connect(merge, 0, 1); outG[3].connect(merge, 0, 1);
      merge.connect(out); out.connect(sh.wet);
      const probe = stereoProbe(ctx, out);
      return {
        apply(p, im) {
          const plan = msPlan({ mode: p.mode, gainM: dbToGain(p.mid), gainS: dbToGain(p.side), solo: p.solo, mono: p.mono, swap: p.swap });
          plan.inM.forEach((v, i) => setP(inG[i].gain, v, ctx, im));
          plan.outM.forEach((v, i) => setP(outG[i].gain, v, ctx, im));
          setP(gM.gain, plan.gm, ctx, im); setP(gS.gain, plan.gs, ctx, im);
          setP(sideHp.frequency, p.sideHp <= 21 ? 5 : p.sideHp, ctx, im);
          setP(out.gain, dbToGain(p.output), ctx, im);
        },
        probe,
      };
    },

    haas(ctx, sh) {
      const inSt = stereoGain(ctx);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      sh.fxIn.connect(inSt); inSt.connect(split);
      // per side: out = g·LP(x) + level·delay(x − g·LP(x)) — g = 1 keeps the lows un-delayed (mono guard)
      const chans = [0, 1].map((c) => {
        const x = ctx.createGain();
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = Math.SQRT1_2;
        const lpOut = ctx.createGain(), lpNeg = ctx.createGain();
        const hi = ctx.createGain();
        const d = ctx.createDelay(0.05);
        const lvl = ctx.createGain();
        const o = ctx.createGain();
        split.connect(x, c);
        x.connect(lp); lp.connect(lpOut); lp.connect(lpNeg);
        x.connect(hi); lpNeg.connect(hi); hi.connect(d); d.connect(lvl); lvl.connect(o); lpOut.connect(o);
        o.connect(merge, 0, c);
        return { lp, lpOut, lpNeg, d, lvl };
      });
      const bal = ctx.createStereoPanner();
      merge.connect(bal); bal.connect(sh.wet);
      const probe = stereoProbe(ctx, bal);
      return {
        apply(p, im) {
          const di = p.side === 'left' ? 0 : 1;
          chans.forEach((ch, c) => {
            const delayed = c === di;
            const g = p.guard ? 1 : 0;
            setP(ch.lp.frequency, p.guardFreq, ctx, im);
            setP(ch.lpOut.gain, g, ctx, im); setP(ch.lpNeg.gain, -g, ctx, im);
            setP(ch.d.delayTime, delayed ? p.delay / 1000 : 0, ctx, im);
            setP(ch.lvl.gain, delayed ? dbToGain(p.level) : 1, ctx, im);
          });
          setP(bal.pan, p.balance, ctx, im);
        },
        probe,
      };
    },
  };
}
