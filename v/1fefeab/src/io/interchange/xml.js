// Tiny XML toolkit (Node + browser, no DOMParser needed).
//
//   el(name, attrs?, ...children) -> XmlNode   (children: XmlNode | string | null | arrays)
//   toXml(node, {declaration=true, indent='  '}) -> string
//   parseXml(text) -> XmlNode (the root element)
//   XmlNode = { name, attrs: {k: string}, children: XmlNode[], text: string }
// Helpers: child(node, name), children(node, name), walk(node, fn).
// Supports elements, attributes, text, CDATA, comments, processing instructions, the
// predefined + numeric entities. DOCTYPE internal subsets are skipped, not interpreted.

export function el(name, attrs = {}, ...kids) {
  const node = { name, attrs: {}, children: [], text: '' };
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
    node.attrs[k] = typeof v === 'number' ? fmtNum(v) : String(v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    if (typeof c === 'string' || typeof c === 'number') node.text += String(c);
    else node.children.push(c);
  };
  kids.forEach(add);
  return node;
}

/** Numbers: up to 6 decimals, no trailing zeros, never exponent notation. */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

export function escapeXml(s, attr = false) {
  let out = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (attr) out = out.replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
  // strip characters XML 1.0 cannot carry
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

export function toXml(node, { declaration = true, indent = '  ' } = {}) {
  const lines = [];
  if (declaration) lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  const write = (n, depth) => {
    const pad = indent.repeat(depth);
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escapeXml(v, true)}"`).join('');
    if (!n.children.length && !n.text) { lines.push(`${pad}<${n.name}${attrs}/>`); return; }
    if (!n.children.length) { lines.push(`${pad}<${n.name}${attrs}>${escapeXml(n.text)}</${n.name}>`); return; }
    lines.push(`${pad}<${n.name}${attrs}>${n.text ? escapeXml(n.text) : ''}`);
    for (const c of n.children) write(c, depth + 1);
    lines.push(`${pad}</${n.name}>`);
  };
  write(node, 0);
  return lines.join('\n') + '\n';
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITIES[e] ?? m;
  });
}

/** Parses an XML document and returns its root element. Throws a readable Error on malformed input. */
export function parseXml(text) {
  const s = String(text).replace(/^﻿/, '');
  let i = 0;
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const fail = (msg) => {
    const line = s.slice(0, i).split('\n').length;
    throw new Error(`XML parse error (line ${line}): ${msg}`);
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      if (s.slice(i).trim()) top.text += decodeEntities(s.slice(i));
      break;
    }
    if (lt > i) {
      const t = s.slice(i, lt);
      if (stack.length > 1) top.text += decodeEntities(t);
      else if (t.trim()) fail('text outside the root element');
    }
    i = lt;
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4);
      if (e < 0) fail('unterminated comment');
      i = e + 3;
    } else if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      if (e < 0) fail('unterminated CDATA');
      top.text += s.slice(i + 9, e);
      i = e + 3;
    } else if (s.startsWith('<?', i)) {
      const e = s.indexOf('?>', i + 2);
      if (e < 0) fail('unterminated processing instruction');
      i = e + 2;
    } else if (s.startsWith('<!', i)) {
      // DOCTYPE (possibly with an internal subset [...])
      let depth = 0;
      let j = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        else if (s[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (s[i + 1] === '/') {
      const e = s.indexOf('>', i);
      if (e < 0) fail('unterminated end tag');
      const name = s.slice(i + 2, e).trim();
      const open = stack.pop();
      if (!open || open === root || open.name !== name) fail(`unexpected </${name}>${open && open !== root ? ` (expected </${open.name}>)` : ''}`);
      i = e + 1;
    } else {
      const m = /^<([A-Za-z_:][\w:.-]*)/.exec(s.slice(i, i + 256));
      if (!m) fail('invalid tag');
      const node = { name: m[1], attrs: {}, children: [], text: '' };
      i += m[0].length;
      for (;;) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === '/' && s[i + 1] === '>') { i += 2; top.children.push(node); break; }
        if (s[i] === '>') { i++; top.children.push(node); stack.push(node); break; }
        const am = /^([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(s.slice(i, i + 65536));
        if (!am) fail(`malformed attribute in <${node.name}>`);
        node.attrs[am[1]] = decodeEntities((am[3] ?? am[4]).replace(/[\t\n\r]/g, ' '));
        i += am[0].length;
      }
      if (stack.length === 1 && root.children.length > 1) fail('more than one root element');
    }
  }
  if (stack.length > 1) fail(`unclosed <${stack[stack.length - 1].name}>`);
  if (!root.children.length) fail('no root element');
  return root.children[0];
}

export const child = (node, name) => node?.children.find((c) => c.name === name) || null;
export const children = (node, name) => (node?.children || []).filter((c) => name === undefined || c.name === name);

/** Depth-first walk: fn(node, parent, ancestors[]) — return false to skip a subtree. */
export function walk(node, fn, parent = null, ancestors = []) {
  if (fn(node, parent, ancestors) === false) return;
  const next = [...ancestors, node];
  for (const c of node.children) walk(c, fn, node, next);
}

/** Number attribute (or fallback). */
export function numAttr(node, name, fallback = null) {
  const v = node?.attrs?.[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function boolAttr(node, name, fallback = null) {
  const v = node?.attrs?.[name];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}
