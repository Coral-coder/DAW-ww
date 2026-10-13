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
import { evaluate, queryEvents, splitTopLevel, stripComments, lastExpressionStart } from './strudel.js';
import { drumPitch } from './convert.js';

const EPS = 1e-6;
const SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
const PITCH_TO_SHORT = Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.short]));
const DRUM_ORDER = new Map(DRUM_PADS.map((p, i) => [p.pitch, i]));
// keys whose signature uses flats (major-relative pitch class of the key)
const FLAT_KEYS = new Set([5, 10, 3, 8, 1, 6]);
const RES = [1, 2, 4, 3, 8, 6, 12, 16, 24];
/**
 * Onset quantisation used by the code view: onsets on the 1/24-beat grid (16ths, 32nds, 8th and
 * 16th triplets) stay; others snap to the nearest 16th when within 0.05 beat (humanised or strummed
 * notes), else to the nearest 1/24 beat.
 */
export function snapBeat(b) {
  const s24 = Math.round(b * 24) / 24;
  if (Math.abs(b - s24) < 0.002) return s24; // already on the fine grid (32nds, triplets, fast arps)
  const s16 = Math.round(b * 4) / 4;
  if (Math.abs(b - s16) <= 0.05 + 1e-9) return s16;
  return Math.round(b * 24) / 24;
}
/** Velocity quantisation used by the code view (0.05 steps — inaudible, far more readable). */
export const qVel = (v) => Math.round(clamp(v, 0, 1) * 20) / 20;
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

/** True when every value in `times` (beats) lies on a grid of `r` steps per beat. */
const onGrid = (times, r) => times.every((t) => Math.abs(t * r - Math.round(t * r)) < 1e-3 * r + 1e-6);
function chooseRes(times) {
  for (const r of RES) if (onGrid(times, r)) return r;
  return 24; // starts are pre-snapped to 1/24 beat
}

const wrap = (x) => (/\s/.test(x) ? `[${x}]` : x);

/** Drop rests at every other (or every 2nd/3rd of three) position while possible: "bd ~ sd ~" -> "bd sd". */
function reduceRests(tokens) {
  for (;;) {
    let done = true;
    for (const f of [2, 3]) {
      if (tokens.length > 1 && tokens.length % f === 0 && tokens.every((t, i) => i % f === 0 || t === '~')) {
        tokens = tokens.filter((_, i) => i % f === 0);
        done = false;
        break;
      }
    }
    if (done) return tokens;
  }
}

/** Compact mini-notation for a grid of one-step tokens (drum hits / velocities). */
export function compactSteps(tokens, { rests = true } = {}) {
  if (rests) tokens = reduceRests(tokens);
  const n = tokens.length;
  if (n === 0) return '~';
  if (n === 1) return tokens[0];
  if (tokens.every((t) => t === tokens[0])) return tokens[0] === '~' ? '~' : `${tokens[0]}*${n}`;
  const cands = [];
  // grouped by beats/halves: "bd ~ [~ bd] ~"
  for (const g of [4, 3, 2, 8, 6]) {
    if (n % g || n / g < 2) continue;
    const per = n / g;
    const parts = [];
    for (let i = 0; i < g; i++) parts.push(wrap(compactSteps(tokens.slice(i * per, (i + 1) * per), { rests })));
    cands.push(parts.join(' '));
  }
  // periodic: "[~ hh]*4"
  for (let p = 1; p <= n / 2; p++) {
    if (n % p) continue;
    let ok = true;
    for (let i = p; i < n && ok; i++) ok = tokens[i] === tokens[i - p];
    if (ok) { cands.push(`${wrap(compactSteps(tokens.slice(0, p), { rests }))}*${n / p}`); break; }
  }
  cands.push(tokens.join(' '));
  let best = cands[0];
  for (const c of cands) if (c.length < best.length) best = c;
  return best;
}

/** Weighted items [{tok, w}] -> "c3@3 e3" (weights reduced by their gcd). */
function weightedSeq(items) {
  if (!items.length) return '~';
  const g = items.reduce((a, it) => gcd(a, it.w), 0) || 1;
  const ws = items.map((it) => it.w / g);
  if (ws.every((w) => w === 1)) return compactSteps(items.map((it) => it.tok), { rests: false });
  return items.map((it, i) => (ws[i] === 1 ? it.tok : `${it.tok}@${ws[i]}`)).join(' ');
}

/** Alternation of segments [{text, w}] -> "<a b@2 c!2>" (or just "a"). */
function alternation(segs) {
  if (!segs.length) return '~';
  // periodic segment lists collapse to their period
  const key = (s) => `${s.text}@${s.w}`;
  for (let p = 1; p < segs.length; p++) {
    if (segs.length % p) continue;
    let ok = true;
    for (let i = p; i < segs.length && ok; i++) ok = key(segs[i]) === key(segs[i - p]);
    if (ok) { segs = segs.slice(0, p); break; }
  }
  if (segs.length === 1 && segs[0].w === 1) return segs[0].text;
  const out = [];
  for (let i = 0; i < segs.length;) {
    let j = i + 1;
    while (j < segs.length && key(segs[j]) === key(segs[i])) j++;
    const s = segs[i];
    let t = wrap(s.text) + (s.w !== 1 ? `@${s.w}` : '');
    if (j - i > 1) t += `!${j - i}`;
    out.push(t);
    i = j;
  }
  return `<${out.join(' ')}>`;
}

/** Splits [0, bars) into groups so no note crosses a group boundary. -> [[barStart, barEnd]] */
function barGroups(notes, bars, barLen) {
  const groups = [];
  let b = 0;
  while (b < bars) {
    let end = b + 1;
    for (let changed = true; changed;) {
      changed = false;
      for (const n of notes) {
        if (n.start >= b * barLen - EPS && n.start < end * barLen - EPS && n.start + n.dur > end * barLen + 1e-4) {
          end = Math.min(bars, Math.ceil((n.start + n.dur) / barLen - 1e-4));
          changed = true;
        }
      }
      if (end >= bars) { end = bars; break; }
    }
    groups.push([b, end]);
    b = end;
  }
  return groups;
}

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

function mergeRests(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.tok === '~' && it.tok === '~') last.w += it.w;
    else out.push({ ...it });
  }
  return out;
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

/** Mini-notation string literal; long ones become multi-line template strings. */
function strLit(mini, indent = '') {
  if (mini.length <= 96 || !mini.startsWith('<') || !mini.endsWith('>')) return `"${mini}"`;
  // one alternation step per line
  const inner = mini.slice(1, -1);
  const parts = [];
  let depth = 0, cur = '';
  for (const c of inner) {
    if ('[<{('.includes(c)) depth++;
    else if (']>})'.includes(c)) depth--;
    if (c === ' ' && depth === 0) { if (cur) parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur) parts.push(cur);
  const lines = [];
  let line = '';
  for (const p of parts) {
    if (line && (line + ' ' + p).length > 72) { lines.push(line); line = p; } else line = line ? `${line} ${p}` : p;
  }
  if (line) lines.push(line);
  return '`<\n' + lines.map((l) => `${indent}  ${l}`).join('\n') + `\n${indent}>\``;
}

/** The note-producing expression for a pattern (no track-level controls). */
export function patternExpr(pattern, { kind, bpb, spell, indent = '' }) {
  const fn = kind === 'drums' ? 's' : 'note';
  if (!pattern || !pattern.notes?.length) {
    const len = pattern?.length || bpb;
    const sl = len / bpb;
    return `${fn}("~")${Math.abs(sl - 1) > EPS ? `.slow(${fmt(sl)})` : ''}`;
  }
  const { voices, slow } = notesToVoices(pattern.notes, pattern.length || bpb, { kind, beatsPerBar: bpb, spell });
  const slowStr = Math.abs(slow - 1) < EPS ? '' : (Number.isInteger(round(1 / slow, 6)) ? `.fast(${fmt(1 / slow)})` : `.slow(${fmt(slow)})`);
  const vels = voices.map((v) => v.vel);
  const uniform = vels.every((v) => typeof v !== 'string') && new Set(vels.map((v) => v ?? DEFAULT_VEL)).size === 1;
  if (uniform) {
    const v = vels[0] ?? DEFAULT_VEL;
    const minis = voices.map((x) => x.mini);
    const joined = minis.join(', ');
    let body;
    if (joined.length > 96 && minis.length > 1) body = '`' + minis.map((m, i) => (i ? `${indent}  ${m}` : m)).join(',\n') + '`';
    else body = strLit(joined, indent);
    return `${fn}(${body})${slowStr}${Math.abs(v - DEFAULT_VEL) > 0.005 ? `.velocity(${velStr(v)})` : ''}`;
  }
  if (voices.length === 1) {
    const v = voices[0];
    return `${fn}(${strLit(v.mini, indent)})${slowStr}.velocity(${typeof v.vel === 'string' ? strLit(v.vel, indent) : velStr(v.vel ?? DEFAULT_VEL)})`;
  }
  const rows = voices.map((v) => {
    let e = `${fn}(${strLit(v.mini, indent + '  ')})`;
    if (v.vel !== null) e += `.velocity(${typeof v.vel === 'string' ? strLit(v.vel, indent + '  ') : velStr(v.vel)})`;
    return `${indent}  ${e},`;
  });
  return `stack(\n${rows.join('\n')}\n${indent})${slowStr}`;
}

// ---------------------------------------------------------------------------- track controls

function fxParam(fx, key, def) {
  const v = fx.params?.[key];
  return v === undefined || v === null ? def : v;
}

/** Track instrument -> Strudel sound / bank call. */
export function soundCall(track) {
  const inst = track.instrument || {};
  if (inst.type === 'drums') return inst.preset ? `.bank("${inst.preset}")` : '';
  const s = inst.preset || ({ synth: 'sawtooth', fm: 'fm', organ: 'organ', sampler: 'piano' }[inst.type]) || 'sawtooth';
  return `.s("${s}")`;
}

/** Mixer + main insert effects -> Strudel controls. */
export function trackControls(track, project) {
  let out = '';
  const vol = typeof track.volume === 'number' ? track.volume : DEFAULT_VOL;
  if (Math.abs(vol - DEFAULT_VOL) > 1e-3) out += `.gain(${fmt(vol / DEFAULT_VOL)})`;
  if (track.pan) out += `.pan(${fmt((track.pan + 1) / 2)})`;
  const bpm = project?.bpm || 120;
  const done = new Set();
  for (const fx of track.fx || []) {
    if (fx.enabled === false || done.has(fx.type)) continue;
    const mixv = fxParam(fx, 'mix', 1);
    switch (fx.type) {
      case 'filter': {
        const t = fxParam(fx, 'type', 'lowpass');
        const fn = t === 'highpass' ? 'hpf' : t === 'bandpass' ? 'bpf' : t === 'lowpass' ? 'lpf' : null;
        if (!fn || mixv < 0.5) break;
        out += `.${fn}(${Math.round(fxParam(fx, 'cutoff', 2000))})`;
        const q = fxParam(fx, 'resonance', 1);
        if (Math.abs(q - 1) > 0.05 && fn !== 'bpf') out += `.${fn === 'lpf' ? 'lpq' : 'hpq'}(${fmt(q, 2)})`;
        done.add(fx.type);
        break;
      }
      case 'reverb':
        out += `.room(${fmt(fxParam(fx, 'mix', 0.3), 2)})`;
        done.add(fx.type);
        break;
      case 'delay': {
        const secs = fxParam(fx, 'sync', false) ? divisionBeats(fxParam(fx, 'division', '1/8D')) * 60 / bpm : fxParam(fx, 'time', 0.375);
        out += `.delay(${fmt(fxParam(fx, 'mix', 0.35), 2)}).delaytime(${fmt(secs, 3)}).delayfeedback(${fmt(fxParam(fx, 'feedback', 0.4), 2)})`;
        done.add(fx.type);
        break;
      }
      case 'distortion':
      case 'saturator':
        if (done.has('shape')) break;
        out += `.shape(${fmt(clamp(fxParam(fx, 'drive', fx.type === 'distortion' ? 12 : 6) / 48, 0, 0.95), 2)})`;
        done.add('shape');
        break;
      case 'bitcrusher':
        out += `.crush(${Math.round(fxParam(fx, 'bits', 8))})`;
        done.add(fx.type);
        break;
      default:
    }
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

/**
 * Renders the project as Strudel code.
 * @returns {{code: string, mode: string, blocks: object[], labels: object}}
 *   blocks: [{ kind: 'header'|'instrument'|'code'|'audio', trackId, label, name, color, start, end,
 *              title, muted, consts: {constName: patternId}, mutedLabels, addedLabel }]
 */
export function songToCode(project) {
  const bpb = beatsPerBar(project);
  const mode = project.mode === 'song' ? 'song' : 'pattern';
  const spell = noteSpeller(project);
  const used = new Set();
  const blocks = [];
  let code = '';
  const push = (text) => { code += text; };

  const tracks = project.tracks || [];
  const playable = tracks.filter((t) => t.type === 'instrument' || t.type === 'code');
  push(`// ${project.name || 'Untitled project'} — the whole project as Strudel code (${mode} mode).\n`);
  if (!playable.length) {
    push('// This project has no tracks yet. Add some in the Rack or Piano Roll and they appear here,\n');
    push('// or write a labelled pattern below and press Ctrl+Enter to create tracks from it, e.g.\n');
    push('//   drums: s("bd*4, ~ cp, hh*8").bank("808")\n');
    push('//   bass: note("<c2 c2 eb2 g1>*2").s("saw-bass")\n');
  } else {
    push(mode === 'song'
      ? '// Edit a pattern (const) or a track\'s gain/pan, then press Ctrl+Enter to apply it to the project.\n'
      : '// Edit any block and press Ctrl+Enter to apply it to the project (one undo step).\n');
  }
  push(`setcpm(${fmt(project.bpm)}/${fmt(bpb)})\n`);
  if (project.swing > 0) push(`all(x => x.swingBy(${fmt(project.swing / 2)}, ${fmt(bpb * 2)}))\n`);
  blocks.push({ kind: 'header', start: 0, end: code.length });

  const totalBeats = songLengthBeats(project);
  for (const track of tracks) {
    const label = labelFor(track.name, used);
    const muted = !audibleState(project, track);
    const start = code.length;
    const mutedNote = track.mute ? ' · muted' : muted ? ' · silenced by solo' : '';
    if (track.type === 'audio') {
      push(`\n${header(`${track.name} · audio track (not expressible as code)`)}\n`);
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
    const isDrums = track.instrument?.type === 'drums';
    const kind = isDrums ? 'drums' : 'melodic';
    const desc = isDrums ? `drums${track.instrument?.preset ? ` (${track.instrument.preset} kit)` : ''}` : (track.instrument?.preset || track.instrument?.type || 'synth');
    const title = `${track.name} · ${desc}${mutedNote}`;
    const tail = soundCall(track) + trackControls(track, project);
    const consts = {};
    let body = '';
    if (mode === 'pattern') {
      const pat = project.patterns?.[track.activePatternId];
      body = `${muted ? '_' : ''}${label}: ${patternExpr(pat, { kind, bpb, spell })}${tail}`;
    } else {
      const secs = trackSections(project, track, bpb, totalBeats);
      const constNames = new Map();
      const usedConst = new Set([...used]);
      for (const s of secs) {
        if (!s.patternId || constNames.has(s.patternId)) continue;
        const pat = project.patterns[s.patternId];
        const base = `${label}_${labelFor(String(pat.name || 'pattern').replace(new RegExp(`^${track.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–:]?\\s*`, 'i'), ''), new Set())}`;
        const cname = labelFor(base, usedConst);
        used.add(cname);
        constNames.set(s.patternId, cname);
        consts[cname] = s.patternId;
        body += `const ${cname} = ${patternExpr(pat, { kind, bpb, spell })}\n`;
      }
      const args = secs.filter((s) => s.len > EPS).map((s) => {
        const cyc = fmt(s.len / bpb, 4);
        if (!s.patternId) return `[${cyc}, silence]`;
        const off = s.offset ? `.early(${fmt(s.offset / bpb, 4)})` : '';
        return `[${cyc}, ${constNames.get(s.patternId)}${off}]`;
      });
      const one = `arrange(${args.join(', ')})`;
      const arr = !args.length ? 'silence' : one.length <= 90 ? one : `arrange(\n${args.map((a) => `  ${a},`).join('\n')}\n)`;
      body += `${muted ? '_' : ''}${label}: ${arr}${tail}`;
    }
    push(`\n${header(title)}\n${body}\n`);
    blocks.push({ kind: 'instrument', trackId: track.id, label, name: track.name, color: track.color, title, start, end: code.length, muted, consts, drums: isDrums });
  }
  const labels = {};
  for (const b of blocks) if (b.label && b.kind === 'instrument') labels[b.label] = b.trackId;
  return { code, mode, blocks, labels };
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
  const vol = round(clamp(r.gain * DEFAULT_VOL, 0, 1.5), 3);
  if (Math.abs(vol - (track.volume ?? DEFAULT_VOL)) > 0.002) { track.volume = vol; out.push(`volume ${vol}`); }
  const pan = round(clamp(r.pan * 2 - 1, -1, 1), 3);
  if (Math.abs(pan - (track.pan || 0)) > 0.002) { track.pan = pan; out.push(`pan ${pan}`); }
  // effects: only those whose code changed relative to what we generated
  const genCtl = gen || {};
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
  const genCtl = (label) => {
    if (!genRes) { try { genRes = evaluate(gen.code); } catch { genRes = { entries: [] }; } }
    const e = (genRes.entries || []).find((x) => x.name === label);
    if (!e) return {};
    try { return eventsToNotes(e.pattern, { cycles: Math.max(1, songLengthBeats(project) / bpb), bpb, kind: 'melodic' }).ctrl; } catch { return {}; }
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
    // song mode: patterns live in consts
    if (mode === 'song') {
      for (const [cname, patId] of Object.entries(b.consts || {})) {
        const d = editedDecls.get(cname);
        const gd = genDecls.get(cname);
        if (!d || !gd) continue;
        const txt = itemText(src, d);
        if (normCode(txt) === normCode(itemText(gen.code, gd))) continue;
        const expr = src.slice(d.exprStart, d.end);
        const r1 = evaluate(`setcpm(1)\n${expr}`);
        if (r1.error || !r1.entries.length) { report.warnings.push(`${cname}: ${r1.error || 'no pattern'}`); continue; }
        const pat = project.patterns[patId];
        const out = patternToNotes(r1.entries[0].pattern, { bpb, kind, prefer: [pat?.length || bpb], text: expr });
        if (out.complex) { report.complex.push({ label: cname, reason: out.complex, text: txt, trackId: t.id, patternId: patId }); continue; }
        if (pat && !(sameNotes(pat.notes, out.notes) && Math.abs(pat.length - out.length) < EPS)) {
          pat.notes = mergeNotes(pat.notes, out.notes);
          pat.length = out.length;
          report.changes.push(`${t.name}: pattern "${pat.name}" (${out.notes.length} notes)`);
        }
      }
      if (changedLabel && entry) {
        if (stripTrackLevel(itemText(src, it)) !== stripTrackLevel(itemText(gen.code, git))) {
          report.warnings.push(`${t.name}: arrangement edits aren't applied in song mode — change clips in the Arrange view, or switch to pattern mode to edit the playing patterns.`);
        }
        const r = eventsToNotes(entry.pattern, { cycles: Math.max(1, songLengthBeats(project) / bpb), bpb, kind });
        if (r.count) {
          const ctl = applyControls(t, r, genCtl(b.label), project);
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
    if (kind === 'drums') {
      const kit = out.ctrl.bank ? kitFor(out.ctrl.bank, opts.kits) : null;
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
    const ctl = applyControls(t, out, genCtl(b.label), project);
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
    applyControls(t, out, {}, project);
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
