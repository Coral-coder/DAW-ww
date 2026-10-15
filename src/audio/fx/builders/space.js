// Space effect builders: algorithmic + shimmer reverb and granular delay (AudioWorklets, see ../worklets), tape and
// multitap delay (native nodes). Receives the shared DSP helpers from effects.js and returns { type: builder } entries
// merged into BUILDERS. A builder is (ctx, sh, env) => { apply(p, immediate), setTempo?(bpm), sync?(time), dispose?(),
// getReduction?(), probe?, ready? } — see the comment above BUILDERS in effects.js. `ready` (worklet effects) resolves
// once the processor is in place, so offline renders wait for it (awaitPluginsReady).
import { makeKit } from '../kit.js';
import { REVERB_MODE_NAMES } from '../dsp/reverb.js';
import { GRAIN_WINDOWS } from '../dsp/granular.js';
import { MULTITAP_COUNT } from '../defs/space.js';
import { OVERSAMPLE_FRAMES } from '../../latency.js';

const SHIMMER_VALUES = ['12', '7', '5', '-12', '19', '24', '12+7', '12-12'];

export default function spaceBuilders(H) {
  const { setP, stereoGain, makeSpaceImpulse, makeCurve, divisionToBeats, clamp, dbToGain, cachedBuffer } = H;
  const { Lfo, workletFx, idx } = makeKit(H);

  /** Native stand-in while / if the worklet is unavailable: a convolution space from the effect's parameters. */
  const convFallback = (ctx) => (input, output) => {
    const conv = ctx.createConvolver();
    conv.normalize = true;
    input.connect(conv); conv.connect(output);
    let key = '';
    return {
      update(p) {
        const k = `${p.decay}|${p.size}|${p.damping}|${p.mode}`;
        if (k === key) return;
        key = k;
        const ch = p.mode === 'spring' ? 'plate' : p.mode === 'room' || p.mode === 'chamber' || p.mode === 'plate' ? p.mode : 'hall';
        conv.buffer = makeSpaceImpulse(ctx, clamp(p.decay, 0.1, 12), p.size, p.damping, ch);
      },
      dispose() { try { input.disconnect(conv); } catch { /* */ } try { conv.disconnect(); } catch { /* */ } },
    };
  };

  /** Reverb block shared by algoReverb and shimmer: worklet -> low cut -> high cut -> wet. */
  function reverbBlock(ctx, sh, shimmer) {
    let fb = null;
    const make = convFallback(ctx);
    const w = workletFx(ctx, 'daw3-fx-reverb', { processorOptions: { shimmer }, fallback: (i, o) => (fb = make(i, o)) });
    const lo = ctx.createBiquadFilter(); lo.type = 'highpass'; lo.Q.value = 0.6;
    const hi = ctx.createBiquadFilter(); hi.type = 'lowpass'; hi.Q.value = 0.6;
    sh.fxIn.connect(w.input); w.output.connect(lo); lo.connect(hi); hi.connect(sh.wet);
    return {
      w,
      apply(p, im) {
        if (!w.active) fb?.update(p);
        w.set('mode', idx(REVERB_MODE_NAMES, p.mode), im, true);
        w.set('size', p.size, im);
        w.set('decay', p.decay, im, true);
        w.set('predelay', p.predelay, im);
        w.set('diffusion', p.diffusion, im);
        w.set('damping', p.damping, im);
        w.set('mod', p.mod, im);
        w.set('balance', p.balance ?? 0.9, im);
        w.set('freeze', p.freeze ? 1 : 0, im, true);
        w.set('width', p.width, im);
        setP(lo.frequency, p.lowcut <= 21 ? 10 : p.lowcut, ctx, im);
        setP(hi.frequency, p.highcut, ctx, im);
      },
      dispose() { w.dispose(); },
    };
  }

  // looping smooth random curve (sum of incommensurate sines over one cycle): tape drift
  const driftBuffer = (ctx) => cachedBuffer(ctx, 'tape-drift', (ph) => 0.55 * Math.sin(2 * Math.PI * (ph + 0.13)) + 0.3 * Math.sin(2 * Math.PI * (3 * ph + 0.71)) + 0.15 * Math.sin(2 * Math.PI * (7 * ph + 0.29)));

  return {
    algoReverb(ctx, sh) {
      const rb = reverbBlock(ctx, sh, false);
      return { apply: (p, im) => rb.apply(p, im), ready: rb.w.ready, dispose: () => rb.dispose() };
    },

    shimmer(ctx, sh) {
      const rb = reverbBlock(ctx, sh, true);
      return {
        apply(p, im) {
          rb.apply({ ...p, balance: 0.92 }, im);
          rb.w.set('shimmer', p.amount, im);
          rb.w.set('interval', Math.max(0, SHIMMER_VALUES.indexOf(String(p.interval))), im, true);
          rb.w.set('tone', p.tone, im);
        },
        ready: rb.w.ready,
        dispose: () => rb.dispose(),
      };
    },

    tapeDelay(ctx, sh, env) {
      const inSt = stereoGain(ctx);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      sh.fxIn.connect(inSt); inSt.connect(split);
      const osFrames = OVERSAMPLE_FRAMES['2x'];
      const wow = new Lfo(ctx, H.shapeBuffer(ctx, 'sine'));
      const flutter = new Lfo(ctx, H.shapeBuffer(ctx, 'triangle'));
      const drift = new Lfo(ctx, driftBuffer(ctx));
      flutter.setHz(6.3); drift.setHz(0.11);
      const wowAmt = ctx.createGain(), flAmt = ctx.createGain(), drAmt = ctx.createGain();
      wow.out.connect(wowAmt); flutter.out.connect(flAmt); drift.out.connect(drAmt);
      const chans = [0, 1].map((c) => {
        const sum = ctx.createGain();
        const d = ctx.createDelay(5);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.5;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
        const bump = ctx.createBiquadFilter(); bump.type = 'peaking'; bump.frequency.value = 110; bump.Q.value = 0.9;
        const sat = ctx.createWaveShaper(); sat.oversample = '2x';
        const fb = ctx.createGain();
        split.connect(sum, c);
        sum.connect(d); d.connect(hp); hp.connect(lp); lp.connect(bump); bump.connect(sat); sat.connect(fb); fb.connect(sum);
        sat.connect(merge, 0, c);
        wowAmt.connect(d.delayTime); flAmt.connect(d.delayTime); drAmt.connect(d.delayTime);
        return { sum, d, hp, lp, bump, sat, fb };
      });
      merge.connect(sh.wet);
      let cur = null;
      let satKey = null;
      const api = {
        apply(p, im) {
          cur = p;
          if (satKey !== p.saturation) {
            satKey = p.saturation;
            const g = dbToGain(0.6 * p.saturation);
            // unity small-signal gain (Feedback means what it says), soft ceiling at 1/g: more saturation = earlier,
            // rounder compression of every repeat — and a bounded loop, so feedback > 100 % self-oscillates safely
            const curve = makeCurve((x) => Math.tanh(x * g) / g, 4096);
            for (const ch of chans) ch.sat.curve = curve;
          }
          const age = p.age;
          for (const ch of chans) {
            setP(ch.fb.gain, p.feedback, ctx, im);
            setP(ch.lp.frequency, 14000 * Math.pow(2500 / 14000, age), ctx, im);
            setP(ch.hp.frequency, 40 + 260 * age, ctx, im);
            setP(ch.bump.gain, 2.5 * (1 - age) + 1, ctx, im);
          }
          wow.setHz(p.wowRate);
          setP(wowAmt.gain, p.wow * 0.0025, ctx, im);
          setP(flAmt.gain, p.flutter * 0.00025, ctx, im);
          setP(drAmt.gain, p.drift * 0.0015, ctx, im);
          api.setTempo(env.getBpm(), im);
        },
        setTempo(bpm, im) {
          if (!cur) return;
          const t = clamp(cur.sync ? (divisionToBeats(cur.division) * 60) / bpm : cur.time, 0.02, 4.5);
          const comp = osFrames / ctx.sampleRate; // the oversampled shaper's own delay is part of every repeat
          setP(chans[0].d.delayTime, Math.max(0.005, t - comp), ctx, im);
          setP(chans[1].d.delayTime, Math.max(0.005, t * (1 + 0.12 * cur.spread) - comp), ctx, im);
        },
        dispose() { wow.dispose(); flutter.dispose(); drift.dispose(); },
      };
      return api;
    },

    multitap(ctx, sh, env) {
      // taps read a mono sum (so each tap can be panned anywhere)
      const sum = ctx.createGain(); sum.channelCount = 1; sum.channelCountMode = 'explicit'; sum.channelInterpretation = 'speakers';
      sh.fxIn.connect(sum);
      const loop = ctx.createDelay(8.5);
      const fbHp = ctx.createBiquadFilter(); fbHp.type = 'highpass'; fbHp.Q.value = 0.5;
      const fbLp = ctx.createBiquadFilter(); fbLp.type = 'lowpass'; fbLp.Q.value = 0.5;
      const fb = ctx.createGain();
      sum.connect(loop); loop.connect(fbHp); fbHp.connect(fbLp); fbLp.connect(fb); fb.connect(sum);
      const out = ctx.createGain();
      out.connect(sh.wet);
      const taps = Array.from({ length: MULTITAP_COUNT }, () => {
        const d = ctx.createDelay(8.5);
        const f = ctx.createBiquadFilter(); f.Q.value = 0.8;
        const g = ctx.createGain();
        const pan = ctx.createStereoPanner();
        sum.connect(d); g.connect(pan); pan.connect(out);
        return { d, f, g, pan, wired: null };
      });
      let cur = null;
      const lengthSec = (p, bpm) => clamp(p.sync ? (divisionToBeats(p.division) * 60) / bpm : p.length, 0.02, 8);
      const api = {
        apply(p, im) {
          cur = p;
          taps.forEach((t, j) => {
            const i = j + 1;
            const ft = p[`t${i}Filter`];
            if (t.wired !== ft) {
              t.wired = ft;
              try { t.d.disconnect(); } catch { /* */ }
              try { t.f.disconnect(); } catch { /* */ }
              if (ft === 'off') t.d.connect(t.g);
              else { t.f.type = ft; t.d.connect(t.f); t.f.connect(t.g); }
            }
            setP(t.f.frequency, p[`t${i}Freq`], ctx, im);
            setP(t.g.gain, p[`t${i}On`] ? p[`t${i}Level`] : 0, ctx, im);
            setP(t.pan.pan, p[`t${i}Pan`], ctx, im);
          });
          setP(fb.gain, p.feedback, ctx, im);
          setP(fbHp.frequency, p.fbLowcut, ctx, im);
          setP(fbLp.frequency, p.fbHighcut, ctx, im);
          api.setTempo(env.getBpm(), im);
        },
        setTempo(bpm, im) {
          if (!cur) return;
          const L = lengthSec(cur, bpm);
          setP(loop.delayTime, L, ctx, im);
          taps.forEach((t, j) => setP(t.d.delayTime, clamp(cur[`t${j + 1}Pos`], 0, 1) * L, ctx, im));
        },
        /** For the tap editor: current pattern length in seconds. */
        probe: { length: () => (cur ? lengthSec(cur, env.getBpm()) : 1) },
      };
      return api;
    },

    grainDelay(ctx, sh, env) {
      let fbDelay = null;
      const w = workletFx(ctx, 'daw3-fx-grain', {
        processorOptions: { seed: 12345 },
        fallback: (i, o) => { fbDelay = ctx.createDelay(4.5); i.connect(fbDelay); fbDelay.connect(o); return { dispose: () => { try { i.disconnect(fbDelay); } catch { /* */ } } }; },
      });
      sh.fxIn.connect(w.input); w.output.connect(sh.wet);
      let cur = null;
      const api = {
        apply(p, im) {
          cur = p;
          w.set('size', p.size, im);
          w.set('pitch', p.pitch, im);
          w.set('pitchRand', p.pitchRand, im);
          w.set('spread', p.spread, im);
          w.set('pan', p.pan, im);
          w.set('reverse', p.reverse, im);
          w.set('feedback', p.feedback, im);
          w.set('freeze', p.freeze ? 1 : 0, im, true);
          w.set('window', idx(GRAIN_WINDOWS, p.window), im, true);
          w.set('tone', p.tone, im);
          api.setTempo(env.getBpm(), im);
        },
        setTempo(bpm, im) {
          if (!cur) return;
          const t = clamp(cur.sync ? (divisionToBeats(cur.division) * 60) / bpm : cur.time, 0.005, 4);
          w.set('time', t, im);
          const dens = cur.densitySync ? bpm / 60 / divisionToBeats(cur.grainDivision) : cur.density;
          w.set('density', clamp(dens, 0.2, 200), im, true);
          if (fbDelay) setP(fbDelay.delayTime, t, ctx, im);
        },
        ready: w.ready,
        dispose() { w.dispose(); },
      };
      return api;
    },
  };
}

