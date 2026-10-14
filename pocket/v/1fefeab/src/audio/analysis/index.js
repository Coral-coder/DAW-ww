// Track analysis entry point: one call returns everything the Decks / Library view shows.
// Pure (Float32Array channels + sample rate) so it runs in Node tests, a Web Worker or the main thread.
import { toMono } from './dsp.js';
import { onsetEnvelope, detectTransients } from './onset.js';
import { detectTempo, makeGrid } from './tempo.js';
import { chromagram, detectKey } from './key.js';
import { integratedLoudness, energyCurve, waveformPeaks } from './loudness.js';
import { detectSections } from './sections.js';

export * from './dsp.js';
export * from './onset.js';
export * from './tempo.js';
export * from './key.js';
export * from './loudness.js';
export * from './sections.js';
export * from './stretch.js';
export * from './slicing.js';
export * from './dj.js';

/**
 * @param {Float32Array[]} channels
 * @param {number} sr
 * @returns {object} JSON-safe analysis { version, duration, sampleRate, bpm, grid, key, camelot, keyName,
 *   lufs, energy[], peaks[], sections[], transients[], confidence }
 */
export function analyzeTrack(channels, sr, { minBpm = 70, maxBpm = 180, onProgress } = {}) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const mono = toMono(chs);
  const duration = mono.length / sr;
  const step = (p) => { try { onProgress?.(p); } catch { /* */ } };
  const onset = onsetEnvelope(mono, sr);
  step(0.3);
  const tempo = detectTempo(onset, { minBpm, maxBpm });
  const grid = makeGrid(tempo.bpm, tempo.downbeat);
  step(0.5);
  const chroma = chromagram(mono, sr);
  const key = detectKey(null, sr, chroma);
  step(0.75);
  const lufs = integratedLoudness(chs.slice(0, 2), sr);
  const sections = detectSections({ grid, duration, chroma });
  const transients = detectTransients(onset.env, onset.fps, { sensitivity: 0.5 });
  step(1);
  return {
    version: 1,
    duration,
    sampleRate: sr,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    bpmAlternatives: tempo.alternatives,
    grid,
    key: { tonic: key.tonic, mode: key.mode },
    keyName: key.name,
    camelot: key.camelot,
    keyConfidence: key.confidence,
    lufs: Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : null,
    energy: Array.from(energyCurve(mono, sr, 2), (v) => Math.round(v * 1000) / 1000),
    peaks: Array.from(waveformPeaks(mono, 600), (v) => Math.round(v * 1000) / 1000),
    sections,
    transients: transients.map((t) => Math.round(t * 1000) / 1000),
  };
}
