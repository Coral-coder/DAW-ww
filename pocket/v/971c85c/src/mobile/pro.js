// daW³ Pocket ▸ pro features from the desktop, phone-sized: freeze / bounce / flatten in track menus, recording takes
// (choose a take per section, promote, delete, flatten), tempo / meter change lists, the pro export as a bottom sheet
// (loudness presets, stems, report), version history and the MIDI device list. Pure helpers live in pro-core.js.
import { h, icon } from '../ui/dom.js';
import { openSheet, actionSheet, bigButton, chips, confirmSheet, promptSheet, haptic } from './touch.js';
import { isFrozen, frozenStaleReason, FROZEN_HINT } from '../core/freeze.js';
import { freezeTrack, unfreezeTrack, bounceTrack, restoreProject } from '../ui/engine-ui.js';
import { hasTakes, setCompRange, promoteTake, deleteTake, allTakes } from '../record/takes.js';
import { takeSections, takeSummary, tempoRows, meterRows } from './pro-core.js';
import { setTempoPoint, removeTempoPoint, setTempoCurve, moveTempoPoint, setMeter, removeMeter } from '../time/tempo-edit.js';
import { songTempoMap } from '../time/tempo-map.js';
import { EXPORT_FORMATS, EXPORT_SAMPLE_RATES, EXPORT_DEFAULTS, resolveRange, rangeSeconds, formatFileName, stemTargets } from '../io/export-plan.js';
import { LOUDNESS_PRESETS } from '../audio/dsp/loudness.js';
import { createRecovery } from '../io/recovery.js';
import { ensureProjectId } from '../io/autosave.js';

const MODE_LABEL = { preFx: 'instrument only', postFx: 'instrument + effects', postFader: 'post-fader (with volume / pan)' };
const trackOf = (app, id) => app.store.get().tracks.find((t) => t.id === id);
/** Re-render `fn` on every project change while a sheet is open. */
function live(app, sheet, fn) {
  const off = app.subscribe((r) => { if (r.project) fn(); });
  const close = sheet.close;
  sheet.close = () => { off(); close(); };
  const back = sheet.back;
  new MutationObserver((_, mo) => { if (!back.isConnected) { off(); mo.disconnect(); } }).observe(document.body, { childList: true });
  fn();
}

// ------------------------------------------------------------------------------------------- install
/** Called once by the Pocket shell: frozen-edit hint, freeze / takes items in track menus, version snapshots. */
export function installPocketPro(app) {
  const { store } = app;
  store.on('blocked', (b) => app.toast(b.message || FROZEN_HINT, { level: 'warn', timeout: 4500 }));
  app.freezeMenuItems = (trackId) => trackProItems(app, trackId); // actions.trackMenuItems appends these
  try { app.recovery = createRecovery({ onError: (e) => console.warn('[recovery]', e) }); } catch (e) { console.warn('[recovery] unavailable', e); }
  return {
    afterBoot() {
      try {
        if (!app.recovery) return;
        ensureProjectId(store.get());
        store.on('load', (p) => ensureProjectId(p));
        app.recovery.start(store, { intervalMs: 10000 });
      } catch (e) { console.warn('[recovery] unavailable', e); }
    },
  };
}

// ------------------------------------------------------------------------------------------- track menu: freeze + takes
async function flatten(app, trackId) {
  const t = trackOf(app, trackId);
  if (!t) return;
  if (!(await confirmSheet('Flatten track', `Replace “${t.name}” by audio of its instrument + effects? Notes and the instrument are removed — Undo brings them back.`, 'Flatten'))) return;
  await app.engine.init();
  try { if (await app.engine.flattenTrack(trackId, { mode: 'postFx' })) app.toast('Track flattened to audio', { level: 'success' }); } catch (e) { app.toast(`Flatten failed: ${e.message || e}`, { level: 'error' }); }
}

/** Freeze / bounce / flatten + takes entries for a track's action sheet. */
export function trackProItems(app, trackId) {
  const p = app.store.get();
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return [];
  const items = [];
  if (hasTakes(t)) items.push({ label: `Recording takes (${allTakes(t).length})…`, icon: 'layers', onClick: () => openTakesSheet(app, trackId) });
  items.push({ header: 'Freeze / bounce' });
  if (isFrozen(t)) {
    const stale = frozenStaleReason(p, t);
    items.push({ label: 'Unfreeze (editable again)', icon: 'snow', onClick: () => unfreezeTrack(app, trackId) });
    if (stale) items.push({ label: 'Freeze again (update)', icon: 'snow', onClick: () => freezeTrack(app, trackId, t.frozen.mode) });
  } else {
    items.push({ label: 'Freeze (save CPU)', icon: 'snow', disabled: t.type === 'audio' && p.mode === 'pattern', onClick: () => freezeTrack(app, trackId, 'postFx') });
    items.push({ label: 'Freeze…', icon: 'snow', submenu: ['preFx', 'postFx', 'postFader'].map((m) => ({ label: `Freeze ${MODE_LABEL[m]}`, onClick: () => freezeTrack(app, trackId, m) })) });
  }
  items.push({ label: 'Bounce to a new audio track', icon: 'wave', onClick: () => bounceTrack(app, trackId, 'postFader') });
  if (t.type !== 'audio' || (t.fx || []).length) items.push({ label: 'Flatten (commit to audio)…', icon: 'layers', onClick: () => flatten(app, trackId) });
  return items;
}

// ------------------------------------------------------------------------------------------- takes
const fmtBars = (map, a, b) => `bars ${map.barAt(a).bar + 1}–${map.barAt(Math.max(a, b - 1e-6)).bar + 1}`;

/** Takes of a track: one row per section (song markers) with the take that plays there; tap = choose another. */
export function openTakesSheet(app, trackId) {
  const { store } = app;
  const list = h('div.pk-list');
  const sub = h('p.pk-p');
  const edit = (label, fn) => store.transact(label, (p) => { const t = p.tracks.find((x) => x.id === trackId); if (t) fn(t); });
  const flattenBtn = bigButton('Flatten comp', () => { sheet.close(); app.rec?.flattenComp(trackId); }, { ic: 'wave', title: 'Render the comp into one clip and remove the takes' });
  const moreBtn = bigButton('Takes…', () => takeMenu(), { ic: 'menu' });
  const sheet = openSheet({ title: `${trackOf(app, trackId)?.name || 'Track'} · takes`, body: [sub, list], actions: h('div.pk-row', moreBtn, flattenBtn), cls: 'pk-takes', tall: true });
  function takeMenu() {
    const t = trackOf(app, trackId);
    if (!t) return;
    const takes = allTakes(t).map((x) => x.take);
    actionSheet('Takes', [
      { label: 'Use a whole take everywhere', icon: 'layers', submenu: takes.map((tk) => ({ label: tk.name, onClick: () => edit('Promote take', (tt) => promoteTake(tt, tk.id)) })) },
      { label: 'Delete a take', icon: 'trash', submenu: takes.map((tk) => ({ label: tk.name, onClick: () => edit('Delete take', (tt) => deleteTake(tt, tk.id)) })) },
      { label: 'Comp crossfade', icon: 'sliders', submenu: [0, 5, 10, 20, 50].map((ms) => ({ label: `${ms} ms`, checked: (t.compXfade ?? 10) === ms, onClick: () => edit('Comp crossfade', (tt) => { tt.compXfade = ms; }) })) },
    ]);
  }
  live(app, sheet, () => {
    const p = store.get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t || !hasTakes(t)) { list.replaceChildren(h('p.pk-p', 'No takes on this track (yet). Record with the loop on to get one take per pass.')); sub.textContent = ''; flattenBtn.disabled = true; return; }
    flattenBtn.disabled = !t.comp?.length;
    const map = songTempoMap(p);
    sub.textContent = `${takeSummary(p, t)} — tap a section to choose which take plays there.`;
    list.replaceChildren(...takeSections(p, t).map((s) => {
      const cur = s.takes.find((x) => x.id === s.takeId);
      const b = h('button.pk-row-btn.pk-take-row', { type: 'button' },
        h('span.pk-row-name', s.name, h('small', ` · ${fmtBars(map, s.start, s.end)}`)),
        h('span.pk-take-cur', cur ? cur.name : 'silent'), icon('chevronRight', 16));
      b.addEventListener('click', () => {
        haptic(5);
        actionSheet(`${s.name}: which take?`, s.takes.map((x) => ({
          label: `${x.name}${x.covers ? '' : ' (covers part of it)'}`, checked: x.id === s.takeId,
          onClick: () => edit('Comp', (tt) => setCompRange(tt, x.id, s.start, s.end)),
        })));
      });
      return b;
    }));
  });
  return sheet;
}

// ------------------------------------------------------------------------------------------- tempo / meter
/** Tempo & meter changes as simple lists: tap a row to edit, add at the playhead. */
export function openTempoSheet(app) {
  const { store, engine } = app;
  const tempoList = h('div.pk-list');
  const meterList = h('div.pk-list');
  const tx = (label, fn) => store.transact(label, fn);
  const playBeat = () => {
    const map = songTempoMap(store.get());
    return map.barStart(map.barAt(engine.getPosition?.() || 0).bar);
  };
  const addTempo = async () => {
    const p = store.get();
    const beat = playBeat();
    const v = await promptSheet(`Tempo from ${songTempoMap(p).formatBBT(beat)} (BPM)`, String(Math.round(songTempoMap(p).bpmAt(beat))), { inputmode: 'decimal' });
    const bpm = parseFloat(v);
    if (Number.isFinite(bpm)) tx('Tempo change', (pp) => setTempoPoint(pp, beat, bpm));
  };
  const addMeter = async () => {
    const p = store.get();
    const bar = songTempoMap(p).barAt(engine.getPosition?.() || 0).bar;
    const v = await promptSheet(`Meter from bar ${bar + 1} (e.g. 3/4, 7/8)`, '3/4');
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v || '');
    if (m) tx('Meter change', (pp) => setMeter(pp, bar, +m[1], +m[2]));
    else if (v != null) app.toast('Write the meter like 3/4 or 7/8', { level: 'warn' });
  };
  const sheet = openSheet({
    title: 'Tempo & meter', tall: true, cls: 'pk-tempo',
    body: [h('div.pk-label.pk-pad', 'Tempo changes'), tempoList, bigButton('Add a tempo change at the playhead', addTempo, { ic: 'plus' }),
      h('div.pk-label.pk-pad', 'Meter (time signature)'), meterList, bigButton('Add a meter change at the playhead', addMeter, { ic: 'plus' }),
      h('p.pk-hint', 'Tempo and meter changes play in Song mode. Ramps glide from a point to the next one.')],
  });
  live(app, sheet, () => {
    const p = store.get();
    const rows = tempoRows(p);
    tempoList.replaceChildren(...rows.map((r) => {
      const next = rows[r.i + 1];
      const b = h('button.pk-row-btn', { type: 'button' }, h('span.pk-row-name', `${+r.bpm.toFixed(2)} BPM`),
        h('span.pk-row-sub', `${r.i === 0 ? 'Start' : r.bbt}${next && r.curve === 'linear' ? ' · ramp ↗' : ''}`), icon('chevronRight', 16));
      b.addEventListener('click', () => actionSheet(r.i === 0 ? 'Song tempo' : `Tempo at ${r.bbt}`, [
        { label: 'Change BPM…', icon: 'metronome', onClick: async () => { const v = parseFloat(await promptSheet('BPM', String(+r.bpm.toFixed(2)), { inputmode: 'decimal' })); if (Number.isFinite(v)) tx('Tempo', (pp) => (r.i === 0 ? setTempoPoint(pp, 0, v) : moveTempoPoint(pp, r.i, null, v))); } },
        next ? { label: r.curve === 'linear' ? 'Jump to the next tempo (no ramp)' : 'Ramp to the next tempo', icon: 'timeline', onClick: () => tx('Tempo curve', (pp) => { if (!pp.tempoMap?.length) setTempoPoint(pp, 0, pp.bpm, 'jump'); setTempoCurve(pp, r.i, r.curve === 'linear' ? 'jump' : 'linear'); }) } : null,
        r.i > 0 ? { label: 'Move to bar…', icon: 'pencil', onClick: async () => { const bar = parseInt(await promptSheet('Bar', String(songTempoMap(store.get()).barAt(r.beat).bar + 1), { inputmode: 'numeric' }), 10); if (bar > 1) tx('Move tempo change', (pp) => moveTempoPoint(pp, r.i, songTempoMap(pp).barStart(bar - 1), null)); } } : null,
        r.i > 0 ? { label: 'Delete this tempo change', icon: 'trash', onClick: () => tx('Delete tempo change', (pp) => removeTempoPoint(pp, r.i)) } : null,
      ].filter(Boolean)));
      return b;
    }));
    meterList.replaceChildren(...meterRows(p).map((m) => {
      const b = h('button.pk-row-btn', { type: 'button' }, h('span.pk-row-name', `${m.num}/${m.den}`), h('span.pk-row-sub', m.bar === 0 ? 'Start' : m.label), icon('chevronRight', 16));
      b.addEventListener('click', () => actionSheet(m.bar === 0 ? 'Song meter' : `Meter at ${m.label}`, [
        ...[[4, 4], [3, 4], [6, 8], [5, 4], [7, 8], [2, 4]].map(([n, d]) => ({ label: `${n}/${d}`, checked: n === m.num && d === m.den, onClick: () => tx('Meter', (pp) => setMeter(pp, m.bar, n, d)) })),
        m.bar > 0 ? '-' : null,
        m.bar > 0 ? { label: 'Delete this meter change', icon: 'trash', onClick: () => tx('Delete meter change', (pp) => removeMeter(pp, m.bar)) } : null,
      ].filter(Boolean)));
      return b;
    }));
  });
  return sheet;
}

// ------------------------------------------------------------------------------------------- export
const XP_LS = 'daw3-export'; // shared with the desktop export dialog
const xpLoad = () => { try { return { ...EXPORT_DEFAULTS, ...JSON.parse(localStorage.getItem(XP_LS) || '{}') }; } catch { return { ...EXPORT_DEFAULTS }; } };
const xpSave = (o) => { try { localStorage.setItem(XP_LS, JSON.stringify(o)); } catch { /* */ } };

/** The desktop's pro export as a bottom sheet: format, loudness presets, range, stems; report after the render. */
export async function openExportSheet(app) {
  const { store, engine } = app;
  const o = xpLoad();
  const lossy = await import('../audio/export.js').then((m) => m.lossyFormats()).catch(() => []);
  if (EXPORT_FORMATS.find((f) => f.id === o.format)?.lossy && !lossy.includes(o.format)) o.format = 'wav24';
  if (o.range === 'selection' || o.range === 'custom') o.range = 'song';
  const body = h('div.pk-xp');
  const summary = h('div.pk-xp-sum');
  const out = h('div.pk-xp-out');
  const set = (k, v) => { o[k] = v; xpSave(o); render(); };
  const loudVal = () => (o.normalize === 'lufs' ? o.preset : o.normalize);
  function render() {
    const p = store.get();
    const r = resolveRange(p, { range: o.range });
    const formats = EXPORT_FORMATS.filter((f) => !f.lossy || lossy.includes(f.id)).map((f) => ({ value: f.id, label: f.label.replace(/ \(.*\)/, '') }));
    const loud = [{ value: 'off', label: 'As mixed' }, { value: 'peak', label: 'Peak −1 dB' }, ...LOUDNESS_PRESETS.map((x) => ({ value: x.id, label: x.label }))];
    const stems = stemTargets(p, { which: 'all' });
    body.replaceChildren(
      h('div.pk-label.pk-pad', 'Loudness'),
      chips(loud, loudVal(), (v) => {
        if (v === 'off' || v === 'peak') { o.normalize = v; if (v === 'peak') o.target = -1; } else { const pr = LOUDNESS_PRESETS.find((x) => x.id === v); o.normalize = 'lufs'; o.preset = v; o.target = pr.lufs; o.ceiling = pr.ceiling; }
        xpSave(o); render();
      }, { cls: 'small' }),
      h('div.pk-label.pk-pad', 'Format'),
      chips(formats, o.format, (v) => set('format', v), { cls: 'small' }),
      h('div.pk-label.pk-pad', 'Sample rate'),
      chips(EXPORT_SAMPLE_RATES.slice(0, 2).map((s) => ({ value: s, label: `${(s / 1000).toFixed(1).replace('.0', '')} kHz` })), o.sampleRate, (v) => set('sampleRate', v), { cls: 'small' }),
      h('div.pk-label.pk-pad', 'Range'),
      chips([{ value: 'song', label: 'Whole song' }, ...(p.loop?.end > p.loop?.start ? [{ value: 'loop', label: 'Loop region' }] : [])], o.range, (v) => set('range', v), { cls: 'small' }),
      h('div.pk-label.pk-pad', 'Stems'),
      chips([{ value: 'none', label: 'Mix only' }, { value: 'all', label: `Mix + ${stems.length} stems (zip)` }, { value: 'buses', label: 'Buses' }], o.stems, (v) => set('stems', v), { cls: 'small' }),
      h('p.pk-hint', `${r.label} · ${rangeSeconds(p, r).toFixed(1)} s · tail ${o.tail === 'none' ? 'cut' : 'auto'}`),
    );
    const fmt = EXPORT_FORMATS.find((f) => f.id === o.format) || EXPORT_FORMATS[1];
    summary.replaceChildren(h('div', h('b', `${formatFileName(o.nameTemplate, { project: p, title: o.title, artist: o.artist })}.${fmt.ext}`)),
      h('div.pk-row-sub', o.normalize === 'lufs' ? `${o.target} LUFS integrated · true peak ≤ ${o.ceiling} dBTP` : o.normalize === 'peak' ? 'Normalized to −1 dBTP true peak' : 'As mixed (no loudness processing)'));
  }
  let busy = false;
  const go = async () => {
    if (busy) return;
    busy = true;
    exportBtn.disabled = true;
    const fill = h('div.pk-progress-fill');
    const status = h('div.pk-row-sub', 'Preparing…');
    out.replaceChildren(status, h('div.pk-progress', fill));
    try {
      await app.actions?.ensureAudio?.();
      const { runExport } = await import('../audio/export.js');
      const { renderOffline } = await import('../audio/render.js');
      const { downloadBlob } = await import('../io/project-file.js');
      const p = store.get();
      const res = await runExport({
        project: p, opts: { ...o, selectedIds: [] },
        render: (proj, ro) => renderOffline(proj, { ...ro, sampleCache: engine.buffers, onError: (e) => console.warn('[export]', e) }),
        onProgress: (f, msg) => { fill.style.width = `${Math.round(f * 100)}%`; status.textContent = msg; },
      });
      const files = res.files;
      if (files.length > 1) {
        const { writeZip } = await import('../io/interchange/zip.js');
        const zip = await writeZip([...files.map((f) => ({ name: f.name, data: new Uint8Array(f.data), compress: false })), { name: 'export-report.txt', data: res.report.text }]);
        downloadBlob(new Blob([zip], { type: 'application/zip' }), `${formatFileName(o.nameTemplate, { project: p })}.zip`);
      } else if (files.length) downloadBlob(new Blob([files[0].data], { type: files[0].mime }), files[0].name);
      app.lastExport = res;
      const rep = res.report;
      out.replaceChildren(h('div.pk-label.pk-pad', 'Export report'),
        rep.mix ? h('table.pk-xp-rep', rep.mix.rows.map(([k, v]) => h('tr', h('td', k), h('td', v)))) : null,
        rep.stems?.length ? h('div.pk-row-sub', `${rep.stems.length} stems in the zip`) : null);
      app.toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`, { level: 'success' });
    } catch (e) {
      console.error(e);
      out.replaceChildren(h('p.pk-p', `Export failed: ${e.message || e}`));
    } finally { busy = false; exportBtn.disabled = false; }
  };
  const exportBtn = bigButton('Export', go, { ic: 'download', cls: 'primary' });
  render();
  return openSheet({ title: 'Export audio', body: [body, summary, out], actions: exportBtn, tall: true, cls: 'pk-xp-sheet' });
}

// ------------------------------------------------------------------------------------------- version history
const fmtTime = (iso) => { const d = new Date(iso); return new Date().toDateString() === d.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

/** Version history (the last 20 snapshots of this project in this browser): tap = restore (undoable). */
export function openHistorySheet(app) {
  const { store, recovery } = app;
  const list = h('div.pk-list', h('p.pk-p', 'Loading…'));
  const saveBtn = bigButton('Save a version now', async () => { await recovery?.snapshot(store.get(), { label: 'manual', force: true }); fill(); app.toast('Version saved', { level: 'success' }); }, { ic: 'save' });
  const sheet = openSheet({ title: 'Version history', tall: true, body: [h('p.pk-p', 'daW³ keeps the last 20 versions of each project in this browser while you work. Restoring is undoable.'), list], actions: saveBtn });
  async function fill() {
    if (!recovery) { list.replaceChildren(h('p.pk-p', 'Version history isn’t available in this browser (no storage).')); return; }
    const snaps = await recovery.listSnapshots(store.get().id || null).catch(() => []);
    if (!snaps.length) { list.replaceChildren(h('p.pk-p', 'No versions yet — they appear as you work (every few seconds).')); return; }
    list.replaceChildren(...snaps.map((s) => {
      const b = h('button.pk-row-btn', { type: 'button' }, icon('history', 18), h('span.pk-row-name', `${fmtTime(s.at)} · ${s.name}`), h('span.pk-row-sub', `${ago(s.at)}${s.label === 'manual' ? ' · saved' : ''}`));
      b.addEventListener('click', async () => {
        if (!(await confirmSheet('Restore this version?', `Go back to “${s.name}” from ${fmtTime(s.at)}? Undo brings you back.`, 'Restore'))) return;
        const proj = await recovery.loadSnapshot(s.id);
        if (!proj) { app.toast('That version is gone', { level: 'error' }); return; }
        restoreProject(app, proj, `Restore version (${fmtTime(s.at)})`);
        sheet.close();
        app.toast(`Restored the version from ${fmtTime(s.at)} — Undo goes back`, { level: 'success' });
      });
      return b;
    }));
  }
  fill();
  return sheet;
}

// ------------------------------------------------------------------------------------------- MIDI devices
/** Hardware / MIDI devices (Web MIDI): list inputs and outputs, turn inputs on / off; enabled inputs play the selected track. */
export async function openMidiSheet(app) {
  const list = h('div.pk-list');
  const supported = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
  const sheet = openSheet({ title: 'MIDI devices', tall: true, body: [list] });
  if (!supported) {
    list.replaceChildren(h('p.pk-p', 'Web MIDI isn’t available in this browser (iPhone / iPad Safari don’t support it). Use Chrome on Android or a desktop browser to play daW³ from a MIDI keyboard.'));
    return sheet;
  }
  const mgr = await pocketMidi(app);
  const render = () => {
    if (!mgr.ready) {
      list.replaceChildren(h('p.pk-p', mgr.error ? `MIDI access was refused: ${mgr.error}` : 'Connect to see the MIDI keyboards and controllers plugged into this device.'),
        bigButton('Connect MIDI', async () => { try { await mgr.open(); } catch { /* error shown */ } render(); }, { ic: 'plug', cls: 'primary' }));
      return;
    }
    const ins = mgr.inputs(), outs = mgr.outputs();
    const row = (d, kind) => {
      const on = d.settings.enabled !== false;
      const b = h(`button.pk-row-btn${on ? '.on' : ''}`, { type: 'button' }, icon(kind === 'in' ? 'keyboard' : 'plug', 18),
        h('span.pk-row-name', d.name), h('span.pk-row-sub', `${d.state === 'disconnected' ? 'unplugged · ' : ''}${on ? 'on' : 'off'}`));
      b.addEventListener('click', () => { haptic(5); if (kind === 'in') mgr.setInputSettings(d.name, { enabled: !on }); else mgr.setOutputSettings(d.name, { enabled: !on }); render(); });
      return b;
    };
    list.replaceChildren(
      h('div.pk-label.pk-pad', `Inputs (${ins.length}) — play the selected track`),
      ...(ins.length ? ins.map((d) => row(d, 'in')) : [h('p.pk-p', 'No MIDI inputs — plug a keyboard in (USB / Bluetooth).')]),
      h('div.pk-label.pk-pad', `Outputs (${outs.length})`),
      ...(outs.length ? outs.map((d) => row(d, 'out')) : [h('p.pk-p', 'No MIDI outputs.')]),
    );
  };
  mgr.on('devices', render);
  render();
  return sheet;
}

async function pocketMidi(app) {
  if (app.pocketMidi) return app.pocketMidi;
  const { MidiDeviceManager } = await import('../control/devices.js');
  const mgr = new MidiDeviceManager({ requestAccess: (o) => navigator.requestMIDIAccess(o) });
  mgr.on('message', (_name, data) => {
    const [st, d1, d2] = data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) app.actions.liveNoteOn(d1, d2 / 127);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) app.actions.liveNoteOff(d1);
  });
  app.pocketMidi = mgr;
  return mgr;
}
