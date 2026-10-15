// Factory effect presets (pure data + helpers, Node-safe). One table per effect type:
//   FACTORY_EFFECT_PRESETS[type][name] = { params, tags, description }
// A preset is merged over the effect's defaults (params left out keep their default value).
// Entries may also use the short legacy shape { name: params } — normalizePresetEntry() accepts both, and
// effect families that carry their own `presets` on the def (src/audio/fx/defs) are picked up by
// effectPresetEntries() automatically.
import { EFFECT_DEFS } from './effect-defs.js';

/** Tags used to filter effect presets (free-form tags are allowed too; these get their own filter chips). */
export const EFFECT_PRESET_TAGS = ['subtle', 'creative', 'vocal', 'drums', 'bass', 'keys', 'guitar', 'synth', 'pad', 'master', 'bus', 'mix',
  'lofi', 'vintage', 'wide', 'tempo-sync', 'sidechain', 'cleanup', 'loud', 'space', 'warm', 'bright', 'dark', 'edm'];

const x = (params, tags = [], description = '') => ({ params, tags, description });

// EQ8 helper: band(i, type, freq, gain, q, on=true)
const band = (i, type, freq, gain = 0, q = 0.9, on = true) => ({ [`b${i}On`]: on, [`b${i}Type`]: type, [`b${i}Freq`]: freq, [`b${i}Gain`]: gain, [`b${i}Q`]: q });
const off = (...is) => Object.assign({}, ...is.map((i) => ({ [`b${i}On`]: false })));

export const FACTORY_EFFECT_PRESETS = {
  // ------------------------------------------------------------------ EQ & Filter
  eq3: {
    'Smile': x({ low: 4, mid: -3, high: 4 }, ['creative', 'mix'], 'Scooped mids, lifted lows and highs — the classic "loudness" curve.'),
    'Warm': x({ low: 2, high: -3 }, ['warm', 'subtle'], 'A touch more body, softer top.'),
    'Telephone': x({ low: -24, mid: 6, high: -24, midFreq: 1400, midQ: 1.2 }, ['creative', 'vocal', 'lofi'], 'Only the mid band survives — old phone / radio voice.'),
    'Cut lows': x({ low: -18 }, ['cleanup', 'mix'], 'Removes rumble and mud below ~250 Hz.'),
    'Vocal presence': x({ low: -3, lowFreq: 180, mid: 2.5, midFreq: 3000, midQ: 0.9, high: 2, highFreq: 9000 }, ['vocal', 'bright'], 'Less boom, more intelligibility and air.'),
    'Kick thump': x({ low: 4, lowFreq: 90, mid: -4, midFreq: 350, midQ: 1.4, high: 2, highFreq: 4500 }, ['drums'], 'Sub thump up, boxiness out, beater click up.'),
    'Bass definition': x({ low: 1.5, lowFreq: 100, mid: 3, midFreq: 900, midQ: 1, high: -6, highFreq: 5000 }, ['bass'], 'Brings out the growl so the bass reads on small speakers.'),
    'Dark & smooth': x({ high: -8, highFreq: 3500, mid: -1.5 }, ['dark', 'subtle', 'lofi'], 'Rolls the highs off for a darker, vintage tone.'),
    'Bright air': x({ high: 5, highFreq: 8000 }, ['bright', 'mix', 'vocal'], 'Open top end shelf.'),
    'Mid scoop': x({ mid: -6, midFreq: 500, midQ: 0.7 }, ['guitar', 'keys', 'mix'], 'Clears space in the low mids for the vocal.'),
    'Kill lows': x({ low: -24, lowFreq: 400 }, ['creative', 'edm'], 'DJ-style low kill — automate it for transitions.'),
    'Kill highs': x({ high: -24, highFreq: 1500 }, ['creative', 'edm'], 'DJ-style high kill.'),
    'Radio': x({ low: -18, lowFreq: 300, mid: 5, midFreq: 1800, midQ: 0.7, high: -14, highFreq: 5000, output: 2 }, ['creative', 'lofi', 'vocal'], 'Narrow-band transistor radio.'),
    'Snare crack': x({ low: -2, lowFreq: 150, mid: 3, midFreq: 2500, midQ: 1.2, high: 3, highFreq: 7000 }, ['drums', 'bright'], 'Snap and sizzle without the ring.'),
  },
  eq8: {
    'Clean low end': x({ ...band(1, 'highpass', 35, 0, 0.7), ...off(8) }, ['cleanup', 'mix', 'subtle'], 'Gentle 35 Hz high-pass: removes sub rumble only.'),
    'Vocal clarity': x({ ...band(1, 'highpass', 90, 0, 0.7), ...band(3, 'peaking', 250, -2.5, 1.2), ...band(5, 'peaking', 3200, 2.5, 1), ...band(7, 'highshelf', 10000, 3, 0.7), ...off(8) }, ['vocal', 'bright'], 'High-pass, de-mud, presence and air.'),
    'De-esser (static)': x({ ...band(1, 'highpass', 80, 0, 0.7), ...band(6, 'peaking', 6500, -5, 4), ...off(8) }, ['vocal', 'cleanup'], 'Narrow dip at the sibilance band.'),
    'Kick': x({ ...band(1, 'highpass', 30, 0, 0.7), ...band(2, 'lowshelf', 60, 3, 0.7), ...band(3, 'peaking', 350, -5, 1.6), ...band(5, 'peaking', 3500, 3, 1.2), ...off(8) }, ['drums'], 'Sub boost, box cut, click.'),
    'Snare': x({ ...band(1, 'highpass', 90, 0, 0.7), ...band(2, 'lowshelf', 200, 2, 0.8), ...band(4, 'peaking', 900, -3, 2), ...band(6, 'peaking', 5000, 3, 1), ...off(8) }, ['drums'], 'Body, less honk, crack.'),
    'Overheads': x({ ...band(1, 'highpass', 250, 0, 0.7), ...band(4, 'peaking', 2000, -2, 1.5), ...band(7, 'highshelf', 9000, 3, 0.7), ...off(8) }, ['drums', 'bright'], 'Cymbals only, with sheen.'),
    'Bass guitar': x({ ...band(1, 'highpass', 35, 0, 0.7), ...band(2, 'lowshelf', 80, 2, 0.7), ...band(3, 'peaking', 250, -3, 1.4), ...band(5, 'peaking', 1200, 3, 1.2), ...band(8, 'lowpass', 6000, 0, 0.7) }, ['bass'], 'Weight, de-mud, growl, no fizz.'),
    'Synth bass tight': x({ ...band(1, 'highpass', 30, 0, 0.7), ...band(2, 'lowshelf', 100, 1.5, 0.7), ...band(3, 'peaking', 180, -2, 1.2), ...band(8, 'lowpass', 9000, 0, 0.7) }, ['bass', 'synth', 'edm'], 'Cleans the low mids so the kick has room.'),
    'Acoustic guitar': x({ ...band(1, 'highpass', 100, 0, 0.7), ...band(3, 'peaking', 220, -3, 1.2), ...band(5, 'peaking', 2500, 1.5, 1), ...band(7, 'highshelf', 11000, 2.5, 0.7), ...off(8) }, ['guitar', 'bright'], 'Less boom, more sparkle.'),
    'Electric guitar': x({ ...band(1, 'highpass', 90, 0, 0.7), ...band(4, 'peaking', 800, -2, 1.2), ...band(5, 'peaking', 2500, 2.5, 1.2), ...band(8, 'lowpass', 8000, 0, 0.7) }, ['guitar'], 'Fits a distorted guitar around the vocal.'),
    'Piano': x({ ...band(1, 'highpass', 40, 0, 0.7), ...band(3, 'peaking', 300, -2, 1), ...band(6, 'peaking', 4000, 1.5, 1), ...band(7, 'highshelf', 10000, 2, 0.7), ...off(8) }, ['keys'], 'Open, clear piano.'),
    'Pad carve': x({ ...band(1, 'highpass', 180, 0, 0.7), ...band(4, 'peaking', 1000, -3, 0.8), ...band(8, 'lowpass', 11000, 0, 0.7) }, ['pad', 'mix'], 'Keeps pads out of the bass and the vocal.'),
    'Master polish': x({ ...band(1, 'highpass', 25, 0, 0.7), ...band(2, 'lowshelf', 90, 1, 0.7), ...band(3, 'peaking', 300, -1, 0.9), ...band(7, 'highshelf', 12000, 1.5, 0.7), ...off(8) }, ['master', 'subtle'], 'Very gentle tonal balance for the master bus.'),
    'Lo-fi band': x({ ...band(1, 'highpass', 300, 0, 0.9), ...band(5, 'peaking', 1500, 3, 0.8), ...band(8, 'lowpass', 4500, 0, 0.9) }, ['lofi', 'creative', 'vintage'], 'Narrow, boxy band like a cheap sampler.'),
    'Notch hum 50 Hz': x({ ...band(2, 'notch', 50, 0, 10), ...band(3, 'notch', 100, 0, 10), ...band(4, 'notch', 150, 0, 10), ...off(8) }, ['cleanup'], 'Notches mains hum (50 Hz + harmonics).'),
    'Notch hum 60 Hz': x({ ...band(2, 'notch', 60, 0, 10), ...band(3, 'notch', 120, 0, 10), ...band(4, 'notch', 180, 0, 10), ...off(8) }, ['cleanup'], 'Notches mains hum (60 Hz + harmonics).'),
    'Air shelf': x({ ...band(7, 'highshelf', 12000, 4, 0.7), ...off(8) }, ['bright', 'vocal', 'master'], 'Silky top-end lift.'),
  },
  filter: {
    'Wobble 1/8': x({ type: 'lowpass', cutoff: 600, resonance: 6, depth: 3, sync: true, division: '1/8' }, ['bass', 'edm', 'tempo-sync', 'creative'], 'Dubstep wobble locked to 1/8 notes.'),
    'Slow sweep': x({ type: 'lowpass', cutoff: 900, resonance: 4, depth: 2.5, sync: true, division: '2/1' }, ['pad', 'tempo-sync', 'creative'], 'Two-bar filter sweep.'),
    'Telephone': x({ type: 'bandpass', cutoff: 1500, resonance: 2, depth: 0 }, ['vocal', 'lofi', 'creative'], 'Band-passed phone voice.'),
    'Hi-pass build': x({ type: 'highpass', cutoff: 300, resonance: 3, depth: 0 }, ['edm', 'creative'], 'Automate the cutoff up for builds.'),
    'Low-pass muffle': x({ type: 'lowpass', cutoff: 450, resonance: 1, slope: '24', depth: 0 }, ['creative', 'dark', 'edm'], '"Next room" sound for breakdowns.'),
    'Wah 1/4': x({ type: 'bandpass', cutoff: 900, resonance: 8, depth: 2, sync: true, division: '1/4', shape: 'triangle' }, ['guitar', 'keys', 'tempo-sync'], 'Auto-wah on quarter notes.'),
    'Trance gate-ish 1/16': x({ type: 'lowpass', cutoff: 400, resonance: 4, depth: 3.5, sync: true, division: '1/16', shape: 'square' }, ['synth', 'pad', 'tempo-sync', 'edm'], 'Choppy square-wave filter on sixteenths.'),
    'Acid squelch': x({ type: 'lowpass', cutoff: 700, resonance: 14, slope: '24', depth: 1.5, sync: true, division: '1/2', shape: 'saw' }, ['bass', 'synth', 'creative'], 'Resonant 24 dB sweep for acid lines.'),
    'Gentle movement': x({ type: 'lowpass', cutoff: 3000, resonance: 1.5, depth: 0.8, sync: false, rate: 0.15 }, ['pad', 'subtle'], 'Slow, subtle breathing filter.'),
    'Notch sweep': x({ type: 'notch', cutoff: 1200, resonance: 2, depth: 2, sync: true, division: '1/1' }, ['creative', 'drums'], 'Phaser-like moving notch.'),
    'Riser 4 bars': x({ type: 'highpass', cutoff: 80, resonance: 5, depth: 4, sync: true, division: '4/1', shape: 'saw' }, ['edm', 'creative', 'tempo-sync'], 'High-pass that climbs over four bars.'),
    'Dark pad': x({ type: 'lowpass', cutoff: 1200, resonance: 2, slope: '24', depth: 0 }, ['pad', 'dark', 'subtle'], 'Static low-pass to sit pads in the back.'),
  },
  // ------------------------------------------------------------------ Dynamics
  compressor: {
    'Gentle glue': x({ threshold: -14, ratio: 2, attack: 0.03, release: 0.2, makeup: 2 }, ['bus', 'mix', 'subtle'], 'Low ratio, slow attack — holds a group together.'),
    'Punchy drums': x({ threshold: -20, ratio: 4, attack: 0.012, release: 0.08, makeup: 5 }, ['drums'], 'Lets the transient through, then clamps.'),
    'Vocal leveler': x({ threshold: -22, ratio: 3.5, attack: 0.005, release: 0.15, makeup: 6 }, ['vocal'], 'Even, upfront vocal.'),
    'Squash (parallel)': x({ threshold: -35, ratio: 12, attack: 0.002, release: 0.1, makeup: 12, mix: 0.4 }, ['drums', 'bus', 'creative'], 'New York parallel compression.'),
    'Bass control': x({ threshold: -18, ratio: 4, attack: 0.02, release: 0.12, knee: 6, makeup: 4 }, ['bass'], 'Keeps every bass note at the same level.'),
    'Kick snap': x({ threshold: -16, ratio: 5, attack: 0.025, release: 0.06, knee: 3, makeup: 3 }, ['drums'], 'Slow attack exaggerates the beater.'),
    'Snare crush': x({ threshold: -28, ratio: 10, attack: 0.001, release: 0.09, knee: 2, makeup: 9, mix: 0.6 }, ['drums', 'creative'], 'Fat, sustained snare.'),
    'Room smash': x({ threshold: -40, ratio: 20, attack: 0.0005, release: 0.25, knee: 0, makeup: 16, mix: 0.35 }, ['drums', 'creative', 'lofi'], 'Pumping, breathing room sound.'),
    'Mix bus 2:1': x({ threshold: -10, ratio: 2, attack: 0.03, release: 0.3, knee: 10, makeup: 1.5 }, ['master', 'bus', 'subtle'], 'SSL-style bus compression, 1–2 dB of reduction.'),
    'Acoustic guitar': x({ threshold: -20, ratio: 3, attack: 0.015, release: 0.18, knee: 8, makeup: 4 }, ['guitar', 'subtle'], 'Smooths strumming dynamics.'),
    'Piano': x({ threshold: -18, ratio: 2.5, attack: 0.02, release: 0.25, knee: 12, makeup: 3 }, ['keys', 'subtle'], 'Transparent piano leveling.'),
    'Synth lead': x({ threshold: -16, ratio: 3, attack: 0.008, release: 0.12, knee: 6, makeup: 3 }, ['synth'], 'Steady lead level.'),
    'Limiting (fast)': x({ threshold: -8, ratio: 20, attack: 0.0005, release: 0.05, knee: 0, makeup: 4 }, ['loud'], 'Peak catcher.'),
    'Sidechain duck': x({ threshold: -30, ratio: 8, attack: 0.002, release: 0.15, knee: 2, makeup: 0 }, ['sidechain', 'edm', 'bass'], 'Pick a kick as the Sidechain key to duck under it.'),
    'Vintage opto': x({ threshold: -24, ratio: 3, attack: 0.01, release: 0.6, knee: 18, makeup: 5 }, ['vocal', 'vintage', 'warm'], 'Slow, program-dependent feel of an optical leveler.'),
  },
  limiter: {
    'Safe': x({ gain: 0, threshold: -1, ceiling: -0.3 }, ['master', 'subtle'], 'Catches stray peaks only.'),
    'Loud': x({ gain: 6, threshold: -3, ceiling: -0.3 }, ['master', 'loud'], 'Competitive loudness.'),
    'Club': x({ gain: 9, threshold: -4, release: 0.05, ceiling: -0.2 }, ['master', 'loud', 'edm'], 'Dense, loud club master.'),
    'Streaming −1 dBTP': x({ gain: 3, threshold: -2, release: 0.12, ceiling: -1 }, ['master'], 'Headroom for lossy encoding on streaming platforms.'),
    'Transparent': x({ gain: 2, threshold: -1.5, release: 0.25, ceiling: -0.5, clip: false }, ['master', 'subtle'], 'Slow release, no clipper.'),
    'Drum bus': x({ gain: 4, threshold: -4, release: 0.04, ceiling: -1 }, ['drums', 'bus'], 'Tames drum peaks so the mix can be louder.'),
    'Bass ceiling': x({ gain: 2, threshold: -6, release: 0.08, ceiling: -3 }, ['bass'], 'Keeps sub peaks consistent.'),
    'Vocal peak catch': x({ gain: 0, threshold: -4, release: 0.06, ceiling: -2 }, ['vocal'], 'Stops occasional loud syllables.'),
    'Brickwall crush': x({ gain: 18, threshold: -12, release: 0.02, ceiling: -0.5 }, ['creative', 'loud', 'lofi'], 'Deliberately over-driven, pumping sound.'),
    'Podcast': x({ gain: 6, threshold: -6, release: 0.15, ceiling: -1 }, ['vocal', 'loud'], 'Even, loud spoken word.'),
    'Gentle +3 dB': x({ gain: 3, threshold: -1, release: 0.2, ceiling: -0.5 }, ['master', 'subtle'], 'A little extra level.'),
  },
  mastering: {
    'Balanced': x({ low: 0.5, tilt: 0, air: 1, glueThreshold: -16, glueRatio: 1.6, drive: 1, width: 1.05, gain: 3, ceiling: -1 }, ['master', 'subtle'], 'Neutral starting point: a bit of glue and air, −1 dBTP.'),
    'Loud & bright (EDM)': x({ low: 1.5, tilt: 1, air: 2, glueThreshold: -18, glueRatio: 2, glueAttack: 0.02, drive: 3, width: 1.2, gain: 8, ceiling: -1, release: 0.08 }, ['master', 'loud', 'edm', 'bright'], 'Dense, bright club master.'),
    'Warm analog': x({ low: 1.5, tilt: -1, air: 0.5, glueThreshold: -20, glueRatio: 2, glueAttack: 0.03, glueRelease: 0.4, drive: 4, width: 1, gain: 4, ceiling: -1 }, ['master', 'warm', 'vintage'], 'Darker tilt with tape-like saturation.'),
    'Hip-hop weight': x({ low: 3, tilt: -0.5, air: 1, glueThreshold: -16, glueRatio: 2.2, glueAttack: 0.03, drive: 2, width: 1.05, gain: 6, ceiling: -1 }, ['master', 'bass', 'loud'], 'Big low end, punchy glue.'),
    'Acoustic / jazz': x({ low: 0, tilt: 0, air: 1.5, glueThreshold: -12, glueRatio: 1.3, glueAttack: 0.05, glueRelease: 0.5, drive: 0, width: 1, gain: 1, ceiling: -1, release: 0.3 }, ['master', 'subtle'], 'Preserves dynamics.'),
    'Lo-fi tape': x({ low: 2, tilt: -3, air: -3, glueThreshold: -22, glueRatio: 2.5, drive: 6, width: 0.85, gain: 4, ceiling: -1 }, ['master', 'lofi', 'vintage', 'dark'], 'Dark, saturated and narrow.'),
    'Wide pop': x({ low: 1, tilt: 0.5, air: 2.5, glueThreshold: -16, glueRatio: 1.8, drive: 1.5, width: 1.35, widthFreq: 3000, gain: 6, ceiling: -1 }, ['master', 'wide', 'bright'], 'Polished pop with wide highs.'),
    'Streaming −14 LUFS-ish': x({ low: 0.5, tilt: 0, air: 1, glueThreshold: -16, glueRatio: 1.6, drive: 1, width: 1.1, gain: 4, ceiling: -1 }, ['master'], 'Moderate loudness for streaming normalisation.'),
    'Rock': x({ low: 1, tilt: 0.5, air: 1, glueThreshold: -18, glueRatio: 2.5, glueAttack: 0.01, drive: 3, width: 1.1, gain: 7, ceiling: -0.8 }, ['master', 'loud', 'guitar'], 'Aggressive glue and saturation.'),
    'Ambient': x({ low: 0, tilt: -0.5, air: 2, glueThreshold: -10, glueRatio: 1.2, glueRelease: 0.8, drive: 0.5, width: 1.4, widthFreq: 1500, gain: 1, ceiling: -1, release: 0.4 }, ['master', 'wide', 'space'], 'Gentle, wide and dynamic.'),
    'Demo quick': x({ low: 1, tilt: 0, air: 1.5, glueThreshold: -18, glueRatio: 2, drive: 2, width: 1.15, gain: 5, ceiling: -1 }, ['master'], 'One-click "sounds finished" demo master.'),
    'Mono-safe club': x({ low: 2, tilt: 0.5, air: 1.5, glueThreshold: -18, glueRatio: 2, drive: 2.5, width: 1, widthFreq: 5000, gain: 9, ceiling: -0.8, release: 0.06 }, ['master', 'loud', 'edm'], 'Loud with mono-compatible low end.'),
  },
  gate: {
    'Tight': x({ threshold: -30, release: 0.04 }, ['drums', 'cleanup'], 'Short release to stop bleed between hits.'),
    'Chop': x({ threshold: -20, range: -80, release: 0.02 }, ['creative'], 'Hard chopping of tails.'),
    'Noise floor': x({ threshold: -55, range: -30, attack: 0.002, release: 0.15, knee: 6 }, ['cleanup', 'vocal', 'subtle'], 'Lowers hiss and room noise between phrases.'),
    'Kick gate': x({ threshold: -24, range: -80, attack: 0.0005, release: 0.08, knee: 2 }, ['drums'], 'Isolates a kick mic.'),
    'Snare gate': x({ threshold: -26, range: -40, attack: 0.0005, release: 0.12, knee: 3 }, ['drums'], 'Removes hi-hat bleed, keeps some room.'),
    'Tom gate': x({ threshold: -32, range: -60, attack: 0.001, release: 0.25, knee: 3 }, ['drums'], 'Opens on tom hits, lets them ring.'),
    'Vocal cleanup': x({ threshold: -48, range: -20, attack: 0.003, release: 0.2, knee: 8 }, ['vocal', 'cleanup', 'subtle'], 'Soft gating between lines.'),
    'Guitar noise': x({ threshold: -45, range: -60, attack: 0.002, release: 0.1, knee: 4 }, ['guitar', 'cleanup'], 'Kills amp buzz when not playing.'),
    'Gated reverb': x({ threshold: -30, range: -80, attack: 0.0005, release: 0.03, knee: 0 }, ['drums', 'creative', 'vintage'], 'Place after a big reverb for the 80s gated snare.'),
    'Stutter': x({ threshold: -12, range: -80, attack: 0.0005, release: 0.01, knee: 0 }, ['creative', 'synth'], 'Very hard gate for glitchy chopping.'),
    'Soft expander': x({ threshold: -40, range: -12, attack: 0.005, release: 0.3, knee: 12 }, ['subtle', 'cleanup'], 'Gentle downward expansion.'),
  },
  ducker: {
    'Classic sidechain': x({ amount: 0.7, threshold: -20, attack: 0.005, release: 0.18 }, ['sidechain', 'edm', 'bass'], 'Pick the kick as Key Track: bass ducks under it.'),
    'Subtle tuck': x({ amount: 0.3, threshold: -24, attack: 0.008, release: 0.12 }, ['sidechain', 'subtle', 'mix'], 'Just enough to clear the kick transient.'),
    'Heavy pump': x({ amount: 0.95, threshold: -30, attack: 0.002, release: 0.3 }, ['sidechain', 'edm', 'creative'], 'Exaggerated French-house pump.'),
    'Vocal ducking (music)': x({ amount: 0.5, threshold: -30, attack: 0.02, release: 0.5 }, ['sidechain', 'vocal', 'mix'], 'Turns music down while the vocal / voice-over plays.'),
    'Pad under kick': x({ amount: 0.6, threshold: -22, attack: 0.004, release: 0.25 }, ['sidechain', 'pad', 'edm'], 'Breathing pads.'),
    'Reverb duck': x({ amount: 0.6, threshold: -26, attack: 0.01, release: 0.35 }, ['sidechain', 'space', 'vocal'], 'On a reverb return keyed by the dry vocal: clear words, wet tails.'),
    'Delay duck': x({ amount: 0.7, threshold: -26, attack: 0.01, release: 0.25 }, ['sidechain', 'space'], 'Echoes swell up only between phrases.'),
    'Fast & tight': x({ amount: 0.8, threshold: -18, attack: 0.001, release: 0.08 }, ['sidechain', 'drums', 'bass'], 'Short ducks for busy kick patterns.'),
    'Podcast music bed': x({ amount: 0.75, threshold: -36, attack: 0.05, release: 1.2 }, ['sidechain', 'vocal'], 'Slow auto-ducking under speech.'),
    'Gentle groove': x({ amount: 0.45, threshold: -20, attack: 0.006, release: 0.2 }, ['sidechain', 'subtle'], 'Musical, light pumping.'),
  },
  pump: {
    'Classic 1/4': x({ division: '1/4', depth: 0.8, shape: 'classic' }, ['edm', 'tempo-sync', 'sidechain'], 'Four-on-the-floor sidechain feel.'),
    'Gentle': x({ division: '1/4', depth: 0.4, shape: 'smooth' }, ['subtle', 'tempo-sync', 'sidechain'], 'Light breathing.'),
    'Hard 1/8': x({ division: '1/8', depth: 1, shape: 'hard' }, ['creative', 'tempo-sync'], 'Hard chopping on eighths.'),
    'Deep house': x({ division: '1/4', depth: 0.6, curve: 0.75, shape: 'smooth' }, ['edm', 'pad', 'tempo-sync', 'sidechain'], 'Smooth, long recovery.'),
    'French house': x({ division: '1/4', depth: 1, curve: 0.55, shape: 'classic', attack: 0.003 }, ['edm', 'creative', 'tempo-sync', 'sidechain'], 'Extreme filter-house pump.'),
    'Future bass': x({ division: '1/4', depth: 0.9, curve: 0.85, shape: 'linear' }, ['edm', 'synth', 'tempo-sync', 'sidechain'], 'Long linear swells on chords.'),
    'Half-time': x({ division: '1/2', depth: 0.8, curve: 0.6, shape: 'classic' }, ['tempo-sync', 'sidechain'], 'Pumps on 1 and 3.'),
    'Trance 1/16': x({ division: '1/16', depth: 0.9, curve: 0.5, shape: 'hard' }, ['edm', 'pad', 'tempo-sync'], 'Trance-gate style chop.'),
    'Offbeat': x({ division: '1/4', depth: 0.8, offset: 0.5, shape: 'classic' }, ['creative', 'tempo-sync'], 'Ducks on the off-beats instead.'),
    'Bass tuck': x({ division: '1/4', depth: 0.7, curve: 0.35, shape: 'classic', attack: 0.002 }, ['bass', 'tempo-sync', 'sidechain'], 'Short duck that clears the kick.'),
    'Triplet swing': x({ division: '1/8T', depth: 0.6, curve: 0.5, shape: 'smooth' }, ['creative', 'tempo-sync'], 'Triplet pulse.'),
  },
  // ------------------------------------------------------------------ Distortion
  distortion: {
    'Warm': x({ type: 'soft', drive: 8, tone: 6000, mix: 0.6 }, ['warm', 'subtle'], 'Soft clipping blended in.'),
    'Crunch': x({ type: 'tube', drive: 20, tone: 5000 }, ['guitar', 'synth'], 'Tube crunch.'),
    'Destroy': x({ type: 'fuzz', drive: 40, tone: 3500, output: -8 }, ['creative'], 'Maximum fuzz.'),
    'Fold': x({ type: 'foldback', drive: 24, mix: 0.7 }, ['creative', 'synth'], 'Wavefolder harmonics.'),
    'Bass grit': x({ type: 'tube', drive: 14, tone: 3000, output: -3, mix: 0.45 }, ['bass'], 'Parallel grit so the bass cuts through.'),
    'Drum smash': x({ type: 'hard', drive: 18, tone: 7000, output: -5, mix: 0.4 }, ['drums', 'bus'], 'Parallel hard clipping for drums.'),
    'Lo-fi fuzz': x({ type: 'fuzz', drive: 22, tone: 2500, output: -6, mix: 0.8 }, ['lofi', 'creative'], 'Dark, broken fuzz.'),
    'Guitar overdrive': x({ type: 'tube', drive: 28, tone: 4200, output: -6 }, ['guitar'], 'Classic overdrive pedal.'),
    'Hard clip master-safe': x({ type: 'hard', drive: 3, tone: 18000, output: -1, mix: 1 }, ['master', 'loud', 'subtle'], 'Very light clipper for peak control.'),
    'Vocal grit': x({ type: 'soft', drive: 16, tone: 5500, output: -4, mix: 0.35 }, ['vocal', 'creative'], 'Adds edge to a vocal in parallel.'),
    'Synth scream': x({ type: 'foldback', drive: 36, tone: 6000, output: -8, mix: 0.9 }, ['synth', 'edm', 'creative'], 'Aggressive folded lead.'),
    'Radio broken': x({ type: 'hard', drive: 30, tone: 1800, output: -6 }, ['lofi', 'creative', 'vocal'], 'Overdriven tiny speaker.'),
  },
  saturator: {
    'Subtle': x({ type: 'warm', drive: 3 }, ['subtle', 'mix'], 'Just a little harmonic density.'),
    'Warm': x({ type: 'warm', drive: 8 }, ['warm'], 'Asymmetric warmth.'),
    'Hot tube': x({ type: 'tube', drive: 15, output: -4 }, ['warm', 'creative'], 'Pushed tube stage.'),
    'Master glue': x({ type: 'soft', drive: 2, tone: 16000, mix: 0.6 }, ['master', 'subtle'], 'Parallel softness on the master.'),
    'Bass harmonics': x({ type: 'warm', drive: 10, tone: 6000, output: -3, mix: 0.7 }, ['bass'], 'Upper harmonics so subs translate to small speakers.'),
    'Drum bus warmth': x({ type: 'tube', drive: 6, tone: 10000, output: -1.5 }, ['drums', 'bus', 'warm'], 'Rounds transients, adds body.'),
    'Vocal warmth': x({ type: 'warm', drive: 5, tone: 12000, output: -1, mix: 0.5 }, ['vocal', 'warm', 'subtle'], 'Analog console flavor.'),
    'Dark tape': x({ type: 'soft', drive: 9, tone: 5000, output: -3 }, ['dark', 'vintage', 'lofi'], 'Rolled-off saturation.'),
    'Keys': x({ type: 'tube', drive: 7, tone: 9000, output: -2 }, ['keys', 'warm'], 'Bark for e-pianos and organs.'),
    'Synth fatten': x({ type: 'warm', drive: 12, tone: 11000, output: -4 }, ['synth', 'bass'], 'Thicker synths.'),
    'Parallel crush': x({ type: 'tube', drive: 22, tone: 7000, output: -6, mix: 0.3 }, ['creative', 'drums'], 'Heavy saturation blended under the dry signal.'),
  },
  tape: {
    'Subtle': x({ drive: 2, wow: 0.1, flutter: 0.05 }, ['subtle', 'vintage'], 'Barely-there tape character.'),
    'Cassette': x({ drive: 6, tone: 6000, wow: 0.4, flutter: 0.3 }, ['lofi', 'vintage'], 'Worn cassette deck.'),
    'Warped': x({ drive: 8, tone: 4500, wow: 0.9, wowRate: 0.4, flutter: 0.5 }, ['lofi', 'creative'], 'Warped record / old tape.'),
    'Studio 2-track': x({ drive: 4, tone: 14000, wow: 0.05, flutter: 0.03 }, ['master', 'subtle', 'warm'], 'Clean reel-to-reel mixdown machine.'),
    'Lo-fi hip-hop': x({ drive: 7, tone: 5000, wow: 0.55, wowRate: 0.5, flutter: 0.25, output: -2 }, ['lofi', 'keys', 'vintage'], 'Dusty keys and drums.'),
    'VHS': x({ drive: 5, tone: 3800, wow: 0.7, wowRate: 0.3, flutter: 0.6, output: -1 }, ['lofi', 'creative', 'pad'], 'Wobbly VHS soundtrack.'),
    'Drum tape': x({ drive: 10, tone: 9000, wow: 0.05, flutter: 0.05, output: -3 }, ['drums', 'warm'], 'Tape compression on drums.'),
    'Bass tape': x({ drive: 8, tone: 7000, wow: 0, flutter: 0.02, output: -2 }, ['bass', 'warm'], 'Rounded, saturated bass.'),
    'Seasick': x({ drive: 3, tone: 8000, wow: 1, wowRate: 1.2, flutter: 0.4 }, ['creative'], 'Strong pitch drift.'),
    'Dictaphone': x({ drive: 12, tone: 2500, wow: 0.3, wowRate: 1.5, flutter: 0.8, output: -4 }, ['lofi', 'vocal', 'creative'], 'Micro-cassette voice memo.'),
    'Vocal tape': x({ drive: 4, tone: 11000, wow: 0.08, flutter: 0.05, mix: 0.7 }, ['vocal', 'subtle', 'warm'], 'Gentle tape glue on vocals.'),
  },
  bitcrusher: {
    '12-bit sampler': x({ bits: 12, downsample: 2, mix: 1 }, ['lofi', 'vintage', 'drums'], 'SP-1200 / MPC60 style grit.'),
    '8-bit': x({ bits: 8, downsample: 4, mix: 1 }, ['lofi', 'creative'], 'Video-game crunch.'),
    'Destroyed': x({ bits: 4, downsample: 12, mix: 0.8 }, ['creative'], 'Barely recognizable.'),
    'Subtle grit': x({ bits: 12, downsample: 1, mix: 0.35 }, ['subtle', 'lofi'], 'Faint digital edge blended in.'),
    'Chiptune': x({ bits: 6, downsample: 3, output: -2 }, ['lofi', 'synth', 'creative'], 'NES-style.'),
    'Telephone digital': x({ bits: 8, downsample: 6, mix: 1, output: -2 }, ['vocal', 'lofi', 'creative'], 'Low sample-rate voice.'),
    'Drum crush (parallel)': x({ bits: 6, downsample: 2, mix: 0.4, output: -3 }, ['drums', 'creative'], 'Crushed drums under the clean ones.'),
    'Aliasing shimmer': x({ bits: 16, downsample: 8, mix: 0.5 }, ['creative', 'synth', 'bright'], 'Sample-rate reduction only: metallic aliases.'),
    'Bass rasp': x({ bits: 7, downsample: 2, mix: 0.45, output: -2 }, ['bass', 'creative'], 'Adds rasp to a sub.'),
    'Lo-fi 10-bit': x({ bits: 10, downsample: 3, mix: 0.8 }, ['lofi', 'keys'], 'Mellow sampler lo-fi.'),
    '1-bit fuzz': x({ bits: 1, downsample: 1, mix: 0.6, output: -10 }, ['creative'], 'Square-wave fuzz.'),
  },
  // ------------------------------------------------------------------ Delay & Reverb
  delay: {
    'Slapback': x({ sync: false, time: 0.09, feedback: 0.1, mix: 0.25 }, ['vocal', 'guitar', 'vintage'], 'Rockabilly slap.'),
    '1/8 dotted ping-pong': x({ sync: true, division: '1/8D', feedback: 0.4, pingpong: true, mix: 0.3 }, ['tempo-sync', 'wide', 'synth'], 'The U2 / trance dotted eighth.'),
    '1/4 dub': x({ sync: true, division: '1/4', feedback: 0.62, highcut: 2800, lowcut: 250, mix: 0.35 }, ['tempo-sync', 'creative', 'dark'], 'Dark, repeating dub echoes.'),
    '1/16 shimmer': x({ sync: true, division: '1/16', feedback: 0.5, pingpong: true, mix: 0.2 }, ['tempo-sync', 'bright', 'synth'], 'Fast sparkling repeats.'),
    'Vocal throw 1/4': x({ sync: true, division: '1/4', feedback: 0.35, lowcut: 300, highcut: 5000, mix: 0.25 }, ['vocal', 'tempo-sync', 'space'], 'Clean quarter-note echo for vocals.'),
    'Doubler': x({ sync: false, time: 0.025, feedback: 0, pingpong: true, mix: 0.35 }, ['vocal', 'guitar', 'wide'], 'Short stereo doubling.'),
    'Tape echo': x({ sync: true, division: '1/8D', feedback: 0.55, lowcut: 200, highcut: 3500, mix: 0.3 }, ['vintage', 'warm', 'tempo-sync'], 'Dark, decaying tape repeats.'),
    'Long ambient': x({ sync: true, division: '1/2', feedback: 0.75, pingpong: true, lowcut: 300, highcut: 4500, mix: 0.3 }, ['pad', 'space', 'tempo-sync'], 'Washes of half-note echoes.'),
    'Triplet bounce': x({ sync: true, division: '1/8T', feedback: 0.45, pingpong: true, mix: 0.25 }, ['tempo-sync', 'creative'], 'Triplet ping-pong groove.'),
    'Send (100% wet)': x({ sync: true, division: '1/8D', feedback: 0.45, mix: 1 }, ['space', 'bus'], 'For a return bus.'),
    'Guitar ambience': x({ sync: false, time: 0.38, feedback: 0.3, highcut: 4000, mix: 0.22 }, ['guitar', 'subtle'], 'Light free-time echo behind a guitar.'),
    'Runaway feedback': x({ sync: true, division: '1/4D', feedback: 0.92, lowcut: 400, highcut: 2500, mix: 0.4 }, ['creative'], 'Near self-oscillating echoes — automate for transitions.'),
    'Lead 1/4 dotted': x({ sync: true, division: '1/4D', feedback: 0.4, pingpong: true, lowcut: 250, highcut: 6000, mix: 0.22 }, ['synth', 'tempo-sync', 'wide'], 'Wide dotted-quarter lead delay.'),
    'Snare echo 1/8': x({ sync: true, division: '1/8', feedback: 0.25, lowcut: 400, mix: 0.2 }, ['drums', 'tempo-sync'], 'Eighth-note snare echo.'),
  },
  reverb: {
    'Small Room': x({ character: 'room', decay: 0.7, size: 0.25, predelay: 0.005, damping: 0.6, mix: 0.18 }, ['drums', 'subtle', 'space'], 'Tight, natural room.'),
    'Plate': x({ character: 'plate', decay: 1.6, size: 0.5, predelay: 0.015, damping: 0.3, mix: 0.25 }, ['vocal', 'drums', 'vintage', 'bright'], 'Classic bright plate.'),
    'Hall': x({ character: 'hall', decay: 3.2, size: 0.8, predelay: 0.025, damping: 0.45, mix: 0.3 }, ['space', 'keys', 'pad'], 'Concert hall.'),
    'Huge': x({ character: 'hall', decay: 8, size: 1, predelay: 0.04, damping: 0.35, mix: 0.45 }, ['space', 'creative', 'pad'], 'Enormous space.'),
    'Send (100% wet)': x({ decay: 2.2, size: 0.6, mix: 1 }, ['space', 'bus'], 'For a return bus.'),
    'Vocal plate': x({ character: 'plate', decay: 1.9, size: 0.55, predelay: 0.03, damping: 0.35, lowcut: 300, highcut: 9000, mix: 0.2 }, ['vocal', 'bright'], 'Plate with pre-delay so the words stay clear.'),
    'Drum room': x({ character: 'room', decay: 0.9, size: 0.35, predelay: 0.002, damping: 0.5, lowcut: 200, mix: 0.2 }, ['drums', 'space'], 'Live drum room.'),
    'Snare plate': x({ character: 'plate', decay: 1.3, size: 0.45, predelay: 0.01, damping: 0.25, lowcut: 250, mix: 0.25 }, ['drums', 'bright'], 'Bright plate for snares and claps.'),
    'Chamber': x({ character: 'chamber', decay: 1.4, size: 0.45, predelay: 0.012, damping: 0.5, mix: 0.22 }, ['vocal', 'keys', 'vintage'], 'Echo-chamber warmth.'),
    'Ambience': x({ character: 'ambience', decay: 0.5, size: 0.2, predelay: 0, damping: 0.5, mix: 0.15 }, ['subtle', 'mix'], 'Adds space without an audible tail.'),
    'Cathedral': x({ character: 'hall', decay: 10, size: 1, predelay: 0.06, damping: 0.55, lowcut: 120, mix: 0.4 }, ['space', 'pad', 'creative'], 'Stone cathedral.'),
    'Dark hall': x({ character: 'hall', decay: 4, size: 0.85, predelay: 0.03, damping: 0.8, highcut: 4500, mix: 0.3 }, ['dark', 'space', 'pad'], 'Soft, dark tail.'),
    'Piano hall': x({ character: 'hall', decay: 2.4, size: 0.7, predelay: 0.02, damping: 0.45, lowcut: 180, mix: 0.25 }, ['keys', 'space'], 'Natural space for piano.'),
    'Guitar spring-ish': x({ character: 'plate', decay: 1.1, size: 0.3, predelay: 0.004, damping: 0.6, lowcut: 400, highcut: 5000, mix: 0.25 }, ['guitar', 'vintage'], 'Short, bright amp-style reverb.'),
    'Lo-fi wash': x({ character: 'hall', decay: 5, size: 0.9, predelay: 0.05, damping: 0.85, lowcut: 300, highcut: 3500, mix: 0.35 }, ['lofi', 'space', 'dark'], 'Muffled washy tail.'),
    'Gated 80s': x({ character: 'room', decay: 0.4, size: 0.6, predelay: 0, damping: 0.2, lowcut: 300, mix: 0.4 }, ['drums', 'vintage', 'creative'], 'Short dense burst (add a Gate after it for the full effect).'),
  },
  // ------------------------------------------------------------------ Modulation
  chorus: {
    'Subtle': x({ depth: 0.3, mix: 0.3 }, ['subtle'], 'Light thickening.'),
    'Wide': x({ depth: 0.6, mix: 0.5, spread: 1 }, ['wide'], 'Stereo spread.'),
    'Huge': x({ depth: 0.9, rate: 0.4, mix: 0.6 }, ['wide', 'creative', 'pad'], 'Massive, slow chorus.'),
    'Juno I': x({ rate: 0.5, depth: 0.45, delay: 0.012, spread: 1, mix: 0.5 }, ['synth', 'pad', 'vintage'], 'The classic Juno-60 chorus mode I.'),
    'Juno II': x({ rate: 0.85, depth: 0.6, delay: 0.012, spread: 1, mix: 0.5 }, ['synth', 'pad', 'vintage'], 'Faster, deeper mode II.'),
    'Guitar shimmer': x({ rate: 1.2, depth: 0.35, delay: 0.008, spread: 0.8, mix: 0.4 }, ['guitar', 'bright'], 'Clean-guitar chorus pedal.'),
    'Vocal double': x({ rate: 0.3, depth: 0.2, delay: 0.022, spread: 1, mix: 0.3 }, ['vocal', 'wide', 'subtle'], 'Fake double-tracking.'),
    'Bass chorus (mono-ish)': x({ rate: 0.6, depth: 0.3, delay: 0.015, spread: 0.3, mix: 0.3 }, ['bass', 'subtle'], 'Narrow chorus that keeps the low end centered.'),
    'Rhodes': x({ rate: 0.7, depth: 0.5, delay: 0.018, spread: 0.9, mix: 0.45 }, ['keys', 'vintage'], 'Electric-piano chorus.'),
    'Seasick': x({ rate: 3.5, depth: 0.9, delay: 0.025, spread: 1, mix: 0.5 }, ['creative', 'lofi'], 'Fast, warbling detune.'),
    'Synced 1/2': x({ sync: true, division: '1/2', depth: 0.55, mix: 0.45 }, ['tempo-sync', 'synth'], 'Chorus sweep locked to half notes.'),
    'Ensemble strings': x({ rate: 0.9, depth: 0.7, delay: 0.02, spread: 1, mix: 0.55 }, ['pad', 'wide', 'vintage'], 'String-machine ensemble.'),
  },
  flanger: {
    'Jet': x({ depth: 0.8, feedback: 0.7, rate: 0.15 }, ['creative'], 'Jet-plane sweep.'),
    'Metallic': x({ depth: 0.5, feedback: -0.85, rate: 0.5 }, ['creative', 'synth'], 'Hollow, metallic resonance.'),
    'Subtle sweep': x({ depth: 0.4, feedback: 0.3, rate: 0.2, mix: 0.35 }, ['subtle'], 'Gentle movement.'),
    'Drum bus jet 1 bar': x({ sync: true, division: '1/1', depth: 0.7, feedback: 0.6, mix: 0.5 }, ['drums', 'tempo-sync', 'edm'], 'Bar-long flange on drums for transitions.'),
    'Hi-hat swirl': x({ sync: true, division: '2/1', depth: 0.6, feedback: 0.75, mix: 0.6 }, ['drums', 'tempo-sync', 'creative'], 'Slow swirl on hats.'),
    'Guitar 70s': x({ rate: 0.3, depth: 0.65, delay: 0.005, feedback: 0.55, mix: 0.5 }, ['guitar', 'vintage'], 'Classic pedal flanger.'),
    'Vocal through-zero-ish': x({ rate: 0.1, depth: 0.9, delay: 0.003, feedback: 0.2, mix: 0.5 }, ['vocal', 'creative'], 'Slow, deep tape-style flange.'),
    'Resonant zap': x({ rate: 4, depth: 0.3, delay: 0.004, feedback: 0.9, mix: 0.5 }, ['creative', 'synth'], 'Fast resonant buzz.'),
    'Negative hollow': x({ rate: 0.25, depth: 0.6, delay: 0.006, feedback: -0.6, mix: 0.5 }, ['creative'], 'Inverted feedback, hollow tone.'),
    'Pad movement': x({ sync: true, division: '4/1', depth: 0.5, feedback: 0.4, mix: 0.4 }, ['pad', 'subtle', 'tempo-sync'], 'Very slow 4-bar flange on pads.'),
  },
  phaser: {
    'Slow swirl': x({ rate: 0.2, depth: 2.5, stages: 6 }, ['pad', 'subtle'], 'Slow swirling phase.'),
    'Funky': x({ sync: true, division: '1/4', depth: 3, feedback: 0.6 }, ['keys', 'guitar', 'tempo-sync'], 'Quarter-note funk phaser.'),
    'Phase 90': x({ rate: 0.6, stages: 4, frequency: 700, depth: 2, feedback: 0.2, q: 0.7, mix: 0.5 }, ['guitar', 'vintage'], 'Four-stage pedal classic.'),
    'Small Stone': x({ rate: 0.35, stages: 4, frequency: 900, depth: 2.5, feedback: 0.6, q: 0.9, mix: 0.5 }, ['keys', 'vintage', 'synth'], 'Resonant 70s phaser.'),
    'Deep 12-stage': x({ rate: 0.15, stages: 12, frequency: 600, depth: 3.5, feedback: 0.7, q: 0.8, mix: 0.5 }, ['creative', 'pad'], 'Very deep notches.'),
    'Rhodes': x({ rate: 0.8, stages: 4, frequency: 800, depth: 1.8, feedback: 0.3, mix: 0.45 }, ['keys', 'vintage', 'subtle'], 'E-piano phaser.'),
    'Synced 1/8': x({ sync: true, division: '1/8', stages: 6, depth: 2.5, feedback: 0.5, mix: 0.5 }, ['tempo-sync', 'creative', 'synth'], 'Rhythmic eighth-note phasing.'),
    'Drum bus 2 bars': x({ sync: true, division: '2/1', stages: 8, depth: 3, feedback: 0.4, mix: 0.45 }, ['drums', 'tempo-sync', 'edm'], 'Slow phasing on a drum loop.'),
    'Vocal subtle': x({ rate: 0.25, stages: 4, frequency: 1200, depth: 1.2, feedback: 0.15, mix: 0.3 }, ['vocal', 'subtle'], 'Gentle movement on vocals.'),
    'Mono vintage': x({ rate: 0.5, stages: 6, depth: 2.2, feedback: 0.45, stereo: false, mix: 0.5 }, ['vintage'], 'Mono phaser like old units.'),
    'Laser sweep': x({ rate: 3, stages: 8, frequency: 1500, depth: 3, feedback: 0.85, q: 1.5, mix: 0.5 }, ['creative', 'synth'], 'Fast resonant zaps.'),
  },
  tremolo: {
    'Gentle 1/8': x({ sync: true, division: '1/8', depth: 0.4 }, ['tempo-sync', 'subtle'], 'Soft eighth-note pulse.'),
    'Chop 1/16': x({ sync: true, division: '1/16', depth: 1, shape: 'square' }, ['tempo-sync', 'creative', 'pad'], 'Trance-gate chop.'),
    'Stereo': x({ stereo: true, depth: 0.6 }, ['wide'], 'Ping-pong tremolo.'),
    'Surf guitar': x({ sync: false, rate: 6, depth: 0.7, shape: 'triangle' }, ['guitar', 'vintage'], 'Amp-style tremolo.'),
    'Vintage amp': x({ sync: false, rate: 4.5, depth: 0.5, shape: 'sine' }, ['guitar', 'keys', 'vintage'], 'Smooth bias tremolo.'),
    'Rhodes stereo': x({ sync: true, division: '1/8', depth: 0.6, stereo: true, shape: 'sine' }, ['keys', 'wide', 'tempo-sync'], 'Suitcase-piano stereo vibrato.'),
    'Helicopter': x({ sync: true, division: '1/32', depth: 1, shape: 'square' }, ['creative', 'tempo-sync'], 'Very fast chop.'),
    'Triplet pulse': x({ sync: true, division: '1/8T', depth: 0.8, shape: 'triangle' }, ['tempo-sync', 'creative'], 'Triplet swing pulse.'),
    'Sidechain-ish saw': x({ sync: true, division: '1/4', depth: 0.8, shape: 'saw' }, ['edm', 'tempo-sync', 'sidechain'], 'Saw ramp volume — a cheap pump.'),
    'Slow swell': x({ sync: true, division: '1/1', depth: 0.5, shape: 'sine' }, ['pad', 'subtle', 'tempo-sync'], 'One swell per bar.'),
  },
  autopan: {
    'Subtle': x({ depth: 0.4, sync: true, division: '1/2' }, ['subtle', 'tempo-sync'], 'Gentle half-note drift.'),
    'Wide 1/4': x({ depth: 1, sync: true, division: '1/4' }, ['wide', 'tempo-sync'], 'Full left-right on quarters.'),
    'Hats 1/8': x({ depth: 0.6, sync: true, division: '1/8', shape: 'triangle' }, ['drums', 'tempo-sync'], 'Moving hi-hats.'),
    'Slow drift': x({ depth: 0.5, sync: false, rate: 0.08, shape: 'sine' }, ['pad', 'subtle'], 'Very slow wander.'),
    'Ping-pong 1/16': x({ depth: 1, sync: true, division: '1/16', shape: 'square' }, ['creative', 'tempo-sync'], 'Hard left-right switching.'),
    'Bar sweep': x({ depth: 0.8, sync: true, division: '1/1', shape: 'triangle' }, ['tempo-sync', 'synth'], 'One sweep per bar.'),
    'Arp spread': x({ depth: 0.7, sync: true, division: '1/4D', shape: 'sine' }, ['synth', 'tempo-sync', 'wide'], 'Dotted-quarter motion for arps.'),
    'Rotary-ish': x({ depth: 0.6, sync: false, rate: 6, shape: 'sine' }, ['keys', 'vintage'], 'Fast pan like a rotating speaker.'),
    'Triplet': x({ depth: 0.8, sync: true, division: '1/4T', shape: 'triangle' }, ['creative', 'tempo-sync'], 'Triplet pan.'),
    'Tremolo pan (saw)': x({ depth: 0.9, sync: true, division: '1/8', shape: 'saw' }, ['creative', 'tempo-sync'], 'Sawtooth jumps.'),
  },
  // ------------------------------------------------------------------ Stereo / Utility
  widener: {
    'Subtle': x({ width: 1.2 }, ['subtle', 'wide'], 'A little wider.'),
    'Wide': x({ width: 1.6, monoBelow: 150 }, ['wide'], 'Wide with mono lows.'),
    'Huge': x({ width: 2, monoBelow: 200 }, ['wide', 'creative'], 'Maximum width (check mono!).'),
    'Mono': x({ width: 0 }, ['mix', 'cleanup'], 'Collapse to mono.'),
    'Master safe': x({ width: 1.1, monoBelow: 120 }, ['master', 'subtle', 'wide'], 'Slightly wider, mono below 120 Hz.'),
    'Bass mono': x({ width: 1, monoBelow: 250 }, ['bass', 'cleanup'], 'Keeps stereo highs, mono below 250 Hz.'),
    'Pad wide': x({ width: 1.7, monoBelow: 200 }, ['pad', 'wide'], 'Wide pads that leave the center free.'),
    'Narrow': x({ width: 0.6 }, ['mix'], 'Pull a wide sound in toward the center.'),
    'Backing vocals': x({ width: 1.5, monoBelow: 150, output: -1 }, ['vocal', 'wide'], 'Spreads backing vocals around the lead.'),
    'Overheads': x({ width: 1.3, monoBelow: 300 }, ['drums', 'wide'], 'Wider cymbals, mono kick bleed.'),
    'Club mono-sub': x({ width: 1.2, monoBelow: 140 }, ['edm', 'master', 'bass'], 'Club-safe low end.'),
  },
  utility: {
    'Mono': x({ mono: true }, ['mix', 'cleanup'], 'Sum to mono.'),
    '-6 dB': x({ gain: -6 }, ['mix'], 'Gain staging trim.'),
    'Phase flip': x({ invert: true }, ['cleanup', 'drums'], 'Polarity invert (multi-mic drums).'),
    '+6 dB': x({ gain: 6 }, ['mix'], 'Boost a quiet source.'),
    '-12 dB': x({ gain: -12 }, ['mix'], 'Big trim before hot plugins.'),
    'Hard left': x({ pan: -1 }, ['mix'], 'Pan fully left.'),
    'Hard right': x({ pan: 1 }, ['mix'], 'Pan fully right.'),
    'Narrow 50%': x({ width: 0.5 }, ['mix'], 'Half width.'),
    'Wide 150%': x({ width: 1.5 }, ['wide'], 'Extra width.'),
    'Mono bass check': x({ mono: true, gain: 0 }, ['bass', 'cleanup'], 'Check mono compatibility.'),
    'Silence': x({ gain: -36 }, ['mix'], 'Mute without bypassing.'),
    'Left 30%': x({ pan: -0.3 }, ['mix'], 'Gentle left placement.'),
    'Right 30%': x({ pan: 0.3 }, ['mix'], 'Gentle right placement.'),
  },
};

/** { params, tags, description } from either preset shape ({ name: params } or { name: { params, tags, description } }). */
export function normalizePresetEntry(v) {
  if (v && typeof v === 'object' && v.params && typeof v.params === 'object' && !Array.isArray(v.params)) {
    return { params: { ...v.params }, tags: Array.isArray(v.tags) ? [...v.tags] : [], description: v.description || '' };
  }
  return { params: { ...(v || {}) }, tags: [], description: '' };
}

/**
 * All factory presets of an effect type: the curated table first, then the def's own `presets`
 * (src/audio/fx/defs). -> [{ name, params, tags, description, type }]
 */
export function effectPresetEntries(type, defs = EFFECT_DEFS) {
  const out = [];
  const seen = new Set();
  for (const src of [FACTORY_EFFECT_PRESETS[type], defs?.[type]?.presets]) {
    if (!src || typeof src !== 'object') continue;
    for (const [name, v] of Object.entries(src)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, type, ...normalizePresetEntry(v) });
    }
  }
  return out;
}

/** Legacy flat view { name: params } of an effect type's presets (null when it has none). */
export function effectPresetMap(type, defs = EFFECT_DEFS) {
  const list = effectPresetEntries(type, defs);
  return list.length ? Object.fromEntries(list.map((p) => [p.name, p.params])) : null;
}
