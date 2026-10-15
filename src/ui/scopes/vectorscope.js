// Vectorscope / goniometer view: Lissajous (rotated 45°: mid up, side across), scatter and polar plots with phosphor
// persistence, M / S solo, auto gain, plus correlation (−1..+1) and balance (L..R) meters with an integration time.
import { h, fitCanvas } from '../dom.js';
import { StereoMeter } from '../../audio/dsp/scope.js';
import { alpha, emptyMessage, label, toolButton } from './common.js';

const R2 = Math.SQRT1_2;

export function createVectorscope({ getParams, compact = false }) {
  const canvas = h('canvas.an-canvas.an-square');
  const meters = h('canvas.an-meters');
  const el = h('div.an-stage.an-col', canvas, meters);
  let frozen = false;
  const tools = [toolButton('Freeze', 'Freeze the display', (on) => { frozen = on; }, { toggle: true })];
  const meter = new StereoMeter(0.3);
  let gainAuto = 1, stats = meter.read(), corrMin = 1;

  function frame(io, dt, th) {
    const p = getParams();
    const { ctx, w, h: H } = fitCanvas(canvas);
    const probe = io.probe;
    const fade = frozen ? 0 : p.persistence > 0 ? 1 - Math.pow(p.persistence, dt * 30) : 1;
    if (fade > 0) { ctx.fillStyle = fade >= 1 ? th.bg : alpha(th.bg, fade); ctx.fillRect(0, 0, w, H); }
    const cx = w / 2, cy = p.mode === 'polar' ? H * 0.88 : H / 2;
    const R = p.mode === 'polar' ? Math.min(w / 2, H * 0.84) * 0.96 : Math.min(w, H) * 0.47;
    axes(ctx, w, H, cx, cy, R, th, p.mode, compact);
    if (!probe) { emptyMessage(ctx, w, H, th, 'No signal'); drawMeters(th); return; }
    if (frozen) { drawMeters(th); return; }
    const d = io.read(2048);
    if (!d) { drawMeters(th); return; }
    const n = Math.max(32, Math.min(d.size, d.fresh || 0));
    meter.tau = p.integration;
    stats = meter.push(d.l, d.r, d.fresh || 0, d.sr);
    corrMin = Math.min(stats.corr, corrMin + dt * 0.25);
    const { l, r } = d;
    const start = d.size - n;
    // auto gain on the (M, S) magnitude of this block
    let pk = 0;
    for (let i = start; i < d.size; i++) { const a = Math.abs(l[i]), b = Math.abs(r[i]); if (a > pk) pk = a; if (b > pk) pk = b; }
    const target = Math.min(64, 0.9 / Math.max(pk, 1e-4));
    gainAuto = target < gainAuto ? target : gainAuto + (target - gainAuto) * Math.min(1, dt * 1.5);
    const g = (p.auto ? gainAuto : p.gain) * R;
    const soloM = p.solo === 'M', soloS = p.solo === 'S';
    const col = p.solo === 'S' ? th.warn : p.solo === 'M' ? th.accent : th.accent2;
    ctx.fillStyle = col;
    ctx.strokeStyle = alpha(col, 0.55);
    ctx.lineWidth = 1;
    if (p.mode === 'lissajous') ctx.beginPath();
    const dot = compact ? 1.1 : 1.4;
    for (let i = start; i < d.size; i++) {
      let s = (r[i] - l[i]) * R2, m = (l[i] + r[i]) * R2; // x = side (L to the left), y = mid
      if (soloM) s = 0; else if (soloS) m = 0;
      if (p.mode === 'polar') {
        if (m < 0) { m = -m; s = -s; } // fold onto the upper half-plane
        const mag = Math.min(1.05, Math.hypot(s, m) * (g / R));
        const ang = Math.atan2(s, m);
        const x = cx + Math.sin(ang) * mag * R, y = cy - Math.cos(ang) * mag * R;
        ctx.fillRect(x, y, dot, dot);
        continue;
      }
      const x = cx + s * g, y = cy - m * g;
      if (p.mode === 'lissajous') { if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y); } else ctx.fillRect(x, y, dot, dot);
    }
    if (p.mode === 'lissajous') ctx.stroke();
    label(ctx, p.auto ? `auto ×${gainAuto.toFixed(1)}` : `×${p.gain.toFixed(2)}`, w - 4, H - 4, th, { align: 'right', color: th.text3, size: 9, box: false });
    drawMeters(th);
  }

  function drawMeters(th) {
    const { ctx, w, h: H } = fitCanvas(meters);
    ctx.clearRect(0, 0, w, H);
    const rowH = H / 2;
    const bar = (row, lbl, v, txt, lo, hi, colFn, mark) => {
      const y = row * rowH + 3, bh = rowH - 6;
      const x0 = 36, x1 = w - 46;
      ctx.fillStyle = th.bg; ctx.fillRect(x0, y, x1 - x0, bh);
      ctx.strokeStyle = th.line; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, bh - 1);
      const xm = x0 + (x1 - x0) / 2, xv = x0 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (x1 - x0);
      ctx.fillStyle = colFn(v);
      ctx.fillRect(Math.min(xm, xv), y + 2, Math.max(2, Math.abs(xv - xm)), bh - 4);
      ctx.fillStyle = th.line2; ctx.fillRect(Math.round(xm), y, 1, bh);
      if (mark != null) { const xk = x0 + ((mark - lo) / (hi - lo)) * (x1 - x0); ctx.fillStyle = th.bad; ctx.fillRect(Math.round(xk), y, 2, bh); }
      ctx.font = th.font(9); ctx.fillStyle = th.text3; ctx.textBaseline = 'middle';
      ctx.fillText(lbl, 2, y + bh / 2);
      ctx.fillStyle = th.text; ctx.textAlign = 'right'; ctx.fillText(txt, w - 2, y + bh / 2); ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    };
    const c = stats.corr;
    bar(0, 'Corr', c, (c >= 0 ? '+' : '') + c.toFixed(2), -1, 1, (v) => (v < -0.05 ? th.bad : v < 0.3 ? th.warn : th.good), corrMin < -0.05 ? corrMin : null);
    const b = stats.balance;
    const bdb = stats.balanceDb;
    const btxt = !Number.isFinite(bdb) ? (bdb > 0 ? 'R' : 'L') : Math.abs(bdb) < 0.05 ? 'C' : `${bdb > 0 ? 'R' : 'L'} ${Math.abs(bdb).toFixed(1)}`;
    bar(1, 'Bal', b, btxt, -1, 1, () => th.accent2, null);
  }

  canvas.addEventListener('dblclick', () => { meter.reset(); corrMin = 1; gainAuto = 1; });
  return { el, tools, frame };
}

function axes(ctx, w, H, cx, cy, R, th, mode, compact) {
  ctx.strokeStyle = alpha(th.line2, 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (mode === 'polar') {
    ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - R);
    ctx.moveTo(cx, cy); ctx.lineTo(cx - R * R2, cy - R * R2);
    ctx.moveTo(cx, cy); ctx.lineTo(cx + R * R2, cy - R * R2);
  } else {
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx - R * R2, cy - R * R2); ctx.lineTo(cx + R * R2, cy + R * R2);
    ctx.moveTo(cx + R * R2, cy - R * R2); ctx.lineTo(cx - R * R2, cy + R * R2);
    ctx.moveTo(cx + R, cy); ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  }
  ctx.stroke();
  if (compact) return;
  ctx.fillStyle = th.text3;
  ctx.font = th.font(9);
  ctx.textAlign = 'center';
  ctx.fillText('M', cx, cy - R - 3 < 9 ? 9 : cy - R - 3);
  ctx.fillText('L', cx - R * R2 - 6, cy - R * R2 - 2);
  ctx.fillText('R', cx + R * R2 + 6, cy - R * R2 - 2);
  ctx.textAlign = 'left';
}
