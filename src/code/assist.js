// Code assist for the Strudel editor — pure functions (no DOM), unit-tested in tests/code-assist.test.js.
//
//   codeMap(src)                        -> per-char lexical map (code / string / comment, bracket depth, matches)
//   contextAt(src, pos)                 -> what the caret is in: {kind:'method'|'top'|'string'|'none', prefix, from, to, fn, isMethod, ...}
//   buildCatalog({key, samples, dsl})   -> completion item lists (methods, top-level, sounds, banks, scales, chords, notes …)
//   completionsAt(src, pos, catalog, {recent, force}) -> {ctx, from, to, items}
//   applyCompletion(src, res, item)     -> {text, selStart, selEnd}
//   rankItems(items, prefix, {recent})  -> ranked items (prefix > case-insensitive prefix > substring > fuzzy; recent first)
//   computeDrop(src, offset, chip)      -> {text, selStart, selEnd, line, message} | null — "drag a building block onto a line"
//   paletteGroups({key, samples, bpm})  -> the "Building blocks" palette (categories of chips)
import { CODE_REFERENCE } from './docs.js';
import { SCALE_INTERVALS } from './theory.js';
import { DRUM_MACHINES, MACHINE_IDS, ALL_TDM_MACHINES, BANK_ALIASES } from '../audio/library/drum-machines.js';
import { DIRT_NAMES, VCSL_NAMES } from '../audio/library/strudel-sounds.js';
import { PRESETS } from '../audio/presets.js';
import { diatonicChords } from '../theory/keys.js';
import { scaleIntervals as theoryScaleIntervals } from '../theory/scales.js';

// ------------------------------------------------------------------------------------------------ lexing

/**
 * kind[i]: 0 code, 1 string (quotes included), 2 comment. depth[i]: bracket depth before char i.
 * strStart[i]: index of the opening quote of the string containing i (-1 outside strings).
 * match: Map open-bracket index <-> close-bracket index.
 */
export function codeMap(src) {
  const n = src.length;
  const kind = new Uint8Array(n);
  const depth = new Int16Array(n + 1);
  const strStart = new Int32Array(n).fill(-1);
  const match = new Map();
  const stack = [];
  let i = 0, d = 0;
  while (i < n) {
    depth[i] = d;
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let e = src.indexOf('\n', i); if (e < 0) e = n;
      for (let k = i; k < e; k++) { kind[k] = 2; depth[k] = d; }
      i = e; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
      for (let k = i; k < e; k++) { kind[k] = 2; depth[k] = d; }
      i = e; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      const e = j < n && src[j] === c ? j + 1 : j;
      for (let k = i; k < e; k++) { kind[k] = 1; depth[k] = d; strStart[k] = i; }
      i = e; continue;
    }
    if (c === '(' || c === '[' || c === '{') { stack.push(i); d++; }
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.length) { const o = stack.pop(); match.set(o, i); match.set(i, o); }
      d = Math.max(0, d - 1);
    }
    i++;
  }
  depth[n] = d;
  return { src, kind, depth, strStart, match };
}

const isOpen = (c) => c === '(' || c === '[' || c === '{';
const lineStartOf = (src, p) => src.lastIndexOf('\n', p - 1) + 1;
const lineEndOf = (src, p) => { const e = src.indexOf('\n', p); return e < 0 ? src.length : e; };
const lineIndex = (src, p) => { let n = 0; for (let i = src.indexOf('\n'); i >= 0 && i < p; i = src.indexOf('\n', i + 1)) n++; return n; };

/** Index of the innermost bracket enclosing position p (code only), or -1. */
export function enclosingOpen(map, p) {
  const { src, kind, depth } = map;
  const D = depth[Math.min(p, src.length)];
  if (D <= 0) return -1;
  for (let q = Math.min(p, src.length) - 1; q >= 0; q--) {
    if (kind[q] === 0 && isOpen(src[q]) && depth[q] === D - 1) return q;
  }
  return -1;
}

/** Name of the function called with the bracket at q: { fn, isMethod, nameStart } (fn null if not a call). */
export function callInfo(map, q) {
  const { src } = map;
  if (q < 0 || src[q] !== '(') return { fn: null, isMethod: false, nameStart: q };
  let k = q - 1;
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--;
  const m = /[A-Za-z_$][\w$]*$/.exec(src.slice(Math.max(0, k - 63), k + 1));
  if (!m) return { fn: null, isMethod: false, nameStart: q };
  const nameStart = k + 1 - m[0].length;
  let b = nameStart - 1;
  while (b >= 0 && /\s/.test(src[b])) b--;
  return { fn: m[0], isMethod: src[b] === '.', nameStart };
}

/** The string literal containing caret position pos (between its quotes), or null. */
function stringAt(map, pos) {
  const { src, kind, strStart } = map;
  if (pos <= 0) return null;
  const s = strStart[pos - 1];
  if (s < 0 || kind[pos - 1] !== 1) return null;
  let e = pos - 1;
  while (e < src.length && strStart[e] === s) e++;
  const closed = e - 1 > s && src[e - 1] === src[s];
  if (pos < e || !closed) return { start: s, end: e, closed, quote: src[s], innerEnd: closed ? e - 1 : e };
  return null;
}

// ------------------------------------------------------------------------------------------------ caret context

const MINI_WORD = /[^\s"'`[\]<>{}(),*!?@%|~;/]*$/;
const MINI_WORD_FWD = /^[^\s"'`[\]<>{}(),*!?@%|~;/]*/;

/**
 * Context at the caret.
 *  kind 'string': inside a string literal; fn = function the string is a direct argument of (s, note, bank …),
 *                 isMethod = called as `.fn("…")`. prefix = the mini-notation word before the caret.
 *  kind 'method': after a `.` (pattern method / control).
 *  kind 'top':    an expression position (statement start or a function argument); atStart = statement start.
 *  kind 'none':   inside a comment or after a number.
 */
export function contextAt(src, pos, map = codeMap(src)) {
  pos = Math.max(0, Math.min(pos, src.length));
  const { kind } = map;
  if (pos > 0 && kind[pos - 1] === 2 && src[pos - 1] !== '\n') {
    // inside a // comment (or before the end of a /* */ comment)
    const blockEnd = src.slice(Math.max(0, pos - 2), pos) === '*/';
    if (!blockEnd) return { kind: 'none', prefix: '', from: pos, to: pos };
  }
  const str = stringAt(map, pos);
  if (str) {
    const q = enclosingOpen(map, str.start);
    const { fn, isMethod } = q >= 0 && map.depth[str.start] === map.depth[q] + 1 ? callInfo(map, q) : { fn: null, isMethod: false };
    const before = src.slice(str.start + 1, pos);
    const prefix = MINI_WORD.exec(before)[0];
    const after = MINI_WORD_FWD.exec(src.slice(pos, str.innerEnd))[0];
    return { kind: 'string', fn, isMethod, prefix, from: pos - prefix.length, to: pos + after.length, str };
  }
  const ls = lineStartOf(src, pos);
  const lineBefore = src.slice(ls, pos);
  const idm = /[A-Za-z_$][\w$]*$/.exec(lineBefore);
  const prefix = idm ? idm[0] : '';
  const from = pos - prefix.length;
  const afterM = /^[\w$]*/.exec(src.slice(pos))[0];
  const to = pos + afterM.length;
  if (/\d$/.test(src.slice(Math.max(0, from - 1), from)) && !prefix) return { kind: 'none', prefix: '', from, to };
  if (from > 0 && /[\d]/.test(src[from - 1]) && prefix) return { kind: 'none', prefix, from, to }; // 1e3, 0x…
  // previous significant char (skip whitespace incl. newlines, chains can span lines)
  let b = from - 1;
  while (b >= 0 && (/\s/.test(src[b]) || kind[b] === 2)) b--;
  if (b >= 0 && src[b] === '.' && kind[b] === 0) {
    // `.` after an identifier, a call, a string or a bracket = method; `(.5` / `0.` = a number being typed
    let c = b - 1;
    while (c >= 0 && /\s/.test(src[c])) c--;
    if (c < 0 || !/[\w$)\]"'`]/.test(src[c])) return { kind: 'none', prefix, from, to };
    if (/[\w$]/.test(src[c])) {
      const tok = /[\w$]*$/.exec(src.slice(Math.max(0, c - 63), c + 1))[0];
      if (/^\d/.test(tok)) return { kind: 'none', prefix, from, to };
    }
    return { kind: 'method', prefix, from, to, dot: b };
  }
  const q = enclosingOpen(map, from);
  const { fn, isMethod } = q >= 0 ? callInfo(map, q) : { fn: null, isMethod: false };
  const atStart = map.depth[from] === 0 && /^\s*(?:(?:\$|[A-Za-z_]\w*):\s*)?$/.test(src.slice(ls, from)) && !/^\s*\/\//.test(lineBefore);
  // `foo: ` label? `$` alone at statement start is the beginning of `$:`
  return { kind: 'top', prefix, from, to, atStart, argOf: fn, argOfMethod: isMethod };
}

// ------------------------------------------------------------------------------------------------ catalog

const METHOD_CATS = new Set(['Controls', 'Time', 'Conditional', 'Structure', 'Arithmetic', 'Tonal']);
const TOP_CATS = new Set(['Constructors', 'Signals', 'Global', 'Mini-notation']);
const TOP_CONTROLS = new Set(['s', 'note', 'n', 'freq', 'chord']);
const NOT_TOP_GLOBAL = new Set(['pianoroll', 'p']);
export const CONSTRUCTORS = new Set(['stack', 'cat', 'seq', 'sequence', 'fastcat', 'slowcat', 'timeCat', 'timecat', 'arrange', 'polymeter', 'polyrhythm', 'chooseCycles', 'randcat', 'layer', 'superimpose']);
export const DRUM_NAMES = [
  ['bd', 'Bass drum (kick)'], ['sd', 'Snare drum'], ['hh', 'Closed hi-hat'], ['oh', 'Open hi-hat'], ['cp', 'Clap'],
  ['rim', 'Rim shot'], ['lt', 'Low tom'], ['mt', 'Mid tom'], ['ht', 'High tom'], ['cr', 'Crash cymbal'], ['rd', 'Ride cymbal'],
  ['cb', 'Cowbell'], ['sh', 'Shaker'], ['tb', 'Tambourine'], ['perc', 'Percussion'],
];
export const WAVEFORMS = [
  ['sawtooth', 'Saw wave synth — bright, buzzy (basses, leads)'], ['square', 'Square wave synth — hollow, 8-bit'],
  ['triangle', 'Triangle wave synth — soft, flute-like'], ['sine', 'Sine wave synth — pure, sub bass'],
  ['supersaw', 'Detuned saw stack — trance / EDM leads and pads'], ['piano', 'Sampled grand piano'],
];
export const MINI_OPS = [
  { label: '*2', insert: '*2', sel: [1, 2], desc: 'Speed up: play the step 2× in its slot (bd*4 = four kicks).' },
  { label: '/2', insert: '/2', sel: [1, 2], desc: 'Slow down: the step spans 2 cycles.' },
  { label: '!2', insert: '!2', sel: [1, 2], desc: 'Replicate: repeat the step 2× (each gets its own slot).' },
  { label: '<a b>', insert: '<>', sel: [1, 1], desc: 'Alternate: play one item per cycle.' },
  { label: '[a b]', insert: '[]', sel: [1, 1], desc: 'Sub-sequence: squeeze several steps into one slot.' },
  { label: '~', insert: '~', desc: 'Rest (silence for one step).' },
  { label: '?', insert: '?', desc: 'Randomly drop the step (50%).' },
  { label: '(3,8)', insert: '(3,8)', sel: [1, 4], desc: 'Euclidean rhythm: 3 hits spread over 8 steps.' },
  { label: '@2', insert: '@2', sel: [1, 2], desc: 'Stretch: the step takes 2 slots.' },
  { label: ', layer', insert: ', ', desc: 'Stack layers: "bd*4, hh*8" plays both at once.' },
  { label: '| choice', insert: ' | ', desc: 'Random choice between alternatives each cycle.' },
  { label: ':2', insert: ':2', sel: [1, 2], desc: 'Sample number: bd:2 picks the third bd sample.' },
];

const PITCH = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const pcName = (pc) => PITCH[((pc % 12) + 12) % 12];
const scaleKey = (s) => String(s || 'minor').replace(/-/g, ' ');
/** Project key -> Strudel scale name ("C:minor", "F#:minor:pentatonic"). */
export function strudelScaleName(key = {}, octave) {
  const root = pcName(key.root ?? 0) + (octave != null ? octave : '');
  let sc = scaleKey(key.scale);
  if (sc === 'minor pentatonic' || sc === 'major pentatonic') sc = sc.split(' ').join(':');
  else if (!SCALE_INTERVALS[sc]) sc = /minor|aeolian|dorian|phrygian/.test(sc) ? 'minor' : 'major';
  return `${root}:${sc.replace(/ /g, ':')}`;
}
/** Chord symbol in Strudel style (maj7 -> ^7). */
const strudelChord = (name) => String(name).replace(/maj7/, '^7').replace(/maj9/, '^9');

function keyIntervals(key = {}) {
  try { return theoryScaleIntervals(key.scale || 'minor') || [0, 2, 3, 5, 7, 8, 10]; } catch { return [0, 2, 3, 5, 7, 8, 10]; }
}
function keyProgression(key = {}) {
  const minor = /minor|aeolian|dorian|phrygian|locrian|blues/.test(String(key.scale || 'minor')) && !/major/.test(String(key.scale));
  const degrees = minor ? [0, 5, 2, 6] : [0, 3, 5, 4];
  try {
    const ch = diatonicChords(key.root ?? 0, minor ? 'minor' : 'major', { sevenths: true });
    return degrees.map((d) => strudelChord(ch[d].name));
  } catch { return minor ? ['Cm7', 'Ab^7', 'Eb^7', 'Bb7'] : ['C^7', 'F^7', 'Am7', 'G7']; }
}

/** Argument the snippet for `name` starts with (selected after insertion). */
const DEFAULT_ARGS = {
  s: '"bd*4"', sound: '"bd*4"', note: '"c3 e3 g3"', n: '"0 2 4"', chord: '"<Am7 Dm7 G7 C^7>"', freq: '220',
  lpf: '800', cutoff: '800', hpf: '400', hcutoff: '400', bpf: '1000', lpq: '8', resonance: '8', hpq: '4',
  room: '.4', size: '.8', delay: '.3', delaytime: '.25', delayfeedback: '.5', gain: '.8', velocity: '.8', pan: '.5',
  shape: '.4', crush: '6', coarse: '6', distort: '1', attack: '.05', decay: '.2', sustain: '.5', release: '.4',
  fast: '2', slow: '2', ply: '2', iter: '4', early: '.25', late: '.125', segment: '8', degradeBy: '.3',
  euclid: '3, 8', euclidRot: '3, 8, 2', struct: '"x ~ x x"', mask: '"1 0 1 1"', bank: '"RolandTR909"',
  scale: '"C:minor"', transpose: '12', add: '12', sub: '12', arp: '"0 1 2 1"', vowel: '"a"', speed: '2',
  legato: '.5', clip: '.5', lpenv: '4', unison: '5', detune: '.2', fm: '2', vib: '4', orbit: '1', cut: '1',
  setcpm: '120/4', setcps: '.5', setbpm: '120', samples: "'github:tidalcycles/dirt-samples'", swingBy: '1/3, 4',
  every: '4, x => x.fast(2)', sometimes: 'x => x.speed(2)', off: '1/8, x => x.add(12)', jux: 'rev',
  stack: 's("bd*4"), s("hh*8")', cat: 's("bd*4"), s("bd*2 sd")', arrange: '[4, s("bd*4")], [4, s("bd*4, hh*8")]',
  slider: '0.5, 0, 1', range: '200, 2000', run: '8', irand: '8', pure: '"c3"',
};
const NO_ARG = new Set(['rev', 'palindrome', 'brak', 'voicing', 'arpeggiate', 'round', 'floor', 'ceil', 'degrade', 'hush', 'pianoroll', 'punchcard']);

/** Extract the argument text of `name(` from an example. */
function exampleArg(example, name, isMethod) {
  if (!example) return null;
  const re = new RegExp(`${isMethod ? '\\.' : '(?:^|[^\\w$.])'}${name.replace(/\$/g, '\\$')}\\(`, 'g');
  const m = re.exec(example);
  if (!m) return null;
  let i = m.index + m[0].length, d = 1, q = null;
  for (let j = i; j < example.length; j++) {
    const c = example[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { d--; if (!d) return example.slice(i, j); }
  }
  return null;
}

/** Snippet for a function completion: {text, sel:[a,b]} (sel relative to text). */
export function functionSnippet(name, entry, isMethod, ctxOpts = {}) {
  if (name === '$:') return { text: '$: s("bd*4")', sel: [7, 11] };
  if (entry && entry.signature && !entry.signature.includes('(') && entry.category === 'Signals') return { text: name, sel: [name.length, name.length] };
  if (name === 'silence') return { text: name, sel: [name.length, name.length] };
  if (NO_ARG.has(name)) return { text: `${name}()`, sel: [name.length + 2, name.length + 2] };
  let arg = DEFAULT_ARGS[name];
  if (name === 'scale' && ctxOpts.key) arg = `"${strudelScaleName(ctxOpts.key)}"`;
  if (arg == null && entry) arg = exampleArg(entry.example, name, isMethod) ?? exampleArg(entry.example, name, !isMethod);
  if (arg == null && entry?.signature) {
    const m = /\(([^)]*)\)/.exec(entry.signature);
    if (m && /^(-?[\d.]+|"[^"]*"|'[^']*')$/.test(m[1].trim())) arg = m[1].trim();
  }
  if (arg == null) arg = '';
  const text = `${name}(${arg})`;
  const a = name.length + 1;
  if (/^(["'`]).*\1$/.test(arg)) return { text, sel: [a + 1, a + arg.length - 1] };
  const comma = arg.indexOf(',');
  if (comma > 0 && /^[\d./ -]+$/.test(arg.slice(0, comma))) return { text, sel: [a, a + comma] };
  return { text, sel: [a, a + arg.length] };
}

const docOf = new Map();
for (const r of CODE_REFERENCE) {
  docOf.set(r.name, r);
  for (const a of r.aliases || []) if (!docOf.has(a)) docOf.set(a, { ...r, aliasOf: r.name });
}
export const referenceFor = (name) => docOf.get(name) || null;

function refItems(filter, kind) {
  const out = [];
  for (const r of CODE_REFERENCE) {
    if (!filter(r)) continue;
    const names = [r.name, ...(r.aliases || [])];
    for (const nm of names) {
      if (!/^[A-Za-z_$][\w$]*$/.test(nm) && nm !== '$:') continue;
      const primary = nm === r.name;
      // the name used in the signature (lpf for 'cutoff') is the one people type
      const sigName = (r.signature || '').replace(/^pat\./, '').split('(')[0];
      out.push({
        label: nm, kind, entry: r, detail: r.signature, desc: r.description + (primary ? '' : ` (alias of ${r.name})`),
        example: r.example, boost: (nm === sigName ? 60 : primary ? 40 : 0) + (nm.startsWith('_') ? -100 : 0),
      });
    }
  }
  return out;
}

/**
 * Catalog of completion items. opts: { key: {root, scale}, samples: [names], dsl: [names] (dslNames()), consts }
 */
export function buildCatalog(opts = {}) {
  const key = opts.key || { root: 0, scale: 'minor' };
  const dsl = opts.dsl || [];
  const methods = refItems((r) => METHOD_CATS.has(r.category) || (r.category === 'Global' && NOT_TOP_GLOBAL.has(r.name)), 'method')
    .filter((it) => it.label !== 'chord');
  const top = [
    ...refItems((r) => (TOP_CATS.has(r.category) && !NOT_TOP_GLOBAL.has(r.name) && r.name !== 'mini') || (r.category === 'Controls' && TOP_CONTROLS.has(r.name)) || r.name === 'chord', 'function'),
    { label: 'slider', kind: 'function', detail: 'slider(value, min, max, step?)', desc: 'A live slider widget in the editor: drag it to change the value while the pattern plays.', example: 'note("c2*8").s("sawtooth").lpf(slider(800, 100, 4000))', boost: 30 },
    { label: 'const', kind: 'keyword', detail: 'const name = pattern', desc: 'Name a pattern so you can reuse it (e.g. inside stack or arrange).', example: 'const drums = s("bd*4, ~ cp")\n$: drums', boost: 10, snippet: { text: 'const name = s("bd*4")', sel: [6, 10] } },
  ];
  // functions of the loaded prebake helper libraries (parsePrebakeDocs), listed with their source
  for (const d of opts.prebake || []) {
    const isMethod = d.kind === 'method';
    const arg = prebakeArgs(d);
    const text = `${d.name}(${arg})`;
    const item = {
      label: d.name, kind: isMethod ? 'method' : 'function', detail: d.signature,
      desc: `${d.desc ? `${d.desc} ` : ''}(prebake: ${d.source || 'helper library'})`, example: d.example || undefined,
      entry: { name: d.name, signature: d.signature, example: d.example || '', description: d.desc, category: 'Prebake' },
      snippet: { text, sel: [d.name.length + 1, d.name.length + 1 + arg.length] }, boost: 45, prebake: d.source || true,
    };
    (isMethod ? methods : top).push(item);
  }
  const known = new Set([...methods, ...top].map((i) => i.label));
  for (const nm of dsl) {
    if (known.has(nm) || !/^[A-Za-z][\w$]*$/.test(nm)) continue;
    known.add(nm);
    methods.push({ label: nm, kind: 'method', detail: `.${nm}(…)`, desc: '', boost: -30 });
    top.push({ label: nm, kind: 'function', detail: `${nm}(…)`, desc: '', boost: -60 });
  }
  const drums = DRUM_NAMES.map(([n, d]) => ({ label: n, kind: 'sound', desc: d, detail: 'drum', boost: 100 }));
  const waves = WAVEFORMS.map(([n, d]) => ({ label: n, kind: 'sound', desc: d, detail: 'synth', boost: 70 }));
  const presets = Object.entries(PRESETS).map(([id, p]) => ({ label: id, kind: 'preset', desc: `${p.name} — daW³ ${String(p.category || '').toLowerCase()} preset`, detail: 'preset', boost: 30 }));
  const dirt = [...DIRT_NAMES].filter((n) => !DRUM_NAMES.some(([d]) => d === n)).map((n) => ({ label: n, kind: 'sound', desc: 'Dirt-Samples sample set', detail: 'sample', boost: 0 }));
  const vcsl = [...VCSL_NAMES].map((n) => ({ label: n, kind: 'sound', desc: 'VCSL (CC0) instrument sample', detail: 'sample', boost: -5 }));
  const project = (opts.samples || []).filter(Boolean).map((n) => ({ label: String(n), kind: 'sound', desc: 'Sample in this project', detail: 'project', boost: 90 }));
  const bankNames = new Set([...MACHINE_IDS, ...ALL_TDM_MACHINES, ...Object.values(BANK_ALIASES)]);
  const banks = [...bankNames].map((b) => ({ label: b, kind: 'bank', desc: DRUM_MACHINES[b] ? `${DRUM_MACHINES[b].name} (${DRUM_MACHINES[b].year}) — ${DRUM_MACHINES[b].description}` : 'Drum machine bank', detail: 'bank', boost: DRUM_MACHINES[b] ? 50 : 0 }));
  const keyRoot = pcName(key.root ?? 0);
  const keyScale = strudelScaleName(key).split(':').slice(1).join(':');
  const scaleNames = Object.keys(SCALE_INTERVALS).map((s) => s.replace(/ /g, ':'));
  const scales = [];
  for (const r of PITCH) for (const s of scaleNames) {
    const inKey = r === keyRoot;
    scales.push({ label: `${r}:${s}`, kind: 'scale', desc: `${r} ${s.replace(/:/g, ' ')} scale${inKey && s === keyScale ? ' — the project key' : ''}`, detail: 'scale', boost: (inKey ? 60 : 0) + (s === keyScale ? 40 : 0) + (['major', 'minor', 'dorian', 'minor:pentatonic', 'major:pentatonic'].includes(s) ? 20 : 0) });
  }
  const prog = keyProgression(key);
  const chordSet = new Set();
  const chords = [];
  const addChord = (c, desc, boost) => { if (chordSet.has(c)) return; chordSet.add(c); chords.push({ label: c, kind: 'chord', desc, detail: 'chord', boost }); };
  try {
    const minor = /minor|aeolian|dorian|phrygian/.test(String(key.scale || 'minor'));
    for (const c of diatonicChords(key.root ?? 0, minor ? 'minor' : 'major', { sevenths: true })) addChord(strudelChord(c.name), `${c.roman} — in the project key`, 80);
    for (const c of diatonicChords(key.root ?? 0, minor ? 'minor' : 'major')) addChord(strudelChord(c.name), `${c.roman} — in the project key`, 75);
  } catch { /* ignore */ }
  for (const p of prog) addChord(p, 'in the project key', 80);
  const TYPES = [['', 'major'], ['m', 'minor'], ['7', 'dominant 7th'], ['^7', 'major 7th'], ['m7', 'minor 7th'], ['dim', 'diminished'], ['m7b5', 'half-diminished'], ['sus4', 'suspended 4th'], ['sus2', 'suspended 2nd'], ['6', 'major 6th'], ['9', 'dominant 9th'], ['m9', 'minor 9th'], ['add9', 'add 9'], ['aug', 'augmented']];
  for (const r of PITCH) for (const [t, d] of TYPES) addChord(r + t, `${r} ${d}`, 0);
  const iv = keyIntervals(key);
  const notes = [];
  for (let oct = 1; oct <= 5; oct++) for (const i of iv) {
    const pc = ((key.root ?? 0) + i) % 12;
    const o = oct + Math.floor(((key.root ?? 0) + i) / 12);
    notes.push({ label: pcName(pc).toLowerCase() + o, kind: 'note', desc: `${pcName(pc)}${o} — in the project key`, detail: 'note', boost: (o === 3 ? 30 : o === 2 || o === 4 ? 20 : 0) });
  }
  const degrees = iv.map((_, i) => ({ label: String(i), kind: 'note', desc: `Scale degree ${i} (${pcName(((key.root ?? 0) + iv[i]) % 12)}) — use with .scale()`, detail: 'degree', boost: 10 - i }));
  const vowels = ['a', 'e', 'i', 'o', 'u'].map((v) => ({ label: v, kind: 'value', desc: `Vowel "${v}" formant`, boost: 0 }));
  const minis = MINI_OPS.map((m) => ({ ...m, kind: 'mini', detail: 'mini-notation', boost: -200 }));
  return { methods, top, drums, waves, presets, dirt, vcsl, project, banks, scales, chords, notes, degrees, vowels, minis, key, consts: opts.consts || [] };
}

/** Argument text for a prebake function: from its @example, else its parameters' defaults (`.5` for the others). */
export function prebakeArgs(d) {
  const ex = exampleArg(d.example, d.name, d.kind === 'method') ?? exampleArg(d.example, d.name, d.kind !== 'method');
  if (ex != null) return ex;
  const ps = (d.params || []).filter((p) => !/^\.\.\./.test(p));
  if (!ps.length) return '';
  const vals = ps.map((p) => (/=/.test(p) ? p.split('=').slice(1).join('=').trim() : null));
  // trailing parameters with defaults are left out
  let n = vals.length;
  while (n > 0 && vals[n - 1] !== null) n--;
  return vals.slice(0, n).map((v) => v ?? '.5').join(', ');
}

/** `const`/`let` names declared in the source (and `name:` labels). */
export function userNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return [...out];
}

// ------------------------------------------------------------------------------------------------ ranking

function fuzzyScore(label, prefix) {
  const l = label.toLowerCase(), p = prefix.toLowerCase();
  let j = 0, gaps = 0, last = -1;
  for (let i = 0; i < l.length && j < p.length; i++) {
    if (l[i] === p[j]) { if (last >= 0) gaps += i - last - 1; last = i; j++; }
  }
  return j === p.length ? gaps : -1;
}

/** Rank items for a prefix: exact-case prefix > any-case prefix > substring > fuzzy subsequence; recent and boosted items first. */
export function rankItems(items, prefix = '', { recent = [], limit = 60 } = {}) {
  const rIdx = new Map(recent.map((r, i) => [r, i]));
  const scored = [];
  const lp = prefix.toLowerCase();
  for (const it of items) {
    const label = it.label;
    let s;
    if (!prefix) s = 0;
    else if (label.startsWith(prefix)) s = 3000 - label.length;
    else if (label.toLowerCase().startsWith(lp)) s = 2600 - label.length;
    else if (label.toLowerCase().includes(lp)) s = 1600 - label.length;
    else {
      const g = fuzzyScore(label, prefix);
      if (g < 0 || prefix.length < 2) continue;
      s = 1000 - g * 10 - label.length;
    }
    if (rIdx.has(label)) s += 300 - rIdx.get(label) * 5;
    s += it.boost || 0;
    scored.push([s, it]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label));
  const seen = new Set();
  const out = [];
  for (const [, it] of scored) {
    const k = it.kind + ':' + it.label;
    if (seen.has(k)) continue;
    seen.add(k); out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/** Candidate items for a context (before ranking). */
export function itemsForContext(ctx, cat, src = '') {
  if (ctx.kind === 'method') return cat.methods;
  if (ctx.kind === 'top') {
    const consts = userNames(src).map((n) => ({ label: n, kind: 'const', desc: 'Declared in this code', detail: 'const', boost: 150 }));
    const items = [...consts, ...cat.top];
    if (ctx.atStart) items.push({ label: '$:', kind: 'function', entry: referenceFor('$:'), detail: '$: pattern', desc: 'Start a new pattern block (plays in parallel with the others).', boost: 100, snippet: functionSnippet('$:') });
    return items;
  }
  if (ctx.kind !== 'string') return [];
  const fn = ctx.fn;
  const minis = cat.minis;
  switch (fn) {
    case 's': case 'sound': {
      if (ctx.isMethod) {
        const map = codeMap(src);
        const span = expressionAt(map, ctx.from);
        const melodic = !!span && !!headCall(map, span, ['note', 'n', 'chord', 'freq']);
        const boost = (arr, b) => arr.map((x) => ({ ...x, boost: (x.boost || 0) + b }));
        return melodic ? [...boost(cat.waves, 120), ...boost(cat.presets, 110), ...cat.project, ...cat.drums, ...cat.dirt, ...cat.vcsl, ...minis]
          : [...cat.drums, ...boost(cat.waves, 20), ...cat.presets, ...cat.project, ...cat.dirt, ...cat.vcsl, ...minis];
      }
      return [...cat.drums, ...cat.project, ...cat.waves, ...cat.presets, ...cat.dirt, ...cat.vcsl, ...minis];
    }
    case 'bank': return cat.banks;
    case 'scale': {
      const m = /^([A-Ga-g][#b]?\d?):/.exec(ctx.prefix);
      if (m) {
        // root typed: offer every scale on that root
        const root = m[1];
        const names = Object.keys(SCALE_INTERVALS).map((s) => s.replace(/ /g, ':'));
        return names.map((s) => ({ label: `${root}:${s}`, kind: 'scale', desc: `${root} ${s.replace(/:/g, ' ')} scale`, boost: ['major', 'minor'].includes(s) ? 20 : 0 }));
      }
      return cat.scales;
    }
    case 'chord': return [...cat.chords, ...minis];
    case 'note': return [...cat.notes, ...minis];
    case 'n': return [...cat.degrees, ...minis];
    case 'vowel': return cat.vowels;
    default: return minis;
  }
}

/**
 * Completions at pos. opts.force (Ctrl+Space) also lists items for an empty prefix.
 * -> { ctx, from, to, items } (items empty when nothing fits)
 */
export function completionsAt(src, pos, cat, opts = {}) {
  const ctx = contextAt(src, pos);
  const res = { ctx, from: ctx.from, to: ctx.to, items: [] };
  if (ctx.kind === 'none') return res;
  if (!opts.force && !ctx.prefix && ctx.kind !== 'method') return res;
  let items = itemsForContext(ctx, cat, src);
  if (ctx.kind === 'string' && ctx.prefix) items = items.filter((i) => i.kind !== 'mini');
  else if (ctx.kind === 'string') items = items.map((i) => (i.kind === 'mini' ? { ...i, boost: 500 } : i)); // Ctrl+Space on a gap: operators first
  res.items = rankItems(items, ctx.prefix, { recent: opts.recent, limit: opts.limit || 60 });
  // a lone exact match that's already typed in full adds nothing (strings / values)
  if (!opts.force && res.items.length === 1 && res.items[0].label === ctx.prefix && ctx.kind === 'string') res.items = [];
  return res;
}

/** Text after accepting item: { text, selStart, selEnd }. */
export function applyCompletion(src, res, item, opts = {}) {
  const { from, to, ctx } = res;
  let ins, selA, selB;
  if (item.kind === 'mini') {
    ins = item.insert;
    selA = item.sel ? item.sel[0] : ins.length; selB = item.sel ? item.sel[1] : ins.length;
  } else if (ctx.kind === 'string' || ['sound', 'preset', 'bank', 'scale', 'chord', 'note', 'value'].includes(item.kind)) {
    ins = item.insert ?? item.label;
    selA = selB = ins.length;
  } else {
    const nextIsParen = /^\s*\(/.test(src.slice(to));
    if (item.snippet) { ins = item.snippet.text; [selA, selB] = item.snippet.sel; }
    else if (item.kind === 'const' || nextIsParen) { ins = item.label; selA = selB = ins.length; }
    else {
      const sn = functionSnippet(item.label, item.entry || referenceFor(item.label), ctx.kind === 'method', opts);
      ins = sn.text; [selA, selB] = sn.sel;
    }
  }
  const text = src.slice(0, from) + ins + src.slice(to);
  return { text, selStart: from + selA, selEnd: from + selB, inserted: ins };
}

// ------------------------------------------------------------------------------------------------ statements & expressions

const CONT_END = /[,(+\-*/=&|?:[{.]$/;

/** Top-level statements: [{start, end}] (start = first code char, end = after the last code char). */
export function statementSpans(map) {
  const { src, kind, depth } = map;
  const out = [];
  let cur = null;
  let ls = 0;
  while (ls <= src.length) {
    let le = src.indexOf('\n', ls); if (le < 0) le = src.length;
    let fc = -1, lc = -1;
    for (let k = ls; k < le; k++) {
      if (kind[k] === 2 || /\s/.test(src[k])) continue;
      if (fc < 0) fc = k;
      lc = k;
    }
    if (fc >= 0) {
      const prevEnd = cur ? src[cur.end - 1] : '';
      const cont = cur && (depth[cur.end] > 0 || (kind[cur.end - 1] === 0 && CONT_END.test(prevEnd)) || src[fc] === '.' || depth[fc] > 0);
      if (!cont || prevEnd === ';') { cur = { start: fc, end: lc + 1 }; out.push(cur); }
      else cur.end = lc + 1;
    }
    if (le >= src.length) break;
    ls = le + 1;
  }
  return out;
}

/** Span of the comma-separated argument of the bracket q that contains p: {start, end} or null. */
function argSpan(map, q, p) {
  const { src, kind, depth, match } = map;
  const close = match.get(q) ?? src.length;
  const D = depth[q] + 1;
  let a = q + 1;
  for (let k = q + 1; k < close; k++) {
    if (kind[k] === 0 && src[k] === ',' && depth[k] === D) {
      if (p <= k) return trimSpan(map, a, k);
      a = k + 1;
    }
  }
  return trimSpan(map, a, close);
}
function trimSpan(map, a, b) {
  const { src, kind } = map;
  while (a < b && (kind[a] === 2 || /\s/.test(src[a]))) a++;
  while (b > a && (kind[b - 1] === 2 || /\s/.test(src[b - 1]))) b--;
  return a < b ? { start: a, end: b } : null;
}

/**
 * The pattern expression a dropped method should attach to: the argument of the innermost
 * constructor (stack / cat / arrange …) containing p, else the whole top-level statement.
 * -> {start, end, depth, inConstructor, q}
 */
export function expressionAt(map, p) {
  const { src, depth, match } = map;
  for (let q = enclosingOpen(map, p); q >= 0; q = enclosingOpen(map, q)) {
    if (src[q] !== '(') continue;
    const { fn, isMethod } = callInfo(map, q);
    if (!fn || isMethod || !CONSTRUCTORS.has(fn)) continue;
    let sp = argSpan(map, q, p);
    if (!sp) return null;
    // arrange([4, pat]) / timeCat([1, pat]): the pattern is the last element of the pair
    if (src[sp.start] === '[' && match.get(sp.start) === sp.end - 1) {
      const inner = argSpan(map, sp.start, sp.end - 2);
      if (inner) sp = inner;
    }
    return { ...sp, depth: depth[sp.start], inConstructor: true, q, fn };
  }
  const st = statementSpans(map).find((s) => p >= s.start && p <= s.end) || statementSpans(map).filter((s) => s.start <= p).pop();
  if (!st) return null;
  // skip a `$:` / `name:` label at the start
  let start = st.start;
  const lm = /^(?:_?\$|[A-Za-z_]\w*):(?!:)\s*/.exec(src.slice(start, st.end));
  if (lm) start += lm[0].length;
  // `const x = …` -> the value
  const cm = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*/.exec(src.slice(start, st.end));
  if (cm) start += cm[0].length;
  return { start, end: st.end, depth: depth[start], inConstructor: false };
}

/** Calls `.name(` chained directly on the expression (not nested): [{dot, open, close, fn}] */
function chainCalls(map, span) {
  const { src, kind, depth, match } = map;
  const out = [];
  const re = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  const text = src.slice(span.start, span.end);
  let m;
  while ((m = re.exec(text))) {
    const dot = span.start + m.index;
    if (kind[dot] !== 0 || depth[dot] !== span.depth) continue;
    const open = dot + m[0].length - 1;
    out.push({ dot, open, close: match.get(open) ?? span.end, fn: m[1] });
  }
  return out;
}

/** Direct call `name(` at the head of / inside the expression (top level, not a method): the first match. */
function headCall(map, span, names) {
  const { src, kind, match } = map;
  const re = new RegExp(`(^|[^\\w$.])(${names.join('|')})\\s*\\(`, 'g');
  const text = src.slice(span.start, span.end);
  let m;
  while ((m = re.exec(text))) {
    const at = span.start + m.index + m[1].length;
    if (kind[at] !== 0) continue;
    const open = at + m[0].length - m[1].length - 1;
    return { at, open, close: match.get(open) ?? span.end, fn: m[2] };
  }
  return null;
}

function firstCode(map, ls, le) {
  for (let k = ls; k < le; k++) if (map.kind[k] !== 2 && !/\s/.test(map.src[k])) return k;
  return -1;
}
function lastCode(map, ls, le) {
  for (let k = le - 1; k >= ls; k--) if (map.kind[k] !== 2 && !/\s/.test(map.src[k])) return k;
  return -1;
}

/** Where on the line a drop lands: the offset itself if it's on code, else the line's first code char (-1 = blank line). */
export function dropPoint(map, offset) {
  const { src } = map;
  const ls = lineStartOf(src, offset), le = lineEndOf(src, offset);
  const fc = firstCode(map, ls, le), lc = lastCode(map, ls, le);
  if (fc < 0) return { p: -1, ls, le };
  if (offset >= fc && offset <= lc && map.kind[offset] !== 2) return { p: offset, ls, le };
  return { p: fc, ls, le };
}

const quoteVal = (v) => `"${v}"`;
function result(src, from, to, ins, selA, selB, message) {
  const text = src.slice(0, from) + ins + src.slice(to);
  const a = from + (selA ?? ins.length), b = from + (selB ?? selA ?? ins.length);
  return { text, selStart: a, selEnd: b, line: lineIndex(text, a), message };
}

/** Insert `value` into the mini-notation string at caret pos (word boundary + spacing). */
function insertIntoMini(src, map, pos, value) {
  const str = stringAt(map, pos) || stringAt(map, pos + 1);
  if (!str) return null;
  let at = Math.max(str.start + 1, Math.min(pos, str.innerEnd));
  // move past the word under the caret and its modifiers (bd*4, bd:3, bd(3,8), bd?)
  if (at > str.start + 1 && !/[\s[<{,|]/.test(src[at - 1])) {
    while (at < str.innerEnd && !/[\s,\]>}|]/.test(src[at])) {
      if (src[at] === '(') { const c = src.indexOf(')', at); at = c < 0 || c >= str.innerEnd ? str.innerEnd : c + 1; } else at++;
    }
  }
  const before = src[at - 1], after = src[at];
  const pre = at > str.start + 1 && !/[\s[<{(,|]/.test(before) ? ' ' : '';
  const post = at < str.innerEnd && !/[\s\]>}),|*!?@%:/]/.test(after) ? ' ' : '';
  const ins = pre + value + post;
  return result(src, at, at, ins, pre.length, pre.length + value.length, `Added ${value} to the pattern`);
}

function appendMethod(src, map, span, code, selRel, message) {
  // multi-line chain whose last line starts with `.` -> new line, same indent
  const ls = lineStartOf(src, span.end - 1);
  const lineText = src.slice(ls, span.end);
  const multi = src.slice(span.start, span.end).includes('\n') && /^\s*\./.test(lineText);
  let at = span.end;
  if (src[at - 1] === ';') at--;
  if (multi) {
    const indent = /^\s*/.exec(lineText)[0];
    const ins = '\n' + indent + code;
    return result(src, at, at, ins, 1 + indent.length + selRel[0], 1 + indent.length + selRel[1], message);
  }
  return result(src, at, at, code, selRel[0], selRel[1], message);
}

/** Replace the argument of call {open, close} with `arg`. */
function replaceArg(src, call, arg, selRel, message) {
  return result(src, call.open + 1, call.close, arg, selRel ? selRel[0] : 0, selRel ? selRel[1] : arg.length, message);
}

/** Selection inside a method snippet ".lpf(800)" -> the argument. */
export function argSelection(code) {
  const o = code.indexOf('(');
  const c = code.lastIndexOf(')');
  if (o < 0 || c < o) return [code.length, code.length];
  const arg = code.slice(o + 1, c);
  if (/^(["'`]).*\1$/.test(arg)) return [o + 2, c - 1];
  const comma = arg.indexOf(',');
  if (comma > 0 && /^[\d./ -]+$/.test(arg.slice(0, comma))) return [o + 1, o + 1 + comma];
  return [o + 1, c];
}

const stripLabel = (code) => code.replace(/^\s*(?:_?\$|[A-Za-z_]\w*):\s*/, '');

/** Insert a new block (statement) — on a blank line, or after the statement at p. */
function insertBlock(src, map, dp, code, message) {
  const sel = argSelectionOfBlock(code);
  if (dp.p < 0) return result(src, dp.ls, dp.le, code, sel[0], sel[1], message || 'New block added'); // blank line: right there
  const st = statementSpans(map).find((s) => dp.p >= s.start && dp.p <= s.end);
  const endLineEnd = lineEndOf(src, st ? st.end - 1 : dp.le);
  const ins = '\n' + code;
  return result(src, endLineEnd, endLineEnd, ins, 1 + sel[0], 1 + sel[1], message || 'New block added below');
}
function argSelectionOfBlock(code) {
  const m = /"([^"]*)"/.exec(code);
  if (m) return [m.index + 1, m.index + 1 + m[1].length];
  return [code.length, code.length];
}

/** Add `expr` as a new argument of the constructor call at q. */
function addConstructorArg(src, map, q, fn, expr, message) {
  const { match } = map;
  const close = match.get(q);
  if (close == null) return null;
  let arg = stripLabel(expr);
  if (fn === 'arrange' || fn === 'timeCat' || fn === 'timecat') arg = `[${fn === 'arrange' ? 4 : 1}, ${arg}]`;
  const last = trimSpan(map, q + 1, close);
  const sel = argSelectionOfBlock(arg);
  if (!last) return result(src, q + 1, q + 1, arg, sel[0], sel[1], message);
  let lastEnd = last.end;
  const trailingComma = src[lastEnd - 1] === ',';
  if (src.slice(q, close).includes('\n')) {
    // one argument per line: same indent as the last argument's line
    const ls = lineStartOf(src, lastEnd - 1);
    const indent = /^\s*/.exec(src.slice(ls, lastEnd))[0] || '  ';
    const ins = (trailingComma ? '' : ',') + '\n' + indent + arg + (trailingComma ? ',' : '');
    const off = (trailingComma ? 0 : 1) + 1 + indent.length;
    return result(src, lastEnd, lastEnd, ins, off + sel[0], off + sel[1], message);
  }
  const ins = (trailingComma ? ' ' : ', ') + arg;
  const off = trailingComma ? 1 : 2;
  return result(src, lastEnd, lastEnd, ins, off + sel[0], off + sel[1], message);
}

/** Constructor call opened on the line of p (e.g. the `stack(` line of a multi-line stack). */
function constructorOnLine(map, dp) {
  const { src, kind } = map;
  for (let k = dp.ls; k < dp.le; k++) {
    if (src[k] !== '(' || kind[k] !== 0) continue;
    const { fn, isMethod } = callInfo(map, k);
    if (fn && !isMethod && CONSTRUCTORS.has(fn)) return { q: k, fn };
  }
  return null;
}
function enclosingConstructor(map, p) {
  for (let q = enclosingOpen(map, p); q >= 0; q = enclosingOpen(map, q)) {
    if (map.src[q] !== '(') continue;
    const { fn, isMethod } = callInfo(map, q);
    if (fn && !isMethod && CONSTRUCTORS.has(fn)) return { q, fn };
  }
  return null;
}

/** Innermost call `name(…)` whose name or parentheses contain offset (not constructors). */
const VALUE_FNS = new Set(['s', 'sound', 'note', 'n', 'chord', 'bank', 'scale', 'struct', 'mask', 'vowel', 'arp', 'samples', 'setcpm', 'setcps']);
function callUnder(map, offset) {
  const { src, kind } = map;
  // on the name itself: `.lp|f(800)`
  const ls = lineStartOf(src, offset), le = lineEndOf(src, offset);
  const lineText = src.slice(ls, le);
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(lineText))) {
    const a = ls + m.index, open = a + m[0].length - 1;
    if (kind[a] !== 0) continue;
    if (offset >= a && offset <= open) {
      const info = callInfo(map, open);
      if (info.fn && !CONSTRUCTORS.has(info.fn) && !VALUE_FNS.has(info.fn)) return { open, close: map.match.get(open) ?? open + 1, fn: info.fn, isMethod: info.isMethod };
    }
  }
  for (let q = enclosingOpen(map, offset); q >= 0; q = enclosingOpen(map, q)) {
    if (src[q] !== '(') continue;
    const info = callInfo(map, q);
    if (!info.fn || CONSTRUCTORS.has(info.fn)) break;
    if (VALUE_FNS.has(info.fn)) continue;
    return { open: q, close: map.match.get(q) ?? src.length, fn: info.fn, isMethod: info.isMethod };
  }
  return null;
}

const SLIDER_RANGES = {
  lpf: [100, 5000], cutoff: [100, 5000], hpf: [20, 4000], hcutoff: [20, 4000], bpf: [100, 5000], lpq: [0, 30], resonance: [0, 30], hpq: [0, 30],
  room: [0, 1], size: [0, 1], delay: [0, 1], delayfeedback: [0, 0.95], delaytime: [0, 1], gain: [0, 1.5], velocity: [0, 1], pan: [0, 1], shape: [0, 1],
  crush: [1, 16], coarse: [1, 32], distort: [0, 5], attack: [0, 2], decay: [0, 2], sustain: [0, 1], release: [0, 4], speed: [-2, 4],
  fast: [0.25, 8], slow: [0.25, 8], lpenv: [0, 8], degradeBy: [0, 1], legato: [0, 2], detune: [0, 1], transpose: [-24, 24], add: [-12, 12],
};
const fmtNum = (v) => String(Math.round(v * 1000) / 1000);

/**
 * Apply a palette chip dropped at offset. chip: {
 *   kind: 'method' (code '.lpf(800)', name 'lpf', unique?) | 'sound' (value, role 'drum'|'synth'|'sample')
 *       | 'bank' (value) | 'block' (code '$: s("bd*4")') | 'samples' (code "samples('github:…')")
 *       | 'arg' (code 'sine.range(200, 2000)', fallback 'lpf') | 'slider' (fallback 'gain') }
 * -> { text, selStart, selEnd, line, message } | null
 */
export function computeDrop(src, offset, chip) {
  offset = Math.max(0, Math.min(offset, src.length));
  const map = codeMap(src);
  const dp = dropPoint(map, offset);
  switch (chip.kind) {
    case 'samples': {
      const url = /\(\s*(['"`])(.*?)\1/.exec(chip.code)?.[2] || chip.code;
      const at = src.indexOf(url);
      if (at >= 0) return { text: src, selStart: at, selEnd: at + url.length, line: lineIndex(src, at), message: 'Already loaded' };
      // after leading comment lines
      let pos = 0;
      for (;;) {
        const le = lineEndOf(src, pos);
        if (/^\s*\/\//.test(src.slice(pos, le)) && le < src.length) pos = le + 1; else break;
      }
      const u0 = chip.code.indexOf(url);
      return result(src, pos, pos, chip.code + '\n', u0, u0 + url.length, 'Sample pack loaded at the top');
    }
    case 'block': {
      const p = dp.p >= 0 ? dp.p : -1;
      if (p >= 0) {
        const ctor = enclosingConstructor(map, p) || constructorOnLine(map, dp);
        if (ctor) return addConstructorArg(src, map, ctor.q, ctor.fn, chip.code, `Added to ${ctor.fn}(…)`);
      }
      return insertBlock(src, map, dp, chip.code);
    }
    case 'sound': {
      const v = chip.value;
      if (map.kind[offset] === 1 || stringAt(map, offset)) {
        const r = insertIntoMini(src, map, offset, v);
        if (r) return r;
      }
      if (dp.p < 0) {
        const code = chip.role === 'synth' ? `$: note("c3 e3 g3").s(${quoteVal(v)})` : `$: s(${quoteVal(v)})`;
        return insertBlock(src, map, dp, code);
      }
      const span = expressionAt(map, dp.p);
      if (!span) return null;
      const calls = chainCalls(map, span);
      const melodic = !!headCall(map, span, ['note', 'n', 'chord', 'freq']);
      const sCall = calls.find((c) => c.fn === 's' || c.fn === 'sound');
      if (chip.role === 'synth' || (melodic && chip.role !== 'drum')) {
        if (sCall) return replaceArg(src, sCall, quoteVal(v), [1, 1 + v.length], `Sound set to ${v}`);
        if (melodic) return appendMethod(src, map, span, `.s(${quoteVal(v)})`, [4, 4 + v.length], `Sound set to ${v}`);
      }
      const head = headCall(map, span, ['s', 'sound']) || sCall;
      if (head) {
        const inner = head.open + 1;
        const str = map.kind[inner] === 1 ? stringAt(map, inner + 1) : null;
        if (str) return insertIntoMini(src, map, str.innerEnd, v);
      }
      if (melodic) return appendMethod(src, map, span, `.s(${quoteVal(v)})`, [4, 4 + v.length], `Sound set to ${v}`);
      return insertBlock(src, map, dp, `$: s(${quoteVal(v)})`);
    }
    case 'bank': {
      const v = chip.value;
      if (dp.p < 0) return insertBlock(src, map, dp, `$: s("bd*4, ~ sd, hh*8").bank(${quoteVal(v)})`);
      const span = expressionAt(map, dp.p);
      if (!span) return null;
      const bank = chainCalls(map, span).find((c) => c.fn === 'bank');
      if (bank) return replaceArg(src, bank, quoteVal(v), [1, 1 + v.length], `Drum machine set to ${v}`);
      return appendMethod(src, map, span, `.bank(${quoteVal(v)})`, [7, 7 + v.length], `Drum machine ${v} added`);
    }
    case 'slider': case 'arg': {
      let call = dp.p === offset ? callUnder(map, offset) : null;
      if (!call && dp.p >= 0) {
        // dropped beside the code: the last chained method with a plain number (".lpf(800)")
        const span = expressionAt(map, dp.p);
        const nums = span ? chainCalls(map, span).filter((c) => /^\s*-?[\d.]+\s*(,|$)/.test(src.slice(c.open + 1, c.close)) && !VALUE_FNS.has(c.fn)) : [];
        if (nums.length && chip.kind === 'slider') call = nums[nums.length - 1];
      }
      const makeArg = (fn, existing) => {
        if (chip.kind === 'arg') return chip.code;
        const num = Number(existing);
        const [lo, hi] = SLIDER_RANGES[fn] || (Number.isFinite(num) && existing.trim() !== '' ? [0, Math.max(1, num * 2)] : [0, 1]);
        const v = Number.isFinite(num) && existing.trim() !== '' ? num : (lo + hi) / 2;
        return `slider(${fmtNum(v)}, ${fmtNum(lo)}, ${fmtNum(hi)})`;
      };
      const selOf = (arg) => {
        if (chip.kind === 'arg') return [0, arg.length];
        const o = arg.indexOf('('), c = arg.indexOf(',');
        return [o + 1, c];
      };
      if (call) {
        const D = map.depth[call.open] + 1;
        let a1 = call.close;
        for (let k = call.open + 1; k < call.close; k++) if (map.src[k] === ',' && map.kind[k] === 0 && map.depth[k] === D) { a1 = k; break; }
        const existing = src.slice(call.open + 1, a1);
        const arg = makeArg(call.fn, existing.trim());
        const sel = selOf(arg);
        return result(src, call.open + 1, a1, arg, sel[0], sel[1], `${chip.kind === 'slider' ? 'Slider' : 'Signal'} now drives .${call.fn}()`);
      }
      const fb = chip.fallback || 'gain';
      const arg = makeArg(fb, '');
      if (dp.p < 0) return insertBlock(src, map, dp, `$: s("hh*8").${fb}(${arg})`);
      const span = expressionAt(map, dp.p);
      if (!span) return null;
      const existing = chainCalls(map, span).find((c) => c.fn === fb);
      const code = `.${fb}(${arg})`;
      const sel = selOf(arg);
      if (existing) return replaceArg(src, existing, arg, sel, `${chip.kind === 'slider' ? 'Slider' : 'Signal'} now drives .${fb}()`);
      return appendMethod(src, map, span, code, [fb.length + 2 + sel[0], fb.length + 2 + sel[1]], `Added .${fb}(…)`);
    }
    case 'method': default: {
      const code = chip.code;
      const name = chip.name || /^\.([\w$]+)/.exec(code)?.[1];
      let span = null;
      if (dp.p >= 0) span = expressionAt(map, dp.p);
      else {
        // blank line: the statement just above
        const above = statementSpans(map).filter((s) => s.end <= dp.ls).pop();
        if (above) span = expressionAt(map, above.end - 1);
      }
      if (!span) return insertBlock(src, map, dp, `$: s("bd*4")${code}`);
      if (chip.unique !== false) {
        const ex = chainCalls(map, span).find((c) => c.fn === name);
        if (ex) {
          const a = argSelection(code);
          const newArg = code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'));
          if (chip.unique === 'replace') return replaceArg(src, ex, newArg, [a[0] - code.indexOf('(') - 1, a[1] - code.indexOf('(') - 1], `.${name}() updated`);
          return { text: src, selStart: ex.open + 1, selEnd: ex.close, line: lineIndex(src, ex.open), message: `Already has .${name}() — its value is selected` };
        }
      }
      return appendMethod(src, map, span, code, argSelection(code), `Added ${code.replace(/\(.*$/s, '()')}`);
    }
  }
}

/** Smallest single replacement turning a into b: {from, to, insert} (to = end in a). */
export function minimalEdit(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  while (s < n && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  return { from: s, to: ea, insert: b.slice(s, eb) };
}

// ------------------------------------------------------------------------------------------------ palette

/** Palette group of the prebake helper libraries' functions (one section per source). */
function prebakeGroups(docs) {
  if (!docs?.length) return [];
  const bySource = new Map();
  for (const d of docs) {
    const k = d.source || 'Prebake';
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(d);
  }
  return [{
    id: 'prebake', title: 'Prebake', desc: 'Functions your prebake helper libraries define',
    sections: [...bySource].map(([src, ds]) => ({
      title: src,
      chips: ds.map((d) => {
        const arg = prebakeArgs(d);
        const desc = `${d.desc || d.signature} — from the prebake “${src}”`;
        return d.kind === 'method'
          ? M(d.name, `.${d.name}(${arg})`, desc, { example: d.example || undefined, prebake: src })
          : B(d.name, `$: ${d.name}(${arg})`, desc, { example: d.example || undefined, prebake: src });
      }),
    })),
  }];
}

const M = (label, code, desc, extra = {}) => ({ kind: 'method', label, code, name: /^\.([\w$]+)/.exec(code)?.[1], desc, unique: true, ...extra });
const B = (label, code, desc, extra = {}) => ({ kind: 'block', label, code, desc, ...extra });

/** Palette categories: [{id, title, desc, sections:[{title?, chips:[chip]}]}]. chip.desc / chip.example are tooltips. */
export function paletteGroups(opts = {}) {
  const key = opts.key || { root: 0, scale: 'minor' };
  const bpm = opts.bpm || 120;
  const sc = strudelScaleName(key);
  const scBass = strudelScaleName(key, 2), scMid = strudelScaleName(key, 4);
  const prog = keyProgression(key);
  const ref = (n) => referenceFor(n)?.description || '';
  const chipM = (label, code, extra) => M(label, code, extra?.desc || ref(/^\.([\w$]+)/.exec(code)?.[1]), { example: referenceFor(/^\.([\w$]+)/.exec(code)?.[1])?.example, ...extra });
  const drums = DRUM_NAMES.map(([v, d]) => ({ kind: 'sound', role: 'drum', label: v, value: v, desc: `${d} — drop into a s("…") string, on an s() line, or on an empty line` }));
  const synths = WAVEFORMS.map(([v, d]) => ({ kind: 'sound', role: 'synth', label: v, value: v, desc: `${d} — drop on a note()/n() line to set its sound` }));
  const presets = Object.entries(PRESETS).map(([id, p]) => ({ kind: 'sound', role: 'synth', label: p.name, value: id, desc: `daW³ preset "${p.name}" (${p.category}) — sets .s("${id}") (daW³ instruments sound engine)` }));
  const banks = MACHINE_IDS.map((id) => ({ kind: 'bank', label: DRUM_MACHINES[id].name.replace(/^Roland /, ''), value: id, desc: `${DRUM_MACHINES[id].name} (${DRUM_MACHINES[id].year}) — ${DRUM_MACHINES[id].description} Adds .bank("${id}")` }));
  const packs = [
    { kind: 'samples', label: 'Dirt-Samples', code: "samples('github:tidalcycles/dirt-samples')", desc: 'Load the classic TidalCycles Dirt-Samples pack (adds a samples() line at the top, once).' },
    { kind: 'samples', label: 'Clean breaks', code: "samples('github:yaxu/clean-breaks')", desc: 'Load Alex McLean\'s clean breakbeats pack (adds a samples() line at the top, once).' },
  ];
  const projectSamples = (opts.samples || []).map((n) => ({ kind: 'sound', role: 'sample', label: n, value: n, desc: `Project sample "${n}"` }));
  return [
    {
      id: 'sounds', title: 'Sounds', desc: 'Drums, synths, presets and drum machines',
      sections: [
        { title: 'Drums', chips: drums },
        { title: 'Synths', chips: synths },
        { title: 'Drum machines', chips: banks, collapsed: true },
        { title: 'Presets', chips: presets, collapsed: true },
        ...(projectSamples.length ? [{ title: 'Project samples', chips: projectSamples }] : []),
        { title: 'Sample packs', chips: packs },
      ],
    },
    {
      id: 'patterns', title: 'Patterns', desc: 'Starter blocks — drop on an empty line (or onto a stack)',
      sections: [{
        chips: [
          B('Four on the floor', '$: s("bd*4")', 'Kick on every beat — the house / techno foundation.'),
          B('Backbeat', '$: s("~ sd ~ sd")', 'Snare on beats 2 and 4.'),
          B('Breakbeat', '$: s("bd ~ [~ bd] ~, ~ sd ~ [sd ~ ~ sd], hh*8")', 'Syncopated kick and snare with 8th hats.'),
          B('Hats 16ths', '$: s("hh*16").gain("[.5 .9]*8")', 'Busy 16th-note hi-hats with an accent pattern.'),
          B('Offbeat hats', '$: s("[~ oh]*4")', 'Open hats between the kicks.'),
          B('Clap 2 & 4', '$: s("~ cp ~ cp")', 'Clap on the backbeat.'),
          B('Euclid groove', '$: s("bd(3,8), hh(5,8,2), ~ cp")', 'Euclidean rhythms: 3 kicks and 5 hats spread over 8 steps.'),
          B('Bassline (in key)', `$: n("0 ~ 0 3 ~ 5 ~ 3").scale("${scBass}").s("sawtooth").lpf(600)`, `A minimal bassline in the project key (${sc}).`),
          B('Chords (in key)', `$: chord("<${prog.join(' ')}>").voicing().s("piano")`, `A four-chord progression in the project key: ${prog.join(' – ')}.`),
          B('Arp (in key)', `$: n("0 2 4 7 4 2").scale("${scMid}").s("triangle").fast(2).delay(.3)`, 'An arpeggio over the project scale.'),
          B('Melody (in key)', `$: n("<0 2 4 [5 4]>*2").scale("${scMid}").s("square").room(.3)`, 'A simple melody in the project scale.'),
        ],
      }],
    },
    {
      id: 'rhythm', title: 'Rhythm', desc: 'Time and variation — drop on a pattern line',
      sections: [{
        chips: [
          chipM('fast', '.fast(2)'), chipM('slow', '.slow(2)'), chipM('ply', '.ply(2)'), chipM('euclid', '.euclid(3, 8)'),
          chipM('struct', '.struct("x ~ x x")'), chipM('swingBy', '.swingBy(1/3, 4)'), chipM('sometimes', '.sometimes(x => x.speed(2))', { unique: false }),
          chipM('every', '.every(4, x => x.fast(2))', { unique: false }), chipM('degradeBy', '.degradeBy(.3)'), chipM('off', '.off(1/8, x => x.add(12))', { unique: false }),
          chipM('rev', '.rev()'), chipM('iter', '.iter(4)'), chipM('jux', '.jux(rev)'),
        ],
      }],
    },
    {
      id: 'pitch', title: 'Pitch', desc: 'Scales, chords and transposition',
      sections: [{
        chips: [
          chipM('scale', `.scale("${sc}")`, { desc: `${ref('scale')} Uses the project key (${sc}).`, unique: 'replace' }),
          chipM('add', '.add("<0 3>")', { unique: false }), chipM('transpose', '.transpose("<0 5 7>")'),
          chipM('octave up', '.transpose(12)', { desc: 'Transpose up one octave (12 semitones).', unique: false }),
          chipM('octave down', '.transpose(-12)', { desc: 'Transpose down one octave.', unique: false }),
          chipM('arp', '.arp("0 1 2 1")'), chipM('voicing', '.voicing()'),
          B('chord', `$: chord("<${prog.join(' ')}>").voicing()`, `${ref('chord')} Pre-filled with chords in the project key.`, { example: referenceFor('chord')?.example }),
        ],
      }],
    },
    {
      id: 'fx', title: 'Filters & FX', desc: 'Sound shaping — drop on a pattern line',
      sections: [{
        chips: [
          chipM('lpf', '.lpf(800)'), chipM('hpf', '.hpf(400)'), chipM('resonance', '.lpq(8)'), chipM('room', '.room(.4)'),
          chipM('delay', '.delay(.3)'), chipM('shape', '.shape(.4)'), chipM('crush', '.crush(6)'), chipM('pan', '.pan(.5)'),
          chipM('gain', '.gain(.8)'), chipM('velocity', '.velocity(.8)'), chipM('attack', '.attack(.05)'), chipM('release', '.release(.4)'),
          chipM('lpenv', '.lpenv(4)'),
        ],
      }],
    },
    {
      id: 'signals', title: 'Signals', desc: 'Drop onto a method\'s value to modulate it (or on a line: adds it)',
      sections: [{
        chips: [
          { kind: 'arg', label: 'sine sweep', code: 'sine.range(200, 2000).slow(4)', fallback: 'lpf', desc: 'A slow sine sweep 200–2000. Drop on a value (e.g. the 800 in .lpf(800)) to modulate it; on a line it adds .lpf(…).' },
          { kind: 'arg', label: 'saw ramp', code: 'saw.range(200, 4000)', fallback: 'lpf', desc: 'Rising ramp each cycle — classic filter sweep.' },
          { kind: 'arg', label: 'perlin', code: 'perlin.range(.4, 1)', fallback: 'gain', desc: 'Smooth random wobble — organic dynamics.' },
          { kind: 'arg', label: 'rand', code: 'rand.range(.3, .9)', fallback: 'gain', desc: 'Random value per event — humanized velocity.' },
          { kind: 'arg', label: 'auto-pan', code: 'sine.slow(4)', fallback: 'pan', desc: 'Slow left-right panning.' },
        ],
      }],
    },
    {
      id: 'structure', title: 'Structure', desc: 'Combine patterns',
      sections: [{
        chips: [
          B('$:', '$: s("bd*4")', 'A new pattern block — every $: block plays at the same time.'),
          B('stack', '$: stack(\n  s("bd*4"),\n  s("~ cp")\n)', 'Play patterns at the same time. Drop pattern blocks onto it to add layers.', { example: referenceFor('stack')?.example }),
          B('cat', '$: cat(s("bd*4"), s("bd*2 sd"))', 'One pattern per cycle, in turn.', { example: referenceFor('cat')?.example }),
          B('arrange', '$: arrange(\n  [4, s("bd*4")],\n  [4, s("bd*4, hh*8")]\n)', 'Sections that play for a number of cycles each. Drop pattern blocks onto it to add sections.', { example: referenceFor('arrange')?.example }),
          B('const', 'const drums = s("bd*4, ~ cp")', 'Name a pattern to reuse it ($: drums, or inside stack / arrange).'),
          chipM('mask', '.mask("<1 [1 0]>")'),
          B('setcpm', `setcpm(${bpm}/4)`, `Set the tempo: ${bpm} BPM (cycles per minute × 4 beats).`),
        ],
      }],
    },
    ...prebakeGroups(opts.prebake),
    {
      id: 'widgets', title: 'Widgets', desc: 'Live controls in the editor',
      sections: [{
        chips: [
          { kind: 'slider', label: 'slider', code: 'slider(0.5, 0, 1)', fallback: 'gain', desc: 'Drop onto a method (e.g. .lpf(800)) to turn its value into a live slider; on a line it adds .gain(slider(…)).', example: 'note("c2*8").s("sawtooth").lpf(slider(800, 100, 4000))' },
        ],
      }],
    },
  ];
}
