// Pro export: ranges, naming templates, tail detection, stem variants, WAV metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange, clipSpan, formatFileName, uniqueNames, detectTail, stemTargets, stemProject, reportText, EXPORT_DEFAULTS } from '../src/io/export-plan.js';
import { addWavMetadata, readWavMetadata, cleanIsrc } from '../src/io/wav-meta.js';
import { encodeWav, decodeWav } from '../src/io/wav.js';
import { createProject, createTrack, createClip, createEffect } from '../src/core/model.js';
import { createGroup, createFolder, setFolderSum } from '../src/core/mixer-model.js';
import { measureLoudness } from '../src/audio/dsp/loudness.js';

function song() {
  const p = createProject({ name: 'Night Drive', bpm: 124 });
  const a = createTrack({ name: 'Kick' }), b = createTrack({ name: 'Bass' }), c = createTrack({ name: 'Pad' });
  p.tracks = [a, b, c];
  p.clips = [createClip(a.id, { start: 0, length: 32 }), createClip(b.id, { start: 8, length: 16 })];
  p.loop = { enabled: true, start: 4, end: 12 };
  return p;
}

test('ranges: song / loop / selection / custom bars', () => {
  const p = song();
  assert.deepEqual(resolveRange(p, { range: 'song' }).endBeat, 32);
  const l = resolveRange(p, { range: 'loop' });
  assert.ok(l.startBeat === 4 && l.endBeat === 12);
  const sel = clipSpan(p, [p.clips[1].id]);
  assert.deepEqual(sel, { start: 8, end: 24 });
  assert.equal(resolveRange(p, { range: 'selection', selection: sel }).startBeat, 8);
  const c = resolveRange(p, { range: 'custom', custom: { start: 2, end: 6 } });
  assert.ok(c.startBeat === 4 && c.endBeat === 20);
});

test('file naming templates', () => {
  const p = song();
  const now = new Date(2026, 9, 14, 9, 5);
  assert.equal(formatFileName('{project}', { project: p }, now), 'Night Drive');
  assert.equal(formatFileName('{artist} - {title} [{bpm} {key}] {date}', { project: p, artist: 'Ada', title: 'Drive' }, now), 'Ada - Drive [124 Cm] 2026-10-14');
  assert.equal(formatFileName('{project} - {n} {stem}', { project: p, n: 3, stem: 'Bass/Sub' }, now), 'Night Drive - 03 Bass_Sub');
  assert.equal(formatFileName('{project}_{sr}_{bits}_{lufs}', { project: p, sampleRate: 44100, bits: '24bit', lufs: -14.2 }, now), 'Night Drive_44.1k_24bit_-14LUFS');
  assert.equal(formatFileName('{nope} x', { project: p }, now), '{nope} x');
  assert.equal(formatFileName('{artist} - {project}', { project: p }, now), 'Night Drive'); // empty artist: no dangling dash
  assert.equal(formatFileName('', { project: { name: 'a:b' } }, now), 'a_b');
  const u = uniqueNames();
  assert.deepEqual([u('Mix'), u('mix'), u('Mix')], ['Mix', 'mix 2', 'Mix 3']);
  assert.equal(EXPORT_DEFAULTS.ceiling, -1);
});

test('tail detection keeps the reverb tail and cuts the silence', () => {
  const sr = 1000;
  const ch = new Float32Array(5000);
  for (let i = 0; i < 2000; i++) ch[i] = 0.5;
  for (let i = 2000; i < 3200; i++) ch[i] = 0.5 * Math.exp(-(i - 2000) / 100); // decays below −80 dB ~ 1.4 s later
  const keep = detectTail([ch], sr, { musicFrames: 2000, thresholdDb: -60, guard: 0.05 });
  assert.ok(keep > 2600 && keep < 3000, `keep ${keep}`);
  assert.equal(detectTail([new Float32Array(100)], sr, { musicFrames: 40, guard: 0 }), 40);
});

test('stem targets + variants (track / bus / group, pre / post fader, master on / off)', () => {
  const p = song();
  const [a, b, c] = p.tracks;
  const rev = p.buses[0];
  b.sends = { [rev.id]: 0.3 };
  b.volume = 0.5;
  b.fx = [createEffect('ducker', { sourceTrackId: a.id })];
  createGroup(p, 'Low end', [a.id, b.id]);
  assert.deepEqual(stemTargets(p).map((t) => t.name), ['Kick', 'Bass', 'Pad']);
  assert.deepEqual(stemTargets(p, { which: 'groups' }).map((t) => [t.name, t.trackIds.length]), [['Low end', 2], ['Pad', 1]]);
  const buses = stemTargets(p, { which: 'buses' });
  assert.deepEqual(buses.map((t) => t.id), [rev.id]);
  assert.deepEqual(stemTargets(p, { which: 'selected', selectedIds: [c.id] }).map((t) => t.id), [c.id]);
  // post-fader track stem: fader kept, kick plays silently as the ducker key, master bypassed
  const post = stemProject(p, { kind: 'track', id: b.id, trackIds: [b.id] });
  const pb = post.tracks.find((t) => t.id === b.id), pa = post.tracks.find((t) => t.id === a.id);
  assert.ok(pb.volume === 0.5 && pb.sends[rev.id] === 0.3 && !pb.mute);
  assert.ok(pa.volume === 0 && !pa.mute);
  assert.ok(post.tracks.find((t) => t.id === c.id).mute);
  assert.equal(post.master.fx.length, 0);
  const pre = stemProject(p, { kind: 'track', id: b.id, trackIds: [b.id] }, { tap: 'pre', master: true });
  const qb = pre.tracks.find((t) => t.id === b.id);
  assert.ok(qb.volume === 1 && Object.keys(qb.sends).length === 0);
  assert.ok(pre.master.fx.length > 0);
  // bus stem: senders feed the bus only (main outs off), other buses muted
  const bs = stemProject(p, buses[0]);
  assert.equal(bs.tracks.find((t) => t.id === b.id)._noDirect, true);
  assert.ok(bs.buses.filter((x) => x.id !== rev.id).every((x) => x.mute));
  // folder sum bus stem: routed tracks keep their main out (it *is* the bus)
  const f = createFolder(p, 'Synths', [c.id]);
  const fb = setFolderSum(p, f.id, true);
  const fs = stemProject(p, stemTargets(p, { which: 'buses' }).find((t) => t.id === fb.id));
  assert.equal(fs.tracks.find((t) => t.id === c.id)._noDirect, false);
});

test('WAV metadata: INFO + iXML chunks, file still decodes', () => {
  const sr = 48000;
  const l = new Float32Array(480).fill(0.25);
  const wav = encodeWav([l, l], { bitDepth: 24, sampleRate: sr });
  const out = addWavMetadata(wav, { title: 'Night Drive', artist: 'Ada & Co', isrc: 'us-abc-24-00001', comment: 'mix v3', bpm: 124 });
  const meta = readWavMetadata(out);
  assert.equal(meta.info.INAM, 'Night Drive');
  assert.equal(meta.info.IART, 'Ada & Co');
  assert.equal(meta.info.ISRC, 'USABC2400001');
  assert.match(meta.ixml, /<ARTIST>Ada &amp; Co<\/ARTIST>/);
  assert.match(meta.ixml, /<TEMPO>124<\/TEMPO>/);
  const dec = decodeWav(out);
  assert.equal(dec.channels[0].length, 480);
  assert.equal(new DataView(out).getUint32(4, true), out.byteLength - 8);
  assert.equal(cleanIsrc('nope'), '');
  const m = measureLoudness(dec.channels, sr, { truePeak: false });
  assert.ok(m.duration > 0);
  assert.match(reportText('x', m, { gainDb: 1.5 }), /Normalise gain\s+\+1.50 dB/);
});
