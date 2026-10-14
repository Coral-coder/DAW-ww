// Tempo track lane for the Arrange view + meter-aware ruler / grid drawing helpers.
//
// The lane sits between the toolbar and the timeline, horizontally locked to the arrangement scroller:
//   · the tempo curve (jumps as steps, ramps as slopes), one handle per tempo point
//   · double-click: new tempo point (jump) at the snapped beat, bpm from the height
//   · drag a point: beat (snapped, Ctrl/⌘ = free) and bpm (Shift = bpm only); point 1 is project.bpm
//   · right-click: ramp to next / jump, set BPM…, delete; add tempo change / meter change here,
//     tempo from loop length, tap tempo to map, clear tempo changes
//   · meter changes are drawn as labels on the lane and on the ruler (drawMeterMarks)
import { h, startDrag, fitCanvas } from './dom.js';
import { button, contextMenu, promptText, toast } from './components.js';
import { songTempoMap } from '../time/tempo-map.js';
import { setTempoPoint, moveTempoPoint, removeTempoPoint, setTempoCurve, setMeter, removeMeter, tempoFromSelection, TapTempo, tapTempoToMap } from '../time/tempo-edit.js';

const LANE_H = 64;

/**
 * @param {object} app
 * @param {{ getPpb(), getHeadW(), getScroller(), snapB(beat, ev, fn?), pos(), invalidate() }} view
 */
export function createTempoLane(app, view) {
  const { store } = app;
  const get = () => store.get();
  let shown = (() => { try { return localStorage.getItem('daw3-tempo-lane') !== '0'; } catch { return true; } })();
  const tapper = new TapTempo();

  const readout = h('span.tempo-lane-now', '');
  const tapBtn = button('Tap', (e) => tapToMap(e), { cls: 'small', title: 'Tap tempo to map: taps set the tempo at the playhead (a tempo change at its bar in song mode)' });
  const head = h('div.tempo-lane-head',
    h('div.tempo-lane-title', h('span', 'Tempo'), readout),
    h('div.tempo-lane-btns', tapBtn,
      button('Meter', (e) => meterMenu(e, barAtPlayhead()), { cls: 'small', title: 'Add a time-signature change at the playhead bar' })));
  const canvas = h('canvas.tempo-lane-canvas');
  const el = h('div.tempo-lane', { style: { height: LANE_H + 'px' } }, head, canvas);
  el.classList.toggle('hidden', !shown);

  let range = { lo: 60, hi: 180 };
  let drag = null; // { i }
  let hover = -1;

  const sx = () => view.getScroller()?.scrollLeft || 0;
  const ppb = () => view.getPpb();
  const yOf = (bpm, H) => 6 + (1 - (bpm - range.lo) / (range.hi - range.lo)) * (H - 14);
  const bpmOfY = (y, H) => range.lo + (1 - (y - 6) / (H - 14)) * (range.hi - range.lo);

  function computeRange(p) {
    const pts = (p.tempoMap?.length ? p.tempoMap : [{ bpm: p.bpm }]).map((x) => x.bpm);
    const lo = Math.min(...pts), hi = Math.max(...pts);
    const pad = Math.max(10, (hi - lo) * 0.25);
    if (!drag) range = { lo: Math.max(10, Math.floor((lo - pad) / 10) * 10), hi: Math.ceil((hi + pad) / 10) * 10 };
  }

  function points(p) {
    return p.tempoMap?.length ? p.tempoMap : [{ beat: 0, bpm: p.bpm, curve: 'jump' }];
  }

  function draw() {
    if (!shown || !el.isConnected) return;
    el.style.setProperty('--arr-head-w', view.getHeadW() + 'px');
    const { ctx, w: W, h: H } = fitCanvas(canvas);
    const p = get();
    const map = songTempoMap(p);
    computeRange(p);
    const cs = getComputedStyle(el);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const accent = v('--accent-2', '#00d4ff'), line = v('--line', '#2a3040'), text2 = v('--text-2', '#a7aec2'), text3 = v('--text-3', '#6d7590'), bg = v('--bg', '#0f1116');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const s = sx(), k = ppb();
    const b0 = s / k, b1 = (s + W) / k;
    // bar grid
    ctx.fillStyle = line;
    let lastX = -1e9;
    for (const g of map.gridLines(Math.max(0, b0 - 1), b1 + 1, { beats: false, maxLines: 2000 })) {
      const x = Math.round(g.beat * k - s);
      if (x - lastX < 6) continue;
      lastX = x;
      ctx.fillRect(x, 0, 1, H);
    }
    // bpm guide lines
    ctx.font = `9.5px ${v('--font', 'system-ui')}`;
    ctx.textBaseline = 'middle';
    const pxPerBpm = (H - 14) / (range.hi - range.lo);
    const step = [5, 10, 20, 25, 50, 100, 200].find((x) => x * pxPerBpm >= 18) || 200;
    for (let bpm = Math.ceil(range.lo / step) * step; bpm <= range.hi; bpm += step) {
      const y = Math.round(yOf(bpm, H)) + 0.5;
      ctx.fillStyle = 'rgba(128,128,140,.12)';
      ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = text3;
      ctx.fillText(String(bpm), 3, Math.max(5, y - 6));
    }
    // curve: sample per few px (exact through the map)
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const stepPx = 3;
    for (let x = 0; x <= W + stepPx; x += stepPx) {
      const b = Math.max(0, (x + s) / k);
      const y = yOf(map.bpmAt(b), H);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.12;
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = accent; ctx.fill();
    ctx.globalAlpha = 1;
    // points
    const pts = points(p);
    pts.forEach((pt, i) => {
      const x = pt.beat * k - s;
      if (x < -8 || x > W + 8) return;
      const y = yOf(i === 0 ? p.bpm : pt.bpm, H);
      ctx.fillStyle = i === hover || drag?.i === i ? '#fff' : accent;
      ctx.beginPath();
      if (pt.curve === 'linear') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); } else ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = text2;
      ctx.font = `600 10px ${v('--font', 'system-ui')}`;
      ctx.fillText(`${+(i === 0 ? p.bpm : pt.bpm).toFixed(2)}`, x + 7, Math.min(H - 8, Math.max(8, y - 9)));
    });
    // meter labels
    drawMeterMarks(ctx, map, { sx: s, ppb: k, W, y: H - 9, color: text2, bg: v('--bg-3', '#1b1f2a'), font: v('--font', 'system-ui') });
    // playhead
    const px = Math.round(view.pos() * k - s);
    if (px >= 0 && px <= W) { ctx.fillStyle = v('--accent', '#7c5cff'); ctx.fillRect(px, 0, 1, H); }
    updateReadout();
  }

  function updateReadout() {
    const p = get();
    const map = songTempoMap(p);
    const b = Math.max(0, view.pos());
    const pos = map.position(b);
    readout.textContent = `${map.bpmAt(b).toFixed(1)} · ${pos.num}/${pos.den}`;
  }

  // ------------------------------------------------------------------ interaction
  const localXY = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, H: r.height }; };
  function pick(e) {
    const { x, y, H } = localXY(e);
    const p = get();
    const pts = points(p);
    let best = -1, bd = 10;
    pts.forEach((pt, i) => {
      const d = Math.hypot(pt.beat * ppb() - sx() - x, yOf(i === 0 ? p.bpm : pt.bpm, H) - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  const beatAt = (e) => Math.max(0, (localXY(e).x + sx()) / ppb());
  const r2 = (x) => Math.round(x * 100) / 100;

  canvas.addEventListener('pointermove', (e) => { if (drag) return; const i = pick(e); if (i !== hover) { hover = i; draw(); } canvas.style.cursor = i >= 0 ? 'grab' : 'crosshair'; });
  canvas.addEventListener('pointerleave', () => { if (hover !== -1) { hover = -1; draw(); } });
  canvas.addEventListener('dblclick', (e) => {
    const i = pick(e);
    if (i > 0) { store.transact('Delete tempo point', (p) => removeTempoPoint(p, i)); return; }
    if (i === 0) return;
    const b = view.snapB(beatAt(e), e);
    const bpm = r2(bpmOfY(localXY(e).y, localXY(e).H));
    store.transact('Add tempo change', (p) => { setTempoPoint(p, b, bpm, 'jump'); if (p.mode !== 'song') p.mode = 'song'; });
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const i = pick(e);
    if (i < 0) return;
    e.preventDefault();
    let started = false;
    drag = { i };
    const tx = (fn) => { store.transact('Edit tempo', fn, started ? { undo: false } : {}); started = true; };
    startDrag(e, (dx, dy, ev) => {
      const { y, H } = localXY(ev);
      const bpm = r2(Math.max(10, Math.min(999, bpmOfY(y, H))));
      const beat = i === 0 || ev.shiftKey ? null : view.snapB(beatAt(ev), ev);
      tx((p) => moveTempoPoint(p, drag.i, beat, bpm));
      draw();
    }, () => { drag = null; draw(); });
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = get();
    const i = pick(e);
    const b = view.snapB(beatAt(e), e, Math.floor);
    const pts = points(p);
    const items = [];
    if (i >= 0) {
      const pt = pts[i];
      items.push({ header: `Tempo point ${i + 1} · ${+(i === 0 ? p.bpm : pt.bpm).toFixed(2)} BPM` });
      if (i < pts.length - 1) items.push({ label: pt.curve === 'linear' ? 'Jump to next (step)' : 'Ramp to next point', icon: 'sliders', onClick: () => store.transact('Tempo curve', (pp) => setTempoCurve(pp, i, pt.curve === 'linear' ? 'jump' : 'linear')) });
      items.push({ label: 'Set BPM…', icon: 'pencil', onClick: async () => {
        const v = Number(await promptText('Tempo (BPM)', String(i === 0 ? p.bpm : pt.bpm)));
        if (v > 0) store.transact('Set tempo', (pp) => (i === 0 ? setTempoPoint(pp, 0, v) : moveTempoPoint(pp, i, null, v)));
      } });
      if (i > 0) items.push({ label: 'Delete point', icon: 'trash', onClick: () => store.transact('Delete tempo point', (pp) => removeTempoPoint(pp, i)) });
      items.push('-');
    }
    const map = songTempoMap(p);
    const bar = map.barAt(b);
    items.push(
      { label: `Add tempo change at bar ${bar.bar + 1}…`, icon: 'plus', onClick: async () => {
        const v = Number(await promptText(`Tempo from bar ${bar.bar + 1} (BPM)`, String(r2(map.bpmAt(bar.start)))));
        if (v > 0) store.transact('Add tempo change', (pp) => { setTempoPoint(pp, bar.start, v, 'jump'); pp.mode = 'song'; });
      } },
      { label: `Time signature from bar ${bar.bar + 1}…`, icon: 'music', onClick: (ev) => meterMenu(e, bar.bar) },
      p.loop && p.loop.end > p.loop.start ? { label: 'Set tempo from loop length…', icon: 'loop', title: 'The loop region becomes a whole number of bars in the time it lasts now', onClick: async () => {
        const L = p.loop;
        const bars = Number(await promptText(`The loop (${r2(L.end - L.start)} beats, ${r2(map.span(L.start, L.end))} s) should last how many beats?`, String(Math.max(map.barAt(L.start).length, Math.round((L.end - L.start) / map.barAt(L.start).length) * map.barAt(L.start).length))));
        if (bars > 0) { let bpm; store.transact('Tempo from selection', (pp) => { bpm = tempoFromSelection(pp, L.start, L.end, bars); }); toast(`Tempo ${r2(bpm)} BPM`); }
      } } : null,
      { label: 'Tap tempo here (tap T / click Tap)', icon: 'metronome', onClick: () => toast('Tap the “Tap” button on the tempo lane in time with the music.') },
      p.tempoMap?.length || p.meterMap?.length ? { label: 'Clear tempo & meter changes', icon: 'trash', onClick: () => store.transact('Clear tempo map', (pp) => { delete pp.tempoMap; delete pp.meterMap; }) } : null,
    );
    contextMenu(e, items.filter(Boolean));
  });

  function barAtPlayhead() { return songTempoMap(get()).barAt(Math.max(0, view.pos())).bar; }

  function meterMenu(e, bar) {
    const map = songTempoMap(get());
    const cur = map.meterOfBar(bar);
    const opts = ['4/4', '3/4', '2/4', '5/4', '6/8', '7/8', '5/8', '9/8', '12/8', '7/4', '6/4'];
    contextMenu(e, [
      { header: `Meter from bar ${bar + 1}` },
      ...opts.map((s) => ({ label: `${s}${s === `${cur.num}/${cur.den}` && cur.bar === bar ? '  ●' : ''}`, onClick: () => { const [n, d] = s.split('/').map(Number); store.transact('Time signature change', (p) => setMeter(p, bar, n, d)); } })),
      { label: 'Other…', onClick: async () => { const v = await promptText('Time signature (e.g. 11/8)', `${cur.num}/${cur.den}`); const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v || ''); if (m) store.transact('Time signature change', (p) => setMeter(p, bar, +m[1], +m[2])); } },
      bar > 0 && (get().meterMap || []).some((m) => m.bar === bar) ? { label: 'Remove this change', icon: 'trash', onClick: () => store.transact('Remove meter change', (p) => removeMeter(p, bar)) } : null,
    ].filter(Boolean));
  }

  function tapToMap(e) {
    const bpm = tapper.tap(performance.now());
    if (!bpm) { app.setStatus?.('Tap tempo: keep tapping…'); return; }
    if (bpm < 20 || bpm > 400) return;
    const p = get();
    const at = p.mode === 'song' && view.pos() > 0 ? songTempoMap(p).barAt(view.pos()).start : 0;
    store.transact('Tap tempo to map', (pp) => tapTempoToMap(pp, at, bpm), { coalesce: true });
    app.setStatus?.(`Tap tempo: ${bpm} BPM${at > 0 ? ` from bar ${songTempoMap(get()).barAt(at).bar + 1}` : ''}`);
  }

  const sc = () => view.getScroller();
  let hooked = null;
  function hook() {
    const s = sc();
    if (s && s !== hooked) { hooked = s; s.addEventListener('scroll', () => draw(), { passive: true }); }
  }

  return {
    el,
    get shown() { return shown; },
    toggle(v = !shown) {
      shown = v;
      try { localStorage.setItem('daw3-tempo-lane', v ? '1' : '0'); } catch { /* */ }
      el.classList.toggle('hidden', !shown);
      draw();
    },
    draw() { hook(); draw(); },
    tick() { if (shown) { updateReadout(); if (app.engine?.isPlaying) draw(); } },
  };
}

// ------------------------------------------------------------------ ruler / grid helpers (Arrange)
/** Meter-change labels ("7/8") at their bars. */
export function drawMeterMarks(ctx, map, { sx, ppb, W, y, color, bg, font }) {
  if (map.meters.length < 2) return;
  ctx.save();
  ctx.font = `700 9.5px ${font}`;
  ctx.textBaseline = 'middle';
  for (const m of map.meters) {
    const x = m.beat * ppb - sx;
    if (x < -40 || x > W + 4) continue;
    const t = `${m.num}/${m.den}`;
    const w = ctx.measureText(t).width + 6;
    ctx.fillStyle = bg;
    ctx.fillRect(x + 1, y - 6, w, 12);
    ctx.fillStyle = color;
    ctx.fillText(t, x + 4, y + 0.5);
  }
  ctx.restore();
}

/**
 * Bar ticks + numbers of the ruler through the meter map. Replaces the constant-bpb loop when meters change.
 * opts: { sx, ppb, W, H (ruler height), theme }
 */
export function drawRulerBars(ctx, map, { sx, ppb, W, H, theme }) {
  const b0 = sx / ppb, b1 = (sx + W) / ppb;
  const minBarPx = Math.min(...map.meters.map((m) => m.bpb)) * ppb;
  let labelStep = 1;
  while (labelStep * minBarPx < 42) labelStep *= 2;
  let tickStep = 1;
  while (tickStep * minBarPx < 7) tickStep *= 2;
  ctx.font = `600 10.5px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const g of map.gridLines(Math.max(0, b0 - 8), b1, { beats: ppb >= 9, maxLines: 6000 })) {
    const x = Math.round(g.beat * ppb - sx);
    if (g.kind === 'beat') { ctx.fillStyle = theme.line; ctx.fillRect(x, 17, 1, H - 17); continue; }
    if (g.bar % tickStep) continue;
    const meterStart = map.meters.some((m) => m.bar === g.bar && g.bar > 0);
    const labeled = g.bar % labelStep === 0 || meterStart;
    ctx.fillStyle = labeled ? theme.text3 : theme.line;
    ctx.fillRect(x, labeled ? 4 : 13, 1, labeled ? H - 4 : H - 13);
    if (labeled) { ctx.fillStyle = theme.text2; ctx.fillText(String(g.bar + 1), x + 4, 9); }
  }
  drawMeterMarks(ctx, map, { sx, ppb, W, y: H - 6, color: theme.accent2 || theme.text2, bg: theme.bg2, font: theme.font });
}

/** Timeline grid (bars / beats in meter units) through the meter map. */
export function drawMeterGrid(ctx, map, { sx, ppb, H, b0, b1, theme, sub = 0 }) {
  if (sub && sub * ppb >= 8) {
    ctx.fillStyle = theme.gridStep;
    for (let b = Math.floor(b0 / sub) * sub; b <= b1; b += sub) ctx.fillRect(Math.round(b * ppb - sx), 0, 1, H);
  }
  const minBarPx = Math.min(...map.meters.map((m) => m.bpb)) * ppb;
  let barStep = 1;
  while (barStep * minBarPx < 8) barStep *= 2;
  for (const g of map.gridLines(Math.max(0, b0 - 8), b1 + 1, { beats: ppb * 0.5 >= 7, maxLines: 8000 })) {
    if (g.kind === 'bar' && g.bar % barStep) continue;
    ctx.fillStyle = g.kind === 'bar' ? theme.gridBar : theme.gridBeat;
    ctx.fillRect(Math.round(g.beat * ppb - sx), 0, 1, H);
  }
}
