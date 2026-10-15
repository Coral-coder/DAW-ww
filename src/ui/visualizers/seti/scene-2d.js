// SETI Scope 3D plot, canvas 2D fallback (no WebGL / no vertex textures): the same camera matrix projects the
// grid and every bar (top + the two faces turned to the camera), painted back to front.
import { projectPoint, colorRamp } from '../../../audio/analysis/seti-signals.js';
import { PLOT } from './plot.js';

export function create2dScene(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let hist = null;
  const order = [];

  const resize = (w, h) => { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } };
  const setGrid = () => {};
  const uploadRow = () => {};
  const shade = (rgb, k, fade) => `rgb(${Math.round(rgb[0] * k * fade * 255)},${Math.round(rgb[1] * k * fade * 255)},${Math.round(rgb[2] * k * fade * 255)})`;

  function poly(pts, fill) {
    if (pts.some((p) => !p)) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function render(vp, head, frac, eye) {
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!hist) return;
    const P = (x, y, z) => projectPoint(vp, x, y, z, W, H);
    // grid
    ctx.strokeStyle = 'rgb(33,84,199)';
    ctx.lineWidth = Math.max(1, W / 1200);
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = -PLOT.width + (2 * PLOT.width * i) / 8, z = (-PLOT.depth * i) / 8;
      for (const [a, b] of [[P(x, 0, 0), P(x, 0, -PLOT.depth)], [P(-PLOT.width, 0, z), P(PLOT.width, 0, z)]]) {
        if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      }
    }
    ctx.stroke();
    const nB = hist.bands, nR = hist.rows;
    const rowD = PLOT.depth / nR, cw = (2 * PLOT.width) / nB;
    // paint order: far from the eye first
    order.length = 0;
    for (let age = 0; age < nR; age++) {
      const zF = -(age + frac) * rowD;
      for (let b = 0; b < nB; b++) {
        const v = hist.at(b, age);
        if (v < 0.02) continue;
        const x0 = -PLOT.width + (b + 0.12) * cw;
        const dx = x0 + cw * 0.38 - eye[0], dz = zF - rowD * 0.36 - eye[2];
        order.push({ d: dx * dx + dz * dz, age, b, v, x0, zF });
      }
    }
    order.sort((a, b) => b.d - a.d);
    for (const o of order) {
      const x1 = o.x0 + cw * 0.76, z0 = o.zF - rowD * 0.72, z1 = o.zF;
      const y = o.v * PLOT.height;
      const rgb = colorRamp(o.v);
      const fade = 0.25 + 0.75 * Math.max(0, 1 - (o.age + frac) / nR);
      // the side facing the eye (x) and the end facing the eye (z)
      const sx = eye[0] > x1 ? x1 : eye[0] < o.x0 ? o.x0 : null;
      if (sx !== null) poly([P(sx, 0, z0), P(sx, 0, z1), P(sx, y, z1), P(sx, y, z0)], shade(rgb, 0.65, fade));
      const sz = eye[2] > z1 ? z1 : eye[2] < z0 ? z0 : null;
      if (sz !== null) poly([P(o.x0, 0, sz), P(x1, 0, sz), P(x1, y, sz), P(o.x0, y, sz)], shade(rgb, 0.8, fade));
      if (eye[1] > y) poly([P(o.x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(o.x0, y, z1)], shade(rgb, 1, fade));
    }
  }

  return {
    kind: 'canvas',
    resize, setGrid, uploadRow, render,
    setHistory(h) { hist = h; },
    dispose() {},
  };
}
