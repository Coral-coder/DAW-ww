// "Split into tracks" import (src/code/import-split.js): any Strudel code -> one track per instrument, with its
// effects (inserts / sends / mixer), automation lanes for controls that move, clips per arrange() section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadStrudel, codeEngine, splitTopLevel, evaluate, queryEvents } from '../src/code/strudel.js';
import { analyzeStrudel, splitStrudelToProject, splitCodeByLabels, importStrudelSplit, summaryText } from '../src/code/import-split.js';
import { createProject, DRUM_PITCH } from '../src/core/model.js';
import { parseTarget, valueAt } from '../src/core/automation.js';
import { Store } from '../src/core/store.js';

if (!(await loadStrudel()) || codeEngine() !== 'strudel') throw new Error('vendored Strudel engine failed to load');

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/strudel-split/${name}.strudel`, import.meta.url), 'utf8');
const split = (code, opts) => {
  const p = createProject();
  const s = splitStrudelToProject(p, code, opts);
  assert.equal(s.error, undefined, s.error);
  return { p, s, track: (name) => p.tracks.find((t) => t.name === name) };
};
const fxOf = (t, type) => t.fx.filter((f) => f.type === type);
const laneOf = (t, pred) => t.automation.find((l) => pred(parseTarget(l.target), l));
const clipsOf = (p, t) => p.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
const notesOf = (p, t) => clipsOf(p, t).flatMap((c) => p.patterns[c.patternId].notes);

test('house sketch: one track per instrument named from the code, drum kit on one track with pads', () => {
  const { p, s, track } = split(fixture('house'));
  const names = p.tracks.filter((t) => t.type === 'instrument').map((t) => t.name);
  assert.deepEqual(names, ['drums', 'bass', 'stabs', 'pad', 'lead', 'arp', 'fx', 'percussion', 'sub', 'counter', 'vocal chops', 'texture', 'impacts']);
  assert.equal(p.bpm, 124);
  assert.equal(s.bars, 200);
  assert.deepEqual(p.key, { root: 0, scale: 'minor' }); // .scale("C2:minor") …
  assert.ok(s.notes.some((n) => /pluck-bass/.test(n)) && s.notes.some((n) => /shaker/.test(n)), s.notes.join('\n'));
  // the drum kit: ONE track, sampled TR-909, pads mapped from the drum names
  const drums = track('drums');
  assert.equal(drums.instrument.type, 'drums');
  assert.equal(drums.instrument.params.machine, 'RolandTR909');
  const pitches = new Set(notesOf(p, drums).map((n) => n.pitch));
  for (const k of ['kick', 'clap', 'rim', 'openhat', 'hihat', 'shaker']) assert.ok(pitches.has(DRUM_PITCH[k]), k);
  // the hats play at gain .4 -> pad level; the perlin-gain shaker -> varying note velocities (not automation)
  assert.ok(Math.abs(drums.instrument.params.pads.hihat.gain / drums.instrument.params.pads.kick.gain - 0.5) < 0.02);
  const shakerVels = new Set(notesOf(p, drums).filter((n) => n.pitch === DRUM_PITCH.shaker).map((n) => n.vel));
  assert.ok(shakerVels.size > 10, 'shaker velocities vary');
  assert.ok(!drums.automation.some((l) => l.target === 'volume'));
  // a melodic source = a 'strudel' instrument with the code's synth controls
  const stabs = track('stabs');
  assert.equal(stabs.instrument.type, 'strudel');
  assert.equal(stabs.instrument.params.s, 'sawtooth');
  assert.equal(stabs.instrument.params.lpenv, 2.5);
  assert.equal(stabs.instrument.params.resonance, 3);
  assert.ok(stabs.instrument.fallbackPreset);
  // a daW³ preset name (.s("pluck-bass")) -> its Strudel patch
  assert.equal(track('bass').instrument.preset, 'sd-pluck-bass');
  assert.equal(track('lead').instrument.params.s, 'piano');
  assert.equal(track('impacts').instrument.params.machine, 'RolandR8');
  // the original code is kept (muted code track + project.importedCode)
  const orig = p.tracks.find((t) => t.type === 'code');
  assert.ok(orig.mute && orig.code.includes('arrange('));
  assert.equal(p.importedCode.code, orig.code);
  assert.equal(p.importedCode.original, fixture('house')); // (nothing to repair: the same text)
});

test('house sketch: effects, sends and automation lanes', () => {
  const { p, s, track } = split(fixture('house'));
  // the intro's saw-swept low-pass on the drums -> filter insert + cutoff automation (opens up, then stays open)
  const drums = track('drums');
  const [lp] = fxOf(drums, 'filter');
  assert.equal(lp.params.type, 'lowpass');
  const cut = laneOf(drums, (t) => t?.kind === 'fx' && t.fxId === lp.id && t.key === 'cutoff');
  assert.ok(cut, 'cutoff lane');
  const vals = cut.points.map((x) => x.value);
  assert.ok(Math.min(...vals) < 500 && Math.max(...vals) > 10000, `sweep ${Math.min(...vals)}..${Math.max(...vals)}`);
  assert.ok(cut.points.length < 40, `thinned (${cut.points.length} points)`);
  const at = (beat) => valueAt(cut.points, beat);
  assert.ok(at(2) < 1000 && at(14 * 4) > 5000 && at(40 * 4) > 15000);
  // constant controls -> static inserts: sub .lpf(400), vocal chops .lpf(3200) + .hpf(250), lead .hpf(180)
  assert.equal(fxOf(track('sub'), 'filter')[0].params.cutoff, 400);
  const vc = fxOf(track('vocal chops'), 'filter');
  assert.deepEqual(vc.map((f) => [f.params.type, f.params.cutoff]), [['lowpass', 3200], ['highpass', 250]]);
  assert.ok(fxOf(track('lead'), 'filter').some((f) => f.params.type === 'highpass' && f.params.cutoff === 180));
  // filter envelope parts keep their cutoff in the synth; the section sweeps automate it (inst:lpf)
  assert.ok(laneOf(track('stabs'), (t) => t?.kind === 'inst' && t.key === 'lpf'));
  // room -> Reverb bus send (amount = room, size -> decay), delay -> tempo-synced Delay bus send
  const pad = track('pad');
  const rv = Object.entries(pad.sends).map(([id, amt]) => [p.buses.find((b) => b.id === id), amt]).find(([b]) => b.fx[0].type === 'reverb');
  assert.equal(rv[1], 0.4);
  const stabs = track('stabs');
  const dl = Object.entries(stabs.sends).map(([id, amt]) => [p.buses.find((b) => b.id === id), amt]).find(([b]) => b.fx[0].type === 'delay');
  assert.equal(dl[1], 0.2);
  assert.equal(dl[0].fx[0].params.sync, true);
  // .gain(.6) in the breakdown -> a volume lane on the pad (section levels, not per-note jitter)
  const vol = laneOf(pad, (t) => t?.kind === 'volume');
  assert.ok(vol && Math.min(...vol.points.map((x) => x.value)) < Math.max(...vol.points.map((x) => x.value)) * 0.8);
  assert.ok(s.lanes >= 5 && s.effects >= 6 && s.sends >= 8);
  assert.match(summaryText(s), /13 tracks .* 200 bars at 124 BPM .* 12 sections/);
});

test('house sketch: clips follow the arrangement (markers, reused patterns, silent sections have no clip)', () => {
  const { p, track } = split(fixture('house'));
  assert.deepEqual(p.markers.map((m) => [m.beat / 4, m.name]), [[0, 'intro'], [16, 'intro 2'], [32, 'groove'], [48, 'breakdown'], [64, 'build'],
    [72, 'drop'], [104, 'groove 2'], [120, 'breakdown 2'], [128, 'build 2'], [136, 'drop 2'], [168, 'outro'], [184, 'outro 2']]);
  assert.equal(p.mode, 'song');
  // bass plays in intro 2, groove, drop, groove 2, drop 2, outro
  const bass = track('bass');
  assert.deepEqual(clipsOf(p, bass).map((c) => [c.start / 4, c.length / 4]), [[16, 16], [32, 16], [72, 32], [104, 16], [136, 32], [168, 16]]);
  // identical content -> one reused, looped pattern (the bass line repeats every 4 bars)
  const pats = new Set(clipsOf(p, bass).map((c) => c.patternId));
  assert.equal(pats.size, 1);
  assert.equal(p.patterns[[...pats][0]].length, 16);
  // the lead is silent until the breakdown; the pad is masked out of the intro
  assert.equal(clipsOf(p, track('lead'))[0].start, 48 * 4);
  assert.ok(!clipsOf(p, track('pad')).some((c) => c.start < 48 * 4));
  // melodic pitches from n()+scale(): the bass sits in octave 2 of C minor
  const bassPitches = notesOf(p, bass).map((n) => n.pitch);
  assert.ok(bassPitches.every((x) => x >= 36 && x < 60));
});

test('tech-house sketch: tracks, kit, sections', () => {
  const { p, s, track } = split(fixture('tech-house'));
  assert.equal(p.bpm, 125);
  assert.equal(s.sections, 13);
  assert.deepEqual(p.tracks.filter((t) => t.type === 'instrument').map((t) => t.name).slice(0, 6), ['drums', 'bass', 'stabs', 'pad', 'lead', 'arp']);
  const drums = track('drums');
  assert.equal(drums.instrument.type, 'drums');
  const pitches = new Set(notesOf(p, drums).map((n) => n.pitch));
  assert.ok(pitches.has(DRUM_PITCH.conga) && pitches.has(DRUM_PITCH.shaker));
  // FM bass: fm controls in the patch
  assert.equal(track('bass').instrument.params.fm, 2.5);
  assert.equal(track('bass').instrument.params.s, 'sine');
  // the drums' low-pass sweep only in the intros
  assert.ok(laneOf(drums, (t) => t?.kind === 'fx' && t.key === 'cutoff'));
});

test('a live coder–style: setcpm, register(), slider(), duck -> sidechain ducker keyed by the kick', () => {
  const { p, s, track } = split(fixture('live-helpers'));
  assert.equal(p.bpm, 140);
  assert.deepEqual(p.tracks.filter((t) => t.type === 'instrument').map((t) => t.name), ['Kick', 'Drums', 'Sawtooth bass', 'Supersaw chords']);
  const kick = track('Kick');
  for (const name of ['Sawtooth bass', 'Supersaw chords']) {
    const [d] = fxOf(track(name), 'ducker');
    assert.ok(d, `${name} ducks`);
    assert.equal(d.params.sourceTrackId, kick.id);
    assert.equal(d.params.amount, 0.8);
  }
  assert.equal(fxOf(track('Drums'), 'ducker').length, 0);
  // register('acidenv') + slider(): resolved by the real engine into synth controls
  const acid = track('Sawtooth bass').instrument.params;
  assert.equal(acid.lpf, 100);
  assert.ok(Math.abs(acid.lpenv - 5.4) < 1e-6);
  assert.equal(acid.resonance, 12);
  // .lpf(slider(2400…)) -> static filter insert; gain .45 -> track volume; room .6 size 6 -> large reverb
  const sup = track('Supersaw chords');
  assert.equal(fxOf(sup, 'filter')[0].params.cutoff, 2400);
  assert.equal(sup.volume, 0.45);
  const [rid, ramt] = Object.entries(sup.sends)[0];
  assert.equal(ramt, 0.6);
  assert.ok(p.buses.find((b) => b.id === rid).fx[0].params.decay >= 6);
  // delay .25 with the default delaysync (3/16 cycle) -> dotted 8th
  const [did] = Object.keys(track('Sawtooth bass').sends);
  assert.equal(p.buses.find((b) => b.id === did).fx[0].params.division, '1/8D');
  assert.equal(s.bars, 4);
});

test('a single $: stack(...) becomes one track per instrument', () => {
  const { p, track } = split(fixture('simple-stack'));
  assert.equal(p.bpm, 120);
  const inst = p.tracks.filter((t) => t.type === 'instrument');
  assert.equal(inst.length, 3);
  const drums = inst.find((t) => t.instrument.type === 'drums');
  assert.equal(drums.instrument.params.machine, 'RolandTR808');
  assert.deepEqual([...new Set(notesOf(p, drums).map((n) => n.pitch))].sort(), [DRUM_PITCH.kick, DRUM_PITCH.snare, DRUM_PITCH.hihat].sort());
  const saw = track('Sawtooth bass');
  assert.deepEqual(fxOf(saw, 'filter').map((f) => [f.params.cutoff, f.params.resonance]), [[800, 4]]);
  assert.deepEqual(notesOf(p, saw).slice(0, 4).map((n) => n.pitch), [36, 39, 43, 46]);
  const ep = track('Epiano1 chords');
  assert.equal(ep.instrument.params.s, 'gm_epiano1');
  assert.equal(ep.pan, -0.4);
  assert.equal(Object.values(ep.sends)[0], 0.4);
  // a 2-cycle loop -> a 4-bar loop region, chords alternate
  assert.deepEqual([p.loop.enabled, p.loop.end], [true, 16]);
  assert.equal(p.patterns[clipsOf(p, ep)[0].patternId].length, 8);
});

test('multiple labels: names from the labels, moving pan / filter -> automation, saturator + bitcrusher', () => {
  const { p, track } = split(fixture('labels'));
  assert.deepEqual(p.tracks.filter((t) => t.type === 'instrument').map((t) => t.name), ['kick', 'hats', 'bass', 'lead']);
  assert.equal(track('kick').instrument.params.machine, 'RolandTR707');
  const hats = track('hats');
  assert.ok(laneOf(hats, (t) => t?.kind === 'pan'), 'sine pan -> pan lane');
  assert.equal(hats.volume, 0.5);
  assert.ok(new Set(notesOf(p, hats).map((n) => n.vel)).size === 2, '.gain(".5 .3") -> two velocities');
  const bass = track('bass');
  const [lp] = fxOf(bass, 'filter');
  const lane = laneOf(bass, (t) => t?.kind === 'fx' && t.fxId === lp.id);
  const vs = lane.points.map((x) => x.value);
  assert.ok(Math.min(...vs) < 400 && Math.max(...vs) > 2500);
  // .delay(.3).delaytime(.375) at 120 BPM = 3/4 beat -> synced 1/8 dotted
  const bus = p.buses.find((b) => b.id === Object.keys(bass.sends)[0]);
  assert.equal(bus.fx[0].params.division, '1/8D');
  const lead = track('lead');
  assert.deepEqual(lead.fx.map((f) => f.type), ['saturator', 'bitcrusher']);
  assert.equal(fxOf(lead, 'bitcrusher')[0].params.bits, 6);
});

test('analysis: loop detection, errors, and code tracks split by labels', () => {
  assert.equal(analyzeStrudel('$: s("bd*4")').cycles, 4);
  assert.equal(analyzeStrudel('$: note("<c e g b>").s("sine")').cycles, 4);
  assert.equal(analyzeStrudel('$: s("hh*8").lpf(saw.range(300, 3000).slow(16))').cycles, 16);
  assert.match(analyzeStrudel('$: s("bd"').error, /Unexpected/);
  const p = createProject();
  assert.match(splitStrudelToProject(p, '// nothing').error, /no notes/);
  const parts = splitCodeByLabels(fixture('labels'), splitTopLevel);
  assert.deepEqual(parts.map((x) => x.name), ['kick', 'hats', 'bass', 'lead']);
  assert.ok(parts.every((x) => x.code.startsWith('setcpm(120/4)')));
});

test('importStrudelSplit: one undo step that replaces the project', async () => {
  const store = new Store(createProject());
  const before = store.get().tracks.length;
  const s = await importStrudelSplit(store, fixture('simple-stack'));
  assert.equal(s.error, undefined);
  assert.equal(store.get().tracks.length, 4);
  store.undo();
  assert.equal(store.get().tracks.length, before);
});

// ------------------------------------------------------------------------------------------------ accuracy

/** Notes a track plays over the timeline (clips loop their pattern). */
const timelineCount = (p, t) => clipsOf(p, t).reduce((n, c) => {
  const pat = p.patterns[c.patternId];
  for (let o = 0; o < c.length; o += pat.length) n += pat.notes.filter((x) => o + x.start < c.length - 1e-6).length;
  return n;
}, 0);
const sounding = (v) => v.s !== undefined || v.note !== undefined || v.freq !== undefined || v.n !== undefined;
/** Raw haps of the code as Strudel plays it (the importer's repaired code), per sound. */
function rawCounts(a) {
  const res = evaluate(a.playedCode);
  const by = new Map();
  for (let c = 0; c < a.cycles; c += 16) for (const e of queryEvents(res, c, Math.min(a.cycles, c + 16))) if (sounding(e.value)) by.set(String(e.value.s), (by.get(String(e.value.s)) || 0) + 1);
  return by;
}
/** Every part plays, no note is lost (per sound), every track's timeline has exactly its notes. */
function assertComplete(code) {
  const a = analyzeStrudel(code);
  assert.equal(a.error, undefined, a.error);
  const p = createProject();
  const s = splitStrudelToProject(p, a);
  assert.equal(s.error, undefined, s.error);
  for (const part of s.parts) assert.notEqual(part.status, 'silent', `part "${part.label}" (${part.code}) made no track`);
  const raw = rawCounts(a);
  const got = new Map();
  for (const t of a.tracks) for (const h of t.haps) got.set(String(h.v.s), (got.get(String(h.v.s)) || 0) + 1);
  assert.deepEqual(Object.fromEntries([...got].sort()), Object.fromEntries([...raw].sort()), 'notes per sound');
  const inst = p.tracks.filter((t) => t.type === 'instrument');
  assert.equal(inst.length, a.tracks.length);
  a.tracks.forEach((t, i) => assert.equal(timelineCount(p, inst[i]), t.haps.length, `${t.name}: timeline notes`));
  return { a, p, s, track: (name) => inst.find((t) => t.name === name), names: inst.map((t) => t.name) };
}
const sendOf = (p, t, type) => {
  const e = Object.entries(t.sends).find(([id]) => p.buses.find((b) => b.id === id)?.fx[0].type === type);
  return e ? { amount: e[1], bus: p.buses.find((b) => b.id === e[0]) } : null;
};
const laneRange = (l) => [Math.min(...l.points.map((x) => x.value)), Math.max(...l.points.map((x) => x.value))];

test('ambient stack without consts: three parts named from their comments, nothing dropped', () => {
  const { p, s, a, track, names } = assertComplete(fixture('ambient'));
  assert.deepEqual(names, ['Warm, Expanding Chord Progression', 'The Wanderer', 'Shimmering Sky']);
  assert.deepEqual(s.parts.map((x) => [x.label, x.status]), [['Warm, Expanding Chord Progression', 'ok'], ['The Wanderer', 'ok'], ['Shimmering Sky', 'ok']]);
  assert.equal(p.bpm, 120); // no setcpm: Strudel's 0.5 cycles/s, 1 cycle = 1 bar of 4 beats
  assert.deepEqual(p.key, { root: 5, scale: 'major' }); // Fmaj7 Dm7 Bbmaj7 Cmaj7 -> F major (not the default C minor)
  assert.equal(p.importedCode.original, fixture('ambient')); // the user's code is kept as written
  // .scramble() without a count is silent in Strudel itself -> repaired (count = the 8 steps), and said so
  assert.ok(s.notes.some((n) => /scramble\(\) has no count.*\.scramble\(8\)/.test(n)), s.notes.join('\n'));

  // 1. supersaw chords: patch, low-pass insert with lpq -> resonance, the sine sweep 300..900 every 8 cycles as a lane
  const warm = track('Warm, Expanding Chord Progression');
  assert.equal(warm.role, 'chords');
  assert.deepEqual([warm.instrument.params.s, warm.instrument.params.attack, warm.instrument.params.release], ['supersaw', 0.8, 1.5]);
  assert.equal(warm.volume, 0.4);
  const [lp] = fxOf(warm, 'filter');
  assert.deepEqual([lp.params.type, lp.params.resonance], ['lowpass', 4]);
  const cut = laneOf(warm, (t) => t?.kind === 'fx' && t.fxId === lp.id && t.key === 'cutoff');
  assert.ok(cut, 'cutoff lane');
  const [lo, hi] = laneRange(cut);
  assert.ok(Math.abs(lo - 300) < 15 && Math.abs(hi - 900) < 15, `${lo}..${hi}`);
  const at = (cycle) => valueAt(cut.points, cycle * 4);
  assert.ok(Math.abs(at(0) - 600) < 30 && Math.abs(at(2) - 900) < 30 && Math.abs(at(6) - 300) < 30 && Math.abs(at(10) - 900) < 30);
  assert.deepEqual(notesOf(p, warm).slice(0, 4).map((n) => n.pitch).sort(), [53, 57, 60, 64].sort()); // F3 A3 C4 E4

  // 2. the Wanderer: scrambled euclid melody on sine, delay + reverb sends, the gain sine as a volume lane
  const wan = track('The Wanderer');
  assert.equal(wan.instrument.params.s, 'sine');
  const pitches = new Set(notesOf(p, wan).map((n) => n.pitch));
  assert.ok(pitches.size >= 6 && [...pitches].every((x) => [60, 62, 65, 67, 69, 72, 74, 77].includes(x)), [...pitches].join());
  const rev = sendOf(p, wan, 'reverb');
  assert.equal(rev.amount, 0.8);
  const dl = sendOf(p, wan, 'delay');
  assert.equal(dl.amount, 0.6); // delay(.6) is the wet level
  assert.equal(dl.bus.fx[0].params.feedback, 0.7); // .delayfb(.7)
  assert.equal(dl.bus.fx[0].params.division, '1/8D'); // no delaytime: Strudel's default 3/16 cycle
  const vol = laneOf(wan, (t) => t?.kind === 'volume');
  const [v0, v1] = laneRange(vol);
  assert.ok(Math.abs(v0 - 0.1) < 0.01 && Math.abs(v1 - 0.35) < 0.01, `${v0}..${v1}`);
  assert.ok(Math.abs(valueAt(vol.points, 5 * 4 * 0.25) - 0.35) < 0.02, 'peaks a quarter into its 5-cycle period');
  assert.ok(notesOf(p, wan).every((n) => n.vel === 1));

  // 3. Shimmering Sky: its own notes (not derived from the chords), the pan sweep, gain .15, degradeBy holes
  const sky = track('Shimmering Sky');
  assert.notEqual(sky.role, 'chords');
  assert.deepEqual([...new Set(notesOf(p, sky).map((n) => n.pitch))].sort(), [77, 84, 88]);
  assert.equal(sky.instrument.params.s, 'triangle'); // "supersoft" isn't a Strudel sound
  assert.ok(s.notes.some((n) => /supersoft/.test(n)));
  assert.equal(sky.volume, 0.15);
  const pan = laneOf(sky, (t) => t?.kind === 'pan');
  assert.ok(pan && laneRange(pan)[0] < -0.5 && laneRange(pan)[1] > 0.5);
  const per = a.tracks.find((t) => t.name === 'Shimmering Sky').haps.length / a.cycles;
  assert.ok(per > 6.5 && per < 9.5, `degradeBy(.4) of 13.5 notes a cycle: ${per}`);
  assert.equal(s.sends, 2);
  assert.match(summaryText(s), /3 tracks .* 64 bars at 120 BPM · F major/);
});

const CORPUS = ['anon-labels', 'consts-stack', 'arrange', 'random', 'layers', 'samples', 'polymeter', 'chords-let', 'fm'];
const corpus = (name) => fs.readFileSync(new URL(`./fixtures/strudel-split/corpus/${name}.strudel`, import.meta.url), 'utf8');

test('corpus: every part becomes a track, no note lost (per sound), the timeline holds every note', () => {
  for (const name of CORPUS) {
    try { assertComplete(corpus(name)); } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
  }
});

test('corpus: names, continuous controls -> lanes, constants -> static params, sends', () => {
  let r = assertComplete(corpus('anon-labels'));
  assert.deepEqual(r.names, ['drums', 'bassline', 'keys']);
  const [blp] = fxOf(r.track('bassline'), 'filter');
  assert.equal(blp.params.resonance, 8);
  const bl = laneOf(r.track('bassline'), (t) => t?.kind === 'fx' && t.key === 'cutoff');
  assert.ok(laneRange(bl)[0] < 450 && laneRange(bl)[1] > 1900);
  assert.equal(sendOf(r.p, r.track('keys'), 'reverb').amount, 0.5);
  assert.ok(laneOf(r.track('keys'), (t) => t?.kind === 'volume'), 'perlin gain -> volume lane');
  assert.deepEqual(r.p.key, { root: 0, scale: 'minor' });

  r = assertComplete(corpus('consts-stack'));
  assert.deepEqual(r.names, ['kick', 'hats', 'bass', 'lead']);
  assert.ok(laneOf(r.track('hats'), (t) => t?.kind === 'pan'));
  assert.equal(fxOf(r.track('bass'), 'filter')[0].params.cutoff, 600);
  assert.equal(r.track('bass').automation.length, 0);
  assert.equal(fxOf(r.track('bass'), 'saturator').length, 1);
  assert.equal(sendOf(r.p, r.track('lead'), 'delay').amount, 0.5);

  r = assertComplete(corpus('arrange'));
  assert.equal(r.s.sections, 3);
  assert.equal(r.p.bpm, 132);
  assert.equal(fxOf(r.track('pad'), 'filter')[0].params.cutoff, 1200);
  assert.ok(laneOf(r.track('arp'), (t) => t?.kind === 'fx' && t.key === 'cutoff'));
  assert.equal(r.track('arp').instrument.params.fm, 2);
  assert.equal(sendOf(r.p, r.track('drums'), 'reverb').amount, 0.2); // only the snare has .room(.2): sent at its level

  r = assertComplete(corpus('random'));
  assert.deepEqual(r.names, ['hats', 'melody', 'shuffled bass']);
  assert.equal(r.s.bars, 64); // randomness never repeats: the whole probe length, as concrete notes
  assert.ok(new Set(notesOf(r.p, r.track('hats')).map((n) => n.vel)).size > 5, 'rand gain -> velocities');

  r = assertComplete(corpus('layers'));
  assert.deepEqual(r.names, ['Sawtooth lead L', 'Sawtooth lead R', 'Sine bass', 'Square bass', 'Drums']);
  assert.deepEqual([r.track('Sawtooth lead L').pan, r.track('Sawtooth lead R').pan], [-1, 1]); // jux(rev)
  assert.equal(r.track('Square bass').volume, 0.3);

  r = assertComplete(corpus('samples'));
  assert.equal(r.track('Piano chords').instrument.params.s, 'piano');
  assert.equal(sendOf(r.p, r.track('Vibraphone lead'), 'delay').amount, 0.4);
  assert.equal(r.track('Sawtooth lead').instrument.params.vowel, 'a');

  r = assertComplete(corpus('polymeter'));
  assert.equal(r.s.bars, 12); // {c d e}%4 + saw.slow(3) (3 cycles) with <c2 g1>/2 (4 cycles) -> 12
  assert.ok(laneOf(r.track('Triangle lead'), (t) => t?.kind === 'volume'));
  const hp = laneOf(r.track('Supersaw bass'), (t) => t?.kind === 'fx' && t.key === 'cutoff');
  assert.ok(laneRange(hp)[0] < 50 && laneRange(hp)[1] > 350, 'sine hpf on 2-cycle notes -> a full sweep');

  r = assertComplete(corpus('chords-let'));
  assert.deepEqual(r.names, ['Square chords', 'Sawtooth bass', 'Flute lead']); // not named after `let prog`
  assert.equal(fxOf(r.track('Square chords'), 'bitcrusher')[0].params.bits, 8);
  assert.ok(laneOf(r.track('Square chords'), (t) => t?.kind === 'send'), 'perlin room -> send lane');
  assert.ok(laneOf(r.track('Flute lead'), (t) => t?.kind === 'pan'));
  assert.ok(laneOf(r.track('Sawtooth bass'), (t) => t?.kind === 'fx' && t.key === 'cutoff'));

  r = assertComplete(corpus('fm'));
  assert.deepEqual(r.names, ['fm bell', 'fm bass', 'noise riser']);
  assert.equal(r.track('fm bell').instrument.params.fmh, 2.01);
  assert.ok(sendOf(r.p, r.track('fm bell'), 'reverb').bus.fx[0].params.decay >= 8);
  assert.notEqual(r.track('noise riser').role, 'bass');
  assert.ok(laneOf(r.track('noise riser'), (t) => t?.kind === 'volume'));
  assert.ok(laneOf(r.track('noise riser'), (t) => t?.kind === 'fx' && t.key === 'cutoff'));
});

test('parts summary: a part Strudel plays nothing for is listed as such', () => {
  const s = split('stack(\n  // keys\n  note("c4 e4").s("piano"),\n  // broken\n  note("c4").s("sine").struct("~"),\n)').s;
  assert.deepEqual(s.parts.map((x) => [x.label, x.status]), [['keys', 'ok'], ['broken', 'silent']]);
  assert.match(summaryText(s), /Plays nothing in Strudel \(no track\): broken/);
});
