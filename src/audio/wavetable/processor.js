// AudioWorklet processor of the wavetable synth ('daw3-wavetable'). One node per instrument: it owns voice
// allocation (poly / mono / legato, glide), 2 morphing wavetable oscillators with warp + unison, sub, noise,
// a per-voice filter (SVF 12/24 dB LP/BP/HP/notch, comb), 3 envelopes, 4 LFOs and an 8-slot mod matrix.
// Band-limited playback: each table arrives as mipmaps (one level per octave, tables.js buildMipmaps); a voice reads
// the richest level whose top harmonic stays below Nyquist for its (warped, detuned) frequency.
//
// Messages in:  {type:'params', p} (partial), {type:'table', osc, mips}, {type:'events', list:[...]}, {type:'ping', id}
//   events: {t (context seconds), type:'on', id, pitch, vel, glideFrom?} | {t, type:'off', id} | {t, type:'allOff'}
//           | {t, type:'bend', semis} | {t, type:'expr', id, bend}
// Messages out: {type:'pong', id}, {type:'state', voices, pos:[a, b]} (~every 40 ms while sounding)
import { WARP_IDS, warpPhase, warpGain, warpBandwidth } from './warp.js';
import { Env, Svf, Comb, svfK, lfoValue, unisonLayout, panGains } from './voice-dsp.js';

const SR = typeof sampleRate === 'number' ? sampleRate : 48000; // eslint-disable-line no-undef
const SUB = 16; // control-rate block (samples)
const MAX_UNI = 16;
const POOL = 40;
const VOICE_SCALE = 0.5;
const MIP_H = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];

const SRC = ['off', 'env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'lfo4', 'vel', 'note', 'rand'];
const DST = ['none', 'pos1', 'pos2', 'warp1', 'warp2', 'pitch', 'pitch1', 'pitch2', 'level1', 'level2', 'cutoff', 'res', 'drive', 'pan', 'amp', 'sub', 'noise', 'detune1', 'detune2'];
const LFO_SHAPE_IDS = { sine: 0, triangle: 1, saw: 2, ramp: 3, square: 4, random: 5, smooth: 6 };
const FILTER_IDS = { lp: 0, bp: 1, hp: 2, notch: 3, comb: 4, combneg: 5, off: 6 };
const SUB_IDS = { sine: 0, triangle: 1, square: 2, saw: 3 };
const NOISE_IDS = { white: 0, pink: 1, brown: 2 };

const n0 = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function divBeats(div) {
  const m = /^(\d+)\/(\d+)([td]?)$/.exec(String(div || '1/4'));
  if (!m) return 1;
  let b = (4 * Number(m[1])) / Math.max(1, Number(m[2]));
  if (m[3] === 't') b *= 2 / 3;
  if (m[3] === 'd') b *= 1.5;
  return b;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compile a param object into the numbers the audio loop uses. */
function compile(p) {
  const osc = [1, 2].map((i) => {
    const uni = Math.round(clamp(n0(p[`osc${i}Unison`], 1), 1, MAX_UNI));
    return {
      on: p[`osc${i}On`] !== false && n0(p[`osc${i}Level`], 0.8) > 0.0005 && (i === 1 || p[`osc${i}On`] === true),
      pos: clamp(n0(p[`osc${i}Pos`], 0), 0, 1),
      warp: WARP_IDS[p[`osc${i}Warp`]] ?? 0,
      warpAmt: clamp(n0(p[`osc${i}WarpAmt`], 0), 0, 1),
      level: clamp(n0(p[`osc${i}Level`], 0.8), 0, 1),
      uni,
      detune: clamp(n0(p[`osc${i}Detune`], 0.2), 0, 1),
      layout: unisonLayout(uni, clamp(n0(p[`osc${i}Blend`], 0.75), 0, 1), clamp(n0(p[`osc${i}Spread`], 0.7), 0, 1)),
      semis: n0(p[`osc${i}Octave`], 0) * 12 + n0(p[`osc${i}Semi`], 0) + n0(p[`osc${i}Fine`], 0) / 100,
      pan: clamp(n0(p[`osc${i}Pan`], 0), -1, 1),
      phase: clamp(n0(p[`osc${i}Phase`], 0), 0, 1),
      rand: clamp(n0(p[`osc${i}Rand`], 1), 0, 1),
    };
  });
  const mods = [];
  for (let s = 1; s <= 8; s++) {
    const src = SRC.indexOf(p[`mod${s}Src`]), dst = DST.indexOf(p[`mod${s}Dst`]), amt = n0(p[`mod${s}Amt`], 0);
    if (src > 0 && dst > 0 && amt !== 0) mods.push([src, dst, clamp(amt, -1, 1)]);
  }
  const lfos = [1, 2, 3, 4].map((k) => ({
    shape: LFO_SHAPE_IDS[p[`lfo${k}Shape`]] ?? 0,
    rate: clamp(n0(p[`lfo${k}Rate`], 1), 0.001, 100),
    sync: !!p[`lfo${k}Sync`],
    beats: divBeats(p[`lfo${k}Div`]),
    retrig: !!p[`lfo${k}Retrig`],
    fade: clamp(n0(p[`lfo${k}Fade`], 0), 0, 10),
  }));
  const used = new Set(mods.map((m) => m[0]));
  const env = (k, d) => [n0(p[`env${k}Attack`], d[0]), n0(p[`env${k}Decay`], d[1]), n0(p[`env${k}Sustain`], d[2]), n0(p[`env${k}Release`], d[3])];
  return {
    osc, mods, lfos, usedSrc: used,
    subLevel: clamp(n0(p.subLevel, 0), 0, 1), subWave: SUB_IDS[p.subWave] ?? 0, subOct: clamp(Math.round(n0(p.subOctave, -1)), -2, 0),
    noiseLevel: clamp(n0(p.noiseLevel, 0), 0, 1), noiseType: NOISE_IDS[p.noiseType] ?? 0,
    filter: FILTER_IDS[p.filterType] ?? 0, slope24: String(p.filterSlope ?? '24') === '24',
    cutoff: clamp(n0(p.cutoff, 12000), 20, 20000), res: clamp(n0(p.resonance, 0.1), 0, 1), drive: clamp(n0(p.filterDrive, 0), 0, 1),
    fEnv: clamp(n0(p.fEnvAmount, 0), -8, 8), keytrack: clamp(n0(p.keytrack, 0.3), 0, 1), velToFilter: clamp(n0(p.velToFilter, 0.2), 0, 1),
    env1: env(1, [0.005, 0.4, 0.8, 0.25]), env2: env(2, [0.005, 0.4, 0.2, 0.3]), env3: env(3, [0.3, 1, 0, 0.6]),
    velToAmp: clamp(n0(p.velToAmp, 0.6), 0, 1),
    mode: p.voiceMode === 'mono' ? 1 : p.voiceMode === 'legato' ? 2 : 0,
    poly: Math.round(clamp(n0(p.polyphony, 8), 1, 32)),
    glide: clamp(n0(p.glide, 0), 0, 5), glideAlways: !!p.glideAlways,
    transpose: n0(p.transpose, 0),
    bpm: clamp(n0(p.bpm, 120), 20, 400),
  };
}

class Voice {
  constructor(seed) {
    this.active = false; this.id = -1; this.age = 0;
    this.pitch = 60; this.target = 60; this.vel = 0.8; this.note = 60;
    this.envs = [new Env(), new Env(), new Env()];
    this.lfoPh = new Float64Array(4); this.lfoHold = new Float64Array(4); this.lfoPrev = new Float64Array(4); this.lfoT = 0;
    this.ph = [new Float64Array(MAX_UNI), new Float64Array(MAX_UNI)];
    this.pos = [0, 0]; this.warpA = [0, 0]; this.lvl = [0, 0];
    this.subPh = 0;
    this.f = [[new Svf(), new Svf()], [new Svf(), new Svf()]]; // [channel][stage]
    this.comb = [new Comb(Math.ceil(SR / 20) + 4), new Comb(Math.ceil(SR / 20) + 4)];
    this.rand = rng(seed);
    this.rnd = 0; this.kill = 0; this.killStep = 0; this.bend = 0;
    this.pink = new Float64Array(7); this.brown = 0;
    this.lastA = 0; this.lastB = 0;
    this.cut = 1000; this.resS = 0.1; this.drv = 0; this.panS = 0; this.ampM = 1; this.subS = 0; this.noiseS = 0;
    this.fresh = true;
  }
}

class WavetableProcessor extends AudioWorkletProcessor { // eslint-disable-line no-undef
  constructor() {
    super();
    this.p = {};
    this.cfg = compile({});
    this.tables = [null, null];
    this.voices = Array.from({ length: POOL }, (_, i) => new Voice(0x9e3779b1 + i * 7919));
    this.events = [];
    this.stack = []; // held notes (mono / legato): [{id, pitch, vel}]
    this.bend = 0; this.bendT = 0;
    this.lastPitch = null;
    this.clock = 0;
    this.lfoGlobal = new Float64Array(4);
    this.stateIn = 0;
    this.port.onmessage = (e) => this._msg(e.data);
  }

  _msg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'params') { Object.assign(this.p, m.p); this.cfg = compile(this.p); }
    else if (m.type === 'table') { this.tables[m.osc] = m.mips || null; }
    else if (m.type === 'events') { for (const ev of m.list || []) this._queue(ev); }
    else if (m.type === 'ping') this.port.postMessage({ type: 'pong', id: m.id });
  }

  _queue(ev) {
    ev.frame = Math.round(n0(ev.t, 0) * SR);
    const q = this.events;
    let i = q.length;
    while (i > 0 && q[i - 1].frame > ev.frame) i--;
    q.splice(i, 0, ev);
  }

  // ---------------------------------------------------------------- voice management
  _free() {
    let best = null;
    for (const v of this.voices) if (!v.active) return v;
    // all busy: the most faded stealing victim, else the oldest voice
    for (const v of this.voices) {
      if (!best) { best = v; continue; }
      const bk = best.kill ? best.kill : 2, vk = v.kill ? v.kill : 2;
      if (vk < bk || (vk === bk && v.age < best.age)) best = v;
    }
    return best;
  }

  _activeCount() { let n = 0; for (const v of this.voices) if (v.active && !v.kill) n++; return n; }

  _steal(limit) {
    // keep at most `limit` sounding (non-fading) voices: fade out the oldest (released first)
    let live = this.voices.filter((v) => v.active && !v.kill);
    while (live.length >= limit) {
      live.sort((a, b) => (b.envs[0].stage === 4) - (a.envs[0].stage === 4) || a.age - b.age);
      this._fade(live[0]);
      live = live.slice(1);
    }
  }

  _fade(v) { if (v.active && !v.kill) { v.kill = 1; v.killStep = 1 / (0.006 * SR); } }

  _startVoice(v, ev, glideFrom) {
    const c = this.cfg;
    v.active = true; v.kill = 0; v.id = ev.id; v.age = this.clock;
    v.note = ev.pitch; v.vel = clamp(n0(ev.vel, 0.8), 0, 1);
    v.target = ev.pitch;
    v.pitch = glideFrom != null ? glideFrom : ev.pitch;
    v.rnd = v.rand() * 2 - 1;
    v.bend = 0;
    v.glideT = n0(ev.glideTime, 0.06);
    for (let k = 0; k < 3; k++) { const e = c[`env${k + 1}`]; v.envs[k].set(e[0], e[1], e[2], e[3], SR); v.envs[k].level = 0; v.envs[k].gate(true, true); }
    for (let k = 0; k < 4; k++) {
      const L = c.lfos[k];
      v.lfoPh[k] = L.retrig ? 0 : this.lfoGlobal[k];
      v.lfoHold[k] = v.rand() * 2 - 1; v.lfoPrev[k] = v.lfoHold[k];
    }
    v.lfoT = 0;
    for (let o = 0; o < 2; o++) {
      const oc = c.osc[o];
      for (let u = 0; u < MAX_UNI; u++) v.ph[o][u] = (oc.phase + v.rand() * oc.rand) % 1;
      v.pos[o] = oc.pos; v.warpA[o] = oc.warpAmt; v.lvl[o] = oc.level;
    }
    v.subPh = 0;
    for (const ch of v.f) for (const s of ch) s.reset();
    v.comb[0].reset(); v.comb[1].reset();
    v.fresh = true;
  }

  _noteOn(ev) {
    const c = this.cfg;
    this.clock++;
    if (c.mode === 0) {
      this._steal(c.poly);
      const v = this._free();
      if (v.active) { v.active = false; }
      const glideFrom = ev.glideFrom != null ? ev.glideFrom : (c.glide > 0 && c.glideAlways && this.lastPitch != null ? this.lastPitch : null);
      this._startVoice(v, ev, glideFrom);
      this.lastPitch = ev.pitch;
      return;
    }
    // mono / legato: one voice follows the note stack
    const held = this.stack.length > 0;
    this.stack = this.stack.filter((n) => n.id !== ev.id);
    this.stack.push({ id: ev.id, pitch: ev.pitch, vel: ev.vel });
    const v = this.voices.find((x) => x.active && !x.kill && x.mono);
    if (!v) {
      for (const x of this.voices) if (x.active && !x.kill) this._fade(x);
      const nv = this._free();
      const glideFrom = ev.glideFrom != null ? ev.glideFrom : (c.glide > 0 && c.glideAlways && this.lastPitch != null ? this.lastPitch : null);
      this._startVoice(nv, ev, glideFrom);
      nv.mono = true;
      this.lastPitch = ev.pitch;
      return;
    }
    v.id = ev.id; v.target = ev.pitch; v.note = ev.pitch; v.age = this.clock;
    const glideNow = c.glide > 0 && (held || c.glideAlways);
    if (ev.glideFrom != null) { v.pitch = ev.glideFrom; v.glideT = n0(ev.glideTime, 0.06); } else if (!glideNow) v.pitch = ev.pitch;
    const retrig = c.mode === 1 || !held;
    if (retrig) { v.vel = clamp(n0(ev.vel, 0.8), 0, 1); for (const e of v.envs) e.gate(true, true); }
    else for (const e of v.envs) if (e.stage === 4) e.gate(true, true);
    this.lastPitch = ev.pitch;
  }

  _noteOff(ev) {
    const c = this.cfg;
    if (c.mode !== 0) {
      const top = this.stack[this.stack.length - 1];
      this.stack = this.stack.filter((n) => n.id !== ev.id);
      const v = this.voices.find((x) => x.active && !x.kill && x.mono);
      if (!v) return;
      if (top && top.id === ev.id && this.stack.length) {
        const nx = this.stack[this.stack.length - 1];
        v.id = nx.id; v.target = nx.pitch; v.note = nx.pitch;
        if (!(c.glide > 0)) v.pitch = nx.pitch;
        return;
      }
      if (!this.stack.length) for (const e of v.envs) e.gate(false);
      return;
    }
    for (const v of this.voices) if (v.active && v.id === ev.id) for (const e of v.envs) e.gate(false);
  }

  _event(ev) {
    switch (ev.type) {
      case 'on': this._noteOn(ev); break;
      case 'off': this._noteOff(ev); break;
      case 'allOff': this.stack = []; for (const v of this.voices) this._fade(v); break;
      case 'bend': this.bendT = n0(ev.semis, 0); break;
      case 'expr': for (const v of this.voices) if (v.active && v.id === ev.id) v.bend = n0(ev.bend, 0); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- audio
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    L.fill(0); if (R !== L) R.fill(0);
    const frame0 = typeof currentFrame === 'number' ? currentFrame : 0; // eslint-disable-line no-undef
    let i = 0;
    while (i < n) {
      while (this.events.length && this.events[0].frame <= frame0 + i) this._event(this.events.shift());
      let end = Math.min(n, i + SUB);
      if (this.events.length) { const nx = this.events[0].frame - frame0; if (nx > i && nx < end) end = nx; }
      this._render(L, R, i, end - i);
      i = end;
    }
    // advance free-running LFO phases (new notes pick them up unless they retrigger)
    for (let k = 0; k < 4; k++) this.lfoGlobal[k] = (this.lfoGlobal[k] + (this._lfoHz(k) * n) / SR) % 1;
    this.stateIn += n;
    if (this.stateIn >= 2048) {
      this.stateIn = 0;
      let cnt = 0, last = null;
      for (const v of this.voices) if (v.active) { cnt++; if (!last || v.age > last.age) last = v; }
      if (cnt || this._wasActive) this.port.postMessage({ type: 'state', voices: cnt, pos: last ? [last.pos[0], last.pos[1]] : null });
      this._wasActive = cnt > 0;
    }
    return true;
  }

  _lfoHz(k) {
    const L = this.cfg.lfos[k];
    return L.sync ? (this.cfg.bpm / 60) / L.beats : L.rate;
  }

  _render(L, R, off, len) {
    const c = this.cfg;
    this.bend += (this.bendT - this.bend) * Math.min(1, len / (0.005 * SR));
    for (const v of this.voices) if (v.active) this._voice(v, c, L, R, off, len);
  }

  _voice(v, c, outL, outR, off, len) {
    // ---- control: envelopes 2/3 (at block rate), LFOs, matrix
    for (let k = 0; k < 3; k++) { const e = c[`env${k + 1}`]; v.envs[k].set(e[0], e[1], e[2], e[3], SR); }
    const e2 = v.envs[1], e3 = v.envs[2];
    const env2 = e2.run(len), env3 = e3.run(len);
    const src = this._src || (this._src = new Float64Array(SRC.length));
    src[1] = v.envs[0].level; src[2] = env2; src[3] = env3;
    v.lfoT += len / SR;
    for (let k = 0; k < 4; k++) {
      const Lf = c.lfos[k];
      const prev = v.lfoPh[k];
      let ph = prev + (this._lfoHz(k) * len) / SR;
      const wrapped = ph >= 1;
      ph -= Math.floor(ph);
      v.lfoPh[k] = ph;
      let val;
      if (Lf.shape === 5 || Lf.shape === 6) {
        if (wrapped) { v.lfoPrev[k] = v.lfoHold[k]; v.lfoHold[k] = v.rand() * 2 - 1; }
        val = Lf.shape === 5 ? v.lfoHold[k] : v.lfoPrev[k] + (v.lfoHold[k] - v.lfoPrev[k]) * (0.5 - 0.5 * Math.cos(Math.PI * ph));
      } else val = lfoValue(Lf.shape, ph);
      if (Lf.fade > 0) val *= Math.min(1, v.lfoT / Lf.fade);
      src[4 + k] = val;
    }
    src[8] = v.vel; src[9] = (v.note - 60) / 60; src[10] = v.rnd;
    const d = this._dst || (this._dst = new Float64Array(DST.length));
    d.fill(0);
    for (const [s, t, a] of c.mods) d[t] += src[s] * a;

    // glide
    if (v.pitch !== v.target) {
      const gt = c.glide > 0 ? c.glide : v.glideT || 0.06;
      const k = 1 - Math.exp(-len / ((gt / 3) * SR));
      v.pitch += (v.target - v.pitch) * k;
      if (Math.abs(v.target - v.pitch) < 0.001) v.pitch = v.target;
    }
    const basePitch = v.pitch + c.transpose + this.bend + v.bend + d[5] * 12;

    // smoothing coefficient for continuous params (≈ 4 ms)
    const sm = 1 - Math.exp(-len / (0.004 * SR));
    const fresh = v.fresh;
    v.fresh = false;

    // ---- oscillators: per-osc setup
    const oscs = this._oscs || (this._oscs = [{}, {}]);
    for (let o = 0; o < 2; o++) {
      const oc = c.osc[o], st = oscs[o];
      const tab = this.tables[o];
      st.on = oc.on && !!tab && tab.levels && tab.frames > 0;
      if (!st.on) continue;
      const posT = clamp(oc.pos + d[1 + o], 0, 1);
      const warpT = clamp(oc.warpAmt + d[3 + o], 0, 1);
      const lvlT = clamp(oc.level * (1 + d[8 + o]), 0, 2);
      const p0 = v.pos[o];
      if (fresh) { v.pos[o] = posT; v.warpA[o] = warpT; v.lvl[o] = lvlT; }
      else { v.pos[o] += (posT - v.pos[o]) * sm; v.warpA[o] += (warpT - v.warpA[o]) * sm; v.lvl[o] += (lvlT - v.lvl[o]) * sm; }
      st.p0 = fresh ? v.pos[o] : p0; st.p1 = v.pos[o];
      st.warp = oc.warp; st.wa = v.warpA[o];
      st.lut = (st.warp === 2 || st.warp === 3) && st.wa > 0 ? bendLut(st.warp, st.wa) : null;
      const f = mtof(basePitch + oc.semis + d[6 + o] * 12);
      const det = clamp(oc.detune + d[17 + o], 0, 1) * 50; // ± cents at the outer voices
      const maxRatio = Math.pow(2, det / 1200);
      st.inc = st.inc || new Float64Array(MAX_UNI);
      st.gl = st.gl || new Float64Array(MAX_UNI);
      st.gr = st.gr || new Float64Array(MAX_UNI);
      const [opl, opr] = panGains(oc.pan);
      for (let u = 0; u < oc.uni; u++) {
        const lay = oc.layout[u];
        st.inc[u] = (f * Math.pow(2, (lay.k * det) / 1200)) / SR;
        const [pl, pr] = panGains(clamp(lay.pan + oc.pan, -1, 1));
        const g = lay.gain * v.lvl[o];
        st.gl[u] = g * (oc.uni > 1 ? pl * Math.SQRT2 : opl * Math.SQRT2);
        st.gr[u] = g * (oc.uni > 1 ? pr * Math.SQRT2 : opr * Math.SQRT2);
      }
      st.uni = oc.uni;
      const bw = warpBandwidth(oc.warp, st.wa) * maxRatio;
      let lv = Math.ceil(Math.log2((MIP_H[0] * f * bw) / (SR / 2)) - 1e-9);
      lv = clamp(lv, 0, tab.levels.length - 1);
      st.lv = tab.levels[lv];
      st.F = tab.frames;
    }
    // sub / noise
    const subT = clamp(c.subLevel * (1 + d[15]), 0, 1), noiseT = clamp(c.noiseLevel * (1 + d[16]), 0, 1);
    v.subS = fresh ? subT : v.subS + (subT - v.subS) * sm;
    v.noiseS = fresh ? noiseT : v.noiseS + (noiseT - v.noiseS) * sm;
    const subInc = mtof(basePitch + c.subOct * 12) / SR;

    // filter
    const ft = c.filter;
    const kt = Math.pow(2, ((v.note - 60) / 12) * c.keytrack);
    const vf = Math.pow(2, c.velToFilter * (v.vel - 0.8) * 2.5);
    const cutT = clamp(c.cutoff * kt * vf * Math.pow(2, c.fEnv * env2 + d[10] * 6), 20, 20000);
    const resT = clamp(c.res + d[11], 0, 1);
    const drvT = clamp(c.drive + d[12], 0, 1);
    if (fresh) { v.cut = cutT; v.resS = resT; v.drv = drvT; }
    else { v.cut *= Math.pow(cutT / v.cut, sm); v.resS += (resT - v.resS) * sm; v.drv += (drvT - v.drv) * sm; }
    if (ft <= 3) {
      const k = svfK(v.resS);
      if (c.slope24) {
        v.f[0][0].setup(v.cut, 1.4142, SR); v.f[1][0].copyCoefs(v.f[0][0]);
        v.f[0][1].setup(v.cut, k, SR); v.f[1][1].copyCoefs(v.f[0][1]);
      } else { v.f[0][0].setup(v.cut, k, SR); v.f[1][0].copyCoefs(v.f[0][0]); }
    } else if (ft <= 5) {
      const fb = (ft === 4 ? 1 : -1) * (0.2 + 0.77 * v.resS);
      v.comb[0].setup(v.cut, fb, SR); v.comb[1].setup(v.cut, fb, SR);
    }
    const drive = v.drv;
    const preG = 1 + drive * 6, postG = drive > 0.001 ? 1 / Math.tanh(preG) : 1;

    const panT = clamp(d[13], -1, 1);
    v.panS = fresh ? panT : v.panS + (panT - v.panS) * sm;
    const [vpl, vpr] = panGains(v.panS);
    const ampMod = Math.max(0, 1 + d[14]);
    const velAmp = 1 - c.velToAmp + c.velToAmp * Math.pow(v.vel, 1.5);
    const gainBase = VOICE_SCALE * velAmp * ampMod * Math.SQRT2;

    // ---- sample loop
    const A = oscs[0], B = oscs[1];
    const e1 = v.envs[0];
    const fmA = A.on && A.warp === 7, fmB = B.on && B.warp === 7;
    for (let s = 0; s < len; s++) {
      const t = len > 1 ? s / len : 1;
      let l = 0, r = 0;
      let monoA = 0, monoB = 0;
      for (let o = 0; o < 2; o++) {
        const st = oscs[o];
        if (!st.on) continue;
        const pos = st.p0 + (st.p1 - st.p0) * t;
        const x = pos * (st.F - 1);
        const fi0 = x | 0, fi1 = fi0 + 1 < st.F ? fi0 + 1 : fi0, mt = x - fi0;
        const S = st.lv.size, mask = S - 1, data = st.lv.data, o0 = fi0 * S, o1 = fi1 * S;
        const ph = v.ph[o];
        const fmIn = o === 0 ? (fmA ? v.lastB : 0) : (fmB ? v.lastA : 0);
        let ms = 0;
        for (let u = 0; u < st.uni; u++) {
          let p = ph[u] + st.inc[u];
          if (p >= 1) p -= 1;
          ph[u] = p;
          let rp = p;
          if (st.lut) { const lx = p * LUT_N, li = lx | 0; rp = st.lut[li] + (st.lut[li + 1] - st.lut[li]) * (lx - li); }
          else if (st.warp) rp = warpPhase(st.warp, p, st.wa, fmIn);
          const xx = (rp - Math.floor(rp)) * S;
          const i0 = xx | 0, fr = xx - i0, i1 = (i0 + 1) & mask;
          const a0 = data[o0 + i0], a = a0 + (data[o0 + i1] - a0) * fr;
          let y = a;
          if (mt > 0) { const b0 = data[o1 + i0]; const b = b0 + (data[o1 + i1] - b0) * fr; y = a + (b - a) * mt; }
          if (st.warp === 8) y *= warpGain(8, p, st.wa);
          l += y * st.gl[u]; r += y * st.gr[u];
          ms += y;
        }
        if (o === 0) monoA = ms / st.uni; else monoB = ms / st.uni;
      }
      v.lastA = monoA; v.lastB = monoB;
      // sub
      if (v.subS > 0.0005) {
        v.subPh += subInc; if (v.subPh >= 1) v.subPh -= 1;
        const sp = v.subPh;
        let y;
        switch (c.subWave) {
          case 1: y = sp < 0.5 ? 4 * sp - 1 : 3 - 4 * sp; break;
          case 2: y = (sp < 0.5 ? 1 : -1) * 0.8; y += polyBlep(sp, subInc) * 0.8 - polyBlep((sp + 0.5) % 1, subInc) * 0.8; break;
          case 3: y = (2 * sp - 1 - polyBlep(sp, subInc)) * 0.8; break;
          default: y = Math.sin(2 * Math.PI * sp);
        }
        l += y * v.subS * 0.7; r += y * v.subS * 0.7;
      }
      // noise
      if (v.noiseS > 0.0005) {
        const w = v.rand() * 2 - 1;
        let y = w;
        if (c.noiseType === 1) {
          const b = v.pink;
          b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
          b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
          y = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11; b[6] = w * 0.115926;
        } else if (c.noiseType === 2) { v.brown = (v.brown + 0.02 * w) / 1.02; y = v.brown * 3.5; }
        l += y * v.noiseS * 0.5; r += y * v.noiseS * 0.5;
      }
      // drive + filter
      if (drive > 0.001) { l = Math.tanh(l * preG) * postG; r = Math.tanh(r * preG) * postG; }
      if (ft <= 3) {
        const mode = ft;
        if (c.slope24) {
          l = v.f[0][1].process(v.f[0][0].process(l, mode), mode);
          r = v.f[1][1].process(v.f[1][0].process(r, mode), mode);
        } else { l = v.f[0][0].process(l, mode); r = v.f[1][0].process(r, mode); }
      } else if (ft <= 5) { l = v.comb[0].process(l); r = v.comb[1].process(r); }
      // amp
      let g = e1.tick() * gainBase;
      if (v.kill) { g *= v.kill; v.kill -= v.killStep; if (v.kill <= 0) { v.kill = 0; v.active = false; v.mono = false; return; } }
      outL[off + s] += l * g * vpl;
      outR[off + s] += r * g * vpr;
    }
    if (e1.idle) { v.active = false; v.mono = false; }
  }
}

// bend warps call pow(): read them from cached 1024-point phase maps instead (keyed by mode + amount / 1000)
const LUT_N = 1024;
const luts = new Map();
function bendLut(mode, a) {
  const key = mode * 1000 + Math.round(a * 999);
  let t = luts.get(key);
  if (!t) {
    t = new Float32Array(LUT_N + 1);
    const aq = Math.round(a * 999) / 999;
    for (let i = 0; i <= LUT_N; i++) t[i] = warpPhase(mode, i / LUT_N, aq);
    if (luts.size > 256) luts.clear();
    luts.set(key, t);
  }
  return t;
}

function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

registerProcessor('daw3-wavetable', WavetableProcessor); // eslint-disable-line no-undef
