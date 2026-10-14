// Control-surface wire protocols (Node-safe): Mackie Control Universal (MCU, incl. XT extenders) and HUI.
// Each protocol turns raw MIDI from the surface into abstract events and abstract feedback into bytes:
//   in : { type:'fader', strip, value 0..1 } | { type:'touch', strip, on } | { type:'vpot', strip, delta }
//        | { type:'button', name, strip?, on } | { type:'jog', delta } | { type:'ping' }
//   out: fader(strip, 0..1) · led(name, strip|null, state 0 off | 1 on | 2 blink) · ring(strip, 0..1, mode)
//        · scribble(strip, row, text) · timecode(text) · assignment(text) · meter(strip, 0..1)
// strip 8 = master fader (MCU). Strips are 0-7 within a unit; extenders get their own protocol instance.
import { split14, to14 } from './midi.js';

// ------------------------------------------------------------------------------------------- MCU
// Button notes (velocity 127 press / 0 release in; LED out 0 off, 1 blink, 127 on)
export const MCU_STRIP_BUTTONS = { rec: 0x00, solo: 0x08, mute: 0x10, select: 0x18, vpotPush: 0x20 };
export const MCU_BUTTONS = {
  assignTrack: 0x28, assignSend: 0x29, assignPan: 0x2a, assignPlugin: 0x2b, assignEq: 0x2c, assignInstrument: 0x2d,
  bankLeft: 0x2e, bankRight: 0x2f, channelLeft: 0x30, channelRight: 0x31, flip: 0x32, globalView: 0x33,
  nameValue: 0x34, smpteBeats: 0x35, f1: 0x36, f2: 0x37, f3: 0x38, f4: 0x39, f5: 0x3a, f6: 0x3b, f7: 0x3c, f8: 0x3d,
  midiTracks: 0x3e, inputs: 0x3f, audioTracks: 0x40, audioInst: 0x41, aux: 0x42, busses: 0x43, outputs: 0x44, user: 0x45,
  shift: 0x46, option: 0x47, control: 0x48, alt: 0x49, readOff: 0x4a, write: 0x4b, trim: 0x4c, touch: 0x4d, latch: 0x4e,
  group: 0x4f, save: 0x50, undo: 0x51, cancel: 0x52, enter: 0x53, marker: 0x54, nudge: 0x55, cycle: 0x56, drop: 0x57,
  replace: 0x58, click: 0x59, soloGlobal: 0x5a, rewind: 0x5b, forward: 0x5c, stop: 0x5d, play: 0x5e, record: 0x5f,
  up: 0x60, down: 0x61, left: 0x62, right: 0x63, zoom: 0x64, scrub: 0x65, userA: 0x66, userB: 0x67,
};
const MCU_NOTE_TO_BUTTON = Object.fromEntries(Object.entries(MCU_BUTTONS).map(([k, v]) => [v, k]));
export const MCU_TOUCH = 0x68; // 0x68-0x6F strip faders, 0x70 master
export const MCU_VPOT_IN = 0x10; // CC 0x10-0x17
export const MCU_VPOT_RING = 0x30; // CC 0x30-0x37
export const MCU_JOG = 0x3c;
export const MCU_SYSEX_HEADER = [0xf0, 0x00, 0x00, 0x66]; // + device id (0x14 MCU, 0x15 XT) …
// 7-segment display characters (time code / assignment): ASCII 0x40-0x5F -> 0x00-0x1F, 0x20-0x3F as is
export function mcuSegChar(c) {
  let code = (c || ' ').toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return code - 0x40;
  if (code >= 0x20 && code <= 0x3f) return code;
  return 0x20;
}
const ascii7 = (s) => [...String(s)].map((c) => { const x = c.charCodeAt(0); return x >= 0x20 && x < 0x7f ? x : 0x3f; });

export class McuProtocol {
  constructor({ extender = false } = {}) {
    this.deviceId = extender ? 0x15 : 0x14;
    this.extender = extender;
  }
  get name() { return this.extender ? 'Mackie Control XT' : 'Mackie Control'; }
  decode(data) {
    const st = data[0] & 0xf0, ch = data[0] & 0x0f;
    if (st === 0xe0) return [{ type: 'fader', strip: ch, value: to14(data[1], data[2]) / 16383 }];
    if (st === 0x90 || st === 0x80) {
      const note = data[1], on = st === 0x90 && data[2] > 0;
      if (note >= MCU_TOUCH && note <= MCU_TOUCH + 8) return [{ type: 'touch', strip: note - MCU_TOUCH, on }];
      if (note < 0x28) {
        const group = Object.entries(MCU_STRIP_BUTTONS).find(([, base]) => note >= base && note < base + 8);
        if (group) return [{ type: 'button', name: group[0], strip: note - group[1], on }];
      }
      const name = MCU_NOTE_TO_BUTTON[note];
      return name ? [{ type: 'button', name, strip: null, on }] : [];
    }
    if (st === 0xb0) {
      const cc = data[1], v = data[2];
      const delta = v & 0x40 ? -(v & 0x3f) : v & 0x3f; // sign-magnitude
      if (cc >= MCU_VPOT_IN && cc < MCU_VPOT_IN + 8) return [{ type: 'vpot', strip: cc - MCU_VPOT_IN, delta }];
      if (cc === MCU_JOG) return [{ type: 'jog', delta }];
    }
    return [];
  }
  /** Fader motor: 14-bit pitch bend on the strip's channel (8 = master). */
  fader(strip, value) { const [l, m] = split14(value * 16383); return [[0xe0 | (strip & 0x0f), l, m]]; }
  led(name, strip, state) {
    const v = state === 2 ? 1 : state ? 127 : 0;
    const note = strip != null && name in MCU_STRIP_BUTTONS ? MCU_STRIP_BUTTONS[name] + strip : MCU_BUTTONS[name];
    return note == null ? [] : [[0x90, note, v]];
  }
  /** V-pot LED ring: mode 0 single dot, 1 boost/cut (from centre), 2 wrap (bar), 3 spread. */
  ring(strip, value, mode = 0, center = false) {
    const pos = Math.max(0, Math.min(11, Math.round(value * 10) + 1));
    return [[0xb0, MCU_VPOT_RING + strip, (center ? 0x40 : 0) | ((mode & 3) << 4) | pos]];
  }
  /** LCD: 2 rows × 56 chars, 7 per strip (the 7th is usually a space). */
  scribble(strip, row, text) {
    const s = String(text ?? '').slice(0, 7).padEnd(7, ' ');
    return [[...MCU_SYSEX_HEADER, this.deviceId, 0x12, row * 56 + strip * 7, ...ascii7(s), 0xf7]];
  }
  /** Whole LCD row (56 chars) in one message. */
  scribbleRow(row, text) {
    return [[...MCU_SYSEX_HEADER, this.deviceId, 0x12, row * 56, ...ascii7(String(text).slice(0, 56).padEnd(56, ' ')), 0xf7]];
  }
  /** 10-digit time code display (CC 0x40 = right-most digit). Dots: '.' after a digit lights its dp. */
  timecode(text) {
    const cells = [];
    for (const c of String(text)) {
      if (c === '.' && cells.length) cells[cells.length - 1].dot = true;
      else cells.push({ c, dot: false });
    }
    const digits = cells.slice(-10);
    while (digits.length < 10) digits.unshift({ c: ' ', dot: false });
    const out = [];
    for (let i = 0; i < 10; i++) {
      const d = digits[9 - i];
      out.push([0xb0, 0x40 + i, mcuSegChar(d.c) | (d.dot ? 0x40 : 0)]);
    }
    return out;
  }
  /** 2-character assignment display (CC 0x4B left, 0x4A right). */
  assignment(text) {
    const s = String(text).padEnd(2, ' ');
    return [[0xb0, 0x4b, mcuSegChar(s[0])], [0xb0, 0x4a, mcuSegChar(s[1])]];
  }
  /** Meter: channel pressure, (strip << 4) | level 0-12 (0x0E would set overload). */
  meter(strip, value) { return [[0xd0, ((strip & 7) << 4) | Math.max(0, Math.min(12, Math.round(value * 12)))]]; }
  /** Host -> device query (MCU device answers with its serial); harmless when unsupported. */
  hello() { return [[...MCU_SYSEX_HEADER, this.deviceId, 0x00, 0xf7]]; }
}

// ------------------------------------------------------------------------------------------- HUI
// Switches: CC 0x0F <zone>, then CC 0x2F <port | 0x40 press>. LEDs: CC 0x0C <zone>, CC 0x2C <port | 0x40 on>.
// Faders: CC 0x00+strip (MSB) / 0x20+strip (LSB), 14-bit (HUI uses the top 10 bits). V-pots: CC 0x40+strip.
// Ping: host sends 90 00 00 about once a second; the device answers 90 00 7F.
export const HUI_STRIP_PORTS = { touch: 0, select: 1, mute: 2, solo: 3, auto: 4, vsel: 5, insert: 6, rec: 7 };
const HUI_PORT_TO_STRIP = Object.fromEntries(Object.entries(HUI_STRIP_PORTS).map(([k, v]) => [v, k]));
// zone 0x0E: transport main; zone 0x0D: cursor / mode; zone 0x0A: window; zone 0x0B: bank + channel
export const HUI_BUTTONS = {
  talkback: [0x0e, 0], rewind: [0x0e, 1], forward: [0x0e, 2], stop: [0x0e, 3], play: [0x0e, 4], record: [0x0e, 5],
  channelLeft: [0x0b, 0], bankLeft: [0x0b, 1], channelRight: [0x0b, 2], bankRight: [0x0b, 3],
  down: [0x0d, 0], left: [0x0d, 1], right: [0x0d, 3], up: [0x0d, 4], scrub: [0x0d, 5], shuttle: [0x0d, 6],
  undo: [0x13, 1], save: [0x13, 2], cycle: [0x0f, 3], click: [0x10, 0],
  assignPan: [0x0c, 1], assignSend: [0x0c, 0], assignPlugin: [0x0c, 3],
};
const HUI_KEY = (z, p) => `${z}:${p}`;
const HUI_BUTTON_OF = Object.fromEntries(Object.entries(HUI_BUTTONS).map(([n, [z, p]]) => [HUI_KEY(z, p), n]));
const HUI_SYSEX = [0xf0, 0x00, 0x00, 0x66, 0x05, 0x00];

export class HuiProtocol {
  constructor() { this.zone = null; this.faderMsb = new Array(8).fill(0); }
  get name() { return 'HUI'; }
  decode(data) {
    const st = data[0] & 0xf0;
    if (st === 0x90 && data[1] === 0 && data[2] === 0x7f) return [{ type: 'ping' }];
    if (st !== 0xb0) return [];
    const cc = data[1], v = data[2];
    if (cc < 8) { this.faderMsb[cc] = v; return []; }
    if (cc >= 0x20 && cc < 0x28) { const s = cc - 0x20; return [{ type: 'fader', strip: s, value: to14(v, this.faderMsb[s]) / 16383 }]; }
    if (cc === 0x0f) { this.zone = v; return []; }
    if (cc === 0x2f && this.zone != null) {
      const port = v & 0x0f, on = !!(v & 0x40), z = this.zone;
      if (z < 8) {
        const name = HUI_PORT_TO_STRIP[port];
        if (name === 'touch') return [{ type: 'touch', strip: z, on }];
        return name ? [{ type: 'button', name, strip: z, on }] : [];
      }
      const name = HUI_BUTTON_OF[HUI_KEY(z, port)];
      return name ? [{ type: 'button', name, strip: null, on }] : [];
    }
    if (cc >= 0x40 && cc < 0x48) { const delta = v > 0x40 ? v - 0x40 : -v; return [{ type: 'vpot', strip: cc - 0x40, delta }]; }
    if (cc === 0x0d) { const delta = v > 0x40 ? v - 0x40 : -v; return [{ type: 'jog', delta }]; }
    return [];
  }
  fader(strip, value) { if (strip > 7) return []; const [l, m] = split14(value * 16383); return [[0xb0, strip, m], [0xb0, 0x20 + strip, l]]; }
  led(name, strip, state) {
    let z, p;
    if (strip != null && name in HUI_STRIP_PORTS) { z = strip; p = HUI_STRIP_PORTS[name]; }
    else if (HUI_BUTTONS[name]) [z, p] = HUI_BUTTONS[name];
    else return [];
    return [[0xb0, 0x0c, z], [0xb0, 0x2c, p | (state ? 0x40 : 0)]];
  }
  ring(strip, value, mode = 0) {
    const pos = Math.max(1, Math.min(11, Math.round(value * 10) + 1));
    return [[0xb0, 0x10 + strip, (mode === 1 ? 0x10 : mode === 2 ? 0x20 : 0) | pos]];
  }
  /** 4-character channel name display. */
  scribble(strip, row, text) {
    if (row !== 0) return [];
    return [[...HUI_SYSEX, 0x10, strip, ...ascii7(String(text ?? '').slice(0, 4).padEnd(4, ' ')), 0xf7]];
  }
  scribbleRow() { return []; }
  /** Time code: 8 digits, right-most first (BCD-like, 0-9 / 0x10+n with dot). */
  timecode(text) {
    const digits = String(text).replace(/[^0-9]/g, '').slice(-8).padStart(8, '0');
    return [[...HUI_SYSEX, 0x11, ...[...digits].reverse().map((d) => +d), 0xf7]];
  }
  assignment() { return []; }
  meter(strip, value) { const lvl = Math.max(0, Math.min(12, Math.round(value * 12))); return [[0xa0, strip, lvl], [0xa0, strip, 0x10 | lvl]]; }
  /** Host ping (send about once a second, or HUI surfaces go offline). */
  ping() { return [[0x90, 0x00, 0x00]]; }
  hello() { return this.ping(); }
}

export function createProtocol(kind) {
  if (kind === 'hui') return new HuiProtocol();
  if (kind === 'mcu-xt') return new McuProtocol({ extender: true });
  return new McuProtocol();
}
