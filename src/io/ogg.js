// Ogg Opus muxer (RFC 7845), pure and Node-safe: OpusHead + OpusTags (Vorbis comments: TITLE, ARTIST, ALBUM, ISRC,
// DATE, COMMENT, BPM, ENCODER, METADATA_BLOCK_PICTURE) + audio pages with 48 kHz granule positions; the last granule
// position trims the encoder padding so decoders return exactly the source length (after the pre-skip).
//
//   muxOggOpus({packets: [{data: Uint8Array, samples (48 kHz)}], channels, inputRate, preSkip = 312, samples48 (source
//               length at 48 kHz), tags, serial}) -> Uint8Array
//   parseOgg(bytes) -> [{serial, seq, granule, flags, packets: Uint8Array[], crcOk}]
//   readOggOpus(bytes) -> {head: {channels, preSkip, inputRate, gain}, tags: {TITLE: …}, vendor, packets, granule, samples}

const enc = new TextEncoder();
const cat = (parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
export function oggCrc(bytes) {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 255]) >>> 0;
  return crc >>> 0;
}

function page({ serial, seq, granule, flags, packets, continued = false, open = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    if (!open || n) lacing.push(n); // an open (unfinished) packet ends on a 255 lacing value
  }
  const head = new Uint8Array(27 + lacing.length);
  const dv = new DataView(head.buffer);
  head.set([0x4f, 0x67, 0x67, 0x53, 0]);
  head[5] = flags | (continued ? 1 : 0);
  dv.setBigUint64(6, BigInt(granule), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  head[26] = lacing.length;
  head.set(lacing, 27);
  const out = cat([head, ...packets]);
  new DataView(out.buffer).setUint32(22, oggCrc(out), true);
  return out;
}

export function opusHead({ channels = 2, preSkip = 312, inputRate = 48000, gain = 0 } = {}) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set(enc.encode('OpusHead'));
  b[8] = 1;
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputRate, true);
  dv.setInt16(16, gain, true);
  b[18] = 0; // mapping family 0 (mono / stereo)
  return b;
}

/** FLAC-style picture block (base64 in METADATA_BLOCK_PICTURE). */
function pictureBlock({ mime = 'image/jpeg', data }) {
  const m = enc.encode(mime);
  const b = new Uint8Array(32 + m.length + data.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 3); // front cover
  dv.setUint32(4, m.length);
  b.set(m, 8);
  let o = 8 + m.length;
  dv.setUint32(o, 0); o += 4; // description length
  o += 16; // width, height, depth, colours (unknown)
  dv.setUint32(o, data.length); o += 4;
  b.set(data, o);
  return b;
}
const b64 = (bytes) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function opusTags(tags = {}, vendor = 'daW3') {
  const list = [];
  const add = (k, v) => { if (v != null && String(v).trim() !== '') list.push(enc.encode(`${k}=${String(v).trim()}`)); };
  add('TITLE', tags.title); add('ARTIST', tags.artist); add('ALBUM', tags.album); add('ISRC', tags.isrc);
  add('DATE', tags.year ?? tags.date); add('COMMENT', tags.comment); add('GENRE', tags.genre);
  add('BPM', tags.bpm != null ? Math.round(tags.bpm) : null); add('ENCODER', tags.software);
  if (tags.cover?.data?.length) add('METADATA_BLOCK_PICTURE', b64(pictureBlock(tags.cover)));
  const v = enc.encode(vendor);
  const head = new Uint8Array(8 + 4 + v.length + 4);
  head.set(enc.encode('OpusTags'));
  new DataView(head.buffer).setUint32(8, v.length, true);
  head.set(v, 12);
  new DataView(head.buffer).setUint32(12 + v.length, list.length, true);
  return cat([head, ...list.flatMap((s) => { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, s.length, true); return [n, s]; })]);
}

/** Mux Opus packets into an Ogg stream (one packet per page run, pages ≤ ~1 s / 255 segments). */
export function muxOggOpus({ packets, channels = 2, inputRate = 48000, preSkip = 312, samples48 = null, tags = {}, serial = 0x64617733 }) {
  if (!packets?.length) throw new Error('no Opus packets to mux');
  const pages = [];
  let seq = 0;
  pages.push(page({ serial, seq: seq++, granule: 0, flags: 2, packets: [opusHead({ channels, preSkip, inputRate })] }));
  // OpusTags may exceed one page (cover art): split into 255-segment pages with the continuation flag
  const tagBytes = opusTags(tags, tags.software || 'daW3');
  const FULL = 255 * 255; // a page of 255 full segments (packet continues on the next page)
  let o = 0;
  while (tagBytes.length - o > 255 * 254 + 254) {
    pages.push(page({ serial, seq: seq++, granule: -1, flags: 0, packets: [tagBytes.subarray(o, o + FULL)], continued: o > 0, open: true }));
    o += FULL;
  }
  pages.push(page({ serial, seq: seq++, granule: 0, flags: 0, packets: [tagBytes.subarray(o)], continued: o > 0 }));
  const total = packets.reduce((a, p) => a + p.samples, 0);
  const end = preSkip + Math.min(total - preSkip, samples48 ?? total - preSkip);
  let granule = 0;
  let cur = [], segs = 0, dur = 0;
  const flush = (last) => {
    pages.push(page({ serial, seq: seq++, granule: last ? end : granule, flags: last ? 4 : 0, packets: cur }));
    cur = []; segs = 0; dur = 0;
  };
  packets.forEach((p, i) => {
    const s = Math.floor(p.data.length / 255) + 1;
    if (cur.length && (segs + s > 255 || dur >= 48000)) flush(false);
    cur.push(p.data); segs += s; dur += p.samples; granule += p.samples;
    if (i === packets.length - 1) flush(true);
  });
  return cat(pages);
}

/** Pages with CRC check; packets re-assembled across lacing / continued pages. */
export function parseOgg(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const pages = [];
  let o = 0, pending = null;
  while (o < b.length) {
    if (!(b[o] === 0x4f && b[o + 1] === 0x67 && b[o + 2] === 0x67 && b[o + 3] === 0x53)) throw new Error(`no OggS capture pattern at ${o}`);
    const nseg = b[o + 26];
    const lacing = b.subarray(o + 27, o + 27 + nseg);
    const bodyLen = lacing.reduce((a, x) => a + x, 0);
    const len = 27 + nseg + bodyLen;
    const copy = b.slice(o, o + len);
    copy[22] = copy[23] = copy[24] = copy[25] = 0;
    const crcOk = oggCrc(copy) === dv.getUint32(o + 22, true);
    const packets = [];
    let p = o + 27 + nseg, acc = pending ? [pending] : [];
    pending = null;
    let run = [];
    for (const l of lacing) {
      run.push(b.subarray(p, p + l)); p += l;
      if (l < 255) { packets.push(cat([...acc, ...run])); acc = []; run = []; }
    }
    if (run.length || acc.length) pending = cat([...acc, ...run]);
    pages.push({ serial: dv.getUint32(o + 14, true), seq: dv.getUint32(o + 18, true), granule: Number(dv.getBigInt64(o + 6, true)), flags: b[o + 5], packets, crcOk, length: len });
    o += len;
  }
  return pages;
}

/** Read an Ogg Opus file back (tests, the export report). */
export function readOggOpus(bytes) {
  const pages = parseOgg(bytes);
  const all = pages.flatMap((p) => p.packets);
  const h = all[0];
  if (new TextDecoder().decode(h.subarray(0, 8)) !== 'OpusHead') throw new Error('not an Ogg Opus stream');
  const hd = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const head = { version: h[8], channels: h[9], preSkip: hd.getUint16(10, true), inputRate: hd.getUint32(12, true), gain: hd.getInt16(16, true) };
  const t = all[1];
  const td = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const vlen = td.getUint32(8, true);
  const vendor = new TextDecoder().decode(t.subarray(12, 12 + vlen));
  let p = 12 + vlen;
  const n = td.getUint32(p, true); p += 4;
  const tags = {};
  for (let i = 0; i < n; i++) {
    const l = td.getUint32(p, true); p += 4;
    const s = new TextDecoder().decode(t.subarray(p, p + l)); p += l;
    const k = s.indexOf('=');
    tags[s.slice(0, k).toUpperCase()] = s.slice(k + 1);
  }
  const last = pages[pages.length - 1];
  return { head, tags, vendor, pages, packets: all.slice(2), granule: last.granule, samples: last.granule - head.preSkip, eos: !!(last.flags & 4), crcOk: pages.every((x) => x.crcOk) };
}
