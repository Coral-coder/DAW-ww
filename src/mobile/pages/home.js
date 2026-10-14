// Pocket ▸ Create: genre + key, Generate song, Start a setlist, recent projects, open / save / share.
import { h, icon } from '../../ui/dom.js';
import { GENRES } from '../../gen/genres.js';
import { SCALES, pitchClassName } from '../../theory/index.js';
import { beatsPerBar, songLengthBeats } from '../../core/model.js';
import { serializeProject, downloadBlob, parseProjectFile } from '../../io/project-file.js';
import { encodeWav } from '../../io/wav.js';
import { exportMidi } from '../../io/midi.js';
import { listLocal, loadLocal, deleteLocal, saveLocal } from '../../io/autosave.js';
import { fileInput } from '../../ui/components.js';
import { pageShell, addTrackSheet } from './common.js';
import { actionSheet, bigButton, chips, openSheet, promptSheet, confirmSheet, onLongPress, haptic } from '../touch.js';

export const POCKET_SCALES = ['minor', 'major', 'dorian', 'mixolydian', 'phrygian', 'harmonic-minor', 'minor-pentatonic', 'blues'];

const safeName = (s, fb) => (String(s || '').replace(/[^\w\- ]+/g, '').trim() || fb);

/** Share a file through the iOS share sheet (Save to Files, AirDrop, Messages…) or download it. Call from a tap. */
export function shareFile(blob, filename, title) {
  const nat = globalThis.daw3Native; // iOS app: native share sheet (WKWebView has no file sharing)
  if (nat?.share) return blob.arrayBuffer().then((data) => nat.share({ name: filename, data: new Uint8Array(data), title })).catch((e) => console.error('[share]', e));
  try {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare?.({ files: [file] })) {
      return navigator.share({ files: [file], title }).catch((e) => { if (e?.name !== 'AbortError') downloadBlob(blob, filename); });
    }
  } catch { /* File / share unsupported */ }
  downloadBlob(blob, filename);
  return Promise.resolve();
}

export function createHomePage(app, nav) {
  const { store, actions, engine } = app;
  const get = () => store.get();
  const p0 = get();
  const opts = { genre: p0.genre && GENRES[p0.genre] ? p0.genre : 'house', root: p0.key?.root ?? null, scale: p0.key?.scale || 'minor' };
  if (!p0.tracks.length) opts.root = null;

  const { el, body } = pageShell('daW³ Pocket');
  const projName = h('button.pk-proj-name', { type: 'button' });
  const projInfo = h('div.pk-proj-info');
  projName.addEventListener('click', async () => { const n = await promptSheet('Project name', get().name); if (n) store.transact('Rename project', (p) => { p.name = n; }); });

  const genreBtn = h('button.pk-select', { type: 'button' });
  genreBtn.addEventListener('click', () => {
    const fams = {};
    for (const [id, g] of Object.entries(GENRES)) (fams[g.family || 'other'] ||= []).push({ label: g.name, checked: id === opts.genre, onClick: () => { opts.genre = id; sync(); } });
    actionSheet('Genre', Object.entries(fams).map(([f, items]) => ({ label: f[0].toUpperCase() + f.slice(1), submenu: items })));
  });
  const rootChips = chips([{ value: null, label: 'Any' }, ...Array.from({ length: 12 }, (_, i) => ({ value: i, label: pitchClassName(i) }))], opts.root, (v) => { opts.root = v; }, { cls: 'keys' });
  const scaleChips = chips(POCKET_SCALES.filter((s) => SCALES[s]).map((s) => ({ value: s, label: SCALES[s].name })), opts.scale, (v) => { opts.scale = v; }, { cls: 'scroll' });

  const genBtn = bigButton('Generate a song', async () => {
    genBtn.disabled = true;
    try {
      await actions.generateSong({ genre: opts.genre, key: opts.root ?? undefined, scale: opts.root == null ? undefined : opts.scale });
      haptic(20);
      nav.go({ page: 'tracks' });
    } finally { genBtn.disabled = false; }
  }, { ic: 'wand', cls: 'primary huge' });
  const setBtn = bigButton('Start a setlist', async () => {
    const p = get();
    if (p.tracks.length && !app.setlist?.active && !(await confirmSheet('Start a setlist?', 'The set replaces the current song (it stays in Recent below).', 'Start'))) return;
    const m = await import('./setlist.js');
    nav.go({ page: 'setlist' });
    m.startSet(app, { genre: opts.genre, key: { root: opts.root ?? Math.floor(Math.random() * 12), scale: opts.scale } });
  }, { ic: 'timeline', cls: 'huge' });
  const humBtn = bigButton('Hum a melody', () => app.openHum?.(), { ic: 'music' });
  const emptyBtn = bigButton('New empty song', async () => {
    if (get().tracks.length && !(await confirmSheet('New song?', 'Start an empty song? The current one stays in Recent.', 'New song'))) return;
    await actions.newProject({ confirm: false });
    store.transact('Genre', (p) => { p.genre = opts.genre; if (opts.root != null) p.key = { root: opts.root, scale: opts.scale }; p.bpm = GENRES[opts.genre]?.defaultBpm || p.bpm; });
    nav.go({ page: 'tracks' });
  }, { ic: 'file' });
  const addBtn = bigButton('Add a track', () => addTrackSheet(app, (t) => nav.go({ page: 'track', id: t.id })), { ic: 'plus' });

  // files
  const openBtn = bigButton('Open', () => openFile(), { ic: 'folder' });
  const saveBtn = bigButton('Save / share', () => shareProject(), { ic: 'save' });
  const wavBtn = bigButton('Share as WAV', () => shareWav(), { ic: 'wave' });
  const midiBtn = bigButton('MIDI', () => { const p = get(); shareFile(new Blob([exportMidi(p, { mode: p.mode === 'song' && p.clips.length ? 'song' : 'pattern' })], { type: 'audio/midi' }), `${safeName(p.name, 'song')}.mid`, p.name); }, { ic: 'music' });

  const recentEl = h('div.pk-list');
  body.append(
    h('div.pk-card.pk-proj', projName, projInfo),
    h('div.pk-card',
      h('div.pk-label', 'Genre'), genreBtn,
      h('div.pk-label', 'Key'), rootChips, scaleChips,
      genBtn, setBtn),
    h('div.pk-grid2', humBtn, addBtn, emptyBtn, openBtn),
    h('div.pk-card', h('div.pk-label', 'Save & share'), h('div.pk-grid3', saveBtn, wavBtn, midiBtn)),
    h('div.pk-card', h('div.pk-label', 'Recent songs (on this device)'), recentEl),
  );

  async function openFile() {
    const [file] = await fileInput('.daW3,.daw3,.json,application/json,application/octet-stream');
    if (!file) return;
    try { actions.loadProjectObject(parseProjectFile(await file.text()), 'Opened'); nav.go({ page: 'tracks' }); } catch (e) { app.toast('Could not open: ' + e.message, { level: 'error' }); }
  }
  function shareProject() {
    const p = get();
    saveLocal(p).catch(() => {});
    shareFile(new Blob([serializeProject(p)], { type: 'application/json' }), `${safeName(p.name, 'project')}.daW3`, p.name);
  }
  async function shareWav() {
    await actions.ensureAudio();
    const p = get();
    const songMode = p.mode === 'song' && p.clips.length;
    const bpb = beatsPerBar(p);
    const endBeat = songMode ? songLengthBeats(p) : Math.max(bpb * 4, ...p.tracks.map((t) => p.patterns[t.activePatternId]?.length || 0));
    const wait = openSheet({ title: 'Rendering…', body: h('p.pk-p', `Mixing ${Math.round(endBeat / bpb)} bars at ${p.bpm} BPM…`) });
    try {
      const buf = await engine.renderOffline({ startBeat: 0, endBeat, stems: false, mode: songMode ? 'song' : 'pattern' });
      wait.close();
      const blob = new Blob([encodeWav(buf, { bitDepth: 16 })], { type: 'audio/wav' });
      const name = `${safeName(p.name, 'mix')}.wav`;
      // share needs a fresh tap on iOS
      const s = openSheet({ title: 'Your mix is ready', body: h('p.pk-p', `${name} · ${(blob.size / 1e6).toFixed(1)} MB`), actions: h('div.pk-row', bigButton('Download', () => { downloadBlob(blob, name); s.close(); }), bigButton('Share', () => { shareFile(blob, name, p.name); s.close(); }, { cls: 'primary', ic: 'upload' })) });
    } catch (e) {
      wait.close();
      app.toast('Render failed: ' + e.message, { level: 'error' });
    }
  }

  async function renderRecent() {
    const list = (await listLocal().catch(() => [])) || [];
    list.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    recentEl.replaceChildren(...list.slice(0, 12).map((item) => {
      const b = h('button.pk-row-btn', { type: 'button' }, icon('file', 18), h('span.pk-row-name', item.name || 'Untitled'), h('span.pk-row-sub', new Date(item.modifiedAt).toLocaleDateString()));
      b.addEventListener('click', async () => { const pr = await loadLocal(item.id); if (pr) { actions.loadProjectObject(pr, 'Opened'); nav.go({ page: 'tracks' }); } });
      onLongPress(b, () => actionSheet(item.name, [{ label: 'Delete from this device', icon: 'trash', onClick: async () => { await deleteLocal(item.id); renderRecent(); } }]));
      return b;
    }));
    if (!list.length) recentEl.appendChild(h('p.pk-p.muted', 'Songs you make are kept here automatically.'));
  }

  function sync() {
    const p = get();
    projName.replaceChildren(h('span', p.name || 'Untitled'), icon('pencil', 14));
    projInfo.textContent = `${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'} · ${p.bpm} BPM · ${pitchClassName(p.key.root)} ${SCALES[p.key.scale]?.name || p.key.scale}`;
    genreBtn.replaceChildren(h('span', GENRES[opts.genre]?.name || opts.genre), icon('chevronDown', 16));
  }
  let visible = false;
  app.subscribe((r) => { if (visible && r.project) sync(); });
  return { el, show() { visible = true; sync(); renderRecent(); }, hide() { visible = false; } };
}
