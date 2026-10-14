// Web MIDI device manager: access, hot-plug, per-device enable + settings, output sending.
// Works with any object shaped like MIDIAccess (tests pass a fake one), so it is Node-testable.
import { Emitter } from '../core/util.js';

export const DEFAULT_INPUT_SETTINGS = {
  enabled: true,
  notes: true, // route notes to tracks
  control: true, // feed MIDI learn mappings / control surfaces
  channels: 'all', // 'all' | [0..15]
  target: 'auto', // 'auto' (armed tracks, else selected) | 'selected' | 'armed' | <trackId>
  curve: 'linear',
  fixedVelocity: 100,
  transpose: 0,
  mpe: false, // MPE: each note on its own channel (lower zone: ch 2-16 notes, ch 1 master)
};
export const DEFAULT_OUTPUT_SETTINGS = { enabled: true };

const STORE_KEY = 'daw3-midi-devices';
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
function defaultStorage() {
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* blocked */ }
  return memoryStorage();
}

export class MidiDeviceManager extends Emitter {
  /** opts.requestAccess(options) -> Promise<MIDIAccess>; opts.storage (localStorage-like). */
  constructor(opts = {}) {
    super();
    this.requestAccess = opts.requestAccess || ((o) => navigator.requestMIDIAccess(o));
    this.storage = opts.storage || defaultStorage();
    this.access = null;
    this.sysex = false;
    this.error = null;
    this.settings = { inputs: {}, outputs: {} };
    try { Object.assign(this.settings, JSON.parse(this.storage.getItem(STORE_KEY) || '{}')); } catch { /* corrupt */ }
    this._bound = new Map(); // input id -> port
  }

  get supported() { return typeof this.requestAccess === 'function'; }
  get ready() { return !!this.access; }

  async open() {
    if (this.access) return this.access;
    try {
      try { this.access = await this.requestAccess({ sysex: true }); this.sysex = true; }
      catch { this.access = await this.requestAccess({ sysex: false }); this.sysex = false; }
    } catch (e) { this.error = e?.message || String(e); throw e; }
    this.access.onstatechange = (e) => { this._bind(); this.emit('devices', e?.port || null); };
    this._bind();
    this.emit('devices', null);
    return this.access;
  }

  _save() { try { this.storage.setItem(STORE_KEY, JSON.stringify(this.settings)); } catch { /* quota */ } }

  _bind() {
    if (!this.access) return;
    const seen = new Set();
    for (const input of this.access.inputs.values()) {
      seen.add(input.id);
      const on = input.state !== 'disconnected' && this.inputSettings(input.name).enabled;
      if (on && this._bound.get(input.id) !== input) {
        input.onmidimessage = (m) => this.emit('message', input.name, m.data, m.timeStamp ?? now(), input);
        this._bound.set(input.id, input);
        try { input.open?.(); } catch { /* optional */ }
      } else if (!on && this._bound.has(input.id)) {
        input.onmidimessage = null;
        this._bound.delete(input.id);
      }
    }
    for (const id of [...this._bound.keys()]) if (!seen.has(id)) this._bound.delete(id);
  }

  inputs() {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((p) => ({ id: p.id, name: p.name, manufacturer: p.manufacturer || '', state: p.state || 'connected', settings: this.inputSettings(p.name) }));
  }
  outputs() {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((p) => ({ id: p.id, name: p.name, manufacturer: p.manufacturer || '', state: p.state || 'connected', settings: this.outputSettings(p.name) }));
  }
  inputSettings(name) { return { ...DEFAULT_INPUT_SETTINGS, ...(this.settings.inputs?.[name] || {}) }; }
  outputSettings(name) { return { ...DEFAULT_OUTPUT_SETTINGS, ...(this.settings.outputs?.[name] || {}) }; }
  setInputSettings(name, patch) {
    this.settings.inputs = { ...this.settings.inputs, [name]: { ...(this.settings.inputs?.[name] || {}), ...patch } };
    this._save();
    this._bind();
    this.emit('settings', { kind: 'input', name });
  }
  setOutputSettings(name, patch) {
    this.settings.outputs = { ...this.settings.outputs, [name]: { ...(this.settings.outputs?.[name] || {}), ...patch } };
    this._save();
    this.emit('settings', { kind: 'output', name });
  }

  output(name) {
    if (!this.access || !name) return null;
    for (const p of this.access.outputs.values()) if (p.name === name && p.state !== 'disconnected') return p;
    return null;
  }
  /** Send bytes (or a list of messages) to an output by name. timestamp: performance.now() domain. */
  send(name, bytes, timestamp) {
    const out = this.output(name);
    if (!out || !this.outputSettings(name).enabled) return false;
    const msgs = Array.isArray(bytes?.[0]) || bytes?.[0] instanceof Uint8Array ? bytes : [bytes];
    for (const m of msgs) {
      if (!this.sysex && m[0] === 0xf0) continue; // SysEx needs permission
      try { out.send(m, timestamp); } catch (e) { this.emit('error', e); return false; }
    }
    return true;
  }
  /** Best output partner of an input (same name, or same name with "In"/"Out" swapped). */
  partnerOutput(inputName) {
    if (!inputName) return null;
    const outs = this.outputs().map((o) => o.name);
    const swap = inputName.replace(/\bIn(put)?\b/i, (m) => (m.length > 2 ? 'Output' : 'Out'));
    return outs.find((n) => n === inputName) || outs.find((n) => n === swap) || outs.find((n) => n.replace(/\s*(out(put)?)\s*/i, '') === inputName.replace(/\s*(in(put)?)\s*/i, '')) || null;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Does a channel-filter setting pass channel ch (0-15)? */
export const channelPasses = (channels, ch) => channels === 'all' || !Array.isArray(channels) || !channels.length || channels.includes(ch);
