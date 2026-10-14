// Mac app shell (Electron): pure helpers + syntax checks. Electron itself isn't installed for `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('../desktop/lib.cjs');

test('desktop: main / preload / lib parse', () => {
  for (const f of ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/lib.cjs', 'desktop/native-bridge.cjs', 'desktop/audio-server.cjs', 'desktop/native-server.cjs', 'desktop/plughost.cjs', 'src/ui/native.js', 'src/ui/audio-prefs.js', 'src/native/client.js', 'src/native/bridge-worklet.js', 'src/native/pump-worker.js', 'src/native/export.js', 'src/plugins/native.js']) execFileSync(process.execPath, ['--check', path.join(root, f)]);
});

test('desktop: app:// paths stay inside the app folder', () => {
  const r = '/Apps/daw3';
  assert.equal(lib.resolveAppPath(r, '/'), path.join(r, 'index.html'));
  assert.equal(lib.resolveAppPath(r, '/src/main.js'), path.join(r, 'src/main.js'));
  assert.equal(lib.resolveAppPath(r, '/styles/a%20b.css'), path.join(r, 'styles/a b.css'));
  assert.equal(lib.resolveAppPath(r, '/../etc/passwd'), null, '.. cannot climb above root');
  assert.equal(lib.resolveAppPath(r, '/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(lib.resolveAppPath(r, '/node_modules/x.js'), null);
  assert.equal(lib.resolveAppPath(r, '/.git/config'), null);
  assert.equal(lib.resolveAppPath(r, '/%E0%A4%A'), null, 'bad escapes rejected');
  assert.equal(lib.mimeFor('a/b.js'), 'text/javascript; charset=utf-8');
  assert.equal(lib.mimeFor('x.css'), 'text/css; charset=utf-8');
  assert.equal(lib.mimeFor('x.wasm'), 'application/wasm');
});

test('desktop: Finder paths are classified (projects, audio, folders)', () => {
  const stat = (p) => ({ isDirectory: () => p.endsWith('/Crate') });
  const c = lib.classifyPaths(['/m/a.mp3', '/m/B.FLAC', '/p/set.daW3', '/m/Crate', '/m/notes.txt'], stat);
  assert.deepEqual(c.audio, ['/m/a.mp3', '/m/B.FLAC']);
  assert.deepEqual(c.projects, ['/p/set.daW3']);
  assert.deepEqual(c.folders, ['/m/Crate']);
  assert.deepEqual(c.other, ['/m/notes.txt']);
  assert.equal(lib.saveFiltersFor('Song.daW3')[0].extensions[0], 'daW3');
  assert.equal(lib.saveFiltersFor('Song.wav')[0].name, 'WAV audio');
  const o = lib.openDialogOptions({ kind: 'audio', multiple: true }, true);
  assert.ok(o.properties.includes('openDirectory') && o.properties.includes('multiSelections'));
  assert.ok(o.filters[0].extensions.includes('flac'));
});

test('desktop: native menu has File / Edit / View with the right commands', () => {
  const sent = [];
  let opened = 0, imported = 0;
  const t = lib.buildMenuTemplate({ isMac: true, send: (c, p) => sent.push([c, p]), openProject: () => opened++, importMusic: () => imported++ });
  const labels = t.map((m) => m.label || m.role);
  assert.deepEqual(labels.slice(0, 4), ['daW³', 'File', 'Edit', 'View']);
  const file = t.find((m) => m.label === 'File').submenu;
  const item = (menu, label) => menu.find((i) => i.label === label);
  item(file, 'Open Project…').click(); item(file, 'Import Music…').click(); item(file, 'Save Project…').click();
  item(file, 'Export').submenu[0].click();
  assert.equal(opened, 1); assert.equal(imported, 1);
  assert.deepEqual(sent.map((s) => s[0]), ['save-project', 'export-wav']);
  assert.equal(item(file, 'Open Project…').accelerator, 'CmdOrCtrl+O');
  const view = t.find((m) => m.label === 'View').submenu;
  view[8].click();
  assert.deepEqual(sent.at(-1), ['show-view', 'decks']);
  const edit = t.find((m) => m.label === 'Edit').submenu;
  assert.ok(edit.some((i) => i.role === 'paste'));
  assert.equal(lib.buildMenuTemplate({ isMac: false })[0].label, 'File', 'no app menu off macOS');
});

test('desktop: package.json wires Electron without touching npm test', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.equal(pkg.main, 'desktop/main.cjs');
  assert.equal(pkg.scripts['mac:dev'], 'electron .');
  assert.ok(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription);
  assert.ok(pkg.build.fileAssociations.some((f) => f.ext.includes('daW3')));
  for (const g of pkg.build.files.filter((f) => !f.includes('*'))) assert.ok(readFileSync(path.join(root, g)), g);
  const png = readFileSync(path.join(root, 'build/icon.png'));
  assert.equal(png.readUInt32BE(16), 1024, 'icon is 1024 px wide');
});

test('desktop: icon generator is deterministic and valid PNG', async () => {
  const { renderIcon } = await import('../scripts/make-icon.mjs');
  const a = renderIcon(64), b = renderIcon(64);
  assert.deepEqual(a, b);
  assert.deepEqual([...a.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('desktop: cross-origin isolation headers (SharedArrayBuffer for the audio bridge) + Audio Settings menu', () => {
  const hd = lib.appHeaders('/x/index.html');
  assert.equal(hd['cross-origin-opener-policy'], 'same-origin');
  assert.equal(hd['cross-origin-embedder-policy'], 'credentialless');
  assert.equal(hd['content-type'], 'text/html; charset=utf-8');
  const sent = [];
  for (const isMac of [true, false]) {
    const t = lib.buildMenuTemplate({ isMac, send: (c) => sent.push(c) });
    const item = t.flatMap((m) => m.submenu || []).find((i) => i.label === 'Audio & Plugin Settings…');
    assert.ok(item, `settings item (isMac=${isMac})`);
    assert.equal(item.accelerator, 'CmdOrCtrl+,');
    item.click();
  }
  assert.deepEqual(sent, ['audio-prefs', 'audio-prefs']);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.extraResources[0].filter, ['daw3_audio.node', 'daw3-plughost']);
  assert.ok(pkg.build.files.includes('!desktop/native/**'), 'native sources stay out of the app bundle');
  assert.ok(pkg.build.asarUnpack.includes('src/native/**'));
});
