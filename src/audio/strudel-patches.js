// Curated Strudel patches (pure data, Node-safe): superdough "patches" — the sound + controls a strudel.cc tune
// writes after .s() — played by the 'strudel' instrument type (src/audio/strudel-voice.js) through Strudel's own
// audio engine (superdough). Modeled on the strudel.cc example tunes / a live coder–style sound design:
// subtractive synths with filter envelopes, supersaws, FM keys, the Salamander piano ('piano'), VCSL samples
// (vibraphone, marimba, kalimba, harp…) and the General MIDI soundfonts (gm_*).
//
// Patch keys use Strudel's method names (lpf, hpf, size, fm …); strudelValue() turns them into superdough's
// control names. Each patch: { id, name, role, roles, genres, patch, fallbackPreset } — fallbackPreset is the
// built-in daW³ preset that plays when superdough (or the patch's samples) can't load.
// Gains are loudness-matched to the fallback preset on a standard role phrase (offline renders; see
// docs/SOUND.md "Strudel patches") so mix.js level tables carry over.

/** Strudel sound names offered by the patch editor (superdough synths, noise, ZZFX, sample maps, GM soundfonts). */
export const STRUDEL_SYNTHS = ['sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'pulse', 'white', 'pink', 'brown', 'crackle',
  'zzfx', 'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'z_noise'];
export const STRUDEL_SAMPLE_SOUNDS = ['piano', 'steinway', 'kawai', 'fmpiano', 'clavisynth', 'vibraphone', 'vibraphone_soft', 'marimba', 'kalimba',
  'glockenspiel', 'xylophone_medium_ff', 'harp', 'folkharp', 'psaltery_pluck', 'balafon', 'tubularbells', 'handbells', 'organ_8inch',
  'organ_full', 'pipeorgan_quiet', 'sax', 'saxello', 'recorder_alto_sus', 'recorder_tenor_vib', 'ocarina', 'harmonica', 'super64', 'didgeridoo'];
export const STRUDEL_GM_SOUNDS = ['gm_piano', 'gm_epiano1', 'gm_epiano2', 'gm_harpsichord', 'gm_clavinet', 'gm_celesta', 'gm_glockenspiel',
  'gm_music_box', 'gm_vibraphone', 'gm_marimba', 'gm_xylophone', 'gm_tubular_bells', 'gm_dulcimer', 'gm_drawbar_organ', 'gm_percussive_organ',
  'gm_rock_organ', 'gm_church_organ', 'gm_reed_organ', 'gm_accordion', 'gm_harmonica', 'gm_bandoneon', 'gm_acoustic_guitar_nylon',
  'gm_acoustic_guitar_steel', 'gm_electric_guitar_jazz', 'gm_electric_guitar_clean', 'gm_electric_guitar_muted', 'gm_overdriven_guitar',
  'gm_distortion_guitar', 'gm_guitar_harmonics', 'gm_acoustic_bass', 'gm_electric_bass_finger', 'gm_electric_bass_pick', 'gm_fretless_bass',
  'gm_slap_bass_1', 'gm_slap_bass_2', 'gm_synth_bass_1', 'gm_synth_bass_2', 'gm_violin', 'gm_viola', 'gm_cello', 'gm_contrabass',
  'gm_tremolo_strings', 'gm_pizzicato_strings', 'gm_orchestral_harp', 'gm_timpani', 'gm_string_ensemble_1', 'gm_string_ensemble_2',
  'gm_synth_strings_1', 'gm_synth_strings_2', 'gm_choir_aahs', 'gm_voice_oohs', 'gm_synth_choir', 'gm_orchestra_hit', 'gm_trumpet',
  'gm_trombone', 'gm_tuba', 'gm_muted_trumpet', 'gm_french_horn', 'gm_brass_section', 'gm_synth_brass_1', 'gm_synth_brass_2',
  'gm_soprano_sax', 'gm_alto_sax', 'gm_tenor_sax', 'gm_baritone_sax', 'gm_oboe', 'gm_english_horn', 'gm_bassoon', 'gm_clarinet',
  'gm_piccolo', 'gm_flute', 'gm_recorder', 'gm_pan_flute', 'gm_blown_bottle', 'gm_shakuhachi', 'gm_whistle', 'gm_ocarina',
  'gm_lead_1_square', 'gm_lead_2_sawtooth', 'gm_lead_3_calliope', 'gm_lead_4_chiff', 'gm_lead_5_charang', 'gm_lead_6_voice',
  'gm_lead_7_fifths', 'gm_lead_8_bass_lead', 'gm_pad_new_age', 'gm_pad_warm', 'gm_pad_poly', 'gm_pad_choir', 'gm_pad_bowed',
  'gm_pad_metallic', 'gm_pad_halo', 'gm_pad_sweep', 'gm_fx_rain', 'gm_fx_soundtrack', 'gm_fx_crystal', 'gm_fx_atmosphere',
  'gm_fx_brightness', 'gm_fx_goblins', 'gm_fx_echoes', 'gm_fx_sci_fi', 'gm_sitar', 'gm_banjo', 'gm_shamisen', 'gm_koto', 'gm_kalimba',
  'gm_bagpipe', 'gm_fiddle', 'gm_shanai', 'gm_tinkle_bell', 'gm_agogo', 'gm_steel_drums', 'gm_woodblock', 'gm_taiko_drum',
  'gm_melodic_tom', 'gm_synth_drum', 'gm_reverse_cymbal'];
export const STRUDEL_SOUNDS = [...STRUDEL_SYNTHS, ...STRUDEL_SAMPLE_SOUNDS, ...STRUDEL_GM_SOUNDS];
/** Sounds rendered by superdough's AudioWorklets (substituted when a context can't load them). */
export const WORKLET_SOUNDS = new Set(['supersaw', 'pulse']);
/** Controls that need superdough's AudioWorklets (dropped when a context can't load them). */
export const WORKLET_CONTROLS = ['shape', 'crush', 'coarse', 'distort'];

const P = (id, name, role, roles, genres, patch, fallbackPreset) => ({ id, name, role, roles, genres, patch, fallbackPreset });
const space = (room, size = 3) => ({ room, size });
const echo = (delay, delayfeedback = 0.4, delaytime) => ({ delay, delayfeedback, ...(delaytime ? { delaytime } : {}) });

export const STRUDEL_PATCHES = [
  /* ------------------------------ BASS ------------------------------ */
  P('sd-sub-bass', 'Sub Bass', 'bass', ['bass'], ['house', 'deep-house', 'trap', 'dubstep', 'dnb', 'garage', 'hiphop', 'edm'],
    { s: 'sine', attack: 0.005, decay: 0.3, sustain: 0.9, release: 0.1, lpf: 400, gain: 0.95 }, 'sub-bass'),
  P('sd-808', '808 Bass', 'bass', ['bass'], ['trap', 'drill', 'hiphop', 'phonk', 'reggaeton', 'rnb'],
    { s: 'sine', penv: 7, pattack: 0.001, pdecay: 0.07, attack: 0.002, decay: 1.4, sustain: 0.35, release: 0.3, shape: 0.25, gain: 0.95 }, '808-bass'),
  P('sd-acid-bass', 'Acid Bass (303)', 'bass', ['bass'], ['acid', 'techno', 'house', 'trance', 'breaks'],
    { s: 'sawtooth', lpf: 380, resonance: 14, lpenv: 4, lpdecay: 0.18, attack: 0.002, decay: 0.25, sustain: 0.75, release: 0.05, shape: 0.3, gain: 0.7 }, 'acid-bass'),
  P('sd-reese-bass', 'Reese Bass', 'bass', ['bass'], ['dnb', 'jungle', 'dubstep', 'garage', 'techno'],
    { s: 'supersaw', unison: 4, detune: 0.35, spread: 0.3, lpf: 650, resonance: 3, lpenv: 1.5, lpdecay: 0.4, lpsustain: 0.4, attack: 0.01, decay: 0.4, sustain: 1, release: 0.15, gain: 0.7 }, 'reese-bass'),
  P('sd-saw-bass', 'Saw Bass', 'bass', ['bass'], ['house', 'deep-house', 'synthwave', 'nu-disco', 'techno', 'electro'],
    { s: 'sawtooth', lpf: 700, resonance: 4, lpenv: 2.5, lpdecay: 0.2, lpsustain: 0.2, attack: 0.003, decay: 0.3, sustain: 0.7, release: 0.08, gain: 0.7 }, 'saw-bass'),
  P('sd-pluck-bass', 'Pluck Bass', 'bass', ['bass'], ['house', 'tech-house', 'future-bass', 'pop'],
    { s: 'sawtooth', lpf: 280, resonance: 6, lpenv: 3.5, lpdecay: 0.12, attack: 0.002, decay: 0.28, sustain: 0.35, release: 0.08, gain: 0.8 }, 'pluck-bass'),
  P('sd-moog-bass', 'Moog-ish Bass', 'bass', ['bass'], ['funk', 'disco', 'synthwave', 'electro', 'nu-disco'],
    { s: 'sawtooth', lpf: 500, resonance: 8, lpenv: 3, lpdecay: 0.3, lpsustain: 0.25, attack: 0.002, decay: 0.4, sustain: 0.8, release: 0.08, gain: 0.7 }, 'moog-bass'),
  P('sd-fm-bass', 'FM Bass', 'bass', ['bass'], ['deep-house', 'funk', 'synthwave', 'future-bass', 'pop'],
    { s: 'sine', fm: 2.5, fmh: 1, fmattack: 0.001, fmdecay: 0.25, fmsustain: 0.15, attack: 0.002, decay: 0.4, sustain: 0.7, release: 0.1, gain: 0.8 }, 'fm-bass'),
  P('sd-dub-bass', 'Dub Bass', 'bass', ['bass'], ['dub', 'reggae', 'trip-hop', 'dubstep'],
    { s: 'triangle', lpf: 500, attack: 0.005, decay: 0.4, sustain: 0.8, release: 0.12, gain: 0.95 }, 'dub-bass'),
  P('sd-square-bass', 'Chip Bass', 'bass', ['bass'], ['chiptune', 'eurobeat'],
    { s: 'square', lpf: 1800, attack: 0.002, decay: 0.15, sustain: 0.7, release: 0.04, gain: 0.55 }, 'chip-bass'),
  P('sd-acoustic-bass', 'Acoustic Bass (GM)', 'bass', ['bass'], ['jazz', 'bossa-nova', 'folk', 'lofi-hip-hop', 'boom-bap', 'salsa'],
    { s: 'gm_acoustic_bass', release: 0.15, gain: 0.9 }, 'upright-bass'),
  P('sd-finger-bass', 'Finger Bass (GM)', 'bass', ['bass'], ['soul', 'neo-soul', 'funk', 'disco', 'gospel', 'reggae', 'indie', 'country'],
    { s: 'gm_electric_bass_finger', release: 0.1, gain: 0.85 }, 'finger-bass'),

  /* ------------------------------ LEAD ------------------------------ */
  P('sd-supersaw-lead', 'Supersaw Lead', 'lead', ['lead'], ['trance', 'progressive-house', 'edm', 'future-bass', 'hardstyle', 'eurobeat'],
    { s: 'supersaw', unison: 7, detune: 0.22, spread: 0.7, lpf: 5000, lpenv: 1, lpdecay: 0.3, lpsustain: 0.6, attack: 0.008, decay: 0.2, sustain: 0.8, release: 0.25, ...echo(0.25, 0.4), ...space(0.25, 4), gain: 0.55 }, 'supersaw-lead'),
  P('sd-square-lead', 'Square Lead', 'lead', ['lead'], ['synthwave', 'chiptune', 'pop', 'electro', 'nu-disco'],
    { s: 'square', lpf: 2600, lpenv: 1.5, lpdecay: 0.2, lpsustain: 0.5, attack: 0.004, decay: 0.15, sustain: 0.75, release: 0.15, vib: 5, vibmod: 0.12, ...echo(0.2, 0.35), gain: 0.5 }, 'square-lead'),
  P('sd-saw-lead', 'Saw Lead', 'lead', ['lead'], ['electro', 'house', 'techno', 'synthwave', 'dnb'],
    { s: 'sawtooth', lpf: 3200, resonance: 3, lpenv: 1.5, lpdecay: 0.25, lpsustain: 0.5, attack: 0.004, decay: 0.2, sustain: 0.8, release: 0.15, vib: 5.5, vibmod: 0.08, ...echo(0.2, 0.35), gain: 0.5 }, 'saw-lead'),
  P('sd-vowel-lead', 'Vowel Lead', 'lead', ['lead'], ['house', 'techno', 'acid', 'breaks', 'experimental'],
    { s: 'sawtooth', vowel: 'a', lpf: 3500, attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.2, ...echo(0.25, 0.4), ...space(0.2), gain: 0.65 }, 'saw-lead'),
  P('sd-acid-lead', 'Acid Lead', 'lead', ['lead'], ['acid', 'techno', 'trance', 'breaks'],
    { s: 'sawtooth', lpf: 700, resonance: 16, lpenv: 3.5, lpdecay: 0.15, lpsustain: 0.1, attack: 0.002, decay: 0.2, sustain: 0.7, release: 0.06, shape: 0.25, ...echo(0.25, 0.45), gain: 0.55 }, 'acid-lead'),
  P('sd-fm-bell', 'FM Bell', 'lead', ['lead', 'chords', 'arp'], ['ambient', 'chillwave', 'future-bass', 'phonk', 'pop', 'trap'],
    { s: 'sine', fm: 3, fmh: 3.5, fmdecay: 0.6, fmsustain: 0, attack: 0.001, decay: 1.4, sustain: 0, release: 0.8, ...space(0.3, 4), gain: 0.6 }, 'fm-bell-lead'),
  P('sd-chip-lead', 'Chip Lead', 'lead', ['lead', 'arp'], ['chiptune', 'eurobeat', 'synthwave'],
    { s: 'square', attack: 0.002, decay: 0.1, sustain: 0.5, release: 0.05, vib: 6, vibmod: 0.15, ...echo(0.15, 0.3), gain: 0.4 }, 'chip-lead'),
  P('sd-flute', 'Flute (GM)', 'lead', ['lead'], ['folk', 'bossa-nova', 'downtempo', 'latin', 'cinematic'],
    { s: 'gm_flute', attack: 0.03, release: 0.25, ...space(0.25), gain: 0.85 }, 'flute'),
  P('sd-sax', 'Sax (VCSL)', 'lead', ['lead'], ['jazz', 'soul', 'gospel', 'funk', 'lofi-hip-hop'],
    { s: 'sax', attack: 0.01, release: 0.2, ...space(0.2), gain: 0.85 }, 'brass-lead'),
  P('sd-gm-saw-lead', 'GM Saw Lead', 'lead', ['lead'], ['eurobeat', 'synthwave', 'electro'],
    { s: 'gm_lead_2_sawtooth', release: 0.15, ...echo(0.2, 0.35), gain: 0.75 }, 'saw-lead'),

  /* ------------------------------ KEYS ------------------------------ */
  P('sd-piano', 'Piano (Salamander)', 'chords', ['chords', 'lead'], ['pop', 'jazz', 'gospel', 'salsa', 'cinematic', 'ballad', 'rnb', 'house'],
    { s: 'piano', release: 0.6, ...space(0.15, 2), gain: 0.9 }, 'grand-piano'),
  P('sd-rhodes', 'Rhodes (GM EP1)', 'chords', ['chords', 'lead'], ['deep-house', 'neo-soul', 'rnb', 'soul', 'lofi-hip-hop', 'liquid-dnb', 'boom-bap', 'trip-hop', 'downtempo', 'amapiano'],
    { s: 'gm_epiano1', release: 0.5, ...space(0.2, 2), gain: 0.85 }, 'electric-piano'),
  P('sd-fm-epiano', 'FM E-Piano', 'chords', ['chords', 'lead'], ['city-pop', 'pop', '80s', 'funk', 'synthwave', 'deep-house'],
    { s: 'sine', fm: 1.4, fmh: 1, fmdecay: 0.5, fmsustain: 0.05, attack: 0.002, decay: 1.6, sustain: 0.12, release: 0.4, vib: 4.5, vibmod: 0.04, ...space(0.2, 2), gain: 0.7 }, 'fm-epiano'),
  P('sd-lofi-keys', 'Lofi Keys', 'chords', ['chords'], ['lofi-hip-hop', 'chillwave', 'boom-bap', 'trip-hop'],
    { s: 'gm_epiano1', lpf: 1800, vib: 3.5, vibmod: 0.06, release: 0.5, ...space(0.25, 2), gain: 0.9 }, 'lofi-keys'),
  P('sd-vibraphone', 'Vibraphone (VCSL)', 'lead', ['lead', 'chords'], ['jazz', 'lofi-hip-hop', 'boom-bap', 'trip-hop', 'bossa-nova'],
    { s: 'vibraphone', release: 0.9, ...space(0.25, 3), gain: 0.85 }, 'vibraphone'),
  P('sd-marimba', 'Marimba (VCSL)', 'lead', ['lead', 'arp'], ['afrobeat', 'amapiano', 'tropical-house', 'pop'],
    { s: 'marimba', release: 0.4, ...space(0.15), gain: 0.9 }, 'marimba'),
  P('sd-organ', 'Drawbar Organ (GM)', 'chords', ['chords', 'pad'], ['gospel', 'soul', 'funk', 'reggae', 'house', 'blues'],
    { s: 'gm_drawbar_organ', attack: 0.005, release: 0.12, ...space(0.15), gain: 0.65 }, 'organ-drawbar'),
  P('sd-rock-organ', 'Rock Organ (GM)', 'chords', ['chords', 'pad'], ['rock', 'blues', 'indie'],
    { s: 'gm_rock_organ', attack: 0.005, release: 0.12, ...space(0.15), gain: 0.6 }, 'organ-rock'),
  P('sd-clav', 'Clavinet (GM)', 'chords', ['chords'], ['funk', 'soul', 'disco'],
    { s: 'gm_clavinet', release: 0.1, gain: 0.75 }, 'clav'),
  P('sd-house-stab', 'House Stab', 'chords', ['chords'], ['house', 'deep-house', 'tech-house', 'garage', 'nu-disco'],
    { s: 'sawtooth', lpf: 1400, resonance: 3, lpenv: 2.5, lpdecay: 0.15, lpsustain: 0.1, attack: 0.002, decay: 0.25, sustain: 0.1, release: 0.12, ...echo(0.2, 0.3), ...space(0.2), gain: 0.5 }, 'house-stab'),
  P('sd-supersaw-chords', 'Supersaw Chords', 'chords', ['chords'], ['future-bass', 'edm', 'trance', 'progressive-house', 'kpop'],
    { s: 'supersaw', unison: 5, detune: 0.2, spread: 0.8, lpf: 3200, lpenv: 1.5, lpdecay: 0.25, lpsustain: 0.5, attack: 0.005, decay: 0.3, sustain: 0.7, release: 0.2, ...space(0.25, 3), gain: 0.45 }, 'future-chords'),

  /* ------------------------------ PADS ------------------------------ */
  P('sd-supersaw-pad', 'Supersaw Pad', 'pad', ['pad', 'chords'], ['trance', 'progressive-house', 'edm', 'synthwave', 'future-bass'],
    { s: 'supersaw', unison: 6, detune: 0.18, spread: 0.9, lpf: 2400, attack: 0.4, decay: 0.6, sustain: 0.8, release: 1.2, ...space(0.45, 6), gain: 0.4 }, 'supersaw-pad'),
  P('sd-warm-pad', 'Warm Pad', 'pad', ['pad', 'chords'], ['house', 'deep-house', 'chillwave', 'downtempo', 'synthwave', 'pop', 'rnb'],
    { s: 'supersaw', unison: 4, detune: 0.12, spread: 0.7, lpf: 1100, resonance: 1, attack: 0.5, decay: 0.8, sustain: 0.85, release: 1.5, vib: 4, vibmod: 0.04, ...space(0.5, 6), gain: 0.5 }, 'warm-pad'),
  P('sd-dark-pad', 'Dark Pad', 'pad', ['pad'], ['techno', 'dnb', 'dubstep', 'trap', 'drill', 'industrial', 'phonk'],
    { s: 'sawtooth', lpf: 520, resonance: 4, lpenv: 1, lpattack: 1.5, lpdecay: 1, lpsustain: 0.5, attack: 0.9, decay: 1, sustain: 0.85, release: 2, ...space(0.6, 8), gain: 0.6 }, 'dark-pad'),
  P('sd-glass-pad', 'Glass Pad', 'pad', ['pad', 'chords'], ['ambient', 'chillwave', 'future-garage', 'downtempo'],
    { s: 'triangle', fm: 0.6, fmh: 2, attack: 0.5, decay: 1, sustain: 0.7, release: 1.6, ...echo(0.2, 0.45), ...space(0.6, 7), gain: 0.65 }, 'glass-pad'),
  P('sd-ambient-pad', 'Ambient Pad', 'pad', ['pad'], ['ambient', 'cinematic', 'chillwave', 'liquid-dnb'],
    { s: 'supersaw', unison: 3, detune: 0.1, spread: 1, lpf: 1500, attack: 1.2, decay: 1, sustain: 0.9, release: 2.5, ...space(0.75, 9), gain: 0.5 }, 'ambient-pad'),
  P('sd-juno-strings', 'Poly Strings', 'pad', ['pad', 'chords'], ['synthwave', '80s', 'house', 'deep-house', 'pop'],
    { s: 'square', lpf: 2600, attack: 0.35, decay: 1, sustain: 0.9, release: 0.9, vib: 5, vibmod: 0.05, ...space(0.4, 5), gain: 0.45 }, 'juno-strings'),
  P('sd-strings', 'String Ensemble (GM)', 'pad', ['pad', 'chords'], ['cinematic', 'pop', 'disco', 'jazz', 'folk', 'drill', 'ballad'],
    { s: 'gm_string_ensemble_1', attack: 0.15, release: 0.8, ...space(0.35, 4), gain: 0.8 }, 'strings'),
  P('sd-synth-strings', 'Synth Strings (GM)', 'pad', ['pad'], ['synthwave', 'pop', '80s', 'house'],
    { s: 'gm_synth_strings_1', attack: 0.2, release: 0.9, ...space(0.35, 4), gain: 0.75 }, 'string-pad'),
  P('sd-choir', 'Choir (GM)', 'pad', ['pad'], ['gospel', 'cinematic', 'metal', 'trance', 'ambient'],
    { s: 'gm_choir_aahs', attack: 0.2, release: 0.9, ...space(0.45, 5), gain: 0.8 }, 'choir-pad'),
  P('sd-halo-pad', 'Halo Pad (GM)', 'pad', ['pad'], ['ambient', 'chillwave', 'cinematic'],
    { s: 'gm_pad_halo', attack: 0.3, release: 1.4, ...space(0.5, 6), gain: 0.8 }, 'ambient-pad'),

  /* ------------------------------ PLUCKS / ARPS ------------------------------ */
  P('sd-tri-pluck', 'Triangle Pluck', 'arp', ['arp', 'chords'], ['house', 'deep-house', 'trance', 'future-bass', 'pop', 'edm', 'chillwave', 'tropical-house'],
    { s: 'triangle', lpf: 1600, lpenv: 3, lpdecay: 0.12, attack: 0.002, decay: 0.22, sustain: 0, release: 0.12, ...echo(0.35, 0.45), ...space(0.2), gain: 0.85 }, 'arp-pluck'),
  P('sd-saw-arp', 'Saw Arp', 'arp', ['arp'], ['trance', 'techno', 'synthwave', 'progressive-house', 'eurobeat'],
    { s: 'sawtooth', lpf: 900, resonance: 6, lpenv: 3.5, lpdecay: 0.14, attack: 0.002, decay: 0.18, sustain: 0.05, release: 0.1, ...echo(0.3, 0.45), gain: 0.55 }, 'arp-saw'),
  P('sd-kalimba', 'Kalimba (VCSL)', 'arp', ['arp', 'lead'], ['afrobeat', 'chillwave', 'tropical-house', 'lofi-hip-hop'],
    { s: 'kalimba', release: 0.5, ...echo(0.2, 0.35), ...space(0.2), gain: 0.9 }, 'kalimba'),
  P('sd-harp', 'Harp (VCSL)', 'arp', ['arp'], ['cinematic', 'folk', 'ambient'],
    { s: 'harp', release: 0.9, ...space(0.3, 4), gain: 0.9 }, 'harp'),
  P('sd-glock', 'Glockenspiel (VCSL)', 'arp', ['arp', 'lead'], ['indie', 'cinematic', 'pop'],
    { s: 'glockenspiel', release: 0.8, ...space(0.25, 3), gain: 0.7 }, 'celesta'),
  P('sd-pizzicato', 'Pizzicato (GM)', 'arp', ['arp'], ['cinematic', 'pop', 'folk'],
    { s: 'gm_pizzicato_strings', release: 0.3, ...space(0.25), gain: 0.85 }, 'pluck'),
  P('sd-steel-drum', 'Steel Drum (GM)', 'chords', ['chords', 'lead'], ['dancehall', 'caribbean', 'tropical-house'],
    { s: 'gm_steel_drums', release: 0.4, ...space(0.2), gain: 0.75 }, 'steel-drum'),

  /* ------------------------------ FX ------------------------------ */
  P('sd-noise-sweep', 'Noise Sweep', 'fx', ['fx'], ['house', 'techno', 'trance', 'edm', 'dnb', 'pop'],
    { s: 'white', lpf: 500, resonance: 4, lpenv: 4.5, lpattack: 2, lpdecay: 0.5, lpsustain: 1, attack: 1.5, decay: 0.5, sustain: 1, release: 1, ...space(0.5, 6), gain: 0.35 }, 'noise-sweep'),
  P('sd-riser', 'Pink Riser', 'fx', ['fx'], ['trance', 'edm', 'future-bass', 'progressive-house'],
    { s: 'pink', hpf: 300, lpf: 1200, lpenv: 3.5, lpattack: 3, lpsustain: 1, attack: 2, sustain: 1, release: 0.6, ...echo(0.3, 0.5), ...space(0.5, 6), gain: 0.4 }, 'riser'),
  P('sd-laser', 'Laser Zap', 'fx', ['fx'], ['dubstep', 'electro', 'techno', 'hardstyle'],
    { s: 'sawtooth', penv: 24, pattack: 0.001, pdecay: 0.18, lpf: 3000, attack: 0.001, decay: 0.25, sustain: 0, release: 0.1, ...echo(0.35, 0.5), gain: 0.4 }, 'laser'),
  P('sd-zzfx-zap', 'ZZFX Blip', 'fx', ['fx'], ['chiptune', 'experimental'],
    { s: 'z_square', attack: 0.001, decay: 0.15, sustain: 0, release: 0.05, ...echo(0.25, 0.4), gain: 0.4 }, 'laser'),
];

export const STRUDEL_PATCH_MAP = Object.fromEntries(STRUDEL_PATCHES.map((p) => [p.id, p]));
export const isStrudelPatch = (id) => Object.prototype.hasOwnProperty.call(STRUDEL_PATCH_MAP, id);

/** Patch key (Strudel method name) -> superdough control name. */
const CONTROL = { lpf: 'cutoff', hpf: 'hcutoff', size: 'roomsize', fm: 'fmi' };
/** A patch value that means "leave it to superdough" (not sent). */
function neutral(k, v, p) {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'number' && !Number.isFinite(v)) return true;
  switch (k) {
    case 's': return false;
    case 'lpf': return v >= 20000;
    case 'hpf': return v <= 20;
    case 'resonance': return !(p.lpf < 20000) || v === 1;
    case 'lpenv': return !(p.lpf < 20000) || v === 0;
    case 'lpattack': case 'lpdecay': case 'lpsustain': case 'lprelease': return !(p.lpf < 20000) || v < 0;
    case 'room': case 'delay': case 'shape': case 'crush': case 'coarse': case 'penv': case 'n': case 'vib': case 'fm': return !(v > 0) && !(k === 'penv' && v < 0);
    case 'size': return !(p.room > 0);
    case 'delaytime': return !(p.delay > 0) || v < 0;
    case 'delayfeedback': return !(p.delay > 0);
    case 'vibmod': return !(p.vib > 0);
    case 'fmh': case 'fmattack': case 'fmdecay': case 'fmsustain': case 'fmrelease': return !(p.fm > 0) || v < 0;
    case 'pattack': case 'pdecay': return !(p.penv) || v < 0;
    case 'pan': return v === 0.5;
    case 'vowel': return !v;
    default: return typeof v === 'number' && v < 0; // -1 = auto (attack/decay/sustain/release, unison, detune, spread …)
  }
}

/** Patch params -> superdough value (controls only; the caller adds note / velocity). */
export function strudelValue(params) {
  const p = params || {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'polyphony' || neutral(k, v, p)) continue;
    out[CONTROL[k] || k] = v;
  }
  if (!out.s) out.s = 'triangle';
  return out;
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const ORDER = ['s', 'n', 'bank', 'gain', 'attack', 'decay', 'sustain', 'release', 'lpf', 'resonance', 'lpenv', 'lpattack', 'lpdecay', 'lpsustain', 'lprelease', 'hpf',
  'unison', 'detune', 'spread', 'fm', 'fmh', 'fmattack', 'fmdecay', 'fmsustain', 'fmrelease', 'penv', 'pattack', 'pdecay', 'vib', 'vibmod', 'vowel', 'shape', 'crush', 'coarse', 'pan', 'delay', 'delaytime', 'delayfeedback', 'room', 'size'];
const METHOD = { resonance: 'lpq' };

/**
 * Patch params -> Strudel code: `.s("supersaw").lpf(1200).lpenv(3).room(.3)` (the same controls the DAW
 * instrument sends to superdough, so a code track plays the patch identically).
 */
export function strudelPatchCode(params, { gain = true } = {}) {
  const p = params || {};
  const keys = Object.keys(p).filter((k) => k !== 'polyphony' && !neutral(k, p[k], p) && (gain || k !== 'gain') && !(k === 'gain' && p[k] === 0.8));
  keys.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const fmt = (v) => (typeof v === 'number' ? String(r3(v)).replace(/^0\./, '.').replace(/^-0\./, '-.') : JSON.stringify(String(v)));
  let out = `.s(${JSON.stringify(String(p.s || 'triangle'))})`;
  const env = ['attack', 'decay', 'sustain', 'release'];
  const adsr = env.every((k) => keys.includes(k));
  for (const k of keys) {
    if (k === 's' || (adsr && env.includes(k) && k !== 'attack')) continue;
    if (adsr && k === 'attack') { out += `.adsr("${env.map((e) => fmt(p[e])).join(':')}")`; continue; }
    out += `.${METHOD[k] || k}(${fmt(p[k])})`;
  }
  return out;
}
