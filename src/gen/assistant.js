// Production assistant: analyses a project and returns actionable recommendations,
// plus a pure-JSON applier for the suggested actions.
import { createRng, clamp } from '../core/util.js';
import { createNote, createPattern, createTrack, createClip, createEffect, beatsPerBar, songLengthBeats, TRACK_COLORS } from '../core/model.js';
import {
  detectKey, keyName, inScale, snapToScale, isMinorScale, suggestNextChords, analyzeProgression, voiceLead,
  chordPitchClasses, resolveScaleId, stepInScale, SCALES, pitchClassName,
} from '../theory/index.js';
import { getGenre, GENRES } from './genres.js';
import { DRUM_STYLES } from './drums.js';
import { BASS_STYLES } from './bass.js';
import { detectPatternChords, chordsToProgression, progressionFromProject, isDrumTrack } from './analyze.js';
import { generatePartNotes } from './song.js';

const LEVEL_ORDER = { warn: 0, idea: 1, tip: 2 };

function guessRole(t) {
  if (t.role) return t.role;
  if (isDrumTrack(t)) return 'drums';
  const s = `${t.name} ${t.instrument?.preset || ''}`.toLowerCase();
  if (/bass|808|sub/.test(s)) return 'bass';
  if (/pad|string|choir/.test(s)) return 'pad';
  if (/arp/.test(s)) return 'arp';
  if (/lead|melody|bell|flute|whistle/.test(s)) return 'lead';
  if (/fx|riser|sweep|laser/.test(s)) return 'fx';
  return 'chords';
}

const trackPatterns = (p, t) => Object.values(p.patterns || {}).filter((x) => x.trackId === t.id);

/**
 * getRecommendations(project, ctx={selectedTrackId, selectedPatternId, view}) ->
 *   [{id, level:'tip'|'warn'|'idea', title, text, action?:{label, kind, payload}}]
 */
export function getRecommendations(project, ctx = {}) {
  const recs = [];
  if (!project) return recs;
  const add = (r) => { if (!recs.some((x) => x.id === r.id)) recs.push(r); };
  const bpb = beatsPerBar(project);
  const key = { root: project.key?.root ?? 0, scale: resolveScaleId(project.key?.scale || 'minor') };
  const kName = keyName(key.root, key.scale);
  const genre = getGenre(project.genre);
  const tracks = project.tracks || [];
  const live = tracks.filter((t) => !t.mute);
  const instrumentTracks = tracks.filter((t) => t.type === 'instrument');
  const melodicTracks = instrumentTracks.filter((t) => !isDrumTrack(t));

  // ---------------------------------------------------------------- empty project
  if (!tracks.length) {
    add({ id: 'start-drums', level: 'idea', title: 'Start with a beat', text: `Lay down a ${genre ? genre.name + ' ' : ''}drum groove first — everything else locks to it.`, action: { label: 'Generate drums', kind: 'generate-part', payload: { role: 'drums', genre: genre?.id || 'house' } } });
    add({ id: 'start-chords', level: 'idea', title: 'Or start with chords', text: `A chord loop in ${kName} gives you a harmonic bed to write over.`, action: { label: 'Generate chords', kind: 'generate-part', payload: { role: 'chords', genre: genre?.id || 'house' } } });
    if (!genre) add({ id: 'pick-genre', level: 'tip', title: 'Pick a genre', text: 'Choosing a genre tunes the generators, tempo hints and these tips to your style.' });
    return recs;
  }

  // ---------------------------------------------------------------- key detection
  const melodicNotes = melodicTracks.flatMap((t) => trackPatterns(project, t).flatMap((p) => p.notes || []));
  if (melodicNotes.length >= 8 && key.scale !== 'chromatic') {
    const keys = detectKey(melodicNotes);
    const top = keys[0];
    const projMode = isMinorScale(key.scale) ? 'minor' : 'major';
    const mine = keys.find((k) => k.root === key.root && k.scale === projMode);
    if (top && (top.root !== key.root || top.scale !== projMode) && top.score > 0.55 && top.score - (mine?.score ?? -1) > 0.08) {
      add({
        id: `key-mismatch:${top.root}:${top.scale}`, level: 'warn', title: `Your notes sound like ${top.name}`,
        text: `The project is set to ${kName}, but the notes you have written fit ${top.name} better (confidence ${Math.round(top.score * 100)}%). Setting the key makes scale snapping, chord suggestions and generators match your music.`,
        action: { label: `Set key to ${top.name}`, kind: 'set-key', payload: { root: top.root, scale: top.scale } },
      });
    }
  }

  // ---------------------------------------------------------------- selected pattern
  const selTrack = tracks.find((t) => t.id === ctx.selectedTrackId);
  let selPat = ctx.selectedPatternId ? project.patterns?.[ctx.selectedPatternId] : null;
  if (!selPat && selTrack?.activePatternId) selPat = project.patterns?.[selTrack.activePatternId];
  const selPatTrack = selPat ? tracks.find((t) => t.id === selPat.trackId) : null;
  if (selPat && selPatTrack && !isDrumTrack(selPatTrack) && key.scale !== 'chromatic') {
    const notes = selPat.notes || [];
    // short chromatic approach notes that resolve by half step are idiomatic, not mistakes
    const isApproach = (n) => n.dur <= 0.3 && notes.some((m) => m.start > n.start && m.start - n.start <= 0.35 && Math.abs(m.pitch - n.pitch) === 1 && inScale(m.pitch, key.root, key.scale));
    const outside = notes.filter((n) => !inScale(n.pitch, key.root, key.scale) && !isApproach(n));
    if (outside.length) {
      const ratio = outside.length / notes.length;
      add({
        id: `out-of-scale:${selPat.id}`, level: ratio > 0.15 ? 'warn' : 'tip', title: `${outside.length} note${outside.length > 1 ? 's' : ''} outside ${kName}`,
        text: `${outside.slice(0, 6).map((n) => pitchClassName(n.pitch, 'common')).join(', ')}${outside.length > 6 ? '…' : ''} in “${selPat.name}” ${outside.length > 1 ? 'are' : 'is'} not in the scale. Chromatic passing/blue notes can be intentional — otherwise snap them in.`,
        action: { label: 'Snap to scale', kind: 'snap-to-scale', payload: { patternId: selPat.id } },
      });
    }
    // melody range
    if (notes.length >= 4) {
      const ps = notes.map((n) => n.pitch);
      const span = Math.max(...ps) - Math.min(...ps);
      const role = guessRole(selPatTrack);
      if ((role === 'lead' || role === 'arp') && span > 24) {
        add({ id: `melody-range:${selPat.id}`, level: 'tip', title: 'Melody range is very wide', text: `“${selPat.name}” spans ${span} semitones. Singable hooks usually sit within an octave and a half — try moving outliers by an octave.` });
      }
    }
  }

  // ---------------------------------------------------------------- next chord suggestions
  let harmonic = null;
  if (selPat && selPatTrack && !isDrumTrack(selPatTrack)) {
    const chords = detectPatternChords(selPat, bpb);
    if (chords.length) harmonic = { pattern: selPat, track: selPatTrack, chords, progression: chordsToProgression(chords, key.root) };
  }
  if (!harmonic) harmonic = progressionFromProject(project);
  if (harmonic) {
    const romans = harmonic.progression.map((c) => c.roman);
    const last = harmonic.chords[harmonic.chords.length - 1];
    const pat = harmonic.pattern;
    const lastEnd = Math.ceil((last.end - 1e-6) / bpb) * bpb;
    const start = lastEnd < pat.length - 1e-6 ? lastEnd : Math.max(pat.length, lastEnd);
    const lo = Math.min(...last.notes), hi = Math.max(...last.notes);
    const range = [Math.min(lo, 52), Math.max(hi, lo + 14, 64)];
    let sugg = [];
    try { sugg = suggestNextChords(romans, key.root, key.scale, genre?.id, { limit: 3 }); } catch { sugg = []; }
    sugg.forEach((s, i) => {
      const notes = voiceLead(last.notes, chordPitchClasses(s.chord.root, s.chord.type), range);
      add({
        id: `next-chord:${pat.id}:${s.roman}`, level: 'idea', title: `Next chord: ${s.roman} (${s.chord.name})`,
        text: `${s.reason}${i === 0 ? ` After ${romans.slice(-4).join(' – ')} in ${kName}.` : ''}`,
        action: { label: `Add ${s.chord.name}`, kind: 'add-chord', payload: { patternId: pat.id, roman: s.roman, notes, start, dur: bpb } },
      });
    });
    if (romans.length >= 2) {
      const an = analyzeProgression(romans, key.root, key.scale);
      const notes = an.notes.slice(0, 3);
      if (notes.length) add({ id: `analysis:${pat.id}:${romans.join('-')}`, level: 'tip', title: `Harmony: ${romans.join(' – ')}`, text: notes.join(' ') });
    }
  }

  // ---------------------------------------------------------------- tracks
  for (const t of instrumentTracks) {
    const hasNotes = trackPatterns(project, t).some((p) => p.notes?.length);
    if (!hasNotes && !(t.code)) {
      const role = guessRole(t);
      add({
        id: `empty-track:${t.id}`, level: 'tip', title: `“${t.name}” is empty`,
        text: `This track has no notes yet. Generate a ${role} part${genre ? ` in ${genre.name} style` : ''} to get going, or delete it to keep the session tidy.`,
        action: { label: `Generate ${role}`, kind: 'generate-part', payload: { role, genre: genre?.id || project.genre || 'pop', trackId: t.id } },
      });
    }
  }
  const roleCount = {};
  for (const t of instrumentTracks) { const r = guessRole(t); roleCount[r] = (roleCount[r] || 0) + 1; }
  for (const [role, n] of Object.entries(roleCount)) {
    if (n > (role === 'drums' ? 2 : 3)) add({ id: `role-crowd:${role}`, level: 'tip', title: `${n} ${role} tracks`, text: `Several tracks share the ${role} role and will compete for the same frequency range. Consider merging, muting or carving space with EQ and arrangement.` });
  }
  if (!instrumentTracks.some(isDrumTrack) && !tracks.some((t) => t.type === 'code' && /s\(|sound\(/.test(t.code || ''))) {
    add({ id: 'missing-drums', level: 'idea', title: 'No drums yet', text: `A ${genre ? genre.name + ' ' : ''}groove would give the track momentum.`, action: { label: 'Generate drums', kind: 'generate-part', payload: { role: 'drums', genre: genre?.id || 'pop' } } });
  }
  const bassTracks = instrumentTracks.filter((t) => guessRole(t) === 'bass');
  if (!bassTracks.length && instrumentTracks.length >= 1) {
    add({ id: 'missing-bass', level: 'idea', title: 'No bassline', text: 'A bassline anchors the harmony and connects the drums to the chords.', action: { label: 'Generate bass', kind: 'generate-part', payload: { role: 'bass', genre: genre?.id || 'pop' } } });
  }

  // ---------------------------------------------------------------- arrangement repetition
  let repeats = 0;
  for (const t of tracks) {
    const cl = (project.clips || []).filter((c) => c.trackId === t.id && c.type === 'pattern' && c.patternId).sort((a, b) => a.start - b.start);
    let run = null;
    const flush = () => {
      if (!run) return;
      const pat = project.patterns?.[run.patternId];
      if (pat && run.len > Math.max(8 * bpb, pat.length * 2) + 1e-6 && repeats < 3) {
        repeats++;
        const hypnotic = genre && ['techno', 'trance', 'house'].includes(genre.family);
        add({
          id: `repeat:${t.id}:${run.patternId}`, level: hypnotic ? 'tip' : 'warn', title: `“${pat.name}” repeats for ${Math.round(run.len / bpb)} bars`,
          text: `The same ${Math.round(pat.length / bpb)}-bar pattern loops unchanged on “${t.name}”. Add a variation (fill, extra notes, a drop-out) so the listener's ear stays engaged.`,
          action: { label: 'Create variation', kind: 'add-variation', payload: { patternId: run.patternId } },
        });
      }
    };
    for (const c of cl) {
      if (run && run.patternId === c.patternId && Math.abs(run.end - c.start) < 0.01) { run.len += c.length; run.end = c.start + c.length; }
      else { flush(); run = { patternId: c.patternId, len: c.length, end: c.start + c.length }; }
    }
    flush();
  }

  // ---------------------------------------------------------------- tempo vs genre
  if (genre && (project.bpm < genre.bpm[0] || project.bpm > genre.bpm[1])) {
    add({
      id: `bpm-range:${genre.id}`, level: 'warn', title: `${project.bpm} BPM is unusual for ${genre.name}`,
      text: `${genre.name} usually sits between ${genre.bpm[0]} and ${genre.bpm[1]} BPM (typically ${genre.defaultBpm}). Half/double-time feels can work, but check the groove.`,
      action: { label: `Set ${genre.defaultBpm} BPM`, kind: 'set-bpm', payload: { bpm: genre.defaultBpm } },
    });
  }
  if (genre && genre.swing >= 0.3 && (project.swing || 0) < 0.1) {
    add({ id: `swing:${genre.id}`, level: 'tip', title: 'Add some swing', text: `${genre.name} grooves rely on swing (around ${Math.round(genre.swing * 100)}%). Raise the project swing for a more authentic feel.` });
  }

  // ---------------------------------------------------------------- mix checks
  const lowSources = live.filter((t) => {
    if (isDrumTrack(t) || t.type !== 'instrument') return false;
    if (guessRole(t) === 'bass') return true;
    const ns = trackPatterns(project, t).flatMap((p) => p.notes || []);
    return ns.length >= 4 && ns.reduce((s, n) => s + n.pitch, 0) / ns.length < 45;
  });
  const hasKick = live.some((t) => isDrumTrack(t) && trackPatterns(project, t).some((p) => (p.notes || []).some((n) => n.pitch === 36)));
  if (lowSources.length >= 2) {
    const sec = lowSources.find((t) => !/808|sub/.test(t.instrument?.preset || '')) || lowSources[1];
    add({
      id: 'low-end-clash', level: 'warn', title: 'Low-end clash',
      text: `${lowSources.map((t) => `“${t.name}”`).join(', ')} all live in the sub/bass register${hasKick ? ' together with the kick' : ''}. Pick one sub source and high-pass the others so the low end stays tight.`,
      action: { label: `High-pass ${sec.name}`, kind: 'add-effect', payload: { trackId: sec.id, type: 'filter', params: { type: 'highpass', cutoff: 140 } } },
    });
  }
  if (hasKick && bassTracks.length) {
    const b = bassTracks[0];
    const ducked = (b.fx || []).some((f) => f.type === 'pump' || f.type === 'compressor');
    if (!ducked && (!genre || ['house', 'techno', 'trance', 'bass', 'dnb', 'garage', 'pop', 'hiphop', 'hard', 'retro'].includes(genre.family))) {
      add({
        id: `sidechain:${b.id}`, level: 'idea', title: 'Make room for the kick',
        text: 'Kick and bass hit at the same time and mask each other. Sidechain-style ducking on the bass makes the kick punch through (and adds groove).',
        action: { label: 'Add pump to bass', kind: 'add-effect', payload: { trackId: b.id, type: 'pump', params: { division: '1/4', depth: 0.6 } } },
      });
    }
  }
  const volSum = live.reduce((s, t) => s + (t.volume ?? 0.8), 0);
  const loudest = live.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
  if (loudest && (loudest.volume > 1.2 || volSum > 5.5)) {
    add({
      id: 'hot-mix', level: 'warn', title: 'Mix is running hot',
      text: `Track volumes add up to ${volSum.toFixed(1)}${loudest.volume > 1.2 ? ` and “${loudest.name}” is at ${Math.round(loudest.volume * 100)}%` : ''}. Pull faders down and leave headroom before the master limiter.`,
      action: { label: `Lower ${loudest.name}`, kind: 'set-volume', payload: { trackId: loudest.id, volume: Math.round(Math.min(loudest.volume * 0.75, 0.8) * 100) / 100 } },
    });
  }
  const panCandidates = live.filter((t) => !isDrumTrack(t) && !['bass', 'lead'].includes(guessRole(t)));
  if (live.length >= 4 && live.every((t) => Math.abs(t.pan || 0) < 0.01) && panCandidates.length) {
    const t = panCandidates[0];
    add({ id: 'all-center', level: 'tip', title: 'Everything is panned center', text: 'Spread supporting parts (chords, arps, percussion) left and right; keep kick, bass and lead in the middle for a wider, clearer mix.', action: { label: `Pan ${t.name} left`, kind: 'set-pan', payload: { trackId: t.id, pan: -0.3 } } });
  }
  const buses = project.buses || [];
  const revIdx = buses.findIndex((b) => /reverb|verb|room|hall/i.test(b.name || '') || (b.fx || []).some((f) => f.type === 'reverb'));
  if (revIdx >= 0) {
    const revId = buses[revIdx].id;
    const dry = live.filter((t) => ['pad', 'lead', 'chords', 'arp'].includes(guessRole(t)) && !((t.sends || {})[revId] > 0) && !(t.fx || []).some((f) => f.type === 'reverb'));
    if (dry.length && dry.length === live.filter((t) => ['pad', 'lead', 'chords', 'arp'].includes(guessRole(t))).length) {
      const t = dry[0];
      add({ id: `no-reverb:${t.id}`, level: 'tip', title: 'Add some space', text: `${dry.map((x) => `“${x.name}”`).join(', ')} ${dry.length > 1 ? 'are' : 'is'} completely dry. A little reverb send glues parts into one room.`, action: { label: `Send ${t.name} to ${buses[revIdx].name}`, kind: 'add-send', payload: { trackId: t.id, busIndex: revIdx, amount: 0.25 } } });
    }
  }

  // ---------------------------------------------------------------- arrangement shape
  const clips = project.clips || [];
  if (clips.length) {
    const end = songLengthBeats(project);
    const arrTracks = new Set(clips.map((c) => c.trackId));
    if (end >= 16 * bpb && arrTracks.size >= 3) {
      const atStart = new Set(clips.filter((c) => c.start < bpb - 1e-6).map((c) => c.trackId));
      const atEnd = new Set(clips.filter((c) => c.start + c.length > end - bpb + 1e-6).map((c) => c.trackId));
      const markers = (project.markers || []).map((m) => (m.name || '').toLowerCase());
      if (atStart.size === arrTracks.size && !markers.some((m) => m.includes('intro'))) add({ id: 'no-intro', level: 'tip', title: 'No intro', text: 'Every track starts on bar 1. A short intro (drums or pads alone) builds anticipation and makes the first drop/chorus hit harder.' });
      if (atEnd.size === arrTracks.size && !markers.some((m) => m.includes('outro'))) add({ id: 'no-outro', level: 'tip', title: 'No outro', text: 'Everything plays until the last bar. Strip elements away for an outro (and DJ-friendly mixing for dance music).' });
    }
  }

  // ---------------------------------------------------------------- genre tips
  if (genre?.tips?.length) {
    const i = (tracks.length + Object.keys(project.patterns || {}).length) % genre.tips.length;
    add({ id: `genre-tip:${genre.id}:${i}`, level: 'tip', title: `${genre.name} tip`, text: genre.tips[i] });
  }

  return recs.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

function makeVariation(pattern, track, project, rng) {
  const bpb = beatsPerBar(project);
  const notes = (pattern.notes || []).map((n) => ({ ...n }));
  const len = pattern.length;
  let out;
  if (isDrumTrack(track)) {
    const fillFrom = len - 1;
    out = notes.filter((n) => n.start < fillFrom - 1e-6 || n.pitch === 36);
    // occasional hat drop-outs / extra ghost snares
    out = out.filter((n) => !(n.pitch === 42 && rng.chance(0.15)));
    for (let b = 0; b < len / bpb - 1; b++) if (rng.chance(0.4)) out.push({ pitch: 38, start: b * bpb + rng.pick([1.75, 2.75, 3.25]), dur: 0.25, vel: 0.3 });
    const seq = [38, 38, 50, 47];
    seq.forEach((p, k) => out.push({ pitch: p, start: fillFrom + k * 0.25, dur: 0.25, vel: 0.65 + k * 0.08 }));
  } else {
    const key = project.key || { root: 0, scale: 'minor' };
    out = notes.map((n) => {
      if (n.start >= len / 2 && rng.chance(0.3)) return { ...n, pitch: stepInScale(n.pitch, rng.pick([-2, -1, 1, 2]), key.root, key.scale) };
      return n;
    });
    // answer phrase: lift the final notes an octave or add a pickup
    const last = out.filter((n) => n.start >= len - bpb);
    if (last.length && rng.chance(0.5)) for (const n of last) n.pitch += 12;
    else if (out.length) {
      const p = out[out.length - 1].pitch;
      out.push({ pitch: stepInScale(p, 1, key.root, key.scale), start: Math.max(0, len - 0.5), dur: 0.45, vel: 0.7 });
    }
  }
  return out.filter((n) => n.start < len).map((n) => createNote(clamp(Math.round(n.pitch), 0, 127), n.start, Math.min(n.dur, len - n.start), n.vel));
}

/**
 * applyAssistantAction(project, action, helpers={rng, createRng}) -> project (mutated in place).
 * Kinds: set-key, set-bpm, snap-to-scale, add-chord, generate-part, add-send, set-pan, set-volume, add-variation, add-effect.
 */
export function applyAssistantAction(project, action, helpers = {}) {
  if (!project || !action) return project;
  const rng = helpers.rng || (helpers.createRng ? helpers.createRng(Date.now() >>> 0) : createRng(Date.now() >>> 0));
  const p = action.payload || {};
  const bpb = beatsPerBar(project);
  const track = (id) => {
    const t = (project.tracks || []).find((x) => x.id === id);
    if (!t) throw new Error(`Track not found: ${id}`);
    return t;
  };
  const pattern = (id) => {
    const pt = project.patterns?.[id];
    if (!pt) throw new Error(`Pattern not found: ${id}`);
    return pt;
  };
  switch (action.kind) {
    case 'set-key':
      project.key = { root: ((Math.round(p.root) % 12) + 12) % 12, scale: SCALES[p.scale] ? p.scale : resolveScaleId(p.scale) };
      break;
    case 'set-bpm':
      project.bpm = clamp(Math.round(p.bpm * 100) / 100, 20, 400);
      break;
    case 'snap-to-scale': {
      const pt = pattern(p.patternId);
      const k = project.key || { root: 0, scale: 'minor' };
      for (const n of pt.notes) n.pitch = snapToScale(n.pitch, k.root, k.scale);
      break;
    }
    case 'add-chord': {
      const pt = pattern(p.patternId);
      const start = p.start ?? pt.length;
      const dur = p.dur ?? bpb;
      for (const m of p.notes || []) pt.notes.push(createNote(m, start, dur * 0.98, p.vel ?? 0.75));
      pt.length = Math.max(pt.length, Math.ceil((start + dur - 1e-6) / bpb) * bpb);
      break;
    }
    case 'add-send': {
      const t = track(p.trackId);
      const bus = (project.buses || [])[p.busIndex ?? 0] || (project.buses || []).find((b) => b.id === p.busId);
      if (!bus) throw new Error('Bus not found');
      t.sends = t.sends || {};
      t.sends[bus.id] = clamp(p.amount ?? 0.25, 0, 1);
      break;
    }
    case 'set-pan':
      track(p.trackId).pan = clamp(p.pan ?? 0, -1, 1);
      break;
    case 'set-volume':
      track(p.trackId).volume = clamp(p.volume ?? 0.8, 0, 1.5);
      break;
    case 'add-effect': {
      const t = track(p.trackId);
      t.fx = t.fx || [];
      t.fx.push(createEffect(p.type, { ...(p.params || {}) }));
      break;
    }
    case 'add-variation': {
      const src = pattern(p.patternId);
      const t = track(src.trackId);
      const v = createPattern(src.trackId, { name: `${src.name} (var)`, length: src.length, color: src.color, notes: makeVariation(src, t, project, rng) });
      project.patterns[v.id] = v;
      // alternate A / A' on the arrangement; split long looping clips in two
      const clips = (project.clips || []).filter((c) => c.patternId === src.id).sort((a, b) => a.start - b.start);
      if (clips.length === 1 && clips[0].length >= src.length * 2) {
        const c = clips[0];
        const half = Math.ceil(c.length / 2 / src.length) * src.length;
        if (half < c.length) {
          const second = createClip(c.trackId, { patternId: v.id, start: c.start + half, length: c.length - half, offset: 0, gain: c.gain, name: c.name });
          c.length = half;
          project.clips.push(second);
        }
      } else {
        clips.forEach((c, i) => { if (i % 2 === 1) c.patternId = v.id; });
      }
      break;
    }
    case 'generate-part': {
      const role = p.role || 'chords';
      const genreId = p.genre || project.genre || 'pop';
      const g = GENRES[genreId] || getGenre(genreId) || GENRES.pop;
      let t = p.trackId ? (project.tracks || []).find((x) => x.id === p.trackId) : null;
      if (!t) {
        t = createTrack({
          name: role[0].toUpperCase() + role.slice(1), role, color: TRACK_COLORS[(project.tracks.length * 3) % TRACK_COLORS.length],
          instrument: role === 'drums' ? { type: 'drums', preset: g.drumKit, params: {} } : { type: 'synth', preset: g.presets?.[role] || null, params: {} },
        });
        project.tracks.push(t);
      }
      let pt = t.activePatternId && project.patterns[t.activePatternId];
      const bars = p.bars || (pt ? Math.max(1, Math.round(pt.length / bpb)) : 4);
      if (!pt) {
        pt = createPattern(t.id, { name: `${t.name} 1`, length: bars * bpb, color: t.color });
        project.patterns[pt.id] = pt;
        t.activePatternId = pt.id;
      }
      const notes = generatePartNotes(role, { genre: g.id, key: project.key?.root ?? 0, scale: project.key?.scale, bars, beatsPerBar: bpb, rng, project });
      pt.length = Math.max(pt.length, bars * bpb);
      pt.notes = notes.filter((n) => n.start < pt.length);
      if ((project.clips || []).length && !project.clips.some((c) => c.trackId === t.id)) {
        project.clips.push(createClip(t.id, { patternId: pt.id, start: 0, length: songLengthBeats(project), name: pt.name }));
      }
      break;
    }
    default:
      throw new Error(`Unknown assistant action: ${action.kind}`);
  }
  return project;
}

/** Human-readable multi-line description of a genre (string; lines separated by \n). */
export function describeGenre(genreId) {
  const g = getGenre(genreId);
  if (!g) return '';
  const scales = g.scales.map((s) => SCALES[s]?.name || s).join(', ');
  const drum = DRUM_STYLES[g.drumStyle]?.name || g.drumStyle;
  const bass = BASS_STYLES[g.bassStyle] || g.bassStyle;
  const structure = g.structure.map((s) => `${s.name} ${s.bars}`).join(' → ');
  const lines = [
    `${g.name}: ${g.bpm[0]}–${g.bpm[1]} BPM (typically ${g.defaultBpm})${g.swing ? `, ${Math.round(g.swing * 100)}% swing` : ', straight feel'}, ${g.timeSig[0]}/${g.timeSig[1]}.`,
    `Harmony: ${scales}. Chord rhythm: ${g.chordStyle}; melody: ${g.melodyStyle}.`,
    `Rhythm section: ${drum} drums on the ${g.drumKit} kit; bass — ${bass}.`,
    `Arrangement: ${structure} (bars).`,
    ...g.tips.slice(0, 3),
  ];
  return lines.join('\n');
}
