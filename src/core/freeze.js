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
//     tempo?                         // song mode: tempo-map signature (tempoSignature) — editing the tempo map / meters
//                                    //   also makes it play live until refrozen
//   }
//
// The original track (instrument, fx, patterns, clips, code) is kept untouched for unfreeze. Editing a frozen
// track's sound is blocked in the UI (FROZEN_HINT); `frozenMode()` is the single source of truth for whether the
// freeze is in effect right now.
import { keySourcesFor } from './patch.js';

export const FREEZE_MODES = ['preFx', 'postFx', 'postFader'];
export const FROZEN_HINT = 'This track is frozen — unfreeze it (track menu ▸ Unfreeze) to edit its sound.';

/** Tempo-map signature of a project's arrangement ('' without tempo / meter changes) — see time/tempo-map.js. */
export function tempoSignature(project) {
  const t = project?.tempoMap?.length > 1 || project?.tempoMap?.[0]?.curve === 'linear' ? JSON.stringify(project.tempoMap.slice(1).map((p) => [p.beat, p.bpm, p.curve]).concat([[project.tempoMap[0].curve]])) : '';
  const m = project?.meterMap?.length ? JSON.stringify(project.meterMap.map((x) => [x.bar, x.num, x.den])) : '';
  return t || m ? `${t}|${m}` : '';
}

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
  if ((f.renderMode || 'song') === 'song' && (f.tempo ?? '') !== tempoSignature(project)) return null;
  return FREEZE_MODES.includes(f.mode) ? f.mode : 'postFx';
}

/** Why a frozen track currently plays live (null when the freeze is in effect / the track is not frozen). */
export function frozenStaleReason(project, track) {
  if (!isFrozen(track)) return null;
  const f = track.frozen;
  if (project?.samples && !project.samples[f.sampleId]) return 'The frozen audio is missing — unfreeze and freeze again.';
  if ((f.renderMode || 'song') !== (project.mode || 'song')) return `Frozen in ${f.renderMode} mode — plays live in ${project.mode} mode.`;
  if (f.bpm && Math.abs(f.bpm - project.bpm) > 1e-6) return `Frozen at ${f.bpm} BPM — the tempo changed, so it plays live. Freeze again to update.`;
  if ((f.renderMode || 'song') === 'song' && (f.tempo ?? '') !== tempoSignature(project)) return 'The tempo map changed since this track was frozen, so it plays live. Freeze again to update.';
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

// ------------------------------------------------------------------------------------------- edit guard
/** The parts of a frozen track's state that its frozen audio depends on (JSON, deterministic). */
function soundState(project, track) {
  const f = track.frozen;
  const mode = FREEZE_MODES.includes(f.mode) ? f.mode : 'postFx';
  const keepLane = (l) => {
    const t = String(l.target);
    if (/^inst:/.test(t)) return true;
    if (/^(fx|fxen|cable):/.test(t)) return mode !== 'preFx';
    if (/^(volume|pan)$/.test(t)) return mode === 'postFader';
    return false;
  };
  const clips = project.clips.filter((c) => c.trackId === track.id).map((c) => ({ ...c }));
  const patterns = Object.values(project.patterns || {}).filter((p) => p.trackId === track.id);
  return JSON.stringify({
    type: track.type, instrument: track.instrument ?? null, code: track.code ?? null, codeSound: track.codeSound ?? null,
    fx: mode === 'preFx' ? null : (track.fx || []), patch: mode === 'preFx' ? null : (track.patch ?? null),
    volume: mode === 'postFader' ? track.volume : null, pan: mode === 'postFader' ? track.pan : null,
    active: f.renderMode === 'pattern' ? track.activePatternId : null,
    lanes: (track.automation || []).filter(keepLane), clips, patterns,
    takes: track.takeLanes ?? null, comp: track.comp ?? null, compXfade: track.compXfade ?? null, // src/record comps
  });
}

/**
 * Store guard (see Store.addGuard) that blocks edits to the sound of frozen tracks: any transaction that changes
 * what a frozen track's audio was rendered from is rolled back for that track and reported with FROZEN_HINT.
 * Renaming, recolouring, mute / solo, sends, the fader (unless frozen post-fader), deleting the track, changing the
 * tempo (the freeze goes stale and the track plays live) and unfreezing stay possible.
 */
export function createFreezeGuard() {
  return {
    capture(project) {
      const out = [];
      for (const t of project.tracks) {
        if (!isFrozen(t)) continue;
        out.push({
          id: t.id, sampleId: t.frozen.sampleId, sig: soundState(project, t),
          track: JSON.parse(JSON.stringify(t)),
          clips: project.clips.filter((c) => c.trackId === t.id).map((c) => JSON.parse(JSON.stringify(c))),
          patterns: Object.values(project.patterns || {}).filter((p) => p.trackId === t.id).map((p) => JSON.parse(JSON.stringify(p))),
        });
      }
      return out;
    },
    /** -> { message, trackIds } when a frozen track's sound was edited, else null. */
    check(before, project) {
      const bad = [];
      for (const b of before) {
        const t = project.tracks.find((x) => x.id === b.id);
        if (!t || !isFrozen(t) || t.frozen.sampleId !== b.sampleId) continue; // deleted / unfrozen / refrozen
        if (soundState(project, t) !== b.sig) bad.push(b);
      }
      return bad.length ? { message: FROZEN_HINT, trackIds: bad.map((b) => b.id), entries: bad } : null;
    },
    restore(violation, project) {
      for (const b of violation.entries) {
        const i = project.tracks.findIndex((x) => x.id === b.id);
        if (i < 0) continue;
        const keep = project.tracks[i];
        // put the sound back, keep the harmless edits made in the same transaction (name, colour, mute…)
        project.tracks[i] = { ...b.track, name: keep.name, color: keep.color, mute: keep.mute, solo: keep.solo, arm: keep.arm, sends: keep.sends, ...(keep.frozen?.mode === 'postFader' ? {} : { volume: keep.volume, pan: keep.pan }) };
        const nonLane = (l) => !/^(inst|fx|fxen|cable):/.test(String(l.target)) && !(b.track.frozen.mode === 'postFader' && /^(volume|pan)$/.test(String(l.target)));
        project.tracks[i].automation = [...(b.track.automation || []).filter((l) => !nonLane(l)), ...(keep.automation || []).filter(nonLane)];
        project.clips = [...project.clips.filter((c) => c.trackId !== b.id), ...b.clips];
        for (const id of Object.keys(project.patterns)) if (project.patterns[id].trackId === b.id) delete project.patterns[id];
        for (const p of b.patterns) project.patterns[p.id] = p;
      }
    },
  };
}
