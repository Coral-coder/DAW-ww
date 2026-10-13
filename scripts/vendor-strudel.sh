#!/usr/bin/env bash
# Rebuilds vendor/strudel/ — the prebuilt ESM bundles of the real Strudel engine (AGPL-3.0-or-later,
# https://strudel.cc, https://codeberg.org/uzu/strudel) that daW³ lazy-loads at runtime.
#
#   scripts/vendor-strudel.sh [work-dir]
#
# Needs node + npm (registry access) at build time only; nothing is installed into the repo.
# To update Strudel: bump the versions below, run the script, run `npm test` and
# `node tests/strudel-compat.mjs`, then check the app in a browser.
#
# Output (all minified ESM, no bare imports, no network at import time):
#   vendor/strudel/strudel-core.mjs   @strudel/core + mini + tonal + transpiler + draw (pure JS, Node-importable)
#   vendor/strudel/strudel-audio.mjs  superdough + @strudel/webaudio + soundfonts (browser only)
#   vendor/strudel/strudel-shared-*.mjs  code both entries share (one Pattern class, one sound registry)
#   vendor/strudel/licenses/          LICENSE / NOTICE of every bundled package
#   vendor/strudel/VERSION            exact versions of everything bundled
set -euo pipefail

CORE_VERSION=1.2.6        # @strudel/core, mini, tonal, transpiler, draw
AUDIO_VERSION=1.3.0       # superdough, @strudel/webaudio, @strudel/soundfonts
ESBUILD_VERSION=0.25.10

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/strudel"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
cd "$WORK"

cat > package.json <<JSON
{ "name": "daw3-strudel-vendor", "private": true, "type": "module",
  "dependencies": {
    "@strudel/core": "$CORE_VERSION", "@strudel/mini": "$CORE_VERSION", "@strudel/tonal": "$CORE_VERSION",
    "@strudel/transpiler": "$CORE_VERSION", "@strudel/draw": "$CORE_VERSION",
    "superdough": "$AUDIO_VERSION", "@strudel/webaudio": "$AUDIO_VERSION", "@strudel/soundfonts": "$AUDIO_VERSION",
    "esbuild": "$ESBUILD_VERSION"
  } }
JSON
npm install --no-audit --no-fund --loglevel=error

cat > entry-core.mjs <<'JS'
// Pattern engine: everything user code needs to evaluate and query patterns.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as transpiler from '@strudel/transpiler';
import * as draw from '@strudel/draw';
import { parse as acornParse } from 'acorn';
export { core, mini, tonal, transpiler, draw, acornParse };
JS
cat > entry-audio.mjs <<'JS'
// Audio engine: superdough (Strudel's synths / sampler / effects) + sound registries.
import * as superdough from 'superdough';
import * as webaudio from '@strudel/webaudio';
import * as soundfonts from '@strudel/soundfonts';
export { superdough, webaudio, soundfonts };
JS
cat > build.mjs <<'JS'
import * as esbuild from 'esbuild';
const out = process.argv[2];
const common = { bundle: true, format: 'esm', minify: true, target: 'es2020', platform: 'neutral',
  mainFields: ['module', 'main'], conditions: ['import', 'module', 'default'], legalComments: 'none',
  define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' };
// one build, two entry points: code shared by both (the pattern engine) lands in a common chunk, so
// strudel-audio.mjs and strudel-core.mjs share a single Pattern class / sound registry
// Three small patches of superdough's dist (both checked; the build fails if they stop applying):
// 1. daW³ renders code tracks offline (WAV export) with superdough in an OfflineAudioContext while the
// realtime context lives on. superdough pools audio nodes per type, not per context, so a pooled node
// of one context could be handed to the other ("cannot connect to a different context"): only reuse
// pooled nodes of the context daW³ is currently triggering (globalThis.__daw3SuperdoughCtx).
// 2. export daw3WorkletUrls() — the AudioWorklet modules superdough needs on each context.
// 3. webAudioTimeout() builds its helper node on the context it is given (not the ambient one).
import { readFile } from 'node:fs/promises';
const patchSuperdough = { name: 'patch-superdough', setup(b) {
  b.onLoad({ filter: /superdough[\\/]dist[\\/]index\.mjs$/ }, async (a) => {
    let src = await readFile(a.path, 'utf8');
    const re = /if \((\w+) = (\w+)\.pop\(\)\?\.deref\(\), \1 != null && (\w+)\(\1\)\)/;
    if (!re.test(src)) throw new Error('superdough node-pool patch did not apply — review it for this version');
    src = src.replace(re, (_, o, n, g) =>
      `if (${o} = ${n}.pop()?.deref(), ${o} != null && ${g}(${o}) && (!globalThis.__daw3SuperdoughCtx || ${o}.context === globalThis.__daw3SuperdoughCtx))`);
    // expose the AudioWorklet module URLs, so daW³ can add them to every context it renders with
    // (superdough's loadWorklets() shares one in-flight promise across contexts)
    const wl = /const (\w+) = (\w+)\(\), (\w+) = (\w+)\.concat\(\[(\w+)\]\);\n(\s*)\w+ = Promise\.all\(\3\.map\(\(\w+\) => \1\.audioWorklet\.addModule/;
    const m = wl.exec(src);
    if (!m) throw new Error('superdough worklet-url patch did not apply — review it for this version');
    src += `\nexport const daw3WorkletUrls = () => ${m[4]}.concat([${m[5]}]);\n`;
    // webAudioTimeout(ctx, …) (runs when a sound ends) builds its muted gain on the *ambient* context:
    // build it on the context it was given
    const to = /const (\w+) = new ConstantSourceNode\((\w+)\), (\w+) = (\w+)\(0\);\n(\s*)return \3\.connect\(\2\.destination\)/;
    if (!to.test(src)) throw new Error('superdough webAudioTimeout patch did not apply — review it for this version');
    src = src.replace(to, (all, a, e, c, g) => all.replace(`${g}(0)`, `new GainNode(${e}, { gain: 0 })`));
    return { loader: 'js', contents: src };
  });
} };
await esbuild.build({ ...common, plugins: [patchSuperdough], entryPoints: { 'strudel-core': 'entry-core.mjs', 'strudel-audio': 'entry-audio.mjs' },
  outdir: out, splitting: true, outExtension: { '.js': '.mjs' }, chunkNames: 'strudel-shared-[hash]' });
JS
rm -rf "$OUT"
mkdir -p "$OUT/licenses"
node build.mjs "$OUT"

# licenses of every bundled package + the exact versions
{
  echo "Strudel (https://strudel.cc, https://codeberg.org/uzu/strudel) — AGPL-3.0-or-later"
  echo "Bundled by scripts/vendor-strudel.sh with esbuild $ESBUILD_VERSION on $(date -u +%Y-%m-%d)"
  echo
} > "$OUT/VERSION"
node -e '
const fs = require("fs"), path = require("path");
const out = process.argv[1];
const seen = new Set();
const lines = [];
const texts = new Map();
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (name.startsWith("@")) { walk(p); continue; }
    const pj = path.join(p, "package.json");
    if (!fs.existsSync(pj)) continue;
    const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
    if (pkg.name === "esbuild" || pkg.name.startsWith("@esbuild/") || seen.has(pkg.name)) continue;
    seen.add(pkg.name);
    lines.push(`${pkg.name}@${pkg.version}  ${pkg.license || ""}`);
    for (const f of fs.readdirSync(p)) {
      if (!/^(licen[cs]e|notice|copying)/i.test(f)) continue;
      // identical texts (the AGPL of every Strudel package, the MIT of every tonal package) are stored once
      const text = fs.readFileSync(path.join(p, f), "utf8");
      const key = text.replace(/\s+/g, " ").trim();
      if (!texts.has(key)) { const file = `${String(pkg.license || "license").replace(/[^\w.-]+/g, "_")}--${pkg.name.replace("/", "__")}--${f}`; fs.writeFileSync(path.join(out, "licenses", file), text); texts.set(key, file); }
      lines[lines.length - 1] += `  (licenses/${texts.get(key)})`;
    }
    if (fs.existsSync(path.join(p, "node_modules"))) walk(path.join(p, "node_modules"));
  }
}
// @strudel/core first, so the shared AGPL text is filed under its name
walk("node_modules/@strudel");
walk("node_modules");
fs.appendFileSync(path.join(out, "VERSION"), lines.sort().join("\n") + "\n");
' "$OUT"
ls -la "$OUT"
cat "$OUT/VERSION"
