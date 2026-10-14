// Mixer structure commands + menus (folders, groups, VCAs, solo modes, snapshots, multi-out drums, routing, notes),
// shared by the Mixer view, the track context menu and the command palette. All edits are single undo steps.
import { h } from './dom.js';
import { modal, promptText, toast } from './components.js';
import { createBus, DRUM_PADS, TRACK_COLORS } from '../core/model.js';
import {
  mixerOf, ensureMixer, createGroup, removeGroup, createVca, removeVca, createFolder, removeFolder, setFolderSum, setTrackFolder,
  saveSnapshot, recallMixerState, resetMixer, linkChannels, SOLO_MODES,
} from '../core/mixer-model.js';

export const SOLO_LABELS = { sip: 'Solo in place', afl: 'AFL (after-fader listen)', pfl: 'PFL (pre-fader listen)' };

const nextColor = (n) => TRACK_COLORS[n % TRACK_COLORS.length];

/** Pads a drum track actually plays (from its patterns), in pad order. */
function usedPads(p, t) {
  const pitches = new Set();
  for (const pat of Object.values(p.patterns || {})) if (pat.trackId === t.id) for (const n of pat.notes || []) pitches.add(n.pitch);
  const keys = new Set();
  for (const pad of DRUM_PADS) if (pitches.has(pad.pitch)) keys.add(pad.key);
  for (const pitch of pitches) { const pad = DRUM_PADS.find((x) => x.pitch === pitch); if (!pad) keys.add('kick'); }
  return DRUM_PADS.filter((pad) => keys.has(pad.key));
}

export function createMixerTools(app) {
  const { store } = app;
  const get = () => store.get();
  const tx = (label, fn) => store.transact(label, fn);

  const cmd = {
    setSoloMode(mode) {
      if (!SOLO_MODES.includes(mode)) return;
      tx(`Solo mode: ${SOLO_LABELS[mode]}`, (p) => { ensureMixer(p).soloMode = mode; });
    },
    async newGroup(ids) {
      const name = await promptText('New group', `Group ${mixerOf(get()).groups.length + 1}`);
      if (!name) return null;
      let g;
      tx(`New group ${name}`, (p) => { g = createGroup(p, name, ids, { color: nextColor(mixerOf(p).groups.length + 3) }); });
      toast(`Group “${name}”: volume, mute, solo, arm and selection are linked (relative). Alt-drag a fader to move one channel only.`, { level: 'success', timeout: 5000 });
      return g;
    },
    linkChannels(ids) {
      if (ids.length < 2) { toast('Select two or more channels to link (Ctrl/Shift-click their names)', { level: 'warn' }); return; }
      tx('Link channels', (p) => { linkChannels(p, ids, `Link ${mixerOf(p).groups.length + 1}`); });
    },
    groupEdit(groupId, fn, label = 'Edit group') { tx(label, (p) => { const g = mixerOf(p).groups.find((x) => x.id === groupId); if (g) fn(g, p); }); },
    deleteGroup(groupId) { tx('Delete group', (p) => removeGroup(p, groupId)); },
    async newVca(ids) {
      const name = await promptText('New VCA fader', `VCA ${mixerOf(get()).vcas.length + 1}`);
      if (!name) return null;
      let v;
      tx(`New VCA ${name}`, (p) => { v = createVca(p, name, ids, { color: nextColor(mixerOf(p).vcas.length + 6) }); });
      return v;
    },
    vcaEdit(vcaId, fn, label = 'Edit VCA', opts) { store.transact(label, (p) => { const v = mixerOf(p).vcas.find((x) => x.id === vcaId); if (v) fn(v, p); }, opts); },
    deleteVca(vcaId) { tx('Delete VCA', (p) => removeVca(p, vcaId)); },
    async newFolder(ids, sum = false) {
      const name = await promptText('New folder', 'Folder');
      if (!name) return null;
      tx(`New folder ${name}`, (p) => { createFolder(p, name, ids, { sum, color: nextColor(mixerOf(p).folders.length + 9) }); });
      return true;
    },
    folderEdit(folderId, fn, label = 'Edit folder') { tx(label, (p) => { const f = mixerOf(p).folders.find((x) => x.id === folderId); if (f) fn(f, p); }); },
    toggleFolder(folderId) { cmd.folderEdit(folderId, (f) => { f.collapsed = !f.collapsed; }, 'Collapse / expand folder'); },
    setFolderSum(folderId, on) { tx(on ? 'Folder → summing bus' : 'Folder: no summing bus', (p) => setFolderSum(p, folderId, on, (name) => createBus(name))); },
    deleteFolder(folderId) { tx('Delete folder', (p) => removeFolder(p, folderId)); },
    moveToFolder(trackId, folderId) { tx(folderId ? 'Move to folder' : 'Remove from folder', (p) => setTrackFolder(p, trackId, folderId)); },
    async saveSnapshot() {
      const name = await promptText('Save mixer snapshot', `Mix ${mixerOf(get()).snapshots.length + 1}`);
      if (!name) return;
      tx(`Save snapshot ${name}`, (p) => { saveSnapshot(p, name); });
      toast(`Snapshot “${name}” saved — recall it from Snapshots ▾`, { level: 'success' });
    },
    recallSnapshot(id, include) {
      const s = mixerOf(get()).snapshots.find((x) => x.id === id);
      if (s) tx(`Recall snapshot ${s.name}`, (p) => recallMixerState(p, s.state, include));
    },
    deleteSnapshot(id) { tx('Delete snapshot', (p) => { const m = ensureMixer(p); m.snapshots = m.snapshots.filter((x) => x.id !== id); }); },
    resetMixer() { tx('Reset mixer', (p) => resetMixer(p)); toast('Mixer reset: faders 0.8, pans centred, mutes / solos / trims cleared (Ctrl+Z to undo)'); },
    setOutput(trackId, busId) { tx('Track output', (p) => { const t = p.tracks.find((x) => x.id === trackId); if (!t) return; if (busId) t.output = busId; else delete t.output; }); },
    toggleSoloSafe(id) { tx('Solo safe', (p) => { const c = p.tracks.find((x) => x.id === id) || p.buses.find((x) => x.id === id); if (c) c.soloSafe = !c.soloSafe; }); },
    async editNotes(id) {
      const c = get().tracks.find((x) => x.id === id) || get().buses.find((x) => x.id === id);
      if (!c) return;
      const v = await promptText(`Notes — ${c.name}`, c.notes || '', { multiline: true, placeholder: 'Mix notes, comp decisions, reminders…' });
      if (v == null) return;
      tx('Track notes', (p) => { const t = p.tracks.find((x) => x.id === id) || p.buses.find((x) => x.id === id); if (t) { if (v.trim()) t.notes = v; else delete t.notes; } });
    },
    /** Drum multi-out: every pad the track plays gets its own mixer channel (a bus fed straight by that pad). */
    splitMultiOut(trackId) {
      const p0 = get();
      const t0 = p0.tracks.find((x) => x.id === trackId);
      if (!t0 || t0.instrument?.type !== 'drums') return;
      const pads = usedPads(p0, t0);
      if (!pads.length) { toast('This drum track plays no pads yet', { level: 'warn' }); return; }
      tx('Multi-out: split pads', (p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        t.padOutputs ||= {};
        for (const pad of pads) {
          if (t.padOutputs[pad.key] && p.buses.some((b) => b.id === t.padOutputs[pad.key])) continue;
          const b = createBus(`${t.name} · ${pad.name}`);
          b.source = { trackId, pad: pad.key };
          b.volume = 1;
          p.buses.push(b);
          t.padOutputs[pad.key] = b.id;
        }
      });
      toast(`${pads.length} pad outputs: each pad now has its own channel strip in the mixer`, { level: 'success' });
    },
    mergeMultiOut(trackId) {
      tx('Multi-out: merge pads', (p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (!t) return;
        const ids = new Set(p.buses.filter((b) => b.source?.trackId === trackId).map((b) => b.id));
        p.buses = p.buses.filter((b) => !ids.has(b.id));
        for (const x of p.tracks) if (x.sends) for (const id of ids) delete x.sends[id];
        delete t.padOutputs;
      });
    },
    /** Checkbox list of channels for a VCA / group membership. */
    editMembers(kind, id) {
      const p = get();
      const list = kind === 'vca' ? mixerOf(p).vcas : mixerOf(p).groups;
      const obj = list.find((x) => x.id === id);
      if (!obj) return;
      const chosen = new Set(obj.members);
      const chans = [...p.tracks.map((t) => ({ id: t.id, name: t.name, color: t.color })), ...(kind === 'vca' ? p.buses.map((b) => ({ id: b.id, name: `${b.name} (bus)`, color: null })) : [])];
      const rows = chans.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: chosen.has(c.id) });
        cb.addEventListener('change', () => { if (cb.checked) chosen.add(c.id); else chosen.delete(c.id); });
        return h('label.mx-member', cb, h('span.mx-member-dot', { style: { background: c.color || 'var(--text-3)' } }), h('span', c.name));
      });
      modal({
        title: `${kind === 'vca' ? 'VCA' : 'Group'} members — ${obj.name}`, width: 380, body: h('div.mx-members', rows),
        actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => tx('Edit members', (pp) => { const o = (kind === 'vca' ? mixerOf(pp).vcas : mixerOf(pp).groups).find((x) => x.id === id); if (o) o.members = chans.filter((c) => chosen.has(c.id)).map((c) => c.id); }) }],
      });
    },
  };

  /** "Mixer" items for a track's context menu (Arrange / Mixer). selIds: currently multi-selected channels. */
  function trackMenuItems(trackId, selIds = []) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return [];
    const ids = [...new Set([trackId, ...selIds])];
    const m = mixerOf(p);
    const inGroups = m.groups.filter((g) => g.members.includes(trackId));
    const inVcas = m.vcas.filter((v) => v.members.includes(trackId));
    const items = [
      { label: 'Folder', icon: 'folder', submenu: [
        { label: ids.length > 1 ? `New folder with ${ids.length} tracks…` : 'New folder with this track…', onClick: () => cmd.newFolder(ids) },
        ...m.folders.filter((f) => f.id !== t.folderId).map((f) => ({ label: `Move to “${f.name}”`, onClick: () => cmd.moveToFolder(trackId, f.id) })),
        t.folderId ? { label: 'Remove from folder', onClick: () => cmd.moveToFolder(trackId, null) } : null,
      ].filter(Boolean) },
      { label: 'Group', icon: 'layers', submenu: [
        { label: ids.length > 1 ? `New group with ${ids.length} tracks…` : 'New group with this track…', onClick: () => cmd.newGroup(ids) },
        ...m.groups.filter((g) => !g.members.includes(trackId)).map((g) => ({ label: `Add to “${g.name}”`, onClick: () => cmd.groupEdit(g.id, (gg) => { gg.members.push(trackId); }, 'Add to group') })),
        ...inGroups.map((g) => ({ label: `Remove from “${g.name}”`, onClick: () => cmd.groupEdit(g.id, (gg) => { gg.members = gg.members.filter((x) => x !== trackId); }, 'Remove from group') })),
      ] },
      { label: 'VCA', icon: 'sliders', submenu: [
        { label: ids.length > 1 ? `New VCA for ${ids.length} tracks…` : 'New VCA for this track…', onClick: () => cmd.newVca(ids) },
        ...m.vcas.filter((v) => !v.members.includes(trackId)).map((v) => ({ label: `Assign to “${v.name}”`, onClick: () => cmd.vcaEdit(v.id, (vv) => { vv.members.push(trackId); }, 'Assign to VCA') })),
        ...inVcas.map((v) => ({ label: `Remove from “${v.name}”`, onClick: () => cmd.vcaEdit(v.id, (vv) => { vv.members = vv.members.filter((x) => x !== trackId); }, 'Remove from VCA') })),
      ] },
      { label: 'Output', icon: 'volume', submenu: [
        { label: `${!t.output ? '● ' : ''}Master`, onClick: () => cmd.setOutput(trackId, null) },
        ...p.buses.filter((b) => !b.source).map((b) => ({ label: `${t.output === b.id ? '● ' : ''}${b.name}`, onClick: () => cmd.setOutput(trackId, b.id) })),
      ] },
      { label: t.soloSafe ? 'Solo safe ✓' : 'Solo safe', icon: 'headphones', onClick: () => cmd.toggleSoloSafe(trackId) },
      { label: t.notes ? 'Notes… ✎' : 'Notes…', icon: 'pencil', onClick: () => cmd.editNotes(trackId) },
    ];
    if (t.instrument?.type === 'drums') {
      items.push(t.padOutputs && Object.keys(t.padOutputs).length
        ? { label: 'Multi-out: merge pad channels', icon: 'drum', onClick: () => cmd.mergeMultiOut(trackId) }
        : { label: 'Multi-out: pads to separate channels', icon: 'drum', onClick: () => cmd.splitMultiOut(trackId) });
    }
    return [{ header: 'Mixer' }, ...items];
  }

  return { cmd, trackMenuItems };
}
