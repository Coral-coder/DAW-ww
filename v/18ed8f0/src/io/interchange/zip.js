// Minimal ZIP (PKWARE APPNOTE 6.3) reader / writer — zero dependencies, Node + browser.
//
//   await writeZip([{ name, data: Uint8Array|string, compress?: bool, date?: Date }], { codec? }) -> Uint8Array
//   await readZip(bytes, { codec? }) -> Map(name -> Uint8Array)
//   zipText(map, name) -> string | null
//
// Methods: 0 (store) and 8 (deflate). Deflate uses CompressionStream('deflate-raw') /
// DecompressionStream when the runtime has them (browsers, Node >= 21.2) and falls back to
// node:zlib. A `codec` { deflateRaw(bytes), inflateRaw(bytes) } (sync or async) can be injected —
// the tests use node:zlib that way. No ZIP64, no encryption, no multi-disk archives.

const enc = new TextEncoder();
const dec = new TextDecoder();

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('zip: entry data must be a string, ArrayBuffer or typed array');
}

async function streamThrough(stream, bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

let nodeZlib = null;
async function zlib() {
  if (!nodeZlib) nodeZlib = await import('node:zlib');
  return nodeZlib;
}

/** Default codec: Compression Streams when present, else node:zlib. */
export const defaultCodec = {
  async deflateRaw(bytes) {
    if (typeof CompressionStream === 'function') {
      try { return await streamThrough(new CompressionStream('deflate-raw'), bytes); } catch { /* fall through */ }
    }
    return new Uint8Array((await zlib()).deflateRawSync(bytes));
  },
  async inflateRaw(bytes) {
    if (typeof DecompressionStream === 'function') {
      try { return await streamThrough(new DecompressionStream('deflate-raw'), bytes); } catch { /* fall through */ }
    }
    return new Uint8Array((await zlib()).inflateRawSync(bytes));
  },
};

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds a ZIP archive. Entries are written in the given order. Text compresses by default; set compress:false for audio. */
export async function writeZip(entries, { codec = defaultCodec } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const e of entries) {
    const name = String(e.name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || seen.has(name)) throw new Error(`zip: missing or duplicate entry name "${name}"`);
    seen.add(name);
    const nameBytes = enc.encode(name);
    const raw = toBytes(e.data);
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (e.compress !== false && raw.length > 64) {
      const z = toBytes(await codec.deflateRaw(raw));
      if (z.length < raw.length) { method = 8; body = z; }
    }
    const { time, date } = dosDateTime(e.date || new Date());
    const flags = 0x0800; // UTF-8 names
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // made by
    cd.setUint16(6, 20, true); // needed
    cd.setUint16(8, flags, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
    if (offset > 0xffffffff) throw new Error('zip: archive larger than 4 GB (ZIP64 is not supported)');
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/** True when the bytes start like a ZIP archive (local header or empty-archive EOCD). */
export function isZip(bytes) {
  const b = toBytes(bytes);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
}

/** Reads every file of a ZIP archive (directories skipped) -> Map(name -> Uint8Array). Verifies CRCs. */
export async function readZip(input, { codec = defaultCodec } = {}) {
  const b = toBytes(input);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (end of central directory not found).');
  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported.');
  const out = new Map();
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error(`ZIP entry "${name}" is encrypted.`);
    if (name.endsWith('/')) continue;
    if (v.getUint32(lho, true) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for "${name}".`);
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    const body = b.subarray(start, start + csize);
    let data;
    if (method === 0) data = body.slice();
    else if (method === 8) data = toBytes(await codec.inflateRaw(body));
    else throw new Error(`ZIP entry "${name}" uses unsupported compression method ${method}.`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`ZIP entry "${name}" is corrupt (size/CRC mismatch).`);
    out.set(name, data);
  }
  return out;
}

/** UTF-8 text of an entry (BOM stripped) or null. */
export function zipText(files, name) {
  const d = files.get(name);
  return d ? dec.decode(d).replace(/^﻿/, '') : null;
}
