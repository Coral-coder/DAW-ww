// Track freeze / bounce-in-place / flatten — the audio side (browser: OfflineAudioContext). Pure helpers and the
// data model are in src/core/freeze.js. The AudioEngine exposes these as engine.freezeTrack / unfreezeTrack /
// bounceTrack / flattenTrack (they edit the project through the engine's store, one undo step each).
import { renderOffline } from './render.js';
import { defaultEndBeat } from './scheduler.js';
import { encodeWav } from '../io/wav.js';
import { arrayBufferToBase64 } from '../io/samples.js';
import { createTrack, createClip, beatsPerBar } from '../core/model.js';
import { uid } from '../core/util.js';
import { freezeVariant, FREEZE_MODES, sampleInUse, isFrozen, tempoSignature } from '../core/freeze.js';
import { songTempoMap } from '../time/tempo-map.js';

/** Beats a song-mode freeze must cover: the arrangement (code tracks: at least the loop region / 8 bars). */
export function freezeSongEnd(project, track) {
  let end = defaultEndBeat(project, 'song');
  if (track?.type === 'code') {
    const bpb = beatsPerBar(project);
    const hasClips = project.clips.length > 0;
    end = Math.max(end, hasClips ? 0 : 8 * bpb, project.loop?.enabled ? project.loop.end : 0);
  }
  return end;
}

/** Loop period (beats) of a pattern-mode freeze: the track's active pattern (code tracks: 4 bars). */
export function freezePatternLoop(project, track) {
  if (track.type === 'instrument') {
    const pat = project.patterns[track.activePatternId];
    return pat?.length > 0 ? pat.length : beatsPerBar(project);
  }
  return 4 * beatsPerBar(project);
}

/**
 * Render one track as audio.
 * opts: { mode: 'preFx'|'postFx'|'postFader', renderMode: 'song'|'pattern' (default project.mode), sampleRate,
 *         sampleCache, onError, onNotice, tail = 2 (s, song mode) }
 * -> { buffer: AudioBuffer, info: { renderMode, start, length, loop? } }
 *   song: the arrangement from beat 0 plus the tail; pattern: exactly one seamless loop cycle (rendered twice,
 *   second cycle kept, so tails wrap around like they do live).
 */
export async function renderTrack(project, trackId, opts = {}) {
  const mode = FREEZE_MODES.includes(opts.mode) ? opts.mode : 'postFx';
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error('Track not found');
  const renderMode = opts.renderMode || project.mode || 'song';
  if (renderMode === 'pattern' && track.type === 'audio') throw new Error('Audio tracks only play in song mode — switch to song mode to freeze or bounce them.');
  const variant = { ...freezeVariant(project, trackId, mode), mode: renderMode };
  const spb = 60 / project.bpm;
  const sampleRate = opts.sampleRate || 44100;
  const common = { sampleRate, sampleCache: opts.sampleCache, onError: opts.onError, onNotice: opts.onNotice, mode: renderMode };
  if (renderMode === 'pattern') {
    const L = freezePatternLoop(project, track);
    const buf = await renderOffline(variant, { ...common, startBeat: 0, endBeat: 2 * L, tail: 0 });
    const from = Math.round(L * spb * sampleRate);
    const len = Math.max(1, Math.min(buf.length - from, Math.round(L * spb * sampleRate)));
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: len, sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(from, from + len));
    return { buffer: out, info: { renderMode, start: 0, length: L, loop: L } };
  }
  const end = freezeSongEnd(project, track);
  const tail = opts.tail ?? 2;
  const buffer = await renderOffline(variant, { ...common, startBeat: 0, endBeat: end, tail });
  // length in beats through the tempo map (ramps / changes after the arrangement end extrapolate the last tempo)
  return { buffer, info: { renderMode, start: 0, length: songTempoMap(project).beatAt(buffer.length / sampleRate) } };
}

/**
 * AudioBuffer -> project sample (24-bit WAV, TPDF dither, peak-normalised so nothing above 0 dBFS is lost)
 * + the playback gain that restores the original level. Also returns the normalised AudioBuffer (for caches).
 */
export function bufferToSample(buffer, name, { bitDepth = 24, frozen = false } = {}) {
  let peak = 0;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    chans.push(d);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  const gain = peak > 0.999 ? peak / 0.999 : 1;
  const scaled = gain === 1 ? chans : chans.map((d) => { const o = new Float32Array(d.length); for (let i = 0; i < d.length; i++) o[i] = d[i] / gain; return o; });
  const wav = encodeWav({ channels: scaled, sampleRate: buffer.sampleRate }, { bitDepth, dither: bitDepth < 32 ? 'tpdf' : 'none' });
  const sample = {
    id: uid('smp'), name, mime: 'audio/wav', data: arrayBufferToBase64(wav),
    duration: buffer.length / buffer.sampleRate, sampleRate: buffer.sampleRate, ...(frozen ? { frozen: true } : {}),
  };
  let normalized = buffer;
  if (gain !== 1 && typeof AudioBuffer === 'function') {
    normalized = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
    scaled.forEach((d, c) => normalized.getChannelData(c).set(d));
  }
  return { sample, gain, normalized };
}

const renderOpts = (engine) => ({
  sampleRate: engine.ctx?.sampleRate || 44100,
  sampleCache: engine.buffers,
  onError: (e) => engine._error?.(e),
});

/** engine.freezeTrack(trackId, {mode = 'postFx'}) — see core/freeze.js for the model. Resolves to track.frozen. */
export async function freezeTrack(engine, trackId, { mode = 'postFx' } = {}) {
  const project = engine.store.get();
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error('Track not found');
  const { buffer, info } = await renderTrack(project, trackId, { ...renderOpts(engine), mode });
  const { sample, gain, normalized } = bufferToSample(buffer, `${track.name} (frozen)`, { frozen: true });
  engine.buffers.set(sample.id, normalized);
  let frozen = null;
  engine.store.transact('Freeze track', (p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const old = t.frozen?.sampleId;
    p.samples[sample.id] = sample;
    t.frozen = frozen = { sampleId: sample.id, mode, ...info, gain, bpm: p.bpm, ...(tempoSignature(p) ? { tempo: tempoSignature(p) } : {}), at: new Date().toISOString() };
    if (old && !sampleInUse(p, old, trackId)) delete p.samples[old];
  });
  engine.emit?.('freeze', { trackId, frozen });
  return frozen;
}

/** Back to the live instrument / inserts; the frozen audio is deleted unless something else uses it. */
export function unfreezeTrack(engine, trackId) {
  const t0 = engine.store.get().tracks.find((x) => x.id === trackId);
  if (!isFrozen(t0)) return false;
  engine.store.transact('Unfreeze track', (p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    const sid = t?.frozen?.sampleId;
    if (!t) return;
    delete t.frozen;
    if (sid && !sampleInUse(p, sid, trackId)) delete p.samples[sid];
  });
  engine.emit?.('freeze', { trackId, frozen: null });
  return true;
}

/**
 * Bounce to a new audio track (song mode render from beat 0): mode 'postFader' (default: what you hear, minus
 * sends) or 'postFx' / 'preFx'. The new track sits under the source; `muteSource` (default true) mutes the original.
 * Resolves to the new track id.
 */
export async function bounceTrack(engine, trackId, { mode = 'postFader', muteSource = true } = {}) {
  const project = engine.store.get();
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error('Track not found');
  const { buffer, info } = await renderTrack(project, trackId, { ...renderOpts(engine), mode, renderMode: 'song' });
  const { sample, gain, normalized } = bufferToSample(buffer, `${track.name} (bounce)`);
  engine.buffers.set(sample.id, normalized);
  const nt = createTrack({ type: 'audio', name: `${track.name} (bounce)`, color: track.color, volume: mode === 'postFader' ? 1 : track.volume, pan: mode === 'postFader' ? 0 : track.pan, sends: mode === 'postFader' ? {} : { ...(track.sends || {}) } });
  const clip = createClip(nt.id, { type: 'audio', sampleId: sample.id, start: 0, length: info.length, gain, name: sample.name });
  engine.store.transact('Bounce track', (p) => {
    p.samples[sample.id] = sample;
    const i = p.tracks.findIndex((x) => x.id === trackId);
    p.tracks.splice(i + 1, 0, nt);
    p.clips.push(clip);
    if (muteSource) { const t = p.tracks.find((x) => x.id === trackId); if (t) t.mute = true; }
  });
  return nt.id;
}

/**
 * Flatten: commit the track to audio for good — it becomes an audio track playing one clip of its own render
 * (song mode). mode 'postFx' (default) bakes the inserts in (they are removed); 'preFx' keeps them live;
 * 'postFader' also bakes volume / pan (fader reset to unity). Undo restores the original.
 */
export async function flattenTrack(engine, trackId, { mode = 'postFx' } = {}) {
  const project = engine.store.get();
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error('Track not found');
  const { buffer, info } = await renderTrack(project, trackId, { ...renderOpts(engine), mode, renderMode: 'song' });
  const { sample, gain, normalized } = bufferToSample(buffer, `${track.name} (flattened)`);
  engine.buffers.set(sample.id, normalized);
  engine.store.transact('Flatten track', (p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const oldFrozen = t.frozen?.sampleId;
    p.samples[sample.id] = sample;
    p.clips = p.clips.filter((c) => c.trackId !== trackId);
    for (const id of Object.keys(p.patterns)) if (p.patterns[id].trackId === trackId) delete p.patterns[id];
    for (const s of p.scenes || []) delete s.slots?.[trackId];
    p.clips.push(createClip(trackId, { type: 'audio', sampleId: sample.id, start: 0, length: info.length, gain, name: sample.name }));
    t.type = 'audio';
    t.instrument = null;
    delete t.code; delete t.codeSound; delete t.frozen;
    t.activePatternId = null;
    const baked = (l) => {
      const x = String(l.target);
      if (/^inst:/.test(x)) return true;
      if (mode !== 'preFx' && /^(fx|fxen|cable):/.test(x)) return true;
      return mode === 'postFader' && /^(volume|pan)$/.test(x);
    };
    t.automation = (t.automation || []).filter((l) => !baked(l));
    if (mode !== 'preFx') { t.fx = []; delete t.patch; }
    if (mode === 'postFader') { t.volume = 1; t.pan = 0; }
    if (oldFrozen && !sampleInUse(p, oldFrozen)) delete p.samples[oldFrozen];
  });
  return trackId;
}
