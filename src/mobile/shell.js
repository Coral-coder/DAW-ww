// daW³ Pocket — the phone-first shell. Same store / engine / actions / generators as the desktop layout
// (createCore), different UI: swipeable pages + bottom tab bar + mini transport, big touch controls.
import { createCore } from '../ui/app.js';
import { installAutomationRecorder } from '../ui/automation-recorder.js';
import { h, icon } from '../ui/dom.js';
import { beatsPerBar } from '../core/model.js';
import { PAGES, SUBPAGES, parseRoute, routeHash, tabOf, neighbour, swipeDecision, isSwipeBlocked } from './router.js';
import { switchLayout } from './mode.js';
import { actionSheet, haptic, closeTopSheet, onLongPress } from './touch.js';
import { showOnboarding } from './onboarding.js';
import { openParamPopup, valueTarget } from './controls.js';
import { installPocketNative, nativeMenuItems } from './native.js';

const PAGE_MODULES = {
  home: () => import('./pages/home.js').then((m) => m.createHomePage),
  tracks: () => import('./pages/tracks.js').then((m) => m.createTracksPage),
  arrange: () => import('./pages/arrange.js').then((m) => m.createArrangePage),
  code: () => import('./pages/code.js').then((m) => m.createCodePage),
  track: () => import('./pages/track.js').then((m) => m.createTrackPage),
  notes: () => import('./pages/notes.js').then((m) => m.createNotesPage),
  play: () => import('./pages/play.js').then((m) => m.createPlayPage),
  mix: () => import('./pages/mix.js').then((m) => m.createMixPage),
  setlist: () => import('./pages/setlist.js').then((m) => m.createSetlistPage),
};

export const TEMPO_DEF = { key: 'bpm', label: 'Tempo', type: 'number', min: 40, max: 240, step: 1, default: 120, unit: 'BPM', format: (v) => `${Math.round(v)} BPM` };

function pocketDocument() {
  const root = document.documentElement;
  root.classList.add('pocket');
  // no pinch-zoom / double-tap zoom for the app shell (our own gestures zoom the piano roll)
  const vp = document.querySelector('meta[name=viewport]');
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  if (!document.querySelector('link[data-pocket-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('styles/mobile.css', document.baseURI).href;
    link.dataset.pocketCss = '';
    document.head.appendChild(link);
  }
  // iOS: block the rubber-band bounce of the whole page and Safari's gesture zoom
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

export async function createPocketApp(rootEl) {
  pocketDocument();
  const app = createCore();
  const { store, ui, engine, actions } = app;
  app.pocket = true;
  app.keyboardPiano = { enabled: false }; // actions.toggleRecord flips it (no computer-keyboard piano on phones)
  app.views = {};
  installAutomationRecorder(app);
  rootEl.className = 'pk';
  rootEl.replaceChildren();

  // ------------------------------------------------------------------ transport
  const playBtn = h('button.pk-tp.play', { type: 'button', 'aria-label': 'Play / pause' }, icon('play', 24));
  const stopBtn = h('button.pk-tp', { type: 'button', 'aria-label': 'Stop' }, icon('stop', 20));
  const recBtn = h('button.pk-tp.rec', { type: 'button', 'aria-label': 'Record' }, icon('record', 20));
  const posEl = h('div.pk-pos', '1.1');
  const bpmBtn = h('button.pk-bpm', { type: 'button', title: 'Tempo' }, '120');
  const modeBtn = h('button.pk-modebtn', { type: 'button', title: 'Pattern loop / whole song' }, 'LOOP');
  const undoBtn = h('button.pk-tp.sm', { type: 'button', 'aria-label': 'Undo' }, icon('undo', 18));
  const redoBtn = h('button.pk-tp.sm', { type: 'button', 'aria-label': 'Redo' }, icon('redo', 18));
  const menuBtn = h('button.pk-tp.sm', { type: 'button', 'aria-label': 'Menu' }, icon('menu', 20));
  const transport = h('header.pk-transport', playBtn, stopBtn, recBtn, h('div.pk-tp-mid', posEl, h('div.pk-tp-sub', bpmBtn, modeBtn)), undoBtn, redoBtn, menuBtn);

  playBtn.addEventListener('click', () => { haptic(8); actions.togglePlay(); });
  stopBtn.addEventListener('click', () => { haptic(8); if (app.setlist?.running) app.setlist.stop(); actions.stop(); });
  recBtn.addEventListener('click', () => { haptic(8); recordMenu(); });
  bpmBtn.addEventListener('click', () => openParamPopup(app, valueTarget(TEMPO_DEF, () => store.get().bpm, (v) => store.transact('Tempo', (p) => { p.bpm = Math.round(v); }, { coalesce: true }))));
  modeBtn.addEventListener('click', () => { haptic(6); actions.setMode(store.get().mode === 'song' ? 'pattern' : 'song'); });
  undoBtn.addEventListener('click', () => { haptic(6); actions.undo(); });
  redoBtn.addEventListener('click', () => { haptic(6); actions.redo(); });
  onLongPress(undoBtn, () => undoMenu());
  // undo history as a sheet (long-press ↶): jump back several steps at once
  function undoMenu() {
    const steps = (store.undoStack || []).slice(-12).reverse();
    actionSheet('Undo', steps.length ? steps.map((st, i) => ({ label: `${i ? `${i + 1} steps: ` : ''}${st.label}`, icon: 'undo', onClick: () => { for (let k = 0; k <= i; k++) actions.undo(); } })) : [{ label: 'Nothing to undo', disabled: true }]);
  }
  menuBtn.addEventListener('click', () => mainMenu());

  function recordMenu() {
    if (ui.get('recording')) { actions.toggleRecord(); return; }
    actionSheet('Record', [
      { label: 'Hum / whistle to notes', icon: 'music', onClick: () => openHum() },
      { label: 'Record notes (play the keys)', icon: 'piano', onClick: () => { go({ page: 'play' }); setTimeout(() => actions.toggleRecord(), 50); } },
      { label: 'Record audio (microphone)', icon: 'wave', onClick: () => recordAudio() },
      { label: `Count-in: ${ui.get('countIn') ? 'on' : 'off'}`, icon: 'metronome', onClick: () => actions.setCountIn(!ui.get('countIn')) },
    ]);
  }
  app.openHum = openHum;
  app.recordAudio = recordAudio;
  async function openHum(opts = {}) {
    const m = await import('./hum.js');
    m.openHumSheet(app, opts);
  }
  async function recordAudio() {
    let t = store.get().tracks.find((x) => x.type === 'audio' && x.arm) || store.get().tracks.find((x) => x.type === 'audio');
    if (!t) t = actions.addTrack('audio', { name: 'Mic' });
    if (!t.arm) actions.updateTrack(t.id, (tt) => { tt.arm = true; }, 'Arm track');
    await actions.toggleRecord();
  }

  function mainMenu() {
    const p = store.get();
    actionSheet(p.name || 'daW³', [
      { label: 'Undo', icon: 'undo', disabled: !store.canUndo(), onClick: () => actions.undo() },
      { label: 'Redo', icon: 'redo', disabled: !store.canRedo?.(), onClick: () => actions.redo() },
      '-',
      { label: `Metronome: ${p.metronome ? 'on' : 'off'}`, icon: 'metronome', onClick: () => store.transact('Metronome', (pp) => { pp.metronome = !pp.metronome; }, { undo: false }) },
      { label: `Loop / song: ${p.mode === 'song' ? 'whole song' : 'loop patterns'}`, icon: 'loop', onClick: () => actions.setMode(p.mode === 'song' ? 'pattern' : 'song') },
      { label: `Theme: ${ui.get('theme') === 'dark' ? 'switch to light' : 'switch to dark'}`, icon: 'sun', onClick: () => ui.set({ theme: ui.get('theme') === 'dark' ? 'light' : 'dark' }) },
      { label: 'Song timeline', icon: 'scenes', onClick: () => go({ page: 'arrange' }) },
      { label: 'Strudel code', icon: 'code', onClick: () => go({ page: 'code' }) },
      { label: 'Desktop layout', icon: 'grid', onClick: () => switchLayout('desktop') },
      ...nativeMenuItems(app, nav), // iOS app: Files import; MIDI keyboards
      '-',
      { label: 'Show the tips again', icon: 'bulb', onClick: () => showOnboarding({ force: true }) },
      { label: 'Help', icon: 'help', onClick: () => actions.showHelp() },
      { label: 'About / source code', icon: 'code', onClick: () => actions.showAbout() },
    ]);
  }

  // ------------------------------------------------------------------ pages
  const pagesEl = h('main.pk-pages');
  const tabsEl = h('nav.pk-tabs');
  rootEl.append(transport, pagesEl, tabsEl);
  const tabBtns = PAGES.map((pg) => {
    const b = h('button.pk-tab', { type: 'button', dataset: { page: pg.id } }, icon(pg.icon, 22), h('span', pg.label));
    b.addEventListener('click', () => { haptic(5); go({ page: pg.id }); });
    tabsEl.appendChild(b);
    return b;
  });

  const pages = {}; // id -> {host, view}
  let route = null;
  const nav = { go: (r) => go(r), back: () => history.length > 1 ? history.back() : go({ page: tabOf(route?.page || 'home') }) };
  app.nav = nav;

  async function mount(id) {
    if (pages[id]) return pages[id];
    const host = h('section.pk-page', { dataset: { page: id }, hidden: true }); // shown by show() (a late mount must not cover the current page)
    pagesEl.appendChild(host);
    pages[id] = { host, view: null };
    try {
      const factory = await PAGE_MODULES[id]();
      const view = factory(app, nav);
      host.appendChild(view.el);
      pages[id].view = view;
    } catch (e) {
      console.error(`[pocket:${id}]`, e);
      host.appendChild(h('div.pk-empty', h('h3', 'This page failed to load'), h('code', e.message)));
    }
    return pages[id];
  }

  async function show(r, dir = 0) {
    const prev = route;
    route = r;
    const tab = tabOf(r.page);
    for (const b of tabBtns) b.classList.toggle('on', b.dataset.page === tab);
    const pg = await mount(r.page);
    if (route !== r) return;
    for (const [id, p] of Object.entries(pages)) {
      const on = id === r.page;
      if (!on && !p.host.hidden) p.view?.hide?.();
      p.host.hidden = !on;
      p.host.classList.remove('from-left', 'from-right');
    }
    if (dir && prev) { void pg.host.offsetWidth; pg.host.classList.add(dir > 0 ? 'from-right' : 'from-left'); }
    pg.view?.show?.(r);
    try { localStorage.setItem('daw3-pocket-page', r.page === 'track' ? 'tracks' : r.page); } catch { /* */ }
  }

  function go(r, { replace = false } = {}) {
    if (!r?.page) return;
    const cur = route;
    const ci = PAGES.findIndex((p) => p.id === tabOf(cur?.page || 'home'));
    const ni = PAGES.findIndex((p) => p.id === tabOf(r.page));
    const dir = SUBPAGES[r.page] ? 1 : SUBPAGES[cur?.page] && tabOf(cur.page) === r.page ? -1 : Math.sign(ni - ci);
    const hash = routeHash(r);
    // absolute URL: a relative '#/…' would resolve against <base> (published builds live in v/<sha>/)
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + hash);
    show(r, dir);
  }
  window.addEventListener('popstate', () => { closeTopSheet(); show(parseRoute(location.hash), -1); });

  // ------------------------------------------------------------------ swipe between pages
  // Touch: touch events (they keep coming after the browser claims the gesture and sends pointercancel);
  // mouse / pen: pointer events.
  let sw = null;
  const swStart = (x, y, target, id) => {
    if (isSwipeBlocked(target)) return;
    sw = { x, y, t: performance.now(), id, horiz: null, lx: x, ly: y };
  };
  const swMove = (x, y, id) => {
    if (!sw || id !== sw.id) return;
    sw.lx = x; sw.ly = y;
    const dx = x - sw.x, dy = y - sw.y;
    if (sw.horiz === null && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) sw.horiz = Math.abs(dx) > Math.abs(dy) * 1.6;
    if (sw.horiz) {
      const host = pages[route?.page]?.host;
      const edge = !neighbour(route.page, dx < 0 ? 1 : -1);
      if (host) host.style.transform = `translateX(${edge ? dx * 0.2 : dx * 0.6}px)`;
    }
  };
  const swEnd = (x, y, id, cancelled = false) => {
    if (!sw || id !== sw.id) return;
    const s = sw;
    sw = null;
    const host = pages[route?.page]?.host;
    if (host) host.style.transform = '';
    if (!s.horiz || cancelled) return;
    const dir = swipeDecision({ dx: (x ?? s.lx) - s.x, dy: (y ?? s.ly) - s.y, dt: performance.now() - s.t, width: pagesEl.clientWidth });
    const to = dir && neighbour(route.page, dir);
    if (to) { haptic(6); go({ page: to }); }
  };
  pagesEl.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' || (e.pointerType === 'mouse' && e.button !== 0)) return; swStart(e.clientX, e.clientY, e.target, `p${e.pointerId}`); });
  pagesEl.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') swMove(e.clientX, e.clientY, `p${e.pointerId}`); });
  pagesEl.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') swEnd(e.clientX, e.clientY, `p${e.pointerId}`); });
  pagesEl.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') swEnd(null, null, `p${e.pointerId}`, true); });
  pagesEl.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { sw = null; return; } const t = e.changedTouches[0]; swStart(t.clientX, t.clientY, e.target, `t${t.identifier}`); }, { passive: true });
  pagesEl.addEventListener('touchmove', (e) => { for (const t of e.changedTouches) swMove(t.clientX, t.clientY, `t${t.identifier}`); }, { passive: true });
  pagesEl.addEventListener('touchend', (e) => { for (const t of e.changedTouches) swEnd(t.clientX, t.clientY, `t${t.identifier}`); });
  pagesEl.addEventListener('touchcancel', (e) => { for (const t of e.changedTouches) swEnd(null, null, `t${t.identifier}`, true); });

  // ------------------------------------------------------------------ transport updates
  const bpb = () => beatsPerBar(store.get());
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const pos = engine.getPosition?.() || 0;
    const b = bpb();
    const bar = Math.floor(pos / b) + 1, beat = Math.floor(pos % b) + 1;
    const txt = `${bar}.${beat}`;
    if (posEl.textContent !== txt) posEl.textContent = txt;
  };
  raf = requestAnimationFrame(tick);
  const syncTransport = () => {
    const p = store.get();
    playBtn.replaceChildren(icon(engine.isPlaying ? 'pause' : 'play', 24));
    playBtn.classList.toggle('on', engine.isPlaying);
    recBtn.classList.toggle('on', !!ui.get('recording'));
    bpmBtn.textContent = `♩${Math.round(p.bpm)}`;
    modeBtn.textContent = p.mode === 'song' ? 'SONG' : 'LOOP';
    modeBtn.classList.toggle('song', p.mode === 'song');
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    document.documentElement.dataset.theme = ui.get('theme');
  };
  engine.on?.('state', () => syncTransport());
  app.subscribe(() => syncTransport());
  syncTransport();

  // Keep the screen's audio alive when the app comes back from the background (iOS suspends the context).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && engine.ctx?.state === 'suspended') engine.ctx.resume().catch(() => {}); });

  // ------------------------------------------------------------------ boot
  await actions.boot({ welcome: false });
  let initial = parseRoute(location.hash);
  if (!location.hash) { try { const s = localStorage.getItem('daw3-pocket-page'); if (s) initial = parseRoute('#/' + s); } catch { /* */ } }
  if (!store.get().tracks.length && !location.hash) initial = { page: 'home' };
  go(initial, { replace: true });
  installPocketNative(app, nav); // iOS app (ios/): "Open in daW³" documents, after boot so they win over autosave
  setTimeout(() => showOnboarding(), 400);
  void raf;
  return app;
}
