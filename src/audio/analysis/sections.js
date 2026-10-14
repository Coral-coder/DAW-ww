// Section / phrase boundaries: per-bar feature vectors (chroma + loudness), novelty between the
// W bars before and after each candidate bar line (checkerboard-style), peaks snapped to the
// phrase grid (8 / 16 bars) — then each section gets a rough DJ label from its energy.
import { barTime } from './tempo.js';
import { mean, std } from './dsp.js';

/**
 * @param {object} a
 * @param {{bpm,anchor,beatsPerBar}} a.grid
 * @param {number} a.duration seconds
 * @param {{frames:Float32Array[], energy:Float32Array, fps:number}} a.chroma chromagram()
 * @returns {{ bar:number, time:number, label:string, energy:number }[]} section starts (first at bar 0)
 */
export function detectSections({ grid, duration, chroma, phraseBars = 8, window = 8 }) {
  const barLen = (60 / grid.bpm) * grid.beatsPerBar;
  const nBars = Math.max(0, Math.floor((duration - grid.anchor) / barLen + 1e-6));
  if (nBars < 2) return [{ bar: 0, time: grid.anchor, label: 'intro', energy: 1 }];
  const feats = [];
  const energies = [];
  for (let b = 0; b < nBars; b++) {
    const f0 = Math.floor(barTime(grid, b) * chroma.fps), f1 = Math.max(f0 + 1, Math.floor(barTime(grid, b + 1) * chroma.fps));
    const c = new Float32Array(12);
    let e = 0, n = 0;
    for (let f = f0; f < f1 && f < chroma.frames.length; f++) { for (let k = 0; k < 12; k++) c[k] += chroma.frames[f][k]; e += chroma.energy[f]; n++; }
    if (n) for (let k = 0; k < 12; k++) c[k] /= n;
    feats.push(c);
    energies.push(n ? e / n : 0);
  }
  const maxE = Math.max(1e-9, ...energies);
  const vec = feats.map((c, b) => [...c, (2 * energies[b]) / maxE]);
  const avg = (b0, b1) => { const o = new Array(13).fill(0); for (let b = b0; b < b1; b++) for (let k = 0; k < 13; k++) o[k] += vec[b][k] / (b1 - b0); return o; };
  const dist = (u, v) => { let s = 0; for (let k = 0; k < 13; k++) s += (u[k] - v[k]) ** 2; return Math.sqrt(s); };
  const nov = new Float32Array(nBars);
  for (let b = 2; b < nBars - 1; b++) {
    const w = Math.min(window, b, nBars - b);
    if (w < 2) continue;
    nov[b] = dist(avg(b - w, b), avg(b, b + w));
  }
  const m = mean(nov), s = std(nov, m);
  const peaks = [];
  for (let b = 1; b < nBars; b++) {
    if (nov[b] <= m + 0.5 * s || nov[b] < 0.05) continue;
    if (nov[b] < nov[b - 1] || (b + 1 < nBars && nov[b] < nov[b + 1])) continue;
    peaks.push(b);
  }
  // snap to the phrase grid when close (DJ music is built in 8 / 16 bar phrases)
  const snapped = [...new Set(peaks.map((b) => {
    const g = Math.round(b / phraseBars) * phraseBars;
    return Math.abs(g - b) <= 1 && g > 0 && g < nBars ? g : b;
  }))].sort((a, b) => a - b).filter((b, i, arr) => i === 0 || b - arr[i - 1] >= 4);
  const starts = [0, ...snapped.filter((b) => b >= 4)];
  const out = starts.map((bar, i) => {
    const end = starts[i + 1] ?? nBars;
    const e = energies.slice(bar, end);
    return { bar, time: barTime(grid, bar), bars: end - bar, energy: (e.reduce((x, y) => x + y, 0) / Math.max(1, e.length)) / maxE };
  });
  return labelSections(out);
}

export function labelSections(sections) {
  const es = sections.map((s) => s.energy);
  const hi = Math.max(...es), lo = Math.min(...es);
  return sections.map((s, i) => {
    let label;
    const rel = hi - lo > 0.05 ? (s.energy - lo) / (hi - lo) : 1;
    if (i === 0 && sections.length > 2 && rel < 0.8) label = 'intro';
    else if (i === sections.length - 1 && sections.length > 2 && rel < 0.8) label = 'outro';
    else if (rel >= 0.75) label = 'drop';
    else if (rel <= 0.35) label = 'break';
    else label = 'build';
    return { ...s, label };
  });
}
