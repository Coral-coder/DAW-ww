// Track freeze / bounce — pure helpers (Node-testable). The audio side lives in src/audio/freeze.js.
//
// A frozen track plays a rendered audio file instead of its instrument / code / clips (and, depending on the
// mode, its inserts and fader), so its instrument and insert effects are not instantiated at all:
//
//   track.frozen = {
//     sampleId,                      // project sample holding the render (24-bit WAV, flagged sample.frozen)
//     mode: 'preFx' | 'postFx' | 'postFader',
//                                    //   preFx:     instrument / clips only — inserts, fader, sends stay live
//                                    //   postFx:    + insert effects (default) — fader, pan, sends stay live
//                                    //   postFader: + volume / pan (+ their automation) — the fader is bypassed;
//                                    //              post-fader sends still work (they tap the frozen signal)
//     renderMode: 'song' | 'pattern',// transport mode the render covers; in the other mode the track plays live
//     start: 0, length,              // song: beats covered by the render (arrangement + reverb tail)
//     loop,                          // pattern: loop period in beats (the render is one seamless cycle)
//     gain,                          // playback gain (renders are peak-normalised before 24-bit encoding)
//     bpm, at                        // tempo at freeze time (a tempo change makes the track play live again), ISO time
//   }
//
// The original track (instrument, fx, patterns, clips, code) is kept untouched for unfreeze. Editing a frozen
// track's sound is blocked in the UI (FROZEN_HINT); `frozenMode()` is the single source of truth for whether the
// freeze is in effect right now.
import { keySourcesFor } from './patch.js';

export const FREEZE_MODES = ['preFx', 'postFx', 'postFader'];
export const FROZEN_HINT = 'This track is frozen — unfreeze it (track menu ▸ Unfreeze) to edit its sound.';

export const isFrozen = (track) => !!(track && track.frozen && track.frozen.sampleId);

/**
 * The freeze mode in effect for `track` in transport mode `mode` (default project.mode), or null when the track
 * plays live: not frozen, its sample is missing, it was frozen in the other transport mode, or the tempo changed.
 */
export function frozenMode(project, track, mode = project?.mode) {
  if (!isFrozen(track)) return null;
  const f = track.frozen;
  if (project?.samples && !project.samples[f.sampleId]) return null;
  if ((f.renderMode || 'song') !== (mode || 'song')) return null;
  if (f.bpm && project?.bpm && Math.abs(f.bpm - project.bpm) > 1e-6) return null;
  return FREEZE_MODES.includes(f.mode) ? f.mode : 'postFx';
}

/** Why a frozen track currently plays live (null when the freeze is in effect / the track is not frozen). */
export function frozenStaleReason(project, track) {
  if (!isFrozen(track)) return null;
  const f = track.frozen;
  if (project?.samples && !project.samples[f.sampleId]) return 'The frozen audio is missing — unfreeze and freeze again.';
  if ((f.renderMode || 'song') !== (project.mode || 'song')) return `Frozen in ${f.renderMode} mode — plays live in ${project.mode} mode.`;
  if (f.bpm && Math.abs(f.bpm - project.bpm) > 1e-6) return `Frozen at ${f.bpm} BPM — the tempo changed, so it plays live. Freeze again to update.`;
  return null;
}

const MIXER_LANE = /^(volume|pan|mute|send:)/;
const FADER_LANE = /^(volume|pan)$/;

/**
 * The project to render for freezing / bouncing `trackId` with `mode`. Only the track (and silent copies of the
 * tracks that key a ducker in its inserts) remain; master and buses are neutral, so the render is exactly the
 * track's signal at the freeze point.
 */
export function freezeVariant(project, trackId, mode = 'postFx') {
  const target = project.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`No track ${trackId}`);
  const keyOnly = mode === 'preFx' ? new Set() : keySourcesFor(project, trackId);
  const tracks = [];
  for (const t of project.tracks) {
    if (t.id === trackId) {
      const tt = { ...t, mute: false, solo: false, sends: {}, arm: false };
      delete tt.frozen; // render the live sound
      if (mode === 'preFx') { tt.fx = []; delete tt.patch; }
      if (mode === 'postFader') {
        tt.automation = (t.automation || []).filter((l) => !/^(mute|send:)/.test(String(l.target)));
      } else {
        tt.volume = 1; tt.pan = 0;
        tt.automation = (t.automation || []).filter((l) => !MIXER_LANE.test(String(l.target)));
      }
      tracks.push(tt);
    } else if (keyOnly.has(t.id) && !t.mute) {
      tracks.push({ ...t, solo: false, volume: 0, sends: {}, automation: (t.automation || []).filter((l) => !/^(volume|send:)/.test(String(l.target))) });
    }
  }
  return {
    ...project,
    tracks,
    buses: [],
    master: { ...(project.master || {}), volume: 1, fx: [], automation: [] },
    metronome: false,
  };
}

/** Does `frozen` (in effect) bypass the strip's inserts / fader? */
export const bypassesInserts = (mode) => mode === 'postFx' || mode === 'postFader';
export const bypassesFader = (mode) => mode === 'postFader';
/** Automation lanes a frozen track must not play (they are baked into the audio). */
export function frozenLaneFilter(mode) {
  const sound = /^(inst):/;
  const inserts = /^(inst|fx|fxen|cable):/;
  if (mode === 'postFader') return (l) => !FADER_LANE.test(String(l.target)) && !inserts.test(String(l.target));
  if (mode === 'postFx') return (l) => !inserts.test(String(l.target));
  return (l) => !sound.test(String(l.target));
}

/** The virtual audio clip(s) a frozen track plays in song mode. */
export function frozenClip(track) {
  const f = track.frozen;
  return { id: `frozen:${track.id}`, trackId: track.id, type: 'audio', sampleId: f.sampleId, start: f.start || 0, length: f.length || 0, offset: 0, gain: f.gain ?? 1, frozen: true };
}

/** Is any sample id still referenced by clips, samplers or frozen tracks (other than `exceptTrackId`'s freeze)? */
export function sampleInUse(project, sampleId, exceptTrackId = null) {
  if (project.clips.some((c) => c.sampleId === sampleId)) return true;
  for (const t of project.tracks) {
    if (t.frozen?.sampleId === sampleId && t.id !== exceptTrackId) return true;
    if (JSON.stringify(t.instrument?.params || {}).includes(sampleId)) return true;
  }
  return false;
}
