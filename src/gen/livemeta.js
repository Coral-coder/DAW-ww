// Compact "intent" metadata of a generated song (project.genMeta), used by the live-coder song code
// (src/code/livecoder.js): the form (sections, layers, energy) and the harmony as Strudel chord symbols.
//
//   project.genMeta = { v: 1, key: {root, scale}, bpb,
//     sections: [{ name, kind, type, bars, energy, layers: [role], enter?: [role], mod?: semitones, harmony: harmonyKey }],
//     harmony: { harmonyKey: [chord symbol per bar of one cycle of the progression] } }
import { keyPrefersFlats, mod12 } from '../theory/index.js';

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** daW³ chord type id -> the suffix Strudel's voicing() dictionary knows. */
export const STRUDEL_CHORD = {
  maj: '', min: 'm', dim: 'o', aug: 'aug', sus2: '2', sus4: 'sus', 5: '5', 6: '6', m6: 'm6', 7: '7', maj7: '^7', m7: 'm7',
  m7b5: 'h7', dim7: 'o7', mMaj7: '-^7', 9: '9', maj9: '^9', m9: 'm9', add9: 'add9', madd9: 'madd9', 11: '11', m11: 'm11',
  13: '13', maj13: '^13', m13: 'm11', '7sus4': '7sus', '9sus4': '9sus', '7b9': '7b9', '7#9': '7#9', '7#11': '7#11',
  '7b5': '7b5', aug7: '7#5', augMaj7: '^7#5', maj7s11: '^7#11', 69: '69', m69: '-69',
};

/** Chord -> Strudel chord symbol ("Cm9", "Eb^7", "F7sus"). */
export function chordSymbol(root, type, flats = true) {
  const suf = STRUDEL_CHORD[type] ?? (/^m/.test(String(type)) ? 'm' : '');
  return (flats ? FLAT : SHARP)[mod12(root)] + suf;
}

/** Progression [{startBeat, durBeats, chord:{root,type}}] -> one token per bar ("Cm9" | "[Cm9 F9]"). */
export function barChordTokens(prog, bars, bpb, flats = true, shift = 0) {
  const out = [];
  for (let b = 0; b < bars; b++) {
    const a = b * bpb, z = a + bpb;
    const inBar = (prog || []).filter((c) => c.startBeat < z - 1e-6 && c.startBeat + c.durBeats > a + 1e-6)
      .map((c) => ({ sym: chordSymbol((c.chord?.root ?? c.root) + shift, c.chord?.type ?? c.type, flats), w: Math.min(z, c.startBeat + c.durBeats) - Math.max(a, c.startBeat) }));
    const merged = [];
    for (const x of inBar) { const l = merged[merged.length - 1]; if (l && l.sym === x.sym) l.w += x.w; else merged.push({ ...x }); }
    if (!merged.length) { out.push(out.length ? out[out.length - 1] : '~'); continue; }
    if (merged.length === 1) { out.push(merged[0].sym); continue; }
    const unit = Math.min(...merged.map((m) => m.w));
    const even = merged.every((m) => Math.abs(m.w - unit) < 1e-6);
    out.push(`[${merged.map((m) => (even ? m.sym : `${m.sym}@${Math.max(1, Math.round(m.w / unit))}`)).join(' ')}]`);
  }
  return out;
}

/**
 * The shortest repeating cycle of a token list. A long list that repeats a short loop except for its last
 * token (a turnaround into the next section) counts as that loop.
 */
export function cycleOf(tokens) {
  const n = tokens.length;
  const loop = (skipLast) => {
    for (let p = 1; p < n; p++) {
      let ok = true;
      for (let i = p; i < n - (skipLast ? 1 : 0) && ok; i++) ok = tokens[i] === tokens[i % p];
      if (ok) return tokens.slice(0, p);
    }
    return null;
  };
  const exact = loop(false);
  if (exact && exact.length <= 8) return exact;
  const near = n > 8 ? loop(true) : null;
  return near && near.length <= 8 ? near : exact || tokens.slice();
}

/** genMeta for generateSong: sections (from planSections) + per-section progressions. */
export function buildGenMeta({ sections, progs, bpb, key }) {
  const flats = keyPrefersFlats(key.root, key.scale);
  // group sections by their chord cycle; each group is named after its most energetic section's type ("chorus")
  const groups = [];
  const groupOf = sections.map((s, i) => {
    const cyc = cycleOf(barChordTokens(progs[i], s.bars, bpb, flats));
    const txt = cyc.join(' ');
    let g = groups.find((x) => x.txt === txt);
    if (!g) { g = { txt, cyc, best: s }; groups.push(g); } else if (s.energy > g.best.energy) g.best = s;
    return g;
  });
  const harmony = {};
  for (const g of groups) {
    const base = String(g.best.type || g.best.kind || 'part').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^(\d)/, '_$1') || 'part';
    g.key = base;
    for (let k = 2; harmony[g.key]; k++) g.key = `${base}${k}`;
    harmony[g.key] = g.cyc;
  }
  const out = sections.map((s, i) => ({
    name: s.label, kind: s.kind, type: s.type, bars: s.bars, energy: Math.round(s.energy * 100) / 100, layers: [...s.roles],
    ...(s.enter?.length ? { enter: [...s.enter] } : {}), ...(s.modulation ? { mod: s.modulation } : {}), harmony: groupOf[i].key,
  }));
  return { v: 1, key: { root: key.root, scale: key.scale }, bpb, sections: out, harmony };
}
