// Song form (pure, no imports): section kinds and fitting a genre's arrangement template to a target length.
// Used by genres.js (every genre's standard form hits its realistic length at the default tempo), by generateSong's
// `length` / `targetMinutes` options and by the song-wizard preview.

/** Map a section name to an arrangement function. */
export function sectionKind(name = '') {
  const n = name.toLowerCase();
  if (/intro/.test(n)) return 'intro';
  if (/outro|fade out|ending/.test(n)) return 'outro';
  if (/build|pre|rise|lift/.test(n)) return 'build';
  if (/break|bridge|reflection|fade|calm/.test(n)) return 'break';
  if (/drop|chorus|hook|peak|climax|finale|bloom|^b$|solo|montuno|mambo/.test(n)) return 'main';
  return 'verse';
}

/** Length presets: factor of the genre's standard minutes. 'club' = DJ edit (long intro / outro) for dance genres. */
export const LENGTH_PRESETS = {
  short: { label: 'Short', factor: 0.6 },
  standard: { label: 'Standard', factor: 1 },
  extended: { label: 'Extended', factor: 1.4 },
  club: { label: 'Club / DJ edit', factor: 1.15 },
};

const DANCE_FAMILIES = new Set(['house', 'techno', 'trance', 'bass', 'dnb', 'garage', 'breaks', 'hard', 'industrial']);
/** Genres whose records are mixed by DJs (long intros / outros make sense). */
export const isDanceGenre = (g) => !!g && (DANCE_FAMILIES.has(g.family) || ['nu-disco', 'disco', 'amapiano', 'eurobeat', 'footwork'].includes(g.id));

export const structureBars = (structure) => structure.reduce((a, s) => a + s.bars, 0);
const copy = (s) => ({ ...s, roles: [...s.roles] });
const kindOf = (s) => sectionKind(s.name);

/** The block a song repeats when it grows: last verse-like section up to the next main section, else the last main. */
function repeatBlock(st) {
  const mains = st.map((s, i) => (kindOf(s) === 'main' ? i : -1)).filter((i) => i >= 0);
  if (!mains.length) return null;
  const lastMain = mains[mains.length - 1];
  // the run after the main before a later main (EDM: Groove/Breakdown/Build/Drop, pop: Verse/Pre/Chorus); a
  // bridge -> chorus run is not what a song repeats, a lone repeated main (jazz / blues solos) is the fallback
  for (let m = mains.length - 1; m >= 1; m--) {
    const end = mains[m];
    const start = mains[m - 1] + 1;
    if (start >= end) continue;
    const block = st.slice(start, end + 1);
    const body = block.filter((s) => kindOf(s) === 'verse' || (kindOf(s) === 'break' && !/bridge/i.test(s.name)));
    if (body.length && !block.some((s) => kindOf(s) === 'intro' || kindOf(s) === 'outro')) return { start, end, at: end + 1 };
  }
  return { start: lastMain, end: lastMain, at: lastMain + 1 };
}

/** Candidate structures one edit away (grow or shrink), each tagged with a small preference penalty. */
function neighbours(st, grow, lock) {
  const out = [];
  const total = structureBars(st);
  const locked = (i) => lock && (i < lock.head || i >= st.length - lock.tail);
  if (grow) {
    const b = repeatBlock(st);
    if (b) {
      const block = st.slice(b.start, b.end + 1).map(copy);
      // insert before the trailing non-main tail (outro / reflections stay at the end)
      let at = b.at;
      if (lock) at = Math.min(at, st.length - lock.tail);
      out.push({ st: [...st.slice(0, at), ...block, ...st.slice(at)], pen: 0 });
    }
    const kindBars = (k) => structureBars(st.filter((x) => kindOf(x) === k));
    st.forEach((s, i) => {
      if (locked(i)) return;
      const k = kindOf(s);
      if (s.bars % 4 !== 0 || s.bars >= 32) return;
      // intros / outros grow only up to a 16-bar total (longer DJ intros are the 'club' edit)
      if (k === 'main' || k === 'break' || ((k === 'intro' || k === 'outro') && kindBars(k) + s.bars <= 16)) {
        const nb = Math.min(32, s.bars * 2);
        out.push({ st: st.map((x, j) => (j === i ? { ...copy(x), bars: nb } : x)), pen: k === 'main' ? 0.02 : 0.04 });
      }
    });
  } else {
    // remove a repeated block (a non-first verse/pre/chorus unit, an extra breakdown/build/drop)
    const mains = st.map((s, i) => (kindOf(s) === 'main' ? i : -1)).filter((i) => i >= 0);
    for (let m = 1; m < mains.length; m++) {
      const end = mains[m];
      let start = end;
      for (let i = end - 1; i > mains[m - 1]; i--) start = i;
      if (locked(start) || locked(end)) continue;
      const names = new Set(st.slice(0, start).map((s) => s.name));
      if (!st.slice(start, end + 1).every((s) => names.has(s.name))) continue;
      const next = [...st.slice(0, start), ...st.slice(end + 1)];
      if (next.length >= 4) out.push({ st: next, pen: 0.03 });
    }
    // remove a single repeated section (a second groove / switch): never the first one, never intros / outros
    st.forEach((s, i) => {
      const k = kindOf(s);
      if (locked(i) || k === 'main' || k === 'intro' || k === 'outro') return;
      const dup = st.some((x, j) => j < i && x.name === s.name);
      if (!dup || st.length <= 4 || /verse|^a$/i.test(s.name) || st[i - 1]?.name === st[i + 1]?.name) return;
      out.push({ st: st.filter((_, j) => j !== i), pen: 0.03 });
    });
    // halve a long section (keeps 4/8-bar phrasing)
    st.forEach((s, i) => {
      if (locked(i) || s.bars < 8 || s.bars % 8 !== 0) return;
      const k = kindOf(s);
      if ((k === 'main' || k === 'verse') && s.bars < 16) return;
      out.push({ st: st.map((x, j) => (j === i ? { ...copy(x), bars: x.bars / 2 } : x)), pen: k === 'main' ? 0.05 : 0.02 });
    });
  }
  return out.filter((c) => c.st.some((s) => kindOf(s) === 'main') && structureBars(c.st) !== total);
}

/**
 * Fit a structure to `targetBars` by repeating / removing idiomatic blocks and lengthening / halving sections.
 * opts: {tolerance (fraction, default 0.07), lock: {head, tail} (sections at the ends to leave alone)}
 * -> new structure (sections copied)
 */
export function fitStructure(structure, targetBars, opts = {}) {
  let st = structure.map(copy);
  if (!(targetBars > 0)) return st;
  const tol = opts.tolerance ?? 0.07;
  const err = (s) => Math.abs(structureBars(s) - targetBars) / targetBars;
  for (let guard = 0; guard < 40 && err(st) > tol / 2; guard++) {
    const grow = structureBars(st) < targetBars;
    const cands = neighbours(st, grow, opts.lock);
    if (!cands.length) break;
    let best = null;
    for (const c of cands) {
      const score = err(c.st) + c.pen;
      if (!best || score < best.score) best = { ...c, score };
    }
    if (err(best.st) >= err(st) - 1e-9) break;
    st = best.st;
  }
  return st;
}

/** DJ edit: at least 32 bars of intro (starting drums-only) and 32 bars of outro (ending drums-only). */
export function clubStructure(structure) {
  const st = structure.map(copy);
  let head = 0;
  while (head < st.length && kindOf(st[head]) === 'intro') head++;
  const introBars = structureBars(st.slice(0, head));
  if (introBars < 32) { st.unshift({ name: 'Intro', bars: 32 - introBars, energy: 0.3, roles: ['drums'] }); head++; }
  let tail = 0;
  while (tail < st.length && kindOf(st[st.length - 1 - tail]) === 'outro') tail++;
  const outroBars = structureBars(st.slice(st.length - tail));
  if (outroBars < 32) { st.push({ name: 'Outro', bars: 32 - outroBars, energy: 0.25, roles: ['drums'] }); tail++; }
  return { structure: st, lock: { head, tail } };
}

const barsFor = (minutes, bpm, bpb) => (minutes * bpm) / bpb;

/**
 * The structure a song of `genre` is generated with.
 * opts: {length: 'short'|'standard'|'extended'|'club', targetMinutes, bpm}
 * Standard length at (about) the default tempo is the genre's own form; other tempos / lengths are fitted.
 */
export function resolveStructure(genre, opts = {}) {
  const bpm = opts.bpm || genre.defaultBpm;
  const bpb = (genre.timeSig?.[0] || 4) * (4 / (genre.timeSig?.[1] || 4));
  const preset = LENGTH_PRESETS[opts.length] ? opts.length : 'standard';
  const base = genre.structure;
  const stdMinutes = genre.minutes || (structureBars(base) * bpb) / genre.defaultBpm;
  if (preset === 'club' && opts.targetMinutes == null) {
    if (!isDanceGenre(genre)) return resolveStructure(genre, { ...opts, length: 'extended' });
    const fitted = fitStructure(base, barsFor(stdMinutes * LENGTH_PRESETS.club.factor, bpm, bpb));
    return clubStructure(fitted).structure;
  }
  const minutes = opts.targetMinutes > 0 ? opts.targetMinutes : stdMinutes * LENGTH_PRESETS[preset].factor;
  if (preset === 'standard' && opts.targetMinutes == null && Math.abs(bpm - genre.defaultBpm) < 1e-6) return base.map(copy);
  return fitStructure(base, barsFor(minutes, bpm, bpb));
}

/** Preview of a generated song's length: {bars, beats, minutes, sections}. */
export function planSongLength(genre, opts = {}) {
  const st = resolveStructure(genre, opts);
  const bpm = opts.bpm || genre.defaultBpm;
  const bpb = (genre.timeSig?.[0] || 4) * (4 / (genre.timeSig?.[1] || 4));
  const bars = structureBars(st);
  return { bars, beats: bars * bpb, minutes: (bars * bpb) / bpm, sections: st.length, structure: st };
}

/** "3:25" */
export function formatMinutes(min) {
  const s = Math.max(0, Math.round(min * 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
