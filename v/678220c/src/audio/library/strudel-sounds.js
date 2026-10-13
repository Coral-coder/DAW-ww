// Strudel sound-name resolution against the same sample collections strudel.cc uses.
//
//   resolveSample(value, {name, index}) -> { url, transpose, tune, decay, index, key } | { pending: Promise } | null
//     value = event value ({s, bank, n, note, freq, gain, velocity, ...}); name/index = `s` split on ':'.
//     null means "not a sample" (synth waveform / preset / unknown) — callers keep their synthesized path.
//
// Resolution (Strudel semantics where Strudel defines them, sensible fallbacks otherwise):
//   1. `.bank("RolandTR909")` (or alias "TR909") + `s("bd")`  -> tidal-drum-machines `RolandTR909_bd`, sample n
//      — when the machine has no such sound, or `s` is a DAW drum name (kick, snare, clap…), the drum-machine
//      pad mapping with its fallback rules is used instead (so `.bank("RolandTR606").s("cp")` still claps).
//   2. `s("RolandTR909_bd")` / `s("tr909_bd")`                -> same as 1.
//   3. sounds registered from loaded sample maps (piano, `registerSamples()` maps).
//   4. bare Dirt-Samples names (bd, sd, hh, cp, casio, jazz, metal, east, crow, insect, wind, jvbass, …)
//      -> github.com/tidalcycles/Dirt-Samples (what `samples('github:tidalcycles/dirt-samples')` gives).
//   5. VCSL names (kawai, steinway, marimba, vibraphone, harp, kalimba, …) -> github.com/sgossner/VCSL (CC0).
//   6. DAW drum names Dirt-Samples lacks (oh, rim, rd, kick, snare, …) -> default machine (TR-909) pad mapping.
import {
  library, processSampleMap, pickSample, sampleIndex, normalizeUrl,
} from './sample-library.js';
import {
  canonicalBank, splitBankSound, strudelBankUrls, resolvePadSamples, padVariant, pickLayer, NAME_TO_PAD, MACHINE_FILES,
} from './drum-machines.js';

export const SAMPLE_SOURCES = {
  dirt: { name: 'Dirt-Samples', url: 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json' },
  tdm: { name: 'tidal-drum-machines', url: 'https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json' },
  vcsl: { name: 'VCSL', url: 'https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json' },
};
export const DEFAULT_BANK = 'RolandTR909';

// Salamander Grand Piano (CC-BY 3.0, Alexander Holm) as hosted by Strudel's dough-samples (= strudel.cc's "piano")
export const PIANO_MAP = {
  _base: 'https://raw.githubusercontent.com/felixroos/dough-samples/main/piano/',
  piano: Object.fromEntries('A0 C1 Ds1 Fs1 A1 C2 Ds2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Fs5 A5 C6 Ds6 Fs6 A6 C7 Ds7 Fs7 A7 C8'.split(' ').map((k) => [k, `${k}v8.mp3`])),
};

export const DIRT_NAMES = new Set(('808 909 808bd 808cy 808hc 808ht 808lc 808lt 808mc 808mt 808oh 808sd ab ade ades2 ades3 ades4 alex alphabet amencutup '
  + 'armora arp arpy auto baa baa2 bass bass0 bass1 bass2 bass3 bassdm bassfoo battles bd bend bev bin birds birds3 bleep blip blue bottle '
  + 'breaks125 breaks152 breaks157 breaks165 breath bubble can casio cb cc chin circus clak click clubkick co coins control cosmicg cp cr crow '
  + 'd db diphone diphone2 dist dork2 dorkbot dr dr2 dr55 dr_few drum drumtraks e east electro1 em2 erk f feel feelfx fest fire flick fm foo '
  + 'future gab gabba gabbaloud gabbalouder glasstap glitch glitch2 gretsch gtr h hand hardcore hardkick haw hc hh hh27 hit hmm ho hoover house '
  + 'ht if ifdrums incoming industrial insect invaders jazz jungbass jungle juno jvbass kicklinn koy kurt latibro led less lighter linnhats lt '
  + 'made made2 mash mash2 metal miniyeah monsterb moog mouth mp3 msg mt mute newnotes noise noise2 notes numbers num oc odx off outdoor pad '
  + 'padlong pebbles perc peri pluck popkick print proc procshort psr rave rave2 ravemono realclaps reverbkick rm rs sax sd seawolf sequential '
  + 'sf sheffield short sid simplesine sitar sn space speakspell speech speechless speedupdown stab stomp subroc3d sugar sundance tabla tabla2 '
  + 'tablex tacscan tech techno tink tok toys trump ul ulgab uxay v voodoo wind wobble world xmas yeah').split(' '));

export const VCSL_NAMES = new Set(('ballwhistle bassdrum1 bassdrum2 bongo conga darbuka framedrum snare_modern snare_hi snare_low snare_rim timpani '
  + 'timpani_roll timpani2 tom_mallet tom_stick tom_rim tom2_mallet tom2_stick tom2_rim recorder_alto_stacc recorder_alto_vib recorder_alto_sus '
  + 'recorder_bass_stacc recorder_bass_vib recorder_bass_sus recorder_soprano_stacc recorder_soprano_sus recorder_tenor_stacc recorder_tenor_vib '
  + 'recorder_tenor_sus ocarina_small_stacc ocarina_small ocarina ocarina_vib pipeorgan_loud_pedal pipeorgan_loud pipeorgan_quiet_pedal '
  + 'pipeorgan_quiet organ_4inch organ_8inch organ_full trainwhistle harmonica harmonica_soft harmonica_vib super64 super64_acc super64_vib siren '
  + 'didgeridoo saxello saxello_stacc saxello_vib sax sax_stacc sax_vib harp folkharp strumstick dantranh dantranh_tremolo dantranh_vibrato '
  + 'kawai steinway psaltery_pluck psaltery_spiccato psaltery_bow clavisynth fmpiano piano1 wineglass wineglass_slow agogo anvil brakedrum '
  + 'balafon_hard balafon_soft balafon belltree cabasa cajon clap clash clash2 clave cowbell fingercymbal flexatone gong gong2 guiro '
  + 'glockenspiel handbells handchimes hihat kalimba kalimba2 kalimba3 kalimba4 kalimba5 marimba marktrees oceandrum ratchet shaker_large '
  + 'shaker_small slapstick sleighbells slitdrum sus_cymbal sus_cymbal2 tambourine tambourine2 triangles tubularbells tubularbells2 vibraphone '
  + 'vibraphone_soft vibraphone_bowed vibraslap woodblock xylophone_hard_pp xylophone_hard_ff xylophone_medium_ff xylophone_medium_pp '
  + 'xylophone_soft_pp xylophone_soft_ff').split(' '));

// ------------------------------------------------------------------------------ registry

const registry = new Map(); // lowercase sound name -> expanded bank (string[] | {note: string[]})
const sourceState = new Map(); // source id -> Promise<boolean>
let registryVersion = 0;

/** Register a strudel.json-style map (object). Returns the registered names. */
export function registerSampleMap(map, baseUrl) {
  const expanded = processSampleMap(map, baseUrl);
  for (const [k, v] of Object.entries(expanded)) registry.set(k.toLowerCase().replace(/\s+/g, '_'), v);
  registryVersion++;
  return Object.keys(expanded);
}
registerSampleMap(PIANO_MAP);

/**
 * Strudel's `samples(...)`: a map object, an https URL to a strudel.json, or 'github:owner/repo[/ref]'.
 * Resolves the registered names (rejects on network/parse failure).
 */
export async function registerSamples(mapOrUrl, baseUrl) {
  if (mapOrUrl && typeof mapOrUrl === 'object') return registerSampleMap(mapOrUrl, baseUrl);
  let url = String(mapOrUrl || '');
  if (url.startsWith('github:')) {
    let path = url.slice(7).replace(/\/$/, '');
    if (path.split('/').length === 2) path += '/main';
    // Strudel's well-known shortcut: tidalcycles/dirt-samples lives on the master branch
    if (/^tidalcycles\/dirt-samples\/main$/i.test(path)) path = 'tidalcycles/Dirt-Samples/master';
    url = `https://raw.githubusercontent.com/${path}/strudel.json`;
  }
  const json = await library.fetchJson(url);
  const base = baseUrl || json._base || url.split('/').slice(0, -1).join('/') + '/';
  return registerSampleMap(json, base);
}

/** Load a built-in source map ('dirt' | 'tdm' | 'vcsl') once. Resolves true/false. */
export function ensureSource(id) {
  if (sourceState.has(id)) return sourceState.get(id);
  const src = SAMPLE_SOURCES[id];
  if (!src) return Promise.resolve(false);
  const p = library.fetchJson(src.url).then((json) => {
    p._done = true; p._ok = true;
    const expanded = processSampleMap(json);
    for (const [k, v] of Object.entries(expanded)) {
      const key = k.toLowerCase();
      if (!registry.has(key)) registry.set(key, v); // user / earlier maps win
    }
    registryVersion++;
    return true;
  }, () => { p._done = true; p._ok = false; setTimeout(() => sourceState.delete(id), 30000); return false; });
  sourceState.set(id, p);
  return p;
}
/** true once a source map finished loading successfully. */
export function sourceLoaded(id) { return !!sourceState.get(id)?._ok; }
export function getRegisteredSound(name) { return registry.get(String(name || '').toLowerCase()) || null; }
export function registryInfo() { return { sounds: registry.size, version: registryVersion }; }

// ------------------------------------------------------------------------------ resolution

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
/** Pitch of a value for sample transposition (note / freq only — `n` is a sample index for samples). */
export function valueMidi(v) {
  if (v.note != null) {
    if (typeof v.note === 'number' && Number.isFinite(v.note)) return v.note;
    const n = Number(v.note);
    if (Number.isFinite(n)) return n;
    const m = /^([a-gA-G])([#sb]*)(-?\d+)?$/.exec(String(v.note).trim());
    if (m) {
      let pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
      for (const ch of m[2]) pc += ch === 'b' ? -1 : 1;
      return (numOr(m[3], 3) + 1) * 12 + pc;
    }
  }
  if (v.freq != null && Number(v.freq) > 0) return 69 + 12 * Math.log2(Number(v.freq) / 440);
  return null;
}

function padResult(machine, pad, value, index, rr) {
  const plan = resolvePadSamples(machine)[pad];
  if (!plan) return null;
  const variant = padVariant(plan, { variant: index }, rr, false);
  const vel = Math.min(1, numOr(value.velocity, 1) * Math.min(1, numOr(value.gain, 1)));
  const layer = pickLayer(variant, vel);
  if (!layer?.urls.length) return null;
  const url = layer.urls[sampleIndex(rr, layer.urls.length)];
  const midi = valueMidi(value);
  return {
    url, index: numOr(index, 0), key: `${machine}:${pad}`, tune: numOr(variant.tune, 0),
    transpose: midi == null ? 0 : midi - 36, decay: numOr(variant.decay, 1),
    all: variant.layers.flatMap((L) => L.urls),
  };
}

function bankResult(machine, key, value, index, rr) {
  const urls = strudelBankUrls(machine, key) || registry.get(`${machine}_${key}`.toLowerCase());
  if (Array.isArray(urls) && urls.length) {
    const midi = valueMidi(value);
    const i = sampleIndex(index, urls.length);
    return { url: urls[i], index: i, key: `${machine}_${key}`, tune: 0, transpose: midi == null ? 0 : midi - 36, decay: 1, all: [urls[i]] };
  }
  const pad = NAME_TO_PAD[key];
  if (pad && (MACHINE_FILES[machine] || machine === 'VCSLAcoustic')) return padResult(machine, pad, value, index, rr);
  if (!MACHINE_FILES[machine] && machine !== 'VCSLAcoustic') {
    // a machine outside the embedded catalog: needs the full tidal-drum-machines map
    return { pending: ensureSource('tdm'), source: 'tdm' };
  }
  return null;
}

function registryResult(bank, value, index) {
  const midi = valueMidi(value);
  const r = pickSample(bank, { n: index, midi });
  return r ? { url: r.url, index: r.index, key: null, tune: 0, transpose: r.transpose, decay: 1, all: [r.url] } : null;
}

/**
 * Resolve an event to a sample. opts: { name, index, rr (round-robin counter), defaultBank }.
 * Returns a result with `url` (may not be loaded yet — check library.get), `{pending, source}` while the
 * source map is loading, or null when the name isn't a sample.
 */
export function resolveSample(value, { name, index = 0, rr = 0, defaultBank = DEFAULT_BANK } = {}) {
  const v = value || {};
  const raw = String(name ?? v.s ?? '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  const n = index;
  if (v.bank != null && String(v.bank) !== '') {
    const machine = canonicalBank(v.bank);
    if (machine) {
      const r = bankResult(machine, low, v, n, rr);
      if (r) return r;
    }
    const reg = registry.get(`${String(v.bank)}_${raw}`.toLowerCase());
    if (reg) return registryResult(reg, v, n);
    if (!machine) return null;
  }
  const split = splitBankSound(raw);
  if (split) {
    const r = bankResult(split.machine, split.key, v, n, rr);
    if (r) return r;
  }
  const reg = registry.get(low);
  if (reg) return registryResult(reg, v, n);
  if (DIRT_NAMES.has(low)) {
    const st = sourceState.get('dirt');
    if (!st || !st._done) return { pending: trackSource('dirt'), source: 'dirt' };
    // map loaded but the name is absent, or the load failed: fall through
  }
  if (VCSL_NAMES.has(low)) {
    const st = sourceState.get('vcsl');
    if (!st || !st._done) return { pending: trackSource('vcsl'), source: 'vcsl' };
  }
  const pad = NAME_TO_PAD[low];
  if (pad) return padResult(canonicalBank(defaultBank) || DEFAULT_BANK, pad, v, n, rr);
  return null;
}

const trackSource = (id) => ensureSource(id);

/** URLs a set of event values will need (loads the source maps they reference first). */
export async function urlsForValues(values, { defaultBank = DEFAULT_BANK, splitName = defaultSplit } = {}) {
  const urls = new Set();
  const pending = [];
  const seen = new Set();
  const uniq = [];
  for (const v of values) {
    const [name, idx] = splitName(v);
    if (!name) continue;
    const k = `${name}|${idx}|${v.bank ?? ''}|${v.note ?? ''}|${v.freq ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push([v, name, idx]);
  }
  const pass = () => {
    pending.length = 0;
    for (const [v, name, idx] of uniq) {
      const r = resolveSample(v, { name, index: idx, defaultBank });
      if (!r) continue;
      if (r.pending) { pending.push(r.pending); continue; }
      for (const u of r.all || [r.url]) urls.add(u);
    }
  };
  pass();
  if (pending.length) { await Promise.all(pending); pass(); }
  return [...urls];
}

/** Split `s` ("bd:3") / n of an event value -> [name, index]. */
export function defaultSplit(v) {
  const s = v?.s ?? v?.sound;
  if (s == null) return [null, 0];
  const [name, i] = String(s).split(':');
  const idx = i != null && i !== '' ? Number(i) : v.n != null && valueMidi(v) == null ? Number(v.n) : 0;
  return [name, Number.isFinite(idx) ? idx : 0];
}

export { library, normalizeUrl };
