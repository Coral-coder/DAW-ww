// "Live-coder" song code: the project described the way a live coder would write it — one short idea per part
// (drum loops, a bass cell over scale-degree roots, chord symbols + voicing(), a lead motif, an arp figure),
// section variants as functions on those ideas (.mask, .degradeBy, .lpf sweeps, .transpose, .gain) and ONE
// arrange() of stack()s at the bottom. It describes the music's intent, not every humanised micro-detail
// (the exact transcription stays available in song-code.js).
//
//   songToLiveCode(project, {export}) -> { code, mode: 'live', blocks, roles: {constName: trackId}, sections }
//   applyLiveCode(project, code, opts) -> report   (mutates `project` — call inside store.transact)
//     Unedited code is a no-op. Edited parts (a changed const, anything it depends on, or its place in the
//     arrangement) are rendered from the code over the arrangement into the track's patterns / clips, and the
//     project's groove / humanisation is applied to the new notes.
//
// Where the intent comes from: project.genMeta (generateSong: form, layers, chord symbols — src/gen/livemeta.js);
// without it, by analysis: dominant bar loops per track and section, chords detected per bar (src/gen/analyze.js).
import { beatsPerBar, songLengthBeats, createPattern, createClip, createNote, DRUM_PADS } from '../core/model.js';
import { evaluate, queryEvents, splitTopLevel, stripComments } from './strudel.js';
import { drumPitch } from './convert.js';
import { compactSteps, detectSwing, unswing, swingCall, scaleCandidates, toDegree, weightedSeq, mergeRests } from './idioms.js';
import { labelFor, kitBank, strudelSound, strudelCall, hasArrangement } from './song-code.js';
import { barChordTokens, cycleOf } from '../gen/livemeta.js';
import { detectPatternChords } from '../gen/analyze.js';
import { applyGroove } from '../gen/groove.js';
import { keyPrefersFlats } from '../theory/index.js';
import { createRng } from '../core/util.js';
import { valueAt } from '../core/automation.js';
import { getGenre } from '../gen/genres.js';

const EPS = 1e-6;
const PITCH_TO_SHORT = Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.short]));
const DRUM_ORDER = new Map(DRUM_PADS.map((p, i) => [p.pitch, i]));
const HATS = new Set([42, 46, 70, 54, 51]);
const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAX_MINI = 96;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const num = (x) => String(x).replace(/^0\./, '.').replace(/^-0\./, '-.');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mod = (a, n) => ((a % n) + n) % n;
const mode = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  let best = null, n = -1;
  for (const [k, v] of m) if (v > n) { best = k; n = v; }
  return best;
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 60; };

/** "<a a b b>" -> "<a!2 b!2>" (one token per cycle). */
export function cycleMini(tokens) {
  const out = [];
  for (const t of tokens) {
    const l = out[out.length - 1];
    if (l && l.t === t) l.n++; else out.push({ t, n: 1 });
  }
  const body = out.map((x) => (x.n > 1 ? `${x.t}!${x.n}` : x.t)).join(' ');
  return out.length === 1 && out[0].n === tokens.length ? tokens[0] : `<${body}>`;
}

// ------------------------------------------------------------------------------------------- notes per track

/** All notes of a track on the timeline (absolute beats), clips resolved (offset, looping patterns). */
function timelineNotes(project, track, bpb) {
  const out = [];
  for (const c of project.clips || []) {
    if (c.trackId !== track.id || c.type === 'audio') continue;
    const p = project.patterns?.[c.patternId];
    if (!p) continue;
    const L = p.length || bpb;
    const off = c.offset || 0;
    const end = c.start + c.length;
    for (let k = Math.floor(off / L); ; k++) {
      const base = c.start - off + k * L;
      if (base >= end - EPS) break;
      for (const n of p.notes || []) {
        const t = base + n.start;
        if (t < c.start - EPS || t >= end - EPS) continue;
        out.push({ pitch: n.pitch, start: t, dur: Math.max(0.05, Math.min(n.dur, end - t)), vel: n.vel ?? 0.8 });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// ------------------------------------------------------------------------------------------------ sections

function planSections(project, bpb, total, tracks) {
  const gm = project.genMeta;
  const totalBars = Math.round(total / bpb);
  if (gm?.sections?.length && gm.bpb === bpb) {
    const sum = gm.sections.reduce((a, s) => a + s.bars, 0);
    if (Math.abs(sum - totalBars) <= 1) {
      let start = 0;
      return gm.sections.map((s) => { const o = { ...s, start }; start += s.bars * bpb; return o; });
    }
  }
  const ps = (project.sections || []).filter((s) => Number.isFinite(s.start) && s.bars > 0).sort((a, b) => a.start - b.start);
  if (ps.length && Math.abs(ps[ps.length - 1].start + ps[ps.length - 1].bars * bpb - total) <= bpb && ps[0].start < EPS) {
    return ps.map((s) => ({ name: s.name, kind: s.kind, type: s.type, bars: s.bars, start: s.start, energy: s.energy, mod: s.modulation }));
  }
  // markers, else the bars where clips start
  let cuts = (project.markers || []).map((m) => Math.round(m.beat / bpb)).filter((b) => b > 0 && b < totalBars);
  let named = new Map((project.markers || []).map((m) => [Math.round(m.beat / bpb), m.name]));
  if (!cuts.length) {
    named = new Map();
    const ids = new Set(tracks.map((t) => t.id));
    cuts = (project.clips || []).filter((c) => ids.has(c.trackId)).map((c) => Math.round(c.start / bpb)).filter((b) => b > 0 && b < totalBars);
  }
  cuts = [...new Set([0, ...cuts])].sort((a, b) => a - b);
  // at most 16 sections: drop the cuts closest to their neighbours
  while (cuts.length > 16) {
    let bi = 1, bl = Infinity;
    for (let i = 1; i < cuts.length; i++) { const l = (cuts[i + 1] ?? totalBars) - cuts[i - 1]; if (l < bl) { bl = l; bi = i; } }
    cuts.splice(bi, 1);
  }
  return cuts.map((b, i) => {
    const e = cuts[i + 1] ?? totalBars;
    return { name: named.get(b) || (cuts.length > 1 ? `part ${i + 1}` : 'song'), kind: '', bars: e - b, start: b * bpb };
  });
}

// ----------------------------------------------------------------------------------------------- analysis

/** Onset -> grid step (un-swung, snapped to 16ths or 8th-note triplets). */
function gridOf(notes, bpb) {
  const groove = detectSwing(notes);
  const straight = notes.map((n) => unswing(n.start, groove));
  const err = (r) => straight.reduce((a, t) => a + Math.abs(t * r - Math.round(t * r)) / r, 0);
  const per = err(3) < err(4) * 0.6 ? 3 : 4;
  return { groove, per, S: bpb * per, step: (t) => Math.round(unswing(t, groove) * per) };
}

/** Notes of [a, b) of the timeline, grouped per bar: [{bar, notes:[{…, s: step in bar}]}]. */
function barsOf(notes, a, bars, bpb, grid) {
  const out = Array.from({ length: bars }, () => []);
  for (const n of notes) {
    if (n.start < a - 0.1 || n.start >= a + bars * bpb - 0.1) continue;
    const st = grid.step(n.start - a);
    const bar = Math.floor(st / grid.S);
    if (bar < 0 || bar >= bars) continue;
    out[bar].push({ ...n, s: st - bar * grid.S });
  }
  return out;
}

const stepsMini = (cells) => compactSteps(cells.map((c) => c ?? '~'));

/** Items [{tok, w}] of one bar (degrees with lengths, rests) -> mini text. */
function barMini(evs, S, rest = '~') {
  const items = [];
  let pos = 0;
  for (const e of evs) {
    if (e.s > pos) items.push({ tok: rest, w: e.s - pos });
    if (e.s < pos) continue;
    items.push({ tok: e.tok, w: e.w });
    pos = e.s + e.w;
  }
  if (pos < S) items.push({ tok: rest, w: S - pos });
  if (items.every((i) => i.tok === rest)) return rest;
  return weightedSeq(mergeRests(items));
}

function scaleInfo(project) {
  const root = project.key?.root ?? 0;
  const cand = scaleCandidates(project.key?.scale || 'major')[0];
  return { root, name: cand.name, intervals: cand.intervals };
}

/** Scale degree of `pitch` from `base` (nearest scale tone for chromatic notes). */
function degreeOf(pitch, base, iv) {
  for (const d of [0, -1, 1, -2, 2]) { const x = toDegree(pitch + d, base, iv); if (x !== null) return x; }
  return 0;
}

/** A scale anchored at the octave holding most of `pitches`: {base (MIDI), label ("C2:dorian")}. */
function anchor(pitches, sc, flats) {
  const m = median(pitches);
  let base = 12 * Math.floor((m - sc.root) / 12) + sc.root;
  if (m - base > 9) base += 12; // e.g. a line around Bb3 in C: anchor C4, degrees go slightly negative
  const oct = Math.floor(base / 12) - 1;
  return { base, label: `${(flats ? NAMES_FLAT : NAMES_SHARP)[mod(sc.root, 12)]}${oct}:${sc.name}` };
}

function fxTail(track, project) {
  let out = '';
  for (const fx of track.fx || []) {
    if (fx.enabled === false) continue;
    if (fx.type === 'reverb' && !out.includes('.room')) out += `.room(${num(r1(fx.params?.mix ?? 0.3))})`;
    if (fx.type === 'delay' && !out.includes('.delay')) out += `.delay(${num(r1(fx.params?.mix ?? 0.3))})`;
  }
  for (const [busId, amt] of Object.entries(track.sends || {})) {
    const bus = (project.buses || []).find((b) => b.id === busId);
    if (!bus || !(amt > 0.05)) continue;
    const has = (t) => (bus.fx || []).some((f) => f.type === t && f.enabled !== false);
    if (has('reverb') && !out.includes('.room')) out += `.room(${num(r1(amt))})`;
    else if (has('delay') && !out.includes('.delay')) out += `.delay(${num(r1(amt))})`;
  }
  return out.replace(/\.(room|delay)\(0\)/g, '');
}

// ---------------------------------------------------------------------------------------------- part ideas

function drumsIdea(notes, ref, bpb, bank) {
  const grid = gridOf(notes.filter((n) => n.start >= ref.start && n.start < ref.start + ref.bars * bpb).map((n) => ({ ...n, start: n.start - ref.start })), bpb);
  const bars = barsOf(notes, ref.start, ref.bars, bpb, grid);
  const sig = bars.map((b) => [...new Set(b.map((n) => `${n.pitch}@${n.s}`))].sort().join(' '));
  const top = mode(sig.filter(Boolean)) || '';
  const loop = bars.filter((_, i) => sig[i] === top);
  const voices = new Map();
  for (const b of loop) for (const n of b) {
    if (!voices.has(n.pitch)) voices.set(n.pitch, { pitch: n.pitch, cells: new Array(grid.S).fill(null), vels: [] });
    const v = voices.get(n.pitch);
    v.cells[n.s % grid.S] = PITCH_TO_SHORT[n.pitch] || `perc:${n.pitch}`;
  }
  // velocities over the whole reference section (per voice)
  for (const b of bars) for (const n of b) voices.get(n.pitch)?.vels.push(n.vel);
  const list = [...voices.values()].sort((a, b) => (DRUM_ORDER.get(a.pitch) ?? 99) - (DRUM_ORDER.get(b.pitch) ?? 99));
  const groups = { main: [], ghost: [], hats: [] };
  for (const v of list) {
    const mean = v.vels.reduce((a, b) => a + b, 0) / Math.max(1, v.vels.length);
    const sd = Math.sqrt(v.vels.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.vels.length));
    v.mini = stepsMini(v.cells);
    v.mean = mean;
    if (HATS.has(v.pitch) && sd > 0.07 && v.vels.length >= 8) { v.lo = Math.min(...v.vels); v.hi = Math.max(...v.vels); groups.hats.push(v); } else if (mean < 0.5) groups.ghost.push(v); else groups.main.push(v);
  }
  const lines = [];
  const join = (vs, tail) => {
    let cur = [];
    const flush = () => { if (cur.length) lines.push(`s("${cur.map((v) => v.mini).join(', ')}")${tail(cur)}`); cur = []; };
    for (const v of vs) { if (cur.length && [...cur, v].map((x) => x.mini).join(', ').length > 60) flush(); cur.push(v); }
    flush();
  };
  join(groups.main, () => '');
  join(groups.ghost, (vs) => `.gain(${num(r1(clamp(vs.reduce((a, v) => a + v.mean, 0) / vs.length / 0.8, 0.2, 1)))})`);
  join(groups.hats, (vs) => {
    const lo = r2(clamp(Math.min(...vs.map((v) => v.lo)) / 0.8, 0.1, 1)), hi = r2(clamp(Math.max(...vs.map((v) => v.hi)) / 0.8, 0.1, 1));
    return `.gain(perlin.range(${num(lo)}, ${num(hi)}))`;
  });
  if (!lines.length) lines.push('silence');
  const busy = sig.filter((s) => s && s !== top).length / Math.max(1, sig.filter(Boolean).length);
  let tail = bank ? `.bank("${bank}")` : '';
  if (busy > 0.15) tail += '.sometimesBy(.1, x => x.ply(2))';
  tail += swingCall(grid.groove, bpb);
  const body = lines.length === 1 ? lines[0] : `stack(\n${lines.map((l) => `  ${l},`).join('\n')}\n)`;
  return { body: body + tail, perBar: (sec) => onsetsPerBar(notes, sec, bpb) };
}

function onsetsPerBar(notes, sec, bpb) {
  const a = sec.start, b = sec.start + sec.bars * bpb;
  let n = 0, first = Infinity, vel = 0;
  for (const x of notes) if (x.start >= a - 0.1 && x.start < b - 0.1) { n++; vel += x.vel; first = Math.min(first, x.start - a); }
  return { n, perBar: n / sec.bars, first, vel: n ? vel / n : 0 };
}

/** Per-bar degree sequence (roots) + one-bar rhythm cell. */
function bassIdea(notes, ref, bpb, sc, flats, sound) {
  const rel = notes.filter((n) => n.start >= ref.start - 0.1 && n.start < ref.start + ref.bars * bpb - 0.1).map((n) => ({ ...n, start: n.start - ref.start }));
  const grid = gridOf(rel, bpb);
  const bars = barsOf(notes, ref.start, ref.bars, bpb, grid);
  const firsts = bars.filter((b) => b.length).map((b) => b[0].pitch);
  const lowRoot = mode(firsts) ?? median(rel.map((n) => n.pitch));
  const base = lowRoot - mod(lowRoot - sc.root, 12);
  const an = { base, label: `${(flats ? NAMES_FLAT : NAMES_SHARP)[mod(sc.root, 12)]}${Math.floor(base / 12) - 1}:${sc.name}` };
  const roots = [];
  const cells = [];
  for (const b of bars) {
    const mono = [];
    for (const n of b) if (!mono.some((m) => m.s === n.s)) mono.push(n);
    if (!mono.length) { roots.push('~'); continue; }
    const r = degreeOf(mono[0].pitch, an.base, sc.intervals);
    roots.push(String(r));
    const cell = new Array(grid.S).fill(null);
    for (const n of mono) cell[n.s] = String(degreeOf(n.pitch, an.base, sc.intervals) - r);
    cells.push(cell);
  }
  const top = mode(cells.map((c) => c.join(','))) || '0';
  const cell = top.split(',').map((x) => x || null);
  let cyc = cycleOf(roots);
  if (cyc.length > 8) cyc = cyc.slice(0, 8);
  const rootsMini = cycleMini(cyc);
  const allZero = cell.every((c) => c === null || c === '0');
  const durs = rel.map((n) => n.dur * grid.per);
  const legato = median(durs);
  const clip = legato >= 1.6 ? `.clip(${num(r1(Math.min(4, legato)))})` : '';
  const body = allZero
    ? `n("${rootsMini}").scale("${an.label}").struct("${stepsMini(cell.map((c) => (c === null ? null : 'x')))}")${clip}.s("${sound}")`
    : `n("${stepsMini(cell)}".add("${rootsMini}")).scale("${an.label}")${clip}.s("${sound}")`;
  return { body: body + swingCall(grid.groove, bpb) };
}

/** Rhythm cell of a chordal part (onsets per bar) — null when it just holds each chord. */
function chordCell(notes, ref, bpb) {
  const rel = notes.filter((n) => n.start >= ref.start - 0.1 && n.start < ref.start + ref.bars * bpb - 0.1).map((n) => ({ ...n, start: n.start - ref.start }));
  const grid = gridOf(rel, bpb);
  const bars = barsOf(notes, ref.start, ref.bars, bpb, grid);
  const cells = bars.filter((b) => b.length).map((b) => {
    const c = new Array(grid.S).fill(null);
    for (const n of b) c[n.s] = 'x';
    return c.join(',');
  });
  const top = mode(cells);
  if (!top) return { struct: '', grid };
  const cell = top.split(',').map((x) => x || null);
  const hits = cell.filter(Boolean).length;
  const longest = Math.max(...rel.map((n) => n.dur));
  if (hits === 1 && cell[0] && longest >= bpb * 0.6) return { struct: '', grid };
  const legato = median(rel.map((n) => n.dur * grid.per));
  return { struct: `.struct("${stepsMini(cell)}")${legato >= 1.6 ? `.clip(${num(r1(Math.min(4, legato)))})` : ''}`, grid };
}

function arpFigure(notes, ref, bpb) {
  const rel = notes.filter((n) => n.start >= ref.start - 0.1 && n.start < ref.start + ref.bars * bpb - 0.1).map((n) => ({ ...n, start: n.start - ref.start }));
  const grid = gridOf(rel, bpb);
  const bars = barsOf(notes, ref.start, ref.bars, bpb, grid).filter((b) => b.length);
  if (!bars.length) return null;
  const cells = bars.map((b) => {
    const pcs = [...new Set(b.map((n) => n.pitch))].sort((x, y) => x - y);
    const c = new Array(grid.S).fill(null);
    for (const n of b) if (c[n.s] === null) c[n.s] = String(pcs.indexOf(n.pitch));
    return c.join(',');
  });
  const fig = stepsMini(mode(cells).split(',').map((x) => x || null));
  const shift = Math.round((median(rel.map((n) => n.pitch)) - 66) / 12) * 12;
  return { fig, shift };
}

function melodyIdea(notes, ref, bpb, sc, flats, sound) {
  const rel = notes.filter((n) => n.start >= ref.start - 0.1 && n.start < ref.start + ref.bars * bpb - 0.1).map((n) => ({ ...n, start: n.start - ref.start }));
  const grid0 = gridOf(rel, bpb);
  const an = anchor(rel.map((n) => n.pitch), sc, flats);
  const build = (per, nBars) => {
    const grid = { ...grid0, per, S: bpb * per, step: (t) => Math.round(unswing(t, grid0.groove) * per) };
    const bars = barsOf(notes, ref.start, ref.bars, bpb, grid);
    const toks = bars.map((b) => {
      const top = new Map();
      for (const n of b) if (!top.has(n.s) || top.get(n.s).pitch < n.pitch) top.set(n.s, n);
      const evs = [...top.values()].sort((x, y) => x.s - y.s);
      const out = evs.map((n, i) => {
        const next = evs[i + 1] ? evs[i + 1].s : grid.S;
        return { s: n.s, w: clamp(Math.round(n.dur * per), 1, next - n.s), tok: String(degreeOf(n.pitch, an.base, sc.intervals)) };
      });
      return barMini(out, grid.S);
    });
    let cyc = cycleOf(toks);
    if (cyc.length > nBars) cyc = cyc.slice(0, nBars);
    return cycleMini(cyc.map((t) => (/\s/.test(t) ? `[${t}]` : t)));
  };
  let mini = build(grid0.per, 4);
  if (mini.length > MAX_MINI) mini = build(grid0.per, 2);
  if (mini.length > MAX_MINI && grid0.per === 4) mini = build(2, 2);
  if (mini.length > MAX_MINI) mini = build(2, 1);
  return { body: `n("${mini}").scale("${an.label}").s("${sound}")${swingCall(grid0.groove, bpb)}` };
}

/** Chordal part without detectable harmony: first chord of each bar as note names. */
function chordNotesIdea(notes, ref, bpb, sound) {
  const rel = notes.filter((n) => n.start >= ref.start - 0.1 && n.start < ref.start + ref.bars * bpb - 0.1).map((n) => ({ ...n, start: n.start - ref.start }));
  const grid = gridOf(rel, bpb);
  const bars = barsOf(notes, ref.start, ref.bars, bpb, grid);
  const name = (p) => NAMES_SHARP[mod(p, 12)].toLowerCase() + (Math.floor(p / 12) - 1);
  const toks = bars.map((b) => {
    if (!b.length) return '~';
    const s0 = b[0].s;
    const ps = [...new Set(b.filter((n) => n.s === s0).map((n) => n.pitch))].sort((x, y) => x - y);
    return ps.length === 1 ? name(ps[0]) : `[${ps.map(name).join(',')}]`;
  });
  let cyc = cycleOf(toks);
  while (cyc.length > 1 && cycleMini(cyc).length > MAX_MINI) cyc = cyc.slice(0, Math.ceil(cyc.length / 2));
  const { struct } = chordCell(notes, ref, bpb);
  return { body: `note("${cycleMini(cyc)}")${struct}.s("${sound}")` };
}

// ------------------------------------------------------------------------------------------------ harmony

function sectionHarmony(project, sections, tracks, bpb, notesOf, flats) {
  const gm = project.genMeta;
  if (gm?.harmony && sections.every((s) => s.harmony && gm.harmony[s.harmony])) {
    return { keys: sections.map((s) => s.harmony), table: gm.harmony };
  }
  // analysis: chords detected per bar on the chord / pad / keys parts
  const rank = (t) => ({ chords: 0, pad: 1, keys: 2, arp: 3 }[t.role] ?? 9);
  const cand = tracks.filter((t) => t.instrument?.type !== 'drums' && rank(t) < 9).sort((a, b) => rank(a) - rank(b));
  const table = {};
  const keys = sections.map((s) => {
    let toks = null;
    for (const t of cand) {
      const ns = notesOf(t).filter((n) => n.start >= s.start - 0.1 && n.start < s.start + s.bars * bpb).map((n) => ({ ...n, start: Math.max(0, n.start - s.start) }));
      if (!ns.length) continue;
      const found = detectPatternChords({ notes: ns, length: s.bars * bpb }, bpb);
      if (!found.length) continue;
      toks = barChordTokens(found.map((f) => ({ startBeat: f.start, durBeats: f.end - f.start, root: f.chord.root, type: f.chord.type })), s.bars, bpb, flats);
      break;
    }
    if (!toks || toks.every((t) => t === '~')) return null;
    const cyc = cycleOf(toks);
    const txt = cyc.join(' ');
    let k = Object.keys(table).find((x) => table[x].join(' ') === txt);
    if (!k) { k = `h${Object.keys(table).length + 1}`; table[k] = cyc; }
    return k;
  });
  return { keys, table };
}

// ---------------------------------------------------------------------------------------------- song code

const ROLE_NAME = { drums: 'drums', bass: 'bass', pad: 'pad', lead: 'lead', arp: 'arp', fx: 'fx', counter: 'counter' };

function roleOf(t) {
  if (t.instrument?.type === 'drums') return 'drums';
  return String(t.role || '').toLowerCase();
}

/**
 * Section items [{base, mods}] -> {items: [expr], tail}: modifiers every part shares move to the stack
 * (`stack(a, b).transpose(2)`), parts sharing a filter sweep are grouped (`stack(pad, arp).lpf(saw…)`).
 */
function groupItems(items) {
  if (items.length < 2) return { items: items.map((i) => i.base + i.mods.join('')), tail: '' };
  const common = items[0].mods.filter((m) => items.every((i) => i.mods.includes(m)));
  const rest = items.map((i) => ({ base: i.base, mods: i.mods.filter((m) => !common.includes(m)) }));
  const out = [];
  const done = new Set();
  rest.forEach((it, k) => {
    if (done.has(k)) return;
    const sw = it.mods.find((m) => m.startsWith('.lpf('));
    const mates = sw ? rest.map((x, j) => (x.mods.includes(sw) && !done.has(j) ? j : -1)).filter((j) => j >= 0) : [];
    if (mates.length >= 2) {
      for (const j of mates) done.add(j);
      out.push(`stack(${mates.map((j) => rest[j].base + rest[j].mods.filter((m) => m !== sw).join('')).join(', ')})${sw}`);
    } else { done.add(k); out.push(it.base + it.mods.join('')); }
  });
  return { items: out, tail: common.join('') };
}

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/**
 * The project as live-coder Strudel code (see the header).
 * @returns {{code, mode: 'live', blocks: object[], roles: object, sections: object[]}}
 */
export function songToLiveCode(project, opts = {}) {
  const exp = !!opts.export;
  const bpb = beatsPerBar(project);
  const arranged = hasArrangement(project);
  const sc = scaleInfo(project);
  const flats = keyPrefersFlats(sc.root, project.key?.scale || 'major');
  const tracks = (project.tracks || []).filter((t) => t.type === 'instrument' && (!opts.trackIds || opts.trackIds.includes(t.id)));
  const codeTracks = (project.tracks || []).filter((t) => t.type === 'code' && String(t.code || '').trim());
  let total, sections;
  const notesCache = new Map();
  let notesOf;
  if (arranged) {
    total = songLengthBeats(project);
    notesOf = (t) => { if (!notesCache.has(t.id)) notesCache.set(t.id, timelineNotes(project, t, bpb)); return notesCache.get(t.id); };
    sections = planSections(project, bpb, total, tracks);
  } else {
    // pattern mode: the active patterns, looped over the longest one
    const pats = tracks.map((t) => project.patterns?.[t.activePatternId]).filter(Boolean);
    const L = Math.max(bpb, ...pats.map((p) => Math.ceil((p.length || bpb) / bpb) * bpb));
    total = L;
    notesOf = (t) => {
      if (notesCache.has(t.id)) return notesCache.get(t.id);
      const p = project.patterns?.[t.activePatternId];
      const out = [];
      if (p) for (let o = 0; o < L; o += p.length || bpb) for (const n of p.notes || []) if (o + n.start < L) out.push({ pitch: n.pitch, start: o + n.start, dur: n.dur, vel: n.vel ?? 0.8 });
      notesCache.set(t.id, out.sort((a, b) => a.start - b.start));
      return out;
    };
    sections = [{ name: 'loop', kind: '', bars: L / bpb, start: 0 }];
  }
  const live = tracks.filter((t) => notesOf(t).length);

  // ---- names
  const used = new Set(['chords', 'silence', 'stack', 'arrange', 'chord', 'n', 's', 'note', 'h']);
  const harmony = sectionHarmony(project, sections, live, bpb, notesOf, flats);
  const hkeys = [...new Set(harmony.keys.filter(Boolean))];
  const multi = hkeys.length > 1;
  const hName = new Map();
  for (const k of hkeys) hName.set(k, multi ? labelFor(k, used) : 'chords');
  const nameOf = new Map();
  const roleTaken = new Set();
  for (const t of live) {
    const role = roleOf(t);
    let base = role === 'chords' ? 'stabs' : ROLE_NAME[role] || t.name;
    if (roleTaken.has(role)) base = t.name;
    roleTaken.add(role);
    nameOf.set(t.id, labelFor(base, used));
  }

  // ---- per section: which parts play, and how they differ from their idea
  const presence = (t, s) => onsetsPerBar(notesOf(t), s, bpb);
  const refOf = new Map();
  for (const t of live) {
    let best = null, bs = -1;
    for (const s of sections) {
      const p = presence(t, s);
      if (!p.n) continue;
      const score = (s.energy ?? 0.5) * 1000 + p.perBar + (s.kind === 'main' ? 500 : 0);
      if (score > bs) { bs = score; best = s; }
    }
    refOf.set(t.id, best);
  }

  // ---- part ideas
  const defs = []; // {name, trackId, body, fn}
  const hasHarmony = hkeys.length > 0;
  const chordsDep = (body) => (multi ? `h => ${body.replace(/^chords\b/, 'chords(h)')}` : body);
  for (const t of live) {
    const role = roleOf(t);
    const name = nameOf.get(t.id);
    const ref = refOf.get(t.id);
    const ns = notesOf(t);
    const sd = t.instrument?.type === 'strudel';
    const sound = sd || exp || !t.instrument?.preset ? strudelSound(t) : t.instrument.preset;
    // Strudel patch tracks: .s("<sound>") + the patch's own controls, so the code plays exactly the DAW's sound
    // (the patch's room / delay win over the track's reverb / delay sends)
    const patchTail = sd ? strudelCall(t).replace(/^\.s\("[^"]*"\)/, '') : '';
    const sendTail = fxTail(t, project);
    const tail = patchTail + (sd ? sendTail.replace(/\.room\([^)]*\)/g, (m) => (/\.room\(/.test(patchTail) ? '' : m)).replace(/\.delay\([^)]*\)/g, (m) => (/\.delay\(/.test(patchTail) ? '' : m)) : sendTail);
    let body, fn = false;
    if (role === 'drums') {
      body = drumsIdea(ns, ref, bpb, t.instrument?.preset ? kitBank(t.instrument.preset) : '').body;
    } else if (role === 'bass' || (!role && median(ns.map((n) => n.pitch)) < 48)) {
      body = bassIdea(ns, ref, bpb, sc, flats, sound).body + tail;
    } else if (hasHarmony && (role === 'chords' || role === 'pad')) {
      const { struct } = role === 'chords' ? chordCell(ns, ref, bpb) : { struct: '' };
      body = chordsDep(`chords${struct}.s("${sound}")${tail}`);
      fn = multi;
    } else if (hasHarmony && role === 'arp') {
      const a = arpFigure(ns, ref, bpb);
      body = chordsDep(`chords.arp("${a?.fig || '[0 1 2 3]*4'}")${a?.shift ? `.transpose(${a.shift})` : ''}.s("${sound}")${tail}`);
      fn = multi;
    } else if (role === 'chords' || role === 'pad') {
      body = chordNotesIdea(ns, ref, bpb, sound).body + tail;
    } else {
      body = melodyIdea(ns, ref, bpb, sc, flats, sound).body + tail;
    }
    // a part doubling another part's line (an octave apart) is written as that part
    const line = /^n\("([^"]*)"\)\.scale\("[^"]*?(-?\d+):/.exec(body);
    const twin = line && defs.find((d) => d.line && d.line[1] === line[1]);
    if (twin) body = `${twin.name}${line[2] !== twin.line[2] ? `.transpose(${12 * (line[2] - twin.line[2])})` : ''}.s("${sound}")${tail}`;
    defs.push({ name, trackId: t.id, body, fn, line: twin ? null : line, chordal: role === 'chords' && /struct\(/.test(body) });
  }

  // ---- variants per section
  const sweepOf = (t, s) => {
    for (const lane of t.automation || []) {
      if (lane.enabled === false || !/:cutoff$/.test(lane.target || '') || !lane.points?.length) continue;
      const a = s.start, b = s.start + s.bars * bpb;
      const v0 = valueAt(lane.points, a + 0.01), v1 = valueAt(lane.points, b - 0.01);
      if (!(v0 > 1) || !(v1 > 1)) continue;
      const hz = (v) => Number(Math.min(16000, v).toPrecision(2));
      // the lane's shape across the section (not just its ends): a ride that rises and falls inside a section
      // (a 303 cutoff ride, a filter LFO) is a moving filter, never its endpoints' average as a static low-pass
      const N = Math.max(8, Math.min(64, s.bars * 2));
      const vs = Array.from({ length: N + 1 }, (_, i) => valueAt(lane.points, a + 0.01 + (b - a - 0.02) * (i / N)));
      const lo = Math.min(...vs), hi = Math.max(...vs);
      let turns = 0;
      for (let i = 2, dir = 0; i <= N; i++) {
        const d = Math.sign(vs[i] - vs[i - 1]);
        if (d && dir && d !== dir) turns++;
        if (d) dir = d;
      }
      if (hi > lo * 1.5 && turns >= 1) {
        const per = (s.bars * 2) / (turns + 1); // bars per cycle, snapped to a phrase length (1 / 2 / 4 / 8 / 16 …)
        return `.lpf(sine.rangex(${hz(lo)}, ${hz(hi)}).slow(${2 ** Math.max(0, Math.round(Math.log2(per)))}))`;
      }
      // a short opening ramp (a hook fading in over its first bar or two) leaves the filter open for the section
      const open = vs.findIndex((v) => v >= v1 * 0.9);
      if (v1 > v0 * 1.5 && v1 >= 15000 && open >= 0 && open / N < 0.5) return '';
      if (v1 > v0 * 1.5) return `.lpf(saw.rangex(${hz(v0)}, ${hz(v1)}).slow(${s.bars}))`;
      if (v0 > v1 * 1.5) return `.lpf(isaw.rangex(${hz(v1)}, ${hz(v0)}).slow(${s.bars}))`;
      if (Math.max(v0, v1) < 15000) return `.lpf(${Math.round((v0 + v1) / 2 / 100) * 100})`;
    }
    return '';
  };
  const entries = sections.map((s, si) => {
    const items = [];
    for (const d of defs) {
      const t = live.find((x) => x.id === d.trackId);
      const p = presence(t, s);
      if (!p.n) continue;
      const ref = presence(t, refOf.get(t.id));
      let expr = d.fn ? `${d.name}(${hName.get(harmony.keys[si]) || hName.get(hkeys[0])})` : d.name;
      const mods = [];
      const half = Math.floor(s.bars / 2);
      let dens = p.perBar;
      if (s.bars >= 4 && s.bars % 2 === 0 && p.first >= half * bpb - 0.5) { mods.push(`.mask("<0!${half} 1!${half}>")`); dens *= 2; }
      const sw = sweepOf(t, s);
      if (sw) mods.push(sw);
      const ratio = ref.perBar ? dens / ref.perBar : 1;
      // calmer sections: chord parts hold their chords, the others play sparser
      if (ratio < 0.7) mods.push(d.chordal ? '.struct("x")' : `.degradeBy(${num(r1(clamp(1 - ratio, 0.2, 0.8)))})`);
      if (s.mod && roleOf(t) !== 'drums') mods.push(`.transpose(${s.mod})`);
      const vr = ref.vel ? p.vel / ref.vel : 1;
      if (vr < 0.7 && mods.length < 2) mods.push(`.gain(${num(r1(clamp(vr, 0.2, 1)))})`);
      items.push({ base: expr, mods: mods.slice(0, 3) });
    }
    return { bars: s.bars, ...groupItems(items), name: s.name || `part ${si + 1}` };
  });

  // merge neighbours that play the same thing
  const merged = [];
  for (const e of entries) {
    const l = merged[merged.length - 1];
    if (l && l.items.join() === e.items.join() && l.tail === e.tail && !/\.(slow|mask)\(/.test(e.items.join() + e.tail)) { l.bars += e.bars; l.names.push(e.name); } else merged.push({ ...e, names: [e.name] });
  }

  // ---- write
  const keyName = `${(flats ? NAMES_FLAT : NAMES_SHARP)[mod(sc.root, 12)]} ${String(project.key?.scale || 'major').replace(/-/g, ' ')}`;
  const genre = getGenre(project.genre)?.name;
  const secs = total / bpb * bpb * 60 / (project.bpm || 120);
  const lines = [
    `// ${genre ? `${genre} sketch` : project.name || 'daW³ song'} — ${keyName} · ${project.bpm} BPM${arranged ? ` · ${fmtTime(secs)}` : ''}`,
    exp ? '// made with daW³ — one idea per part, arranged at the bottom' : '// live-coder view: one idea per part. Edit + Ctrl+Enter re-renders the parts you changed.',
    `setcpm(${project.bpm}/${bpb})`,
    '',
  ];
  const hdefs = [];
  if (hkeys.length === 1) hdefs.push(['chords', `chord("${cycleMini(harmony.table[hkeys[0]])}").voicing()`]);
  else if (multi) {
    for (const k of hkeys) hdefs.push([hName.get(k), `"${cycleMini(harmony.table[k])}"`]);
    hdefs.push(['chords', 'h => chord(h).voicing()']);
  }
  const all = [...hdefs.map(([n, b]) => ({ name: n, body: b })), ...defs];
  const w = Math.max(...all.map((d) => d.name.length).filter((l) => l <= 6), 1);
  const blocks = [];
  let code = lines.join('\n') + '\n';
  for (const d of all) {
    const start = code.length;
    code += `const ${d.name.padEnd(w)} = ${d.body}\n`;
    if (d.trackId) {
      const t = live.find((x) => x.id === d.trackId);
      blocks.push({ kind: 'instrument', trackId: t.id, label: d.name, name: t.name, color: t.color, start, end: code.length });
    }
  }
  if (codeTracks.length) code += `// + code track${codeTracks.length > 1 ? 's' : ''} ${codeTracks.map((t) => `"${t.name}"`).join(', ')} (edit in ${codeTracks.length > 1 ? 'their' : 'its'} own tab)\n`;
  code += '\n';
  const arrStart = code.length;
  const stackOf = (items, tail = '') => (!items.length ? 'silence' : items.length === 1 ? items[0] + tail : `stack(${items.join(', ')})${tail}`);
  if (!arranged) {
    code += `$: ${stackOf(merged[0]?.items || [], merged[0]?.tail)}\n`;
  } else {
    const rows = merged.map((e) => {
      const rep = e.names.length > 1 && e.names.every((n) => n.replace(/\s*\d+$/, '') === e.names[0].replace(/\s*\d+$/, ''));
      const label = rep ? `${e.names[0].replace(/\s*\d+$/, '')} ×${e.names.length}` : e.names.join(' + ');
      const text = `[${e.bars}, ${stackOf(e.items, e.tail)}],`;
      if (text.length <= 76 || e.items.length < 2) return { text, rest: [], label: label.toLowerCase() };
      // long stacks continue on indented lines
      const out = [`[${e.bars}, stack(`];
      const its = e.items.map((x, i) => x + (i < e.items.length - 1 ? ',' : `)${e.tail}],`));
      for (const x of its) {
        const l = out[out.length - 1];
        if (l.length + x.length + 1 > (out.length === 1 ? 78 : 94) && !/[(,]$/.test(l.slice(-1)) === false && l.trim() !== `[${e.bars}, stack(`) out.push(`  ${x}`);
        else out[out.length - 1] = l + (/\($/.test(l) ? '' : ' ') + x;
      }
      return { text: out[0], rest: out.slice(1), label: label.toLowerCase() };
    });
    const cw = Math.min(76, Math.max(...rows.map((r) => r.text.length)));
    code += '$: arrange(\n' + rows.map((r) => [`  ${r.text.padEnd(cw)}  // ${r.label}`, ...r.rest.map((x) => `  ${x}`)].join('\n')).join('\n') + '\n)\n';
  }
  blocks.push({ kind: 'arrange', start: arrStart, end: code.length });
  const roles = Object.fromEntries(defs.map((d) => [d.name, d.trackId]));
  return { code, mode: 'live', blocks, roles, labels: {}, sections: merged.map((e) => ({ name: e.names[0], bars: e.bars })) };
}

// --------------------------------------------------------------------------------------------- apply back

/** Top-level statements: { decls: Map(name -> {text, start, end, fn}), arrange: text|null, cpm: text|null }. */
function parseLive(code) {
  const items = splitTopLevel(code);
  const decls = new Map();
  let arrange = null, cpm = null;
  const order = [];
  for (const it of items) {
    const text = code.slice(it.start, it.end);
    if (it.kind === 'decl' && it.name) {
      const rhs = text.slice(text.indexOf('=') + 1);
      decls.set(it.name, { text, rhs: norm(rhs), start: it.start, end: it.end, fn: /^\s*(\(?[\w\s,$]*\)?)\s*=>/.test(rhs) });
      order.push(it);
    } else if (it.kind === 'label') arrange = text.replace(/^\s*\$:\s*/, '');
    else if (/^\s*setcp[ms]\s*\(/.test(text)) cpm = text;
  }
  return { decls, arrange, cpm };
}
const norm = (s) => stripComments(String(s || '')).replace(/\s+/g, '');

function splitArgs(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** arrange(...) text -> [{bars, items: [expr]}] | null. */
function parseArrangeEntries(text) {
  const t = norm(text || '');
  const m = /^arrange\((.*)\)$/.exec(t);
  if (!m) return t ? [{ bars: null, items: stackItems(t) }] : null;
  return splitArgs(m[1]).map((a) => {
    const inner = a.replace(/^\[/, '').replace(/\]$/, '');
    const [n, ...rest] = splitArgs(inner);
    return { bars: Number(n), items: stackItems(rest.join(',')) };
  });
}
function stackItems(e) {
  if (e === 'silence') return [];
  if (!e.startsWith('stack(')) return [e];
  let depth = 0, q = null, close = -1;
  for (let i = 5; i < e.length; i++) {
    const c = e[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return [e];
  const tail = e.slice(close + 1);
  return splitArgs(e.slice(6, close)).flatMap((x) => stackItems(x).map((y) => y + tail));
}
/** The arrangement of live-coder code: [{bars, items: [expr]}] (nested stacks expanded, their modifiers kept). */
export const liveArrangement = (code) => parseArrangeEntries(parseLive(code).arrange) || [];
const headIdent = (e) => /^([A-Za-z_$][\w$]*)/.exec(e)?.[1] || null;
const identsIn = (s) => new Set(stripComments(s).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '').match(/[A-Za-z_$][\w$]*/g) || []);

function eventsToNotes(events, bpb, drums) {
  const out = [];
  for (const ev of events) {
    const v = ev.value || {};
    let pitch;
    if (drums) {
      pitch = v.s != null ? drumPitch(String(v.s)) : null;
      if (pitch == null && typeof v.note === 'number') pitch = Math.round(v.note);
    } else pitch = typeof v.note === 'number' ? Math.round(v.note) : null;
    if (pitch == null || !Number.isFinite(pitch)) continue;
    const len = Number.isFinite(ev.duration) ? ev.duration : (ev.end - ev.begin) * (v.clip ?? v.legato ?? 1);
    const vel = clamp((v.velocity ?? 1) * (v.gain ?? 1) * 0.8, 0.05, 1);
    out.push({ pitch, start: ev.begin * bpb, dur: Math.max(0.05, len * bpb), vel: Math.round(vel * 100) / 100 });
  }
  return out;
}

const hashStr = (s) => [...String(s)].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 7);

/**
 * Applies edited live-coder code to the project (mutates it). Unedited code changes nothing.
 * @returns {{changed: boolean, changes: string[], warnings: string[], muted: string[], complex: object[], error?: string, tracks: string[]}}
 */
export function applyLiveCode(project, code, opts = {}) {
  const rep = { changed: false, changes: [], warnings: [], muted: [], complex: [], tracks: [] };
  const orig = opts.original || songToLiveCode(project);
  if (norm(code) === norm(orig.code)) return rep;
  const res = evaluate(code);
  if (res.error) return { ...rep, error: res.error };
  const bpb = beatsPerBar(project);
  const A = parseLive(orig.code), B = parseLive(code);

  // tempo
  if (B.cpm && norm(B.cpm) !== norm(A.cpm || '') && res.cps > 0) {
    const bpm = Math.round(res.cps * 60 * bpb * 100) / 100;
    if (Math.abs(bpm - project.bpm) > 1e-3) { project.bpm = clamp(bpm, 20, 400); rep.changes.push(`Tempo → ${project.bpm} BPM`); rep.changed = true; }
  }

  // which parts changed: their const, anything it uses, or their place in the arrangement
  const memo = new Map();
  const dirty = (name, seen = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name)) return false;
    seen.add(name);
    const a = A.decls.get(name), b = B.decls.get(name);
    let d = !a || !b || a.rhs !== b.rhs;
    if (!d && b) for (const id of identsIn(b.text)) if (id !== name && B.decls.has(id) && dirty(id, seen)) { d = true; break; }
    memo.set(name, d);
    return d;
  };
  const ea = parseArrangeEntries(A.arrange) || [], eb = parseArrangeEntries(B.arrange) || [];
  const barsChanged = ea.length !== eb.length || ea.some((e, i) => e.bars !== eb[i].bars);
  const usage = (entries, name) => entries.map((e) => e.items.filter((x) => headIdent(x) === name).join('|')).join(';');
  const roleNames = Object.keys(orig.roles);
  const todo = roleNames.filter((n) => B.decls.has(n) && (barsChanged || dirty(n) || usage(ea, n) !== usage(eb, n)));
  for (const e of eb) for (const x of e.items) {
    const h = headIdent(x);
    if (h && !orig.roles[h] && B.decls.has(h) && !A.decls.has(h)) rep.warnings.push(`"${h}" is a new part — it isn't mapped to a track. Add it as a code track to hear it in the project.`);
  }
  for (const n of roleNames) if (!B.decls.has(n)) rep.warnings.push(`"${n}" was removed from the code — its track keeps its notes (delete the track to remove it).`);
  if (!todo.length) return rep;

  // the sections as the code arranges them
  const secs = [];
  let pos = 0;
  if (eb.length && eb[0].bars !== null) for (const e of eb) { secs.push({ start: pos * bpb, bars: e.bars }); pos += e.bars; } else secs.push({ start: 0, bars: Math.max(1, Math.round(songLengthBeats(project) / bpb)) });
  const totalCycles = secs.reduce((a, s) => a + s.bars, 0);
  const names = (project.markers || []).slice().sort((a, b) => a.beat - b.beat);
  const secName = (s) => names.filter((m) => m.beat <= s.start + EPS).pop()?.name || `Bar ${s.start / bpb + 1}`;

  const stmts = splitTopLevel(code);
  for (const name of todo) {
    const track = project.tracks.find((t) => t.id === orig.roles[name]);
    if (!track) continue;
    // render this part alone: the other parts are silenced
    let iso = '';
    let cur = 0;
    for (const it of stmts) {
      if (it.kind === 'decl' && it.name && it.name !== name && orig.roles[it.name]) {
        iso += code.slice(cur, it.start) + `const ${it.name} = ${B.decls.get(it.name).fn ? '(..._) => silence' : 'silence'}`;
        cur = it.end;
      }
    }
    iso += code.slice(cur);
    const r = evaluate(iso);
    if (r.error) { rep.warnings.push(`${track.name}: ${r.error}`); continue; }
    const drums = track.instrument?.type === 'drums';
    const notes = eventsToNotes(queryEvents(r, 0, totalCycles), bpb, drums);
    // replace the track's clips / patterns with one pattern per section
    const oldPats = new Set(Object.values(project.patterns).filter((p) => p.trackId === track.id).map((p) => p.id));
    project.clips = project.clips.filter((c) => c.trackId !== track.id || c.type === 'audio');
    const made = [];
    secs.forEach((s, i) => {
      const a = s.start, b = s.start + s.bars * bpb;
      const ns = notes.filter((n) => n.start >= a - EPS && n.start < b - EPS).map((n) => ({ ...n, start: n.start - a, dur: Math.min(n.dur, b - n.start) }));
      if (!ns.length) { made.push(null); return; }
      const role = drums ? 'drums' : track.role || 'lead';
      if (role !== 'fx') applyGroove(ns, { genre: project.genre, role, bpm: project.bpm, rng: createRng(hashStr(`${track.id}|${i}|${project.seed ?? 0}`)), length: b - a });
      const pat = createPattern(track.id, { name: `${track.name} – ${secName(s)}`, length: b - a, color: track.color, notes: ns.map((n) => createNote(n.pitch, Math.max(0, n.start), n.dur, n.vel)) });
      project.patterns[pat.id] = pat;
      project.clips.push(createClip(track.id, { patternId: pat.id, start: a, length: b - a, name: secName(s) }));
      made.push(pat);
    });
    const scenes = project.scenes || [];
    const sameForm = scenes.length === secs.length;
    for (let i = 0; i < scenes.length; i++) {
      const slots = scenes[i].slots || (scenes[i].slots = {});
      if (sameForm && made[i]) slots[track.id] = made[i].id; else delete slots[track.id];
    }
    const kept = new Set([...project.clips.map((c) => c.patternId), ...scenes.flatMap((s) => Object.values(s.slots || {}))]);
    for (const id of oldPats) if (!kept.has(id)) { delete project.patterns[id]; if (project.patternHarmony) delete project.patternHarmony[id]; }
    const best = made.filter(Boolean).sort((x, y) => y.notes.length - x.notes.length)[0];
    track.activePatternId = best ? best.id : null;
    rep.tracks.push(track.id);
    rep.changes.push(`${track.name}: re-rendered from "${name}" (${notes.length} notes)`);
    rep.changed = true;
  }
  return rep;
}
