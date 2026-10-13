// Mixer console: channel strips for every track, return buses and the master.
// Strips are rebuilt only when the mixer *structure* changes (tracks, buses, fx
// lists, names); fader/pan/send/toggle values are updated in place so dragging a
// control never rebuilds the DOM. One rAF loop drives every meter while visible.
import { h, icon, startDrag, fitCanvas, clear } from '../dom.js';
import { knob, contextMenu, promptText, confirmDialog, button, iconButton, markAuto, touchStart, touchEnd } from '../components.js';
import { createBus, createEffect } from '../../core/model.js';
import { clamp, dbToGain, gainToDb } from '../../core/util.js';
import { EFFECT_DEFS, INSTRUMENT_DEFS, PRESETS, DRUM_KITS } from '../../audio/index.js';
import { showEffectMenu } from '../panels/device.js';
import { isPatchActive, patchFxOrder } from '../../core/patch.js';

// ---------------------------------------------------------------- helpers
const VOL_MAX = 1.5;
/** Fader taper: cube-root of linear gain → 0 dB sits at ~87 % travel, −60 dB near the bottom. */
const volToPos = (g) => Math.cbrt(clamp(g, 0, VOL_MAX) / VOL_MAX);
const posToVol = (n) => +(VOL_MAX * Math.pow(clamp(n, 0, 1), 3)).toFixed(4);
const fmtDb = (g) => {
  if (g <= 0.0001) return '−∞';
  const db = gainToDb(g);
  return (db > 0.05 ? '+' : db < -0.05 ? '−' : '') + Math.abs(db).toFixed(1);
};
const fmtPan = (v) => (Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
const SCALE_DB = [3, 0, -3, -6, -12, -20, -30, -40, -60];
const METER_MIN_DB = -60, METER_MAX_DB = 6;
const meterPos = (lin) => (lin <= 0 ? 0 : clamp((20 * Math.log10(lin) - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB), 0, 1));

const PAN_DEF = { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, default: 0, description: 'Pan — drag up/down, double-click to center' };
const SEND_DEF = (bus) => ({ key: 'send', label: bus.name, min: 0, max: 1, step: 0.01, default: 0, unit: '%', description: `Send level to “${bus.name}” — double-click to reset` });

const ROLE_RE = [
  ['drums', /drum|kit|beat|kick|snare|hat|808|909/i], ['bass', /bass|sub|808 bass/i], ['pad', /pad|string|choir|atmos/i],
  ['chords', /chord|key|piano|organ|stab|rhodes|ep\b/i], ['lead', /lead|melody|pluck|bell/i], ['arp', /arp/i],
  ['vocal', /vox|vocal|voice/i], ['fx', /fx|riser|sweep|noise|impact/i], ['perc', /perc|shaker|conga|tamb|clap/i],
];
/** Best guess of a track's musical role (used by the auto-mix helpers). */
export function trackRole(t) {
  if (t.instrument?.type === 'drums') return t.role === 'perc' ? 'perc' : 'drums';
  if (t.role) return t.role;
  const pr = t.instrument?.preset && PRESETS?.[t.instrument.preset];
  if (pr?.roles?.length) return pr.roles[0];
  for (const [role, re] of ROLE_RE) if (re.test(t.name || '')) return role;
  if (t.type === 'code') return 'code';
  if (t.type === 'audio') return 'audio';
  return 'other';
}

function trackSubtitle(t) {
  if (t.type === 'audio') return 'Audio';
  if (t.type === 'code') return 'Code';
  const ins = t.instrument;
  if (!ins) return '';
  if (ins.type === 'drums') return DRUM_KITS?.[ins.preset]?.name || 'Drums';
  return PRESETS?.[ins.preset]?.name || INSTRUMENT_DEFS?.[ins.type]?.name || ins.type;
}
const trackIcon = (t) => (t.type === 'code' ? 'code' : t.type === 'audio' ? 'wave' : t.instrument?.type === 'drums' ? 'drum' : t.instrument?.type === 'sampler' ? 'wave' : 'piano');

const BUS_TEMPLATES = [
  { label: 'Reverb — Hall', name: 'Hall', fx: () => [createEffect('reverb', { mix: 1, decay: 3.2, size: 0.8, predelay: 0.02 })], help: 'Lush hall reverb for pads, vocals and leads' },
  { label: 'Reverb — Room', name: 'Room', fx: () => [createEffect('reverb', { mix: 1, decay: 0.8, size: 0.3, damping: 0.6 })], help: 'Short room ambience that glues drums and percussion' },
  { label: 'Delay — 1/8 dotted ping-pong', name: 'Delay', fx: () => [createEffect('delay', { mix: 1, sync: true, division: '1/8D', feedback: 0.4, pingpong: true })], help: 'Tempo-synced stereo echo' },
  { label: 'Delay — 1/4 dub', name: 'Dub Delay', fx: () => [createEffect('delay', { mix: 1, sync: true, division: '1/4', feedback: 0.6, highcut: 3000 }), createEffect('reverb', { mix: 0.25, decay: 1.5 })], help: 'Dark, long dub echo' },
  { label: 'Parallel compression', name: 'Parallel Comp', fx: () => [createEffect('compressor', { threshold: -32, ratio: 8, attack: 0.003, release: 0.12, makeup: 10, mix: 1 })], help: 'New-York style parallel crush — send drums here' },
  { label: 'Chorus / width', name: 'Width', fx: () => [createEffect('chorus', { mix: 1, depth: 0.6 }), createEffect('widener', { width: 1.6 })], help: 'Thickens and widens anything you send to it' },
  { label: 'Lo-fi', name: 'Lo-fi', fx: () => [createEffect('bitcrusher', { bits: 8, downsample: 3, mix: 1 }), createEffect('filter', { type: 'lowpass', cutoff: 3500 })], help: 'Crunchy, dusty texture' },
  { label: 'Empty bus', name: 'Bus', fx: () => [], help: 'Blank return track' },
];

const LS_KEY = 'dawww-mixer';
function loadPrefs() {
  try { return { narrow: false, showBuses: true, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; } catch { return { narrow: false, showBuses: true }; }
}

// ---------------------------------------------------------------- view
export function createMixerView(app) {
  const { store, ui, engine, actions } = app;
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

  let visible = false;
  let dirty = true;
  let lastSig = '';
  /** strips: Map id -> strip api { kind, id, update(p), meterEl, ... } */
  let strips = new Map();

  // ---- toolbar
  const addTrackBtn = button('Track', (e) => contextMenu(menuPos(e), actions.addTrackMenuItems()), { icon: 'plus', title: 'Add a new track (instrument, drums, audio or code)' });
  const addBusBtn = button('Bus', (e) => contextMenu(menuPos(e), busMenuItems()), { icon: 'plus', title: 'Add a return bus (reverb, delay, parallel compression…) that tracks can send to' });
  const assistBtn = button('Auto-mix assist ▾', (e) => contextMenu(menuPos(e), assistMenuItems()), { icon: 'wand', title: 'One-click mixing helpers: gain staging, panning and sends by track role. Every step can be undone.' });
  const busToggle = h('button.toggle', { type: 'button', title: 'Show or hide the return-bus strips' }, 'Buses');
  busToggle.addEventListener('click', () => { prefs.showBuses = !prefs.showBuses; savePrefs(); render(true); });
  const narrowToggle = h('button.toggle', { type: 'button', title: 'Narrow strips: fit more channels on screen' }, 'Narrow');
  narrowToggle.addEventListener('click', () => { prefs.narrow = !prefs.narrow; savePrefs(); render(true); });
  const resetPeaksBtn = button('Reset peaks', () => resetAllPeaks(), { title: 'Clear every clip indicator and peak-hold readout', cls: 'small' });
  const toolbar = h('div.view-toolbar.mx-toolbar',
    h('span.mx-title', icon('mixer', 15), 'Mixer'),
    h('div.sep'), addTrackBtn, addBusBtn, h('div.sep'), assistBtn, h('div.sep'), busToggle, narrowToggle,
    h('div.spacer'), resetPeaksBtn);

  const scroller = h('div.mx-scroll');
  const masterHost = h('div.mx-master-host');
  const body = h('div.mx-body', scroller, masterHost);
  const el = h('div.mixer-view', toolbar, body);

  scroller.addEventListener('wheel', (e) => {
    // vertical wheel over empty strip areas scrolls the console horizontally
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.target.closest('.knob, .mx-fader, .mx-inserts, .mx-sends')) {
      scroller.scrollLeft += e.deltaY;
    }
  }, { passive: true });

  function menuPos(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return { clientX: r.left, clientY: r.bottom + 2, preventDefault() {} };
  }

  // ---------------------------------------------------------------- structure signature
  const fxSig = (fx) => (fx || []).map((f) => `${f.id}:${f.type}:${f.enabled ? 1 : 0}`).join(',');
  function signature(p) {
    return JSON.stringify([
      prefs.narrow, prefs.showBuses,
      p.tracks.map((t) => [t.id, t.name, t.color, t.type, t.instrument?.type, t.instrument?.preset, fxSig(t.fx), isPatchActive(t) ? patchFxOrder(t).join(',') : 0]),
      p.buses.map((b) => [b.id, b.name, fxSig(b.fx)]),
      fxSig(p.master.fx),
    ]);
  }

  function render(force = false) {
    if (!visible) { dirty = true; return; }
    const p = store.get();
    const sig = signature(p);
    if (force || sig !== lastSig) {
      lastSig = sig;
      rebuild(p);
    }
    update(p);
    dirty = false;
  }

  function rebuild(p) {
    const scrollLeft = scroller.scrollLeft;
    const oldStrips = strips;
    strips = new Map();
    clear(scroller);
    clear(masterHost);
    el.classList.toggle('narrow', prefs.narrow);
    const sendRows = prefs.showBuses && p.buses.length ? Math.min(3, Math.ceil(p.buses.length / 2)) : 0;
    el.style.setProperty('--mx-send-rows', sendRows);
    busToggle.classList.toggle('on', prefs.showBuses);
    narrowToggle.classList.toggle('on', prefs.narrow);

    const trackGroup = h('div.mx-group.mx-tracks');
    if (!p.tracks.length) {
      trackGroup.appendChild(h('div.mx-empty',
        icon('mixer', 28), h('h3', 'No tracks yet'),
        h('p', 'Every track gets a channel strip here with inserts, sends, pan and a fader.'),
        button('Add a track', (e) => contextMenu(menuPos(e), actions.addTrackMenuItems()), { icon: 'plus', primary: true })));
    }
    for (const t of p.tracks) {
      const s = trackStrip(t, p);
      carryPeaks(oldStrips.get(t.id), s);
      strips.set(t.id, s);
      trackGroup.appendChild(s.el);
    }
    scroller.appendChild(trackGroup);

    if (prefs.showBuses) {
      const busGroup = h('div.mx-group.mx-buses', h('div.mx-group-label', 'Returns'));
      for (const b of p.buses) {
        const s = busStrip(b, p);
        carryPeaks(oldStrips.get(b.id), s);
        strips.set(b.id, s);
        busGroup.appendChild(s.el);
      }
      const add = h('button.mx-add-bus', { type: 'button', title: 'Add a return bus' }, icon('plus', 16), h('span', 'Add bus'));
      add.addEventListener('click', (e) => contextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault() {} }, busMenuItems()));
      busGroup.appendChild(add);
      scroller.appendChild(busGroup);
    }

    const m = masterStrip(p);
    carryPeaks(oldStrips.get('master'), m);
    strips.set('master', m);
    masterHost.appendChild(m.el);
    scroller.scrollLeft = scrollLeft;
    needFit = true;
  }

  function carryPeaks(from, to) {
    if (!from || !to) return;
    to.meterState.peakMax = from.meterState.peakMax;
    to.meterState.clip = from.meterState.clip;
    to.meterState.hold = from.meterState.hold;
    to.meterState.holdT = from.meterState.holdT;
  }

  function update(p) {
    const anySolo = p.tracks.some((t) => t.solo);
    const sel = ui.get('selectedTrackId');
    for (const t of p.tracks) {
      const s = strips.get(t.id);
      if (!s) continue;
      s.setVolume(t.volume);
      s.pan.setValue(t.pan);
      s.panVal.textContent = fmtPan(t.pan);
      s.mute.classList.toggle('on', !!t.mute);
      s.solo.classList.toggle('on', !!t.solo);
      s.arm?.classList.toggle('on', !!t.arm);
      for (const [busId, k] of s.sends) k.setValue(t.sends?.[busId] || 0);
      s.el.classList.toggle('selected', t.id === sel);
      s.el.classList.toggle('silenced', !!t.mute || (anySolo && !t.solo));
    }
    for (const b of p.buses) {
      const s = strips.get(b.id);
      if (!s) continue;
      s.setVolume(b.volume);
      s.pan.setValue(b.pan);
      s.panVal.textContent = fmtPan(b.pan);
      s.mute.classList.toggle('on', !!b.mute);
      s.el.classList.toggle('silenced', !!b.mute);
      const target = ui.get('deviceTarget');
      s.el.classList.toggle('selected', target?.kind === 'bus' && target.id === b.id);
    }
    const m = strips.get('master');
    if (m) {
      m.setVolume(p.master.volume);
      const target = ui.get('deviceTarget');
      m.el.classList.toggle('selected', target?.kind === 'master');
    }
  }

  // ---------------------------------------------------------------- edits
  const editTrack = (id, label, fn, coalesce = false) => store.transact(label, (p) => { const t = p.tracks.find((x) => x.id === id); if (t) fn(t, p); }, { coalesce });
  const editBus = (id, label, fn, coalesce = false) => store.transact(label, (p) => { const b = p.buses.find((x) => x.id === id); if (b) fn(b, p); }, { coalesce });
  const editMaster = (label, fn, coalesce = false) => store.transact(label, (p) => fn(p.master, p), { coalesce });
  // Drags coalesce into one undo step; the gesture's closing "final" call is skipped when it changes nothing
  // (otherwise every fader/knob drag left a second, empty undo step behind).
  const same = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9;
  const trackOf = (id) => store.get().tracks.find((x) => x.id === id);
  const busOf = (id) => store.get().buses.find((x) => x.id === id);

  function openChain(kind, id, fxId) {
    if (kind === 'track') {
      actions.selectTrack(id);
      ui.set({ deviceOpen: true, deviceTarget: null, deviceFocus: fxId || null });
    } else {
      ui.set({ deviceOpen: true, deviceTarget: { kind, id }, deviceFocus: fxId || null });
    }
  }

  // ---------------------------------------------------------------- strip parts
  function insertsSection(kind, id, fxList, getFxOwner, patched = false) {
    const ownerId = kind === 'master' ? 'master' : id;
    const list = h('div.mx-slot-list');
    fxList.forEach((f, i) => {
      const def = EFFECT_DEFS?.[f.type];
      const dot = h('button.mx-slot-dot', { type: 'button', title: f.enabled ? 'Bypass this effect' : 'Enable this effect' });
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        store.transact(`${f.enabled ? 'Bypass' : 'Enable'} ${def?.name || f.type}`, (p) => { const fx = getFxOwner(p)?.fx.find((x) => x.id === f.id); if (fx) fx.enabled = !fx.enabled; });
      });
      markAuto(dot, ownerId, `fxen:${f.id}`).autoSet = (on) => { dot.parentElement?.classList.toggle('off', !on); };
      const slot = h(`div.mx-slot${f.enabled ? '' : '.off'}`, { title: `${def?.name || f.type}${def?.description ? ' — ' + def.description : ''}\nClick to edit in the device panel · right-click for options` }, dot, h('span.mx-slot-name', def?.name || f.type));
      slot.addEventListener('click', () => openChain(kind, id, f.id));
      slot.addEventListener('contextmenu', (e) => contextMenu(e, [
        { header: def?.name || f.type },
        { label: 'Edit in device panel', icon: 'sliders', onClick: () => openChain(kind, id, f.id) },
        { label: f.enabled ? 'Bypass' : 'Enable', icon: 'power', onClick: () => dot.click() },
        patched ? { label: 'Show on the Plugboard', icon: 'plug', onClick: () => openPlugboard(id) } : null,
        { label: 'Move up', disabled: i === 0 || patched, onClick: () => moveFx(getFxOwner, f.id, -1) },
        { label: 'Move down', disabled: i === fxList.length - 1 || patched, onClick: () => moveFx(getFxOwner, f.id, 1) },
        { label: 'Duplicate', icon: 'copy', onClick: () => store.transact('Duplicate effect', (p) => { const o = getFxOwner(p); const j = o.fx.findIndex((x) => x.id === f.id); if (j >= 0) o.fx.splice(j + 1, 0, createEffect(f.type, JSON.parse(JSON.stringify(f.params || {})))); }) },
        '-',
        { label: 'Remove', icon: 'trash', onClick: () => store.transact(`Remove ${def?.name || f.type}`, (p) => { const o = getFxOwner(p); o.fx = o.fx.filter((x) => x.id !== f.id); }) },
      ].filter(Boolean)));
      list.appendChild(slot);
    });
    const add = h('button.mx-slot.mx-slot-add', { type: 'button', title: 'Add an insert effect' }, icon('plus', 12), h('span', fxList.length ? '' : 'Add FX'));
    add.addEventListener('click', (e) => {
      showEffectMenu({ clientX: e.clientX, clientY: e.clientY }, (type, params) => {
        const fx = createEffect(type, params || {});
        store.transact(`Add ${EFFECT_DEFS?.[type]?.name || type}`, (p) => { getFxOwner(p)?.fx.push(fx); });
        openChain(kind, id, fx.id);
      });
    });
    list.appendChild(add);
    if (patched) {
      const badge = h('button.mx-plug-badge', { type: 'button', title: 'This channel’s effects are wired on the Plugboard (parallel branches / sidechain). Shown in signal-flow order — click to open the Plugboard.' }, icon('plug', 9), 'PLUG');
      badge.addEventListener('click', (e) => { e.stopPropagation(); openPlugboard(id); });
      return h('div.mx-inserts.patched', h('div.mx-sec-label', 'Inserts', badge), list);
    }
    return h('div.mx-inserts', h('div.mx-sec-label', { title: 'Insert effects process this channel in series, top to bottom' }, 'Inserts'), list);
  }

  function openPlugboard(trackId) {
    actions.selectTrack(trackId);
    app.showView('patch');
  }

  function moveFx(getFxOwner, fxId, dir) {
    store.transact('Reorder effects', (p) => {
      const o = getFxOwner(p);
      const i = o.fx.findIndex((x) => x.id === fxId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.fx.length) return;
      [o.fx[i], o.fx[j]] = [o.fx[j], o.fx[i]];
    });
  }

  function panSection(value, onChange, auto = null) {
    const panVal = h('div.mx-pan-val', fmtPan(value));
    const k = knob({ def: PAN_DEF, value, size: prefs.narrow ? 26 : 30, label: false, showValue: false, onChange: (v, meta) => { panVal.textContent = fmtPan(v); onChange(v, meta); } });
    if (auto) { markAuto(k, auto.owner, 'pan'); k.autoSet = (v) => { k.setValue(v); panVal.textContent = fmtPan(v); }; }
    k.classList.add('mx-pan-knob');
    return { el: h('div.mx-pan', k, panVal), knob: k, panVal };
  }

  /** Vertical fader with dB scale, stereo meter, clip LED and peak readout. */
  function faderSection({ value, onChange, color, big = false, title, auto = null }) {
    const scale = h('div.mx-scale');
    for (const db of SCALE_DB) {
      const pos = volToPos(dbToGain(db));
      scale.appendChild(h('div.mx-tick', { style: { bottom: `${pos * 100}%` } }, h('span', db > 0 ? `+${db}` : String(db))));
    }
    const fill = h('div.mx-fader-fill', { style: color ? { background: color } : {} });
    const cap = h('div.mx-fader-cap');
    const groove = h('div.mx-fader-groove', fill);
    const fad = h('div.mx-fader', { title: `${title || 'Volume'} — drag (Shift = fine), double-click = 0.8 / Alt-click = 0 dB, wheel to nudge` }, groove, cap);
    let v = value;
    const setPos = () => {
      const n = volToPos(v) * 100;
      cap.style.bottom = `calc(${n}% - 9px)`;
      fill.style.height = `${n}%`;
    };
    const readout = h('div.mx-db', { title: 'Fader level in dB — click to type a value' });
    const setReadout = () => { readout.textContent = fmtDb(v); };
    const commit = (nv, final) => {
      v = clamp(nv, 0, VOL_MAX);
      setPos(); setReadout();
      onChange(v, { final });
    };
    fad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.altKey) { commit(1, true); return; }
      const r = fad.getBoundingClientRect();
      // click on the groove (not the cap) jumps there; dragging is always relative
      const capR = cap.getBoundingClientRect();
      fad.classList.add('active');
      touchStart(fad);
      if (e.clientY < capR.top - 2 || e.clientY > capR.bottom + 2) commit(posToVol(1 - (e.clientY - r.top) / r.height), false);
      const n0 = volToPos(v);
      startDrag(e, (_dx, dy, ev) => {
        const k = ev.shiftKey ? 0.2 : 1;
        commit(posToVol(n0 - (dy / r.height) * k), false);
      }, () => { fad.classList.remove('active'); onChange(v, { final: true }); touchEnd(fad); });
    });
    fad.addEventListener('dblclick', () => commit(0.8, true));
    fad.addEventListener('wheel', (e) => { e.preventDefault(); commit(posToVol(volToPos(v) - Math.sign(e.deltaY) * (e.shiftKey ? 0.004 : 0.02)), false); }, { passive: false });
    readout.addEventListener('click', async () => {
      const s = await promptText('Set level (dB)', v > 0 ? gainToDb(v).toFixed(1) : '-inf');
      if (s == null) return;
      const db = parseFloat(String(s).replace('−', '-'));
      if (/inf/i.test(s)) commit(0, true);
      else if (Number.isFinite(db)) commit(dbToGain(clamp(db, -90, gainToDb(VOL_MAX))), true);
    });

    const meterCanvas = h('canvas.mx-meter', { title: 'Level meter (peak). Hold line shows recent peak.' });
    const clipLed = h('button.mx-clip', { type: 'button', title: 'Clip indicator — lights when the signal reaches 0 dBFS. Click to reset.' });
    const peakEl = h('div.mx-peak', { title: 'Highest peak since reset (dBFS) — click to reset' }, '−∞');
    const meterState = { l: 0, r: 0, hold: [0, 0], holdT: [0, 0], peakMax: 0, clip: false, clipLed, peakEl, canvas: meterCanvas, fit: null };
    const reset = () => { meterState.clip = false; meterState.peakMax = 0; meterState.hold = [0, 0]; clipLed.classList.remove('on'); peakEl.textContent = '−∞'; peakEl.classList.remove('hot'); };
    clipLed.addEventListener('click', reset);
    peakEl.addEventListener('click', reset);

    setPos(); setReadout();
    if (auto) { markAuto(fad, auto.owner, 'volume'); fad.autoSet = (nv) => { if (fad.classList.contains('active')) return; v = nv; setPos(); setReadout(); }; }
    const area = h(`div.mx-fader-area${big ? '.big' : ''}`, scale, fad, h('div.mx-meter-wrap', clipLed, meterCanvas));
    return {
      area, readout, peakEl, meterState, reset,
      setVolume: (nv) => { if (fad.classList.contains('active')) return; v = nv; setPos(); setReadout(); },
    };
  }

  // ---------------------------------------------------------------- track strip
  function trackStrip(t, p) {
    const get = (pp) => pp.tracks.find((x) => x.id === t.id);
    const nameEl = h('div.mx-name', { title: `${t.name} — click to select, double-click to rename, right-click for track options` }, t.name);
    const head = h('div.mx-head', { style: { '--strip-color': t.color } },
      h('div.mx-color'),
      nameEl,
      h('div.mx-sub', { title: trackSubtitle(t) }, icon(trackIcon(t), 11), h('span', trackSubtitle(t))));
    head.addEventListener('click', () => actions.selectTrack(t.id));
    head.addEventListener('dblclick', () => actions.renameTrack(t.id));
    head.addEventListener('contextmenu', (e) => contextMenu(e, actions.trackMenuItems(t.id)));

    const patched = isPatchActive(t);
    const ordered = patched ? patchFxOrder(t).map((fid) => t.fx.find((f) => f.id === fid)).filter(Boolean) : (t.fx || []);
    const inserts = insertsSection('track', t.id, ordered, get, patched);

    // sends
    const sends = new Map();
    let sendsSec = null;
    if (p.buses.length && prefs.showBuses) {
      const grid = h('div.mx-send-grid');
      for (const b of p.buses) {
        const k = knob({
          def: SEND_DEF(b), value: t.sends?.[b.id] || 0, size: prefs.narrow ? 22 : 24, label: b.name, showValue: false,
          onChange: (v, { final }) => { if (final && same(trackOf(t.id)?.sends?.[b.id] || 0, v)) return; editTrack(t.id, `Send ${b.name}`, (tt) => { if (v <= 0.001) delete tt.sends[b.id]; else tt.sends[b.id] = v; }, !final); },
        });
        k.classList.add('mx-send-knob');
        markAuto(k, t.id, `send:${b.id}`);
        sends.set(b.id, k);
        grid.appendChild(k);
      }
      sendsSec = h('div.mx-sends', h('div.mx-sec-label', { title: 'Post-fader sends to the return buses' }, 'Sends'), grid);
    }

    const pan = panSection(t.pan, (v, { final }) => { if (final && same(trackOf(t.id)?.pan, v)) return; editTrack(t.id, `Pan ${t.name}`, (tt) => { tt.pan = v; }, !final); }, { owner: t.id });
    const mute = h('button.toggle.mute.mx-btn', { type: 'button', title: 'Mute (silence this track)' }, 'M');
    markAuto(mute, t.id, 'mute').autoSet = (on) => mute.classList.toggle('on', !!on);
    const solo = h('button.toggle.solo.mx-btn', { type: 'button', title: 'Solo (hear only soloed tracks) — Ctrl/Cmd-click for exclusive solo' }, 'S');
    const arm = t.type !== 'code' ? h('button.toggle.arm.mx-btn', { type: 'button', title: 'Record arm' }, h('span.mx-arm-dot')) : null;
    mute.addEventListener('click', () => editTrack(t.id, 'Mute', (tt) => { tt.mute = !tt.mute; }));
    solo.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        store.transact('Exclusive solo', (pp) => {
          const onlyThis = get(pp).solo && !pp.tracks.some((y) => y.solo && y.id !== t.id);
          for (const x of pp.tracks) x.solo = !onlyThis && x.id === t.id;
        });
      }
      else editTrack(t.id, 'Solo', (tt) => { tt.solo = !tt.solo; });
    });
    arm?.addEventListener('click', () => editTrack(t.id, 'Arm', (tt) => { tt.arm = !tt.arm; }));

    const fad = faderSection({ value: t.volume, color: t.color, title: `${t.name} volume`, auto: { owner: t.id }, onChange: (v, { final }) => { if (final && same(trackOf(t.id)?.volume, v)) return; editTrack(t.id, `Volume ${t.name}`, (tt) => { tt.volume = v; }, !final); } });

    const el = h('div.mx-strip.mx-track', { dataset: { id: t.id }, style: { '--strip-color': t.color } },
      head, inserts, sendsSec, pan.el,
      h('div.mx-btns', mute, solo, arm),
      fad.area,
      h('div.mx-foot', fad.readout, fad.peakEl));
    return { kind: 'track', id: t.id, el, pan: pan.knob, panVal: pan.panVal, mute, solo, arm, sends, setVolume: fad.setVolume, meterState: fad.meterState, reset: fad.reset };
  }

  // ---------------------------------------------------------------- bus strip
  function busStrip(b, p) {
    const get = (pp) => pp.buses.find((x) => x.id === b.id);
    const rename = async () => {
      const n = await promptText('Rename bus', b.name);
      if (n) editBus(b.id, 'Rename bus', (bb) => { bb.name = n; });
    };
    const head = h('div.mx-head.bus', { title: `${b.name} (return bus) — double-click to rename, right-click for options` },
      h('div.mx-color'), h('div.mx-name', b.name), h('div.mx-sub', icon('layers', 11), h('span', 'Return')));
    head.addEventListener('click', () => openChain('bus', b.id));
    head.addEventListener('dblclick', rename);
    const menu = (e) => contextMenu(e, [
      { header: b.name },
      { label: 'Rename…', icon: 'pencil', onClick: rename },
      { label: 'Edit effects', icon: 'sliders', onClick: () => openChain('bus', b.id) },
      { label: 'Send all tracks here (20%)', onClick: () => store.transact(`Send all to ${b.name}`, (p) => { for (const t of p.tracks) if (!t.sends[b.id]) t.sends[b.id] = 0.2; }) },
      { label: 'Clear sends to this bus', onClick: () => store.transact(`Clear sends to ${b.name}`, (p) => { for (const t of p.tracks) delete t.sends[b.id]; }) },
      '-',
      { label: 'Delete bus', icon: 'trash', onClick: () => deleteBus(b.id) },
    ]);
    head.addEventListener('contextmenu', menu);
    const del = iconButton('x', () => deleteBus(b.id), 'Delete this bus (removes all sends to it)', 'mx-del');
    head.appendChild(del);

    const inserts = insertsSection('bus', b.id, b.fx || [], get);
    const pan = panSection(b.pan, (v, { final }) => { if (final && same(busOf(b.id)?.pan, v)) return; editBus(b.id, `Pan ${b.name}`, (bb) => { bb.pan = v; }, !final); }, { owner: b.id });
    const mute = h('button.toggle.mute.mx-btn', { type: 'button', title: 'Mute this return' }, 'M');
    markAuto(mute, b.id, 'mute').autoSet = (on) => mute.classList.toggle('on', !!on);
    mute.addEventListener('click', () => editBus(b.id, 'Mute bus', (bb) => { bb.mute = !bb.mute; }));
    const fad = faderSection({ value: b.volume, title: `${b.name} return level`, auto: { owner: b.id }, onChange: (v, { final }) => { if (final && same(busOf(b.id)?.volume, v)) return; editBus(b.id, `Volume ${b.name}`, (bb) => { bb.volume = v; }, !final); } });

    // spacer keeps faders aligned with track strips that have sends
    const el = h('div.mx-strip.mx-bus', { dataset: { id: b.id } },
      head, inserts, p.buses.length ? h('div.mx-sends.mx-sends-spacer') : null, pan.el, h('div.mx-btns', mute), fad.area, h('div.mx-foot', fad.readout, fad.peakEl));
    return { kind: 'bus', id: b.id, el, pan: pan.knob, panVal: pan.panVal, mute, setVolume: fad.setVolume, meterState: fad.meterState, reset: fad.reset };
  }

  async function deleteBus(busId) {
    const b = store.get().buses.find((x) => x.id === busId);
    if (!b) return;
    const users = store.get().tracks.filter((t) => t.sends?.[busId] > 0).length;
    if (users && !(await confirmDialog(`Delete “${b.name}”?`, `${users} track${users > 1 ? 's send' : ' sends'} to this bus. The sends will be removed too (undo restores everything).`))) return;
    store.transact(`Delete bus ${b.name}`, (p) => {
      p.buses = p.buses.filter((x) => x.id !== busId);
      for (const t of p.tracks) if (t.sends) delete t.sends[busId];
    });
    const tgt = ui.get('deviceTarget');
    if (tgt?.kind === 'bus' && tgt.id === busId) ui.set({ deviceTarget: null });
  }

  function addBus(tpl) {
    const p = store.get();
    let name = tpl.name;
    let n = 2;
    while (p.buses.some((b) => b.name === name)) name = `${tpl.name} ${n++}`;
    const bus = createBus(name, tpl.fx());
    store.transact(`Add bus ${name}`, (pp) => { pp.buses.push(bus); });
    if (!prefs.showBuses) { prefs.showBuses = true; savePrefs(); render(true); }
    app.toast?.(`Added “${name}” — turn up its send knob on any track`, { level: 'success' });
    return bus;
  }

  function busMenuItems() {
    return [{ header: 'Add return bus' }, ...BUS_TEMPLATES.map((tpl) => ({ label: tpl.label, icon: tpl.fx().length ? 'layers' : 'plus', onClick: () => addBus(tpl) }))];
  }

  // ---------------------------------------------------------------- master strip
  function masterStrip(p) {
    const get = (pp) => pp.master;
    const head = h('div.mx-head.master', { title: 'Master output — click to edit the master effect chain' }, h('div.mx-color'), h('div.mx-name', 'Master'), h('div.mx-sub', icon('volume', 11), h('span', 'Stereo out')));
    head.addEventListener('click', () => openChain('master', 'master'));
    const inserts = insertsSection('master', 'master', p.master.fx || [], get);
    const spec = h('canvas.mx-spectrum', { title: 'Spectrum analyser (20 Hz – 20 kHz)' });
    const rmsEl = h('div.mx-loud-val', '−∞');
    const pkEl = h('div.mx-loud-val', '−∞');
    const balEl = h('div.mx-loud-val', 'C');
    const loud = h('div.mx-loud',
      h('div.mx-loud-cell', { title: 'Short-term RMS level (≈ loudness). Most mixes sit around −14…−8 dB RMS.' }, h('span', 'RMS'), rmsEl),
      h('div.mx-loud-cell', { title: 'Momentary peak level (dBFS)' }, h('span', 'Peak'), pkEl),
      h('div.mx-loud-cell', { title: 'Left/right balance of the output' }, h('span', 'Bal'), balEl));
    const fad = faderSection({ value: p.master.volume, big: true, title: 'Master volume', auto: { owner: 'master' }, onChange: (v, { final }) => { if (final && same(store.get().master.volume, v)) return; editMaster('Master volume', (m) => { m.volume = v; }, !final); } });
    const el = h('div.mx-strip.mx-master', head, inserts, h('div.mx-analysis', spec, loud), fad.area, h('div.mx-foot', fad.readout, fad.peakEl));
    return { kind: 'master', id: 'master', el, setVolume: fad.setVolume, meterState: fad.meterState, reset: fad.reset, spec, rmsEl, pkEl, balEl, rms: -90 };
  }

  function resetAllPeaks() { for (const s of strips.values()) s.reset(); }

  // ---------------------------------------------------------------- auto-mix assist
  const GAIN_DB = { drums: -5, perc: -11, bass: -7, chords: -11, pad: -14, lead: -8, arp: -12, vocal: -6, fx: -16, code: -10, audio: -9, other: -10 };
  const PAN_WIDTH = { chords: 0.4, pad: 0.5, arp: 0.6, perc: 0.35, fx: 0.7, lead: 0.15, vocal: 0.1, code: 0.3, audio: 0.3, other: 0.35 };
  const REVERB_SEND = { pad: 0.35, chords: 0.22, lead: 0.18, arp: 0.25, vocal: 0.2, perc: 0.12, drums: 0.06, fx: 0.4, code: 0.15, audio: 0.1, other: 0.15, bass: 0 };
  const DELAY_SEND = { lead: 0.18, arp: 0.22, vocal: 0.15, fx: 0.25, chords: 0.08, perc: 0.06 };

  function findOrCreateBus(p, fxType, re, tpl) {
    let b = p.buses.find((x) => x.fx?.some((f) => f.type === fxType)) || p.buses.find((x) => re.test(x.name));
    if (!b) { b = createBus(tpl.name, tpl.fx()); p.buses.push(b); }
    return b;
  }

  const assist = {
    gainStage() {
      store.transact('Auto-mix: gain stage by role', (p) => {
        for (const t of p.tracks) t.volume = +dbToGain(GAIN_DB[trackRole(t)] ?? -10).toFixed(4);
        p.master.volume = 0.9;
      });
      app.toast?.('Gain-staged every track by role (drums & bass loudest, pads & FX tucked in). Ctrl+Z to undo.', { level: 'success' });
    },
    spreadPans() {
      let side = 1;
      let n = 0;
      store.transact('Auto-mix: spread pans', (p) => {
        for (const t of p.tracks) {
          const role = trackRole(t);
          if (role === 'bass' || role === 'drums') { t.pan = 0; continue; }
          const w = PAN_WIDTH[role] ?? 0.35;
          t.pan = +(side * w * (n % 4 < 2 ? 1 : 0.7)).toFixed(2);
          side = -side; n++;
        }
      });
      app.toast?.(`Spread ${n} track${n === 1 ? '' : 's'} across the stereo field; bass & drums stay centered.`, { level: 'success' });
    },
    reverbSends() {
      store.transact('Auto-mix: reverb sends by role', (p) => {
        const bus = findOrCreateBus(p, 'reverb', /reverb|verb|hall|room|plate/i, BUS_TEMPLATES[0]);
        for (const t of p.tracks) {
          const amt = REVERB_SEND[trackRole(t)] ?? 0.15;
          if (amt > 0) t.sends[bus.id] = amt; else delete t.sends[bus.id];
        }
      });
      app.toast?.('Added reverb sends by role (pads & FX wettest, bass dry).', { level: 'success' });
    },
    delaySends() {
      store.transact('Auto-mix: delay throws', (p) => {
        const bus = findOrCreateBus(p, 'delay', /delay|echo/i, BUS_TEMPLATES[2]);
        for (const t of p.tracks) {
          const amt = DELAY_SEND[trackRole(t)];
          if (amt) t.sends[bus.id] = amt;
        }
      });
      app.toast?.('Added delay throws to leads, arps and FX.', { level: 'success' });
    },
    resetFaders() { store.transact('Auto-mix: reset all faders', (p) => { for (const t of p.tracks) t.volume = 0.8; for (const b of p.buses) b.volume = 0.8; }); },
    centerPans() { store.transact('Auto-mix: center all pans', (p) => { for (const t of p.tracks) t.pan = 0; }); },
    clearSends() { store.transact('Auto-mix: clear all sends', (p) => { for (const t of p.tracks) t.sends = {}; }); },
    unmuteAll() { store.transact('Auto-mix: unmute & unsolo all', (p) => { for (const t of p.tracks) { t.mute = false; t.solo = false; } for (const b of p.buses) b.mute = false; }); },
    full() {
      store.transact('Auto-mix: full assist', (p) => {
        const rev = findOrCreateBus(p, 'reverb', /reverb|verb|hall|room|plate/i, BUS_TEMPLATES[0]);
        const del = findOrCreateBus(p, 'delay', /delay|echo/i, BUS_TEMPLATES[2]);
        let side = 1;
        for (const t of p.tracks) {
          const role = trackRole(t);
          t.volume = +dbToGain(GAIN_DB[role] ?? -10).toFixed(4);
          if (role === 'bass' || role === 'drums') t.pan = 0;
          else { t.pan = +(side * (PAN_WIDTH[role] ?? 0.35)).toFixed(2); side = -side; }
          const r = REVERB_SEND[role] ?? 0.15;
          if (r > 0) t.sends[rev.id] = r; else delete t.sends[rev.id];
          if (DELAY_SEND[role]) t.sends[del.id] = DELAY_SEND[role];
        }
        if (!p.master.fx.some((f) => f.type === 'limiter')) p.master.fx.push(createEffect('limiter', { threshold: -1 }));
      });
      app.toast?.('Auto-mix applied: levels, panning, reverb & delay sends and a master limiter. Ctrl+Z undoes it in one step.', { level: 'success' });
    },
  };

  function assistMenuItems() {
    const none = !store.get().tracks.length;
    return [
      { header: 'Auto-mix assist' },
      { label: 'Full auto-mix (levels + pans + sends)', icon: 'sparkles', disabled: none, onClick: assist.full },
      '-',
      { label: 'Levels', icon: 'sliders', submenu: [
        { label: 'Gain stage by role (≈ −6 dB headroom)', disabled: none, onClick: assist.gainStage },
        { label: 'Reset all faders', onClick: assist.resetFaders },
        { label: 'Unmute & unsolo everything', onClick: assist.unmuteAll },
      ] },
      { label: 'Panning', icon: 'headphones', submenu: [
        { label: 'Spread pans (bass & drums stay center)', disabled: none, onClick: assist.spreadPans },
        { label: 'Center all pans', onClick: assist.centerPans },
      ] },
      { label: 'Sends', icon: 'layers', submenu: [
        { label: 'Add reverb sends by role', disabled: none, onClick: assist.reverbSends },
        { label: 'Add delay throws (leads, arps, FX)', disabled: none, onClick: assist.delaySends },
        { label: 'Clear all sends', onClick: assist.clearSends },
      ] },
    ];
  }

  // ---------------------------------------------------------------- meters (one rAF loop)
  let raf = 0;
  let frame = 0;
  let needFit = true;
  const ro = new ResizeObserver(() => { needFit = true; });
  ro.observe(body);
  let specBins = null;
  let timeBuf = null;
  let meterColors = null;

  function readMeter(id) {
    try { return engine.ctx ? engine.getMeter?.(id) || null : null; } catch { return null; }
  }

  function drawMeter(st, lv, now) {
    if (!st.fit || needFit) st.fit = fitCanvas(st.canvas);
    const { ctx, w, h: H } = st.fit;
    ctx.clearRect(0, 0, w, H);
    const gap = 1;
    const bw = (w - gap) / 2;
    const levels = [lv.l || 0, lv.r ?? lv.l ?? 0];
    for (let i = 0; i < 2; i++) {
      const v = levels[i];
      const n = meterPos(v);
      // smooth fall-off
      const prev = st[i ? 'r' : 'l'];
      const shown = n >= prev ? n : Math.max(n, prev - 0.025);
      st[i ? 'r' : 'l'] = shown;
      const x = i * (bw + gap);
      ctx.fillStyle = meterColors.bg;
      ctx.fillRect(x, 0, bw, H);
      if (shown > 0) {
        ctx.fillStyle = meterColors.grad(ctx, H);
        ctx.fillRect(x, H - shown * H, bw, shown * H);
      }
      if (n > st.hold[i] || now - st.holdT[i] > 1500) {
        st.hold[i] = n > st.hold[i] ? n : Math.max(n, st.hold[i] - 0.01);
        if (n >= st.hold[i]) st.holdT[i] = now;
      }
      if (st.hold[i] > 0.01) {
        ctx.fillStyle = st.hold[i] > meterPos(1) ? '#ff4d5e' : meterColors.hold;
        ctx.fillRect(x, H - st.hold[i] * H, bw, 1.5);
      }
      if (v > st.peakMax) {
        st.peakMax = v;
        st.peakEl.textContent = fmtDb(v);
        st.peakEl.classList.toggle('hot', v >= 1);
      }
      if (v >= 0.999 && !st.clip) { st.clip = true; st.clipLed.classList.add('on'); }
    }
    // 0 dB line
    const z = H - meterPos(1) * H;
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(0, z, w, 1);
  }

  function drawSpectrum(m) {
    const an = (() => { try { return engine.ctx ? engine.getAnalyser?.() : null; } catch { return null; } })();
    if (!m.specFit || needFit) m.specFit = fitCanvas(m.spec);
    const { ctx, w, h: H } = m.specFit;
    ctx.clearRect(0, 0, w, H);
    // grid
    ctx.fillStyle = meterColors.grid;
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log10(f / 20) / 3) * w;
      ctx.fillRect(x, 0, 1, H);
    }
    if (!an) { m.rmsEl.textContent = '−∞'; return; }
    if (!specBins || specBins.length !== an.frequencyBinCount) specBins = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(specBins);
    const sr = an.context.sampleRate;
    const nb = Math.max(16, Math.floor(w / 4));
    const binHz = sr / an.fftSize;
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, meterColors.accent2);
    grad.addColorStop(1, meterColors.accent);
    ctx.fillStyle = grad;
    for (let i = 0; i < nb; i++) {
      const f0 = 20 * Math.pow(1000, i / nb), f1 = 20 * Math.pow(1000, (i + 1) / nb);
      const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
      let mx = 0;
      for (let b = b0; b < b1 && b < specBins.length; b++) if (specBins[b] > mx) mx = specBins[b];
      const hh = (mx / 255) * H;
      ctx.fillRect((i / nb) * w + 0.5, H - hh, w / nb - 1, hh);
    }
    // RMS (approximate loudness) from time-domain data
    if (!timeBuf || timeBuf.length !== an.fftSize) timeBuf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const rmsDb = sum > 0 ? 10 * Math.log10(sum / timeBuf.length) : -90;
    m.rms = m.rms * 0.85 + Math.max(-90, rmsDb) * 0.15;
    m.rmsEl.textContent = m.rms < -80 ? '−∞' : m.rms.toFixed(1);
    m.rmsEl.classList.toggle('hot', m.rms > -6);
  }

  function readColors() {
    const cs = getComputedStyle(el);
    const accent = cs.getPropertyValue('--accent').trim() || '#7c5cff';
    const accent2 = cs.getPropertyValue('--accent-2').trim() || '#00d4ff';
    const bg = cs.getPropertyValue('--mx-meter-bg').trim() || '#06070a';
    let gradCache = null, gradH = 0;
    meterColors = {
      accent, accent2, bg, hold: cs.getPropertyValue('--text').trim() || '#ddd', grid: cs.getPropertyValue('--grid-beat').trim() || 'rgba(255,255,255,.08)',
      grad(ctx, H) {
        if (gradCache && gradH === H && gradCache.ctx === ctx) return gradCache.g;
        const g = ctx.createLinearGradient(0, H, 0, 0);
        g.addColorStop(0, '#1fae63'); g.addColorStop(0.62, '#2fd17a'); g.addColorStop(0.8, '#d6e04a'); g.addColorStop(meterPos(0.7), '#ffb547'); g.addColorStop(meterPos(1), '#ff4d5e'); g.addColorStop(1, '#ff4d5e');
        gradCache = { ctx, g }; gradH = H;
        return g;
      },
    };
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    frame++;
    if (frame % 2) return; // ~30 fps is plenty for meters
    if (!meterColors) readColors();
    const now = performance.now();
    const live = !!engine.ctx;
    for (const s of strips.values()) {
      const lv = live ? readMeter(s.id) : null;
      // skip redrawing idle meters once they have decayed to zero
      const st = s.meterState;
      if (!lv && st.l === 0 && st.r === 0 && st.hold[0] === 0 && st.hold[1] === 0 && st.fit && !needFit) continue;
      drawMeter(st, lv || { l: 0, r: 0 }, now);
      if (!lv && st.l < 0.002 && st.r < 0.002) { st.l = 0; st.r = 0; if (now - st.holdT[0] > 1500) st.hold = [0, 0]; }
      if (s.kind === 'master' && lv) {
        s.pkEl.textContent = fmtDb(Math.max(lv.l || 0, lv.r || 0));
        const bal = (lv.r || 0) - (lv.l || 0);
        const sum = (lv.r || 0) + (lv.l || 0);
        s.balEl.textContent = sum < 0.001 ? 'C' : fmtPan(clamp(bal / sum, -1, 1));
      }
    }
    const m = strips.get('master');
    if (m && (frame % 4 === 0 || needFit)) drawSpectrum(m);
    needFit = false;
  }

  function startLoop() { if (!raf) { meterColors = null; needFit = true; raf = requestAnimationFrame(tick); } }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  // ---------------------------------------------------------------- subscriptions
  app.subscribe((r) => {
    if (!visible) { if (r.project) dirty = true; return; }
    if ('theme' in r.ui) { meterColors = null; needFit = true; }
    if (r.project || dirty) render();
    else if ('selectedTrackId' in r.ui || 'deviceTarget' in r.ui) update(store.get());
  });
  store.on?.('load', () => { lastSig = ''; resetAllPeaks(); });

  return {
    el,
    show() { visible = true; render(dirty); startLoop(); },
    hide() { visible = false; stopLoop(); },
    assist, // exposed for automation/tests
  };
}
