// Sample helpers: base64 <-> bytes (Node + browser), File -> Sample.
import { uid } from '../core/util.js';

const hasBuffer = typeof globalThis.Buffer === 'function' && typeof globalThis.Buffer.from === 'function';

export function arrayBufferToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  if (hasBuffer) return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

export function base64ToArrayBuffer(b64) {
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (hasBuffer) {
    const b = globalThis.Buffer.from(clean, 'base64');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const MIME_BY_EXT = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
};
export function guessMime(name, fallback = 'application/octet-stream') {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

/** Browser File/Blob -> Sample { id, name, mime, data(base64), duration:null }. */
export async function fileToSample(file) {
  const buf = await file.arrayBuffer();
  const name = String(file.name || 'sample').replace(/\.[^.]+$/, '') || 'sample';
  return {
    id: uid('smp'),
    name,
    mime: file.type || guessMime(file.name, 'audio/wav'),
    data: arrayBufferToBase64(buf),
    duration: null,
  };
}

/** Sample -> ArrayBuffer of the original file bytes (e.g. for decodeAudioData). */
export function sampleToArrayBuffer(sample) {
  return base64ToArrayBuffer(sample.data);
}

export function sampleToBlob(sample) {
  return new Blob([sampleToArrayBuffer(sample)], { type: sample.mime || 'application/octet-stream' });
}
