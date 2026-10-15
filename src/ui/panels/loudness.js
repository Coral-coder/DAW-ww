// Loudness meter panel (docked in the Mixer): EBU R128 momentary / short-term / integrated loudness, loudness range,
// true peak, PLR / PSR, DR, a short-term history and histogram against a delivery target, pass / adjust against every
// streaming / broadcast target, phase correlation, a stereo vector scope, a pre / post spectrum, and utility meters of
// the master output (bit meter, DC offset, clip counter). Meters the master or any track / bus (analysis-hub.js);
// reads at ~30 fps while visible.
import { h, fitCanvas, clear } from '../dom.js';
import { iconButton, button } from '../components.js';
import { LOUDNESS_PRESETS } from '../../audio/dsp/loudness.js';
import { checkTarget } from '../../audio/dsp/loudness-stats.js';
import { loudnessOf, releaseLoudness, utilityOf, channelList } from '../../audio/analysis-hub.js';

const LS = 'daw3-loudness';
const f1 = (x) => (Number.isFinite(x) && x > -99 ? x.toFixed(1) : '−∞');
const lu = (x) => (x != null && Number.isFinite(x) ? x.toFixed(1) : '—');

export function createLoudnessPanel(app, { onClose } = {}) {
  const { engine } = app;
  let prefs = { target: 'spotify', spec: 'post', source: 'master', showTargets: true, showUtil: true };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { /* */ }
  const savePrefs = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* */ } };
  const target = () => LOUDNESS_PRESETS.find((x) => x.id === prefs.target) || LOUDNESS_PRESETS[0];
  const project = () => app.store?.get?.() || null;
  const analysis = () => (engine.ctx ? loudnessOf(engine, prefs.source) : null);

  const cell = (label, title, big = false) => {
    const v = h(`div.ld-val${big ? '.big' : ''}`, '−∞');
    const el = h('div.ld-cell', { title }, h('div.ld-lbl', label), v);
    return { el, v };
  };
  const cI = cell('Integrated', 'Integrated (gated, BS.1770-4) loudness since reset, LUFS', true);
  const cS = cell('Short-term', 'Short-term loudness (3 s window), LUFS');
  const cM = cell('Momentary', 'Momentary loudness (400 ms window), LUFS');
  const cL = cell('LRA', 'Loudness range (EBU Tech 3342), LU');
  const cT = cell('True peak', 'Maximum true peak since reset (4x oversampled), dBTP');
  const cMM = cell('Max M', 'Highest momentary loudness since reset, LUFS');
  const cMS = cell('Max S', 'Highest short-term loudness since reset, LUFS');
  const cPLR = cell('PLR', 'Peak-to-loudness ratio: true peak − integrated loudness (LU). Low values = heavily limited; ~8–12 LU is typical for modern pop masters');
  const cPSR = cell('PSR', 'Peak-to-short-term-loudness ratio: true peak of the last 3 s − short-term loudness (LU). Below ~8 sounds squashed');
  const cDR = cell('DR', 'Dynamic range (DR): crest factor of the loudest 20 % of 3 s blocks against the second-highest peak, averaged over both channels');
  const badge = h('span.ld-badge', '');
  cI.el.append(badge);

  const srcSel = h('select.ld-source', { title: 'What to meter: the master or any track / bus (post-fader)' });
  let srcSig = '';
  const fillSources = () => {
    const list = channelList(project());
    const sig = list.map((c) => `${c.id}:${c.label}`).join('|');
    if (sig === srcSig) return;
    srcSig = sig;
    clear(srcSel);
    for (const c of list) srcSel.append(h('option', { value: c.id }, c.label));
    if (!list.some((c) => c.id === prefs.source)) setSource('master');
    srcSel.value = prefs.source;
  };
  function setSource(id) {
    if (id === prefs.source) return;
    releaseLoudness(engine, prefs.source);
    prefs.source = id; savePrefs();
    hist.length = 0;
    utilSec.classList.toggle('hidden', id !== 'master' || !prefs.showUtil);
  }
  srcSel.addEventListener('change', () => setSource(srcSel.value));

  const tgtSel = h('select.ld-target', { title: 'Delivery target — reference line, the colour of the integrated readout and the pass / adjust badge' },
    LOUDNESS_PRESETS.map((x) => h('option', { value: x.id }, x.label)));
  tgtSel.value = prefs.target;
  const setTarget = (id) => { prefs.target = id; tgtSel.value = id; savePrefs(); };
  tgtSel.addEventListener('change', () => setTarget(tgtSel.value));
  const pauseBtn = h('button.toggle.small.ld-pause', { type: 'button', title: 'Pause metering (freezes every readout; integrated / LRA stop accumulating)' }, 'Pause');
  pauseBtn.addEventListener('click', () => {
    const on = !pauseBtn.classList.contains('on');
    pauseBtn.classList.toggle('on', on);
    analysis()?.setPaused?.(on);
    const u = engine.ctx ? utilityOf(engine) : null;
    if (u) u.paused = on;
  });
  const reset = button('Reset', () => { analysis()?.reset(); if (prefs.source === 'master' && engine.ctx) utilityOf(engine)?.reset(); hist.length = 0; }, { cls: 'small', title: 'Restart integrated loudness, LRA, histogram, peak hold and the utility meters' });

  const hist = []; // short-term history (≈ 10 values / s)
  const histCv = h('canvas.ld-hist', { title: 'Short-term loudness history (last 60 s) — dashed line = target' });
  const distCv = h('canvas.ld-dist', { title: 'Loudness histogram: how often each short-term loudness occurred since reset (gated). Dashed = target, solid = integrated' });

  // targets list
  const tRows = LOUDNESS_PRESETS.map((t) => {
    const st = h('span.ld-t-st', '—');
    const row = h('button.ld-t-row', { type: 'button', title: `${t.label}: ${t.lufs} LUFS ±${t.tol ?? 1} LU, true peak ≤ ${t.ceiling} dBTP${t.normalize === 'down' ? ' — louder masters are turned down' : t.normalize === 'both' ? ' — turned up or down (up only within the peak headroom)' : t.kind === 'broadcast' ? ' — broadcast specification' : ''}. Click to make it the target.` },
      h('span.ld-t-name', t.label.replace(/ \(.*\)$/, '')), h('span.ld-t-spec', `${t.lufs} / ${t.ceiling}`), st);
    row.addEventListener('click', () => setTarget(t.id));
    return { t, row, st };
  });
  const targetsSec = h('details.ld-targets', { open: prefs.showTargets },
    h('summary.ld-sec', 'Delivery targets ', h('span.muted', '(LUFS / dBTP)')), h('div.ld-t-list', tRows.map((r) => r.row)));
  targetsSec.addEventListener('toggle', () => { prefs.showTargets = targetsSec.open; savePrefs(); });

  const corrBar = h('div.ld-corr-fill');
  const corrVal = h('span.ld-corr-val', '0.00');
  const corr = h('div.ld-corr', { title: 'Phase correlation: +1 = mono-compatible, 0 = wide, −1 = out of phase' }, h('span.ld-corr-l', '−1'), h('div.ld-corr-track', corrBar), h('span.ld-corr-r', '+1'), corrVal);
  const scopeCv = h('canvas.ld-scope', { title: 'Stereo vector scope (goniometer): vertical = mono / centre, horizontal = side / width' });
  const specCv = h('canvas.ld-spec', { title: 'Spectrum analyser' });
  const preBtn = h('button.toggle.small', { type: 'button', title: 'Spectrum before the channel\'s effects (master: before the master chain)' }, 'Pre');
  const postBtn = h('button.toggle.small', { type: 'button', title: 'Spectrum of the channel output' }, 'Post');
  const setSpec = (w) => { prefs.spec = w; savePrefs(); preBtn.classList.toggle('on', w === 'pre'); postBtn.classList.toggle('on', w === 'post'); };
  preBtn.addEventListener('click', () => setSpec('pre'));
  postBtn.addEventListener('click', () => setSpec('post'));
  setSpec(prefs.spec);

  // utility meters (master output)
  const bitCells = Array.from({ length: 23 }, (_, i) => h('span.ld-bit', { title: `Bit ${23 - i} (${-6 * i} dB)` }));
  const bitInfo = h('div.ld-util-note');
  const dcEl = h('span.ld-util-val', '—');
  const clipEl = h('span.ld-util-val', '0');
  const clipReset = button('Reset', () => engine.ctx && utilityOf(engine)?.reset(), { cls: 'small', title: 'Reset the clip counter, DC average and bit history' });
  const utilSec = h('div.ld-util',
    h('div.ld-sec', 'Master output · bits'),
    h('div.ld-bits', { title: 'Bit meter: which of the 24 bits carry signal (last second; dim = used since reset). Unused low bits = lower real resolution (e.g. 16-bit material); no bits = digital silence' }, bitCells),
    bitInfo,
    h('div.ld-util-row', h('span.ld-lbl', { title: 'DC offset (average) of each channel since reset' }, 'DC offset'), dcEl),
    h('div.ld-util-row', h('span.ld-lbl', { title: 'Clips: runs of 3 or more consecutive full-scale samples (per channel) since reset' }, 'Clips'), clipEl, clipReset));
  utilSec.classList.toggle('hidden', prefs.source !== 'master' || !prefs.showUtil);

  const modeEl = h('div.ld-mode');
  const el = h('div.ld-panel',
    h('div.ld-head', h('span.ld-title', 'Loudness'), srcSel, iconButton('x', () => onClose?.(), 'Close the loudness panel')),
    h('div.ld-head', tgtSel, pauseBtn, reset),
    h('div.ld-grid', cI.el, cS.el, cM.el, cL.el, cT.el, cMM.el, cMS.el, cPLR.el, cPSR.el, cDR.el),
    targetsSec,
    histCv,
    distCv,
    h('div.ld-sec', 'Phase correlation'), corr,
    h('div.ld-row', h('div.ld-col', h('div.ld-sec', 'Vector scope'), scopeCv), h('div.ld-col.grow', h('div.ld-sec', 'Spectrum ', preBtn, postBtn), specCv)),
    utilSec,
    modeEl);

  let raf = 0, frame = 0, last = 0;
  let bins = null;
  let scopeGain = 0.5;
  const css = () => getComputedStyle(el);
  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (++frame % 2) return;
    if (frame % 30 === 0 || !srcSig) fillSources();
    const an = analysis();
    const col = css();
    const accent = col.getPropertyValue('--accent').trim() || '#7c5cff';
    const accent2 = col.getPropertyValue('--accent-2').trim() || '#00d4ff';
    const grid = col.getPropertyValue('--line').trim() || '#333';
    const text3 = col.getPropertyValue('--text-3').trim() || '#888';
    if (!an) { modeEl.textContent = engine.ctx ? 'That channel is not playing yet.' : 'Start playback to meter.'; return; }
    if (an.paused !== pauseBtn.classList.contains('on')) an.setPaused?.(pauseBtn.classList.contains('on'));
    const r = an.read();
    const tg = target();
    cM.v.textContent = f1(r.momentary);
    cS.v.textContent = f1(r.shortTerm);
    cI.v.textContent = f1(r.integrated);
    cL.v.textContent = Number.isFinite(r.lra) ? r.lra.toFixed(1) : '0.0';
    cT.v.textContent = f1(r.truePeakDb);
    cMM.v.textContent = f1(r.maxMomentary);
    cMS.v.textContent = f1(r.maxShort);
    cPLR.v.textContent = lu(r.plr);
    cPSR.v.textContent = lu(r.psr);
    cDR.v.textContent = r.dr != null ? String(Math.round(r.dr)) : '—';
    cPSR.v.classList.toggle('hot', r.psr != null && r.psr < 6);
    cPLR.v.classList.toggle('hot', r.plr != null && r.plr < 6);
    const chk = checkTarget(r, tg);
    const dI = r.integrated - tg.lufs;
    cI.v.className = 'ld-val big ' + (!Number.isFinite(r.integrated) ? '' : Math.abs(dI) <= (tg.tol ?? 1) ? 'ok' : dI > 0 ? 'hot' : 'low');
    cT.v.classList.toggle('hot', r.truePeakDb > tg.ceiling);
    badge.className = `ld-badge ${chk.status}`;
    badge.textContent = chk.status === 'pass' ? '✓ PASS' : chk.status === 'adjust' ? 'ADJUST' : '';
    badge.title = `${tg.label}: ${chk.message}`;
    if (targetsSec.open && frame % 10 === 0) {
      for (const tr of tRows) {
        const c = checkTarget(r, tr.t);
        tr.row.classList.toggle('sel', tr.t.id === tg.id);
        tr.st.className = `ld-t-st ${c.status}`;
        tr.st.textContent = c.status === 'none' ? '—' : c.status === 'pass' ? '✓' : `${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta).toFixed(1)}${c.peakOk ? '' : ' TP'}`;
        tr.row.title = tr.row.title.split('\n')[0] + `\n${c.message}`;
      }
    }
    modeEl.textContent = (r.paused ? 'Paused · ' : '') + (r.mode === 'worklet' ? 'BS.1770-4 · AudioWorklet' : r.mode === 'analyser' ? 'BS.1770 (analyser fallback — approximate)' : '…');
    if (now - last > 100 && !r.paused) { last = now; hist.push(r.shortTerm); if (hist.length > 600) hist.shift(); }
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
    // histogram of short-term loudness
    {
      const hg = r.histogram;
      const { ctx, w, h: H } = fitCanvas(distCv);
      ctx.clearRect(0, 0, w, H);
      const lo = -50, hi = 0;
      const x = (l) => ((Math.max(lo, Math.min(hi, l)) - lo) / (hi - lo)) * w;
      ctx.fillStyle = grid;
      for (const l of [-40, -30, -20, -10]) ctx.fillRect(Math.round(x(l)), 0, 1, H);
      ctx.fillStyle = text3; ctx.font = '9px system-ui'; for (const l of [-40, -30, -20, -10]) ctx.fillText(String(l), x(l) + 2, 10);
      if (hg && hg.count) {
        let mx = 1;
        for (const b of hg.bins) if (b > mx) mx = b;
        ctx.fillStyle = accent;
        for (let i = 0; i < hg.bins.length; i++) {
          if (!hg.bins[i]) continue;
          const l0 = hg.lo + i * hg.step;
          if (l0 + hg.step <= lo) continue;
          const x0 = x(l0), x1 = x(l0 + hg.step);
          const bh = (hg.bins[i] / mx) * (H - 12);
          ctx.fillRect(x0 + 0.5, H - bh, Math.max(1, x1 - x0 - 1), bh);
        }
      }
      ctx.strokeStyle = '#ffb547'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x(tg.lufs), 0); ctx.lineTo(x(tg.lufs), H); ctx.stroke(); ctx.setLineDash([]);
      if (Number.isFinite(r.integrated)) { ctx.fillStyle = accent2; ctx.fillRect(Math.round(x(r.integrated)) - 1, 0, 2, H); }
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
    // utility meters (master output)
    if (prefs.source === 'master' && prefs.showUtil && frame % 6 === 0) {
      const u = utilityOf(engine)?.read();
      if (u) {
        for (let i = 0; i < 23; i++) {
          bitCells[i].classList.toggle('on', !!u.recentBits.used[i]);
          bitCells[i].classList.toggle('seen', !!u.bits.used[i]);
        }
        bitInfo.textContent = u.samples ? (u.recentBits.silent ? 'Digital silence' : `${u.recentBits.verdict}${u.recentBits.msb ? ` · top bit ${u.recentBits.msb} (${((u.recentBits.msb - 23) * 6.02).toFixed(0)} dBFS)` : ''}`) : '';
        const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(3)} %`;
        dcEl.textContent = u.samples ? `L ${pct(u.dc[0])} · R ${pct(u.dc[1])}` : '—';
        dcEl.classList.toggle('hot', Number.isFinite(u.dcDb) && u.dcDb > -60);
        clipEl.textContent = u.clips.total ? `L ${u.clips.events[0]} · R ${u.clips.events[1]} · longest ${u.clips.longest}` : '0';
        clipEl.classList.toggle('hot', u.clips.total > 0);
      }
    }
  }
  return {
    el,
    show() { el.classList.remove('hidden'); fillSources(); if (!raf) raf = requestAnimationFrame(draw); },
    hide() { el.classList.add('hidden'); if (raf) cancelAnimationFrame(raf); raf = 0; },
    dispose() { if (raf) cancelAnimationFrame(raf); raf = 0; releaseLoudness(engine, prefs.source); clear(el); },
  };
}
