// Pro mixer structure: groups (relative / absolute), VCAs (dB sum, automation multiply), solo logic (SIP / AFL / PFL,
// solo-safe, exclusive), folders, snapshots, sidechain routing graph and the engine graph (mock Web Audio).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGroup, applyLinkedEdit, linkedIds, groupSelection, linkChannels, createVca, vcaGainFor, vcaDb, vcaGainAt, vcaCombinedLane,
  memberGainAt, soloState, isAudible, toggleSolo, createFolder, setFolderSum, trackRows, visibleTrackIds, setTrackFolder, removeFolder,
  saveSnapshot, recallMixerState, resetMixer, inputGain, widthMatrix, sendTap, outputOf, busesFedBy, mixerOf, ensureMixer,
} from '../src/core/mixer-model.js';
import { resolveKeyLinks, canKey, keyRequests } from '../src/core/patch.js';
import { isTrackAudible } from '../src/audio/scheduler.js';
import { createProject, createTrack, createEffect, createBus } from '../src/core/model.js';
import { createAutomationLane, automationOwner, hasAutomation } from '../src/core/automation.js';
import { MixGraph } from '../src/audio/mixer.js';
import { MockContext, impulseResponse, latentEffectFactory } from './lib/mock-audio.js';

const db = (g) => 20 * Math.log10(g);
const near = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

function proj(n = 4) {
  const p = createProject();
  p.tracks = Array.from({ length: n }, (_, i) => createTrack({ name: `T${i}`, volume: 0.5 + i * 0.1 }));
  return p;
}

test('groups: relative volume moves every member by the same dB; absolute sets all; switches always absolute', () => {
  const p = proj();
  const [a, b, c, d] = p.tracks;
  const g = createGroup(p, 'Drums', [a.id, b.id, c.id]);
  c.volume = 0; // at −∞: stays there in relative mode
  const before = db(b.volume);
  applyLinkedEdit(p, a.id, 'volume', a.volume * 2); // +6.02 dB
  near(db(b.volume) - before, db(2), 1e-4, 'relative dB delta');
  assert.equal(c.volume, 0);
  assert.equal(d.volume, 0.8); // not a member
  applyLinkedEdit(p, a.id, 'pan', 0.3);
  assert.equal(b.pan, 0); // group doesn't link pan by default
  g.link.pan = true;
  applyLinkedEdit(p, a.id, 'pan', 0.5);
  near(b.pan, 0.2, 1e-9, 'relative pan offset');
  applyLinkedEdit(p, a.id, 'mute', true);
  assert.ok(a.mute && b.mute && c.mute && !d.mute);
  g.mode = 'absolute';
  applyLinkedEdit(p, b.id, 'volume', 0.42);
  assert.ok(a.volume === 0.42 && b.volume === 0.42 && c.volume === 0.42);
  // bypass (Alt) edits only the one channel; disabled groups don't link
  applyLinkedEdit(p, a.id, 'volume', 0.1, { bypass: true });
  assert.equal(b.volume, 0.42);
  g.enabled = false;
  applyLinkedEdit(p, a.id, 'volume', 0.2);
  assert.equal(b.volume, 0.42);
  // transitive membership + selection link
  g.enabled = true;
  createGroup(p, 'Other', [c.id, d.id]);
  assert.deepEqual(new Set(linkedIds(p, a.id, 'mute')), new Set([a.id, b.id, c.id, d.id]));
  assert.deepEqual(new Set(groupSelection(p, d.id)), new Set([a.id, b.id, c.id, d.id]));
  const l = linkChannels(p, [a.id, d.id]);
  assert.equal(l.mode, 'absolute');
});

test('VCA: levels add in dB, mute → 0, automation multiplies with member automation', () => {
  const p = proj(2);
  const [a, b] = p.tracks;
  const v1 = createVca(p, 'All', [a.id, b.id], { volume: Math.pow(10, -6 / 20) });
  const v2 = createVca(p, 'A', [a.id], { volume: Math.pow(10, 3 / 20) });
  near(vcaDb(p, a.id), -3, 1e-9, 'dB sum');
  near(vcaDb(p, b.id), -6, 1e-9);
  assert.equal(vcaGainFor(p, 'nobody'), 1);
  v2.mute = true;
  assert.equal(vcaGainFor(p, a.id), 0);
  assert.equal(vcaDb(p, a.id), -Infinity);
  v2.mute = false;
  // VCA automation (lane on the VCA) × member fader automation
  v1.automation = [createAutomationLane('volume', [{ beat: 0, value: 1 }, { beat: 8, value: 0.5 }])];
  a.automation = [createAutomationLane('volume', [{ beat: 0, value: 0.8 }, { beat: 8, value: 0.4 }])];
  near(vcaGainAt(p, a.id, 4), 0.75 * Math.pow(10, 3 / 20), 1e-9, 'vca at beat 4');
  near(memberGainAt(p, a, 4, 0.6), 0.6 * 0.75 * Math.pow(10, 3 / 20), 1e-9, 'member × vca');
  const lane = vcaCombinedLane(p, a.id);
  assert.deepEqual(lane.points.map((x) => x.beat), [0, 8]);
  near(lane.points[1].value, 0.5 * Math.pow(10, 3 / 20), 1e-9);
  assert.equal(vcaCombinedLane(p, 'nobody'), null);
  // VCAs are automation owners (lanes drawn / recorded / rendered like any other)
  assert.equal(automationOwner(p, v1.id), v1);
  const q = proj(1);
  createVca(q, 'V', [q.tracks[0].id]).automation = [createAutomationLane('volume', [{ beat: 0, value: 1 }])];
  assert.ok(hasAutomation(q));
});

test('solo: SIP mutes the others (solo-safe exempt), AFL / PFL never touch the main mix, exclusive solo', () => {
  const p = proj(3);
  const [a, b, c] = p.tracks;
  a.solo = true;
  c.soloSafe = true;
  assert.ok(isAudible(p, a) && !isAudible(p, b) && isAudible(p, c));
  assert.equal(isTrackAudible(p, b), false);
  assert.deepEqual(soloState(p).cue, []);
  ensureMixer(p).soloMode = 'afl';
  assert.ok(isAudible(p, b));
  assert.deepEqual(soloState(p).cue, [{ id: a.id, tap: 'post' }]);
  p.mixer.soloMode = 'pfl';
  assert.deepEqual(soloState(p).cue, [{ id: a.id, tap: 'pre' }]);
  b.mute = true;
  assert.equal(isAudible(p, b), false);
  p.mixer.soloMode = 'sip';
  b.mute = false;
  toggleSolo(p, b.id, { exclusive: true });
  assert.deepEqual(p.tracks.map((t) => !!t.solo), [false, true, false]);
  toggleSolo(p, b.id, { exclusive: true }); // again: unsolo all
  assert.deepEqual(p.tracks.map((t) => !!t.solo), [false, false, false]);
  createGroup(p, 'G', [a.id, b.id]);
  toggleSolo(p, a.id);
  assert.ok(a.solo && b.solo && !c.solo);
});

test('folders: rows, collapse, summing bus routing; sends pre/post; outputs', () => {
  const p = proj(4);
  const [a, b, c, d] = p.tracks;
  const f = createFolder(p, 'Drums', [b.id, d.id]);
  assert.deepEqual(p.tracks.map((t) => t.name), ['T0', 'T1', 'T3', 'T2']); // members contiguous
  const rows = trackRows(p);
  assert.deepEqual(rows.map((r) => r.kind), ['track', 'folder', 'track', 'track', 'track']);
  f.collapsed = true;
  assert.deepEqual(visibleTrackIds(p), [a.id, c.id]);
  const bus = setFolderSum(p, f.id, true);
  assert.equal(bus.folderId, f.id);
  assert.equal(outputOf(p, b), bus.id);
  assert.equal(outputOf(p, a), 'master');
  setTrackFolder(p, a.id, f.id);
  assert.equal(a.output, bus.id);
  setTrackFolder(p, a.id, null);
  assert.equal(a.output, undefined);
  a.sends = { [p.buses[0].id]: 0.3 };
  a.sendModes = { [p.buses[0].id]: 'pre' };
  assert.equal(sendTap(a, p.buses[0].id), 'pre');
  assert.equal(sendTap(a, 'x'), 'post');
  assert.deepEqual(busesFedBy(p, b), [bus.id]);
  removeFolder(p, f.id);
  assert.equal(p.buses.some((x) => x.id === bus.id), false);
  assert.equal(b.output, undefined);
  assert.equal(b.folderId, undefined);
  assert.equal(mixerOf(p).folders.length, 0);
});

test('snapshots, reset, input stage, width matrix', () => {
  const p = proj(2);
  const [a] = p.tracks;
  a.fx = [createEffect('eq3', { low: 2 })];
  const s = saveSnapshot(p, 'Verse');
  a.volume = 1.2; a.pan = -0.5; a.mute = true; a.fx[0].params.low = -6; a.fx[0].enabled = false;
  recallMixerState(p, s.state, { fx: false });
  assert.ok(a.volume === 0.5 && a.pan === 0 && a.mute === false);
  assert.equal(a.fx[0].params.low, -6);
  recallMixerState(p, s.state);
  assert.equal(a.fx[0].params.low, 2);
  assert.equal(a.fx[0].enabled, true);
  a.trim = 6; a.phase = true; a.width = 0;
  resetMixer(p);
  assert.ok(a.volume === 0.8 && a.trim === undefined && !a.phase);
  near(inputGain({ trim: 6, phase: true }), -Math.pow(10, 6 / 20));
  assert.deepEqual(widthMatrix(0), { ll: 0.5, rl: 0.5, lr: 0.5, rr: 0.5 });
  assert.deepEqual(widthMatrix(1), { ll: 1, rl: 0, lr: 0, rr: 1 });
});

test('sidechain routing graph: compressor / gate / ducker keys from tracks or buses; loops through sends are refused', () => {
  const p = createProject();
  const kick = createTrack({ name: 'Kick' });
  const bass = createTrack({ name: 'Bass' });
  const pad = createTrack({ name: 'Pad' });
  p.tracks = [kick, bass, pad];
  const rev = p.buses[0];
  bass.fx = [createEffect('compressor', { sourceTrackId: kick.id })];
  pad.fx = [createEffect('gate', { sourceTrackId: kick.id }), createEffect('ducker', { sourceTrackId: rev.id })];
  pad.sends = { [rev.id]: 0.4 }; // pad feeds the reverb → the reverb can't key the pad
  kick.fx = [createEffect('ducker', { sourceTrackId: rev.id })]; // kick doesn't feed the reverb: fine
  rev.fx.push(createEffect('compressor', { sourceTrackId: bass.id }));
  assert.equal(keyRequests(p).length, 5);
  const links = resolveKeyLinks(p);
  assert.equal(links.get(bass.fx[0].id), kick.id);
  assert.equal(links.get(kick.fx[0].id), rev.id);
  // kick → (key) pad → (send) reverb → (key) kick would loop: the pad's gate key is dropped
  assert.equal(links.has(pad.fx[0].id), false);
  assert.equal(links.has(pad.fx[1].id), false);
  assert.equal(links.has(rev.fx[1].id), false); // bass → rev → kick → bass would loop through the keys
  assert.equal(canKey(p, pad.id, rev.id), false);
  assert.equal(canKey(p, bass.id, rev.id), true);
  assert.equal(canKey(p, rev.id, bass.id), false);
  // a bus-routed track (folder sum) also counts as feeding the bus
  const t = createTrack({ name: 'Routed' });
  t.output = rev.id;
  p.tracks.push(t);
  assert.equal(canKey(p, t.id, rev.id), false);
});

// ----------------------------------------------------------------------------------------------- engine graph (mock)
function graphFor(p) {
  const ctx = new MockContext({ sampleRate: 48000 });
  const g = new MixGraph(ctx, { destination: ctx.destination, getBpm: () => 120, getBeatAt: () => 0, getSampleBuffer: () => null, createEffect: latentEffectFactory(() => 0), meters: true });
  g.sync(p);
  return { ctx, g };
}
const gainTo = (from, to, sr = 48000) => [...impulseResponse(from, to, sr).values()].reduce((a, b) => a + b, 0);

test('MixGraph: VCA scales the member, trim / phase, pre-fader sends ignore the fader, folder bus routing, AFL cue', () => {
  const p = createProject();
  p.master.fx = [];
  const a = createTrack({ name: 'A', type: 'audio', volume: 0.5 });
  const b = createTrack({ name: 'B', type: 'audio', volume: 0.5 });
  p.tracks = [a, b];
  const rev = p.buses[0];
  a.sends = { [rev.id]: 0.25 };
  a.sendModes = { [rev.id]: 'pre' };
  createVca(p, 'V', [a.id], { volume: 0.5 });
  a.trim = 6; a.phase = true;
  const { ctx, g } = graphFor(p);
  const sa = g.tracks.get(a.id).strip;
  // direct: trim(-2) × fader 0.5 × vca 0.5 → master input
  near(gainTo(sa.input, sa.direct), -Math.pow(10, 6 / 20) * 0.25, 1e-9, 'direct');
  // pre-fader send: trim × 0.25, independent of fader and VCA
  near(gainTo(sa.input, g.buses.get(rev.id).input), -Math.pow(10, 6 / 20) * 0.25, 1e-9, 'pre send');
  p.tracks[0] = { ...a, volume: 1 };
  g.sync(p);
  near(gainTo(sa.input, g.buses.get(rev.id).input), -Math.pow(10, 6 / 20) * 0.25, 1e-9, 'pre send after fader move');
  // folder summing bus: B routes into it instead of the master
  const f = createFolder(p, 'F', [b.id]);
  const bus = setFolderSum(p, f.id, true, () => createBus('F'));
  g.sync(p);
  const sb = g.tracks.get(b.id).strip;
  near(gainTo(sb.input, g.buses.get(bus.id).input), 0.5, 1e-9, 'into folder bus');
  near(gainTo(sb.input, g.master.input), 0.5 * 0.8, 1e-9, 'through the folder bus fader');
  // AFL: soloing B routes it to the cue bus; the main mix keeps A
  ensureMixer(p).soloMode = 'afl';
  p.tracks[1].solo = true;
  g.sync(p);
  assert.equal(g.cueActive, true);
  near(gainTo(sb.input, g.cue), 0.5, 1e-9, 'cue post-fader');
  near(gainTo(sa.input, sa.direct), -Math.pow(10, 6 / 20) * 0.5, 1e-9, 'main mix untouched');
  assert.equal(g.monitor.gain.value, 0);
  p.tracks[1].solo = false;
  g.sync(p);
  assert.equal(g.cueActive, false);
  assert.equal(g.monitor.gain.value, 1);
  void ctx;
});
