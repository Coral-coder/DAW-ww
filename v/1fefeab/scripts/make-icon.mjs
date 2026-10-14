// Generates build/icon.png (1024×1024) for the Mac app — zero dependencies (zlib PNG encoder).
// electron-builder derives the .icns from it. Run: npm run mac:icon
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function renderIcon(S = 1024) {
  const px = new Uint8Array(S * S * 4);
  const pad = S * 0.09, r = S * 0.2, x0 = pad, y0 = pad, x1 = S - pad, y1 = S - pad;
  // the favicon's zig-zag waveform, in a 32-unit box mapped into the squircle
  const pts = [[6, 20], [10, 12], [14, 22], [18, 8], [22, 20], [26, 14]].map(([x, y]) => [x0 + ((x - 3) / 26) * (x1 - x0), y0 + ((y - 1) / 30) * (y1 - y0)]);
  const stroke = S * 0.052;
  const segDist = (px_, py, [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px_ - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px_ - ax - t * dx, py - ay - t * dy);
  };
  const c0 = [124, 92, 255], c1 = [0, 212, 255];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const qx = Math.max(x0 + r - x - 0.5, 0, x + 0.5 - (x1 - r)), qy = Math.max(y0 + r - y - 0.5, 0, y + 0.5 - (y1 - r));
      const d = Math.hypot(qx, qy) - r; // rounded-rect SDF (negative inside)
      const inside = Math.max(0, Math.min(1, 0.5 - d));
      if (inside <= 0) continue;
      const t = ((x - x0) + (y - y0)) / ((x1 - x0) + (y1 - y0));
      let cr = c0[0] + (c1[0] - c0[0]) * t, cg = c0[1] + (c1[1] - c0[1]) * t, cb = c0[2] + (c1[2] - c0[2]) * t;
      let sd = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) sd = Math.min(sd, segDist(x + 0.5, y + 0.5, pts[i], pts[i + 1]));
      const w = Math.max(0, Math.min(1, stroke / 2 - sd + 0.5));
      cr += (255 - cr) * w; cg += (255 - cg) * w; cb += (255 - cb) * w;
      const o = (y * S + x) * 4;
      px[o] = cr; px[o + 1] = cg; px[o + 2] = cb; px[o + 3] = Math.round(inside * 255);
    }
  }
  return encodePng(px, S, S);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = new URL('../build/icon.png', import.meta.url);
  mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
  writeFileSync(out, renderIcon(1024));
  console.log('wrote', fileURLToPath(out));
}
