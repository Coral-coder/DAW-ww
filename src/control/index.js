// Hardware control for daW³ (browser): wires the Node-safe modules in src/control/* to the app.
//   · Web MIDI device manager (Preferences → MIDI): hot-plug, per-device enable, routing to selected / armed
//     tracks with channel filters, velocity curves, transpose, sustain, MIDI thru, MPE per-note expression.
//   · MIDI learn for every automatable control (right-click → "MIDI learn…", or the header MIDI button's learn
//     mode that highlights every learnable control). Mappings live in project.controlMappings (+ a global
//     controller template in localStorage). Mapped moves are ordinary store edits, so the automation recorder
//     records them while armed, and they override (Ableton-style) lanes while not recording.
//   · Control surfaces: Mackie Control (+XT) / HUI, and pad grids (Launchpad / APC / Push) for Scenes + Setlist.
//   · Sync: MIDI clock out / in (24 ppqn, SPP), MTC out, Ableton Link through tools/link-bridge.
//   · Command palette (Ctrl/Cmd+K) + rebindable shortcuts (commands live in ./commands.js).
// app.control exposes the pieces (devices, mappings, router, surfaces, grids, clock, link) for scripting/tests.
import { h, icon } from '../ui/dom.js';
import { toast, contextMenu, touchStart, touchEnd } from '../ui/components.js';
import { laneLabel, targetGroups } from '../ui/automation-targets.js';
import { automationOwner, MIXER_TARGETS, toNorm } from '../core/automation.js';
import { beatsPerBar } from '../core/model.js';
import { MidiDeviceManager } from './devices.js';
import { MappingEngine, sourceKey } from './mapping.js';
import { sourceLabel } from './midi.js';
import { NoteRouter } from './router.js';
import { SurfaceController, faderToGain } from './surface.js';
import { GridController } from './grid.js';
import { MidiClockOut, MidiClockIn, MtcOut } from './clock.js';
import { tempoMapFor } from '../time/tempo-map.js';
import { LinkClient, LINK_DEFAULT_URL } from './link-client.js';
import { applyNorm, applyLaneValue, targetNorm, targetSteps, resolveOwner } from './targets.js';
import { flattenMenu } from './commands.js';
import { formatChord } from './shortcuts.js';

const SETTINGS_KEY = 'daw3-control';
const DEFAULT_SETTINGS = {
  template: [], // global controller-template mappings
  surfaces: [], // [{ id, kind: 'mcu'|'mcu-xt'|'hui', input, output, enabled, offset }]
  grids: [], // [{ id, layout, input, output, enabled, mode: 'auto'|'session'|'setlist' }]
  thru: null, // MIDI thru output name
  sync: { clockOut: [], clockIn: null, follow: true, followTransport: true, mtcOut: null, mtcFps: 25, offsetMs: 0 },
  link: { enabled: false, url: LINK_DEFAULT_URL },
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* corrupt / blocked */ }
  return { ...DEFAULT_SETTINGS, ...s, sync: { ...DEFAULT_SETTINGS.sync, ...(s.sync || {}) }, link: { ...DEFAULT_SETTINGS.link, ...(s.link || {}) } };
}

export function installControl(app) {
  const { store, ui, engine, actions } = app;
  const settings = loadSettings();
  const save = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* quota */ } };
  const now = () => performance.now();
  const devices = new MidiDeviceManager({ requestAccess: navigator.requestMIDIAccess ? (o) => navigator.requestMIDIAccess(o) : null });
  const bus = { listeners: new Set(), emit() { for (const f of this.listeners) try { f(); } catch (e) { console.warn(e); } } };

  // ------------------------------------------------------------------ writing targets
  const laneOf = (p, owner, target) => automationOwner(p, owner)?.automation?.find((l) => l.target === target) || null;
  let toldOverride = false;
  /** Write a controller value into the store: recorded by the automation recorder while armed, overrides lanes otherwise. */
  function writeTarget(owner, target, fn, label = 'MIDI control') {
    const p = store.get();
    const lane = laneOf(p, owner, target);
    const recording = ui.get('autoArm') && engine.isPlaying && p.mode === 'song';
    const override = !recording && lane && lane.enabled !== false && !lane.overridden && lane.points?.length;
    store.transact(label, (pp) => {
      fn(pp);
      if (override) { const l = laneOf(pp, owner, target); if (l) l.overridden = true; }
    }, { coalesce: true });
    if (override && !toldOverride) {
      toldOverride = true;
      toast(`"${laneLabel(store.get(), owner, target)}" now follows your controller instead of its automation lane — ↺ (next to A●) re-enables it. Arm A● to record the moves instead.`, { level: 'info', timeout: 6000 });
    }
  }
  const writeNorm = (owner, target, n) => writeTarget(owner, target, (pp) => applyNorm(pp, owner, target, n));
  const writeLane = (owner, target, v) => writeTarget(owner, target, (pp) => applyLaneValue(pp, owner, target, v));
  // fake "held control" so TOUCH-mode automation knows when a motor fader / touch strip is released
  const touchEls = new Map();
  function touch(owner, target, on) {
    const key = `${owner}|${target}`;
    if (on && !touchEls.has(key)) { const el = { dataset: { autoOwner: owner, autoTarget: target } }; touchEls.set(key, el); touchStart(el); }
    else if (!on && touchEls.has(key)) { const el = touchEls.get(key); touchEls.delete(key); touchEnd(el); }
  }

  // ------------------------------------------------------------------ mappings (MIDI learn)
  const ctx = () => ({ selectedTrackId: ui.get('selectedTrackId') });
  const resolve = (t) => ({ owner: resolveOwner(store.get(), t.owner, ctx()), target: t.target });
  const registry = () => app.commands;
  const mappings = new MappingEngine({
    getNorm(t) { const r = resolve(t); return r.owner ? targetNorm(store.get(), r.owner, r.target) : null; },
    steps(t) { const r = resolve(t); return r.owner ? targetSteps(store.get(), r.owner, r.target) : null; },
    setNorm(t, n) { const r = resolve(t); if (r.owner) writeNorm(r.owner, r.target, n); },
    runCommand(id, { pressed }) { if (pressed) registry()?.get(id)?.run(); },
  });
  mappings.setTemplate(settings.template);
  mappings.setProjectMappings(store.get().controlMappings || []);
  let syncing = false;
  const projectJson = () => JSON.stringify(mappings.project);
  mappings.on('change', ({ scope, auto } = {}) => {
    if (scope === 'template') { settings.template = mappings.template; save(); }
    else {
      const list = JSON.parse(projectJson());
      syncing = true;
      try { store.transact('MIDI mapping', (p) => { p.controlMappings = list; }, auto ? { undo: false } : {}); } finally { syncing = false; }
    }
    markMapped();
    bus.emit();
  });
  const resyncFromStore = () => {
    const list = store.get().controlMappings || [];
    if (JSON.stringify(list) !== projectJson()) { mappings.setProjectMappings(list); markMapped(); bus.emit(); }
  };
  store.on('change', (_p, label) => { if (!syncing && (label === 'undo' || label === 'redo' || label === 'load' || label === 'MIDI mapping')) resyncFromStore(); });
  store.on('load', () => { resyncFromStore(); mappings.resetTakeover(); });
  mappings.on('pickup', ({ mapping, hw, cur }) => app.setStatus?.(`${labelOfTarget(mapping.target)}: move the control ${hw < cur ? 'up' : 'down'} to pick up the value (soft takeover)`));

  function labelOfTarget(t) {
    if (t.command) return `Command: ${registry()?.get(t.command)?.label || t.command}`;
    const r = resolve(t);
    if (!r.owner) return `${t.owner} › ${t.target}`;
    const base = laneLabel(store.get(), r.owner, r.target);
    return t.owner?.startsWith('@') ? `${base} (${t.owner === '@sel' ? 'selected track' : 'track ' + t.owner.slice(2)})` : base;
  }

  // ------------------------------------------------------------------ note routing
  let toldNoTarget = false;
  const router = new NoteRouter({
    targets(s) {
      const p = store.get();
      const inst = p.tracks.filter((t) => t.type === 'instrument');
      const sel = inst.filter((t) => t.id === ui.get('selectedTrackId')).map((t) => t.id);
      const armed = inst.filter((t) => t.arm).map((t) => t.id);
      let ids;
      if (s.target === 'selected') ids = sel;
      else if (s.target === 'armed') ids = armed;
      else if (s.target && s.target !== 'auto') ids = inst.some((t) => t.id === s.target) ? [s.target] : [];
      else ids = armed.length ? armed : sel;
      if (!ids.length && !toldNoTarget) { toldNoTarget = true; toast('MIDI notes are arriving — select (or arm ●) an instrument track to play it.', { level: 'info' }); }
      return ids;
    },
    noteOn: (id, pitch, vel) => actions.liveNoteOn(pitch, vel, id),
    noteOff: (id, pitch, expr) => actions.liveNoteOff(pitch, id, expr),
    pitchBend: (id, v) => engine.pitchBend?.(id, v),
    expression: (id, pitch, x) => engine.noteExpression?.(id, pitch, x),
    thru: (data) => { if (settings.thru) devices.send(settings.thru, data); },
  });

  // ------------------------------------------------------------------ sync
  const clockOut = new MidiClockOut({ send: (d, ts) => { for (const n of settings.sync.clockOut || []) devices.send(n, d, ts); } });
  const mtcOut = new MtcOut({ send: (d, ts) => { if (settings.sync.mtcOut) devices.send(settings.sync.mtcOut, d, ts); }, fps: settings.sync.mtcFps });
  const clockIn = new MidiClockIn();
  const pos = () => (engine.getAudiblePosition ? engine.getAudiblePosition() : engine.getPosition());
  const syncStart = () => {
    const p = store.get();
    const t0 = now() + (+settings.sync.offsetMs || 0);
    // tempo map (src/time): clock ticks follow ramps / changes; MTC runs on the map's seconds
    const map = tempoMapFor(p, p.mode);
    if (settings.sync.clockOut?.length) clockOut.start(Math.max(0, pos()), map.bpmAt(Math.max(0, pos())), t0, map);
    if (settings.sync.mtcOut) { mtcOut.fps = [24, 25, 30].includes(+settings.sync.mtcFps) ? +settings.sync.mtcFps : 25; mtcOut.start(map.secAt(Math.max(0, pos())), t0); }
  };
  const syncStop = () => { clockOut.stop(now()); mtcOut.stop(); };
  engine.on?.('state', ({ playing }) => {
    if (playing) syncStart(); else syncStop();
    link.sendPlay(playing);
  });
  let lastBpm = store.get().bpm;
  let lastMap = tempoMapFor(store.get(), store.get().mode);
  store.on('change', (p, label) => {
    const map = tempoMapFor(p, p.mode);
    if (p.bpm !== lastBpm || map !== lastMap) {
      lastBpm = p.bpm;
      lastMap = map;
      clockOut.setTempo(map.bpmAt(Math.max(0, pos())), now(), map);
      if (label !== 'Tempo (Link)' && label !== 'Tempo (MIDI clock)' && map.isConstant) link.sendTempo(p.bpm);
    }
  });
  // tempo map playback: Link peers follow the tempo at the playhead
  engine.on?.('tempo', (bpm) => { if (!lastMap.isConstant) link.sendTempo(bpm); });
  setInterval(() => {
    // the playhead jumped (seek, loop wrap in song mode): Stop + SPP + Continue so slaves follow
    if (clockOut.running && engine.isPlaying) {
      const t = now() + (+settings.sync.offsetMs || 0);
      if (Math.abs(clockOut.beatAt(t) - pos()) > 0.25) { const p = store.get(), map = tempoMapFor(p, p.mode); clockOut.stop(t); clockOut.start(Math.max(0, pos()), map.bpmAt(Math.max(0, pos())), t, map); }
    }
    clockOut.pump(now()); mtcOut.pump(now());
  }, 25);
  clockIn.on('tempo', (bpm) => {
    if (!settings.sync.follow) return;
    const v = Math.round(bpm * 10) / 10;
    if (Math.abs(store.get().bpm - v) >= 0.1) store.transact('Tempo (MIDI clock)', (p) => { p.bpm = v; }, { undo: false });
  });
  clockIn.on('start', () => { if (!settings.sync.followTransport) return; actions.setPosition(0); if (!engine.isPlaying) actions.play(); });
  clockIn.on('continue', () => { if (settings.sync.followTransport && !engine.isPlaying) actions.play(); });
  clockIn.on('stop', () => { if (settings.sync.followTransport && engine.isPlaying) actions.togglePlay(); });
  clockIn.on('position', (b) => { if (settings.sync.followTransport) actions.setPosition(b); });

  const link = new LinkClient({
    bpm: () => store.get().bpm,
    setBpm: (b) => store.transact('Tempo (Link)', (p) => { p.bpm = b; }, { undo: false }),
    playing: () => !!engine.isPlaying,
    beat: () => engine.getPosition(),
    play: () => actions.play(),
    stop: () => { if (engine.isPlaying) actions.togglePlay(); },
    setBeat: (b) => actions.setPosition(b),
    now,
  }, {
    url: settings.link.url,
    // Mac app: Ableton Link is built in (the daw3-link process) — started on connect, no bridge to run
    start: typeof window !== 'undefined' && window.daw3Native?.link ? () => window.daw3Native.link.start().then((r) => r?.url) : null,
  });
  link.on('status', () => bus.emit());
  if (settings.link.enabled) link.connect(settings.link.url);

  // ------------------------------------------------------------------ control surfaces + grids
  const meterNorm = (id) => { const m = engine.ctx ? engine.getMeter(id) : null; const v = m ? Math.max(m.l, m.r) : 0; return v > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(v) + 60) / 60)) : 0; };
  const surfaceHost = {
    strips() {
      const p = store.get();
      const sel = ui.get('selectedTrackId');
      return [...p.tracks.map((t) => ({ id: t.id, name: t.name, volume: t.volume ?? 0.8, pan: t.pan || 0, mute: !!t.mute, solo: !!t.solo, arm: !!t.arm, selected: t.id === sel, kind: 'track' })),
        ...(p.buses || []).map((b) => ({ id: b.id, name: b.name, volume: b.volume ?? 0.8, pan: b.pan || 0, mute: !!b.mute, solo: false, arm: false, selected: false, kind: 'bus' }))];
    },
    master: () => ({ volume: store.get().master.volume }),
    setVolume: (id, g) => writeLane(id, 'volume', g),
    setPan: (id, v) => writeLane(id, 'pan', v),
    toggle(id, k) {
      const o = automationOwner(store.get(), id);
      if (!o) return;
      if (k === 'mute') writeLane(id, 'mute', o.mute ? 0 : 1);
      else if (store.get().tracks.includes(o)) actions.updateTrack(id, (t) => { t[k] = !t[k]; }, k === 'arm' ? 'Arm' : 'Solo');
    },
    select: (id) => { if (store.get().tracks.some((t) => t.id === id)) actions.selectTrack(id); },
    touch: (id, target, on) => touch(id, target, on),
    sends: (id) => { const p = store.get(); const t = p.tracks.find((x) => x.id === id); return (p.buses || []).map((b) => ({ busId: b.id, name: b.name, value: t?.sends?.[b.id] || 0 })); },
    setSend: (id, busId, v) => { if (store.get().tracks.some((t) => t.id === id)) writeLane(id, `send:${busId}`, v); },
    params(id) {
      const p = store.get();
      const out = [];
      for (const g of targetGroups(p, id)) {
        if (g.kind !== 'inst' && g.kind !== 'fx') continue;
        for (const it of g.items) {
          if (it.target.startsWith('fxen:')) continue;
          out.push({ label: it.label, get norm() { return targetNorm(store.get(), id, it.target) ?? 0; }, set: (n) => writeNorm(id, it.target, n) });
        }
      }
      return out;
    },
    transport: () => { const p = store.get(); return { playing: !!engine.isPlaying, recording: !!ui.get('recording'), loop: !!p.loop.enabled, click: !!p.metronome, autoArm: !!ui.get('autoArm') }; },
    command(name) {
      const p = store.get();
      const bpb = beatsPerBar(p);
      switch (name) {
        case 'play': if (!engine.isPlaying) actions.play(); return;
        case 'stop': actions.stop(); return;
        case 'record': actions.toggleRecord(); return;
        case 'rewind': actions.setPosition(Math.max(0, Math.floor(engine.getPosition() / bpb - 1e-6) * bpb - (engine.isPlaying ? bpb : 0))); return;
        case 'forward': actions.setPosition(Math.floor(engine.getPosition() / bpb + 1e-6) * bpb + bpb); return;
        case 'loop': store.transact('Toggle loop', (pp) => { pp.loop.enabled = !pp.loop.enabled; }); return;
        case 'click': store.transact('Toggle metronome', (pp) => { pp.metronome = !pp.metronome; }, { undo: false }); return;
        case 'undo': actions.undo(); return;
        case 'save': actions.saveProject(); return;
        case 'autoArm': ui.set({ autoArm: !ui.get('autoArm') }); return;
        default: return;
      }
    },
    jog: (d) => actions.setPosition(Math.max(0, engine.getPosition() + d * 0.25)),
    position() {
      const p = store.get();
      const b = Math.max(0, engine.getPosition());
      const bpb = beatsPerBar(p);
      const inBar = b % bpb;
      return { bar: Math.floor(b / bpb) + 1, beat: Math.floor(inBar) + 1, sixteenth: Math.floor((inBar % 1) * 4) + 1, tick: Math.floor(((inBar * 4) % 1) * 240) };
    },
    meter: meterNorm,
  };
  surfaceHost.setVolume = (id, g) => (id === 'master' ? writeLane('master', 'volume', g) : writeLane(id, 'volume', g));

  const gridHost = {
    tracks: () => store.get().tracks.filter((t) => t.type === 'instrument').map((t) => ({ id: t.id, activePatternId: t.activePatternId })),
    scenes: () => store.get().scenes || [],
    playing: () => !!engine.isPlaying,
    launchSlot(trackId, pid) { if (!store.get().patterns[pid]) return; actions.selectPattern(pid); startPatternPlayback(); },
    launchScene(id) {
      const v = app.views?.session;
      if (v?.launchScene) { v.launchScene(id); return; }
      const sc = store.get().scenes.find((s) => s.id === id);
      if (!sc) return;
      store.transact('Launch scene', (p) => { for (const t of p.tracks) if (t.type === 'instrument') { const pid = sc.slots?.[t.id]; t.activePatternId = pid && p.patterns[pid] ? pid : null; } }, { undo: false });
      startPatternPlayback();
    },
    stopTrack: (id) => store.transact('Stop track', (p) => { const t = p.tracks.find((x) => x.id === id); if (t) t.activePatternId = null; }, { undo: false }),
    layers() {
      const st = app.setlist?.state;
      if (!st) return [];
      const p = store.get();
      return st.layers.map((l) => { const t = p.tracks.find((x) => x.id === l.id); return { id: l.id, mute: !!t?.mute, solo: !!t?.solo, locked: !!l.lock }; });
    },
    layerAction(id, a) {
      const r = app.setlist;
      if (!r) return;
      if (a === 'mute' || a === 'solo') actions.updateTrack(id, (t) => { t[a] = !t[a]; }, a === 'mute' ? 'Mute' : 'Solo');
      else if (a === 'regenerate') r.regenerate(id);
      else if (a === 'next') r.nextSoundNow(id);
      else if (a === 'lock') { const l = r.layer(id); if (l) r.setLayer(id, { lock: !l.lock }); }
    },
    sections() {
      const r = app.setlist;
      if (!r?.state) return [];
      const cur = r.phraseAt?.(engine.getPosition())?.section;
      return ['intro', 'groove', 'build', 'drop', 'breakdown'].map((id) => ({ id, label: id, current: cur === id, queued: r.state.queued === id }));
    },
    queueSection: (id) => app.setlist?.queueSection(id),
  };
  async function startPatternPlayback() {
    if (store.get().mode !== 'pattern') actions.setMode('pattern');
    if (!engine.isPlaying) { try { await actions.play(); } catch { /* toast shown by actions */ } }
  }

  const surfaces = new Map(); // config id -> { cfg, ctl }
  const grids = new Map();
  function buildControllers() {
    for (const { ctl } of surfaces.values()) try { ctl.blank(); } catch { /* port gone */ }
    surfaces.clear(); grids.clear();
    let xt = 0;
    for (const cfg of settings.surfaces) {
      if (!cfg.enabled || !cfg.input) continue;
      const offset = cfg.kind === 'mcu-xt' ? (cfg.offset ?? 8 * ++xt) : 0;
      const ctl = new SurfaceController({ kind: cfg.kind, host: surfaceHost, unitOffset: offset, send: (msgs) => devices.send(cfg.output, msgs) });
      surfaces.set(cfg.id, { cfg, ctl });
      if (devices.ready) ctl.connect();
    }
    for (const cfg of settings.grids) {
      if (!cfg.enabled || !cfg.input) continue;
      const ctl = new GridController({ layout: cfg.layout, host: gridHost, mode: 'session', send: (msgs) => devices.send(cfg.output, msgs) });
      grids.set(cfg.id, { cfg, ctl });
      if (devices.ready) ctl.refresh();
    }
  }
  const gridMode = (cfg) => (cfg.mode === 'session' || cfg.mode === 'setlist' ? cfg.mode : ui.get('view') === 'setlist' && app.setlist?.active ? 'setlist' : 'session');
  let meterTick = 0, pingTick = 0;
  setInterval(() => {
    if (!devices.ready) return;
    meterTick++;
    for (const { ctl } of surfaces.values()) {
      try {
        ctl.refresh();
        if (engine.isPlaying && meterTick % 2 === 0) ctl.meters();
        if (ctl.kind === 'hui' && ++pingTick % 16 === 0) ctl.send(ctl.proto.ping());
      } catch (e) { console.warn('[surface]', e); }
    }
    for (const { cfg, ctl } of grids.values()) { try { ctl.setMode(gridMode(cfg)); ctl.refresh(); } catch (e) { console.warn('[grid]', e); } }
  }, 60);

  // ------------------------------------------------------------------ MIDI in dispatch
  let activityTimer = 0;
  const activity = () => { midiBtn?.classList.add('ctl-activity'); clearTimeout(activityTimer); activityTimer = setTimeout(() => midiBtn?.classList.remove('ctl-activity'), 120); };
  devices.on('message', (name, data, ts) => {
    try {
      const st = data[0];
      if (st >= 0xf8 || st === 0xf2) { if (settings.sync.clockIn === name) clockIn.handle(data, ts); return; }
      if (st === 0xf0 || st === 0xf1) return; // SysEx / MTC in are not used
      activity();
      for (const { cfg, ctl } of surfaces.values()) if (cfg.input === name) { ctl.handle(data); return; }
      for (const { cfg, ctl } of grids.values()) if (cfg.input === name && ctl.handle(data)) return;
      const s = devices.inputSettings(name);
      if ((s.control || mappings.isLearning) && mappings.handle(name, data, ts)) return;
      router.handle(name, data, s, ts);
    } catch (e) { console.error('[midi-in]', e); }
  });
  devices.on('devices', () => { buildControllers(); bus.emit(); });
  setInterval(() => mappings.flushLearn(now()), 100);

  // controller feedback (LED rings / motor faders of learned controls)
  const fbCache = new Map();
  function feedback() {
    if (!devices.ready) return;
    for (const m of mappings.mappings) {
      if (!m.feedback || !m.source.device || m.target.command) continue;
      const out = devices.partnerOutput(m.source.device);
      if (!out) continue;
      const n = mappings.host.getNorm(m.target);
      if (n == null) continue;
      const bytes = mappings.feedbackBytes(m, n);
      const ser = JSON.stringify(bytes);
      if (fbCache.get(m.id) === ser) continue;
      fbCache.set(m.id, ser);
      if (bytes.length) devices.send(out, bytes);
    }
  }
  app.subscribe((r) => { if (r.project || 'selectedTrackId' in r.ui) feedback(); });

  async function openMidi({ quiet = false } = {}) {
    if (devices.ready) return true;
    if (!devices.supported) { if (!quiet) toast('Web MIDI is not available in this browser — use Chrome / Edge / Opera (or the desktop app).', { level: 'warn', timeout: 6000 }); return false; }
    try {
      await devices.open();
      buildControllers();
      try { localStorage.setItem('daw3-midi-on', '1'); } catch { /* */ }
      if (!quiet) {
        const n = devices.inputs().length;
        toast(n ? `MIDI ready: ${devices.inputs().map((i) => i.name).join(', ')}` : 'MIDI ready — no devices connected yet (plug one in any time).', { level: n ? 'success' : 'info' });
      }
      bus.emit();
      return true;
    } catch (e) {
      if (!quiet) toast('MIDI access was denied: ' + (e?.message || e), { level: 'error' });
      return false;
    }
  }
  // reopen silently on load when MIDI was used before (Chrome remembers the permission)
  try { if (localStorage.getItem('daw3-midi-on') === '1') setTimeout(() => openMidi({ quiet: true }), 400); } catch { /* */ }

  // ------------------------------------------------------------------ learn UI
  let learnMode = false;
  let learnEl = null;
  const banner = h('div.ctl-learn-banner.hidden');
  document.body.appendChild(banner);
  function setBanner(html) { banner.replaceChildren(...html); banner.classList.toggle('hidden', !html.length); }
  function bannerIdle() {
    if (!learnMode) { setBanner([]); return; }
    setBanner([h('b', 'MIDI learn'), h('span', ' — click any highlighted control, then move a knob / fader / button on your device. '), learnCloseBtn()]);
  }
  const learnCloseBtn = () => { const b = h('button.btn.small', { type: 'button' }, 'Done (Esc)'); b.addEventListener('click', () => setLearnMode(false)); return b; };
  function setLearnMode(on) {
    learnMode = !!on;
    document.body.classList.toggle('ctl-learn-mode', learnMode);
    midiBtn?.classList.toggle('on', learnMode);
    if (!learnMode) { mappings.cancelLearn(); learnEl?.classList.remove('ctl-learn-target'); learnEl = null; }
    else { openMidi(); markMapped(); }
    bannerIdle();
  }
  async function learn(owner, target, el, scope = 'project') {
    if (!(await openMidi())) return;
    learnEl?.classList.remove('ctl-learn-target');
    learnEl = el || null;
    learnEl?.classList.add('ctl-learn-target');
    const t = target ? { owner: scope === 'template' && owner !== 'master' && store.get().tracks.some((x) => x.id === owner) ? '@sel' : owner, target } : owner;
    mappings.startLearn(t, { scope });
    const lbl = labelOfTarget(t);
    setBanner([h('b', 'Learning: '), h('span', lbl), h('span', ' — move a control on your MIDI device. '), (() => { const b = h('button.btn.small', { type: 'button' }, 'Cancel'); b.addEventListener('click', () => { mappings.cancelLearn(); learnEl?.classList.remove('ctl-learn-target'); learnEl = null; bannerIdle(); }); return b; })()]);
  }
  mappings.on('learned', (m) => {
    learnEl?.classList.remove('ctl-learn-target');
    learnEl = null;
    const how = m.button ? ` (${m.button})` : m.mode !== 'absolute' ? ` (${m.mode.replace('relative-', 'relative ')}${m.detect ? ', detecting' : ''})` : '';
    toast(`Mapped ${sourceLabel(m.source)}${how} → ${labelOfTarget(m.target)}${m.scope === 'template' ? ' — saved in your controller template' : ''}`, { level: 'success', timeout: 4200 });
    setTimeout(bannerIdle, 50);
  });
  // learn-mode clicks pick a control instead of editing it
  const swallow = (e) => {
    if (!learnMode) return;
    const el = e.target?.closest?.('[data-auto-target]');
    if (!el || el.closest('.modal, .ctl-palette')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'pointerdown' && e.button === 0) learn(el.dataset.autoOwner, el.dataset.autoTarget, el);
  };
  for (const type of ['pointerdown', 'click', 'dblclick', 'mousedown']) document.addEventListener(type, swallow, true);
  document.addEventListener('wheel', (e) => { if (learnMode && e.target?.closest?.('[data-auto-target]')) { e.preventDefault(); e.stopPropagation(); } }, { capture: true, passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (mappings.isLearning) { mappings.cancelLearn(); learnEl?.classList.remove('ctl-learn-target'); learnEl = null; bannerIdle(); e.stopImmediatePropagation(); return; }
    if (learnMode) { setLearnMode(false); e.stopImmediatePropagation(); }
  }, true);

  /** Mark controls that have a mapping (title gets the source). */
  function markMapped() {
    const bySrc = new Map();
    for (const m of mappings.mappings) {
      if (m.target.command) continue;
      const r = resolve(m.target);
      if (!r.owner) continue;
      const k = `${r.owner}|${r.target}`;
      if (!bySrc.has(k)) bySrc.set(k, []);
      bySrc.get(k).push(sourceLabel(m.source));
    }
    for (const el of document.querySelectorAll('[data-auto-target]')) {
      const list = bySrc.get(`${el.dataset.autoOwner}|${el.dataset.autoTarget}`);
      el.classList.toggle('ctl-mapped', !!list);
      if (list) el.dataset.midi = list.join(', '); else delete el.dataset.midi;
    }
  }
  setInterval(markMapped, 700);
  ui.on('change', (c) => { if ('selectedTrackId' in c) markMapped(); });

  // right-click menu entries on every automatable control
  app.automationContextExtras = (owner, target, el) => {
    const items = ['-', { label: 'MIDI learn…', icon: 'piano', onClick: () => learn(owner, target, el) }];
    if (store.get().tracks.some((t) => t.id === owner)) items.push({ label: 'MIDI learn for the selected track (all projects)', icon: 'piano', onClick: () => learn(owner, target, el, 'template') });
    for (const m of mappings.mappings) {
      if (m.target.command) continue;
      const r = resolve(m.target);
      if (r.owner === owner && r.target === target) items.push({ label: `Remove MIDI mapping (${sourceLabel(m.source)}${m.scope === 'template' ? ', template' : ''})`, icon: 'x', onClick: () => mappings.remove(m.id) });
    }
    return items;
  };

  // ------------------------------------------------------------------ header buttons
  let midiBtn = null;
  const slot = document.querySelector('.ctl-slot');
  if (slot) {
    midiBtn = h('button.transport-btn.ctl-midi-btn', { type: 'button', title: `MIDI learn mode (${shortcutLabel('midi.learn')}): click any control, then move a knob on your MIDI controller. Right-click for MIDI devices, mappings, control surfaces and sync.` }, h('span', 'MIDI'), h('span.ctl-midi-dot'));
    midiBtn.addEventListener('click', () => setLearnMode(!learnMode));
    midiBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e, [
        { header: 'Hardware control' },
        { label: learnMode ? 'Leave MIDI learn mode' : 'MIDI learn mode', icon: 'piano', shortcut: shortcutLabel('midi.learn'), onClick: () => setLearnMode(!learnMode) },
        { label: 'MIDI devices…', icon: 'plug', onClick: () => openPrefs('midi') },
        { label: 'Mappings…', icon: 'sliders', onClick: () => openPrefs('mappings') },
        { label: 'Control surfaces & pad grids…', icon: 'grid', onClick: () => openPrefs('surfaces') },
        { label: 'Sync (MIDI clock, MTC, Link)…', icon: 'loop', onClick: () => openPrefs('sync') },
        { label: 'Keyboard shortcuts…', icon: 'keyboard', onClick: () => openPrefs('shortcuts') },
      ]);
    });
    const palBtn = h('button.icon-btn.ctl-palette-btn', { type: 'button', title: `Command palette (${shortcutLabel('palette.open')}) — every action, searchable` }, icon('search', 16));
    palBtn.addEventListener('click', () => openPalette());
    slot.append(midiBtn, palBtn);
  }

  function shortcutLabel(id) { return app.shortcuts?.label(id) || ''; }

  // ------------------------------------------------------------------ palette + prefs (lazy)
  function paletteEntries() {
    const out = [];
    for (const c of app.commands?.list() || []) if (c.palette !== false) out.push({ id: c.id, label: c.label, category: c.category, shortcut: shortcutLabel(c.id), run: () => c.run() });
    try { out.push(...flattenMenu(actions.mainMenuItems(), 'Menu')); } catch (e) { console.warn('[palette] menu', e); }
    try { out.push(...flattenMenu(actions.generateMenuItems(), 'Create')); } catch (e) { console.warn('[palette] create', e); }
    try { out.push(...flattenMenu(actions.addTrackMenuItems(), 'Add track')); } catch { /* */ }
    return out;
  }
  let paletteMod = null;
  async function openPalette() {
    paletteMod = paletteMod || (await import('./palette.js'));
    paletteMod.openPalette(app, paletteEntries());
  }
  async function openPrefs(tab) {
    const m = await import('./prefs.js');
    m.openPrefs(app, tab);
  }

  const api = {
    devices, mappings, router, clockOut, clockIn, mtcOut, link, surfaces, grids, settings,
    save, openMidi, openPrefs, openPalette, setLearnMode, learn, labelOfTarget, shortcutLabel, buildControllers,
    get learnMode() { return learnMode; },
    toggleLearnMode: () => setLearnMode(!learnMode),
    onChange: (fn) => { bus.listeners.add(fn); return () => bus.listeners.delete(fn); },
    emitChange: () => bus.emit(),
    formatChord: (c) => formatChord(c, { isMac: app.shortcuts?.isMac }),
    sourceKey,
    gainToNorm: (g) => toNorm(MIXER_TARGETS.volume, g),
    faderToGain,
  };
  app.control = api;
  return api;
}
