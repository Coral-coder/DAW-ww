// SETI Scope: a fullscreen visualizer in the style of the classic radio-telescope screensaver, where every
// number is real analysis of the playing audio (src/audio/analysis/seti-signals.js). Main thread only: it reads
// an unsmoothed AnalyserNode tap (engine.getStripAnalyser) once per frame, nothing runs on the audio thread.
import {
  SetiAnalyzer, analysisRows, makeBandMap, bandsFromDb, dbToUnit, viewProjection, cameraPose, projectPoint, CAMERA_MODES,
  formatHz, formatRA, formatDec, keyToDec, formatCpuTime, formatRecordedOn, formatPercent, skyFrequency, midiToFreq,
  gaussianAt, fmt, STAGE_LABEL, ENV_FPS,
} from '../../../audio/analysis/seti-signals.js';
import { PITCH_NAMES } from '../../../audio/analysis/key.js';
import { tempoMapFor } from '../../../time/tempo-map.js';
import { PLOT, LEVELS, PlotHistory, FrameBudget, initialLevel, songProgress, SessionStats } from './plot.js';
import { createGlScene } from './scene-gl.js';
import { create2dScene } from './scene-2d.js';
import { injectSetiStyle } from './style.js';
import { loadSetiPrefs, saveSetiPrefs, requestFs } from './launch.js';

const FFT = 4096;
const HISTORY_SECONDS = 4.5;
const F_MIN = 30, F_MAX = 16000;
const session = new SessionStats(); // work units + CPU time survive closing / reopening within a page session

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
/** Panel with a title bar and label/value rows; returns { el, set(i, value, hot) }. */
function panel(cls, title, labels) {
  const p = el('div', `seti-panel ${cls}`);
  p.appendChild(el('div', 'seti-ptitle', title));
  const table = el('table', 'seti-rows');
  const cells = labels.map((l) => {
    const tr = el('tr');
    tr.appendChild(el('th', '', l ? `${l}:` : ''));
    const td = el('td');
    tr.appendChild(td);
    table.appendChild(tr);
    return td;
  });
  p.appendChild(table);
  const last = [];
  return {
    el: p,
    table,
    labels: [...table.querySelectorAll('th')],
    set(i, v, hot = false) {
      if (!cells[i]) return;
      if (last[i] !== v) { cells[i].textContent = v; last[i] = v; }
      cells[i].classList.toggle('hot', hot);
    },
  };
}
const isMinorScale = (s) => /minor|dorian|phrygian|aeolian|locrian|blues/i.test(String(s || ''));

export function mountSetiScope(host, app, opts = {}) {
  injectSetiStyle();
  const { store, engine } = app;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const prefs = loadSetiPrefs();
  const st = {
    camera: CAMERA_MODES.includes(prefs.camera) ? prefs.camera : 'orbit',
    crt: prefs.crt !== false, retro: !!prefs.retro, saver: !!opts.screensaver,
    sourceId: opts.source || 'master',
  };

  // ------------------------------------------------------------------ DOM
  const stage = el('div', 'seti-stage');
  let glCanvas = el('canvas', 'seti-gl');
  const bloom = el('canvas', 'seti-bloom');
  const labels = el('canvas', 'seti-labels');
  const crt = el('div', 'seti-crt');
  const title = el('div', 'seti-title');
  title.append(el('h1', '', 'SETI Scope'));
  const subtitle = el('div', '', '');
  title.append(subtitle);
  const toolbar = el('div', 'seti-toolbar');
  const msg = el('div', 'seti-msg');

  const analysisP = panel('seti-analysis', 'Data Analysis', ['Doing', 'Chirp rate', 'Fft length', 'Best spike', '', 'Best gaussian', 'Best pulse', '', 'Best triplet', '']);
  const infoP = panel('seti-info', 'Data Info', ['From', 'Recorded on', 'Recorded by', 'Base frequency', 'Sky frequency', 'Sky coordinates', '', 'Source', 'Listening to']);
  const userP = panel('seti-user', 'User Info', ['Name', 'Work units completed', 'Total CPU time', '% done']);
  const doneBar = el('div', 'seti-bar');
  const doneFill = el('i');
  doneBar.appendChild(doneFill);
  userP.el.appendChild(doneBar);
  const graphs = el('div', 'seti-panel seti-graphs');
  graphs.appendChild(el('div', 'seti-ptitle', 'Gaussian'));
  const gLabel = el('div', 'seti-glabel');
  const gL1 = el('span'), gL2 = el('span');
  gLabel.append(gL1, gL2);
  const gaussCv = el('canvas', 'seti-gauss');
  const powerLabel = el('div', 'seti-glabel');
  const pL1 = el('span', '', 'Power'), pL2 = el('b');
  powerLabel.append(pL1, pL2);
  const powerCv = el('canvas', 'seti-power');
  graphs.append(gLabel, gaussCv, powerLabel, powerCv);
  const strip = el('div', 'seti-strip');
  const stripText = el('span', '', 'SETI Scope');
  const stripBar = el('div', 'seti-bar');
  const stripFill = el('i');
  stripBar.appendChild(stripFill);
  const stripPct = el('span', '', '0.000%');
  strip.append(stripText, stripBar, stripPct);

  const btn = (label, title, fn) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); syncToolbar(); });
    toolbar.appendChild(b);
    return b;
  };
  const bSource = btn('Source', 'Cycle the analysed source: master, buses, tracks (S)', () => cycleSource(1));
  const bCam = btn('Camera', 'Camera: orbit / fixed / fly (C)', () => cycleCamera());
  const bCrt = btn('CRT', 'Scanlines + bloom (B)', () => setCrt(!st.crt));
  const bRetro = btn('Retro 640×480', 'Pixelated 640×480 mode (R)', () => setRetro(!st.retro));
  const bSaver = btn('Screensaver', 'Open automatically after a few idle minutes while playing', () => {
    const p = saveSetiPrefs({ screensaver: !loadSetiPrefs().screensaver });
    app.toast?.(p.screensaver ? `SETI Scope screensaver on: after ${p.idleMinutes} idle minutes while playing` : 'SETI Scope screensaver off', { timeout: 2500 });
  });
  const bFs = btn('Fullscreen', 'Toggle fullscreen (F)', () => toggleFs());
  btn('Close', 'Close (Esc)', () => close());

  stage.append(glCanvas, bloom, labels, crt, title, analysisP.el, infoP.el, userP.el, graphs, strip, toolbar, msg);
  host.appendChild(stage);
  try { host.focus({ preventScroll: true }); } catch { /* */ }

  // ------------------------------------------------------------------ scene
  let scene = createGlScene(glCanvas);
  if (!scene) {
    const c2 = el('canvas', 'seti-gl'); // a canvas that failed WebGL may already hold a context
    glCanvas.replaceWith(c2);
    glCanvas = c2;
    scene = create2dScene(glCanvas);
  }
  const bctx = bloom.getContext('2d');
  const lctx = labels.getContext('2d');
  let sizeDirty = true;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let level = initialLevel({ width: innerWidth, height: innerHeight, coarse, dpr: devicePixelRatio || 1 });
  if (scene?.kind === 'canvas') level = Math.max(level, 4);
  let hist, bandMap, bandsDb, rowAcc, nB, nR, rowPeriod;
  let sampleRate = engine.ctx?.sampleRate || 48000;
  function setLevel(l) {
    level = Math.max(0, Math.min(LEVELS.length - 1, l));
    [nB, nR] = LEVELS[level];
    hist = new PlotHistory(nB, nR);
    bandMap = makeBandMap(nB, FFT, sampleRate, F_MIN, F_MAX);
    bandsDb = new Float32Array(nB);
    rowAcc = new Float32Array(nB);
    rowPeriod = HISTORY_SECONDS / nR;
    scene?.setGrid(nB, nR);
    scene?.setHistory?.(hist);
  }
  setLevel(level);
  const analyzer = new SetiAnalyzer({ sampleRate, fftSize: FFT });
  const db = new Float32Array(FFT / 2);
  const td = new Float32Array(FFT);

  // ------------------------------------------------------------------ source tap
  let tap = null, tapId = null, tapGraph = null, tapCheck = 0;
  const sources = () => {
    const p = store.get();
    return [{ id: 'master', label: 'Master' }, ...(p.buses || []).map((b) => ({ id: b.id, label: `Bus: ${b.name}` })), ...p.tracks.map((t) => ({ id: t.id, label: t.name }))];
  };
  const sourceLabel = () => sources().find((s) => s.id === st.sourceId)?.label || 'Master';
  function acquire(now) {
    if (tap && tapId === st.sourceId && tapGraph === engine.graph && now - tapCheck < 1000) return tap;
    tapCheck = now;
    if (!sources().some((s) => s.id === st.sourceId)) st.sourceId = 'master';
    if (tapId && tapId !== st.sourceId && tapGraph === engine.graph) engine.releaseStripAnalyser?.(tapId);
    const node = engine.getStripAnalyser?.(st.sourceId, { fftSize: FFT }) || null;
    if (node && node.context?.sampleRate && node.context.sampleRate !== sampleRate) {
      sampleRate = node.context.sampleRate;
      analyzer.sampleRate = sampleRate;
      bandMap = makeBandMap(nB, FFT, sampleRate, F_MIN, F_MAX);
    }
    tap = node; tapId = st.sourceId; tapGraph = engine.graph;
    return tap;
  }
  function cycleSource(dir) {
    const list = sources();
    const i = list.findIndex((s) => s.id === st.sourceId);
    st.sourceId = list[(i + dir + list.length) % list.length].id;
    tapCheck = 0;
    flash(`Source: ${sourceLabel()}`);
  }
  function cycleCamera() {
    st.camera = CAMERA_MODES[(CAMERA_MODES.indexOf(st.camera) + 1) % CAMERA_MODES.length];
    saveSetiPrefs({ camera: st.camera });
    flash(`Camera: ${st.camera}`);
  }
  function setCrt(on) { st.crt = on; saveSetiPrefs({ crt: on }); applyClasses(); }
  function setRetro(on) { st.retro = on; saveSetiPrefs({ retro: on }); applyClasses(); sizeDirty = true; }
  function applyClasses() {
    stage.classList.toggle('crt', st.crt);
    stage.classList.toggle('retro', st.retro);
    stage.classList.toggle('saver', st.saver);
  }
  function syncToolbar() {
    bSource.textContent = `Source: ${sourceLabel()}`;
    bCam.textContent = `Camera: ${st.camera}`;
    bCrt.classList.toggle('on', st.crt);
    bRetro.classList.toggle('on', st.retro);
    bSaver.classList.toggle('on', !!loadSetiPrefs().screensaver);
    bFs.classList.toggle('on', !!fsElement());
  }
  applyClasses();
  syncToolbar();
  let flashT = 0;
  function flash(text) { msg.textContent = text; msg.classList.add('on'); flashT = performance.now() + 1400; syncToolbar(); }

  // ------------------------------------------------------------------ fullscreen + input
  let fsOurs = false, fsToggling = false;
  function toggleFs() {
    if (fsElement()) {
      fsToggling = true;
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    } else {
      requestFs(host).then((ok) => { fsOurs = ok; if (!ok) flash('Fullscreen not available — showing the scope in the window'); });
    }
  }
  opts.fsRequest?.then?.((ok) => { fsOurs = ok; syncToolbar(); });
  const onFsChange = () => {
    if (fsElement() === host) { fsOurs = true; }
    else if (fsOurs && !fsToggling) { fsOurs = false; close(); return; } // Esc in fullscreen leaves it: close too
    else fsOurs = false;
    fsToggling = false;
    sizeDirty = true;
    syncToolbar();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  const onKey = (e) => {
    if (st.saver) { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (k === ' ') { if (!e.repeat) (app.actions?.togglePlay ? app.actions.togglePlay() : engine.togglePlay?.()); }
    else if (k === 'Escape') close();
    else if (k === 'f') toggleFs();
    else if (k === 's') cycleSource(e.shiftKey ? -1 : 1);
    else if (k === 'c') cycleCamera();
    else if (k === 'r') setRetro(!st.retro);
    else if (k === 'b') setCrt(!st.crt);
    else handled = false;
    if (handled) { e.preventDefault(); syncToolbar(); }
    e.stopImmediatePropagation(); // the app's shortcuts stay quiet behind the scope
  };
  window.addEventListener('keydown', onKey, true);

  let down = null, moved = 0, uiTimer = 0;
  const onDown = (e) => {
    if (st.saver) { e.preventDefault(); close(); return; }
    down = { x: e.clientX, y: e.clientY, t: performance.now(), onUi: !!e.target.closest?.('.seti-toolbar') };
  };
  const onUp = (e) => {
    if (!down) return;
    const d = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t, onUi = down.onUi;
    down = null;
    if (!onUi && d < 12 && dt < 700) close(); // tap / click closes
  };
  const onMove = (e) => {
    if (st.saver) {
      moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      if (moved > 24) close();
      return;
    }
    stage.classList.add('show-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => stage.classList.remove('show-ui'), 2500);
  };
  const onWheel = () => { if (st.saver) close(); };
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('wheel', onWheel, { passive: true });
  if (!st.saver && coarse) { stage.classList.add('show-ui'); uiTimer = setTimeout(() => stage.classList.remove('show-ui'), 3500); }

  // ------------------------------------------------------------------ sizing
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { sizeDirty = true; }) : null;
  ro?.observe(stage);
  let W = 1, H = 1, cssW = 1, cssH = 1;
  function resize() {
    sizeDirty = false;
    const r = stage.getBoundingClientRect();
    cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
    const dpr = Math.min(devicePixelRatio || 1, level >= 4 ? 1.5 : 2);
    if (st.retro) { const k = Math.min(640 / cssW, 480 / cssH); W = Math.round(cssW * k); H = Math.round(cssH * k); }
    else { W = Math.round(cssW * dpr); H = Math.round(cssH * dpr); }
    scene?.resize(W, H);
    bloom.width = Math.max(1, Math.round(W / 4)); bloom.height = Math.max(1, Math.round(H / 4));
    const ldpr = Math.min(devicePixelRatio || 1, 2);
    labels.width = Math.round(cssW * ldpr); labels.height = Math.round(cssH * ldpr);
    for (const cv of [gaussCv, powerCv]) {
      const b = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(b.width * ldpr)); cv.height = Math.max(1, Math.round(b.height * ldpr));
    }
  }

  // ------------------------------------------------------------------ drawing helpers
  function drawLabels(vp) {
    const w = labels.width, h = labels.height, s = w / cssW;
    lctx.clearRect(0, 0, w, h);
    const P = (x, y, z) => projectPoint(vp, x, y, z, w, h);
    lctx.font = `${Math.round((st.retro ? 10 : 12) * s)}px "Lucida Console", Monaco, "Courier New", monospace`;
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    lctx.fillStyle = '#7fb6ff';
    lctx.lineWidth = 3 * s;
    lctx.strokeStyle = 'rgba(0,0,0,.85)';
    const text = (t, p) => { if (p && p.z < 1) { lctx.strokeText(t, p.x, p.y); lctx.fillText(t, p.x, p.y); } };
    lctx.font = `bold ${Math.round((st.retro ? 11 : 14) * s)}px "MS Sans Serif", Tahoma, Verdana, sans-serif`;
    text('Frequency', P(0, 0, 0.32));
    text('Time', P(PLOT.width + 0.3, 0, -PLOT.depth / 2));
    text('Power', P(-PLOT.width - 0.12, PLOT.height * 0.55, -PLOT.depth));
    lctx.font = `${Math.round((st.retro ? 10 : 12) * s)}px "Lucida Console", Monaco, "Courier New", monospace`;
    lctx.fillStyle = '#4f7fd6';
    const span = Math.log(F_MAX / F_MIN);
    for (const [f, t] of [[50, '50'], [100, '100'], [500, '500'], [1000, '1k'], [5000, '5k'], [10000, '10k']]) {
      const x = -PLOT.width + (2 * PLOT.width * Math.log(f / F_MIN)) / span;
      text(t, P(x, 0, 0.1));
    }
    text('now', P(PLOT.width + 0.1, 0, 0.04));
    text(`−${HISTORY_SECONDS.toFixed(1)} s`, P(PLOT.width + 0.14, 0, -PLOT.depth));
  }

  function drawGauss(a) {
    const c = gaussCv.getContext('2d');
    const w = gaussCv.width, h = gaussCv.height;
    c.fillStyle = '#000615';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#0f2a6e';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 4; i++) { c.moveTo(0, (h * i) / 4); c.lineTo(w, (h * i) / 4); c.moveTo((w * i) / 4, 0); c.lineTo((w * i) / 4, h); }
    c.stroke();
    const y = a.state.gaussWindow, g = a.state.gaussian;
    if (!y || !y.length) return;
    let max = 0;
    for (let i = 0; i < y.length; i++) if (y[i] > max) max = y[i];
    if (g) max = Math.max(max, g.a + g.b);
    max = max || 1;
    const X = (i) => (i / (y.length - 1)) * w, Y = (v) => h - 3 - (v / max) * (h - 8);
    // measured power (bars like the original graph)
    const bw = Math.max(1, w / y.length);
    for (let i = 0; i < y.length; i++) {
      c.fillStyle = '#2f7cff';
      const yy = Y(y[i]);
      c.fillRect(X(i), yy, bw, h - yy);
    }
    if (g) {
      c.strokeStyle = '#ffe066';
      c.lineWidth = Math.max(1.5, w / 200);
      c.beginPath();
      for (let i = 0; i < y.length; i++) { const v = gaussianAt(g, i); if (i) c.lineTo(X(i), Y(v)); else c.moveTo(X(i), Y(v)); }
      c.stroke();
    }
  }

  function drawPower(a) {
    const c = powerCv.getContext('2d');
    const w = powerCv.width, h = powerCv.height;
    c.fillStyle = '#000615';
    c.fillRect(0, 0, w, h);
    const env = a.envelope('loud', 8);
    if (env.length < 2) return;
    c.strokeStyle = '#6fe3ff';
    c.lineWidth = Math.max(1, w / 260);
    c.beginPath();
    const step = Math.max(1, Math.floor(env.length / w));
    for (let i = 0, j = 0; i < env.length; i += step, j++) {
      const v = Math.max(0, Math.min(1, (env[i] + 72) / 72));
      const x = (i / (env.length - 1)) * w, yy = h - 2 - v * (h - 4);
      if (j) c.lineTo(x, yy); else c.moveTo(x, yy);
    }
    c.stroke();
  }

  // ------------------------------------------------------------------ panels
  let loudestName = '—', loudT = 0;
  function loudestTrack(now) {
    if (now - loudT < 200) return loudestName;
    loudT = now;
    let best = 0, name = '—';
    for (const t of store.get().tracks) {
      const m = engine.getMeter?.(t.id);
      const v = m ? Math.max(m.l || 0, m.r || 0) : 0;
      if (v > best) { best = v; name = t.name; }
    }
    loudestName = best > 0.001 ? name : '—';
    return loudestName;
  }
  const userName = () => {
    const p = store.get();
    let n = p.author;
    if (!n) { try { n = localStorage.getItem('daw3-collab-name'); } catch { n = null; } }
    if (n && n.startsWith('"')) { try { n = JSON.parse(n); } catch { /* raw */ } }
    return n || 'Anonymous';
  };

  function updatePanels(now) {
    const a = analyzer.state;
    const rows = analysisRows(a);
    rows.forEach(([, v], i) => analysisP.set(i, v, i === 0 || (a.stage === 'spike' && (i === 3 || i === 4)) || (a.stage === 'gaussian' && i === 5) || (a.stage === 'pulse' && (i === 6 || i === 7)) || (a.stage === 'triplet' && (i === 8 || i === 9)) || (a.stage === 'baseline' && i === 2)));
    const p = store.get();
    const pos = Math.max(0, engine.getPosition?.() || 0);
    const map = tempoMapFor(p, p.mode);
    const bbt = map.position(pos);
    const signal = a.loudDb > -80;
    const detected = signal && a.key && a.key.confidence > 0.02 ? a.key : null;
    const tonic = detected ? detected.tonic : p.key.root;
    const minor = detected ? detected.mode === 'minor' : isMinorScale(p.key.scale);
    const keyLabel = `${PITCH_NAMES[tonic]} ${minor ? 'minor' : 'major'}${detected ? ', detected' : ', project key'}`;
    const tonicHz = midiToFreq(60 + tonic);
    let created = p.createdAt ? new Date(p.createdAt) : new Date();
    if (Number.isNaN(created.getTime())) created = new Date();
    infoP.set(0, p.name || 'Untitled Project');
    infoP.set(1, formatRecordedOn(created));
    infoP.set(2, 'daW³');
    infoP.set(3, `${formatHz(tonicHz)} (${keyLabel})`);
    infoP.set(4, formatHz(skyFrequency(tonicHz)));
    infoP.set(5, `RA ${formatRA(bbt.bar, bbt.beat, bbt.sub + 1)}`);
    infoP.set(6, `Dec ${formatDec(keyToDec(tonic, minor ? 'minor' : 'major'))}`);
    infoP.set(7, loudestTrack(now));
    infoP.set(8, sourceLabel());
    const done = songProgress(p, pos);
    userP.set(0, userName());
    userP.set(1, String(session.bars));
    userP.set(2, formatCpuTime(session.cpu));
    userP.set(3, formatPercent(done));
    doneFill.style.width = `${(done * 100).toFixed(2)}%`;
    stripFill.style.width = `${(done * 100).toFixed(2)}%`;
    stripPct.textContent = formatPercent(done);
    stripText.textContent = `${engine.isPlaying ? '▶' : '■'} ${STAGE_LABEL[a.stage]}`;
    subtitle.textContent = `${sourceLabel()} · ${scene?.kind === 'webgl' ? 'WebGL' : 'Canvas'} · ${nB}×${nR}`;
    const g = a.gaussian;
    gL1.textContent = g ? `fit ${fmt(g.r2, 3)}` : 'fit —';
    gL2.textContent = g ? `σ ${fmt(g.sigma / ENV_FPS, 2)} s · power ${fmt(g.power, 2)}` : '';
    pL2.textContent = `${fmt(a.loudDb, 1)} dBFS`;
    if (now > flashT) {
      const noSignal = !tap ? 'No audio yet — press Space to play' : !signal && !engine.isPlaying ? 'No signal — press Space to play' : '';
      msg.textContent = noSignal;
      msg.classList.toggle('on', !!noSignal);
    }
  }

  // ------------------------------------------------------------------ loop
  const budget = new FrameBudget({ budgetMs: 21, window: 2.5 });
  let raf = 0, lastTs = 0, rowT = 0, camT = 0, panelT = 0, graphT = 0, closed = false;
  function frame(ts) {
    raf = 0;
    if (closed) return;
    const rawDt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
    const dt = Math.min(0.1, rawDt); // animation step (no jumps after a stall)
    lastTs = ts;
    if (sizeDirty) resize();
    if (budget.tick(rawDt) && level < LEVELS.length - 1) { setLevel(level + 1); sizeDirty = true; }
    const t = ts / 1000;
    const an = acquire(ts);
    if (an) {
      an.getFloatFrequencyData(db);
      an.getFloatTimeDomainData(td);
      analyzer.push(db, td, t);
      bandsFromDb(db, bandMap, bandsDb);
      for (let b = 0; b < nB; b++) { const v = dbToUnit(bandsDb[b]); if (v > rowAcc[b]) rowAcc[b] = v; }
    }
    rowT += dt;
    while (rowT >= rowPeriod) {
      rowT -= rowPeriod;
      scene?.uploadRow(hist.push(rowAcc), hist.row(hist.head));
      rowAcc.fill(0);
    }
    const p = store.get();
    const pos = Math.max(0, engine.getPosition?.() || 0);
    session.tick(Math.min(1, rawDt), !!engine.isPlaying, engine.isPlaying ? tempoMapFor(p, p.mode).barAt(pos).bar : null);
    camT += dt;
    const aspect = W / Math.max(1, H);
    const vp = viewProjection(st.camera, camT, aspect, { depth: PLOT.depth });
    scene?.render(vp, hist.head, rowT / rowPeriod, cameraPose(st.camera, camT, { depth: PLOT.depth, aspect }).eye);
    if (st.crt && bctx) { try { bctx.drawImage(glCanvas, 0, 0, bloom.width, bloom.height); } catch { /* */ } }
    drawLabels(vp);
    if (ts - panelT > 100) { panelT = ts; updatePanels(ts); }
    if (ts - graphT > 66) { graphT = ts; drawGauss(analyzer); drawPower(analyzer); }
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }
  const onVis = () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
    else if (!raf && !closed) { lastTs = 0; raf = requestAnimationFrame(frame); }
  };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(frame);

  function close() {
    if (closed) return;
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(uiTimer);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    document.removeEventListener('visibilitychange', onVis);
    ro?.disconnect();
    if (fsElement() === host) { try { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {}); } catch { /* */ } }
    if (tapId && tapGraph === engine.graph) engine.releaseStripAnalyser?.(tapId);
    scene?.dispose();
    host.remove();
    opts.onClose?.();
  }

  return { close, get state() { return { ...st, level, bands: nB, rows: nR, renderer: scene?.kind || null, analysis: analyzer.state }; } };
}
