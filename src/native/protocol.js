// Message schemas shared by the renderer, the Electron main process and the audio server
// (utility process). Control calls are `{ method, args }` requests answered with a value or an
// error; the audio stream uses small typed messages on a MessagePort. Pure, Node-testable.

export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];
export const BUFFER_SIZES = [32, 64, 128, 256, 512, 1024];
export const BUFFER_MIN = 32;
export const BUFFER_MAX = 1024;

export const DEFAULT_AUDIO_CONFIG = Object.freeze({
  enabled: false,        // route daW³'s output through the native engine
  outputId: '',          // '' = system default device
  inputId: '',
  inputEnabled: true,
  sampleRate: 48000,
  bufferFrames: 256,
  deviceOutChannels: 2,  // channels opened on the output device
  deviceInChannels: 2,
  outOffset: 0,          // first output channel daW³'s stereo master lands on (0 = outputs 1/2)
  safetyFrames: 0,       // extra bridge buffering (0 = auto)
  latencyMs: null,       // last measured round-trip latency (loopback calibration)
  latencySamples: null,
});

const int = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Coerce a (possibly partial / stale) config into a valid one. */
export function normalizeAudioConfig(cfg = {}) {
  const c = { ...DEFAULT_AUDIO_CONFIG, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const out = {
    enabled: !!c.enabled,
    outputId: typeof c.outputId === 'string' ? c.outputId.slice(0, 1024) : '',
    inputId: typeof c.inputId === 'string' ? c.inputId.slice(0, 1024) : '',
    inputEnabled: c.inputEnabled !== false,
    sampleRate: SAMPLE_RATES.includes(int(c.sampleRate, 0)) ? int(c.sampleRate, 48000) : 48000,
    bufferFrames: clamp(int(c.bufferFrames, 256), BUFFER_MIN, BUFFER_MAX),
    deviceOutChannels: clamp(int(c.deviceOutChannels, 2), 1, 64),
    deviceInChannels: clamp(int(c.deviceInChannels, 2), 1, 64),
    outOffset: 0,
    safetyFrames: clamp(int(c.safetyFrames, 0), 0, 8192),
    latencyMs: Number.isFinite(c.latencyMs) ? c.latencyMs : null,
    latencySamples: Number.isFinite(c.latencySamples) ? c.latencySamples : null,
  };
  out.outOffset = clamp(int(c.outOffset, 0), 0, Math.max(0, out.deviceOutChannels - 2));
  return out;
}

/** The native engine's open() options for a config (stream = daW³'s stereo master). */
export function engineOptions(cfg) {
  const c = normalizeAudioConfig(cfg);
  return {
    outputId: c.outputId, inputId: c.inputId, inputEnabled: c.inputEnabled, sampleRate: c.sampleRate,
    bufferFrames: c.bufferFrames, deviceOutChannels: Math.max(2, c.deviceOutChannels), deviceInChannels: c.deviceInChannels,
    streamChannels: 2, outOffset: c.outOffset,
    targetFrames: c.safetyFrames ? c.bufferFrames + c.safetyFrames : 0,
  };
}

/** Bridge latency estimate (frames) from renderer to device output for a config. */
export function bridgeLatencyFrames(cfg, quantum = 128) {
  const c = normalizeAudioConfig(cfg);
  const target = c.safetyFrames ? c.bufferFrames + c.safetyFrames : c.bufferFrames + Math.round(c.sampleRate / 100);
  return target + quantum * 2 + c.bufferFrames;
}

// ------------------------------------------------------------------------------------- control methods
const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const isBase64 = (s) => isStr(s) && s.length % 4 === 0 && B64.test(s);
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
/** Output channels of one plugin over all its buses (multi-out instruments), and the host's shared-memory width. */
export const MAX_OUT_CHANNELS = 32;
export const HOST_MAX_CHANNELS = 32;

/** method -> validator(args) returning an error string or null. */
export const METHODS = {
  'audio.available': () => null,
  'audio.listDevices': () => null,
  'audio.getConfig': () => null,
  'audio.setConfig': (a) => (isObj(a?.[0]) ? null : 'config object expected'),
  'audio.status': () => null,
  'audio.calibrate': (a) => (a?.[0] == null || isObj(a[0]) ? null : 'options object expected'),
  'plugins.scan': (a) => (a?.[0] == null || isObj(a[0]) ? null : 'options object expected'),
  'plugins.list': () => null,
  'plugins.load': (a) => {
    const o = a?.[0];
    if (!isObj(o)) return 'options object expected';
    if (!isStr(o.key) || !/^(clap|vst3|au):/.test(o.key)) return 'plugin key expected (clap:… / vst3:… / au:…)';
    if (o.state != null && o.state !== '' && !isBase64(o.state)) return 'state must be base64';
    if (o.sampleRate != null && !SAMPLE_RATES.includes(o.sampleRate)) return 'unsupported sample rate';
    return null;
  },
  'plugins.unload': (a) => (isInt(a?.[0]) ? null : 'instance id expected'),
  'plugins.info': (a) => (isInt(a?.[0]) ? null : 'instance id expected'),
  'plugins.setParam': (a) => (isInt(a?.[0]) && isInt(a?.[1]) && a[1] >= 0 && isNum(a?.[2]) ? null : '(inst, paramId, value) expected'),
  'plugins.getState': (a) => (isInt(a?.[0]) ? null : 'instance id expected'),
  'plugins.setState': (a) => (isInt(a?.[0]) && isBase64(a?.[1]) && a[1].length <= MAX_STATE_BYTES * 4 / 3 + 4 ? null : '(inst, base64 state) expected'),
  'plugins.openEditor': (a) => (isInt(a?.[0]) ? null : 'instance id expected'),
  'plugins.closeEditor': (a) => (isInt(a?.[0]) ? null : 'instance id expected'),
  'plugins.setOffline': (a) => (isInt(a?.[0]) && typeof a?.[1] === 'boolean' ? null : '(inst, boolean) expected'),
  'plugins.presets': (a) => (isInt(a?.[0]) ? null : 'instance id expected'),
  'plugins.loadPreset': (a) => (isInt(a?.[0]) && isStr(a?.[1]) && a[1].length > 0 && a[1].length < 4096 ? null : '(inst, preset id) expected'),
  'plugins.savePreset': (a) => (isInt(a?.[0]) && isStr(a?.[1]) && PRESET_NAME.test(a[1]) ? null : '(inst, preset name) expected (letters, digits, spaces, - _ . ( ), no path)'),
  'plugins.render': (a) => {
    const o = a?.[0];
    if (!isObj(o) || !isInt(o.inst) || !isInt(o.frames) || o.frames < 0 || o.frames > 48000 * 60 * 60) return '{inst, frames, events} expected';
    if (o.events != null && !Array.isArray(o.events)) return 'events must be an array';
    if (o.params != null && !Array.isArray(o.params)) return 'params must be an array of [frame, paramId, value]';
    if (o.input != null && (!(o.input instanceof Float32Array) || o.input.length < o.frames || o.input.length > o.frames * 8)) return 'input must be a planar Float32Array (channels × frames)';
    return null;
  },
  'plugins.retry': (a) => (isBundleRef(a?.[0]) ? null : '{format, path} expected'),
  'plugins.scanLog': (a) => (isBundleRef(a?.[0]) ? null : '{format, path} expected'),
  'plugins.getPrefs': () => null,
  'plugins.setPrefs': (a) => (isObj(a?.[0]) && JSON.stringify(a[0]).length < 2_000_000 ? null : 'preferences object expected'),
};

/** { format, path } of a plugin bundle (AU: the registry, path 'all'). */
const isBundleRef = (o) => isObj(o) && ['vst3', 'clap', 'au'].includes(o.format) && isStr(o.path) && o.path.length > 0 && o.path.length < 4096;

/** A preset name the server may turn into a file name (no separators, no dot files). */
export const PRESET_NAME = /^(?!\.)[\p{L}\p{N} _\-.()'&+,#]{1,96}$/u;

/** Throws on an unknown method or bad arguments. */
export function validateCall(method, args = []) {
  const v = METHODS[method];
  if (!v) throw new Error(`Unknown native method: ${method}`);
  const err = v(args);
  if (err) throw new Error(`${method}: ${err}`);
  return true;
}

// ------------------------------------------------------------------------------------- stream messages
// worker -> server: { t:'out', data:Float32Array(stereo interleaved) }
//                   { t:'proc', inst, block, numIn, numOut, input:Float32Array(planar), midi:Float64Array, params?:Float64Array,
//                     numSc?, sidechain?:Float32Array(planar numSc*128) }   numOut = every output bus' channels, bus after bus
// server -> worker: { t:'in', data:Float32Array(interleaved), channels }
//                   { t:'procd', inst, block, output:Float32Array(planar)|null, status, outParams:Float64Array }
export function validateStreamMessage(m) {
  if (!isObj(m) || !isStr(m.t)) return false;
  const f32 = (x) => x instanceof Float32Array;
  const f64 = (x) => x instanceof Float64Array;
  switch (m.t) {
    case 'out': return f32(m.data) && m.data.length % 2 === 0;
    case 'in': return f32(m.data) && isInt(m.channels) && m.channels > 0 && m.data.length % m.channels === 0;
    case 'proc': return isInt(m.inst) && isNum(m.block) && isInt(m.numIn) && isInt(m.numOut) && m.numIn >= 0 && m.numIn <= 16
      && m.numOut >= 1 && m.numOut <= MAX_OUT_CHANNELS && f32(m.input) && m.input.length === m.numIn * 128 && f64(m.midi) && m.midi.length % 4 === 0
      && (m.params == null || (f64(m.params) && m.params.length % 3 === 0))
      && (m.numSc == null || m.numSc === 0 || (isInt(m.numSc) && m.numSc > 0 && m.numSc <= 8 && f32(m.sidechain) && m.sidechain.length === m.numSc * 128));
    case 'procd': return isInt(m.inst) && isNum(m.block) && (m.output === null || f32(m.output)) && isInt(m.status);
    case 'hello': return isInt(m.sampleRate);
    default: return false;
  }
}
