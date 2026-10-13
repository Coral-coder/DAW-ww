// Fit melodic lines to the harmony under them: every note is judged against the chord-scale of the chord it
// sounds over (not just the global project scale), so exotic project scales (harmonic minor, bebop, blues)
// never put an E# melody note over a chord with E, a held 4th over a major 3rd, or a b9 over anything.
import { chordScale, chordScaleRole, fitToChord, mod12 } from '../theory/index.js';

const EPS = 1e-6;

/** Progression lookup that loops over the progression length. */
export function progressionLookup(progression) {
  const len = progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const at = (t) => {
    if (!progression.length) return null;
    const tt = len ? ((t % len) + len) % len : t;
    return progression.find((c) => tt >= c.startBeat - EPS && tt < c.startBeat + c.durBeats - EPS) || progression[progression.length - 1];
  };
  /** Absolute chord-change times in (a, b). */
  const changesIn = (a, b) => {
    const out = [];
    if (!len) return out;
    for (let k = Math.floor(a / len); k * len < b; k++) {
      for (const c of progression) {
        const s = k * len + c.startBeat;
        if (s > a + EPS && s < b - EPS) out.push(s);
      }
    }
    return out.sort((x, y) => x - y);
  };
  return { len, at, changesIn };
}

/**
 * Fit notes (in place) to the chord-scales of the progression.
 * opts: {key: {root, scale}, blues (allow b3 over major chords), range [lo, hi], passing (allow short off-beat
 *        avoid notes as passing tones, default true), minDur (shortest note left after trimming, default 0.12)}
 * Rules: chord tones and tensions stay; an avoid / out-of-chord note moves to the nearest acceptable pitch
 * (towards the next note); a note that rings into a chord it clashes with is shortened at the change, or re-fit
 * when it starts right before the change (anticipation).
 */
export function fitNotesToHarmony(notes, progression, opts = {}) {
  if (!progression?.length || !notes?.length) return notes;
  const { root = 0, scale = 'major' } = opts.key || {};
  const { at, changesIn } = progressionLookup(progression);
  const csCache = new Map();
  const csOf = (c) => {
    if (!csCache.has(c)) csCache.set(c, chordScale(c.chord, root, scale, { blues: !!opts.blues }));
    return csCache.get(c);
  };
  const minDur = opts.minDur ?? 0.12;
  const sorted = notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const good = (pc, cs) => { const r = chordScaleRole(pc, cs); return r === 'tone' || r === 'tension'; };
  sorted.forEach((n, i) => {
    const cs = csOf(at(n.start + 0.01));
    const next = sorted[i + 1];
    const dir = next ? Math.sign(next.pitch - n.pitch) : 0;
    const onBeat = Math.abs(n.start - Math.round(n.start)) < 0.02;
    const passing = opts.passing !== false && !onBeat && n.dur <= 0.26 && chordScaleRole(n.pitch, cs) === 'avoid';
    if (!good(n.pitch, cs) && !passing) n.pitch = fitToChord(n.pitch, cs, { dir: dir || -1, range: opts.range });
    // ringing into later chords
    for (const ch of changesIn(n.start, n.start + n.dur)) {
      if (n.start + n.dur - ch <= 0.1) break; // releases within a 32nd of the change are inaudible as a clash
      const cs2 = csOf(at(ch + 0.01));
      if (good(n.pitch, cs2)) continue;
      if (ch - n.start >= Math.max(minDur, 0.5) || ch - n.start >= n.dur * 0.5) {
        n.dur = Math.max(minDur, Math.round((ch - n.start - 0.02) * 10000) / 10000);
        break;
      }
      // starts just before the change (a push into the next chord): fit it to both if possible
      const both = { tones: cs2.tones.filter((p) => good(p, cs)), tensions: cs2.tensions.filter((p) => good(p, cs)) };
      const target = both.tones.length || both.tensions.length ? both : cs2;
      n.pitch = fitToChord(n.pitch, target, { dir: dir || -1, range: opts.range });
      break;
    }
  });
  return notes;
}

/** True when a pitch class is a chord tone or available tension of the chord at time t. */
export function consonantAt(progression, key, t, pitch) {
  const { at } = progressionLookup(progression);
  const c = at(t);
  if (!c) return true;
  const r = chordScaleRole(mod12(pitch), chordScale(c.chord, key.root, key.scale));
  return r === 'tone' || r === 'tension';
}
