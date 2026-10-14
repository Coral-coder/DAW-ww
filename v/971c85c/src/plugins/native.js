// Native plugins (VST3 / AU / CLAP) in the Mac app. The plugin itself runs in the out-of-process
// plugin host; here it is a Web Audio node (daw3-native-plugin worklet) at a fixed, reported latency.
//   instrument params / effect params: { key, format, uid, path, name, vendor, state (base64), values: {id: plain} }
// Parameters map onto daW³'s model as `values.<id>` (automation, MIDI learn, undo); the plugin's own
// editor opens as a native window; its state chunk is saved in the project. Effects with a sidechain input
// bus get a key input (the effect's `keyInput`, fed by the mixer from params.sourceTrackId); multi-out
// instruments expose their aux output buses (setPadOutputs({ bus<k>: AudioNode })); presets are listed /
// loaded / saved through the plugin host.
import { setStatus, getStatus } from './status.js';
import { getNativeClient, nativePluginsApi } from '../native/client.js';
import { controlsFromParams, diffValues, valuesPatch } from '../native/params.js';
import { sanitizeNativeParams } from '../native/state.js';

const live = new Map(); // inst -> plugin object (events from the host are routed here)
let unsubscribe = null;
// App-level hooks (installed by the UI, src/ui/plugin-device.js installNativeHooks):
//   values(plugin, values)  a change in the plugin's own window -> the project (undo, automation, controller feedback)
//   touch(plugin, address)  the user moved that parameter in the plugin's window (MIDI learn picks it up)
const hooks = { values: null, touch: null };
export function setNativeHooks(h = {}) { Object.assign(hooks, h); }
/** Every live native plugin object (instruments + effects). */
export const livePlugins = () => [...live.values()];
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
        this.bridge = await client.pluginNode(this.ctx, this._nodeShape(info.plugin || {}));
        this._connect(this.bridge.node);
      }
      if (!this.offline) {
        setStatus(key, { state: 'ready', progress: 1, message: info.plugin?.name || this.p.name,
          info: { name: info.plugin?.name || this.p.name, vendor: info.plugin?.vendor, format: info.plugin?.format, params: this.controls, hasGui: !!info.hasEditor,
            latency: this.latencySamples, offline: info.offline !== false, sidechain: info.plugin?.sidechain || 0,
            outputBuses: info.plugin?.outputBuses || [{ name: 'Main', channels: info.plugin?.numOutputs ?? 2 }] } });
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
      if (values) {
        this.sent[String(ev.param)] = Number(ev.value);
        this.p = { ...this.p, values };
        if (this.onValues) this.onValues(values); else hooks.values?.(this, values);
      }
      hooks.touch?.(this, String(ev.param));
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

  /** Bridge node shape (client.pluginNode options) for the loaded plugin. */
  _nodeShape(pl) { return { inst: this.inst, numIn: pl.numInputs ?? 2, numOut: pl.numOutputs ?? 2 }; }

  /** Factory presets + preset files -> [{ id, name, category, kind: 'factory'|'file' }]. */
  async listPresets() {
    await this.ready;
    if (this.inst == null) throw new Error(this.error || 'The plugin is not loaded');
    return nativePluginsApi().presets(this.inst);
  }

  /**
   * Load a preset in the plugin -> { values, state } for the project (the plugin's new parameter values and its
   * state chunk, so the project reproduces the preset without the file).
   */
  async loadPreset(id) {
    await this.ready;
    if (this.inst == null) throw new Error(this.error || 'The plugin is not loaded');
    const api = nativePluginsApi();
    const info = await api.loadPreset(this.inst, id);
    if (info?.params) this.controls = controlsFromParams(info.params);
    const values = {};
    for (const c of this.controls) if (info?.values && c.address in info.values) values[c.address] = Number(info.values[c.address]);
    this.sent = { ...this.sent, ...values };
    this.p = { ...this.p, values: { ...(this.p.values || {}), ...values } };
    const state = await this.getState().catch(() => null);
    return { values: this.p.values, state };
  }

  /** Save the current settings as a user preset file (VST3 / AU) -> its path. */
  async savePreset(name) {
    await this.ready;
    if (this.inst == null) throw new Error(this.error || 'The plugin is not loaded');
    return nativePluginsApi().savePreset(this.inst, name);
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
    this.padOuts = null; // multi-out: { bus<k>: AudioNode } (plugin output bus k -> a mixer channel)
    this.auxGains = new Map(); // bus<k> -> GainNode (the instrument's gain applies to aux buses too)
    this.setParams(params);
  }

  _applyGain() {
    const g = Math.max(0, Number(this.p.gain ?? 1));
    for (const n of [this.out, ...this.auxGains.values()]) { try { n.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01); } catch { /* */ } }
  }
  _nodeShape(pl) { return { inst: this.inst, numIn: 0, numOut: pl.numOutputs ?? 2, outputBuses: pl.outputBuses }; }
  _connect(node) { node.connect(this.out, 0); this._wireAux(); }
  _disconnect() { for (const g of this.auxGains.values()) { try { g.disconnect(); } catch { /* */ } } this.auxGains.clear(); }

  /** Output buses beyond the main one: [{ key: 'bus<k>', name, channels }] (empty for single-output plugins). */
  get auxBuses() {
    const buses = this.info?.plugin?.outputBuses || [];
    return buses.map((b, k) => ({ key: `bus${k}`, name: b.name || `Out ${k + 1}`, channels: b.channels })).slice(1).filter((b) => b.channels > 0);
  }

  /** Drum-style multi-out: map { bus<k>: AudioNode } routes plugin output bus k into that node (unmapped aux buses are silent). */
  setPadOutputs(map) {
    this.padOuts = map && Object.keys(map).length ? map : null;
    this._wireAux();
  }

  _wireAux() {
    const layout = this.bridge?.layout;
    if (!layout) return;
    layout.busIds.forEach((busIndex, out) => {
      if (busIndex === 0) return;
      const key = `bus${busIndex}`;
      const dest = this.padOuts?.[key] || null;
      let g = this.auxGains.get(key);
      if (!dest) { if (g) { try { g.disconnect(); } catch { /* */ } } return; }
      if (!g) {
        g = this.ctx.createGain();
        g.gain.value = Math.max(0, Number(this.p.gain ?? 1));
        this.auxGains.set(key, g);
        this.bridge.node.connect(g, out);
      }
      try { g.disconnect(); } catch { /* */ }
      g.connect(dest);
    });
  }

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
   * notes: [{ time (s), pitch, vel (0..1), dur (s) }], frames: render length,
   * opts.params: parameter automation [[frame, paramId, value]] (sample-accurate, see native/automation.js),
   * opts.initial: { paramId: value } applied at frame 0 (the static values the automation starts from).
   * Aux output buses play into their multi-out channels (setPadOutputs) when mapped.
   */
  async prerender(notes, frames, opts = {}) {
    const ok = await this.ready;
    if (!ok || this.inst == null) return false;
    const sr = this.ctx.sampleRate;
    const events = [];
    for (const n of notes) {
      const k = this._pitch(n.pitch);
      const on = Math.max(0, Math.round(n.time * sr));
      events.push([on, 0x90, k, this._vel(n.vel)], [Math.max(on + 1, Math.round((n.time + Math.max(0.005, n.dur)) * sr)), 0x80, k, 0]);
    }
    const params = [];
    for (const [id, v] of Object.entries(opts.initial || {})) if (Number.isFinite(Number(v))) params.push([0, Number(id), Number(v)]);
    for (const e of opts.params || []) params.push(e);
    const r = await nativePluginsApi().render({ inst: this.inst, frames, events, params });
    const buses = r.buses?.length ? r.buses : [{ channels: r.numOut }];
    let ch0 = 0;
    buses.forEach((b, k) => {
      const nch = Math.max(0, b.channels | 0);
      const first = ch0;
      ch0 += nch;
      const dest = k === 0 ? this.out : this.padOuts?.[`bus${k}`];
      if (!nch || !dest || first >= r.numOut) return;
      const buf = this.ctx.createBuffer(2, frames, sr);
      for (let c = 0; c < 2; c++) {
        const src = first + Math.min(c, nch - 1);
        if (src < r.numOut) buf.copyToChannel(r.output.subarray(src * frames, src * frames + frames), c);
      }
      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      if (k === 0) node.connect(dest);
      else {
        const g = this.ctx.createGain();
        g.gain.value = Math.max(0, Number(this.p.gain ?? 1));
        node.connect(g);
        g.connect(dest);
      }
      node.start(0);
    });
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
  /** opts.keyInput: the node the mixer feeds the sidechain key into (params.sourceTrackId). */
  constructor(ctx, input, output, opts = {}) {
    super(ctx);
    this.input = input;
    this.output = output;
    this.keyInput = opts.keyInput || null;
    this.thru = true;
    input.connect(output); // audio passes through until the plugin is ready (the effect shell does dry / wet)
  }

  /** Effects use the main output bus, and the aux input bus as the sidechain when the plugin has one. */
  _nodeShape(pl) { return { inst: this.inst, numIn: pl.numInputs ?? 2, numOut: pl.numOutputs ?? 2, numSc: this.keyInput ? pl.sidechain || 0 : 0 }; }

  _connect(node) {
    this.input.connect(node, 0, 0);
    if (this.keyInput && this.bridge?.layout?.numSc) this.keyInput.connect(node, 0, 1);
    node.connect(this.output, 0);
    if (this.thru) { try { this.input.disconnect(this.output); } catch { /* */ } this.thru = false; }
  }

  _disconnect() {
    if (this.bridge) {
      try { this.input.disconnect(this.bridge.node); } catch { /* */ }
      if (this.keyInput) { try { this.keyInput.disconnect(this.bridge.node); } catch { /* */ } }
    }
    if (!this.thru) { try { this.input.connect(this.output); } catch { /* */ } this.thru = true; }
  }

  async _build() {
    if (this.offline) { this.error = 'Native effects render through the realtime bounce, not offline.'; return false; }
    return super._build();
  }
}

export { NativeEngine as Engine, NativeEffect as Effect };
