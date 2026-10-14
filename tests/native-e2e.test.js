// End-to-end: the real native addon + out-of-process plugin host, driven through the audio server's
// logic (desktop/native-server.cjs). Runs when `sh desktop/native/build.sh` has been run (the Mac CI
// job does; on Linux it uses miniaudio's null backend). Skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const build = path.join(root, 'desktop', 'native', 'build');
const have = existsSync(path.join(build, 'daw3_audio.node')) && existsSync(path.join(build, 'daw3-plughost')) && existsSync(path.join(build, 'daW3TestGain.clap'));
const opts = { skip: have ? false : 'native layer not built (sh desktop/native/build.sh)' };

async function setup() {
  const { NativeServer } = require('../desktop/native-server.cjs');
  const addon = require(path.join(build, 'daw3_audio.node'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'daw3-native-'));
  const home = path.join(tmp, 'home');
  const plat = process.platform;
  // install the test plugins where a user would
  const clapDir = plat === 'darwin' ? path.join(home, 'Library/Audio/Plug-Ins/CLAP') : path.join(home, '.clap');
  const vst3Dir = plat === 'darwin' ? path.join(home, 'Library/Audio/Plug-Ins/VST3') : path.join(home, '.vst3');
  mkdirSync(clapDir, { recursive: true });
  mkdirSync(vst3Dir, { recursive: true });
  cpSync(path.join(build, 'daW3TestGain.clap'), path.join(clapDir, 'daW3TestGain.clap'), { recursive: true });
  cpSync(path.join(build, 'daW3TestGain.vst3'), path.join(vst3Dir, 'daW3TestGain.vst3'), { recursive: true });
  writeFileSync(path.join(clapDir, 'Broken.clap'), 'not a plugin');
  const events = [];
  const server = await NativeServer.create({ addon, binary: path.join(build, 'daw3-plughost'), dataDir: path.join(tmp, 'data'), home, nullBackend: true, post: (e) => events.push(e) });
  return { server, tmp, events, cleanup: () => { server.shutdown(); rmSync(tmp, { recursive: true, force: true }); } };
}

const block = (v, ch = 2) => new Float32Array(128 * ch).fill(v);

test('native e2e: devices + engine config (null backend)', opts, async () => {
  const { server, cleanup } = await setup();
  try {
    const d = await server.handle('audio.listDevices');
    assert.ok(d.outputs.length >= 1 && d.inputs.length >= 1);
    const r = await server.handle('audio.setConfig', [{ enabled: true, bufferFrames: 128, sampleRate: 48000 }]);
    assert.equal(r.error, null);
    assert.equal(r.status.running, true);
    assert.equal(r.status.backend, 'Null');
    // the stream accepts renderer output and the input poll returns captured frames
    server.stream({ t: 'out', data: block(0.1) });
    await new Promise((res) => setTimeout(res, 60));
    const inMsg = server.pollInput();
    assert.ok(inMsg === null || (inMsg.data instanceof Float32Array && inMsg.channels >= 1));
    assert.throws(() => server.m.protocol.validateCall('audio.setConfig', ['x']));
    const off = await server.handle('audio.setConfig', [{ enabled: false }]);
    assert.equal(off.status.state, 'stopped');
    assert.equal((await server.handle('audio.getConfig')).bufferFrames, 128, 'config persists');
  } finally { cleanup(); }
});

test('native e2e: scan, load, process, params, state, latency (CLAP + VST3 through the plugin host)', opts, async () => {
  const { server, events, cleanup } = await setup();
  try {
    const scan = await server.handle('plugins.scan', [{ formats: ['clap', 'vst3'] }]);
    const { plugins, failed } = await server.handle('plugins.list');
    assert.equal(scan.count, plugins.length);
    const names = plugins.map((p) => `${p.format}:${p.name}`).sort();
    assert.deepEqual(names, ['clap:daW3 Test Gain', 'clap:daW3 Test Tone', 'vst3:daW3 Test Gain (VST3)']);
    assert.equal(failed.length, 1, 'the broken bundle is reported, not fatal');
    assert.match(failed[0].path, /Broken\.clap$/);
    assert.ok(events.some((e) => e.event === 'scan-progress'));

    for (const [format, unity, double, latency] of [['clap', 1, 2, 64], ['vst3', 0.5, 1, 32]]) {
      const desc = plugins.find((p) => p.format === format && !p.instrument);
      const info = await server.handle('plugins.load', [{ key: desc.key, sampleRate: 48000 }]);
      assert.equal(info.latency, latency, `${format} latency reported`);
      assert.equal(info.params.length, 1);
      assert.equal(info.params[0].name, 'Gain');
      assert.equal(info.values[String(info.params[0].id)], unity);
      const proc = (inst) => server.stream({ t: 'proc', inst, block: 0, numIn: 2, numOut: 2, input: block(0.5), midi: new Float64Array(0) });
      let r = proc(info.inst);
      assert.equal(r.status, 0);
      assert.ok(Math.abs(r.output[64] - 0.5) < 1e-6, `${format} unity`);
      await server.handle('plugins.setParam', [info.inst, info.params[0].id, double]);
      r = proc(info.inst);
      assert.ok(Math.abs(r.output[200] - 1.0) < 1e-6, `${format} gain x2`);
      const state = await server.handle('plugins.getState', [info.inst]);
      assert.match(state, /^[A-Za-z0-9+/]+=*$/);
      // a second instance restored from the saved chunk processes like the first
      const again = await server.handle('plugins.load', [{ key: desc.key, state, sampleRate: 48000 }]);
      assert.equal(again.values[String(info.params[0].id)], double);
      assert.ok(Math.abs(proc(again.inst).output[10] - 1.0) < 1e-6, `${format} state restored`);
      await server.handle('plugins.unload', [again.inst]);
      await server.handle('plugins.unload', [info.inst]);
      assert.equal(proc(info.inst).output, null, 'unloaded instance yields no audio');
    }

    // instrument: MIDI through the shared-memory block, offline render
    const tone = plugins.find((p) => p.instrument);
    const t = await server.handle('plugins.load', [{ key: tone.key, sampleRate: 48000 }]);
    const r = server.stream({ t: 'proc', inst: t.inst, block: 0, numIn: 0, numOut: 2, input: new Float32Array(0), midi: new Float64Array([0, 0x90, 69, 100]) });
    assert.ok(Math.max(...r.output.map(Math.abs)) > 0.2, 'note on -> sound');
    const rendered = await server.handle('plugins.render', [{ inst: t.inst, frames: 4800, events: [[1000, 0x80, 69, 0], [2400, 0x90, 60, 100]] }]);
    assert.equal(rendered.output.length, 9600);
    const seg = (a, b) => Math.max(...rendered.output.subarray(a, b).map(Math.abs));
    assert.ok(seg(0, 900) > 0.2, 'held note sounds');
    assert.equal(seg(1100, 2300), 0, 'silent after note off');
    assert.ok(seg(2500, 4800) > 0.2, 'second note');

    // a crashed host is reported and the next load starts a fresh one
    const pid = server.host.pid;
    process.kill(pid, 'SIGKILL');
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(events.some((e) => e.event === 'plugin-host-exit' && e.insts.includes(t.inst)));
    const back = await server.handle('plugins.load', [{ key: tone.key }]);
    assert.ok(back.inst > t.inst);
    assert.notEqual(server.host.pid, pid);
  } finally { cleanup(); }
});
