// Mixer meter modes (UI side): which ballistics / scale each strip meter uses — one global mode plus optional per-strip
// overrides — the VU / PPM reference levels, the strip LUFS readout switch, the menus that change them and the
// canvas drawing of a mode meter. Stored per browser (a monitoring preference, not part of the project).
// Ballistics and scales: src/audio/dsp/ballistics.js.
import { METER_MODES, METER_DEFAULTS, meterMode, meterScale, StereoBallistics } from '../audio/dsp/ballistics.js';

const LS = 'daw3-meter-modes';
const defaults = () => ({ global: 'peak', strips: {}, vuRef: METER_DEFAULTS.vuRef, align: METER_DEFAULTS.align, stripLufs: false });
let prefs = defaults();
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { /* */ }
const listeners = new Set();
const save = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* */ } for (const fn of listeners) { try { fn(prefs); } catch { /* */ } } };

export const meterPrefs = () => prefs;
export const onMeterPrefs = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Effective mode of a strip ('master', a track or a bus id). */
export const modeFor = (id) => meterMode(prefs.strips[id] || prefs.global).id;
export function setGlobalMode(mode) { prefs.global = meterMode(mode).id; save(); }
export function setStripMode(id, mode) { if (mode) prefs.strips[id] = meterMode(mode).id; else delete prefs.strips[id]; save(); }
export function setMeterOption(key, value) { prefs[key] = value; save(); }
export const scaleOpts = () => ({ vuRef: prefs.vuRef, align: prefs.align });

const REF_LEVELS = [-12, -14, -16, -18, -20, -24];

/** Context-menu items for one strip's meter (or only the global settings when id is null). */
export function meterMenuItems(id = null) {
  const items = [];
  if (id) {
    const own = prefs.strips[id];
    items.push({ header: 'Meter of this channel' },
      { label: `${own ? '' : '● '}Follow the global mode (${meterMode(prefs.global).label})`, onClick: () => setStripMode(id, null) },
      ...METER_MODES.map((m) => ({ label: `${own === m.id ? '● ' : ''}${m.label}`, title: m.help, onClick: () => setStripMode(id, m.id) })),
      '-');
  }
  items.push(
    { label: 'Global meter mode', submenu: METER_MODES.map((m) => ({ label: `${prefs.global === m.id ? '● ' : ''}${m.label}`, title: m.help, onClick: () => setGlobalMode(m.id) })) },
    { label: `VU reference: 0 VU = ${prefs.vuRef} dBFS`, submenu: REF_LEVELS.map((v) => ({ label: `${prefs.vuRef === v ? '● ' : ''}${v} dBFS${v === -18 ? ' (EBU R68)' : v === -20 ? ' (SMPTE RP155)' : ''}`, onClick: () => setMeterOption('vuRef', v) })) },
    { label: `PPM alignment: ${prefs.align} dBFS`, submenu: REF_LEVELS.map((v) => ({ label: `${prefs.align === v ? '● ' : ''}${v} dBFS${v === -18 ? ' (EBU R68)' : ''}`, onClick: () => setMeterOption('align', v) })) },
    ...(Object.keys(prefs.strips).length ? [{ label: 'Reset every channel to the global mode', onClick: () => { prefs.strips = {}; save(); } }] : []),
    '-',
    { label: `${prefs.stripLufs ? '● ' : ''}Short-term LUFS on every strip`, title: 'BS.1770 short-term loudness under each meter (one loudness meter per channel)', onClick: () => setMeterOption('stripLufs', !prefs.stripLufs) },
  );
  return items;
}

/** Per-strip runtime state of a mode meter: ballistics recreated when the mode / rate / references change. */
export function modeMeter(st, mode, sampleRate) {
  const key = `${mode}|${sampleRate}|${prefs.vuRef}|${prefs.align}`;
  if (!st.mm || st.mm.key !== key) {
    st.mm = { key, mode, ball: new StereoBallistics(mode, sampleRate, scaleOpts()), scale: meterScale(mode, scaleOpts()), t: 0, hold: [0, 0], holdT: [0, 0], shown: [0, 0] };
  }
  return st.mm;
}

const ZONE = { ok: '#2fd17a', mid: '#9be15d', warn: '#ffb547', hot: '#ff4d5e' };

/** Draw a mode meter (2 bars) into a fitted canvas; returns the reading (max of L / R, sine-peak dBFS). */
export function drawModeMeter(fit, mm, rd, now, colors) {
  const { ctx, w, h: H } = fit;
  const sc = mm.scale;
  ctx.clearRect(0, 0, w, H);
  const gap = 1, bw = (w - gap) / 2;
  for (let i = 0; i < 2; i++) {
    const x = i * (bw + gap);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(x, 0, bw, H);
    const n = sc.pos(rd.db[i]);
    mm.shown[i] = n;
    // bar, coloured by scale zone
    for (const z of sc.zones) {
      const a = sc.pos(z.from), b = Math.min(n, sc.pos(z.to));
      if (b <= a) continue;
      ctx.fillStyle = ZONE[z.level] || ZONE.ok;
      ctx.fillRect(x, H - b * H, bw, (b - a) * H);
    }
    // fast peak of averaging meters
    if (mm.mode !== 'peak' && meterMode(mm.mode).kind !== 'ppm') {
      const pn = sc.pos(rd.peakDb[i]);
      if (pn > 0.005) { ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillRect(x, H - pn * H, bw, 1); }
    }
    // peak hold of the reading (1.5 s, then falls)
    if (n >= mm.hold[i]) { mm.hold[i] = n; mm.holdT[i] = now; } else if (now - mm.holdT[i] > 1500) mm.hold[i] = Math.max(n, mm.hold[i] - 0.01);
    if (mm.hold[i] > 0.01) { ctx.fillStyle = mm.hold[i] >= sc.pos(sc.zones[sc.zones.length - 1].from) ? ZONE.hot : colors.hold; ctx.fillRect(x, H - mm.hold[i] * H, bw, 1.5); }
  }
  // scale ticks (reference mark brighter)
  for (const t of sc.ticks) {
    const y = Math.round(H - sc.pos(t.db) * H);
    const ref = t.label === '0' || t.label === 'TEST' || t.label === '4' && mm.mode === 'ppm-bbc';
    ctx.fillStyle = ref ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.16)';
    ctx.fillRect(0, y, w, 1);
  }
  return Math.max(rd.db[0], rd.db[1]);
}

/** Tooltip text: the mode, its references and the tick labels (the canvas is too narrow for numbers). */
export function modeTitle(mode) {
  const m = meterMode(mode);
  const sc = meterScale(mode, scaleOpts());
  const ref = m.kind === 'vu' ? ` · 0 VU = ${prefs.vuRef} dBFS` : m.kind === 'ppm' ? ` · alignment ${prefs.align} dBFS` : '';
  return `${m.label}${ref} — ${m.help}\nScale: ${sc.ticks.map((t) => t.label).join(' · ')}\nRight-click: meter mode`;
}
