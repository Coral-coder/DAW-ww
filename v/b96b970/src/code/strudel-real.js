// The REAL Strudel engine (https://strudel.cc — AGPL-3.0-or-later), vendored as prebuilt ESM under
// vendor/strudel/ (see scripts/vendor-strudel.sh) and lazy-loaded the first time code is evaluated.
//
//   loadStrudel()            -> Promise<boolean>   loads vendor/strudel/strudel-core.mjs (pattern engine)
//   strudelStatus()          -> 'idle' | 'loading' | 'ready' | 'failed'
//   onStrudelStatus(fn)      -> unsubscribe        called when the status changes
//   evaluateStrudel(source)  -> evaluate() result (see strudel.js) computed by Strudel's own transpiler
//   isStrudelPattern(x)      -> boolean
//   setSliderValue(id, v) / sliderValue(id)        live values of slider() widgets
//   loadStrudelAudio()       -> Promise<module>    superdough + sound registries (browser only, see
//                                                  src/audio/strudel-instrument.js)
//
// Evaluation mirrors Strudel's REPL (@strudel/core repl.mjs + transpiler): `$:` / `name:` labels become
// `.p(name)` calls, double-quoted / backtick strings become located mini-notation, slider() becomes
// sliderWithID(), all()/each()/hush()/setcps()… work, and every exported function is in scope. Differences
// (all deliberate, so a DAW track can evaluate synchronously): top-level `await` is dropped (sample maps
// load in the background), labelled patterns stay separate entries (one per block, for highlighting and
// the song view) instead of one stack, and names Strudel packages we don't ship (midi, hydra, osc, …)
// degrade to pass-throughs with a warning.
import { findUnknownNames, loadSamples } from './strudel.js';

const CORE_URL = new URL('../../vendor/strudel/strudel-core.mjs', import.meta.url).href;
const AUDIO_URL = new URL('../../vendor/strudel/strudel-audio.mjs', import.meta.url).href;

let S = null; // { core, mini, tonal, transpiler, draw, acornParse }
let status = 'idle';
let loading = null;
let scope = null; // name -> value (everything user code can reference)
let scopeNames = [];
let scopeValues = [];
const listeners = new Set();

export const strudelStatus = () => status;
export const strudelModules = () => S;
export function onStrudelStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setStatus(s) {
  status = s;
  for (const fn of [...listeners]) { try { fn(s); } catch (e) { console.warn('[strudel]', e); } }
}

/** Loads the vendored Strudel pattern engine (once). Resolves true when it is usable. */
export function loadStrudel() {
  if (loading) return loading;
  setStatus('loading');
  loading = import(/* @vite-ignore */ CORE_URL).then((mod) => {
    S = mod;
    setup();
    setStatus('ready');
    return true;
  }, (e) => {
    console.warn('[strudel] could not load the Strudel engine — using the built-in engine instead:', e?.message || e);
    setStatus('failed');
    return false;
  });
  return loading;
}

export const isStrudelPattern = (x) => !!S && x instanceof S.core.Pattern;

// ------------------------------------------------------------------------------- scope set-up

const VALID_NAME = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public',
  'eval', 'arguments', 'null', 'true', 'false', 'undefined', 'NaN', 'Infinity']);
// visualisations draw onto a full-page canvas in strudel.cc; inside the DAW they are no-ops
// (the Code view draws its own punchcard / piano roll)
const VISUALS = ['draw', 'animate', 'pianoroll', 'punchcard', 'wordfall', 'spiral', 'pitchwheel', 'scope', 'tscope', 'fscope', 'spectrum'];

let ev = null; // per-evaluation state (evaluation is synchronous, so one is enough)
const sliderValues = new Map(); // slider id -> current value
const pendingAudioCalls = []; // samples()/aliasBank()/soundAlias() calls made before superdough loaded
let audio = null; // loaded audio module (strudel-audio.mjs)

function neutraliseVisuals() {
  const proto = S.core.Pattern.prototype;
  for (const k of VISUALS) proto[k] = function visual() { return this; };
}

function setup() {
  const { core, mini, tonal, draw } = S;
  neutraliseVisuals();
  const P = core.Pattern.prototype;
  // REPL pattern methods (normally injected by repl()): labels -> .p(name)
  P.p = function p(id) { return ev ? ev.register(this, id) : this; };
  P.q = function q() { return core.silence; };
  for (let i = 1; i < 10; i++) {
    for (const k of [`d${i}`, `p${i}`]) Object.defineProperty(P, k, { get() { return this.p(i); }, configurable: true });
    P[`q${i}`] = core.silence;
  }
  core.register('cpm', function cpm(c, pat) { return pat._fast(c / 60 / (ev?.result.cps || 0.5)); });

  // strudel.cc's evalScope order: core, draw, mini, tonal, (webaudio …)
  scope = {};
  for (const m of [core, draw, mini, tonal]) Object.assign(scope, m);
  Object.assign(scope, {
    // REPL functions (repl.mjs)
    setcps: (x) => setCps(unpure(x)), setCps: (x) => setCps(unpure(x)),
    setcpm: (x) => setCps(unpure(x) / 60), setCpm: (x) => setCps(unpure(x) / 60),
    setbpm: (x) => setCps(unpure(x) / 240), setBpm: (x) => setCps(unpure(x) / 240),
    hush: () => { if (ev) ev.hushed = true; return core.silence; },
    all: (f) => { ev?.all.push(f); return core.silence; },
    each: (f) => { ev?.each.push(f); return core.silence; },
    // widgets (@strudel/codemirror): the transpiler turns slider(v, min, max) into sliderWithID('slider_<pos>', v, min, max)
    // (the value in the code wins at evaluation; setSliderValue() moves it live in between)
    sliderWithID: (id, value) => {
      sliderValues.set(id, Number(unpure(value)));
      return core.ref(() => sliderValues.get(id));
    },
    slider: (value) => core.pure(Number(unpure(value))),
    // superdough sound registries — run now when the audio engine is loaded, else replayed once it is
    samples: (...args) => audioCall('samples', args),
    aliasBank: (...args) => audioCall('aliasBank', args),
    soundAlias: (...args) => audioCall('soundAlias', args),
    loadSoundfont: () => undefined,
    registerSynthSounds: () => undefined,
    registerZZFXSounds: () => undefined,
    registerSoundfonts: () => undefined,
    initAudio: () => undefined,
    initAudioOnFirstClick: () => undefined,
    // strudel.cc page helpers: never touch daW³'s own page
    backgroundImage: () => undefined,
    cleanupUi: () => undefined,
    getDrawContext: () => offscreenContext(),
    // packages daW³ doesn't ship (their functions work as no-ops)
    loadCsound: absorber(), loadCSound: absorber(), loadcsound: absorber(), loadOrc: absorber(),
    midin: () => () => core.ref(() => 0),
    sysex: () => undefined,
  });
  rebuildScope();
}

let offscreen = null;
function offscreenContext() {
  if (offscreen) return offscreen;
  if (typeof document !== 'undefined') offscreen = document.createElement('canvas').getContext('2d');
  else offscreen = absorber();
  return offscreen;
}

/** A value that accepts anything: any property, call or `new` gives itself back (hydra, csound, Tone.js mocks). */
export function absorber() {
  const target = function absorbed() {};
  const p = new Proxy(target, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : k === 'toString' ? () => '' : p),
    apply: () => p,
    construct: () => p,
  });
  return p;
}
// hydra (strudel.cc's @strudel/hydra): initHydra() makes hydra's sources/outputs global
const HYDRA_NAMES = ['initHydra', 'H', 'osc', 'shape', 'noise', 'voronoi', 'src', 'solid', 'gradient', 'render',
  'o0', 'o1', 'o2', 'o3', 's0', 's1', 's2', 's3'];
// very old tunes use note names as variables (`seq(c3, eb3)`)
const PSEUDO_NOTE = /(?<![\w$.'"`])([a-gA-G](?:#|b|s|f)?-?[0-9])(?![\w$'"`])/g;

function rebuildScope() {
  scopeNames = Object.keys(scope).filter((k) => VALID_NAME.test(k) && !RESERVED.has(k));
  scopeValues = scopeNames.map((k) => scope[k]);
}

function unpure(x) {
  if (x && x._Pattern) return x.__pure !== undefined ? x.__pure : x;
  return x;
}
function setCps(cps) {
  if (ev) ev.result.cps = Number(cps);
  return S.core.silence;
}

function audioCall(name, args) {
  args = args.map(unpure);
  // daW³ instruments (CodeInstrument) resolve custom sample maps through our own loader
  if (name === 'samples') loadSamples(args[0], args[1]);
  if (audio) return runAudioCall(name, args);
  if (typeof window !== 'undefined') pendingAudioCalls.push([name, args]);
  return undefined;
}
function runAudioCall(name, args) {
  try {
    const r = audio.superdough[name](...args);
    if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[strudel] ${name}() failed:`, e?.message || e));
    return r;
  } catch (e) {
    console.warn(`[strudel] ${name}() failed:`, e?.message || e);
    return undefined;
  }
}

/** Names user code can reference (after loadStrudel()). */
export function strudelScopeNames() { return scope ? scopeNames.slice() : []; }

// ---------------------------------------------------------------------------------- sliders

export function setSliderValue(id, value) { sliderValues.set(id, Number(value)); }
export function sliderValue(id) { return sliderValues.get(id); }

// --------------------------------------------------------------------------------- evaluation

/** Top-level labelled statements: [{ name (without a leading _), raw, muted, start, end }]. */
function topLabels(ast) {
  const out = [];
  for (const node of ast.body) {
    if (node.type !== 'LabeledStatement') continue;
    const raw = node.label.name;
    out.push({ name: raw.replace(/^_/, ''), raw, muted: raw.startsWith('_') || raw.endsWith('_'), start: node.start, end: node.end });
  }
  return out;
}

/** slider(value, min, max, step) calls — what Strudel's transpiler reports as widgets (same ids). */
function sliderWidgets(ast) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'slider' && node.arguments[0]) {
      const [v, min, max, step] = node.arguments;
      out.push({ type: 'slider', id: `slider_${v.start}`, from: v.start, to: v.end, value: v.raw ?? String(v.value), min: min?.value ?? 0, max: max?.value ?? 1, step: step?.value });
    }
    for (const k of Object.keys(node)) {
      const x = node[k];
      if (Array.isArray(x)) x.forEach(visit);
      else if (x && typeof x === 'object' && typeof x.type === 'string') visit(x);
    }
  };
  ast.body.forEach(visit);
  return out.sort((a, b) => a.from - b.from);
}

/** Removes top-level `await` (not inside functions) from generated code. */
function stripTopLevelAwait(code) {
  if (!/\bawait\b/.test(code)) return code;
  let ast;
  try { ast = S.acornParse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); } catch { return code; }
  const cuts = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (/Function/.test(node.type)) return;
    if (node.type === 'AwaitExpression') cuts.push([node.start, node.argument.start]);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
    }
  };
  ast.body.forEach(visit);
  cuts.sort((a, b) => b[0] - a[0]);
  for (const [a, b] of cuts) code = code.slice(0, a) + code.slice(b);
  return code;
}

// Double-quoted strings that are plainly not mini-notation keep being plain strings (same length, so
// every offset is kept): object keys ({"gain": .5}, obj["key"]) and the arguments of the sound-registry
// functions (samples("github:user/repo") — mini-notation would choke on the URL, in Strudel too).
const PLAIN_ARG_FNS = new Set(['samples', 'soundAlias', 'aliasBank', 'loadSoundfont', 'addVoicings', 'setSoundfontUrl']);
function plainStrings(src, ast) {
  const at = [];
  const lit = (n) => n && n.type === 'Literal' && typeof n.value === 'string' && n.raw?.[0] === '"' && !n.value.includes("'") && !n.raw.includes('\\') && at.push(n);
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Property' && !node.computed) lit(node.key);
    else if (node.type === 'MemberExpression' && node.computed) lit(node.property);
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && PLAIN_ARG_FNS.has(node.callee.name)) {
      const all = (n) => { if (!n || typeof n.type !== 'string') return; lit(n); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(all); else if (v && typeof v === 'object' && typeof v.type === 'string') all(v); } };
      node.arguments.forEach(all);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
    }
  };
  ast.body.forEach(visit);
  if (!at.length) return src;
  const chars = src.split('');
  for (const n of at) { chars[n.start] = "'"; chars[n.end - 1] = "'"; }
  return chars.join('');
}

/** Is `name` used as a plain variable (not a property / key / declaration) somewhere in the program? */
function isFreeIdentifier(ast, name) {
  let found = false;
  const visit = (node, parent, key) => {
    if (found || !node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && node.name === name) {
      const prop = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed));
      if (!prop) found = true;
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => visit(x, node, k));
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, node, k);
    }
  };
  ast.body.forEach((n) => visit(n, null, null));
  return found;
}

const errMsg = (e) => (e && e.message ? e.message : String(e));

/**
 * Evaluates Strudel code with the real engine (call after loadStrudel() resolved true).
 * Same result shape as strudel.js evaluate(): { patterns, entries: [{name, pattern, muted, block}],
 * labels: [{name, muted, start, end}], cps, error, warnings, widgets, engine: 'strudel' }.
 */
export function evaluateStrudel(source) {
  const { core, transpiler } = S;
  const result = { patterns: [], entries: [], labels: [], cps: null, error: null, warnings: [], widgets: [], engine: 'strudel' };
  let src = String(source ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = ' ' + src.slice(1); // keep offsets

  let ast;
  try {
    ast = S.acornParse(src, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
  } catch (e) {
    result.error = errMsg(e);
    return result;
  }
  if (!ast.body.length) return result; // only comments / whitespace
  src = plainStrings(src, ast);
  const labels = topLabels(ast);
  result.labels = labels.map(({ name, muted, start, end }) => ({ name, muted, start, end }));

  let out;
  try {
    let t;
    try {
      // (emitMiniLocations would re-parse every mini-notation string — the haps carry their locations anyway)
      t = transpiler.transpiler(src, { wrapAsync: false, addReturn: true, emitMiniLocations: false });
    } catch (e) {
      // Strudel insists on a final expression; code ending in a declaration still evaluates here
      // (appending after the code keeps every offset)
      if (!/without body expression/.test(errMsg(e))) throw e;
      t = transpiler.transpiler(`${src}\n;undefined\n`, { wrapAsync: false, addReturn: true, emitMiniLocations: false });
    }
    out = t.output;
    result.widgets = sliderWidgets(ast);
  } catch (e) {
    result.error = errMsg(e);
    return result;
  }
  out = stripTopLevelAwait(out);

  // unknown functions / methods -> pass-throughs (Strudel packages we don't ship: midi, hydra, osc, …)
  const unknown = findUnknownNames(src, scope, core.Pattern.prototype);
  const extraNames = [];
  const extraValues = [];
  if (/\binitHydra\b|\bH\s*\(/.test(src)) {
    for (const name of HYDRA_NAMES) { extraNames.push(name); extraValues.push(absorber()); }
    result.warnings.push('hydra visuals are not available in daW³ — ignored');
  }
  for (const name of unknown.functions) {
    if (extraNames.includes(name)) continue;
    extraNames.push(name);
    // (a plain function, so `new ToneSynth()` works too)
    extraValues.push(function unknownFunction(...args) { return args.find((a) => a instanceof core.Pattern) ?? core.silence; });
    result.warnings.push(`${name}() is not available in daW³ — ignored`);
  }
  const declared = new Set(ast.body.flatMap((n) => (n.type === 'VariableDeclaration' ? n.declarations.map((d) => d.id?.name) : [n.id?.name])));
  for (const m of src.matchAll(PSEUDO_NOTE)) {
    const name = m[1];
    if (scope[name] !== undefined || declared.has(name) || extraNames.includes(name) || !isFreeIdentifier(ast, name)) continue;
    extraNames.push(name);
    extraValues.push(name);
  }
  const addedMethods = [];
  for (const name of unknown.methods) {
    core.Pattern.prototype[name] = function passThrough() { return this; };
    addedMethods.push(name);
    result.warnings.push(`.${name}() is not available in daW³ — ignored`);
  }

  const entries = [];
  let anon = 0;
  let nextLabel = 0;
  ev = {
    result, hushed: false, all: [], each: [],
    register(pattern, id) {
      const raw = String(id);
      let block = null;
      if (nextLabel < labels.length && labels[nextLabel].raw === raw) block = nextLabel++;
      const muted = raw.startsWith('_') || raw.endsWith('_');
      const solo = !muted && raw.length > 1 && raw.startsWith('S'); // Strudel: `S$:` / `Sname:` solo
      const base = raw.replace(/^_|_$/g, '');
      const name = base.includes('$') ? `$${++anon}` : base;
      entries.push({ name, pattern, muted, block, solo });
      return muted ? core.silence : pattern;
    },
  };
  let ret;
  try {
    // a block (as Strudel's own eval does) so `const chorus = …` may shadow a Strudel name
    const fn = new Function(...scopeNames, ...extraNames, `{\n${out}\n}`);
    ret = fn(...scopeValues, ...extraValues);
  } catch (e) {
    result.error = errMsg(e);
  } finally {
    for (const name of addedMethods) delete core.Pattern.prototype[name];
  }
  const state = ev;
  ev = null;
  if (result.error) return result;
  if (ret && typeof ret.then === 'function') ret.then(() => {}, () => {});
  if (!entries.length && ret instanceof core.Pattern) entries.push({ name: 'main', pattern: ret, muted: false, block: null });
  if (state.hushed) entries.length = 0;
  if (entries.some((e) => e.solo)) for (const e of entries) if (!e.solo) e.muted = true;
  for (const e of entries) {
    delete e.solo;
    for (const f of state.each) if (typeof f === 'function') e.pattern = f(e.pattern);
    for (const f of state.all) if (typeof f === 'function') e.pattern = f(e.pattern);
    if (!(e.pattern instanceof core.Pattern)) e.pattern = core.reify(e.pattern);
  }
  // surface query-time errors now (unknown scales, bad chord names, …)
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

/** Haps of a real Strudel pattern in [b, e) (numbers). */
export function queryStrudel(pattern, b, e, cps) {
  return pattern.queryArc(b, e, cps ? { _cps: cps } : undefined);
}

// ---------------------------------------------------------------------------------- audio

let audioLoading = null;
/**
 * Loads superdough + the sound registries strudel.cc's prebake registers (synths, ZZFX, General MIDI
 * soundfonts, the default sample maps). Browser only. Resolves the strudel-audio.mjs module.
 */
export function loadStrudelAudio() {
  if (audioLoading) return audioLoading;
  audioLoading = loadStrudel().then((ok) => {
    if (!ok) throw new Error('Strudel engine unavailable');
    return import(/* @vite-ignore */ AUDIO_URL);
  }).then((mod) => {
    audio = mod;
    neutraliseVisuals(); // webaudio re-adds .scope() / .spectrum()
    // the audio package's functions become available to user code too (getAudioContext, …)
    const extra = { ...mod.webaudio, ...mod.soundfonts };
    for (const k of Object.keys(extra)) if (!(k in scope) || /^(register|get|set)/.test(k)) scope[k] = extra[k];
    Object.assign(scope, {
      samples: (...args) => audioCall('samples', args),
      aliasBank: (...args) => audioCall('aliasBank', args),
      soundAlias: (...args) => audioCall('soundAlias', args),
      loadSoundfont: (...args) => mod.soundfonts.loadSoundfont?.(...args),
    });
    rebuildScope();
    prebake(mod);
    for (const [name, args] of pendingAudioCalls.splice(0)) runAudioCall(name, args);
    return mod;
  });
  audioLoading.catch((e) => console.warn('[strudel] audio engine failed to load:', e?.message || e));
  return audioLoading;
}

const DS = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const TS = 'https://raw.githubusercontent.com/todepond/samples/main';
let prebaked = null;
/** strudel.cc's prebake: the sounds every strudel.cc tune can count on. */
function prebake(mod) {
  if (prebaked) return prebaked;
  const sd = mod.superdough;
  const soft = (p) => Promise.resolve(p).catch((e) => console.warn('[strudel] sound pack failed to load:', e?.message || e));
  prebaked = Promise.all([
    soft(mod.webaudio.registerSynthSounds?.()),
    soft(mod.webaudio.registerZZFXSounds?.()),
    soft(mod.soundfonts.registerSoundfonts?.()),
    ...['tidal-drum-machines', 'piano', 'Dirt-Samples', 'EmuSP12', 'vcsl', 'mridangam'].map((n) => soft(sd.samples(`${DS}/${n}.json`))),
  ]).then(() => soft(sd.aliasBank(`${TS}/tidal-drum-machines-alias.json`)));
  return prebaked;
}

/** Resolves once the default sound packs are registered (or failed). */
export const strudelSoundsReady = () => prebaked || Promise.resolve();
export const strudelAudio = () => audio;
