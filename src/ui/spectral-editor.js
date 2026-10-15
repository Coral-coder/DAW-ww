// Spectral editor (modal) for audio clips: spectrogram of the clip's sample, rectangle / time-range / frequency-band
// selections and the spectral edits of src/audio/dsp/spectral.js (attenuate, gain, remove, heal, isolate).
//
// Edits are made on a working copy (editor-level undo with Ctrl/⌘+Z); "Apply to clip" writes the result as a NEW
// sample and points the clip at it in one undo step — the original sample stays in the project (clip.spectralSource
// remembers it, the clip inspector can restore it).
import { h, icon, fitCanvas, startDrag } from './dom.js';
import { modal, button, select, toggle, numberField, toast } from './components.js';
import { spectrogram, processRegion } from '../audio/dsp/spectral.js';
import { encodeWav } from '../io/wav.js';
import { arrayBufferToBase64 } from '../io/samples.js';
import { uid } from '../core/util.js';

const FMIN = 20;
const DB_FLOOR = -100;
const MAX_UNDO = 12;

/** Magma-like colour ramp (0..1 -> [r, g, b]). */
const STOPS = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
const LUT = (() => {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (STOPS.length - 1), k = Math.min(STOPS.length - 2, Math.floor(x)), f = x - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * f;
  }
  return out;
})();

export async function openSpectralEditor(app, clipId) {
  const { store, engine } = app;
  const get = () => store.get();
  const clip0 = get().clips.find((c) => c.id === clipId);
  if (!clip0 || clip0.type !== 'audio' || !clip0.sampleId) { toast('Select an audio clip'); return null; }
  const sample = get().samples?.[clip0.sampleId];
  let buf;
  try { buf = await engine.decodeSample(clip0.sampleId, { full: true }); } catch (e) { toast(`Could not decode the audio: ${e.message}`, { level: 'error' }); return null; }
  if (!buf || typeof buf.getChannelData !== 'function') { toast('This audio could not be loaded for editing', { level: 'error' }); return null; }
  const sr = buf.sampleRate;
  const nyq = sr / 2;
  let work = Array.from({ length: buf.numberOfChannels }, (_, c) => Float32Array.from(buf.getChannelData(c)));
  const duration = work[0].length / sr;
  const history = [];
  let dirty = false;
  let view = { t0: 0, t1: duration };
  let sel = null; // { t0, t1, f0, f1 }
  let logScale = true;
  let selMode = 'rect';
  let attDb = -12, gainDb = 3;
  let spec = null, specKey = '';
  let preview = null;

  // clip region (unwarped clips: offset / length in beats at the project tempo)
  const clipRegion = () => {
    const c = get().clips.find((x) => x.id === clipId);
    if (!c || (c.warp && c.warp.mode && c.warp.mode !== 'off')) return null;
    const spb = 60 / (get().bpm || 120);
    return { t0: (c.offset || 0) * spb, t1: ((c.offset || 0) + c.length) * spb };
  };

  // ---------------------------------------------------------------- layout
  const canvas = h('canvas.spx-canvas');
  const status = h('span.spx-status', '');
  const busy = h('span.spx-busy.hidden', 'Processing…');
  const fld = (v, set, title) => numberField({ value: v, min: -60, max: 24, step: 0.5, width: 66, title, format: (x) => `${x > 0 ? '+' : ''}${x} dB`, onChange: (x) => set(x) });
  const tools = h('div.spx-tools',
    select({ options: [{ value: 'rect', label: 'Rectangle' }, { value: 'time', label: 'Time range (all frequencies)' }, { value: 'band', label: 'Frequency band (whole view)' }], value: selMode, title: 'Selection shape (Shift-drag: time range · Alt-drag: frequency band)', onChange: (v) => { selMode = v; } }),
    toggle({ label: 'Log', value: logScale, title: 'Logarithmic frequency axis', onChange: (v) => { logScale = v; draw(); } }),
    button('', () => zoomSel(), { icon: 'zoomIn', cls: 'small', title: 'Zoom to the selection' }),
    button('', () => { view = { t0: 0, t1: duration }; specKey = ''; draw(); }, { icon: 'zoomOut', cls: 'small', title: 'Show everything' }),
    h('div.sep'),
    button('Play', () => play(), { icon: 'play', cls: 'small', title: 'Play the selection (band-limited to it) or the view' }),
    button('', () => stopPreview(), { icon: 'stop', cls: 'small', title: 'Stop' }),
    h('div.sep'),
    button('Attenuate', () => edit({ type: 'gain', db: attDb }, 'Attenuate'), { cls: 'small', title: 'Turn the selected region down by the amount on the right' }),
    fld(attDb, (x) => { attDb = Math.min(0, x); }, 'Attenuation (dB)'),
    button('Gain', () => edit({ type: 'gain', db: gainDb }, 'Gain'), { cls: 'small', title: 'Change the level of the selected region' }),
    fld(gainDb, (x) => { gainDb = x; }, 'Gain (dB)'),
    button('Remove', () => edit({ type: 'remove' }, 'Remove'), { cls: 'small', title: 'Silence the selected region (soft edges)' }),
    button('Heal', () => edit({ type: 'heal' }, 'Heal'), { cls: 'small', title: 'Replace the selection with what surrounds it in time (clicks, coughs, dropouts)' }),
    button('Isolate', () => edit({ type: 'isolate' }, 'Isolate'), { cls: 'small', title: 'During the selected time, keep only the selected frequency band' }),
    button('', () => undo(), { icon: 'undo', cls: 'small', title: 'Undo the last spectral edit (Ctrl/⌘+Z)' }),
    busy);
  const body = h('div.spx', tools, h('div.spx-view', canvas), h('div.spx-foot', icon('help', 12), status));

  const m = modal({
    title: `Spectral editor · ${sample?.name || 'audio'}`, body, width: 1100, cls: 'spx-modal',
    actions: [{ label: 'Cancel' }, { label: 'Apply to clip', primary: true, onClick: () => commit() }],
    onClose: () => { stopPreview(); document.removeEventListener('keydown', onKey, true); ro?.disconnect(); },
  });

  // ---------------------------------------------------------------- coordinates
  const fOfY = (y, H) => { const r = 1 - y / H; return logScale ? FMIN * Math.pow(nyq / FMIN, r) : r * nyq; };
  const yOfF = (f, H) => { const r = logScale ? Math.log(Math.max(FMIN, f) / FMIN) / Math.log(nyq / FMIN) : f / nyq; return (1 - r) * H; };
  const tOfX = (x, W) => view.t0 + (x / W) * (view.t1 - view.t0);
  const xOfT = (t, W) => ((t - view.t0) / (view.t1 - view.t0)) * W;

  // ---------------------------------------------------------------- drawing
  const image = document.createElement('canvas');
  function computeSpec(W) {
    const cols = Math.max(64, Math.min(2400, Math.round(W)));
    const key = `${view.t0}|${view.t1}|${cols}|${history.length}|${dirty}`;
    if (key === specKey && spec) return;
    specKey = key;
    const a = Math.floor(view.t0 * sr), b = Math.ceil(view.t1 * sr);
    const mono = new Float32Array(Math.max(1, b - a));
    for (const ch of work) for (let i = 0; i < mono.length; i++) mono[i] += (ch[a + i] || 0) / work.length;
    const span = view.t1 - view.t0;
    const fftSize = span < 2 ? 1024 : span < 30 ? 2048 : 4096;
    spec = spectrogram(mono, sr, { fftSize, columns: cols });
  }
  function draw() {
    if (!canvas.isConnected) return;
    const { ctx, w: W, h: H } = fitCanvas(canvas);
    computeSpec(W);
    const rows = Math.max(1, Math.round(H));
    image.width = spec.cols; image.height = rows;
    const ic = image.getContext('2d');
    const img = ic.createImageData(spec.cols, rows);
    const binOfRow = new Int32Array(rows);
    for (let y = 0; y < rows; y++) binOfRow[y] = Math.min(spec.bins - 1, Math.max(0, Math.round((fOfY(y + 0.5, rows) / nyq) * (spec.bins - 1))));
    for (let c = 0; c < spec.cols; c++) {
      const o = c * spec.bins;
      for (let y = 0; y < rows; y++) {
        const db = spec.db[o + binOfRow[y]];
        const v = Math.max(0, Math.min(255, Math.round(((db - DB_FLOOR) / -DB_FLOOR) * 255)));
        const p = (y * spec.cols + c) * 4;
        img.data[p] = LUT[v * 3]; img.data[p + 1] = LUT[v * 3 + 1]; img.data[p + 2] = LUT[v * 3 + 2]; img.data[p + 3] = 255;
      }
    }
    ic.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0, W, H);
    // frequency guides
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f >= nyq) continue;
      const y = Math.round(yOfF(f, H)) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), 4, y - 6);
    }
    // time ticks
    const span = view.t1 - view.t0;
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60].find((s) => (s / span) * W >= 70) || 120;
    for (let t = Math.ceil(view.t0 / step) * step; t <= view.t1; t += step) {
      const x = Math.round(xOfT(t, W)) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(x, H - 10, 1, 10);
      ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillText(`${+t.toFixed(2)}s`, x + 3, H - 6);
    }
    // the part of the sample the clip plays
    const reg = clipRegion();
    if (reg) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      const xa = xOfT(reg.t0, W), xb = xOfT(Math.min(duration, reg.t1), W);
      if (xa > 0) ctx.fillRect(0, 0, Math.min(W, xa), H);
      if (xb < W) ctx.fillRect(Math.max(0, xb), 0, W - Math.max(0, xb), H);
    }
    if (sel) {
      const x0 = xOfT(sel.t0, W), x1 = xOfT(sel.t1, W), y0 = yOfF(sel.f1, H), y1 = yOfF(sel.f0, H);
      ctx.fillStyle = 'rgba(0,212,255,.14)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }
    if (preview?.pos != null) { const x = xOfT(preview.pos(), W); ctx.fillStyle = '#fff'; ctx.fillRect(x, 0, 1, H); }
    status.textContent = sel
      ? `Selection: ${sel.t0.toFixed(3)}–${sel.t1.toFixed(3)} s · ${Math.round(sel.f0)}–${Math.round(sel.f1)} Hz${dirty ? ' · edited (not applied yet)' : ''}`
      : `Drag to select a region (Shift: time range, Alt: frequency band) · ${duration.toFixed(2)} s · ${sr} Hz${dirty ? ' · edited (not applied yet)' : ''}`;
  }

  // ---------------------------------------------------------------- selection
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const mode = e.shiftKey ? 'time' : e.altKey ? 'band' : selMode;
    const mk = (x1, y1) => {
      const ta = tOfX(Math.max(0, Math.min(W, Math.min(x0, x1))), W), tb = tOfX(Math.max(0, Math.min(W, Math.max(x0, x1))), W);
      const fa = fOfY(Math.max(0, Math.min(H, Math.max(y0, y1))), H), fb = fOfY(Math.max(0, Math.min(H, Math.min(y0, y1))), H);
      if (mode === 'time') return { t0: ta, t1: tb, f0: 0, f1: nyq };
      if (mode === 'band') return { t0: view.t0, t1: view.t1, f0: fa, f1: fb };
      return { t0: ta, t1: tb, f0: fa, f1: fb };
    };
    let moved = false;
    startDrag(e, (dx, dy, ev) => {
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      sel = mk(ev.clientX - r.left, ev.clientY - r.top);
      draw();
    }, () => { if (!moved) { sel = null; draw(); } });
  });

  function zoomSel() {
    if (!sel || sel.t1 - sel.t0 < 0.01) return;
    const pad = (sel.t1 - sel.t0) * 0.25;
    view = { t0: Math.max(0, sel.t0 - pad), t1: Math.min(duration, sel.t1 + pad) };
    specKey = '';
    draw();
  }

  // ---------------------------------------------------------------- editing
  function edit(op, label) {
    if (!sel || sel.t1 - sel.t0 < 0.002) { toast('Drag on the spectrogram to select a region first'); return; }
    busy.classList.remove('hidden');
    setTimeout(() => {
      try {
        history.push(work);
        if (history.length > MAX_UNDO) history.shift();
        const s = { ...sel };
        work = work.map((ch) => processRegion(ch, sr, s, op));
        dirty = true;
        specKey = '';
        app.setStatus?.(`Spectral ${label}: ${s.t0.toFixed(2)}–${s.t1.toFixed(2)} s, ${Math.round(s.f0)}–${Math.round(s.f1)} Hz`);
      } catch (err) {
        toast(`Spectral edit failed: ${err.message}`, { level: 'error' });
      } finally {
        busy.classList.add('hidden');
        draw();
      }
    }, 16);
  }
  function undo() {
    if (!history.length) return;
    work = history.pop();
    dirty = history.length > 0;
    specKey = '';
    draw();
  }

  // ---------------------------------------------------------------- preview
  async function play() {
    stopPreview();
    try { await engine.init(); } catch { return; }
    const ctx = engine.ctx;
    const t0 = sel ? sel.t0 : view.t0, t1 = sel ? sel.t1 : view.t1;
    const a = Math.floor(t0 * sr), n = Math.max(1, Math.floor((t1 - t0) * sr));
    const b = ctx.createBuffer(work.length, n, sr);
    work.forEach((ch, c) => b.getChannelData(c).set(ch.subarray(a, a + n)));
    const src = ctx.createBufferSource();
    src.buffer = b;
    let node = src;
    if (sel && (sel.f0 > FMIN || sel.f1 < nyq * 0.98)) { // band-limited audition of the selection
      for (let k = 0; k < 2; k++) {
        if (sel.f0 > FMIN) { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = sel.f0; hp.Q.value = 0.707; node.connect(hp); node = hp; }
        if (sel.f1 < nyq * 0.98) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = sel.f1; lp.Q.value = 0.707; node.connect(lp); node = lp; }
      }
    }
    const g = ctx.createGain();
    g.gain.value = 0.9;
    node.connect(g);
    g.connect(engine.graph?.master?.input || ctx.destination);
    const start = ctx.currentTime + 0.02;
    src.start(start);
    let raf = 0;
    const tick = () => { if (!preview) return; draw(); raf = requestAnimationFrame(tick); };
    preview = { src, g, pos: () => Math.min(t1, t0 + Math.max(0, ctx.currentTime - start)), stop: () => cancelAnimationFrame(raf) };
    src.onended = () => { if (preview?.src === src) { preview.stop(); preview = null; draw(); } try { g.disconnect(); } catch { /* */ } };
    raf = requestAnimationFrame(tick);
  }
  function stopPreview() {
    if (!preview) return;
    const p = preview;
    preview = null;
    p.stop();
    try { p.src.stop(); } catch { /* */ }
    try { p.g.disconnect(); } catch { /* */ }
  }

  // ---------------------------------------------------------------- commit
  function commit() {
    if (!dirty) return true;
    const clip = get().clips.find((c) => c.id === clipId);
    if (!clip) return true;
    const bytes = encodeWav({ channels: work, sampleRate: sr }, { bitDepth: 24, dither: 'tpdf' });
    const orig = get().samples[clip.sampleId] || {};
    const id = uid('smp');
    const ns = { id, name: `${(orig.name || 'audio').replace(/ \(spectral( \d+)?\)$/, '')} (spectral)`, mime: 'audio/wav', data: arrayBufferToBase64(bytes), duration };
    if (orig.analysis) ns.analysis = orig.analysis; // same timing: transients / tempo stay valid
    // hand the engine the decoded result so playback does not wait for a decode
    try {
      if (engine.ctx) {
        const ab = engine.ctx.createBuffer(work.length, work[0].length, sr);
        work.forEach((ch, c) => ab.getChannelData(c).set(ch));
        engine.buffers?.set(id, ab);
      }
    } catch { /* decoded on demand instead */ }
    store.transact('Spectral edit', (p) => {
      p.samples[id] = ns; // (samples live outside undo snapshots: undo points the clip back at the original)
      const c = p.clips.find((x) => x.id === clipId);
      if (!c) return;
      if (!c.spectralSource) c.spectralSource = c.sampleId;
      c.sampleId = id;
    });
    toast('Spectral edit applied to the clip (the original audio is kept — undo or “Restore original audio” in the clip inspector)', { level: 'success', timeout: 5000 });
    return true;
  }

  const onKey = (e) => {
    if (!body.isConnected) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); undo(); }
    if (e.key === ' ' && !e.target.closest('input, textarea, select')) { e.preventDefault(); e.stopImmediatePropagation(); if (preview) stopPreview(); else play(); }
  };
  document.addEventListener('keydown', onKey, true);
  let ro = null;
  try { ro = new ResizeObserver(() => draw()); ro.observe(canvas); } catch { /* */ }
  requestAnimationFrame(() => draw());
  return m;
}
