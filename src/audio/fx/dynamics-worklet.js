// AudioWorklet processors of the dynamics family: 'daw3-multiband', 'daw3-transient', 'daw3-deesser', 'daw3-expander'
// (input 1 = external key) and 'daw3-dyneq'. Thin wrappers around the cores in dsp/dynamics-core.js: k-rate
// AudioParams (dsp/dynamics-params.js) are read every block and pushed into the core when they change.
// processorOptions: { meter: true } → posts the core's meters ~30x per second ({ type: 'meter', ... }).
import { MultibandCore, TransientCore, DeesserCore, ExpanderCore, DynEqCore } from './dsp/dynamics-core.js';
import { PROCS } from './dsp/dynamics-params.js';

const CORES = { multiband: MultibandCore, transient: TransientCore, deesser: DeesserCore, expander: ExpanderCore, dyneq: DynEqCore };
const SILENT = new Float32Array(128);

function makeProcessor(type) {
  const P = PROCS[type];
  const Core = CORES[type];
  const names = P.spec.map((s) => s[0]);
  return class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return P.spec.map(([name, def]) => ({ name, defaultValue: def, automationRate: 'k-rate' }));
    }
    constructor(opts) {
      super();
      this.core = new Core(sampleRate);
      this.vals = new Float64Array(names.length).fill(NaN);
      this.meter = !!opts?.processorOptions?.meter;
      this.meterEvery = Math.round(sampleRate / 30);
      this.meterN = 0;
      this.alive = true;
      this.port.onmessage = (e) => { if (e.data === 'dispose') this.alive = false; };
    }
    process(inputs, outputs, parameters) {
      let changed = false;
      for (let i = 0; i < names.length; i++) {
        const v = parameters[names[i]][0];
        if (v !== this.vals[i]) { this.vals[i] = v; changed = true; }
      }
      if (changed) {
        const o = {};
        for (let i = 0; i < names.length; i++) o[names[i]] = this.vals[i];
        this.core.set(P.decode(o, sampleRate));
      }
      const out = outputs[0];
      const n = out[0]?.length || 128;
      const inp = inputs[0];
      const ins = inp && inp.length ? [inp[0], inp[1] || inp[0]] : [SILENT, SILENT];
      const key = inputs[1] && inputs[1].length ? [inputs[1][0], inputs[1][1] || inputs[1][0]] : null;
      const outs = [out[0], out[1] || new Float32Array(n)];
      this.core.process(ins, outs, n, key);
      if (this.meter && (this.meterN += n) >= this.meterEvery) {
        this.meterN = 0;
        this.port.postMessage({ type: 'meter', ...this.core.readMeter() });
      }
      return this.alive;
    }
  };
}

for (const type of Object.keys(PROCS)) registerProcessor(PROCS[type].name, makeProcessor(type));
