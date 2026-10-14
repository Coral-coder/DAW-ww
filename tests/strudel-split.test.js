// "Split into tracks" import (src/code/import-split.js): any Strudel code -> one track per instrument, with its
// effects (inserts / sends / mixer), automation lanes for controls that move, clips per arrange() section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadStrudel, codeEngine, splitTopLevel } from '../src/code/strudel.js';
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
  assert.equal(p.importedCode, orig.code);
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
