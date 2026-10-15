// AudioWorklet processor of the rhythm effects (loaded with audioWorklet.addModule — realtime and offline).
// One processor, four kinds (processorOptions.kind): 'trancegate' | 'volshaper' | 'beatrepeat' | 'timeshaper'.
//
// Timing: a BeatClock of piecewise-linear segments (frame -> song beat) sent by the builder (fx/builders/rhythm.js)
// whenever the transport starts, seeks, loops or the tempo changes; every sample's effect state is a pure function
// of its beat (fx/rhythm-dsp.js), so the output is sample-accurate and identical live and in exports.
// Messages: {type:'cfg', cfg, ringSec?} {type:'clock', segs:[{f,beat,bpf}]} {type:'free', f, bpm}
//           {type:'hold', start|null, end|null} {type:'trigger', at} {type:'dispose'}
//           {type:'ping', id} -> replies {type:'pong', id} (flush: everything posted before has arrived)
// No look-ahead: repeats and time effects only read the past, so the effect adds no latency.
import {
  BeatClock, gateEnvAt, gateGain, shaperValueAt, repeatAt, repeatSlice, sliceEnv,
  timeWindowAt, manualWindowAt, timeRead, speedExp, tapeAmp,
} from './rhythm-dsp.js';

const FADE_SEC = 0.002;

/** Stereo ring buffer of the recent input; read(ch, d) = the sample d frames before the newest one. */
class Ring {
  constructor(frames) { this.alloc(frames); }
  alloc(frames) {
    this.len = Math.max(1024, frames | 0);
    this.ch = [new Float32Array(this.len), new Float32Array(this.len)];
    this.w = 0;
  }
  write(l, r) { this.ch[0][this.w] = l; this.ch[1][this.w] = r; this.w = this.w + 1 === this.len ? 0 : this.w + 1; }
  read(c, d) {
    const buf = this.ch[c];
    const n = this.len;
    if (d < 0) d = 0;
    if (d > n - 4) d = n - 4;
    let pos = this.w - 1 - d;
    if (pos < 0) pos += n;
    const i = Math.floor(pos);
    const fr = pos - i;
    const i0 = i % n, i1 = (i + 1) % n;
    const x0 = buf[i0], x1 = buf[i1];
    if (d < 2) return x0 + (x1 - x0) * fr; // (no future samples for the cubic)
    const xm = buf[i0 === 0 ? n - 1 : i0 - 1], x2 = buf[(i + 2) % n];
    // Catmull-Rom / cubic Hermite
    const c1 = 0.5 * (x1 - xm);
    const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * fr + c2) * fr + c1) * fr + x0;
  }
}

/** Topology-preserving state-variable low-pass (one per channel). */
class Svf {
  constructor() { this.s1 = 0; this.s2 = 0; }
  run(x, g, k) {
    const a1 = 1 / (1 + g * (g + k));
    const v3 = x - this.s2;
    const v1 = a1 * this.s1 + g * a1 * v3;
    const v2 = this.s2 + g * v1;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    return v2;
  }
}

const ZERO = new Float32Array(128);

class RhythmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.kind = o.kind;
    this.cfg = o.cfg || null;
    this.clock = new BeatClock(o.bpm || 120, sampleRate);
    if (o.segs?.length) this.clock.set(o.segs);
    this.ring = this.kind === 'beatrepeat' || this.kind === 'timeshaper' ? new Ring(sampleRate * (o.ringSec || 6)) : null;
    this.hold = null; // {start, end}
    this.manualAt = null;
    this.depth = this.cfg?.depth ?? 1;
    this.g = [1, 1];
    this.svf = [new Svf(), new Svf()];
    this.dead = false;
    this.st = {}; // reused result objects (no allocation per sample)
    this.rd = {};
    this.win = {};
    this.port.onmessage = (e) => this.onMessage(e.data || {});
  }

  onMessage(m) {
    switch (m.type) {
      case 'cfg':
        this.cfg = m.cfg;
        if (this.ring && m.ringSec && m.ringSec * sampleRate > this.ring.len) this.ring.alloc(m.ringSec * sampleRate);
        break;
      case 'clock': this.clock.set(m.segs); break;
      case 'free': this.clock.free(m.f, m.bpm); break;
      case 'hold': this.hold = m.start == null ? null : { start: m.start, end: m.end ?? Infinity }; break;
      case 'trigger': this.manualAt = m.at; break;
      case 'dispose': this.dead = true; break;
      case 'ping': this.port.postMessage({ type: 'pong', id: m.id }); break;
      default:
    }
  }

  process(inputs, outputs) {
    if (this.dead) return false;
    const out = outputs[0];
    if (!out || !out.length) return true;
    const inp = inputs[0] || [];
    const n = out[0].length;
    const inL = inp[0] || (n === 128 ? ZERO : new Float32Array(n));
    const inR = inp[1] || inL;
    const oL = out[0];
    const oR = out[1] || out[0];
    const f0 = currentFrame;
    this.clock.prune(f0);
    const c = this.cfg;
    if (!c) { oL.set(inL); if (oR !== oL) oR.set(inR); return true; }
    switch (this.kind) {
      case 'trancegate': this.gate(c, inL, inR, oL, oR, f0, n); break;
      case 'volshaper': this.shaper(c, inL, inR, oL, oR, f0, n); break;
      case 'beatrepeat': this.repeat(c, inL, inR, oL, oR, f0, n); break;
      case 'timeshaper': this.time(c, inL, inR, oL, oR, f0, n); break;
      default: oL.set(inL); if (oR !== oL) oR.set(inR);
    }
    return true;
  }

  gate(c, inL, inR, oL, oR, f0, n) {
    const clock = this.clock;
    const sameR = c.R === c.L || c.stereoSame;
    const dk = 1 - Math.exp(-1 / (0.01 * sampleRate)); // depth automation smoothing
    for (let i = 0; i < n; i++) {
      const f = f0 + i;
      const b = clock.beatAt(f);
      const bps = clock.bpfAt(f) * sampleRate;
      this.depth += (c.depth - this.depth) * dk;
      const eL = gateEnvAt(b, c.L, c, bps);
      const eR = sameR ? eL : gateEnvAt(b, c.R, c, bps);
      oL[i] = inL[i] * gateGain(eL, this.depth);
      if (oR !== oL) oR[i] = inR[i] * gateGain(eR, this.depth);
    }
  }

  shaper(c, inL, inR, oL, oR, f0, n) {
    const clock = this.clock;
    const a = c.smooth > 0 ? Math.exp(-1 / (c.smooth * sampleRate)) : 0;
    const vol = c.target !== 'filter';
    const filt = c.target === 'filter' || c.target === 'both';
    const k = 1 / c.resonance;
    const ratio = c.cutMax / c.cutMin;
    let g = this.g[0];
    let fg = this.g[1];
    let coef = 0;
    for (let i = 0; i < n; i++) {
      const v = shaperValueAt(clock.beatAt(f0 + i), c);
      g = a * g + (1 - a) * v;
      let l = inL[i], r = inR[i];
      if (filt) {
        if ((i & 7) === 0 || i === 0) {
          fg = g;
          const fc = Math.min(sampleRate * 0.45, c.cutMin * Math.pow(ratio, fg));
          coef = Math.tan((Math.PI * fc) / sampleRate);
        }
        l = this.svf[0].run(l, coef, k);
        r = this.svf[1].run(r, coef, k);
      }
      const gain = vol ? g : 1;
      oL[i] = l * gain;
      if (oR !== oL) oR[i] = r * gain;
    }
    this.g[0] = g;
    this.g[1] = fg;
  }

  repeat(c, inL, inR, oL, oR, f0, n) {
    const clock = this.clock;
    const ring = this.ring;
    const two = oR !== oL;
    for (let i = 0; i < n; i++) {
      const f = f0 + i;
      const l = inL[i], r = inR[i];
      ring.write(l, r);
      const b = clock.beatAt(f);
      const bpf = clock.bpfAt(f);
      const fpb = bpf > 0 ? 1 / bpf : sampleRate;
      const fadeB = FADE_SEC * sampleRate * bpf;
      let st = null;
      const h = this.hold;
      if (h && b >= h.start && b < h.end) { st = repeatSlice(b, h.start, c.grid, c, this.st); st.end = h.end; } else if (c.chance > 0) st = repeatAt(b, c, this.st);
      if (!st) {
        oL[i] = c.mode === 'gate' ? 0 : l;
        if (two) oR[i] = c.mode === 'gate' ? 0 : r;
        continue;
      }
      const e = sliceEnv(st.pos, c.grid, fadeB, st.n) * st.gain;
      const a = Math.max(0, Math.min(1, (st.end - b) / fadeB));
      const d = st.delay * fpb;
      const wl = ring.read(0, d) * e, wr = ring.read(1, d) * e;
      if (c.mode === 'mix') {
        const w = st.n > 0 ? a : 0;
        oL[i] = l + wl * w;
        if (two) oR[i] = r + wr * w;
      } else if (c.mode === 'gate') {
        oL[i] = wl * a;
        if (two) oR[i] = wr * a;
      } else {
        oL[i] = l * (1 - a) + wl * a;
        if (two) oR[i] = r * (1 - a) + wr * a;
      }
    }
  }

  time(c, inL, inR, oL, oR, f0, n) {
    const clock = this.clock;
    const ring = this.ring;
    const two = oR !== oL;
    const fadeF = FADE_SEC * sampleRate;
    const p = speedExp(c.curve);
    for (let i = 0; i < n; i++) {
      const f = f0 + i;
      const l = inL[i], r = inR[i];
      ring.write(l, r);
      const b = clock.beatAt(f);
      const win = c.trigger === 'manual' ? manualWindowAt(b, this.manualAt, c, this.win) : timeWindowAt(b, c, this.win);
      if (!win) { oL[i] = l; if (two) oR[i] = r; continue; }
      const bpf = clock.bpfAt(f);
      const lenF = win.len / (bpf > 0 ? bpf : 1 / sampleRate);
      const eF = win.u * lenF;
      const rd = timeRead(win.mode, win.u, lenF, p, this.rd);
      const amp = win.mode === 'tapestop' || win.mode === 'tapestart' ? tapeAmp(rd.rate) : 1;
      const a = Math.max(0, Math.min(1, eF / fadeF, (lenF - eF) / fadeF));
      const wl = ring.read(0, rd.delay) * amp, wr = ring.read(1, rd.delay) * amp;
      oL[i] = l * (1 - a) + wl * a;
      if (two) oR[i] = r * (1 - a) + wr * a;
    }
  }
}

registerProcessor('daw3-rhythm', RhythmProcessor);
