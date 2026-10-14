// Lossy export: MP3 (vendored LAME port) frames + Xing/LAME tag + ID3v2, the .m4a (MP4) and Ogg Opus muxers parsed
// back, the WebCodecs pipeline (mocked encoder) and the export runner's lossy path + encoded-file report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMp3, parseMp3, buildId3v2, parseId3v2, frameHeader, mp3RateFor } from '../src/io/mp3.js';
import { muxM4a, readM4a, parseBoxes, findBox } from '../src/io/mp4.js';
import { muxOggOpus, readOggOpus, parseOgg, oggCrc } from '../src/io/ogg.js';
import { runExport, encodeLossy, formatSupport } from '../src/audio/export.js';
import { EXPORT_FORMATS, encodeRate, reportText } from '../src/io/export-plan.js';
import { measureLoudness } from '../src/audio/dsp/loudness.js';
import { createProject, createTrack, createClip } from '../src/core/model.js';

const tone = (sr, sec, f = 440, a = 0.5) => {
  const n = Math.round(sr * sec);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = a * Math.sin((2 * Math.PI * f * i) / sr); R[i] = a * 0.7 * Math.sin((2 * Math.PI * f * 1.5 * i) / sr); }
  return [L, R];
};

test('MP3: every frame header decodes, Xing/LAME tag gives the exact source length (CBR)', async () => {
  const sr = 44100;
  const ch = tone(sr, 1.3);
  const bytes = await encodeMp3(ch, sr, { bitrate: 192, mode: 'cbr' });
  const p = parseMp3(bytes); // throws on any invalid / truncated frame
  assert.ok(p.frames.length > 40);
  assert.deepEqual(p.bitrates, [192]);
  assert.equal(p.sampleRate, 44100);
  assert.equal(p.channels, 2);
  assert.ok(p.frames.every((f) => f.version === 1 && f.layer === 3 && f.samples === 1152));
  assert.equal(p.xing.tag, 'Info');
  assert.equal(p.xing.frames, p.frames.length);
  assert.equal(p.xing.encoder, 'LAME3.99r');
  assert.ok(p.xing.crcOk, 'LAME tag CRC');
  assert.equal(p.xing.delay, 576);
  assert.equal(p.samples, ch[0].length, 'frames × 1152 − delay − padding = source length');
  assert.equal(p.xing.bytes, bytes.length);
  // frame header decoding by hand: 0xFFFB = MPEG-1 layer III, no CRC
  assert.deepEqual([bytes[p.frames[0].offset], bytes[p.frames[0].offset + 1] & 0xfe], [0xff, 0xfa]);
});

test('MP3: VBR (average bitrate) varies the frame bitrate and marks the Xing tag', async () => {
  const sr = 48000;
  const [L, R] = tone(sr, 1.5, 220, 0.4);
  for (let i = sr >> 1; i < sr; i++) { L[i] += (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.3; R[i] = L[i] * 0.5; } // noisy half
  const bytes = await encodeMp3([L, R], sr, { bitrate: 192, mode: 'abr' });
  const p = parseMp3(bytes);
  assert.equal(p.xing.tag, 'Xing');
  assert.equal(p.xing.vbrMethod, 2);
  assert.ok(p.bitrates.length > 1, `several bitrates: ${p.bitrates}`);
  assert.equal(p.samples, L.length);
  assert.equal(p.sampleRate, 48000);
});

test('MP3: mono input, rate mapping', async () => {
  const sr = 32000;
  const [L] = tone(sr, 0.5);
  const p = parseMp3(await encodeMp3([L], sr, { bitrate: 128 }));
  assert.equal(p.channels, 1);
  assert.equal(p.samples, L.length);
  assert.equal(mp3RateFor(96000), 48000);
  assert.equal(mp3RateFor(88200), 44100);
  assert.equal(encodeRate('opus', 44100), 48000);
  assert.equal(encodeRate('aac', 96000), 48000);
  assert.equal(encodeRate('wav24', 96000), 96000);
  await assert.rejects(() => encodeMp3([L], 96000, {}), /32, 44.1 or 48/);
});

test('ID3v2.3: title / artist / album / ISRC / BPM / comment / cover round-trip, Unicode as UTF-16', async () => {
  const cover = { mime: 'image/png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
  const tag = buildId3v2({ title: 'Nachtfahrt — ☾', artist: 'Ada', album: 'Lights', isrc: 'USABC2400001', bpm: 124.4, comment: 'mixed in daW³', cover, software: 'daW³' });
  const r = parseId3v2(tag);
  assert.equal(r.version, 3);
  assert.equal(r.frames.TIT2, 'Nachtfahrt — ☾');
  assert.equal(r.frames.TPE1, 'Ada');
  assert.equal(r.frames.TALB, 'Lights');
  assert.equal(r.frames.TSRC, 'USABC2400001');
  assert.equal(r.frames.TBPM, '124');
  assert.equal(r.frames.COMM, 'mixed in daW³');
  assert.equal(r.frames.APIC.mime, 'image/png');
  assert.equal(r.frames.APIC.type, 3);
  assert.deepEqual([...r.frames.APIC.data], [...cover.data]);
  // in a file: the frames start right after the tag
  const bytes = await encodeMp3(tone(44100, 0.3), 44100, { bitrate: 128, tags: { title: 'T', artist: 'A' } });
  const p = parseMp3(bytes);
  assert.equal(p.id3.frames.TIT2, 'T');
  assert.ok(frameHeader(bytes, p.id3.size), 'Xing frame right after the tag');
});

// fake AAC-LC access units (content is opaque to the muxer)
const fakeFrames = (n) => Array.from({ length: n }, (_, i) => Uint8Array.from({ length: 100 + (i % 7) * 13 }, (_, k) => (i * 31 + k) & 255));

test('M4A muxer: ftyp / moov / mdat structure, esds, edit list, sample table and iTunes metadata parse back', () => {
  const frames = fakeFrames(50);
  const asc = Uint8Array.from([0x12, 0x10]); // AAC-LC 44.1 kHz stereo
  const samples = 50 * 1024 - 2112 - 300;
  const cover = { mime: 'image/jpeg', data: Uint8Array.from([0xff, 0xd8, 0xff, 9, 9]) };
  const bytes = muxM4a({ frames, asc, sampleRate: 44100, channels: 2, samples, priming: 2112, bitrate: 256000, tags: { title: 'Drive', artist: 'Ada', album: 'Lights', isrc: 'USABC2400001', bpm: 124, software: 'daW³', date: '2026-10-14', cover } });
  const tree = parseBoxes(bytes); // throws on any inconsistent box size
  assert.deepEqual(tree.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  for (const path of ['moov/mvhd', 'moov/trak/tkhd', 'moov/trak/edts/elst', 'moov/trak/mdia/mdhd', 'moov/trak/mdia/hdlr', 'moov/trak/mdia/minf/smhd', 'moov/trak/mdia/minf/dinf/dref',
    'moov/trak/mdia/minf/stbl/stsd/mp4a/esds', 'moov/trak/mdia/minf/stbl/stts', 'moov/trak/mdia/minf/stbl/stsc', 'moov/trak/mdia/minf/stbl/stsz', 'moov/trak/mdia/minf/stbl/stco', 'moov/udta/meta/hdlr', 'moov/udta/meta/ilst']) {
    assert.ok(findBox(tree, path), path);
  }
  const r = readM4a(bytes);
  assert.equal(r.major, 'M4A ');
  assert.equal(r.sampleRate, 44100);
  assert.equal(r.channels, 2);
  assert.equal(r.objectType, 0x40);
  assert.deepEqual([...r.asc], [...asc]);
  assert.equal(r.frames, 50);
  assert.deepEqual(r.sizes, frames.map((f) => f.length));
  assert.equal(r.duration, 50 * 1024);
  assert.equal(r.priming, 2112);
  assert.equal(r.editDuration, samples);
  // chunk offset points at the first frame inside mdat; the frames are stored in order
  assert.equal(r.chunkOffset, r.mdatStart);
  assert.deepEqual([...bytes.subarray(r.chunkOffset, r.chunkOffset + frames[0].length)], [...frames[0]]);
  assert.equal(r.mdatEnd, bytes.length);
  assert.equal(r.tags['\xa9nam'], 'Drive');
  assert.equal(r.tags['\xa9ART'], 'Ada');
  assert.equal(r.tags['\xa9alb'], 'Lights');
  assert.equal(r.tags.tmpo, 124);
  assert.equal(r.tags.ISRC, 'USABC2400001');
  assert.match(r.tags.iTunSMPB, / 00000000 00000840 0000012C /);
  assert.deepEqual([...r.tags.covr], [...cover.data]);
});

test('Ogg Opus muxer: pages with valid CRCs, OpusHead / OpusTags, granule = pre-skip + source length', () => {
  assert.equal(oggCrc(new TextEncoder().encode('OggS')), 0x5fb0a94f);
  const packets = Array.from({ length: 120 }, (_, i) => ({ data: Uint8Array.from({ length: 80 + (i % 5) * 40 }, (_, k) => (k * 7 + i) & 255), samples: 960 }));
  const samples48 = 120 * 960 - 312 - 500;
  const cover = { mime: 'image/png', data: new Uint8Array(70000).fill(7) }; // forces OpusTags across pages
  const bytes = muxOggOpus({ packets, channels: 2, inputRate: 44100, preSkip: 312, samples48, tags: { title: 'Drive', artist: 'Ada', isrc: 'USABC2400001', bpm: 124, cover } });
  const pages = parseOgg(bytes);
  assert.ok(pages.every((p) => p.crcOk));
  assert.deepEqual(pages.map((p) => p.seq), pages.map((_, i) => i));
  assert.equal(pages[0].flags & 2, 2, 'BOS');
  assert.equal(pages[pages.length - 1].flags & 4, 4, 'EOS');
  const r = readOggOpus(bytes);
  assert.deepEqual(r.head, { version: 1, channels: 2, preSkip: 312, inputRate: 44100, gain: 0 });
  assert.equal(r.tags.TITLE, 'Drive');
  assert.equal(r.tags.ARTIST, 'Ada');
  assert.equal(r.tags.ISRC, 'USABC2400001');
  assert.ok(r.tags.METADATA_BLOCK_PICTURE.length > 90000);
  assert.equal(r.packets.length, 120);
  assert.deepEqual([...r.packets[7]], [...packets[7].data]);
  assert.equal(r.samples, samples48);
  // granules never decrease
  const g = pages.filter((p) => p.granule >= 0).map((p) => p.granule);
  assert.deepEqual(g, [...g].sort((a, b) => a - b));
});

// --- WebCodecs pipeline with a mocked AudioEncoder ---
function mockWebCodecs({ supported = ['mp4a.40.2', 'opus'] } = {}) {
  const seen = [];
  class AudioData {
    constructor(init) { Object.assign(this, init); }
    close() {}
  }
  class AudioEncoder {
    static async isConfigSupported(cfg) { return { supported: supported.includes(cfg.codec), config: cfg }; }
    constructor({ output }) { this.output = output; this.encodeQueueSize = 0; this.buf = 0; this.t = 0; }
    configure(cfg) { this.cfg = cfg; seen.push(cfg); this.frame = cfg.codec === 'opus' ? Math.round(cfg.sampleRate * 0.02) : 1024; }
    encode(ad) {
      this.buf += ad.numberOfFrames;
      while (this.buf >= this.frame) { this.emit(); this.buf -= this.frame; }
    }
    emit() {
      const data = new Uint8Array(64).fill(this.t & 255);
      const ts = Math.round((this.t * this.frame / this.cfg.sampleRate) * 1e6);
      const chunk = { byteLength: 64, timestamp: ts, duration: Math.round((this.frame / this.cfg.sampleRate) * 1e6), copyTo: (b) => b.set(data) };
      const desc = this.cfg.codec === 'opus' ? null : Uint8Array.from([0x11, 0x90]);
      this.output(chunk, this.t === 0 && desc ? { decoderConfig: { description: desc } } : undefined);
      this.t++;
    }
    async flush() { if (this.buf > 0) { this.emit(); this.buf = 0; } this.emit(); this.emit(); }
    close() {}
  }
  globalThis.AudioEncoder = AudioEncoder;
  globalThis.AudioData = AudioData;
  return { seen, restore: () => { delete globalThis.AudioEncoder; delete globalThis.AudioData; } };
}

test('WebCodecs path: AAC -> .m4a with the encoder description, Opus -> .ogg; bitrate / VBR passed to the encoder', async () => {
  const m = mockWebCodecs();
  try {
    const ch = tone(48000, 0.5);
    const m4a = await encodeLossy(ch, 48000, 'aac', { bitrate: 256, bitrateMode: 'vbr', tags: { title: 'X' } });
    const r = readM4a(m4a);
    assert.deepEqual([...r.asc], [0x11, 0x90]);
    assert.equal(r.editDuration, ch[0].length);
    assert.equal(r.tags['\xa9nam'], 'X');
    assert.equal(m.seen[0].bitrate, 256000);
    assert.equal(m.seen[0].bitrateMode, 'variable');
    assert.deepEqual(m.seen[0].aac, { format: 'aac' });
    const ogg = await encodeLossy(ch, 48000, 'opus', { bitrate: 160, bitrateMode: 'cbr', tags: { artist: 'Y' } });
    const o = readOggOpus(ogg);
    assert.equal(o.samples, ch[0].length);
    assert.equal(o.tags.ARTIST, 'Y');
    assert.equal(m.seen[1].bitrateMode, 'constant');
  } finally { m.restore(); }
});

test('format support: MP3 always, AAC / Opus only with a WebCodecs encoder (reason otherwise)', async () => {
  const s = await formatSupport();
  assert.equal(s.mp3.ok, true);
  assert.equal(s.wav24.ok, true);
  assert.equal(s.aac.ok, false); // Node: no WebCodecs
  assert.match(s.aac.reason, /WebCodecs/);
  assert.equal(s.opus.ok, false);
  assert.ok(EXPORT_FORMATS.find((f) => f.id === 'mp3').bitrates.includes(320));
});

test('runExport MP3: normalisation applies before encoding; the report measures the decoded file', async () => {
  const p = createProject({ name: 'Lossy', bpm: 120 });
  const t = createTrack({ name: 'Tone' });
  p.tracks = [t];
  p.clips = [createClip(t.id, { start: 0, length: 8 })];
  let rendered = null;
  const render = async (proj, ro) => {
    const n = Math.round(ro.sampleRate * (8 * 60 / 120 + ro.tail));
    const chs = tone(ro.sampleRate, n / ro.sampleRate, 330, 0.1);
    rendered = ro;
    return { numberOfChannels: 2, sampleRate: ro.sampleRate, length: n, getChannelData: (c) => chs[c] };
  };
  let decoded = null;
  // stand-in for decodeAudioData (no MP3 decoder in Node): PCM of the length the file's frames + LAME tag describe
  const decode = async (bytes) => {
    const info = parseMp3(bytes);
    decoded = info;
    return { channels: tone(info.sampleRate, info.samples / info.sampleRate, 330, 0.2), sampleRate: info.sampleRate };
  };
  const res = await runExport({
    project: p, render, decode,
    opts: { format: 'mp3', sampleRate: 96000, bitrate: 256, bitrateMode: 'cbr', normalize: 'lufs', target: -16, ceiling: -1, tail: 'none', range: 'song', title: 'Lossy', artist: 'Ada', isrc: 'US-ABC-24-00001', nameTemplate: '{project}' },
  });
  assert.equal(rendered.sampleRate, 48000, 'MP3 renders at a rate the codec takes');
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].name, 'Lossy.mp3');
  assert.equal(res.files[0].mime, 'audio/mpeg');
  const info = parseMp3(res.files[0].data);
  assert.equal(info.samples, 4 * 48000, '8 beats @ 120 BPM = 4 s, gapless');
  assert.equal(info.id3.frames.TSRC, 'USABC2400001');
  assert.equal(info.id3.frames.TPE1, 'Ada');
  assert.ok(Math.abs(res.report.mix.measure.integrated - -16) < 0.2, 'normalised before encoding');
  assert.ok(res.report.mix.encoded, 'encoded file measured');
  assert.ok(Math.abs(res.report.mix.encoded.duration - 4) < 0.01);
  assert.match(res.report.text, /Encoded file/);
  assert.match(res.report.text, /MP3 256 kbps CBR @ 48000 Hz/);
  assert.ok(decoded);
});

test('report: encoded rows', () => {
  const m = { integrated: -14, truePeakDb: -1, lra: 5, shortTermMax: -10, momentaryMax: -8, samplePeakDb: -1.2, duration: 10 };
  const txt = reportText('x.mp3', m, { encoded: { ...m, integrated: -14.1, truePeakDb: -0.8, codec: 'MP3 320 kbps CBR' } });
  assert.match(txt, /Encoded file\s+-14\.1 LUFS · -0\.8 dBTP/);
  assert.match(txt, /Codec\s+MP3 320 kbps CBR/);
  assert.ok(measureLoudness);
});
