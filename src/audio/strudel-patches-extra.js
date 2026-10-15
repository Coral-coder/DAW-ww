// More curated Strudel (superdough) patches, appended to STRUDEL_PATCHES by strudel-patches.js. Same shape:
// { id, name, role, roles, genres, patch, fallbackPreset } — fallbackPreset is the built-in preset that plays when
// superdough (or the patch's samples) can't load. Gains follow the original table: synth patches measured against
// their fallback preset like the originals; sample patches start from the level of the closest original patch with
// the same sample family.

const P = (id, name, role, roles, genres, patch, fallbackPreset) => ({ id, name, role, roles, genres, patch, fallbackPreset });
const space = (room, size = 3) => ({ room, size });
const echo = (delay, delayfeedback = 0.4) => ({ delay, delayfeedback });

export const EXTRA_STRUDEL_PATCHES = [
  /* ------------------------------ BASS ------------------------------ */
  P('sd-distorted-808', 'Distorted 808', 'bass', ['bass'], ['trap', 'drill', 'phonk', 'rage'],
    { s: 'sine', penv: 9, pattack: 0.001, pdecay: 0.06, attack: 0.002, decay: 1.8, sustain: 0.4, release: 0.35, shape: 0.6, lpf: 5000, gain: 0.928 }, 'distorted-808'),
  P('sd-rubber-bass', 'Rubber Bass', 'bass', ['bass'], ['funk', 'nu-disco', 'disco', 'boogie'],
    { s: 'square', lpf: 420, resonance: 7, lpenv: 3, lpdecay: 0.12, lpsustain: 0.1, attack: 0.002, decay: 0.3, sustain: 0.6, release: 0.06, gain: 0.818 }, 'rubber-bass'),
  P('sd-garage-bass', 'Garage Bass', 'bass', ['bass'], ['uk-garage', 'two-step', 'speed-garage', 'bassline'],
    { s: 'square', lpf: 520, resonance: 5, lpenv: 2.2, lpdecay: 0.15, lpsustain: 0.25, attack: 0.002, decay: 0.35, sustain: 0.75, release: 0.08, gain: 0.729 }, 'garage-bass'),
  P('sd-neuro-bass', 'Neuro Bass', 'bass', ['bass'], ['dnb', 'neurofunk', 'dubstep'],
    { s: 'supersaw', unison: 3, detune: 0.3, spread: 0.2, lpf: 700, resonance: 8, lpenv: 1.5, lpdecay: 0.2, lpsustain: 0.3, attack: 0.003, decay: 0.4, sustain: 1, release: 0.1, shape: 0.4, gain: 1.25 }, 'neuro-bass'),
  P('sd-slap-bass', 'Slap Bass (GM)', 'bass', ['bass'], ['funk', 'fusion', 'pop', 'city-pop'],
    { s: 'gm_slap_bass_1', release: 0.1, gain: 1.6 }, 'fm-slap-bass'),
  P('sd-fretless', 'Fretless Bass (GM)', 'bass', ['bass'], ['jazz', 'fusion', 'ballad', 'world'],
    { s: 'gm_fretless_bass', release: 0.15, gain: 1.8 }, 'mellow-bass'),
  P('sd-synth-bass-gm', 'Synth Bass (GM)', 'bass', ['bass'], ['80s', 'synthwave', 'electro', 'pop'],
    { s: 'gm_synth_bass_1', release: 0.08, gain: 1.3 }, 'pulse-bass'),

  /* ------------------------------ LEAD ------------------------------ */
  P('sd-future-lead', 'Future Lead', 'lead', ['lead'], ['future-bass', 'edm', 'kpop', 'melodic-dubstep'],
    { s: 'supersaw', unison: 5, detune: 0.3, spread: 0.9, lpf: 5000, lpenv: 1, lpdecay: 0.3, lpsustain: 0.6, attack: 0.004, decay: 0.3, sustain: 0.85, release: 0.25, vib: 5.8, vibmod: 0.12, ...echo(0.2, 0.35), ...space(0.2, 3), gain: 0.842 }, 'future-lead'),
  P('sd-gfunk-whine', 'G-Funk Whine', 'lead', ['lead'], ['g-funk', 'west-coast', 'hiphop'],
    { s: 'sine', fm: 0.5, fmh: 1, attack: 0.03, decay: 0.2, sustain: 0.9, release: 0.2, vib: 5, vibmod: 0.18, ...echo(0.15, 0.3), gain: 0.446 }, 'gfunk-whine'),
  P('sd-theremin', 'Theremin', 'lead', ['lead', 'fx'], ['cinematic', 'sci-fi', 'experimental'],
    { s: 'sine', attack: 0.12, decay: 0.3, sustain: 1, release: 0.35, vib: 6, vibmod: 0.3, ...space(0.35, 4), gain: 0.404 }, 'theremin'),
  P('sd-pwm-lead', 'Pulse Lead', 'lead', ['lead'], ['synthwave', '80s', 'italo-disco'],
    { s: 'pulse', lpf: 3500, lpenv: 1.2, lpdecay: 0.4, lpsustain: 0.5, attack: 0.004, decay: 0.3, sustain: 0.85, release: 0.2, vib: 5.5, vibmod: 0.08, ...echo(0.2, 0.35), gain: 0.349 }, 'pwm-lead'),
  P('sd-psy-lead', 'Psy Lead', 'lead', ['lead', 'arp'], ['psytrance', 'goa', 'trance'],
    { s: 'sawtooth', lpf: 900, resonance: 12, lpenv: 3.5, lpdecay: 0.15, lpsustain: 0.1, attack: 0.002, decay: 0.2, sustain: 0.6, release: 0.08, shape: 0.2, ...echo(0.18, 0.4), gain: 0.624 }, 'psy-lead'),
  P('sd-ocarina', 'Ocarina', 'lead', ['lead'], ['world', 'video-game', 'fantasy', 'cinematic'],
    { s: 'ocarina', attack: 0.03, release: 0.2, ...space(0.3, 4), gain: 1.4 }, 'ocarina-lead'),
  P('sd-harmonica', 'Harmonica', 'lead', ['lead'], ['blues', 'country', 'folk', 'americana'],
    { s: 'harmonica', attack: 0.02, release: 0.15, ...space(0.2), gain: 1.5 }, 'soft-square-lead'),
  P('sd-recorder', 'Recorder', 'lead', ['lead'], ['folk', 'baroque', 'cinematic', 'lofi-hip-hop'],
    { s: 'recorder_alto_sus', attack: 0.03, release: 0.2, ...space(0.25), gain: 1.3 }, 'flute'),
  P('sd-pan-flute', 'Pan Flute (GM)', 'lead', ['lead'], ['world', 'andean', 'cinematic', 'new-age'],
    { s: 'gm_pan_flute', attack: 0.04, release: 0.25, ...space(0.35, 4), gain: 1.3 }, 'ocarina-lead'),
  P('sd-shakuhachi', 'Shakuhachi (GM)', 'lead', ['lead'], ['japanese', 'world', 'cinematic', 'lofi-hip-hop'],
    { s: 'gm_shakuhachi', attack: 0.05, release: 0.3, ...space(0.35, 4), gain: 1.3 }, 'flute'),

  /* ------------------------------ KEYS ------------------------------ */
  P('sd-wurli', 'Wurli (GM EP2)', 'chords', ['chords', 'lead'], ['soul', 'neo-soul', 'indie', 'rnb', 'lofi-hip-hop'],
    { s: 'gm_epiano2', release: 0.4, ...space(0.2, 2), gain: 1 }, 'wurli'),
  P('sd-dx-piano', 'DX Piano', 'chords', ['chords'], ['80s', 'city-pop', 'ballad', 'synthwave'],
    { s: 'sine', fm: 2, fmh: 1, fmdecay: 0.9, fmsustain: 0.05, attack: 0.002, decay: 2, sustain: 0.1, release: 0.4, ...space(0.2, 2), gain: 0.535 }, 'fm-dx-piano'),
  P('sd-gospel-organ', 'Gospel Organ (GM)', 'chords', ['chords', 'pad'], ['gospel', 'soul', 'rnb', 'blues'],
    { s: 'gm_percussive_organ', attack: 0.005, release: 0.15, vib: 6, vibmod: 0.03, ...space(0.2), gain: 1.3 }, 'organ-gospel'),
  P('sd-church-organ', 'Church Organ (GM)', 'chords', ['chords', 'pad'], ['classical', 'cinematic', 'gospel', 'christmas'],
    { s: 'gm_church_organ', attack: 0.05, release: 0.6, ...space(0.55, 7), gain: 1 }, 'organ-church'),
  P('sd-harpsichord', 'Harpsichord (GM)', 'chords', ['chords', 'arp'], ['baroque', 'classical', 'cinematic'],
    { s: 'gm_harpsichord', release: 0.3, ...space(0.2, 3), gain: 1.1 }, 'harpsichord'),
  P('sd-music-box', 'Music Box (GM)', 'arp', ['arp', 'lead'], ['lofi-hip-hop', 'ambient', 'lullaby', 'christmas'],
    { s: 'gm_music_box', release: 0.8, ...space(0.3, 4), gain: 1.9 }, 'music-box'),
  P('sd-celesta', 'Celesta (GM)', 'arp', ['arp', 'lead'], ['cinematic', 'christmas', 'classical'],
    { s: 'gm_celesta', release: 0.7, ...space(0.3, 4), gain: 2 }, 'celesta'),

  /* ------------------------------ PADS ------------------------------ */
  P('sd-analog-pad', 'Analog Pad', 'pad', ['pad', 'chords'], ['synthwave', 'house', 'pop', 'cinematic'],
    { s: 'sawtooth', lpf: 1400, resonance: 1, attack: 0.6, decay: 1, sustain: 0.85, release: 1.2, vib: 4, vibmod: 0.05, ...space(0.45, 6), gain: 0.492 }, 'analog-pad'),
  P('sd-shimmer-pad', 'Shimmer Pad', 'pad', ['pad'], ['ambient', 'post-rock', 'worship', 'chillwave'],
    { s: 'supersaw', unison: 5, detune: 0.12, spread: 1, lpf: 6000, hpf: 300, attack: 1.2, decay: 1.5, sustain: 0.9, release: 2.5, ...echo(0.3, 0.55), ...space(0.7, 9), gain: 0.421 }, 'shimmer-pad'),
  P('sd-sweep-pad', 'Sweep Pad', 'pad', ['pad'], ['trance', 'progressive-house', 'synthwave'],
    { s: 'supersaw', unison: 4, detune: 0.2, spread: 0.9, lpf: 700, resonance: 6, lpenv: 3, lpattack: 2.5, lpdecay: 2, lpsustain: 0.4, attack: 0.5, decay: 1, sustain: 0.9, release: 1.5, ...space(0.5, 6), gain: 0.571 }, 'sweep-pad'),
  P('sd-voice-oohs', 'Voice Oohs (GM)', 'pad', ['pad'], ['cinematic', 'gospel', 'rnb', 'ambient'],
    { s: 'gm_voice_oohs', attack: 0.25, release: 1, ...space(0.45, 5), gain: 1 }, 'choir-ooh'),
  P('sd-bowed-pad', 'Bowed Pad (GM)', 'pad', ['pad'], ['ambient', 'cinematic', 'post-rock'],
    { s: 'gm_pad_bowed', attack: 0.4, release: 1.5, ...space(0.5, 6), gain: 0.8 }, 'cinematic-swell'),
  P('sd-warm-pad-gm', 'Warm Pad (GM)', 'pad', ['pad', 'chords'], ['rnb', 'pop', 'chillwave', 'downtempo'],
    { s: 'gm_pad_warm', attack: 0.3, release: 1.2, ...space(0.4, 5), gain: 0.75 }, 'warm-pad'),
  P('sd-tremolo-strings', 'Tremolo Strings (GM)', 'pad', ['pad'], ['cinematic', 'trailer', 'classical', 'horror'],
    { s: 'gm_tremolo_strings', attack: 0.1, release: 0.8, ...space(0.4, 5), gain: 1 }, 'cinematic-swell'),

  /* ------------------------------ PLUCKS / ARPS / FX ------------------------------ */
  P('sd-nylon', 'Nylon Guitar (GM)', 'chords', ['chords', 'arp'], ['bossa-nova', 'latin', 'flamenco', 'folk', 'reggaeton'],
    { s: 'gm_acoustic_guitar_nylon', release: 0.3, ...space(0.2, 3), gain: 1.3 }, 'nylon-pluck'),
  P('sd-dub-chord', 'Dub Techno Chord', 'chords', ['chords'], ['dub-techno', 'techno', 'minimal', 'deep-house'],
    { s: 'sawtooth', lpf: 700, resonance: 7, lpenv: 1.8, lpdecay: 0.2, lpsustain: 0, attack: 0.002, decay: 0.25, sustain: 0, release: 0.2, ...echo(0.45, 0.65), ...space(0.5, 7), gain: 0.815 }, 'dub-techno-chord'),
  P('sd-tropical-pluck', 'Tropical Pluck', 'arp', ['arp', 'chords', 'lead'], ['tropical-house', 'dancehall', 'afrobeats', 'pop'],
    { s: 'triangle', lpf: 1300, lpenv: 3, lpdecay: 0.12, attack: 0.001, decay: 0.3, sustain: 0, release: 0.15, ...echo(0.25, 0.35), ...space(0.2), gain: 1.144 }, 'tropical-pluck'),
  P('sd-square-arp', 'Square Arp', 'arp', ['arp'], ['synthwave', 'electro', 'italo-disco', 'video-game'],
    { s: 'square', lpf: 1800, resonance: 4, lpenv: 2, lpdecay: 0.1, attack: 0.001, decay: 0.15, sustain: 0.1, release: 0.08, ...echo(0.25, 0.4), gain: 0.824 }, 'arp-square'),
  P('sd-glass-arp', 'Glass Arp', 'arp', ['arp'], ['ambient', 'chillwave', 'idm', 'future-garage'],
    { s: 'sine', fm: 2.5, fmh: 3.5, fmdecay: 0.4, fmsustain: 0, attack: 0.001, decay: 0.8, sustain: 0, release: 0.4, ...echo(0.3, 0.45), ...space(0.3, 4), gain: 0.624 }, 'arp-fm-glass'),
  P('sd-downlifter', 'Downlifter', 'fx', ['fx'], ['edm', 'house', 'trance', 'dubstep'],
    { s: 'white', lpf: 6000, lpenv: -4, lpattack: 0.01, lpdecay: 2.5, lpsustain: 0, attack: 0.005, decay: 2.5, sustain: 0, release: 0.4, ...space(0.5, 6), gain: 0.15 }, 'downlifter'),
  P('sd-impact', 'Impact Boom', 'fx', ['fx'], ['cinematic', 'trailer', 'edm', 'trap'],
    { s: 'sine', penv: 24, pattack: 0.001, pdecay: 0.35, attack: 0.001, decay: 2.5, sustain: 0, release: 1, shape: 0.3, ...space(0.6, 8), gain: 0.237 }, 'impact-boom'),
  P('sd-siren', 'Dub Siren', 'fx', ['fx'], ['dub', 'reggae', 'dancehall', 'jungle'],
    { s: 'square', lpf: 2500, vib: 3, vibmod: 2, attack: 0.01, decay: 0.5, sustain: 1, release: 0.6, ...echo(0.4, 0.6), ...space(0.3), gain: 0.156 }, 'siren'),
];
