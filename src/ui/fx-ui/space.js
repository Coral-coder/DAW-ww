// Custom UI for space effects, keyed by effect type. Each entry is (el, api) => ({ update?(fx), dispose?() }).
// el is the effect card body (generic param knobs are already in it); api = { fx, tgt, engine, app, probe(), edit }.
// Animation loops must stop by themselves once el.isConnected is false (cards are rebuilt without a dispose call).
import { h, fitCanvas, startDrag } from '../dom.js';
import { resolveEffectParams } from '../../audio/effect-defs.js';
import { MULTITAP_COUNT } from '../../audio/fx/defs/space.js';

const GRID = 1 / 64; // tap positions snap to 1/64 of the pattern (1/16 of a beat in a synced bar)

/** Multitap pattern editor: drag a tap sideways (position) and up / down (level); double-click adds / removes. */
function multitapEditor(el, api) {
  const canvas = h('canvas', { style: { width: '100%', height: '76px', display: 'block', cursor: 'pointer', touchAction: 'none', borderRadius: '6px' } });
  const hint = h('div.dv-note', { style: { fontSize: '11px', opacity: 0.75, marginTop: '2px' } }, 'Drag taps: sideways = position, up / down = level. Double-click to add or remove a tap.');
  const wrap = h('div.dv-multitap', { style: { margin: '6px 0 2px' } }, canvas, hint);
  el.appendChild(wrap);
  let p = resolveEffectParams(api.fx);
  let hot = -1;
  const css = (n, d) => getComputedStyle(canvas).getPropertyValue(n).trim() || d;

  function draw() {
    if (!canvas.isConnected) return;
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = css('--bg-2', 'rgba(127,127,127,0.08)');
    ctx.fillRect(0, 0, w, H);
    ctx.strokeStyle = css('--line', 'rgba(127,127,127,0.3)');
    for (let i = 1; i < 16; i++) {
      ctx.globalAlpha = i % 4 ? 0.35 : 0.9;
      ctx.beginPath(); ctx.moveTo((i / 16) * w + 0.5, 0); ctx.lineTo((i / 16) * w + 0.5, H); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const accent = css('--accent', '#7c5cff');
    for (let i = 1; i <= MULTITAP_COUNT; i++) {
      const on = p[`t${i}On`], x = p[`t${i}Pos`] * w, lv = p[`t${i}Level`], pan = p[`t${i}Pan`];
      const top = H - 4 - lv * (H - 12);
      ctx.globalAlpha = on ? 1 : 0.25;
      ctx.fillStyle = accent;
      ctx.fillRect(x - 3, top, 6, H - 4 - top);
      ctx.beginPath(); ctx.arc(x, top, i - 1 === hot ? 5.5 : 4, 0, Math.PI * 2); ctx.fill();
      // pan tick
      ctx.fillStyle = css('--text', '#ddd');
      ctx.fillRect(x - 0.5 + pan * 7, top + 7, 1.5, 6);
      if (p[`t${i}Filter`] !== 'off' && on) { ctx.font = '9px sans-serif'; ctx.fillText(p[`t${i}Filter`][0].toUpperCase(), x + 5, top + 4); }
    }
    ctx.globalAlpha = 1;
  }
  const tapAt = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = 12;
    for (let i = 1; i <= MULTITAP_COUNT; i++) {
      const tx = p[`t${i}Pos`] * r.width, ty = r.height - 4 - p[`t${i}Level`] * (r.height - 12);
      const d = Math.abs(tx - x) + (p[`t${i}On`] ? 0 : 6) + Math.max(0, Math.abs(ty - y) - 30) * 0.3;
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, x: x / r.width, y: 1 - (y - 8) / (r.height - 12) };
  };
  const snap = (v) => Math.min(1, Math.max(GRID, Math.round(v / GRID) * GRID));
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  canvas.addEventListener('pointerdown', (ev) => {
    const t = tapAt(ev);
    if (t.i < 0) return;
    ev.preventDefault();
    hot = t.i - 1;
    const r = canvas.getBoundingClientRect();
    const pos0 = p[`t${t.i}Pos`], lv0 = p[`t${t.i}Level`];
    startDrag(ev, (dx, dy, e) => {
      const pos = e.shiftKey ? pos0 : snap(pos0 + dx / r.width);
      const lv = Math.round(clamp01(lv0 - dy / (r.height - 12)) * 100) / 100;
      p = { ...p, [`t${t.i}Pos`]: pos, [`t${t.i}Level`]: lv };
      draw();
      api.edit(`Multitap: tap ${t.i}`, (o) => { o[`t${t.i}Pos`] = pos; o[`t${t.i}Level`] = lv; }, { coalesce: true });
    }, () => { hot = -1; draw(); });
  });
  canvas.addEventListener('dblclick', (ev) => {
    const t = tapAt(ev);
    const r = canvas.getBoundingClientRect();
    const near = t.i > 0 && p[`t${t.i}On`] && Math.abs(p[`t${t.i}Pos`] * r.width - (ev.clientX - r.left)) < 8;
    if (near) { api.edit(`Multitap: remove tap ${t.i}`, (o) => { o[`t${t.i}On`] = false; }); return; }
    let free = 0;
    for (let i = 1; i <= MULTITAP_COUNT && !free; i++) if (!p[`t${i}On`]) free = i;
    if (!free) return;
    const pos = snap(t.x), lv = Math.round(clamp01(t.y) * 100) / 100;
    api.edit(`Multitap: add tap ${free}`, (o) => { o[`t${free}On`] = true; o[`t${free}Pos`] = pos; o[`t${free}Level`] = lv || 0.5; });
  });
  requestAnimationFrame(draw);
  return {
    update(fx) { p = resolveEffectParams(fx); draw(); },
  };
}

export default { multitap: multitapEditor };
