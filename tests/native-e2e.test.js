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
    assert.deepEqual(names, ['clap:daW3 Test Duck', 'clap:daW3 Test Gain', 'clap:daW3 Test Tone', 'vst3:daW3 Test Duck (VST3)', 'vst3:daW3 Test Gain (VST3)']);
    assert.equal(failed.length, 1, 'the broken bundle is reported, not fatal');
    assert.match(failed[0].path, /Broken\.clap$/);
    assert.ok(events.some((e) => e.event === 'scan-progress'));

    for (const [format, unity, double, latency] of [['clap', 1, 2, 64], ['vst3', 0.5, 1, 32]]) {
      const desc = plugins.find((p) => p.format === format && /Gain/.test(p.name));
      const info = await server.handle('plugins.load', [{ key: desc.key, sampleRate: 48000 }]);
      assert.equal(info.latency, latency, `${format} latency reported`);
      info.params = info.params.filter((p) => !(p.flags & 4)); // VST3: the hidden program-change parameter
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
    assert.equal(rendered.numOut, 4, 'every output bus of the multi-out tone plugin');
    assert.equal(rendered.output.length, 4 * 4800);
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

test('native e2e: Audio Units through the plugin host (macOS)', { skip: !have ? opts.skip : process.platform !== 'darwin' ? 'Audio Units exist only on macOS' : false }, async () => {
  const { server, cleanup } = await setup();
  try {
    await server.handle('plugins.scan', [{ formats: ['au'] }]);
    const { plugins } = await server.handle('plugins.list');
    const delay = plugins.find((p) => p.key === 'au:aufx:dely:appl');
    assert.ok(delay, 'AUDelay listed');
    assert.equal(delay.vendor, 'Apple');
    const info = await server.handle('plugins.load', [{ key: delay.key, sampleRate: 48000 }]);
    assert.ok(info.params.some((p) => p.id === 0 && p.max === 100), 'wet/dry param');
    await server.handle('plugins.setParam', [info.inst, 0, 0]);
    let r;
    for (let i = 0; i < 4; i++) r = server.stream({ t: 'proc', inst: info.inst, block: i, numIn: 2, numOut: 2, input: block(0.5), midi: new Float64Array(0) });
    assert.ok(Math.abs(r.output[100] - 0.5) < 1e-3, 'dry signal passes');
    const state = await server.handle('plugins.getState', [info.inst]);
    const again = await server.handle('plugins.load', [{ key: delay.key, state }]);
    assert.equal(Math.round(again.values['0']), 0, 'state restored');
  } finally { cleanup(); }
});

test('native e2e: sidechain bus, multi-out, sample-accurate automation in the offline render, presets, rate change', opts, async () => {
  const { server, tmp, cleanup } = await setup();
  try {
    await server.handle('plugins.scan', [{ formats: ['clap', 'vst3'] }]);
    const { plugins } = await server.handle('plugins.list');
    const byName = (n) => plugins.find((p) => p.name === n);

    // sidechain: the key input of the duck plugins (CLAP port 1 / VST3 aux bus) ducks the main input
    for (const name of ['daW3 Test Duck', 'daW3 Test Duck (VST3)']) {
      const info = await server.handle('plugins.load', [{ key: byName(name).key, sampleRate: 48000 }]);
      assert.equal(info.plugin.sidechain, 2, `${name}: sidechain bus reported`);
      const base = { t: 'proc', inst: info.inst, block: 0, numIn: 2, numOut: 2, input: block(0.5), midi: new Float64Array(0) };
      assert.ok(Math.abs(server.stream(base).output[5] - 0.5) < 1e-6, `${name}: no key -> unity`);
      const keyed = server.stream({ ...base, numSc: 2, sidechain: block(0.5) });
      assert.ok(Math.abs(keyed.output[5] - 0.25) < 1e-6 && Math.abs(keyed.output[133] - 0.25) < 1e-6, `${name}: key 0.5 -> half`);
      assert.equal(server.m.protocol.validateStreamMessage({ ...base, numSc: 2, sidechain: new Float32Array(3) }), false);
      await server.handle('plugins.unload', [info.inst]);
    }

    // multi-out: the tone plugin's second output bus (the same sine at half level)
    const tone = await server.handle('plugins.load', [{ key: byName('daW3 Test Tone').key, sampleRate: 48000 }]);
    assert.equal(tone.plugin.totalOutputs, 4);
    assert.deepEqual(tone.plugin.outputBuses.map((b) => b.name), ['Out', 'Aux']);
    const mo = server.stream({ t: 'proc', inst: tone.inst, block: 0, numIn: 0, numOut: 4, input: new Float32Array(0), midi: new Float64Array([0, 0x90, 69, 100]) });
    const peak = (a, ch) => Math.max(...a.subarray(ch * 128, ch * 128 + 128).map(Math.abs));
    assert.ok(peak(mo.output, 0) > 0.2);
    assert.ok(Math.abs(peak(mo.output, 2) - peak(mo.output, 0) / 2) < 1e-6, 'aux bus at half level');

    // offline render: notes + sample-accurate parameter automation (gain 1 -> 2 at frame 1000, 0 at frame 3000)
    const r = await server.handle('plugins.render', [{ inst: tone.inst, frames: 4800, events: [[0, 0x80, 69, 0], [0, 0x90, 69, 100]],
      params: [[3000, 1, 0], [1000, 1, 2]] }]);
    assert.equal(r.numOut, 4);
    assert.equal(r.buses.length, 2);
    const seg = (ch, a, b) => Math.max(...r.output.subarray(ch * 4800 + a, ch * 4800 + b).map(Math.abs));
    assert.ok(Math.abs(seg(0, 0, 1000) - 0.25) < 0.01, 'gain 1 before frame 1000');
    assert.ok(seg(0, 0, 1000) <= 0.2501, 'the change does not leak before its frame');
    assert.ok(Math.abs(seg(0, 1000, 3000) - 0.5) < 0.01, 'gain 2 from frame 1000');
    assert.equal(seg(0, 3000, 4800), 0, 'silent from frame 3000');
    assert.ok(Math.abs(seg(2, 1000, 3000) - 0.25) < 0.01, 'the aux bus follows the automation too');
    // the very sample: frame 999 is still at gain 1, 1000 on is at 2 (the 440 Hz sine's phase from its first two samples)
    const w = 2 * Math.PI * 440 / 48000, s0 = r.output[0] / 0.25, c0 = (r.output[1] / 0.25 - s0 * Math.cos(w)) / Math.sin(w);
    const ref = (k) => 0.25 * (s0 * Math.cos(k * w) + c0 * Math.sin(k * w));
    assert.ok(Math.abs(r.output[999] - ref(999)) < 1e-4 && Math.abs(r.output[1000] - 2 * ref(1000)) < 1e-4, 'sample-accurate');
    assert.throws(() => server.m.protocol.validateCall('plugins.render', [{ inst: 1, frames: 10, params: 'x' }]));

    // presets: CLAP factory presets / VST3 programs + a saved .vstpreset
    const gain = await server.handle('plugins.load', [{ key: byName('daW3 Test Gain').key, sampleRate: 48000 }]);
    const cp = await server.handle('plugins.presets', [gain.inst]);
    assert.deepEqual(cp.map((p) => p.name), ['Unity', 'Double', 'Half']);
    const after = await server.handle('plugins.loadPreset', [gain.inst, cp[1].id]);
    assert.equal(after.values['1'], 2, 'preset values come back with the info');
    await assert.rejects(server.handle('plugins.savePreset', [gain.inst, 'Mine']), /CLAP/);
    const v = await server.handle('plugins.load', [{ key: byName('daW3 Test Gain (VST3)').key, sampleRate: 48000 }]);
    let vp = await server.handle('plugins.presets', [v.inst]);
    assert.deepEqual(vp.map((p) => `${p.kind}:${p.name}`), ['factory:Unity', 'factory:Double', 'factory:Silent']);
    await server.handle('plugins.setParam', [v.inst, 0, 0.75]);
    server.stream({ t: 'proc', inst: v.inst, block: 0, numIn: 2, numOut: 2, input: block(0.5), midi: new Float64Array(0) });
    const file = await server.handle('plugins.savePreset', [v.inst, 'Warm One']);
    assert.ok(file.startsWith(path.join(tmp, 'home')) && file.endsWith('Warm One.vstpreset'), file);
    assert.throws(() => server.m.protocol.validateCall('plugins.savePreset', [v.inst, '../escape']));
    await server.handle('plugins.loadPreset', [v.inst, vp[2].id]);
    vp = await server.handle('plugins.presets', [v.inst]);
    const mine = vp.find((p) => p.kind === 'file');
    assert.equal(mine?.name, 'Warm One');
    const back = await server.handle('plugins.loadPreset', [v.inst, mine.id]);
    assert.ok(Math.abs(back.values['0'] - 0.75) < 1e-6, '.vstpreset restores the state');

    // sample-rate change: the device reopens and loaded plugins are re-activated at the new rate
    await server.handle('audio.setConfig', [{ enabled: true, sampleRate: 48000, bufferFrames: 128 }]);
    const sr = await server.handle('audio.setConfig', [{ sampleRate: 96000 }]);
    assert.equal(sr.status.sampleRate, 96000);
    assert.equal(sr.plugins.sampleRate, 96000);
    assert.deepEqual(sr.plugins.failed, []);
    const r96 = await server.handle('plugins.render', [{ inst: tone.inst, frames: 24000, events: [[0, 0x90, 69, 100]], params: [[0, 1, 1]] }]);
    let zc = 0;
    for (let k = 1; k < 24000; k++) if ((r96.output[k] >= 0) !== (r96.output[k - 1] >= 0) && r96.output[k - 1] !== 0) zc++;
    assert.ok(Math.abs(zc - 220) <= 2, `440 Hz at 96 kHz (${zc} zero crossings in 0.25 s)`);
  } finally { cleanup(); }
});
