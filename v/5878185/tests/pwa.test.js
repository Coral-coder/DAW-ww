import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildInfo, workerURL } from '../src/pwa.js';

test('pwa: build folder and service-worker URL derive from <base> (versioned publish and dev)', () => {
  assert.deepEqual(buildInfo('https://x.github.io/daw3/v/abc123/', 'https://x.github.io/daw3/?pwa'), { version: 'abc123', base: 'v/abc123/' });
  assert.deepEqual(buildInfo('http://localhost:5173/', 'http://localhost:5173/?nowelcome'), { version: 'dev', base: './' });
  const u = new URL(workerURL('https://x.github.io/daw3/v/abc123/', 'https://x.github.io/daw3/'));
  assert.equal(u.pathname, '/daw3/sw.js');
  assert.equal(u.searchParams.get('v'), 'abc123');
  assert.equal(u.searchParams.get('base'), 'v/abc123/');
});

test('pwa: manifest, icons and iOS meta are in place', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url)));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(new URL('../' + i.src, import.meta.url)), i.src);
  // manifest lives in v/<sha>/: start_url / scope point back to the site root
  assert.equal(new URL(m.start_url, 'https://x.github.io/daw3/v/abc/manifest.webmanifest').pathname, '/daw3/');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const s of ['rel="manifest"', 'apple-touch-icon', 'apple-mobile-web-app-capable', 'viewport-fit=cover']) assert.ok(html.includes(s), s);
  assert.ok(existsSync(new URL('../sw.js', import.meta.url)));
});
