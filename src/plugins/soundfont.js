// SoundFont (midi-js-soundfonts) sampled instrument. Browser-only.
// Downloads one instrument file (≈2 MB of base64 MP3/OGG per note), decodes every note once
// (in-memory bank cache shared by live playback and offline renders) and plays each MIDI note
// from the nearest sampled note, repitched with playbackRate.
import { parseSoundfontText, dataUrlToBytes, nearestSampleIndex, playbackRateFor } from './soundfont-parse.js';
import { fetchText, forget, releaseMemory } from './fetch-cache.js';
import { setStatus, soundfontSourceUrl, friendlyError, userError } from './status.js';

const banks = new Map(); // url -> Promise<{ name, midis:number[], buffers:AudioBuffer[] }>

/** Load (or reuse) the decoded sample bank of a soundfont file URL. */
export function loadSoundfontBank(url, { sampleRate = 44100, onProgress } = {}) {
  if (banks.has(url)) return banks.get(url);
  const p = (async () => {
    const text = await fetchText(url, { onProgress: (f) => onProgress?.(f == null ? null : f * 0.7) });
    const parsed = parseSoundfontText(text);
    const dec = new OfflineAudioContext(1, 1, sampleRate);
    let done = 0;
    const results = await Promise.all(parsed.samples.map(async (s) => {
      try {
        const bytes = dataUrlToBytes(s.dataUrl);
        const buf = await new Promise((resolve, reject) => {
          const r = dec.decodeAudioData(bytes.buffer, resolve, reject);
          if (r && typeof r.then === 'function') r.then(resolve, reject);
        });
        return { midi: s.midi, buf };
      } catch {
        return null; // e.g. OGG on Safari — skip that note
      } finally {
        done++;
        onProgress?.(0.7 + 0.3 * (done / parsed.samples.length));
      }
    }));
    const ok = results.filter(Boolean);
    if (!ok.length) throw userError('None of the samples could be decoded by this browser (try the MP3 format).');
    releaseMemory(url);
    // midi-js soundfonts are rendered quietly (peaks around -20 dBFS): normalise the whole bank
    // with one factor so the relative levels across the keyboard stay intact.
    let peak = 0;
    for (const { buf } of ok) {
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i += 4) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
      }
    }
    const norm = peak > 0 ? Math.min(10, 0.7 / peak) : 1;
    return { name: parsed.name, midis: ok.map((r) => r.midi), buffers: ok.map((r) => r.buf), norm };
  })();
  banks.set(url, p);
  p.catch(() => banks.delete(url));
  return p;
}

/** Drop caches for a URL so the next load re-downloads it. */
export async function resetSoundfont(url) {
  banks.delete(url);
  await forget(url);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class SoundfontEngine {
  constructor(ctx, output, params, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.out = ctx.createGain();
    this.out.connect(output);
    this.voices = [];
    this.bank = null;
    this.url = null;
    this.error = null;
    this.ready = Promise.resolve(false);
    this.setParams(params);
  }

  get key() { return 'sf:' + this.url; }

  setParams(p) {
    this.p = p || {};
    const t = this.ctx.currentTime;
    try { this.out.gain.setTargetAtTime(clamp(Number(this.p.gain ?? 0.8), 0, 2), t, 0.01); } catch { this.out.gain.value = this.p.gain ?? 0.8; }
    const url = soundfontSourceUrl(this.p);
    if (url !== this.url) {
      this.url = url;
      this.bank = null;
      this.ready = this._load(url);
    }
  }

  reload() {
    const url = this.url;
    this.url = null;
    return resetSoundfont(url).then(() => { this.setParams(this.p); return this.ready; });
  }

  _load(url) {
    const key = 'sf:' + url;
    this.error = null;
    setStatus(key, { state: 'loading', progress: 0, message: 'Downloading samples…' });
    return loadSoundfontBank(url, {
      sampleRate: this.ctx.sampleRate,
      onProgress: (f) => setStatus(key, { state: 'loading', progress: f ?? 0, message: f != null && f >= 0.7 ? 'Decoding samples…' : 'Downloading samples…' }),
    }).then((bank) => {
      if (this.url === url) this.bank = bank;
      setStatus(key, { state: 'ready', progress: 1, message: `${bank.buffers.length} samples`, info: { name: bank.name, samples: bank.buffers.length } });
      return true;
    }, (e) => {
      const message = friendlyError(e, { url, kind: 'soundfont' });
      if (this.url === url) this.error = message;
      setStatus(key, { state: 'error', error: message, message });
      return false;
    });
  }

  _active() { return this.voices.filter((v) => !v.done); }

  _start(pitch, vel, time) {
    const bank = this.bank;
    if (!bank) return null;
    const ctx = this.ctx;
    const t = Math.max(time ?? ctx.currentTime, ctx.currentTime);
    const p = this.p;
    const note = pitch + Number(p.tune || 0);
    const idx = nearestSampleIndex(bank.midis, note);
    if (idx < 0) return null;
    // voice limit: release the oldest voices first
    const active = this._active();
    const maxV = clamp(Math.round(p.polyphony ?? 32), 1, 64);
    for (let i = 0; i <= active.length - maxV; i++) this._release(active[i], t, 0.015);

    const src = ctx.createBufferSource();
    src.buffer = bank.buffers[idx];
    src.playbackRate.value = playbackRateFor(note, bank.midis[idx], Number(p.fine || 0));
    const g = ctx.createGain();
    const vs = clamp(Number(p.velSens ?? 0.7), 0, 1);
    const v = clamp(Number(vel ?? 0.8), 0, 1);
    const amp = ((1 - vs) + vs * v * v) * (bank.norm || 1);
    const att = Math.max(0.001, Number(p.attack ?? 0.002));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + att);
    src.connect(g);
    g.connect(this.out);
    src.start(t);
    const voice = { pitch, src, g, start: t, done: false, released: false };
    src.onended = () => {
      voice.done = true;
      try { g.disconnect(); } catch { /* */ }
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(voice);
    return voice;
  }

  _release(voice, time, fast = 0) {
    if (!voice || voice.released || voice.done) return;
    voice.released = true;
    const t = Math.max(time ?? this.ctx.currentTime, voice.start);
    const rel = fast || Math.max(0.01, Number(this.p.release ?? 0.4));
    const gp = voice.g.gain;
    try {
      if (gp.cancelAndHoldAtTime) gp.cancelAndHoldAtTime(t);
      else { gp.cancelScheduledValues(t); }
      gp.setTargetAtTime(0, t, rel / 5);
      voice.src.stop(t + rel + 0.05);
    } catch { /* already stopped */ }
  }

  trigger(time, pitch, vel, durSec) {
    const v = this._start(pitch, vel, time);
    if (v) this._release(v, time + Math.max(0.005, durSec));
  }

  noteOn(pitch, vel, time) { this._start(pitch, vel, time); }

  noteOff(pitch, time) {
    for (const v of this.voices) if (v.pitch === pitch && !v.released) this._release(v, time);
  }

  allNotesOff(time) {
    for (const v of [...this.voices]) this._release(v, time ?? this.ctx.currentTime, 0.02);
  }

  dispose() {
    this.allNotesOff();
    const out = this.out;
    setTimeout(() => { try { out.disconnect(); } catch { /* */ } }, 200);
  }
}

export { SoundfontEngine as Engine };
