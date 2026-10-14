// Recording, takes + comping, clip editing math, MIDI capture (src/record/*).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePasses, addRecordedTakes, setCompRange, compClips, createTake, placeTakes, promoteTake, deleteTake,
  normalizeComp, compTakeAt, cutRange,
} from '../src/record/takes.js';
import {
  trackClips, autoCrossfade, envelopePoints, pointsValueAt, clipGainAt, fadeCurve, mixClipsToPcm, splitClipAt, slipOffset,
  rippleDelete, rippleShift, nearestZeroCrossing, normalizeGain, reverseFrames, peakOf, needsShapedEnvelope,
} from '../src/record/clips.js';
import { beatOfFrame, frameOfBeat, roundTrip, detectPing, recordPlan, monitorActive } from '../src/record/timing.js';
import { MidiPassRecorder, buildMidiTakes, CaptureBuffer, StepInput, quantizeNote } from '../src/record/midi.js';
import { collectEvents } from '../src/audio/scheduler.js';
import { createProject, createTrack, createClip, normalizeProject } from '../src/core/model.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function audioSong() {
  const p = createProject();
  p.mode = 'song';
  p.bpm = 120;
  const t = createTrack({ type: 'audio', name: 'Vox' });
  p.tracks.push(t);
  return { p, t };
}

// ------------------------------------------------------------------------------------------------ passes
test('computePasses: one take per cycle pass, offsets into the continuous recording', () => {
  const loop = { enabled: true, start: 4, end: 12 };
  // recording from beat 4 (count-in audio from beat 2 kept as handle), stopped during the 4th pass
  const ps = computePasses({ u0: 4, u1: 4 + 8 * 3 + 2, loop, origin: 2, minLen: 4 });
  assert.equal(ps.length, 3, 'the 2-beat partial 4th pass is dropped (minLen 4)');
  assert.deepEqual(ps.map((x) => [x.start, x.end]), [[4, 12], [4, 12], [4, 12]]);
  assert.deepEqual(ps.map((x) => x.offset), [2, 10, 18]);
  // shorter minLen keeps the partial pass
  const ps2 = computePasses({ u0: 4, u1: 30, loop, origin: 4, minLen: 1 });
  assert.equal(ps2.length, 4);
  assert.deepEqual([ps2[3].start, ps2[3].end, ps2[3].offset], [4, 6, 24]);
  // starting inside the loop: the first pass is partial
  const ps3 = computePasses({ u0: 8, u1: 20, loop, minLen: 1 });
  assert.deepEqual(ps3.map((x) => [x.start, x.end, x.offset]), [[8, 12, 0], [4, 12, 4]]);
  // no loop: one linear pass
  assert.deepEqual(computePasses({ u0: 3, u1: 9 }), [{ pass: 0, start: 3, end: 9, offset: 0 }]);
});

test('computePasses: punch in / out keeps only the punch range of every pass', () => {
  const punch = { enabled: true, start: 6, end: 9 };
  const lin = computePasses({ u0: 0, u1: 16, punch });
  assert.deepEqual(lin, [{ pass: 0, start: 6, end: 9, offset: 6 }]);
  const cyc = computePasses({ u0: 4, u1: 20, loop: { enabled: true, start: 4, end: 12 }, punch, origin: 3 });
  assert.deepEqual(cyc.map((x) => [x.start, x.end, x.offset]), [[6, 9, 3], [6, 9, 11]]);
  // punch entirely outside the recording: nothing
  assert.deepEqual(computePasses({ u0: 0, u1: 4, punch }), []);
});

test('recordPlan: pre-roll, punch-in and auto stop after post-roll', () => {
  assert.deepEqual(recordPlan({ pos: 8, preRollBars: 1, bpb: 4 }), { playFrom: 4, recIn: 8, stopAt: null, punched: false, cycle: false });
  const r = recordPlan({ pos: 0, punch: { enabled: true, start: 16, end: 24 }, preRollBars: 2, postRollBars: 1, bpb: 4 });
  assert.deepEqual([r.playFrom, r.recIn, r.stopAt, r.punched], [8, 16, 28, true]);
  // cycling: no auto stop
  assert.equal(recordPlan({ pos: 0, punch: { enabled: true, start: 4, end: 8 }, loop: { enabled: true, start: 0, end: 16 } }).stopAt, null);
  assert.equal(recordPlan({ pos: 2, preRollBars: 4 }).playFrom, 0, 'pre-roll never starts before 0');
});

// ------------------------------------------------------------------------------------------------ latency
test('latency compensation: captured frames land on the beat the musician heard', () => {
  const sr = 48000;
  const anchor = { time: 10, beat: 0, bpm: 120 }; // beat 0 was heard (left the graph) at ctx time 10 s
  const rt = roundTrip({ estimate: 0.02, calibratedMs: 12.5, manualMs: 1.5 });
  assert.ok(near(rt, 0.014), 'calibration wins over the estimate, manual offset added');
  assert.ok(near(roundTrip({ estimate: 0.02 }), 0.02));
  // the downbeat played in time arrives rt later in the capture
  const f = Math.round((10 + 2 * 0.5 + rt) * sr); // beat 2 heard at 11 s
  assert.ok(near(beatOfFrame(f, sr, anchor, rt), 2, 1e-4));
  assert.equal(frameOfBeat(2, sr, anchor, rt), f);
  // without compensation the take would be late by rt (in beats)
  assert.ok(beatOfFrame(f, sr, anchor, 0) - 2 > 0.027);
});

test('detectPing: finds the loopback delay of a click train', () => {
  const sr = 44100, delay = 1234;
  const data = new Float32Array(sr * 3);
  let seed = 7;
  for (let i = 0; i < data.length; i++) { seed = (seed * 16807) % 2147483647; data[i] = ((seed / 2147483647) - 0.5) * 0.004; } // noise
  const emits = [4410, 30000, 60000, 90000];
  for (const e of emits) for (let k = 0; k < 40; k++) data[e + delay + k] += 0.6 * Math.exp(-k / 8) * (k % 2 ? -1 : 1);
  const r = detectPing(data, sr, emits);
  assert.ok(r, 'detected');
  assert.ok(Math.abs(r.frames - delay) <= 1, `frames ${r.frames}`);
  assert.ok(near(r.ms, (r.frames / sr) * 1000));
  assert.equal(detectPing(new Float32Array(sr), sr, [100, 20000]), null, 'silence: no result');
});

test('monitorActive: off / on / auto (tape style)', () => {
  assert.equal(monitorActive('off', { armed: true }), false);
  assert.equal(monitorActive('on', {}), true);
  assert.equal(monitorActive('auto', { armed: false }), false);
  assert.equal(monitorActive('auto', { armed: true, playing: false }), true);
  assert.equal(monitorActive('auto', { armed: true, playing: true, recording: false }), false, 'playback: hear the takes');
  assert.equal(monitorActive('auto', { armed: true, playing: true, recording: true }), true);
  assert.equal(monitorActive('auto', { armed: true, playing: true, recording: true, punched: true, inPunch: false }), false);
});

// ------------------------------------------------------------------------------------------------ takes + comp
function threeTakeTrack() {
  const { p, t } = audioSong();
  const passes = computePasses({ u0: 0, u1: 24, loop: { enabled: true, start: 0, end: 8 } });
  const takes = passes.map((x, i) => createTake({ name: `Take ${i + 1}`, sampleId: 'smp_rec', start: x.start, length: x.end - x.start, offset: x.offset, srcLength: 24 }));
  const { absorbed } = addRecordedTakes(p, t, takes);
  return { p, t, takes, absorbed };
}

test('takes: each cycle pass becomes a take in its own lane; the comp plays the newest', () => {
  const { t, takes, absorbed } = threeTakeTrack();
  assert.equal(absorbed.length, 0);
  assert.equal(t.takeLanes.length, 3);
  assert.deepEqual(t.takeLanes.map((l) => l.takes.length), [1, 1, 1]);
  assert.deepEqual(takes.map((x) => x.pass), [1, 2, 3]);
  assert.deepEqual(t.comp, [{ takeId: takes[2].id, start: 0, end: 8 }]);
});

test('takes: recording over an existing clip keeps it as an "Original" take', () => {
  const { p, t } = audioSong();
  p.clips.push(createClip(t.id, { type: 'audio', sampleId: 'smp_old', start: 0, length: 16, name: 'Old' }));
  const take = createTake({ sampleId: 'smp_new', start: 4, length: 4, offset: 0 });
  const { absorbed } = addRecordedTakes(p, t, [take]);
  assert.equal(absorbed.length, 1);
  assert.equal(t.takeLanes.length, 2);
  const orig = t.takeLanes[0].takes[0];
  assert.equal(orig.sampleId, 'smp_old');
  assert.deepEqual(t.comp.map((s) => [s.takeId === orig.id ? 'old' : 'new', s.start, s.end]), [['old', 0, 4], ['new', 4, 8], ['old', 8, 16]]);
});

test('swipe comping: segment math, merge, promote, delete', () => {
  const { t, takes } = threeTakeTrack();
  const [a, b, c] = takes.map((x) => x.id);
  setCompRange(t, a, 2, 5); // swipe take 1 over 2..5
  assert.deepEqual(t.comp.map((s) => [s.takeId, s.start, s.end]), [[c, 0, 2], [a, 2, 5], [c, 5, 8]]);
  setCompRange(t, b, 4.5, 3); // reversed drag, overlaps take 1's segment
  assert.deepEqual(t.comp.map((s) => [s.takeId, s.start, s.end]), [[c, 0, 2], [a, 2, 3], [b, 3, 4.5], [a, 4.5, 5], [c, 5, 8]]);
  setCompRange(t, c, 2, 5); // the same take again: merges with its neighbours
  assert.deepEqual(t.comp.map((s) => [s.takeId, s.start, s.end]), [[c, 0, 8]]);
  setCompRange(t, a, -5, 3); // clamped to the take
  assert.deepEqual(t.comp[0], { takeId: a, start: 0, end: 3 });
  assert.equal(compTakeAt(t, 1), a);
  assert.equal(compTakeAt(t, 5), c);
  promoteTake(t, b);
  assert.deepEqual(t.comp, [{ takeId: b, start: 0, end: 8 }]);
  deleteTake(t, b); // the newest remaining take fills the hole
  assert.deepEqual(t.comp, [{ takeId: c, start: 0, end: 8 }]);
  assert.equal(t.takeLanes.length, 2);
  deleteTake(t, a); deleteTake(t, c);
  assert.equal(t.takeLanes, undefined, 'no takes left: model removed');
  assert.equal(t.comp, undefined);
  assert.deepEqual(cutRange([{ takeId: 'x', start: 0, end: 10 }], 2, 3), [{ takeId: 'x', start: 0, end: 2 }, { takeId: 'x', start: 3, end: 10 }]);
});

test('comp clips: equal-power crossfade centred on each boundary, using the handles', () => {
  const { p, t, takes } = threeTakeTrack();
  setCompRange(t, takes[0].id, 2, 5);
  t.compXfade = 20; // ms -> at 120 bpm 0.04 beats
  const cc = compClips(p, t);
  assert.equal(cc.length, 3);
  const xf = 0.02 / 0.5;
  // first segment (take 3, 0..2) extends half a crossfade into the next one and fades out over the whole crossfade
  assert.ok(near(cc[0].start, 0) && near(cc[0].length, 2 + xf / 2));
  assert.ok(near(cc[0].fadeOut, xf) && cc[0].fadeOutShape === 'eqp' && !cc[0].fadeIn);
  // middle one: starts half a crossfade early (its handle), fades in and out
  assert.ok(near(cc[1].start, 2 - xf / 2) && near(cc[1].length, 3 + xf));
  assert.ok(near(cc[1].offset, takes[0].offset + 2 - xf / 2));
  assert.ok(near(cc[1].fadeIn, xf) && near(cc[1].fadeOut, xf));
  assert.ok(near(cc[2].fadeIn, xf) && !cc[2].fadeOut);
  // the very first take has no audio before beat 0 of the recording: the fade shrinks to what exists
  t.comp = [{ takeId: takes[2].id, start: 0, end: 4 }, { takeId: takes[0].id, start: 4, end: 8 }];
  normalizeComp(t);
  const t0 = takes[0];
  assert.equal(t0.offset, 0);
  const c2 = compClips(p, t);
  assert.ok(near(c2[1].start, 4 - xf / 2), 'take 1 has its own audio before beat 4 (offset 4)');
  // equal power: the two gains' squares sum to 1 through the crossfade
  for (let k = 0; k <= 10; k++) {
    const x = c2[0].start + c2[0].length - xf + (xf * k) / 10;
    const gA = clipGainAt(c2[0], x - c2[0].start), gB = clipGainAt(c2[1], x - c2[1].start);
    assert.ok(near(gA * gA + gB * gB, 1, 1e-6), `k=${k}: ${gA * gA + gB * gB}`);
  }
});

test('scheduler plays the comp (and only the comp) of a track with take lanes', () => {
  const { p, t, takes } = threeTakeTrack();
  setCompRange(t, takes[0].id, 4, 8);
  const evs = collectEvents(p, 0, 8, { mode: 'song' }).filter((e) => e.type === 'audio');
  assert.equal(evs.length, 2);
  assert.equal(evs[0].clip.takeId, takes[2].id);
  assert.equal(evs[1].clip.takeId, takes[0].id);
  assert.ok(evs[1].beat < 4 && evs[1].beat > 3.9, 'starts half a crossfade early');
  assert.ok(needsShapedEnvelope(evs[1].clip));
  // a seek into the middle starts the comp segment part-way
  const j = collectEvents(p, 6, 7, { mode: 'song', jump: true }).filter((e) => e.type === 'audio');
  assert.equal(j.length, 1);
  assert.ok(near(j[0].offset, 6 - evs[1].clip.start));
  // projects without takes are unchanged
  const plain = audioSong();
  plain.p.clips.push(createClip(plain.t.id, { type: 'audio', sampleId: 's', start: 1, length: 2 }));
  const e2 = collectEvents(plain.p, 0, 4, { mode: 'song' });
  assert.equal(e2.length, 1);
  assert.equal(e2[0].clip, plain.p.clips[0], 'plain clips are passed through as they are');
  // normalizeProject keeps the take model
  const n = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(n.tracks[0].takeLanes.length, 3);
  assert.equal(n.tracks[0].comp.length, 2);
});

test('crossfade rendering: comp boundaries are click-free and keep the level', () => {
  const sr = 8000, bpm = 120;
  const { p, t, takes } = threeTakeTrack(); // 3 takes on one 24-beat (12 s) recording
  // the recording: a 200 Hz sine whose phase flips every pass (worst case for a hard cut)
  const n = 12 * sr;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) { const pass = Math.floor(i / (4 * sr)); pcm[i] = 0.5 * Math.sin(2 * Math.PI * 200 * i / sr + (pass % 2) * Math.PI); }
  const getPcm = () => ({ channels: [pcm], sampleRate: sr });
  setCompRange(t, takes[1].id, 3, 5);
  const render = (ms) => {
    t.compXfade = ms;
    return mixClipsToPcm({ clips: trackClips(p, t), getPcm, bpm, sampleRate: sr, startBeat: 0, endBeat: 8, channels: 1 })[0];
  };
  const maxStep = (d, a, b) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(d[i] - d[i - 1])); return m; };
  const xf = render(10);
  const sine = 2 * Math.PI * 200 / sr * 0.5; // the sine's own largest step
  const b1 = 3 * 0.5 * sr, b2 = 5 * 0.5 * sr;
  assert.ok(maxStep(xf, b1 - 200, b1 + 200) < sine * 1.6, `boundary 1 step ${maxStep(xf, b1 - 200, b1 + 200)} vs ${sine}`);
  assert.ok(maxStep(xf, b2 - 200, b2 + 200) < sine * 1.6);
  // non-silent all the way through (no gap at the boundaries)
  for (const b of [b1, b2]) {
    let e = 0;
    for (let i = b - 40; i < b + 40; i++) e = Math.max(e, Math.abs(xf[i]));
    assert.ok(e > 0.2, 'level kept across the boundary');
  }
  let peak = 0;
  for (const v of xf) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.5 * Math.SQRT2 + 1e-3, 'equal-power bump is at most +3 dB');
  assert.ok(peakOf([xf]) > 0.45);
});

// ------------------------------------------------------------------------------------------------ clip editing
test('fade shapes + envelope points', () => {
  assert.equal(fadeCurve('lin', 0.5), 0.5);
  assert.ok(fadeCurve('exp', 0.5) < 0.5 && fadeCurve('log', 0.5) > 0.5);
  assert.ok(near(fadeCurve('s', 0.5), 0.5) && near(fadeCurve('eqp', 1), 1));
  const clip = { type: 'audio', start: 0, length: 4, gain: 0.5, fadeIn: 1, fadeInShape: 's', fadeOut: 1, fadeOutShape: 'exp', gainEnv: [{ beat: 2, gain: 1 }, { beat: 3, gain: 0.5 }] };
  const spb = 0.5;
  const pts = envelopePoints(clip, 0, 2, spb);
  assert.equal(pts[0].v, 0);
  assert.equal(pts[pts.length - 1].v, 0);
  assert.ok(pts.every((q, i) => !i || q.t > pts[i - 1].t), 'strictly increasing times');
  // value in the middle of the S fade-in: 0.5 (curve) × 0.5 (gain) × 1 (env)
  assert.ok(near(pointsValueAt(pts, 0.25), 0.25, 0.01));
  // from the middle (seek): starts with the de-click ramp, follows the gain envelope
  const p2 = envelopePoints(clip, 2.5, 0.75, spb);
  assert.ok(near(pointsValueAt(p2, 0.25), clipGainAt(clip, 3), 1e-6));
});

test('auto crossfade where audio clips overlap', () => {
  const a = createClip('t', { type: 'audio', sampleId: 's', start: 0, length: 4 });
  const b = createClip('t', { type: 'audio', sampleId: 's', start: 3, length: 4 });
  const c = createClip('t', { type: 'audio', sampleId: 's', start: 10, length: 2 });
  const out = autoCrossfade([a, b, c]);
  assert.ok(out[0] !== a && out[0].fadeOut === 1 && out[0].fadeOutShape === 'eqp');
  assert.ok(out[1].fadeIn === 1 && out[1].fadeInShape === 'eqp');
  assert.equal(out[2], c);
  assert.equal(a.fadeOut, undefined, 'originals untouched');
  b.xfade = false;
  assert.deepEqual(autoCrossfade([a, b]), [a, b]);
});

test('split / slip / ripple / zero crossing / normalize / reverse', () => {
  const clip = { id: 'c1', trackId: 't', type: 'audio', sampleId: 's', start: 4, length: 8, offset: 1, fadeIn: 1, fadeOut: 2, gainEnv: [{ beat: 0, gain: 1 }, { beat: 8, gain: 0 }] };
  const [l, r] = splitClipAt(clip, 6, { newId: 'c2' });
  assert.deepEqual([l.start, l.length, l.offset, r.start, r.length, r.offset], [4, 2, 1, 6, 6, 3]);
  assert.equal(l.fadeOut, undefined); assert.equal(r.fadeIn, undefined); assert.equal(r.fadeOut, 2); assert.equal(l.fadeIn, 1);
  assert.ok(near(l.gainEnv.at(-1).gain, 0.75) && near(r.gainEnv[0].gain, 0.75));
  assert.equal(splitClipAt(clip, 4), null);
  const pc = splitClipAt({ id: 'p', type: 'pattern', start: 0, length: 8, offset: 3 }, 2, { patternLength: 4 });
  assert.equal(pc[1].offset, 1, 'pattern offsets wrap');
  // slip: content moves right -> offset decreases, bounded by the source
  assert.equal(slipOffset({ offset: 2, length: 4 }, 1, 10), 1);
  assert.equal(slipOffset({ offset: 2, length: 4 }, 5, 10), 0);
  assert.equal(slipOffset({ offset: 2, length: 4 }, -9, 10), 6);
  // ripple delete
  const clips = [
    { id: 'a', trackId: 't', start: 0, length: 4 }, { id: 'b', trackId: 't', start: 4, length: 2 },
    { id: 'c', trackId: 't', start: 8, length: 4 }, { id: 'd', trackId: 'u', start: 8, length: 4 },
  ];
  const rd = rippleDelete(clips, ['b']);
  assert.deepEqual(rd.map((c) => [c.id, c.start]), [['a', 0], ['c', 6], ['d', 8]]);
  assert.deepEqual(rippleShift(clips, 't', 4, 2, ['b']).map((c) => c.start), [0, 4, 10, 8]);
  // zero crossing
  const d = new Float32Array(100);
  for (let i = 0; i < 100; i++) d[i] = Math.sin((2 * Math.PI * (i - 3)) / 40);
  assert.ok(Math.abs(nearestZeroCrossing(d, 20) - 23) <= 1);
  // normalize
  assert.ok(near(normalizeGain(0.5, 0), 2));
  assert.equal(normalizeGain(0), null);
  // reverse
  const rv = reverseFrames([Float32Array.from([1, 2, 3, 4, 5])], 1, 4);
  assert.deepEqual([...rv[0]], [4, 3, 2]);
});

// ------------------------------------------------------------------------------------------------ MIDI
test('MIDI cycle recording: a new take per loop pass (or merged), notes relative to the take', () => {
  const loop = { enabled: true, start: 0, end: 4 };
  const r = new MidiPassRecorder({ recIn: 0, loop });
  const play = (pitch, on, off) => { r.noteOn('t', pitch, 0.8, on); r.noteOff('t', pitch, off); };
  play(60, 0.02, 0.5); play(62, 2.0, 2.4);
  r.position(3.9); r.position(0.05); // wrap
  play(64, 1.01, 1.4);
  r.noteOn('t', 67, 0.9, 3.5); // held across the next wrap
  r.position(0.1);
  r.noteOff('t', 67, 0.6);
  const notes = r.finish(2);
  assert.equal(r.pass, 2);
  const takes = buildMidiTakes(notes, { recIn: 0, stop: 2, loop, mode: 'takes', grid: 0.25 });
  assert.deepEqual(takes.map((t) => [t.pass, t.start, t.length, t.notes.length]), [[0, 0, 4, 2], [1, 0, 4, 2], [2, 0, 2, 1]]);
  assert.deepEqual(takes[0].notes.map((n) => [n.pitch, n.start]), [[60, 0], [62, 2]]);
  assert.deepEqual(takes[1].notes.map((n) => [n.pitch, n.start, n.dur]), [[64, 1, 0.39], [67, 3.5, 0.5]]);
  assert.deepEqual(takes[2].notes.map((n) => [n.pitch, n.start]), [[67, 0]]);
  const merged = buildMidiTakes(notes, { recIn: 0, stop: 2, loop, mode: 'merge' });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].notes.length, 5);
  // linear (no loop)
  const lin = buildMidiTakes([{ pitch: 60, vel: 1, start: 9.1, end: 10, pass: 0 }], { recIn: 8, stop: 12, grid: 0.5, quantizeLength: true });
  assert.deepEqual([lin[0].start, lin[0].length, lin[0].notes[0].start, lin[0].notes[0].dur], [8, 4, 1, 1]);
  assert.deepEqual(quantizeNote(1.13, 0.3, 0), { start: 1.13, dur: 0.3 });
});

test('capture MIDI: retrospective buffer keeps 2 minutes and drops the last phrase into a clip', () => {
  const cb = new CaptureBuffer({ seconds: 120 });
  cb.noteOn('t', 40, 0.5, 0); cb.noteOff('t', 40, 0.4); // an old phrase…
  // …then (after a 10 s pause) a phrase played with the transport stopped, at 120 bpm
  cb.noteOn('t', 60, 0.8, 10.0); cb.noteOff('t', 60, 10.25);
  cb.noteOn('t', 64, 0.7, 10.5); cb.noteOff('t', 64, 10.75);
  cb.noteOn('t', 67, 0.9, 11.0);
  const c = cb.capture({ bpm: 120, bpb: 4, atBeat: 8, now: 11.5 });
  assert.equal(c.onBeats, false);
  assert.deepEqual([c.start, c.length], [8, 4]);
  assert.deepEqual(c.notes.map((n) => [n.pitch, +n.start.toFixed(3), +n.dur.toFixed(3)]), [[60, 0, 0.5], [64, 1, 0.5], [67, 2, 1]]);
  // played over a running transport: the song positions are kept
  const cb2 = new CaptureBuffer();
  cb2.noteOn('t', 50, 1, 1, 13.0); cb2.noteOff('t', 50, 1.5, 14.0);
  const c2 = cb2.capture({ bpb: 4 });
  assert.deepEqual([c2.onBeats, c2.start, c2.notes[0].start, c2.notes[0].dur], [true, 12, 1, 1]);
  // older than 2 minutes: gone
  cb2.noteOn('t', 52, 1, 200); cb2.noteOff('t', 52, 200.5);
  assert.equal(cb2.notes().length, 1);
});

test('step input: chords at the cursor, rests and back', () => {
  const s = new StepInput({ cursor: 4, step: 0.5, legato: 1 });
  s.noteOn(60); s.noteOn(64);
  assert.equal(s.noteOff(60), null, 'chord still held');
  assert.deepEqual(s.noteOff(64).map((n) => [n.pitch, n.start, n.dur]), [[60, 4, 0.5], [64, 4, 0.5]]);
  s.rest();
  s.noteOn(67);
  assert.deepEqual(s.noteOff(67).map((n) => [n.pitch, n.start]), [[67, 5]]);
  assert.equal(s.cursor, 5.5);
  assert.deepEqual(s.back().map((n) => n.pitch), [67]);
  assert.equal(s.cursor, 5);
});

test('placeTakes fills free lanes before adding new ones', () => {
  const t = { id: 't' };
  placeTakes(t, [createTake({ sampleId: 'a', start: 0, length: 4 }), createTake({ sampleId: 'b', start: 0, length: 4 })]);
  placeTakes(t, [createTake({ sampleId: 'c', start: 8, length: 4 })]);
  assert.equal(t.takeLanes.length, 2);
  assert.equal(t.takeLanes[0].takes.length, 2);
});

test('mixer schedules the shaped envelope for comp / curved-fade clips; song length counts comps', async () => {
  const { MixGraph } = await import('../src/audio/mixer.js');
  const { songLengthBeats } = await import('../src/core/model.js');
  const { defaultEndBeat } = await import('../src/audio/scheduler.js');
  const calls = [];
  const g = { gain: { setValueAtTime: (v, t) => calls.push(['set', v, t]), linearRampToValueAtTime: (v, t) => calls.push(['ramp', v, t]) } };
  const clip = { type: 'audio', start: 0, length: 4, gain: 1, fadeIn: 1, fadeInShape: 'eqp' };
  MixGraph.prototype._clipEnvelope.call({}, g, clip, { offset: 0 }, 10, 2, 0.5);
  assert.deepEqual(calls[0], ['set', 0, 10]);
  const pts = envelopePoints(clip, 0, 2, 0.5);
  assert.equal(calls.length, pts.length);
  calls.slice(1).forEach((c, i) => { assert.equal(c[0], 'ramp'); assert.ok(near(c[1], pts[i + 1].v) && near(c[2], 10 + pts[i + 1].t)); });
  // plain clips keep the old linear envelope (bit-identical renders)
  const c2 = [];
  MixGraph.prototype._clipEnvelope.call({}, { gain: { setValueAtTime: (v, t) => c2.push(['set', v, t]), linearRampToValueAtTime: (v, t) => c2.push(['ramp', v, t]) } }, { gain: 0.5 }, { offset: 0 }, 1, 1, 0.5);
  assert.deepEqual(c2.map((x) => x[0]), ['set', 'ramp', 'set', 'ramp']);
  // a project whose only audio is a comp still has its length
  const { p } = threeTakeTrack();
  assert.equal(songLengthBeats(p), 8);
  assert.equal(defaultEndBeat(p, 'song'), 8);
});
