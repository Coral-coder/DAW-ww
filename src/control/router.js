// MIDI note routing (Node-safe): input device settings -> target tracks, channel filters, velocity curves,
// transpose, sustain pedal, pitch bend, MPE per-note expression (bend / pressure / timbre) and MIDI thru.
//
// host:
//   targets(settings) -> [trackId]          tracks a device plays (auto = armed instrument tracks, else selected)
//   noteOn(trackId, pitch, vel01)
//   noteOff(trackId, pitch, expr)            expr = recorded note expression {bend, bendAt} | null
//   pitchBend(trackId, -1..1)
//   expression(trackId, pitch, {bend (semitones), pressure 0..1, timbre 0..1})   (MPE)
//   thru(bytes)                               MIDI thru (raw message, after filters)
import { parseMessage, applyVelocityCurve, bendNorm } from './midi.js';
import { channelPasses } from './devices.js';

export const MPE_BEND_RANGE = 48; // semitones (MPE default for member channels)

export class NoteRouter {
  constructor(host) {
    this.host = host;
    this.held = new Map(); // `${device}|${ch}|${note}` -> { tracks:[...], pitch, t0, bend, peak, peakT, sustained }
    this.sustain = new Map(); // `${device}|${ch}` -> bool (sustain is per channel)
    this.mpe = new Map(); // `${device}|${ch}` -> { bend, pressure, timbre } member-channel state
  }

  /** Feed one raw message of an input with its settings. Returns true when it was a performance message. */
  handle(device, data, settings, t = 0) {
    const m = parseMessage(data);
    if (!('ch' in m) || m.type === 'other') return false;
    if (!settings.notes) return false;
    if (!channelPasses(settings.channels, m.ch)) return false;
    const chKey = `${device}|${m.ch}`;
    const mpe = !!settings.mpe;
    switch (m.type) {
      case 'noteon': {
        const pitch = clampPitch(m.note + (settings.transpose || 0));
        if (pitch == null) return true;
        const vel = applyVelocityCurve(m.vel, settings.curve, { fixed: (settings.fixedVelocity ?? 100) / 127 });
        const key = `${chKey}|${m.note}`;
        if (this.held.has(key)) this._release(key);
        const tracks = this.host.targets?.(settings) || [];
        const st = mpe ? this.mpe.get(chKey) : null;
        this.held.set(key, { tracks, pitch, t0: t, bend: st?.bend || 0, peak: st?.bend || 0, peakT: t, sustained: false, ch: m.ch, device });
        for (const id of tracks) this.host.noteOn?.(id, pitch, vel);
        if (mpe && st && (st.bend || st.pressure || st.timbre != null)) for (const id of tracks) this.host.expression?.(id, pitch, { ...st });
        this.host.thru?.(data);
        return true;
      }
      case 'noteoff': {
        const key = `${chKey}|${m.note}`;
        const n = this.held.get(key);
        this.host.thru?.(data);
        if (!n) return true;
        if (this.sustain.get(chKey) || (mpe && this.sustain.get(`${device}|0`))) { n.sustained = true; n.tEnd = t; return true; }
        this._release(key, t);
        return true;
      }
      case 'cc': {
        if (m.cc === 64) {
          const on = m.value >= 64;
          this.sustain.set(chKey, on);
          if (!on) for (const [key, n] of [...this.held]) if (n.sustained && (key.startsWith(chKey + '|') || (mpe && m.ch === 0 && n.device === device))) this._release(key, t);
          this.host.thru?.(data);
          return true;
        }
        if (m.cc === 123 || m.cc === 120) { // all notes / sound off
          for (const [key, n] of [...this.held]) if (n.device === device) this._release(key, t);
          this.host.thru?.(data);
          return true;
        }
        if (mpe && m.cc === 74 && m.ch !== 0) { this._mpe(device, m.ch, { timbre: m.value / 127 }, t); this.host.thru?.(data); return true; }
        return false; // other CCs are for mappings / surfaces
      }
      case 'pb': {
        const v = bendNorm(m.value);
        if (mpe && m.ch !== 0) this._mpe(device, m.ch, { bend: v * (settings.bendRange || MPE_BEND_RANGE) }, t);
        else for (const id of this.host.targets?.(settings) || []) this.host.pitchBend?.(id, v);
        this.host.thru?.(data);
        return true;
      }
      case 'chanat': {
        if (mpe && m.ch !== 0) this._mpe(device, m.ch, { pressure: m.value / 127 }, t);
        this.host.thru?.(data);
        return true;
      }
      case 'polyat': {
        const n = this.held.get(`${chKey}|${m.note}`);
        if (n) for (const id of n.tracks) this.host.expression?.(id, n.pitch, { pressure: m.value / 127 });
        this.host.thru?.(data);
        return true;
      }
      default: return false;
    }
  }

  _mpe(device, ch, patch, t) {
    const chKey = `${device}|${ch}`;
    const st = { bend: 0, pressure: 0, timbre: null, ...(this.mpe.get(chKey) || {}), ...patch };
    this.mpe.set(chKey, st);
    for (const n of this.held.values()) {
      if (n.device !== device || n.ch !== ch) continue;
      if ('bend' in patch) { n.bend = st.bend; if (Math.abs(st.bend) > Math.abs(n.peak)) { n.peak = st.bend; n.peakT = t; } }
      for (const id of n.tracks) this.host.expression?.(id, n.pitch, { bend: st.bend, pressure: st.pressure, timbre: st.timbre });
    }
  }

  _release(key, t) {
    const n = this.held.get(key);
    if (!n) return;
    this.held.delete(key);
    const end = n.tEnd ?? t ?? n.t0;
    let expr = null;
    if (Math.abs(n.peak) >= 0.1) {
      const dur = Math.max(1, end - n.t0);
      expr = { bend: +n.peak.toFixed(2), bendAt: +Math.max(0, Math.min(0.95, (n.peakT - n.t0) / dur)).toFixed(3) };
    }
    for (const id of n.tracks) this.host.noteOff?.(id, n.pitch, expr);
  }

  /** Release everything (device unplugged, panic). */
  allOff(device = null) {
    for (const [key, n] of [...this.held]) if (!device || n.device === device) this._release(key);
  }
}

function clampPitch(p) { return p >= 0 && p <= 127 ? p : null; }
