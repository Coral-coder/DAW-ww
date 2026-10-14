// Piano roll: canvas note editor with scale guides, chord tools, transforms,
// velocity lane, ghost notes and drum-pad mode. See docs/UI.md for the view contract.
import { h, icon, startDrag, fitCanvas, cssVar } from '../dom.js';
import { select, numberField, iconButton, button, contextMenu, promptText } from '../components.js';
import { DRUM_PADS, beatsPerBar, patternsForTrack } from '../../core/model.js';
import { uid, clamp, createRng } from '../../core/util.js';
import * as T from '../../theory/index.js';
import { isTyping } from '../keyboard.js';

// Generators are optional for this view (arpeggiate); load lazily so a missing module can't break it.
let gen = null;
import('../../gen/index.js').then((m) => { gen = m; }).catch(() => {});

const SNAPS = [
  { v: 4, label: '1/1' }, { v: 2, label: '1/2' }, { v: 1, label: '1/4' }, { v: 0.5, label: '1/8' },
  { v: 1 / 3, label: '1/8T' }, { v: 0.25, label: '1/16' }, { v: 1 / 6, label: '1/16T' }, { v: 0.125, label: '1/32' }, { v: 0, label: 'Off' },
];
const LENGTHS = [
  { v: 'last', label: 'Last used' }, { v: 'snap', label: '= Snap' }, { v: 0.125, label: '1/32' }, { v: 0.25, label: '1/16' },
  { v: 0.5, label: '1/8' }, { v: 1, label: '1/4' }, { v: 2, label: '1/2' }, { v: 4, label: '1 bar' },
];
const TOOLS = [
  { id: 'pointer', icon: 'pointer', label: 'Select', tip: 'Select tool (drag empty space to rubber-band select, double-click to add)' },
  { id: 'pencil', icon: 'pencil', label: 'Draw', tip: 'Draw tool: click to add a note, drag right to lengthen. Drag notes to move, edges to resize' },
  { id: 'eraser', icon: 'eraser', label: 'Erase', tip: 'Erase tool: click or drag across notes to delete them (also: right-drag in any tool)' },
  { id: 'slice', icon: 'scissors', label: 'Slice', tip: 'Slice tool: click a note to cut it at the grid position' },
  { id: 'velocity', icon: 'sliders', label: 'Velocity', tip: 'Velocity tool: drag a note up/down to change its velocity (selected notes together)' },
  { id: 'chord', icon: 'music', label: 'Chord', tip: 'Chord stamp: click to place a whole chord rooted on that key' },
];
const KEY_W = 66;
const DRUM_KEY_W = 112;
const MIN_PPB = 8, MAX_PPB = 640;
const EPS = 1e-6;
const SETTINGS_KEY = 'daw3-piano';

// shared clipboard (survives pattern switches)
let clipboard = null; // { notes: [{pitch, start(rel), dur, vel}], span, origin }

function loadSettings() {
  const d = {
    tool: 'pencil', snap: 0.25, len: 'last', scaleHL: true, fold: false, snapScale: false, ghosts: true,
    chordType: 'diatonic', voicing: 'close', chordLen: 'bar', ppb: 0, rowH: 14, velH: 72, audition: true,
  };
  try { Object.assign(d, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* ignore */ }
  return d;
}

const fmtBeat = (b, bpb) => {
  const bar = Math.floor(b / bpb) + 1;
  const beat = Math.floor(b % bpb) + 1;
  const tick = Math.floor(((b % 1) + EPS) * 4) + 1;
  return `${bar}.${beat}.${tick}`;
};
const roundT = (x) => Math.round(x * 100000) / 100000;
const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

export function createPianoView(app) {
  const { store, ui, actions, engine } = app;
  const S = loadSettings();
  const save = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* ignore */ } };

  // ---------------------------------------------------------------- state
  let visible = false;
  let cur = { p: null, track: null, pat: null };
  let rows = []; // [{pitch, name?}] top -> bottom
  let rowOf = new Map();
  let isDrum = false;
  let selected = new Set();
  let lastLen = 0.25;
  let hover = null; // {pitch, beat, note}
  let band = null; // rubber band rect in content coords
  let scrolledFor = null;
  let lastPatId = null;
  let chordCursor = null;
  const lit = new Map(); // pitch -> count (auditions / live input)
  let playLit = new Set(); // pitches sounding at playhead
  let colors = {};
  let raf = 0;
  let suggestions = [];

  // ---------------------------------------------------------------- DOM
  const toolbar = h('div.view-toolbar.piano-toolbar');
  const keysCv = h('canvas.piano-keys', { 'aria-label': 'Piano keyboard', title: 'Click / drag to audition. Shift+click selects every note on that key' });
  const rulerCv = h('canvas.piano-ruler', { 'aria-label': 'Timeline ruler', title: 'Click to move the playhead. Drag the ▼ end marker to change the pattern length' });
  const gridCv = h('canvas.piano-grid-canvas');
  const spacer = h('div.piano-spacer');
  const scroller = h('div.piano-scroller', { tabIndex: 0, role: 'application', 'aria-label': 'Note grid. Click to add notes, drag to move, Delete removes, arrows nudge, Ctrl+A/C/V/D' }, spacer);
  const playhead = h('div.piano-playhead');
  const rulerHead = h('div.piano-playhead.ruler');
  const gridWrap = h('div.piano-gridwrap', gridCv, playhead, scroller);
  const rulerWrap = h('div.piano-rulerwrap', rulerCv, rulerHead);
  const velCv = h('canvas.piano-vel-canvas', { 'aria-label': 'Velocity lane', title: 'Velocity: drag to set, sweep across to paint. Only selected notes are affected when there is a selection' });
  const velResizer = h('div.piano-vel-resizer', { title: 'Drag to resize the velocity lane' });
  const velLabel = h('div.piano-vel-label', h('span', 'Velocity'));
  const corner = h('div.piano-corner');
  const statusL = h('span.piano-status-main');
  const statusChord = h('span.piano-status-chord');
  const chips = h('span.piano-chips');
  const status = h('div.piano-status', statusL, statusChord, h('div.spacer'), chips);
  const body = h('div.piano-body', corner, rulerWrap, keysCv, gridWrap, velResizer, velLabel, velCv, status);
  const empty = h('div.piano-empty.hidden');
  const el = h('div.piano-view', toolbar, body, empty);

  const applyLayout = () => {
    body.style.setProperty('--piano-keys-w', (isDrum ? DRUM_KEY_W : KEY_W) + 'px');
    body.style.setProperty('--piano-vel-h', S.velH + 'px');
  };

  // ---------------------------------------------------------------- helpers
  const proj = () => store.get();
  const bpb = () => beatsPerBar(proj());
  const rowH = () => (isDrum ? Math.max(S.rowH, 20) : S.rowH);
  const ppb = () => S.ppb || 80;
  const gridStep = () => S.snap || 0.25;
  const snapRound = (b) => (S.snap ? Math.round(b / S.snap + EPS) * S.snap : b);
  const snapFloor = (b) => (S.snap ? Math.floor(b / S.snap + EPS) * S.snap : b);
  const minDur = () => Math.min(S.snap || 1 / 32, 1 / 32) || 1 / 32;
  const keyInfo = () => proj().key || { root: 0, scale: 'major' };
  const inKey = (m) => { const k = keyInfo(); try { return T.inScale(m, k.root, k.scale); } catch { return true; } };
  const isRoot = (m) => ((m % 12) + 12) % 12 === keyInfo().root;
  const scaleName = () => {
    const k = keyInfo();
    try { if (T.keyName) return T.keyName(k.root, k.scale); } catch { /* fall through */ }
    return `${T.pitchClassName(k.root, 'common')} ${T.SCALES[k.scale]?.name || k.scale}`;
  };
  const flats = () => { const k = keyInfo(); try { return !!T.keyPrefersFlats?.(k.root, k.scale); } catch { return false; } };
  const nn = (m) => T.noteName(m, flats());
  const pitchLabel = (m) => {
    if (isDrum) { const pad = DRUM_PADS.find((d) => d.pitch === m); if (pad) return pad.name; }
    return nn(m);
  };
  function noteLen() {
    if (S.len === 'last') return lastLen || gridStep();
    if (S.len === 'snap') return gridStep();
    return Number(S.len) || 0.25;
  }
  function chordLenBeats() {
    if (S.chordLen === 'bar') return bpb();
    if (S.chordLen === 'note') return noteLen();
    return Number(S.chordLen) || bpb();
  }

  function resolveContext() {
    const p = proj();
    let pat = p.patterns[ui.get('selectedPatternId')] || null;
    let track = pat ? p.tracks.find((t) => t.id === pat.trackId) : null;
    if (!track || track.type !== 'instrument') {
      track = p.tracks.find((t) => t.id === ui.get('selectedTrackId')) || null;
      if (track && track.type !== 'instrument') track = null;
      pat = track ? p.patterns[track.activePatternId] || patternsForTrack(p, track.id)[0] || null : null;
    }
    return { p, track, pat };
  }

  function buildRows() {
    const { track, pat } = cur;
    isDrum = track?.instrument?.type === 'drums';
    const used = new Set((pat?.notes || []).map((n) => n.pitch));
    if (isDrum) {
      let pads = DRUM_PADS.map((d) => ({ pitch: d.pitch, name: d.name }));
      for (const m of [...used].sort((a, b) => a - b)) if (!DRUM_PADS.some((d) => d.pitch === m)) pads.push({ pitch: m, name: T.noteName(m) });
      if (S.fold) { const f = pads.filter((r) => used.has(r.pitch)); if (f.length) pads = f; }
      rows = pads;
    } else {
      rows = [];
      for (let m = 127; m >= 0; m--) {
        if (S.fold && !inKey(m) && !used.has(m)) continue;
        rows.push({ pitch: m });
      }
    }
    rowOf = new Map(rows.map((r, i) => [r.pitch, i]));
    applyLayout();
  }

  function readColors() {
    const c = (n, f) => cssVar(n) || f;
    colors = {
      bg: c('--bg', '#0f1116'), bg2: c('--bg-2', '#151821'), bg3: c('--bg-3', '#1b1f2a'), bg4: c('--bg-4', '#232836'),
      line: c('--line', '#2a3040'), text: c('--text', '#e6e9f2'), text2: c('--text-2', '#a7aec2'), text3: c('--text-3', '#6d7590'),
      accent: c('--accent', '#7c5cff'), accent2: c('--accent-2', '#00d4ff'), accent3: c('--accent-3', '#ff4fa3'),
      gridBar: c('--grid-bar', 'rgba(255,255,255,.16)'), gridBeat: c('--grid-beat', 'rgba(255,255,255,.08)'), gridStep: c('--grid-step', 'rgba(255,255,255,.035)'),
      white: c('--white-key', '#e9ecf5'), black: c('--black-key', '#1b1e27'), font: c('--font', 'system-ui'),
      light: document.documentElement.dataset.theme === 'light',
    };
  }

  function contentBeats() {
    const pat = cur.pat;
    if (!pat) return 16;
    const end = pat.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
    const b = bpb();
    const beats = Math.max(pat.length, end) + b * 2;
    const minBeats = (scroller.clientWidth || 800) / ppb();
    return Math.max(beats, minBeats);
  }

  function updateSpacer() {
    spacer.style.width = Math.ceil(contentBeats() * ppb()) + 'px';
    spacer.style.height = Math.ceil(rows.length * rowH()) + 'px';
  }

  // coordinates (relative to scroller viewport) -> content point
  function point(clientX, clientY) {
    const r = scroller.getBoundingClientRect();
    const x = clientX - r.left + scroller.scrollLeft;
    const y = clientY - r.top + scroller.scrollTop;
    const row = clamp(Math.floor(y / rowH()), 0, rows.length - 1);
    return { x, y, beat: Math.max(0, x / ppb()), row, pitch: rows[row]?.pitch };
  }

  function hitTest(pt) {
    const pat = cur.pat;
    if (!pat || pt.pitch == null) return null;
    const P = ppb();
    let best = null;
    for (const n of pat.notes) {
      if (n.pitch !== pt.pitch) continue;
      const x0 = n.start * P, x1 = x0 + Math.max(4, n.dur * P);
      if (pt.x >= x0 - 1 && pt.x <= x1 + 1) best = n;
    }
    if (!best) return null;
    const x0 = best.start * P, w = Math.max(4, best.dur * P), x1 = x0 + w;
    let edge = null;
    if (w >= 10 && pt.x >= x1 - Math.min(7, w * 0.3)) edge = 'end';
    else if (w >= 18 && pt.x <= x0 + 4) edge = 'start';
    return { note: best, edge };
  }

  // ---------------------------------------------------------------- editing
  /** Transact on the current pattern. drag = {recorded} token → one undo step per gesture. */
  function edit(label, fn, drag) {
    const pid = cur.pat?.id;
    if (!pid) return;
    let opts = {};
    if (drag) { if (drag.recorded) opts = { undo: false }; drag.recorded = true; }
    store.transact(label, (p) => { const pat = p.patterns[pid]; if (pat) fn(pat, p); }, opts);
  }
  const targets = (pat) => {
    const sel = pat.notes.filter((n) => selected.has(n.id));
    return sel.length ? sel : pat.notes;
  };
  const tidy = (n) => { n.start = roundT(Math.max(0, n.start)); n.dur = roundT(Math.max(1 / 64, n.dur)); n.vel = roundT(clamp(n.vel ?? 0.8, 0.01, 1)); n.pitch = clamp(Math.round(n.pitch), 0, 127); return n; };
  const mkNote = (pitch, start, dur, vel = 0.8) => tidy({ id: uid('n'), pitch, start, dur, vel });
  function ensureLength(pat, end) {
    if (end > pat.length + EPS) { const b = bpb(); pat.length = Math.ceil((end - EPS) / b) * b; }
  }

  // ---------------------------------------------------------------- audio
  function light(pitch, on) {
    const c = (lit.get(pitch) || 0) + (on ? 1 : -1);
    if (c <= 0) lit.delete(pitch); else lit.set(pitch, c);
    if (visible) drawKeys();
  }
  const prevEmit = app.emitLiveNote;
  app.emitLiveNote = (pitch, on) => { try { prevEmit?.(pitch, on); } catch { /* ignore */ } light(pitch, on); };

  async function audition(pitches, vel = 0.8, ms = 240) {
    if (!S.audition || !cur.track) return;
    const tid = cur.track.id;
    const list = Array.isArray(pitches) ? pitches : [pitches];
    try { await actions.ensureAudio(); } catch { return; }
    for (const m of list) { try { engine.noteOn(tid, m, vel); } catch { /* ignore */ } light(m, true); }
    setTimeout(() => { for (const m of list) { try { engine.noteOff(tid, m); } catch { /* ignore */ } light(m, false); } }, ms);
  }

  // ---------------------------------------------------------------- drawing
  function drawAll() {
    if (!visible || !cur.pat) return;
    updateSpacer();
    drawGrid();
    drawKeys();
    drawRuler();
    drawVel();
    updatePlayhead(true);
    updateStatus();
  }

  function visibleRows(hgt) {
    const rh = rowH();
    const sy = scroller.scrollTop;
    return [Math.max(0, Math.floor(sy / rh)), Math.min(rows.length - 1, Math.ceil((sy + hgt) / rh))];
  }

  function drawGrid() {
    const { ctx, w, h: H } = fitCanvas(gridCv);
    const pat = cur.pat;
    const P = ppb(), rh = rowH(), sx = scroller.scrollLeft, sy = scroller.scrollTop;
    const B = bpb();
    ctx.fillStyle = colors.bg2;
    ctx.fillRect(0, 0, w, H);
    const [r0, r1] = visibleRows(H);
    // row backgrounds
    for (let r = r0; r <= r1; r++) {
      const y = r * rh - sy;
      const m = rows[r].pitch;
      if (isDrum) {
        ctx.fillStyle = r % 2 ? colors.bg2 : colors.bg3;
      } else if (isBlack(m) && !S.fold) {
        ctx.fillStyle = colors.light ? colors.bg3 : colors.bg;
      } else {
        ctx.fillStyle = colors.bg2;
      }
      ctx.fillRect(0, y, w, rh);
      if (!isDrum && S.scaleHL) {
        if (isRoot(m)) { ctx.fillStyle = hexA(colors.accent, 0.13); ctx.fillRect(0, y, w, rh); }
        else if (!inKey(m)) { ctx.fillStyle = colors.light ? 'rgba(0,0,0,0.07)' : 'rgba(0,0,0,0.28)'; ctx.fillRect(0, y, w, rh); }
      }
      if (hover && hover.pitch === m) { ctx.fillStyle = hexA(colors.accent2, 0.06); ctx.fillRect(0, y, w, rh); }
      // row separators
      const pc = ((m % 12) + 12) % 12;
      ctx.fillStyle = !isDrum && (pc === 0 || pc === 5) ? colors.gridBeat : colors.gridStep;
      ctx.fillRect(0, y + rh - 1, w, 1);
    }
    // vertical grid
    const b0 = sx / P, b1 = (sx + w) / P;
    const sub = S.snap && S.snap * P >= 6 ? S.snap : (P / 4 >= 6 ? 0.25 : (P >= 8 ? 1 : B));
    const first = Math.floor(b0 / sub) * sub;
    for (let b = first; b <= b1 + sub; b += sub) {
      const x = Math.round(b * P - sx) + 0.5;
      const isBar = Math.abs(b / B - Math.round(b / B)) < EPS;
      const isBeat = Math.abs(b - Math.round(b)) < EPS;
      ctx.fillStyle = isBar ? colors.gridBar : isBeat ? colors.gridBeat : colors.gridStep;
      ctx.fillRect(x - 0.5, 0, 1, H);
    }
    // beyond pattern end
    const endX = pat.length * P - sx;
    if (endX < w) {
      ctx.fillStyle = colors.light ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.35)';
      ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), H);
    }
    // loop repeats preview of the pattern beyond the end
    // ghost notes from other tracks
    if (S.ghosts && !isDrum) drawGhosts(ctx, w, H);
    // notes
    const color = cur.track?.color || colors.accent;
    ctx.font = `10px ${colors.font}`;
    ctx.textBaseline = 'middle';
    const sel = [];
    for (const n of pat.notes) {
      const r = rowOf.get(n.pitch);
      if (r == null) continue;
      const x = n.start * P - sx, y = r * rh - sy;
      const nw = Math.max(3, n.dur * P - 1);
      if (x > w || x + nw < 0 || y > H || y + rh < 0) continue;
      if (selected.has(n.id)) { sel.push(n); continue; }
      drawNote(ctx, n, x, y, nw, rh, color, false, n.start >= pat.length - EPS);
    }
    for (const n of sel) {
      const r = rowOf.get(n.pitch);
      drawNote(ctx, n, n.start * P - sx, r * rh - sy, Math.max(3, n.dur * P - 1), rh, color, true, n.start >= pat.length - EPS);
    }
    // pattern end marker
    if (endX >= 0 && endX <= w) {
      ctx.fillStyle = colors.accent3;
      ctx.fillRect(Math.round(endX) - 1, 0, 2, H);
    }
    // rubber band
    if (band) {
      const x = Math.min(band.x0, band.x1) - sx, y = Math.min(band.y0, band.y1) - sy;
      const bw = Math.abs(band.x1 - band.x0), bh = Math.abs(band.y1 - band.y0);
      ctx.fillStyle = hexA(colors.accent2, 0.1);
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = colors.accent2;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(bw), Math.round(bh));
    }
  }

  function drawNote(ctx, n, x, y, nw, rh, color, isSel, outside) {
    const v = clamp(n.vel ?? 0.8, 0, 1);
    ctx.globalAlpha = outside ? 0.35 : 1;
    // body: velocity → brightness / saturation of the track colour
    ctx.fillStyle = mix(colors.light ? '#ffffff' : '#10121a', color, 0.35 + 0.65 * v);
    roundRect(ctx, x + 0.5, y + 1, nw, rh - 2, Math.min(3, rh / 4));
    ctx.fill();
    if (isSel) {
      ctx.strokeStyle = colors.light ? '#000' : '#fff';
      ctx.lineWidth = 2;
      roundRect(ctx, x + 1, y + 1.5, nw - 1, rh - 3, Math.min(3, rh / 4));
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 1, nw, rh - 2, Math.min(3, rh / 4));
      ctx.stroke();
    }
    if (rh >= 12 && nw > 26) {
      ctx.fillStyle = v > 0.55 ? 'rgba(0,0,0,0.75)' : (colors.light ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)');
      ctx.fillText(pitchLabel(n.pitch), x + 4, y + rh / 2, nw - 6);
    }
    ctx.globalAlpha = 1;
  }

  function drawGhosts(ctx, w, H) {
    const p = proj();
    const P = ppb(), rh = rowH(), sx = scroller.scrollLeft, sy = scroller.scrollTop;
    const endBeat = (sx + w) / P;
    for (const t of p.tracks) {
      if (t.id === cur.track.id || t.type !== 'instrument' || t.instrument?.type === 'drums') continue;
      const gp = p.patterns[t.activePatternId];
      if (!gp || !gp.notes.length || gp.length <= 0) continue;
      ctx.fillStyle = hexA(t.color || '#888888', colors.light ? 0.28 : 0.22);
      for (let off = 0; off < Math.min(endBeat, cur.pat.length); off += gp.length) {
        for (const n of gp.notes) {
          const r = rowOf.get(n.pitch);
          if (r == null) continue;
          const x = (n.start + off) * P - sx, y = r * rh - sy;
          if (n.start + off >= cur.pat.length) continue;
          const nw = Math.max(2, n.dur * P - 1);
          if (x > w || x + nw < 0 || y > H || y + rh < 0) continue;
          ctx.fillRect(x, y + 2, nw, rh - 4);
        }
      }
    }
  }

  function drawKeys() {
    const { ctx, w, h: H } = fitCanvas(keysCv);
    const rh = rowH(), sy = scroller.scrollTop;
    ctx.fillStyle = colors.bg2;
    ctx.fillRect(0, 0, w, H);
    const [r0, r1] = visibleRows(H);
    ctx.font = `${Math.min(11, rh - 3)}px ${colors.font}`;
    ctx.textBaseline = 'middle';
    for (let r = r0; r <= r1; r++) {
      const m = rows[r].pitch;
      const y = r * rh - sy;
      const on = lit.has(m) || playLit.has(m);
      if (isDrum) {
        ctx.fillStyle = on ? colors.accent2 : (r % 2 ? colors.bg3 : colors.bg4);
        ctx.fillRect(0, y, w, rh - 1);
        if (hover?.pitch === m && !on) { ctx.fillStyle = hexA(colors.accent2, 0.15); ctx.fillRect(0, y, w, rh - 1); }
        ctx.fillStyle = on ? '#000' : colors.text;
        ctx.textAlign = 'left';
        ctx.fillText(rows[r].name || pitchLabel(m), 8, y + rh / 2, w - 14);
        ctx.fillStyle = cur.track?.color || colors.accent;
        ctx.fillRect(0, y, 3, rh - 1);
        continue;
      }
      if (S.fold) {
        // folded rows aren't contiguous semitones: draw a labelled list instead of a keyboard
        const inK = inKey(m);
        ctx.fillStyle = on ? colors.accent2 : inK ? colors.white : colors.black;
        ctx.fillRect(0, y, w, rh - 1);
        if (hover?.pitch === m && !on) { ctx.fillStyle = hexA(colors.accent, 0.22); ctx.fillRect(0, y, w, rh); }
        if (isRoot(m)) { ctx.fillStyle = colors.accent; ctx.fillRect(w - 6, y + 1, 6, rh - 2); }
        if (rh >= 9) {
          ctx.fillStyle = on || inK ? '#20232c' : '#c9cedd';
          ctx.textAlign = 'right';
          ctx.font = `${isRoot(m) ? '600 ' : ''}${Math.min(11, rh - 3)}px ${colors.font}`;
          ctx.fillText(nn(m), w - 9, y + rh / 2 + 0.5);
          ctx.font = `${Math.min(11, rh - 3)}px ${colors.font}`;
        }
        continue;
      }
      const black = isBlack(m);
      // white base
      ctx.fillStyle = on && !black ? colors.accent2 : colors.white;
      ctx.fillRect(0, y, w, rh);
      if (black) {
        ctx.fillStyle = on ? colors.accent2 : colors.black;
        ctx.fillRect(0, y + 0.5, w * 0.62, rh - 1);
      }
      if (hover?.pitch === m && !on) { ctx.fillStyle = hexA(colors.accent, 0.22); ctx.fillRect(0, y, w, rh); }
      // separators between white keys (B|C and E|F)
      const pc = ((m % 12) + 12) % 12;
      if (pc === 0 || pc === 5) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, y + rh - 1, w, 1); }
      else if (!black && !isBlack(m - 1)) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, y + rh - 1, w, 1); }
      // scale guide strip
      if (S.scaleHL) {
        if (isRoot(m)) { ctx.fillStyle = colors.accent; ctx.fillRect(w - 6, y + 1, 6, rh - 2); }
        else if (inKey(m)) { ctx.fillStyle = hexA(colors.accent, 0.45); ctx.fillRect(w - 4, y + 2, 4, rh - 4); }
      }
      if (pc === 0 || (rh >= 14 && S.scaleHL && isRoot(m))) {
        ctx.fillStyle = '#20232c';
        ctx.textAlign = 'right';
        ctx.fillText(nn(m), w - 9, y + rh / 2 + 0.5);
      }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = colors.line;
    ctx.fillRect(w - 1, 0, 1, H);
  }

  function drawRuler() {
    const { ctx, w, h: H } = fitCanvas(rulerCv);
    const P = ppb(), sx = scroller.scrollLeft, B = bpb();
    ctx.fillStyle = colors.bg3;
    ctx.fillRect(0, 0, w, H);
    const pat = cur.pat;
    // pattern region
    const endX = pat.length * P - sx;
    ctx.fillStyle = hexA(cur.track?.color || colors.accent, 0.18);
    ctx.fillRect(-sx, H - 5, pat.length * P, 5);
    ctx.font = `10px ${colors.font}`;
    ctx.textBaseline = 'top';
    const b0 = Math.floor(sx / P), b1 = Math.ceil((sx + w) / P);
    const showBeats = P >= 22;
    const barStep = P * B < 30 ? Math.ceil(30 / (P * B)) : 1;
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(b * P - sx) + 0.5;
      const isBar = b % B === 0;
      if (isBar) {
        const bar = b / B;
        ctx.fillStyle = colors.text3;
        ctx.fillRect(x - 0.5, 0, 1, H);
        if (bar % barStep === 0) { ctx.fillStyle = colors.text2; ctx.fillText(String(bar + 1), x + 3, 3); }
      } else if (showBeats) {
        ctx.fillStyle = colors.gridBar;
        ctx.fillRect(x - 0.5, H - 7, 1, 7);
        if (P >= 60) { ctx.fillStyle = colors.text3; ctx.fillText(`${Math.floor(b / B) + 1}.${(b % B) + 1}`, x + 2, 7); }
      }
    }
    // end marker handle
    ctx.fillStyle = colors.accent3;
    ctx.beginPath();
    ctx.moveTo(endX - 6, 0); ctx.lineTo(endX + 6, 0); ctx.lineTo(endX, 9); ctx.closePath();
    ctx.fill();
    ctx.fillRect(endX - 1, 0, 2, H);
    ctx.fillStyle = colors.line;
    ctx.fillRect(0, H - 1, w, 1);
  }

  function drawVel() {
    const { ctx, w, h: H } = fitCanvas(velCv);
    const P = ppb(), sx = scroller.scrollLeft;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, H);
    // guides at 25/50/75/100%
    ctx.fillStyle = colors.gridStep;
    for (const f of [0.25, 0.5, 0.75]) ctx.fillRect(0, Math.round(4 + (H - 8) * (1 - f)), w, 1);
    const B = bpb();
    for (let b = Math.floor(sx / P / B) * B; b * P - sx < w; b += B) {
      ctx.fillStyle = colors.gridBeat;
      ctx.fillRect(Math.round(b * P - sx), 0, 1, H);
    }
    const color = cur.track?.color || colors.accent;
    const pat = cur.pat;
    const notes = pat.notes.slice().sort((a, b) => (selected.has(a.id) ? 1 : 0) - (selected.has(b.id) ? 1 : 0));
    for (const n of notes) {
      const x = Math.round(n.start * P - sx);
      if (x < -10 || x > w + 10) continue;
      const v = clamp(n.vel ?? 0.8, 0, 1);
      const y = 4 + (H - 8) * (1 - v);
      const isSel = selected.has(n.id);
      ctx.fillStyle = isSel ? (colors.light ? '#000' : '#fff') : mix('#10121a', color, 0.45 + 0.55 * v);
      ctx.fillRect(x, y, 2, H - y);
      ctx.beginPath();
      ctx.arc(x + 1, y, isSel ? 3.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (endXVisible(pat.length * P - sx, w)) { ctx.fillStyle = colors.accent3; ctx.fillRect(Math.round(pat.length * P - sx) - 1, 0, 2, H); }
  }
  const endXVisible = (x, w) => x >= 0 && x <= w;

  // ---------------------------------------------------------------- playhead
  function localPos() {
    const pat = cur.pat;
    if (!pat || pat.length <= 0) return null;
    let pos;
    try { pos = engine.getPosition?.(); } catch { return null; }
    if (pos == null || !Number.isFinite(pos)) return null;
    const p = proj();
    if (p.mode === 'song') {
      const c = p.clips.find((cl) => cl.patternId === pat.id && pos >= cl.start && pos < cl.start + cl.length);
      if (!c) return null;
      return (((pos - c.start + (c.offset || 0)) % pat.length) + pat.length) % pat.length;
    }
    return ((pos % pat.length) + pat.length) % pat.length;
  }

  function updatePlayhead(force = false) {
    const lp = localPos();
    if (lp == null) { playhead.style.display = 'none'; rulerHead.style.display = 'none'; if (playLit.size) { playLit = new Set(); drawKeys(); } return; }
    const x = lp * ppb() - scroller.scrollLeft;
    const vis = x >= 0 && x <= gridWrap.clientWidth;
    playhead.style.display = vis ? '' : 'none';
    rulerHead.style.display = vis ? '' : 'none';
    playhead.style.transform = `translateX(${x}px)`;
    rulerHead.style.transform = `translateX(${x}px)`;
    const playing = !!engine.isPlaying;
    // light keys under the playhead
    const now = new Set();
    if (playing) for (const n of cur.pat.notes) if (lp >= n.start && lp < n.start + n.dur) now.add(n.pitch);
    if (force || now.size !== playLit.size || [...now].some((m) => !playLit.has(m))) {
      playLit = now;
      drawKeys();
      if (!hover) updateStatus();
    }
    // follow
    if (playing && ui.get('followPlayhead') && !dragging) {
      const w = scroller.clientWidth;
      if (x > w - 20 || x < 0) scroller.scrollLeft = Math.max(0, lp * ppb() - 40);
    }
  }

  function loop() {
    raf = 0;
    if (!visible) return;
    if (cur.pat) updatePlayhead();
    raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- status / chords
  function chordAt() {
    const pat = cur.pat;
    let notes;
    let where;
    if (selected.size) { notes = pat.notes.filter((n) => selected.has(n.id)); where = 'selection'; }
    else {
      const lp = engine.isPlaying ? localPos() : (hover?.beat ?? localPos());
      if (lp == null) return null;
      notes = pat.notes.filter((n) => lp >= n.start - EPS && lp < n.start + n.dur);
      where = engine.isPlaying ? 'playhead' : (hover ? 'cursor' : 'playhead');
    }
    if (notes.length < 2) return null;
    try { const c = T.detectChord(notes.map((n) => n.pitch)); return c ? { chord: c, where } : null; } catch { return null; }
  }

  function detectedProgression() {
    const pat = cur.pat;
    if (!pat || isDrum) return [];
    const groups = new Map();
    for (const n of pat.notes) {
      const k = Math.round(n.start * 64) / 64;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const out = [];
    for (const k of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(k);
      if (new Set(g.map((n) => n.pitch % 12)).size < 2) continue;
      const c = T.detectChord(g.map((n) => n.pitch));
      if (!c) continue;
      const key = keyInfo();
      const roman = T.chordToRoman ? T.chordToRoman(c, key.root) : c.name;
      if (out.length && out[out.length - 1].roman === roman) continue;
      out.push({ roman, chord: c, start: k, end: Math.max(...g.map((n) => n.start + n.dur)) });
    }
    return out;
  }

  function updateSuggestions() {
    chips.replaceChildren();
    suggestions = [];
    if (!cur.pat || isDrum || typeof T.suggestNextChords !== 'function') return;
    let prog = [];
    try { prog = detectedProgression(); } catch { prog = []; }
    if (!prog.length) return;
    const k = keyInfo();
    try { suggestions = T.suggestNextChords(prog.map((x) => x.roman), k.root, k.scale, proj().genre || null, { limit: 4 }) || []; } catch { suggestions = []; }
    if (!suggestions.length) return;
    chips.append(h('span.piano-chips-label', { title: `Detected: ${prog.map((x) => x.chord.name).join(' → ')}` }, 'Next chord:'));
    const after = prog[prog.length - 1].end;
    for (const s of suggestions) {
      const ch = s.chord || T.romanToChord(s.roman, k.root, k.scale);
      if (!ch) continue;
      const b = h('button.piano-chip', { type: 'button', title: `${s.reason || ''}\nClick to insert ${ch.name || ''} after the last chord` }, h('b', s.roman), ' ', T.chordName ? T.chordName(ch) : (ch.name || ''));
      b.addEventListener('click', () => insertChord(ch.root, ch.type, { at: after }));
      chips.append(b);
    }
  }

  function updateStatus() {
    if (!cur.pat) return;
    const B = bpb();
    const parts = [];
    if (hover) {
      parts.push(`${pitchLabel(hover.pitch)}${isDrum ? '' : ` (${hover.pitch})`}`);
      parts.push(`@ ${fmtBeat(hover.beat, B)}`);
      if (hover.note) parts.push(`vel ${Math.round((hover.note.vel ?? 0.8) * 127)}`);
    }
    if (selected.size) parts.push(`${selected.size} selected`);
    parts.push(`${cur.pat.notes.length} notes`);
    if (!isDrum) parts.push(scaleName());
    statusL.textContent = parts.join(' · ');
    const c = isDrum ? null : chordAt();
    statusChord.textContent = c ? `Chord (${c.where}): ${c.chord.name}` : '';
    statusChord.title = c ? 'Detected chord' : '';
  }

  // ---------------------------------------------------------------- toolbar
  const trackSel = h('select.piano-track-sel', { title: 'Track to edit' });
  trackSel.addEventListener('change', () => actions.selectTrack(trackSel.value));
  const patSel = h('select.piano-pat-sel', { title: 'Pattern being edited (also becomes the track\'s active pattern)' });
  patSel.addEventListener('change', () => actions.selectPattern(patSel.value));
  const newPatBtn = iconButton('plus', () => cur.track && actions.newPattern(cur.track.id), 'New empty pattern for this track');
  const dupPatBtn = iconButton('copy', () => cur.pat && actions.duplicatePattern(cur.pat.id), 'Duplicate this pattern');
  const patMenuBtn = iconButton('chevronDown', (e) => contextMenu(anchorEv(e), patternMenuItems()), 'Pattern: rename, delete, length…');
  const barsField = numberField({
    value: 1, min: 1, max: 128, step: 1, width: 40, title: 'Pattern length in bars (drag or type)',
    onChange: (v) => { if (cur.pat) edit('Pattern length', (pat) => { pat.length = v * bpb(); }); },
  });
  const toolBtns = {};
  const toolGroup = h('div.piano-tools');
  for (const t of TOOLS) {
    const b = iconButton(t.icon, () => setTool(t.id), `${t.tip}`, 'piano-tool');
    b.dataset.tool = t.id;
    toolBtns[t.id] = b;
    toolGroup.append(b);
  }
  const chordTypeSel = select({
    title: 'Chord stamp type ("In key" picks the diatonic chord for the clicked degree)',
    options: [{ value: 'diatonic', label: 'In key' }, ...Object.entries(T.CHORD_TYPES).map(([id, c]) => ({ value: id, label: c.symbol ? c.symbol : 'maj', group: 'Chord type' }))],
    value: S.chordType, onChange: (v) => { S.chordType = v; save(); },
    cls: 'piano-chordtype',
  });
  const snapSel = select({
    title: 'Grid / snap', options: SNAPS.map((s, i) => ({ value: i, label: s.label })),
    value: Math.max(0, SNAPS.findIndex((s) => Math.abs(s.v - S.snap) < EPS)),
    onChange: (i) => { S.snap = SNAPS[i].v; save(); drawAll(); },
  });
  const lenSel = select({
    title: 'Length of new notes', options: LENGTHS.map((l, i) => ({ value: i, label: l.label })),
    value: Math.max(0, LENGTHS.findIndex((l) => l.v === S.len)),
    onChange: (i) => { S.len = LENGTHS[i].v; save(); },
  });
  const scaleBtn = h('button.toggle.piano-scale-btn', { type: 'button', title: 'Highlight the project key/scale (in-scale rows lighter, root rows tinted)' }, 'Scale');
  scaleBtn.addEventListener('click', () => { S.scaleHL = !S.scaleHL; save(); syncToolbar(); drawAll(); });
  const foldBtn = h('button.toggle', { type: 'button', title: 'Fold: show only in-scale rows (drums: only used pads)' }, 'Fold');
  foldBtn.addEventListener('click', () => { S.fold = !S.fold; save(); keepCenterPitch(() => buildRows()); syncToolbar(); drawAll(); });
  const snapScaleBtn = iconButton('magnet', () => { S.snapScale = !S.snapScale; save(); syncToolbar(); }, 'Snap to scale: new and moved notes land on scale tones');
  const keyBtn = h('button.btn.small.piano-key-btn', { type: 'button', title: 'Project key & scale (click to change)' });
  keyBtn.addEventListener('click', (e) => contextMenu(anchorEv(e), keyMenuItems()));
  const chordsBtn = button('Chords', (e) => contextMenu(anchorEv(e), chordsMenuItems()), { icon: 'piano', title: 'Insert diatonic chords of the project key at the playhead / selection, voicing & length options', cls: 'small' });
  const moreBtn = button('More', (e) => contextMenu(anchorEv(e), moreMenuItems()), { icon: 'chevronDown', title: 'Transform: quantize, humanize, transpose, reverse, legato, strum, arpeggiate, generate…', cls: 'small' });
  const ghostBtn = iconButton('layers', () => { S.ghosts = !S.ghosts; save(); syncToolbar(); drawAll(); }, 'Ghost notes: show other tracks\' active patterns faintly');
  const audBtn = iconButton('headphones', () => { S.audition = !S.audition; save(); syncToolbar(); }, 'Audition notes while editing');
  const fitBtn = iconButton('zoomIn', () => { fitView(); drawAll(); }, 'Zoom to fit the pattern. Ctrl+wheel: horizontal zoom · Alt+wheel: vertical zoom · Shift+wheel: scroll sideways · middle-drag: pan');

  const grp = (...c) => h('div.piano-group', ...c);
  toolbar.append(
    grp(trackSel, patSel, newPatBtn, dupPatBtn, patMenuBtn, h('label.piano-mini', { title: 'Pattern length in bars' }, barsField, h('span', 'bars'))),
    h('div.sep'),
    grp(toolGroup, chordTypeSel),
    h('div.sep'),
    grp(icon('grid', 14), snapSel, h('span.piano-mini-label', 'Len'), lenSel),
    h('div.sep'),
    grp(keyBtn, scaleBtn, foldBtn, snapScaleBtn),
    h('div.sep'),
    grp(chordsBtn, moreBtn),
    h('div.spacer'),
    grp(ghostBtn, audBtn, fitBtn),
  );

  function anchorEv(e) {
    const r = (e.currentTarget || e.target).getBoundingClientRect();
    return { clientX: r.left, clientY: r.bottom + 2, preventDefault() {} };
  }

  function setTool(t) { S.tool = t; save(); syncToolbar(); scroller.style.cursor = ''; }

  function syncToolbar() {
    const p = proj();
    const inst = p.tracks.filter((t) => t.type === 'instrument');
    trackSel.replaceChildren(...inst.map((t) => h('option', { value: t.id }, `${t.instrument?.type === 'drums' ? '🥁 ' : ''}${t.name}`)));
    if (cur.track) trackSel.value = cur.track.id;
    const pats = cur.track ? patternsForTrack(p, cur.track.id) : [];
    patSel.replaceChildren(...pats.map((pt) => h('option', { value: pt.id }, pt.name)));
    if (cur.pat) patSel.value = cur.pat.id;
    if (cur.pat) barsField.setValue(+(cur.pat.length / bpb()).toFixed(2));
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', S.tool === id);
    chordTypeSel.classList.toggle('hidden', S.tool !== 'chord' || isDrum);
    toolBtns.chord.classList.toggle('hidden', isDrum);
    scaleBtn.classList.toggle('on', S.scaleHL);
    foldBtn.classList.toggle('on', S.fold);
    foldBtn.title = isDrum ? 'Fold: show only pads used in this pattern' : 'Fold: show only in-scale rows';
    snapScaleBtn.classList.toggle('on', S.snapScale);
    ghostBtn.classList.toggle('on', S.ghosts);
    audBtn.classList.toggle('on', S.audition);
    keyBtn.textContent = scaleName();
    for (const b of [scaleBtn, snapScaleBtn, keyBtn, chordsBtn, ghostBtn]) b.classList.toggle('hidden', isDrum);
  }

  // ---------------------------------------------------------------- menus
  function patternMenuItems() {
    const pat = cur.pat;
    if (!pat) return [];
    return [
      { header: pat.name },
      { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptText('Rename pattern', pat.name); if (n) edit('Rename pattern', (pt) => { pt.name = n; }); } },
      { label: 'New pattern', icon: 'plus', onClick: () => actions.newPattern(cur.track.id) },
      { label: 'Duplicate', icon: 'copy', onClick: () => actions.duplicatePattern(pat.id) },
      '-',
      { label: 'Double length (repeat notes)', onClick: () => edit('Double pattern', (pt) => { const L = pt.length; pt.notes.push(...pt.notes.filter((n) => n.start < L).map((n) => mkNote(n.pitch, n.start + L, n.dur, n.vel))); pt.length = L * 2; }) },
      { label: 'Halve length', onClick: () => edit('Halve pattern', (pt) => { pt.length = Math.max(1, pt.length / 2); }) },
      { label: 'Fit length to notes', onClick: () => edit('Fit pattern', (pt) => { const end = pt.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0); const b = bpb(); pt.length = Math.max(b, Math.ceil((end - EPS) / b) * b); }) },
      '-',
      { label: 'Delete pattern', icon: 'trash', onClick: () => actions.deletePattern(pat.id) },
    ];
  }

  function keyMenuItems() {
    const k = keyInfo();
    const scales = Object.entries(T.SCALES);
    return [
      { header: 'Project key' },
      { label: `Root: ${T.pitchClassName(k.root, 'common')}`, submenu: Array.from({ length: 12 }, (_, i) => ({ label: T.pitchClassName(i, 'common'), icon: i === k.root ? 'chevronRight' : null, onClick: () => store.transact('Key', (p) => { p.key.root = i; }) })) },
      { label: `Scale: ${T.SCALES[k.scale]?.name || k.scale}`, submenu: scales.slice(0, 40).map(([id, s]) => ({ label: s.name, icon: id === k.scale ? 'chevronRight' : null, onClick: () => store.transact('Scale', (p) => { p.key.scale = id; }) })) },
      '-',
      { label: 'Detect key from this pattern', icon: 'sparkles', onClick: detectKeyFromPattern, disabled: !cur.pat?.notes.length || typeof T.detectKey !== 'function' },
    ];
  }

  function detectKeyFromPattern() {
    try {
      const res = T.detectKey(cur.pat.notes.map((n) => ({ pitch: n.pitch, dur: n.dur })));
      const best = res?.[0];
      if (!best) return;
      store.transact('Detect key', (p) => { p.key.root = best.root; p.key.scale = best.scale; });
      app.toast(`Key set to ${scaleName()}`, { level: 'success' });
    } catch (e) { app.toast('Key detection failed: ' + e.message, { level: 'warn' }); }
  }

  function chordsMenuItems() {
    const k = keyInfo();
    const tri = [], sev = [];
    for (let d = 0; d < 7; d++) {
      try {
        const c = T.diatonicChord(k.root, k.scale, d);
        tri.push({ label: `${c.roman}  —  ${c.name}`, onClick: () => insertChord(c.root, c.type) });
        const c7 = T.diatonicChord(k.root, k.scale, d, { sevenths: true });
        sev.push({ label: `${c7.roman}  —  ${c7.name}`, onClick: () => insertChord(c7.root, c7.type) });
      } catch { /* ignore */ }
    }
    const radio = (cur0, v) => (cur0 === v ? 'chevronRight' : null);
    const items = [
      { header: `Insert chord in ${scaleName()}` },
      ...tri,
      { label: 'Seventh chords', icon: 'layers', submenu: sev },
      '-',
      { label: 'Voicing', icon: 'sliders', submenu: [['close', 'Close'], ['open', 'Open'], ['drop2', 'Drop 2'], ['spread', 'Spread'], ['smooth', 'Smooth voice-leading']].map(([v, l]) => ({ label: l, icon: radio(S.voicing, v), onClick: () => { S.voicing = v; save(); } })) },
      { label: 'Chord length', icon: 'timeline', submenu: [['bar', '1 bar'], [2, '2 beats'], [1, '1 beat'], [8, '2 bars'], ['note', 'Note length']].map(([v, l]) => ({ label: l, icon: radio(S.chordLen, v), onClick: () => { S.chordLen = v; save(); } })) },
    ];
    if (suggestions.length) {
      items.push('-', { header: 'Suggested next' });
      for (const s of suggestions) {
        const ch = s.chord;
        if (ch) items.push({ label: `${s.roman}  —  ${ch.name || ''}`, icon: 'bulb', onClick: () => { const prog = detectedProgression(); insertChord(ch.root, ch.type, { at: prog.length ? prog[prog.length - 1].end : undefined }); } });
      }
    }
    items.push('-', { label: 'Use chord stamp tool', icon: 'music', onClick: () => setTool('chord') });
    return items;
  }

  function moreMenuItems() {
    const isD = isDrum;
    const roles = isD ? [['drums', 'Drum pattern']] : [['chords', 'Chords'], ['bass', 'Bassline'], ['lead', 'Lead melody'], ['arp', 'Arpeggio'], ['pad', 'Pad']];
    const sel = selected.size ? `${selected.size} selected` : 'all notes';
    return [
      { header: `Transform ${sel}` },
      { label: 'Quantize', icon: 'magnet', shortcut: 'Q', submenu: [
        { label: 'Starts 100%', onClick: () => quantize(1) },
        { label: 'Starts 75%', onClick: () => quantize(0.75) },
        { label: 'Starts 50%', onClick: () => quantize(0.5) },
        { label: 'Starts + ends 100%', onClick: () => quantize(1, true) },
      ] },
      { label: 'Humanize', icon: 'sparkles', submenu: [
        { label: 'Subtle (timing + velocity)', onClick: () => humanize(0.012, 0.06) },
        { label: 'Medium', onClick: () => humanize(0.025, 0.12) },
        { label: 'Heavy', onClick: () => humanize(0.05, 0.2) },
        { label: 'Velocity only', onClick: () => humanize(0, 0.15) },
        { label: 'Timing only', onClick: () => humanize(0.025, 0) },
      ] },
      { label: 'Transpose', icon: 'music', submenu: [
        { label: '+1 semitone', shortcut: '↑', onClick: () => transpose(1) },
        { label: '−1 semitone', shortcut: '↓', onClick: () => transpose(-1) },
        { label: '+1 octave', shortcut: 'Shift+↑', onClick: () => transpose(12) },
        { label: '−1 octave', shortcut: 'Shift+↓', onClick: () => transpose(-12) },
        ...(isD ? [] : [{ label: 'Fix out-of-scale notes', onClick: fixToScale }]),
      ] },
      { label: 'Velocity', icon: 'sliders', submenu: [
        { label: 'Randomize', onClick: () => mapNotes('Randomize velocity', (n, rng) => { n.vel = 0.5 + rng() * 0.5; }) },
        { label: 'Accent downbeats', onClick: () => mapNotes('Accent downbeats', (n) => { n.vel = Math.abs(n.start - Math.round(n.start)) < EPS ? Math.min(1, (n.vel ?? 0.8) + 0.15) : Math.max(0.2, (n.vel ?? 0.8) - 0.1); }) },
        { label: 'Crescendo', onClick: () => ramp(0.4, 1) },
        { label: 'Decrescendo', onClick: () => ramp(1, 0.4) },
        { label: 'Set all to 100', onClick: () => mapNotes('Set velocity', (n) => { n.vel = 100 / 127; }) },
        { label: 'Set all to 64', onClick: () => mapNotes('Set velocity', (n) => { n.vel = 64 / 127; }) },
      ] },
      { label: 'Timing', icon: 'timeline', submenu: [
        { label: 'Reverse (retrograde)', onClick: reverse },
        { label: 'Legato (fill gaps)', onClick: legato },
        { label: 'Double speed', onClick: () => speed(0.5) },
        { label: 'Half speed', onClick: () => speed(2) },
        { label: 'Strum up', onClick: () => strum(1) },
        { label: 'Strum down', onClick: () => strum(-1) },
        { label: 'Staccato (halve lengths)', onClick: () => mapNotes('Staccato', (n) => { n.dur = Math.max(1 / 32, n.dur / 2); }) },
      ] },
      ...(isD ? [] : [
        { label: 'Invert (mirror pitches)', icon: 'redo', onClick: invertPitches },
        { label: 'Arpeggiate chords', icon: 'wave', submenu: [['up', 'Up'], ['down', 'Down'], ['updown', 'Up-down'], ['downup', 'Down-up'], ['converge', 'Converge'], ['pinky', 'Pinky (top note pedal)'], ['thumb', 'Thumb (bass pedal)'], ['random', 'Random']].map(([m, l]) => ({ label: l, onClick: () => arpeggiate(m) })) },
      ]),
      '-',
      { label: 'Select', icon: 'pointer', submenu: [
        { label: 'All', shortcut: 'Ctrl+A', onClick: () => selectAll() },
        { label: 'None', shortcut: 'Esc', onClick: () => { selected.clear(); drawAll(); } },
        { label: 'Invert selection', onClick: () => { const s = new Set(cur.pat.notes.filter((n) => !selected.has(n.id)).map((n) => n.id)); selected = s; drawAll(); } },
        ...(isD ? [] : [{ label: 'Out-of-scale notes', onClick: () => { selected = new Set(cur.pat.notes.filter((n) => !inKey(n.pitch)).map((n) => n.id)); drawAll(); } }]),
      ] },
      { label: 'Generate into pattern', icon: 'wand', submenu: roles.map(([r, l]) => ({ label: l, icon: 'dice', onClick: () => { selected.clear(); actions.generatePart(r, { trackId: cur.track.id }); } })) },
      '-',
      { label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', onClick: copySel, disabled: !selected.size },
      { label: 'Paste', shortcut: 'Ctrl+V', onClick: paste, disabled: !clipboard },
      { label: 'Duplicate right', shortcut: 'Ctrl+D', onClick: duplicateRight, disabled: !selected.size },
      { label: selected.size ? 'Delete selected' : 'Clear pattern', icon: 'trash', shortcut: selected.size ? 'Del' : '', onClick: () => { if (selected.size) deleteSel(); else edit('Clear pattern', (pt) => { pt.notes = []; }); } },
      '-',
      { label: 'Detect key from notes', icon: 'sparkles', onClick: detectKeyFromPattern, disabled: isD },
    ];
  }

  // ---------------------------------------------------------------- transforms
  function mapNotes(label, fn) {
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    edit(label, (pat) => { const ts = targets(pat); ts.forEach((n, i) => { fn(n, rng, i, ts); tidy(n); }); });
  }
  function quantize(strength = 1, ends = false) {
    const g = gridStep();
    mapNotes('Quantize', (n) => {
      const end = n.start + n.dur;
      const qs = Math.round(n.start / g) * g;
      n.start = n.start + (qs - n.start) * strength;
      if (ends) { const qe = Math.max(qs + g, Math.round(end / g) * g); n.dur = Math.max(g, (end + (qe - end) * strength) - n.start); }
    });
    app.setStatus?.(`Quantized to ${SNAPS.find((s) => Math.abs(s.v - g) < EPS)?.label || g} grid`);
  }
  function humanize(t, v) {
    const gauss = (rng) => (rng() + rng() + rng() - 1.5) / 1.5;
    mapNotes('Humanize', (n, rng) => {
      if (t) n.start = Math.max(0, n.start + gauss(rng) * t * 4);
      if (v) n.vel = clamp((n.vel ?? 0.8) + gauss(rng) * v, 0.1, 1);
    });
  }
  function transpose(semi) {
    edit('Transpose', (pat) => {
      for (const n of targets(pat)) {
        let np = n.pitch + semi;
        if (isDrum && Math.abs(semi) < 12) { const r = rowOf.get(n.pitch); if (r != null) np = rows[clamp(r - semi, 0, rows.length - 1)].pitch; }
        n.pitch = clamp(np, 0, 127);
      }
    });
  }
  function fixToScale() { const k = keyInfo(); mapNotes('Snap to scale', (n) => { n.pitch = T.snapToScale(n.pitch, k.root, k.scale); }); }
  function ramp(a, b) {
    edit('Velocity ramp', (pat) => {
      const ts = targets(pat).slice().sort((x, y) => x.start - y.start);
      const s0 = ts[0]?.start ?? 0, s1 = ts[ts.length - 1]?.start ?? 1;
      for (const n of ts) { const f = s1 > s0 ? (n.start - s0) / (s1 - s0) : 0; n.vel = roundT(a + (b - a) * f); }
    });
  }
  function reverse() {
    edit('Reverse', (pat) => {
      const ts = targets(pat);
      if (!ts.length) return;
      const s0 = Math.min(...ts.map((n) => n.start)), s1 = Math.max(...ts.map((n) => n.start + n.dur));
      for (const n of ts) { n.start = s0 + s1 - (n.start + n.dur); tidy(n); }
    });
  }
  function invertPitches() {
    edit('Invert', (pat) => {
      const ts = targets(pat);
      if (!ts.length) return;
      const lo = Math.min(...ts.map((n) => n.pitch)), hi = Math.max(...ts.map((n) => n.pitch));
      const k = keyInfo();
      for (const n of ts) { n.pitch = lo + hi - n.pitch; if (S.snapScale) n.pitch = T.snapToScale(n.pitch, k.root, k.scale); }
    });
  }
  function legato() {
    edit('Legato', (pat) => {
      const ts = targets(pat).slice().sort((a, b) => a.start - b.start);
      for (const n of ts) {
        const next = ts.find((m) => m.start > n.start + EPS);
        const end = next ? next.start : Math.max(pat.length, n.start + n.dur);
        n.dur = roundT(Math.max(1 / 32, end - n.start));
      }
    });
  }
  function speed(f) {
    edit(f < 1 ? 'Double speed' : 'Half speed', (pat) => {
      const ts = targets(pat);
      if (!ts.length) return;
      const s0 = Math.min(...ts.map((n) => n.start));
      for (const n of ts) { n.start = s0 + (n.start - s0) * f; n.dur = Math.max(1 / 64, n.dur * f); tidy(n); }
      ensureLength(pat, Math.max(...ts.map((n) => n.start + n.dur)));
    });
  }
  function strum(dir) {
    edit('Strum', (pat) => {
      const groups = new Map();
      for (const n of targets(pat)) { const k = Math.round(n.start * 64); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
      const step = 1 / 24;
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort((a, b) => (a.pitch - b.pitch) * dir);
        g.forEach((n, i) => { const o = i * step; n.start += o; n.dur = Math.max(1 / 32, n.dur - o); tidy(n); });
      }
    });
  }
  function arpeggiate(mode) {
    const pat = cur.pat;
    const ts = targets(pat);
    const groups = new Map();
    for (const n of ts) { const k = Math.round(n.start * 64) / 64; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    const chords = [...groups.entries()].filter(([, g]) => g.length >= 2).sort((a, b) => a[0] - b[0]);
    if (!chords.length) { app.toast('Arpeggiate needs chords (2+ notes starting together). Select some, or add chords with the Chords menu.', { level: 'warn', timeout: 5000 }); return; }
    const rate = 0.25;
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    const remove = new Set();
    const out = [];
    for (const [start, g] of chords) {
      const dur = Math.max(...g.map((n) => n.dur));
      const pitches = g.map((n) => n.pitch).sort((a, b) => a - b);
      const vel = g.reduce((s, n) => s + (n.vel ?? 0.8), 0) / g.length;
      g.forEach((n) => remove.add(n.id));
      let notes = null;
      if (gen?.arpeggiate) {
        try {
          const prog = [{ startBeat: start, durBeats: dur, notes: pitches, chord: T.detectChord(pitches) }];
          const res = gen.arpeggiate(prog, { mode, rate, octaves: 1, rng });
          if (Array.isArray(res) && res.length && res.every((n) => Number.isFinite(n.pitch) && Number.isFinite(n.start))) notes = res;
        } catch { notes = null; }
      }
      if (!notes) {
        notes = [];
        const seq = mode === 'down' ? pitches.slice().reverse() : mode === 'updown' ? [...pitches, ...pitches.slice(1, -1).reverse()] : pitches;
        for (let i = 0, t = start; t < start + dur - EPS; i++, t += rate) {
          const m = mode === 'random' ? pitches[Math.floor(rng() * pitches.length)] : seq[i % seq.length];
          notes.push({ pitch: m, start: t, dur: Math.min(rate, start + dur - t), vel });
        }
      }
      for (const n of notes) out.push(mkNote(n.pitch, n.start, n.dur, n.vel ?? vel));
    }
    edit('Arpeggiate', (pt) => { pt.notes = pt.notes.filter((n) => !remove.has(n.id)).concat(out); });
    selected = new Set(out.map((n) => n.id));
  }

  // chords
  function insertPos() {
    const pat = cur.pat;
    if (selected.size) {
      const s = pat.notes.filter((n) => selected.has(n.id));
      if (s.length) return Math.min(...s.map((n) => n.start));
    }
    if (engine.isPlaying) { const lp = localPos(); if (lp != null) return Math.floor(lp / gridStep() + EPS) * gridStep(); }
    if (chordCursor != null) return chordCursor;
    const end = pat.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
    return Math.ceil(end - EPS);
  }
  function voiceChord(rootPc, type, at) {
    if (S.voicing === 'smooth' && T.voiceChord) {
      // voice-led from the chord before it, clean low-interval limits, ~C3–C5
      const before = cur.pat.notes.filter((n) => n.start < at - EPS);
      let prev = [];
      if (before.length) {
        const lastStart = Math.max(...before.map((n) => n.start));
        prev = before.filter((n) => Math.abs(n.start - lastStart) < EPS).map((n) => n.pitch);
      }
      try { const v = T.voiceChord({ root: rootPc, type }, { prev, range: [52, 76], maxVoices: 5 }); if (v?.length) return v; } catch { /* fall through */ }
    }
    let rootMidi = 48 + rootPc;
    if (rootMidi > 55) rootMidi -= 12;
    if (rootMidi < 48) rootMidi += 12;
    const voicing = S.voicing === 'smooth' ? 'close' : S.voicing;
    const notes = T.chordNotes(rootMidi + 12, type, { voicing });
    // drop / spread voicings can push 2nds and 3rds into the mud: lift them (no m2 below C4, no 3rds below F3)
    return T.cleanVoicing ? T.cleanVoicing(notes) : notes;
  }
  function insertChord(rootPc, type, { at } = {}) {
    if (!cur.pat || isDrum) return;
    const start = at ?? insertPos();
    const len = chordLenBeats();
    const pitches = voiceChord(rootPc, type, start);
    const notes = pitches.map((m) => mkNote(m, start, len, 0.78));
    edit('Insert chord', (pat) => { pat.notes.push(...notes); ensureLength(pat, start + len); });
    chordCursor = start + len;
    selected.clear();
    audition(pitches, 0.7, 450);
    const c = T.detectChord(pitches);
    app.setStatus?.(`Inserted ${c?.name || 'chord'} at ${fmtBeat(start, bpb())}`);
  }
  function chordForClick(pitch) {
    const k = keyInfo();
    if (S.chordType === 'diatonic') {
      const m = T.snapToScale(pitch, k.root, k.scale);
      const deg = T.scaleDegreeOf ? T.scaleDegreeOf(m, k.root, k.scale) : -1;
      if (deg >= 0) {
        try {
          const c = T.diatonicChord(k.root, k.scale, deg);
          return clean(T.chordNotes(m, c.type));
        } catch { /* fall back */ }
      }
      return clean(T.chordNotes(m, 'maj'));
    }
    return clean(T.chordNotes(pitch, S.chordType));
  }
  /** Stamped chords keep their clicked root but never stack 2nds / 3rds in the low register. */
  function clean(notes) {
    return T.cleanVoicing ? T.cleanVoicing(notes) : notes;
  }

  // clipboard
  function copySel() {
    const pat = cur.pat;
    const s = pat.notes.filter((n) => selected.has(n.id));
    if (!s.length) return false;
    const s0 = Math.min(...s.map((n) => n.start));
    const s1 = Math.max(...s.map((n) => n.start + n.dur));
    clipboard = { notes: s.map((n) => ({ pitch: n.pitch, start: n.start - s0, dur: n.dur, vel: n.vel })), span: s1 - s0, origin: s0 };
    app.setStatus?.(`Copied ${s.length} note(s)`);
    return true;
  }
  function paste() {
    if (!clipboard || !cur.pat) return;
    const pat = cur.pat;
    let at;
    if (engine.isPlaying) { const lp = localPos(); at = lp == null ? 0 : Math.floor(lp / gridStep() + EPS) * gridStep(); }
    else if (selected.size) {
      const s = pat.notes.filter((n) => selected.has(n.id));
      const end = Math.max(...s.map((n) => n.start + n.dur));
      at = Math.ceil(end / gridStep() - EPS) * gridStep();
    } else at = clipboard.origin;
    const fresh = clipboard.notes.map((n) => mkNote(n.pitch, at + n.start, n.dur, n.vel));
    edit('Paste notes', (pt) => { pt.notes.push(...fresh); ensureLength(pt, at + clipboard.span); });
    selected = new Set(fresh.map((n) => n.id));
  }
  function duplicateRight() {
    const pat = cur.pat;
    const s = pat.notes.filter((n) => selected.has(n.id));
    if (!s.length) return;
    const s0 = Math.min(...s.map((n) => n.start)), s1 = Math.max(...s.map((n) => n.start + n.dur));
    const g = S.snap || 0.25;
    const span = Math.max(g, Math.ceil((s1 - s0) / g - EPS) * g);
    const fresh = s.map((n) => mkNote(n.pitch, n.start + span, n.dur, n.vel));
    edit('Duplicate notes', (pt) => { pt.notes.push(...fresh); ensureLength(pt, s1 + span); });
    selected = new Set(fresh.map((n) => n.id));
  }
  function deleteSel() {
    if (!selected.size) return;
    const ids = new Set(selected);
    edit('Delete notes', (pat) => { pat.notes = pat.notes.filter((n) => !ids.has(n.id)); });
    selected.clear();
  }
  function selectAll() { selected = new Set(cur.pat.notes.map((n) => n.id)); drawAll(); }
  function nudge(dBeat, dSemi, octave) {
    if (!selected.size) return;
    const k = keyInfo();
    edit('Nudge notes', (pat) => {
      for (const n of pat.notes) {
        if (!selected.has(n.id)) continue;
        n.start = roundT(Math.max(0, n.start + dBeat));
        if (dSemi) {
          if (isDrum && !octave) { const r = rowOf.get(n.pitch); if (r != null) n.pitch = rows[clamp(r - dSemi, 0, rows.length - 1)].pitch; }
          else if (S.snapScale && !octave && !isDrum && T.stepInScale) n.pitch = clamp(T.stepInScale(n.pitch, dSemi, k.root, k.scale), 0, 127);
          else n.pitch = clamp(n.pitch + dSemi * (octave ? 12 : 1), 0, 127);
        }
      }
    });
    if (dSemi) {
      const ps = cur.pat ? proj().patterns[cur.pat.id].notes.filter((n) => selected.has(n.id)).map((n) => n.pitch) : [];
      if (ps.length && ps.length <= 6) audition([...new Set(ps)], 0.7, 180);
    }
  }

  // ---------------------------------------------------------------- grid mouse
  let dragging = false;
  scroller.addEventListener('contextmenu', (e) => e.preventDefault());
  scroller.addEventListener('pointerdown', (e) => {
    if (!cur.pat) return;
    const r = scroller.getBoundingClientRect();
    if (e.clientX - r.left >= scroller.clientWidth || e.clientY - r.top >= scroller.clientHeight) return; // scrollbars
    e.preventDefault();
    scroller.focus({ preventScroll: true });
    const pt = point(e.clientX, e.clientY);
    const hit = hitTest(pt);
    const drag = { recorded: false };

    if (e.button === 1) { // middle: pan
      const sl = scroller.scrollLeft, st = scroller.scrollTop;
      startDrag(e, (dx, dy) => { scroller.scrollLeft = sl - dx; scroller.scrollTop = st - dy; });
      return;
    }
    if (e.button === 2) {
      let moved = false;
      if (hit) eraseAt(pt, drag);
      dragging = true;
      startDrag(e, (dx, dy, ev) => {
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        eraseAt(point(ev.clientX, ev.clientY), drag);
      }, () => {
        dragging = false;
        if (!hit && !moved) contextMenu(e, gridContextItems(pt));
      });
      return;
    }
    if (e.button !== 0) return;
    const tool = S.tool;
    if (tool === 'eraser' || e.altKey) {
      eraseAt(pt, drag);
      dragging = true;
      startDrag(e, (_dx, _dy, ev) => eraseAt(point(ev.clientX, ev.clientY), drag), () => { dragging = false; });
      return;
    }
    if (!hit && (e.shiftKey || tool === 'pointer' || tool === 'velocity' || tool === 'slice')) { rubberBand(e, pt, e.shiftKey); return; }
    if (hit && tool === 'slice') { slice(hit.note, pt.beat); return; }
    if (hit && tool === 'velocity') { velDrag(e, hit.note); return; }
    if (hit) {
      const n = hit.note;
      if (e.shiftKey) {
        if (selected.has(n.id)) selected.delete(n.id); else selected.add(n.id);
        drawAll();
        if (!selected.has(n.id)) return;
      } else if (!selected.has(n.id)) { selected = new Set([n.id]); }
      if (S.len === 'last') lastLen = n.dur;
      let ids = [...selected];
      if ((e.ctrlKey || e.metaKey) && !hit.edge) {
        // duplicate the selection and drag the copies
        const src = cur.pat.notes.filter((x) => selected.has(x.id));
        const copies = src.map((x) => mkNote(x.pitch, x.start, x.dur, x.vel));
        const anchorIdx = src.findIndex((x) => x.id === n.id);
        edit('Duplicate notes', (pat) => { pat.notes.push(...copies); }, drag);
        selected = new Set(copies.map((x) => x.id));
        ids = [...selected];
        moveDrag(e, copies[anchorIdx].id, ids, drag, pt);
        return;
      }
      audition(n.pitch, n.vel ?? 0.8);
      if (hit.edge === 'end') resizeDrag(e, n.id, ids, drag, 'end');
      else if (hit.edge === 'start') resizeDrag(e, n.id, ids, drag, 'start');
      else moveDrag(e, n.id, ids, drag, pt);
      drawAll();
      return;
    }
    // empty space with pencil / chord: create
    if (pt.pitch == null) return;
    const start = snapFloor(pt.beat);
    const k = keyInfo();
    let pitches;
    if (tool === 'chord' && !isDrum) pitches = chordForClick(pt.pitch);
    else pitches = [S.snapScale && !isDrum ? T.snapToScale(pt.pitch, k.root, k.scale) : pt.pitch];
    const len = tool === 'chord' ? (S.chordLen === 'note' ? noteLen() : chordLenBeats()) : noteLen();
    const fresh = pitches.filter((m) => m >= 0 && m <= 127).map((m) => mkNote(m, start, len, 0.8));
    if (!e.shiftKey) selected.clear();
    edit(fresh.length > 1 ? 'Add chord' : 'Add note', (pat) => { pat.notes.push(...fresh); }, drag);
    for (const f of fresh) selected.add(f.id);
    audition(pitches, 0.8, tool === 'chord' ? 450 : 240);
    drawAll();
    // drag right to set the length of what we just drew
    resizeDrag(e, fresh[0].id, fresh.map((f) => f.id), drag, 'end', true);
  });

  scroller.addEventListener('dblclick', (e) => {
    if (!cur.pat || S.tool === 'slice') return;
    const pt = point(e.clientX, e.clientY);
    const hit = hitTest(pt);
    if (hit) {
      const id = hit.note.id;
      edit('Delete note', (pat) => { pat.notes = pat.notes.filter((n) => n.id !== id); });
      selected.delete(id);
    } else if (S.tool === 'pointer' || S.tool === 'velocity') {
      const k = keyInfo();
      const m = S.snapScale && !isDrum ? T.snapToScale(pt.pitch, k.root, k.scale) : pt.pitch;
      const n = mkNote(m, snapFloor(pt.beat), noteLen(), 0.8);
      edit('Add note', (pat) => { pat.notes.push(n); });
      selected = new Set([n.id]);
      audition(m);
    }
  });

  function gridContextItems(pt) {
    return [
      { label: 'Paste here', icon: 'copy', disabled: !clipboard, onClick: () => {
        const at = snapFloor(pt.beat);
        const fresh = clipboard.notes.map((n) => mkNote(n.pitch, at + n.start, n.dur, n.vel));
        edit('Paste notes', (pat) => { pat.notes.push(...fresh); ensureLength(pat, at + clipboard.span); });
        selected = new Set(fresh.map((n) => n.id));
      } },
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: selectAll },
      ...(isDrum ? [] : [{ label: 'Insert chord here', icon: 'piano', submenu: (() => {
        const k = keyInfo();
        const out = [];
        for (let d = 0; d < 7; d++) { try { const c = T.diatonicChord(k.root, k.scale, d); out.push({ label: `${c.roman} — ${c.name}`, onClick: () => insertChord(c.root, c.type, { at: snapFloor(pt.beat) }) }); } catch { /* ignore */ } }
        return out;
      })() }]),
      '-',
      ...moreMenuItems().slice(1),
    ];
  }

  function eraseAt(pt, drag) {
    const hit = hitTest(pt);
    if (!hit) return;
    const id = hit.note.id;
    edit('Erase notes', (pat) => { pat.notes = pat.notes.filter((n) => n.id !== id); }, drag);
    selected.delete(id);
  }

  function slice(note, beat) {
    const cut = S.snap ? snapRound(beat) : beat;
    if (cut <= note.start + EPS || cut >= note.start + note.dur - EPS) return;
    const right = mkNote(note.pitch, cut, note.start + note.dur - cut, note.vel);
    edit('Slice note', (pat) => {
      const n = pat.notes.find((x) => x.id === note.id);
      if (!n) return;
      n.dur = roundT(cut - n.start);
      pat.notes.push(right);
    });
  }

  function rubberBand(e, pt, additive) {
    const base = additive ? new Set(selected) : new Set();
    band = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    if (!additive) selected = new Set();
    dragging = true;
    drawAll();
    startDrag(e, (_dx, _dy, ev) => {
      const q = point(ev.clientX, ev.clientY);
      band.x1 = q.x; band.y1 = clamp(q.y, 0, rows.length * rowH());
      const P = ppb(), rh = rowH();
      const bx0 = Math.min(band.x0, band.x1), bx1 = Math.max(band.x0, band.x1);
      const by0 = Math.min(band.y0, band.y1), by1 = Math.max(band.y0, band.y1);
      const s = new Set(base);
      for (const n of cur.pat.notes) {
        const r = rowOf.get(n.pitch);
        if (r == null) continue;
        const x0 = n.start * P, x1 = x0 + Math.max(3, n.dur * P), y0 = r * rh, y1 = y0 + rh;
        if (x1 >= bx0 && x0 <= bx1 && y1 >= by0 && y0 <= by1) s.add(n.id);
      }
      selected = s;
      drawGrid(); drawVel(); updateStatus();
    }, () => { band = null; dragging = false; drawAll(); });
  }

  function mapPitch(p0, dRow, dSemi) {
    if (!isDrum && !S.fold) {
      let np = p0 + dSemi;
      if (S.snapScale && dSemi) { const k = keyInfo(); np = T.snapToScale(np, k.root, k.scale); }
      return clamp(np, 0, 127);
    }
    const r = rowOf.get(p0);
    if (r == null) return p0;
    return rows[clamp(r + dRow, 0, rows.length - 1)].pitch;
  }

  function moveDrag(e, anchorId, ids, drag, pt0) {
    const pat0 = proj().patterns[cur.pat.id];
    const idSet = new Set(ids);
    const orig = pat0.notes.filter((n) => idSet.has(n.id)).map((n) => ({ ...n }));
    const anchor = orig.find((n) => n.id === anchorId) || orig[0];
    if (!anchor) return;
    const minStart = Math.min(...orig.map((n) => n.start));
    const offset = pt0.beat - anchor.start; // grab offset inside the note
    let last = { d: 0, r: 0 };
    let lastPitch = anchor.pitch;
    dragging = true;
    startDrag(e, (_dx, dy, ev) => {
      const q = point(ev.clientX, ev.clientY);
      let newStart = q.beat - offset;
      newStart = S.snap ? snapRound(newStart) : newStart;
      let d = newStart - anchor.start;
      d = Math.max(d, -minStart);
      const dRow = q.row - (rowOf.get(anchor.pitch) ?? q.row);
      const dSemi = isDrum || S.fold ? 0 : -dRow;
      if (Math.abs(d - last.d) < EPS && dRow === last.r) return;
      last = { d, r: dRow };
      edit('Move notes', (pat) => {
        const byId = new Map(pat.notes.map((n) => [n.id, n]));
        for (const o of orig) {
          const n = byId.get(o.id);
          if (!n) continue;
          n.start = roundT(o.start + d);
          n.pitch = mapPitch(o.pitch, dRow, dSemi);
        }
      }, drag);
      const np = mapPitch(anchor.pitch, dRow, dSemi);
      if (np !== lastPitch) { lastPitch = np; audition(np, anchor.vel ?? 0.8, 160); }
      hover = { pitch: np, beat: anchor.start + d, note: null };
      updateStatus();
    }, () => { dragging = false; });
  }

  function resizeDrag(e, anchorId, ids, drag, side, fromCreate = false) {
    const pat0 = proj().patterns[cur.pat.id];
    const idSet = new Set(ids);
    const orig = pat0.notes.filter((n) => idSet.has(n.id)).map((n) => ({ ...n }));
    const anchor = orig.find((n) => n.id === anchorId) || orig[0];
    if (!anchor) return;
    const md = minDur();
    dragging = true;
    let lastV = null;
    startDrag(e, (dx, _dy, ev) => {
      if (fromCreate && Math.abs(dx) < 4) return;
      const q = point(ev.clientX, ev.clientY);
      if (side === 'end') {
        let end = S.snap ? snapRound(q.beat) : q.beat;
        if (fromCreate && S.snap) end = Math.max(anchor.start + S.snap, Math.ceil(q.beat / S.snap - EPS) * S.snap);
        const dd = end - (anchor.start + anchor.dur);
        if (lastV !== null && Math.abs(dd - lastV) < EPS) return;
        lastV = dd;
        edit(fromCreate ? 'Add note' : 'Resize notes', (pat) => {
          const byId = new Map(pat.notes.map((n) => [n.id, n]));
          for (const o of orig) { const n = byId.get(o.id); if (n) n.dur = roundT(Math.max(md, o.dur + dd)); }
        }, drag);
        lastLen = Math.max(md, anchor.dur + dd);
      } else {
        let st = S.snap ? snapRound(q.beat) : q.beat;
        const ds = st - anchor.start;
        if (lastV !== null && Math.abs(ds - lastV) < EPS) return;
        lastV = ds;
        edit('Resize notes', (pat) => {
          const byId = new Map(pat.notes.map((n) => [n.id, n]));
          for (const o of orig) {
            const n = byId.get(o.id);
            if (!n) continue;
            const end = o.start + o.dur;
            const ns = clamp(o.start + ds, 0, end - md);
            n.start = roundT(ns); n.dur = roundT(end - ns);
          }
        }, drag);
      }
      app.setStatus?.(`Length: ${(lastLen).toFixed(3).replace(/\.?0+$/, '')} beats`);
    }, () => { dragging = false; });
  }

  function velDrag(e, note) {
    if (!selected.has(note.id)) selected = new Set([note.id]);
    const idSet = new Set(selected);
    const orig = proj().patterns[cur.pat.id].notes.filter((n) => idSet.has(n.id)).map((n) => ({ ...n }));
    const drag = { recorded: false };
    dragging = true;
    drawAll();
    startDrag(e, (_dx, dy) => {
      edit('Velocity', (pat) => {
        const byId = new Map(pat.notes.map((n) => [n.id, n]));
        for (const o of orig) { const n = byId.get(o.id); if (n) n.vel = roundT(clamp((o.vel ?? 0.8) - dy / 150, 0.02, 1)); }
      }, drag);
      const v = clamp((orig.find((o) => o.id === note.id)?.vel ?? 0.8) - dy / 150, 0.02, 1);
      app.setStatus?.(`Velocity ${Math.round(v * 127)}`);
    }, () => { dragging = false; });
  }

  // hover / cursor
  scroller.addEventListener('pointermove', (e) => {
    if (!cur.pat || e.buttons) return;
    const pt = point(e.clientX, e.clientY);
    const hit = hitTest(pt);
    const prevPitch = hover?.pitch;
    hover = { pitch: pt.pitch, beat: pt.beat, note: hit?.note || null };
    let cursor = 'default';
    if (e.altKey || S.tool === 'eraser') cursor = hit ? 'not-allowed' : 'default';
    else if (S.tool === 'slice') cursor = hit ? 'col-resize' : 'default';
    else if (S.tool === 'velocity') cursor = hit ? 'ns-resize' : 'default';
    else if (hit) cursor = hit.edge ? (hit.edge === 'end' ? 'e-resize' : 'w-resize') : (e.ctrlKey || e.metaKey ? 'copy' : 'move');
    else if (S.tool === 'pencil' || S.tool === 'chord') cursor = 'crosshair';
    scroller.style.cursor = cursor;
    if (prevPitch !== pt.pitch) { drawKeys(); drawGrid(); }
    updateStatus();
  });
  scroller.addEventListener('pointerleave', () => { if (dragging) return; hover = null; if (cur.pat) { drawKeys(); drawGrid(); updateStatus(); } });

  // scroll & zoom
  scroller.addEventListener('scroll', () => { if (!cur.pat) return; drawGrid(); drawKeys(); drawRuler(); drawVel(); updatePlayhead(); });
  function zoomH(f, anchorX) {
    const P = ppb();
    const ax = anchorX ?? scroller.clientWidth / 2;
    const beatAt = (scroller.scrollLeft + ax) / P;
    S.ppb = clamp(P * f, MIN_PPB, MAX_PPB);
    save();
    updateSpacer();
    scroller.scrollLeft = Math.max(0, beatAt * S.ppb - ax);
    drawAll();
  }
  function zoomV(f, anchorY) {
    const rh = rowH();
    const ay = anchorY ?? scroller.clientHeight / 2;
    const rowAt = (scroller.scrollTop + ay) / rh;
    S.rowH = clamp(Math.round(S.rowH * f * 2) / 2, 6, 40);
    if (S.rowH === rh && f > 1) S.rowH = Math.min(40, rh + 1);
    save();
    updateSpacer();
    scroller.scrollTop = Math.max(0, rowAt * rowH() - ay);
    drawAll();
  }
  const onWheelZoom = (e) => {
    if (!cur.pat) return;
    const r = scroller.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomH(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left); }
    else if (e.altKey) { e.preventDefault(); zoomV(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientY - r.top); }
  };
  scroller.addEventListener('wheel', onWheelZoom, { passive: false });
  keysCv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.altKey || e.ctrlKey || e.metaKey) { const r = scroller.getBoundingClientRect(); zoomV(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientY - r.top); return; }
    scroller.scrollTop += e.deltaY;
  }, { passive: false });
  rulerCv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) { const r = scroller.getBoundingClientRect(); zoomH(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left); return; }
    scroller.scrollLeft += e.deltaY || e.deltaX;
  }, { passive: false });
  velCv.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = scroller.getBoundingClientRect(); zoomH(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left); return; } e.preventDefault(); scroller.scrollLeft += e.deltaX || e.deltaY; }, { passive: false });

  function keepCenterPitch(fn) {
    const mid = rows[Math.floor((scroller.scrollTop + scroller.clientHeight / 2) / rowH())]?.pitch;
    fn();
    updateSpacer();
    if (mid != null) scrollToPitch(mid);
  }
  function scrollToPitch(m) {
    let idx = rowOf.get(m);
    if (idx == null) {
      let best = 0, bd = 1e9;
      rows.forEach((r, i) => { const d = Math.abs(r.pitch - m); if (d < bd) { bd = d; best = i; } });
      idx = best;
    }
    scroller.scrollTop = Math.max(0, idx * rowH() - scroller.clientHeight / 2 + rowH() / 2);
  }
  function fitView() {
    const pat = cur.pat;
    if (!pat) return;
    const w = scroller.clientWidth || 800;
    const end = Math.max(pat.length, pat.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0));
    S.ppb = clamp((w - 24) / Math.max(end, 1), MIN_PPB, 220);
    save();
    updateSpacer();
    scroller.scrollLeft = 0;
    if (pat.notes.length) {
      const ps = pat.notes.map((n) => n.pitch);
      scrollToPitch(Math.round((Math.min(...ps) + Math.max(...ps)) / 2));
    } else if (isDrum) scroller.scrollTop = 0;
    else scrollToPitch(60 + keyInfo().root);
  }

  // ruler: click = playhead, drag end marker = length
  rulerCv.addEventListener('pointerdown', (e) => {
    if (!cur.pat) return;
    e.preventDefault();
    const r = rulerCv.getBoundingClientRect();
    const x = e.clientX - r.left + scroller.scrollLeft;
    const P = ppb();
    const endX = cur.pat.length * P;
    if (Math.abs(x - endX) <= 7) {
      const drag = { recorded: false };
      dragging = true;
      startDrag(e, (_dx, _dy, ev) => {
        const xx = ev.clientX - r.left + scroller.scrollLeft;
        const g = Math.max(S.snap || 1, 0.25) >= 1 ? 1 : Math.max(S.snap, 0.25);
        const len = Math.max(g, Math.round(xx / P / g) * g);
        if (Math.abs(len - proj().patterns[cur.pat.id].length) < EPS) return;
        edit('Pattern length', (pat) => { pat.length = len; }, drag);
        app.setStatus?.(`Pattern length: ${len} beats (${+(len / bpb()).toFixed(2)} bars)`);
      }, () => { dragging = false; });
      return;
    }
    const beat = Math.max(0, x / P);
    const p = proj();
    if (p.mode === 'song') {
      const c = p.clips.find((cl) => cl.patternId === cur.pat.id);
      actions.setPosition(c ? c.start + Math.max(0, beat - (c.offset || 0)) : beat);
    } else actions.setPosition(snapFloor(beat));
    updatePlayhead(true);
  });
  rulerCv.addEventListener('pointermove', (e) => {
    if (!cur.pat) return;
    const r = rulerCv.getBoundingClientRect();
    const x = e.clientX - r.left + scroller.scrollLeft;
    rulerCv.style.cursor = Math.abs(x - cur.pat.length * ppb()) <= 7 ? 'ew-resize' : 'pointer';
  });

  // keyboard (piano keys)
  keysCv.addEventListener('pointerdown', (e) => {
    if (!cur.pat || !cur.track) return;
    e.preventDefault();
    const r = keysCv.getBoundingClientRect();
    const rowAt = (cy) => clamp(Math.floor((cy - r.top + scroller.scrollTop) / rowH()), 0, rows.length - 1);
    let pitch = rows[rowAt(e.clientY)]?.pitch;
    if (pitch == null) return;
    if (e.shiftKey) {
      const add = cur.pat.notes.filter((n) => n.pitch === pitch).map((n) => n.id);
      if (!(e.ctrlKey || e.metaKey)) selected = new Set();
      for (const id of add) selected.add(id);
      drawAll();
      return;
    }
    const tid = cur.track.id;
    const velAt = (cx) => clamp(0.45 + 0.55 * ((cx - r.left) / r.width), 0.3, 1);
    actions.liveNoteOn(pitch, velAt(e.clientX), tid);
    startDrag(e, (_dx, _dy, ev) => {
      const np = rows[rowAt(ev.clientY)]?.pitch;
      if (np != null && np !== pitch) { actions.liveNoteOff(pitch); pitch = np; actions.liveNoteOn(pitch, velAt(ev.clientX), tid); }
    }, () => actions.liveNoteOff(pitch));
  });
  keysCv.addEventListener('pointermove', (e) => {
    if (!cur.pat || e.buttons) return;
    const r = keysCv.getBoundingClientRect();
    const row = clamp(Math.floor((e.clientY - r.top + scroller.scrollTop) / rowH()), 0, rows.length - 1);
    const m = rows[row]?.pitch;
    if (hover?.pitch !== m) { hover = { pitch: m, beat: hover?.beat ?? 0, note: null }; drawKeys(); drawGrid(); updateStatus(); }
  });
  keysCv.addEventListener('pointerleave', () => { if (hover) { hover = null; if (cur.pat) { drawKeys(); drawGrid(); updateStatus(); } } });

  // velocity lane: drag to set / paint
  velCv.addEventListener('pointerdown', (e) => {
    if (!cur.pat) return;
    e.preventDefault();
    const r = velCv.getBoundingClientRect();
    const drag = { recorded: false };
    const P = ppb();
    let lastX = e.clientX - r.left + scroller.scrollLeft;
    const restrict = selected.size ? new Set(selected) : null;
    const apply = (cx, cy) => {
      const x = cx - r.left + scroller.scrollLeft;
      const v = clamp(1 - (cy - r.top - 4) / (r.height - 8), 0.02, 1);
      const lo = Math.min(lastX, x) - 4, hi = Math.max(lastX, x) + 4;
      lastX = x;
      const pat = proj().patterns[cur.pat.id];
      const hits = pat.notes.filter((n) => (!restrict || restrict.has(n.id)) && n.start * P >= lo && n.start * P <= hi);
      if (!hits.length) return;
      const ids = new Set(hits.map((n) => n.id));
      edit('Velocity', (pt) => { for (const n of pt.notes) if (ids.has(n.id)) n.vel = roundT(v); }, drag);
      app.setStatus?.(`Velocity ${Math.round(v * 127)}`);
    };
    apply(e.clientX, e.clientY);
    dragging = true;
    startDrag(e, (_dx, _dy, ev) => apply(ev.clientX, ev.clientY), () => { dragging = false; });
  });
  velResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const h0 = S.velH;
    startDrag(e, (_dx, dy) => { S.velH = clamp(h0 - dy, 28, 260); applyLayout(); drawAll(); }, () => save());
  });

  // ---------------------------------------------------------------- keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (!visible || !cur.pat || isTyping(e) || e.defaultPrevented) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Escape' && document.querySelector('.ctx-menu')) return; // let the open menu close first
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if ((k === 'Delete' || k === 'Backspace') && !mod) { if (selected.size) deleteSel(); else handled = false; }
    else if (mod && (k === 'a' || k === 'A')) selectAll();
    else if (mod && (k === 'c' || k === 'C') && !e.shiftKey) { if (!copySel()) handled = false; }
    else if (mod && (k === 'x' || k === 'X')) { if (copySel()) deleteSel(); else handled = false; }
    else if (mod && (k === 'v' || k === 'V')) { if (clipboard) paste(); else handled = false; }
    else if (mod && (k === 'd' || k === 'D')) { if (selected.size) duplicateRight(); else handled = false; }
    else if (k === 'Escape' && !mod) { if (selected.size) { selected.clear(); drawAll(); } else handled = false; }
    else if (!mod && (k === 'ArrowLeft' || k === 'ArrowRight') && selected.size) nudge((k === 'ArrowLeft' ? -1 : 1) * (e.altKey ? 1 / 32 : gridStep()), 0);
    else if (!mod && (k === 'ArrowUp' || k === 'ArrowDown') && selected.size) nudge(0, k === 'ArrowUp' ? 1 : -1, e.shiftKey);
    else if (!mod && !e.altKey && (k === 'q' || k === 'Q') && !app.keyboardPiano?.enabled) quantize(1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); drawAll(); }
  }, true);

  // ---------------------------------------------------------------- render cycle
  function showEmpty(kind) {
    body.classList.add('hidden');
    toolbar.classList.add('hidden');
    empty.classList.remove('hidden');
    const p = proj();
    const inst = p.tracks.filter((t) => t.type === 'instrument');
    if (kind === 'no-pattern') {
      empty.replaceChildren(h('div.empty-state',
        icon('piano', 40), h('h3', `${cur.track.name} has no pattern yet`),
        h('p', 'Patterns hold the notes a track plays. Create one to start drawing notes.'),
        button('Create pattern', () => actions.ensurePattern(cur.track.id), { icon: 'plus', primary: true })));
      return;
    }
    empty.replaceChildren(h('div.empty-state',
      icon('piano', 40), h('h3', 'Piano roll'),
      h('p', inst.length ? 'Select an instrument track to edit its notes — or add a new one.' : 'The piano roll edits the notes of an instrument track. Add a synth to start writing melodies and chords.'),
      h('div.row.wrap', { style: { justifyContent: 'center' } },
        button('Add synth', () => actions.addTrack('electric-piano'), { icon: 'plus', primary: true, title: 'Add an electric piano track and open it here' }),
        button('Add drums', () => actions.addTrack('drums'), { icon: 'drum' })),
      inst.length ? h('div.row.wrap', { style: { justifyContent: 'center' } }, inst.slice(0, 6).map((t) => button(t.name, () => actions.selectTrack(t.id), { cls: 'small', title: `Edit ${t.name}` }))) : null));
  }
  function hideEmpty() {
    body.classList.remove('hidden');
    toolbar.classList.remove('hidden');
    empty.classList.add('hidden');
  }

  function refresh() {
    cur = resolveContext();
    if (!cur.track) { showEmpty('no-track'); return; }
    if (!cur.pat) { showEmpty('no-pattern'); return; }
    hideEmpty();
    if (cur.pat.id !== lastPatId) {
      selected = new Set();
      chordCursor = null;
      lastPatId = cur.pat.id;
      lastLen = gridStep();
    } else {
      const ids = new Set(cur.pat.notes.map((n) => n.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    }
    const wasDrum = isDrum;
    buildRows();
    syncToolbar();
    updateSpacer();
    if (scrolledFor !== cur.pat.id || wasDrum !== isDrum) {
      if (scroller.clientWidth > 0) { scrolledFor = cur.pat.id; fitView(); }
    }
    drawAll();
    updateSuggestions();
  }

  let lastTheme = null;
  app.subscribe((r) => {
    if ('theme' in r.ui) lastTheme = null;
    if (!visible) return;
    if (r.project || 'selectedTrackId' in r.ui || 'selectedPatternId' in r.ui || 'theme' in r.ui) {
      if (lastTheme !== ui.get('theme')) { readColors(); lastTheme = ui.get('theme'); }
      refresh();
    }
  });

  const ro = new ResizeObserver(() => { if (visible && cur.pat) { if (scrolledFor !== cur.pat.id) refresh(); else drawAll(); } });
  ro.observe(gridWrap);
  ro.observe(keysCv);

  return {
    el,
    show() {
      visible = true;
      readColors();
      lastTheme = ui.get('theme');
      refresh();
      if (!raf) raf = requestAnimationFrame(loop);
    },
    hide() {
      visible = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      hover = null;
    },
    // geometry for collaboration overlays (src/collab/overlay.js)
    collabGeom: () => ({
      kind: 'piano', scroller, ppb: ppb(), rowH: rowH(), patternId: cur.pat?.id || null,
      rowOfPitch: (pitch) => rows.findIndex((r) => r.pitch === pitch),
      pitchAt: (y) => rows[clamp(Math.floor(y / rowH()), 0, rows.length - 1)]?.pitch ?? null,
      selected: () => [...selected],
    }),
  };
}

// ---------------------------------------------------------------- colour helpers
function parseColor(c) {
  if (!c) return [128, 128, 128];
  c = c.trim();
  if (c[0] === '#') {
    let hx = c.slice(1);
    if (hx.length === 3) hx = hx.split('').map((x) => x + x).join('');
    const n = parseInt(hx.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) return m[1].split(',').slice(0, 3).map((x) => parseFloat(x));
  return [128, 128, 128];
}
function hexA(c, a) { const [r, g, b] = parseColor(c); return `rgba(${r},${g},${b},${a})`; }
function mix(a, b, t) {
  const A = parseColor(a), B = parseColor(b);
  return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
