// Builds tests/fixtures/strudel-tunes/ — the Strudel compatibility corpus (AGPL-3.0-or-later, like Strudel).
//
//   node scripts/collect-strudel-tunes.mjs <strudel-checkout> <npm-packages-dir>
//
// <strudel-checkout>: a checkout of the Strudel repository (github.com/tidalcycles/strudel at
//   84efa664 — the last full tree before the move to codeberg.org/uzu/strudel — or a codeberg checkout).
// <npm-packages-dir>: directory holding the extracted npm tarballs (`npm pack @strudel/core` …, each
//   extracted into <name>-<version>/package) — their sources carry the @example blocks of the reference.
//
// Output: tunes.json (the REPL's example tunes + test tunes + example apps), examples.json (every
// @example of the function reference), docs.json (every MiniRepl tune of the workshop / learn pages).
import fs from 'node:fs';
import path from 'node:path';

const [repo, pkgs] = process.argv.slice(2);
if (!repo || !pkgs) { console.error('usage: node scripts/collect-strudel-tunes.mjs <strudel-checkout> <npm-packages-dir>'); process.exit(1); }
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tests', 'fixtures', 'strudel-tunes');
fs.mkdirSync(OUT, { recursive: true });

/** `export const name = `…`;` template-literal exports of a tunes module. */
function tuneExports(file, source) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/export const (\w+)\s*=\s*`/g)) {
    let i = m.index + m[0].length;
    let code = '';
    for (; i < text.length && text[i] !== '`'; i++) {
      if (text[i] === '\\') { code += text[i + 1]; i++; } else code += text[i];
    }
    out.push({ name: m[1], source, code });
  }
  return out;
}

const tunes = [
  ...tuneExports(path.join(repo, 'website/src/repl/tunes.mjs'), 'website/src/repl/tunes.mjs'),
  // legacy: Tone.js-era tunes Strudel's own test suite no longer runs (pseudo-note variables, .tone(), …)
  ...tuneExports(path.join(repo, 'test/testtunes.mjs'), 'test/testtunes.mjs').map((t) => ({ ...t, legacy: true })),
  ...tuneExports(path.join(repo, 'examples/codemirror-repl/tunes.mjs'), 'examples/codemirror-repl/tunes.mjs'),
  ...tuneExports(path.join(repo, 'examples/minimal-repl/tune.mjs'), 'examples/minimal-repl/tune.mjs'),
];

// @example blocks of the jsdoc'd sources
const examples = [];
for (const dir of fs.readdirSync(pkgs).sort()) {
  const root = path.join(pkgs, dir, 'package');
  if (!fs.existsSync(root)) continue;
  for (const f of fs.readdirSync(root).filter((x) => x.endsWith('.mjs')).sort()) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const c of text.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
      const lines = c[1].split('\n').map((l) => l.replace(/^\s*\* ?/, ''));
      const name = (lines.find((l) => l.startsWith('@name ')) || '').slice(6).trim();
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('@example')) continue;
        const body = [];
        for (i++; i < lines.length && !lines[i].startsWith('@'); i++) body.push(lines[i]);
        i--;
        const code = body.join('\n').trim();
        if (code) examples.push({ name: name || '?', source: `${dir}/${f}`, code });
      }
    }
  }
}

// <MiniRepl tune={`…`} /> blocks of the documentation (english pages)
const docs = [];
const pages = path.join(repo, 'website/src/pages');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return e.name === 'de' ? [] : walk(p);
  return e.name.endsWith('.mdx') ? [p] : [];
});
for (const file of walk(pages).sort()) {
  const text = fs.readFileSync(file, 'utf8');
  let k = 0;
  for (const m of text.matchAll(/tune=\{`/g)) {
    let i = m.index + m[0].length;
    let code = '';
    for (; i < text.length && text[i] !== '`'; i++) {
      if (text[i] === '\\') { code += text[i + 1]; i++; } else code += text[i];
    }
    const name = `${path.basename(file, '.mdx')}#${++k}`;
    // learn/code.mdx: "What happens if we try to 'break' this pattern?" — syntax errors on purpose
    const broken = ['code#2', 'code#3', 'code#4'].includes(name);
    docs.push({ name, source: path.relative(repo, file), code, ...(broken ? { expectError: true } : {}) });
  }
}

const header = { license: 'AGPL-3.0-or-later', origin: 'Strudel — https://strudel.cc, https://codeberg.org/uzu/strudel (c) Strudel contributors' };
fs.writeFileSync(path.join(OUT, 'tunes.json'), JSON.stringify({ ...header, tunes }, null, 1));
fs.writeFileSync(path.join(OUT, 'examples.json'), JSON.stringify({ ...header, tunes: examples }, null, 1));
fs.writeFileSync(path.join(OUT, 'docs.json'), JSON.stringify({ ...header, tunes: docs }, null, 1));
console.log(`tunes ${tunes.length}, reference examples ${examples.length}, docs ${docs.length}`);
