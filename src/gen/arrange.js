// Arrangement planning (pure): section kinds and harmonic types, orchestration (who plays where — not everything
// all the time), per-section progressions (verse / chorus / pre-chorus tension / bridge contrast) and automation.
import { createRng } from '../core/util.js';
import { getProgression, romanToChord, scalePitchClasses, chordPitchClasses, SCALES } from '../theory/index.js';
import { createAutomationLane } from '../core/automation.js';
import { pickGenreProgression } from './harmony.js';
import { sectionKind } from './form.js';

export { sectionKind };

/** Harmonic type of a section: which progression it uses. */
export function sectionType(name = '') {
  const n = name.toLowerCase();
  if (/pre/.test(n)) return 'pre';
  if (/bridge/.test(n)) return 'bridge';
  const k = sectionKind(name);
  if (k === 'main') return 'chorus';
  if (k === 'verse') return 'verse';
  return k; // intro / outro / build / break
}

const MELODIC = ['bass', 'chords', 'pad', 'lead', 'arp'];

/**
 * Expand the genre structure into section instances with orchestration applied.
 * -> [{name, label, kind, type, bars, energy, roles:[...], occurrence, index, start (beats)}]
 * Rules: first verse is sparse (no pad / arp), later verses add a layer; the first chorus holds back the arp when a
 * lead sings (the last chorus lifts with everything); at most 5 melodic layers; fx only on transitions.
 */
export function planSections(genre, { bpb = 4, available, structure, evolve = true } = {}) {
  const counts = {};
  const typeCounts = {};
  let beat = 0;
  const out = (structure || genre.structure).map((s, index) => {
    counts[s.name] = (counts[s.name] || 0) + 1;
    const kind = sectionKind(s.name);
    const type = sectionType(s.name);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    const sec = {
      name: s.name, label: counts[s.name] > 1 ? `${s.name} ${counts[s.name]}` : s.name, kind, type, bars: s.bars, energy: s.energy,
      roles: s.roles.filter((r) => !available || available.has(r)), occurrence: typeCounts[type], index, start: beat,
    };
    beat += s.bars * bpb;
    return sec;
  });
  const lastOfType = {};
  for (const s of out) lastOfType[s.type] = s.occurrence;
  for (const s of out) {
    const has = (r) => s.roles.includes(r);
    const drop = (r) => { s.roles = s.roles.filter((x) => x !== r); };
    if (s.kind === 'verse') {
      if (s.occurrence === 1) { if (has('pad') && has('chords')) drop('pad'); if (has('arp') && has('lead')) drop('arp'); }
      if (has('fx')) drop('fx');
    }
    if (s.kind === 'main') {
      const final = s.occurrence === lastOfType[s.type];
      if (!final && has('arp') && has('lead') && s.roles.filter((r) => MELODIC.includes(r)).length > 4) drop('arp');
    }
    // at most five melodic layers at once
    while (s.roles.filter((r) => MELODIC.includes(r)).length > 5) drop(['arp', 'pad'].find(has));
    if (s.kind === 'outro' && has('lead')) drop('lead');
  }
  // long sections evolve: in a repeated (or 32-bar) groove / drop a held-back layer enters halfway (s.enter)
  if (evolve) {
    for (const s of out) {
      if (s.bars < 16 || !(s.kind === 'verse' || s.kind === 'main') || (s.occurrence < 2 && s.bars < 32)) continue;
      if (s.roles.filter((r) => MELODIC.includes(r)).length >= 5) continue;
      const role = ['arp', 'pad', 'chords'].find((r) => !s.roles.includes(r) && (!available || available.has(r)));
      if (role) s.enter = [role];
    }
  }
  for (let i = 0; i < out.length; i++) { out[i].prev = out[i - 1] || null; out[i].next = out[i + 1] || null; }
  return out;
}

// ---------------------------------------------------------------------------------------------- harmony per section

const SINGLE_FORM = new Set(['blues', 'jazz', 'ambient', 'techno', 'minimal', 'psytrance', 'idm', 'glitch', 'drone']);

function diatonicOk(romans, root, scale) {
  if ((SCALES[scale]?.intervals?.length || 0) !== 7) return false;
  const set = new Set(scalePitchClasses(root, scale));
  return romans.every((r) => {
    const c = romanToChord(r, root, scale);
    return c && chordPitchClasses(c.root, c.type).slice(0, 3).every((pc) => set.has(pc) || /^b/.test(r));
  });
}

/** Tension progressions for pre-choruses: they end on the dominant / bVII so the chorus lands. */
function preRomans(scale) {
  switch (scale) {
    case 'major': case 'lydian': return [['IV', 'IV', 'V', 'V'], ['ii', 'ii', 'IV', 'V'], ['vi', 'vi', 'IV', 'V']];
    case 'mixolydian': return [['IV', 'IV', 'bVII', 'bVII']];
    case 'minor': return [['bVI', 'bVI', 'bVII', 'bVII'], ['iv', 'iv', 'bVI', 'bVII']];
    case 'harmonic-minor': return [['iv', 'iv', 'V', 'V'], ['bVI', 'bVI', 'V', 'V']];
    case 'dorian': return [['IV', 'IV', 'bVII', 'bVII']];
    case 'phrygian': return [['bVI', 'bVI', 'bII', 'bII']];
    default: return [];
  }
}

const rotate = (arr, k) => arr.map((_, i) => arr[(i + k) % arr.length]);

/**
 * Choose the progression (romans / library id) for each section type.
 * -> {chorus, verse, pre, bridge, intro, outro, build, break} values: progression id | romans[] (null = chorus)
 */
export function planSectionHarmony({ genre, root, scale, rng = createRng(1), main, sections }) {
  const types = new Set(sections.map((s) => s.type));
  const plan = { chorus: main };
  const songForm = types.has('verse') && types.has('chorus') && !SINGLE_FORM.has(genre.id) && !SINGLE_FORM.has(genre.family);
  const mainRomans = getProgression(main)?.romans || null;
  if (songForm && mainRomans) {
    // verse: another of the genre's progressions when there is one, else the chorus loop rotated (different first chord)
    const alt = pickGenreProgression({ genre: genre.id, scale, rng: createRng(Math.floor(rng() * 1e9)) });
    const altR = alt && getProgression(alt.id || alt.romans);
    if (altR && altR.romans.join() !== mainRomans.join() && !getProgression(main)?.durs && !altR.durs) plan.verse = alt.id || altR.romans;
    else if (mainRomans.length >= 3 && !getProgression(main)?.durs) plan.verse = rotate(mainRomans, mainRomans.length === 4 ? 2 : 1);
    if (types.has('pre')) {
      const cands = preRomans(scale).filter((r) => diatonicOk(r, root, scale));
      if (cands.length) plan.pre = rng.pick(cands);
    }
    if (types.has('bridge') && mainRomans.length >= 3 && !getProgression(main)?.durs) {
      const r = rotate(mainRomans, mainRomans.length === 4 ? 3 : 2);
      plan.bridge = r.join() === (Array.isArray(plan.verse) ? plan.verse.join() : '') ? rotate(mainRomans, 1) : r;
    }
    plan.intro = plan.verse || main;
    plan.outro = main;
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------- automation

/** Points of a low-pass sweep: closed `from` Hz at beat `a` -> open `to` at `b`, fully open (20 kHz) around it. */
export function filterSweepPoints(a, b, from = 600, to = 18000) {
  return [
    { beat: Math.max(0, a - 0.01), value: 20000 }, { beat: a, value: from },
    { beat: a + (b - a) * 0.6, value: Math.round(Math.sqrt(from * to)) }, { beat: b - 0.01, value: to }, { beat: b, value: 20000 },
  ];
}

/** Points of a volume swell v0 -> v1 over [a, b], `rest` (the fader value) around it. */
export function volumeSwellPoints(a, b, v0, v1, rest) {
  return [{ beat: Math.max(0, a - 0.01), value: rest }, { beat: a, value: v0 }, { beat: b - 0.01, value: v1 }, { beat: b, value: rest }];
}

/** Collects automation points per target and turns them into lanes (one lane per target, sorted). */
export class AutomationBuilder {
  constructor() { this.map = new Map(); }
  add(target, points) { if (!this.map.has(target)) this.map.set(target, []); this.map.get(target).push(...points); }
  lanes() {
    return [...this.map.entries()].map(([target, pts]) => {
      const sorted = pts.slice().sort((a, b) => a.beat - b.beat);
      const dedup = sorted.filter((p, i) => !(sorted[i + 1] && Math.abs(sorted[i + 1].beat - p.beat) < 1e-6 && sorted[i + 1].value === p.value));
      return createAutomationLane(target, dedup);
    });
  }
}
