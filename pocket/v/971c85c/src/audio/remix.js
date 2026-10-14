// Remix helpers: turn a region of an analysed track into project samples — warped to the project
// tempo (optionally pitch-kept / key-shifted) and cut into slices for drum pads, a chromatic sampler,
// arrangement clips or a Setlist layer. Pure (no DOM / AudioContext) so it is Node-testable.
import { DRUM_PADS } from '../core/model.js';
import { uid } from '../core/util.js';
import { encodeWav } from '../io/wav.js';
import { arrayBufferToBase64 } from '../io/samples.js';
import { extractRegion, sliceGrid, sliceTransients, warp, keyShiftToward, beatIndexAt } from './analysis/index.js';

const MINOR_SCALES = ['minor', 'aeolian', 'dorian', 'phrygian', 'harmonicMinor', 'harmonic-minor', 'melodicMinor', 'melodic-minor', 'minorPentatonic', 'minor-pentatonic', 'blues', 'locrian'];
/** daW³ project key ({root, scale}) -> { tonic, mode } */
export function projectKeyOf(project) {
  const k = project?.key || {};
  const scale = String(k.scale || 'major');
  return { tonic: ((Number(k.root) || 0) % 12 + 12) % 12, mode: MINOR_SCALES.includes(scale) || /minor/i.test(scale) ? 'minor' : 'major' };
}

/**
 * Slices of [region.start, region.end) — mode: 'beat' | 'half' | 'bar' | 'transient'.
 * Returned times are in source-track seconds; `beat` = offset from the region start in beats.
 */
export function planSlices(analysis, region, mode = 'beat', { max = 16 } = {}) {
  const grid = analysis.grid;
  let slices;
  if (mode === 'transient') slices = sliceTransients(analysis.transients || [], { start: region.start, end: region.end, grid, max });
  else {
    const unit = mode === 'bar' ? 'bar' : 'beat';
    const size = mode === 'half' ? 0.5 : 1;
    slices = sliceGrid(grid, { start: region.start, end: region.end, unit, size, duration: analysis.duration, max });
  }
  const b0 = beatIndexAt(grid, region.start);
  return slices.map((s, i) => ({ ...s, index: i, beat: beatIndexAt(grid, s.start) - b0, beats: (s.end - s.start) * grid.bpm / 60 }));
}

/**
 * Render a region warped to the project: returns { channels, sampleRate, semitones, ratio }.
 * ratio = output seconds per source second.
 */
export function renderRegion(audio, analysis, region, { projectBpm, keepPitch = true, matchKey = false, projectKey = null, warpTempo = true } = {}) {
  const sr = audio.sampleRate;
  const raw = extractRegion(audio.channels, sr, region.start, region.end, { fadeMs: 2 });
  const srcBpm = analysis.grid.bpm;
  const dstBpm = warpTempo && projectBpm ? projectBpm : srcBpm;
  const semitones = matchKey && projectKey && analysis.key ? keyShiftToward(analysis.key, projectKey).semitones : 0;
  const channels = warp(raw, { srcBpm, dstBpm, keepPitch, semitones, sr });
  return { channels, sampleRate: sr, semitones, ratio: srcBpm / dstBpm };
}

/** Cut rendered audio into slices (times relative to the region, scaled by ratio). */
export function cutRendered(rendered, slices, regionStart) {
  const { channels, sampleRate, ratio } = rendered;
  return slices.map((s) => extractRegion(channels, sampleRate, (s.start - regionStart) * ratio, (s.end - regionStart) * ratio, { fadeMs: 2 }));
}

/** Float32Array channels -> daW³ project sample (16-bit WAV, base64). */
export function channelsToSample(channels, sampleRate, name) {
  const buf = { numberOfChannels: channels.length, sampleRate, length: channels[0].length, getChannelData: (i) => channels[i] };
  return { id: uid('smp'), name, mime: 'audio/wav', data: arrayBufferToBase64(encodeWav(buf, { bitDepth: 16 })), duration: channels[0].length / sampleRate };
}

/** Notes that replay the slices in their original order on drum pads (first 16 pads) or a chromatic sampler (root up). */
export function slicePatternNotes(slices, { target = 'drums', rootNote = 60 } = {}) {
  return slices.map((s, i) => ({
    pitch: target === 'drums' ? DRUM_PADS[i % DRUM_PADS.length].pitch : rootNote + i,
    start: Math.round(s.beat * 1000) / 1000,
    dur: Math.max(0.05, Math.round(s.beats * 1000) / 1000 - 0.01),
    vel: 0.9,
  }));
}

export const padKeyForSlice = (i) => DRUM_PADS[i % DRUM_PADS.length].key;
