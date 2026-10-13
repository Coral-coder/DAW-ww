// Genre library: tempo, feel, harmony, sound palette, arrangement and production tips.
// Preset and drum-kit ids refer to src/audio/presets.js (owned by the audio module).
import { fitStructure } from './form.js';


export const DRUM_KIT_IDS = ['808', '909', 'trap', 'lofi', 'acoustic', 'rock', 'techno', 'house', 'breaks', 'dnb', 'jazz', 'latin', 'afro', 'reggaeton', 'chip', 'industrial', 'hardstyle', 'phonk', 'garage', 'cinematic'];

export const PRESET_IDS = {
  bass: ['sub-bass', '808-bass', 'reese-bass', 'acid-bass', 'pluck-bass', 'fm-bass', 'wobble-bass', 'moog-bass', 'finger-bass', 'saw-bass', 'dub-bass', 'upright-bass', 'chip-bass', 'synthwave-bass'],
  lead: ['supersaw-lead', 'square-lead', 'saw-lead', 'fm-bell-lead', 'chip-lead', 'acid-lead', 'sync-lead', 'whistle-lead', 'guitar-lead', 'brass-lead', 'flute', 'trance-lead', 'hoover'],
  keys: ['electric-piano', 'fm-epiano', 'grand-piano', 'organ-drawbar', 'organ-rock', 'clav', 'vibraphone', 'marimba', 'bell', 'celesta', 'harpsichord', 'music-box', 'lofi-keys'],
  pad: ['warm-pad', 'string-pad', 'choir-pad', 'ambient-pad', 'dark-pad', 'glass-pad', 'supersaw-pad', 'strings', 'brass-section', 'synthwave-pad', 'juno-strings', 'detuned-pad'],
  chords: ['pluck', 'house-stab', 'fm-brass', 'rave-stab', 'future-chords', 'guitar-clean', 'guitar-dist', 'power-chord', 'harp', 'koto', 'steel-drum', 'kalimba'],
  arp: ['arp-pluck', 'arp-saw'],
  fx: ['riser', 'noise-sweep', 'laser'],
};
export const ALL_PRESET_IDS = Object.values(PRESET_IDS).flat();

export const ROLES = ['drums', 'bass', 'chords', 'pad', 'lead', 'arp', 'fx'];

const S = (name, bars, energy, roles) => ({ name, bars, energy, roles });
const ALL = ROLES;

/**
 * Arrangement templates (bars are in the genre's time signature). Each genre's standard form is its template fitted to
 * the genre's realistic length (`minutes` at the default tempo, see form.js): club genres get DJ-friendly forms
 * (drums-only DJ intro, long breakdown with the melody exposed, two drops, DJ outro), songs get verse / pre / chorus /
 * bridge / final double chorus forms, jazz plays several solo choruses with changing comping.
 */
export const STRUCTURES = {
  // dubstep / brostep / future bass / glitch (~4–4.5 min)
  edm: [
    S('Intro', 16, 0.25, ['drums', 'pad', 'fx']), S('Build', 8, 0.6, ['drums', 'chords', 'pad', 'arp', 'fx']),
    S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'fx']), S('Verse', 16, 0.55, ['drums', 'bass', 'chords', 'pad']),
    S('Breakdown', 16, 0.3, ['pad', 'chords', 'lead']), S('Build', 8, 0.7, ['drums', 'chords', 'arp', 'fx', 'pad']),
    S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'arp', 'fx']), S('Outro', 16, 0.2, ['drums', 'pad']),
  ],
  // house / deep / tech house (~6.5–7 min): 32-bar DJ intro, grooves, breakdown, two drops, 32-bar DJ outro
  house: [
    S('Intro', 16, 0.3, ['drums']), S('Intro', 16, 0.4, ['drums', 'bass', 'fx']),
    S('Groove', 16, 0.6, ['drums', 'bass', 'chords']), S('Groove', 16, 0.65, ['drums', 'bass', 'chords', 'arp']),
    S('Breakdown', 16, 0.3, ['pad', 'chords', 'lead', 'fx']), S('Build', 8, 0.65, ['drums', 'chords', 'arp', 'fx']),
    S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'arp', 'pad']), S('Groove', 16, 0.7, ['drums', 'bass', 'chords', 'pad']),
    S('Breakdown', 8, 0.35, ['pad', 'chords', 'lead']), S('Build', 8, 0.7, ['drums', 'chords', 'arp', 'fx']),
    S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'arp', 'pad', 'fx']),
    S('Outro', 16, 0.4, ['drums', 'bass', 'chords']), S('Outro', 16, 0.3, ['drums']),
  ],
  // techno (~6.5 min): hypnotic, layers come and go
  techno: [
    S('Intro', 16, 0.3, ['drums']), S('Intro', 16, 0.4, ['drums', 'bass']),
    S('Groove', 16, 0.6, ['drums', 'bass', 'arp']), S('Peak', 32, 1, ['drums', 'bass', 'arp', 'lead', 'chords']),
    S('Break', 16, 0.3, ['pad', 'fx', 'arp']), S('Build', 8, 0.65, ['drums', 'arp', 'fx']),
    S('Peak', 32, 1, ['drums', 'bass', 'arp', 'lead', 'chords', 'fx']), S('Groove', 16, 0.7, ['drums', 'bass', 'arp', 'chords']),
    S('Peak', 32, 1, ['drums', 'bass', 'arp', 'lead', 'pad']),
    S('Outro', 16, 0.4, ['drums', 'bass']), S('Outro', 16, 0.3, ['drums']),
  ],
  // trance (~7.5 min): drums-only DJ intro, percussion build, long breakdown with the melody exposed, big build, two drops
  trance: [
    S('Intro', 16, 0.3, ['drums']), S('Intro', 16, 0.4, ['drums', 'bass', 'fx']),
    S('Groove', 16, 0.55, ['drums', 'bass', 'arp']), S('Groove', 16, 0.65, ['drums', 'bass', 'arp', 'pad', 'fx']),
    S('Breakdown', 32, 0.3, ['pad', 'chords', 'lead']), S('Build', 16, 0.75, ['drums', 'arp', 'fx', 'chords', 'pad']),
    S('Drop', 32, 1, ['drums', 'bass', 'lead', 'arp', 'pad', 'chords']), S('Groove', 16, 0.7, ['drums', 'bass', 'arp', 'pad']),
    S('Breakdown', 16, 0.35, ['pad', 'lead', 'arp']), S('Build', 16, 0.8, ['drums', 'arp', 'fx', 'chords']),
    S('Drop', 32, 1, ['drums', 'bass', 'lead', 'arp', 'pad', 'chords', 'fx']),
    S('Outro', 16, 0.45, ['drums', 'bass', 'arp']), S('Outro', 16, 0.3, ['drums']),
  ],
  // psytrance (~7.5 min): rolling bass all the way, short breaks, three peaks
  psytrance: [
    S('Intro', 16, 0.3, ['drums']), S('Intro', 16, 0.45, ['drums', 'bass', 'fx']),
    S('Groove', 32, 0.65, ['drums', 'bass', 'arp']), S('Build', 16, 0.75, ['drums', 'bass', 'arp', 'fx']),
    S('Peak', 32, 1, ['drums', 'bass', 'arp', 'lead', 'pad']), S('Break', 16, 0.35, ['pad', 'lead', 'fx', 'arp']),
    S('Build', 8, 0.8, ['drums', 'bass', 'arp', 'fx']), S('Peak', 32, 1, ['drums', 'bass', 'arp', 'lead', 'chords']),
    S('Groove', 16, 0.7, ['drums', 'bass', 'arp', 'chords']), S('Break', 16, 0.4, ['pad', 'chords', 'lead']),
    S('Build', 8, 0.85, ['drums', 'bass', 'arp', 'fx']), S('Peak', 32, 1, ['drums', 'bass', 'arp', 'lead', 'pad', 'fx']),
    S('Outro', 16, 0.45, ['drums', 'bass']), S('Outro', 16, 0.3, ['drums']),
  ],
  // progressive house (~7 min)
  progressive: [
    S('Intro', 16, 0.3, ['drums']), S('Intro', 16, 0.4, ['drums', 'bass', 'fx']),
    S('Groove', 16, 0.55, ['drums', 'bass', 'arp']), S('Groove', 16, 0.65, ['drums', 'bass', 'arp', 'chords']),
    S('Breakdown', 32, 0.3, ['pad', 'chords', 'lead']), S('Build', 16, 0.75, ['drums', 'chords', 'arp', 'fx', 'pad']),
    S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'arp']), S('Breakdown', 16, 0.35, ['pad', 'chords', 'lead']),
    S('Build', 8, 0.75, ['drums', 'chords', 'arp', 'fx']), S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'arp', 'pad']),
    S('Outro', 16, 0.4, ['drums', 'bass', 'arp']), S('Outro', 16, 0.3, ['drums']),
  ],
  // drum & bass (~5 min): 32-bar DJ intro, two drops, a switch-up, DJ outro
  dnb: [
    S('Intro', 16, 0.3, ['drums', 'pad']), S('Intro', 16, 0.45, ['drums', 'pad', 'fx', 'arp']),
    S('Build', 8, 0.6, ['drums', 'pad', 'fx', 'arp']), S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead']),
    S('Switch', 16, 0.75, ['drums', 'bass', 'chords', 'arp']), S('Breakdown', 16, 0.3, ['pad', 'chords', 'lead']),
    S('Build', 16, 0.7, ['drums', 'chords', 'fx', 'arp']), S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'arp']),
    S('Groove', 32, 0.75, ['drums', 'bass', 'chords', 'pad']),
    S('Outro', 16, 0.4, ['drums', 'bass']), S('Outro', 16, 0.3, ['drums', 'pad']),
  ],
  // UK garage / 2-step / breakbeat (~5 min): club vocal-song shape
  garage: [
    S('Intro', 16, 0.3, ['drums']), S('Intro', 8, 0.45, ['drums', 'bass', 'fx']),
    S('Verse', 16, 0.6, ['drums', 'bass', 'chords']), S('Build', 8, 0.7, ['drums', 'bass', 'chords', 'pad', 'fx']),
    S('Drop', 16, 1, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Verse', 16, 0.65, ['drums', 'bass', 'chords', 'arp']),
    S('Breakdown', 8, 0.35, ['pad', 'chords', 'lead']), S('Build', 8, 0.75, ['drums', 'chords', 'arp', 'fx']),
    S('Drop', 32, 1, ['drums', 'bass', 'chords', 'lead', 'pad', 'arp']),
    S('Outro', 16, 0.4, ['drums', 'bass']), S('Outro', 8, 0.3, ['drums']),
  ],
  // pop / k-pop (~3.5 min): intro, verse, pre, chorus, verse 2, pre, chorus, bridge, final double chorus, outro
  pop: [
    S('Intro', 8, 0.3, ['chords', 'pad']), S('Verse', 16, 0.5, ['drums', 'bass', 'chords', 'lead']),
    S('Pre-Chorus', 8, 0.65, ['drums', 'bass', 'chords', 'pad', 'arp']), S('Chorus', 8, 0.95, ALL),
    S('Verse', 16, 0.55, ['drums', 'bass', 'chords', 'lead']), S('Pre-Chorus', 8, 0.7, ['drums', 'bass', 'chords', 'pad', 'arp', 'fx']),
    S('Chorus', 8, 1, ALL), S('Bridge', 8, 0.45, ['pad', 'chords', 'lead']), S('Chorus', 16, 1, ALL),
    S('Outro', 8, 0.3, ['chords', 'pad']),
  ],
  // trap / drill / phonk (~3 min at 140): intro, hook, 16-bar verses with hooks between
  hiphop: [
    S('Intro', 4, 0.3, ['chords', 'pad']), S('Hook', 16, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Verse', 16, 0.7, ['drums', 'bass', 'chords']), S('Hook', 16, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Verse', 16, 0.7, ['drums', 'bass', 'chords', 'arp']), S('Bridge', 8, 0.5, ['chords', 'pad', 'lead']),
    S('Hook', 16, 0.95, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Outro', 8, 0.3, ['chords', 'pad']),
  ],
  // boom bap (~3.5 min at 90): three verses, hooks between
  boombap: [
    S('Intro', 4, 0.3, ['chords', 'pad']), S('Hook', 8, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Verse', 16, 0.7, ['drums', 'bass', 'chords']), S('Hook', 8, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Verse', 16, 0.7, ['drums', 'bass', 'chords', 'arp']), S('Hook', 8, 0.95, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Verse', 16, 0.75, ['drums', 'bass', 'chords', 'pad']), S('Hook', 8, 0.95, ['drums', 'bass', 'chords', 'lead', 'pad', 'arp']),
    S('Outro', 4, 0.3, ['chords']),
  ],
  rock: [
    S('Intro', 8, 0.5, ['drums', 'chords']), S('Verse', 16, 0.6, ['drums', 'bass', 'chords']),
    S('Chorus', 8, 0.95, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Verse', 16, 0.65, ['drums', 'bass', 'chords']),
    S('Chorus', 8, 1, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Solo', 16, 0.9, ['drums', 'bass', 'chords', 'lead']),
    S('Bridge', 8, 0.55, ['drums', 'bass', 'chords', 'pad']),
    S('Chorus', 16, 1, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Outro', 8, 0.5, ['drums', 'chords']),
  ],
  // ambient (~6.5 min): slow arc, layers bloom and drift
  ambient: [
    S('Intro', 16, 0.15, ['pad']), S('Rise', 16, 0.35, ['pad', 'chords', 'arp']),
    S('Bloom', 16, 0.5, ['pad', 'chords', 'lead', 'arp', 'bass', 'drums']), S('Drift', 16, 0.4, ['pad', 'lead', 'arp']),
    S('Bloom', 16, 0.55, ['pad', 'chords', 'lead', 'bass', 'drums']), S('Fade', 16, 0.3, ['pad', 'lead']),
    S('Outro', 16, 0.1, ['pad']),
  ],
  // lo-fi / downtempo: loop-based A/B variations
  chill: [
    S('Intro', 4, 0.3, ['chords']), S('A', 8, 0.6, ['drums', 'bass', 'chords']),
    S('B', 8, 0.75, ['drums', 'bass', 'chords', 'lead', 'pad']), S('A', 8, 0.65, ['drums', 'bass', 'chords', 'arp']),
    S('B', 8, 0.8, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Break', 4, 0.35, ['chords', 'pad']),
    S('A', 8, 0.65, ['drums', 'bass', 'chords', 'pad']), S('B', 8, 0.85, ['drums', 'bass', 'chords', 'lead', 'pad', 'arp']),
    S('Outro', 4, 0.3, ['chords']),
  ],
  // jazz (~5 min): head, several solo choruses (comping changes, the piano lays out), trading 4s, head out
  jazz: [
    S('Intro', 4, 0.35, ['chords', 'bass']), S('Head', 32, 0.6, ['drums', 'bass', 'chords', 'lead']),
    S('Solo', 32, 0.8, ['drums', 'bass', 'chords', 'lead']), S('Solo', 32, 0.85, ['drums', 'bass', 'chords', 'lead']),
    S('Solo', 32, 0.85, ['drums', 'bass', 'lead']), S('Trading 4s', 16, 0.8, ['drums', 'bass', 'chords', 'lead']),
    S('Head', 32, 0.65, ['drums', 'bass', 'chords', 'lead']), S('Outro', 4, 0.35, ['chords', 'bass', 'drums']),
  ],
  blues: [
    S('Intro', 4, 0.4, ['drums', 'bass', 'chords']), S('Verse', 12, 0.6, ['drums', 'bass', 'chords']),
    S('Verse', 12, 0.7, ['drums', 'bass', 'chords', 'lead']), S('Solo', 12, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Verse', 12, 0.7, ['drums', 'bass', 'chords', 'lead']), S('Solo', 12, 0.9, ['drums', 'bass', 'chords', 'lead']),
    S('Verse', 12, 0.75, ['drums', 'bass', 'chords', 'lead']), S('Outro', 4, 0.4, ['drums', 'bass', 'chords']),
  ],
  // cinematic (~3.5 min): a clear arc — theme, rise, climax, reflection, second rise, finale
  cinematic: [
    S('Intro', 8, 0.15, ['pad']), S('Theme', 8, 0.4, ['pad', 'chords', 'lead']),
    S('Rise', 8, 0.65, ['pad', 'chords', 'drums', 'arp', 'fx']), S('Climax', 16, 1, ALL),
    S('Reflection', 8, 0.3, ['pad', 'lead']), S('Rise', 8, 0.7, ['pad', 'chords', 'drums', 'arp', 'fx']),
    S('Finale', 16, 0.95, ALL), S('Outro', 8, 0.15, ['pad']),
  ],
  // funk / disco / reggae / latin (~3.5–4 min)
  groove: [
    S('Intro', 4, 0.4, ['drums', 'chords']), S('Verse', 16, 0.6, ['drums', 'bass', 'chords']),
    S('Chorus', 8, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Verse', 16, 0.65, ['drums', 'bass', 'chords', 'arp']),
    S('Chorus', 8, 0.95, ['drums', 'bass', 'chords', 'lead', 'pad']), S('Breakdown', 8, 0.4, ['drums', 'bass']),
    S('Chorus', 16, 1, ['drums', 'bass', 'chords', 'lead', 'pad', 'arp']), S('Outro', 8, 0.4, ['drums', 'chords']),
  ],
  // salsa: verses (son), then the montuno (coro / pregón) and a mambo section
  salsa: [
    S('Intro', 8, 0.5, ['drums', 'bass', 'chords']), S('Verse', 16, 0.6, ['drums', 'bass', 'chords', 'lead']),
    S('Verse', 16, 0.65, ['drums', 'bass', 'chords', 'lead']), S('Montuno', 32, 0.9, ['drums', 'bass', 'chords', 'lead', 'pad']),
    S('Mambo', 16, 1, ['drums', 'bass', 'chords', 'lead', 'arp']), S('Break', 8, 0.5, ['drums', 'bass']),
    S('Montuno', 32, 0.95, ['drums', 'bass', 'chords', 'lead', 'pad', 'arp']), S('Outro', 8, 0.5, ['drums', 'bass', 'chords']),
  ],
  // hardstyle (~5 min)
  hard: [
    S('Intro', 16, 0.45, ['drums', 'bass']), S('Intro', 16, 0.55, ['drums', 'bass', 'fx']),
    S('Breakdown', 32, 0.3, ['pad', 'lead', 'chords']), S('Build', 8, 0.7, ['drums', 'fx', 'chords', 'arp']),
    S('Drop', 32, 1, ['drums', 'bass', 'lead', 'pad']), S('Break', 16, 0.35, ['pad', 'chords']),
    S('Build', 8, 0.75, ['drums', 'fx', 'chords', 'arp']), S('Drop', 32, 1, ['drums', 'bass', 'lead', 'pad', 'arp']),
    S('Outro', 16, 0.4, ['drums', 'bass']),
  ],
};

/** Realistic standard song lengths (minutes at the default tempo). */
export const GENRE_MINUTES = {
  house: 6.5, 'deep-house': 6.5, 'tech-house': 6.5, techno: 6.5, minimal: 7, trance: 7.5, psytrance: 7.5, 'progressive-house': 7,
  dubstep: 4.5, brostep: 4, 'future-bass': 3.75, 'drum-and-bass': 5, 'liquid-dnb': 5, jungle: 5, breakbeat: 5, 'uk-garage': 5, 'two-step': 4.5,
  trap: 3, drill: 3, 'boom-bap': 3.75, 'lofi-hip-hop': 3, phonk: 2.75, rnb: 3.5, 'neo-soul': 4, pop: 3.5, kpop: 3.4, synthwave: 4,
  chillwave: 3.5, ambient: 6.5, downtempo: 4.5, 'trip-hop': 4.5, idm: 5, glitch: 4, chiptune: 3, rock: 3.75, punk: 2.5, metal: 4, indie: 3.5,
  funk: 4, disco: 5, 'nu-disco': 5.5, jazz: 5, 'bossa-nova': 3.5, blues: 4, gospel: 4.5, reggae: 3.75, dub: 4.5, dancehall: 3.25,
  reggaeton: 3.25, afrobeat: 3.5, amapiano: 6, salsa: 4, country: 3.4, folk: 3.5, cinematic: 3.5, industrial: 5.5, hardstyle: 5, eurobeat: 4,
  footwork: 3,
};

const DEF = {
  swing: 0, timeSig: [4, 4], humanize: 0, keys: null,
  melodyStyle: 'lead', arp: { mode: 'up', rate: 0.25, octaves: 1 },
};

function G(id, name, family, bpm, defaultBpm, o) {
  const template = typeof o.structure === 'string' ? STRUCTURES[o.structure] : o.structure;
  const minutes = o.minutes ?? GENRE_MINUTES[id];
  const ts = o.timeSig || DEF.timeSig;
  const bpb = ts[0] * (4 / ts[1]);
  // the standard form: the template fitted to the genre's realistic length at its default tempo
  const structure = minutes ? fitStructure(template, (minutes * defaultBpm) / bpb) : template.map((s) => ({ ...s, roles: [...s.roles] }));
  return { ...DEF, id, name, family, bpm, defaultBpm, ...o, minutes, structureId: typeof o.structure === 'string' ? o.structure : null, structure };
}

/** GENRES {id: GenreDef}. See docs/ARCHITECTURE.md "Generators". */
export const GENRES = {
  // ======================= HOUSE / TECHNO =======================
  house: G('house', 'House', 'house', [118, 130], 124, {
    swing: 0.1, scales: ['minor', 'dorian', 'major'], drumKit: '909', drumStyle: 'house', bassStyle: 'house', chordStyle: 'house',
    progressions: ['house-minor-7', 'dorian-vamp', 'soul-vamp', 'deep-house-9'], melodyStyle: 'hook',
    presets: { drums: '909', bass: 'pluck-bass', chords: 'house-stab', pad: 'juno-strings', lead: 'electric-piano', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'house', fx: ['Sidechain compression on pads/bass from the kick', 'Plate reverb on claps', 'Low-pass filter sweeps for builds'],
    tips: ['Four-on-the-floor kick with claps on 2 and 4; open hats on the off-beats drive the groove.', 'Use 7th/9th chord stabs (organ or piano) in a syncopated rhythm.', 'Arrange in 8/16-bar blocks so DJs can mix it.', 'Sidechain the bass and chords to the kick for pump.'],
  }),
  'deep-house': G('deep-house', 'Deep House', 'house', [118, 125], 122, {
    swing: 0.15, scales: ['minor', 'dorian'], drumKit: 'house', drumStyle: 'deep-house', bassStyle: 'deep', chordStyle: 'house',
    progressions: ['deep-house-9', 'house-minor-7', 'amapiano-minor', 'neo-soul-251'], melodyStyle: 'sparse',
    presets: { drums: 'house', bass: 'sub-bass', chords: 'electric-piano', pad: 'juno-strings', lead: 'vibraphone', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'house', fx: ['Lush hall reverb on chords', 'Tape saturation on drums', 'Gentle sidechain'],
    tips: ['Minor 9th and 11th chords give the warm, jazzy colour.', 'Keep the kick soft and round; let shakers and rimshots carry the groove.', 'Rolling sub bass that answers the kick rather than doubling it.'],
  }),
  'tech-house': G('tech-house', 'Tech House', 'house', [122, 128], 125, {
    swing: 0.12, scales: ['minor', 'phrygian', 'dorian'], drumKit: '909', drumStyle: 'tech-house', bassStyle: 'tech', chordStyle: 'stabs',
    progressions: ['techno-drone', 'house-minor-7', 'techno-two'], melodyStyle: 'riff',
    presets: { drums: '909', bass: 'fm-bass', chords: 'house-stab', pad: 'dark-pad', lead: 'acid-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'house', fx: ['Short room reverb on percussion', 'Distortion on the bass', 'Filter automation'],
    tips: ['The bassline is the hook: short, syncopated and groovy.', 'Shuffled 16th hats and quirky percussion keep it rolling.', 'Vocal chops and one-shots add character.'],
  }),
  techno: G('techno', 'Techno', 'techno', [125, 140], 132, {
    scales: ['minor', 'phrygian', 'dorian'], drumKit: 'techno', drumStyle: 'techno', bassStyle: 'rolling', chordStyle: 'stabs',
    progressions: ['techno-drone', 'techno-two', 'psy-phrygian'], melodyStyle: 'riff', arp: { mode: 'random', rate: 0.25, octaves: 2 },
    presets: { drums: 'techno', bass: 'saw-bass', chords: 'house-stab', pad: 'dark-pad', lead: 'acid-lead', arp: 'arp-saw', fx: 'noise-sweep' },
    structure: 'techno', fx: ['Long dark reverb on stabs (send, then gate/duck)', 'Delay throws', 'Saturation on the kick bus'],
    tips: ['Kick is king: tune the rumble below it and sidechain everything.', 'Build tension with filter automation instead of chord changes.', 'Repetition with subtle evolution — add or remove one element every 8–16 bars.'],
  }),
  minimal: G('minimal', 'Minimal', 'techno', [120, 128], 124, {
    swing: 0.1, scales: ['minor', 'dorian'], drumKit: 'techno', drumStyle: 'minimal', bassStyle: 'tech', chordStyle: 'stabs',
    progressions: ['techno-drone', 'house-minor-7'], melodyStyle: 'sparse',
    presets: { drums: 'techno', bass: 'sub-bass', chords: 'pluck', pad: 'ambient-pad', lead: 'marimba', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'techno', fx: ['Micro delays on clicks', 'Very short reverbs'],
    tips: ['Less is more: few elements, precise placement.', 'Micro-percussion and clicks give space and groove.', 'Automate tiny parameter changes for movement.'],
  }),
  trance: G('trance', 'Trance', 'trance', [132, 140], 138, {
    scales: ['minor', 'harmonic-minor'], drumKit: '909', drumStyle: 'trance', bassStyle: 'offbeat', chordStyle: 'trance-gate',
    progressions: ['aeolian-loop', 'trance-uplift', 'trance-anthem', 'epic-rise'], melodyStyle: 'hook', arp: { mode: 'updown', rate: 0.25, octaves: 2 },
    presets: { drums: '909', bass: 'saw-bass', chords: 'pluck', pad: 'supersaw-pad', lead: 'trance-lead', arp: 'arp-saw', fx: 'riser' },
    structure: 'trance', fx: ['Big hall reverb + delay on the lead', 'Gated supersaw pads', 'White-noise risers into drops'],
    tips: ['Long breakdowns with the main melody, then a huge build into the drop.', 'Rolling offbeat bass under a four-on-the-floor kick.', 'Supersaw leads in octaves with 1/8 dotted delay.'],
  }),
  psytrance: G('psytrance', 'Psytrance', 'trance', [138, 148], 145, {
    scales: ['phrygian', 'minor', 'phrygian-dominant'], drumKit: 'techno', drumStyle: 'psytrance', bassStyle: 'psy', chordStyle: 'stabs',
    progressions: ['psy-phrygian', 'techno-drone', 'drill-phrygian'], melodyStyle: 'riff', arp: { mode: 'random', rate: 0.25, octaves: 2 },
    presets: { drums: 'techno', bass: 'fm-bass', chords: 'pluck', pad: 'dark-pad', lead: 'acid-lead', arp: 'arp-saw', fx: 'laser' },
    structure: 'psytrance', fx: ['Resonant filter sweeps', 'Ping-pong delay on FX', 'Tight sidechain/ducking on bass'],
    tips: ['Rolling 16th bass: three notes between each kick (K-B-B-B).', 'Keep the kick short and punchy so bass fits between.', 'Phrygian riffs and psychedelic FX automation.'],
  }),
  'progressive-house': G('progressive-house', 'Progressive House', 'house', [122, 130], 126, {
    scales: ['minor', 'major'], drumKit: '909', drumStyle: 'progressive', bassStyle: 'offbeat', chordStyle: 'pulse8',
    progressions: ['axis-minor', 'aeolian-loop', 'pop-axis', 'trance-uplift'], melodyStyle: 'hook', arp: { mode: 'up', rate: 0.25, octaves: 2 },
    presets: { drums: '909', bass: 'saw-bass', chords: 'pluck', pad: 'supersaw-pad', lead: 'supersaw-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'progressive', fx: ['Long reverb tails', 'Filter builds over 16 bars'],
    tips: ['Slowly evolving layers: introduce one element every 8 bars.', 'Emotional chord progressions with plucky arps.', 'Long, satisfying builds.'],
  }),
  // ======================= BASS MUSIC =======================
  dubstep: G('dubstep', 'Dubstep', 'bass', [138, 142], 140, {
    scales: ['minor', 'phrygian'], drumKit: 'trap', drumStyle: 'dubstep', bassStyle: 'wobble', chordStyle: 'whole',
    progressions: ['dubstep-dark', 'trap-two-chord', 'aeolian-loop'], melodyStyle: 'sparse',
    presets: { drums: 'trap', bass: 'wobble-bass', chords: 'future-chords', pad: 'dark-pad', lead: 'square-lead', arp: 'arp-saw', fx: 'riser' },
    structure: 'edm', fx: ['Distortion & OTT on bass', 'Big snare reverb', 'Pitch-down FX before drops'],
    tips: ['Half-time feel at 140: kick on 1, snare on 3.', 'The drop is about bass sound design: LFO-wobbled filters in triplets and 1/8s.', 'Leave space — silence before the drop hits harder.'],
  }),
  brostep: G('brostep', 'Brostep', 'bass', [140, 150], 150, {
    scales: ['minor', 'phrygian'], drumKit: 'trap', drumStyle: 'dubstep', bassStyle: 'wobble', chordStyle: 'stabs',
    progressions: ['dubstep-dark', 'drill-phrygian', 'aeolian-loop'], melodyStyle: 'riff',
    presets: { drums: 'trap', bass: 'wobble-bass', chords: 'future-chords', pad: 'dark-pad', lead: 'hoover', arp: 'arp-saw', fx: 'laser' },
    structure: 'edm', fx: ['Heavy multiband distortion', 'Formant filters on bass', 'Laser FX'],
    tips: ['Aggressive mid-range growls and screeches with call/response.', 'Layer a clean sub under the distorted bass.', 'Big, tight snare on 3.'],
  }),
  'future-bass': G('future-bass', 'Future Bass', 'bass', [130, 160], 150, {
    scales: ['major', 'minor'], drumKit: 'trap', drumStyle: 'future-bass', bassStyle: 'sub', chordStyle: 'future',
    progressions: ['future-bass', 'axis-minor', 'royal-road', 'aeolian-loop'], melodyStyle: 'hook', arp: { mode: 'up', rate: 0.125, octaves: 2 },
    presets: { drums: 'trap', bass: 'sub-bass', chords: 'future-chords', pad: 'supersaw-pad', lead: 'supersaw-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'edm', fx: ['Heavy sidechain on supersaw chords', 'Vocal chop delays', 'Chorus + reverb on leads'],
    tips: ['Supersaw 7th/9th chords with volume pumping (sidechain/LFO).', 'Half-time trap drums with fast hats.', 'Pitch-bent vocal chops make great hooks.'],
  }),
  'drum-and-bass': G('drum-and-bass', 'Drum & Bass', 'dnb', [170, 178], 174, {
    scales: ['minor', 'dorian'], drumKit: 'dnb', drumStyle: 'dnb', bassStyle: 'reese', chordStyle: 'whole',
    progressions: ['dnb-liquid', 'aeolian-loop', 'jungle-rave', 'dubstep-dark'], melodyStyle: 'sparse',
    presets: { drums: 'dnb', bass: 'reese-bass', chords: 'pluck', pad: 'dark-pad', lead: 'saw-lead', arp: 'arp-saw', fx: 'riser' },
    structure: 'dnb', fx: ['Parallel compression on breaks', 'Detuned chorus on reese', 'Short plate on snare'],
    tips: ['Two-step beat: kick on 1 and the "and" of 3, snares on 2 and 4.', 'Reese bass: detuned saws with slow filter movement.', 'Split bass into clean sub + distorted mids.'],
  }),
  'liquid-dnb': G('liquid-dnb', 'Liquid DnB', 'dnb', [170, 176], 174, {
    swing: 0.05, scales: ['minor', 'dorian', 'major'], drumKit: 'dnb', drumStyle: 'liquid', bassStyle: 'sub', chordStyle: 'whole',
    progressions: ['dnb-liquid', 'deep-house-9', 'neo-soul-descend', 'amapiano'], melodyStyle: 'vocal',
    presets: { drums: 'dnb', bass: 'sub-bass', chords: 'electric-piano', pad: 'string-pad', lead: 'flute', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'dnb', fx: ['Lush reverb on keys and pads', 'Ride cymbal for shimmer', 'Gentle tape saturation'],
    tips: ['Soulful extended chords (maj7/m9) over rolling breaks.', 'Smooth sub bass following the chord roots.', 'Ghost snares and shakers add flow.'],
  }),
  jungle: G('jungle', 'Jungle', 'dnb', [160, 175], 168, {
    scales: ['minor', 'dorian'], drumKit: 'breaks', drumStyle: 'jungle', bassStyle: 'dub', chordStyle: 'stabs',
    progressions: ['jungle-rave', 'dub-rock', 'footwork-soul'], melodyStyle: 'sparse',
    presets: { drums: 'breaks', bass: 'sub-bass', chords: 'organ-drawbar', pad: 'string-pad', lead: 'whistle-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'dnb', fx: ['Chopped, time-stretched breaks', 'Dub delays', 'Big spring reverb'],
    tips: ['Chop and rearrange the Amen break — vary every 2 or 4 bars.', 'Deep reggae-style sub bass under fast breaks.', 'Ragga vocal samples and rave stabs.'],
  }),
  breakbeat: G('breakbeat', 'Breakbeat', 'breaks', [125, 140], 132, {
    swing: 0.08, scales: ['minor', 'dorian'], drumKit: 'breaks', drumStyle: 'breakbeat', bassStyle: 'tech', chordStyle: 'stabs',
    progressions: ['jungle-rave', 'techno-two', 'house-minor-7'], melodyStyle: 'riff',
    presets: { drums: 'breaks', bass: 'acid-bass', chords: 'house-stab', pad: 'dark-pad', lead: 'acid-lead', arp: 'arp-saw', fx: 'noise-sweep' },
    structure: 'garage', fx: ['Parallel-compressed breaks', 'Acid filter automation'],
    tips: ['Syncopated, funky break patterns with ghost snares.', 'Acid or reese basslines.', 'Big-beat style FX and stabs.'],
  }),
  'uk-garage': G('uk-garage', 'UK Garage', 'garage', [128, 136], 132, {
    swing: 0.55, scales: ['minor', 'dorian'], drumKit: 'garage', drumStyle: 'garage', bassStyle: 'garage', chordStyle: 'house',
    progressions: ['garage-stabs', 'house-minor-7', 'deep-house-9'], melodyStyle: 'vocal',
    presets: { drums: 'garage', bass: 'sub-bass', chords: 'organ-drawbar', pad: 'warm-pad', lead: 'electric-piano', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'garage', fx: ['Swing on the hats', 'Pitched vocal chops', 'Organ stabs with short reverb'],
    tips: ['Heavy swing on 16th hats is essential.', 'Skippy kicks, shuffling snares and organ/m7 stabs.', 'Chopped R&B vocals as hooks.'],
  }),
  'two-step': G('two-step', '2-Step', 'garage', [128, 136], 132, {
    swing: 0.6, scales: ['minor', 'dorian'], drumKit: 'garage', drumStyle: 'two-step', bassStyle: 'garage', chordStyle: 'house',
    progressions: ['garage-stabs', 'house-minor-7', 'neo-soul-251'], melodyStyle: 'vocal',
    presets: { drums: 'garage', bass: 'sub-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'fm-epiano', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'garage', fx: ['Swing', 'Short plate on snares', 'Sub-bass sidechain'],
    tips: ['No kick on 2 and 4 — the "skipping" kick pattern defines 2-step.', 'Snares on 2 and 4 with shuffled ghost hits.', 'Bouncy sub bass with octave jumps.'],
  }),
  // ======================= HIP-HOP / URBAN =======================
  trap: G('trap', 'Trap', 'hiphop', [130, 160], 140, {
    scales: ['minor', 'harmonic-minor', 'phrygian'], drumKit: 'trap', drumStyle: 'trap', bassStyle: '808', chordStyle: 'whole',
    progressions: ['sad-trap', 'trap-two-chord', 'trap-bells', 'drill-phrygian'], melodyStyle: 'hook', arp: { mode: 'updown', rate: 0.25, octaves: 1 },
    presets: { drums: 'trap', bass: '808-bass', chords: 'bell', pad: 'dark-pad', lead: 'fm-bell-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'hiphop', fx: ['Saturation on the 808', 'Reverb on bells', 'Stereo delay on hat rolls'],
    tips: ['Half-time snare on beat 3 with fast hi-hat rolls (1/32, triplets).', 'Long 808s with pitch glides following the kick.', 'Dark bell/piano melodies in minor keys.'],
  }),
  drill: G('drill', 'UK Drill', 'hiphop', [138, 146], 142, {
    scales: ['minor', 'harmonic-minor', 'phrygian'], drumKit: 'trap', drumStyle: 'drill', bassStyle: 'drill', chordStyle: 'whole',
    progressions: ['drill-phrygian', 'drill-sliding', 'sad-trap'], melodyStyle: 'sparse',
    presets: { drums: 'trap', bass: '808-bass', chords: 'strings', pad: 'choir-pad', lead: 'grand-piano', arp: 'arp-pluck', fx: 'riser' },
    structure: 'hiphop', fx: ['Pitch glides on 808', 'Dark choir/strings reverb'],
    tips: ['Sliding 808s are the signature — glide between notes.', 'Syncopated snare placement and triplet hi-hats.', 'Dark minor strings, choirs and pianos.'],
  }),
  'boom-bap': G('boom-bap', 'Hip-Hop (Boom Bap)', 'hiphop', [85, 98], 90, {
    swing: 0.55, humanize: 0.3, scales: ['minor', 'dorian'], drumKit: 'acoustic', drumStyle: 'boom-bap', bassStyle: 'boom-bap', chordStyle: 'whole',
    progressions: ['boom-bap-soul', 'house-minor-7', 'jazz-turnaround', 'minor-ii-v-i'], melodyStyle: 'sparse',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'electric-piano', pad: 'strings', lead: 'vibraphone', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'boombap', fx: ['Vinyl saturation', 'Low-pass on samples', 'Compressed, punchy drums'],
    tips: ['Hard kick and snare (2 & 4) with swung hats.', 'Jazz/soul sampled chords, chopped and filtered.', 'Leave space in the mids for the vocal.'],
  }),
  'lofi-hip-hop': G('lofi-hip-hop', 'Lo-fi Hip-Hop', 'hiphop', [70, 90], 80, {
    swing: 0.6, humanize: 0.4, scales: ['major', 'dorian', 'minor'], drumKit: 'lofi', drumStyle: 'lofi', bassStyle: 'boom-bap', chordStyle: 'neo-soul',
    progressions: ['jazz-turnaround', 'neo-soul-descend', 'lofi-minor', 'just-the-two', 'chillwave'], melodyStyle: 'sparse',
    presets: { drums: 'lofi', bass: 'upright-bass', chords: 'lofi-keys', pad: 'warm-pad', lead: 'vibraphone', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'chill', fx: ['Vinyl crackle & wow/flutter', 'Low-pass filter ~8 kHz', 'Bitcrush lightly'],
    tips: ['Jazzy 7th/9th chords with a lazy, swung groove.', 'Humanize timing; drums slightly behind the beat.', 'Lo-fi texture: tape wobble, noise and soft transients.'],
  }),
  phonk: G('phonk', 'Phonk', 'hiphop', [130, 160], 140, {
    scales: ['minor', 'phrygian'], drumKit: 'phonk', drumStyle: 'phonk', bassStyle: '808', chordStyle: 'whole',
    progressions: ['phonk-loop', 'trap-two-chord', 'drill-phrygian'], melodyStyle: 'riff',
    presets: { drums: 'phonk', bass: '808-bass', chords: 'organ-rock', pad: 'dark-pad', lead: 'fm-bell-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'hiphop', fx: ['Heavy distortion on 808', 'Cowbell melody with reverb', 'Memphis vocal chops'],
    tips: ['Cowbell melodies are the drift-phonk trademark.', 'Distorted, punchy 808s and aggressive hats.', 'Memphis rap samples and dark minor riffs.'],
  }),
  rnb: G('rnb', 'R&B', 'soul', [65, 100], 85, {
    swing: 0.25, humanize: 0.2, scales: ['minor', 'dorian', 'major'], drumKit: 'trap', drumStyle: 'rnb', bassStyle: 'sub', chordStyle: 'neo-soul',
    progressions: ['neo-soul-251', 'just-the-two', 'garage-stabs', 'trap-bells'], melodyStyle: 'vocal',
    presets: { drums: 'trap', bass: 'sub-bass', chords: 'electric-piano', pad: 'string-pad', lead: 'fm-epiano', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'pop', fx: ['Smooth plate reverb on vocals/keys', 'Gentle saturation'],
    tips: ['Lush extended chords (maj7, m9, 11) and smooth voice leading.', 'Trap-soul drums: sparse kicks, snaps, rolling hats.', 'Leave room for vocal runs and harmonies.'],
  }),
  'neo-soul': G('neo-soul', 'Neo-Soul', 'soul', [70, 95], 84, {
    swing: 0.5, humanize: 0.45, scales: ['dorian', 'major', 'minor'], drumKit: 'acoustic', drumStyle: 'neo-soul', bassStyle: 'neo-soul', chordStyle: 'neo-soul',
    progressions: ['neo-soul-descend', 'neo-soul-251', 'just-the-two', 'tritone-sub', 'backdoor'], melodyStyle: 'vocal',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'fm-epiano', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'chill', fx: ['Rhodes tremolo + chorus', 'Tape saturation'],
    tips: ['Dilla-style drunk drums: quantize loosely, push/pull timing.', 'Extended chords with chromatic passing chords.', 'Melodic bass with slides and ghost notes.'],
  }),
  // ======================= POP =======================
  pop: G('pop', 'Pop', 'pop', [95, 128], 118, {
    scales: ['major', 'minor'], drumKit: '808', drumStyle: 'pop', bassStyle: 'pop', chordStyle: 'pulse8',
    progressions: ['pop-axis', 'axis-minor', 'fifties', 'axis-iv-start', 'i-iv-vi-v'], melodyStyle: 'hook',
    presets: { drums: '808', bass: 'synthwave-bass', chords: 'grand-piano', pad: 'warm-pad', lead: 'square-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'pop', fx: ['Vocal reverb/delay throws', 'Bus compression', 'Risers into choruses'],
    tips: ['Hook first: the chorus melody should be singable after one listen.', 'Contrast verse (sparse) vs chorus (full, wider, brighter).', 'Pre-chorus raises energy — try lifting the bass or adding hats.'],
  }),
  kpop: G('kpop', 'K-Pop', 'pop', [100, 135], 124, {
    scales: ['minor', 'major', 'dorian'], drumKit: '909', drumStyle: 'kpop', bassStyle: 'pop', chordStyle: 'future',
    progressions: ['royal-road', 'kpop-drama', 'axis-minor', 'just-the-two'], melodyStyle: 'hook',
    presets: { drums: '909', bass: 'synthwave-bass', chords: 'future-chords', pad: 'supersaw-pad', lead: 'supersaw-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'pop', fx: ['Big risers & impacts', 'Vocal chops', 'Wide stereo synths'],
    tips: ['Genre switch-ups between sections are part of the style.', 'Dense production with ear-candy every 4 bars.', 'Powerful, catchy hook + dance-break section.'],
  }),
  synthwave: G('synthwave', 'Synthwave', 'retro', [80, 118], 100, {
    scales: ['minor', 'dorian'], drumKit: '808', drumStyle: 'synthwave', bassStyle: 'synthwave', chordStyle: 'whole',
    progressions: ['synthwave-drive', 'synthwave-mediant', 'aeolian-loop', 'mario-cadence'], melodyStyle: 'lead', arp: { mode: 'up', rate: 0.25, octaves: 2 },
    presets: { drums: '808', bass: 'synthwave-bass', chords: 'synthwave-pad', pad: 'juno-strings', lead: 'saw-lead', arp: 'arp-saw', fx: 'noise-sweep' },
    structure: 'pop', fx: ['Gated reverb on snare', 'Chorus on pads and bass', 'Tape saturation'],
    tips: ['Pulsing 8th-note bass locked to the grid.', 'Big gated-reverb snare on 2 and 4.', 'Lush detuned pads and arpeggios — 80s soundtrack vibes.'],
  }),
  chillwave: G('chillwave', 'Chillwave', 'retro', [75, 110], 92, {
    swing: 0.1, scales: ['major', 'lydian', 'dorian'], drumKit: '808', drumStyle: 'chillwave', bassStyle: 'synthwave', chordStyle: 'whole',
    progressions: ['chillwave', 'soul-vamp', 'indie-dreamy', 'lydian-float'], melodyStyle: 'vocal',
    presets: { drums: '808', bass: 'synthwave-bass', chords: 'electric-piano', pad: 'juno-strings', lead: 'fm-bell-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'chill', fx: ['Tape wobble', 'Heavy reverb', 'Sidechain on everything'],
    tips: ['Hazy, washed-out pads and reverb.', 'Lo-fi drum machines with soft transients.', 'Major 7th chords and nostalgic melodies.'],
  }),
  // ======================= AMBIENT / DOWNTEMPO / EXPERIMENTAL =======================
  ambient: G('ambient', 'Ambient', 'ambient', [60, 90], 70, {
    scales: ['lydian', 'major', 'dorian', 'major-pentatonic'], drumKit: 'cinematic', drumStyle: 'ambient', bassStyle: 'drone', chordStyle: 'whole',
    progressions: ['ambient-drift', 'lydian-float', 'soul-vamp', 'amen'], melodyStyle: 'ambient', arp: { mode: 'random', rate: 0.5, octaves: 2 },
    presets: { drums: 'cinematic', bass: 'sub-bass', chords: 'glass-pad', pad: 'ambient-pad', lead: 'bell', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'ambient', fx: ['Very long reverbs (8s+)', 'Feedback delays', 'Slow filter LFOs'],
    tips: ['Slow-evolving textures; let sounds breathe.', 'Use long attack/release and modulation.', 'Generative, sparse melodies with lots of space.'],
  }),
  downtempo: G('downtempo', 'Downtempo', 'chill', [80, 110], 95, {
    swing: 0.2, humanize: 0.2, scales: ['minor', 'dorian'], drumKit: 'lofi', drumStyle: 'downtempo', bassStyle: 'dub', chordStyle: 'neo-soul',
    progressions: ['chillwave', 'trip-hop-noir', 'ambient-drift', 'deep-house-9'], melodyStyle: 'vocal',
    presets: { drums: 'lofi', bass: 'sub-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'flute', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'chill', fx: ['Warm tape saturation', 'Spacious reverb'],
    tips: ['Laid-back grooves with organic percussion.', 'Warm, deep bass and jazzy chords.', 'Field recordings add atmosphere.'],
  }),
  'trip-hop': G('trip-hop', 'Trip-Hop', 'chill', [70, 100], 85, {
    swing: 0.3, humanize: 0.3, scales: ['minor', 'harmonic-minor'], drumKit: 'breaks', drumStyle: 'trip-hop', bassStyle: 'dub', chordStyle: 'whole',
    progressions: ['trip-hop-noir', 'minor-line-cliche', 'minor-blues', 'minor-ii-v-i'], melodyStyle: 'vocal',
    presets: { drums: 'breaks', bass: 'dub-bass', chords: 'electric-piano', pad: 'strings', lead: 'vibraphone', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'chill', fx: ['Vinyl crackle', 'Dark spring reverb', 'Lo-fi bitcrushing'],
    tips: ['Slow, heavy breakbeats with a hard snare.', 'Dark, cinematic strings and noir jazz chords.', 'Scratches and vinyl texture.'],
  }),
  idm: G('idm', 'IDM', 'experimental', [90, 160], 120, {
    swing: 0.1, scales: ['lydian', 'dorian', 'whole-tone', 'minor'], drumKit: '909', drumStyle: 'idm', bassStyle: 'tech', chordStyle: 'arp',
    progressions: ['idm-planing', 'lydian-float', 'ambient-drift'], melodyStyle: 'riff', arp: { mode: 'random', rate: 0.125, octaves: 3 },
    presets: { drums: '909', bass: 'fm-bass', chords: 'celesta', pad: 'glass-pad', lead: 'fm-bell-lead', arp: 'arp-pluck', fx: 'laser' },
    structure: 'ambient', fx: ['Granular stutter', 'Bitcrush automation', 'Complex delays'],
    tips: ['Complex, shifting rhythms (try odd euclidean patterns).', 'Melodic, detailed sound design.', 'Contrast delicate melodies with glitchy drums.'],
  }),
  glitch: G('glitch', 'Glitch', 'experimental', [100, 150], 128, {
    scales: ['minor', 'chromatic', 'whole-tone'], drumKit: 'industrial', drumStyle: 'glitch', bassStyle: 'tech', chordStyle: 'stabs',
    progressions: ['idm-planing', 'techno-drone', 'dubstep-dark'], melodyStyle: 'riff', arp: { mode: 'random', rate: 0.125, octaves: 2 },
    presets: { drums: 'industrial', bass: 'fm-bass', chords: 'pluck', pad: 'dark-pad', lead: 'sync-lead', arp: 'arp-saw', fx: 'laser' },
    structure: 'edm', fx: ['Stutter / beat-repeat', 'Bitcrusher', 'Tape-stop'],
    tips: ['Stutters, retriggers and micro-edits are the instrument.', 'Precise, clicky drums.', 'Automate everything.'],
  }),
  chiptune: G('chiptune', 'Chiptune', 'retro', [120, 170], 150, {
    scales: ['major', 'minor', 'major-pentatonic'], drumKit: 'chip', drumStyle: 'chiptune', bassStyle: 'chip', chordStyle: 'arp',
    progressions: ['chiptune-hero', 'mario-cadence', 'fifties', 'pop-axis'], melodyStyle: 'lead', arp: { mode: 'up', rate: 0.0625, octaves: 1 },
    presets: { drums: 'chip', bass: 'chip-bass', chords: 'pluck', pad: 'glass-pad', lead: 'chip-lead', arp: 'arp-pluck', fx: 'laser' },
    structure: 'pop', fx: ['Bitcrusher', 'Short echo'],
    tips: ['Fast arpeggios simulate chords on limited channels.', 'Square/pulse leads with vibrato.', 'Noise-channel drums.'],
  }),
  // ======================= ROCK / BAND =======================
  rock: G('rock', 'Rock', 'rock', [100, 150], 120, {
    humanize: 0.25, scales: ['major', 'minor', 'mixolydian', 'minor-pentatonic'], drumKit: 'rock', drumStyle: 'rock', bassStyle: 'rock', chordStyle: 'power',
    progressions: ['pop-axis', 'mixolydian-rock', 'three-chord', 'creep', 'metal-power'], melodyStyle: 'riff',
    presets: { drums: 'rock', bass: 'finger-bass', chords: 'guitar-dist', pad: 'organ-rock', lead: 'guitar-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'rock', fx: ['Amp distortion on guitars', 'Room reverb on drums', 'Bus compression'],
    tips: ['Power chords and driving 8th-note bass.', 'Kick on 1 & 3, snare on 2 & 4, crash at section starts.', 'Double-track rhythm guitars hard left/right.'],
  }),
  punk: G('punk', 'Punk', 'rock', [150, 200], 180, {
    humanize: 0.2, scales: ['major', 'minor'], drumKit: 'rock', drumStyle: 'punk', bassStyle: 'rock', chordStyle: 'power',
    progressions: ['pop-punk', 'three-chord', 'mixolydian-rock'], melodyStyle: 'riff',
    presets: { drums: 'rock', bass: 'saw-bass', chords: 'power-chord', pad: 'organ-rock', lead: 'guitar-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'rock', fx: ['Raw distortion', 'Short room'],
    tips: ['Fast, simple and loud: three chords and the truth.', 'Down-picked 8th-note power chords.', 'Skate beat: kick-snare alternating 8ths.'],
  }),
  metal: G('metal', 'Metal', 'rock', [100, 200], 160, {
    humanize: 0.1, scales: ['phrygian', 'minor', 'harmonic-minor', 'phrygian-dominant'], drumKit: 'rock', drumStyle: 'metal', bassStyle: 'metal', chordStyle: 'power',
    progressions: ['metal-power', 'metal-tritone', 'andalusian', 'epic-rise'], melodyStyle: 'riff',
    presets: { drums: 'rock', bass: 'saw-bass', chords: 'guitar-dist', pad: 'choir-pad', lead: 'guitar-lead', arp: 'arp-saw', fx: 'noise-sweep' },
    structure: 'rock', fx: ['High-gain amp sim', 'Tight gate', 'Kick click EQ'],
    tips: ['Palm-muted chugs locked with double-kick.', 'Phrygian b2 and tritones for darkness.', 'Tight editing: everything on the grid.'],
  }),
  indie: G('indie', 'Indie', 'rock', [90, 140], 115, {
    humanize: 0.25, scales: ['major', 'mixolydian', 'dorian'], drumKit: 'acoustic', drumStyle: 'indie', bassStyle: 'pop', chordStyle: 'strum',
    progressions: ['indie-dreamy', 'creep', 'i-iii-iv-v', 'mixolydian-rock'], melodyStyle: 'vocal',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'guitar-clean', pad: 'warm-pad', lead: 'guitar-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'rock', fx: ['Chorus on clean guitar', 'Spring reverb', 'Tape delay'],
    tips: ['Jangly clean guitars with chorus.', 'Melodic bass lines that move independently.', 'Lo-fi charm is OK — keep some rough edges.'],
  }),
  funk: G('funk', 'Funk', 'funk', [95, 120], 108, {
    swing: 0.15, humanize: 0.25, scales: ['dorian', 'mixolydian', 'minor-pentatonic'], drumKit: 'acoustic', drumStyle: 'funk', bassStyle: 'funk', chordStyle: 'stabs',
    progressions: ['funk-vamp', 'dorian-vamp', 'just-the-two'], melodyStyle: 'riff',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'clav', pad: 'brass-section', lead: 'brass-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'groove', fx: ['Auto-wah on clav/guitar', 'Tight compression'],
    tips: ['It\'s all about "the one" — land the downbeat hard.', 'Ghost notes on snare and 16th-note hats.', 'Syncopated slap bass with octaves and dead notes.'],
  }),
  disco: G('disco', 'Disco', 'funk', [110, 130], 118, {
    swing: 0.05, humanize: 0.15, scales: ['major', 'dorian', 'minor'], drumKit: 'acoustic', drumStyle: 'disco', bassStyle: 'disco', chordStyle: 'offbeat',
    progressions: ['nu-disco', 'disco-minor', 'vi-ii-v-i', 'dorian-vamp'], melodyStyle: 'hook',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'guitar-clean', pad: 'strings', lead: 'brass-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'groove', fx: ['Plate reverb on strings', 'Phaser on hats'],
    tips: ['Four-on-the-floor with open hats on every off-beat.', 'Octave-jumping bass lines.', 'String swells and brass stabs.'],
  }),
  'nu-disco': G('nu-disco', 'Nu-Disco', 'funk', [110, 126], 120, {
    swing: 0.08, scales: ['minor', 'dorian', 'major'], drumKit: '909', drumStyle: 'disco', bassStyle: 'disco', chordStyle: 'house',
    progressions: ['nu-disco', 'disco-minor', 'royal-road', 'dorian-vamp'], melodyStyle: 'hook',
    presets: { drums: '909', bass: 'moog-bass', chords: 'house-stab', pad: 'juno-strings', lead: 'square-lead', arp: 'arp-saw', fx: 'noise-sweep' },
    structure: 'house', fx: ['Filter house sweeps', 'Sidechain'],
    tips: ['Disco grooves with modern synths and filter sweeps.', 'Arpeggiated synth bass.', 'Chopped disco samples or string stabs.'],
  }),
  // ======================= JAZZ / BLUES / GOSPEL =======================
  jazz: G('jazz', 'Jazz', 'jazz', [90, 220], 140, {
    swing: 0.66, humanize: 0.35, scales: ['major', 'dorian', 'bebop-dominant', 'melodic-minor'], drumKit: 'jazz', drumStyle: 'jazz', bassStyle: 'walking', chordStyle: 'comp',
    progressions: ['ii-v-i', 'jazz-turnaround', 'rhythm-changes', 'minor-ii-v-i', 'jazz-blues', 'tritone-sub'], melodyStyle: 'lead',
    presets: { drums: 'jazz', bass: 'upright-bass', chords: 'grand-piano', pad: 'strings', lead: 'vibraphone', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'jazz', fx: ['Natural room reverb', 'Minimal processing'],
    tips: ['Walking bass outlines chords with chromatic approach notes.', 'Ride cymbal "ding ding-a ding" with hi-hat on 2 & 4.', 'Comp with rootless voicings and Charleston rhythms.'],
  }),
  'bossa-nova': G('bossa-nova', 'Bossa Nova', 'latin', [110, 140], 126, {
    humanize: 0.2, scales: ['major', 'dorian'], drumKit: 'latin', drumStyle: 'bossa', bassStyle: 'bossa', chordStyle: 'bossa',
    progressions: ['bossa-ipanema', 'ii-v-i', 'jazz-turnaround', 'minor-line-cliche'], melodyStyle: 'vocal',
    presets: { drums: 'latin', bass: 'upright-bass', chords: 'guitar-clean', pad: 'strings', lead: 'flute', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'jazz', fx: ['Warm room reverb', 'Soft compression'],
    tips: ['Syncopated nylon-guitar comping with jazzy chords.', 'Bass on 1 and the "and" of 2 (root-fifth).', 'Rim-click bossa clave pattern.'],
  }),
  blues: G('blues', 'Blues', 'blues', [70, 130], 96, {
    swing: 0.66, humanize: 0.3, scales: ['blues', 'minor-pentatonic', 'mixolydian', 'major-blues'], drumKit: 'acoustic', drumStyle: 'blues', bassStyle: 'blues', chordStyle: 'shuffle',
    progressions: ['twelve-bar-blues', 'quick-change-blues', 'minor-blues', 'eight-bar-blues'], melodyStyle: 'riff',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'guitar-clean', pad: 'organ-drawbar', lead: 'guitar-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'blues', fx: ['Spring reverb', 'Tube overdrive on guitar'],
    tips: ['Shuffle feel: swung triplet 8ths.', '12-bar form with dominant 7th chords on I, IV and V.', 'Call and response between voice and guitar.'],
  }),
  gospel: G('gospel', 'Gospel', 'soul', [70, 130], 96, {
    swing: 0.35, humanize: 0.25, scales: ['major', 'major-blues', 'mixolydian'], drumKit: 'acoustic', drumStyle: 'gospel', bassStyle: 'gospel', chordStyle: 'gospel',
    progressions: ['gospel-walk', 'gospel-1-4', 'amen', 'secondary-lift', 'fifties'], melodyStyle: 'vocal',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'organ-drawbar', pad: 'choir-pad', lead: 'grand-piano', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'pop', fx: ['Leslie on organ', 'Hall reverb on choir'],
    tips: ['Passing diminished chords and secondary dominants everywhere.', 'Big choir pads and Hammond organ swells.', 'Chops and fills between phrases.'],
  }),
  // ======================= CARIBBEAN / LATIN / AFRICAN =======================
  reggae: G('reggae', 'Reggae', 'caribbean', [65, 90], 76, {
    swing: 0.3, humanize: 0.2, scales: ['major', 'minor', 'dorian'], drumKit: 'acoustic', drumStyle: 'one-drop', bassStyle: 'reggae', chordStyle: 'skank',
    progressions: ['reggae-skank', 'reggae-minor', 'pop-axis', 'dub-rock'], melodyStyle: 'vocal',
    presets: { drums: 'acoustic', bass: 'dub-bass', chords: 'organ-drawbar', pad: 'organ-drawbar', lead: 'guitar-clean', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'groove', fx: ['Spring reverb on rim', 'Tape echo on skanks'],
    tips: ['One-drop: kick and rim together on beat 3, nothing on 1.', 'Skank guitar/organ on beats 2 and 4.', 'Bass is melodic and leaves space.'],
  }),
  dub: G('dub', 'Dub', 'caribbean', [65, 90], 74, {
    swing: 0.25, humanize: 0.2, scales: ['minor', 'dorian'], drumKit: 'acoustic', drumStyle: 'steppers', bassStyle: 'dub', chordStyle: 'skank',
    progressions: ['dub-rock', 'reggae-minor', 'minor-four'], melodyStyle: 'sparse',
    presets: { drums: 'acoustic', bass: 'dub-bass', chords: 'organ-drawbar', pad: 'dark-pad', lead: 'brass-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'groove', fx: ['Tape delay with feedback throws', 'Spring reverb', 'High-pass filter sweeps'],
    tips: ['The mixer is an instrument: drop elements in and out.', 'Massive sub bass and echo-laden skanks.', 'Steppers kick on every beat for energy.'],
  }),
  dancehall: G('dancehall', 'Dancehall', 'caribbean', [90, 110], 100, {
    scales: ['minor', 'dorian'], drumKit: 'reggaeton', drumStyle: 'dancehall', bassStyle: 'dembow', chordStyle: 'stabs',
    progressions: ['dancehall', 'reggae-minor', 'reggaeton-minor'], melodyStyle: 'hook',
    presets: { drums: 'reggaeton', bass: '808-bass', chords: 'steel-drum', pad: 'warm-pad', lead: 'square-lead', arp: 'arp-pluck', fx: 'laser' },
    structure: 'groove', fx: ['Short reverbs', 'Pitched vocal chops'],
    tips: ['3-3-2 kick feel with claps on 2 and 4.', 'Minor riddim loop; leave lots of room for the vocal.', 'Digital sounds — steel drums, plucks, sub bass.'],
  }),
  reggaeton: G('reggaeton', 'Reggaeton', 'latin', [88, 100], 95, {
    scales: ['minor', 'harmonic-minor', 'major'], drumKit: 'reggaeton', drumStyle: 'dembow', bassStyle: 'dembow', chordStyle: 'stabs',
    progressions: ['reggaeton', 'reggaeton-minor', 'andalusian'], melodyStyle: 'hook',
    presets: { drums: 'reggaeton', bass: '808-bass', chords: 'pluck', pad: 'warm-pad', lead: 'square-lead', arp: 'arp-pluck', fx: 'riser' },
    structure: 'groove', fx: ['Short room on snare', 'Vocal autotune vibe'],
    tips: ['Dembow rhythm: kick on every beat, snare on the "a" of 1 and "and" of 2.', 'Simple minor chord loops (often vi–IV–I–V).', '808 bass doubling the kick.'],
  }),
  afrobeat: G('afrobeat', 'Afrobeats', 'african', [95, 115], 104, {
    swing: 0.2, humanize: 0.2, scales: ['major', 'dorian', 'mixolydian', 'major-pentatonic'], drumKit: 'afro', drumStyle: 'afrobeat', bassStyle: 'afro', chordStyle: 'stabs',
    progressions: ['afrobeats', 'highlife', 'pop-axis', 'dorian-vamp'], melodyStyle: 'hook',
    presets: { drums: 'afro', bass: 'sub-bass', chords: 'guitar-clean', pad: 'warm-pad', lead: 'kalimba', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'groove', fx: ['Short room on percussion', 'Stereo delay on guitars'],
    tips: ['Syncopated shaker and percussion carry the groove.', 'Highlife-style guitar riffs and log/conga patterns.', 'Kick with a laid-back, swung 3-3-2 feel.'],
  }),
  amapiano: G('amapiano', 'Amapiano', 'african', [110, 118], 113, {
    swing: 0.2, scales: ['minor', 'dorian', 'major'], drumKit: 'afro', drumStyle: 'amapiano', bassStyle: 'log-drum', chordStyle: 'neo-soul',
    progressions: ['amapiano', 'amapiano-minor', 'neo-soul-251', 'deep-house-9'], melodyStyle: 'sparse',
    presets: { drums: 'afro', bass: 'sub-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'flute', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'house', fx: ['Wide reverb on keys', 'Log-drum saturation'],
    tips: ['Log-drum basslines with pitch slides are the signature.', 'Jazzy deep-house chords and airy pads.', 'Shakers and syncopated percussion; sparse kicks.'],
  }),
  salsa: G('salsa', 'Latin / Salsa', 'latin', [160, 220], 190, {
    humanize: 0.2, scales: ['minor', 'major', 'harmonic-minor'], drumKit: 'latin', drumStyle: 'salsa', bassStyle: 'tumbao', chordStyle: 'montuno',
    progressions: ['salsa-montuno', 'salsa-minor', 'andalusian', 'harmonic-minor-cadence'], melodyStyle: 'hook',
    presets: { drums: 'latin', bass: 'upright-bass', chords: 'grand-piano', pad: 'brass-section', lead: 'brass-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'salsa', fx: ['Room reverb', 'Brass section stereo spread'],
    tips: ['Everything locks to the clave (son 3-2 or 2-3).', 'Piano montuno syncopations and tumbao bass anticipations.', 'Brass mambo sections for climaxes.'],
  }),
  // ======================= COUNTRY / FOLK =======================
  country: G('country', 'Country', 'americana', [80, 140], 110, {
    swing: 0.1, humanize: 0.25, scales: ['major', 'major-pentatonic', 'mixolydian'], drumKit: 'acoustic', drumStyle: 'country', bassStyle: 'country', chordStyle: 'strum',
    progressions: ['country-turnaround', 'three-chord', 'pop-axis', 'ragtime'], melodyStyle: 'vocal',
    presets: { drums: 'acoustic', bass: 'finger-bass', chords: 'guitar-clean', pad: 'organ-drawbar', lead: 'guitar-lead', arp: 'arp-pluck', fx: 'noise-sweep' },
    structure: 'pop', fx: ['Slapback delay', 'Natural room'],
    tips: ['Root-fifth "boom-chick" bass.', 'Train beat or simple 2&4 backbeat.', 'Storytelling lyrics and pedal-steel style bends.'],
  }),
  folk: G('folk', 'Folk', 'americana', [70, 130], 96, {
    humanize: 0.35, scales: ['major', 'mixolydian', 'dorian', 'major-pentatonic'], drumKit: 'acoustic', drumStyle: 'folk', bassStyle: 'root', chordStyle: 'strum',
    progressions: ['folk-ballad', 'three-chord', 'canon', 'amen'], melodyStyle: 'vocal',
    presets: { drums: 'acoustic', bass: 'upright-bass', chords: 'guitar-clean', pad: 'strings', lead: 'flute', arp: 'harp', fx: 'noise-sweep' },
    structure: 'pop', fx: ['Natural room reverb', 'Light compression'],
    tips: ['Acoustic strumming patterns drive the song.', 'Modal melodies (Dorian/Mixolydian) feel traditional.', 'Minimal percussion: stomps, claps, tambourine.'],
  }),
  // ======================= CINEMATIC / INDUSTRIAL / HARD =======================
  cinematic: G('cinematic', 'Cinematic / Orchestral', 'cinematic', [60, 140], 90, {
    scales: ['minor', 'harmonic-minor', 'lydian', 'dorian'], drumKit: 'cinematic', drumStyle: 'cinematic', bassStyle: 'cinematic', chordStyle: 'ostinato',
    progressions: ['cinematic-epic', 'chromatic-mediant', 'epic-rise', 'dark-tension', 'lydian-float'], melodyStyle: 'lead',
    presets: { drums: 'cinematic', bass: 'sub-bass', chords: 'strings', pad: 'choir-pad', lead: 'brass-section', arp: 'harp', fx: 'riser' },
    structure: 'cinematic', fx: ['Large hall reverb', 'Impacts and risers', 'Wide stereo strings'],
    tips: ['Ostinato strings drive momentum under sustained brass.', 'Big taiko/tom hits on climaxes.', 'Chromatic mediants (I–bVI) give awe and wonder.'],
  }),
  industrial: G('industrial', 'Industrial', 'industrial', [110, 140], 125, {
    scales: ['phrygian', 'minor', 'locrian'], drumKit: 'industrial', drumStyle: 'industrial', bassStyle: 'metal', chordStyle: 'power',
    progressions: ['industrial-grind', 'metal-tritone', 'drill-phrygian'], melodyStyle: 'riff',
    presets: { drums: 'industrial', bass: 'saw-bass', chords: 'guitar-dist', pad: 'dark-pad', lead: 'hoover', arp: 'arp-saw', fx: 'noise-sweep' },
    structure: 'techno', fx: ['Heavy distortion & bitcrush', 'Metallic convolution reverb', 'Gated noise'],
    tips: ['Metallic, distorted percussion and mechanical repetition.', 'Distorted bass riffs with tritones.', 'Noise as a musical element.'],
  }),
  hardstyle: G('hardstyle', 'Hardstyle', 'hard', [145, 160], 150, {
    scales: ['minor', 'harmonic-minor'], drumKit: 'hardstyle', drumStyle: 'hardstyle', bassStyle: 'hardstyle', chordStyle: 'whole',
    progressions: ['hardstyle-euphoric', 'epic-rise', 'aeolian-loop', 'eurobeat'], melodyStyle: 'hook',
    presets: { drums: 'hardstyle', bass: 'saw-bass', chords: 'supersaw-pad', pad: 'supersaw-pad', lead: 'supersaw-lead', arp: 'arp-saw', fx: 'riser' },
    structure: 'hard', fx: ['Distorted kick with pitch envelope', 'Huge reverb on leads', 'Screeches'],
    tips: ['The kick IS the bass: distorted, pitched tail tuned to the key.', 'Off-beat "reverse bass" fills the gaps between kicks.', 'Euphoric supersaw melodies in the breakdown.'],
  }),
  eurobeat: G('eurobeat', 'Eurobeat', 'retro', [150, 165], 155, {
    scales: ['minor', 'harmonic-minor'], drumKit: '909', drumStyle: 'eurobeat', bassStyle: 'offbeat', chordStyle: 'pulse8',
    progressions: ['eurobeat', 'royal-road', 'kpop-drama', 'epic-rise'], melodyStyle: 'lead', arp: { mode: 'up', rate: 0.25, octaves: 2 },
    presets: { drums: '909', bass: 'saw-bass', chords: 'supersaw-pad', pad: 'fm-brass', lead: 'brass-lead', arp: 'arp-saw', fx: 'riser' },
    structure: 'pop', fx: ['Bright reverb', 'Gated brass stabs'],
    tips: ['Octave-bouncing offbeat bass at 155+ BPM.', 'Synth-brass riffs and dramatic minor melodies.', 'Big pre-chorus builds into the chorus hook.'],
  }),
  footwork: G('footwork', 'Footwork / Juke', 'bass', [155, 165], 160, {
    scales: ['minor', 'dorian'], drumKit: '808', drumStyle: 'footwork', bassStyle: '808', chordStyle: 'stabs',
    progressions: ['footwork-soul', 'house-minor-7', 'trap-two-chord'], melodyStyle: 'riff',
    presets: { drums: '808', bass: '808-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'fm-bell-lead', arp: 'arp-pluck', fx: 'laser' },
    structure: 'hiphop', fx: ['Chopped vocal stutters', 'Short reverbs'],
    tips: ['Polyrhythmic triplet-ish 808 kicks at 160 BPM.', 'Chopped, repeated vocal and soul samples.', 'Sparse harmony, frantic rhythm.'],
  }),
};

/** Normalize an id/name to a GENRES key (or null). */
export function resolveGenreId(id) {
  if (!id) return null;
  if (GENRES[id]) return id;
  const k = String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (GENRES[k]) return k;
  const alias = {
    dnb: 'drum-and-bass', 'drum-n-bass': 'drum-and-bass', ukg: 'uk-garage', garage: 'uk-garage', '2-step': 'two-step', 'hip-hop': 'boom-bap', hiphop: 'boom-bap',
    lofi: 'lofi-hip-hop', 'lo-fi': 'lofi-hip-hop', 'r-b': 'rnb', 'r-and-b': 'rnb', latin: 'salsa', orchestral: 'cinematic', 'k-pop': 'kpop',
    afrobeats: 'afrobeat', juke: 'footwork', 'uk-drill': 'drill', psy: 'psytrance', bossa: 'bossa-nova', edm: 'progressive-house', soul: 'neo-soul',
  };
  if (alias[k]) return alias[k];
  const byName = Object.values(GENRES).find((g) => g.name.toLowerCase() === String(id).toLowerCase());
  return byName ? byName.id : null;
}

export function getGenre(id) {
  return GENRES[resolveGenreId(id)] || null;
}

/** Genres grouped by family: {family: [GenreDef]} */
export function genresByFamily() {
  const out = {};
  for (const g of Object.values(GENRES)) (out[g.family] ||= []).push(g);
  return out;
}
