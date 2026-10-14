#!/usr/bin/env node
// daW³ collaboration relay — a tiny, dependency-free WebSocket signaling relay (Node 18+).
// It only forwards small signaling messages (SDP offers/answers, ICE candidates) between people in
// the same room; project data never passes through it (that goes peer-to-peer over WebRTC).
//
//   PORT=8787 node tools/collab-relay/server.js
//   client: ws://host:8787/?room=<room>&id=<peerId>
//   server -> client: {type:'peers', peers:[ids]} on join · {type:'join', id} · {type:'leave', id}
//                     {type:'signal', from, data} · {type:'error', message}
//   client -> server: {type:'signal', to, data}
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8787;
const MAX_ROOM = Number(process.env.MAX_ROOM) || 8;
const MAX_MSG = 256 * 1024;
const rooms = new Map(); // room -> Map(id -> socket)

function frame(text) {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length])
    : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p.length)); return b; })()]);
  return Buffer.concat([head, p]);
}
const send = (sock, obj) => { if (!sock.destroyed) sock.write(frame(JSON.stringify(obj))); };

function onMessage(sock, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (m?.type !== 'signal' || typeof m.to !== 'string') return;
  const peer = rooms.get(sock.room)?.get(m.to);
  if (peer) send(peer, { type: 'signal', from: sock.peerId, data: m.data });
}

function leave(sock) {
  const room = rooms.get(sock.room);
  if (!room || room.get(sock.peerId) !== sock) return;
  room.delete(sock.peerId);
  for (const s of room.values()) send(s, { type: 'leave', id: sock.peerId });
  if (!room.size) rooms.delete(sock.room);
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end(`daW3 collab relay: ${rooms.size} room(s)\n`);
});

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  const room = (url.searchParams.get('room') || '').slice(0, 64);
  const id = (url.searchParams.get('id') || '').slice(0, 64);
  const key = req.headers['sec-websocket-key'];
  if (!room || !id || !key) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  if (!rooms.has(room)) rooms.set(room, new Map());
  const peers = rooms.get(room);
  if (peers.size >= MAX_ROOM) { send(sock, { type: 'error', message: 'room is full' }); sock.end(); return; }
  peers.get(id)?.destroy();
  Object.assign(sock, { room, peerId: id });
  send(sock, { type: 'peers', peers: [...peers.keys()] });
  for (const s of peers.values()) send(s, { type: 'join', id });
  peers.set(id, sock);

  let buf = Buffer.alloc(0);
  let parts = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG) { sock.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mask = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3])); }
      buf = buf.subarray(need);
      if (op === 0x8) { sock.end(Buffer.from([0x88, 0])); return; }
      if (op === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0x1 || op === 0x0) {
        parts.push(payload);
        if (fin) { onMessage(sock, Buffer.concat(parts).toString('utf8')); parts = []; }
      }
    }
  });
  sock.on('close', () => leave(sock));
  sock.on('error', () => leave(sock));
});

// keep NAT / proxy connections alive
setInterval(() => { for (const room of rooms.values()) for (const s of room.values()) if (!s.destroyed) s.write(Buffer.from([0x89, 0])); }, 30000).unref();

server.listen(PORT, () => console.log(`daW³ collab relay listening on :${server.address().port}`));
