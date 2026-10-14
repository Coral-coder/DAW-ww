// Guided "Make a track" walkthrough — pure logic (Node-safe, no DOM): step list, progress detection from a project,
// mood → scale, genre-aware progression suggestions, and a simple arranger that lays the user's own patterns out
// as a song (intro → verse → build → chorus → break → build → chorus → outro) with filter-sweep automation.
// The UI lives in src/ui/wizard.js.
import { GENRES } from '../gen/genres.js';
import { progressionFromProject } from '../gen/analyze.js';
import { filterSweepPoints } from '../gen/arrange.js';
import {
  PROGRESSIONS, findProgressions, progressionChords, chordFunction, isMinorScale, romanToChord,
  chordPitchClasses, scalePitchClasses, SCALES,
} from '../theory/index.js';
import { createClip, createEffect, beatsPerBar } from '../core/model.js';
import { createAutomationLane } from '../core/automation.js';
import { uid } from '../core/util.js';

export const WIZARD_STEPS = [
  { id: 'vibe', title: 'Pick a vibe', short: 'Vibe' },
  { id: 'key', title: 'Key & scale', short: 'Key' },
  { id: 'beat', title: 'Lay down a beat', short: 'Beat' },
  { id: 'bass', title: 'Add a bassline', short: 'Bass' },
  { id: 'chords', title: 'Choose your chords', short: 'Chords' },
  { id: 'melody', title: 'Find the hook', short: 'Hook' },
  { id: 'layers', title: 'Extra layers', short: 'Layers' },
  { id: 'arrange', title: 'Arrange the song', short: 'Arrange' },
  { id: 'mix', title: 'Mix it', short: 'Mix' },
  { id: 'finish', title: 'Finish & share', short: 'Finish' },
];
export const STEP_IDS = WIZARD_STEPS.map((s) => s.id);

/** Moods bias the scale choice (and which progressions get suggested first). */
export const MOODS = {
  dark: { label: 'Dark', scales: ['phrygian', 'minor', 'harmonic-minor'], tags: ['dark', 'epic', 'dramatic', 'brutal', 'melancholic', 'tense', 'determined', 'mechanical'], blurb: 'brooding, tense, heavy' },
  uplifting: { label: 'Uplifting', scales: ['major', 'lydian', 'mixolydian'], tags: ['uplifting', 'hopeful', 'anthemic', 'triumphant', 'joyful', 'lifting', 'climbing'], blurb: 'bright, hopeful, big' },
  chill: { label: 'Chill', scales: ['dorian', 'major', 'minor'], tags: ['dreamy', 'relaxed', 'mellow', 'lush', 'smooth', 'warm', 'breezy'], blurb: 'laid-back, warm, soft' },
  energetic: { label: 'Energetic', scales: ['minor', 'mixolydian', 'dorian'], tags: ['energetic', 'driving', 'epic', 'anthemic', 'groovy', 'swagger'], blurb: 'driving, punchy, loud' },
};

/** Short teaching notes for well-known progressions (falls back to the library's description). */
const PROG_WHY = {
  'aeolian-loop': 'i–VI–III–VII is the epic minor loop: it never lands on a dominant, so it can cycle forever — the sound of trance, film trailers and big-room drops.',
  'pop-axis': 'I–V–vi–IV: home, tension, a sad turn, then lift. Four chords behind hundreds of hits.',
  'axis-minor': 'Starts on the relative minor (vi) — the same four pop chords, but bittersweet.',
  andalusian: 'A descending bass line i–VII–VI–V that ends on a major V — instant drama and Spanish colour.',
  'dorian-vamp': 'Minor i with a major IV — the raised 6th is the Dorian "hopeful minor" sound of house and funk.',
  'soul-vamp': 'Two major-seventh chords rocking back and forth: dreamy, no tension, perfect for grooves.',
  'ii-v-i': 'ii–V–I: the backbone of jazz — the V pulls hard toward home.',
  'minor-descend': 'Rocking between VI and VII without resolving keeps the energy hovering — rock and trance love it.',
  'royal-road': 'IV–V–iii–vi: the J-pop "royal road" — yearning and dramatic.',
  fifties: 'I–vi–IV–V: doo-wop changes — sweet and nostalgic.',
  'mario-cadence': 'Borrowed ♭VI–♭VII rising to I — the triumphant video-game finish.',
};

const FN_LABEL = { tonic: 'home', subdominant: 'away', dominant: 'tension', 'secondary-dominant': 'pull', chromatic: 'colour' };

// ------------------------------------------------------------------------------------------------ roles / detection
/** Musical role of a track as the wizard sees it. */
export function wizardRole(t) {
  if (!t) return null;
  if (t.type !== 'instrument') return t.type; // 'audio' | 'code'
  if (t.role === 'perc') return 'perc';
  if (t.instrument?.type === 'drums' || t.role === 'drums') return 'drums';
  if (t.role === 'keys') return 'chords';
  return t.role || 'other';
}

const trackHasNotes = (p, t) => Object.values(p.patterns || {}).some((pat) => pat.trackId === t.id && pat.notes?.length);

/** First track of a role that has notes (or, with anyTrack, any track of that role). */
export function findRoleTrack(p, role, { anyTrack = false } = {}) {
  const ts = (p.tracks || []).filter((t) => wizardRole(t) === role);
  return ts.find((t) => trackHasNotes(p, t)) || (anyTrack ? ts[0] : null) || null;
}

/**
 * What the project already has, per step: {vibe, key, beat, bass, chords, melody, layers, arrange, mix, finish}
 * (booleans; key / mix / finish can only be confirmed by the user, so they are false here) + track ids.
 */
export function detectProgress(p) {
  const out = Object.fromEntries(STEP_IDS.map((id) => [id, false]));
  if (!p) return out;
  out.vibe = !!(p.genre && GENRES[p.genre]);
  const drums = findRoleTrack(p, 'drums');
  const bass = findRoleTrack(p, 'bass');
  const lead = findRoleTrack(p, 'lead');
  const chordsTrack = findRoleTrack(p, 'chords');
  let prog = null;
  try { prog = progressionFromProject(p); } catch { prog = null; }
  out.beat = !!drums;
  out.bass = !!bass;
  out.chords = !!chordsTrack || !!(prog?.progression?.length >= 2 && ['chords', 'pad'].includes(wizardRole(prog.track)));
  out.melody = !!lead;
  out.layers = ['pad', 'arp', 'counter', 'perc'].some((r) => findRoleTrack(p, r));
  out.arrange = (p.clips || []).some((c) => c.type !== 'audio');
  out.ids = { drums: drums?.id || null, bass: bass?.id || null, lead: lead?.id || null, chords: chordsTrack?.id || null };
  out.hasMelodicNotes = (p.tracks || []).some((t) => t.type === 'instrument' && wizardRole(t) !== 'drums' && wizardRole(t) !== 'perc' && trackHasNotes(p, t));
  return out;
}

/** Index of the first step that's not done (done = detected || confirmed), or the last step. */
export function nextOpenStep(detected, confirmed = {}) {
  const i = STEP_IDS.findIndex((id) => !(detected[id] || confirmed[id]));
  return i < 0 ? STEP_IDS.length - 1 : i;
}

// ------------------------------------------------------------------------------------------------ mood → scale
const art = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const an = (word) => `${art(word)} ${word.toLowerCase()}`;
/** Scale for a genre + mood: the genre's own scales that fit the mood first, else the mood's default. -> {scale, why} */
export function moodScale(genreId, mood) {
  const g = GENRES[genreId];
  const m = MOODS[mood];
  const gScales = (g?.scales || []).filter((s) => SCALES[s]);
  if (!m) return { scale: gScales[0] || 'minor', why: g ? `${g.name} usually sits in ${SCALES[gScales[0]]?.name || 'minor'}.` : '' };
  const hit = m.scales.find((s) => gScales.includes(s));
  const scale = hit || m.scales[0];
  const name = SCALES[scale]?.name || scale;
  const why = hit
    ? `${g?.name || 'This genre'} often lives in ${name} (${SCALES[scale]?.mood || m.blurb}) — a natural home for ${an(m.label)} track.`
    : `${g?.name || 'This genre'} is usually ${SCALES[gScales[0]]?.name || 'minor'}, but for ${an(m.label)} mood ${name} (${SCALES[scale]?.mood || m.blurb}) works great.`;
  return { scale, why };
}

// ------------------------------------------------------------------------------------------------ progressions
function modeFits(p, scale) {
  const minor = isMinorScale(scale);
  if (p.mode === 'any') return true;
  return minor ? ['minor', 'phrygian'].includes(p.mode) : ['major', 'lydian'].includes(p.mode);
}
/** Every un-altered roman's triad must sit in the scale (borrowed ♭/♯ chords are intentional colour). */
function fitsScale(p, scale) {
  if ((SCALES[scale]?.intervals?.length || 0) !== 7) return true;
  const set = new Set(scalePitchClasses(0, scale));
  return p.romans.every((r) => {
    if (/^[b#♭♯]|\//.test(r)) return true;
    const c = romanToChord(r, 0, scale);
    return !c || chordPitchClasses(c.root, c.type).slice(0, 3).every((pc) => set.has(pc));
  });
}

/**
 * 3–4 progressions that suit the genre / mood and fit the key.
 * -> [{id, name, romans, description, why, bars, chords:[{roman, name, bars, fn}], flow}]
 */
export function suggestProgressions(genreId, root = 0, scale = 'minor', { mood, limit = 4 } = {}) {
  const g = GENRES[genreId];
  const minor = isMinorScale(scale);
  const tags = MOODS[mood]?.tags || [];
  const score = new Map();
  const bump = (id, s) => { if (PROGRESSIONS[id]) score.set(id, (score.get(id) || 0) + s); };
  (g?.progressions || []).forEach((id, i) => bump(id, 6 - i * 0.2));
  for (const p of findProgressions({ genre: genreId })) bump(p.id, 2);
  for (const [id, p] of Object.entries(PROGRESSIONS)) if (p.moods.some((m) => tags.includes(m))) bump(id, score.has(id) ? 1.5 : 0.6);
  // everything else that fits the key fills the list (keeps library order)
  for (const id of Object.keys(PROGRESSIONS)) bump(id, 0.01);
  // always have a safe fallback for the mode
  bump(minor ? 'aeolian-loop' : 'pop-axis', 0.5);
  bump(minor ? 'andalusian' : 'fifties', 0.3);
  const ids = [...score.entries()]
    .filter(([id]) => modeFits(PROGRESSIONS[id], scale) && fitsScale(PROGRESSIONS[id], scale))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return ids.slice(0, limit).map((id) => describeProgression(id, root, scale));
}

export function describeProgression(id, root, scale) {
  const p = PROGRESSIONS[id];
  const chords = progressionChords(id, root, scale).map((c) => {
    const fn = chordFunction(c.chord, root, scale);
    return { roman: c.roman, name: c.chord.name, bars: c.bars, fn, fnLabel: FN_LABEL[fn] || 'colour' };
  });
  const bars = chords.reduce((s, c) => s + c.bars, 0);
  return {
    id, name: p.name, romans: p.romans, description: p.description, why: PROG_WHY[id] || p.description,
    bars, chords, flow: chords.map((c) => c.fnLabel).join(' → '),
  };
}

/** Loop length (bars) for a progression: at least 4, a multiple of the progression, at most 16. */
export function loopBarsFor(progBars) {
  const b = Math.max(1, Math.ceil(progBars || 4));
  if (b >= 4) return Math.min(16, b);
  return 4;
}

// ------------------------------------------------------------------------------------------------ arranger
/** Song form for the arranger: section name, bars, which roles play, and filter sweeps. */
export const ARRANGER_FORM = [
  { name: 'Intro', bars: 8, kind: 'intro', roles: ['drums'], sweep: [300, 16000] },
  { name: 'Verse', bars: 8, kind: 'verse', roles: ['drums', 'bass', 'perc'] },
  { name: 'Build', bars: 4, kind: 'build', roles: ['drums', 'chords', 'arp', 'pad', 'perc'], sweep: [500, 18000] },
  { name: 'Chorus', bars: 16, kind: 'main', roles: ['drums', 'bass', 'chords', 'lead', 'pad', 'arp', 'perc', 'other'] },
  { name: 'Break', bars: 8, kind: 'break', roles: ['pad', 'chords', 'lead', 'arp', 'other'] },
  { name: 'Build', bars: 4, kind: 'build', roles: ['drums', 'chords', 'arp', 'pad', 'perc'], sweep: [500, 18000] },
  { name: 'Chorus', bars: 16, kind: 'main', roles: ['drums', 'bass', 'chords', 'lead', 'counter', 'pad', 'arp', 'perc', 'other'] },
  { name: 'Outro', bars: 8, kind: 'outro', roles: ['drums', 'bass', 'pad'] },
];

/** The pattern a track contributes to the arrangement: its active pattern if it has notes, else its fullest one. */
function arrangePattern(p, t) {
  const act = p.patterns[t.activePatternId];
  if (act?.notes?.length) return act;
  return Object.values(p.patterns).filter((x) => x.trackId === t.id && x.notes?.length).sort((a, b) => b.notes.length - a.notes.length)[0] || null;
}

/**
 * Plan a song from the project's own patterns (pure).
 * -> {sections:[{name, start, bars, kind, trackIds}], clips:[Clip], markers, sweeps:[{trackId, a, b, from, to}], totalBeats}
 */
export function planArrangement(p, { form = ARRANGER_FORM } = {}) {
  const bpb = beatsPerBar(p);
  const half = (p.bpm || 120) < 95; // slow genres: shorter sections keep the song a sensible length
  const parts = [];
  for (const t of p.tracks || []) {
    if (t.type !== 'instrument') continue;
    const pat = arrangePattern(p, t);
    if (!pat) continue;
    let role = wizardRole(t);
    if (!form.some((s) => s.roles.includes(role))) role = 'other';
    parts.push({ t, pat, role });
  }
  const sections = [];
  const clips = [];
  const markers = [];
  const sweeps = [];
  let beat = 0;
  for (const s of form) {
    const bars = half ? Math.max(4, s.bars / 2) : s.bars;
    let playing = parts.filter((x) => s.roles.includes(x.role));
    if (!playing.length) playing = s.kind === 'break' ? parts.filter((x) => x.role !== 'drums' && x.role !== 'perc') : [];
    if (!playing.length) playing = parts;
    if (!playing.length) continue;
    const len = bars * bpb;
    for (const x of playing) clips.push(createClip(x.t.id, { patternId: x.pat.id, start: beat, length: len }));
    markers.push({ id: uid('mk'), beat, name: s.name });
    if (s.sweep) for (const x of playing) if (x.role !== 'perc') sweeps.push({ trackId: x.t.id, a: beat, b: beat + len, from: s.sweep[0], to: s.sweep[1] });
    sections.push({ name: s.name, kind: s.kind, start: beat, bars, trackIds: playing.map((x) => x.t.id) });
    beat += len;
  }
  return { sections, clips, markers, sweeps, totalBeats: beat };
}

/** Apply a plan to a project draft (inside store.transact): replaces pattern clips + markers, adds sweep lanes. */
export function applyArrangement(p, plan) {
  p.clips = (p.clips || []).filter((c) => c.type === 'audio').concat(plan.clips);
  p.markers = plan.markers.slice();
  const byTrack = new Map();
  for (const sw of plan.sweeps) (byTrack.get(sw.trackId) || byTrack.set(sw.trackId, []).get(sw.trackId)).push(sw);
  for (const [tid, list] of byTrack) {
    const t = p.tracks.find((x) => x.id === tid);
    if (!t) continue;
    t.fx = t.fx || [];
    let f = t.fx.find((x) => x.type === 'filter' && x.wizard);
    if (!f) {
      f = { ...createEffect('filter', { type: 'lowpass', cutoff: 20000, resonance: 1.1, slope: '12', depth: 0, mix: 1 }), wizard: true };
      t.fx.push(f);
    }
    const target = `fx:${f.id}:cutoff`;
    const pts = list.flatMap((sw) => filterSweepPoints(sw.a, sw.b, sw.from, sw.to)).sort((a, b) => a.beat - b.beat);
    t.automation = (t.automation || []).filter((l) => l.target !== target);
    t.automation.push(createAutomationLane(target, pts));
  }
  p.mode = 'song';
  p.loop = { ...(p.loop || {}), enabled: false, start: 0, end: plan.totalBeats || 16 };
  return p;
}

/** Sidechain "pump": duck bass / chords / pad / arp from the drum track (skips tracks that already duck). -> count */
export function addSidechain(p) {
  const drums = findRoleTrack(p, 'drums', { anyTrack: true });
  if (!drums) return 0;
  let n = 0;
  for (const t of p.tracks) {
    const role = wizardRole(t);
    if (!['bass', 'chords', 'pad', 'arp'].includes(role)) continue;
    t.fx = t.fx || [];
    if (t.fx.some((f) => f.type === 'ducker' || f.type === 'pump')) continue;
    t.fx.push(createEffect('ducker', { sourceTrackId: drums.id, amount: role === 'bass' ? 0.55 : 0.35, threshold: -22, attack: 0.004, release: role === 'bass' ? 0.13 : 0.16 }));
    n++;
  }
  return n;
}
