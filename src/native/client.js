// Renderer side of the native audio engine (Mac app only; everything here is a no-op in the browser).
// daW³ keeps rendering in Web Audio; with native audio on, the master output is captured by an
// AudioWorklet into a SharedArrayBuffer ring, a pump worker forwards it to the audio server, which
// plays it on the chosen device (any device / channel pair / rate / buffer size). Device inputs come
// back the same way as input nodes / MediaStreams for recording, and native plugins run as worklet
// nodes whose audio is processed by the out-of-process plugin host.
import { createRingBuffer, packetSize, BLOCK } from './ring.js';

export const nativeAudioApi = () => (typeof window !== 'undefined' && window.daw3Native?.audio) || null;
export const nativePluginsApi = () => (typeof window !== 'undefined' && window.daw3Native?.plugins) || null;
const sabOk = () => typeof SharedArrayBuffer !== 'undefined';

const PLUGIN_LATENCY_BLOCKS = 3;

export class NativeAudioClient {
  constructor(api) {
    this.api = api;
    this.config = null;
    this.worker = null;
    this._connecting = null;
    this._modules = new WeakMap();
    this.outputs = new Map(); // ctx -> { tap, node }
    this.inputSab = null;
    this.inputChannels = 2;
    this.inputNodes = new Set();
    this.listeners = new Set();
    this.stats = null;
    api.onEvent?.((ev) => {
      if (ev?.event === 'audio-config') { this.config = ev.config; this._reroute(); }
      for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.warn('[native]', e); } }
    });
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async loadConfig() {
    try { this.config = await this.api.getConfig(); } catch { this.config = null; }
    return this.config;
  }

  get enabled() { return !!this.config?.enabled && sabOk(); }

  /** AudioContext options: the context runs at the device rate when native audio is on. */
  contextOptions() {
    return this.enabled ? { sampleRate: this.config.sampleRate } : {};
  }

  /** Open the audio-stream port and start the pump worker (once). */
  connect() {
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const t = setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('The audio server did not answer')); }, 10000);
      const onMsg = (e) => {
        if (e.data?.daw3 !== 'native-port' || !e.ports?.[0]) return;
        clearTimeout(t);
        window.removeEventListener('message', onMsg);
        const port = e.ports[0];
        this.worker = new Worker(new URL('./pump-worker.js', import.meta.url), { type: 'module', name: 'daW3 audio pump' });
        this.worker.onmessage = (ev) => this._onWorker(ev.data);
        this.worker.postMessage({ type: 'init', port }, [port]);
        if (this.inputSab) this.worker.postMessage({ type: 'in', sab: this.inputSab });
        resolve(this);
      };
      window.addEventListener('message', onMsg);
      this.api.connectStream();
    });
    this._connecting.catch(() => { this._connecting = null; });
    return this._connecting;
  }

  _onWorker(m) {
    if (m.type === 'stats') this.stats = m.stats;
    else if (m.type === 'in-channels' && m.channels !== this.inputChannels) {
      this.inputChannels = m.channels;
      this._makeInputRing();
    }
  }

  _makeInputRing() {
    if (!sabOk()) return null;
    this.inputSab = createRingBuffer(16384, this.inputChannels);
    this.worker?.postMessage({ type: 'in', sab: this.inputSab });
    for (const n of this.inputNodes) n.port.postMessage({ sab: this.inputSab });
    return this.inputSab;
  }

  ensureWorklet(ctx) {
    if (!this._modules.has(ctx)) this._modules.set(ctx, ctx.audioWorklet.addModule(new URL('./bridge-worklet.js', import.meta.url)));
    return this._modules.get(ctx);
  }

  /**
   * The node daW³'s master should connect to for this context. It plays through the default
   * output until native audio is switched on; then it feeds the native device.
   */
  async attachOutput(ctx) {
    const tap = ctx.createGain();
    const rec = { tap, node: null, ctx };
    this.outputs.set(ctx, rec);
    if (sabOk()) {
      try {
        await this.ensureWorklet(ctx);
        const sab = createRingBuffer(16384, 2);
        rec.node = new AudioWorkletNode(ctx, 'daw3-native-out', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { sab } });
        rec.sab = sab;
        rec.node.connect(ctx.destination); // emits silence; keeps the capture pulled
      } catch (e) { console.warn('[native] output bridge unavailable', e); }
    }
    await this._route(rec);
    return tap;
  }

  async _route(rec) {
    const native = this.enabled && rec.node;
    try { rec.tap.disconnect(); } catch { /* */ }
    if (native) {
      await this.connect();
      this.worker.postMessage({ type: 'out', sab: rec.sab });
      rec.tap.connect(rec.node);
      // don't also hold the system default device open
      try { await rec.ctx.setSinkId?.({ type: 'none' }); } catch { /* older engines */ }
    } else {
      rec.tap.connect(rec.ctx.destination);
      this.worker?.postMessage({ type: 'out', sab: null });
      try { if (rec.ctx.sinkId && typeof rec.ctx.sinkId === 'object') await rec.ctx.setSinkId(''); } catch { /* */ }
    }
  }

  _reroute() { for (const rec of this.outputs.values()) this._route(rec).catch((e) => console.warn('[native] reroute', e)); }

  /** Does a context's sample rate differ from the device's (engine.setSampleRate rebuilds the context)? */
  rateMismatch(ctx) { return this.enabled && ctx && ctx.sampleRate !== this.config.sampleRate; }

  /** Switch the device's sample rate (the server renegotiates the stream and re-activates loaded plugins). */
  async setDeviceRate(rate) {
    const r = await this.api.setConfig({ sampleRate: rate });
    this.config = r.config;
    if (r.error) throw new Error(r.error);
    return r;
  }

  /** The context the output tap of `ctx` belongs to is gone (rate switch): forget it. */
  detachOutput(ctx) {
    const rec = this.outputs.get(ctx);
    if (!rec) return;
    try { rec.tap.disconnect(); rec.node?.disconnect(); } catch { /* */ }
    this.outputs.delete(ctx);
  }

  /** Web Audio node carrying native device inputs `channels` (0-based device input channel indices). */
  async inputNode(ctx, { channels = [0, 1] } = {}) {
    if (!sabOk()) throw new Error('Native inputs need SharedArrayBuffer');
    await this.connect();
    await this.ensureWorklet(ctx);
    if (!this.inputSab) this._makeInputRing();
    const node = new AudioWorkletNode(ctx, 'daw3-native-in', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [Math.max(1, channels.length)],
      processorOptions: { sab: this.inputSab, channels, prefill: 2 * BLOCK + (this.config?.bufferFrames || 256) },
    });
    this.inputNodes.add(node);
    node.addEventListener?.('processorerror', () => this.inputNodes.delete(node));
    return node;
  }

  /** MediaStream of native device inputs (what getUserMedia would give, but from any interface channel). */
  async inputStream(ctx, opts = {}) {
    const node = await this.inputNode(ctx, opts);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = Math.max(1, (opts.channels || [0, 1]).length);
    node.connect(dest);
    return dest.stream;
  }

  /**
   * A worklet node that runs plugin instance `inst` (loaded in the plugin host).
   *   input 0 = the plugin's main input, input 1 = its sidechain key (numSc > 0);
   *   output k = output bus k (outputBuses [{name, channels}], multi-out instruments; output 0 = main).
   */
  async pluginNode(ctx, { inst, numIn, numOut, numSc = 0, outputBuses = null }) {
    await this.connect();
    await this.ensureWorklet(ctx);
    const layout = pluginNodeLayout({ numIn, numOut, numSc, outputBuses });
    const toSab = createRingBuffer(64, packetSize(layout.numIn + layout.numSc));
    const fromSab = createRingBuffer(8192, layout.totalOut);
    const node = new AudioWorkletNode(ctx, 'daw3-native-plugin', {
      numberOfInputs: layout.numSc ? 2 : 1, numberOfOutputs: layout.buses.length, outputChannelCount: layout.buses,
      channelCount: Math.max(1, layout.numIn), channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { toSab, fromSab, numIn: layout.numIn, numSc: layout.numSc, numOut: layout.totalOut, buses: layout.buses, latencyBlocks: PLUGIN_LATENCY_BLOCKS },
    });
    this.worker.postMessage({ type: 'plugin', inst, toSab, fromSab, numIn: layout.numIn, numSc: layout.numSc, numOut: layout.totalOut });
    return {
      node,
      layout,
      bridgeLatency: PLUGIN_LATENCY_BLOCKS * BLOCK,
      dispose: () => { this.worker?.postMessage({ type: 'unplug', inst }); try { node.disconnect(); } catch { /* */ } },
    };
  }
}

/**
 * Bridge node shape for a plugin: main input channels (≤ 2), sidechain channels (≤ 2) and one node output per
 * plugin output bus with the bus' own channel count (multi-out instruments; ≤ 8 channels a bus, 32 in all — the
 * host's limits). Buses without channels are left out; busIds[k] = the plugin bus index of node output k. Pure.
 */
export function pluginNodeLayout({ numIn = 0, numOut = 2, numSc = 0, outputBuses = null } = {}) {
  const cl = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? Math.round(+v) : d));
  const buses = [], busIds = [];
  const list = Array.isArray(outputBuses) && outputBuses.length ? outputBuses : [{ channels: numOut || 2 }];
  let total = 0;
  for (let i = 0; i < Math.min(16, list.length); i++) {
    const ch = cl(list[i]?.channels, 0, 8, 2);
    if (total + ch > 32) break; // the host fills channels bus after bus: stop at the first bus that no longer fits
    if (!ch) continue;
    buses.push(ch);
    busIds.push(i);
    total += ch;
  }
  if (!buses.length) { buses.push(2); busIds.push(0); total = 2; }
  return { numIn: cl(numIn, 0, 2, 0), numSc: cl(numSc, 0, 2, 0), buses, busIds, totalOut: total };
}

let client = null;
/** The shared client (null outside the Mac app). */
export function getNativeClient() {
  const api = nativeAudioApi();
  if (!api) return null;
  if (!client) {
    client = new NativeAudioClient(api);
    // public surface for other features (recording uses the native inputs)
    globalThis.daw3NativeAudio = {
      client,
      get config() { return client.config; },
      get inputChannels() { return client.inputChannels; },
      inputNode: (ctx, opts) => client.inputNode(ctx, opts),
      inputStream: (ctx, opts) => client.inputStream(ctx, opts),
      latency: () => ({ roundTripMs: client.config?.latencyMs ?? null, roundTripSamples: client.config?.latencySamples ?? null }),
    };
  }
  return client;
}

/** For AudioEngine.init(): null in the browser, else the client with its config loaded. */
export async function nativeAudioForEngine() {
  const c = getNativeClient();
  if (!c) return null;
  if (!c.config) await c.loadConfig();
  return c;
}
