// Take lanes + comps in interchange and exports: DAWproject writes the comp as the active clips and every take lane as
// a muted nested <Lanes> (round-trips into takeLanes / comp), MIDI export writes the comp, stems / exports render it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildDawproject, exportDawproject, importDawproject, parseDawproject } from '../src/io/interchange/dawproject.js';
import { parseXml, child, children, toXml } from '../src/io/interchange/xml.js';
import { stemVariant, stemRenderPlan } from '../src/io/interchange/stems.js';
import { stemProject, stemTargets, resolveRange } from '../src/io/export-plan.js';
import { collectTrackNotes, exportMidi, importMidi } from '../src/io/midi.js';
import { createTake, addRecordedTakes, setCompRange, compClips } from '../src/record/takes.js';
import { trackClips } from '../src/record/clips.js';
import { collectEvents } from '../src/audio/scheduler.js';
import { createProject, createTrack, createPattern, createNote, createClip } from '../src/core/model.js';
import { encodeWav } from '../src/io/wav.js';
import { arrayBufferToBase64 } from '../src/io/samples.js';
import { loadSchema } from './lib/xsd-lite.js';

const zlibCodec = { deflateRaw: (b) => zlib.deflateRawSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };
const PROJECT_XSD = loadSchema(fs.readFileSync(new URL('./fixtures/dawproject/Project.xsd', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

function wavSample(id, seconds, freq) {
  const sr = 44100, n = Math.round(seconds * sr);
  const ch = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin((2 * Math.PI * freq * i) / sr));
  const bytes = new Uint8Array(encodeWav([ch], { bitDepth: 16, sampleRate: sr }));
  return { id, name: id, mime: 'audio/wav', data: arrayBufferToBase64(bytes), duration: seconds };
}

/** Audio track with 3 cycle takes (0–8 beats) comped 2|0|1, plus a MIDI track with 2 pattern takes comped. */
function takeProject() {
  const p = createProject({ name: 'Takes', bpm: 120 });
  p.mode = 'song';
  const vox = createTrack({ type: 'audio', name: 'Vox' });
  const keys = createTrack({ name: 'Keys', instrument: { type: 'synth', preset: null, params: {} } });
  p.tracks.push(vox, keys);
  for (const [i, f] of [220, 330, 440].entries()) p.samples[`smp_t${i}`] = wavSample(`smp_t${i}`, 6, f);
  const takes = [0, 1, 2].map((i) => createTake({ name: `Take ${i + 1}`, sampleId: `smp_t${i}`, start: 0, length: 8, offset: 1, srcLength: 12 }));
  addRecordedTakes(p, vox, takes);
  setCompRange(vox, takes[0].id, 2, 4);
  setCompRange(vox, takes[1].id, 6, 8);
  // MIDI takes
  const pa = createPattern(keys.id, { name: 'Pass A', length: 8, notes: [createNote(60, 0, 1, 0.8), createNote(62, 2, 1, 0.8), createNote(64, 4, 1, 0.8), createNote(65, 6, 1, 0.8)] });
  const pb = createPattern(keys.id, { name: 'Pass B', length: 8, notes: [createNote(72, 0, 1, 0.5), createNote(74, 2, 1, 0.5), createNote(76, 4, 1, 0.5), createNote(77, 6, 1, 0.5)] });
  p.patterns[pa.id] = pa; p.patterns[pb.id] = pb;
  keys.activePatternId = pa.id;
  const mt = [createTake({ name: 'Pass A', patternId: pa.id, start: 8, length: 8 }), createTake({ name: 'Pass B', patternId: pb.id, start: 8, length: 8 })];
  addRecordedTakes(p, keys, mt, { kind: 'pattern' });
  setCompRange(keys, mt[0].id, 12, 16); // B for 8–12, A for 12–16
  // an ordinary clip next to the takes stays an ordinary clip
  p.clips.push(createClip(vox.id, { type: 'audio', sampleId: 'smp_t0', start: 16, length: 4 }));
  return { p, vox, keys, takes, mt };
}

const sig = (proj, t) => ({
  lanes: t.takeLanes.map((l) => l.takes.map((x) => [x.name, x.start, x.length, x.offset, x.pass ?? null, x.srcLength ?? null, x.sampleId ? proj.samples[x.sampleId].data.length : proj.patterns[x.patternId].notes.map((n) => n.pitch).join()])),
  comp: t.comp.map((s) => [t.takeLanes.flatMap((l) => l.takes).find((x) => x.id === s.takeId).name, s.start, s.end]),
});

test('DAWproject export: comp = active clips, takes = muted nested lanes; still valid against Project.xsd', () => {
  const { p } = takeProject();
  const out = buildDawproject(p);
  assert.deepEqual(PROJECT_XSD.validate(out.projectXml), []);
  const root = parseXml(out.projectXml);
  const trackLanes = children(child(child(root, 'Arrangement'), 'Lanes'), 'Lanes');
  const voxId = children(child(root, 'Structure'), 'Track').find((t) => t.attrs.name === 'Vox').attrs.id;
  const vl = trackLanes.find((l) => l.attrs.track === voxId);
  const active = children(child(vl, 'Clips'), 'Clip');
  // comp segments 2|0|2|1 + the ordinary clip, all enabled
  assert.equal(active.filter((c) => /^daw3:comp:/.test(c.attrs.comment || '')).length, 4);
  assert.ok(active.every((c) => c.attrs.enable !== 'false'));
  const nested = children(vl, 'Lanes');
  assert.equal(nested.length, 3, 'one nested lane per take lane');
  for (const l of nested) {
    const cs = children(child(l, 'Clips'), 'Clip');
    assert.equal(cs.length, 1);
    assert.equal(cs[0].attrs.enable, 'false', 'takes are muted');
    assert.match(cs[0].attrs.comment, /^daw3:take:\{/);
  }
  assert.match(out.report.exported.join('\n'), /Vox": comp \(4 segments\) \+ 3 takes in 3 muted take lanes/);
});

test('DAWproject round trip: takeLanes / takes / comp come back; the comp plays the same audio and notes', async () => {
  const { p, vox, keys } = takeProject();
  const { bytes } = await exportDawproject(p, { codec: zlibCodec });
  const { project: q, report } = await importDawproject(bytes, { codec: zlibCodec });
  const qv = q.tracks.find((t) => t.name === 'Vox'), qk = q.tracks.find((t) => t.name === 'Keys');
  assert.deepEqual(sig(q, qv), sig(p, vox));
  assert.deepEqual(sig(q, qk), sig(p, keys));
  assert.equal(qv.takeLanes[0].id, vox.takeLanes[0].id, 'lane ids kept');
  // comp clips were not imported as ordinary clips: only the plain clip at beat 16 is a clip
  assert.deepEqual(q.clips.filter((c) => c.trackId === qv.id).map((c) => [c.start, c.length]), [[16, 4]]);
  assert.equal(q.clips.filter((c) => c.trackId === qk.id).length, 0);
  // what plays is the same: comp audio segments (take sample, start, length, offset, crossfades)
  const play = (proj, t) => compClips(proj, t).map((c) => [(c.sampleId ? proj.samples[c.sampleId].data.length : proj.patterns[c.patternId].name), +c.start.toFixed(4), +c.length.toFixed(4), +c.offset.toFixed(4), +(c.fadeIn || 0).toFixed(4)]);
  assert.deepEqual(play(q, qv), play(p, vox));
  const notes = (proj, t) => collectTrackNotes(proj, t, 'song').map((n) => [n.pitch, n.start, n.dur]);
  assert.deepEqual(notes(q, qk), notes(p, keys));
  assert.match(report.mapped.join('\n'), /Vox": 3 takes in 3 take lanes, comp of 4 segments/);
});

test('DAWproject import: comp clips without their take lanes stay ordinary clips; foreign muted lanes become takes', () => {
  const { p } = takeProject();
  const out = buildDawproject(p);
  const root = parseXml(out.projectXml);
  // an editor that drops nested lanes: the comp still plays as clips
  const strip = (n) => { n.children = n.children.filter((c) => !(c.name === 'Lanes' && /^daw3:takes:/.test(c.attrs.comment || ''))); n.children.forEach(strip); };
  strip(root);
  const files = new Map(out.files.map((f) => [f.path, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]));
  const { project: q } = parseDawproject(toXml(root), files);
  const qv = q.tracks.find((t) => t.name === 'Vox');
  assert.ok(!qv.takeLanes?.length || !qv.takeLanes.some((l) => l.takes.length));
  assert.equal(q.clips.filter((c) => c.trackId === qv.id && c.type === 'audio').length, 5, '4 comp segments + the plain clip');
  // a foreign file: nested lane of disabled clips without daW³ comments -> a take lane, no comp
  const root2 = parseXml(out.projectXml);
  const scrub = (n) => { if (n.name === 'Lanes' && /^daw3:takes:/.test(n.attrs.comment || '')) delete n.attrs.comment; if (n.name === 'Clip') delete n.attrs.comment; n.children.forEach(scrub); };
  scrub(root2);
  const { project: r } = parseDawproject(toXml(root2), files);
  const rv = r.tracks.find((t) => t.name === 'Vox');
  assert.equal(rv.takeLanes.length, 3);
  assert.ok(!rv.comp?.length);
  assert.equal(r.clips.filter((c) => c.trackId === rv.id).length, 5);
});

test('MIDI export writes the comp of MIDI take lanes', () => {
  const { p, keys } = takeProject();
  const notes = collectTrackNotes(p, keys, 'song').map((n) => [n.pitch, n.start]);
  assert.deepEqual(notes, [[72, 8], [74, 10], [64, 12], [65, 14]], 'pass B for 8–12, pass A for 12–16');
  const mid = importMidi(exportMidi(p, { mode: 'song' }).buffer);
  const k = mid.tracks.find((t) => t.name === 'Keys');
  assert.deepEqual(k.notes.map((n) => [n.pitch, +n.start.toFixed(3)]), notes);
});

test('stems + audio export render the comp (trackClips): plan, variants and scheduled events', () => {
  const { p, vox, keys, takes } = takeProject();
  p.clips = []; // comps only
  assert.equal(resolveRange(p).mode, 'song');
  assert.equal(resolveRange(p).endBeat, 16);
  const plan = stemRenderPlan(p);
  assert.equal(plan.mode, 'song');
  assert.deepEqual(plan.tracks.map((t) => t.name), ['Vox', 'Keys'], 'tracks with only a comp get a stem');
  const comp = (proj, id) => collectEvents(proj, 0, 16, { mode: 'song' }).filter((e) => e.trackId === id);
  // mixing-engineer stems (stems.js)
  const v = stemVariant(p, vox.id);
  const ev = comp(v, vox.id);
  assert.deepEqual(ev.map((e) => e.clip.takeId), [takes[2].id, takes[0].id, takes[2].id, takes[1].id]);
  assert.equal(comp(v, keys.id).length, 0, 'other tracks muted');
  // pro export stems (export-plan.js)
  const target = stemTargets(p, { which: 'all' }).find((t) => t.id === keys.id);
  const sp = stemProject(p, target, { tap: 'post' });
  const kev = comp(sp, keys.id).filter((e) => e.type === 'note');
  assert.deepEqual(kev.map((e) => e.pitch ?? e.note?.pitch), [72, 74, 64, 65]);
  assert.equal(comp(sp, vox.id).length, 0);
  assert.equal(trackClips(sp, sp.tracks.find((t) => t.id === keys.id)).length, 2);
});
