// The iOS app's JS bridge (ios/daW3/Web/daw3-native.js): window.daw3Native shape, the postMessage schema shared with
// NativeBridge.swift, the Web MIDI polyfill and the Pocket glue (src/mobile/native.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { routeFiles } from '../src/mobile/native.js';

const BRIDGE = readFileSync(new URL('../ios/daW3/Web/daw3-native.js', import.meta.url), 'utf8');
const SWIFT = readFileSync(new URL('../ios/daW3/Bridge/NativeBridge.swift', import.meta.url), 'utf8');

/** Load the bridge into a fake WKWebView page. replies: cmd -> (args) => value | Promise. */
function loadBridge(replies = {}, extra = {}) {
  const sent = [];
  const files = extra.files || {};
  const win = {
    console, Promise, Uint8Array, ArrayBuffer, TextEncoder, Map, Set, Error, TypeError, Array, Object, Number, String, Math, JSON,
    EventTarget, Event,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    performance: { now: () => 1000 },
    navigator: extra.navigator || {},
    fetch: async (url) => {
      const data = files[url];
      return data ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(data).buffer } : { ok: false, status: 404 };
    },
    webkit: {
      messageHandlers: {
        daw3: {
          postMessage(msg) {
            sent.push(msg);
            const fn = replies[msg.cmd];
            return fn ? Promise.resolve().then(() => fn(msg.args)) : Promise.resolve(null);
          },
        },
      },
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(BRIDGE, win, { filename: 'daw3-native.js' });
  return { win, sent, nat: win.daw3Native, receive: (events) => win.__daw3NativeReceive(events) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('ios bridge: not installed outside the app (no webkit.messageHandlers.daw3)', () => {
  const win = { navigator: {}, console };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(BRIDGE, win);
  assert.equal(win.daw3Native, undefined);
  assert.equal(win.navigator.requestMIDIAccess, undefined);
});

test('ios bridge: daw3Native has the Mac preload shape where they overlap, plus iOS extras', () => {
  const { nat } = loadBridge();
  assert.equal(nat.isNative, true);
  assert.equal(nat.platform, 'ios');
  for (const k of ['openFiles', 'saveFile', 'readFile', 'pathForFile', 'onCommand', 'ready', 'share', 'info']) assert.equal(typeof nat[k], 'function', k);
  assert.equal(typeof nat.midi.list, 'function');
  assert.equal(typeof nat.audio.setSession, 'function');
  assert.equal(typeof nat.auv3.list, 'function');
  assert.ok(Object.isFrozen(nat));
});

test('ios bridge: every message is { v: 1, cmd, args } and every cmd is handled by NativeBridge.swift', async () => {
  const { nat, sent, win } = loadBridge({ 'midi.access': () => ({ inputs: [], outputs: [{ id: '7', name: 'Synth' }] }) });
  await nat.info();
  await nat.ready();
  await nat.saveFile({ name: 'a.daW3', data: '{}' });
  await nat.share({ name: 'a.wav', data: new Uint8Array([1, 2, 3]), title: 'Song' });
  await nat.openFiles({ kind: 'audio' });
  await nat.readFile('files/x/a.wav').catch(() => {});
  await nat.midi.list();
  await nat.audio.setSession('record');
  await nat.audio.route();
  await nat.audio.setPreferred({ sampleRate: 48000 });
  await nat.auv3.list({ kind: 'instrument' });
  const access = await win.navigator.requestMIDIAccess();
  access.outputs.get('7').send([0x90, 60, 100]);
  const cmds = new Set(sent.map((m) => m.cmd));
  for (const m of sent) {
    assert.equal(m.v, 1);
    assert.equal(typeof m.cmd, 'string');
    assert.equal(typeof m.args, 'object');
    assert.ok(m.args && !Array.isArray(m.args));
  }
  // the bridge source names exactly these commands; Swift must switch over all of them
  const inJs = new Set([...BRIDGE.matchAll(/call\('([\w.]+)'/g)].map((x) => x[1]));
  assert.deepEqual([...cmds].sort(), [...inJs].sort(), 'every bridge command was exercised');
  for (const c of inJs) assert.ok(SWIFT.includes(`case "${c}":`), `NativeBridge.swift handles "${c}"`);
});

test('ios bridge: saveFile / share send base64; openFiles fetches daw3:// file URLs into Uint8Array', async () => {
  const url = 'daw3://localhost/__files/t1/kick.wav';
  const { nat, sent } = loadBridge({ openFiles: () => [{ name: 'kick.wav', path: 'files/t1/kick.wav', url }] }, { files: { [url]: [82, 73, 70, 70] } });
  await nat.saveFile({ name: 'x.bin', data: new Uint8Array([0, 255, 128]) });
  assert.equal(sent.at(-1).args.data, Buffer.from([0, 255, 128]).toString('base64'));
  await nat.share({ name: 's.txt', data: 'hé' });
  assert.equal(Buffer.from(sent.at(-1).args.data, 'base64').toString('utf8'), 'hé');
  const [f] = await nat.openFiles({ kind: 'audio', multiple: true });
  assert.equal(f.name, 'kick.wav');
  assert.equal(f.path, 'files/t1/kick.wav');
  assert.deepEqual([...f.data], [82, 73, 70, 70]);
});

test('ios bridge: commands opened before the page listens are queued; file payloads become bytes', async () => {
  const url = 'daw3://localhost/__files/t2/song.daW3';
  const { nat, receive } = loadBridge({}, { files: { [url]: [123, 125] } });
  receive([{ type: 'command', cmd: 'open-files', payload: { files: [{ name: 'song.daW3', path: 'files/t2/song.daW3', url }] } }]);
  await tick(); await tick();
  const got = [];
  const off = nat.onCommand((cmd, payload) => got.push([cmd, payload]));
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 'open-files');
  assert.equal(got[0][1][0].name, 'song.daW3');
  assert.deepEqual([...got[0][1][0].data], [123, 125]);
  off();
});

test('ios MIDI polyfill: Web MIDI shape, input messages, sysex gate, output send, hot-plug', async () => {
  const state = { inputs: [{ id: '101', name: 'Keystep', manufacturer: 'Arturia', version: 1 }], outputs: [{ id: '202', name: 'Synth' }] };
  const { win, sent, receive } = loadBridge({ 'midi.access': () => state });
  const access = await win.navigator.requestMIDIAccess();
  assert.equal(access.sysexEnabled, false);
  assert.equal(access.inputs.size, 1);
  const input = access.inputs.get('101');
  assert.equal(input.type, 'input');
  assert.equal(input.name, 'Keystep');
  assert.equal(input.manufacturer, 'Arturia');
  assert.equal(input.state, 'connected');
  assert.equal(input.connection, 'closed');
  // the same iteration the app's enableMidiInput() uses
  const msgs = [];
  for (const i of access.inputs.values()) i.onmidimessage = (m) => msgs.push([...m.data]);
  assert.equal(input.connection, 'open');
  const listened = [];
  input.addEventListener('midimessage', (e) => listened.push(e.data[1]));
  receive([{ type: 'midi', id: '101', data: [0x90, 60, 100] }, { type: 'midi', id: '101', data: [0xf0, 1, 0xf7] }, { type: 'midi', id: '999', data: [0x80, 1, 0] }]);
  assert.deepEqual(msgs, [[0x90, 60, 100]], 'sysex dropped without { sysex: true }; unknown ports ignored');
  assert.deepEqual(listened, [60]);
  assert.ok(msgs.length && input.onmidimessage);

  const out = access.outputs.get('202');
  out.send([0x90, 64, 1], 1250);
  const m = sent.at(-1);
  assert.equal(m.cmd, 'midi.send');
  assert.deepEqual(JSON.parse(JSON.stringify(m.args)), { id: '202', data: [0x90, 64, 1], delay: 250 });
  assert.throws(() => out.send([0x90, 300, 1]), TypeError);
  assert.throws(() => out.send([60, 1]), TypeError);
  assert.throws(() => out.send([0xf0, 1, 0xf7]), (e) => e.name === 'InvalidAccessError');

  // hot-plug: a new input arrives, the old one leaves
  const changes = [];
  access.onstatechange = (e) => changes.push(`${e.port.id}:${e.port.state}`);
  receive([{ type: 'midi-state', inputs: [{ id: '303', name: 'Pads' }], outputs: state.outputs }]);
  assert.deepEqual([...access.inputs.keys()], ['303']);
  assert.equal(input.state, 'disconnected');
  assert.deepEqual(changes, ['303:connected', '101:disconnected']);

  // sysex once requested
  const again = await win.navigator.requestMIDIAccess({ sysex: true });
  assert.equal(again, access);
  assert.equal(access.sysexEnabled, true);
  const pads = access.inputs.get('303');
  const sx = [];
  pads.onmidimessage = (e) => sx.push([...e.data]);
  receive([{ type: 'midi', id: '303', data: [0xf0, 0x7e, 0xf7] }]);
  assert.deepEqual(sx, [[0xf0, 0x7e, 0xf7]]);
});

test('ios MIDI polyfill: rejects with NotSupportedError when CoreMIDI fails, and can retry', async () => {
  let fail = true;
  const { win } = loadBridge({ 'midi.access': () => { if (fail) throw new Error('no CoreMIDI'); return { inputs: [], outputs: [] }; } });
  await assert.rejects(win.navigator.requestMIDIAccess(), (e) => e.name === 'NotSupportedError');
  fail = false;
  const a = await win.navigator.requestMIDIAccess();
  assert.equal(a.inputs.size, 0);
});

test('ios bridge: getUserMedia switches the audio session to record and back when the mic track stops', async () => {
  const track = { stop() { this.stopped = true; }, addEventListener() {} };
  const navigator = { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }) } };
  const { sent } = loadBridge({}, { navigator });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  assert.deepEqual(sent.filter((m) => m.cmd === 'audio.session').map((m) => m.args.mode), ['record']);
  stream.getAudioTracks()[0].stop();
  assert.equal(track.stopped, true);
  assert.deepEqual(sent.filter((m) => m.cmd === 'audio.session').map((m) => m.args.mode), ['record', 'playback']);
});

test('ios: Pocket routes opened files — projects, MIDI, audio, other', () => {
  const r = routeFiles([{ name: 'a.daW3' }, { name: 'b.mid' }, { name: 'c.WAV' }, { name: 'd.m4a' }, { name: 'voice', type: 'audio/mp4' }, { name: 'e.pdf' }]);
  assert.deepEqual(r.projects.map((f) => f.name), ['a.daW3']);
  assert.deepEqual(r.midi.map((f) => f.name), ['b.mid']);
  assert.deepEqual(r.audio.map((f) => f.name), ['c.WAV', 'd.m4a', 'voice']);
  assert.deepEqual(r.other.map((f) => f.name), ['e.pdf']);
});

test('ios: Info.plist registers .daW3, background audio and the microphone', () => {
  const plist = readFileSync(new URL('../ios/daW3/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>com\.coralcoder\.daw3\.project<\/string>/);
  assert.match(plist, /<string>daW3<\/string>/);
  assert.match(plist, /UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>/);
  assert.match(plist, /NSMicrophoneUsageDescription/);
});
