// VCA automation lanes (Arrange rows like buses / master: targets, drawing data, playback ramps, the write override)
// and VCA / folder / group structure in DAWproject (folder tracks + group channels, daw3/mixer.json for VCAs / groups).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createProject, createTrack, createPattern, createNote, createClip, createBus } from '../src/core/model.js';
import { createAutomationLane, automationOwner, valueAt, toNorm } from '../src/core/automation.js';
import { createVca, createGroup, createFolder, setFolderSum, vcaCombinedLane, mixerOf } from '../src/core/mixer-model.js';
import { ownerInfo, ownerView, targetGroups, targetInfo, laneLabel, VCA_COLOR } from '../src/ui/automation-targets.js';
import { snapshotTargets } from '../src/core/automation-record.js';
import { AudioEngine } from '../src/audio/engine.js';
import { MixGraph } from '../src/audio/mixer.js';
import { buildDawproject, exportDawproject, importDawproject } from '../src/io/interchange/dawproject.js';
import { parseXml, child, children } from '../src/io/interchange/xml.js';
import { MockContext, latentEffectFactory } from './lib/mock-audio.js';
import { loadSchema } from './lib/xsd-lite.js';

const zlibCodec = { deflateRaw: (b) => zlib.deflateRawSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };
const PROJECT_XSD = loadSchema(fs.readFileSync(new URL('./fixtures/dawproject/Project.xsd', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function mixProject() {
  const p = createProject({ name: 'VCA', bpm: 120 });
  p.mode = 'song';
  const kick = createTrack({ name: 'Kick', instrument: { type: 'drums', preset: '909', params: {} } });
  const snare = createTrack({ name: 'Snare', instrument: { type: 'drums', preset: '909', params: {} } });
  const bass = createTrack({ name: 'Bass', instrument: { type: 'synth', preset: null, params: {} } });
  p.tracks.push(kick, snare, bass);
  for (const t of p.tracks) {
    const pat = createPattern(t.id, { length: 4, notes: [createNote(36, 0, 0.5, 0.9)] });
    p.patterns[pat.id] = pat;
    t.activePatternId = pat.id;
    p.clips.push(createClip(t.id, { patternId: pat.id, start: 0, length: 16 }));
  }
  const f = createFolder(p, 'Drums', [kick.id, snare.id]);
  setFolderSum(p, f.id, true, () => createBus('Drums'));
  f.collapsed = true;
  const vca = createVca(p, 'All music', [kick.id, snare.id, bass.id], { volume: 0.8 });
  vca.automation = [createAutomationLane('volume', [{ beat: 0, value: 1 }, { beat: 8, value: 0.25 }, { beat: 16, value: 1 }])];
  createGroup(p, 'Rhythm', [kick.id, bass.id]);
  return { p, kick, snare, bass, vca, folder: f };
}

test('VCA owners: Arrange row metadata — kind, colour, a single level target on a 0 dB-centred lane', () => {
  const { p, vca } = mixProject();
  assert.equal(automationOwner(p, vca.id), vca);
  const oi = ownerInfo(p, vca.id);
  assert.equal(oi.kind, 'vca');
  assert.equal(oi.color, VCA_COLOR);
  const v = ownerView(p, vca.id);
  assert.equal(v.kind, 'vca');
  assert.deepEqual(v.members, vca.members);
  const groups = targetGroups(p, vca.id);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.target)), [['volume']]);
  const info = targetInfo(p, vca.id, 'volume');
  assert.equal(info.missing, false);
  assert.equal(info.staticValue, 0.8);
  assert.equal(info.def.max, 4);
  assert.ok(near(toNorm(info.def, 1), 0.5), '0 dB in the middle of the lane');
  assert.ok(targetInfo(p, vca.id, 'pan').missing);
  assert.equal(laneLabel(p, vca.id, 'volume'), 'All music › VCA level');
  // the recorder sees VCA faders (touch / latch writes go to the VCA lane)
  assert.equal(snapshotTargets(p).get(`${vca.id}|volume`), 0.8);
});

test('VCA lane playback: drawn points ramp every member strip\'s VCA gain; the write override hands back the fader', () => {
  const { p, kick, bass, vca } = mixProject();
  const ctx = new MockContext({ sampleRate: 48000 });
  const g = new MixGraph(ctx, { destination: ctx.destination, getBpm: () => 120, getBeatAt: () => 0, getSampleBuffer: () => null, createEffect: latentEffectFactory(() => 0) });
  g.sync(p);
  const calls = new Map();
  for (const t of [kick, bass]) {
    const prm = g.tracks.get(t.id).strip.vcaGain.gain;
    const log = [];
    calls.set(t.id, log);
    for (const k of ['setValueAtTime', 'linearRampToValueAtTime']) {
      const orig = prm[k].bind(prm);
      prm[k] = (v, time) => { log.push([k, +v.toFixed(6), +time.toFixed(6)]); return orig(v, time); };
    }
  }
  g.automateMixer(p, 0, 16, 0, 0.5, 'seek');
  for (const [, log] of calls) {
    const ramps = log.filter((x) => x[0] === 'linearRampToValueAtTime');
    assert.ok(ramps.some(([, v, t]) => near(v, 0.25) && near(t, 4)), `ramps to the drawn 0.25 at beat 8 (4 s): ${JSON.stringify(log)}`);
    assert.ok(ramps.some(([, v, t]) => near(v, 1) && near(t, 8)));
  }
  assert.deepEqual(vcaCombinedLane(p, kick.id).points.map((x) => x.value), [1, 0.25, 1]);
  // write override (automation recording): the engine ignores the VCA lane while the user rides the VCA fader
  const view = AudioEngine.prototype._withoutOverrides.call({ _overrides: new Set([`${vca.id}|volume`]) }, p);
  assert.equal(mixerOf(view).vcas[0].automation.length, 0);
  assert.equal(vcaCombinedLane(view, kick.id), null, 'members follow the live VCA fader');
  assert.equal(mixerOf(p).vcas[0].automation.length, 1, 'the project itself is untouched');
  // engine readback for the fader animation
  const fake = { _playing: true, project: p, _overrides: new Set(), getAudiblePosition: () => 8 };
  assert.equal(AudioEngine.prototype.getAutomatedValue.call(fake, vca.id, 'volume'), 0.25);
  fake._overrides.add(`${vca.id}|volume`);
  assert.equal(AudioEngine.prototype.getAutomatedValue.call(fake, vca.id, 'volume'), null);
  assert.equal(valueAt(vca.automation[0].points, 4), 0.625);
});

test('DAWproject: folders -> group tracks with their summing bus as submix channel; VCAs / groups round-trip via daw3/mixer.json', async () => {
  const { p, kick, snare, bass, vca, folder } = mixProject();
  const out = buildDawproject(p);
  assert.deepEqual(PROJECT_XSD.validate(out.projectXml), []);
  const root = parseXml(out.projectXml);
  const top = children(child(root, 'Structure'), 'Track');
  const fold = top.find((t) => t.attrs.contentType === 'tracks');
  assert.equal(fold.attrs.name, 'Drums');
  assert.deepEqual(children(fold, 'Track').map((t) => t.attrs.name), ['Kick', 'Snare']);
  const sub = child(fold, 'Channel');
  assert.equal(sub.attrs.role, 'submix');
  for (const t of children(fold, 'Track')) assert.equal(child(t, 'Channel').attrs.destination, sub.attrs.id, 'members feed the group channel');
  assert.ok(!top.some((t) => t.attrs.name === 'Drums' && child(t, 'Channel')?.attrs.role === 'effect'), 'the folder bus is not also a return');
  assert.ok(out.files.some((f) => f.path === 'daw3/mixer.json'));
  assert.match(out.report.unmapped.join('\n'), /VCA "All music" \(3 members, level automation\)/);

  const { bytes } = await exportDawproject(p, { codec: zlibCodec });
  const { project: q, report } = await importDawproject(bytes, { codec: zlibCodec });
  const byName = (n) => q.tracks.find((t) => t.name === n);
  const mq = mixerOf(q);
  assert.equal(mq.folders.length, 1);
  assert.equal(mq.folders[0].name, 'Drums');
  assert.equal(mq.folders[0].collapsed, true);
  const fb = q.buses.find((b) => b.id === mq.folders[0].busId);
  assert.ok(fb && fb.folderId === mq.folders[0].id);
  assert.deepEqual(q.tracks.filter((t) => t.folderId === mq.folders[0].id).map((t) => t.name), ['Kick', 'Snare']);
  assert.equal(byName('Kick').output, fb.id);
  assert.ok(!byName('Bass').output);
  assert.equal(mq.vcas.length, 1);
  const qv = mq.vcas[0];
  assert.equal(qv.name, 'All music');
  assert.equal(qv.volume, 0.8);
  assert.deepEqual(qv.members, ['Kick', 'Snare', 'Bass'].map((n) => byName(n).id));
  assert.deepEqual(qv.automation[0].points, vca.automation[0].points);
  assert.deepEqual(mq.groups.map((x) => [x.name, x.members.map((id) => q.tracks.find((t) => t.id === id).name)]), [['Rhythm', ['Kick', 'Bass']]]);
  assert.equal(q.buses.filter((b) => b.name === 'Drums').length, 1);
  assert.match(report.mapped.join('\n'), /1 VCA\(s\), 1 group\(s\) restored/);
  void kick; void snare; void bass; void folder;
});
