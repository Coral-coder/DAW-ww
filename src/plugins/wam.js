// Web Audio Modules 2.0 host (experimental). Loads a WAM plugin (ES module whose default export is
// the WebAudioModule class) from a URL, sends notes as 'wam-midi' events, exposes the plugin's own
// GUI and saves / restores its state. Browser-only.
import { setStatus, friendlyError, userError } from './status.js';

export const WAM_SDK_VERSION = '0.0.12';
export const WAM_SDK_URL = `https://cdn.jsdelivr.net/npm/@webaudiomodules/sdk@${WAM_SDK_VERSION}/dist/index.js`;

const hosts = new WeakMap(); // BaseAudioContext -> Promise<groupId>
const modules = new Map(); // url -> Promise<WAM class>
let sdkPromise = null;

function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import(/* webpackIgnore: true */ WAM_SDK_URL);
    sdkPromise.catch(() => { sdkPromise = null; });
  }
  return sdkPromise;
}

/** initializeWamHost once per AudioContext -> groupId */
export function wamHost(ctx) {
  if (!hosts.has(ctx)) {
    const p = (async () => {
      const sdk = await loadSdk();
      const init = sdk.initializeWamHost || sdk.default?.initializeWamHost;
      if (typeof init !== 'function') throw userError('The WAM SDK did not load correctly.');
      const [groupId] = await init(ctx);
      return groupId;
    })();
    hosts.set(ctx, p);
    p.catch(() => hosts.delete(ctx));
  }
  return hosts.get(ctx);
}

export function loadWamModule(url) {
  if (!modules.has(url)) {
    const p = import(/* webpackIgnore: true */ url).then((m) => {
      const WAM = m.default;
      if (typeof WAM !== 'function' || typeof WAM.createInstance !== 'function') {
        throw userError('That module does not export a Web Audio Module (default export with createInstance()).');
      }
      return WAM;
    });
    modules.set(url, p);
    p.catch(() => modules.delete(url));
  }
  return modules.get(url);
}

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(userError(`${what} timed out after ${Math.round(ms / 1000)} s.`)), ms)),
]);

class WamBase {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.instance = null;
    this.node = null;
    this.error = null;
    this.url = null;
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.ready = Promise.resolve(false);
  }

  get key() { return 'wam:' + this.url; }

  setParams(p) {
    const prevState = this.p?.state;
    this.p = p || {};
    this._applyGain?.();
    if (this.p.url !== this.url) {
      this.url = this.p.url;
      this.ready = this._build(this.url);
    } else if (this.instance && this.p.state && prevState !== this.p.state && this.p.state !== this._lastState) {
      // state changed externally (undo / project load) -> push it into the plugin
      this.instance.audioNode?.setState?.(this.p.state).catch?.(() => {});
    }
  }

  reload() { const u = this.url; this.url = null; modules.delete(u); this.setParams(this.p); return this.ready; }

  async _build(url) {
    this.error = null;
    this._teardown();
    if (!url) { this.error = 'No plugin URL.'; return false; }
    const key = 'wam:' + url;
    if (!this.offline) setStatus(key, { state: 'loading', progress: null, message: 'Loading the WAM host…' });
    try {
      const groupId = await withTimeout(wamHost(this.ctx), 20000, 'Starting the WAM host');
      if (!this.offline) setStatus(key, { state: 'loading', progress: null, message: 'Loading the plugin…' });
      const WAM = await withTimeout(loadWamModule(url), 30000, 'Loading the plugin');
      const instance = await withTimeout(WAM.createInstance(groupId, this.ctx, this.p.state || undefined), 30000, 'Creating the plugin');
      if (url !== this.url) { try { instance.audioNode?.destroy?.(); } catch { /* */ } return false; }
      this.instance = instance;
      this.node = instance.audioNode;
      if (this.p.state) { try { await this.node.setState?.(this.p.state); } catch { /* not all plugins support it */ } }
      this._connect();
      const d = instance.descriptor || {};
      if (!this.offline) {
        setStatus(key, { state: 'ready', progress: 1, message: d.name || 'Loaded', info: { name: d.name, vendor: d.vendor, isInstrument: d.isInstrument, hasGui: true } });
      }
      return true;
    } catch (e) {
      const message = friendlyError(e, { url, kind: 'wam' });
      this.error = this.offline ? `${message} (WAM plugins may only run live, not in offline renders)` : message;
      if (!this.offline) setStatus(key, { state: 'error', error: message, message });
      return false;
    }
  }

  _teardown() {
    const node = this.node;
    this.node = null;
    this.instance = null;
    if (node) { try { node.disconnect(); } catch { /* */ } try { node.destroy?.(); } catch { /* */ } }
  }

  /** Plugin GUI element (caller mounts it); null when the plugin has none. */
  async createGui() {
    await this.ready;
    if (!this.instance?.createGui) return null;
    return this.instance.createGui();
  }

  destroyGui(el) { try { this.instance?.destroyGui?.(el); } catch { /* */ } }

  async getState() {
    if (!this.node?.getState) return null;
    const s = await this.node.getState();
    this._lastState = s;
    return s;
  }

  dispose() { this.url = '#disposed'; this._teardown(); }
}

// ----------------------------------------------------------------------------- instrument
export class WamEngine extends WamBase {
  constructor(ctx, output, params, opts) {
    super(ctx, opts);
    this.out = ctx.createGain();
    this.out.connect(output);
    this.voices = [];
    this.held = new Set();
    this.setParams(params);
  }

  _applyGain() { try { this.out.gain.setTargetAtTime(Math.max(0, Number(this.p.gain ?? 0.8)), this.ctx.currentTime, 0.01); } catch { /* */ } }
  _connect() { this.node.connect(this.out); }

  _midi(bytes, time) {
    if (!this.node?.scheduleEvents) return;
    try { this.node.scheduleEvents({ type: 'wam-midi', time: Math.max(time ?? this.ctx.currentTime, this.ctx.currentTime), data: { bytes } }); } catch { /* */ }
  }

  _pitch(p) { return Math.max(0, Math.min(127, Math.round(p + Number(this.p.transpose || 0)))); }

  trigger(time, pitch, vel, durSec) {
    const k = this._pitch(pitch);
    this._midi([0x90, k, Math.max(1, Math.round((vel ?? 0.8) * 127))], time);
    this._midi([0x80, k, 0], time + Math.max(0.005, durSec));
  }

  noteOn(pitch, vel, time) { const k = this._pitch(pitch); this.held.add(k); this._midi([0x90, k, Math.max(1, Math.round((vel ?? 0.8) * 127))], time); }
  noteOff(pitch, time) { const k = this._pitch(pitch); this.held.delete(k); this._midi([0x80, k, 0], time); }

  allNotesOff(time) {
    for (const k of this.held) this._midi([0x80, k, 0], time);
    this.held.clear();
    this._midi([0xb0, 123, 0], time);
    try { this.node?.clearEvents?.(); } catch { /* */ }
  }

  dispose() {
    super.dispose();
    const out = this.out;
    setTimeout(() => { try { out.disconnect(); } catch { /* */ } }, 300);
  }
}

// ----------------------------------------------------------------------------- effect
export class WamEffect extends WamBase {
  constructor(ctx, input, output) {
    super(ctx);
    this.input = input;
    this.output = output;
    this.thru = true;
    input.connect(output);
  }

  _connect() {
    this.input.connect(this.node);
    this.node.connect(this.output);
    if (this.thru) { try { this.input.disconnect(this.output); } catch { /* */ } this.thru = false; }
  }

  _teardown() {
    if (this.node) { try { this.input.disconnect(this.node); } catch { /* */ } }
    super._teardown();
    if (!this.thru) { try { this.input.connect(this.output); } catch { /* */ } this.thru = true; }
  }
}

export { WamEngine as Engine, WamEffect as Effect };
