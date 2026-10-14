// Pocket ▸ Setlist: the endless DJ set on a phone — Start, now-playing, Build / Drop / Breakdown, an energy fader,
// key moves, and every layer as a card (AUTO / ON / OFF, mute, lock, new idea, sound, volume). Drives app.setlist
// (src/live/setlist-runner.js) exactly like the desktop Setlist view.
import { h, icon } from '../../ui/dom.js';
import { GENRES } from '../../gen/genres.js';
import { SCALES, pitchClassName } from '../../theory/index.js';
import { SetlistRunner } from '../../live/setlist-runner.js';
import { SECTIONS, keyMoveOptions, keyName, camelot } from '../../live/setlist-engine.js';
import { pageShell, soundName, soundBrowser, iconBtn } from './common.js';
import { ctlTile, mixTarget, valueTarget } from '../controls.js';
import { actionSheet, bigButton, chips, haptic, confirmSheet } from '../touch.js';
import { POCKET_SCALES } from './home.js';

const SECTION_BTNS = ['intro', 'groove', 'build', 'drop', 'breakdown'];
const MODE_NEXT = { auto: 'on', on: 'off', off: 'auto' };

export const runnerOf = (app) => app.setlist || (app.setlist = new SetlistRunner(app));

export async function startSet(app, { genre, key, phraseBars = 8, energy = 0.7 } = {}) {
  const runner = runnerOf(app);
  const g = genre && GENRES[genre] ? genre : 'tech-house';
  await runner.start({ genre: g, key: key || { root: 9, scale: 'minor' }, bpm: GENRES[g]?.defaultBpm, phraseBars, energy });
}

export function createSetlistPage(app, nav) {
  const { store, engine, actions } = app;
  const runner = runnerOf(app);
  const get = () => store.get();
  const p0 = get();
  const opts = { genre: p0.genre && GENRES[p0.genre] ? p0.genre : 'tech-house', root: p0.key?.root ?? 9, scale: p0.key?.scale || 'minor', bars: 8 };
  const playBtn = iconBtn('play', () => (runner.running && engine.isPlaying ? runner.stop() : runner.resume()), 'Stop / resume', 'labeled');
  const { el, body } = pageShell('Setlist', playBtn);
  let visible = false, raf = 0, layerKey = '';
  let energy = 0.7;
  let showIdle = false;

  // ---------------------------------------------------------------- idle: start a set
  const genreBtn = h('button.pk-select', { type: 'button' });
  genreBtn.addEventListener('click', () => {
    const fams = {};
    for (const [id, g] of Object.entries(GENRES)) (fams[g.family || 'other'] ||= []).push({ label: g.name, checked: id === opts.genre, onClick: () => { opts.genre = id; syncIdle(); } });
    actionSheet('Genre', Object.entries(fams).map(([f, items]) => ({ label: f[0].toUpperCase() + f.slice(1), submenu: items })));
  });
  const rootChips = chips(Array.from({ length: 12 }, (_, i) => ({ value: i, label: pitchClassName(i) })), opts.root, (v) => { opts.root = v; }, { cls: 'keys' });
  const scaleChips = chips(POCKET_SCALES.filter((s) => SCALES[s]).slice(0, 5).map((s) => ({ value: s, label: SCALES[s].name })), opts.scale, (v) => { opts.scale = v; }, { cls: 'scroll' });
  const barsChips = chips([4, 8, 16].map((b) => ({ value: b, label: `${b} bars` })), 8, (v) => { opts.bars = v; runner.setPhraseBars(v); });
  const startBtn = bigButton('Start the set', () => onStart(), { ic: 'play', cls: 'primary huge' });
  const idle = h('div.pk-card', h('p.pk-p', 'An endless, evolving DJ set: every layer loops while the next phrase is generated as a variation; the energy arc brings layers in and out.'),
    h('div.pk-label', 'Genre'), genreBtn, h('div.pk-label', 'Key'), rootChips, scaleChips, h('div.pk-label', 'Phrase'), barsChips, startBtn);

  async function onStart() {
    const p = get();
    const isSet = runner.active && p.tracks.some((t) => runner.layer(t.id));
    if (!isSet && p.tracks.length && (p.clips.length || Object.keys(p.patterns).length) && !(await confirmSheet('Start a new set?', 'This replaces the current song (it stays in Recent on the Create page).', 'Start'))) return;
    if (isSet && runner.phrases.length > 2 && !(await confirmSheet('Start a new set?', 'The current set is replaced. Capture it first to keep it as a song.', 'New set'))) return;
    startBtn.disabled = true;
    showIdle = false;
    try { await startSet(app, { genre: opts.genre, key: { root: opts.root, scale: opts.scale }, phraseBars: opts.bars, energy }); } finally { startBtn.disabled = false; }
    haptic(20);
    renderAll();
  }

  // ---------------------------------------------------------------- live
  const secName = h('div.pk-sl-sec');
  const keyEl = h('div.pk-sl-key');
  const nextEl = h('div.pk-sl-next');
  const progFill = h('div.pk-sl-fill');
  const now = h('div.pk-card.pk-sl-now', h('div.pk-row.between', secName, keyEl), h('div.pk-sl-prog', progFill), nextEl);
  const secBtns = SECTION_BTNS.map((id) => {
    const b = h(`button.pk-secbtn.s-${id}`, { type: 'button' }, SECTIONS[id].label);
    b.addEventListener('click', () => { haptic(10); runner.queueSection(runner.state?.queued === id ? null : id); });
    return b;
  });
  const energyTile = ctlTile(app, valueTarget({ key: 'energy', label: 'Energy', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, unit: '%' }, () => energy, (v) => { energy = v; runner.setEnergy(v); }));
  const freshTile = ctlTile(app, valueTarget({ key: 'freshness', label: 'Freshness', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, unit: '%' }, () => runner.state?.freshness ?? 0.5, (v) => runner.setFreshness(v)));
  const keyBtns = h('div.pk-grid3');
  const keyQ = h('div.pk-sl-keyq');
  const layersEl = h('div.pk-layers');
  const captureBtn = bigButton('Capture to song', () => {
    const r = runner.capture();
    if (r) { app.toast(`Captured ${Math.round(r.bars)} bars in ${r.sections} sections — it's a normal song now.`, { level: 'success' }); nav.go({ page: 'tracks' }); }
    renderAll();
  }, { ic: 'timeline' });
  const newBtn = bigButton('New set', () => { showIdle = true; renderAll(); }, { ic: 'plus' });
  const live = h('div.pk-sl-live', now, h('div.pk-card', h('div.pk-label', 'Next section'), h('div.pk-secs', ...secBtns), h('div.pk-tiles', energyTile, freshTile)),
    h('div.pk-card', h('div.pk-label', 'Key moves (at the next phrase)'), keyBtns, keyQ),
    h('div.pk-label.pk-pad', 'Layers'), layersEl, h('div.pk-row', captureBtn, newBtn));
  body.append(idle, live);

  function layerCard(l) {
    const t0 = get().tracks.find((t) => t.id === l.id);
    const name = h('div.pk-layer-name', l.name);
    const sound = h('button.pk-layer-sound', { type: 'button' });
    sound.addEventListener('click', () => soundBrowser(app, l.id));
    const modeBtn = h('button.pk-layer-mode', { type: 'button' });
    modeBtn.addEventListener('click', () => { haptic(6); runner.setLayer(l.id, { mode: MODE_NEXT[runner.layer(l.id)?.mode || 'auto'] }); });
    const mute = h('button.pk-ms', { type: 'button' }, 'M');
    mute.addEventListener('click', () => { haptic(6); actions.updateTrack(l.id, (t) => { t.mute = !t.mute; }, 'Mute'); });
    const lock = h('button.pk-layer-btn', { type: 'button' }, '🔒');
    lock.addEventListener('click', () => { haptic(6); runner.setLayer(l.id, { lock: !runner.layer(l.id)?.lock }); });
    const regen = h('button.pk-layer-btn', { type: 'button', 'aria-label': 'New idea' }, icon('dice', 18));
    regen.addEventListener('click', () => { haptic(10); runner.regenerate(l.id); regen.classList.add('on'); });
    const editBtn = h('button.pk-layer-btn', { type: 'button', 'aria-label': 'Edit notes' }, icon('piano', 18));
    editBtn.addEventListener('click', () => {
      const ph = runner.phraseAt(engine.getPosition());
      const pid = ph?.patterns[l.id];
      actions.selectTrack(l.id);
      if (pid) app.ui.set({ selectedPatternId: pid });
      nav.go({ page: 'notes' });
    });
    const volTarget = { ...mixTarget(app, l.id, 'volume'), color: t0?.color, lock: { label: 'Lock loop', get: () => !!runner.layer(l.id)?.lock, set: (on) => runner.setLayer(l.id, { lock: on }) } };
    const vol = ctlTile(app, volTarget, { cls: 'slim' });
    const mut = ctlTile(app, valueTarget({ key: 'mutate', label: 'Mutate', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, unit: '%' }, () => runner.layer(l.id)?.mutate ?? 0.35, (v) => runner.setLayer(l.id, { mutate: v }), { lock: volTarget.lock }), { cls: 'slim' });
    const el2 = h('div.pk-layer', { style: { '--tc': t0?.color || '#7aa2ff' } }, h('div.pk-layer-top', name, modeBtn, mute, lock, regen, editBtn), sound, h('div.pk-tiles', vol, mut));
    const sync = () => {
      const L = runner.layer(l.id);
      const t = get().tracks.find((x) => x.id === l.id);
      if (!L || !t) return;
      modeBtn.textContent = (L.mode || 'auto').toUpperCase();
      modeBtn.dataset.mode = L.mode || 'auto';
      mute.classList.toggle('on', !!t.mute);
      lock.classList.toggle('on', !!L.lock);
      if (!L.regen) regen.classList.remove('on');
      sound.replaceChildren(h('span', soundName(t)), icon('chevronRight', 16));
      vol.update(); mut.update();
    };
    const frame = (pos) => {
      const ph = runner.phraseAt(pos);
      el2.classList.toggle('playing', !!ph?.active?.has?.(l.id));
    };
    return { el: el2, sync, frame };
  }
  const cards = new Map();

  function renderAll() {
    const st = runner.state;
    const active = !!st && get().tracks.some((t) => runner.layer(t.id));
    idle.hidden = active && !showIdle;
    live.hidden = !active || showIdle;
    playBtn.hidden = !active;
    if (!active || showIdle) { syncIdle(); if (!active) return; }
    const playing = runner.running && engine.isPlaying;
    playBtn.replaceChildren(icon(playing ? 'stop' : 'play', 20), h('span', playing ? 'Stop' : 'Resume'));
    for (const b of secBtns) b.classList.toggle('queued', st.queued === b.className.match(/s-(\w+)/)[1]);
    const kOpts = keyMoveOptions(st.pendingKey || st.key);
    keyBtns.replaceChildren(...kOpts.map((o) => {
      const b = h('button.pk-keymove', { type: 'button', title: o.hint }, h('b', o.label), h('span', keyName(o.target)), h('small', camelot(o.target).code));
      b.addEventListener('click', () => { haptic(8); runner.keyMove(o.id); });
      return b;
    }));
    keyQ.replaceChildren(st.pendingKey ? h('button.pk-chip.on', { type: 'button', onclick: () => runner.cancelKeyMove() }, `Next: ${keyName(st.key)} → ${keyName(st.pendingKey)}  ✕`) : h('span.muted', `In ${keyName(st.key)} (${camelot(st.key).code})`));
    energy = st.energy ?? energy;
    energyTile.update(); freshTile.update();
    const layers = st.layers.filter((l) => get().tracks.some((t) => t.id === l.id));
    const k = layers.map((l) => l.id).join(',');
    if (k !== layerKey) {
      layerKey = k;
      cards.clear();
      layersEl.replaceChildren(...layers.map((l) => { const c = layerCard(l); cards.set(l.id, c); return c.el; }));
    }
    for (const c of cards.values()) c.sync();
  }
  function syncIdle() {
    genreBtn.replaceChildren(h('span', GENRES[opts.genre]?.name || opts.genre), icon('chevronDown', 16));
  }
  const frame = () => {
    if (!visible) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    const st = runner.state;
    if (!st) return;
    const pos = engine.getPosition();
    const ph = runner.phraseAt(pos);
    if (ph) {
      progFill.style.width = `${Math.min(100, Math.max(0, ((pos - ph.start) / ph.length) * 100))}%`;
      secName.textContent = SECTIONS[ph.section]?.label || ph.section;
      secName.dataset.sec = ph.section;
      keyEl.textContent = `${keyName(ph.key)} · ${camelot(ph.key).code}`;
      const bars = Math.max(0, Math.ceil((ph.start + ph.length - pos) / st.bpb));
      nextEl.textContent = `Phrase ${ph.index + 1} · ${bars} bar${bars === 1 ? '' : 's'} to go${st.queued ? ` · next: ${SECTIONS[st.queued]?.label}` : ''}`;
    }
    for (const c of cards.values()) c.frame(pos);
    const playing = runner.running && engine.isPlaying;
    if (playing !== playBtn._playing) { playBtn._playing = playing; renderAll(); }
  };
  runner.on('phrase', () => { if (visible) renderAll(); });
  runner.on('change', () => { if (visible) renderAll(); });
  app.subscribe((r) => { if (visible && r.project) renderAll(); });
  return { el, show() { visible = true; renderAll(); if (!raf) raf = requestAnimationFrame(frame); }, hide() { visible = false; } };
}
