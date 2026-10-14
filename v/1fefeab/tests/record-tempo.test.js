// Recording under a tempo / meter map: audio takes, MIDI notes, count-in, comp flatten (src/record/* + src/time/tempo-map.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap, songTempoMap } from '../src/time/tempo-map.js';
import { beatAtTime, timeAtBeat, songBeat, beatOfFrame, frameOfBeat, planAudioTakes, countInPlan, recordPlan } from '../src/record/timing.js';
import { computePasses, compClips, srcSecAt, createTake } from '../src/record/takes.js';
import { mixClipsToPcm, envelopePoints } from '../src/record/clips.js';
import { MidiPassRecorder, buildMidiTakes, CaptureBuffer } from '../src/record/midi.js';
import { Scheduler } from '../src/audio/scheduler.js';
import { createProject } from '../src/core/model.js';

const SR = 48000;
const RAMP = [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 140, curve: 'jump' }];
const rampMap = () => new TempoMap({ bpm: 120, points: RAMP });
const MS = 0.001;

// analytic 120 -> 140 over 16 beats: k = 1.25 bpm / beat, beat(s) = 120·(e^{k s/60} − 1)/k
const K = 20 / 16;
const beatAtSecExact = (s) => (120 * Math.expm1((K * s) / 60)) / K;
const secAtBeatExact = (b) => (60 / K) * Math.log1p((K * b) / 120);

/** Synthetic capture: impulses at the context frames where `beats` were heard (+ round trip), like a musician playing. */
function captureClicks(anchor, beats, { rt, frame, frames, amp = 1 }) {
  const d = new Float32Array(frames);
  for (const b of beats) {
    const i = frameOfBeat(b, SR, anchor, rt) - frame;
    if (i >= 0 && i < frames) d[i] = amp;
  }
  return d;
}
const onsets = (d, thr = 0.5) => { const o = []; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) >= thr && (i === 0 || Math.abs(d[i - 1]) < thr)) o.push(i); return o; };

test('timing: unwrapped beat <-> context time through a ramp (and loop wraps) matches the closed form', () => {
  const map = rampMap();
  const a = { time: 2, beat: 0, bpm: 120, map };
  for (const s of [0, 0.5, 1.7, 3.3, 6.1]) {
    assert.ok(Math.abs(beatAtTime(a, 2 + s) - beatAtSecExact(s)) < 1e-9);
    assert.ok(Math.abs(timeAtBeat(a, beatAtSecExact(s)) - (2 + s)) < 1e-9);
  }
  // cycle [4, 8): every pass takes span(4, 8) seconds and lands on the same song beats
  const lp = { time: 0, beat: 0, bpm: 120, map, loop: { start: 4, end: 8 } };
  const P = map.span(4, 8);
  const tIn2 = map.secAt(6) + P; // beat 6 in the second pass
  const u = beatAtTime(lp, tIn2);
  assert.ok(Math.abs(u - 10) < 1e-9, `unwrapped ${u}`);
  assert.ok(Math.abs(songBeat(lp, u) - 6) < 1e-9);
  assert.ok(Math.abs(timeAtBeat(lp, 14) - (map.secAt(6) + 2 * P)) < 1e-9);
  // constant tempo (no map) keeps the linear formula exactly
  const c = { time: 1, beat: 3, bpm: 97 };
  assert.equal(beatAtTime(c, 2.5), 3 + (1.5 * 97) / 60);
  assert.equal(beatAtTime({ ...c, map: new TempoMap({ bpm: 97 }) }, 2.5), 3 + (1.5 * 97) / 60);
});

test('audio take across a 120 -> 140 linear ramp lands on the beats it was played on (< 1 ms)', () => {
  const map = rampMap();
  const anchor = { time: 1.0, beat: 0, bpm: 120, map }; // transport heard from beat 0 at t = 1 s
  const rt = 0.0123;
  const frame = Math.round(1.0 * SR); // capture starts with the transport
  const frames = Math.round(8.5 * SR);
  const hits = [3, 4, 6, 8, 10.5, 12, 13];
  const data = captureClicks(anchor, hits, { rt, frame, frames });
  const recIn = 2, u1 = beatAtTime(anchor, 1.0 + 7.9);
  const plan = planAudioTakes({ anchor, frame, frames, sampleRate: SR, rt, recIn, u1, bpb: 4, bpm: 120 });
  assert.equal(plan.passes.length, 1);
  const p = plan.passes[0];
  assert.equal(p.start, 2);
  assert.ok(Math.abs(p.end - u1) < 1e-5);
  // length in beats = beatAt(startTime + duration) − startBeat
  const startSec = map.secAt(p.start);
  assert.ok(Math.abs((p.end - p.start) - (map.beatAt(startSec + map.span(p.start, p.end)) - p.start)) < 1e-9);
  // the clip as playback treats it (unwarped under a map: offset · spb(start) + span(start, beat))
  const kept = data.slice(plan.f0, plan.f1);
  const clip = { start: p.start, length: p.end - p.start, offset: p.offset };
  for (const b of hits.filter((x) => x >= recIn && x < p.end)) {
    const want = srcSecAt(map, clip, b);
    const got = onsets(kept).map((i) => i / SR).find((s) => Math.abs(s - want) < 0.05);
    assert.ok(got != null && Math.abs(got - want) < MS, `beat ${b}: ${got} vs ${want}`);
  }
  // render it back on the timeline: onsets at secAt(beat) (exact ramp) within 1 ms
  const out = mixClipsToPcm({ clips: [{ ...clip, type: 'audio', sampleId: 'r' }], getPcm: () => ({ channels: [kept], sampleRate: SR }), map, sampleRate: SR, startBeat: 0, endBeat: 16, channels: 1 });
  const got = onsets(out[0]).map((i) => map.beatAt(i / SR));
  const expect = hits.filter((x) => x >= recIn + 0.01 && x < p.end);
  assert.equal(got.length, expect.length);
  got.forEach((b, i) => assert.ok(Math.abs(secAtBeatExact(b) - secAtBeatExact(expect[i])) < MS, `onset ${b} vs ${expect[i]}`));
  // the constant-tempo arithmetic would have missed by far more than that
  const naiveBeat = recIn + (onsets(kept)[onsets(kept).length - 1] / SR - p.offset * 0.5) / 0.5;
  assert.ok(Math.abs(naiveBeat - 13) > 0.1);
});

test('audio cycle recording across a ramp: every pass lines up with the loop', () => {
  const map = rampMap();
  const loop = { enabled: true, start: 4, end: 8 };
  const anchor = { time: 0.5, beat: 2, bpm: map.bpmAt(2), map, loop };
  const rt = 0.008, frame = Math.round(0.5 * SR);
  // hits at song beat 5 and 7 in each of three passes (unwrapped 5, 7, 9, 11, 13, 15)
  const unwrapped = [5, 7, 9, 11, 13, 15];
  const frames = Math.round((timeAtBeat(anchor, 16) - 0.5 + 0.2) * SR);
  const data = captureClicks(anchor, unwrapped, { rt, frame, frames });
  const plan = planAudioTakes({ anchor, frame, frames, sampleRate: SR, rt, recIn: 4, u1: 16, loop, bpb: 4, bpm: 120 });
  assert.deepEqual(plan.passes.map((x) => [x.start, x.end]), [[4, 8], [4, 8], [4, 8]]);
  const kept = data.slice(plan.f0, plan.f1);
  const ons = onsets(kept).map((i) => i / SR);
  for (const x of plan.passes) {
    for (const b of [5, 7]) {
      const want = srcSecAt(map, { start: x.start, offset: x.offset }, b);
      assert.ok(ons.some((s) => Math.abs(s - want) < MS), `pass ${x.pass} beat ${b}`);
    }
  }
});

test('constant tempo: planAudioTakes reproduces the original arithmetic bit for bit', () => {
  const anchor = { time: 0.73, beat: 1.5, bpm: 117 };
  const frame = 34567, frames = 9 * SR, rt = 0.0171, recIn = 2, u1 = 14.25, bpb = 4, bpm = 117;
  const loop = { enabled: true, start: 2, end: 10 };
  for (const a of [anchor, { ...anchor, map: new TempoMap({ bpm: 117 }), loop }]) {
    const plan = planAudioTakes({ anchor: a, frame, frames, sampleRate: SR, rt, recIn, u1, loop, bpb, bpm });
    // the pre-tempo-map code (session.js finish)
    const origin = beatOfFrame(frame, SR, anchor, rt);
    const lastBeat = origin + (frames / SR) / (60 / bpm);
    const passes = computePasses({ u0: recIn, u1: Math.min(u1, lastBeat), loop, punch: null, origin, minLen: 1 });
    const sp = 60 / bpm;
    const lo = Math.max(0, Math.min(...passes.map((x) => x.offset)) - bpb);
    const hi = Math.max(...passes.map((x) => x.offset + x.end - x.start)) + bpb;
    const f0 = Math.max(0, Math.round(lo * sp * SR)), f1 = Math.min(frames, Math.round(hi * sp * SR));
    const shift = f0 / SR / sp;
    assert.equal(plan.f0, f0);
    assert.equal(plan.f1, f1);
    assert.equal(plan.srcLength, (f1 - f0) / SR / sp);
    assert.deepEqual(plan.passes.map(({ srcLength, ...x }) => x), passes.map((x) => ({ ...x, offset: x.offset - shift })));
  }
  // envelope points: number spb unchanged; constant map in mixClipsToPcm = bpm
  const clip = { start: 0, length: 4, fadeIn: 1, fadeInShape: 's', gainEnv: [{ beat: 2, gain: 0.5 }] };
  assert.deepEqual(envelopePoints(clip, 0.5, 1.5, 0.5), envelopePoints(clip, 0.5, 1.5, 0.5));
  const pcm = { channels: [Float32Array.from({ length: SR }, (_, i) => Math.sin(i / 7))], sampleRate: SR };
  const c = { type: 'audio', sampleId: 's', start: 1, length: 1.5, offset: 0.25, fadeOut: 0.5 };
  const a1 = mixClipsToPcm({ clips: [c], getPcm: () => pcm, bpm: 120, sampleRate: SR, startBeat: 0, endBeat: 3, channels: 1 });
  const a2 = mixClipsToPcm({ clips: [c], getPcm: () => pcm, bpm: 120, map: new TempoMap({ bpm: 120 }), sampleRate: SR, startBeat: 0, endBeat: 3, channels: 1 });
  assert.deepEqual(a1, a2);
});

test('MIDI notes played during a ramp get the beats the transport was at', () => {
  const p = createProject();
  p.mode = 'song';
  p.bpm = 120;
  p.tempoMap = RAMP.map((x) => ({ ...x }));
  const ctx = { currentTime: 0 };
  const sch = new Scheduler({ ctx, getProject: () => p, dispatch() {} });
  sch.start(0, 0);
  const a = sch.anchors[0];
  const anchor = { time: a.time, beat: a.beat, bpm: a.bpm, map: a.map };
  const rec = new MidiPassRecorder({ recIn: 0 });
  const played = [[60, 0.4, 0.9], [62, 2.0, 2.6], [64, 4.1, 5.0], [65, 6.3, 6.8]]; // [pitch, t on, t off] seconds after start
  for (const [pitch, on, off] of played) {
    ctx.currentTime = a.time + on;
    const bOn = sch.getPosition(); // what engine.getPosition() hands the recorder
    assert.ok(Math.abs(bOn - beatAtSecExact(on)) < 1e-9);
    assert.ok(Math.abs(beatAtTime(anchor, a.time + on) - bOn) < 1e-9);
    rec.noteOn('t', pitch, 0.8, bOn);
    ctx.currentTime = a.time + off;
    rec.noteOff('t', pitch, sch.getPosition());
  }
  sch.stop();
  const notes = rec.finish();
  const [take] = buildMidiTakes(notes, { recIn: 0, stop: 16 });
  played.forEach(([pitch, on, off], i) => {
    const n = take.notes[i];
    assert.equal(n.pitch, pitch);
    assert.ok(Math.abs(secAtBeatExact(n.start) - on) < MS, `note ${pitch} start`);
    assert.ok(Math.abs(secAtBeatExact(n.start + n.dur) - off) < MS, `note ${pitch} end`);
  });
});

test('capture MIDI with the transport stopped times free playing through the tempo map and snaps to its bars', () => {
  const map = new TempoMap({ bpm: 120, points: RAMP, meters: [{ bar: 1, num: 7, den: 8 }, { bar: 2, num: 4, den: 4 }] });
  const cb = new CaptureBuffer();
  const T = 100;
  cb.noteOn('t', 60, 0.8, T); cb.noteOff('t', 60, T + 0.3);
  cb.noteOn('t', 62, 0.8, T + 2.5); cb.noteOff('t', 62, T + 2.9);
  const c = cb.capture({ trackId: 't', bpm: 120, bpb: 4, atBeat: 0, map, now: T + 3 });
  assert.equal(c.start, 0);
  assert.ok(Math.abs(c.notes[1].start - beatAtSecExact(2.5)) < 1e-4);
  // phrase ends inside bar 2 (7/8, beats 4..7.5) -> the clip covers bars 1-2 = 7.5 beats
  assert.ok(beatAtSecExact(2.9) > 4 && beatAtSecExact(2.9) < 7.5);
  assert.equal(c.length, 7.5);
  // no map: unchanged
  const c0 = cb.capture({ trackId: 't', bpm: 120, bpb: 4, atBeat: 0, now: T + 3 });
  assert.equal(c0.notes[1].start, 5);
  assert.equal(c0.length, 8);
});

test('count-in through a 7/8 bar: its own clicks, accents (2+2+3) and tempo; pre-roll counts real bars', () => {
  // bar 0: 4/4 (beats 0-4), bar 1: 7/8 (4-7.5), bar 2+: 4/4 from 7.5
  const map = new TempoMap({ bpm: 100, points: [{ beat: 0, bpm: 100, curve: 'linear' }, { beat: 8, bpm: 140, curve: 'jump' }], meters: [{ bar: 1, num: 7, den: 8 }, { bar: 2, num: 4, den: 4 }] });
  const ci = countInPlan(map, 7.5, 1);
  assert.equal(ci.from, 4);
  assert.equal(ci.beats, 3.5);
  assert.deepEqual(ci.clicks.map((c) => c.beat), [4, 4.5, 5, 5.5, 6, 6.5, 7]);
  assert.deepEqual(ci.clicks.map((c) => c.level), [2, 0, 1, 0, 1, 0, 0]);
  ci.clicks.forEach((c) => assert.ok(Math.abs(c.t - map.span(4, c.beat)) < 1e-12));
  assert.ok(Math.abs(ci.sec - map.span(4, 7.5)) < 1e-12);
  // the clicks follow the ramp: eighths get shorter
  const gaps = ci.clicks.slice(1).map((c, i) => c.t - ci.clicks[i].t);
  assert.ok(gaps.every((g, i) => i === 0 || g < gaps[i - 1]));
  // two bars: the 4/4 bar then the 7/8 bar
  const c2 = countInPlan(map, 7.5, 2);
  assert.equal(c2.from, 0);
  assert.equal(c2.clicks.length, 4 + 7);
  assert.deepEqual(c2.clicks.slice(0, 4).map((c) => c.level), [2, 1, 1, 1]);
  // before bar 1: the first meter / tempo, negative beats
  const c0 = countInPlan(map, 0, 1);
  assert.equal(c0.from, -4);
  assert.deepEqual(c0.clicks.map((c) => c.beat), [-4, -3, -2, -1]);
  assert.ok(Math.abs(c0.sec - 4 * 60 / 100) < 1e-12);
  // pre-roll / post-roll in bars of the meter map
  assert.equal(recordPlan({ pos: 7.5, preRollBars: 1, bpb: 4, map }).playFrom, 4);
  assert.equal(recordPlan({ pos: 9, preRollBars: 1, bpb: 4, map }).playFrom, 9 - 3.5); // one (7/8) bar back, same place in the bar
  assert.equal(recordPlan({ pos: 0, punch: { enabled: true, start: 2, end: 4 }, postRollBars: 1, bpb: 4, map }).stopAt, 7.5);
  // without a map: unchanged
  assert.deepEqual(recordPlan({ pos: 7.5, preRollBars: 1, bpb: 4 }), { playFrom: 3.5, recIn: 7.5, stopAt: null, punched: false, cycle: false });
});

test('comp flatten across a ramp: each comp segment plays its take at the right time, crossfaded', () => {
  const p = createProject();
  p.mode = 'song';
  p.bpm = 120;
  p.tempoMap = RAMP.map((x) => ({ ...x }));
  const map = songTempoMap(p);
  // two takes recorded over [0, 12): A has hits at 2, 4, 6, 8 (amp 1), B at 3, 5, 7, 9 (amp -1) — sample second 0 = beat 0
  const len = Math.round((map.secAt(12) + 0.5) * SR);
  const mk = (beats, amp) => { const d = new Float32Array(len); for (const b of beats) d[Math.round(map.secAt(b) * SR)] = amp; return d; };
  const pcm = { A: mk([2, 4, 6, 8], 1), B: mk([3, 5, 7, 9], -1) };
  // takes start at beat 1 (offset = content beats at the tempo of beat 1)
  const off = map.secAt(1) / map.spbAt(1);
  const tA = createTake({ name: 'A', sampleId: 'A', start: 1, length: 11, offset: off, srcLength: len / SR / map.spbAt(1) });
  const tB = createTake({ name: 'B', sampleId: 'B', start: 1, length: 11, offset: off, srcLength: len / SR / map.spbAt(1) });
  const track = { id: 'tr', takeLanes: [{ id: 'l1', takes: [tA] }, { id: 'l2', takes: [tB] }], comp: [{ takeId: tA.id, start: 1, end: 4.5 }, { takeId: tB.id, start: 4.5, end: 6.5 }, { takeId: tA.id, start: 6.5, end: 10 }] };
  const cc = compClips(p, track);
  assert.equal(cc.length, 3);
  // every comp clip plays the same source second at a beat as its take does
  for (const c of cc) {
    const take = c.takeId === tA.id ? tA : tB;
    for (const b of [c.start, c.start + c.length / 2]) assert.ok(Math.abs(srcSecAt(map, c, b) - srcSecAt(map, take, b)) < 1e-9);
  }
  // crossfades ~10 ms centred on the boundaries
  assert.ok(Math.abs(map.span(cc[1].start, 4.5) - 0.005) < 1e-4);
  const out = mixClipsToPcm({ clips: cc, getPcm: (id) => ({ channels: [pcm[id]], sampleRate: SR }), map, sampleRate: SR, startBeat: 1, endBeat: 10, channels: 1 });
  const hits = [];
  for (let i = 0; i < out[0].length; i++) if (Math.abs(out[0][i]) > 0.5) hits.push({ beat: map.beatAt(map.secAt(1) + i / SR), sign: Math.sign(out[0][i]) });
  assert.deepEqual(hits.map((h) => h.sign), [1, 1, -1, 1]); // A:2, A:4, B:5, A:8
  [2, 4, 5, 8].forEach((b, i) => assert.ok(Math.abs(map.secAt(hits[i].beat) - map.secAt(b)) < MS, `hit ${b}: ${hits[i].beat}`));
  // the flattened clip (offset 0 at the render start) plays back in the same place
  const flat = { type: 'audio', sampleId: 'F', start: 1, length: 9, offset: 0 };
  const re = mixClipsToPcm({ clips: [flat], getPcm: () => ({ channels: out, sampleRate: SR }), map, sampleRate: SR, startBeat: 0, endBeat: 10, channels: 1 });
  const rh = []; for (let i = 0; i < re[0].length; i++) if (Math.abs(re[0][i]) > 0.5) rh.push(map.beatAt(i / SR));
  [2, 4, 5, 8].forEach((b, i) => assert.ok(Math.abs(map.secAt(rh[i]) - map.secAt(b)) < MS));
});

test('unwarped clips under a tempo map: gain envelope points are converted to seconds like fades', async () => {
  const { unwarpedInSeconds } = await import('../src/audio/warp/player.js');
  const map = { spbAt: () => 0.5, span: (a, b) => (b - a) * 0.5 };
  const ev = { beat: 0, dur: 8, clip: { start: 0, length: 8, offset: 0, fadeIn: 1, gainEnv: [{ beat: 0, gain: 1 }, { beat: 4, gain: 0.5 }] } };
  const out = unwarpedInSeconds(ev, map);
  assert.deepEqual(out.clip.gainEnv.map((p) => p.beat), [0, 2]);
  assert.equal(out.clip.fadeIn, 0.5);
});
