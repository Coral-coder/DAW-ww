import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/theory/index.js';

const pcs = (arr) => arr.map((n) => ((n % 12) + 12) % 12);

test('note names and parsing', () => {
  assert.equal(T.noteName(60), 'C4');
  assert.equal(T.noteName(61), 'C#4');
  assert.equal(T.noteName(61, true), 'Db4');
  assert.equal(T.noteName(21), 'A0');
  assert.equal(T.parseNote('C4'), 60);
  assert.equal(T.parseNote('c#4'), 61);
  assert.equal(T.parseNote('eb3'), 51);
  assert.equal(T.parseNote('c'), 60);
  assert.equal(T.parseNote('B#3'), 60);
  assert.equal(T.parseNote('Cb4'), 59);
  assert.equal(T.parseNote('a-1'), 9);
  assert.equal(T.parseNote('nope'), null);
  assert.equal(T.pitchClassName(10), 'A#');
  assert.equal(T.pitchClassName(10, true), 'Bb');
  assert.equal(T.pitchClassName(10, 'common'), 'Bb');
  assert.equal(T.parsePitchClass('F#'), 6);
});

test('intervals and transposition', () => {
  assert.equal(T.intervalName(7), 'P5');
  assert.equal(T.intervalName(3), 'm3');
  assert.equal(T.intervalName(6), 'TT');
  assert.equal(T.intervalName(14), 'M9');
  assert.equal(T.intervalName('C4', 'G4'), 'P5');
  assert.equal(T.intervalName(4, { long: true }), 'major 3rd');
  assert.equal(T.transpose(60, 5), 65);
  assert.equal(T.transpose('C4', 2), 'D4');
  assert.equal(T.transpose('Bb3', 2), 'C4');
  assert.deepEqual(T.transpose([60, 64], 12), [72, 76]);
  assert.equal(T.transpose({ root: 0, type: 'maj' }, 7).root, 7);
});

test('scales: required catalogue with valid intervals', () => {
  const required = ['major', 'minor', 'harmonic-minor', 'melodic-minor', 'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
    'major-pentatonic', 'minor-pentatonic', 'blues', 'major-blues', 'whole-tone', 'diminished-hw', 'diminished-wh', 'chromatic', 'phrygian-dominant',
    'hungarian-minor', 'double-harmonic', 'japanese-in', 'hirajoshi', 'arabic', 'bebop-dominant', 'lydian-dominant', 'altered', 'neapolitan-minor',
    'neapolitan-major', 'egyptian', 'prometheus'];
  for (const id of required) {
    const s = T.SCALES[id];
    assert.ok(s, `missing scale ${id}`);
    assert.equal(s.intervals[0], 0, id);
    for (let i = 1; i < s.intervals.length; i++) assert.ok(s.intervals[i] > s.intervals[i - 1] && s.intervals[i] < 12, id);
  }
  assert.deepEqual(T.SCALES.dorian.intervals, [0, 2, 3, 5, 7, 9, 10]);
  assert.deepEqual(T.SCALES['phrygian-dominant'].intervals, [0, 1, 4, 5, 7, 8, 10]);
  assert.deepEqual(T.SCALES.blues.intervals, [0, 3, 5, 6, 7, 10]);
});

test('scale notes, membership and snapping', () => {
  assert.deepEqual(T.scaleNotes(0, 'major', 4), [60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepEqual(T.scalePitchClasses(9, 'minor'), [9, 11, 0, 2, 4, 5, 7]);
  assert.ok(T.inScale(64, 0, 'major'));
  assert.ok(!T.inScale(63, 0, 'major'));
  assert.ok(T.inScale(63, 0, 'minor'));
  assert.equal(T.snapToScale(61, 0, 'major'), 60);
  assert.equal(T.snapToScale(61, 0, 'major', 1), 62);
  assert.equal(T.snapToScale(66, 0, 'major'), 65);
  assert.equal(T.stepInScale(60, 1, 0, 'major'), 62);
  assert.equal(T.stepInScale(71, 1, 0, 'major'), 72);
  assert.equal(T.stepInScale(60, -1, 0, 'major'), 59);
  assert.equal(T.stepInScale(60, 7, 0, 'major'), 72);
  assert.equal(T.stepInScale(57, 2, 9, 'minor-pentatonic'), 62);
  assert.equal(T.resolveScaleId('aeolian'), 'minor');
});

test('chord types: required set and spellings', () => {
  const required = ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4', '5', '6', 'm6', '7', 'maj7', 'm7', 'm7b5', 'dim7', 'mMaj7', '9', 'maj9', 'm9',
    'add9', 'madd9', '11', 'm11', '13', 'maj13', '7sus4', '7b9', '7#9', '7#11', 'aug7'];
  for (const id of required) assert.ok(T.CHORD_TYPES[id], `missing chord ${id}`);
  assert.deepEqual(T.chordNotes(60, 'maj7'), [60, 64, 67, 71]); // C E G B
  assert.deepEqual(T.chordNotes(60, 'min'), [60, 63, 67]);
  assert.deepEqual(T.chordNotes(62, 'm7b5'), [62, 65, 68, 72]);
  assert.deepEqual(pcs(T.chordNotes(67, '7')), [7, 11, 2, 5]);
  assert.deepEqual(T.chordNotes(60, 'maj', { inversion: 1 }), [64, 67, 72]);
  assert.deepEqual(T.chordNotes(60, 'maj', { inversion: 2 }), [67, 72, 76]);
  assert.deepEqual(T.chordNotes(60, 'maj7', { voicing: 'drop2' }), [55, 60, 64, 71]);
  const open = T.chordNotes(60, 'maj', { voicing: 'open' });
  assert.deepEqual(pcs(open).sort(), [0, 4, 7]);
  assert.ok(open[open.length - 1] - open[0] > 12);
  const spread = T.chordNotes(60, 'maj7', { voicing: 'spread' });
  assert.equal(spread[0], 48);
  assert.equal(T.chordName({ root: 0, type: 'maj7' }), 'Cmaj7');
  assert.equal(T.chordName({ root: 6, type: 'm7b5' }), 'F#m7b5');
  assert.equal(T.chordName({ root: 10, type: 'min' }), 'Bbm');
  assert.deepEqual(T.parseChordName('Ebmaj7'), { root: 3, type: 'maj7' });
  assert.deepEqual(T.parseChordName('G7/B'), { root: 7, type: '7', bass: 11 });
});

test('detectChord', () => {
  assert.equal(T.detectChord([60, 64, 67, 71]).name, 'Cmaj7');
  assert.equal(T.detectChord([57, 60, 64, 67]).name, 'Am7'); // bass A -> Am7 not C6
  assert.equal(T.detectChord([60, 64, 67, 69]).name, 'C6');
  const inv = T.detectChord([64, 67, 72]);
  assert.equal(inv.root, 0);
  assert.equal(inv.type, 'maj');
  assert.equal(inv.inversion, 1);
  assert.equal(T.detectChord([62, 65, 69]).name, 'Dm');
  assert.equal(T.detectChord([67, 71, 74, 77]).name, 'G7');
  assert.equal(T.detectChord([60, 64, 70]).name, 'C7'); // 5th omitted
  assert.equal(T.detectChord([59, 62, 65, 68]).type, 'dim7');
  assert.equal(T.detectChord([]), null);
});

test('diatonic chords in major and minor', () => {
  const romans = T.diatonicChords(0, 'major').map((c) => c.roman);
  assert.deepEqual(romans, ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  const sev = T.diatonicChords(0, 'major', { sevenths: true }).map((c) => c.name);
  assert.deepEqual(sev, ['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5']);
  const minor = T.diatonicChords(9, 'minor').map((c) => c.roman);
  assert.deepEqual(minor, ['i', 'ii°', 'bIII', 'iv', 'v', 'bVI', 'bVII']);
  const hm = T.diatonicChord(9, 'harmonic-minor', 4, { sevenths: true });
  assert.equal(hm.name, 'E7');
  assert.equal(T.diatonicChord(0, 'major', 0, { extensions: 1 }).type, 'maj9');
  assert.equal(T.diatonicChord(0, 'major', 4, { extensions: 3 }).type, '13');
  // pentatonic falls back to its parent heptatonic scale
  assert.equal(T.diatonicChord(9, 'minor-pentatonic', 3).name, 'Dm');
  assert.equal(T.diatonicChord(0, 'whole-tone', 0).type, 'aug');
});

test('romanToChord handles accidentals, case, °, ø, extensions, sus and secondaries', () => {
  const c = (r, s = 'major', k = 0) => T.romanToChord(r, k, s);
  assert.equal(c('bVII').name, 'Bb');
  assert.deepEqual(c('bVII').notes, [10, 2, 5]);
  assert.equal(c('ii').name, 'Dm');
  assert.equal(c('V7').name, 'G7');
  assert.equal(c('ii7').name, 'Dm7');
  assert.equal(c('IVmaj7').name, 'Fmaj7');
  assert.equal(c('vii°').name, 'Bdim');
  assert.equal(c('vii°7').name, 'Bdim7');
  assert.equal(c('iiø7').name, 'Dm7b5');
  assert.equal(c('bIII+').type, 'aug');
  assert.equal(c('Vsus4').name, 'Gsus4');
  assert.equal(c('V7sus4').type, '7sus4');
  assert.equal(c('ii9').type, 'm9');
  assert.equal(c('V13').type, '13');
  assert.equal(c('I5').type, '5');
  assert.equal(c('#iv°7').name, 'F#dim7');
  assert.equal(c('bII7').name, 'Db7');
  assert.equal(c('V/V').name, 'D');
  assert.equal(c('V7/vi').name, 'E7');
  assert.equal(c('vii°7/V').name, 'F#dim7');
  // minor key: unaccidentaled numerals follow the scale, vii° is the leading tone
  assert.equal(c('VI', 'minor').name, 'Ab');
  assert.equal(c('III', 'minor').name, 'Eb');
  assert.equal(c('bVI', 'minor').name, 'Ab');
  assert.equal(c('V', 'minor').name, 'G');
  assert.equal(c('vii°', 'minor').name, 'Bdim');
  assert.equal(c('imaj7', 'minor').type, 'mMaj7');
  assert.equal(c('bVII', 'major', 9).name, 'G');
  assert.equal(c('xyz'), null);
  // round trip
  for (const ch of T.diatonicChords(4, 'minor', { sevenths: true })) {
    const back = T.romanToChord(ch.roman, 4, 'minor');
    assert.equal(back.root, ch.root, ch.roman);
    assert.equal(back.type, ch.type, ch.roman);
  }
});

test('detectKey (Krumhansl–Schmuckler)', () => {
  assert.equal(T.detectKey(T.scaleNotes(0, 'major', 4))[0].name, 'C major');
  const aMinor = [57, 60, 64, 57, 59, 60, 62, 64, 65, 64, 62, 60, 59, 56, 57].map((p, i) => ({ pitch: p, start: i, dur: p % 12 === 9 ? 2 : 1, vel: 0.8 }));
  const k = T.detectKey(aMinor)[0];
  assert.equal(k.root, 9);
  assert.equal(k.scale, 'minor');
  const g = T.detectKey(T.scaleNotes(7, 'major', 3, { octaves: 2 }))[0];
  assert.deepEqual([g.root, g.scale], [7, 'major']);
  const ebm = T.detectKey([...T.chordNotes(63, 'min'), ...T.chordNotes(63, 'min'), ...T.scaleNotes(3, 'minor', 4)])[0];
  assert.deepEqual([ebm.root, ebm.scale], [3, 'minor']);
  assert.deepEqual(T.detectKey([]), []);
});

test('voice leading moves smoothly and stays in range', () => {
  const prev = [60, 64, 67];
  const next = T.voiceLead(prev, [5, 9, 0], [52, 76]); // C -> F
  assert.deepEqual(pcs(next).sort((a, b) => a - b), [0, 5, 9]);
  const moved = next.reduce((s, n, i) => s + Math.abs(n - prev[i]), 0);
  assert.ok(moved <= 5, `moved ${moved}`);
  const g7 = T.voiceLead([], [7, 11, 2, 5], [52, 76]);
  assert.ok(g7.every((n) => n >= 52 && n <= 76));
  assert.equal(g7.length, 4);
});

test('keys: relative, parallel, circle of fifths, signatures', () => {
  assert.deepEqual(T.relativeKey(0, 'major'), { root: 9, scale: 'minor' });
  assert.deepEqual(T.relativeKey(9, 'minor'), { root: 0, scale: 'major' });
  assert.deepEqual(T.relativeKey(2, 'dorian'), { root: 0, scale: 'major' });
  assert.deepEqual(T.parallelKey(0, 'major'), { root: 0, scale: 'minor' });
  assert.deepEqual(T.parallelKey(9, 'minor'), { root: 9, scale: 'major' });
  const nb = T.circleNeighbors(0, 'major');
  assert.equal(nb.dominant.root, 7);
  assert.equal(nb.subdominant.root, 5);
  assert.equal(nb.relative.root, 9);
  assert.equal(T.fifthsDistance(0, 7), 1);
  assert.equal(T.fifthsDistance(0, 6), 6);
  assert.equal(T.keySignature(7, 'major'), 1);
  assert.equal(T.keySignature(5, 'major'), -1);
  assert.equal(T.keySignature(9, 'minor'), 0);
  assert.equal(T.keyName(10, 'major'), 'Bb major');
  assert.deepEqual(T.parseKey('F# minor'), { root: 6, scale: 'minor' });
  assert.deepEqual(T.parseKey('Am'), { root: 9, scale: 'minor' });
});

test('progression library: 60+ entries, all romans parse, tagged', () => {
  const entries = Object.entries(T.PROGRESSIONS);
  assert.ok(entries.length >= 60, `only ${entries.length}`);
  for (const [id, p] of entries) {
    assert.ok(p.name && p.genres.length && p.moods.length, id);
    if (p.durs) assert.equal(p.durs.length, p.romans.length, id);
    const scale = p.mode === 'any' ? 'major' : p.mode;
    for (const r of p.romans) assert.ok(T.romanToChord(r, 0, scale), `${id}: ${r}`);
  }
  for (const id of ['pop-axis', 'fifties', 'ii-v-i', 'twelve-bar-blues', 'andalusian', 'royal-road', 'aeolian-loop', 'canon', 'sad-trap', 'house-minor-7', 'gospel-walk', 'neo-soul-251', 'phrygian-flamenco', 'cinematic-epic']) {
    assert.ok(T.PROGRESSIONS[id], id);
  }
  assert.equal(T.PROGRESSIONS['twelve-bar-blues'].romans.length, 12);
  assert.ok(T.findProgressions({ genre: 'trap' }).length >= 2);
});

test('suggestNextChords uses functional harmony with readable reasons', () => {
  const s = T.suggestNextChords(['I', 'IV', 'V'], 0, 'major');
  assert.equal(s[0].roman, 'I');
  assert.match(s[0].reason, /resolution/);
  for (const x of s) {
    assert.ok(x.chord && typeof x.reason === 'string' && x.reason.length > 10);
    assert.ok(x.score > 0 && x.score <= 1);
  }
  const fromII = T.suggestNextChords(['ii'], 0, 'major');
  assert.equal(fromII[0].chord.root, 7, 'ii -> V');
  const borrowed = T.suggestNextChords(['I'], 0, 'major', null, { limit: 30 });
  assert.ok(borrowed.some((x) => x.roman === 'bVI' && /borrowed/.test(x.reason)));
  assert.ok(borrowed.some((x) => /secondary dominant/.test(x.reason)));
  const minor = T.suggestNextChords(['i', 'bVI'], 9, 'minor', 'trance');
  assert.ok(minor.slice(0, 3).some((x) => x.roman === 'bVII'));
  const start = T.suggestNextChords([], 0, 'major');
  assert.equal(start[0].roman, 'I');
  const sec = T.suggestNextChords(['I', 'V7/vi'], 0, 'major');
  assert.equal(sec[0].chord.root, 9, 'secondary dominant resolves to vi');
});

test('analyzeProgression finds cadences, borrowed chords and secondary dominants', () => {
  const a = T.analyzeProgression(['ii7', 'V7', 'Imaj7', 'VI7'], 0, 'major');
  assert.ok(a.cadences.some((c) => c.type === 'ii-V-I'));
  assert.ok(a.cadences.some((c) => c.type === 'authentic'));
  assert.equal(a.secondaryDominants.length, 1);
  assert.equal(a.secondaryDominants[0].target, 'ii');
  const b = T.analyzeProgression(['I', 'bVI', 'bVII', 'I'], 0, 'major');
  assert.ok(b.borrowed.some((x) => x.roman === 'bVI'));
  assert.ok(b.cadences.some((c) => c.type === 'aeolian'));
  const c = T.analyzeProgression(['I', 'V', 'vi', 'IV'], 0, 'major');
  assert.ok(c.cadences.some((x) => x.type === 'deceptive'));
  assert.equal(T.chordFunction('V7', 0, 'major'), 'dominant');
  assert.equal(T.chordFunction('IV', 0, 'major'), 'subdominant');
  assert.equal(T.chordFunction('vi', 0, 'major'), 'tonic');
});
