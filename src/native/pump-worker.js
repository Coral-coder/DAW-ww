// Pump worker: moves audio between the AudioWorklet rings (SharedArrayBuffer) and the native audio
// server (MessagePort), off the UI thread so UI work can't cause dropouts.
//   main thread -> { type:'init', port } | { type:'out', sab } | { type:'in', sab }
//                  | { type:'plugin', inst, toSab, fromSab, numIn, numSc, numOut } | { type:'unplug', inst }
import { RingBuffer, decodePacket, BLOCK } from './ring.js';

let port = null;
let out = null;        // master -> device
let inRing = null;     // device inputs -> recording
const plugins = new Map(); // inst -> { to, from, numIn, numOut, rec, inflight }
let stats = { outFrames: 0, inFrames: 0, procSent: 0, procLate: 0 };

function onServer(e) {
  const m = e.data;
  if (m.t === 'in') {
    if (!inRing || inRing.channels !== m.channels) { self.postMessage({ type: 'in-channels', channels: m.channels }); return; }
    inRing.write(m.data);
    stats.inFrames += m.data.length / m.channels;
  } else if (m.t === 'procd') {
    const p = plugins.get(m.inst);
    if (!p) return;
    p.inflight--;
    if (!m.output) { p.from.write(new Float32Array(BLOCK * p.numOut)); stats.procLate++; return; } // keep the timeline: silence
    const chans = [];
    for (let c = 0; c < p.numOut; c++) chans.push(m.output.subarray(c * BLOCK, (c + 1) * BLOCK));
    p.from.writePlanar(chans, BLOCK);
  }
}

function pump() {
  if (!port) return;
  if (out) {
    const n = out.available();
    if (n > 0) {
      const buf = new Float32Array(n * 2);
      out.read(buf, n);
      port.postMessage({ t: 'out', data: buf }, [buf.buffer]);
      stats.outFrames += n;
    }
  }
  for (const [inst, p] of plugins) {
    while (p.to.available() > 0 && p.inflight < 16) {
      p.to.read(p.rec, 1);
      const pk = decodePacket(p.rec, p.numIn + p.numSc);
      p.inflight++;
      stats.procSent++;
      if (p.numSc) {
        // the packet carries main + sidechain channels: the key goes to the plugin's aux input bus
        const input = pk.audio.slice(0, p.numIn * BLOCK), sidechain = pk.audio.slice(p.numIn * BLOCK);
        port.postMessage({ t: 'proc', inst, block: pk.block, numIn: p.numIn, numOut: p.numOut, input, midi: pk.midi, numSc: p.numSc, sidechain }, [input.buffer, sidechain.buffer, pk.midi.buffer]);
      } else {
        port.postMessage({ t: 'proc', inst, block: pk.block, numIn: p.numIn, numOut: p.numOut, input: pk.audio, midi: pk.midi }, [pk.audio.buffer, pk.midi.buffer]);
      }
    }
  }
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') {
    port = d.port;
    port.onmessage = onServer;
    port.start?.();
    setInterval(pump, 2);
    setInterval(() => self.postMessage({ type: 'stats', stats }), 1000);
  } else if (d.type === 'out') {
    out = d.sab ? new RingBuffer(d.sab) : null;
  } else if (d.type === 'in') {
    inRing = d.sab ? new RingBuffer(d.sab) : null;
  } else if (d.type === 'plugin') {
    const to = new RingBuffer(d.toSab);
    plugins.set(d.inst, { to, from: new RingBuffer(d.fromSab), numIn: d.numIn, numSc: d.numSc || 0, numOut: d.numOut, rec: new Float32Array(to.channels), inflight: 0 });
  } else if (d.type === 'unplug') {
    plugins.delete(d.inst);
  }
};
