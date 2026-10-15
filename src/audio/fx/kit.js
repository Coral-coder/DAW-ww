// Building blocks for the space / character effect builders: a worklet-backed processing block with a native
// fallback, and a phase-controllable LFO (looping one-cycle buffer: tempo-syncable, identical offline).
import { FX_PROCESSORS } from './dsp/specs.js';
import { loadFxWorklet } from './worklet-loader.js';

export function makeKit(H) {
  const { setP, stereoGain, shapeBuffer } = H;

  /** Phase-controllable LFO (same contract as effects.js' Lfo: works with H.syncLfo). `out` emits -1..1. */
  class Lfo {
    constructor(ctx, buffer) {
      this.ctx = ctx; this.out = ctx.createGain(); this.buffer = buffer; this.hz = 1; this.sources = [];
      this.t0 = ctx.currentTime; this.ph0 = 0;
      this.start(ctx.currentTime, 0);
    }
    _rate(hz) { return (hz * this.buffer.length) / this.buffer.sampleRate; }
    phaseAt(t) { return this.ph0 + (t - this.t0) * this.hz; }
    start(when, phase) {
      const { ctx } = this;
      when = Math.max(when, ctx.currentTime);
      for (const s of this.sources) { try { s.stop(when); } catch { /* not started */ } }
      const s = ctx.createBufferSource();
      s.buffer = this.buffer; s.loop = true;
      s.playbackRate.value = this._rate(this.hz);
      s.connect(this.out);
      const ph = ((phase % 1) + 1) % 1;
      s.start(when, ph * this.buffer.duration);
      s.onended = () => { try { s.disconnect(); } catch { /* */ } this.sources = this.sources.filter((x) => x !== s); };
      this.sources.push(s);
      this.t0 = when; this.ph0 = ph;
    }
    setHz(hz) {
      hz = Math.max(0.0001, hz);
      if (Math.abs(hz - this.hz) < 1e-9) return;
      const now = this.ctx.currentTime;
      this.ph0 = this.phaseAt(now); this.t0 = now; this.hz = hz;
      for (const s of this.sources) setP(s.playbackRate, this._rate(hz), this.ctx, true);
    }
    setShape(shape) {
      const b = shapeBuffer(this.ctx, shape);
      if (b === this.buffer) return;
      const ph = this.phaseAt(this.ctx.currentTime);
      this.buffer = b;
      this.start(this.ctx.currentTime, ph);
    }
    dispose() {
      for (const s of this.sources) { try { s.stop(); } catch { /* */ } try { s.disconnect(); } catch { /* */ } }
      this.sources = [];
      try { this.out.disconnect(); } catch { /* */ }
    }
  }

  /**
   * A processor from fx-processors.js between `input` (stereo) and `output`. Until (or unless) the worklet module
   * loads, `fallback(input, output)` (default: straight through) carries the signal. set(name, value, immediate,
   * discrete) drives the processor's AudioParams (remembered and passed as parameterData when the node is created).
   * `ready` resolves once the node is in place (true either way: the fallback keeps the effect usable).
   */
  function workletFx(ctx, processor, o = {}) {
    const spec = FX_PROCESSORS[processor];
    const input = stereoGain(ctx);
    const output = ctx.createGain();
    const key = (spec.inputs || 1) > 1 ? stereoGain(ctx) : null;
    const vals = {};
    const paramLinks = []; // [name, sourceNode]
    let node = null, disposed = false;
    let fb = o.fallback ? o.fallback(input, output) : null;
    if (!fb) { input.connect(output); fb = { dispose: () => { try { input.disconnect(output); } catch { /* */ } } }; }
    const ready = loadFxWorklet(ctx).then((ok) => {
      if (disposed || !ok) return true;
      try {
        const parameterData = {};
        for (const k of spec.params) if (Number.isFinite(vals[k])) parameterData[k] = vals[k];
        node = new AudioWorkletNode(ctx, processor, {
          numberOfInputs: spec.inputs || 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          parameterData, processorOptions: o.processorOptions || {},
        });
      } catch (e) {
        console.warn('[fx] could not create', processor, e?.message || e);
        return true;
      }
      input.connect(node, 0, 0);
      if (key) key.connect(node, 0, 1);
      node.connect(output);
      for (const [k, src] of paramLinks) src.connect(node.parameters.get(k));
      fb.dispose();
      return true;
    });
    return {
      input, output, key, ready,
      get node() { return node; },
      get active() { return !!node; },
      set(name, value, immediate = false, discrete = false) {
        if (!Number.isFinite(value)) return;
        vals[name] = value;
        const prm = node?.parameters.get(name);
        if (prm) setP(prm, value, ctx, immediate || discrete);
      },
      /** Connect a modulation source (e.g. an LFO gain) to an a-rate AudioParam of the processor. */
      link(name, src) { paramLinks.push([name, src]); if (node) src.connect(node.parameters.get(name)); },
      dispose() {
        disposed = true;
        try { fb.dispose(); } catch { /* */ }
        try { node?.disconnect(); } catch { /* */ }
        try { node?.port.postMessage({ type: 'dispose' }); } catch { /* */ }
      },
    };
  }

  /** Index of value in an option list (enum params -> processor numbers). */
  const idx = (list, v) => Math.max(0, list.indexOf(v));

  return { Lfo, workletFx, idx };
}
