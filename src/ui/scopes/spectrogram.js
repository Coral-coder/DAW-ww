// Spectrogram view: scrolling 2D time × frequency image (horizontal or vertical scroll, log / linear / mel axis,
// colour maps, floor + dynamic range) and a 3D waterfall of stacked spectra in perspective (WebGL when available,
// canvas 2D otherwise) with adjustable angle, depth and height.
import { h, fitCanvas } from '../dom.js';
import {
  SpectrumAnalyzer, slopeGains, bandEdges, resampleBands, freqToNorm, normToFreq, colormapLUT, dbToNorm, channelOf,
  noteOf, formatHz,
} from '../../audio/dsp/scope.js';
import { alpha, emptyMessage, label, toolButton } from './common.js';
import { createWaterfallGL, waterfallMatrix, projectPoint } from './waterfall-gl.js';

const TICKS = { log: [50, 100, 200, 500, 1000, 2000, 5000, 10000], linear: [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000], mel: [100, 250, 500, 1000, 2000, 4000, 8000, 16000] };
const tickLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

export function createSpectrogram({ getParams, compact = false }) {
  const canvas = h('canvas.an-canvas');
  const glCanvas = h('canvas.an-canvas.an-gl');
  const el = h('div.an-stage', glCanvas, canvas);
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d');
  let frozen = false;
  const tools = [
    toolButton('Freeze', 'Pause scrolling', (on) => { frozen = on; }, { toggle: true }),
    toolButton('Clear', 'Clear the history', () => clearAll()),
  ];
  let an = null, slope = null, slopeKey = '';
  let lastAxes = '', edges = null, rowsDb = null, lastNorm = null, acc = 0;
  let wfKey = '', wfEdges = null, wfRows = [], wfAcc = 0, gl = null, glTried = false;
  let hover = null;
  let mono = null;
  function clearAll() { offCtx.clearRect(0, 0, off.width, off.height); lastNorm = null; wfRows = []; }

  /** Power spectrum of the newest fftSize samples (slope applied), or null. */
  function spectrum(io, p) {
    const size = Number(p.fftSize) || 4096;
    const d = io.read(size);
    if (!d) return null;
    if (!an || an.size !== size) an = new SpectrumAnalyzer(size);
    const nb = size / 2 + 1, binHz = d.sr / size;
    const sk = `${size}|${p.slope}|${d.sr}`;
    if (sk !== slopeKey) { slopeKey = sk; slope = slopeGains(nb, binHz, Number(p.slope)); }
    if (!mono || mono.length !== size) mono = new Float32Array(size);
    const o = d.size - size;
    channelOf(d.l.subarray(o), d.r.subarray(o), p.channel, mono);
    an.analyze(mono, null, p.window);
    for (let i = 0; i < nb; i++) an.pa[i] *= slope[i];
    return { power: an.pa, binHz, sr: d.sr };
  }

  const fRange = (p, sr) => [p.scale === 'log' ? 20 : 0, Math.min(20000, (sr || 48000) / 2)];

  // ---------------------------------------------------------------- 2D
  function frame2d(io, dt, th, p, ctx, w, H) {
    glCanvas.style.display = 'none';
    const dpr = canvas.width / Math.max(1, w);
    const W = canvas.width, HH = canvas.height;
    const sr = io.probe?.sampleRate || 48000;
    const [fmin, fmax] = fRange(p, sr);
    const horiz = p.direction !== 'v';
    const nRows = horiz ? HH : W;
    const axesKey = `${p.direction}|${p.scale}|${fmax}`;
    if (W !== off.width || HH !== off.height || axesKey !== lastAxes) {
      let tmp = null; // same axes, new size: stretch the history instead of dropping it
      if (axesKey === lastAxes && off.width && off.height) { tmp = document.createElement('canvas'); tmp.width = off.width; tmp.height = off.height; tmp.getContext('2d').drawImage(off, 0, 0); }
      off.width = W; off.height = HH;
      if (tmp) offCtx.drawImage(tmp, 0, 0, W, HH);
      lastAxes = axesKey;
      edges = bandEdges(nRows, p.scale, fmin, fmax);
      rowsDb = new Float32Array(nRows);
      lastNorm = null;
    }
    if (!frozen && io.probe) {
      acc += p.speed * dt * dpr;
      const n = Math.min(horiz ? W : HH, Math.floor(acc));
      if (n > 0) {
        acc -= n;
        const s = spectrum(io, p);
        if (s) {
          resampleBands(s.power, s.binHz, edges, rowsDb);
          const lut = colormapLUT(p.colormap);
          const cur = new Float32Array(nRows);
          for (let i = 0; i < nRows; i++) cur[i] = dbToNorm(rowsDb[i], p.floor, p.range);
          const prev = lastNorm || cur;
          offCtx.globalCompositeOperation = 'copy';
          if (horiz) offCtx.drawImage(off, -n, 0); else offCtx.drawImage(off, 0, n);
          offCtx.globalCompositeOperation = 'source-over';
          const img = horiz ? offCtx.createImageData(n, HH) : offCtx.createImageData(W, n);
          const px = img.data;
          for (let c = 0; c < n; c++) {
            const t = (c + 1) / n; // blend from the previous column to this one (smooth at low frame rates)
            for (let i = 0; i < nRows; i++) {
              const v = prev[i] + (cur[i] - prev[i]) * t;
              const li = Math.round(v * 255) * 4;
              // horizontal: row i = frequency (bottom = low); vertical: column i = frequency, row 0 = newest
              const o = horiz ? ((HH - 1 - i) * n + c) * 4 : ((n - 1 - c) * W + i) * 4;
              px[o] = lut[li]; px[o + 1] = lut[li + 1]; px[o + 2] = lut[li + 2]; px[o + 3] = 255;
            }
          }
          if (horiz) offCtx.putImageData(img, W - n, 0); else offCtx.putImageData(img, 0, 0);
          lastNorm = cur;
        }
      }
    }
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, H);
    ctx.drawImage(off, 0, 0, w, H);
    if (!io.probe) emptyMessage(ctx, w, H, th, 'No signal');
    // axes
    ctx.font = th.font(9);
    for (const f of TICKS[p.scale] || TICKS.log) {
      if (f >= fmax) continue;
      const t = freqToNorm(f, p.scale, fmin, fmax);
      if (horiz) { const y = Math.round(H - t * H); ctx.fillStyle = alpha(th.text, 0.18); ctx.fillRect(0, y, w, 1); if (!compact || f === 1000) label(ctx, tickLabel(f), 3, y - 2, th, { color: th.text2, size: 9 }); }
      else { const x = Math.round(t * w); ctx.fillStyle = alpha(th.text, 0.18); ctx.fillRect(x, 0, 1, H); if (!compact || f === 1000) label(ctx, tickLabel(f), x + 2, H - 4, th, { color: th.text2, size: 9 }); }
    }
    if (!compact) {
      const secPx = p.speed;
      for (let s = 1; s * secPx < (horiz ? w : H) - 20; s += secPx < 30 ? 5 : secPx < 60 ? 2 : 1) {
        if (horiz) label(ctx, `−${s}s`, w - s * secPx, 12, th, { align: 'center', color: th.text3, size: 9 });
        else label(ctx, `−${s}s`, w - 4, s * secPx, th, { align: 'right', color: th.text3, size: 9 });
      }
      label(ctx, `${p.floor}…${p.floor + p.range} dB${frozen ? ' · FROZEN' : ''}`, horiz ? w - 4 : 4, horiz ? H - 4 : 12, th, { align: horiz ? 'right' : 'left', color: frozen ? th.warn : th.text3, size: 9 });
    }
    if (hover) {
      const t = horiz ? 1 - hover.y / H : hover.x / w;
      const f = normToFreq(Math.max(0, Math.min(1, t)), p.scale, fmin, fmax);
      const ago = (horiz ? w - hover.x : hover.y) / p.speed;
      const nt = noteOf(f);
      label(ctx, `${formatHz(f)}${nt ? ` · ${nt.label}` : ''} · −${ago.toFixed(1)} s`, Math.min(w - 4, hover.x + 8), Math.max(24, hover.y - 6), th, { align: hover.x > w * 0.6 ? 'right' : 'left', size: 10, weight: 600 });
    }
  }

  // ---------------------------------------------------------------- 3D
  function frame3d(io, dt, th, p, ctx, w, H) {
    const P = compact ? 96 : 160;
    const sr = io.probe?.sampleRate || 48000;
    const [fmin, fmax] = fRange(p, sr);
    const k = `${P}|${p.scale}|${fmax}`;
    if (k !== wfKey) { wfKey = k; wfEdges = bandEdges(P, p.scale, fmin, fmax); wfRows = []; }
    const depth = Math.round(p.depth);
    if (!frozen && io.probe) {
      wfAcc += dt * Math.max(2, p.speed / 6); // rows per second
      if (wfAcc >= 1) {
        wfAcc = Math.min(wfAcc - 1, 1);
        const s = spectrum(io, p);
        if (s) {
          const db = resampleBands(s.power, s.binHz, wfEdges);
          const row = new Float32Array(P);
          for (let i = 0; i < P; i++) row[i] = dbToNorm(db[i], p.floor, p.range);
          wfRows.unshift(row);
        }
      }
    }
    if (wfRows.length > depth) wfRows.length = depth;
    const lut = colormapLUT(p.colormap);
    const M = waterfallMatrix(w, H, p.angle, p.height);
    if (!glTried) { glTried = true; gl = createWaterfallGL(glCanvas); }
    ctx.clearRect(0, 0, w, H);
    if (gl) glCanvas.style.display = '';
    if (gl && gl.draw({ rows: wfRows, depth, lut, matrix: M, bg: th.bg, height: p.height }) !== false) {
      // drawn by WebGL under the label canvas
    } else {
      gl = null;
      glCanvas.style.display = 'none';
      ctx.fillStyle = th.bg; ctx.fillRect(0, 0, w, H);
      draw2dWaterfall(ctx, wfRows, depth, lut, M, w, H, th, p.height);
    }
    if (!io.probe) emptyMessage(ctx, w, H, th, 'No signal');
    // frequency ticks along the front edge
    for (const f of TICKS[p.scale] || TICKS.log) {
      if (f >= fmax) continue;
      const x = freqToNorm(f, p.scale, fmin, fmax) * 2 - 1;
      const [sx, sy] = projectPoint(M, x, 0, 1, w, H);
      if (!compact || f === 1000) label(ctx, tickLabel(f), sx, Math.min(H - 3, sy + 12), th, { align: 'center', color: th.text2, size: 9 });
    }
    if (!compact) {
      const [bx, by] = projectPoint(M, 1, 0, -1, w, H);
      const secs = depth / Math.max(2, p.speed / 6);
      label(ctx, `−${secs.toFixed(1)} s`, Math.min(w - 4, bx + 4), Math.max(12, by), th, { color: th.text3, size: 9 });
      label(ctx, `${gl ? 'WebGL' : '2D'} · ${p.floor}…${p.floor + p.range} dB${frozen ? ' · FROZEN' : ''}`, 4, 12, th, { color: frozen ? th.warn : th.text3, size: 9 });
    }
  }

  function frame(io, dt, th) {
    const p = getParams();
    const { ctx, w, h: H } = fitCanvas(canvas);
    if (p.view === '3d') frame3d(io, dt, th, p, ctx, w, H);
    else frame2d(io, dt, th, p, ctx, w, H);
  }

  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  canvas.addEventListener('pointerleave', () => { hover = null; });
  return { el, tools, frame, dispose() { gl?.dispose(); } };
}

/** Canvas 2D waterfall (no WebGL): rows back to front, each filled with the background to hide what is behind. */
function draw2dWaterfall(ctx, rows, depth, lut, M, w, H, th, height) {
  const P = rows[0]?.length || 0;
  for (let r = rows.length - 1; r >= 0; r--) {
    const z = 1 - (2 * r) / Math.max(1, depth - 1);
    const row = rows[r];
    const pts = new Float32Array(P * 2);
    for (let i = 0; i < P; i++) {
      const [sx, sy] = projectPoint(M, (i / (P - 1)) * 2 - 1, row[i] * 0.6 * height, z, w, H);
      pts[i * 2] = sx; pts[i * 2 + 1] = sy;
    }
    const [x0, y0] = projectPoint(M, -1, 0, z, w, H);
    const [x1, y1] = projectPoint(M, 1, 0, z, w, H);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (let i = 0; i < P; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
    ctx.lineTo(x1, y1);
    ctx.closePath();
    ctx.fillStyle = alpha(th.bg, 0.94);
    ctx.fill();
    // stroke in a few colour buckets so peaks glow brighter than the floor
    for (let b = 0; b < 6; b++) {
      ctx.beginPath();
      let any = false;
      for (let i = 1; i < P; i++) {
        const v = (row[i - 1] + row[i]) / 2;
        if (Math.min(5, Math.floor(v * 6)) !== b) continue;
        ctx.moveTo(pts[i * 2 - 2], pts[i * 2 - 1]); ctx.lineTo(pts[i * 2], pts[i * 2 + 1]); any = true;
      }
      if (!any) continue;
      const li = Math.round(Math.min(1, (b + 0.5) / 6 + 0.1) * 255) * 4;
      ctx.strokeStyle = `rgb(${lut[li]}, ${lut[li + 1]}, ${lut[li + 2]})`;
      ctx.lineWidth = r === 0 ? 1.6 : 1;
      ctx.stroke();
    }
  }
}
