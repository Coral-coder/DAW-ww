// Parser for midi-js-soundfonts instrument files (pure, Node-safe; never evals the file).
//
//   if (typeof(MIDI) === 'undefined') var MIDI = {};
//   MIDI.Soundfont.acoustic_grand_piano = {
//   "A0": "data:audio/mp3;base64,....",
//   "Bb0": "data:audio/mp3;base64,....",
//   ... }
// A plain JSON object {"A0": "data:...", ...} is accepted as well.

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * 'C4' -> 60, 'A4' -> 69, 'Bb0' -> 22, 'F#3' -> 54, 'Cb4' -> 59, 'C-1' -> 0. Null when invalid.
 * Octave numbering: C4 = middle C = 60.
 */
export function noteNameToMidi(name) {
  const m = /^\s*([A-Ga-g])([#b♯♭s]*)(-?\d{1,2})\s*$/.exec(String(name ?? ''));
  if (!m) return null;
  let pc = PC[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === 'b' || ch === '♭' ? -1 : 1;
  const midi = (parseInt(m[3], 10) + 1) * 12 + pc;
  return midi >= 0 && midi <= 127 ? midi : null;
}

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** 60 -> 'C4' (flats, matching the soundfont files' key names). */
export function midiToNoteName(midi) {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * parseSoundfontText(text) -> { name: string|null, samples: [{ note, midi, mime, dataUrl }] (sorted by midi) }
 * Throws a friendly Error when the text has no samples.
 */
export function parseSoundfontText(text) {
  const src = String(text ?? '');
  const nameM = /MIDI\.Soundfont\.([A-Za-z0-9_$]+)\s*=/.exec(src) || /MIDI\.Soundfont\[\s*["']([^"']+)["']\s*\]\s*=/.exec(src);
  const re = /["']([A-Ga-g][#b]?-?\d{1,2})["']\s*:\s*["'](data:([a-z]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]*?)["']/g;
  const byMidi = new Map();
  let m;
  while ((m = re.exec(src))) {
    const midi = noteNameToMidi(m[1]);
    if (midi == null) continue;
    byMidi.set(midi, { note: m[1], midi, mime: m[3], dataUrl: m[2].replace(/\s+/g, '') });
  }
  if (!byMidi.size) {
    throw new Error('This file does not look like a midi-js soundfont (no "A0": "data:audio/…" entries found).');
  }
  const samples = [...byMidi.values()].sort((a, b) => a.midi - b.midi);
  return { name: nameM ? nameM[1] : null, samples };
}

/** Index of the sample whose midi is nearest to `midi` in a sorted midi list (ties prefer the lower sample). */
export function nearestSampleIndex(sortedMidis, midi) {
  const n = sortedMidis.length;
  if (!n) return -1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedMidis[mid] < midi) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(sortedMidis[lo - 1] - midi) <= Math.abs(sortedMidis[lo] - midi)) return lo - 1;
  return lo;
}

/** Playback rate that repitches a sample recorded at `sampleMidi` to `midi` (+ cents). */
export function playbackRateFor(midi, sampleMidi, cents = 0) {
  return Math.pow(2, (midi - sampleMidi + cents / 100) / 12);
}

/** 'data:audio/mp3;base64,AAAA' -> Uint8Array (works in browsers and Node). */
export function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  const b64 = comma >= 0 ? s.slice(comma + 1) : s;
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line no-undef
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
