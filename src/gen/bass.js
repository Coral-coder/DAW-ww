// Bassline generator: idiomatic styles following a progression (from harmony.generateProgression).
import { createRng, clamp } from '../core/util.js';
import { createNote, DRUM_PITCH } from '../core/model.js';
import { mod12, scalePitchClasses, getChordType } from '../theory/index.js';
import { getGenre } from './genres.js';
import { resolveKey } from './harmony.js';

/** Bass style ids with a short description (for UI pickers). */
export const BASS_STYLES = {
  root: 'Whole-note roots', pop: 'Pop: root pulse with pickups', rock: 'Rock: driving 8th-note roots', house: 'House: bouncy off-beat groove',
  deep: 'Deep house: round syncopated sub', tech: 'Tech: short syncopated stabs with octaves', offbeat: 'Trance/eurobeat off-beat 8ths',
  rolling: 'Techno rolling 16ths between kicks', psy: 'Psytrance K-B-B-B 16ths', hardstyle: 'Hardstyle reverse/off-beat bass',
  sub: 'Long sub following chords / kick', 808: '808: long notes on the kick with glides', drill: 'Drill: sliding 808s',
  reese: 'Reese: long sustained notes', wobble: 'Dubstep wobble rhythm', acid: 'Acid 303: 16ths with accents & slides',
  walking: 'Jazz walking quarter notes', reggae: 'Reggae: melodic with space', dub: 'Dub: heavy, sparse, deep', funk: 'Funk slap: syncopated 16ths, ghost notes & octave pops',
  disco: 'Disco octaves', synthwave: 'Synthwave pulsing 8ths', metal: 'Metal 16th chugs', tumbao: 'Latin tumbao (anticipated)',
  bossa: 'Bossa root–fifth', blues: 'Boogie-woogie walking shuffle', gospel: 'Gospel walk-ups', country: 'Country root–fifth boom-chick',
  dembow: 'Reggaeton: 808 with the dembow kick', afro: 'Afrobeats syncopation', 'log-drum': 'Amapiano log drum with slides',
  garage: 'UK garage skippy sub', 'boom-bap': 'Boom bap: follows the kick', 'neo-soul': 'Neo-soul: melodic, ghost notes & slides',
  chip: 'Chiptune octave arps', drone: 'Drone: sustained roots', cinematic: 'Cinematic: long roots with octave pulses',
};

const B = (t, d, iv = 0, v = 0.85, extra = {}) => ({ t, d, iv, v, ...extra });

// Bar templates: iv is a semitone offset from the chord root, or a token: 'oct', '5', '3', 'b7', 'next', 'appr'
const TEMPLATES = {
  pop: [[B(0, 0.75), B(1.5, 0.5), B(2, 0.75), B(3, 0.5), B(3.5, 0.45, 'appr', 0.7)]],
  rock: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => B(t, 0.45, i === 7 ? 'appr' : 0, i % 2 ? 0.75 : 0.9))],
  house: [
    [B(0.5, 0.4), B(1.25, 0.2, 'oct', 0.6), B(1.5, 0.4), B(2.5, 0.4), B(3.25, 0.2, '5', 0.6), B(3.5, 0.4)],
    [B(0.5, 0.4), B(1.5, 0.4), B(1.75, 0.2, 'oct', 0.6), B(2.5, 0.4), B(3.5, 0.3), B(3.75, 0.2, 'oct', 0.6)],
  ],
  deep: [[B(0, 0.75), B(1.5, 0.5, 0, 0.75), B(2.75, 0.75), B(3.5, 0.25, 'oct', 0.6)]],
  tech: [
    [B(0.5, 0.25), B(0.75, 0.2, 'oct', 0.6), B(1.5, 0.25), B(2.5, 0.25), B(2.75, 0.2, 0, 0.6), B(3.5, 0.25, 'oct', 0.7)],
    [B(0.25, 0.25, 0, 0.7), B(0.75, 0.25), B(1.75, 0.25, 'oct', 0.6), B(2.5, 0.25), B(3.25, 0.25, '5', 0.6)],
  ],
  offbeat: [[B(0.5, 0.4), B(1.5, 0.4), B(2.5, 0.4), B(3.5, 0.4)]],
  rolling: [[0, 1, 2, 3].flatMap((b) => [B(b + 0.5, 0.2, 0, 0.75), B(b + 0.75, 0.2, 0, 0.6)])],
  psy: [[0, 1, 2, 3].flatMap((b) => [B(b + 0.25, 0.2, 0, 0.8), B(b + 0.5, 0.2, 0, 0.65), B(b + 0.75, 0.2, 0, 0.7)])],
  hardstyle: [[0, 1, 2, 3].map((b) => B(b + 0.5, 0.45, 0, 0.9))],
  wobble: [
    [B(0, 0.75, 0, 1), B(0.75, 0.25, 0, 0.8), B(1, 0.5, 'oct'), B(1.5, 0.5), B(2, 1, 0, 0.95), B(3, 1 / 3, 0, 0.8), B(3 + 1 / 3, 1 / 3, 'oct', 0.8), B(3 + 2 / 3, 1 / 3, 0, 0.8)],
    [B(0, 1.5, 0, 1), B(1.5, 0.25, 'oct', 0.7), B(1.75, 0.25), B(2.5, 0.5, 1, 0.8), B(3, 1, 0, 0.9)],
  ],
  reggae: [
    [B(0, 0.9, 0, 0.9), B(1.5, 0.4, '3', 0.7), B(2, 0.5, '5', 0.8), B(2.5, 0.5, 0, 0.75), B(3.5, 0.4, 'appr', 0.65)],
    [B(0.5, 0.5, 0, 0.8), B(1, 0.5, '5', 0.7), B(2, 0.9, 0, 0.9), B(3, 0.4, 'b7', 0.7), B(3.5, 0.4, '5', 0.7)],
  ],
  dub: [[B(0, 1.25, 0, 0.95), B(1.5, 0.5, 0, 0.8), B(2.5, 0.4, '5', 0.75), B(3, 0.5, 'b7', 0.7), B(3.5, 0.45, 0, 0.8)]],
  funk: [[
    B(0, 0.3, 0, 1), B(0.5, 0.12, 0, 0.25, { ghost: true }), B(0.75, 0.2, 'oct', 0.75), B(1.5, 0.2, 'b7', 0.7),
    B(1.75, 0.2, 'oct', 0.8), B(2.25, 0.2, 0, 0.75), B(2.5, 0.12, 0, 0.25, { ghost: true }), B(2.75, 0.2, '5', 0.7),
    B(3, 0.25, 0, 0.85), B(3.5, 0.2, 'oct', 0.8), B(3.75, 0.2, 'appr', 0.65),
  ]],
  disco: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => B(t, 0.4, i % 2 ? 'oct' : 0, i % 2 ? 0.75 : 0.9))],
  synthwave: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => B(t, 0.42, 0, i % 2 ? 0.7 : 0.88))],
  tumbao: [[B(1.5, 1.5, '5', 0.85), B(3, 1, 'next', 0.9)]],
  bossa: [[B(0, 1.5, 0, 0.9), B(1.5, 0.5, '5', 0.7), B(2, 1.5, '5', 0.85), B(3.5, 0.5, 0, 0.7)]],
  country: [[B(0, 0.9, 0, 0.9), B(2, 0.9, '5', 0.8)], [B(0, 0.9, 0, 0.9), B(2, 0.9, '5', 0.8), B(3.5, 0.4, 'appr', 0.65)]],
  afro: [[B(0, 0.5, 0, 0.9), B(0.75, 0.25, 0, 0.7), B(1.5, 0.5, '5', 0.8), B(2.5, 0.5, 0, 0.8), B(3, 0.25, 'oct', 0.7), B(3.5, 0.5, '3', 0.75)]],
  'log-drum': [
    [B(0.75, 0.4, 0, 0.9), B(1.5, 0.3, 'oct', 0.75), B(2.25, 0.5, 0, 0.85, { slide: '5' }), B(3, 0.25, 0, 0.7), B(3.5, 0.4, 'oct', 0.8)],
    [B(0, 0.4, 0, 0.85), B(0.75, 0.3, 0, 0.8), B(1.75, 0.5, '5', 0.8, { slide: 0 }), B(2.75, 0.25, 'oct', 0.75), B(3.25, 0.5, 0, 0.8)],
  ],
  garage: [[B(0, 0.75, 0, 0.9), B(0.75, 0.25, 'oct', 0.65), B(1.75, 0.5, 0, 0.8), B(2.5, 0.5, 0, 0.85), B(3.25, 0.25, 'oct', 0.6), B(3.5, 0.45, '5', 0.75)]],
  'boom-bap': [[B(0, 0.75, 0, 0.9), B(1.75, 0.25, 0, 0.7), B(2.5, 1, 0, 0.85), B(3.5, 0.4, 'appr', 0.65)]],
  'neo-soul': [[B(0, 0.75, 0, 0.9), B(1, 0.1, 0, 0.25, { ghost: true }), B(1.5, 0.5, '5', 0.75), B(2.25, 0.25, 'b7', 0.7), B(2.5, 0.5, 'oct', 0.8, { slide: 0 }), B(3.5, 0.45, 'appr', 0.7)]],
  chip: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => B(t, 0.3, i % 2 ? 'oct' : 0, 0.8))],
  dembow: [[B(0, 0.9, 0, 0.95), B(1, 0.9, 0, 0.85), B(2, 0.9, 0, 0.9), B(3, 0.9, 0, 0.85)]],
};

function bassRoot(pc, lo) {
  // lowest instance of pc that is >= lo
  return lo + mod12(pc - lo);
}

function chordToneOffset(chord, token) {
  const iv = getChordType(chord.type).intervals;
  switch (token) {
    case 'oct': return 12;
    case '5': return iv.find((i) => i === 7 || i === 6 || i === 8) ?? 7;
    case '3': return iv.find((i) => i >= 2 && i <= 5) ?? 4;
    case 'b7': return iv.find((i) => i === 10 || i === 11 || i === 9) ?? 10;
    default: return typeof token === 'number' ? token : 0;
  }
}

/**
 * generateBassline({progression, style, genre, key, scale, rng, seed, octave=2, density=0.8, beatsPerBar=4,
 *   length, kickNotes (drum Note[] or beat numbers to lock to), range}) -> Note[]
 */
export function generateBassline(opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const genre = getGenre(opts.genre);
  const style = opts.style || genre?.bassStyle || 'root';
  const progression = opts.progression || [];
  if (!progression.length) return [];
  const { root: keyRoot, scale } = resolveKey(opts);
  const bpb = opts.beatsPerBar || 4;
  const length = opts.length ?? progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const density = clamp(opts.density ?? 0.8, 0, 1);
  const octave = opts.octave ?? 2;
  const lo = opts.range?.[0] ?? ((octave + 1) * 12 - 5); // octave 2 -> 31 (G1)
  const scalePcs = scalePitchClasses(keyRoot, scale);
  const out = [];
  const push = (pitch, start, dur, vel) => {
    if (start < -1e-6 || start >= length - 1e-6) return;
    const s = Math.max(0, start);
    const d = Math.max(0.05, Math.min(dur, length - s));
    out.push(createNote(Math.round(pitch), Math.round(s * 10000) / 10000, Math.round(d * 10000) / 10000, Math.round(clamp(vel, 0.05, 1) * 100) / 100));
  };
  const chordAt = (t) => progression.find((c) => t >= c.startBeat - 1e-6 && t < c.startBeat + c.durBeats - 1e-6) || progression[progression.length - 1];
  const nextChordAfter = (c) => {
    const i = progression.indexOf(c);
    return progression[(i + 1) % progression.length];
  };
  const rootPitch = (c) => bassRoot(c.chord.root, lo);
  const approach = (c, t) => {
    // chromatic or diatonic approach to the next chord root
    const nxt = chordAt(t + 0.5 + 1e-3);
    const target = rootPitch(nxt === c ? nextChordAfter(c) : nxt);
    const below = target - 1;
    const above = target + 1;
    const diatonicBelow = [target - 2, target - 1].find((p) => scalePcs.includes(mod12(p)));
    return rng.chance(0.5) ? (rng.chance(0.5) ? below : above) : diatonicBelow ?? below;
  };
  const kickTimes = (opts.kickNotes || []).map((k) => (typeof k === 'number' ? k : k.pitch === DRUM_PITCH.kick ? k.start : null)).filter((t) => t != null).sort((a, b) => a - b);

  const bars = Math.ceil(length / bpb);
  const resolveIv = (c, h, t) => {
    if (h.iv === 'appr') return approach(c, t);
    if (h.iv === 'next') return rootPitch(chordAt(t + 1 + 1e-3));
    return rootPitch(c) + chordToneOffset(c.chord, h.iv);
  };

  const fromTemplate = (name) => {
    const variants = TEMPLATES[name];
    const v0 = rng.int(0, variants.length - 1);
    for (let b = 0; b < bars; b++) {
      const tpl = variants[b % 2 && variants.length > 1 && rng.chance(0.4) ? (v0 + 1) % variants.length : v0];
      for (const h of tpl) {
        if (h.t >= bpb) continue;
        const t = b * bpb + h.t;
        if (t >= length) continue;
        // density thins weak, short hits (never the downbeat)
        if (h.t !== 0 && h.v < 0.8 && rng() > density + 0.15) continue;
        const c = chordAt(t);
        const pitch = resolveIv(c, h, t);
        const end = c.startBeat + c.durBeats;
        const dur = name === 'tumbao' ? h.d : Math.min(h.d, Math.max(0.1, end - t));
        push(pitch, t, dur, h.ghost ? h.v : h.v * (0.9 + rng() * 0.1));
        if (h.slide !== undefined) {
          // overlapping second note = legato glide on mono synths
          const sp = rootPitch(c) + chordToneOffset(c.chord, h.slide);
          push(sp, t + dur * 0.6, dur * 0.6, h.v * 0.85);
        }
      }
    }
  };

  switch (style) {
    case 'root':
    case 'drone':
      for (const c of progression) push(rootPitch(c), c.startBeat, c.durBeats * 0.98, style === 'drone' ? 0.65 : 0.85);
      break;
    case 'reese':
      for (const c of progression) {
        if (c.durBeats >= bpb * 2 && rng.chance(0.5)) {
          push(rootPitch(c), c.startBeat, c.durBeats / 2, 0.9);
          push(rootPitch(c) + (rng.chance(0.5) ? 12 : chordToneOffset(c.chord, '5')), c.startBeat + c.durBeats / 2, c.durBeats / 2 - 0.02, 0.85);
        } else push(rootPitch(c), c.startBeat, c.durBeats - 0.02, 0.9);
      }
      break;
    case 'cinematic':
      for (const c of progression) {
        push(rootPitch(c), c.startBeat, c.durBeats - 0.02, 0.8);
        if (density > 0.7) for (let t = 0; t < c.durBeats; t += 0.5) push(rootPitch(c) + 12, c.startBeat + t, 0.4, t % 1 === 0 ? 0.7 : 0.5);
      }
      break;
    case 'sub':
    case '808':
    case 'drill':
    case 'metal': {
      let hits = kickTimes.filter((t) => t < length);
      if (!hits.length) {
        const defaults = {
          sub: [0, 2.5], 808: [0, 2.5, 3.5], drill: [0, 1.5, 2.75], metal: [0, 0.25, 0.5, 1, 1.25, 1.5, 2, 2.25, 2.5, 3, 3.25, 3.5],
        }[style];
        hits = [];
        for (let b = 0; b < bars; b++) for (const t of defaults) hits.push(b * bpb + t);
        if (style === 'sub') hits = progression.map((c) => c.startBeat);
      }
      // ensure each chord change gets a note
      for (const c of progression) if (!hits.some((t) => Math.abs(t - c.startBeat) < 1e-6)) hits.push(c.startBeat);
      hits = [...new Set(hits.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
      for (let i = 0; i < hits.length; i++) {
        const t = hits[i];
        const next = hits[i + 1] ?? length;
        const c = chordAt(t);
        let p = rootPitch(c);
        if (style === 'metal') {
          p = bassRoot(c.chord.root, 28);
          push(p, t, Math.min(0.22, next - t), (t % 1 === 0 ? 0.95 : 0.75));
          continue;
        }
        const chordEnd = c.startBeat + c.durBeats;
        let dur = Math.min(next, chordEnd) - t;
        if (style === 'sub') { push(p, t, Math.max(0.1, dur - 0.02), 0.85); continue; }
        // 808: occasional octave jump on later hits within a chord
        if (t > c.startBeat + 1e-6 && rng.chance(0.25)) p += rng.chance(0.6) ? 12 : chordToneOffset(c.chord, '5');
        push(p, t, Math.max(0.15, dur - 0.02), 0.95);
        const slideChance = style === 'drill' ? 0.55 : 0.2;
        if (dur >= 1 && rng.chance(slideChance)) {
          // glide: overlapping note into a neighbour (drill loves minor 3rd / b2 / 5th slides)
          const targetIv = rng.pick(style === 'drill' ? [3, 1, 7, -2, 12] : [12, 7, -5]);
          const sp = p + targetIv;
          const st = t + dur * rng.pick([0.5, 0.75]);
          push(sp, st, t + dur - st, 0.9);
        }
      }
      break;
    }
    case 'acid': {
      const steps = Math.round(length / 0.25);
      const scaleOffsets = [0, 0, 0, 12, 7, 10, 3, 5, -2, 12, 0];
      for (let i = 0; i < steps; i++) {
        const t = i * 0.25;
        if (i % 4 !== 0 && rng() > 0.45 + density * 0.4) continue;
        const c = chordAt(t);
        let p = rootPitch(c) + rng.pick(scaleOffsets);
        if (!scalePcs.includes(mod12(p))) p = rootPitch(c);
        const accent = i % 4 === 0 || rng.chance(0.25);
        const slide = rng.chance(0.2);
        push(p, t, slide ? 0.35 : 0.18, accent ? 1 : 0.6);
      }
      break;
    }
    case 'walking': {
      for (const c of progression) {
        const beats = Math.max(1, Math.round(c.durBeats));
        const r = rootPitch(c);
        const tones = getChordType(c.chord.type).intervals.map((i) => r + (i % 12)).filter((p, k, a) => a.indexOf(p) === k);
        let prev = r;
        for (let k = 0; k < beats; k++) {
          const t = c.startBeat + k;
          if (t >= length) break;
          let p;
          if (k === 0) p = r;
          else if (k === beats - 1) p = approach(c, t);
          else {
            // step through chord/scale tones, ascending or descending
            const dir = rng.chance(0.6) ? 1 : -1;
            const cands = [];
            for (let d = 1; d <= 4; d++) {
              const q = prev + d * dir;
              if (tones.some((x) => mod12(x) === mod12(q)) || (scalePcs.includes(mod12(q)) && d <= 2)) cands.push(q);
            }
            p = cands.length ? cands[0] : prev + 2 * dir;
          }
          while (p < lo) p += 12;
          while (p > lo + 19) p -= 12;
          push(p, t, 0.92, k === 0 ? 0.9 : 0.75 + rng() * 0.1);
          prev = p;
        }
      }
      break;
    }
    case 'blues': {
      // boogie: root 3 5 6 b7 6 5 3 on swung 8ths (triplet positions)
      const fig = [0, 4, 7, 9, 10, 9, 7, 4];
      for (let b = 0; b < bars; b++) {
        for (let k = 0; k < Math.min(8, bpb * 2); k++) {
          const t = b * bpb + Math.floor(k / 2) + (k % 2 ? 2 / 3 : 0);
          if (t >= length) continue;
          const c = chordAt(t);
          push(rootPitch(c) + fig[k], t, k % 2 ? 0.3 : 0.6, k % 2 ? 0.7 : 0.88);
        }
      }
      break;
    }
    case 'gospel': {
      for (const c of progression) {
        const r = rootPitch(c);
        for (let k = 0; k < c.durBeats; k++) {
          const t = c.startBeat + k;
          const last = k === Math.ceil(c.durBeats) - 1;
          if (last && c.durBeats >= 2) {
            // chromatic walk-up 8ths into the next root
            const target = rootPitch(chordAt(c.startBeat + c.durBeats + 1e-3));
            push(target - 2, t, 0.45, 0.7);
            push(target - 1, t + 0.5, 0.45, 0.75);
          } else push(k % 2 ? r + 7 : r, t, 0.9, k === 0 ? 0.9 : 0.75);
        }
      }
      break;
    }
    case 'synthwave':
      fromTemplate('synthwave');
      // octave flicks for movement
      for (const n of out) if (rng.chance(0.12 * density) && n.start % 1 !== 0) n.pitch += 12;
      break;
    default:
      fromTemplate(TEMPLATES[style] ? style : 'pop');
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return out;
}
