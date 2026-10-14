// Pocket ▸ pro features — pure helpers (Node-testable): recording-take sections, tempo / meter change lists.
import { allTakes, takeEnd, compTakeAt, compExtent, hasTakes } from '../record/takes.js';
import { songTempoMap } from '../time/tempo-map.js';

const EPS = 1e-6;
const r6 = (x) => +(+x).toFixed(6);

/**
 * Sections for choosing takes: the song's marker sections that overlap the takes (else the comp's own segments, else
 * one section per take extent). Each: {start, end, name, takeId (what plays at the section start), takes: [{id, name,
 * pass, covers}]} — `covers` = the take spans the whole section.
 */
export function takeSections(project, track) {
  if (!hasTakes(track)) return [];
  const takes = allTakes(track).map((x) => x.take);
  const lo = Math.min(...takes.map((t) => t.start)), hi = Math.max(...takes.map(takeEnd));
  const ms = [...(project.markers || [])].sort((a, b) => a.beat - b.beat);
  let ranges = [];
  ms.forEach((m, i) => {
    const s = m.beat, e = ms[i + 1]?.beat ?? Infinity;
    const a = Math.max(s, lo), b = Math.min(e, hi);
    if (b - a > EPS) ranges.push({ start: r6(a), end: r6(b), name: m.name });
  });
  if (ms.length && ms[0].beat > lo + EPS) ranges.unshift({ start: r6(lo), end: r6(Math.min(ms[0].beat, hi)), name: 'Intro' });
  if (!ranges.length) {
    const comp = track.comp || [];
    ranges = comp.length ? comp.map((s, i) => ({ start: s.start, end: s.end, name: `Part ${i + 1}` })) : [{ start: r6(lo), end: r6(hi), name: 'Recording' }];
  }
  return ranges.map((r) => ({
    ...r,
    takeId: compTakeAt(track, r.start + EPS * 10) || null,
    takes: takes.filter((t) => t.start < r.end - EPS && takeEnd(t) > r.start + EPS)
      .sort((a, b) => (b.pass ?? 0) - (a.pass ?? 0))
      .map((t) => ({ id: t.id, name: t.name || `Take ${t.pass ?? ''}`.trim(), pass: t.pass ?? null, covers: t.start <= r.start + EPS && takeEnd(t) >= r.end - EPS })),
  }));
}

/** Short summary of a track's takes: "3 takes · comp bars 1–9". */
export function takeSummary(project, track) {
  const n = allTakes(track).length;
  const ext = compExtent(track);
  if (!n) return '';
  const map = songTempoMap(project);
  return `${n} take${n === 1 ? '' : 's'}${ext ? ` · comp bars ${map.barAt(ext[0]).bar + 1}–${map.barAt(Math.max(ext[0], ext[1] - EPS)).bar + 1}` : ''}`;
}

/** Tempo change list: [{i, beat, bbt, bpm, curve}] — point 0 is the song tempo (always present). */
export function tempoRows(project) {
  const map = songTempoMap(project);
  const pts = project.tempoMap?.length ? project.tempoMap : [{ beat: 0, bpm: project.bpm, curve: 'jump' }];
  return pts.map((p, i) => ({ i, beat: p.beat, bbt: map.formatBBT(p.beat), bpm: i === 0 ? project.bpm : p.bpm, curve: p.curve === 'linear' ? 'linear' : 'jump' }));
}

/** Meter list: [{bar (0-based), label 'Bar n', num, den}] — bar 0 is the song meter. */
export function meterRows(project) {
  const ts = project.timeSig || [4, 4];
  return [{ bar: 0, num: ts[0], den: ts[1] }, ...(project.meterMap || []).map((m) => ({ bar: m.bar, num: m.num, den: m.den }))]
    .map((m) => ({ ...m, label: `Bar ${m.bar + 1}` }));
}
