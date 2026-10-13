// Entry point of the live-coding engine.
//
//   evaluate(source) -> { patterns, entries, cps, error }
//   queryEvents(evaluated, beginCycle, endCycle) -> [{ begin, end, value, pattern }]
//
// This is a facade: once the vendored REAL Strudel engine (vendor/strudel, see strudel-real.js) is
// loaded, evaluate() runs user code through Strudel itself and queryEvents() turns its haps into our
// event format. In a browser the first evaluate() starts loading it (lazily); until it is ready — or if
// it can't load — the built-in reimplementation below (evaluateBuiltin, pattern.js, mini.js) is used.
// In Node nothing is loaded unless loadStrudel() is called (tests choose the engine explicitly).
//
// Built-in engine:
// User code is plain JavaScript evaluated with every DSL function in scope (passed as
// parameters of a `new Function`, no `with`). A light source transform adds Strudel's REPL
// conveniences: `$:` / `name:` labelled patterns (`_$:` = muted), double-quoted and backtick
// strings become mini-notation patterns, top-level `await` is stripped, and the final bare
// expression is used as the pattern when there are no labels.
import {
  Pattern, pure, silence, stack, slowcat, fastcat, cat, seq, sequence, timeCat, timecat, arrange,
  polymeter, polymeterSteps, polyrhythm, run, irand, choose, chooseCycles, randcat, reify, register,
  curried, controls, METHOD_ARITY, setPatternRegistrar, isObj, EPS, shiftLocations, stripLocations,
  saw, isaw, sine, cosine, square, tri, rand, perlin, saw2, isaw2, sine2, cosine2, square2, tri2, rand2,
} from './pattern.js';
import { mini } from './mini.js';
import { noteToMidi, isNoteName } from './theory.js';
import {
  loadStrudel, strudelStatus, evaluateStrudel, isStrudelPattern, strudelScopeNames, onStrudelStatus,
} from './strudel-real.js';

export {
  loadStrudel, strudelStatus, onStrudelStatus, isStrudelPattern, setSliderValue, sliderValue, loadStrudelAudio,
} from './strudel-real.js';

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

// `mini("…")` in user code: the literal was already turned into a (located) pattern
const miniArg = (x) => (x instanceof Pattern ? x : stripLocations(mini(x)));

function buildStaticScope() {
  const scope = {};
  for (const name of Object.keys(METHOD_ARITY)) {
    if (!NOT_CURRIED.has(name) && !name.startsWith('_')) scope[name] = curried(name);
  }
  Object.assign(scope, controls, {
    pure, silence, stack, slowcat, fastcat, cat, seq, sequence, timeCat, timecat, arrange, polymeter,
    polymeterSteps, polyrhythm, pr: polyrhythm, run, irand, choose, chooseCycles, randcat, reify, register,
    mini: miniArg, m: miniArg, Pattern,
    saw, isaw, sine, cosine, square, tri, rand, perlin, saw2, isaw2, sine2, cosine2, square2, tri2, rand2,
  });
  return scope;
}

/** Names of all functions/values available in user code (static part). */
export function dslNames() {
  if (strudelStatus() === 'ready') return strudelScopeNames();
  return Object.keys(buildStaticScope()).concat(PER_EVAL_NAMES);
}

let builtinOnly = false;
/** Force the built-in engine (true) or allow the real Strudel engine again (false). */
export function useBuiltinEngine(on = true) { builtinOnly = !!on; engineVersion++; }
let engineVersion = 0;
onStrudelStatus(() => { engineVersion++; });
/** Changes whenever the engine evaluate() uses changes — include it in caches of evaluate() results. */
export const codeEngineVersion = () => engineVersion;
/** 'strudel' when evaluate() runs the real Strudel engine, else 'builtin'. */
export const codeEngine = () => (!builtinOnly && strudelStatus() === 'ready' ? 'strudel' : 'builtin');
const PER_EVAL_NAMES = ['setcps', 'setCps', 'setcpm', 'setCpm', 'setbpm', 'setBpm', 'hush', 'samples', 'soundAlias',
  'aliasBank', 'loadSoundfont', 'addVoicings', 'setVoicingRange', 'initHydra', 'all', 'each'];

// --------------------------------------------------------------------------- source transform

/** Returns the source with comments and string contents blanked (same length) + literal ranges. */
function maskSource(src) {
  const chars = src.split('');
  const literals = [];
  const comments = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' '; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      comments.push({ start: i, end: j });
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      comments.push({ start: i, end: j });
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
  return { masked: chars.join(''), literals, comments };
}

/** The source without comments (strings untouched). */
export function stripComments(src) {
  src = String(src ?? '');
  const { comments } = maskSource(src);
  if (!comments.length) return src;
  let out = '';
  let cur = 0;
  for (const c of comments) { out += src.slice(cur, c.start); cur = c.end; }
  return out + src.slice(cur);
}

/**
 * Splits code into its top-level items (statements / labelled patterns), in source order:
 * [{ kind: 'label'|'decl'|'stmt', name?, muted?, start, end, exprStart }]. Lines that only hold
 * comments belong to no item. `end` excludes trailing whitespace/comments.
 */
export function splitTopLevel(source) {
  const src = String(source ?? '');
  const { masked } = maskSource(src);
  const n = src.length;
  const items = [];
  let d = 0;
  let prev = '';
  let cur = null;
  let lineStart = 0;
  const close = (end) => {
    if (!cur) return;
    let e = end;
    while (e > cur.start && /\s/.test(masked[e - 1])) e--;
    cur.end = e;
    items.push(cur);
    cur = null;
  };
  while (lineStart <= n) {
    let lineEnd = masked.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = n;
    const line = masked.slice(lineStart, lineEnd);
    const t = line.trim();
    if (t) {
      const first = lineStart + line.length - line.trimStart().length;
      const lab = d === 0 ? LABEL_RE.exec(line) : null;
      const isLabel = lab && !NON_LABELS.has(lab[3]);
      const startsNew = d === 0 && (isLabel || !cur || (prev && !CONT_PREV.has(prev) && !CONT_NEXT.has(t[0])));
      if (startsNew) {
        close(lineStart);
        if (isLabel) cur = { kind: 'label', name: lab[3], muted: lab[2] === '_', start: first, exprStart: lineStart + lab[0].length };
        else {
          const dm = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(t);
          cur = dm ? { kind: 'decl', name: dm[1], start: first, exprStart: first + t.indexOf('=') + 1 } : { kind: 'stmt', start: first, exprStart: first };
        }
      }
      for (let k = lineStart; k < lineEnd; k++) {
        const c = masked[k];
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
        if (!/\s/.test(c)) prev = c;
      }
    }
    lineStart = lineEnd + 1;
  }
  close(n);
  return items;
}

/** Start offset of the last top-level expression statement (where `label:` can be inserted), or -1. */
export function lastExpressionStart(source) {
  const items = splitTopLevel(source).filter((it) => it.kind !== 'decl');
  const last = items[items.length - 1];
  if (!last || last.kind !== 'stmt') return -1;
  const text = String(source).slice(last.start, last.end);
  return STMT_KEYWORD.test(text) ? -1 : last.start;
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
  const raw0 = String(source ?? '');
  const src = raw0.replace(/^\uFEFF/, '');
  const bom = raw0.length - src.length;
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
  // a label's block ends at the next label or at the next top-level statement
  // (`const x = …`, `setcpm(…)`, …) so declarations can sit between labelled patterns
  const statementBoundary = (from, to) => {
    let k = from;
    while (k < to && /\s/.test(masked[k])) k++;
    let prev = '';
    for (; k < to; k++) {
      const c = masked[k];
      if (depth[k] === 0 && c === '\n' && prev) {
        let j = k + 1;
        while (j < to && /\s/.test(masked[j])) j++;
        const next = masked[j];
        if (j < to && next && !CONT_PREV.has(prev) && !CONT_NEXT.has(next)) return lineStartOf(j);
      }
      if (!/\s/.test(c)) prev = c;
    }
    return to;
  };
  const lineStartOf = (pos) => masked.lastIndexOf('\n', pos - 1) + 1;

  // arguments of samples(…) / soundAlias(…) etc. are URLs and sample maps, never mini-notation
  const plainRanges = [];
  for (const m of masked.matchAll(/\b(samples|soundAlias|aliasBank|loadSoundfont|addVoicings)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let dd = 0;
    let k = open;
    for (; k < masked.length; k++) {
      if (masked[k] === '(') dd++;
      else if (masked[k] === ')' && --dd === 0) break;
    }
    plainRanges.push([open, k]);
  }
  // string literals -> mini patterns (double quotes & backticks without interpolation)
  for (const lit of literals) {
    if (lit.quote === "'" || lit.interp || lit.end - lit.start < 2) continue;
    if (plainRanges.some(([a, b]) => lit.start > a && lit.start < b)) continue;
    // keep object keys like {"s": 1} as plain strings
    let a = lit.start - 1;
    while (a >= 0 && /\s/.test(masked[a])) a--;
    let b = lit.end;
    while (b < masked.length && /\s/.test(masked[b])) b++;
    if (masked[b] === ':' && (masked[a] === '{' || masked[a] === ',')) continue;
    // the content offset lets every mini-notation atom report its position in `source`
    // (escape sequences would shift positions -> no locations for those literals)
    const raw = src.slice(lit.start + 1, lit.end - 1);
    const off = raw.includes('\\') ? -1 : lit.start + 1 + bom;
    edit(lit.start, 0, '__mini(');
    edit(lit.end, 0, `, ${off})`);
  }
  // strip top-level await (samples() etc. are no-ops here)
  for (const m of masked.matchAll(/\bawait\s+/g)) edit(m.index, m[0].length, '');

  let wrapped = false;
  if (labels.length) {
    labels.forEach((lab, idx) => {
      const nextLabel = idx + 1 < labels.length ? labels[idx + 1].start : src.length;
      const blockEnd = statementBoundary(lab.end, nextLabel);
      lab.blockEnd = blockEnd;
      let last = lastCode(lab.end, blockEnd);
      while (last >= lab.end && masked[last] === ';') {
        edit(last, 1, '');
        last = lastCode(lab.end, last);
      }
      const name = lab.name === '$' ? null : lab.name;
      edit(lab.start, lab.end - lab.start, `__reg(${idx}, ${JSON.stringify(name)}, ${lab.muted}, (`);
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
  return {
    body: `{\n${out}\n}`,
    // start/end: source range of the label's block (label included) — used for highlighting
    labels: labels.map((l) => ({ name: l.name, muted: l.muted, start: l.start + bom, end: (l.blockEnd ?? src.length) + bom })),
    wrapped,
  };
}

// ------------------------------------------------------------------------------- sample packs

// `samples('github:user/repo')` / `samples({name: [urls]}, base)` register custom sample packs.
// The loader is injectable (setSampleLoader) so this module stays Node-importable; in a browser it
// defaults to src/audio/library/strudel-sounds.js registerSamples() via a lazy dynamic import.
let sampleLoader = null;
const requestedPacks = new Map(); // key -> Promise (each pack is fetched once per session)
export function setSampleLoader(fn) { sampleLoader = typeof fn === 'function' ? fn : null; }
function defaultSampleLoader(mapOrUrl, base) {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return import('../audio/library/strudel-sounds.js').then((m) => m.registerSamples(mapOrUrl, base));
}
/** Starts loading a sample pack (fire and forget; errors are reported once). Returns the promise. */
export function loadSamples(mapOrUrl, base) {
  if (mapOrUrl === undefined || mapOrUrl === null || mapOrUrl === '') return Promise.resolve(null);
  let key;
  try { key = typeof mapOrUrl === 'string' ? `${mapOrUrl}|${base ?? ''}` : JSON.stringify([mapOrUrl, base ?? '']); } catch { key = String(mapOrUrl); }
  if (requestedPacks.has(key)) return requestedPacks.get(key);
  const loader = sampleLoader || defaultSampleLoader;
  const p = Promise.resolve().then(() => loader(mapOrUrl, base)).catch((e) => {
    requestedPacks.delete(key); // allow a retry on the next evaluation
    if (typeof console !== 'undefined') console.warn('[strudel] samples() failed:', e?.message || e);
    return null;
  });
  requestedPacks.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------------- evaluate

const errMsg = (e) => (e && e.message ? e.message : String(e));

/**
 * Evaluates Strudel code (real Strudel when loaded, see the header).
 * @returns {{patterns: Pattern[], entries: {name, pattern, muted, block}[], labels, cps: number|null,
 *   error: string|null, warnings: string[], widgets?: object[], engine: 'strudel'|'builtin', pending?: boolean}}
 */
export function evaluate(source) {
  if (!builtinOnly) {
    const st = strudelStatus();
    if (st === 'ready') return evaluateStrudel(source);
    if (st === 'idle' && typeof window !== 'undefined') loadStrudel();
    if (st === 'idle' || st === 'loading') {
      if (typeof window === 'undefined') return evaluateBuiltin(source);
      // while Strudel loads (a moment), the built-in engine stands in; code it can't handle isn't an error yet
      const res = evaluateBuiltin(source);
      if (!res.error) return { ...res, pending: true };
      return { patterns: [], entries: [], labels: res.labels || [], cps: null, error: null, warnings: [], engine: 'builtin', pending: true };
    }
  }
  return evaluateBuiltin(source);
}

/** The built-in (reimplemented) engine. */
export function evaluateBuiltin(source) {
  const result = { patterns: [], entries: [], labels: [], cps: null, error: null, engine: 'builtin' };
  const entries = [];
  let hushed = false;
  const allFns = [];
  const register$ = (name, muted, value, block = null) => {
    if (value === undefined || value === null) return value;
    const pattern = value instanceof Pattern ? value : reify(value);
    entries.push({ name: name || `$${entries.filter((e) => !e.explicitName).length + 1}`, explicitName: !!name, pattern, muted: !!muted, block });
    return value;
  };
  // labelled blocks: __reg(blockIndex, name, muted, value)
  const regLabel = (block, name, muted, value) => register$(name, muted, value, block);
  const plainStr = (x) => (x instanceof Pattern && x._src !== undefined ? x._src : x);
  const perEval = {
    setcps: (x) => { result.cps = Number(plainStr(x)); },
    setcpm: (x) => { result.cps = Number(plainStr(x)) / 60; },
    setbpm: (x) => { result.cps = Number(plainStr(x)) / 240; },
    hush: () => { hushed = true; return silence; },
    samples: (x, base) => { loadSamples(plainStr(x), plainStr(base)); return undefined; },
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
  const __mini = (s, offset = -1) => {
    let p = mini(s);
    p = offset >= 0 ? shiftLocations(p, offset) : stripLocations(p);
    if (p._src === undefined) p._src = s;
    return p;
  };

  // Strudel REPL widgets: the code keeps working with the widget's current (initial) value.
  perEval.slider = (value) => reify(Number(plainStr(value)));
  perEval.toggle = (value) => reify(plainStr(value) ? 1 : 0);

  const scope = { ...buildStaticScope(), ...perEval };
  // Functions / methods we don't implement yet degrade to pass-throughs (with a warning) instead of
  // failing the whole song.
  const unknown = findUnknownNames(source, scope);
  result.warnings = [];
  for (const name of unknown.functions) {
    scope[name] = (...args) => args.find((a) => a instanceof Pattern) ?? silence;
    result.warnings.push(`${name}() is not supported yet — ignored`);
  }
  const addedMethods = [];
  for (const name of unknown.methods) {
    Pattern.prototype[name] = function passThrough() { return this; };
    addedMethods.push(name);
    result.warnings.push(`.${name}() is not supported yet — ignored`);
  }
  const names = Object.keys(scope).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
  const values = names.map((k) => scope[k]);

  let ret;
  setPatternRegistrar((name, pat) => register$(String(plainStr(name)), false, pat));
  try {
    let fn;
    let t = transformSource(source);
    result.labels = t.labels;
    try {
      fn = new Function(...names, '__reg', '__mini', t.body);
    } catch (e) {
      if (!t.wrapped) throw e;
      t = transformSource(source, { wrapLast: false });
      result.labels = t.labels;
      fn = new Function(...names, '__reg', '__mini', t.body);
    }
    ret = fn(...values, regLabel, __mini);
    if (!entries.length && ret !== undefined && ret !== null && (ret instanceof Pattern || typeof ret === 'string')) {
      register$('main', false, ret);
    }
  } catch (e) {
    result.error = errMsg(e);
  } finally {
    setPatternRegistrar(null);
    for (const name of addedMethods) delete Pattern.prototype[name];
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

// Identifiers JavaScript itself provides (never stubbed).
const JS_GLOBALS = new Set(['Math', 'Number', 'String', 'Array', 'Object', 'Boolean', 'JSON', 'Date', 'console', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'Promise', 'Symbol', 'Map', 'Set', 'RegExp', 'Error', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'window', 'globalThis', 'require', 'import', 'async', 'function', 'return',
  'if', 'for', 'while', 'switch', 'catch', 'typeof', 'new', 'await', 'Infinity', 'NaN', 'undefined']);
// Methods of plain JS values that may legitimately appear in Strudel code.
const JS_METHODS = new Set(['map', 'filter', 'reduce', 'forEach', 'join', 'split', 'slice', 'splice', 'push', 'pop', 'shift',
  'unshift', 'concat', 'includes', 'indexOf', 'toString', 'toFixed', 'then', 'catch', 'finally', 'keys', 'values',
  'entries', 'replace', 'trim', 'toUpperCase', 'toLowerCase', 'repeat', 'fill', 'flat', 'flatMap', 'find', 'some',
  'every', 'sort', 'reverse', 'at', 'charAt', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'log', 'apply', 'call', 'bind',
  'floor', 'ceil', 'round', 'random', 'min', 'max', 'abs', 'pow', 'sqrt', 'sin', 'cos', 'exp']);

/** Calls in the source to functions / Pattern methods the engine doesn't know. */
export function findUnknownNames(source, scope, proto = Pattern.prototype) {
  const { masked } = maskSource(String(source ?? ''));
  const declared = new Set();
  for (const m of masked.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of masked.matchAll(/\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) declared.add(m[1]);
  for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) for (const a of m[1].split(',')) declared.add(a.trim().replace(/=.*$/, '').trim());
  const functions = new Set();
  const methods = new Set();
  for (const m of masked.matchAll(/(\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (m[1]) {
      if (!(name in proto) && !JS_METHODS.has(name)) methods.add(name);
    } else if (!(name in scope) && !declared.has(name) && !JS_GLOBALS.has(name) && !RESERVED.has(name)) {
      functions.add(name);
    }
  }
  return { functions: [...functions], methods: [...methods] };
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

/** Unique, sorted source ranges of a hap ([{start, end}]). */
function hapLocations(h) {
  const locs = h.context?.locations;
  if (!locs || !locs.length) return [];
  if (locs.length === 1) return [{ start: locs[0].start, end: locs[0].end }];
  const seen = new Set();
  const out = [];
  for (const l of locs) {
    const k = l.start * 1e6 + l.end;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ start: l.start, end: l.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Onsets in [beginCycle, endCycle), sorted by begin.
 * `evaluated` may be an evaluate() result, a Pattern, or an array of patterns.
 * Each event: { begin, end, value, pattern (index into the playing patterns), name (label, when
 * known), block (labelled-block index, when known), locations: [{start, end}] (source ranges of
 * the mini-notation tokens that produced it — absolute offsets for evaluate() results) }.
 * opts.active: return the events *overlapping* the window instead of the onsets inside it
 * (used for live highlighting).
 */
export function queryEvents(evaluated, beginCycle, endCycle, opts = {}) {
  let list;
  const isPat = (x) => x instanceof Pattern || isStrudelPattern(x);
  if (isPat(evaluated)) list = [{ pattern: evaluated }];
  else if (Array.isArray(evaluated)) list = evaluated.map((pattern) => ({ pattern }));
  else {
    const entries = (evaluated?.entries || []).filter((e) => !e.muted);
    list = entries.length === (evaluated?.patterns || []).length && entries.length
      ? entries
      : (evaluated?.patterns || []).map((pattern) => ({ pattern }));
  }
  const events = [];
  const overlap = !!opts.active;
  list.forEach((entry, i) => {
    const real = isStrudelPattern(entry.pattern);
    let haps;
    try {
      haps = entry.pattern.queryArc(beginCycle, endCycle);
    } catch (e) {
      if (evaluated && !isPat(evaluated) && !Array.isArray(evaluated)) evaluated.queryError = errMsg(e);
      return;
    }
    for (const h of haps) {
      if (!h.whole) continue;
      const b = Number(h.whole.begin); // real Strudel times are Fractions
      if (overlap) {
        // events overlapping the window: report each once (at its onset fragment, or the first fragment)
        if (!h.hasOnset() && Number(h.part.begin) > beginCycle + EPS) continue;
      } else {
        if (!h.hasOnset()) continue;
        if (b < beginCycle - EPS || b >= endCycle - EPS) continue;
      }
      const ev = { begin: b, end: Number(h.whole.end), value: normalizeValue(h.value), pattern: i, locations: hapLocations(h) };
      // sounding length in cycles as Strudel computes it (value.duration / clip|legato applied)
      if (real) ev.duration = Number(h.duration);
      if (entry.name !== undefined) ev.name = entry.name;
      if (entry.block !== undefined && entry.block !== null) ev.block = entry.block;
      events.push(ev);
    }
  });
  events.sort((a, b) => a.begin - b.begin || a.pattern - b.pattern);
  return events;
}

/** Default Strudel tempo: 0.5 cycles per second (= 120 bpm in 4/4 with 1 cycle per bar). */
export const DEFAULT_CPS = 0.5;
