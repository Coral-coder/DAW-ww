// Loudness meter panel (docked in the Mixer): EBU R128 momentary / short-term / integrated loudness, loudness range,
// true peak, a short-term history against a delivery target, phase correlation, a stereo vector scope and a pre / post
// master spectrum. Reads engine.getMasterAnalysis() (src/audio/meters.js) at ~30 fps while visible.
import { h, fitCanvas, clear } from '../dom.js';
import { iconButton, button } from '../components.js';
import { LOUDNESS_PRESETS } from '../../audio/dsp/loudness.js';

const LS = 'daw3-loudness';
const f1 = (x) => (Number.isFinite(x) && x > -99 ? x.toFixed(1) : '−∞');

export function createLoudnessPanel(app, { onClose } = {}) {
  const { engine } = app;
  let prefs = { target: 'spotify', spec: 'post' };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { /* */ }
  const savePrefs = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* */ } };
  const target = () => LOUDNESS_PRESETS.find((x) => x.id === prefs.target) || LOUDNESS_PRESETS[0];

  const cell = (label, title, big = false) => {
    const v = h(`div.ld-val${big ? '.big' : ''}`, '−∞');
    const el = h('div.ld-cell', { title }, h('div.ld-lbl', label), v);
    return { el, v };
  };
  const cM = cell('Momentary', 'Momentary loudness (400 ms window), LUFS');
  const cS = cell('Short-term', 'Short-term loudness (3 s window), LUFS');
  const cI = cell('Integrated', 'Integrated (gated, BS.1770-4) loudness since reset, LUFS', true);
  const cL = cell('LRA', 'Loudness range (EBU Tech 3342), LU');
  const cT = cell('True peak', 'Maximum true peak since reset (4x oversampled), dBTP');
  const cMM = cell('Max M', 'Highest momentary loudness since reset');
  const tgtSel = h('select.ld-target', { title: 'Delivery target — reference line and the colour of the integrated readout' },
    LOUDNESS_PRESETS.map((x) => h('option', { value: x.id }, x.label)));
  tgtSel.value = prefs.target;
  tgtSel.addEventListener('change', () => { prefs.target = tgtSel.value; savePrefs(); });
  const reset = button('Reset', () => { engine.getMasterAnalysis?.()?.reset(); hist.length = 0; }, { cls: 'small', title: 'Restart integrated loudness, LRA and peak hold' });
  const hist = []; // short-term history (≈ 10 values / s)
  const histCv = h('canvas.ld-hist', { title: 'Short-term loudness history (last 60 s) — dashed line = target' });
  const corrBar = h('div.ld-corr-fill');
  const corrVal = h('span.ld-corr-val', '0.00');
  const corr = h('div.ld-corr', { title: 'Phase correlation: +1 = mono-compatible, 0 = wide, −1 = out of phase' }, h('span.ld-corr-l', '−1'), h('div.ld-corr-track', corrBar), h('span.ld-corr-r', '+1'), corrVal);
  const scopeCv = h('canvas.ld-scope', { title: 'Stereo vector scope (goniometer): vertical = mono / centre, horizontal = side / width' });
  const specCv = h('canvas.ld-spec', { title: 'Spectrum analyser' });
  const preBtn = h('button.toggle.small', { type: 'button', title: 'Spectrum of the master input (before the master effects)' }, 'Pre');
  const postBtn = h('button.toggle.small', { type: 'button', title: 'Spectrum of the master output' }, 'Post');
  const setSpec = (w) => { prefs.spec = w; savePrefs(); preBtn.classList.toggle('on', w === 'pre'); postBtn.classList.toggle('on', w === 'post'); };
  preBtn.addEventListener('click', () => setSpec('pre'));
  postBtn.addEventListener('click', () => setSpec('post'));
  setSpec(prefs.spec);
  const modeEl = h('div.ld-mode');
  const el = h('div.ld-panel',
    h('div.ld-head', h('span.ld-title', 'Loudness'), tgtSel, reset, iconButton('x', () => onClose?.(), 'Close the loudness panel')),
    h('div.ld-grid', cI.el, cS.el, cM.el, cL.el, cT.el, cMM.el),
    histCv,
    h('div.ld-sec', 'Phase correlation'), corr,
    h('div.ld-row', h('div.ld-col', h('div.ld-sec', 'Vector scope'), scopeCv), h('div.ld-col.grow', h('div.ld-sec', 'Spectrum ', preBtn, postBtn), specCv)),
    modeEl);

  let raf = 0, frame = 0, last = 0;
  let bins = null;
  let scopeGain = 0.5;
  const css = () => getComputedStyle(el);
  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (++frame % 2) return;
    const an = engine.ctx ? engine.getMasterAnalysis?.() : null;
    const col = css();
    const accent = col.getPropertyValue('--accent').trim() || '#7c5cff';
    const accent2 = col.getPropertyValue('--accent-2').trim() || '#00d4ff';
    const grid = col.getPropertyValue('--line').trim() || '#333';
    const text3 = col.getPropertyValue('--text-3').trim() || '#888';
    if (!an) { modeEl.textContent = 'Start playback to meter the master.'; return; }
    const r = an.read();
    const tg = target();
    cM.v.textContent = f1(r.momentary);
    cS.v.textContent = f1(r.shortTerm);
    cI.v.textContent = f1(r.integrated);
    cL.v.textContent = Number.isFinite(r.lra) ? r.lra.toFixed(1) : '0.0';
    cT.v.textContent = f1(r.truePeakDb);
    cMM.v.textContent = f1(r.maxMomentary);
    const dI = r.integrated - tg.lufs;
    cI.v.className = 'ld-val big ' + (!Number.isFinite(r.integrated) ? '' : Math.abs(dI) <= 1 ? 'ok' : dI > 1 ? 'hot' : 'low');
    cT.v.classList.toggle('hot', r.truePeakDb > tg.ceiling);
    modeEl.textContent = r.mode === 'worklet' ? 'BS.1770-4 · AudioWorklet' : r.mode === 'analyser' ? 'BS.1770 (analyser fallback — approximate)' : '…';
    if (now - last > 100) { last = now; hist.push(r.shortTerm); if (hist.length > 600) hist.shift(); }
    // history
    {
      const { ctx, w, h: H } = fitCanvas(histCv);
      ctx.clearRect(0, 0, w, H);
      const lo = -40, hi = -3;
      const y = (l) => H - ((Math.max(lo, Math.min(hi, l)) - lo) / (hi - lo)) * H;
      ctx.fillStyle = grid;
      for (const l of [-30, -20, -10]) ctx.fillRect(0, Math.round(y(l)), w, 1);
      ctx.fillStyle = text3; ctx.font = '9px system-ui'; for (const l of [-30, -20, -10]) ctx.fillText(String(l), 2, y(l) - 2);
      ctx.strokeStyle = '#ffb547'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, y(tg.lufs)); ctx.lineTo(w, y(tg.lufs)); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = accent2; ctx.lineWidth = 1.5; ctx.beginPath();
      const n = hist.length;
      for (let i = 0; i < n; i++) { const x = w - (n - 1 - i) * (w / 600); const v = hist[i]; if (!Number.isFinite(v)) continue; if (i && Number.isFinite(hist[i - 1])) ctx.lineTo(x, y(v)); else ctx.moveTo(x, y(v)); }
      ctx.stroke();
    }
    // correlation
    const c = Math.max(-1, Math.min(1, r.correlation || 0));
    corrBar.style.left = c < 0 ? `${50 + c * 50}%` : '50%';
    corrBar.style.width = `${Math.abs(c) * 50}%`;
    corrBar.classList.toggle('neg', c < 0);
    corrVal.textContent = c.toFixed(2);
    // vector scope
    {
      const { ctx, w, h: H } = fitCanvas(scopeCv);
      ctx.clearRect(0, 0, w, H);
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(w, H / 2); ctx.stroke();
      const { l, r: rr } = an.scope();
      ctx.fillStyle = accent;
      let pk = 0;
      for (let i = 0; i < l.length; i++) pk = Math.max(pk, Math.abs(l[i]), Math.abs(rr[i]));
      scopeGain = Math.max(pk * 1.1, scopeGain * 0.97, 0.02); // auto-gain so quiet mixes still fill the scope
      const s = (Math.min(w, H) * 0.45) / scopeGain;
      for (let i = 0; i < l.length; i += 2) {
        const m = (l[i] + rr[i]) * 0.7071, sd = (l[i] - rr[i]) * 0.7071;
        ctx.fillRect(w / 2 + sd * s, H / 2 - m * s, 1.2, 1.2);
      }
    }
    // spectrum
    {
      const a = an.analyser(prefs.spec);
      const { ctx, w, h: H } = fitCanvas(specCv);
      ctx.clearRect(0, 0, w, H);
      ctx.fillStyle = grid;
      for (const f of [100, 1000, 10000]) ctx.fillRect((Math.log10(f / 20) / 3) * w, 0, 1, H);
      if (!bins || bins.length !== a.frequencyBinCount) bins = new Float32Array(a.frequencyBinCount);
      a.getFloatFrequencyData(bins);
      const binHz = a.context.sampleRate / a.fftSize;
      ctx.strokeStyle = prefs.spec === 'pre' ? accent2 : accent; ctx.lineWidth = 1.5; ctx.beginPath();
      const nb = Math.max(32, Math.floor(w / 2));
      for (let i = 0; i < nb; i++) {
        const f0 = 20 * Math.pow(1000, i / nb), f1x = 20 * Math.pow(1000, (i + 1) / nb);
        let mx = -140;
        for (let b = Math.max(1, Math.floor(f0 / binHz)); b <= Math.max(Math.floor(f0 / binHz) + 1, Math.ceil(f1x / binHz)) && b < bins.length; b++) if (bins[b] > mx) mx = bins[b];
        const yy = H - ((Math.max(-100, Math.min(0, mx)) + 100) / 100) * H;
        const x = (i / nb) * w;
        if (i) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
      }
      ctx.stroke();
    }
  }
  return {
    el,
    show() { el.classList.remove('hidden'); if (!raf) raf = requestAnimationFrame(draw); },
    hide() { el.classList.add('hidden'); if (raf) cancelAnimationFrame(raf); raf = 0; },
    dispose() { if (raf) cancelAnimationFrame(raf); raf = 0; clear(el); },
  };
}
