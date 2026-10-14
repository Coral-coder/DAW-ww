// Decks view: import music into a library (BPM / beat grid / key + Camelot / loudness / sections are
// analysed automatically), mix it on two decks (play / cue / sync / loops / hot cues / EQ / crossfader)
// and remix it: slice a loop to drum pads or a chromatic sampler, send slices or loops to the
// arrangement (warped to the project tempo, optionally pitch-kept and key-matched) or to the Setlist.
// Analysis: src/audio/analysis (pure), remix helpers: src/audio/remix.js, playback: src/audio/decks.js,
// library persistence: src/io/track-library.js.
import { h, icon, fitCanvas, cssVar } from '../dom.js';
import { button, iconButton, toggle, select, knob, contextMenu, fileInput } from '../components.js';
import { TrackLibrary, filesFromDataTransfer } from '../../io/track-library.js';
import { DeckMixer } from '../../audio/decks.js';
import { loopAt, beatIndexAt, beatTime, camelotRelation, scaleGrid, makeGrid, keyShiftToward, snapToGrid } from '../../audio/analysis/index.js';
import { projectKeyOf, planSlices, renderRegion, cutRendered, channelsToSample, slicePatternNotes, padKeyForSlice } from '../../audio/remix.js';
import { camelotOf } from '../../audio/analysis/key.js';
import { createClip, beatsPerBar } from '../../core/model.js';

const PREF_KEY = 'daw3-decks';
const RELATION_LABEL = { same: 'same key', adjacent: '±1', relative: 'relative', energy: '+2 energy' };
const fmtTime = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtBpm = (b) => (b ? (Math.abs(b - Math.round(b)) < 0.05 ? String(Math.round(b)) : b.toFixed(1)) : '–');

function loadPrefs() {
  try { return { keepPitch: true, matchKey: false, warp: true, sort: 'added', range: 8, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { keepPitch: true, matchKey: false, warp: true, sort: 'added', range: 8 }; }
}

export function createDecksView(app) {
  const { store, engine, actions, toast } = app;
  const lib = app.library || (app.library = new TrackLibrary());
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* */ } };
  let visible = false, raf = 0, mixer = null, query = '';

  async function ensureMixer() {
    if (mixer) return mixer;
    await engine.init();
    const dest = engine.graph?.master?.input || engine.ctx.destination;
    mixer = new DeckMixer(engine.ctx, dest);
    mixer.decks.forEach((d, i) => d.on('change', () => decks[i].refresh()));
    mixer.setCrossfader(+xfader.value);
    app.decks = mixer;
    return mixer;
  }

  // ------------------------------------------------------------------ toolbar
  const importBtn = button('Import music…', () => importDialog(), { icon: 'upload', primary: true, title: 'Add tracks (mp3 / wav / flac / m4a / ogg / aiff) to the library — or drop files / folders anywhere on this view' });
  const warpT = toggle({ label: 'Warp', value: prefs.warp, title: 'Slices / loops you send to the project are time-stretched to the project tempo', onChange: (v) => { prefs.warp = v; savePrefs(); } });
  const pitchT = toggle({ label: 'Keep pitch', value: prefs.keepPitch, title: 'Warp with a time-stretch (WSOLA) that keeps the pitch; off = vinyl-style resample (pitch follows tempo)', onChange: (v) => { prefs.keepPitch = v; savePrefs(); } });
  const keyT = toggle({ label: 'Match key', value: prefs.matchKey, title: 'Pitch-shift rendered slices toward the nearest Camelot-compatible key of the project', onChange: (v) => { prefs.matchKey = v; savePrefs(); } });
  const projInfo = h('span.dk-proj.muted', { title: 'Project tempo and key — slices are rendered to fit them' });
  const toolbar = h('div.view-toolbar.dk-toolbar', importBtn, h('span.dk-sep'), h('span.dk-lbl', 'Render'), warpT, pitchT, keyT, h('div.spacer'), projInfo);

  // ------------------------------------------------------------------ decks
  const xfader = h('input.dk-xfader', { type: 'range', min: -1, max: 1, step: 0.01, value: 0, title: 'Crossfader (double-click = centre)' });
  xfader.addEventListener('input', () => mixer?.setCrossfader(+xfader.value));
  xfader.addEventListener('dblclick', () => { xfader.value = 0; mixer?.setCrossfader(0); });
  const decks = [createDeckUI(0), createDeckUI(1)];
  const center = h('div.dk-center',
    h('div.dk-xf-row', h('b', 'A'), xfader, h('b', 'B')),
    h('div.dk-center-btns',
      button('Sync B → A', () => syncDeck(1, 0), { title: 'Match deck B tempo and beat phase to deck A' }),
      button('Sync A → B', () => syncDeck(0, 1), { title: 'Match deck A tempo and beat phase to deck B' })));
  const deckRow = h('div.dk-decks', decks[0].el, center, decks[1].el);

  // ------------------------------------------------------------------ library
  const search = h('input.dk-search', { type: 'search', placeholder: 'Search library…', title: 'Filter by title, key or Camelot code' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderLibrary(); });
  const sortSel = select({ options: [{ value: 'added', label: 'Recently added' }, { value: 'name', label: 'Title' }, { value: 'bpm', label: 'BPM' }, { value: 'camelot', label: 'Camelot key' }, { value: 'match', label: 'Best match for playing deck' }], value: prefs.sort, title: 'Sort the library', onChange: (v) => { prefs.sort = v; savePrefs(); renderLibrary(); } });
  const libCount = h('span.muted');
  const libBody = h('div.dk-lib-body');
  const empty = h('div.empty-state.dk-empty',
    h('h3', 'Import music to DJ and remix'),
    h('p', 'Drop audio files or whole folders here (or use Import music…). Every track is analysed for BPM and beat grid, musical key with its Camelot code, loudness and phrase sections. Load a track onto deck A or B, loop a few bars and slice it to pads, a sampler or the arrangement — warped to your project tempo.'),
    button('Import music…', () => importDialog(), { icon: 'upload', primary: true }));
  const libEl = h('div.dk-lib', h('div.dk-lib-head', h('b', 'Library'), libCount, h('div.spacer'), search, sortSel), libBody, empty);
  const el = h('div.dk', toolbar, h('div.dk-main', deckRow, libEl));

  // drag & drop of files / folders
  el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); el.classList.add('dk-drop'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dk-drop'); });
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); el.classList.remove('dk-drop');
    const files = await filesFromDataTransfer(e.dataTransfer);
    const nat = globalThis.daw3Native;
    if (nat?.pathForFile) for (const f of files) f.nativePath = nat.pathForFile(f) || null;
    if (files.length) importFiles(files); else toast('No audio files in that drop', { level: 'warn' });
  });

  async function importDialog() {
    const nat = globalThis.daw3Native;
    let files;
    if (nat?.openFiles) {
      const picked = await nat.openFiles({ title: 'Import music', kind: 'audio', multiple: true }).catch(() => null);
      files = (picked || []).map((f) => Object.assign(new File([f.data], f.name, { type: '' }), { nativePath: f.path || null }));
    } else files = await fileInput('audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus,.aif,.aiff', true);
    if (files?.length) importFiles(files);
  }
  async function importFiles(files) {
    const added = await lib.addFiles(files);
    toast(`Added ${added.length} track${added.length === 1 ? '' : 's'} — analysing BPM, key and phrases…`, { level: 'success' });
    renderLibrary();
    return added;
  }
  app.importMusic = importFiles; // used by the Mac app (File ▸ Import music…, Finder drops)

  // ------------------------------------------------------------------ deck UI
  function createDeckUI(i) {
    const name = 'AB'[i];
    const deck = () => mixer?.decks[i];
    const st = { trackId: null, hi: null, hiRate: 200 };
    const title = h('div.dk-title', 'Empty deck');
    const meta = h('div.dk-meta.muted', 'Load a track from the library ↓');
    const bpmEl = h('div.dk-bpm', '–');
    const timeEl = h('div.dk-time.muted');
    const zoom = h('canvas.dk-zoom', { title: 'Click to jump · the bright line is the playhead, bar lines are numbered' });
    const over = h('canvas.dk-over', { title: 'Whole track: sections, loop, cues — click to jump' });
    const playB = iconButton('play', async () => { await ensureMixer(); deck()?.toggle(); }, 'Play / pause');
    const cueB = button('CUE', async () => { await ensureMixer(); deck()?.cue(); }, { title: 'While playing: jump back to the cue point and stop. While stopped: set the cue point here.', cls: 'dk-cue' });
    const syncB = button('SYNC', () => syncDeck(i, 1 - i), { title: `Match this deck's tempo and beat phase to deck ${'AB'[1 - i]}` });
    const tempo = h('input.dk-tempo', { type: 'range', min: -16, max: 16, step: 0.05, value: 0, title: 'Tempo (pitch fader, ±16%) — double-click to reset' });
    const tempoVal = h('span.dk-tempo-val', '0.0%');
    tempo.addEventListener('input', async () => { await ensureMixer(); deck()?.setRate(1 + tempo.value / 100); });
    tempo.addEventListener('dblclick', () => { tempo.value = 0; deck()?.setRate(1); });
    const loopBtns = [1, 2, 4, 8, 16].map((bars) => {
      const b = h('button.dk-loop', { type: 'button', title: `Loop ${bars} bar${bars > 1 ? 's' : ''} from the nearest beat (click again to exit)` }, String(bars));
      b.addEventListener('click', async () => {
        await ensureMixer();
        const d = deck(); if (!d?.grid) return;
        if (d.loop?.bars === bars) { d.setLoop(null); return; }
        const L = d.loop ? { start: d.loop.start, end: d.loop.start + bars * d.grid.beatsPerBar * 60 / d.grid.bpm, bars } : loopAt(d.grid, d.position(), bars);
        d.setLoop(L);
        if (!d.playing && (d.position() < L.start || d.position() >= L.end)) d.seek(L.start);
      });
      b.dataset.bars = bars;
      return b;
    });
    const hot = [0, 1, 2, 3].map((k) => {
      const b = h('button.dk-hot', { type: 'button', title: `Hot cue ${k + 1}: click to set (empty) or jump; right-click to clear` }, String(k + 1));
      b.addEventListener('click', async () => { await ensureMixer(); deck()?.hotCue(k); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); deck()?.hotCue(k, { clear: true }); });
      return b;
    });
    const eqDef = (label) => ({ label, min: -26, max: 6, default: 0, step: 0.5, unit: 'dB' });
    const eq = ['high', 'mid', 'low'].map((band) => knob({ def: eqDef(band[0].toUpperCase() + band.slice(1)), value: 0, size: 30, onChange: (v) => deck()?.setEq(band, v) }));
    const vol = knob({ def: { label: 'Vol', min: 0, max: 1.2, default: 1, step: 0.01 }, value: 1, size: 30, onChange: (v) => deck()?.setFader(v) });
    const remixB = button('Remix', (e) => remixMenu(e, i), { icon: 'scissors', title: 'Slice the loop (or the next bars) to pads / sampler / arrangement / Setlist' });
    const moreB = iconButton('menu', (e) => deckMenu(e, i), 'Beat grid, tempo and key tools');
    const el = h(`div.dk-deck`, { dataset: { deck: name } },
      h('div.dk-head', h('span.dk-badge', name), h('div.dk-head-text', title, meta), h('div.dk-head-right', bpmEl, timeEl)),
      zoom, over,
      h('div.dk-row', cueB, playB, syncB, h('div.dk-tempo-wrap', tempo, tempoVal), remixB, moreB),
      h('div.dk-row', h('span.dk-lbl', 'Loop'), ...loopBtns, h('span.dk-sep'), h('span.dk-lbl', 'Hot'), ...hot, h('div.spacer'), ...eq, vol));

    const seekFromCanvas = async (canvas, e, isZoom) => {
      await ensureMixer();
      const d = deck(); if (!d?.buffer) return;
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      if (!isZoom) d.seek(fx * d.duration);
      else { const span = zoomSpan(d); d.seek(d.position() + (fx - 0.5) * span); }
    };
    zoom.addEventListener('pointerdown', (e) => seekFromCanvas(zoom, e, true));
    over.addEventListener('pointerdown', (e) => seekFromCanvas(over, e, false));

    async function loadTrack(trackId) {
      await ensureMixer();
      const t = lib.get(trackId);
      if (!t) return;
      if (!t.analysis) { toast('Still analysing — loading as soon as it is ready…'); await lib.analyze(trackId).catch(() => {}); }
      try {
        const audio = await lib.getAudio(trackId);
        const tt = lib.get(trackId);
        deck().load(tt, audio);
        st.trackId = trackId;
        st.hi = hiPeaks(audio, st.hiRate);
        tempo.value = 0;
        refresh();
        renderLibrary();
      } catch (e) { toast(`Could not load ${t.name}: ${e.message}`, { level: 'error' }); }
    }

    function refresh() {
      const d = deck();
      const t = d?.track;
      if (t) {
        const a = t.analysis || {};
        title.textContent = t.name;
        meta.textContent = [a.keyName && `${a.keyName} · ${a.camelot}`, a.lufs != null && `${a.lufs} LUFS`, `${fmtBpm(a.bpm)} BPM orig.`].filter(Boolean).join(' · ');
      }
      bpmEl.textContent = d?.grid ? fmtBpm(d.bpm) : '–';
      tempoVal.textContent = `${d ? ((d.rate - 1) * 100).toFixed(1) : '0.0'}%`;
      if (d && Math.abs(+tempo.value - (d.rate - 1) * 100) > 0.06) tempo.value = (d.rate - 1) * 100;
      playB.replaceChildren(icon(d?.playing ? 'pause' : 'play'));
      playB.classList.toggle('on', !!d?.playing);
      for (const b of loopBtns) b.classList.toggle('on', d?.loop?.bars === +b.dataset.bars);
      hot.forEach((b, k) => b.classList.toggle('set', d?.hotCues[k] != null));
    }

    function draw() {
      const d = deck();
      drawOverview(over, d, st);
      drawZoom(zoom, d, st);
      if (d) timeEl.textContent = `${fmtTime(d.position())} / -${fmtTime(d.duration - d.position())}`;
    }
    return { el, loadTrack, refresh, draw, st, deck };
  }

  const zoomSpan = (d) => (d?.grid ? (8 * d.grid.beatsPerBar * 60) / d.grid.bpm : 16);

  function hiPeaks(audio, rate) {
    const ch = audio.channels, n = Math.ceil(audio.duration * rate), w = audio.sampleRate / rate;
    const out = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let m = 0; const end = Math.min(ch[0].length, Math.floor((b + 1) * w));
      for (let i = Math.floor(b * w); i < end; i += 2) { const v = Math.abs(ch[0][i]) + (ch[1] ? Math.abs(ch[1][i]) : Math.abs(ch[0][i])); if (v > m) m = v; }
      out[b] = Math.min(1, m / 2);
    }
    return out;
  }

  const SECTION_COLORS = { intro: '--accent-2', build: '--warn', drop: '--accent-3', break: '--accent', outro: '--text-3' };
  function drawOverview(canvas, d, st) {
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = cssVar('--bg-2'); ctx.fillRect(0, 0, w, H);
    const a = d?.track?.analysis;
    if (!d?.buffer || !a) return;
    const dur = d.duration, x = (t) => (t / dur) * w;
    for (const s of a.sections || []) {
      ctx.fillStyle = cssVar(SECTION_COLORS[s.label] || '--accent'); ctx.globalAlpha = 0.18;
      const x0 = x(s.time), x1 = x(s.time + (s.bars || 0) * 4 * 60 / a.grid.bpm);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), 4); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = cssVar('--accent');
    const pk = a.peaks || [];
    for (let i = 0; i < pk.length; i++) { const hh = pk[i] * (H - 8); ctx.fillRect((i / pk.length) * w, 4 + (H - 4 - hh) / 2, Math.max(1, w / pk.length), hh); }
    // phrase lines (every 16 bars)
    const g = d.grid; ctx.fillStyle = cssVar('--text-3'); ctx.globalAlpha = 0.5;
    for (let b = 0; ; b += 16) { const t = beatTime(g, b * g.beatsPerBar); if (t > dur) break; ctx.fillRect(x(t), 0, 1, H); }
    ctx.globalAlpha = 1;
    if (d.loop) { ctx.fillStyle = cssVar('--good'); ctx.globalAlpha = 0.3; ctx.fillRect(x(d.loop.start), 0, Math.max(2, x(d.loop.end) - x(d.loop.start)), H); ctx.globalAlpha = 1; }
    ctx.fillStyle = cssVar('--warn'); ctx.fillRect(x(d.cuePoint) - 1, 0, 2, H);
    d.hotCues.forEach((c, k) => { if (c != null) { ctx.fillStyle = cssVar('--accent-3'); ctx.fillRect(x(c), H - 7, 6, 7); ctx.fillText?.(String(k + 1), x(c) + 7, H - 1); } });
    ctx.fillStyle = cssVar('--text'); ctx.fillRect(x(d.position()) - 1, 0, 2, H);
  }

  function drawZoom(canvas, d, st) {
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.fillStyle = cssVar('--bg-2'); ctx.fillRect(0, 0, w, H);
    if (!d?.buffer || !st.hi) {
      ctx.fillStyle = cssVar('--text-3'); ctx.font = '12px sans-serif'; ctx.fillText(d?.buffer ? '' : `Deck ${d?.name || ''} — load a track from the library`, 10, H / 2 + 4); return;
    }
    const span = zoomSpan(d), pos = d.position(), t0 = pos - span / 2;
    const px = (t) => ((t - t0) / span) * w;
    if (d.loop) { ctx.fillStyle = cssVar('--good'); ctx.globalAlpha = 0.18; ctx.fillRect(px(d.loop.start), 0, px(d.loop.end) - px(d.loop.start), H); ctx.globalAlpha = 1; }
    const g = d.grid;
    if (g) {
      const b0 = Math.floor(beatIndexAt(g, t0)), b1 = Math.ceil(beatIndexAt(g, t0 + span));
      ctx.font = '10px sans-serif';
      for (let b = b0; b <= b1; b++) {
        const xx = px(beatTime(g, b)), bar = ((b % g.beatsPerBar) + g.beatsPerBar) % g.beatsPerBar === 0;
        ctx.fillStyle = cssVar(bar ? '--grid-bar' : '--grid-beat'); ctx.fillRect(Math.round(xx), 0, bar ? 2 : 1, H);
        if (bar) { ctx.fillStyle = cssVar('--text-3'); ctx.fillText(String(Math.floor(b / g.beatsPerBar) + 1), xx + 3, 10); }
      }
    }
    ctx.fillStyle = cssVar('--accent-2');
    const hi = st.hi, rate = st.hiRate;
    for (let x = 0; x < w; x++) {
      const t = t0 + (x / w) * span;
      if (t < 0 || t > d.duration) continue;
      const i0 = Math.floor(t * rate), i1 = Math.max(i0 + 1, Math.floor((t + span / w) * rate));
      let m = 0; for (let i = i0; i < i1 && i < hi.length; i++) if (hi[i] > m) m = hi[i];
      const hh = m * (H - 14);
      ctx.fillRect(x, 12 + (H - 12 - hh) / 2, 1, hh);
    }
    d.hotCues.forEach((c) => { if (c != null) { ctx.fillStyle = cssVar('--accent-3'); ctx.fillRect(px(c), 0, 2, H); } });
    ctx.fillStyle = cssVar('--warn'); ctx.fillRect(px(d.cuePoint), 0, 1, H);
    ctx.fillStyle = cssVar('--text'); ctx.fillRect(w / 2 - 1, 0, 2, H);
  }

  async function syncDeck(i, j) {
    await ensureMixer();
    const [a, b] = [mixer.decks[i], mixer.decks[j]];
    if (!a.grid || !b.grid) { toast('Load tracks on both decks to sync', { level: 'warn' }); return; }
    a.syncTo(b);
  }

  // ------------------------------------------------------------------ menus
  function deckMenu(e, i) {
    const d = mixer?.decks[i], t = d?.track;
    if (!t?.analysis) { toast('Load a track first', { level: 'warn' }); return; }
    const a = t.analysis;
    const patch = (p) => { lib.updateAnalysis(t.id, p); d.track = lib.get(t.id); d.grid = d.track.analysis.grid; decks[i].refresh(); renderLibrary(); };
    contextMenu(e, [
      { header: `${t.name}` },
      { label: `Double tempo (${fmtBpm(a.bpm * 2)} BPM)`, onClick: () => patch({ bpm: a.bpm * 2, grid: scaleGrid(a.grid, 2) }) },
      { label: `Half tempo (${fmtBpm(a.bpm / 2)} BPM)`, onClick: () => patch({ bpm: a.bpm / 2, grid: scaleGrid(a.grid, 0.5) }) },
      { label: 'Set downbeat (bar 1) at the playhead', icon: 'magnet', onClick: () => { const tt = snapToGrid(a.grid, d.position()); patch({ grid: makeGrid(a.grid.bpm, tt, a.grid.beatsPerBar) }); } },
      { label: 'Re-analyse track', icon: 'wand', onClick: () => lib.analyze(t.id).then(() => { d.track = lib.get(t.id); d.grid = d.track.analysis.grid; decks[i].refresh(); }) },
      '-',
      { label: `Set project tempo to ${fmtBpm(d.bpm)} BPM`, icon: 'metronome', onClick: () => store.transact('Tempo from deck', (p) => { p.bpm = Math.round(d.bpm * 100) / 100; }) },
      { label: `Set project key to ${a.keyName}`, icon: 'music', onClick: () => store.transact('Key from deck', (p) => { p.key = { ...p.key, root: a.key.tonic, scale: a.key.mode === 'minor' ? 'minor' : 'major' }; }) },
    ]);
  }

  /** The region the remix menu works on: the active loop, else `prefs.range` bars from the nearest bar. */
  function remixRegion(d) {
    if (d.loop) return { start: d.loop.start, end: d.loop.end, bars: d.loop.bars };
    const start = Math.max(0, snapToGrid(d.grid, d.position(), d.grid.beatsPerBar, 'round'));
    return { ...loopAt(d.grid, start, prefs.range), start };
  }

  function remixMenu(e, i) {
    const d = mixer?.decks[i];
    if (!d?.track?.analysis) { toast('Load a track first', { level: 'warn' }); return; }
    const reg = remixRegion(d);
    const bars = Math.round((reg.end - reg.start) * d.grid.bpm / 60 / d.grid.beatsPerBar);
    const setlistOk = typeof app.setlist?.addSampleLayer === 'function';
    contextMenu(e, [
      { header: d.loop ? `Loop: ${bars} bar${bars > 1 ? 's' : ''}` : `Next ${bars} bars (set a loop to choose)` },
      { label: 'Slice to drum pads', icon: 'drum', submenu: [
        { label: 'Every beat', onClick: () => doRemix(i, 'pads', 'beat') },
        { label: 'Every ½ beat', onClick: () => doRemix(i, 'pads', 'half') },
        { label: 'On transients', onClick: () => doRemix(i, 'pads', 'transient') },
        { label: 'Every bar', onClick: () => doRemix(i, 'pads', 'bar') },
      ] },
      { label: 'Slice to sampler (chromatic, C4 up)', icon: 'piano', submenu: [
        { label: 'Every beat', onClick: () => doRemix(i, 'sampler', 'beat') },
        { label: 'Every ½ beat', onClick: () => doRemix(i, 'sampler', 'half') },
        { label: 'Every bar', onClick: () => doRemix(i, 'sampler', 'bar') },
      ] },
      { label: 'Send slices to arrangement', icon: 'timeline', submenu: [
        { label: 'Beats', onClick: () => doRemix(i, 'clips', 'beat') },
        { label: 'Bars', onClick: () => doRemix(i, 'clips', 'bar') },
        { label: 'Transients', onClick: () => doRemix(i, 'clips', 'transient') },
      ] },
      { label: 'Send loop to arrangement', icon: 'wave', onClick: () => doRemix(i, 'loop') },
      { label: setlistOk ? 'Send loop to Setlist' : 'Send loop to Setlist (open the Setlist view first)', icon: 'sparkles', disabled: !setlistOk, onClick: () => doRemix(i, 'setlist') },
      '-',
      { header: 'Region when no loop is set' },
      ...[2, 4, 8, 16].map((n) => ({ label: `${n} bars${prefs.range === n ? '  ✓' : ''}`, onClick: () => { prefs.range = n; savePrefs(); } })),
    ]);
  }

  async function doRemix(i, target, mode = 'beat') {
    const d = mixer.decks[i], t = d.track, a = t.analysis;
    const region = remixRegion(d);
    const p = store.get();
    const projectKey = projectKeyOf(p);
    app.setStatus?.(`Rendering ${t.name}…`);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const audio = await lib.getAudio(t.id);
      const rendered = renderRegion(audio, a, region, { projectBpm: p.bpm, keepPitch: prefs.keepPitch, matchKey: prefs.matchKey, projectKey, warpTempo: prefs.warp });
      const shiftTxt = rendered.semitones ? ` (${rendered.semitones > 0 ? '+' : ''}${rendered.semitones} st)` : '';
      const beatsTotal = Math.round((region.end - region.start) * a.grid.bpm / 60 * 1000) / 1000;
      const bpb = beatsPerBar(p);
      const pos = engine.getPosition?.() || 0;
      const at = Math.max(0, Math.floor(pos / bpb) * bpb);
      if (target === 'loop' || target === 'setlist') {
        const smp = channelsToSample(rendered.channels, rendered.sampleRate, `${t.name} loop`);
        store.transact('Add loop sample', (pp) => { pp.samples[smp.id] = smp; });
        if (target === 'setlist') {
          await app.setlist.addSampleLayer({ sampleId: smp.id, name: `${t.name} loop`, beats: beatsTotal, bpm: p.bpm, key: a.key });
          toast(`Loop sent to the Setlist${shiftTxt}`, { level: 'success' });
        } else {
          const track = actions.addTrack('audio', { name: `${t.name} loop` });
          store.transact('Send loop to arrangement', (pp) => { pp.clips.push(createClip(track.id, { type: 'audio', sampleId: smp.id, start: at, length: beatsTotal, name: smp.name })); });
          toast(`Loop placed at bar ${at / bpb + 1} on "${track.name}"${shiftTxt}`, { level: 'success' });
        }
        return;
      }
      const slices = planSlices(a, region, mode, { max: target === 'clips' ? 64 : 16 });
      if (!slices.length) { toast('No slices found in that region', { level: 'warn' }); return; }
      if (target === 'sampler') {
        const smp = channelsToSample(rendered.channels, rendered.sampleRate, `${t.name} slices`);
        store.transact('Add slice sample', (pp) => { pp.samples[smp.id] = smp; });
        const track = actions.addTrack('sampler', { name: `${t.name} slices`, params: { sampleId: smp.id } });
        actions.updateTrack(track.id, (tt) => { Object.assign(tt.instrument.params, { sampleId: smp.id, slices: slices.length, rootNote: 60, oneShot: true, attack: 0.002, release: 0.02 }); }, 'Slice sampler', { undo: false });
        const pat = actions.ensurePattern(track.id);
        store.transact('Slice pattern', (pp) => { if (pp.patterns[pat.id]) pp.patterns[pat.id].length = Math.max(1, Math.ceil(beatsTotal)); }, { undo: false });
        actions.setPatternNotes(pat.id, slicePatternNotes(slices, { target: 'sampler', rootNote: 60 }), 'Slice pattern', { undo: false });
        actions.selectTrack?.(track.id);
        toast(`${slices.length} slices on a sampler (C4 = slice 1) — pattern replays the loop${shiftTxt}`, { level: 'success' });
        return;
      }
      const parts = cutRendered(rendered, slices, region.start);
      const samples = parts.map((chs, k) => channelsToSample(chs, rendered.sampleRate, `${t.name} ${k + 1}`));
      store.transact('Add slices', (pp) => { for (const s of samples) pp.samples[s.id] = s; });
      if (target === 'pads') {
        const track = actions.addTrack('drums', { name: `${t.name} pads` });
        actions.updateTrack(track.id, (tt) => {
          tt.instrument.params.pads = tt.instrument.params.pads || {};
          samples.forEach((s, k) => { const key = padKeyForSlice(k); tt.instrument.params.pads[key] = { ...(tt.instrument.params.pads[key] || {}), sampleId: s.id }; });
        }, 'Slice to pads', { undo: false });
        const pat = actions.ensurePattern(track.id);
        store.transact('Slice pattern', (pp) => { if (pp.patterns[pat.id]) pp.patterns[pat.id].length = Math.max(1, Math.ceil(beatsTotal)); }, { undo: false });
        actions.setPatternNotes(pat.id, slicePatternNotes(slices, { target: 'drums' }), 'Slice pattern', { undo: false });
        actions.selectTrack?.(track.id);
        toast(`${samples.length} slices on drum pads — the pattern replays the loop; rearrange it in the Step Rack / Piano Roll${shiftTxt}`, { level: 'success', timeout: 5000 });
      } else {
        const track = actions.addTrack('audio', { name: `${t.name} slices` });
        store.transact('Send slices to arrangement', (pp) => {
          slices.forEach((s, k) => pp.clips.push(createClip(track.id, { type: 'audio', sampleId: samples[k].id, start: at + s.beat, length: Math.max(0.05, s.beats), name: samples[k].name })));
        });
        toast(`${samples.length} slice clips at bar ${at / bpb + 1} on "${track.name}"${shiftTxt}`, { level: 'success' });
      }
    } catch (err) {
      console.error(err);
      toast(`Remix failed: ${err.message}`, { level: 'error' });
    } finally { app.setStatus?.('Ready.'); }
  }

  // ------------------------------------------------------------------ library list
  function referenceKey() {
    const d = mixer?.leadDeck?.();
    return d?.track?.analysis?.camelot ? { camelot: d.track.analysis.camelot, deck: d.name, bpm: d.bpm } : null;
  }

  function renderLibrary() {
    if (!visible) return;
    const ref = referenceKey();
    let rows = lib.list();
    if (query) rows = rows.filter((t) => `${t.name} ${t.analysis?.keyName || ''} ${t.analysis?.camelot || ''}`.toLowerCase().includes(query));
    const cam = (t) => { const c = t.analysis?.camelot; return c ? parseInt(c, 10) * 2 + (c.endsWith('B') ? 1 : 0) : 99; };
    const relRank = (t) => { const r = ref && t.analysis ? camelotRelation(ref.camelot, t.analysis.camelot) : null; return r === 'same' ? 0 : r === 'adjacent' ? 1 : r === 'relative' ? 2 : r === 'energy' ? 3 : 9; };
    const sorters = {
      added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      bpm: (a, b) => (a.analysis?.bpm || 999) - (b.analysis?.bpm || 999),
      camelot: (a, b) => cam(a) - cam(b),
      match: (a, b) => relRank(a) - relRank(b) || Math.abs((a.analysis?.bpm || 0) - (ref?.bpm || 0)) - Math.abs((b.analysis?.bpm || 0) - (ref?.bpm || 0)),
    };
    rows.sort(sorters[prefs.sort] || sorters.added);
    libCount.textContent = `${lib.tracks.size} track${lib.tracks.size === 1 ? '' : 's'}${ref ? ` · harmonic matches for deck ${ref.deck} (${ref.camelot}) highlighted` : ''}`;
    empty.hidden = lib.tracks.size > 0;
    libBody.hidden = lib.tracks.size === 0;
    const loaded = new Set(decks.map((dk) => dk.st.trackId));
    const head = h('div.dk-tr.dk-th', h('span'), h('span', 'Title'), h('span', 'BPM'), h('span', 'Key'), h('span', 'Camelot'), h('span', 'Length'), h('span', 'LUFS'), h('span', 'Overview'), h('span'));
    const list = rows.map((t) => {
      const a = t.analysis;
      const rel = ref && a ? camelotRelation(ref.camelot, a.camelot) : null;
      const shift = ref && a && !rel ? keyShiftToward(a.key, { tonic: keyFromCamelot(ref.camelot).tonic, mode: keyFromCamelot(ref.camelot).mode }) : null;
      const wave = h('canvas.dk-mini');
      const loadA = h('button.dk-load', { type: 'button', title: 'Load on deck A' }, 'A');
      const loadB = h('button.dk-load', { type: 'button', title: 'Load on deck B' }, 'B');
      loadA.addEventListener('click', () => decks[0].loadTrack(t.id));
      loadB.addEventListener('click', () => decks[1].loadTrack(t.id));
      const status = t.status === 'analyzing' ? `analysing ${Math.round((t.progress || 0) * 100)}%` : t.status === 'error' ? `error: ${t.error}` : t.status === 'pending' ? 'queued' : '';
      const row = h(`div.dk-tr${rel === 'same' || rel === 'adjacent' || rel === 'relative' ? '.dk-compat' : ''}${loaded.has(t.id) ? '.dk-loaded' : ''}`,
        { title: rel ? `Harmonic match with deck ${ref.deck}: ${RELATION_LABEL[rel]}` : shift?.relation ? `Shift ${shift.semitones > 0 ? '+' : ''}${shift.semitones} st to mix with deck ${ref.deck}` : t.fileName },
        h('span.dk-loadbtns', loadA, loadB),
        h('span.dk-name', t.name, status ? h('small.muted', ` ${status}`) : null, rel ? h('small.dk-rel', RELATION_LABEL[rel]) : null),
        h('span.dk-num', a ? fmtBpm(a.bpm) : '…'),
        h('span', a?.keyName || '…'),
        h('span.dk-cam', { style: a ? { '--cam-h': `${((parseInt(a.camelot, 10) - 1) * 30)}` } : {} }, a?.camelot || '…'),
        h('span.dk-num', a ? fmtTime(a.duration) : ''),
        h('span.dk-num', a?.lufs != null ? String(a.lufs) : ''),
        wave,
        iconButton('menu', (e) => contextMenu(e, [
          { label: 'Load on deck A', onClick: () => decks[0].loadTrack(t.id) },
          { label: 'Load on deck B', onClick: () => decks[1].loadTrack(t.id) },
          { label: 'Re-analyse', icon: 'wand', onClick: () => lib.analyze(t.id) },
          { label: 'Show in Finder', icon: 'folder', disabled: !globalThis.daw3Native?.revealInFinder || !t.path, onClick: () => globalThis.daw3Native.revealInFinder(t.path) },
          '-',
          { label: 'Remove from library', icon: 'trash', onClick: () => lib.remove(t.id) },
        ]), 'More'));
      row.addEventListener('dblclick', () => decks[mixer?.decks[0].playing && !mixer?.decks[1].playing ? 1 : 0].loadTrack(t.id));
      if (a?.peaks) requestAnimationFrame(() => drawMini(wave, a));
      return row;
    });
    libBody.replaceChildren(head, ...list);
  }

  const keyFromCamelot = (c) => { const n = parseInt(c, 10), minor = c.endsWith('A'); const majorPc = (((n - 8) * 7) % 12 + 12) % 12; return { tonic: minor ? (majorPc + 9) % 12 : majorPc, mode: minor ? 'minor' : 'major' }; };

  function drawMini(canvas, a) {
    if (!canvas.isConnected) return;
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = cssVar('--text-3');
    const pk = a.peaks;
    const step = pk.length / w;
    for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.floor(x * step); i < Math.floor((x + 1) * step); i++) m = Math.max(m, pk[i] || 0); const hh = Math.max(1, m * H); ctx.fillRect(x, (H - hh) / 2, 1, hh); }
    // beat grid: bar lines every 16 bars
    if (a.grid) { ctx.fillStyle = cssVar('--accent'); for (let b = 0; ; b += 16) { const t = beatTime(a.grid, b * a.grid.beatsPerBar); if (t > a.duration) break; ctx.fillRect((t / a.duration) * w, 0, 1, H); } }
  }

  // ------------------------------------------------------------------ lifecycle
  let libTimer = 0;
  lib.on('change', () => { clearTimeout(libTimer); libTimer = setTimeout(renderLibrary, 60); });
  lib.on('progress', () => { clearTimeout(libTimer); libTimer = setTimeout(renderLibrary, 250); });
  let lastLead = null;
  const loop = () => {
    if (!visible) { raf = 0; return; }
    for (const d of decks) d.draw();
    const lead = mixer?.leadDeck?.()?.track?.id || null;
    if (lead !== lastLead) { lastLead = lead; renderLibrary(); }
    raf = requestAnimationFrame(loop);
  };
  const updateProj = () => { const p = store.get(); const k = projectKeyOf(p); projInfo.textContent = `Project ${fmtBpm(p.bpm)} BPM · ${['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][k.tonic]} ${k.mode} (${camelotOf(k)})`; };
  app.subscribe((r) => { if (visible && r.project) updateProj(); });

  return {
    el,
    show() { visible = true; updateProj(); renderLibrary(); decks.forEach((d) => d.refresh()); if (!raf) raf = requestAnimationFrame(loop); },
    hide() { visible = false; },
  };
}
