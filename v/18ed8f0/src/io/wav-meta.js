// WAV metadata: RIFF LIST/INFO and iXML chunks appended to an encoded WAV (pure, Node-safe).
//
//   addWavMetadata(arrayBuffer, {title, artist, album, comment, date, isrc, software, bpm, key, genre}) -> ArrayBuffer
//   readWavMetadata(arrayBuffer) -> {info: {INAM: …}, ixml: string|null}
// INFO tags: INAM title, IART artist, IPRD album, ICMT comment, ICRD date, IGNR genre, ISFT software, ISRC (ISRC code —
// the conventional use by broadcast / distribution tools), plus the same data (and BPM / key) in an iXML document.

const enc = (s) => new TextEncoder().encode(String(s));
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Normalise an ISRC ("US-ABC-24-00001" → "USABC2400001"); '' when it isn't a valid 12-character code. */
export function cleanIsrc(s) {
  const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(c) ? c : '';
}

function chunk(id, bytes) {
  const pad = bytes.length % 2;
  const out = new Uint8Array(8 + bytes.length + pad);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, bytes.length, true);
  out.set(bytes, 8);
  return out;
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function addWavMetadata(arrayBuffer, meta = {}) {
  const tags = [
    ['INAM', meta.title], ['IART', meta.artist], ['IPRD', meta.album], ['ICMT', meta.comment],
    ['ICRD', meta.date], ['IGNR', meta.genre], ['ISFT', meta.software || 'daW³'], ['ISRC', cleanIsrc(meta.isrc)],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
  const parts = [];
  if (tags.length) {
    const subs = tags.map(([id, v]) => chunk(id, concat([enc(String(v).trim()), new Uint8Array([0])])));
    parts.push(chunk('LIST', concat([enc('INFO'), ...subs])));
  }
  const ixmlFields = [
    ['PROJECT', meta.title], ['NOTE', meta.comment], ['ARTIST', meta.artist], ['ISRC', cleanIsrc(meta.isrc)], ['TEMPO', meta.bpm], ['KEY', meta.key],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
  if (ixmlFields.length) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<BWFXML><IXML_VERSION>2.10</IXML_VERSION>${ixmlFields.map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('')}</BWFXML>`;
    parts.push(chunk('iXML', enc(xml)));
  }
  if (!parts.length) return arrayBuffer;
  const extra = concat(parts);
  const src = new Uint8Array(arrayBuffer);
  const out = new Uint8Array(src.length + extra.length);
  out.set(src, 0);
  out.set(extra, src.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true); // RIFF size
  return out.buffer;
}

export function readWavMetadata(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const id = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  const info = {};
  let ixml = null;
  let o = 12;
  const dec = new TextDecoder();
  while (o + 8 <= v.byteLength) {
    const cid = id(o);
    const size = v.getUint32(o + 4, true);
    if (cid === 'LIST' && id(o + 8) === 'INFO') {
      let p = o + 12;
      while (p + 8 <= o + 8 + size) {
        const sid = id(p);
        const ss = v.getUint32(p + 4, true);
        info[sid] = dec.decode(new Uint8Array(arrayBuffer, p + 8, ss)).replace(/\0+$/, '');
        p += 8 + ss + (ss % 2);
      }
    } else if (cid === 'iXML') ixml = dec.decode(new Uint8Array(arrayBuffer, o + 8, size));
    o += 8 + size + (size % 2);
  }
  return { info, ixml };
}
