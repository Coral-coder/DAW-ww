// Objective harmony-quality analysis of generated songs (used by tests/harmony-quality.test.js).
// Deliberately independent of the generators' own chord-scale logic: it only uses the chord-type table
// and the project scale, so it judges the output the way a listener / session player would.
import { CHORD_TYPES, scalePitchClasses } from '../../src/theory/index.js';

const m12 = (n) => ((Math.round(n) % 12) + 12) % 12;
const EPS = 1e-6;

const DOMINANT = new Set(['7', '9', '11', '13', '7b9', '7#9', '7#11', '7b5', 'aug7', '7sus4', '9sus4']);

/** Genre-specific idioms that a strict classical checker would wrongly flag. */
export function genreExceptions(genre, scale = '') {
  return {
    // blue notes: b3 / b5 / b7 of the key (and of the chord) over anything in the melody
    blues: ['blues', 'boom-bap', 'rock', 'funk'].includes(genre) || /blues/.test(scale),
    // tensions 9/11/13 everywhere and altered tensions (b9 #9 #11 b13) over dominant chords
    jazz: ['jazz', 'bossa-nova', 'neo-soul', 'lofi-hip-hop', 'gospel', 'rnb'].includes(genre),
    // power chords have no third; chromatic b2 / b5 riffing is the idiom
    metal: ['metal', 'industrial'].includes(genre),
    // a 0.25-beat half-step "sidestep" approach chord into the next chord
    sidestep: genre === 'gospel',
  };
}

export function chordInfo(c) {
  const t = CHORD_TYPES[c.type] || CHORD_TYPES.maj;
  const all = new Set(t.intervals.map((i) => m12(c.root + i)));
  const core = new Set(t.intervals.filter((i) => i < 12).map((i) => m12(c.root + i)));
  if (c.bass != null) { all.add(m12(c.bass)); core.add(m12(c.bass)); }
  const iv = new Set(t.intervals.map((i) => m12(i)));
  return {
    root: m12(c.root), type: c.type, all, core,
    major3: iv.has(4), minor3: iv.has(3) && !iv.has(4), dominant: DOMINANT.has(c.type), power: c.type === '5',
  };
}

function chordAt(harmony, len, t) {
  const tt = ((t % len) + len) % len;
  return harmony.find((c) => tt >= c.startBeat - EPS && tt < c.startBeat + c.durBeats - EPS) || harmony[harmony.length - 1];
}

/**
 * Classify a pitch class against a chord: 'chord' | 'tension' | 'avoid' | 'clash'.
 *  clash  = a minor 2nd/9th above a chord tone, major+minor third together, or a cross-relation with an
 *           altered chord tone (key E under a chord with E#) — what makes chords "not sound right".
 *  avoid  = out of key and not a chord tone (chromatic) — fine as a short passing tone only.
 */
export function classify(pc, ci, keyPcs, ex) {
  if (ci.all.has(pc)) return 'chord';
  const rel = m12(pc - ci.root);
  if (ex.metal && ci.power) return keyPcs.has(pc) || rel === 1 || rel === 6 ? 'tension' : 'avoid';
  if (ex.jazz && ci.dominant && [1, 3, 6, 8].includes(rel)) return 'tension'; // altered dominant
  if (ex.blues && (rel === 3 || rel === 6 || rel === 10 || [3, 6, 10].includes(m12(pc - [...keyPcs][0])))) {
    if (!(ci.minor3 && rel === 4)) return 'tension'; // blue notes
  }
  if (ci.major3 && rel === 3) return 'clash';
  for (const ct of ci.all) {
    if (m12(pc - ct) === 1) return 'clash'; // b9 against a chord tone
    if (m12(ct - pc) === 1 && !keyPcs.has(ct) && keyPcs.has(pc)) return 'clash'; // cross relation
  }
  if (!keyPcs.has(pc)) return 'avoid';
  return 'tension';
}

/** Note list of a pattern looped/clipped to the harmony length. */
const notesOf = (pat) => (pat?.notes || []).filter((n) => n.dur > 0);

/**
 * Analyse one song generated with {withHarmony: true}.
 * -> {bass:{ok,total}, notes:{ok,total,clash,clashSustained}, voicing:{ok,total,maxNotes,issues[]}, overlap:{ok,total},
 *     register:{leadMedian,padTop}, issues:[strings]}
 */
export function analyzeSong(song) {
  const ex = genreExceptions(song.genre, song.key.scale);
  // per-pattern harmony (songs whose sections use different progressions export patternHarmony {patId: {harmony, length}});
  // every rule below is unchanged — each pattern is judged against the chords it was written over
  let harmony = song.harmony;
  let len = song.harmonyLength;
  const useHarmonyOf = (pat) => {
    const ph = song.patternHarmony?.[pat.id];
    harmony = ph ? ph.harmony : song.harmony;
    len = ph ? ph.length : song.harmonyLength;
  };
  const bpb = song.timeSig ? song.timeSig[0] * (4 / song.timeSig[1]) : 4;
  const keyPcs = new Set(scalePitchClasses(song.key.root, song.key.scale));
  // blues-type scales: the key's "parent" notes are fine too
  const res = {
    bass: { ok: 0, total: 0 }, notes: { ok: 0, total: 0, clash: 0, clashSustained: 0 },
    voicing: { ok: 0, total: 0, maxNotes: 0 }, overlap: { ok: 0, total: 0 }, register: {}, issues: [],
  };
  const issue = (s) => { if (res.issues.length < 40) res.issues.push(s); };
  const byRole = {};
  for (const t of song.tracks) {
    if (!t.role || t.role === 'drums' || t.role === 'fx') continue;
    for (const p of Object.values(song.patterns)) if (p.trackId === t.id) (byRole[t.role] ||= []).push(p);
  }
  // (a) bass: strong beats (1 & 3), sustained notes and the first note of each chord must be chord tones
  //     (root/3rd/5th/7th/6th or the slash bass). Short weak-beat notes are approach / passing tones, but they
  //     must not grind a minor 2nd against the chord (except a walking jazz line).
  for (const pat of byRole.bass || []) {
      useHarmonyOf(pat);
    const ns = notesOf(pat).slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const strong = bpb % 2 === 0 ? [0, bpb / 2] : [0];
    const seenChord = new Set();
    for (const n of ns) {
      const c = chordAt(harmony, len, n.start + 0.01);
      const ci = chordInfo(c);
      const pos = n.start % bpb;
      const chordKey = `${Math.floor(n.start / len)}:${harmony.indexOf(c)}`;
      const first = !seenChord.has(chordKey);
      seenChord.add(chordKey);
      const pc = m12(n.pitch);
      const isStrong = strong.some((s) => Math.abs(pos - s) < 0.03);
      // a weak-beat note that anticipates the next chord (tumbao, pushes) is judged against that chord
      const nextC = chordAt(harmony, len, n.start + 1.01);
      const anticipates = !isStrong && nextC !== c && chordInfo(nextC).core.has(pc);
      if ((isStrong || n.dur >= 1.5 || first) && !anticipates) {
        res.bass.total++;
        if (ci.core.has(pc) || (ci.power && (pc === ci.root || pc === m12(ci.root + 7)))) res.bass.ok++;
        else issue(`bass ${pat.name} @${n.start}: pc ${pc} vs ${c.name}`);
      } else if (n.dur > 0.3 && !ex.jazz && !ci.all.has(pc) && !anticipates) {
        res.bass.total++;
        const grind = [...ci.all].some((ct) => m12(pc - ct) === 1 || m12(ct - pc) === 1 && !keyPcs.has(ct));
        if (!grind || (ex.metal && ci.power)) res.bass.ok++;
        else issue(`bass ${pat.name} @${n.start}: weak-beat grind pc ${pc} vs ${c.name}`);
      }
    }
  }
  // (b) upper parts against the chord(s) they sound over
  for (const role of ['chords', 'pad', 'lead', 'arp']) {
    for (const pat of byRole[role] || []) {
      useHarmonyOf(pat);
      for (const n of notesOf(pat)) {
        const pc = m12(n.pitch);
        const onBeat = Math.abs(n.start - Math.round(n.start)) < 0.02;
        const passing = n.dur <= 0.3 + EPS && !onBeat && (role === 'lead' || role === 'arp');
        // chords this note sounds over (by more than 0.1 beat), the onset chord always included
        const spans = [];
        for (let k = Math.floor(n.start / len) - 0; k * len < n.start + n.dur; k++) {
          for (const c of harmony) {
            const a = Math.max(n.start, k * len + c.startBeat), b = Math.min(n.start + n.dur, k * len + c.startBeat + c.durBeats);
            if (b - a > 0.1 + EPS || (n.start >= k * len + c.startBeat - EPS && n.start < k * len + c.startBeat + c.durBeats - EPS)) spans.push({ c, a, b });
          }
        }
        let worst = 'chord';
        let worstC = null;
        const rank = { chord: 0, tension: 1, avoid: 2, clash: 3 };
        for (const { c, a } of spans) {
          let cls = classify(pc, chordInfo(c), keyPcs, ex);
          // chord / pad anticipation of the next chord (pushes): judged against the chord it anticipates
          if ((role === 'chords' || role === 'pad') && cls !== 'chord') {
            const nxt = chordAt(harmony, len, n.start + 0.5 + 0.01);
            const nextStart = Math.ceil((n.start - EPS) / 0.5) * 0.5;
            if (nxt !== c && chordInfo(nxt).all.has(pc) && a < nextStart + 0.6) cls = 'chord';
          }
          if (ex.sidestep && role === 'chords' && n.dur <= 0.25 + EPS) cls = cls === 'clash' ? 'tension' : cls;
          if (rank[cls] > rank[worst]) { worst = cls; worstC = c; }
        }
        // chords / pads must be chord tones (or anticipations); melodies may use tensions
        let ok = role === 'chords' || role === 'pad' ? worst === 'chord' || (worst === 'tension' && ex.sidestep) : worst === 'chord' || worst === 'tension';
        if (!ok && passing && worst !== 'clash') ok = true;
        if (!ok && passing && worst === 'clash' && n.dur <= 0.26) ok = true; // 16th-note chromatic passing tone
        res.notes.total++;
        if (ok) res.notes.ok++;
        else issue(`${role} ${pat.name} @${n.start} pitch ${n.pitch} ${worst} vs ${worstC?.name}`);
        if (worst === 'clash' && !passing) { res.notes.clash++; if (n.dur >= 0.5) res.notes.clashSustained++; }
      }
    }
  }
  // (c) voicings + (d) overlaps in the chord / pad tracks
  for (const role of ['chords', 'pad']) {
    for (const pat of byRole[role] || []) {
      useHarmonyOf(pat);
      const ns = notesOf(pat);
      const onsets = [...new Set(ns.map((n) => Math.round(n.start * 100) / 100))];
      for (const t of onsets) {
        const sounding = ns.filter((n) => n.start <= t + 0.05 && n.start + n.dur > t + 0.05).map((n) => n.pitch).sort((a, b) => a - b);
        const uniq = [...new Set(sounding)];
        if (uniq.length < 2) continue;
        res.voicing.total++;
        res.voicing.maxNotes = Math.max(res.voicing.maxNotes, uniq.length);
        let bad = uniq.length > 6 ? `${uniq.length} notes` : null;
        for (let i = 1; i < uniq.length && !bad; i++) {
          const lo = uniq[i - 1], d = uniq[i] - lo;
          if (d === 1 && lo < 60) bad = `semitone ${lo}-${uniq[i]} below C4`;
          else if (d === 2 && lo < 55) bad = `whole tone ${lo}-${uniq[i]} below G3`;
          else if (d <= 4 && lo < 50) bad = `third ${lo}-${uniq[i]} below D3`;
        }
        const pcs = new Set(uniq.map(m12));
        const c = chordAt(harmony, len, t + 0.05);
        if (!bad && pcs.has(m12(c.root + 3)) && pcs.has(m12(c.root + 4)) && !(ex.jazz && chordInfo(c).dominant)) bad = 'major+minor 3rd';
        if (bad) issue(`${role} ${pat.name} @${t}: ${bad} [${uniq.join(' ')}]`);
        else res.voicing.ok++;
      }
      // overlap: every 1/8 beat, the sounding notes must all belong to one chord (current, or the next = push)
      for (let t = 0; t < pat.length - EPS; t += 0.125) {
        const s = ns.filter((n) => n.start <= t + 0.01 && n.start + n.dur > t + 0.03);
        if (s.length < 2) continue;
        const pcs = [...new Set(s.map((n) => m12(n.pitch)))];
        const cur = chordInfo(chordAt(harmony, len, t + 0.01));
        const nxt = chordInfo(chordAt(harmony, len, t + 1));
        const prv = chordInfo(chordAt(harmony, len, t - 0.26));
        const fits = (ci) => pcs.every((p) => ci.all.has(p));
        const shortOnes = s.every((n) => n.dur <= 0.25 + EPS);
        res.overlap.total++;
        if (fits(cur) || fits(nxt) || fits(prv) || (ex.sidestep && shortOnes)) res.overlap.ok++;
        else issue(`${role} ${pat.name} overlap @${t}: [${pcs.join(',')}]`);
      }
    }
  }
  // register: lead above pad
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const leadP = (byRole.lead || []).flatMap((p) => notesOf(p).map((n) => n.pitch));
  const padP = (byRole.pad || []).flatMap((p) => notesOf(p).map((n) => n.pitch));
  res.register = { leadMedian: med(leadP), padMedian: med(padP), padTop: padP.length ? Math.max(...padP) : null };
  return res;
}

export const ratio = (x) => (x.total ? x.ok / x.total : 1);
