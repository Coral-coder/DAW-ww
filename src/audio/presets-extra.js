// Additional built-in instrument presets (pure data, Node-safe) for the synth / fm / organ engines, merged into
// PRESETS by presets.js. Same shape: id -> { name, category, roles[], genres[], description, instrument:{type, params} }.
// Gains are loudness-matched with EXTRA_LEVEL_DB below (offline renders of a C2..C6 phrase + chords, K-weighted
// gated loudness; same targets as the original presets: leads/keys/plucks -14, pads -15.5, basses -11, FX -18 LUFS).

const synth = (params) => ({ type: 'synth', params: { osc2Fine: 0, ...params } });
const fm = (params) => ({ type: 'fm', params });
const organ = (params) => ({ type: 'organ', params });
const P = (name, category, roles, genres, description, instrument) => ({ name, category, roles, genres, description, instrument });

const vib = (depth = 0.01, rate = 5.5, fade = 0.4, k = 1) => ({
  [`lfo${k}Target`]: 'pitch', [`lfo${k}Shape`]: 'sine', [`lfo${k}Rate`]: rate, [`lfo${k}Depth`]: depth, [`lfo${k}Fade`]: fade,
});
const pwm = (depth = 0.3, rate = 0.6, k = 2) => ({ [`lfo${k}Target`]: 'pwm', [`lfo${k}Shape`]: 'triangle', [`lfo${k}Rate`]: rate, [`lfo${k}Depth`]: depth });
const env = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const fenv = (fEnvAmount, fAttack, fDecay, fSustain, fRelease = 0.3) => ({ fEnvAmount, fAttack, fDecay, fSustain, fRelease });
const op = (i, ratio, level, a, d, s, r, extra = {}) => ({
  [`op${i}Ratio`]: ratio, [`op${i}Level`]: level, [`op${i}Attack`]: a, [`op${i}Decay`]: d, [`op${i}Sustain`]: s, [`op${i}Release`]: r,
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`op${i}${k[0].toUpperCase()}${k.slice(1)}`, v])),
});
const bars = (s) => Object.fromEntries([...String(s)].map((c, i) => [`db${i + 1}`, +c]));

export const EXTRA_PRESETS = {
  /* ------------------------------ BASS ------------------------------ */
  'distorted-808': P('Distorted 808', 'Bass', ['bass'], ['trap', 'drill', 'phonk', 'hiphop', 'rage'], 'Long 808 with a pitch drop pushed through the amp model — cuts on phone speakers.', synth({
    osc1Wave: 'sine', osc1Level: 0.95, filterType: 'off', pitchEnvAmt: 9, pitchEnvDecay: 0.05,
    ...env(0.002, 2.2, 0.4, 0.4), velToAmp: 0.25, mono: true, legato: true, glide: 0.12, analog: 0,
    drive: 0.8, driveType: 'amp', toneCut: 5500, lowCut: 25, gain: 0.5,
  })),
  'rubber-bass': P('Rubber Bass', 'Bass', ['bass'], ['funk', 'nu-disco', 'disco', 'synthwave', 'boogie'], 'Bouncy square/saw bass with a quick resonant filter blip.', synth({
    osc1Wave: 'square', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.5, osc2Fine: 6, subLevel: 0.4,
    filterType: 'lp24', cutoff: 380, resonance: 0.45, keytrack: 0.3, velToFilter: 0.6, ...fenv(3.2, 0.001, 0.12, 0.1, 0.08),
    ...env(0.002, 0.3, 0.6, 0.06), mono: true, legato: false, glide: 0.03, analog: 0.25, gain: 0.9,
  })),
  'organ-bass': P('Organ Bass', 'Bass', ['bass'], ['house', 'deep-house', 'garage', 'uk-garage', 'jazz'], 'Classic 90s house organ bass: 16\' and 8\' drawbars, no vibrato, quick release.', organ({
    ...bars('808400000'), perc: false, vibrato: 'off', rotary: 'off', click: 0.4, attack: 0.002, release: 0.05, polyphony: 2, drive: 0.15, toneCut: 6000, gain: 0.8,
  })),
  'fm-slap-bass': P('FM Slap Bass', 'Bass', ['bass'], ['funk', 'pop', 'city-pop', '80s', 'fusion'], 'DX-style slap: a bright transient modulator over a solid carrier.', fm({
    algorithm: 5, feedback: 0.2, ...op(1, 2, 0.55, 0.001, 0.09, 0, 0.05, { vel: 0.9 }), ...op(2, 1, 0.95, 0.001, 0.9, 0.35, 0.08),
    ...op(3, 1, 0.25, 0.001, 0.4, 0.2, 0.08), ...op(4, 0.5, 0.45, 0.001, 0.6, 0.4, 0.08), keyScale: 0.5, polyphony: 2, gain: 1,
  })),
  'neuro-bass': P('Neuro Bass', 'Bass', ['bass'], ['dnb', 'neurofunk', 'dubstep', 'jungle'], 'Gritty detuned saw/square with 1/16 filter motion and amp distortion.', synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -9, osc2Wave: 'square', osc2Level: 0.6, osc2Fine: 9, subLevel: 0.55,
    unison: 2, unisonDetune: 14, unisonSpread: 0.25, filterType: 'lp24', cutoff: 650, resonance: 0.5, filterDrive: 0.6, ...fenv(1.5, 0.002, 0.2, 0.3, 0.1),
    ...env(0.003, 0.4, 1, 0.1), lfo1Target: 'filter', lfo1Shape: 'triangle', lfo1Sync: true, lfo1Div: '1/16', lfo1Depth: 0.3,
    mono: true, glide: 0.03, analog: 0.1, drive: 0.6, driveType: 'amp', gain: 0.45,
  })),
  'garage-bass': P('Garage Bass', 'Bass', ['bass'], ['uk-garage', 'two-step', 'garage', 'speed-garage', 'bassline'], 'Hollow square + sine bass with a plucky filter — UKG / bassline.', synth({
    osc1Wave: 'square', osc1Level: 0.6, osc2Wave: 'sine', osc2Level: 0.8, osc2Octave: -1,
    filterType: 'lp24', cutoff: 520, resonance: 0.35, keytrack: 0.3, ...fenv(2.2, 0.001, 0.15, 0.25, 0.08),
    ...env(0.002, 0.35, 0.75, 0.08), mono: true, glide: 0.05, analog: 0.15, drive: 0.25, gain: 0.85,
  })),
  'techno-rumble': P('Techno Rumble', 'Bass', ['bass'], ['techno', 'hard-techno', 'industrial', 'minimal'], 'Dark, saturated low sine-triangle rumble — pair with a long reverb send.', synth({
    osc1Wave: 'sine', osc1Level: 0.9, osc2Wave: 'triangle', osc2Level: 0.5, osc2Octave: -1, noiseLevel: 0.03, noiseType: 'pink',
    filterType: 'lp12', cutoff: 220, resonance: 0.15, keytrack: 0, fEnvAmount: 1.2, fAttack: 0.001, fDecay: 0.2, fSustain: 0.2,
    ...env(0.005, 0.8, 0.45, 0.35), mono: true, analog: 0.1, drive: 0.55, driveType: 'tube', gain: 0.9,
  })),
  'pulse-bass': P('Pulse Bass', 'Bass', ['bass'], ['synthwave', 'retrowave', 'italo-disco', 'electro', 'darksynth'], 'Narrow pulse with a sub and a snappy filter — octave-bass sequences.', synth({
    osc1Wave: 'pulse', osc1Width: 0.3, osc1Level: 0.8, subLevel: 0.5, subWave: 'square',
    filterType: 'lp24', cutoff: 650, resonance: 0.3, filterDrive: 0.3, ...fenv(2.6, 0.001, 0.15, 0.2, 0.08),
    ...env(0.002, 0.22, 0.55, 0.07), ...pwm(0.12, 0.3, 2), polyphony: 4, analog: 0.3, gain: 0.85,
  })),
  'jungle-sub': P('Jungle Sub', 'Bass', ['bass'], ['jungle', 'dnb', 'dub', 'liquid-dnb', 'breaks'], 'Round sine sub with a slight pitch dip and slides.', synth({
    osc1Wave: 'sine', osc1Level: 0.95, osc2Wave: 'triangle', osc2Level: 0.15, filterType: 'off', pitchEnvAmt: 2, pitchEnvDecay: 0.04,
    ...env(0.004, 0.6, 0.9, 0.15), mono: true, legato: true, glide: 0.08, analog: 0, drive: 0.2, driveType: 'tube', gain: 0.9,
  })),
  'growl-bass': P('Growl Bass', 'Bass', ['bass'], ['dubstep', 'riddim', 'brostep', 'edm'], 'Talking 1/16 growl: unison saw + square through a driven resonant filter.', synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'square', osc2Level: 0.7, osc2Fine: 12, unison: 3, unisonDetune: 18, unisonSpread: 0.3, subLevel: 0.5,
    filterType: 'lp24', cutoff: 420, resonance: 0.6, filterDrive: 0.7, fEnvAmount: 0, ...env(0.003, 0.4, 1, 0.1),
    lfo1Target: 'filter', lfo1Shape: 'sine', lfo1Sync: true, lfo1Div: '1/16', lfo1Depth: 0.6,
    lfo2Target: 'oscmix', lfo2Shape: 'triangle', lfo2Sync: true, lfo2Div: '1/8', lfo2Depth: 0.4,
    mono: true, glide: 0.04, analog: 0.1, drive: 0.65, driveType: 'amp', gain: 0.4,
  })),
  'fm-sub-pluck': P('FM Sub Pluck', 'Bass', ['bass'], ['deep-house', 'tech-house', 'minimal', 'garage'], 'Short, round FM bass with a soft thump on the attack.', fm({
    algorithm: 5, ...op(1, 1, 0.45, 0.001, 0.08, 0, 0.05), ...op(2, 1, 0.95, 0.001, 0.45, 0.2, 0.08),
    ...op(3, 2, 0.2, 0.001, 0.05, 0, 0.05), ...op(4, 0.5, 0.5, 0.001, 0.35, 0.1, 0.08), keyScale: 0.4, polyphony: 2, gain: 1,
  })),
  'mellow-bass': P('Mellow Bass', 'Bass', ['bass'], ['lofi', 'chillhop', 'neo-soul', 'rnb', 'jazz'], 'Warm, soft triangle bass for laid-back grooves.', synth({
    osc1Wave: 'triangle', osc1Level: 0.9, osc2Wave: 'sine', osc2Level: 0.5, filterType: 'lp12', cutoff: 700, resonance: 0.05, keytrack: 0.5,
    ...fenv(0.8, 0.002, 0.25, 0.4, 0.1), ...env(0.005, 0.9, 0.55, 0.12), velToAmp: 0.5, mono: true, analog: 0.3, drive: 0.15, driveType: 'tube', gain: 1,
  })),

  /* ------------------------------ LEADS ----------------------------- */
  'future-lead': P('Future Lead', 'Lead', ['lead'], ['future-bass', 'edm', 'pop', 'kpop', 'melodic-dubstep'], 'Wide detuned unison saw with pitch vibrato — future-bass toplines.', synth({
    osc1Wave: 'saw', osc1Level: 0.8, unison: 5, unisonDetune: 28, unisonSpread: 0.9, osc2Wave: 'square', osc2Level: 0.25, osc2Octave: 1,
    filterType: 'lp24', cutoff: 5000, resonance: 0.1, ...fenv(1, 0.002, 0.3, 0.6), ...env(0.004, 0.3, 0.85, 0.25),
    ...vib(0.012, 5.8, 0.3), polyphony: 6, analog: 0.15, gain: 0.45,
  })),
  'lofi-sine-lead': P('Lo-Fi Sine Lead', 'Lead', ['lead'], ['lofi', 'chillhop', 'vaporwave', 'bedroom-pop'], 'Wobbly sine + triangle with tape-like drift.', synth({
    osc1Wave: 'sine', osc1Level: 0.8, osc2Wave: 'triangle', osc2Level: 0.35, osc2Octave: 1, filterType: 'lp12', cutoff: 3000, fEnvAmount: 0,
    ...env(0.02, 0.3, 0.8, 0.3), ...vib(0.015, 0.8, 0), analog: 0.7, toneCut: 5000, mono: true, glide: 0.05, gain: 0.8,
  })),
  'gfunk-whine': P('G-Funk Whine', 'Lead', ['lead'], ['g-funk', 'west-coast', 'hiphop', 'funk'], 'High portamento Moog-style whine with slow vibrato.', synth({
    osc1Wave: 'saw', osc1Level: 0.6, osc2Wave: 'sine', osc2Level: 0.6, filterType: 'lp12', cutoff: 2600, resonance: 0.2, fEnvAmount: 0.5,
    ...env(0.03, 0.2, 0.9, 0.2), ...vib(0.018, 5, 0.25), mono: true, legato: true, glide: 0.18, glideAlways: true, transpose: 12, analog: 0.25, gain: 0.6,
  })),
  'pwm-lead': P('PWM Lead', 'Lead', ['lead'], ['synthwave', '80s', 'italo-disco', 'pop', 'chiptune'], 'Slowly modulated pulse lead with a bright filter.', synth({
    osc1Wave: 'pulse', osc1Width: 0.4, osc1Level: 0.8, osc2Wave: 'pulse', osc2Width: 0.6, osc2Level: 0.4, osc2Fine: 6,
    filterType: 'lp24', cutoff: 3500, resonance: 0.15, ...fenv(1.2, 0.003, 0.4, 0.5), ...env(0.004, 0.3, 0.85, 0.2),
    ...pwm(0.4, 0.9, 2), ...vib(0.008, 5.5, 0.5), mono: true, glide: 0.04, analog: 0.25, gain: 0.7,
  })),
  'fm-lead': P('FM Lead', 'Lead', ['lead'], ['80s', 'city-pop', 'synthwave', 'video-game', 'jpop'], 'Bright DX-style lead with feedback edge and delayed vibrato.', fm({
    algorithm: 5, feedback: 0.4, ...op(1, 1, 0.45, 0.001, 0.6, 0.5, 0.2), ...op(2, 1, 0.9, 0.002, 1, 0.85, 0.2),
    ...op(3, 2, 0.35, 0.001, 0.4, 0.3, 0.2), ...op(4, 1, 0.5, 0.002, 1, 0.85, 0.2, { fine: 4 }),
    vibDepth: 0.12, vibRate: 5.5, vibDelay: 0.35, keyScale: 0.3, polyphony: 4, gain: 0.7,
  })),
  'ocarina-lead': P('Ocarina', 'Lead', ['lead'], ['world', 'video-game', 'cinematic', 'lofi', 'fantasy'], 'Breathy sine with a soft chiff and gentle vibrato.', synth({
    osc1Wave: 'sine', osc1Level: 0.85, osc2Wave: 'triangle', osc2Level: 0.12, osc2Octave: 1, noiseLevel: 0.05, noiseType: 'pink',
    filterType: 'lp12', cutoff: 4000, fEnvAmount: 0.4, fAttack: 0.03, fDecay: 0.2, fSustain: 0.6,
    ...env(0.05, 0.2, 0.9, 0.18), ...vib(0.008, 5.2, 0.4), mono: true, glide: 0.03, analog: 0.1, gain: 1,
  })),
  theremin: P('Theremin', 'Lead', ['lead', 'fx'], ['cinematic', 'sci-fi', 'experimental', 'psychedelic'], 'Always-gliding sine with deep, slow vibrato.', synth({
    osc1Wave: 'sine', osc1Level: 0.9, osc2Wave: 'triangle', osc2Level: 0.15, filterType: 'off',
    ...env(0.12, 0.3, 1, 0.35), ...vib(0.03, 6, 0.6), mono: true, legato: true, glide: 0.25, glideAlways: true, analog: 0.2, gain: 0.95,
  })),
  'psy-lead': P('Psy Lead', 'Lead', ['lead', 'arp'], ['psytrance', 'goa', 'trance', 'techno'], 'Squelchy resonant saw lead with a fast filter envelope.', synth({
    osc1Wave: 'saw', osc1Level: 0.85, osc2Wave: 'saw', osc2Level: 0.4, osc2Fine: 8, filterType: 'lp24', cutoff: 900, resonance: 0.65, filterDrive: 0.3,
    velToFilter: 0.6, ...fenv(3.5, 0.001, 0.15, 0.1, 0.08), ...env(0.002, 0.2, 0.6, 0.08), mono: true, glide: 0.03, analog: 0.1, drive: 0.25, gain: 0.55,
  })),
  'hardstyle-lead': P('Hardstyle Lead', 'Lead', ['lead', 'chords'], ['hardstyle', 'hardcore', 'gabber', 'rawstyle'], 'Screaming supersaw with amp distortion and pitch-drop.', synth({
    osc1Wave: 'supersaw', osc1Level: 0.9, superDetune: 0.7, superMix: 0.85, unisonSpread: 0.9, osc2Wave: 'saw', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 5500, resonance: 0.2, ...fenv(1.5, 0.002, 0.3, 0.5), ...env(0.003, 0.3, 0.9, 0.2),
    pitchEnvAmt: -3, pitchEnvDecay: 0.08, polyphony: 6, drive: 0.6, driveType: 'amp', gain: 0.35,
  })),
  'chip-pulse-lead': P('Chip Pulse 12.5%', 'Lead', ['lead', 'arp'], ['chiptune', 'video-game', 'electro'], 'Thin NES-style 12.5 % pulse with arpeggio-friendly envelope.', synth({
    osc1Wave: 'pulse', osc1Width: 0.125, osc1Level: 0.8, filterType: 'off', ...env(0.001, 0.15, 0.6, 0.04), velToAmp: 0.1,
    ...vib(0.01, 6.5, 0.3), polyphony: 4, analog: 0, gain: 0.75,
  })),
  'soft-square-lead': P('Soft Square Lead', 'Lead', ['lead'], ['lofi', 'pop', 'indie', 'bedroom-pop', 'chillwave'], 'Mellow filtered square — sits under a vocal.', synth({
    osc1Wave: 'square', osc1Level: 0.7, osc2Wave: 'sine', osc2Level: 0.4, osc2Octave: -1, filterType: 'lp12', cutoff: 1800, resonance: 0.1,
    ...fenv(0.8, 0.01, 0.4, 0.5), ...env(0.01, 0.3, 0.85, 0.2), ...vib(0.006, 5, 0.5), mono: true, glide: 0.04, analog: 0.3, gain: 0.95,
  })),
  'sync-scream': P('Sync Scream', 'Lead', ['lead'], ['electro', 'french-house', 'edm', 'industrial'], 'Hard-sync sweep driven by the filter envelope — aggressive and vocal.', synth({
    osc1Wave: 'sync', osc1Width: 0.8, osc1Level: 0.85, osc2Wave: 'square', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 2500, resonance: 0.4, ...fenv(2, 0.002, 0.6, 0.4), ...env(0.003, 0.3, 0.9, 0.15),
    lfo2Target: 'pwm', lfo2Rate: 0.4, lfo2Depth: 0.3, mono: true, glide: 0.05, drive: 0.45, driveType: 'amp', gain: 0.4,
  })),

  /* ------------------------------ KEYS ------------------------------ */
  'organ-gospel': P('Gospel Organ', 'Keys', ['chords', 'keys'], ['gospel', 'soul', 'rnb', 'blues', 'neo-soul'], 'Full 888 registration, third percussion and a fast rotary.', organ({
    ...bars('888800000'), perc: true, percHarmonic: 'third', percDecay: 0.3, percLevel: 0.6, vibrato: 'c3', rotary: 'fast', rotaryDepth: 0.8, click: 0.45, drive: 0.35, driveType: 'tube', gain: 0.6,
  })),
  'organ-jazz': P('Jazz Organ', 'Keys', ['chords', 'keys', 'lead'], ['jazz', 'soul-jazz', 'blues', 'funk', 'lounge'], 'Classic "888" with second percussion, chorus-vibrato and slow Leslie.', organ({
    ...bars('888000000'), perc: true, percHarmonic: 'second', percDecay: 0.25, percLevel: 0.7, vibrato: 'c3', rotary: 'slow', click: 0.5, drive: 0.2, driveType: 'tube', gain: 0.75,
  })),
  'organ-church': P('Church Organ', 'Keys', ['chords', 'pad'], ['classical', 'cinematic', 'gospel', 'christmas', 'baroque'], 'Every drawbar pulled, no vibrato — a big pipe-like tutti.', organ({
    ...bars('868868468'), perc: false, vibrato: 'off', rotary: 'off', click: 0, attack: 0.06, release: 0.4, drive: 0, gain: 0.45,
  })),
  'organ-bubble': P('Reggae Bubble Organ', 'Keys', ['chords'], ['reggae', 'dub', 'ska', 'rocksteady', 'dancehall'], 'Short, percussive organ for off-beat skanks.', organ({
    ...bars('808000000'), perc: true, percHarmonic: 'third', percDecay: 0.12, percLevel: 0.6, vibrato: 'off', rotary: 'slow', click: 0.6, attack: 0.001, release: 0.04, gain: 0.8,
  })),
  'organ-house': P('House Organ', 'Keys', ['chords', 'lead'], ['house', 'deep-house', 'garage', 'uk-garage', 'piano-house'], 'M1-style house organ: upper drawbars, quick click, no Leslie.', organ({
    ...bars('008808008'), perc: true, percHarmonic: 'second', percDecay: 0.2, percLevel: 0.5, vibrato: 'off', rotary: 'off', click: 0.7, attack: 0.001, release: 0.08, toneCut: 9000, gain: 0.5,
  })),
  'fm-dx-piano': P('DX Piano', 'Keys', ['chords', 'keys'], ['80s', 'city-pop', 'ballad', 'pop', 'synthwave'], 'Bright FM piano of 80s ballads.', fm({
    algorithm: 5, ...op(1, 1, 0.42, 0.001, 0.9, 0.05, 0.3, { vel: 0.8 }), ...op(2, 1, 0.9, 0.001, 2.4, 0.1, 0.4),
    ...op(3, 14, 0.12, 0.001, 0.12, 0, 0.1, { vel: 0.9 }), ...op(4, 1, 0.6, 0.001, 1.8, 0.05, 0.4, { fine: 3 }),
    keyScale: 0.5, polyphony: 12, gain: 0.7,
  })),
  'fm-clav': P('FM Clav', 'Keys', ['chords', 'keys'], ['funk', 'disco', 'soul', '80s'], 'Biting FM clavinet with a nasal edge.', fm({
    algorithm: 5, feedback: 0.3, ...op(1, 3, 0.5, 0.001, 0.25, 0.15, 0.05, { vel: 0.8 }), ...op(2, 1, 0.9, 0.001, 0.8, 0.2, 0.06),
    ...op(3, 5, 0.3, 0.001, 0.1, 0, 0.05), ...op(4, 1, 0.5, 0.001, 0.6, 0.15, 0.06), keyScale: 0.4, gain: 0.65,
  })),
  wurli: P('Wurli', 'Keys', ['chords', 'keys'], ['soul', 'neo-soul', 'indie', 'rnb', 'lofi', '70s'], 'Reedy electric piano with a barky attack and amp tremolo.', fm({
    algorithm: 5, ...op(1, 1, 0.5, 0.001, 0.4, 0.1, 0.2, { vel: 0.9 }), ...op(2, 1, 0.9, 0.001, 2.2, 0.15, 0.3),
    ...op(3, 3, 0.2, 0.001, 0.2, 0, 0.1, { vel: 0.8 }), ...op(4, 1, 0.45, 0.001, 1.6, 0.1, 0.3, { fine: -4 }),
    tremDepth: 0.25, tremRate: 5.5, keyScale: 0.5, drive: 0.25, driveType: 'tube', gain: 0.7,
  })),
  'toy-piano': P('Toy Piano', 'Keys', ['lead', 'arp'], ['lofi', 'indie', 'lullaby', 'cinematic', 'christmas'], 'Inharmonic metal-rod plink.', fm({
    algorithm: 5, ...op(1, 3.47, 0.3, 0.001, 0.2, 0, 0.2), ...op(2, 1, 0.85, 0.001, 0.9, 0, 0.4),
    ...op(3, 6.9, 0.18, 0.001, 0.15, 0, 0.1), ...op(4, 2, 0.3, 0.001, 0.5, 0, 0.3), keyScale: 0.5, transpose: 12, gain: 0.8,
  })),
  'dark-rhodes': P('Dark Tines', 'Keys', ['chords', 'keys'], ['neo-soul', 'lofi', 'jazz', 'rnb', 'trip-hop'], 'Mellow, rounded tine piano rolled off at the top.', fm({
    algorithm: 5, ...op(1, 1, 0.3, 0.001, 1.2, 0.05, 0.4, { vel: 0.8 }), ...op(2, 1, 0.95, 0.001, 3, 0.1, 0.5),
    ...op(3, 14, 0.05, 0.001, 0.1, 0, 0.1, { vel: 0.9 }), ...op(4, 1, 0.5, 0.001, 2.2, 0.1, 0.5, { fine: 2 }),
    tremDepth: 0.15, tremRate: 4, keyScale: 0.5, toneCut: 4000, gain: 0.75,
  })),

  /* ------------------------------ PADS ------------------------------ */
  'analog-pad': P('Analog Pad', 'Pad', ['pad', 'chords'], ['synthwave', 'house', 'pop', 'ambient', 'cinematic'], 'Two detuned saws, slow attack, warm 24 dB filter.', synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc1Fine: -8, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 8, unisonSpread: 0.8,
    filterType: 'lp24', cutoff: 1400, resonance: 0.12, keytrack: 0.4, ...fenv(0.8, 0.6, 1.5, 0.6, 1), ...env(0.6, 1, 0.85, 1.2),
    lfo1Target: 'filter', lfo1Rate: 0.2, lfo1Depth: 0.04, polyphony: 8, analog: 0.5, gain: 0.5,
  })),
  'evolving-pad': P('Evolving Pad', 'Pad', ['pad'], ['ambient', 'cinematic', 'downtempo', 'idm'], 'Saw + PWM pulse with slow filter and width motion.', synth({
    osc1Wave: 'saw', osc1Level: 0.6, osc2Wave: 'pulse', osc2Width: 0.4, osc2Level: 0.6, osc2Fine: 5, unison: 2, unisonDetune: 10, unisonSpread: 0.9,
    filterType: 'lp24', cutoff: 1100, resonance: 0.25, keytrack: 0.3, ...fenv(1.2, 2, 3, 0.4, 2), ...env(1.5, 2, 0.8, 2.5),
    lfo1Target: 'filter', lfo1Shape: 'triangle', lfo1Rate: 0.07, lfo1Depth: 0.12, ...pwm(0.45, 0.15, 2), polyphony: 8, analog: 0.5, gain: 0.5,
  })),
  'shimmer-pad': P('Shimmer Pad', 'Pad', ['pad'], ['ambient', 'post-rock', 'cinematic', 'worship', 'chillwave'], 'Bright octave-up supersaw shimmer above the chords.', synth({
    osc1Wave: 'supersaw', osc1Level: 0.7, superDetune: 0.35, superMix: 0.7, unisonSpread: 1, osc2Wave: 'sine', osc2Level: 0.35, osc2Octave: 1,
    filterType: 'lp12', cutoff: 6000, resonance: 0.05, ...env(1.2, 1.5, 0.9, 2.5), ...vib(0.004, 4.5, 1), polyphony: 8, analog: 0.3, lowCut: 200, gain: 0.35,
  })),
  'fm-glass-pad': P('FM Glass Pad', 'Pad', ['pad', 'chords'], ['ambient', 'new-age', 'cinematic', 'chillout', 'lofi'], 'Crystalline FM pad with slow attack and bell harmonics.', fm({
    algorithm: 5, ...op(1, 3, 0.25, 0.8, 2, 0.4, 1.5), ...op(2, 1, 0.8, 0.9, 2, 0.85, 2),
    ...op(3, 7, 0.12, 1.2, 3, 0.3, 1.5), ...op(4, 2, 0.4, 1, 2, 0.8, 2, { fine: 5 }),
    vibDepth: 0.05, vibRate: 4, vibDelay: 0.8, keyScale: 0.3, polyphony: 10, gain: 0.55,
  })),
  'organ-pad': P('Organ Pad', 'Pad', ['pad', 'chords'], ['ambient', 'gospel', 'indie', 'dream-pop'], 'Soft drawbar organ with a swelling attack and slow rotary.', organ({
    ...bars('008800800'), perc: false, vibrato: 'c2', rotary: 'slow', rotaryDepth: 0.5, click: 0, attack: 0.5, release: 1, gain: 0.6,
  })),
  'lofi-tape-pad': P('Lo-Fi Tape Pad', 'Pad', ['pad', 'chords'], ['lofi', 'chillhop', 'vaporwave', 'bedroom-pop'], 'Dusty triangle pad with wow-like pitch drift.', synth({
    osc1Wave: 'triangle', osc1Level: 0.75, osc2Wave: 'saw', osc2Level: 0.25, osc2Fine: 6, filterType: 'lp12', cutoff: 1600, resonance: 0.05,
    ...env(0.4, 1, 0.8, 1), ...vib(0.006, 0.6, 0), noiseLevel: 0.02, noiseType: 'pink', polyphony: 8, analog: 0.8, toneCut: 4500, gain: 0.75,
  })),
  'sweep-pad': P('Sweep Pad', 'Pad', ['pad'], ['trance', 'progressive-house', 'synthwave', 'ambient'], 'Resonant 2-bar filter sweep on a wide saw pad.', synth({
    osc1Wave: 'saw', osc1Level: 0.75, unison: 3, unisonDetune: 18, unisonSpread: 0.9, osc2Wave: 'square', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 900, resonance: 0.45, keytrack: 0.3, fEnvAmount: 0, ...env(0.5, 1, 0.9, 1.5),
    lfo1Target: 'filter', lfo1Shape: 'triangle', lfo1Sync: true, lfo1Div: '2/1', lfo1Depth: 0.35, polyphony: 8, analog: 0.3, gain: 0.4,
  })),
  'choir-ooh': P('Choir Ooh', 'Pad', ['pad'], ['cinematic', 'gospel', 'ambient', 'rnb', 'trance'], 'Dark "ooh" choir with slow attack.', synth({
    osc1Wave: 'choir', osc1Level: 0.9, modelTone: -0.4, filterType: 'lp12', cutoff: 2200, resonance: 0, keytrack: 0.4,
    ...env(0.5, 1, 0.9, 1.2), ...vib(0.004, 5, 0.8, 2), polyphony: 8, analog: 0.2, gain: 1,
  })),
  'cinematic-swell': P('Cinematic Swell', 'Pad', ['pad', 'fx'], ['cinematic', 'trailer', 'ambient', 'post-rock'], 'Ensemble strings that swell in over two seconds.', synth({
    osc1Wave: 'ensemble', osc1Level: 0.85, osc2Wave: 'saw', osc2Level: 0.2, osc2Octave: -1, filterType: 'lp24', cutoff: 2600, resonance: 0.1,
    ...fenv(1.2, 2, 2, 0.6, 1.5), ...env(2, 1.5, 0.9, 2), polyphony: 8, analog: 0.3, gain: 0.8,
  })),
  'air-pad': P('Air Pad', 'Pad', ['pad', 'fx'], ['ambient', 'downtempo', 'cinematic', 'chillwave'], 'Breathy PADsynth layer with filtered noise.', synth({
    osc1Wave: 'pad', osc1Level: 0.8, padWidth: 2.5, noiseLevel: 0.08, noiseType: 'pink', filterType: 'lp12', cutoff: 3000, resonance: 0.1,
    ...env(1.2, 1, 0.9, 2), lfo1Target: 'filter', lfo1Rate: 0.12, lfo1Depth: 0.08, polyphony: 8, analog: 0.3, lowCut: 180, gain: 0.8,
  })),

  /* ------------------------------ PLUCKS / CHORDS ------------------------------ */
  'nylon-pluck': P('Nylon Pluck', 'Guitar', ['chords', 'arp', 'lead'], ['bossa-nova', 'latin', 'flamenco', 'lofi', 'reggaeton', 'folk'], 'Soft nylon-string pluck (Karplus-Strong) with a warm body.', synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelTone: -0.25, modelDecay: 1.6, osc2Wave: 'sine', osc2Level: 0.12,
    filterType: 'lp12', cutoff: 3500, resonance: 0.05, keytrack: 0.5, velToFilter: 0.5, fEnvAmount: 0,
    ...env(0.001, 2.5, 0.3, 0.2), velToAmp: 0.6, polyphony: 8, analog: 0, gain: 0.6,
  })),
  'tropical-pluck': P('Tropical Pluck', 'Pluck', ['chords', 'arp', 'lead'], ['tropical-house', 'pop', 'dancehall', 'afrobeats', 'future-bass'], 'Marimba-like synth pluck for tropical house hooks.', synth({
    osc1Wave: 'triangle', osc1Level: 0.8, osc2Wave: 'square', osc2Level: 0.25, osc2Octave: 1, filterType: 'lp24', cutoff: 1200, resonance: 0.2,
    ...fenv(3, 0.001, 0.12, 0, 0.1), ...env(0.001, 0.3, 0, 0.15), polyphony: 8, analog: 0.1, gain: 0.8,
  })),
  'stab-90s': P('90s Chord Stab', 'Pluck', ['chords'], ['house', 'rave', 'eurodance', 'breakbeat', 'garage'], 'Bright stacked-saw chord stab with a short filter snap.', synth({
    osc1Wave: 'saw', osc1Level: 0.75, osc2Wave: 'saw', osc2Level: 0.6, osc2Fine: 10, osc3Wave: 'square', osc3Level: 0.3, osc3Octave: 0,
    filterType: 'lp24', cutoff: 1500, resonance: 0.3, ...fenv(2.5, 0.001, 0.18, 0.15, 0.1), ...env(0.001, 0.35, 0.2, 0.15), polyphony: 12, analog: 0.15, gain: 0.45,
  })),
  'deep-chord': P('Deep House Chord', 'Pluck', ['chords', 'pad'], ['deep-house', 'house', 'lofi-house', 'garage', 'minimal'], 'Warm filtered saw+square chord with a soft decay.', synth({
    osc1Wave: 'saw', osc1Level: 0.6, osc2Wave: 'square', osc2Level: 0.45, osc2Fine: -6, filterType: 'lp24', cutoff: 850, resonance: 0.2, keytrack: 0.3,
    ...fenv(1.6, 0.003, 0.45, 0.2, 0.3), ...env(0.004, 0.7, 0.35, 0.35), polyphony: 12, analog: 0.4, gain: 0.7,
  })),
  'dub-techno-chord': P('Dub Techno Chord', 'Pluck', ['chords'], ['dub-techno', 'techno', 'minimal', 'deep-house'], 'Short resonant minor-chord stab — add a 1/4 dotted dub delay and long reverb.', synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.5, osc2Fine: 7, filterType: 'lp24', cutoff: 700, resonance: 0.45, keytrack: 0.2,
    ...fenv(1.8, 0.002, 0.2, 0, 0.2), ...env(0.002, 0.25, 0, 0.2), polyphony: 12, analog: 0.3, gain: 0.6,
  })),
  'fm-pluck': P('FM Pluck', 'Pluck', ['arp', 'chords', 'lead'], ['pop', 'future-bass', 'house', 'kpop', 'edm'], 'Glassy FM pluck with a bright decaying modulator.', fm({
    algorithm: 5, ...op(1, 2, 0.4, 0.001, 0.2, 0, 0.1), ...op(2, 1, 0.9, 0.001, 0.6, 0, 0.2),
    ...op(3, 5, 0.2, 0.001, 0.1, 0, 0.1), ...op(4, 1, 0.45, 0.001, 0.5, 0, 0.2, { fine: 6 }), keyScale: 0.4, gain: 0.8,
  })),
  'banjo-pluck': P('Banjo', 'Guitar', ['chords', 'arp'], ['country', 'bluegrass', 'folk', 'americana'], 'Twangy, bright plucked string with a short ring.', synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelTone: 0.85, modelDecay: 0.6, osc2Wave: 'pulse', osc2Width: 0.15, osc2Level: 0.1,
    filterType: 'hp12', cutoff: 180, fEnvAmount: 0, ...env(0.001, 0.9, 0.2, 0.1), velToAmp: 0.6, polyphony: 8, analog: 0, gain: 0.55,
  })),
  'sitar-pluck': P('Sitar-ish', 'Guitar', ['lead', 'arp'], ['world', 'psychedelic', 'indian', 'lofi'], 'Buzzy plucked string with a resonant drone colour.', synth({
    osc1Wave: 'pluck', osc1Level: 0.85, modelTone: 0.6, modelDecay: 2.2, osc2Wave: 'saw', osc2Level: 0.1,
    filterType: 'bp', cutoff: 1800, resonance: 0.55, keytrack: 0.6, fEnvAmount: 0.6, fAttack: 0.001, fDecay: 0.5, fSustain: 0.4,
    ...env(0.001, 3, 0.4, 0.3), pitchEnvAmt: 0.3, pitchEnvDecay: 0.05, polyphony: 6, analog: 0.1, gain: 0.7,
  })),

  /* ------------------------------ ARPS ------------------------------ */
  'arp-square': P('Square Arp', 'Arp', ['arp'], ['synthwave', 'electro', 'video-game', 'italo-disco'], 'Tight hollow square blips for 1/16 sequences.', synth({
    osc1Wave: 'square', osc1Level: 0.75, filterType: 'lp24', cutoff: 1800, resonance: 0.25, ...fenv(2, 0.001, 0.1, 0.1, 0.05),
    ...env(0.001, 0.15, 0.1, 0.08), polyphony: 6, analog: 0.15, gain: 0.85,
  })),
  'arp-fm-glass': P('Glass Arp', 'Arp', ['arp'], ['ambient', 'pop', 'chillwave', 'idm', 'future-garage'], 'Bell-like FM arpeggio tone.', fm({
    algorithm: 5, ...op(1, 3.5, 0.3, 0.001, 0.4, 0, 0.3), ...op(2, 1, 0.85, 0.001, 0.8, 0, 0.4),
    ...op(3, 7, 0.1, 0.001, 0.15, 0, 0.1), ...op(4, 2, 0.35, 0.001, 0.6, 0, 0.3), keyScale: 0.4, gain: 0.85,
  })),
  'arp-gated': P('Gated Saw Arp', 'Arp', ['arp', 'pad'], ['trance', 'progressive-house', 'edm', 'eurodance'], 'Held saw chords chopped into 1/16 notes by the amp LFO.', synth({
    osc1Wave: 'saw', osc1Level: 0.75, unison: 3, unisonDetune: 15, unisonSpread: 0.8, filterType: 'lp24', cutoff: 3000, resonance: 0.15,
    fEnvAmount: 0, ...env(0.005, 0.5, 1, 0.2), lfo1Target: 'amp', lfo1Shape: 'square', lfo1Sync: true, lfo1Div: '1/16', lfo1Depth: 0.9,
    polyphony: 8, analog: 0.2, gain: 0.45,
  })),
  'arp-sine-blip': P('Sine Blip', 'Arp', ['arp', 'fx'], ['minimal', 'techno', 'idm', 'ambient', 'microhouse'], 'Pure short sine blips with a tiny pitch click.', synth({
    osc1Wave: 'sine', osc1Level: 0.9, filterType: 'off', pitchEnvAmt: 5, pitchEnvDecay: 0.01, ...env(0.001, 0.12, 0, 0.06), polyphony: 6, analog: 0, gain: 1,
  })),
  'arp-acid': P('Acid Arp', 'Arp', ['arp', 'bass'], ['acid', 'techno', 'breaks', 'electro'], 'Resonant squelchy saw for fast acid arps.', synth({
    osc1Wave: 'saw', osc1Level: 0.85, filterType: 'lp24', cutoff: 500, resonance: 0.8, velToFilter: 0.8, filterDrive: 0.4,
    ...fenv(4, 0.001, 0.14, 0, 0.06), ...env(0.001, 0.2, 0.5, 0.05), mono: true, glide: 0.02, analog: 0.1, drive: 0.3, driveType: 'tube', gain: 0.6,
  })),
  'arp-pwm': P('PWM Arp', 'Arp', ['arp'], ['synthwave', '80s', 'pop', 'chillwave'], 'Chorused pulse arpeggio with a soft filter.', synth({
    osc1Wave: 'pulse', osc1Width: 0.35, osc1Level: 0.8, osc2Wave: 'pulse', osc2Width: 0.65, osc2Level: 0.3, osc2Fine: 7, filterType: 'lp24', cutoff: 2200, resonance: 0.1,
    ...fenv(1.5, 0.001, 0.2, 0.2), ...env(0.001, 0.25, 0.2, 0.15), ...pwm(0.35, 0.8, 2), polyphony: 6, analog: 0.25, gain: 0.8,
  })),

  /* ------------------------------ FX ------------------------------ */
  downlifter: P('Downlifter', 'FX', ['fx'], ['edm', 'house', 'trance', 'dubstep', 'future-bass'], 'Falling filtered noise sweep for after a drop.', synth({
    osc1Level: 0, noiseLevel: 1, noiseType: 'white', filterType: 'lp12', cutoff: 12000, resonance: 0.3, keytrack: 0,
    fEnvAmount: -5, fAttack: 0.001, fDecay: 3, fSustain: 0, fRelease: 0.5, ...env(0.005, 3, 0, 0.6), polyphony: 2, analog: 0, gain: 0.8,
  })),
  'impact-boom': P('Impact Boom', 'FX', ['fx'], ['cinematic', 'trailer', 'edm', 'trap', 'dubstep'], 'Deep sub hit with a long pitch dive — play a low note on the downbeat.', synth({
    osc1Wave: 'sine', osc1Level: 1, osc2Wave: 'triangle', osc2Level: 0.3, noiseLevel: 0.15, noiseType: 'pink', filterType: 'lp12', cutoff: 900, fEnvAmount: 0,
    pitchEnvAmt: 24, pitchEnvDecay: 0.35, ...env(0.001, 2.5, 0, 1), mono: true, drive: 0.4, driveType: 'tube', gain: 0.9,
  })),
  'fm-zap': P('FM Zap', 'FX', ['fx'], ['electro', 'dubstep', 'video-game', 'drum-and-bass'], 'Laser-like FM zap: a high modulator diving away.', fm({
    algorithm: 1, feedback: 0.6, ...op(1, 7, 0.6, 0.001, 0.15, 0, 0.1), ...op(2, 3, 0.5, 0.001, 0.2, 0, 0.1),
    ...op(3, 1, 0.4, 0.001, 0.3, 0, 0.1), ...op(4, 1, 0.9, 0.001, 0.35, 0, 0.1), keyScale: 0, polyphony: 4, gain: 0.6,
  })),
  'scifi-drone': P('Sci-Fi Drone', 'FX', ['fx', 'pad'], ['cinematic', 'ambient', 'sci-fi', 'dark-ambient', 'industrial'], 'Slowly beating low saws with a moving resonant filter.', synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 13, osc3Wave: 'square', osc3Level: 0.4, osc3Octave: -1, osc3Fine: -7,
    filterType: 'lp24', cutoff: 500, resonance: 0.55, keytrack: 0.2, fEnvAmount: 0, ...env(2, 1, 1, 3),
    lfo1Target: 'filter', lfo1Shape: 'sine', lfo1Rate: 0.05, lfo1Depth: 0.25, lfo2Target: 'pan', lfo2Rate: 0.1, lfo2Depth: 0.4, polyphony: 4, analog: 0.6, gain: 0.45,
  })),
  'vinyl-noise': P('Vinyl Noise Bed', 'FX', ['fx'], ['lofi', 'chillhop', 'trip-hop', 'boom-bap'], 'Hold a note for a soft filtered noise bed (crackle-free hiss).', synth({
    osc1Level: 0, noiseLevel: 1, noiseType: 'pink', filterType: 'lp12', cutoff: 6000, resonance: 0, keytrack: 0, fEnvAmount: 0, lowCut: 200,
    ...env(0.3, 1, 1, 0.8), lfo1Target: 'amp', lfo1Shape: 'square', lfo1Rate: 13, lfo1Depth: 0.08, polyphony: 1, analog: 0, gain: 0.8,
  })),
  siren: P('Dub Siren', 'FX', ['fx'], ['dub', 'reggae', 'dancehall', 'jungle', 'dubstep'], 'Square-wave siren with a fast pitch LFO.', synth({
    osc1Wave: 'square', osc1Level: 0.7, filterType: 'lp12', cutoff: 2500, resonance: 0.2, fEnvAmount: 0, ...env(0.01, 0.5, 1, 0.6),
    lfo1Target: 'pitch', lfo1Shape: 'triangle', lfo1Rate: 3, lfo1Depth: 0.35, mono: true, analog: 0.1, gain: 0.5,
  })),

  /* ------------------------------ ORCHESTRAL ------------------------------ */
  'synth-brass-stab': P('Synth Brass Stab', 'Orchestral', ['chords'], ['synthwave', '80s', 'funk', 'disco', 'pop'], 'Short "blat" brass stab: two saws, envelope-swept filter.', synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -4, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 4, filterType: 'lp24', cutoff: 800, resonance: 0.12, velToFilter: 0.6,
    ...fenv(3, 0.04, 0.25, 0.3, 0.15), ...env(0.02, 0.3, 0.5, 0.15), polyphony: 8, analog: 0.35, gain: 0.45,
  })),
  'pizz-synth': P('Synth Pizzicato', 'Orchestral', ['arp', 'chords'], ['cinematic', 'classical', 'pop', 'christmas'], 'Plucked string section, short and light.', synth({
    osc1Wave: 'pluck', osc1Level: 0.85, modelTone: 0.1, modelDecay: 0.45, osc2Wave: 'pluck', osc2Level: 0.4, osc2Fine: 6,
    filterType: 'lp12', cutoff: 3000, fEnvAmount: 0, ...env(0.002, 0.5, 0, 0.15), polyphony: 12, analog: 0.05, gain: 0.6,
  })),
  'french-horn': P('French Horn', 'Orchestral', ['lead', 'chords', 'pad'], ['cinematic', 'classical', 'fantasy', 'trailer'], 'Round, dark horn with a slow swell.', synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'triangle', osc2Level: 0.6, filterType: 'lp24', cutoff: 700, resonance: 0.05, keytrack: 0.5, velToFilter: 0.6,
    ...fenv(1.5, 0.12, 0.4, 0.6, 0.3), ...env(0.08, 0.3, 0.9, 0.3), ...vib(0.005, 5, 0.6), polyphony: 6, analog: 0.25, gain: 0.85,
  })),
  'solo-violin': P('Synth Violin', 'Orchestral', ['lead'], ['cinematic', 'classical', 'folk', 'ballad', 'tango'], 'Bowed-saw lead with expressive delayed vibrato.', synth({
    osc1Wave: 'saw', osc1Level: 0.75, osc2Wave: 'pulse', osc2Width: 0.2, osc2Level: 0.2, filterType: 'lp12', cutoff: 3200, resonance: 0.15, keytrack: 0.5,
    ...fenv(0.6, 0.1, 0.4, 0.8), ...env(0.07, 0.3, 0.9, 0.25), ...vib(0.012, 5.8, 0.5), mono: true, legato: true, glide: 0.04, analog: 0.2, lowCut: 180, gain: 0.6,
  })),
  'cello-synth': P('Synth Cello', 'Orchestral', ['bass', 'lead', 'pad'], ['cinematic', 'classical', 'ballad', 'chamber'], 'Warm bowed low strings.', synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.4, osc2Fine: 5, filterType: 'lp12', cutoff: 1500, resonance: 0.1, keytrack: 0.5,
    ...fenv(0.6, 0.15, 0.5, 0.7), ...env(0.12, 0.3, 0.9, 0.4), ...vib(0.008, 5.2, 0.6), polyphony: 4, analog: 0.2, gain: 0.65,
  })),
  'fm-timpani': P('FM Timpani', 'Orchestral', ['fx', 'bass'], ['cinematic', 'classical', 'trailer', 'christmas'], 'Tuned drum hit with an inharmonic FM skin.', fm({
    algorithm: 5, ...op(1, 1.6, 0.35, 0.001, 0.4, 0, 0.3), ...op(2, 1, 0.95, 0.001, 1.6, 0, 0.8),
    ...op(3, 2.3, 0.2, 0.001, 0.2, 0, 0.2), ...op(4, 1.5, 0.4, 0.001, 1, 0, 0.6), keyScale: 0.2, polyphony: 4, gain: 1,
  })),

  /* ------------------------------ GUITAR ------------------------------ */
  'muted-guitar': P('Muted Guitar', 'Guitar', ['chords', 'arp', 'bass'], ['funk', 'pop', 'afrobeat', 'highlife', 'disco'], 'Palm-muted plucks for chicken-scratch and afrobeat lines.', synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelTone: 0.2, modelDecay: 0.25, filterType: 'lp12', cutoff: 2400, resonance: 0.1, fEnvAmount: 0,
    ...env(0.001, 0.25, 0, 0.06), velToAmp: 0.6, polyphony: 8, analog: 0, drive: 0.2, driveType: 'amp', gain: 0.6,
  })),
  'jazz-guitar': P('Jazz Guitar', 'Guitar', ['chords', 'lead'], ['jazz', 'bossa-nova', 'soul-jazz', 'lounge', 'lofi'], 'Dark, round archtop tone (neck pickup, tone rolled off).', synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelTone: -0.55, modelDecay: 1.8, osc2Wave: 'sine', osc2Level: 0.2,
    filterType: 'lp12', cutoff: 1800, resonance: 0.05, keytrack: 0.4, fEnvAmount: 0, ...env(0.002, 2, 0.4, 0.2), polyphony: 8, analog: 0, gain: 0.7,
  })),
  'twelve-string': P('12-String', 'Guitar', ['chords', 'arp'], ['folk', 'indie', 'rock', 'americana', 'psychedelic'], 'Jangly doubled strings (octave + unison courses).', synth({
    osc1Wave: 'pluck', osc1Level: 0.8, modelTone: 0.5, modelDecay: 1.5, osc2Wave: 'pluck', osc2Level: 0.45, osc2Octave: 1, osc2Fine: 4,
    filterType: 'hp12', cutoff: 120, fEnvAmount: 0, ...env(0.001, 2, 0.4, 0.2), polyphony: 12, analog: 0.05, gain: 0.45,
  })),
  'funk-guitar': P('Funk Guitar', 'Guitar', ['chords'], ['funk', 'disco', 'nu-disco', 'soul', 'boogie'], 'Bright single-coil chops with a touch of amp grit.', synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelTone: 0.75, modelDecay: 0.5, filterType: 'bp', cutoff: 1500, resonance: 0.3, velToFilter: 0.5,
    fEnvAmount: 1.2, fAttack: 0.001, fDecay: 0.15, fSustain: 0.3, ...env(0.001, 0.4, 0.1, 0.08), polyphony: 8, drive: 0.35, driveType: 'amp', analog: 0, gain: 0.5,
  })),
};

// Mix trim like presets.js MIX: a low cut on everything that doesn't play the low end (keeps room for kick & bass).
const LOW_CUT = { Pad: 110, Pluck: 130, Arp: 150, Lead: 120, Keys: 80, Guitar: 90, Orchestral: 90, FX: 60 };
for (const pr of Object.values(EXTRA_PRESETS)) {
  const pp = pr.instrument.params;
  if (pp.lowCut === undefined && !pr.roles.includes('bass') && LOW_CUT[pr.category]) pp.lowCut = LOW_CUT[pr.category];
}

/** Loudness trims (dB) for the presets above — applied by presets.js like LEVEL_DB. */
export const EXTRA_LEVEL_DB = {
  'distorted-808': -0.1, 'rubber-bass': 4.7, 'organ-bass': -1.5, 'fm-slap-bass': 6, 'neuro-bass': 0.5, 'garage-bass': -4.7, 'techno-rumble': -1, 'pulse-bass': 3.2, 'jungle-sub': -0.5, 'growl-bass': 2, 'fm-sub-pluck': 6, 'mellow-bass': 6, 'future-lead': 5.4, 'lofi-sine-lead': 0.3, 'gfunk-whine': 2.1, 'pwm-lead': 4, 'fm-lead': -0.6, 'ocarina-lead': -2.2, 'theremin': -2.9, 'psy-lead': -7.2, 'hardstyle-lead': -4.7, 'chip-pulse-lead': 4.1, 'soft-square-lead': -1.8, 'sync-scream': -8.2, 'organ-gospel': -4.2, 'organ-jazz': -2.6, 'organ-church': -4.8, 'organ-bubble': 0.6, 'organ-house': -4.4, 'fm-dx-piano': 1.4, 'fm-clav': 5.5, 'wurli': -1.1, 'toy-piano': 5.5, 'dark-rhodes': -0.1, 'analog-pad': 0.2, 'evolving-pad': 4.9, 'shimmer-pad': 3.2, 'fm-glass-pad': 0.7, 'organ-pad': -1.1, 'lofi-tape-pad': -3.1, 'sweep-pad': 3, 'choir-ooh': 3.2, 'cinematic-swell': 7.5, 'air-pad': 6.8, 'nylon-pluck': -2.1, 'tropical-pluck': 7.1, 'stab-90s': 8, 'deep-chord': 4, 'dub-techno-chord': 8.6, 'fm-pluck': 5.6, 'banjo-pluck': -2.9, 'sitar-pluck': 5.2, 'arp-square': 5.1, 'arp-fm-glass': 5.6, 'arp-gated': 8.9, 'arp-sine-blip': 5.7, 'arp-acid': -5.2, 'arp-pwm': 7.5, 'downlifter': 8, 'impact-boom': -13, 'fm-zap': 4.2, 'scifi-drone': 0.8, 'vinyl-noise': 8, 'siren': -2.2, 'synth-brass-stab': 6.5, 'pizz-synth': -1.3, 'french-horn': -1.7, 'solo-violin': 7.4, 'cello-synth': 1.9, 'fm-timpani': 1.2, 'muted-guitar': -2.5, 'jazz-guitar': -1.2, 'twelve-string': -1.8, 'funk-guitar': -6.1,
};
