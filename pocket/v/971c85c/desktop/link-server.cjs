// Ableton Link for daW³ over a local WebSocket (the protocol of tools/link-bridge, see its README):
//   bridge -> client  { type:'state', tempo, beat, phase, quantum, playing, peers, link, time }  20×/s + on change
//   client -> bridge  { type:'tempo', bpm } | { type:'play' } | { type:'stop' } | { type:'quantum', value }
// Link sessions:
//   processLink(binary)  the daw3-link process (desktop/native/src/link — the Ableton Link SDK, GPL-2.0-or-later,
//                        kept in its own process) — what the Mac app uses, so Link works out of the box
//   simulatedLink()      no Link: a shared clock (tests, and several browser tabs on one machine)
// The Mac app's main process starts it on demand (desktop/native-bridge.cjs); tools/link-bridge/link-bridge.mjs
// is the same server for the browser version. No Electron imports (Node tests drive it).
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const LINK_PORT = 20809;
const mod = (x, q) => ((x % q) + q) % q;

function simulatedLink() {
  let tempo = 120, quantum = 4, playing = false, t0 = Date.now(), b0 = 0;
  const beatNow = () => b0 + ((Date.now() - t0) / 60000) * tempo;
  return {
    real: false,
    get tempo() { return tempo; },
    set tempo(v) { b0 = beatNow(); t0 = Date.now(); tempo = v; },
    get quantum() { return quantum; }, set quantum(v) { quantum = v; },
    get beat() { return beatNow(); },
    get phase() { return mod(beatNow(), quantum); },
    get playing() { return playing; },
    play() { playing = true; }, stop() { playing = false; },
    get peers() { return 0; },
    close() {},
  };
}

/**
 * The daw3-link process as a Link session. opts.onState(state) fires on every state line it prints;
 * `ready` resolves once it runs (rejects when it can't start). The beat / phase between two state lines are
 * extrapolated from the last one (Link's timeline runs at the session tempo).
 */
function processLink(binary, { onState, onExit } = {}) {
  let last = { tempo: 120, beat: 0, phase: 0, quantum: 4, playing: false, peers: 0, time: Date.now() };
  let alive = false;
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  const send = (m) => { if (alive) child.stdin.write(JSON.stringify(m) + '\n'); };
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The Link process did not start')), 10000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'ready') { alive = true; clearTimeout(t); resolve(); return; }
      if (m.type === 'state') { last = m; onState?.(m); }
    });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('exit', (code, signal) => { alive = false; clearTimeout(t); reject(new Error(`The Link process exited (${signal || code})`)); onExit?.(code, signal); });
  });
  ready.catch(() => {}); // callers that never await it must not see an unhandled rejection
  const beatNow = () => last.beat + ((Date.now() - last.time) / 60000) * last.tempo;
  return {
    real: true,
    ready,
    get alive() { return alive; },
    get tempo() { return last.tempo; },
    set tempo(v) { send({ type: 'tempo', bpm: v }); },
    get quantum() { return last.quantum; },
    set quantum(v) { send({ type: 'quantum', value: v }); },
    get beat() { return beatNow(); },
    get phase() { return mod(last.phase + (beatNow() - last.beat), last.quantum || 4); },
    get playing() { return !!last.playing; },
    play() { send({ type: 'play' }); }, stop() { send({ type: 'stop' }); },
    get peers() { return last.peers || 0; },
    close() { try { child.stdin.end(); } catch { /* */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 1000).unref?.(); },
    pid: child.pid,
  };
}

// ------------------------------------------------------------------------------------- minimal WebSocket server
function frame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
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
    const maskOff = off;
    if (masked) off += 4;
    if (b.length < off + len) break;
    const data = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) data[i] ^= b[maskOff + (i & 3)];
    sock.buf = b.subarray(off + len);
    out.push({ op, data });
  }
  return out;
}

/**
 * Serve a Link session on ws://host:port. opts: { link, port, host, origins: ['https://…', 'app://daw3', '*'],
 * fallbackPort: true (take a free port when `port` is busy), log } -> Promise<{ url, port, broadcast(), close() }>.
 */
function startLinkServer({ link, port = LINK_PORT, host = '127.0.0.1', origins = [], fallbackPort = false, log = () => {} } = {}) {
  const clients = new Set();
  const originOk = (o) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) || origins.includes(o) || origins.includes('*');
  const state = () => ({ type: 'state', tempo: +(+link.tempo).toFixed(3), beat: link.beat, phase: link.phase, quantum: link.quantum, playing: !!link.playing,
    peers: link.peers, link: !!link.real, time: Date.now() });
  const broadcast = () => { const f = frame(JSON.stringify(state())); for (const c of clients) c.write(f); };
  const command = (m) => {
    if (m.type === 'tempo' && m.bpm >= 20 && m.bpm <= 999) link.tempo = +m.bpm;
    else if (m.type === 'play') link.play();
    else if (m.type === 'stop') link.stop();
    else if (m.type === 'quantum' && m.value >= 1 && m.value <= 16) link.quantum = +m.value;
    // the process link answers with its new state line (broadcast then); the simulated one changes at once
    if (!link.real) broadcast();
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(`daW³ Link bridge (${link.real ? 'Link' : 'simulated'}) — connect with WebSocket\n`);
  });
  server.on('upgrade', (req, sock) => {
    if (!originOk(req.headers.origin)) { log(`rejected origin ${req.headers.origin}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
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
        if (f.op === 1) { try { command(JSON.parse(f.data.toString('utf8'))); } catch (e) { log(`bad message: ${e.message}`); } }
      }
    });
    const drop = () => clients.delete(sock);
    sock.on('close', drop);
    sock.on('error', drop);
  });
  const timer = setInterval(broadcast, 50);
  timer.unref?.();
  return new Promise((resolve, reject) => {
    const listen = (p) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && fallbackPort && p !== 0) { log(`port ${p} busy, using a free one`); listen(0); } else { clearInterval(timer); reject(e); }
      });
      server.listen(p, host, () => {
        const actual = server.address().port;
        resolve({
          port: actual,
          url: `ws://${host}:${actual}`,
          broadcast,
          clients,
          close() { clearInterval(timer); for (const c of clients) { try { c.destroy(); } catch { /* */ } } server.close(); link.close?.(); },
        });
      });
    };
    listen(port);
  });
}

module.exports = { LINK_PORT, simulatedLink, processLink, startLinkServer, frame, parseFrames };
