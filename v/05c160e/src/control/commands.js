// daW³ command registry + shortcut map (browser). Every global action lives here with its default keys;
// src/ui/keyboard.js dispatches keydown through it, Preferences → Shortcuts rebinds it and the command palette
// (Ctrl/Cmd+K) lists it together with every main-menu / Create-menu entry.
import { CommandRegistry, ShortcutMap } from './shortcuts.js';
import { VIEWS } from '../ui/app.js';
import { viewCommandEntries } from './view-commands.js';

const STORE_KEY = 'daw3-shortcuts';
export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

export function buildCommands(app) {
  const { ui, actions, store } = app;
  const ctl = () => app.control;
  const tr = (label, fn) => store.transact(label, fn);
  const selTrack = (dir) => {
    const ts = store.get().tracks;
    if (!ts.length) return;
    const i = ts.findIndex((t) => t.id === ui.get('selectedTrackId'));
    const n = ts[Math.max(0, Math.min(ts.length - 1, (i < 0 ? 0 : i + dir)))];
    actions.selectTrack(n.id);
  };
  const editSel = (label, fn) => { const id = ui.get('selectedTrackId'); if (id) actions.updateTrack(id, fn, label); };
  const list = [
    // transport
    { id: 'transport.play', label: 'Play / pause', category: 'Transport', keys: ['space'], run: () => actions.togglePlay() },
    { id: 'transport.stop', label: 'Stop (twice: back to start)', category: 'Transport', keys: ['enter'], run: () => actions.stop() },
    { id: 'transport.record', label: 'Record', category: 'Transport', keys: ['r'], run: () => actions.toggleRecord() },
    { id: 'record.capture', label: 'Capture MIDI (what you just played)', category: 'Recording', keys: ['shift+r'], run: () => actions.captureMidi?.() },
    { id: 'record.settings', label: 'Recording settings…', category: 'Recording', keys: [], run: () => actions.showRecordSettings?.() },
    { id: 'record.punch', label: 'Toggle punch in / out', category: 'Recording', keys: [], run: () => tr('Punch', (p) => { p.punch = { start: p.loop.start, end: p.loop.end, ...(p.punch || {}), enabled: !p.punch?.enabled }; }) },
    { id: 'record.step', label: 'Step input on / off', category: 'Recording', keys: [], run: () => app.rec?.setStepMode(!ui.get('stepInput')) },
    { id: 'transport.loop', label: 'Toggle loop', category: 'Transport', keys: ['l'], run: () => tr('Toggle loop', (p) => { p.loop.enabled = !p.loop.enabled; }) },
    { id: 'transport.metronome', label: 'Toggle metronome', category: 'Transport', keys: ['m'], run: () => store.transact('Toggle metronome', (p) => { p.metronome = !p.metronome; }, { undo: false }) },
    { id: 'transport.home', label: 'Go to start', category: 'Transport', keys: ['home'], run: () => actions.setPosition(0) },
    { id: 'transport.mode', label: 'Toggle Pattern / Song mode', category: 'Transport', keys: ['p'], run: () => actions.setMode(store.get().mode === 'song' ? 'pattern' : 'song') },
    { id: 'transport.tempoUp', label: 'Tempo +1 BPM', category: 'Transport', keys: [], repeat: true, run: () => tr('Tempo', (p) => { p.bpm = Math.min(400, p.bpm + 1); }) },
    { id: 'transport.tempoDown', label: 'Tempo −1 BPM', category: 'Transport', keys: [], repeat: true, run: () => tr('Tempo', (p) => { p.bpm = Math.max(20, p.bpm - 1); }) },
    { id: 'transport.panic', label: 'Panic: all notes off', category: 'Transport', keys: [], run: () => (app.engine.panic ? app.engine.panic() : app.engine.allNotesOff?.()) },
    // automation
    { id: 'automation.arm', label: 'Arm automation recording', category: 'Automation', keys: ['shift+a'], run: () => ui.set({ autoArm: !ui.get('autoArm') }) },
    { id: 'automation.reenable', label: 'Re-enable overridden automation', category: 'Automation', keys: [], run: () => app.automation?.reenable() },
    { id: 'automation.touch', label: 'Automation mode: Touch', category: 'Automation', keys: [], run: () => ui.set({ autoMode: 'touch' }) },
    { id: 'automation.latch', label: 'Automation mode: Latch', category: 'Automation', keys: [], run: () => ui.set({ autoMode: 'latch' }) },
    { id: 'automation.write', label: 'Automation mode: Write', category: 'Automation', keys: [], run: () => ui.set({ autoMode: 'write' }) },
    // edit / file
    { id: 'edit.undo', label: 'Undo', category: 'Edit', keys: ['mod+z'], repeat: true, run: () => actions.undo() },
    { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['mod+shift+z', 'mod+y'], repeat: true, run: () => actions.redo() },
    { id: 'file.save', label: 'Save project', category: 'File', keys: ['mod+s'], run: () => actions.saveProject() },
    { id: 'file.open', label: 'Open project…', category: 'File', keys: ['mod+o'], run: () => actions.openProject() },
    { id: 'file.export', label: 'Export mixdown WAV', category: 'File', keys: ['mod+e'], run: () => actions.exportWav() },
    { id: 'file.new', label: 'New project', category: 'File', keys: [], run: () => actions.newProject?.() },
    // tracks
    { id: 'track.next', label: 'Select next track', category: 'Tracks', keys: ['alt+arrowdown'], repeat: true, run: () => selTrack(1) },
    { id: 'track.prev', label: 'Select previous track', category: 'Tracks', keys: ['alt+arrowup'], repeat: true, run: () => selTrack(-1) },
    { id: 'track.mute', label: 'Mute selected track', category: 'Tracks', keys: [], run: () => editSel('Mute', (t) => { t.mute = !t.mute; }) },
    { id: 'track.solo', label: 'Solo selected track', category: 'Tracks', keys: [], run: () => editSel('Solo', (t) => { t.solo = !t.solo; }) },
    { id: 'track.arm', label: 'Record-arm selected track', category: 'Tracks', keys: [], run: () => editSel('Arm', (t) => { t.arm = !t.arm; }) },
    { id: 'track.duplicate', label: 'Duplicate selected track', category: 'Tracks', keys: [], run: () => { const id = ui.get('selectedTrackId'); if (id) actions.duplicateTrack?.(id); } },
    { id: 'track.delete', label: 'Delete selected track', category: 'Tracks', keys: [], run: () => { const id = ui.get('selectedTrackId'); if (id) actions.deleteTrack?.(id); } },
    // views & panels
    ...VIEWS.map((v) => ({ id: `view.${v.id}`, label: `Show ${v.label}`, category: 'Views', keys: [v.key], run: () => ui.set({ view: v.id }) })),
    { id: 'panel.browser', label: 'Toggle browser panel', category: 'Views', keys: ['b'], run: () => ui.set({ browserOpen: !ui.get('browserOpen') }) },
    { id: 'panel.assistant', label: 'Toggle assistant panel', category: 'Views', keys: ['a'], run: () => ui.set({ assistantOpen: !ui.get('assistantOpen') }) },
    { id: 'panel.device', label: 'Toggle device panel', category: 'Views', keys: ['d'], run: () => ui.set({ deviceOpen: !ui.get('deviceOpen') }) },
    { id: 'view.theme', label: 'Toggle light / dark theme', category: 'Views', keys: [], run: () => ui.set({ theme: ui.get('theme') === 'dark' ? 'light' : 'dark' }) },
    // play
    { id: 'piano.toggle', label: 'Computer keyboard piano on / off', category: 'Play', keys: ['`'], run: () => { app.keyboardPiano.enabled = !app.keyboardPiano.enabled; app.toast(`Computer keyboard piano ${app.keyboardPiano.enabled ? 'ON — play with Z…M / Q…P, octave with - and =' : 'OFF'}`); } },
    // control
    { id: 'palette.open', label: 'Command palette', category: 'General', keys: ['mod+k'], run: () => ctl()?.openPalette() },
    { id: 'help.show', label: 'Help & shortcuts', category: 'General', keys: ['shift+/'], run: () => actions.showHelp() },
    { id: 'prefs.open', label: 'Preferences…', category: 'General', keys: ['mod+,'], run: () => ctl()?.openPrefs() },
    { id: 'hardware.check', label: 'Hardware check (MIDI, control surface, audio I/O, Link) — copy a report', category: 'General', keys: [], run: () => ctl()?.openPrefs('hardware') },
    { id: 'prefs.shortcuts', label: 'Keyboard shortcuts…', category: 'General', keys: [], run: () => ctl()?.openPrefs('shortcuts') },
    { id: 'midi.learn', label: 'MIDI learn mode (map hardware to any control)', category: 'MIDI', keys: ['mod+shift+m'], run: () => ctl()?.toggleLearnMode() },
    { id: 'midi.devices', label: 'MIDI devices…', category: 'MIDI', keys: [], run: () => ctl()?.openPrefs('midi') },
    { id: 'midi.mappings', label: 'MIDI mappings…', category: 'MIDI', keys: [], run: () => ctl()?.openPrefs('mappings') },
    { id: 'midi.surfaces', label: 'Control surfaces (Mackie / HUI / pad grids)…', category: 'MIDI', keys: [], run: () => ctl()?.openPrefs('surfaces') },
    { id: 'midi.bankNext', label: 'Next controller template bank', category: 'MIDI', keys: [], run: () => ctl()?.selectTemplateBank(1) },
    { id: 'midi.bankPrev', label: 'Previous controller template bank', category: 'MIDI', keys: [], run: () => ctl()?.selectTemplateBank(-1) },
    { id: 'midi.sync', label: 'Sync: MIDI clock, MTC, Ableton Link…', category: 'MIDI', keys: [], run: () => ctl()?.openPrefs('sync') },
    // view-specific keys (piano roll, arrange, step rack, mixer): same map, scoped to their view
    ...viewCommandEntries(app),
  ];
  return new CommandRegistry().registerAll(list);
}

export function createShortcutMap(registry) {
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* none */ }
  const map = new ShortcutMap(registry, overrides, { isMac: isMacPlatform() });
  map.save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(map.overrides)); } catch { /* quota */ } };
  return map;
}

/** Flatten main-menu style items ({label, onClick, submenu}) into palette entries "Menu › Export › Stems". */
export function flattenMenu(items, prefix) {
  const out = [];
  for (const it of items || []) {
    if (!it || it === '-' || it.header || it.disabled) continue;
    const label = `${prefix} › ${it.label}`;
    if (it.submenu) out.push(...flattenMenu(it.submenu, label));
    else if (it.onClick) out.push({ id: `menu:${label}`, label, category: prefix.split(' › ')[0], run: it.onClick, menu: true, shortcut: it.shortcut || '' });
  }
  return out;
}
