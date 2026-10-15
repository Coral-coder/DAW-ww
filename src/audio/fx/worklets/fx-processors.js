// AudioWorklet processors of the space / pitch & voice / character effects (loaded by src/audio/fx/fx-worklet-loader.js
// into realtime and offline contexts alike). Each one wraps a pure-JS engine from ../dsp; parameters arrive as
// AudioParams (names in ../dsp/specs.js), so automation is sample-block accurate and renders deterministically.
import { FX_PROCESSORS } from '../dsp/specs.js';
import { FdnReverb } from '../dsp/reverb.js';
import { GrainCloud } from '../dsp/granular.js';
import { HarmonizerEngine, FormantEngine, VocoderEngine } from '../dsp/voice.js';
import { FreqShifterEngine, ResonatorEngine, AutoWahEngine } from '../dsp/character.js';

const ENGINES = {
  'daw3-fx-reverb': (sr, o) => new FdnReverb(sr, { shimmer: !!o.shimmer }),
  'daw3-fx-grain': (sr, o) => new GrainCloud(sr, o.seed || 12345),
  'daw3-fx-pitch': (sr) => new HarmonizerEngine(sr),
  'daw3-fx-formant': (sr) => new FormantEngine(sr),
  'daw3-fx-vocoder': (sr) => new VocoderEngine(sr),
  'daw3-fx-freqshift': (sr) => new FreqShifterEngine(sr),
  'daw3-fx-resonator': (sr) => new ResonatorEngine(sr),
  'daw3-fx-autowah': (sr) => new AutoWahEngine(sr),
};

const QUANTUM = 128;
const SLEEP_BLOCKS = 16; // silent input + silent output for this many blocks: stop computing until input returns

for (const [name, spec] of Object.entries(FX_PROCESSORS)) {
  const aRate = new Set(spec.aRate || []);
  const keys = spec.params.filter((k) => !aRate.has(k));
  class FxProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return spec.params.map((k) => ({ name: k, defaultValue: 0, minValue: -1e6, maxValue: 1e6, automationRate: aRate.has(k) ? 'a-rate' : 'k-rate' }));
    }
    constructor(options) {
      super();
      const o = options?.processorOptions || {};
      this.engine = ENGINES[name](sampleRate, o);
      this.vals = {};
      this.last = new Float64Array(keys.length).fill(NaN);
      this.zero = new Float32Array(QUANTUM);
      this.tmpL = new Float32Array(QUANTUM); this.tmpR = new Float32Array(QUANTUM);
      this.quiet = 0;
      this.dead = false;
      // 'dispose': the effect was removed — let the node be collected; 'reset': clear all state (tails, buffers)
      this.port.onmessage = (e) => {
        if (e.data?.type === 'reset') this.engine = ENGINES[name](sampleRate, o);
        else if (e.data?.type === 'dispose') this.dead = true;
      };
    }
    process(inputs, outputs, parameters) {
      if (this.dead) return false;
      const out = outputs[0];
      if (!out || !out.length) return true;
      const n = out[0].length;
      let changed = false;
      for (let i = 0; i < keys.length; i++) {
        const v = parameters[keys[i]][0];
        if (v !== this.last[i]) { this.last[i] = v; this.vals[keys[i]] = v; changed = true; }
      }
      if (changed) this.engine.set(this.vals);
      const inp = inputs[0] || [];
      const inL = inp[0] || this.zero, inR = inp[1] || inL;
      const key = inputs[1] || [];
      const keyL = key[0] || null, keyR = key[1] || keyL;
      const outL = out[0], outR = out[1] || this.tmpR;
      // sleep while nothing goes in and nothing comes out (frozen spaces and keyed carriers keep running)
      let silent = !(this.vals.freeze >= 0.5) && !keyL;
      if (silent) for (let i = 0; i < n; i++) if (inL[i] !== 0 || inR[i] !== 0) { silent = false; break; }
      if (silent && this.quiet >= SLEEP_BLOCKS) { outL.fill(0); if (out[1]) outR.fill(0); return true; }
      if (aRate.size) this.engine.process(inL, inR, outL, outR, n, parameters.mod);
      else this.engine.process(inL, inR, outL, outR, n, keyL, keyR);
      if (silent) {
        let peak = 0;
        for (let i = 0; i < n; i++) { const a = Math.abs(outL[i]) + Math.abs(outR[i]); if (a > peak) peak = a; }
        this.quiet = peak < 1e-6 ? this.quiet + 1 : 0;
      } else this.quiet = 0;
      for (let c = 2; c < out.length; c++) out[c].set(c % 2 ? outR : outL);
      return true;
    }
  }
  registerProcessor(name, FxProcessor);
}
