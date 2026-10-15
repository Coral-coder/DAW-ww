// Effect params ↔ AudioWorklet AudioParams for the dynamics processors (pure; shared by the builders in
// ../builders/dynamics.js and the processors in ../dynamics-worklet.js).
//
// Every processor exposes k-rate AudioParams (so automation and offline renders are sample-deterministic — no
// message timing involved). PROCS[type] = { name, spec: [[param, default, discrete?]], encode(p, sampleRate) → {param: value},
// decode(values, sampleRate) → the core's set() object }. Discrete params (enums, bools, band counts) are set without smoothing.
// Times are seconds, levels dB; look-ahead travels as whole frames (AudioParams are float32: an exact frame count
// keeps the processing delay equal to the latency reported through latency.js).
import { lookaheadFrames } from './dynamics-core.js';

const MODES = ['down', 'up', 'both'];
const BAND_KEYS = ['Thresh', 'Ratio', 'UpThresh', 'UpRatio', 'Attack', 'Release', 'Makeup', 'Solo', 'Bypass'];
const DYN_TYPES = ['peaking', 'lowshelf', 'highshelf'];
const b01 = (v) => (v ? 1 : 0);
const on = (v) => v >= 0.5;

function mbSpec() {
  const s = [['bands', 3, true], ['f1', 120], ['f2', 2500], ['f3', 8000], ['mode', 0, true], ['depth', 1], ['input', 0], ['output', 0], ['mix', 1], ['lookFrames', 0, true]];
  for (let k = 1; k <= 4; k++) for (const key of BAND_KEYS) s.push([`b${k}${key}`, 0, key === 'Solo' || key === 'Bypass']);
  return s;
}
function dynSpec() {
  const s = [['output', 0]];
  for (let k = 1; k <= 4; k++) for (const key of ['On', 'Type', 'Freq', 'Gain', 'Q', 'Thresh', 'Ratio', 'Attack', 'Release', 'Range', 'Mode']) s.push([`b${k}${key}`, 0, key === 'On' || key === 'Type' || key === 'Mode']);
  return s;
}

export const PROCS = {
  multiband: {
    name: 'daw3-multiband',
    spec: mbSpec(),
    encode(p, sr) {
      const o = { bands: Number(p.bands) >= 4 ? 4 : 3, f1: p.x1, f2: p.x2, f3: p.x3, mode: Math.max(0, MODES.indexOf(p.mode)), depth: p.depth, input: p.input, output: p.output, mix: p.wetMix, lookFrames: lookaheadFrames(p.lookahead, sr) };
      for (let k = 1; k <= 4; k++) {
        o[`b${k}Thresh`] = p[`b${k}Thresh`]; o[`b${k}Ratio`] = p[`b${k}Ratio`];
        o[`b${k}UpThresh`] = p[`b${k}UpThresh`]; o[`b${k}UpRatio`] = p[`b${k}UpRatio`];
        o[`b${k}Attack`] = p[`b${k}Attack`]; o[`b${k}Release`] = p[`b${k}Release`]; o[`b${k}Makeup`] = p[`b${k}Makeup`];
        o[`b${k}Solo`] = b01(p[`b${k}Solo`]); o[`b${k}Bypass`] = b01(p[`b${k}Bypass`]);
      }
      return o;
    },
    decode(v, sr) {
      const band = [];
      for (let k = 1; k <= 4; k++) {
        band.push({ thr: v[`b${k}Thresh`], ratio: v[`b${k}Ratio`], upThr: v[`b${k}UpThresh`], upRatio: v[`b${k}UpRatio`], attack: v[`b${k}Attack`], release: v[`b${k}Release`], makeup: v[`b${k}Makeup`], solo: on(v[`b${k}Solo`]), bypass: on(v[`b${k}Bypass`]) });
      }
      return { bands: Math.round(v.bands) >= 4 ? 4 : 3, freqs: [v.f1, v.f2, v.f3], mode: MODES[Math.round(v.mode)] || 'down', depth: v.depth, input: v.input, output: v.output, mix: v.mix, lookahead: v.lookFrames / sr, band };
    },
  },
  transient: {
    name: 'daw3-transient',
    spec: [['attack', 0], ['sustain', 0], ['speed', 0.025], ['clip', 0, true], ['output', 0]],
    encode: (p) => ({ attack: p.attack, sustain: p.sustain, speed: p.speed, clip: b01(p.clip), output: p.output }),
    decode: (v) => ({ attack: v.attack, sustain: v.sustain, speed: v.speed, clip: on(v.clip), output: v.output }),
  },
  deesser: {
    name: 'daw3-deesser',
    spec: [['freq', 6500], ['thr', -30], ['range', 12], ['mode', 0, true], ['detect', 0, true], ['listen', 0, true], ['release', 0.06]],
    encode: (p) => ({ freq: p.freq, thr: p.threshold, range: p.range, mode: p.mode === 'wide' ? 1 : 0, detect: p.detector === 'bp' ? 1 : 0, listen: b01(p.listen), release: p.release }),
    decode: (v) => ({ freq: v.freq, thr: v.thr, range: v.range, mode: on(v.mode) ? 'wide' : 'split', detect: on(v.detect) ? 'bp' : 'hp', listen: on(v.listen), release: v.release }),
  },
  expander: {
    name: 'daw3-expander',
    spec: [['thr', -40], ['ratio', 4], ['range', -40], ['hyst', 3], ['knee', 2], ['attack', 0.001], ['hold', 0.02], ['release', 0.12], ['lookFrames', 0, true], ['hpf', 20], ['lpf', 20000], ['keyed', 0, true], ['listen', 0, true]],
    encode: (p, sr) => ({ thr: p.threshold, ratio: p.ratio, range: p.range, hyst: p.hysteresis, knee: p.knee, attack: p.attack, hold: p.hold, release: p.release, lookFrames: lookaheadFrames(p.lookahead, sr), hpf: p.scHighpass, lpf: p.scLowpass, keyed: b01(!!p.sourceTrackId), listen: b01(p.listen) }),
    decode: (v, sr) => ({ thr: v.thr, ratio: v.ratio, range: v.range, hyst: v.hyst, knee: v.knee, attack: v.attack, hold: v.hold, release: v.release, lookahead: v.lookFrames / sr, hpf: v.hpf, lpf: v.lpf, keyed: on(v.keyed), listen: on(v.listen) }),
  },
  dyneq: {
    name: 'daw3-dyneq',
    spec: dynSpec(),
    encode(p) {
      const o = { output: p.output };
      for (let k = 1; k <= 4; k++) {
        o[`b${k}On`] = b01(p[`b${k}On`]); o[`b${k}Type`] = Math.max(0, DYN_TYPES.indexOf(p[`b${k}Type`]));
        for (const key of ['Freq', 'Gain', 'Q', 'Thresh', 'Ratio', 'Range']) o[`b${k}${key}`] = p[`b${k}${key}`];
        o[`b${k}Attack`] = p[`b${k}Attack`]; o[`b${k}Release`] = p[`b${k}Release`];
        o[`b${k}Mode`] = p[`b${k}Mode`] === 'below' ? 1 : 0;
      }
      return o;
    },
    decode(v) {
      const band = [];
      for (let k = 1; k <= 4; k++) {
        band.push({ on: on(v[`b${k}On`]), type: DYN_TYPES[Math.round(v[`b${k}Type`])] || 'peaking', freq: v[`b${k}Freq`], gain: v[`b${k}Gain`], q: v[`b${k}Q`], thr: v[`b${k}Thresh`], ratio: v[`b${k}Ratio`], attack: v[`b${k}Attack`], release: v[`b${k}Release`], range: v[`b${k}Range`], mode: on(v[`b${k}Mode`]) ? 'below' : 'above' });
      }
      return { output: v.output, band };
    },
  },
};
