// The Faust compiler ships with the app (vendor/faustwasm): every catalog Faust plugin must compile with it, offline,
// as the kind of plugin the catalog offers it as; failures must produce specific messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  FAUSTWASM_VERSION, FAUSTWASM_LOCAL, normFaustLabel, faustwasmSources, compilerLoadError, loadFaustCompiler, getFaustFactory, looksPolyphonic,
} from '../src/plugins/faust.js';
import { CATALOG, pluginParams } from '../src/plugins/catalog.js';
import { FAUST_INSTRUMENTS, FAUST_EFFECTS, FAUST_TEMPLATE } from '../src/plugins/faust-library.js';
import { GENRE_FAUST, EXTRA_FAUST } from '../src/gen/plugins.js';
import { friendlyError, userError } from '../src/plugins/status.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = (f) => new URL(`../vendor/faustwasm/${f}`, import.meta.url);

test('the Faust compiler is bundled: vendor/faustwasm holds the pinned faustwasm version', () => {
  for (const f of ['dist/esm/index.js', 'libfaust-wasm/libfaust-wasm.js', 'libfaust-wasm/libfaust-wasm.wasm', 'libfaust-wasm/libfaust-wasm.data', 'COPYING.txt']) {
    assert.ok(existsSync(vendor(f)), `vendor/faustwasm/${f} is missing — run scripts/vendor-faustwasm.sh`);
    assert.ok(statSync(vendor(f)).size > 1000, f);
  }
  assert.match(readFileSync(vendor('VERSION'), 'utf8'), new RegExp(`@grame/faustwasm@${FAUSTWASM_VERSION.replace(/\./g, '\\.')}\\b`));
  assert.equal(FAUSTWASM_LOCAL, new URL('../vendor/faustwasm/', import.meta.url).href);
  // the bundled copy is tried before the CDN
  assert.deepEqual(faustwasmSources().map((s) => s.id), ['bundled', 'cdn']);
  assert.ok(faustwasmSources().every((s) => s.base.endsWith('/')));
});

test('the desktop app packages vendor/ and serves .wasm with the right MIME type', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('vendor/**/*'));
  const lib = createRequire(import.meta.url)('../desktop/lib.cjs');
  assert.equal(lib.mimeFor('x/libfaust-wasm.wasm'), 'application/wasm');
  assert.equal(lib.mimeFor('x/index.js').split(';')[0], 'text/javascript');
  assert.ok(lib.resolveAppPath(root, '/vendor/faustwasm/libfaust-wasm/libfaust-wasm.wasm'));
});

test('compilerLoadError names each source that failed and what to do', () => {
  const both = compilerLoadError([
    { id: 'bundled', base: 'app://daw3/vendor/faustwasm/', error: 'HTTP 404 for libfaust-wasm.wasm' },
    { id: 'cdn', base: 'https://cdn.jsdelivr.net/npm/@grame/faustwasm@0.19.0/', error: 'network error (Failed to fetch)' },
  ]);
  assert.match(both, /^Could not load the Faust compiler/);
  assert.match(both, /bundled with the app \(vendor\/faustwasm\/\) did not load: HTTP 404 for libfaust-wasm\.wasm/);
  assert.match(both, /cdn\.jsdelivr\.net failed: network error/);
  assert.match(both, /internet connection/);
  assert.match(compilerLoadError([], { noWasm: true }), /WebAssembly.*turned off/);
});

test('loadFaustCompiler: every source failing gives one friendly error (no network involved)', async () => {
  const bogus = new URL('../vendor/does-not-exist/', import.meta.url).href;
  await assert.rejects(loadFaustCompiler({ sources: [{ id: 'bundled', base: bogus }, { id: 'cdn', base: bogus }] }), (e) => {
    assert.equal(e.friendly, true);
    assert.match(e.message, /Could not load the Faust compiler — the copy bundled with the app/);
    assert.match(e.message, /cdn\.jsdelivr\.net failed/);
    assert.equal(friendlyError(e, { kind: 'faust' }), e.message);
    return true;
  });
});

test('friendlyError: a module that failed to import is not reported as a plugin download / compile error', () => {
  const m = friendlyError(new TypeError('Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/@grame/faustwasm@0.19.0/dist/esm/index.js'), { kind: 'faust' });
  assert.match(m, /Could not load the JavaScript module “https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(m, /Could not download the plugin|compile error/);
  assert.match(friendlyError(new TypeError('Failed to fetch'), { url: 'https://x/y.dsp' }), /Could not download “https:\/\/x\/y\.dsp”/);
  assert.equal(friendlyError(userError('Faust plugins need AudioWorklet'), { kind: 'faust' }), 'Faust plugins need AudioWorklet');
});

test('the bundled compiler loads in Node and compiles every catalog Faust plugin as what the catalog offers', async () => {
  const c = await loadFaustCompiler();
  assert.equal(c.source, 'bundled');
  assert.match(c.version, /^2\.\d+/);
  const faust = CATALOG.filter((e) => e.kind === 'faust');
  assert.equal(faust.length, Object.keys(FAUST_INSTRUMENTS).length + Object.keys(FAUST_EFFECTS).length);
  for (const e of faust) {
    const { code } = pluginParams(e);
    if (e.type === 'instrument') {
      assert.ok(looksPolyphonic(code), `${e.id}: freq/gain/gate`);
      const f = await getFaustFactory(code, 'poly');
      assert.equal(f.outputs, 2, `${e.id}: stereo out`);
      assert.ok(f.params.length >= 2, `${e.id}: has knobs`);
      assert.ok(!f.params.some((p) => /^(freq|gain|gate)$/.test(p.label)), `${e.id}: voice controls are not knobs`);
    } else {
      const f = await getFaustFactory(code, 'mono');
      assert.equal(f.inputs, 2, `${e.id}: stereo in`);
      assert.equal(f.outputs, 2, `${e.id}: stereo out`);
      assert.ok(f.params.length >= 2, `${e.id}: has knobs`);
    }
  }
  const t = await getFaustFactory(FAUST_TEMPLATE, 'poly');
  assert.ok(t.params.length > 0, 'the Faust editor template compiles');
});

test('control values used by generated songs match the compiled controls of each Faust plugin', async () => {
  const labels = async (code, mode) => new Set((await getFaustFactory(code, mode)).params.map((p) => p.label));
  const defs = [...Object.values(GENRE_FAUST), ...Object.values(EXTRA_FAUST)].flatMap((roles) => Object.values(roles));
  for (const d of defs) {
    const have = await labels(FAUST_INSTRUMENTS[d.id].code, 'poly');
    for (const k of Object.keys(d.values)) assert.ok(have.has(k), `${d.id}: no control “${k}” (has ${[...have].join(', ')})`);
  }
  // effects: faustEffect('<id>', { Label: value, … }, …) calls in src/gen/plugins.js
  const src = readFileSync(new URL('../src/gen/plugins.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/faustEffect\('([\w-]+)',\s*\{([^}]*)\}/g)];
  assert.ok(calls.length >= 5);
  for (const [, id, body] of calls) {
    const have = await labels(FAUST_EFFECTS[id].code, 'mono');
    const keys = [...body.matchAll(/(?:^|,)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))\s*:/g)].map((m) => m[1] || m[2] || m[3]);
    assert.ok(keys.length, id);
    for (const k of keys) assert.ok(have.has(k), `${id}: no control “${k}” (has ${[...have].join(', ')})`);
  }
});

test('normFaustLabel: labels Faust rewrote still match the values saved for them', () => {
  assert.equal(normFaustLabel("16'"), normFaustLabel('16-'));
  assert.equal(normFaustLabel("5 1/3'"), normFaustLabel('5 1/3-'));
  assert.notEqual(normFaustLabel("2'"), normFaustLabel("2 2/3'"));
  assert.equal(normFaustLabel('Room size'), normFaustLabel('room_size'));
});
