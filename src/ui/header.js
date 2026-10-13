// Top bar: main menu, transport, tempo/key/genre, mode switch, master meter.
import { h, icon } from './dom.js';
import { numberField, select, contextMenu, meter, knob } from './components.js';
import { SCALES, pitchClassName } from '../theory/index.js';
import { GENRES } from '../gen/genres.js';
import { beatsPerBar } from '../core/model.js';

export function createHeader(app) {
  const { store, ui, engine, actions } = app;
  const p0 = store.get();

  const menuBtn = h('button.icon-btn', { title: 'Menu' }, icon('menu', 18));
  menuBtn.addEventListener('click', (e) => contextMenu({ clientX: e.currentTarget.getBoundingClientRect().left, clientY: 46, preventDefault() {} }, actions.mainMenuItems()));
  const logo = h('div.logo', { title: 'daWWW — open the main menu' }, h('div.logo-mark', '⚡'), h('div', 'daWWW', h('small', 'THE WEB REMEMBERS')));
  logo.addEventListener('click', (e) => contextMenu({ clientX: 10, clientY: 46, preventDefault() {} }, actions.mainMenuItems()));

  // transport
  const tbtn = (ic, title, cls, onClick) => {
    const b = h(`button.transport-btn${cls ? '.' + cls : ''}`, { title, type: 'button' }, icon(ic, 16));
    b.addEventListener('click', onClick);
    return b;
  };
  const playBtn = tbtn('play', 'Play / Pause (Space)', 'play', () => actions.togglePlay());
  const stopBtn = tbtn('stop', 'Stop (Space twice / Enter)', '', () => actions.stop());
  const recBtn = tbtn('record', 'Record (R): notes from the keyboard/MIDI into the selected pattern — or, with an audio track armed (●), audio from your microphone / line-in onto the timeline', 'rec', () => actions.toggleRecord());
  const loopBtn = tbtn('loop', 'Loop region (L)', '', () => store.transact('Toggle loop', (p) => { p.loop.enabled = !p.loop.enabled; }));
  const metroBtn = tbtn('metronome', 'Metronome (M)', '', () => store.transact('Toggle metronome', (p) => { p.metronome = !p.metronome; }, { undo: false }));
  const lcd = h('div.lcd', { title: 'Position (bar.beat.step) — click to switch to time' }, '1.1.1');
  let lcdTime = false;
  lcd.addEventListener('click', () => { lcdTime = !lcdTime; });

  const bpm = numberField({ value: p0.bpm, min: 20, max: 400, step: 1, width: 54, title: 'Tempo (BPM) — drag or type', onChange: (v, { final }) => { if (final && store.get().bpm === v) return; store.transact('Tempo', (p) => { p.bpm = v; }, { coalesce: true }); } });
  const tapTimes = [];
  const tap = h('button.btn.small', { title: 'Tap tempo' }, 'TAP');
  tap.addEventListener('click', () => {
    const now = performance.now();
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes.length = 0;
    tapTimes.push(now);
    if (tapTimes.length >= 3) {
      const d = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
      const v = Math.round(60000 / d);
      if (v >= 20 && v <= 400) store.transact('Tap tempo', (p) => { p.bpm = v; });
    }
  });
  const sigOptions = ['4/4', '3/4', '6/8', '5/4', '7/8', '2/4', '12/8', '7/4'].map((s) => ({ value: s, label: s }));
  const sig = select({ options: sigOptions, value: p0.timeSig.join('/'), title: 'Time signature', onChange: (v) => store.transact('Time signature', (p) => { p.timeSig = v.split('/').map(Number); }) });
  const swing = numberField({ value: Math.round(p0.swing * 100), min: 0, max: 100, step: 1, width: 42, title: 'Swing % (applied to off-beat 16ths)', onChange: (v, { final }) => { if (final && Math.abs(store.get().swing * 100 - v) < 1e-9) return; store.transact('Swing', (p) => { p.swing = v / 100; }, { coalesce: true }); } });

  const rootOpts = Array.from({ length: 12 }, (_, i) => ({ value: i, label: pitchClassName(i) }));
  const keyRoot = select({ options: rootOpts, value: p0.key.root, title: 'Key root', onChange: (v) => store.transact('Key', (p) => { p.key.root = Number(v); }) });
  const scaleOpts = Object.entries(SCALES).map(([id, s]) => ({ value: id, label: s.name }));
  const keyScale = select({ options: scaleOpts, value: p0.key.scale, title: 'Scale — used by the piano roll, generators and assistant', onChange: (v) => store.transact('Scale', (p) => { p.key.scale = v; }) });
  const genreOpts = [{ value: '', label: '— Any genre —' }, ...Object.entries(GENRES).map(([id, g]) => ({ value: id, label: g.name, group: g.family || 'Other' }))];
  const genre = select({ options: genreOpts, value: p0.genre || '', title: 'Genre — guides generators and recommendations', onChange: (v) => actions.setGenre(v || null) });

  const modeSwitch = h('div.mode-switch', { title: 'Pattern mode loops the active pattern of each track. Song mode plays the arrangement.' });
  const patBtn = h('button', { type: 'button' }, 'PATTERN');
  const songBtn = h('button', { type: 'button' }, 'SONG');
  patBtn.addEventListener('click', () => actions.setMode('pattern'));
  songBtn.addEventListener('click', () => actions.setMode('song'));
  modeSwitch.append(patBtn, songBtn);

  const genBtn = h('button.btn.primary', { title: 'Generate a full song, parts or ideas' }, icon('wand', 15), h('span', 'Create'));
  genBtn.addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, actions.generateMenuItems());
  });

  const undoBtn = h('button.icon-btn', { title: 'Undo (Ctrl+Z)' }, icon('undo'));
  const redoBtn = h('button.icon-btn', { title: 'Redo (Ctrl+Shift+Z)' }, icon('redo'));
  undoBtn.addEventListener('click', () => actions.undo());
  redoBtn.addEventListener('click', () => actions.redo());

  const masterMeter = meter({ height: 30 });
  masterMeter.style.height = '30px';
  const masterVol = knob({ def: { key: 'mv', label: 'Master', min: 0, max: 1.5, default: 0.9, step: 0.01 }, value: p0.master.volume, size: 26, showValue: false, label: false, onChange: (v, { final }) => { if (final && store.get().master.volume === v) return; store.transact('Master volume', (p) => { p.master.volume = v; }, { coalesce: true }); } });
  masterVol.title = 'Master volume';

  const panelBtn = (ic, key, title) => {
    const b = h('button.icon-btn', { title }, icon(ic));
    b.addEventListener('click', () => ui.set({ [key]: !ui.get(key) }));
    b.sync = () => b.classList.toggle('on', !!ui.get(key));
    return b;
  };
  const browserBtn = panelBtn('folder', 'browserOpen', 'Toggle browser (B)');
  const deviceBtn = panelBtn('sliders', 'deviceOpen', 'Toggle device panel (D)');
  const assistBtn = panelBtn('bulb', 'assistantOpen', 'Toggle assistant (A)');

  const el = h('header.app-header',
    h('div.hgroup', menuBtn, logo),
    h('div.hgroup', undoBtn, redoBtn),
    h('div.hgroup', playBtn, stopBtn, recBtn, loopBtn, metroBtn, lcd),
    h('div.hgroup', h('div.hfield', h('span.hlabel', 'BPM'), bpm), tap, h('div.hfield', h('span.hlabel', 'Sig'), sig), h('div.hfield', h('span.hlabel', 'Swing'), swing)),
    h('div.hgroup', h('div.hfield', h('span.hlabel', 'Key'), keyRoot), h('div.hfield', h('span.hlabel', 'Scale'), keyScale), h('div.hfield', h('span.hlabel', 'Genre'), genre)),
    h('div.hgroup', modeSwitch),
    h('div.hgroup', genBtn),
    h('div.spacer'),
    h('div.hgroup', masterVol, masterMeter),
    h('div.hgroup', browserBtn, deviceBtn, assistBtn),
  );

  function sync() {
    const p = store.get();
    bpm.setValue(p.bpm);
    sig.setValue(p.timeSig.join('/'));
    swing.setValue(Math.round(p.swing * 100));
    keyRoot.setValue(p.key.root);
    keyScale.setValue(p.key.scale);
    genre.setValue(p.genre || '');
    loopBtn.classList.toggle('on', !!p.loop.enabled);
    metroBtn.classList.toggle('on', !!p.metronome);
    patBtn.classList.toggle('on', p.mode !== 'song');
    songBtn.classList.toggle('on', p.mode === 'song');
    masterVol.setValue(p.master.volume);
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    undoBtn.style.opacity = store.canUndo() ? 1 : 0.35;
    redoBtn.style.opacity = store.canRedo() ? 1 : 0.35;
    recBtn.classList.toggle('on', !!ui.get('recording'));
    browserBtn.sync(); deviceBtn.sync(); assistBtn.sync();
  }
  app.subscribe(sync);
  sync();

  // live LCD + meter loop
  function frame() {
    const p = store.get();
    const pos = engine.getPosition ? engine.getPosition() : 0;
    if (lcdTime) {
      const sec = (pos * 60) / p.bpm;
      lcd.textContent = `${Math.floor(sec / 60)}:${(sec % 60).toFixed(2).padStart(5, '0')}`;
    } else {
      const bpb = beatsPerBar(p);
      const bar = Math.floor(pos / bpb) + 1;
      const beat = Math.floor(pos % bpb) + 1;
      const step = Math.floor((pos % 1) * 4) + 1;
      lcd.textContent = `${bar}.${beat}.${step}`;
    }
    playBtn.classList.toggle('on', !!engine.isPlaying);
    playBtn.replaceChildren(icon(engine.isPlaying ? 'pause' : 'play', 16));
    if (engine.getMeter && engine.ctx) {
      const m = engine.getMeter('master') || { l: 0, r: 0 };
      masterMeter.setLevels(m.l, m.r);
    }
    requestAnimationFrame(frame);
  }
  // play button icon swap without rebuilding every frame
  let lastPlaying = null;
  const origReplace = playBtn.replaceChildren.bind(playBtn);
  playBtn.replaceChildren = (...n) => { if (lastPlaying !== engine.isPlaying) { lastPlaying = engine.isPlaying; origReplace(...n); } };
  requestAnimationFrame(frame);

  return { el, sync };
}
