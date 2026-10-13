// Setlist view: continuous DJ-style generation. Pick a genre + key, Start, and every layer loops while the next
// phrase is generated as a variation of what's playing; an energy arc brings layers in and out, key moves are
// quantized to phrase boundaries with a pivot bar. One column per layer (Ableton-session-like strips).
// Logic: src/live/setlist-engine.js (pure) + src/live/setlist-runner.js (store / engine glue).
import { h, icon, fitCanvas } from '../dom.js';
import { button, toggle, select, numberField, knob, fader, contextMenu, confirmDialog, markAuto } from '../components.js';
import { SCALES, pitchClassName } from '../../theory/index.js';
import { GENRES } from '../../gen/genres.js';
import { PRESETS, DRUM_KITS } from '../../audio/index.js';
import { SetlistRunner } from '../../live/setlist-runner.js';
import { SECTIONS, keyMoveOptions, keyName, camelot, nextSection, soundInfo, loopBarsFor } from '../../live/setlist-engine.js';
import { drawPatternNotes } from './arrange.js';

const SECTION_BTNS = [
  { id: 'intro', title: 'Strip back to an intro groove next phrase' },
  { id: 'groove', title: 'Steady groove: drums, bass, chords' },
  { id: 'build', title: 'Build: snare roll, risers, filters opening — leads into the drop' },
  { id: 'drop', title: 'Drop: everything in' },
  { id: 'breakdown', title: 'Breakdown: drums and bass out, pads / chords / lead' },
];
const MODE_LABEL = { auto: 'AUTO', on: 'ON', off: 'OFF' };
const MODE_NEXT = { auto: 'on', on: 'off', off: 'auto' };

export function createSetlistView(app) {
  const { store, ui, engine, actions } = app;
  const runner = app.setlist || (app.setlist = new SetlistRunner(app));
  const get = () => store.get();
  let visible = false;
  let raf = 0;
  const cols = new Map(); // layerId -> column api
  let colKey = '';

  const p0 = get();
  const startOpts = { genre: p0.genre && GENRES[p0.genre] ? p0.genre : 'tech-house', root: p0.key?.root ?? 0, scale: p0.key?.scale || 'minor', bpm: null, phraseBars: 8 };

  // ------------------------------------------------------------------ toolbar
  const genreSel = select({ options: Object.entries(GENRES).map(([id, g]) => ({ value: id, label: g.name, group: g.family || 'Other' })), value: startOpts.genre, title: 'Genre of the set (applies to a new set)', onChange: (v) => { startOpts.genre = v; startOpts.bpm = null; bpmField.setValue(GENRES[v]?.defaultBpm || 120); } });
  const rootSel = select({ options: Array.from({ length: 12 }, (_, i) => ({ value: i, label: pitchClassName(i) })), value: startOpts.root, title: 'Key root — while a set plays, picking a key moves there at the next phrase', onChange: (v) => { startOpts.root = Number(v); if (runner.active) { runner.setKey({ root: Number(v), scale: runner.state.pendingKey?.scale || runner.state.key.scale }); } } });
  const scaleOpts = ['minor', 'major', 'dorian', 'phrygian', 'mixolydian', 'harmonic-minor', 'lydian'].filter((s) => SCALES[s]).map((s) => ({ value: s, label: SCALES[s].name }));
  const scaleSel = select({ options: scaleOpts, value: scaleOpts.some((o) => o.value === startOpts.scale) ? startOpts.scale : 'minor', title: 'Scale — while a set plays, changes at the next phrase', onChange: (v) => { startOpts.scale = v; if (runner.active) runner.setKey({ root: runner.state.pendingKey?.root ?? runner.state.key.root, scale: v }); } });
  const bpmField = numberField({ value: GENRES[startOpts.genre]?.defaultBpm || 124, min: 60, max: 200, step: 1, width: 48, title: 'Tempo (BPM) — live', onChange: (v, { final }) => { startOpts.bpm = v; if (runner.active && final) store.transact('Tempo', (p) => { p.bpm = v; }, { coalesce: true }); } });
  const barsSel = select({ options: [{ value: 4, label: '4 bars' }, { value: 8, label: '8 bars' }, { value: 16, label: '16 bars' }], value: 8, title: 'Phrase length: how often the set moves on (new variations, sections, key moves land on phrase boundaries)', onChange: (v) => { startOpts.phraseBars = Number(v); runner.setPhraseBars(Number(v)); } });
  const startBtn = button('Start', () => onStart(), { icon: 'play', primary: true, title: 'Start a new set: generates every layer for the genre / key and plays it as endless, evolving loops' });
  const playBtn = button('Stop', () => (runner.running && engine.isPlaying ? runner.stop() : runner.resume()), { icon: 'stop', title: 'Stop / resume the set (Space works too)' });
  const captureBtn = button('Capture to arrangement', () => onCapture(), { icon: 'timeline', title: 'Write the set played so far into the song timeline (sections as markers) — export it like any song (.daW3 / WAV / MIDI)' });
  const addLoopBtn = button('＋ Add loop', () => onAddLoop(), { icon: 'wave', title: 'Import an audio loop and add it as a layer (joins at the next phrase, loops on the phrase grid, follows the energy arc). Bars are inferred from the project tempo and the file length (1 / 2 / 4 / 8 bars).' });
  let loopKeyShift = false;
  const loopShiftToggle = toggle({ label: 'Key-shift', value: false, title: 'New loops follow key moves (re-pitched on a sampler track, in semitones). Off: loops keep their pitch and are placed as audio clips.', onChange: (v) => { loopKeyShift = !!v; } });
  const statusEl = h('span.sl-status.muted');
  const toolbar = h('div.view-toolbar.sl-toolbar',
    h('label.sl-field', h('span', 'Genre'), genreSel), h('label.sl-field', h('span', 'Key'), rootSel, scaleSel),
    h('label.sl-field', h('span', 'BPM'), bpmField), h('label.sl-field', h('span', 'Phrase'), barsSel),
    startBtn, playBtn, captureBtn, addLoopBtn, loopShiftToggle, h('div.spacer'), statusEl);

  // ------------------------------------------------------------------ global strip
  const secName = h('div.sl-sec-name');
  const secNext = h('div.sl-sec-next.muted');
  const keyEl = h('div.sl-key');
  const progFill = h('div.sl-prog-fill');
  const progBar = h('div.sl-prog', { title: 'Progress to the next phrase' }, progFill);
  const phraseEl = h('span.muted');
  const now = h('div.sl-now', h('div.sl-now-row', secName, keyEl), h('div.sl-now-row', phraseEl, secNext), progBar);

  const secBtns = SECTION_BTNS.map((s) => {
    const b = h('button.sl-secbtn', { type: 'button', title: s.title + ' (at the next phrase)', dataset: { sec: s.id } }, SECTIONS[s.id].label);
    b.addEventListener('click', () => runner.queueSection(runner.state?.queued === s.id ? null : s.id));
    return b;
  });
  const holdBtn = toggle({ label: 'Keep groove', value: false, title: 'Hold the current section (no arc moves) until released', onChange: (v) => runner.setHold(v) });
  const energyDef = { key: 'energy', label: 'Energy', min: 0, max: 1, default: 0.7, step: 0.01 };
  const energyFader = fader({ def: energyDef, value: 0.7, vertical: false, length: 150, onChange: (v) => { runner.setEnergy(v); energyVal.textContent = Math.round(v * 100) + '%'; } });
  const energyVal = h('span.sl-energy-val', '70%');
  const freshDef = { key: 'freshness', label: 'Freshness', min: 0, max: 1, default: 0.5, step: 0.01 };
  const freshVal = h('span.sl-energy-val', '50%');
  const freshFader = fader({ def: freshDef, value: 0.5, vertical: false, length: 150, onChange: (v) => { runner.setFreshness(v); freshVal.textContent = Math.round(v * 100) + '%'; } });
  freshFader.title = 'Freshness: how often layers rotate to a new sound and how far their settings drift (0 = static sounds, 100 % = twice as often, wider drift)';
  const sections = h('div.sl-group', h('div.sl-glabel', 'Next section'), h('div.sl-row', ...secBtns, holdBtn), h('div.sl-row', h('span.sl-glabel', 'Energy'), energyFader, energyVal),
    h('div.sl-row', h('span.sl-glabel', 'Freshness'), freshFader, freshVal));

  const keyBtns = h('div.sl-keymoves');
  const keyQueued = h('div.sl-keyq');
  const driftToggle = toggle({ label: 'Auto-drift', value: false, title: 'Every N phrases, drift to a Camelot neighbour (harmonic mixing)', onChange: (v) => runner.setAutoDrift(v) });
  const driftEvery = select({ options: [2, 4, 8, 16].map((n) => ({ value: n, label: `every ${n}` })), value: 4, title: 'Auto-drift interval (phrases)', onChange: (v) => runner.setAutoDrift(runner.state?.autoDrift, Number(v)) });
  const keys = h('div.sl-group.sl-keys', h('div.sl-glabel', 'Key moves (at the next phrase, with a pivot bar)'), keyBtns, h('div.sl-row', keyQueued, h('div.spacer'), driftToggle, driftEvery));
  const globalEl = h('div.sl-global', now, sections, keys);

  // ------------------------------------------------------------------ columns
  const colsEl = h('div.sl-cols');
  const scroll = h('div.sl-scroll', colsEl);
  const empty = h('div.sl-empty', h('div.empty-state',
    icon('sparkles', 40),
    h('h3', 'Setlist — an endless, evolving DJ set'),
    h('p', 'Pick a genre and a key, press Start. Every layer (drums, percussion, bass, chords, pad, lead, arp, fx…) loops while the next phrase is generated as a variation of what is playing. The energy arc brings layers in and out (intro → groove → build → drop → breakdown), and key moves glide to related keys on the next phrase.'),
    h('p.muted', 'Per layer: lock a loop you love, regenerate a new idea, dial mutation and density, swap the sound — or let it rotate through genre-fitting sounds while its settings drift (Freshness sets how much). Edit a pattern in the piano roll and the set continues from your edit. Capture writes the set into the arrangement.'),
    h('div.row.wrap', { style: { justifyContent: 'center' } }, button('Start a set', () => onStart(), { icon: 'play', primary: true }))));
  const body = h('div.sl-body', globalEl, scroll);
  const el = h('div.sl', toolbar, body, empty);

  // ------------------------------------------------------------------ actions
  async function onStart() {
    const p = get();
    const isSet = runner.active && p.tracks.some((t) => runner.layer(t.id));
    if (!isSet && p.tracks.length && (p.clips.length || Object.keys(p.patterns).length)) {
      const ok = await confirmDialog('Start a new set?', 'This replaces the current project with a new set (save it first if you want to keep it — it is also in Menu ▸ Recent).');
      if (!ok) return;
    } else if (isSet && runner.phrases.length > 2) {
      const ok = await confirmDialog('Start a new set?', 'The current set is replaced. Use "Capture to arrangement" first to keep it as a song.');
      if (!ok) return;
    }
    startBtn.disabled = true;
    statusEl.textContent = 'Generating…';
    try {
      await runner.start({ genre: startOpts.genre, key: { root: startOpts.root, scale: startOpts.scale }, bpm: startOpts.bpm || GENRES[startOpts.genre]?.defaultBpm, phraseBars: startOpts.phraseBars, energy: currentEnergy() });
    } finally { startBtn.disabled = false; }
    renderAll();
  }
  const currentEnergy = () => { const t = parseFloat(energyVal.textContent); return isFinite(t) ? t / 100 : 0.7; };

  async function onAddLoop() {
    if (!runner.active) { app.toast('Start a set first — then add loops to it.', { level: 'warn' }); return; }
    const added = await actions.importSamples();
    const smp = added?.[0];
    if (!smp) return;
    let dur = smp.duration;
    if (!dur) { try { dur = (await engine.decodeSample(smp.id)).duration; } catch { dur = 0; } }
    const p = get();
    const bpb = runner.state?.bpb || 4;
    const bars = loopBarsFor(dur || 2, p.bpm, bpb);
    try {
      await runner.addSampleLayer({ sampleId: smp.id, name: String(smp.name || 'Loop').replace(/\.[^.]+$/, ''), beats: bars * bpb, bpm: p.bpm, keyShift: loopKeyShift });
      app.toast(`Loop added: ${bars} bar${bars > 1 ? 's' : ''} — it comes in at the next phrase.`, { level: 'success' });
    } catch (e) { app.toast(e.message, { level: 'error' }); }
    renderAll();
  }

  function onCapture() {
    if (!runner.active || !runner.phrases.length) { app.toast('Start a set first — then capture what you played.', { level: 'warn' }); return; }
    const r = runner.capture();
    if (r) {
      app.toast(`Captured the set: ${Math.round(r.bars)} bars in ${r.sections} sections. It's now a song — export from Menu ▸ Export.`, { level: 'success', timeout: 6000 });
      ui.set({ view: 'arrange' });
    }
    renderAll();
  }

  // ------------------------------------------------------------------ column factory
  function soundName(t) {
    const ins = t.instrument || {};
    if (ins.type === 'drums') return DRUM_KITS[ins.preset]?.name || ins.params?.machine || ins.preset || 'Drums';
    return PRESETS[ins.preset]?.name || ins.preset || ins.params?.instrument || ins.type || '—';
  }
  function soundMenu(t) {
    const ins = t.instrument || {};
    const edit = { label: 'Edit in device panel…', icon: 'sliders', onClick: () => { actions.selectTrack(t.id); ui.set({ deviceOpen: true }); } };
    if (ins.type === 'drums' || ins.type === 'drumsampler') {
      return [{ header: 'Drum kit' }, ...Object.entries(DRUM_KITS).map(([id, k]) => ({ label: k.name, onClick: () => actions.updateTrack(t.id, (tt) => { const params = { ...(tt.instrument.params || {}), kit: id }; delete params.machine; tt.instrument = { type: 'drums', preset: id, params }; }, `Kit: ${k.name}`) })), '-', edit];
    }
    const cats = [...new Set(Object.values(PRESETS).map((pr) => pr.category))].sort((a, b) => (a === 'Strudel' ? -1 : b === 'Strudel' ? 1 : a.localeCompare(b)));
    const role = t.role;
    const fits = Object.entries(PRESETS).filter(([, pr]) => pr.role?.includes(role)).slice(0, 14);
    return [
      ...(fits.length ? [{ header: `Fits ${role}` }, ...fits.map(([id, pr]) => ({ label: pr.name, onClick: () => setPreset(t.id, id) })), '-'] : []),
      ...cats.map((c) => ({ label: c, submenu: Object.entries(PRESETS).filter(([, pr]) => pr.category === c).map(([id, pr]) => ({ label: pr.name, onClick: () => setPreset(t.id, id) })) })),
      '-', edit,
    ];
  }
  function setPreset(trackId, id) {
    const pr = PRESETS[id];
    if (!pr) return;
    actions.updateTrack(trackId, (t) => { t.instrument = { type: pr.instrument.type, preset: id, params: {} }; }, `Preset: ${pr.name}`);
  }

  function makeColumn(l) {
    const t0 = get().tracks.find((t) => t.id === l.id);
    const color = t0?.color || '#7aa2ff';
    const name = h('div.sl-col-name', { title: `${l.name} (${l.category})` }, l.name);
    const state = h('div.sl-col-state');
    const modeBtn = h('button.sl-mode', { type: 'button', title: 'AUTO: the energy arc decides when this layer plays · ON: always in · OFF: always out (from the next phrase)' });
    modeBtn.addEventListener('click', () => runner.setLayer(l.id, { mode: MODE_NEXT[runner.layer(l.id)?.mode || 'auto'] }));
    const muteBtn = h('button.sl-ms', { type: 'button', title: 'Mute (instant)' }, 'M');
    muteBtn.addEventListener('click', () => actions.updateTrack(l.id, (t) => { t.mute = !t.mute; }, 'Mute'));
    const soloBtn = h('button.sl-ms.solo', { type: 'button', title: 'Solo (instant)' }, 'S');
    soloBtn.addEventListener('click', () => actions.updateTrack(l.id, (t) => { t.solo = !t.solo; }, 'Solo'));
    const vol = fader({ def: { key: 'volume', label: 'Volume', min: 0, max: 1.5, default: 0.8, step: 0.01 }, value: t0?.volume ?? 0.8, vertical: true, length: 70, color, onChange: (v, { final }) => store.transact('Volume', (p) => { const t = p.tracks.find((x) => x.id === l.id); if (t) t.volume = v; }, { coalesce: !final }) });
    markAuto(vol, l.id, 'volume');
    const lockBtn = toggle({ label: 'Lock', value: l.lock, title: 'Lock: keep looping exactly this pattern (no mutation)', onChange: (v) => runner.setLayer(l.id, { lock: v }) });
    const regenBtn = h('button.sl-regen', { type: 'button', title: 'New idea at the next phrase (same role and sound, a freshly generated part)' }, icon('dice', 14));
    regenBtn.addEventListener('click', () => { runner.regenerate(l.id); regenBtn.classList.add('on'); });
    const mut = knob({ def: { key: 'mutate', label: 'Mutate', min: 0, max: 1, default: 0.35, step: 0.01 }, value: l.mutate, size: 30, label: 'Mutate', onChange: (v) => runner.setLayer(l.id, { mutate: v }) });
    mut.title = 'Mutate: how much each new phrase varies (0 = repeat, 1 = wild)';
    const dens = knob({ def: { key: 'density', label: 'Density', min: 0, max: 1.25, default: 1, step: 0.01 }, value: l.density, size: 30, label: 'Density', onChange: (v) => runner.setLayer(l.id, { density: v }) });
    dens.title = 'Density / energy of this layer: thins (< 100 %) or thickens (> 100 %) the next phrases';
    const soundBtn = h('button.sl-sound', { type: 'button', title: 'Sound / patch — click to swap (live)' });
    soundBtn.addEventListener('click', (e) => { const t = get().tracks.find((x) => x.id === l.id); if (!t) return; const r = e.currentTarget.getBoundingClientRect(); contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, soundMenu(t)); });
    const editBtn = h('button.sl-edit', { type: 'button', title: 'Edit the playing pattern in the piano roll — the set continues from your edit' }, icon('piano', 13));
    editBtn.addEventListener('click', () => {
      const ph = runner.phraseAt(engine.getPosition());
      const pid = ph?.patterns[l.id] || get().tracks.find((t) => t.id === l.id)?.activePatternId;
      actions.selectTrack(l.id);
      if (pid) ui.set({ selectedPatternId: pid });
      ui.set({ view: isDrumLayer(l) ? 'rack' : 'piano' });
    });
    // sound freshness: rotate / keep, drift amount, what's queued next
    const rotBtn = h('button.sl-rot', { type: 'button', title: 'Rotate: every few phrases this layer swaps to another sound that fits the genre (at a phrase boundary, level-matched) · Keep: stay on this sound' });
    rotBtn.addEventListener('click', () => { const L = runner.layer(l.id); if (L?.sound) runner.setSound(l.id, { rotate: !L.sound.rotate }); });
    const driftKnob = knob({ def: { key: 'drift', label: 'Drift', min: 0, max: 1, default: 0.5, step: 0.01 }, value: l.sound?.drift ?? 0.5, size: 24, label: 'Drift', onChange: (v) => runner.setSound(l.id, { drift: v }) });
    driftKnob.title = 'Drift: how far filter / envelope / space / width settings wander across phrases (0 = static). A knob you move yourself stops drifting.';
    const nowBtn = h('button.sl-regen', { type: 'button', title: 'Next sound now: swap to the queued sound at the next phrase' }, icon('refresh', 13));
    nowBtn.addEventListener('click', () => { runner.nextSoundNow(l.id); nowBtn.classList.add('on'); });
    const nextEl = h('div.sl-next.muted');
    const canvas = h('canvas.sl-prev');
    const head = h('div.sl-prev-head');
    const prevWrap = h('div.sl-prev-wrap', { title: 'The phrase playing now' }, canvas, head);
    const prog = h('div.sl-col-prog', h('div.sl-col-prog-fill'));
    const isLoop = !!l.sample;
    const removeBtn = h('button.sl-regen', { type: 'button', title: 'Remove this loop from the set (from the next phrase)' }, icon('trash', 13));
    removeBtn.addEventListener('click', () => runner.removeLayer(l.id));
    const loopInfo = h('div.sl-next.muted');
    const colEl = isLoop
      ? h('div.sl-col', { style: { '--col': color } },
        h('div.sl-col-top', name, state),
        prevWrap, prog,
        h('div.sl-row.c', modeBtn, muteBtn, soloBtn),
        h('div.sl-col-mid', vol),
        h('div.sl-row.c', lockBtn, removeBtn),
        loopInfo)
      : h('div.sl-col', { style: { '--col': color } },
        h('div.sl-col-top', name, state),
        prevWrap, prog,
        h('div.sl-row.c', modeBtn, muteBtn, soloBtn),
        h('div.sl-col-mid', vol, h('div.sl-knobs', mut, dens)),
        h('div.sl-row.c', lockBtn, regenBtn, editBtn),
        soundBtn,
        h('div.sl-row.c', rotBtn, driftKnob, nowBtn),
        nextEl);
    let drawnPat = null;
    const api = {
      el: colEl,
      sync() {
        const t = get().tracks.find((x) => x.id === l.id);
        const L = runner.layer(l.id);
        if (!t || !L) return;
        muteBtn.classList.toggle('on', !!t.mute);
        soloBtn.classList.toggle('on', !!t.solo);
        vol.setValue(t.volume);
        soundBtn.textContent = soundName(t);
        modeBtn.textContent = MODE_LABEL[L.mode];
        modeBtn.dataset.mode = L.mode;
        lockBtn.setValue(L.lock);
        regenBtn.classList.toggle('on', !!L.regen);
        mut.setValue?.(L.mutate);
        dens.setValue?.(L.density);
        if (L.sample) {
          const bars = Math.round((L.sample.beats / (runner.state?.bpb || 4)) * 100) / 100;
          loopInfo.textContent = `${bars} bar loop · ${L.sample.keyShift ? `key-shift ${L.sample.shift > 0 ? '+' : ''}${L.sample.shift} st` : 'audio, fixed pitch'}`;
          loopInfo.title = loopInfo.textContent;
        }
        const si = soundInfo(runner.state, l.id);
        if (si) {
          rotBtn.textContent = si.rotate ? '↻ Rotate' : 'Keep';
          rotBtn.classList.toggle('on', si.rotate);
          rotBtn.disabled = !si.canRotate;
          nowBtn.disabled = !si.canRotate;
          nowBtn.classList.toggle('on', !!L.sound.now);
          driftKnob.setValue?.(si.drift);
          driftKnob.style.opacity = si.canDrift ? '' : '0.4';
          nextEl.textContent = si.next ? `next: ${si.next.name} in ${si.next.in} phrase${si.next.in === 1 ? '' : 's'}` : (L.lock ? 'locked' : si.rotate ? '' : 'sound kept');
          nextEl.title = nextEl.textContent;
        }
      },
      frame(pos) {
        const ph = runner.phraseAt(pos);
        const last = runner.lastPhrase;
        const playing = !!ph?.active.has(l.id);
        const next = last && last !== ph ? last.active.has(l.id) : null;
        state.textContent = playing ? (next === false ? '▶ out next' : '▶ playing') : next ? '◌ in next' : '· resting';
        colEl.classList.toggle('playing', playing);
        colEl.classList.toggle('resting', !playing);
        if (isLoop) {
          const sigNow = playing ? `loop:${ph.index}` : null;
          if (sigNow !== drawnPat) { drawnPat = sigNow; drawLoopPreview(canvas, playing ? ph : null, l, color); }
        } else {
          const pid = ph?.patterns[l.id] || null;
          const pat = pid ? get().patterns[pid] : null;
          const sigNow = pat ? `${pid}:${pat.notes.length}:${pat.notes[0]?.pitch}` : null;
          if (sigNow !== drawnPat) { drawnPat = sigNow; drawPreview(canvas, pat, isDrumLayer(l), color); }
        }
        const pr = ph ? Math.min(1, Math.max(0, (pos - ph.start) / ph.length)) : 0;
        head.style.left = `${pr * 100}%`;
        head.hidden = !playing;
        prog.firstChild.style.width = `${pr * 100}%`;
      },
      redraw() { drawnPat = null; },
    };
    return api;
  }
  const isDrumLayer = (l) => l.drums;

  function drawPreview(canvas, pat, drums, color) {
    const { ctx: c, w: W, h: H } = fitCanvas(canvas);
    c.clearRect(0, 0, W, H);
    if (!pat) return;
    // bar lines
    c.fillStyle = 'rgba(128,128,128,0.18)';
    const bpb = runner.state?.bpb || 4;
    for (let b = bpb; b < pat.length; b += bpb) c.fillRect(Math.round((b / pat.length) * W), 0, 1, H);
    drawPatternNotes(c, pat, { x: 0, y: 2, w: W, h: H - 4, color, drums, minW: 2 });
    c.globalAlpha = 1;
  }

  /** Loop layer preview: one block per loop restart inside the phrase. */
  function drawLoopPreview(canvas, ph, l, color) {
    const { ctx: c, w: W, h: H } = fitCanvas(canvas);
    c.clearRect(0, 0, W, H);
    if (!ph) return;
    const clips = get().clips.filter((x) => x.trackId === l.id && x.start >= ph.start - 1e-6 && x.start < ph.start + ph.length - 1e-6);
    c.fillStyle = color;
    c.globalAlpha = 0.55;
    for (const x of clips) c.fillRect(Math.round(((x.start - ph.start) / ph.length) * W) + 1, 3, Math.max(2, Math.round((x.length / ph.length) * W) - 2), H - 6);
    if (!clips.length) c.fillRect(1, 3, W - 2, H - 6); // key-shift (sampler) loops: a pattern clip
    c.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ render
  function renderColumns() {
    const layers = runner.state?.layers || [];
    const p = get();
    const live = layers.filter((l) => p.tracks.some((t) => t.id === l.id));
    const key = live.map((l) => l.id).join(',');
    if (key !== colKey) {
      colKey = key;
      cols.clear();
      colsEl.replaceChildren(...live.map((l) => { const c = makeColumn(l); cols.set(l.id, c); return c.el; }));
    }
    for (const c of cols.values()) c.sync();
  }

  function renderGlobal() {
    const st = runner.state;
    const active = !!st;
    el.classList.toggle('sl-idle', !active);
    empty.hidden = active;
    body.hidden = !active;
    startBtn.lastChild.textContent = active ? 'New set' : 'Start';
    playBtn.disabled = !active;
    captureBtn.disabled = !active;
    const playing = runner.running && engine.isPlaying;
    playBtn.replaceChildren(icon(playing ? 'stop' : 'play', 15), h('span', playing ? 'Stop' : 'Resume'));
    if (!st) { statusEl.textContent = 'Pick a genre and key, then Start.'; return; }
    const kOpts = keyMoveOptions(st.pendingKey || st.key);
    keyBtns.replaceChildren(...kOpts.map((o) => {
      const b = h('button.sl-keybtn', { type: 'button', title: `${o.hint}\n${o.text} · Camelot ${o.camelot}` }, h('b', o.label), h('span', keyName(o.target)), h('small', camelot(o.target).code));
      b.addEventListener('click', () => runner.keyMove(o.id));
      return b;
    }));
    keyQueued.replaceChildren(...(st.pendingKey
      ? [h('span.sl-keyq-on', `Next phrase: ${keyName(st.key)} → ${keyName(st.pendingKey)}`), h('button.sl-x', { type: 'button', title: 'Cancel the key move', onclick: () => runner.cancelKeyMove() }, '×')]
      : [h('span.muted', `In ${keyName(st.key)} (${camelot(st.key).code})`)]));
    for (const b of secBtns) b.classList.toggle('queued', st.queued === b.dataset.sec);
    holdBtn.setValue(st.hold);
    driftToggle.setValue(st.autoDrift);
    driftEvery.setValue(st.driftEvery);
    barsSel.setValue(runner.pendingBars || st.phraseBars);
    freshFader.setValue?.(st.freshness ?? 0.5);
    freshVal.textContent = Math.round((st.freshness ?? 0.5) * 100) + '%';
    statusEl.textContent = `${GENRES[st.genre]?.name || st.genre} · ${get().bpm} BPM · ${st.layers.length} layers${runner.lastError ? ' · error: ' + runner.lastError.message : ''}`;
  }

  function renderAll() { renderGlobal(); renderColumns(); }

  function frame() {
    if (!visible) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    const st = runner.state;
    if (!st) return;
    const pos = engine.getPosition();
    const ph = runner.phraseAt(pos);
    const last = runner.lastPhrase;
    if (ph) {
      const pr = Math.min(1, Math.max(0, (pos - ph.start) / ph.length));
      progFill.style.width = `${pr * 100}%`;
      secName.textContent = SECTIONS[ph.section]?.label || ph.section;
      secName.dataset.sec = ph.section;
      keyEl.textContent = `${keyName(ph.key)} · ${camelot(ph.key).code}`;
      const bars = Math.max(0, Math.ceil((ph.start + ph.length - pos) / st.bpb));
      phraseEl.textContent = `Phrase ${ph.index + 1} · ${bars} bar${bars === 1 ? '' : 's'} to go`;
      const nxt = last && last !== ph ? last : null;
      const upcoming = nxt ? SECTIONS[nxt.section]?.label : SECTIONS[st.queued || nextSection({ arcIndex: st.arcIndex, hold: st.hold, current: st.section }).section]?.label;
      const keyNext = nxt ? (nxt.keyChanged ? ` in ${keyName(nxt.key)}` : '') : st.pendingKey ? ` in ${keyName(st.pendingKey)}` : '';
      secNext.textContent = `Next: ${upcoming || '—'}${keyNext}${nxt ? '' : ' (planning)'}`;
    }
    for (const c of cols.values()) c.frame(pos);
    const playing = runner.running && engine.isPlaying;
    if (playing !== playBtn._playing) { playBtn._playing = playing; renderGlobal(); }
  }

  runner.on('phrase', () => { if (visible) { renderGlobal(); for (const c of cols.values()) c.sync(); } });
  runner.on('change', () => { if (visible) renderAll(); });
  app.subscribe((r) => { if (visible && (r.project || r.ui.view)) renderAll(); });

  return {
    el,
    show() { visible = true; renderAll(); for (const c of cols.values()) c.redraw(); if (!raf) raf = requestAnimationFrame(frame); },
    hide() { visible = false; },
  };
}

