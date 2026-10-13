// Pattern / project analysis helpers shared by the assistant and part generators.
import { beatsPerBar } from '../core/model.js';
import { detectChord, chordToRoman, chordPitchClasses, mod12 } from '../theory/index.js';

export const isDrumTrack = (t) => t?.instrument?.type === 'drums' || t?.role === 'drums';

/**
 * Detect chords in a pattern. Uses onset clusters (block chords) when present, else per-bar pitch content.
 * -> [{start, end, chord, notes (MIDI)}]
 */
export function detectPatternChords(pattern, bpb = 4) {
  const notes = (pattern?.notes || []).slice().sort((a, b) => a.start - b.start);
  if (!notes.length) return [];
  const length = Math.max(pattern.length || 0, notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0));
  // onset clusters
  const clusters = [];
  for (const n of notes) {
    const q = Math.round(n.start * 8) / 8;
    let c = clusters.find((x) => Math.abs(x.t - q) < 0.07);
    if (!c) { c = { t: q, notes: [] }; clusters.push(c); }
    c.notes.push(n);
  }
  let chordClusters = clusters.filter((c) => new Set(c.notes.map((n) => mod12(n.pitch))).size >= 3).sort((a, b) => a.t - b.t);
  // drop short passing/approach chords (e.g. gospel half-step approaches) when longer chords exist
  const maxDur = (c) => Math.max(...c.notes.map((n) => n.dur));
  if (chordClusters.some((c) => maxDur(c) >= 0.4)) {
    chordClusters = chordClusters.filter((c, i) => {
      if (maxDur(c) >= 0.3) return true;
      const next = chordClusters[i + 1];
      return !(next && next.t - c.t <= 0.5);
    });
  }
  const out = [];
  if (chordClusters.length && chordClusters.length * 3 >= clusters.length * 0.5) {
    for (let i = 0; i < chordClusters.length; i++) {
      const c = chordClusters[i];
      const chord = detectChord(c.notes.map((n) => n.pitch));
      if (!chord) continue;
      const prev = out[out.length - 1];
      const ringOut = Math.max(...c.notes.map((n) => n.start + n.dur));
      const end = i + 1 < chordClusters.length ? Math.min(chordClusters[i + 1].t, Math.max(ringOut, c.t + 0.25)) : Math.min(length, ringOut);
      if (prev && prev.chord.root === chord.root && prev.chord.type === chord.type) { prev.end = end; continue; }
      out.push({ start: c.t, end, chord, notes: c.notes.map((n) => n.pitch).sort((a, b) => a - b) });
    }
    if (out.length) return out;
  }
  // per-bar analysis (arpeggios, riffs, sparse parts)
  const bars = Math.ceil(length / bpb);
  for (let b = 0; b < bars; b++) {
    const a = b * bpb, z = a + bpb;
    const w = new Map();
    const pitches = [];
    for (const n of notes) {
      const ov = Math.min(z, n.start + n.dur) - Math.max(a, n.start);
      if (ov <= 0) continue;
      const pc = mod12(n.pitch);
      w.set(pc, (w.get(pc) || 0) + ov * (n.start >= a - 1e-6 && Math.abs((n.start - a) % 1) < 1e-6 ? 1.5 : 1));
      pitches.push(n.pitch);
    }
    if (!w.size) continue;
    const max = Math.max(...w.values());
    const keep = new Set([...w.entries()].filter(([, v]) => v >= max * 0.25).map(([pc]) => pc));
    const ps = pitches.filter((p) => keep.has(mod12(p)));
    if (new Set(ps.map(mod12)).size < 2) continue;
    const chord = detectChord(ps);
    if (!chord) continue;
    const prev = out[out.length - 1];
    if (prev && prev.chord.root === chord.root && prev.chord.type === chord.type && Math.abs(prev.end - a) < 1e-6) { prev.end = z; continue; }
    out.push({ start: a, end: z, chord, notes: [...new Set(ps)].sort((x, y) => x - y) });
  }
  return out;
}

/** Turn detected chords into a generator progression [{roman, chord, startBeat, durBeats, notes}]. */
export function chordsToProgression(found, keyRoot = 0) {
  return found.map((f) => ({
    roman: chordToRoman(f.chord, keyRoot),
    chord: { ...f.chord, notes: chordPitchClasses(f.chord.root, f.chord.type) },
    startBeat: f.start,
    durBeats: Math.max(0.25, f.end - f.start),
    notes: f.notes,
  }));
}

/**
 * Find the harmonic backbone of a project: the chords/pad track pattern with the most detectable chords.
 * -> {pattern, track, chords, progression} | null
 */
export function progressionFromProject(project) {
  if (!project) return null;
  const bpb = beatsPerBar(project);
  const roleRank = { chords: 0, pad: 1, keys: 2, arp: 3, lead: 4 };
  const candidates = [];
  for (const t of project.tracks || []) {
    if (isDrumTrack(t) || t.type !== 'instrument') continue;
    const pats = Object.values(project.patterns || {}).filter((p) => p.trackId === t.id && p.notes?.length);
    for (const p of pats) {
      const chords = detectPatternChords(p, bpb);
      if (chords.length) candidates.push({ track: t, pattern: p, chords, rank: (roleRank[t.role] ?? 5) - (p.id === t.activePatternId ? 0.5 : 0) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rank - b.rank || b.chords.length - a.chords.length);
  const best = candidates[0];
  return { ...best, progression: chordsToProgression(best.chords, project.key?.root ?? 0) };
}
