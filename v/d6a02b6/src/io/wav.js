// WAV (RIFF) encoder for AudioBuffer-like objects:
//   { numberOfChannels, sampleRate, length, getChannelData(i) -> Float32Array }
// bitDepth 16 / 24 -> integer PCM (format 1), 32 -> IEEE float (format 3, with fact chunk).

export function encodeWav(buffer, { bitDepth = 16 } = {}) {
  const depth = Number(bitDepth) === 32 || bitDepth === '32float' ? 32 : Number(bitDepth) === 24 ? 24 : 16;
  const float = depth === 32;
  const channels = Math.max(1, buffer.numberOfChannels | 0);
  const sampleRate = Math.round(buffer.sampleRate) || 44100;
  const length = buffer.length | 0;
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

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(Math.min(c, (buffer.numberOfChannels || 1) - 1)));
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      let s = data[c][i] || 0;
      if (float) { view.setFloat32(p, s, true); p += 4; continue; }
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      if (depth === 16) {
        view.setInt16(p, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
        p += 2;
      } else {
        let v = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff);
        if (v < 0) v += 0x1000000;
        view.setUint8(p, v & 0xff); view.setUint8(p + 1, (v >> 8) & 0xff); view.setUint8(p + 2, (v >> 16) & 0xff);
        p += 3;
      }
    }
  }
  return ab;
}

/** Convenience: encodeWav -> Blob (browser / Node 18+). */
export function wavBlob(buffer, opts) {
  return new Blob([encodeWav(buffer, opts)], { type: 'audio/wav' });
}
