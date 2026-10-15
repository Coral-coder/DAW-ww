// Analyzer devices: pass-through builders, defs / presets and the pure DSP behind the scopes (src/audio/dsp/scope.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockContext, impulseResponse } from './lib/mock-audio.js';
import { createEffect } from '../src/audio/effects.js';
import { EFFECT_DEFS, resolveEffectParams } from '../src/audio/effect-defs.js';
import { effectLatencyFrames } from '../src/audio/latency.js';
import { KEYED_FX, resolveKeyLinks } from '../src/core/patch.js';
import {
  noteOf, formatHz, findCrossings, pickTrigger, scopeTrigger, resampleWindow, channelOf, stereoStats, StereoMeter,
  makeWindow, SpectrumAnalyzer, powToDb, slopeGains, averageInto, maxInto, PeakHold, octaveSmooth, freqToNorm, normToFreq,
  bandEdges, resampleBands, mapColor, colormapLUT, COLORMAPS, dbToNorm, detectPitch, TunerTracker, smoothCoef, hzToMel, melToHz,
} from '../src/audio/dsp/scope.js';
import { yin as yinShared } from '../src/audio/dsp/yin.js';
import { yin as yinPocket } from '../src/mobile/pitch.js';

const SR = 48000;
const TYPES = ['oscilloscope', 'vectorscope', 'spectrum', 'spectrogram', 'tuner'];
const sine = (f, n, { amp = 1, phase = 0, sr = SR } = {}) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr + phase));

// ------------------------------------------------------------------------------------------------ devices
test('analyzers are Analysis effects with valid presets', () => {
  for (const t of TYPES) {
    const d = EFFECT_DEFS[t];
    assert.ok(d, t);
    assert.equal(d.category, 'Analysis');
    const n = Object.keys(d.presets || {}).length;
    assert.ok(n >= 10, `${t}: ${n} presets`);
    const keys = new Set(d.params.map((p) => p.key));
    for (const [name, vals] of Object.entries(d.presets)) {
      for (const k of Object.keys(vals)) assert.ok(keys.has(k), `${t} preset ${name}: unknown param ${k}`);
      const r = resolveEffectParams({ type: t, params: vals });
      for (const [k, v] of Object.entries(vals)) assert.equal(String(r[k]), String(v), `${t} preset ${name}.${k} out of range / not an option`);
    }
  }
});

test('analyzers pass audio through unchanged with zero latency and expose a probe', () => {
  const ctx = new MockContext({ sampleRate: SR });
  for (const t of TYPES) {
    const fx = createEffect(ctx, { id: 'a', type: t, params: {} });
    const ir = impulseResponse(fx.input, fx.output, SR);
    assert.deepEqual([...ir.entries()], [[0, 1]], `${t} impulse response`);
    assert.equal(fx.latency, 0, t);
    assert.equal(effectLatencyFrames({ type: t, params: {} }, SR), 0, t);
    const p = fx.probe;
    assert.ok(p && typeof p.read === 'function', `${t} probe`);
    assert.equal(p.sampleRate, SR);
    assert.equal(p.ensure(5000) >= 5000, true);
    assert.equal(p.ensure(100000), 32768, 'capped at the AnalyserNode maximum');
    const l = new Float32Array(p.size), r = new Float32Array(p.size);
    assert.equal(p.read(l, r), true);
    assert.equal(p.read(new Float32Array(16), null), false, 'wrong length is refused');
    fx.update({ id: 'a', type: t, enabled: false, params: {} });
    assert.deepEqual([...impulseResponse(fx.input, fx.output, SR).entries()], [[0, 1]], `${t} bypassed`);
    fx.dispose();
  }
});

test('spectrum compare input is a key: stereo key input, fed through the sidechain plumbing', () => {
  const ctx = new MockContext({ sampleRate: SR });
  const fx = createEffect(ctx, { id: 's', type: 'spectrum', params: { sourceTrackId: 't2' } });
  assert.ok(fx.keyInput);
  assert.equal(fx.keyInput.channelCount, 2);
  assert.equal(fx.probe.hasKey, true);
  fx.update({ id: 's', type: 'spectrum', params: {} });
  assert.equal(fx.probe.hasKey, false);
  assert.ok(KEYED_FX.has('spectrum'));
  const project = { tracks: [{ id: 't1', fx: [{ id: 's', type: 'spectrum', params: { sourceTrackId: 't2' } }] }, { id: 't2', fx: [] }], buses: [], master: { fx: [] } };
  assert.equal(resolveKeyLinks(project).get('s'), 't2');
  assert.equal(createEffect(ctx, { type: 'tuner', params: {} }).keyInput, null, 'other analyzers take no key');
});

test('YIN is shared between Pocket hum analysis and the analyzers', () => {
  assert.equal(yinShared, yinPocket);
});

// ------------------------------------------------------------------------------------------------ notes
test('noteOf: names, octaves, cents and the A4 reference', () => {
  const a = noteOf(440);
  assert.equal(a.label, 'A4'); assert.equal(a.midi, 69); assert.ok(Math.abs(a.cents) < 1e-9);
  assert.equal(noteOf(261.6256).label, 'C4');
  assert.equal(noteOf(277.18).name, 'C♯');
  assert.equal(noteOf(277.18, { flats: true }).name, 'D♭');
  const sharp = noteOf(440 * Math.pow(2, 10 / 1200));
  assert.ok(Math.abs(sharp.cents - 10) < 1e-6);
  assert.equal(noteOf(415, { a4: 415 }).label, 'A4');
  assert.ok(Math.abs(noteOf(440, { a4: 415 }).cents - (1200 * Math.log2(440 / 415) - 100)) < 1e-6);
  assert.equal(noteOf(0), null);
  assert.equal(noteOf(30.87).label, 'B0');
  assert.equal(formatHz(1234), '1.23 kHz');
  assert.equal(formatHz(440), '440 Hz');
});

// ------------------------------------------------------------------------------------------------ trigger
test('findCrossings: rising / falling zero crossings at the right fractional positions', () => {
  const f = 1000, n = 480; // 10 cycles of 48 samples
  const s = sine(f, n, { phase: 0.3 });
  const up = findCrossings(s);
  // rising crossings where phase ≡ 0 mod 2π: i = (k·2π − 0.3)·SR / (2π f)
  const want = (k) => ((k * 2 * Math.PI - 0.3) * SR) / (2 * Math.PI * f);
  assert.equal(up.length, 10);
  up.forEach((x, j) => assert.ok(Math.abs(x - want(j + 1)) < 0.05, `${x} vs ${want(j + 1)}`));
  const down = findCrossings(s, { slope: 'fall' });
  assert.ok(down.length >= 9);
  assert.ok(Math.abs(down[0] - (((Math.PI - 0.3) * SR) / (2 * Math.PI * f))) < 0.05);
});

test('findCrossings: hysteresis ignores noise chatter around the level', () => {
  const s = new Float32Array(200);
  for (let i = 0; i < 200; i++) s[i] = (i < 100 ? -0.5 : 0.5) + (i % 2 ? 0.01 : -0.01);
  assert.ok(findCrossings(s, { hyst: 0 }).length >= 1);
  const c = findCrossings(s, { hyst: 0.1 });
  assert.equal(c.length, 1);
  assert.ok(Math.abs(c[0] - 99.5) < 0.6);
});

test('cycle-locked trigger keeps a periodic wave still from frame to frame', () => {
  const f = 220, period = SR / f;
  const wave = (n, ph) => Float32Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * f * i) / SR + ph;
    return 0.6 * Math.sin(t) + 0.3 * Math.sin(2 * t + 1) + 0.15 * Math.sin(3 * t + 2); // several crossings per cycle
  });
  const len = 2 * period;
  let prev = null;
  const frames = [];
  for (let k = 0; k < 6; k++) {
    const buf = wave(8192, k * 1.234); // a new random phase each read
    const { pos, triggered } = scopeTrigger(buf, { mode: 'cycle', len, prev, hyst: 0.02 });
    assert.ok(triggered);
    const shown = resampleWindow(buf, pos, len, 64);
    frames.push(shown);
    prev = shown;
  }
  for (let k = 1; k < frames.length; k++) {
    let err = 0;
    for (let i = 0; i < 64; i++) err = Math.max(err, Math.abs(frames[k][i] - frames[0][i]));
    assert.ok(err < 0.03, `frame ${k} drifts by ${err}`);
  }
  // free run returns the newest window; no crossing -> free-run fallback
  assert.deepEqual(scopeTrigger(new Float32Array(1000), { mode: 'zero', len: 100 }), { pos: 899, triggered: false });
  assert.equal(scopeTrigger(wave(1000, 0), { mode: 'free', len: 100 }).pos, 899);
});

test('pickTrigger: newest candidate without history, best match with it', () => {
  const buf = sine(1000, 960);
  const c = findCrossings(buf);
  assert.equal(pickTrigger(buf, c, 48), c[c.length - 1]);
  assert.equal(pickTrigger(buf, [], 48), -1);
  const prev = resampleWindow(buf, c[2], 48, 32);
  const best = pickTrigger(buf, c, 48, prev);
  assert.ok(Math.abs(resampleWindow(buf, best, 48, 32)[5] - prev[5]) < 1e-3);
});

test('channelOf: L, R, mid and side views', () => {
  const l = Float32Array.from([1, 0.5]), r = Float32Array.from([0, 0.5]);
  assert.deepEqual([...channelOf(l, r, 'M')], [0.5, 0.5]);
  assert.deepEqual([...channelOf(l, r, 'S')], [0.5, 0]);
  assert.deepEqual([...channelOf(l, r, 'R')], [0, 0.5]);
});

// ------------------------------------------------------------------------------------------------ stereo
test('stereoStats: correlation and balance', () => {
  const s = sine(440, 4800);
  const neg = s.map((x) => -x);
  const quad = sine(440, 4800, { phase: Math.PI / 2 });
  const zero = new Float32Array(4800);
  assert.ok(Math.abs(stereoStats(s, s).corr - 1) < 1e-6, 'mono = +1');
  assert.ok(Math.abs(stereoStats(s, neg).corr + 1) < 1e-6, 'polarity flip = −1');
  assert.ok(Math.abs(stereoStats(s, quad).corr) < 0.01, '90° = 0');
  assert.equal(stereoStats(zero, zero).corr, 0, 'silence = 0');
  assert.ok(Math.abs(stereoStats(s, s).balance) < 1e-9);
  assert.equal(stereoStats(s, zero).balance, -1, 'hard left');
  assert.equal(stereoStats(zero, s).balance, 1, 'hard right');
  const half = s.map((x) => x * 0.5);
  const st = stereoStats(s, half);
  assert.ok(Math.abs(st.balanceDb + 6.0206) < 1e-3, 'R 6 dB down');
  assert.ok(Math.abs(st.balance - (0.25 - 1) / 1.25) < 1e-6);
  assert.ok(Math.abs(stereoStats(s, s).rmsS) < 1e-9);
  assert.ok(Math.abs(stereoStats(s, s).rmsM - Math.SQRT1_2) < 1e-3);
});

test('StereoMeter integrates the sums over its time constant', () => {
  const m = new StereoMeter(0.3);
  const s = sine(440, 2048);
  for (let i = 0; i < 20; i++) m.push(s, s, 2048, SR);
  assert.ok(m.read().corr > 0.999);
  const neg = s.map((x) => -x);
  m.push(s, neg, 2048, SR); // one 43 ms block of anti-phase: the reading moves, but stays positive
  const r1 = m.read().corr;
  assert.ok(r1 < 0.999 && r1 > 0, `${r1}`);
  for (let i = 0; i < 60; i++) m.push(s, neg, 2048, SR);
  assert.ok(m.read().corr < -0.99);
  assert.equal(smoothCoef(0.1, 0), 0);
  assert.ok(Math.abs(smoothCoef(0.3, 0.3) - Math.exp(-1)) < 1e-12);
});

// ------------------------------------------------------------------------------------------------ spectrum
test('SpectrumAnalyzer: a full-scale bin-centred sine reads 0 dB for every window, two channels at once', () => {
  const N = 4096, binHz = SR / N;
  const k = 100, f = k * binHz;
  for (const w of ['hann', 'hamming', 'blackman', 'blackman-harris', 'flattop', 'rect']) {
    const an = new SpectrumAnalyzer(N).analyze(sine(f, N), sine(f, N, { amp: 0.5 }), w);
    assert.ok(Math.abs(powToDb(an.pa[k])) < 0.05, `${w} L ${powToDb(an.pa[k])}`);
    assert.ok(Math.abs(powToDb(an.pb[k]) + 6.0206) < 0.05, `${w} R ${powToDb(an.pb[k])}`);
  }
  // separation: a silent second channel stays silent
  const an = new SpectrumAnalyzer(N).analyze(sine(f, N), new Float32Array(N), 'hann');
  assert.ok(powToDb(an.pb[k]) < -150);
  // reads the newest N samples of a longer block
  const long = new Float32Array(N * 2); long.set(sine(f, N), N);
  assert.ok(Math.abs(powToDb(new SpectrumAnalyzer(N).analyze(long, null).pa[k])) < 0.05);
  // DC
  const dc = new SpectrumAnalyzer(N).analyze(new Float32Array(N).fill(1), null, 'rect');
  assert.ok(Math.abs(powToDb(dc.pa[0])) < 1e-6);
  const w = makeWindow('hann', 8);
  assert.equal(w[0], 0); assert.ok(Math.abs(w[4] - 1) < 1e-6);
});

test('flat-top window measures an off-bin sine within 0.1 dB (scalloping)', () => {
  const N = 4096, f = 100.5 * (SR / N);
  const ft = new SpectrumAnalyzer(N).analyze(sine(f, N), null, 'flattop').pa;
  const hn = new SpectrumAnalyzer(N).analyze(sine(f, N), null, 'hann').pa;
  const peak = (p) => powToDb(Math.max(...p));
  assert.ok(Math.abs(peak(ft)) < 0.1, `${peak(ft)}`);
  assert.ok(peak(hn) < -1, 'hann scallops ~1.4 dB');
});

test('slope tilt is 0 dB at 1 kHz and +slope per octave', () => {
  const binHz = 10;
  const g = slopeGains(3000, binHz, 4.5);
  assert.ok(Math.abs(powToDb(g[100])) < 1e-6);
  assert.ok(Math.abs(powToDb(g[200]) - 4.5) < 1e-4);
  assert.ok(Math.abs(powToDb(g[50]) + 4.5) < 1e-4);
  assert.ok(Math.abs(powToDb(slopeGains(3000, binHz, 3)[2000]) - 3 * Math.log2(20)) < 1e-3);
  assert.ok(slopeGains(10, binHz, 0).every((x) => x === 1));
});

test('averaging, max and peak hold', () => {
  const st = new Float32Array([0, 0]);
  averageInto(st, new Float32Array([1, 2]), 0);
  assert.deepEqual([...st], [1, 2]);
  averageInto(st, new Float32Array([0, 0]), 0.5);
  assert.deepEqual([...st], [0.5, 1]);
  const mx = new Float32Array([1, 5]);
  maxInto(mx, new Float32Array([3, 2]));
  assert.deepEqual([...mx], [3, 5]);
  const ph = new PeakHold(1);
  ph.update(Float32Array.of(-10), 0.1, 1, 10);
  ph.update(Float32Array.of(-40), 0.5, 1, 10);
  assert.equal(ph.v[0], -10, 'holds');
  ph.update(Float32Array.of(-40), 0.6, 1, 10); // age 1.1 s > hold: falls 6 dB
  assert.ok(Math.abs(ph.v[0] + 16) < 1e-4);
  for (let i = 0; i < 100; i++) ph.update(Float32Array.of(-40), 0.1, 1, 10);
  assert.equal(ph.v[0], -40, 'never below the trace');
  ph.update(Float32Array.of(-3), 0.1);
  assert.equal(ph.v[0], -3);
  ph.reset();
  assert.equal(ph.v[0], -200);
});

test('fractional-octave smoothing keeps a flat spectrum flat and spreads a peak', () => {
  const flat = new Float32Array(1000).fill(2);
  assert.ok(octaveSmooth(flat, 3).every((x) => Math.abs(x - 2) < 1e-9));
  const spike = new Float32Array(1000); spike[500] = 1;
  const sm = octaveSmooth(spike, 6);
  assert.ok(sm[500] < 1 && sm[500] > 0);
  assert.ok(sm[520] > 0, 'spread within ±1/12 oct');
  assert.equal(sm[700], 0);
  assert.deepEqual([...octaveSmooth(spike, 0)], [...spike]);
});

test('display resampling keeps peaks and interpolates the sparse low end', () => {
  const binHz = 10;
  const p = new Float32Array(2049).fill(1e-6);
  p[1000] = 1; // 10 kHz
  const edges = bandEdges(100, 'log', 20, 20000);
  const db = resampleBands(p, binHz, edges);
  assert.equal(Math.max(...db), 0, 'the peak survives');
  const at = Math.floor(freqToNorm(10000, 'log', 20, 20000) * 100);
  assert.equal(db[at], 0);
  const ramp = Float32Array.from({ length: 100 }, (_, k) => Math.pow(10, k / 10)); // k dB per bin
  const sparse = resampleBands(ramp, binHz, [20.5, 21, 22]);
  assert.ok(Math.abs(sparse[0] - 2.075) < 1e-5 && Math.abs(sparse[1] - 2.15) < 1e-5, `${[...sparse]}`);
});

test('frequency scales: log / linear / mel mapping round-trips', () => {
  for (const scale of ['log', 'linear', 'mel']) {
    const lo = scale === 'log' ? 20 : 0;
    for (const f of [20, 100, 1000, 5000, 19000]) {
      const t = freqToNorm(f, scale, lo, 20000);
      assert.ok(t >= 0 && t <= 1, `${scale} ${f}`);
      assert.ok(Math.abs(normToFreq(t, scale, lo, 20000) - f) < 1e-6 * f, `${scale} ${f}`);
    }
    assert.ok(Math.abs(freqToNorm(20000, scale, lo, 20000) - 1) < 1e-12);
  }
  assert.ok(Math.abs(freqToNorm(632.456, 'log', 20, 20000) - 0.5) < 1e-4, 'decades evenly spaced');
  assert.equal(freqToNorm(10000, 'linear', 0, 20000), 0.5);
  assert.ok(Math.abs(hzToMel(1000) - 1000) < 0.5, 'mel(1 kHz) ≈ 1000');
  assert.ok(Math.abs(melToHz(hzToMel(3000)) - 3000) < 1e-6);
  const e = bandEdges(4, 'log', 20, 20000);
  assert.ok(Math.abs(e[0] - 20) < 1e-9 && Math.abs(e[4] - 20000) < 1e-6);
});

test('colour maps: endpoints, monotonic lightness for the colour-blind safe maps, LUT layout', () => {
  assert.deepEqual(mapColor('viridis', 0), [0x44, 0x01, 0x54]);
  assert.deepEqual(mapColor('viridis', 1), [0xfd, 0xe7, 0x25]);
  assert.deepEqual(mapColor('gray', 0.5), [128, 128, 128]);
  assert.deepEqual(mapColor('viridis', -1), mapColor('viridis', 0));
  assert.deepEqual(mapColor('nope', 1), mapColor('viridis', 1));
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (const name of ['viridis', 'cividis', 'magma', 'inferno', 'gray']) {
    let last = -1;
    for (let i = 0; i <= 20; i++) { const L = lum(mapColor(name, i / 20)); assert.ok(L >= last - 1, `${name} lightness at ${i}`); last = L; }
  }
  for (const name of COLORMAPS) {
    const lut = colormapLUT(name);
    assert.equal(lut.length, 1024);
    assert.equal(lut[3], 255);
    assert.deepEqual([lut[1020], lut[1021], lut[1022]], mapColor(name, 1));
  }
  assert.equal(dbToNorm(-100, -100, 90), 0);
  assert.equal(dbToNorm(-10, -100, 90), 1);
  assert.equal(dbToNorm(-55, -100, 90), 0.5);
});

// ------------------------------------------------------------------------------------------------ pitch / tuner
test('detectPitch finds the fundamental of tones from low B to high notes', () => {
  for (const f of [30.87, 41.2, 82.41, 110, 196, 440, 1046.5, 3520]) {
    const n = 8192;
    const s = Float32Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * f * i) / SR;
      return 0.5 * Math.sin(t) + 0.25 * Math.sin(2 * t) + 0.12 * Math.sin(3 * t);
    });
    const r = detectPitch(s, SR, { minFreq: 25, maxFreq: 4200 });
    assert.ok(Math.abs(1200 * Math.log2(r.freq / f)) < 2, `${f}: ${r.freq}`);
    assert.ok(r.conf > 0.8);
  }
  assert.equal(detectPitch(new Float32Array(8192), SR).freq, 0);
  assert.equal(detectPitch(new Float32Array(100), SR).freq, 0, 'too short');
});

test('TunerTracker: gate, smoothing, note changes and hold', () => {
  const t = new TunerTracker({ a4: 440, gateDb: -50, smooth: 0.1, holdSec: 1 });
  const loud = 0.1; // −20 dBFS
  let r = t.push({ freq: 440 * Math.pow(2, 8 / 1200), conf: 0.95, rms: loud }, 1 / 30);
  assert.equal(r.active, true);
  assert.equal(r.note.label, 'A4');
  assert.ok(Math.abs(r.cents - 8) < 0.01);
  for (let i = 0; i < 30; i++) r = t.push({ freq: 440, conf: 0.95, rms: loud }, 1 / 30);
  assert.ok(Math.abs(r.cents) < 0.5, `settles to 0, got ${r.cents}`);
  r = t.push({ freq: 440, conf: 0.95, rms: 0.001 }, 1 / 30); // −60 dB: gated
  assert.equal(r.active, false);
  assert.equal(r.held, true);
  assert.equal(r.note.label, 'A4');
  for (let i = 0; i < 40; i++) r = t.push({ freq: 0, conf: 0, rms: 0 }, 1 / 30);
  assert.equal(r.held, false);
  assert.equal(r.note, null);
  r = t.push({ freq: 415.3, conf: 0.95, rms: loud }, 1 / 30);
  assert.equal(r.note.label, 'G♯4');
  t.set({ flats: true });
  r = t.push({ freq: 415.3, conf: 0.95, rms: loud }, 1 / 30);
  assert.equal(r.note.label, 'A♭4');
  r = t.push({ freq: 440, conf: 0.3, rms: loud }, 1 / 30);
  assert.equal(r.active, false, 'low confidence is gated');
});
