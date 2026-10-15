// EQ curve editor for the 'eq8' (Parametric EQ) and 'eq3' (EQ Three) cards: the combined frequency response
// (dsp/eq-curve.js — the Web Audio biquad formulas, so it matches what is heard) over a live post-EQ spectrum (the
// builder's probe analyser), with a handle per band: drag = frequency / gain, wheel = Q (bells, cuts, notches),
// double-click = reset the gain (eq8: Alt-double-click toggles the band), Shift = fine.
import { h, fitCanvas } from '../dom.js';
import { resolveEffectParams } from '../../audio/effect-defs.js';
import { eqBands, eqResponse, bandResponse, logFreqs, freqToX, xToFreq, dbToY, yToDb } from '../../audio/dsp/eq-curve.js';

const RANGE = 24; // ± dB on the display
const GRID_F = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const GRID_DB = [-18, -12, -6, 0, 6, 12, 18];
const fmtF = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} k` : `${Math.round(f)}`);
const BAND_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];

function eqCard(el, api) {
  const type = api.fx.type;
  const cv = h('canvas.eqc-canvas', { title: 'Drag a band handle: frequency / gain · wheel: Q · double-click: reset gain' + (type === 'eq8' ? ' · Alt-double-click: band on / off' : '') + ' · Shift: fine' });
  const info = h('div.eqc-info');
  const wrap = h('div.eqc', cv, info);
  const params = el.querySelector('.dv-params');
  el.insertBefore(wrap, params || null);

  let p = resolveEffectParams(api.fx);
  let bands = eqBands(type, p);
  let drag = null; // {band, x0, y0, f0, g0}
  let hover = -1;
  let raf = 0;
  let bins = null;
  let geom = { w: 1, h: 1 };
  const sr = () => api.probe()?.sampleRate || api.engine?.ctx?.sampleRate || 48000;

  const handlePos = (b, w, H) => ({ x: freqToX(b.freq, w), y: b.hasGain ? dbToY(b.gain, H, RANGE) : dbToY(0, H, RANGE) });
  const nearest = (x, y) => {
    let best = -1, bd = 14 * 14;
    bands.forEach((b, i) => { const q = handlePos(b, geom.w, geom.h); const d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const setInfo = (b) => {
    if (!b) { info.textContent = ''; return; }
    info.textContent = `${type === 'eq8' ? `Band ${b.label}` : b.label} · ${fmtF(b.freq)} Hz${b.hasGain ? ` · ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB` : ''}${b.hasQ ? ` · Q ${b.q.toFixed(2)}` : ''}${b.on ? '' : ' · off'}`;
  };
  const edit = (label, fn) => api.edit(label, fn, { coalesce: true });
  /** Apply locally (instant redraw) and to the project. */
  const setBand = (b, patch, label) => {
    Object.assign(b, patch);
    const kv = {};
    if ('freq' in patch) kv[b.keys.freq] = Math.round(Math.max(20, Math.min(20000, patch.freq)));
    if ('gain' in patch && b.keys.gain) kv[b.keys.gain] = Math.round(Math.max(-24, Math.min(type === 'eq3' ? 12 : 24, patch.gain)) * 10) / 10;
    if ('q' in patch && b.keys.q) kv[b.keys.q] = Math.round(Math.max(0.1, Math.min(type === 'eq3' ? 10 : 18, patch.q)) * 100) / 100;
    if ('on' in patch && b.keys.on) kv[b.keys.on] = !!patch.on;
    Object.assign(p, kv);
    edit(label, (pp) => Object.assign(pp, kv));
    setInfo(b);
    draw();
  };

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect();
    const i = nearest(e.clientX - r.left, e.clientY - r.top);
    if (i < 0) return;
    e.preventDefault();
    cv.setPointerCapture?.(e.pointerId);
    const b = bands[i];
    drag = { i, x: e.clientX, y: e.clientY, fx: freqToX(b.freq, geom.w), gy: dbToY(b.gain, geom.h, RANGE) };
    if (type === 'eq8' && !b.on) setBand(b, { on: true }, `EQ band ${b.label} on`);
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    if (!drag) {
      const i = nearest(e.clientX - r.left, e.clientY - r.top);
      if (i !== hover) { hover = i; cv.style.cursor = i >= 0 ? 'grab' : ''; setInfo(bands[i]); draw(); }
      return;
    }
    const k = e.shiftKey ? 0.2 : 1;
    const b = bands[drag.i];
    const patch = { freq: xToFreq(drag.fx + (e.clientX - drag.x) * k, geom.w) };
    if (b.hasGain) patch.gain = yToDb(drag.gy + (e.clientY - drag.y) * k, geom.h, RANGE);
    setBand(b, patch, 'EQ band');
  });
  const end = () => { drag = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { if (!drag && hover >= 0) { hover = -1; setInfo(null); draw(); } });
  cv.addEventListener('wheel', (e) => {
    const r = cv.getBoundingClientRect();
    const i = hover >= 0 ? hover : nearest(e.clientX - r.left, e.clientY - r.top);
    const b = bands[i];
    if (!b || !b.hasQ) return;
    e.preventDefault();
    const f = Math.pow(e.shiftKey ? 1.03 : 1.12, -Math.sign(e.deltaY));
    setBand(b, { q: b.q * f }, 'EQ band Q');
  }, { passive: false });
  cv.addEventListener('dblclick', (e) => {
    const r = cv.getBoundingClientRect();
    const b = bands[nearest(e.clientX - r.left, e.clientY - r.top)];
    if (!b) return;
    if (e.altKey && b.keys.on) setBand(b, { on: !b.on }, `EQ band ${b.label} ${b.on ? 'off' : 'on'}`);
    else if (b.hasGain) setBand(b, { gain: 0 }, 'Reset EQ band gain');
  });

  function draw() {
    if (!wrap.isConnected) return;
    const { ctx, w, h: H } = fitCanvas(cv);
    geom = { w, h: H };
    const cs = getComputedStyle(wrap);
    const accent = cs.getPropertyValue('--accent').trim() || '#7c5cff';
    const grid = cs.getPropertyValue('--line').trim() || 'rgba(255,255,255,.1)';
    const text3 = cs.getPropertyValue('--text-3').trim() || '#888';
    ctx.clearRect(0, 0, w, H);
    // grid
    ctx.fillStyle = grid;
    ctx.font = '9px system-ui';
    for (const f of GRID_F) { const x = Math.round(freqToX(f, w)); ctx.fillRect(x, 0, 1, H); }
    for (const d of GRID_DB) { const y = Math.round(dbToY(d, H, RANGE)); ctx.fillRect(0, y, w, d === 0 ? 1.5 : 1); }
    ctx.fillStyle = text3;
    for (const f of [100, 1000, 10000]) ctx.fillText(fmtF(f), freqToX(f, w) + 2, H - 3);
    for (const d of [-12, 12]) ctx.fillText(`${d > 0 ? '+' : ''}${d}`, 2, dbToY(d, H, RANGE) - 2);
    // live spectrum (post-EQ), −90…0 dBFS over the full height
    const an = api.probe()?.analyser;
    if (an) {
      if (!bins || bins.length !== an.frequencyBinCount) bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(bins);
      const binHz = sr() / an.fftSize;
      ctx.beginPath();
      ctx.moveTo(0, H);
      const n = Math.max(48, Math.floor(w / 2));
      for (let i = 0; i <= n; i++) {
        const f0 = xToFreq((i / n) * w, w), f1 = xToFreq(((i + 1) / n) * w, w);
        let mx = -140;
        for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.max(Math.floor(f0 / binHz) + 1, Math.ceil(f1 / binHz)) && k < bins.length; k++) if (bins[k] > mx) mx = bins[k];
        ctx.lineTo((i / n) * w, H - ((Math.max(-90, Math.min(0, mx)) + 90) / 90) * H);
      }
      ctx.lineTo(w, H);
      ctx.closePath();
      ctx.fillStyle = 'rgba(140,160,200,.16)';
      ctx.fill();
    }
    // per-band curves (selected / hovered band filled), then the sum
    const freqs = logFreqs(Math.max(64, Math.floor(w / 2)));
    const rate = sr();
    const focus = drag ? drag.i : hover;
    if (focus >= 0 && bands[focus]?.on) {
      const r = bandResponse(bands[focus], freqs, rate);
      ctx.beginPath();
      ctx.moveTo(0, dbToY(0, H, RANGE));
      for (let i = 0; i < freqs.length; i++) ctx.lineTo(freqToX(freqs[i], w), dbToY(r[i], H, RANGE));
      ctx.lineTo(w, dbToY(0, H, RANGE));
      ctx.fillStyle = `${BAND_COLORS[focus % 8]}33`;
      ctx.fill();
    }
    const resp = eqResponse(bands, freqs, rate, p.output || 0);
    ctx.beginPath();
    for (let i = 0; i < freqs.length; i++) { const x = freqToX(freqs[i], w), y = dbToY(resp[i], H, RANGE); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
    // handles
    bands.forEach((b, i) => {
      const q = handlePos(b, w, H);
      ctx.beginPath();
      ctx.arc(q.x, q.y, i === focus ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = b.on ? BAND_COLORS[i % 8] : 'rgba(128,128,128,.35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#111'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(type === 'eq8' ? b.label : b.label[0], q.x, q.y + 0.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    });
  }

  const loop = () => {
    if (!wrap.isConnected) { raf = 0; return; }
    raf = requestAnimationFrame(loop);
    if (api.probe()?.analyser || drag) draw();
  };
  requestAnimationFrame(() => { draw(); if (!raf) raf = requestAnimationFrame(loop); });

  return {
    update(fx) {
      if (drag) return; // the drag is the source of truth until release
      p = resolveEffectParams(fx);
      bands = eqBands(type, p);
      if (hover >= 0) setInfo(bands[hover]);
      draw();
    },
    dispose() { if (raf) cancelAnimationFrame(raf); raf = 0; wrap.remove(); },
  };
}

export default { eq8: eqCard, eq3: eqCard };
