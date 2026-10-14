// Prebake (helper libraries evaluated before the user's code): engine (src/code/strudel-real.js setPrebake),
// manager (src/code/prebake.js), docs for autocomplete / palette, repair and split import with prebake helpers.
// The fixture is a small synthetic helper library written for these tests (tests/fixtures/prebake/helpers.strudel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadStrudel, codeEngine, evaluate, queryEvents } from '../src/code/strudel.js';
import { setPrebake, prebakeStatus, onPrebake, prebakeDefinedNames, prebakeGlobals } from '../src/code/strudel-real.js';
import {
  createPrebakeManager, parsePrebakeDocs, normalizeProjectPrebake, mergeProjectPrebake, undefinedCalls, sourcesDefining, toRawUrl, codeUses,
} from '../src/code/prebake.js';
import { buildCatalog, paletteGroups, completionsAt, applyCompletion, prebakeArgs } from '../src/code/assist.js';
import { repairStrudel } from '../src/code/repair.js';
import { splitStrudelToProject, analyzeStrudel } from '../src/code/import-split.js';
import { createProject } from '../src/core/model.js';
import { serializeProject, parseProjectFile } from '../src/io/project-file.js';
import { parseTarget } from '../src/core/automation.js';

if (!(await loadStrudel()) || codeEngine() !== 'strudel') throw new Error('vendored Strudel engine failed to load');

const FIXTURE = fs.readFileSync(new URL('./fixtures/prebake/helpers.strudel', import.meta.url), 'utf8');
const HELPERS = { id: 'helpers', name: 'helpers', code: FIXTURE };
const lineOf = (text) => FIXTURE.split('\n').findIndex((l) => l.includes(text)) + 1;
const first = (code) => {
  const r = evaluate(code);
  assert.equal(r.error, null, r.error);
  return queryEvents(r, 0, 1);
};

test('engine: the prebake defines methods, functions and globals the user code can call', () => {
  const st = setPrebake([HELPERS]);
  assert.equal(st.applied, true);
  for (const m of ['pg', 'acidenv', 'dly', 'rlpf', 'rhpf', 'o', 'twice', 'gate16']) assert.ok(st.methods.includes(m), m);
  for (const f of ['chrd', 'arp3', 'zap', 'mute', 'solo', 'afterFailure']) assert.ok(st.functions.includes(f), f);
  const [bass] = first('note("c2").s("sawtooth").acidenv(.5).dly(.5).rlpf(.5).pg(.8)');
  const v = bass.value;
  assert.equal(v.cutoff, 1296); // (12 × .5)^4 — rlpf after acidenv's lpf(100)
  assert.equal(v.lpenv, 4.5);
  assert.equal(v.lpdecay, 0.12);
  assert.equal(v.lpsustain, 0.2);
  assert.equal(v.resonance, 2);
  assert.equal(v.delay, 0.4);
  assert.equal(v.delayfeedback, 0.25);
  assert.equal(v.postgain, 0.8);
  // window.fn = … (incl. one that reads a const of the prebake), registerFunc, Pattern.prototype
  assert.deepEqual(first("chrd(48, 'min')").map((e) => e.value.note).sort((a, b) => a - b), [48, 51, 55]);
  assert.equal(first('arp3().twice()').length, 6);
  assert.equal(first('zap()')[0].value.s, 'sine');
  assert.equal(first('s("hh*4").gate16("1 0 1 1")').length, 3);
  // no "not available" warnings for prebake names
  const r = evaluate('note("c2").acidenv(.5).o(1)\n');
  assert.deepEqual(r.warnings, []);
});

test('engine: prebake errors are isolated per statement and reported with their line', () => {
  const st = setPrebake([HELPERS]);
  const src = st.sources[0];
  assert.equal(src.ok, false);
  const lines = src.errors.map((e) => e.line);
  assert.ok(lines.includes(lineOf('window.widget = window.makeWidget()')), JSON.stringify(src.errors)); // no document in Node
  assert.ok(src.errors.some((e) => e.line === lineOf('throw new Error') && /deliberate failure/.test(e.message)));
  // statements after the failures still ran
  assert.equal(typeof prebakeGlobals().afterFailure, 'function');
  assert.equal(first('afterFailure()').length, 8);
  // a source that does not even parse doesn't stop the others
  const st2 = setPrebake([{ id: 'bad', name: 'bad', code: 'register("x", (a, pat) => pat.fast(a)\nwindow.y = 1' }, HELPERS]);
  assert.equal(st2.sources[0].ok, false);
  assert.equal(st2.sources[0].errors[0].line, 2);
  assert.ok(st2.methods.includes('acidenv'));
  assert.equal(evaluate('s("bd").pg(.5)').error, null);
});

test('engine: re-applying undoes what the previous prebake defined; listeners are told', () => {
  setPrebake([HELPERS]);
  let calls = 0;
  const off = onPrebake(() => { calls++; });
  setPrebake([]);
  off();
  assert.equal(calls, 1);
  assert.equal(prebakeStatus().names.length, 0);
  const r = evaluate('s("bd").pg(.5)');
  assert.ok(r.warnings.some((w) => /\.pg\(\) is not available/.test(w)), r.warnings.join('\n'));
  assert.equal(prebakeGlobals().chrd, undefined);
  // the same sources twice: evaluated once
  setPrebake([HELPERS]);
  let again = 0;
  const off2 = onPrebake(() => { again++; });
  setPrebake([{ ...HELPERS }]);
  off2();
  assert.equal(again, 0);
});

test('engine: orbit mute / solo globals of a prebake are live (assigned by the user code)', () => {
  setPrebake([HELPERS]);
  const r = evaluate('mute(2)\n$: s("bd*4").o(1)\n$: s("hh*4").o(2)');
  assert.equal(r.error, null);
  assert.equal(queryEvents(r, 0, 1).length, 4);
  evaluate('mute()\n$: s("bd")');
  assert.deepEqual([...prebakeGlobals().mutedOrbits], []);
});

test('prebakeDefinedNames / parsePrebakeDocs: names, signatures and docs from the code', () => {
  const d = prebakeDefinedNames(FIXTURE);
  assert.ok(d.methods.includes('acidenv') && d.methods.includes('twice'));
  assert.ok(d.functions.includes('zap'));
  assert.ok(d.globals.includes('chrd') && d.globals.includes('mutedOrbits'));
  const docs = parsePrebakeDocs(FIXTURE, 'helpers');
  const by = (n, k) => docs.find((x) => x.name === n && (!k || x.kind === k));
  assert.equal(by('pg').signature, 'pat.pg(amount)');
  assert.equal(by('pg').title, 'pg');
  assert.equal(by('pg').example, 's("bd*4").pg(.5)');
  assert.match(by('pg').desc, /Post-gain/);
  assert.equal(by('acidenv').desc, 'filter envelope between 0 and 1 (a squelchy bass)');
  assert.equal(by('chrd').signature, "chrd(root = 48, kind = 'maj')");
  assert.equal(by('chrd').kind, 'function');
  assert.equal(by('zap').signature, 'zap(amount = .8)');
  assert.equal(by('twice').kind, 'method');
  assert.equal(by('twice').source, 'helpers');
  assert.equal(by('registerFunc'), undefined); // the helper that registers the others
  assert.equal(by('mutedOrbits'), undefined); // state, not a function
  assert.equal(prebakeArgs(by('chrd')), '');
  assert.equal(prebakeArgs(by('acidenv')), '.5');
  assert.equal(prebakeArgs(by('pg')), '.5'); // from the @example
});

test('autocomplete and palette list the prebake functions with their source', () => {
  const docs = parsePrebakeDocs(FIXTURE, 'helpers');
  const cat = buildCatalog({ prebake: docs });
  const m = cat.methods.find((i) => i.label === 'acidenv');
  assert.ok(m && /prebake: helpers/.test(m.desc));
  assert.ok(cat.top.find((i) => i.label === 'chrd'));
  const src = 'note("c2").aci';
  const res = completionsAt(src, src.length, cat);
  assert.equal(res.items[0].label, 'acidenv');
  assert.equal(applyCompletion(src, res, res.items[0]).text, 'note("c2").acidenv(.5)');
  const groups = paletteGroups({ prebake: docs });
  const g = groups.find((x) => x.id === 'prebake');
  assert.ok(g);
  assert.equal(g.sections[0].title, 'helpers');
  const chips = g.sections[0].chips;
  assert.equal(chips.find((c) => c.label === 'dly').code, '.dly(.5)');
  assert.equal(chips.find((c) => c.label === 'arp3').code, '$: arp3()');
  assert.ok(!paletteGroups({}).some((x) => x.id === 'prebake'));
});

test('repair: names a prebake defines are never "repaired"', () => {
  setPrebake([HELPERS]);
  const code = 'note("c2 eb2").s("sawtooth").acidenv(.5).dly(.4).rlpf(.6).pg(.8).o(1)\n$: chrd(48, "min").gate16("1 0 1 1")';
  const r = repairStrudel(code);
  assert.equal(r.code, code);
  assert.deepEqual(r.repairs, []);
  // a prebake that redefines a method the repair pass would rewrite keeps its meaning
  const VOX = { id: 'vox', name: 'vox', code: "register('voicings', (mode, pat) => pat.voicing())" };
  setPrebake([HELPERS, VOX]);
  const c2 = 'chord("<C Am>").voicings("lefthand").s("piano")';
  assert.equal(repairStrudel(c2).code, c2);
  setPrebake([HELPERS]);
  assert.notEqual(repairStrudel(c2).code, c2); // without it, the old API is repaired as before
});

test('split import: code using the prebake helpers becomes tracks with their effects; mute(n) mutes the orbit', () => {
  setPrebake([HELPERS]);
  const code = `setcpm(130/4)
mute(3)
const bass = note("c2 c2 eb2 g1").s("sawtooth").acidenv(.6).o(1)
const stab = chrd(60, 'min').s("square").struct("~ x ~ x").dly(.5).rlpf(.5).pg(.7).o(2)
const hats = s("hh*8").gate16("1 0 1 1 1 0 1 1").rhpf(.6).o(3)
$: stack(bass, stab, hats)`;
  const p = createProject();
  const s = splitStrudelToProject(p, code, { prebake: [{ name: 'helpers', url: 'https://example.com/helpers.strudel' }] });
  assert.equal(s.error, undefined, s.error);
  const t = (n) => p.tracks.find((x) => x.name === n);
  // acidenv -> filter envelope on the synth patch
  const bp = t('bass').instrument.params;
  assert.equal(t('bass').instrument.type, 'strudel');
  assert.equal(bp.lpenv, 5.4);
  assert.equal(bp.lpdecay, 0.12);
  assert.equal(bp.lpsustain, 0.2);
  assert.equal(bp.resonance, 2);
  // rlpf -> low-pass insert at (12x)^4; dly -> delay send (amount .8x, feedback x²); pg -> volume
  const lp = t('stab').fx.find((f) => f.type === 'filter');
  assert.equal(lp.params.type, 'lowpass');
  assert.equal(lp.params.cutoff, 1296);
  const [busId, amt] = Object.entries(t('stab').sends)[0];
  assert.equal(amt, 0.4);
  const delay = p.buses.find((b) => b.id === busId).fx.find((f) => f.type === 'delay');
  assert.equal(delay.params.feedback, 0.25);
  assert.equal(t('stab').volume, 0.56);
  // chord notes (three voices per hit) and the gated hats (6 of 8 per cycle)
  const notesOf = (tr) => p.clips.filter((c) => c.trackId === tr.id).flatMap((c) => p.patterns[c.patternId].notes);
  assert.equal(notesOf(t('stab')).length % 3, 0);
  const hp = t('hats').fx.find((f) => f.type === 'filter');
  assert.equal(hp.params.type, 'highpass');
  assert.ok(t('hats').mute, 'orbit 3 muted');
  assert.ok(!t('bass').mute && !t('stab').mute);
  assert.ok(s.notes.some((n) => /mute\(3\)/.test(n)));
  assert.deepEqual(p.prebake, [{ name: 'helpers', url: 'https://example.com/helpers.strudel' }]);
  // the code still mutes orbit 3 when it plays (the analysis didn't change the user's mute state)
  assert.deepEqual([...prebakeGlobals().mutedOrbits], [3]);
  // automation / effects never reference a prebake name
  for (const tr of p.tracks) for (const l of tr.automation) assert.ok(parseTarget(l.target));
});

test('split import: solo(n) solos the orbit\'s tracks', () => {
  setPrebake([HELPERS]);
  const a = analyzeStrudel('solo(1)\n$: note("c2*4").s("sawtooth").o(1)\n$: s("hh*8").o(2)');
  assert.equal(a.error, undefined);
  assert.deepEqual(a.orbitState, { muted: [], soloed: [1] });
  assert.equal(a.tracks.length, 2); // both analysed
  const p = createProject();
  splitStrudelToProject(p, a);
  assert.ok(p.tracks.filter((x) => x.type === 'instrument').find((x) => x.solo));
  evaluate('solo()\n$: s("bd")');
});

test('project.prebake round-trips through the .daW3 file (refs: url, or code for pasted snippets)', () => {
  const p = createProject();
  p.prebake = [{ name: 'helpers', url: 'https://example.com/helpers.strudel' }, { name: 'mine', code: "register('dub', (x, pat) => pat.delay(x))" }, { name: 'junk' }, { url: 'javascript:alert(1)' }];
  const back = parseProjectFile(serializeProject(p));
  assert.deepEqual(back.prebake, [{ name: 'helpers', url: 'https://example.com/helpers.strudel' }, { name: 'mine', code: "register('dub', (x, pat) => pat.delay(x))" }]);
  assert.equal(parseProjectFile(serializeProject(createProject())).prebake, undefined);
  assert.deepEqual(normalizeProjectPrebake([{ url: 'https://x.org/a/b.strudel' }]), [{ name: 'b.strudel', url: 'https://x.org/a/b.strudel' }]);
  const list = [{ name: 'a', url: 'https://x.org/a.strudel' }];
  assert.equal(mergeProjectPrebake(list, [{ name: 'a again', url: 'https://x.org/a.strudel' }]), list);
  assert.equal(mergeProjectPrebake(list, [{ name: 'b', code: 'x' }]).length, 2);
});

test('undefined calls: detection and which saved prebake defines them', () => {
  setPrebake([]);
  const r = evaluate('note("c2").acidenv(.5).dly(.3)\n$: s("bd").midi()');
  const missing = undefinedCalls(r);
  assert.deepEqual(missing.sort(), ['acidenv', 'dly']); // (midi: a Strudel package, not a missing helper)
  const hits = sourcesDefining(missing, [{ id: 'x', name: 'other', code: "register('foo', (a, p) => p)" }, HELPERS]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source.id, 'helpers');
  assert.deepEqual(hits[0].names.sort(), ['acidenv', 'dly']);
  assert.deepEqual(codeUses('s("x").dly(.2) // pg(1)\nconst a = "o(1)"', ['dly', 'pg', 'o']), ['dly']);
});

test('toRawUrl: page links become raw file links', () => {
  assert.equal(toRawUrl('https://github.com/someone/scripts/blob/main/prebake.strudel'), 'https://raw.githubusercontent.com/someone/scripts/main/prebake.strudel');
  assert.equal(toRawUrl('https://codeberg.org/a/b/src/branch/main/x.strudel'), 'https://codeberg.org/a/b/raw/branch/main/x.strudel');
  assert.equal(toRawUrl('https://example.com/x.strudel'), 'https://example.com/x.strudel');
});

// ------------------------------------------------------------------------------------------- manager

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}
function fakeFetch(files) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: { ...(opts.headers || {}) } });
    const f = files[url];
    if (!f) throw new TypeError('Failed to fetch');
    if (f.offline) throw new TypeError('Failed to fetch');
    if (f.etag && opts.headers?.['If-None-Match'] === f.etag) return { ok: false, status: 304, headers: new Map(), text: async () => '' };
    return { ok: true, status: 200, statusText: 'OK', headers: new Map([['etag', f.etag || null]]), text: async () => f.text };
  };
  fn.calls = calls;
  return fn;
}

test('manager: add by URL (cached with ETag), revalidate (304), offline uses the cached copy', async () => {
  const URL1 = 'https://example.com/helpers.strudel';
  const files = { [URL1]: { text: FIXTURE, etag: '"v1"' } };
  const fetch = fakeFetch(files);
  const storage = memoryStorage();
  const applied = [];
  const engine = { setPrebake: (list) => { applied.push(list); return setPrebake(list); }, prebakeStatus };
  const mgr = createPrebakeManager({ storage, fetch, engine });
  const src = await mgr.add({ url: URL1 });
  assert.equal(src.kind, 'url');
  assert.equal(src.etag, '"v1"');
  assert.equal(mgr.effective().length, 1);
  assert.ok(prebakeStatus().methods.includes('acidenv'));
  assert.ok(mgr.docs().some((d) => d.name === 'acidenv' && d.source === src.name));
  // persisted with the cached text
  const again = createPrebakeManager({ storage, fetch, engine });
  assert.equal(again.sources()[0].code, FIXTURE);
  // background revalidation sends the ETag; 304 keeps the cache
  await again.start();
  assert.equal(fetch.calls.at(-1).headers['If-None-Match'], '"v1"');
  assert.equal(again.sources()[0].code, FIXTURE);
  // offline: the cached copy stays in use, flagged
  files[URL1].offline = true;
  await again.reload();
  const s = again.sources()[0];
  assert.equal(s.stale, true);
  assert.match(s.error, /cached copy/);
  assert.equal(again.effective()[0].code, FIXTURE);
  assert.equal(again.status().state, 'error'); // (the fixture has statements that fail in Node)
  // disable / enable / reorder / remove
  const pasted = await again.add({ code: "register('dub', (x, pat) => pat.delay(x))", name: 'dub' });
  assert.deepEqual(again.effective().map((x) => x.name), [s.name, 'dub']);
  again.move(pasted.id, -1);
  assert.deepEqual(again.effective().map((x) => x.name), ['dub', s.name]);
  again.setEnabled(s.id, false);
  assert.deepEqual(again.effective().map((x) => x.name), ['dub']);
  assert.ok(!prebakeStatus().methods.includes('acidenv'));
  again.remove(pasted.id);
  assert.equal(again.effective().length, 0);
  // a web page instead of a raw file is refused with a hint
  files['https://example.com/page'] = { text: '<!DOCTYPE html><html></html>' };
  const page = await again.add({ url: 'https://example.com/page' });
  assert.match(page.error, /web page/);
  setPrebake([]);
});

test('manager: project refs — known URLs load, unknown ones ask first, refsFor(code) names what the code uses', async () => {
  const URL1 = 'https://example.com/helpers.strudel';
  const URL2 = 'https://example.com/other.strudel';
  const fetch = fakeFetch({ [URL1]: { text: FIXTURE }, [URL2]: { text: "register('dub', (x, pat) => pat.delay(x))" } });
  const asked = [];
  let answer = false;
  const mgr = createPrebakeManager({ storage: memoryStorage(), fetch, engine: { setPrebake, prebakeStatus }, confirmProjectUrl: async (r) => { asked.push(r.url); return answer; } });
  await mgr.add({ url: URL1, enabled: false });
  assert.equal(mgr.effective().length, 0);
  // the project needs the (disabled) saved prebake + an unknown URL (declined) + embedded code
  await mgr.setProject({ prebake: [{ name: 'h', url: URL1 }, { name: 'o', url: URL2 }, { name: 'emb', code: "register('emb', (pat) => pat)" }] });
  assert.deepEqual(asked, [URL2]);
  assert.deepEqual(mgr.effective().map((x) => x.name).sort(), ['emb', 'helpers.strudel']);
  assert.ok(prebakeStatus().methods.includes('acidenv') && prebakeStatus().methods.includes('emb'));
  assert.ok(!prebakeStatus().methods.includes('dub'));
  // accepted: fetched, remembered (disabled for other projects)
  answer = true;
  const m2 = createPrebakeManager({ storage: memoryStorage(), fetch, engine: { setPrebake, prebakeStatus }, confirmProjectUrl: async () => answer });
  await m2.setProject({ prebake: [{ name: 'o', url: URL2 }] });
  assert.ok(prebakeStatus().methods.includes('dub'));
  assert.equal(m2.sources()[0].enabled, false);
  // refsFor: only sources the code uses
  await m2.add({ url: URL1 });
  assert.deepEqual(m2.refsFor('note("c2").acidenv(.5)'), [{ name: 'helpers.strudel', url: URL1 }]);
  assert.deepEqual(m2.refsFor('s("bd")'), []);
  await m2.setProject({});
  setPrebake([]);
});
