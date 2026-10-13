// Builds src/audio/library/multisample-data.js — the note / velocity / round-robin maps of the real
// multisampled instruments daWWW streams at runtime (see docs/SAMPLES.md "Multisampled instruments").
//
// usage: node scripts/build-multisamples.mjs <VSCO-2-CE listing> <VCSL listing> <tonejs-instruments listing>
//   Each listing is the output of `git ls-tree -r --name-only HEAD` in a (blob-less) clone of
//   sgossner/VSCO-2-CE, sgossner/VCSL and nbrosowsky/tonejs-instruments. Salamander (tambien/Piano)
//   follows a fixed naming scheme and needs no listing.
//
// Octave conventions differ per collection: VSCO-2-CE and most of VCSL name notes with C3 = middle C
// (`oct: 1` below shifts them to MIDI's C4 = 60); the VSCO solo violin and harp use C4 = 60, the VCSL
// glockenspiel is named an octave below its sounding pitch. Every `oct` value was verified by detecting the
// fundamental of two samples per set (YIN; tubular bells by their strike tone) — re-check when adding a set.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/';
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const noteMidi = (name, oct = 0) => {
  const m = /^([A-Ga-g])(#|s|b)?(-?\d)$/.exec(name);
  if (!m) return null;
  return (Number(m[3]) + 1 + oct) * 12 + NOTE[m[1].toUpperCase()] + (m[2] === '#' || m[2] === 's' ? 1 : m[2] === 'b' ? -1 : 0);
};


/**
 * Set definitions. src: 'vsco' | 'vcsl' | 'tjs'; dir: folder inside the repo; match: filename regex with named
 * groups n (note), v (velocity token, optional), r (round robin, optional); vel: ordered velocity tokens to keep
 * (soft -> loud; others dropped); rr: max round robins; oct: octave shift of the naming; kind: 'sustain' (looped
 * when held longer than the sample) | 'decay' (rings out); maxSec: seconds fetched per file (HTTP Range).
 * parts: several sources merged into one keyboard (each with lo/hi MIDI bounds).
 */
const SETS = {
  // ---------------------------------------------------------------- strings (VSCO-2-CE, CC0)
  'vsco-strings': {
    name: 'String Ensemble (VSCO-2 sections)', family: 'strings', kind: 'sustain', maxSec: 4, attack: 0.09, release: 0.5,
    parts: [
      { src: 'vsco', dir: 'Strings/Cello Section/susvib', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '3'], oct: 1, hi: 54 },
      { src: 'vsco', dir: 'Strings/Viola Section/susvib', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '2'], oct: 1, lo: 55, hi: 63 },
      { src: 'vsco', dir: 'Strings/Violin Section/susVib', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)\.wav$/, vel: ['1', '2'], oct: 1, lo: 64 },
    ],
  },
  'vsco-strings-trem': {
    name: 'String Ensemble Tremolo (VSCO-2)', family: 'strings', kind: 'sustain', maxSec: 4, attack: 0.05, release: 0.4,
    parts: [
      { src: 'vsco', dir: 'Strings/Cello Section/trem', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '2'], oct: 1, hi: 54 },
      { src: 'vsco', dir: 'Strings/Viola Section/trem', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr\d\.wav$/, vel: ['1', '2'], oct: 1, lo: 55, hi: 63 },
      { src: 'vsco', dir: 'Strings/Violin Section/Trem', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)\.wav$/, vel: ['1', '2'], oct: 1, lo: 64 },
    ],
  },
  'vsco-strings-pizz': {
    name: 'Pizzicato Strings (VSCO-2)', family: 'strings', kind: 'decay', maxSec: 2.5, release: 0.25,
    parts: [
      { src: 'vsco', dir: 'Strings/Cello Section/pizzT', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_RR(?<r>\d)\.wav$/, vel: ['1', '2'], rr: 2, oct: 1, hi: 57 },
      { src: 'vsco', dir: 'Strings/Violin Section/Pizz', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr(?<r>\d)\.wav$/, vel: ['1', '2'], rr: 2, oct: 1, lo: 58 },
    ],
  },
  'vsco-violin': {
    name: 'Solo Violin (VSCO-2)', family: 'strings', kind: 'sustain', maxSec: 4, attack: 0.06, release: 0.35,
    parts: [{ src: 'vsco', dir: 'Strings/Solo Violin/Arco Vib', match: /_(?<n>[A-G]#?\d)_(?<v>p|f)\.wav$/, vel: ['p', 'f'], oct: 0 }],
  },
  'vsco-cello': {
    name: 'Cello Section (VSCO-2)', family: 'strings', kind: 'sustain', maxSec: 4, attack: 0.08, release: 0.45,
    parts: [{ src: 'vsco', dir: 'Strings/Cello Section/susvib', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-contrabass': {
    name: 'Contrabass Arco (VSCO-2)', family: 'bass', kind: 'sustain', maxSec: 4, attack: 0.06, release: 0.3,
    parts: [{ src: 'vsco', dir: 'Strings/Solo Contrabass/SusNV', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr\d\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-bass-pizz': {
    name: 'Upright Bass Pizzicato (VSCO-2)', family: 'bass', kind: 'decay', maxSec: 2.5, release: 0.12,
    parts: [{ src: 'vsco', dir: 'Strings/Solo Contrabass/Pizz', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr(?<r>\d)\.wav$/, vel: ['1', '3'], rr: 2, oct: 1 }],
  },
  'vsco-harp': {
    name: 'Concert Harp (VSCO-2)', family: 'plucked', kind: 'decay', maxSec: 4, release: 0.8,
    parts: [{ src: 'vsco', dir: 'Strings/Harp', match: /_(?<n>[A-G]#?\d)_mf\.wav$/, oct: 0 }],
  },
  // ---------------------------------------------------------------- brass (VSCO-2-CE, CC0)
  'vsco-trumpet': {
    name: 'Trumpet (VSCO-2)', family: 'brass', kind: 'sustain', maxSec: 3.5, attack: 0.012, release: 0.18,
    parts: [{ src: 'vsco', dir: 'Brass/Trumpet/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr\d\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-horn': {
    name: 'French Horn (VSCO-2)', family: 'brass', kind: 'sustain', maxSec: 3.5, attack: 0.03, release: 0.3,
    parts: [{ src: 'vsco', dir: 'Brass/F Horn/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-trombone': {
    name: 'Tenor Trombone (VSCO-2)', family: 'brass', kind: 'sustain', maxSec: 3.5, attack: 0.02, release: 0.22,
    parts: [{ src: 'vsco', dir: 'Brass/Tenor Trombone/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '2'], oct: 1 }],
  },
  'vsco-tuba': {
    name: 'Tuba (VSCO-2)', family: 'brass', kind: 'sustain', maxSec: 3.5, attack: 0.03, release: 0.25,
    parts: [{ src: 'vsco', dir: 'Brass/Tuba/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr\d_Mid\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-brass': {
    name: 'Brass Section (VSCO-2: trombone / horn / trumpet)', family: 'brass', kind: 'sustain', maxSec: 3.5, attack: 0.015, release: 0.22,
    parts: [
      { src: 'vsco', dir: 'Brass/Tenor Trombone/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '2'], oct: 1, hi: 53 },
      { src: 'vsco', dir: 'Brass/F Horn/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '3'], oct: 1, lo: 54, hi: 62 },
      { src: 'vsco', dir: 'Brass/Trumpet/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr\d\.wav$/, vel: ['1', '3'], oct: 1, lo: 63 },
    ],
  },
  // ---------------------------------------------------------------- woodwinds
  'vsco-flute': {
    name: 'Flute (VSCO-2)', family: 'woodwind', kind: 'sustain', maxSec: 3.5, attack: 0.04, release: 0.22,
    parts: [{ src: 'vsco', dir: 'Woodwinds/Flute/susNV', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_\d\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-clarinet': {
    name: 'Clarinet (VSCO-2)', family: 'woodwind', kind: 'sustain', maxSec: 3.5, attack: 0.03, release: 0.2,
    parts: [{ src: 'vsco', dir: 'Woodwinds/Clarinet/susLong', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr1_sum\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-oboe': {
    name: 'Oboe (VSCO-2)', family: 'woodwind', kind: 'sustain', maxSec: 3.5, attack: 0.03, release: 0.2,
    parts: [{ src: 'vsco', dir: 'Woodwinds/Oboe/Sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_Main\.wav$/, vel: ['1', '3'], oct: 1 }],
  },
  'vsco-bassoon': {
    name: 'Bassoon (VSCO-2)', family: 'woodwind', kind: 'sustain', maxSec: 3.5, attack: 0.03, release: 0.2,
    parts: [{ src: 'vsco', dir: 'Woodwinds/Bassoon/sus', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_1\.wav$/, vel: ['1', '2'], oct: 1 }],
  },
  'vcsl-tenor-sax': {
    name: 'Tenor Saxophone (VCSL)', family: 'woodwind', kind: 'sustain', maxSec: 3.5, attack: 0.02, release: 0.18,
    parts: [{ src: 'vcsl', dir: 'Aerophones/Reed Aerophones/Tenor Saxophone/Non-Vibrato', match: /_(?<n>[A-G]#?\d)_vl(?<v>\d)_rr(?<r>\d)\.wav$/, vel: ['2', '3'], rr: 1, oct: 1 }],
  },
  'vcsl-recorder': {
    name: 'Alto Recorder (VCSL)', family: 'woodwind', kind: 'sustain', maxSec: 3, attack: 0.03, release: 0.15,
    parts: [{ src: 'vcsl', dir: 'Aerophones/Edge-blown Aerophones/Baroque Alto Recorder/Sustain', match: /_(?<n>[A-G]#?\d)_rr1_Main\.wav$/, oct: 1 }],
  },
  'vcsl-harmonica': {
    name: 'Harmonica (VCSL)', family: 'woodwind', kind: 'sustain', maxSec: 3, attack: 0.03, release: 0.15,
    parts: [{ src: 'vcsl', dir: 'Aerophones/Free Aerophones/Harmonica-Hohner-Special20-C/Sustains/Normal', match: /_(?<n>[A-G]#?\d)\.wav$/, oct: 1 }],
  },
  // ---------------------------------------------------------------- keys
  'vcsl-upright': {
    name: 'Upright Piano (VCSL Yamaha)', family: 'piano', kind: 'decay', maxSec: 6, release: 0.3,
    parts: [{ src: 'vcsl', dir: 'Chordophones/Zithers/Upright Piano, Yamaha/Sustains', match: /_Sus_(?<n>[A-G]#?-?\d)_vl(?<v>\d)_rr(?<r>\d)\.wav$/, vel: ['1', '2', '3'], rr: 1, oct: 1 }],
  },
  'vcsl-harpsichord': {
    name: 'Harpsichord (VCSL English)', family: 'piano', kind: 'decay', maxSec: 4, release: 0.15,
    parts: [{ src: 'vcsl', dir: 'Chordophones/Zithers/Harpsichord, English/Sustains/Normal', match: /_Sus_(?<n>[A-G]#?\d)_rr1\.wav$/, oct: 1 }],
  },
  'vcsl-pipe-organ': {
    name: 'Pipe Organ (VCSL)', family: 'organ', kind: 'sustain', maxSec: 4, attack: 0.04, release: 0.6,
    parts: [{ src: 'vcsl', dir: 'Aerophones/Edge-blown Aerophones/Pipe Organ/Quiet', match: /_Man3Quiet_(?<n>[A-G]#?\d)_rr1\.wav$/, oct: 1 }],
  },
  // ---------------------------------------------------------------- mallets / plucked idiophones (VCSL, CC0)
  'vcsl-vibraphone': {
    name: 'Vibraphone (VCSL)', family: 'mallet', kind: 'decay', maxSec: 5, release: 0.6,
    parts: [{ src: 'vcsl', dir: 'Idiophones/Struck Idiophones/Vibraphone/Soft Mallets', match: /_(?<n>[A-G]#?\d)_v(?<v>\d)_rr1_Main\.wav$/, vel: ['1', '2'], oct: 1 }],
  },
  'vcsl-marimba': {
    name: 'Marimba (VCSL)', family: 'mallet', kind: 'decay', maxSec: 2.5, release: 0.3,
    parts: [{ src: 'vcsl', dir: 'Idiophones/Struck Idiophones/Marimba', match: /Outrigger_(?<n>[A-G]#?\d)_(?<v>soft|med|loud)_01\.wav$/, vel: ['soft', 'med', 'loud'], oct: 1 }],
  },
  'vcsl-glockenspiel': {
    name: 'Glockenspiel (VCSL)', family: 'mallet', kind: 'decay', maxSec: 3, release: 0.5,
    parts: [{ src: 'vcsl', dir: 'Idiophones/Struck Idiophones/Glockenspiel', match: /glock_(?<v>soft|medium|loud)_(?<n>[A-G]#?\d)_0\d\.wav$/, vel: ['soft', 'medium', 'loud'], oct: 1 }],
  },
  'vcsl-xylophone': {
    name: 'Xylophone (VCSL)', family: 'mallet', kind: 'decay', maxSec: 2, release: 0.2,
    parts: [{ src: 'vcsl', dir: 'Idiophones/Struck Idiophones/Xylophone/Medium Mallets', match: /Xylo_Medium_(?<n>[A-G]#?\d)_(?<v>pp|ff)_01_far\.wav$/, vel: ['pp', 'ff'], oct: 1 }],
  },
  'vcsl-tubular-bells': {
    name: 'Tubular Bells (VCSL)', family: 'mallet', kind: 'decay', maxSec: 5, release: 1,
    parts: [{ src: 'vcsl', dir: 'Idiophones/Struck Idiophones/Tubular Bells 2', match: /TB_hit_(?<n>[A-G]#?\d)_v(?<v>\d)_1\.wav$/, vel: ['2', '4'], oct: 0 }],
  },
  'vcsl-kalimba': {
    name: 'Kalimba (VCSL Tanzania)', family: 'mallet', kind: 'decay', maxSec: 3, release: 0.4,
    parts: [{ src: 'vcsl', dir: 'Idiophones/Plucked Idiophones/Kalimba, Tanzania', match: /_Main_(?<n>[A-G]#?\d)_k\d+_50_100_rr\d\.wav$/, oct: 1 }],
  },
  // ---------------------------------------------------------------- guitars / bass / sax (tonejs-instruments, mp3)
  'tjs-guitar-electric': {
    name: 'Electric Guitar, clean (Karoryfer)', family: 'guitar', kind: 'decay', release: 0.2,
    parts: [{ src: 'tjs', dir: 'samples/guitar-electric', match: /^(?<n>[A-G]s?\d)\.mp3$/, oct: 0 }],
  },
  'tjs-guitar-acoustic': {
    name: 'Acoustic Guitar, steel (Univ. of Iowa MIS)', family: 'guitar', kind: 'decay', release: 0.25,
    parts: [{ src: 'tjs', dir: 'samples/guitar-acoustic', match: /^(?<n>[A-G]s?\d)\.mp3$/, oct: 0 }],
  },
  'tjs-guitar-nylon': {
    name: 'Classical Guitar, nylon (Freesound: quartertone)', family: 'guitar', kind: 'decay', release: 0.25,
    parts: [{ src: 'tjs', dir: 'samples/guitar-nylon', match: /^(?<n>[A-G]s?\d)\.mp3$/, oct: 0 }],
  },
  'tjs-bass-electric': {
    name: 'Electric Bass, finger (Karoryfer)', family: 'bass', kind: 'decay', release: 0.1,
    parts: [{ src: 'tjs', dir: 'samples/bass-electric', match: /^(?<n>[A-G]s?\d)\.mp3$/, oct: 0 }],
  },
  'tjs-saxophone': {
    name: 'Alto Saxophone (Karoryfer)', family: 'woodwind', kind: 'sustain', attack: 0.015, release: 0.15,
    parts: [{ src: 'tjs', dir: 'samples/saxophone', match: /^(?<n>[A-G]s?\d)\.mp3$/, oct: 0 }],
  },
  'tjs-harmonium': {
    name: 'Harmonium (Freesound: donyaquick)', family: 'organ', kind: 'sustain', attack: 0.05, release: 0.3,
    parts: [{ src: 'tjs', dir: 'samples/harmonium', match: /^(?<n>[A-G]s?\d)\.mp3$/, oct: 0 }],
  },
};

const REPOS = {
  vsco: { base: `${RAW}sgossner/VSCO-2-CE/master/`, license: 'CC0-1.0', credit: 'VS Chamber Orchestra: Community Edition — Versilian Studios (Sam Gossner, Simon Dalzell)', repo: 'sgossner/VSCO-2-CE' },
  vcsl: { base: `${RAW}sgossner/VCSL/master/`, license: 'CC0-1.0', credit: 'Versilian Community Sample Library — Versilian Studios', repo: 'sgossner/VCSL' },
  sal: { base: `${RAW}tambien/Piano/master/audio/`, license: 'CC-BY 3.0', credit: 'Salamander Grand Piano V3 — Alexander Holm (CC-BY 3.0), mp3 conversion by Yotam Mann (tambien/Piano)', repo: 'tambien/Piano' },
  tjs: { base: `${RAW}nbrosowsky/tonejs-instruments/master/`, license: 'see sample-source-info.txt', credit: 'tonejs-instruments — Nicholaus Brosowsky (MIT); samples from Karoryfer, Univ. of Iowa MIS, Freesound, VSCO-2', repo: 'nbrosowsky/tonejs-instruments' },
};
const TJS_LICENSE = {
  'samples/guitar-electric': 'Karoryfer Samples (free library)', 'samples/bass-electric': 'Karoryfer Samples (free library)', 'samples/saxophone': 'Karoryfer Samples (free library)',
  'samples/guitar-acoustic': 'University of Iowa Musical Instrument Samples (free for any use)', 'samples/guitar-nylon': 'Freesound pack 11573 by quartertone (CC-BY 3.0)',
  'samples/harmonium': 'Freesound pack 330410 by donyaquick (CC-BY 3.0)',
};

function build(listings) {
  const out = {};
  for (const [id, set] of Object.entries(SETS)) {
    const zones = [];
    const repos = new Set();
    const licenses = new Set();
    for (const part of set.parts) {
      repos.add(part.src);
      licenses.add(part.src === 'tjs' ? TJS_LICENSE[part.dir] : REPOS[part.src].license);
      const files = listings[part.src].filter((f) => f.startsWith(part.dir + '/') && !f.slice(part.dir.length + 1).includes('/'));
      const vels = part.vel ? (part.vmax ? part.vel.slice(-part.vmax) : part.vel) : [null];
      const found = new Map(); // midi -> [{layer, rr, file}]
      for (const f of files) {
        const m = part.match.exec(f.slice(part.dir.length + 1));
        if (!m) continue;
        const midi = noteMidi(m.groups.n, part.oct || 0);
        if (midi == null || (part.lo != null && midi < part.lo) || (part.hi != null && midi > part.hi)) continue;
        const layer = part.vel ? vels.indexOf(m.groups.v) : 0;
        if (layer < 0) continue;
        const rr = m.groups.r ? Number(m.groups.r) : 1;
        if (rr > (part.rr || 1)) continue;
        if (!found.has(midi)) found.set(midi, []);
        found.get(midi).push({ layer, rr, file: f });
      }
      // keep notes that have every layer (no velocity gaps); fill missing layers from the nearest one
      for (const [midi, list] of found) {
        for (let l = 0; l < vels.length; l++) {
          let items = list.filter((x) => x.layer === l);
          if (!items.length) {
            const near = [...list].sort((a, b) => Math.abs(a.layer - l) - Math.abs(b.layer - l))[0];
            items = list.filter((x) => x.layer === near.layer);
          }
          for (const it of items.sort((a, b) => a.rr - b.rr)) zones.push([midi, l, `${part.src}:${it.file}`]);
        }
      }
    }
    zones.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
    const layers = Math.max(...zones.map((z) => z[1])) + 1;
    out[id] = {
      name: set.name, family: set.family, kind: set.kind, layers,
      ...(set.maxSec ? { maxSec: set.maxSec } : {}), ...(set.attack ? { attack: set.attack } : {}), release: set.release,
      license: [...licenses].join(' + '), credit: [...repos].map((r) => REPOS[r].credit).join('; '),
      zones,
    };
    if (!zones.length) throw new Error(`set ${id}: no samples matched`);
  }
  // Salamander Grand (16 velocity layers, every minor third A0..C8, release samples rel1..rel88): 4 layers kept
  const SAL_VEL = [3, 7, 11, 15];
  const salZones = [];
  for (let midi = 21; midi <= 108; midi += 3) {
    const name = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'][midi % 12] + (Math.floor(midi / 12) - 1);
    SAL_VEL.forEach((v, l) => salZones.push([midi, l, `sal:${name}v${v}.mp3`]));
  }
  out.salamander = {
    name: 'Salamander Grand Piano', family: 'piano', kind: 'decay', layers: SAL_VEL.length, release: 0.35,
    releaseSamples: { from: 21, to: 108, file: 'sal:rel{n}.mp3', offset: -20, gain: 0.08 },
    license: REPOS.sal.license, credit: REPOS.sal.credit, zones: salZones,
  };
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [vsco, vcsl, tjs] = process.argv.slice(2);
  if (!tjs) { console.error('usage: node scripts/build-multisamples.mjs <vsco listing> <vcsl listing> <tonejs listing>'); process.exit(1); }
  const read = (f) => readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const sets = build({ vsco: read(vsco), vcsl: read(vcsl), tjs: read(tjs) });
  const bases = Object.fromEntries(Object.entries(REPOS).map(([k, v]) => [k, v.base]));
  const body = Object.entries(sets).map(([id, s]) => {
    const { zones, ...meta } = s;
    const z = zones.map((x) => JSON.stringify(x)).join(',');
    return `  ${JSON.stringify(id)}: { ...${JSON.stringify(meta)}, zones: [${z}] },`;
  }).join('\n');
  const src = `// GENERATED by scripts/build-multisamples.mjs — do not edit by hand.\n// Zone = [midi, velocityLayer (0 = softest), 'repo:path'] (several zones with the same midi + layer = round robins).\n// Files are streamed at runtime from GitHub (see docs/SAMPLES.md); nothing is bundled.\nexport const MS_BASES = ${JSON.stringify(bases)};\nexport const MS_SETS = {\n${body}\n};\n`;
  const dest = new URL('../src/audio/library/multisample-data.js', import.meta.url);
  writeFileSync(dest, src);
  console.log(`wrote ${fileURLToPath(dest)} (${(src.length / 1024).toFixed(1)} KB):`);
  for (const [id, s] of Object.entries(sets)) {
    const notes = [...new Set(s.zones.map((z) => z[0]))];
    console.log(id.padEnd(22), `${notes.length} notes ${notes[0]}..${notes[notes.length - 1]}`, `${s.layers} layers`, `${s.zones.length} files`);
  }
}

export { SETS, build, noteMidi };
