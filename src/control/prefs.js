// Preferences dialog: MIDI devices · Mappings · Control surfaces · Sync · Shortcuts · Hardware check.
import { h, icon } from '../ui/dom.js';
import { modal, tabs, toast, fileInput, select, contextMenu, promptText } from '../ui/components.js';
import { downloadBlob } from '../io/project-file.js';
import { VELOCITY_CURVES, sourceLabel, RELATIVE_MODES } from './midi.js';
import { exportMappings, importMappings } from './mapping.js';
import { GRID_LAYOUTS } from './grid.js';
import { templateOwner } from './targets.js';
import { eventToChord, formatChord, fuzzyScore } from './shortcuts.js';
import { uid } from '../core/util.js';
import { hardwareCheckTab } from '../ui/hardware-check.js';

const chk = (value, onChange, title) => {
  const el = h('input', { type: 'checkbox', title });
  el.checked = !!value;
  el.addEventListener('change', () => onChange(el.checked));
  return el;
};
const sel = (options, value, onChange, title) => select({ options, value: value ?? '', onChange, title, cls: 'ctl-select' });
const num = (value, { min, max, step = 1, width = 56, title }, onChange) => {
  const el = h('input.ctl-num', { type: 'number', min, max, step, title, style: { width: width + 'px' } });
  el.value = value;
  el.addEventListener('change', () => { const v = Number(el.value); if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v))); });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  return el;
};
const btn = (label, onClick, { title, primary, ic } = {}) => {
  const b = h(`button.btn.small${primary ? '.primary' : ''}`, { type: 'button', title }, ic ? icon(ic, 13) : null, label);
  b.addEventListener('click', onClick);
  return b;
};
const help = (text) => h('p.ctl-help', text);

export function openPrefs(app, tab = 'midi') {
  const c = app.control;
  const roots = {};
  let unsub = null;
  const refresh = (id) => { const r = roots[id]; if (r?.isConnected) r.replaceChildren(...r.renderFn()); };
  const mk = (id, renderFn) => () => { const r = h('div.ctl-tab', { dataset: { tab: id } }); r.renderFn = renderFn; r.replaceChildren(...renderFn()); roots[id] = r; return r; };
  const t = tabs([
    { id: 'midi', label: 'MIDI devices', icon: 'plug', render: mk('midi', () => midiTab(app, () => refresh('midi'))) },
    { id: 'mappings', label: 'Mappings', icon: 'sliders', render: mk('mappings', () => mappingsTab(app, () => refresh('mappings'))) },
    { id: 'surfaces', label: 'Control surfaces', icon: 'grid', render: mk('surfaces', () => surfacesTab(app, () => refresh('surfaces'))) },
    { id: 'sync', label: 'Sync', icon: 'loop', render: mk('sync', () => syncTab(app, () => refresh('sync'))) },
    { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', render: mk('shortcuts', () => shortcutsTab(app, () => refresh('shortcuts'))) },
    { id: 'hardware', label: 'Hardware check', icon: 'search', render: mk('hardware', () => hardwareCheckTab(app, () => refresh('hardware'))) },
  ], tab);
  const m = modal({ title: 'Preferences', body: h('div.ctl-prefs', t), width: 900, cls: 'ctl-prefs-modal', onClose: () => unsub?.() });
  unsub = c.onChange(() => { for (const id of ['midi', 'mappings', 'surfaces']) { if (!roots[id]?.contains(document.activeElement)) refresh(id); } });
  const statusTimer = setInterval(() => { if (!m.el.isConnected) { clearInterval(statusTimer); return; } const r = roots.sync; if (r?.isConnected) r.querySelectorAll('[data-live]').forEach((el) => el.update?.()); }, 400);
  return m;
}

// ------------------------------------------------------------------------------------------- MIDI devices
function midiTab(app, rerender) {
  const c = app.control;
  const d = c.devices;
  if (!d.ready) {
    return [
      help('daW³ talks to keyboards, pads, controllers and control surfaces over Web MIDI (Chrome, Edge, Opera, the desktop app). Nothing leaves your computer.'),
      d.supported ? btn('Enable MIDI', async () => { if (await c.openMidi()) rerender(); }, { primary: true, ic: 'piano' }) : h('p.ctl-warn', 'This browser has no Web MIDI. Use a Chromium-based browser or the desktop app.'),
    ];
  }
  const tracks = app.store.get().tracks.filter((x) => x.type === 'instrument');
  const targetOpts = [{ value: 'auto', label: 'Armed tracks, else selected' }, { value: 'selected', label: 'Selected track' }, { value: 'armed', label: 'Armed tracks (●)' }, ...tracks.map((x) => ({ value: x.id, label: `Track: ${x.name}`, group: 'Fixed track' }))];
  const chOpts = [{ value: 'all', label: 'All channels' }, ...Array.from({ length: 16 }, (_, i) => ({ value: String(i), label: `Channel ${i + 1}` }))];
  const ins = d.inputs();
  const outs = d.outputs();
  const inRows = ins.map((p) => {
    const s = p.settings;
    const set = (patch) => { d.setInputSettings(p.name, patch); };
    const roleNote = c.settings.surfaces.some((x) => x.enabled && x.input === p.name) ? 'control surface' : c.settings.grids.some((x) => x.enabled && x.input === p.name) ? 'pad grid' : c.settings.sync.clockIn === p.name ? 'clock in' : '';
    return h('tr', { class: p.state === 'disconnected' ? 'ctl-off' : '' },
      h('td', chk(s.enabled, (v) => set({ enabled: v }), 'Use this device')),
      h('td.ctl-name', p.name, roleNote ? h('span.ctl-tag', roleNote) : null),
      h('td', chk(s.notes, (v) => set({ notes: v }), 'Play notes on tracks')),
      h('td', chk(s.control, (v) => set({ control: v }), 'Use knobs / faders / pads for MIDI-learn mappings')),
      h('td', sel(chOpts, Array.isArray(s.channels) && s.channels.length === 1 ? String(s.channels[0]) : 'all', (v) => set({ channels: v === 'all' ? 'all' : [Number(v)] }), 'Channel filter for notes')),
      h('td', sel(targetOpts, s.target, (v) => set({ target: v }), 'Which track(s) the notes play')),
      h('td', sel(VELOCITY_CURVES, s.curve, (v) => set({ curve: v }), 'Velocity curve'), s.curve === 'fixed' ? num(s.fixedVelocity, { min: 1, max: 127, width: 48, title: 'Fixed velocity' }, (v) => set({ fixedVelocity: v })) : null),
      h('td', num(s.transpose, { min: -48, max: 48, width: 48, title: 'Transpose (semitones)' }, (v) => set({ transpose: v }))),
      h('td', chk(s.mpe, (v) => set({ mpe: v }), 'MPE: per-note pitch bend, pressure and timbre (CC74) on member channels 2-16')),
    );
  });
  const outRows = outs.map((p) => h('tr', h('td', chk(p.settings.enabled, (v) => d.setOutputSettings(p.name, { enabled: v }), 'Allow daW³ to send to this output')), h('td.ctl-name', p.name)));
  const thru = sel([{ value: '', label: '— off —' }, ...outs.map((o) => ({ value: o.name, label: o.name }))], c.settings.thru || '', (v) => { c.settings.thru = v || null; c.save(); }, 'MIDI thru: echo incoming notes to this output (e.g. a hardware synth)');
  return [
    h('h4', 'Inputs'),
    ins.length ? h('table.ctl-table', h('thead', h('tr', ...['On', 'Device', 'Notes', 'Control', 'Channel', 'Plays', 'Velocity', 'Transpose', 'MPE'].map((x) => h('th', x)))), h('tbody', inRows)) : help('No MIDI inputs — plug one in; it appears here automatically.'),
    help('Notes go to the armed (●) instrument tracks, or the selected one. Sustain pedal, pitch bend and MPE (per-note bend / pressure / timbre on the analog synth) are supported; with Record on, MPE bends are stored on the recorded notes.'),
    h('h4', 'Outputs'),
    outs.length ? h('table.ctl-table', h('tbody', outRows)) : help('No MIDI outputs.'),
    h('div.ctl-row', h('span', 'MIDI thru → '), thru),
    help(d.sysex ? 'SysEx enabled (needed for Mackie scribble strips).' : 'SysEx was not granted: control-surface displays stay blank, everything else works.'),
  ];
}

// ------------------------------------------------------------------------------------------- Mappings
function mappingsTab(app, rerender) {
  const c = app.control;
  const M = c.mappings;
  const modeOpts = [{ value: 'absolute', label: 'Absolute' }, { value: 'relative-2c', label: "Relative (2's compl.)" }, { value: 'relative-bin', label: 'Relative (binary offset)' }, { value: 'relative-sm', label: 'Relative (sign-magnitude)' }];
  const row = (m) => {
    const up = (patch) => M.update(m.id, patch);
    const isBtn = !!m.button || m.source.kind === 'note';
    const pct = (v) => Math.round(v * 100);
    return h('tr',
      h('td.ctl-src', sourceLabel(m.source), h('div.ctl-sub', m.source.device || 'any device')),
      h('td.ctl-tgt', c.labelOfTarget(m.target)),
      h('td', isBtn ? sel([{ value: 'toggle', label: 'Toggle' }, { value: 'momentary', label: 'Momentary' }], m.button || 'toggle', (v) => up({ button: v }), 'Button behaviour')
        : sel(modeOpts, m.mode, (v) => up({ mode: v }), 'How the control sends values (auto-detected when learned)'), m.detect ? h('span.ctl-tag', 'detecting') : null),
      h('td', isBtn || RELATIVE_MODES.includes(m.mode) ? '—' : sel([{ value: 'pickup', label: 'Pickup' }, { value: 'jump', label: 'Jump' }], m.takeover, (v) => up({ takeover: v }), 'Pickup (soft takeover): the control only takes over once it reaches the current value')),
      h('td.ctl-range', num(pct(m.min), { min: 0, max: 100, width: 50, title: 'Minimum (%)' }, (v) => up({ min: v / 100 })), '–', num(pct(m.max), { min: 0, max: 100, width: 50, title: 'Maximum (%)' }, (v) => up({ max: v / 100 }))),
      h('td', chk(m.invert, (v) => up({ invert: v }), 'Invert')),
      h('td', chk(m.feedback, (v) => up({ feedback: v }), 'Send the value back to the controller (LED rings, motor faders, pad LEDs)')),
      h('td', btn('', () => M.remove(m.id), { ic: 'trash', title: 'Delete mapping' })),
    );
  };
  const table = (list) => (list.length
    ? h('table.ctl-table', h('thead', h('tr', ...['Control', 'Target', 'Mode', 'Takeover', 'Range %', 'Inv', 'FB', ''].map((x) => h('th', x)))), h('tbody', list.map(row)))
    : help('None yet.'));
  const commands = (app.commands?.list() || []).map((cmd) => ({ value: cmd.id, label: `${cmd.category} › ${cmd.label}` }));
  let cmdPick = commands[0]?.value;
  const cmdSel = sel(commands, cmdPick, (v) => { cmdPick = v; }, 'Command to trigger from a button');
  const p = app.store.get();
  return [
    help('Right-click any knob, fader or switch → "MIDI learn…", or press the MIDI button in the header (learn mode) and click controls one after another. Absolute knobs, relative encoders (three flavours, auto-detected), 14-bit CC pairs, NRPN and buttons are recognised automatically.'),
    h('div.ctl-row', btn(c.learnMode ? 'Leave learn mode' : 'Learn mode', () => { c.setLearnMode(!c.learnMode); rerender(); }, { primary: true, ic: 'piano' }),
      h('span.ctl-gap'), h('span', 'Button → command: '), cmdSel, btn('Learn', () => { if (cmdPick) c.learn({ command: cmdPick }); }, { title: 'Then press a button / pad on your controller' })),
    h('h4', `This project (${M.project.length})`),
    table(M.project),
    h('div.ctl-row',
      btn('Export…', () => downloadBlob(new Blob([exportMappings(M.project)], { type: 'application/json' }), 'daw3-midi-mappings.json'), { ic: 'download' }),
      btn('Import…', async () => {
        const [f] = await fileInput('.json,application/json');
        if (!f) return;
        try { const list = importMappings(await f.text()); M.project.push(...list); M.emit('change', { scope: 'project' }); toast(`Imported ${list.length} mappings`, { level: 'success' }); } catch (e) { toast(e.message, { level: 'error' }); }
      }, { ic: 'upload' }),
      btn('Save as controller template', () => {
        M.template = M.project.map((m) => ({ ...JSON.parse(JSON.stringify(m)), id: uid('map'), scope: 'template', target: m.target.command ? m.target : { ...m.target, owner: templateOwner(p, m.target.owner) } }));
        M.emit('change', { scope: 'template' });
        toast('Saved as your controller template — it works in every project (track mappings follow track order).', { level: 'success' });
      }, { title: 'Copy these mappings into the global template (tracks become "track 1, 2…")' }),
      M.project.length ? btn('Delete all', () => { M.project.length = 0; M.emit('change', { scope: 'project' }); }, { ic: 'trash' }) : null),
    h('h4', `Controller template — all projects (${M.template.length})`),
    // named banks: e.g. "Mixer", "Synth edit", "Live" — switch from here, the palette or a mapped controller button
    h('div.ctl-row', h('span', 'Bank: '),
      sel(c.banks.names().map((n) => ({ value: n, label: n })), c.banks.active, (v) => { c.selectTemplateBank(v); rerender(); }, 'Active controller template bank (map "Next / Previous controller template bank" to buttons to switch from the controller)'),
      btn('Save as bank…', async () => { const n = await promptText('Save the controller template as bank', c.banks.active === 'Default' ? 'Mixer' : c.banks.active); if (n && c.saveTemplateBankAs(n)) rerender(); }, { ic: 'save', title: 'Keep the current template under a name; switch banks to swap whole controller layouts' }),
      c.banks.names().length > 1 ? btn('Delete bank', () => { c.deleteTemplateBank(c.banks.active); rerender(); }, { ic: 'trash' }) : null),
    help('Template mappings apply in every project unless a project mapping uses the same control. "Selected track" mappings follow whichever track you select.'),
    table(M.template),
    h('div.ctl-row',
      btn('Export…', () => downloadBlob(new Blob([exportMappings(M.template)], { type: 'application/json' }), 'daw3-controller-template.json'), { ic: 'download' }),
      btn('Import…', async () => {
        const [f] = await fileInput('.json,application/json');
        if (!f) return;
        try { const list = importMappings(await f.text()).map((m) => ({ ...m, scope: 'template' })); M.template.push(...list); M.emit('change', { scope: 'template' }); } catch (e) { toast(e.message, { level: 'error' }); }
      }, { ic: 'upload' }),
      M.template.length ? btn('Clear template', () => { M.template.length = 0; M.emit('change', { scope: 'template' }); }, { ic: 'trash' }) : null),
  ];
}

// ------------------------------------------------------------------------------------------- Surfaces
function surfacesTab(app, rerender) {
  const c = app.control;
  const d = c.devices;
  if (!d.ready) return [help('Enable MIDI first (MIDI devices tab).'), btn('Enable MIDI', async () => { if (await c.openMidi()) rerender(); }, { primary: true })];
  const ins = [{ value: '', label: '— input —' }, ...d.inputs().map((p) => ({ value: p.name, label: p.name }))];
  const outs = [{ value: '', label: '— output —' }, ...d.outputs().map((p) => ({ value: p.name, label: p.name }))];
  const commit = () => { c.save(); c.buildControllers(); rerender(); };
  const guessOut = (cfg) => { if (cfg.input && !cfg.output) cfg.output = d.partnerOutput(cfg.input) || ''; };
  const surfRows = c.settings.surfaces.map((cfg) => h('tr',
    h('td', chk(cfg.enabled, (v) => { cfg.enabled = v; commit(); })),
    h('td', sel([{ value: 'mcu', label: 'Mackie Control (MCU)' }, { value: 'mcu-xt', label: 'Mackie XT extender' }, { value: 'hui', label: 'HUI' }], cfg.kind, (v) => { cfg.kind = v; commit(); })),
    h('td', sel(ins, cfg.input || '', (v) => { cfg.input = v; guessOut(cfg); commit(); })),
    h('td', sel(outs, cfg.output || '', (v) => { cfg.output = v; commit(); })),
    h('td', btn('', () => { c.settings.surfaces = c.settings.surfaces.filter((x) => x !== cfg); commit(); }, { ic: 'trash' })),
  ));
  const gridRows = c.settings.grids.map((cfg) => h('tr',
    h('td', chk(cfg.enabled, (v) => { cfg.enabled = v; commit(); })),
    h('td', sel(Object.entries(GRID_LAYOUTS).map(([value, L]) => ({ value, label: L.label })), cfg.layout, (v) => { cfg.layout = v; commit(); })),
    h('td', sel(ins, cfg.input || '', (v) => { cfg.input = v; guessOut(cfg); commit(); })),
    h('td', sel(outs, cfg.output || '', (v) => { cfg.output = v; commit(); })),
    h('td', sel([{ value: 'auto', label: 'Follow view (Scenes / Setlist)' }, { value: 'session', label: 'Scenes' }, { value: 'setlist', label: 'Setlist' }], cfg.mode || 'auto', (v) => { cfg.mode = v; commit(); })),
    h('td', btn('', () => { c.settings.grids = c.settings.grids.filter((x) => x !== cfg); commit(); }, { ic: 'trash' })),
  ));
  const firstIn = d.inputs()[0]?.name || '';
  return [
    h('h4', 'Mackie Control / HUI'),
    help('Set the surface to Mackie Control (or HUI) mode. 8 faders (touch-sensitive: touching writes automation in Touch mode), V-pots for pan → sends (press SEND again to step through buses) → instrument/device parameters (PLUG-IN, page with CHANNEL ◀ ▶), mute / solo / rec / select with LEDs, transport, jog wheel (16ths), BANK ◀ ▶ by 8, CHANNEL ◀ ▶ by 1, scribble strips, bar.beat time display and meters.'),
    c.settings.surfaces.length ? h('table.ctl-table', h('thead', h('tr', ...['On', 'Protocol', 'From surface', 'To surface', ''].map((x) => h('th', x)))), h('tbody', surfRows)) : null,
    h('div.ctl-row', btn('Add Mackie Control', () => { const cfg = { id: uid('srf'), kind: 'mcu', input: firstIn, output: '', enabled: true }; guessOut(cfg); c.settings.surfaces.push(cfg); commit(); }, { ic: 'plus' }),
      btn('Add HUI', () => { const cfg = { id: uid('srf'), kind: 'hui', input: firstIn, output: '', enabled: true }; guessOut(cfg); c.settings.surfaces.push(cfg); commit(); }, { ic: 'plus' })),
    h('h4', 'Pad grids (clip launching)'),
    help('Launchpad (programmer mode), APC mini, Push (user mode) and compatible 8×8 grids: in Scenes the pads launch slots (rows = scenes, columns = tracks; empty pad stops the track), the right column launches scenes, arrows scroll. In Setlist: per layer mute / solo / regenerate / next sound / lock, bottom row queues sections. Pad colours show what is playing.'),
    c.settings.grids.length ? h('table.ctl-table', h('thead', h('tr', ...['On', 'Layout', 'From grid', 'To grid', 'Controls', ''].map((x) => h('th', x)))), h('tbody', gridRows)) : null,
    h('div.ctl-row', btn('Add pad grid', () => { const cfg = { id: uid('grd'), layout: 'launchpad', input: firstIn, output: '', enabled: true, mode: 'auto' }; guessOut(cfg); c.settings.grids.push(cfg); commit(); }, { ic: 'plus' })),
  ];
}

// ------------------------------------------------------------------------------------------- Sync
function syncTab(app, rerender) {
  const c = app.control;
  const d = c.devices;
  const S = c.settings.sync;
  const commit = () => { c.save(); rerender(); };
  const live = (fn) => { const el = h('span.ctl-live', { dataset: { live: '1' } }); el.update = () => { el.textContent = fn(); }; el.update(); return el; };
  const linkSet = c.settings.link;
  const linkStatus = live(() => {
    const st = c.link.state;
    if (c.link.status === 'connected') return st ? `connected · ${st.link ? 'Link' : 'simulated'} · ${(+st.tempo).toFixed(2)} BPM · ${st.peers} peer${st.peers === 1 ? '' : 's'} · ${st.playing ? 'playing' : 'stopped'}` : 'connected';
    return c.link.status === 'connecting' ? 'connecting… (is the bridge running?)' : c.link.status;
  });
  const urlIn = h('input.ctl-text', { type: 'text', value: linkSet.url, title: 'Bridge WebSocket URL' });
  urlIn.addEventListener('keydown', (e) => e.stopPropagation());
  const linkBlock = [
    h('h4', 'Ableton Link'),
    help(typeof window !== 'undefined' && window.daw3Native?.link
      ? 'Ableton Link is built into the daW³ Mac app: Connect joins the Link session on your network. daW³ then follows and sets the session tempo, starts on the next bar of the Link timeline and stops with it.'
      : 'Browsers cannot join Link directly. Run the companion bridge (node tools/link-bridge/link-bridge.mjs — see its README) and connect: daW³ then follows and sets the session tempo, starts on the next bar of the Link timeline and stops with it.'),
    h('div.ctl-row', urlIn,
      c.link.status === 'off' || c.link.status === 'error'
        ? btn('Connect', () => { linkSet.enabled = true; linkSet.url = urlIn.value.trim() || linkSet.url; c.save(); c.link.connect(linkSet.url); rerender(); }, { primary: true })
        : btn('Disconnect', () => { linkSet.enabled = false; c.save(); c.link.disconnect(); rerender(); }),
      linkStatus),
  ];
  if (!d.ready) return [help('Enable MIDI for MIDI clock / MTC.'), btn('Enable MIDI', async () => { if (await c.openMidi()) rerender(); }, { primary: true }), ...linkBlock];
  const outs = d.outputs();
  const ins = d.inputs();
  return [
    h('h4', 'MIDI clock out'),
    help('24 ppqn clock with Start / Stop / Continue and Song Position Pointer to the ticked outputs (drum machines, sequencers, other DAWs). Tempo changes keep the phase.'),
    outs.length ? h('div.ctl-checks', outs.map((o) => h('label', chk((S.clockOut || []).includes(o.name), (v) => { S.clockOut = v ? [...new Set([...(S.clockOut || []), o.name])] : (S.clockOut || []).filter((x) => x !== o.name); commit(); }), ' ', o.name))) : help('No outputs.'),
    h('div.ctl-row', h('span', 'Latency offset '), num(S.offsetMs || 0, { min: -200, max: 200, width: 60, title: 'Shift clock / MTC output (ms): positive = later' }, (v) => { S.offsetMs = v; c.save(); }), h('span', ' ms')),
    h('h4', 'MIDI clock in'),
    h('div.ctl-row', sel([{ value: '', label: '— off —' }, ...ins.map((i) => ({ value: i.name, label: i.name }))], S.clockIn || '', (v) => { S.clockIn = v || null; commit(); }, 'Follow an external MIDI clock'),
      h('label', chk(S.follow, (v) => { S.follow = v; c.save(); }), ' follow tempo'),
      h('label', chk(S.followTransport, (v) => { S.followTransport = v; c.save(); }), ' follow start / stop / position'),
      live(() => (c.clockIn.bpm ? `incoming ≈ ${c.clockIn.bpm.toFixed(2)} BPM` : 'no clock'))),
    help('Tempo is estimated from the tick timing with a least-squares fit over the last 3 beats (robust to USB jitter) and smoothed; real tempo changes are picked up within about half a beat.'),
    h('h4', 'MIDI time code (MTC) out'),
    h('div.ctl-row', sel([{ value: '', label: '— off —' }, ...outs.map((o) => ({ value: o.name, label: o.name }))], S.mtcOut || '', (v) => { S.mtcOut = v || null; commit(); }, 'Send MTC quarter frames'),
      sel([{ value: '24', label: '24 fps' }, { value: '25', label: '25 fps' }, { value: '29.97', label: '29.97 fps drop-frame' }, { value: '30', label: '30 fps (non-drop)' }], String(S.mtcFps || 25), (v) => { S.mtcFps = v === '29.97' ? '29.97' : +v; commit(); })),
    ...linkBlock,
  ];
}

// ------------------------------------------------------------------------------------------- Shortcuts
let shortcutQuery = '';
function shortcutsTab(app, rerender) {
  const map = app.shortcuts;
  const reg = app.commands;
  const isMac = map.isMac;
  const fmt = (k) => formatChord(k, { isMac });
  const conflicts = map.conflicts();
  const conflictIds = new Set(conflicts.flatMap((x) => x.ids));
  const search = h('input.ctl-text.ctl-search', { type: 'search', placeholder: 'Search actions or keys…', value: shortcutQuery });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const body = h('tbody');
  const fill = () => {
    const q = shortcutQuery.trim();
    const cmds = reg.list().filter((cmd) => !q || fuzzyScore(q, `${cmd.category} ${cmd.label}`) > 0 || map.keysFor(cmd.id).some((k) => fmt(k).toLowerCase().includes(q.toLowerCase())));
    let cat = null;
    const rows = [];
    for (const cmd of cmds) {
      if (cmd.category !== cat) { cat = cmd.category; rows.push(h('tr.ctl-cat', h('td', { colspan: 3 }, cat, cmd.scope && cmd.scope !== 'global' ? h('span.muted', ' — only in this view (the same keys can do something else in other views)') : null))); }
      const chips = map.keysFor(cmd.id).map((k) => {
        const x = h('button.ctl-chip-x', { type: 'button', title: 'Remove this shortcut' }, '×');
        x.addEventListener('click', () => { map.unbind(cmd.id, k); map.save(); rerender(); });
        return h('span.ctl-chip', h('kbd', fmt(k)), x);
      });
      const add = h('button.btn.small', { type: 'button', title: 'Press the new key combination (Esc cancels)' }, '+');
      add.addEventListener('click', () => record(cmd, add));
      const reset = map.isCustom(cmd.id) ? btn('Reset', () => { map.reset(cmd.id); map.save(); rerender(); }) : null;
      rows.push(h(`tr${conflictIds.has(cmd.id) ? '.ctl-conflict' : ''}`, h('td.ctl-name', cmd.label), h('td', chips, add), h('td', reset)));
    }
    body.replaceChildren(...rows);
  };
  search.addEventListener('input', () => { shortcutQuery = search.value; fill(); });
  function record(cmd, anchor) {
    anchor.textContent = 'Press keys…';
    anchor.classList.add('recording');
    const onKey = (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { done(); rerender(); return; }
      const chord = eventToChord(e, { isMac });
      if (!chord) return; // a bare modifier: wait for the key
      done();
      const clash = map.commandsFor(chord, cmd.scope).filter((x) => x.id !== cmd.id);
      if (!clash.length) { map.bind(cmd.id, chord); map.save(); rerender(); return; }
      const r = anchor.getBoundingClientRect();
      contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, [
        { header: `${fmt(chord)} is used by ${clash.map((x) => `"${x.label}"`).join(', ')}` },
        { label: `Use it for "${cmd.label}" only (remove it there)`, onClick: () => { map.bind(cmd.id, chord, { steal: true }); map.save(); rerender(); } },
        { label: 'Keep both (conflict)', onClick: () => { map.bind(cmd.id, chord); map.save(); rerender(); } },
        { label: 'Cancel', onClick: () => rerender() },
      ]);
    };
    const done = () => window.removeEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onKey, true);
  }
  fill();
  return [
    h('div.ctl-row', search,
      btn('Export…', () => downloadBlob(new Blob([map.export()], { type: 'application/json' }), 'daw3-shortcuts.json'), { ic: 'download' }),
      btn('Import…', async () => { const [f] = await fileInput('.json,application/json'); if (!f) return; try { map.import(await f.text()); map.save(); rerender(); toast('Shortcuts imported', { level: 'success' }); } catch (e) { toast(e.message, { level: 'error' }); } }, { ic: 'upload' }),
      btn('Reset all', () => { map.reset(); map.save(); rerender(); }, { title: 'Back to the default shortcuts' })),
    conflicts.length ? h('div.ctl-warn', `${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}: `, conflicts.map((x) => `${fmt(x.chord)} → ${x.ids.map((id) => reg.get(id)?.label).join(' / ')}`).join(' · ')) : null,
    help(`Every action is also in the command palette (${map.label('palette.open') || 'unbound'}). View-specific keys (Delete, Ctrl+A / C / V / D, arrows in the piano roll and timeline) stay as they are.`),
    h('table.ctl-table.ctl-shortcuts', body),
  ];
}
