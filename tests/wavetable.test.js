// Wavetable synth: table generation, mipmaps, morphing, warps, WAV / Serum import, resynthesis, storage and the
// AudioWorklet processor (run in Node through tests/lib/worklet-harness.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_SIZE, MIP_HARMONICS, mipSize, frameFromHarmonics, harmonicsOf, bandlimit, resampleCycle, removeDC, normalizeFrames,
  buildMipmaps, mipLevel, readLevel, readMorph, encodeTable, decodeTable, addProjectTable, sanitizeWavetables, referencedTables, morphKeys,
} from '../src/audio/wavetable/tables.js';
import { FACTORY_TABLES, FACTORY_CATEGORIES, factoryFrames, factoryTableOptions } from '../src/audio/wavetable/factory.js';
import { WARP_MODES, warpPhase, warpGain, warpBandwidth } from '../src/audio/wavetable/warp.js';
import { parseWav, classifyWav, importWavetable, detectPitch, resynthesize, splitFrames } from '../src/audio/wavetable/import.js';
import { Env, Svf, unisonLayout, panGains } from '../src/audio/wavetable/voice-dsp.js';
import { fallbackSynthParams, tableMips } from '../src/audio/wavetable/engine.js';
import { fft } from '../src/audio/dsp/fft.js';
import { getParamDefaults, sanitizeParams, INSTRUMENT_DEFS } from '../src/audio/defs.js';
import { PRESETS, resolveInstrumentDef } from '../src/audio/presets.js';
import { normalizeProject, createProject, createTrack } from '../src/core/model.js';
import { loadProcessor } from './lib/worklet-harness.js';

const PROC = new URL('../src/audio/wavetable/processor.js', import.meta.url).href;
const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b} (±${eps})`);

/** Energy fraction above harmonic `h` of one cycle. */
function energyAbove(cycle, hLimit) {
  const n = cycle.length, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = cycle[i];
  fft(re, im);
  let lo = 0, hi = 0;
  for (let k = 1; k < n / 2; k++) { const e = re[k] ** 2 + im[k] ** 2; if (k > hLimit) hi += e; else lo += e; }
  return hi / (lo + hi + 1e-30);
}

test('factory: 50+ generated tables in every category, finite, normalized, DC-free', () => {
  const ids = Object.keys(FACTORY_TABLES);
  assert.ok(ids.length >= 50, `${ids.length} tables`);
  for (const cat of FACTORY_CATEGORIES) assert.ok(ids.some((id) => FACTORY_TABLES[id].category === cat), cat);
  assert.equal(factoryTableOptions().length, ids.length);
  for (const id of ids) {
    const fr = factoryFrames(id);
    assert.ok(fr.length >= 1 && fr.length <= 256, id);
    let pk = 0;
    for (const f of fr) {
      assert.equal(f.length, FRAME_SIZE, id);
      let dc = 0;
      for (const x of f) { assert.ok(Number.isFinite(x), id); pk = Math.max(pk, Math.abs(x)); dc += x; }
      assert.ok(Math.abs(dc / f.length) < 1e-3, `${id} DC`);
    }
    close(pk, 0.95, 1e-4, `${id} peak`);
  }
  assert.equal(factoryFrames('nope'), null);
});

test('spectra: additive frames round-trip through harmonicsOf; bandlimit removes everything above the limit', () => {
  const amps = new Float32Array(20), ph = new Float32Array(20);
  amps[1] = 1; amps[3] = 0.5; amps[7] = 0.25; ph[3] = 0.7; ph[7] = -1.1;
  const f = frameFromHarmonics(amps, ph);
  const h = harmonicsOf(f);
  for (const k of [1, 3, 7]) close(h.amps[k], amps[k], 1e-4, `amp ${k}`);
  close(Math.cos(h.phases[3]), Math.cos(0.7), 1e-3, 'phase 3');
  close(h.amps[2], 0, 1e-5);
  const sq = bandlimit((x) => (x < 0.5 ? 1 : -1), { maxHarmonic: 40 });
  assert.ok(energyAbove(sq, 40) < 1e-12);
  close(harmonicsOf(sq).amps[1], 4 / Math.PI, 0.01, 'square fundamental');
  const r = resampleCycle(Float32Array.from({ length: 600 }, (_, i) => Math.sin((2 * Math.PI * i) / 600)));
  assert.equal(r.length, FRAME_SIZE);
  close(r[512], 1, 0.01, 'resampled sine quarter');
});

test('mipmaps: each level is band-limited to its harmonic count; level choice never exceeds Nyquist', () => {
  const saw = frameFromHarmonics(Float32Array.from({ length: 1024 }, (_, k) => (k ? 1 / k : 0)));
  const mips = buildMipmaps([saw, removeDC(saw)]);
  assert.equal(mips.frames, 2);
  assert.equal(mips.levels.length, MIP_HARMONICS.length);
  mips.levels.forEach((lv, i) => {
    assert.equal(lv.size, mipSize(lv.harmonics));
    assert.equal(lv.data.length, 2 * lv.size);
    const cyc = lv.data.subarray(0, lv.size);
    if (lv.harmonics < lv.size / 2 - 1) assert.ok(energyAbove(cyc, lv.harmonics) < 1e-9, `level ${i}`);
    close(harmonicsOf(cyc).amps[1], 1, 0.01, `level ${i} fundamental`);
  });
  for (const sr of [44100, 48000, 96000]) {
    for (const f of [20, 55, 110, 261.6, 1000, 4186, 12000]) {
      const k = mipLevel(f, sr);
      assert.ok(MIP_HARMONICS[k] * f <= sr / 2 + 1e-6 || k === MIP_HARMONICS.length - 1, `${f} Hz @ ${sr}`);
      if (k > 0) assert.ok(MIP_HARMONICS[k - 1] * f > sr / 2, `${f} Hz @ ${sr} is the richest safe level`);
    }
  }
  assert.ok(mipLevel(1000, 48000, 4) > mipLevel(1000, 48000, 1), 'warp bandwidth picks a narrower level');
});

test('morph: position interpolates neighbouring frames, phase interpolates samples', () => {
  const a = new Float32Array(FRAME_SIZE).fill(0), b = new Float32Array(FRAME_SIZE).fill(0);
  a[0] = 1; b[0] = -1; // read the raw (unfiltered) level-free data through a fake single level
  const mips = { frames: 2, levels: [{ harmonics: 1024, size: FRAME_SIZE, data: new Float32Array([...a, ...b]) }] };
  close(readMorph(mips, 0, 0, 0), 1, 1e-9);
  close(readMorph(mips, 0, 1, 0), -1, 1e-9);
  close(readMorph(mips, 0, 0.5, 0), 0, 1e-9);
  close(readMorph(mips, 0, 0.25, 0), 0.5, 1e-9);
  close(readLevel(mips.levels[0], 0, 0.5 / FRAME_SIZE), 0.5, 1e-9, 'half-sample phase');
  close(readLevel(mips.levels[0], 0, 1 - 0.5 / FRAME_SIZE), 0.5, 1e-9, 'wraps to the start');
  const keys = morphKeys([a, b], 5);
  assert.equal(keys.length, 5);
  close(keys[2][0], 0, 1e-9);
});

test('warps: identity at amount 0, continuous ends, documented shapes', () => {
  for (const m of WARP_MODES) {
    for (const x of [0, 0.1, 0.37, 0.5, 0.9]) close(warpPhase(m, x, 0), x, 1e-12, `${m} identity`);
    assert.ok(warpBandwidth(m, 0.7) >= 1, `${m} bandwidth`);
  }
  // sync: (1 + 7a) restarts per cycle
  close(warpPhase('sync', 0.25, 1 / 7), 0.5, 1e-12);
  close(warpPhase('sync', 0.75, 1 / 7), 0.5, 1e-12);
  // bends keep 0, ½ and 1 and stay monotonic
  for (const m of ['bendp', 'bendm']) {
    close(warpPhase(m, 0, 0.8), 0, 1e-12); close(warpPhase(m, 0.5, 0.8), 0.5, 1e-12); close(warpPhase(m, 1, 0.8), 1, 1e-12);
    let prev = -1;
    for (let i = 0; i <= 100; i++) { const v = warpPhase(m, i / 100, 0.8); assert.ok(v >= prev - 1e-12, `${m} monotonic`); prev = v; }
  }
  assert.ok(warpPhase('bendp', 0.4, 0.8) < 0.4, 'bend + pushes the read phase towards the edges');
  assert.ok(warpPhase('bendm', 0.4, 0.8) > 0.4, 'bend − pulls towards the centre');
  // pwm: compressed cycle then hold
  close(warpPhase('pwm', 0.25, 0.5), 0.25 / 0.51, 1e-12);
  assert.equal(warpPhase('pwm', 0.8, 0.5), 0);
  // mirror: forward to the split, then back
  close(warpPhase('mirror', 0.25, 1), 0.5, 1e-12);
  close(warpPhase('mirror', 0.75, 1), 0.5, 1e-12);
  // quantize: few steps at full amount
  const q = new Set(Array.from({ length: 200 }, (_, i) => warpPhase('quantize', i / 200, 1)));
  assert.equal(q.size, 4);
  // fm: offset by the other oscillator
  close(warpPhase('fm', 0.2, 0.5, 0.4), 0.2 + 0.3, 1e-12);
  // formant: windowed (silent at the cycle edges once a ≥ ¼)
  close(warpGain('formant', 0, 0.5), 0, 1e-12);
  close(warpGain('formant', 0.5, 0.5), 1, 1e-12);
  close(warpGain('sync', 0, 0.5), 1, 1e-12);
});

// ---- WAV fixtures
function wav(channels, { sampleRate = 44100, bits = 16, float = false, clm = null } = {}) {
  const n = channels[0].length, nc = channels.length, bps = bits / 8;
  const chunks = [];
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, float ? 3 : 1, true); fmt.setUint16(2, nc, true); fmt.setUint32(4, sampleRate, true);
  fmt.setUint32(8, sampleRate * nc * bps, true); fmt.setUint16(12, nc * bps, true); fmt.setUint16(14, bits, true);
  chunks.push(['fmt ', new Uint8Array(fmt.buffer)]);
  if (clm) chunks.push(['clm ', new TextEncoder().encode(clm)]);
  const data = new DataView(new ArrayBuffer(n * nc * bps));
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const v = channels[c][i], p = (i * nc + c) * bps;
    if (float) data.setFloat32(p, v, true);
    else if (bits === 16) data.setInt16(p, Math.round(v * 32767), true);
    else if (bits === 24) { const x = Math.round(v * 8388607); data.setUint8(p, x & 255); data.setUint8(p + 1, (x >> 8) & 255); data.setUint8(p + 2, (x >> 16) & 255); }
  }
  chunks.push(['data', new Uint8Array(data.buffer)]);
  const len = 12 + chunks.reduce((s, [, b]) => s + 8 + b.length + (b.length & 1), 0);
  const out = new Uint8Array(len), dv = new DataView(out.buffer);
  const put = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, len - 8, true); put(8, 'WAVE');
  let o = 12;
  for (const [id, b] of chunks) { put(o, id); dv.setUint32(o + 4, b.length, true); out.set(b, o + 8); o += 8 + b.length + (b.length & 1); }
  return out.buffer;
}
const sineCycle = (n, k = 1) => Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin((2 * Math.PI * k * i) / n));

test('WAV import: PCM 16/24, float, stereo, Serum clm frame size, single cycles, multi-frame tables', () => {
  const frames3 = new Float32Array(3 * 2048);
  for (let f = 0; f < 3; f++) frames3.set(sineCycle(2048, f + 1), f * 2048);
  for (const opts of [{ bits: 16 }, { bits: 24 }, { float: true, bits: 32 }]) {
    const w = parseWav(wav([frames3], opts));
    assert.equal(w.channels, 1);
    close(w.data[0][512], 0.8, 1e-3, `${JSON.stringify(opts)} sample`);
    assert.deepEqual(classifyWav(w), { kind: 'multi', frameSize: 2048 });
    const res = importWavetable(wav([frames3], opts));
    assert.equal(res.frames.length, 3);
    close(harmonicsOf(res.frames[2]).amps[3], 0.8, 0.01, 'third frame = 3rd harmonic');
  }
  // Serum: clm chunk with a 1024-sample frame size
  const s1024 = new Float32Array(4 * 1024);
  for (let f = 0; f < 4; f++) s1024.set(sineCycle(1024, 1), f * 1024);
  const clmBuf = wav([s1024], { float: true, bits: 32, clm: '<!>1024 10000000 wavetable (www.xferrecords.com)' });
  const w = parseWav(clmBuf);
  assert.equal(w.clm.frameSize, 1024);
  assert.ok(w.chunks.includes('clm '));
  const res = importWavetable(clmBuf);
  assert.equal(res.kind, 'clm');
  assert.equal(res.frames.length, 4);
  assert.equal(res.frames[0].length, FRAME_SIZE);
  close(harmonicsOf(res.frames[0]).amps[1], 0.8, 0.01);
  // single cycle, stereo
  const single = importWavetable(wav([sineCycle(600), sineCycle(600)], { bits: 16 }));
  assert.equal(single.kind, 'single');
  assert.equal(single.frames.length, 1);
  // splitting
  assert.equal(splitFrames(new Float32Array(2048 * 5)).length, 5);
  assert.throws(() => parseWav(new TextEncoder().encode('not a wav at all').buffer), /Not a WAV/);
});

test('resynthesis: pitch detection and phase-aligned frames from audio', () => {
  const sr = 44100, f0 = 220, n = sr;
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, bright = i / n; // gets brighter over time
    for (let k = 1; k <= 12; k++) audio[i] += (k === 1 ? 0.5 : bright * 0.5) / k * Math.sin(2 * Math.PI * f0 * k * t);
  }
  const p = detectPitch(audio, sr);
  close(p, f0, 1.5, 'pitch');
  const frames = resynthesize(audio, sr, { frames: 8 });
  assert.equal(frames.length, 8);
  const h0 = harmonicsOf(frames[0]).amps, h7 = harmonicsOf(frames[7]).amps;
  assert.ok(h7[3] / h7[1] > h0[3] / h0[1] * 3, 'later frames carry more upper harmonics');
  close(h7[2] / h7[1], 0.5, 0.08, 'harmonic ratio ~ 1/k');
  assert.equal(detectPitch(new Float32Array(4096), sr), null);
  const noise = Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1);
  assert.equal(resynthesize(noise, sr, { frames: 4 }).length, 4, 'unpitched audio still gives frames');
});

test('storage: compact int16 tables, content-hash ids dedupe, round trip, pruning on load', () => {
  const fr = [sineCycle(2048, 1), sineCycle(2048, 2)];
  const e = encodeTable('Test', fr);
  assert.match(e.id, /^u_[0-9a-f]+$/);
  assert.equal(e.frames, 2);
  assert.ok(e.data.length < 2 * 2048 * 2 * 1.4, 'base64 of int16');
  const back = decodeTable(e);
  assert.equal(back.length, 2);
  const norm = normalizeFrames(fr.map(removeDC));
  for (let i = 0; i < 2048; i += 97) close(back[1][i], norm[1][i], 1 / 16000);
  const p = createProject();
  const t = createTrack({ type: 'instrument', name: 'WT' });
  t.instrument = { type: 'wavetable', preset: null, params: {} };
  p.tracks.push(t);
  const id1 = addProjectTable(p, 'A', fr), id2 = addProjectTable(p, 'Copy', fr);
  assert.equal(id1, id2);
  assert.equal(Object.keys(p.wavetables).length, 1);
  addProjectTable(p, 'Other', [sineCycle(2048, 3)]);
  t.instrument.params.osc2Table = id1;
  assert.deepEqual([...referencedTables(p)], [id1]);
  const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(Object.keys(loaded.wavetables), [id1], 'unused tables are pruned on load');
  assert.equal(decodeTable(loaded.wavetables[id1]).length, 2);
  assert.deepEqual(sanitizeWavetables({ bad: { data: 'x' }, u_1: { data: 5 } }), {});
  // the mipmap cache resolves project tables through the getter
  const mips = tableMips(id1, (id) => loaded.wavetables[id]);
  assert.equal(mips.frames, 2);
  assert.equal(tableMips('u_missing', () => null).frames, factoryFrames('basic').length, 'missing table plays Basic Shapes');
});

test('defs / presets: wavetable instrument params, 60+ presets with metadata, sanitize keeps table ids', () => {
  const def = INSTRUMENT_DEFS.wavetable;
  assert.ok(def && def.params.length > 80);
  const d = getParamDefaults('wavetable');
  assert.equal(d.osc1Table, 'basic');
  const s = sanitizeParams('wavetable', { osc1Table: 'u_abc', osc2Table: 7, osc1Unison: 99 });
  assert.equal(s.osc1Table, 'u_abc');
  assert.equal(s.osc2Table, 'pwm');
  assert.equal(s.osc1Unison, 16);
  const wt = Object.entries(PRESETS).filter(([, p]) => p.instrument.type === 'wavetable');
  assert.ok(wt.length >= 60, `${wt.length} presets`);
  for (const cat of ['Bass', 'Lead', 'Pad', 'Pluck', 'Keys', 'FX']) assert.ok(wt.some(([, p]) => p.category === cat), cat);
  for (const [id] of wt) {
    const r = resolveInstrumentDef({ preset: id });
    assert.equal(r.type, 'wavetable');
    for (const k of ['osc1Table', 'osc2Table']) assert.ok(FACTORY_TABLES[r.params[k]], `${id}.${k}`);
  }
  const fb = fallbackSynthParams(resolveInstrumentDef({ preset: 'wt-reese' }).params);
  assert.equal(fb.osc1Wave, 'saw');
  assert.ok(fb.osc2Level > 0 && fb.mono);
});

test('voice DSP: envelope stages, SVF low-pass response, unison layout', () => {
  const sr = 48000;
  const e = new Env();
  e.set(0.01, 0.2, 0.5, 0.1, sr);
  e.gate(true);
  let n = 0;
  while (e.stage === 1 && n < sr) { e.tick(); n++; }
  close(n / sr, 0.01, 0.0015, 'attack time');
  e.run(sr);
  close(e.level, 0.5, 1e-3, 'sustain');
  e.gate(false);
  e.run(Math.round(0.1 * sr));
  assert.ok(e.level < 0.5 * 0.01, 'released within r');
  const f = new Svf();
  f.setup(1000, 1.4142, sr);
  const gainAt = (hz) => { f.reset(); let pk = 0; for (let i = 0; i < sr / 4; i++) { const y = f.process(Math.sin((2 * Math.PI * hz * i) / sr), 0); if (i > sr / 8) pk = Math.max(pk, Math.abs(y)); } return pk; };
  close(gainAt(100), 1, 0.02, 'pass band');
  close(gainAt(1000), Math.SQRT1_2, 0.03, '-3 dB at cutoff');
  assert.ok(gainAt(8000) < 0.02, 'stop band −12 dB/oct');
  const lay = unisonLayout(7, 0.5, 1);
  assert.equal(lay.length, 7);
  close(lay.reduce((s, u) => s + u.gain * u.gain, 0), 1, 1e-9, 'power-normalized');
  close(lay.reduce((s, u) => s + u.k, 0), 0, 1e-9, 'symmetric detune');
  assert.ok(lay.some((u) => u.pan < 0) && lay.some((u) => u.pan > 0));
  const [l, r] = panGains(0);
  close(l, r, 1e-12);
});

// ---- processor
async function proc(params = {}, tables = ['basic', 'pwm'], sampleRate = 48000) {
  const h = await loadProcessor(PROC, 'daw3-wavetable', { sampleRate });
  h.send({ type: 'params', p: { ...getParamDefaults('wavetable'), ...params } });
  tables.forEach((id, osc) => h.send({ type: 'table', osc, mips: tableMips(id) }));
  return h;
}
function aliasDb(sig, sr, f0) {
  const N = 8192, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const w = (2 * Math.PI * i) / N; re[i] = sig[i] * (0.35875 - 0.48829 * Math.cos(w) + 0.14128 * Math.cos(2 * w) - 0.01168 * Math.cos(3 * w)); }
  fft(re, im);
  let harm = 0, alias = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N, e = re[k] ** 2 + im[k] ** 2;
    if (Math.abs(f - Math.round(f / f0) * f0) < (5 * sr) / N) harm += e; else alias += e;
  }
  return 10 * Math.log10(alias / harm);
}

test('processor: renders notes band-limited, releases, reports state, answers pings', async () => {
  const h = await proc({ filterType: 'off', osc1Rand: 0, env1Attack: 0.001, env1Sustain: 1, env1Release: 0.05 });
  h.send({ type: 'events', list: [{ t: 0, type: 'on', id: 1, pitch: 96, vel: 1 }, { t: 0.4, type: 'off', id: 1 }] });
  const [L, R] = h.render(48000);
  assert.ok(peak(L.subarray(0, 19000)) > 0.05, 'sounds');
  assert.equal(peak(L.subarray(30000)), 0, 'silent after the release');
  assert.ok(aliasDb(L.subarray(2000), 48000, 440 * 2 ** (27 / 12)) < -60, 'C7 saw stays alias-free');
  close(peak(L), peak(R), 1e-6, 'centred');
  assert.ok(h.outbox.some((m) => m.type === 'state' && m.voices === 1));
  h.send({ type: 'ping', id: 42 });
  assert.deepEqual(h.outbox.at(-1), { type: 'pong', id: 42 });
});

test('processor: deterministic, sample-accurate note starts, polyphony limit, morph + warp change the sound', async () => {
  const run = async (p) => {
    const h = await proc({ filterType: 'off', ...p });
    h.send({ type: 'events', list: [{ t: 0.01, type: 'on', id: 1, pitch: 60, vel: 0.8 }, { t: 0.2, type: 'off', id: 1 }] });
    return h.render(16384)[0];
  };
  const a = await run({}), b = await run({});
  assert.deepEqual(a, b, 'same params -> same render');
  const first = a.findIndex((x) => x !== 0);
  assert.equal(first, 480, 'note starts on its frame (0.01 s @ 48 kHz)');
  const pos = await run({ osc1Pos: 0 });
  const warp = await run({ osc1Warp: 'sync', osc1WarpAmt: 0.6 });
  const diff = (x, y) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0);
  assert.ok(diff(a, pos) > 10 && diff(a, warp) > 10);
  // polyphony 2: a third note steals the oldest
  const h = await proc({ polyphony: 2, env1Sustain: 1 });
  h.send({ type: 'events', list: [60, 64, 67].map((p, i) => ({ t: i * 0.01, type: 'on', id: i + 1, pitch: p, vel: 0.8 })) });
  h.render(4096 * 2);
  const st = h.outbox.filter((m) => m.type === 'state').at(-1);
  assert.equal(st.voices, 2);
});

test('processor: legato glide and mono retrigger', async () => {
  const h = await proc({ voiceMode: 'legato', glide: 0.2, filterType: 'off', osc1Pos: 0, env1Sustain: 1 }); // sine
  h.send({ type: 'events', list: [{ t: 0, type: 'on', id: 1, pitch: 48, vel: 0.8 }, { t: 0.3, type: 'on', id: 2, pitch: 60, vel: 0.8 }] });
  const [L] = h.render(48000);
  const zc = (from, to) => { let n = 0; for (let i = from + 1; i < to; i++) if (L[i - 1] <= 0 && L[i] > 0) n++; return n / ((to - from) / 48000); };
  close(zc(4800, 14400), 130.8, 3, 'C3');
  const mid = zc(14600, 17000);
  assert.ok(mid > 135 && mid < 255, `gliding (${mid.toFixed(1)} Hz)`);
  close(zc(38000, 48000), 261.6, 4, 'C4 after the glide');
  const voices = h.outbox.filter((m) => m.type === 'state').map((m) => m.voices);
  assert.ok(voices.every((v) => v <= 1), 'one voice in legato mode');
});

test('processor: mod matrix (LFO -> position) and filter env reach sounding voices', async () => {
  const still = await proc({ filterType: 'lp', cutoff: 400, fEnvAmount: 0, env1Sustain: 1 });
  const env = await proc({ filterType: 'lp', cutoff: 400, fEnvAmount: 5, env2Attack: 0.001, env2Decay: 0.3, env2Sustain: 0, env1Sustain: 1 });
  const moving = await proc({ env1Sustain: 1, mod1Src: 'lfo1', mod1Dst: 'pos1', mod1Amt: 0.6, lfo1Rate: 3 });
  for (const h of [still, env, moving]) h.send({ type: 'events', list: [{ t: 0, type: 'on', id: 1, pitch: 48, vel: 0.8 }] });
  const a = still.render(24000)[0], b = env.render(24000)[0];
  moving.render(24000);
  // brightness: level of the first difference (weights the upper harmonics)
  const bright = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += (x[i] - x[i - 1]) ** 2; return Math.sqrt(s / (i1 - i0)); };
  assert.ok(bright(b, 500, 3000) > bright(a, 500, 3000) * 2, 'env 2 opens the filter at the attack');
  close(bright(b, 16000, 24000), bright(a, 16000, 24000), bright(a, 16000, 24000) * 0.1, 'and closes it again');
  const pos = moving.outbox.filter((m) => m.type === 'state' && m.pos).map((m) => m.pos[0]);
  assert.ok(Math.max(...pos) - Math.min(...pos) > 0.2, 'the LFO moves the position');
});
