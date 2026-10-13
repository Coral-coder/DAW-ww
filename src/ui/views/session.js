// Session view: scenes × tracks clip launcher (Ableton Session / Bitwig clip launcher style).
// Columns = tracks, rows = project.scenes; each slot holds a pattern id. Launching a slot makes it
// the track's active pattern and starts pattern-mode playback; launching a scene does it for every
// track at once (tracks with an empty slot stop).
import { h, icon } from '../dom.js';
import { button, iconButton, toggle, contextMenu, promptText, confirmDialog, toast } from '../components.js';
import { beatsPerBar, patternsForTrack, createPattern, createScene, TRACK_COLORS } from '../../core/model.js';
import { uid, deepClone } from '../../core/util.js';
import { drawPatternNotes, hexToRgb, rgba, isDrumTrack, sceneLengthBeats, scenesToArrangement } from './arrange.js';

const DT_SLOT = 'application/x-heroic-slot';
const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;
const MELODIC_ROLES = ['chords', 'bass', 'lead', 'arp', 'pad'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function createSessionView(app) {
  const { store, ui, engine, actions } = app;
  const get = () => store.get();
  let visible = false;
  let stale = true;
  let rings = []; // [{ circle, trackId, patternId }]
  let raf = 0;
  let lastLaunchedScene = null;

  const pos = () => (engine.getPosition ? engine.getPosition() : 0) || 0;
  const menuAt = (anchor, items) => {
    const r = anchor.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, items.filter(Boolean));
  };

  // ------------------------------------------------------------------ toolbar
  const addSceneBtn = button('Scene', () => addScene(), { icon: 'plus', title: 'Add an empty scene (row)' });
  const captureBtn = button('Capture current', () => captureScene(), { icon: 'record', title: 'New scene from the patterns every track is playing right now' });
  const toArrBtn = button('Scenes → Arrangement', (e) => menuAt(e.currentTarget, toArrangementItems()), { icon: 'timeline', title: 'Lay out all scenes one after another on the timeline and switch to Song mode' });
  const stopAllBtn = button('Stop', () => actions.stop(), { icon: 'stop', title: 'Stop playback (Enter)' });
  const addTrackBtn = button('Track', (e) => menuAt(e.currentTarget, actions.addTrackMenuItems()), { icon: 'plus', title: 'Add a track (new column)' });
  const modeNote = h('span.ses-mode');
  const toolbar = h('div.view-toolbar.ses-toolbar', addSceneBtn, captureBtn, toArrBtn, h('div.sep'), stopAllBtn, h('div.sep'), addTrackBtn, h('div.spacer'), modeNote);

  const grid = h('div.ses-grid');
  const scroll = h('div.ses-scroll', grid);
  const empty = h('div.ses-empty.hidden',
    h('div.empty-state',
      icon('scenes', 40),
      h('h3', 'No tracks to launch yet'),
      h('p', 'Scenes are rows of patterns you can launch together — perfect for jamming out verse / chorus / drop ideas before arranging them. Add some tracks to get started.'),
      h('div.row.wrap', { style: { justifyContent: 'center' } },
        button('Generate a song', () => actions.showSongWizard(), { icon: 'wand', primary: true }),
        button('Add drum track', () => { const t = actions.addTrack('drums'); actions.generatePart('drums', { trackId: t.id }); }, { icon: 'drum' }),
        button('Add synth', () => actions.addTrack('synth'), { icon: 'piano' }))));
  const el = h('div.ses', toolbar, scroll, empty);

  // ------------------------------------------------------------------ model helpers
  const trackOf = (id) => get().tracks.find((t) => t.id === id);
  const sceneOf = (id) => get().scenes.find((s) => s.id === id);
  const launchable = (t) => t && t.type === 'instrument';

  async function startPatternPlayback() {
    if (get().mode !== 'pattern') actions.setMode('pattern');
    if (!engine.isPlaying) { try { await actions.play(); } catch { /* toast shown by actions */ } }
  }

  function launchSlot(trackId, patternId) {
    if (!get().patterns[patternId]) return;
    actions.selectPattern(patternId); // activates it (non-undoable) and selects it for editing
    startPatternPlayback();
  }

  function launchScene(sceneId) {
    const sc = sceneOf(sceneId);
    if (!sc) return;
    store.transact('Launch scene', (p) => {
      for (const t of p.tracks) {
        if (t.type !== 'instrument') continue;
        const pid = sc.slots?.[t.id];
        t.activePatternId = pid && p.patterns[pid] ? pid : null;
      }
    }, { undo: false });
    lastLaunchedScene = sceneId;
    app.setStatus?.(`Launched "${sc.name}"`);
    startPatternPlayback();
  }

  function stopTrack(trackId) {
    store.transact('Stop track', (p) => { const t = p.tracks.find((x) => x.id === trackId); if (t) t.activePatternId = null; }, { undo: false });
  }

  function nextSceneName(p) {
    const names = new Set(p.scenes.map((s) => s.name));
    for (let i = p.scenes.length + 1; i < 999; i++) if (!names.has(`Scene ${i}`)) return `Scene ${i}`;
    return 'Scene';
  }

  function addScene(index = null, slots = {}, name = null) {
    const p = get();
    const sc = createScene(name || nextSceneName(p), { ...slots });
    store.transact('Add scene', (pp) => {
      if (index === null || index >= pp.scenes.length) pp.scenes.push(sc); else pp.scenes.splice(index, 0, sc);
    });
    return sc;
  }

  function currentSlots() {
    const p = get();
    const slots = {};
    for (const t of p.tracks) if (t.type === 'instrument' && t.activePatternId && p.patterns[t.activePatternId]) slots[t.id] = t.activePatternId;
    return slots;
  }

  function captureScene() {
    const slots = currentSlots();
    if (!Object.keys(slots).length) { toast('No track has an active pattern to capture yet.', { level: 'warn' }); return; }
    const sc = addScene(null, slots);
    lastLaunchedScene = sc.id;
    toast(`Captured ${Object.keys(slots).length} pattern(s) as "${sc.name}"`, { level: 'success' });
  }

  function clonePattern(pp, pat, name) {
    const np = { ...deepClone(pat), id: uid('pat'), name: name || pat.name };
    np.notes = np.notes.map((n) => ({ ...n, id: uid('n') }));
    pp.patterns[np.id] = np;
    return np;
  }
  function copyName(p, base) {
    const stem = base.replace(/\s*\d+$/, '').trim() || 'Pattern';
    const names = new Set(Object.values(p.patterns).map((x) => x.name));
    for (let i = 2; i < 999; i++) if (!names.has(`${stem} ${i}`)) return `${stem} ${i}`;
    return `${stem} copy`;
  }

  function duplicateScene(sceneId, withCopies = false) {
    const p = get();
    const i = p.scenes.findIndex((s) => s.id === sceneId);
    if (i < 0) return;
    const src = p.scenes[i];
    store.transact(withCopies ? 'Duplicate scene + patterns' : 'Duplicate scene', (pp) => {
      const slots = {};
      for (const [tid, pid] of Object.entries(src.slots || {})) {
        const pat = pp.patterns[pid];
        if (!pat) continue;
        slots[tid] = withCopies ? clonePattern(pp, pat, copyName(pp, pat.name)).id : pid;
      }
      pp.scenes.splice(i + 1, 0, createScene(`${src.name} copy`, slots));
    });
  }

  async function renameScene(sceneId) {
    const sc = sceneOf(sceneId);
    if (!sc) return;
    const name = await promptText('Scene name', sc.name);
    if (name) store.transact('Rename scene', (p) => { const s = p.scenes.find((x) => x.id === sceneId); if (s) s.name = name; });
  }

  function moveScene(sceneId, dir) {
    store.transact('Move scene', (p) => {
      const i = p.scenes.findIndex((s) => s.id === sceneId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.scenes.length) return;
      [p.scenes[i], p.scenes[j]] = [p.scenes[j], p.scenes[i]];
    });
  }

  function deleteScene(sceneId) {
    if (get().scenes.length <= 1) { toast('A project keeps at least one scene — clear its slots instead.'); return; }
    store.transact('Delete scene', (p) => { p.scenes = p.scenes.filter((s) => s.id !== sceneId); });
  }

  function setSlot(sceneId, trackId, patternId, label = 'Assign slot') {
    store.transact(label, (p) => {
      const s = p.scenes.find((x) => x.id === sceneId);
      if (!s) return;
      s.slots = s.slots || {};
      if (patternId) s.slots[trackId] = patternId; else delete s.slots[trackId];
    });
  }

  /** New empty pattern in a slot — becomes the track's active pattern (one undo step). */
  function newPatternInSlot(sceneId, trackId) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!launchable(t)) return null;
    const cur = p.patterns[t.activePatternId];
    const bpb = beatsPerBar(p);
    const pat = createPattern(trackId, { name: `${t.name} ${patternsForTrack(p, trackId).length + 1}`, length: cur?.length || bpb * (isDrumTrack(t) ? 1 : 2) });
    store.transact('New pattern in slot', (pp) => {
      pp.patterns[pat.id] = pat;
      const s = pp.scenes.find((x) => x.id === sceneId);
      if (s) { s.slots = s.slots || {}; s.slots[trackId] = pat.id; }
      const tt = pp.tracks.find((x) => x.id === trackId);
      if (tt) tt.activePatternId = pat.id;
    });
    ui.set({ selectedTrackId: trackId, selectedPatternId: pat.id });
    app.setStatus?.(`New pattern "${pat.name}" — double-click it (or right-click ▸ Edit) to write notes, or right-click ▸ Generate.`);
    return pat;
  }

  function duplicateIntoSlot(sceneId, trackId, patternId) {
    const p = get();
    const pat = p.patterns[patternId];
    if (!pat) return;
    let nid = null;
    store.transact('Duplicate pattern into slot', (pp) => {
      const np = clonePattern(pp, pat, copyName(pp, pat.name));
      nid = np.id;
      const s = pp.scenes.find((x) => x.id === sceneId);
      if (s) s.slots[trackId] = np.id;
      const tt = pp.tracks.find((x) => x.id === trackId);
      if (tt) tt.activePatternId = np.id;
    });
    ui.set({ selectedTrackId: trackId, selectedPatternId: nid });
  }

  function editPattern(patternId) {
    const pat = get().patterns[patternId];
    if (!pat) return;
    actions.selectPattern(patternId);
    app.showView(isDrumTrack(trackOf(pat.trackId)) ? 'rack' : 'piano');
  }

  function generateInto(sceneId, trackId, role) {
    const sc = sceneOf(sceneId);
    let pid = sc?.slots?.[trackId];
    if (!pid || !get().patterns[pid]) pid = newPatternInSlot(sceneId, trackId)?.id;
    if (!pid) return;
    actions.selectPattern(pid); // make it active so generatePart writes into it
    actions.generatePart(role, { trackId });
  }

  async function sendToArrangement(barsPerScene, replace = true) {
    const p = get();
    if (replace && p.clips.some((c) => c.type === 'pattern') && !(await confirmDialog('Replace arrangement?', 'This replaces the pattern clips and markers on the timeline with one section per scene. Audio clips are kept. You can undo with Ctrl+Z.'))) return;
    const res = scenesToArrangement(app, { barsPerScene, replace });
    if (!res) return;
    actions.setMode('song');
    if (replace) actions.setPosition(0);
    toast(`Arranged ${get().scenes.length} scenes into ${Math.round(res.beats / beatsPerBar(get()))} bars. Song mode is on — open Arrange (1) to see the timeline.`, { level: 'success', timeout: 5500 });
  }

  // ------------------------------------------------------------------ menus
  function toArrangementItems() {
    const bars = [1, 2, 4, 8, 16];
    return [
      { header: 'Each scene becomes a section' },
      { label: 'Auto length (longest pattern per scene)', icon: 'timeline', onClick: () => sendToArrangement(null) },
      ...bars.map((n) => ({ label: `${n} bar${n > 1 ? 's' : ''} per scene`, onClick: () => sendToArrangement(n) })),
      '-',
      { label: 'Append after the current song end', icon: 'plus', onClick: () => sendToArrangement(null, false) },
    ];
  }

  function sceneMenuItems(sc) {
    const p = get();
    const i = p.scenes.indexOf(sc);
    return [
      { header: sc.name },
      { label: 'Launch scene', icon: 'play', onClick: () => launchScene(sc.id) },
      { label: 'Rename…', icon: 'pencil', onClick: () => renameScene(sc.id) },
      { label: 'Duplicate', icon: 'copy', onClick: () => duplicateScene(sc.id, false) },
      { label: 'Duplicate with new pattern copies', icon: 'layers', onClick: () => duplicateScene(sc.id, true) },
      { label: 'Insert empty scene below', icon: 'plus', onClick: () => addScene(i + 1) },
      { label: 'Capture playing patterns into this scene', icon: 'record', onClick: () => store.transact('Capture into scene', (pp) => { const s = pp.scenes.find((x) => x.id === sc.id); if (s) s.slots = currentSlots(); }) },
      { label: 'Move up', disabled: i <= 0, onClick: () => moveScene(sc.id, -1) },
      { label: 'Move down', disabled: i >= p.scenes.length - 1, onClick: () => moveScene(sc.id, 1) },
      '-',
      { label: 'Clear all slots', onClick: () => store.transact('Clear scene', (pp) => { const s = pp.scenes.find((x) => x.id === sc.id); if (s) s.slots = {}; }) },
      { label: 'Delete scene', icon: 'trash', disabled: p.scenes.length <= 1, onClick: () => deleteScene(sc.id) },
    ];
  }

  function generateItems(sc, t) {
    if (isDrumTrack(t)) return [{ label: 'Drum pattern', icon: 'dice', onClick: () => generateInto(sc.id, t.id, 'drums') }];
    const roles = t.role && MELODIC_ROLES.includes(t.role) ? [t.role, ...MELODIC_ROLES.filter((r) => r !== t.role)] : MELODIC_ROLES;
    return roles.map((r) => ({ label: cap(r) + (r === t.role ? ' (track role)' : ''), icon: 'dice', onClick: () => generateInto(sc.id, t.id, r) }));
  }

  function cellMenuItems(sc, t) {
    const p = get();
    const pid = sc.slots?.[t.id];
    const pat = pid && p.patterns[pid];
    const pats = patternsForTrack(p, t.id);
    const assign = { label: 'Assign pattern', icon: 'music', disabled: !pats.length, submenu: pats.map((pt) => ({ label: `${pt.id === pid ? '● ' : ''}${pt.name}`, onClick: () => setSlot(sc.id, t.id, pt.id) })) };
    if (!pat) {
      return [
        { header: `${t.name} · ${sc.name}` },
        { label: 'New pattern here', icon: 'plus', onClick: () => newPatternInSlot(sc.id, t.id) },
        pats.length ? assign : null,
        { label: 'Generate', icon: 'wand', submenu: generateItems(sc, t) },
      ].filter(Boolean);
    }
    return [
      { header: pat.name },
      { label: 'Launch', icon: 'play', onClick: () => launchSlot(t.id, pid) },
      { label: isDrumTrack(t) ? 'Edit in Step Rack' : 'Edit in Piano Roll', icon: isDrumTrack(t) ? 'grid' : 'piano', onClick: () => editPattern(pid) },
      { label: 'Rename pattern…', icon: 'pencil', onClick: async () => { const n = await promptText('Pattern name', pat.name); if (n) store.transact('Rename pattern', (pp) => { if (pp.patterns[pid]) pp.patterns[pid].name = n; }); } },
      assign,
      { label: 'Duplicate (new copy in this slot)', icon: 'copy', onClick: () => duplicateIntoSlot(sc.id, t.id, pid) },
      { label: 'Copy to scene', icon: 'scenes', submenu: p.scenes.filter((s) => s.id !== sc.id).map((s) => ({ label: s.name, onClick: () => setSlot(s.id, t.id, pid, 'Copy slot') })) },
      { label: 'Generate', icon: 'wand', submenu: generateItems(sc, t) },
      { label: 'Color', submenu: TRACK_COLORS.map((c) => ({ label: h('span.ses-swatch-row', h('span.ses-swatch', { style: { background: c } }), c), onClick: () => store.transact('Pattern color', (pp) => { if (pp.patterns[pid]) pp.patterns[pid].color = c; }) })) },
      '-',
      { label: 'Clear slot', icon: 'x', onClick: () => setSlot(sc.id, t.id, null, 'Clear slot') },
      { label: 'Delete pattern everywhere…', icon: 'trash', onClick: async () => { if (await confirmDialog('Delete pattern', `Delete "${pat.name}" from every scene and the arrangement?`)) actions.deletePattern(pid); } },
    ];
  }

  // ------------------------------------------------------------------ rendering
  function previewCanvas(pat, t, color) {
    const dpr = window.devicePixelRatio || 1;
    const W = 120, H = 20;
    const c = h('canvas.ses-prev', { width: Math.round(W * dpr), height: Math.round(H * dpr) });
    c.style.width = W + 'px';
    c.style.height = H + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPatternNotes(ctx, pat, { x: 0, y: 1, w: W, h: H - 2, color, drums: isDrumTrack(t), minW: 1 });
    return c;
  }

  function ring() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('class', 'ses-ring');
    const bg = document.createElementNS(ns, 'circle');
    const fg = document.createElementNS(ns, 'circle');
    for (const c of [bg, fg]) { c.setAttribute('cx', 9); c.setAttribute('cy', 9); c.setAttribute('r', RING_R); }
    bg.setAttribute('class', 'ses-ring-bg');
    fg.setAttribute('class', 'ses-ring-fg');
    fg.style.strokeDasharray = `${RING_C}`;
    fg.style.strokeDashoffset = `${RING_C}`;
    const tri = document.createElementNS(ns, 'path');
    tri.setAttribute('d', 'M7 5.5 L12.5 9 L7 12.5 Z');
    tri.setAttribute('class', 'ses-ring-tri');
    svg.append(bg, fg, tri);
    return { svg, fg };
  }

  function trackHeader(t, selected) {
    const p = get();
    const active = p.patterns[t.activePatternId];
    const mute = toggle({ label: 'M', cls: 'mute', value: !!t.mute, title: 'Mute', onChange: (v) => actions.updateTrack(t.id, (tt) => { tt.mute = v; }, v ? 'Mute' : 'Unmute') });
    const solo = toggle({ label: 'S', cls: 'solo', value: !!t.solo, title: 'Solo', onChange: (v) => actions.updateTrack(t.id, (tt) => { tt.solo = v; }, v ? 'Solo' : 'Unsolo') });
    const icn = t.type === 'code' ? 'code' : t.type === 'audio' ? 'wave' : isDrumTrack(t) ? 'drum' : 'piano';
    const status = t.type === 'instrument' ? (active ? `▶ ${active.name}` : '■ stopped') : t.type === 'code' ? 'live code · always on' : 'audio · arrangement only';
    const elh = h(`div.ses-th${selected ? '.selected' : ''}${t.mute ? '.is-muted' : ''}`, { title: 'Click to select · double-click to rename · right-click for track options' },
      h('div.ses-th-bar'),
      h('div.ses-th-name', icon(icn, 13), h('span', t.name)),
      h('div.ses-th-status', status),
      h('div.ses-th-ctrls', mute, solo));
    elh.addEventListener('click', (e) => { if (!e.target.closest('button')) actions.selectTrack(t.id); });
    elh.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) actions.renameTrack(t.id); });
    elh.addEventListener('contextmenu', (e) => { e.preventDefault(); actions.selectTrack(t.id); contextMenu(e, actions.trackMenuItems(t.id)); });
    elh.style.setProperty('--tc', t.color);
    return elh;
  }

  function sceneIsCurrent(p, sc) {
    let any = false;
    for (const t of p.tracks) {
      if (t.type !== 'instrument') continue;
      const want = sc.slots?.[t.id] && p.patterns[sc.slots[t.id]] ? sc.slots[t.id] : null;
      if ((t.activePatternId || null) !== want) return false;
      if (want) any = true;
    }
    return any;
  }

  function sceneHeader(sc, p) {
    const bpb = beatsPerBar(p);
    const bars = sceneLengthBeats(p, sc) / bpb;
    const current = sceneIsCurrent(p, sc);
    const launch = h('button.ses-launch', { type: 'button', title: `Launch "${sc.name}" — every track plays its pattern from this row (empty slots stop)` }, icon('play', 13));
    launch.addEventListener('click', () => launchScene(sc.id));
    const name = h('div.ses-scene-name', { title: 'Double-click to rename' }, sc.name);
    name.addEventListener('dblclick', () => renameScene(sc.id));
    const more = iconButton('menu', (e) => menuAt(e.currentTarget, sceneMenuItems(sc)), 'Scene options: rename, duplicate, reorder, delete…', 'ses-more');
    const elh = h(`div.ses-scene${current ? '.current' : ''}${lastLaunchedScene === sc.id ? '.last' : ''}`,
      launch, h('div.ses-scene-text', name, h('div.ses-scene-sub', `${+bars.toFixed(2)} bar${bars === 1 ? '' : 's'}`)), more);
    elh.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e, sceneMenuItems(sc)); });
    return elh;
  }

  function slotCell(sc, t, p, playing) {
    const pid = sc.slots?.[t.id];
    const pat = pid && p.patterns[pid];
    if (!launchable(t)) {
      return h('div.ses-cell.na', { title: t.type === 'code' ? 'Code tracks play continuously — edit them in the Code view' : 'Audio tracks play clips from the arrangement' }, t.type === 'code' ? '⟳' : '—');
    }
    if (!pat) {
      const cell = h('div.ses-cell.empty', { title: 'Click to create a new pattern here · right-click to assign an existing one or generate' }, h('span.ses-plus', icon('plus', 14)));
      cell.addEventListener('click', () => newPatternInSlot(sc.id, t.id));
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e, cellMenuItems(sc, t)); });
      addDropTarget(cell, sc, t);
      return cell;
    }
    const color = pat.color || t.color;
    const rgb = hexToRgb(color);
    const isActive = t.activePatternId === pid;
    const isSel = ui.get('selectedPatternId') === pid;
    const isPlaying = isActive && playing && !t.mute;
    const dark = (ui.get('theme') || 'dark') !== 'light';
    const ink = dark ? rgba(rgb.map((v) => Math.round(v + (255 - v) * 0.35)), 1) : rgba(rgb.map((v) => Math.round(v * 0.5)), 1);
    const r = ring();
    const bars = pat.length / beatsPerBar(p);
    const cell = h(`div.ses-cell.filled${isActive ? '.active' : ''}${isPlaying ? '.playing' : ''}${isSel ? '.selected' : ''}`,
      { draggable: true, title: `${pat.name} — click to launch, double-click to edit, drag to another scene (Alt/Ctrl = copy), right-click for more` },
      h('div.ses-cell-top', r.svg, h('span.ses-cell-name', pat.name), h('span.ses-cell-len', `${+bars.toFixed(2)}b`)),
      previewCanvas(pat, t, ink));
    cell.style.setProperty('--cc', color);
    cell.style.setProperty('--cc-bg', rgba(rgb, dark ? 0.2 : 0.26));
    cell.style.setProperty('--cc-bg-hi', rgba(rgb, dark ? 0.34 : 0.4));
    if (isActive) rings.push({ circle: r.fg, patternId: pid, trackId: t.id });
    cell.addEventListener('click', () => launchSlot(t.id, pid));
    cell.addEventListener('dblclick', () => editPattern(pid));
    cell.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e, cellMenuItems(sc, t)); });
    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DT_SLOT, JSON.stringify({ sceneId: sc.id, trackId: t.id, patternId: pid }));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    addDropTarget(cell, sc, t);
    return cell;
  }

  let dragSrcTrack = null;
  grid.addEventListener('dragstart', (e) => {
    try { dragSrcTrack = JSON.parse(e.dataTransfer.getData(DT_SLOT) || 'null')?.trackId || null; } catch { dragSrcTrack = null; }
  });
  grid.addEventListener('dragend', () => { dragSrcTrack = null; grid.querySelectorAll('.drop-ok').forEach((x) => x.classList.remove('drop-ok')); });

  function addDropTarget(cell, sc, t) {
    cell.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(DT_SLOT) || dragSrcTrack !== t.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey || e.ctrlKey || e.metaKey ? 'copy' : 'move';
      cell.classList.add('drop-ok');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-ok'));
    cell.addEventListener('drop', (e) => {
      cell.classList.remove('drop-ok');
      let data;
      try { data = JSON.parse(e.dataTransfer.getData(DT_SLOT)); } catch { return; }
      if (!data || data.trackId !== t.id || data.sceneId === sc.id) return;
      e.preventDefault();
      const copy = e.altKey || e.ctrlKey || e.metaKey;
      store.transact(copy ? 'Copy slot' : 'Move slot', (p) => {
        const dst = p.scenes.find((s) => s.id === sc.id);
        const src = p.scenes.find((s) => s.id === data.sceneId);
        if (!dst || !src) return;
        const prev = dst.slots[t.id];
        dst.slots[t.id] = data.patternId;
        if (!copy) { if (prev) src.slots[t.id] = prev; else delete src.slots[t.id]; } // move swaps with the target
      });
    });
  }

  function render() {
    if (!visible) { stale = true; return; }
    stale = false;
    const p = get();
    const scrollPos = [scroll.scrollLeft, scroll.scrollTop];
    rings = [];
    empty.classList.toggle('hidden', p.tracks.length > 0);
    scroll.classList.toggle('hidden', !p.tracks.length);
    const playing = !!engine.isPlaying && p.mode === 'pattern';
    const selT = ui.get('selectedTrackId');
    modeNote.replaceChildren();
    if (p.mode === 'song') {
      const b = button('Switch to PATTERN', () => actions.setMode('pattern'), { cls: 'small', title: 'Scenes play in Pattern mode (P)' });
      modeNote.append(h('span.ses-warn', icon('help', 13), ' Song mode is on — launching a slot or scene switches to Pattern mode.'), b);
    } else {
      modeNote.append(h('span.muted', 'Click a slot to launch it, ▶ to launch a whole row. Patterns of different lengths loop independently (polymeter).'));
    }
    const cols = p.tracks.length;
    grid.style.gridTemplateColumns = `var(--ses-scene-w) repeat(${cols}, var(--ses-col-w)) var(--ses-add-w)`;
    const kids = [];
    // header row
    kids.push(h('div.ses-corner', h('span', 'Scenes'), h('span.muted', `${p.scenes.length}`)));
    for (const t of p.tracks) kids.push(trackHeader(t, t.id === selT));
    const addCol = h('div.ses-addcol', { title: 'Add a track' }, icon('plus', 16), h('span', 'Track'));
    addCol.addEventListener('click', (e) => menuAt(e.currentTarget, actions.addTrackMenuItems()));
    kids.push(addCol);
    // scene rows
    for (const sc of p.scenes) {
      kids.push(sceneHeader(sc, p));
      for (const t of p.tracks) {
        const cell = slotCell(sc, t, p, playing);
        if (t.id === selT) cell.classList.add('col-sel');
        kids.push(cell);
      }
      kids.push(h('div.ses-filler'));
    }
    // footer: add scene + per-track stop buttons
    const addRow = h('div.ses-addscene', { title: 'Add an empty scene' }, icon('plus', 14), h('span', 'Add scene'));
    addRow.addEventListener('click', () => addScene());
    kids.push(addRow);
    for (const t of p.tracks) {
      if (!launchable(t)) { kids.push(h('div.ses-stopcell')); continue; }
      const b = h('button.ses-stop', { type: 'button', title: `Stop ${t.name} (clear its active pattern)`, disabled: !t.activePatternId }, icon('stop', 11));
      b.addEventListener('click', () => stopTrack(t.id));
      kids.push(h('div.ses-stopcell', b));
    }
    kids.push(h('div.ses-filler'));
    grid.replaceChildren(...kids);
    grid.classList.toggle('is-playing', playing);
    scroll.scrollLeft = scrollPos[0];
    scroll.scrollTop = scrollPos[1];
  }

  // progress rings
  function frame() {
    raf = 0;
    if (!visible) return;
    const p = get();
    const playing = !!engine.isPlaying && p.mode === 'pattern';
    if (playing !== grid.classList.contains('is-playing')) render();
    const ps = pos();
    for (const r of rings) {
      const pat = p.patterns[r.patternId];
      const L = pat?.length || 0;
      const prog = playing && L > 0 ? (((ps % L) + L) % L) / L : 0;
      r.circle.style.strokeDashoffset = String(RING_C * (1 - prog));
    }
    raf = requestAnimationFrame(frame);
  }

  app.subscribe((r) => {
    if (!visible) { if (r.project) stale = true; return; }
    if (r.project || 'selectedTrackId' in r.ui || 'selectedPatternId' in r.ui || 'theme' in r.ui) render();
  });

  return {
    el,
    show() {
      visible = true;
      render();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    hide() {
      visible = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    launchScene, captureScene,
  };
}
