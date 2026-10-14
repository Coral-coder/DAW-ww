// Minimal XML Schema validator — enough of XSD 1.0 for the DAWproject schemas:
// global/local elements, element refs, complexType with complexContent/extension, sequence / choice with
// minOccurs / maxOccurs, attributes (use="required"), simple types (enumeration restrictions, lists),
// xs:boolean / xs:int / xs:double / xs:ID / xs:IDREF checks and ID/IDREF integrity.
// Content models are compiled to regular expressions over the child-element names.
import { parseXml, children } from '../../src/io/interchange/xml.js';

const strip = (q) => String(q || '').replace(/^xs:/, '');

export function loadSchema(xsdText) {
  const root = parseXml(xsdText);
  const elements = new Map();
  const complex = new Map();
  const simple = new Map();
  for (const n of root.children) {
    if (n.name === 'xs:element') elements.set(n.attrs.name, n);
    else if (n.name === 'xs:complexType') complex.set(n.attrs.name, n);
    else if (n.name === 'xs:simpleType') simple.set(n.attrs.name, n);
  }
  const cache = new Map();

  const occurs = (n) => ({ min: n.attrs.minOccurs !== undefined ? Number(n.attrs.minOccurs) : 1, max: n.attrs.maxOccurs === 'unbounded' ? Infinity : n.attrs.maxOccurs !== undefined ? Number(n.attrs.maxOccurs) : 1 });

  function particle(n) {
    if (n.name === 'xs:element') {
      if (n.attrs.ref) return { kind: 'el', name: n.attrs.ref, decl: elements.get(n.attrs.ref), ...occurs(n) };
      return { kind: 'el', name: n.attrs.name, decl: n, ...occurs(n) };
    }
    if (n.name === 'xs:sequence' || n.name === 'xs:choice') {
      return { kind: n.name === 'xs:sequence' ? 'seq' : 'choice', items: n.children.filter((c) => /^xs:(element|sequence|choice)$/.test(c.name)).map(particle), ...occurs(n) };
    }
    throw new Error(`xsd-lite: unsupported particle ${n.name}`);
  }

  function resolveComplex(ct) {
    if (cache.has(ct)) return cache.get(ct);
    const out = { attrs: new Map(), parts: [] };
    const own = (node) => {
      for (const c of node.children) {
        if (c.name === 'xs:attribute') out.attrs.set(c.attrs.name, { type: c.attrs.type ? strip(c.attrs.type) : null, inline: children(c, 'xs:simpleType')[0] || null, required: c.attrs.use === 'required' });
        else if (/^xs:(sequence|choice)$/.test(c.name)) out.parts.push(particle(c));
      }
    };
    const cc = children(ct, 'xs:complexContent')[0];
    if (cc) {
      const ext = children(cc, 'xs:extension')[0];
      if (!ext) throw new Error('xsd-lite: only complexContent/extension is supported');
      const base = resolveComplex(complex.get(ext.attrs.base));
      for (const [k, v] of base.attrs) out.attrs.set(k, v);
      out.parts.push(...base.parts);
      own(ext);
    } else own(ct);
    out.regex = new RegExp(`^${out.parts.map(toRegex).join('')}$`);
    out.decls = new Map();
    const collect = (p) => { if (p.kind === 'el') { if (!out.decls.has(p.name)) out.decls.set(p.name, p.decl); } else p.items.forEach(collect); };
    out.parts.forEach(collect);
    cache.set(ct, out);
    return out;
  }

  function toRegex(p) {
    const q = p.min === 1 && p.max === 1 ? '' : `{${p.min},${p.max === Infinity ? '' : p.max}}`;
    if (p.kind === 'el') return `(?:<${p.name}>)${q}`;
    const inner = p.items.map(toRegex);
    if (!inner.length) return '';
    return `(?:${p.kind === 'seq' ? inner.join('') : inner.join('|')})${q}`;
  }

  function checkSimple(typeName, inline, value, where, errors, ids, refs) {
    const v = String(value);
    if (inline) {
      const list = children(inline, 'xs:list')[0];
      if (list) { for (const tok of v.split(/\s+/).filter(Boolean)) checkSimple(strip(list.attrs.itemType), null, tok, where, errors, ids, refs); return; }
    }
    switch (typeName) {
      case null: case undefined: case 'string': return;
      case 'boolean': if (!/^(true|false|1|0)$/.test(v)) errors.push(`${where}: "${v}" is not an xs:boolean`); return;
      case 'int': if (!/^[+-]?\d+$/.test(v) || Math.abs(Number(v)) > 2147483647) errors.push(`${where}: "${v}" is not an xs:int`); return;
      case 'double': if (!/^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|-INF|NaN)$/.test(v)) errors.push(`${where}: "${v}" is not an xs:double`); return;
      case 'ID': if (!/^[A-Za-z_][\w.-]*$/.test(v)) errors.push(`${where}: "${v}" is not an xs:ID`); else if (ids.has(v)) errors.push(`${where}: duplicate ID "${v}"`); else ids.add(v); return;
      case 'IDREF': refs.push({ v, where }); return;
      default: {
        const st = simple.get(typeName);
        if (!st) { errors.push(`${where}: unknown simple type ${typeName}`); return; }
        const list = children(st, 'xs:list')[0];
        if (list) { for (const tok of v.split(/\s+/).filter(Boolean)) checkSimple(strip(list.attrs.itemType), null, tok, where, errors, ids, refs); return; }
        const r = children(st, 'xs:restriction')[0];
        const enums = children(r, 'xs:enumeration').map((e) => e.attrs.value);
        if (enums.length && !enums.includes(v)) errors.push(`${where}: "${v}" not in {${enums.join(', ')}}`);
      }
    }
  }

  function validateElement(node, decl, path, errors, ids, refs) {
    const where = `${path}/${node.name}`;
    const typeName = decl.attrs.type ? strip(decl.attrs.type) : null;
    const inlineCt = children(decl, 'xs:complexType')[0];
    if (!inlineCt && (typeName === 'string' || (typeName && !complex.has(typeName)))) {
      if (node.children.length) errors.push(`${where}: simple-content element has child elements`);
      return;
    }
    const ct = inlineCt || complex.get(typeName);
    if (ct.attrs.abstract === 'true') errors.push(`${where}: element of abstract type ${typeName}`);
    const info = resolveComplex(ct);
    for (const [k, v] of Object.entries(node.attrs)) {
      if (k.startsWith('xmlns')) continue;
      const a = info.attrs.get(k);
      if (!a) { errors.push(`${where}: attribute "${k}" not allowed`); continue; }
      checkSimple(a.type, a.inline, v, `${where}@${k}`, errors, ids, refs);
    }
    for (const [k, a] of info.attrs) if (a.required && !(k in node.attrs)) errors.push(`${where}: missing required attribute "${k}"`);
    const seq = node.children.map((c) => `<${c.name}>`).join('');
    if (!info.regex.test(seq)) errors.push(`${where}: children [${node.children.map((c) => c.name).join(', ')}] do not match the content model`);
    if (node.text.trim()) errors.push(`${where}: unexpected text content`);
    node.children.forEach((c) => {
      const d = info.decls.get(c.name);
      if (d) validateElement(c, d, where, errors, ids, refs);
    });
  }

  return {
    /** -> array of error strings (empty = valid). */
    validate(xmlText) {
      const doc = typeof xmlText === 'string' ? parseXml(xmlText) : xmlText;
      const decl = elements.get(doc.name);
      if (!decl) return [`root <${doc.name}> is not a global element of the schema`];
      const errors = [];
      const ids = new Set();
      const refs = [];
      validateElement(doc, decl, '', errors, ids, refs);
      for (const r of refs) if (!ids.has(r.v)) errors.push(`${r.where}: IDREF "${r.v}" does not resolve`);
      return errors;
    },
  };
}
