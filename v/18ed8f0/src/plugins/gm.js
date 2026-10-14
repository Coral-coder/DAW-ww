// General MIDI instrument names (midi-js-soundfonts ids) + soundfont library metadata.
// Pure data — Node-safe.

/** The 128 GM melodic instruments, program order (index = program number 0..127). */
export const GM_INSTRUMENTS = [
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honkytonk_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone', 'tubular_bells', 'dulcimer',
  'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz', 'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'guitar_harmonics',
  'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass', 'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
  'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani',
  'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2', 'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit',
  'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2',
  'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet',
  'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi', 'whistle', 'ocarina',
  'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff', 'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass__lead',
  'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir', 'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep',
  'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere', 'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi',
  'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai',
  'tinkle_bell', 'agogo', 'steel_drums', 'woodblock', 'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal',
  'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause', 'gunshot',
];

/** The 16 GM families (8 programs each). */
export const GM_FAMILIES = [
  'Piano', 'Chromatic Percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'Ethnic', 'Percussive', 'Sound Effects',
];

const SPECIAL_LABELS = { honkytonk_piano: 'Honky-tonk Piano', lead_8_bass__lead: 'Lead 8 (Bass + Lead)', fx_1_rain: 'FX 1 (Rain)' };

/** 'electric_piano_1' -> 'Electric Piano 1', 'lead_2_sawtooth' -> 'Lead 2 (Sawtooth)'. */
export function gmLabel(id) {
  if (SPECIAL_LABELS[id]) return SPECIAL_LABELS[id];
  const words = String(id || '').split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  const m = /^(Lead|Pad|Fx) (\d) (.+)$/.exec(words.join(' '));
  if (m) return `${m[1] === 'Fx' ? 'FX' : m[1]} ${m[2]} (${m[3]})`;
  return words.join(' ');
}

/** Family name for a GM id (or program number). */
export function gmFamily(idOrProgram) {
  const i = typeof idOrProgram === 'number' ? idOrProgram : GM_INSTRUMENTS.indexOf(idOrProgram);
  return i >= 0 ? GM_FAMILIES[Math.floor(i / 8)] : null;
}

/** Open-source sample libraries in the midi-js-soundfonts format (gleitz/midi-js-soundfonts, gh-pages). */
export const SOUNDFONT_LIBRARIES = {
  FluidR3_GM: { name: 'FluidR3 GM', license: 'CC-BY 3.0', author: 'Frank Wen (FluidR3) / gleitz', description: 'Clean, light General-MIDI set (≈2 MB per instrument).' },
  MusyngKite: { name: 'Musyng Kite', license: 'CC-BY-SA 3.0', author: 'Musyng Kite / gleitz', description: 'Larger, richer multisamples (bigger downloads).' },
  FatBoy: { name: 'FatBoy', license: 'CC-BY-SA 3.0', author: 'FatBoy / gleitz', description: 'Warm, characterful GM set.' },
};

export const SOUNDFONT_REPO = { owner: 'gleitz', repo: 'midi-js-soundfonts', ref: 'gh-pages' };

/** jsDelivr URL of a midi-js-soundfonts instrument file. */
export function soundfontUrl(library = 'FluidR3_GM', instrument = 'acoustic_grand_piano', format = 'mp3') {
  const lib = SOUNDFONT_LIBRARIES[library] ? library : 'FluidR3_GM';
  const fmt = format === 'ogg' ? 'ogg' : 'mp3';
  const { owner, repo, ref } = SOUNDFONT_REPO;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${lib}/${instrument}-${fmt}.js`;
}
