#!/usr/bin/env bash
# Rebuilds vendor/faustwasm/ — the Faust compiler (libfaust as WebAssembly, @grame/faustwasm, LGPL-2.1-or-later,
# https://github.com/grame-cncm/faustwasm) that src/plugins/faust.js loads to compile Faust plugins in the app.
# Shipping it with the app means the built-in Faust instruments / effects load offline and in the desktop app
# without reaching cdn.jsdelivr.net (the CDN is only a fallback when the bundled copy is missing).
#
#   scripts/vendor-faustwasm.sh [work-dir]
#
# Needs npm (registry access) at build time only. To update: bump FAUSTWASM_VERSION in src/plugins/faust.js, run
# this script, `npm test` and `node tools/browser-check/faust-catalog-check.mjs`.
#
# Output (unmodified files from the npm package):
#   vendor/faustwasm/dist/esm/index.js                 the faustwasm ES module (compiler wrapper, AudioWorklet nodes)
#   vendor/faustwasm/libfaust-wasm/libfaust-wasm.js    Emscripten loader
#   vendor/faustwasm/libfaust-wasm/libfaust-wasm.wasm  libfaust compiled to WebAssembly
#   vendor/faustwasm/libfaust-wasm/libfaust-wasm.data  the Faust standard libraries (stdfaust.lib, …)
#   vendor/faustwasm/COPYING.txt, VERSION
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n "s/^export const FAUSTWASM_VERSION = '\([^']*\)'.*/\1/p" "$ROOT/src/plugins/faust.js")"
test -n "$VERSION" || { echo "FAUSTWASM_VERSION not found in src/plugins/faust.js" >&2; exit 1; }
OUT="$ROOT/vendor/faustwasm"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
cd "$WORK"
npm pack "@grame/faustwasm@$VERSION" --silent > /dev/null
rm -rf package && tar xzf "grame-faustwasm-$VERSION.tgz"

rm -rf "$OUT"
mkdir -p "$OUT/dist/esm" "$OUT/libfaust-wasm"
cp package/dist/esm/index.js "$OUT/dist/esm/index.js"
for ext in js wasm data; do cp "package/libfaust-wasm/libfaust-wasm.$ext" "$OUT/libfaust-wasm/"; done
cp package/COPYING.txt "$OUT/COPYING.txt"
{
  echo "@grame/faustwasm@$VERSION  LGPL-2.1-or-later (COPYING.txt)  https://github.com/grame-cncm/faustwasm"
  echo "libfaust-wasm.data holds the Faust libraries (https://github.com/grame-cncm/faustlibraries): LGPL with the"
  echo "Faust exception and other permissive licenses, per library header; code generated from them may be used freely."
  echo "Copied unmodified from the npm package by scripts/vendor-faustwasm.sh on $(date -u +%Y-%m-%d)"
} > "$OUT/VERSION"
ls -la "$OUT" "$OUT/dist/esm" "$OUT/libfaust-wasm"
