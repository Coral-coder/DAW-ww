// Arrangement timeline: track headers, ruler / markers / loop bar, and a single virtualized
// canvas with pattern & audio clips. Clip editing (move / resize / trim / split / duplicate /
// erase / rubber-band), drag & drop from the browser and the OS, follow-playhead.
import { h, icon, startDrag, fitCanvas } from '../dom.js';
import { button, iconButton, toggle, select, fader, meter, contextMenu, promptText, confirmDialog, toast } from '../components.js';
import { beatsPerBar, songLengthBeats, patternsForTrack, createClip, createPattern, TRACK_COLORS } from '../../core/model.js';
import { uid, clamp, deepClone } from '../../core/util.js';
import { isTyping } from '../keyboard.js';

// ----------------------------------------------------------------------------- constants
const RULER_H = 22;
const MARK_H = 18;
const LOOP_H = 14;
const TOP_H = RULER_H + MARK_H + LOOP_H;
const ADD_ROW_H = 46;
const MIN_PPB = 1.2;
const MAX_PPB = 480;
const MIN_LANE = 26;
const MAX_LANE = 180;
const DT_SAMPLE = 'application/x-heroic-sample';
const DT_PRESET = 'application/x-heroic-preset';
const EPS = 1e-6;

const SNAP_OPTIONS = [
  { value: 'bar', label: 'Snap: Bar' },
  { value: '1', label: 'Snap: Beat' },
  { value: '0.5', label: 'Snap: 1/2 beat' },
  { value: '0.25', label: 'Snap: 1/4 beat' },
  { value: '0.125', label: 'Snap: 1/8 beat' },
  { value: 'off', label: 'Snap: Off' },
];
export const COLOR_NAMES = ['Red', 'Orange', 'Yellow', 'Lime', 'Teal', 'Cyan', 'Blue', 'Indigo', 'Violet', 'Purple', 'Pink', 'Grey'];

const TOOLS = [
  { id: 'pointer', icon: 'pointer', label: 'Pointer', tip: 'Pointer — click to select (Shift adds), drag to move, drag edges to resize/trim, Alt-drag copies, drag empty space to rubber-band select, double-click to create/edit' },
  { id: 'pencil', icon: 'pencil', label: 'Pencil', tip: 'Pencil — click an empty lane to draw a clip, drag to set its length' },
  { id: 'scissors', icon: 'scissors', label: 'Scissors', tip: 'Scissors — click a clip to split it at the grid line' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', tip: 'Eraser — click or drag across clips to delete them' },
];

let clipboard = null; // { clips: Clip[], minStart } shared between arrange instances

// ----------------------------------------------------------------------------- shared helpers (also used by the session view)
const rgbCache = new Map();
export function hexToRgb(hex) {
  if (rgbCache.has(hex)) return rgbCache.get(hex);
  let s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  const out = Number.isFinite(n) && s.length >= 6 ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [136, 136, 136];
  rgbCache.set(hex, out);
  return out;
}
export const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
const mixRgb = (rgb, to, t) => rgb.map((v, i) => Math.round(v + (to[i] - v) * t));

export const isDrumTrack = (t) => !!t && t.type === 'instrument' && t.instrument?.type === 'drums';

/** Hash of a pattern's content — cheap cache key for previews. */
export function patternSignature(pat) {
  let hsh = (pat.length * 1000) | 0;
  for (const n of pat.notes || []) {
    hsh = (Math.imul(hsh, 31) + n.pitch * 131 + ((n.start * 960) | 0) * 7 + ((n.dur * 960) | 0) * 3 + ((n.vel ?? 0.8) * 100 | 0)) | 0;
  }
  return `${pat.notes?.length || 0}:${hsh}`;
}

/**
 * Draw one pass of a pattern's notes into the rect (x, y, w, h). Drums: one row per used pad
 * with short ticks; melodic: tiny note bars scaled to the pattern's pitch range.
 */
export function drawPatternNotes(ctx, pat, { x, y, w, h, color = '#fff', drums = false, minW = 1 }) {
  const notes = pat?.notes || [];
  const L = pat?.length || 0;
  if (!notes.length || !(L > 0) || w <= 0 || h <= 0) return;
  const bw = w / L;
  ctx.fillStyle = color;
  if (drums) {
    const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => b - a);
    const row = new Map(pitches.map((p, i) => [p, i]));
    const rh = h / pitches.length;
    const th = Math.max(1, rh * 0.72);
    for (const n of notes) {
      if (n.start >= L) continue;
      const nx = x + n.start * bw;
      const nw = Math.max(minW, Math.min(bw * Math.min(n.dur || 0.25, 0.25), Math.max(minW, rh * 0.9)));
      ctx.globalAlpha = 0.45 + 0.55 * (n.vel ?? 0.8);
      ctx.fillRect(nx, y + row.get(n.pitch) * rh + (rh - th) / 2, nw, th);
    }
  } else {
    let lo = Infinity, hi = -Infinity;
    for (const n of notes) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
    const span = Math.max(12, hi - lo + 1);
    const mid = (lo + hi) / 2;
    lo = mid - span / 2; hi = mid + span / 2;
    const nh = clamp(h / span, 1, Math.max(1.5, h / 8));
    for (const n of notes) {
      if (n.start >= L) continue;
      const nx = x + n.start * bw;
      const nw = Math.max(minW, Math.min(n.dur || 0.25, L - n.start) * bw - (bw > 4 ? 0.5 : 0));
      const ny = y + ((hi - n.pitch - 0.5) / span) * h - nh / 2;
      ctx.globalAlpha = 0.55 + 0.45 * (n.vel ?? 0.8);
      ctx.fillRect(nx, clamp(ny, y, y + h - nh), nw, nh);
    }
  }
  ctx.globalAlpha = 1;
}

/** Length (beats) of a scene: its longest pattern rounded up to whole bars (min 1 bar). */
export function sceneLengthBeats(project, scene) {
  const bpb = beatsPerBar(project);
  let longest = 0;
  for (const [tid, pid] of Object.entries(scene.slots || {})) {
    const pat = project.patterns[pid];
    if (pat && project.tracks.some((t) => t.id === tid)) longest = Math.max(longest, pat.length || 0);
  }
  return Math.max(bpb, Math.ceil(longest / bpb - 1e-9) * bpb);
}

const songEndBar = (p) => {
  const bpb = beatsPerBar(p);
  const end = p.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return Math.ceil(end / bpb - 1e-9) * bpb;
};

/**
 * Lay out every scene sequentially on the timeline (one clip per filled slot, a marker per scene).
 * barsPerScene: number | null (auto = longest pattern). replace: drop existing pattern clips & markers.
 * Returns { clips, beats } or null.
 */
export function scenesToArrangement(app, { barsPerScene = null, replace = true } = {}) {
  const { store } = app;
  const p = store.get();
  const bpb = beatsPerBar(p);
  if (!p.scenes.length) { toast('There are no scenes yet — add one in the Scenes view (2).', { level: 'warn' }); return null; }
  let start = replace ? 0 : songEndBar(p);
  const origin = start;
  const clips = [];
  const markers = [];
  for (const sc of p.scenes) {
    const len = barsPerScene ? barsPerScene * bpb : sceneLengthBeats(p, sc);
    for (const [tid, pid] of Object.entries(sc.slots || {})) {
      const t = p.tracks.find((x) => x.id === tid);
      if (!t || t.type !== 'instrument' || !p.patterns[pid]) continue;
      clips.push(createClip(tid, { patternId: pid, start, length: len }));
    }
    markers.push({ id: uid('mk'), beat: start, name: sc.name || 'Scene' });
    start += len;
  }
  if (!clips.length) { toast('Your scenes have no patterns in them yet.', { level: 'warn' }); return null; }
  store.transact('Scenes → arrangement', (pp) => {
    if (replace) {
      pp.clips = pp.clips.filter((c) => c.type === 'audio');
      pp.markers = markers;
      pp.loop = { ...(pp.loop || {}), start: 0, end: start };
    } else {
      pp.markers = [...(pp.markers || []), ...markers].sort((a, b) => a.beat - b.beat);
    }
    pp.clips.push(...clips);
  });
  return { clips: clips.length, beats: start - origin, start: origin };
}

/** Put a clip of every instrument track's active pattern at `start` (bars = loop length, null = one pass). */
export function clipsFromActivePatterns(app, { start = 0, bars = null } = {}) {
  const { store } = app;
  const p = store.get();
  const bpb = beatsPerBar(p);
  const clips = [];
  for (const t of p.tracks) {
    if (t.type !== 'instrument') continue;
    const pat = p.patterns[t.activePatternId];
    if (!pat) continue;
    clips.push(createClip(t.id, { patternId: pat.id, start, length: bars ? bars * bpb : pat.length }));
  }
  if (!clips.length) { toast('No instrument track has an active pattern yet.', { level: 'warn' }); return []; }
  store.transact('Clips from active patterns', (pp) => { pp.clips.push(...clips); });
  return clips;
}

const loadPrefs = () => { try { return JSON.parse(localStorage.getItem('heroic-arrange') || '{}'); } catch { return {}; } };
const mod = (a, n) => (n > 0 ? ((a % n) + n) % n : a);

// ============================================================================ the view
export function createArrangeView(app) {
  const { store, ui, engine, actions } = app;
  const get = () => store.get();
  const prefs = loadPrefs();
  let ppb = clamp(prefs.ppb ?? 24, MIN_PPB, MAX_PPB); // pixels per beat
  let laneH = clamp(prefs.laneH ?? 60, MIN_LANE, MAX_LANE);
  let headW = clamp(prefs.headW ?? 210, 150, 380);
  let snapMode = prefs.snap ?? 'bar';
  let tool = 'pointer';
  let visible = false;
  let stale = true;
  let dragging = false;
  let version = 0; // project version (bumped on every project change)
  let theme = {};

  const savePrefs = () => { try { localStorage.setItem('heroic-arrange', JSON.stringify({ ppb, laneH, headW, snap: snapMode })); } catch { /* ignore */ } };
  const bpbNow = () => beatsPerBar(get());
  const snapStep = () => (snapMode === 'off' ? 0 : snapMode === 'bar' ? bpbNow() : Number(snapMode));
  const snapB = (b, ev, fn = Math.round) => {
    const s = ev && (ev.ctrlKey || ev.metaKey) ? 0 : snapStep();
    if (!s) return b;
    const q = fn === Math.floor ? Math.floor(b / s + 1e-7) : fn === Math.ceil ? Math.ceil(b / s - 1e-7) : Math.round(b / s);
    return q * s;
  };
  const minLen = () => snapStep() || 0.25;
  const selIds = () => ui.get('selectedClipIds') || [];
  const setSel = (ids) => ui.set({ selectedClipIds: [...new Set(ids)] });
  const pos = () => (engine.getPosition ? engine.getPosition() : 0) || 0;
  const trackById = (id) => get().tracks.find((t) => t.id === id);
  /** One undo step per drag: the first transact records, later ones don't. */
  const dragTx = (label) => { let started = false; return (fn) => { store.transact(label, fn, started ? { undo: false } : {}); started = true; }; };

  // ------------------------------------------------------------------ toolbar
  const menuAt = (anchor, items) => {
    const r = anchor.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, items.filter(Boolean));
  };
  const addTrackBtn = button('Track', (e) => menuAt(e.currentTarget, actions.addTrackMenuItems()), { icon: 'plus', title: 'Add a track: drum machine, instrument preset, synth, sampler, audio or code' });
  const toolBtns = {};
  const toolGroup = h('div.arr-seg', { title: 'Editing tool' }, TOOLS.map((t) => {
    const b = iconButton(t.icon, () => setTool(t.id), t.tip);
    toolBtns[t.id] = b;
    return b;
  }));
  const snapSel = select({ options: SNAP_OPTIONS, value: snapMode, cls: 'arr-snap', title: 'Grid snap for moving, resizing, splitting and drawing clips. Hold Ctrl/⌘ while dragging to move freely.', onChange: (v) => { snapMode = v; savePrefs(); invalidate(); } });
  const zoomOutBtn = iconButton('zoomOut', () => zoomBy(1 / 1.5), 'Zoom out (Ctrl + mouse wheel)');
  const zoomInBtn = iconButton('zoomIn', () => zoomBy(1.5), 'Zoom in (Ctrl + mouse wheel)');
  const fitBtn = button('Fit', () => zoomToFit(), { cls: 'small', title: 'Zoom to fit the whole song in view' });
  const followBtn = toggle({ label: 'Follow', value: ui.get('followPlayhead') !== false, title: 'Follow playhead: page the timeline along while the song plays', onChange: (v) => ui.set({ followPlayhead: v }) });
  const p2sBtn = button('Pattern ▸ Song', (e) => menuAt(e.currentTarget, patternToSongItems()), { icon: 'layers', title: 'Build an arrangement from your scenes or the patterns that are playing now' });
  const markerBtn = button('Marker', () => addMarkerAt(snapB(pos(), null, Math.floor)), { icon: 'plus', cls: 'small', title: 'Add a section marker at the playhead (or double-click the marker lane)' });
  const loopBtn = toggle({ label: 'Loop', value: !!get().loop?.enabled, title: 'Loop region on/off (L). Drag in the loop lane above the tracks to set it.', onChange: (v) => store.transact('Toggle loop', (p) => { p.loop.enabled = v; }) });
  const moreBtn = button('More', (e) => menuAt(e.currentTarget, moreItems()), { icon: 'chevronDown', cls: 'small', title: 'More arrangement commands' });
  const hint = h('span.arr-hint');
  const toolbar = h('div.view-toolbar.arr-toolbar',
    addTrackBtn, h('div.sep'), toolGroup, snapSel, h('div.sep'),
    zoomOutBtn, zoomInBtn, fitBtn, followBtn, h('div.sep'),
    p2sBtn, markerBtn, loopBtn, moreBtn, hint);

  // ------------------------------------------------------------------ banner
  const bannerText = h('span.arr-banner-text');
  const bannerBtns = h('span.arr-banner-btns');
  const banner = h('div.arr-banner.hidden', icon('help', 14), bannerText, bannerBtns);

  // ------------------------------------------------------------------ body
  const laneHBtn = (ic, f, tip) => iconButton(ic, () => setLaneH(laneH * f), tip, 'arr-mini');
  const corner = h('div.arr-corner',
    h('div.arr-corner-row', { style: { height: RULER_H + 'px' } }, laneHBtn('minus', 1 / 1.25, 'Smaller tracks (Alt + wheel)'), laneHBtn('plus', 1.25, 'Taller tracks (Alt + wheel)'), h('span.spacer'), h('span.arr-corner-lbl', { title: 'Click the ruler to move the playhead; drag to scrub' }, 'Bars')),
    h('div.arr-corner-row', { style: { height: MARK_H + 'px' } }, h('span.spacer'), h('span.arr-corner-lbl', { title: 'Double-click the marker lane to add a section marker; drag to move; right-click for options' }, 'Markers')),
    h('div.arr-corner-row', { style: { height: LOOP_H + 'px' } }, h('span.spacer'), h('span.arr-corner-lbl', { title: 'Drag to draw the loop region, drag its edges to resize, click it to toggle looping' }, 'Loop')));
  const topCanvas = h('canvas.arr-top-canvas');
  const topPlayhead = h('div.arr-top-playhead');
  const top = h('div.arr-top', topCanvas, topPlayhead);
  const headsInner = h('div.arr-heads-inner');
  const addRow = h('div.arr-add-row', button('Add track', (e) => menuAt(e.currentTarget, actions.addTrackMenuItems()), { icon: 'plus', cls: 'small', title: 'Add a new track' }));
  const reorderInd = h('div.arr-reorder-ind.hidden');
  headsInner.append(addRow, reorderInd);
  const heads = h('div.arr-heads', headsInner);
  const headResizer = h('div.arr-head-resizer', { title: 'Drag to resize the track header column' });
  const canvas = h('canvas.arr-canvas');
  const playhead = h('div.arr-playhead');
  const rubber = h('div.arr-rubber.hidden');
  const hoverLine = h('div.arr-hover-line.hidden');
  const dropInd = h('div.arr-drop.hidden');
  const spacer = h('div.arr-spacer');
  const scroller = h('div.arr-scroll', spacer);
  const lanes = h('div.arr-lanes', canvas, playhead, hoverLine, rubber, dropInd, scroller);

  const emptyBtn = (label, ic, fn, primary) => button(label, fn, { icon: ic, primary, title: label });
  const empty = h('div.arr-empty.hidden', h('div.arr-empty-card',
    h('div.arr-empty-icon', icon('timeline', 34)),
    h('h3', 'Your arrangement is empty'),
    h('p', 'Generate a complete song in any genre, start from a beat or a synth, or bring in audio and Strudel code. Everything you add shows up here as tracks you can arrange.'),
    h('div.arr-empty-actions',
      emptyBtn('Generate a song', 'wand', () => actions.showSongWizard(), true),
      emptyBtn('Add drum track', 'drum', () => quickStart('drums')),
      emptyBtn('Add synth', 'piano', () => quickStart('synth')),
      emptyBtn('Import audio', 'wave', () => importAudioAt(null, 0)),
      emptyBtn('Import Strudel', 'code', () => actions.importStrudel())),
    h('p.arr-empty-tip', 'Tip: drag samples or presets from the Browser and drop audio, .strudel or project files anywhere on this view.')));

  const body = h('div.arr-body', corner, top, heads, lanes, headResizer, empty);
  const el = h('div.arr', toolbar, banner, body);

  // ------------------------------------------------------------------ theme
  function readTheme() {
    const cs = getComputedStyle(el);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    theme = {
      dark: (ui.get('theme') || 'dark') !== 'light',
      bg: v('--bg', '#0f1116'), bg2: v('--bg-2', '#151821'), bg3: v('--bg-3', '#1b1f2a'), bg4: v('--bg-4', '#232836'),
      line: v('--line', '#2a3040'), text: v('--text', '#e6e9f2'), text2: v('--text-2', '#a7aec2'), text3: v('--text-3', '#6d7590'),
      accent: v('--accent', '#7c5cff'), accent2: v('--accent-2', '#00d4ff'), accent3: v('--accent-3', '#ff4fa3'),
      gridBar: v('--grid-bar', 'rgba(255,255,255,.16)'), gridBeat: v('--grid-beat', 'rgba(255,255,255,.08)'), gridStep: v('--grid-step', 'rgba(255,255,255,.035)'),
      laneA: v('--arr-lane-a', '#12151c'), laneB: v('--arr-lane-b', '#151922'), laneSel: v('--arr-lane-sel', 'rgba(124,92,255,.1)'),
      below: v('--arr-below', '#0c0e13'), section: v('--arr-section', 'rgba(255,255,255,.025)'), loopShade: v('--arr-loop-shade', 'rgba(0,212,255,.05)'),
      clipText: v('--arr-clip-text', '#0b0d12'), sel: v('--arr-sel', '#ffffff'),
      font: v('--font', 'system-ui, sans-serif'), mono: v('--mono', 'monospace'),
    };
  }

  // ------------------------------------------------------------------ tools / zoom
  function setTool(t) {
    tool = t;
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', id === t);
    scroller.dataset.tool = t;
    hint.textContent = TOOLS.find((x) => x.id === t).tip.split(' — ')[1];
    hoverLine.classList.add('hidden');
  }

  function setLaneH(v) {
    const centerTrack = (scroller.scrollTop + scroller.clientHeight / 2) / laneH;
    laneH = Math.round(clamp(v, MIN_LANE, MAX_LANE));
    savePrefs();
    syncHeaders();
    layout();
    scroller.scrollTop = Math.max(0, centerTrack * laneH - scroller.clientHeight / 2);
    drawNow();
  }

  function zoomAt(factor, mx) {
    const beat = (scroller.scrollLeft + mx) / ppb;
    ppb = clamp(ppb * factor, MIN_PPB, MAX_PPB);
    savePrefs();
    layout();
    scroller.scrollLeft = Math.max(0, beat * ppb - mx);
    drawNow();
  }
  const zoomBy = (f) => zoomAt(f, scroller.clientWidth / 2);
  function zoomToFit() {
    const p = get();
    const end = Math.max(p.clips.length ? songLengthBeats(p) : bpbNow() * 16, ...(p.markers || []).map((m) => m.beat + bpbNow()));
    ppb = clamp((scroller.clientWidth - 24) / end, MIN_PPB, MAX_PPB);
    savePrefs();
    layout();
    scroller.scrollLeft = 0;
    drawNow();
  }

  // ------------------------------------------------------------------ layout & draw scheduling
  function totalBeats() {
    const p = get();
    const bpb = beatsPerBar(p);
    const end = Math.max(songLengthBeats(p), p.loop?.end || 0, ...(p.markers || []).map((m) => m.beat));
    return Math.max(end + bpb * 32, (scroller.clientWidth || 800) / ppb + bpb * 4);
  }
  function layout() {
    const p = get();
    body.style.setProperty('--arr-head-w', headW + 'px');
    spacer.style.width = Math.ceil(totalBeats() * ppb) + 'px';
    spacer.style.height = (p.tracks.length * laneH + ADD_ROW_H + 24) + 'px';
    const w = scroller.clientWidth, hh = scroller.clientHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = hh + 'px';
    topCanvas.style.width = w + 'px';
    headsInner.style.height = (p.tracks.length * laneH + ADD_ROW_H + 24) + 'px';
    addRow.style.top = p.tracks.length * laneH + 'px';
    addRow.style.height = ADD_ROW_H + 'px';
    syncScrollY();
  }
  function syncScrollY() { headsInner.style.transform = `translateY(${-scroller.scrollTop}px)`; }

  let rafDraw = 0;
  function invalidate() {
    if (!visible) { stale = true; return; }
    if (!rafDraw) rafDraw = requestAnimationFrame(() => { rafDraw = 0; drawNow(); });
  }
  function drawNow() {
    if (!visible) return;
    try { drawLanes(); drawTop(); updatePlayhead(); } catch (e) { console.error('[arrange draw]', e); }
  }

  // ------------------------------------------------------------------ pattern preview cache (offscreen canvases)
  const sigCache = new Map(); // patId -> { ver, sig }
  const previewCache = new Map(); // key -> { canvas, wpb, dpr, h }
  function sigOf(pat) {
    let e = sigCache.get(pat.id);
    if (!e || e.ver !== version) { e = { ver: version, sig: patternSignature(pat) }; sigCache.set(pat.id, e); }
    return e.sig;
  }
  function getPreview(pat, drums, hCss, color) {
    const dpr = window.devicePixelRatio || 1;
    const L = pat.length;
    const wpb = Math.min(Math.max(ppb, 2), 6000 / (L * dpr)); // CSS px per beat of the cached image
    const key = `${pat.id}|${sigOf(pat)}|${wpb.toFixed(2)}|${hCss}|${color}|${dpr}|${drums ? 1 : 0}`;
    let e = previewCache.get(key);
    if (e) return e;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(L * wpb * dpr));
    c.height = Math.max(1, Math.ceil(hCss * dpr));
    const cx = c.getContext('2d');
    drawPatternNotes(cx, pat, { x: 0, y: 0, w: L * wpb * dpr, h: hCss * dpr, color, drums, minW: Math.max(1, dpr) });
    e = { canvas: c, wpb, dpr, h: hCss };
    previewCache.set(key, e);
    if (previewCache.size > 400) previewCache.delete(previewCache.keys().next().value);
    return e;
  }

  // ------------------------------------------------------------------ audio peaks cache
  const peaks = new Map(); // sampleId -> { status, min, max, bucketSec, duration, failedAt }
  function getPeaks(sampleId) {
    let e = peaks.get(sampleId);
    if (e && !(e.status === 'error' && performance.now() - e.failedAt > 5000)) return e;
    e = { status: 'loading' };
    peaks.set(sampleId, e);
    if (!engine.decodeSample) { e.status = 'error'; e.failedAt = performance.now(); return e; }
    Promise.resolve().then(() => engine.decodeSample(sampleId)).then((buf) => {
      if (!buf || !buf.getChannelData) throw new Error('no buffer');
      const n = buf.length;
      const bucket = 256;
      const nb = Math.ceil(n / bucket);
      const mn = new Float32Array(nb), mx = new Float32Array(nb);
      const chans = Math.min(2, buf.numberOfChannels);
      const data = [];
      for (let c = 0; c < chans; c++) data.push(buf.getChannelData(c));
      for (let b = 0; b < nb; b++) {
        let lo = 0, hi = 0;
        const end = Math.min(n, (b + 1) * bucket);
        for (let i = b * bucket; i < end; i++) {
          const s = chans > 1 ? (data[0][i] + data[1][i]) * 0.5 : data[0][i];
          if (s < lo) lo = s; else if (s > hi) hi = s;
        }
        mn[b] = lo; mx[b] = hi;
      }
      Object.assign(e, { status: 'ready', min: mn, max: mx, bucketSec: bucket / buf.sampleRate, duration: buf.duration });
      invalidate();
    }).catch(() => { e.status = 'error'; e.failedAt = performance.now(); invalidate(); });
    return e;
  }

  // ------------------------------------------------------------------ draw: lanes
  function drawLanes() {
    const { ctx, w: W, h: H } = fitCanvas(canvas);
    const p = get();
    const bpb = beatsPerBar(p);
    const sx = scroller.scrollLeft, sy = scroller.scrollTop;
    const b0 = sx / ppb, b1 = (sx + W) / ppb;
    const tracks = p.tracks;
    const selTrack = ui.get('selectedTrackId');
    const first = Math.max(0, Math.floor(sy / laneH));
    const last = Math.min(tracks.length - 1, Math.floor((sy + H) / laneH));
    const xOf = (b) => b * ppb - sx;

    ctx.fillStyle = theme.below;
    ctx.fillRect(0, 0, W, H);
    // lane backgrounds
    for (let i = first; i <= last; i++) {
      const y = i * laneH - sy;
      ctx.fillStyle = i % 2 ? theme.laneB : theme.laneA;
      ctx.fillRect(0, y, W, laneH);
      if (tracks[i].id === selTrack) { ctx.fillStyle = theme.laneSel; ctx.fillRect(0, y, W, laneH); }
    }
    const lanesBottom = Math.min(H, tracks.length * laneH - sy);
    // section shading between markers
    const markers = [...(p.markers || [])].sort((a, b) => a.beat - b.beat);
    for (let i = 0; i < markers.length; i++) {
      if (i % 2) continue;
      const a = markers[i].beat, b = markers[i + 1]?.beat ?? totalBeats();
      if (b < b0 || a > b1) continue;
      ctx.fillStyle = theme.section;
      ctx.fillRect(xOf(a), 0, (b - a) * ppb, Math.max(0, lanesBottom));
    }
    // loop shading
    const loop = p.loop;
    if (loop?.enabled && loop.end > loop.start) {
      ctx.fillStyle = theme.loopShade;
      ctx.fillRect(xOf(loop.start), 0, (loop.end - loop.start) * ppb, Math.max(0, lanesBottom));
    }
    // grid
    if (lanesBottom > 0) drawGrid(ctx, W, lanesBottom, b0, b1, bpb, sx);
    for (const m of markers) {
      if (m.beat < b0 || m.beat > b1) continue;
      ctx.fillStyle = rgba(hexToRgb(markerColor(p, m)), 0.45);
      ctx.fillRect(Math.round(xOf(m.beat)), 0, 1, Math.max(0, lanesBottom));
    }
    // lane separators
    ctx.fillStyle = theme.line;
    for (let i = first; i <= last; i++) ctx.fillRect(0, (i + 1) * laneH - sy - 1, W, 1);

    // code-track lanes
    for (let i = first; i <= last; i++) if (tracks[i].type === 'code') drawCodeLane(ctx, tracks[i], i * laneH - sy, W);

    // clips
    const idx = new Map();
    for (let i = first; i <= last; i++) idx.set(tracks[i].id, i);
    const sel = new Set(selIds());
    const selected = [];
    ctx.font = `600 11px ${theme.font}`;
    ctx.textBaseline = 'middle';
    for (const c of p.clips) {
      const i = idx.get(c.trackId);
      if (i === undefined) continue;
      if (c.start + c.length < b0 || c.start > b1) continue;
      if (sel.has(c.id)) { selected.push([c, i]); continue; }
      drawClip(ctx, p, c, tracks[i], i * laneH - sy, W, sx, b0, b1, false);
    }
    for (const [c, i] of selected) drawClip(ctx, p, c, tracks[i], i * laneH - sy, W, sx, b0, b1, true);
  }

  function drawGrid(ctx, W, H, b0, b1, bpb, sx) {
    const barPx = bpb * ppb;
    let barStep = 1;
    while (barStep * barPx < 8) barStep *= 2;
    const step = snapStep();
    const showSub = step && step < 1 && step * ppb >= 8;
    const showBeat = ppb >= 7;
    const startBeat = Math.floor(b0);
    if (showSub) {
      ctx.fillStyle = theme.gridStep;
      for (let b = Math.floor(b0 / step) * step; b <= b1; b += step) {
        if (Math.abs(b - Math.round(b)) < EPS) continue;
        ctx.fillRect(Math.round(b * ppb - sx), 0, 1, H);
      }
    }
    if (showBeat) {
      ctx.fillStyle = theme.gridBeat;
      for (let b = startBeat; b <= b1; b++) {
        if (mod(b, bpb) < EPS) continue;
        ctx.fillRect(Math.round(b * ppb - sx), 0, 1, H);
      }
    }
    ctx.fillStyle = theme.gridBar;
    const firstBar = Math.floor(b0 / bpb / barStep) * barStep;
    for (let bar = firstBar; bar * bpb <= b1; bar += barStep) ctx.fillRect(Math.round(bar * bpb * ppb - sx), 0, 1, H);
  }

  function drawCodeLane(ctx, t, y, W) {
    const rgb = hexToRgb(t.color);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y + 3, W, laneH - 7);
    ctx.clip();
    ctx.fillStyle = rgba(rgb, t.mute ? 0.04 : 0.1);
    ctx.fillRect(0, y, W, laneH);
    ctx.strokeStyle = rgba(rgb, t.mute ? 0.08 : 0.22);
    ctx.lineWidth = 3;
    const off = scroller.scrollLeft % 14;
    ctx.beginPath();
    for (let x = -laneH - off; x < W + laneH; x += 14) { ctx.moveTo(x, y + laneH); ctx.lineTo(x + laneH, y); }
    ctx.stroke();
    ctx.restore();
    if (laneH >= 30) {
      ctx.font = `600 11px ${theme.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.text2;
      ctx.fillText(t.mute ? '⟳ live code (muted) — click to open the Code view' : '⟳ live code — plays continuously in both modes · click to edit in the Code view', 10, y + laneH / 2);
    }
  }

  function clipLabel(p, c) {
    if (c.name) return c.name;
    if (c.type === 'audio') return p.samples?.[c.sampleId]?.name || 'Audio';
    return p.patterns[c.patternId]?.name || 'Missing pattern';
  }

  function drawClip(ctx, p, c, t, laneY, W, sx, b0, b1, selected) {
    const pat = c.type === 'pattern' ? p.patterns[c.patternId] : null;
    const color = pat?.color || c.color || t.color || '#8a93a8';
    const rgb = hexToRgb(color);
    const x = c.start * ppb - sx;
    const w = Math.max(2, c.length * ppb);
    const y = laneY + 2;
    const hh = laneH - 5;
    const vx0 = Math.max(x, -4), vx1 = Math.min(x + w, W + 4);
    if (vx1 <= vx0) return;
    const muted = t.mute;
    if (vx1 - vx0 < 12) { // fast path when zoomed far out: a solid sliver
      ctx.fillStyle = rgba(rgb, muted ? 0.3 : selected ? 1 : 0.75);
      ctx.fillRect(vx0, y, Math.max(1, vx1 - vx0 - 0.5), hh);
      return;
    }
    ctx.globalAlpha = muted ? 0.45 : 1;
    // body
    ctx.fillStyle = rgba(rgb, theme.dark ? 0.26 : 0.32);
    ctx.beginPath();
    ctx.roundRect(vx0, y, vx1 - vx0, hh, 3);
    ctx.fill();
    const headH = hh >= 30 ? 14 : 0;
    if (headH) {
      ctx.fillStyle = rgba(rgb, selected ? 1 : 0.85);
      ctx.beginPath();
      ctx.roundRect(vx0, y, vx1 - vx0, headH, [3, 3, 0, 0]);
      ctx.fill();
    }
    // content
    const cy = y + headH + 2, ch = hh - headH - 4;
    const ink = rgba(theme.dark ? mixRgb(rgb, [255, 255, 255], 0.35) : mixRgb(rgb, [0, 0, 0], 0.45), 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(vx0, y, vx1 - vx0, hh);
    ctx.clip();
    if (ch > 3) {
      if (c.type === 'audio') drawAudioClip(ctx, p, c, x, cy, ch, W, sx, ink);
      else if (pat) drawPatternClip(ctx, c, pat, t, x, cy, ch, sx, b0, b1, ink, rgb);
      else {
        ctx.fillStyle = rgba(rgb, 0.25);
        for (let hx = Math.floor(vx0 / 8) * 8; hx < vx1; hx += 8) ctx.fillRect(hx, cy, 3, ch);
      }
    }
    // label
    const label = clipLabel(p, c) + (c.type === 'pattern' && pat && Math.abs(c.length - pat.length) > EPS && c.length > pat.length ? `  ×${+(c.length / pat.length).toFixed(2)}` : '');
    const tx = Math.max(x, 0) + 5;
    if (vx1 - tx > 14) {
      if (headH) {
        ctx.fillStyle = theme.clipText;
        ctx.fillText(label, tx, y + headH / 2 + 0.5, Math.max(10, vx1 - tx - 4));
      } else { // compact lanes: label on a chip so it stays readable over the preview
        const maxW = Math.max(10, vx1 - tx - 6);
        const tw = Math.min(ctx.measureText(label).width, maxW);
        ctx.fillStyle = rgba(rgb, 0.92);
        ctx.fillRect(tx - 3, y + hh / 2 - 7, tw + 6, 14);
        ctx.fillStyle = theme.clipText;
        ctx.fillText(label, tx, y + hh / 2 + 0.5, maxW);
      }
    }
    ctx.restore();
    // border
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? theme.sel : rgba(rgb, 0.85);
    ctx.beginPath();
    ctx.roundRect(vx0 + (selected ? 1 : 0.5), y + (selected ? 1 : 0.5), vx1 - vx0 - (selected ? 2 : 1), hh - (selected ? 2 : 1), 3);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawPatternClip(ctx, c, pat, t, x, cy, ch, sx, b0, b1, ink, rgb) {
    const L = pat.length;
    if (!(L > 0)) return;
    const off = c.offset || 0;
    const cs = c.start, ce = c.start + c.length;
    const anchor = cs - off; // where repeat k=0 of the pattern begins
    const from = Math.max(cs, b0), to = Math.min(ce, b1);
    if (to <= from) return;
    if (L * ppb < 5) { // too small to draw individual repeats: density fill
      ctx.fillStyle = rgba(rgb, pat.notes.length ? 0.35 : 0.08);
      ctx.fillRect(from * ppb - sx, cy + ch * 0.25, (to - from) * ppb, ch * 0.5);
      return;
    }
    const drums = isDrumTrack(t);
    const prev = pat.notes.length ? getPreview(pat, drums, Math.max(2, Math.round(ch)), ink) : null;
    let k = Math.floor((from - anchor) / L + EPS);
    for (let s = anchor + k * L; s < to - EPS; k++, s = anchor + k * L) {
      const a = Math.max(s, from), b = Math.min(s + L, to);
      if (b <= a) continue;
      if (prev) {
        const srcX = (a - s) * prev.wpb * prev.dpr;
        const srcW = Math.max(0.5, (b - a) * prev.wpb * prev.dpr);
        ctx.drawImage(prev.canvas, srcX, 0, Math.min(srcW, prev.canvas.width - srcX), prev.canvas.height, a * ppb - sx, cy, (b - a) * ppb, ch);
      }
      if (s > cs + EPS && s >= from - EPS) { // repeat divider
        const dx = Math.round(s * ppb - sx);
        ctx.fillStyle = rgba(rgb, 0.7);
        for (let yy = cy; yy < cy + ch; yy += 4) ctx.fillRect(dx, yy, 1, 2);
      }
    }
  }

  function drawAudioClip(ctx, p, c, x, cy, ch, W, sx, ink) {
    const pk = c.sampleId ? getPeaks(c.sampleId) : null;
    const mid = cy + ch / 2;
    if (!pk || pk.status !== 'ready') {
      ctx.save();
      ctx.fillStyle = ink;
      ctx.globalAlpha *= 0.5;
      ctx.fillRect(Math.max(x, 0), mid, Math.min(W, x + c.length * ppb) - Math.max(x, 0), 1);
      ctx.font = `10px ${theme.font}`;
      ctx.fillText(pk?.status === 'loading' ? 'decoding waveform…' : 'audio', Math.max(x, 0) + 6, mid + 9);
      ctx.restore();
      return;
    }
    const spb = 60 / p.bpm;
    const amp = (ch / 2) * Math.min(2, c.gain ?? 1);
    const px0 = Math.max(Math.floor(x), 0), px1 = Math.min(Math.ceil(x + c.length * ppb), W);
    const n = pk.min.length;
    ctx.fillStyle = ink;
    ctx.beginPath();
    for (let px = px0; px < px1; px++) {
      const beatA = (px + sx) / ppb - c.start + (c.offset || 0);
      const ta = beatA * spb, tb = (beatA + 1 / ppb) * spb;
      if (ta >= pk.duration) break;
      if (tb < 0) continue;
      const ia = Math.max(0, Math.floor(ta / pk.bucketSec));
      const ib = Math.min(n, Math.max(ia + 1, Math.ceil(tb / pk.bucketSec)));
      let lo = 0, hi = 0;
      for (let i = ia; i < ib; i++) { if (pk.min[i] < lo) lo = pk.min[i]; if (pk.max[i] > hi) hi = pk.max[i]; }
      const top = clamp(mid - hi * amp, cy, cy + ch), bot = clamp(mid - lo * amp, cy, cy + ch);
      ctx.rect(px, top, 1, Math.max(1, bot - top));
    }
    ctx.fill();
  }

  // ------------------------------------------------------------------ draw: top (ruler / markers / loop)
  const markerColor = (p, m) => {
    const i = (p.markers || []).indexOf(m);
    return TRACK_COLORS[(Math.max(0, i) * 5 + 2) % TRACK_COLORS.length];
  };
  let markerHit = []; // [{m, x0, x1}]
  function drawTop() {
    const { ctx, w: W } = fitCanvas(topCanvas);
    const p = get();
    const bpb = beatsPerBar(p);
    const sx = scroller.scrollLeft;
    const b0 = sx / ppb, b1 = (sx + W) / ppb;
    ctx.fillStyle = theme.bg2;
    ctx.fillRect(0, 0, W, TOP_H);
    ctx.fillStyle = theme.bg3;
    ctx.fillRect(0, RULER_H, W, MARK_H);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, RULER_H + MARK_H, W, LOOP_H);

    // ruler
    const barPx = bpb * ppb;
    let labelStep = 1;
    while (labelStep * barPx < 42) labelStep *= 2;
    let tickStep = 1;
    while (tickStep * barPx < 7) tickStep *= 2;
    ctx.font = `600 10.5px ${theme.font}`;
    ctx.textBaseline = 'middle';
    const firstBar = Math.floor(b0 / bpb / tickStep) * tickStep;
    for (let bar = firstBar; bar * bpb <= b1; bar += tickStep) {
      const x = Math.round(bar * barPx - sx);
      const labeled = bar % labelStep === 0;
      ctx.fillStyle = labeled ? theme.text3 : theme.line;
      ctx.fillRect(x, labeled ? 4 : 13, 1, labeled ? RULER_H - 4 : RULER_H - 13);
      if (labeled) { ctx.fillStyle = theme.text2; ctx.fillText(String(bar + 1), x + 4, 9); }
    }
    if (ppb >= 9) {
      ctx.fillStyle = theme.line;
      for (let b = Math.floor(b0); b <= b1; b++) {
        if (mod(b, bpb) < EPS) continue;
        ctx.fillRect(Math.round(b * ppb - sx), 17, 1, RULER_H - 17);
      }
      if (ppb >= 44) {
        ctx.fillStyle = theme.text3;
        ctx.font = `9.5px ${theme.font}`;
        for (let b = Math.floor(b0); b <= b1; b++) {
          const beatIn = Math.round(mod(b, bpb));
          if (beatIn === 0) continue;
          ctx.fillText(`${Math.floor(b / bpb) + 1}.${beatIn + 1}`, Math.round(b * ppb - sx) + 3, 12);
        }
      }
    }
    // song end marker
    if (p.clips.length) {
      const ex = songLengthBeats(p) * ppb - sx;
      if (ex > 0 && ex < W) {
        ctx.fillStyle = theme.text3;
        ctx.beginPath(); ctx.moveTo(ex, RULER_H - 7); ctx.lineTo(ex, RULER_H); ctx.lineTo(ex - 6, RULER_H); ctx.fill();
      }
    }

    // markers
    markerHit = [];
    ctx.font = `600 10.5px ${theme.font}`;
    const ms = [...(p.markers || [])].sort((a, b) => a.beat - b.beat);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const x = m.beat * ppb - sx;
      const next = ms[i + 1] ? ms[i + 1].beat * ppb - sx : Infinity;
      const tw = Math.min(ctx.measureText(m.name || 'Marker').width + 12, Math.max(14, next - x - 2));
      if (x + tw < 0 || x > W) { markerHit.push({ m, x0: x, x1: x + tw }); continue; }
      const rgb = hexToRgb(markerColor(p, m));
      ctx.fillStyle = rgba(rgb, dragMarkerId === m.id ? 1 : 0.85);
      ctx.beginPath();
      ctx.roundRect(x, RULER_H + 2, tw, MARK_H - 4, [0, 3, 3, 0]);
      ctx.fill();
      ctx.fillStyle = theme.clipText;
      ctx.fillText(m.name || 'Marker', x + 5, RULER_H + MARK_H / 2 + 0.5, Math.max(4, tw - 8));
      markerHit.push({ m, x0: x, x1: x + tw });
    }

    // loop
    const loop = p.loop;
    if (loop && loop.end > loop.start) {
      const x0 = loop.start * ppb - sx, x1 = loop.end * ppb - sx;
      const y = RULER_H + MARK_H + 2;
      const lh = LOOP_H - 4;
      ctx.fillStyle = loop.enabled ? rgba(hexToRgb(cssHex(theme.accent2)), 0.55) : rgba([128, 128, 140], 0.45);
      ctx.fillRect(x0, y, x1 - x0, lh);
      ctx.fillStyle = loop.enabled ? theme.accent2 : theme.text3;
      ctx.fillRect(x0, y - 1, 3, lh + 2);
      ctx.fillRect(x1 - 3, y - 1, 3, lh + 2);
    }
    ctx.fillStyle = theme.line;
    ctx.fillRect(0, RULER_H - 1, W, 1);
    ctx.fillRect(0, RULER_H + MARK_H - 1, W, 1);
    ctx.fillRect(0, TOP_H - 1, W, 1);
  }
  const cssHex = (c) => (c.startsWith('#') ? c : '#00d4ff');

  // ------------------------------------------------------------------ playhead
  function updatePlayhead() {
    const p = get();
    const x = pos() * ppb - scroller.scrollLeft;
    const W = scroller.clientWidth;
    const show = x >= -1 && x <= W + 1;
    playhead.style.transform = `translateX(${x}px)`;
    topPlayhead.style.transform = `translateX(${x}px)`;
    playhead.classList.toggle('hidden', !show);
    topPlayhead.classList.toggle('hidden', !show);
    const dim = p.mode !== 'song';
    playhead.classList.toggle('dim', dim);
    topPlayhead.classList.toggle('dim', dim);
    return x;
  }
  let rafLoop = 0;
  function frame() {
    rafLoop = 0;
    if (!visible) return;
    const p = get();
    const x = updatePlayhead();
    if (ui.get('followPlayhead') !== false && engine.isPlaying && p.mode === 'song' && !dragging) {
      const W = scroller.clientWidth;
      if (x > W * 0.92 || x < 0) {
        scroller.scrollLeft = Math.max(0, pos() * ppb - W * 0.08);
      }
    }
    if (engine.ctx && engine.getMeter) {
      const first = Math.floor(scroller.scrollTop / laneH);
      const last = Math.ceil((scroller.scrollTop + scroller.clientHeight) / laneH);
      p.tracks.forEach((t, i) => {
        if (i < first || i > last) return;
        const hd = headers.get(t.id);
        if (!hd) return;
        let m;
        try { m = engine.getMeter(t.id); } catch { m = null; }
        if (m) hd.mtr.setLevels(m.l || 0, m.r ?? m.l ?? 0);
      });
    }
    rafLoop = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ track headers
  const headers = new Map(); // trackId -> header
  const typeIcon = (t) => (t.type === 'code' ? 'code' : t.type === 'audio' ? 'wave' : isDrumTrack(t) ? 'drum' : t.instrument?.type === 'sampler' ? 'wave' : 'piano');
  const typeName = (t) => (t.type === 'code' ? 'Code track (Strudel)' : t.type === 'audio' ? 'Audio track' : isDrumTrack(t) ? 'Drum machine' : `${({ synth: 'Analog synth', fm: 'FM synth', organ: 'Organ', sampler: 'Sampler' })[t.instrument?.type] || 'Instrument'}${t.instrument?.preset ? ' · ' + t.instrument.preset : ''}`);

  function colorItems(onPick) {
    return TRACK_COLORS.map((c, i) => ({ label: h('span.arr-swatch-row', h('span.arr-swatch', { style: { background: c } }), COLOR_NAMES[i] || c), onClick: () => onPick(c) }));
  }

  function makeHeader(track) {
    const id = track.id;
    const strip = h('div.arr-th-strip', { title: 'Track color — click to change' });
    const ic = h('span.arr-th-icon');
    const name = h('div.arr-th-name', { title: 'Double-click to rename · drag the header to reorder · right-click for more' });
    const upd = (fn, label, opts) => actions.updateTrack(id, fn, label, opts);
    const mute = toggle({ label: 'M', cls: 'mute', title: 'Mute this track', onChange: (v) => upd((t) => { t.mute = v; }, v ? 'Mute' : 'Unmute') });
    const solo = toggle({ label: 'S', cls: 'solo', title: 'Solo — only soloed tracks are heard', onChange: (v) => upd((t) => { t.solo = v; }, v ? 'Solo' : 'Unsolo') });
    const arm = toggle({ label: '●', cls: 'arm', title: 'Arm for recording (notes you play are recorded into this track\'s active pattern)', onChange: (v) => upd((t) => { t.arm = v; }, v ? 'Arm' : 'Disarm') });
    const vol = fader({ def: { key: 'volume', label: 'Volume', min: 0, max: 1.5, default: 0.8, step: 0.01 }, value: track.volume, vertical: false, length: 62, onChange: (v) => upd((t) => { t.volume = v; }, 'Volume', { coalesce: true }) });
    vol.classList.add('arr-th-vol');
    const mtr = meter({ height: 30 });
    mtr.classList.add('arr-th-meter');
    const ctrls = h('div.arr-th-ctrls', mute, solo, arm, vol);
    const el = h('div.arr-th', strip, h('div.arr-th-main', h('div.arr-th-top', ic, name), ctrls), mtr);

    strip.addEventListener('click', (e) => { e.stopPropagation(); contextMenu(e, [{ header: 'Track color' }, ...colorItems((c) => upd((t) => { t.color = c; }, 'Track color'))]); });
    name.addEventListener('dblclick', () => actions.renameTrack(id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); actions.selectTrack(id); contextMenu(e, actions.trackMenuItems(id)); });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, .fader, input, select, .arr-th-strip')) return;
      const p = get();
      const i0 = p.tracks.findIndex((t) => t.id === id);
      const n = p.tracks.length;
      let moved = false, target = i0;
      startDrag(e, (_dx, dy) => {
        if (!moved && Math.abs(dy) < 5) return;
        moved = true;
        el.classList.add('dragging');
        el.style.transform = `translateY(${dy}px)`;
        target = clamp(Math.round((i0 * laneH + dy) / laneH), 0, n - 1);
        reorderInd.classList.remove('hidden');
        reorderInd.style.top = ((target > i0 ? target + 1 : target) * laneH - 1) + 'px';
      }, () => {
        el.classList.remove('dragging');
        el.style.transform = '';
        reorderInd.classList.add('hidden');
        if (!moved) { actions.selectTrack(id); return; }
        if (target !== i0) {
          store.transact('Reorder tracks', (pp) => {
            const j = pp.tracks.findIndex((t) => t.id === id);
            if (j < 0) return;
            const [t] = pp.tracks.splice(j, 1);
            pp.tracks.splice(target, 0, t);
          });
        }
      });
    });
    return {
      el, mtr,
      update(t, i, selected) {
        el.style.top = i * laneH + 'px';
        el.style.height = laneH + 'px';
        el.style.setProperty('--tc', t.color);
        el.classList.toggle('selected', selected);
        el.classList.toggle('is-muted', !!t.mute);
        if (name.textContent !== t.name) name.textContent = t.name;
        const icn = typeIcon(t);
        if (ic.dataset.icon !== icn) { ic.dataset.icon = icn; ic.replaceChildren(icon(icn, 14)); }
        ic.title = typeName(t);
        mute.setValue(!!t.mute);
        solo.setValue(!!t.solo);
        arm.setValue(!!t.arm);
        arm.classList.toggle('hidden', t.type === 'code');
        vol.setValue(t.volume ?? 0.8);
        mtr.style.height = Math.max(14, laneH - 16) + 'px';
      },
    };
  }

  function syncHeaders() {
    const p = get();
    const sel = ui.get('selectedTrackId');
    const seen = new Set();
    heads.classList.toggle('compact', laneH < 52);
    heads.classList.toggle('tiny', laneH < 36);
    p.tracks.forEach((t, i) => {
      seen.add(t.id);
      let hd = headers.get(t.id);
      if (!hd) { hd = makeHeader(t); headers.set(t.id, hd); headsInner.insertBefore(hd.el, addRow); }
      hd.update(t, i, t.id === sel);
    });
    for (const [id, hd] of headers) if (!seen.has(id)) { hd.el.remove(); headers.delete(id); }
  }

  // header column resize
  headResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const w0 = headW;
    startDrag(e, (dx) => {
      headW = clamp(w0 + dx, 150, 380);
      body.style.setProperty('--arr-head-w', headW + 'px');
    }, () => { savePrefs(); layout(); drawNow(); });
  });

  // ------------------------------------------------------------------ hit testing
  function hitTest(clientX, clientY) {
    const r = scroller.getBoundingClientRect();
    const x = Math.max(0, clientX - r.left + scroller.scrollLeft);
    const y = clientY - r.top + scroller.scrollTop;
    const p = get();
    const lane = Math.floor(y / laneH);
    const track = lane >= 0 ? p.tracks[lane] || null : null;
    const beat = x / ppb;
    let clip = null, edge = null;
    if (track) {
      for (let i = p.clips.length - 1; i >= 0; i--) {
        const c = p.clips[i];
        if (c.trackId !== track.id) continue;
        const cx0 = c.start * ppb, cx1 = (c.start + c.length) * ppb;
        if (x >= cx0 && x < cx1) {
          clip = c;
          const ew = Math.min(8, (cx1 - cx0) / 3);
          if (x >= cx1 - ew) edge = 'right';
          else if (x < cx0 + ew) edge = 'left';
          break;
        }
      }
    }
    return { x, y, beat, lane, track, clip, edge };
  }

  const compatible = (clip, srcTrack, dst) => {
    if (!dst) return false;
    if (clip.type === 'audio') return dst.type === 'audio';
    return dst.type === 'instrument' && isDrumTrack(dst) === isDrumTrack(srcTrack);
  };

  /** Pattern clips moved to another track: re-home (or copy) the pattern so it belongs to its new track. */
  function fixOwnership(pp, ids) {
    const done = new Map();
    for (const c of pp.clips) {
      if (!ids.has(c.id) || c.type !== 'pattern') continue;
      const pat = pp.patterns[c.patternId];
      if (!pat || pat.trackId === c.trackId) continue;
      const key = pat.id + '>' + c.trackId;
      if (done.has(key)) { c.patternId = done.get(key); continue; }
      const used = pp.clips.some((o) => o.patternId === pat.id && o.trackId === pat.trackId)
        || pp.tracks.some((t) => t.id === pat.trackId && t.activePatternId === pat.id)
        || pp.scenes.some((s) => s.slots?.[pat.trackId] === pat.id);
      if (!used) { pat.trackId = c.trackId; done.set(key, pat.id); }
      else {
        const np = { ...deepClone(pat), id: uid('pat'), trackId: c.trackId };
        np.notes = np.notes.map((n) => ({ ...n, id: uid('n') }));
        pp.patterns[np.id] = np;
        c.patternId = np.id;
        done.set(key, np.id);
      }
      const tt = pp.tracks.find((t) => t.id === c.trackId);
      if (tt && !(tt.activePatternId && pp.patterns[tt.activePatternId])) tt.activePatternId = c.patternId;
    }
  }

  // ------------------------------------------------------------------ editing operations
  function createClipAt(track, beat, { length } = {}) {
    if (!track || track.type !== 'instrument') return null;
    const pat = actions.ensurePattern(track.id);
    if (!pat) return null;
    const start = Math.max(0, snapB(beat, null, Math.floor));
    const clip = createClip(track.id, { patternId: pat.id, start, length: length || pat.length });
    store.transact('Add clip', (p) => { p.clips.push(clip); });
    setSel([clip.id]);
    return clip;
  }

  function splitClip(clipId, beat) {
    const c0 = get().clips.find((c) => c.id === clipId);
    if (!c0 || beat <= c0.start + EPS || beat >= c0.start + c0.length - EPS) return false;
    store.transact('Split clip', (p) => {
      const i = p.clips.findIndex((c) => c.id === clipId);
      const c = p.clips[i];
      const cut = beat - c.start;
      const L = p.patterns[c.patternId]?.length || 0;
      const second = { ...deepClone(c), id: uid('clip'), start: beat, length: c.length - cut, offset: c.type === 'pattern' ? mod((c.offset || 0) + cut, L) : (c.offset || 0) + cut };
      c.length = cut;
      p.clips.splice(i + 1, 0, second);
    });
    return true;
  }

  function deleteClips(ids) {
    const s = new Set(ids);
    if (!s.size) return;
    store.transact(s.size > 1 ? `Delete ${s.size} clips` : 'Delete clip', (p) => { p.clips = p.clips.filter((c) => !s.has(c.id)); });
    setSel(selIds().filter((id) => !s.has(id)));
  }
  const deleteSelection = () => deleteClips(selIds());

  function selectedClips() {
    const s = new Set(selIds());
    return get().clips.filter((c) => s.has(c.id));
  }

  function duplicateSelection() {
    const cs = selectedClips();
    if (!cs.length) return;
    const minS = Math.min(...cs.map((c) => c.start));
    const maxE = Math.max(...cs.map((c) => c.start + c.length));
    const span = maxE - minS;
    const copies = cs.map((c) => ({ ...deepClone(c), id: uid('clip'), start: c.start + span }));
    store.transact('Duplicate clips', (p) => { p.clips.push(...copies); });
    setSel(copies.map((c) => c.id));
  }

  function copySelection() {
    const cs = selectedClips();
    if (!cs.length) return false;
    clipboard = { clips: deepClone(cs), minStart: Math.min(...cs.map((c) => c.start)) };
    app.setStatus?.(`Copied ${cs.length} clip(s) — Ctrl+V pastes at the playhead`);
    return true;
  }

  function pasteAt(beat, targetTrackId = null) {
    if (!clipboard?.clips.length) { toast('Nothing to paste — copy clips with Ctrl+C first'); return; }
    const p = get();
    const start = Math.max(0, beat);
    const srcTracks = new Set(clipboard.clips.map((c) => c.trackId));
    let target = targetTrackId ? p.tracks.find((t) => t.id === targetTrackId) : null;
    if (!target && srcTracks.size === 1) target = p.tracks.find((t) => t.id === ui.get('selectedTrackId'));
    const srcTrack = p.tracks.find((t) => t.id === [...srcTracks][0]);
    const useTarget = srcTracks.size === 1 && target && clipboard.clips.every((c) => compatible(c, srcTrack || target, target));
    const copies = [];
    for (const c of clipboard.clips) {
      const trackId = useTarget ? target.id : c.trackId;
      if (!p.tracks.some((t) => t.id === trackId)) continue;
      if (c.type === 'pattern' && !p.patterns[c.patternId]) continue;
      copies.push({ ...deepClone(c), id: uid('clip'), trackId, start: start + (c.start - clipboard.minStart) });
    }
    if (!copies.length) { toast('The copied clips\' tracks no longer exist', { level: 'warn' }); return; }
    store.transact('Paste clips', (pp) => { pp.clips.push(...copies); fixOwnership(pp, new Set(copies.map((c) => c.id))); });
    setSel(copies.map((c) => c.id));
  }

  function nudge(dBeats, dLanes) {
    const cs = selectedClips();
    if (!cs.length) return;
    const p = get();
    const tIdx = new Map(p.tracks.map((t, i) => [t.id, i]));
    const minS = Math.min(...cs.map((c) => c.start));
    const d = Math.max(-minS, dBeats);
    if (dLanes) {
      const ok = cs.every((c) => compatible(c, p.tracks[tIdx.get(c.trackId)], p.tracks[tIdx.get(c.trackId) + dLanes]));
      if (!ok) { app.setStatus?.('Can\'t move there — clips only move to tracks of the same kind'); return; }
    }
    const ids = new Set(cs.map((c) => c.id));
    store.transact('Nudge clips', (pp) => {
      for (const c of pp.clips) {
        if (!ids.has(c.id)) continue;
        c.start = +(c.start + d).toFixed(6);
        if (dLanes) c.trackId = pp.tracks[tIdx.get(c.trackId) + dLanes].id;
      }
      if (dLanes) fixOwnership(pp, ids);
    }, { coalesce: true });
  }

  function makeUnique(clipId) {
    const p = get();
    const c = p.clips.find((x) => x.id === clipId);
    const pat = c && p.patterns[c.patternId];
    if (!pat) return;
    const np = { ...deepClone(pat), id: uid('pat'), name: uniqueName(p, pat.name) };
    np.notes = np.notes.map((n) => ({ ...n, id: uid('n') }));
    store.transact('Make clip unique', (pp) => {
      pp.patterns[np.id] = np;
      const cc = pp.clips.find((x) => x.id === clipId);
      if (cc) cc.patternId = np.id;
    });
    actions.selectPattern(np.id, { activate: false });
    app.setStatus?.(`"${np.name}" is now its own pattern — edits won't affect other clips.`);
  }
  function uniqueName(p, base) {
    const stem = base.replace(/\s*\d+$/, '').trim() || 'Pattern';
    const names = new Set(Object.values(p.patterns).map((x) => x.name));
    for (let i = 2; i < 999; i++) if (!names.has(`${stem} ${i}`)) return `${stem} ${i}`;
    return `${stem} copy`;
  }

  function setClipPattern(clipId, patternId) {
    store.transact('Change clip pattern', (p) => {
      const c = p.clips.find((x) => x.id === clipId);
      if (c && p.patterns[patternId]) { c.patternId = patternId; c.name = null; c.offset = 0; }
    });
  }

  async function renameClip(clipId) {
    const p = get();
    const c = p.clips.find((x) => x.id === clipId);
    if (!c) return;
    const name = await promptText('Clip name', clipLabel(p, c));
    if (name === null) return;
    store.transact('Rename clip', (pp) => {
      const cc = pp.clips.find((x) => x.id === clipId);
      if (!cc) return;
      const pat = cc.type === 'pattern' ? pp.patterns[cc.patternId] : null;
      // rename the pattern itself when this clip is its only user — keeps names in sync everywhere
      if (pat && !pp.clips.some((o) => o !== cc && o.patternId === pat.id)) { pat.name = name || pat.name; cc.name = null; } else cc.name = name || null;
    });
  }

  function openClipEditor(clip) {
    const t = trackById(clip.trackId);
    if (clip.type === 'pattern' && get().patterns[clip.patternId]) {
      actions.selectPattern(clip.patternId);
      app.showView(isDrumTrack(t) ? 'rack' : 'piano');
    } else if (t) {
      actions.selectTrack(t.id);
      ui.set({ deviceOpen: true });
    }
  }

  function openCode(track) {
    actions.selectTrack(track.id);
    app.showView('code');
  }

  async function importAudioAt(track, beat) {
    const added = await actions.importSamples();
    if (added?.[0]) await actions.placeSample(added[0].id, { trackId: track?.type === 'audio' ? track.id : undefined, start: Math.max(0, beat) });
  }

  function quickStart(kind) {
    const bpb = bpbNow();
    if (kind === 'drums') {
      const t = actions.addTrack('drums');
      try { actions.generatePart('drums', { trackId: t.id }); } catch (e) { console.warn(e); }
      const pat = get().patterns[trackById(t.id)?.activePatternId];
      if (pat) store.transact('Add clip', (p) => { p.clips.push(createClip(t.id, { patternId: pat.id, start: 0, length: Math.max(pat.length, bpb * 4) })); });
      toast('Added a drum track with a generated beat. Double-click the clip to edit it in the Step Rack.', { level: 'success' });
    } else {
      const t = actions.addTrack('synth');
      const pat = get().patterns[trackById(t.id)?.activePatternId];
      if (pat) store.transact('Add clip', (p) => { p.clips.push(createClip(t.id, { patternId: pat.id, start: 0, length: pat.length })); });
      toast('Added a synth track. Double-click its clip to write notes in the Piano Roll.', { level: 'success' });
    }
  }

  // markers & loop
  function addMarkerAt(beat) {
    const p = get();
    const m = { id: uid('mk'), beat: Math.max(0, beat), name: `Section ${(p.markers?.length || 0) + 1}` };
    store.transact('Add marker', (pp) => { pp.markers = [...(pp.markers || []), m].sort((a, b) => a.beat - b.beat); });
    return m;
  }
  async function renameMarker(id) {
    const m = (get().markers || []).find((x) => x.id === id);
    if (!m) return;
    const name = await promptText('Marker name', m.name);
    if (name) store.transact('Rename marker', (p) => { const mm = p.markers.find((x) => x.id === id); if (mm) mm.name = name; });
  }
  const deleteMarker = (id) => store.transact('Delete marker', (p) => { p.markers = (p.markers || []).filter((x) => x.id !== id); });
  function setLoop(start, end, enabled = true) {
    if (!(end > start)) return;
    store.transact('Set loop', (p) => { p.loop = { ...(p.loop || {}), start, end, enabled }; });
  }
  function markerSection(m) {
    const ms = [...(get().markers || [])].sort((a, b) => a.beat - b.beat);
    const i = ms.indexOf(m);
    const end = ms[i + 1]?.beat ?? Math.max(songLengthBeats(get()), m.beat + bpbNow());
    return [m.beat, end];
  }

  // ------------------------------------------------------------------ menus
  function patternToSongItems() {
    const p = get();
    const bars = [1, 2, 4, 8, 16];
    return [
      { header: 'Scenes → arrangement' },
      { label: `Fill from ${p.scenes.length} scene${p.scenes.length === 1 ? '' : 's'} (auto length)`, icon: 'scenes', onClick: () => fillFromScenes(null) },
      { label: 'Fill from scenes — bars per scene', icon: 'scenes', submenu: bars.map((n) => ({ label: `${n} bar${n > 1 ? 's' : ''} each`, onClick: () => fillFromScenes(n) })) },
      { label: 'Append scenes after the song end', icon: 'plus', onClick: () => fillFromScenes(null, false) },
      '-',
      { header: 'Active patterns → clips' },
      { label: 'One pass of each active pattern', icon: 'music', onClick: () => clipsFromActive(null) },
      { label: 'Loop each active pattern for…', icon: 'loop', submenu: bars.map((n) => ({ label: `${n} bar${n > 1 ? 's' : ''}`, onClick: () => clipsFromActive(n) })) },
    ];
  }
  async function fillFromScenes(barsPerScene, replace = true) {
    const p = get();
    if (replace && p.clips.some((c) => c.type === 'pattern') && !(await confirmDialog('Replace arrangement?', 'This replaces the pattern clips and markers on the timeline with one section per scene. Audio clips are kept. You can undo with Ctrl+Z.'))) return;
    const res = scenesToArrangement(app, { barsPerScene, replace });
    if (!res) return;
    actions.setMode('song');
    if (replace) actions.setPosition(0);
    zoomToFit();
    toast(`Laid out ${get().scenes.length} scenes as ${Math.round(res.beats / bpbNow())} bars (${res.clips} clips). Song mode is on — press Space.`, { level: 'success', timeout: 5000 });
  }
  function clipsFromActive(bars) {
    const p = get();
    const start = p.mode === 'song' ? snapB(pos(), null, Math.floor) : songEndBar(p);
    const clips = clipsFromActivePatterns(app, { start: Math.max(0, start), bars });
    if (!clips.length) return;
    setSel(clips.map((c) => c.id));
    const x = start * ppb;
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = Math.max(0, x - 60);
    toast(`Placed ${clips.length} clip(s) at bar ${Math.floor(start / bpbNow()) + 1}.${p.mode !== 'song' ? ' Switch to SONG mode (P) to hear the arrangement.' : ''}`, { level: 'success' });
  }

  function moreItems() {
    const p = get();
    const n = selIds().length;
    const cs = selectedClips();
    return [
      { label: 'Select all clips', shortcut: 'Ctrl+A', onClick: () => setSel(p.clips.map((c) => c.id)) },
      { label: `Duplicate selection${n ? ` (${n})` : ''}`, icon: 'copy', shortcut: 'Ctrl+D', disabled: !n, onClick: duplicateSelection },
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !n, onClick: copySelection },
      { label: 'Paste at playhead', shortcut: 'Ctrl+V', disabled: !clipboard, onClick: () => pasteAt(snapB(pos(), null, Math.floor)) },
      { label: 'Delete selection', icon: 'trash', shortcut: 'Del', disabled: !n, onClick: deleteSelection },
      '-',
      { label: 'Loop the selection', icon: 'loop', disabled: !n, onClick: () => setLoop(Math.min(...cs.map((c) => c.start)), Math.max(...cs.map((c) => c.start + c.length))) },
      { label: 'Loop the whole song', icon: 'loop', disabled: !p.clips.length, onClick: () => setLoop(0, songLengthBeats(p)) },
      { label: 'Track height', icon: 'sliders', submenu: [['Small', 34], ['Medium', 60], ['Large', 96], ['Huge', 150]].map(([l, v]) => ({ label: l, onClick: () => setLaneH(v) })) },
      { label: p.mode === 'song' ? 'Switch to Pattern mode' : 'Switch to Song mode', shortcut: 'P', onClick: () => actions.setMode(p.mode === 'song' ? 'pattern' : 'song') },
      '-',
      { label: 'Clear arrangement…', icon: 'trash', disabled: !p.clips.length, onClick: async () => { if (await confirmDialog('Clear arrangement', 'Remove every clip from the timeline? Patterns and tracks are kept.')) { store.transact('Clear arrangement', (pp) => { pp.clips = []; }); setSel([]); } } },
    ];
  }

  function clipMenuItems(clip) {
    const p = get();
    const t = trackById(clip.trackId);
    const pat = clip.type === 'pattern' ? p.patterns[clip.patternId] : null;
    const n = selIds().length;
    const ph = pos();
    const pats = t ? patternsForTrack(p, t.id) : [];
    const items = [
      { header: clipLabel(p, clip) },
      pat ? { label: isDrumTrack(t) ? 'Edit in Step Rack' : 'Edit in Piano Roll', icon: isDrumTrack(t) ? 'grid' : 'piano', onClick: () => openClipEditor(clip) } : null,
      { label: 'Rename…', icon: 'pencil', onClick: () => renameClip(clip.id) },
      { label: n > 1 ? `Duplicate ${n} clips` : 'Duplicate', icon: 'copy', shortcut: 'Ctrl+D', onClick: duplicateSelection },
      { label: 'Split at playhead', icon: 'scissors', disabled: !(ph > clip.start + EPS && ph < clip.start + clip.length - EPS), onClick: () => splitClip(clip.id, ph) },
      pat ? { label: 'Make unique (own copy of the pattern)', icon: 'layers', onClick: () => makeUnique(clip.id) } : null,
      pat || clip.type === 'pattern' ? { label: 'Choose pattern', icon: 'music', submenu: [
        ...pats.map((pt) => ({ label: `${pt.id === clip.patternId ? '● ' : ''}${pt.name}`, onClick: () => setClipPattern(clip.id, pt.id) })),
        '-',
        { label: 'New empty pattern', icon: 'plus', onClick: () => { const np = actions.newPattern(clip.trackId, { length: pat?.length }); if (np) setClipPattern(clip.id, np.id); } },
      ] } : null,
      pat && Math.abs(clip.length - pat.length) > EPS ? { label: `Fit to pattern length (${+(pat.length / bpbNow()).toFixed(2)} bar${pat.length === bpbNow() ? '' : 's'})`, onClick: () => store.transact('Fit clip', (pp) => { const c = pp.clips.find((x) => x.id === clip.id); if (c) { c.length = pat.length; c.offset = 0; } }) } : null,
      { label: 'Color', submenu: colorItems((c) => store.transact('Clip color', (pp) => {
        const ids = new Set(n > 1 ? selIds() : [clip.id]);
        for (const cc of pp.clips) {
          if (!ids.has(cc.id)) continue;
          if (cc.type === 'pattern' && pp.patterns[cc.patternId]) pp.patterns[cc.patternId].color = c; else cc.color = c;
        }
      })) },
      clip.type === 'audio' ? { label: 'Gain', icon: 'volume', submenu: [-12, -6, -3, 0, 3, 6].map((db) => ({ label: `${db > 0 ? '+' : ''}${db} dB${Math.abs(20 * Math.log10(clip.gain ?? 1) - db) < 0.5 ? '  ●' : ''}`, onClick: () => store.transact('Clip gain', (pp) => { const c = pp.clips.find((x) => x.id === clip.id); if (c) c.gain = +Math.pow(10, db / 20).toFixed(4); }) })) } : null,
      { label: 'Loop this clip', icon: 'loop', onClick: () => setLoop(clip.start, clip.start + clip.length) },
      '-',
      { label: n > 1 ? `Delete ${n} clips` : 'Delete', icon: 'trash', shortcut: 'Del', onClick: deleteSelection },
    ];
    return items.filter(Boolean);
  }

  function laneMenuItems(hit) {
    const t = hit.track;
    const beat = Math.max(0, snapB(hit.beat, null, Math.floor));
    const items = [{ header: t.name }];
    if (t.type === 'instrument') items.push({ label: 'Add clip here', icon: 'plus', onClick: () => createClipAt(t, hit.beat) });
    if (t.type === 'audio') items.push({ label: 'Import audio here…', icon: 'upload', onClick: () => importAudioAt(t, beat) });
    if (t.type === 'code') items.push({ label: 'Open in Code view', icon: 'code', onClick: () => openCode(t) });
    if (clipboard) items.push({ label: 'Paste here', shortcut: 'Ctrl+V', onClick: () => pasteAt(beat, t.id) });
    items.push(
      { label: 'Add marker here', icon: 'plus', onClick: () => addMarkerAt(beat) },
      { label: 'Move playhead here', icon: 'play', onClick: () => actions.setPosition(beat) },
      { label: 'Select all clips on this track', onClick: () => setSel(get().clips.filter((c) => c.trackId === t.id).map((c) => c.id)) },
      '-',
      ...actions.trackMenuItems(t.id),
    );
    return items;
  }

  // ------------------------------------------------------------------ lane pointer interactions
  scroller.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // ignore native scrollbar clicks
    const r = scroller.getBoundingClientRect();
    if (e.clientX - r.left >= scroller.clientWidth || e.clientY - r.top >= scroller.clientHeight) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit.track) { if (!e.shiftKey) setSel([]); startRubber(e, hit); return; }
    if (hit.track.type === 'code' && !hit.clip) {
      startDrag(e, () => {}, (ev) => { if (Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) openCode(hit.track); });
      return;
    }
    if (tool === 'eraser') return startErase(e, hit);
    if (tool === 'scissors') {
      if (hit.clip) splitClip(hit.clip.id, snapB(hit.beat, e));
      return;
    }
    if (tool === 'pencil' && !hit.clip) return startPencil(e, hit);
    if (!hit.clip) {
      if (!e.shiftKey) setSel([]);
      if (hit.track.id !== ui.get('selectedTrackId')) actions.selectTrack(hit.track.id);
      return startRubber(e, hit);
    }
    // clip under pointer (pointer tool, or pencil on a clip)
    const id = hit.clip.id;
    const sel = new Set(selIds());
    if (e.shiftKey) {
      if (sel.has(id)) { sel.delete(id); setSel([...sel]); return; }
      sel.add(id);
      setSel([...sel]);
    } else if (!sel.has(id)) setSel([id]);
    if (hit.clip.type === 'pattern' && get().patterns[hit.clip.patternId]) actions.selectPattern(hit.clip.patternId, { activate: false });
    else actions.selectTrack(hit.clip.trackId);
    if (hit.edge) return startResize(e, hit.clip, hit.edge);
    startMove(e, hit.clip);
  });

  function beginDrag() { dragging = true; scroller.classList.add('dragging'); }
  function endDrag() { dragging = false; scroller.classList.remove('dragging'); }

  function startMove(e, anchor) {
    const p = get();
    const tIdx = new Map(p.tracks.map((t, i) => [t.id, i]));
    const orig = new Map();
    for (const c of p.clips) if (selIds().includes(c.id)) orig.set(c.id, { start: c.start, ti: tIdx.get(c.trackId), clip: c, track: p.tracks[tIdx.get(c.trackId)] });
    if (!orig.size) return;
    const a0 = anchor.start;
    const minStart = Math.min(...[...orig.values()].map((o) => o.start));
    const dup = e.altKey;
    const tx = dragTx(dup ? 'Copy clips' : 'Move clips');
    let moved = false, duplicated = false, lastDl = 0, changedTrack = false;
    const laneOk = (dl) => [...orig.values()].every((o) => compatible(o.clip, o.track, p.tracks[o.ti + dl]));
    beginDrag();
    startDrag(e, (dx, dy, ev) => {
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      let delta = snapB(a0 + dx / ppb, ev) - a0;
      if (minStart + delta < 0) delta = -minStart;
      let dl = Math.round(dy / laneH);
      if (dl !== 0 && !laneOk(dl)) dl = laneOk(lastDl) ? lastDl : 0;
      lastDl = dl;
      if (dl) changedTrack = true;
      tx((pp) => {
        if (dup && !duplicated) {
          duplicated = true;
          for (const id of orig.keys()) { const c = pp.clips.find((x) => x.id === id); if (c) pp.clips.push({ ...deepClone(c), id: uid('clip') }); }
        }
        const byId = new Map(pp.clips.map((c) => [c.id, c]));
        for (const [id, o] of orig) {
          const c = byId.get(id);
          if (!c) continue;
          c.start = +(o.start + delta).toFixed(6);
          c.trackId = pp.tracks[o.ti + dl].id;
        }
      });
      app.setStatus?.(`${dup ? 'Copy' : 'Move'}: bar ${(Math.floor((a0 + delta) / bpbNow()) + 1)} · beat ${+(mod(a0 + delta, bpbNow()) + 1).toFixed(2)}${dl ? ` · ${dl > 0 ? '+' : ''}${dl} track(s)` : ''}`);
    }, () => {
      endDrag();
      if (!moved) { if (!e.shiftKey) setSel([anchor.id]); return; }
      if (changedTrack) tx((pp) => fixOwnership(pp, new Set(orig.keys())));
    });
  }

  function startResize(e, anchor, side) {
    const p = get();
    const ids = new Set(selIds());
    const orig = new Map();
    for (const c of p.clips) if (ids.has(c.id)) orig.set(c.id, { start: c.start, length: c.length, offset: c.offset || 0, L: p.patterns[c.patternId]?.length || 0, type: c.type });
    const a = orig.get(anchor.id);
    if (!a) return;
    const tx = dragTx(side === 'right' ? 'Resize clips' : 'Trim clips');
    beginDrag();
    startDrag(e, (dx, _dy, ev) => {
      const ml = ev.ctrlKey || ev.metaKey ? 1 / 16 : minLen();
      if (side === 'right') {
        const end = snapB(a.start + a.length + dx / ppb, ev);
        const delta = end - (a.start + a.length);
        tx((pp) => { for (const c of pp.clips) { const o = orig.get(c.id); if (o) c.length = +Math.max(ml, o.length + delta).toFixed(6); } });
      } else {
        let delta = snapB(a.start + dx / ppb, ev) - a.start;
        let lo = -Infinity, hi = Infinity;
        for (const o of orig.values()) {
          lo = Math.max(lo, -o.start);
          hi = Math.min(hi, o.length - ml);
          if (o.type === 'audio') lo = Math.max(lo, -o.offset);
        }
        delta = clamp(delta, lo, Math.max(lo, hi));
        tx((pp) => {
          for (const c of pp.clips) {
            const o = orig.get(c.id);
            if (!o) continue;
            c.start = +(o.start + delta).toFixed(6);
            c.length = +(o.length - delta).toFixed(6);
            c.offset = o.type === 'pattern' ? +mod(o.offset + delta, o.L).toFixed(6) : +(o.offset + delta).toFixed(6);
          }
        });
      }
    }, endDrag);
  }

  function startRubber(e, hit) {
    const base = e.shiftKey ? new Set(selIds()) : new Set();
    const x0 = hit.x, y0 = hit.y;
    let moved = false;
    startDrag(e, (dx, dy, ev) => {
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      const h2 = hitTest(ev.clientX, ev.clientY);
      const l = Math.min(x0, h2.x), r = Math.max(x0, h2.x), t = Math.min(y0, h2.y), b = Math.max(y0, h2.y);
      rubber.classList.remove('hidden');
      Object.assign(rubber.style, { left: (l - scroller.scrollLeft) + 'px', top: (t - scroller.scrollTop) + 'px', width: (r - l) + 'px', height: (b - t) + 'px' });
      const p = get();
      const l0 = Math.floor(t / laneH), l1 = Math.floor(b / laneH);
      const tset = new Set(p.tracks.slice(Math.max(0, l0), l1 + 1).map((x) => x.id));
      const ba = l / ppb, bb = r / ppb;
      const found = p.clips.filter((c) => tset.has(c.trackId) && c.start < bb && c.start + c.length > ba).map((c) => c.id);
      setSel([...base, ...found]);
    }, () => { rubber.classList.add('hidden'); });
  }

  function startPencil(e, hit) {
    const t = hit.track;
    if (t.type === 'audio') { toast('Audio lanes take audio clips: drop a sample from the Browser or an audio file here (double-click to import).'); return; }
    if (t.type !== 'instrument') return;
    const pat = actions.ensurePattern(t.id);
    if (!pat) return;
    const start = Math.max(0, snapB(hit.beat, e, Math.floor));
    const clip = createClip(t.id, { patternId: pat.id, start, length: pat.length });
    const tx = dragTx('Draw clip');
    tx((p) => { p.clips.push(clip); });
    setSel([clip.id]);
    beginDrag();
    startDrag(e, (dx, _dy, ev) => {
      if (Math.abs(dx) < 4) return;
      const end = snapB(hit.beat + dx / ppb, ev, Math.ceil);
      const len = Math.max(minLen(), end - start);
      tx((p) => { const c = p.clips.find((x) => x.id === clip.id); if (c) c.length = len; });
    }, endDrag);
  }

  function startErase(e, hit) {
    const tx = dragTx('Erase clips');
    const erase = (c) => { if (!c) return; tx((p) => { p.clips = p.clips.filter((x) => x.id !== c.id); }); };
    erase(hit.clip);
    beginDrag();
    startDrag(e, (_dx, _dy, ev) => erase(hitTest(ev.clientX, ev.clientY).clip), endDrag);
  }

  scroller.addEventListener('dblclick', (e) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit.track) { menuAt(addRow, actions.addTrackMenuItems()); return; }
    if (hit.clip) { openClipEditor(hit.clip); return; }
    if (tool !== 'pointer') return;
    if (hit.track.type === 'instrument') createClipAt(hit.track, hit.beat);
    else if (hit.track.type === 'audio') importAudioAt(hit.track, snapB(hit.beat, null, Math.floor));
  });

  scroller.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = hitTest(e.clientX, e.clientY);
    if (hit.clip) {
      if (!selIds().includes(hit.clip.id)) setSel([hit.clip.id]);
      contextMenu(e, clipMenuItems(hit.clip));
    } else if (hit.track) contextMenu(e, laneMenuItems(hit));
    else contextMenu(e, [...actions.addTrackMenuItems(), ...(clipboard ? ['-', { label: 'Paste at playhead', onClick: () => pasteAt(snapB(pos(), null, Math.floor)) }] : [])]);
  });

  // hover feedback: cursors + scissors split line
  scroller.addEventListener('pointermove', (e) => {
    if (dragging || e.buttons) return;
    const hit = hitTest(e.clientX, e.clientY);
    let cur = '';
    if (tool === 'pointer') cur = hit.clip ? (hit.edge ? 'ew-resize' : 'grab') : hit.track?.type === 'code' ? 'pointer' : '';
    else if (tool === 'pencil') cur = hit.clip ? (hit.edge ? 'ew-resize' : 'grab') : hit.track?.type === 'instrument' ? 'copy' : '';
    else if (tool === 'eraser') cur = hit.clip ? 'not-allowed' : '';
    else if (tool === 'scissors') cur = hit.clip ? 'col-resize' : '';
    scroller.style.cursor = cur;
    if (tool === 'scissors' && hit.clip) {
      const b = snapB(hit.beat, e);
      const inside = b > hit.clip.start + EPS && b < hit.clip.start + hit.clip.length - EPS;
      hoverLine.classList.toggle('hidden', !inside);
      hoverLine.style.transform = `translate(${b * ppb - scroller.scrollLeft}px, ${hit.lane * laneH - scroller.scrollTop}px)`;
      hoverLine.style.height = laneH + 'px';
    } else hoverLine.classList.add('hidden');
  });
  scroller.addEventListener('pointerleave', () => hoverLine.classList.add('hidden'));

  // wheel: native vertical / shift-horizontal; Ctrl = zoom around cursor; Alt = track height
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - scroller.getBoundingClientRect().left);
    } else if (e.altKey) {
      e.preventDefault();
      setLaneH(laneH * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    }
  }, { passive: false });
  heads.addEventListener('wheel', (e) => {
    if (e.target.closest('.fader')) return;
    e.preventDefault();
    if (e.altKey) setLaneH(laneH * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    else scroller.scrollTop += e.deltaY;
  }, { passive: false });
  top.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - top.getBoundingClientRect().left);
    else scroller.scrollLeft += e.deltaY + e.deltaX;
  }, { passive: false });

  scroller.addEventListener('scroll', () => { syncScrollY(); drawNow(); });

  // ------------------------------------------------------------------ top bar interactions
  let dragMarkerId = null;
  const topBeat = (clientX) => Math.max(0, (clientX - top.getBoundingClientRect().left + scroller.scrollLeft) / ppb);
  const topRow = (clientY) => {
    const y = clientY - top.getBoundingClientRect().top;
    return y < RULER_H ? 'ruler' : y < RULER_H + MARK_H ? 'markers' : 'loop';
  };
  const markerAt = (clientX) => {
    const x = clientX - top.getBoundingClientRect().left;
    for (let i = markerHit.length - 1; i >= 0; i--) if (x >= markerHit[i].x0 - 3 && x <= markerHit[i].x1) return markerHit[i].m;
    return null;
  };

  topCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = topRow(e.clientY);
    const beat = topBeat(e.clientX);
    const p = get();
    if (row === 'ruler') {
      actions.setPosition(snapB(beat, e, Math.round));
      beginDrag();
      startDrag(e, (_dx, _dy, ev) => actions.setPosition(snapB(topBeat(ev.clientX), ev)), endDrag);
      return;
    }
    if (row === 'markers') {
      const m = markerAt(e.clientX);
      if (!m) return;
      const b0 = m.beat;
      const tx = dragTx('Move marker');
      dragMarkerId = m.id;
      beginDrag();
      let moved = false;
      startDrag(e, (dx, _dy, ev) => {
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const nb = Math.max(0, snapB(b0 + dx / ppb, ev));
        tx((pp) => { const mm = pp.markers.find((x) => x.id === m.id); if (mm) mm.beat = nb; pp.markers.sort((a, b) => a.beat - b.beat); });
      }, () => {
        endDrag();
        dragMarkerId = null;
        if (!moved) actions.setPosition(m.beat);
        drawNow();
      });
      return;
    }
    // loop lane
    const loop = p.loop || { start: 0, end: 16, enabled: false };
    const x = beat * ppb;
    const nearStart = Math.abs(x - loop.start * ppb) < 6, nearEnd = Math.abs(x - loop.end * ppb) < 6;
    const inside = beat > loop.start && beat < loop.end;
    const tx = dragTx('Loop region');
    let moved = false;
    const mode = nearEnd ? 'end' : nearStart ? 'start' : inside ? 'move' : 'new';
    const anchor = snapB(beat, e, Math.floor);
    beginDrag();
    startDrag(e, (dx, _dy, ev) => {
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const d = dx / ppb;
      let s = loop.start, en = loop.end;
      const ms = minLen();
      if (mode === 'end') en = Math.max(s + ms, snapB(loop.end + d, ev));
      else if (mode === 'start') s = clamp(snapB(loop.start + d, ev), 0, en - ms);
      else if (mode === 'move') { const sh = Math.max(-loop.start, snapB(loop.start + d, ev) - loop.start); s = loop.start + sh; en = loop.end + sh; }
      else { const b = snapB(topBeat(ev.clientX), ev, Math.round); s = Math.min(anchor, b); en = Math.max(anchor, b); if (en - s < ms) en = s + ms; }
      tx((pp) => { pp.loop = { ...pp.loop, start: +s.toFixed(6), end: +en.toFixed(6), enabled: mode === 'new' ? true : pp.loop.enabled }; });
    }, () => {
      endDrag();
      if (!moved && (inside || nearStart || nearEnd)) store.transact('Toggle loop', (pp) => { pp.loop.enabled = !pp.loop.enabled; });
    });
  });

  topCanvas.addEventListener('dblclick', (e) => {
    const row = topRow(e.clientY);
    if (row === 'loop') return;
    const m = row === 'markers' ? markerAt(e.clientX) : null;
    if (m) { renameMarker(m.id); return; }
    addMarkerAt(snapB(topBeat(e.clientX), e, Math.floor));
  });

  topCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = topRow(e.clientY);
    const beat = snapB(topBeat(e.clientX), null, Math.floor);
    const p = get();
    const m = row === 'markers' ? markerAt(e.clientX) : null;
    if (m) {
      contextMenu(e, [
        { header: m.name },
        { label: 'Rename…', icon: 'pencil', onClick: () => renameMarker(m.id) },
        { label: 'Go to marker', icon: 'play', onClick: () => actions.setPosition(m.beat) },
        { label: 'Loop this section', icon: 'loop', onClick: () => { const [a, b] = markerSection(m); setLoop(a, b); } },
        '-',
        { label: 'Delete marker', icon: 'trash', onClick: () => deleteMarker(m.id) },
      ]);
      return;
    }
    contextMenu(e, [
      { label: 'Add marker here', icon: 'plus', onClick: () => addMarkerAt(beat) },
      { label: 'Move playhead here', icon: 'play', onClick: () => actions.setPosition(beat) },
      '-',
      { label: p.loop?.enabled ? 'Disable loop' : 'Enable loop', icon: 'loop', onClick: () => store.transact('Toggle loop', (pp) => { pp.loop.enabled = !pp.loop.enabled; }) },
      { label: 'Loop the whole song', icon: 'loop', disabled: !p.clips.length, onClick: () => setLoop(0, songLengthBeats(p)) },
      { label: 'Loop 4 bars from here', icon: 'loop', onClick: () => setLoop(beat, beat + bpbNow() * 4) },
    ]);
  });

  topCanvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const row = topRow(e.clientY);
    let cur = 'pointer';
    if (row === 'markers') cur = markerAt(e.clientX) ? 'grab' : 'copy';
    else if (row === 'loop') {
      const loop = get().loop || {};
      const x = topBeat(e.clientX) * ppb;
      cur = Math.abs(x - loop.start * ppb) < 6 || Math.abs(x - loop.end * ppb) < 6 ? 'ew-resize' : 'pointer';
    }
    topCanvas.style.cursor = cur;
  });

  // ------------------------------------------------------------------ drag & drop (browser panel + OS files)
  const acceptsDrop = (dt) => { const ty = [...(dt?.types || [])]; return ty.includes(DT_SAMPLE) || ty.includes(DT_PRESET) || ty.includes('Files'); };
  body.addEventListener('dragover', (e) => {
    if (!acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const hit = hitTest(e.clientX, e.clientY);
    const b = Math.max(0, snapB(hit.beat, null, Math.floor));
    const lane = hit.track ? hit.lane : get().tracks.length;
    dropInd.classList.remove('hidden');
    Object.assign(dropInd.style, { transform: `translate(${b * ppb - scroller.scrollLeft}px, ${lane * laneH - scroller.scrollTop}px)`, height: laneH + 'px' });
    dropInd.dataset.label = hit.track ? `${hit.track.name} · bar ${Math.floor(b / bpbNow()) + 1}` : 'New track';
  });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) dropInd.classList.add('hidden'); });
  body.addEventListener('drop', async (e) => {
    if (!acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    dropInd.classList.add('hidden');
    const hit = hitTest(e.clientX, e.clientY);
    const beat = Math.max(0, snapB(hit.beat, null, Math.floor));
    const track = hit.track;
    const dt = e.dataTransfer;
    const sid = dt.getData(DT_SAMPLE);
    if (sid) { await actions.placeSample(sid, { trackId: track?.type === 'audio' ? track.id : undefined, start: beat }); return; }
    const pid = dt.getData(DT_PRESET);
    if (pid) { actions.addTrack(pid); return; }
    const files = [...(dt.files || [])];
    if (files.length) handleFiles(files, track, beat);
  });

  async function handleFiles(files, track, beat) {
    const isAudio = (f) => (f.type.startsWith('audio/') && !/midi/i.test(f.type)) || /\.(wav|mp3|ogg|oga|flac|aiff?|m4a|aac|webm|opus)$/i.test(f.name);
    const audio = files.filter(isAudio);
    const midi = files.filter((f) => /\.(mid|midi)$/i.test(f.name));
    const code = files.filter((f) => /\.(strudel|str|js|txt|tidal)$/i.test(f.name));
    const json = files.filter((f) => /\.json$/i.test(f.name));
    if (audio.length) {
      const added = await actions.importSamples(audio);
      if (added?.[0]) await actions.placeSample(added[0].id, { trackId: track?.type === 'audio' ? track.id : undefined, start: beat });
      if (added?.length > 1) toast(`${added.length - 1} more sample(s) are in the Browser — drag them where you need them.`);
    }
    for (const f of code) await actions.importStrudel(f);
    if (midi.length) toast('To import MIDI, use Menu ▸ Import ▸ MIDI file… (tracks, patterns and clips are created for you).', { timeout: 5000 });
    if (json.length) toast('To open a project file, use Menu ▸ Open project… (Ctrl+O).', { timeout: 5000 });
    if (!audio.length && !code.length && !midi.length && !json.length) toast('Unsupported file type. Drop audio, .strudel/.js code, MIDI or project files.', { level: 'warn' });
  }

  // ------------------------------------------------------------------ keyboard
  function onKey(e) {
    if (!visible || isTyping(e) || document.querySelector('.modal-backdrop')) return;
    const modk = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const n = selIds().length;
    let handled = true;
    if ((k === 'delete' || k === 'backspace') && !modk) { if (!n) return; deleteSelection(); }
    else if (modk && k === 'd') { if (!n) return; duplicateSelection(); }
    else if (modk && k === 'c') { if (!copySelection()) return; }
    else if (modk && k === 'x') { if (!copySelection()) return; deleteSelection(); }
    else if (modk && k === 'v') { if (!clipboard) return; pasteAt(snapB(pos(), null, Math.floor)); }
    else if (modk && k === 'a') setSel(get().clips.map((c) => c.id));
    else if (!modk && (k === 'arrowleft' || k === 'arrowright')) {
      if (!n) return;
      const step = e.shiftKey ? bpbNow() : (snapStep() || 0.25);
      nudge(k === 'arrowleft' ? -step : step, 0);
    } else if (!modk && (k === 'arrowup' || k === 'arrowdown')) {
      if (!n) return;
      nudge(0, k === 'arrowup' ? -1 : 1);
    } else if (k === 'escape' && !modk) { if (!n) return; setSel([]); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  window.addEventListener('keydown', onKey, true);

  // ------------------------------------------------------------------ sync
  function syncToolbar() {
    const p = get();
    loopBtn.setValue(!!p.loop?.enabled);
    followBtn.setValue(ui.get('followPlayhead') !== false);
    snapSel.setValue(snapMode);
    empty.classList.toggle('hidden', p.tracks.length > 0);
    // banner
    let text = '', btns = [];
    if (p.tracks.length && p.mode !== 'song') {
      text = 'Pattern mode — the timeline isn\'t playing (each track loops its active pattern). Switch to SONG (P) to hear the arrangement.';
      btns = [button('Switch to SONG', () => actions.setMode('song'), { cls: 'small', primary: true, title: 'Play the arrangement timeline (P)' })];
      if (!p.clips.length) btns.push(button('Pattern ▸ Song…', (e) => menuAt(e.currentTarget, patternToSongItems()), { cls: 'small', title: 'Build the arrangement from scenes or active patterns' }));
    } else if (p.tracks.length && !p.clips.length && p.tracks.some((t) => t.type !== 'code')) {
      text = 'The timeline is empty — double-click a lane to add a clip, draw with the pencil, or build it from your patterns.';
      btns = [button('Clips from active patterns', () => clipsFromActive(4), { cls: 'small', primary: true, title: 'Place every active pattern as a 4-bar clip' }), button('Fill from scenes', () => fillFromScenes(null), { cls: 'small', title: 'One section per scene' })];
    }
    banner.classList.toggle('hidden', !text);
    if (bannerText.textContent !== text) { bannerText.textContent = text; bannerBtns.replaceChildren(...btns); }
    // drop stale selection
    const ids = selIds();
    if (ids.length) {
      const all = new Set(p.clips.map((c) => c.id));
      const keep = ids.filter((id) => all.has(id));
      if (keep.length !== ids.length) setSel(keep);
    }
  }

  function fullSync() {
    readTheme();
    syncHeaders();
    syncToolbar();
    layout();
    drawNow();
  }

  app.subscribe((r) => {
    if (r.project) version++;
    if (!visible) { stale = true; return; }
    if ('theme' in r.ui) readTheme();
    if (r.project) { syncHeaders(); syncToolbar(); layout(); }
    else if ('selectedTrackId' in r.ui) syncHeaders();
    if ('followPlayhead' in r.ui) followBtn.setValue(ui.get('followPlayhead') !== false);
    if (r.project || 'selectedClipIds' in r.ui || 'selectedTrackId' in r.ui || 'theme' in r.ui) invalidate();
  });
  engine.on?.('samples', () => { for (const [id, e] of peaks) if (e.status === 'error') peaks.delete(id); invalidate(); });

  const ro = new ResizeObserver(() => { if (visible) { layout(); drawNow(); } });
  ro.observe(lanes);

  setTool('pointer');

  return {
    el,
    show() {
      visible = true;
      requestAnimationFrame(() => {
        if (!visible) return;
        fullSync();
        stale = false;
        if (!rafLoop) rafLoop = requestAnimationFrame(frame);
      });
    },
    hide() {
      visible = false;
      if (rafLoop) { cancelAnimationFrame(rafLoop); rafLoop = 0; }
    },
    // exposed for automation / other views
    zoomToFit, scenesToArrangement: (o) => scenesToArrangement(app, o), getState: () => ({ ppb, laneH, headW, tool, snapMode, stale }),
  };
}
