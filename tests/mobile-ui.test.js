import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { detectPocket, readEnv } from '../src/mobile/mode.js';
import { PAGES, parseRoute, routeHash, neighbour, swipeDecision, tabOf } from '../src/mobile/router.js';
import { nudge, presetsFor, parseTyped, scrubFactor, scrubNorm, repeatDelay, quantize, defaultOf } from '../src/mobile/param-logic.js';
import { INSTRUMENT_DEFS } from '../src/audio/defs.js';
import { EFFECT_DEFS } from '../src/audio/effect-defs.js';

test('pocket mode: URL > remembered choice > automatic small / touch screens', () => {
  assert.equal(detectPocket({ width: 390, coarse: true }), true); // iPhone
  assert.equal(detectPocket({ width: 932, coarse: true }), true); // iPhone landscape
  assert.equal(detectPocket({ width: 1366, coarse: true }), false); // big iPad Pro landscape
  assert.equal(detectPocket({ width: 1440 }), false); // desktop
  assert.equal(detectPocket({ width: 800 }), true); // small desktop window
  assert.equal(detectPocket({ width: 1440, search: '?mobile=1' }), true);
  assert.equal(detectPocket({ width: 390, search: '?mobile=0' }), false);
  assert.equal(detectPocket({ width: 390, search: '?desktop' }), false);
  assert.equal(detectPocket({ width: 390, stored: 'desktop' }), false);
  assert.equal(detectPocket({ width: 1440, stored: 'pocket' }), true);
  assert.equal(detectPocket({ width: 1440, stored: 'pocket', search: '?mobile=0' }), false);
  const env = readEnv({ innerWidth: 400, location: { search: '?x' }, localStorage: { getItem: () => { throw new Error('blocked'); } }, matchMedia: () => ({ matches: true }) });
  assert.deepEqual(env, { search: '?x', stored: null, width: 400, coarse: true });
});

test('pocket router: hash routes, tabs, neighbours, swipe decisions', () => {
  assert.deepEqual(parseRoute('#/notes'), { page: 'notes' });
  assert.deepEqual(parseRoute('#/track/trk_1'), { page: 'track', id: 'trk_1' });
  assert.deepEqual(parseRoute('#/track'), { page: 'tracks' });
  assert.deepEqual(parseRoute('#/nope'), { page: 'home' });
  assert.deepEqual(parseRoute(''), { page: 'home' });
  assert.equal(routeHash({ page: 'track', id: 'a b' }), '#/track/a%20b');
  assert.deepEqual(parseRoute(routeHash({ page: 'track', id: 'a b' })), { page: 'track', id: 'a b' });
  assert.equal(tabOf('track'), 'tracks');
  assert.equal(neighbour('home', -1), null);
  assert.equal(neighbour('home', 1), 'tracks');
  assert.equal(neighbour('track', 1), 'notes');
  assert.equal(neighbour(PAGES[PAGES.length - 1].id, 1), null);
  assert.equal(swipeDecision({ dx: -150, dy: 10, dt: 400, width: 390 }), 1);
  assert.equal(swipeDecision({ dx: 150, dy: 10, dt: 400, width: 390 }), -1);
  assert.equal(swipeDecision({ dx: -60, dy: 5, dt: 80, width: 390 }), 1); // flick
  assert.equal(swipeDecision({ dx: -60, dy: 5, dt: 400, width: 390 }), 0); // slow + short
  assert.equal(swipeDecision({ dx: -150, dy: 140, dt: 200, width: 390 }), 0); // diagonal / scroll
  assert.equal(swipeDecision({ dx: 20, dy: 0, dt: 10, width: 390 }), 0);
});

const cutoff = { key: 'cutoff', label: 'Cutoff', type: 'number', min: 20, max: 20000, default: 20000, step: 1, unit: 'Hz', curve: 'log' };
const mix = { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, default: 0.3, step: 0.01 };
const semis = { key: 'tune', label: 'Tune', type: 'number', min: -24, max: 24, default: 0, step: 1, unit: 'st' };

test('popup: step / nudge follows the param curve and step', () => {
  assert.equal(nudge(semis, 0, 1), 1);
  assert.equal(nudge(semis, 24, 1), 24);
  assert.equal(nudge(mix, 0.5, 1), 0.51);
  assert.equal(nudge(mix, 0.5, -1), 0.49);
  assert.equal(nudge(mix, 0, -1), 0);
  // log cutoff: a nudge is a constant ratio, ~7 % per step over 20..20k
  const up = nudge(cutoff, 1000, 1), up2 = nudge(cutoff, 100, 1);
  assert.ok(up > 1000 && up < 1100 && up2 > 100 && up2 < 110, `${up} ${up2}`);
  assert.ok(Math.abs(up / 1000 - up2 / 100) < 0.02);
  assert.ok(nudge(cutoff, 1000, 1, { fine: true }) < up);
  assert.equal(quantize(mix, 0.123456), 0.12);
  assert.equal(repeatDelay(0) > repeatDelay(1), true);
  assert.ok(repeatDelay(50) >= 35);
});

test('popup: musical presets per param type, plus min / default / max', () => {
  const labels = (d) => presetsFor(d).map((p) => p.label);
  const vals = (d) => presetsFor(d).map((p) => p.value);
  assert.deepEqual(vals(cutoff), [20, 200, 800, 2000, 8000, 20000]);
  assert.ok(labels(cutoff).some((l) => l.includes('2k')) && labels(cutoff).some((l) => l.includes('Default')));
  assert.deepEqual(vals(mix), [0, 0.25, 0.3, 0.5, 1]);
  assert.ok(presetsFor(mix).find((p) => p.value === 1).label.includes('100%'));
  assert.deepEqual(vals(semis), [-24, -12, -7, 0, 7, 12, 24]);
  assert.deepEqual(vals({ key: 'pan', label: 'Pan', min: -1, max: 1, default: 0, step: 0.01 }), [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(presetsFor({ type: 'enum', options: [{ value: 'a', label: 'A' }] }), [{ label: 'A', value: 'a' }]);
  // every real instrument / effect number param yields sorted in-range presets incl. its default
  const all = [...Object.values(INSTRUMENT_DEFS).flatMap((d) => d.params), ...Object.values(EFFECT_DEFS).flatMap((d) => d.params)].filter((d) => d.type === 'number');
  assert.ok(all.length > 100);
  for (const d of all) {
    const ps = presetsFor(d);
    assert.ok(ps.length >= 2, d.key);
    for (let i = 1; i < ps.length; i++) assert.ok(ps[i].value > ps[i - 1].value, `${d.key} sorted`);
    assert.ok(ps.every((p) => p.value >= d.min && p.value <= d.max), `${d.key} in range`);
    assert.ok(ps.some((p) => Math.abs(p.value - quantize(d, d.default)) < 1e-6), `${d.key} has default`);
    assert.equal(defaultOf(d), d.default);
  }
});

test('popup: typed entry and fine scrubbing', () => {
  assert.equal(parseTyped(cutoff, '2k'), 2000);
  assert.equal(parseTyped(cutoff, '2.5 kHz'), 2500);
  assert.equal(parseTyped(cutoff, '50000'), 20000);
  assert.equal(parseTyped(mix, '50%'), 0.5);
  assert.equal(parseTyped(mix, '0,25'), 0.25);
  assert.equal(parseTyped(semis, '−7'), -7);
  assert.equal(parseTyped({ min: 0, max: 10, step: 0.001, unit: 's' }, '120 ms'), 0.12);
  assert.equal(parseTyped(mix, 'loud'), null);
  assert.equal(parseTyped({ type: 'bool' }, 'on'), true);
  assert.equal(scrubFactor(0), 1);
  assert.equal(scrubFactor(25), 1);
  assert.ok(scrubFactor(60) <= 0.5 && scrubFactor(60) > 0.4);
  assert.ok(scrubFactor(1000) >= 0.05);
  assert.equal(scrubNorm(0.5, 100, 200, 0), 1);
  assert.ok(Math.abs(scrubNorm(0.5, 100, 200, 60) - 0.75) < 1e-9);
});

test('pocket: shell files exist, mobile CSS, desktop menu offers the Pocket layout', () => {
  for (const f of ['src/mobile/shell.js', 'styles/mobile.css', 'src/mobile/capture-worklet.js']) assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /detectPocket/);
  const actions = readFileSync(new URL('../src/ui/actions.js', import.meta.url), 'utf8');
  assert.match(actions, /Pocket layout/);
});
