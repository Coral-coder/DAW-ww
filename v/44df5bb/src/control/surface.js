// Control-surface controller (Node-safe): drives an MCU / HUI protocol against an abstract DAW host.
// Banks of 8 strips (faders, V-pots, mute / solo / rec / select with LEDs), transport, jog wheel, bank /
// channel shift, scribble strips, time display and meters. Only changed feedback is re-sent.
//
// host (see src/control/index.js for the real one, tests use a fake):
//   strips() -> [{ id, name, volume (0..1.5 gain), pan (-1..1), mute, solo, arm, selected }]  (tracks, then buses)
//   master() -> { volume }
//   setVolume(id, gain), setPan(id, pan), toggle(id, 'mute'|'solo'|'arm'), select(id)
//   touch(id, target, on)                          fader touch -> automation TOUCH mode
//   sends(id) -> [{ busId, name, value 0..1 }], setSend(id, busId, value)
//   params(id) -> [{ label, norm, set(norm) }]       instrument / device parameters (V-pot "plugin" mode)
//   transport() -> { playing, recording, loop, click, autoArm }
//   command(name)  'play'|'stop'|'record'|'rewind'|'forward'|'loop'|'click'|'undo'|'save'|'autoArm'|'marker'
//   jog(delta), position() -> { bar, beat, sixteenth, tick }, meter(id) -> 0..1
import { createProtocol } from './surface-protocol.js';

export const VPOT_MODES = ['pan', 'send', 'plugin'];
const MAX_GAIN = 1.5;
/** Fader travel 0..1 <-> track gain 0..1.5 with a squared taper (unity 0.8 sits at ~73% like a console). */
export const faderToGain = (x) => +(MAX_GAIN * Math.max(0, Math.min(1, x)) ** 2).toFixed(4);
export const gainToFader = (g) => Math.sqrt(Math.max(0, Math.min(MAX_GAIN, g)) / MAX_GAIN);
const short = (s, n = 6) => {
  s = String(s || '').replace(/[^\x20-\x7e]/g, '').trim();
  if (s.length <= n) return s;
  const noVowels = s[0] + s.slice(1).replace(/[aeiou]/gi, '');
  if (noVowels.length <= n) return noVowels;
  return noVowels.replace(/\s+/g, '').slice(0, n);
};

export class SurfaceController {
  /** opts: { kind: 'mcu'|'mcu-xt'|'hui', send(bytesList), host, unitOffset (strips before this unit, XT = 8) } */
  constructor({ kind = 'mcu', send, host, unitOffset = 0 } = {}) {
    this.kind = kind;
    this.proto = createProtocol(kind);
    this.send = send || (() => {});
    this.host = host;
    this.unitOffset = unitOffset;
    this.bank = 0; // first strip index
    this.mode = 'pan';
    this.sendIndex = 0;
    this.paramPage = 0;
    this.touched = new Set(); // strip indexes held by the hand
    this.shift = false;
    this.cache = new Map(); // feedback key -> serialized bytes
  }

  /** The 8 strips of the current bank (null where there is no track). */
  bankStrips() {
    const all = this.host.strips();
    const out = [];
    for (let i = 0; i < 8; i++) out.push(all[this.bank + this.unitOffset + i] || null);
    return out;
  }

  // ------------------------------------------------------------------ input
  handle(data) {
    for (const ev of this.proto.decode(data)) this._event(ev);
  }

  _event(ev) {
    const strips = this.bankStrips();
    const s = ev.strip != null && ev.strip < 8 ? strips[ev.strip] : null;
    switch (ev.type) {
      case 'fader':
        if (ev.strip === 8) { this.host.setVolume('master', faderToGain(ev.value)); return; }
        if (s) this.host.setVolume(s.id, faderToGain(ev.value));
        return;
      case 'touch': {
        const id = ev.strip === 8 ? 'master' : s?.id;
        if (ev.on) this.touched.add(ev.strip); else this.touched.delete(ev.strip);
        if (id) this.host.touch?.(id, 'volume', ev.on);
        if (!ev.on) this._invalidate(`fader:${ev.strip}`); // motor goes back to the value
        return;
      }
      case 'vpot': return this._vpot(ev.strip, ev.delta, s);
      case 'jog': this.host.jog?.(ev.delta); return;
      case 'button': return this._button(ev, s);
      default: return;
    }
  }

  _vpot(strip, delta, s) {
    if (this.mode === 'plugin') {
      const sel = this.host.strips().find((x) => x.selected);
      const p = sel && this.host.params?.(sel.id)?.[this.paramPage * 8 + strip];
      if (p) p.set(Math.max(0, Math.min(1, p.norm + delta / 100)));
      return;
    }
    if (!s) return;
    if (this.mode === 'send') {
      const snd = this.host.sends?.(s.id)?.[this.sendIndex];
      if (snd) this.host.setSend(s.id, snd.busId, Math.max(0, Math.min(1, +(snd.value + delta / 100).toFixed(3))));
      return;
    }
    this.host.setPan(s.id, Math.max(-1, Math.min(1, +((s.pan || 0) + delta / 50).toFixed(3))));
  }

  _button(ev, s) {
    if (ev.name === 'shift') { this.shift = ev.on; return; }
    if (!ev.on) return;
    const total = this.host.strips().length;
    const maxBank = Math.max(0, total - 8 - this.unitOffset);
    switch (ev.name) {
      case 'mute': case 'solo': if (s) this.host.toggle(s.id, ev.name); return;
      case 'rec': if (s) this.host.toggle(s.id, 'arm'); return;
      case 'select': if (s) this.host.select(s.id); return;
      case 'vpotPush':
        if (s && this.mode === 'pan') this.host.setPan(s.id, 0);
        return;
      case 'bankLeft': this.bank = Math.max(0, this.bank - 8); return this._bankChanged();
      case 'bankRight': this.bank = Math.min(maxBank, this.bank + 8); return this._bankChanged();
      case 'channelLeft':
        if (this.mode === 'plugin') { this.paramPage = Math.max(0, this.paramPage - 1); return this._bankChanged(); }
        this.bank = Math.max(0, this.bank - 1); return this._bankChanged();
      case 'channelRight':
        if (this.mode === 'plugin') { this.paramPage++; return this._bankChanged(); }
        this.bank = Math.min(maxBank, this.bank + 1); return this._bankChanged();
      case 'assignPan': this.mode = 'pan'; return this._bankChanged();
      case 'assignSend': {
        const n = Math.max(1, this.host.sends?.(this.host.strips()[0]?.id)?.length || 1);
        this.sendIndex = this.mode === 'send' ? (this.sendIndex + 1) % n : 0;
        this.mode = 'send';
        return this._bankChanged();
      }
      case 'assignPlugin': case 'assignInstrument': this.mode = 'plugin'; this.paramPage = 0; return this._bankChanged();
      case 'play': case 'stop': case 'record': case 'rewind': case 'forward': case 'undo': case 'save': case 'marker':
        this.host.command?.(ev.name); return;
      case 'cycle': this.host.command?.('loop'); return;
      case 'click': this.host.command?.('click'); return;
      case 'write': case 'latch': case 'touch': this.host.command?.('autoArm'); return;
      case 'left': this.host.jog?.(-4 * 4); return; // a bar back (in sixteenths)
      case 'right': this.host.jog?.(4 * 4); return;
      default: return;
    }
  }

  _bankChanged() { this.cache.clear(); this.refresh(); }
  _invalidate(key) { this.cache.delete(key); }

  // ------------------------------------------------------------------ feedback
  _out(key, msgs) {
    const ser = JSON.stringify(msgs);
    if (this.cache.get(key) === ser) return;
    this.cache.set(key, ser);
    if (msgs.length) this.send(msgs);
  }

  /** Push every changed LED / fader / ring / LCD cell / time digit to the surface. */
  refresh() {
    const p = this.proto;
    const strips = this.bankStrips();
    const sel = this.host.strips().find((x) => x.selected);
    const params = this.mode === 'plugin' && sel ? this.host.params?.(sel.id) || [] : [];
    strips.forEach((s, i) => {
      if (!this.touched.has(i)) this._out(`fader:${i}`, p.fader(i, s ? gainToFader(s.volume ?? 0.8) : 0));
      this._out(`led:mute:${i}`, p.led('mute', i, s?.mute ? 1 : 0));
      this._out(`led:solo:${i}`, p.led('solo', i, s?.solo ? 1 : 0));
      this._out(`led:rec:${i}`, p.led('rec', i, s?.arm ? 1 : 0));
      this._out(`led:select:${i}`, p.led('select', i, s?.selected ? 1 : 0));
      let ring = 0, ringMode = 0, label = '', value = '';
      if (this.mode === 'plugin') {
        const prm = params[this.paramPage * 8 + i];
        if (prm) { ring = prm.norm; ringMode = 2; label = short(prm.label); value = String(Math.round(prm.norm * 100)); }
      } else if (s && this.mode === 'send') {
        const snd = this.host.sends?.(s.id)?.[this.sendIndex];
        ring = snd?.value || 0; ringMode = 2; label = short(s.name); value = snd ? `${short(snd.name, 3)}${Math.round(ring * 100)}` : '';
      } else if (s) {
        const pan = s.pan || 0;
        ring = (pan + 1) / 2; ringMode = 1; label = short(s.name);
        value = Math.abs(pan) < 0.01 ? '<C>' : `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
      }
      this._out(`ring:${i}`, s || params.length ? p.ring(i, ring, ringMode, this.mode === 'pan' && s && Math.abs(s.pan || 0) < 0.01) : p.ring(i, 0, 0));
      this._out(`lcd:0:${i}`, p.scribble(i, 0, label));
      this._out(`lcd:1:${i}`, p.scribble(i, 1, value));
    });
    if (this.unitOffset === 0) {
      if (!this.touched.has(8)) this._out('fader:8', this.kind === 'hui' ? [] : p.fader(8, gainToFader(this.host.master?.().volume ?? 0.9)));
      const tr = this.host.transport?.() || {};
      this._out('led:play', p.led('play', null, tr.playing ? 1 : 0));
      this._out('led:stop', p.led('stop', null, tr.playing ? 0 : 1));
      this._out('led:record', p.led('record', null, tr.recording ? 1 : 0));
      this._out('led:cycle', p.led('cycle', null, tr.loop ? 1 : 0));
      this._out('led:click', p.led('click', null, tr.click ? 1 : 0));
      this._out('led:assignPan', p.led('assignPan', null, this.mode === 'pan' ? 1 : 0));
      this._out('led:assignSend', p.led('assignSend', null, this.mode === 'send' ? 1 : 0));
      this._out('led:assignPlugin', p.led('assignPlugin', null, this.mode === 'plugin' ? 1 : 0));
      this._out('assign', p.assignment(this.mode === 'pan' ? 'PN' : this.mode === 'send' ? `S${this.sendIndex + 1}` : `P${this.paramPage + 1}`));
      this._out('time', p.timecode(this.timeText()));
    }
  }

  /** "BBB.BB.SS.TTT" style text for the time display (bars . beats . sixteenths . ticks). */
  timeText() {
    const pos = this.host.position?.() || { bar: 1, beat: 1, sixteenth: 1, tick: 0 };
    return `${String(pos.bar).padStart(3, ' ')}.${String(pos.beat).padStart(2, ' ')}.${String(pos.sixteenth).padStart(2, ' ')}.${String(pos.tick).padStart(3, '0')}`;
  }

  /** Meter frame (call ~10×/s): levels are not cached, they decay on the surface by themselves. */
  meters() {
    const msgs = [];
    this.bankStrips().forEach((s, i) => { if (s) msgs.push(...this.proto.meter(i, this.host.meter?.(s.id) || 0)); });
    if (msgs.length) this.send(msgs);
  }

  /** Initial handshake + full redraw (on connect). */
  connect() {
    this.cache.clear();
    this.send(this.proto.hello());
    this.refresh();
  }
  /** Blank the surface (on disconnect / disable). */
  blank() {
    const msgs = [];
    for (let i = 0; i < 8; i++) msgs.push(...this.proto.fader(i, 0), ...this.proto.scribble(i, 0, ''), ...this.proto.scribble(i, 1, ''), ...this.proto.ring(i, 0, 0));
    this.send(msgs);
    this.cache.clear();
  }
}
