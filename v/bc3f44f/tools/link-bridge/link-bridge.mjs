#!/usr/bin/env node
// daW³ Ableton Link bridge — browsers cannot speak Link (UDP multicast), so this tiny companion joins the Link
// session and exposes it to daW³ over a local WebSocket (ws://127.0.0.1:20809). Zero dependencies apart from
// the optional `abletonlink` native addon; without it the bridge runs a simulated Link session (handy for
// testing the daW³ side, and it still syncs several browser tabs with each other).
//
//   node tools/link-bridge/link-bridge.mjs [--port 20809] [--origin https://your.daw3.host] [--simulate]
//
// Protocol (JSON text frames):
//   bridge -> client  { type:'state', tempo, beat, phase, quantum, playing, peers, link:true|false, time }
//                      (20×/s and on every change; beat / phase are at `time` = bridge Date.now())
//   client -> bridge  { type:'tempo', bpm } | { type:'play' } | { type:'stop' } | { type:'quantum', value }
// See README.md in this folder (also: integration point for the macOS app build).
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PORT = +opt('port', process.env.DAW3_LINK_PORT || 20809);
const ORIGINS = (opt('origin', process.env.DAW3_LINK_ORIGINS || '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SIMULATE = args.includes('--simulate');

// ------------------------------------------------------------------------------------------- Link session
function simulatedLink() {
  let tempo = 120, quantum = 4, playing = false, t0 = Date.now(), b0 = 0;
  const beatNow = () => b0 + ((Date.now() - t0) / 60000) * tempo;
  return {
    real: false,
    get tempo() { return tempo; },
    set tempo(v) { b0 = beatNow(); t0 = Date.now(); tempo = v; },
    get quantum() { return quantum; }, set quantum(v) { quantum = v; },
    get beat() { return beatNow(); },
    get phase() { const b = beatNow(); return ((b % quantum) + quantum) % quantum; },
    get playing() { return playing; },
    play() { playing = true; }, stop() { playing = false; },
    get peers() { return 0; },
  };
}

function realLink() {
  const require = createRequire(import.meta.url);
  let AbletonLink;
  try { AbletonLink = require('abletonlink'); } catch { return null; }
  const link = new AbletonLink(120, 4, true);
  try { link.enablePlayStateSync?.(); link.isStartStopSyncEnabled = true; } catch { /* older addon */ }
  let beat = 0, phase = 0;
  link.startUpdate(16, (b, ph) => { beat = b; phase = ph; });
  return {
    real: true,
    get tempo() { return link.bpm; }, set tempo(v) { link.bpm = v; },
    get quantum() { return link.quantum; }, set quantum(v) { link.quantum = v; },
    get beat() { return beat; }, get phase() { return phase; },
    get playing() { return !!link.isPlaying; },
    play() { link.play?.(); }, stop() { link.stop?.(); },
    get peers() { return link.numPeers ?? 0; },
  };
}

const link = (!SIMULATE && realLink()) || simulatedLink();
console.log(link.real ? '[link-bridge] Ableton Link enabled (abletonlink addon)' : `[link-bridge] SIMULATED Link session${SIMULATE ? '' : ' — `npm i abletonlink` in this folder for real Link'}`);

// ------------------------------------------------------------------------------------------- minimal WebSocket server
const clients = new Set();
function frame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}
function parseFrames(sock, chunk) {
  sock.buf = sock.buf ? Buffer.concat([sock.buf, chunk]) : chunk;
  const out = [];
  for (;;) {
    const b = sock.buf;
    if (b.length < 2) break;
    const op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskOff = off; if (masked) off += 4;
    if (b.length < off + len) break;
    const data = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) data[i] ^= b[maskOff + (i & 3)];
    sock.buf = b.subarray(off + len);
    out.push({ op, data });
  }
  return out;
}
const originOk = (o) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) || ORIGINS.includes(o) || ORIGINS.includes('*');

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end(`daW³ Link bridge (${link.real ? 'Link' : 'simulated'}) — connect with WebSocket\n`); });
server.on('upgrade', (req, sock) => {
  if (!originOk(req.headers.origin)) { console.warn('[link-bridge] rejected origin', req.headers.origin, '(add it with --origin)'); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(sock);
  sock.write(frame(JSON.stringify(state())));
  sock.on('data', (chunk) => {
    for (const f of parseFrames(sock, chunk)) {
      if (f.op === 8) { sock.end(); return; }
      if (f.op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data])); continue; }
      if (f.op === 1) { try { command(JSON.parse(f.data.toString('utf8'))); } catch (e) { console.warn('[link-bridge] bad message', e.message); } }
    }
  });
  const drop = () => clients.delete(sock);
  sock.on('close', drop); sock.on('error', drop);
});

function state() {
  return { type: 'state', tempo: +link.tempo.toFixed(3), beat: link.beat, phase: link.phase, quantum: link.quantum, playing: link.playing, peers: link.peers, link: link.real, time: Date.now() };
}
function command(m) {
  if (m.type === 'tempo' && m.bpm >= 20 && m.bpm <= 999) link.tempo = +m.bpm;
  else if (m.type === 'play') link.play();
  else if (m.type === 'stop') link.stop();
  else if (m.type === 'quantum' && m.value >= 1 && m.value <= 16) link.quantum = +m.value;
  broadcast();
}
function broadcast() { const f = frame(JSON.stringify(state())); for (const c of clients) c.write(f); }
setInterval(broadcast, 50);

server.listen(PORT, '127.0.0.1', () => console.log(`[link-bridge] ws://127.0.0.1:${PORT}  (daW³: Preferences → Sync → Ableton Link)`));
