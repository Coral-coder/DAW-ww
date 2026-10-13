// Entry point of the Strudel-compatible live-coding engine.
//
//   evaluate(source) -> { patterns, entries, cps, error }
//   queryEvents(evaluated, beginCycle, endCycle) -> [{ begin, end, value, pattern }]
//
// User code is plain JavaScript evaluated with every DSL function in scope (passed as
// parameters of a `new Function`, no `with`). A light source transform adds Strudel's REPL
// conveniences: `$:` / `name:` labelled patterns (`_$:` = muted), double-quoted and backtick
// strings become mini-notation patterns, top-level `await` is stripped, and the final bare
// expression is used as the pattern when there are no labels.
import {
  Pattern, pure, silence, stack, slowcat, fastcat, cat, seq, sequence, timeCat, timecat, arrange,
  polymeter, polymeterSteps, polyrhythm, run, irand, choose, chooseCycles, randcat, reify, register,
  curried, controls, METHOD_ARITY, setPatternRegistrar, isObj, EPS,
  saw, isaw, sine, cosine, square, tri, rand, perlin, saw2, isaw2, sine2, cosine2, square2, tri2, rand2,
} from './pattern.js';
import { mini } from './mini.js';
import { noteToMidi, isNoteName } from './theory.js';

export * from './pattern.js';
export { mini, parseMini } from './mini.js';
export { noteToMidi, midiToNoteName, isNoteName, parseScale, scaleStep, parseChord, voiceChord } from './theory.js';

// --------------------------------------------------------------------------------- DSL scope

const NOT_CURRIED = new Set(['p', 'q', 'play', 'log', 'logValues', 'stack', 'seq', 'cat', 'silence', 'hush']);
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public',
  'eval', 'arguments', 'null', 'true', 'false', 'undefined']);

function buildStaticScope() {
  const scope = {};
  for (const name of Object.keys(METHOD_ARITY)) {
    if (!NOT_CURRIED.has(name) && !name.startsWith('_')) scope[name] = curried(name);
  }
  Object.assign(scope, controls, {
    pure, silence, stack, slowcat, fastcat, cat, seq, sequence, timeCat, timecat, arrange, polymeter,
    polymeterSteps, polyrhythm, pr: polyrhythm, run, irand, choose, chooseCycles, randcat, reify, register,
    mini, m: mini, Pattern,
    saw, isaw, sine, cosine, square, tri, rand, perlin, saw2, isaw2, sine2, cosine2, square2, tri2, rand2,
  });
  return scope;
}

/** Names of all functions/values available in user code (static part). */
export function dslNames() {
  return Object.keys(buildStaticScope()).concat(PER_EVAL_NAMES);
}
const PER_EVAL_NAMES = ['setcps', 'setCps', 'setcpm', 'setCpm', 'setbpm', 'setBpm', 'hush', 'samples', 'soundAlias',
  'aliasBank', 'loadSoundfont', 'addVoicings', 'setVoicingRange', 'initHydra', 'all', 'each'];

// --------------------------------------------------------------------------- source transform

/** Returns the source with comments and string contents blanked (same length) + literal ranges. */
function maskSource(src) {
  const chars = src.split('');
  const literals = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' '; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let interp = false;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') interp = true;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      const end = Math.min(j + 1, n);
      literals.push({ start: i, end, quote: c, interp });
      blank(i + 1, end - 1);
      i = end;
    } else i++;
  }
  return { masked: chars.join(''), literals };
}

const LABEL_RE = /^(\s*)(_?)(\$|[A-Za-z_][\w]*)\s*:(?![:=])/;
const NON_LABELS = new Set(['case', 'default', 'http', 'https']);
const CONT_PREV = new Set('([{,.+-*/%&|=<>?:!~^'.split(''));
const CONT_NEXT = new Set('.)]},+*/%&|=<>?:^'.split(''));
const STMT_KEYWORD = /^(const|let|var|function|class|if|for|while|do|return|import|export|try|switch|throw|async|break|continue)\b/;

/**
 * Rewrites Strudel REPL code into a function body. Exported for debugging/tests.
 * Returns { body, labels: [{name, muted}], wrapped: boolean }.
 */
export function transformSource(source, { wrapLast = true } = {}) {
  const src = String(source ?? '').replace(/^﻿/, '');
  const { masked, literals } = maskSource(src);
  const edits = []; // { pos, del, text, order }
  let order = 0;
  const edit = (pos, del, text) => edits.push({ pos, del, text, order: order++ });

  // depth at each index
  const depth = new Int32Array(src.length + 1);
  let d = 0;
  for (let i = 0; i < src.length; i++) {
    depth[i] = d;
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
  }
  depth[src.length] = d;

  // labels at depth 0
  const labels = [];
  let lineStart = 0;
  while (lineStart <= src.length) {
    let lineEnd = masked.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = src.length;
    if (depth[lineStart] === 0) {
      const m = LABEL_RE.exec(masked.slice(lineStart, lineEnd));
      if (m && !NON_LABELS.has(m[3])) {
        labels.push({ start: lineStart + m[1].length, end: lineStart + m[0].length, muted: m[2] === '_', name: m[3] });
      }
    }
    lineStart = lineEnd + 1;
  }

  const lastCode = (a, b) => {
    for (let k = b - 1; k >= a; k--) if (!/\s/.test(masked[k])) return k;
    return -1;
  };

  // string literals -> mini patterns (double quotes & backticks without interpolation)
  for (const lit of literals) {
    if (lit.quote === "'" || lit.interp || lit.end - lit.start < 2) continue;
    // keep object keys like {"s": 1} as plain strings
    let a = lit.start - 1;
    while (a >= 0 && /\s/.test(masked[a])) a--;
    let b = lit.end;
    while (b < masked.length && /\s/.test(masked[b])) b++;
    if (masked[b] === ':' && (masked[a] === '{' || masked[a] === ',')) continue;
    edit(lit.start, 0, '__mini(');
    edit(lit.end, 0, ')');
  }
  // strip top-level await (samples() etc. are no-ops here)
  for (const m of masked.matchAll(/\bawait\s+/g)) edit(m.index, m[0].length, '');

  let wrapped = false;
  if (labels.length) {
    labels.forEach((lab, idx) => {
      const blockEnd = idx + 1 < labels.length ? labels[idx + 1].start : src.length;
      let last = lastCode(lab.end, blockEnd);
      while (last >= lab.end && masked[last] === ';') {
        edit(last, 1, '');
        last = lastCode(lab.end, last);
      }
      const name = lab.name === '$' ? null : lab.name;
      edit(lab.start, lab.end - lab.start, `__reg(${JSON.stringify(name)}, ${lab.muted}, (`);
      if (last < lab.end) edit(lab.end, 0, 'undefined\n));');
      else edit(last + 1, 0, '\n));');
    });
  } else if (wrapLast) {
    // split top-level statements, wrap the last expression in `return (...)`
    const stmts = [];
    let start = 0;
    let prev = '';
    for (let i = 0; i < src.length; i++) {
      const c = masked[i];
      if (depth[i] === 0 && c === ';') { stmts.push([start, i]); start = i + 1; prev = ''; continue; }
      if (depth[i] === 0 && c === '\n') {
        let k = i + 1;
        while (k < masked.length && /\s/.test(masked[k])) k++;
        const next = masked[k];
        if (prev && next && !CONT_PREV.has(prev) && !CONT_NEXT.has(next)) { stmts.push([start, i]); start = i + 1; prev = ''; }
        continue;
      }
      if (!/\s/.test(c)) prev = c;
    }
    stmts.push([start, src.length]);
    for (let s = stmts.length - 1; s >= 0; s--) {
      const [a, b] = stmts[s];
      const last = lastCode(a, b);
      if (last < 0) continue;
      let first = a;
      while (first < b && /\s/.test(masked[first])) first++;
      if (!STMT_KEYWORD.test(masked.slice(first, last + 1))) {
        edit(first, 0, 'return (');
        edit(last + 1, 0, '\n);');
        wrapped = true;
      }
      break;
    }
  }

  edits.sort((x, y) => x.pos - y.pos || (x.del === 0 ? 0 : 1) - (y.del === 0 ? 0 : 1) || x.order - y.order);
  let out = '';
  let cur = 0;
  for (const e of edits) {
    if (e.pos < cur) continue; // overlapping (shouldn't happen)
    out += src.slice(cur, e.pos) + e.text;
    cur = e.pos + e.del;
  }
  out += src.slice(cur);
  return { body: `{\n${out}\n}`, labels: labels.map((l) => ({ name: l.name, muted: l.muted })), wrapped };
}

// ---------------------------------------------------------------------------------- evaluate

const errMsg = (e) => (e && e.message ? e.message : String(e));

/**
 * Evaluates Strudel code.
 * @returns {{patterns: Pattern[], entries: {name, pattern, muted}[], cps: number|null, error: string|null}}
 */
export function evaluate(source) {
  const result = { patterns: [], entries: [], cps: null, error: null };
  const entries = [];
  let hushed = false;
  const allFns = [];
  const register$ = (name, muted, value) => {
    if (value === undefined || value === null) return value;
    const pattern = value instanceof Pattern ? value : reify(value);
    entries.push({ name: name || `$${entries.filter((e) => !e.explicitName).length + 1}`, explicitName: !!name, pattern, muted: !!muted });
    return value;
  };
  const plainStr = (x) => (x instanceof Pattern && x._src !== undefined ? x._src : x);
  const perEval = {
    setcps: (x) => { result.cps = Number(plainStr(x)); },
    setcpm: (x) => { result.cps = Number(plainStr(x)) / 60; },
    setbpm: (x) => { result.cps = Number(plainStr(x)) / 240; },
    hush: () => { hushed = true; return silence; },
    samples: () => undefined,
    soundAlias: () => undefined,
    aliasBank: () => undefined,
    loadSoundfont: () => undefined,
    addVoicings: () => undefined,
    setVoicingRange: () => undefined,
    initHydra: () => undefined,
    all: (f) => { allFns.push(f); },
    each: (f) => { allFns.push(f); },
  };
  perEval.setCps = perEval.setcps;
  perEval.setCpm = perEval.setcpm;
  perEval.setBpm = perEval.setbpm;
  const __mini = (s) => {
    const p = mini(s);
    if (p._src === undefined) p._src = s;
    return p;
  };

  const scope = { ...buildStaticScope(), ...perEval };
  const names = Object.keys(scope).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
  const values = names.map((k) => scope[k]);

  let ret;
  setPatternRegistrar((name, pat) => register$(String(plainStr(name)), false, pat));
  try {
    let fn;
    let t = transformSource(source);
    try {
      fn = new Function(...names, '__reg', '__mini', t.body);
    } catch (e) {
      if (!t.wrapped) throw e;
      t = transformSource(source, { wrapLast: false });
      fn = new Function(...names, '__reg', '__mini', t.body);
    }
    ret = fn(...values, register$, __mini);
    if (!entries.length && ret !== undefined && ret !== null && (ret instanceof Pattern || typeof ret === 'string')) {
      register$('main', false, ret);
    }
  } catch (e) {
    result.error = errMsg(e);
  } finally {
    setPatternRegistrar(null);
  }
  if (result.error) return result;
  if (hushed) entries.length = 0;
  for (const e of entries) {
    for (const f of allFns) e.pattern = typeof f === 'function' ? f(e.pattern) : e.pattern;
    delete e.explicitName;
  }
  // surface query-time errors now (bad chord names, unknown scales, ...)
  for (const e of entries) {
    try {
      e.pattern.queryArc(0, 1);
    } catch (err) {
      result.error = `${e.name}: ${errMsg(err)}`;
      return result;
    }
  }
  result.entries = entries;
  result.patterns = entries.filter((e) => !e.muted).map((e) => e.pattern);
  if (result.cps !== null && !(result.cps > 0)) result.cps = null;
  return result;
}

// ------------------------------------------------------------------------------------- events

/** Normalises a hap value into a control object; note names -> MIDI numbers. */
export function normalizeValue(v) {
  let out;
  if (isObj(v)) out = { ...v };
  else if (Array.isArray(v)) out = { s: v[0], ...(v[1] !== undefined ? { n: v[1] } : {}) };
  else if (typeof v === 'number' || isNoteName(v)) out = { note: v };
  else out = { s: String(v) };
  if ('value' in out && out.note === undefined && out.s === undefined) {
    const val = out.value;
    delete out.value;
    if (typeof val === 'number' || isNoteName(val)) out.note = val;
    else out.s = String(val);
  }
  if (typeof out.note === 'string') {
    const m = noteToMidi(out.note);
    if (m !== null) out.note = m;
    else if (out.note.trim() !== '' && !Number.isNaN(Number(out.note))) out.note = Number(out.note);
  }
  return out;
}

/**
 * Onsets in [beginCycle, endCycle), sorted by begin.
 * `evaluated` may be an evaluate() result, a Pattern, or an array of patterns.
 */
export function queryEvents(evaluated, beginCycle, endCycle) {
  const pats = evaluated instanceof Pattern ? [evaluated] : Array.isArray(evaluated) ? evaluated : evaluated?.patterns || [];
  const events = [];
  pats.forEach((pat, i) => {
    let haps;
    try {
      haps = pat.queryArc(beginCycle, endCycle);
    } catch (e) {
      if (evaluated && !(evaluated instanceof Pattern) && !Array.isArray(evaluated)) evaluated.queryError = errMsg(e);
      return;
    }
    for (const h of haps) {
      if (!h.hasOnset()) continue;
      const b = h.whole.begin;
      if (b < beginCycle - EPS || b >= endCycle - EPS) continue;
      events.push({ begin: b, end: h.whole.end, value: normalizeValue(h.value), pattern: i });
    }
  });
  events.sort((a, b) => a.begin - b.begin || a.pattern - b.pattern);
  return events;
}

/** Default Strudel tempo: 0.5 cycles per second (= 120 bpm in 4/4 with 1 cycle per bar). */
export const DEFAULT_CPS = 0.5;
