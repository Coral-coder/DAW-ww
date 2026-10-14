// Pocket ▸ Mix: big vertical faders per track (drag anywhere on the fader; sideways distance = fine), mute / solo,
// pan (tap for the popup), live meters and the master — in track order (drag a strip's ≡ grip sideways to reorder the
// tracks). The desktop's pro mixer, phone-sized: folders (tap the folder tab to collapse / expand), group link badges
// (faders / mutes / solos of linked channels move together), VCA faders, frozen ❄ marks and a compact LUFS readout.
import { h, icon } from '../../ui/dom.js';
import { pageShell, emptyState } from './common.js';
import { vFader, ctlTile, mixTarget, valueTarget } from '../controls.js';
import { haptic, bigButton, onLongPress, actionSheet, openSheet, confirmSheet } from '../touch.js';
import { dragReorder } from '../reorder.js';
import { mixStrips, visibleStripIds, reorderVisible, folderAfterMove, lufsReadout, VCA_MAX } from '../mix-core.js';
import { applyLinkedEdit, toggleSolo, ensureMixer, setTrackFolder, removeFolder, removeVca, mixerOf } from '../../core/mixer-model.js';
import { isFrozen } from '../../core/freeze.js';

const VCA_DEF = { key: 'vca', label: 'VCA', type: 'number', min: 0, max: VCA_MAX, step: 0.01, default: 1, format: (v) => (v <= 0.0001 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`) };
const initials = (s) => String(s || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function createMixPage(app, nav) {
  const { store, engine, actions } = app;
  const lufsBtn = h('button.pk-lufs', { type: 'button', title: 'Loudness of the master (LUFS) — tap for details' },
    h('span.pk-lufs-k', 'S'), h('span.pk-lufs-s', '−∞'), h('span.pk-lufs-k', 'I'), h('span.pk-lufs-i', '−∞'), h('span.pk-lufs-u', 'LUFS'));
  lufsBtn.addEventListener('click', () => { haptic(5); loudnessSheet(); });
  const { el, body } = pageShell('Mix', lufsBtn);
  const strips = h('div.pk-strips', { 'data-noswipe': '' });
  body.classList.add('pk-mix-body');
  body.append(strips, h('p.pk-hint', 'Drag a fader · slide sideways while dragging for fine moves · tap for exact values · drag ≡ to reorder'));
  let visible = false, key = '', raf = 0, lastLufs = 0;
  const meters = []; // {id, l, r}
  const updaters = [];
  const get = () => store.get();
  const channel = (p, id) => p.tracks.find((t) => t.id === id) || p.buses.find((b) => b.id === id);

  dragReorder(strips, {
    axis: 'x', grip: '.pk-grip', rows: () => [...strips.querySelectorAll('.pk-strip.trk')],
    onMove: (from, to) => {
      const p = get();
      const ids = visibleStripIds(p);
      const id = ids[from];
      store.transact('Reorder tracks', (pp) => {
        pp.tracks = reorderVisible(pp.tracks, ids, from, to);
        const f = folderAfterMove(pp, id);
        const t = pp.tracks.find((x) => x.id === id);
        if ((t?.folderId || null) !== f) setTrackFolder(pp, id, f);
      });
    },
  });

  /** Volume / pan / mute targets that follow the channel's groups (like the desktop mixer). */
  const linked = (id, what) => {
    const base = mixTarget(app, id, what);
    if (!get().tracks.some((t) => t.id === id)) return base;
    return { ...base, set: (v) => store.transact(base.def.label, (p) => { if (applyLinkedEdit(p, id, what, v).length === 0) { const o = channel(p, id); if (o) o[what] = v; } }, { coalesce: true }) };
  };

  function strip(id, name, color, { master = false, bus = false, badges = [], depth = 0, frozen = false } = {}) {
    const vol = vFader(app, { ...(master ? mixTarget(app, id, 'volume') : linked(id, 'volume')), label: `${name} volume` }, { color });
    const l = h('div.pk-meter-bar'), r = h('div.pk-meter-bar');
    meters.push({ id: master ? 'master' : id, l, r });
    const nameEl = h('button.pk-strip-name', { type: 'button' }, frozen ? h('span.pk-frozen', { title: 'Frozen' }, '❄ ') : null, name);
    const parts = [nameEl, h('div.pk-strip-mid', vol, h('div.pk-meter', l, r))];
    updaters.push(vol.update);
    if (!master) {
      const pan = ctlTile(app, linked(id, 'pan'), { cls: 'mini' });
      updaters.push(pan.update);
      parts.splice(1, 0, pan);
      const ms = h('div.pk-strip-ms');
      const mute = h('button.pk-ms', { type: 'button' }, 'M');
      mute.addEventListener('click', () => { haptic(6); store.transact('Mute', (p) => { const o = channel(p, id); if (o) applyLinkedEdit(p, id, 'mute', !o.mute); }); });
      ms.append(mute);
      if (!bus) {
        const solo = h('button.pk-ms.solo', { type: 'button' }, 'S');
        solo.addEventListener('click', () => { haptic(6); store.transact('Solo', (p) => toggleSolo(p, id)); });
        ms.append(solo);
        updaters.push(() => { const t = get().tracks.find((x) => x.id === id); solo.classList.toggle('on', !!t?.solo); });
      }
      updaters.push(() => { const o = channel(get(), id); mute.classList.toggle('on', !!o?.mute); });
      parts.push(ms);
      if (!bus) {
        nameEl.addEventListener('click', () => { actions.selectTrack(id); nav.go({ page: 'track', id }); });
        onLongPress(nameEl, () => actionSheet(name, actions.trackMenuItems(id).filter((it) => it === '-' || it.header || !/Export track/.test(it.label || ''))));
      }
    }
    const top = [];
    if (!master && !bus) top.push(h('span.pk-grip.pk-strip-grip', { 'aria-label': 'Drag sideways to reorder', title: 'Drag sideways to reorder' }, '≡'));
    if (badges.length) {
      top.push(h('div.pk-badges', ...badges.map((b) => h(`span.pk-badge.${b.kind}${b.enabled ? '' : '.off'}`, { style: b.color ? { '--bc': b.color } : {}, title: b.kind === 'vca' ? `VCA ${b.name}` : `Group ${b.name}: ${b.links.join(', ')} linked` }, b.kind === 'vca' ? 'V' : initials(b.name)))));
    }
    if (top.length) parts.unshift(h('div.pk-strip-top', ...top));
    return h(`div.pk-strip${master ? '.master' : bus ? '.bus' : '.trk'}${depth ? '.infolder' : ''}`, { style: { '--tc': color } }, ...parts);
  }

  function folderStrip(row) {
    const f = row.folder;
    const b = h(`button.pk-strip.pk-folder${row.collapsed ? '.collapsed' : ''}`, { type: 'button', style: { '--tc': f.color || 'var(--text-3)' }, title: row.collapsed ? 'Tap to expand the folder' : 'Tap to collapse the folder' },
      icon(row.collapsed ? 'chevronRight' : 'chevronDown', 18), icon('folder', 18), h('span.pk-folder-name', f.name), h('span.pk-folder-n', `${row.members.length}`));
    b.addEventListener('click', () => { haptic(6); store.transact(row.collapsed ? 'Expand folder' : 'Collapse folder', (p) => { const ff = ensureMixer(p).folders.find((x) => x.id === f.id); if (ff) ff.collapsed = !ff.collapsed; }); });
    onLongPress(b, () => actionSheet(`Folder ${f.name}`, [
      { label: row.collapsed ? 'Expand' : 'Collapse', icon: 'folder', onClick: () => store.transact('Folder', (p) => { const ff = ensureMixer(p).folders.find((x) => x.id === f.id); if (ff) ff.collapsed = !ff.collapsed; }) },
      { header: `Members: ${row.members.map((t) => t.name).join(', ') || '—'}` },
      { label: 'Remove folder (keep the tracks)', icon: 'trash', onClick: async () => { if (await confirmSheet('Remove folder?', `The tracks of “${f.name}” stay; only the folder goes.`, 'Remove')) store.transact('Remove folder', (p) => removeFolder(p, f.id)); } },
    ]));
    return b;
  }

  function vcaStrip(row) {
    const v = row.vca;
    const target = valueTarget({ ...VCA_DEF, label: `VCA ${v.name}` }, () => mixerOf(get()).vcas.find((x) => x.id === v.id)?.volume ?? 1,
      (val) => store.transact('VCA', (p) => { const x = ensureMixer(p).vcas.find((y) => y.id === v.id); if (x) x.volume = val; }, { coalesce: true }));
    const fader = vFader(app, target, { color: v.color || '#e599f7' });
    updaters.push(fader.update);
    const mute = h('button.pk-ms', { type: 'button' }, 'M');
    mute.addEventListener('click', () => { haptic(6); store.transact('VCA mute', (p) => { const x = ensureMixer(p).vcas.find((y) => y.id === v.id); if (x) x.mute = !x.mute; }); });
    updaters.push(() => mute.classList.toggle('on', !!mixerOf(get()).vcas.find((x) => x.id === v.id)?.mute));
    const nameEl = h('button.pk-strip-name', { type: 'button' }, `VCA ${v.name}`);
    const names = row.members.map((id) => channel(get(), id)?.name).filter(Boolean);
    const info = () => actionSheet(`VCA ${v.name}`, [
      { header: `Controls: ${names.join(', ') || 'nothing yet'}` },
      { label: 'Reset to 0 dB', icon: 'refresh', onClick: () => store.transact('VCA', (p) => { const x = ensureMixer(p).vcas.find((y) => y.id === v.id); if (x) x.volume = 1; }) },
      { label: 'Delete VCA', icon: 'trash', onClick: () => store.transact('Delete VCA', (p) => removeVca(p, v.id)) },
    ]);
    nameEl.addEventListener('click', info);
    return h('div.pk-strip.vca', { style: { '--tc': v.color || '#e599f7' } }, nameEl, h('div.pk-vca-members', `${names.length} ch`), h('div.pk-strip-mid', fader), h('div.pk-strip-ms', mute));
  }

  function render() {
    const p = get();
    const m = mixerOf(p);
    const k = JSON.stringify([p.tracks.map((t) => [t.id, t.name, t.color, t.folderId || '', isFrozen(t)]), p.buses.map((b) => [b.id, b.name]),
      m.folders.map((f) => [f.id, f.name, !!f.collapsed]), m.groups.map((g) => [g.id, g.name, g.enabled, g.members]), m.vcas.map((v) => [v.id, v.name, v.members])]);
    if (k !== key) {
      key = k;
      meters.length = 0;
      updaters.length = 0;
      const { rows, vcas } = mixStrips(p);
      const sl = strips.scrollLeft;
      strips.replaceChildren(
        ...rows.map((r) => (r.kind === 'folder' ? folderStrip(r) : strip(r.track.id, r.track.name, r.track.color, { badges: r.badges, depth: r.depth, frozen: isFrozen(r.track) }))),
        ...p.buses.map((b) => strip(b.id, b.name, '#3bc9db', { bus: true })),
        ...vcas.map((r) => vcaStrip(r)),
        strip('master', 'Master', '#ffa94d', { master: true }));
      strips.style.scrollSnapType = 'none'; // keep the scroll position across rebuilds (no re-snap)
      strips.scrollLeft = sl;
      requestAnimationFrame(() => { strips.style.scrollSnapType = ''; });
      if (!p.tracks.length) strips.prepend(emptyState('Nothing to mix yet', 'Add or generate some tracks first.', bigButton('Create', () => nav.go({ page: 'home' }), { ic: 'sparkles', cls: 'primary' })));
    }
    for (const u of updaters) u();
  }

  // ------------------------------------------------------------------ loudness
  const analysis = () => (engine.ctx ? engine.getMasterAnalysis?.() : null);
  function paintLufs() {
    const r = lufsReadout(analysis()?.read());
    lufsBtn.querySelector('.pk-lufs-s').textContent = r.short;
    lufsBtn.querySelector('.pk-lufs-i').textContent = r.integrated;
    lufsBtn.classList.toggle('hot', r.hot);
  }
  function loudnessSheet() {
    const vals = h('div.pk-lufs-grid');
    const sheet = openSheet({
      title: 'Loudness (master)', body: [vals, h('p.pk-hint', 'Streaming targets: Spotify / YouTube −14, Apple −16, broadcast −23 LUFS integrated, true peak ≤ −1 dBTP. Play the whole song for the integrated value.')],
      actions: bigButton('Reset', () => { analysis()?.reset(); haptic(6); }, { ic: 'refresh' }),
    });
    const tick = () => {
      if (!sheet.back.isConnected) return;
      const a = analysis();
      const m = a?.read();
      const r = lufsReadout(m);
      vals.replaceChildren(...[['Momentary', r.momentary, 'LUFS'], ['Short-term', r.short, 'LUFS'], ['Integrated', r.integrated, 'LUFS'], ['Range (LRA)', r.lra, 'LU'], ['True peak', r.peak, 'dBTP']]
        .map(([l, v, u]) => h(`div.pk-lufs-cell${u === 'dBTP' && r.hot ? '.hot' : ''}`, h('span.pk-label', l), h('b', v), h('small', u))));
      if (!a) vals.append(h('p.pk-p', 'Press play to measure.'));
      setTimeout(tick, 250);
    };
    tick();
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
    const now = performance.now();
    if (now - lastLufs > 200) { lastLufs = now; paintLufs(); }
  };
  app.subscribe(() => { if (visible) render(); });
  return { el, show() { visible = true; render(); if (!raf) raf = requestAnimationFrame(frame); }, hide() { visible = false; } };
}
