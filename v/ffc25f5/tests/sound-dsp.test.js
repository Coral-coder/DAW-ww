// Pure-JS checks for the procedural sound generators (src/audio/dsp) and synth helper curves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft } from '../src/audio/dsp/fft.js';
import { pluckTable } from '../src/audio/dsp/pluck.js';
import { padTable } from '../src/audio/dsp/padsynth.js';
import { pianoTable } from '../src/audio/dsp/piano.js';
import { superDetuneCurve, superMixCurve, filterQ, velCurve, MODEL_WAVES } from '../src/audio/synth.js';
import { INSTRUMENT_DEFS } from '../src/audio/defs.js';
import { PRESETS } from '../src/audio/presets.js';

// Node has no AudioBuffer: makeBuffer falls back to ctx.createBuffer
const ctx = {
  createBuffer: (c, n, sr) => {
    const d = [...Array(c)].map(() => new Float32Array(n));
    return { length: n, numberOfChannels: c, sampleRate: sr, duration: n / sr, getChannelData: (i) => d[i] };
  },
};

/** Frequency (Hz) of the strongest DTFT peak within ±50 cents of f. */
function peakFreq(x, sr, f) {
  let best = -1, bf = f;
  for (let c = -50; c <= 50; c += 0.5) {
    const ff = f * 2 ** (c / 1200), w = (2 * Math.PI * ff) / sr;
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / x.length); re += x[i] * h * Math.cos(w * i); im += x[i] * h * Math.sin(w * i); }
    const p = re * re + im * im;
    if (p > best) { best = p; bf = ff; }
  }
  return bf;
}
const cents = (a, b) => 1200 * Math.log2(a / b);

test('fft round-trips', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + (i % 3)), im = new Float64Array(64);
  const orig = [...re];
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] / 64 - orig[i]) < 1e-9);
});

test('Karplus-Strong tables are in tune (±2 cents) and finite', () => {
  for (const m of [40, 57, 69, 88]) {
    const { buffer, f0 } = pluckTable(48000, m, 1, 0, 1, ctx);
    const x = buffer.getChannelData(0);
    assert.ok(x.every(Number.isFinite));
    const seg = x.subarray(2400, 2400 + 12000);
    assert.ok(Math.abs(cents(peakFreq(seg, 48000, f0), f0)) < 2, `KS pitch ${m}`);
  }
});

test('piano tables keep partial 1 on pitch despite inharmonicity', () => {
  for (const m of [48, 72, 96]) {
    const { buffer, f0 } = pianoTable(48000, m, 1, 0, 1, ctx);
    const seg = buffer.getChannelData(0).subarray(4800, 4800 + 14400);
    assert.ok(Math.abs(cents(peakFreq(seg, 48000, f0), f0)) < 3, `piano pitch ${m}`);
  }
});

test('PADsynth tables loop seamlessly and have bin-exact fundamentals', () => {
  const { buffer, f0 } = padTable(48000, 'choir', 60, 1, 0, ctx);
  const x = buffer.getChannelData(0);
  assert.equal(x.length, 1 << 18);
  assert.ok(Math.abs((f0 * x.length) / 48000 - Math.round((f0 * x.length) / 48000)) < 1e-6, 'f0 on an FFT bin');
  assert.ok(Math.abs(x[0] - x[x.length - 1]) < 0.05, 'loop seam is continuous');
  assert.ok(Math.abs(cents(f0, 261.6256)) < 1);
});

test('supersaw / filter / velocity curves are sane', () => {
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.05) { const d = superDetuneCurve(x); assert.ok(d >= prev - 1e-3); prev = d; }
  assert.ok(Math.abs(superDetuneCurve(1) - 1) < 0.01);
  const [c, s] = superMixCurve(0.75);
  assert.ok(c > 0.5 && s > 0.5);
  assert.ok(filterQ('lp24', 1) <= 21.5 && filterQ('lp24', 0) <= -2.9);
  assert.ok(velCurve(1, 1) === 1 && velCurve(0.5, 1) < 0.5 && velCurve(0.3, 0) === 1);
});

test('model waves are selectable and the sample-model presets use them', () => {
  const waves = INSTRUMENT_DEFS.synth.params.find((p) => p.key === 'osc1Wave').options.map((o) => o.value);
  for (const w of MODEL_WAVES) assert.ok(waves.includes(w), w);
  assert.equal(PRESETS['grand-piano'].instrument.params.osc1Wave, 'piano');
  assert.equal(PRESETS['guitar-clean'].instrument.params.osc1Wave, 'pluck');
  assert.equal(PRESETS['choir-pad'].instrument.params.osc1Wave, 'choir');
  // DX7 E.PIANO 1 conversion: 14:1 tine modulator, 1:1 carriers, fast attacks
  const ep = PRESETS['electric-piano'].instrument.params;
  assert.equal(ep.op1Ratio, 14);
  assert.equal(ep.op2Ratio, 1);
  assert.ok(ep.op2Attack < 0.005 && ep.op1Level > 0 && ep.op1Level < 0.5);
});
