// Content-addressed samples for collaboration: synchronous SHA-256 (no crypto.subtle needed, so it
// works inside synchronous store diffs and in Node), base64 chunking and verified reassembly.
// Samples travel on demand: the CRDT only carries metadata { id, name, mime, duration, hash, size };
// a peer missing the bytes for a hash asks others with 'sreq' and gets 'schunk' messages back.
import { base64ToArrayBuffer } from '../io/samples.js';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of bytes (Uint8Array | ArrayBuffer | string as UTF-8) -> lowercase hex. */
export function sha256(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(total - 4, (len << 3) >>> 0, false);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Hash of a project sample's bytes (its base64 `data` decoded). */
export function hashSampleData(b64) {
  return sha256(new Uint8Array(base64ToArrayBuffer(b64 || '')));
}

/** Caches hashes per sample id while its data string is unchanged. */
export class SampleHasher {
  constructor() { this.cache = new Map(); }
  hash(id, data) {
    const c = this.cache.get(id);
    if (c && c.data === data) return c.hash;
    const hash = hashSampleData(data);
    this.cache.set(id, { data, hash });
    return hash;
  }
}

export const CHUNK_CHARS = 16 * 1024; // base64 chars per data-channel message (well below SCTP limits)

/** Split base64 data into transfer chunks: [{ hash, i, n, d }]. */
export function chunkSample(hash, b64, size = CHUNK_CHARS) {
  const n = Math.max(1, Math.ceil(b64.length / size));
  const out = [];
  for (let i = 0; i < n; i++) out.push({ hash, i, n, d: b64.slice(i * size, (i + 1) * size) });
  return out;
}

/** Collects chunks (any order, duplicates ok); resolves complete + verified data per hash. */
export class ChunkAssembler {
  constructor() { this.parts = new Map(); }
  /** -> { done:false } | { done:true, ok:boolean, data?:string } */
  add({ hash, i, n, d }) {
    if (typeof hash !== 'string' || !(n > 0) || !(i >= 0 && i < n) || typeof d !== 'string') return { done: false };
    let p = this.parts.get(hash);
    if (!p || p.n !== n) this.parts.set(hash, (p = { n, got: new Map() }));
    p.got.set(i, d);
    if (p.got.size < n) return { done: false, received: p.got.size, total: n };
    this.parts.delete(hash);
    let data = '';
    for (let k = 0; k < n; k++) data += p.got.get(k);
    const ok = hashSampleData(data) === hash;
    return ok ? { done: true, ok, data } : { done: true, ok: false };
  }
  pending(hash) { return this.parts.has(hash); }
  drop(hash) { this.parts.delete(hash); }
}
