// DSP math of the space family (src/audio/fx/dsp): FDN reverb (orthogonal mixing, decay filters, T60, freeze,
// stability, shimmer), granular delay, delay-line pitch shifter (ratio, windows, latency) and the effect defs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayGain, DelayLine, rms } from '../src/audio/fx/dsp/common.js';
import { hadamard8, dampingFilter, lineLengths, primeAtLeast, FdnReverb, REVERB_MODE_NAMES, SHIMMER_INTERVALS } from '../src/audio/fx/dsp/reverb.js';
import { grainEnvelope, minGrainDelay, GrainCloud } from '../src/audio/fx/dsp/granular.js';
import { PitchShifter, grainWindow, shifterLatency, SHIFTER_MODES } from '../src/audio/fx/dsp/pitch.js';
import { FX_PROCESSORS } from '../src/audio/fx/dsp/specs.js';
import { EFFECT_DEFS, EFFECT_CATEGORIES, resolveEffectParams } from '../src/audio/effect-defs.js';
import { effectLatencyFrames } from '../src/audio/latency.js';

const SR = 44100;

/** Run a stereo engine over mono input x (blocks of 128). */
function run(eng, x, n = x.length) {
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    const xi = x.subarray(i, i + m);
    eng.process(xi, xi, l.subarray(i, i + m), r.subarray(i, i + m), m);
  }
  return { l, r };
}
/** T60 from Schroeder backward integration, fitted between -5 and -25 dB. */
function t60Of(l, r) {
  const n = l.length, E = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += l[i] * l[i] + r[i] * r[i]; E[i] = acc; }
  const db = (i) => 10 * Math.log10(E[i] / E[0]);
  let i5 = -1, i25 = -1;
  for (let i = 0; i < n; i++) { if (i5 < 0 && db(i) < -5) i5 = i; if (db(i) < -25) { i25 = i; break; } }
  return ((i25 - i5) / SR) * 3;
}
/** Windowed single-bin DFT magnitude. */
function bin(s, f, a, b) {
  let re = 0, im = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
    re += w * s[i] * Math.cos((2 * Math.PI * f * i) / SR); im += w * s[i] * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return (Math.hypot(re, im) / (b - a)) * 4;
}
/** Frequency of the strongest bin within ±range cents of f. */
function peakNear(s, f, a, b, range = 60) {
  let best = -1, bf = f;
  for (let c = -range; c <= range; c += 1) { const ff = f * 2 ** (c / 1200); const v = bin(s, ff, a, b); if (v > best) { best = v; bf = ff; } }
  return bf;
}
const cents = (a, b) => 1200 * Math.log2(a / b);

// ------------------------------------------------------------------------------------------- FDN reverb
test('hadamard8 is orthogonal (energy preserving, self-inverse)', () => {
  for (let k = 0; k < 8; k++) {
    const e = new Float64Array(8); e[k] = 1;
    hadamard8(e);
    assert.ok(Math.abs(e.reduce((s, v) => s + v * v, 0) - 1) < 1e-12, 'unit norm column');
    for (let j = 0; j < 8; j++) assert.ok(Math.abs(Math.abs(e[j]) - 1 / Math.sqrt(8)) < 1e-12);
    hadamard8(e); // H·H = I
    for (let j = 0; j < 8; j++) assert.ok(Math.abs(e[j] - (j === k ? 1 : 0)) < 1e-12);
  }
});

test('decay gains and the two-band damping filter hit their T60 targets', () => {
  // a 1000-sample loop decaying 60 dB in 2 s: g^(2·sr/1000) = 1e-3
  const g = decayGain(1000, 2, SR);
  assert.ok(Math.abs(Math.pow(g, (2 * SR) / 1000) - 1e-3) < 1e-9);
  const f = dampingFilter(1500, 3, 1, SR);
  const dc = f.c / (1 - f.a), nyq = f.c / (1 + f.a);
  assert.ok(Math.abs(dc - decayGain(1500, 3, SR)) < 1e-12, 'DC gain = low T60 gain');
  assert.ok(Math.abs(nyq - decayGain(1500, 1, SR)) < 1e-12, 'Nyquist gain = high T60 gain');
  assert.ok(f.a > 0 && f.a < 1, 'low-pass when highs decay faster');
});

test('line lengths are increasing primes that grow with size', () => {
  for (const mode of REVERB_MODE_NAMES) {
    const small = lineLengths(mode, 0, SR), big = lineLengths(mode, 1, SR);
    for (let i = 0; i < 8; i++) {
      assert.equal(primeAtLeast(big[i]), big[i], `${mode} prime`);
      if (i) assert.ok(big[i] > big[i - 1], `${mode} increasing`);
      assert.ok(big[i] > small[i] * 2, `${mode} size scales`);
    }
  }
});

test('FDN reverb decays at the requested T60 (plate, no damping)', () => {
  for (const decay of [1, 3]) {
    const n = Math.round(SR * (decay * 1.3 + 0.3));
    const rv = new FdnReverb(SR);
    rv.set({ mode: 'plate', decay, damping: 0, size: 0.6, predelay: 0, mod: 0.2, balance: 1 });
    const x = new Float32Array(n); x[0] = 1;
    const { l, r } = run(rv, x);
    const t = t60Of(l, r);
    assert.ok(Math.abs(t - decay) / decay < 0.2, `T60 ${t.toFixed(2)} for ${decay} s`);
  }
});

test('damping shortens the tail; every mode stays stable at long decays with full modulation', () => {
  const tail = (damping) => {
    const rv = new FdnReverb(SR); rv.set({ mode: 'hall', decay: 2, damping, predelay: 0 });
    const x = new Float32Array(SR * 2); x[0] = 1;
    const { l, r } = run(rv, x);
    return t60Of(l, r);
  };
  assert.ok(tail(1) < tail(0) * 0.8, 'damped tail is shorter');
  for (const mode of REVERB_MODE_NAMES) {
    const rv = new FdnReverb(SR); rv.set({ mode, decay: 30, size: 1, mod: 1, damping: 0, diffusion: 1 });
    const x = new Float32Array(SR * 3); for (let i = 0; i < SR * 0.3; i++) x[i] = Math.sin(i * 0.05) * 0.5;
    const { l, r } = run(rv, x);
    let peak = 0; for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    assert.ok(Number.isFinite(peak) && peak < 3, `${mode} bounded (${peak})`);
  }
});

test('freeze holds the tail (no decay, no input) and shimmer stays bounded', () => {
  const rv = new FdnReverb(SR);
  rv.set({ mode: 'hall', decay: 1, predelay: 0 });
  const n = SR * 3;
  const x = new Float32Array(n); for (let i = 0; i < SR * 0.4; i++) x[i] = Math.random() * 2 - 1;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    if (i >= SR * 0.5) rv.set({ mode: 'hall', decay: 1, predelay: 0, freeze: 1 });
    const m = Math.min(128, n - i);
    rv.process(x.subarray(i, i + m), x.subarray(i, i + m), l.subarray(i, i + m), r.subarray(i, i + m), m);
  }
  const a = rms(l, SR * 0.8, SR * 1.2), b = rms(l, SR * 2.5, SR * 2.9);
  assert.ok(a > 1e-3 && Math.abs(20 * Math.log10(b / a)) < 3, `frozen level ${a} -> ${b}`);
  for (let k = 0; k < SHIMMER_INTERVALS.length; k++) {
    const sv = new FdnReverb(SR, { shimmer: true });
    sv.set({ mode: 'hall', decay: 20, shimmer: 1, interval: k, size: 1 });
    const y = run(sv, x.subarray(0, SR * 2));
    let peak = 0; for (const v of y.l) peak = Math.max(peak, Math.abs(v));
    assert.ok(Number.isFinite(peak) && peak < 3, `shimmer interval ${k} bounded (${peak})`);
  }
});

// ------------------------------------------------------------------------------------------- pitch shifter
test('pitch shifter windows cross-fade to unity and taps never read ahead', () => {
  for (let ph = 0; ph < 1; ph += 0.01) assert.ok(Math.abs(grainWindow(ph) + grainWindow((ph + 0.5) % 1) - 1) < 1e-12);
  assert.equal(grainWindow(0), 0);
  for (const mode of Object.keys(SHIFTER_MODES)) {
    const m = SHIFTER_MODES[mode];
    assert.equal(shifterLatency(mode, 48000), Math.round(Math.ceil(m.search * 48000) + 3 + (m.window * 48000) / 2));
  }
  assert.ok(shifterLatency('low', 48000) < shifterLatency('quality', 48000));
});

test('pitch shifter output frequency = input × 2^(st/12) in both latency modes', () => {
  for (const mode of ['low', 'quality']) {
    for (const st of [-12, -5, 7, 12, 19]) {
      const ps = new PitchShifter(SR, mode); ps.setSemitones(st);
      const n = SR, y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = ps.process(0.5 * Math.sin((2 * Math.PI * 220 * i) / SR));
      const f = 220 * 2 ** (st / 12);
      const pk = peakNear(y, f, SR / 4, n);
      assert.ok(Math.abs(cents(pk, f)) <= 2, `${mode} ${st} st: ${cents(pk, f).toFixed(1)} ct`);
      assert.ok(Math.abs(rms(y, SR / 4, n) - 0.3536) < 0.03, `${mode} ${st} st level ${rms(y, SR / 4, n)}`);
    }
  }
});

test('unity ratio is a clean delay of the reported latency', () => {
  const ps = new PitchShifter(SR, 'quality');
  const n = 4000, y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = ps.process(i === 100 ? 1 : 0);
  let at = 0; for (let i = 0; i < n; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
  assert.ok(Math.abs(at - 100 - ps.latency) <= 1, `impulse at +${at - 100}, latency ${ps.latency}`);
  assert.ok(Math.abs(y[at] - 1) < 0.02);
});

// ------------------------------------------------------------------------------------------- granular
test('grain envelopes and safe grain delays', () => {
  for (const shape of ['hann', 'tukey', 'triangle']) {
    assert.equal(grainEnvelope(0, shape), 0); assert.equal(grainEnvelope(1, shape), 0);
    assert.ok(Math.abs(grainEnvelope(0.5, shape) - 1) < 1e-12, shape);
    for (let t = 0.05; t < 0.5; t += 0.05) assert.ok(Math.abs(grainEnvelope(t, shape) - grainEnvelope(1 - t, shape)) < 1e-12, `${shape} symmetric`);
  }
  assert.ok(grainEnvelope(0.5, 'tukey') === grainEnvelope(0.3, 'tukey'), 'tukey has a flat top');
  // a 2x grain of 1000 samples reads 1000 samples past its start: it must start at least that far back
  assert.ok(minGrainDelay(1000, 2) >= 1000);
  assert.ok(minGrainDelay(1000, 0.5) < 10);
});

test('granular cloud is deterministic, bounded, and frozen clouds keep sounding', () => {
  const x = new Float32Array(SR); for (let i = 0; i < SR / 2; i++) x[i] = Math.sin(i * 0.03) * 0.5;
  const mk = () => { const g = new GrainCloud(SR, 99); g.set({ time: 0.2, size: 0.08, density: 30, pitch: 12, pitchRand: 2, feedback: 0.6, reverse: 0.3 }); return g; };
  const a = run(mk(), x), b = run(mk(), x);
  assert.deepEqual(a.l, b.l, 'same seed, same cloud');
  let peak = 0; for (const v of a.l) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.01 && peak < 2, `peak ${peak}`);
  const fz = new GrainCloud(SR, 5); fz.set({ time: 0.3, size: 0.1, density: 25 });
  run(fz, x.subarray(0, SR / 2));
  fz.set({ time: 0.3, size: 0.1, density: 25, freeze: 1 });
  const silent = new Float32Array(SR);
  const y = run(fz, silent);
  assert.ok(rms(y.l, SR / 2, SR) > 0.01, 'frozen cloud plays the captured audio');
});

// ------------------------------------------------------------------------------------------- defs / specs
const SPACE = ['algoReverb', 'shimmer', 'tapeDelay', 'multitap', 'grainDelay'];

test('space defs: categories, 10–20 valid presets each', () => {
  for (const t of SPACE) {
    const d = EFFECT_DEFS[t];
    assert.ok(d, t);
    assert.equal(d.category, 'Delay & Reverb');
    assert.ok(EFFECT_CATEGORIES.includes(d.category));
    const n = Object.keys(d.presets).length;
    assert.ok(n >= 10 && n <= 20, `${t}: ${n} presets`);
    const keys = new Set(d.params.map((p) => p.key));
    for (const [name, pr] of Object.entries(d.presets)) {
      for (const [k, v] of Object.entries(pr)) {
        assert.ok(keys.has(k), `${t} / ${name}: unknown ${k}`);
        const p = d.params.find((x) => x.key === k);
        if (p.type === 'number') assert.ok(v >= p.min && v <= p.max, `${t} / ${name}: ${k}=${v} out of range`);
        if (p.type === 'enum') assert.ok(p.options.some((o) => o.value === v), `${t} / ${name}: ${k}=${v} not an option`);
      }
      const r = resolveEffectParams({ type: t, params: pr });
      for (const [k, v] of Object.entries(pr)) assert.equal(r[k], v, `${t} / ${name}: ${k} survives resolve`);
    }
  }
});

test('worklet processor specs and latency reporting', () => {
  for (const [name, spec] of Object.entries(FX_PROCESSORS)) {
    assert.ok(name.startsWith('daw3-fx-'));
    assert.equal(new Set(spec.params).size, spec.params.length, `${name} unique params`);
    for (const a of spec.aRate || []) assert.ok(spec.params.includes(a));
  }
  for (const t of SPACE) assert.equal(effectLatencyFrames({ type: t, params: {} }, 48000), 0, `${t}: no processing latency`);
  // DelayLine read convention used by every engine: read(d) = x[n - d]
  const dl = new DelayLine(16);
  for (let i = 1; i <= 10; i++) dl.write(i);
  assert.equal(dl.read(0), 10); assert.equal(dl.read(3), 7); assert.equal(dl.read(2.5), 7.5);
  assert.ok(Math.abs(dl.readCubic(3) - 7) < 1e-9);
});
