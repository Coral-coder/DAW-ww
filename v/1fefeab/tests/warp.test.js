import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap } from '../src/time/tempo-map.js';
import { secAtBeat, beatAtSec, clipCurve, curveAt, curveRates, autoWarp, normalizeMarkers, moveMarker, setWarpBpm, isWarped } from '../src/audio/warp/markers.js';
import { WarpRenderer, renderWarp, lpc } from '../src/audio/warp/core.js';
import { analyzeChannels } from '../src/audio/warp/analyze.js';

const SR = 44100;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

/** Drum-ish loop: a decaying noise+tone hit on every 8th note at `bpm`, accented on beats. */
export function drumLoop(bpm, beats = 8, sr = SR) {
  const spb = 60 / bpm, len = Math.round(beats * spb * sr);
  const x = new Float32Array(len);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let k = 0; k < beats * 2; k++) {
    const i0 = Math.round(k * spb / 2 * sr), acc = k % 2 ? 0.45 : 1;
    for (let j = 0; j < 0.08 * sr && i0 + j < len; j++) x[i0 + j] += acc * Math.exp(-j / (0.012 * sr)) * (0.6 * Math.sin(2 * Math.PI * (k % 4 ? 900 : 70) * j / sr) + 0.4 * rnd());
  }
  return x;
}
const sine = (f, sec, sr = SR) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * f * i / sr));
/** Fundamental (Hz) by autocorrelation peak in [60, 2000] Hz over the middle of x. */
function pitchOf(x, sr = SR) {
  const a = Math.floor(x.length / 3), n = 4096;
  const ac = [];
  let max = 0;
  for (let lag = 0; lag < sr / 60; lag++) {
    let s = 0; for (let i = 0; i < n; i++) s += x[a + i] * x[a + i + lag];
    ac.push(s); if (lag > sr / 2000) max = Math.max(max, s);
  }
  // first local maximum above 85 % of the strongest (avoids sub-harmonics)
  let bl = 0;
  for (let lag = Math.ceil(sr / 2000); lag < ac.length - 1; lag++) if (ac[lag] >= max * 0.85 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { bl = lag; break; }
  // parabolic refinement
  const r = (l) => { let s = 0; for (let i = 0; i < n; i++) s += x[a + i] * x[a + i + l]; return s; };
  const y0 = r(bl - 1), y1 = r(bl), y2 = r(bl + 1);
  return sr / (bl + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2));
}
/** Onset times (s): rising threshold crossings of a short energy envelope. */
function onsets(x, sr = SR) {
  const hop = 64, out = [];
  let prev = 0, max = 0;
  const env = [];
  for (let i = 0; i + hop <= x.length; i += hop) { let s = 0; for (let j = 0; j < hop; j++) s += x[i + j] ** 2; env.push(Math.sqrt(s / hop)); max = Math.max(max, env[env.length - 1]); }
  let last = -1;
  env.forEach((e, k) => { const t = k * hop / sr; if (e > max * 0.12 && prev <= max * 0.12 && t - last > 0.05) { out.push(t); last = t; } prev = e; });
  return out;
}

test('warp markers: piecewise-linear mapping, inverse, extrapolation', () => {
  const w = { mode: 'tones', markers: normalizeMarkers([{ beat: 0, sec: 0 }, { beat: 4, sec: 2 }, { beat: 8, sec: 5 }]), bpm: 120 };
  close(secAtBeat(w, 2), 1, 1e-12);
  close(secAtBeat(w, 6), 3.5, 1e-12);
  close(secAtBeat(w, 10), 6.5, 1e-12, 'extrapolates the last segment');
  close(secAtBeat(w, -2), -1, 1e-12);
  for (let c = -2; c < 12; c += 0.37) close(beatAtSec(w, secAtBeat(w, c)), c, 1e-9);
  moveMarker(w, 1, 5);
  close(secAtBeat(w, 5), 2, 1e-12, 'dragged marker keeps its sample time');
  moveMarker(w, 1, 100);
  assert.ok(w.markers[1].beat < 8, 'clamped between neighbours');
  const one = { markers: [{ beat: 0, sec: 0.5 }], bpm: 100 };
  close(secAtBeat(one, 10), 6.5, 1e-12);
  setWarpBpm(one, 50);
  close(secAtBeat(one, 5), 6.5, 1e-12, 'setWarpBpm');
});

test('clip curve follows the tempo map (ramp) and the markers; rates reproduce it', () => {
  const map = new TempoMap({ bpm: 120, points: [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 8, bpm: 160 }] });
  const clip = { start: 0, length: 16, offset: 0, warp: { mode: 'beats', markers: [{ beat: 0, sec: 0 }, { beat: 16, sec: 8 }], bpm: 120 } };
  assert.ok(isWarped(clip));
  const { points, duration } = clipCurve(clip, map, 2, 14);
  close(duration, map.secAt(14) - map.secAt(2), 1e-12);
  for (const b of [2, 3, 5.5, 8, 11, 14]) close(curveAt(points, map.secAt(b) - map.secAt(2)), b * 0.5, 2e-6, `beat ${b}`);
  const rates = curveRates(points);
  let s = points[0].s;
  rates.forEach((r, i) => { const t1 = i + 1 < rates.length ? rates[i + 1].t : duration; s += r.rate * (t1 - r.t); });
  close(s, 7, 1e-9, 'integrated rates hit the end exactly');
  // unwarped: plays at its own speed from clip.offset seconds
  const off = clipCurve({ start: 4, length: 8, offset: 2 }, map, 6, 10);
  close(off.points[0].s, 2 * map.spbAt(4) + map.span(4, 6), 1e-12);
  close(off.points[1].s - off.points[0].s, off.duration, 1e-12);
});

function warpLoopTo(x, srcBpm, dstBpm, mode, beats = 8, extra = {}) {
  const map = new TempoMap({ bpm: dstBpm });
  const clip = { start: 0, length: beats, offset: 0, warp: { mode, markers: [{ beat: 0, sec: 0 }, { beat: beats, sec: beats * 60 / srcBpm }], bpm: srcBpm, ...extra } };
  const { points } = clipCurve(clip, map, 0, beats);
  const slices = onsets(x);
  return renderWarp({ channels: [x], srcRate: SR, outRate: SR, curve: points, mode, slices, ...extra });
}

test('beats mode: drum loop at three tempi stays on the grid (onset alignment)', () => {
  const x = drumLoop(120);
  for (const bpm of [96, 120, 150]) {
    const y = warpLoopTo(x, 120, bpm, 'beats')[0];
    close(y.length, Math.round(8 * 60 / bpm * SR), 1, 'length');
    const on = onsets(y);
    assert.equal(on.length, 16, `${bpm}: 16 hits, got ${on.length}`);
    on.forEach((t, k) => close(t, k * 30 / bpm, 0.004, `${bpm} BPM hit ${k}`));
  }
});

test('tones (WSOLA) stretch: exact output length, pitch preserved; transpose ±semitones (+ formants)', () => {
  const x = sine(440, 2);
  const map = new TempoMap({ bpm: 80 });
  const clip = { start: 0, length: 4, offset: 0, warp: { mode: 'tones', markers: [{ beat: 0, sec: 0 }, { beat: 4, sec: 2 }], bpm: 120 } };
  const { points, duration } = clipCurve(clip, map, 0, 4);
  close(duration, 3, 1e-12);
  for (const mode of ['tones', 'complex']) {
    const y = renderWarp({ channels: [x], srcRate: SR, outRate: SR, curve: points, mode })[0];
    assert.equal(y.length, 3 * SR, mode);
    close(pitchOf(y), 440, 2, `${mode} pitch`);
    // no level collapse / blow-up in the middle
    let e = 0; for (let i = SR; i < 2 * SR; i++) e += y[i] * y[i];
    close(Math.sqrt(e / SR), 0.5 / Math.SQRT2, 0.06, `${mode} rms`);
  }
  const up = renderWarp({ channels: [x], srcRate: SR, outRate: SR, curve: points, mode: 'tones', transpose: 7 })[0];
  close(pitchOf(up), 440 * 2 ** (7 / 12), 4, '+7 st');
  const down = renderWarp({ channels: [x], srcRate: SR, outRate: SR, curve: points, mode: 'tones', transpose: -12, formants: true })[0];
  close(pitchOf(down), 220, 2, '-12 st with formants');
  // repitch: speed & pitch follow the tempo (2 s at 120 -> 3 s at 80 = 2/3 pitch)
  const rp = renderWarp({ channels: [x], srcRate: SR, outRate: SR, curve: points, mode: 'repitch' })[0];
  close(pitchOf(rp), 440 * 80 / 120, 2, 'repitch');
});

test('streaming == offline: block-wise processing gives the same samples', () => {
  const x = drumLoop(120, 4);
  const curve = [{ t: 0, s: 0 }, { t: 2.5, s: 2 }];
  const a = renderWarp({ channels: [x, x], srcRate: SR, outRate: SR, curve, mode: 'tones' });
  const r = new WarpRenderer({ channels: [x, x], srcRate: SR, outRate: SR, curve, mode: 'tones' });
  const out = [new Float32Array(a[0].length), new Float32Array(a[0].length)];
  for (let off = 0; !r.done; off += 128) r.process(out.map((o) => o.subarray(off, off + 128)), 128);
  let d = 0; for (let i = 0; i < out[0].length; i++) d = Math.max(d, Math.abs(out[0][i] - a[0][i]));
  assert.ok(d < 1e-6, `max diff ${d}`);
});

test('LPC of a resonant AR(2) process recovers its coefficients', () => {
  const n = 4096, x = new Float32Array(n);
  let s = 1; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let i = 2; i < n; i++) x[i] = 1.6 * x[i - 1] - 0.8 * x[i - 2] + rnd();
  const a = lpc(x, 2);
  close(a[1], -1.6, 0.05); close(a[2], 0.8, 0.05);
});

test('analysis + auto-warp: detects the loop tempo and puts bar markers on its downbeats', () => {
  const bpm = 124, x = drumLoop(bpm, 16);
  const an = analyzeChannels([x], SR);
  close(an.bpm, bpm, 1, 'bpm');
  assert.ok(an.transients.length >= 28, `transients ${an.transients.length}`);
  const w = autoWarp(an, x.length / SR);
  assert.equal(w.mode, 'beats');
  assert.ok(w.markers.length >= 4);
  for (const m of w.markers.slice(0, 4)) close(m.sec, m.beat * 60 / bpm, 0.012, `marker ${m.beat}`);
});

test('AudioWorklet processor (stubbed scope): streams the warp in 128-frame blocks, starts on time, ends', async () => {
  let Proc = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); } }; } };
  globalThis.registerProcessor = (name, cls) => { if (name === 'daw3-warp') Proc = cls; };
  globalThis.sampleRate = SR;
  globalThis.currentTime = 0;
  await import(`../src/audio/warp/worklet.js?t=${Date.now()}`);
  assert.ok(Proc, 'registered');
  const x = drumLoop(120, 4);
  const when = 0.01;
  const p = new Proc({ processorOptions: { sampleId: 's1', when, mode: 'beats', curve: [{ t: 0, s: 0 }, { t: 2.5, s: 2 }], slices: onsets(x), transpose: 0 } });
  p.port.onmessage({ data: { type: 'sample', id: 's1', sr: SR, channels: [x] } });
  const out = new Float32Array(Math.round(3 * SR));
  let alive = true, f = 0;
  while (alive && f < out.length) {
    globalThis.currentTime = f / SR;
    const blk = [new Float32Array(128), new Float32Array(128)];
    alive = p.process([], [blk]);
    out.set(blk[0].subarray(0, Math.min(128, out.length - f)), f);
    f += 128;
  }
  assert.equal(alive, false, 'ended');
  assert.ok(p.port.posted.some((m) => m.type === 'ended'));
  const on = onsets(out);
  assert.equal(on.length, 8);
  on.forEach((t, k) => close(t, when + k * 0.3125, 0.004, `hit ${k}`));
  delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor; delete globalThis.sampleRate; delete globalThis.currentTime;
});

test('unwarped clip under a tempo map: seconds view matches the source curve', async () => {
  const { unwarpedInSeconds } = await import('../src/audio/warp/player.js');
  const map = new TempoMap({ bpm: 100, points: [{ beat: 0, bpm: 100, curve: 'linear' }, { beat: 16, bpm: 160 }] });
  const clip = { start: 4, length: 8, offset: 1, fadeIn: 1, sampleId: 's' };
  const ev = { type: 'audio', beat: 6, clip, offset: 2, dur: 6 };
  const s = unwarpedInSeconds(ev, map);
  const { points, duration } = clipCurve(clip, map, 6, 12);
  close((s.clip.offset + s.offset), points[0].s, 1e-12, 'start offset (s)');
  close(s.dur, duration, 1e-12, 'duration (s)');
  close(s.clip.fadeIn, map.span(4, 5), 1e-12);
});
