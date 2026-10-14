// Snapshot diff for versioning: what changed between two project JSONs, grouped the way a musician
// thinks about it (song settings, tracks, clips, patterns/notes, buses, samples). Pure / Node-safe.
import { deepEqual } from './crdt.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IGNORE = new Set(['modifiedAt', 'createdAt', 'id', 'format', 'version', 'samples', 'tracks', 'patterns', 'clips', 'buses', 'markers', 'scenes']);

/** Changed leaves between two values, flattening plain objects: [{ key:'instrument.params.cutoff', from, to }]. */
function fieldChanges(a, b, prefix = '', skip = null, out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (skip && skip.has(k)) continue;
    const x = a?.[k], y = b?.[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (deepEqual(x, y)) continue;
    if (isObj(x) && isObj(y)) fieldChanges(x, y, key, null, out);
    else out.push({ key, from: x, to: y });
  }
  return out;
}

function diffById(listA, listB, describe, skip) {
  const A = new Map(listA.map((x) => [x.id, x])), B = new Map(listB.map((x) => [x.id, x]));
  const added = [], removed = [], changed = [];
  for (const [id, y] of B) if (!A.has(id)) added.push({ id, name: describe(y) });
  for (const [id, x] of A) {
    if (!B.has(id)) { removed.push({ id, name: describe(x) }); continue; }
    const fields = fieldChanges(x, B.get(id), '', skip);
    if (fields.length) changed.push({ id, name: describe(B.get(id)), fields });
  }
  return { added, removed, changed };
}

function noteDiff(a = [], b = []) {
  const A = new Map(a.map((n) => [n.id, n])), B = new Map(b.map((n) => [n.id, n]));
  let added = 0, removed = 0, changed = 0;
  for (const id of B.keys()) if (!A.has(id)) added++;
  for (const [id, n] of A) { if (!B.has(id)) removed++; else if (!deepEqual(n, B.get(id))) changed++; }
  return { added, removed, changed };
}

export function diffProjects(a, b) {
  const trackName = (t) => t.name || t.id;
  const tracks = diffById(a.tracks || [], b.tracks || [], trackName);
  const allTracks = new Map([...(a.tracks || []), ...(b.tracks || [])].map((t) => [t.id, t.name]));
  const clipName = (c) => `${c.name || allTracks.get(c.trackId) || 'clip'} @ ${+(c.start ?? 0).toFixed(2)}`;
  const clips = diffById(a.clips || [], b.clips || [], clipName);
  const pats = diffById(Object.values(a.patterns || {}), Object.values(b.patterns || {}), (p) => p.name || p.id, new Set(['notes']));
  // patterns whose only change is notes are not in pats.changed yet
  const changedPats = new Map(pats.changed.map((c) => [c.id, c]));
  for (const [id, pb] of Object.entries(b.patterns || {})) {
    const pa = a.patterns?.[id];
    if (!pa) continue;
    const nd = noteDiff(pa.notes, pb.notes);
    if (!nd.added && !nd.removed && !nd.changed) continue;
    const entry = changedPats.get(id) || { id, name: pb.name || id, fields: [] };
    entry.notes = nd;
    changedPats.set(id, entry);
  }
  pats.changed = [...changedPats.values()];
  return {
    project: fieldChanges(a, b, '', IGNORE),
    tracks,
    clips,
    patterns: pats,
    buses: diffById(a.buses || [], b.buses || [], (x) => x.name || x.id),
    markers: diffById(a.markers || [], b.markers || [], (x) => x.name || x.id),
    samples: diffById(Object.values(a.samples || {}).map(({ data, ...m }) => m), Object.values(b.samples || {}).map(({ data, ...m }) => m), (x) => x.name || x.id),
  };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One-line human summary of a diff. */
export function summarizeDiff(d) {
  const parts = [];
  if (d.project.length) parts.push(`song: ${d.project.map((c) => c.key).join(', ')}`);
  for (const [k, w] of [['tracks', 'track'], ['clips', 'clip'], ['patterns', 'pattern'], ['buses', 'bus'], ['markers', 'marker'], ['samples', 'sample']]) {
    const g = d[k];
    if (g.added.length) parts.push(`${plural(g.added.length, w)} added`);
    if (g.removed.length) parts.push(`${plural(g.removed.length, w)} removed`);
    if (g.changed.length) parts.push(`${plural(g.changed.length, w)} changed`);
  }
  let na = 0, nr = 0, nc = 0;
  for (const p of d.patterns.changed) if (p.notes) { na += p.notes.added; nr += p.notes.removed; nc += p.notes.changed; }
  if (na || nr || nc) parts.push(`notes +${na} −${nr} ~${nc}`);
  return parts.length ? parts.join(' · ') : 'No changes';
}
