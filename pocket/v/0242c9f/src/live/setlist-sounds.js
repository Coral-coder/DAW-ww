// Setlist sound freshness (pure, Node-testable): SOUND ROTATION (each layer swaps to a genre-appropriate
// alternative for its role every few phrases, at musically sensible boundaries, at most 2 layers per boundary,
// loudness-matched with mix.js) and SETTINGS DRIFT (bounded random walks of a sound's filter / envelope / space /
// width / drive params across phrases, with bigger moves at section changes). Driven by planPhrase()
// (src/live/setlist-engine.js); the runner writes swaps at the boundary and drift as `inst:<key>` automation lanes
// (so a hand-moved knob overrides its lane and stops drifting — automation-recorder's `overridden`).
import { clamp } from '../core/util.js';
import { PRESETS, resolveInstrumentDef } from '../audio/presets.js';
import { INSTRUMENT_DEFS } from '../audio/defs.js';
import { STRUDEL_PATCHES } from '../audio/strudel-patches.js';
import { DRUM_MACHINES } from '../audio/library/drum-machines.js';
import { DRUM_KITS } from '../audio/kits.js';
import { GENRES, getGenre } from '../gen/genres.js';
import { mixTrack } from '../gen/mix.js';
import { mixInstrument } from '../gen/orchestra.js';

/** Track role -> mix.js role (same table as the generator's ROLE_INFO.mix). */
const MIX_ROLE = { perc: 'drums', top: 'drums', impact: 'drums', sub: 'bass', counter: 'lead', vox: 'lead', chop: 'lead', strings: 'pad', texture: 'pad', organ: 'pad', brass: 'chords', guitar: 'chords', stabs: 'chords', color: 'arp', bells: 'arp' };
export const mixRoleOf = (role) => MIX_ROLE[role] || role;

/** Track role -> pool kind (null: no rotation by default — sub, vox, strings, guitars, organ, brass, perc, impacts). */
const POOL_ROLE = { lead: 'lead', counter: 'lead', chop: 'chop', bass: 'bass', chords: 'chords', stabs: 'chords', pad: 'pad', texture: 'pad', arp: 'arp', color: 'arp', bells: 'arp', fx: 'fx', drums: 'drums' };

/** Phrases between swaps per layer category [min, max] (at Freshness 50 %). */
export const SOUND_RATE = { lead: [2, 4], arp: [2, 3], fx: [2, 3], chords: [4, 8], pad: [4, 8], bass: [6, 12], drums: [8, 14], perc: [8, 14] };
/** Most layers swapped at one boundary (section starts / key moves); 1 elsewhere. */
export const MAX_SWAPS = 2;

/** Alternate sampled machines per genre family (all loudness-measured in mix.js LEVEL_FIX). */
const FAMILY_MACHINES = {
  house: ['RolandTR909', 'RolandTR808', 'LinnLM1', 'OberheimDMX'], techno: ['RolandTR909', 'RolandTR606', 'RolandTR808', 'YamahaRX5'],
  trance: ['RolandTR909', 'RolandTR808', 'RolandTR606'], garage: ['RolandTR909', 'RolandTR808', 'OberheimDMX'], hard: ['RolandTR909', 'RolandTR606', 'YamahaRX5'],
  industrial: ['YamahaRX5', 'RolandTR606', 'RolandTR909'], hiphop: ['RolandTR808', 'AkaiMPC60', 'EmuSP12', 'OberheimDMX'], bass: ['RolandTR808', 'RolandTR909', 'AkaiMPC60'],
  dnb: ['AkaiMPC60', 'EmuSP12', 'OberheimDMX', 'LinnDrum'], breaks: ['OberheimDMX', 'AkaiMPC60', 'EmuSP12', 'LinnDrum'], soul: ['AkaiMPC60', 'EmuSP12', 'LinnLM1'],
  chill: ['AkaiMPC60', 'EmuSP12', 'RolandCompurhythm78', 'KorgMinipops'], pop: ['RolandTR808', 'LinnDrum', 'RolandTR909'], retro: ['LinnDrum', 'OberheimDMX', 'LinnLM1', 'RolandCompurhythm78'],
  funk: ['LinnLM1', 'LinnDrum', 'OberheimDMX'], rock: ['AlesisSR16', 'AlesisHR16'], latin: ['AlesisHR16', 'AlesisSR16'], ambient: ['KorgMinipops', 'RolandCompurhythm78'],
  experimental: ['RolandTR909', 'RolandTR606', 'CasioRZ1'],
};
/** Soft e-pianos never carry a dance hook (strudel-sounds.js hookSafe). */
const SOFT_KEYS = new Set(['sd-rhodes', 'sd-fm-epiano', 'sd-lofi-keys']);
const DANCE_FAMILIES = new Set(['house', 'techno', 'trance', 'garage', 'breaks', 'bass', 'dnb', 'hard']);

export function soundKey(def) {
  if (!def) return '';
  if (def.type === 'drums' || def.type === 'drumsampler') return `m:${def.params?.machine || def.preset || def.params?.kit || ''}`;
  return `${def.type}:${def.preset || def.params?.instrument || def.params?.name || ''}`;
}
export function soundName(def) {
  if (!def) return '—';
  if (def.type === 'drums' || def.type === 'drumsampler') return DRUM_MACHINES[def.params?.machine]?.name || DRUM_KITS[def.preset]?.name || def.preset || 'Drums';
  return PRESETS[def.preset]?.name || def.params?.name || def.params?.instrument || def.preset || def.type;
}
const strudelDef = (id) => ({ type: 'strudel', preset: id, params: {}, fallbackPreset: PRESETS[id]?.fallbackPreset || null });
const presetDef = (id) => ({ type: PRESETS[id].instrument.type, preset: id, params: {} });

const baseCache = new Map();
/** Fully resolved params of a def (preset ← def.params), cached per sound. */
export function baseParams(def) {
  const k = soundKey(def) + (def?.params && Object.keys(def.params).length ? JSON.stringify(def.params) : '');
  if (!baseCache.has(k)) { let r; try { r = resolveInstrumentDef(def); } catch { r = { type: def?.type, params: {} }; } baseCache.set(k, r); }
  return baseCache.get(k);
}

const lg = (x) => Math.log2(Math.max(1e-4, x));
/** Higher = more alike (oscillator, brightness, envelope, space). */
export function soundSimilarity(a, b) {
  if (a.type === 'drums' || b.type === 'drums') return a.params?.machine === b.params?.machine ? 10 : DRUM_MACHINES[a.params?.machine]?.kit === DRUM_MACHINES[b.params?.machine]?.kit ? 1 : 0;
  const A = baseParams(a).params, B = baseParams(b).params;
  const f = (p) => (p.lpf ?? p.cutoff ?? 20000);
  let s = (A.s && A.s === B.s ? 2 : 0) + (a.type === b.type ? 1 : 0);
  s -= Math.abs(lg(f(A)) - lg(f(B))) * 0.4;
  s -= Math.abs(lg(A.attack ?? 0.005) - lg(B.attack ?? 0.005)) * 0.25;
  s -= Math.abs(lg(A.release ?? 0.1) - lg(B.release ?? 0.1)) * 0.25;
  s -= Math.abs((A.room ?? 0) - (B.room ?? 0)) * 1.5;
  return s;
}

/**
 * Genre-appropriate alternatives for a layer's role: curated Strudel patches by role + genre tags (exact genre
 * first, then the genre's family), same-role built-in presets as fallback, ordered by similarity to `cur`.
 * Includes `cur` (first). Drums: alternate sampled machines of the genre family.
 */
export function soundPool(role, genreId, cur, max = 6) {
  const kind = POOL_ROLE[role];
  if (!kind || !cur) return cur ? [cur] : [];
  const g = getGenre(genreId) || {};
  const fam = g.family;
  if (kind === 'drums') {
    if (cur.type !== 'drums' || !cur.params?.machine) return [cur];
    const ms = [...new Set([cur.params.machine, ...(FAMILY_MACHINES[fam] || [])])].filter((m) => DRUM_MACHINES[m]);
    return ms.map((m) => {
      if (m === cur.params.machine) return cur;
      const kit = DRUM_KITS[DRUM_MACHINES[m].kit] ? DRUM_MACHINES[m].kit : cur.preset;
      return { type: 'drums', preset: kit, params: { ...cur.params, kit, machine: m } };
    });
  }
  const famIds = new Set(Object.entries(GENRES).filter(([, x]) => x.family && x.family === fam).map(([id]) => id));
  const score = (genres) => (genres.includes(genreId) ? 3 : 0) + (genres.some((x) => famIds.has(x) || x === fam) ? 1 : 0);
  const dance = DANCE_FAMILIES.has(fam);
  const okPatch = (p) => {
    if (kind === 'chop') return !!p.patch.vowel;
    if (!p.roles.includes(kind)) return false;
    if (dance && kind === 'lead' && SOFT_KEYS.has(p.id)) return false;
    return true;
  };
  const curKey = soundKey(cur);
  const items = [];
  for (const p of STRUDEL_PATCHES) if (okPatch(p)) items.push({ def: strudelDef(p.id), sc: score(p.genres) + 0.5 });
  if (kind !== 'chop') {
    for (const [id, pr] of Object.entries(PRESETS)) {
      if (pr.strudel || !pr.roles?.includes(kind) || pr.instrument.type === 'drums' || pr.instrument.type === 'soundfont') continue;
      items.push({ def: presetDef(id), sc: score(pr.genres || []) });
    }
  }
  const cand = items.filter((x) => soundKey(x.def) !== curKey).map((x) => ({ ...x, sim: soundSimilarity(cur, x.def) }));
  cand.sort((a, b) => b.sc - a.sc || b.sim - a.sim);
  let pick = cand.filter((x) => x.sc >= 1).slice(0, max - 1);
  // thin genres: top up with same-role sounds closest to the current one
  if (pick.length < 2) pick = pick.concat(cand.filter((x) => !pick.includes(x)).sort((a, b) => b.sim - a.sim).slice(0, 3 - pick.length));
  pick.sort((a, b) => b.sim - a.sim);
  return [cur, ...pick.map((x) => x.def)];
}

/** mix.js fader for a sound in a role/genre (what the generator would set). */
export function mixLevel(genreId, role, def) {
  const t = { fx: [], sends: {} };
  mixTrack(t, { genre: genreId, role: mixRoleOf(role), instrument: mixInstrument(def), drumTrackId: 'drums', buses: [] });
  return t.volume;
}
const db = (r) => 20 * Math.log10(Math.max(1e-6, r));

// ------------------------------------------------------------------------------------------------ drift

/**
 * Drift specs per instrument type: mode 'oct' (multiplicative, range in octaves) or 'add'; [lo, hi] = musically safe
 * bounds (intersected with the param def's min/max); `when` = the sound uses this control; `kind` = section bias group.
 */
const has = (k) => (p, raw) => raw[k] !== undefined;
const filt = (p) => (p.lpf ?? 20000) < 20000;
export const DRIFT_SPECS = {
  strudel: {
    lpf: { mode: 'oct', range: 1.1, lo: 180, hi: 14000, when: filt, kind: 'bright' },
    resonance: { mode: 'add', range: 3, lo: 0, hi: 16, when: filt, kind: 'bite' },
    lpenv: { mode: 'add', range: 1.2, lo: -6, hi: 6, when: (p) => filt(p) && !!p.lpenv, kind: 'bright' },
    attack: { mode: 'oct', range: 1, lo: 0.001, hi: 1.5, when: has('attack'), kind: 'attack' },
    release: { mode: 'oct', range: 1, lo: 0.02, hi: 4, when: has('release'), kind: 'tail' },
    delay: { mode: 'add', range: 0.12, lo: 0, hi: 0.6, when: (p) => p.delay > 0, kind: 'space' },
    room: { mode: 'add', range: 0.15, lo: 0, hi: 0.85, when: (p) => p.room > 0, kind: 'space' },
    detune: { mode: 'add', range: 0.08, lo: 0.02, hi: 0.5, when: (p) => p.s === 'supersaw', kind: 'width' },
    spread: { mode: 'add', range: 0.15, lo: 0.2, hi: 1, when: (p) => p.s === 'supersaw', kind: 'width' },
    shape: { mode: 'add', range: 0.1, lo: 0, hi: 0.5, when: (p) => p.shape > 0, kind: 'drive' },
    fm: { mode: 'oct', range: 0.6, lo: 0.05, hi: 8, when: (p) => p.fm > 0, kind: 'bright' },
  },
  synth: {
    cutoff: { mode: 'oct', range: 1.1, lo: 180, hi: 14000, when: (p) => (p.cutoff ?? 20000) < 18000, kind: 'bright' },
    resonance: { mode: 'add', range: 0.12, lo: 0, hi: 0.8, when: () => true, kind: 'bite' },
    fEnvAmount: { mode: 'add', range: 1, lo: -6, hi: 6, when: (p) => !!p.fEnvAmount, kind: 'bright' },
    attack: { mode: 'oct', range: 1, lo: 0.001, hi: 1.5, when: () => true, kind: 'attack' },
    release: { mode: 'oct', range: 1, lo: 0.02, hi: 4, when: () => true, kind: 'tail' },
    unisonDetune: { mode: 'add', range: 8, lo: 0, hi: 60, when: (p) => p.unison > 1, kind: 'width' },
    drive: { mode: 'add', range: 0.1, lo: 0, hi: 0.6, when: (p) => p.drive > 0, kind: 'drive' },
  },
};
/** Pull on the walk at a section start: breakdown darker / longer / wetter, drop brighter / tighter / drier. */
const SECTION_BIAS = {
  breakdown: { bright: -0.7, tail: 0.6, space: 0.6, attack: 0.4, bite: -0.2, drive: -0.3, width: 0.3 },
  drop: { bright: 0.6, tail: -0.5, space: -0.4, attack: -0.4, bite: 0.3, drive: 0.3, width: 0.2 },
  intro: { bright: -0.35, space: 0.25 },
  build: { bright: 0.15, width: 0.15 },
  groove: { bright: 0.05 },
};
const gauss = (rng) => (rng() + rng() + rng() - 1.5) * 1.15;

/** Value of a drifted param: base moved by `o` (−1..1 × amount) within the spec range ∩ the def's min/max. */
export function driftValue(base, o, spec, pdef) {
  const lo = Math.max(spec.lo, pdef?.min ?? -Infinity), hi = Math.min(spec.hi, pdef?.max ?? Infinity);
  const b = clamp(base, lo, hi);
  const v = spec.mode === 'oct' ? b * 2 ** (o * spec.range) : b + o * spec.range;
  const r = clamp(v, lo, hi);
  return Math.round(r * (Math.abs(r) >= 100 ? 1 : 10000)) / (Math.abs(r) >= 100 ? 1 : 10000);
}
/** {key: {spec, def}} the sound drifts. */
export function driftTargets(def) {
  const { type, params } = baseParams(def);
  const specs = DRIFT_SPECS[type];
  if (!specs) return {};
  const pdefs = Object.fromEntries((INSTRUMENT_DEFS[type]?.params || []).map((p) => [p.key, p]));
  const raw = { ...(PRESETS[def.preset]?.instrument.params || {}), ...(def.params || {}) };
  const out = {};
  for (const [k, spec] of Object.entries(specs)) if (pdefs[k] && pdefs[k].type === 'number' && spec.when(params, raw)) out[k] = { spec, def: pdefs[k], base: Number(params[k] ?? pdefs[k].default) };
  return out;
}

// ------------------------------------------------------------------------------------------------ per-layer state

/** Initial sound state of a layer. */
export function initSound(layer, track, genreId) {
  const cur = track.instrument ? JSON.parse(JSON.stringify(track.instrument)) : null;
  // production doublings (Lead Octave, Strings Layer …) follow their source layer's sound instead of rotating
  const pool = layer.layerOf ? (cur ? [cur] : []) : soundPool(layer.role, genreId, cur);
  return {
    rotate: pool.length > 1, drift: DRIFT_SPECS[cur?.type] ? 0.5 : 0, cur, pool, hist: [soundKey(cur)], nextAt: null, now: false,
    offsets: {}, values: {}, touched: [], level: mixLevel(genreId, layer.role, cur), swaps: 0,
  };
}
const freshScale = (f) => 2 ** ((0.5 - f) * 2); // rotation interval multiplier: 0.5 -> 1, 1 -> 0.5, 0 -> 2

function interval(l, f, rng) {
  const [a, b] = SOUND_RATE[l.category] || SOUND_RATE.chords;
  return Math.max(1, Math.round(rng.int(a, b) * freshScale(f)));
}

/** The sound a layer would swap to next (most similar not recently used, not used by another layer). */
export function nextSound(state, l) {
  const s = l.sound;
  if (!s || s.pool.length < 2) return null;
  const K = Math.min(s.pool.length - 1, 3);
  const recent = new Set(s.hist.slice(-K));
  const inUse = new Set(state.layers.filter((x) => x !== l && x.sound).map((x) => soundKey(x.sound.cur)));
  const curKey = soundKey(s.cur);
  let c = s.pool.filter((d) => soundKey(d) !== curKey && !recent.has(soundKey(d)));
  if (!c.length) c = s.pool.filter((d) => soundKey(d) !== curKey);
  const free = c.filter((d) => !inUse.has(soundKey(d)));
  if (free.length) c = free;
  return c.slice().sort((a, b) => soundSimilarity(s.cur, b) - soundSimilarity(s.cur, a))[0] || null;
}

/** The user picked a sound by hand: adopt it, stop rotating this layer. */
export function adoptSound(state, layerId, def, genreId = state.genre) {
  const l = state.layers.find((x) => x.id === layerId);
  if (!l?.sound || !def) return;
  const s = l.sound;
  s.cur = JSON.parse(JSON.stringify(def));
  s.pool = soundPool(l.role, genreId, s.cur);
  s.hist.push(soundKey(s.cur));
  s.rotate = false;
  s.values = {}; s.offsets = {};
  s.level = mixLevel(genreId, l.role, s.cur);
}

/** Queue "next sound now" for the next phrase boundary. */
export function queueNextSound(state, layerId) {
  const l = state.layers.find((x) => x.id === layerId);
  if (l?.sound && l.sound.pool.length > 1) l.sound.now = true;
}

/** UI summary: {name, rotate, drift, next: {name, in} | null}. */
export function soundInfo(state, layerId) {
  const l = state?.layers.find((x) => x.id === layerId);
  if (!l?.sound) return null;
  const s = l.sound;
  const nx = s.rotate && !l.lock && (state.freshness ?? 0.5) > 0 ? nextSound(state, l) : null;
  return {
    name: soundName(s.cur), rotate: s.rotate, drift: s.drift, canRotate: s.pool.length > 1, canDrift: !!DRIFT_SPECS[s.cur?.type],
    next: nx ? { name: soundName(nx), in: s.now ? 1 : Math.max(1, (s.nextAt ?? state.index + 1) - state.index) } : null,
  };
}

/**
 * Sound plan of one phrase (mutates the layers' sound state). Returns {layerId: {swap: {def, name, levelDb} | null,
 * drift: {key: {from, to}}}}. ctx: {index, section, firstOfSection, keyChanged, active:Set, overridden: {id: [keys]}, rng(id)}.
 */
export function planSounds(state, ctx) {
  const { index, section, firstOfSection, keyChanged, active } = ctx;
  const f = state.freshness ?? 0.5;
  const out = {};
  for (const l of state.layers) if (l.sound) out[l.id] = { swap: null, drift: {} };
  // ---- rotation
  if (f > 0 || state.layers.some((l) => l.sound?.now)) {
    const sensibleBoundary = (firstOfSection && section !== 'build') || keyChanged;
    const due = [];
    for (const l of state.layers) {
      const s = l.sound;
      if (!s || s.pool.length < 2 || l.lock) { if (s) s.now = false; continue; }
      if (s.nextAt == null) s.nextAt = index + interval(l, f, ctx.rng(l.id, 'int0'));
      if (!s.now && (!s.rotate || f <= 0 || index === 0 || index < s.nextAt)) continue;
      const silent = !active.has(l.id);
      const overdue = index - s.nextAt;
      if (!s.now && !silent && !sensibleBoundary && overdue < 2) continue;
      if (!s.now && section === 'build' && !silent && overdue < 4) continue; // the riser is no place for a new sound
      due.push({ l, pri: (s.now ? 100 : 0) + (silent ? 10 : 0) + (sensibleBoundary ? 5 : 0) + overdue });
    }
    due.sort((a, b) => b.pri - a.pri);
    const cap = sensibleBoundary ? MAX_SWAPS : 1;
    for (const { l } of due.slice(0, cap)) {
      const s = l.sound;
      const nx = nextSound(state, l);
      s.now = false;
      if (!nx) continue;
      const lv = mixLevel(state.genre, l.role, nx);
      out[l.id].swap = { def: JSON.parse(JSON.stringify(nx)), name: soundName(nx), levelDb: Math.round(db(lv / s.level) * 100) / 100, prev: soundName(s.cur) };
      out[l.id].prevValues = s.values;
      s.cur = JSON.parse(JSON.stringify(nx));
      s.level = lv;
      s.hist.push(soundKey(nx));
      if (s.hist.length > 16) s.hist.shift();
      s.values = {};
      s.swaps++;
      s.nextAt = index + interval(l, f, ctx.rng(l.id, 'int'));
      // doublings of this layer take the same new sound (same boundary, not counted as a separate swap)
      for (const d of state.layers) {
        if (d.layerOf !== l.id || !d.sound || d.lock) continue;
        const ds = d.sound, dl = mixLevel(state.genre, d.role, nx);
        out[d.id].swap = { def: JSON.parse(JSON.stringify(nx)), name: soundName(nx), levelDb: Math.round(db(dl / ds.level) * 100) / 100, prev: soundName(ds.cur), follow: true };
        out[d.id].prevValues = ds.values;
        ds.cur = JSON.parse(JSON.stringify(nx)); ds.level = dl; ds.values = {}; ds.hist.push(soundKey(nx)); ds.swaps++;
      }
    }
  }
  // ---- drift
  const bias = firstOfSection ? SECTION_BIAS[section] || {} : {};
  const amtScale = Math.min(1.5, f * 2);
  for (const l of state.layers) {
    const s = l.sound;
    if (!s || !s.cur) continue;
    const o = out[l.id];
    for (const k of ctx.overridden?.[l.id] || []) if (!s.touched.includes(k)) s.touched.push(k);
    const targets = driftTargets(s.cur);
    if (l.lock || index === 0) continue; // a locked layer holds its sound and settings exactly
    const amt = s.drift * amtScale;
    const rng = ctx.rng(l.id, 'drift');
    const prevVals = o.prevValues || null;
    delete o.prevValues;
    for (const [k, { spec, def, base }] of Object.entries(targets)) {
      const prevO = s.offsets[k] ?? 0;
      let off = prevO * 0.88 + gauss(rng) * 0.4 + (bias[spec.kind] || 0);
      off = clamp(off, -1, 1);
      if (amt > 0) s.offsets[k] = off;
      if (s.touched.includes(k)) continue;
      const to = driftValue(base, (amt > 0 ? off : prevO) * amt, spec, def);
      const from = s.values[k] ?? driftValue(base, prevO * amt, spec, def);
      s.values[k] = to;
      if (amt > 0 || from !== to || o.swap) o.drift[k] = { from, to };
    }
    // a swap leaves lanes of controls the new sound doesn't drift: park them on the new sound's own value
    if (prevVals) {
      const { params } = baseParams(s.cur);
      for (const k of Object.keys(prevVals)) if (!targets[k] && !s.touched.includes(k) && typeof params[k] === 'number') o.drift[k] = { from: params[k], to: params[k], reset: true };
    }
  }
  return out;
}

export { db as ratioDb };
