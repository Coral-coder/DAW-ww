// Mixer structure (pure, Node-safe): folders, groups, VCA faders, solo logic (SIP / AFL / PFL, solo-safe,
// exclusive), per-send pre/post taps, output routing, mixer snapshots and channel-strip extras.
//
// Data (all optional — absent = the old behaviour, bit-identical renders):
//   project.mixer = {
//     soloMode: 'sip' | 'afl' | 'pfl'     (solo-in-place mutes the others; AFL/PFL only route soloed channels to the
//                                          cue bus — the main mix / exports are untouched),
//     groups:  [{ id, name, color, members:[trackId], mode:'relative'|'absolute', enabled,
//                 link:{ volume, pan, mute, solo, arm, select } }],
//     vcas:    [{ id, name, color, volume (linear, 1 = 0 dB), mute, members:[trackId|busId], automation:[lane 'volume'] }],
//     folders: [{ id, name, color, collapsed, busId|null (summing bus when set) }],
//     snapshots: [{ id, name, at, state }],
//   }
//   track: folderId, trim (dB), phase (bool, polarity invert), width (0 = mono … 1 … 2), soloSafe, notes,
//          sendModes:{busId:'pre'|'post'}, output (busId → main out into that bus instead of the master),
//          padOutputs:{padKey: busId} (drum multi-out)
//   bus:   folderId (folder summing bus), source:{trackId, pad} (drum multi-out channel), trim, phase, width
//
// VCA math: a VCA never carries audio. Member gain = own fader (or its automation) × Π gain(VCA) over every VCA
// the member belongs to — i.e. VCA levels add in dB, VCA automation multiplies with member automation.
import { uid, clamp, dbToGain, gainToDb } from './util.js';
import { valueAt } from './automation.js';

export const SOLO_MODES = ['sip', 'afl', 'pfl'];
export const VOL_MAX = 1.5;
export const VCA_MAX = 4; // +12 dB
export const LINK_KEYS = ['volume', 'pan', 'mute', 'solo', 'arm', 'select'];

const EMPTY = Object.freeze({ soloMode: 'sip', groups: [], vcas: [], folders: [], snapshots: [] });

/** Read-only view of project.mixer with defaults. */
export function mixerOf(project) {
  const m = project?.mixer;
  if (!m) return EMPTY;
  return {
    soloMode: SOLO_MODES.includes(m.soloMode) ? m.soloMode : 'sip',
    groups: Array.isArray(m.groups) ? m.groups : [],
    vcas: Array.isArray(m.vcas) ? m.vcas : [],
    folders: Array.isArray(m.folders) ? m.folders : [],
    snapshots: Array.isArray(m.snapshots) ? m.snapshots : [],
  };
}

/** project.mixer, created with every list (mutates — use inside store.transact). */
export function ensureMixer(project) {
  const m = (project.mixer ||= {});
  if (!SOLO_MODES.includes(m.soloMode)) m.soloMode = 'sip';
  for (const k of ['groups', 'vcas', 'folders', 'snapshots']) if (!Array.isArray(m[k])) m[k] = [];
  return m;
}

const channelOf = (project, id) => project.tracks?.find((t) => t.id === id) || project.buses?.find((b) => b.id === id) || null;

// ------------------------------------------------------------------------------------------------ groups
export function createGroup(project, name, members = [], opts = {}) {
  const m = ensureMixer(project);
  const link = { volume: true, pan: false, mute: true, solo: true, arm: true, select: true, ...(opts.link || {}) };
  const g = { id: uid('grp'), name: name || `Group ${m.groups.length + 1}`, color: opts.color || null, members: [...new Set(members)], mode: opts.mode === 'absolute' ? 'absolute' : 'relative', enabled: opts.enabled !== false, link };
  m.groups.push(g);
  return g;
}

export function removeGroup(project, groupId) {
  const m = ensureMixer(project);
  m.groups = m.groups.filter((g) => g.id !== groupId);
}

/** Enabled groups that contain `trackId` (and link `key`, when given). */
export function groupsOf(project, trackId, key = null) {
  return mixerOf(project).groups.filter((g) => g.enabled !== false && g.members?.includes(trackId) && (!key || g.link?.[key]));
}

/** Every track id linked to `trackId` for `key` (itself included), through all its enabled groups (transitive). */
export function linkedIds(project, trackId, key) {
  const out = new Set([trackId]);
  const stack = [trackId];
  while (stack.length) {
    const id = stack.pop();
    for (const g of groupsOf(project, id, key)) for (const m of g.members) if (!out.has(m)) { out.add(m); stack.push(m); }
  }
  return [...out].filter((id) => channelOf(project, id));
}

/** Group mode for a linked edit started on trackId: 'absolute' if any of its linking groups says so. */
function modeFor(project, trackId, key) {
  return groupsOf(project, trackId, key).some((g) => g.mode === 'absolute') ? 'absolute' : 'relative';
}

/**
 * A fader / pan / switch edit on one channel, propagated to its group members (mutates the project).
 * key: 'volume' | 'pan' | 'mute' | 'solo' | 'arm'; value: the new value of `trackId`.
 * Relative mode: volume moves every member by the same dB delta (members at −∞ stay there), pan by the same offset;
 * absolute mode: every member gets the same value. Switches are always absolute. bypass (e.g. Alt-drag) = no linking.
 * Returns the ids that changed.
 */
export function applyLinkedEdit(project, trackId, key, value, { bypass = false } = {}) {
  const src = channelOf(project, trackId);
  if (!src) return [];
  const ids = bypass ? [trackId] : linkedIds(project, trackId, key);
  const mode = modeFor(project, trackId, key);
  const old = src[key];
  const changed = [];
  for (const id of ids) {
    const ch = channelOf(project, id);
    if (!ch) continue;
    let nv;
    if (key === 'volume') {
      if (id === trackId || mode === 'absolute') nv = value;
      else {
        const o = Number(old) || 0;
        const cur = Number(ch.volume) || 0;
        if (o <= 1e-6 || cur <= 1e-6) nv = o <= 1e-6 ? value : cur; // no defined ratio: follow absolutely / stay at −∞
        else nv = dbToGain(gainToDb(cur) + (gainToDb(value) - gainToDb(o)));
      }
      nv = +clamp(nv, 0, VOL_MAX).toFixed(6);
    } else if (key === 'pan') {
      nv = id === trackId || mode === 'absolute' ? value : (Number(ch.pan) || 0) + (value - (Number(old) || 0));
      nv = +clamp(nv, -1, 1).toFixed(4);
    } else {
      nv = !!value;
    }
    if (ch[key] !== nv) { ch[key] = nv; changed.push(id); }
  }
  return changed;
}

/** Selection follows groups that link 'select'. */
export function groupSelection(project, trackId) { return linkedIds(project, trackId, 'select'); }

/** "Channel link": a quick absolute group of the given channels (volume, pan, mute, solo — stereo-pair style). */
export function linkChannels(project, ids, name) {
  return createGroup(project, name || 'Link', ids, { mode: 'absolute', link: { volume: true, pan: true, mute: true, solo: true, arm: true, select: true } });
}

// ------------------------------------------------------------------------------------------------ VCAs
export function createVca(project, name, members = [], opts = {}) {
  const m = ensureMixer(project);
  const v = { id: uid('vca'), name: name || `VCA ${m.vcas.length + 1}`, color: opts.color || null, volume: opts.volume ?? 1, mute: false, members: [...new Set(members)], automation: [] };
  m.vcas.push(v);
  return v;
}

export function removeVca(project, vcaId) {
  const m = ensureMixer(project);
  m.vcas = m.vcas.filter((v) => v.id !== vcaId);
}

export const vcasOf = (project, memberId) => mixerOf(project).vcas.filter((v) => v.members?.includes(memberId));

const vcaLane = (v) => (v.automation || []).find((l) => l.target === 'volume' && l.enabled !== false && l.points?.length) || null;

/** Static VCA gain on a member (product of every VCA's level; a muted VCA → 0). 1 when it has none. */
export function vcaGainFor(project, memberId) {
  let g = 1;
  for (const v of vcasOf(project, memberId)) g *= v.mute ? 0 : clamp(Number(v.volume ?? 1), 0, VCA_MAX);
  return g;
}

/** Total VCA offset in dB on a member (sum of the VCAs' dB levels; −Infinity when one is at 0 / muted). */
export function vcaDb(project, memberId) {
  const g = vcaGainFor(project, memberId);
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

/** VCA gain on a member at `beat` (automation lanes used where present, static level elsewhere). */
export function vcaGainAt(project, memberId, beat) {
  let g = 1;
  for (const v of vcasOf(project, memberId)) {
    if (v.mute) return 0;
    const lane = vcaLane(v);
    g *= clamp(lane ? valueAt(lane.points, beat) : Number(v.volume ?? 1), 0, VCA_MAX);
  }
  return g;
}

/** Is any VCA over this member automated? */
export function hasVcaAutomation(project, memberId) {
  return vcasOf(project, memberId).some((v) => !v.mute && vcaLane(v));
}

/**
 * The combined VCA gain of a member as one automation lane (points at the union of every lane's breakpoints,
 * value = product), or null when no VCA over it is automated. Exact at the breakpoints; with several automated VCAs
 * the product between breakpoints is linearised (a close approximation of a product of ramps).
 */
export function vcaCombinedLane(project, memberId) {
  const vs = vcasOf(project, memberId);
  if (!vs.some((v) => !v.mute && vcaLane(v))) return null;
  const beats = new Set();
  for (const v of vs) for (const p of vcaLane(v)?.points || []) beats.add(p.beat);
  const sorted = [...beats].sort((a, b) => a - b);
  const points = [];
  for (const b of sorted) {
    // a vertical jump in any lane: evaluate just before and at the beat
    const jump = vs.some((v) => { const pts = vcaLane(v)?.points || []; return pts.filter((p) => p.beat === b).length > 1; });
    if (jump) points.push({ beat: b, value: vcaGainBefore(project, memberId, b) });
    points.push({ beat: b, value: vcaGainAt(project, memberId, b) });
  }
  return { id: `vca:${memberId}`, target: 'vca', enabled: true, points };
}

function vcaGainBefore(project, memberId, beat) {
  let g = 1;
  for (const v of vcasOf(project, memberId)) {
    if (v.mute) return 0;
    const lane = vcaLane(v);
    if (!lane) { g *= Number(v.volume ?? 1); continue; }
    const first = lane.points.find((p) => p.beat === beat);
    g *= lane.points.filter((p) => p.beat === beat).length > 1 ? first.value : valueAt(lane.points, beat);
  }
  return g;
}

/** Effective member gain at `beat`: own fader value (or its lane value) × VCA gain. */
export function memberGainAt(project, member, beat, ownLaneValue = null) {
  const own = ownLaneValue != null ? ownLaneValue : Number(member.volume ?? 0.8);
  return own * vcaGainAt(project, member.id, beat);
}

// ------------------------------------------------------------------------------------------------ solo
/**
 * Solo state of the main mix and the cue (monitor) bus.
 * -> { mode, anySolo, audible(trackId) (main mix: not muted and — in SIP — soloed / solo-safe / nothing soloed),
 *      cue: [{id, tap:'pre'|'post'}] (AFL = post-fader, PFL = pre-fader; empty in SIP) }
 */
export function soloState(project) {
  const mode = mixerOf(project).soloMode;
  const tracks = project?.tracks || [];
  const buses = project?.buses || [];
  const anySolo = tracks.some((t) => t.solo) || buses.some((b) => b.solo);
  const sip = mode === 'sip';
  const audible = (id) => {
    const t = tracks.find((x) => x.id === id);
    if (t) return isAudible(project, t);
    const b = buses.find((x) => x.id === id);
    return !!b && !b.mute;
  };
  const cue = sip ? [] : [...tracks, ...buses].filter((c) => c.solo).map((c) => ({ id: c.id, tap: mode === 'pfl' ? 'pre' : 'post' }));
  return { mode, anySolo, audible, cue };
}

/** Does a track sound in the main mix? (mute, solo-in-place with solo-safe; AFL / PFL never silence the mix) */
export function isAudible(project, track) {
  if (!track || track.mute) return false;
  if (mixerOf(project).soloMode !== 'sip') return true;
  const anySolo = (project?.tracks || []).some((t) => t.solo);
  if (!anySolo) return true;
  if (track.solo || track.soloSafe) return true;
  // a track inside a soloed folder (its folder bus is the soloed channel)
  return false;
}

/** Toggle solo (mutates). exclusive: unsolo everything else first. Group-linked. Returns the new solo value. */
export function toggleSolo(project, trackId, { exclusive = false, bypass = false } = {}) {
  const t = channelOf(project, trackId);
  if (!t) return false;
  if (exclusive) {
    const onlyThis = t.solo && !project.tracks.some((y) => y.solo && y.id !== trackId);
    const ids = new Set(bypass ? [trackId] : linkedIds(project, trackId, 'solo'));
    for (const x of project.tracks) x.solo = !onlyThis && ids.has(x.id);
    for (const b of project.buses || []) if (b.solo) b.solo = false;
    return !!t.solo;
  }
  applyLinkedEdit(project, trackId, 'solo', !t.solo, { bypass });
  return !!t.solo;
}

// ------------------------------------------------------------------------------------------------ sends / routing
export const sendTap = (track, busId) => (track?.sendModes?.[busId] === 'pre' ? 'pre' : 'post');

/** Main-out destination of a track: a bus id (folder bus / custom routing) or 'master'. */
export function outputOf(project, track) {
  const id = track?.output;
  if (id && (project?.buses || []).some((b) => b.id === id)) return id;
  return 'master';
}

/** Buses fed by a track: its sends (> 0), its output bus and its drum multi-outs. */
export function busesFedBy(project, track) {
  const out = new Set();
  for (const [b, v] of Object.entries(track?.sends || {})) if (v > 0) out.add(b);
  const o = outputOf(project, track);
  if (o !== 'master') out.add(o);
  for (const b of Object.values(track?.padOutputs || {})) if (b) out.add(b);
  return [...out].filter((id) => (project?.buses || []).some((b) => b.id === id));
}

// ------------------------------------------------------------------------------------------------ folders
export function createFolder(project, name, trackIds = [], opts = {}) {
  const m = ensureMixer(project);
  const f = { id: uid('fld'), name: name || `Folder ${m.folders.length + 1}`, color: opts.color || null, collapsed: false, busId: null };
  m.folders.push(f);
  for (const t of project.tracks) if (trackIds.includes(t.id)) t.folderId = f.id;
  // keep members contiguous (folder rows sit together in Arrange / Mixer)
  const ids = new Set(trackIds);
  const first = project.tracks.findIndex((t) => ids.has(t.id));
  if (first >= 0) {
    const members = project.tracks.filter((t) => ids.has(t.id));
    const rest = project.tracks.filter((t) => !ids.has(t.id));
    const at = project.tracks.slice(0, first).filter((t) => !ids.has(t.id)).length;
    rest.splice(at, 0, ...members);
    project.tracks = rest;
  }
  if (opts.sum) setFolderSum(project, f.id, true);
  return f;
}

export const folderMembers = (project, folderId) => (project?.tracks || []).filter((t) => t.folderId === folderId);

/** Folder as a summing bus: on → a bus (folderId set) and every member's main out goes into it; off → removed. */
export function setFolderSum(project, folderId, on, makeBus) {
  const m = ensureMixer(project);
  const f = m.folders.find((x) => x.id === folderId);
  if (!f) return null;
  if (on) {
    let bus = project.buses.find((b) => b.id === f.busId);
    if (!bus) {
      bus = makeBus ? makeBus(f.name) : { id: uid('bus'), name: f.name, volume: 0.8, pan: 0, mute: false, fx: [], automation: [] };
      bus.folderId = f.id;
      project.buses.push(bus);
      f.busId = bus.id;
    }
    for (const t of folderMembers(project, f.id)) t.output = bus.id;
    return bus;
  }
  const busId = f.busId;
  f.busId = null;
  for (const t of project.tracks) if (t.output === busId) delete t.output;
  if (busId) {
    project.buses = project.buses.filter((b) => b.id !== busId);
    for (const t of project.tracks) if (t.sends) delete t.sends[busId];
  }
  return null;
}

export function removeFolder(project, folderId) {
  setFolderSum(project, folderId, false);
  const m = ensureMixer(project);
  m.folders = m.folders.filter((f) => f.id !== folderId);
  for (const t of project.tracks) if (t.folderId === folderId) delete t.folderId;
}

/** Add / move a track into a folder (null = out of any folder); routes it into the folder bus when summing. */
export function setTrackFolder(project, trackId, folderId) {
  const t = project.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const old = mixerOf(project).folders.find((f) => f.id === t.folderId);
  if (old?.busId && t.output === old.busId) delete t.output;
  if (!folderId) { delete t.folderId; return; }
  const f = mixerOf(project).folders.find((x) => x.id === folderId);
  if (!f) return;
  t.folderId = f.id;
  if (f.busId) t.output = f.busId;
}

/**
 * Rows for a track list with folders: [{kind:'folder', folder, members}, {kind:'track', track, depth}].
 * Members of a collapsed folder are left out. Folder headers sit before their first member.
 */
export function trackRows(project, { collapsed } = {}) {
  const folders = new Map(mixerOf(project).folders.map((f) => [f.id, f]));
  const isCollapsed = collapsed || ((f) => !!f.collapsed);
  const rows = [];
  const seen = new Set();
  for (const t of project?.tracks || []) {
    const f = t.folderId ? folders.get(t.folderId) : null;
    if (f && !seen.has(f.id)) {
      seen.add(f.id);
      rows.push({ kind: 'folder', folder: f, members: folderMembers(project, f.id) });
    }
    if (f && isCollapsed(f)) continue;
    rows.push({ kind: 'track', track: t, depth: f ? 1 : 0 });
  }
  return rows;
}

/** Tracks visible in a track list (collapsed folders hide their members). */
export function visibleTrackIds(project) {
  return trackRows(project).filter((r) => r.kind === 'track').map((r) => r.track.id);
}

// ------------------------------------------------------------------------------------------------ snapshots
const STRIP_KEYS = ['volume', 'pan', 'mute', 'solo', 'trim', 'phase', 'width', 'soloSafe'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** Mixer state (faders, pans, switches, sends, insert on/params, VCAs) as plain JSON. */
export function captureMixerState(project) {
  const fxState = (fx) => (fx || []).map((f) => ({ id: f.id, enabled: f.enabled !== false, params: clone(f.params || {}) }));
  return {
    tracks: Object.fromEntries(project.tracks.map((t) => [t.id, { ...pick(t, STRIP_KEYS), sends: clone(t.sends || {}), sendModes: clone(t.sendModes || {}), fx: fxState(t.fx) }])),
    buses: Object.fromEntries((project.buses || []).map((b) => [b.id, { ...pick(b, STRIP_KEYS), fx: fxState(b.fx) }])),
    master: { volume: project.master?.volume, fx: fxState(project.master?.fx) },
    vcas: Object.fromEntries(mixerOf(project).vcas.map((v) => [v.id, { volume: v.volume, mute: !!v.mute }])),
  };
}

/** Save a snapshot (mutates). */
export function saveSnapshot(project, name) {
  const m = ensureMixer(project);
  const s = { id: uid('snap'), name: name || `Mix ${m.snapshots.length + 1}`, at: new Date().toISOString(), state: captureMixerState(project) };
  m.snapshots.push(s);
  return s;
}

/**
 * Recall a mixer state (mutates). include: {faders, pans, switches, sends, fx} (all true by default).
 * Channels / effects that no longer exist are skipped; new ones are left as they are.
 */
export function recallMixerState(project, state, include = {}) {
  const inc = { faders: true, pans: true, switches: true, sends: true, fx: true, ...include };
  const applyStrip = (ch, s) => {
    if (!ch || !s) return;
    if (inc.faders) { if (s.volume !== undefined) ch.volume = s.volume; if (s.trim !== undefined) ch.trim = s.trim; }
    if (inc.pans) { if (s.pan !== undefined) ch.pan = s.pan; if (s.width !== undefined) ch.width = s.width; }
    if (inc.switches) for (const k of ['mute', 'solo', 'phase', 'soloSafe']) if (s[k] !== undefined) ch[k] = s[k];
    if (inc.sends && s.sends) { ch.sends = Object.fromEntries(Object.entries(s.sends).filter(([b]) => project.buses.some((x) => x.id === b))); ch.sendModes = clone(s.sendModes || {}); }
    if (inc.fx && s.fx) for (const f of s.fx) { const cur = ch.fx?.find((x) => x.id === f.id); if (cur) { cur.enabled = f.enabled; cur.params = clone(f.params); } }
  };
  for (const t of project.tracks) applyStrip(t, state.tracks?.[t.id]);
  for (const b of project.buses || []) applyStrip(b, state.buses?.[b.id]);
  if (state.master) {
    if (inc.faders && state.master.volume !== undefined) project.master.volume = state.master.volume;
    if (inc.fx) for (const f of state.master.fx || []) { const cur = project.master.fx?.find((x) => x.id === f.id); if (cur) { cur.enabled = f.enabled; cur.params = clone(f.params); } }
  }
  if (inc.faders || inc.switches) for (const v of mixerOf(project).vcas) { const s = state.vcas?.[v.id]; if (!s) continue; if (inc.faders) v.volume = s.volume; if (inc.switches) v.mute = s.mute; }
}

/** "Reset mixer": unity-ish faders (0.8), centre pans, no mutes / solos, trims / phase / width back to neutral. */
export function resetMixer(project, { sends = false, vcas = true } = {}) {
  for (const t of project.tracks) {
    t.volume = 0.8; t.pan = 0; t.mute = false; t.solo = false;
    delete t.trim; delete t.phase; delete t.width;
    if (sends) { t.sends = {}; delete t.sendModes; }
  }
  for (const b of project.buses || []) { b.volume = 0.8; b.pan = 0; b.mute = false; b.solo = false; delete b.trim; delete b.phase; delete b.width; }
  if (vcas) for (const v of mixerOf(project).vcas) { v.volume = 1; v.mute = false; }
}

// ------------------------------------------------------------------------------------------------ strip extras
/** Input trim (dB) × polarity → linear gain of the input stage. */
export function inputGain(ch) {
  const trim = clamp(Number(ch?.trim) || 0, -24, 24);
  return dbToGain(trim) * (ch?.phase ? -1 : 1);
}

/** Stereo width (0 = mono, 1 = unchanged, 2 = extra wide) → M/S matrix {ll, rl, lr, rr} (L' = ll·L + rl·R …). */
export function widthMatrix(width = 1) {
  const w = clamp(Number.isFinite(+width) ? +width : 1, 0, 2);
  const a = (1 + w) / 2, b = (1 - w) / 2;
  return { ll: a, rl: b, lr: b, rr: a };
}

/** Track ids hidden by collapsed folders (every member but the first, which stands for the folder). */
export function collapsedHidden(project) {
  const out = new Set();
  const folders = new Map(mixerOf(project).folders.map((f) => [f.id, f]));
  const seen = new Set();
  for (const t of project?.tracks || []) {
    const f = t.folderId && folders.get(t.folderId);
    if (!f) continue;
    if (!seen.has(f.id)) { seen.add(f.id); continue; }
    if (f.collapsed) out.add(t.id);
  }
  return out;
}

/** The folder a track heads (it is that folder's first member), or null. */
export function folderHeadOf(project, trackId) {
  const t = project?.tracks?.find((x) => x.id === trackId);
  const f = t?.folderId && mixerOf(project).folders.find((x) => x.id === t.folderId);
  if (!f) return null;
  return project.tracks.find((x) => x.folderId === f.id)?.id === trackId ? f : null;
}
