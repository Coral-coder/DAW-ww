#!/usr/bin/env node
// Analyzer devices in a real browser: a 220 Hz tone (+ a quieter octave partial on the right) runs through each analysis
// effect in a realtime AudioContext; every view (src/ui/scopes) is mounted and drawn, the tuner must read A3, the
// 3D waterfall reports WebGL or its 2D fallback, and no console errors may appear. Screenshot -> $SHOT (optional).
//   node tools/browser-check/scopes-check.mjs
import { launch, serveRepo } from './browser.mjs';

const srv = await serveRepo();
const { browser, page } = await launch();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if ((m.type() === 'error' && !/404/.test(m.text())) || (m.type() === 'warning' && /\[scope|waterfall/.test(m.text()))) errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
let fails = 0;
try {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  await page.addStyleTag({ url: '/styles/main.css' });
  const res = await page.evaluate(async () => {
    const { createEffect } = await import('/src/audio/effects.js');
    const { mountAnalyzer } = await import('/src/ui/scopes/index.js');
    const { getEffectDefaults, resolveEffectParams } = await import('/src/audio/effect-defs.js');
    const { h } = await import('/src/ui/dom.js');
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const merger = ctx.createChannelMerger(2);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 220;
    const g1 = ctx.createGain(); g1.gain.value = 0.3;
    const o2 = ctx.createOscillator(); o2.frequency.value = 440;
    const g2 = ctx.createGain(); g2.gain.value = 0.15;
    o1.connect(g1); g1.connect(merger, 0, 0); g1.connect(merger, 0, 1); o2.connect(g2); g2.connect(merger, 0, 1);
    o1.start(); o2.start();
    const out = {};
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', padding: '8px' } });
    document.body.appendChild(grid);
    const views = [];
    const kinds = [['oscilloscope', {}], ['vectorscope', {}], ['spectrum', { channel: 'stereo' }], ['spectrogram', {}], ['spectrogram', { view: '3d' }], ['tuner', {}], ['tuner', {}, true], ['spectrum', { channel: 'M' }, true], ['oscilloscope', { channel: 'ms', trigger: 'zero' }, true], ['spectrogram', { direction: 'v', scale: 'mel', colormap: 'cividis' }, true]];
    for (const [kind, extra, compact] of kinds) {
      const fx = createEffect(ctx, { id: kind, type: kind, params: { ...getEffectDefaults(kind), ...extra } });
      merger.connect(fx.input);
      fx.output.connect(ctx.destination);
      const params = resolveEffectParams({ type: kind, params: extra });
      const v = mountAnalyzer(kind, { compact, getProbe: () => fx.probe, getParams: () => params, popout: { key: kind + JSON.stringify(extra), title: kind } });
      grid.appendChild(h('div', { style: { height: compact ? '190px' : '300px', display: 'flex' } }, v.el));
      views.push({ kind, extra, fx, v, compact });
    }
    await new Promise((r) => setTimeout(r, 2500));
    // the tuner's readout comes from YIN on the probe: check it directly too
    const { detectPitch, noteOf } = await import('/src/audio/dsp/scope.js');
    const tp = views.find((x) => x.kind === 'tuner').fx.probe;
    tp.ensure(8192);
    const l = new Float32Array(tp.size), r = new Float32Array(tp.size);
    tp.read(l, r);
    const m = l.map((x, i) => (x + r[i]) / 2);
    const pitch = detectPitch(m, 48000, { minFreq: 25, maxFreq: 4200 });
    out.tuner = { freq: pitch.freq, note: noteOf(pitch.freq)?.label };
    // pixels: every canvas painted something other than the background
    out.painted = views.map(({ kind, extra, v, compact }) => {
      const c = v.el.querySelector('canvas:not(.an-gl)');
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 16) if (data[i] + data[i + 1] + data[i + 2] > 200) lit++;
      const gl = v.el.querySelector('.an-gl');
      return { kind: kind + (extra.view ? ':' + extra.view : '') + (compact ? ' (compact)' : ''), w: c.width, h: c.height, lit, gl: gl ? gl.style.display !== 'none' : null };
    });
    // pop-out window opens and draws
    views[2].v.el.querySelector('.an-tool:last-child').click();
    await new Promise((r) => setTimeout(r, 600));
    const pop = document.querySelector('.an-pop canvas');
    out.popout = pop ? { w: pop.width, h: pop.height } : null;
    window.__grid = grid;
    return out;
  });
  console.log(JSON.stringify(res, null, 1));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  // detached views stop by themselves (no errors after removal)
  await page.evaluate(async () => { window.__grid.remove(); document.querySelector('.an-pop')?.remove(); await new Promise((r) => setTimeout(r, 300)); });
  if (res.tuner.note !== 'A3') { fails++; console.log('FAIL tuner', res.tuner); }
  for (const p of res.painted) if (p.lit < 20) { fails++; console.log('FAIL nothing drawn', p); }
  if (!res.popout) { fails++; console.log('FAIL pop-out'); }
  if (errors.length) { fails++; console.log('FAIL console errors', errors); }
} finally { await browser.close(); srv.close(); }
console.log(fails ? `${fails} failure(s)` : 'PASS');
process.exit(fails ? 1 : 0);
