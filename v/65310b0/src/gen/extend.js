// Extend an existing song (pure): append / insert idiomatic new sections that sound like the same song — the
// existing patterns are re-used as varied copies (drum variants with fills / builds, melody variations of the hook
// fitted to the section's chords, octave lifts, an arp entering), the same tracks / instruments / mix / sends, and
// automation lanes continue (rides copied per section, the master fade moves to the new end).
// Works on generated songs (markers + project.sections + patternHarmony) and on hand-made ones (markers, or the
// last bars of every track as a fallback).
//
//   planExtension(project, opts) -> {mode, at, items:[{name, label, kind, bars, start}], addBars, addBeats, addMinutes,
//                                    oldEnd, newEnd, shiftFrom, summary}
//   extendSong(project, opts)    -> plan + {patterns, clips, markers, scenes, automation:[{ownerId, target, points}],
//                                    patternHarmony, sections, masterFade}
//   applyExtension(project, ext) -> mutates the project (shifts later material when inserting, adds everything)
//   removeSection(project, {markerId | start, end}) -> mutates: removes a section and closes the gap
// opts: {bars | minutes | toMinutes, mode: 'continue'|'repeat-last'|'extend-outro'|'insert-section', at (beat) | markerId,
//        kind ('break'|'build'|'main'|'verse'|'solo'|...) / templateMarkerId (insert-section), seed}
import { createRng, uid, clamp } from '../core/util.js';
import { createPattern, createClip, createNote, createScene, beatsPerBar } from '../core/model.js';
import { valueAt } from '../core/automation.js';
import { mod12, chordPitchClasses, scalePitchClasses, snapToScale, resolveScaleId } from '../theory/index.js';
import { getGenre } from './genres.js';
import { sectionKind } from './form.js';
import { isDrumTrack, detectPatternChords, chordsToProgression } from './analyze.js';
import { fitNotesToHarmony } from './fit.js';
import { arpeggiate } from './arp.js';

const EPS = 1e-6;
const r4 = (x) => Math.round(x * 10000) / 10000;
const hashStr = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ [...String(x)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7), 2654435761) >>> 0), 0x9e3779b9);

export const EXTEND_MODES = {
  continue: { label: 'Continue the song', hint: 'Appends idiomatic new sections (EDM: breakdown → build → drop → outro; songs: bridge → final choruses; loops: new variations)' },
  'repeat-last': { label: 'Repeat the last section', hint: 'Plays the last section again with variations' },
  'extend-outro': { label: 'Extend the outro', hint: 'A longer ending: a DJ outro / fade that peels layers away' },
  'insert-section': { label: 'Insert a section', hint: 'Inserts a new section before a marker and moves everything after it' },
};

const ELECTRONIC_FAMILIES = new Set(['house', 'techno', 'trance', 'bass', 'dnb', 'garage', 'breaks', 'hard', 'industrial', 'experimental']);

// ------------------------------------------------------------------------------------------------ song analysis

/** End of the arrangement (last clip end) rounded up to a bar. */
export function songEnd(project) {
  const bpb = beatsPerBar(project);
  const end = (project.clips || []).reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return Math.ceil(end / bpb - EPS) * bpb;
}

/** Role of a track: its generator role, else guessed (drums / bass / chords / lead) from its notes. */
export function trackRole(project, t) {
  if (!t) return null;
  if (isDrumTrack(t)) return 'drums';
  if (t.role && t.role !== 'audio' && t.role !== 'code') return t.role;
  if (t.type !== 'instrument') return t.type === 'audio' ? 'audio' : null;
  const notes = Object.values(project.patterns || {}).filter((p) => p.trackId === t.id).flatMap((p) => p.notes || []);
  if (!notes.length) return 'lead';
  const ps = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const med = ps[Math.floor(ps.length / 2)];
  const onsets = new Map();
  for (const n of notes) { const k = Math.round(n.start * 8); onsets.set(k, (onsets.get(k) || 0) + 1); }
  const poly = [...onsets.values()].filter((v) => v >= 3).length / Math.max(1, onsets.size);
  if (med < 52 && poly < 0.3) return 'bass';
  if (poly >= 0.4) return 'chords';
  return 'lead';
}

/**
 * Sections of a song: from the markers (a section runs to the next marker), else 8-bar parts.
 * -> [{index, name, kind, start, end, bars, markerId}]
 */
export function songSections(project) {
  const bpb = beatsPerBar(project);
  const end = songEnd(project);
  const ms = [...(project.markers || [])].filter((m) => m.beat < end - EPS).sort((a, b) => a.beat - b.beat)
    .filter((m, i, a) => i === 0 || m.beat > a[i - 1].beat + EPS);
  const out = [];
  if (ms.length) {
    if (ms[0].beat > EPS) out.push({ name: 'Start', start: 0, end: ms[0].beat, markerId: null });
    ms.forEach((m, i) => out.push({ name: m.name || 'Section', start: m.beat, end: ms[i + 1]?.beat ?? end, markerId: m.id }));
  } else if (end > 0) {
    const part = end >= 16 * bpb ? 8 * bpb : 4 * bpb;
    for (let a = 0, k = 1; a < end - EPS; a += part, k++) out.push({ name: `Part ${k}`, start: a, end: Math.min(end, a + part), markerId: null });
  }
  return out.map((s, index) => ({ ...s, index, kind: sectionKind(s.name), bars: (s.end - s.start) / bpb }));
}

const baseName = (name) => String(name || 'Section').replace(/\s+\d+$/, '').replace(/\s*\(.*\)\s*$/, '').trim() || 'Section';

/** "Drop" -> "Drop 3" when Drop and Drop 2 exist (labels like the generator's). */
function nextLabel(names, base) {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: (\\d+))?$`, 'i');
  let n = 0;
  for (const x of names) { const m = re.exec(x); if (m) n = Math.max(n, m[1] ? Number(m[1]) : 1); }
  names.push(n ? `${base} ${n + 1}` : base);
  return names[names.length - 1];
}

function styleOf(project) {
  const g = getGenre(project.genre);
  const secs = songSections(project);
  const kinds = new Set(secs.map((s) => s.kind));
  const names = secs.map((s) => s.name.toLowerCase()).join(' ');
  const electronic = (g && ELECTRONIC_FAMILIES.has(g.family)) || /drop|peak|breakdown/.test(names) || (kinds.has('build') && kinds.has('main') && !/chorus|verse/.test(names));
  const jazz = g?.family === 'jazz' || g?.family === 'blues' || /solo|head/.test(names) && !/chorus/.test(names);
  const song = !electronic && !jazz && /verse|chorus|hook/.test(names) && kinds.has('main');
  return { g, electronic, jazz, song, hiphop: song && /hook/.test(names) && !/chorus/.test(names), loop: !electronic && !jazz && !song };
}

/** Bars from {bars | minutes | toMinutes} (multiples of 4, at least 4). */
export function amountToBars(project, opts = {}) {
  const bpb = beatsPerBar(project);
  let bars = opts.bars;
  if (bars == null && opts.minutes != null) bars = (opts.minutes * project.bpm) / bpb;
  if (bars == null && opts.toMinutes != null) bars = (opts.toMinutes * project.bpm) / bpb - songEnd(project) / bpb;
  bars = Math.round((bars || 16) / 4) * 4;
  return Math.max(4, bars);
}

// ------------------------------------------------------------------------------------------------ planning

/** Pick the existing section an item is modelled on: the latest of that kind, else a stand-in with a role filter. */
function templateFor(secs, kind, { preferName } = {}) {
  const body = secs.filter((s) => s.end - s.start > EPS);
  const byName = preferName && [...body].reverse().find((s) => baseName(s.name).toLowerCase() === preferName.toLowerCase());
  if (byName) return { sec: byName };
  const same = [...body].reverse().find((s) => s.kind === kind);
  if (same) return { sec: same };
  const main = [...body].reverse().find((s) => s.kind === 'main') || [...body].reverse().find((s) => s.kind === 'verse') || body[body.length - 1];
  if (!main) return null;
  // stand-ins: a breakdown = the main section's melodic layers without drums / bass; a build = drums + chords/pads/arp
  const roles = { break: ['pad', 'chords', 'lead', 'arp', 'keys'], build: ['drums', 'chords', 'pad', 'arp', 'fx'], verse: ['drums', 'bass', 'chords', 'pad'], outro: null, intro: null }[kind];
  return { sec: main, roles: roles || null };
}

function existingNames(project) { return (project.markers || []).map((m) => m.name); }

/**
 * Plan the new sections (no material yet). Deterministic: the same opts give the same plan (preview == result).
 */
export function planExtension(project, opts = {}) {
  const mode = EXTEND_MODES[opts.mode] ? opts.mode : 'continue';
  const bpb = beatsPerBar(project);
  const secs = songSections(project);
  const oldEnd = songEnd(project);
  const bars = amountToBars(project, opts);
  const st = styleOf(project);
  const names = existingNames(project);
  // trailing outro sections stay the ending: new body sections go in front of them
  let tail = secs.length;
  while (tail > 0 && secs[tail - 1].kind === 'outro') tail--;
  const outroStart = tail < secs.length ? secs[tail].start : null;
  const lastBody = secs[tail - 1] || secs[secs.length - 1] || null;
  const raw = []; // {base, kind, bars, tpl, peel?, enter?}
  const nameOfKind = (kind, dflt) => {
    const s = [...secs].reverse().find((x) => x.kind === kind);
    return s ? baseName(s.name) : dflt;
  };
  let at = oldEnd;
  if (mode === 'extend-outro') {
    // a longer ending built from the last full section, peeling layers away; it plays before the existing (sparse)
    // outro sections, or is appended when the song has none
    if (outroStart != null) at = outroStart;
    const tpl = lastBody;
    raw.push({ base: 'Outro', kind: 'outro', bars, tpl: tpl ? { sec: tpl } : null, peel: true });
  } else if (mode === 'insert-section') {
    const marker = opts.markerId ? (project.markers || []).find((m) => m.id === opts.markerId) : null;
    at = marker ? marker.beat : clamp(Math.round((opts.at ?? oldEnd) / bpb) * bpb, 0, oldEnd);
    const like = opts.templateMarkerId ? secs.find((s) => s.markerId === opts.templateMarkerId) : null;
    let kind = like ? like.kind : opts.kind || (st.electronic ? 'break' : st.jazz ? 'main' : 'break');
    if (kind === 'solo') kind = 'main';
    const base = like ? baseName(like.name) : opts.name || (opts.kind === 'solo' || (st.jazz && kind === 'main') ? 'Solo' : kind === 'break' ? (st.electronic ? nameOfKind('break', 'Breakdown') : 'Bridge') : kind === 'build' ? nameOfKind('build', 'Build') : kind === 'main' ? nameOfKind('main', st.electronic ? 'Drop' : 'Chorus') : kind === 'verse' ? nameOfKind('verse', 'Verse') : kind === 'intro' ? 'Intro' : 'Outro');
    const tpl = like ? { sec: like } : templateFor(secs, kind, { preferName: base });
    raw.push({ base, kind, bars: opts.bars == null && opts.minutes == null && tpl ? Math.max(4, Math.round(tpl.sec.bars)) : bars, tpl });
  } else {
    // continue / repeat-last: before the outro when the song has one, else appended
    if (outroStart != null) at = outroStart;
    let cycle;
    let first = null;
    if (mode === 'repeat-last') {
      cycle = lastBody ? [{ base: baseName(lastBody.name), kind: lastBody.kind, bars: Math.max(4, Math.round(lastBody.bars)), tpl: { sec: lastBody } }] : [];
    } else if (st.electronic) {
      const bk = templateFor(secs, 'break'), bd = templateFor(secs, 'build'), mn = templateFor(secs, 'main');
      cycle = [
        { base: nameOfKind('break', 'Breakdown'), kind: 'break', bars: 16, tpl: bk },
        { base: nameOfKind('build', 'Build'), kind: 'build', bars: 8, tpl: bd },
        { base: nameOfKind('main', 'Drop'), kind: 'main', bars: 32, tpl: mn, enter: true },
      ];
    } else if (st.jazz) {
      const mn = templateFor(secs, 'main', { preferName: 'Solo' });
      cycle = [{ base: mn ? baseName(mn.sec.name) : 'Solo', kind: 'main', bars: mn ? Math.max(4, Math.round(mn.sec.bars)) : 16, tpl: mn }];
    } else if (st.song) {
      const mn = templateFor(secs, 'main');
      const chorus = mn ? baseName(mn.sec.name) : 'Chorus';
      const cb = mn ? Math.max(8, Math.round(mn.sec.bars)) : 8;
      const vs = templateFor(secs, 'verse', { preferName: 'Verse' });
      const verse = vs && vs.sec.kind === 'verse' && !vs.roles ? { base: baseName(vs.sec.name), kind: 'verse', bars: Math.max(8, Math.round(vs.sec.bars)), tpl: vs } : null;
      const pr = secs.find((x) => /pre/i.test(x.name)) ? templateFor(secs, 'build', { preferName: baseName([...secs].reverse().find((x) => /pre/i.test(x.name)).name) }) : null;
      const pre = pr ? { base: baseName(pr.sec.name), kind: 'build', bars: Math.round(pr.sec.bars), tpl: pr } : null;
      const ch = (lift) => ({ base: chorus, kind: 'main', bars: cb, tpl: mn, enter: true, lift });
      if (st.hiphop) cycle = [verse, ch(false)].filter(Boolean);
      else {
        // bridge -> final double chorus, then (when more is wanted) verse -> pre -> chorus rounds
        const hasBridge = secs.some((x) => /bridge/i.test(x.name));
        const br = templateFor(secs, 'break', { preferName: hasBridge ? 'Bridge' : undefined });
        first = [{ base: 'Bridge', kind: 'break', bars: br?.sec && /bridge/i.test(br.sec.name) ? Math.max(4, Math.round(br.sec.bars)) : 8, tpl: br }, ch(false), ch(true)];
        cycle = [verse, pre, ch(true)].filter(Boolean);
      }
    } else {
      // loop-based: new variations of the body sections (the last two distinct ones, alternating)
      const body = secs.filter((s) => s.kind !== 'intro' && s.kind !== 'outro');
      const picks = [];
      for (let i = body.length - 1; i >= 0 && picks.length < 2; i--) if (!picks.some((p) => baseName(p.name) === baseName(body[i].name))) picks.unshift(body[i]);
      cycle = (picks.length ? picks : secs.slice(-1)).map((s) => ({ base: baseName(s.name), kind: s.kind, bars: Math.max(4, Math.round(s.bars)), tpl: { sec: s }, enter: s.kind === 'main' }));
    }
    // an ending when the song has none (continue only), ~a quarter of the new part, 8–16 bars
    let outroBars = 0;
    if (mode === 'continue' && outroStart == null && bars >= 24) outroBars = clamp(Math.round(bars / 4 / 8) * 8, 8, 16);
    let left = bars - outroBars;
    const seq = (k) => (first && k < first.length ? first[k] : cycle[(k - (first ? first.length : 0)) % cycle.length]);
    const cycleBars = cycle.reduce((a, c) => a + c.bars, 0);
    let tag = null; // song form: what doesn't fit a whole verse round becomes more chorus (an outro chorus / vamp)
    for (let k = 0; left > 0 && cycle.length && k < 64; k++) {
      const inCycle = !first || k >= first.length;
      if (st.song && !st.hiphop && inCycle && (k - (first ? first.length : 0)) % cycle.length === 0 && left < cycleBars) tag = cycle[cycle.length - 1];
      const c = tag || seq(k);
      let b = Math.min(c.bars, left);
      if (left - b > 0 && left - b < 4) b = left; // no 1–3 bar leftovers
      raw.push({ ...c, bars: b, rep: Math.floor(k / cycle.length) });
      left -= b;
    }
    // phrasing: a short remainder (< 8 bars, or a build that would lead nowhere) joins the section before it
    const lastRaw = raw[raw.length - 1];
    if (raw.length > 1 && (lastRaw.kind === 'build' || (lastRaw.bars < 8 && lastRaw.bars < lastRaw.tpl?.sec?.bars))) {
      raw.pop();
      raw[raw.length - 1].bars += lastRaw.bars;
    }
    if (outroBars) {
      const tpl = secs[secs.length - 1];
      raw.push({ base: 'Outro', kind: 'outro', bars: outroBars, tpl: tpl ? { sec: tpl } : null, peel: true });
    }
  }
  let beat = at;
  const items = raw.filter((r) => r.tpl && r.bars > 0).map((r) => {
    const it = { ...r, label: nextLabel(names, r.base), start: beat, beats: r.bars * bpb };
    beat += it.beats;
    return it;
  });
  const addBeats = beat - at;
  const shiftFrom = at < oldEnd - EPS ? at : null;
  const addMinutes = (addBeats / project.bpm);
  const summary = items.length
    ? `Adds ${items.map((i) => `${i.label} (${i.bars})`).join(' → ')}${shiftFrom != null && mode !== 'insert-section' ? ` before ${secs.find((s) => Math.abs(s.start - at) < EPS)?.name || 'the ending'}` : ''} = +${addBeats / bpb} bars / +${fmt(addMinutes)}`
    : 'Nothing to extend (the song has no clips yet)';
  return { mode, at, items, addBars: addBeats / bpb, addBeats, addMinutes, oldEnd, newEnd: oldEnd + addBeats, shiftFrom, summary, bpb };
}

function fmt(min) {
  const s = Math.max(0, Math.round(min * 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ material

/** Clips of a track inside [a, b), cropped to the range: [{clip, rel, length, offset}] */
function clipsIn(project, trackId, a, b) {
  const out = [];
  for (const c of project.clips) {
    if (c.trackId !== trackId) continue;
    const s0 = Math.max(a, c.start), s1 = Math.min(b, c.start + c.length);
    if (s1 - s0 <= EPS) continue;
    out.push({ clip: c, rel: s0 - a, length: s1 - s0, offset: (c.offset || 0) + (s0 - c.start) });
  }
  return out.sort((x, y) => x.rel - y.rel);
}

/** Progression objects for fitNotesToHarmony / arpeggiate from a pattern's harmony (or its section's chord track). */
function harmonyOf(project, pat, sec, chordTrack) {
  const ph = project.patternHarmony?.[pat.id];
  if (ph?.harmony?.length) {
    return {
      length: ph.length || pat.length, key: ph.key || project.key, harmony: ph.harmony,
      prog: ph.harmony.map((c) => ({ startBeat: c.startBeat, durBeats: c.durBeats, chord: { root: c.root, type: c.type, bass: c.bass ?? undefined } })),
    };
  }
  if (!chordTrack || !sec) return null;
  const c = clipsIn(project, chordTrack.id, sec.start, sec.end)[0];
  const cp = c && project.patterns[c.clip.patternId];
  if (!cp || c.rel > EPS) return null;
  const found = chordsToProgression(detectPatternChords(cp, beatsPerBar(project)), project.key?.root ?? 0);
  if (!found.length) return null;
  return {
    length: cp.length, key: project.key, prog: found,
    harmony: found.map((x) => ({ startBeat: x.startBeat, durBeats: x.durBeats, root: x.chord.root, type: x.chord.type, bass: x.chord.bass ?? null, name: x.chord.name })),
  };
}

const DRUM = { kick: 36, snare: 38, clap: 39, hat: 42, open: 46, crash: 49, ride: 51 };

/** A drum variant: hat / ghost changes, a fill (or a build roll) at the end, a crash at the top. */
function varyDrums(notes, { len, bpb, rng, kind, fill, crash, build, peelKick }) {
  let out = notes.map((n) => ({ ...n }));
  const has = (p) => out.some((n) => n.pitch === p);
  const snare = has(DRUM.snare) ? DRUM.snare : has(DRUM.clap) ? DRUM.clap : DRUM.snare;
  // hats: thin a few / add an open hat on a couple of off-beats (only in the bars that have hats)
  for (const n of out) if (n.pitch === DRUM.hat && rng.chance(0.08)) n.vel = r4(n.vel * 0.7);
  const bars = Math.round(len / bpb);
  for (let b = 1; b < bars; b += 2) {
    if (!rng.chance(0.5)) continue;
    const t = b * bpb + bpb - 0.5;
    if (out.some((n) => n.pitch === DRUM.hat && Math.abs(n.start - t) < 0.05)) {
      out = out.filter((n) => !(n.pitch === DRUM.hat && Math.abs(n.start - t) < 0.05));
      out.push({ pitch: DRUM.open, start: t, dur: 0.4, vel: 0.62 });
    }
  }
  if (peelKick) out = out.filter((n) => n.pitch !== DRUM.kick || n.start < len - peelKick);
  if (build) {
    // snare roll: quarters -> 8ths -> 16ths over the last 4 bars, rising; a beat of silence before the drop
    const a = Math.max(0, len - 4 * bpb);
    out = out.filter((n) => !(n.start >= a && (n.pitch === snare || n.pitch === DRUM.clap)));
    for (let t = a; t < len - 0.5 - EPS; ) {
      const q = (t - a) / (len - a);
      out.push({ pitch: snare, start: r4(t), dur: 0.2, vel: r4(0.45 + q * 0.5) });
      t += q < 0.5 ? 1 : q < 0.75 ? 0.5 : 0.25;
    }
    out = out.filter((n) => n.start < len - 0.5);
  } else if (fill && len >= bpb) {
    const a = len - (rng.chance(0.5) ? 1 : 2);
    out = out.filter((n) => !(n.start >= a - EPS && n.pitch !== DRUM.kick));
    for (let t = a; t < len - EPS; t += 0.25) out.push({ pitch: snare, start: r4(t), dur: 0.2, vel: r4(0.55 + ((t - a) / (len - a)) * 0.4) });
  }
  if (crash && !out.some((n) => n.pitch === DRUM.crash && n.start < 0.05)) out.push({ pitch: DRUM.crash, start: 0, dur: 1, vel: 0.8 });
  if (kind === 'break') out = out.filter((n) => n.pitch !== DRUM.kick || rng.chance(0.5));
  return out.filter((n) => n.start >= 0 && n.start < len - EPS).map((n) => ({ ...n, dur: Math.min(n.dur, len - n.start) }));
}

/** Melody variation of a hook: per 8-bar period the answer phrase is re-shaped (octave lift / displacement / ornament / new tail), then fitted to the chords. */
function varyLead(notes, { len, bpb, rng, key, prog, lift, kind }) {
  const out = notes.map((n) => ({ ...n }));
  const period = 8 * bpb;
  const scale = resolveScaleId(key?.scale || 'major');
  const root = key?.root ?? 0;
  const pcs = scalePitchClasses(root, scale);
  const step = (p, d) => { let q = p + d; while (!pcs.includes(mod12(q))) q += d; return q; };
  const changed = new Set();
  for (let a = 0; a < len - EPS; a += period) {
    // the answer: second half of the period (bars 5–8), the call stays recognisable
    const b0 = a + period / 2, b1 = Math.min(len, a + period);
    const ph = out.filter((n) => n.start >= b0 - EPS && n.start < b1 - EPS);
    if (!ph.length) continue;
    const op = lift && kind === 'main' ? 'octave' : rng.pick(['displace', 'ornament', 'tail', 'octave', 'none']);
    if (op === 'octave') {
      const top = Math.max(...ph.map((n) => n.pitch));
      if (top + 12 <= 93) for (const n of ph) { n.pitch += 12; }
    } else if (op === 'displace') {
      for (const n of ph) { if (n.start + 0.5 + n.dur <= b1 + EPS) { n.start = r4(n.start + 0.5); changed.add(n); } }
    } else if (op === 'ornament') {
      const long = ph.filter((n) => n.dur >= 0.75 && n.start - 0.25 >= b0).sort((x, y) => y.dur - x.dur)[0];
      if (long && !out.some((n) => Math.abs(n.start - (long.start - 0.25)) < 0.05)) {
        const o = { pitch: step(long.pitch, 1), start: r4(long.start - 0.25), dur: 0.22, vel: r4(long.vel * 0.9) };
        out.push(o); changed.add(o);
      }
    } else if (op === 'tail') {
      const last = ph.reduce((m, n) => (n.start > m.start ? n : m), ph[0]);
      last.pitch = step(last.pitch, rng.chance(0.5) ? 1 : -1); changed.add(last);
    }
  }
  // only the re-shaped notes are re-fitted (the rest of the hook is already right over its chords)
  if (prog?.length && changed.size) fitNotesToHarmony([...changed], prog, { key: { root, scale }, range: [55, 96] });
  else for (const n of changed) n.pitch = snapToScale(n.pitch, root, scale);
  // mono line: no overlaps
  out.sort((x, y) => x.start - y.start);
  for (let i = 0; i + 1 < out.length; i++) {
    const maxD = out[i + 1].start - out[i].start - 0.02;
    if (out[i].dur > maxD) out[i].dur = Math.max(0.05, r4(maxD));
  }
  return out.filter((n, i) => n.dur > 0.04 && !(i > 0 && Math.abs(out[i - 1].start - n.start) < 1e-4));
}

/** An arp written over a harmony (for a layer that enters): chord tones voiced around E4–E5, 16ths, half-gated. */
function arpOver(h, len, rng) {
  if (!h?.prog?.length) return [];
  const voiced = [];
  const hl = h.length || len;
  for (let off = 0; off < len - EPS; off += hl) {
    for (const c of h.prog) {
      const s0 = off + c.startBeat;
      if (s0 >= len - EPS) continue;
      const pcs = chordPitchClasses(c.chord.root, c.chord.type).slice(0, 4);
      const notes = pcs.map((pc) => { let p = 64 + mod12(pc - 64); if (p > 76) p -= 12; return p; }).sort((a, b) => a - b);
      voiced.push({ startBeat: s0, durBeats: Math.min(c.durBeats, len - s0), notes });
    }
  }
  return arpeggiate(voiced, { mode: rng.pick(['up', 'updown', 'down']), rate: 0.25, octaves: 1, gate: 0.6, rng, vel: 0.6 });
}

/**
 * Build the material for a plan. Pure: returns new objects only (the project is not changed).
 */
export function extendSong(project, opts = {}) {
  const plan = planExtension(project, opts);
  const { bpb } = plan;
  const seed = opts.seed ?? 1;
  const res = { ...plan, patterns: {}, clips: [], markers: [], scenes: [], automation: [], patternHarmony: {}, derivedFrom: {}, sections: [], masterFade: null };
  if (!plan.items.length) return res;
  const roles = new Map(project.tracks.map((t) => [t.id, trackRole(project, t)]));
  const chordTrack = project.tracks.find((t) => roles.get(t.id) === 'chords') || project.tracks.find((t) => roles.get(t.id) === 'pad');
  const variantCache = new Map();
  const melodic = (r) => !['drums', 'bass', 'fx', 'audio'].includes(r);
  // peel order for outros: what leaves first
  const PEEL = ['lead', 'arp', 'chords', 'keys', 'pad', 'fx', 'bass', 'drums'];

  plan.items.forEach((it, ii) => {
    const tpl = it.tpl.sec;
    const tplLen = tpl.end - tpl.start;
    const rng = createRng(hashStr(seed, it.label, ii));
    const isLast = ii === plan.items.length - 1;
    const nextKind = !isLast ? plan.items[ii + 1].kind : plan.shiftFrom != null ? sectionKind(songSections(project).find((s) => Math.abs(s.start - plan.at) < EPS)?.name || '') : null;
    const slots = {};
    // tracks that play in the template (filtered for stand-in templates)
    const playing = project.tracks.filter((t) => {
      if (t.type === 'code') return false;
      if (it.tpl.roles && !it.tpl.roles.includes(roles.get(t.id))) return false;
      return clipsIn(project, t.id, tpl.start, tpl.end).length > 0;
    });
    // outro peeling: layers leave every 8 bars (drums stay to the end for the DJ)
    const peelOrder = playing.map((t) => t.id).sort((a, b) => PEEL.indexOf(roles.get(a)) - PEEL.indexOf(roles.get(b)));
    const leaveAt = new Map(); // trackId -> beat (relative) where it stops
    if (it.peel && peelOrder.length > 1) {
      const leaving = peelOrder.slice(0, -1);
      const per = it.beats / (leaving.length + 1);
      leaving.forEach((id, k) => leaveAt.set(id, Math.max(bpb * 4, Math.round(((k + 1) * per) / (bpb * 4)) * bpb * 4)));
    }
    for (const t of playing) {
      const role = roles.get(t.id);
      const src = clipsIn(project, t.id, tpl.start, tpl.end);
      const stopAt = Math.min(it.beats, leaveAt.get(t.id) ?? it.beats);
      for (let k = 0; k * tplLen < stopAt - EPS; k++) {
        for (const s of src) {
          const start = k * tplLen + s.rel;
          if (start >= stopAt - EPS) continue;
          const length = Math.min(s.length, stopAt - start);
          if (s.clip.type === 'audio') {
            res.clips.push(createClip(t.id, { type: 'audio', sampleId: s.clip.sampleId, start: it.start + start, length, offset: s.offset, gain: s.clip.gain ?? 1, name: it.label }));
            continue;
          }
          const pat = project.patterns[s.clip.patternId];
          if (!pat) continue;
          const last = start + length >= it.beats - EPS;
          const vkey = `${pat.id}|${ii}|${k % 2}|${last ? 'L' : ''}|${stopAt < it.beats ? stopAt : ''}`;
          let pid = variantCache.get(vkey);
          if (!pid) {
            const vr = createRng(hashStr(seed, vkey));
            const plen = pat.length || length;
            const h = melodic(role) ? harmonyOf(project, pat, tpl, chordTrack) : null;
            let notes = (pat.notes || []).map((n) => ({ pitch: n.pitch, start: n.start, dur: n.dur, vel: n.vel }));
            if (role === 'drums') {
              const endsHere = last && Math.abs((s.offset + length) - plen) < bpb + EPS;
              notes = varyDrums(notes, {
                len: plen, bpb, rng: vr, kind: it.kind,
                fill: endsHere && nextKind != null && nextKind !== it.kind && it.kind !== 'build',
                build: it.kind === 'build' && endsHere && (nextKind === 'main' || nextKind == null),
                crash: k === 0 && s.rel < EPS && it.kind === 'main',
              });
            } else if (role === 'bass') {
              if (it.kind === 'main') for (const n of notes) if (n.dur <= 0.5 && n.start % 1 !== 0 && vr.chance(0.12) && n.pitch + 12 <= 55) n.pitch += 12;
            } else if (role === 'lead') {
              notes = varyLead(notes, { len: plen, bpb, rng: vr, key: h?.key || project.key, prog: h?.prog, lift: it.lift || it.rep > 0, kind: it.kind });
            } else if (role === 'arp') {
              if (it.kind === 'main' && (it.lift || k % 2 === 1)) { const top = Math.max(...notes.map((n) => n.pitch), 0); if (top + 12 <= 100) for (const n of notes) n.pitch += 12; }
            } else {
              for (const n of notes) n.vel = r4(clamp(n.vel * (0.95 + vr() * 0.08), 0.05, 1));
            }
            // an outro winds down: the last 4 bars fade in velocity
            if (it.kind === 'outro' && role !== 'fx') {
              const fadeFrom = Math.max(0, plen - 4 * bpb);
              for (const n of notes) if (n.start > fadeFrom) n.vel = r4(n.vel * (1 - 0.35 * (n.start - fadeFrom) / (plen - fadeFrom)));
            }
            const np = createPattern(t.id, { name: `${pat.name.replace(/\s+–\s+.*$/, '')} – ${it.label}${k ? ` (${k + 1})` : ''}`, length: plen, notes: notes.map((n) => createNote(n.pitch, r4(n.start), r4(Math.max(0.02, n.dur)), r4(n.vel))), color: pat.color || t.color });
            res.patterns[np.id] = np;
            res.derivedFrom[np.id] = pat.id;
            const ph = project.patternHarmony?.[pat.id];
            if (ph) res.patternHarmony[np.id] = ph;
            else if (h && melodic(role)) res.patternHarmony[np.id] = { harmony: h.harmony, length: h.length };
            pid = np.id;
            variantCache.set(vkey, pid);
          }
          if (!slots[t.id]) slots[t.id] = pid;
          res.clips.push(createClip(t.id, { patternId: pid, start: it.start + start, length, offset: s.offset, gain: s.clip.gain ?? 1, name: it.label }));
        }
      }
    }
    // evolving: in a main section an arp (or held-back arp track) enters halfway
    if (it.enter && it.beats >= 16 * bpb) {
      const arpT = project.tracks.find((t) => roles.get(t.id) === 'arp' && !playing.includes(t));
      const chordClip = chordTrack && clipsIn(project, chordTrack.id, tpl.start, tpl.end)[0];
      const cp = chordClip && project.patterns[chordClip.clip.patternId];
      const h = cp && chordClip.rel < EPS ? harmonyOf(project, cp, tpl, chordTrack) : null;
      if (arpT && h) {
        const half = Math.floor(it.bars / 2) * bpb;
        const hl = h.length;
        // the harmony re-based to the half (patterns loop from their own start)
        const shift = half % hl;
        const harmony = [...h.harmony.map((c) => ({ ...c, startBeat: c.startBeat - shift })), ...h.harmony.map((c) => ({ ...c, startBeat: c.startBeat - shift + hl }))]
          .map((c) => { const a = Math.max(0, c.startBeat), b = Math.min(hl, c.startBeat + c.durBeats); return { ...c, startBeat: a, durBeats: b - a }; })
          .filter((c) => c.durBeats > EPS);
        const prog = harmony.map((c) => ({ startBeat: c.startBeat, durBeats: c.durBeats, chord: { root: c.root, type: c.type } }));
        const notes = arpOver({ prog, length: hl }, hl, createRng(hashStr(seed, it.label, 'arp')));
        if (notes.length) {
          const np = createPattern(arpT.id, { name: `${arpT.name} – ${it.label} (enters)`, length: hl, notes: notes.map((n) => createNote(n.pitch, r4(n.start), r4(n.dur), r4(n.vel))), color: arpT.color });
          res.patterns[np.id] = np;
          res.patternHarmony[np.id] = { harmony, length: hl, ...(h.key && h.key !== project.key ? { key: h.key } : {}) };
          res.clips.push(createClip(arpT.id, { patternId: np.id, start: it.start + half, length: it.beats - half, name: it.label }));
          slots[arpT.id] = np.id;
        }
      }
    }
    res.markers.push({ id: uid('mk'), beat: it.start, name: it.label });
    res.scenes.push(createScene(it.label, slots));
    res.sections.push({ name: it.label, kind: it.kind, start: it.start, bars: it.bars });
    // automation: lanes with points in the template continue (rides / sweeps / throws copied per section)
    for (const owner of automationOwnersOf(project)) {
      for (const lane of owner.lanes) {
        if (!lane.points?.length) continue;
        if (owner.isMaster && lane.target === 'volume') continue; // the master fade is moved, never copied
        if (it.tpl.roles && owner.track && !playing.includes(owner.track)) continue;
        const inside = lane.points.filter((p) => p.beat >= tpl.start - EPS && p.beat < tpl.end - EPS);
        if (!inside.length) continue;
        const pts = [];
        for (let k = 0; k * tplLen < it.beats - EPS; k++) {
          const off = it.start + k * tplLen;
          pts.push({ beat: r4(off), value: valueAt(lane.points, tpl.start) });
          for (const p of inside) { const b = off + (p.beat - tpl.start); if (b < it.start + it.beats - EPS) pts.push({ beat: r4(b), value: p.value }); }
        }
        pts.push({ beat: r4(it.start + it.beats - 0.01), value: valueAt(lane.points, tpl.end - 0.01) });
        res.automation.push({ ownerId: owner.id, target: lane.target, points: pts });
      }
    }
  });
  // the master fade moves to the new end when the song grows at its end
  if (plan.shiftFrom == null) {
    const lane = (project.master?.automation || []).find((l) => l.target === 'volume' && l.points?.length >= 2);
    if (lane) {
      const pts = lane.points;
      const lastP = pts[pts.length - 1];
      const max = Math.max(...pts.map((p) => p.value));
      if (lastP.value < max * 0.3 && lastP.beat >= plan.oldEnd - 4 * bpb) {
        let i = pts.length - 1;
        while (i > 0 && pts[i - 1].value < max * 0.9) i--;
        const from = Math.max(0, i - 1);
        res.masterFade = { from: pts[from].beat, by: plan.addBeats };
      }
    }
  }
  return res;
}

function automationOwnersOf(project) {
  const out = project.tracks.map((t) => ({ id: t.id, track: t, lanes: t.automation || [] }));
  for (const b of project.buses || []) out.push({ id: b.id, lanes: b.automation || [] });
  if (project.master) out.push({ id: 'master', isMaster: true, lanes: project.master.automation || [] });
  return out;
}
const ownerById = (project, id) => (id === 'master' ? project.master : project.tracks.find((t) => t.id === id) || (project.buses || []).find((b) => b.id === id));

/** Move everything at or after `at` right by `by` beats (clips are split at `at`; lanes hold their value across the gap). */
export function shiftSong(project, at, by) {
  if (!(by > 0)) return;
  const add = [];
  for (const c of project.clips) {
    if (c.start >= at - EPS) { c.start = r4(c.start + by); continue; }
    if (c.start + c.length > at + EPS) {
      const head = at - c.start;
      const pat = c.type === 'pattern' ? project.patterns[c.patternId] : null;
      let off = (c.offset || 0) + head;
      if (pat?.length) off %= pat.length;
      add.push({ ...c, id: uid('clip'), start: r4(at + by), length: r4(c.length - head), offset: r4(off) });
      c.length = r4(head);
    }
  }
  project.clips.push(...add);
  for (const m of project.markers || []) if (m.beat >= at - EPS) m.beat = r4(m.beat + by);
  for (const o of automationOwnersOf(project)) {
    for (const lane of o.lanes) {
      if (!lane.points?.length) continue;
      const v = valueAt(lane.points, at - EPS);
      const after = lane.points.some((p) => p.beat >= at - EPS);
      for (const p of lane.points) if (p.beat >= at - EPS) p.beat = r4(p.beat + by);
      if (after && lane.points.some((p) => p.beat < at - EPS)) lane.points.push({ beat: r4(at), value: v }, { beat: r4(at + by - 0.01), value: v });
      lane.points.sort((a, b) => a.beat - b.beat);
    }
  }
  for (const s of project.sections || []) if (s.start >= at - EPS) s.start = r4(s.start + by);
  if (project.loop) {
    if (project.loop.start >= at - EPS) project.loop.start = r4(project.loop.start + by);
    if (project.loop.end > at + EPS) project.loop.end = r4(project.loop.end + by);
  }
}

/** Apply an extendSong() result to a project (mutates; use inside store.transact). */
export function applyExtension(project, ext) {
  if (!ext?.items?.length) return project;
  if (ext.shiftFrom != null) shiftSong(project, ext.shiftFrom, ext.addBeats);
  Object.assign(project.patterns, ext.patterns);
  project.clips.push(...ext.clips);
  project.markers = [...(project.markers || []), ...ext.markers].sort((a, b) => a.beat - b.beat);
  project.scenes = [...(project.scenes || []), ...ext.scenes];
  if (project.patternHarmony) Object.assign(project.patternHarmony, ext.patternHarmony);
  if (Array.isArray(project.sections)) {
    project.sections.push(...ext.sections.map((s) => ({ ...s, type: s.kind === 'main' ? 'chorus' : s.kind, energy: s.kind === 'main' ? 1 : 0.5, roles: [] })));
    project.sections.sort((a, b) => a.start - b.start);
  }
  for (const a of ext.automation) {
    const owner = ownerById(project, a.ownerId);
    const lane = owner?.automation?.find((l) => l.target === a.target);
    if (!lane) continue;
    const a0 = a.points[0].beat, a1 = a.points[a.points.length - 1].beat;
    lane.points = [...lane.points.filter((p) => p.beat < a0 - EPS || p.beat > a1 + EPS), ...a.points].sort((x, y) => x.beat - y.beat);
  }
  if (ext.masterFade) {
    const lane = project.master.automation.find((l) => l.target === 'volume');
    const { from, by } = ext.masterFade;
    const v = valueAt(lane.points, from);
    for (const p of lane.points) if (p.beat > from + EPS) p.beat = r4(p.beat + by);
    const hold = lane.points.find((p) => Math.abs(p.beat - from) < EPS);
    if (hold) hold.beat = r4(from + by);
    lane.points.push({ beat: r4(from), value: v });
    lane.points.sort((a, b) => a.beat - b.beat);
  }
  return project;
}

/**
 * Remove a section and close the gap: clips inside go, clips across the edges are cropped, everything after moves
 * left, automation inside is dropped (lanes jump to the value after the cut), markers inside are deleted.
 * -> {start, end, beats} | null
 */
export function removeSection(project, opts = {}) {
  let { start, end } = opts;
  if (opts.markerId) {
    const sec = songSections(project).find((s) => s.markerId === opts.markerId);
    if (!sec) return null;
    ({ start, end } = sec);
  }
  if (!(end > start)) return null;
  const by = end - start;
  const out = [];
  for (const c of project.clips) {
    const c0 = c.start, c1 = c.start + c.length;
    if (c1 <= start + EPS) { out.push(c); continue; }
    if (c0 >= end - EPS) { c.start = r4(c0 - by); out.push(c); continue; }
    const pat = c.type === 'pattern' ? project.patterns[c.patternId] : null;
    if (c0 < start - EPS) {
      // head before the cut (and a tail after it, re-attached at the cut)
      if (c1 > end + EPS) {
        let off = (c.offset || 0) + (end - c0);
        if (pat?.length) off %= pat.length;
        out.push({ ...c, id: uid('clip'), start: r4(start), length: r4(c1 - end), offset: r4(off) });
      }
      c.length = r4(start - c0);
      out.push(c);
    } else if (c1 > end + EPS) {
      let off = (c.offset || 0) + (end - c0);
      if (pat?.length) off %= pat.length;
      c.offset = r4(off); c.start = r4(start); c.length = r4(c1 - end);
      out.push(c);
    }
  }
  project.clips = out;
  project.markers = (project.markers || []).filter((m) => m.beat < start - EPS || m.beat >= end - EPS).map((m) => (m.beat >= end - EPS ? { ...m, beat: r4(m.beat - by) } : m));
  for (const o of automationOwnersOf(project)) {
    for (const lane of o.lanes) {
      if (!lane.points?.length) continue;
      const before = lane.points.some((p) => p.beat < start - EPS);
      const vA = valueAt(lane.points, start - EPS), vB = valueAt(lane.points, end);
      const after = lane.points.some((p) => p.beat >= end - EPS);
      lane.points = lane.points.filter((p) => p.beat < start - EPS || p.beat >= end - EPS).map((p) => (p.beat >= end - EPS ? { ...p, beat: r4(p.beat - by) } : p));
      if (before && after) lane.points.push({ beat: r4(start), value: vA }, ...(Math.abs(vA - vB) > 1e-9 ? [{ beat: r4(start), value: vB }] : []));
      lane.points.sort((a, b) => a.beat - b.beat);
    }
  }
  if (Array.isArray(project.sections)) {
    project.sections = project.sections.filter((s) => s.start < start - EPS || s.start >= end - EPS).map((s) => (s.start >= end - EPS ? { ...s, start: r4(s.start - by) } : s));
  }
  if (project.loop) {
    const mv = (b) => (b >= end ? b - by : b > start ? start : b);
    project.loop.start = r4(mv(project.loop.start));
    project.loop.end = r4(Math.max(project.loop.start + 1, mv(project.loop.end)));
  }
  return { start, end, beats: by };
}
