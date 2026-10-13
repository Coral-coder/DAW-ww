// Conversion between Strudel code and DAW patterns.
//
//   codeToPatterns(source, {cycles=4, beatsPerCycle=4}) -> [{name, kind, sound, notes, lengthBeats}]
//   patternsToCode(project, {trackIds?}) -> Strudel code string
import { DRUM_PADS, beatsPerBar, patternsForTrack } from '../core/model.js';
import { evaluate, queryEvents } from './strudel.js';
import { midiToNoteName } from './theory.js';
import { songToCode, hasArrangement } from './song-code.js';
import { EPS } from './pattern.js';

const DRUM_SHORT_PITCH = Object.fromEntries(DRUM_PADS.map((p) => [p.short, p.pitch]));
const PITCH_TO_SHORT = Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.short]));

const DRUM_ALIASES = {
  bd: 'bd', kick: 'bd', kck: 'bd', bassdrum: 'bd', kd: 'bd',
  sd: 'sd', snare: 'sd', sn: 'sd', sne: 'sd',
  hh: 'hh', hat: 'hh', hihat: 'hh', ch: 'hh', hc: 'hh', closedhat: 'hh', chh: 'hh',
  oh: 'oh', openhat: 'oh', ho: 'oh', ohh: 'oh',
  cp: 'cp', clap: 'cp', clp: 'cp', handclap: 'cp',
  rim: 'rim', rs: 'rim', rimshot: 'rim',
  lt: 'lt', lowtom: 'lt', mt: 'mt', tom: 'mt', midtom: 'mt', ht: 'ht', hightom: 'ht',
  cr: 'cr', crash: 'cr', cy: 'cr', cymbal: 'cr',
  rd: 'rd', ride: 'rd',
  cb: 'cb', cowbell: 'cb',
  sh: 'sh', shaker: 'sh', shake: 'sh',
  tb: 'tb', tamb: 'tb', tambourine: 'tb',
  perc: 'perc', conga: 'perc', bongo: 'perc', misc: 'perc', fx: 'perc',
  cl: 'cl', clave: 'cl', claves: 'cl',
};

/** 'RolandTR808_bd' / '808bd' / 'kick' / 'hh27' -> 'bd' | 'hh' | ... | null */
export function drumKey(name) {
  if (typeof name !== 'string' || !name) return null;
  let s = name.toLowerCase();
  if (s.includes('_')) s = s.slice(s.lastIndexOf('_') + 1);
  if (DRUM_ALIASES[s]) return DRUM_ALIASES[s];
  s = s.replace(/^\d+/, '').replace(/\d+$/, '');
  return DRUM_ALIASES[s] || null;
}

export function drumPitch(name) {
  const k = drumKey(name);
  return k ? DRUM_SHORT_PITCH[k] : null;
}

const SYNTH_SOUNDS = new Set(['sawtooth', 'saw', 'sine', 'sin', 'square', 'sqr', 'triangle', 'tri', 'supersaw',
  'pulse', 'piano', 'fm', 'organ', 'bass', 'lead', 'pad', 'synth', 'epiano', 'rhodes', 'strings']);
export function isSynthSound(s) {
  return s === undefined || s === null || SYNTH_SOUNDS.has(String(s).toLowerCase()) || /^(gm_|z_|wt_)/.test(String(s));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

function eventPitch(v) {
  if (typeof v.note === 'number' && Number.isFinite(v.note)) return { kind: 'melodic', pitch: Math.round(v.note) };
  if (typeof v.freq === 'number' && v.freq > 0) return { kind: 'melodic', pitch: Math.round(69 + 12 * Math.log2(v.freq / 440)) };
  const dp = drumPitch(v.s);
  if (dp !== null) return { kind: 'drums', pitch: dp };
  const n = typeof v.n === 'number' ? v.n : 0;
  if (isSynthSound(v.s)) return { kind: 'melodic', pitch: Math.round(n >= 24 ? n : 48 + n) };
  return { kind: 'melodic', pitch: 60 + Math.round(n) };
}

/** Smallest period (in cycles, dividing `cycles`) after which the notes repeat. */
function detectPeriod(notes, cycles, bpc) {
  const key = (n) => `${n.pitch}@${round(n.start, 3)}`;
  for (let p = 1; p < cycles; p++) {
    if (cycles % p) continue;
    const len = p * bpc;
    const first = notes.filter((n) => n.start < len - EPS);
    const set = new Set(first.map(key));
    const ok = notes.every((n) => set.has(`${n.pitch}@${round(n.start % len, 3)}`))
      && first.length * (cycles / p) === notes.length;
    if (ok) return p;
  }
  return cycles;
}

/**
 * Evaluates code and renders its events into DAW-style note lists, grouped per `$:` pattern
 * (drum sounds of one pattern share a 'drums' group; melodic events are grouped by sound).
 */
export function codeToPatterns(source, { cycles = 4, beatsPerCycle = 4, trim = true } = {}) {
  const ev = typeof source === 'string' ? evaluate(source) : source;
  if (ev.error) throw new Error(ev.error);
  const out = [];
  const entries = ev.entries || ev.patterns.map((pattern, i) => ({ name: `$${i + 1}`, pattern, muted: false }));
  entries.filter((e) => !e.muted).forEach((entry, idx) => {
    const groups = new Map();
    for (const e of queryEvents([entry.pattern], 0, cycles)) {
      const v = e.value;
      const { kind, pitch } = eventPitch(v);
      const sound = kind === 'drums' ? (v.bank ? String(v.bank) : 'drums') : String(v.s ?? 'triangle');
      const key = kind === 'drums' ? 'drums' : `m:${sound}`;
      if (!groups.has(key)) groups.set(key, { kind, sound, notes: [] });
      const legato = typeof v.legato === 'number' ? v.legato : typeof v.clip === 'number' ? v.clip : 1;
      const durCycles = (e.end - e.begin) * legato;
      const gain = typeof v.gain === 'number' ? v.gain : 1;
      const velocity = typeof v.velocity === 'number' ? v.velocity : 1;
      groups.get(key).notes.push({
        pitch,
        start: round(e.begin * beatsPerCycle),
        dur: round(Math.max(kind === 'drums' ? 0.25 : 0.05, durCycles * beatsPerCycle)),
        vel: round(clamp(0.8 * gain * velocity, 0.05, 1), 3),
      });
    }
    const label = /^\$\d+$/.test(entry.name) || entry.name === 'main' ? `Pattern ${idx + 1}` : entry.name;
    for (const g of groups.values()) {
      g.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      let lengthCycles = cycles;
      if (trim) {
        lengthCycles = detectPeriod(g.notes, cycles, beatsPerCycle);
        g.notes = g.notes.filter((n) => n.start < lengthCycles * beatsPerCycle - EPS);
      }
      out.push({
        // the pattern's name only — callers append the sound/kind (adding it here doubled it: "Pattern 1 drums Drums")
        name: label,
        kind: g.kind,
        sound: g.sound,
        notes: g.notes,
        lengthBeats: lengthCycles * beatsPerCycle,
      });
    }
  });
  return out;
}

// --------------------------------------------------------------------------- patterns -> code

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Reduce a token list by halving while every odd position is a rest. */
function simplify(tokens) {
  while (tokens.length > 1 && tokens.length % 2 === 0 && tokens.every((t, i) => i % 2 === 0 || t === '~')) {
    tokens = tokens.filter((_, i) => i % 2 === 0);
  }
  return tokens;
}

function groupString(tokens) {
  const t = simplify(tokens);
  if (t.length === 1) return t[0];
  if (t.every((x) => x === t[0]) && !t[0].startsWith('[')) return t[0] === '~' ? '~' : `${t[0]}*${t.length}`;
  return `[${t.join(' ')}]`;
}

function drumBar(cells, beats) {
  // cells: array (steps) of arrays of names
  const tokens = cells.map((c) => (c.length === 0 ? '~' : c.length === 1 ? c[0] : `[${c.join(',')}]`));
  const S = tokens.length;
  if (beats > 0 && S % beats === 0 && S / beats > 1) {
    const per = S / beats;
    const groups = [];
    for (let b = 0; b < beats; b++) groups.push(groupString(tokens.slice(b * per, (b + 1) * per)));
    const top = simplify(groups);
    if (top.every((g) => g === '~')) return '~';
    return top.join(' ');
  }
  return simplify(tokens).join(' ');
}

function melodicBar(cells, durs) {
  // cells: steps -> array of note names; durs: steps -> duration in steps
  const S = cells.length;
  const items = [];
  let i = 0;
  while (i < S) {
    if (!cells[i].length) {
      let j = i + 1;
      while (j < S && !cells[j].length) j++;
      items.push(['~', j - i]);
      i = j;
      continue;
    }
    let next = i + 1;
    while (next < S && !cells[next].length) next++;
    const w = Math.max(1, Math.min(durs[i], next - i));
    const names = cells[i];
    items.push([names.length === 1 ? names[0] : `[${names.join(',')}]`, w]);
    if (w < next - i) items.push(['~', next - i - w]);
    i = next;
  }
  if (items.length === 1 && items[0][0] === '~') return '~';
  const g = items.reduce((a, [, w]) => gcd(a, w), 0) || 1;
  return items.map(([t, w]) => (w / g === 1 ? t : `${t}@${w / g}`)).join(' ');
}

/** Builds a mini-notation string for a note list. Returns { mini, slow }. */
export function notesToMini(notes, lengthBeats, { kind = 'melodic', beatsPerBar: bpb = 4, stepsPerBeat = 4 } = {}) {
  const totalSteps = Math.max(1, Math.round(lengthBeats * stepsPerBeat));
  const cells = Array.from({ length: totalSteps }, () => []);
  const durs = new Array(totalSteps).fill(0);
  for (const n of [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
    const idx = Math.round(n.start * stepsPerBeat);
    if (idx < 0 || idx >= totalSteps) continue;
    const name = kind === 'drums' ? PITCH_TO_SHORT[n.pitch] || 'perc' : midiToNoteName(n.pitch);
    if (!cells[idx].includes(name)) cells[idx].push(name);
    durs[idx] = Math.max(durs[idx], Math.max(1, Math.round((n.dur || 0.25) * stepsPerBeat)));
  }
  const barSteps = bpb * stepsPerBeat;
  const render = (from, to, beats) => (kind === 'drums'
    ? drumBar(cells.slice(from, to), beats)
    : melodicBar(cells.slice(from, to), durs.slice(from, to)));
  if (totalSteps % barSteps === 0 && Number.isInteger(bpb)) {
    const bars = [];
    for (let b = 0; b < totalSteps / barSteps; b++) bars.push(render(b * barSteps, (b + 1) * barSteps, bpb));
    if (bars.every((x) => x === bars[0])) return { mini: bars[0], slow: 1 };
    return { mini: `<${bars.map((b) => (b.includes(' ') ? `[${b}]` : b)).join(' ')}>`, slow: 1 };
  }
  return { mini: render(0, totalSteps, Math.round(lengthBeats)), slow: lengthBeats / bpb };
}

const ROLE_SOUND = { bass: 'sawtooth', lead: 'square', arp: 'square', pad: 'triangle', chords: 'triangle', vocal: 'sine', fx: 'sine' };
function trackSound(track) {
  const inst = track.instrument || {};
  if (inst.type === 'sampler') return 'piano';
  if (inst.type === 'organ' || inst.type === 'fm') return 'sine';
  return ROLE_SOUND[track.role] || 'sawtooth';
}

const fmt = (x) => String(round(x, 3));

/**
 * Exports the project as Strudel code for strudel.cc. With an arrangement (clips) the WHOLE song is written —
 * per-section patterns in idiomatic Strudel (scale degrees, motifs, struct, euclid, <> variations) played by
 * one arrange([bars, pattern], …) per track (see song-code.js / idioms.js); without clips, the (active) loop.
 */
export function patternsToCode(project, { trackIds = null } = {}) {
  if (hasArrangement(project)) return songToCode(project, { export: true, trackIds }).code;
  const bpb = beatsPerBar(project);
  const lines = [
    `// ${project.name || 'daW³ project'} — exported from daW³`,
    `setcpm(${fmt(project.bpm)}/${fmt(bpb)})`,
  ];
  if (project.swing > 0) lines.push(`all(x => x.swingBy(${fmt(project.swing / 2)}, ${fmt(bpb * 2)}))`);
  for (const track of project.tracks || []) {
    if (trackIds && !trackIds.includes(track.id)) continue;
    const label = track.mute ? '_$:' : '$:';
    if (track.type === 'code') {
      const code = String(track.code || '').trim();
      if (!code) continue;
      lines.push('', `// ${track.name} (code)`);
      if (/^\s*_?(\$|[A-Za-z_]\w*)\s*:(?![:=])/m.test(code)) lines.push(code);
      else lines.push(`${label} ${code}`);
      continue;
    }
    if (track.type !== 'instrument') continue;
    const pat = project.patterns?.[track.activePatternId] || patternsForTrack(project, track.id)[0];
    if (!pat || !pat.notes?.length) continue;
    const isDrums = track.instrument?.type === 'drums';
    const { mini, slow } = notesToMini(pat.notes, pat.length || bpb, { kind: isDrums ? 'drums' : 'melodic', beatsPerBar: bpb });
    let expr = isDrums ? `s("${mini}")` : `note("${mini}").s("${trackSound(track)}")`;
    if (slow !== 1) expr += `.slow(${fmt(slow)})`;
    const vol = typeof track.volume === 'number' ? track.volume : 0.8;
    if (Math.abs(vol - 0.8) > 1e-3) expr += `.gain(${fmt(vol / 0.8)})`;
    if (track.pan) expr += `.pan(${fmt((track.pan + 1) / 2)})`;
    lines.push('', `// ${track.name}`, `${label} ${expr}`);
  }
  return lines.join('\n') + '\n';
}
