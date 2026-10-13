// Plays Strudel-style events (from src/code queryEvents) on synthesized voices:
// drum names -> drum-kit pads, waveforms -> light synth voices, preset ids / GM-ish names ->
// full preset instruments, project sample names -> sample playback. Per-event FX chain:
// hpf -> lpf -> bpf -> vowel -> shape -> crush -> amp(ADSR) -> pan.
import { clamp, midiToFreq, freqToMidi } from '../core/util.js';
import { DRUM_KITS } from './kits.js';
import { PRESETS } from './presets.js';
import { createInstrument } from './instruments.js';
import { playDrumVoice } from './drums.js';
import {
  Voice, envNote, getCrushCurve, getDriveCurve, getNoiseBuffer, getPulseWave, getReversedBuffer, fadeOut, isOffline, num,
} from './synth.js';

export const DRUM_ALIASES = {
  bd: 'kick', kick: 'kick', sd: 'snare', snare: 'snare', sn: 'snare', hh: 'hihat', hat: 'hihat', ch: 'hihat', hihat: 'hihat',
  oh: 'openhat', openhat: 'openhat', cp: 'clap', clap: 'clap', rim: 'rim', rs: 'rim', lt: 'tomlow', mt: 'tommid', ht: 'tomhigh',
  tom: 'tommid', cr: 'crash', crash: 'crash', rd: 'ride', ride: 'ride', cb: 'cowbell', cowbell: 'cowbell', sh: 'shaker',
  shaker: 'shaker', perc: 'conga', conga: 'conga', tb: 'tambourine', tamb: 'tambourine', tambourine: 'tambourine',
  cl: 'clave', clave: 'clave', misc: 'cowbell', fx: 'crash',
};
const WAVES = new Set(['sine', 'sin', 'sawtooth', 'saw', 'square', 'sqr', 'triangle', 'tri', 'supersaw', 'pulse', 'fm', 'white', 'pink', 'brown', 'noise']);
const NAMED = {
  piano: 'grand-piano', epiano: 'electric-piano', rhodes: 'electric-piano', organ: 'organ-drawbar', pluck: 'pluck',
  bass: 'saw-bass', pad: 'warm-pad', strings: 'strings', brass: 'brass-section', bell: 'bell', bells: 'bell', lead: 'saw-lead',
  synth: 'saw-lead', guitar: 'guitar-clean', choir: 'choir-pad', flute: 'flute', harp: 'harp', marimba: 'marimba',
  vibraphone: 'vibraphone', vibes: 'vibraphone', kalimba: 'kalimba', clav: 'clav', '808': '808-bass', sub: 'sub-bass',
};
const GM_KEYWORDS = [
  ['music_box', 'music-box'], ['epiano', 'electric-piano'], ['electric_piano', 'electric-piano'], ['harpsichord', 'harpsichord'],
  ['clavinet', 'clav'], ['piano', 'grand-piano'], ['celesta', 'celesta'], ['glockenspiel', 'celesta'], ['vibraphone', 'vibraphone'],
  ['marimba', 'marimba'], ['xylophone', 'marimba'], ['tubular', 'bell'], ['bell', 'bell'], ['organ', 'organ-drawbar'],
  ['distort', 'guitar-dist'], ['overdriven', 'guitar-dist'], ['guitar', 'guitar-clean'], ['acoustic_bass', 'upright-bass'],
  ['contrabass', 'upright-bass'], ['synth_bass', 'moog-bass'], ['bass', 'finger-bass'], ['string', 'strings'], ['violin', 'strings'],
  ['cello', 'strings'], ['choir', 'choir-pad'], ['voice', 'choir-pad'], ['trumpet', 'brass-lead'], ['brass', 'brass-section'],
  ['horn', 'brass-section'], ['flute', 'flute'], ['piccolo', 'flute'], ['whistle', 'whistle-lead'], ['ocarina', 'whistle-lead'],
  ['harp', 'harp'], ['koto', 'koto'], ['kalimba', 'kalimba'], ['steel', 'steel-drum'], ['pad', 'warm-pad'], ['lead', 'saw-lead'],
];
const VOWELS = { a: [800, 1150, 2900], e: [400, 1600, 2700], i: [350, 1700, 2700], o: [450, 800, 2830], u: [325, 700, 2530] };

/** Strudel bank name -> kit id. */
export function bankToKit(bank) {
  const b = String(bank || '').toLowerCase();
  if (!b) return null;
  if (DRUM_KITS[b]) return b;
  if (b.includes('808')) return '808';
  if (b.includes('909')) return '909';
  if (b.includes('606') || b.includes('101')) return 'techno';
  if (b.includes('707') || b.includes('727') || b.includes('626')) return 'house';
  if (b.includes('linn') || b.includes('dmx') || b.includes('oberheim')) return 'breaks';
  if (b.includes('mpc') || b.includes('sp12') || b.includes('akai') || b.includes('emu')) return 'lofi';
  if (b.includes('casio') || b.includes('nes') || b.includes('gameboy')) return 'chip';
  if (b.includes('acoustic') || b.includes('kit')) return 'acoustic';
  return null;
}

/** Resolve an `s` name to what will play it. */
export function classifySound(name, opts = {}) {
  const n = String(name || '').trim();
  const low = n.toLowerCase();
  if (DRUM_ALIASES[low]) return { kind: 'drum', pad: DRUM_ALIASES[low] };
  if (WAVES.has(low)) return { kind: 'wave', wave: low };
  if (PRESETS[low]) return { kind: 'preset', preset: low };
  if (NAMED[low]) return { kind: 'preset', preset: NAMED[low] };
  const buf = opts.getSampleByName?.(n);
  if (buf) return { kind: 'sample', buffer: buf };
  if (low.startsWith('gm_') || low.includes('_')) {
    for (const [kw, id] of GM_KEYWORDS) if (low.includes(kw)) return { kind: 'preset', preset: id };
  }
  // e.g. "RolandTR909_bd" style names
  const tail = low.split(/[_-]/).pop();
  if (DRUM_ALIASES[tail]) return { kind: 'drum', pad: DRUM_ALIASES[tail], kit: bankToKit(low) };
  return { kind: 'unknown' };
}

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** 'c4' | 'eb3' | 'f#' | 'Bb2' -> midi (octave defaults to 3, Strudel-style). */
export function noteNameToMidi(name) {
  const m = /^([a-gA-G])([#sb]*)(-?\d+)?$/.exec(String(name).trim());
  if (!m) return null;
  let pc = PC[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === 'b' ? -1 : 1;
  const oct = m[3] != null ? Number(m[3]) : 3;
  return (oct + 1) * 12 + pc;
}

function eventMidi(v) {
  if (v.note != null) {
    const m = typeof v.note === 'number' ? v.note : Number(v.note);
    if (Number.isFinite(m)) return m;
    const nm = noteNameToMidi(v.note);
    if (nm != null) return nm;
  }
  if (v.freq != null && Number(v.freq) > 0) return freqToMidi(Number(v.freq));
  if (v.n != null && Number.isFinite(Number(v.n))) { const n = Number(v.n); return n >= 24 ? n : 60 + n; }
  return null;
}

export class CodeInstrument {
  constructor(ctx, output, opts = {}) {
    this.ctx = ctx;
    this.opts = opts || {};
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    if (output) this.bus.connect(output);
    this.voices = new Set();
    this.presetInsts = new Map();
    this.maxVoices = 96;
    this.defaultKit = opts.defaultKit || '808';
  }

  _register(v) {
    this.voices.add(v);
    v.onDone = () => this.voices.delete(v);
    if (this.voices.size > this.maxVoices) {
      const oldest = [...this.voices].filter((x) => !x.done).sort((a, b) => a.start - b.start)[0];
      if (oldest) this._kill(oldest, Math.max(this.ctx.currentTime, oldest.start));
    }
    return v;
  }
  _kill(v, t, fade = 0.015) {
    if (v.done) return;
    if (v.choke) { v.choke(t, fade); return; }
    const g = v.amp?.gain;
    if (g) fadeOut(g, t, fade, g.value);
    v.stopAt(t + fade + 0.01);
  }

  /** Build the per-event FX chain. Returns {input, amp, nodes, output}. */
  _chain(t, v) {
    const ctx = this.ctx, nyq = ctx.sampleRate / 2 - 100;
    const nodes = [];
    const mk = (n) => { nodes.push(n); return n; };
    const input = mk(ctx.createGain());
    let node = input;
    const hpf = v.hpf ?? v.hcutoff;
    if (hpf != null && Number(hpf) > 0) {
      const f = mk(ctx.createBiquadFilter());
      f.type = 'highpass'; f.frequency.value = clamp(num(hpf, 200), 20, nyq); f.Q.value = clamp(num(v.hpq ?? v.hresonance, 1), 0.0001, 30);
      node.connect(f); node = f;
    }
    const lpf = v.lpf ?? v.cutoff ?? v.ctf;
    let lpNode = null;
    if (lpf != null && Number(lpf) > 0) {
      const f = mk(ctx.createBiquadFilter());
      f.type = 'lowpass'; f.frequency.value = clamp(num(lpf, 20000), 20, nyq);
      f.Q.value = clamp(num(v.resonance ?? v.lpq, 1), 0.0001, 30);
      node.connect(f); node = f; lpNode = f;
    }
    const bpf = v.bpf ?? v.bandf;
    if (bpf != null && Number(bpf) > 0) {
      const f = mk(ctx.createBiquadFilter());
      f.type = 'bandpass'; f.frequency.value = clamp(num(bpf, 1000), 20, nyq); f.Q.value = clamp(num(v.bpq ?? v.bandq, 1), 0.0001, 30);
      node.connect(f); node = f;
    }
    if (v.vowel && VOWELS[String(v.vowel)[0]]) {
      const sum = mk(ctx.createGain());
      sum.gain.value = 2.5;
      for (const fr of VOWELS[String(v.vowel)[0]]) {
        const f = mk(ctx.createBiquadFilter());
        f.type = 'bandpass'; f.frequency.value = fr; f.Q.value = 8;
        node.connect(f); f.connect(sum);
      }
      node = sum;
    }
    const shape = num(v.shape ?? v.distort, 0, 0, 1);
    if (shape > 0.001) {
      const pre = mk(ctx.createGain()); pre.gain.value = 1 + shape * 3;
      const ws = mk(ctx.createWaveShaper()); ws.curve = getDriveCurve(shape); ws.oversample = '2x';
      const post = mk(ctx.createGain()); post.gain.value = 1 / (1 + shape * 1.5);
      node.connect(pre); pre.connect(ws); ws.connect(post); node = post;
    }
    const crush = num(v.crush, 0, 0, 16);
    if (crush >= 1 && crush < 16) {
      const ws = mk(ctx.createWaveShaper()); ws.curve = getCrushCurve(crush);
      node.connect(ws); node = ws;
    }
    const amp = mk(ctx.createGain());
    amp.gain.value = 0;
    node.connect(amp); node = amp;
    if (v.pan != null) {
      const pn = mk(ctx.createStereoPanner());
      pn.pan.value = clamp(num(v.pan, 0.5) * 2 - 1, -1, 1);
      node.connect(pn); node = pn;
    }
    node.connect(this.bus);
    return { input, amp, nodes, lpNode };
  }

  trigger(time, value, durSec) {
    try { return this._trigger(time, value, durSec); } catch (e) { if (typeof console !== 'undefined') console.warn('[code-instrument]', e); return null; }
  }

  _trigger(time, value, durSec) {
    const ctx = this.ctx;
    const t = Math.max(num(time, ctx.currentTime), ctx.currentTime);
    const v = value && typeof value === 'object' ? value : { s: value };
    const dur = num(durSec, 0.25, 0.01, 60);
    const level = num(v.gain, 1, 0, 4) * num(v.velocity, 1, 0, 2);
    if (level <= 0) return null;
    let midi = eventMidi(v);
    let sName = v.s ?? v.sound;
    if (sName == null) sName = midi != null ? 'triangle' : 'bd';
    let [name, idx] = String(sName).split(':');
    if (idx == null && v.n != null && midi == null) idx = v.n;
    const info = classifySound(name, this.opts);
    if (info.kind === 'unknown') {
      if (midi == null) return null;
      info.kind = 'wave'; info.wave = 'sawtooth';
    }
    if (info.kind === 'preset') return this._preset(t, info.preset, midi ?? 60, level, dur, v);
    if (info.kind === 'drum') return this._drum(t, info, v, level, idx, midi);
    if (info.kind === 'sample') return this._sample(t, info.buffer, v, level, midi, dur);
    return this._synth(t, info.wave, midi ?? 48, v, level, dur);
  }

  _preset(t, id, midi, level, dur, v) {
    let inst = this.presetInsts.get(id);
    if (!inst) {
      inst = createInstrument(this.ctx, this.bus, { type: PRESETS[id]?.instrument.type || 'synth', preset: id, params: {} }, this.opts);
      this.presetInsts.set(id, inst);
    }
    const extra = {};
    if (v.pan != null) extra.pan = clamp(num(v.pan, 0.5) * 2 - 1, -1, 1);
    const lpf = v.lpf ?? v.cutoff;
    if (lpf != null) extra.cutoff = num(lpf, 8000, 20, 20000);
    inst.trigger(t, clamp(Math.round(midi), 0, 127), clamp(level * 0.8, 0, 1), dur, extra);
    return null;
  }

  _drum(t, info, v, level, idx, midi) {
    const kitId = bankToKit(v.bank) || info.kit || this.defaultKit;
    const kit = DRUM_KITS[kitId] || DRUM_KITS['808'];
    const def = kit.voices[info.pad];
    const ch = this._chain(t, v);
    ch.amp.gain.setValueAtTime(level * 0.8, t);
    const speed = num(v.speed, 1, -16, 16);
    const variation = num(idx, 0, 0, 64);
    let tune = (Math.abs(speed) > 0.01 ? 12 * Math.log2(Math.abs(speed)) : 0) + ((variation % 4) * 0.7);
    if (v.note != null && midi != null) tune += midi - 36;
    // choke groups: hats choke each other; `cut` groups too
    const group = v.cut != null ? `cut${v.cut}` : (info.pad === 'hihat' || info.pad === 'openhat') ? 'hat' : null;
    if (group) for (const o of this.voices) if (o.group === group && o.start < t + 1e-4) this._kill(o, t, 0.01);
    const dv = playDrumVoice(this.ctx, ch.input, t, def, {
      tune, decay: v.decay != null && v.sustain == null ? clamp(num(v.decay, 1) * 4, 0.1, 4) : 1, vel: 1, fx: kit.fx,
    });
    dv.nodes.push(...ch.nodes);
    dv.group = group;
    dv.amp = ch.amp;
    return this._register(dv);
  }

  _sample(t, buffer, v, level, midi, dur) {
    const ch = this._chain(t, v);
    let speed = num(v.speed, 1, -16, 16);
    if (v.note != null && midi != null) speed *= Math.pow(2, (midi - 36) / 12);
    const begin = num(v.begin, 0, 0, 1), end = num(v.end, 1, 0, 1);
    const ctx = this.ctx;
    const vo = new Voice(ctx);
    vo.start = t;
    const src = vo.src(ctx.createBufferSource());
    src.buffer = speed < 0 ? getReversedBuffer(ctx, buffer) : buffer;
    src.playbackRate.value = clamp(Math.abs(speed) || 1, 0.01, 16);
    const b0 = speed < 0 ? 1 - end : begin, b1 = speed < 0 ? 1 - begin : end;
    const offset = b0 * buffer.duration;
    const segLen = Math.max(0.001, (b1 - b0) * buffer.duration);
    let outLen = segLen / src.playbackRate.value;
    if (v.clip != null || v.legato != null) outLen = Math.min(outLen, dur * num(v.clip ?? v.legato, 1, 0, 16));
    if (v.loop) { src.loop = true; src.loopStart = offset; src.loopEnd = offset + segLen; outLen = dur; }
    src.connect(ch.input);
    const a = num(v.attack, 0.001, 0.001, 10), r = num(v.release, 0.01, 0.005, 10);
    const g = ch.amp.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(level, t + a);
    const relAt = Math.max(t + a, t + outLen - Math.min(r, outLen * 0.5));
    g.setValueAtTime(level, relAt);
    g.linearRampToValueAtTime(0, t + outLen);
    vo.nodes.push(...ch.nodes);
    vo.amp = ch.amp;
    src.onended = () => vo.cleanup();
    src.start(t, offset);
    vo.stopAt(t + outLen + 0.01);
    return this._register(vo);
  }

  _synth(t, wave, midi, v, level, dur) {
    const ctx = this.ctx, nyq = ctx.sampleRate / 2;
    const ch = this._chain(t, v);
    const vo = new Voice(ctx);
    vo.start = t;
    const freq = v.freq != null && Number(v.freq) > 0 ? Number(v.freq) : midiToFreq(midi);
    const mix = vo.node(ctx.createGain());
    mix.connect(ch.input);
    const detuneParams = [];
    const freqParams = [];
    const addOsc = (type, cents = 0, gain = 1) => {
      const o = vo.src(ctx.createOscillator());
      if (type === 'pulse') o.setPeriodicWave(getPulseWave(ctx, num(v.pw, 0.5, 0.02, 0.98)));
      else o.type = type;
      o.frequency.value = clamp(freq, 1, nyq);
      o.detune.value = cents;
      detuneParams.push(o.detune); freqParams.push(o.frequency);
      if (gain !== 1) { const g = vo.node(ctx.createGain()); g.gain.value = gain; o.connect(g); g.connect(mix); } else o.connect(mix);
      return o;
    };
    let base = 0.3;
    switch (wave) {
      case 'sine': case 'sin': addOsc('sine'); base = 0.35; break;
      case 'square': case 'sqr': addOsc('square'); base = 0.22; break;
      case 'triangle': case 'tri': addOsc('triangle'); base = 0.35; break;
      case 'pulse': addOsc('pulse'); base = 0.25; break;
      case 'supersaw': {
        const n = Math.round(num(v.unison, 5, 1, 9));
        const det = num(v.detune, 0.18, 0, 2) * 100; // semitones -> cents spread
        for (let i = 0; i < n; i++) addOsc('sawtooth', n > 1 ? (i / (n - 1) - 0.5) * det : 0, 1 / Math.sqrt(n));
        base = 0.3; break;
      }
      case 'fm': addOsc('sine'); base = 0.35; break;
      case 'white': case 'pink': case 'brown': case 'noise': {
        const ns = vo.src(ctx.createBufferSource());
        ns.buffer = getNoiseBuffer(ctx, wave === 'noise' ? 'white' : wave);
        ns.loop = true;
        ns.connect(mix);
        base = 0.25; break;
      }
      default: addOsc('sawtooth'); base = 0.25;
    }
    // FM modulation (fm wave or any wave with fmi)
    const fmi = num(v.fmi, wave === 'fm' ? 2 : 0, 0, 50);
    if (fmi > 0 && freqParams.length) {
      const h = num(v.fmh, 1, 0.01, 32);
      const m = vo.src(ctx.createOscillator());
      m.frequency.value = clamp(freq * h, 0.1, nyq);
      const mg = vo.node(ctx.createGain());
      mg.gain.value = fmi * freq * h;
      m.connect(mg);
      for (const fp of freqParams) mg.connect(fp);
      detuneParams.push(m.detune);
    }
    // vibrato
    const vib = num(v.vib, 0, 0, 30);
    if (vib > 0) {
      const l = vo.src(ctx.createOscillator());
      l.frequency.value = vib;
      const lg = vo.node(ctx.createGain());
      lg.gain.value = num(v.vibmod, 0.5, 0, 24) * 100;
      l.connect(lg);
      for (const d of detuneParams) lg.connect(d);
    }
    // pitch envelope
    const penv = num(v.penv, 0, -48, 48);
    if (Math.abs(penv) > 0.01) {
      const pd = num(v.pdecay, 0.1, 0.001, 5);
      for (const d of detuneParams) { const b = d.value; d.setValueAtTime(b + penv * 100, t); d.setTargetAtTime(b, t, pd / 4); }
    }
    // filter envelope (Strudel lpenv in octaves)
    const lpenv = num(v.lpenv, 0, -10, 10);
    if (ch.lpNode && Math.abs(lpenv) > 0.01) {
      envNote(ch.lpNode.detune, t, t + dur, { a: num(v.lpattack, 0.005), d: num(v.lpdecay, 0.2), s: num(v.lpsustain, 0), r: num(v.lprelease, 0.1) }, lpenv * 1200, 0);
    }
    mix.gain.value = base;
    // amp ADSR (Strudel defaults: a .001, d .05, s .6 unless decay given, r .01)
    const hasDecay = v.decay != null;
    const st = envNote(ch.amp.gain, t, t + dur, {
      a: num(v.attack, 0.002, 0.001, 20), d: num(v.decay, 0.05, 0.001, 20),
      s: num(v.sustain, hasDecay ? 0 : 0.7, 0, 1), r: num(v.release, 0.03, 0.005, 20),
    }, level, 0);
    vo.nodes.push(...ch.nodes);
    vo.amp = ch.amp;
    vo.startAll(t);
    vo.stopAt(st.tOff + st.r + 0.02);
    if (v.cut != null) {
      vo.group = `cut${v.cut}`;
      for (const o of this.voices) if (o.group === vo.group && o.start < t) this._kill(o, t, 0.01);
    }
    return this._register(vo);
  }

  allNotesOff(time) {
    const t = Math.max(num(time, this.ctx.currentTime), this.ctx.currentTime);
    for (const v of this.voices) this._kill(v, t, 0.02);
    for (const inst of this.presetInsts.values()) inst.allNotesOff(t);
  }
  dispose() {
    this.allNotesOff();
    for (const inst of this.presetInsts.values()) inst.dispose();
    this.presetInsts.clear();
    const bus = this.bus;
    if (!isOffline(this.ctx)) setTimeout(() => { try { bus.disconnect(); } catch { /* */ } }, 120);
  }
}
