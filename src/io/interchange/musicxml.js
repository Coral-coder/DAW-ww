// MusicXML 4.0 (partwise) lead-sheet export and melody import — pure, Node-safe.
//
//   exportMusicXml(project, {trackId?, chords?, title?}) -> { xml, trackId, chords, report }
//       one part: the melody (monophonic skyline of the chosen track) + chord symbols (<harmony>)
//       from the project's harmony (a chords/pad track, detected per beat) or `chords` [{beat, name}].
//   parseMusicXml(text) -> { title, bpm, timeSig, key, parts:[{id, name, notes:[{pitch,start,dur,vel}]}], chords:[{beat, name}], markers }
//   await readMusicXmlFile(bytes) -> same (accepts .musicxml/.xml text or compressed .mxl)
//   addMusicXmlToProject(project, parsed, {setTempo, chordTrack}) -> { trackIds } (mutates; use in store.transact)
//   melodyTrack(project) / harmonyChords(project) — the defaults used by the export
import { el, toXml, parseXml, child, children, numAttr } from './xml.js';
import { readZip, zipText, isZip } from './zip.js';
import { beatsPerBar, songLengthBeats, createTrack, createPattern, createNote, createClip, TRACK_COLORS } from '../../core/model.js';
import { collectTrackNotes } from '../midi.js';
import { detectChord, chordName, parseChordName, chordNotes, keySignature, keyPrefersFlats, pitchClassName, mod12 } from '../../theory/index.js';
import { clamp } from '../../core/util.js';

export const DIVISIONS = 24; // per quarter note: 16ths, 32nds and (16th-)triplets are exact

const TYPES = [
  // [duration in divisions, type, dots, triplet]
  [144, 'whole', 1, false], [96, 'whole', 0, false], [72, 'half', 1, false], [48, 'half', 0, false], [36, 'quarter', 1, false],
  [24, 'quarter', 0, false], [18, 'eighth', 1, false], [12, 'eighth', 0, false], [9, '16th', 1, false], [6, '16th', 0, false], [3, '32nd', 0, false],
];
const TRIPLETS = [[64, 'whole', 0, true], [32, 'half', 0, true], [16, 'quarter', 0, true], [8, 'eighth', 0, true], [4, '16th', 0, true], [2, '32nd', 0, true], [1, '64th', 0, true]];

/** Splits a duration (divisions) into notatable values (greedy, plain values first). */
export function splitDuration(d) {
  const out = [];
  let rest = Math.round(d);
  while (rest > 0) {
    // plain values while the rest is a multiple of 3; otherwise one triplet value that makes it so
    const pick = rest % 3 === 0
      ? TYPES.find((t) => t[0] <= rest)
      : TRIPLETS.find((t) => t[0] <= rest && (rest - t[0]) % 3 === 0) || TRIPLETS.find((t) => t[0] <= rest);
    out.push(pick);
    rest -= pick[0];
  }
  return out;
}

const KIND_OUT = {
  maj: 'major', min: 'minor', dim: 'diminished', aug: 'augmented', sus2: 'suspended-second', sus4: 'suspended-fourth', 5: 'power',
  6: 'major-sixth', m6: 'minor-sixth', 7: 'dominant', maj7: 'major-seventh', m7: 'minor-seventh', m7b5: 'half-diminished',
  dim7: 'diminished-seventh', mMaj7: 'major-minor', 9: 'dominant-ninth', maj9: 'major-ninth', m9: 'minor-ninth', 11: 'dominant-11th',
  m11: 'minor-11th', 13: 'dominant-13th', maj13: 'major-13th', m13: 'minor-13th', aug7: 'augmented-seventh',
  add9: 'major', madd9: 'minor', '7sus4': 'suspended-fourth', '9sus4': 'suspended-fourth', '7b9': 'dominant', '7#9': 'dominant',
  '7#11': 'dominant', '7b5': 'dominant', augMaj7: 'augmented', maj7s11: 'major-seventh', 69: 'major-sixth', m69: 'minor-sixth',
};
const KIND_IN = {
  major: 'maj', minor: 'min', diminished: 'dim', augmented: 'aug', 'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5',
  'major-sixth': '6', 'minor-sixth': 'm6', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7', 'half-diminished': 'm7b5',
  'diminished-seventh': 'dim7', 'major-minor': 'mMaj7', 'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9',
  'dominant-11th': '11', 'major-11th': 'maj9', 'minor-11th': 'm11', 'dominant-13th': '13', 'major-13th': 'maj13', 'minor-13th': 'm13',
  'augmented-seventh': 'aug7',
};

const STEP_ALTER = (pc, flats) => {
  const name = pitchClassName(pc, flats);
  return { step: name[0], alter: name.length > 1 ? (name[1] === 'b' ? -1 : 1) : 0 };
};
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// ----------------------------------------------------------------------- melody + harmony sources

const isMelodic = (t) => t.type === 'instrument' && t.instrument?.type !== 'drums' && t.instrument?.type !== 'drumsampler';

function trackNotes(project, track) {
  return collectTrackNotes(project, track, project.clips?.some((c) => c.trackId === track.id) ? 'song' : 'pattern');
}

/** The lead: role lead/vocal, else the most monophonic, highest melodic track with notes. */
export function melodyTrack(project) {
  const melodic = project.tracks.filter(isMelodic);
  const byRole = melodic.find((t) => (t.role === 'lead' || t.role === 'vocal') && trackNotes(project, t).length);
  if (byRole) return byRole;
  let best = null;
  for (const t of melodic) {
    const notes = trackNotes(project, t);
    if (!notes.length || t.role === 'chords' || t.role === 'pad' || t.role === 'bass') continue;
    const poly = notes.filter((n, i) => notes.some((m, j) => j !== i && Math.abs(m.start - n.start) < 0.01)).length / notes.length;
    const avg = notes.reduce((s, n) => s + n.pitch, 0) / notes.length;
    const score = avg - poly * 40;
    if (!best || score > best.score) best = { t, score };
  }
  return best?.t || melodic.find((t) => trackNotes(project, t).length) || null;
}

/** Chord symbols from the project's harmony: a chords / pad track (or the most polyphonic one), one per change (beat grid). */
export function harmonyChords(project, { exclude = null } = {}) {
  const melodic = project.tracks.filter((t) => isMelodic(t) && t.id !== exclude);
  let src = melodic.find((t) => t.role === 'chords' && trackNotes(project, t).length) || melodic.find((t) => t.role === 'pad' && trackNotes(project, t).length);
  if (!src) {
    let best = null;
    for (const t of melodic) {
      const notes = trackNotes(project, t);
      if (notes.length < 3) continue;
      const poly = notes.filter((n, i) => notes.some((m, j) => j !== i && Math.abs(m.start - n.start) < 0.01)).length / notes.length;
      if (poly > 0.5 && (!best || poly > best.poly)) best = { t, poly };
    }
    src = best?.t;
  }
  if (!src) return [];
  const notes = trackNotes(project, src);
  const bass = project.tracks.find((t) => isMelodic(t) && t.role === 'bass');
  const bassNotes = bass ? trackNotes(project, bass) : [];
  const end = Math.max(...notes.map((n) => n.start + n.dur));
  const keyFlats = project.key ? keyPrefersFlats(project.key.root, project.key.scale) : 'common'; // chord symbols spelled like the key
  const out = [];
  let prev = null;
  for (let b = 0; b < end - 1e-9; b += 1) {
    const sounding = notes.filter((n) => n.start < b + 1 - 1e-9 && n.start + n.dur > b + 1e-9);
    if (!sounding.length) continue;
    const ch = detectChord(sounding.map((n) => n.pitch));
    if (!ch) continue;
    const bassNote = bassNotes.filter((n) => n.start <= b + 1e-9 && n.start + n.dur > b + 1e-9).sort((x, y) => x.pitch - y.pitch)[0];
    const chord = { root: ch.root, type: ch.type, ...(bassNote && mod12(bassNote.pitch) !== ch.root ? { bass: mod12(bassNote.pitch) } : ch.bass !== ch.root ? { bass: ch.bass } : {}) };
    const name = chordName(chord, { preferFlats: keyFlats });
    if (name !== prev) out.push({ beat: b, name });
    prev = name;
  }
  return out;
}

/** Monophonic line: the highest note wins at equal starts; overlapping notes are cut at the next start. */
function skyline(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.start - n.start) < 1e-6) continue;
    if (last && last.start + last.dur > n.start) last.dur = n.start - last.start;
    out.push({ ...n });
  }
  return out.filter((n) => n.dur > 1e-6);
}

// ------------------------------------------------------------------------------------- export

export function exportMusicXml(project, opts = {}) {
  const report = { warnings: [] };
  const track = opts.trackId ? project.tracks.find((t) => t.id === opts.trackId) : melodyTrack(project);
  const raw = track ? trackNotes(project, track) : [];
  if (!track) report.warnings.push('No melodic track found — the lead sheet only has chord symbols.');
  const poly = raw.length !== skyline(raw).length;
  if (poly) report.warnings.push(`"${track.name}" is polyphonic — only the top line was written.`);
  const chords = opts.chords || harmonyChords(project, { exclude: track?.id });
  if (!chords.length) report.warnings.push('No chord track found — no chord symbols written.');
  const [num, den] = project.timeSig || [4, 4];
  const measure = Math.round(beatsPerBar(project) * DIVISIONS);
  const k = project.key || { root: 0, scale: 'major' };
  let fifths = 0;
  try { fifths = keySignature(k.root, k.scale); } catch { /* C */ }
  const flats = fifths < 0;
  const minor = /minor|aeolian|dorian|phrygian|locrian/.test(String(k.scale));

  const q = (b) => Math.round(b * DIVISIONS);
  const notes = skyline(raw).map((n) => ({ pitch: clamp(Math.round(n.pitch), 0, 127), s: q(n.start), e: q(n.start + n.dur), vel: n.vel ?? 0.8 }))
    .filter((n) => n.e > n.s);
  for (let i = 0; i < notes.length - 1; i++) if (notes[i].e > notes[i + 1].s) notes[i].e = notes[i + 1].s;
  const mono = notes.filter((n) => n.e > n.s);
  const endUnits = Math.max(q(songLengthBeats(project)), ...mono.map((n) => n.e), ...chords.map((c) => q(c.beat) + 1), 1);
  const nMeasures = Math.max(1, Math.ceil(endUnits / measure));
  const avg = mono.length ? mono.reduce((s, n) => s + n.pitch, 0) / mono.length : 64;
  const bassClef = avg < 55;

  const harmonyEl = (c, offset) => {
    const parsed = parseChordName(c.name);
    if (!parsed) return null;
    const r = STEP_ALTER(parsed.root, flats);
    const sym = c.name.replace(/^\s*[A-Ga-g][#♯b♭]?/, '').replace(/\/.*$/, '');
    const b = parsed.bass != null ? STEP_ALTER(parsed.bass, flats) : null;
    return el('harmony', {},
      el('root', {}, el('root-step', {}, r.step), r.alter ? el('root-alter', {}, String(r.alter)) : null),
      el('kind', { text: sym }, KIND_OUT[parsed.type] || 'other'),
      b ? el('bass', {}, el('bass-step', {}, b.step), b.alter ? el('bass-alter', {}, String(b.alter)) : null) : null,
      offset ? el('offset', {}, String(offset)) : null);
  };

  const noteEls = (pitch, dur, { tieStart, tieStop, vel }) => splitDuration(dur).map(([d, type, dots, triplet], i, arr) => {
    const first = i === 0;
    const last = i === arr.length - 1;
    const ts = pitch !== null && (!last || tieStart);
    const tp = pitch !== null && (!first || tieStop);
    let pitchEl;
    if (pitch === null) pitchEl = el('rest');
    else {
      const sa = STEP_ALTER(pitch, flats);
      pitchEl = el('pitch', {}, el('step', {}, sa.step), sa.alter ? el('alter', {}, String(sa.alter)) : null, el('octave', {}, String(Math.floor(pitch / 12) - 1)));
    }
    return el('note', pitch !== null ? { dynamics: Math.round((vel * 127 / 90) * 10000) / 100 } : {},
      pitchEl, el('duration', {}, String(d)),
      tp ? el('tie', { type: 'stop' }) : null, ts ? el('tie', { type: 'start' }) : null,
      el('voice', {}, '1'), el('type', {}, type), dots ? el('dot') : null,
      triplet ? el('time-modification', {}, el('actual-notes', {}, '3'), el('normal-notes', {}, '2')) : null,
      tp || ts ? el('notations', {}, tp ? el('tied', { type: 'stop' }) : null, ts ? el('tied', { type: 'start' }) : null) : null);
  });

  const harmonies = chords.map((c) => ({ pos: q(c.beat), c }));
  const markers = (project.markers || []).map((m) => ({ pos: q(m.beat), name: m.name || 'Marker' }));
  const measures = [];
  let ni = 0;
  for (let m = 0; m < nMeasures; m++) {
    const m0 = m * measure;
    const m1 = m0 + measure;
    const items = [];
    if (m === 0) {
      items.push(el('attributes', {},
        el('divisions', {}, String(DIVISIONS)),
        el('key', {}, el('fifths', {}, String(fifths)), el('mode', {}, minor ? 'minor' : 'major')),
        el('time', {}, el('beats', {}, String(num)), el('beat-type', {}, String(den))),
        el('clef', {}, el('sign', {}, bassClef ? 'F' : 'G'), el('line', {}, bassClef ? '4' : '2'))));
      items.push(el('direction', { placement: 'above' },
        el('direction-type', {}, el('metronome', {}, el('beat-unit', {}, 'quarter'), el('per-minute', {}, String(project.bpm)))),
        el('sound', { tempo: project.bpm })));
    }
    // events: rests + notes (split at the barline, tied across)
    const events = [];
    let cur = m0;
    while (ni < mono.length && mono[ni].e <= m0) ni++;
    for (let j = ni; j < mono.length && mono[j].s < m1; j++) {
      const n = mono[j];
      const s = Math.max(n.s, m0);
      const e = Math.min(n.e, m1);
      if (s > cur) events.push({ s: cur, d: s - cur, pitch: null });
      events.push({ s, d: e - s, pitch: n.pitch, vel: n.vel, tieStop: n.s < m0, tieStart: n.e > m1 });
      cur = e;
    }
    if (cur < m1) events.push({ s: cur, d: m1 - cur, pitch: null });
    // attach harmonies / rehearsal marks to the event that contains their position
    const extras = [...harmonies.filter((h) => h.pos >= m0 && h.pos < m1).map((h) => ({ pos: h.pos, make: (off) => harmonyEl(h.c, off) })),
      ...markers.filter((h) => h.pos >= m0 && h.pos < m1).map((h) => ({
        pos: h.pos,
        make: (off) => el('direction', { placement: 'above' }, el('direction-type', {}, el('rehearsal', {}, h.name)), off ? el('offset', {}, String(off)) : null),
      }))].sort((a, b) => a.pos - b.pos);
    for (const ev of events) {
      for (const x of extras.filter((x2) => !x2.done && x2.pos < ev.s + ev.d)) { items.push(x.make(Math.max(0, x.pos - ev.s))); x.done = true; }
      items.push(...noteEls(ev.pitch, ev.d, ev));
    }
    measures.push(el('measure', { number: m + 1 }, items));
  }

  const title = opts.title || project.name || 'Untitled';
  const root = el('score-partwise', { version: '4.0' },
    el('work', {}, el('work-title', {}, title)),
    el('identification', {}, el('encoding', {}, el('software', {}, 'daW³'), el('encoding-date', {}, new Date().toISOString().slice(0, 10)))),
    el('part-list', {}, el('score-part', { id: 'P1' }, el('part-name', {}, track?.name || 'Melody'))),
    el('part', { id: 'P1' }, measures));
  const xml = toXml(root).replace(/^(<\?xml[^>]*\?>)\n/, '$1\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n');
  return { xml, trackId: track?.id || null, chords, report };
}

// ------------------------------------------------------------------------------------- import

const intText = (n, fallback = 0) => {
  const v = Number(n?.text?.trim());
  return Number.isFinite(v) ? v : fallback;
};

export function parseMusicXml(text) {
  const root = parseXml(text);
  if (root.name === 'score-timewise') throw new Error('Timewise MusicXML is not supported — export it as partwise.');
  if (root.name !== 'score-partwise') throw new Error('Not a MusicXML score (expected <score-partwise>).');
  const title = child(child(root, 'work'), 'work-title')?.text?.trim() || child(root, 'movement-title')?.text?.trim() || null;
  const names = new Map(children(child(root, 'part-list'), 'score-part').map((sp) => [sp.attrs.id, child(sp, 'part-name')?.text?.trim() || sp.attrs.id]));
  let bpm = null;
  let timeSig = null;
  let key = null;
  const chords = [];
  const markers = [];
  const report = { warnings: [] };
  const parts = [];
  children(root, 'part').forEach((part, pi) => {
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let mStart = 0; // in quarter notes
    const notes = [];
    const openTies = new Map(); // pitch -> note
    let unpitched = 0;
    for (const m of children(part, 'measure')) {
      let cur = 0; // divisions inside the measure
      let maxCur = 0;
      let lastStart = 0;
      const pos = () => mStart + cur / divisions;
      for (const e of m.children) {
        if (e.name === 'attributes') {
          const d = child(e, 'divisions');
          if (d) divisions = intText(d, 1) || 1;
          const t = child(e, 'time');
          if (t) { beats = intText(child(t, 'beats'), 4); beatType = intText(child(t, 'beat-type'), 4); if (!timeSig) timeSig = [beats, beatType]; }
          const k = child(e, 'key');
          if (k && !key) key = { fifths: intText(child(k, 'fifths'), 0), mode: child(k, 'mode')?.text?.trim() || 'major' };
        } else if (e.name === 'sound' && e.attrs.tempo && bpm === null) bpm = Number(e.attrs.tempo);
        else if (e.name === 'direction') {
          const snd = child(e, 'sound');
          if (snd?.attrs.tempo && bpm === null) bpm = Number(snd.attrs.tempo);
          const off = intText(child(e, 'offset'), 0);
          const reh = child(child(e, 'direction-type'), 'rehearsal');
          if (reh && pi === 0) markers.push({ beat: pos() + off / divisions, name: reh.text.trim() });
          if (bpm === null) {
            const met = child(child(e, 'direction-type'), 'metronome');
            const pm = met && child(met, 'per-minute');
            if (pm && child(met, 'beat-unit')?.text?.trim() === 'quarter') bpm = intText(pm, null);
          }
        } else if (e.name === 'harmony' && pi === 0) {
          const r = child(e, 'root');
          if (!r) continue;
          const rootPc = mod12((STEP_PC[child(r, 'root-step')?.text?.trim()] ?? 0) + intText(child(r, 'root-alter'), 0));
          const kindEl = child(e, 'kind');
          const sym = kindEl?.attrs.text;
          let parsed = sym !== undefined ? parseChordName(pitchClassName(rootPc, 'common') + sym) : null;
          if (!parsed) parsed = { root: rootPc, type: KIND_IN[kindEl?.text?.trim()] || 'maj' };
          const b = child(e, 'bass');
          if (b) parsed.bass = mod12((STEP_PC[child(b, 'bass-step')?.text?.trim()] ?? 0) + intText(child(b, 'bass-alter'), 0));
          const off = intText(child(e, 'offset'), 0);
          chords.push({ beat: Math.round((pos() + off / divisions) * 1e6) / 1e6, name: chordName(parsed) });
        } else if (e.name === 'backup') { cur -= intText(child(e, 'duration'), 0); } else if (e.name === 'forward') { cur += intText(child(e, 'duration'), 0); maxCur = Math.max(maxCur, cur); } else if (e.name === 'note') {
          if (child(e, 'grace') || child(e, 'cue')) continue;
          const dur = intText(child(e, 'duration'), 0);
          const isChord = !!child(e, 'chord');
          const start = isChord ? lastStart : cur;
          if (!isChord) lastStart = cur;
          const p = child(e, 'pitch');
          if (p) {
            const midi = (intText(child(p, 'octave'), 4) + 1) * 12 + (STEP_PC[child(p, 'step')?.text?.trim()] ?? 0) + intText(child(p, 'alter'), 0);
            const ties = children(e, 'tie').map((t) => t.attrs.type);
            const dyn = e.attrs.dynamics !== undefined ? Number(e.attrs.dynamics) : null;
            const vel = dyn !== null && Number.isFinite(dyn) ? clamp(Math.round(((dyn / 100) * 90 / 127) * 1000) / 1000, 0.01, 1) : 0.8;
            const st = mStart + start / divisions;
            const open = openTies.get(midi);
            if (ties.includes('stop') && open && Math.abs(open.start + open.dur - st) < 1e-6) {
              open.dur += dur / divisions;
              if (!ties.includes('start')) openTies.delete(midi);
            } else {
              const n = { pitch: midi, start: st, dur: dur / divisions, vel };
              notes.push(n);
              if (ties.includes('start')) openTies.set(midi, n); else openTies.delete(midi);
            }
          } else if (child(e, 'unpitched')) unpitched++;
          if (!isChord) cur += dur;
          maxCur = Math.max(maxCur, cur);
        }
      }
      const tsLen = (beats * 4 / beatType) * divisions;
      const len = m.attrs.implicit === 'yes' ? maxCur : Math.max(maxCur, tsLen);
      mStart += len / divisions;
    }
    if (unpitched) report.warnings.push(`${names.get(part.attrs.id) || part.attrs.id}: ${unpitched} unpitched (percussion) note(s) skipped.`);
    const round = (v) => Math.round(v * 1e6) / 1e6;
    parts.push({ id: part.attrs.id, name: names.get(part.attrs.id) || `Part ${pi + 1}`, notes: notes.map((n) => ({ ...n, start: round(n.start), dur: round(n.dur) })) });
  });
  return { title, bpm: bpm && bpm > 0 ? bpm : null, timeSig: timeSig || [4, 4], key, parts, chords, markers, report };
}

/** .musicxml / .xml text or compressed .mxl bytes. */
export async function readMusicXmlFile(input, opts = {}) {
  const bytes = typeof input === 'string' ? null : (input instanceof Uint8Array ? input : new Uint8Array(input));
  if (bytes && isZip(bytes)) {
    const files = await readZip(bytes, opts);
    const container = zipText(files, 'META-INF/container.xml');
    let path = null;
    if (container) {
      const rf = /full-path="([^"]+)"/.exec(container);
      if (rf) path = rf[1];
    }
    if (!path) path = [...files.keys()].find((n) => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n));
    const text = path && zipText(files, path);
    if (!text) throw new Error('Compressed MusicXML (.mxl) without a score file.');
    return parseMusicXml(text);
  }
  return parseMusicXml(typeof input === 'string' ? input : new TextDecoder().decode(bytes));
}

const fifthsToRoot = (fifths, mode) => {
  const majorRoot = mod12(fifths * 7);
  return mode === 'minor' ? mod12(majorRoot + 9) : majorRoot;
};

/** Adds every part with notes as an instrument track (one pattern + clip at bar 1); chord symbols become a chords track. */
export function addMusicXmlToProject(project, parsed, { setTempo = false, chordTrack = true, preset = 'saw-lead' } = {}) {
  const bpb = beatsPerBar(project);
  if (setTempo) {
    if (parsed.bpm) project.bpm = Math.round(parsed.bpm * 100) / 100;
    if (parsed.timeSig) project.timeSig = [...parsed.timeSig];
    if (parsed.key) project.key = { root: fifthsToRoot(parsed.key.fifths, parsed.key.mode), scale: parsed.key.mode === 'minor' ? 'minor' : 'major' };
    if (parsed.markers?.length) project.markers = parsed.markers.map((m, i) => ({ id: `mk_xml_${Date.now().toString(36)}_${i}`, beat: m.beat, name: m.name }));
  }
  const bars = (end) => Math.max(bpb, Math.ceil(end / bpb - 1e-6) * bpb);
  const trackIds = [];
  const add = (name, notes, instrument, role) => {
    const track = createTrack({ name, color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length], instrument, role });
    const length = bars(notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0));
    const pat = createPattern(track.id, { name, length, notes: notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
    track.activePatternId = pat.id;
    project.tracks.push(track);
    project.patterns[pat.id] = pat;
    project.clips.push(createClip(track.id, { patternId: pat.id, start: 0, length }));
    trackIds.push(track.id);
  };
  for (const part of parsed.parts) {
    if (!part.notes.length) continue;
    add(part.name, part.notes, { type: 'synth', preset, params: {} }, parsed.parts.length === 1 ? 'lead' : null);
  }
  if (chordTrack && parsed.chords?.length) {
    const end = Math.max(...parsed.parts.flatMap((p) => p.notes.map((n) => n.start + n.dur)), parsed.chords[parsed.chords.length - 1].beat + bpb);
    const notes = [];
    parsed.chords.forEach((c, i) => {
      const ch = parseChordName(c.name);
      if (!ch) return;
      const next = parsed.chords[i + 1]?.beat ?? Math.ceil(end / bpb) * bpb;
      const root = 48 + ch.root;
      for (const p of chordNotes(root, ch.type)) notes.push({ pitch: p, start: c.beat, dur: Math.max(0.25, next - c.beat), vel: 0.7 });
      if (ch.bass != null) notes.push({ pitch: 36 + ch.bass, start: c.beat, dur: Math.max(0.25, next - c.beat), vel: 0.7 });
    });
    if (notes.length) add('Chords', notes, { type: 'synth', preset: 'electric-piano', params: {} }, 'chords');
  }
  project.mode = 'song';
  return { trackIds };
}
