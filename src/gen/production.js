// Production layer for generated songs (pure, deterministic): what turns a correctly written arrangement into a
// record. Used by src/gen/song.js (see the wiring notes in docs/SOUND.md "Realism pipeline").
//
//  * realInstrument(def, role, genre)  — acoustic parts stream real multisampled instruments (Salamander, VSCO-2,
//    VCSL…, MusyngKite / FluidR3 fallbacks, the synth preset as the offline fallback); call it where the
//    instrument is chosen (before the mix, so level tables see the final instrument).
//  * finishSong(song, {genre, seed})  — after the parts are written: per-part download ranges, performance
//    expression (src/gen/expression.js), per-preset insert FX (chorus on pads, delay on plucks, drive on basses),
//    layered doubles (pad + real strings, lead + octave), the space (reverb character per genre) and a
//    genre-targeted mastering chain.
//  * presetFxChain(presetId, {genre}) — the insert FX a producer would put on a preset, as [type, params] pairs.
//  * masterChainFor(genre) / spaceFor(genre) — mastering targets and reverb characters per genre.
import { createRng, clamp, uid } from '../core/util.js';
import { createEffect, createTrack, createPattern, createClip } from '../core/model.js';
import { getGenre } from './genres.js';
import { applyExpression } from './expression.js';
import { PRESET_GM, realInstrumentDef, multisampleFor, DEFAULT_SOUNDFONT_LIBRARY } from '../audio/library/instrument-map.js';

const ELECTRONIC_FAMILIES = new Set(['house', 'techno', 'trance', 'bass', 'dnb', 'garage', 'breaks', 'hard', 'experimental', 'industrial', 'retro']);
/** Presets kept as synths in electronic genres (their character is the synth). */
const SYNTH_IN_ELECTRONIC = new Set(['electric-piano', 'brass-lead', 'brass-section', 'guitar-dist', 'clav', 'steel-drum', 'celesta', 'choir-pad']);

/**
 * Upgrade an instrument def to the best real sample source (mutates nothing; returns a new def or the input).
 * GM soundfont defs gain the multisample + MusyngKite sources; synth presets that imitate an acoustic instrument
 * (grand-piano, strings, flute, upright-bass, guitar-*, brass-*, vibraphone…) become the real instrument with the
 * preset as fallback. opts.soundfonts === false keeps everything synthesized.
 */
export function realInstrument(def, role, genreId, opts = {}) {
  if (!def || opts.soundfonts === false || role === 'drums' || role === 'fx') return def;
  const g = getGenre(genreId);
  const electronic = ELECTRONIC_FAMILIES.has(g?.family);
  if (def.type === 'soundfont' && def.params?.instrument && !def.params.url) {
    const up = realInstrumentDef(def.params.instrument, { role, fallbackPreset: def.fallbackPreset || null });
    const { library, instrument, multisample, ...rest } = def.params; // keep playing params (attack / release …)
    return { ...up, params: { ...up.params, ...rest } };
  }
  const gm = PRESET_GM[def.preset];
  if (!gm || (electronic && SYNTH_IN_ELECTRONIC.has(def.preset))) return def;
  // basses in electronic music stay synths unless they are explicitly acoustic
  if (role === 'bass' && electronic && def.preset !== 'upright-bass') return def;
  return realInstrumentDef(gm, { role, fallbackPreset: def.preset, params: SAMPLE_PARAMS[gm] || {} });
}

/** Playing params for sampled instruments (attack / release s) — like src/gen/sound.js SF_PARAMS. */
const SAMPLE_PARAMS = {
  string_ensemble_1: { attack: 0.08, release: 0.6 }, choir_aahs: { attack: 0.12, release: 0.8 }, brass_section: { attack: 0.02, release: 0.25 },
  trumpet: { attack: 0.01, release: 0.2 }, acoustic_grand_piano: { release: 0.5 }, electric_piano_1: { release: 0.45 }, vibraphone: { release: 0.9 },
  orchestral_harp: { release: 1 }, acoustic_bass: { release: 0.12 }, electric_bass_finger: { release: 0.1 }, flute: { attack: 0.03, release: 0.25 },
  marimba: { release: 0.3 }, kalimba: { release: 0.4 }, electric_guitar_clean: { release: 0.3 }, overdriven_guitar: { release: 0.2 }, distortion_guitar: { release: 0.2 },
};

// ------------------------------------------------------------------------------------------- insert FX per preset
const fx = (type, params) => [type, params];
/** Insert FX a producer reaches for on each preset (applied before the mix chain). */
export function presetFxChain(presetId, { genre } = {}) {
  const id = String(presetId || '');
  const g = getGenre(genre);
  const lofi = ['lofi-hip-hop', 'boom-bap', 'chillwave', 'trip-hop'].includes(g?.id);
  if (/^(warm-pad|string-pad|ambient-pad|dark-pad|detuned-pad|synthwave-pad|juno-strings|supersaw-pad|glass-pad)$/.test(id)) {
    return [fx('chorus', { rate: 0.35, depth: 0.45, delay: 0.014, spread: 1, mix: id === 'supersaw-pad' ? 0.2 : 0.35 })];
  }
  if (/^(pluck|arp-pluck|arp-saw|house-stab|future-chords|koto|chords)$/.test(id)) {
    return [fx('delay', { sync: true, division: id === 'house-stab' ? '1/8D' : '1/16D', feedback: 0.22, pingpong: true, lowcut: 500, highcut: 6000, mix: 0.14 })];
  }
  if (/^(saw-bass|reese-bass|acid-bass|moog-bass|synthwave-bass|wobble-bass|pluck-bass|dub-bass|chip-bass)$/.test(id)) {
    return [fx('saturator', { type: 'warm', drive: id === 'reese-bass' || id === 'wobble-bass' ? 6 : 4, tone: 9000, output: -2, mix: 0.45 })];
  }
  if (id === '808-bass' || id === 'sub-bass') {
    // harmonics so the sub reads on small speakers
    return [fx('saturator', { type: 'tube', drive: 5, tone: 7000, output: -2.5, mix: 0.35 })];
  }
  if (/^(saw-lead|square-lead|supersaw-lead|trance-lead|sync-lead|hoover|acid-lead)$/.test(id)) {
    return [fx('saturator', { type: 'soft', drive: 3, tone: 12000, output: -1.5, mix: 0.4 }), fx('chorus', { rate: 0.6, depth: 0.25, delay: 0.01, spread: 1, mix: 0.18 })];
  }
  if (/^(electric-piano|fm-epiano|lofi-keys|electric_piano_1|electric_piano_2)$/.test(id)) {
    // suitcase stereo tremolo + a touch of chorus
    return [fx('autopan', { sync: true, division: '1/4', depth: 0.22 }), fx('chorus', { rate: 0.5, depth: 0.3, delay: 0.012, spread: 1, mix: lofi ? 0.3 : 0.2 })];
  }
  if (/^(guitar-clean|electric_guitar_clean|electric_guitar_jazz)$/.test(id)) {
    return [fx('chorus', { rate: 0.7, depth: 0.2, delay: 0.008, spread: 1, mix: 0.15 })];
  }
  if (/^(bell|fm-bell-lead|celesta|music-box|kalimba|vibraphone|marimba)$/.test(id)) {
    return [fx('delay', { sync: true, division: '1/8D', feedback: 0.25, pingpong: true, lowcut: 400, highcut: 5000, mix: 0.12 })];
  }
  return [];
}

// ------------------------------------------------------------------------------------------- space & master
/** Reverb character per genre (space = the room the record was made in). */
export function spaceFor(genreId) {
  const g = getGenre(genreId);
  const id = g?.id, f = g?.family;
  if (['ambient', 'cinematic'].includes(id) || f === 'ambient') return { character: 'hall', damping: 0.45 };
  if (['jazz', 'blues', 'bossa-nova', 'salsa', 'funk', 'soul', 'gospel', 'country', 'folk'].includes(id) || f === 'jazz') return { character: 'chamber', damping: 0.55 };
  if (f === 'rock' || ['punk', 'metal', 'indie', 'disco'].includes(id)) return { character: 'room', damping: 0.5 };
  if (['pop', 'kpop', 'rnb', 'neo-soul', 'synthwave', 'chillwave'].includes(id)) return { character: 'plate', damping: 0.5 };
  if (f === 'hiphop' || ['trap', 'drill', 'phonk', 'boom-bap', 'lofi-hip-hop'].includes(id)) return { character: 'plate', damping: 0.6 };
  return { character: 'hall', damping: 0.5 }; // electronic: big, smooth
}

/** Integrated-loudness target (LUFS) per genre and the mastering settings that hit it from the generator's mix. */
export function masterChainFor(genreId) {
  const g = getGenre(genreId);
  const id = g?.id, f = g?.family;
  let lufs = -10;
  if (['ambient', 'cinematic'].includes(id) || f === 'ambient') lufs = -16;
  else if (f === 'jazz' || ['jazz', 'bossa-nova', 'blues', 'folk', 'country', 'gospel', 'soul', 'neo-soul', 'lofi-hip-hop', 'downtempo', 'trip-hop'].includes(id)) lufs = -14;
  else if (['house', 'techno', 'trance', 'bass', 'dnb', 'hard', 'garage', 'breaks', 'industrial'].includes(f) || ['hardstyle', 'brostep', 'dubstep', 'psytrance', 'eurobeat'].includes(id)) lufs = -9.5;
  else if (f === 'rock' || ['metal', 'punk'].includes(id)) lufs = -10;
  const acoustic = lufs <= -14;
  return {
    lufs,
    params: {
      low: acoustic || f === 'hiphop' ? 0 : 0.5, // 808 genres already carry plenty of sub
      tilt: acoustic ? 0.2 : 0.4,
      air: acoustic ? 1 : 1.5,
      glueThreshold: acoustic ? -20 : -18, glueRatio: acoustic ? 1.4 : 1.7, glueAttack: 0.03, glueRelease: 0.3,
      drive: acoustic ? 0.5 : 2,
      width: acoustic ? 1.05 : 1.15, widthFreq: 2500,
      ceiling: -0.3, release: lufs >= -10 ? 0.09 : 0.14, // the limiter holds peaks ~1 dB under the ceiling: -0.3 lands true peak near -1.3 dBTP
    },
  };
}

/**
 * Master bus for a generated song: the mastering device with its drive set from `preLufs` (the loudness of the
 * mix before mastering, measured or estimated) so the result lands on the genre target.
 */
export function createMasterChain(genreId, { preLufs = -16 } = {}) {
  const m = masterChainFor(genreId);
  // the glue + limiter take back ~0.4 dB of every dB pushed in (measured on main sections, see docs/SOUND.md)
  const d = m.lufs - preLufs;
  const gain = clamp(d * 1.4 + 0.5, 0, 14);
  return [createEffect('mastering', { ...m.params, gain: Math.round(gain * 10) / 10 })];
}

// ------------------------------------------------------------------------------------------- layers
const LAYER_GENRES = {
  pad: new Set(['trance', 'progressive-house', 'future-bass', 'liquid-dnb', 'chillwave', 'synthwave', 'kpop', 'eurobeat', 'deep-house', 'pop']),
  lead: new Set(['trance', 'progressive-house', 'future-bass', 'eurobeat', 'hardstyle', 'kpop', 'synthwave', 'psytrance']),
};

/**
 * Layered doubles (adds tracks to the song): pads get a real string ensemble underneath (-9 dB), synth leads an
 * octave-up double on a brighter synth (-10 dB). Each layer copies its source track's clips with its own patterns,
 * so it follows the arrangement exactly. Returns the added tracks.
 */
export function addLayers(song, { genre } = {}) {
  const g = getGenre(genre || song.genre);
  const added = [];
  const layer = (src, { name, instrument, transpose = 0, gainDb, pan = src.pan }) => {
    const t = createTrack({ name, color: src.color, volume: Math.round(clamp(src.volume * 10 ** (gainDb / 20), 0.01, 1.5) * 1000) / 1000, pan, role: src.role, instrument, sends: { ...src.sends } });
    t.layerOf = src.id;
    t.fx = (src.fx || []).filter((f) => ['eq8', 'compressor', 'ducker', 'pump', 'widener'].includes(f.type)).map((f) => ({ ...f, id: uid('fx'), params: { ...f.params } }));
    const map = new Map();
    for (const c of song.clips.filter((c) => c.trackId === src.id)) {
      if (!map.has(c.patternId)) {
        const p = song.patterns[c.patternId];
        const np = createPattern(t.id, { name: `${name} – ${p.name.split(' – ').slice(1).join(' – ') || p.name}`, length: p.length, color: src.color, notes: p.notes.map((n) => ({ ...n, id: uid('n'), pitch: n.pitch + transpose })) });
        song.patterns[np.id] = np;
        if (song.patternHarmony?.[c.patternId]) song.patternHarmony[np.id] = song.patternHarmony[c.patternId];
        map.set(c.patternId, np.id);
      }
      song.clips.push(createClip(t.id, { patternId: map.get(c.patternId), start: c.start, length: c.length, offset: c.offset, name: c.name }));
    }
    t.activePatternId = map.get(src.activePatternId) || [...map.values()][0] || null;
    for (const sc of song.scenes || []) if (sc.slots?.[src.id] && map.has(sc.slots[src.id])) sc.slots[t.id] = map.get(sc.slots[src.id]);
    song.tracks.push(t);
    added.push(t);
    return t;
  };
  const pad = song.tracks.find((t) => t.role === 'pad' && !t.layerOf);
  if (pad && LAYER_GENRES.pad.has(g.id) && !/string|choir/.test(pad.instrument?.params?.instrument || pad.instrument?.preset || '')) {
    layer(pad, { name: 'Strings Layer', instrument: realInstrumentDef('string_ensemble_1', { role: 'pad', fallbackPreset: 'strings', params: { attack: 0.15, release: 0.8 } }), gainDb: -8 });
  }
  const lead = song.tracks.find((t) => t.role === 'lead' && !t.layerOf);
  if (lead && LAYER_GENRES.lead.has(g.id) && lead.instrument?.type === 'synth') {
    layer(lead, { name: 'Lead Octave', instrument: { type: 'synth', preset: lead.instrument.preset === 'square-lead' ? 'saw-lead' : 'square-lead', params: {} }, transpose: 12, gainDb: -11 });
  }
  return added;
}

// ------------------------------------------------------------------------------------------- the whole pass
/** MIDI range [lo, hi] of every note a track plays (null when it plays none). */
export function trackRange(song, trackId) {
  let lo = 127, hi = 0;
  for (const p of Object.values(song.patterns)) if (p.trackId === trackId) for (const n of p.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  return hi >= lo ? [lo, hi] : null;
}

/**
 * After generation: expression, per-part ranges, preset FX, layers, space, master (mutates `song`).
 * opts: {genre, seed, expression=true, layers=true, presetFx=true, master=true, preLufs}
 * Returns a report {expression, layers: [names], ranges: {track: [lo, hi]}, sampled: n tracks on real samples}.
 */
export function finishSong(song, opts = {}) {
  const genre = opts.genre || song.genre;
  const seed = opts.seed ?? song.seed ?? 1;
  const report = { layers: [], ranges: {}, sampled: 0 };
  if (opts.expression !== false) report.expression = applyExpression(song, { genre, rng: createRng((seed * 2654435761) >>> 0) });
  if (opts.layers !== false) report.layers = addLayers(song, { genre }).map((t) => t.name);
  for (const t of song.tracks) {
    const inst = t.instrument;
    if (inst?.type === 'soundfont' && inst.params?.multisample) {
      const r = trackRange(song, t.id);
      if (r) { inst.params.range = r; report.ranges[t.name] = r; }
      report.sampled++;
    }
    if (opts.presetFx !== false && !t.layerOf) {
      const key = inst?.type === 'soundfont' ? inst.params?.instrument : inst?.preset;
      const chain = presetFxChain(key, { genre }).map(([type, params]) => createEffect(type, params));
      if (chain.length) {
        // colour before the mix chain (EQ / dynamics / sidechain stay last)
        const firstMix = t.fx.findIndex((f) => ['eq8', 'compressor', 'ducker', 'pump'].includes(f.type));
        t.fx.splice(firstMix < 0 ? t.fx.length : firstMix, 0, ...chain);
      }
    }
  }
  const sp = spaceFor(genre);
  for (const b of song.buses || []) for (const f of b.fx || []) if (f.type === 'reverb') { f.params.character = sp.character; f.params.damping = sp.damping; }
  if (opts.master !== false && song.master) {
    song.master.fx = createMasterChain(genre, { preLufs: opts.preLufs ?? estimatePreLufs(genre) });
    report.master = masterChainFor(genre).lufs;
  }
  return report;
}

/**
 * Effective loudness of the generator's mix before mastering (LUFS) per family / id: measured on 16 bars of the main
 * section (drop / chorus / head) rendered headless with the master bypassed, then calibrated so the mastering drive
 * lands on masterChainFor().lufs (transient-heavy mixes lose more to the limiter, so they read a little quieter
 * here than their raw pre-master loudness). 'acoustic': fallback for the -14 / -16 LUFS genres. Re-measure when the
 * mix levels change.
 */
export const PRE_MASTER_LUFS = { default: -16.5, acoustic: -18.6, house: -17, trance: -16.1, pop: -15.8, hiphop: -16.6, jazz: -18.6 };
export function estimatePreLufs(genreId) {
  const g = getGenre(genreId);
  return PRE_MASTER_LUFS[g?.id] ?? PRE_MASTER_LUFS[g?.family] ?? (masterChainFor(genreId).lufs <= -14 ? PRE_MASTER_LUFS.acoustic : PRE_MASTER_LUFS.default);
}

export { multisampleFor, DEFAULT_SOUNDFONT_LIBRARY };
