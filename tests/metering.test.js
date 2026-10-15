// Metering: meter ballistics / scales, loudness statistics (histogram, PLR / PSR, DR), delivery-target checks,
// utility meters (bits, DC, clips) incl. the utility worklet, the export analysis and the per-channel analysis hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Ballistics, StereoBallistics, METER_MODES, meterScale, VU_OMEGA, vuStep } from '../src/audio/dsp/ballistics.js';
import { LoudnessHistogram, plr, psr, PeakWindow, drOf, DynamicRange, dynamicRange, checkTarget, analyzeRender, analysisRows, analysisJson, averageSpectrum } from '../src/audio/dsp/loudness-stats.js';
import { bitMask, analyzeBits, dcOffset, ClipCounter, UtilityStats, analyzeUtility } from '../src/audio/dsp/utility-meters.js';
import { measureLoudness, LOUDNESS_PRESETS } from '../src/audio/dsp/loudness.js';
import { MasterAnalysis } from '../src/audio/meters.js';
import { stripOf, meterBlock, loudnessOf, releaseLoudness, releaseLightExcept, channelList } from '../src/audio/analysis-hub.js';
import { MockContext } from './lib/mock-audio.js';

const SR = 48000;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const sine = (sec, amp = 0.5, freq = 1000, sr = SR) => {
  const n = Math.round(sec * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
};
const db = (a) => 20 * Math.log10(a);

// ------------------------------------------------------------------ ballistics
test('ballistics: a steady sine reads its peak level on peak / VU / PPM / K meters, RMS reads −3 dB', () => {
  const x = sine(4, 0.5);
  for (const m of METER_MODES) {
    const b = new Ballistics(m.id, SR).process(x);
    near(b.db, m.kind === 'rms' ? db(0.5) - 3.01 : db(0.5), 0.1, m.id);
  }
});

test('ballistics: digital peak falls 20 dB in 1.7 s; PPM type II 24 dB in 2.8 s, type I 20 dB in 1.7 s', () => {
  const fall = (mode, sec) => { const b = new Ballistics(mode, SR).process(sine(1, 1)); const d0 = b.db; b.process(new Float32Array(Math.round(sec * SR))); return d0 - b.db; };
  near(fall('peak', 1.7), 20, 0.1, 'peak');
  near(fall('ppm-bbc', 2.8), 24, 0.2, 'bbc');
  near(fall('ppm-ebu', 2.8), 24, 0.2, 'ebu');
  near(fall('ppm-din', 1.7), 20, 0.2, 'din');
  near(fall('ppm-nordic', 1.7), 20, 0.2, 'nordic');
});

test('ballistics: PPM integration time — a tone burst of that length reads 2 dB under the steady tone', () => {
  for (const [mode, integ] of [['ppm-bbc', 0.010], ['ppm-ebu', 0.010], ['ppm-din', 0.005], ['ppm-nordic', 0.005]]) {
    const steady = new Ballistics(mode, SR).process(sine(1, 0.5, 5000)).db;
    const burst = new Ballistics(mode, SR).process(sine(integ, 0.5, 5000)).db;
    near(burst - steady, -2, 0.1, mode);
    // a much longer burst reads (almost) the full level, a much shorter one far less
    assert.ok(new Ballistics(mode, SR).process(sine(integ * 10, 0.5, 5000)).db - steady > -0.3);
    assert.ok(new Ballistics(mode, SR).process(sine(integ / 5, 0.5, 5000)).db - steady < -6);
  }
});

test('ballistics: VU reaches 99 % of the reading after 300 ms and overshoots by ~1–1.5 %', () => {
  near(vuStep(0.3, VU_OMEGA), 0.99, 1e-6, 'continuous step');
  const x = sine(1.5, 0.5);
  const b = new Ballistics('vu', SR);
  const ref = db(0.5);
  let t99 = null, max = 0;
  for (let i = 0; i < x.length; i += 24) {
    b.process(x, i, Math.min(x.length, i + 24));
    const lin = Math.pow(10, (b.db - ref) / 20);
    if (t99 == null && lin >= 0.99) t99 = (i + 24) / SR;
    if (lin > max) max = lin;
  }
  near(t99, 0.3, 0.01, 't99');
  assert.ok(max > 1.005 && max < 1.02, `overshoot ${max}`);
});

test('ballistics: RMS / K integrate (a short burst reads low), peak reacts instantly', () => {
  const burst = sine(0.03, 0.5);
  assert.ok(new Ballistics('rms', SR).process(burst).db < db(0.5) - 3.01 - 6);
  assert.ok(new Ballistics('k14', SR).process(burst).db < db(0.5) - 8);
  near(new Ballistics('peak', SR).process(burst).db, db(0.5), 0.01, 'peak');
});

test('ballistics: feed() of overlapping analyser windows equals one continuous pass; gaps count as silence', () => {
  for (const mode of ['vu', 'ppm-bbc', 'k20', 'rms', 'peak']) {
    const x = sine(1, 0.4, 440);
    const ref = new Ballistics(mode, SR).process(x);
    const fed = new Ballistics(mode, SR);
    const hop = 1600; // ~30 fps at 48 kHz, analyser window 2048
    for (let end = hop; end <= x.length; end += hop) fed.feed(x.subarray(Math.max(0, end - 2048), end), hop / SR);
    const rest = x.length % hop;
    if (rest) fed.feed(x.subarray(x.length - 2048), rest / SR);
    near(fed.db, ref.db, 0.01, mode);
    // a gap longer than the window: idle() + the window
    const a = new Ballistics(mode, SR).process(x).process(new Float32Array(SR / 2)).process(x.subarray(0, 2048));
    const bb = new Ballistics(mode, SR).process(x).feed(x.subarray(0, 2048), (SR / 2 + 2048) / SR);
    near(bb.db, a.db, 0.05, `${mode} gap`);
  }
});

test('ballistics: stereo meter reports both channels, the fast peak and the sample peak', () => {
  const s = new StereoBallistics('vu', SR);
  s.feed(sine(0.5, 0.5), sine(0.5, 0.25), 0.5);
  const r = s.read();
  assert.ok(r.db[0] > r.db[1] + 5);
  near(r.peakDb[0], db(0.5), 0.05, 'fast peak');
  near(r.samplePeak[0], 0.5, 0.001, 'sample peak');
  assert.equal(s.read().samplePeak[0], 0); // taken
});

test('meter scales: references and labels', () => {
  const vu = meterScale('vu', { vuRef: -18 });
  assert.equal(vu.label(-18), '0.0');
  assert.equal(vu.label(-15), '+3.0');
  assert.equal(meterScale('vu', { vuRef: -20 }).label(-20), '0.0');
  const bbc = meterScale('ppm-bbc', { align: -18 });
  assert.equal(bbc.label(-18), '4.0'); // mark 4 = alignment
  assert.equal(bbc.label(-10), '6.0'); // mark 6 = permitted maximum (+8 dB)
  assert.equal(bbc.label(-32), '1.0'); // mark 1 = −14 dB
  assert.deepEqual(bbc.ticks.map((t) => t.label), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(meterScale('ppm-ebu').ticks.find((t) => t.label === 'TEST').db, -18);
  assert.equal(meterScale('ppm-din').label(-9), '0.0'); // 0 dB DIN = permitted maximum = alignment + 9
  const k = meterScale('k14');
  assert.equal(k.label(-14), '0.0');
  assert.equal(k.zones.find((z) => z.level === 'warn').from, -14);
  assert.equal(meterScale('k20').hi, 0);
  near(meterScale('peak').pos(0), 60 / 66, 1e-9, 'peak pos');
  assert.equal(meterScale('vu').pos(-100), 0);
});

// ------------------------------------------------------------------ loudness statistics
test('histogram: bins, percentiles, peak bin; values below the range are ignored', () => {
  const hg = new LoudnessHistogram({ lo: -60, hi: 0, step: 1 });
  for (let i = 0; i < 80; i++) hg.add(-14.4);
  for (let i = 0; i < 20; i++) hg.add(-20.2);
  hg.add(-70); hg.add(-Infinity); hg.add(NaN); hg.add(3);
  assert.equal(hg.count, 101);
  assert.equal(hg.bins[hg.index(-14.4)], 80);
  assert.equal(hg.centre(hg.peakBin()), -14.5);
  assert.equal(hg.percentile(10), -20.5);
  assert.equal(hg.percentile(50), -14.5);
  assert.equal(hg.bins[hg.bins.length - 1], 1); // ≥ hi goes to the top bin
  hg.reset();
  assert.equal(hg.count, 0);
  assert.equal(hg.percentile(50), null);
});

test('PLR / PSR / peak window', () => {
  assert.equal(plr(-1, -9), 8);
  assert.equal(psr(-0.5, -8.5), 8);
  assert.equal(plr(-1, -Infinity), null);
  assert.equal(psr(-Infinity, -10), null);
  const w = new PeakWindow(3);
  w.push(0.5).push(1).push(0.25);
  assert.equal(w.max, 1);
  w.push(0.1);
  assert.equal(w.max, 1);
  w.push(0.1);
  assert.equal(w.max, 0.25);
  near(w.maxDb, db(0.25), 1e-9);
});

test('DR: a steady sine is DR0, a sine with sparse 12 dB peaks is DR12; streaming = offline', () => {
  near(dynamicRange([sine(9, 0.5), sine(9, 0.5)], SR), 0, 0.05, 'sine');
  const x = sine(30, 0.25);
  for (let k = 1; k < 10; k++) x[Math.round(k * 3 * SR) - 100] = 1; // one spike per 3 s block
  const dr = dynamicRange([x, x], SR);
  near(dr, db(1 / 0.25), 0.1, 'spiky');
  const s = new DynamicRange();
  const hop = SR / 10;
  for (let o = 0; o + hop <= x.length; o += hop) {
    let ss = 0, pk = 0;
    for (let i = o; i < o + hop; i++) { ss += x[i] * x[i]; pk = Math.max(pk, Math.abs(x[i])); }
    s.push({ n: hop, ss: [ss, ss], pk: [pk, pk] });
  }
  near(s.value, dr, 0.05, 'streaming');
  assert.equal(drOf([]), null);
});

test('delivery targets: pass / adjust and what a platform does with the master', () => {
  const sp = LOUDNESS_PRESETS.find((x) => x.id === 'spotify');
  const yt = LOUDNESS_PRESETS.find((x) => x.id === 'youtube');
  const ebu = LOUDNESS_PRESETS.find((x) => x.id === 'ebu');
  const atsc = LOUDNESS_PRESETS.find((x) => x.id === 'atsc');
  for (const id of ['spotify', 'apple', 'youtube', 'tidal', 'amazon', 'deezer', 'soundcloud', 'ebu', 'atsc', 'podcast', 'cd', 'club']) assert.ok(LOUDNESS_PRESETS.find((x) => x.id === id), id);
  assert.equal(checkTarget({ integrated: -14.3, truePeakDb: -1.2 }, sp).status, 'pass');
  const loud = checkTarget({ integrated: -8, truePeakDb: -0.2 }, yt);
  assert.equal(loud.status, 'adjust');
  near(loud.playbackGainDb, -6, 1e-9, 'turned down');
  near(loud.playbackPeakDb, -6.2, 1e-9, 'peak after');
  assert.ok(!loud.peakOk && !loud.loudnessOk);
  // 'down' platforms never turn a quiet master up
  assert.equal(checkTarget({ integrated: -20, truePeakDb: -6 }, yt).playbackGainDb, 0);
  // 'both': up only within the true-peak headroom
  const quiet = checkTarget({ integrated: -20, truePeakDb: -4 }, sp);
  near(quiet.playbackGainDb, 3, 1e-9, 'limited by peak');
  assert.match(quiet.message, /headroom/);
  near(checkTarget({ integrated: -20, truePeakDb: -12 }, sp).playbackGainDb, 6, 1e-9, 'full gain');
  // broadcast: tolerance from the spec
  assert.equal(checkTarget({ integrated: -23.4, truePeakDb: -3 }, ebu).status, 'pass');
  assert.equal(checkTarget({ integrated: -23.8, truePeakDb: -3 }, ebu).status, 'adjust');
  assert.equal(checkTarget({ integrated: -25.5, truePeakDb: -3 }, atsc).status, 'pass');
  assert.equal(checkTarget({ integrated: -24, truePeakDb: -1.5 }, atsc).status, 'adjust'); // over −2 dBTP
  assert.equal(checkTarget({ integrated: -Infinity, truePeakDb: -Infinity }, sp).status, 'none');
  assert.equal(checkTarget({ integrated: -14, truePeakDb: -1 }, null).status, 'none');
});

test('MasterAnalysis (light, no worklet): histogram, PSR, PLR, DR and pause from posted blocks', () => {
  const ctx = new MockContext({ sampleRate: SR });
  const a = new MasterAnalysis(ctx, ctx.createGain(), ctx.createGain(), { truePeak: false, views: false });
  // −20 LUFS-ish blocks with a 0.5 (−6 dBFS) peak
  const e = Math.pow(10, (-20 + 0.691) / 10);
  for (let i = 0; i < 60; i++) a._block({ e, tp: 0.5, n: 4800, ss: [4800 * 0.01, 4800 * 0.01], pk: [0.5, 0.5] });
  const r = a.read();
  near(r.integrated, -20, 0.01, 'I');
  near(r.plr, db(0.5) + 20, 0.01, 'PLR');
  near(r.psr, db(0.5) + 20, 0.01, 'PSR');
  assert.equal(r.histogram.count, 31); // one value per block once 3 s are in
  near(r.dr, db(0.5 / Math.sqrt(0.02)), 0.01, 'DR');
  a.setPaused(true);
  a._block({ e: e * 100, tp: 1 });
  assert.equal(a.read().histogram.count, 31);
  assert.ok(a.read().paused);
  a.setPaused(false);
  a.reset();
  assert.equal(a.read().histogram.count, 0);
  assert.equal(a.read().dr, null);
  a.dispose();
});

// ------------------------------------------------------------------ utility meters
test('bit meter: real resolution, padded 16-bit material, float detail, digital silence', () => {
  const x = sine(0.1, 0.5, 997);
  const q16 = x.map((v) => Math.round(v * 32768) / 32768);
  const q24 = x.map((v) => Math.round(v * 8388608) / 8388608);
  const b16 = bitMask(q16), b24 = bitMask(q24), bf = bitMask(x);
  const a16 = analyzeBits(b16.mask, b16), a24 = analyzeBits(b24.mask, b24), af = analyzeBits(bf.mask, bf);
  assert.equal(a16.effective, 16);
  assert.match(a16.verdict, /16-bit/);
  assert.equal(a24.effective, 24);
  assert.ok(!a24.float);
  assert.ok(af.float);
  assert.equal(a16.msb, 23); // peaks in the top 6 dB use the top magnitude bit
  assert.equal(a16.used.length, 23);
  assert.ok(a16.used[0] && a16.used[14] && !a16.used[15] && !a16.used[22]); // bits 22 … 8 of the magnitude
  const quiet = bitMask(sine(0.1, 0.1, 997)); // −20 dBFS: three top bits idle
  assert.equal(analyzeBits(quiet.mask, quiet).msb, 20);
  const s = analyzeBits(bitMask(new Float32Array(100)).mask);
  assert.ok(s.silent);
  assert.equal(s.effective, 0);
});

test('DC offset and clip counter (runs of consecutive full-scale samples, across blocks)', () => {
  const x = sine(0.1, 0.5).map((v) => v + 0.01);
  near(dcOffset(x), 0.01, 1e-4, 'dc');
  const c = new ClipCounter({ minRun: 3 });
  c.process(0, Float32Array.from([0, 1, 1, 0, 1, 1, 1, 0])); // a 2-run (no clip) and a 3-run (clip)
  assert.equal(c.events[0], 1);
  c.process(0, Float32Array.from([1, 1])); // run continues over the block boundary …
  c.process(0, Float32Array.from([1, 0.2])); // … and becomes a clip
  assert.equal(c.events[0], 2);
  c.process(1, Float32Array.from([-1.2, -1.1, -1, -1, 0]));
  assert.equal(c.events[1], 1);
  assert.equal(c.longest, 4);
  assert.equal(c.overs, 2);
  assert.equal(c.total, 3);
  c.reset();
  assert.equal(c.total, 0);
});

test('utility worklet matches the pure statistics', () => {
  const src = readFileSync(new URL('../src/audio/utility-worklet.js', import.meta.url), 'utf8');
  let Proc = null;
  const posts = [];
  const sandbox = {
    sampleRate: SR, Math,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posts.push(structuredClone(m)), onmessage: null }; } },
    registerProcessor: (name, cls) => { Proc = cls; },
  };
  vm.runInNewContext(src, sandbox);
  const p = new Proc({ processorOptions: {} });
  const L = sine(0.3, 0.6, 440).map((v) => Math.round(v * 32768) / 32768 + 0.002);
  const R = sine(0.3, 1.4, 220).map((v) => Math.max(-1, Math.min(1, v))); // clipped flat tops
  for (let o = 0; o < L.length; o += 128) p.process([[L.subarray(o, o + 128), R.subarray(o, o + 128)]]);
  assert.equal(posts.length, 3);
  const live = new UtilityStats();
  for (const m of posts) live.push(m);
  const off = analyzeUtility([L, R]);
  const lr = live.read();
  assert.deepEqual(lr.clips.events, off.clips.events);
  assert.ok(off.clips.events[1] > 0 && off.clips.events[0] === 0);
  near(lr.dc[0], off.dc[0], 1e-7, 'dc');
  assert.equal(lr.bits.effective, off.bits.effective);
  assert.equal(lr.bits.effective, 24); // the clipped sine is float detail
  assert.equal(analyzeBits(posts[0].mask & 0, {}).silent, true);
});

test('loudness worklet: true-peak can be switched off; per-channel sum of squares / peaks for DR', () => {
  const src = readFileSync(new URL('../src/audio/loudness-worklet.js', import.meta.url), 'utf8');
  const run = (truePeak) => {
    let Proc = null;
    const posts = [];
    vm.runInNewContext(src, {
      sampleRate: SR, Math, Float64Array,
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posts.push(structuredClone(m)) }; } },
      registerProcessor: (n, c) => { Proc = c; },
    });
    const p = new Proc({ processorOptions: { coeffs: [{ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }], truePeak } });
    const x = sine(0.1, 0.5, 11000); // near Nyquist / 2: inter-sample peaks above the sample peak
    for (let o = 0; o < x.length; o += 128) p.process([[x.subarray(o, o + 128), x.subarray(o, o + 128)]]);
    return posts[0];
  };
  const on = run(true), off = run(false);
  let sp = 0, ss = 0;
  const x = sine(0.1, 0.5, 11000);
  for (const v of x) { sp = Math.max(sp, Math.abs(v)); ss += v * v; }
  near(off.tp, sp, 1e-7, 'sample peak when off');
  assert.ok(on.tp >= off.tp);
  near(off.pk[0], sp, 1e-7, 'pk');
  near(off.ss[0], ss, 1e-6, 'ss');
  assert.equal(off.n, SR / 10);
  near(on.e, off.e, 1e-9, 'energy unaffected');
});

// ------------------------------------------------------------------ export analysis
test('analyzeRender: loudness figures match measureLoudness; PLR, PSR, clips, DC, spectrum, series', () => {
  const l = sine(8, 0.5, 1000), r = sine(8, 0.5, 1000);
  for (let i = 0; i < l.length; i++) l[i] += 0.005; // DC on the left
  for (let i = 4 * SR; i < 4 * SR + 5; i++) { r[i] = 1; } // one 5-sample clip on the right
  const a = analyzeRender([l, r], SR);
  const m = measureLoudness([l, r], SR);
  near(a.integrated, m.integrated, 1e-9, 'I');
  near(a.lra, m.lra, 1e-9, 'LRA');
  near(a.truePeakDb, m.truePeakDb, 1e-6, 'TP');
  near(a.shortTermMax, m.shortTermMax, 1e-9, 'max S');
  near(a.momentaryMax, m.momentaryMax, 1e-9, 'max M');
  near(a.plr, a.truePeakDb - a.integrated, 1e-9, 'PLR');
  assert.ok(a.psrMin > 0 && a.psrMin <= a.plr + 0.5);
  assert.equal(a.clips.events[1], 1);
  assert.equal(a.clips.total, 1);
  near(a.dc[0], 0.005, 1e-4, 'dc');
  near(a.dcOffset, 0.005, 1e-4, 'dc worst');
  assert.equal(a.shortTerm.length, 80 - 29);
  assert.equal(a.momentary.length, 80 - 3);
  assert.ok(a.histogram.bins.reduce((x, y) => x + y, 0) > 0);
  const top = a.spectrum.reduce((x, y) => (y.db > x.db ? y : x));
  assert.ok(top.f > 900 && top.f < 1120, `spectrum peak at ${top.f}`);
  const rows = analysisRows(a, LOUDNESS_PRESETS[0]);
  assert.ok(rows.find(([k]) => k === 'PLR'));
  assert.ok(rows.find(([k]) => k.startsWith('Target')));
  const j = analysisJson(a, { file: 'x.wav' });
  assert.equal(j.file, 'x.wav');
  assert.equal(j.shortTermLufs.length, Math.ceil(a.shortTerm.length / 10));
  assert.ok(JSON.stringify(j).length < 20000);
});

test('average spectrum: a full-scale sine reads ~0 dB at its frequency', () => {
  const sp = averageSpectrum([sine(1, 1, 1000)], SR, { points: 96 });
  const top = sp.reduce((x, y) => (y.db > x.db ? y : x));
  near(top.db, 0, 1.5, 'level');
});

// ------------------------------------------------------------------ analysis hub
test('analysis hub: channel taps per graph, light analyses released, meter blocks', () => {
  const ctx = new MockContext({ sampleRate: SR });
  const mkStrip = () => { const s = { input: ctx.createGain(), muteGain: ctx.createGain(), anL: ctx.createAnalyser(), anR: ctx.createAnalyser() }; s.anL.fftSize = s.anR.fftSize = 2048; return s; };
  let masterCalls = 0;
  const graph = { master: mkStrip(), out: ctx.createGain(), tracks: new Map([['t1', { strip: mkStrip() }]]), buses: new Map([['b1', mkStrip()]]), masterAnalysis() { masterCalls++; return 'MASTER'; } };
  const engine = { ctx, graph };
  assert.equal(stripOf(graph, 't1'), graph.tracks.get('t1').strip);
  assert.equal(stripOf(graph, 'b1'), graph.buses.get('b1'));
  assert.equal(stripOf(graph, 'nope'), null);
  assert.equal(loudnessOf(engine, 'master'), 'MASTER');
  const t = loudnessOf(engine, 't1', { light: true });
  assert.ok(t instanceof MasterAnalysis);
  assert.equal(loudnessOf(engine, 't1', { light: true }), t); // cached
  assert.notEqual(loudnessOf(engine, 't1'), t); // full analysis is a separate tap
  releaseLightExcept(engine, new Set(['b1']));
  assert.ok(t.disposed);
  releaseLoudness(engine, 't1');
  const blk = meterBlock(engine, 'b1');
  assert.equal(blk.l.length, 2048);
  assert.equal(blk.sampleRate, SR);
  assert.equal(meterBlock(engine, 'zzz'), null);
  // a new graph gets fresh taps
  const t2 = loudnessOf(engine, 'b1', { light: true });
  engine.graph = { ...graph, masterAnalysis: () => 'M2' };
  assert.notEqual(loudnessOf(engine, 'b1', { light: true }), t2);
  assert.ok(t2.disposed);
  assert.equal(loudnessOf({ ctx: null, graph }, 'master'), null);
  assert.deepEqual(channelList({ tracks: [{ id: 't1', name: 'Kick' }], buses: [{ id: 'b1', name: 'Verb' }] }).map((c) => c.id), ['master', 't1', 'b1']);
});
