// Pure plugin helpers: GitHub URL resolution, kind detection, manifests, soundfont parsing, catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGitHubUrl, detectPluginKind, validateManifest, manifestUrls, joinUrl, nameFromUrl, hashString,
} from '../src/plugins/github.js';
import {
  noteNameToMidi, midiToNoteName, parseSoundfontText, nearestSampleIndex, playbackRateFor, dataUrlToBytes,
} from '../src/plugins/soundfont-parse.js';
import { GM_INSTRUMENTS, GM_FAMILIES, gmLabel, gmFamily, soundfontUrl } from '../src/plugins/gm.js';
import { CATALOG, searchCatalog, catalogCategories, pluginParams } from '../src/plugins/catalog.js';
import { pluginKey, friendlyError, setStatus, getStatus, onStatus } from '../src/plugins/status.js';
import { faustParams, looksPolyphonic, hasEffectSection } from '../src/plugins/faust.js';
import { INSTRUMENT_DEFS, sanitizeParams } from '../src/audio/defs.js';
import { resolveInstrumentDef } from '../src/audio/presets.js';
import { EFFECT_DEFS } from '../src/audio/effect-defs.js';

const J = 'https://cdn.jsdelivr.net/gh';

test('resolveGitHubUrl: blob / raw / tree / repo / raw.githubusercontent / github.io / jsDelivr', () => {
  const r = resolveGitHubUrl('https://github.com/grame-cncm/faust/blob/master-dev/examples/reverb/freeverb.dsp');
  assert.equal(r.url, `${J}/grame-cncm/faust@master-dev/examples/reverb/freeverb.dsp`);
  assert.deepEqual([r.owner, r.repo, r.ref, r.path, r.isDir], ['grame-cncm', 'faust', 'master-dev', 'examples/reverb/freeverb.dsp', false]);
  assert.equal(resolveGitHubUrl('github.com/o/r/raw/main/a/b.js').url, `${J}/o/r@main/a/b.js`);
  const tree = resolveGitHubUrl('https://github.com/o/r/tree/v1.2/plugins/synth');
  assert.equal(tree.url, `${J}/o/r@v1.2/plugins/synth/`);
  assert.ok(tree.isDir && !tree.isRepoRoot);
  const root = resolveGitHubUrl('https://github.com/o/my-plugin.git');
  assert.equal(root.url, `${J}/o/my-plugin/`);
  assert.ok(root.isRepoRoot && root.isDir);
  assert.equal(resolveGitHubUrl('https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/marimba-mp3.js').url,
    `${J}/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/marimba-mp3.js`);
  assert.equal(resolveGitHubUrl('https://raw.githubusercontent.com/o/r/refs/heads/main/x.dsp').url, `${J}/o/r@main/x.dsp`);
  assert.equal(resolveGitHubUrl('https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/marimba-mp3.js').url,
    `${J}/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/marimba-mp3.js`);
  const cdn = `${J}/o/r@main/x.dsp`;
  assert.equal(resolveGitHubUrl(cdn).url, cdn);
  assert.equal(resolveGitHubUrl(cdn).ref, 'main');
  const other = resolveGitHubUrl('https://example.com/wam/index.js?v=2');
  assert.equal(other.github, false);
  assert.equal(other.url, 'https://example.com/wam/index.js?v=2');
  // file names with spaces are percent-decoded then re-joined
  assert.equal(resolveGitHubUrl('https://github.com/o/r/blob/main/My%20Synth.dsp').path, 'My Synth.dsp');
});

test('resolveGitHubUrl rejects junk with friendly errors', () => {
  assert.throws(() => resolveGitHubUrl(''), /Paste/);
  assert.throws(() => resolveGitHubUrl('not a url'), /not a valid URL/);
  assert.throws(() => resolveGitHubUrl('ftp://x.org/a'), /http/);
  assert.throws(() => resolveGitHubUrl('https://github.com/onlyowner'), /repository/);
  assert.throws(() => resolveGitHubUrl('https://github.com/o/r/issues/3'), /Unsupported/);
});

test('detectPluginKind by extension and by content', () => {
  assert.equal(detectPluginKind('https://x/y/synth.dsp'), 'faust');
  assert.equal(detectPluginKind('https://x/FluidR3_GM/marimba-mp3.js'), 'soundfont');
  assert.equal(detectPluginKind('https://x/FluidR3_GM/marimba-ogg.js?x=1'), 'soundfont');
  assert.equal(detectPluginKind('https://x/plugin.json'), 'manifest');
  assert.equal(detectPluginKind('https://x/daWWW.json'), 'manifest');
  assert.equal(detectPluginKind('https://x/wam/index.js'), 'wam');
  assert.equal(detectPluginKind('https://x/a.txt'), null);
  assert.equal(detectPluginKind('https://x/a.js', 'MIDI.Soundfont.marimba = { "A0": "data:audio/mp3;base64,AA" }'), 'soundfont');
  assert.equal(detectPluginKind('https://x/a.js', 'class X extends WebAudioModule {}\nexport default X;'), 'wam');
  assert.equal(detectPluginKind('https://x/a.js', 'var a=1;export { Plugin as default };'), 'wam');
  assert.equal(detectPluginKind('https://x/a.txt', 'import("stdfaust.lib");\nprocess = os.osc(440);'), 'faust');
  assert.equal(detectPluginKind('https://x/a.js', 'console.log(1)'), null);
});

test('validateManifest + manifestUrls + joinUrl', () => {
  const base = `${J}/o/r@main/`;
  const ok = validateManifest('{"name":"Fat Synth","kind":"faust","entry":"dsp/fat.dsp","description":"big"}', base + 'daWWW.json');
  assert.ok(ok.ok, ok.errors.join());
  assert.equal(ok.manifest.url, `${J}/o/r@main/dsp/fat.dsp`);
  assert.equal(ok.manifest.type, 'instrument');
  const abs = validateManifest({ name: 'W', kind: 'wam', entry: 'https://github.com/o/w/blob/main/dist/index.js', type: 'effect' }, base);
  assert.equal(abs.manifest.url, `${J}/o/w@main/dist/index.js`);
  assert.equal(abs.manifest.type, 'effect');
  const bad = validateManifest({ name: '', kind: 'vst', entry: 3, type: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
  assert.equal(validateManifest('{nope').ok, false);
  assert.equal(validateManifest([]).ok, false);
  assert.deepEqual(manifestUrls('https://github.com/o/r'), [`${J}/o/r/daWWW.json`, `${J}/o/r/plugin.json`]);
  assert.equal(joinUrl('https://a.b/c/d.json', 'e/f.dsp'), 'https://a.b/c/e/f.dsp');
  assert.equal(joinUrl('https://a.b/c/', '../x.js'), 'https://a.b/x.js');
  assert.equal(nameFromUrl('https://x/FluidR3_GM/marimba-mp3.js'), 'marimba');
  assert.equal(nameFromUrl('https://x/y/My%20Synth.dsp'), 'My Synth');
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});

test('note names <-> midi', () => {
  assert.equal(noteNameToMidi('C4'), 60);
  assert.equal(noteNameToMidi('A4'), 69);
  assert.equal(noteNameToMidi('A0'), 21);
  assert.equal(noteNameToMidi('Bb0'), 22);
  assert.equal(noteNameToMidi('C8'), 108);
  assert.equal(noteNameToMidi('F#3'), 54);
  assert.equal(noteNameToMidi('Cb4'), 59);
  assert.equal(noteNameToMidi('c-1'), 0);
  assert.equal(noteNameToMidi('H2'), null);
  assert.equal(noteNameToMidi('G9'), 127);
  assert.equal(noteNameToMidi('A9'), null);
  for (let m = 0; m < 128; m++) assert.equal(noteNameToMidi(midiToNoteName(m)), m);
  assert.equal(midiToNoteName(61), 'Db4');
});

test('parseSoundfontText reads midi-js files without eval', () => {
  const text = `if (typeof(MIDI) === 'undefined') var MIDI = {};
if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
MIDI.Soundfont.acoustic_grand_piano = {
"A0": "data:audio/mp3;base64,SUQz",
"Bb0": "data:audio/mp3;base64,AAEC",
"C4": "data:audio/ogg;base64,T2dn
UwA=",
"bogus": "data:audio/mp3;base64,AA",
}
`;
  const sf = parseSoundfontText(text);
  assert.equal(sf.name, 'acoustic_grand_piano');
  assert.deepEqual(sf.samples.map((s) => s.midi), [21, 22, 60]);
  assert.equal(sf.samples[2].mime, 'audio/ogg');
  assert.equal(sf.samples[2].dataUrl, 'data:audio/ogg;base64,T2dnUwA=');
  assert.deepEqual([...dataUrlToBytes(sf.samples[0].dataUrl)], [0x49, 0x44, 0x33]);
  // plain JSON form
  assert.equal(parseSoundfontText('{"C4":"data:audio/mp3;base64,AA=="}').samples[0].midi, 60);
  assert.throws(() => parseSoundfontText('<html>404</html>'), /midi-js soundfont/);
});

test('nearest sample + repitch rate', () => {
  const m = [21, 24, 27, 30, 60, 72];
  assert.equal(nearestSampleIndex(m, 21), 0);
  assert.equal(nearestSampleIndex(m, 0), 0);
  assert.equal(nearestSampleIndex(m, 23), 1);
  assert.equal(nearestSampleIndex(m, 22), 0); // tie 21/23… 22 is 1 from 21, 2 from 24
  assert.equal(nearestSampleIndex([60, 62], 61), 0); // ties prefer the lower sample
  assert.equal(nearestSampleIndex(m, 66), 4);
  assert.equal(nearestSampleIndex(m, 127), 5);
  assert.equal(nearestSampleIndex([], 60), -1);
  assert.equal(playbackRateFor(69, 69), 1);
  assert.ok(Math.abs(playbackRateFor(81, 69) - 2) < 1e-12);
  assert.ok(Math.abs(playbackRateFor(70, 69) - Math.pow(2, 1 / 12)) < 1e-12);
  assert.ok(Math.abs(playbackRateFor(69, 69, 100) - Math.pow(2, 1 / 12)) < 1e-12);
});

test('GM list, labels, families and soundfont URLs', () => {
  assert.equal(GM_INSTRUMENTS.length, 128);
  assert.equal(new Set(GM_INSTRUMENTS).size, 128);
  assert.equal(GM_FAMILIES.length, 16);
  assert.equal(gmLabel('electric_piano_1'), 'Electric Piano 1');
  assert.equal(gmLabel('lead_2_sawtooth'), 'Lead 2 (Sawtooth)');
  assert.equal(gmLabel('fx_4_atmosphere'), 'FX 4 (Atmosphere)');
  assert.equal(gmFamily('violin'), 'Strings');
  assert.equal(gmFamily(0), 'Piano');
  assert.equal(gmFamily('gunshot'), 'Sound Effects');
  assert.equal(soundfontUrl('MusyngKite', 'marimba', 'ogg'), `${J}/gleitz/midi-js-soundfonts@gh-pages/MusyngKite/marimba-ogg.js`);
  assert.equal(soundfontUrl('nope', 'marimba'), `${J}/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/marimba-mp3.js`);
});

test('catalog entries are complete, unique and searchable', () => {
  const ids = new Set();
  const kinds = { soundfont: 0, faust: 0, wam: 0 };
  for (const e of CATALOG) {
    for (const k of ['id', 'name', 'kind', 'type', 'category', 'description', 'author', 'license', 'homepage']) assert.ok(e[k], `${e.id} ${k}`);
    assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
    ids.add(e.id);
    assert.ok(['instrument', 'effect'].includes(e.type));
    assert.ok(e.source && (e.source.url || e.source.code), `${e.id} source`);
    kinds[e.kind]++;
    if (e.kind === 'soundfont') assert.ok(GM_INSTRUMENTS.includes(e.source.instrument), e.id);
    if (e.kind === 'faust') {
      assert.match(e.source.code, /process\s*=/);
      assert.equal(looksPolyphonic(e.source.code), e.type === 'instrument', `${e.id} poly convention`);
    }
    if (e.kind === 'wam') assert.ok(e.experimental && /^https:\/\/cdn\.jsdelivr\.net\//.test(e.source.url));
  }
  assert.ok(kinds.soundfont >= 40 && kinds.faust >= 10 && kinds.wam >= 3, JSON.stringify(kinds));
  // a good spread of GM families
  assert.ok(new Set(CATALOG.filter((e) => e.kind === 'soundfont').map((e) => e.category)).size >= 12);
  assert.ok(searchCatalog({ query: 'piano' }).length >= 3);
  assert.ok(searchCatalog({ kind: 'faust', type: 'effect' }).every((e) => e.kind === 'faust' && e.type === 'effect'));
  assert.ok(searchCatalog({ query: 'zita reverb' }).some((e) => e.id === 'faust-zita-reverb'));
  assert.ok(catalogCategories({ kind: 'soundfont' }).includes('Brass'));
  assert.deepEqual(pluginParams(CATALOG.find((e) => e.id === 'sf-marimba')), { library: 'FluidR3_GM', instrument: 'marimba', url: '' });
});

test('plugin instrument defs resolve, keep their source keys and have status keys', () => {
  for (const t of ['soundfont', 'faust', 'wam']) assert.ok(INSTRUMENT_DEFS[t]?.plugin, t);
  const sf = resolveInstrumentDef({ type: 'soundfont', params: { instrument: 'violin', release: 99, url: '' } });
  assert.equal(sf.type, 'soundfont');
  assert.equal(sf.params.instrument, 'violin');
  assert.equal(sf.params.library, 'FluidR3_GM');
  assert.equal(sf.params.release, 8); // clamped
  assert.equal(pluginKey(sf), `sf:${J}/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/violin-mp3.js`);
  assert.equal(sanitizeParams('soundfont', { instrument: 'not-gm' }).instrument, 'acoustic_grand_piano');
  const code = 'import("stdfaust.lib"); process = os.osc(440);';
  const f = resolveInstrumentDef({ type: 'faust', params: { code, name: 'X', values: { '/x/a': 1 } } });
  assert.equal(f.params.code, code);
  assert.deepEqual(f.params.values, { '/x/a': 1 });
  assert.equal(f.params.voices, 8);
  assert.equal(pluginKey(f), 'faust:' + hashString(code));
  const w = resolveInstrumentDef({ type: 'wam', params: { url: 'https://x/i.js', state: { a: 1 } } });
  assert.deepEqual(w.params.state, { a: 1 });
  assert.equal(pluginKey(w), 'wam:https://x/i.js');
  assert.equal(pluginKey({ type: 'synth', params: {} }), null);
  assert.ok(EFFECT_DEFS.faust?.plugin && EFFECT_DEFS.wam?.plugin);
});

test('status registry + friendly errors', () => {
  const seen = [];
  const off = onStatus((k, s) => seen.push([k, s.state]));
  setStatus('t:1', { state: 'loading', progress: 0.5 });
  setStatus('t:1', { state: 'error', error: 'boom' });
  setStatus('t:1', { state: 'ready' });
  off();
  setStatus('t:1', { state: 'loading' });
  assert.deepEqual(seen, [['t:1', 'loading'], ['t:1', 'error'], ['t:1', 'ready']]);
  assert.equal(getStatus('t:1').error, null);
  assert.equal(getStatus('nope').state, 'idle');
  assert.match(friendlyError(new TypeError('Failed to fetch'), { url: 'https://x/y.js' }), /CORS/);
  assert.match(friendlyError(new Error('HTTP 404 Not Found'), { url: 'https://x/y.js' }), /404/);
  assert.match(friendlyError(new Error('undefined symbol : foo'), { kind: 'faust' }), /Faust compile error/);
});

test('faust UI JSON -> knob descriptors (voice controls hidden)', () => {
  const ui = [{ type: 'vgroup', label: 'synth', items: [
    { type: 'hslider', label: 'freq', address: '/synth/freq', init: 440, min: 20, max: 20000, step: 1 },
    { type: 'hslider', label: 'gain', address: '/synth/gain', init: 0.5, min: 0, max: 1, step: 0.01 },
    { type: 'button', label: 'gate', address: '/synth/gate' },
    { type: 'hslider', label: 'Cutoff', address: '/synth/Cutoff', init: 1000, min: 50, max: 10000, step: 1, meta: [{ unit: 'Hz' }, { scale: 'log' }] },
    { type: 'hgroup', label: 'env', items: [{ type: 'checkbox', label: 'Hold', address: '/synth/env/Hold' }] },
    { type: 'hbargraph', label: 'level', address: '/synth/level', min: 0, max: 1 },
  ] }];
  const ps = faustParams(ui, { skipVoice: true });
  assert.deepEqual(ps.map((p) => p.address), ['/synth/Cutoff', '/synth/env/Hold']);
  assert.equal(ps[0].unit, 'Hz');
  assert.equal(ps[0].scale, 'log');
  assert.equal(ps[1].type, 'bool');
  assert.equal(ps[1].section, 'env');
  assert.equal(faustParams(ui).length, 5);
  assert.ok(hasEffectSection('process = _;\neffect = dm.zita_light;'));
  assert.ok(!hasEffectSection('process = _; // effect = x;'));
});

test('rawGitHubUrl maps jsDelivr /gh/ URLs back to raw.githubusercontent (fetch fallback)', async () => {
  const { rawGitHubUrl } = await import('../src/plugins/github.js');
  assert.equal(rawGitHubUrl(soundfontUrl('FluidR3_GM', 'marimba')), 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/marimba-mp3.js');
  assert.equal(rawGitHubUrl('https://cdn.jsdelivr.net/gh/o/r/x.js'), null);
  assert.equal(rawGitHubUrl('https://example.com/a.js'), null);
});
