// AudioWorklet processors of the native audio bridge (loaded with audioWorklet.addModule).
//   daw3-native-out     daW³'s master output -> SharedArrayBuffer ring -> (pump worker) -> native device
//   daw3-native-in      native device inputs -> ring -> Web Audio (an input stream for recording)
//   daw3-native-plugin  a track's audio + MIDI -> packet ring -> native plugin (out of process) -> ring -> Web Audio,
//                       at a fixed, reported latency
//   daw3-capture        records its input into a ring (realtime bounce / export)
import { RingBuffer, encodePacket, packetSize, BLOCK } from './ring.js';

class NativeOut extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ring = new RingBuffer(opts.processorOptions.sab);
    this.silent = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  }
  process(inputs) {
    const inp = inputs[0];
    this.ring.writePlanar(inp && inp.length ? inp : this.silent, BLOCK);
    return true;
  }
}

class NativeIn extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ring = null;
    this.prefill = opts.processorOptions.prefill || 512;
    this.primed = false;
    this.select = opts.processorOptions.channels || null; // device channel indices to output
    this.tmp = null;
    this.port.onmessage = (e) => { if (e.data?.sab) { this.ring = new RingBuffer(e.data.sab); this.primed = false; this.tmp = null; } };
    if (opts.processorOptions.sab) this.ring = new RingBuffer(opts.processorOptions.sab);
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const r = this.ring;
    if (!r) return true;
    if (!this.primed) { if (r.available() < this.prefill) return true; this.primed = true; }
    if (r.available() < BLOCK) { r.noteUnderrun(); this.primed = false; return true; }
    const ch = r.channels;
    if (!this.tmp || this.tmp.length !== ch) this.tmp = Array.from({ length: ch }, () => new Float32Array(BLOCK));
    r.readPlanar(this.tmp, BLOCK);
    for (let c = 0; c < out.length; c++) {
      const src = this.select ? this.select[c] : c;
      if (src != null && src < ch) out[c].set(this.tmp[src]);
    }
    // keep the bridge latency bounded when the renderer fell behind
    if (r.available() > this.prefill * 4) r.read(null, r.available() - this.prefill);
    return true;
  }
}

class NativePlugin extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.numIn = o.numIn;
    this.numOut = o.numOut;
    this.to = new RingBuffer(o.toSab);
    this.from = new RingBuffer(o.fromSab);
    this.latencyBlocks = o.latencyBlocks || 3;
    this.rec = new Float32Array(packetSize(this.numIn));
    this.block = 0;
    this.debt = 0;
    this.events = []; // [time(s), status, d1, d2] sorted
    this.silentIn = Array.from({ length: Math.max(1, this.numIn) }, () => new Float32Array(BLOCK));
    this.bypass = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'midi') {
        for (const ev of d.events) this.events.push(ev);
        this.events.sort((a, b) => a[0] - b[0]);
      } else if (d.type === 'clear') {
        this.events.length = 0;
      } else if (d.type === 'bypass') {
        this.bypass = !!d.on;
      }
    };
  }
  process(inputs, outputs) {
    const t0 = currentTime, t1 = currentTime + BLOCK / sampleRate;
    const evs = [];
    while (this.events.length && this.events[0][0] < t1) {
      const e = this.events.shift();
      evs.push([Math.max(0, Math.min(BLOCK - 1, Math.round((e[0] - t0) * sampleRate))), e[1], e[2], e[3]]);
    }
    const inp = inputs[0] && inputs[0].length ? inputs[0] : this.silentIn;
    encodePacket(this.rec, this.block & 0xffffff, inp, this.numIn, evs);
    this.to.write(this.rec, 1);
    this.block++;
    const out = outputs[0];
    if (this.block <= this.latencyBlocks) return true;
    if (this.debt > 0 && this.from.available() >= BLOCK * 2) { this.from.read(null, BLOCK); this.debt--; }
    if (this.from.available() >= BLOCK) {
      this.from.readPlanar(out, BLOCK);
      if (this.bypass) for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, inp.length - 1)] || this.silentIn[0]);
    } else {
      this.from.noteUnderrun();
      this.debt++; // the late block is dropped when it arrives: the latency stays fixed
    }
    return true;
  }
}

class Capture extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ring = new RingBuffer(opts.processorOptions.sab);
    this.silent = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  }
  process(inputs) {
    if (!this.started) { this.started = true; this.ring.flag = currentFrame; } // context frame of ring index 0
    const inp = inputs[0];
    this.ring.writePlanar(inp && inp.length ? inp : this.silent, BLOCK);
    return true;
  }
}

registerProcessor('daw3-native-out', NativeOut);
registerProcessor('daw3-native-in', NativeIn);
registerProcessor('daw3-native-plugin', NativePlugin);
registerProcessor('daw3-capture', Capture);
