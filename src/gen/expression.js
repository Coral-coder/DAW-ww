// Performance expression (pure, deterministic): turns generated parts from "sequenced" into "played".
//
//   applyExpression(project, {genre, rng|seed}) -> project (mutated) + returns a report {notes, changed:{…}}
//
// Run it after the parts are written / grooved (it reads track roles and instruments). Per role / instrument:
//  * keys (piano, e-piano…) — sustain pedal: each chord rings until the next harmony change (the pedal lifts
//    just before it, so chords never smear into each other); voicing balance (top voice sings, inner voices soft).
//  * guitars — strummed chords ring to the next chord in let-ring genres; leads get bends (slide up into
//    long notes), slides between close notes and delayed finger vibrato.
//  * strings / brass / winds / synth leads — legato: notes inside a phrase touch / overlap slightly (mono
//    synths glide, samples cross over), delayed vibrato on long notes, occasional scoops / fall-offs (jazz, funk).
//  * every melodic part — phrase dynamics: a gentle arc over each phrase (rest-delimited), accents on bar
//    downbeats, softer pickups and phrase endings, louder high notes; articulation variety (detached short notes
//    in busy passages, held long tones).
//  * basses — 808 / fretless / upright slides into octave jumps or chord roots, shorter funk / reggae notes.
//  * drums — flams on fill snares / toms, crescendo through fills, accented section-start crashes.
// Note fields added (all optional, ignored by older builds): glide (semitones to slide in from), gt (glide
// time s), bend (semitones, reached at bendAt × duration), bendAt (0..1), vib (vibrato depth in semitones),
// flam (grace-stroke level 0..1, drums).
// The audio engine turns them into trigger extras (src/audio/mixer.js noteExtra).
// Guarantees: notes stay inside their pattern ([0, length)), no note is added or removed and pitches never
// change, held notes never cross an inferred chord change (tests/expression.test.js checks it with the
// harmony checker and the song-code round trip).
import { createRng, clamp } from '../core/util.js';
import { DRUM_PITCH, beatsPerBar } from '../core/model.js';

const EPS = 1e-6;
const r4 = (x) => Math.round(x * 10000) / 10000;
const r2 = (x) => Math.round(x * 100) / 100;

const PEDAL_GENRES = new Set(['pop', 'gospel', 'rnb', 'neo-soul', 'lofi-hip-hop', 'cinematic', 'ambient', 'downtempo', 'folk', 'country', 'indie', 'boom-bap', 'trip-hop', 'drill', 'liquid-dnb', 'chillwave', 'kpop', 'soul', 'blues']);
const VOICING_GENRES = new Set([...PEDAL_GENRES, 'jazz', 'bossa-nova', 'salsa']);
const LET_RING_GENRES = new Set(['folk', 'country', 'indie', 'pop', 'bossa-nova', 'rock', 'blues', 'afrobeat']);
const STAB_GENRES = new Set(['funk', 'disco', 'reggae', 'dub', 'house', 'tech-house', 'nu-disco', 'salsa', 'dancehall', 'ska']);
const BEND_GENRES = new Set(['blues', 'rock', 'metal', 'punk', 'country', 'indie', 'funk', 'soul', 'gospel']);
const FALL_GENRES = new Set(['jazz', 'funk', 'soul', 'salsa', 'disco', 'gospel', 'blues', 'neo-soul', 'bossa-nova']);
const SYNTH_GLIDE_GENRES = new Set(['synthwave', 'chiptune', 'dubstep', 'brostep', 'future-bass', 'psytrance', 'trance', 'eurobeat', 'hardstyle', 'drum-and-bass', 'acid', 'techno']);
const SLIDE_808_GENRES = new Set(['trap', 'drill', 'phonk', 'footwork', 'dancehall', 'reggaeton']);

/** Instrument family of a track's instrument: keys | mallet | guitar | strings | brass | wind | organ | pad | bass | synthlead | pluck | other. */
export function instrumentClass(inst) {
  const name = String(inst?.type === 'soundfont' ? inst.params?.instrument || '' : inst?.preset || inst?.type || '');
  if (/organ|harmonium/.test(name)) return 'organ';
  if (/guitar|nylon|power-chord|banjo|koto|sitar/.test(name)) return 'guitar';
  if (/piano|clav|celesta|harpsichord|lofi-keys|epiano/.test(name)) return 'keys';
  if (/vibraphone|marimba|kalimba|bell|glock|xylo|steel|music-box|tubular/.test(name)) return 'mallet';
  if (/bass|808/.test(name)) return 'bass';
  if (/string|violin|viola|cello|fiddle|harp/.test(name)) return name.includes('harp') && !name.includes('harpsi') ? 'mallet' : 'strings';
  if (/brass|trumpet|trombone|horn|tuba/.test(name)) return 'brass';
  if (/sax|flute|clarinet|oboe|bassoon|recorder|whistle|harmonica|pan_flute|ocarina|piccolo/.test(name)) return 'wind';
  if (/choir|pad|voice/.test(name)) return 'pad';
  if (/lead|hoover|square|saw|chip/.test(name)) return 'synthlead';
  if (/pluck|stab|arp|chords/.test(name)) return 'pluck';
  return 'other';
}

/** Group chord-part notes into hits (onsets within `tol` beats — strums / rolls count as one hit). */
export function chordGroups(notes, tol = 0.06) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && n.start - g.start <= tol) { g.notes.push(n); g.end = Math.max(g.end, n.start + n.dur); } else groups.push({ start: n.start, end: n.start + n.dur, notes: [n] });
  }
  for (const g of groups) g.pcs = [...new Set(g.notes.map((n) => ((n.pitch % 12) + 12) % 12))].sort((a, b) => a - b).join(',');
  return groups;
}

/** Harmony change points (beats) of a chord / pad part: onsets whose pitch-class set differs from the previous hit. */
export function harmonyChanges(notes) {
  const out = [];
  let prev = null;
  for (const g of chordGroups(notes)) {
    if (g.notes.length >= 2 && g.pcs !== prev) { out.push(g.start); prev = g.pcs; }
  }
  return out;
}

/**
 * Latest end a held note may be extended to: never across a grid line (half bar by default, where chords change)
 * that the note did not already reach — except by `slack` beats (an overlap the ear hears as legato).
 */
export function holdLimit(start, end, target, grid = 2, slack = 0.08) {
  const line = Math.floor((end - EPS) / grid + 1) * grid; // first grid line after the current end
  return target > line + slack ? Math.max(end, line - 0.06) : target;
}

/** Sustain pedal: each hit rings until the next harmony change (or next hit of the same chord), pedal lifts `lift` beats early. */
export function pedalSustain(notes, { length, lift = 0.06, maxExtend = 6, grid = 2 } = {}) {
  const groups = chordGroups(notes);
  let changed = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    // the pedal holds through repeated hits of the same chord and is lifted before a different one
    let j = i + 1;
    while (j < groups.length && groups[j].pcs === g.pcs) j++;
    const nextSame = groups[i + 1];
    const until = nextSame && nextSame.pcs === g.pcs ? nextSame.start : j < groups.length ? groups[j].start - lift : length;
    for (const n of g.notes) {
      // a chord that falls silent can't be held into the next half bar (the harmony may change there unplayed)
      const end = holdLimit(n.start, n.start + n.dur, Math.min(until, n.start + n.dur + maxExtend, length), grid);
      if (end > n.start + n.dur + 0.02) { n.dur = r4(end - n.start); changed++; }
    }
  }
  return changed;
}

/** Hits whose pitch set is a subset of the previous hit = same harmony; otherwise a change. Used for legato limits. */
function nextChangeAfter(changes, t) {
  for (const c of changes) if (c > t + 0.02) return c;
  return Infinity;
}

/** Split a monophonic line into phrases (a rest of >= minRest beats ends a phrase). */
export function phrases(notes, minRest = 0.5) {
  const s = [...notes].sort((a, b) => a.start - b.start);
  const out = [];
  let cur = [];
  for (const n of s) {
    const last = cur[cur.length - 1];
    if (last && n.start - (last.start + last.dur) >= minRest) { out.push(cur); cur = []; }
    cur.push(n);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Phrase dynamics for a melodic line: arc, downbeat accents, softer pickups / endings, high notes lift. */
export function phraseDynamics(notes, { bpb = 4, amount = 1, rng } = {}) {
  for (const ph of phrases(notes)) {
    const lo = Math.min(...ph.map((n) => n.pitch)), hi = Math.max(...ph.map((n) => n.pitch));
    const t0 = ph[0].start, t1 = ph[ph.length - 1].start + ph[ph.length - 1].dur;
    ph.forEach((n, i) => {
      const x = (n.start - t0) / Math.max(0.5, t1 - t0);
      let m = 1 + 0.07 * Math.sin(Math.PI * Math.min(1, x * 1.15)); // swell toward the middle, ease off at the end
      if (hi > lo) m *= 1 + 0.06 * ((n.pitch - lo) / (hi - lo) - 0.5); // reaching up = a little louder
      const pos = ((n.start % bpb) + bpb) % bpb;
      if (pos < 0.04 || bpb - pos < 0.04) m *= 1.05; // bar downbeat
      else if (bpb - pos <= 1 && i < ph.length - 1 && ph[i + 1].start - Math.ceil(n.start / bpb - EPS) * bpb > -EPS) m *= 0.93; // pickup into the bar
      if (i === ph.length - 1 && ph.length > 2) m *= 0.94; // phrase ending
      if (rng) m *= 1 + (rng() - 0.5) * 0.04;
      n.vel = r2(clamp(n.vel * (1 + (m - 1) * amount), 0.05, 1));
    });
  }
}

/** Expression for one pattern (mutates its notes). ctx: {role, cls, genre, length, bpb, bpm, changes, rng}. */
export function expressPattern(notes, ctx) {
  const { role, cls, genre, length, bpb = 4, rng } = ctx;
  const spb = 60 / (ctx.bpm || 120);
  const changes = ctx.changes || [];
  const stat = { pedal: 0, legato: 0, glide: 0, bend: 0, vib: 0, flam: 0, stacc: 0 };
  if (!notes.length) return stat;

  if (role === 'chords') {
    const keysLike = cls === 'keys' || cls === 'mallet';
    if ((keysLike && PEDAL_GENRES.has(genre)) || (cls === 'guitar' && LET_RING_GENRES.has(genre) && !/metal|punk/.test(genre))) {
      stat.pedal += pedalSustain(notes, { length, grid: bpb / 2 });
    } else if (STAB_GENRES.has(genre) && (cls === 'keys' || cls === 'guitar' || cls === 'pluck' || cls === 'organ')) {
      // rhythmic comping: short, slightly varied stabs (off-beat skanks shorter than downbeats)
      // (one length per chord hit, so every voice of the stab stops together and song code can still write it)
      for (const g of chordGroups(notes)) {
        const d = Math.max(...g.notes.map((n) => n.dur));
        if (d <= 0.2 || d > 1.01) continue;
        const off = Math.abs(g.start - Math.round(g.start)) > 0.1;
        const len = r4(Math.max(0.14, d * ((off ? 0.5 : 0.65) + rng() * 0.12)));
        for (const n of g.notes) { n.dur = Math.min(n.dur, len); stat.stacc++; }
      }
    }
    // voicing balance: the top voice sings, inner voices recede, the bass of the chord stays solid
    // (acoustic / ballad genres only: song code writes one velocity per chord hit, so dance-music stabs keep theirs)
    for (const g of VOICING_GENRES.has(genre) ? chordGroups(notes) : []) {
      if (g.notes.length < 3) continue;
      const ps = g.notes.map((n) => n.pitch);
      const top = Math.max(...ps), bot = Math.min(...ps);
      for (const n of g.notes) n.vel = r2(clamp(n.vel + (n.pitch === top ? 0.035 : n.pitch === bot ? 0.01 : -0.025), 0.05, 1));
    }
  }

  if (role === 'lead' || role === 'counter') {
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    const sustained = ['strings', 'brass', 'wind', 'synthlead', 'organ', 'pad'].includes(cls);
    const legatoGap = sustained ? 0.26 : cls === 'guitar' ? 0.13 : 0;
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i], nx = sorted[i + 1], pv = sorted[i - 1];
      const end = n.start + n.dur;
      // legato: close the gap to the next note (+ a 20 ms overlap) unless a chord change sits in between
      if (nx && legatoGap > 0 && nx.start - end <= legatoGap && nx.start > n.start + 0.05) {
        const lim = nextChangeAfter(changes, n.start);
        const target = holdLimit(n.start, end, Math.min(nx.start + Math.min(0.06, 0.02 / spb), length), bpb / 2);
        if (target <= lim + 0.05 && target > end + 0.005) { n.dur = r4(target - n.start); stat.legato++; }
      }
      const durSec = n.dur * spb;
      const leap = pv ? n.pitch - pv.pitch : 0;
      const connected = pv && n.start - (pv.start + pv.dur) <= 0.05;
      // slides / scoops
      if (cls === 'guitar' && BEND_GENRES.has(genre) && durSec > 0.35 && rng.chance(0.28)) {
        n.glide = rng.chance(0.6) ? -2 : -1; n.gt = r2(0.1 + rng() * 0.08); stat.bend++;
      } else if (connected && Math.abs(leap) >= 1 && Math.abs(leap) <= 5 && (
        (cls === 'guitar' && rng.chance(0.18)) || (cls === 'synthlead' && SYNTH_GLIDE_GENRES.has(genre) && rng.chance(0.3))
        || ((cls === 'strings' || cls === 'wind') && rng.chance(0.08)))) {
        n.glide = -leap; n.gt = r2(cls === 'synthlead' ? 0.05 + rng() * 0.04 : 0.06 + rng() * 0.05); stat.glide++;
      } else if ((cls === 'brass' || cls === 'wind') && FALL_GENRES.has(genre) && !connected && durSec > 0.25 && rng.chance(0.12)) {
        n.glide = -1; n.gt = 0.07; stat.glide++; // scoop into the note
      }
      // fall-off at a phrase end (brass / sax), never into the next chord
      const phraseEnd = !nx || nx.start - end >= 0.75;
      if ((cls === 'brass' || cls === 'wind') && FALL_GENRES.has(genre) && phraseEnd && durSec > 0.3 && rng.chance(0.25)) {
        n.bend = -2; n.bendAt = 0.72; stat.bend++;
      }
      // delayed vibrato on held notes
      const vibDepth = { strings: 0.18, brass: 0.12, wind: 0.16, guitar: 0.22, synthlead: 0.14, pad: 0, organ: 0 }[cls] || 0;
      if (vibDepth && durSec >= 0.55) { n.vib = r2(vibDepth * (0.8 + rng() * 0.4) * (durSec > 1.2 ? 1.15 : 1)); stat.vib++; }
    }
    phraseDynamics(notes, { bpb, rng });
  }

  if (role === 'bass') {
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    const is808 = ctx.inst?.preset === '808-bass' || SLIDE_808_GENRES.has(genre);
    for (let i = 1; i < sorted.length; i++) {
      const n = sorted[i], pv = sorted[i - 1];
      const connected = n.start - (pv.start + pv.dur) <= 0.06;
      const leap = n.pitch - pv.pitch;
      if (is808 && connected && leap !== 0 && Math.abs(leap) <= 12 && rng.chance(Math.abs(leap) === 12 ? 0.6 : 0.3)) {
        n.glide = -leap; n.gt = r2(0.06 + rng() * 0.05); stat.glide++;
      } else if (/upright|acoustic_bass|fretless/.test(ctx.instName) && !connected && Math.abs(n.start - Math.round(n.start)) < 0.02 && n.dur * spb > 0.3 && rng.chance(0.07)) {
        n.glide = -2; n.gt = 0.06; stat.glide++; // slide into a downbeat
      }
    }
    if (STAB_GENRES.has(genre) && !is808) {
      for (const n of notes) if (n.dur > 0.3 && n.dur <= 1.01 && rng.chance(0.5)) { n.dur = r4(n.dur * (0.6 + rng() * 0.2)); stat.stacc++; }
    }
    for (const n of notes) {
      const pos = ((n.start % bpb) + bpb) % bpb;
      const m = pos < 0.03 ? 1.05 : Math.abs(pos - Math.round(pos)) > 0.1 ? 0.94 : 1;
      n.vel = r2(clamp(n.vel * m, 0.05, 1));
    }
  }

  if (role === 'pad' && ['strings', 'brass', 'wind', 'pad'].includes(cls)) {
    // long chords breathe: a slow swell on each held chord is the velocity's job for samples (louder = brighter)
    for (const g of chordGroups(notes)) if (g.end - g.start >= bpb) for (const n of g.notes) n.vel = r2(clamp(n.vel * 1.04, 0.05, 1));
  }

  // (sub-16th arps — chiptune / trance gates — stay mechanical: that's their idiom)
  if (role === 'arp' && notes.filter((n) => n.dur >= 0.12).length >= notes.length / 2) {
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    sorted.forEach((n) => {
      const pos = ((n.start % 1) + 1) % 1;
      // beat accents only (no random jitter: song code writes arp velocities as a per-step pattern)
      n.vel = r2(clamp(n.vel * (pos < 0.04 ? 1.06 : Math.abs(pos - 0.5) < 0.04 ? 1 : 0.95), 0.05, 1));
    });
  }

  if (role === 'drums') {
    const snare = DRUM_PITCH.snare, toms = new Set([DRUM_PITCH.tomlow, DRUM_PITCH.tommid, DRUM_PITCH.tomhigh].filter((x) => x != null));
    const bars = Math.max(1, Math.round(length / bpb));
    for (let b = 0; b < bars; b++) {
      const a = b * bpb, z = a + bpb;
      const hits = notes.filter((n) => n.start >= a - EPS && n.start < z - EPS && (n.pitch === snare || toms.has(n.pitch)));
      const fill = hits.length >= 5 || hits.some((n) => toms.has(n.pitch));
      if (!fill) continue;
      // fills build: crescendo across the bar, flams on some strokes (`flam` = grace-stroke level relative to the
      // note; the instrument plays the grace stroke and the main stroke ~16 ms apart — src/audio/instruments.js)
      const t0 = Math.min(...hits.map((n) => n.start));
      for (const n of hits) {
        n.vel = r2(clamp(n.vel * (0.86 + 0.24 * ((n.start - t0) / Math.max(0.5, z - t0))), 0.05, 1));
        if (n.vel >= 0.55 && rng.chance(0.3)) { n.flam = r2(0.35 + rng() * 0.15); stat.flam++; }
      }
    }
    for (const n of notes) if (n.pitch === DRUM_PITCH.crash && n.start < 0.05) n.vel = r2(clamp(n.vel * 1.08, 0.05, 1));
  }

  // bounds (pattern length) + tidy
  for (const n of notes) {
    if (n.start + n.dur > length) n.dur = r4(Math.max(0.01, length - n.start));
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return stat;
}

/**
 * Post-process a generated song (mutates). opts: {genre, rng | seed}. Patterns are matched to their track's role /
 * instrument; held notes are limited by the chord changes of the chord (or pad) part playing at the same time.
 * Returns {notes, ...counts} — how many notes got each treatment.
 */
export function applyExpression(project, opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? project.seed ?? 1);
  const genre = opts.genre || project.genre;
  const bpb = beatsPerBar(project);
  const bpm = project.bpm || 120;
  const report = { notes: 0, pedal: 0, legato: 0, glide: 0, bend: 0, vib: 0, flam: 0, stacc: 0 };
  const trackById = new Map(project.tracks.map((t) => [t.id, t]));
  // chord changes per clip start: chords part first, pads second
  const changeAt = new Map();
  for (const role of ['pad', 'chords']) {
    for (const c of project.clips || []) {
      const t = trackById.get(c.trackId);
      if (t?.role !== role) continue;
      const p = project.patterns[c.patternId];
      if (p) changeAt.set(c.start, harmonyChanges(p.notes || []));
    }
  }
  const clipStartOf = new Map();
  for (const c of project.clips || []) if (!clipStartOf.has(c.patternId)) clipStartOf.set(c.patternId, c.start);
  const base = Math.floor(rng() * 2 ** 31);
  const ids = Object.keys(project.patterns); // generation order (ids themselves are random)
  for (const [i, id] of ids.entries()) {
    const pat = project.patterns[id];
    const track = trackById.get(pat.trackId);
    if (!track || track.type !== 'instrument' || !pat.notes?.length) continue;
    const role = track.role || (track.instrument?.type === 'drums' ? 'drums' : 'lead');
    if (role === 'fx') continue;
    const inst = track.instrument;
    const instName = String(inst?.type === 'soundfont' ? inst.params?.instrument || '' : inst?.preset || '');
    const st = expressPattern(pat.notes, {
      role, cls: role === 'drums' ? 'drums' : instrumentClass(inst), inst, instName, genre, length: pat.length, bpb, bpm,
      changes: changeAt.get(clipStartOf.get(id)) || [], rng: createRng((base + i * 7919) >>> 0),
    });
    report.notes += pat.notes.length;
    for (const k of Object.keys(st)) report[k] += st[k];
  }
  return report;
}
