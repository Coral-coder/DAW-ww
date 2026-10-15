// Spectrum analyzer view (SPAN-style): windowed FFT 1k–32k, log axis 20 Hz – 20 kHz, slope tilt, averaging,
// fractional-octave smoothing, L+R / L / R / M / S, peak-hold and max traces (Reset), hover readout (frequency, note,
// level) and a compare trace from the probe's key input (another track, fed like a sidechain).
import { h, fitCanvas } from '../dom.js';
import {
  SpectrumAnalyzer, slopeGains, averageInto, smoothCoef, octaveSmooth, bandEdges, resampleBands, PeakHold, maxInto,
  freqToNorm, normToFreq, noteOf, formatHz, channelOf,
} from '../../audio/dsp/scope.js';
import { alpha, chColor, emptyMessage, label, toolButton } from './common.js';

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const tickLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

export function createSpectrum({ getParams, compact = false }) {
  const canvas = h('canvas.an-canvas');
  const el = h('div.an-stage', canvas);
  let frozen = false;
  const tools = [
    toolButton('Freeze', 'Freeze the display', (on) => { frozen = on; }, { toggle: true }),
    toolButton('Reset', 'Reset the peak-hold and max traces', () => resetHolds()),
  ];
  let an = null, slopeKey = '', slope = null, edgesKey = '', edges = null;
  const avg = {}; // trace -> Float32Array power (bins)
  let sm = null;
  let disp = {}; // trace -> Float32Array dB (display points)
  let hold = null, max = null;
  let hover = null; // {x, y}
  const bufs = {};
  const buf = (k, n) => (bufs[k] && bufs[k].length === n ? bufs[k] : (bufs[k] = new Float32Array(n)));
  function resetHolds() { hold?.reset(); max?.fill(-200); }

  function process(name, power, k, p, nb) {
    let a = avg[name];
    const fresh = !a || a.length !== nb;
    if (fresh) a = avg[name] = new Float32Array(nb);
    for (let i = 0; i < nb; i++) power[i] *= slope[i];
    averageInto(a, power, fresh ? 0 : k);
    if (!sm || sm.length !== nb) sm = new Float32Array(nb);
    const src = p.smoothing > 0 ? octaveSmooth(a, Number(p.smoothing), sm) : a;
    const out = disp[name] && disp[name].length === edges.length - 1 ? disp[name] : new Float32Array(edges.length - 1);
    disp[name] = resampleBands(src, an.binHz, edges, out);
  }

  function compute(io, dt, p, w) {
    const size = Number(p.fftSize) || 8192;
    const d = io.read(size);
    if (!d) return false;
    if (!an || an.size !== size) { an = new SpectrumAnalyzer(size); for (const k of Object.keys(avg)) delete avg[k]; disp = {}; }
    an.binHz = d.sr / size;
    const nb = size / 2 + 1;
    const sk = `${size}|${p.slope}|${d.sr}`;
    if (sk !== slopeKey) { slopeKey = sk; slope = slopeGains(nb, an.binHz, Number(p.slope)); }
    const fmax = Math.min(20000, d.sr / 2);
    const npts = Math.max(48, Math.round(w / (compact ? 2 : 1.5)));
    const ek = `${npts}|${fmax}`;
    if (ek !== edgesKey) { edgesKey = ek; edges = bandEdges(npts, 'log', 20, fmax); disp = {}; hold = new PeakHold(npts); max = new Float32Array(npts).fill(-200); }
    const k = smoothCoef(dt, p.average / 1000);
    const ch = p.channel;
    const off = d.size - size;
    const L = d.l.subarray(off), R = d.r.subarray(off);
    if (ch === 'stereo') {
      an.analyze(L, R, p.window);
      process('L', an.pa, k, p, nb); process('R', an.pb, k, p, nb);
      delete disp.M;
    } else if (ch === 'L' || ch === 'R') {
      an.analyze(ch === 'L' ? L : R, null, p.window);
      process('M', an.pa, k, p, nb);
      delete disp.L; delete disp.R;
    } else {
      const m = channelOf(L, R, 'M', buf('m', size)), s = channelOf(L, R, 'S', buf('s', size));
      an.analyze(m, s, p.window);
      process('M', ch === 'S' ? an.pb : an.pa, k, p, nb);
      delete disp.L; delete disp.R;
    }
    // compare (key input): same channel view, mono for L+R
    if (io.probe?.hasKey) {
      const kd = io.read(size, 'key');
      if (kd) {
        const KL = kd.l.subarray(kd.size - size), KR = kd.r.subarray(kd.size - size);
        const kc = ch === 'stereo' ? 'M' : ch;
        an.analyze(channelOf(KL, KR, kc, buf('k', size)), null, p.window);
        process('key', an.pa, k, p, nb);
      }
    } else delete disp.key;
    // main level (loudest of the shown channels) -> hold / max
    const main = disp.M || maxOf(disp.L, disp.R, buf('mx', edges.length - 1));
    disp.main = main;
    hold.update(main, dt, p.holdTime >= 20 ? Infinity : p.holdTime, 15);
    maxInto(max, main);
    return true;
  }

  function frame(io, dt, th) {
    const p = getParams();
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, H);
    const top = p.top, floor = Math.min(p.floor, top - 6);
    const yOf = (db) => ((top - db) / (top - floor)) * H;
    const fmax = an && io.probe ? Math.min(20000, io.probe.sampleRate / 2) : 20000;
    const xOf = (f) => freqToNorm(f, 'log', 20, fmax) * w;
    gridLines(ctx, w, H, th, xOf, yOf, top, floor, compact);
    if (!io.probe) { emptyMessage(ctx, w, H, th, 'No signal'); return; }
    if (!frozen && !compute(io, dt, p, w)) { emptyMessage(ctx, w, H, th, 'No signal'); return; }
    if (!edges || !disp.main) return;
    const n = edges.length - 1;
    const xs = (i) => (i + 0.5) * (w / n);
    if (disp.key) { drawCurve(ctx, disp.key, xs, yOf, H, th.text3, true, 0.22, 1); }
    const traces = disp.M ? [['M', disp.M]] : [['L', disp.L], ['R', disp.R]];
    const chName = p.channel === 'stereo' ? null : p.channel;
    for (const [name, arr] of traces) {
      const col = chColor(th, chName === 'S' ? 'S' : chName === 'L' ? 'L' : chName === 'R' ? 'R' : name === 'M' ? 'M' : name);
      drawCurve(ctx, arr, xs, yOf, H, col, p.fill, traces.length > 1 ? 0.1 : 0.16, 1.5);
    }
    if (p.showMax) drawCurve(ctx, max, xs, yOf, H, th.warn, false, 0, 1, 0.9);
    if (p.peakHold) drawCurve(ctx, hold.v, xs, yOf, H, th.text2, false, 0, 1, 0.55);
    // legend
    if (!compact) {
      const parts = [p.channel === 'stereo' ? 'L+R' : p.channel, `${p.fftSize}`, Number(p.slope) ? `${p.slope} dB/oct` : 'flat'];
      if (disp.key) parts.push('compare');
      if (frozen) parts.push('FROZEN');
      label(ctx, parts.join(' · '), w - 6, 13, th, { align: 'right', color: frozen ? th.warn : th.text3, size: 9 });
    }
    // hover readout
    if (hover && hover.x >= 0 && hover.x <= w) {
      const t = hover.x / w;
      const f = normToFreq(t, 'log', 20, fmax);
      const i = Math.max(0, Math.min(n - 1, Math.floor(t * n)));
      const lv = disp.main[i];
      ctx.fillStyle = alpha(th.text, 0.35);
      ctx.fillRect(Math.round(hover.x), 0, 1, H);
      const y = yOf(lv);
      ctx.fillStyle = th.text; ctx.beginPath(); ctx.arc(hover.x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      const nt = noteOf(f, { a4: p.a4 });
      const txt = `${formatHz(f)} · ${nt ? `${nt.label} ${nt.cents >= 0 ? '+' : '−'}${Math.abs(nt.cents).toFixed(0)}¢` : ''} · ${lv > -199 ? lv.toFixed(1) : '−∞'} dB${disp.key ? ` (cmp ${disp.key[i].toFixed(1)})` : ''}`;
      label(ctx, txt, Math.min(w - 4, Math.max(4, hover.x + (hover.x > w * 0.6 ? -8 : 8))), Math.max(26, Math.min(H - 6, hover.y)), th, { align: hover.x > w * 0.6 ? 'right' : 'left', size: compact ? 9 : 10, weight: 600 });
    }
  }

  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  canvas.addEventListener('pointerleave', () => { hover = null; });
  canvas.addEventListener('dblclick', resetHolds);
  return { el, tools, frame };
}

function maxOf(a, b, out) {
  for (let i = 0; i < out.length; i++) out[i] = Math.max(a ? a[i] : -200, b ? b[i] : -200);
  return out;
}

function drawCurve(ctx, arr, xs, yOf, H, color, fill, fillAlpha, lw, a = 1) {
  const n = arr.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const y = Math.min(H + 2, yOf(arr[i])); if (i === 0) ctx.moveTo(xs(i), y); else ctx.lineTo(xs(i), y); }
  if (fill) {
    ctx.save();
    ctx.lineTo(xs(n - 1), H + 2); ctx.lineTo(xs(0), H + 2); ctx.closePath();
    ctx.fillStyle = alpha(color, fillAlpha);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const y = Math.min(H + 2, yOf(arr[i])); if (i === 0) ctx.moveTo(xs(i), y); else ctx.lineTo(xs(i), y); }
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = a;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function gridLines(ctx, w, H, th, xOf, yOf, top, floor, compact) {
  ctx.fillStyle = alpha(th.line, 0.7);
  ctx.font = th.font(9);
  for (const f of FREQ_TICKS) {
    const x = Math.round(xOf(f));
    ctx.fillRect(x, 0, 1, H);
  }
  const span = top - floor;
  const step = span > 90 ? 12 : span > 40 ? 6 : 3;
  for (let db = Math.ceil(floor / step) * step; db <= top; db += step) {
    const y = Math.round(yOf(db));
    ctx.fillStyle = alpha(th.line, db === 0 ? 1 : 0.55);
    ctx.fillRect(0, y, w, 1);
    if (!compact || db % 24 === 0) { ctx.fillStyle = th.text3; ctx.fillText(String(db), 3, y - 2); }
  }
  ctx.fillStyle = th.text3;
  for (const f of FREQ_TICKS) {
    if (compact && ![100, 1000, 10000].includes(f)) continue;
    const x = xOf(f);
    if (x < 14 || x > w - 14) continue;
    ctx.fillText(tickLabel(f), x + 2, H - 3);
  }
}
