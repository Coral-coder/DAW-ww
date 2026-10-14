// Version 1.0.0: the number shown in the app follows package.json, and the build sha is found on GitHub Pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION, buildSha, versionLabel } from '../src/version.js';
import { detectPocket } from '../src/mobile/mode.js';
import { defaultFolders } from '../src/native/plugin-db.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('version: src/version.js matches package.json (1.0.0) and the CHANGELOG has its section', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.version, '1.0.0');
  const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(log, new RegExp(`^## \\[?${VERSION.replace(/\./g, '\\.')}\\]?`, 'm'));
});

test('version: build sha from the stamped build-info, else the GitHub Pages /v/<sha>/ path, else dev', () => {
  assert.equal(buildSha('https://coral-coder.github.io/daw3/v/bc3f44f1234/index.html'), 'bc3f44f');
  assert.equal(buildSha('https://coral-coder.github.io/daw3/pocket/v/f8c7ec5/'), 'f8c7ec5');
  assert.equal(buildSha('app://daw3/index.html'), 'dev');
  assert.equal(versionLabel('x'), `daW³ ${VERSION} (dev)`);
});

test('Pocket: the /pocket/ address opens the Pocket layout unless the user chose otherwise', () => {
  assert.equal(detectPocket({ width: 1440, path: '/daw3/pocket/' }), true);
  assert.equal(detectPocket({ width: 1440, path: '/daw3/pocket/', stored: 'desktop' }), false);
  assert.equal(detectPocket({ width: 1440, path: '/daw3/pocket/', search: '?desktop=1' }), false);
  assert.equal(detectPocket({ width: 1440, path: '/daw3/' }), false);
  assert.equal(detectPocket({ width: 390, path: '/daw3/' }), true);
});

test('native plugin folders: Windows (Common Files + per-user) and Linux defaults', () => {
  const w = defaultFolders('C:\\Users\\me', 'win32', { CommonProgramFiles: 'C:\\Program Files\\Common Files' });
  assert.deepEqual(w.vst3, ['C:\\Users\\me\\AppData\\Local\\Programs\\Common\\VST3', 'C:\\Program Files\\Common Files\\VST3']);
  assert.deepEqual(w.clap, ['C:\\Users\\me\\AppData\\Local\\Programs\\Common\\CLAP', 'C:\\Program Files\\Common Files\\CLAP']);
  assert.deepEqual(w.au, []);
  const l = defaultFolders('/home/me', 'linux');
  assert.deepEqual(l.vst3, ['/home/me/.vst3', '/usr/lib/vst3', '/usr/local/lib/vst3']);
  assert.deepEqual(l.clap, ['/home/me/.clap', '/usr/lib/clap', '/usr/local/lib/clap']);
});

test('desktop packaging: macOS, Windows (NSIS + zip) and Linux (AppImage + deb + tar.gz) targets, .daW3 association', () => {
  const b = pkg.build;
  assert.ok(b.mac && b.win && b.linux);
  assert.deepEqual(b.win.target.map((t) => t.target), ['nsis', 'zip']);
  assert.deepEqual(b.linux.target.map((t) => t.target), ['AppImage', 'deb', 'tar.gz']);
  assert.ok(b.fileAssociations[0].ext.includes('daW3'));
  assert.equal(b.fileAssociations[0].mimeType, 'application/x-daw3');
  for (const f of ['daw3_audio.node', 'daw3-plughost', 'daw3-link', 'daw3-plughost.exe', 'daw3-link.exe']) assert.ok(b.extraResources[0].filter.includes(f), f);
});
