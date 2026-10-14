// Pocket ▸ Song: the arrangement for touch. Horizontal track lanes with clips; pinch to zoom, drag to pan.
// Tap a clip = select · drag a selected clip = move (snaps to bars) · drag its edges = trim / loop longer ·
// long-press = actions · double-tap = edit notes · tap empty space = add a clip of the track's pattern.
// Top bars: ruler (tap / drag = scrub the playhead), section markers (tap empty = add, drag = move, tap = menu),
// loop region (drag handles / body, drag empty = new loop, tap = on / off). Automation lane docked below.
import { h, icon, fitCanvas, cssVar } from '../../ui/dom.js';
import { beatsPerBar, songLengthBeats, patternsForTrack, createClip, TRACK_COLORS } from '../../core/model.js';
import { drawPatternNotes, COLOR_NAMES } from '../../ui/views/arrange.js';
import {
  RULER_H, MARK_H, LOOP_H, TOP_H, SNAP_MODES, snapStep, snapTo, laneAt, laneY, topZone, hitClip, moveStart, resizeRight, trimLeft,
  splitClip, duplicateClip, makeUnique, renameClip, colorClip, clipForTap, clipLabel, markerAt, addMarker, moveMarker, loopHit, dragLoop,
  pinchTime, fitPpb, followX0, clampY0, beatToX, xToBeat, EPS,
} from '../arrange-core.js';
import { pageShell, iconBtn, isDrums, emptyState, addTrackSheet } from './common.js';
import { actionSheet, haptic, chips, bigButton, promptSheet, confirmSheet } from '../touch.js';
import { createAutoLane, pickAutomationTarget } from '../auto-lane.js';

const LS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const SS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

export function createArrangePage(app, nav) {
  const { store, ui, actions, engine } = app;
  const get = () => store.get();
  const bpb = () => beatsPerBar(get());

  const modeBtn = iconBtn('loop', () => actions.setMode(get().mode === 'song' ? 'pattern' : 'song'), 'Song / loop', 'labeled');
  const codeBtn = iconBtn('code', () => nav.go({ page: 'code' }), 'Code');
  const moreBtn = iconBtn('menu', () => moreMenu(), 'More');
  const { el, body } = pageShell('Song', modeBtn, codeBtn, moreBtn);
  body.classList.add('pk-arr-body');

  let snapMode = LS('daw3-pocket-arr-snap', 'bar');
  let follow = LS('daw3-pocket-arr-follow', true);
  let autoOpen = LS('daw3-pocket-arr-auto', false);
  const snapChips = chips(SNAP_MODES.map((s) => ({ value: s.value, label: `⌗ ${s.label}` })), snapMode, (v) => { snapMode = v; SS('daw3-pocket-arr-snap', v); }, { cls: 'small' });
  const followBtn = h('button.pk-chip', { type: 'button', title: 'Follow the playhead' }, '▶︎ Follow');
  followBtn.addEventListener('click', () => { follow = !follow; SS('daw3-pocket-arr-follow', follow); haptic(5); syncTools(); });
  const fitBtn = h('button.pk-chip', { type: 'button' }, '↔ Fit');
  fitBtn.addEventListener('click', () => { haptic(5); fit(); });
  const autoBtn = h('button.pk-chip', { type: 'button' }, '∿ Automation');
  autoBtn.addEventListener('click', () => { autoOpen = !autoOpen; SS('daw3-pocket-arr-auto', autoOpen); haptic(5); syncTools(); layoutAuto(); });
  const tools = h('div.pk-arr-tools', { 'data-noswipe': '' }, snapChips, followBtn, fitBtn, autoBtn);
  const canvas = h('canvas.pk-arr-cv', { 'data-noswipe': '' });
  const cvWrap = h('div.pk-arr-wrap', canvas);
  const selBar = h('div.pk-arr-sel', { hidden: true });
  const autoHost = h('div.pk-arr-auto', { 'data-noswipe': '', hidden: true });
  const empty = h('div.pk-arr-empty');
  body.append(tools, cvWrap, selBar, autoHost, empty);

  let v = { ppb: 12, x0: 0, y0: 0, laneH: 60 };
  let fitted = false, visible = false, raf = 0, W = 300, H = 400;
  let selId = null;
  const step = () => snapStep(snapMode, bpb());
  const sel = () => get().clips.find((c) => c.id === selId) || null;
  const setView = (nv) => { v = { ...v, ...nv, x0: Math.max(-1, nv.x0 ?? v.x0) }; v.y0 = clampY0(v.y0, get().tracks.length, v.laneH, H); };
  const autoLane = createAutoLane(app, {
    ownerId: LS('daw3-pocket-arr-auto-owner', null), target: LS('daw3-pocket-arr-auto-target', null), height: 110,
    getView: () => v, setView: (nv) => { setView(nv); draw(); },
    getRange: () => { const c = sel(); if (c) return { b0: c.start, b1: c.start + c.length, name: 'the selected clip' }; const p = get(); if (p.loop?.enabled && p.loop.end > p.loop.start) return { b0: p.loop.start, b1: p.loop.end, name: 'the loop' }; return { b0: 0, b1: songLengthBeats(p), name: 'the whole song' }; },
    onTarget: (o, t) => { SS('daw3-pocket-arr-auto-owner', o); SS('daw3-pocket-arr-auto-target', t); },
  });
  autoHost.appendChild(autoLane.el);

  function syncTools() {
    followBtn.classList.toggle('on', follow);
    autoBtn.classList.toggle('on', autoOpen);
    const song = get().mode === 'song';
    modeBtn.classList.toggle('on', song);
    const lbl = modeBtn.querySelector('span:not(.icon)');
    if (lbl) lbl.textContent = song ? 'Song' : 'Loop';
  }
  function layoutAuto() { autoHost.hidden = !autoOpen; requestAnimationFrame(() => { draw(); autoLane.draw(); }); }
  function fit() {
    const r = canvas.getBoundingClientRect();
    const w = r.width || 340;
    setView({ ppb: fitPpb(Math.max(songLengthBeats(get()), bpb() * 4), w), x0: 0 });
    draw();
  }

  // ------------------------------------------------------------------ drawing
  function roundRect(c, x, y, w, hh, r) { r = Math.min(r, w / 2, hh / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function draw() {
    if (!visible) return;
    const r = fitCanvas(canvas);
    const c = r.ctx;
    W = r.w; H = r.h;
    const p = get();
    const B = bpb();
    c.clearRect(0, 0, W, H);
    c.fillStyle = cssVar('--bg');
    c.fillRect(0, 0, W, H);
    const b0 = xToBeat(v, 0), b1 = xToBeat(v, W);
    // bar grid (thin out when zoomed out)
    let every = 1;
    while (B * every * v.ppb < 28) every *= 2;
    for (let bar = Math.max(0, Math.floor(b0 / B / every) * every); bar * B <= b1; bar += every) {
      const x = Math.round(beatToX(v, bar * B));
      c.fillStyle = bar % (every * 4) === 0 ? cssVar('--grid-bar') : cssVar('--grid-beat');
      c.fillRect(x, TOP_H, 1, H - TOP_H);
    }
    // lanes
    p.tracks.forEach((t, i) => {
      const y = laneY(v, i);
      if (y > H || y + v.laneH < TOP_H) return;
      c.fillStyle = i % 2 ? 'rgba(128,128,128,0.05)' : 'rgba(128,128,128,0.10)';
      c.fillRect(0, y, W, v.laneH);
      c.fillStyle = 'rgba(128,128,128,0.18)';
      c.fillRect(0, y + v.laneH - 1, W, 1);
    });
    c.save();
    c.beginPath(); c.rect(0, TOP_H, W, H - TOP_H); c.clip();
    const tIdx = new Map(p.tracks.map((t, i) => [t.id, i]));
    for (const clip of p.clips) {
      const i = tIdx.get(clip.trackId);
      if (i == null) continue;
      const t = p.tracks[i];
      const x = beatToX(v, clip.start), w = clip.length * v.ppb;
      if (x > W || x + w < 0) continue;
      const y = laneY(v, i) + 3, hh = v.laneH - 6;
      if (y > H || y + hh < TOP_H) continue;
      const pat = clip.type === 'pattern' ? p.patterns[clip.patternId] : null;
      const col = pat?.color || clip.color || t.color || '#7c5cff';
      const on = clip.id === selId;
      c.globalAlpha = t.mute ? 0.4 : 1;
      c.fillStyle = col;
      c.globalAlpha *= 0.32;
      roundRect(c, x + 0.5, y, Math.max(3, w - 1), hh, 6);
      c.fill();
      c.globalAlpha = t.mute ? 0.4 : 1;
      c.strokeStyle = col;
      c.lineWidth = on ? 0 : 1;
      if (!on) c.stroke();
      // notes (pattern repeats when the clip is longer than the pattern)
      if (pat?.length > 0 && w > 6) {
        c.save();
        roundRect(c, x + 0.5, y, Math.max(3, w - 1), hh, 6); c.clip();
        const L = pat.length;
        const first = clip.start - (clip.offset || 0);
        for (let k = 0; first + k * L < clip.start + clip.length; k++) {
          const rs = first + k * L;
          if (rs + L <= clip.start) continue;
          const rx = beatToX(v, rs);
          if (rx > W) break;
          if (rx + L * v.ppb < 0) continue;
          drawPatternNotes(c, pat, { x: rx, y: y + 14, w: L * v.ppb, h: hh - 18, color: col, drums: isDrums(t), minW: 1 });
          if (k > 0 || rs > clip.start + EPS) { c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(Math.round(rx), y, 1, hh); }
        }
        c.restore();
      }
      if (w > 30) {
        c.fillStyle = cssVar('--text');
        c.font = '600 11px system-ui';
        c.fillText(clipLabel(p, clip).slice(0, Math.max(3, Math.floor(w / 7))), Math.max(x + 6, 4), y + 12);
      }
      if (on) {
        c.strokeStyle = cssVar('--text');
        c.lineWidth = 2;
        roundRect(c, x + 1, y + 1, Math.max(3, w - 2), hh - 2, 6);
        c.stroke();
        // grips
        c.fillStyle = cssVar('--text');
        roundRect(c, x + w - 9, y + hh / 2 - 12, 6, 24, 3); c.fill();
        if (w > 24) { roundRect(c, x + 3, y + hh / 2 - 12, 6, 24, 3); c.fill(); }
      }
      c.globalAlpha = 1;
    }
    // track names
    p.tracks.forEach((t, i) => {
      const y = laneY(v, i);
      if (y > H || y + v.laneH < TOP_H) return;
      c.font = '600 11px system-ui';
      const tw = Math.min(120, c.measureText(t.name).width + 16);
      c.globalAlpha = 0.85;
      c.fillStyle = cssVar('--bg-2');
      roundRect(c, 4, y + v.laneH - 20, tw, 16, 8); c.fill();
      c.globalAlpha = 1;
      c.fillStyle = t.color;
      c.beginPath(); c.arc(11, y + v.laneH - 12, 3.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = t.mute ? cssVar('--text-3') : cssVar('--text-2');
      c.fillText(t.name.slice(0, 16), 18, y + v.laneH - 8);
    });
    c.restore();
    // top bars
    c.fillStyle = cssVar('--bg-2');
    c.fillRect(0, 0, W, TOP_H);
    c.fillStyle = 'rgba(128,128,128,0.25)';
    c.fillRect(0, RULER_H, W, 1); c.fillRect(0, RULER_H + MARK_H, W, 1); c.fillRect(0, TOP_H - 1, W, 1);
    c.fillStyle = cssVar('--text-2');
    c.font = '11px system-ui';
    for (let bar = Math.max(0, Math.floor(b0 / B / every) * every); bar * B <= b1; bar += every) c.fillText(String(bar + 1), beatToX(v, bar * B) + 3, 16);
    // markers
    const ms = p.markers || [];
    for (const m of ms) {
      const x = beatToX(v, m.beat);
      if (x > W + 4) continue;
      c.fillStyle = cssVar('--accent');
      c.fillRect(x, RULER_H, 2, MARK_H + LOOP_H);
      c.font = '600 11px system-ui';
      const tw = c.measureText(m.name).width + 10;
      c.globalAlpha = 0.9;
      roundRect(c, x, RULER_H + 3, tw, MARK_H - 6, 4); c.fill();
      c.globalAlpha = 1;
      c.fillStyle = '#fff';
      c.fillText(m.name, x + 5, RULER_H + MARK_H - 8);
      c.fillStyle = 'rgba(124,92,255,0.25)';
      c.fillRect(x, TOP_H, 1, H - TOP_H);
    }
    if (!ms.length && W > 200) { c.fillStyle = cssVar('--text-3'); c.font = '11px system-ui'; c.fillText('Tap here to add a section marker', 8, RULER_H + 16); }
    // loop
    const lp = p.loop;
    if (lp && lp.end > lp.start) {
      const xs = beatToX(v, lp.start), xe = beatToX(v, lp.end);
      c.globalAlpha = lp.enabled ? 0.9 : 0.3;
      c.fillStyle = cssVar('--accent-2');
      roundRect(c, xs, RULER_H + MARK_H + 4, Math.max(4, xe - xs), LOOP_H - 8, 5); c.fill();
      c.fillStyle = cssVar('--text');
      c.fillRect(xs, RULER_H + MARK_H + 2, 3, LOOP_H - 4); c.fillRect(xe - 3, RULER_H + MARK_H + 2, 3, LOOP_H - 4);
      c.globalAlpha = lp.enabled ? 0.07 : 0;
      c.fillStyle = cssVar('--accent-2');
      c.fillRect(xs, TOP_H, xe - xs, H - TOP_H);
      c.globalAlpha = 1;
    }
    // song end
    const endX = beatToX(v, songLengthBeats(p));
    if (endX < W && p.clips.length) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(endX, TOP_H, W - endX, H - TOP_H); }
    // playhead
    const pos = engine.getPosition?.() || 0;
    const px = beatToX(v, pos);
    if (px >= -2 && px <= W + 2) {
      c.fillStyle = cssVar('--accent-2');
      c.fillRect(px - 1, 0, 2, H);
      c.beginPath(); c.moveTo(px - 7, 0); c.lineTo(px + 7, 0); c.lineTo(px, 9); c.closePath(); c.fill();
    }
  }

  const frame = () => {
    if (!visible) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    if (engine.isPlaying) {
      if (follow && !g) { const nx = followX0(v, engine.getPosition(), W); if (nx !== v.x0) v.x0 = nx; }
      draw();
      if (autoOpen) autoLane.draw();
    }
  };

  // ------------------------------------------------------------------ editing helpers
  let txStarted = false;
  const dragTx = (label, fn) => { store.transact(label, fn, txStarted ? { undo: false } : {}); txStarted = true; };
  function select(id) { selId = id; syncSel(); draw(); }
  function syncSel() {
    const c = sel();
    selBar.hidden = !c;
    if (!c) return;
    const p = get();
    const t = p.tracks.find((x) => x.id === c.trackId);
    selBar.replaceChildren(
      h('span.pk-arr-sel-name', { style: { '--tc': t?.color } }, `${clipLabel(p, c)} · bar ${Math.floor(c.start / bpb()) + 1} · ${+(c.length / bpb()).toFixed(2)} bars`),
      selBtn('pencil', 'Edit', () => editClip(c)),
      selBtn('copy', 'Duplicate', () => { let id; store.transact('Duplicate clip', (pp) => { id = duplicateClip(pp, c.id); }); select(id); }),
      selBtn('scissors', 'Split', () => splitAtPlayhead(c)),
      selBtn('trash', 'Delete', () => deleteClip(c.id)),
      selBtn('menu', 'More', () => clipMenu(c)),
    );
  }
  function selBtn(ic, label, fn) { const b = h('button.pk-ib', { type: 'button', 'aria-label': label, title: label }, icon(ic, 18)); b.addEventListener('click', () => { haptic(5); fn(); }); return b; }
  function deleteClip(id) { store.transact('Delete clip', (p) => { p.clips = p.clips.filter((c) => c.id !== id); }); if (selId === id) select(null); }
  function splitAtPlayhead(c) {
    const ph = engine.getPosition?.() || 0;
    let id = null;
    store.transact('Split clip', (p) => { id = splitClip(p, c.id, ph); });
    if (!id) app.toast('Move the playhead inside the clip to split it there (tap the ruler).', { level: 'warn' });
  }
  function editClip(c) {
    const t = get().tracks.find((x) => x.id === c.trackId);
    if (c.type === 'pattern' && get().patterns[c.patternId]) { actions.selectTrack(c.trackId); actions.selectPattern(c.patternId); nav.go({ page: 'notes' }); } else if (t) nav.go({ page: 'track', id: t.id });
  }
  function clipMenu(c) {
    const p = get();
    const t = p.tracks.find((x) => x.id === c.trackId);
    const pat = c.type === 'pattern' ? p.patterns[c.patternId] : null;
    const ph = engine.getPosition?.() || 0;
    const pats = t ? patternsForTrack(p, t.id) : [];
    select(c.id);
    actionSheet(clipLabel(p, c), [
      pat ? { label: isDrums(t) ? 'Edit beat' : 'Edit notes', icon: isDrums(t) ? 'drum' : 'piano', onClick: () => editClip(c) } : null,
      { label: 'Duplicate', icon: 'copy', onClick: () => { let id; store.transact('Duplicate clip', (pp) => { id = duplicateClip(pp, c.id); }); select(id); } },
      { label: 'Split at playhead', icon: 'scissors', disabled: !(ph > c.start + EPS && ph < c.start + c.length - EPS), onClick: () => splitAtPlayhead(c) },
      { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptSheet('Clip name', clipLabel(p, c)); if (n != null) store.transact('Rename clip', (pp) => renameClip(pp, c.id, n)); } },
      pat ? { label: 'Make unique (own copy)', icon: 'layers', onClick: () => { let np; store.transact('Make clip unique', (pp) => { np = makeUnique(pp, c.id); }); if (np) { actions.selectPattern(np, { activate: false }); app.toast('This clip has its own pattern now — edits won’t change the other clips.'); } } } : null,
      pat ? { label: 'Choose pattern', icon: 'music', submenu: [...pats.map((pt) => ({ label: pt.name, checked: pt.id === c.patternId, onClick: () => store.transact('Change clip pattern', (pp) => { const cc = pp.clips.find((x) => x.id === c.id); if (cc && pp.patterns[pt.id]) { cc.patternId = pt.id; cc.name = null; cc.offset = 0; } }) })), '-', { label: 'New empty pattern', icon: 'plus', onClick: () => { const np = actions.newPattern(c.trackId, { length: pat.length }); if (np) store.transact('Change clip pattern', (pp) => { const cc = pp.clips.find((x) => x.id === c.id); if (cc) { cc.patternId = np.id; cc.offset = 0; } }); } }] } : null,
      pat && Math.abs(c.length - pat.length) > EPS ? { label: 'Fit to pattern length', onClick: () => store.transact('Fit clip', (pp) => { const cc = pp.clips.find((x) => x.id === c.id); if (cc) { cc.length = pat.length; cc.offset = 0; } }) } : null,
      { label: 'Color', icon: 'sun', submenu: TRACK_COLORS.map((col, i) => ({ label: COLOR_NAMES[i] || col, onClick: () => store.transact('Clip color', (pp) => colorClip(pp, c.id, col)) })) },
      { label: 'Loop this clip', icon: 'loop', onClick: () => store.transact('Set loop', (pp) => { pp.loop = { ...(pp.loop || {}), start: c.start, end: c.start + c.length, enabled: true }; }) },
      { label: 'Automate…', icon: 'sliders', onClick: () => { pickAutomationTarget(app, { ownerId: c.trackId, onPick: (o, tg) => { autoLane.setTarget(o, tg); autoOpen = true; SS('daw3-pocket-arr-auto', true); syncTools(); layoutAuto(); } }); } },
      '-',
      { label: 'Delete clip', icon: 'trash', onClick: () => deleteClip(c.id) },
    ].filter(Boolean));
  }
  function laneMenu(t, beat) {
    const p = get();
    actionSheet(t.name, [
      { label: 'Open track', icon: 'sliders', onClick: () => nav.go({ page: 'track', id: t.id }) },
      t.type === 'instrument' ? { label: 'Add a clip here', icon: 'plus', onClick: () => addClipAt(t, beat) } : null,
      t.type === 'instrument' ? { label: 'Generate a part', icon: 'dice', submenu: (isDrums(t) ? ['drums'] : ['lead', 'bass', 'chords', 'arp', 'pad']).map((r) => ({ label: r[0].toUpperCase() + r.slice(1), onClick: () => actions.generatePart(r, { trackId: t.id }) })) } : null,
      { label: 'Automate…', icon: 'sliders', onClick: () => pickAutomationTarget(app, { ownerId: t.id, onPick: (o, tg) => { autoLane.setTarget(o, tg); autoOpen = true; SS('daw3-pocket-arr-auto', true); syncTools(); layoutAuto(); } }) },
      { label: t.mute ? 'Unmute' : 'Mute', icon: 'mute', onClick: () => actions.updateTrack(t.id, (tt) => { tt.mute = !tt.mute; }, 'Mute') },
      { label: 'Add section marker here', icon: 'timeline', onClick: () => store.transact('Add marker', (pp) => addMarker(pp, snapTo(beat, bpb(), Math.floor))) },
      p.tracks.length ? { label: 'Delete track…', icon: 'trash', onClick: async () => { if (await confirmSheet('Delete track?', `Delete “${t.name}” and its clips?`, 'Delete')) actions.deleteTrack(t.id); } } : null,
    ].filter(Boolean));
  }
  function addClipAt(t, beat) {
    if (t.type !== 'instrument') { app.toast('Audio / code tracks: record or edit them on their track page.'); return; }
    const pat = actions.ensurePattern(t.id);
    if (!pat) return;
    const p = get();
    const clip = clipForTap(p, t.id, beat, step() || 1, t.activePatternId && p.patterns[t.activePatternId] ? t.activePatternId : pat.id);
    if (!clip) return;
    store.transact('Add clip', (pp) => { pp.clips.push(clip); if (pp.mode !== 'song' && pp.clips.length === 1) pp.mode = 'song'; });
    haptic(8);
    select(clip.id);
  }
  function markerMenu(m) {
    const p = get();
    const ms = [...(p.markers || [])].sort((a, b) => a.beat - b.beat);
    const next = ms[ms.indexOf(ms.find((x) => x.id === m.id)) + 1];
    const end = next?.beat ?? Math.max(songLengthBeats(p), m.beat + bpb());
    actionSheet(m.name, [
      { label: 'Play from here', icon: 'play', onClick: () => { actions.setPosition(m.beat); actions.play(); } },
      { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptSheet('Section name', m.name); if (n) store.transact('Rename marker', (pp) => { const mm = pp.markers.find((x) => x.id === m.id); if (mm) mm.name = n; }); } },
      { label: 'Loop this section', icon: 'loop', onClick: () => store.transact('Set loop', (pp) => { pp.loop = { ...(pp.loop || {}), start: m.beat, end, enabled: true }; }) },
      { label: 'Extend this section', icon: 'wand', onClick: () => actions.extendSongBy({ mode: 'insert-section', templateMarkerId: m.id, markerId: next?.id, at: next ? undefined : end, bars: Math.max(4, Math.round((end - m.beat) / bpb())) }) },
      { label: 'Remove section (close the gap)', icon: 'scissors', onClick: () => actions.removeSectionAt(m.id) },
      '-',
      { label: 'Delete marker', icon: 'trash', onClick: () => store.transact('Delete marker', (pp) => { pp.markers = (pp.markers || []).filter((x) => x.id !== m.id); }) },
    ]);
  }

  function moreMenu() {
    const p = get();
    actionSheet('Song', [
      { label: 'Generate a new song', icon: 'wand', onClick: () => nav.go({ page: 'home' }) },
      { label: 'Extend the song', icon: 'plus', submenu: [
        { label: '+16 bars', onClick: () => actions.extendSongBy({ mode: 'continue', bars: 16 }) },
        { label: '+32 bars', onClick: () => actions.extendSongBy({ mode: 'continue', bars: 32 }) },
        { label: '+1 minute', onClick: () => actions.extendSongBy({ mode: 'continue', minutes: 1 }) },
        { label: 'to 3 minutes', onClick: () => actions.extendSongBy({ mode: 'continue', toMinutes: 3 }) },
        { label: 'Insert a breakdown at the playhead', onClick: () => actions.extendSongBy({ mode: 'insert-section', at: snapTo(engine.getPosition?.() || 0, bpb(), Math.round), bars: 8, kind: 'break' }) },
      ] },
      { label: 'Clips from the current patterns (8 bars)', icon: 'layers', disabled: !p.tracks.length, onClick: () => clipsFromActive(8) },
      { label: 'Add section marker at the playhead', icon: 'timeline', onClick: () => store.transact('Add marker', (pp) => addMarker(pp, snapTo(engine.getPosition?.() || 0, bpb(), Math.round))) },
      { label: p.loop?.enabled ? 'Loop: on (tap to turn off)' : 'Loop: off (tap to turn on)', icon: 'loop', onClick: () => store.transact('Toggle loop', (pp) => { pp.loop.enabled = !pp.loop.enabled; }) },
      { label: 'Automation lane…', icon: 'sliders', onClick: () => pickAutomationTarget(app, { ownerId: ui.get('selectedTrackId'), onPick: (o, tg) => { autoLane.setTarget(o, tg); autoOpen = true; SS('daw3-pocket-arr-auto', true); syncTools(); layoutAuto(); } }) },
      { label: 'Lane height', icon: 'sliders', submenu: [[44, 'Small'], [60, 'Medium'], [84, 'Large']].map(([lh, l]) => ({ label: l, checked: v.laneH === lh, onClick: () => { setView({ laneH: lh }); SS('daw3-pocket-arr-laneh', lh); draw(); } })) },
      { label: 'Strudel code of the song', icon: 'code', onClick: () => nav.go({ page: 'code' }) },
      '-',
      { label: 'Clear arrangement…', icon: 'trash', disabled: !p.clips.length, onClick: async () => { if (await confirmSheet('Clear arrangement', 'Remove every clip from the timeline? Patterns and tracks stay.', 'Clear')) { store.transact('Clear arrangement', (pp) => { pp.clips = []; }); select(null); } } },
    ]);
  }
  function clipsFromActive(bars) {
    const p = get();
    const start = p.clips.length ? songLengthBeats(p) : 0;
    store.transact('Clips from active patterns', (pp) => {
      for (const t of pp.tracks) {
        const pat = pp.patterns[t.activePatternId];
        if (!pat) continue;
        pp.clips.push(createClip(t.id, { patternId: pat.id, start, length: bars * bpb() }));
      }
      pp.mode = 'song';
    });
  }

  // ------------------------------------------------------------------ gestures
  const ptrs = new Map();
  let g = null, lastTap = { t: 0, id: null };
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) {
      clearTimeout(g?.lp);
      const [a, b] = [...ptrs.values()];
      g = { type: 'pinch', xs: [a.x, b.x], v0: { ...v } };
      return;
    }
    if (ptrs.size > 2) return;
    txStarted = false;
    const proj = get();
    const zone = topZone(p.y);
    const base = { x: p.x, y: p.y, v0: { ...v }, moved: false, beat: xToBeat(v, p.x) };
    if (zone === 'ruler') { g = { ...base, type: 'scrub' }; actions.setPosition(Math.max(0, snapTo(base.beat, step() ? 1 : 0))); draw(); return; }
    if (zone === 'markers') {
      const m = markerAt(proj.markers, v, p.x);
      g = { ...base, type: m ? 'marker' : 'marker-new', marker: m ? { ...m } : null };
      if (m) g.lp = setTimeout(() => { if (g && !g.moved) { haptic(15); const mm = g.marker; g = null; markerMenu(mm); } }, 480);
      return;
    }
    if (zone === 'loop') { const which = loopHit(proj.loop, v, p.x); g = { ...base, type: 'loop', which: which || 'new', loop0: { ...proj.loop } }; return; }
    const hit = hitClip(proj, v, p.x, p.y);
    const ti = laneAt(v, p.y, proj.tracks.length);
    g = { ...base, type: hit ? 'clip' : 'empty', hit, ti, clip0: hit ? { ...hit.clip } : null };
    g.lp = setTimeout(() => {
      if (!g || g.moved || g.type === 'pinch') return;
      haptic(15);
      const gg = g;
      g = null;
      if (gg.hit) clipMenu(gg.hit.clip);
      else if (gg.ti >= 0) laneMenu(proj.tracks[gg.ti], gg.beat);
    }, 480);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e);
    ptrs.set(e.pointerId, p);
    if (!g) return;
    if (g.type === 'pinch') {
      if (ptrs.size < 2) return;
      const [a, b] = [...ptrs.values()];
      setView(pinchTime(g.v0, g.xs, [a.x, b.x]));
      draw();
      if (autoOpen) autoLane.draw();
      return;
    }
    const dx = p.x - g.x, dy = p.y - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 8) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.lp); }
    const db = dx / v.ppb;
    const st = step();
    if (g.type === 'scrub') { actions.setPosition(Math.max(0, xToBeat(v, p.x))); draw(); return; }
    if (g.type === 'marker') { dragTx('Move marker', (pp) => moveMarker(pp, g.marker.id, snapTo(g.marker.beat + db, st))); draw(); return; }
    if (g.type === 'loop') {
      const lp = dragLoop(g.loop0, g.which, db, st || 1, g.beat);
      dragTx('Set loop', (pp) => { pp.loop = { ...(pp.loop || {}), start: lp.start, end: lp.end, enabled: true }; });
      draw();
      return;
    }
    const c = g.clip0;
    if (g.type === 'clip' && c && c.id === selId) {
      if (g.hit.zone === 'right') {
        const len = resizeRight(c, db, st);
        dragTx('Resize clip', (pp) => { const cc = pp.clips.find((x) => x.id === c.id); if (cc) cc.length = len; });
      } else if (g.hit.zone === 'left') {
        const r = trimLeft(c, db, st, { patternLength: get().patterns[c.patternId]?.length || 0 });
        dragTx('Trim clip', (pp) => { const cc = pp.clips.find((x) => x.id === c.id); if (cc) Object.assign(cc, r); });
      } else {
        const s = moveStart(c.start, db, st);
        dragTx('Move clip', (pp) => { const cc = pp.clips.find((x) => x.id === c.id); if (cc) cc.start = s; });
      }
      syncSel();
      draw();
      return;
    }
    // pan (both axes)
    g.type = 'pan';
    setView({ x0: g.v0.x0 - dx / v.ppb, y0: g.v0.y0 - dy });
    draw();
    if (autoOpen) autoLane.draw();
  });
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (!g) return;
    clearTimeout(g.lp);
    if (g.type === 'pinch') { if (!ptrs.size) g = null; return; }
    const gg = g;
    g = null;
    if (e.type === 'pointercancel') return;
    if (gg.moved) { if (gg.type === 'clip' || gg.type === 'marker' || gg.type === 'loop') haptic(6); return; }
    const proj = get();
    if (gg.type === 'marker') { markerMenu(gg.marker); return; }
    if (gg.type === 'marker-new') {
      store.transact('Add marker', (pp) => addMarker(pp, snapTo(gg.beat, bpb(), Math.floor)));
      haptic(8);
      app.toast('Section marker added — tap it to rename, drag to move.');
      return;
    }
    if (gg.type === 'loop') { store.transact('Toggle loop', (pp) => { pp.loop.enabled = !pp.loop.enabled; }); haptic(6); return; }
    if (gg.type === 'clip') {
      const now = performance.now();
      if (lastTap.id === gg.hit.clip.id && now - lastTap.t < 320) { editClip(gg.hit.clip); lastTap = { t: 0, id: null }; return; }
      lastTap = { t: now, id: gg.hit.clip.id };
      haptic(5);
      select(gg.hit.clip.id);
      return;
    }
    if (gg.type === 'empty') {
      if (selId) { select(null); return; }
      if (gg.ti >= 0) addClipAt(proj.tracks[gg.ti], gg.beat);
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (e.ctrlKey) setView(pinchTime(v, [0, 100], [0, 100 * Math.exp(-e.deltaY / 200)])); else setView({ x0: v.x0 + e.deltaX / v.ppb, y0: v.y0 + e.deltaY }); draw(); }, { passive: false });

  // ------------------------------------------------------------------ state
  function render() {
    const p = get();
    syncTools();
    if (selId && !sel()) selId = null;
    syncSel();
    empty.replaceChildren();
    cvWrap.hidden = !p.tracks.length;
    tools.hidden = !p.tracks.length;
    if (!p.tracks.length) {
      empty.appendChild(emptyState('No song yet', 'Generate one on the Create page, or add a track and tap the timeline to place clips.',
        bigButton('Generate a song', () => nav.go({ page: 'home' }), { ic: 'wand', cls: 'primary' }), bigButton('Add a track', () => addTrackSheet(app), { ic: 'plus' })));
    } else if (!p.clips.length) {
      empty.appendChild(h('div.pk-row', bigButton('Clips from the current patterns', () => clipsFromActive(8), { ic: 'layers', cls: 'primary' })));
    }
    draw();
  }
  app.subscribe(() => { if (visible) render(); });
  return {
    el,
    show() {
      visible = true;
      setView({ laneH: LS('daw3-pocket-arr-laneh', 60) });
      layoutAuto();
      requestAnimationFrame(() => { if (!fitted && get().clips.length) { fitted = true; fit(); } render(); });
      render();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    hide() { visible = false; },
  };
}
