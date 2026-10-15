// Dynamics effect builders. Receives the shared DSP helpers from effects.js and returns { type: builder }
// entries merged into BUILDERS. A builder is (ctx, sh, env) => { apply(p, immediate), setTempo?(bpm),
// sync?(time), dispose?(), getReduction?(), probe? } — see the comment above BUILDERS in effects.js.
// probe: optional live data for the effect's custom UI (read through engine.getFxProbe(fxId)).
//
// multiband / transient / deesser / expander / dyneq: an AudioWorkletNode (dynamics-worklet.js) driven by k-rate
// AudioParams. The module loads asynchronously: until then the signal passes through a DelayNode of the effect's
// latency (so timing never changes), and `ready` lets offline renders wait for it. Without AudioWorklet support the
// pass-through stays and `error` says why.
// lineq / matcheq: ConvolverNode with a linear-phase kernel (dsp/fir.js), rebuilt when the params change (debounced
// and crossfaded live, immediate offline). Latency (taps − 1) / 2 is reported through latency.js.
import { PROCS } from '../dsp/dynamics-params.js';
import { loadDynamicsWorklet } from '../worklet-loader.js';
import { dynamicsLatencyFrames } from '../dynamics-latency.js';
import { designLinearPhase, firTaps, matchCurve, curveMagFn, MATCH_FREQS } from '../dsp/fir.js';
import { bandsMag } from '../dsp/curve-math.js';

/** Smoothing widths (octaves) of the match EQ's `smoothing` enum. */
export const MATCH_SMOOTHING = { '1/24': 1 / 24, '1/12': 1 / 12, '1/6': 1 / 6, '1/3': 1 / 3, '1/1': 1 };

/** Bands of a linear-phase EQ param set → [{on, type, freq, gain, q}] (also used by the effect card). */
export function linEqBands(p) {
  const out = [];
  for (let k = 1; k <= 8; k++) out.push({ on: !!p[`b${k}On`], type: p[`b${k}Type`], freq: p[`b${k}Freq`], gain: p[`b${k}Gain`], q: p[`b${k}Q`] });
  return out;
}

/** Match EQ correction (dB on MATCH_FREQS) for resolved params + the stored spectra (raw params). */
export function matchCorrection(p, raw) {
  const ref = raw?.refSpectrum, cur = raw?.curSpectrum;
  if (!Array.isArray(ref) || !Array.isArray(cur) || ref.length !== MATCH_FREQS.length || cur.length !== MATCH_FREQS.length) return null;
  return matchCurve(ref, cur, {
    amount: p.amount, smoothing: MATCH_SMOOTHING[p.smoothing] ?? 1 / 6, maxBoost: p.maxBoost, maxCut: p.maxCut, low: p.lowLimit, high: p.highLimit,
  });
}

export default function dynamicsBuilders(H) {
  const { isOffline, setP, dbToGain } = H;

  /**
   * Shared wiring for the worklet effects. opts: { keyed: bool (2nd input = sidechain key), reduction(meter) → dB }.
   */
  function workletEffect(type, opts = {}) {
    const proc = PROCS[type];
    const discrete = new Set(proc.spec.filter((s) => s[2]).map((s) => s[0]));
    return (ctx, sh) => {
      const sr = ctx.sampleRate;
      const out = ctx.createGain();
      out.connect(sh.wet);
      const keyIn = opts.keyed ? ctx.createGain() : null;
      // placeholder until the module is loaded: a pure delay of the effect's latency
      const hold = ctx.createDelay(0.1);
      sh.fxIn.connect(hold); hold.connect(out);
      let node = null, disposed = false, cur = null, enc = null;
      const probe = { type, meter: null, params: null, sampleRate: sr, live: !isOffline(ctx) };
      const api = {
        keyInput: keyIn,
        error: null,
        probe,
        apply(p, im) {
          cur = p;
          probe.params = p;
          enc = proc.encode(p, sr);
          hold.delayTime.value = (dynamicsLatencyFrames({ type, params: p }, sr) || 0) / sr;
          if (!node) return;
          for (const [k, v] of Object.entries(enc)) {
            const prm = node.parameters.get(k);
            if (!prm || !Number.isFinite(v)) continue;
            if (discrete.has(k) || im) { prm.cancelScheduledValues(0); prm.setValueAtTime(v, ctx.currentTime); } else setP(prm, v, ctx, false);
          }
        },
        dispose() {
          disposed = true;
          for (const n of [out, hold, keyIn]) { try { n?.disconnect(); } catch { /* */ } }
          if (node) { try { node.port.postMessage('dispose'); node.port.onmessage = null; node.disconnect(); } catch { /* */ } }
        },
      };
      if (opts.reduction) api.getReduction = () => (probe.meter ? opts.reduction(probe.meter) : 0);
      api.ready = loadDynamicsWorklet(ctx).then((ok) => {
        if (disposed) return true;
        if (!ok) { api.error = 'AudioWorklet unavailable'; return false; }
        try {
          const parameterData = {};
          for (const [k, v] of Object.entries(enc || {})) if (Number.isFinite(v)) parameterData[k] = v;
          node = new AudioWorkletNode(ctx, proc.name, {
            numberOfInputs: keyIn ? 2 : 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
            parameterData, processorOptions: { meter: probe.live },
          });
        } catch (e) { api.error = e?.message || String(e); return false; }
        node.port.onmessage = (e) => { if (e.data?.type === 'meter') probe.meter = e.data; };
        sh.fxIn.connect(node, 0, 0);
        if (keyIn) keyIn.connect(node, 0, 1);
        node.connect(out);
        try { sh.fxIn.disconnect(hold); } catch { /* */ }
        try { hold.disconnect(); } catch { /* */ }
        if (cur) api.apply(cur, true);
        return true;
      });
      return api;
    };
  }

  /** Linear-phase convolution engine: set(key, design) swaps in a new kernel (crossfaded live). */
  function firEngine(ctx, input, output) {
    let conv = null, gain = null, key = null, timer = null;
    const swap = (kernel) => {
      const buf = ctx.createBuffer(1, kernel.length, ctx.sampleRate);
      buf.getChannelData(0).set(kernel);
      const c = ctx.createConvolver();
      c.normalize = false;
      c.buffer = buf;
      const g = ctx.createGain();
      input.connect(c); c.connect(g); g.connect(output);
      if (conv) {
        const now = ctx.currentTime, oc = conv, og = gain;
        g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + 0.05);
        og.gain.setValueAtTime(1, now); og.gain.linearRampToValueAtTime(0, now + 0.05);
        setTimeout(() => { try { input.disconnect(oc); } catch { /* */ } try { oc.disconnect(); og.disconnect(); } catch { /* */ } }, 400);
      }
      conv = c; gain = g;
    };
    return {
      set(k, design, immediate) {
        if (k === key) return;
        key = k;
        clearTimeout(timer);
        if (!conv || immediate || isOffline(ctx)) swap(design());
        else timer = setTimeout(() => swap(design()), 90);
      },
      dispose() {
        clearTimeout(timer);
        for (const n of [conv, gain]) { try { n?.disconnect(); } catch { /* */ } }
      },
    };
  }

  const minOf = (a) => (Array.isArray(a) && a.length ? Math.min(0, ...a) : 0);

  return {
    multiband: workletEffect('multiband', { reduction: (m) => minOf(m.gr) }),
    transient: workletEffect('transient'),
    deesser: workletEffect('deesser', { reduction: (m) => Math.min(0, m.gr || 0) }),
    expander: workletEffect('expander', { keyed: true, reduction: (m) => Math.min(0, m.gr || 0) }),
    dyneq: workletEffect('dyneq', { reduction: (m) => minOf(m.dyn) }),

    lineq(ctx, sh) {
      const out = ctx.createGain();
      out.connect(sh.wet);
      const fir = firEngine(ctx, sh.fxIn, out);
      const probe = { type: 'lineq', bands: null, sampleRate: ctx.sampleRate };
      return {
        probe,
        apply(p, im) {
          const bands = linEqBands(p);
          probe.bands = bands;
          const taps = firTaps(p.quality, ctx.sampleRate);
          const on = bands.filter((b) => b.on);
          fir.set(JSON.stringify([taps, on]), () => designLinearPhase((f) => bandsMag(on, f), taps, ctx.sampleRate), im);
          setP(out.gain, dbToGain(p.output), ctx, im);
        },
        dispose() { fir.dispose(); try { out.disconnect(); } catch { /* */ } },
      };
    },

    matcheq(ctx, sh) {
      const out = ctx.createGain();
      out.connect(sh.wet);
      const fir = firEngine(ctx, sh.fxIn, out);
      const live = !isOffline(ctx);
      // analysers for capturing (live only): this channel's input and the reference key
      const keyIn = ctx.createGain();
      let inAn = null, keyAn = null;
      if (live) {
        inAn = ctx.createAnalyser(); inAn.fftSize = 16384; inAn.smoothingTimeConstant = 0;
        keyAn = ctx.createAnalyser(); keyAn.fftSize = 16384; keyAn.smoothingTimeConstant = 0;
        sh.fxIn.connect(inAn); keyIn.connect(keyAn);
      }
      const probe = { type: 'matcheq', inAnalyser: inAn, keyAnalyser: keyAn, curve: null, sampleRate: ctx.sampleRate };
      return {
        keyInput: keyIn,
        probe,
        apply(p, im, def) {
          const curve = matchCorrection(p, def?.params);
          probe.curve = curve;
          const taps = firTaps(p.quality, ctx.sampleRate);
          const k = JSON.stringify([taps, curve && curve.map((v) => Math.round(v * 100))]);
          fir.set(k, () => designLinearPhase(curve ? curveMagFn(curve) : () => 1, taps, ctx.sampleRate), im);
          setP(out.gain, dbToGain(p.output), ctx, im);
        },
        dispose() {
          fir.dispose();
          for (const n of [out, keyIn, inAn, keyAn]) { try { n?.disconnect(); } catch { /* */ } }
        },
      };
    },
  };
}
