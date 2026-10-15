// Wavetable synth editor (device panel, instrument card): per oscillator a table picker (56 factory tables +
// the project's own tables), a 2D view of the current frame (warp applied, neighbours ghosted) and a 3D stack of
// all frames with the current position highlighted (live position while notes play), WAV / Serum import,
// resynthesis of a project sample, and a frame editor (freehand drawing, harmonic sliders, normalize, remove DC).
import { h, startDrag, fitCanvas, clear } from './dom.js';
import { select, button, iconButton, contextMenu, promptText } from './components.js';
import { FACTORY_TABLES, FACTORY_CATEGORIES } from '../audio/wavetable/factory.js';
import { tableFrames } from '../audio/wavetable/engine.js';
import {
  addProjectTable, isUserTable, harmonicsOf, frameFromHarmonics, removeDC, normalizeFrame, FRAME_SIZE,
} from '../audio/wavetable/tables.js';
import { importWavetable, resynthesize, toMono } from '../audio/wavetable/import.js';
import { warpPhase, warpGain } from '../audio/wavetable/warp.js';

const HARM_EDIT = 32;
const frameCache = new Map(); // table id -> frames (factory ids and content-hash ids never change)

function framesOf(app, id) {
  if (frameCache.has(id)) return frameCache.get(id);
  const fr = tableFrames(id, (tid) => app.store.get().wavetables?.[tid] || null);
  if (!isUserTable(id) || app.store.get().wavetables?.[id]) frameCache.set(id, fr);
  if (frameCache.size > 32) frameCache.delete(frameCache.keys().next().value);
  return fr;
}

/** Table picker options: factory tables by category + the project's tables. */
export function tableOptions(project, current) {
  const opts = [];
  for (const cat of FACTORY_CATEGORIES) for (const [id, t] of Object.entries(FACTORY_TABLES)) if (t.category === cat) opts.push({ value: id, label: t.name, group: cat });
  for (const [id, e] of Object.entries(project.wavetables || {})) opts.push({ value: id, label: `${e.name} (${e.frames})`, group: 'Project tables' });
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: isUserTable(current) ? 'Missing table (plays Basic Shapes)' : current, group: 'Project tables' });
  return opts;
}

/**
 * Mount the editor into `body`. onParam(key, value) edits instrument params (one undo step each).
 * Returns an updater(resolvedParams).
 */
export function wavetableEditor(app, body, tgt, onParam) {
  const { store, engine } = app;
  const trackId = tgt.id;
  let osc = 1;
  let params = {};
  let edit = null; // { osc, frames, fi, name }
  const wrap = h('div.wt-editor');
  body.appendChild(wrap);

  const tabs = h('div.wt-tabs');
  const tabBtn = (i) => {
    const b = h('button.wt-tab', { type: 'button' }, i === 1 ? 'Osc A' : 'Osc B');
    b.addEventListener('click', () => { osc = i; edit = null; build(); });
    return b;
  };
  const tabA = tabBtn(1), tabB = tabBtn(2);
  tabs.append(tabA, tabB);

  const c2 = h('canvas.wt-canvas.wt-2d', { title: 'Current frame (warp applied). In edit mode: draw freehand.' });
  const c3 = h('canvas.wt-canvas.wt-3d', { title: 'All frames — the highlighted one is the current position (live while playing). Click to set the position.' });
  const tableSel = h('span.wt-table-sel');
  const info = h('span.wt-info');
  const tools = h('div.wt-tools');
  const harm = h('canvas.wt-canvas.wt-harm', { title: `Harmonics 1–${HARM_EDIT}: drag to set their levels` });
  const editBar = h('div.wt-editbar');
  wrap.append(h('div.wt-head', tabs, tableSel, iconButton('menu', (e) => contextMenu(e, tableMenu()), 'Import a WAV wavetable, resynthesize a sample, edit the frame', 'wt-menu'), info),
    h('div.wt-views', c2, c3), tools);

  const key = (k) => `osc${osc}${k}`;
  const curId = () => params[key('Table')] || (osc === 1 ? 'basic' : 'pwm');
  const frames = () => (edit && edit.osc === osc ? edit.frames : framesOf(app, curId()));
  const pos = () => {
    const live = engine?.getInstrument?.(trackId)?.engine?.livePos;
    const v = Array.isArray(live) && engine?.getInstrument?.(trackId)?.engine?.liveVoices ? live[osc - 1] : null;
    return v != null ? v : Number(params[key('Pos')] ?? 0);
  };

  function setTable(id, label = 'Wavetable') { edit = null; onParam(key('Table'), id, label); }

  function tableMenu() {
    const samples = Object.values(store.get().samples || {});
    return [
      { header: `Osc ${osc === 1 ? 'A' : 'B'} wavetable` },
      { label: 'Import WAV wavetable…', icon: 'upload', onClick: importWav },
      { label: 'Resynthesize a sample', icon: 'wave', disabled: !samples.length, submenu: samples.length ? samples.slice(0, 60).map((s) => ({ label: s.name, onClick: () => resynthSample(s.id, s.name) })) : undefined },
      '-',
      { label: edit ? 'Leave frame editor' : 'Edit frame…', icon: 'pencil', onClick: () => { if (edit) { edit = null; build(); } else startEdit(); } },
      { label: 'Rename project table…', icon: 'pencil', disabled: !isUserTable(curId()) || !store.get().wavetables?.[curId()], onClick: async () => {
        const id = curId();
        const n = await promptText('Rename wavetable', store.get().wavetables[id].name);
        if (n) store.transact('Rename wavetable', (p) => { if (p.wavetables?.[id]) p.wavetables[id].name = n.slice(0, 80); });
      } },
    ];
  }

  function storeFrames(name, list, label) {
    let id = null;
    store.transact(label, (p) => {
      id = addProjectTable(p, name, list);
      const t = p.tracks.find((x) => x.id === trackId);
      if (t?.instrument) { t.instrument.params = t.instrument.params || {}; t.instrument.params[key('Table')] = id; t.instrument.edited = true; }
    });
    frameCache.delete(id);
    return id;
  }

  function importWav() {
    const inp = h('input', { type: 'file', accept: '.wav,audio/wav,audio/x-wav' });
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const res = importWavetable(await f.arrayBuffer(), { frames: 64 });
        const name = f.name.replace(/\.[a-z0-9]+$/i, '');
        storeFrames(name, res.frames, `Import wavetable: ${name}`);
        const how = { clm: 'Serum wavetable', multi: 'multi-frame table', single: 'single cycle', audio: 'audio resynthesized into frames' }[res.kind];
        app.toast?.(`Imported “${name}” — ${res.frames.length} frame${res.frames.length === 1 ? '' : 's'} (${how})`, { level: 'success' });
      } catch (e) { app.toast?.(`Could not import the wavetable: ${e?.message || e}`, { level: 'error' }); }
    });
    inp.click();
  }

  async function resynthSample(sampleId, name) {
    try {
      app.setStatus?.(`Resynthesizing “${name}”…`);
      const buf = await engine.decodeSample(sampleId, { full: true });
      if (!buf?.getChannelData) throw new Error('the sample could not be decoded');
      const ch = [];
      for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
      const fr = resynthesize(toMono(ch), buf.sampleRate, { frames: 64 });
      storeFrames(`${name} (resynth)`, fr, `Resynthesize: ${name}`);
      app.toast?.(`“${name}” resynthesized into 64 frames`, { level: 'success' });
    } catch (e) { app.toast?.(`Resynthesis failed: ${e?.message || e}`, { level: 'error' }); }
  }

  // ---- frame editor
  function startEdit() {
    const src = framesOf(app, curId());
    const fi = Math.round(Number(params[key('Pos')] ?? 0) * (src.length - 1));
    const t = FACTORY_TABLES[curId()];
    edit = { osc, frames: src.map((f) => Float32Array.from(f)), fi, name: t ? t.name : store.get().wavetables?.[curId()]?.name || 'Wavetable', dirty: false };
    build();
  }
  function saveEdit() {
    if (!edit) return;
    storeFrames(`${edit.name.replace(/ \(edited\)$/, '')} (edited)`, edit.frames, 'Edit wavetable');
    edit = null;
    build();
  }

  function buildEditBar() {
    clear(editBar);
    if (!edit || edit.osc !== osc) return;
    const F = edit.frames.length;
    const fiSel = select({ options: Array.from({ length: F }, (_, i) => ({ value: i, label: `Frame ${i + 1} / ${F}` })), value: edit.fi, onChange: (v) => { edit.fi = Number(v); draw(); } });
    const op = (label, fn, title) => button(label, () => { edit.frames[edit.fi] = fn(edit.frames[edit.fi]); edit.dirty = true; draw(); }, { cls: 'small', title });
    editBar.append(
      h('b', 'Frame editor'), fiSel,
      op('Normalize', (f) => normalizeFrame(f, 0.95), 'Scale this frame to full level'),
      op('Remove DC', removeDC, 'Centre the frame around zero'),
      op('Sine', () => frameFromHarmonics([0, 1]), 'Replace the frame with a sine'),
      button('All frames: normalize', () => { edit.frames = edit.frames.map((f) => normalizeFrame(removeDC(f), 0.95)); edit.dirty = true; draw(); }, { cls: 'small' }),
      h('div.spacer'),
      button('Cancel', () => { edit = null; build(); }, { cls: 'small' }),
      button('Save as project table', saveEdit, { cls: 'small', primary: true, title: 'Store the edited table in the project and use it on this oscillator (undoable)' }),
    );
  }

  function build() {
    tabA.classList.toggle('on', osc === 1); tabB.classList.toggle('on', osc === 2);
    clear(tableSel);
    tableSel.appendChild(select({ options: tableOptions(store.get(), curId()), value: curId(), cls: 'wt-select', title: 'Wavetable of this oscillator', onChange: (v) => setTable(v) }));
    clear(tools);
    if (edit && edit.osc === osc) {
      buildEditBar();
      tools.append(editBar, h('div.wt-harm-wrap', h('span.wt-cap', 'Harmonics'), harm));
    } else {
      tools.append(button('Edit frame', startEdit, { icon: 'pencil', cls: 'small', title: 'Draw the current frame, set its harmonics, normalize / remove DC' }),
        button('Import WAV', importWav, { icon: 'upload', cls: 'small', title: 'Import a wavetable WAV (Serum “clm” tables, 2048-sample frames, single cycles) or any audio (resynthesized)' }));
    }
    draw();
  }

  // ---- drawing
  const colors = (el) => {
    const cs = getComputedStyle(el);
    return { acc: cs.getPropertyValue('--accent').trim() || '#7c5cff', acc2: cs.getPropertyValue('--accent-2').trim() || '#3bc9db', line: cs.getPropertyValue('--line').trim() || '#333', dim: cs.getPropertyValue('--text-3').trim() || '#777' };
  };
  const sampleFrame = (f, x) => { const n = f.length; const p = (x - Math.floor(x)) * n; const i = Math.floor(p), fr = p - i; return f[i] + (f[(i + 1) % n] - f[i]) * fr; };

  function draw2d() {
    const { ctx, w, h: H } = fitCanvas(c2);
    const col = colors(c2);
    ctx.clearRect(0, 0, w, H);
    ctx.strokeStyle = col.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(w, H / 2); ctx.stroke();
    const fr = frames();
    if (!fr?.length) return;
    const editing = edit && edit.osc === osc;
    const p = editing ? edit.fi / Math.max(1, fr.length - 1) : pos();
    const x = p * (fr.length - 1), i0 = Math.floor(x), t = x - i0;
    const a = fr[i0], b = fr[Math.min(fr.length - 1, i0 + 1)];
    const warp = editing ? 'none' : params[key('Warp')] || 'none';
    const wa = Number(params[key('WarpAmt')] ?? 0);
    const N = Math.max(64, Math.floor(w));
    const y = (v) => H / 2 - v * (H / 2 - 4);
    // neighbours (ghosted)
    ctx.globalAlpha = 0.25; ctx.strokeStyle = col.dim;
    for (const k of [i0 - 1, i0 + 2]) {
      const f = fr[k];
      if (!f || editing) continue;
      ctx.beginPath();
      for (let j = 0; j <= N; j++) { const v = sampleFrame(f, j / N); if (j) ctx.lineTo((j / N) * w, y(v)); else ctx.moveTo(0, y(v)); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col.acc; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let j = 0; j <= N; j++) {
      const ph0 = j / N;
      const ph = warp === 'fm' ? ph0 : warpPhase(warp, ph0, wa);
      const va = sampleFrame(a, ph), vb = sampleFrame(b, ph);
      const v = (va + (vb - va) * (editing ? 0 : t)) * warpGain(warp, ph0, wa);
      if (j) ctx.lineTo((j / N) * w, y(v)); else ctx.moveTo(0, y(v));
    }
    ctx.stroke();
  }

  function draw3d() {
    const { ctx, w, h: H } = fitCanvas(c3);
    const col = colors(c3);
    ctx.clearRect(0, 0, w, H);
    const fr = frames();
    if (!fr?.length) return;
    const editing = edit && edit.osc === osc;
    const F = fr.length;
    const show = Math.min(F, 40);
    const cur = editing ? edit.fi : Math.round(pos() * (F - 1));
    const depthX = w * 0.28, depthY = H * 0.5;
    const pw = w - depthX - 4, amp = H * 0.18;
    const pts = 96;
    const line = (f, k, style, lw) => {
      const ox = 2 + (k / Math.max(1, F - 1)) * depthX, oy = H - amp - 4 - (k / Math.max(1, F - 1)) * depthY;
      ctx.beginPath();
      for (let j = 0; j <= pts; j++) { const v = sampleFrame(f, j / pts); const X = ox + (j / pts) * pw, Y = oy - v * amp; if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.stroke();
    };
    for (let s = show - 1; s >= 0; s--) {
      const k = Math.round((s / Math.max(1, show - 1)) * (F - 1));
      ctx.globalAlpha = 0.18 + 0.4 * (1 - s / show);
      line(fr[k], k, col.dim, 1);
    }
    ctx.globalAlpha = 1;
    line(fr[Math.max(0, Math.min(F - 1, cur))], cur, col.acc2, 2);
    const name = FACTORY_TABLES[curId()]?.name || store.get().wavetables?.[curId()]?.name || curId();
    info.textContent = `${editing ? `${edit.name} (editing)` : name} · ${F} frame${F === 1 ? '' : 's'} · frame ${cur + 1}`;
  }

  function drawHarm() {
    if (!edit || edit.osc !== osc || !harm.isConnected) return;
    const { ctx, w, h: H } = fitCanvas(harm);
    const col = colors(harm);
    ctx.clearRect(0, 0, w, H);
    const { amps } = harmonicsOf(edit.frames[edit.fi]);
    let mx = 0;
    for (let k = 1; k <= HARM_EDIT; k++) mx = Math.max(mx, amps[k]);
    const bw = w / HARM_EDIT;
    for (let k = 1; k <= HARM_EDIT; k++) {
      const v = mx > 0 ? amps[k] / mx : 0;
      ctx.fillStyle = col.line; ctx.fillRect((k - 1) * bw + 1, 0, bw - 2, H);
      ctx.fillStyle = col.acc; ctx.fillRect((k - 1) * bw + 1, H - v * H, bw - 2, v * H);
    }
  }

  function draw() { if (!wrap.isConnected) return; draw2d(); draw3d(); drawHarm(); }

  // freehand drawing on the 2D view (edit mode)
  c2.addEventListener('pointerdown', (e) => {
    if (!edit || edit.osc !== osc || e.button !== 0) return;
    e.preventDefault();
    const r = c2.getBoundingClientRect();
    const f = edit.frames[edit.fi];
    let last = null;
    const paint = (ev) => {
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const v = Math.max(-1, Math.min(1, (r.height / 2 - (ev.clientY - r.top)) / (r.height / 2 - 4)));
      const i = Math.min(FRAME_SIZE - 1, Math.floor(x * FRAME_SIZE));
      if (last) {
        const [i0, v0] = last, n = Math.abs(i - i0);
        for (let k = 0; k <= n; k++) { const j = i0 + Math.sign(i - i0) * k; f[j] = v0 + (v - v0) * (n ? k / n : 1); }
      } else f[i] = v;
      last = [i, v];
      edit.dirty = true;
      draw();
    };
    paint(e);
    startDrag(e, (_dx, _dy, ev) => paint(ev), () => { last = null; });
  });
  // harmonic sliders
  harm.addEventListener('pointerdown', (e) => {
    if (!edit || e.button !== 0) return;
    e.preventDefault();
    const r = harm.getBoundingClientRect();
    const set = (ev) => {
      const k = Math.max(1, Math.min(HARM_EDIT, Math.floor(((ev.clientX - r.left) / r.width) * HARM_EDIT) + 1));
      const v = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
      const { amps, phases } = harmonicsOf(edit.frames[edit.fi]);
      let mx = 0;
      for (let j = 1; j <= HARM_EDIT; j++) mx = Math.max(mx, amps[j]);
      amps[k] = v * (mx || 1);
      edit.frames[edit.fi] = frameFromHarmonics(amps, phases);
      edit.dirty = true;
      draw();
    };
    set(e);
    startDrag(e, (_dx, _dy, ev) => set(ev), () => {});
  });
  // click the 3D stack to move the position
  c3.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = c3.getBoundingClientRect();
    const setPos = (ev) => {
      const v = Math.max(0, Math.min(1, ((ev.clientX - r.left) / r.width - 0.05) / 0.3 * 0.5 + (1 - (ev.clientY - r.top) / r.height) * 0.5));
      if (edit && edit.osc === osc) { edit.fi = Math.round(v * (edit.frames.length - 1)); buildEditBar(); draw(); } else onParam(key('Pos'), Math.round(v * 1000) / 1000, 'Position');
    };
    setPos(e);
    startDrag(e, (_dx, _dy, ev) => setPos(ev), () => {});
  });

  new ResizeObserver(() => draw()).observe(wrap);
  // live position while notes play
  let lastLive = '';
  const live = () => {
    if (!wrap.isConnected) return;
    const inst = engine?.getInstrument?.(trackId)?.engine;
    const k = inst?.liveVoices ? JSON.stringify(inst.livePos) : '';
    if (k !== lastLive) { lastLive = k; if (!edit) { draw2d(); draw3d(); } }
    setTimeout(() => requestAnimationFrame(live), 50);
  };
  live();

  let lastTables = null, lastView = '';
  return (resolved) => {
    params = resolved || {};
    const tk = `${params.osc1Table}|${params.osc2Table}|${Object.keys(store.get().wavetables || {}).join(',')}`;
    const vk = ['Pos', 'Warp', 'WarpAmt'].map((x) => `${params[`osc1${x}`]}|${params[`osc2${x}`]}`).join('|');
    if (tk !== lastTables) { lastTables = tk; lastView = vk; build(); return; }
    if (vk !== lastView) { lastView = vk; draw(); }
  };
}
