// Lock-free single-producer / single-consumer ring of float frames on a SharedArrayBuffer — the
// bridge between AudioWorklets (render thread) and the pump worker that talks to the native audio
// server. Works with any record width: an audio ring stores `channels` floats per frame, a packet
// ring stores one fixed-size record per "frame" (see PACKET_* below). Pure JS, Node-testable.
//
// SAB layout: Int32 header [HEADER_INTS] then Float32 data (capacity * channels).
//   h[0] write index (frames, wraps at 2^32)  h[1] read index   h[2] capacity (power of two)
//   h[3] channels   h[4] overruns   h[5] underruns   h[6] generation (bumped on reset)   h[7] user flag

export const HEADER_INTS = 8;
const W = 0, R = 1, CAP = 2, CH = 3, OVER = 4, UNDER = 5, GEN = 6, FLAG = 7;

const pow2 = (n) => { let c = 1; while (c < n) c *= 2; return c; };

/** Allocate the shared memory for a ring (capacity rounded up to a power of two). */
export function createRingBuffer(capacityFrames, channels = 2) {
  const cap = pow2(Math.max(2, capacityFrames | 0));
  const ch = Math.max(1, channels | 0);
  const SAB = globalThis.SharedArrayBuffer;
  if (!SAB) throw new Error('SharedArrayBuffer is unavailable (the page must be cross-origin isolated)');
  const sab = new SAB(HEADER_INTS * 4 + cap * ch * 4);
  const h = new Int32Array(sab, 0, HEADER_INTS);
  h[CAP] = cap;
  h[CH] = ch;
  return sab;
}

export class RingBuffer {
  constructor(sab) {
    this.sab = sab;
    this.h = new Int32Array(sab, 0, HEADER_INTS);
    this.capacity = this.h[CAP];
    this.channels = this.h[CH];
    this.mask = this.capacity - 1;
    this.data = new Float32Array(sab, HEADER_INTS * 4, this.capacity * this.channels);
  }

  /** Frames ready to read. */
  available() { return (Atomics.load(this.h, W) - Atomics.load(this.h, R)) >>> 0; }
  /** Frames that can be written without overwriting unread data. */
  space() { return this.capacity - this.available(); }
  get overruns() { return Atomics.load(this.h, OVER); }
  get underruns() { return Atomics.load(this.h, UNDER); }
  noteUnderrun() { Atomics.add(this.h, UNDER, 1); }
  get flag() { return Atomics.load(this.h, FLAG); }
  set flag(v) { Atomics.store(this.h, FLAG, v | 0); Atomics.notify(this.h, FLAG); }

  /** Producer: interleaved frames in. Returns frames written (the rest is dropped and counted). */
  write(src, frames = Math.floor(src.length / this.channels)) {
    const ch = this.channels;
    const w = Atomics.load(this.h, W) >>> 0;
    const n = Math.min(frames, this.capacity - ((w - (Atomics.load(this.h, R) >>> 0)) >>> 0));
    if (n < frames) Atomics.add(this.h, OVER, 1);
    let i = w & this.mask;
    const first = Math.min(n, this.capacity - i);
    this.data.set(src.subarray(0, first * ch), i * ch);
    if (n > first) this.data.set(src.subarray(first * ch, n * ch), 0);
    Atomics.store(this.h, W, (w + n) | 0);
    return n;
  }

  /** Producer: planar channels in (chans[c] is a Float32Array), starting at frame `offset` of each. */
  writePlanar(chans, frames, offset = 0) {
    const ch = this.channels;
    const w = Atomics.load(this.h, W) >>> 0;
    const n = Math.min(frames, this.capacity - ((w - (Atomics.load(this.h, R) >>> 0)) >>> 0));
    if (n < frames) Atomics.add(this.h, OVER, 1);
    const d = this.data;
    for (let f = 0; f < n; f++) {
      const base = ((w + f) & this.mask) * ch;
      for (let c = 0; c < ch; c++) {
        const src = chans[c < chans.length ? c : chans.length - 1];
        d[base + c] = src ? src[offset + f] : 0;
      }
    }
    Atomics.store(this.h, W, (w + n) | 0);
    return n;
  }

  /** Consumer: interleaved frames out. Returns frames read (dst may be null to skip). */
  read(dst, frames) {
    const ch = this.channels;
    const r = Atomics.load(this.h, R) >>> 0;
    const n = Math.min(frames, (Atomics.load(this.h, W) - r) >>> 0);
    if (dst) {
      const i = r & this.mask;
      const first = Math.min(n, this.capacity - i);
      dst.set(this.data.subarray(i * ch, (i + first) * ch), 0);
      if (n > first) dst.set(this.data.subarray(0, (n - first) * ch), first * ch);
    }
    Atomics.store(this.h, R, (r + n) | 0);
    return n;
  }

  /** Consumer: planar channels out (missing frames are left untouched). */
  readPlanar(chans, frames) {
    const ch = this.channels;
    const r = Atomics.load(this.h, R) >>> 0;
    const n = Math.min(frames, (Atomics.load(this.h, W) - r) >>> 0);
    const d = this.data;
    for (let f = 0; f < n; f++) {
      const base = ((r + f) & this.mask) * ch;
      for (let c = 0; c < chans.length; c++) chans[c][f] = c < ch ? d[base + c] : d[base + ch - 1];
    }
    Atomics.store(this.h, R, (r + n) | 0);
    return n;
  }

  /** Consumer: drop everything queued. */
  clear() { Atomics.store(this.h, R, Atomics.load(this.h, W)); }
}

// ---- plugin packets: one record per render quantum sent to a native plugin
// [0] block index (low 24 bits safe as float) [1] event count [2] frames [3] reserved
// [4 .. 4 + MAX_EVENTS*4) events: offset, status, data1, data2   then audio: numIn * BLOCK planar
export const BLOCK = 128;
export const PACKET_MAX_EVENTS = 32;
export const PACKET_HEADER = 4 + PACKET_MAX_EVENTS * 4;
export const packetSize = (numIn) => PACKET_HEADER + BLOCK * Math.max(0, numIn);

/** Write one quantum (planar input + MIDI events [[offset, status, d1, d2]…]) into a record. */
export function encodePacket(rec, blockIndex, input, numIn, events = []) {
  rec[0] = blockIndex;
  const ne = Math.min(events.length, PACKET_MAX_EVENTS);
  rec[1] = ne;
  rec[2] = BLOCK;
  for (let i = 0; i < ne; i++) {
    const e = events[i];
    rec[4 + i * 4] = e[0]; rec[5 + i * 4] = e[1]; rec[6 + i * 4] = e[2]; rec[7 + i * 4] = e[3];
  }
  for (let c = 0; c < numIn; c++) {
    const src = input[c < input.length ? c : input.length - 1];
    const off = PACKET_HEADER + c * BLOCK;
    if (src) rec.set(src.subarray(0, BLOCK), off); else rec.fill(0, off, off + BLOCK);
  }
  return rec;
}

/** -> { block, frames, midi: Float64Array [offset, status, d1, d2]*, audio: Float32Array planar } */
export function decodePacket(rec, numIn) {
  const ne = Math.min(rec[1] | 0, PACKET_MAX_EVENTS);
  const midi = new Float64Array(ne * 4);
  for (let i = 0; i < ne * 4; i++) midi[i] = rec[4 + i];
  return { block: rec[0], frames: rec[2] | 0, midi, audio: rec.slice(PACKET_HEADER, PACKET_HEADER + numIn * BLOCK) };
}
