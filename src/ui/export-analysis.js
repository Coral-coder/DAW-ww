// Export dialog: pictures of the export analysis (src/audio/dsp/loudness-stats.js analyzeRender) — loudness over
// time (short-term + momentary against the target) and the long-term average spectrum — plus the report files
// (.txt / .json) that can be saved next to the export.
import { h } from './dom.js';

export const REPORT_FILE_OPTIONS = [
  { value: 'none', label: 'Show only' },
  { value: 'txt', label: 'Save .txt' },
  { value: 'json', label: 'Save .json' },
  { value: 'both', label: 'Save .txt + .json' },
];

/** Files of the report for `mode` ('none' | 'txt' | 'json' | 'both'), named after the export (`base` without extension). */
export function reportFiles(report, base, mode = 'none') {
  const out = [];
  if ((mode === 'txt' || mode === 'both') && report?.text) out.push({ name: `${base}.report.txt`, data: report.text, mime: 'text/plain' });
  if ((mode === 'json' || mode === 'both') && report?.json) out.push({ name: `${base}.report.json`, data: JSON.stringify(report.json, null, 2), mime: 'application/json' });
  return out;
}

const colors = (el) => {
  const cs = getComputedStyle(el);
  return {
    accent: cs.getPropertyValue('--accent').trim() || '#7c5cff',
    accent2: cs.getPropertyValue('--accent-2').trim() || '#00d4ff',
    grid: cs.getPropertyValue('--line').trim() || 'rgba(128,128,128,.3)',
    text: cs.getPropertyValue('--text-3').trim() || '#888',
  };
};

function canvas(w, hgt, title) {
  const dpr = globalThis.devicePixelRatio || 1;
  const cv = h('canvas', { title, width: Math.round(w * dpr), height: Math.round(hgt * dpr) });
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cv, ctx };
}

/** Loudness over time: short-term (line) and momentary (faint), target line, x = song time. */
export function drawLoudnessTime(ctx, w, H, a, c, targetLufs = null) {
  ctx.clearRect(0, 0, w, H);
  const lo = -40, hi = 0;
  const y = (l) => H - ((Math.max(lo, Math.min(hi, l)) - lo) / (hi - lo)) * H;
  ctx.fillStyle = c.grid;
  for (const l of [-30, -20, -10]) ctx.fillRect(0, Math.round(y(l)), w, 1);
  ctx.fillStyle = c.text; ctx.font = '9px system-ui';
  for (const l of [-30, -20, -10]) ctx.fillText(`${l}`, 2, y(l) - 2);
  const dur = a.duration || 1;
  const series = (arr, offsetSec, style, width) => {
    if (!arr.length) return;
    ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
    let pen = false;
    const step = Math.max(1, Math.floor(arr.length / (w * 2)));
    for (let i = 0; i < arr.length; i += step) {
      const v = arr[i];
      if (!Number.isFinite(v) || v < lo) { pen = false; continue; }
      const x = ((offsetSec + i * 0.1) / dur) * w;
      if (pen) ctx.lineTo(x, y(v)); else ctx.moveTo(x, y(v));
      pen = true;
    }
    ctx.stroke();
  };
  series(a.momentary, 0.4, 'rgba(128,128,128,.45)', 1);
  series(a.shortTerm, 3, c.accent2, 1.5);
  if (Number.isFinite(targetLufs)) { ctx.strokeStyle = '#ffb547'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, y(targetLufs)); ctx.lineTo(w, y(targetLufs)); ctx.stroke(); ctx.setLineDash([]); }
  if (Number.isFinite(a.integrated)) { ctx.fillStyle = c.accent; ctx.fillRect(0, Math.round(y(a.integrated)), w, 1); ctx.fillText(`I ${a.integrated.toFixed(1)}`, w - 44, y(a.integrated) - 3); }
}

/** Long-term average spectrum, 20 Hz – 20 kHz, −90…0 dB. */
export function drawSpectrum(ctx, w, H, a, c) {
  ctx.clearRect(0, 0, w, H);
  ctx.fillStyle = c.grid;
  for (const f of [100, 1000, 10000]) ctx.fillRect((Math.log10(f / 20) / 3) * w, 0, 1, H);
  ctx.fillStyle = c.text; ctx.font = '9px system-ui';
  for (const [f, l] of [[100, '100'], [1000, '1k'], [10000, '10k']]) ctx.fillText(l, (Math.log10(f / 20) / 3) * w + 2, H - 3);
  const pts = a.spectrum || [];
  if (!pts.length) return;
  const top = Math.max(...pts.map((p) => p.db));
  const y = (db) => H - ((Math.max(-60, Math.min(0, db - top)) + 60) / 60) * (H - 4);
  ctx.beginPath();
  ctx.moveTo(0, H);
  pts.forEach((p) => ctx.lineTo((Math.log10(p.f / 20) / 3) * w, y(p.db)));
  ctx.lineTo(w, H);
  ctx.closePath();
  ctx.fillStyle = `${c.accent}55`;
  ctx.fill();
  ctx.strokeStyle = c.accent; ctx.lineWidth = 1.2; ctx.beginPath();
  pts.forEach((p, i) => { const x = (Math.log10(p.f / 20) / 3) * w; if (i) ctx.lineTo(x, y(p.db)); else ctx.moveTo(x, y(p.db)); });
  ctx.stroke();
}

/** The two analysis pictures for the export report (null without an analysis). */
export function analysisView(host, analysis, { targetLufs = null } = {}) {
  if (!analysis) return null;
  const c = colors(host);
  const lt = canvas(290, 110, 'Loudness over time: short-term (3 s) LUFS, momentary in grey, dashed = target, solid = integrated');
  drawLoudnessTime(lt.ctx, 290, 110, analysis, c, targetLufs);
  const sp = canvas(290, 110, 'Long-term average spectrum (relative dB)');
  drawSpectrum(sp.ctx, 290, 110, analysis, c);
  return h('div.xp-analysis', lt.cv, sp.cv);
}
