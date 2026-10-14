// MIDI byte-level helpers (Node-safe, no DOM): message parsing, velocity curves, 14-bit values and a
// control decoder that turns raw CC / NRPN / note / pitch-bend streams into "control events" for MIDI learn.
//
// Control event: { device, ch (0-15), kind, num, value, max, t }
//   kind 'cc'    num 0-127, value 0-127            (plain 7-bit controller)
//   kind 'cc14'  num 0-31,  value 0-16383          (MSB = CC num, LSB = CC num+32, auto-detected)
//   kind 'nrpn'  num 0-16383, value 0-127|0-16383  (CC 99/98 select, CC 6 / 38 data entry, CC 96/97 inc/dec)
//   kind 'note'  num = pitch, value = velocity (0 = released)
//   kind 'pb'    num 0, value 0-16383              (pitch bend)
//   kind 'cp'    num 0, value 0-127                (channel pressure)

export const STATUS = { NOTE_OFF: 0x80, NOTE_ON: 0x90, POLY_AT: 0xa0, CC: 0xb0, PC: 0xc0, CHAN_AT: 0xd0, PB: 0xe0 };
export const RT = { CLOCK: 0xf8, START: 0xfa, CONTINUE: 0xfb, STOP: 0xfc, SENSE: 0xfe, RESET: 0xff, SPP: 0xf2, MTC: 0xf1, SYSEX: 0xf0, EOX: 0xf7 };

/** Parse one MIDI message (Uint8Array / array) -> {type, ch, ...}. */
export function parseMessage(data) {
  const st = data?.[0] ?? 0;
  if (st >= 0xf0) {
    switch (st) {
      case RT.CLOCK: return { type: 'clock' };
      case RT.START: return { type: 'start' };
      case RT.CONTINUE: return { type: 'continue' };
      case RT.STOP: return { type: 'stop' };
      case RT.SPP: return { type: 'spp', value: (data[1] & 0x7f) | ((data[2] & 0x7f) << 7) };
      case RT.MTC: return { type: 'mtc', value: data[1] & 0x7f };
      case RT.SYSEX: return { type: 'sysex', data };
      case RT.SENSE: return { type: 'sense' };
      default: return { type: 'other' };
    }
  }
  const cmd = st & 0xf0, ch = st & 0x0f;
  const d1 = (data[1] ?? 0) & 0x7f, d2 = (data[2] ?? 0) & 0x7f;
  switch (cmd) {
    case STATUS.NOTE_ON: return d2 > 0 ? { type: 'noteon', ch, note: d1, vel: d2 } : { type: 'noteoff', ch, note: d1, vel: 0 };
    case STATUS.NOTE_OFF: return { type: 'noteoff', ch, note: d1, vel: d2 };
    case STATUS.POLY_AT: return { type: 'polyat', ch, note: d1, value: d2 };
    case STATUS.CC: return { type: 'cc', ch, cc: d1, value: d2 };
    case STATUS.PC: return { type: 'pc', ch, value: d1 };
    case STATUS.CHAN_AT: return { type: 'chanat', ch, value: d1 };
    case STATUS.PB: return { type: 'pb', ch, value: d1 | (d2 << 7) };
    default: return { type: 'other' };
  }
}

export const to14 = (lsb, msb) => ((msb & 0x7f) << 7) | (lsb & 0x7f);
export const split14 = (v) => { v = Math.max(0, Math.min(16383, Math.round(v))); return [v & 0x7f, (v >> 7) & 0x7f]; };
/** Pitch bend 0..16383 -> -1..1 (8192 = centre). */
export const bendNorm = (v) => (v >= 8192 ? (v - 8192) / 8191 : (v - 8192) / 8192);

// ---------------------------------------------------------------------------- velocity curves
export const VELOCITY_CURVES = [
  { value: 'linear', label: 'Linear' },
  { value: 'soft', label: 'Soft (light touch = louder)' },
  { value: 'hard', label: 'Hard (needs a firm hit)' },
  { value: 'scurve', label: 'S-curve (expressive middle)' },
  { value: 'fixed', label: 'Fixed velocity' },
];
/** MIDI velocity 1..127 -> 0..1 through a curve. opts.fixed (0..1) for 'fixed'; opts.min floor (0..1). */
export function applyVelocityCurve(vel, curve = 'linear', opts = {}) {
  const x = Math.max(0, Math.min(1, vel / 127));
  if (x <= 0) return 0;
  let y;
  switch (curve) {
    case 'soft': y = Math.pow(x, 0.55); break;
    case 'hard': y = Math.pow(x, 1.8); break;
    case 'scurve': y = x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x); break;
    case 'fixed': return opts.fixed ?? 0.8;
    default: y = x;
  }
  const min = opts.min ?? 0;
  return +(min + (1 - min) * y).toFixed(4);
}

// ---------------------------------------------------------------------------- relative encoders
export const RELATIVE_MODES = ['relative-2c', 'relative-bin', 'relative-sm'];
/** Signed delta of a relative-encoder value. */
export function relativeDelta(mode, v) {
  if (mode === 'relative-2c') return v === 0 ? 0 : v < 64 ? v : v - 128;
  if (mode === 'relative-bin') return v - 64;
  if (mode === 'relative-sm') return v & 0x40 ? -(v & 0x3f) : v & 0x3f;
  return 0;
}

/**
 * Guess how a CC control encodes its movement from a series of values (in arrival order).
 * -> { mode: 'absolute'|'relative-2c'|'relative-bin'|'relative-sm'|'button'|null, sure: boolean }
 * Absolute knobs only send changed values, so they never repeat a value back-to-back; relative
 * encoders repeat the same small delta (1, 1, 1 / 127, 127 …). Button CCs send 127 / 0 pairs.
 */
export function detectCcMode(values) {
  const n = values.length;
  if (!n) return { mode: null, sure: false };
  const set = new Set(values);
  if ([...set].every((v) => v === 0 || v === 127) && set.has(127) && (set.has(0) || n === 1)) return { mode: 'button', sure: set.has(0) };
  let repeats = 0;
  for (let i = 1; i < n; i++) if (values[i] === values[i - 1]) repeats++;
  const inR = (v, a, b) => v >= a && v <= b;
  const lo = (v) => inR(v, 1, 15), hi = (v) => inR(v, 113, 127), up = (v) => inR(v, 65, 79), dn = (v) => inR(v, 49, 63);
  const relLike = n >= 3 && repeats / (n - 1) >= 0.3;
  if (!relLike) {
    // monotonic-ish sweeps and few samples: absolute (sure once we saw a real sweep)
    return { mode: 'absolute', sure: n >= 4 && repeats === 0 };
  }
  if (values.every((v) => up(v) || dn(v) || v === 64)) return { mode: 'relative-bin', sure: values.some(up) && values.some(dn) };
  if (values.every((v) => lo(v) || hi(v))) return { mode: 'relative-2c', sure: values.some(hi) };
  if (values.every((v) => lo(v) || up(v))) return { mode: 'relative-sm', sure: values.some(up) };
  return { mode: 'absolute', sure: false };
}

// ---------------------------------------------------------------------------- control decoder
/**
 * Stateful decoder: raw messages of one or more devices -> control events (see header).
 * 14-bit CC pairs are detected when CC n (0-31) is directly followed by CC n+32 on the same channel;
 * from then on the pair is reported once per LSB as kind 'cc14'.
 */
export class ControlDecoder {
  constructor() {
    this.ch = new Map(); // `${device}|${ch}` -> { msb:{}, pairs:Set, lastCc, nrpn, nrpnMsb, nrpn14:Set, rpn }
  }
  _state(device, ch) {
    const k = `${device}|${ch}`;
    let s = this.ch.get(k);
    if (!s) { s = { msb: {}, pairs: new Set(), lastCc: -1, nrpn: null, dataMsb: null, nrpn14: new Set(), rpnActive: false }; this.ch.set(k, s); }
    return s;
  }
  /** -> array of control events (usually 0 or 1). */
  decode(device, data, t = 0) {
    const m = parseMessage(data);
    const ev = (kind, num, value, max) => ({ device, ch: m.ch, kind, num, value, max, t });
    switch (m.type) {
      case 'noteon': case 'noteoff': return [ev('note', m.note, m.type === 'noteon' ? m.vel : 0, 127)];
      case 'pb': return [ev('pb', 0, m.value, 16383)];
      case 'chanat': return [ev('cp', 0, m.value, 127)];
      case 'cc': break;
      default: return [];
    }
    const s = this._state(device, m.ch);
    const { cc, value } = m;
    const prevCc = s.lastCc;
    s.lastCc = cc;
    // NRPN / RPN parameter selection + data entry
    if (cc === 99) { s.nrpn = (value << 7) | ((s.nrpn ?? 0) & 0x7f); s.rpnActive = false; s.dataMsb = null; return []; }
    if (cc === 98) { s.nrpn = ((s.nrpn ?? 0) & ~0x7f) | value; s.rpnActive = false; s.dataMsb = null; return []; }
    if (cc === 101 || cc === 100) { s.rpnActive = true; s.nrpn = null; return []; }
    if (s.nrpn != null && !s.rpnActive && (cc === 6 || cc === 38 || cc === 96 || cc === 97)) {
      const num = s.nrpn;
      if (cc === 6) {
        s.dataMsb = value;
        if (s.nrpn14.has(num)) return []; // wait for the LSB
        return [ev('nrpn', num, value, 127)];
      }
      if (cc === 38) {
        if (s.dataMsb == null) return [];
        s.nrpn14.add(num);
        return [ev('nrpn', num, to14(value, s.dataMsb), 16383)];
      }
      return [{ ...ev('nrpn', num, cc === 96 ? 1 : -1, 0), step: true }];
    }
    if (s.rpnActive && (cc === 6 || cc === 38 || cc === 96 || cc === 97)) return []; // RPN (bend range…) — not a control
    // 14-bit CC
    if (cc < 32) {
      s.msb[cc] = value;
      if (s.pairs.has(cc)) return []; // reported with its LSB
      return [ev('cc', cc, value, 127)];
    }
    if (cc >= 32 && cc < 64) {
      const msbCc = cc - 32;
      if (s.pairs.has(msbCc) || (prevCc === msbCc && s.msb[msbCc] != null)) {
        s.pairs.add(msbCc);
        return [ev('cc14', msbCc, to14(value, s.msb[msbCc] ?? 0), 16383)];
      }
    }
    return [ev('cc', cc, value, 127)];
  }
}

/** Short human label of a control source: "CC 74 · ch 1", "Note C3 · ch 10", "NRPN 1:5 (14-bit)". */
export function sourceLabel(src) {
  if (!src) return '—';
  const ch = src.ch == null ? 'any ch' : `ch ${src.ch + 1}`;
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  switch (src.kind) {
    case 'cc': return `CC ${src.num} · ${ch}`;
    case 'cc14': return `CC ${src.num}/${src.num + 32} (14-bit) · ${ch}`;
    case 'nrpn': return `NRPN ${src.num >> 7}:${src.num & 0x7f} · ${ch}`;
    case 'note': return `Note ${NOTE[src.num % 12]}${Math.floor(src.num / 12) - 1} · ${ch}`;
    case 'pb': return `Pitch bend · ${ch}`;
    case 'cp': return `Pressure · ${ch}`;
    default: return String(src.kind);
  }
}
