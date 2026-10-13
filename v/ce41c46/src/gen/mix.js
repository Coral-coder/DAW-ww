// Mix for generated songs (pure): gain staging by role, panning, insert chains (EQ / dynamics / saturation /
// sidechain / width), bus sends, the song's Reverb + Delay buses and a gentle master chain.
// Effect param keys are exactly those of src/audio/effect-defs.js.
import { createEffect, createBus } from '../core/model.js';
import { clamp, dbToGain } from '../core/util.js';
import { getGenre } from './genres.js';

/** Mix balance by role in dB, for loudness-normalised instruments (see LEVEL_FIX); drums / bass peak around -4..-6 dBFS. */
export const ROLE_TRIM_DB = { drums: -4.5, bass: -4.5, chords: -6.5, pad: -9.5, lead: -7, arp: -11.5, fx: -12 };
/** Global fader offset: leaves the master limiter ~1 dB of work at most (measured, see report). */
export const MIX_HEADROOM_DB = -2;
/** Genres whose arrangements leave more peak headroom (sparser / less transient-stacked) sit closer to unity (dB). */
const HEADROOM_BY_FAMILY = { techno: 1.5, house: 0.5, trance: 0.5, dnb: 0.5, garage: 0.5, breaks: 0.5, soul: -0.5, chill: -0.5, rock: -0.5, latin: -0.5, jazz: -0.5 };
/** Sub-heavy basses read low on a K-weighted meter but carry most of the energy: anchor them a little lower. */
const SUB_BASSES = new Set(['808-bass', 'sub-bass', 'reese-bass', 'wobble-bass', 'dub-bass']);

/**
 * Loudness normalisation per instrument (dB to reach -16 LUFS on a standard role phrase at unity fader), measured
 * by rendering every generator instrument headless (drum machines at 4-on-the-floor + backbeat + 8th hats, bass 8ths,
 * chords / pads / lead / arp phrases). Keys: 'role|preset', 'role|sf:<gm name>', 'machine:<drum machine>'. 'sf:' keys
 * are measured on the source generated songs actually stream (multisample set via realInstrument, else MusyngKite).
 * Acoustic kits (VCSL, SR-16) carry +7 / +4 dB on top of the probe: their in-song ride / brush / ghost patterns and
 * velocity layers read lower than the probe groove. Distorted rhythm guitars carry -3 dB: in-song power-chord 8ths are
 * denser than the probe phrase and buried the lead. Re-measure when presets change (presets are re-balanced separately).
 */
export const LEVEL_FIX = {
  "arp|arp-pluck": 6.5, "arp|arp-saw": 5, "arp|harp": 3, "arp|sf:orchestral_harp": 0.2, "bass|808-bass": -3.9,
  "bass|acid-bass": -3, "bass|chip-bass": -2.3, "bass|dub-bass": -4.4, "bass|finger-bass": -0.4, "bass|fm-bass": -3,
  "bass|moog-bass": -1.9, "bass|pluck-bass": -5.2, "bass|reese-bass": -5.7, "bass|saw-bass": -2.1,
  "bass|sf:acoustic_bass": -2.4, "bass|sf:contrabass": -2.4, "bass|sf:electric_bass_finger": 3.4,
  "bass|sf:electric_bass_pick": -4.1, "bass|sf:slap_bass_1": 6.4, "bass|sub-bass": -2.8, "bass|synthwave-bass": -2.1,
  "bass|upright-bass": 0.4, "bass|wobble-bass": -7.7, "chords|bell": 1.5, "chords|celesta": 7.1, "chords|clav": 7.2,
  "chords|electric-piano": 3.4, "chords|future-chords": 0.3, "chords|glass-pad": 5.4, "chords|grand-piano": 8.4,
  "chords|guitar-clean": 3, "chords|guitar-dist": 2.8, "chords|house-stab": 5, "chords|lofi-keys": 0.6,
  "chords|organ-drawbar": -0.6, "chords|organ-rock": -2.1, "chords|pluck": 6.9, "chords|power-chord": 3,
  "chords|sf:acoustic_grand_piano": 0.6, "chords|sf:acoustic_guitar_nylon": 4.3,
  "chords|sf:acoustic_guitar_steel": 4.3, "chords|sf:clavinet": 0.5, "chords|sf:distortion_guitar": -8,
  "chords|sf:electric_guitar_clean": 8, "chords|sf:electric_guitar_muted": 4.8, "chords|sf:electric_piano_1": -7.3,
  "chords|sf:overdriven_guitar": -6, "chords|sf:steel_drums": -0.9, "chords|sf:string_ensemble_1": -1.4,
  "chords|steel-drum": 4.9, "chords|strings": 1.1, "chords|supersaw-pad": 2.8, "chords|synthwave-pad": 2.5,
  // club hooks sit under the kick / bass (tech house bleep, techno pluck, 303 lead): a few dB below the measured match
  "lead|strudel:sd-tech-bleep": -2.5, "lead|strudel:sd-techno-pluck": -2, "lead|strudel:sd-acid-lead": -1,
  "lead|acid-lead": 1.2, "lead|bell": 4.6, "lead|brass-lead": 1.7, "lead|brass-section": 4.8, "lead|chip-lead": 6.1,
  "lead|electric-piano": 7.3, "lead|flute": 2.1, "lead|fm-bell-lead": 8, "lead|fm-epiano": 7.4,
  "lead|grand-piano": 10, "lead|guitar-clean": 2.8, "lead|guitar-lead": 1.1, "lead|hoover": -2, "lead|kalimba": 9.1,
  "lead|marimba": 13.3, "lead|saw-lead": 1.5, "lead|sf:acoustic_grand_piano": 1.5, "lead|sf:alto_sax": 0.9,
  "lead|sf:brass_section": -0.4, "lead|sf:distortion_guitar": -1.2, "lead|sf:electric_guitar_clean": 9.3,
  "lead|sf:electric_guitar_jazz": 9.3, "lead|sf:fiddle": -0.5, "lead|sf:flute": 4, "lead|sf:french_horn": -1,
  "lead|sf:kalimba": 8.6, "lead|sf:marimba": 4, "lead|sf:overdriven_guitar": 1.9, "lead|sf:trumpet": 1.7,
  "lead|sf:vibraphone": 7.1, "lead|square-lead": 0.9, "lead|supersaw-lead": 4.9, "lead|sync-lead": 1.6,
  "lead|trance-lead": 4.8, "lead|vibraphone": 7.8, "lead|whistle-lead": 2.3, "machine:AkaiMPC60": -5.2,
  "machine:AlesisHR16": -7, "machine:AlesisSR16": 2.1, "machine:CasioRZ1": -2.1, "machine:EmuSP12": -3.9,
  "machine:KorgMinipops": -2.3, "machine:LinnDrum": -2.9, "machine:LinnLM1": -0.1, "machine:OberheimDMX": -1.4,
  "machine:RolandCompurhythm78": -1.9, "machine:RolandTR606": 0.1, "machine:RolandTR808": -1.3,
  "machine:RolandTR909": -5.3, "machine:VCSLAcoustic": 10.2, "machine:YamahaRX5": -0.1, "pad|ambient-pad": 0.8,
  "pad|brass-section": -0.2, "pad|choir-pad": 1.5, "pad|dark-pad": 0.8, "pad|fm-brass": 3, "pad|glass-pad": 4.9,
  "pad|juno-strings": 4.3, "pad|organ-drawbar": -0.4, "pad|organ-rock": -2.9, "pad|sf:brass_section": -2.6,
  "pad|sf:choir_aahs": -1.8, "pad|sf:string_ensemble_1": -2.1, "pad|sf:string_ensemble_2": -2.1,
  "pad|string-pad": 1.5, "pad|strings": 0.3, "pad|supersaw-pad": 1.5, "pad|warm-pad": 1.1
};

/** dB correction for an instrument in a role (clamped; unknown instruments: 0). */
export function levelFix(role, inst) {
  if (!inst) return 0;
  let k;
  if (role === 'drums') k = inst.params?.machine ? `machine:${inst.params.machine}` : null;
  else if (inst.type === 'strudel') {
    // Strudel patches are loudness-matched to their fallback preset (src/audio/strudel-patches.js): their own
    // 'role|strudel:<id>' entry when measured separately, else the fallback preset's
    k = `${role}|strudel:${inst.preset}`;
    if (LEVEL_FIX[k] === undefined) k = `${role}|${inst.fallbackPreset}`;
  } else k = `${role}|${inst.type === 'soundfont' ? `sf:${inst.params?.instrument}` : inst.preset}`;
  const v = k != null ? LEVEL_FIX[k] : undefined;
  // decaying sounds (bells, e-pianos, plucks, mallets) read quiet on a loudness meter but cut through on their
  // attacks: never boost them by more than a few dB
  return clamp(v ?? 0, -9, role === 'pad' ? 5 : role === 'drums' ? 11 : role === 'bass' ? 6 : role === 'arp' ? 3.5 : role === 'lead' ? 6 : 5);
}

/** High-pass (Hz) per role: everything except kick & bass leaves the low end alone. */
const ROLE_HPF = { chords: 140, pad: 240, lead: 200, arp: 260, fx: 300 };

const SIDECHAIN_FAMILIES = new Set(['house', 'techno', 'trance', 'garage']);
const SIDECHAIN_GENRES = new Set(['future-bass', 'dubstep', 'brostep', 'kpop', 'nu-disco', 'eurobeat', 'hardstyle', 'amapiano', 'synthwave', 'progressive-house', 'breakbeat']);
const TAPE_GENRES = new Set(['lofi-hip-hop', 'boom-bap', 'trip-hop', 'downtempo', 'chillwave', 'neo-soul', 'phonk']);
const DRIVE_GENRES = new Set(['techno', 'industrial', 'rock', 'punk', 'metal', 'drum-and-bass', 'jungle', 'breakbeat', 'tech-house', 'phonk', 'brostep', 'hardstyle']);

/** Reverb / delay character per genre: [decay s, predelay s, delay division, feedback, reverb send scale]. */
function spaceFor(g) {
  const id = g.id, f = g.family;
  if (['ambient', 'cinematic'].includes(id) || f === 'ambient') return { decay: 5.5, predelay: 0.03, division: '1/4D', feedback: 0.45, scale: 1.6 };
  if (['trance', 'psytrance', 'progressive-house', 'future-bass', 'chillwave', 'liquid-dnb'].includes(id)) return { decay: 3.6, predelay: 0.025, division: '1/8D', feedback: 0.4, scale: 1.2 };
  if (['dub', 'reggae'].includes(id)) return { decay: 2.6, predelay: 0.02, division: '1/4D', feedback: 0.55, scale: 1.1 };
  if (f === 'rock' || ['funk', 'disco', 'punk'].includes(id)) return { decay: 1.5, predelay: 0.012, division: '1/8', feedback: 0.25, scale: 0.6 };
  if (f === 'jazz' || ['bossa-nova', 'blues', 'salsa'].includes(id)) return { decay: 1.8, predelay: 0.015, division: '1/4', feedback: 0.25, scale: 0.75 };
  if (f === 'techno') return { decay: 2.8, predelay: 0.02, division: '1/8D', feedback: 0.35, scale: 0.8 };
  if (f === 'hiphop') return { decay: 1.9, predelay: 0.02, division: '1/8D', feedback: 0.3, scale: 0.8 };
  return { decay: 2.4, predelay: 0.02, division: '1/8D', feedback: 0.35, scale: 1 };
}

/** The song's return buses: a darker, high-passed reverb and a tempo-synced filtered ping-pong delay. */
export function createSongBuses(genreId) {
  const g = getGenre(genreId);
  const sp = spaceFor(g);
  const reverb = createBus('Reverb', [
    createEffect('reverb', { mix: 1, decay: sp.decay, size: clamp(sp.decay / 6, 0.35, 0.95), predelay: sp.predelay, damping: 0.55, lowcut: 280, highcut: 8500 }),
  ]);
  reverb.volume = 0.75;
  const delay = createBus('Delay', [
    createEffect('delay', { mix: 1, sync: true, division: sp.division, feedback: sp.feedback, pingpong: true, lowcut: 350, highcut: 4500 }),
  ]);
  delay.volume = 0.6;
  return [reverb, delay];
}

/** Master: glue compressor (slow attack, low ratio) into the limiter — the limiter only catches peaks. */
export function createSongMaster(genreId) {
  const g = getGenre(genreId);
  const acoustic = ['jazz', 'blues', 'latin', 'americana', 'cinematic', 'ambient'].includes(g.family);
  return {
    volume: 0.9,
    fx: [
      createEffect('compressor', { threshold: acoustic ? -14 : -12, ratio: 1.8, attack: 0.03, release: 0.25, knee: 10, makeup: 0, mix: 1 }),
      createEffect('limiter', { gain: 0, threshold: -1.5, release: 0.12, ceiling: -0.5 }),
    ],
    automation: [],
  };
}

const eqHpf = (hz, extra = {}) => createEffect('eq8', { b1On: true, b1Type: 'highpass', b1Freq: hz, b1Q: 0.75, ...extra });

/**
 * Configure one generated track's channel (mutates): volume, pan, fx, sends.
 * ctx: {genre, role, instrument, drumTrackId, buses:[reverb, delay], side (-1|1 for stereo spread), energy}
 */
export function mixTrack(track, ctx) {
  const g = getGenre(ctx.genre);
  const role = ctx.role;
  const sf = ctx.instrument?.type === 'soundfont';
  const sp = spaceFor(g);
  const side = ctx.side || 1;
  const sidechain = SIDECHAIN_FAMILIES.has(g.family) || SIDECHAIN_GENRES.has(g.id);
  const trim = (ROLE_TRIM_DB[role] ?? -6) + levelFix(role, ctx.instrument) + (role === 'bass' && SUB_BASSES.has(ctx.instrument?.type === 'strudel' ? ctx.instrument.fallbackPreset : ctx.instrument?.preset) ? -3 : 0)
    + (role === 'bass' && sidechain ? 3 : 0) // the ducker takes ~3 dB out on average
    + (role === 'bass' && sf ? (/acoustic_bass|contrabass/.test(ctx.instrument.params?.instrument) ? -5.5 : -3) : 0) // sampled basses sustain (walking / finger lines) and read hot in the mix
    + (role === 'drums' && ['cinematic', 'ambient'].includes(g.family) ? -4 : 0); // orchestral percussion supports, it doesn't lead
  track.volume = Math.round(clamp(0.8 * dbToGain(trim + (HEADROOM_BY_FAMILY[g.family] ?? MIX_HEADROOM_DB)), 0.02, 1.5) * 1000) / 1000;
  const fx = [];
  const sends = {};
  const [rev, dly] = ctx.buses || [];
  const send = (bus, v) => { if (bus && v > 0.005) sends[bus.id] = Math.round(clamp(v, 0, 1) * 100) / 100; };
  switch (role) {
    case 'drums': {
      track.pan = 0;
      fx.push(createEffect('compressor', { threshold: -16, ratio: 3, attack: 0.012, release: 0.14, knee: 6, makeup: 2, mix: 0.75 }));
      if (TAPE_GENRES.has(g.id)) fx.push(createEffect('tape', { drive: 3, tone: 9000, wow: 0.08, flutter: 0.08, mix: 1 }));
      else if (DRIVE_GENRES.has(g.id)) fx.push(createEffect('saturator', { type: 'warm', drive: 4, tone: 11000, output: -2, mix: 0.6 }));
      send(rev, 0.07 * sp.scale);
      break;
    }
    case 'bass': {
      track.pan = 0;
      fx.push(createEffect('eq8', { b1On: true, b1Type: 'highpass', b1Freq: 32, b1Q: 0.7, b8On: !sf, b8Type: 'lowpass', b8Freq: 7000 }));
      fx.push(createEffect('compressor', { threshold: -20, ratio: 4, attack: 0.006, release: 0.12, knee: 6, makeup: 2.5, mix: 1 }));
      if (DRIVE_GENRES.has(g.id) || TAPE_GENRES.has(g.id)) fx.push(createEffect('saturator', { type: 'tube', drive: 4, tone: 6000, output: -2, mix: 0.5 }));
      if (sidechain && ctx.drumTrackId) fx.push(createEffect('ducker', { sourceTrackId: ctx.drumTrackId, amount: 0.55, threshold: -22, attack: 0.003, release: 0.13 }));
      break;
    }
    case 'chords': {
      track.pan = sf && /guitar/.test(ctx.instrument.params?.instrument || '') ? -0.3 * side : -0.18 * side;
      fx.push(eqHpf(ROLE_HPF.chords, { b3On: true, b3Freq: 350, b3Gain: -2, b3Q: 1 }));
      if (sf) fx.push(createEffect('compressor', { threshold: -20, ratio: 2.5, attack: 0.01, release: 0.2, knee: 8, makeup: 1.5, mix: 1 }));
      if (TAPE_GENRES.has(g.id)) fx.push(createEffect('tape', { drive: 2, tone: 7500, wow: 0.22, flutter: 0.12, mix: 1 }));
      if (sidechain && ctx.drumTrackId) fx.push(createEffect('ducker', { sourceTrackId: ctx.drumTrackId, amount: 0.35, threshold: -22, attack: 0.004, release: 0.16 }));
      send(rev, 0.17 * sp.scale);
      if (['reggae', 'dub'].includes(g.id)) send(dly, 0.16);
      break;
    }
    case 'pad': {
      track.pan = 0;
      fx.push(eqHpf(ROLE_HPF.pad, { b3On: true, b3Freq: 400, b3Gain: -2.5, b3Q: 1, b7On: !sf, b7Type: 'highshelf', b7Freq: 7500, b7Gain: -2 }));
      if (sidechain && ctx.drumTrackId) fx.push(createEffect('pump', { division: '1/4', depth: 0.45, curve: 0.55, shape: 'classic' }));
      fx.push(createEffect('widener', { width: 1.55, monoBelow: 250 }));
      send(rev, 0.3 * sp.scale);
      break;
    }
    case 'lead': {
      track.pan = 0;
      fx.push(eqHpf(ROLE_HPF.lead, { b6On: true, b6Freq: 3200, b6Gain: sf ? 1.5 : 0, b6Q: 0.8 }));
      fx.push(createEffect('compressor', { threshold: -18, ratio: 2.5, attack: 0.008, release: 0.18, knee: 8, makeup: 1.5, mix: 1 }));
      // club leads breathe with the kick (a light duck, less than the bass / chords)
      if (sidechain && ctx.drumTrackId && ['house', 'techno'].includes(g.family)) fx.push(createEffect('ducker', { sourceTrackId: ctx.drumTrackId, amount: 0.25, threshold: -22, attack: 0.004, release: 0.15 }));
      send(rev, 0.2 * sp.scale);
      send(dly, 0.13);
      break;
    }
    case 'arp': {
      track.pan = 0.32 * side;
      fx.push(eqHpf(ROLE_HPF.arp, { b7On: true, b7Type: 'highshelf', b7Freq: 8000, b7Gain: -2 }));
      if (sidechain && ctx.drumTrackId) fx.push(createEffect('ducker', { sourceTrackId: ctx.drumTrackId, amount: 0.3, threshold: -22, attack: 0.004, release: 0.14 }));
      send(rev, 0.22 * sp.scale);
      send(dly, 0.16);
      break;
    }
    case 'fx':
    default: {
      track.pan = 0;
      fx.push(eqHpf(ROLE_HPF.fx));
      fx.push(createEffect('widener', { width: 1.6, monoBelow: 300 }));
      send(rev, 0.35 * sp.scale);
      send(dly, 0.15);
    }
  }
  track.fx = [...(track.fx || []), ...fx];
  track.sends = sends;
  return track;
}
