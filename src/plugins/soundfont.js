// SoundFont (midi-js-soundfonts) sampled instrument. Browser-only.
// Downloads one instrument file (≈2 MB of base64 MP3/OGG per note), decodes every note once
// (in-memory bank cache shared by live playback and offline renders) and plays each MIDI note
// from the nearest sampled note, repitched with playbackRate.
//
// params.multisample (optional): a real multisampled instrument from src/audio/library/multisample-data.js
// (velocity layers, round robins, loops, release samples) tried first; params.range [lo, hi] limits which of
// its notes are downloaded. Fallback order: multisample -> midi-js file of params.library -> FluidR3_GM;
// when everything fails `ready` resolves false and the Instrument wrapper switches to its fallbackPreset.
import { parseSoundfontText, dataUrlToBytes } from './soundfont-parse.js';
import { fetchText, forget, releaseMemory } from './fetch-cache.js';
import { setStatus, soundfontSourceUrl, friendlyError, userError, pluginKey } from './status.js';
import { soundfontUrl } from './gm.js';
import { loadMultisampleBank, zoneBankFromSoundfont, playSampleVoice, releaseSampleVoice, MS_SETS } from '../audio/library/multisample.js';

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

/** Load a bank while reporting progress / errors to the status registry (key 'sf:<url>'). */
export function loadSoundfontWithStatus(url, sampleRate = 44100) {
  const key = 'sf:' + url;
  setStatus(key, { state: 'loading', progress: 0, message: 'Downloading samples…' });
  return loadSoundfontBank(url, {
    sampleRate,
    onProgress: (f) => setStatus(key, { state: 'loading', progress: f ?? 0, message: f != null && f >= 0.7 ? 'Decoding samples…' : 'Downloading samples…' }),
  }).then((bank) => {
    setStatus(key, { state: 'ready', progress: 1, message: `${bank.buffers.length} samples`, info: { name: bank.name, samples: bank.buffers.length } });
    return bank;
  }, (e) => {
    const message = friendlyError(e, { url, kind: 'soundfont' });
    setStatus(key, { state: 'error', error: message, message });
    throw userError(message);
  });
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class SoundfontEngine {
  constructor(ctx, output, params, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.out = ctx.createGain();
    this.out.connect(output);
    this.voices = [];
    this.bank = null; // zone bank (multisample or wrapped midi-js bank)
    this.url = null;
    this.source = null; // 'multisample:<id>' | 'soundfont:<library>' — what actually plays
    this.error = null;
    this.ready = Promise.resolve(false);
    this.setParams(params);
  }

  get key() { return pluginKey({ type: 'soundfont', params: this.p }); }

  setParams(p) {
    this.p = p || {};
    const t = this.ctx.currentTime;
    try { this.out.gain.setTargetAtTime(clamp(Number(this.p.gain ?? 0.8), 0, 2), t, 0.01); } catch { this.out.gain.value = this.p.gain ?? 0.8; }
    const url = soundfontSourceUrl(this.p);
    const src = `${url}|${this.p.multisample || ''}|${(this.p.range || []).join(',')}`;
    if (src !== this.url) {
      this.url = src;
      this.bank = null;
      this.ready = this._load(src);
    }
  }

  reload() {
    const url = soundfontSourceUrl(this.p);
    this.url = null;
    return resetSoundfont(url).then(() => { this.setParams(this.p); return this.ready; });
  }

  async _load(src) {
    this.error = null;
    const p = this.p;
    const key = this.key;
    const sr = this.ctx.sampleRate;
    const ms = p.multisample && MS_SETS[p.multisample] ? p.multisample : null;
    const range = Array.isArray(p.range) && p.range.length === 2 ? p.range : null;
    const current = () => this.url === src;
    if (ms) {
      setStatus(key, { state: 'loading', progress: 0, message: `Downloading ${MS_SETS[ms].name}…` });
      try {
        const bank = await loadMultisampleBank(ms, { sampleRate: sr, range, onProgress: (f) => setStatus(key, { state: 'loading', progress: f, message: `Downloading ${MS_SETS[ms].name}…` }) });
        if (!current()) return false;
        this.bank = bank;
        this.source = `multisample:${ms}`;
        setStatus(key, { state: 'ready', progress: 1, message: `${bank.files} samples`, info: { name: MS_SETS[ms].name, samples: bank.files, source: this.source, license: MS_SETS[ms].license } });
        return true;
      } catch (e) {
        console.warn('[soundfont] multisample failed, falling back to the GM soundfont:', e?.message || e);
      }
    }
    // midi-js soundfont: the requested library, then FluidR3_GM (the smallest, most widely cached set)
    const urls = [soundfontSourceUrl(p)];
    if (!p.url && p.library && p.library !== 'FluidR3_GM') urls.push(soundfontUrl('FluidR3_GM', p.instrument, p.format));
    let lastErr = null;
    for (const url of urls) {
      try {
        const bank = await loadSoundfontWithStatus(url, sr);
        if (!current()) return false;
        this.bank = zoneBankFromSoundfont(bank);
        this.source = `soundfont:${/\/(FluidR3_GM|MusyngKite|FatBoy)\//.exec(url)?.[1] || 'custom'}`;
        if (key !== 'sf:' + url) setStatus(key, { state: 'ready', progress: 1, message: `${bank.buffers.length} samples`, info: { name: bank.name, samples: bank.buffers.length, source: this.source } });
        return true;
      } catch (e) { lastErr = e; }
    }
    if (current()) {
      this.error = lastErr?.message || 'Could not load the instrument samples.';
      setStatus(key, { state: 'error', error: this.error, message: this.error });
    }
    return false;
  }

  _active() { return this.voices.filter((v) => !v.done); }

  _start(pitch, vel, time, extra = {}) {
    const bank = this.bank;
    if (!bank) return null;
    const t = Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime);
    // voice limit: release the oldest voices first
    const active = this._active();
    const maxV = clamp(Math.round(this.p.polyphony ?? 32), 1, 64);
    for (let i = 0; i <= active.length - maxV; i++) this._release(active[i], t, 0.015);
    return playSampleVoice(this, bank, pitch, vel, t, extra);
  }

  _release(voice, time, fast = 0) { releaseSampleVoice(this, voice, time, fast); }

  trigger(time, pitch, vel, durSec, extra) {
    const v = this._start(pitch, vel, time, extra || {});
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
