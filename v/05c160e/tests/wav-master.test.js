// Pro export path: WAV encoder (bit-exact float32, TPDF dither, noise shaping, no clipping / wrap-around), decoder,
// true-peak meter and the offline true-peak limiter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav } from '../src/audio/wav.js';
import { truePeak, limitTruePeak } from '../src/audio/dsp/truepeak.js';

const rand = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

test('32-bit float WAV is bit-exact (incl. overs beyond ±1, denormals, -0)', () => {
  const r = rand(7);
  const L = new Float32Array(5000).map(() => (r() - 0.5) * 6);
  const R = new Float32Array(5000).map(() => (r() - 0.5) * 1e-3);
  L[0] = -0; L[1] = 1.5; L[2] = -3.25; R[3] = 1e-40; R[4] = Math.fround(0.1);
  const ab = encodeWav([L, R], { bitDepth: 32, sampleRate: 96000 });
  const dec = decodeWav(ab);
  assert.equal(dec.sampleRate, 96000);
  assert.equal(dec.float, true);
  for (let i = 0; i < L.length; i++) {
    assert.ok(Object.is(dec.channels[0][i], L[i]), `L[${i}]`);
    assert.ok(Object.is(dec.channels[1][i], R[i]), `R[${i}]`);
  }
});

test('AudioBuffer-like input and {channels, sampleRate} both work; plain 16-bit keeps legacy rounding', () => {
  const ch = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const ab1 = encodeWav({ numberOfChannels: 1, sampleRate: 44100, length: ch.length, getChannelData: () => ch }, { bitDepth: 16 });
  const ab2 = encodeWav({ channels: [ch], sampleRate: 44100 }, { bitDepth: 16 });
  assert.deepEqual(new Uint8Array(ab1), new Uint8Array(ab2));
  const v = new DataView(ab1, 44);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => v.getInt16(i * 2, true)), [0, 16384, -16384, 32767, -32768, 32767, -32768]);
});

test('TPDF dither: unbiased (linearises sub-LSB signals) with total error variance ≈ 1/4 LSB²', () => {
  const N = 200000;
  for (const [depth, lsb] of [[16, 1 / 32768], [24, 1 / 8388608]]) {
    const x = new Float32Array(N).fill(0.3 * lsb); // constant 0.3 LSB: plain rounding loses it completely
    const plain = decodeWav(encodeWav([x], { bitDepth: depth, sampleRate: 48000 })).channels[0];
    const dith = decodeWav(encodeWav([x], { bitDepth: depth, sampleRate: 48000, dither: 'tpdf', seed: 3 })).channels[0];
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    assert.equal(mean(plain), 0);
    const m = mean(dith) / lsb;
    assert.ok(Math.abs(m - 0.3) < 0.01, `${depth}-bit dithered mean ${m} LSB ≈ 0.3`);
    let v = 0;
    for (let i = 0; i < N; i++) { const e = dith[i] / lsb - 0.3; v += e * e; }
    v /= N;
    assert.ok(Math.abs(v - 0.25) < 0.02, `${depth}-bit error variance ${v} LSB² ≈ 0.25`);
    // dither values are whole LSBs within ±2 of the input
    for (let i = 0; i < 1000; i++) { const q = dith[i] / lsb; assert.ok(Number.isInteger(Math.round(q * 1e6) / 1e6) && Math.abs(q) <= 2); }
  }
});

test('dither + noise shaping never clip or wrap at full scale', () => {
  const N = 20000;
  const r = rand(11);
  const x = new Float32Array(N).map((_, i) => (i % 2 ? 1 : -1) * (1 - r() * 1e-6)); // full-scale square, ±1
  x[10] = 4; x[11] = -4; // overs
  for (const noiseShaping of ['none', 'first', 'shaped']) {
    for (const depth of [16, 24]) {
      const d = decodeWav(encodeWav([x], { bitDepth: depth, sampleRate: 44100, dither: 'tpdf', noiseShaping })).channels[0];
      for (let i = 0; i < N; i++) {
        assert.ok(Math.sign(d[i]) === Math.sign(x[i]), `${depth}/${noiseShaping}: sample ${i} wrapped (${x[i]} -> ${d[i]})`);
        assert.ok(Math.abs(d[i]) <= 1 && Math.abs(d[i]) > 0.999, `${depth}/${noiseShaping}: ${d[i]}`);
      }
    }
  }
});

test('noise shaping moves the requantisation noise out of the low band', () => {
  const N = 1 << 15;
  const x = new Float32Array(N).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const lowFrac = (shaping) => {
    const d = decodeWav(encodeWav([x], { bitDepth: 16, sampleRate: 44100, dither: 'tpdf', noiseShaping: shaping, seed: 9 })).channels[0];
    const e = new Float64Array(N);
    for (let i = 0; i < N; i++) e[i] = (d[i] - Math.fround(x[i])) * 32768;
    // low band = 32-tap moving average (passes < ~1.4 kHz), compare its energy with the total
    let lo = 0, tot = 0, acc = 0;
    for (let i = 0; i < N; i++) { acc += e[i] - (i >= 32 ? e[i - 32] : 0); const l = acc / 32; lo += l * l; tot += e[i] * e[i]; }
    return lo / tot;
  };
  const flat = lowFrac('none');
  const first = lowFrac('first');
  const shaped = lowFrac('shaped');
  assert.ok(first < flat * 0.25, `first-order: ${first} vs flat ${flat}`);
  assert.ok(shaped < flat * 0.25, `shaped: ${shaped} vs flat ${flat}`);
});

test('true-peak meter sees inter-sample peaks; limiter holds the ceiling without clipping or latency', () => {
  const n = 9600;
  const sr = 48000;
  // fs/4 sine at 45°: samples peak at 0.707, the reconstructed waveform at 1.0
  const x = new Float32Array(n).map((_, i) => 1.4 * Math.sin((2 * Math.PI * i) / 4 + Math.PI / 4));
  let sp = 0; for (const v of x) sp = Math.max(sp, Math.abs(v));
  const tp = truePeak([x]);
  assert.ok(tp > sp * 1.3, `true peak ${tp} > sample peak ${sp}`);
  const quiet = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 1000 * i) / sr));
  const res = limitTruePeak([x, quiet], sr, { ceilingDb: -1 });
  assert.ok(res.truePeakDb <= -1 + 0.01, `after: ${res.truePeakDb} dBTP`);
  assert.ok(res.gainReductionDb < -3);
  assert.ok(truePeak(res.channels) <= Math.pow(10, -1 / 20) * 1.001);
  // under the ceiling: untouched (unity, no delay)
  const clean = limitTruePeak([quiet], sr, { ceilingDb: -1 });
  assert.equal(clean.gainReductionDb, 0);
  assert.deepEqual(clean.channels[0], quiet);
  // a single loud transient in silence: gain only dips around it, the signal stays aligned (no latency)
  const hit = new Float32Array(n);
  hit[5000] = 2; hit[5001] = -1.5;
  const lim = limitTruePeak([hit], sr, { ceilingDb: -0.3 }).channels[0];
  let mi = 0; for (let i = 0; i < n; i++) if (Math.abs(lim[i]) > Math.abs(lim[mi])) mi = i;
  assert.equal(mi, 5000);
  assert.ok(Math.abs(lim[5000]) <= Math.pow(10, -0.3 / 20) + 1e-6);
});
