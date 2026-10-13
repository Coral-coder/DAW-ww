// Sampled drum machine catalog (pure data + mapping, Node-safe).
//
// Samples are the ones Strudel uses: github.com/ritchse/tidal-drum-machines (via Strudel's
// tidal-drum-machines.json, naming `<Machine>_<key>` e.g. RolandTR909_bd) plus a CC0 acoustic
// kit built from the Versilian Community Sample Library (github.com/sgossner/VCSL) with real
// velocity layers and round-robins. See docs/SAMPLES.md for sources and licenses.
//
//   DRUM_MACHINES                 { id: {name, maker, year, tags, kit (synth fallback kit), description} }
//   resolvePadSamples(machine)    { padKey: { variants: [{ layers: [{vmax, urls}], tune, label }], source } }
//   padLoadList(machine, params)  URLs needed to play `params` (variant / roundRobin aware)
//   canonicalBank(name)           'tr909' | 'RolandTR909' | 'rolandtr909' -> 'RolandTR909' (Strudel aliases)
//   strudelBankUrls(machine, key) URLs of Strudel's `<machine>_<key>` sound for embedded machines
//   preferredKitForGenre(genreId) machine id for generated songs
import { MACHINE_FILES, TDM_BASE } from './drum-machines-data.js';
import { normalizeUrl } from './sample-library.js';

export { MACHINE_FILES, TDM_BASE };

const VCSL_BASE = 'https://raw.githubusercontent.com/sgossner/VCSL/master/';

// pad key (DRUM_PADS in core/model.js) -> Strudel/tidal sound key
export const PAD_TO_STRUDEL = {
  kick: 'bd', snare: 'sd', clap: 'cp', rim: 'rim', hihat: 'hh', openhat: 'oh', tomlow: 'lt', tommid: 'mt', tomhigh: 'ht',
  crash: 'cr', ride: 'rd', cowbell: 'cb', tambourine: 'tb', shaker: 'sh', conga: 'perc', clave: 'cl',
};
// Strudel / DAW drum names -> pad key
export const NAME_TO_PAD = {
  bd: 'kick', kick: 'kick', sd: 'snare', sn: 'snare', snare: 'snare', cp: 'clap', clap: 'clap', rim: 'rim', rs: 'rim',
  hh: 'hihat', ch: 'hihat', hat: 'hihat', hihat: 'hihat', oh: 'openhat', openhat: 'openhat', lt: 'tomlow', mt: 'tommid',
  ht: 'tomhigh', tom: 'tommid', cr: 'crash', crash: 'crash', rd: 'ride', ride: 'ride', cb: 'cowbell', cowbell: 'cowbell',
  tb: 'tambourine', tamb: 'tambourine', tambourine: 'tambourine', sh: 'shaker', shaker: 'shaker', perc: 'conga',
  conga: 'conga', cl: 'clave', clave: 'clave',
};

const M = (name, maker, year, kit, tags, description) => ({ name, maker, year, kit, tags, description });
/** Machines offered in the UI (ids = Strudel bank names). */
export const DRUM_MACHINES = {
  RolandTR909: M('Roland TR-909', 'Roland', 1983, '909', ['house', 'techno', 'trance'], 'Half analog, half sampled — the punchy kick, crisp hats and claps that define house and techno.'),
  RolandTR808: M('Roland TR-808', 'Roland', 1980, '808', ['hip-hop', 'trap', 'electro', 'pop'], 'Booming analog kick, snappy snare, cowbell and congas — hip-hop, trap and electro.'),
  RolandTR707: M('Roland TR-707', 'Roland', 1985, 'house', ['house', 'freestyle', 'pop'], 'Clean 80s PCM kit — early Chicago house and freestyle.'),
  RolandTR606: M('Roland TR-606', 'Roland', 1981, 'techno', ['acid', 'techno', 'electro'], 'The Drumatix: thin, clicky analog drums — the TB-303’s partner in acid.'),
  RolandTR626: M('Roland TR-626', 'Roland', 1987, 'house', ['house', 'pop'], 'Late-80s PCM kit with congas, timbales and a shaker.'),
  RolandTR505: M('Roland TR-505', 'Roland', 1986, 'house', ['house', 'lofi'], 'Lo-fi 12-bit PCM kit — gritty and charming.'),
  RolandCompurhythm78: M('Roland CR-78', 'Roland', 1978, 'acoustic', ['disco', 'synthpop', 'downtempo'], 'Warm preset rhythm box (Blondie, Phil Collins) — soft kick, tick-tick hats, guiro and bongos.'),
  RolandCompurhythm1000: M('Roland CR-1000', 'Roland', 1980, 'acoustic', ['disco', 'synthpop'], 'Analog CompuRhythm with a full kit.'),
  RolandCompurhythm8000: M('Roland CR-8000', 'Roland', 1981, 'acoustic', ['synthpop', 'electro'], 'Analog CompuRhythm, a cousin of the 808.'),
  RolandR8: M('Roland R-8', 'Roland', 1989, 'acoustic', ['pop', 'rock', 'new jack'], 'Realistic late-80s PCM kit with lots of variations.'),
  RolandMC303: M('Roland MC-303', 'Roland', 1996, '909', ['house', 'techno', 'big beat'], 'Groovebox with 808/909-style and dance kits.'),
  LinnDrum: M('LinnDrum', 'Linn', 1982, 'breaks', ['synthwave', 'pop', 'funk', 'disco'], 'The 80s pop drum machine — punchy snare, real cymbals, congas.'),
  LinnLM1: M('Linn LM-1', 'Linn', 1980, 'breaks', ['disco', 'funk', 'pop'], 'The first sampled drum machine (Prince, Michael Jackson).'),
  Linn9000: M('Linn 9000', 'Linn', 1984, 'breaks', ['pop', 'funk'], 'Sampling workstation kit, big 80s sound.'),
  OberheimDMX: M('Oberheim DMX', 'Oberheim', 1981, 'breaks', ['hip-hop', 'electro', 'synthwave'], 'Run-DMC and early hip-hop / electro — hard, bright, punchy.'),
  EmuSP12: M('E-mu SP-12', 'E-mu', 1985, 'lofi', ['boom-bap', 'hip-hop'], 'Gritty 12-bit sampler drums — golden-era boom bap.'),
  EmuDrumulator: M('E-mu Drumulator', 'E-mu', 1983, 'breaks', ['synthpop', 'electro'], 'Affordable 80s sampled kit.'),
  AkaiMPC60: M('Akai MPC60', 'Akai', 1988, 'lofi', ['boom-bap', 'hip-hop', 'lofi'], 'Roger Linn’s MPC — warm, swung hip-hop drums.'),
  AkaiXR10: M('Akai XR10', 'Akai', 1988, 'acoustic', ['pop', 'funk'], 'Late-80s PCM kit with lots of variations.'),
  AlesisHR16: M('Alesis HR-16', 'Alesis', 1987, 'acoustic', ['pop', 'industrial', 'rock'], 'Bright 16-bit kit with Latin percussion.'),
  AlesisSR16: M('Alesis SR-16', 'Alesis', 1990, 'rock', ['rock', 'pop', 'metal', 'jazz'], 'Realistic stereo acoustic kits — rock and band demos.'),
  KorgMinipops: M('Korg Mini Pops', 'Korg', 1966, 'acoustic', ['lofi', 'ambient', 'retro'], 'Vintage preset rhythm box (Jean-Michel Jarre) — soft and woody.'),
  KorgKR55: M('Korg KR-55', 'Korg', 1979, 'acoustic', ['disco', 'synthpop'], 'Analog preset rhythm box.'),
  KorgDDM110: M('Korg DDM-110', 'Korg', 1984, 'breaks', ['synthpop', 'electro'], 'Super Drums — cheap 80s PCM, clicky and fun.'),
  KorgM1: M('Korg M1', 'Korg', 1988, 'house', ['house', 'pop'], 'The M1 workstation drums — 90s house and pop.'),
  SequentialCircuitsDrumtracks: M('Sequential Drumtraks', 'Sequential Circuits', 1984, 'breaks', ['synthpop', 'pop'], 'Sequential’s 80s sampled kit.'),
  YamahaRX5: M('Yamaha RX5', 'Yamaha', 1986, 'breaks', ['synthpop', 'industrial'], '80s FM-era sampled kit.'),
  YamahaRX21: M('Yamaha RX21', 'Yamaha', 1985, 'breaks', ['synthpop', 'pop'], 'Compact 80s PCM kit.'),
  YamahaRY30: M('Yamaha RY30', 'Yamaha', 1991, 'acoustic', ['pop', 'rock'], 'Early-90s kit with many variations.'),
  BossDR110: M('Boss DR-110', 'Boss', 1983, 'techno', ['electro', 'acid'], 'Dr. Rhythm Graphic — analog, a pocket 808.'),
  BossDR220: M('Boss DR-220', 'Boss', 1987, 'house', ['house', 'pop'], 'Dr. Rhythm with PCM drums.'),
  BossDR550: M('Boss DR-550', 'Boss', 1989, 'acoustic', ['rock', 'pop'], 'Dr. Rhythm with a big PCM set.'),
  CasioRZ1: M('Casio RZ-1', 'Casio', 1986, 'chip', ['lofi', 'house'], 'Crunchy 8-bit sampler drums.'),
  SimmonsSDS5: M('Simmons SDS-5', 'Simmons', 1981, 'industrial', ['synthwave', 'new wave'], 'The hexagonal electronic drums — huge 80s toms.'),
  RhythmAce: M('Ace Tone Rhythm Ace', 'Ace Tone', 1967, 'acoustic', ['lofi', 'retro', 'ambient'], 'The vintage rhythm box Roland grew out of — soft, vintage, lo-fi.'),
  VCSLAcoustic: M('VCSL Acoustic Kit (CC0)', 'Versilian Studios', 2019, 'acoustic', ['acoustic', 'jazz', 'cinematic', 'folk'], 'Public-domain acoustic percussion with real velocity layers and round-robins.'),
};
export const MACHINE_IDS = Object.keys(DRUM_MACHINES);

// ---------------------------------------------------------------------------- Strudel bank names

// Strudel's tidal-drum-machines-alias.json (machine -> short alias), lets `.bank("TR909")` work.
export const BANK_ALIASES = {
  AJKPercusyn: 'Percysyn', AkaiLinn: 'Linn', AkaiMPC60: 'MPC60', AkaiXR10: 'XR10', AlesisHR16: 'HR16', AlesisSR16: 'SR16',
  BossDR110: 'DR110', BossDR220: 'DR220', BossDR55: 'DR55', BossDR550: 'DR550', CasioRZ1: 'RZ1', CasioSK1: 'SK1', CasioVL1: 'VL1',
  DoepferMS404: 'MS404', EmuDrumulator: 'Drumulator', EmuSP12: 'SP12', KorgDDM110: 'DDM110', KorgKPR77: 'KPR77', KorgKR55: 'KR55',
  KorgKRZ: 'KRZ', KorgM1: 'M1', KorgMinipops: 'Minipops', KorgPoly800: 'Poly800', KorgT3: 'T3', Linn9000: '9000', LinnLM1: 'LM1',
  LinnLM2: 'LM2', MoogConcertMateMG1: 'ConcertMateMG1', OberheimDMX: 'DMX', RhodesPolaris: 'Polaris', RhythmAce: 'Ace',
  RolandCompurhythm1000: 'Compurhythm1000', RolandCompurhythm78: 'Compurhythm78', RolandCompurhythm8000: 'Compurhythm8000',
  RolandD110: 'D110', RolandD70: 'D70', RolandDDR30: 'DDR30', RolandJD990: 'JD990', RolandMC202: 'MC202', RolandMC303: 'MC303',
  RolandMT32: 'MT32', RolandR8: 'R8', RolandS50: 'S50', RolandSH09: 'SH09', RolandSystem100: 'System100', RolandTR505: 'TR505',
  RolandTR606: 'TR606', RolandTR626: 'TR626', RolandTR707: 'TR707', RolandTR727: 'TR727', RolandTR808: 'TR808', RolandTR909: 'TR909',
  SakataDPM48: 'DPM48', SequentialCircuitsDrumtracks: 'CircuitsDrumtracks', SequentialCircuitsTom: 'CircuitsTom',
  SimmonsSDS400: 'SDS400', SimmonsSDS5: 'SDS5', SoundmastersR88: 'R88', UnivoxMicroRhythmer12: 'MicroRhythmer12',
  ViscoSpaceDrum: 'SpaceDrum', XdrumLM8953: 'LM8953', YamahaRM50: 'RM50', YamahaRX21: 'RX21', YamahaRX5: 'RX5', YamahaRY30: 'RY30',
  YamahaTG33: 'TG33',
};
// every machine in the full collection (not only the embedded ones) — for name parsing
export const ALL_TDM_MACHINES = [...new Set([...Object.keys(BANK_ALIASES), 'EmuModular', 'MFB512', 'MPC1000', 'SergeModular', 'LinnDrum'])];
const BANK_LOOKUP = new Map();
for (const m of ALL_TDM_MACHINES) BANK_LOOKUP.set(m.toLowerCase(), m);
for (const [m, a] of Object.entries(BANK_ALIASES)) BANK_LOOKUP.set(a.toLowerCase(), m);
for (const m of MACHINE_IDS) BANK_LOOKUP.set(m.toLowerCase(), m);
// friendly extras
for (const [a, m] of Object.entries({ '909': 'RolandTR909', '808': 'RolandTR808', '707': 'RolandTR707', '606': 'RolandTR606', cr78: 'RolandCompurhythm78', 'cr-78': 'RolandCompurhythm78', linn: 'LinnDrum', linndrum: 'LinnDrum', lm1: 'LinnLM1', dmx: 'OberheimDMX', sp12: 'EmuSP12', 'sp-1200': 'EmuSP12', sp1200: 'EmuSP12', mpc: 'AkaiMPC60', mpc60: 'AkaiMPC60', minipops: 'KorgMinipops', drumtraks: 'SequentialCircuitsDrumtracks', vcsl: 'VCSLAcoustic' })) BANK_LOOKUP.set(a, m);

/** Strudel bank name (any case, alias or full) -> canonical machine id, or null. */
export function canonicalBank(name) {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
  return k ? BANK_LOOKUP.get(k) || null : null;
}
/** Split a Strudel sound name like 'RolandTR909_bd' / 'tr909_bd' -> { machine, key } or null. */
export function splitBankSound(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('_');
  if (i <= 0) return null;
  const machine = canonicalBank(s.slice(0, i));
  return machine ? { machine, key: s.slice(i + 1).toLowerCase() } : null;
}

// ---------------------------------------------------------------------------- file URLs

/** Full URL of a tidal-drum-machines file of the embedded catalog. */
export function machineFileUrl(machine, key, file) {
  const rel = file.startsWith('/') ? file.slice(1) : `${machine}/${machine.toLowerCase()}-${key}/${file}`;
  return normalizeUrl(TDM_BASE + rel);
}
/** URLs of Strudel's `<machine>_<key>` sound (embedded machines only; null if unknown). */
export function strudelBankUrls(machine, key) {
  const files = MACHINE_FILES[machine]?.[key];
  return files ? files.map((f) => machineFileUrl(machine, key, f)) : null;
}

// ---------------------------------------------------------------------------- pad mapping

// preferred default file per pad (substring of the file name) — "the classic sound" of the machine
const DEFAULT_PICK = {
  RolandTR808: { bd: 'BD2550', sd: 'SD2550', cr: 'CY5050', oh: 'OH25', lt: 'LT25', mt: 'MT25', ht: 'HT25', cp: 'CP' },
  EmuSP12: { bd: 'Bassdrum-03', sd: 'Snaredrum-05' },
  AkaiMPC60: { bd: '0 Bassdrum' },
};
const CONGA_RE = /conga|tumba|quinto|^[hml]c\d|bongo/i;
const CLAVE_RE = /clave|^cl\.|^cl\b|wood ?block|woodblock|click/i;
const base = (u) => decodeURIComponent(String(u).split('/').pop() || '');

// fallback chains: [sourceKey, tune(semitones), filter(file)] — tried in order within the machine
const RULES = {
  kick: [['bd']],
  snare: [['sd']],
  clap: [['cp']],
  rim: [['rim']],
  hihat: [['hh']],
  openhat: [['oh'], ['hh', 0, null, 3]], // 4th = decay multiplier hint (closed hat let ring)
  tomlow: [['lt'], ['mt', -3], ['ht', -7]],
  tommid: [['mt'], ['lt', 3], ['ht', -3]],
  tomhigh: [['ht'], ['mt', 3], ['lt', 7]],
  crash: [['cr'], ['rd']],
  ride: [['rd'], ['cr', 0, null, 0.6]],
  cowbell: [['cb']],
  tambourine: [['tb'], ['sh']],
  shaker: [['sh'], ['tb']],
  conga: [['perc', 0, CONGA_RE], ['misc', 0, CONGA_RE], ['perc'], ['misc']],
  clave: [['cl'], ['perc', 0, CLAVE_RE], ['misc', 0, CLAVE_RE], ['rim', 5]],
};
// machines used to fill pads a machine doesn't have (in order)
const COMPANIONS = ['RolandTR808', 'LinnDrum', 'RolandTR707', 'RolandTR909'];

function tdmVariants(machine, padKey) {
  const pads = MACHINE_FILES[machine];
  if (!pads) return null;
  for (const [key, tune = 0, filter = null, decay = 1] of RULES[padKey] || []) {
    let files = pads[key];
    if (!files?.length) continue;
    if (filter) {
      files = files.filter((f) => filter.test(base(f)));
      if (!files.length) continue;
      if (padKey === 'conga') { // prefer real congas over bongos/timbales
        const c = files.filter((f) => /conga|^[hml]c\d/i.test(base(f)));
        if (c.length) files = [...c, ...files.filter((f) => !c.includes(f))];
      }
    }
    const urls = files.map((f) => machineFileUrl(machine, key, f));
    const pick = DEFAULT_PICK[machine]?.[key];
    let start = pick ? urls.findIndex((u) => base(u).includes(pick)) : 0;
    if (start < 0) start = 0;
    const rotated = [...urls.slice(start), ...urls.slice(0, start)];
    return {
      key,
      variants: rotated.map((u) => ({ layers: [{ vmax: 1, urls: [u] }], tune, decay, label: base(u).replace(/\.wav$/i, '') })),
    };
  }
  return null;
}

// ---- CC0 acoustic kit from VCSL (velocity layers × round robins)
const V = (dir, files) => files.map((f) => normalizeUrl(VCSL_BASE + dir + '/' + f));
const vl = (vmax, dir, files) => ({ vmax, urls: V(dir, files) });
const BD = 'Membranophones/Struck Membranophones/Bass Drum 1';
const SN = 'Membranophones/Struck Membranophones/Snare Drum, Modern 1';
const RS = 'Membranophones/Struck Membranophones/Snare Drum, Rope Tension';
const HH = 'Idiophones/Struck Idiophones/Hi-Hat Cymbal';
const T1 = 'Membranophones/Struck Membranophones/Tom 1/Stick';
const T2 = 'Membranophones/Struck Membranophones/Tom 2/Stick';
const C1 = 'Idiophones/Struck Idiophones/Suspended Cymbal 1';
const C2 = 'Idiophones/Struck Idiophones/Suspended Cymbal 2';
const rr = (stem, v, n = 2, suf = '_Mid.wav') => Array.from({ length: n }, (_, i) => `${stem}_v${v}_rr${i + 1}${suf}`);
const VCSL_KIT = {
  kick: [{ layers: [vl(0.45, BD, rr('BDrumNew_hit', 3, 2, '_Sum.wav')), vl(0.8, BD, rr('BDrumNew_hit', 5, 2, '_Sum.wav')), vl(1, BD, rr('BDrumNew_hit', 7, 2, '_Sum.wav'))], label: 'Bass drum' }],
  snare: [{ layers: [vl(0.4, SN, rr('Snare2_HitSN', 3)), vl(0.7, SN, rr('Snare2_HitSN', 5)), vl(0.9, SN, rr('Snare2_HitSN', 7)), vl(1, SN, rr('Snare2_HitSN', 9))], label: 'Snare' }],
  rim: [{ layers: [vl(1, RS, ['RopeSnare_sidestick_Main_vl2_rr1.wav', 'RopeSnare_sidestick_Main_vl2_rr2.wav'])], label: 'Side stick' }],
  hihat: [{ layers: [vl(0.35, HH, rr('HiHat_HitC', 1)), vl(0.6, HH, rr('HiHat_HitC', 2)), vl(0.85, HH, rr('HiHat_HitC', 3)), vl(1, HH, rr('HiHat_HitC', 4))], label: 'Closed hat' }],
  openhat: [{ layers: [vl(1, HH, ['HiHat_HitO_rr1_Mid.wav', 'HiHat_HitO_rr2_Mid.wav'])], label: 'Open hat' }],
  tomlow: [{ layers: [vl(0.6, T2, rr('TomL_HitS', 2)), vl(1, T2, rr('TomL_HitS', 4))], label: 'Low tom' }],
  tommid: [{ layers: [vl(0.6, T2, rr('TomL_HitS', 2)), vl(1, T2, rr('TomL_HitS', 4))], tune: 4, label: 'Mid tom' }],
  tomhigh: [{ layers: [vl(0.6, T1, rr('TomH_HitS', 2)), vl(1, T1, rr('TomH_HitS', 4))], label: 'High tom' }],
  crash: [{ layers: [vl(0.5, C2, ['susCymb2_hit_mp1.wav']), vl(0.8, C2, ['susCymb2_hit_mf1.wav']), vl(1, C2, ['susCymb2_hit_f1.wav'])], label: 'Crash' }],
  ride: [{ layers: [vl(0.5, C1, ['susCymb1_hit_stick_pp1.wav']), vl(0.8, C1, ['susCymb1_hit_stick_mp1.wav']), vl(1, C1, ['susCymb1_hit_stick_f1.wav'])], label: 'Ride (stick)' }],
  cowbell: [{ layers: [vl(0.6, 'Idiophones/Struck Idiophones/Cowbells', ['Cowbell1_Normal_v2_rr1_Mid.wav']), vl(1, 'Idiophones/Struck Idiophones/Cowbells', ['Cowbell1_Normal_v3_rr1_Mid.wav'])], label: 'Cowbell' }],
  tambourine: [{ layers: [vl(0.6, 'Idiophones/Struck Idiophones/Tambourine 1', ['Tamb1_Hit_v1_rr1_Mid.wav']), vl(1, 'Idiophones/Struck Idiophones/Tambourine 1', ['Tamb1_Hit_v2_rr1_Mid.wav'])], label: 'Tambourine' }],
  shaker: [{ layers: [vl(1, 'Idiophones/Struck Idiophones/Shaker, Small', ['Mid_Shaker_Slap_rr1.wav', 'Mid_Shaker_Slap_rr2.wav'])], label: 'Shaker' }],
  conga: [{ layers: [vl(0.6, 'Membranophones/Struck Membranophones/Conga', ['Conga_HitN_v1_rr1_Sum.wav', 'Conga_HitN_v1_rr2_Sum.wav']), vl(1, 'Membranophones/Struck Membranophones/Conga', ['Conga_HitN_v3_rr1_Sum.wav', 'Conga_HitN_v3_rr2_Sum.wav'])], label: 'Conga' }],
  clave: [{ layers: [vl(0.5, 'Idiophones/Struck Idiophones/Claves', ['Claves1_Hit_v1_rr1_Mid.wav']), vl(0.8, 'Idiophones/Struck Idiophones/Claves', ['Claves1_Hit_v2_rr1_Mid.wav']), vl(1, 'Idiophones/Struck Idiophones/Claves', ['Claves1_Hit_v3_rr1_Mid.wav'])], label: 'Claves' }],
  clap: [{ layers: [vl(1, 'Idiophones/Struck Idiophones/Claps', ['Clap_rr1.wav', 'Clap_rr2.wav', 'Clap_rr3.wav', 'Clap_rr4.wav'])], label: 'Claps' }],
};

const resolvedCache = new Map();
/**
 * Per-pad sample plan for a machine:
 *   { padKey: { source: 'machine'|'companion', machine, key, variants: [{ layers:[{vmax, urls}], tune, decay, label }] } }
 * Pads no machine can fill are absent (the synthesized kit voice plays them).
 */
export function resolvePadSamples(machineId) {
  const id = canonicalBank(machineId) || machineId;
  if (resolvedCache.has(id)) return resolvedCache.get(id);
  const out = {};
  if (id === 'VCSLAcoustic') {
    for (const [pad, variants] of Object.entries(VCSL_KIT)) out[pad] = { source: 'machine', machine: id, key: pad, variants: variants.map((v) => ({ tune: 0, decay: 1, ...v })) };
  } else if (MACHINE_FILES[id]) {
    for (const pad of Object.keys(PAD_TO_STRUDEL)) {
      let r = tdmVariants(id, pad);
      let source = 'machine', from = id;
      if (!r) {
        for (const c of COMPANIONS) {
          if (c === id) continue;
          r = tdmVariants(c, pad);
          if (r) { source = 'companion'; from = c; break; }
        }
      }
      if (r) out[pad] = { source, machine: from, key: r.key, variants: r.variants };
    }
  }
  resolvedCache.set(id, out);
  return out;
}

/** Variant entry a pad plays for params (pad.variant / roundRobin counter). */
export function padVariant(plan, padParams = {}, rrCounter = 0, roundRobin = false) {
  if (!plan?.variants?.length) return null;
  const n = plan.variants.length;
  const v = Math.round(Number(padParams.variant) || 0);
  const i = roundRobin ? (((v + rrCounter) % n) + n) % n : ((v % n) + n) % n;
  return plan.variants[i];
}
/** Velocity layer of a variant for vel 0..1. */
export function pickLayer(variant, vel) {
  const layers = variant?.layers || [];
  for (const L of layers) if (vel <= L.vmax + 1e-9) return L;
  return layers[layers.length - 1] || null;
}

/** URLs to fetch so `params` ({machine, roundRobin, pads}) plays fully. */
export function padLoadList(machineId, params = {}) {
  const plan = resolvePadSamples(machineId);
  const urls = [];
  for (const [pad, p] of Object.entries(plan)) {
    const pp = params.pads?.[pad] || {};
    if (pp.mute) continue;
    const variants = params.roundRobin ? p.variants.slice(0, 8) : [padVariant(p, pp)];
    for (const v of variants) for (const L of v?.layers || []) urls.push(...L.urls);
  }
  return [...new Set(urls)];
}

// ---------------------------------------------------------------------------- genres

const GENRE_MACHINE = {
  house: 'RolandTR909', 'deep-house': 'RolandTR909', 'tech-house': 'RolandTR909', techno: 'RolandTR909', minimal: 'RolandTR909',
  trance: 'RolandTR909', psytrance: 'RolandTR909', 'progressive-house': 'RolandTR909', hardstyle: 'RolandTR909', 'nu-disco': 'RolandTR909',
  eurobeat: 'RolandTR909', kpop: 'RolandTR909', idm: 'RolandTR909', glitch: 'RolandTR606', industrial: 'YamahaRX5', 'acid': 'RolandTR606',
  dubstep: 'RolandTR808', brostep: 'RolandTR808', 'future-bass': 'RolandTR808', trap: 'RolandTR808', drill: 'RolandTR808',
  rnb: 'RolandTR808', pop: 'RolandTR808', footwork: 'RolandTR808', dancehall: 'RolandTR808', reggaeton: 'RolandTR808',
  phonk: 'RolandTR808', afrobeat: 'RolandTR808', amapiano: 'RolandTR909',
  'boom-bap': 'EmuSP12', 'lofi-hip-hop': 'AkaiMPC60', 'trip-hop': 'AkaiMPC60', downtempo: 'AkaiMPC60', 'neo-soul': 'AkaiMPC60',
  'drum-and-bass': 'AkaiMPC60', 'liquid-dnb': 'AkaiMPC60', jungle: 'EmuSP12', breakbeat: 'OberheimDMX', 'uk-garage': 'RolandTR909', 'two-step': 'RolandTR909',
  synthwave: 'LinnDrum', chillwave: 'LinnDrum', disco: 'RolandCompurhythm78', funk: 'LinnLM1', gospel: 'LinnDrum',
  chiptune: 'CasioRZ1', rock: 'AlesisSR16', punk: 'AlesisSR16', metal: 'AlesisSR16', indie: 'AlesisSR16', country: 'AlesisSR16',
  blues: 'AlesisSR16', jazz: 'VCSLAcoustic', folk: 'VCSLAcoustic', cinematic: 'VCSLAcoustic', ambient: 'KorgMinipops',
  'bossa-nova': 'RolandCompurhythm78', salsa: 'AlesisHR16', reggae: 'LinnDrum', dub: 'LinnDrum',
};
const FAMILY_MACHINE = {
  house: 'RolandTR909', techno: 'RolandTR909', trance: 'RolandTR909', bass: 'RolandTR808', dnb: 'AkaiMPC60', breaks: 'OberheimDMX',
  garage: 'RolandTR909', hiphop: 'RolandTR808', soul: 'AkaiMPC60', pop: 'RolandTR808', retro: 'LinnDrum', ambient: 'KorgMinipops',
  chill: 'AkaiMPC60', experimental: 'RolandTR909', rock: 'AlesisSR16', funk: 'LinnLM1', jazz: 'VCSLAcoustic', latin: 'AlesisHR16',
  blues: 'AlesisSR16', caribbean: 'LinnDrum', african: 'RolandTR808', americana: 'AlesisSR16', cinematic: 'VCSLAcoustic',
  industrial: 'YamahaRX5', hard: 'RolandTR909',
};

/** Sampled drum machine for a genre id (optionally a family fallback). Always returns a machine id. */
export function preferredKitForGenre(genreId, family) {
  const g = String(genreId || '').toLowerCase();
  return GENRE_MACHINE[g] || FAMILY_MACHINE[String(family || '').toLowerCase()] || 'RolandTR909';
}

/**
 * Instrument def for a generated drum track: a regular 'drums' instrument (so every drum view —
 * step rack, piano roll drum lanes, generators — keeps working) that plays the sampled machine and
 * falls back to the synthesized `kit` when samples can't load.
 */
export function drumInstrumentForGenre(genreId, { kit, family } = {}) {
  const machine = preferredKitForGenre(genreId, family);
  const k = kit || DRUM_MACHINES[machine]?.kit || '808';
  return { type: 'drums', preset: k, params: { kit: k, machine } };
}

// ---------------------------------------------------------------------------- params (UI metadata)

const numP = (key, label, min, max, def, o = {}) => ({
  key, label, type: 'number', min, max, step: o.step ?? 0.01, default: def, unit: o.unit, curve: o.curve || 'lin', section: o.section || 'Kit', advanced: !!o.adv,
});
const sortedMachines = () => MACHINE_IDS.map((id) => ({ value: id, label: `${DRUM_MACHINES[id].name}${DRUM_MACHINES[id].year ? ` (${DRUM_MACHINES[id].year})` : ''}` }));
/** enum options for a machine picker; withOff adds '' = synthesized kit. */
export function machineOptions(withOff = false) {
  return [...(withOff ? [{ value: '', label: 'Off — synthesized kit' }] : []), ...sortedMachines()];
}
/** `machine` param for the synthesized 'drums' instrument ('' = off). */
export const DRUMS_MACHINE_PARAM = { key: 'machine', label: 'Sampled machine', type: 'enum', options: machineOptions(true), default: '', section: 'Kit', advanced: false };
/** extra drums params used when a machine is active (ignored by the synth engine). */
export const SAMPLED_DRUM_EXTRA_PARAMS = [
  { key: 'roundRobin', label: 'Round robin', type: 'bool', default: false, section: 'Kit', advanced: true },
  numP('humanize', 'Humanize', 0, 1, 0.2, { adv: true }),
];
/** per-pad sample variation (index into the machine's variants for that pad). */
export const PAD_VARIANT_PARAM = numP('variant', 'Variation', 0, 24, 0, { step: 1, section: 'Pad', adv: true });

/**
 * Params of the 'drumsampler' instrument type. `kitOptions` = [{value,label}] of synthesized kits
 * (fallback when samples can't load) — passed in by defs.js to avoid an import cycle.
 */
export function drumSamplerParams(kitOptions = [{ value: '909', label: '909' }]) {
  return [
    { key: 'machine', label: 'Machine', type: 'enum', options: machineOptions(false), default: 'RolandTR909', section: 'Kit', advanced: false },
    numP('pitch', 'Pitch', -24, 24, 0, { step: 0.1, unit: 'st' }),
    numP('decay', 'Decay', 0.1, 4, 1, { unit: '×', curve: 'exp' }),
    numP('tone', 'Tone', -1, 1, 0),
    ...SAMPLED_DRUM_EXTRA_PARAMS,
    { key: 'kit', label: 'Fallback kit', type: 'enum', options: kitOptions, default: kitOptions.some((o) => o.value === '909') ? '909' : kitOptions[0].value, section: 'Kit', advanced: true },
    numP('drive', 'Drive', 0, 1, 0, { section: 'Output' }),
    numP('gain', 'Volume', 0, 2, 0.8, { section: 'Output' }),
  ];
}

// ---------------------------------------------------------------------------- preview grooves

/** A one-bar preview groove (GM pitches, beats) suited to the machine — for the browser. */
export function previewGroove(machineId) {
  const id = canonicalBank(machineId) || machineId;
  const tags = DRUM_MACHINES[id]?.tags || [];
  const n = (pitch, start, vel = 0.9) => ({ pitch, start, dur: 0.25, vel });
  const hats = (pitch = 42, step = 0.5, off = 0) => Array.from({ length: Math.round(4 / step) }, (_, i) => n(pitch, off + i * step, i % 2 ? 0.55 : 0.75));
  if (tags.some((t) => /hip-hop|boom|lofi|trap/.test(t))) {
    return [n(36, 0), n(36, 1.75, 0.8), n(36, 2.5), n(38, 1), n(38, 3), ...hats(42, 0.5)];
  }
  if (tags.some((t) => /house|techno|trance|acid/.test(t))) {
    return [n(36, 0), n(36, 1), n(36, 2), n(36, 3), n(39, 1, 0.8), n(39, 3, 0.8), ...hats(46, 1, 0.5), ...hats(42, 0.25).filter((x) => x.start % 1 !== 0.5)];
  }
  if (tags.some((t) => /rock|metal|pop|jazz|acoustic|folk|cinematic/.test(t))) {
    return [n(36, 0), n(36, 2.5, 0.8), n(38, 1), n(38, 3), ...hats(42, 0.5), n(49, 0, 0.7)];
  }
  return [n(36, 0), n(36, 2), n(38, 1), n(38, 3), ...hats(42, 0.5), n(63, 3.5, 0.6), n(56, 2.75, 0.6)];
}
