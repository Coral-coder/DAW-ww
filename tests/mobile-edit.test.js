// Pocket editing logic: Song page (arrange) geometry / clip math, touch automation, code snippets + apply path,
// drum pad sheet mapping, hum analysis worker protocol, drag-reorder, onboarding flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createTrack, createPattern, createClip, createNote } from '../src/core/model.js';
import { Store } from '../src/core/store.js';
import {
  TOP_H, snapStep, snapTo, laneAt, hitClip, moveStart, resizeRight, trimLeft, splitClip, duplicateClip, makeUnique,
  renameClip, clipForTap, markerAt, addMarker, moveMarker, loopHit, dragLoop, pinchTime, followX0, beatToX, xToBeat,
} from '../src/mobile/arrange-core.js';
import { rdp, strokeToPoints, applyStroke, hitPoint, addPoint, movePoint, deletePoint, presetPoints, ensureLane, valueToY, LANE_PAD } from '../src/mobile/auto-core.js';
import { MIXER_TARGETS, valueAt } from '../src/core/automation.js';
import { SNIPPETS, insertSnippet, codeEntries } from '../src/mobile/code-core.js';
import { planSongApply, commitSongApply, isForeignSong, splitCodeIntoTracks, replaceProjectWithCode, songApplySummary } from '../src/code/song-apply.js';
import { padDefs, readPad, writePad, padAutoTarget, editedPads, isSampledKit, drumInstrument } from '../src/mobile/pad-logic.js';
import { targetInfo } from '../src/ui/automation-targets.js';
import { analyzeTake } from '../src/mobile/pitch.js';
import { handleAnalysisMessage, analyzeTakeSliced } from '../src/mobile/hum-analysis.js';
import { reorder, dropIndex, shiftFor } from '../src/mobile/reorder.js';
import { shouldOnboard, markOnboarded, ONBOARD_CARDS } from '../src/mobile/onboarding.js';
import { PAGES, SUBPAGES, parseRoute, neighbour } from '../src/mobile/router.js';

function songProject() {
  const p = createProject();
  const a = createTrack({ name: 'Bass' });
  const b = createTrack({ name: 'Lead' });
  p.tracks.push(a, b);
  const pa = createPattern(a.id, { name: 'Groove', length: 4, notes: [createNote(40, 0, 1)] });
  const pb = createPattern(b.id, { name: 'Hook', length: 8 });
  p.patterns[pa.id] = pa; p.patterns[pb.id] = pb;
  a.activePatternId = pa.id; b.activePatternId = pb.id;
  p.clips.push(createClip(a.id, { patternId: pa.id, start: 0, length: 8 }), createClip(b.id, { patternId: pb.id, start: 4, length: 8 }));
  return { p, a, b, pa, pb };
}

// ------------------------------------------------------------------------------------------- arrange
test('arrange: snap steps, lanes, clip hit-testing with edge zones', () => {
  assert.equal(snapStep('bar', 4), 4);
  assert.equal(snapStep('beat', 4), 1);
  assert.equal(snapStep('off', 4), 0);
  assert.equal(snapTo(5.9, 4), 4);
  assert.equal(snapTo(6.1, 4), 8);
  assert.equal(snapTo(7.9, 4, Math.floor), 4);
  assert.equal(snapTo(3.3, 0), 3.3);
  const { p, a, b } = songProject();
  const v = { ppb: 10, x0: 0, y0: 0, laneH: 60 };
  assert.equal(laneAt(v, TOP_H - 1, 2), -1);
  assert.equal(laneAt(v, TOP_H + 5, 2), 0);
  assert.equal(laneAt(v, TOP_H + 65, 2), 1);
  assert.equal(laneAt(v, TOP_H + 125, 2), -1);
  assert.equal(laneAt({ ...v, y0: 60 }, TOP_H + 5, 2), 1, 'vertical scroll');
  // track 0 clip: beats 0..8 = x 0..80
  const mid = hitClip(p, v, 40, TOP_H + 10);
  assert.equal(mid.track.id, a.id);
  assert.equal(mid.zone, 'body');
  assert.equal(hitClip(p, v, 78, TOP_H + 10).zone, 'right');
  assert.equal(hitClip(p, v, 3, TOP_H + 10).zone, 'left');
  assert.equal(hitClip(p, v, 120, TOP_H + 10), null, 'empty lane space');
  const lead = hitClip(p, v, 60, TOP_H + 70);
  assert.equal(lead.track.id, b.id);
  assert.equal(lead.zone, 'body');
  // a tiny clip: the right (resize) zone wins over trim
  const tiny = { ...p, clips: [createClip(a.id, { patternId: 'x', start: 0, length: 1 })] };
  assert.equal(hitClip(tiny, v, 8, TOP_H + 10).zone, 'right');
});

test('arrange: move / resize / trim math snaps to bars and keeps pattern content in place', () => {
  assert.equal(moveStart(4, 5.2, 4), 8);
  assert.equal(moveStart(4, -1.5, 4), 4, 'snaps back to the nearest bar');
  assert.equal(moveStart(4, -9, 4), 0, 'never before 0');
  assert.equal(moveStart(4, 1.3, 0), 5.3, 'snap off');
  const clip = { type: 'pattern', start: 4, length: 8, offset: 0 };
  assert.equal(resizeRight(clip, 3, 4), 12, 'loop the pattern longer, snapped to the bar');
  assert.equal(resizeRight(clip, -20, 4), 4, 'minimum one bar');
  assert.equal(resizeRight(clip, 0.4, 1), 8);
  const t = trimLeft(clip, 3.8, 4, { patternLength: 4 });
  assert.deepEqual(t, { start: 8, length: 4, offset: 0 }, 'trim a whole bar: offset wraps inside the 4-beat pattern');
  const t2 = trimLeft(clip, 1, 1, { patternLength: 4 });
  assert.deepEqual(t2, { start: 5, length: 7, offset: 1 });
  const t3 = trimLeft(clip, -10, 1, { patternLength: 4 });
  assert.deepEqual(t3, { start: 0, length: 12, offset: 0 }, 'extend left to 0, offset wraps (−4 mod 4)');
  const t4 = trimLeft(clip, 20, 4, { patternLength: 4 });
  assert.equal(t4.length, 4, 'trim never removes the last bar');
  const audio = { type: 'audio', start: 4, length: 4, offset: 1 };
  assert.equal(trimLeft(audio, -3, 1).start, 3, 'audio clips stop at their sample start');
});

test('arrange: split, duplicate, make unique, rename, tap-to-add, markers, loop drag, zoom, follow', () => {
  const { p, a, pa } = songProject();
  const c0 = p.clips[0];
  assert.equal(splitClip(p, c0.id, 0), null, 'no split at the edge');
  const id2 = splitClip(p, c0.id, 6);
  const c2 = p.clips.find((c) => c.id === id2);
  assert.equal(c0.length, 6);
  assert.deepEqual([c2.start, c2.length, c2.offset], [6, 2, 2]);
  const d = duplicateClip(p, c2.id);
  assert.equal(p.clips.find((c) => c.id === d).start, 8);
  const np = makeUnique(p, d);
  assert.notEqual(np, pa.id);
  assert.equal(p.patterns[np].name, 'Groove 2');
  assert.notEqual(p.patterns[np].notes[0].id, pa.notes[0].id);
  renameClip(p, d, 'Fill');
  assert.equal(p.patterns[np].name, 'Fill', 'only user of its pattern: the pattern is renamed');
  renameClip(p, c0.id, 'Intro');
  assert.equal(c0.name, 'Intro', 'shared pattern: the clip gets its own name');
  // tap empty space
  const tap = clipForTap(p, a.id, 13.5, 4, pa.id);
  assert.deepEqual([tap.start, tap.length, tap.patternId], [12, 4, pa.id]);
  assert.equal(clipForTap(p, a.id, 1, 4, pa.id), null, 'occupied');
  p.clips.push(createClip(a.id, { patternId: pa.id, start: 18, length: 4 }));
  assert.equal(clipForTap(p, a.id, 16.2, 4, pa.id).length, 2, 'shortened before the next clip');
  // markers
  const m1 = addMarker(p, 8, 'Drop');
  addMarker(p, 0);
  assert.deepEqual(p.markers.map((m) => m.beat), [0, 8]);
  const v = { ppb: 10, x0: 0 };
  assert.equal(markerAt(p.markers, v, 85)?.id, m1.id, 'flag label to the right of the line');
  assert.equal(markerAt(p.markers, v, 150), null);
  const m0 = p.markers[0];
  moveMarker(p, m0.id, 12);
  assert.deepEqual(p.markers.map((m) => m.id), [m1.id, m0.id], 're-sorted');
  moveMarker(p, m1.id, -2);
  assert.equal(m1.beat, 0, 'clamped at 0');
  // loop
  const loop = { start: 4, end: 12 };
  assert.equal(loopHit(loop, v, 42), 'start');
  assert.equal(loopHit(loop, v, 118), 'end');
  assert.equal(loopHit(loop, v, 80), 'body');
  assert.equal(loopHit(loop, v, 200), null);
  assert.deepEqual(dragLoop(loop, 'body', 5, 4), { start: 8, end: 16 });
  assert.deepEqual(dragLoop(loop, 'end', -20, 4), { start: 4, end: 8 });
  assert.deepEqual(dragLoop(loop, 'start', 30, 4), { start: 8, end: 12 });
  assert.deepEqual(dragLoop(loop, 'new', -6, 4, 9), { start: 4, end: 8 });
  // pinch keeps the beat under the fingers
  const z = pinchTime({ ppb: 10, x0: 0 }, [100, 200], [50, 250]);
  assert.equal(z.ppb, 20);
  assert.ok(Math.abs(xToBeat(z, 150) - 15) < 1e-9);
  // follow playhead flips the page
  assert.equal(followX0({ ppb: 10, x0: 0 }, 20, 300), 0);
  assert.ok(followX0({ ppb: 10, x0: 0 }, 29, 300) > 0);
  assert.ok(beatToX({ ppb: 10, x0: followX0({ ppb: 10, x0: 0 }, 29, 300) }, 29) < 300 * 0.85);
});

// ------------------------------------------------------------------------------------------- automation
test('automation: freehand stroke is thinned, mapped and replaces only its range', () => {
  // a straight line keeps only its ends
  const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 0.5 }));
  assert.deepEqual(rdp(line, 1), [0, 49]);
  // a V keeps the corner
  const vee = [...Array.from({ length: 20 }, (_, i) => ({ x: i, y: i })), ...Array.from({ length: 20 }, (_, i) => ({ x: 20 + i, y: 19 - i }))];
  assert.equal(rdp(vee, 1).length, 3);
  const def = MIXER_TARGETS.volume; // 0..1.5
  const h = 100, view = { ppb: 10, x0: 0 };
  // finger draws from x=0 (bottom) to x=100 (top), wobbling back once (later samples win)
  const stroke = [];
  for (let x = 0; x <= 100; x += 2) stroke.push({ x, y: h - LANE_PAD - (x / 100) * (h - 2 * LANE_PAD) });
  stroke.push({ x: 98, y: LANE_PAD }); // back-track
  const res = strokeToPoints(stroke, { view, h, def });
  assert.ok(res.points.length < 8, `thinned: ${res.points.length}`);
  assert.equal(res.b0, 0);
  assert.equal(res.b1, 10);
  assert.equal(res.points[0].value, 0);
  assert.equal(res.points[res.points.length - 1].value, 1.5);
  const before = [{ beat: -0, value: 0.8 }, { beat: 5, value: 0.1 }, { beat: 20, value: 0.8 }];
  const after = applyStroke(before, res);
  assert.ok(after.some((p) => p.beat === 20), 'outside the stroke kept');
  assert.ok(!after.some((p) => p.beat === 5 && p.value === 0.1), 'inside replaced');
  // snapping folds duplicate beats
  const snapped = strokeToPoints(stroke, { view, h, def, snapBeat: (b) => Math.round(b) });
  assert.equal(new Set(snapped.points.map((p) => p.beat)).size, snapped.points.length);
});

test('automation: tap to add, drag (clamped between neighbours), hit, delete, presets, ensureLane', () => {
  const def = MIXER_TARGETS.pan;
  let pts = [{ beat: 0, value: 0 }, { beat: 8, value: 1 }];
  const r = addPoint(pts, 4, -1);
  assert.equal(r.idx, 1);
  pts = r.points;
  assert.deepEqual(movePoint(pts, 1, 12, 0.5)[1], { beat: 8, value: 0.5 }, 'clamped at the next point');
  assert.deepEqual(movePoint(pts, 1, -3, 0)[1], { beat: 0, value: 0 }, 'clamped at the previous point');
  const geo = { view: { ppb: 10, x0: 0 }, h: 100, def };
  assert.equal(hitPoint(pts, geo, 41, valueToY(def, -1, 100) + 3), 1);
  assert.equal(hitPoint(pts, geo, 200, 50), -1);
  assert.equal(deletePoint(pts, 1).length, 2);
  const ramp = presetPoints(pts, 'up', { b0: 0, b1: 8, def });
  assert.deepEqual(ramp.map((p) => p.value), [-1, 1]);
  assert.equal(presetPoints(pts, 'clear', { b0: 0, b1: 8, def }).length, 0);
  const lfo = presetPoints([], 'sine', { b0: 0, b1: 8, def, periodBeats: 4 });
  assert.ok(lfo.length > 8);
  assert.ok(Math.abs(valueAt(lfo, 2) - 1) < 1e-6, 'sine peaks mid-cycle');
  // lane model: create / find, editing re-enables an overridden lane
  const p = createProject();
  const t = createTrack();
  p.tracks.push(t);
  const lane = ensureLane(p, t.id, 'pan');
  assert.equal(t.automation.length, 1);
  lane.overridden = true;
  assert.equal(ensureLane(p, t.id, 'pan', { reenable: false }).overridden, true);
  assert.equal(ensureLane(p, t.id, 'pan'), lane);
  assert.equal(lane.overridden, undefined);
  assert.equal(ensureLane(p, 'master', 'volume').target, 'volume');
  assert.equal(ensureLane(p, 'nope', 'volume'), null);
});

// ------------------------------------------------------------------------------------------- code
test('code: snippets insert at the cursor, select their placeholder, wrap a selection', () => {
  for (const name of ['s()', 'n()', 'note()', '.lpf()', '.room()', '.delay()', '.fast()', '.slow()', '.every()', 'stack()', 'arrange()']) assert.ok(SNIPPETS.some((s) => s.label === name), name);
  const r = insertSnippet('note("c3")', 10, 10, SNIPPETS.find((s) => s.label === '.lpf()'));
  assert.equal(r.text, 'note("c3").lpf(800)');
  assert.equal(r.text.slice(r.selStart, r.selEnd), '800', 'placeholder selected — type to replace');
  const r2 = insertSnippet('x', 0, 1, '.fast(|2|)');
  assert.equal(r2.text, '.fast(x)', 'selection replaces the placeholder');
  const r3 = insertSnippet('ab', 1, 1, '.rev()|');
  assert.deepEqual(r3, { text: 'a.rev()b', selStart: 7, selEnd: 7 });
  const r4 = insertSnippet('', 5, 9, 'plain');
  assert.deepEqual(r4, { text: 'plain', selStart: 5, selEnd: 5 });
  const p = createProject();
  p.tracks.push(createTrack({ type: 'code', name: 'Beat' }), createTrack());
  assert.deepEqual(codeEntries(p).map((e) => e.label), ['Whole song', 'Beat']);
});

test('code: apply path shared with the desktop (unchanged / foreign / error / edit)', async () => {
  const { loadStrudel } = await import('../src/code/strudel.js');
  await loadStrudel();
  const { songToLiveCode } = await import('../src/code/livecoder.js');
  const { generateSong } = await import('../src/gen/song.js');
  const { PRESETS, DRUM_KITS } = await import('../src/audio/index.js');
  const store = new Store({ ...createProject(), ...generateSong({ genre: 'deep-house', seed: 1 }), mode: 'song' });
  const song = songToLiveCode(store.get());
  const o = { song, presets: PRESETS, kits: DRUM_KITS };
  assert.equal(planSongApply(store.get(), song.code, o).kind, 'unchanged');
  assert.equal(planSongApply(store.get(), 's("bd*4")', o).kind, 'foreign');
  assert.equal(isForeignSong(store.get(), song, song.code), false);
  const edited = song.code.replace(/^(const bass\s+= )n\("[^"]*"/m, '$1n("0*8"');
  assert.notEqual(edited, song.code);
  const plan = planSongApply(store.get(), edited, { ...o, songDraft: edited });
  assert.equal(plan.kind, 'apply', plan.error);
  const undo0 = store.undoStack.length;
  const rep = commitSongApply(store, plan, edited);
  assert.ok(rep.changed);
  assert.equal(store.undoStack.length, undo0 + 1, 'one undo step');
  assert.ok(songApplySummary(rep).length >= 1);
  const bad = song.code.replace(/^(const bass\s+= )n\(/m, '$1n(((');
  assert.equal(planSongApply(store.get(), bad, { ...o, songDraft: bad }).kind, 'error');
  // foreign song: code tracks per block, buses kept
  const text = 'setcpm(30)\n$: s("bd*4")\n$: note("c3 e3").s("sawtooth")';
  const tracks = splitCodeIntoTracks(text);
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every((t) => t.type === 'code' && t.code.includes('setcpm(30)')));
  const buses = store.get().buses;
  store.transact('Replace project with code', (p) => replaceProjectWithCode(p, text, { cps: 0.5 }, tracks));
  assert.equal(store.get().tracks.length, 2);
  assert.equal(store.get().buses, buses);
  assert.equal(store.get().bpm, 120);
});

// ------------------------------------------------------------------------------------------- drum pads
test('pad sheet: defs, read / write mapping and automation targets match the device panel model', () => {
  const t = createTrack({ instrument: { type: 'drums', preset: '808', params: {} } });
  const defs = padDefs(t);
  assert.deepEqual(defs.map((d) => d.key), ['tune', 'decay', 'tone', 'gain', 'pan', 'mute'], 'no variation on a synthesized kit');
  const tune = defs[0];
  assert.equal(readPad(t, 'snare', tune), 0);
  assert.ok(writePad(t, 'snare', 'tune', 3));
  assert.equal(t.instrument.params.pads.snare.tune, 3);
  assert.equal(readPad(t, 'snare', tune), 3);
  assert.ok(editedPads(t).has('snare'));
  assert.ok(!editedPads(t).has('kick'));
  writePad(t, 'kick', 'mute', true);
  assert.equal(readPad(t, 'kick', defs.find((d) => d.key === 'mute')), true);
  // same target strings the desktop automation lanes use
  const p = createProject();
  p.tracks.push(t);
  const info = targetInfo(p, t.id, padAutoTarget('snare', 'tune'));
  assert.equal(info.missing, false);
  assert.equal(info.staticValue, 3);
  // sampled machines get Variation
  const s = createTrack({ instrument: { type: 'drums', params: { machine: 'RolandTR909' } } });
  assert.ok(isSampledKit(drumInstrument(s)));
  assert.ok(padDefs(s).some((d) => d.key === 'variant'));
  assert.deepEqual(padDefs(createTrack()), [], 'not a drum track');
  assert.equal(writePad(createTrack(), 'kick', 'tune', 1), false);
});

// ------------------------------------------------------------------------------------------- hum worker
function hummed(sr = 16000) {
  const notes = [[57, 0.3], [60, 0.3], [64, 0.4]];
  const total = notes.reduce((s, n) => s + n[1] + 0.08, 0.1);
  const out = new Float32Array(Math.ceil(total * sr));
  let t = 0.1;
  for (const [m, dur] of notes) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const i0 = Math.floor(t * sr), n = Math.floor(dur * sr);
    for (let i = 0; i < n; i++) out[i0 + i] = 0.4 * Math.sin((2 * Math.PI * f * i) / sr) * Math.min(1, i / 200, (n - i) / 200);
    t += dur + 0.08;
  }
  return out;
}

test('hum worker protocol: progress then a result identical to the main-thread analysis', async () => {
  const sr = 16000;
  const samples = hummed(sr);
  const direct = analyzeTake(samples, sr);
  assert.equal(direct.length, 3);
  const msgs = [];
  handleAnalysisMessage({ type: 'analyze', id: 7, samples: new Float32Array(samples), sampleRate: sr, opts: {} }, (m) => msgs.push(structuredClone(m)));
  const prog = msgs.filter((m) => m.type === 'progress');
  const res = msgs.filter((m) => m.type === 'result');
  assert.ok(prog.length >= 2, 'reports progress');
  assert.ok(prog.every((m, i) => m.id === 7 && m.p >= 0 && m.p <= 1 && (i === 0 || m.p >= prog[i - 1].p)), 'monotonic');
  assert.equal(prog[prog.length - 1].p, 1);
  assert.equal(res.length, 1);
  assert.equal(msgs[msgs.length - 1].type, 'result');
  assert.deepEqual(res[0].notes, direct, 'identical to the main-thread path');
  // ignores other messages; errors are reported, not thrown
  const none = [];
  handleAnalysisMessage({ type: 'ping' }, (m) => none.push(m));
  assert.equal(none.length, 0);
  const err = [];
  handleAnalysisMessage({ type: 'analyze', id: 1, samples: null, sampleRate: sr }, (m) => err.push(m));
  assert.equal(err[err.length - 1].type, 'error');
  // the sliced main-thread fallback gives the same notes too
  const ps = [];
  const sliced = await analyzeTakeSliced(samples, sr, { onProgress: (p) => ps.push(p), sliceMs: 1, yieldFn: (r) => setImmediate(r) });
  assert.deepEqual(sliced, direct);
  assert.equal(ps[ps.length - 1], 1);
});

// ------------------------------------------------------------------------------------------- reorder / onboarding / routes
test('reorder: array move, drop index from the dragged row centre, neighbour shifts', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b'], 5, 0), ['a', 'b']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
  const rows = [0, 1, 2, 3].map((i) => ({ top: i * 50, height: 50 }));
  assert.equal(dropIndex(rows, 0, 25), 0);
  assert.equal(dropIndex(rows, 0, 80), 1);
  assert.equal(dropIndex(rows, 0, 130), 2);
  assert.equal(dropIndex(rows, 3, 60), 1);
  assert.equal(dropIndex(rows, 3, -10), 0);
  assert.equal(shiftFor(1, 0, 2, 50), -50);
  assert.equal(shiftFor(3, 0, 2, 50), 0);
  assert.equal(shiftFor(1, 3, 1, 50), 50);
});

test('onboarding is shown once and survives blocked storage; new routes', () => {
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(shouldOnboard(st), true);
  markOnboarded(st);
  assert.equal(shouldOnboard(st), false);
  assert.equal(shouldOnboard({ getItem: () => { throw new Error('blocked'); } }), false);
  assert.equal(ONBOARD_CARDS.length, 3);
  assert.ok(PAGES.some((p) => p.id === 'arrange'));
  assert.deepEqual(parseRoute('#/arrange'), { page: 'arrange' });
  assert.deepEqual(parseRoute('#/code'), { page: 'code' });
  assert.equal(SUBPAGES.code.parent, 'arrange');
  assert.equal(neighbour('tracks', 1), 'arrange');
});
