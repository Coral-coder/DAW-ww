// Invite / answer codes for zero-infrastructure sessions: a signaling message (SDP offer or answer
// with all ICE candidates gathered) as JSON -> deflate-raw -> base64url, prefixed "daw3:".
// Uses the platform CompressionStream (browsers, Node 18+); falls back to plain base64url.
// Pure / Node-safe.

const PREFIX = 'daw3:';

function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Drop SDP lines a data-channel-only connection never needs (keeps codes short). */
export function minifySdp(sdp) {
  return String(sdp).split(/\r?\n/).filter((l) => l && !/^a=(extmap-allow-mixed|msid-semantic)/.test(l)).join('\r\n') + '\r\n';
}

/** Signal object -> "daw3:<base64url>". Format byte: 'z' deflate-raw JSON, 'j' plain JSON. */
export async function encodeSignal(sig) {
  const json = new TextEncoder().encode(JSON.stringify(sig));
  if (canCompress()) {
    const z = await pipe(json, new CompressionStream('deflate-raw'));
    return PREFIX + 'z' + toB64url(z);
  }
  return PREFIX + 'j' + toB64url(json);
}

/** "daw3:..." -> signal object. Throws a readable Error for anything else. */
export async function decodeSignal(code) {
  const s = String(code || '').replace(/\s+/g, '');
  if (!s.startsWith(PREFIX) || s.length < PREFIX.length + 2) throw new Error('Not a daW³ invite code.');
  const kind = s[PREFIX.length];
  const body = s.slice(PREFIX.length + 1);
  try {
    let bytes = fromB64url(body);
    if (kind === 'z') {
      if (!canCompress()) throw new Error('This browser cannot read compressed codes.');
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'j') throw new Error('unknown code format');
    const sig = JSON.parse(new TextDecoder().decode(bytes));
    if (!sig || typeof sig !== 'object' || typeof sig.t !== 'string') throw new Error('missing type');
    return sig;
  } catch (e) {
    throw new Error(`Invite code is damaged or incomplete (${e.message}).`);
  }
}
