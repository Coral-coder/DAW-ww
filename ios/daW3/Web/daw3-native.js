// daW³ for iOS — the JavaScript half of the native bridge. Injected by the app (WKUserScript, document start,
// main frame) before any page script runs; a classic script, not a module.
//
// Exposes window.daw3Native with the same shape as the Mac app's preload where they overlap
// (isNative, platform, openFiles, saveFile, readFile, pathForFile, onCommand, ready) plus iOS extras:
// share, midi, audio, auv3 — and installs a Web MIDI polyfill (navigator.requestMIDIAccess) backed by CoreMIDI,
// so the existing Web MIDI code works unchanged (iOS WebKit has no Web MIDI).
//
// Wire format (JS -> native): webkit.messageHandlers.daw3.postMessage({ v: 1, cmd, args }) — a
// WKScriptMessageHandlerWithReply, so postMessage returns a Promise of the native reply (or rejects with its error).
// Wire format (native -> JS): window.__daw3NativeReceive([event, …]) with events
//   { type: 'midi', id, data: [bytes] }                       one complete MIDI message from input port `id`
//   { type: 'midi-state', inputs: [port], outputs: [port] }   device list changed (port = { id, name, manufacturer, version })
//   { type: 'command', cmd, payload }                         app commands (files opened via "Open in daW³", …)
//   { type: 'audio', event: 'interruption-began' | 'interruption-ended' | 'route-change', info }
// Binary data crosses as base64 (JS -> native) or as daw3://localhost/__files/… URLs fetched by the bridge (native -> JS).
(function install(global) {
  'use strict';
  if (global.daw3Native) return;
  const handler = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.daw3;
  if (!handler) return;

  const VERSION = 1;
  const call = (cmd, args) => Promise.resolve(handler.postMessage({ v: VERSION, cmd, args: args || {} }));

  // ------------------------------------------------------------------------------------------------ binary helpers
  function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('daw3Native: data must be a string, ArrayBuffer or typed array');
  }
  function toBase64(data) {
    const bytes = toBytes(data);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return global.btoa(s);
  }
  /** Native file descriptor { name, path, url } -> { name, path, data: Uint8Array } (Mac preload shape). */
  async function fetchFile(f) {
    if (!f) return null;
    if (f.data != null) return { name: f.name, path: f.path || null, data: toBytes(f.data) };
    const res = await global.fetch(f.url);
    if (!res.ok) throw new Error(`could not read ${f.name} (${res.status})`);
    return { name: f.name, path: f.path || null, data: new Uint8Array(await res.arrayBuffer()) };
  }
  const fetchFiles = (list) => Promise.all((list || []).map(fetchFile)).then((a) => a.filter(Boolean));

  // ------------------------------------------------------------------------------------------------ commands
  const commandListeners = new Set();
  const pendingCommands = [];
  async function deliverCommand(cmd, payload) {
    // file payloads arrive as URLs; resolve them to bytes so listeners get the Mac shape
    if (payload && Array.isArray(payload.files)) payload = await fetchFiles(payload.files);
    if (!commandListeners.size) { pendingCommands.push([cmd, payload]); return; }
    for (const cb of commandListeners) {
      try { cb(cmd, payload); } catch (e) { console.error('[daw3Native] command', cmd, e); }
    }
  }

  // ------------------------------------------------------------------------------------------------ Web MIDI polyfill
  const midi = createMidi();

  function createMidi() {
    const inputs = new Map(), outputs = new Map();
    let access = null, sysex = false, starting = null;
    const now = () => (global.performance ? global.performance.now() : Date.now());
    const mkEvent = (type, props) => {
      const ev = new global.Event(type);
      for (const k in props) Object.defineProperty(ev, k, { value: props[k], enumerable: true });
      return ev;
    };

    class MIDIPort extends global.EventTarget {
      constructor(info, type) {
        super();
        this.id = String(info.id);
        this.name = info.name || 'MIDI device';
        this.manufacturer = info.manufacturer || '';
        this.version = info.version != null ? String(info.version) : '';
        this.type = type;
        this.state = 'connected';
        this.connection = 'closed';
        this.onstatechange = null;
      }
      open() {
        if (this.connection !== 'open' && this.state === 'connected') { this.connection = 'open'; this._changed(); }
        return Promise.resolve(this);
      }
      close() {
        if (this.connection !== 'closed') { this.connection = 'closed'; this._changed(); }
        return Promise.resolve(this);
      }
      _changed() {
        const ev = mkEvent('statechange', { port: this });
        if (typeof this.onstatechange === 'function') this.onstatechange(ev);
        this.dispatchEvent(ev);
        if (access) access._portChanged(this);
      }
    }
    class MIDIInput extends MIDIPort {
      constructor(info) { super(info, 'input'); this._onmessage = null; }
      get onmidimessage() { return this._onmessage; }
      set onmidimessage(fn) { this._onmessage = typeof fn === 'function' ? fn : null; if (this._onmessage) this.open(); }
      addEventListener(type, fn, opts) { super.addEventListener(type, fn, opts); if (type === 'midimessage') this.open(); }
      _receive(bytes) {
        if (this.connection !== 'open') return;
        if (!sysex && bytes[0] === 0xf0) return;
        const ev = mkEvent('midimessage', { data: Uint8Array.from(bytes), receivedTime: now() });
        if (this._onmessage) { try { this._onmessage.call(this, ev); } catch (e) { console.error('[midi]', e); } }
        this.dispatchEvent(ev);
      }
    }
    class MIDIOutput extends MIDIPort {
      constructor(info) { super(info, 'output'); }
      send(data, timestamp) {
        const bytes = Array.from(data || [], (b) => {
          const n = Number(b);
          if (!Number.isInteger(n) || n < 0 || n > 255) throw new TypeError('MIDIOutput.send: bytes must be integers 0-255');
          return n;
        });
        if (!bytes.length) return;
        if (!(bytes[0] & 0x80)) throw new TypeError('MIDIOutput.send: message must start with a status byte');
        if (!sysex && bytes.includes(0xf0)) {
          const err = new Error('System exclusive messages need requestMIDIAccess({ sysex: true })');
          err.name = 'InvalidAccessError';
          throw err;
        }
        if (this.state !== 'connected') { const err = new Error('MIDI port is disconnected'); err.name = 'InvalidStateError'; throw err; }
        if (this.connection !== 'open') this.open();
        const delay = timestamp ? Math.max(0, timestamp - now()) : 0;
        call('midi.send', { id: this.id, data: bytes, delay }).catch((e) => console.warn('[midi] send failed', e));
      }
      clear() { /* nothing is buffered on our side */ }
    }

    class MIDIAccess extends global.EventTarget {
      constructor() {
        super();
        this.inputs = inputs;
        this.outputs = outputs;
        this.onstatechange = null;
      }
      get sysexEnabled() { return sysex; }
      _portChanged(port) {
        const ev = mkEvent('statechange', { port });
        if (typeof this.onstatechange === 'function') this.onstatechange(ev);
        this.dispatchEvent(ev);
      }
    }

    /** Merge a native device list into the port maps, firing statechange for arrivals / departures. */
    function applyState(state) {
      const sync = (map, list, Cls) => {
        const seen = new Set();
        for (const info of list || []) {
          const id = String(info.id);
          seen.add(id);
          let port = map.get(id);
          if (!port) {
            port = new Cls(info);
            map.set(id, port);
            if (access) access._portChanged(port);
          } else if (port.state !== 'connected') {
            port.state = 'connected';
            port._changed();
          }
        }
        for (const [id, port] of [...map]) {
          if (seen.has(id)) continue;
          map.delete(id);
          port.state = 'disconnected';
          port.connection = 'closed';
          port._changed();
        }
      };
      sync(inputs, state.inputs, MIDIInput);
      sync(outputs, state.outputs, MIDIOutput);
    }

    function requestMIDIAccess(options) {
      if (options && options.sysex) sysex = true;
      if (!starting) {
        starting = call('midi.access', { sysex: !!(options && options.sysex) }).then((state) => {
          access = access || new MIDIAccess();
          applyState(state || {});
          return access;
        }, (e) => {
          starting = null;
          const err = new Error('MIDI unavailable: ' + ((e && e.message) || e));
          err.name = 'NotSupportedError';
          throw err;
        });
      }
      return starting;
    }

    return {
      requestMIDIAccess,
      receive(id, data) { const port = inputs.get(String(id)); if (port) port._receive(data); },
      applyState(state) { if (access) applyState(state); },
      list: () => call('midi.list'),
      get inputs() { return inputs; },
      get outputs() { return outputs; },
    };
  }

  if (global.navigator && !global.navigator.requestMIDIAccess) {
    try {
      Object.defineProperty(global.navigator, 'requestMIDIAccess', { value: midi.requestMIDIAccess, configurable: true, writable: true });
    } catch (e) { global.navigator.requestMIDIAccess = midi.requestMIDIAccess; }
  }

  // ------------------------------------------------------------------------------------------------ audio session
  // Recording needs .playAndRecord; everything else runs as .playback (plays with the silent switch on, keeps playing
  // when locked, does not mix with other apps). getUserMedia is wrapped so the switch is automatic.
  const audioListeners = new Set();
  let liveInputTracks = 0;
  function setSessionMode(mode) {
    try { if (global.navigator.audioSession) global.navigator.audioSession.type = mode === 'record' ? 'play-and-record' : 'playback'; } catch (e) { /* WebKit < 16.4 */ }
    return call('audio.session', { mode });
  }
  const md = global.navigator && global.navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const original = md.getUserMedia.bind(md);
    const wrapped = async function getUserMedia(constraints) {
      const wantsAudio = !!(constraints && constraints.audio);
      if (wantsAudio) await setSessionMode('record').catch(() => {});
      let stream;
      try { stream = await original(constraints); } catch (e) {
        if (wantsAudio && !liveInputTracks) setSessionMode('playback').catch(() => {});
        throw e;
      }
      for (const track of stream.getAudioTracks ? stream.getAudioTracks() : []) {
        liveInputTracks++;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (--liveInputTracks <= 0) { liveInputTracks = 0; setSessionMode('playback').catch(() => {}); }
        };
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); finish(); };
        track.addEventListener('ended', finish);
      }
      return stream;
    };
    try { md.getUserMedia = wrapped; } catch (e) { /* read-only */ }
  }
  function resumeAudio() {
    const ctx = global.daw3 && global.daw3.engine && global.daw3.engine.ctx;
    if (ctx && ctx.state !== 'running' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
  }

  // ------------------------------------------------------------------------------------------------ native -> JS
  global.__daw3NativeReceive = function receive(events) {
    for (const ev of events || []) {
      try {
        if (ev.type === 'midi') midi.receive(ev.id, ev.data);
        else if (ev.type === 'midi-state') midi.applyState(ev);
        else if (ev.type === 'command') deliverCommand(ev.cmd, ev.payload).catch((e) => console.error('[daw3Native]', e));
        else if (ev.type === 'audio') {
          if (ev.event === 'interruption-ended') resumeAudio();
          for (const cb of audioListeners) cb(ev.event, ev.info || {});
        }
      } catch (e) { console.error('[daw3Native] event', ev && ev.type, e); }
    }
  };

  // ------------------------------------------------------------------------------------------------ public API
  const api = {
    isNative: true,
    platform: 'ios',
    bridgeVersion: VERSION,
    /** App / device info: { version, build, os, model, idiom }. */
    info: () => call('info'),
    /** Files-app picker -> [{ name, path, data: Uint8Array }]. opts: { kind: 'audio'|'project'|'midi'|'any', multiple, title } */
    openFiles: (opts) => call('openFiles', opts || {}).then(fetchFiles),
    /** "Save to Files" (export picker) -> saved file name | null when cancelled. opts: { name, data } */
    saveFile: (opts) => {
      const o = opts || {};
      return call('saveFile', { name: String(o.name || 'untitled'), data: toBase64(o.data) });
    },
    /** iOS share sheet (AirDrop, Messages, Save to Files…) -> true when shared. opts: { name, data, title } */
    share: (opts) => {
      const o = opts || {};
      return call('share', { name: String(o.name || 'untitled'), data: toBase64(o.data), title: o.title ? String(o.title) : '' });
    },
    /** Re-read a file picked / opened this session -> { name, path, data } */
    readFile: (p) => call('readFile', { path: String(p || '') }).then(fetchFile),
    /** Files have no stable paths in a WebView. */
    pathForFile: () => '',
    /** App commands (Open in daW³ from Files / AirDrop…): cb(cmd, payload). Returns an unsubscribe function. */
    onCommand: (cb) => {
      commandListeners.add(cb);
      for (const [cmd, payload] of pendingCommands.splice(0)) { try { cb(cmd, payload); } catch (e) { console.error(e); } }
      return () => commandListeners.delete(cb);
    },
    /** The page is ready for commands (flushes documents opened before the page loaded). */
    ready: () => call('ready').catch(() => {}),
    midi: {
      /** Raw device list { inputs, outputs } (navigator.requestMIDIAccess is the normal way in). */
      list: () => midi.list(),
      requestAccess: (opts) => midi.requestMIDIAccess(opts),
    },
    audio: {
      /** 'playback' | 'record' — normally automatic (getUserMedia switches to record and back). */
      setSession: (mode) => setSessionMode(mode === 'record' ? 'record' : 'playback'),
      /** Current route: { sampleRate, ioBufferDuration, inputs: [{name, type}], outputs: [...], category } */
      route: () => call('audio.route'),
      /** Preferred hardware settings (audio interfaces): { sampleRate, ioBufferDuration } */
      setPreferred: (opts) => call('audio.preferred', opts || {}),
      /** cb(event, info) for 'interruption-began' | 'interruption-ended' | 'route-change'. Returns unsubscribe. */
      on: (cb) => { audioListeners.add(cb); return () => audioListeners.delete(cb); },
    },
    auv3: {
      /** Installed Audio Unit v3 components: [{ name, manufacturer, kind, type, subtype, manufacturerCode, version, … }]. opts: { kind } */
      list: (opts) => call('auv3.list', opts || {}),
    },
  };
  Object.defineProperty(global, 'daw3Native', { value: Object.freeze(api), configurable: false, writable: false, enumerable: true });
})(typeof window !== 'undefined' ? window : globalThis);
