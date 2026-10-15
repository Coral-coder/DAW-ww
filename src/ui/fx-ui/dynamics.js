// Custom UI for dynamics effects, keyed by effect type. Each entry is (el, api) => ({ update?(fx), dispose?() }).
// el is the effect card body (generic param knobs are already in it); api = { fx, tgt, engine, app, probe(), edit }.
// Animation loops must stop by themselves once el.isConnected is false (cards are rebuilt without a dispose call).
//
// Dynamics cards show transfer curves and gain-reduction meters (live from the worklet meters in the probe);
// EQ cards show frequency-response curves with draggable band handles. Match EQ adds capture buttons and its three
// curves (reference, this track, correction).
import { h, fitCanvas } from '../dom.js';
import { contextMenu, fileInput } from '../components.js';
import { resolveEffectParams, EFFECT_DEFS } from '../../audio/effect-defs.js';
import { compressGain, upwardGain, expandGain } from '../../audio/fx/dsp/dynamics-core.js';
import { bandsMag, rbjCoefs, biquadMag, analogMag, linToDb } from '../../audio/fx/dsp/curve-math.js';
import { MATCH_FREQS, bandsFromPower, dbBinsToPower, averageSpectrum, smoothSpectrum, packCurve, firTaps, firLatency } from '../../audio/fx/dsp/fir.js';
import { linEqBands, matchCorrection, MATCH_SMOOTHING } from '../../audio/fx/builders/dynamics.js';

// ------------------------------------------------------------------------------------ shared bits
const STYLE = `
.fxd { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: flex-start; }
.fxd-cardrow { display: flex; align-items: flex-start; gap: 8px; }
.fxd-cardrow > .fxd { flex: none; flex-wrap: nowrap; margin-top: 0; }
.fxd-cardrow > .dv-params { flex: none; }
.fxd-box { display: flex; flex-direction: column; gap: 3px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 5px 5px; }
.fxd-box > span.fxd-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); display: flex; gap: 6px; align-items: center; }
.fxd-box > span.fxd-lbl b { font-weight: 600; color: var(--text-2); font-family: var(--mono); letter-spacing: 0; text-transform: none; }
.fxd-cv { display: block; touch-action: none; }
.fxd-cv.wide { width: 320px; height: 120px; }
.fxd-cv.mid { width: 220px; height: 84px; }
.fxd-cv.sq { width: 120px; height: 120px; }
.fxd-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.fxd-btn { font-size: 10px; background: var(--bg-3); border: 1px solid var(--line); border-radius: 3px; padding: 2px 7px; cursor: pointer; color: var(--text-2); height: 21px; }
.fxd-btn:hover { color: var(--text); border-color: var(--accent); }
.fxd-btn.on { background: var(--accent); border-color: transparent; color: #fff; }
.fxd-btn.rec.on { background: var(--rec, var(--bad)); }
.fxd-btn.solo.on { background: var(--warn); color: #000; }
.fxd-gr { position: relative; width: 120px; height: 10px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 2px; overflow: hidden; }
.fxd-gr > i { position: absolute; right: 0; top: 0; bottom: 0; width: 0; background: var(--warn); opacity: .85; }
.fxd-gr > i.up { left: 0; right: auto; background: var(--good); }
.fxd-gr > em { position: absolute; inset: 0; font: 8px/10px var(--mono); font-style: normal; text-align: center; color: var(--text); }
.fxd-led { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--bg-4); }
.fxd-led.on { background: var(--good); box-shadow: 0 0 5px var(--good); }
.fxd-note { font-size: 10px; color: var(--text-3); max-width: 320px; }
`;
function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('fxd-style')) return;
  document.head.appendChild(h('style#fxd-style', STYLE));
}

const FMIN = 20, FMAX = 20000;
const xOfF = (f, w) => (Math.log(Math.max(FMIN, f) / FMIN) / Math.log(FMAX / FMIN)) * w;
const fOfX = (x, w) => FMIN * Math.pow(FMAX / FMIN, Math.min(1, Math.max(0, x / w)));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function palette(el) {
  const c = getComputedStyle(el);
  const v = (n, d) => c.getPropertyValue(n).trim() || d;
  return { accent: v('--accent', '#7c5cff'), accent2: v('--accent-2', '#22d3ee'), accent3: v('--accent-3', '#f472b6'), warn: v('--warn', '#f59e0b'), good: v('--good', '#22c55e'), bad: v('--bad', '#ef4444'), line: v('--line', '#333'), text2: v('--text-2', '#aaa'), text3: v('--text-3', '#777'), bg2: v('--bg-2', '#16181f') };
}

/** rAF loop at ~fps; stops once el has been connected and is not any more (or never connects within ~5 s). */
function loop(el, fn, fps = 30) {
  let last = 0, seen = false, frames = 0, raf = 0;
  const tick = (t) => {
    if (el.isConnected) seen = true;
    else if (seen || ++frames > 300) return;
    raf = requestAnimationFrame(tick);
    if (!seen || t - last < 1000 / fps) return;
    last = t;
    try { fn(); } catch (e) { console.warn('[fx-ui]', e); }
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** Put the visuals left of the generic knobs (wide cards would otherwise scroll them out of view). */
function mount(el, wrap) {
  const params = [...el.children].find((c) => c.classList?.contains('dv-params'));
  if (!params) { el.appendChild(wrap); return; }
  const row = h('div.fxd-cardrow');
  el.insertBefore(row, params);
  row.append(wrap, params);
}

function canvas(cls) { return h(`canvas.fxd-cv.${cls}`); }
function box(label, ...kids) { const lbl = h('span.fxd-lbl', label); return { el: h('div.fxd-box', lbl, ...kids), lbl }; }
function btn(label, title, onClick, cls = '') { return h(`button.fxd-btn${cls ? '.' + cls : ''}`, { type: 'button', title, onClick }, label); }

/** Horizontal gain meter: set(db) — negative = reduction (warn, from the right), positive = boost (good, from the left). */
function grMeter(title = 'Gain reduction', range = 24) {
  const fill = h('i'), up = h('i.up'), txt = h('em');
  const el = h('div.fxd-gr', { title }, fill, up, txt);
  let shown = 0;
  return {
    el,
    set(db) {
      db = Number.isFinite(db) ? db : 0;
      shown = db < shown ? db : shown * 0.85 + db * 0.15; // fast attack, smooth fall-back
      fill.style.width = `${clamp(-shown / range, 0, 1) * 100}%`;
      up.style.width = `${clamp(shown / range, 0, 1) * 100}%`;
      txt.textContent = Math.abs(shown) >= 0.1 ? `${shown > 0 ? '+' : '−'}${Math.abs(shown).toFixed(1)} dB` : '';
    },
  };
}

function freqGrid(g, w, H, col, dbMax) {
  g.strokeStyle = col.line; g.lineWidth = 1; g.globalAlpha = 0.6;
  g.font = '8px sans-serif'; g.fillStyle = col.text3;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOfF(f, w)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    if (f === 100 || f === 1000 || f === 10000) g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 2);
  }
  for (const d of [-dbMax / 2, 0, dbMax / 2]) {
    const y = Math.round(H / 2 - (d / dbMax) * (H / 2)) + 0.5;
    g.globalAlpha = d === 0 ? 0.9 : 0.4;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  g.globalAlpha = 1;
}

function plotCurve(g, w, H, dbAt, dbMax, color, width = 1.6, dash = null, fill = false) {
  const N = Math.max(64, Math.floor(w));
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * w;
    const y = H / 2 - (clamp(dbAt(fOfX(x, w)), -dbMax * 1.2, dbMax * 1.2) / dbMax) * (H / 2);
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []);
  g.stroke();
  g.setLineDash([]);
  if (fill) {
    g.lineTo(w, H / 2); g.lineTo(0, H / 2); g.closePath();
    g.globalAlpha = 0.12; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  }
}

/** Transfer curve (input dB → output dB) over [lo, 0] with a level dot. */
function drawTransfer(cv, gainAt, { lo = -60, level = null, marks = [] } = {}) {
  const { ctx: g, w, h: H } = fitCanvas(cv);
  const col = palette(cv);
  g.clearRect(0, 0, w, H);
  const X = (d) => ((d - lo) / -lo) * w, Y = (d) => H - ((d - lo) / -lo) * H;
  g.strokeStyle = col.line; g.lineWidth = 1;
  for (let d = lo; d <= 0; d += 12) { g.globalAlpha = 0.4; g.beginPath(); g.moveTo(X(d), 0); g.lineTo(X(d), H); g.moveTo(0, Y(d)); g.lineTo(w, Y(d)); g.stroke(); }
  g.globalAlpha = 0.8; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(X(lo), Y(lo)); g.lineTo(X(0), Y(0)); g.stroke(); g.setLineDash([]);
  for (const m of marks) { g.strokeStyle = m.color || col.text3; g.globalAlpha = 0.7; g.setLineDash(m.dash || [3, 3]); g.beginPath(); g.moveTo(X(m.db), 0); g.lineTo(X(m.db), H); g.stroke(); g.setLineDash([]); }
  g.globalAlpha = 1;
  g.strokeStyle = col.accent; g.lineWidth = 1.8;
  g.beginPath();
  const N = Math.max(48, Math.floor(w));
  for (let i = 0; i <= N; i++) {
    const d = lo + (i / N) * -lo;
    const y = Y(clamp(d + gainAt(d), lo - 6, 6));
    if (i) g.lineTo(X(d), y); else g.moveTo(X(d), y);
  }
  g.stroke();
  if (level != null && level > lo) {
    const d = Math.min(0, level);
    g.fillStyle = col.warn;
    g.beginPath(); g.arc(X(d), Y(clamp(d + gainAt(d), lo, 6)), 3.2, 0, Math.PI * 2); g.fill();
  }
}

const paramsOf = (fx) => resolveEffectParams(fx);
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}`);

/** Drag helper on a canvas: onDown(x, y, w, h) → handler {move(x, y), up()} | null. */
function dragOn(cv, onDown) {
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    const hd = onDown(e.clientX - r.left, e.clientY - r.top, r.width, r.height, e);
    if (!hd) return;
    e.preventDefault();
    cv.setPointerCapture?.(e.pointerId);
    const mv = (ev) => hd.move(ev.clientX - r.left, ev.clientY - r.top, ev);
    const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); hd.up?.(); };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  });
}
const round = (v, step) => Math.round(v / step) * step;

// ------------------------------------------------------------------------------------ multiband compressor
function multibandUi(el, api) {
  injectStyle();
  let p = paramsOf(api.fx);
  let sel = 1;
  const map = canvas('wide'), tr = canvas('sq');
  const mapBox = box('Bands');
  mapBox.el.append(map);
  const btnRow = h('div.fxd-row');
  mapBox.el.append(btnRow);
  const trBox = box('Transfer');
  trBox.el.append(tr);
  const gr = grMeter('Largest gain reduction of all bands');
  trBox.el.append(gr.el);
  const wrap = h('div.fxd', mapBox.el, trBox.el);
  mount(el, wrap);
  const names3 = ['Low', 'Mid', 'High'], names4 = ['Low', 'Lo-Mid', 'Hi-Mid', 'High'];
  const nb = () => (Number(p.bands) >= 4 ? 4 : 3);
  const xs = () => [p.x1, p.x2, p.x3].slice(0, nb() - 1);
  const renderButtons = () => {
    btnRow.replaceChildren(...Array.from({ length: nb() }, (_, i) => {
      const k = i + 1;
      return h('span.fxd-row', { style: { gap: '2px', marginRight: '6px' } },
        btn((nb() === 4 ? names4 : names3)[i], 'Show this band’s transfer curve', () => { sel = k; draw(); renderButtons(); }, sel === k ? 'on' : ''),
        btn('S', 'Solo band', () => api.edit(`Multiband: solo band ${k}`, (q) => { q[`b${k}Solo`] = !p[`b${k}Solo`]; }), `solo${p[`b${k}Solo`] ? '.on' : ''}`),
        btn('B', 'Bypass band (no compression, no makeup)', () => api.edit(`Multiband: bypass band ${k}`, (q) => { q[`b${k}Bypass`] = !p[`b${k}Bypass`]; }), p[`b${k}Bypass`] ? 'on' : ''));
    }));
  };
  const bandGainAt = (k, d) => {
    let g = 0;
    if (p.mode !== 'up') g += compressGain(d, p[`b${k}Thresh`], p[`b${k}Ratio`], 6);
    if (p.mode !== 'down') g += upwardGain(d, p[`b${k}UpThresh`], p[`b${k}UpRatio`], 6);
    return g * p.depth;
  };
  const draw = () => {
    const m = api.probe()?.meter;
    const { ctx: g, w, h: H } = fitCanvas(map);
    const col = palette(map);
    g.clearRect(0, 0, w, H);
    const edges = [FMIN, ...xs(), FMAX];
    const zero = H * 0.45, scale = H * 0.4 / 24;
    for (let i = 0; i < nb(); i++) {
      const k = i + 1;
      const x0 = xOfF(edges[i], w), x1 = xOfF(edges[i + 1], w);
      const anySolo = Array.from({ length: nb() }, (_, j) => p[`b${j + 1}Solo`]).some(Boolean);
      const muted = anySolo && !p[`b${k}Solo`];
      g.fillStyle = k === sel ? col.accent : col.text3;
      g.globalAlpha = k === sel ? 0.14 : (i % 2 ? 0.05 : 0.09);
      g.fillRect(x0, 0, x1 - x0, H);
      g.globalAlpha = 1;
      const cx = (x0 + x1) / 2, bw = Math.min(18, (x1 - x0) * 0.4);
      const down = m?.gr?.[i] ?? 0, up = m?.up?.[i] ?? 0;
      g.fillStyle = col.warn; g.fillRect(cx - bw / 2, zero, bw, Math.min(H - zero, -down * scale));
      g.fillStyle = col.good; g.fillRect(cx - bw / 2, zero - Math.min(zero, up * scale), bw, Math.min(zero, up * scale));
      g.fillStyle = muted || p[`b${k}Bypass`] ? col.text3 : col.text2;
      g.font = '9px sans-serif'; g.textAlign = 'center';
      g.fillText((nb() === 4 ? names4 : names3)[i] + (p[`b${k}Bypass`] ? ' (byp)' : muted ? ' (muted)' : ''), cx, 10);
      const txt = down < -0.1 ? `−${(-down).toFixed(1)}` : up > 0.1 ? `+${up.toFixed(1)}` : '';
      g.fillStyle = col.text2; g.font = '9px monospace'; g.fillText(txt, cx, H - 4);
    }
    g.textAlign = 'left';
    g.strokeStyle = col.line; g.beginPath(); g.moveTo(0, zero + 0.5); g.lineTo(w, zero + 0.5); g.stroke();
    g.strokeStyle = col.accent2; g.lineWidth = 2;
    for (const f of xs()) { const x = xOfF(f, w); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.lineWidth = 1;
    g.fillStyle = col.accent2; g.font = '8px monospace';
    for (const f of xs()) g.fillText(fmtHz(f), xOfF(f, w) + 3, 20);
    const i = sel - 1;
    drawTransfer(tr, (d) => bandGainAt(sel, d), { level: m?.level?.[i] ?? null, marks: [{ db: p[`b${sel}Thresh`] }, ...(p.mode !== 'down' ? [{ db: p[`b${sel}UpThresh`], color: palette(tr).good }] : [])] });
    trBox.lbl.textContent = `Transfer · band ${sel}`;
    gr.set(m ? Math.min(0, ...(m.gr || [0])) : 0);
  };
  // drag the crossover lines
  const keys = ['x1', 'x2', 'x3'];
  dragOn(map, (x, y, w) => {
    const list = xs();
    let best = -1, bd = 8;
    list.forEach((f, j) => { const d = Math.abs(xOfF(f, w) - x); if (d < bd) { bd = d; best = j; } });
    if (best < 0) {
      // click inside a band selects it
      const edges = [FMIN, ...list, FMAX];
      const f = fOfX(x, w);
      const j = edges.findIndex((e, n) => n > 0 && f <= e);
      if (j > 0) { sel = j; renderButtons(); draw(); }
      return null;
    }
    const def = EFFECT_DEFS.multiband.params.find((d) => d.key === keys[best]);
    return {
      move(mx) {
        const f = clamp(round(fOfX(mx, w), 1), def.min, def.max);
        api.edit('Multiband: crossover', (q) => { q[keys[best]] = f; }, { coalesce: true });
      },
    };
  });
  renderButtons();
  loop(wrap, draw);
  return { update(fx) { p = paramsOf(fx); if (sel > nb()) sel = nb(); renderButtons(); draw(); } };
}

// ------------------------------------------------------------------------------------ transient shaper
function transientUi(el, api) {
  injectStyle();
  let p = paramsOf(api.fx);
  const cv = canvas('mid');
  const b = box('Gain over time');
  b.el.append(cv);
  const wrap = h('div.fxd', b.el);
  mount(el, wrap);
  const hist = [];
  const draw = () => {
    const m = api.probe()?.meter;
    hist.push(m ? [m.min, m.max] : [0, 0]);
    if (m) { m.min = 0; m.max = 0; }
    if (hist.length > 220) hist.shift();
    const { ctx: g, w, h: H } = fitCanvas(cv);
    const col = palette(cv);
    g.clearRect(0, 0, w, H);
    g.strokeStyle = col.line; g.beginPath(); g.moveTo(0, H / 2 + 0.5); g.lineTo(w, H / 2 + 0.5); g.stroke();
    const sc = (H / 2 - 2) / 12;
    const step = w / 220;
    for (let i = 0; i < hist.length; i++) {
      const x = w - (hist.length - i) * step;
      const [lo, hi] = hist[i];
      if (hi > 0) { g.fillStyle = col.good; g.fillRect(x, H / 2 - Math.min(H / 2, hi * sc), step + 0.5, Math.min(H / 2, hi * sc)); }
      if (lo < 0) { g.fillStyle = col.warn; g.fillRect(x, H / 2, step + 0.5, Math.min(H / 2, -lo * sc)); }
    }
    g.fillStyle = col.text3; g.font = '8px sans-serif';
    g.fillText('+12 dB', 2, 9); g.fillText('−12 dB', 2, H - 2);
    b.lbl.replaceChildren('Gain over time ', h('b', `A ${p.attack > 0 ? '+' : ''}${Math.round(p.attack)}% · S ${p.sustain > 0 ? '+' : ''}${Math.round(p.sustain)}%`));
  };
  loop(wrap, draw);
  return { update(fx) { p = paramsOf(fx); } };
}

// ------------------------------------------------------------------------------------ de-esser
function deesserUi(el, api) {
  injectStyle();
  let p = paramsOf(api.fx);
  const cv = canvas('mid');
  const b = box('Detector');
  const gr = grMeter('Gain reduction', 18);
  gr.el.style.width = '220px';
  b.el.append(cv, gr.el);
  const wrap = h('div.fxd', b.el);
  mount(el, wrap);
  const sr = () => api.probe()?.sampleRate || 48000;
  const draw = () => {
    const m = api.probe()?.meter;
    const { ctx: g, w, h: H } = fitCanvas(cv);
    const col = palette(cv);
    g.clearRect(0, 0, w, H);
    freqGrid(g, w, H, col, 48);
    const red = Math.min(0, m?.gr || 0);
    const c = p.detector === 'bp' ? rbjCoefs('bandpass', p.freq, 1.4, 0, sr()) : null;
    const hpAt = (f) => linToDb(c ? biquadMag(c, f, sr()) : analogMag('highpass24', f, p.freq, 0.71, 0));
    // the detector band (top half: 0 dB at the centre line)
    plotCurve(g, w, H, (f) => Math.max(-48, hpAt(f)), 48, col.accent2, 1.4, [3, 3]);
    // the signal's response right now: wide → everything turned down; split → LR4 low + high·g = (1 + g·w⁴) / (1 + w⁴)
    const gl = Math.pow(10, red / 20);
    plotCurve(g, w, H, (f) => {
      if (p.mode === 'wide') return red;
      const w4 = (f / p.freq) ** 4;
      return linToDb((1 + gl * w4) / (1 + w4));
    }, 24, col.warn, 1.8, null, true);
    const x = xOfF(p.freq, w);
    g.fillStyle = col.accent2; g.beginPath(); g.arc(x, H / 2, 4, 0, Math.PI * 2); g.fill();
    g.font = '8px monospace'; g.fillText(`${fmtHz(p.freq)} Hz`, Math.min(w - 40, x + 6), 10);
    gr.set(red);
    b.lbl.replaceChildren('Detector ', h('b', p.listen ? 'listening' : p.mode === 'wide' ? 'wideband' : 'split-band'));
  };
  dragOn(cv, (x, y, w) => {
    if (Math.abs(x - xOfF(p.freq, w)) > 12) return null;
    return { move(mx) { const f = clamp(round(fOfX(mx, w), 10), 2000, 12000); api.edit('De-esser: frequency', (q) => { q.freq = f; }, { coalesce: true }); } };
  });
  loop(wrap, draw);
  return { update(fx) { p = paramsOf(fx); draw(); } };
}

// ------------------------------------------------------------------------------------ expander / gate
function expanderUi(el, api) {
  injectStyle();
  let p = paramsOf(api.fx);
  const cv = canvas('sq');
  const led = h('i.fxd-led');
  const b = box('Transfer');
  b.lbl.append(led);
  const gr = grMeter('Gain reduction', 40);
  gr.el.style.width = '120px';
  b.el.append(cv, gr.el);
  const wrap = h('div.fxd', b.el);
  mount(el, wrap);
  const draw = () => {
    const m = api.probe()?.meter;
    const col = palette(cv);
    drawTransfer(cv, (d) => expandGain(d, p.threshold, p.ratio, p.range, p.knee), {
      lo: -80,
      marks: [{ db: p.threshold, color: col.accent2 }, { db: p.threshold - p.hysteresis, color: col.text3, dash: [1, 3] }],
    });
    gr.set(m ? m.gr : 0);
    led.classList.toggle('on', m ? !!m.open : false);
    led.title = m?.open ? 'Open' : 'Closed';
  };
  loop(wrap, draw);
  return { update(fx) { p = paramsOf(fx); draw(); } };
}

// ------------------------------------------------------------------------------------ dynamic EQ
function dyneqUi(el, api) {
  injectStyle();
  let p = paramsOf(api.fx);
  const cv = canvas('wide');
  const b = box('Response');
  b.el.append(cv, h('span.fxd-note', 'Dashed: static curve · solid: now (static + dynamic) · drag a dot to move the band'));
  const wrap = h('div.fxd', b.el);
  mount(el, wrap);
  const SR = 48000;
  const bandMag = (k, f, extra) => {
    const t = p[`b${k}Type`];
    return biquadMag(rbjCoefs(t, p[`b${k}Freq`], p[`b${k}Q`], p[`b${k}Gain`] + extra, SR), f, SR);
  };
  const curve = (dyn) => (f) => {
    let m = 1;
    for (let k = 1; k <= 4; k++) if (p[`b${k}On`]) m *= bandMag(k, f, dyn ? dyn[k - 1] || 0 : 0);
    return linToDb(m);
  };
  const draw = () => {
    const m = api.probe()?.meter;
    const { ctx: g, w, h: H } = fitCanvas(cv);
    const col = palette(cv);
    g.clearRect(0, 0, w, H);
    freqGrid(g, w, H, col, 24);
    // range whiskers: where each band can go
    for (let k = 1; k <= 4; k++) {
      if (!p[`b${k}On`]) continue;
      const x = xOfF(p[`b${k}Freq`], w), y0 = H / 2 - (p[`b${k}Gain`] / 24) * (H / 2), y1 = H / 2 - ((p[`b${k}Gain`] + p[`b${k}Range`]) / 24) * (H / 2);
      g.strokeStyle = col.text3; g.lineWidth = 3; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); g.globalAlpha = 1; g.lineWidth = 1;
    }
    plotCurve(g, w, H, curve(null), 24, col.text2, 1.2, [4, 3]);
    plotCurve(g, w, H, curve(m?.dyn || null), 24, col.accent, 1.8, null, true);
    for (let k = 1; k <= 4; k++) {
      const x = xOfF(p[`b${k}Freq`], w), y = H / 2 - ((p[`b${k}Gain`] + (m?.dyn?.[k - 1] || 0)) / 24) * (H / 2);
      g.fillStyle = p[`b${k}On`] ? col.accent2 : col.text3;
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000'; g.font = 'bold 8px sans-serif'; g.textAlign = 'center'; g.fillText(String(k), x, y + 3); g.textAlign = 'left';
    }
  };
  dragOn(cv, (x, y, w, H, e) => {
    let best = 0, bd = 12;
    for (let k = 1; k <= 4; k++) {
      const d = Math.hypot(xOfF(p[`b${k}Freq`], w) - x, H / 2 - (p[`b${k}Gain`] / 24) * (H / 2) - y);
      if (d < bd) { bd = d; best = k; }
    }
    if (!best) return null;
    if (e.detail >= 2) { api.edit(`Dynamic EQ: band ${best} on/off`, (q) => { q[`b${best}On`] = !p[`b${best}On`]; }); return null; }
    return {
      move(mx, my) {
        const f = clamp(round(fOfX(mx, w), 1), 20, 20000), gdb = clamp(round(((H / 2 - my) / (H / 2)) * 24, 0.1), -24, 24);
        api.edit(`Dynamic EQ: band ${best}`, (q) => { q[`b${best}Freq`] = f; q[`b${best}Gain`] = gdb; q[`b${best}On`] = true; }, { coalesce: true });
      },
    };
  });
  loop(wrap, draw);
  return { update(fx) { p = paramsOf(fx); draw(); } };
}

// ------------------------------------------------------------------------------------ linear-phase EQ
function lineqUi(el, api) {
  injectStyle();
  let p = paramsOf(api.fx);
  const cv = canvas('wide');
  const b = box('Response');
  const note = h('span.fxd-note');
  b.el.append(cv, note);
  const wrap = h('div.fxd', b.el);
  mount(el, wrap);
  const NOGAIN = new Set(['highpass', 'lowpass', 'highpass24', 'lowpass24', 'highpass48', 'lowpass48', 'bandpass', 'notch']);
  const handleY = (bd, H) => H / 2 - ((NOGAIN.has(bd.type) ? 0 : bd.gain) / 24) * (H / 2);
  const draw = () => {
    const bands = linEqBands(p);
    const { ctx: g, w, h: H } = fitCanvas(cv);
    const col = palette(cv);
    g.clearRect(0, 0, w, H);
    freqGrid(g, w, H, col, 24);
    const on = bands.filter((x) => x.on);
    plotCurve(g, w, H, (f) => linToDb(bandsMag(on, f)) + p.output, 24, col.accent, 1.8, null, true);
    bands.forEach((bd, i) => {
      const x = xOfF(bd.freq, w), y = handleY(bd, H);
      g.fillStyle = bd.on ? col.accent2 : col.text3;
      g.globalAlpha = bd.on ? 1 : 0.5;
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      g.fillStyle = '#000'; g.font = 'bold 8px sans-serif'; g.textAlign = 'center'; g.fillText(String(i + 1), x, y + 3); g.textAlign = 'left';
    });
    const sr = api.engine?.ctx?.sampleRate || 48000;
    note.textContent = `Latency ${(firLatency(firTaps(p.quality, sr)) / sr * 1000).toFixed(0)} ms (compensated) · drag dots, wheel = Q, double-click = on/off`;
  };
  const pick = (x, y, w, H) => {
    const bands = linEqBands(p);
    let best = 0, bd = 12;
    bands.forEach((b0, i) => { const d = Math.hypot(xOfF(b0.freq, w) - x, handleY(b0, H) - y); if (d < bd) { bd = d; best = i + 1; } });
    return best;
  };
  dragOn(cv, (x, y, w, H, e) => {
    const k = pick(x, y, w, H);
    if (!k) return null;
    if (e.detail >= 2) { api.edit(`Linear-Phase EQ: band ${k} on/off`, (q) => { q[`b${k}On`] = !p[`b${k}On`]; }); return null; }
    const gainless = NOGAIN.has(p[`b${k}Type`]);
    return {
      move(mx, my) {
        const f = clamp(round(fOfX(mx, w), 1), 20, 20000), gdb = clamp(round(((H / 2 - my) / (H / 2)) * 24, 0.1), -24, 24);
        api.edit(`Linear-Phase EQ: band ${k}`, (q) => { q[`b${k}Freq`] = f; if (!gainless) q[`b${k}Gain`] = gdb; q[`b${k}On`] = true; }, { coalesce: true });
      },
    };
  });
  cv.addEventListener('wheel', (e) => {
    const r = cv.getBoundingClientRect();
    const k = pick(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (!k) return;
    e.preventDefault();
    const q = clamp(round(p[`b${k}Q`] * Math.pow(1.1, e.deltaY < 0 ? 1 : -1), 0.01), 0.1, 18);
    api.edit(`Linear-Phase EQ: band ${k} Q`, (o) => { o[`b${k}Q`] = q; }, { coalesce: true });
  }, { passive: false });
  loop(wrap, draw, 10);
  return { update(fx) { p = paramsOf(fx); draw(); } };
}

// ------------------------------------------------------------------------------------ match EQ
function matcheqUi(el, api) {
  injectStyle();
  let fxDef = api.fx;
  let p = paramsOf(fxDef);
  const cv = canvas('wide');
  const b = box('Spectra');
  const status = h('span.fxd-note');
  const capRef = btn('● Capture reference', 'Average the spectrum of the reference track while it plays (press again to stop)', () => toggleCapture('ref'), 'rec');
  const capCur = btn('● Capture this track', 'Average this channel’s spectrum while it plays (press again to stop)', () => toggleCapture('cur'), 'rec');
  const imp = btn('Import file…', 'Use an audio file as the reference', () => importFile());
  const clip = btn('From clip ▾', 'Use a sample / clip of this project as the reference', (e) => clipMenu(e));
  const clr = btn('Clear', 'Forget both captured spectra (flat EQ)', () => api.edit('Match EQ: clear', (q) => { delete q.refSpectrum; delete q.curSpectrum; delete q.refName; }));
  const legend = h('span.fxd-note');
  b.el.append(cv, legend, h('div.fxd-row', capRef, capCur, imp, clip, clr), status);
  const wrap = h('div.fxd', b.el);
  mount(el, wrap);
  let cap = null; // { which, acc: Float64Array, n, an, t0 }
  const live = { ref: null, cur: null };

  function toggleCapture(which) {
    if (cap) { const was = cap.which; finishCapture(); if (was === which) return; }
    const pr = api.probe();
    const an = which === 'ref' ? pr?.keyAnalyser : pr?.inAnalyser;
    if (!an) { api.app?.toast?.('Start audio first (press play once) to capture a spectrum.', { level: 'warn' }); return; }
    if (which === 'ref' && !p.sourceTrackId) { api.app?.toast?.('Pick a Reference Track first (or import a file / clip).', { level: 'warn' }); return; }
    cap = { which, an, acc: new Float64Array(an.frequencyBinCount), n: 0, buf: new Float32Array(an.frequencyBinCount), t0: performance.now() };
  }
  function captureTick() {
    if (!cap) return;
    cap.an.getFloatFrequencyData(cap.buf);
    let loud = false;
    for (let i = 0; i < cap.buf.length; i++) if (cap.buf[i] > -110) { loud = true; break; }
    if (!loud) return; // silence (stopped transport) does not count
    const pw = dbBinsToPower(cap.buf);
    for (let i = 0; i < pw.length; i++) cap.acc[i] += pw[i];
    cap.n++;
    const sr = api.probe()?.sampleRate || 48000;
    live[cap.which] = bandsFromPower(cap.acc.map((v) => v / cap.n), sr, cap.an.fftSize);
  }
  function finishCapture() {
    const c = cap;
    cap = null;
    if (!c || c.n < 3) { live.ref = live.cur = null; if (c) api.app?.toast?.('Nothing was captured — play the audio while capturing.', { level: 'warn' }); return; }
    const sr = api.probe()?.sampleRate || 48000;
    const spec = packCurve(bandsFromPower(c.acc.map((v) => v / c.n), sr, c.an.fftSize));
    const secs = ((performance.now() - c.t0) / 1000).toFixed(1);
    const trackName = api.engine?.project?.tracks?.find((t) => t.id === p.sourceTrackId)?.name || api.engine?.project?.buses?.find((t) => t.id === p.sourceTrackId)?.name || 'reference track';
    api.edit(c.which === 'ref' ? 'Match EQ: capture reference' : 'Match EQ: capture this track', (q) => {
      if (c.which === 'ref') { q.refSpectrum = spec; q.refName = `${trackName} (${secs} s)`; } else q.curSpectrum = spec;
    });
    live[c.which] = null;
  }
  async function setRefFromBuffer(buf, name) {
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const spec = packCurve(averageSpectrum(chans, buf.sampleRate));
    api.edit('Match EQ: reference from audio', (q) => { q.refSpectrum = spec; q.refName = name; });
  }
  async function importFile() {
    const [file] = await fileInput('audio/*');
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 48000);
      const buf = await ctx.decodeAudioData(data);
      await setRefFromBuffer(buf, file.name);
    } catch (e) { api.app?.toast?.(`Could not read “${file.name}”: ${e?.message || e}`, { level: 'error' }); }
  }
  function clipMenu(e) {
    const samples = Object.values(api.engine?.project?.samples || {});
    if (!samples.length) { api.app?.toast?.('This project has no audio clips yet.', { level: 'warn' }); return; }
    contextMenu(e, [{ header: 'Reference from clip' }, ...samples.slice(0, 40).map((s) => ({
      label: s.name || s.id,
      onClick: async () => {
        try { const buf = await api.engine.decodeSample(s.id, { full: true }); await setRefFromBuffer(buf, s.name || 'clip'); } catch (err) { api.app?.toast?.(`Could not decode “${s.name}”: ${err?.message || err}`, { level: 'error' }); }
      },
    }))]);
  }

  const norm = (spec) => { // display: level-align on 200 Hz – 5 kHz and smooth like the correction
    if (!spec) return null;
    const s = smoothSpectrum(spec, MATCH_FREQS, MATCH_SMOOTHING[p.smoothing] ?? 1 / 6);
    let a = 0, n = 0;
    MATCH_FREQS.forEach((f, i) => { if (f >= 200 && f <= 5000) { a += s[i]; n++; } });
    const off = n ? a / n : 0;
    return s.map((v) => v - off);
  };
  const plotSpec = (g, w, H, spec, color, dbMax, width, dash) => {
    g.beginPath();
    MATCH_FREQS.forEach((f, i) => { const x = xOfF(f, w), y = H / 2 - (clamp(spec[i], -dbMax * 1.2, dbMax * 1.2) / dbMax) * (H / 2); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]);
  };
  const draw = () => {
    captureTick();
    const { ctx: g, w, h: H } = fitCanvas(cv);
    const col = palette(cv);
    g.clearRect(0, 0, w, H);
    freqGrid(g, w, H, col, 24);
    const ref = norm(live.ref || fxDef.params?.refSpectrum), cur = norm(live.cur || fxDef.params?.curSpectrum);
    if (ref) plotSpec(g, w, H, ref, col.accent2, 36, 1.2);
    if (cur) plotSpec(g, w, H, cur, col.accent3, 36, 1.2);
    const corr = matchCorrection(p, { refSpectrum: live.ref || fxDef.params?.refSpectrum, curSpectrum: live.cur || fxDef.params?.curSpectrum });
    if (corr) plotSpec(g, w, H, corr, col.accent, 24, 2.2);
    for (const lim of [p.lowLimit, p.highLimit]) { const x = xOfF(lim, w); g.strokeStyle = col.text3; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]); }
    capRef.classList.toggle('on', cap?.which === 'ref');
    capCur.classList.toggle('on', cap?.which === 'cur');
    const has = (k) => Array.isArray(fxDef.params?.[k]);
    legend.replaceChildren(
      h('span', { style: { color: col.accent2 } }, '— reference  '), h('span', { style: { color: col.accent3 } }, '— this track  '), h('span', { style: { color: col.accent } }, '— correction'));
    status.textContent = cap ? `Capturing ${cap.which === 'ref' ? 'the reference' : 'this track'}… ${cap.n} frames — press again to stop`
      : `Reference: ${has('refSpectrum') ? fxDef.params.refName || 'captured' : 'none'} · this track: ${has('curSpectrum') ? 'captured' : 'none'}${corr ? '' : ' — capture both to match'}`;
  };
  loop(wrap, draw, 10);
  return { update(fx) { fxDef = fx; p = paramsOf(fx); draw(); } };
}

export default {
  multiband: multibandUi,
  transient: transientUi,
  deesser: deesserUi,
  expander: expanderUi,
  dyneq: dyneqUi,
  lineq: lineqUi,
  matcheq: matcheqUi,
};
