// Native audio engine + plugin hosting: the JS side (pure modules, no native build needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer, RingBuffer, encodePacket, decodePacket, packetSize, BLOCK, PACKET_MAX_EVENTS } from '../src/native/ring.js';
import { normalizeAudioConfig, engineOptions, validateCall, validateStreamMessage, bridgeLatencyFrames, DEFAULT_AUDIO_CONFIG } from '../src/native/protocol.js';
import { makeChirp, findDelay, analyzePing } from '../src/native/latency.js';
import { scanPlugins, parseDb, parseDescribeOutput, catalogEntries, emptyDb, defaultFolders, keyHash } from '../src/native/plugin-db.js';
import { controlsFromParams, paramDefsFromControls, diffValues, midiToValue, normalize, denormalize, valuesPatch } from '../src/native/params.js';
import { nativeParamsFor, sanitizeNativeParams, nativePluginsIn, stateBytes } from '../src/native/state.js';

test('ring: interleaved write/read with wrap-around, overflow is counted', () => {
  const r = new RingBuffer(createRingBuffer(5, 2)); // -> 8 frames
  assert.equal(r.capacity, 8);
  const src = Float32Array.from({ length: 20 }, (_, i) => i);
  assert.equal(r.write(src, 6), 6);
  assert.equal(r.write(src, 6), 2);
  assert.equal(r.overruns, 1);
  const out = new Float32Array(16);
  assert.equal(r.read(out, 4), 4);
  assert.deepEqual([...out.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(r.write(src.subarray(12), 4), 4); // wraps
  assert.equal(r.read(out, 8), 8);
  assert.deepEqual([...out], [8, 9, 10, 11, 0, 1, 2, 3, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(r.available(), 0);
});

test('ring: planar in/out (what the AudioWorklets use) and index wrap past 2^31', () => {
  const sab = createRingBuffer(256, 2);
  const r = new RingBuffer(sab);
  new Int32Array(sab, 0, 2).fill(0x7fffff00); // read == write near the int32 limit
  const L = Float32Array.from({ length: 128 }, (_, i) => i), R = Float32Array.from({ length: 128 }, (_, i) => -i);
  for (let k = 0; k < 10; k++) {
    assert.equal(r.writePlanar([L, R], 128), 128);
    const a = new Float32Array(128), b = new Float32Array(128);
    assert.equal(r.readPlanar([a, b], 128), 128);
    assert.deepEqual([...a], [...L]);
    assert.deepEqual([...b], [...R]);
  }
  // mono source feeds both ring channels; a reader on a second view sees the same data
  r.writePlanar([L], 64);
  const v2 = new RingBuffer(sab);
  const both = new Float32Array(128);
  assert.equal(v2.read(both, 64), 64);
  assert.equal(both[2 * 10], 10);
  assert.equal(both[2 * 10 + 1], 10);
});

test('ring: plugin packets carry block index, MIDI and planar audio', () => {
  const size = packetSize(2);
  const r = new RingBuffer(createRingBuffer(16, size));
  const rec = new Float32Array(size);
  const L = new Float32Array(BLOCK).fill(0.25), R = new Float32Array(BLOCK).fill(-0.5);
  const events = [[3, 0x90, 60, 100], [77, 0x80, 60, 0]];
  encodePacket(rec, 42, [L, R], 2, events);
  r.write(rec, 1);
  const got = new Float32Array(size);
  assert.equal(r.read(got, 1), 1);
  const p = decodePacket(got, 2);
  assert.equal(p.block, 42);
  assert.equal(p.frames, BLOCK);
  assert.deepEqual([...p.midi], [3, 0x90, 60, 100, 77, 0x80, 60, 0]);
  assert.equal(p.audio.length, 2 * BLOCK);
  assert.equal(p.audio[5], 0.25);
  assert.equal(p.audio[BLOCK + 5], -0.5);
  const many = Array.from({ length: 50 }, (_, i) => [i, 0x90, 60, 1]);
  assert.equal(decodePacket(encodePacket(rec, 1, [L], 1, many), 1).midi.length, PACKET_MAX_EVENTS * 4);
});

test('protocol: audio config is normalised (buffer 32–1024, rates, channel offset)', () => {
  assert.deepEqual(normalizeAudioConfig({}), { ...DEFAULT_AUDIO_CONFIG });
  const c = normalizeAudioConfig({ enabled: 1, bufferFrames: 4, sampleRate: 12345, deviceOutChannels: 8, outOffset: 9, outputId: 'abc' });
  assert.equal(c.enabled, true);
  assert.equal(c.bufferFrames, 32);
  assert.equal(c.sampleRate, 48000);
  assert.equal(c.outOffset, 6, 'stereo pair must fit on the device');
  assert.equal(normalizeAudioConfig({ bufferFrames: 4096 }).bufferFrames, 1024);
  assert.equal(normalizeAudioConfig(null).bufferFrames, 256);
  const o = engineOptions({ deviceOutChannels: 1, outOffset: 0 });
  assert.equal(o.deviceOutChannels, 2);
  assert.equal(o.streamChannels, 2);
  assert.ok(bridgeLatencyFrames({ bufferFrames: 128 }) > 128);
});

test('protocol: control calls and stream messages are validated', () => {
  assert.ok(validateCall('audio.listDevices'));
  assert.throws(() => validateCall('audio.nope'), /Unknown/);
  assert.throws(() => validateCall('audio.setConfig', [1]), /config/);
  assert.ok(validateCall('plugins.load', [{ key: 'vst3:ABCDEF', state: 'aGk=' }]));
  assert.throws(() => validateCall('plugins.load', [{ key: 'dll:x' }]), /plugin key/);
  assert.throws(() => validateCall('plugins.load', [{ key: 'clap:x', state: 'not base64!' }]), /base64/);
  assert.throws(() => validateCall('plugins.setParam', [1, -1, 0.5]));
  assert.throws(() => validateCall('plugins.setParam', [1, 2, NaN]));
  assert.ok(validateCall('plugins.setParam', [1, 2, 0.5]));
  assert.throws(() => validateCall('plugins.setState', [1, '%%%']));
  assert.ok(validateCall('plugins.render', [{ inst: 1, frames: 48000, events: [[0, 144, 60, 100]] }]));
  assert.ok(validateStreamMessage({ t: 'out', data: new Float32Array(256) }));
  assert.ok(!validateStreamMessage({ t: 'out', data: new Float32Array(3) }));
  assert.ok(!validateStreamMessage({ t: 'out', data: [0, 0] }));
  assert.ok(validateStreamMessage({ t: 'proc', inst: 1, block: 7, numIn: 2, numOut: 2, input: new Float32Array(256), midi: new Float64Array(4) }));
  assert.ok(!validateStreamMessage({ t: 'proc', inst: 1, block: 7, numIn: 2, numOut: 2, input: new Float32Array(100), midi: new Float64Array(4) }));
  assert.ok(validateStreamMessage({ t: 'in', data: new Float32Array(12), channels: 4 }));
  assert.ok(!validateStreamMessage({ t: 'evil' }));
});

test('latency: the loopback ping is found at the right delay, noise is rejected', () => {
  const sr = 48000;
  const chirp = makeChirp(sr);
  const cap = new Float32Array(sr / 2);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  for (let i = 0; i < cap.length; i++) cap[i] = rnd();
  const D = 517;
  for (let i = 0; i < chirp.length; i++) cap[D + i] += 0.3 * chirp[i];
  assert.equal(findDelay(cap, chirp).lag, D);
  const r = analyzePing(cap, chirp, sr);
  assert.ok(r.ok);
  assert.equal(r.latencySamples, D);
  assert.equal(r.latencyMs, Math.round((D / sr) * 1000 * 100) / 100);
  const silent = analyzePing(Float32Array.from(cap, (_, i) => (i % 7) * 0.001), chirp, sr);
  assert.equal(silent.ok, false);
});

test('plugin DB: scan isolates crashing plugins and reuses unchanged bundles', async () => {
  const calls = [];
  const io = {
    listBundles: async (format, dirs) => (format === 'vst3' ? ['/P/VST3/Good.vst3', '/P/VST3/Crashy.vst3'] : format === 'clap' ? ['/P/CLAP/Two.clap'] : dirs.length ? ['all'] : []),
    mtime: async (p) => (p.includes('Good') ? 100 : 200),
    describe: async (format, p) => {
      calls.push(p);
      if (p.includes('Crashy')) return { ok: false, crashed: true, error: 'The plugin crashed the scanner (SIGSEGV)' };
      if (format === 'au') return { ok: true, plugins: [{ format: 'au', uid: 'aufx:dely:appl', name: 'AUDelay', vendor: 'Apple' }] };
      if (format === 'clap') return { ok: true, plugins: [{ format: 'clap', uid: 'a.synth', name: 'Zeta Synth', instrument: true, category: 'synthesizer' }, { format: 'clap', uid: 'a.verb', name: 'Alpha Verb', category: 'reverb' }] };
      return { ok: true, plugins: [{ format: 'vst3', uid: 'ABCD', name: 'Good EQ', vendor: 'Acme', category: 'Fx|EQ', path: p }] };
    },
  };
  const folders = defaultFolders('/Users/me');
  assert.deepEqual(folders.vst3, ['/Users/me/Library/Audio/Plug-Ins/VST3', '/Library/Audio/Plug-Ins/VST3']);
  const progress = [];
  const db = await scanPlugins({ folders, io, now: 5, onProgress: (p) => progress.push(p) });
  assert.deepEqual(db.plugins.map((p) => p.name), ['Alpha Verb', 'AUDelay', 'Good EQ', 'Zeta Synth']);
  assert.equal(db.failed.length, 1);
  assert.equal(db.failed[0].crashed, true);
  assert.equal(progress.length, 4);
  assert.equal(progress.at(-1).done, 4);
  // second scan: unchanged bundles are not loaded again (AU is always re-enumerated)
  calls.length = 0;
  const db2 = await scanPlugins({ db: parseDb(JSON.stringify(db)), folders, io, now: 6 });
  assert.deepEqual(calls, ['all']);
  assert.equal(db2.plugins.length, 4);
  assert.equal(db2.failed.length, 1, 'a known-bad bundle stays reported without crashing again');
  calls.length = 0;
  await scanPlugins({ db: db2, folders, io, force: true });
  assert.equal(calls.length, 4);
  // catalog entries for the plugin browser
  const cat = catalogEntries(db);
  const synth = cat.find((e) => e.name === 'Zeta Synth');
  assert.equal(synth.kind, 'native');
  assert.equal(synth.type, 'instrument');
  assert.equal(synth.category, 'Synth');
  assert.equal(synth.source.key, 'clap:a.synth');
  assert.equal(cat.find((e) => e.name === 'Good EQ').category, 'EQ / Filter');
  assert.equal(cat.find((e) => e.name === 'AUDelay').type, 'effect');
  assert.equal(new Set(cat.map((e) => e.id)).size, cat.length);
  assert.equal(keyHash('clap:a'), keyHash('clap:a'));
});

test('plugin DB: stored / scanner JSON is validated', () => {
  assert.deepEqual(parseDb('{bad'), emptyDb());
  assert.deepEqual(parseDb({ version: 99, plugins: [] }), emptyDb());
  const d = parseDb({ version: 1, plugins: [{ format: 'vst3', uid: 'X', name: 'Ok' }, { format: 'dll', uid: 'Y', name: 'No' }, null] });
  assert.equal(d.plugins.length, 1);
  assert.equal(d.plugins[0].key, 'vst3:X');
  const r = parseDescribeOutput('[clap] warning\n{"ok":true,"plugins":[{"format":"clap","uid":"z","name":"Z"}]}\n');
  assert.equal(r.ok, true);
  assert.equal(r.plugins[0].key, 'clap:z');
  assert.equal(parseDescribeOutput('garbage').ok, false);
});

test('params: plugin parameters map onto daW³ controls, automation defs and MIDI learn', () => {
  const params = [
    { id: 3, name: 'Cutoff', module: 'Filter', min: 20, max: 20000, default: 1000, steps: 0, flags: 1, unit: 'Hz' },
    { id: 7, name: 'Mode', min: 0, max: 3, default: 1, steps: 3, flags: 1 | 2 },
    { id: 9, name: 'Bypass', min: 0, max: 1, default: 0, steps: 1, flags: 1 | 2 | 16 },
    { id: 11, name: 'Meter', min: 0, max: 1, default: 0, flags: 8 },
    { id: 12, name: 'Secret', min: 0, max: 1, default: 0, flags: 4 },
  ];
  const c = controlsFromParams(params);
  assert.deepEqual(c.map((x) => x.address), ['3', '7', '9']);
  assert.equal(c[0].section, 'Filter');
  assert.equal(c[1].step, 1);
  assert.equal(c[2].type, 'bool');
  const defs = paramDefsFromControls(c);
  assert.equal(defs[0].key, 'values.3');
  assert.equal(defs[0].default, 1000);
  assert.deepEqual(diffValues({ 3: 1000 }, { 3: 1000, 7: 2, 99: 1, x: 2 }, c), [[7, 2]]);
  assert.deepEqual(diffValues({}, { 3: 1e9 }, c), [[3, 20000]], 'clamped to range');
  assert.equal(normalize(c[0], 20000), 1);
  assert.equal(denormalize(c[1], 0.5), 2, 'stepped params snap');
  assert.equal(midiToValue(c[1], 127), 3);
  assert.equal(midiToValue(c[2], 100), 1);
  assert.equal(midiToValue(c[0], 0), 20);
  assert.deepEqual(valuesPatch({ 3: 1 }, c, 7, 2), { 3: 1, 7: 2 });
  assert.equal(valuesPatch({ 7: 2 }, c, 7, 2), null);
  assert.equal(valuesPatch({}, c, 11, 0.5), null);
  assert.equal(controlsFromParams(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `p${i}`, flags: 1 }))).length, 512);
});

test('state: native plugins in a project (base64 chunk + values) survive save / load', () => {
  const entry = catalogEntries({ plugins: [{ key: 'vst3:AB', format: 'vst3', uid: 'AB', name: 'Verb', vendor: 'Acme', path: '/x.vst3', instrument: false }] })[0];
  const p = nativeParamsFor(entry);
  assert.deepEqual({ key: p.key, format: p.format, uid: p.uid, path: p.path, name: p.name, vendor: p.vendor, instrument: p.instrument }, { key: 'vst3:AB', format: 'vst3', uid: 'AB', path: '/x.vst3', name: 'Verb', vendor: 'Acme', instrument: false });
  const saved = JSON.parse(JSON.stringify({ ...p, state: 'AAECAw==', values: { 3: 0.5, foo: 1, 4: 'x' } }));
  const back = sanitizeNativeParams(saved);
  assert.equal(back.state, 'AAECAw==');
  assert.deepEqual(back.values, { 3: 0.5 });
  assert.equal(stateBytes(back.state), 4);
  assert.equal(sanitizeNativeParams({ key: 'x', state: '!!' }).state, '');
  assert.equal(sanitizeNativeParams({ key: 'x' }).key, '');
  const project = {
    tracks: [{ id: 't1', instrument: { type: 'native', params: p }, fx: [{ type: 'native', params: p }, { type: 'reverb' }] }, { id: 't2', instrument: { type: 'synth' }, fx: [] }],
    buses: [{ id: 'b1', fx: [{ type: 'native', params: p }] }],
    master: { fx: [] },
  };
  assert.deepEqual(nativePluginsIn(project).map((x) => `${x.owner}:${x.where}`), ['t1:instrument', 't1:fx', 'b1:fx']);
});
