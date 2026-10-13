// Multisampled instruments: note / velocity-layer / round-robin maps of real recorded instruments
// (Salamander Grand, VSCO-2-CE orchestra, VCSL, tonejs-instruments — see multisample-data.js and
// docs/SAMPLES.md), streamed from GitHub at runtime through the shared sample library cache.
//
//  * Pure helpers (Node-safe): msUrl, layerForVelocity, nearestNote, notesForRange, crossfadeLoopPoints.
//  * Browser: loadMultisampleBank(id, {sampleRate, range}) -> bank; playSampleVoice(engine, bank, …) plays
//    one note from any "zone bank" (multisample banks and midi-js soundfont banks share the voice code):
//    velocity layers, round robins, nearest-sample repitch, velocity -> brightness, attack / release,
//    seamless crossfade loops for held sustained notes, release samples (piano dampers), and the
//    expression extras glideFrom / bend / vib (see src/gen/expression.js).
//
// Long WAV recordings (VSCO / VCSL keep 10–40 s per note) are fetched with an HTTP Range request
// (`maxSec` of audio per file) — sustained notes loop a crossfaded region, decays fade at the end.
import { MS_SETS, MS_BASES } from './multisample-data.js';
import { library, canonicalUrl } from './sample-library.js';

export { MS_SETS };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 'vsco:Strings/…/x.wav' -> full raw.githubusercontent URL. */
export function msUrl(ref) {
  const i = String(ref).indexOf(':');
  const repo = ref.slice(0, i), path = ref.slice(i + 1);
  return (MS_BASES[repo] || '') + path; // canonicalised (spaces, '#') once, by the sample library
}

/** Velocity (0..1) -> layer index of a set with n layers (layers are spaced on a perceptual curve). */
export function layerForVelocity(vel, n) {
  if (!(n > 1)) return 0;
  const v = clamp(Number(vel) || 0, 0, 1);
  const bounds = n === 2 ? [0.62] : n === 3 ? [0.45, 0.76] : n === 4 ? [0.32, 0.55, 0.78] : Array.from({ length: n - 1 }, (_, i) => 0.25 + (0.6 * (i + 1)) / n);
  let l = 0;
  while (l < bounds.length && v >= bounds[l]) l++;
  return l;
}

/** Index of the sampled note closest to midi in a sorted list (ties -> the lower sample, so it is pitched up). */
export function nearestNote(sorted, midi) {
  if (!sorted.length) return -1;
  let best = 0, bd = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const d = Math.abs(sorted[i] - midi);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Sampled notes of a set needed to play every pitch in [lo, hi] (the whole set when no range). */
export function notesForRange(set, range) {
  const notes = [...new Set(set.zones.map((z) => z[0]))].sort((a, b) => a - b);
  if (!range) return notes;
  const lo = Math.max(0, Math.round(range[0]) - 2), hi = Math.min(127, Math.round(range[1]) + 2);
  const need = new Set();
  for (let p = lo; p <= hi; p++) need.add(notes[nearestNote(notes, p)]);
  return notes.filter((n) => need.has(n));
}

/**
 * Loop region of a sustained sample (seconds): after the attack, ending just before the cut, with a crossfade length.
 * -> {start, end, fade} | null when the sample is too short to loop.
 */
export function crossfadeLoopPoints(duration, { attack = 0.4 } = {}) {
  if (!(duration >= 1.2)) return null;
  const end = duration - 0.06;
  const start = Math.max(Math.min(attack + 0.35, end * 0.45), end - 2.2);
  const fade = Math.min(0.3, (end - start) / 3);
  return { start, end, fade };
}

// ------------------------------------------------------------------------------------- loading
/** Keep only the first maxSec of a (possibly truncated) RIFF/WAVE file and fix its header. Non-WAV bytes pass through. */
export function trimWav(bytes, maxSec) {
  const u8 = new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length < 44 || str(0) !== 'RIFF' || str(8) !== 'WAVE') return bytes;
  let p = 12, fmt = null;
  while (p + 8 <= u8.length) {
    const id = str(p), size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { off: p + 8, size, ch: dv.getUint16(p + 10, true), sr: dv.getUint32(p + 12, true), align: dv.getUint16(p + 20, true) };
    if (id === 'data') {
      if (!fmt || !fmt.align) return bytes;
      const avail = Math.max(0, u8.length - (p + 8));
      let n = Math.min(size, avail);
      if (maxSec > 0) n = Math.min(n, Math.floor(maxSec * fmt.sr) * fmt.align);
      n -= n % fmt.align;
      const out = new Uint8Array(12 + 8 + fmt.size + 8 + n);
      const ov = new DataView(out.buffer);
      out.set(u8.subarray(0, 12), 0);
      out.set(u8.subarray(fmt.off - 8, fmt.off + fmt.size), 12);
      let q = 12 + 8 + fmt.size;
      out.set([0x64, 0x61, 0x74, 0x61], q); ov.setUint32(q + 4, n, true);
      out.set(u8.subarray(p + 8, p + 8 + n), q + 8);
      ov.setUint32(4, out.length - 8, true);
      return out.buffer;
    }
    p += 8 + size + (size & 1);
  }
  return bytes;
}

const decodedCache = new Map(); // `${rate}|${url}|${maxSec}` -> Promise<AudioBuffer|null>

function decode(rate, bytes) {
  const ctx = new OfflineAudioContext(1, 1, rate);
  return new Promise((resolve, reject) => {
    const q = ctx.decodeAudioData(bytes, resolve, reject);
    if (q && typeof q.then === 'function') q.then(resolve, reject);
  });
}

/** Post-process a decoded sample: fade a truncated decay, bake a crossfade loop into a sustained one. */
function prepareBuffer(buf, set) {
  const sr = buf.sampleRate;
  const truncated = set.maxSec && buf.duration >= set.maxSec - 0.02;
  if (set.kind === 'sustain') {
    const lp = crossfadeLoopPoints(buf.duration, { attack: set.attack || 0.1 });
    if (lp) {
      const s = Math.floor(lp.start * sr), e = Math.floor(lp.end * sr), X = Math.floor(lp.fade * sr);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < X; i++) {
          const w = (i + 0.5) / X;
          const j = e - X + i, k = s - X + i;
          if (k < 0) continue;
          d[j] = d[j] * Math.cos(w * Math.PI / 2) + d[k] * Math.sin(w * Math.PI / 2);
        }
      }
      buf._loop = { start: s / sr, end: e / sr };
    }
  } else if (truncated) {
    const n = Math.min(buf.length, Math.floor(0.35 * sr));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[buf.length - n + i] *= Math.cos(((i + 0.5) / n) * Math.PI / 2) ** 2;
    }
  }
  return buf;
}

function loadZone(url, rate, set) {
  const maxSec = /\.wav$/i.test(url) && set.maxSec ? set.maxSec : 0;
  const key = `${rate}|${url}|${maxSec}`;
  if (!decodedCache.has(key)) {
    // sized for 44.1 kHz / 16-bit stereo (176.4 kB/s) + header chunks; a 24-bit file simply yields ~2/3 of maxSec
    const maxBytes = maxSec ? Math.ceil(maxSec * 176400) + 32768 : 0;
    const p = library.fetchBytes(url, maxBytes ? { maxBytes } : undefined)
      .then((bytes) => decode(rate, maxSec ? trimWav(bytes.slice(0), maxSec) : bytes.slice(0)))
      .then((buf) => prepareBuffer(buf, set), () => null);
    decodedCache.set(key, p);
    p.then((b) => { if (!b) decodedCache.delete(key); });
  }
  return decodedCache.get(key);
}

const peakOf = (buf) => {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 3) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > pk) pk = v; }
  }
  return pk;
};

/**
 * Fetch + decode the zones of a set needed for `range` ([lo, hi] MIDI). Resolves a zone bank:
 * { kind:'multisample', id, set, notes, layers, get(note, layer, rr) -> AudioBuffer[], gain[layer], release?: Map }.
 * Rejects when fewer than half of the files could be loaded.
 */
export async function loadMultisampleBank(id, { sampleRate = 44100, range = null, onProgress } = {}) {
  const set = MS_SETS[id];
  if (!set) throw new Error(`Unknown multisample set "${id}"`);
  const notes = new Set(notesForRange(set, range));
  const zones = set.zones.filter((z) => notes.has(z[0]));
  let done = 0;
  const results = await Promise.all(zones.map((z) => loadZone(msUrl(z[2]), sampleRate, set).then((buf) => {
    done++;
    onProgress?.(done / zones.length);
    return buf ? { note: z[0], layer: z[1], buf } : null;
  })));
  const ok = results.filter(Boolean);
  if (ok.length < Math.max(1, zones.length * 0.5)) throw new Error(`Could not load the ${set.name} samples (${ok.length}/${zones.length} files).`);
  const map = new Map();
  for (const r of ok) {
    const k = `${r.note}|${r.layer}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r.buf);
  }
  // per-layer level match: every layer's loudest file -> 0.7 (the velocity curve sets the dynamics, the layer the timbre)
  const layers = set.layers || 1;
  const gain = [];
  for (let l = 0; l < layers; l++) {
    const pk = Math.max(0, ...ok.filter((r) => r.layer === l).map((r) => peakOf(r.buf)));
    gain.push(pk > 0 ? Math.min(12, 0.7 / pk) : 1);
  }
  let release = null;
  if (set.releaseSamples) {
    const rs = set.releaseSamples;
    release = new Map();
    const want = [...new Set([...notes].flatMap((n) => [n, n + 1, n + 2, n - 1]))].filter((n) => n >= rs.from && n <= rs.to);
    await Promise.all(want.map((n) => loadZone(msUrl(rs.file.replace('{n}', String(n + rs.offset))), sampleRate, { kind: 'decay' })
      .then((b) => { if (b) release.set(n, b); })));
  }
  const loaded = [...new Set(ok.map((r) => r.note))].sort((a, b) => a - b);
  return {
    kind: 'multisample', id, set, notes: loaded, layers, gain, release, releaseGain: set.releaseSamples?.gain || 0,
    attack: set.attack || 0.002, releaseTime: set.release ?? 0.3, sustain: set.kind === 'sustain',
    files: ok.length, requested: zones.length,
    get(note, layer) {
      for (let d = 0; d < layers; d++) {
        for (const l of [layer - d, layer + d]) { const b = map.get(`${note}|${l}`); if (b) return { bufs: b, layer: l }; }
      }
      return null;
    },
  };
}

/** Wrap a midi-js soundfont bank ({midis, buffers, norm}) as a single-layer zone bank. */
export function zoneBankFromSoundfont(bank) {
  const idx = new Map(bank.midis.map((m, i) => [m, i]));
  const notes = [...bank.midis].sort((a, b) => a - b);
  return {
    kind: 'soundfont', notes, layers: 1, gain: [bank.norm || 1], release: null, releaseGain: 0, attack: 0.002, releaseTime: 0.4, sustain: false,
    name: bank.name,
    get(note) { const i = idx.get(note); return i == null ? null : { bufs: [bank.buffers[i]], layer: 0 }; },
  };
}

// ------------------------------------------------------------------------------------- playback
/**
 * Start one voice of a zone bank. engine: {ctx, out (GainNode), voices[], p (params), rr (Map)}.
 * extra: { glideFrom (midi), glideTime (s), bend: {to: semitones, at: s, time: s}, vib: {depth: semitones, rate: Hz, delay: s} }.
 * Returns the voice {pitch, src, g, start, done, released, bank} (registered in engine.voices).
 */
export function playSampleVoice(engine, bank, pitch, vel, time, extra = {}) {
  const ctx = engine.ctx, p = engine.p || {};
  const t = Math.max(time ?? ctx.currentTime, ctx.currentTime);
  const note = pitch + Number(p.tune || 0);
  const i = nearestNote(bank.notes, note);
  if (i < 0) return null;
  const v = clamp(Number(vel ?? 0.8), 0, 1);
  const want = layerForVelocity(v, bank.layers);
  const z = bank.get(bank.notes[i], want);
  if (!z) return null;
  const key = `${bank.notes[i]}|${z.layer}`;
  const rr = engine.rr || (engine.rr = new Map());
  const k = rr.get(key) || 0;
  rr.set(key, k + 1);
  const buf = z.bufs[k % z.bufs.length];
  const cents = (note - bank.notes[i]) * 100 + Number(p.fine || 0);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.detune.value = cents;
  if (buf._loop && bank.sustain && p.loop !== false) {
    src.loop = true; src.loopStart = buf._loop.start; src.loopEnd = buf._loop.end;
  }
  // pitch expression: slide in from glideFrom, bend at a time, delayed vibrato
  if (extra.glideFrom != null && isFinite(extra.glideFrom)) {
    const from = (Number(extra.glideFrom) - pitch) * 100;
    const gt = clamp(Number(extra.glideTime) || 0.07, 0.01, 1);
    src.detune.setValueAtTime(cents + from, t);
    src.detune.setTargetAtTime(cents, t, gt / 3);
  }
  if (extra.bend && isFinite(extra.bend.to)) {
    const at = t + Math.max(0, Number(extra.bend.at) || 0);
    const bt = clamp(Number(extra.bend.time) || 0.12, 0.01, 2);
    src.detune.setTargetAtTime(cents + Number(extra.bend.to) * 100, at, bt / 3);
  }
  let vibOsc = null;
  if (extra.vib && Number(extra.vib.depth) > 0) {
    vibOsc = ctx.createOscillator();
    vibOsc.frequency.value = clamp(Number(extra.vib.rate) || 5.5, 0.5, 12);
    const vg = ctx.createGain();
    const d0 = t + Math.max(0, Number(extra.vib.delay) || 0.25);
    vg.gain.setValueAtTime(0, t);
    vg.gain.setValueAtTime(0, d0);
    vg.gain.linearRampToValueAtTime(clamp(Number(extra.vib.depth), 0, 1) * 100, d0 + 0.35);
    vibOsc.connect(vg); vg.connect(src.detune);
    vibOsc.start(t);
  }
  // velocity -> brightness (a single-layer bank leans on the filter, a multi-layer one only adds a touch)
  let node = src;
  const bright = clamp(Number(p.brightness ?? 1), 0, 2);
  const span = (bank.layers > 1 ? 1.2 : 2.6) * bright;
  const fc = 18000 * Math.pow(2, -(1 - v) * span) * Math.pow(2, clamp((pitch - 60) / 48, -0.5, 0.6));
  let filt = null;
  if (fc < 16000) {
    filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.Q.value = 0.5;
    filt.frequency.value = clamp(fc, 400, ctx.sampleRate / 2 - 100);
    src.connect(filt); node = filt;
  }
  const g = ctx.createGain();
  const vs = clamp(Number(p.velSens ?? 0.7), 0, 1);
  const amp = ((1 - vs) + vs * v * v) * (bank.gain[z.layer] || 1);
  const att = Math.max(0.001, Number(p.attack ?? bank.attack ?? 0.002));
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + att);
  node.connect(g);
  g.connect(engine.out);
  src.start(t);
  const voice = { pitch, src, g, filt, vibOsc, start: t, done: false, released: false, bank, vel: v, note: bank.notes[i], cents };
  src.onended = () => {
    voice.done = true;
    try { g.disconnect(); } catch { /* */ }
    try { vibOsc?.stop(); } catch { /* */ }
    const j = engine.voices.indexOf(voice);
    if (j >= 0) engine.voices.splice(j, 1);
  };
  engine.voices.push(voice);
  return voice;
}

/** Release a voice (envelope tail) and trigger the bank's release sample, if any. */
export function releaseSampleVoice(engine, voice, time, fast = 0) {
  if (!voice || voice.released || voice.done) return;
  const ctx = engine.ctx;
  voice.released = true;
  const t = Math.max(time ?? ctx.currentTime, voice.start);
  const rel = fast || Math.max(0.01, Number(engine.p?.release ?? voice.bank?.releaseTime ?? 0.3));
  const gp = voice.g.gain;
  try {
    if (gp.cancelAndHoldAtTime) gp.cancelAndHoldAtTime(t);
    else gp.cancelScheduledValues(t);
    gp.setTargetAtTime(0, t, rel / 5);
    voice.src.stop(t + rel + 0.05);
    voice.vibOsc?.stop(t + rel + 0.05);
  } catch { /* already stopped */ }
  // damper / key-up noise (Salamander): quiet, scaled by velocity and by how long the note sounded
  const bank = voice.bank;
  if (!fast && bank?.release?.size && bank.releaseGain > 0) {
    const rb = bank.release.get(voice.pitch) || bank.release.get(voice.note);
    if (rb) {
      const s = ctx.createBufferSource();
      s.buffer = rb;
      const g = ctx.createGain();
      const held = Math.min(1, (t - voice.start) / 0.6);
      g.gain.value = bank.releaseGain * (0.4 + 0.6 * voice.vel) * (0.3 + 0.7 * held) * (bank.gain[bank.layers - 1] || 1);
      s.connect(g); g.connect(engine.out);
      s.start(t);
      s.onended = () => { try { g.disconnect(); } catch { /* */ } };
    }
  }
}
