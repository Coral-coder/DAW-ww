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
// Anonymous code (no consts / labels) is split by its parts: each `$:` block and each stack(…) member is its own
// track (named by the `// comment` above it), so parts sharing a sound never merge. Controls driven by continuous
// signals (sine / saw / perlin …) are re-sampled over time (probeSignals) — Strudel reads them only at note starts,
// which for long notes can miss the whole sweep. Code Strudel itself plays nothing for (repairCode: `.scramble()`
// without a count; sounds superdough doesn't have) is repaired / substituted and reported; summary.parts lists
// every part found and what became of it (a part with no notes is visible there).
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
import { STRUDEL_PATCHES, STRUDEL_SYNTHS, STRUDEL_SAMPLE_SOUNDS } from '../audio/strudel-patches.js';
import { DIRT_NAMES, VCSL_NAMES } from '../audio/library/strudel-sounds.js';
import { detectKey as detectKeyFromNotes, keyRootName } from '../theory/keys.js';
import { PRESETS } from '../audio/presets.js';
import { PRESET_STRUDEL } from '../gen/strudel-sounds.js';
import { DIVISIONS } from '../audio/effect-defs.js';
import { repairStrudel, diagnose } from './repair.js';

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
    // a string const (`let prog = "<Am7 Dm7>"`) used by anonymous code doesn't name that code's part
    if (list.every((d) => d.prio === 0) && locations.some((l) => !defAt(l.start))) list = [];
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

/** Every AST node (depth-first) with a callback(node, parents). */
function walkAst(root, fn) {
  const parents = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    fn(n, parents);
    parents.push(n);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
    }
    parents.pop();
  };
  visit(root);
}

const parseCode = (code) => {
  try { return strudelModules().acornParse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: false }); } catch { return null; }
};

/**
 * Code Strudel silently plays nothing for, fixed so the split has the part the code means:
 * `.scramble()` / `.shuffle()` without a count (Strudel needs `scramble(n)`; with none the whole part is silent)
 * -> the pattern's own step count. -> { code, notes: [string], fixes: [{start, text}] }
 */
export function repairCode(code) {
  const ast = parseCode(code);
  const out = { code, notes: [], fixes: [] };
  if (!ast) return out;
  const edits = [];
  walkAst(ast, (n) => {
    if (n.type !== 'CallExpression' || n.arguments.length || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
    const m = n.callee.property?.name;
    if (m !== 'scramble' && m !== 'shuffle') return;
    const recv = n.callee.object;
    const steps = stepCount(code.slice(recv.start, recv.end));
    edits.push({ at: n.end - 1, text: String(steps), method: m, start: n.callee.property.start });
  });
  if (!edits.length) return out;
  let s = code;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) s = s.slice(0, e.at) + e.text + s.slice(e.at);
  out.code = s;
  for (const e of edits) {
    out.notes.push(`.${e.method}() has no count — Strudel plays nothing for it; imported as .${e.method}(${e.text}) (one slot per step)`);
    out.fixes.push({ start: e.start, text: `.${e.method}(${e.text})` });
  }
  return out;
}

/** Steps per cycle of a pattern expression (its mini-notation's top level), 4 when unknown. */
function stepCount(expr) {
  try {
    const res = evaluate(expr);
    const pat = res.entries?.[0]?.pattern;
    const st = Number(pat?._steps ?? pat?.tactus);
    if (Number.isFinite(st) && st >= 1 && st <= 64 && Number.isInteger(st)) return st;
    const n = queryEvents(res, 0, 1).length;
    if (n >= 1 && n <= 64) return n;
  } catch { /* not evaluable on its own (uses a const …) */ }
  const mini = /["'`]([^"'`]*)["'`]/.exec(expr)?.[1];
  const n = mini ? mini.replace(/\[[^\]]*\]|<[^>]*>|\{[^}]*\}/g, 'x').trim().split(/\s+/).filter(Boolean).length : 0;
  return n >= 1 ? n : 4;
}

/** The part name a `// comment` right above (or, for one-line parts, after) a code range gives, or ''. */
function commentName(code, start, end) {
  const lineStart = code.lastIndexOf('\n', start - 1) + 1;
  if (code.slice(lineStart, start).trim()) return ''; // code before the part on its line
  const above = [];
  let pos = lineStart - 1;
  while (pos > 0) {
    const ls = code.lastIndexOf('\n', pos - 1) + 1;
    const line = code.slice(ls, pos).trim();
    if (!line.startsWith('//')) break;
    above.unshift(line.replace(/^\/\/+\s*/, ''));
    pos = ls - 1;
  }
  let raw = above.find((x) => x.trim()) || '';
  if (raw && !code.slice(0, pos + 1).trim()) raw = '__header__:' + raw; // the file's opening comment (maybe a title)
  if (!raw) {
    const lineEnd = code.indexOf('\n', start);
    if (lineEnd < 0 || lineEnd >= end - 2) raw = /\/\/\s*(.+)$/.exec(code.slice(start, lineEnd < 0 ? code.length : lineEnd))?.[1] || '';
  }
  return cleanName(raw);
}
function cleanName(raw) {
  let x = String(raw || '').trim();
  const header = x.startsWith('__header__:');
  if (header) return '\u0000' + cleanName(x.slice(11)); // marked: decided by codeUnits
  if (!x || /[.(]\s*["'`]|\w\(.*\)|=>|^\$|^[A-Za-z_]+:\s*\w+\(/.test(x)) return ''; // commented-out code
  x = x.replace(/^(\d+|[a-z])[.)]\s*/i, '').replace(/^[-*#=>~]+\s*/, '');
  // `LAYER 2: Generative Acid Bassline` / `Part 3 - Pads`: the numbering isn't the name
  x = x.replace(/^(layer|part|section|track|voice|step|channel|instrument)\s*#?\d+\s*(?::|\.|-|—|–)\s*(?=\S)/i, '');
  x = x.split(/\s*[:(—–]\s*|\s+-\s+|\.\s+/)[0].replace(/[\s.,;!-]+$/, '').trim();
  // a description (`melody that sometimes jumps an octave`, `hats with random gaps`) -> its subject
  x = x.replace(/^(.+?)\s+(that|which|with|where|who|for)\s.*$/i, '$1');
  if (x.length > 40) x = x.slice(0, 40).replace(/\s+\S*$/, '');
  return x.length >= 2 ? x : '';
}

/**
 * Parts of anonymous code (no `const name =` / `name:`): each `$:` block / top-level expression and each member of a
 * stack(…) call (nested), with its name from the comment above it. -> [{id, start, end, depth, parent, name, index, sound}]
 */
function codeUnits(code, ast, defs) {
  if (!ast) return [];
  const named = (pos) => defs.some((d) => pos >= d.start && pos < d.end);
  const units = [];
  const add = (node, kind, parent, index) => {
    const u = { id: units.length, kind, start: node.start, end: node.end, parent, depth: parent ? parent.depth + 1 : 0, index, name: commentName(code, node.start, node.end), sound: SOUND_CALL.test(code.slice(node.start, node.end)) };
    units.push(u);
    return u;
  };
  const visit = (n, parent) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'stack' && !named(n.start)) {
      visit(n.callee, parent);
      n.arguments.forEach((a, i) => visit(a, add(a, 'member', parent, i)));
      return;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => visit(x, parent));
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, parent);
    }
  };
  for (const node of ast.body) {
    if (named(node.start)) continue;
    if (node.type === 'LabeledStatement') visit(node.body, add(node, 'block', null, null));
    else if (node.type === 'ExpressionStatement') {
      const e = node.expression;
      if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && /^(setcp[ms]|setCps|samples|register|hush|setDefaultVoicings|aliasBank|soundAlias)$/.test(e.callee.name)) continue;
      visit(node, add(node, 'block', null, null));
    }
  }
  // the file's opening comment names its first block only when the other blocks are named by comments too
  // (else it is the sketch's title: `// superimpose / off / jux` above the first of three unnamed `$:` blocks)
  const blocks = units.filter((u) => !u.parent);
  for (const u of units) {
    if (!u.name.startsWith('\u0000')) continue;
    const others = blocks.filter((b) => b !== u);
    u.name = !u.parent && others.length && others.every((b) => b.name && !b.name.startsWith('\u0000')) ? u.name.slice(1) : '';
    if (u.name === '') u.title = true;
  }
  return units;
}

/** Deepest unit holding a hap (by its first source location — the pattern that gave it its structure). */
function makeUnitResolver(units) {
  const cache = new Map();
  return (locations) => {
    if (!locations?.length || !units.length) return null;
    const inside = locations.filter((l) => units.some((u) => l.start >= u.start && l.start < u.end));
    if (!inside.length) return null;
    const pos = Math.min(...inside.map((l) => l.start));
    if (cache.has(pos)) return cache.get(pos);
    let best = null;
    for (const u of units) if (pos >= u.start && pos < u.end && (!best || u.depth > best.depth)) best = u;
    cache.set(pos, best);
    return best;
  };
}

// controls a continuous signal (sine / saw / perlin …) may drive, read continuously (not only at note starts)
const SIGNAL = /(^|[^\w$.])(sine|cosine|saw|isaw|tri|square|perlin|sine2|cosine2|saw2|isaw2|tri2|square2)\b/;
const PROBE_METHODS = new Set(['lpf', 'cutoff', 'ctf', 'lp', 'lpq', 'resonance', 'hpf', 'hcutoff', 'hp', 'hpq', 'hresonance', 'bpf', 'bandf', 'bp',
  'bpq', 'bandq', 'gain', 'velocity', 'postgain', 'pan', 'room', 'size', 'roomsize', 'sz', 'rsize', 'delay', 'delaytime', 'delayt', 'dt',
  'delayfeedback', 'delayfb', 'dfb', 'shape', 'distort', 'crush', 'coarse']);
export const PROBE_STEPS = 16; // samples per cycle
const PROBE_CHUNK = 4; // cycles
const PROBE_KEY = { lpf: 'cutoff', ctf: 'cutoff', lp: 'cutoff', lpq: 'resonance', hpf: 'hcutoff', hp: 'hcutoff', hpq: 'hresonance', bpf: 'bandf', bp: 'bandf',
  bpq: 'bandq', size: 'roomsize', sz: 'roomsize', rsize: 'roomsize', delayt: 'delaytime', dt: 'delaytime', delayfb: 'delayfeedback', dfb: 'delayfeedback' };

/**
 * Controls driven by continuous signals (`.lpf(sine.range(300, 900).slow(8))`): Strudel reads them once per note,
 * so a slow sweep over long notes would come out as a few (often identical) values. Each such call is re-evaluated
 * with a probe pattern in place of its receiver (`pure({__probe}).segment(16).lpf(…)` + the rest of the chain, so
 * later .fast() / .slow() / arrange() still apply) -> [{start, end, cover: [[s, e]], samples: [{cycle, value}]}]
 */
function probeSignals(code, ast, defs, cycles, needed = () => true, chunksOf = null) {
  if (!ast) return [];
  const calls = [];
  walkAst(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed || !n.arguments.length) return;
    if (!PROBE_METHODS.has(n.callee.property?.name)) return;
    const args = code.slice(n.arguments[0].start, n.arguments[n.arguments.length - 1].end);
    if (!SIGNAL.test(args)) return;
    const recv = n.callee.object;
    // the parts the call applies to: its receiver + the consts the receiver uses
    const cover = [[recv.start, recv.end]];
    const ids = new Set();
    walkAst(recv, (x) => { if (x.type === 'Identifier') ids.add(x.name); });
    for (const d of defs) if (ids.has(d.name)) { cover.push([d.start, d.end]); for (const dep of d.deps) { const dd = defs.find((y) => y.name === dep); if (dd) cover.push([dd.start, dd.end]); } }
    const m = n.callee.property.name;
    const c = { start: recv.start, end: recv.end, call: n, cover, samples: [], key: PROBE_KEY[m] || m };
    if (needed(c)) calls.push(c);
  });
  if (!calls.length) return [];
  // passes of non-overlapping receivers (a nested call needs its own evaluation)
  const passes = [];
  for (const c of [...calls].sort((a, b) => a.start - b.start)) {
    const pass = passes.find((p) => p.every((o) => c.end <= o.start || c.start >= o.end));
    if (pass) pass.push(c); else passes.push([c]);
  }
  for (const pass of passes) {
    let s = code;
    const ordered = [...pass].sort((a, b) => b.start - a.start);
    for (const c of ordered) s = `${s.slice(0, c.start)}pure({__probe: ${calls.indexOf(c)}}).segment(${PROBE_STEPS})${s.slice(c.end)}`;
    let res;
    try { res = evaluate(s); } catch { continue; }
    if (res.error) continue;
    // (only the cycles where the parts it applies to play)
    const chunks = chunksOf ? [...new Set(pass.flatMap((c) => [...chunksOf(c)]))].sort((x, y) => x - y) : null;
    const spans = chunks ? chunks.map((c0) => [c0, Math.min(cycles, c0 + PROBE_CHUNK)]) : Array.from({ length: Math.ceil(cycles / 16) }, (_, i) => [i * 16, Math.min(cycles, i * 16 + 16)]);
    for (const [c0, c1] of spans) {
      let evs;
      try { evs = queryEvents(res, c0, c1); } catch { break; }
      for (const e of evs) {
        const id = e.value?.__probe;
        if (id === undefined) continue;
        calls[id]?.samples.push({ cycle: e.begin, value: e.value });
      }
    }
  }
  return calls.filter((c) => c.samples.length);
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
  // TidalCycles-isms (C'min7, |+, .arp("pinkyup") …) -> valid Strudel; the repaired code is what gets stored
  const original = opts.original ?? code;
  const tidal = opts.skipRepair ? { code, repairs: opts.repairs || [], unresolved: [] } : repairStrudel(code, { key: opts.key });
  const userCode = tidal.code;
  code = userCode;
  const fixed = repairCode(code);
  code = fixed.code;
  const res = evaluate(code);
  if (res.error) {
    const d = diagnose(userCode);
    return { error: res.error, diagnosis: d, repairs: tidal.repairs, unresolved: tidal.unresolved, code: userCode, original };
  }
  const cps = res.cps > 0 ? res.cps : 0.5;
  const bpm = Math.round(cps * 60 * bpc * 100) / 100;
  const { defs, ast } = sourceMap(code);
  const resolve = makeResolver(code, defs);
  const units = codeUnits(code, ast, defs);
  const unitOf = makeUnitResolver(units);
  const arr = arrangeSections(code, ast);
  const warnings = [...(res.warnings || []), ...fixed.notes];

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

  // group haps into tracks: named code by its const / label; anonymous code by its part (stack member / $: block),
  // so two parts never merge just because they share a sound (drums of one block stay one kit)
  const groups = new Map();
  const unitHaps = new Map();
  for (const e of events) {
    const v = e.value || {};
    if (v.s === undefined && v.note === undefined && v.freq === undefined && v.n === undefined) continue;
    const drum = drumInfo(v);
    const src = resolve(e.locations, v) || (e.name && !/^\$\d+$|^main$/.test(e.name) ? e.name : null);
    const unit = src ? null : unitOf(e.locations);
    if (unit) unitHaps.set(unit.id, (unitHaps.get(unit.id) || 0) + 1);
    const sound = drum ? (drum.machine || '') : String(v.s ?? 'triangle');
    let top = unit;
    while (top?.parent) top = top.parent;
    const anon = src ? '' : drum ? `#${top ? `u${top.id}` : e.block ?? e.pattern ?? 0}` : unit ? `u${unit.id}` : `#${e.block ?? e.pattern ?? 0}`;
    const key = `${src || anon}|${drum ? 'd' : 'm'}|${sound}`;
    let g = groups.get(key);
    if (!g) { g = { key, src, kind: drum ? 'drums' : 'melodic', sound, machine: drum ? drum.machine : null, haps: [], pos: Infinity, units: new Set() }; groups.set(key, g); }
    if (unit) g.units.add(unit.id);
    const at = defs.find((d) => d.name === src)?.start ?? e.locations?.[0]?.start;
    if (isNum(at) && at < g.pos) g.pos = at;
    const amp = (isNum(v.gain) ? v.gain : 0.8) * (isNum(v.velocity) ? v.velocity : 1) * (isNum(v.postgain) ? v.postgain : 1);
    const durCycles = isNum(e.duration) && e.duration > 0 ? e.duration : e.end - e.begin;
    g.haps.push({ beat: e.begin * bpc, dur: Math.max(0.02, durCycles * bpc), pitch: drum ? padPitch(drum.pad) : hapPitch(v), pad: drum?.pad, short: drum?.short, amp, v, locs: e.locations });
  }
  const tracks = [...groups.values()].filter((g) => g.haps.length).flatMap(splitByPan).sort((x, y) => x.pos - y.pos || (x.panSide || 0) - (y.panSide || 0)); // code order
  for (const t of tracks) t.unitList = [...t.units].map((id) => units[id]);
  nameTracks(tracks);
  // sounds superdough doesn't have (silent in Strudel) -> the nearest built-in waveform
  const customSamples = /\bsamples\s*\(/.test(code);
  for (const t of tracks) if (t.kind === 'melodic' && !customSamples && !isPresetName(t.sound) && unknownSound(t.sound)) t.substitute = { from: t.sound, to: substituteSound(t.sound) };

  // continuous controls (sine / saw / perlin …) sampled over time, per track they apply to
  const covered = (pr, t) => t.haps.some((h) => h.locs?.some((l) => pr.cover.some(([s0, e0]) => l.start >= s0 && l.start < e0)));
  // (only where the notes are too sparse / long to trace the signal themselves: < 2 notes per cycle or notes > ½ cycle)
  const sparse = (t) => {
    const on = [...new Set(t.haps.map((h) => r3(h.beat)))];
    return on.length < 2 * cycles * 0.9 || median(t.haps.map((h) => h.dur)) > bpc / 2;
  };
  const chunksOf = (c) => {
    const out = new Set();
    for (const t of tracks) {
      if (!covered(c, t)) continue;
      for (const h of t.haps) {
        const a0 = Math.floor(h.beat / bpc / PROBE_CHUNK), a1 = Math.floor((h.beat + h.dur) / bpc / PROBE_CHUNK);
        for (let k = a0; k <= a1 && k * PROBE_CHUNK < cycles; k++) out.add(k * PROBE_CHUNK);
      }
    }
    return out;
  };
  // (a gain signal on a melodic part always: a volume lane rather than per-note velocities)
  const needed = (c) => tracks.some((t) => covered(c, t) && (sparse(t) || (t.kind === 'melodic' && c.key === 'gain')));
  for (const pr of probeSignals(code, ast, defs, cycles, needed, chunksOf)) {
    const inCover = (pos) => pr.cover.some(([s0, e0]) => pos >= s0 && pos < e0);
    for (const t of tracks) {
      if (!t.haps.some((h) => h.locs?.some((l) => inCover(l.start)))) continue;
      t.probes ||= {};
      for (const k of [pr.key]) {
        const pts = pr.samples.filter((x) => isNum(x.value[k])).map((x) => ({ beat: x.cycle * bpc, value: x.value[k] }));
        if (pts.length < 2) continue;
        const prev = t.probes[k];
        if (!prev || pr.end - pr.start > prev.span) t.probes[k] = { span: pr.end - pr.start, points: pts };
      }
    }
  }
  for (const t of tracks) for (const [k, pr] of Object.entries(t.probes || {})) if (!probeAgrees(t.haps, k, pr.points)) delete t.probes[k];

  const parts = describeParts(code, defs, units, unitHaps, tracks, events, resolve);
  return { bpm, cps, beatsPerCycle: bpc, cycles, sections, arranged, tracks, warnings, code: userCode, original, playedCode: code, parts, repaired: fixed.fixes, repairs: tidal.repairs };
}

/**
 * jux() / per-copy pans: the same part plays at several fixed pan positions at once (a track has one pan) ->
 * one track per pan position (`lead L` / `lead R`), each panned there.
 */
function splitByPan(g) {
  if (g.kind !== 'melodic') return [g];
  const pans = new Set(g.haps.map((h) => (isNum(h.v.pan) ? r3(h.v.pan) : 0.5)));
  if (pans.size < 2 || pans.size > 3) return [g];
  const at = new Map();
  for (const h of g.haps) { const b = r3(h.beat); if (!at.has(b)) at.set(b, new Set()); at.get(b).add(isNum(h.v.pan) ? r3(h.v.pan) : 0.5); }
  const both = [...at.values()].filter((x) => x.size > 1).length;
  if (both < at.size * 0.5) return [g];
  return [...pans].sort((x, y) => x - y).map((pan) => ({
    ...g, key: `${g.key}|pan${pan}`, panSide: pan, panLabel: pan < 0.5 ? 'L' : pan > 0.5 ? 'R' : 'C', haps: g.haps.filter((h) => (isNum(h.v.pan) ? r3(h.v.pan) : 0.5) === pan),
  }));
}

/** Lookup of a probed series: the sample nearest a beat (null where the series has no samples close by). */
function probeLookup(points) {
  const gaps = [];
  for (let i = 1; i < points.length; i++) { const g = points[i].beat - points[i - 1].beat; if (g > 1e-6) gaps.push(g); }
  const tol = (median(gaps) || 0.25) * 1.5 + 1e-6;
  return (beat) => {
    let lo = 0, hi = points.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (points[mid].beat <= beat + 1e-6) lo = mid; else hi = mid - 1; }
    const p = points[lo];
    return p && Math.abs(p.beat - beat) <= tol ? p : null;
  };
}

/** Does a probed (continuous) series pass through the values Strudel gave the notes? (else a later call overrides it) */
function probeAgrees(haps, k, points) {
  const withK = haps.filter((h) => isNum(h.v[k]));
  if (!withK.length) return false;
  const near = probeLookup(points);
  let bad = 0, seen = 0;
  for (const h of withK) {
    const p = near(h.beat);
    if (!p) continue; // not sampled there (a section without the call)
    seen++;
    const x = h.v[k];
    if (Math.abs(p.value - x) > Math.max(Math.abs(x) * 0.08, 1e-3)) bad++;
  }
  return seen > 0 && bad <= seen * 0.1;
}

/**
 * The control series of a track as pseudo-haps [{beat, v: {[k]}}]: the probed continuous series where there is one,
 * the notes' own values elsewhere (sections without the signal, constant values).
 */
function controlSeries(t, haps, k) {
  const pr = t.probes?.[k];
  if (!pr) return haps;
  const near = probeLookup(pr.points);
  const first = pr.points[0].beat, last = pr.points[pr.points.length - 1].beat;
  const out = pr.points.map((p) => ({ beat: p.beat, v: { [k]: p.value } }));
  for (const h of haps) if (!(h.beat >= first - 1e-6 && h.beat <= last + 1e-6 && near(h.beat))) out.push(h);
  return out.sort((a, b) => a.beat - b.beat);
}

/**
 * The code's parts and what became of each: named consts / labels that play, else stack members / `$:` blocks.
 * -> [{label, name, kind, start, end (offsets in the played code), code, notes, tracks: [trackName], status: 'ok' | 'silent' | 'via', via?}]
 */
function describeParts(code, defs, units, unitHaps, tracks, events, resolve) {
  const parts = [];
  const snippet = (s0, e0) => code.slice(s0, e0).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // named sources
  const bySrc = new Map();
  for (const t of tracks) if (t.src) { if (!bySrc.has(t.src)) bySrc.set(t.src, []); bySrc.get(t.src).push(t); }
  for (const d of defs) {
    if (d.prio < 2) continue;
    const ts = bySrc.get(d.name) || [];
    const notes = ts.reduce((n, t) => n + t.haps.length, 0);
    const user = !notes ? defs.find((o) => o !== d && o.deps.has(d.name) && bySrc.has(o.name)) : null;
    parts.push({ label: d.name, name: d.name, kind: d.kind, start: d.start, end: d.end, code: snippet(d.start, d.end), notes, tracks: ts.map((t) => t.name), status: notes ? 'ok' : user ? 'via' : 'silent', via: user?.name });
  }
  // anonymous parts: leaf units with sound code (a member that is itself a stack lists its members instead)
  const hasSoundChild = new Set(units.filter((u) => u.sound && u.parent).map((u) => u.parent.id));
  const within = (u, o) => o.start >= u.start && o.end <= u.end;
  for (const u of units) {
    if (!u.sound || hasSoundChild.has(u.id)) continue;
    const ts = tracks.filter((t) => t.unitList?.some((x) => x === u || within(u, x)));
    const notes = [...unitHaps.entries()].filter(([id]) => within(u, units[id])).reduce((n, [, c]) => n + c, 0);
    const pathIdx = [];
    for (let x = u; x; x = x.parent) if (x.kind === 'member') pathIdx.unshift(x.index + 1);
    const label = u.name || (u.kind === 'member' ? `stack member ${pathIdx.join('.')}` : `block ${units.filter((x) => x.kind === 'block').indexOf(u) + 1}`);
    parts.push({ label, name: u.name || '', kind: u.kind, start: u.start, end: u.end, code: snippet(u.start, u.end), notes, tracks: ts.map((t) => t.name), status: notes ? 'ok' : 'silent' });
  }
  return parts;
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
  // anonymous parts named by their comment (`// 2. The Wanderer: …` above a stack member)
  const unitName = (t) => {
    const names = new Set(t.unitList?.map((u) => { let x = u; while (x && !x.name) x = x.parent; return x?.name || ''; }));
    return names.size === 1 ? [...names][0] : '';
  };
  const perUnitName = new Map();
  for (const t of tracks) if (!t.src) { const n = unitName(t); if (n) perUnitName.set(n, (perUnitName.get(n) || 0) + 1); }
  for (const [src, list] of bySrc) {
    for (const t of list) {
      const machine = t.machine ? (DRUM_MACHINES[t.machine]?.name || t.machine) : '';
      const sound = t.kind === 'drums' ? (machine || 'Drums') : prettySound(t.sound);
      const un = !src ? unitName(t) : '';
      if (un) t.name = perUnitName.get(un) > 1 ? `${un} ${t.kind === 'drums' ? drumsName(t).toLowerCase() : sound.toLowerCase()}` : un;
      else if (!src) t.name = t.kind === 'drums' ? drumsName(t) : [sound, roleWord(t)].filter(Boolean).join(' ');
      else if (list.length === 1) t.name = src;
      else if (t.kind === 'drums' && list.filter((x) => x.kind === 'drums').length === 1) t.name = src;
      else t.name = `${src} ${t.kind === 'drums' ? sound : sound.toLowerCase()}`;
      if (!un) t.name = t.name.replace(/_+$/, '').replace(/_/g, ' ');
    }
  }
  for (const t of tracks) if (t.panLabel) t.name = `${t.name} ${t.panLabel}`;
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
/** 'bass' | 'chords' (several notes at once, changing harmony) | 'lead' | '' (a fixed cluster repeated: no role). */
function roleWord(t) {
  if (t.kind === 'melodic' && t.haps.every((h) => h.v.note === undefined && h.v.freq === undefined && h.v.n === undefined)) return ''; // noise / unpitched
  const med = median(t.haps.map((h) => h.pitch));
  if (med < 48) return 'bass';
  const at = new Map();
  for (const h of t.haps) { const b = r3(h.beat); if (!at.has(b)) at.set(b, []); at.get(b).push(Math.round(h.pitch)); }
  const poly = [...at.values()].filter((xs) => xs.length > 1);
  if (poly.length <= at.size * 0.3) return 'lead';
  const sets = new Set(poly.map((xs) => [...new Set(xs.map((p) => ((p % 12) + 12) % 12))].sort((x, y) => x - y).join(',')));
  return sets.size > 1 ? 'chords' : '';
}

/** Loop length (cycles) of code without arrange(): the smallest period the haps (and slow sweeps) repeat with. */
function detectLoop(res) {
  let evs;
  try { evs = queryEvents(res, 0, LOOP_PROBE); } catch { return 4; }
  if (!evs.length) return 4;
  // per part (pattern + sound): every part must repeat with the period — a slow part (a 4-cycle bass under
  // 1-cycle drums) or a slow sweep can't be outvoted by the busy ones
  const sigs = new Map();
  const q = (x, step) => (isNum(x) ? Math.round(x / step) : '');
  const qf = (x) => (isNum(x) && x > 0 ? Math.round(Math.log2(x) * 4) : '');
  for (const e of evs) {
    const c = Math.floor(e.begin + EPS);
    if (c < 0 || c >= LOOP_PROBE) continue;
    const v = e.value || {};
    const g = `${e.pattern}|${v.s}`;
    if (!sigs.has(g)) sigs.set(g, Array.from({ length: LOOP_PROBE }, () => new Map()));
    const sig = sigs.get(g);
    const k = [v.note ?? v.n ?? v.freq, r3(e.begin - c), qf(v.cutoff), qf(v.hcutoff), q(v.room, 0.1), q(v.delay, 0.1), q(v.pan, 0.1), q(v.gain, 0.05)].join('|');
    sig[c].set(k, (sig[c].get(k) || 0) + 1);
  }
  const sim = (a, b) => {
    let inter = 0, total = 0;
    for (const [k, n] of a) { inter += Math.min(n, b.get(k) || 0); total += n; }
    for (const [, n] of b) total += n;
    return total ? (2 * inter) / total : 1;
  };
  for (const P of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48]) {
    const ok = [...sigs.values()].every((sig) => {
      let sum = 0, n = 0, worst = 1;
      for (let c = P; c < LOOP_PROBE; c++) { const s = sim(sig[c], sig[c - P]); sum += s; n++; worst = Math.min(worst, s); }
      return n && sum / n >= 0.85 && worst >= 0.5;
    });
    if (ok) return P < 4 ? P * Math.ceil(4 / P) : P;
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
  } else if (t.substitute) {
    // not a sound Strudel has (superdough plays nothing for it): the nearest built-in waveform, reported
    const sub = t.substitute.to;
    const cp = closestPatch(sub, med, poly);
    params.s = sub;
    def = { type: 'strudel', preset: null, params, fallbackPreset: cp.fallbackPreset };
    t.closestPatch = cp.id;
    t.silentInStrudel = true;
    report.notes.push(`${t.name}: "${sound}" isn't a Strudel sound (Strudel plays nothing for it) — played with "${sub}"`);
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

const KNOWN_SAMPLES = new Set(STRUDEL_SAMPLE_SOUNDS);
/** A sound name superdough doesn't know (no synth, no sample library / bank entry). */
function unknownSound(sound) {
  const s = String(sound || '').split(':')[0].toLowerCase();
  if (!s || isSynth(s) || KNOWN_SAMPLES.has(s) || /^gm_/.test(s) || DIRT_NAMES.has(s) || VCSL_NAMES.has(s) || splitBankSound(s)) return false;
  return true;
}
function substituteSound(sound) {
  const s = String(sound).toLowerCase();
  if (/saw/.test(s)) return /super/.test(s) ? 'supersaw' : 'sawtooth';
  if (/sq|pulse/.test(s)) return 'square';
  if (/sin|sub/.test(s)) return 'sine';
  if (/piano|keys/.test(s)) return 'piano';
  return 'triangle'; // soft / pad / bell / unknown: the softest waveform
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
function controlLane(haps, getter, { neutral, log = false, lo = 0, hi = 1, agg = median }) {
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
  const series = [...byBeat.entries()].sort((a, b) => a[0] - b[0]).map(([beat, xs]) => ({ beat, value: clamp(agg(xs), lo, hi) }));
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
  // (thinned relative to the lane's own swing: a 300..900 Hz sweep keeps its shape, not just its ends)
  const n0 = norm(mn), span = Math.max(norm(mx) - n0, 1e-6);
  const thinned = thin(pts.map((p) => ({ ...p, y: (norm(p.value) - n0) / span })), 0.02).map(({ beat, value }) => ({ beat, value: Number(value.toPrecision(4)) }));
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
  if (t.haps.every((h) => h.v.note === undefined && h.v.freq === undefined && h.v.n === undefined)) return null;
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
  // the code as imported (repaired: the code track holds it) and the user's original text
  project.importedCode = { code: a.code, original: a.original ?? a.code, repairs: a.repairs || [] };

  // ---- buses (room -> Reverb, delay -> Delay): one per distinct setting; a replaced project reuses its own buses first
  project.buses ||= [];
  const busCache = new Map();
  const taken = new Set();
  const busFor = (type, params) => {
    const key = type + JSON.stringify(params);
    if (busCache.has(key)) return busCache.get(key);
    let bus = replace ? project.buses.find((b) => !taken.has(b.id) && b.fx?.some((f) => f.type === type)) : null;
    if (!bus) {
      const label = type === 'reverb' ? `Reverb (${params.decay >= 8 ? 'large' : params.decay >= 4 ? 'medium' : params.decay >= 2 ? 'room' : 'small'})` : `Delay${params.division ? ` ${params.division}` : ''}`;
      const taken2 = new Set(project.buses.map((b) => b.name));
      let name = replace ? label : `${label} (Strudel)`;
      for (let i = 2; taken2.has(name); i++) name = `${replace ? label : `${label} (Strudel)`} ${i}`;
      bus = createBus(name, [createEffect(type, {})]);
      project.buses.push(bus);
    }
    taken.add(bus.id);
    Object.assign(bus.fx.find((f) => f.type === type).params, params, { mix: 1 });
    bus.volume = 1; // superdough's delay / reverb return at unity
    busCache.set(key, bus);
    return bus;
  };
  // (sizes in three buckets — small room / medium / large hall — so a song doesn't grow a bus per part)
  const reverbBus = (size) => {
    // (superdough's roomsize ≈ the tail's length in seconds: nearest of 0.5 / 1 / 2 / 4 / 8 s)
    const s = [0.5, 1, 2, 4, 8].reduce((b, x) => (Math.abs(Math.log(x / Math.max(size, 0.05))) < Math.abs(Math.log(b / Math.max(size, 0.05))) ? x : b), 2);
    return busFor('reverb', { decay: s, size: r3(clamp(s / 10, 0.2, 1)) });
  };
  const delayBus = (beats, seconds, feedback) => {
    const div = nearestDivision(beats);
    const fb = r3(clamp(Math.round(feedback / 0.05) * 0.05, 0, 0.95));
    // superdough's delay: one plain feedback line (no ping-pong, no filters in the loop)
    const plain = { feedback: fb, pingpong: false, lowcut: 20, highcut: 20000 };
    return busFor('delay', div ? { sync: true, division: div, ...plain } : { sync: false, time: r3(clamp(seconds, 0.01, 2)), ...plain });
  };

  const built = [];
  const colorIdx = { i: (project.tracks || []).length };
  for (const t of a.tracks) {
    const role = guessRole(t) || (t.kind === 'drums' ? 'drums' : roleWord(t) || null);
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
    let gainLane = null;
    if (!isDrums && t.probes?.gain) {
      // .gain(sine…) — a continuous level: a volume lane following the signal; the rest of the amplitude
      // (velocity / postgain / constant factors) stays in the notes
      const resid = haps.map((h) => h.amp / (isNum(h.v.gain) && h.v.gain > 0 ? h.v.gain : 0.8));
      const rref = Math.max(...resid, 1e-4);
      const G = controlLane(controlSeries(t, haps, 'gain'), (h) => (isNum(h.v.gain) ? h.v.gain : 0.8), { lo: 0, hi: 10, neutral: 0.8 });
      if (G?.points) {
        const top = Math.max(...G.points.map((x) => x.value)) * rref;
        const scale = top > 1.5 ? 1.5 / top : 1;
        if (scale < 1 && inst.type === 'strudel') inst.params.gain = r3((inst.params.gain || 0.8) / scale);
        gainLane = G.points.map((x) => ({ beat: x.beat, value: r3(clamp(x.value * rref * scale, 0, 1.5)) }));
        track.automation.push(createAutomationLane('volume', gainLane));
        track.volume = r3(Math.max(...gainLane.map((x) => x.value)));
        info.automation.push(`volume ${r3(Math.min(...gainLane.map((x) => x.value)))}–${r3(Math.max(...gainLane.map((x) => x.value)))}`);
        const resOf = new Map(haps.map((h, i) => [h, resid[i]]));
        haps.velRef = (h) => clamp(resOf.get(h) / rref, 0.02, 1);
      }
    }
    if (!isDrums && !gainLane) {
      const lane = controlLane(haps, (h) => h.amp, { lo: 0, hi: ref, neutral: undefined });
      if (lane?.points && smoothSeries(haps)) {
        volLane = lane.points.map((p) => ({ beat: p.beat, value: r3(clamp((p.value / ref) * vol, 0, 1.5)) }));
        track.automation.push(createAutomationLane('volume', volLane));
        info.automation.push('volume');
      }
    }
    const panComp = new Map();
    const velOf = (h) => (panComp.get(h) ?? 1) * velBase(h);
    const velBase = (h) => {
      if (isDrums) return clamp(h.amp / (padRef.get(h.pad) || ref), 0.05, 1);
      if (haps.velRef) return haps.velRef(h);
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
      const L = controlLane(controlSeries(t, haps, key), (h) => h.v[key], { neutral, log: true, lo: 20, hi: 20000 });
      if (!L) return;
      const q = stat(haps, qKey);
      const res = q && isNum(q.value) ? clamp(q.value, 0.1, 24) : (type === 'bandpass' ? 1 : 0.707);
      if (L.static !== undefined && neutral !== undefined && Math.abs(Math.log2(L.static / neutral)) < 0.01) return;
      const e = addFx('filter', { type, cutoff: r3(L.static ?? L.points[0].value), resonance: r3(res), depth: 0, mix: 1 },
        `${label} ${fmtHz(L.static ?? L.min)}${L.points ? `–${fmtHz(L.max)}` : ''}${q && isNum(q.value) ? ` Q ${r3(res)}` : ''}`);
      if (L.points) lane(`fx:${e.id}:cutoff`, L.points, `${label} cutoff ${fmtHz(L.min)}–${fmtHz(L.max)}${t.probes?.[key] ? ` (${sweepWord(L.points, bpc)})` : ''}`);
      if (neutral === undefined && L.present < L.total) lane(`fxen:${e.id}`, presenceLane(haps, (h) => h.v[key] !== undefined), `${label} on/off`);
    };
    if (t.lpInPatch && inst.type === 'strudel') {
      const L = controlLane(controlSeries(t, haps, 'cutoff'), (h) => h.v.cutoff, { neutral: 20000, log: true, lo: 20, hi: 20000 });
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
    // superdough's shape is (1+k)x / (1+k|x|) with no level compensation (k = 2s / (1-s)): it gets LOUDER; daW³'s
    // saturator keeps the level -> its output carries the gain the shaper adds at the voice's level (≈ 0.3 × gain)
    const shapeGain = (v) => {
      const k = (2 * clamp(v, 0, 0.99)) / (1 - clamp(v, 0, 0.99));
      const g = stat(haps, 'gain');
      const a = 0.3 * (g && isNum(g.value) ? g.value : 0.8);
      return r3(clamp(20 * Math.log10((1 + k) / (1 + k * a)), 0, 24));
    };
    amountFx('shape', 'saturator', (v) => ({ type: 'soft', drive: r3(clamp(v, 0, 1) * 24), output: shapeGain(v), tone: 20000, mix: 1 }), 'saturator');
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
        const L = controlLane(controlSeries(t, haps, 'pan'), (h) => h.v.pan, { neutral: 0.5, lo: 0, hi: 1 });
        if (L?.static !== undefined) track.pan = r3((L.static - 0.5) * 2);
        else if (L?.points) { lane('pan', L.points.map((p) => ({ beat: p.beat, value: r3((p.value - 0.5) * 2) })), 'pan'); track.pan = r3((L.points[0].value - 0.5) * 2); }
        if (isDrums) for (const p of Object.values(inst.params.pads)) delete p.pan;
        // superdough pans each (mono) voice with an equal-power panner: any .pan() costs the voice 3 dB at the
        // centre; a channel / patch panner on the voice's dual-mono output keeps the centre at unity and gains up
        // to +3 dB at the sides -> the notes are scaled by the difference, so the part keeps Strudel's level
        if (!isDrums) for (const h of haps) if (isNum(h.v.pan)) panComp.set(h, panLawComp(h.v.pan));
      }
    }

    // sends: room -> reverb bus, delay -> delay bus
    if (haps.some((h) => isNum(h.v.room) && h.v.room > 0)) {
      const mixed = conflict('room');
      if (mixed) report.notes.push(`${t.name}: reverb on some drum sounds only — the whole kit is sent at their level`);
      const size = stat(haps.filter((h) => isNum(h.v.room)), 'roomsize');
      const bus = reverbBus(size && isNum(size.value) ? size.value : 2);
      const L = controlLane(controlSeries(t, haps, 'room'), (h) => h.v.room, { neutral: 0, lo: 0, hi: 1, agg: (xs) => Math.max(...xs) });
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
      const L = controlLane(controlSeries(t, haps, 'delay'), (h) => h.v.delay, { neutral: 0, lo: 0, hi: 1, agg: (xs) => Math.max(...xs) });
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
  summary.parts = a.parts || [];
  summary.repaired = a.repaired || [];
  summary.repairs = a.repairs || [];
  // key: the code's .scale(), else what the notes say (pitch classes weighted by length)
  const key = detectKey(a.code) || keyFromNotes(a.tracks);
  if (key && !hadTracks) project.key = { root: key.root, scale: key.scale };
  summary.key = key ? `${keyRootName(key.root, key.scale)} ${key.scale}${key.from ? ` (${key.from})` : ''}` : null;
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

/** Key of the melodic notes (Krumhansl–Schmuckler, duration-weighted), null when there are too few. */
function keyFromNotes(tracks) {
  const notes = [];
  for (const t of tracks) if (t.kind !== 'drums') for (const h of t.haps) notes.push({ pitch: Math.round(h.pitch), start: h.beat, dur: Math.min(h.dur, 8), vel: clamp(h.amp, 0, 1) });
  if (notes.length < 4 || new Set(notes.map((n) => ((n.pitch % 12) + 12) % 12)).size < 3) return null;
  const [best] = detectKeyFromNotes(notes);
  return best ? { root: best.root, scale: best.scale, from: 'from the notes' } : null;
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

/**
 * Level of Strudel's per-voice pan (mono voice, equal-power: -3 dB at any position vs. no pan) relative to daW³'s
 * channel pan of the same voice (StereoPanner on a dual-mono signal: unity at the centre, +3 dB at the sides).
 * pan: Strudel 0..1 -> amplitude factor (0.707 at the centre, 0.5 hard left / right).
 */
export function panLawComp(pan) {
  const p = clamp((pan - 0.5) * 2, -1, 1);
  const c = Math.cos(((1 - Math.abs(p)) * Math.PI) / 2);
  return 1 / Math.sqrt(2 * (1 + c));
}

/** 'every 8 bars' — the period of a periodic lane (median distance between its peaks), else 'moving'. */
function sweepWord(points, bpc) {
  const peaks = [];
  for (let i = 1; i < points.length - 1; i++) if (points[i].value > points[i - 1].value && points[i].value >= points[i + 1].value) peaks.push(points[i].beat);
  if (peaks.length < 2) return 'moving';
  const d = [];
  for (let i = 1; i < peaks.length; i++) d.push(peaks[i] - peaks[i - 1]);
  let bars = median(d) / bpc;
  if (Math.abs(bars - Math.round(bars)) < Math.max(0.05 * bars, 0.02)) bars = Math.round(bars) || bars;
  return `every ${Number(bars.toPrecision(2))} bar${bars === 1 ? '' : 's'}`;
}

const fmtHz = (x) => (!isNum(x) ? '' : x >= 1000 ? `${Number((x / 1000).toPrecision(3))} kHz` : `${Math.round(x)} Hz`);

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
  if (analysis.error) return { error: analysis.error, diagnosis: analysis.diagnosis, repairs: analysis.repairs };
  if (!analysis.tracks.length) return { error: 'The code plays no notes' };
  let summary;
  store.transact(opts.label || 'Import Strudel (split into tracks)', (p) => { summary = splitStrudelToProject(p, analysis, opts); });
  return summary;
}

/** One-paragraph report of a split import. */
export function summaryText(s) {
  if (s.error) return `Could not split the code: ${s.error}`;
  const lines = [`${s.tracks.length} track${s.tracks.length === 1 ? '' : 's'} (${s.tracks.map((t) => t.name).join(', ')}) · ${s.bars} bars at ${s.bpm} BPM`
    + `${s.sections > 1 ? ` · ${s.sections} sections` : ''}${s.key ? ` · ${s.key}` : ''} · ${s.effects} effect${s.effects === 1 ? '' : 's'}, ${s.sends} send${s.sends === 1 ? '' : 's'}, ${s.lanes} automation lane${s.lanes === 1 ? '' : 's'}.`];
  const silent = (s.parts || []).filter((x) => x.status === 'silent');
  if (silent.length) lines.push(`Plays nothing in Strudel (no track): ${silent.map((x) => x.label).join(', ')}.`);
  if (s.repairs?.length) lines.push(`Repaired ${s.repairs.length} thing${s.repairs.length === 1 ? '' : 's'} Strudel would reject or play wrong (TidalCycles syntax): ${s.repairs.map((r) => `line ${r.line} ${r.from} → ${r.to}`).slice(0, 3).join('; ')}${s.repairs.length > 3 ? ' …' : ''}.`);
  if (s.unmapped?.length) lines.push(`Not mapped: ${s.unmapped.join(', ')}.`);
  if (s.notes?.length) lines.push(...s.notes.slice(0, 4));
  return lines.join('\n');
}
