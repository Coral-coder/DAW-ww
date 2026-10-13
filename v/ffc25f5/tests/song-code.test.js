// Song-as-code: source locations for live highlighting, project -> code round trips, apply-back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, queryEvents, splitTopLevel, transformSource } from '../src/code/strudel.js';
import { songToCode, applySongCode, snapBeat, notesToVoices, labelFor } from '../src/code/song-code.js';
import { drumPitch } from '../src/code/convert.js';
import { generateSong } from '../src/gen/song.js';
import { createProject, createTrack, createPattern, createNote, beatsPerBar } from '../src/core/model.js';
import { songFaith } from './lib/song-faith.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
/** [begin, token text] of each event, sorted. */
function located(code, b = 0, e = 1) {
  const r = evaluate(code);
  assert.equal(r.error, null, r.error);
  return queryEvents(r, b, e).map((ev) => [+ev.begin.toFixed(4), ev.locations.map((l) => code.slice(l.start, l.end)).join('|'), ev.locations[0]?.start]);
}

// ------------------------------------------------------------------------------ locations

test('locations: atoms map to their characters in the source', () => {
  const code = 's("bd [sd hh]")';
  assert.deepEqual(located(code), [[0, 'bd', 3], [0.5, 'sd', 7], [0.75, 'hh', 10]]);
});

test('locations survive fast, *, <>, stack and labels', () => {
  const fast = located('s("bd [sd hh]").fast(2)');
  assert.deepEqual(fast.map((x) => x[1]), ['bd', 'sd', 'hh', 'bd', 'sd', 'hh']);
  assert.deepEqual(fast.map((x) => x[2]), [3, 7, 10, 3, 7, 10]);
  // (real Strudel also locates the `*2` factor — the first location is the atom itself)
  const alt = located('s("<bd sd>*2 hh")', 0, 2);
  assert.deepEqual(alt.map((x) => x[1].split('|')[0]), ['bd', 'sd', 'hh', 'bd', 'sd', 'hh']);
  const st = located('stack(s("bd*2"), s("~ hh"))');
  assert.deepEqual(st.map((x) => x[1].split('|')[0]).sort(), ['bd', 'bd', 'hh']);
  assert.ok(st.filter((x) => x[1] === 'hh').every((x) => x[2] === 22));
  const code = '// tempo\nsetcpm(30)\ndrums: s("bd sd")\nbass: note("c2 eb2").s("saw")';
  const evs = queryEvents(evaluate(code), 0, 1);
  const bass = evs.filter((e) => e.name === 'bass');
  assert.deepEqual(bass.map((e) => e.locations.map((l) => code.slice(l.start, l.end))), [['c2', 'saw'], ['eb2', 'saw']]);
  assert.ok(evs.every((e) => typeof e.block === 'number'));
});

test('locations: combined controls, backticks and active-window queries', () => {
  const code = 'note(`<c3 e3>`).velocity(".5 .8")';
  const evs = queryEvents(evaluate(code), 1, 2);
  // structure comes from the left: one event, highlighted together with the velocity it got
  assert.deepEqual(evs.map((e) => e.locations.map((l) => code.slice(l.start, l.end))), [['e3', '.5']]);
  // events overlapping a window (for highlighting) — a long note started earlier is still reported
  const long = queryEvents(evaluate('note("c3@3 e3")'), 0.5, 0.6, { active: true });
  assert.equal(long.length, 1);
  assert.equal(long[0].begin, 0);
});

test('labelled blocks end at top-level declarations; splitTopLevel', () => {
  const code = 'const a = s("bd")\ndrums: a.bank("909")\nconst b = note("c3")\nbass: b\n';
  const r = evaluate(code);
  assert.equal(r.error, null);
  assert.deepEqual(r.entries.map((e) => e.name), ['drums', 'bass']);
  assert.deepEqual(transformSource(code).labels.map((l) => code.slice(l.start, l.end).trim()), ['drums: a.bank("909")', 'bass: b']);
  assert.deepEqual(splitTopLevel(code).map((i) => [i.kind, i.name]), [['decl', 'a'], ['label', 'drums'], ['decl', 'b'], ['label', 'bass']]);
});

// ------------------------------------------------------------------------------ project -> code

test('notesToVoices writes compact, idiomatic mini-notation', () => {
  const kick = [0, 1, 2, 3].map((b) => createNote(36, b));
  const hats = Array.from({ length: 8 }, (_, i) => createNote(42, i * 0.5));
  const { voices } = notesToVoices([...kick, ...hats, createNote(38, 1), createNote(38, 3)], 4, { kind: 'drums' });
  assert.deepEqual(voices.map((v) => v.mini), ['bd*4', '[~ sd]*2', 'hh*8']);
  const mel = notesToVoices([createNote(48, 0, 4), createNote(52, 0, 4), createNote(55, 0, 4), createNote(45, 4, 4)], 8, {});
  assert.equal(mel.voices[0].mini, '<[c3,e3,g3] a2>');
  const held = notesToVoices([createNote(48, 0, 8), createNote(50, 8, 2)], 16, {});
  assert.equal(held.voices[0].mini, '<c3@2 [d3 ~] ~>');
  assert.equal(labelFor('Lead Synth 2'), 'lead_synth_2');
  assert.equal(labelFor('808'), 't_808');
});

function roundTrip(p) {
  const bpb = beatsPerBar(p);
  const { code, labels } = songToCode(p);
  // with clips the whole arrangement is written (any mode); without, the playing loop
  const f = songFaith(p, code, labels, p.clips.length ? {} : { end: 8 * bpb, mode: 'pattern' });
  return { ok: f.ok, total: f.total };
}

test('song code round trip: code -> notes == project notes (>=95%) across genres, both modes, and loops', () => {
  const genres = ['house', 'techno', 'jazz', 'lofi-hip-hop', 'drum-and-bass', 'reggae', 'salsa', 'ambient', 'funk', 'indie', 'chiptune', 'trap'];
  let all = 0, good = 0;
  for (const genre of genres) {
    for (const seed of [11, 42]) {
      for (const mode of ['pattern', 'song', 'loop']) {
        const base = { ...createProject(), ...generateSong({ genre, seed }), mode: mode === 'loop' ? 'pattern' : mode, swing: 0 };
        const p = mode === 'loop' ? { ...base, clips: [] } : base;
        const { ok, total } = roundTrip(p);
        assert.ok(total > 0, `${genre} ${seed} ${mode}: no notes`);
        assert.ok(ok / total >= 0.95, `${genre} ${seed} ${mode}: only ${ok}/${total} notes round-trip`);
        all += total; good += ok;
      }
    }
  }
  assert.ok(good / all >= 0.98, `overall ${good}/${all}`);
});

test('song code: header, labels, mutes, code tracks, empty project', () => {
  const empty = songToCode(createProject({ bpm: 100 }));
  assert.match(empty.code, /setcpm\(100\/4\)/);
  assert.match(empty.code, /no tracks yet/);
  assert.equal(evaluate(empty.code).error, null);
  const p = { ...createProject(), ...generateSong({ genre: 'house', seed: 5 }), mode: 'pattern' };
  p.tracks[1].mute = true;
  const ct = createTrack({ type: 'code', name: 'Groove' });
  ct.code = 'setcpm(30)\n$: s("cp*2")';
  p.tracks.push(ct);
  const { code } = songToCode(p);
  assert.match(code, /^drums: /m);
  assert.match(code, new RegExp(`^_${labelFor(p.tracks[1].name)}: `, 'm'));
  assert.match(code, /\/\/ \[project tempo\] setcpm\(30\)/);
  assert.match(code, /code track "Groove"/);
  const r = evaluate(code);
  assert.equal(r.error, null);
  assert.equal(r.cps, p.bpm / 60 / 4);
  // with clips (any mode): one const per section part + one arrange() per track
  const s = songToCode({ ...p, mode: 'song' }).code;
  assert.match(s, /^const \w+_drums\s*= /m);
  assert.match(s, /^drums: arrange\(/m);
  assert.equal(evaluate(s).error, null);
});

// ------------------------------------------------------------------------------ apply back

test('apply-back: unchanged code changes nothing; edits write notes, gain, mutes, new tracks', () => {
  const p = { ...createProject(), ...generateSong({ genre: 'house', seed: 3 }), mode: 'pattern', clips: [] };
  const { code } = songToCode(p);
  let q = clone(p);
  assert.equal(applySongCode(q, code).changed, false);
  assert.equal(JSON.stringify(q), JSON.stringify(p));

  // drums rewritten
  q = clone(p);
  const edited = code.replace(/drums: stack\([\s\S]*?\n\)\.bank/, 'drums: s("bd*4, ~ sd ~ sd").bank');
  let r = applySongCode(q, edited);
  assert.equal(r.error, null);
  const dt = q.tracks.find((t) => t.name === 'Drums');
  const dpat = q.patterns[dt.activePatternId];
  const bar1 = dpat.notes.filter((n) => n.start < 4).map((n) => `${n.pitch}@${n.start}`).sort();
  assert.deepEqual(bar1, ['36@0', '36@1', '36@2', '36@3', '38@1', '38@3'].sort());
  // regenerated code reflects the edit and re-applying it is a no-op
  const again = songToCode(q).code;
  assert.match(again, /drums: s\("bd\*4, \[~ sd\]\*2"\)\.bank\("RolandTR909"\)/);
  assert.equal(applySongCode(clone(q), again).changed, false);

  // remove bass (-> muted), mute lead with "_", change chords gain, add a new drum + melodic block
  const bassLabel = labelFor('Bass');
  let e2 = code.replace(new RegExp(`\\n${bassLabel}: [\\s\\S]*?\\n(?=\\n)`), '\n').replace('\nlead:', '\n_lead:')
    .replace(/(\nchords: [\s\S]*?\.s\("[^"]+"\)\s*)\.gain\([\d.]+\)/, '$1.gain(0.5)');
  e2 += '\nperc: s("[~ cp]*4").bank("808")\nhook: note("c4 e4 g4 c5").s("square")\n';
  q = clone(p);
  r = applySongCode(q, e2);
  assert.equal(r.error, null);
  assert.ok(q.tracks.find((t) => t.name === 'Bass').mute);
  assert.ok(q.tracks.find((t) => t.name === 'Lead').mute);
  assert.deepEqual(r.muted.sort(), ['Bass', 'Lead']);
  assert.equal(q.tracks.find((t) => t.name === 'Chords').volume, 0.4);
  const perc = q.tracks.find((t) => t.name === 'Perc');
  assert.equal(perc.instrument.type, 'drums');
  assert.equal(q.patterns[perc.activePatternId].notes.length, 4);
  const hook = q.tracks.find((t) => t.name === 'Hook');
  assert.deepEqual(q.patterns[hook.activePatternId].notes.map((n) => n.pitch), [60, 64, 67, 72]);
  assert.equal(q.tracks.length, p.tracks.length + 2);
});

test('apply-back: random / signal blocks are offered as code tracks; tempo + song-mode consts', () => {
  const p = { ...createProject(), ...generateSong({ genre: 'techno', seed: 9 }), mode: 'pattern', clips: [] };
  const { code } = songToCode(p);
  const e = code + '\nwobble: note("c2*8").s("sawtooth").lpf(sine.range(200, 2000))\n';
  let q = clone(p);
  let r = applySongCode(q, e);
  assert.equal(r.complex.length, 1);
  assert.equal(r.complex[0].label, 'wobble');
  assert.equal(q.tracks.length, p.tracks.length);
  q = clone(p);
  r = applySongCode(q, e, { keepComplexAsCode: true });
  const ct = q.tracks.find((t) => t.type === 'code');
  assert.ok(ct && /sine\.range/.test(ct.code));
  // tempo
  q = clone(p);
  applySongCode(q, code.replace(/setcpm\([\d.]+\/4\)/, 'setcpm(140/4)'));
  assert.equal(q.bpm, 140);
  // song mode: editing a section const rewrites that pattern
  const ps = { ...createProject(), ...generateSong({ genre: 'techno', seed: 9 }), mode: 'song' };
  const sc = songToCode(ps).code;
  const d = splitTopLevel(sc).find((it) => it.kind === 'decl' && it.name.endsWith('_bass'));
  assert.ok(d, 'bass const');
  q = clone(ps);
  r = applySongCode(q, sc.slice(0, d.start) + `const ${d.name} = note("c2 eb2 g2 bb2")` + sc.slice(d.end));
  assert.equal(r.error, null);
  const changed = Object.values(q.patterns).find((pat) => pat.notes.length && pat.notes.every((n) => [36, 39, 43, 46].includes(n.pitch)) && pat.trackId === q.tracks.find((t) => t.name === 'Bass').id);
  assert.ok(changed, 'pattern rewritten');
  // arrangement edits are applied to the clips (the first section gets 4 bars longer, the rest moves)
  q = clone(ps);
  r = applySongCode(q, sc.replace(/drums: arrange\(\n {2}\[(\d+),/, (s0, n) => `drums: arrange(\n  [${Number(n) + 4},`));
  assert.equal(r.error, null);
  assert.ok(r.changes.some((c) => /^Drums: arrangement/.test(c)), r.changes.join('; '));
  const dt = q.tracks.find((t) => t.name === 'Drums');
  const before = ps.clips.filter((c) => c.trackId === dt.id).sort((a, b) => a.start - b.start);
  const after = q.clips.filter((c) => c.trackId === dt.id).sort((a, b) => a.start - b.start);
  assert.equal(after[0].length, before[0].length + 16);
  assert.equal(after[after.length - 1].start, before[before.length - 1].start + 16);
  assert.deepEqual(q.clips.filter((c) => c.trackId !== dt.id), ps.clips.filter((c) => c.trackId !== dt.id));
});

test('samples() calls the injectable sample-pack loader once per pack; URL args stay strings', async () => {
  const { setSampleLoader } = await import('../src/code/strudel.js');
  const calls = [];
  setSampleLoader((map, base) => { calls.push([map, base]); return Promise.resolve(true); });
  try {
    const code = 'samples("github:someone/my-pack-test")\nsamples({ bass: ["b.wav"] }, "https://example.com/x/")\n$: s("bd")';
    assert.equal(evaluate(code).error, null);
    assert.equal(evaluate(code).error, null);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(calls, [['github:someone/my-pack-test', undefined], [{ bass: ['b.wav'] }, 'https://example.com/x/']]);
  } finally {
    setSampleLoader(null);
  }
});
