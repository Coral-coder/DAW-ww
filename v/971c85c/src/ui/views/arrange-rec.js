// Arrange view: recording + comping + pro audio-clip editing (kept out of arrange.js; it calls in through a few hooks).
//
//   take lanes      rows under a track (toggle "T" in the header): every take of every pass; the parts the comp uses
//                   are lit. Drag across a take = swipe its region into the comp; click = use this take for the comp
//                   section under the pointer (quick swipe); Alt-click = audition the take from there; double-click =
//                   use the whole take; right-click = audition / promote / delete / crossfade length / flatten.
//   comp            drawn in the track lane itself (what plays), boundaries marked with their crossfades.
//   clip handles    selected audio clips show fade-in / fade-out handles (top corners; right-click for the curve) and
//                   a clip-gain line (drag up / down; Shift-click adds a gain-envelope point, Alt-click removes one).
//   slip            Alt-drag inside an audio clip's waveform moves the audio inside the clip.
//   punch           Shift-drag in the loop lane draws the punch-in / punch-out range (red); right-click for options.
//   ripple          toolbar toggle: deleting closes the gap, lengthening / shortening a clip moves what follows.
import { h, icon, startDrag } from '../dom.js';
import { contextMenu, toast } from '../components.js';
import { clamp, deepClone } from '../../core/util.js';
import { beatsPerBar } from '../../core/model.js';
import {
  hasTakes, setCompRange, promoteTake, deleteTake, compClips, compTakeAt, findTake, takeEnd, DEFAULT_XFADE_MS,
} from '../../record/takes.js';
import { envAt, slipOffset, rippleDelete, nearestZeroCrossing, FADE_SHAPES, fadeCurve } from '../../record/clips.js';
import { listInputSources, DEFAULT_SOURCE, trackChannels } from '../../record/inputs.js';

const EPS = 1e-6;
const SHAPE_NAMES = { lin: 'Linear', exp: 'Exponential', log: 'Logarithmic', s: 'S-curve', eqp: 'Equal power' };
const DB_MIN = -48, DB_MAX = 12;
const gainToNorm = (g) => clamp(((g > 1e-5 ? 20 * Math.log10(g) : DB_MIN) - DB_MIN) / (DB_MAX - DB_MIN), 0, 1);
const normToGain = (n) => { const db = DB_MIN + clamp(n, 0, 1) * (DB_MAX - DB_MIN); return db <= DB_MIN + 0.01 ? 0 : Math.pow(10, db / 20); };
const fmtDb = (g) => (g <= 0 ? '−∞ dB' : `${(20 * Math.log10(g)) >= 0 ? '+' : ''}${(20 * Math.log10(g)).toFixed(1)} dB`);
const loadSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
const saveSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch { /* */ } };

/**
 * api (from arrange.js): { app, get, ppb(), laneH(), scroller, theme(), invalidate(), relayout(), snapB(b, ev, fn),
 *   setSel(ids), selIds(), pos(), dragTx(label), beginDrag(), endDrag(), drawAudioClip, drawPatternClip, rgba, hexToRgb }
 */
export function createArrangeRec(api) {
  const { app, get } = api;
  const { store, ui } = app;
  const rec = () => app.rec;
  const open = loadSet('daw3-arrange-takes');
  let ripple = (() => { try { return localStorage.getItem('daw3-ripple') === '1'; } catch { return false; } })();
  let zeroSnap = (() => { try { return localStorage.getItem('daw3-zero-snap') === '1'; } catch { return false; } })();
  const takeH = () => clamp(Math.round(api.laneH() * 0.75), 28, 96);
  const trackById = (id) => get().tracks.find((t) => t.id === id);

  // ------------------------------------------------------------------------------------------- layout
  /** Add the take rows of a track after its lane (arrange rowsLayout). */
  function pushTakes(r, t, y) {
    r.takes = [];
    if (!open.has(t.id) || !hasTakes(t)) return y;
    const th = takeH();
    t.takeLanes.forEach((lane, idx) => { r.takes.push({ lane, idx, y, h: th }); y += th; });
    return y;
  }
  function setOpen(trackId, on = !open.has(trackId)) {
    if (on) open.add(trackId); else open.delete(trackId);
    saveSet('daw3-arrange-takes', open);
    api.relayout();
  }
  // new takes open their track's lanes
  let lastTakeSig = '';
  function autoOpenNew(p) {
    const sig = p.tracks.map((t) => (t.takeLanes ? `${t.id}:${t.takeLanes.length}` : '')).join(',');
    if (sig === lastTakeSig) return;
    const before = new Map(lastTakeSig.split(',').filter(Boolean).map((x) => x.split(':')));
    lastTakeSig = sig;
    let changed = false;
    for (const t of p.tracks) {
      const n = t.takeLanes?.length || 0;
      if (n > Number(before.get(t.id) || 0) && n > 1 && !open.has(t.id)) { open.add(t.id); changed = true; }
    }
    if (changed) saveSet('daw3-arrange-takes', open);
  }

  // ------------------------------------------------------------------------------------------- drawing
  function drawTakeRow(ctx, p, t, row, y, W, sx, b0, b1) {
    const th = api.theme();
    const ppb = api.ppb();
    const rgb = api.hexToRgb(t.color || '#8a93a8');
    const H = row.h;
    ctx.fillStyle = th.autoBg;
    ctx.fillRect(0, y, W, H);
    ctx.fillStyle = th.autoLine;
    ctx.fillRect(0, y, W, 1);
    const aud = rec()?.auditionPos?.();
    for (const take of row.lane.takes) {
      const x0 = take.start * ppb - sx, x1 = takeEnd(take) * ppb - sx;
      if (x1 < -2 || x0 > W + 2 || take.start > b1 || takeEnd(take) < b0) continue;
      const by = y + 3, bh = H - 6;
      ctx.fillStyle = api.rgba(rgb, 0.1);
      ctx.fillRect(x0, by, x1 - x0, bh);
      // the parts of this take the comp plays
      for (const s of t.comp || []) {
        if (s.takeId !== take.id) continue;
        ctx.fillStyle = api.rgba(rgb, th.dark ? 0.42 : 0.5);
        ctx.fillRect(s.start * ppb - sx, by, (s.end - s.start) * ppb, bh);
      }
      const ink = api.rgba(th.dark ? [235, 238, 245] : [20, 24, 32], 0.75);
      const clipLike = { type: take.sampleId ? 'audio' : 'pattern', sampleId: take.sampleId, patternId: take.patternId, start: take.start, length: take.length, offset: take.offset, gain: take.gain ?? 1 };
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(0, x0), by, Math.min(W, x1) - Math.max(0, x0), bh);
      ctx.clip();
      const labH = bh >= 30 ? 12 : 0;
      if (take.sampleId) api.drawAudioClip(ctx, p, clipLike, x0, by + labH, bh - labH, W, sx, ink);
      else if (p.patterns[take.patternId]) api.drawPatternClip(ctx, clipLike, p.patterns[take.patternId], t, x0, by + labH, bh - labH, sx, b0, b1, ink, rgb);
      ctx.restore();
      ctx.strokeStyle = api.rgba(rgb, 0.7);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, by + 0.5, x1 - x0 - 1, bh - 1);
      ctx.font = `600 10px ${th.font}`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = th.text2;
      const lx = Math.max(x0, 0) + 4;
      if (x1 - lx > 30) ctx.fillText(`${take.name || 'Take'}${aud?.takeId === take.id ? '  ▶' : ''}`, lx, by + 1, x1 - lx - 4);
      if (aud?.takeId === take.id) {
        const ax = aud.beat * ppb - sx;
        ctx.fillStyle = th.accent2;
        ctx.fillRect(ax, by, 2, bh);
      }
    }
    // comp boundaries (thin lines across the row)
    ctx.fillStyle = api.rgba([255, 255, 255], 0.18);
    for (const s of t.comp || []) { const x = s.start * ppb - sx; if (x > 0 && x < W) ctx.fillRect(Math.round(x), y + 1, 1, H - 2); }
  }

  /** Comp clips of a track (drawn in its lane like clips, not selectable). */
  const compFor = (p, t) => (t.comp?.length && t.takeLanes?.length ? compClips(p, t) : []);

  /** Crossfade marks at comp boundaries (in the track lane). */
  function drawCompMarks(ctx, p, t, laneY, W, sx) {
    const cc = compFor(p, t);
    if (!cc.length) return;
    const ppb = api.ppb();
    const lh = api.laneH();
    ctx.save();
    ctx.strokeStyle = api.rgba([255, 255, 255], 0.75);
    ctx.lineWidth = 1;
    for (const c of cc) {
      if (!(c.fadeIn > 0)) continue;
      const xa = c.start * ppb - sx, xb = (c.start + c.fadeIn) * ppb - sx;
      if (xb < 0 || xa > W) continue;
      const w = Math.max(6, xb - xa), xm = (xa + xb) / 2;
      ctx.beginPath();
      ctx.moveTo(xm - w / 2, laneY + 3); ctx.lineTo(xm + w / 2, laneY + lh - 4);
      ctx.moveTo(xm + w / 2, laneY + 3); ctx.lineTo(xm - w / 2, laneY + lh - 4);
      ctx.stroke();
    }
    // a "comp" tag at the comp's start
    const a = Math.min(...cc.map((c) => c.start)) * ppb - sx;
    if (a > -40 && a < W) {
      ctx.font = `700 9px ${api.theme().font}`;
      ctx.fillStyle = api.theme().accent2;
      ctx.textBaseline = 'bottom';
      ctx.fillText(`COMP · ${cc.length} part${cc.length > 1 ? 's' : ''}`, Math.max(a, 0) + 4, laneY + lh - 4);
    }
    ctx.restore();
  }

  // clip handle geometry (selected audio clips)
  function geom(c, laneY) {
    const ppb = api.ppb(), sx = api.scroller.scrollLeft, sy = api.scroller.scrollTop;
    const hh = api.laneH() - 5;
    const headH = hh >= 30 ? 14 : 0;
    const x = c.start * ppb - sx, w = c.length * ppb;
    const y = laneY - sy + 2;
    const cy = y + headH + 2, ch = hh - headH - 4;
    return { x, w, y, hh, headH, cy, ch, ppb };
  }
  const gainY = (g, cy, ch) => cy + (1 - gainToNorm(g)) * ch;

  /** Fade shading + handles + gain line / envelope on an audio clip (called by drawClip). */
  function drawClipOverlay(ctx, c, x, y, w, hh, selected) {
    if (c.type !== 'audio' || c.comp) return;
    const ppb = api.ppb();
    const headH = hh >= 30 ? 14 : 0;
    const cy = y + headH + 2, ch = hh - headH - 4;
    const fi = (c.fadeIn || 0) * ppb, fo = (c.fadeOut || 0) * ppb;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    const curve = (x0, x1, shape, rising) => {
      ctx.beginPath();
      ctx.moveTo(x0, rising ? cy + ch : cy);
      for (let k = 0; k <= 16; k++) {
        const u = k / 16;
        const v = fadeCurve(shape, rising ? u : 1 - u);
        ctx.lineTo(x0 + (x1 - x0) * u, cy + (1 - v) * ch);
      }
      ctx.lineTo(rising ? x0 : x1, cy);
      ctx.closePath();
      ctx.fill();
    };
    if (fi > 1) curve(x, x + fi, c.fadeInShape, true);
    if (fo > 1) curve(x + w - fo, x + w, c.fadeOutShape, false);
    if (selected && ch > 10) {
      // gain line (clip gain × envelope)
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const env = c.gainEnv || [];
      const xs = [0, ...env.map((q) => q.beat * ppb), w].filter((v) => v >= 0 && v <= w).sort((a, b) => a - b);
      xs.forEach((xx, i) => { const g = (c.gain ?? 1) * envAt(env, xx / ppb); const yy = gainY(g, cy, ch); if (i) ctx.lineTo(x + xx, yy); else ctx.moveTo(x + xx, yy); });
      ctx.stroke();
      ctx.fillStyle = '#ffd43b';
      for (const q of env) { const yy = gainY((c.gain ?? 1) * q.gain, cy, ch); ctx.beginPath(); ctx.arc(x + q.beat * ppb, yy, 3.5, 0, Math.PI * 2); ctx.fill(); }
      // fade handles
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      for (const hx of [x + fi, x + w - fo]) { ctx.fillRect(hx - 4, cy - 1, 8, 8); ctx.strokeRect(hx - 4 + 0.5, cy - 0.5, 7, 7); }
      if (ch > 18) {
        ctx.font = `600 9.5px ${api.theme().font}`;
        ctx.fillStyle = '#ffd43b';
        ctx.textBaseline = 'bottom';
        ctx.fillText(fmtDb(c.gain ?? 1), Math.max(x, 0) + 6, gainY(c.gain ?? 1, cy, ch) - 2);
      }
    }
    ctx.restore();
  }

  /** Which handle of a selected audio clip is under (contentX, contentY)? 'fadeIn' | 'fadeOut' | 'gain' | {env: i} | null */
  function clipHandleAt(c, hitX, hitY, laneY) {
    if (!c || c.type !== 'audio' || !api.selIds().includes(c.id)) return null;
    const ppb = api.ppb();
    const hh = api.laneH() - 5;
    if (hh < 24) return null;
    const headH = hh >= 30 ? 14 : 0;
    const y = laneY + 2, cy = y + headH + 2, ch = hh - headH - 4;
    const x = c.start * ppb, w = c.length * ppb;
    const fi = (c.fadeIn || 0) * ppb, fo = (c.fadeOut || 0) * ppb;
    if (hitY >= cy - 3 && hitY <= cy + 10) {
      if (Math.abs(hitX - (x + fi)) <= 6) return 'fadeIn';
      if (Math.abs(hitX - (x + w - fo)) <= 6) return 'fadeOut';
    }
    const env = c.gainEnv || [];
    for (let i = 0; i < env.length; i++) {
      const px = x + env[i].beat * ppb, py = gainY((c.gain ?? 1) * env[i].gain, cy, ch);
      if (Math.abs(hitX - px) <= 6 && Math.abs(hitY - py) <= 6) return { env: i };
    }
    const g = (c.gain ?? 1) * envAt(env, (hitX - x) / ppb);
    if (hitY > cy && Math.abs(hitY - gainY(g, cy, ch)) <= 4) return 'gain';
    return null;
  }

  function startHandleDrag(e, clip, kind, laneY) {
    const ppb = api.ppb();
    const hh = api.laneH() - 5;
    const headH = hh >= 30 ? 14 : 0;
    const ch = hh - headH - 4;
    const c0 = deepClone(clip);
    const edit = (label, fn) => api.dragTx(label);
    const show = (t) => app.setStatus?.(t);
    if (kind === 'gain' && e.shiftKey) {
      // add an envelope point
      const tb = clamp((api.hitBeat(e) - clip.start), 0, clip.length);
      store.transact('Gain envelope point', (pp) => {
        const c = pp.clips.find((x) => x.id === clip.id);
        if (!c) return;
        const env = c.gainEnv?.length ? c.gainEnv : [{ beat: 0, gain: 1 }, { beat: +c.length.toFixed(6), gain: 1 }];
        env.push({ beat: +tb.toFixed(6), gain: envAt(env, tb) });
        env.sort((a, b) => a.beat - b.beat);
        c.gainEnv = env;
      });
      return;
    }
    if (kind?.env != null && e.altKey) {
      store.transact('Gain envelope point', (pp) => {
        const c = pp.clips.find((x) => x.id === clip.id);
        if (!c?.gainEnv) return;
        c.gainEnv.splice(kind.env, 1);
        if (c.gainEnv.length < 2) delete c.gainEnv;
      });
      return;
    }
    const tx = edit(kind === 'fadeIn' ? 'Fade in' : kind === 'fadeOut' ? 'Fade out' : kind === 'gain' ? 'Clip gain' : 'Gain envelope');
    api.beginDrag();
    startDrag(e, (dx, dy, ev) => {
      tx((pp) => {
        const c = pp.clips.find((x) => x.id === clip.id);
        if (!c) return;
        if (kind === 'fadeIn') {
          c.fadeIn = +clamp((c0.fadeIn || 0) + dx / ppb, 0, c.length - (c.fadeOut || 0)).toFixed(6);
          if (!c.fadeIn) { delete c.fadeIn; delete c.fadeInShape; }
          show(`Fade in: ${((c.fadeIn || 0) * 60 / pp.bpm * 1000).toFixed(0)} ms`);
        } else if (kind === 'fadeOut') {
          c.fadeOut = +clamp((c0.fadeOut || 0) - dx / ppb, 0, c.length - (c.fadeIn || 0)).toFixed(6);
          if (!c.fadeOut) { delete c.fadeOut; delete c.fadeOutShape; }
          show(`Fade out: ${((c.fadeOut || 0) * 60 / pp.bpm * 1000).toFixed(0)} ms`);
        } else if (kind === 'gain') {
          const fine = ev.shiftKey ? 0.25 : 1;
          c.gain = +normToGain(gainToNorm(c0.gain ?? 1) - (dy * fine) / Math.max(20, ch)).toFixed(5);
          show(`Clip gain: ${fmtDb(c.gain)}`);
        } else if (kind?.env != null && c.gainEnv?.[kind.env]) {
          const q0 = c0.gainEnv[kind.env];
          const q = c.gainEnv[kind.env];
          const lo = kind.env > 0 ? c.gainEnv[kind.env - 1].beat : 0, hi = kind.env + 1 < c.gainEnv.length ? c.gainEnv[kind.env + 1].beat : c.length;
          q.beat = +clamp(q0.beat + dx / ppb, lo, hi).toFixed(6);
          const g = normToGain(gainToNorm((c0.gain ?? 1) * q0.gain) - dy / Math.max(20, ch));
          q.gain = +clamp(g / Math.max(1e-5, c.gain ?? 1), 0, 4).toFixed(5);
          show(`Envelope: ${fmtDb((c.gain ?? 1) * q.gain)}`);
        }
      });
      void laneY;
    }, () => api.endDrag());
  }

  /** Alt-drag in an audio clip's body: slip the audio inside it. */
  function startSlip(e, clip) {
    const p = get();
    const smp = p.samples?.[clip.sampleId];
    const spb = 60 / p.bpm;
    const srcLen = smp?.duration ? smp.duration / spb : Infinity;
    const off0 = clip.offset || 0;
    const tx = api.dragTx('Slip audio');
    api.beginDrag();
    startDrag(e, (dx, _dy, ev) => {
      let d = dx / api.ppb();
      if (!(ev.ctrlKey || ev.metaKey)) { const s = api.snapStep?.() || 0; if (s && s < 1) d = Math.round(d / s) * s; }
      tx((pp) => { const c = pp.clips.find((x) => x.id === clip.id); if (c) c.offset = slipOffset({ offset: off0, length: c.length }, d, srcLen); });
      app.setStatus?.(`Slip: audio moved ${d >= 0 ? '+' : ''}${d.toFixed(3)} beats inside the clip (Ctrl: free)`);
    }, () => api.endDrag());
  }

  // ------------------------------------------------------------------------------------------- takes interaction
  function takeAt(row, beat) {
    return row.lane.takes.find((k) => beat >= k.start - EPS && beat < takeEnd(k) + EPS) || null;
  }
  function editTrack(trackId, label, fn, opts) {
    store.transact(label, (pp) => { const t = pp.tracks.find((x) => x.id === trackId); if (t) fn(t, pp); }, opts);
  }

  /** pointerdown in a take row */
  function takePointerDown(e, hit) {
    const t = hit.track, row = hit.takeRow;
    const take = takeAt(row, hit.beat);
    if (!take) return;
    if (e.altKey) { rec()?.auditionTake(t.id, take.id, hit.beat); return; }
    const comp0 = deepClone(t.comp || []);
    const a = api.snapB(hit.beat, e);
    let moved = false;
    const tx = api.dragTx('Comp');
    api.beginDrag();
    startDrag(e, (dx, _dy, ev) => {
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      const b = api.snapB(hit.beat + dx / api.ppb(), ev);
      tx((pp) => {
        const tt = pp.tracks.find((x) => x.id === t.id);
        if (!tt) return;
        tt.comp = deepClone(comp0);
        setCompRange(tt, take.id, Math.min(a, b), Math.max(a, b));
      });
      app.setStatus?.(`Comp: ${take.name || 'take'} from ${fmtPos(Math.min(a, b))} to ${fmtPos(Math.max(a, b))}`);
    }, () => {
      api.endDrag();
      if (moved) return;
      // quick swipe: this take for the comp section under the pointer
      const seg = (t.comp || []).find((s) => hit.beat >= s.start - EPS && hit.beat < s.end - EPS);
      editTrack(t.id, 'Comp', (tt) => { if (seg) setCompRange(tt, take.id, seg.start, seg.end); else promoteTake(tt, take.id); });
    });
  }
  const fmtPos = (b) => { const bpb = beatsPerBar(get()); return `${Math.floor(b / bpb) + 1}.${+((b % bpb) + 1).toFixed(2)}`; };

  function takeDblClick(hit) {
    const take = takeAt(hit.takeRow, hit.beat);
    if (take) editTrack(hit.track.id, 'Promote take', (tt) => promoteTake(tt, take.id));
  }

  function takeMenu(hit) {
    const t = hit.track;
    const take = takeAt(hit.takeRow, hit.beat);
    const using = compTakeAt(t, hit.beat);
    const xf = t.compXfade ?? DEFAULT_XFADE_MS;
    const items = [{ header: take ? `${take.name || 'Take'} · lane ${hit.takeRow.idx + 1}` : `Take lane ${hit.takeRow.idx + 1}` }];
    if (take) {
      items.push(
        take.sampleId ? { label: 'Audition from here', icon: 'play', shortcut: 'Alt+click', onClick: () => rec()?.auditionTake(t.id, take.id, hit.beat) } : null,
        rec()?.auditionPos?.() ? { label: 'Stop audition', icon: 'stop', onClick: () => rec()?.stopAudition() } : null,
        { label: 'Use this take for this comp section', icon: 'music', disabled: using === take.id, onClick: () => { const seg = (t.comp || []).find((s) => hit.beat >= s.start && hit.beat < s.end); editTrack(t.id, 'Comp', (tt) => (seg ? setCompRange(tt, take.id, seg.start, seg.end) : promoteTake(tt, take.id))); } },
        { label: 'Promote: use the whole take', icon: 'layers', shortcut: 'Dbl-click', onClick: () => editTrack(t.id, 'Promote take', (tt) => promoteTake(tt, take.id)) },
        { label: 'Delete take', icon: 'trash', onClick: () => editTrack(t.id, 'Delete take', (tt) => deleteTake(tt, take.id)) },
        '-',
      );
    }
    items.push(
      { label: 'Comp crossfade', icon: 'sliders', disabled: !!take && !take.sampleId, submenu: [0, 5, 10, 20, 50, 100].map((ms) => ({ label: `${ms === xf ? '● ' : ''}${ms} ms${ms === DEFAULT_XFADE_MS ? ' (default)' : ''}`, onClick: () => editTrack(t.id, 'Comp crossfade', (tt) => { tt.compXfade = ms; }) })) },
      { label: 'Flatten comp to one clip', icon: 'wave', onClick: () => rec()?.flattenComp(t.id) },
      { label: 'Hide take lanes', onClick: () => setOpen(t.id, false) },
    );
    return items.filter(Boolean);
  }

  function trackMenuItems(trackId) {
    const t = trackById(trackId);
    if (!t) return [];
    const items = [];
    if (hasTakes(t)) {
      items.push({ label: open.has(t.id) ? 'Hide take lanes' : `Show take lanes (${t.takeLanes.length})`, icon: 'layers', onClick: () => setOpen(t.id) });
      items.push({ label: 'Flatten comp to one clip', icon: 'wave', onClick: () => rec()?.flattenComp(t.id) });
    }
    if (t.type === 'audio') items.push({ label: 'Input & monitoring', icon: 'headphones', submenu: inputSubmenu(t, []) });
    if (t.type === 'instrument') items.push({ label: 'Capture MIDI (what you just played)', icon: 'piano', shortcut: 'Shift+R', onClick: () => rec()?.captureMidi(t.id) });
    return items;
  }

  // ------------------------------------------------------------------------------------------- input / monitoring
  let sourceCache = null;
  async function refreshSources() { sourceCache = await listInputSources(); return sourceCache; }
  const upd = (id, label, fn) => app.actions.updateTrack(id, fn, label);
  function inputSubmenu(t, sources = sourceCache || [{ id: DEFAULT_SOURCE, label: 'Default input' }]) {
    const cur = t.recInput?.source || DEFAULT_SOURCE;
    const open = rec()?.inputs.sources.get(cur);
    const n = open?.channels || 2;
    const chans = trackChannels(t, n);
    const chItems = [];
    for (let c = 0; c < Math.max(2, n); c++) chItems.push({ label: `${chans.length === 1 && chans[0] === c ? '● ' : ''}Mono — input ${c + 1}`, onClick: () => upd(t.id, 'Input channel', (tt) => { tt.recInput = { ...(tt.recInput || { source: cur }), channels: [c] }; }) });
    for (let c = 0; c + 1 < Math.max(2, n); c += 2) chItems.push({ label: `${chans.length === 2 && chans[0] === c ? '● ' : ''}Stereo — inputs ${c + 1}–${c + 2}`, onClick: () => upd(t.id, 'Input channel', (tt) => { tt.recInput = { ...(tt.recInput || { source: cur }), channels: [c, c + 1] }; }) });
    const mon = t.monitor || 'off';
    return [
      { header: 'Input device' },
      ...(sources.length ? sources : [{ id: DEFAULT_SOURCE, label: 'Default input' }]).map((s) => ({ label: `${s.id === cur ? '● ' : ''}${s.label}`, onClick: () => upd(t.id, 'Input device', (tt) => { tt.recInput = { source: s.id, channels: tt.recInput?.channels }; }) })),
      { label: 'Channels', submenu: chItems },
      '-',
      { header: 'Monitoring' },
      ...[['off', 'Off'], ['auto', 'Auto (while armed; not during playback)'], ['on', 'On (always)']].map(([v, l]) => ({ label: `${mon === v ? '● ' : ''}${l}`, onClick: () => upd(t.id, 'Monitoring', (tt) => { tt.monitor = v; }) })),
      '-',
      { label: 'Recording settings…', icon: 'sliders', onClick: () => app.actions.showRecordSettings?.() },
    ];
  }
  function inputLabel(t) {
    const cur = t.recInput?.source || DEFAULT_SOURCE;
    const s = rec()?.inputs.sources.get(cur);
    const chans = trackChannels(t, s?.channels || 2);
    return `${chans.length === 1 ? 'In ' + (chans[0] + 1) : `In ${chans[0] + 1}-${chans[1] + 1}`}`;
  }

  /** Extra controls for a track header: input / monitor button (audio), takes toggle. */
  function headerControls(trackId) {
    const inBtn = h('button.arr-th-input', { title: 'Input & monitoring: device, channels, monitor mode (Off / Auto / On)' });
    inBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const t = trackById(trackId);
      if (!t) return;
      const ev = { clientX: r.left, clientY: r.bottom + 2, preventDefault() {} };
      contextMenu(ev, inputSubmenu(t));
      refreshSources().catch(() => {});
    });
    const takesBtn = h('button.arr-th-takes', { title: 'Take lanes: show every take of the recorded passes and comp them (swipe across a take)' }, 'T');
    takesBtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(trackId); });
    const el = h('span.arr-th-rec', inBtn, takesBtn);
    return {
      el,
      update(t) {
        const audio = t.type === 'audio';
        inBtn.classList.toggle('hidden', !audio);
        if (audio) {
          const txt = inputLabel(t);
          if (inBtn.textContent !== txt) inBtn.textContent = txt;
          inBtn.dataset.mon = t.monitor || 'off';
        }
        const tk = hasTakes(t);
        takesBtn.classList.toggle('hidden', !tk);
        takesBtn.classList.toggle('on', tk && open.has(t.id));
        if (tk) takesBtn.textContent = `T${t.takeLanes.length}`;
      },
    };
  }

  /** Input meters (+ latched clip) on armed audio track headers — called every frame. */
  function updateMeters(p, headers) {
    const ins = rec()?.inputs;
    for (const t of p.tracks) {
      if (t.type !== 'audio') continue;
      const hd = headers.get(t.id);
      if (!hd?.inFill) continue;
      const lv = ins?.level(t.id);
      const pct = lv ? Math.min(100, Math.round(Math.sqrt(Math.min(1, lv.peak)) * 100)) + '%' : '0%';
      if (hd.inFill.style.width !== pct) hd.inFill.style.width = pct;
      hd.inFill.classList.toggle('clip', !!lv?.clip);
      hd.el.classList.toggle('monitoring', !!ins?.isMonitoring(t.id));
    }
  }

  // ------------------------------------------------------------------------------------------- punch (loop lane)
  function drawPunch(ctx, p, sx, y, lh) {
    const pu = p.punch;
    if (!pu || !(pu.end > pu.start)) return;
    const ppb = api.ppb();
    const x0 = pu.start * ppb - sx, x1 = pu.end * ppb - sx;
    ctx.fillStyle = pu.enabled ? 'rgba(255,77,77,0.85)' : 'rgba(255,77,77,0.3)';
    ctx.fillRect(x0, y + lh - 4, x1 - x0, 4);
    ctx.fillRect(x0, y, 2, lh);
    ctx.fillRect(x1 - 2, y, 2, lh);
  }
  function startPunchDrag(e, beat) {
    const p = get();
    const pu = p.punch || { enabled: false, start: 0, end: 0 };
    const ppb = api.ppb();
    const nearS = pu.end > pu.start && Math.abs(beat - pu.start) * ppb < 6, nearE = pu.end > pu.start && Math.abs(beat - pu.end) * ppb < 6;
    const anchor = api.snapB(beat, e, Math.round);
    const tx = api.dragTx('Punch range');
    let moved = false;
    api.beginDrag();
    startDrag(e, (dx, _dy, ev) => {
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const b = Math.max(0, api.snapB(beat + dx / ppb, ev));
      let s = pu.start, en = pu.end;
      if (nearE) en = Math.max(s + 0.25, b);
      else if (nearS) s = Math.min(en - 0.25, b);
      else { s = Math.min(anchor, b); en = Math.max(anchor, b); }
      tx((pp) => { pp.punch = { enabled: true, start: +s.toFixed(6), end: +en.toFixed(6) }; });
    }, () => {
      api.endDrag();
      if (!moved && pu.end > pu.start && beat > pu.start && beat < pu.end) setPunch({ enabled: !pu.enabled });
    });
  }
  function setPunch(patch) {
    store.transact('Punch', (pp) => {
      const cur = pp.punch || { enabled: false, start: pp.loop?.start || 0, end: pp.loop?.end || 4 };
      pp.punch = { ...cur, ...patch };
    });
  }
  function punchMenuItems() {
    const p = get();
    const pu = p.punch;
    return [
      { header: 'Punch in / out' },
      { label: pu?.enabled ? 'Punch: On — click to turn off' : 'Punch: Off — record only inside the punch range', onClick: () => setPunch({ enabled: !pu?.enabled }) },
      { label: 'Set punch range to the loop', icon: 'loop', onClick: () => setPunch({ start: p.loop.start, end: p.loop.end, enabled: true }) },
      pu?.end > pu?.start ? { label: 'Set loop to the punch range', icon: 'loop', onClick: () => store.transact('Loop region', (pp) => { pp.loop = { ...pp.loop, start: pu.start, end: pu.end }; }) } : null,
      { label: 'Shift-drag in the loop lane to draw the punch range', disabled: true },
    ].filter(Boolean);
  }

  // ------------------------------------------------------------------------------------------- clip editing commands
  const audioSel = () => get().clips.filter((c) => api.selIds().includes(c.id) && c.type === 'audio');
  function setFade(ids, patch, label = 'Fade') {
    store.transact(label, (pp) => {
      for (const c of pp.clips) {
        if (!ids.includes(c.id) || c.type !== 'audio') continue;
        Object.assign(c, patch);
        for (const k of ['fadeIn', 'fadeOut', 'fadeInShape', 'fadeOutShape']) if (c[k] == null || c[k] === 0) delete c[k];
      }
    });
  }
  function clipMenuItems(clip) {
    if (clip.type !== 'audio') return [];
    const ids = api.selIds().includes(clip.id) ? api.selIds() : [clip.id];
    const p = get();
    const ms = (b) => (b * 60 / p.bpm) * 1000;
    const fadeLen = (msv) => +(msv / 1000 / (60 / p.bpm)).toFixed(6);
    const shapeItems = (key) => FADE_SHAPES.map((s) => ({ label: `${(clip[key] || 'lin') === s ? '● ' : ''}${SHAPE_NAMES[s]}`, onClick: () => setFade(ids, { [key]: s }, 'Fade shape') }));
    return [
      { label: 'Fades', icon: 'sliders', submenu: [
        { header: `In: ${ms(clip.fadeIn || 0).toFixed(0)} ms · Out: ${ms(clip.fadeOut || 0).toFixed(0)} ms` },
        ...[10, 50, 250, 1000].map((v) => ({ label: `Fade in + out ${v} ms`, onClick: () => setFade(ids, { fadeIn: fadeLen(v), fadeOut: fadeLen(v) }) })),
        { label: 'Fade-in curve', submenu: shapeItems('fadeInShape') },
        { label: 'Fade-out curve', submenu: shapeItems('fadeOutShape') },
        { label: 'Remove fades', onClick: () => setFade(ids, { fadeIn: 0, fadeOut: 0 }, 'Remove fades') },
        '-',
        { label: `Automatic crossfades with overlapping clips: ${clip.xfade === false ? 'Off' : 'On'}`, onClick: () => store.transact('Crossfades', (pp) => { for (const c of pp.clips) if (ids.includes(c.id)) { if (clip.xfade === false) delete c.xfade; else c.xfade = false; } }) },
      ] },
      { label: clip.gainEnv?.length ? 'Remove gain envelope' : 'Add gain envelope', icon: 'volume', onClick: () => store.transact('Gain envelope', (pp) => { for (const c of pp.clips) if (ids.includes(c.id) && c.type === 'audio') { if (clip.gainEnv?.length) delete c.gainEnv; else c.gainEnv = [{ beat: 0, gain: 1 }, { beat: +c.length.toFixed(6), gain: 1 }]; } }) },
      { label: 'Normalize (−0.3 dBFS)', icon: 'volume', onClick: () => rec()?.normalizeClips(ids) },
      { label: 'Reverse', icon: 'loop', onClick: () => rec()?.reverseClips(ids) },
      { label: ids.length > 1 ? `Consolidate ${ids.length} clips` : 'Consolidate (render to one clip)', icon: 'layers', onClick: async () => { const nid = await rec()?.consolidate(ids); if (nid) api.setSel([nid]); } },
    ];
  }

  /** Split beat for an audio clip, moved to the nearest zero crossing when that option is on. */
  function splitBeat(clip, beat) {
    if (!zeroSnap || clip.type !== 'audio') return beat;
    const eng = app.engine;
    const buf = eng.buffers?.get(clip.sampleId);
    if (!buf?.getChannelData) return beat;
    const spb = 60 / get().bpm;
    const f = ((clip.offset || 0) + beat - clip.start) * spb * buf.sampleRate;
    const z = nearestZeroCrossing(buf.getChannelData(0), f, Math.round(buf.sampleRate * 0.005));
    return clip.start + (z / buf.sampleRate / spb) - (clip.offset || 0);
  }

  function rippleDeleteClips(ids) {
    store.transact(ids.length > 1 ? `Ripple delete ${ids.length} clips` : 'Ripple delete', (pp) => { pp.clips = rippleDelete(pp.clips, ids); });
  }

  function setRipple(v) { ripple = !!v; try { localStorage.setItem('daw3-ripple', ripple ? '1' : '0'); } catch { /* */ } }
  function setZeroSnap(v) { zeroSnap = !!v; try { localStorage.setItem('daw3-zero-snap', zeroSnap ? '1' : '0'); } catch { /* */ } }

  function recMenuItems() {
    const r = rec();
    const pr = r?.prefs() || {};
    const p = get();
    return [
      { label: 'Recording settings…', icon: 'sliders', onClick: () => app.actions.showRecordSettings?.() },
      '-',
      { label: `Punch in/out: ${p.punch?.enabled ? 'On' : 'Off'}`, icon: 'record', onClick: () => setPunch({ enabled: !p.punch?.enabled }) },
      { label: `Count-in: ${pr.countInBars || 0} bar${pr.countInBars === 1 ? '' : 's'}`, icon: 'metronome', submenu: [0, 1, 2].map((n) => ({ label: `${(pr.countInBars || 0) === n ? '● ' : ''}${n ? `${n} bar${n > 1 ? 's' : ''}` : 'Off'}`, onClick: () => { r.setPrefs({ countInBars: n }); ui.set({ countIn: n > 0 }); } })) },
      { label: `Pre-roll: ${pr.preRollBars || 0} bar${pr.preRollBars === 1 ? '' : 's'}`, submenu: [0, 1, 2, 4].map((n) => ({ label: `${(pr.preRollBars || 0) === n ? '● ' : ''}${n ? `${n} bar${n > 1 ? 's' : ''}` : 'Off'}`, onClick: () => r.setPrefs({ preRollBars: n }) })) },
      { label: `MIDI recording: ${({ overdub: 'Overdub', replace: 'Replace', takes: 'New take per pass', merge: 'Merge passes' })[pr.midiMode] || 'Overdub'}`, icon: 'piano', submenu: [['overdub', 'Overdub (add to what is there)'], ['replace', 'Replace (clear the recorded range)'], ['takes', 'Cycle: new take per loop pass'], ['merge', 'Cycle: merge every pass']].map(([v, l]) => ({ label: `${pr.midiMode === v ? '● ' : ''}${l}`, onClick: () => r.setPrefs({ midiMode: v }) })) },
      { label: 'Capture MIDI (what you just played)', icon: 'piano', shortcut: 'Shift+R', onClick: () => r?.captureMidi() },
      { label: `Step input: ${ui.get('stepInput') ? 'On' : 'Off'}`, icon: 'grid', onClick: () => r?.setStepMode(!ui.get('stepInput')) },
      '-',
      { label: `Ripple editing: ${ripple ? 'On' : 'Off'}`, icon: 'scissors', onClick: () => { setRipple(!ripple); syncToggle(); } },
      { label: `Snap splits to zero crossings: ${zeroSnap ? 'On' : 'Off'}`, onClick: () => setZeroSnap(!zeroSnap) },
    ];
  }
  let syncToggle = () => {};
  function toolbarButtons({ button, toggle, menuAt }) {
    const recBtn = button('Rec', (e) => menuAt(e.currentTarget, recMenuItems()), { icon: 'record', cls: 'small', title: 'Recording: punch, count-in, pre-roll, MIDI modes, capture MIDI, step input, ripple editing' });
    const ripBtn = toggle({ label: 'Ripple', value: ripple, title: 'Ripple editing: deleting a clip closes the gap; lengthening or shortening one moves the clips after it', onChange: (v) => setRipple(v) });
    syncToggle = () => ripBtn.setValue(ripple);
    return [recBtn, ripBtn];
  }

  store.on('change', (p) => autoOpenNew(p));
  autoOpenNew(get());
  rec()?.on?.('audition', () => api.invalidate());
  let audTimer = null;
  rec()?.on?.('audition', (a) => { clearInterval(audTimer); if (a) audTimer = setInterval(() => api.invalidate(), 50); });
  rec()?.inputs?.on?.('change', () => api.relayout());

  return {
    pushTakes, setOpen, isOpen: (id) => open.has(id), drawTakeRow, compFor, drawCompMarks, drawClipOverlay, clipHandleAt,
    startHandleDrag, startSlip, takePointerDown, takeDblClick, takeMenu, trackMenuItems, headerControls, updateMeters,
    drawPunch, startPunchDrag, punchMenuItems, clipMenuItems, splitBeat, rippleDeleteClips, toolbarButtons,
    get ripple() { return ripple; }, get zeroSnap() { return zeroSnap; }, findTake, icon,
  };
}
