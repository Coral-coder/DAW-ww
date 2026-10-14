// Strudel code -> multi-track daW³ project ("Split into tracks": one track per instrument, with its effects).
//
//   analyzeStrudel(code, opts)        -> analysis (pure data; needs loadStrudel() resolved — real Strudel engine)
//   splitStrudelToProject(project, code | analysis, opts) -> summary   mutates `project` (call inside store.transact)
//   importStrudelSplit(store, code, opts) -> Promise<summary>           loads the engine + one undo step (UI / Pocket)
//   splitCodeByLabels(code)           -> [{name, code, muted}]          "Keep as code tracks" (one per `$:` block)
//   summaryText(summary)              -> string                         human-readable report
//
// How it works: the code is evaluated by the vendored Strudel engine and its haps are queried over the whole piece
// (arrange() sections, else the detected loop length). Every hap is attributed to the top-level `const name =` /
// `name:` block its mini-notation came from (hap.context.locations -> source offsets), so tracks are named after
// the code ("drums", "bass", "stabs"…). Drum sounds of a source become ONE drum track (pads mapped bd->kick …,
// sampled machine from .bank()); every melodic source/sound becomes a 'strudel' instrument (superdough patch from
// the hap's synth controls). Strudel's effect controls become daW³ inserts / sends / mixer settings — constant
// values as static params, values that change over time as automation lanes, per-hap gain as note velocities.
import { evaluate, queryEvents, loadStrudel, codeEngine } from './strudel.js';
import { strudelModules } from './strudel-real.js';
import { noteToMidi } from './theory.js';
import { SCALES } from '../theory/scales.js';
import { drumKey } from './convert.js';
import {
  createTrack, createPattern, createClip, createNote, createEffect, createBus, createProject, DRUM_PADS, TRACK_COLORS,
} from '../core/model.js';
import { createAutomationLane } from '../core/automation.js';
import { uid } from '../core/util.js';
import { canonicalBank, splitBankSound, DRUM_MACHINES, NAME_TO_PAD, MACHINE_FILES, resolvePadSamples } from '../audio/library/drum-machines.js';
import { STRUDEL_PATCHES, STRUDEL_SYNTHS } from '../audio/strudel-patches.js';
import { PRESETS } from '../audio/presets.js';
import { PRESET_STRUDEL } from '../gen/strudel-sounds.js';
import { DIVISIONS } from '../audio/effect-defs.js';

const EPS = 1e-6;
const MAX_CYCLES = 512;
const LOOP_PROBE = 64;
const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const mode = (arr) => {
  const m = new Map();
  for (const x of arr) { const k = JSON.stringify(x); m.set(k, (m.get(k) || 0) + 1); }
  let best = null, bn = -1;
  for (const [k, n] of m) if (n > bn) { bn = n; best = k; }
  return best === null ? undefined : JSON.parse(best);
};
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ------------------------------------------------------------------------------------------- source map

const SOUND_CALL = /(^|[^\w$])(s|sound)\s*\(|\.(s|sound|bank)\s*\(|(^|[^\w$])(note|n|freq)\s*\(/;

/** Top-level declarations / labelled blocks of the code, with their dependencies and priority. */
function sourceMap(code) {
  const S = strudelModules();
  let ast;
  try { ast = S.acornParse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: false }); } catch { return { defs: [], ast: null }; }
  const defs = [];
  const add = (name, node, init, kind) => {
    const text = code.slice(node.start, node.end);
    let prio = 1;
    if (kind === 'label') prio = 3;
    else if (init && (init.type === 'Literal' || (init.type === 'TemplateLiteral' && !init.expressions.length))) prio = 0;
    else if (SOUND_CALL.test(text)) prio = 2;
    defs.push({ name, kind, start: node.start, end: node.end, node: init || node, prio, deps: new Set() });
  };
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id?.type === 'Identifier' && d.init) add(d.id.name, d, d.init, 'const');
    } else if (node.type === 'FunctionDeclaration' && node.id) add(node.id.name, node, node, 'const');
    else if (node.type === 'LabeledStatement') {
      const base = node.label.name.replace(/^_|_$/g, '').replace(/^S(?=[A-Za-z$])/, (m) => m);
      if (base.includes('$') || /^d\d+$|^p\d+$/.test(base)) continue; // anonymous `$:` blocks name nothing
      add(base, node, node.body, 'label');
    }
  }
  const names = new Set(defs.map((d) => d.name));
  const walk = (n, out) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier' && names.has(n.name)) out.add(n.name);
    for (const k of Object.keys(n)) {
      if (k === 'property' && n.type === 'MemberExpression' && !n.computed) continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, out));
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, out);
    }
  };
  for (const d of defs) { walk(d.node, d.deps); d.deps.delete(d.name); }
  // transitive closure
  const byName = new Map(defs.map((d) => [d.name, d]));
  for (const d of defs) {
    const stack = [...d.deps];
    while (stack.length) {
      const n = stack.pop();
      for (const x of byName.get(n)?.deps || []) if (x !== d.name && !d.deps.has(x)) { d.deps.add(x); stack.push(x); }
    }
  }
  return { defs, ast };
}

/** The const / label a hap belongs to (by its source locations), or null. */
function makeResolver(code, defs) {
  const cache = new Map();
  const defAt = (pos) => defs.find((d) => pos >= d.start && pos < d.end) || null;
  return (locations, value) => {
    if (!locations?.length) return null;
    const key = locations.map((l) => l.start).join(',') + '|' + (value?.s ?? '');
    if (cache.has(key)) return cache.get(key);
    const cands = new Map();
    let soundDef = null;
    for (const l of locations) {
      const d = defAt(l.start);
      if (!d) continue;
      cands.set(d.name, d);
      const txt = code.slice(l.start, l.end).split(':')[0];
      if (value && value.s !== undefined && txt === String(value.s)) soundDef = d;
    }
    let list = [...cands.values()];
    let res = null;
    if (list.length) {
      const top = Math.max(...list.map((d) => d.prio));
      list = list.filter((d) => d.prio === top);
      // most derived: not a dependency of another candidate
      const derived = list.filter((d) => !list.some((o) => o !== d && o.deps.has(d.name)));
      if (derived.length === 1) res = derived[0].name;
      else if (soundDef && derived.includes(soundDef)) res = soundDef.name;
      else res = (derived.length ? derived : list).sort((a, b) => b.start - a.start)[0].name;
    }
    cache.set(key, res);
    return res;
  };
}

/** arrange([cycles, pat], …) sections of the code (the longest arrange call) with their `// comment` names. */
function arrangeSections(code, ast) {
  if (!ast) return null;
  const calls = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'arrange') calls.push(n);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
    }
  };
  ast.body.forEach(visit);
  let best = null;
  for (const c of calls) {
    const secs = [];
    let at = 0;
    for (const a of c.arguments) {
      if (a.type !== 'ArrayExpression' || !a.elements.length) return null;
      const n = a.elements[0];
      const cyc = n?.type === 'Literal' && isNum(n.value) ? n.value : null;
      if (!(cyc > 0)) { secs.length = 0; break; }
      const lineEnd = code.indexOf('\n', a.start);
      const line = code.slice(a.start, lineEnd < 0 ? code.length : lineEnd);
      const cm = /\/\/\s*(.+?)\s*$/.exec(line);
      secs.push({ name: cm ? cm[1].slice(0, 40) : `Section ${secs.length + 1}`, start: at, cycles: cyc });
      at += cyc;
    }
    if (secs.length && (!best || at > best.total)) best = { sections: secs, total: at };
  }
  return best;
}

// ------------------------------------------------------------------------------------------- hap model

const SYNTH_SET = new Set([...STRUDEL_SYNTHS, 'saw', 'sin', 'sqr', 'tri', 'zzfx', 'bytebeat', 'sbd', 'user', 'one']);
const isSynth = (s) => SYNTH_SET.has(String(s)) || /^(z_|wt_)/.test(String(s));
const isPresetName = (s) => !!PRESETS[s] && !SYNTH_SET.has(s);

/** Drum info of a hap value: { pad: 'kick'…, short: 'bd'…, machine } or null. */
function drumInfo(v) {
  if (v.note !== undefined || v.freq !== undefined) return null;
  const s = String(v.s ?? '');
  if (!s) return null;
  const split = splitBankSound(s);
  const name = split ? split.key : s;
  const short = drumKey(name);
  if (!short) return null;
  const pad = NAME_TO_PAD[short] || (short === 'perc' ? 'conga' : null);
  if (!pad) return null;
  return { pad, short, machine: split?.machine || (v.bank ? canonicalBank(v.bank) || String(v.bank) : '') };
}

function hapPitch(v) {
  if (isNum(v.note)) return v.note;
  if (typeof v.note === 'string') { const m = noteToMidi(v.note); if (m !== null) return m; }
  if (isNum(v.freq) && v.freq > 0) return 69 + 12 * Math.log2(v.freq / 440);
  return 36; // superdough: a sound without note/freq plays at note 36 (synths: C2, samples: unshifted)
}

// amplitude controls (-> velocity / volume), consumed controls (handled elsewhere), patch controls (instrument)
const AMP_KEYS = ['gain', 'velocity', 'postgain'];
const PATCH_KEYS = new Set(['attack', 'decay', 'sustain', 'release', 'lpenv', 'lpattack', 'lpdecay', 'lpsustain', 'lprelease',
  'fmi', 'fmh', 'fmattack', 'fmdecay', 'fmsustain', 'fmrelease', 'fmenv', 'unison', 'detune', 'spread', 'vowel', 'vib', 'vibmod',
  'penv', 'pattack', 'pdecay', 'prelease', 'pcurve', 'panchor', 'noise', 'speed', 'begin', 'end', 'loop', 'loopBegin', 'loopEnd',
  'cut', 'hpenv', 'hpattack', 'hpdecay', 'hpsustain', 'hprelease', 'bpenv', 'bpattack', 'bpdecay', 'bpsustain', 'bprelease',
  'ftype', 'fanchor', 'drive', 'dry', 'roomlp', 'roomdim', 'roomfade', 'unit', 'accelerate', 'partials', 'phases', 'pw', 'pwrate', 'pwsweep']);
const CONSUMED = new Set(['s', 'n', 'note', 'freq', 'bank', 'gain', 'velocity', 'postgain', 'cutoff', 'resonance', 'hcutoff', 'hresonance',
  'bandf', 'bandq', 'room', 'roomsize', 'size', 'delay', 'delaytime', 'delayfeedback', 'delaysync', 'shape', 'shapevol', 'distort', 'distortvol',
  'crush', 'coarse', 'pan', 'orbit', 'duckorbit', 'duckdepth', 'duckattack', 'duckonset', 'compressor', 'compressorRatio', 'compressorKnee',
  'compressorAttack', 'compressorRelease', 'phaserrate', 'phaserdepth', 'phasercenter', 'phasersweep', 'tremolo', 'tremolodepth',
  'tremolosync', 'tremoloskew', 'tremolophase', 'tremoloshape', 'clip', 'legato', 'duration', 'cps', 'cycle', 'channels', 'analyze', 'fft',
  'color', 'markcss', 'x', 'y', 'id', 'label']);
const STRUDEL_PARAM_RENAME = { fmi: 'fm' };

// ------------------------------------------------------------------------------------------- analysis

/**
 * Evaluates `code` with the real Strudel engine and groups its haps into instrument tracks.
 * opts: { beatsPerCycle = 4, maxCycles = 512 }
 * -> { error?, bpm, cps, beatsPerCycle, cycles, sections, arranged, tracks: [TrackInfo], warnings }
 */
export function analyzeStrudel(code, opts = {}) {
  const bpc = opts.beatsPerCycle || 4;
  if (codeEngine() !== 'strudel') return { error: 'The Strudel engine is not loaded' };
  const res = evaluate(code);
  if (res.error) return { error: res.error };
  const cps = res.cps > 0 ? res.cps : 0.5;
  const bpm = Math.round(cps * 60 * bpc * 100) / 100;
  const { defs, ast } = sourceMap(code);
  const resolve = makeResolver(code, defs);
  const arr = arrangeSections(code, ast);
  const warnings = [...(res.warnings || [])];

  let cycles, sections, arranged = false;
  if (arr && arr.total > 0) {
    cycles = Math.min(arr.total, opts.maxCycles || MAX_CYCLES);
    sections = arr.sections.filter((s) => s.start < cycles).map((s) => ({ ...s, cycles: Math.min(s.cycles, cycles - s.start) }));
    arranged = true;
    if (arr.total > cycles) warnings.push(`Only the first ${cycles} of ${arr.total} bars were imported`);
  } else {
    cycles = detectLoop(res);
    sections = [{ name: 'Loop', start: 0, cycles }];
  }

  // query in chunks (keeps memory small for long songs)
  const events = [];
  for (let c = 0; c < cycles; c += 16) events.push(...queryEvents(res, c, Math.min(cycles, c + 16)));
  if (res.queryError) return { error: res.queryError };

  // group haps into tracks
  const groups = new Map();
  for (const e of events) {
    const v = e.value || {};
    if (v.s === undefined && v.note === undefined && v.freq === undefined && v.n === undefined) continue;
    const drum = drumInfo(v);
    const src = resolve(e.locations, v) || (e.name && !/^\$\d+$|^main$/.test(e.name) ? e.name : null);
    const sound = drum ? (drum.machine || '') : String(v.s ?? 'triangle');
    // unnamed code: drums of different `$:` blocks stay apart (a lone kick block is the sidechain key, has its own fx)
    const anon = src ? '' : drum ? `#${e.block ?? e.pattern ?? 0}` : '';
    const key = `${src || anon}|${drum ? 'd' : 'm'}|${sound}`;
    let g = groups.get(key);
    if (!g) { g = { key, src, kind: drum ? 'drums' : 'melodic', sound, machine: drum ? drum.machine : null, haps: [], pos: Infinity }; groups.set(key, g); }
    const at = defs.find((d) => d.name === src)?.start ?? e.locations?.[0]?.start;
    if (isNum(at) && at < g.pos) g.pos = at;
    const amp = (isNum(v.gain) ? v.gain : 0.8) * (isNum(v.velocity) ? v.velocity : 1) * (isNum(v.postgain) ? v.postgain : 1);
    const durCycles = isNum(e.duration) && e.duration > 0 ? e.duration : e.end - e.begin;
    g.haps.push({ beat: e.begin * bpc, dur: Math.max(0.02, durCycles * bpc), pitch: drum ? padPitch(drum.pad) : hapPitch(v), pad: drum?.pad, short: drum?.short, amp, v });
  }
  const tracks = [...groups.values()].filter((g) => g.haps.length).sort((x, y) => x.pos - y.pos); // code order
  nameTracks(tracks);
  return { bpm, cps, beatsPerCycle: bpc, cycles, sections, arranged, tracks, warnings, code };
}

const PAD_PITCH = Object.fromEntries(DRUM_PADS.map((p) => [p.key, p.pitch]));
const padPitch = (pad) => PAD_PITCH[pad] ?? 63;

function prettySound(s) {
  const x = String(s || '').replace(/^gm_/, '').replace(/[_-]+/g, ' ').trim();
  return x ? x[0].toUpperCase() + x.slice(1) : 'Synth';
}
function nameTracks(tracks) {
  const bySrc = new Map();
  for (const t of tracks) { const k = t.src || ''; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(t); }
  for (const [src, list] of bySrc) {
    for (const t of list) {
      const machine = t.machine ? (DRUM_MACHINES[t.machine]?.name || t.machine) : '';
      const sound = t.kind === 'drums' ? (machine || 'Drums') : prettySound(t.sound);
      if (!src) t.name = t.kind === 'drums' ? drumsName(t) : `${sound} ${roleWord(t)}`;
      else if (list.length === 1) t.name = src;
      else if (t.kind === 'drums' && list.filter((x) => x.kind === 'drums').length === 1) t.name = src;
      else t.name = `${src} ${t.kind === 'drums' ? sound : sound.toLowerCase()}`;
      t.name = t.name.replace(/_+$/, '').replace(/_/g, ' ');
    }
  }
  const used = new Map();
  for (const t of tracks) {
    const n = used.get(t.name) || 0;
    used.set(t.name, n + 1);
    if (n) t.name = `${t.name} ${n + 1}`;
  }
}

const PAD_NAMES = { kick: 'Kick', snare: 'Snare', clap: 'Clap', hihat: 'Hats', openhat: 'Hats', shaker: 'Shaker', rim: 'Rim', crash: 'Cymbals', ride: 'Cymbals' };
function drumsName(t) {
  const names = new Set(t.haps.map((h) => PAD_NAMES[h.pad] || 'Percussion'));
  return names.size === 1 ? [...names][0] : 'Drums';
}
function roleWord(t) {
  const med = median(t.haps.map((h) => h.pitch));
  const at = new Map();
  for (const h of t.haps) at.set(r3(h.beat), (at.get(r3(h.beat)) || 0) + 1);
  const poly = [...at.values()].filter((n) => n > 1).length > at.size * 0.3;
  return med < 48 ? 'bass' : poly ? 'chords' : 'lead';
}

/** Loop length (cycles) of code without arrange(): the smallest period the haps (and slow sweeps) repeat with. */
function detectLoop(res) {
  let evs;
  try { evs = queryEvents(res, 0, LOOP_PROBE); } catch { return 4; }
  if (!evs.length) return 4;
  const sig = Array.from({ length: LOOP_PROBE }, () => new Map());
  const q = (x, step) => (isNum(x) ? Math.round(x / step) : '');
  const qf = (x) => (isNum(x) && x > 0 ? Math.round(Math.log2(x) * 4) : '');
  for (const e of evs) {
    const c = Math.floor(e.begin + EPS);
    if (c < 0 || c >= LOOP_PROBE) continue;
    const v = e.value || {};
    const k = [e.pattern, v.s, v.note ?? v.n ?? v.freq, r3(e.begin - c), qf(v.cutoff), qf(v.hcutoff), q(v.room, 0.1), q(v.delay, 0.1), q(v.pan, 0.1)].join('|');
    sig[c].set(k, (sig[c].get(k) || 0) + 1);
  }
  const sim = (a, b) => {
    let inter = 0, total = 0;
    for (const [k, n] of a) { inter += Math.min(n, b.get(k) || 0); total += n; }
    for (const [, n] of b) total += n;
    return total ? (2 * inter) / total : 1;
  };
  for (const P of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    let sum = 0, n = 0, worst = 1;
    for (let c = P; c < LOOP_PROBE; c++) { const s = sim(sig[c], sig[c - P]); sum += s; n++; worst = Math.min(worst, s); }
    if (n && sum / n >= 0.85 && worst >= 0.5) return P < 4 ? P * Math.ceil(4 / P) : P;
  }
  return LOOP_PROBE;
}

// ------------------------------------------------------------------------------------------- instruments

/** Closest curated sd-* patch for a sound + register (its built-in fallback preset plays if superdough can't). */
function closestPatch(sound, medPitch, poly) {
  const role = medPitch < 48 ? 'bass' : poly ? 'chords' : 'lead';
  const same = STRUDEL_PATCHES.filter((p) => p.patch.s === sound);
  const pool = same.length ? same : STRUDEL_PATCHES;
  return pool.find((p) => p.roles.includes(role)) || pool.find((p) => role === 'chords' && p.roles.includes('pad')) || pool[0];
}

/** The constant value of control k over haps (mode), and whether it varies / is missing on some haps. */
function stat(haps, k) {
  const vals = [];
  let missing = 0;
  for (const h of haps) { const x = h.v[k]; if (x === undefined || x === null) missing++; else vals.push(x); }
  if (!vals.length) return null;
  const m = mode(vals);
  const varies = vals.some((x) => JSON.stringify(x) !== JSON.stringify(m)) || (missing > 0);
  return { value: m, varies, missing, count: vals.length, numeric: vals.every(isNum) };
}

function melodicInstrument(t, report) {
  const haps = t.haps;
  const sound = t.sound;
  const pitches = haps.map((h) => h.pitch);
  const med = median(pitches);
  const onsets = new Map();
  for (const h of haps) onsets.set(r3(h.beat), (onsets.get(r3(h.beat)) || 0) + 1);
  const poly = [...onsets.values()].filter((n) => n > 1).length > onsets.size * 0.3;
  const params = {};
  let def;
  if (isPresetName(sound)) {
    // a daW³ preset name (daW³'s own live-coder sketches write .s("pluck-bass")): its Strudel patch, else the preset itself
    const p = PRESETS[sound];
    if (p.instrument.type === 'strudel') def = { type: 'strudel', preset: sound, params, fallbackPreset: p.fallbackPreset };
    else if (PRESET_STRUDEL[sound]) def = { type: 'strudel', preset: PRESET_STRUDEL[sound], params, fallbackPreset: sound };
    else def = { type: p.instrument.type, preset: sound, params: {} };
    t.silentInStrudel = true; // superdough doesn't know daW³ preset names
    report.notes.push(`${t.name}: .s("${sound}") is a daW³ preset (Strudel itself has no such sound) — played with ${def.preset}`);
  } else {
    const cp = closestPatch(sound, med, poly);
    params.s = sound;
    def = { type: 'strudel', preset: null, params, fallbackPreset: cp.fallbackPreset };
    t.closestPatch = cp.id;
  }
  if (def.type === 'strudel') {
    const n = stat(haps, 'n');
    if (n && isNum(n.value) && !isSynth(sound) && !(haps.some((h) => h.v.note !== undefined || h.v.freq !== undefined))) params.n = n.value;
    if (t.bankPrefix) params.bank = t.bankPrefix;
    const bank = stat(haps, 'bank');
    if (bank && !bank.varies) params.bank = bank.value;
    for (const k of PATCH_KEYS) {
      const st = stat(haps, k);
      if (!st) continue;
      if (st.varies && st.missing < st.count) report.varying.add(`${t.name}: ${k}`);
      if (st.missing > st.count) continue;
      params[STRUDEL_PARAM_RENAME[k] || k] = isNum(st.value) ? Number(st.value.toPrecision(4)) : st.value;
    }
    // filter envelope: the cutoff belongs to the synth voice (not an insert)
    if (params.lpenv !== undefined || params.lpattack !== undefined || params.lpdecay !== undefined) {
      t.lpInPatch = true;
      const c = stat(haps, 'cutoff');
      if (c && isNum(c.value)) params.lpf = Number(c.value.toPrecision(4));
      const q = stat(haps, 'resonance');
      if (q) params.resonance = q.value;
    }
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  }
  // pass-through: other superdough controls go into the patch untouched (strudelValue sends unknown keys as they are)
  const seen = new Set(haps.flatMap((h) => Object.keys(h.v)));
  for (const k of seen) {
    if (CONSUMED.has(k) || PATCH_KEYS.has(k) || k in params || STRUDEL_PARAM_RENAME[k]) continue;
    const st = stat(haps, k);
    if (def.type === 'strudel' && st && !st.varies) { params[k] = st.value; report.passed.add(k); } else report.unmapped.add(k);
  }
  return def;
}

/** Pad variant index of a sampled machine that plays Strudel's `<machine>_<short>:<n>` file (null: default / unknown). */
function strudelVariant(machine, pad, short, n) {
  const plan = resolvePadSamples(machine)?.[pad];
  const files = MACHINE_FILES[machine]?.[short];
  if (!plan || !files?.length || plan.machine !== machine || plan.key !== short) return null;
  const want = String(files[((Math.round(n) % files.length) + files.length) % files.length]).split('/').pop().replace(/\.wav$/i, '');
  const i = plan.variants.findIndex((v) => { try { return decodeURIComponent(v.label) === want || v.label === want; } catch { return v.label === want; } });
  return i > 0 ? i : null;
}

function drumInstrument(t, report) {
  let machine = t.machine ? canonicalBank(t.machine) || t.machine : '';
  if (machine && !DRUM_MACHINES[machine]) { report.notes.push(`${t.name}: bank "${t.machine}" isn't an embedded machine — synthesized kit`); machine = ''; }
  if (!t.machine) machine = 'RolandTR909'; // no .bank(): Strudel's default (Dirt-Samples) bd/sd/hh are 909-ish
  const kit = machine ? (DRUM_MACHINES[machine]?.kit || '909') : (/808/.test(t.machine) ? '808' : '909');
  const pads = {};
  const byPad = new Map();
  for (const h of t.haps) { if (!byPad.has(h.pad)) byPad.set(h.pad, []); byPad.get(h.pad).push(h); }
  for (const [pad, haps] of byPad) {
    const pp = {};
    // a sound the bank doesn't have plays nothing in Strudel (e.g. sh / tb / perc on the TR-909); daW³ fills the pad
    // from a companion machine or its synthesized kit — reported, so the user knows the split adds it
    const short = haps[0].short;
    if (t.machine && MACHINE_FILES[machine] && !MACHINE_FILES[machine][short]) (t.silentInStrudel ||= []).push(pad);
    // the machine sample Strudel plays (file n of the bank's list) -> the pad variant playing that file
    const n = stat(haps, 'n');
    const vi = machine ? strudelVariant(machine, pad, haps[0].short, n && isNum(n.value) ? n.value : 0) : null;
    if (vi) pp.variant = vi;
    const pan = stat(haps, 'pan');
    if (pan && isNum(pan.value) && !pan.varies && Math.abs(pan.value - 0.5) > 0.01) pp.pan = r3((pan.value - 0.5) * 2);
    if (Object.keys(pp).length) pads[pad] = pp;
  }
  for (const k of new Set(t.haps.flatMap((h) => Object.keys(h.v)))) {
    if (CONSUMED.has(k)) continue;
    report.unmapped.add(k);
  }
  return { type: 'drums', preset: kit, params: { kit, machine, humanize: 0, pads } };
}

// ------------------------------------------------------------------------------------------- effect lanes

/** Ramer–Douglas–Peucker on [{beat, y}] (y normalised 0..1). */
function thin(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a], pb = points[b];
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const t = pb.beat > pa.beat ? (p.beat - pa.beat) / (pb.beat - pa.beat) : 0;
      const d = Math.abs(p.y - (pa.y + (pb.y - pa.y) * t));
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Per-hap control series -> automation points [{beat, value}] (thinned), or a static value.
 * getter(h) -> number | undefined; neutral: value when the control is absent; log: frequency scale.
 */
function controlLane(haps, getter, { neutral, log = false, lo = 0, hi = 1 }) {
  const byBeat = new Map();
  let present = 0;
  for (const h of haps) {
    let x = getter(h);
    if (isNum(x)) present++;
    else x = neutral;
    if (!isNum(x)) continue;
    const b = r3(h.beat);
    if (!byBeat.has(b)) byBeat.set(b, []);
    byBeat.get(b).push(x);
  }
  if (!present) return null;
  const series = [...byBeat.entries()].sort((a, b) => a[0] - b[0]).map(([beat, xs]) => ({ beat, value: clamp(median(xs), lo, hi) }));
  const vals = series.map((p) => p.value);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const norm = (v) => (log ? Math.log2(Math.max(v, 1e-3) / Math.max(lo, 1e-3)) / Math.log2(Math.max(hi, 1e-3) / Math.max(lo, 1e-3)) : (v - lo) / (hi - lo || 1));
  if (Math.abs(norm(mx) - norm(mn)) < 0.01) return { static: series[0].value, present, total: haps.length };
  // step holds: a jump after a gap keeps the old value until just before the next hap
  const pts = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (i > 0) {
      const prev = series[i - 1];
      if (p.beat - prev.beat > 0.3 && Math.abs(norm(p.value) - norm(prev.value)) > 0.02) pts.push({ beat: r3(p.beat - 0.02), value: prev.value });
    }
    pts.push(p);
  }
  const thinned = thin(pts.map((p) => ({ ...p, y: norm(p.value) })), 0.012).map(({ beat, value }) => ({ beat, value: Number(value.toPrecision(4)) }));
  return { points: thinned, present, total: haps.length, min: mn, max: mx };
}

/** Does a control differ between drum sounds hit at the same time (e.g. only the hats have .room())? Then it isn't a kit-wide effect. */
function conflictsAcrossPads(haps, k) {
  const at = new Map();
  for (const h of haps) {
    const b = r3(h.beat);
    if (!at.has(b)) at.set(b, new Map());
    const x = h.v[k];
    at.get(b).set(h.pad, isNum(x) ? x : x === undefined ? null : String(x));
  }
  let shared = 0, conflicts = 0;
  for (const m of at.values()) {
    if (m.size < 2) continue;
    shared++;
    const vals = [...m.values()];
    const same = vals.every((x) => (isNum(x) && isNum(vals[0]) ? Math.abs(x - vals[0]) <= Math.abs(vals[0]) * 0.1 + 1e-6 : x === vals[0]));
    if (!same) conflicts++;
  }
  return shared > 0 && conflicts > shared * 0.2;
}

function nearestDivision(beats) {
  let best = null, err = Infinity;
  for (const [d, b] of Object.entries(DIVISIONS)) { const e = Math.abs(Math.log(beats / b)); if (e < err) { err = e; best = d; } }
  return err < Math.log(1.03) ? best : null;
}

// ------------------------------------------------------------------------------------------- project build

const ROLE_COLORS = { drums: '#ff5f6d', bass: '#4dabf7', chords: '#ffd43b', pad: '#9775fa', lead: '#38d9a9', arp: '#ffa94d', fx: '#3bc9db' };
function guessRole(t) {
  const n = String(t.name).toLowerCase();
  if (t.kind === 'drums') return 'drums';
  for (const r of ['bass', 'pad', 'lead', 'arp', 'fx']) if (n.includes(r)) return r;
  if (/stab|chord|keys|piano|organ/.test(n)) return 'chords';
  if (/sub/.test(n)) return 'bass';
  const med = median(t.haps.map((h) => h.pitch));
  return med < 48 ? 'bass' : null;
}

/**
 * Builds the split tracks into `project` (mutated). code: Strudel source or an analyzeStrudel() result.
 * opts: { replace = true (drop existing tracks/clips/patterns/markers), keepCode = true (muted original code track),
 *         selectFirst } -> summary { tracks, effects, lanes, sends, unmapped, notes, bpm, bars, sections, error? }
 */
export function splitStrudelToProject(project, code, opts = {}) {
  const a = typeof code === 'string' ? analyzeStrudel(code, { beatsPerCycle: 4, ...opts }) : code;
  if (a.error) return { error: a.error };
  if (!a.tracks.length) return { error: 'The code plays no notes' };
  const replace = opts.replace !== false;
  const hadTracks = !replace && (project.tracks || []).length > 0; // adding to a project keeps its tempo and key
  const bpc = a.beatsPerCycle;
  const report = { unmapped: new Set(), passed: new Set(), varying: new Set(), notes: [...a.warnings] };
  const summary = { tracks: [], effects: 0, lanes: 0, sends: 0, bpm: a.bpm, bars: a.cycles, sections: a.sections.length };

  if (replace) {
    const fresh = createProject();
    const keep = { buses: project.buses?.length ? project.buses : fresh.buses, master: project.master || fresh.master, samples: project.samples || {} };
    for (const k of Object.keys(project)) if (!['id', 'name', 'buses', 'master', 'samples'].includes(k)) delete project[k];
    Object.assign(project, fresh, keep, { id: project.id ?? fresh.id, name: project.name && project.name !== 'Untitled Project' ? project.name : 'Strudel song' });
    project.tracks = []; project.patterns = {}; project.clips = []; project.markers = [];
    for (const s of project.scenes || []) s.slots = {};
  }
  if (!hadTracks) project.bpm = a.bpm;
  project.timeSig = [4, 4];
  project.mode = 'song';
  const total = a.cycles * bpc;
  project.loop = { enabled: !a.arranged, start: 0, end: total };
  project.importedCode = a.code;

  // ---- buses (room -> Reverb, delay -> Delay): one per distinct setting; a replaced project reuses its own buses first
  project.buses ||= [];
  const busCache = new Map();
  const taken = new Set();
  const count = { reverb: 0, delay: 0 };
  const busFor = (type, params) => {
    const key = type + JSON.stringify(params);
    if (busCache.has(key)) return busCache.get(key);
    const n = ++count[type];
    let bus = replace ? project.buses.find((b) => !taken.has(b.id) && b.fx?.some((f) => f.type === type)) : null;
    if (!bus) {
      const label = type === 'reverb' ? 'Reverb' : 'Delay';
      bus = createBus(replace ? (n > 1 ? `${label} ${n}` : label) : `${label} (Strudel)${n > 1 ? ` ${n}` : ''}`, [createEffect(type, {})]);
      project.buses.push(bus);
    }
    taken.add(bus.id);
    Object.assign(bus.fx.find((f) => f.type === type).params, params, { mix: 1 });
    busCache.set(key, bus);
    return bus;
  };
  // (sizes in three buckets — small room / medium / large hall — so a song doesn't grow a bus per part)
  const reverbBus = (size) => {
    const s = size < 2.5 ? 2 : size <= 5 ? 4 : 8;
    return busFor('reverb', { decay: s, size: r3(clamp(s / 10, 0.2, 1)) });
  };
  const delayBus = (beats, seconds, feedback) => {
    const div = nearestDivision(beats);
    const fb = r3(clamp(Math.round(feedback / 0.15) * 0.15, 0, 0.9));
    return busFor('delay', div ? { sync: true, division: div, feedback: fb } : { sync: false, time: r3(clamp(seconds, 0.01, 2)), feedback: fb });
  };

  const built = [];
  const colorIdx = { i: (project.tracks || []).length };
  for (const t of a.tracks) {
    const role = guessRole(t);
    const inst = t.kind === 'drums' ? drumInstrument(t, report) : melodicInstrument(t, report);
    const track = createTrack({ name: t.name, role, color: ROLE_COLORS[role] || TRACK_COLORS[colorIdx.i++ % TRACK_COLORS.length], instrument: inst });
    const info = { name: t.name, kind: t.kind, instrument: describeInstrument(inst, t), effects: [], automation: [], sends: [] };
    const haps = t.haps;

    // ---- amplitude: reference level -> track volume (+ patch gain), per-note velocity (or a volume lane when smooth)
    const isDrums = t.kind === 'drums';
    const amps = haps.map((h) => h.amp);
    const ref = Math.max(...amps, 1e-4);
    let vol = ref; // the code track plays superdough at track volume 0.8 with gain 0.8 by default -> same level
    let extra = 1;
    if (vol > 1.5) { extra = vol / 1.5; vol = 1.5; }
    track.volume = r3(vol);
    if (inst.type === 'strudel') {
      const base = inst.preset ? (PRESETS[inst.preset]?.instrument?.params?.gain ?? 0.8) : 0.8;
      inst.params.gain = r3(base * extra);
    } else if (isDrums) inst.params.gain = r3(0.8 * extra);
    let padRef = null;
    if (isDrums) {
      // per-pad level (pad gain) so velocities stay near 1 (sampled machines shape velocity non-linearly)
      padRef = new Map();
      for (const h of haps) padRef.set(h.pad, Math.max(padRef.get(h.pad) || 0, h.amp));
      for (const [pad, r] of padRef) {
        const g = r3(clamp(r / ref, 0, 2));
        if (Math.abs(g - 1) > 0.01) (inst.params.pads[pad] ||= {}).gain = g;
      }
    }
    let volLane = null;
    if (!isDrums) {
      const lane = controlLane(haps, (h) => h.amp, { lo: 0, hi: ref, neutral: undefined });
      if (lane?.points && smoothSeries(haps)) {
        volLane = lane.points.map((p) => ({ beat: p.beat, value: r3(clamp((p.value / ref) * vol, 0, 1.5)) }));
        track.automation.push(createAutomationLane('volume', volLane));
        info.automation.push('volume');
      }
    }
    const velOf = (h) => {
      if (isDrums) return clamp(h.amp / (padRef.get(h.pad) || ref), 0.05, 1);
      if (volLane) return 1;
      return clamp(h.amp / ref, 0.02, 1);
    };

    // ---- effects
    const fx = [];
    const addFx = (type, params, label) => { const e = createEffect(type, params); fx.push(e); info.effects.push(label || type); return e; };
    const lane = (target, points, label) => { track.automation.push(createAutomationLane(target, points)); info.automation.push(label); };
    const conflict = (k) => isDrums && conflictsAcrossPads(haps, k);

    // filters: low-pass / high-pass / band-pass inserts (a filter envelope keeps the low-pass in the synth patch)
    const filt = (key, qKey, type, neutral, label) => {
      if (!haps.some((h) => h.v[key] !== undefined)) return;
      if (conflict(key)) { report.notes.push(`${t.name}: ${label} only on some drum sounds — not mapped`); return; }
      const L = controlLane(haps, (h) => h.v[key], { neutral, log: true, lo: 20, hi: 20000 });
      if (!L) return;
      const q = stat(haps, qKey);
      const res = q && isNum(q.value) ? clamp(q.value, 0.1, 24) : (type === 'bandpass' ? 1 : 0.707);
      if (L.static !== undefined && neutral !== undefined && Math.abs(Math.log2(L.static / neutral)) < 0.01) return;
      const e = addFx('filter', { type, cutoff: r3(L.static ?? L.points[0].value), resonance: r3(res), depth: 0, mix: 1 }, `${label} ${fmtHz(L.static ?? L.min)}${L.points ? `–${fmtHz(L.max)}` : ''}`);
      if (L.points) lane(`fx:${e.id}:cutoff`, L.points, `${label} cutoff`);
      if (neutral === undefined && L.present < L.total) lane(`fxen:${e.id}`, presenceLane(haps, (h) => h.v[key] !== undefined), `${label} on/off`);
    };
    if (t.lpInPatch && inst.type === 'strudel') {
      const L = controlLane(haps, (h) => h.v.cutoff, { neutral: 20000, log: true, lo: 20, hi: 20000 });
      if (L?.points) { lane('inst:lpf', L.points, 'synth low-pass'); info.effects.push(`synth low-pass ${fmtHz(L.min)}–${fmtHz(L.max)} (filter env)`); }
    } else filt('cutoff', 'resonance', 'lowpass', 20000, 'low-pass');
    filt('hcutoff', 'hresonance', 'highpass', 20, 'high-pass');
    filt('bandf', 'bandq', 'bandpass', undefined, 'band-pass');

    // drive / lo-fi
    const amountFx = (key, type, toParams, label, neutralParams) => {
      if (!haps.some((h) => h.v[key] !== undefined)) return;
      if (conflict(key)) { report.notes.push(`${t.name}: .${key}() only on some drum sounds — not mapped`); return; }
      const st = stat(haps, key);
      if (!st || !st.numeric) { report.unmapped.add(key); return; }
      const e = addFx(type, toParams(st.value), `${label} ${r3(st.value)}`);
      if (st.varies) {
        const vals = haps.map((h) => h.v[key]).filter(isNum);
        const L = controlLane(haps, (h) => h.v[key], { neutral: neutralParams?.value, lo: Math.min(...vals, neutralParams?.value ?? Infinity), hi: Math.max(...vals) });
        const pkey = Object.keys(toParams(st.value)).find((k) => k !== 'type' && k !== 'mix');
        if (L?.points && neutralParams) lane(`fx:${e.id}:${pkey}`, L.points.map((p) => ({ beat: p.beat, value: toParams(p.value)[pkey] })), `${label} amount`);
        else if (st.missing) lane(`fxen:${e.id}`, presenceLane(haps, (h) => h.v[key] !== undefined), `${label} on/off`);
      }
    };
    amountFx('shape', 'saturator', (v) => ({ type: 'soft', drive: r3(clamp(v, 0, 1) * 24), mix: 1 }), 'saturator');
    amountFx('distort', 'distortion', (v) => ({ type: 'soft', drive: r3(clamp(v * 12, 0, 48)), mix: 1 }), 'distortion');
    amountFx('crush', 'bitcrusher', (v) => ({ bits: Math.round(clamp(v, 1, 16)), downsample: 1, mix: 1 }), 'bitcrusher (bits)', { value: 16 });
    if (haps.some((h) => h.v.coarse !== undefined)) {
      const st = stat(haps, 'coarse');
      const cr = fx.find((f) => f.type === 'bitcrusher');
      if (cr) cr.params.downsample = Math.round(clamp(st.value, 1, 32));
      else amountFx('coarse', 'bitcrusher', (v) => ({ bits: 16, downsample: Math.round(clamp(v, 1, 32)), mix: 1 }), 'bitcrusher (coarse)', { value: 1 });
    }
    // compressor
    if (haps.some((h) => h.v.compressor !== undefined)) {
      const g = (k, d) => { const s = stat(haps, k); return s && isNum(s.value) ? s.value : d; };
      addFx('compressor', { threshold: clamp(g('compressor', -18), -60, 0), ratio: clamp(g('compressorRatio', 4), 1, 20), knee: clamp(g('compressorKnee', 6), 0, 40), attack: clamp(g('compressorAttack', 0.01), 0.0005, 0.5), release: clamp(g('compressorRelease', 0.15), 0.01, 1), mix: 1 }, 'compressor');
    }
    // modulation
    if (haps.some((h) => h.v.phaserrate !== undefined)) {
      const g = (k, d) => { const s = stat(haps, k); return s && isNum(s.value) ? s.value : d; };
      addFx('phaser', { sync: false, rate: r3(clamp(g('phaserrate', 1), 0.01, 10)), depth: r3(clamp(g('phaserdepth', 0.75) * 4, 0, 4)), frequency: clamp(g('phasercenter', 1000), 20, 20000), mix: 0.5 }, 'phaser');
    }
    if (haps.some((h) => h.v.tremolo !== undefined || h.v.tremolosync !== undefined)) {
      const g = (k, d) => { const s = stat(haps, k); return s && isNum(s.value) ? s.value : d; };
      const syncC = g('tremolosync', null);
      const div = syncC ? nearestDivision(bpc / syncC) : null;
      addFx('tremolo', div ? { sync: true, division: div, depth: clamp(g('tremolodepth', 1), 0, 1) } : { sync: false, rate: r3(clamp(g('tremolo', 4), 0.01, 20)), depth: clamp(g('tremolodepth', 1), 0, 1) }, 'tremolo');
    }

    // pan
    if (haps.some((h) => isNum(h.v.pan))) {
      if (isDrums && conflictsAcrossPads(haps, 'pan')) { /* per-pad pans (instrument pads) */ } else {
        const L = controlLane(haps, (h) => h.v.pan, { neutral: 0.5, lo: 0, hi: 1 });
        if (L?.static !== undefined) track.pan = r3((L.static - 0.5) * 2);
        else if (L?.points) { lane('pan', L.points.map((p) => ({ beat: p.beat, value: r3((p.value - 0.5) * 2) })), 'pan'); track.pan = r3((L.points[0].value - 0.5) * 2); }
        if (isDrums) for (const p of Object.values(inst.params.pads)) delete p.pan;
      }
    }

    // sends: room -> reverb bus, delay -> delay bus
    if (haps.some((h) => isNum(h.v.room) && h.v.room > 0)) {
      const mixed = conflict('room');
      if (mixed) report.notes.push(`${t.name}: reverb on some drum sounds only — the whole kit is sent at their level`);
      const size = stat(haps.filter((h) => isNum(h.v.room)), 'roomsize');
      const bus = reverbBus(size && isNum(size.value) ? size.value : 2);
      const L = controlLane(haps, (h) => h.v.room, { neutral: 0, lo: 0, hi: 1 });
      const amt = L.static ?? Math.max(...L.points.map((p) => p.value));
      track.sends[bus.id] = r3(clamp(amt, 0, 1));
      if (L.points && !mixed) lane(`send:${bus.id}`, L.points, 'reverb send');
      info.sends.push(`${bus.name} ${r3(amt)}`);
      summary.sends++;
    }
    if (haps.some((h) => isNum(h.v.delay) && h.v.delay > 0)) {
      const dh = haps.filter((h) => isNum(h.v.delay) && h.v.delay > 0);
      const fb = stat(dh, 'delayfeedback');
      const dt = stat(dh, 'delaytime');
      const ds = stat(dh, 'delaysync');
      const seconds = dt && isNum(dt.value) ? dt.value : ((ds && isNum(ds.value) ? ds.value : 3 / 16) / a.cps);
      const beats = seconds * (a.bpm / 60);
      const bus = delayBus(beats, seconds, fb && isNum(fb.value) ? fb.value : 0.5);
      const L = controlLane(haps, (h) => h.v.delay, { neutral: 0, lo: 0, hi: 1 });
      const amt = L.static ?? Math.max(...L.points.map((p) => p.value));
      track.sends[bus.id] = r3(clamp(amt, 0, 1));
      if (L.points) lane(`send:${bus.id}`, L.points, 'delay send');
      info.sends.push(`${bus.name} ${r3(amt)}`);
      summary.sends++;
    }

    track.fx = fx;
    summary.effects += fx.length;

    // ---- notes -> patterns + clips per section
    buildClips(project, track, t, haps, a, velOf);
    built.push({ track, t, info, orbit: mode(haps.map((h) => (isNum(h.v.orbit) ? h.v.orbit : 1))) });
    summary.tracks.push(info);
  }

  // ---- duck (live-coder style sidechain): the hap's track keys a ducker on every track of the target orbits
  for (const k of built) {
    const dk = k.t.haps.filter((h) => h.v.duckorbit !== undefined);
    if (!dk.length) continue;
    const orbits = new Set(dk.flatMap((h) => (Array.isArray(h.v.duckorbit) ? h.v.duckorbit : [h.v.duckorbit])).map(Number));
    const depth = stat(dk, 'duckdepth');
    const att = stat(dk, 'duckattack');
    for (const o of built) {
      if (o === k || !orbits.has(o.orbit)) continue;
      const e = createEffect('ducker', { sourceTrackId: k.track.id, amount: r3(clamp(depth && isNum(depth.value) ? depth.value : 1, 0, 1)), threshold: -30, attack: 0.005, release: r3(clamp(att && isNum(att.value) ? att.value : 0.1, 0.02, 1.5)) });
      o.track.fx.unshift(e);
      o.info.effects.unshift(`ducker ← ${k.track.name}`);
      summary.effects++;
    }
  }
  for (const { info } of built) summary.lanes += info.automation.length;

  // ---- markers per arrange() section
  if (a.arranged) project.markers = a.sections.map((s) => ({ id: uid('mk'), beat: s.start * bpc, name: s.name }));
  project.tracks.push(...built.map((b) => b.track));
  if (opts.keepCode !== false) {
    const ct = createTrack({ type: 'code', name: 'Strudel (original)', code: a.code, role: 'code', color: '#868e96' });
    ct.mute = true;
    ct.importedOriginal = true;
    project.tracks.push(ct);
    summary.codeTrackId = ct.id;
  }
  summary.unmapped = [...report.unmapped].sort();
  summary.passed = [...report.passed].sort();
  summary.varying = [...report.varying];
  summary.firstTrackId = built[0]?.track.id || null;
  summary.notInStrudel = built.filter((b) => b.t.silentInStrudel).map((b) => ({ trackId: b.track.id, name: b.track.name, pads: Array.isArray(b.t.silentInStrudel) ? b.t.silentInStrudel : null }));
  for (const x of summary.notInStrudel) if (x.pads) report.notes.push(`${x.name}: ${x.pads.join(', ')} — not in the ${built.find((b) => b.track.id === x.trackId).track.instrument.params.machine} bank (silent in Strudel), daW³ plays its own`);
  summary.notes = report.notes;
  const key = detectKey(a.code);
  if (key && !hadTracks) project.key = key;
  return summary;
}

/** Project key from the code's most used .scale("C2:minor") (null when none / unknown). */
function detectKey(code) {
  const counts = new Map();
  for (const m of String(code).matchAll(/scale\(\s*["'`]([A-Ga-g])([#b]?)-?\d*:([a-z][\w-]*)/g)) {
    const k = `${m[1].toUpperCase()}${m[2]}:${m[3]}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!top) return null;
  const [tonic, type] = top.split(':');
  const scale = SCALES[type] ? type : Object.keys(SCALES).find((k) => SCALES[k].aliases?.includes(type));
  const root = noteToMidi(`${tonic}4`);
  return scale && root !== null ? { root: ((root % 12) + 12) % 12, scale } : null;
}

/** Is the amplitude series smooth (a slow ride / section levels) rather than per-hap jitter? */
function smoothSeries(haps) {
  const s = [...haps].sort((a, b) => a.beat - b.beat).map((h) => h.amp);
  if (s.length < 4) return false;
  const mx = Math.max(...s), mn = Math.min(...s);
  if (mx - mn < mx * 0.15) return false;
  const d = [];
  for (let i = 1; i < s.length; i++) d.push(Math.abs(s[i] - s[i - 1]));
  const big = d.filter((x) => x > (mx - mn) * 0.1).length;
  return big <= Math.max(2, d.length * 0.05);
}

function presenceLane(haps, has) {
  const pts = [];
  let prev = null;
  for (const h of [...haps].sort((a, b) => a.beat - b.beat)) {
    const v = has(h) ? 1 : 0;
    if (v !== prev) { pts.push({ beat: r3(h.beat), value: v }); prev = v; }
  }
  return pts;
}

const fmtHz = (x) => (!isNum(x) ? '' : x >= 1000 ? `${r3(x / 1000)} kHz` : `${Math.round(x)} Hz`);

function describeInstrument(inst, t) {
  if (inst.type === 'drums') return `drums · ${inst.params.machine ? DRUM_MACHINES[inst.params.machine]?.name || inst.params.machine : `${inst.preset} kit`} · pads ${[...new Set(t.haps.map((h) => h.pad))].join(', ')}`;
  if (inst.type === 'strudel') return `strudel · ${inst.preset || inst.params.s}${t.closestPatch ? ` (fallback ${t.closestPatch})` : ''}`;
  return `${inst.type} · ${inst.preset}`;
}

/** Notes of one track -> patterns (deduplicated) + one clip per section it plays in. */
function buildClips(project, track, t, haps, a, velOf) {
  const bpc = a.beatsPerCycle;
  const sorted = [...haps].sort((x, y) => x.beat - y.beat || x.pitch - y.pitch);
  const byHash = new Map();
  let first = null;
  for (const s of a.sections) {
    const b0 = s.start * bpc, b1 = (s.start + s.cycles) * bpc;
    const notes = sorted.filter((h) => h.beat >= b0 - EPS && h.beat < b1 - EPS).map((h) => ({
      pitch: clamp(Math.round(h.pitch), 0, 127), start: r3(h.beat - b0), dur: r3(t.kind === 'drums' ? Math.min(h.dur, 1) : h.dur), vel: r3(velOf(h)),
    }));
    if (!notes.length) continue; // silent / masked section: no clip
    const lenBeats = s.cycles * bpc;
    const period = notePeriod(notes, s.cycles, bpc);
    const pl = period * bpc;
    const pnotes = notes.filter((n) => n.start < pl - EPS);
    const hash = `${pl}|${pnotes.map((n) => `${n.pitch}@${n.start}:${n.dur}:${Math.round(n.vel * 50)}`).join(',')}`;
    let pat = byHash.get(hash);
    if (!pat) {
      pat = createPattern(track.id, { name: a.arranged ? `${track.name} · ${s.name}` : track.name, length: pl, notes: pnotes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
      project.patterns[pat.id] = pat;
      byHash.set(hash, pat);
    }
    if (!first) first = pat;
    project.clips.push(createClip(track.id, { patternId: pat.id, start: b0, length: lenBeats, name: a.arranged ? s.name : null }));
  }
  track.activePatternId = first?.id || null;
}

/** Smallest period (whole cycles dividing the section) after which the notes repeat exactly. */
function notePeriod(notes, cycles, bpc) {
  const key = (n, len) => `${n.pitch}@${r3(n.start % len)}:${n.dur}:${Math.round(n.vel * 50)}`;
  for (let p = 1; p < cycles; p++) {
    if (cycles % p) continue;
    const len = p * bpc;
    const first = notes.filter((n) => n.start < len - EPS);
    if (first.length * (cycles / p) !== notes.length) continue;
    const set = new Map();
    for (const n of first) set.set(key(n, len), (set.get(key(n, len)) || 0) + cycles / p);
    let ok = true;
    for (const n of notes) {
      const k = key(n, len);
      const c = set.get(k);
      if (!c) { ok = false; break; }
      set.set(k, c - 1);
    }
    if (ok) return p;
  }
  return cycles;
}

// ------------------------------------------------------------------------------------------- code tracks

/**
 * "Keep as code tracks": every labelled block ($:, name:, _$:) becomes its own code track, with the shared setup
 * (register / setcpm / samples / const …) copied in front so each one runs on its own. -> [{name, code, muted}]
 */
export function splitCodeByLabels(text, splitTopLevel) {
  const DRUMS = /^(bd|sd|hh|oh|cp|rim|lt|mt|ht|cr|rd|cb|sh|perc|tb|cl|tbd|kick|snare|hat|clap|breaks?\d*|.*_(bd|sd|hh|oh|cp))$/i;
  let items = [];
  try { items = splitTopLevel ? splitTopLevel(text) : []; } catch { items = []; }
  const blocks = items.filter((it) => it.kind === 'label');
  if (blocks.length < 2) return [{ name: 'Strudel', code: text, muted: false }];
  const setup = items.filter((it) => it.kind !== 'label').map((it) => text.slice(it.start, it.end)).join('\n');
  const used = new Map();
  return blocks.map((b, i) => {
    const body = text.slice(b.start, b.end);
    let name = b.name && b.name !== '$' ? b.name : '';
    if (!name) {
      const snd = /(?:^|[.\s(])(?:s|sound)\(\s*["'`]\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
      const isNote = /\b(?:note|n)\(/.test(body);
      name = snd ? (DRUMS.test(snd) && !isNote ? 'Drums' : snd[0].toUpperCase() + snd.slice(1)) : `Part ${i + 1}`;
    }
    const k = used.get(name) || 0;
    used.set(name, k + 1);
    if (k) name = `${name} ${k + 1}`;
    // un-mute the label inside its own track; the track's mute button carries the state instead
    const code = (setup ? setup + '\n\n' : '') + body.replace(/^_(\$|[A-Za-z_][\w]*)\s*:/, '$1:');
    return { name, code, muted: !!b.muted };
  });
}

// ------------------------------------------------------------------------------------------- entry points

/**
 * Loads the Strudel engine, then replaces (opts.replace, default) or extends the store's project with the split
 * tracks in ONE undo step. Reusable by every import path (Code tab paste, File ▸ Import Strudel, Pocket's Code page).
 * -> summary ({ error } when the code can't be split; the project is then untouched)
 */
export async function importStrudelSplit(store, code, opts = {}) {
  await loadStrudel();
  const analysis = analyzeStrudel(code, opts);
  if (analysis.error) return { error: analysis.error };
  if (!analysis.tracks.length) return { error: 'The code plays no notes' };
  let summary;
  store.transact(opts.label || 'Import Strudel (split into tracks)', (p) => { summary = splitStrudelToProject(p, analysis, opts); });
  return summary;
}

/** One-paragraph report of a split import. */
export function summaryText(s) {
  if (s.error) return `Could not split the code: ${s.error}`;
  const lines = [`${s.tracks.length} track${s.tracks.length === 1 ? '' : 's'} (${s.tracks.map((t) => t.name).join(', ')}) · ${s.bars} bars at ${s.bpm} BPM`
    + `${s.sections > 1 ? ` · ${s.sections} sections` : ''} · ${s.effects} effect${s.effects === 1 ? '' : 's'}, ${s.sends} send${s.sends === 1 ? '' : 's'}, ${s.lanes} automation lane${s.lanes === 1 ? '' : 's'}.`];
  if (s.unmapped?.length) lines.push(`Not mapped: ${s.unmapped.join(', ')}.`);
  if (s.notes?.length) lines.push(...s.notes.slice(0, 4));
  return lines.join('\n');
}
