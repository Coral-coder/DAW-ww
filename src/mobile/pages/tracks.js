// Pocket ▸ Tracks: one big card per track (sound, mute / solo, volume); tap = track page, long-press = actions.
import { h, icon } from '../../ui/dom.js';
import { pageShell, soundName, iconBtn, addTrackSheet, emptyState } from './common.js';
import { ctlTile, mixTarget } from '../controls.js';
import { actionSheet, onLongPress, haptic, bigButton } from '../touch.js';
import { dragReorder, reorder } from '../reorder.js';

export function createTracksPage(app, nav) {
  const { store, ui, actions } = app;
  const { el, body } = pageShell('Tracks', iconBtn('plus', () => addTrackSheet(app, (t) => nav.go({ page: 'track', id: t.id })), 'Add track', 'labeled'));
  const list = h('div.pk-tracks');
  body.append(list);
  dragReorder(list, { onMove: (from, to) => store.transact('Reorder tracks', (p) => { p.tracks = reorder(p.tracks, from, to); }) });
  let visible = false, key = '';
  const cards = new Map();

  function card(t) {
    const nameEl = h('div.pk-tc-name');
    const subEl = h('div.pk-tc-sub');
    const mute = h('button.pk-ms', { type: 'button', 'aria-label': 'Mute' }, 'M');
    const solo = h('button.pk-ms.solo', { type: 'button', 'aria-label': 'Solo' }, 'S');
    mute.addEventListener('click', (e) => { e.stopPropagation(); haptic(6); actions.updateTrack(t.id, (tt) => { tt.mute = !tt.mute; }, 'Mute'); });
    solo.addEventListener('click', (e) => { e.stopPropagation(); haptic(6); actions.updateTrack(t.id, (tt) => { tt.solo = !tt.solo; }, 'Solo'); });
    const vol = ctlTile(app, { ...mixTarget(app, t.id, 'volume'), color: t.color }, { cls: 'slim' });
    const open = h('button.pk-tc-open', { type: 'button', 'aria-label': 'Open track' }, h('span.pk-tc-dot'), h('div.pk-tc-text', nameEl, subEl), icon('chevronRight', 20));
    open.addEventListener('click', () => { haptic(5); actions.selectTrack(t.id); nav.go({ page: 'track', id: t.id }); });
    onLongPress(open, () => trackActions(t.id));
    const grip = h('span.pk-grip', { 'aria-label': 'Drag to reorder', 'data-noswipe': '' }, '≡');
    const el2 = h('div.pk-tc', { style: { '--tc': t.color } }, h('div.pk-tc-top', grip, open, mute, solo), vol);
    const sync = () => {
      const tt = store.get().tracks.find((x) => x.id === t.id);
      if (!tt) return;
      nameEl.textContent = tt.name;
      subEl.textContent = [soundName(tt), tt.role].filter(Boolean).join(' · ');
      mute.classList.toggle('on', !!tt.mute);
      solo.classList.toggle('on', !!tt.solo);
      el2.classList.toggle('sel', ui.get('selectedTrackId') === tt.id);
      el2.style.setProperty('--tc', tt.color);
      vol.update();
    };
    return { el: el2, sync };
  }

  function trackActions(id) {
    const t = store.get().tracks.find((x) => x.id === id);
    if (!t) return;
    const items = actions.trackMenuItems(id).filter((it) => it === '-' || it.header || !/Export track/.test(it.label || ''));
    actionSheet(t.name, [
      { label: 'Edit notes', icon: 'piano', onClick: () => { actions.selectTrack(id); nav.go({ page: 'notes' }); } },
      { label: 'Play it (keys)', icon: 'music', onClick: () => { actions.selectTrack(id); nav.go({ page: 'play' }); } },
      { label: 'Show in the song', icon: 'scenes', onClick: () => { actions.selectTrack(id); nav.go({ page: 'arrange' }); } },
      ...items,
    ]);
  }

  function render() {
    const p = store.get();
    const k = p.tracks.map((t) => t.id).join(',');
    if (k !== key) {
      key = k;
      cards.clear();
      list.replaceChildren(...p.tracks.map((t) => { const c = card(t); cards.set(t.id, c); return c.el; }));
      if (!p.tracks.length) list.appendChild(emptyState('No tracks yet', 'Generate a song on the Create page, or add a track and start making noise.', bigButton('Add a track', () => addTrackSheet(app, (t) => nav.go({ page: 'track', id: t.id })), { ic: 'plus', cls: 'primary' }), bigButton('Generate a song', () => nav.go({ page: 'home' }), { ic: 'wand' })));
    }
    for (const c of cards.values()) c.sync();
  }
  app.subscribe(() => { if (visible) render(); });
  return { el, show() { visible = true; render(); }, hide() { visible = false; } };
}
