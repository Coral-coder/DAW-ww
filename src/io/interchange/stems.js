// Stems + MIDI delivery bundle ("Export for mixing engineer") and per-track renders for DAWproject.
//
//   stemVariant(project, trackId, {tap}) -> project copy where only that track sounds (pure)
//       tap 'post-fader'  : fader, pan, mute/volume/pan/send automation and sends (incl. the returns' effects)
//       tap 'post-insert' : after the insert effects, before the fader — unity gain, centre, no sends
//       Both are pre-master: master effects bypassed, master volume 1, no master automation.
//   stemRenderPlan(project) -> { mode, startBeat:0, endBeat, tracks:[track] } (tracks that get a stem)
//   await renderStems(project, {tap, render, tail, onProgress, trackIds}) -> [{track, buffer}]
//       `render(variantProject, {mode, startBeat, endBeat, tail})` -> AudioBuffer — the existing offline
//       render path (src/audio/render.js renderOffline), injected so this module stays Node-safe.
//   buildMixBundle(project, {stems:[{track, wav, …}], …}) -> [{name, data, compress}] (ZIP entries, pure)
//   tempoMapText(project), readmeText(project, info)
import { beatsPerBar, songLengthBeats } from '../../core/model.js';
import { keySourcesFor } from '../../core/patch.js';
import { pitchClassName, keySignature } from '../../theory/index.js';
import { exportMidi } from '../midi.js';
import { safeName, uniqueNamer } from './media.js';

const MIXER_LANE = /^(volume|pan|mute|send:)/;

export function stemVariant(project, trackId, { tap = 'post-fader' } = {}) {
  const keyOnly = keySourcesFor(project, trackId);
  const pre = tap === 'post-insert';
  return {
    ...project,
    master: { ...project.master, volume: 1, fx: [], automation: [] },
    tracks: project.tracks.map((t) => {
      if (t.id === trackId) {
        if (!pre) return { ...t, mute: false, solo: false };
        return { ...t, mute: false, solo: false, volume: 1, pan: 0, sends: {}, automation: (t.automation || []).filter((l) => !MIXER_LANE.test(String(l.target))) };
      }
      // ducker keys keep playing silently (pre-fader key tap) so the stem keeps its sidechain movement
      if (keyOnly.has(t.id) && !t.mute) return { ...t, solo: false, volume: 0, sends: {}, automation: (t.automation || []).filter((l) => !MIXER_LANE.test(String(l.target))) };
      return { ...t, mute: true, solo: false, automation: (t.automation || []).filter((l) => l.target !== 'mute') };
    }),
  };
}

/** Render range + the tracks that get a stem (unmuted tracks with something to play). */
export function stemRenderPlan(project, { trackIds = null } = {}) {
  const bpb = beatsPerBar(project);
  const song = project.clips?.length > 0;
  let endBeat;
  if (song) endBeat = songLengthBeats(project);
  else {
    const lens = project.tracks.map((t) => project.patterns[t.activePatternId]?.length || 0);
    endBeat = Math.max(bpb * 4, Math.ceil(Math.max(bpb, ...lens) / bpb - 1e-9) * bpb);
  }
  const hasContent = (t) => {
    if (t.type === 'code') return !!String(t.code || '').trim();
    if (song) return project.clips.some((c) => c.trackId === t.id);
    return t.type === 'instrument' && (project.patterns[t.activePatternId]?.notes?.length || 0) > 0;
  };
  const tracks = project.tracks.filter((t) => (trackIds ? trackIds.includes(t.id) : !t.mute && hasContent(t)));
  return { mode: song ? 'song' : 'pattern', startBeat: 0, endBeat, tracks };
}

/** Renders one stem per planned track (sequentially — offline renders are memory hungry). */
export async function renderStems(project, { tap = 'post-fader', render, tail = 2, onProgress, trackIds } = {}) {
  if (typeof render !== 'function') throw new Error('renderStems needs a render function');
  const plan = stemRenderPlan(project, { trackIds });
  const out = [];
  for (let i = 0; i < plan.tracks.length; i++) {
    const track = plan.tracks[i];
    onProgress?.(i, plan.tracks.length, track);
    const buffer = await render(stemVariant(project, track.id, { tap }), { mode: plan.mode, startBeat: 0, endBeat: plan.endBeat, tail });
    out.push({ track, buffer });
  }
  onProgress?.(plan.tracks.length, plan.tracks.length, null);
  return out;
}

const fmtTime = (sec) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const barBeat = (beat, bpb) => `${Math.floor(beat / bpb + 1e-9) + 1}.${(Math.floor((beat % bpb) + 1e-9) + 1)}`;

/** Human-readable tempo map: tempo / meter (incl. project.tempoAutomation if present) and markers. */
export function tempoMapText(project) {
  const bpb = beatsPerBar(project);
  const spb = 60 / project.bpm;
  const [num, den] = project.timeSig || [4, 4];
  const lines = ['TEMPO MAP', '', 'Position (bar.beat)\tBeat\tTime\tEvent'];
  lines.push(`1.1\t0\t${fmtTime(0)}\tTempo ${project.bpm} BPM, meter ${num}/${den}`);
  for (const p of project.tempoAutomation || []) if (p.beat > 0) lines.push(`${barBeat(p.beat, bpb)}\t${p.beat}\t${fmtTime(p.beat * spb)}\tTempo ${p.bpm} BPM (${p.interpolation === 'hold' ? 'step' : 'ramp'}; not played back by daW³)`);
  for (const p of project.timeSigAutomation || []) if (p.beat > 0) lines.push(`${barBeat(p.beat, bpb)}\t${p.beat}\t${fmtTime(p.beat * spb)}\tMeter ${p.num}/${p.den}`);
  for (const m of [...(project.markers || [])].sort((a, b) => a.beat - b.beat)) lines.push(`${barBeat(m.beat, bpb)}\t${m.beat}\t${fmtTime(m.beat * spb)}\tMarker "${m.name}"`);
  lines.push('', 'The tempo is constant unless listed above. The MIDI file carries the same tempo, meter and markers.');
  return lines.join('\n') + '\n';
}

export function keyText(project) {
  const k = project.key || { root: 0, scale: 'minor' };
  let flats = false;
  try { flats = keySignature(k.root, k.scale) < 0; } catch { /* default sharps */ }
  return `${pitchClassName(k.root, flats)} ${k.scale}`;
}

export function readmeText(project, { sampleRate, bitDepth, tap, lengthSec, stems, midiName, endBeat }) {
  const [num, den] = project.timeSig || [4, 4];
  const bpb = beatsPerBar(project);
  const tapText = tap === 'post-insert'
    ? 'post-insert, pre-fader (insert effects printed; fader, pan, sends and master processing NOT printed)'
    : 'post-fader, pre-master (insert effects, fader, pan, automation and send effects printed; master processing NOT printed)';
  return [
    `${project.name || 'Untitled'} — stems for mixing`,
    '='.repeat(48),
    '',
    `Tempo:        ${project.bpm} BPM${project.tempoAutomation?.length > 1 ? ' (has tempo changes — see Tempo map.txt)' : ''}`,
    `Meter:        ${num}/${den}`,
    `Key:          ${keyText(project)}`,
    `Sample rate:  ${sampleRate} Hz`,
    `Bit depth:    ${bitDepth === 32 ? '32-bit float' : `${bitDepth}-bit integer PCM (no dither)`}`,
    `Length:       ${fmtTime(lengthSec)} (${Math.round(endBeat / bpb)} bars + tail), every stem has exactly the same length`,
    `Stems:        ${tapText}`,
    '',
    'All stems start at bar 1 (0:00.000) — line them up at the session start and they are in sync.',
    'Summing all stems (plus the effect returns when post-insert) reproduces the mix before the master bus.',
    '',
    'Files',
    '-----',
    ...stems.map((s) => `Stems/${s.file}  —  ${s.track.name}${s.track.type === 'audio' ? ' (audio)' : s.track.type === 'code' ? ' (code)' : ` (${s.track.instrument?.type || 'instrument'})`}${s.track.mute ? ' [muted in the session]' : ''}`),
    midiName ? `MIDI/${midiName}  —  all note parts (Standard MIDI File, type 1, tempo/meter/markers)` : null,
    'Tempo map.txt  —  tempo, meter and markers',
    '',
    `Exported from daW³ on ${new Date().toISOString().slice(0, 10)}.`,
    '',
  ].filter((l) => l !== null).join('\n');
}

/**
 * ZIP entries of the delivery bundle.
 * stems: [{track, wav: Uint8Array|ArrayBuffer}] in track order; info: {sampleRate, bitDepth, tap, lengthSec, endBeat}
 */
export function buildMixBundle(project, { stems, sampleRate = 44100, bitDepth = 24, tap = 'post-fader', lengthSec = 0, endBeat = songLengthBeats(project), includeMidi = true }) {
  const folder = safeName(project.name, 'Mix');
  const namer = uniqueNamer();
  const pad = String(stems.length).length < 2 ? 2 : String(stems.length).length;
  const named = stems.map((s, i) => ({ ...s, file: namer(`${String(i + 1).padStart(pad, '0')} ${safeName(s.track.name, 'Track')}`, 'wav') }));
  const entries = named.map((s) => ({ name: `${folder}/Stems/${s.file}`, data: s.wav, compress: false }));
  let midiName = null;
  if (includeMidi) {
    const midi = exportMidi(project, { mode: project.clips?.length ? 'song' : 'pattern' });
    midiName = `${folder}.mid`;
    entries.push({ name: `${folder}/MIDI/${midiName}`, data: midi, compress: true });
  }
  entries.push({ name: `${folder}/Tempo map.txt`, data: tempoMapText(project) });
  entries.unshift({ name: `${folder}/README.txt`, data: readmeText(project, { sampleRate, bitDepth, tap, lengthSec, stems: named, midiName, endBeat }) });
  return entries;
}
