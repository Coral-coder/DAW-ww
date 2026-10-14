// Curated catalog of open-source plugins (pure data, Node-safe).
// Entry: { id, name, kind:'soundfont'|'faust'|'wam', type:'instrument'|'effect', category, description,
//          author, license, source:{url}|{code}|{library, instrument}, homepage, experimental?, tags? }
import { FAUST_INSTRUMENTS, FAUST_EFFECTS } from './faust-library.js';
import { gmLabel, gmFamily, soundfontUrl, SOUNDFONT_LIBRARIES } from './gm.js';

export const KIND_LABELS = { soundfont: 'SoundFont', faust: 'Faust', wam: 'Web Audio Module' };

const SF_HOME = 'https://github.com/gleitz/midi-js-soundfonts';
const FAUST_HOME = 'https://faust.grame.fr';
const WAM_VERSION = '0.4.9';
const WAM_BASE = `https://cdn.jsdelivr.net/npm/wam-community@${WAM_VERSION}/dist/plugins/`;
const WAM_HOME = 'https://github.com/boourns/wam-community';

// [instrument id, library, description]
const SOUNDFONTS = [
  ['acoustic_grand_piano', 'FluidR3_GM', 'Concert grand, full 88-key multisample.'],
  ['acoustic_grand_piano', 'MusyngKite', 'Richer grand piano from the Musyng Kite set (bigger download).'],
  ['bright_acoustic_piano', 'FluidR3_GM', 'Brighter upright-style piano that cuts through a mix.'],
  ['electric_piano_1', 'FluidR3_GM', 'Rhodes-style tine electric piano.'],
  ['electric_piano_2', 'FluidR3_GM', 'DX-style FM electric piano.'],
  ['harpsichord', 'FluidR3_GM', 'Baroque plucked keyboard.'],
  ['clavinet', 'FluidR3_GM', 'Funky Clavinet for rhythm parts.'],
  ['vibraphone', 'FluidR3_GM', 'Vibraphone with soft mallets.'],
  ['marimba', 'FluidR3_GM', 'Warm wooden marimba.'],
  ['celesta', 'FluidR3_GM', 'Sparkling celesta.'],
  ['music_box', 'FluidR3_GM', 'Delicate music box.'],
  ['tubular_bells', 'FluidR3_GM', 'Orchestral chimes.'],
  ['drawbar_organ', 'FluidR3_GM', 'Classic drawbar organ.'],
  ['rock_organ', 'FluidR3_GM', 'Overdriven rock organ.'],
  ['church_organ', 'FluidR3_GM', 'Pipe organ with full stops.'],
  ['accordion', 'FluidR3_GM', 'French musette accordion.'],
  ['harmonica', 'FluidR3_GM', 'Blues harmonica.'],
  ['acoustic_guitar_nylon', 'FluidR3_GM', 'Classical nylon-string guitar.'],
  ['acoustic_guitar_steel', 'FluidR3_GM', 'Steel-string acoustic guitar.'],
  ['electric_guitar_clean', 'FluidR3_GM', 'Clean electric guitar.'],
  ['electric_guitar_jazz', 'FluidR3_GM', 'Mellow jazz guitar.'],
  ['overdriven_guitar', 'FluidR3_GM', 'Crunchy overdriven guitar.'],
  ['distortion_guitar', 'FluidR3_GM', 'High-gain distortion guitar.'],
  ['acoustic_bass', 'FluidR3_GM', 'Upright double bass (pizzicato).'],
  ['electric_bass_finger', 'FluidR3_GM', 'Fingered electric bass.'],
  ['fretless_bass', 'FluidR3_GM', 'Singing fretless bass.'],
  ['slap_bass_1', 'FluidR3_GM', 'Slap bass for funk lines.'],
  ['synth_bass_1', 'FluidR3_GM', 'Analog-style synth bass.'],
  ['violin', 'FluidR3_GM', 'Solo violin.'],
  ['cello', 'FluidR3_GM', 'Solo cello.'],
  ['string_ensemble_1', 'FluidR3_GM', 'Lush string section.'],
  ['string_ensemble_1', 'MusyngKite', 'Large string section from the Musyng Kite set.'],
  ['pizzicato_strings', 'FluidR3_GM', 'Plucked string section.'],
  ['orchestral_harp', 'FluidR3_GM', 'Concert harp.'],
  ['timpani', 'FluidR3_GM', 'Orchestral timpani.'],
  ['choir_aahs', 'FluidR3_GM', 'Choir singing “aah”.'],
  ['voice_oohs', 'FluidR3_GM', 'Soft “ooh” vocal pad.'],
  ['trumpet', 'FluidR3_GM', 'Solo trumpet.'],
  ['trombone', 'FluidR3_GM', 'Solo trombone.'],
  ['french_horn', 'FluidR3_GM', 'Warm French horn.'],
  ['brass_section', 'FluidR3_GM', 'Punchy brass section.'],
  ['alto_sax', 'FluidR3_GM', 'Alto saxophone.'],
  ['tenor_sax', 'FluidR3_GM', 'Tenor saxophone.'],
  ['oboe', 'FluidR3_GM', 'Oboe.'],
  ['clarinet', 'FluidR3_GM', 'Clarinet.'],
  ['flute', 'FluidR3_GM', 'Concert flute.'],
  ['pan_flute', 'FluidR3_GM', 'Breathy pan flute.'],
  ['shakuhachi', 'FluidR3_GM', 'Japanese bamboo flute.'],
  ['lead_1_square', 'FluidR3_GM', 'Square-wave lead.'],
  ['lead_2_sawtooth', 'FluidR3_GM', 'Sawtooth lead.'],
  ['pad_2_warm', 'FluidR3_GM', 'Warm analog pad.'],
  ['pad_3_polysynth', 'FluidR3_GM', 'Polysynth pad.'],
  ['pad_7_halo', 'FluidR3_GM', 'Airy halo pad.'],
  ['fx_4_atmosphere', 'FluidR3_GM', 'Atmospheric texture.'],
  ['sitar', 'FluidR3_GM', 'Indian sitar.'],
  ['koto', 'FluidR3_GM', 'Japanese koto.'],
  ['kalimba', 'FluidR3_GM', 'African thumb piano.'],
  ['steel_drums', 'FluidR3_GM', 'Caribbean steel pan.'],
  ['taiko_drum', 'FluidR3_GM', 'Japanese taiko drum (pitched).'],
  ['acoustic_grand_piano', 'FatBoy', 'Characterful grand piano from the FatBoy set.'],
];

const sfEntries = SOUNDFONTS.map(([instrument, library, description]) => ({
  id: `sf-${library === 'FluidR3_GM' ? '' : library.toLowerCase() + '-'}${instrument.replace(/_/g, '-')}`,
  name: library === 'FluidR3_GM' ? gmLabel(instrument) : `${gmLabel(instrument)} (${SOUNDFONT_LIBRARIES[library].name})`,
  kind: 'soundfont',
  type: 'instrument',
  category: gmFamily(instrument),
  description,
  author: SOUNDFONT_LIBRARIES[library].author,
  license: SOUNDFONT_LIBRARIES[library].license,
  source: { library, instrument, url: soundfontUrl(library, instrument) },
  homepage: SF_HOME,
}));

const FAUST_CATS = {
  'va-poly': 'Synth', supersaw: 'Synth', pluck: 'Physical model', 'modal-bell': 'Physical model',
  flute: 'Physical model', clarinet: 'Physical model', organ: 'Organ', 'warm-pad': 'Synth',
  'zita-reverb': 'Reverb', 'moog-ladder': 'Filter', phaser: 'Modulation', compressor: 'Dynamics',
  freeverb: 'Reverb', 'tape-echo': 'Delay',
};
const faustEntry = (type) => ([id, p]) => ({
  id: `faust-${id}`,
  name: p.name,
  kind: 'faust',
  type,
  category: FAUST_CATS[id] || (type === 'effect' ? 'Effect' : 'Synth'),
  description: p.description,
  author: 'daW³ · Faust libraries (GRAME)',
  license: 'MIT / Faust libraries (LGPL-with-exception, STK)',
  source: { code: p.code },
  homepage: FAUST_HOME,
});

// [path, name, type, category, description, author]
const WAMS = [
  ['burns-audio/synth101/index.js', 'Synth-101', 'instrument', 'Synth', 'Monophonic SH-101 style synthesizer with its own panel GUI.', 'Sequencer Party (Tom Burns)'],
  ['burns-audio/modal/index.js', 'Spectrum: Modal', 'instrument', 'Physical model', 'Modal resonator synthesizer (port of Mutable Instruments Elements ideas).', 'Sequencer Party (Tom Burns)'],
  ['burns-audio/drumsampler/index.js', 'DRM-16 DrumComputer', 'instrument', 'Drums', 'Sample-based drum computer (MIDI notes trigger pads).', 'Sequencer Party (Tom Burns)'],
  ['wimmics/greyhole/index.js', 'Grey Hole', 'effect', 'Reverb', 'Huge diffuse “Blackhole”-style reverb (Faust, Julian Parker).', 'Wimmics (Michel Buffa)'],
  ['wimmics/kbverb/index.js', 'KBVerb', 'effect', 'Reverb', 'Plate-style reverb.', 'Wimmics'],
  ['wimmics/pingpongdelay/dist/index.js', 'PingPongDelay', 'effect', 'Delay', 'Stereo ping-pong delay with feedback and mix.', 'Wimmics (Michel Buffa)'],
  ['wimmics/stonephaser/index.js', 'StonePhaser', 'effect', 'Modulation', 'Small Stone style phaser.', 'Wimmics'],
  ['wimmics/ThruZeroFlanger/index.js', 'ThruZeroFlanger', 'effect', 'Modulation', 'Through-zero tape flanger.', 'Wimmics'],
  ['wimmics/BigMuff/index.js', 'Big Muff', 'effect', 'Distortion', 'Fuzz pedal emulation.', 'Wimmics'],
  ['wimmics/TS9_Overdrive/index.js', 'TS9 Overdrive', 'effect', 'Distortion', 'Tube-Screamer style overdrive.', 'Wimmics'],
  ['wimmics/graphicEqualizer/index.js', 'Graphic Equalizer', 'effect', 'EQ', 'Multi-band graphic EQ with spectrum display.', 'Wimmics'],
];

const wamEntries = WAMS.map(([path, name, type, category, description, author]) => ({
  id: `wam-${path.split('/')[1].toLowerCase()}`,
  name,
  kind: 'wam',
  type,
  category,
  description,
  author,
  license: 'Open source (see the plugin repository)',
  source: { url: WAM_BASE + path },
  homepage: WAM_HOME,
  experimental: true,
}));

export const CATALOG = [
  ...Object.entries(FAUST_INSTRUMENTS).map(faustEntry('instrument')),
  ...Object.entries(FAUST_EFFECTS).map(faustEntry('effect')),
  ...sfEntries,
  ...wamEntries,
];

/** Categories in catalog order (optionally for one kind / type). */
/**
 * Native plugins (Mac app): replace the catalog's 'native' entries with this list (from the
 * plugin database, src/native/plugin-db.js catalogEntries). The kind only appears once registered.
 */
export function setNativeEntries(entries = []) {
  for (let i = CATALOG.length - 1; i >= 0; i--) if (CATALOG[i].kind === 'native') CATALOG.splice(i, 1);
  CATALOG.unshift(...entries);
  if (entries.length) KIND_LABELS.native = 'Native (VST3 / AU / CLAP)';
  else delete KIND_LABELS.native;
}

export function catalogCategories(filter = {}) {
  const out = [];
  for (const e of CATALOG) {
    if (filter.kind && e.kind !== filter.kind) continue;
    if (filter.type && e.type !== filter.type) continue;
    if (!out.includes(e.category)) out.push(e.category);
  }
  return out;
}

/** searchCatalog({query, kind, type, category}) -> entries matching every given filter. */
export function searchCatalog({ query = '', kind = '', type = '', category = '' } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return CATALOG.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (type && e.type !== type) return false;
    if (category && e.category !== category) return false;
    if (!words.length) return true;
    const hay = `${e.name} ${e.category} ${e.description} ${e.author} ${KIND_LABELS[e.kind]} ${e.source?.instrument || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function getCatalogEntry(id) { return CATALOG.find((e) => e.id === id) || null; }

/**
 * Project Instrument / Effect JSON for a catalog entry (or a detected link):
 *  soundfont -> { type:'soundfont', preset:null, params:{ library, instrument, url? } }
 *  faust     -> { type:'faust', params:{ name, code, url? } }
 *  wam       -> { type:'wam', params:{ name, url } }
 * For effects the same params go into an Effect { type, params }.
 */
export function pluginParams(entry) {
  const s = entry.source || {};
  if (entry.kind === 'soundfont') {
    if (s.library && s.instrument) return { library: s.library, instrument: s.instrument, url: '' };
    return { url: s.url || '', name: entry.name };
  }
  if (entry.kind === 'faust') return { name: entry.name, code: s.code || '', url: s.url || '' };
  return { name: entry.name, url: s.url || '' };
}
