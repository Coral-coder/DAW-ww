// Takes + comping — pure helpers (Node-testable, no Web Audio).
//
// Model (all optional on a track; projects without it behave exactly as before):
//   track.takeLanes = [{ id, name?, takes: Take[] }]           rows under the track ("take lanes")
//   Take  = { id, name, sampleId | patternId, start, length, offset, gain?, srcLength?, pass? }
//           start / length / offset in beats like a Clip (offset = beats into the sample / pattern; under a tempo map
//           audio offsets are content beats at the tempo of the take start — srcSecAt);
//           srcLength = length of the source in beats (lets crossfades use the handle after the take's end)
//   track.comp = [{ takeId, start, end }]                      sorted, non-overlapping song-beat ranges
//   track.compXfade = ms                                       crossfade at comp boundaries (default 10, equal power)
//
// The comp is what plays: compClips() turns it into virtual clips (audio: crossfaded with equal-power fades; MIDI:
// pattern clips cut to the segment) that the scheduler plays next to the track's ordinary clips (see clips.js
// trackClips). Recording (src/record/session.js) adds one take per cycle / punch pass and points the comp at the
// newest take for the recorded range.
import { uid } from '../core/util.js';
import { songTempoMap } from '../time/tempo-map.js';

export const DEFAULT_XFADE_MS = 10;
const EPS = 1e-6;
const r6 = (x) => +(+x).toFixed(6);

export const takeEnd = (t) => t.start + t.length;

/**
 * Sample seconds an (unwarped) audio clip / take plays at song beat `beat` under tempo map `map`: content beats
 * (offset) count at the tempo of the clip start, then the sample runs at its own speed — exactly how playback treats
 * unwarped clips under a tempo map (src/audio/warp/player.js unwarpedInSeconds).
 */
export const srcSecAt = (map, clip, beat) => (clip.offset || 0) * map.spbAt(clip.start) + map.span(clip.start, beat);
/** Content-beat offset a clip starting at `beat` needs to play the same audio there as `clip` does (see srcSecAt). */
export const offsetAtBeat = (map, clip, beat) => srcSecAt(map, clip, beat) / map.spbAt(beat);
export const hasTakes = (track) => !!track?.takeLanes?.some((l) => l.takes?.length);

/** Every take of a track with its lane: [{ take, lane, laneIndex }]. */
export function allTakes(track) {
  const out = [];
  (track?.takeLanes || []).forEach((lane, laneIndex) => { for (const take of lane.takes || []) out.push({ take, lane, laneIndex }); });
  return out;
}

export function findTake(track, takeId) {
  for (const lane of track?.takeLanes || []) for (const t of lane.takes || []) if (t.id === takeId) return t;
  return null;
}

/** Remove [a, b) from a list of comp segments (segments crossing the range are trimmed / split). */
export function cutRange(segs, a, b) {
  const out = [];
  for (const s of segs) {
    if (s.end <= a + EPS || s.start >= b - EPS) { out.push({ ...s }); continue; }
    if (s.start < a - EPS) out.push({ ...s, end: r6(a) });
    if (s.end > b + EPS) out.push({ ...s, start: r6(b) });
  }
  return out;
}

/**
 * Clean a comp: drop segments of missing takes, clamp each to its take, sort, resolve overlaps (a later
 * segment in the list wins), merge touching segments of the same take. Mutates and returns track.comp.
 */
export function normalizeComp(track) {
  const segs = [];
  for (const s of track.comp || []) {
    const t = findTake(track, s.takeId);
    if (!t) continue;
    const a = Math.max(s.start, t.start), b = Math.min(s.end, takeEnd(t));
    if (b - a <= EPS) continue;
    // later segments win: cut what they cover out of the ones already kept
    const kept = cutRange(segs, a, b);
    segs.length = 0;
    segs.push(...kept, { takeId: s.takeId, start: r6(a), end: r6(b) });
  }
  segs.sort((x, y) => x.start - y.start);
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.takeId === s.takeId && Math.abs(last.end - s.start) < EPS) last.end = s.end;
    else out.push(s);
  }
  track.comp = out;
  return out;
}

/** Swipe-comp: use `takeId` for [a, b) (clamped to the take). Returns the new comp. */
export function setCompRange(track, takeId, a, b) {
  const t = findTake(track, takeId);
  if (!t) return track.comp || [];
  if (b < a) [a, b] = [b, a];
  a = Math.max(a, t.start);
  b = Math.min(b, takeEnd(t));
  if (b - a <= EPS) return track.comp || [];
  track.comp = [...cutRange(track.comp || [], a, b), { takeId, start: r6(a), end: r6(b) }];
  return normalizeComp(track);
}

/** Song range the comp covers ([start, end] or null). */
export function compExtent(track) {
  const c = track?.comp || [];
  if (!c.length) return null;
  return [Math.min(...c.map((s) => s.start)), Math.max(...c.map((s) => s.end))];
}

/** Which take the comp plays at `beat` (null = none). */
export function compTakeAt(track, beat) {
  const s = (track?.comp || []).find((x) => beat >= x.start - EPS && beat < x.end - EPS);
  return s ? s.takeId : null;
}

/** Promote a take: it plays wherever it exists (its whole extent). */
export function promoteTake(track, takeId) {
  const t = findTake(track, takeId);
  if (!t) return track.comp || [];
  return setCompRange(track, takeId, t.start, takeEnd(t));
}

/**
 * Delete a take: its comp segments are given to the newest other take covering them (or become silent),
 * empty lanes are removed, and when no take is left the take model is removed from the track.
 */
export function deleteTake(track, takeId) {
  const lanes = track.takeLanes || [];
  for (const l of lanes) l.takes = (l.takes || []).filter((t) => t.id !== takeId);
  track.takeLanes = lanes.filter((l) => l.takes.length);
  const gone = (track.comp || []).filter((s) => s.takeId === takeId);
  track.comp = (track.comp || []).filter((s) => s.takeId !== takeId);
  // refill the holes with the newest remaining take that covers them
  const takes = allTakes(track).map((x) => x.take).sort((x, y) => (y.pass ?? 0) - (x.pass ?? 0));
  for (const g of gone) {
    for (const t of takes) {
      const a = Math.max(g.start, t.start), b = Math.min(g.end, takeEnd(t));
      if (b - a > EPS) { track.comp.push({ takeId: t.id, start: a, end: b }); break; }
    }
  }
  normalizeComp(track);
  if (!track.takeLanes.length) clearTakes(track);
  return track;
}

export function clearTakes(track) {
  delete track.takeLanes;
  delete track.comp;
  delete track.compXfade;
  return track;
}

/** Put takes into lanes: each take goes to the first lane with room for it, else a new lane. Returns lane ids. */
export function placeTakes(track, takes) {
  if (!Array.isArray(track.takeLanes)) track.takeLanes = [];
  if (!Array.isArray(track.comp)) track.comp = [];
  const ids = [];
  for (const take of takes) {
    let lane = track.takeLanes.find((l) => !(l.takes || []).some((t) => t.start < takeEnd(take) - EPS && takeEnd(t) > take.start + EPS));
    if (!lane) { lane = { id: uid('tln'), takes: [] }; track.takeLanes.push(lane); }
    lane.takes.push(take);
    lane.takes.sort((a, b) => a.start - b.start);
    ids.push(lane.id);
  }
  return ids;
}

/** Highest pass number used on a track (takes are numbered 1, 2, 3… in recording order). */
export const lastPass = (track) => allTakes(track).reduce((m, x) => Math.max(m, x.take.pass || 0), 0);

export function createTake(opts) {
  return {
    id: uid('take'),
    name: opts.name || 'Take',
    ...(opts.sampleId ? { sampleId: opts.sampleId } : {}),
    ...(opts.patternId ? { patternId: opts.patternId } : {}),
    start: r6(opts.start),
    length: r6(opts.length),
    offset: r6(opts.offset || 0),
    ...(opts.gain != null && opts.gain !== 1 ? { gain: opts.gain } : {}),
    ...(opts.srcLength != null ? { srcLength: r6(opts.srcLength) } : {}),
    ...(opts.pass != null ? { pass: opts.pass } : {}),
  };
}

/**
 * Add recorded takes to a track and comp to the newest one for the range they cover. Ordinary clips of the same
 * kind overlapping that range become takes first (lane "Original") so nothing is lost and the comp can swipe back to
 * them — returns the ids of the clips it absorbed (the caller removes them from project.clips).
 *   takes: Take[] (newest last). kind: 'audio' | 'pattern'.
 */
export function addRecordedTakes(project, track, takes, { kind = 'audio' } = {}) {
  if (!takes.length) return { absorbed: [] };
  const lo = Math.min(...takes.map((t) => t.start)), hi = Math.max(...takes.map(takeEnd));
  const absorbed = [];
  let pass = lastPass(track);
  const orig = [];
  for (const c of project.clips) {
    if (c.trackId !== track.id || (kind === 'audio' ? c.type !== 'audio' : c.type === 'audio')) continue;
    if (c.start >= hi - EPS || c.start + c.length <= lo + EPS) continue;
    if (kind === 'audio' && !c.sampleId) continue;
    if (kind !== 'audio' && !project.patterns?.[c.patternId]) continue;
    // fades / gain envelopes / looping pattern clips don't map onto a take: keep those as clips
    if (kind === 'audio' && (c.gainEnv?.length || c.fadeIn > 0 || c.fadeOut > 0)) continue;
    if (kind !== 'audio' && (c.offset || 0) + c.length > project.patterns[c.patternId].length + EPS) continue;
    absorbed.push(c.id);
    orig.push(createTake({
      name: c.name || 'Original', sampleId: c.sampleId, patternId: kind === 'audio' ? null : c.patternId,
      start: c.start, length: c.length, offset: c.offset || 0, gain: c.gain ?? 1, pass: ++pass,
    }));
  }
  if (orig.length) {
    placeTakes(track, orig);
    for (const t of orig) track.comp.push({ takeId: t.id, start: t.start, end: takeEnd(t) });
  }
  for (const t of takes) if (t.pass == null) t.pass = ++pass;
  placeTakes(track, takes);
  // the newest pass wins its range; earlier passes of this recording keep the parts the newest doesn't cover
  for (const t of takes) track.comp = [...cutRange(track.comp || [], t.start, takeEnd(t)), { takeId: t.id, start: t.start, end: takeEnd(t) }];
  normalizeComp(track);
  return { absorbed };
}

/**
 * The comp as virtual clips (what the scheduler plays). Audio segments that touch get an equal-power crossfade of
 * `track.compXfade` ms centred on the boundary, using the takes' handles (audio before / after the segment) where the
 * source has it; at the edge of the recorded audio the fade shrinks to what exists.
 */
export function compClips(project, track) {
  const segs = track?.comp;
  if (!segs?.length || !track.takeLanes?.length) return [];
  const map = songTempoMap(project);
  const tm = map.isConstant ? null : map; // tempo map: audio offsets / crossfades through it (see srcSecAt)
  const spb = 60 / (project.bpm || 120);
  const ms = Math.max(0, Number(track.compXfade ?? DEFAULT_XFADE_MS) || 0) / 1000;
  const xf = ms / spb; // beats
  const half = xf / 2;
  const items = [];
  for (const s of segs) {
    const take = findTake(track, s.takeId);
    if (!take || s.end - s.start <= EPS) continue;
    items.push({ s, take, audio: !!take.sampleId });
  }
  items.sort((a, b) => a.s.start - b.s.start);
  // per boundary i|i+1: how far the crossfade can reach left (h1, into the earlier part: the next take's handle) and
  // right (h2, the previous take's handle after its segment)
  const lead = new Array(items.length).fill(0); // extension before the segment start
  const tail = new Array(items.length).fill(0); // extension after the segment end
  for (let i = 0; i + 1 < items.length; i++) {
    const A = items[i], B = items[i + 1];
    if (!A.audio || !B.audio || Math.abs(A.s.end - B.s.start) > EPS || half <= 0) continue;
    let hf, bOff, aRest;
    if (tm) {
      // seconds -> beats at the tempo of the boundary (the fade is a few ms long)
      const sp = tm.spbAt(B.s.start);
      hf = ms / 2 / sp;
      bOff = srcSecAt(tm, B.take, B.s.start) / sp;
      aRest = A.take.srcLength == null ? Infinity : (A.take.srcLength * tm.spbAt(A.take.start) - srcSecAt(tm, A.take, A.s.end)) / sp;
    } else {
      hf = half;
      bOff = B.take.offset + (B.s.start - B.take.start); // where B's segment starts in its source
      const aEndOff = A.take.offset + (A.s.end - A.take.start);
      const aSrc = A.take.srcLength ?? Infinity;
      aRest = aSrc - aEndOff;
    }
    const h1 = Math.max(0, Math.min(hf, bOff, A.s.end - A.s.start - EPS, B.s.end - B.s.start - EPS));
    const h2 = Math.max(0, Math.min(hf, aRest, B.s.end - B.s.start - EPS));
    lead[i + 1] = h1;
    tail[i] = h2;
  }
  const out = [];
  items.forEach(({ s, take, audio }, i) => {
    const start = s.start - lead[i];
    const end = s.end + tail[i];
    const clip = {
      id: `comp:${track.id}:${i}`, trackId: track.id, type: audio ? 'audio' : 'pattern',
      sampleId: take.sampleId || null, patternId: take.patternId || null,
      start: start, length: end - start, offset: audio && tm ? offsetAtBeat(tm, take, start) : take.offset + (start - take.start),
      gain: take.gain ?? 1, name: take.name, comp: true, takeId: take.id, compStart: s.start, compEnd: s.end,
    };
    if (audio) {
      const fi = lead[i] + (i > 0 ? tail[i - 1] : 0);
      const fo = tail[i] + (i + 1 < items.length ? lead[i + 1] : 0);
      if (fi > EPS) { clip.fadeIn = fi; clip.fadeInShape = 'eqp'; }
      if (fo > EPS) { clip.fadeOut = fo; clip.fadeOutShape = 'eqp'; }
    }
    out.push(clip);
  });
  return out;
}

// ------------------------------------------------------------------------------------------- recording passes
/**
 * Split one continuous recording into passes (takes).
 *   u0, u1: the recording's first / last position on the *unwrapped* song timeline (beats; the transport position as
 *           if the loop never wrapped). The captured audio starts at u0 (offset 0).
 *   loop:   {enabled, start, end} — cycle recording when enabled and u0 < loop.end
 *   punch:  {enabled, start, end} — only the punch range of each pass is kept
 *   minLen: drop (partial) passes shorter than this (beats) unless nothing else is left
 *   origin: unwrapped beat of the first captured sample (pre-roll / count-in audio before u0 is kept as a handle);
 *           offsets are measured from it. Default u0.
 * Returns [{ pass, start, end, offset }]: song beats + offset (beats) into the recording.
 */
export function computePasses({ u0, u1, loop = null, punch = null, minLen = 0.5, origin = u0 }) {
  const raw = [];
  const cyc = loop?.enabled && loop.end - loop.start >= 0.25 && u0 < loop.end - EPS;
  if (!cyc) {
    raw.push({ start: u0, end: u1, offset: 0 });
  } else {
    const L0 = loop.start, L1 = loop.end, len = L1 - L0;
    raw.push({ start: u0, end: Math.min(u1, L1), offset: 0 });
    for (let k = 1; L1 + (k - 1) * len < u1 - EPS; k++) {
      const ua = L1 + (k - 1) * len;
      const ub = Math.min(u1, ua + len);
      raw.push({ start: L0, end: L0 + (ub - ua), offset: ua - u0 });
    }
  }
  let passes = raw.map((p, i) => ({ pass: i, ...p, offset: p.offset + (u0 - origin) }));
  if (punch?.enabled && punch.end > punch.start) {
    passes = passes.map((p) => {
      const a = Math.max(p.start, punch.start), b = Math.min(p.end, punch.end);
      return { ...p, offset: p.offset + (a - p.start), start: a, end: b };
    });
  }
  passes = passes.filter((p) => p.end - p.start > EPS);
  const long = passes.filter((p) => p.end - p.start >= minLen - EPS);
  const keep = long.length ? long : passes.slice(-1);
  return keep.map((p) => ({ pass: p.pass, start: r6(p.start), end: r6(p.end), offset: r6(p.offset) }));
}
