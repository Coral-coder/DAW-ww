// Live tempo edits on playing warped clips (WarpRenderer.setCurve, markers.spliceCurve, WarpPlayer.retime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap } from '../src/time/tempo-map.js';
import { clipCurve, curveAt, spliceCurve, normalizeMarkers } from '../src/audio/warp/markers.js';
import { WarpRenderer } from '../src/audio/warp/core.js';
import { WarpPlayer } from '../src/audio/warp/player.js';

const SR = 44100;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

function drumLoop(bpm, beats = 8, sr = SR) {
  const spb = 60 / bpm, len = Math.round(beats * spb * sr);
  const x = new Float32Array(len);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let k = 0; k < beats * 2; k++) {
    const i0 = Math.round(k * spb / 2 * sr), acc = k % 2 ? 0.45 : 1;
    for (let j = 0; j < 0.08 * sr && i0 + j < len; j++) x[i0 + j] += acc * Math.exp(-j / (0.012 * sr)) * (0.6 * Math.sin(2 * Math.PI * (k % 4 ? 900 : 70) * j / sr) + 0.4 * rnd());
  }
  return x;
}
function onsets(x, sr = SR) {
  const hop = 64, out = [], env = [];
  let prev = 0, max = 0, last = -1;
  for (let i = 0; i + hop <= x.length; i += hop) { let s = 0; for (let j = 0; j < hop; j++) s += x[i + j] ** 2; env.push(Math.sqrt(s / hop)); max = Math.max(max, env[env.length - 1]); }
  env.forEach((e, k) => { const t = k * hop / sr; if (e > max * 0.12 && prev <= max * 0.12 && t - last > 0.05) { out.push(t); last = t; } prev = e; });
  return out;
}
/** Render the rest of a (possibly part-played) renderer. */
function drain(r) {
  const out = new Float32Array(Math.max(0, r.total - r.n)), o2 = new Float32Array(out.length);
  for (let off = 0; off < out.length;) { const n = Math.min(4096, out.length - off); r.process([out.subarray(off, off + n), o2.subarray(off, off + n)], n); off += n; }
  return [out];
}
const loopClip = (beats = 16) => ({ type: 'audio', start: 0, length: beats, offset: 0, sampleId: 's', warp: { mode: 'beats', markers: normalizeMarkers([{ beat: 0, sec: 0 }, { beat: 8, sec: 4 }]), bpm: 120 } });

test('spliceCurve keeps the played part and continues with the new tail from tc', () => {
  const old = [{ t: 0, s: 0 }, { t: 1, s: 1 }, { t: 2, s: 2 }, { t: 3, s: 3 }];
  const tail = [{ t: 0, s: 1.5 }, { t: 3, s: 3 }];
  const c = spliceCurve(old, 1.5, tail);
  assert.deepEqual(c, [{ t: 0, s: 0 }, { t: 1, s: 1 }, { t: 1.5, s: 1.5 }, { t: 4.5, s: 3 }]);
  close(curveAt(c, 0.5), 0.5, 1e-12);
  close(curveAt(c, 3), 2.25, 1e-12);
});

test('WarpRenderer.setCurve mid-stream: output equals a render of the spliced curve, hits move to the new tempo', () => {
  const x = drumLoop(120, 8);
  const clip = loopClip(8);
  const slices = onsets(x);
  const m120 = new TempoMap({ bpm: 120 }), m90 = new TempoMap({ bpm: 90 });
  const c120 = clipCurve(clip, m120, 0, 8).points;
  const B = 3; // edit at beat 3 (1.5 s at 120)
  const tc = m120.span(0, B);
  const spliced = spliceCurve(c120, tc, clipCurve(clip, m90, B, 8).points);
  const live = new WarpRenderer({ channels: [x], srcRate: SR, outRate: SR, curve: c120, mode: 'beats', slices });
  const head = live.renderAll(Math.round(tc * SR));
  live.setCurve(spliced);
  const rest = drain(live);
  const out = new Float32Array(head[0].length + rest[0].length);
  out.set(head[0]); out.set(rest[0], head[0].length);
  const ref = new WarpRenderer({ channels: [x], srcRate: SR, outRate: SR, curve: spliced, mode: 'beats', slices }).renderAll()[0];
  assert.equal(out.length, ref.length);
  let err = 0; for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(out[i] - ref[i]));
  assert.ok(err < 1e-6, `max diff ${err}`);
  close(out.length / SR, tc + m90.span(B, 8), 1 / SR * 2, 'length follows the new tempo');
  // 8th-note hits: before the edit every 0.25 s, after it every 1/3 s
  const on = onsets(out);
  const expect = [];
  for (let k = 0; k < 16; k++) { const b = k / 2; expect.push(b < B ? m120.secAt(b) : tc + m90.span(B, b)); }
  assert.equal(on.length, 16);
  on.forEach((t, k) => close(t, expect[k], 0.004, `hit ${k}`));
});

test('WarpRenderer.setCurve (tones): carries on without restarting and ends at the new length', () => {
  const x = Float32Array.from({ length: 4 * SR }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 220 * i / SR));
  const clip = { ...loopClip(8), warp: { ...loopClip(8).warp, mode: 'tones' } };
  const m120 = new TempoMap({ bpm: 120 }), m150 = new TempoMap({ bpm: 150 });
  const c = clipCurve(clip, m120, 0, 8).points;
  const r = new WarpRenderer({ channels: [x], srcRate: SR, outRate: SR, curve: c, mode: 'tones' });
  r.renderAll(SR);
  r.setCurve(spliceCurve(c, 1, clipCurve(clip, m150, 2, 8).points));
  const rest = drain(r)[0];
  close(rest.length / SR, m150.span(2, 8), 2 / SR);
  // no dropout around the splice: RMS of the first 50 ms after it ≈ steady-state sine RMS
  let s = 0; for (let i = 0; i < 0.05 * SR; i++) s += rest[i] ** 2;
  close(Math.sqrt(s / (0.05 * SR)), 0.5 / Math.SQRT2, 0.05, 'rms after splice');
});

// ---- WarpPlayer.retime with a fake context
function fakeParam() {
  const ev = [];
  return { ev, value: 1, setValueAtTime(v, t) { ev.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { ev.push(['ramp', v, t]); }, cancelScheduledValues(t) { ev.push(['cancel', t]); }, cancelAndHoldAtTime(t) { ev.push(['hold', t]); } };
}
function fakeCtx() {
  const posted = [];
  const ctx = {
    sampleRate: SR, currentTime: 0, posted,
    createGain: () => ({ gain: fakeParam(), connect() {}, disconnect() {} }),
    createBufferSource: () => ({ playbackRate: fakeParam(), connect() {}, start(...a) { this.started = a; }, stop(t) { (this.stops ||= []).push(t); } }),
    createBuffer: (n, len, sr) => { const ch = Array.from({ length: n }, () => new Float32Array(len)); return { numberOfChannels: n, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c) => ch[c] }; },
  };
  return ctx;
}

test('WarpPlayer.retime: worklet voice gets the spliced curve, repitch re-schedules rates, envelope re-laid', () => {
  const ctx = fakeCtx();
  const x = drumLoop(120, 8);
  const buffer = { sampleRate: SR, numberOfChannels: 1, duration: x.length / SR, getChannelData: () => x };
  const graph = { ctx, sources: new Set(), _clipEnvelope() {} };
  const wp = new WarpPlayer(graph, { worklet: false, getSampleBuffer: () => buffer });
  const m120 = new TempoMap({ bpm: 120 }), m100 = new TempoMap({ bpm: 100 });
  const e = { strip: { input: {} } };
  // repitch (native) voice
  const clipR = { ...loopClip(8), warp: { ...loopClip(8).warp, mode: 'repitch' } };
  wp.play(e, { type: 'audio', beat: 0, clip: clipR, offset: 0, dur: 8 }, 1, 0.5, m120);
  // simulated worklet voice: same bookkeeping, node with a port
  const port = { msgs: [], postMessage(m) { this.msgs.push(m); } };
  const clipB = loopClip(8);
  const pts = clipCurve(clipB, m120, 0, 8).points;
  const wsrc = { node: { port }, stop() {} };
  wp.voices.add({ e, ev: { beat: 0, dur: 8 }, clip: clipB, time: 1, points: pts, mode: 'beats', kind: 'worklet', src: wsrc, g: ctx.createGain(), rec: { src: wsrc } });
  assert.equal(wp.voices.size, 2);
  const n = wp.retime(m100, 1 + m120.span(0, 4), 4);
  assert.equal(n, 2);
  const msg = port.msgs.find((m) => m.type === 'curve');
  assert.ok(msg, 'curve posted');
  const end = msg.curve[msg.curve.length - 1];
  close(end.t, 2 + m100.span(4, 8), 1e-9, 'new end');
  close(curveAt(msg.curve, 2), 2, 1e-9, 'source position continuous at the splice');
  const native = [...wp.voices].find((v) => v.kind === 'native');
  const rates = native.src.playbackRate.ev.filter((r) => r[0] === 'set' && r[2] >= 3 - 1e-9);
  close(rates[0][1], 100 / 120, 1e-9, 'rate after the edit');
  close(native.src.stops.at(-1), 1 + 2 + m100.span(4, 8) + 0.001, 1e-9, 'stop moved');
  const gev = native.g.gain.ev;
  assert.ok(gev.some((r) => r[0] === 'hold' && Math.abs(r[1] - 3) < 1e-9), 'envelope held at the splice');
  close(gev.at(-1)[2], 3 + m100.span(4, 8), 1e-9, 'envelope ends at the new end');
  // voices that do not span the edit beat are left alone
  assert.equal(wp.retime(m120, 1 + 10, 9), 0);
  wp.clear();
  assert.equal(wp.retime(m120, 3.5, 5), 0, 'cleared (stopped) voices are never retimed');
});
