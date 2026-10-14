// Native plugins (VST3 / AU / CLAP) in the Mac app. The plugin itself runs in the out-of-process
// plugin host; here it is a Web Audio node (daw3-native-plugin worklet) at a fixed, reported latency.
//   instrument params / effect params: { key, format, uid, path, name, vendor, state (base64), values: {id: plain} }
// Parameters map onto daW³'s model as `values.<id>` (automation, MIDI learn, undo); the plugin's own
// editor opens as a native window; its state chunk is saved in the project.
import { setStatus, getStatus } from './status.js';
import { getNativeClient, nativePluginsApi } from '../native/client.js';
import { controlsFromParams, diffValues, valuesPatch } from '../native/params.js';
import { sanitizeNativeParams } from '../native/state.js';

const live = new Map(); // inst -> plugin object (events from the host are routed here)
let unsubscribe = null;
function listen() {
  if (unsubscribe) return;
  const api = nativePluginsApi();
  if (!api?.onEvent) return;
  unsubscribe = api.onEvent((ev) => {
    if (ev?.event === 'plugin') live.get(ev.inst)?._hostEvent(ev);
    else if (ev?.event === 'plugin-host-exit') for (const i of ev.insts || []) live.get(i)?._crashed(ev);
    else if (ev?.event === 'server-exit') for (const p of live.values()) p._crashed(ev);
  });
}

export const nativeStatusKey = (p = {}) => (p.key ? `native:${p.key}` : null);

class NativeBase {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.p = {};
    this.key = null;
    this.inst = null;
    this.info = null;
    this.controls = [];
    this.sent = {};
    this.error = null;
    this.bridge = null;
    this.ready = Promise.resolve(false);
    this.isNative = true;
    this.onValues = opts.onNativeValues || null; // (values) => void : plugin GUI edits -> project
  }

  /** Total latency this plugin adds (plugin + bridge), for delay compensation. */
  get latencySamples() { return (this.info?.latency || 0) + (this.bridge?.bridgeLatency || 0); }
  get statusKey() { return nativeStatusKey(this.p); }

  setParams(raw) {
    const p = sanitizeNativeParams(raw || {});
    const prevState = this.p.state;
    this.p = p;
    this._applyGain?.();
    if (p.key !== this.key) {
      this.key = p.key;
      this.ready = this._build();
      return;
    }
    if (this.inst == null) return;
    const api = nativePluginsApi();
    if (p.state && p.state !== prevState && p.state !== this._lastState) {
      // state changed from outside (undo / project load): restore it, then re-apply the values
      api.setState(this.inst, p.state).then(() => { this.sent = {}; this._sendValues(); }).catch(() => {});
      return;
    }
    this._sendValues();
  }

  _sendValues() {
    const api = nativePluginsApi();
    for (const [id, v] of diffValues(this.sent, this.p.values, this.controls)) {
      this.sent[String(id)] = v;
      api.setParam(this.inst, id, v).catch(() => {});
    }
  }

  async _build() {
    this._teardown();
    this.error = null;
    const key = this.statusKey;
    const api = nativePluginsApi();
    const client = getNativeClient();
    if (!api || !client) { this.error = 'Native plugins are only available in the daW³ Mac app.'; return false; }
    if (!this.p.key) { this.error = 'No plugin selected.'; return false; }
    listen();
    if (!this.offline) setStatus(key, { state: 'loading', progress: null, message: `Loading ${this.p.name || 'plugin'}…` });
    const myKey = this.key;
    try {
      const info = await api.load({ key: this.p.key, format: this.p.format, uid: this.p.uid, path: this.p.path, name: this.p.name, state: this.p.state || '', sampleRate: this.ctx.sampleRate });
      if (myKey !== this.key || this.disposed) { api.unload(info.inst).catch(() => {}); return false; }
      this.inst = info.inst;
      this.info = info;
      live.set(info.inst, this);
      this.controls = controlsFromParams(info.params);
      this.sent = { ...Object.fromEntries(Object.entries(info.values || {}).map(([k, v]) => [k, Number(v)])) };
      this._sendValues();
      if (!this.offline) {
        this.bridge = await client.pluginNode(this.ctx, { inst: info.inst, numIn: info.plugin?.numInputs ?? 2, numOut: info.plugin?.numOutputs ?? 2 });
        this._connect(this.bridge.node);
      }
      if (!this.offline) {
        setStatus(key, { state: 'ready', progress: 1, message: info.plugin?.name || this.p.name,
          info: { name: info.plugin?.name || this.p.name, vendor: info.plugin?.vendor, params: this.controls, hasGui: !!info.hasEditor, latency: this.latencySamples, offline: info.offline !== false } });
      }
      return true;
    } catch (e) {
      this.error = e?.message || String(e);
      if (!this.offline) setStatus(key, { state: 'error', error: this.error, message: this.error });
      return false;
    }
  }

  _hostEvent(ev) {
    if (ev.event === 'param') {
      const values = valuesPatch(this.p.values, this.controls, ev.param, ev.value);
      if (values) { this.sent[String(ev.param)] = Number(ev.value); this.p = { ...this.p, values }; this.onValues?.(values); }
    } else if (ev.event === 'latency') {
      if (this.info) this.info.latency = ev.samples;
      const st = getStatus(this.statusKey);
      if (st.info) setStatus(this.statusKey, { ...st, info: { ...st.info, latency: this.latencySamples } });
    } else if (ev.event === 'editor-closed') {
      this.onEditorClosed?.();
    } else if (ev.event === 'params-changed') {
      nativePluginsApi()?.info(this.inst).then((info) => {
        this.controls = controlsFromParams(info.params);
        const st = getStatus(this.statusKey);
        setStatus(this.statusKey, { ...st, info: { ...(st.info || {}), params: this.controls } });
      }).catch(() => {});
    }
  }

  _crashed() {
    if (this.inst != null) live.delete(this.inst);
    this.inst = null;
    this.error = 'The plugin host stopped (a plugin crashed). Retry to reload the plugin.';
    if (!this.offline) setStatus(this.statusKey, { state: 'error', error: this.error, message: this.error });
  }

  /** Re-create the plugin (after a crash). */
  reload() { this.key = null; this.setParams(this.p); return this.ready; }

  async openEditor() {
    await this.ready;
    if (this.inst == null) throw new Error(this.error || 'The plugin is not loaded');
    return nativePluginsApi().openEditor(this.inst);
  }

  /** The plugin's state chunk (base64), also remembered so setParams doesn't push it back. */
  async getState() {
    if (this.inst == null) return null;
    const s = await nativePluginsApi().getState(this.inst);
    this._lastState = s;
    return s;
  }

  async flush() {}

  _teardown() {
    this._disconnect?.();
    if (this.bridge) { this.bridge.dispose(); this.bridge = null; }
    if (this.inst != null) { live.delete(this.inst); nativePluginsApi()?.unload(this.inst).catch(() => {}); this.inst = null; }
  }

  dispose() { this.disposed = true; this.key = '#disposed'; this._teardown(); }
}

// ----------------------------------------------------------------------------- instrument
export class NativeEngine extends NativeBase {
  constructor(ctx, output, params, opts) {
    super(ctx, opts);
    this.out = ctx.createGain();
    this.out.connect(output);
    this.voices = [];
    this.held = new Set();
    this.prerendered = false;
    this.setParams(params);
  }

  _applyGain() { try { this.out.gain.setTargetAtTime(Math.max(0, Number(this.p.gain ?? 1)), this.ctx.currentTime, 0.01); } catch { /* */ } }
  _connect(node) { node.connect(this.out); }
  _disconnect() { /* bridge.dispose() disconnects the node */ }

  _midi(events) {
    if (this.prerendered || !this.bridge) return;
    this.bridge.node.port.postMessage({ type: 'midi', events });
  }

  _pitch(p) { return Math.max(0, Math.min(127, Math.round(p + Number(this.p.transpose || 0)))); }
  _vel(v) { return Math.max(1, Math.min(127, Math.round((v ?? 0.8) * 127))); }

  trigger(time, pitch, vel, durSec) {
    const k = this._pitch(pitch);
    this._midi([[time, 0x90, k, this._vel(vel)], [time + Math.max(0.005, durSec), 0x80, k, 0]]);
  }
  noteOn(pitch, vel, time) { const k = this._pitch(pitch); this.held.add(k); this._midi([[time ?? this.ctx.currentTime, 0x90, k, this._vel(vel)]]); }
  noteOff(pitch, time) { const k = this._pitch(pitch); this.held.delete(k); this._midi([[time ?? this.ctx.currentTime, 0x80, k, 0]]); }
  allNotesOff(time) {
    const t = time ?? this.ctx.currentTime;
    this.bridge?.node.port.postMessage({ type: 'clear' });
    const evs = [...this.held].map((k) => [t, 0x80, k, 0]);
    for (let ch = 0; ch < 16; ch++) evs.push([t, 0xb0 | ch, 123, 0]);
    this.held.clear();
    this._midi(evs);
  }

  /**
   * Offline export: render this instrument's whole part faster than realtime in the plugin host
   * (offline processing mode) and play it back in the OfflineAudioContext.
   * notes: [{ time (s), pitch, vel (0..1), dur (s) }], frames: render length.
   */
  async prerender(notes, frames) {
    const ok = await this.ready;
    if (!ok || this.inst == null) return false;
    const sr = this.ctx.sampleRate;
    const events = [];
    for (const n of notes) {
      const k = this._pitch(n.pitch);
      const on = Math.max(0, Math.round(n.time * sr));
      events.push([on, 0x90, k, this._vel(n.vel)], [Math.max(on + 1, Math.round((n.time + Math.max(0.005, n.dur)) * sr)), 0x80, k, 0]);
    }
    const r = await nativePluginsApi().render({ inst: this.inst, frames, events });
    const buf = this.ctx.createBuffer(2, frames, sr);
    for (let c = 0; c < 2; c++) buf.copyToChannel(r.output.subarray(Math.min(c, r.numOut - 1) * frames, Math.min(c, r.numOut - 1) * frames + frames), c);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start(0);
    this.prerendered = true;
    return true;
  }

  dispose() {
    super.dispose();
    const out = this.out;
    setTimeout(() => { try { out.disconnect(); } catch { /* */ } }, 300);
  }
}

// ----------------------------------------------------------------------------- effect
export class NativeEffect extends NativeBase {
  constructor(ctx, input, output) {
    super(ctx);
    this.input = input;
    this.output = output;
    this.thru = true;
    input.connect(output); // audio passes through until the plugin is ready (the effect shell does dry / wet)
  }

  _connect(node) {
    this.input.connect(node);
    node.connect(this.output);
    if (this.thru) { try { this.input.disconnect(this.output); } catch { /* */ } this.thru = false; }
  }

  _disconnect() {
    if (this.bridge) { try { this.input.disconnect(this.bridge.node); } catch { /* */ } }
    if (!this.thru) { try { this.input.connect(this.output); } catch { /* */ } this.thru = true; }
  }

  async _build() {
    if (this.offline) { this.error = 'Native effects render through the realtime bounce, not offline.'; return false; }
    return super._build();
  }
}

export { NativeEngine as Engine, NativeEffect as Effect };
