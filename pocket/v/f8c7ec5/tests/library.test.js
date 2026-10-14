// Sample library: URL / sample-map logic, drum-machine catalog + pad mapping, Strudel sound resolution.
// Node only — fetch is stubbed (no network access needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fetched = [];
let fetchImpl = async (url) => { throw new Error('offline: ' + url); };
globalThis.fetch = (url, opts) => { fetched.push(String(url)); return fetchImpl(String(url), opts); };

const lib = await import('../src/audio/library/sample-library.js');
const dm = await import('../src/audio/library/drum-machines.js');
const ss = await import('../src/audio/library/strudel-sounds.js');
const { INSTRUMENT_DEFS, getParamDefaults, sanitizeParams } = await import('../src/audio/defs.js');
const { resolveInstrumentDef } = await import('../src/audio/presets.js');
const { DRUM_PADS } = await import('../src/core/model.js');
const { GENRES } = await import('../src/gen/genres.js');

const jsonResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

test('github pseudo URLs, mirrors and normalization', () => {
  assert.equal(lib.githubPath('github:tidalcycles/dirt-samples', 'strudel.json'), 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json');
  assert.equal(lib.githubPath('github:ritchse/tidal-drum-machines/main/machines/'), 'https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/machines/');
  assert.equal(lib.resolveBase('bubo:waveforms'), 'https://raw.githubusercontent.com/Bubobubobubobubo/dough-waveforms/main/');
  // spaces / # encoded once; existing escapes kept
  assert.equal(lib.normalizeUrl('https://x.org/a b/Hat Open#1.wav'), 'https://x.org/a%20b/Hat%20Open%231.wav');
  assert.equal(lib.normalizeUrl('https://x.org/Bass%20Drum%201/x.wav'), 'https://x.org/Bass%20Drum%201/x.wav');
  const raw = 'https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/machines/RolandTR909/rolandtr909-bd/Bassdrum-01.wav';
  const jsd = 'https://cdn.jsdelivr.net/gh/ritchse/tidal-drum-machines@main/machines/RolandTR909/rolandtr909-bd/Bassdrum-01.wav';
  assert.equal(lib.rawToJsdelivr(raw), jsd);
  assert.equal(lib.jsdelivrToRaw(jsd), raw);
  assert.equal(lib.canonicalUrl(jsd), raw);
  assert.equal(lib.repoOf(jsd), 'ritchse/tidal-drum-machines');
  assert.deepEqual(lib.mirrorsFor(raw), [raw, jsd]);
  assert.deepEqual(lib.mirrorsFor(raw, ['jsdelivr', 'raw']), [jsd, raw]);
  assert.deepEqual(lib.mirrorsFor(raw, ['jsdelivr', 'raw'], new Set(['jsdelivr'])), [raw]);
  assert.deepEqual(lib.mirrorsFor('https://example.com/a.wav'), ['https://example.com/a.wav']);
});

test('processSampleMap expands strudel.json maps (arrays, strings, note keys, per-entry _base)', () => {
  const m = lib.processSampleMap({
    _base: 'github:tidalcycles/Dirt-Samples/master/',
    bd: ['bd/BT0A0A7.wav', 'bd/BT0AADA.wav'],
    cp: 'cp/HANDCLP0.wav',
    piano: { _base: 'https://x.org/p/', C4: 'C4v8.mp3', Ds4: ['Ds4v8.mp3'] },
    _meta: 'ignored',
  });
  assert.deepEqual(Object.keys(m).sort(), ['bd', 'cp', 'piano']);
  assert.equal(m.bd[1], 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/BT0AADA.wav');
  assert.equal(m.cp[0], 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/cp/HANDCLP0.wav');
  assert.deepEqual(m.piano, { C4: ['https://x.org/p/C4v8.mp3'], Ds4: ['https://x.org/p/Ds4v8.mp3'] });
});

test('sample index and note-keyed picking follow Strudel', () => {
  assert.equal(lib.sampleIndex(3, 4), 3);
  assert.equal(lib.sampleIndex(5, 4), 1);
  assert.equal(lib.sampleIndex(-1, 4), 3);
  assert.equal(lib.sampleIndex(1.6, 4), 2);
  assert.equal(lib.noteKeyToMidi('C4'), 60);
  assert.equal(lib.noteKeyToMidi('Ds1'), 27);
  assert.equal(lib.noteKeyToMidi('Bb3'), 58);
  const bank = { C4: ['c4.mp3'], Fs4: ['fs4.mp3'], A4: ['a4.mp3'] };
  assert.deepEqual(lib.pickSample(bank, { midi: 61 }), { url: 'c4.mp3', index: 0, transpose: 1 });
  assert.deepEqual(lib.pickSample(bank, { midi: 68 }), { url: 'a4.mp3', index: 0, transpose: -1 });
  assert.deepEqual(lib.pickSample(['a', 'b', 'c'], { n: 4 }), { url: 'b', index: 1, transpose: 0 });
  assert.equal(lib.pickSample(['a'], { midi: 48 }).transpose, 12);
});

test('drum machine catalog: ≥15 machines, every core pad mapped, URLs well-formed', () => {
  const ids = Object.keys(dm.DRUM_MACHINES);
  assert.ok(ids.length >= 15, `${ids.length} machines`);
  for (const id of ['RolandTR808', 'RolandTR909', 'RolandTR707', 'RolandTR606', 'RolandCompurhythm78', 'LinnDrum', 'LinnLM1', 'OberheimDMX', 'EmuSP12', 'AkaiMPC60', 'AlesisHR16', 'KorgMinipops', 'RolandCompurhythm1000', 'SequentialCircuitsDrumtracks', 'YamahaRX5', 'BossDR110', 'CasioRZ1']) {
    assert.ok(dm.DRUM_MACHINES[id], id);
  }
  for (const id of ids) {
    const plan = dm.resolvePadSamples(id);
    for (const pad of DRUM_PADS) {
      assert.ok(plan[pad.key], `${id} has a sample for ${pad.key}`);
      for (const v of plan[pad.key].variants) {
        assert.ok(v.layers.length && v.layers.at(-1).vmax === 1, `${id}.${pad.key} layers`);
        for (const L of v.layers) for (const u of L.urls) assert.match(u, /^https:\/\/raw\.githubusercontent\.com\/[^ #]+\.(wav|WAV|mp3)$/, u);
      }
    }
    assert.equal(plan.kick.source, 'machine', `${id} kick is its own`);
    assert.ok(dm.DRUM_MACHINES[id].kit, `${id} has a synth fallback kit`);
  }
  const p909 = dm.resolvePadSamples('RolandTR909');
  assert.match(p909.kick.variants[0].layers[0].urls[0], /RolandTR909\/rolandtr909-bd\/Bassdrum-01\.wav$/);
  assert.match(p909.openhat.variants[0].layers[0].urls[0], /rolandtr909-oh\/Hat%20Open\.wav$/);
  assert.equal(p909.cowbell.source, 'companion'); // the 909 has no cowbell
  assert.equal(p909.clave.source, 'companion');
  // missing mid tom -> low tom tuned up (same machine)
  const p606 = dm.resolvePadSamples('RolandTR606');
  assert.equal(p606.tommid.key, 'lt');
  assert.equal(p606.tommid.variants[0].tune, 3);
  // the 808's classic picks
  assert.match(dm.resolvePadSamples('RolandTR808').kick.variants[0].layers[0].urls[0], /BD2550/);
  // VCSL acoustic kit: velocity layers + round robins
  const vk = dm.resolvePadSamples('VCSLAcoustic');
  assert.ok(vk.snare.variants[0].layers.length >= 3);
  assert.equal(dm.pickLayer(vk.snare.variants[0], 0.2).vmax, 0.4);
  assert.equal(dm.pickLayer(vk.snare.variants[0], 1).vmax, 1);
  assert.ok(vk.hihat.variants[0].layers[0].urls.length === 2);
});

test('padVariant / padLoadList: a pad always plays its chosen sound (round robin never swaps sounds)', () => {
  const plan = dm.resolvePadSamples('RolandTR909').snare;
  assert.equal(dm.padVariant(plan, {}), plan.variants[0]);
  assert.equal(dm.padVariant(plan, { variant: 2 }), plan.variants[2]);
  // round robin must not jump between different samples (that made kicks sound inconsistent)
  assert.equal(dm.padVariant(plan, { variant: 1 }, 3, true), plan.variants[1]);
  const base = dm.padLoadList('RolandTR909', {});
  assert.equal(base.length, new Set(base).size);
  assert.ok(base.length >= 12 && base.length <= 16, String(base.length));
  const muted = dm.padLoadList('RolandTR909', { pads: { kick: { mute: true } } });
  assert.equal(muted.length, base.length - 1);
  assert.equal(dm.padLoadList('RolandTR909', { roundRobin: true }).length, base.length);
});

test('bank names: Strudel aliases, case-insensitive', () => {
  assert.equal(dm.canonicalBank('RolandTR909'), 'RolandTR909');
  assert.equal(dm.canonicalBank('rolandtr909'), 'RolandTR909');
  assert.equal(dm.canonicalBank('TR909'), 'RolandTR909');
  assert.equal(dm.canonicalBank('sp12'), 'EmuSP12');
  assert.equal(dm.canonicalBank('YamahaTG33'), 'YamahaTG33');
  assert.equal(dm.canonicalBank('nope'), null);
  assert.deepEqual(dm.splitBankSound('RolandTR909_bd'), { machine: 'RolandTR909', key: 'bd' });
  assert.deepEqual(dm.splitBankSound('tr808_oh'), { machine: 'RolandTR808', key: 'oh' });
  assert.equal(dm.splitBankSound('snare_modern'), null);
  assert.equal(dm.strudelBankUrls('RolandTR909', 'bd').length, 4);
});

test('preferredKitForGenre covers every genre with a catalog machine', () => {
  for (const [id, g] of Object.entries(GENRES)) {
    const m = dm.preferredKitForGenre(id, g.family);
    assert.ok(dm.DRUM_MACHINES[m], `${id} -> ${m}`);
  }
  assert.equal(dm.preferredKitForGenre('house'), 'RolandTR909');
  assert.equal(dm.preferredKitForGenre('techno'), 'RolandTR909');
  assert.equal(dm.preferredKitForGenre('trap'), 'RolandTR808');
  assert.equal(dm.preferredKitForGenre('boom-bap'), 'EmuSP12');
  assert.equal(dm.preferredKitForGenre('synthwave'), 'LinnDrum');
  assert.equal(dm.preferredKitForGenre('disco'), 'RolandCompurhythm78');
  assert.equal(dm.preferredKitForGenre('unknown-genre'), 'RolandTR909');
  const def = dm.drumInstrumentForGenre('house', { kit: '909' });
  assert.deepEqual(def, { type: 'drums', preset: '909', params: { kit: '909', machine: 'RolandTR909' } });
  // the def resolves cleanly through the normal instrument pipeline
  const r = resolveInstrumentDef(def);
  assert.equal(r.type, 'drums');
  assert.equal(r.params.machine, 'RolandTR909');
  assert.equal(r.params.kit, '909');
});

test('instrument defs: drums.machine and the drumsampler type', () => {
  assert.equal(getParamDefaults('drums').machine, '');
  assert.ok(INSTRUMENT_DEFS.drums.params.find((p) => p.key === 'machine').options.some((o) => o.value === 'RolandTR909'));
  assert.ok(INSTRUMENT_DEFS.drums.padParams.find((p) => p.key === 'variant'));
  const d = getParamDefaults('drumsampler');
  assert.equal(d.machine, 'RolandTR909');
  assert.deepEqual(d.pads, {});
  const s = sanitizeParams('drumsampler', { machine: 'bogus', pads: { kick: { variant: 99, tune: 3 } } });
  assert.equal(s.machine, 'RolandTR909');
  assert.equal(s.pads.kick.variant, 24);
  assert.equal(sanitizeParams('drums', { machine: 'LinnDrum' }).machine, 'LinnDrum');
});

test('Strudel sound resolution: banks, aliases, indices, pad fallbacks', () => {
  const r1 = ss.resolveSample({ s: 'bd', bank: 'RolandTR909' }, { name: 'bd', index: 0 });
  assert.match(r1.url, /RolandTR909\/rolandtr909-bd\/Bassdrum-01\.wav$/);
  const r2 = ss.resolveSample({ s: 'bd', bank: 'TR909' }, { name: 'bd', index: 2 });
  assert.match(r2.url, /Bassdrum-03\.wav$/);
  assert.equal(r2.index, 2);
  const r3 = ss.resolveSample({ s: 'RolandTR909_sd' }, { name: 'RolandTR909_sd', index: 1 });
  assert.match(r3.url, /rolandtr909-sd\/sd01\.wav$/);
  const wrap = ss.resolveSample({ s: 'bd', bank: 'RolandTR909' }, { name: 'bd', index: 5 });
  assert.match(wrap.url, /Bassdrum-02\.wav$/);
  // machine lacks the sound -> pad mapping (TR-606 has no clap: companion clap)
  const cp = ss.resolveSample({ s: 'cp', bank: 'RolandTR606' }, { name: 'cp' });
  assert.ok(cp?.url, 'clap resolved');
  assert.match(cp.url, /cp|Clap/i);
  // DAW drum names work with a bank too
  assert.match(ss.resolveSample({ s: 'kick', bank: 'LinnDrum' }, { name: 'kick' }).url, /LinnDrum\/linndrum-bd/);
  // no bank: names Dirt-Samples lacks fall to the default machine (909)
  assert.match(ss.resolveSample({ s: 'oh' }, { name: 'oh' }).url, /RolandTR909\/rolandtr909-oh/);
  // synth waveforms / unknown names are not samples
  assert.equal(ss.resolveSample({ s: 'sawtooth' }, { name: 'sawtooth' }), null);
  assert.equal(ss.resolveSample({ s: 'xyzzy' }, { name: 'xyzzy' }), null);
  // note-keyed piano (Salamander): closest sample + transposition
  const pn = ss.resolveSample({ s: 'piano', note: 61 }, { name: 'piano' });
  assert.match(pn.url, /piano\/C4v8\.mp3$/);
  assert.equal(pn.transpose, 1);
  const pn2 = ss.resolveSample({ s: 'piano', note: 'a3' }, { name: 'piano' });
  assert.match(pn2.url, /A3v8\.mp3$/);
  assert.equal(pn2.transpose, 0);
  // pitched array samples: note relative to 36
  assert.equal(ss.resolveSample({ s: 'bd', bank: 'RolandTR909', note: 48 }, { name: 'bd' }).transpose, 12);
});

test('Dirt-Samples names load the Strudel map (stubbed) and then resolve Strudel-style', async () => {
  const before = fetched.length;
  fetchImpl = async (url) => {
    if (url.endsWith('/strudel.json') && url.includes('Dirt-Samples')) {
      return jsonResponse({ _base: 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/', bd: ['bd/BT0A0A7.wav', 'bd/BT0AADA.wav'], casio: ['casio/high.wav', 'casio/low.wav', 'casio/noise.wav'], jvbass: ['jvbass/000_01.wav'] });
    }
    throw new Error('offline');
  };
  const p = ss.resolveSample({ s: 'casio' }, { name: 'casio', index: 1 });
  assert.ok(p.pending, 'pending while the map loads');
  assert.equal(await p.pending, true);
  assert.ok(fetched.slice(before).some((u) => u.includes('tidalcycles/Dirt-Samples/master/strudel.json')));
  assert.match(ss.resolveSample({ s: 'casio' }, { name: 'casio', index: 1 }).url, /Dirt-Samples\/master\/casio\/low\.wav$/);
  assert.match(ss.resolveSample({ s: 'bd' }, { name: 'bd', index: 1 }).url, /bd\/BT0AADA\.wav$/);
  // a bank still wins over the bare Dirt name
  assert.match(ss.resolveSample({ s: 'bd', bank: 'RolandTR808' }, { name: 'bd' }).url, /RolandTR808/);
  // urlsForValues gathers what a pattern needs
  const urls = await ss.urlsForValues([{ s: 'bd' }, { s: 'casio', n: 2 }, { s: 'bd', bank: 'RolandTR909' }, { s: 'sawtooth', note: 40 }, { s: 'jvbass:0', note: 40 }]);
  assert.equal(urls.length, 4);
  assert.ok(urls.some((u) => /casio\/noise\.wav$/.test(u)));
});

test('registerSamples: github shortcut + map objects', async () => {
  fetchImpl = async (url) => {
    if (url === 'https://raw.githubusercontent.com/someone/my-samples/main/strudel.json') return jsonResponse({ _base: 'https://raw.githubusercontent.com/someone/my-samples/main/', mykick: ['k.wav'] });
    throw new Error('offline');
  };
  const names = await ss.registerSamples('github:someone/my-samples');
  assert.deepEqual(names, ['mykick']);
  assert.match(ss.resolveSample({ s: 'mykick' }, { name: 'mykick' }).url, /someone\/my-samples\/main\/k\.wav$/);
  ss.registerSampleMap({ _base: 'https://x.org/', 'MyBank_bd': ['b.wav'] });
  assert.equal(ss.resolveSample({ s: 'bd', bank: 'MyBank' }, { name: 'bd' }).url, 'https://x.org/b.wav');
});

test('SampleLibrary: mirror fallback, caching, failure memory, concurrency', async () => {
  const L = new lib.SampleLibrary({ concurrency: 2 });
  const raw = 'https://raw.githubusercontent.com/o/r/main/a b.wav';
  const calls = [];
  fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('blocked');
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const b = await L.fetchBytes(raw);
  assert.equal(b.byteLength, 3);
  assert.deepEqual(calls, ['https://raw.githubusercontent.com/o/r/main/a%20b.wav', 'https://cdn.jsdelivr.net/gh/o/r@main/a%20b.wav']);
  // cached in memory (same promise, no new fetch) — also via its jsDelivr alias
  await L.fetchBytes('https://cdn.jsdelivr.net/gh/o/r@main/a%20b.wav');
  assert.equal(calls.length, 2);
  // failures are remembered (no refetch storm) and reported
  let errs = 0;
  L.on('error', () => errs++);
  fetchImpl = async () => { throw new Error('down'); };
  await assert.rejects(L.fetchBytes('https://raw.githubusercontent.com/o/r/main/x.wav'));
  assert.ok(L.hasFailed('https://raw.githubusercontent.com/o/r/main/x.wav'));
  await assert.rejects(L.fetchBytes('https://raw.githubusercontent.com/o/r/main/x.wav'));
  assert.equal(errs, 1);
  // concurrency limit
  let active = 0, peak = 0;
  fetchImpl = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return new Response(new Uint8Array([1])); };
  await Promise.all(Array.from({ length: 7 }, (_, i) => L.fetchBytes(`https://raw.githubusercontent.com/o/r/main/c${i}.wav`)));
  assert.ok(peak <= 2, `peak ${peak}`);
  // decode via a fake context, cached per sample rate; preload never rejects
  const ctx = { sampleRate: 48000, decodeAudioData: (ab, ok) => ok({ duration: 1, ab }) };
  const buf = await L.load(ctx, 'https://raw.githubusercontent.com/o/r/main/c1.wav');
  assert.equal(L.get(ctx, 'https://raw.githubusercontent.com/o/r/main/c1.wav'), buf);
  assert.equal(L.get(44100, 'https://raw.githubusercontent.com/o/r/main/c1.wav'), null);
  fetchImpl = async () => { throw new Error('down'); };
  const res = await L.preload(ctx, ['https://raw.githubusercontent.com/o/r/main/c1.wav', 'https://raw.githubusercontent.com/o/r/main/zz.wav']);
  assert.deepEqual(res, { loaded: 1, failed: 1, total: 2 });
});
