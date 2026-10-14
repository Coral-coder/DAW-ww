// Pocket ▸ Mix — pure strip layout and reorder logic (Node-testable): folder rows, group / VCA badges, drag-reorder of
// the visible strips mapped onto project.tracks (Mix order = track order), compact LUFS formatting.
import { mixerOf, trackRows, vcasOf, VCA_MAX } from '../core/mixer-model.js';
import { reorder } from './reorder.js';

export { VCA_MAX };

/** Enabled groups / VCAs a channel belongs to, as badges {id, name, color, kind: 'group' | 'vca', links}. */
export function channelBadges(project, id) {
  const m = mixerOf(project);
  const gs = m.groups.filter((g) => g.members?.includes(id)).map((g) => ({
    id: g.id, name: g.name, color: g.color || null, kind: 'group', enabled: g.enabled !== false,
    links: Object.entries(g.link || {}).filter(([, on]) => on).map(([k]) => k),
  }));
  const vs = vcasOf(project, id).map((v) => ({ id: v.id, name: v.name, color: v.color || null, kind: 'vca', enabled: true, links: [] }));
  return [...gs, ...vs];
}

/**
 * The Mix page's strip list: [{kind:'folder', folder, members, collapsed}, {kind:'track', track, depth, badges}]
 * (members of collapsed folders left out), then the VCA strips [{kind:'vca', vca, members}].
 */
export function mixStrips(project) {
  const rows = trackRows(project).map((r) => (r.kind === 'folder'
    ? { kind: 'folder', folder: r.folder, members: r.members, collapsed: !!r.folder.collapsed }
    : { kind: 'track', track: r.track, depth: r.depth, badges: channelBadges(project, r.track.id) }));
  const vcas = mixerOf(project).vcas.map((v) => ({ kind: 'vca', vca: v, members: (v.members || []).filter((id) => project.tracks.some((t) => t.id === id) || project.buses?.some((b) => b.id === id)) }));
  return { rows, vcas };
}

/** Ids of the visible track strips, in order. */
export const visibleStripIds = (project) => mixStrips(project).rows.filter((r) => r.kind === 'track').map((r) => r.track.id);

/**
 * Reorder via the visible strips: strip `from` moves to the place of strip `to` (indexes into visibleIds). Hidden tracks
 * (collapsed folders) keep their place relative to their neighbours. Returns the new project.tracks array.
 */
export function reorderVisible(tracks, visibleIds, from, to) {
  if (from === to || from < 0 || to < 0 || from >= visibleIds.length || to >= visibleIds.length) return tracks.slice();
  const fi = tracks.findIndex((t) => t.id === visibleIds[from]);
  let ti = tracks.findIndex((t) => t.id === visibleIds[to]);
  if (fi < 0 || ti < 0) return tracks.slice();
  // moving down: land after the target strip — and after the hidden members that follow it
  if (to > from) { while (ti + 1 < tracks.length && !visibleIds.includes(tracks[ti + 1].id) && tracks[ti + 1].folderId && tracks[ti + 1].folderId === tracks[ti].folderId) ti++; }
  return reorder(tracks, fi, ti);
}

/**
 * After a move, a track takes the folder it landed in: inside a folder's run (neighbours above and below are in the
 * same folder, or it already was in the folder next to it) → that folder; else no folder. Returns the folder id or null
 * (apply it with mixer-model setTrackFolder, which also fixes folder-bus routing).
 */
export function folderAfterMove(project, trackId) {
  const ts = project.tracks;
  const i = ts.findIndex((t) => t.id === trackId);
  if (i < 0) return null;
  const t = ts[i], up = ts[i - 1], dn = ts[i + 1];
  const folders = new Set(mixerOf(project).folders.map((f) => f.id));
  let f = null;
  if (up?.folderId && folders.has(up.folderId) && (dn?.folderId === up.folderId || t.folderId === up.folderId)) f = up.folderId;
  else if (dn?.folderId && folders.has(dn.folderId) && t.folderId === dn.folderId) f = dn.folderId;
  return f;
}

/** Compact loudness text: "−14.2" / "−∞". */
export const fmtLu = (x) => (Number.isFinite(x) && x > -70 ? `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}` : '−∞');
/** Readout chunks for a MasterAnalysis.read() result. */
export function lufsReadout(m) {
  if (!m) return { short: '−∞', integrated: '−∞', peak: '−∞', hot: false };
  return { short: fmtLu(m.shortTerm), integrated: fmtLu(m.integrated), momentary: fmtLu(m.momentary), peak: fmtLu(m.truePeakDb), lra: Number.isFinite(m.lra) ? m.lra.toFixed(1) : '—', hot: Number.isFinite(m.truePeakDb) && m.truePeakDb > -1 };
}
