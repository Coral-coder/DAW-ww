// WAV (RIFF) encoder / decoder.
//
// encodeWav(buffers, opts) -> ArrayBuffer
//   buffers: an AudioBuffer-like { numberOfChannels, sampleRate, length, getChannelData(i) }
//            | Float32Array[] (one per channel; pass opts.sampleRate) | { channels: Float32Array[], sampleRate }
//   opts: {
//     bitDepth: 16 | 24 | 32 (32 = IEEE float, format 3, bit-exact float32 — values beyond ±1 are kept, no clipping)
//     dither: 'none' (default) | 'tpdf'            16 / 24-bit only: triangular (±1 LSB) dither before rounding
//     noiseShaping: 'none' (default) | 'first' | 'shaped'
//                                                   error feedback: first-order (+6 dB/oct) or a 3-tap F-weighted
//                                                   curve (Wannamaker) that moves the noise above ~10 kHz
//     seed: number                                  dither RNG seed (deterministic output; default fixed)
//     sampleRate                                    for plain channel arrays
//   }
//   Integer formats clamp to the legal range after dither (never wrap); float keeps everything.
// decodeWav(arrayBuffer) -> { sampleRate, bitDepth, float, channels: Float32Array[] }   (PCM 8/16/24/32, float 32/64)
// wavBlob(buffers, opts) -> Blob

function asChannels(buffers, opts) {
  if (Array.isArray(buffers)) return { channels: buffers, sampleRate: opts.sampleRate || 44100 };
  if (buffers && Array.isArray(buffers.channels)) return { channels: buffers.channels, sampleRate: buffers.sampleRate || opts.sampleRate || 44100 };
  const n = Math.max(1, buffers.numberOfChannels | 0);
  const channels = [];
  for (let c = 0; c < n; c++) channels.push(buffers.getChannelData(Math.min(c, (buffers.numberOfChannels || 1) - 1)));
  return { channels, sampleRate: buffers.sampleRate, length: buffers.length | 0 };
}

/** Small fast deterministic RNG (mulberry32) -> [0, 1). */
function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHAPING = { none: [], first: [1], shaped: [1.623, -0.982, 0.109] };

export function encodeWav(buffers, opts = {}) {
  const { bitDepth = 16 } = opts;
  const depth = Number(bitDepth) === 32 || bitDepth === '32float' ? 32 : Number(bitDepth) === 24 ? 24 : 16;
  const float = depth === 32;
  const src = asChannels(buffers, opts);
  const data = src.channels;
  const channels = Math.max(1, data.length);
  const sampleRate = Math.round(src.sampleRate) || 44100;
  const length = src.length ?? (data[0]?.length | 0);
  const bytesPerSample = depth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const fmtSize = float ? 18 : 16;
  const factSize = float ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const ab = new ArrayBuffer(headerSize + dataSize + (dataSize % 2));
  const view = new DataView(ab);
  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };

  str('RIFF'); u32(ab.byteLength - 8); str('WAVE');
  str('fmt '); u32(fmtSize);
  u16(float ? 3 : 1); u16(channels); u32(sampleRate); u32(sampleRate * blockAlign); u16(blockAlign); u16(depth);
  if (float) u16(0);
  if (float) { str('fact'); u32(4); u32(length); }
  str('data'); u32(dataSize);

  if (float) {
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) { const v = data[c][i]; view.setFloat32(p, v === undefined ? 0 : v, true); p += 4; }
    }
    return ab;
  }

  // integer PCM: scale to LSB units, optional noise-shaped TPDF dither, round, clamp
  const maxPos = depth === 16 ? 0x7fff : 0x7fffff;
  const minNeg = depth === 16 ? -0x8000 : -0x800000;
  const dither = opts.dither === 'tpdf' || opts.dither === true;
  const coefs = SHAPING[opts.noiseShaping] || SHAPING.none;
  const rand = rng(opts.seed ?? 0x5eed);
  const errs = Array.from({ length: channels }, () => new Float64Array(coefs.length)); // e[n-1], e[n-2], …
  const plain = !dither && !coefs.length;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      let s = data[c][i] || 0;
      let v;
      if (plain) {
        // (original rounding, kept bit-identical for existing callers)
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        v = s < 0 ? Math.round(s * (maxPos + 1)) : Math.round(s * maxPos);
      } else {
        const x = s * (maxPos + 1); // LSB units, symmetric scale
        const e = errs[c];
        let y = x;
        for (let k = 0; k < coefs.length; k++) y -= coefs[k] * e[k];
        const d = dither ? rand() - rand() : 0; // TPDF in (-1, 1) LSB
        v = Math.round(y + d);
        if (v > maxPos) v = maxPos; else if (v < minNeg) v = minNeg;
        if (coefs.length) {
          for (let k = coefs.length - 1; k > 0; k--) e[k] = e[k - 1];
          // error the next samples compensate (bounded so a clamped overload can't run away)
          const err = v - y;
          e[0] = err > 4 ? 4 : err < -4 ? -4 : err;
        }
      }
      if (depth === 16) {
        view.setInt16(p, v, true);
        p += 2;
      } else {
        if (v < 0) v += 0x1000000;
        view.setUint8(p, v & 0xff); view.setUint8(p + 1, (v >> 8) & 0xff); view.setUint8(p + 2, (v >> 16) & 0xff);
        p += 3;
      }
    }
  }
  return ab;
}

/** Parse a RIFF/WAVE file (PCM 8/16/24/32-bit int, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE). */
export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength));
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (view.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let fmt = null;
  let dataOff = -1, dataLen = 0;
  for (let o = 12; o + 8 <= view.byteLength;) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = view.getUint16(o + 8, true);
      if (format === 0xfffe && size >= 40) format = view.getUint16(o + 8 + 24, true); // extensible: sub-format GUID
      fmt = { format, channels: view.getUint16(o + 10, true), sampleRate: view.getUint32(o + 12, true), bits: view.getUint16(o + 22, true) };
    } else if (id === 'data') {
      dataOff = o + 8;
      dataLen = Math.min(size, view.byteLength - dataOff);
      break;
    }
    o += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('Malformed WAV file');
  const { format, channels, sampleRate, bits } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const float = format === 3;
  if (!float && format !== 1) throw new Error(`Unsupported WAV format ${format}`);
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v;
      if (float) v = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      else if (bits === 8) v = (view.getUint8(p) - 128) / 128;
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) { let x = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
      else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      else throw new Error(`Unsupported WAV bit depth ${bits}`);
      out[c][i] = v;
      p += bps;
    }
  }
  return { sampleRate, bitDepth: bits, float, channels: out };
}

/** Convenience: encodeWav -> Blob (browser / Node 18+). */
export function wavBlob(buffer, opts) {
  return new Blob([encodeWav(buffer, opts)], { type: 'audio/wav' });
}
