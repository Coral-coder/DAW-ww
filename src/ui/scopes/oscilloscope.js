// Oscilloscope view: cycle-locked (pitch period) / zero-crossing / free-run triggering, time window, vertical zoom or
// auto gain, L / R / M / S / L+R / M+S traces, phosphor persistence, freeze and a pitch readout (YIN).
import { h, fitCanvas } from '../dom.js';
import { scopeTrigger, resampleWindow, channelOf, peakOf, detectPitch, pitchFrameLength, noteOf, sampleAt } from '../../audio/dsp/scope.js';
import { alpha, chColor, emptyMessage, label, toolButton } from './common.js';

const PREV_POINTS = 96;

export function createOscilloscope({ getParams, compact = false }) {
  const canvas = h('canvas.an-canvas');
  const el = h('div.an-stage', canvas);
  let frozen = false;
  const freezeBtn = toolButton('Freeze', 'Freeze the display (F)', (on) => { frozen = on; }, { toggle: true });
  const tools = [freezeBtn];
  let prev = null, gainAuto = 1, f0 = 0, f0Age = 9, pitchConf = 0, frameNo = 0;
  let last = null; // frozen frame: {traces: [{ch, pts}], len, sr, gain}
  const bufs = {};
  const buf = (k, n) => (bufs[k] && bufs[k].length === n ? bufs[k] : (bufs[k] = new Float32Array(n)));

  function frame(io, dt, th) {
    const p = getParams();
    const { ctx, w, h: H } = fitCanvas(canvas);
    const probe = io.probe;
    const sr = probe?.sampleRate || 48000;
    const fade = p.persistence > 0 && !frozen ? 1 - Math.pow(p.persistence, dt * 30) : 1;
    ctx.fillStyle = fade >= 1 ? th.bg : alpha(th.bg, fade);
    ctx.fillRect(0, 0, w, H);
    grid(ctx, w, H, th);
    if (!probe) { emptyMessage(ctx, w, H, th, 'No signal'); return; }

    if (!frozen) {
      const period = f0 > 0 ? sr / f0 : 0;
      const cycleMode = p.trigger === 'cycle' && period > 0;
      let len = cycleMode ? p.cycles * period : (p.time / 1000) * sr;
      const search = Math.max(cycleMode ? 2.2 * period : len, 1024);
      const pitchN = p.pitch || p.trigger === 'cycle' ? pitchFrameLength(sr, 30, 4200) : 0;
      const need = Math.max(len + search + 64, pitchN);
      const d = io.read(need);
      if (!d) { emptyMessage(ctx, w, H, th, 'No signal'); return; }
      len = Math.min(len, d.size - 64 - Math.min(search, d.size / 2));
      const mono = channelOf(d.l, d.r, 'M', buf('m', d.size));
      // pitch: YIN on the mono sum, every other frame; held briefly through gaps
      if ((p.pitch || p.trigger === 'cycle') && (frameNo++ % 2 === 0)) {
        const r = detectPitch(mono, sr, { minFreq: 30, maxFreq: 4200 });
        if (r.freq > 0 && r.conf > 0.75 && r.rms > 1e-4) {
          f0 = f0 > 0 && Math.abs(1200 * Math.log2(r.freq / f0)) < 30 ? f0 * 0.6 + r.freq * 0.4 : r.freq;
          pitchConf = r.conf; f0Age = 0;
        } else f0Age += dt * 2;
        if (f0Age > 0.4) f0 = 0;
      }
      const trigCh = p.channel === 'stereo' || p.channel === 'ms' ? 'M' : p.channel;
      const trig = trigCh === 'M' ? mono : channelOf(d.l, d.r, trigCh, buf('t', d.size));
      const pk = peakOf(trig, Math.max(0, d.size - len - search), d.size);
      const mode = p.trigger === 'cycle' ? (cycleMode ? 'cycle' : 'zero') : p.trigger;
      const { pos, triggered } = scopeTrigger(trig, { mode, len, level: p.level, hyst: Math.max(0.002, pk * 0.06), slope: p.slope, prev, search });
      prev = triggered ? resampleWindow(trig, pos, len, PREV_POINTS, prev && prev.length === PREV_POINTS ? prev : undefined) : null;
      const chans = p.channel === 'stereo' ? ['L', 'R'] : p.channel === 'ms' ? ['M', 'S'] : [p.channel];
      const traces = chans.map((ch) => {
        const src = ch === 'M' ? mono : ch === 'L' ? d.l : ch === 'R' ? d.r : channelOf(d.l, d.r, ch, buf('s', d.size));
        return { ch, pts: traceOf(src, pos, len, Math.max(2, Math.round(w))) };
      });
      // auto gain: fast to shrink, ~0.3 s to grow
      let wp = 0;
      for (const t of traces) for (let i = 0; i < t.pts.max.length; i++) wp = Math.max(wp, Math.abs(t.pts.max[i]), Math.abs(t.pts.min[i]));
      const target = Math.min(1000, 0.9 / Math.max(wp, 1e-4));
      gainAuto = target < gainAuto ? target : gainAuto + (target - gainAuto) * Math.min(1, dt * 3);
      last = { traces, len, sr, triggered, mode };
    }
    if (!last) return;
    const gain = p.auto ? gainAuto : p.gain;
    const mid = H / 2, amp = (H / 2) * gain;
    for (const t of last.traces) drawTrace(ctx, t.pts, w, mid, amp, chColor(th, t.ch), last.traces.length > 1 ? 0.95 : 1);
    // readouts
    const ms = (last.len / last.sr) * 1000;
    const trigTxt = frozen ? 'FROZEN' : last.mode === 'free' ? 'FREE' : last.triggered ? (last.mode === 'cycle' ? 'CYCLE LOCK' : 'TRIG') : 'AUTO';
    label(ctx, `${trigTxt} · ${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms · ×${gain < 10 ? gain.toFixed(2) : gain.toFixed(0)}`, 6, 14, th, { color: frozen ? th.warn : th.text2, size: compact ? 9 : 10 });
    if (p.pitch) {
      const n = f0 > 0 ? noteOf(f0, { a4: p.a4 }) : null;
      const txt = n ? `${n.label} ${n.cents >= 0 ? '+' : '−'}${Math.abs(n.cents).toFixed(0)}¢ · ${f0.toFixed(1)} Hz` : '— Hz';
      label(ctx, txt, w - 6, 14, th, { align: 'right', color: n && pitchConf > 0.85 ? th.text : th.text3, size: compact ? 10 : 12, weight: 600 });
    }
    if (last.traces.length > 1 && !compact) {
      let x = 6;
      for (const t of last.traces) { label(ctx, t.ch, x, H - 6, th, { color: chColor(th, t.ch), size: 9 }); x += 16; }
    }
  }

  canvas.addEventListener('dblclick', () => { prev = null; gainAuto = 1; });
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') freezeBtn.click(); });
  return { el, tools, frame };
}

/** min / max per pixel column of buf[pos .. pos+len) (or interpolated samples when zoomed in). */
function traceOf(buf, pos, len, cols) {
  const min = new Float32Array(cols), max = new Float32Array(cols);
  const spp = len / cols;
  if (spp <= 1.5) {
    for (let x = 0; x < cols; x++) { const v = sampleAt(buf, pos + x * spp); min[x] = v; max[x] = v; }
    return { min, max, dense: false };
  }
  for (let x = 0; x < cols; x++) {
    const a = Math.floor(pos + x * spp), b = Math.min(buf.length - 1, Math.floor(pos + (x + 1) * spp));
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i <= b; i++) { const v = buf[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[x] = lo; max[x] = hi;
  }
  return { min, max, dense: spp > 3 };
}

function drawTrace(ctx, pts, w, mid, amp, color, a) {
  const n = pts.min.length;
  const sx = w / Math.max(1, n - 1);
  ctx.strokeStyle = color;
  ctx.globalAlpha = a;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (pts.dense) {
    // envelope: one vertical stroke per column, joined to the next
    for (let x = 0; x < n; x++) {
      const y0 = mid - pts.max[x] * amp, y1 = mid - pts.min[x] * amp;
      if (x === 0) ctx.moveTo(x * sx, y0); else ctx.lineTo(x * sx, y0);
      ctx.lineTo(x * sx, Math.max(y1, y0 + 0.5));
    }
  } else {
    for (let x = 0; x < n; x++) { const y = mid - ((pts.min[x] + pts.max[x]) / 2) * amp; if (x === 0) ctx.moveTo(0, y); else ctx.lineTo(x * sx, y); }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function grid(ctx, w, H, th) {
  ctx.fillStyle = alpha(th.line, 0.55);
  for (let i = 1; i < 10; i++) ctx.fillRect(Math.round((i * w) / 10), 0, 1, H);
  for (const f of [0.25, 0.75]) ctx.fillRect(0, Math.round(H * f), w, 1);
  ctx.fillStyle = th.line2;
  ctx.fillRect(0, Math.round(H / 2), w, 1);
}
