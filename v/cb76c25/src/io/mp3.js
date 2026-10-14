// MP3 export (pure, Node-safe): encoding through the vendored LAME port (vendor/lamejs, LGPL-3.0, loaded lazily),
// frame-header parsing, a Xing / Info + LAME tag frame (frame count, seek TOC, encoder delay / padding → gapless
// decoders trim exactly to the source length) and ID3v2.3 tags (title, artist, album, ISRC, comment, year, BPM, cover).
//
//   await encodeMp3(channels, sampleRate, {bitrate: 128..320 kbps, mode: 'cbr'|'abr', tags}) -> Uint8Array (.mp3)
//   parseMp3(bytes) -> {id3: {size, frames}|null, frames: [{offset, length, version, layer, bitrate, sampleRate, channels,
//                     samples, padding}], xing: {tag, frames, bytes, delay, padding}|null, sampleRate, channels, duration}
//   buildId3v2(tags) -> Uint8Array, parseId3v2(bytes) -> {version, frames: {TIT2: 'x', …, APIC: {mime, type, data}}}
//   MP3_RATES: the sample rates MPEG-1 Layer III supports (renders at other rates are made at 44.1 / 48 kHz)

export const MP3_BITRATES = [128, 160, 192, 224, 256, 320];
export const MP3_RATES = [32000, 44100, 48000];
export const mp3RateFor = (sr) => (MP3_RATES.includes(sr) ? sr : sr % 44100 === 0 ? 44100 : 48000);

const BR = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], // MPEG-1 layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], // MPEG-2 / 2.5 layer III
};
const SR = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** Decode one frame header at `o` (layer III only) or null. */
export function frameHeader(b, o) {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const vBits = (b[o + 1] >> 3) & 3, lBits = (b[o + 1] >> 1) & 3;
  if (vBits === 1 || lBits !== 1) return null; // reserved version / not layer III
  const version = vBits === 3 ? 1 : vBits === 2 ? 2 : 2.5;
  const bi = b[o + 2] >> 4, si = (b[o + 2] >> 2) & 3;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const bitrate = BR[version === 1 ? 1 : 2][bi];
  const sampleRate = SR[version][si];
  const padding = (b[o + 2] >> 1) & 1;
  const mode = b[o + 3] >> 6;
  const samples = version === 1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + padding;
  return { version, layer: 3, bitrate, bitrateIndex: bi, sampleRate, sampleRateIndex: si, padding, mode, channels: mode === 3 ? 1 : 2, samples, length, crc: !(b[o + 1] & 1) };
}

const sideInfoLen = (h) => (h.version === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17));
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Walk an MP3 file: ID3v2 tag, frames (every frame header validated), Xing / Info / LAME tag. */
export function parseMp3(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let o = 0;
  let id3 = null;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = 10 + syncsafe(b, 6);
    id3 = { size, ...parseId3v2(b.subarray(0, size)) };
    o = size;
  }
  const frames = [];
  let xing = null;
  while (o < b.length) {
    const h = frameHeader(b, o);
    if (!h) {
      if (b.length - o >= 3 && b[o] === 0x54 && b[o + 1] === 0x41 && b[o + 2] === 0x47) break; // ID3v1 'TAG'
      throw new Error(`invalid MP3 frame header at byte ${o}`);
    }
    if (o + h.length > b.length) throw new Error(`truncated MP3 frame at byte ${o}`);
    const x = o + 4 + sideInfoLen(h);
    const tag = String.fromCharCode(b[x], b[x + 1], b[x + 2], b[x + 3]);
    if (!frames.length && !xing && (tag === 'Xing' || tag === 'Info')) {
      const flags = u32(b, x + 4);
      let p = x + 8;
      xing = { tag, flags, offset: o, length: h.length };
      if (flags & 1) { xing.frames = u32(b, p); p += 4; }
      if (flags & 2) { xing.bytes = u32(b, p); p += 4; }
      if (flags & 4) { xing.toc = Array.from(b.subarray(p, p + 100)); p += 100; }
      if (flags & 8) { xing.quality = u32(b, p); p += 4; }
      const enc = String.fromCharCode(...b.subarray(p, p + 9));
      if (/^(LAME|Lavf|Lavc)/.test(enc)) {
        xing.encoder = enc.replace(/\0+$/, '');
        xing.vbrMethod = b[p + 9] & 15;
        const d = (b[p + 21] << 16) | (b[p + 22] << 8) | b[p + 23];
        xing.delay = d >> 12;
        xing.padding = d & 0xfff;
        xing.musicLength = u32(b, p + 28);
        xing.tagCrc = (b[p + 34] << 8) | b[p + 35];
        xing.crcOk = crc16(b.subarray(o, p + 34)) === xing.tagCrc;
      }
    } else {
      frames.push({ offset: o, ...h });
    }
    o += h.length;
  }
  const f0 = frames[0] || {};
  const total = frames.reduce((a, f) => a + f.samples, 0) - (xing?.delay != null ? xing.delay + xing.padding : 0); // gapless length (FFmpeg's rule)
  const sampleRate = f0.sampleRate || 0;
  return { id3, frames, xing, sampleRate, channels: f0.channels || 0, samples: total, duration: sampleRate ? total / sampleRate : 0, bitrates: [...new Set(frames.map((f) => f.bitrate))] };
}

// CRC-16 (poly 0x8005, reflected 0xA001), as LAME uses for the info tag CRC
function crc16(bytes) {
  let crc = 0;
  for (const v of bytes) {
    crc ^= v;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

/**
 * Xing ('Xing' for VBR / 'Info' for CBR) frame with a LAME tag, placed before the first audio frame: frame count,
 * byte count, a 100-entry seek TOC and encoder delay / padding — decoders that read it (FFmpeg, Chrome, Firefox,
 * Safari, iTunes) trim the codec delay and the padding, so the decoded length equals the source length.
 */
export function xingFrame(frames, { vbr = false, delay = 576, padding = 0, bitrate = 0, totalBytes = null } = {}) {
  const h = frames[0];
  // smallest bitrate whose frame holds header + side info + Xing (120) + LAME (36) bytes
  const table = BR[h.version === 1 ? 1 : 2];
  const need = 4 + sideInfoLen(h) + 156;
  let bi = 1;
  const lenOf = (i) => Math.floor(((h.samples / 8) * table[i] * 1000) / h.sampleRate);
  while (bi < 14 && lenOf(bi) < need) bi++;
  const len = lenOf(bi);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  out[0] = 0xff;
  out[1] = 0xe0 | ((h.version === 1 ? 3 : h.version === 2 ? 2 : 0) << 3) | (1 << 1) | 1; // layer III, no CRC
  out[2] = (bi << 4) | (h.sampleRateIndex << 2);
  out[3] = (h.mode << 6);
  let p = 4 + sideInfoLen(h);
  const audioBytes = frames.reduce((a, f) => a + f.length, 0);
  const bytesAll = totalBytes ?? audioBytes + len;
  out.set([...(vbr ? 'Xing' : 'Info')].map((c) => c.charCodeAt(0)), p);
  dv.setUint32(p + 4, 0x0f);
  dv.setUint32(p + 8, frames.length);
  dv.setUint32(p + 12, bytesAll);
  // TOC: byte position (/256 of the audio size) of each percent of the duration
  const starts = [];
  let acc = 0;
  for (const f of frames) { starts.push(acc); acc += f.length; }
  for (let i = 0; i < 100; i++) {
    const fi = Math.min(frames.length - 1, Math.floor((i / 100) * frames.length));
    out[p + 16 + i] = Math.min(255, Math.floor((starts[fi] / Math.max(1, audioBytes)) * 256));
  }
  dv.setUint32(p + 116, vbr ? 50 : 0); // quality indicator
  p += 120;
  // LAME tag (36 bytes)
  out.set([...'LAME3.99r'].map((c) => c.charCodeAt(0)), p);
  out[p + 9] = (0 << 4) | (vbr ? 2 : 1); // tag revision 0, VBR method: 1 CBR, 2 ABR
  out[p + 10] = 195; // lowpass / 100 Hz (informational)
  // p+11..18 replay gain (unset), p+19 flags/ATH
  out[p + 20] = Math.min(255, bitrate | 0);
  const d = Math.max(0, Math.min(4095, delay | 0)), pd = Math.max(0, Math.min(4095, padding | 0));
  out[p + 21] = d >> 4;
  out[p + 22] = ((d & 15) << 4) | (pd >> 8);
  out[p + 23] = pd & 255;
  out[p + 24] = (h.sampleRate === 48000 ? 2 : h.sampleRate === 44100 ? 1 : h.sampleRate > 48000 ? 3 : 0) << 6;
  dv.setUint32(p + 28, len + audioBytes); // music length (Xing frame + audio frames)
  // p+32..33 music CRC (0 = not computed); tag CRC over the first 190 bytes of the frame
  dv.setUint16(p + 34, crc16(out.subarray(0, p + 34)));
  return out;
}

// ---- ID3v2.3 ----
const latin1 = (s) => /^[\x00-\xff]*$/.test(s);
function encText(s) {
  s = String(s);
  if (latin1(s)) return Uint8Array.from([0, ...[...s].map((c) => c.charCodeAt(0))]);
  const out = [1, 0xff, 0xfe];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c & 255, c >> 8); }
  return Uint8Array.from(out);
}
function frame(id, body) {
  const out = new Uint8Array(10 + body.length);
  out.set([...id].map((c) => c.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 10);
  return out;
}
const cat = (parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const ascii = (s) => Uint8Array.from([...String(s)].map((c) => c.charCodeAt(0) & 255));

/**
 * ID3v2.3 tag: title (TIT2), artist (TPE1), album (TALB), ISRC (TSRC), year (TYER), bpm (TBPM), key (TKEY), genre
 * (TCON), software (TSSE), comment (COMM), cover {mime, data: Uint8Array} (APIC front cover). Empty fields are skipped.
 */
export function buildId3v2(tags = {}) {
  const frames = [];
  const text = (id, v) => { if (v != null && String(v).trim() !== '') frames.push(frame(id, encText(String(v).trim()))); };
  text('TIT2', tags.title);
  text('TPE1', tags.artist);
  text('TALB', tags.album);
  text('TSRC', tags.isrc);
  text('TYER', tags.year ?? (tags.date ? String(tags.date).slice(0, 4) : null));
  text('TBPM', tags.bpm != null ? Math.round(tags.bpm) : null);
  text('TKEY', tags.key);
  text('TCON', tags.genre);
  text('TSSE', tags.software);
  if (tags.comment) {
    const t = encText(tags.comment);
    frames.push(frame('COMM', cat([t.subarray(0, 1), ascii('eng'), t[0] === 1 ? Uint8Array.from([0xff, 0xfe, 0, 0]) : Uint8Array.from([0]), t.subarray(1)])));
  }
  if (tags.cover?.data?.length) {
    frames.push(frame('APIC', cat([Uint8Array.from([0]), ascii(tags.cover.mime || 'image/jpeg'), Uint8Array.from([0, 3, 0]), tags.cover.data])));
  }
  const body = cat(frames);
  const head = new Uint8Array(10);
  head.set([0x49, 0x44, 0x33, 3, 0, 0]);
  const n = body.length;
  head.set([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f], 6);
  return cat([head, body]);
}

function decText(b) {
  const e = b[0];
  if (e === 1 || e === 2) {
    let s = '', i = 1, le = true;
    if (e === 1 && b[1] === 0xfe && b[2] === 0xff) le = false;
    if (e === 1) i = 3;
    for (; i + 1 < b.length; i += 2) { const c = le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]; if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  let s = '';
  for (let i = 1; i < b.length && b[i]; i++) s += String.fromCharCode(b[i]);
  return e === 3 ? new TextDecoder().decode(b.subarray(1)).replace(/\0.*$/s, '') : s;
}

/** Read an ID3v2.3 / 2.4 tag (text frames, COMM, APIC). */
export function parseId3v2(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)) return null;
  const version = b[3];
  const end = 10 + syncsafe(b, 6);
  const frames = {};
  let o = 10;
  while (o + 10 <= end && b[o]) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const size = version >= 4 ? syncsafe(b, o + 4) : u32(b, o + 4);
    const body = b.subarray(o + 10, o + 10 + size);
    if (id[0] === 'T') frames[id] = decText(body);
    else if (id === 'COMM') {
      const e = body[0];
      let i = 4;
      if (e === 1 || e === 2) { while (i + 1 < body.length && (body[i] || body[i + 1])) i += 2; i += 2; } else { while (i < body.length && body[i]) i++; i++; }
      frames.COMM = decText(Uint8Array.from([e, ...body.subarray(i)]));
    } else if (id === 'APIC') {
      let i = 1;
      let mime = '';
      while (body[i]) mime += String.fromCharCode(body[i++]);
      const type = body[++i];
      i++;
      while (body[i]) i++;
      frames.APIC = { mime, type, data: body.slice(i + 1) };
    }
    o += 10 + size;
  }
  return { version, frames };
}

// ---- encoding ----
let lameMod = null;
/** The vendored LAME port, imported on first use (≈ 0.5 MB). */
export function loadLame() {
  lameMod ||= import(new URL('../../vendor/lamejs/lame.mjs', import.meta.url).href).then((m) => m.default);
  return lameMod;
}

/**
 * Encode planar float channels (−1..1) to MP3 with LAME: CBR or ABR (average-bitrate VBR) at `bitrate` kbps, joint
 * stereo, + Xing/LAME info frame + ID3v2.3 tag. The sample rate must be one of MP3_RATES (32 / 44.1 / 48 kHz).
 * onProgress(fraction) is called every ~1 s of audio.
 */
export async function encodeMp3(channels, sampleRate, { bitrate = 320, mode = 'cbr', tags = null, onProgress = null, lame = null } = {}) {
  if (!MP3_RATES.includes(sampleRate)) throw new Error(`MP3 needs 32, 44.1 or 48 kHz (got ${sampleRate})`);
  const lamejs = lame || (await loadLame());
  const nch = Math.min(2, channels.length);
  const kbps = MP3_BITRATES.includes(+bitrate) ? +bitrate : 320;
  const enc = new lamejs.Mp3Encoder(nch, sampleRate, kbps, { vbr: mode === 'abr' || mode === 'vbr' ? 'abr' : 'cbr' });
  const len = channels[0].length;
  const block = 1152 * 8;
  const L = new Float32Array(block), R = new Float32Array(block);
  const parts = [];
  let lastTick = 0;
  for (let o = 0; o < len; o += block) {
    const n = Math.min(block, len - o);
    const l = channels[0], r = channels[nch > 1 ? 1 : 0];
    // LAME's input scale is 16-bit, but it reads floats: no quantisation before the encoder
    for (let i = 0; i < n; i++) { L[i] = l[o + i] * 32767; R[i] = r[o + i] * 32767; }
    const out = enc.encodeBuffer(L.subarray(0, n), nch > 1 ? R.subarray(0, n) : undefined);
    if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
    if (onProgress && o - lastTick >= sampleRate) { lastTick = o; onProgress(o / len); await null; }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());
  const audio = cat(parts);
  const info = enc.getEncoderInfo?.() || { delay: 576, padding: 0 };
  const parsed = parseMp3(audio);
  // padding: whatever the frames hold beyond delay + source length (decoders add their 529-sample decoder delay)
  const padding = Math.max(0, parsed.frames.length * parsed.frames[0].samples - (info.delay + len));
  const xing = xingFrame(parsed.frames, { vbr: mode !== 'cbr', delay: info.delay, padding, bitrate: kbps });
  const id3 = tags ? buildId3v2(tags) : new Uint8Array(0);
  return cat([id3, xing, audio]);
}
