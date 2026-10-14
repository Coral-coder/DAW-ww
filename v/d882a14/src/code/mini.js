// Mini-notation parser (Strudel / Tidal style). `mini("bd [sd sd] <hh oh>")` -> Pattern.
//
// Supported: sequences, ~ / - rests, [ ] subsequences, < > alternation, { }%n polymeter,
// *n fast, /n slow, !n and bare ! replicate, @n elongate, _ hold, ? / ?0.3 degrade,
// , stack, | random choice, (k,n,r) euclid, a:b lists (bd:3), . grouping, 0 .. 3 ranges,
// numbers and words (note names, sample names, chord symbols).
// Every atom carries its source range ({start, end}, relative to the string) in
// hap.context.locations; Pattern operations merge locations (see combineContext).
import {
  pure, silence, stack, fastcat, slowcat, timeCat, rand, chooseInWith, Pattern,
} from './pattern.js';

const NUM_RE = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/;
const WORD_CHAR = /[A-Za-z0-9#^_.:'\-$]/;
const SINGLE = '[]<>{}(),|*/!@?%';
const CLOSERS = new Set([']', '>', '}', ')', ',', '|']);

export class MiniError extends Error {}

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const ws = i === 0 || /\s/.test(src[i - 1]);
    const pos = i;
    const nx = src[i + 1] || '';
    if (SINGLE.includes(c)) { toks.push({ t: c, ws, pos }); i++; continue; }
    if (c === '~') { toks.push({ t: '~', ws, pos }); i++; continue; }
    if (c === '_' ) { toks.push({ t: '_', ws, pos }); i++; continue; }
    if (c === '.' && nx === '.') { toks.push({ t: '..', ws, pos }); i += 2; continue; }
    if (c === '.' && !/\d/.test(nx)) { toks.push({ t: '.', ws, pos }); i++; continue; }
    if (c === '-' && !/[\d.A-Za-z]/.test(nx)) { toks.push({ t: '~', ws, pos }); i++; continue; }
    if (/[A-Za-z0-9#'.\-$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && WORD_CHAR.test(src[j])) {
        if (src[j] === '.' && !/\d/.test(src[j + 1] || '')) break;
        j++;
      }
      toks.push({ t: 'word', v: src.slice(i, j), ws, pos });
      i = j;
      continue;
    }
    throw new MiniError(`Mini-notation: unexpected "${c}" at position ${i} in "${src}"`);
  }
  return toks;
}

const conv = (s) => (NUM_RE.test(s) ? Number(s) : s);
function atomValue(w) {
  if (w.includes(':')) return w.split(':').filter((s) => s !== '').map(conv);
  return conv(w);
}

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = lex(src);
    this.i = 0;
    this.seed = 0;
  }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  fail(msg) { throw new MiniError(`Mini-notation: ${msg} in "${this.src}"`); }
  expect(t) {
    const k = this.next();
    if (!k || k.t !== t) this.fail(`expected "${t}"${k ? ` but got "${k.v ?? k.t}"` : ' before end'}`);
  }
  number() {
    const k = this.next();
    if (!k || k.t !== 'word' || !NUM_RE.test(k.v)) this.fail('expected a number');
    return Number(k.v);
  }
  parseAll() {
    const node = this.parseStack();
    if (this.i < this.toks.length) this.fail(`unexpected "${this.peek().v ?? this.peek().t}"`);
    return node;
  }
  parseStack() {
    const layers = [this.parseSeq()];
    let sep = null;
    while (this.peek() && (this.peek().t === ',' || this.peek().t === '|')) {
      const t = this.next().t;
      if (sep && sep !== t) this.fail('cannot mix "," and "|" in one group');
      sep = t;
      layers.push(this.parseSeq());
    }
    if (layers.length === 1) return layers[0];
    return sep === ',' ? { type: 'stack', layers } : { type: 'rand', layers, seed: this.seed++ };
  }
  parseSeq() {
    const groups = [];
    let steps = [];
    for (;;) {
      const k = this.peek();
      if (!k || CLOSERS.has(k.t)) break;
      if (k.t === '.') { this.next(); groups.push(steps); steps = []; continue; }
      if (k.t === '_') {
        this.next();
        if (!steps.length) this.fail('"_" needs a preceding step');
        steps[steps.length - 1] = { ...steps[steps.length - 1], weight: steps[steps.length - 1].weight + 1 };
        continue;
      }
      if (k.t === '!' && k.ws) {
        this.next();
        if (!steps.length) this.fail('"!" needs a preceding step');
        steps.push({ ...steps[steps.length - 1] });
        continue;
      }
      if (k.t === '..') {
        this.next();
        const prev = steps.pop();
        const [nxt] = this.parseStep();
        const a = prev?.node.value;
        const b = nxt?.node.value;
        if (typeof a !== 'number' || typeof b !== 'number') this.fail('".." needs numbers on both sides');
        const dir = b >= a ? 1 : -1;
        const loc = prev.node.loc && nxt.node.loc ? { start: prev.node.loc.start, end: nxt.node.loc.end } : undefined;
        for (let v = a; dir > 0 ? v <= b : v >= b; v += dir) steps.push({ node: { type: 'atom', value: v, loc }, weight: 1 });
        continue;
      }
      steps.push(...this.parseStep());
    }
    if (groups.length) {
      groups.push(steps);
      return {
        type: 'seq',
        steps: groups.filter((g) => g.length).map((g) => ({ node: { type: 'seq', steps: g }, weight: 1 })),
      };
    }
    return { type: 'seq', steps };
  }
  parseStep() {
    let node = this.parseTerm();
    let weight = 1;
    let reps = 1;
    for (;;) {
      const k = this.peek();
      if (!k) break;
      if (k.t === '*' || k.t === '/') {
        this.next();
        node = { type: k.t === '*' ? 'fast' : 'slow', node, arg: this.parseTerm() };
        continue;
      }
      if (k.t === '@') { this.next(); weight = this.number(); continue; }
      if (k.t === '!' && !k.ws) {
        this.next();
        const nk = this.peek();
        if (nk && nk.t === 'word' && !nk.ws && NUM_RE.test(nk.v)) { this.next(); reps += Number(nk.v) - 1; } else reps += 1;
        continue;
      }
      if (k.t === '?' && !k.ws) {
        this.next();
        let amount = 0.5;
        const nk = this.peek();
        if (nk && nk.t === 'word' && !nk.ws && NUM_RE.test(nk.v)) { this.next(); amount = Number(nk.v); }
        node = { type: 'degrade', node, amount, seed: this.seed++ };
        continue;
      }
      if (k.t === '(' ) {
        this.next();
        const args = [this.parseSeq()];
        while (this.peek()?.t === ',') { this.next(); args.push(this.parseSeq()); }
        this.expect(')');
        if (args.length < 2) this.fail('euclid needs (pulses,steps[,rotation])');
        node = { type: 'euclid', node, args };
        continue;
      }
      break;
    }
    return Array.from({ length: Math.max(1, reps) }, () => ({ node, weight }));
  }
  parseTerm() {
    const k = this.next();
    if (!k) this.fail('unexpected end');
    switch (k.t) {
      case '[': { const n = this.parseStack(); this.expect(']'); return n; }
      case '<': { const n = this.parseStack(); this.expect('>'); return { type: 'alt', node: n }; }
      case '{': {
        const layers = [this.parseSeq()];
        while (this.peek()?.t === ',') { this.next(); layers.push(this.parseSeq()); }
        this.expect('}');
        let steps = null;
        if (this.peek()?.t === '%') { this.next(); steps = this.number(); }
        return { type: 'poly', layers, steps };
      }
      case '~': return { type: 'rest' };
      case 'word': return { type: 'atom', value: atomValue(k.v), loc: { start: k.pos, end: k.pos + k.v.length } };
      default: return this.fail(`unexpected "${k.t}"`);
    }
  }
}

/** Parses mini-notation into an AST (exposed for tooling/tests). */
export function parseMini(src) {
  return new Parser(String(src)).parseAll();
}

const seqWeight = (steps) => steps.reduce((s, x) => s + x.weight, 0);

function seqPat(steps) {
  if (!steps.length) return silence;
  if (steps.length === 1) return toPat(steps[0].node);
  if (steps.every((s) => s.weight === steps[0].weight)) return fastcat(...steps.map((s) => toPat(s.node)));
  return timeCat(...steps.map((s) => [s.weight, toPat(s.node)]));
}

function altPat(node) {
  if (node.type === 'seq') {
    if (!node.steps.length) return silence;
    if (node.steps.every((s) => s.weight === 1)) return slowcat(...node.steps.map((s) => toPat(s.node)));
    return seqPat(node.steps)._slow(seqWeight(node.steps));
  }
  if (node.type === 'stack') return stack(...node.layers.map(altPat));
  return toPat(node);
}

/** A plain number if the node is a single numeric atom, else a pattern. */
function argOf(node) {
  if (node.type === 'atom' && typeof node.value === 'number') return node.value;
  if (node.type === 'seq' && node.steps.length === 1 && node.steps[0].node.type === 'atom'
    && typeof node.steps[0].node.value === 'number') return node.steps[0].node.value;
  return toPat(node);
}

function toPat(node) {
  switch (node.type) {
    // each atom remembers its source range (relative to the string) for live highlighting
    case 'atom': return pure(node.value, node.loc ? { locations: [node.loc] } : undefined);
    case 'rest': return silence;
    case 'seq': return seqPat(node.steps);
    case 'stack': return stack(...node.layers.map(toPat));
    case 'rand': return chooseInWith(rand._early(0.1 * node.seed)._segment(1), node.layers.map(toPat));
    case 'alt': return altPat(node.node);
    case 'poly': {
      const layers = node.layers.filter((l) => l.steps.length);
      if (!layers.length) return silence;
      const base = node.steps ?? seqWeight(layers[0].steps);
      return stack(...layers.map((l) => seqPat(l.steps)._fast(base / seqWeight(l.steps))));
    }
    case 'fast': return toPat(node.node).fast(argOf(node.arg));
    case 'slow': return toPat(node.node).slow(argOf(node.arg));
    case 'degrade': return toPat(node.node)._degradeByWith(rand._early(0.1 * node.seed), node.amount);
    case 'euclid': {
      const [k, n, r] = node.args.map(argOf);
      return toPat(node.node).euclidRot(k, n, r ?? 0);
    }
    default: throw new MiniError(`Mini-notation: unknown node ${node.type}`);
  }
}

const cache = new Map();
/** Parse a mini-notation string into a Pattern (cached; patterns are immutable). */
export function mini(src) {
  const key = String(src);
  let pat = cache.get(key);
  if (!pat) {
    pat = toPat(parseMini(key));
    if (cache.size > 2000) cache.clear();
    cache.set(key, pat);
  }
  return pat;
}

export { Pattern };
