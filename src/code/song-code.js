// "Song as code": the whole project rendered as readable, idiomatic Strudel code — and applied
// back to the project. Pure (runs under Node).
//
//   songToCode(project) -> { code, mode, blocks: SongBlock[], labels: {label: trackId} }
//   applySongCode(project, code, opts) -> report        (mutates `project` — call inside store.transact)
//   notesToVoices(notes, lengthBeats, {kind, beatsPerBar, spell}) -> { voices: [{mini, vel}], slow }
//
// Layout of the generated code:
//   // header comments
//   setcpm(bpm/beatsPerBar)
//   all(x => x.swingBy(…))                      (only with project swing)
//   // ── Drums ── …                              one section per track, in track order
//   drums: s("bd*4, ~ sd, hh*8").bank("808")      pattern mode: the track's active pattern
//   const bass_verse = note("<c2 …>")              song mode: one const per pattern used …
//   bass: arrange([8, bass_verse], [8, silence]).s("saw-bass")   … arranged like the clips
//   _lead: …                                      muted (or silenced by another track's solo)
//   // ── code track "Groove" ──                   code tracks verbatim (setcpm/all lines disabled)
import { DRUM_PADS, beatsPerBar, songLengthBeats, createTrack, createPattern, createNote, createClip, createEffect } from '../core/model.js';
import { evaluate, queryEvents, splitTopLevel, stripComments, lastExpressionStart, codeEngineVersion } from './strudel.js';
import { drumPitch } from './convert.js';
import {
  renderPart, verifyExpr, detectSwing, swingCall, snapBeat as snapBeatQ, qVel as qVelQ, alternation, barsText, rootName, compactSteps, weightedSeq, mergeRests, chooseRes, barGroups,
} from './idioms.js';
import { valueAt, parseTarget } from '../core/automation.js';
import { grooveFor } from '../gen/groove.js';

const EPS = 1e-6;
const SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
const PITCH_TO_SHORT = Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.short]));
const DRUM_ORDER = new Map(DRUM_PADS.map((p, i) => [p.pitch, i]));
// keys whose signature uses flats (major-relative pitch class of the key)
const FLAT_KEYS = new Set([5, 10, 3, 8, 1, 6]);
/** Onset quantisation used by the code view (see idioms.js snapBeat). */
export const snapBeat = snapBeatQ;
/** Velocity quantisation used by the code view (0.05 steps). */
export const qVel = qVelQ;
const DEFAULT_VEL = 0.8;
const DEFAULT_VOL = 0.8;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements',
  'package', 'protected', 'interface', 'private', 'public', 'eval', 'arguments', 'null', 'true', 'false', 'undefined',
  'http', 'https', 'silence', 'all', 'each']);
const MINOR_LIKE = new Set(['minor', 'aeolian', 'dorian', 'phrygian', 'harmonicMinor', 'melodicMinor', 'harmonic-minor', 'melodic-minor', 'locrian', 'minorPentatonic', 'blues']);
export const TEMPO_MARK = '// [project tempo] ';
export const ALL_MARK = '// [this track only] ';

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const fmt = (x, d = 3) => String(round(x, d));
/** Control value literal: 0.25 -> ".25". */
const num = (x, d = 3) => fmt(x, d).replace(/^0\./, '.').replace(/^-0\./, '-.');
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Velocity literal: 0.8 -> ".8", 1 -> "1". */
function velStr(v) {
  const r = round(clamp(v, 0, 1), 2);
  if (r >= 1) return '1';
  if (r <= 0) return '0';
  return String(r).replace(/^0\./, '.');
}

/** 'c3' style names, spelled for the project key. */
export function noteSpeller(project) {
  const root = project?.key?.root ?? 0;
  const scale = project?.key?.scale || 'major';
  const rel = MINOR_LIKE.has(scale) ? (root + 3) % 12 : root;
  const names = FLAT_KEYS.has(rel) ? FLAT : SHARP;
  return (m) => { m = Math.round(m); return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); };
}

/** Track name -> unique JS identifier usable as a Strudel label. */
export function labelFor(name, used = new Set()) {
  let base = String(name || 'track').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'track';
  if (/^\d/.test(base)) base = 't_' + base;
  if (RESERVED.has(base)) base += '_';
  let out = base;
  for (let k = 2; used.has(out); k++) out = `${base}_${k}`;
  used.add(out);
  return out;
}

// ------------------------------------------------------------------------- mini-notation writer

/**
 * Notes -> mini-notation voices.
 * drums: one voice per drum sound, e.g. {mini: "bd ~ [~ bd] ~", vel: ".9 .7 …" | 0.9 | null}
 * melodic: chords "[c3,e3,g3]" with "@" durations, one voice per non-overlapping layer.
 * Returns { voices: [{mini, vel, sound?}], slow } — `slow` ≠ 1 when the pattern isn't whole bars.
 */
export function notesToVoices(notes, lengthBeats, { kind = 'melodic', beatsPerBar: bpb = 4, spell } = {}) {
  spell = spell || noteSpeller(null);
  const L = Math.max(EPS, lengthBeats || bpb);
  // humanised / strummed timing snaps to 16ths, else to a 1/24-beat grid (32nds, triplets); velocities to 0.05
  const snap = snapBeat;
  const clean = (notes || [])
    .map((n) => ({ pitch: n.pitch, start: snap(n.start), dur: n.dur > 0 ? n.dur : 0.25, vel: qVel(n.vel ?? DEFAULT_VEL) }))
    .filter((n) => n.start >= -EPS && n.start < L - EPS)
    .map((n) => ({ ...n, start: Math.max(0, n.start), dur: Math.max(1 / 24, Math.min(Math.round(n.dur * 24) / 24 || 1 / 24, L - n.start)) }));
  const whole = Math.abs(L / bpb - Math.round(L / bpb)) < EPS && Number.isInteger(bpb);
  const bars = whole ? Math.round(L / bpb) : 1;
  const barLen = whole ? bpb : L;
  const slow = whole ? 1 : L / bpb;
  const groups = kind === 'drums'
    ? Array.from({ length: bars }, (_, i) => [i, i + 1])
    : barGroups(clean, bars, barLen);
  const inGroup = (n, [a, b]) => n.start >= a * barLen - EPS && n.start < b * barLen - EPS;

  if (kind === 'drums') {
    const byVoice = new Map();
    for (const n of clean) {
      // drum pitches without a pad of their own keep their pitch as the sample number: "perc:60"
      const name = PITCH_TO_SHORT[n.pitch] || `perc:${n.pitch}`;
      if (!byVoice.has(name)) byVoice.set(name, { name, order: DRUM_ORDER.get(n.pitch) ?? 99, notes: [] });
      byVoice.get(name).notes.push(n);
    }
    const voices = [...byVoice.values()].sort((a, b) => a.order - b.order).map((v) => {
      const segs = [];
      const vsegs = [];
      for (const g of groups) {
        const ns = v.notes.filter((n) => inGroup(n, g)).map((n) => ({ ...n, t: n.start - g[0] * barLen }));
        const span = (g[1] - g[0]) * barLen;
        const r = chooseRes(ns.map((n) => n.t));
        const S = Math.max(1, Math.round(span * r));
        const cells = new Array(S).fill('~');
        const vcells = new Array(S).fill('~');
        for (const n of ns) {
          const i = Math.min(S - 1, Math.round(n.t * r));
          cells[i] = v.name;
          vcells[i] = velStr(Math.max(n.vel, vcells[i] === '~' ? 0 : Number(vcells[i]) || 0));
        }
        segs.push({ text: compactSteps(cells), w: g[1] - g[0] });
        vsegs.push({ text: compactSteps(vcells), w: g[1] - g[0] });
      }
      return { mini: alternation(segs), velMini: alternation(vsegs), vels: v.notes.map((n) => n.vel), sound: v.name };
    });
    return { voices: finishVel(voices), slow };
  }

  // melodic: chord events grouped by (start, dur); layered so a layer never overlaps itself
  const layersPerGroup = groups.map((g) => {
    const span = (g[1] - g[0]) * barLen;
    const ns = clean.filter((n) => inGroup(n, g)).map((n) => ({ ...n, t: n.start - g[0] * barLen }));
    // grid from the onsets; note ends snap to it, at least to 16ths (gates round to the grid, min one step)
    const rOn = chooseRes(ns.map((n) => n.t));
    const re = Math.max(rOn, 4);
    const r = chooseRes(ns.flatMap((n) => [n.t, Math.round(Math.min(span, n.t + n.dur) * re) / re]));
    const S = Math.max(1, Math.round(span * r));
    const evMap = new Map();
    for (const n of ns) {
      const s0 = Math.min(S - 1, Math.round(n.t * r));
      const d = Math.max(1, Math.min(S - s0, Math.round(n.dur * r)));
      const k = `${s0}|${d}`;
      if (!evMap.has(k)) evMap.set(k, { s0, d, pitches: [], vels: [] });
      const e = evMap.get(k);
      if (!e.pitches.includes(n.pitch)) { e.pitches.push(n.pitch); e.vels.push(n.vel); }
    }
    const evs = [...evMap.values()].sort((a, b) => a.s0 - b.s0 || b.d - a.d);
    const layers = [];
    for (const e of evs) {
      let lay = layers.find((l) => l.end <= e.s0);
      if (!lay) { lay = { end: 0, evs: [] }; layers.push(lay); }
      lay.evs.push(e);
      lay.end = e.s0 + e.d;
    }
    return { S, layers, w: g[1] - g[0] };
  });
  const nLayers = Math.max(1, ...layersPerGroup.map((g) => g.layers.length));
  const voices = [];
  for (let li = 0; li < nLayers; li++) {
    const segs = [];
    const vsegs = [];
    const vels = [];
    for (const g of layersPerGroup) {
      const lay = g.layers[li];
      const items = [];
      const vitems = [];
      let pos = 0;
      for (const e of lay ? lay.evs : []) {
        if (e.s0 > pos) { items.push({ tok: '~', w: e.s0 - pos }); vitems.push({ tok: '~', w: e.s0 - pos }); }
        const ps = [...e.pitches].sort((a, b) => a - b);
        items.push({ tok: ps.length === 1 ? spell(ps[0]) : `[${ps.map(spell).join(',')}]`, w: e.d });
        const v = qVel(e.vels.reduce((a, b) => a + b, 0) / e.vels.length);
        vitems.push({ tok: velStr(v), w: e.d });
        for (const x of e.vels) vels.push(x);
        pos = e.s0 + e.d;
      }
      if (pos < g.S) { items.push({ tok: '~', w: g.S - pos }); vitems.push({ tok: '~', w: g.S - pos }); }
      const allRest = items.every((it) => it.tok === '~');
      segs.push({ text: allRest ? '~' : weightedSeq(mergeRests(items)), w: g.w });
      vsegs.push({ text: allRest ? '~' : weightedSeq(mergeRests(vitems)), w: g.w });
    }
    voices.push({ mini: alternation(segs), velMini: alternation(vsegs), vels });
  }
  return { voices: finishVel(voices), slow };
}

/** vel: null (all default .8) | number (uniform) | mini string (varies). */
function finishVel(voices) {
  return voices.map((v) => {
    const set = new Set(v.vels);
    let vel;
    if (!v.vels.length || (set.size === 1 && Math.abs(v.vels[0] - DEFAULT_VEL) < 0.005)) vel = null;
    else if (set.size === 1) vel = v.vels[0];
    else vel = v.velMini;
    return { mini: v.mini, vel, sound: v.sound };
  });
}

/** Splits a long expression over lines: stack(…) arguments one per line, long alternations one chunk per line. */
export function formatExpr(expr, indent = '', width = 100) {
  if (expr.length + indent.length <= width) return expr;
  if (expr.startsWith('stack(')) {
    const close = matchParen(expr, 5);
    if (close > 0) {
      const args = splitArgs(expr.slice(6, close));
      if (args.length > 1) {
        const inner = args.map((a) => `${indent}  ${formatExpr(a.trim(), indent + '  ', width)},`).join('\n');
        return `stack(\n${inner}\n${indent})${expr.slice(close + 1)}`;
      }
    }
  }
  return expr.replace(/"([^"`]*)"/g, (m, mini) => (mini.length > 90 && /[<\[,]/.test(mini) ? strLit(mini, indent) : m));
}

/** Top-level method-call pieces of an expression: 'n("…").scale("…").lpf(…)' -> ['n("…")', '.scale("…")', '.lpf(…)'] */
function chainPieces(expr) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === '`' || c === "'") { const j = expr.indexOf(c, i + 1); if (j < 0) return [expr]; cur += expr.slice(i, j + 1); i = j; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === '.' && depth === 0 && cur && /[)\]`"]$/.test(cur)) { out.push(cur); cur = ''; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Wraps a method chain over continuation lines (indented by 2) when a line would exceed `width`. */
export function wrapChain(expr, startCol = 0, width = 100) {
  const pieces = chainPieces(expr);
  if (pieces.length < 2) return expr;
  let out = '';
  let col = startCol;
  for (const p of pieces) {
    const firstLine = p.split('\n')[0];
    if (out && col + firstLine.length > width) { out += '\n  '; col = 2; }
    out += p;
    col = p.includes('\n') ? p.length - p.lastIndexOf('\n') - 1 : col + p.length;
  }
  return out;
}

/** Index of the parenthesis closing the one at `open` (strings skipped), or -1. */
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '`' || c === "'") { const j = s.indexOf(c, i + 1); if (j < 0) return -1; i = j; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/** Top-level comma-separated arguments (strings and brackets skipped). */
function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '`' || c === "'") { const j = s.indexOf(c, i + 1); cur += s.slice(i, j + 1); i = j; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Splits a mini-notation string at top-level occurrences of `sep` (' ' or ','). */
function splitMini(s, sep) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if ('[<{('.includes(c)) depth++;
    else if (']>})'.includes(c)) depth--;
    if (c === sep && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Index of the bracket closing the one at 0, or -1. */
function closeOf(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if ('[<{('.includes(s[i])) depth++;
    else if (']>})'.includes(s[i])) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Lines of a long mini-notation term (indented by `ind`): stacked layers one per line, an alternation / sequence
 * broken into lines of whole steps, nested ones opened on their own lines when a step alone is too long.
 */
function miniLines(mini, ind, width) {
  if (ind.length + mini.length <= width) return [ind + mini];
  const layers = splitMini(mini, ',');
  if (layers.length > 1) {
    const out = [];
    layers.forEach((l, i) => {
      const ls = miniLines(l, ind, width);
      if (i < layers.length - 1) ls[ls.length - 1] += ',';
      out.push(...ls);
    });
    return out;
  }
  const c = closeOf(mini);
  const suffix = c > 0 ? mini.slice(c + 1) : null;
  if (c <= 0 || !'<['.includes(mini[0]) || !/^[!*@\d./]*$/.test(suffix)) return [ind + mini];
  const parts = splitMini(mini.slice(1, c), ' ');
  const inner = ind + '  ';
  const out = [ind + mini[0]];
  let line = '';
  for (const p of parts) {
    if (inner.length + p.length > width) {
      if (line) { out.push(inner + line); line = ''; }
      out.push(...miniLines(p, inner, width));
      continue;
    }
    if (line && inner.length + line.length + 1 + p.length > width) { out.push(inner + line); line = p; } else line = line ? `${line} ${p}` : p;
  }
  if (line) out.push(inner + line);
  out.push(ind + mini[c] + suffix);
  return out;
}

/** Mini-notation string literal; long ones become multi-line template strings. */
function strLit(mini, indent = '') {
  if (mini.length <= 90) return `"${mini}"`;
  if (splitMini(mini, ',').length > 1) {
    // stacked layers: one per line (each broken further when long), inside an indented template string
    const ls = miniLines(mini, '  ', Math.max(40, 88 - indent.length));
    return '`\n' + ls.map((l) => indent + l).join('\n') + `\n${indent}\``;
  }
  const lines = miniLines(mini, '', Math.max(40, 86 - indent.length));
  if (lines.length < 2) return `"${mini}"`;
  return '`' + lines.map((l, i) => (i ? indent + l : l)).join('\n') + '`';
}

/** The note-producing expression for a pattern (no track-level controls), written by the idiom engine. */
export function patternExpr(pattern, { kind, bpb, spell, key = null, indent = '' }) {
  const len = pattern?.length || bpb;
  const r = renderPart(pattern?.notes || [], len, { kind, bpb, spell, key, spellKey: spell?.key });
  return formatExpr(r.expr, indent);
}

// ---------------------------------------------------------------------------- track controls

function fxParam(fx, key, def) {
  const v = fx.params?.[key];
  return v === undefined || v === null ? def : v;
}

/** Track instrument -> Strudel sound / bank call. */
export function soundCall(track, { export: exp = false } = {}) {
  const inst = track.instrument || {};
  if (inst.type === 'drums') return inst.preset ? `.bank("${kitBank(inst.preset)}")` : '';
  const s = exp ? strudelSound(track) : inst.preset || ({ synth: 'sawtooth', fm: 'fm', organ: 'organ', sampler: 'piano' }[inst.type]) || 'sawtooth';
  return `.s("${s}")`;
}

/** Mixer + main insert effects -> Strudel controls. */
export function trackControls(track, project, { ride = null, automated = null } = {}) {
  let out = '';
  const vol = typeof track.volume === 'number' ? track.volume : DEFAULT_VOL;
  if (ride?.mini) out += `.gain("${ride.mini}")`;
  else if (ride && ride.static !== undefined) { if (Math.abs(ride.static - 1) > 1e-3) out += `.gain(${num(ride.static)})`; }
  else if (Math.abs(vol - DEFAULT_VOL) > 1e-3) out += `.gain(${num(vol / DEFAULT_VOL)})`;
  if (track.pan) out += `.pan(${num((track.pan + 1) / 2)})`;
  const bpm = project?.bpm || 120;
  const done = new Set();
  for (const fx of track.fx || []) {
    if (automated?.has(fx.id)) { done.add(fx.type); continue; } // automated: written per section
    if (fx.enabled === false || done.has(fx.type)) continue;
    const mixv = fxParam(fx, 'mix', 1);
    switch (fx.type) {
      case 'filter': {
        const t = fxParam(fx, 'type', 'lowpass');
        const fn = t === 'highpass' ? 'hpf' : t === 'bandpass' ? 'bpf' : t === 'lowpass' ? 'lpf' : null;
        if (!fn || mixv < 0.5) break;
        // a wide-open lowpass / closed highpass does nothing (e.g. the filter an automation sweep opens)
        if ((fn === 'lpf' && fxParam(fx, 'cutoff', 2000) >= 19000) || (fn === 'hpf' && fxParam(fx, 'cutoff', 2000) <= 25)) break;
        out += `.${fn}(${Math.round(fxParam(fx, 'cutoff', 2000))})`;
        const q = fxParam(fx, 'resonance', 1);
        if (Math.abs(q - 1) > 0.05 && fn !== 'bpf') out += `.${fn === 'lpf' ? 'lpq' : 'hpq'}(${num(q, 2)})`;
        done.add(fx.type);
        break;
      }
      case 'reverb':
        out += `.room(${num(fxParam(fx, 'mix', 0.3), 2)})`;
        done.add(fx.type);
        break;
      case 'delay': {
        const secs = fxParam(fx, 'sync', false) ? divisionBeats(fxParam(fx, 'division', '1/8D')) * 60 / bpm : fxParam(fx, 'time', 0.375);
        out += `.delay(${num(fxParam(fx, 'mix', 0.35), 2)}).delaytime(${num(secs, 3)}).delayfeedback(${num(fxParam(fx, 'feedback', 0.4), 2)})`;
        done.add(fx.type);
        break;
      }
      case 'distortion':
      case 'saturator':
        if (done.has('shape')) break;
        out += `.shape(${num(clamp(fxParam(fx, 'drive', fx.type === 'distortion' ? 12 : 6) / 48, 0, 0.95), 2)})`;
        done.add('shape');
        break;
      case 'bitcrusher':
        out += `.crush(${Math.round(fxParam(fx, 'bits', 8))})`;
        done.add(fx.type);
        break;
      default:
    }
  }
  // sends to the reverb / delay buses -> .room() / .delay() (when there is no insert of that kind)
  for (const [busId, amt] of Object.entries(track.sends || {})) {
    const bus = (project?.buses || []).find((b) => b.id === busId);
    if (!bus || !(amt > 0.005) || bus.mute) continue;
    const has = (type) => (bus.fx || []).some((f) => f.type === type && f.enabled !== false);
    if (has('reverb') && !done.has('reverb')) { out += `.room(${num(amt, 2)})`; done.add('reverb'); } else if (has('delay') && !done.has('delay')) { out += `.delay(${num(amt, 2)})`; done.add('delay'); }
  }
  return out;
}

const DIV = { '4/1': 16, '2/1': 8, '1/1': 4, '1/2D': 3, '1/2': 2, '1/2T': 4 / 3, '1/4D': 1.5, '1/4': 1, '1/4T': 2 / 3, '1/8D': 0.75, '1/8': 0.5, '1/8T': 1 / 3, '1/16D': 0.375, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125 };
const divisionBeats = (d) => (typeof d === 'number' ? d : DIV[d] ?? 1);

// ---------------------------------------------------------------------------- project -> code

const header = (title) => `// ── ${title} ${'─'.repeat(Math.max(3, 58 - title.length))}`;
export const HEADER_RE = /^\/\/ ── (.+?) ─+\s*$/;
const codeHeaderTitle = (name) => `code track "${String(name).replace(/"/g, "'")}"`;

function audibleState(project, track) {
  const anySolo = project.tracks.some((t) => t.solo);
  return !track.mute && (!anySolo || !!track.solo);
}

/** Prepares a code track's code for the song view (tempo / all() lines are per-track in the DAW). */
function embedCode(code, label, muted) {
  let src = String(code || '').replace(/\s+$/, '');
  src = src.split('\n').map((l) => {
    if (/^\s*(await\s+)?(setcps|setCps|setcpm|setCpm|setbpm|setBpm)\s*\(/.test(l)) return TEMPO_MARK + l;
    if (/^\s*(all|each)\s*\(/.test(l)) return ALL_MARK + l;
    return l;
  }).join('\n');
  const items = splitTopLevel(src);
  const added = [];
  if (!items.some((it) => it.kind === 'label')) {
    const at = lastExpressionStart(src);
    if (at >= 0) { src = `${src.slice(0, at)}${muted ? '_' : ''}${label}: ${src.slice(at)}`; added.push('label'); }
    return { text: src, addedLabel: at >= 0 ? label : null, mutedLabels: muted && at >= 0 ? [label] : [] };
  }
  const mutedLabels = [];
  if (muted) {
    // mute every label that plays: insert "_" (back to front so offsets stay valid)
    for (const it of items.filter((x) => x.kind === 'label' && !x.muted).reverse()) {
      src = src.slice(0, it.start) + '_' + src.slice(it.start);
      mutedLabels.push(it.name);
    }
  }
  return { text: src, addedLabel: null, mutedLabels };
}

/** Restores a code track's own code from its (edited) song-view region. */
export function unembedCode(text, block) {
  let src = String(text).replace(/^\n+|\s+$/g, '');
  src = src.split('\n').map((l) => (l.startsWith(TEMPO_MARK) ? l.slice(TEMPO_MARK.length) : l.startsWith(ALL_MARK) ? l.slice(ALL_MARK.length) : l)).join('\n');
  const items = splitTopLevel(src);
  let unmute = false;
  if (block.mutedLabels?.length) {
    const labs = items.filter((it) => it.kind === 'label');
    const stillMuted = block.mutedLabels.every((n) => labs.some((l) => l.name === n && l.muted));
    unmute = !stillMuted;
    for (const it of labs.filter((l) => l.muted && block.mutedLabels.includes(l.name)).reverse()) {
      const at = src.indexOf('_', it.start);
      if (at >= 0 && at === it.start) src = src.slice(0, at) + src.slice(at + 1);
    }
  }
  if (block.addedLabel) {
    const re = new RegExp(`^(\\s*)_?${block.addedLabel.replace(/\$/g, '\\$')}:\\s?`, 'm');
    src = src.replace(re, '$1');
  }
  return { code: src + '\n', unmute };
}

/** Clips of a track as arrangement sections (cycles), adjacent seamless clips merged. */
function trackSections(project, track, bpb, totalBeats) {
  const clips = project.clips.filter((c) => c.trackId === track.id && c.type !== 'audio' && project.patterns[c.patternId])
    .sort((a, b) => a.start - b.start);
  const secs = [];
  let pos = 0;
  for (const c of clips) {
    let start = c.start;
    let len = c.length;
    if (start < pos - EPS) { // overlapping clips: the later one wins from its start
      const prev = secs[secs.length - 1];
      if (prev && prev.patternId) prev.len = Math.max(0, start - prev.start);
      if (prev && prev.len <= EPS) secs.pop();
      pos = start;
    }
    if (start > pos + EPS) secs.push({ start: pos, len: start - pos, patternId: null });
    const prev = secs[secs.length - 1];
    const L = project.patterns[c.patternId].length || bpb;
    if (prev && prev.patternId === c.patternId && Math.abs(prev.start + prev.len - start) < EPS
      && Math.abs((((prev.offset + prev.len) % L) + L) % L - (((c.offset || 0) % L) + L) % L) < EPS) {
      prev.len += len;
    } else secs.push({ start, len, patternId: c.patternId, offset: c.offset || 0 });
    pos = start + len;
  }
  if (totalBeats > pos + EPS) secs.push({ start: pos, len: totalBeats - pos, patternId: null });
  return secs;
}

/** True when the project has an arrangement: pattern clips on instrument tracks. */
export function hasArrangement(project) {
  const inst = new Set((project.tracks || []).filter((t) => t.type === 'instrument').map((t) => t.id));
  return (project.clips || []).some((c) => c.type !== 'audio' && inst.has(c.trackId) && project.patterns?.[c.patternId]);
}

/** Song sections from the markers: [{name, label, start, end}] (beats), covering [0, total). */
function songSections(project, total, used) {
  const ms = (project.markers || []).filter((m) => m.beat >= -EPS && m.beat < total - EPS).slice().sort((a, b) => a.beat - b.beat);
  const out = [];
  for (const m of ms) {
    if (out.length && Math.abs(out[out.length - 1].start - m.beat) < EPS) { out[out.length - 1].name = m.name || out[out.length - 1].name; continue; }
    out.push({ name: String(m.name || `Section ${out.length + 1}`), start: Math.max(0, m.beat) });
  }
  if (!out.length || out[0].start > EPS) out.unshift({ name: out.length ? 'Start' : 'Song', start: 0 });
  out.forEach((s, i) => { s.end = out[i + 1] ? out[i + 1].start : total; });
  const local = new Set(used);
  for (const s of out) s.label = labelFor(s.name, local);
  return out;
}

const sig2 = (x) => {
  if (!(x > 0)) return round(x, 2);
  const p = 10 ** (Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
};
const numStr = (x) => String(round(x, 3)).replace(/^0\./, '.').replace(/^-0\./, '-.');

/** Filter insert (lowpass/highpass/bandpass) -> Strudel method name, or null. */
function filterMethod(fx) {
  if (!fx || fx.type !== 'filter' || fx.enabled === false || fxParam(fx, 'mix', 1) < 0.5) return null;
  const t = fxParam(fx, 'type', 'lowpass');
  return t === 'highpass' ? 'hpf' : t === 'bandpass' ? 'bpf' : t === 'lowpass' ? 'lpf' : null;
}
const NEUTRAL = { lpf: (v) => v >= 19000, hpf: (v) => v <= 25, bpf: () => false };

/** Automated filter lanes of a track: [{fxId, method, points}] */
function filterLanes(track) {
  const out = [];
  for (const l of track.automation || []) {
    if (l.enabled === false || !l.points?.length) continue;
    const t = parseTarget(l.target);
    if (!t || t.kind !== 'fx' || t.key !== 'cutoff') continue;
    const fx = (track.fx || []).find((f) => f.id === t.fxId);
    const method = filterMethod(fx);
    if (method) out.push({ fxId: fx.id, method, points: l.points });
  }
  return out;
}

/**
 * A lane over [a, b) beats as a section-relative Strudel value: a number, a signal ramp
 * (`saw.rangex(400, 8000).slow(16)`), a per-bar pattern ("<400 800 1600>"), or null (neutral / unchanged).
 */
function laneExpr(points, a, b, bpb, { neutral = () => false, exp = true } = {}) {
  const nb = Math.max(1, Math.round((b - a) / bpb));
  const at = (beat) => valueAt(points, beat, null);
  const samples = Array.from({ length: nb }, (_, i) => at(a + i * bpb + 0.01));
  const last = at(b - 0.02);
  const all = [...samples, last];
  const lo = Math.min(...all), hi = Math.max(...all);
  if (hi <= 0 || lo / hi > 0.95) {
    const v = sig2(samples[0]);
    return neutral(v) ? null : numStr(v);
  }
  // ramps: one across the section, or a few pieces (each a saw ramp or a held value) via arrange()
  const v0 = samples[0];
  const fits = (i, j, vEnd) => {
    // samples i..j-1 on one ramp from samples[i] to vEnd (reached at bar j)
    const v0 = samples[i];
    for (let k = i; k < j; k++) {
      const t = (k - i) / (j - i);
      const want = exp && v0 > 0 && vEnd > 0 ? v0 * (vEnd / v0) ** t : v0 + (vEnd - v0) * t;
      if (Math.abs(Math.log(Math.max(1e-6, samples[k]) / Math.max(1e-6, want))) > 0.25) return false;
    }
    return true;
  };
  const endAt = (j) => (j >= nb ? last : samples[j]);
  // a sweep across the whole section (automation is approximated: within ~±50% of the drawn curve)
  if (nb >= 2) {
    const ok = samples.every((v, k) => {
      const t = k / nb;
      const want = exp && v0 > 0 && last > 0 ? v0 * (last / v0) ** t : v0 + (last - v0) * t;
      return Math.abs(Math.log(Math.max(1e-6, v) / Math.max(1e-6, want))) < 0.45;
    });
    if (ok) return `saw.${exp ? 'rangex' : 'range'}(${numStr(sig2(v0))}, ${numStr(sig2(last))}).slow(${nb})`;
  }
  const pieces = [];
  for (let i = 0; i < nb;) {
    let j = i + 1;
    while (j < nb && fits(i, j + 1, endAt(j + 1))) j++;
    pieces.push({ i, j, v0: samples[i], v1: endAt(j) });
    i = j;
  }
  // a one-bar tail piece joins the piece before it
  while (pieces.length > 1 && pieces[pieces.length - 1].j - pieces[pieces.length - 1].i === 1) {
    const t = pieces.pop();
    pieces[pieces.length - 1].j = t.j;
    pieces[pieces.length - 1].v1 = t.v1;
  }
  const pieceExpr = (p) => {
    const n = p.j - p.i;
    if (Math.abs(Math.log(Math.max(1e-6, p.v1) / Math.max(1e-6, p.v0))) < 0.05) return { held: true, text: numStr(sig2(p.v0)) };
    return { held: false, text: `saw.${exp ? 'rangex' : 'range'}(${numStr(sig2(p.v0))}, ${numStr(sig2(p.v1))}).slow(${n})` };
  };
  if (pieces.length === 1) return pieceExpr(pieces[0]).text;
  if (pieces.length <= 4) return `arrange(${pieces.map((p) => { const e = pieceExpr(p); return `[${p.j - p.i}, ${e.held ? `"${e.text}"` : e.text}]`; }).join(', ')})`;
  return `"${barsText(samples.map((v) => ({ text: numStr(sig2(v)), w: 1 })))}"`;
}

/** Automation of a track inside [a, b) as const suffix (filter sweeps / held cutoffs). */
function sectionAutomation(track, a, b, bpb) {
  let out = '';
  for (const fl of filterLanes(track)) {
    const e = laneExpr(fl.points, a, b, bpb, { neutral: NEUTRAL[fl.method] });
    if (e) out += `.${fl.method}(${e})`;
  }
  return out;
}

/** Volume lane -> per-bar gain pattern for the whole song ("<.9@32 1.1@16 …>"), or null. */
function volumeRide(track, totalBeats, bpb, active) {
  const lane = (track.automation || []).find((l) => l.target === 'volume' && l.enabled !== false && l.points?.length);
  if (!lane) return null;
  const nb = Math.max(1, Math.round(totalBeats / bpb));
  const vals = [];
  for (let i = 0; i < nb; i++) vals.push(Math.round((valueAt(lane.points, i * bpb + 0.01, track.volume ?? DEFAULT_VOL) / DEFAULT_VOL) * 50) / 50);
  // bars where the track is silent take their neighbour's value (fewer, longer steps)
  for (let i = 0; i < nb; i++) if (!active(i)) vals[i] = null;
  let prev = vals.find((v) => v !== null) ?? 1;
  for (let i = 0; i < nb; i++) { if (vals[i] === null) vals[i] = prev; else prev = vals[i]; }
  const segs = [];
  for (const v of vals) {
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && Math.abs(lastSeg.v - v) < 0.021) lastSeg.w++;
    else segs.push({ v, w: 1 });
  }
  if (segs.length === 1) return { static: segs[0].v };
  return { mini: alternation(segs.map((s) => ({ text: numStr(s.v), w: s.w }))) };
}

/** Master volume lane -> `all(x => x.postgain(…))` (fades), or ''. */
function masterRide(project, totalBeats, bpb) {
  const lane = (project.master?.automation || []).find((l) => l.target === 'volume' && l.enabled !== false && l.points?.length >= 2);
  if (!lane) return '';
  const base = project.master.volume || 1;
  const nb = Math.max(1, Math.round(totalBeats / bpb));
  const f = (beat) => clamp(valueAt(lane.points, beat, base) / base, 0, 2);
  // the common case: a fade out at the end
  const pts = lane.points;
  const fadeStart = pts[pts.length - 2].beat, fadeEnd = pts[pts.length - 1].beat;
  if (pts[pts.length - 1].value <= 1e-3 && Math.abs(f(fadeStart) - 1) < 0.02 && pts.slice(0, -1).every((p) => Math.abs(p.value / base - 1) < 0.02)) {
    const k = Math.max(1, Math.round((fadeEnd - fadeStart) / bpb));
    const a = Math.max(0, Math.round(fadeStart / bpb));
    const rest = nb - a - k;
    const parts = [];
    if (a > 0) parts.push(`[${a}, "1"]`);
    parts.push(`[${k}, isaw.slow(${k})]`);
    if (rest > 0) parts.push(`[${rest}, "0"]`);
    return `all(x => x.postgain(arrange(${parts.join(', ')})))  // master fade-out`;
  }
  const segs = Array.from({ length: nb }, (_, i) => ({ text: numStr(Math.round(f(i * bpb + 0.01) * 50) / 50), w: 1 }));
  const runs = [];
  for (const s of segs) { const l = runs[runs.length - 1]; if (l && l.text === s.text) l.w++; else runs.push({ ...s }); }
  return runs.length > 1 ? `all(x => x.postgain("${alternation(runs)}"))  // master volume automation` : '';
}

const reuseMemo = new Map();
/** Does an earlier section's expression play this part faithfully? (memoised per engine) */
function reuseOk(core, target, L, bpb, kind) {
  const k = `${codeEngineVersion()}|${core}|${L}|${partSig(target)}|${target.map((n) => n.vel0).join(',')}`;
  if (!reuseMemo.has(k)) {
    if (reuseMemo.size > 4000) reuseMemo.clear();
    reuseMemo.set(k, verifyExpr(core, target, { cycles: L / bpb, bpb, kind }));
  }
  return reuseMemo.get(k);
}

/** Onsets + pitches only (velocities / lengths aside). */
const partShape = (target) => target.map((n) => `${n.pitch}@${n.start}`).join(';');

/** Quantized-note signature used to spot repeated / transposed patterns. */
function partSig(target, shift = 0) {
  return target.map((n) => `${n.pitch - shift}@${n.start}@${round(n.dur, 3)}@${n.vel}`).join(';');
}

const KIT_BANK = {
  '808': 'RolandTR808', '909': 'RolandTR909', trap: 'RolandTR808', reggaeton: 'RolandTR808', phonk: 'RolandTR808',
  house: 'RolandTR909', techno: 'RolandTR909', hardstyle: 'RolandTR909', industrial: 'RolandTR909', garage: 'RolandTR909',
  lofi: 'AkaiMPC60', breaks: 'AkaiMPC60', dnb: 'AkaiMPC60', chip: 'CasioRZ1', acoustic: 'RolandR8', rock: 'RolandR8',
  jazz: 'RolandR8', latin: 'RolandR8', afro: 'RolandR8', cinematic: 'RolandR8',
};
/** Drum kit -> Strudel sample bank (tidal-drum-machines names, so the code plays on strudel.cc). */
export const kitBank = (kit) => KIT_BANK[String(kit || '').toLowerCase()] || kit;

/** DAW preset -> a Strudel sound that exists on strudel.cc (export flavour). */
export function strudelSound(track) {
  const inst = track.instrument || {};
  const id = String(inst.preset || inst.params?.instrument || '').toLowerCase();
  const has = (...ws) => ws.some((w) => id.includes(w));
  if (inst.type === 'soundfont' && inst.params?.instrument) return `gm_${String(inst.params.instrument).replace(/^gm_/, '')}`;
  if (has('supersaw')) return 'supersaw';
  if (has('rhodes', 'epiano', 'electric-piano', 'wurli')) return 'gm_epiano1';
  if (has('piano', 'keys')) return 'piano';
  if (has('organ')) return 'gm_drawbar_organ';
  if (has('string')) return 'gm_string_ensemble_1';
  if (has('flute')) return 'gm_flute';
  if (has('bell', 'mallet', 'marimba', 'vibes')) return 'gm_vibraphone';
  if (has('guitar', 'pluck')) return has('pluck') ? 'gm_pizzicato_strings' : 'gm_electric_guitar_clean';
  if (has('brass', 'horn')) return 'gm_brass_section';
  if (has('choir', 'vox', 'voice')) return 'gm_choir_aahs';
  if (has('sub', 'sine', '808')) return 'sine';
  if (has('square', 'chip', 'pulse')) return 'square';
  if (has('tri', 'pad', 'warm')) return has('pad') ? 'sawtooth' : 'triangle';
  return 'sawtooth';
}

/** Comma-separated arrange() entries wrapped over lines of at most `width` characters. */
function arrangeCall(entries, prefix, width = 100) {
  const one = `${prefix}arrange(${entries.join(', ')})`;
  if (one.length <= width) return one;
  const lines = [];
  let line = '';
  for (const e of entries) {
    const piece = `${e},`;
    if (line && (`  ${line} ${piece}`).length > width) { lines.push(line); line = piece; } else line = line ? `${line} ${piece}` : piece;
  }
  if (line) lines.push(line);
  return `${prefix}arrange(\n${lines.map((l) => `  ${l}`).join('\n')}\n)`;
}

/** Appends track-level controls to the last line, continuing on indented lines when it gets long. */
function withTail(body, tail, width = 100) {
  if (!tail) return body;
  const lastLine = body.slice(body.lastIndexOf('\n') + 1);
  return body + wrapChain(`x${tail}`, lastLine.length - 1, width).slice(1);
}

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const scaleTitle = (s) => String(s || 'major').replace(/-/g, ' ');

/**
 * Renders the project as Strudel code.
 * opts.export: strudel.cc flavour (Strudel sound names, no DAW editing hints); opts.trackIds: only these tracks.
 * @returns {{code: string, mode: string, blocks: object[], labels: object, sections: object[], stats: object}}
 *   mode: 'song' when the project has an arrangement (clips) — the whole song is written —, else 'pattern'.
 *   blocks: [{ kind: 'header'|'section'|'instrument'|'code'|'audio', trackId, label, name, color, start, end,
 *              title, muted, consts: {constName: {patterns: [{id, transpose}], suffix}}, entries, mutedLabels, addedLabel }]
 */
export function songToCode(project, opts = {}) {
  const exp = !!opts.export;
  const bpb = beatsPerBar(project);
  const arranged = hasArrangement(project);
  const mode = arranged ? 'song' : 'pattern';
  const spell = noteSpeller(project);
  const key = project.key ? { root: project.key.root ?? 0, scale: project.key.scale || 'major' } : null;
  const used = new Set();
  const blocks = [];
  const tracks = (project.tracks || []).filter((t) => !opts.trackIds || opts.trackIds.includes(t.id));
  const playable = tracks.filter((t) => t.type === 'instrument' || t.type === 'code');
  const totalBeats = songLengthBeats(project);
  const stats = { parts: 0, verified: 0, humanized: 0, forms: {} };

  // ---- per-track parts
  const instTracks = tracks.filter((t) => t.type === 'instrument');
  const labelOf = new Map();
  for (const t of tracks) if (t.type !== 'audio') labelOf.set(t.id, labelFor(t.name, used));
  const sections = arranged ? songSections(project, totalBeats, used) : [];
  const sectionAt = (beat) => sections.filter((s) => s.start <= beat + EPS).pop() || sections[0];
  const constNames = new Set([...used, ...sections.map((s) => s.label)]);
  // swing / push per track (the generator bakes the genre's groove into the notes)
  const prior = project.genre ? safeGrooveSwing(project.genre) : null;
  const grooves = new Map();
  for (const t of tracks.filter((x) => x.type === 'instrument')) {
    const pats = arranged ? [...new Set(project.clips.filter((c) => c.trackId === t.id).map((c) => c.patternId))] : [t.activePatternId];
    const notes = pats.flatMap((id) => project.patterns?.[id]?.notes || []);
    const humanized = notes.filter((n) => Math.abs(n.start - Math.round(n.start * 24) / 24) > 0.002).length > notes.length * 0.1;
    if (!humanized) continue;
    const sw = detectSwing(notes, prior);
    grooves.set(t.id, sw);
  }
  const render = (pat, kind, trackId) => {
    const r = renderPart(pat?.notes || [], pat?.length || bpb, { kind, bpb, spell, key, spellKey: spell.key, groove: grooves.get(trackId) || null });
    stats.parts++;
    if (r.verified) stats.verified++;
    stats.forms[r.form] = (stats.forms[r.form] || 0) + 1;
    if ((pat?.notes || []).some((n) => Math.abs(n.start - snapBeat(n.start)) > 0.002)) stats.humanized++;
    return r;
  };

  const trackInfo = new Map(); // trackId -> { label, kind, consts, entries, body }
  const sectionConsts = new Map(sections.map((s) => [s, []])); // section -> [{name, text}]
  const globalKnown = []; // every track's section patterns (for layers that double another track)
  for (const track of instTracks) {
    const isDrums = track.instrument?.type === 'drums';
    const kind = isDrums ? 'drums' : 'melodic';
    const label = labelOf.get(track.id);
    const info = { label, kind, consts: {}, entries: [] };
    trackInfo.set(track.id, info);
    if (!arranged) continue;
    const segs = trackSections(project, track, bpb, totalBeats);
    const known = []; // [{name, sig, len, suffix, kind}]
    const byPattern = new Map(); // patternId|suffix -> {name, transpose}
    for (const s of segs) {
      if (s.len <= EPS) continue;
      const cyc = fmt(s.len / bpb, 4);
      if (!s.patternId) { info.entries.push({ cycles: s.len / bpb, ref: 'silence', transpose: 0, offset: 0, text: `[${cyc}, silence]` }); continue; }
      const pat = project.patterns[s.patternId];
      const suffix = sectionAutomation(track, s.start, s.start + s.len, bpb);
      const pk = `${s.patternId}|${suffix}`;
      let ref = byPattern.get(pk);
      if (!ref) {
        const r = render(pat, kind, track.id);
        const L = pat.length || bpb;
        const sig = partSig(r.target);
        let found = known.find((k) => k.sig === sig && Math.abs(k.len - L) < EPS && k.suffix === suffix);
        // an earlier section's pattern that plays this part too (same notes, velocities within tolerance)
        if (!found) {
          const shape = partShape(r.target);
          found = known.find((k) => k.shape === shape && Math.abs(k.len - L) < EPS && k.suffix === suffix
            && reuseOk(k.core, r.target, L, bpb, kind));
        }
        let transpose = 0;
        if (!found && kind === 'melodic' && r.target.length) {
          for (const k of known) {
            if (Math.abs(k.len - L) > EPS || k.suffix !== suffix || !k.target.length || k.target.length !== r.target.length) continue;
            const d = r.target[0].pitch - k.target[0].pitch;
            if (d && Math.abs(d) <= 12 && partSig(r.target, d) === k.sig) { found = k; transpose = d; break; }
          }
        }
        // a layer of another track (doubled strings, an octave lead): reference that track's section pattern
        if (!found && r.target.length) {
          for (const k of globalKnown) {
            if (k.trackId === track.id || k.kind !== kind || Math.abs(k.len - L) > EPS || k.suffix !== suffix || k.target.length !== r.target.length) continue;
            const d = kind === 'drums' ? 0 : r.target[0].pitch - k.target[0].pitch;
            if (Math.abs(d) > 24) continue;
            if (partSig(r.target, d) !== k.sig && !(partShape(r.target) === partShape(k.target.map((n) => ({ ...n, pitch: n.pitch + d })))
              && reuseOk(d ? `${k.core}.transpose(${d})` : k.core, r.target, L, bpb, kind))) continue;
            found = k; transpose = d;
            info.consts[k.name] = k.meta; // shared: an edit of the const rewrites every track's pattern
            break;
          }
        }
        if (found) {
          ref = { name: found.name, transpose };
          info.consts[found.name].patterns.push({ id: s.patternId, transpose });
        } else {
          const sec = sectionAt(s.start);
          const startsSection = Math.abs(sec.start - s.start) < EPS;
          const name = labelFor(`${sec.label}_${label}${startsSection ? '' : '_in'}`, constNames);
          used.add(name);
          const core = r.expr;
          info.consts[name] = { patterns: [{ id: s.patternId, transpose: 0 }], suffix, core, form: r.form };
          const k = { name, sig, shape: partShape(r.target), core, len: L, suffix, target: r.target, trackId: track.id, kind, meta: info.consts[name] };
          known.push(k);
          globalKnown.push(k);
          sectionConsts.get(sec).push({ name, core, suffix, trackId: track.id });
          ref = { name, transpose: 0 };
        }
        byPattern.set(pk, ref);
      }
      let refText = ref.name + (ref.transpose ? `.transpose(${ref.transpose})` : '');
      if (s.offset) refText += `.early(${fmt(s.offset / bpb, 4)})`;
      info.entries.push({ cycles: s.len / bpb, ref: ref.name, transpose: ref.transpose, offset: (s.offset || 0) / bpb, text: `[${cyc}, ${refText}]` });
    }
  }

  // ---- header
  let code = '';
  const push = (text) => { code += text; };
  const keyName = key ? `${rootName(key.root)} ${scaleTitle(key.scale)}` : '';
  const bars = Math.round(totalBeats / bpb);
  const facts = [keyName, `${fmt(project.bpm)} BPM`, project.genre, arranged ? `${bars} bars (${fmtTime((totalBeats * 60) / (project.bpm || 120))})` : 'loop'].filter(Boolean);
  push(`// ${project.name || 'Untitled project'} — ${facts.join(' · ')}\n`);
  const grooveId = project.genre ? safeGroove(project.genre) : null;
  if (stats.humanized) push(`// groove: ${grooveId || 'humanized'} — timing & velocity humanization is quantized here (1/16 grid, accents ±0.1);\n//   the project keeps its exact feel.\n`);
  if (!playable.length) {
    push('// This project has no tracks yet. Add some in the Rack or Piano Roll and they appear here,\n');
    push('// or write a labelled pattern below and press Ctrl+Enter to create tracks from it, e.g.\n');
    push('//   drums: s("bd*4, ~ cp, hh*8").bank("RolandTR808")\n');
    push('//   bass: n("<0 0 3 -2>*2").scale("C2:minor").s("saw-bass")\n');
  } else if (!exp) {
    push(arranged
      ? '// Edit a section pattern (const) or an arrange([bars, pattern], …) line, then Ctrl+Enter applies it.\n'
      : '// Edit any block and press Ctrl+Enter to apply it to the project (one undo step).\n');
  } else push('// Exported from daW³ — paste into strudel.cc. 1 cycle = 1 bar.\n');
  push(`setcpm(${fmt(project.bpm)}/${fmt(bpb)})\n`);
  if (project.swing > 0) push(`all(x => x.swingBy(${fmt(project.swing / 2)}, ${fmt(bpb * 2)}))\n`);
  const mr = arranged ? masterRide(project, totalBeats, bpb) : '';
  if (mr) push(mr + '\n');
  blocks.push({ kind: 'header', start: 0, end: code.length });

  // ---- sections: one const per (track, section) part, aligned
  if (arranged) {
    const firstUse = new Map();
    for (const sec of sections) {
      const list = sectionConsts.get(sec);
      const nb = fmt((sec.end - sec.start) / bpb);
      const start = code.length;
      const prevUse = list.length ? '' : ' · repeats earlier parts';
      push(`\n// —— ${sec.name} · ${nb} bar${nb === '1' ? '' : 's'}${prevUse} ——\n`);
      const w = Math.max(0, ...list.map((c) => c.name.length));
      for (const c of list) {
        const head = `const ${c.name.padEnd(w)} = `;
        push(`${head}${wrapChain(formatExpr(c.core + c.suffix, '', 100 - head.length), head.length)}\n`);
        firstUse.set(c.name, sec);
      }
      blocks.push({ kind: 'section', name: sec.name, beat: sec.start, start, end: code.length });
    }
    push(`\n// —— Arrangement · arrange([bars, pattern], …) per track ——\n`);
  }

  // ---- tracks
  for (const track of tracks) {
    const label = labelOf.get(track.id);
    const muted = !audibleState(project, track);
    const start = code.length;
    const mutedNote = track.mute ? ' · muted' : muted ? ' · silenced by solo' : '';
    if (track.type === 'audio') {
      push(`${arranged ? '' : '\n'}// ${track.name} · audio track (not expressible as code)\n`);
      blocks.push({ kind: 'audio', trackId: track.id, label: null, name: track.name, color: track.color, start, end: code.length });
      continue;
    }
    if (track.type === 'code') {
      const title = codeHeaderTitle(track.name);
      const emb = embedCode(track.code, label, muted);
      push(`\n${header(title + mutedNote)}\n${emb.text}\n`);
      blocks.push({ kind: 'code', trackId: track.id, label, name: track.name, color: track.color, title, start, end: code.length, muted, mutedLabels: emb.mutedLabels, addedLabel: emb.addedLabel, code: track.code || '' });
      continue;
    }
    if (track.type !== 'instrument') continue;
    const info = trackInfo.get(track.id);
    const isDrums = info.kind === 'drums';
    const desc = isDrums ? `drums${track.instrument?.preset ? ` (${track.instrument.preset} kit)` : ''}` : (track.instrument?.preset || track.instrument?.type || 'synth');
    const title = `${track.name} · ${desc}${mutedNote}`;
    let tail = soundCall(track, { export: exp }) + swingCall(grooves.get(track.id), bpb);
    // volume rides (song mode) replace the static gain
    let ride = null;
    if (arranged) {
      const activeBars = new Set();
      let pos = 0;
      for (const e of info.entries) { if (e.ref !== 'silence') for (let b = Math.round(pos); b < Math.round(pos + e.cycles); b++) activeBars.add(b); pos += e.cycles; }
      ride = volumeRide(track, totalBeats, bpb, (b) => activeBars.has(b));
    }
    const automated = new Set(arranged ? filterLanes(track).map((f) => f.fxId) : []);
    tail += trackControls(track, project, { ride, automated });
    let body;
    if (arranged) {
      const entries = info.entries.map((e) => e.text);
      body = !entries.length ? `${muted ? '_' : ''}${label}: silence` : arrangeCall(entries, `${muted ? '_' : ''}${label}: `);
      push(`// ${title}\n`);
    } else {
      const pat = project.patterns?.[track.activePatternId];
      const r = pat ? render(pat, info.kind, track.id) : null;
      const expr = r ? r.expr : `${isDrums ? 's' : 'note'}("~")`;
      body = `${muted ? '_' : ''}${label}: ${wrapChain(formatExpr(expr, '', 100 - label.length - 2), label.length + 2)}`;
      push(`\n// —— ${title} ——\n`);
    }
    body = withTail(body, tail);
    push(`${body}\n`);
    blocks.push({ kind: 'instrument', trackId: track.id, label, name: track.name, color: track.color, title, start, end: code.length, muted, consts: info.consts, entries: info.entries, drums: isDrums });
  }
  const labels = {};
  for (const b of blocks) if (b.label && b.kind === 'instrument') labels[b.label] = b.trackId;
  return { code, mode, blocks, labels, sections: sections.map((s) => ({ name: s.name, label: s.label, start: s.start, end: s.end })), stats };
}

function safeGrooveSwing(genre) {
  try { const g = grooveFor(genre); return g ? { s8: g.swing8 ?? 0.5, s16: g.swing16 ?? 0.5 } : null; } catch { return null; }
}

function safeGroove(genre) {
  try { return grooveFor(genre)?.id || null; } catch { return null; }
}

// ---------------------------------------------------------------------------- code -> project

const COMPLEX_RE = /\b(rand|irand|perlin|choose|chooseCycles|randcat|wchoose|shuffle|scramble|sometimes\w*|often|rarely|almostNever|almostAlways|someCycles\w*|degrade\w*|undegradeBy|sine|cosine|saw|isaw|square|tri|sine2|saw2|square2|tri2|rand2)\b/;

/** Normalised code for "did the user change this?" comparisons. */
export function normCode(s) {
  return stripComments(String(s || '')).replace(/\s+/g, '');
}

/** Rounds a beat time onto a 1/48-note-or-finer grid (keeps 16ths and triplets exact). */
const qBeat = (b) => Math.round(b * 48) / 48;

/** Events of one pattern -> DAW notes over [0, cycles). */
function eventsToNotes(pattern, { cycles, bpb, kind }) {
  const evs = queryEvents([pattern], 0, cycles);
  const notes = [];
  const gains = new Map();
  const pans = new Map();
  const ctrl = {};
  const sounds = new Map();
  const skipped = new Set();
  let melodicCount = 0;
  let drumCount = 0;
  for (const e of evs) {
    const v = e.value;
    const g = typeof v.gain === 'number' ? round(v.gain, 3) : 1;
    gains.set(g, (gains.get(g) || 0) + 1);
    const p = typeof v.pan === 'number' ? round(v.pan, 3) : 0.5;
    pans.set(p, (pans.get(p) || 0) + 1);
    for (const k of ['cutoff', 'hcutoff', 'bandf', 'resonance', 'hresonance', 'room', 'delay', 'delaytime', 'delayfeedback', 'crush', 'shape']) {
      if (typeof v[k] === 'number' && ctrl[k] === undefined) ctrl[k] = v[k];
    }
    const sname = v.s !== undefined ? String(v.s) : null;
    if (sname) sounds.set(sname, (sounds.get(sname) || 0) + 1);
    if (v.bank !== undefined) ctrl.bank = String(v.bank);
    let pitch = null;
    const isMel = typeof v.note === 'number' || typeof v.freq === 'number';
    if (kind === 'drums' || (!isMel && drumPitch(sname) !== null)) {
      pitch = drumPitch(sname);
      // "perc:60" -> pitch 60 (drum sounds without a pad name of their own)
      if (pitch !== null && typeof v.n === 'number' && v.n >= 24 && v.n < 128) pitch = Math.round(v.n);
      if (pitch === null && isMel) pitch = Math.round(v.note ?? 69 + 12 * Math.log2(v.freq / 440));
      if (pitch !== null) drumCount++;
    } else {
      if (typeof v.note === 'number') pitch = Math.round(v.note);
      else if (typeof v.freq === 'number' && v.freq > 0) pitch = Math.round(69 + 12 * Math.log2(v.freq / 440));
      else if (typeof v.n === 'number') pitch = Math.round(v.n >= 24 ? v.n : 48 + v.n);
      if (pitch !== null) melodicCount++;
    }
    if (pitch === null) { if (sname) skipped.add(sname); continue; }
    const legato = typeof v.legato === 'number' ? v.legato : typeof v.clip === 'number' ? v.clip : 1;
    const vel = typeof v.velocity === 'number' ? v.velocity : DEFAULT_VEL;
    notes.push({ pitch, start: qBeat(e.begin * bpb), dur: Math.max(0.01, round((e.end - e.begin) * legato * bpb, 5)), vel: round(clamp(vel, 0.01, 1), 3), gain: g });
  }
  const mode = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const gain = mode(gains) ?? 1;
  // per-event gain deviations fold into the velocity
  for (const n of notes) { if (Math.abs(n.gain - gain) > 1e-3 && gain > 0) n.vel = round(clamp(n.vel * (n.gain / gain), 0.01, 1), 3); delete n.gain; }
  return { notes, gain, pan: mode(pans) ?? 0.5, ctrl, sound: mode(sounds) ?? null, skipped: [...skipped], kind: drumCount > melodicCount ? 'drums' : 'melodic', count: evs.length };
}

/** Smallest repeating period (beats) of notes rendered over `cycles`, or null if they never repeat. */
function findPeriod(notes, cycles, bpb, prefer = []) {
  const total = cycles * bpb;
  const key = (n) => `${n.pitch}@${round(n.start, 3)}@${round(n.dur, 3)}@${round(n.vel, 2)}`;
  const set = new Set(notes.map(key));
  const test = (p) => {
    if (!(p > 0) || p > total / 2 + EPS) return false;
    for (const n of notes) {
      if (n.start + p >= total - EPS) continue;
      if (!set.has(key({ ...n, start: n.start + p }))) return false;
    }
    // and nothing appears later that's missing earlier
    for (const n of notes) {
      if (n.start - p < -EPS) continue;
      if (!set.has(key({ ...n, start: n.start - p }))) return false;
    }
    return true;
  };
  for (const p of prefer) if (p > 0 && test(p)) return p; // keep the pattern's length when it still fits
  const cands = [...new Set([...Array.from({ length: Math.floor(total / 2) }, (_, i) => i + 1)])].sort((a, b) => a - b);
  for (const p of cands) if (test(p)) {
    // prefer whole bars when the period is a fraction of one (a 1-beat loop -> 1 bar pattern)
    if (p < bpb && bpb % p === 0) return bpb;
    return p;
  }
  return notes.length ? null : bpb;
}

/** Renders a pattern expression into a DAW pattern: { notes, length, … } or { complex: reason }. */
export function patternToNotes(pattern, { bpb, kind, prefer = [], text = '' } = {}) {
  const maxLen = Math.max(...prefer.filter((x) => x > 0), bpb);
  const cycles = Math.max(16, Math.ceil((2 * maxLen) / bpb) * 2);
  let r;
  try { r = eventsToNotes(pattern, { cycles, bpb, kind }); } catch (e) { return { complex: `error: ${e.message}` }; }
  if (COMPLEX_RE.test(stripComments(text).replace(/"[^"]*"|`[^`]*`|'[^']*'/g, '""')) || /"[^"]*[?|][^"]*"/.test(stripComments(text))) return { complex: 'uses randomness or continuous signals', ...r };
  const period = findPeriod(r.notes, cycles, bpb, prefer);
  if (period === null) return { complex: `doesn't repeat within ${cycles} bars`, ...r };
  return { ...r, length: period, notes: r.notes.filter((n) => n.start < period - EPS).map((n) => ({ ...n, dur: Math.min(n.dur, Math.max(0.01, period * 4)) })) };
}

/** Reuses ids of unchanged notes. */
function mergeNotes(old, fresh) {
  const pool = new Map();
  for (const n of old || []) pool.set(`${n.pitch}@${round(n.start, 4)}`, n);
  return fresh.map((n) => {
    const o = pool.get(`${n.pitch}@${round(n.start, 4)}`);
    if (o) pool.delete(`${n.pitch}@${round(n.start, 4)}`);
    return { id: o?.id || createNote(n.pitch, n.start).id, pitch: n.pitch, start: n.start, dur: n.dur, vel: n.vel };
  });
}

const sameNotes = (a, b) => {
  const k = (n) => `${n.pitch}@${round(n.start, 4)}@${round(n.dur, 3)}@${round(n.vel ?? DEFAULT_VEL, 2)}`;
  const sa = (a || []).map(k).sort().join('|');
  const sb = (b || []).map(k).sort().join('|');
  return sa === sb;
};

/** Writes Strudel controls back onto a track's mixer / effects. Returns change descriptions. */
function applyControls(track, r, gen, project) {
  const out = [];
  // only what changed relative to the generated code is written back (gain rides, sends, automation stay)
  const g = gen && gen.ctrl ? gen : null;
  const vol = round(clamp(r.gain * DEFAULT_VOL, 0, 1.5), 3);
  if ((!g || Math.abs(r.gain - g.gain) > 1e-3) && Math.abs(vol - (track.volume ?? DEFAULT_VOL)) > 0.002) { track.volume = vol; out.push(`volume ${vol}`); }
  const pan = round(clamp(r.pan * 2 - 1, -1, 1), 3);
  if ((!g || Math.abs(r.pan - g.pan) > 1e-3) && Math.abs(pan - (track.pan || 0)) > 0.002) { track.pan = pan; out.push(`pan ${pan}`); }
  const genCtl = g ? g.ctrl : gen || {};
  const c = r.ctrl;
  const fxOf = (type, pred = () => true) => (track.fx || []).find((f) => f.type === type && pred(f));
  const ensureFx = (type, params) => {
    track.fx = track.fx || [];
    const f = createEffect(type, params);
    track.fx.push(f);
    return f;
  };
  const filt = (key, ftype) => {
    if (c[key] === genCtl[key]) return;
    const f = fxOf('filter', (x) => (x.params?.type || 'lowpass') === ftype);
    if (c[key] === undefined) { if (f && f.enabled !== false) { f.enabled = false; out.push(`${ftype} off`); } return; }
    if (f) { f.enabled = true; f.params = { ...f.params, cutoff: c[key] }; } else ensureFx('filter', { type: ftype, cutoff: c[key] });
    out.push(`${ftype} ${Math.round(c[key])} Hz`);
  };
  filt('cutoff', 'lowpass');
  filt('hcutoff', 'highpass');
  filt('bandf', 'bandpass');
  const simple = (key, type, param, map = (x) => x, label = type) => {
    if (c[key] === genCtl[key]) return;
    const f = fxOf(type);
    // .room() / .delay() of a track without such an insert are its send to the reverb / delay bus
    if (!f && (type === 'reverb' || type === 'delay')) {
      const bus = (project?.buses || []).find((b) => (b.fx || []).some((x) => x.type === type && x.enabled !== false));
      if (bus && (track.sends?.[bus.id] !== undefined || c[key] !== undefined)) {
        const v = round(clamp(c[key] ?? 0, 0, 1), 3);
        track.sends = { ...(track.sends || {}), [bus.id]: v };
        out.push(`${bus.name || type} send ${v}`);
        return;
      }
    }
    if (c[key] === undefined) { if (f && f.enabled !== false) { f.enabled = false; out.push(`${label} off`); } return; }
    if (f) { f.enabled = true; f.params = { ...f.params, [param]: map(c[key]) }; } else ensureFx(type, { [param]: map(c[key]) });
    out.push(`${label} ${round(map(c[key]), 3)}`);
  };
  simple('room', 'reverb', 'mix', (x) => clamp(x, 0, 1));
  simple('delay', 'delay', 'mix', (x) => clamp(x, 0, 1));
  if (c.delaytime !== genCtl.delaytime && c.delaytime !== undefined) { const f = fxOf('delay'); if (f) { f.params = { ...f.params, sync: false, time: clamp(c.delaytime, 0.01, 2) }; out.push(`delay time ${c.delaytime}s`); } }
  if (c.delayfeedback !== genCtl.delayfeedback && c.delayfeedback !== undefined) { const f = fxOf('delay'); if (f) { f.params = { ...f.params, feedback: clamp(c.delayfeedback, 0, 0.95) }; out.push(`delay feedback ${c.delayfeedback}`); } }
  simple('crush', 'bitcrusher', 'bits', (x) => clamp(Math.round(x), 1, 16), 'bitcrusher');
  if (c.shape !== genCtl.shape) {
    const f = fxOf('distortion') || fxOf('saturator');
    if (c.shape === undefined) { if (f && f.enabled !== false) { f.enabled = false; out.push('distortion off'); } } else {
      const drive = round(clamp(c.shape, 0, 1) * 48, 1);
      if (f) { f.enabled = true; f.params = { ...f.params, drive }; } else ensureFx('distortion', { drive });
      out.push(`distortion ${drive} dB`);
    }
  }
  void project;
  return out;
}

/** Sound name -> instrument for a melodic track (preset id when the sound is one). */
function instrumentFor(sound, notes, presets) {
  const s = String(sound || '').toLowerCase();
  if (presets?.[s]) return { type: presets[s].instrument?.type || 'synth', preset: s, params: {} };
  const avg = notes.reduce((a, n) => a + n.pitch, 0) / Math.max(1, notes.length);
  const low = avg < 48;
  let preset = low ? 'saw-bass' : 'saw-lead';
  if (s.includes('square')) preset = low ? 'chip-bass' : 'square-lead';
  else if (s.includes('sine')) preset = low ? 'sub-bass' : 'fm-bell-lead';
  else if (s.includes('tri')) preset = 'flute';
  else if (s.includes('epiano') || s.includes('rhodes')) preset = 'electric-piano';
  else if (s.includes('piano')) preset = 'grand-piano';
  else if (s.includes('organ')) preset = 'organ-drawbar';
  else if (s.includes('supersaw')) preset = 'supersaw-lead';
  else if (s.includes('pad')) preset = 'warm-pad';
  else if (s.includes('pluck')) preset = 'pluck';
  if (presets && !presets[preset]) return { type: 'synth', preset: null, params: {} };
  return { type: presets?.[preset]?.instrument?.type || 'synth', preset, params: {} };
}

function kitFor(bank, kits) {
  const b = String(bank || '').toLowerCase();
  if (!b) return null;
  if (kits?.[b] || !kits) return b;
  for (const id of Object.keys(kits)) if (b.includes(id)) return id;
  return null;
}

/** Sections of song code by their `// ── … ──` headers: [{title, start, end, text}] */
export function codeSections(code) {
  const lines = code.split('\n');
  const out = [];
  let off = 0;
  let cur = null;
  for (const l of lines) {
    const m = HEADER_RE.exec(l);
    if (m) {
      if (cur) { cur.end = off; out.push(cur); }
      cur = { title: m[1], start: off, bodyStart: off + l.length + 1 };
    }
    off += l.length + 1;
  }
  if (cur) { cur.end = code.length; out.push(cur); }
  for (const s of out) s.text = code.slice(s.bodyStart, s.end);
  return out;
}

/** `raw` without a trailing `suffix` (compared ignoring whitespace / comments), or null when it doesn't end with it. */
function stripTail(raw, suffix) {
  const want = normCode(suffix);
  let j = want.length;
  let i = raw.length;
  while (j > 0) {
    i--;
    if (i < 0) return null;
    if (/\s/.test(raw[i])) continue;
    if (raw[i] !== want[j - 1]) return null;
    j--;
  }
  return raw.slice(0, i);
}

/**
 * The arrange([bars, pattern], …) of a track's labelled block -> [{cycles, ref, transpose, offset}] (offset in
 * cycles), or null when the block isn't a plain arrange() of named patterns.
 */
export function parseArrange(text) {
  const src = stripComments(String(text));
  const m = /^\s*_?[\w$]+\s*:\s*arrange\s*\(/.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchParen(src, open);
  if (close < 0) return null;
  const out = [];
  for (const arg of splitArgs(src.slice(open + 1, close))) {
    const a = arg.trim();
    if (!a) continue;
    const e = /^\[\s*([\d.]+(?:\s*\/\s*[\d.]+)?)\s*,\s*([A-Za-z_$][\w$]*)((?:\s*\.\s*(?:transpose|early)\s*\(\s*-?[\d.]+\s*\))*)\s*\]$/.exec(a);
    if (!e) return null;
    const cycles = e[1].includes('/') ? Number(e[1].split('/')[0]) / Number(e[1].split('/')[1]) : Number(e[1]);
    if (!(cycles > 0)) return null;
    const tr = /\.\s*transpose\s*\(\s*(-?[\d.]+)\s*\)/.exec(e[3]);
    const ea = /\.\s*early\s*\(\s*(-?[\d.]+)\s*\)/.exec(e[3]);
    out.push({ cycles, ref: e[2], transpose: tr ? Math.round(Number(tr[1])) : 0, offset: ea ? Number(ea[1]) : 0 });
  }
  return out;
}

const sameEntries = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x.cycles - b[i].cycles) < 1e-6 && x.ref === b[i].ref
  && (x.transpose || 0) === (b[i].transpose || 0) && Math.abs((x.offset || 0) - (b[i].offset || 0)) < 1e-4);

/**
 * Rebuilds a track's clips from an edited arrange(): one clip per [bars, pattern] entry, end to end. Patterns come
 * from the track's section consts (a transposed reference gets its own transposed copy), or from a const the user
 * added (a new pattern). Returns a short description or null.
 */
function applyArrangement(project, track, entries, ctx) {
  const { b, src, editedDecls, genDecls, bpb, kind, report } = ctx;
  const created = new Map(); // const name -> patternId (new consts)
  const resolve = (e) => {
    const meta = b.consts?.[e.ref];
    if (meta) {
      // (a const shared with a layered track lists that track's patterns too: clips only use this track's own)
      const own = (x) => project.patterns[x.id]?.trackId === track.id;
      const hit = meta.patterns.find((x) => x.transpose === e.transpose && own(x));
      if (hit) return hit.id;
      const base = meta.patterns.find(own) || meta.patterns.find((x) => project.patterns[x.id]);
      if (!base) return null;
      const bp = project.patterns[base.id];
      const d = kind === 'drums' ? 0 : e.transpose - base.transpose;
      const np = createPattern(track.id, { name: `${bp.name} ${d >= 0 ? '+' : ''}${d}`, length: bp.length, color: bp.color, notes: bp.notes.map((n) => createNote(n.pitch + d, n.start, n.dur, n.vel)) });
      project.patterns[np.id] = np;
      meta.patterns.push({ id: np.id, transpose: e.transpose });
      return np.id;
    }
    // a const the user wrote (or one of another track): render it into a new pattern of this track
    if (created.has(e.ref)) return created.get(e.ref);
    const d = editedDecls.get(e.ref);
    if (!d) { report.warnings.push(`${track.name}: unknown pattern "${e.ref}" in arrange() — skipped`); return null; }
    const expr = src.slice(d.exprStart, d.end);
    const r1 = evaluate(`setcpm(1)\n${expr}`);
    if (r1.error || !r1.entries.length) { report.warnings.push(`${e.ref}: ${r1.error || 'no pattern'}`); return null; }
    const out = patternToNotes(r1.entries[0].pattern, { bpb, kind, prefer: [bpb * Math.max(1, Math.round(e.cycles))], text: expr });
    if (out.complex) { report.warnings.push(`${e.ref}: ${out.complex} — skipped`); return null; }
    const np = createPattern(track.id, { name: `${track.name} – ${e.ref}`, length: out.length, color: track.color, notes: out.notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
    project.patterns[np.id] = np;
    created.set(e.ref, np.id);
    void genDecls;
    return np.id;
  };
  const sections = (project.markers || []).slice().sort((x, y) => x.beat - y.beat);
  const nameAt = (beat) => sections.filter((m) => m.beat <= beat + EPS).pop()?.name || '';
  const clips = [];
  let pos = 0;
  for (const e of entries) {
    const len = e.cycles * bpb;
    if (e.ref !== 'silence') {
      const pid = resolve(e);
      if (pid) clips.push(createClip(track.id, { patternId: pid, start: round(pos, 6), length: round(len, 6), offset: round((e.offset || 0) * bpb, 6), name: nameAt(pos) }));
    }
    pos += len;
  }
  project.clips = project.clips.filter((c) => c.trackId !== track.id || c.type === 'audio').concat(clips);
  return `${clips.length} clip${clips.length === 1 ? '' : 's'}, ${fmt(pos / bpb)} bars`;
}

/**
 * Applies edited song code to `project` (mutates it; call inside ONE store.transact).
 * opts: { presets, kits, keepComplexAsCode: boolean | Set(labels), dryRun }
 * Returns { error, changes: string[], warnings: string[], complex: [{label, reason, text, trackId}],
 *           created: trackId[], muted: [names], changed: boolean }
 */
export function applySongCode(project, code, opts = {}) {
  const report = { error: null, changes: [], warnings: [], complex: [], created: [], muted: [], changed: false };
  const gen = songToCode(project);
  const bpb = beatsPerBar(project);
  const mode = gen.mode;
  let src = String(code ?? '');

  // header: tempo + swing
  const swingRe = /^all\(x => x\.swingBy\(([\d.]+), [\d.]+\)\)\s*$/m;
  const sm = swingRe.exec(src);
  const newSwing = sm ? round(clamp(Number(sm[1]) * 2, 0, 1), 3) : 0;
  if (sm) src = src.slice(0, sm.index) + ' '.repeat(sm[0].length) + src.slice(sm.index + sm[0].length);
  const res = evaluate(src);
  if (res.error) { report.error = res.error; return report; }
  if (Math.abs(newSwing - (project.swing || 0)) > 1e-3) { project.swing = newSwing; report.changes.push(`swing ${newSwing}`); }
  if (res.cps) {
    const bpm = round(res.cps * 60 * bpb, 2);
    if (Math.abs(bpm - project.bpm) > 0.01) { project.bpm = clamp(bpm, 20, 400); report.changes.push(`tempo ${project.bpm} BPM`); }
  }

  // controls as generated (so only what the user changed is written back)
  let genRes = null;
  const songCycles = Math.max(1, songLengthBeats(project) / bpb);
  const genInfo = (label) => {
    if (!genRes) { try { genRes = evaluate(gen.code); } catch { genRes = { entries: [] }; } }
    const e = (genRes.entries || []).find((x) => x.name === label);
    if (!e) return null;
    try { return eventsToNotes(e.pattern, { cycles: songCycles, bpb, kind: 'melodic' }); } catch { return null; }
  };
  const genSections = codeSections(gen.code);
  const sections = codeSections(src);
  const genItems = splitTopLevel(gen.code);
  const items = splitTopLevel(src);
  const itemText = (code2, it) => code2.slice(it.start, it.end);
  const trackOf = (id) => project.tracks.find((t) => t.id === id);

  // ---- code tracks (by header)
  const codeRegions = [];
  for (const b of gen.blocks.filter((x) => x.kind === 'code')) {
    const sec = sections.find((s) => s.title.startsWith(b.title));
    const genSec = genSections.find((s) => s.title.startsWith(b.title));
    const t = trackOf(b.trackId);
    if (!t) continue;
    if (!sec) {
      if (!t.mute) { t.mute = true; report.muted.push(t.name); }
      continue;
    }
    codeRegions.push([sec.bodyStart, sec.end]);
    if (genSec && normCode(sec.text) === normCode(genSec.text)) continue;
    const { code: newCode, unmute } = unembedCode(sec.text, b);
    if (normCode(newCode) !== normCode(t.code)) { t.code = newCode; report.changes.push(`${t.name}: code updated`); }
    if (unmute && t.mute) { t.mute = false; report.changes.push(`${t.name}: unmuted`); }
  }
  const inCodeRegion = (pos) => codeRegions.some(([a, b]) => pos >= a && pos < b);

  // ---- instrument tracks (by label / const name)
  const entryByName = new Map();
  for (const e of res.entries) if (!entryByName.has(e.name)) entryByName.set(e.name, e);
  const editedLabels = new Map(items.filter((it) => it.kind === 'label' && !inCodeRegion(it.start)).map((it) => [it.name, it]));
  const editedDecls = new Map(items.filter((it) => it.kind === 'decl').map((it) => [it.name, it]));
  const genLabels = new Map(genItems.filter((it) => it.kind === 'label').map((it) => [it.name, it]));
  const genDecls = new Map(genItems.filter((it) => it.kind === 'decl').map((it) => [it.name, it]));
  const stripTrackLevel = (s) => normCode(s).replace(/^_/, '').replace(/\.(gain|pan|velocity)\([^()]*\)/g, '');

  for (const b of gen.blocks.filter((x) => x.kind === 'instrument')) {
    const t = trackOf(b.trackId);
    if (!t) continue;
    const it = editedLabels.get(b.label);
    const git = genLabels.get(b.label);
    if (!it) {
      if (!t.mute) { t.mute = true; report.muted.push(t.name); }
      continue;
    }
    if (it.muted !== b.muted) {
      t.mute = it.muted;
      if (it.muted) report.muted.push(t.name); else report.changes.push(`${t.name}: unmuted`);
    }
    const kind = b.drums ? 'drums' : 'melodic';
    const changedLabel = !git || normCode(itemText(src, it)).replace(/^_/, '') !== normCode(itemText(gen.code, git)).replace(/^_/, '');
    const entry = entryByName.get(b.label);
    // song mode: section patterns live in consts, the arrangement in the track's arrange([...])
    if (mode === 'song') {
      for (const [cname, meta] of Object.entries(b.consts || {})) {
        const d = editedDecls.get(cname);
        const gd = genDecls.get(cname);
        if (!d || !gd) continue;
        const txt = itemText(src, d);
        if (normCode(txt) === normCode(itemText(gen.code, gd))) continue;
        let expr = src.slice(d.exprStart, d.end);
        // the section's automation (filter sweeps) stays in the automation lanes
        if (meta.suffix) {
          const cut = stripTail(expr, meta.suffix);
          if (cut !== null) expr = cut;
          else report.warnings.push(`${cname}: automation edits (${meta.suffix.slice(1, 40)}…) aren't applied — edit the lanes in the Arrange view.`);
        }
        const r1 = evaluate(`setcpm(1)\n${expr}`);
        if (r1.error || !r1.entries.length) { report.warnings.push(`${cname}: ${r1.error || 'no pattern'}`); continue; }
        const first = project.patterns[meta.patterns[0]?.id];
        const out = patternToNotes(r1.entries[0].pattern, { bpb, kind, prefer: [first?.length || bpb], text: expr });
        if (out.complex) { report.complex.push({ label: cname, reason: out.complex, text: txt, trackId: t.id, patternId: meta.patterns[0]?.id }); continue; }
        for (const { id, transpose } of meta.patterns) {
          const pat = project.patterns[id];
          if (!pat) continue;
          const notes = kind === 'drums' || !transpose ? out.notes : out.notes.map((n) => ({ ...n, pitch: n.pitch + transpose }));
          if (sameNotes(pat.notes, notes) && Math.abs(pat.length - out.length) < EPS) continue;
          pat.notes = mergeNotes(pat.notes, notes);
          pat.length = out.length;
          report.changes.push(`${t.name}: pattern "${pat.name}" (${notes.length} notes)`);
        }
      }
      if (changedLabel && entry) {
        const labelText = itemText(src, it);
        const parsed = parseArrange(labelText);
        if (!parsed) {
          if (!/^_?[\w$]+:\s*silence\b/.test(labelText.trim())) report.warnings.push(`${t.name}: write the arrangement as arrange([bars, pattern], …) to apply it to the clips.`);
        } else if (!sameEntries(parsed, b.entries || [])) {
          const res = applyArrangement(project, t, parsed, { b, gen, src, editedDecls, genDecls, bpb, kind, report });
          if (res) report.changes.push(`${t.name}: arrangement — ${res}`);
        }
        const r = eventsToNotes(entry.pattern, { cycles: songCycles, bpb, kind });
        if (r.count) {
          const ctl = applyControls(t, r, genInfo(b.label), project, opts);
          if (ctl.length) report.changes.push(`${t.name}: ${ctl.join(', ')}`);
        }
      }
      continue;
    }
    if (!changedLabel || !entry) continue;
    const pat = project.patterns[t.activePatternId];
    const out = patternToNotes(entry.pattern, { bpb, kind, prefer: [pat?.length || bpb], text: itemText(src, it) });
    if (out.complex) {
      report.complex.push({ label: b.label, reason: out.complex, text: itemText(src, it).replace(/^_/, ''), trackId: t.id });
      continue;
    }
    if (out.skipped?.length) report.warnings.push(`${t.name}: ignored unknown sounds ${out.skipped.map((s) => `"${s}"`).join(', ')}`);
    // instrument changes via .s() / .bank()
    const g0 = genInfo(b.label);
    if (kind === 'drums') {
      const kit = out.ctrl.bank && out.ctrl.bank !== g0?.ctrl?.bank ? kitFor(out.ctrl.bank, opts.kits) : null;
      if (kit && kit !== t.instrument?.preset) { t.instrument = { ...t.instrument, preset: kit }; report.changes.push(`${t.name}: kit ${kit}`); }
    } else if (out.sound && opts.presets?.[out.sound] && out.sound !== t.instrument?.preset) {
      t.instrument = { type: opts.presets[out.sound].instrument?.type || 'synth', preset: out.sound, params: {} };
      report.changes.push(`${t.name}: instrument ${out.sound}`);
    }
    let target = pat;
    if (!target) {
      target = createPattern(t.id, { name: `${t.name} 1`, length: out.length });
      project.patterns[target.id] = target;
      t.activePatternId = target.id;
    }
    if (!(sameNotes(target.notes, out.notes) && Math.abs(target.length - out.length) < EPS)) {
      target.notes = mergeNotes(target.notes, out.notes);
      target.length = out.length;
      report.changes.push(`${t.name}: ${out.notes.length} notes, ${fmt(out.length / bpb)} bar${out.length === bpb ? '' : 's'}`);
    }
    const ctl = applyControls(t, out, g0, project, opts);
    if (ctl.length) report.changes.push(`${t.name}: ${ctl.join(', ')}`);
  }

  // ---- new labelled blocks -> new tracks
  const known = new Set(gen.blocks.filter((b) => b.kind === 'instrument').map((b) => b.label));
  for (const [name, it] of editedLabels) {
    if (known.has(name)) continue;
    const entry = entryByName.get(name);
    if (!entry) continue;
    const text = itemText(src, it);
    const probe = eventsToNotes(entry.pattern, { cycles: 4, bpb, kind: 'melodic' });
    if (!probe.count) { report.warnings.push(`${name}: produced no events — skipped`); continue; }
    const kind = probe.kind;
    const out = patternToNotes(entry.pattern, { bpb, kind, prefer: [bpb], text });
    const keep = opts.keepComplexAsCode === true || (opts.keepComplexAsCode instanceof Set && opts.keepComplexAsCode.has(name));
    if (out.complex) {
      if (keep) {
        const t = createTrack({ type: 'code', name: name.replace(/_/g, ' '), color: '#ffd43b', role: 'code' });
        t.code = text.replace(/^_/, '').replace(new RegExp(`^${name}:\\s*`), '$: ') + '\n';
        t.mute = it.muted;
        project.tracks.push(t);
        report.created.push(t.id);
        report.changes.push(`new code track "${t.name}"`);
      } else report.complex.push({ label: name, reason: out.complex, text, trackId: null });
      continue;
    }
    const isDrums = kind === 'drums';
    const t = createTrack({
      name: name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      role: isDrums ? 'drums' : (out.notes.reduce((a, n) => a + n.pitch, 0) / Math.max(1, out.notes.length) < 48 ? 'bass' : null),
      instrument: isDrums ? { type: 'drums', preset: kitFor(out.ctrl.bank, opts.kits) || '808', params: {} } : instrumentFor(out.sound, out.notes, opts.presets),
    });
    if (isDrums) t.color = '#ff5f6d';
    t.mute = it.muted;
    t.volume = round(clamp(out.gain * DEFAULT_VOL, 0, 1.5), 3);
    t.pan = round(clamp(out.pan * 2 - 1, -1, 1), 3);
    const pat = createPattern(t.id, { name: `${t.name} 1`, length: out.length, notes: out.notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
    t.activePatternId = pat.id;
    project.tracks.push(t);
    project.patterns[pat.id] = pat;
    if (mode === 'song') project.clips.push(createClip(t.id, { patternId: pat.id, start: 0, length: songLengthBeats(project) }));
    if (project.scenes?.[0]) project.scenes[0].slots[t.id] = pat.id;
    applyControls(t, out, null, project);
    report.created.push(t.id);
    report.changes.push(`new ${isDrums ? 'drum' : 'instrument'} track "${t.name}" (${out.notes.length} notes)`);
  }

  // complex blocks of existing tracks the user chose to keep as code
  for (const c of [...report.complex]) {
    if (!c.trackId) continue;
    const keep = opts.keepComplexAsCode === true || (opts.keepComplexAsCode instanceof Set && opts.keepComplexAsCode.has(c.label));
    if (!keep) continue;
    const src0 = trackOf(c.trackId);
    if (!src0) continue;
    const t = createTrack({ type: 'code', name: `${src0.name} (code)`, color: src0.color, role: 'code' });
    let body = c.text;
    if (c.patternId) body = `$: ${body.replace(/^const\s+[\w$]+\s*=\s*/, '')}${soundCall(src0)}`;
    else body = body.replace(new RegExp(`^${c.label}:\\s*`), '$: ');
    t.code = body + '\n';
    project.tracks.splice(project.tracks.indexOf(src0) + 1, 0, t);
    if (!src0.mute && !c.patternId) { src0.mute = true; report.muted.push(src0.name); }
    report.created.push(t.id);
    report.changes.push(`"${src0.name}" kept as code track "${t.name}"`);
    report.complex.splice(report.complex.indexOf(c), 1);
  }

  report.changed = !!(report.changes.length || report.muted.length || report.created.length);
  return report;
}
