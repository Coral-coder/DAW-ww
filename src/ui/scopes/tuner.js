// Chromatic tuner view (mono sum): YIN pitch -> note, octave, cents and frequency on a needle and a three-row strobe
// (rows at 1×, 2×, 4× speed), in-tune zone, adjustable A4 reference, frequency range and a signal-level gate.
import { h, fitCanvas } from '../dom.js';
import { channelOf, detectPitch, pitchFrameLength, TunerTracker } from '../../audio/dsp/scope.js';
import { alpha, emptyMessage, label } from './common.js';

export const TUNER_RANGES = { full: [25, 4200], bass: [25, 500], guitar: [60, 1500], voice: [70, 1200], high: [200, 4200] };

export function createTuner({ getParams, compact = false }) {
  const canvas = h('canvas.an-canvas.an-tuner');
  const el = h('div.an-stage', canvas);
  const tracker = new TunerTracker();
  let needle = 0, phase = 0, st = { active: false, held: false, note: null, cents: 0, freq: 0, levelDb: -200 };
  let mono = null;

  function frame(io, dt, th) {
    const p = getParams();
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, H);
    const probe = io.probe;
    if (probe) {
      const [minFreq, maxFreq] = TUNER_RANGES[p.range] || TUNER_RANGES.full;
      const sr = probe.sampleRate;
      const need = pitchFrameLength(sr, minFreq, maxFreq);
      const d = io.read(need);
      if (d) {
        if (!mono || mono.length !== d.size) mono = new Float32Array(d.size);
        channelOf(d.l, d.r, 'M', mono);
        const r = detectPitch(mono, sr, { minFreq, maxFreq, threshold: 0.12 });
        tracker.set({ a4: p.a4, gateDb: p.gate, smooth: p.response, flats: p.accidentals === 'flat' });
        st = tracker.push(r, dt);
      }
    }
    const tol = p.tolerance;
    const on = st.active || st.held;
    const inTune = on && Math.abs(st.cents) <= tol;
    const target = on ? Math.max(-50, Math.min(50, st.cents)) : 0;
    needle += (target - needle) * Math.min(1, dt * 14);
    if (st.active && st.note) phase += ((st.freq - st.note.ref) * dt) / Math.max(0.5, st.note.ref / 220); // beat rate, scaled so it stays readable
    const hot = inTune ? th.good : Math.abs(st.cents) > 15 ? th.bad : th.warn;
    const col = on ? (st.active ? hot : alpha(hot, 0.45)) : th.text3;

    const levelH = compact ? 6 : 8;
    const textH = compact ? Math.min(52, H * 0.34) : Math.min(78, H * 0.32);
    const body = H - textH - levelH - 8;
    // ---- note readout
    const name = st.note ? st.note.name : '—';
    const oct = st.note ? String(st.note.octave) : '';
    const big = Math.max(18, Math.min(textH * 0.78, w * 0.16));
    ctx.font = th.font(big, 700);
    const nw = ctx.measureText(name).width;
    ctx.font = th.font(big * 0.45, 600);
    const ow = ctx.measureText(oct).width;
    const x0 = w / 2 - (nw + ow) / 2;
    ctx.fillStyle = on ? th.text : th.text3;
    ctx.font = th.font(big, 700);
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(name, x0, textH * 0.82);
    ctx.font = th.font(big * 0.45, 600);
    ctx.fillStyle = on ? th.text2 : th.text3;
    ctx.fillText(oct, x0 + nw + 2, textH * 0.82);
    const sz = compact ? 10 : 12;
    label(ctx, on ? `${st.cents >= 0 ? '+' : '−'}${Math.abs(st.cents).toFixed(1)} ¢` : '', 8, textH * 0.5, th, { color: col, size: sz + 2, weight: 600, box: false });
    label(ctx, on ? `${st.freq.toFixed(2)} Hz` : 'listening…', w - 8, textH * 0.5, th, { align: 'right', color: on ? th.text2 : th.text3, size: sz, box: false });
    label(ctx, `A4 = ${Number(p.a4).toFixed(p.a4 % 1 ? 1 : 0)} Hz`, w - 8, textH * 0.5 + sz + 4, th, { align: 'right', color: th.text3, size: 9, box: false });
    if (!probe) emptyMessage(ctx, w, textH + body / 2, th, 'No signal');

    // ---- needle / strobe areas
    const y0 = textH + 2;
    const showNeedle = p.display !== 'strobe', showStrobe = p.display !== 'needle';
    const needleH = showNeedle && showStrobe ? body * 0.62 : showNeedle ? body : 0;
    const strobeH = body - needleH - (showNeedle && showStrobe ? 6 : 0);
    if (showNeedle) drawNeedle(ctx, w, y0, needleH, th, needle, tol, col, on, compact);
    if (showStrobe) drawStrobe(ctx, 8, y0 + needleH + (showNeedle ? 6 : 0), w - 16, strobeH, th, phase, on, st.active ? (inTune ? th.good : th.accent) : th.text3);
    // ---- level / gate
    const ly = H - levelH - 2;
    ctx.fillStyle = th.bg3; ctx.fillRect(8, ly, w - 16, levelH);
    const lv = Math.max(0, Math.min(1, (st.levelDb + 90) / 90));
    ctx.fillStyle = st.levelDb >= p.gate ? th.good : th.text3;
    ctx.fillRect(8, ly, (w - 16) * lv, levelH);
    const gx = 8 + (w - 16) * ((p.gate + 90) / 90);
    ctx.fillStyle = th.warn; ctx.fillRect(Math.round(gx), ly - 2, 2, levelH + 4);
  }
  canvas.addEventListener('dblclick', () => tracker.reset());
  return { el, tools: [], frame };
}

function drawNeedle(ctx, w, y, hh, th, cents, tol, col, on, compact) {
  if (hh < 20) return;
  const cx = w / 2, R = Math.min(w * 0.46, hh * 0.92), cy = y + hh - 4;
  const a = (c) => -Math.PI / 2 + (c / 50) * (Math.PI / 3); // ±50 ct = ±60°
  // in-tune zone
  ctx.strokeStyle = alpha(th.good, 0.35);
  ctx.lineWidth = Math.max(6, R * 0.09);
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, a(-tol), a(tol)); ctx.stroke();
  // ticks
  ctx.lineWidth = 1;
  ctx.font = th.font(9);
  ctx.textAlign = 'center';
  for (let c = -50; c <= 50; c += 5) {
    const major = c % 25 === 0, mid = c % 10 === 0;
    const r0 = R * (major ? 0.78 : mid ? 0.84 : 0.88), r1 = R * 0.96;
    ctx.strokeStyle = major ? th.text2 : th.line2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a(c)) * r0, cy + Math.sin(a(c)) * r0);
    ctx.lineTo(cx + Math.cos(a(c)) * r1, cy + Math.sin(a(c)) * r1);
    ctx.stroke();
    if (major && !compact) { ctx.fillStyle = th.text3; ctx.fillText(c > 0 ? `+${c}` : String(c), cx + Math.cos(a(c)) * R * 0.66, cy + Math.sin(a(c)) * R * 0.66 + 3); }
  }
  ctx.textAlign = 'left';
  // needle
  ctx.strokeStyle = col;
  ctx.lineWidth = on ? 2.5 : 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a(cents)) * R * 0.95, cy + Math.sin(a(cents)) * R * 0.95);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
  if (!compact) {
    ctx.fillStyle = th.text3; ctx.font = th.font(10, 600);
    ctx.fillText('♭', cx - R * 0.98, cy - 2);
    ctx.fillText('♯', cx + R * 0.94, cy - 2);
  }
}

function drawStrobe(ctx, x, y, w, hh, th, phase, on, color) {
  if (hh < 8) return;
  const rows = hh > 36 ? 3 : 2;
  const rh = (hh - (rows - 1) * 3) / rows;
  const period = Math.max(16, Math.min(40, w / 12));
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
  ctx.fillStyle = th.bg3; ctx.fillRect(x, y, w, hh);
  ctx.fillStyle = on ? color : alpha(th.text3, 0.4);
  for (let r = 0; r < rows; r++) {
    const ry = y + r * (rh + 3);
    const p = ((phase * Math.pow(2, r)) % 1 + 1) % 1;
    // same stripe pitch on every row; row r moves 2^r times faster (like the octave rows of a mechanical strobe)
    for (let sx = x - period + p * period; sx < x + w; sx += period) ctx.fillRect(sx, ry, period / 2, rh);
  }
  ctx.restore();
}
