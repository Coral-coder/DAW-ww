// Native plugin manager: CPU-architecture detection (Intel-only plugins in a second, Rosetta-run host), failure
// classification (quarantine / crash / timeout), Electron error cleanup, favourites / hidden / blocklist, the
// incremental scan with per-bundle logs, and (with the native build) the two-host path end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, chmodSync, readFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machoArchs, pickHostArch, hostArchOf, isArchError, isRosettaMissing, classifyFailure, cleanErrorMessage, quarantineCommand } from '../src/native/plugin-diagnostics.js';
import { normalizePrefs, toggleKey, setBlocked, isBundleBlocked, isPluginBlocked, filterNativePlugins, catalogPlugins, emptyPrefs } from '../src/native/plugin-prefs.js';
import { scanPlugins, parseDb, parseDescribeOutput } from '../src/native/plugin-db.js';
import { validateCall } from '../src/native/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ------------------------------------------------------------------------------------- Mach-O
const u32be = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u32le = (v) => u32be(v).reverse();
const CPU_X86_64 = 0x01000007, CPU_ARM64 = 0x0100000c;

test('machoArchs: thin, universal (fat / fat64) and non-Mach-O binaries', () => {
  assert.deepEqual(machoArchs(new Uint8Array([...u32le(0xfeedfacf), ...u32le(CPU_X86_64), 0, 0, 0, 0])), ['x86_64']);
  assert.deepEqual(machoArchs(new Uint8Array([...u32le(0xfeedfacf), ...u32le(CPU_ARM64), 0, 0, 0, 0])), ['arm64']);
  const fat = [...u32be(0xcafebabe), ...u32be(2), ...u32be(CPU_X86_64), ...u32be(3), ...u32be(4096), ...u32be(100), ...u32be(12),
    ...u32be(CPU_ARM64), ...u32be(0), ...u32be(8192), ...u32be(100), ...u32be(14)];
  assert.deepEqual(machoArchs(new Uint8Array(fat)), ['x86_64', 'arm64']);
  const fat64 = [...u32be(0xcafebabf), ...u32be(1), ...u32be(CPU_ARM64), ...u32be(2), ...new Array(24).fill(0)];
  assert.deepEqual(machoArchs(new Uint8Array(fat64)), ['arm64']);
  assert.equal(machoArchs(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])), null, 'ELF');
  assert.equal(machoArchs(new Uint8Array([...u32be(0xcafebabe), ...u32be(52)])), null, 'a Java class file is not a fat binary');
  assert.equal(machoArchs(new Uint8Array(3)), null);
});

test('pickHostArch: Intel-only plugins on Apple silicon go to the Rosetta host; unusable binaries are explained', () => {
  assert.equal(hostArchOf('arm64'), 'arm64');
  assert.equal(hostArchOf('x64'), 'x86_64');
  assert.deepEqual(pickHostArch(['x86_64', 'arm64'], 'arm64'), { arch: '' });
  assert.deepEqual(pickHostArch(['arm64e'], 'arm64'), { arch: '' });
  assert.deepEqual(pickHostArch(['x86_64'], 'arm64'), { arch: 'x86_64', intelOnly: true });
  assert.deepEqual(pickHostArch(['arm64'], 'x86_64'), { arch: 'arm64' });
  assert.deepEqual(pickHostArch(null, 'arm64'), { arch: '' }, 'unknown: own host');
  assert.deepEqual(pickHostArch(['x86_64'], 'arm64', 'linux'), { arch: '' }, 'only macOS has a second host');
  const ppc = pickHostArch(['ppc', 'i386'], 'arm64');
  assert.equal(ppc.arch, null);
  assert.match(ppc.error, /ppc \/ i386 only/);
  assert.ok(isArchError("dlopen(/x.vst3, 0x0001): tried: '/x' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64e'))"));
  assert.ok(isArchError('wrong ELF class: ELFCLASS32'));
  assert.ok(!isArchError('file too short'));
  assert.ok(isRosettaMissing('arch: posix_spawnp: /x/daw3-plughost: Bad CPU type in executable'));
});

test('classifyFailure + cleanErrorMessage: reasons and fixes a musician can act on', () => {
  const q = classifyFailure({ path: '/Users/me/Library/Audio/Plug-Ins/VST3/Foo.vst3', error: 'Could not load the VST3 binary: …', quarantined: true });
  assert.equal(q.reason, 'quarantined');
  assert.match(q.hint, /xattr -dr com\.apple\.quarantine "\/Users\/me\/Library\/Audio\/Plug-Ins\/VST3\/Foo\.vst3"/);
  assert.match(q.hint, /Privacy & Security/);
  assert.equal(classifyFailure({ crashed: true, error: 'x' }).reason, 'crashed');
  assert.equal(classifyFailure({ timedOut: true, error: 'x' }).label, 'Timed out');
  const intel = classifyFailure({ arch: 'x86_64', intelOnly: true, rosettaMissing: true, error: 'Intel-only plugin and Rosetta 2 is not installed (Bad CPU type in executable)' });
  assert.equal(intel.reason, 'intel-only');
  assert.match(intel.hint, /softwareupdate --install-rosetta/);
  assert.equal(classifyFailure({ error: "mach-o file, but is an incompatible architecture (have 'ppc', need 'arm64')" }).reason, 'wrong-arch');
  assert.equal(classifyFailure({ error: 'file too short' }).reason, 'error');
  assert.equal(quarantineCommand('/a "b".clap'), 'xattr -dr com.apple.quarantine "/a \\"b\\".clap"');
  assert.equal(cleanErrorMessage(new Error("Error invoking remote method 'daw3:native': Error: The audio server stopped")), 'The audio server stopped');
  assert.equal(cleanErrorMessage("Error invoking remote method 'daw3:native': TypeError: x is not a function"), 'x is not a function');
  assert.equal(cleanErrorMessage('Plugin scan failed: boom'), 'Plugin scan failed: boom');
  assert.equal(cleanErrorMessage(''), 'Unknown error');
});

// ------------------------------------------------------------------------------------- preferences
const P = (key, name, extra = {}) => ({ key, format: key.split(':')[0], uid: key.split(':')[1], name, vendor: '', category: '', path: `/p/${name}`, ...extra });

test('plugin prefs: favourites, hidden, blocklist, search / sort / filter, catalog', () => {
  assert.deepEqual(normalizePrefs('junk'), emptyPrefs());
  const n = normalizePrefs({ favorites: ['vst3:A', 'vst3:A', 'bad', 3], hidden: ['clap:x'], blocked: [{ format: 'vst3', path: '/p/Crash.vst3' }, { format: 'au', path: 'all' }, { format: 'au', key: 'au:aufx:dely:appl' }, { format: 'dll', path: '/x' }] });
  assert.deepEqual(n.favorites, ['vst3:A']);
  assert.equal(n.blocked.length, 2, 'AU entries need a key; unknown formats are dropped');
  assert.ok(isBundleBlocked(n, 'vst3', '/p/Crash.vst3'));
  assert.ok(!isBundleBlocked(n, 'clap', '/p/Crash.vst3'));
  assert.ok(isPluginBlocked(n, { key: 'au:aufx:dely:appl', format: 'au', path: 'all' }));
  assert.ok(isPluginBlocked(n, { key: 'vst3:Z', format: 'vst3', path: '/p/Crash.vst3' }), 'every plugin in a blocked bundle');
  let p = toggleKey(n, 'favorites', 'clap:b');
  assert.deepEqual(p.favorites, ['vst3:A', 'clap:b']);
  p = toggleKey(p, 'favorites', 'vst3:A');
  assert.deepEqual(p.favorites, ['clap:b']);
  assert.deepEqual(n.favorites, ['vst3:A'], 'immutable');
  p = setBlocked(p, { format: 'clap', path: '/p/Bad.clap' });
  p = setBlocked(p, { format: 'clap', path: '/p/Bad.clap' });
  assert.equal(p.blocked.filter((b) => b.path === '/p/Bad.clap').length, 1);
  p = setBlocked(p, { format: 'clap', path: '/p/Bad.clap' }, false);
  assert.ok(!isBundleBlocked(p, 'clap', '/p/Bad.clap'));

  const plugins = [P('vst3:A', 'Alpha', { vendor: 'Zed' }), P('clap:b', 'beta', { vendor: 'Acme', instrument: true }), P('clap:x', 'Hidden One'), P('au:c', 'Gamma', { vendor: 'Acme', arch: 'x86_64' }), P('vst3:Z', 'Crashy', { path: '/p/Crash.vst3' })];
  const prefs = normalizePrefs({ favorites: ['au:c'], hidden: ['clap:x'], blocked: [{ format: 'vst3', path: '/p/Crash.vst3' }] });
  assert.deepEqual(filterNativePlugins(plugins, prefs).map((x) => x.name), ['Alpha', 'beta', 'Gamma']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { sort: 'vendor' }).map((x) => x.name), ['beta', 'Gamma', 'Alpha']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { sort: 'format' }).map((x) => x.format), ['au', 'clap', 'vst3']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { sort: 'favorites' }).map((x) => x.name), ['Gamma', 'Alpha', 'beta']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { show: 'hidden' }).map((x) => x.name), ['Hidden One']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { show: 'favorites' }).map((x) => x.name), ['Gamma']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { query: 'acme synth' }).map((x) => x.name), ['beta']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { query: 'rosetta' }).map((x) => x.name), ['Gamma']);
  assert.deepEqual(filterNativePlugins(plugins, prefs, { format: 'vst3' }).map((x) => x.name), ['Alpha']);
  assert.deepEqual(catalogPlugins(plugins, prefs).map((x) => x.name), ['Gamma', 'Alpha', 'beta'], 'no hidden / blocked; favourites first');
});

test('plugin DB: blocklist skips bundles, Retry rescans one bundle, logs + arch + quarantine are kept, native copy preferred', async () => {
  const calls = [];
  const io = {
    listBundles: async (format) => (format === 'vst3' ? ['/u/A.vst3', '/u/Crash.vst3', '/u/IntelA.vst3'] : []),
    mtime: async () => 7,
    describe: async (format, p) => {
      calls.push(p);
      if (p.includes('Crash')) return { ok: false, crashed: true, error: 'The plugin crashed the scanner (SIGSEGV)', log: ['scanner: crashed'] };
      if (p.includes('IntelA')) return { ok: true, arch: 'x86_64', quarantined: true, plugins: [{ format: 'vst3', uid: 'A', name: 'Alpha' }], log: ['binary [x86_64]'] };
      return { ok: true, plugins: [{ format: 'vst3', uid: 'A', name: 'Alpha' }], log: 'scanner: ok' };
    },
  };
  const folders = { vst3: ['/u'] };
  const db = await scanPlugins({ folders, io, formats: ['vst3'], now: 1000 });
  assert.equal(db.plugins.length, 1, 'same plugin twice: one entry');
  assert.equal(db.plugins[0].path, '/u/A.vst3', 'the copy the own host runs wins over the Rosetta one');
  assert.equal(db.plugins[0].arch, '');
  assert.equal(db.failed[0].crashed, true);
  assert.match(db.bundles['vst3|/u/IntelA.vst3'].log, /binary \[x86_64\][\s\S]*found 1 plugin/);
  assert.equal(db.bundles['vst3|/u/IntelA.vst3'].arch, 'x86_64');
  assert.equal(db.bundles['vst3|/u/IntelA.vst3'].quarantined, true);
  assert.match(db.bundles['vst3|/u/Crash.vst3'].log, /failed: The plugin crashed/);
  // stored + reloaded: arch / quarantine survive
  const back = parseDb(JSON.stringify(db));
  assert.deepEqual(back.bundles, db.bundles);
  // Retry: only the named bundle is described again
  calls.length = 0;
  await scanPlugins({ db: back, folders, io, formats: ['vst3'], force: (f, p) => p === '/u/Crash.vst3' });
  assert.deepEqual(calls, ['/u/Crash.vst3']);
  // blocklist: never described
  calls.length = 0;
  const prefs = normalizePrefs({ blocked: [{ format: 'vst3', path: '/u/Crash.vst3' }] });
  const db3 = await scanPlugins({ db: back, folders, io, formats: ['vst3'], force: true, skip: (f, p) => isBundleBlocked(prefs, f, p) });
  assert.ok(!calls.includes('/u/Crash.vst3'));
  assert.equal(db3.failed.length, 0);
  // exclude (blocked AU keys)
  const db4 = await scanPlugins({ db: back, folders, io, formats: ['vst3'], exclude: (d) => d.key === 'vst3:A' });
  assert.equal(db4.plugins.length, 0);
  // the scanner's hostArch field is noise to the DB parser
  assert.equal(parseDescribeOutput('{"ok":true,"hostArch":"x86_64","plugins":[]}').ok, true);
});

test('protocol: manager methods are validated', () => {
  assert.ok(validateCall('plugins.retry', [{ format: 'vst3', path: '/a.vst3' }]));
  assert.throws(() => validateCall('plugins.retry', [{ format: 'dll', path: '/a' }]));
  assert.throws(() => validateCall('plugins.scanLog', [{ format: 'clap' }]));
  assert.ok(validateCall('plugins.setPrefs', [{ favorites: [] }]));
  assert.throws(() => validateCall('plugins.setPrefs', [[]]));
  assert.ok(validateCall('plugins.render', [{ inst: 1, frames: 4, input: new Float32Array(8) }]));
  assert.throws(() => validateCall('plugins.render', [{ inst: 1, frames: 4, input: [0, 0, 0, 0] }]));
});

test('preload: every plugin manager call is exposed and Electron error prefixes are stripped', () => {
  const src = readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8');
  for (const m of ['plugins.retry', 'plugins.scanLog', 'plugins.getPrefs', 'plugins.setPrefs']) assert.ok(src.includes(`'${m}'`), m);
  assert.match(src, /Error invoking remote method/);
});

// ------------------------------------------------------------------------------------- plughost I/O helpers
test('plughost: bundle executable from Info.plist, Mach-O head, bundle mtime, describe of a broken bundle', async () => {
  const { bundleExecutable, readHead, bundleMtime, describeBundle, isQuarantined } = require('../desktop/plughost.cjs');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'daw3-pm-'));
  try {
    const b = path.join(tmp, 'Foo.vst3');
    mkdirSync(path.join(b, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(path.join(b, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key>\n<string>FooBin</string></dict></plist>');
    writeFileSync(path.join(b, 'Contents', 'MacOS', 'FooBin'), new Uint8Array([...u32le(0xfeedfacf), ...u32le(CPU_X86_64), 0, 0, 0, 0]));
    const exe = await bundleExecutable(b);
    assert.equal(exe, path.join(b, 'Contents', 'MacOS', 'FooBin'));
    assert.deepEqual(machoArchs(await readHead(exe)), ['x86_64']);
    assert.equal((await readHead(path.join(tmp, 'missing'))).length, 0);
    // an in-place update of the binary changes the bundle's scan mtime
    const t0 = await bundleMtime(b, { binary: exe });
    utimesSync(exe, new Date(), new Date(Date.now() + 60000));
    assert.ok((await bundleMtime(b, { binary: exe })) > t0);
    assert.equal(await isQuarantined(b, { platform: 'linux' }), false);
    assert.equal(await isQuarantined(b, { platform: 'darwin', run: (cmd, args, o, cb) => { assert.deepEqual(args.slice(0, 2), ['-p', 'com.apple.quarantine']); cb(null); } }), true);
    // a scanner that prints nothing but fails (like `arch` without Rosetta) reports its stderr, not "returned nothing"
    const fake = path.join(tmp, 'fakehost.sh');
    writeFileSync(fake, '#!/bin/sh\necho "arch: posix_spawnp: daw3-plughost: Bad CPU type in executable" >&2\nexit 1\n');
    chmodSync(fake, 0o755);
    if (process.platform !== 'win32') {
      const r = await describeBundle(fake, 'vst3', b, { parse: parseDescribeOutput });
      assert.equal(r.ok, false);
      assert.match(r.error, /Bad CPU type/);
      assert.ok(!r.crashed);
      assert.match(r.log.join('\n'), /stderr: arch: posix_spawnp/);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------- end to end (native build)
const build = path.join(root, 'desktop', 'native', 'build');
const EXE = process.platform === 'win32' ? '.exe' : '';
const have = existsSync(path.join(build, 'daw3_audio.node')) && existsSync(path.join(build, `daw3-plughost${EXE}`)) && existsSync(path.join(build, 'daW3TestGain.clap'));
const e2e = { skip: !have ? 'native layer not built (sh desktop/native/build.sh)' : process.platform === 'win32' ? 'the arch-wrapper script needs a POSIX shell' : false };

test('native e2e: an "Intel-only" plugin is scanned and served by a second host; quarantine, blocklist, retry, prefs', e2e, async () => {
  const { NativeServer } = require('../desktop/native-server.cjs');
  const addon = require(path.join(build, 'daw3_audio.node'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'daw3-pm-e2e-'));
  const home = path.join(tmp, 'home');
  // pretend to be macOS on Apple silicon: the CLAP test plugin "is" x86_64-only, so it must go through the arch tool
  const clapDir = path.join(home, 'Library/Audio/Plug-Ins/CLAP');
  const vst3Dir = path.join(home, 'Library/Audio/Plug-Ins/VST3');
  mkdirSync(clapDir, { recursive: true });
  mkdirSync(vst3Dir, { recursive: true });
  cpSync(path.join(build, 'daW3TestGain.clap'), path.join(clapDir, 'daW3TestGain.clap'), { recursive: true });
  cpSync(path.join(build, 'daW3TestGain.vst3'), path.join(vst3Dir, 'daW3TestGain.vst3'), { recursive: true });
  writeFileSync(path.join(clapDir, 'Broken.clap'), 'not a plugin');
  const archLog = path.join(tmp, 'arch.log');
  const archTool = path.join(tmp, 'arch');
  writeFileSync(archTool, `#!/bin/sh\necho "$1" >> "${archLog}"\nshift\nexec "$@"\n`);
  chmodSync(archTool, 0o755);
  const events = [];
  const server = await NativeServer.create({
    addon, binary: path.join(build, 'daw3-plughost'), dataDir: path.join(tmp, 'data'), home, nullBackend: true, post: (e) => events.push(e),
    platform: 'darwin', hostArch: 'arm64', archTool,
    binaryArchs: async (bundle) => (bundle.endsWith('daW3TestGain.clap') ? ['x86_64'] : null),
    quarantined: async (p) => p.endsWith('Broken.clap'),
  });
  try {
    await server.handle('plugins.scan', [{ formats: ['clap', 'vst3'] }]);
    let list = await server.handle('plugins.list');
    const gain = list.plugins.find((p) => p.format === 'clap' && p.name === 'daW3 Test Gain');
    assert.equal(gain.arch, 'x86_64', 'stored per plugin');
    assert.equal(list.plugins.find((p) => p.format === 'vst3').arch, '');
    assert.match(readFileSync(archLog, 'utf8'), /^-x86_64$/m, 'scanned through `arch -x86_64`');
    const broken = list.failed.find((f) => f.path.endsWith('Broken.clap'));
    assert.equal(broken.quarantined, true);
    assert.equal(classifyFailure(broken).reason, 'quarantined');
    assert.match(broken.error, /Could not load the CLAP binary: .*Broken\.clap/, 'the loader\'s own text, not a guess');
    const log = await server.handle('plugins.scanLog', [{ format: 'clap', path: gain.path }]);
    assert.match(log.log, /host: arm64[\s\S]*scanner \(as x86_64\): ok/);

    // load + process in both hosts
    const block = new Float32Array(256).fill(0.5);
    const a = await server.handle('plugins.load', [{ key: gain.key, sampleRate: 48000 }]);
    const v = await server.handle('plugins.load', [{ key: list.plugins.find((p) => p.format === 'vst3' && /Gain/.test(p.name)).key, sampleRate: 48000 }]);
    assert.equal(server.hosts.size, 2, 'one host per architecture');
    assert.notEqual(server.hosts.get('x86_64').pid, server.host.pid);
    for (const inst of [a.inst, v.inst]) {
      const r = server.stream({ t: 'proc', inst, block: 0, numIn: 2, numOut: 2, input: block, midi: new Float64Array(0) });
      assert.equal(r.status, 0);
      assert.ok(Math.abs(r.output[64] - 0.5) < 1e-6);
    }
    // offline render of an effect with input audio
    const rr = await server.handle('plugins.render', [{ inst: a.inst, frames: 3000, input: new Float32Array(3000).fill(0.25) }]);
    assert.ok(Math.abs(rr.output[2500] - 0.25) < 1e-6, 'effect render processes the given input');
    const rate = await server._plugins_setSampleRate(44100);
    assert.ok(String(a.inst) in rate.latency && String(v.inst) in rate.latency, 'both hosts follow the device rate');

    // blocklist: blocked plugins are dropped, refused, and not scanned again; retry rescans one bundle
    const r1 = await server.handle('plugins.setPrefs', [{ favorites: [gain.key], blocked: [{ format: 'clap', path: broken.path }] }]);
    assert.deepEqual(r1.prefs.favorites, [gain.key]);
    list = await server.handle('plugins.list');
    assert.ok(!list.failed.some((f) => f.path.endsWith('Broken.clap')));
    await assert.rejects(server.handle('plugins.retry', [{ format: 'clap', path: broken.path }]), /blocklist/);
    await server.handle('plugins.setPrefs', [{ blocked: [{ format: 'clap', path: gain.path }] }]);
    await assert.rejects(server.handle('plugins.load', [{ key: gain.key }]), /blocklist/);
    const s = await server.handle('plugins.scan', [{ formats: ['clap', 'vst3'] }]);
    assert.ok(s.failed.some((f) => f.path.endsWith('Broken.clap')), 'unblocked bundles come back');
    assert.ok(!(await server.handle('plugins.list')).plugins.some((p) => p.path === gain.path), 'still blocked');
    await server.handle('plugins.setPrefs', [{}]);
    await server.handle('plugins.scan', [{ formats: ['clap', 'vst3'] }]);
    assert.ok((await server.handle('plugins.list')).plugins.some((p) => p.key === gain.key && p.arch === 'x86_64'), 'an unblocked, unchanged bundle is scanned again');
    await server.handle('plugins.setPrefs', [{ blocked: [{ format: 'clap', path: gain.path }] }]);
    const rt = await server.handle('plugins.retry', [{ format: 'clap', path: broken.path }]);
    assert.equal(rt.ok, false);
    assert.match(rt.error, /Could not load the CLAP binary/);
    const prefsFile = JSON.parse(readFileSync(path.join(tmp, 'data', 'plugin-prefs.json'), 'utf8'));
    assert.equal(prefsFile.blocked[0].path, gain.path, 'stored in userData');
    // a fresh server reads them back
    assert.equal((await server.handle('plugins.getPrefs')).blocked.length, 1);
  } finally {
    server.shutdown();
    await new Promise((res) => setTimeout(res, 300));
    rmSync(tmp, { recursive: true, force: true });
  }
});
