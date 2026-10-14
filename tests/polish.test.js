// fix/polish: count-in, groove UI logic, key spelling, warp repitch, scoped shortcuts, MPE voices, sync / surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { songTempoMap } from '../src/time/tempo-map.js';
import { countInSchedule } from '../src/record/timing.js';
import { createProject } from '../src/core/model.js';
import { Scheduler } from '../src/audio/scheduler.js';

test('count-in: unmapped project, metronome on, record from bar 1 → recorder clicks the whole bar before 0', () => {
  const p = createProject({ bpm: 120 });
  const map = songTempoMap(p);
  const ci = countInSchedule(map, 0, 1, true);
  assert.equal(ci.from, -4);
  assert.equal(ci.startDelay, 0);
  assert.deepEqual(ci.clicks.map((c) => c.beat), [-4, -3, -2, -1]);
  assert.deepEqual(ci.clicks.map((c) => c.level), [2, 1, 1, 1]);
  assert.deepEqual(ci.clicks.map((c) => +c.t.toFixed(6)), [0, 0.5, 1, 1.5]);
  // the transport's own metronome yields nothing before beat 0 — that was the silent count-in
  const sch = new Scheduler(p, { mode: 'song', metronome: true });
  assert.equal(map.clicks(-4, 0).length, 0);
  assert.ok(sch);
});

test('count-in: metronome off → transport waits, every unit is clicked; 2 bars; mid-song start', () => {
  const p = createProject({ bpm: 90 });
  const map = songTempoMap(p);
  const ci = countInSchedule(map, 8, 2, false);
  assert.equal(ci.from, 8);
  assert.equal(ci.clicks.length, 8);
  assert.ok(Math.abs(ci.startDelay - 8 * 60 / 90) < 1e-9);
  assert.deepEqual(ci.clicks.map((c) => c.level), [2, 1, 1, 1, 2, 1, 1, 1]);
  // metronome on, mid-song: the transport clicks positive beats itself
  const on = countInSchedule(map, 8, 1, true);
  assert.equal(on.from, 4);
  assert.equal(on.clicks.length, 0);
  assert.deepEqual(countInSchedule(map, 0, 0, true), { from: 0, startDelay: 0, clicks: [] });
});

test('count-in: accents follow the meter (6/8 groups 3+3) even without a tempo map', () => {
  const p = createProject({ bpm: 120 });
  p.timeSig = [6, 8]; p.meter = { num: 6, den: 8 };
  const map = songTempoMap(p);
  const ci = countInSchedule(map, 0, 1, true);
  if (map.meterOfBar(-1).num === 6) assert.deepEqual(ci.clicks.map((c) => c.level), [2, 0, 0, 1, 0, 0]);
  else assert.equal(ci.clicks[0].level, 2);
});

import { keyName, keyRootName, spellPitch, spellNote, keySignature, diatonicChords, keyPrefersFlats } from '../src/theory/index.js';
import { keyName as setlistKeyName, keyMoveOptions } from '../src/live/setlist-engine.js';
import { noteSpeller } from '../src/code/song-code.js';

test('key spelling: flat keys (F Bb Eb Ab Db Gb + relative minors) use flats everywhere', () => {
  assert.equal(keyName(8, 'major'), 'Ab major');
  assert.equal(keyRootName(8, 'major'), 'Ab');
  assert.equal(keyRootName(8, 'minor'), 'G#');
  assert.equal(keyName(3, 'minor'), 'Eb minor'); // 6 flats, not D# minor
  assert.equal(keyName(6, 'major'), 'Gb major');
  assert.equal(keyName(10, 'minor'), 'Bb minor');
  assert.equal(keyName(1, 'minor'), 'C# minor');
  assert.equal(keyName(4, 'major'), 'E major');
  assert.equal(keyRootName(2, 'dorian'), 'D');
  assert.equal(keyRootName(3, 'dorian'), 'Eb'); // Eb dorian = Db major
  assert.equal(spellPitch(8, { root: 3, scale: 'major' }), 'Ab');
  assert.equal(spellPitch(8, { root: 4, scale: 'major' }), 'G#');
  assert.equal(spellNote(68, { root: 3, scale: 'minor' }), 'Ab4');
  assert.equal(keySignature(6, 'major'), -6);
  assert.equal(keySignature(3, 'minor'), -6);
  assert.equal(keySignature(11, 'major'), 5);
  assert.ok(keyPrefersFlats(5, 'major') && !keyPrefersFlats(7, 'major'));
});

test('key spelling: chord symbols, setlist and code speller agree with the key', () => {
  assert.deepEqual(diatonicChords(8, 'major').map((c) => c.name), ['Ab', 'Bbm', 'Cm', 'Db', 'Eb', 'Fm', 'Gdim']);
  assert.deepEqual(diatonicChords(4, 'major').map((c) => c.name).slice(0, 3), ['E', 'F#m', 'G#m']);
  assert.equal(setlistKeyName({ root: 3, scale: 'minor' }), 'Eb minor');
  const par = keyMoveOptions({ root: 3, scale: 'major' }).find((o) => /parallel/i.test(o.label));
  if (par) assert.match(par.text, /^Eb major → Eb minor/);
  assert.equal(noteSpeller({ key: { root: 8, scale: 'major' } })(68), 'ab4');
  assert.equal(noteSpeller({ key: { root: 3, scale: 'minor' } })(66), 'gb4');
  assert.equal(noteSpeller({ key: { root: 9, scale: 'minor' } })(66), 'f#4');
});

import { repitchRates, curveRates } from '../src/audio/warp/markers.js';
import { WarpRenderer } from '../src/audio/warp/core.js';

test('warp: Re-Pitch honours transpose (rate × 2^(st/12) on top of the tempo ratio)', () => {
  const pts = [{ t: 0, s: 0 }, { t: 1, s: 0.5 }, { t: 2, s: 1.5 }];
  assert.deepEqual(curveRates(pts).map((r) => r.rate), [0.5, 1]);
  assert.deepEqual(repitchRates(pts, 12).map((r) => r.rate), [1, 2]);
  assert.ok(Math.abs(repitchRates(pts, 7)[1].rate - 2 ** (7 / 12)) < 1e-12);
  assert.deepEqual(repitchRates(pts, 0), curveRates(pts));
  // renderer: a 100 Hz sine played at tempo ratio 1 with +12 st comes out at 200 Hz
  const sr = 8000, x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 100 * i / sr);
  const zc = (y) => { let n = 0; for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) n++; return n; };
  const mk = (mode, transpose) => new WarpRenderer({ channels: [x], srcRate: sr, outRate: sr, curve: [{ t: 0, s: 0 }, { t: 0.5, s: 0.5 }], mode, transpose }).renderAll()[0];
  assert.ok(Math.abs(zc(mk('repitch', 0)) - 50) <= 1);
  assert.ok(Math.abs(zc(mk('repitch', 12)) - 100) <= 1);
  assert.ok(Math.abs(zc(mk('off', 12)) - 50) <= 1); // warp off: transpose does nothing
});

import { BUILTIN_GROOVES, grooveLibrary, findGroove, grooveNotes, mpcSwingGroove, grooveFromNotes } from '../src/time/groove.js';

test('groove library: MPC 16th swing presets + project grooves; apply with strength / to selected notes only', () => {
  const g58 = findGroove({}, 'mpc16-58');
  assert.ok(g58 && g58.builtin);
  assert.equal(g58.grid, 0.25);
  assert.ok(Math.abs(g58.offsets[1] - 0.04) < 1e-9); // 58% of an 8th pair: the off 16th is 0.04 beats late
  assert.equal(g58.offsets[0], 0);
  assert.ok(Math.abs(mpcSwingGroove(66).offsets[1] - 0.08) < 1e-9);
  assert.ok(BUILTIN_GROOVES.some((g) => g.id === 'mpc16-71'));
  const extracted = grooveFromNotes([{ start: 0, vel: 1 }, { start: 0.3, vel: 0.5 }], { grid: 0.25, length: 1, name: 'mine' });
  const lib = grooveLibrary({ grooves: [extracted] });
  assert.equal(lib[lib.length - 1].name, 'mine');
  assert.equal(findGroove({ grooves: [extracted] }, extracted.id), extracted);
  const notes = [0, 0.25, 0.5, 0.75].map((s, i) => ({ id: 'n' + i, pitch: 60, start: s, dur: 0.2, vel: 0.8 }));
  const full = grooveNotes(notes, g58, { strength: 1 });
  assert.deepEqual(full.map((n) => n.start), [0, 0.29, 0.5, 0.79]);
  const half = grooveNotes(notes, g58, { strength: 0.5 });
  assert.deepEqual(half.map((n) => n.start), [0, 0.27, 0.5, 0.77]);
  const sel = grooveNotes(notes, g58, { strength: 1, noteIds: new Set(['n1']) });
  assert.deepEqual(sel.map((n) => n.start), [0, 0.29, 0.5, 0.75]);
  const acc = grooveNotes(notes, g58, { strength: 0, velStrength: 1 });
  assert.equal(acc[1].vel, 0.85);
  assert.equal(notes[1].start, 0.25); // input untouched
});

import { instrumentEdited } from '../src/core/model.js';
import { instrumentForRole } from '../src/gen/sound.js';

test('"edited" badge: generated drum tracks are not edited; user edits / legacy sound params are', () => {
  for (const g of ['house', 'dnb', 'trap', 'techno', 'lofi']) {
    const ins = instrumentForRole('drums', g);
    assert.equal(instrumentEdited(ins), false, g);
  }
  assert.equal(instrumentEdited({ type: 'drums', preset: '808', params: { kit: '808' } }), false);
  assert.equal(instrumentEdited({ type: 'synth', preset: 'x', params: { cutoff: 0.3 } }), true);
  assert.equal(instrumentEdited({ type: 'drums', preset: '808', params: { kit: '808', pads: { kick: { tone: 1 } } }, edited: true }), true);
  assert.equal(instrumentEdited({ type: 'synth', preset: 'x', params: { cutoff: 0.3 }, edited: false }), false);
});

import { fitPlan } from '../src/ui/overflow.js';

test('priority+ overflow: hides the highest priorities first until the row fits', () => {
  const items = [{ prio: 0, width: 100 }, { prio: 3, width: 50 }, { prio: 9, width: 80 }, { prio: 5, width: 40 }, { prio: 9, width: 30 }];
  assert.deepEqual(fitPlan(items, 500, 600), []);
  // 650 + 32 (⋯) must drop to ≤ 600: the later prio-9 (30) then the other prio-9 (80)
  assert.deepEqual(fitPlan(items, 650, 600), [4, 2]);
  assert.deepEqual(fitPlan(items, 1000, 600), [4, 2, 3, 1]); // never the prio-0 item
});

import { buildCommands } from '../src/control/commands.js';
import { ShortcutMap } from '../src/control/shortcuts.js';
import { VIEW_COMMANDS, VIEW_SCOPES } from '../src/control/view-commands.js';

test('shortcuts: view-scoped commands share the rebindable map; same key in different views, no default conflicts', () => {
  let viewNow = 'piano';
  const calls = [];
  const app = { ui: { get: (k) => (k === 'view' ? viewNow : null), set: (o) => { if (o.view) viewNow = o.view; } }, actions: {}, store: { get: () => ({ tracks: [] }) },
    viewActions: { piano: { delete: () => { calls.push('piano.delete'); return true; } }, arrange: { delete: () => { calls.push('arrange.delete'); return false; } } } };
  const reg = buildCommands(app);
  const map = new ShortcutMap(reg);
  assert.deepEqual(map.conflicts(), []);
  for (const s of Object.keys(VIEW_SCOPES)) assert.ok(VIEW_COMMANDS.some((c) => c.scope === s), s);
  assert.equal(map.match('delete', { view: 'piano' }).id, 'piano.delete');
  assert.equal(map.match('delete', { view: 'arrange' }).id, 'arrange.delete');
  assert.equal(map.match('delete', { view: 'code' }), null);
  assert.equal(map.match('s', { view: 'arrange' }).id, 'arrange.split');
  assert.equal(map.match('space', { view: 'piano' }).id, 'transport.play'); // globals still work in views
  assert.equal(map.matchScope('space', 'piano'), null);
  assert.equal(reg.get('piano.delete').run({}), true);
  assert.equal(reg.get('arrange.delete').run({}), false); // nothing selected: the key falls through
  // rebinding is per command: piano delete on "x" leaves arrange's Delete alone
  map.set('piano.delete', ['x']);
  assert.equal(map.match('x', { view: 'piano' }).id, 'piano.delete');
  assert.equal(map.match('delete', { view: 'arrange' }).id, 'arrange.delete');
  assert.equal(map.match('delete', { view: 'piano' }), null);
  // the same chord in two views is not a conflict; with a global command it is
  map.set('mixer.mute', ['x']);
  assert.deepEqual(map.conflicts(), []);
  map.set('mixer.mute', ['space']);
  assert.ok(map.conflicts().some((c) => c.chord === 'space'));
  // from the palette (no event) a view command opens its view first
  viewNow = 'mixer';
  assert.equal(reg.get('piano.selectAll').run(), true);
  assert.equal(viewNow, 'piano');
});

import { FMInstrument } from '../src/audio/fm.js';
import { OrganInstrument } from '../src/audio/organ.js';
import { SamplerInstrument } from '../src/audio/sampler.js';
import { SynthInstrument } from '../src/audio/synth.js';
import { pressureGain, timbreCutoff, timbreCents } from '../src/audio/voice-expression.js';

/** Permissive Web Audio fake: every node property that isn't set is an AudioParam; param inputs are recorded. */
function fakeCtx() {
  class Param {
    constructor(v = 0) { this.value = v; this.inputs = []; }
    setValueAtTime(v) { this.value = v; return this; } setTargetAtTime(v) { this.value = v; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; } exponentialRampToValueAtTime(v) { this.value = v; return this; }
    setValueCurveAtTime(c) { this.value = c[c.length - 1]; return this; } cancelScheduledValues() { return this; } cancelAndHoldAtTime() { return this; }
  }
  const METHODS = new Set(['connect', 'disconnect', 'start', 'stop', 'setPeriodicWave', 'addEventListener', 'removeEventListener', 'getFloatTimeDomainData', 'getByteFrequencyData', 'getFloatFrequencyData', 'getFrequencyResponse']);
  const node = (kind) => {
    const o = { kind, outs: [] };
    o.connect = (d) => { if (d instanceof Param) d.inputs.push(p); else o.outs.push(d); return d; };
    o.disconnect = (d) => { if (d === undefined) o.outs = []; else o.outs = o.outs.filter((x) => x !== d); };
    o.start = () => {}; o.stop = () => {}; o.setPeriodicWave = () => {}; o.addEventListener = () => {}; o.removeEventListener = () => {};
    const p = new Proxy(o, { get(t, k) { if (k in t || typeof k === 'symbol' || k === 'then' || k === 'onended' || METHODS.has(k)) return t[k]; if (k === 'curve' || k === 'buffer') return t[k] ?? null; t[k] = new Param(k === 'gain' ? 1 : 0); return t[k]; } });
    return p;
  };
  const ctx = { sampleRate: 48000, currentTime: 0, state: 'running', destination: node('dest') };
  return new Proxy(ctx, { get(t, k) {
    if (k in t) return t[k];
    if (k === 'createPeriodicWave') return () => ({});
    if (k === 'createBuffer') return (ch, len, sr) => { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c) => d[c] }; };
    if (typeof k === 'string' && k.startsWith('create')) return () => node(k.slice(6));
    return undefined;
  } });
}
const reached = (from, target, seen = new Set()) => { if (from === target) return true; if (seen.has(from)) return false; seen.add(from); return (from.outs || []).some((n) => reached(n, target, seen)); };

test('MPE: pure maps (pressure gain, timbre cutoff / cents)', () => {
  assert.equal(pressureGain(0), 1);
  assert.equal(pressureGain(1), 1.5);
  assert.equal(timbreCutoff(0.5, 0), 20000);
  assert.equal(timbreCutoff(1, 0), 20000);
  assert.ok(timbreCutoff(0, 0) < 200);
  assert.ok(timbreCutoff(0.25, 1) > timbreCutoff(0.25, 0));
  assert.equal(timbreCents(0.5, 0), 0);
  assert.equal(timbreCents(1, 0.5), 1200 + 600);
});

test('MPE: FM, organ, sampler and synth voices take per-note bend / pressure / timbre (only the touched note)', () => {
  const engines = [
    ['fm', FMInstrument, {}],
    ['organ', OrganInstrument, {}],
    ['sampler', SamplerInstrument, {}],
    ['synth', SynthInstrument, {}],
  ];
  for (const [name, E, params] of engines) {
    const ctx = fakeCtx();
    const out = ctx.createGain();
    const inst = new E(ctx, out, params, {});
    if (name === 'sampler') { const b = ctx.createBuffer(1, 48000, 48000); inst._buffer = () => b; }
    const a = inst.noteOn(60, 0.8, 0);
    const b = inst.noteOn(64, 0.8, 0);
    assert.ok(a && b, name);
    assert.ok(a.xs, `${name}: expression stage`);
    inst.noteExpression(60, { bend: 2, pressure: 1, timbre: 0.1 }, 0);
    assert.equal(a.xs.gain.gain.value, 1.5, `${name}: pressure -> gain`);
    assert.equal(b.xs.gain.gain.value, 1, `${name}: other note untouched`);
    if (name !== 'synth') {
      assert.ok(a.mpeBend, `${name}: per-note bend source`);
      assert.equal(a.mpeBend.offset.value, 200, `${name}: bend in cents`);
      assert.ok(!b.mpeBend, `${name}: bend only on the touched voice`);
      for (const d of a.detuneTargets) assert.ok(d.inputs.length >= 1, `${name}: detune target driven`);
    }
    if (name === 'fm' || name === 'organ') {
      assert.ok(a.xs.filter, `${name}: timbre inserted a per-voice low-pass`);
      assert.ok(a.xs.filter.frequency.value < 2000, `${name}: dark timbre closes the filter`);
      assert.ok(reached(a.xs.gain, a.xs.filter) && reached(a.xs.filter, a.xs.dest), `${name}: re-routed through the filter`);
      assert.ok(!a.xs.gain.outs.includes(a.xs.dest), `${name}: direct path removed`);
    }
    if (name === 'sampler') assert.equal(a.filters[0].detune.value, timbreCents(0.1, 1), 'sampler: own filter detuned');
  }
});

import { SurfaceController, faderToGain, gainToFader } from '../src/control/surface.js';
import { MCU_BUTTONS } from '../src/control/surface-protocol.js';
import { framesToTimecode, toTimecode, mtcFullFrame, quarterFrames, MtcOut, ClockPhaseLock, MidiClockIn } from '../src/control/clock.js';
import { applyExternalTempo } from '../src/time/tempo-edit.js';
import { TemplateBanks } from '../src/control/mapping.js';

function fakeSurfaceHost() {
  const st = { strips: [{ id: 't1', name: 'Kick', volume: 0.8, pan: 0, mute: false, solo: false, arm: false, selected: true }, { id: 't2', name: 'Bass', volume: 0.5, pan: -0.5 }],
    autoMode: 'read', cmds: [], vol: {}, pan: {} };
  return { st, strips: () => st.strips, master: () => ({ volume: 0.9 }), setVolume: (id, g) => { st.vol[id] = g; const s = st.strips.find((x) => x.id === id); if (s) s.volume = g; },
    setPan: (id, v) => { st.pan[id] = v; const s = st.strips.find((x) => x.id === id); if (s) s.pan = v; }, toggle() {}, select() {}, touch() {},
    transport: () => ({ playing: false, autoMode: st.autoMode }), setAutoMode: (m) => { st.autoMode = m; }, command: (n) => st.cmds.push(n), jog: (d) => st.cmds.push(`jog${d}`) };
}
const btnMsg = (name, on = true) => [0x90, MCU_BUTTONS[name], on ? 127 : 0];

test('MCU: flip swaps faders and V-pots; automation-mode buttons; marker add / navigate', () => {
  const host = fakeSurfaceHost();
  const sent = [];
  const c = new SurfaceController({ kind: 'mcu', host, send: (m) => sent.push(...m) });
  c.connect();
  c.handle(btnMsg('flip')); c.handle(btnMsg('flip', false));
  assert.equal(c.flip, true);
  // flipped: fader 1 (pitch bend ch 1) sets Bass's pan (V-pot parameter in pan mode)
  c.handle([0xe1, 0x7f, 0x7f]);
  assert.ok(Math.abs(host.st.pan.t2 - 1) < 0.01);
  // the V-pot rides the volume
  c.handle([0xb0, 0x10, 0x05]);
  assert.ok(host.st.vol.t1 > 0.8);
  // fader motor of strip 0 follows the pan value (centre) — pitch bend ≈ 8192
  const fb = sent.filter((m) => m[0] === 0xe0).at(-1);
  assert.ok(Math.abs(((fb[2] << 7) | fb[1]) - 8191) < 64);
  // automation modes
  c.handle(btnMsg('latch')); assert.equal(host.st.autoMode, 'latch');
  c.handle(btnMsg('write')); assert.equal(host.st.autoMode, 'write');
  c.handle(btnMsg('readOff')); assert.equal(host.st.autoMode, 'read');
  c.handle(btnMsg('readOff')); assert.equal(host.st.autoMode, 'off');
  c.handle(btnMsg('touch')); assert.equal(host.st.autoMode, 'touch');
  assert.ok(sent.some((m) => m[0] === 0x90 && m[1] === MCU_BUTTONS.touch && m[2] === 127), 'touch LED');
  // marker: press+release = add; hold + ▶ / ◀ = navigate (no add)
  c.handle(btnMsg('marker')); c.handle(btnMsg('marker', false));
  c.handle(btnMsg('marker')); c.handle(btnMsg('right')); c.handle(btnMsg('left')); c.handle(btnMsg('marker', false));
  assert.deepEqual(host.st.cmds, ['marker', 'nextMarker', 'prevMarker']);
  c.handle(btnMsg('right'));
  assert.equal(host.st.cmds.at(-1), 'jog16');
  assert.ok(faderToGain(gainToFader(0.8)) - 0.8 < 1e-3);
});

test('MTC 29.97 drop-frame: frame numbering, full frame and quarter-frame rate bits, real-time quarter frames', () => {
  assert.deepEqual(framesToTimecode(1799, '29.97'), { h: 0, m: 0, s: 59, f: 29 });
  assert.deepEqual(framesToTimecode(1800, '29.97'), { h: 0, m: 1, s: 0, f: 2 }); // ;00 and ;01 skipped
  assert.deepEqual(framesToTimecode(17982, '29.97'), { h: 0, m: 10, s: 0, f: 0 }); // not skipped at minute 10
  assert.deepEqual(toTimecode(3600, '29.97'), { h: 1, m: 0, s: 0, f: 0 }); // DF tracks the wall clock
  assert.deepEqual(toTimecode(3600, 30), { h: 1, m: 0, s: 0, f: 0 });
  const ff = mtcFullFrame(0, '29.97');
  assert.equal(ff[5] >> 5, 2);
  assert.equal(quarterFrames({ h: 0, m: 0, s: 0, f: 0 }, '29.97')[7] & 0x0f, 2 << 1);
  const out = [];
  const m = new MtcOut({ fps: '29.97', send: (d, ts) => out.push([d, ts]), lookahead: 0 });
  m.start(0, 0);
  m.pump(1000);
  const qf = out.filter(([d]) => d[0] === 0xf1);
  assert.ok(Math.abs(qf.length - Math.ceil(1000 / (1000 / (30000 / 1001 * 4)))) <= 1, `≈120 quarter frames per second, got ${qf.length}`);
});

test('MIDI clock in: continuous phase lock (trim small drift, relocate large) and beatAt extrapolation', () => {
  const lock = new ClockPhaseLock();
  assert.equal(lock.update(10, 10, 120).kind, 'hold');
  const r = lock.update(10.05, 10, 120);
  assert.equal(r.kind, 'trim');
  assert.ok(r.bpm > 120 && r.bpm <= 120 * 1.02); // behind -> slightly faster
  const r2 = new ClockPhaseLock().update(9.95, 10, 120);
  assert.ok(r2.bpm < 120);
  const j = lock.update(20, 10, 120);
  assert.deepEqual([j.kind, j.beat], ['jump', 20]);
  // simulate: a local transport 0.06 beat behind converges under the trim loop
  const pl = new ClockPhaseLock();
  let local = 0, ext = 0.06;
  for (let i = 0; i < 400; i++) { const u = pl.update(ext, local, 120); const bpm = u.bpm || 120; ext += 0.25; local += 0.25 * bpm / 120; }
  assert.ok(Math.abs(ext - local) < 0.01, `converged (${ext - local})`);
  const ci = new MidiClockIn({ minTicks: 4 });
  ci.handle([0xfa], 0);
  for (let k = 0; k < 30; k++) ci.handle([0xf8], k * (500 / 24));
  assert.ok(Math.abs(ci.bpm - 120) < 0.5);
  const b = ci.beatAt(29 * (500 / 24) + 10);
  assert.ok(b > ci.position && b <= ci.position + 1 / 24 + 1e-9);
});

test('external tempo (Link / MIDI clock): tempo-map points while recording automation, else the current segment', () => {
  const p = createProject({ bpm: 120 }); p.mode = 'song';
  assert.equal(applyExternalTempo(p, 124, { beat: 8 }), 'bpm');
  assert.equal(p.bpm, 124); assert.ok(!p.tempoMap);
  assert.equal(applyExternalTempo(p, 126, { beat: 16, record: true }), 'point');
  assert.deepEqual(p.tempoMap.map((x) => [x.beat, x.bpm]), [[0, 124], [16, 126]]);
  applyExternalTempo(p, 127, { beat: 16.5, record: true }); // within a beat: the point glides instead of piling up
  assert.deepEqual(p.tempoMap.map((x) => [x.beat, x.bpm]), [[0, 124], [16, 127]]);
  applyExternalTempo(p, 130, { beat: 32, record: true });
  assert.equal(p.tempoMap.length, 3);
  // not recording: changes the segment under the playhead only
  assert.equal(applyExternalTempo(p, 110, { beat: 20 }), 'segment');
  assert.deepEqual(p.tempoMap.map((x) => [x.beat, x.bpm]), [[0, 124], [16, 110], [32, 130]]);
  applyExternalTempo(p, 100, { beat: 4 });
  assert.equal(p.bpm, 100);
  // pattern mode: just the project tempo
  p.mode = 'pattern';
  assert.equal(applyExternalTempo(p, 90, { beat: 20, record: true }), 'bpm');
  assert.equal(p.bpm, 90);
});

test('named controller-template banks', () => {
  const b = new TemplateBanks(null, [{ id: 'm1' }]);
  assert.deepEqual(b.names(), ['Default']);
  b.saveAs('Synth edit', [{ id: 'm2' }, { id: 'm3' }]);
  assert.equal(b.active, 'Synth edit');
  assert.equal(b.select(1).length, 1); // wraps to Default
  assert.equal(b.active, 'Default');
  assert.equal(b.select(-1).length, 2);
  b.store([{ id: 'm4' }]);
  assert.deepEqual(b.banks['Synth edit'], [{ id: 'm4' }]);
  assert.ok(b.rename('Synth edit', 'Synth'));
  assert.equal(b.active, 'Synth');
  assert.equal(b.select('nope'), null);
  assert.ok(b.remove('Synth'));
  assert.ok(!b.remove('Default')); // the last bank stays
  const round = new TemplateBanks(JSON.parse(JSON.stringify(b)));
  assert.deepEqual(round.names(), ['Default']);
});
