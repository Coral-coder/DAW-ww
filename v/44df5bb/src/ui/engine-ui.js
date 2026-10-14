// Engine UI: status-bar health meter (DSP load / dropouts / latency / PDC), Panic, sample-rate choice, track freeze /
// bounce / flatten menu items + the mixer's freeze button, the frozen-edit hint, crash recovery on boot and the
// version-history dialog. Installed once by app.js (installEngineUi); actions.js / mixer.js only call the exports.
import { h, icon } from './dom.js';
import { toast, modal, button, contextMenu, confirmDialog } from './components.js';
import { SAMPLE_RATES } from '../audio/engine.js';
import { isFrozen, frozenStaleReason, FROZEN_HINT } from '../core/freeze.js';
import { createRecovery } from '../io/recovery.js';
import { ensureProjectId } from '../io/autosave.js';
import { normalizeProject } from '../core/model.js';

const SR_KEY = 'daw3-sample-rate';
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* */ } },
};

const fmtTime = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

// ---------------------------------------------------------------------------------------------- freeze
const MODE_LABEL = { preFx: 'instrument only (inserts stay live)', postFx: 'instrument + inserts', postFader: 'post-fader (incl. volume / pan)' };

async function runBusy(app, label, fn) {
  app.setStatus?.(`${label}…`);
  const t = setTimeout(() => toast(`${label}…`, { timeout: 2500 }), 250);
  try {
    const r = await fn();
    return r;
  } catch (e) {
    console.error(e);
    toast(`${label} failed: ${e.message || e}`, { level: 'error', timeout: 7000 });
    return null;
  } finally {
    clearTimeout(t);
    app.setStatus?.('Ready.');
  }
}

export async function freezeTrack(app, trackId, mode = 'postFx') {
  await app.engine.init();
  const r = await runBusy(app, 'Freezing track', () => app.engine.freezeTrack(trackId, { mode }));
  if (r) toast(`Track frozen (${MODE_LABEL[mode]}) — its instrument${mode === 'preFx' ? '' : ' and inserts'} no longer use CPU`, { level: 'success' });
  return r;
}

export function unfreezeTrack(app, trackId) {
  if (app.engine.unfreezeTrack(trackId)) toast('Track unfrozen — editable again', { level: 'success' });
}

export async function bounceTrack(app, trackId, mode = 'postFader') {
  await app.engine.init();
  const id = await runBusy(app, 'Bouncing track', () => app.engine.bounceTrack(trackId, { mode }));
  if (id) { toast('Bounced to a new audio track (the original is muted)', { level: 'success' }); app.actions?.selectTrack?.(id); }
  return id;
}

export async function flattenTrack(app, trackId, mode = 'postFx') {
  const t = app.store.get().tracks.find((x) => x.id === trackId);
  if (!t) return null;
  const ok = await confirmDialog('Flatten track', `Replace "${t.name}" by audio of its ${MODE_LABEL[mode]}? Its notes, instrument${mode === 'preFx' ? '' : ' and baked inserts'} are removed (Undo brings them back).`);
  if (!ok) return null;
  await app.engine.init();
  const r = await runBusy(app, 'Flattening track', () => app.engine.flattenTrack(trackId, { mode }));
  if (r) toast('Track flattened to audio', { level: 'success' });
  return r;
}

/** Track context-menu items (actions.trackMenuItems appends these). */
export function freezeMenuItems(app, trackId) {
  const p = app.store.get();
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return [];
  const audioInPattern = t.type === 'audio' && p.mode === 'pattern';
  const items = [{ header: 'Freeze / bounce' }];
  if (isFrozen(t)) {
    const stale = frozenStaleReason(p, t);
    items.push({ label: 'Unfreeze', icon: 'snow', onClick: () => unfreezeTrack(app, trackId) });
    if (stale) items.push({ label: 'Freeze again (update)', icon: 'snow', onClick: () => freezeTrack(app, trackId, t.frozen.mode) });
  } else {
    items.push({ label: 'Freeze', icon: 'snow', disabled: audioInPattern, onClick: () => freezeTrack(app, trackId, 'postFx') });
    items.push({ label: 'Freeze…', submenu: ['preFx', 'postFx', 'postFader'].map((m) => ({ label: `Freeze ${MODE_LABEL[m]}`, onClick: () => freezeTrack(app, trackId, m) })) });
  }
  items.push({ label: 'Bounce to new audio track', icon: 'wave', onClick: () => bounceTrack(app, trackId, 'postFader'), submenu: undefined });
  items.push({ label: 'Bounce…', submenu: ['postFader', 'postFx', 'preFx'].map((m) => ({ label: `Bounce ${MODE_LABEL[m]}`, onClick: () => bounceTrack(app, trackId, m) })) });
  if (t.type !== 'audio' || (t.fx || []).length) items.push({ label: 'Flatten (commit to audio)…', icon: 'layers', onClick: () => flattenTrack(app, trackId, 'postFx') });
  return items;
}

/** The mixer strip's ❄ button: click = freeze / unfreeze, right-click = freeze / bounce options. */
export function freezeButton(app, track) {
  const frozen = isFrozen(track);
  const stale = frozen ? frozenStaleReason(app.store.get(), track) : null;
  const b = h(`button.toggle.mx-btn.mx-freeze${frozen ? '.on' : ''}${stale ? '.stale' : ''}`, {
    type: 'button',
    title: frozen ? (stale ? `Frozen, but plays live: ${stale}` : `Frozen (${MODE_LABEL[track.frozen.mode] || track.frozen.mode}) — click to unfreeze`) : 'Freeze: render this track to audio so its instrument and inserts stop using CPU (right-click for options)',
  }, icon('snow', 12));
  b.addEventListener('click', (e) => { e.stopPropagation(); if (isFrozen(track)) unfreezeTrack(app, track.id); else freezeTrack(app, track.id, 'postFx'); });
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); contextMenu(e, freezeMenuItems(app, track.id)); });
  return b;
}

// ---------------------------------------------------------------------------------------------- status bar
function statusWidget(app) {
  const { engine } = app;
  const load = h('span.eng-load', { title: 'DSP load (where the browser reports it)' }, '');
  const xr = h('span.eng-xruns', { title: 'Audio dropouts (buffer underruns) and late scheduler windows since the audio started' }, '');
  const lat = h('span.eng-lat', { title: 'Output latency (device) + plugin delay compensation' }, '');
  const srSel = h('select.eng-sr', { title: 'Sample rate of the audio engine (the device decides what is possible)' },
    h('option', { value: '' }, 'Auto'), ...SAMPLE_RATES.map((r) => h('option', { value: String(r) }, `${(r / 1000).toFixed(1)} kHz`)));
  srSel.value = ls.get(SR_KEY) || '';
  srSel.addEventListener('change', async () => {
    const v = srSel.value ? Number(srSel.value) : null;
    ls.set(SR_KEY, v ? String(v) : null);
    try {
      const got = await engine.setSampleRate(v);
      if (got && v && got !== v) toast(`The device runs at ${(got / 1000).toFixed(1)} kHz`, { level: 'warn' });
      else toast(v ? `Audio engine at ${(v / 1000).toFixed(1)} kHz` : 'Audio engine at the device rate', { level: 'success' });
    } catch (e) { toast(`Could not switch the sample rate: ${e.message || e}`, { level: 'error' }); }
  });
  const panic = h('button.eng-panic', { type: 'button', title: 'Panic: all notes off, cut every tail (Shift+Esc)' }, 'Panic');
  panic.addEventListener('click', () => { engine.panic(); toast('All notes off'); });
  const el = h('span.eng-status', icon('gauge', 12), load, xr, lat, srSel, panic);
  const tick = () => {
    if (!engine.ctx) { load.textContent = 'audio idle'; xr.textContent = ''; lat.textContent = ''; return; }
    const m = engine.getMetrics();
    load.textContent = m.load != null ? `DSP ${Math.round(m.load * 100)}%` : `${(m.sampleRate / 1000).toFixed(1)} kHz`;
    load.classList.toggle('hot', m.load != null && m.load > 0.8);
    const drops = m.xruns + m.late;
    xr.textContent = `${drops} dropout${drops === 1 ? '' : 's'}${m.lateMs > 30 ? ` · late ${Math.round(m.lateMs)} ms` : ''}`;
    xr.classList.toggle('hot', drops > 0);
    lat.textContent = `${Math.round(m.latencyMs)} ms${m.pdcMs > 0.05 ? ` + PDC ${m.pdcMs.toFixed(1)} ms` : ''}`;
  };
  setInterval(tick, 500);
  tick();
  return el;
}

// ---------------------------------------------------------------------------------------------- recovery / history
export function showHistory(app) {
  const { store, recovery } = app;
  const p = store.get();
  const body = h('div.col.eng-history');
  const list = h('div.eng-history-list', h('p.muted', 'Loading…'));
  body.append(h('p.muted', 'daW³ keeps the last 20 versions of each project in this browser (every few seconds while you work, and whenever the tab is hidden). Restoring is undoable.'), list);
  const m = modal({
    title: `Version history — ${p.name}`, body, width: 620,
    actions: [{ label: 'Save a version now', onClick: async () => { await recovery.snapshot(store.get(), { label: 'manual', force: true }); fill(); return false; } }, { label: 'Close', primary: true }],
  });
  async function fill() {
    const snaps = await recovery.listSnapshots(store.get().id || null).catch(() => []);
    list.replaceChildren();
    if (!snaps.length) { list.appendChild(h('p.muted', 'No versions yet — they appear as you work.')); return; }
    for (const s of snaps) {
      const restore = button('Restore', async () => {
        const proj = await recovery.loadSnapshot(s.id);
        if (!proj) { toast('That version is gone', { level: 'error' }); return; }
        restoreProject(app, proj, `Restore version (${fmtTime(s.at)})`);
        m.close();
        toast(`Restored the version from ${fmtTime(s.at)} — Ctrl+Z goes back`, { level: 'success' });
      });
      list.appendChild(h('div.eng-history-row', h('span.eng-h-time', fmtTime(s.at)), h('span.muted', ago(s.at)), h('span.eng-h-label', s.label === 'manual' ? 'saved' : s.label === 'close' ? 'closed' : s.label === 'hidden' ? 'tab hidden' : 'auto'), h('span.eng-h-name', s.name), restore));
    }
  }
  fill();
}

/** Replace the project content by `proj` as one undoable step (keeps the project id; samples merged in). */
export function restoreProject(app, proj, label = 'Restore version') {
  const n = normalizeProject(proj);
  app.store.transact(label, (p) => {
    const id = p.id;
    const samples = { ...p.samples, ...n.samples };
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, n, { samples });
    if (id) p.id = id;
  }, { guard: false });
}

async function offerRecovery(app) {
  const { recovery, store } = app;
  const found = await recovery.findUnclean().catch(() => null);
  if (!found) return;
  const { session, snapshot } = found;
  const body = h('div.col',
    h('p', 'daW³ did not close cleanly last time (crash, killed tab or power loss).'),
    h('p', h('b', snapshot.name), ` — last saved ${fmtTime(snapshot.at)} (${ago(snapshot.at)}).`),
    h('p.muted', 'Recovering opens that version; the project currently open stays in Recent and in its version history.'));
  modal({
    title: 'Recover unsaved session', body, width: 480,
    actions: [
      { label: 'Discard', onClick: () => recovery.dismiss(session.id) },
      {
        label: `Recover (${fmtTime(snapshot.at)})`, primary: true,
        onClick: async () => {
          const proj = await recovery.loadSnapshot(snapshot.id);
          await recovery.dismiss(session.id);
          if (!proj) { toast('The recovery data is gone', { level: 'error' }); return; }
          store.load(proj);
          const first = store.get().tracks[0];
          app.ui?.set?.({ selectedTrackId: first?.id || null, selectedPatternId: first?.activePatternId || null });
          toast(`Recovered "${proj.name}" from ${fmtTime(snapshot.at)}`, { level: 'success' });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------- install
/**
 * Called by app.js after the actions exist and before boot. Returns { afterBoot() } — app.js calls it once the last
 * session was restored (recovery is offered then, and crash-safe snapshots start).
 */
export function installEngineUi(app, statusEl) {
  const { engine, store } = app;
  const sr = Number(ls.get(SR_KEY)) || null;
  if (sr) engine.sampleRate = sr;
  if (statusEl) statusEl.insertBefore(statusWidget(app), statusEl.lastChild);
  store.on('blocked', (b) => toast(b.message || FROZEN_HINT, { level: 'warn', timeout: 4500 }));
  engine.on('error', () => {});
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); engine.panic(); toast('All notes off'); } });
  app.recovery = createRecovery({ onError: (e) => console.warn('[recovery]', e) });
  app.showHistory = () => showHistory(app);
  app.freezeMenuItems = (trackId) => freezeMenuItems(app, trackId);
  return {
    async afterBoot() {
      try {
        await offerRecovery(app);
        ensureProjectId(store.get());
        store.on('load', (p) => ensureProjectId(p));
        app.recovery.start(store, { intervalMs: 10000 });
      } catch (e) { console.warn('[recovery] unavailable', e); }
    },
  };
}
