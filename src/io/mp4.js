// Minimal MP4 / ISO-BMFF audio muxer for AAC (.m4a), pure and Node-safe: ftyp + moov (mvhd, trak with an edit list
// that hides the encoder priming, mp4a/esds sample entry, stts/stsc/stsz/stco) + udta iTunes metadata (ilst:
// ©nam ©ART ©alb ©cmt ©day ©too tmpo covr, ISRC + iTunSMPB as '----' freeform atoms) + mdat.
//
//   muxM4a({frames: Uint8Array[], asc: Uint8Array (AudioSpecificConfig), sampleRate, channels, samples (source length),
//           priming = 2112, frameSamples = 1024, bitrate, tags}) -> Uint8Array
//   parseBoxes(bytes) -> [{type, start, size, header, children?}]   (container boxes are descended)
//   readM4a(bytes) -> {sampleRate, channels, frames, sizes, duration, editDuration, priming, asc, objectType, tags}

const enc = new TextEncoder();
const cat = (parts) => {
  const flat = parts.flat(Infinity).filter(Boolean);
  const out = new Uint8Array(flat.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
};
const u8 = (...v) => Uint8Array.from(v);
const u16 = (v) => u8((v >> 8) & 255, v & 255);
const u24 = (v) => u8((v >> 16) & 255, (v >> 8) & 255, v & 255);
const u32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const str = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));
const zeros = (n) => new Uint8Array(n);

/** A box: 32-bit size + 4-char type (© = 0xA9) + payload. */
export function box(type, ...payload) {
  const body = cat(payload);
  return cat([u32(8 + body.length), str(type), body]);
}
const fullBox = (type, version, flags, ...payload) => box(type, u8(version), u24(flags), ...payload);
const MATRIX = cat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

// MPEG-4 descriptor with a 4-byte (0x80-continued) length, as most muxers write it
const desc = (tag, ...payload) => {
  const body = cat(payload);
  const n = body.length;
  return cat([u8(tag, 0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127), body]);
};

function esds(asc, bitrate, maxFrame) {
  return fullBox('esds', 0, 0,
    desc(3, u16(1), u8(0), // ES_ID, flags
      desc(4, u8(0x40), u8((0x05 << 2) | 1), u24(maxFrame), u32(bitrate), u32(bitrate), // MPEG-4 audio, audio stream
        desc(5, asc)),
      desc(6, u8(2))));
}

const dataAtom = (type, payload) => box('data', u32(type), u32(0), payload);
const textItem = (name, value) => box(name, dataAtom(1, enc.encode(String(value))));
const freeform = (name, value) => box('----', fullBox('mean', 0, 0, str('com.apple.iTunes')), fullBox('name', 0, 0, str(name)), dataAtom(1, enc.encode(String(value))));
const hex = (v, n) => Math.max(0, Math.round(v)).toString(16).toUpperCase().padStart(n, '0');

/** iTunes-style metadata: udta > meta > hdlr(mdir) + ilst. */
export function itunesMeta(tags = {}, { priming = 0, padding = 0, samples = 0 } = {}) {
  const items = [];
  const t = (name, v) => { if (v != null && String(v).trim() !== '') items.push(textItem(name, String(v).trim())); };
  t('\xa9nam', tags.title);
  t('\xa9ART', tags.artist);
  t('\xa9alb', tags.album);
  t('\xa9cmt', tags.comment);
  t('\xa9day', tags.year ?? (tags.date ? String(tags.date).slice(0, 10) : null));
  t('\xa9gen', tags.genre);
  t('\xa9too', tags.software);
  if (tags.bpm) items.push(box('tmpo', dataAtom(21, u16(Math.round(tags.bpm)))));
  if (tags.cover?.data?.length) items.push(box('covr', dataAtom(/png/.test(tags.cover.mime || '') ? 14 : 13, tags.cover.data)));
  if (tags.isrc) items.push(freeform('ISRC', tags.isrc));
  if (samples) items.push(freeform('iTunSMPB', ` 00000000 ${hex(priming, 8)} ${hex(padding, 8)} ${hex(samples, 16)} 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000`));
  return box('udta', fullBox('meta', 0, 0,
    fullBox('hdlr', 0, 0, u32(0), str('mdir'), str('appl'), u32(0), u32(0), u8(0)),
    box('ilst', ...items)));
}

/** Mux raw AAC access units into an .m4a (one chunk, frames after the moov). */
export function muxM4a({ frames, asc, sampleRate, channels = 2, samples = null, priming = 2112, frameSamples = 1024, bitrate = 0, tags = {} }) {
  if (!frames?.length) throw new Error('no AAC frames to mux');
  if (sampleRate > 65535) throw new Error('mp4a sample entries hold rates up to 65535 Hz');
  const n = frames.length;
  const mediaDur = n * frameSamples;
  const keep = Math.max(0, Math.min(samples ?? mediaDur - priming, mediaDur - priming));
  const padding = Math.max(0, mediaDur - priming - keep);
  const sizes = frames.map((f) => f.length);
  const maxFrame = Math.max(...sizes);
  const avg = bitrate || Math.round((sizes.reduce((a, s) => a + s, 0) * 8 * sampleRate) / mediaDur);
  const now = 0; // creation time: 1904 epoch, left 0 (deterministic files)
  const build = (mdatOffset) => {
    const stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1),
        box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536), esds(asc, avg, maxFrame))),
      fullBox('stts', 0, 0, u32(1), u32(n), u32(frameSamples)),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      fullBox('stsz', 0, 0, u32(0), u32(n), ...sizes.map(u32)),
      fullBox('stco', 0, 0, u32(1), u32(mdatOffset)));
    const minf = box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)),
      box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl);
    const mdia = box('mdia',
      fullBox('mdhd', 0, 0, u32(now), u32(now), u32(sampleRate), u32(mediaDur), u16(0x55c4), u16(0)), // 'und'
      fullBox('hdlr', 0, 0, u32(0), str('soun'), zeros(12), str('SoundHandler'), u8(0)), minf);
    const edts = box('edts', fullBox('elst', 0, 0, u32(1), u32(keep), u32(priming), u16(1), u16(0)));
    const trak = box('trak',
      fullBox('tkhd', 0, 3, u32(now), u32(now), u32(1), u32(0), u32(keep), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
      edts, mdia);
    const mvhd = fullBox('mvhd', 0, 0, u32(now), u32(now), u32(sampleRate), u32(keep), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
    return box('moov', mvhd, trak, itunesMeta(tags, { priming, padding, samples: keep }));
  };
  const ftyp = box('ftyp', str('M4A '), u32(0), str('M4A '), str('mp42'), str('isom'));
  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const mdat = cat([u32(8 + sizes.reduce((a, s) => a + s, 0)), str('mdat'), ...frames]);
  return cat([ftyp, moov, mdat]);
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'meta', 'stsd', 'mp4a']);
const SKIP = { meta: 4, stsd: 8, mp4a: 28 }; // full-box / entry headers before the children

/** Box tree (sizes validated against the parent). */
export function parseBoxes(bytes, start = 0, end = bytes.length, depth = 0) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); header = 16; }
    if (size === 0) size = end - o;
    if (size < header || o + size > end) throw new Error(`bad box '${type}' at ${o} (size ${size})`);
    const b = { type, start: o, size, header };
    if (CONTAINERS.has(type)) b.children = parseBoxes(bytes, o + header + (SKIP[type] || 0), o + size, depth + 1);
    if (type === 'ilst') b.children = parseIlst(bytes, o + header, o + size);
    out.push(b);
    o += size;
  }
  if (o !== end) throw new Error(`trailing bytes after box at ${o}`);
  return out;
}
function parseIlst(bytes, start, end) {
  const items = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = start;
  while (o + 8 <= end) {
    const size = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (size < 8 || o + size > end) throw new Error(`bad ilst item '${type}'`);
    items.push({ type, start: o, size, header: 8, children: parseBoxes(bytes, o + 8, o + size, 9) });
    o += size;
  }
  return items;
}

export const findBox = (tree, path) => {
  let level = tree;
  let b = null;
  for (const t of path.split('/')) {
    b = level?.find((x) => x.type === t);
    if (!b) return null;
    level = b.children;
  }
  return b;
};

/** Read back what muxM4a wrote (tests, the export report). */
export function readM4a(bytes) {
  const tree = parseBoxes(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const body = (b) => b.start + b.header;
  const ftyp = findBox(tree, 'ftyp');
  const major = String.fromCharCode(...bytes.subarray(body(ftyp), body(ftyp) + 4));
  const mdhd = findBox(tree, 'moov/trak/mdia/mdhd');
  const sampleRate = dv.getUint32(body(mdhd) + 12);
  const duration = dv.getUint32(body(mdhd) + 16);
  const elst = findBox(tree, 'moov/trak/edts/elst');
  const editDuration = dv.getUint32(body(elst) + 8), priming = dv.getUint32(body(elst) + 12);
  const mp4a = findBox(tree, 'moov/trak/mdia/minf/stbl/stsd/mp4a');
  const channels = dv.getUint16(body(mp4a) + 16);
  const esdsB = mp4a.children.find((c) => c.type === 'esds');
  // descriptor walk: find tag 5
  let p = body(esdsB) + 4;
  const endE = esdsB.start + esdsB.size;
  let asc = null, objectType = null;
  const readLen = () => { let n = 0, c; do { c = bytes[p++]; n = (n << 7) | (c & 127); } while (c & 128); return n; };
  while (p < endE) {
    const tag = bytes[p++];
    const n = readLen();
    if (tag === 3) { p += 3; continue; }
    if (tag === 4) { objectType = bytes[p]; p += 13; continue; }
    if (tag === 5) { asc = bytes.slice(p, p + n); break; }
    p += n;
  }
  const stsz = findBox(tree, 'moov/trak/mdia/minf/stbl/stsz');
  const count = dv.getUint32(body(stsz) + 8);
  const sizes = Array.from({ length: count }, (_, i) => dv.getUint32(body(stsz) + 12 + 4 * i));
  const stco = findBox(tree, 'moov/trak/mdia/minf/stbl/stco');
  const chunkOffset = dv.getUint32(body(stco) + 8);
  const mdat = findBox(tree, 'mdat');
  const tags = {};
  const ilst = findBox(tree, 'moov/udta/meta/ilst');
  for (const it of ilst?.children || []) {
    const data = it.children.find((c) => c.type === 'data');
    if (!data) continue;
    const payload = bytes.subarray(body(data) + 8, data.start + data.size);
    let key = it.type;
    if (key === '----') {
      const nm = it.children.find((c) => c.type === 'name');
      key = new TextDecoder().decode(bytes.subarray(body(nm) + 4, nm.start + nm.size));
    }
    tags[key] = key === 'covr' ? payload.slice() : key === 'tmpo' ? (payload[0] << 8) | payload[1] : new TextDecoder().decode(payload);
  }
  return { major, tree, sampleRate, channels, frames: count, sizes, chunkOffset, mdatStart: mdat.start + mdat.header, mdatEnd: mdat.start + mdat.size, duration, editDuration, priming, asc, objectType, tags };
}
