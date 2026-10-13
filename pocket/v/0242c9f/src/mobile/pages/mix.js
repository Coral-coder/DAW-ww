// Pocket ▸ Mix: big vertical faders per track (drag anywhere on the fader; sideways distance = fine), mute / solo,
// pan (tap for the popup), live meters, and the master.
import { h } from '../../ui/dom.js';
import { pageShell, emptyState } from './common.js';
import { vFader, ctlTile, mixTarget } from '../controls.js';
import { haptic, bigButton, onLongPress, actionSheet } from '../touch.js';

export function createMixPage(app, nav) {
  const { store, engine, actions } = app;
  const { el, body } = pageShell('Mix');
  const strips = h('div.pk-strips', { 'data-noswipe': '' });
  body.classList.add('pk-mix-body');
  body.append(strips, h('p.pk-hint', 'Drag a fader up or down · slide sideways while dragging for fine moves · tap for exact values'));
  let visible = false, key = '', raf = 0;
  const meters = []; // {id, l, r}
  const updaters = [];

  function strip(id, name, color, { master = false, bus = false } = {}) {
    const vol = vFader(app, { ...mixTarget(app, id, 'volume'), label: `${name} volume` }, { color });
    const l = h('div.pk-meter-bar'), r = h('div.pk-meter-bar');
    meters.push({ id: master ? 'master' : id, l, r });
    const nameEl = h('button.pk-strip-name', { type: 'button' }, name);
    const parts = [nameEl, h('div.pk-strip-mid', vol, h('div.pk-meter', l, r))];
    updaters.push(vol.update);
    if (!master) {
      const pan = ctlTile(app, mixTarget(app, id, 'pan'), { cls: 'mini' });
      updaters.push(pan.update);
      parts.splice(1, 0, pan);
      const ms = h('div.pk-strip-ms');
      const mute = h('button.pk-ms', { type: 'button' }, 'M');
      mute.addEventListener('click', () => { haptic(6); store.transact('Mute', (p) => { const o = p.tracks.find((t) => t.id === id) || p.buses.find((b) => b.id === id); if (o) o.mute = !o.mute; }); });
      ms.append(mute);
      if (!bus) {
        const solo = h('button.pk-ms.solo', { type: 'button' }, 'S');
        solo.addEventListener('click', () => { haptic(6); actions.updateTrack(id, (t) => { t.solo = !t.solo; }, 'Solo'); });
        ms.append(solo);
        updaters.push(() => { const t = store.get().tracks.find((x) => x.id === id); solo.classList.toggle('on', !!t?.solo); });
      }
      updaters.push(() => { const p = store.get(); const o = p.tracks.find((x) => x.id === id) || p.buses.find((b) => b.id === id); mute.classList.toggle('on', !!o?.mute); });
      parts.push(ms);
      if (!bus) {
        nameEl.addEventListener('click', () => { actions.selectTrack(id); nav.go({ page: 'track', id }); });
        onLongPress(nameEl, () => actionSheet(name, actions.trackMenuItems(id).filter((it) => it === '-' || it.header || !/Export track/.test(it.label || ''))));
      }
    }
    return h(`div.pk-strip${master ? '.master' : ''}${bus ? '.bus' : ''}`, { style: { '--tc': color } }, ...parts);
  }

  function render() {
    const p = store.get();
    const k = [...p.tracks.map((t) => `${t.id}:${t.name}:${t.color}`), ...p.buses.map((b) => `${b.id}:${b.name}`)].join(',');
    if (k !== key) {
      key = k;
      meters.length = 0;
      updaters.length = 0;
      strips.replaceChildren(
        ...p.tracks.map((t) => strip(t.id, t.name, t.color)),
        ...p.buses.map((b) => strip(b.id, b.name, '#3bc9db', { bus: true })),
        strip('master', 'Master', '#ffa94d', { master: true }));
      if (!p.tracks.length) strips.prepend(emptyState('Nothing to mix yet', 'Add or generate some tracks first.', bigButton('Create', () => nav.go({ page: 'home' }), { ic: 'sparkles', cls: 'primary' })));
    }
    for (const u of updaters) u();
  }
  const frame = () => {
    if (!visible) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    for (const m of meters) {
      const v = engine.getMeter(m.id);
      const pct = (x) => `${Math.max(0, Math.min(100, (1 + Math.log10(Math.max(1e-4, x)) / 2.4) * 100))}%`; // ~ -48 dB .. 0 dB
      m.l.style.height = pct(v.l || 0);
      m.r.style.height = pct(v.r || 0);
    }
  };
  app.subscribe(() => { if (visible) render(); });
  return { el, show() { visible = true; render(); if (!raf) raf = requestAnimationFrame(frame); }, hide() { visible = false; } };
}
