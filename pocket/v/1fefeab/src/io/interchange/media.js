// Media helpers shared by the interchange formats (pure, Node-safe).

const EXT_BY_MIME = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/webm': 'webm', 'audio/aiff': 'aif', 'audio/x-aiff': 'aif',
};
const MIME_BY_EXT = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
};

export const extForMime = (mime) => EXT_BY_MIME[String(mime || '').toLowerCase().split(';')[0]] || 'wav';
export const mimeForPath = (path) => MIME_BY_EXT[String(path || '').split('.').pop().toLowerCase()] || 'application/octet-stream';

/** RIFF/WAVE header -> { sampleRate, channels, bitDepth, frames, duration } or null. */
export function wavInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12;
  let fmt = null;
  while (p + 8 <= b.length) {
    const id = tag(p);
    const size = v.getUint32(p + 4, true);
    if (id === 'fmt ' && size >= 16) {
      fmt = { channels: v.getUint16(p + 10, true), sampleRate: v.getUint32(p + 12, true), blockAlign: v.getUint16(p + 20, true), bitDepth: v.getUint16(p + 22, true) };
    } else if (id === 'data' && fmt) {
      const dataSize = Math.min(size, b.length - p - 8);
      const frames = fmt.blockAlign ? Math.floor(dataSize / fmt.blockAlign) : 0;
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitDepth: fmt.bitDepth, frames, duration: fmt.sampleRate ? frames / fmt.sampleRate : 0 };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

/** Filesystem-safe base name (keeps unicode letters, drops path separators / reserved chars). */
export function safeName(name, fallback = 'file') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/** Returns a function that makes names unique within one archive folder. */
export function uniqueNamer() {
  const used = new Set();
  return (base, ext) => {
    let n = `${base}.${ext}`;
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base} ${k}.${ext}`;
    used.add(n.toLowerCase());
    return n;
  };
}
