import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { writeZip, readZip, zipText, crc32, isZip, defaultCodec } from '../src/io/interchange/zip.js';
import { el, toXml, parseXml, child, children } from '../src/io/interchange/xml.js';
import { wavInfo } from '../src/io/interchange/media.js';
import { buildDawproject, exportDawproject, importDawproject, parseDawproject, summarizeReport } from '../src/io/interchange/dawproject.js';
import { stemVariant, stemRenderPlan, renderStems, buildMixBundle, tempoMapText } from '../src/io/interchange/stems.js';
import { exportMusicXml, parseMusicXml, readMusicXmlFile, addMusicXmlToProject, splitDuration, harmonyChords, DIVISIONS } from '../src/io/interchange/musicxml.js';
import { createProject, createTrack, createPattern, createNote, createClip, createEffect } from '../src/core/model.js';
import { createAutomationLane, valueAt } from '../src/core/automation.js';
import { collectTrackNotes, importMidi } from '../src/io/midi.js';
import { encodeWav } from '../src/io/wav.js';
import { arrayBufferToBase64 } from '../src/io/samples.js';
import { loadSchema } from './lib/xsd-lite.js';

const zlibCodec = { deflateRaw: (b) => zlib.deflateRawSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };
const PROJECT_XSD = loadSchema(fs.readFileSync(new URL('./fixtures/dawproject/Project.xsd', import.meta.url), 'utf8'));
const METADATA_XSD = loadSchema(fs.readFileSync(new URL('./fixtures/dawproject/MetaData.xsd', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

/** AudioBuffer-like object (what encodeWav / renderOffline deal in). */
function fakeBuffer(seconds, sampleRate = 44100, channels = 2, freq = 220) {
  const length = Math.round(seconds * sampleRate);
  const data = Array.from({ length: channels }, (_, c) => Float32Array.from({ length }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * (c + 1) * i) / sampleRate)));
  return { numberOfChannels: channels, sampleRate, length, duration: length / sampleRate, getChannelData: (c) => data[c] };
}

function richProject() {
  const p = createProject({ name: 'Interchange Demo', bpm: 124 });
  p.timeSig = [4, 4];
  p.key = { root: 9, scale: 'minor' };
  const drums = createTrack({ name: 'Drums', instrument: { type: 'drums', preset: '909', params: {} }, role: 'drums' });
  const bass = createTrack({ name: 'Bass', instrument: { type: 'synth', preset: 'acid-bass', params: { cutoff: 900 } }, role: 'bass' });
  const keys = createTrack({ name: 'Keys', instrument: { type: 'fm', preset: null, params: {} }, role: 'chords' });
  const vox = createTrack({ name: 'Vox', type: 'audio' });
  const code = createTrack({ name: 'Hats code', type: 'code' });
  code.code = 's("hh*4")';
  bass.fx.push(createEffect('compressor', { threshold: -24, ratio: 6, attack: 0.005 }), createEffect('eq8', { b2Gain: -3 }), createEffect('delay', { mix: 0.3 }));
  bass.sends[p.buses[0].id] = 0.25;
  keys.sends[p.buses[1].id] = 0.4;
  bass.volume = 0.65; bass.pan = -0.3; keys.mute = true; drums.solo = false; vox.pan = 0.4;
  p.tracks.push(drums, bass, keys, vox, code);
  const dp = createPattern(drums.id, { name: 'Beat', length: 4, notes: [createNote(36, 0, 0.25, 1), createNote(42, 0.5, 0.25, 0.6), createNote(38, 1, 0.25, 0.9), createNote(36, 2.5, 0.25, 0.8)] });
  const bp = createPattern(bass.id, { name: 'Line', length: 2, notes: [createNote(33, 0, 0.5, 0.9), createNote(45, 0.75, 0.25, 0.55), createNote(40, 1.5, 0.5, 0.7)] });
  const kp = createPattern(keys.id, { name: 'Chords', length: 8, notes: [57, 60, 64].map((x) => createNote(x, 0, 4, 0.6)).concat([53, 57, 60].map((x) => createNote(x, 4, 4, 0.6))) });
  for (const pat of [dp, bp, kp]) p.patterns[pat.id] = pat;
  drums.activePatternId = dp.id; bass.activePatternId = bp.id; keys.activePatternId = kp.id;
  p.clips.push(
    createClip(drums.id, { patternId: dp.id, start: 0, length: 16 }),
    createClip(drums.id, { patternId: dp.id, start: 20, length: 4 }),
    createClip(bass.id, { patternId: bp.id, start: 4, length: 7, offset: 1 }),
    createClip(keys.id, { patternId: kp.id, start: 0, length: 16 }),
  );
  const wav = new Uint8Array(encodeWav(fakeBuffer(1.5, 44100, 1), { bitDepth: 16 }));
  p.samples.smp_vox = { id: 'smp_vox', name: 'vocal take', mime: 'audio/wav', data: arrayBufferToBase64(wav), duration: 1.5 };
  const vclip = createClip(vox.id, { type: 'audio', sampleId: 'smp_vox', start: 8, length: 2, offset: 0.5 });
  vclip.fadeIn = 0.25; vclip.fadeOut = 0.5;
  p.clips.push(vclip);
  bass.automation.push(
    createAutomationLane('volume', [{ beat: 0, value: 0.2 }, { beat: 8, value: 1.1 }]),
    createAutomationLane('pan', [{ beat: 0, value: -1 }, { beat: 16, value: 1 }]),
    createAutomationLane(`send:${p.buses[0].id}`, [{ beat: 4, value: 0 }, { beat: 12, value: 0.8 }]),
    createAutomationLane(`fx:${bass.fx[0].id}:threshold`, [{ beat: 0, value: -30 }, { beat: 4, value: -10 }]),
    createAutomationLane(`fx:${bass.fx[0].id}:ratio`, [{ beat: 0, value: 2 }, { beat: 4, value: 8 }]),
    createAutomationLane(`fx:${bass.fx[2].id}:mix`, [{ beat: 0, value: 0 }, { beat: 8, value: 0.5 }]),
    createAutomationLane(`fxen:${bass.fx[1].id}`, [{ beat: 0, value: 1 }, { beat: 8, value: 0 }]),
    createAutomationLane('inst:cutoff', [{ beat: 0, value: 400 }, { beat: 16, value: 4000 }]),
    createAutomationLane('mute', [{ beat: 0, value: 0 }, { beat: 12, value: 1 }]),
    createAutomationLane('cable:c_1', [{ beat: 0, value: 1 }]),
  );
  p.buses[0].automation.push(createAutomationLane('volume', [{ beat: 0, value: 0.5 }, { beat: 4, value: 0.9 }]));
  p.master.automation.push(createAutomationLane('volume', [{ beat: 0, value: 0.9 }, { beat: 24, value: 0 }]));
  p.markers.push({ id: 'mk1', beat: 0, name: 'Intro' }, { id: 'mk2', beat: 16, name: 'Drop' });
  p.tempoMap = [{ beat: 0, bpm: p.bpm, curve: 'linear' }, { beat: 16, bpm: 130, curve: 'jump' }, { beat: 32, bpm: 128, curve: 'jump' }];
  p.meterMap = [{ bar: 6, num: 7, den: 8 }, { bar: 7, num: 4, den: 4 }];
  p.mode = 'song';
  return p;
}

// --------------------------------------------------------------------------------------- ZIP

test('ZIP: store + deflate round trip (node:zlib codec), unicode names, CRC', async () => {
  const big = 'daW³ '.repeat(5000);
  const bin = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7919) & 0xff);
  const bytes = await writeZip([
    { name: 'project.xml', data: big },
    { name: 'audio/klänge ü.wav', data: bin, compress: false },
    { name: 'empty.txt', data: '' },
  ], { codec: zlibCodec });
  assert.ok(isZip(bytes));
  assert.ok(bytes.length < big.length / 4, 'text is deflated');
  const files = await readZip(bytes, { codec: zlibCodec });
  assert.deepEqual([...files.keys()], ['project.xml', 'audio/klänge ü.wav', 'empty.txt']);
  assert.equal(zipText(files, 'project.xml'), big);
  assert.deepEqual(files.get('audio/klänge ü.wav'), bin);
  assert.equal(files.get('empty.txt').length, 0);
  // the default codec (CompressionStream in Node >= 21) reads what node:zlib wrote and vice versa
  const again = await readZip(bytes, { codec: defaultCodec });
  assert.equal(zipText(again, 'project.xml'), big);
  const viaStreams = await writeZip([{ name: 'a.txt', data: big }]);
  assert.equal(zipText(await readZip(viaStreams, { codec: zlibCodec }), 'a.txt'), big);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  // corruption is detected
  const bad = bytes.slice();
  const pos = bytes.indexOf(0x50, 40) + 200;
  bad[pos] ^= 0xff;
  await assert.rejects(() => readZip(bad, { codec: zlibCodec }));
  await assert.rejects(() => readZip(new Uint8Array(30)), /Not a ZIP/);
});

test('ZIP: the archive is readable by the system unzip when available', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('unzip', ['-v']).status !== 0) { t.skip('unzip not installed'); return; }
  const dir = fs.mkdtempSync('/tmp/daw3-zip-');
  const file = `${dir}/t.zip`;
  fs.writeFileSync(file, await writeZip([{ name: 'x/project.xml', data: '<a>' + 'b'.repeat(500) + '</a>' }], { codec: zlibCodec }));
  const r = spawnSync('unzip', ['-t', file]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
});

// --------------------------------------------------------------------------------------- XML

test('XML: write / parse round trip with escaping', () => {
  const doc = el('Root', { a: 'x < y & "z"', n: 0.1 + 0.2, skip: undefined }, el('Child', { id: 'c1' }, 'text & <more>'), el('Empty'));
  const xml = toXml(doc);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"/);
  assert.match(xml, /n="0.3"/);
  const back = parseXml(xml);
  assert.equal(back.attrs.a, 'x < y & "z"');
  assert.equal(child(back, 'Child').text, 'text & <more>');
  assert.equal(children(back).length, 2);
  assert.equal(parseXml('<!DOCTYPE x [<!ENTITY a "b">]><!-- c --><x y=\'1\'><![CDATA[<raw>]]>&#65;&#x42;</x>').text, '<raw>AB');
  assert.throws(() => parseXml('<a><b></a>'), /expected <\/b>/);
  assert.throws(() => parseXml('<a></a><b/>'), /root/);
});

// ------------------------------------------------------------------------------- DAWproject

test('DAWproject export validates against the official Project.xsd / MetaData.xsd', () => {
  const p = richProject();
  const renders = { [p.tracks[1].id]: { data: new Uint8Array(encodeWav(fakeBuffer(0.5), { bitDepth: 24 })), sampleRate: 44100, channels: 2, duration: 0.5 } };
  const out = buildDawproject(p, { renders });
  assert.deepEqual(PROJECT_XSD.validate(out.projectXml), []);
  assert.deepEqual(METADATA_XSD.validate(out.metadataXml), []);
  const root = parseXml(out.projectXml);
  assert.equal(root.attrs.version, '1.0');
  assert.equal(child(root, 'Application').attrs.name, 'daW³');
  // required structure the importers rely on
  const tracks = children(child(root, 'Structure'), 'Track');
  assert.ok(tracks.find((t) => child(t, 'Channel')?.attrs.role === 'master'));
  assert.equal(tracks.filter((t) => child(t, 'Channel')?.attrs.role === 'effect').length, 2);
  assert.ok(tracks.find((t) => t.attrs.name === 'Bass (audio)'), 'rendered companion track');
  assert.ok(out.files.some((f) => f.path.startsWith('audio/') && f.path.endsWith('.wav')));
  assert.ok(out.files.some((f) => f.path.startsWith('plugins/')));
  assert.match(out.report.unmapped.join('\n'), /cable:c_1/);
  // the validator itself catches broken documents
  const broken = out.projectXml.replace('<TimeSignature ', '<TimeSignature bogus="1" ').replace(/ unit="bpm"/, '');
  const errs = PROJECT_XSD.validate(broken);
  assert.ok(errs.some((e) => /bogus/.test(e)) && errs.some((e) => /required attribute "unit"/.test(e)), errs.join('\n'));
  assert.ok(PROJECT_XSD.validate(out.projectXml.replace(/destination="(id\d+)"/, 'destination="nope"')).some((e) => /IDREF/.test(e)));
  assert.ok(PROJECT_XSD.validate(out.projectXml.replace('<Transport>', '<Transport><Bogus/>')).some((e) => /content model/.test(e)));
});

test('DAWproject round trip: export -> import gives an equivalent project', async () => {
  const p = richProject();
  const { bytes, report: exReport } = await exportDawproject(p, { codec: zlibCodec });
  assert.ok(isZip(bytes));
  const files = await readZip(bytes, { codec: zlibCodec });
  assert.ok(files.has('project.xml') && files.has('metadata.xml'));
  const { project: q, report } = await importDawproject(bytes, { codec: zlibCodec });
  assert.ok(exReport.mapped.length >= 8);

  assert.equal(q.name, 'Interchange Demo');
  assert.equal(q.bpm, 124);
  assert.deepEqual(q.timeSig, [4, 4]);
  // tempo map (ramp + jump) and meter changes round-trip exactly
  assert.deepEqual(q.tempoMap, [{ beat: 0, bpm: 124, curve: 'linear' }, { beat: 16, bpm: 130, curve: 'jump' }, { beat: 32, bpm: 128, curve: 'jump' }]);
  assert.deepEqual(q.meterMap, [{ bar: 6, num: 7, den: 8 }, { bar: 7, num: 4, den: 4 }]);
  assert.deepEqual(q.markers.map((m) => [m.beat, m.name]), [[0, 'Intro'], [16, 'Drop']]);
  assert.deepEqual(q.tracks.map((t) => [t.name, t.type]), p.tracks.map((t) => [t.name, t.type]));
  assert.deepEqual(q.buses.map((b) => b.name), p.buses.map((b) => b.name));
  assert.equal(q.master.volume, p.master.volume);
  assert.deepEqual(q.master.fx.map((f) => f.type), ['limiter']);

  for (const [a, b] of p.tracks.map((t, i) => [t, q.tracks[i]])) {
    assert.ok(near(a.volume, b.volume) && near(a.pan, b.pan), `${a.name} volume/pan`);
    assert.equal(!!a.mute, !!b.mute);
    assert.equal(!!a.solo, !!b.solo);
    assert.deepEqual(b.instrument, a.instrument, `${a.name} instrument restored from State`);
    assert.deepEqual(b.fx.map((f) => [f.type, f.enabled, f.params]), a.fx.map((f) => [f.type, f.enabled, f.params]));
    // sends by bus name
    const sendsByName = (proj, t) => Object.fromEntries(Object.entries(t.sends).map(([id, v]) => [proj.buses.find((x) => x.id === id).name, v]));
    assert.deepEqual(sendsByName(q, b), sendsByName(p, a));
    // every note the track plays in song mode
    if (a.type === 'instrument') {
      const na = collectTrackNotes(p, a, 'song').map((n) => [n.pitch, +n.start.toFixed(4), +n.dur.toFixed(4), +n.vel.toFixed(4)]);
      const nb = collectTrackNotes(q, b, 'song').map((n) => [n.pitch, +n.start.toFixed(4), +n.dur.toFixed(4), +n.vel.toFixed(4)]);
      assert.deepEqual(nb, na, `${a.name} notes`);
    }
  }
  assert.equal(q.tracks[4].code, 's("hh*4")');
  // clip structure: same starts / lengths / offsets, shared patterns stay shared
  const clipSig = (proj) => proj.clips.map((c) => [proj.tracks.find((t) => t.id === c.trackId).name, c.type, c.start, c.length, c.offset]).sort((x, y) => String(x).localeCompare(String(y)));
  assert.deepEqual(clipSig(q), clipSig(p));
  const drumClips = q.clips.filter((c) => c.trackId === q.tracks[0].id);
  assert.equal(drumClips[0].patternId, drumClips[1].patternId, 'identical clips share one pattern');
  assert.equal(q.patterns[drumClips[0].patternId].length, 4);
  // audio clip: sample bytes, offset, fades
  const vc = q.clips.find((c) => c.type === 'audio');
  assert.equal(q.samples[vc.sampleId].data, p.samples.smp_vox.data);
  assert.equal(q.samples[vc.sampleId].name, 'vocal take');
  assert.ok(near(vc.offset, 0.5) && near(vc.fadeIn, 0.25) && near(vc.fadeOut, 0.5));
  // automation: every mappable lane comes back on the same target (fx ids are new) with the same points
  const lanes = (proj, owner) => Object.fromEntries(owner.automation.map((l) => {
    let target = l.target;
    for (const [i, fx] of (owner.fx || []).entries()) target = target.replace(fx.id, `#${i}`);
    for (const b of proj.buses) target = target.replace(b.id, b.name);
    return [target, l.points.map((x) => [x.beat, +x.value.toFixed(4)])];
  }));
  const expected = lanes(p, p.tracks[1]);
  const got = lanes(q, q.tracks[1]);
  delete expected['cable:c_1'];
  // step lanes (mute, effect on/off) come back as hold steps at the switch point: compare what they do
  const stepped = ['mute', 'fxen:#1'];
  for (const k of stepped) {
    const pa = expected[k].map(([beat, value]) => ({ beat, value }));
    const pb = got[k].map(([beat, value]) => ({ beat, value }));
    for (let b = 0; b <= 20; b += 0.25) assert.equal(valueAt(pb, b + 0.01) >= 0.5, valueAt(pa, b + 0.01) >= 0.5, `${k} at beat ${b}`);
    delete expected[k]; delete got[k];
  }
  assert.deepEqual(got, expected);
  assert.deepEqual(lanes(q, q.buses[0]), lanes(p, p.buses[0]));
  assert.deepEqual(lanes(q, q.master), lanes(p, p.master));
  assert.equal(q.mode, 'song');
  assert.equal(typeof summarizeReport(report), 'string');
});

test('DAWproject: rendered instrument audio is written alongside MIDI and skipped on daW³ re-import', async () => {
  const p = richProject();
  const bass = p.tracks[1];
  const renders = { [bass.id]: { data: new Uint8Array(encodeWav(fakeBuffer(2), { bitDepth: 24 })), sampleRate: 44100, channels: 2, duration: 2 } };
  const { bytes } = await exportDawproject(p, { renders, codec: zlibCodec });
  const files = await readZip(bytes, { codec: zlibCodec });
  const xml = zipText(files, 'project.xml');
  const root = parseXml(xml);
  const comp = children(child(root, 'Structure'), 'Track').find((t) => t.attrs.name === 'Bass (audio)');
  assert.equal(comp.attrs.contentType, 'audio');
  const file = [...files.keys()].find((n) => /Bass \(rendered\)\.wav$/.test(n));
  assert.ok(file);
  assert.equal(wavInfo(files.get(file)).duration, 2);
  // the companion carries the fader automation of the MIDI track
  const lanesEl = children(child(child(root, 'Arrangement'), 'Lanes'), 'Lanes').find((l) => l.attrs.track === comp.attrs.id);
  assert.ok(children(lanesEl, 'Points').length >= 3);
  const { project: q } = await importDawproject(bytes, { codec: zlibCodec });
  assert.ok(!q.tracks.some((t) => t.name === 'Bass (audio)'));
  const { project: q2 } = await importDawproject(bytes, { codec: zlibCodec, skipRendered: false });
  const t2 = q2.tracks.find((t) => t.name === 'Bass (audio)');
  assert.equal(t2.type, 'audio');
  assert.equal(q2.clips.filter((c) => c.trackId === t2.id).length, 1);
});

const FOREIGN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project version="1.0">
  <Application name="Bitwig Studio" version="5.0"/>
  <Transport>
    <Tempo max="666.000000" min="20.000000" unit="bpm" value="149.000000" id="id0" name="Tempo"/>
    <TimeSignature denominator="4" numerator="3" id="id1"/>
  </Transport>
  <Structure>
    <Track contentType="tracks" loaded="true" id="g1" name="Band">
      <Channel audioChannels="2" destination="id15" role="submix" id="g1c"><Volume unit="linear" value="0.5" id="g1v"/></Channel>
      <Track contentType="notes" loaded="true" id="id2" name="Bass" color="#a2eabf">
        <Channel audioChannels="2" destination="g1c" role="regular" solo="false" id="id3">
          <Devices>
            <ClapPlugin deviceID="org.surge-synth-team.surge-xt" deviceName="Surge XT" deviceRole="instrument" loaded="true" id="id7" name="Surge XT">
              <Parameters><RealParameter id="p1" name="Cutoff" unit="normalized" value="0.4"/></Parameters>
              <Enabled value="true" id="id8" name="On/Off"/>
              <State path="plugins/d19b1f6e.clap-preset"/>
            </ClapPlugin>
            <Compressor deviceName="Bus Comp" deviceRole="audioFX" id="c1">
              <Ratio unit="percent" value="75" id="c1r"/>
              <Threshold unit="decibel" value="-12" id="c1t"/>
            </Compressor>
            <Vst3Plugin deviceName="ValhallaRoom" deviceRole="audioFX" deviceVendor="Valhalla DSP" id="v1"><Enabled value="false" id="v1e"/></Vst3Plugin>
            <Vst3Plugin deviceName="Soothe2" deviceRole="audioFX" deviceVendor="oeksound" id="v2"/>
          </Devices>
          <Mute value="false" id="id6" name="Mute"/>
          <Pan max="1.000000" min="0.000000" unit="normalized" value="0.250000" id="id5" name="Pan"/>
          <Sends><Send destination="fx1c" type="post" id="s1"><Volume unit="linear" min="0" max="1" value="0.3" id="s1v"/></Send></Sends>
          <Volume max="2.000000" min="0.000000" unit="linear" value="0.659140" id="id4" name="Volume"/>
        </Channel>
      </Track>
    </Track>
    <Track contentType="audio" loaded="true" id="id9" name="Drumloop" color="#b53bba">
      <Channel audioChannels="2" destination="id15" role="regular" solo="true" id="id10">
        <Mute value="true" id="id13" name="Mute"/>
        <Volume max="2.000000" min="0.000000" unit="linear" value="0.177125" id="id11" name="Volume"/>
      </Channel>
    </Track>
    <Track contentType="audio" loaded="true" id="fx1" name="Hall">
      <Channel audioChannels="2" destination="id15" role="effect" id="fx1c">
        <Devices><BuiltinDevice deviceName="Reverb" deviceRole="audioFX" id="r1"/></Devices>
        <Volume unit="linear" value="1" id="fx1v"/>
      </Channel>
    </Track>
    <Track contentType="audio notes" loaded="true" id="id14" name="Master">
      <Channel audioChannels="2" role="master" solo="false" id="id15">
        <Volume max="2.000000" min="0.000000" unit="linear" value="1.000000" id="id16" name="Volume"/>
      </Channel>
    </Track>
  </Structure>
  <Arrangement id="id19">
    <Lanes timeUnit="beats" id="id20">
      <Lanes track="id2" id="id21">
        <Clips id="id22">
          <Clip time="0.0" duration="8.0" playStart="0.0">
            <Notes id="id23">
              <Note time="0.000000" duration="0.250000" channel="0" key="65" vel="0.787402" rel="0.787402"/>
              <Note time="1.500000" duration="2.500000" channel="0" key="53" vel="0.5" rel="0.787402"/>
            </Notes>
          </Clip>
          <Clip time="8.0" duration="8.0" playStart="0.0" loopStart="0" loopEnd="2" enable="false"><Notes id="id24"/></Clip>
        </Clips>
        <Points id="a1" unit="linear"><Target parameter="id4"/><RealPoint time="0" value="0.2" interpolation="hold"/><RealPoint time="4" value="1" interpolation="linear"/></Points>
        <Points id="a2"><Target parameter="p1"/><RealPoint time="0" value="0.1"/></Points>
        <Points id="a3"><Target channel="0" controller="74"/><RealPoint time="0" value="0.1"/></Points>
        <Points id="a4" unit="percent"><Target parameter="c1r"/><RealPoint time="0" value="50"/></Points>
      </Lanes>
      <Lanes track="id9" id="id24b">
        <Clips id="id25">
          <Clip time="4.0" duration="8.00003433227539" playStart="0.0" loopStart="0.0" loopEnd="8.00003433227539" fadeTimeUnit="beats" fadeInTime="0.5" fadeOutTime="0.0" name="Drumfunk3 170bpm">
            <Clips id="id26">
              <Clip time="0.0" duration="8.00003433227539" contentTimeUnit="beats" playStart="1.0" fadeTimeUnit="beats" fadeInTime="0.0" fadeOutTime="0.0">
                <Warps contentTimeUnit="seconds" timeUnit="beats" id="id28">
                  <Audio algorithm="stretch" channels="2" duration="2.823541666666667" sampleRate="48000" id="id27">
                    <File path="audio/Drumfunk3 170bpm.wav"/>
                  </Audio>
                  <Warp time="0.0" contentTime="0.0"/>
                  <Warp time="8.00003433227539" contentTime="2.823541666666667"/>
                </Warps>
              </Clip>
            </Clips>
          </Clip>
        </Clips>
      </Lanes>
    </Lanes>
    <Markers id="m"><Marker time="0" name="Verse"/><Marker time="12" name="Chorus"/></Markers>
  </Arrangement>
  <Scenes/>
</Project>`;

test('DAWproject import of a foreign (Bitwig-style) file: mapping, placeholders, report', () => {
  assert.deepEqual(PROJECT_XSD.validate(FOREIGN), [], 'fixture is schema-valid');
  const wav = new Uint8Array(encodeWav(fakeBuffer(0.1, 48000), { bitDepth: 16 }));
  const files = new Map([['audio/Drumfunk3 170bpm.wav', wav]]);
  const { project: q, report } = parseDawproject(FOREIGN, files);
  assert.equal(q.bpm, 149);
  assert.deepEqual(q.timeSig, [3, 4]);
  assert.deepEqual(q.tracks.map((t) => [t.name, t.type]), [['Bass', 'instrument'], ['Drumloop', 'audio']]);
  const [bass, loop] = q.tracks;
  assert.equal(bass.instrument.preset, 'saw-bass', 'Surge XT on a "Bass" track -> nearest daW³ bass preset');
  assert.ok(near(bass.volume, 0.65914) && near(bass.pan, -0.5));
  assert.deepEqual(bass.fx.map((f) => [f.type, f.enabled]), [['compressor', true], ['reverb', false]]);
  assert.equal(bass.fx[0].params.ratio, 4);
  assert.equal(bass.fx[0].params.threshold, -12);
  assert.deepEqual(bass.foreignDevices.map((d) => d.deviceName), ['Soothe2']);
  assert.equal(q.buses.length, 1);
  assert.equal(q.buses[0].name, 'Hall');
  assert.equal(bass.sends[q.buses[0].id], 0.3);
  assert.ok(loop.mute && loop.solo && near(loop.volume, 0.177125));
  // clips: disabled clip skipped, notes as pattern, nested Bitwig audio clip flattened with warp offset + fade
  const bc = q.clips.filter((c) => c.trackId === bass.id);
  assert.equal(bc.length, 1);
  assert.deepEqual(q.patterns[bc[0].patternId].notes.map((n) => [n.pitch, n.start, n.dur, n.vel]), [[65, 0, 0.25, 0.787402], [53, 1.5, 2.5, 0.5]]);
  const ac = q.clips.find((c) => c.type === 'audio');
  assert.equal(ac.trackId, loop.id);
  assert.ok(near(ac.start, 4) && near(ac.length, 8.000034));
  // the stretched loop (170 BPM material on a 149 BPM timeline) becomes a warped clip: offset in content beats
  assert.equal(ac.warp.mode, 'complex');
  assert.ok(near(ac.offset, 1), 'playStart in content beats');
  assert.equal(ac.warp.markers.length, 2);
  assert.ok(near(ac.warp.markers[1].beat, 8.000034) && near(ac.warp.markers[1].sec, 2.823542) && ac.warp.markers[0].sec === 0);
  assert.ok(Math.abs(ac.warp.bpm - 170) < 0.01, `source tempo ${ac.warp.bpm}`);
  assert.equal(ac.fadeIn, 0.5);
  assert.equal(q.samples[ac.sampleId].name, 'Drumfunk3 170bpm');
  assert.deepEqual(q.markers.map((m) => [m.beat, m.name]), [[0, 'Verse'], [12, 'Chorus']]);
  // automation: volume (hold -> step), compressor ratio mapped; plugin param + MIDI CC reported
  const vol = bass.automation.find((l) => l.target === 'volume');
  assert.deepEqual(vol.points.map((x) => [x.beat, x.value]), [[0, 0.2], [4, 0.2], [4, 1]]);
  const ratio = bass.automation.find((l) => /:ratio$/.test(l.target));
  assert.equal(ratio.points[0].value, 2);
  const text = [...report.unmapped, ...report.warnings, ...report.placeholders, ...report.mapped].join('\n');
  assert.match(text, /Soothe2/);
  assert.match(text, /MIDI CC 74/);
  assert.match(text, /parameter p1/);
  assert.match(text, /disabled clip/);
  assert.match(text, /Group "Band"/);
  assert.match(text, /time-stretched/);
  assert.match(text, /Surge XT/);
  // placeholders survive the way back out
  const again = buildDawproject(q);
  assert.deepEqual(PROJECT_XSD.validate(again.projectXml), []);
  assert.match(again.projectXml, /<Vst3Plugin [^>]*deviceName="Soothe2"/);
});

test('DAWproject export of a pattern-mode project still has an arrangement', () => {
  const p = createProject();
  const t = createTrack({ name: 'Lead' });
  p.tracks.push(t);
  const pat = createPattern(t.id, { length: 4, notes: [createNote(60, 0, 1, 0.8)] });
  p.patterns[pat.id] = pat;
  t.activePatternId = pat.id;
  const out = buildDawproject(p);
  assert.deepEqual(PROJECT_XSD.validate(out.projectXml), []);
  assert.match(out.projectXml, /<Note time="0" duration="1" channel="0" key="60"/);
  assert.match(out.report.warnings.join(), /no arrangement/);
  const q = parseDawproject(out.projectXml, new Map(out.files.map((f) => [f.path, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))).project;
  assert.equal(q.clips.length, 1);
});

// --------------------------------------------------------------------------- stems bundle

test('Stems: variants are pre-master, post-fader / post-insert', () => {
  const p = richProject();
  const bass = p.tracks[1];
  const pf = stemVariant(p, bass.id, { tap: 'post-fader' });
  assert.equal(pf.master.fx.length, 0);
  assert.equal(pf.master.volume, 1);
  assert.equal(pf.master.automation.length, 0);
  const pb = pf.tracks.find((t) => t.id === bass.id);
  assert.equal(pb.volume, 0.65);
  assert.ok(pb.automation.some((l) => l.target === 'volume'));
  assert.ok(pf.tracks.filter((t) => t.id !== bass.id).every((t) => t.mute));
  const pi = stemVariant(p, bass.id, { tap: 'post-insert' });
  const ib = pi.tracks.find((t) => t.id === bass.id);
  assert.deepEqual([ib.volume, ib.pan, ib.sends], [1, 0, {}]);
  assert.ok(!ib.automation.some((l) => /^(volume|pan|mute|send:)/.test(l.target)));
  assert.ok(ib.automation.some((l) => l.target === 'inst:cutoff'), 'insert / instrument automation kept');
  assert.equal(p.tracks[1].volume, 0.65, 'source project untouched');
  const plan = stemRenderPlan(p);
  assert.deepEqual(plan.tracks.map((t) => t.name), ['Drums', 'Bass', 'Vox', 'Hats code'], 'muted Keys gets no stem');
  assert.equal(plan.mode, 'song');
  assert.equal(plan.endBeat, 24);
});

test('Stems bundle: equal-length WAV stems + MIDI + tempo map + README in one ZIP', async () => {
  const p = richProject();
  const calls = [];
  const render = async (variant, o) => {
    calls.push({ variant, o });
    return fakeBuffer(((o.endBeat - o.startBeat) * 60) / variant.bpm + o.tail, 48000, 2, 100 + calls.length * 50);
  };
  const stems = await renderStems(p, { tap: 'post-fader', render, tail: 2 });
  assert.equal(stems.length, 4);
  assert.ok(calls.every((c) => c.o.startBeat === 0 && c.o.endBeat === 24 && c.o.mode === 'song'));
  const entries = buildMixBundle(p, { stems: stems.map((s) => ({ track: s.track, wav: new Uint8Array(encodeWav(s.buffer, { bitDepth: 24 })) })), sampleRate: 48000, bitDepth: 24, tap: 'post-fader', lengthSec: stems[0].buffer.duration, endBeat: 24 });
  const zip = await writeZip(entries, { codec: zlibCodec });
  const files = await readZip(zip, { codec: zlibCodec });
  const names = [...files.keys()];
  assert.deepEqual(names.filter((n) => /Stems\//.test(n)).map((n) => n.split('/').pop()), ['01 Drums.wav', '02 Bass.wav', '03 Vox.wav', '04 Hats code.wav']);
  const infos = names.filter((n) => n.endsWith('.wav')).map((n) => wavInfo(files.get(n)));
  assert.ok(infos.every((i) => i.frames === infos[0].frames && i.sampleRate === 48000 && i.bitDepth === 24 && i.channels === 2), 'same length / format');
  const readme = zipText(files, 'Interchange Demo/README.txt');
  assert.match(readme, /Tempo: +124 BPM/);
  assert.match(readme, /Key: +A minor/);
  assert.match(readme, /Sample rate: +48000 Hz/);
  assert.match(readme, /Bit depth: +24-bit/);
  assert.match(readme, /post-fader, pre-master/);
  const tempo = zipText(files, 'Interchange Demo/Tempo map.txt');
  assert.match(tempo, /Tempo 124 BPM, meter 4\/4/);
  assert.match(tempo, /Marker "Drop"/);
  assert.equal(tempoMapText(p), tempo);
  const midi = importMidi(files.get('Interchange Demo/MIDI/Interchange Demo.mid'));
  assert.equal(midi.bpm, 124);
  assert.ok(midi.tracks.length >= 3);
});

// ------------------------------------------------------------------------------ MusicXML

function leadSheetProject() {
  const p = createProject({ name: 'Lead Sheet', bpm: 96 });
  p.key = { root: 5, scale: 'major' };
  const lead = createTrack({ name: 'Melody', role: 'lead' });
  const keys = createTrack({ name: 'Keys', role: 'chords' });
  p.tracks.push(lead, keys);
  const mel = [
    [65, 0, 1, 0.8], [67, 1, 0.5, 0.6], [69, 1.5, 0.5, 0.7], [70, 2, 1.5, 0.9], [72, 3.5, 1.5, 0.5], // tie across the barline
    [74, 6, 1 / 3, 0.8], [72, 6 + 1 / 3, 1 / 3, 0.75], [70, 6 + 2 / 3, 1 / 3, 0.7], [69, 7, 0.75, 0.8], [65, 7.75, 0.25, 0.4],
    [61, 8, 3, 0.66], [62, 11.25, 0.125, 1], [63, 11.375, 0.625, 0.3], // dotted half, 32nd, rest gaps, accidentals
  ];
  const lp = createPattern(lead.id, { length: 12, notes: mel.map(([a, b, c, d]) => createNote(a, b, c, d)) });
  const kp = createPattern(keys.id, { length: 12, notes: [[53, 57, 60, 0, 4], [58, 62, 65, 4, 2], [60, 64, 67, 6, 2], [62, 65, 69, 8, 4]].flatMap(([a, b, c, s, d]) => [a, b, c].map((x) => createNote(x, s, d, 0.6))).concat([createNote(70, 6, 2, 0.6)]) });
  p.patterns[lp.id] = lp; p.patterns[kp.id] = kp;
  lead.activePatternId = lp.id; keys.activePatternId = kp.id;
  p.clips.push(createClip(lead.id, { patternId: lp.id, start: 0, length: 12 }), createClip(keys.id, { patternId: kp.id, start: 0, length: 12 }));
  p.markers.push({ id: 'a', beat: 4, name: 'B' });
  p.mode = 'song';
  return p;
}

test('MusicXML: duration splitting covers every value exactly', () => {
  for (let d = 1; d <= 200; d++) assert.equal(splitDuration(d).reduce((s, x) => s + x[0], 0), d);
  assert.deepEqual(splitDuration(36).map((x) => [x[1], x[2]]), [['quarter', 1]]);
  assert.deepEqual(splitDuration(8).map((x) => [x[1], x[3]]), [['eighth', true]]);
  assert.equal(DIVISIONS, 24);
});

test('MusicXML lead sheet round trip: melody, chord symbols, tempo, key, markers', async () => {
  const p = leadSheetProject();
  assert.deepEqual(harmonyChords(p).map((c) => [c.beat, c.name]), [[0, 'F'], [4, 'Bb'], [6, 'C7'], [8, 'Dm']]);
  const out = exportMusicXml(p);
  assert.match(out.xml, /<!DOCTYPE score-partwise PUBLIC "-\/\/Recordare\/\/DTD MusicXML 4.0 Partwise\/\/EN"/);
  const doc = parseXml(out.xml);
  assert.equal(doc.attrs.version, '4.0');
  const measures = children(child(doc, 'part'), 'measure');
  assert.equal(measures.length, 3);
  // every measure is exactly full (4/4 at 24 divisions per quarter)
  for (const m of measures) {
    const total = children(m, 'note').filter((n) => !child(n, 'chord')).reduce((s, n) => s + Number(child(n, 'duration').text), 0);
    assert.equal(total, 96, `measure ${m.attrs.number}`);
  }
  assert.match(out.xml, /<tie type="start"\/>/);
  assert.match(out.xml, /<time-modification>/);
  assert.match(out.xml, /<fifths>-1<\/fifths>/);
  assert.match(out.xml, /<kind text="7">dominant<\/kind>/);
  const back = parseMusicXml(out.xml);
  assert.equal(back.title, 'Lead Sheet');
  assert.equal(back.bpm, 96);
  assert.deepEqual(back.timeSig, [4, 4]);
  assert.deepEqual(back.key, { fifths: -1, mode: 'major' });
  assert.deepEqual(back.chords.map((c) => [c.beat, c.name]), [[0, 'F'], [4, 'Bb'], [6, 'C7'], [8, 'Dm']]);
  assert.deepEqual(back.markers, [{ beat: 4, name: 'B' }]);
  const want = p.patterns[p.tracks[0].activePatternId].notes;
  const got = back.parts[0].notes;
  assert.equal(got.length, want.length);
  got.forEach((n, i) => {
    assert.equal(n.pitch, want[i].pitch);
    assert.ok(near(n.start, want[i].start) && near(n.dur, want[i].dur), `note ${i}: ${JSON.stringify(n)}`);
    assert.ok(near(n.vel, want[i].vel, 0.01), `velocity ${i}`);
  });
  // compressed .mxl
  const mxl = await writeZip([
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/lead.musicxml"/></rootfiles></container>' },
    { name: 'score/lead.musicxml', data: out.xml },
  ], { codec: zlibCodec });
  const fromMxl = await readMusicXmlFile(mxl, { codec: zlibCodec });
  assert.equal(fromMxl.parts[0].notes.length, want.length);
  // into a project: melody pattern + chords track
  const q = createProject();
  const { trackIds } = addMusicXmlToProject(q, back, { setTempo: true });
  assert.equal(trackIds.length, 2);
  assert.equal(q.bpm, 96);
  assert.deepEqual(q.key, { root: 5, scale: 'major' });
  const mel = q.tracks.find((t) => t.id === trackIds[0]);
  assert.equal(q.patterns[mel.activePatternId].notes.length, want.length);
  assert.equal(q.patterns[mel.activePatternId].length, 12);
  const chordsTrack = q.tracks.find((t) => t.id === trackIds[1]);
  assert.equal(chordsTrack.role, 'chords');
  assert.deepEqual(harmonyChords(q).map((c) => c.name), ['F', 'Bb', 'C7', 'Dm']);
});

test('MusicXML import handles chords-in-notes, backup/forward, pickups and ties', () => {
  const xml = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
<part id="P1">
 <measure number="0" implicit="yes"><attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration></note></measure>
 <measure number="1">
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><tie type="start"/></note>
  <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/></note>
  <backup><duration>6</duration></backup>
  <forward><duration>2</duration></forward>
  <note><grace/><pitch><step>D</step><octave>5</octave></pitch></note>
  <note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>2</duration></note>
 </measure>
</part></score-partwise>`;
  const r = parseMusicXml(xml);
  assert.deepEqual(r.timeSig, [3, 4]);
  assert.deepEqual(r.parts[0].notes.map((n) => [n.pitch, n.start, n.dur]), [[67, 0, 1], [72, 1, 3], [76, 1, 2]]);
  assert.match(r.report.warnings.join(), /unpitched/);
  assert.throws(() => parseMusicXml('<score-timewise/>'), /Timewise/);
});
