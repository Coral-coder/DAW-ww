#!/usr/bin/env node
// Analyzers inside the app: analysis effects on a track (device-panel cards draw, pop-out opens), the Mixer's Scopes
// panel on the master, and Pocket's effect card. Screenshots -> $SHOT_DIR (optional).
//   node tools/browser-check/scopes-app-check.mjs
import { launch, serveRepo } from './browser.mjs';

const srv = await serveRepo();
const { browser, page } = await launch();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (/\[scope|waterfall/.test(m.text()) && m.type() !== 'log') errors.push(m.text()); });
const shot = async (name) => { if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); };
const wait = (ms) => page.waitForTimeout(ms);
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
try {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(srv.url + '/index.html?mobile=0');
  await wait(4000);
  await page.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove())); // the app may reload once (layout / service worker)
  await page.waitForFunction(() => window.daw3?.store, null, { timeout: 30000 });
  await wait(1000);
  await page.evaluate(() => window.daw3.engine.init?.());
  await wait(1000);
  await page.evaluate(() => { window.daw3.actions.addTrack('synth'); });
  await wait(1000);
  const ids = await page.evaluate(async () => {
    const app = window.daw3;
    const { createEffect } = await import('/src/core/model.js');
    const t = app.store.get().tracks.at(-1);
    const fx = ['spectrum', 'oscilloscope', 'tuner'].map((type) => createEffect(type, {}));
    app.store.transact('Add analyzers', (p) => { p.tracks.find((x) => x.id === t.id).fx.push(...fx); });
    return { track: t.id, fx: fx.map((f) => f.id) };
  });
  await wait(1500);
  // play a note so there is signal
  await page.evaluate(({ track }) => { const e = window.daw3.engine; e.init?.(); e.noteOn(track, 57, 0.9); }, ids);
  await page.evaluate(() => document.querySelector('.an-card')?.scrollIntoView({ inline: 'start' }));
  await wait(1500);
  const cards = await page.evaluate(() => [...document.querySelectorAll('.an-card .an-view')].map((v) => {
    const c = v.querySelector('canvas:not(.an-gl)');
    return { cls: v.className, w: c?.width, h: c?.height };
  }));
  check(cards.length === 3 && cards.every((c) => c.w > 100 && c.h > 80), `three analyzer cards drawn ${JSON.stringify(cards)}`);
  await shot('cards');
  await page.evaluate(() => document.querySelector('.an-spectrum .an-tool:last-child')?.click());
  await wait(800);
  check(await page.evaluate(() => !!document.querySelector('.an-pop canvas')), 'pop-out window');
  await shot('popout');
  await page.evaluate(() => document.querySelector('.an-pop .an-pop-x')?.click());
  // mixer scopes panel
  await page.evaluate(() => window.daw3.showView('mixer'));
  await wait(1200);
  const btn = await page.$('button.toggle:has-text("Scopes")');
  check(!!btn, 'Scopes button in the mixer toolbar');
  await btn?.evaluate((b) => b.click()); // (a welcome dialog may cover the page)
  await wait(1200);
  const panel = await page.evaluate(() => { const p = document.querySelector('.sc-panel'); const c = p?.querySelector('canvas'); return p && !p.classList.contains('hidden') ? { w: c?.width, h: c?.height, tabs: p.querySelectorAll('.sc-tabs button').length } : null; });
  check(panel && panel.w > 100 && panel.tabs === 5, `scopes panel ${JSON.stringify(panel)}`);
  for (const tab of ['Spectrogram', 'Tuner', 'Vector']) {
    await page.evaluate((t) => [...document.querySelectorAll('.sc-tabs button')].find((b) => b.textContent === t)?.click(), tab);
    await wait(500);
  }
  await shot('mixer-scopes');
  await page.evaluate(({ track }) => window.daw3.engine.noteOff(track, 57), ids);
  // Pocket
  await page.goto(srv.url + '/index.html?mobile=1');
  await page.setViewportSize({ width: 400, height: 860 });
  await page.waitForFunction(() => window.daw3?.store || document.querySelector('.pk-app, .pk-shell, [class^="pk-"]'), null, { timeout: 30000 });
  await wait(1500);
  check(errors.length === 0, `no console errors ${JSON.stringify(errors)}`);
} finally { await browser.close(); srv.close(); }
console.log(fails ? `${fails} failure(s)` : 'PASS');
process.exit(fails ? 1 : 0);
