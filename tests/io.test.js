import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, parseProjectFile, downloadProject, readFileAsProject, downloadBlob } from '../src/io/project-file.js';
import { exportMidi, importMidi, collectTrackNotes, addMidiToProject } from '../src/io/midi.js';
import { encodeWav } from '../src/io/wav.js';
import { arrayBufferToBase64, base64ToArrayBuffer, fileToSample, sampleToArrayBuffer } from '../src/io/samples.js';
import { saveLocal, listLocal, loadLocal, deleteLocal, createAutosaver, isAutosaveAvailable } from '../src/io/autosave.js';
import { readStrudelFile, downloadStrudel, codeToShareUrl } from '../src/io/strudel-file.js';
import { createProject, createTrack, createPattern, createNote, createClip, PROJECT_FORMAT } from '../src/core/model.js';
import { Store } from '../src/core/store.js';

function demoProject() {
  const p = createProject({ name: 'Demo', bpm: 125 });
  const drums = createTrack({ name: 'Drums', instrument: { type: 'drums', preset: null, params: {} } });
  const bass = createTrack({ name: 'Bass' });
  p.tracks.push(drums, bass);
  const dp = createPattern(drums.id, { length: 4, notes: [createNote(36, 0, 0.25, 1), createNote(38, 1, 0.25, 0.5), createNote(42, 0.5), createNote(36, 2)] });
  const bp = createPattern(bass.id, { length: 2, notes: [createNote(36, 0, 0.5, 0.9), createNote(43, 1, 0.75, 0.6)] });
  p.patterns[dp.id] = dp;
  p.patterns[bp.id] = bp;
  drums.activePatternId = dp.id;
  bass.activePatternId = bp.id;
  p.clips.push(createClip(drums.id, { patternId: dp.id, start: 0, length: 8 }));
  p.clips.push(createClip(bass.id, { patternId: bp.id, start: 4, length: 3, offset: 1 }));
  p.samples.smp_1 = { id: 'smp_1', name: 'kick', mime: 'audio/wav', data: arrayBufferToBase64(new Uint8Array([1, 2, 3, 250])), duration: 0.1 };
  return p;
}

// ------------------------------------------------------------------------------ project file

test('serializeProject / parseProjectFile round trip', () => {
  const p = demoProject();
  const text = serializeProject(p);
  assert.ok(text.includes('\n  "format"'), 'pretty printed');
  const back = parseProjectFile(text);
  assert.equal(back.format, PROJECT_FORMAT);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(text));
  assert.deepEqual(back.warnings, []);
  assert.equal(back.samples.smp_1.data, p.samples.smp_1.data);
  assert.deepEqual(parseProjectFile('﻿' + text).tracks.length, 2);
});

test('parseProjectFile validates and normalizes', () => {
  assert.throws(() => parseProjectFile('not json'), /Not a valid project file/);
  assert.throws(() => parseProjectFile(''), /empty/);
  assert.throws(() => parseProjectFile('[1,2]'), /JSON object/);
  assert.throws(() => parseProjectFile('{"hello":1}'), /Not a daWWW project/);
  assert.throws(() => parseProjectFile('{"format":"dawww-project","tracks":5}'), /tracks/);
  const partial = parseProjectFile(JSON.stringify({ bpm: 90, tracks: [{ id: 't1', name: 'X', type: 'instrument' }], clips: [{ id: 'c', trackId: 'gone' }] }));
  assert.equal(partial.bpm, 90);
  assert.equal(partial.format, PROJECT_FORMAT);
  assert.ok(Array.isArray(partial.buses) && partial.master);
  assert.equal(partial.clips.length, 0);
  assert.ok(partial.warnings.length >= 2);
  assert.equal(Object.keys(partial).includes('warnings'), false);
});

test('browser-only helpers are safe in Node', async () => {
  assert.equal(downloadBlob(new Blob(['x']), 'x.txt'), false);
  assert.equal(downloadProject(demoProject()), false);
  assert.equal(downloadStrudel('s("bd")', 'beat'), false);
  const file = new File([serializeProject(demoProject())], 'demo.daW3');
  const p = await readFileAsProject(file);
  assert.equal(p.name, 'Demo');
});

// ------------------------------------------------------------------------------------- MIDI

test('exportMidi writes a valid SMF header and tempo/time-signature', () => {
  const p = demoProject();
  p.timeSig = [3, 4];
  const bytes = exportMidi(p, { mode: 'pattern' });
  assert.ok(bytes instanceof Uint8Array);
  const s = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  assert.equal(s(0, 4), 'MThd');
  assert.equal((bytes[8] << 8) | bytes[9], 1); // format 1
  assert.equal((bytes[10] << 8) | bytes[11], 3); // tempo + 2 tracks
  assert.equal((bytes[12] << 8) | bytes[13], 480);
  const parsed = importMidi(bytes.buffer);
  assert.equal(parsed.bpm, 125);
  assert.deepEqual(parsed.timeSig, [3, 4]);
  assert.equal(parsed.ppq, 480);
});

test('MIDI round trip (pattern mode) preserves notes, drums on channel 10', () => {
  const p = demoProject();
  const parsed = importMidi(exportMidi(p, { mode: 'pattern' }));
  assert.equal(parsed.tracks.length, 2);
  const [d, b] = parsed.tracks;
  assert.equal(d.name, 'Drums');
  assert.equal(d.isDrums, true);
  assert.equal(d.channel, 9);
  assert.equal(b.isDrums, false);
  assert.notEqual(b.channel, 9);
  const simplify = (notes) => notes.map((n) => [n.pitch, n.start, n.dur, Math.round(n.vel * 127)]).sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  const dOrig = Object.values(p.patterns).find((x) => x.trackId === p.tracks[0].id).notes;
  assert.deepEqual(simplify(d.notes), simplify(dOrig));
  assert.deepEqual(simplify(b.notes), [[36, 0, 0.5, 114], [43, 1, 0.75, 76]]);
});

test('MIDI song mode loops pattern clips with offset', () => {
  const p = demoProject();
  const bass = collectTrackNotes(p, p.tracks[1], 'song');
  // bass pattern (len 2): 36@0, 43@1. clip start 4, offset 1, length 3 -> 43@4, 36@5, 43@6
  assert.deepEqual(bass.map((n) => [n.pitch, n.start]), [[43, 4], [36, 5], [43, 6]]);
  const drums = collectTrackNotes(p, p.tracks[0], 'song');
  assert.equal(drums.length, 8);
  const parsed = importMidi(exportMidi(p, { mode: 'song' }));
  assert.deepEqual(parsed.tracks[1].notes.map((n) => [n.pitch, n.start]), [[43, 4], [36, 5], [43, 6]]);
  assert.equal(parsed.tracks[0].notes.length, 8);
});

test('MIDI export renders code tracks', () => {
  const p = createProject();
  p.tracks.push(createTrack({ type: 'code', name: 'Code', code: '$: s("bd*4")\n$: note("c3 e3").s("sawtooth")' }));
  const parsed = importMidi(exportMidi(p, { mode: 'pattern' }));
  const drums = parsed.tracks.find((t) => t.isDrums);
  assert.equal(drums.notes.length, 16); // 4 bars
  assert.ok(parsed.tracks.find((t) => !t.isDrums).notes.some((n) => n.pitch === 52));
});

test('importMidi handles format 0, running status, note-on vel 0, multiple channels', () => {
  const vlq = (n) => { const o = [n & 0x7f]; while ((n >>= 7)) o.unshift((n & 0x7f) | 0x80); return o; };
  const ev = [
    ...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 120 bpm
    ...vlq(0), 0xff, 0x03, 0x03, 0x41, 0x42, 0x43, // name "ABC"
    ...vlq(0), 0x90, 60, 100, // note on ch0
    ...vlq(0), 64, 90, // running status
    ...vlq(96), 60, 0, // note off via vel 0 (running)
    ...vlq(0), 0x99, 36, 127, // drum on ch 10
    ...vlq(48), 0x89, 36, 0, // drum off
    ...vlq(48), 0x90, 64, 0,
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, ev.length, ...ev,
  ]);
  const r = importMidi(bytes);
  assert.equal(r.format, 0);
  assert.equal(r.bpm, 120);
  assert.equal(r.tracks.length, 2);
  const mel = r.tracks.find((t) => t.channel === 0);
  const dr = r.tracks.find((t) => t.isDrums);
  assert.match(mel.name, /^ABC/);
  assert.deepEqual(mel.notes.map((n) => [n.pitch, n.start, n.dur]), [[60, 0, 1], [64, 0, 2]]);
  assert.deepEqual(dr.notes.map((n) => [n.pitch, n.start, n.dur]), [[36, 1, 0.5]]);
  assert.throws(() => importMidi(new Uint8Array([1, 2, 3])), /Not a MIDI file/);
});

test('addMidiToProject creates tracks, patterns and clips', () => {
  const p = createProject();
  const parsed = importMidi(exportMidi(demoProject(), { mode: 'pattern' }));
  const { trackIds } = addMidiToProject(p, parsed);
  assert.equal(trackIds.length, 2);
  assert.equal(p.tracks[0].instrument.type, 'drums');
  assert.equal(p.patterns[p.tracks[0].activePatternId].length, 4);
  assert.equal(p.clips.length, 2);
});

// -------------------------------------------------------------------------------------- WAV

function fakeBuffer(channels, length, sampleRate = 44100) {
  const data = Array.from({ length: channels }, (_, c) => Float32Array.from({ length }, (_, i) => (c === 0 ? Math.sin(i / 3) : -0.5 + i * 0.001)));
  data[0][0] = 1.5; // clipped
  data[0][1] = -1;
  return { numberOfChannels: channels, sampleRate, length, getChannelData: (i) => data[i] };
}

test('encodeWav 16-bit header and samples', () => {
  const buf = fakeBuffer(2, 100, 48000);
  const ab = encodeWav(buf, { bitDepth: 16 });
  const v = new DataView(ab);
  const s = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));
  assert.equal(s(0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), ab.byteLength - 8);
  assert.equal(s(8, 4), 'WAVE');
  assert.equal(s(12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 4);
  assert.equal(v.getUint16(32, true), 4);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(s(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 400);
  assert.equal(ab.byteLength, 44 + 400);
  assert.equal(v.getInt16(44, true), 32767); // clipped 1.5
  assert.equal(v.getInt16(48, true), -32768); // -1
  assert.equal(v.getInt16(46, true), Math.round(-0.5 * 32768)); // right channel first sample
});

test('encodeWav 24-bit and 32-bit float', () => {
  const buf = fakeBuffer(1, 11);
  const ab24 = encodeWav(buf, { bitDepth: 24 });
  const v24 = new DataView(ab24);
  assert.equal(v24.getUint16(34, true), 24);
  assert.equal(v24.getUint16(32, true), 3);
  assert.equal(v24.getUint32(40, true), 33);
  assert.equal(ab24.byteLength, 44 + 34); // padded to even
  const int24 = (o) => { let x = v24.getUint8(o) | (v24.getUint8(o + 1) << 8) | (v24.getUint8(o + 2) << 16); return x & 0x800000 ? x - 0x1000000 : x; };
  assert.equal(int24(44), 0x7fffff);
  assert.equal(int24(47), -0x800000);
  const ab32 = encodeWav(buf, { bitDepth: 32 });
  const v32 = new DataView(ab32);
  const s = (o, n) => String.fromCharCode(...new Uint8Array(ab32, o, n));
  assert.equal(v32.getUint16(20, true), 3); // IEEE float
  assert.equal(v32.getUint32(16, true), 18);
  assert.equal(s(38, 4), 'fact');
  assert.equal(v32.getUint32(46, true), 11);
  assert.equal(s(50, 4), 'data');
  assert.equal(v32.getUint32(54, true), 44);
  assert.ok(Math.abs(v32.getFloat32(58 + 8, true) - Math.sin(2 / 3)) < 1e-6);
});

// ---------------------------------------------------------------------------------- samples

test('base64 helpers round trip', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
  const b64 = arrayBufferToBase64(bytes.buffer);
  assert.equal(b64, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(new Uint8Array(base64ToArrayBuffer(b64)), bytes);
  assert.deepEqual(new Uint8Array(base64ToArrayBuffer('data:audio/wav;base64,' + b64)), bytes);
  assert.equal(arrayBufferToBase64(new Uint8Array(0)), '');
});

test('fileToSample / sampleToArrayBuffer', async () => {
  const file = new File([new Uint8Array([82, 73, 70, 70, 9, 9])], 'my kick.wav', { type: '' });
  const smp = await fileToSample(file);
  assert.match(smp.id, /^smp_/);
  assert.equal(smp.name, 'my kick');
  assert.equal(smp.mime, 'audio/wav');
  assert.equal(smp.duration, null);
  assert.deepEqual(new Uint8Array(sampleToArrayBuffer(smp)), new Uint8Array([82, 73, 70, 70, 9, 9]));
});

// --------------------------------------------------------------------------------- autosave

test('autosave degrades gracefully without IndexedDB', async () => {
  assert.equal(isAutosaveAvailable(), false);
  await assert.rejects(saveLocal(createProject()), /IndexedDB/);
  assert.deepEqual(await listLocal(), []);
  assert.equal(await loadLocal('x'), null);
  assert.equal(await deleteLocal('x'), false);
  const store = new Store(createProject());
  const saver = createAutosaver(store, { intervalMs: 10 });
  store.transact('x', (p) => { p.name = 'Y'; });
  await saver.flush();
  saver.stop();
});

// ---------------------------------------------------------------------------- strudel files

test('readStrudelFile: text, files, share URLs', async () => {
  const code = 'note("c3 e3") // é ✓\n$: s("bd")';
  assert.deepEqual(await readStrudelFile('﻿' + code), { name: 'strudel', code });
  const url = codeToShareUrl(code);
  assert.match(url, /^https:\/\/strudel\.cc\/#/);
  assert.deepEqual(await readStrudelFile(url), { name: 'strudel-share', code });
  const f = new File(['s("bd*4")\r\n'], 'groove.strudel');
  assert.deepEqual(await readStrudelFile(f), { name: 'groove', code: 's("bd*4")\n' });
  const js = new File(['x'], 'tune.js');
  assert.equal((await readStrudelFile(js)).name, 'tune');
});
