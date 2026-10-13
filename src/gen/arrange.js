// Arrangement planning (pure): section kinds and harmonic types, orchestration (who plays where — not everything
// all the time), per-section progressions (verse / chorus / pre-chorus tension / bridge contrast) and automation.
import { createRng } from '../core/util.js';
import { getProgression, romanToChord, scalePitchClasses, chordPitchClasses, SCALES, heptatonicParent } from '../theory/index.js';
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

/** Genres where a running arpeggio is the idiom (it may carry whole sections); elsewhere an arp is a seasoning. */
export const ARP_HOME = new Set(['trance', 'progressive-house', 'synthwave', 'outrun', 'eurobeat', 'chiptune']);

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
    // arp budget: outside its home genres the arp only lifts builds and the last chorus (and never fights a lead there);
    // even at home it sits out intros, outros and the first verse
    if (has('arp')) {
      const home = ARP_HOME.has(genre.id);
      const finalMain = s.kind === 'main' && s.occurrence === lastOfType[s.type];
      // at home: builds, breakdowns without a lead, every other groove, and only the last drop when a lead sings
      const keep = home ? s.kind === 'build' || (s.kind === 'break' && !has('lead')) || (s.kind === 'verse' && s.occurrence % 2 === 0)
          || (s.kind === 'main' && (finalMain || !has('lead')))
        : s.kind === 'build' || (finalMain && !has('lead'));
      if (!keep) drop('arp');
    }
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
      const role = (ARP_HOME.has(genre.id) ? ['arp', 'pad', 'chords'] : ['pad', 'chords']).find((r) => !s.roles.includes(r) && (!available || available.has(r)));
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

// ---- drone / vamp genres: section-level movement over the pedal ('T' = the tonic, i or I by the scale's 3rd).
// Romans are one bar each (repeats = a longer chord); accidentals are relative to the major scale. Each section type
// lists candidates; the ones that fit the song's scale best (fewest borrowed chords) are chosen from.
const DRONE_PLANS = {
  // psytrance: the rolling pedal on i, phrygian bII tension, bVI–bVII lifts in builds / peaks, a relative-major
  // (bIII) shift in the breakdown with a modal-mixture IV
  psy: {
    intro: [['T', 'T', 'T', 'T', 'T', 'T', 'T', 'bII'], ['T', 'T', 'T', 'T', 'T', 'T', 'bvii', 'T']],
    verse: [['T', 'T', 'T', 'T', 'T', 'T', 'bII', 'bII'], ['T', 'T', 'T', 'T', 'bVII', 'bVII', 'bII', 'T'], ['T', 'T', 'T', 'T', 'T', 'T', 'bVI', 'bVII'],
      ['T', 'T', 'T', 'T', 'iv', 'iv', 'bII', 'T']],
    build: [['bVI', 'bVI', 'bVII', 'bVII'], ['iv', 'iv', 'bVI', 'bVII'], ['bII', 'bII', 'bVII', 'bVII'], ['iv', 'iv', 'bII', 'bII']],
    chorus: [['T', 'T', 'T', 'T', 'bVI', 'bVII', 'T', 'bII'], ['T', 'T', 'bII', 'T', 'T', 'T', 'bVI', 'bVII'], ['T', 'T', 'T', 'bII', 'bVI', 'bVI', 'bVII', 'bVII'],
      ['T', 'T', 'T', 'T', 'iv', 'iv', 'bII', 'T']],
    break: [['bVI', 'bVI', 'bIII', 'bIII', 'bVII', 'bVII', 'T', 'T'], ['iv', 'iv', 'bVI', 'bVI', 'bIII', 'bIII', 'bVII', 'bVII'],
      ['bVI', 'bVI', 'bVII', 'bVII', 'IV', 'IV', 'T', 'T'], ['iv', 'iv', 'bII', 'bII', 'bvii', 'bvii', 'T', 'T']],
    outro: [['T', 'T', 'T', 'T', 'T', 'T', 'bII', 'T'], ['T', 'T', 'T', 'T', 'T', 'T', 'bVII', 'T']],
  },
  // techno / minimal / tech house: long i with a whole-step (bVII) or iv shift; stabs move between them
  techno: {
    intro: [['T', 'T', 'T', 'T', 'T', 'T', 'T', 'bVII'], ['T', 'T', 'T', 'T', 'T', 'T', 'iv', 'T']],
    verse: [['T', 'T', 'T', 'T', 'T', 'T', 'bVII', 'bVII'], ['T', 'T', 'T', 'T', 'bVI', 'bVI', 'bVII', 'bVII'], ['T', 'T', 'iv', 'iv', 'T', 'T', 'bVII', 'bVII'],
      ['T', 'T', 'T', 'T', 'IV', 'IV', 'T', 'T']],
    build: [['bVI', 'bVI', 'bVII', 'bVII'], ['iv', 'iv', 'bVII', 'bVII'], ['IV', 'IV', 'bVII', 'bVII']],
    chorus: [['T', 'T', 'bVII', 'bVII', 'bVI', 'bVI', 'bVII', 'bVII'], ['T', 'T', 'T', 'T', 'bVI', 'bVII', 'T', 'T'], ['T', 'T', 'iv', 'iv', 'bVI', 'bVI', 'bVII', 'bVII'],
      ['T', 'T', 'T', 'T', 'IV', 'IV', 'bVII', 'bVII']],
    break: [['bVI', 'bVI', 'bIII', 'bIII', 'bVII', 'bVII', 'iv', 'iv'], ['bIII', 'bIII', 'bVII', 'bVII', 'bVI', 'bVI', 'bVII', 'bVII'],
      ['IV', 'IV', 'bVII', 'bVII', 'T', 'T', 'IV', 'IV']],
    outro: [['T', 'T', 'T', 'T', 'T', 'T', 'bVII', 'T'], ['T', 'T', 'T', 'T', 'T', 'T', 'iv', 'T']],
  },
  // ambient: slow (2-bar) drifts between I and its neighbours
  ambient: {
    intro: [['T', 'T', 'T', 'T', 'IV', 'IV', 'IV', 'IV'], ['T', 'T', 'T', 'T', 'II', 'II', 'II', 'II']],
    break: [['vi', 'vi', 'IV', 'IV', 'T', 'T', 'V', 'V'], ['IV', 'IV', 'vi', 'vi', 'II', 'II', 'T', 'T'], ['bVI', 'bVI', 'bVII', 'bVII', 'T', 'T', 'T', 'T']],
    outro: [['T', 'T', 'T', 'T', 'IV', 'IV', 'T', 'T']],
  },
};
const DRONE_GENRES = { psytrance: 'psy', techno: 'techno', minimal: 'techno', 'tech-house': 'techno', ambient: 'ambient' };

/** Contrasting (lift) progressions for vamp songs: the verse keeps the vamp, the chorus / bridge move. */
const LIFTS = [
  ['iv', 'iv', 'bVII', 'bVII'], ['bVI', 'bVII', 'T', 'T'], ['bIII', 'bIII', 'IV', 'IV'], ['bVI', 'bVI', 'bVII', 'bVII'], ['IV', 'IV', 'bVII', 'bVII'],
  ['IV', 'IV', 'V', 'V'], ['vi', 'vi', 'IV', 'V'], ['IV', 'IV', 'T', 'T'], ['ii', 'ii', 'IV', 'IV'], ['bVII', 'bVII', 'IV', 'IV'], ['vi', 'vi', 'ii', 'V'],
  ['bVI', 'bVI', 'iv', 'iv'], ['ii', 'ii', 'V', 'V'], ['iii', 'iii', 'vi', 'vi'],
];

const triadPcs = (c) => chordPitchClasses(c.root, c.type).slice(0, 3);
const tonicRoman = (scale) => (scalePitchClasses(0, heptatonicParent(scale)).includes(3) && !scalePitchClasses(0, heptatonicParent(scale)).includes(4) ? 'i' : 'I');

/** Resolve 'T' and (optionally) add the main progression's 7th colour to plain romans; null when a roman is invalid. */
function resolvePlan(romans, root, scale, sevenths) {
  const T = tonicRoman(scale);
  const set = new Set(scalePitchClasses(root, heptatonicParent(scale)));
  const out = romans.map((r) => {
    const base = r === 'T' ? T : r;
    if (!sevenths || /\d|sus|maj|°|ø|\+/.test(base)) return base;
    // a major chord only becomes a dominant 7th on the dominant (V7); IV7 / bVII7 / bVI7 are blues / funk vocabulary,
    // not minor house / pop: those take maj7 when it is in the key, else stay triads (colorChord adds a 9th)
    const tri = romanToChord(base, root, scale);
    const dominant = tri && tri.type === 'maj' && (tri.root - root + 12) % 12 === 7;
    const exts = tri && tri.type === 'maj' ? (dominant ? ['7'] : ['maj7']) : ['7', 'maj7'];
    for (const ext of exts) {
      const c = romanToChord(base + ext, root, scale);
      if (c && chordPitchClasses(c.root, c.type).every((pc) => set.has(pc))) return base + ext;
    }
    return base;
  });
  return out.every((r) => romanToChord(r, root, scale)) ? out : null;
}

/** How many distinct romans of a plan are borrowed (triad outside the scale) — lower fits better. */
function borrowedCount(romans, root, scale) {
  const set = new Set(scalePitchClasses(root, heptatonicParent(scale)));
  return new Set(romans.filter((r) => { const c = romanToChord(r, root, scale); return !c || !triadPcs(c).every((pc) => set.has(pc)); })).size;
}

/** Pick one of the candidate plans that fits the scale best (ties broken by rng). */
function pickPlan(cands, { root, scale, rng, sevenths = false, avoid = [], strict = false }) {
  const resolved = cands.map((c) => resolvePlan(c, root, scale, sevenths)).filter(Boolean)
    .filter((r) => !avoid.some((a) => a && a.join() === r.join()));
  if (!resolved.length) return null;
  const scored = resolved.map((r) => ({ r, s: borrowedCount(r, root, scale) }));
  const best = Math.min(...scored.map((x) => x.s));
  // allow one more borrowed chord than the best fit (the bII / bVII colours are the idiom), never more than two
  // (strict — club genres: only the best-fitting plans; a borrowed major IV / V in minor house reads as funk / pop)
  const pool = scored.filter((x) => x.s <= (strict ? best : Math.min(best + 1, Math.max(best, 2))));
  return rng.pick(pool).r;
}

/** Distinct chord roots of a set of progression specs (ids / romans arrays). */
export function planRoots(specs, root, scale) {
  const roots = new Set();
  for (const sp of specs) {
    const p = sp && getProgression(sp);
    for (const r of p?.romans || []) { const c = romanToChord(r, root, scale); if (c) roots.add(c.root); }
  }
  return roots;
}

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
  const sevenths = !!mainRomans?.length && mainRomans.every((r) => /\d/.test(r.replace(/^[b#]*[ivIV]+/, '')));
  const same = (a, b) => {
    const ra = a && getProgression(a)?.romans, rb = b && getProgression(b)?.romans;
    return !!ra && !!rb && [...new Set(ra)].sort().join() === [...new Set(rb)].sort().join();
  };
  // drone / vamp genres: the pedal stays, but every section type gets its own movement (and the drop / peak loop too)
  // (a one-chord loop in a non-song form — e.g. glitch on the techno drone — gets the techno plan too)
  const droneId = DRONE_GENRES[genre.id] || (!songForm && mainRomans && new Set(mainRomans).size === 1 ? 'techno' : null);
  if (droneId) {
    const fam = DRONE_PLANS[droneId];
    for (const type of types) {
      if (!fam[type]) continue;
      const p = pickPlan(fam[type], { root, scale, rng });
      if (p) plan[type] = p;
    }
    if (fam.chorus && plan.chorus !== main) plan.main = plan.chorus;
  } else if (songForm && mainRomans && new Set(mainRomans).size <= 2 && (!plan.verse || same(plan.verse, main))) {
    // a two-chord vamp: the verse grooves on it, the chorus lifts somewhere new, the bridge somewhere else again
    const strict = ['house', 'techno', 'trance'].includes(genre.family);
    const lift = pickPlan(LIFTS.filter((l) => l.some((r) => !mainRomans.includes(r))), { root, scale, rng, sevenths, avoid: [mainRomans], strict });
    if (lift && planRoots([lift], root, scale).size >= 2) {
      plan.verse = main;
      plan.intro = main;
      plan.chorus = lift;
      plan.main = lift;
      plan.outro = lift;
      if (types.has('bridge')) plan.bridge = pickPlan(LIFTS, { root, scale, rng, sevenths, avoid: [mainRomans, lift] }) || plan.bridge;
    }
  }
  // songs: the bridge never just repeats the chorus or the verse
  if (songForm && types.has('bridge') && plan.bridge && (same(plan.bridge, plan.main || main) || same(plan.bridge, plan.verse))) {
    const alt = pickPlan(LIFTS, { root, scale, rng, sevenths, avoid: [mainRomans, getProgression(plan.verse || main)?.romans] });
    if (alt && !same(alt, plan.main || main) && !same(alt, plan.verse)) plan.bridge = alt;
  }
  // nothing sits on one chord for a whole song: at least two chord roots across the sections
  const specs = () => [plan.main || main, ...[...types].map((t) => plan[t] || plan.main || main)];
  if (planRoots(specs(), root, scale).size < 2) {
    const fam = DRONE_PLANS.techno;
    const targets = ['verse', 'break', 'build', 'bridge', 'pre'].filter((t) => types.has(t));
    for (const type of targets) {
      const p = pickPlan(songForm || !fam[type] ? LIFTS : fam[type], { root, scale, rng, sevenths, avoid: [mainRomans] });
      if (p) plan[type] = p;
    }
    if (planRoots(specs(), root, scale).size < 2) {
      // only one harmonic section type: the loop itself moves (8 bars: the vamp, then a lift)
      const lift = pickPlan(fam.chorus, { root, scale, rng, sevenths });
      if (lift) { plan.main = lift; plan.chorus = lift; }
    }
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
