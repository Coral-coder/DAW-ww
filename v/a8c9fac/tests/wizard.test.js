import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIZARD_STEPS, STEP_IDS, MOODS, detectProgress, nextOpenStep, moodScale, suggestProgressions, loopBarsFor,
  planArrangement, applyArrangement, addSidechain, wizardRole, ARRANGER_FORM,
} from '../src/ui/wizard-core.js';
import { GENRES } from '../src/gen/genres.js';
import { PROGRESSIONS, isMinorScale, romanToChord, scalePitchClasses, chordPitchClasses } from '../src/theory/index.js';
import { createProject, createTrack, createPattern, createNote, createClip } from '../src/core/model.js';

function addPart(p, role, notes, opts = {}) {
  const t = createTrack({ name: role, role, instrument: role === 'drums' || role === 'perc' ? { type: 'drums', preset: '909', params: {} } : { type: 'synth', preset: null, params: {} } });
  const pat = createPattern(t.id, { length: opts.length || 16, notes });
  t.activePatternId = pat.id;
  p.tracks.push(t);
  p.patterns[pat.id] = pat;
  return t;
}
const chordNotes = () => [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]].flatMap((c, i) => c.map((m) => createNote(m, i * 4, 4, 0.7)));

test('wizard: ten steps in teaching order', () => {
  assert.deepEqual(STEP_IDS, ['vibe', 'key', 'beat', 'bass', 'chords', 'melody', 'layers', 'arrange', 'mix', 'finish']);
  for (const s of WIZARD_STEPS) assert.ok(s.title && s.short);
});

test('wizard: detectProgress on an empty project → nothing done, first step open', () => {
  const p = createProject();
  const d = detectProgress(p);
  for (const id of STEP_IDS) assert.equal(d[id], false, id);
  assert.equal(nextOpenStep(d), 0);
  assert.equal(d.hasMelodicNotes, false);
});

test('wizard: detectProgress finds drums, bass, chords, melody, layers and arrangement', () => {
  const p = createProject({ genre: 'house' });
  p.genre = 'house';
  const empty = addPart(p, 'bass', []); // an empty bass track is not a bassline
  let d = detectProgress(p);
  assert.ok(d.vibe);
  assert.equal(d.bass, false);
  const drums = addPart(p, 'drums', [createNote(36, 0, 0.25), createNote(36, 1, 0.25)], { length: 4 });
  d = detectProgress(p);
  assert.ok(d.beat && !d.bass && !d.chords);
  assert.equal(d.ids.drums, drums.id);
  assert.equal(nextOpenStep(d), 1, 'key still needs confirming');
  assert.equal(nextOpenStep(d, { key: true }), 3, 'bass is next');
  p.patterns[empty.activePatternId].notes = [createNote(33, 0, 1)];
  addPart(p, 'chords', chordNotes());
  addPart(p, 'lead', [createNote(72, 0, 1), createNote(74, 1, 1)]);
  d = detectProgress(p);
  assert.ok(d.bass && d.chords && d.melody && d.hasMelodicNotes);
  assert.equal(d.layers, false);
  addPart(p, 'pad', chordNotes());
  assert.ok(detectProgress(p).layers);
  // a melodic track with stacked chords but no role still counts as chords
  const q = createProject();
  const t = addPart(q, 'other', chordNotes());
  t.role = null;
  assert.equal(wizardRole(t), 'other');
  assert.equal(detectProgress(q).chords, false, 'unlabelled tracks are not assumed to be the chord part');
  q.tracks[0].role = 'chords';
  assert.ok(detectProgress(q).chords);
  p.clips.push(createClip(drums.id, { patternId: drums.activePatternId, start: 0, length: 16 }));
  assert.ok(detectProgress(p).arrange);
});

test('wizard: mood biases the scale toward the genre\'s own scales', () => {
  assert.equal(moodScale('house', 'chill').scale, 'dorian');
  assert.equal(moodScale('trap', 'dark').scale, 'phrygian');
  assert.equal(moodScale('pop', 'uplifting').scale, 'major');
  assert.equal(moodScale('trance', 'dark').scale, 'minor');
  // genre has no bright scale: the mood wins (and says so)
  const t = moodScale('trap', 'uplifting');
  assert.equal(t.scale, 'major');
  assert.match(t.why, /usually/);
  assert.ok(moodScale('house').scale, 'no mood → genre default');
  for (const m of Object.keys(MOODS)) for (const g of Object.keys(GENRES)) assert.ok(moodScale(g, m).scale, `${g}/${m}`);
});

test('wizard: progression suggestions fit the genre, mode and key', () => {
  const tr = suggestProgressions('trance', 9, 'minor', { mood: 'dark' });
  assert.equal(tr[0].id, 'aeolian-loop', 'trance leads with the epic minor loop');
  assert.deepEqual(tr[0].chords.map((c) => c.name), ['Am', 'F', 'C', 'G']);
  assert.deepEqual(tr[0].romans, ['i', 'bVI', 'bIII', 'bVII']);
  assert.match(tr[0].why, /epic minor loop/);
  const pop = suggestProgressions('pop', 0, 'major', { mood: 'uplifting' });
  assert.equal(pop[0].id, 'pop-axis');
  assert.deepEqual(pop[0].chords.map((c) => c.name), ['C', 'G', 'Am', 'F']);
  // every genre × common key gets 3–4 suggestions, all matching the key's mode and the scale's notes
  for (const gid of Object.keys(GENRES)) {
    for (const scale of ['minor', 'major', 'dorian', 'phrygian']) {
      const s = suggestProgressions(gid, 2, scale, { mood: 'chill' });
      assert.ok(s.length >= 3 && s.length <= 4, `${gid} ${scale}: ${s.length}`);
      const minor = isMinorScale(scale);
      const set = new Set(scalePitchClasses(0, scale));
      for (const x of s) {
        const mode = PROGRESSIONS[x.id].mode;
        assert.ok(mode === 'any' || (minor ? ['minor', 'phrygian'] : ['major', 'lydian']).includes(mode), `${gid} ${scale} ${x.id} (${mode})`);
        assert.ok(x.chords.length >= 2 && x.chords.every((c) => c.name && c.roman && c.fnLabel), x.id);
        for (const r of x.romans) {
          if (/^[b#♭♯]|\//.test(r)) continue; // borrowed colour chords are intentional
          const c = romanToChord(r, 0, scale);
          assert.ok(chordPitchClasses(c.root, c.type).slice(0, 3).every((pc) => set.has(pc)), `${gid} ${scale} ${x.id}: ${r} outside the scale`);
        }
      }
      assert.equal(new Set(s.map((x) => x.id)).size, s.length, 'no duplicates');
    }
  }
});

test('wizard: loop length for progressions', () => {
  assert.equal(loopBarsFor(4), 4);
  assert.equal(loopBarsFor(2), 4);
  assert.equal(loopBarsFor(8), 8);
  assert.equal(loopBarsFor(12), 12);
  assert.equal(loopBarsFor(40), 16);
});

test('wizard: arranger lays the user\'s patterns out as a song with sweeps', () => {
  const p = createProject();
  p.bpm = 124;
  const drums = addPart(p, 'drums', [createNote(36, 0, 0.25)], { length: 8 });
  const bass = addPart(p, 'bass', [createNote(33, 0, 1)]);
  const chords = addPart(p, 'chords', chordNotes());
  const lead = addPart(p, 'lead', [createNote(72, 0, 1)]);
  addPart(p, 'pad', []); // empty: left out
  p.clips.push(createClip(drums.id, { patternId: drums.activePatternId, start: 64, length: 4 }));
  p.clips.push({ ...createClip(drums.id, { start: 0, length: 4 }), type: 'audio' });
  const plan = planArrangement(p);
  assert.deepEqual(plan.sections.map((s) => s.name), ARRANGER_FORM.map((s) => s.name));
  const sec = Object.fromEntries(plan.sections.map((s) => [s.name + s.start, s]));
  const intro = plan.sections[0];
  assert.deepEqual(intro.trackIds, [drums.id], 'intro = drums only');
  assert.deepEqual(plan.sections[1].trackIds.sort(), [drums.id, bass.id].sort(), 'verse = drums + bass');
  const chorus = plan.sections.find((s) => s.name === 'Chorus');
  assert.deepEqual(chorus.trackIds.sort(), [drums.id, bass.id, chords.id, lead.id].sort(), 'chorus = everything');
  const brk = plan.sections.find((s) => s.name === 'Break');
  assert.ok(!brk.trackIds.includes(drums.id) && !brk.trackIds.includes(bass.id), 'break drops drums & bass');
  assert.ok(sec && plan.totalBeats === ARRANGER_FORM.reduce((s, x) => s + x.bars, 0) * 4);
  // sections are contiguous, clips sit inside their section and reference real patterns
  let at = 0;
  for (const s of plan.sections) { assert.equal(s.start, at); at += s.bars * 4; }
  for (const c of plan.clips) assert.ok(p.patterns[c.patternId] && p.patterns[c.patternId].trackId === c.trackId);
  assert.equal(plan.clips.length, plan.sections.reduce((n, s) => n + s.trackIds.length, 0));
  assert.ok(plan.sweeps.some((sw) => sw.trackId === drums.id && sw.a === 0), 'filtered intro');
  assert.ok(plan.sweeps.filter((sw) => sw.trackId === chords.id).length === 2, 'two builds sweep the chords');
  applyArrangement(p, plan);
  assert.equal(p.mode, 'song');
  assert.equal(p.clips.filter((c) => c.type === 'audio').length, 1, 'audio clips are kept');
  assert.equal(p.clips.filter((c) => c.type !== 'audio').length, plan.clips.length, 'old pattern clips replaced');
  assert.equal(p.markers.length, plan.sections.length);
  assert.equal(p.loop.end, plan.totalBeats);
  const f = p.tracks.find((t) => t.id === chords.id).fx.find((x) => x.type === 'filter');
  assert.ok(f, 'filter inserted for the sweep');
  const lane = p.tracks.find((t) => t.id === chords.id).automation.find((l) => l.target === `fx:${f.id}:cutoff`);
  assert.ok(lane && lane.points.length >= 8, 'one lane with both builds');
  assert.ok(lane.points.every((pt, i, a) => i === 0 || a[i - 1].beat <= pt.beat), 'sorted');
  // re-arranging reuses the filter and replaces the lane
  applyArrangement(p, planArrangement(p));
  const t2 = p.tracks.find((t) => t.id === chords.id);
  assert.equal(t2.fx.filter((x) => x.type === 'filter').length, 1);
  assert.equal(t2.automation.filter((l) => l.target === `fx:${f.id}:cutoff`).length, 1);
  // slow tempo → shorter sections
  const q = createProject();
  q.bpm = 80;
  addPart(q, 'drums', [createNote(36, 0, 0.25)], { length: 4 });
  assert.equal(planArrangement(q).sections[3].bars, 8);
  assert.equal(planArrangement(createProject()).clips.length, 0, 'nothing to arrange');
});

test('wizard: sidechain ducks bass / chords from the drums once', () => {
  const p = createProject();
  const drums = addPart(p, 'drums', [createNote(36, 0, 0.25)]);
  addPart(p, 'bass', [createNote(33, 0, 1)]);
  addPart(p, 'chords', chordNotes());
  addPart(p, 'lead', [createNote(72, 0, 1)]);
  assert.equal(addSidechain(p), 2);
  const duck = p.tracks.find((t) => t.role === 'bass').fx.find((f) => f.type === 'ducker');
  assert.equal(duck.params.sourceTrackId, drums.id);
  assert.equal(p.tracks.find((t) => t.role === 'lead').fx.length, 0);
  assert.equal(addSidechain(p), 0, 'idempotent');
  assert.equal(addSidechain(createProject()), 0);
});
