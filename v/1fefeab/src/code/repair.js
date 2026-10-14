// Strudel repair: rewrites the TidalCycles-isms AI chatbots (and Tidal users) put in "Strudel" code into valid Strudel,
// before the code is evaluated (paste / import — split and keep-as-code — and the Code tab's Apply).
//
//   repairStrudel(code, opts)  -> { code, repairs: [{line, from, to, why}], unresolved: [{line, column, message, suggestion}] }
//   locateError(code, error)   -> { line, column, snippet, message } | null   where a Strudel error really is in the code
//                                 (mini-notation errors name the line inside the STRING; this maps them to the file)
//   diagnose(code)             -> null | { error, line, column, snippet, suggestion }   evaluates and locates the error
//   salvageParts(code)         -> null | { code, dropped: [{label, line, error}], kept }  drops only the parts that fail
//   TIDAL_ARP_MODES            mode -> (n) => indices, Tidal's arp modes for an n-note chord
//
// Rules (each applied repair is recorded with its line, before -> after, and why):
//   Tidal chord names in mini strings (`C'min7`) -> Strudel chord symbols (`Cm7`) in chord(), note stacks in note()
//   Tidal operators between patterns (`a |+ b`, `a +| b`, `a |+| b`, |- |* |/ |% |< |>) -> `.add.in / .add.out / .add.mix` …
//   Tidal `# speed 2` chaining -> `.speed(2)`
//   note names: Tidal flats / sharps `ef4` / `cs` -> `eb4` / `c#`; `c4_ef4_g4` (notes glued by `_`) -> `[c4,eb4,g4]`
//   sound aliases saw / sin / tri / sqr -> sawtooth / sine / triangle / square; bank names in their canonical spelling
//   struct("x o x") -> struct("x ~ x") (`o` is not a rest in Strudel — every word plays)
//   .arp("pinkyup") (Tidal arp modes) -> index patterns for the chord size (.arp("[0 3 1 3 2 3]"))
//   .voicings() -> .voicing() (chord() patterns, Strudel 1.2); .scale("aeolian") -> .scale("C:aeolian")
//   note("0 2 4").scale(…) -> n("0 2 4").scale(…) (scale degrees); .scale() after absolute notes -> commented out
//   a second .note(…) in one chain (it would replace the first one's notes) -> .add(note(…)) when it is numbers
// Haskell-only syntax (`d1 $`, `every 3 (fast 2)`, `sound "bd"`) can't be guessed: it is reported with a suggestion.
import { strudelModules, prebakeStatus } from './strudel-real.js';
import { evaluate } from './strudel.js';
import { canonicalBank } from '../audio/library/drum-machines.js';

// ------------------------------------------------------------------------------------------- tables

/** Tidal chord names -> intervals (Sound.Tidal.Chords chordTable). */
const TIDAL_CHORD_INTERVALS = {
  major: [0, 4, 7], aug: [0, 4, 8], six: [0, 4, 7, 9], sixNine: [0, 4, 7, 9, 14], major7: [0, 4, 7, 11], major9: [0, 4, 7, 11, 14],
  add9: [0, 4, 7, 14], major11: [0, 4, 7, 11, 14, 17], add11: [0, 4, 7, 17], major13: [0, 4, 7, 11, 14, 21], add13: [0, 4, 7, 21],
  dom7: [0, 4, 7, 10], dom9: [0, 4, 7, 14], dom11: [0, 4, 7, 17], dom13: [0, 4, 7, 21], sevenFlat5: [0, 4, 6, 10], sevenSharp5: [0, 4, 8, 10],
  sevenFlat9: [0, 4, 7, 10, 13], nine: [0, 4, 7, 10, 14], eleven: [0, 4, 7, 10, 14, 17], thirteen: [0, 4, 7, 10, 14, 17, 21],
  minor: [0, 3, 7], diminished: [0, 3, 6], minorSharp5: [0, 3, 8], minor6: [0, 3, 7, 9], minorSixNine: [0, 3, 9, 7, 14],
  minor7flat5: [0, 3, 6, 10], minorMajor7: [0, 3, 7, 11], diminished7: [0, 3, 6, 9], minor7: [0, 3, 7, 10], minor7sharp5: [0, 3, 8, 10],
  minor7flat9: [0, 3, 7, 10, 13], minor7sharp9: [0, 3, 7, 10, 14], minor9: [0, 3, 7, 10, 14], minor11: [0, 3, 7, 10, 14, 17],
  minor13: [0, 3, 7, 10, 14, 17, 21], minorMajor9: [0, 3, 7, 11, 14], one: [0], five: [0, 7], sus2: [0, 2, 7], sus4: [0, 5, 7],
  sevenSus2: [0, 2, 7, 10], sevenSus4: [0, 5, 7, 10], nineSus4: [0, 5, 7, 10, 14], sevenFlat10: [0, 4, 7, 10, 15], nineSharp5: [0, 1, 13],
  minor9sharp5: [0, 1, 14], sevenSharp5flat9: [0, 4, 8, 10, 13], elevenSharp: [0, 4, 7, 10, 14, 18], minor11sharp: [0, 3, 7, 10, 14, 18],
};
/** Tidal's other spellings of the chord names. */
const TIDAL_CHORD_ALIASES = {
  maj: 'major', M: 'major', plus: 'aug', sharp5: 'aug', 6: 'six', six9: 'sixNine', sixby9: 'sixNine', '6by9': 'sixNine',
  maj7: 'major7', maj9: 'major9', maj11: 'major11', maj13: 'major13', '7f5': 'sevenFlat5', '7s5': 'sevenSharp5', '7f9': 'sevenFlat9',
  11: 'eleven', 13: 'thirteen', min: 'minor', m: 'minor', dim: 'diminished', msharp5: 'minorSharp5', mS5: 'minorSharp5',
  min6: 'minor6', m6: 'minor6', minor69: 'minorSixNine', min69: 'minorSixNine', minSixNine: 'minorSixNine', m69: 'minorSixNine',
  mSixNine: 'minorSixNine', m6by9: 'minorSixNine', min7flat5: 'minor7flat5', m7flat5: 'minor7flat5', m7f5: 'minor7flat5',
  minMaj7: 'minorMajor7', mmaj7: 'minorMajor7', dim7: 'diminished7', min7: 'minor7', m7: 'minor7', m7sharp5: 'minor7sharp5',
  m7s5: 'minor7sharp5', min7sharp5: 'minor7sharp5', m7flat9: 'minor7flat9', m7f9: 'minor7flat9', min7flat9: 'minor7flat9',
  m7sharp9: 'minor7sharp9', m7s9: 'minor7sharp9', min7sharp9: 'minor7sharp9', min9: 'minor9', m9: 'minor9', min11: 'minor11',
  m11: 'minor11', min13: 'minor13', m13: 'minor13', minMaj9: 'minorMajor9', mmaj9: 'minorMajor9', 1: 'one', 5: 'five',
  '7sus2': 'sevenSus2', '7sus4': 'sevenSus4', ninesus4: 'nineSus4', '9sus4': 'nineSus4', '7f10': 'sevenFlat10', ninesharp5: 'nineSharp5',
  '9sharp5': 'nineSharp5', '9s5': 'nineSharp5', minor9s5: 'minor9sharp5', min9sharp5: 'minor9sharp5', min9s5: 'minor9sharp5',
  m9sharp5: 'minor9sharp5', m9s5: 'minor9sharp5', '7s5f9': 'sevenSharp5flat9', '11s': 'elevenSharp', m11sharp: 'minor11sharp',
  m11s: 'minor11sharp', dom9: 'dom9', dom11: 'dom11', dom13: 'dom13',
};
/**
 * Tidal chord name -> Strudel chord symbol (the vendored voicing dictionary, 'ireal'); `approx` when Strudel has no
 * exact counterpart (the nearest one is used and the repair says so).
 */
export const TIDAL_TO_STRUDEL_CHORD = {
  major: '', aug: 'aug', six: '6', sixNine: '69', major7: '^7', major9: '^9', add9: 'add9', major11: { to: '^9', approx: true },
  add11: { to: 'add9', approx: true }, major13: '^13', add13: { to: '6', approx: true }, dom7: '7', dom9: '9', dom11: '11', dom13: '13',
  sevenFlat5: '7b5', sevenSharp5: '7#5', sevenFlat9: '7b9', nine: '9', eleven: '11', thirteen: '13', minor: 'm', diminished: 'o',
  minorSharp5: 'm#5', minor6: 'm6', minorSixNine: 'm69', minor7flat5: 'm7b5', minorMajor7: 'm^7', diminished7: 'o7', minor7: 'm7',
  minor7sharp5: { to: 'm#5', approx: true }, minor7flat9: { to: 'm7', approx: true }, minor7sharp9: { to: 'm9', approx: true },
  minor9: 'm9', minor11: 'm11', minor13: { to: 'm11', approx: true }, minorMajor9: 'm^9', one: { to: '5', approx: true }, five: '5',
  sus2: '2', sus4: 'sus', sevenSus2: { to: '7sus', approx: true }, sevenSus4: '7sus', nineSus4: '9sus', sevenFlat10: { to: '7#9', approx: true },
  nineSharp5: '9#5', minor9sharp5: { to: 'm9', approx: true }, sevenSharp5flat9: '7b9#5', elevenSharp: '9#11', minor11sharp: { to: 'm11', approx: true },
};
const tidalChordName = (name) => (TIDAL_CHORD_INTERVALS[name] ? name : TIDAL_CHORD_ALIASES[name] || null);

/** Tidal's arp modes (Sound.Tidal.UI arps) as indices into an n-note chord (lowest note = 0). */
const up = (n) => Array.from({ length: n }, (_, i) => i);
const converge = (xs) => (xs.length ? [xs[0], ...(xs.length > 1 ? [xs[xs.length - 1], ...converge(xs.slice(1, -1))] : [])] : []);
const pinkyup = (xs) => xs.slice(0, -1).flatMap((x) => [x, xs[xs.length - 1]]);
const thumbup = (xs) => xs.slice(1).flatMap((x) => [xs[0], x]);
const initOf = (xs) => xs.slice(0, -1);
export const TIDAL_ARP_MODES = {
  up: (n) => up(n),
  down: (n) => up(n).reverse(),
  updown: (n) => [...initOf(up(n)), ...initOf(up(n).reverse())],
  downup: (n) => [...initOf(up(n).reverse()), ...initOf(up(n))],
  'up&down': (n) => [...up(n), ...up(n).reverse()],
  'down&up': (n) => [...up(n).reverse(), ...up(n)],
  converge: (n) => converge(up(n)),
  diverge: (n) => converge(up(n)).reverse(),
  disconverge: (n) => { const c = converge(up(n)); return [...c, ...c.slice().reverse().slice(1)]; },
  pinkyup: (n) => pinkyup(up(n)),
  pinkyupdown: (n) => { const p = pinkyup(up(n)); return [...initOf(p), ...initOf(p.slice().reverse())]; },
  thumbup: (n) => thumbup(up(n)),
  thumbupdown: (n) => { const t = thumbup(up(n)); return [...initOf(t), ...initOf(t.slice().reverse())]; },
};

/** Tidal scale names Strudel (tonal) spells differently. */
const TIDAL_SCALES = {
  majPent: 'major:pentatonic', minPent: 'minor:pentatonic', harmonicMinor: 'harmonic:minor', melodicMinor: 'melodic:minor',
  harmonicMajor: 'harmonic:major', whole: 'whole:tone', wholetone: 'whole:tone', major: 'major', minor: 'minor', ionian: 'ionian',
  dorian: 'dorian', phrygian: 'phrygian', lydian: 'lydian', mixolydian: 'mixolydian', aeolian: 'aeolian', locrian: 'locrian',
  chromatic: 'chromatic', blues: 'blues', bartok: 'bartok', egyptian: 'egyptian', hexMajor7: 'major:hexatonic', ritusen: 'ritusen',
  superLocrian: 'super:locrian', diminished: 'diminished', augmented: 'augmented',
};

const SOUND_ALIASES = { saw: 'sawtooth', sin: 'sine', tri: 'triangle', sqr: 'square' };
const OP_METHOD = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '<': 'keep', '>': 'set' };
const NOTE_RE = /^([a-gA-G])(#|b|s|f)?(-?\d+)?$/;

// ------------------------------------------------------------------------------------------- helpers

const parse = (code) => strudelModules().acornParse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: false });
const tryParse = (code) => { try { return { ast: parse(code) }; } catch (e) { return { error: e }; } };
const lineOf = (code, pos) => { let n = 1; for (let i = 0; i < pos && i < code.length; i++) if (code.charCodeAt(i) === 10) n++; return n; };
const clip = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function walk(root, fn) {
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

/** Name of a call: `note(…)` -> 'note', `x.note(…)` -> 'note', else null. */
const calleeName = (n) => (n?.type !== 'CallExpression' ? null : n.callee.type === 'Identifier' ? n.callee.name
  : n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property.name : null);

/** String literal nodes the transpiler turns into mini-notation (double quotes / backticks without ${}). */
const isMiniLiteral = (code, n) => (n.type === 'Literal' && typeof n.value === 'string' && code[n.start] === '"')
  || (n.type === 'TemplateLiteral' && !n.expressions.length);
const literalText = (code, n) => code.slice(n.start + 1, n.end - 1);

const OPERATOR_METHODS = new Set(['add', 'sub', 'mul', 'div', 'mod', 'set', 'keep', 'in', 'out', 'mix', 'squeeze', 'reset', 'restart', 'poly', 'squeezeout']);
/** The control a string literal feeds (`note`, `s`, `chord`, `struct` …): its nearest enclosing call that isn't an operator. */
function contextOf(parents, node) {
  let child = node;
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (p.type === 'CallExpression') {
      if (p.arguments.includes(child)) {
        const name = calleeName(p);
        if (!OPERATOR_METHODS.has(name)) return name;
      }
      // the string is the receiver of a method call (`"<c g>".add(…)`): keep going up
    }
    child = p;
  }
  return null;
}

/** The calls of a method chain, outermost first (`a.b().c()` -> [c, b, a]); follows receivers only. */
function chainCalls(node) {
  const out = [];
  let n = node;
  while (n) {
    if (n.type === 'CallExpression') { out.push(n); n = n.callee.type === 'MemberExpression' ? n.callee.object : null; }
    else if (n.type === 'MemberExpression') n = n.object;
    else break;
  }
  return out;
}

/** Replace word tokens of a mini-notation string (letters, digits, # . ' _ ^ - ) with fn(word) (null = keep). */
function mapWords(text, fn) {
  return text.replace(/[A-Za-z0-9#.'_^\-]+/g, (w, off) => {
    // (keep the number after `:` / `*` / `/` / `@` / `!` / `(`: sample index, speed, weight …)
    const prev = text[off - 1];
    if (prev && ':*/@!%'.includes(prev)) return w;
    const r = fn(w);
    return r === null || r === undefined ? w : r;
  });
}

/** Tidal note name -> Strudel spelling (`ef4` -> `eb4`, `cs` -> `c#`), or null when it isn't one. */
function fixNoteName(w) {
  const m = NOTE_RE.exec(w);
  if (!m) return null;
  const acc = m[2] === 's' ? '#' : m[2] === 'f' ? 'b' : m[2] || '';
  return m[1] + acc + (m[3] || '');
}
const NOTE_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const PC_NAMES = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'ab', 'a', 'bb', 'b'];
function noteMidi(name) {
  const m = NOTE_RE.exec(name);
  if (!m) return null;
  const acc = m[2] === 's' || m[2] === '#' ? 1 : m[2] === 'f' || m[2] === 'b' ? -1 : 0;
  return (Number(m[3] ?? 3) + 1) * 12 + NOTE_PC[m[1].toLowerCase()] + acc;
}
const midiName = (m) => PC_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// ------------------------------------------------------------------------------------------- textual passes

/** Skips comments and strings: calls fn(i) for every code position; returns nothing. */
function codePositions(code) {
  const pos = new Uint8Array(code.length); // 1 = code
  let i = 0;
  while (i < code.length) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === '\\') j++; if (code[j] === '\n' && c !== '`') break; j++; }
      i = j + 1; continue;
    }
    pos[i] = 1;
    i++;
  }
  return pos;
}

/** Start of the operand that ends right before `end` (string / number / identifier / call chain), or -1. */
function operandStart(code, end, isCode) {
  let i = end;
  while (i > 0 && /\s/.test(code[i - 1])) i--;
  const atomStart = (j) => {
    const c = code[j - 1];
    if (c === '"' || c === "'" || c === '`') { const k = code.lastIndexOf(c, j - 2); return k < 0 ? -1 : k; }
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      for (let k = j - 1; k >= 0; k--) {
        if (!isCode[k] && code[k] !== c && code[k] !== open) continue;
        if (code[k] === c) depth++;
        else if (code[k] === open && --depth === 0) {
          // a call: include the callee identifier
          let s = k;
          while (s > 0 && /[\w$]/.test(code[s - 1])) s--;
          return s;
        }
      }
      return -1;
    }
    if (/[\w$.]/.test(c)) { let s = j; while (s > 0 && /[\w$]/.test(code[s - 1])) s--; return s < j ? s : -1; }
    return -1;
  };
  let s = atomStart(i);
  if (s < 0) return -1;
  // member chains: `x.y(…).z` — keep going while preceded by `.`
  for (;;) {
    let k = s;
    while (k > 0 && /\s/.test(code[k - 1])) k--;
    if (code[k - 1] !== '.' || code[k - 2] === '.') break;
    const s2 = atomStart(k - 1);
    if (s2 < 0) break;
    s = s2;
  }
  return s;
}

/** End of the operand that starts at/after `start`, or -1. */
function operandEnd(code, start, isCode) {
  let i = start;
  while (i < code.length && /\s/.test(code[i])) i++;
  const atomEnd = (j) => {
    const c = code[j];
    if (c === '"' || c === "'" || c === '`') { const k = code.indexOf(c, j + 1); return k < 0 ? -1 : k + 1; }
    if (c === '(' || c === '[') {
      const close = c === '(' ? ')' : ']';
      let depth = 0;
      for (let k = j; k < code.length; k++) {
        if (!isCode[k] && code[k] !== c && code[k] !== close) continue;
        if (code[k] === c) depth++;
        else if (code[k] === close && --depth === 0) return k + 1;
      }
      return -1;
    }
    if (/[\w$]/.test(c ?? '')) { let e = j; while (e < code.length && /[\w$.]/.test(code[e]) && !(code[e] === '.' && !/[\w$\d]/.test(code[e + 1] ?? ''))) e++; return e; }
    return -1;
  };
  let e = atomEnd(i);
  if (e < 0) return -1;
  for (;;) {
    if (code[e] === '(') { const e2 = atomEnd(e); if (e2 < 0) break; e = e2; continue; }
    let k = e;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] === '.' && /[A-Za-z_$]/.test(code[k + 1] ?? '')) { const e2 = atomEnd(k + 1); if (e2 < 0) break; e = e2; continue; }
    break;
  }
  return e;
}

/** `a |+ b` and friends -> `a.add.in(b)`; `x # speed 2` -> `x.speed(2)`. */
function tidalOperators(code, repairs) {
  for (let guard = 0; guard < 200; guard++) {
    const isCode = codePositions(code);
    let found = null;
    const re = /(\|?)([+\-*/%<>])(\|?)/g;
    let m;
    while ((m = re.exec(code))) {
      if (!m[1] && !m[3]) continue;
      if (!isCode[m.index]) continue;
      const before = code[m.index - 1], after = code[m.index + m[0].length];
      if (before === '|' || after === '|' || after === '=' || (m[2] === '/' && (after === '/' || after === '*'))) continue; // `||`, `|=`, comments
      if (m[1] && m[3] === '' && m[2] === '-' && /\d/.test(after ?? '')) { /* `x |-1`: still Tidal */ }
      found = m; break;
    }
    if (found) {
      const opStart = found.index, opEnd = found.index + found[0].length;
      const ls = operandStart(code, opStart, isCode), re2 = operandEnd(code, opEnd, isCode);
      if (ls < 0 || re2 < 0) break;
      const left = code.slice(ls, opStart).trim(), right = code.slice(opEnd, re2).trim();
      const mode = found[1] && found[3] ? 'mix' : found[1] ? 'in' : 'out';
      const method = OP_METHOD[found[2]];
      const lhs = /^[\d.]+$/.test(left) ? `pure(${left})` : left;
      const to = `${lhs}.${method}.${mode}(${right})`;
      const from = code.slice(ls, re2);
      const structure = mode === 'in' ? 'structure from the left' : mode === 'out' ? 'structure from the right' : 'structure from both sides';
      repairs.push({ pos: ls, from: clip(from.replace(/\s+/g, ' ')), to: clip(to), why: `Tidal operator ${found[0]} is not JavaScript (in JS it is a bitwise OR: the notes silently become 0) — Strudel's .${method}.${mode}() (${structure})` });
      code = keepCommentColumn(code, ls, re2, to);
      continue;
    }
    // `# speed 2` / `# speed("2")` / `# s "bd"` (Tidal's # chaining)
    const hm = /[ \t]*#\s*([A-Za-z_]\w*)\s*(\(|"[^"\n]*"|-?[\d.]+)/g;
    let h2 = null;
    while ((m = hm.exec(code))) if (isCode[m.index + m[0].indexOf('#')]) { h2 = m; break; }
    if (!h2) break;
    const to = h2[2] === '(' ? `.${h2[1]}(` : `.${h2[1]}(${h2[2]})`;
    repairs.push({ pos: h2.index, from: h2[0].trim(), to, why: 'Tidal\'s # chaining is a method call in Strudel' });
    code = code.slice(0, h2.index) + to + code.slice(h2.index + h2[0].length);
  }
  return code;
}

// ------------------------------------------------------------------------------------------- AST passes

/** Names the loaded prebake helper libraries define (their calls are never "repaired"). */
const prebakeNames = () => new Set(prebakeStatus()?.names || []);

/** Rewrites of mini-notation strings by the control they feed. -> [{start, end, text, repair}] */
function stringEdits(code, ast) {
  const edits = [];
  const own = prebakeNames();
  walk(ast, (n, parents) => {
    if (!isMiniLiteral(code, n)) return;
    const ctx = contextOf(parents, n);
    if (!ctx || own.has(ctx)) return; // (a prebake's own function: its strings mean what it says)
    const quote = code[n.start];
    let text = literalText(code, n);
    const steps = [];
    const step = (next, why) => { if (next !== text) { steps.push({ from: quote + text + quote, to: quote + next + quote, why }); text = next; } };
    if (ctx === 'chord') {
      const approx = [];
      step(mapWords(text, (w) => {
        const m = /^([a-gA-G])(#|b|s|f)?(-?\d*)'([A-Za-z0-9]+)((?:'[A-Za-z0-9]+)*)$/.exec(w);
        if (!m) return null;
        const name = tidalChordName(m[4]);
        if (!name) return null;
        let to = TIDAL_TO_STRUDEL_CHORD[name];
        if (typeof to === 'object') { approx.push(`${m[4]}≈${to.to || 'major'}`); to = to.to; }
        const acc = m[2] === 's' ? '#' : m[2] === 'f' ? 'b' : m[2] || '';
        return m[1].toUpperCase() + acc + to;
      }), `Tidal chord names (C'min7) are a parse error in Strudel — chord symbols as the voicing dictionary spells them${approx.length ? ` (no exact Strudel chord: ${approx.join(', ')})` : ''}`);
      step(mapWords(text, (w) => {
        const m = /^([A-Ga-g])(s|f)(.*)$/.exec(w);
        if (!m || /^us/.test(m[3]) || !/^(-?\d*)(m|M|\^|o|h|aug|add|sus|\d|-|$)/.test(m[3])) return null;
        return m[1].toUpperCase() + (m[2] === 's' ? '#' : 'b') + m[3];
      }), 'Tidal flats / sharps (ef, cs) in chord roots — Strudel reads them as Eb, C#');
    }
    if (ctx === 'note' || ctx === 'n') {
      const unknown = [];
      step(mapWords(text, (w) => {
        const m = /^([a-gA-G])(#|b|s|f)?(-?\d*)'([A-Za-z0-9]+)((?:'[A-Za-z0-9]+)*)$/.exec(w);
        if (!m) return null;
        const name = tidalChordName(m[4]);
        if (!name) { unknown.push(w); return null; }
        const root = noteMidi(m[1] + (m[2] || '') + (m[3] || ''));
        return `[${TIDAL_CHORD_INTERVALS[name].map((iv) => midiName(root + iv)).join(',')}]`;
      }), 'Tidal chord names (c\'maj) in notes are a parse error in Strudel — written out as a chord stack [c3,e3,g3]');
      step(mapWords(text, (w) => {
        if (!w.includes('_') || /^_+$/.test(w)) return null;
        const tail = /^([^_]+)(_+)$/.exec(w);
        if (tail && NOTE_RE.test(tail[1])) return [tail[1], ...tail[2].split('')].join(' ');
        const parts = w.split('_');
        if (parts.length < 2 || parts.some((x) => !NOTE_RE.test(x))) return null;
        return `[${parts.map((x) => fixNoteName(x)).join(',')}]`;
      }), 'notes glued by _ are one (invalid) note in Strudel, so it played nothing — `a_b_c` read as a chord stack [a,b,c], `b_` as b held (b _)');
      step(mapWords(text, (w) => {
        const m = NOTE_RE.exec(w);
        if (!m || (m[2] !== 's' && m[2] !== 'f')) return null;
        return fixNoteName(w);
      }), 'Tidal note names (ef = E flat, cs = C sharp) — written the Strudel way (eb, c#)');
    }
    if (ctx === 's' || ctx === 'sound') {
      step(mapWords(text, (w) => SOUND_ALIASES[w] || null), 'synth aliases (saw / sin / tri / sqr) — Strudel\'s sound names are sawtooth / sine / triangle / square');
    }
    if (ctx === 'bank') {
      step(mapWords(text, (w) => { const c = canonicalBank(w); return c && c !== w ? c : null; }), 'drum machine bank in its canonical spelling (Strudel looks banks up case-insensitively, so it played either way)');
    }
    if (ctx === 'struct') {
      const words = text.match(/[A-Za-z0-9]+/g) || [];
      if (words.includes('o') && words.includes('x') && words.every((w) => /^(x|o|t|f|1|0)$/.test(w))) {
        step(mapWords(text, (w) => (w === 'o' ? '~' : null)), 'in struct() every word is a hit — `o` plays too; rests are ~');
      }
    }
    if (steps.length) edits.push({ start: n.start, end: n.end, text: quote + text + quote, repairs: steps });
  });
  return edits;
}

/** Chord size of a pattern expression: evaluated (most notes starting together), else its mini stacks, else 4. */
function chordShape(code, recv) {
  const src = code.slice(recv.start, recv.end);
  try {
    const res = evaluate(src);
    if (!res.error && res.patterns?.length) {
      const haps = res.patterns[0].queryArc(0, 1).filter((h) => h.hasOnset?.() ?? true);
      const at = new Map();
      for (const h of haps) { const k = Number(h.whole?.begin ?? h.part.begin).toFixed(6); at.set(k, (at.get(k) || 0) + 1); }
      if (at.size) return { size: Math.max(...at.values()), perCycle: at.size };
    }
  } catch { /* uses consts — read the strings */ }
  let size = 0;
  for (const m of src.matchAll(/\[([^\[\]]*,[^\[\]]*)\]/g)) size = Math.max(size, m[1].split(',').length);
  return { size: size || 4, perCycle: 1, guessed: !size };
}

/** True when .scale() pushes the notes of `recv` out of range (absolute MIDI numbers read as degrees). */
function scaleOverflows(withScale, recv) {
  try {
    const res = evaluate(withScale);
    if (!res.error && res.patterns?.length) {
      const notes = res.patterns[0].queryArc(0, 4).map((h) => h.value?.note).filter((x) => typeof x === 'number');
      if (notes.length) return Math.max(...notes) > 115;
    }
  } catch { /* uses consts */ }
  return /\.(add|sub)\b|\|/.test(recv) || /note\(\s*\d{2}/.test(recv);
}

/** Method-chain rewrites (.voicings, .arp modes, .scale, duplicate .note). -> edits */
function callEdits(code, ast, opts) {
  const edits = [];
  const add = (start, end, text, why) => edits.push({ start, end, text, repairs: [{ from: clip(code.slice(start, end)), to: clip(text), why }] });
  // the song's key: the root of another .scale("D:minor"), opts.key, else C
  const rootM = /scale\(\s*["'`]([A-Ga-g][#b]?)-?\d*:/.exec(code);
  const root = rootM ? rootM[1].toUpperCase() : opts.key || 'C';
  const own = prebakeNames();
  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
    const name = n.callee.property.name;
    if (own.has(name)) return; // defined by a loaded prebake: not a TidalCycles-ism
    const recv = n.callee.object;
    const arg = n.arguments[0];
    const argStr = arg && arg.type === 'Literal' && typeof arg.value === 'string' ? arg.value : arg && arg.type === 'TemplateLiteral' && !arg.expressions.length ? arg.quasis[0].value.cooked : null;
    const chain = chainCalls(recv);
    const inChain = (nm) => chain.some((c) => calleeName(c) === nm);
    const recvHas = (re) => re.test(code.slice(recv.start, recv.end));
    const from = n.callee.property.start - 1; // the `.`
    if (name === 'voicings') {
      if (!recvHas(/\bchord\s*\(/)) return; // old API on chord-name strings ("<C^7 Dm7>".voicings('lefthand')) still works
      const dict = argStr ? `.dict(${code.slice(arg.start, arg.end)})` : '';
      add(from, n.end, `${dict}.voicing()`, '.voicings() is the old API — on chord() patterns Strudel 1.2 plays nothing for it; .voicing() voices the chords');
    } else if (name === 'arp' && argStr !== null) {
      const words = argStr.match(/[A-Za-z&]+/g) || [];
      if (!words.length || !words.every((w) => TIDAL_ARP_MODES[w])) return;
      const shape = chordShape(code, recv);
      const idx = (w) => `[${TIDAL_ARP_MODES[w](shape.size).join(' ')}]`;
      let pat = argStr.replace(/[A-Za-z&]+/g, (w) => idx(w));
      if (shape.perCycle > 1) pat = `[${pat}]*${shape.perCycle}`;
      add(arg.start, arg.end, `"${pat}"`, `Tidal arp mode${words.length > 1 ? 's' : ''} "${words.join(' ')}" — Strudel's .arp() takes note indices: the ${words.join(' / ')} order for ${shape.size}-note chords${shape.guessed ? ' (assumed)' : ''}`);
    } else if (name === 'scale' && argStr !== null) {
      // .scale() after absolute notes reads them as scale degrees (note 48 -> degree 48, ~7 octaves up)
      const noteCalls = chain.filter((c) => calleeName(c) === 'note' && c !== n);
      if (noteCalls.length) {
        const args = noteCalls.map((c) => code.slice(c.arguments[0]?.start ?? c.end, c.arguments[0]?.end ?? c.end));
        const nums = args.every((a) => /^\s*["'`][\s\d<>\[\]~.,*/!@?|-]*["'`]\s*$/.test(a)) && args.join(' ').match(/\d+/g)?.every((x) => Number(x) < 24);
        if (!nums && !scaleOverflows(code.slice(recv.start, n.end), code.slice(recv.start, recv.end))) return;
        if (nums) {
          for (const c of noteCalls) { const p = c.callee.type === 'MemberExpression' ? c.callee.property : c.callee; add(p.start, p.end, 'n', 'scale degrees go in n() — note() numbers are MIDI notes, so .scale() mis-read them'); }
        } else {
          const full = /:/.test(argStr) ? code.slice(arg.start, arg.end) : `"${root}:${TIDAL_SCALES[argStr] || argStr}"`;
          add(from, n.end, `/* .scale(${full}) */`, 'Strudel\'s .scale() reads numbers as scale degrees, so the absolute notes before it would play many octaves too high (inaudible) — left out (kept as a comment; it names the key)');
          return;
        }
      }
      const fixedName = (s) => TIDAL_SCALES[s] || s;
      if (!/:/.test(argStr) && /^[A-Za-z]+$/.test(argStr.trim())) {
        add(arg.start, arg.end, `"${root}:${fixedName(argStr.trim())}"`, `a scale needs a root in Strudel (.scale("aeolian") plays nothing) — ${root}${rootM ? ' (the code\'s key)' : opts.key ? ' (the song key)' : ''}`);
      } else if (/:/.test(argStr)) {
        const [r, ...rest] = argStr.split(':');
        const nm = rest.join(':');
        if (TIDAL_SCALES[nm] && TIDAL_SCALES[nm] !== nm) add(arg.start, arg.end, `"${r}:${TIDAL_SCALES[nm]}"`, `Tidal scale name ${nm} — Strudel (tonal) spells it ${TIDAL_SCALES[nm].replace(/:/g, ' ')}`);
      }
    } else if (name === 'note' && arg) {
      // a second .note() replaces the first one's notes (in Tidal too: # note) — numbers are meant as a transposition / walk
      if (!chain.some((c) => calleeName(c) === 'note' && c !== n) && !/^\s*note\s*\(/.test(code.slice(recv.start, recv.end))) return;
      if (argStr === null || !/^[\s\d<>\[\]~.,*/!@?|_-]*$/.test(argStr)) return;
      add(from, n.end, `.add(note(${code.slice(arg.start, arg.end)}))`, 'a second .note() replaces the notes of the first one (they never played) — its numbers added as a transposition instead');
    }
  });
  return edits;
}

/** Replaces code[start, end) with text, keeping a `// comment` later on the line in its column when there is room. */
function keepCommentColumn(code, start, end, text) {
  const d = text.length - (end - start);
  let rest = code.slice(end);
  const m = /^([^\n]*?)( +)(\/\/[^\n]*)/.exec(rest);
  if (d && m && !/["'`]/.test(m[1])) {
    const sp = m[2].length - d;
    if (sp >= 1) rest = m[1] + ' '.repeat(sp) + rest.slice(m[1].length + m[2].length);
  }
  return code.slice(0, start) + text + rest;
}

function applyEdits(code, edits, repairs) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const kept = [];
  for (const e of sorted) if (!kept.length || e.start >= kept[kept.length - 1].end) kept.push(e);
  let out = code;
  for (const e of [...kept].reverse()) out = keepCommentColumn(out, e.start, e.end, e.text);
  for (const e of kept) for (const r of e.repairs) repairs.push({ pos: e.start, ...r });
  return out;
}

// ------------------------------------------------------------------------------------------- Haskell-only syntax

const HASKELL = [
  [/^\s*d\d+\s*\$/m, 'TidalCycles (Haskell) syntax `d1 $ …` — in Strudel write `$: …` and call functions with parentheses: sound("bd*2")'],
  [/\bevery\s+\d+\s*\(/, 'Tidal `every 3 (fast 2)` — in Strudel: .firstOf(3, x => x.fast(2)) (or .every(3, fast(2)) on older versions)'],
  [/\b(sound|s|n|note)\s+"/, 'Tidal function application `sound "bd"` — Strudel needs parentheses: sound("bd")'],
  [/\$\s*(sound|s|n|note|fast|slow|stack|cat)\b/, 'Tidal `$` application — in Strudel chain methods: s("bd").fast(2)'],
  [/<~|~>/, 'Tidal shift operators `0.25 <~ p` — in Strudel: p.early(0.25) / p.late(0.25)'],
];

function unresolvedOf(code, err) {
  const pos = Number.isFinite(err?.pos) ? err.pos : null;
  const line = err?.loc?.line ?? (pos !== null ? lineOf(code, pos) : null);
  const column = err?.loc?.column ?? null;
  const text = line ? code.split('\n')[line - 1] || '' : '';
  const hint = HASKELL.find(([re]) => re.test(text)) || HASKELL.find(([re]) => re.test(code));
  return { line, column: column === null ? null : column + 1, message: String(err?.message || err), snippet: text.trim(), suggestion: hint ? hint[1] : 'Fix this line by hand (it is not valid JavaScript / Strudel)' };
}

// ------------------------------------------------------------------------------------------- entry points

/**
 * Rewrites TidalCycles-isms into valid Strudel. opts: { key: 'C' (root for .scale() without one) }.
 * -> { code, repairs: [{line, from, to, why}], unresolved: [{line, column, message, snippet, suggestion}] }
 */
export function repairStrudel(code, opts = {}) {
  const original = String(code ?? '');
  const out = { code: original, repairs: [], unresolved: [] };
  if (!strudelModules()) return out;
  const raw = [];
  let s = tidalOperators(original, raw);
  const lineMap = (pos, text) => lineOf(text, pos);
  // (the passes never add or remove line breaks, so lines are the user's lines)
  const repairs = raw.map((r) => ({ line: lineMap(r.pos, original), from: r.from, to: r.to, why: r.why }));
  const p = tryParse(s);
  if (p.error) {
    out.code = s;
    out.repairs = repairs;
    out.unresolved.push(unresolvedOf(s, p.error));
    return out;
  }
  const r1 = [];
  s = applyEdits(s, stringEdits(s, p.ast), r1);
  repairs.push(...r1.map((r) => ({ line: lineOf(s, r.pos), from: r.from, to: r.to, why: r.why })));
  const p2 = tryParse(s);
  if (!p2.error) {
    const r2 = [];
    const before = s;
    s = applyEdits(s, callEdits(s, p2.ast, opts), r2);
    repairs.push(...r2.map((r) => ({ line: lineOf(before, r.pos), from: r.from, to: r.to, why: r.why })));
  }
  out.code = s;
  out.repairs = repairs.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * Where an evaluation error is in the code: mini-notation errors ("[mini] parse error at line 1: … but "'" found")
 * name the line inside the string — the string literal that fails to parse gives the real line / column.
 * -> { line, column, snippet, message } | null
 */
export function locateError(code, error) {
  const S = strudelModules();
  if (!S || !error) return null;
  const msg = String(error);
  if (/\[mini\]|parse error/i.test(msg)) {
    const p = tryParse(code);
    if (p.ast) {
      let hit = null;
      walk(p.ast, (n) => {
        if (hit || !isMiniLiteral(code, n)) return;
        try { S.mini.parse(`"${literalText(code, n)}"`); } catch (e) {
          const off = Math.max(0, (e.location?.start?.offset ?? 1) - 1);
          const at = n.start + 1 + off;
          const line = lineOf(code, at);
          const ls = code.lastIndexOf('\n', at - 1) + 1;
          hit = { line, column: at - ls + 1, start: at, snippet: code.slice(n.start, n.end), message: msg.replace(/^\[mini\] parse error at line \d+:\s*/, '[mini] parse error: ') };
        }
      });
      if (hit) return hit;
    }
  }
  const p = tryParse(code);
  if (p.error) {
    const u = unresolvedOf(code, p.error);
    return { line: u.line, column: u.column, snippet: u.snippet, message: u.message };
  }
  return null;
}

/** Evaluates the code; null when it works, else the error with its place in the code and a suggestion. */
export function diagnose(code) {
  let res;
  try { res = evaluate(code); } catch (e) { res = { error: String(e?.message || e) }; }
  if (!res?.error) return null;
  const loc = locateError(code, res.error) || {};
  const text = loc.line ? code.split('\n')[loc.line - 1] || '' : '';
  const hint = HASKELL.find(([re]) => re.test(text));
  return { error: res.error, line: loc.line ?? null, column: loc.column ?? null, snippet: loc.snippet || text.trim(), suggestion: hint ? hint[1] : null };
}

/**
 * "Import the parts that work": evaluates each `$:` / top-level block and each stack(…) member on its own (with the
 * code's setup — consts, setcps …) and drops only the failing ones. -> null when nothing can be kept, else
 * { code, dropped: [{label, line, error}], kept } (the code with the failing parts removed / silenced).
 */
export function salvageParts(code) {
  const p = tryParse(code);
  if (p.error) return null;
  const ast = p.ast;
  const setup = ast.body.filter((n) => n.type === 'VariableDeclaration' || n.type === 'FunctionDeclaration'
    || (n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' && /^(setcp[ms]|setCps|setCpm|setbpm|samples|register|setDefaultVoicings|aliasBank|soundAlias)$/.test(n.expression.callee?.name || '')))
    .map((n) => code.slice(n.start, n.end)).join('\n');
  const fails = (expr) => { try { const r = evaluate(`${setup}\n${expr}`); return r.error || null; } catch (e) { return String(e?.message || e); } };
  const label = (node) => {
    const ls = code.lastIndexOf('\n', node.start - 1) + 1;
    const prev = code.slice(0, ls).trimEnd().split('\n').pop()?.trim() || '';
    const c = /^\/\/\s*(.+)$/.exec(prev)?.[1];
    return clip((c ? `${c} — ` : '') + code.slice(node.start, node.end).replace(/\s+/g, ' '), 80);
  };
  const edits = [];
  const dropped = [];
  let kept = 0;
  const visitStack = (call) => {
    for (const a of call.arguments) {
      const inner = a.type === 'CallExpression' && a.callee.type === 'Identifier' && a.callee.name === 'stack' ? a : null;
      const err = fails(code.slice(a.start, a.end));
      if (!err) { kept++; continue; }
      if (inner) { visitStack(inner); continue; }
      dropped.push({ label: label(a), line: lineOf(code, a.start), error: err });
      edits.push({ start: a.start, end: a.end, text: 'silence' });
    }
  };
  for (const node of ast.body) {
    const body = node.type === 'LabeledStatement' ? node.body : node.type === 'ExpressionStatement' ? node : null;
    if (!body) continue;
    const expr = body.type === 'ExpressionStatement' ? body.expression : body;
    if (expr.type === 'CallExpression' && /^(setcp[ms]|setCps|setCpm|setbpm|samples|register|hush|setDefaultVoicings|aliasBank|soundAlias)$/.test(expr.callee?.name || '')) continue;
    const err = fails(code.slice(expr.start, expr.end));
    if (!err) { kept++; continue; }
    // a failing stack: keep its members that work
    let st = null;
    walk(expr, (x) => { if (!st && x.type === 'CallExpression' && x.callee.type === 'Identifier' && x.callee.name === 'stack') st = x; });
    if (st) { visitStack(st); continue; }
    dropped.push({ label: label(node), line: lineOf(code, node.start), error: err });
    edits.push({ start: node.start, end: node.end, text: `/* dropped (fails in Strudel): ${code.slice(node.start, node.end).replace(/\*\//g, '* /')} */` });
  }
  if (!dropped.length || !kept) return null;
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const res = evaluate(out);
  if (res.error) return null;
  return { code: out, dropped, kept };
}
