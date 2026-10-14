#!/usr/bin/env node
// Recording capture alignment: an impulse scheduled at a known context frame is fed to the capture worklet tap and
// the ScriptProcessor fallback tap (src/record/inputs.js createCaptureTap); the frame each one reports for the
// impulse must be exact (worklet) / within the documented fallback tolerance.   node tools/browser-check/record-check.mjs
import { launch, serveRepo } from './browser.mjs';

const srv = await serveRepo();
const { browser, page } = await launch();
if (process.env.DEBUG) page.on('console', (m) => console.log('  [page]', m.text()));
let fails = 0;
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const res = await page.evaluate(async () => {
    const { createCaptureTap } = await import('/src/record/inputs.js');
    const ctx = new AudioContext({ sampleRate: 48000 });
    const out = {};
    for (const kind of ['worklet', 'script']) {
      if (kind === 'script') globalThis.__noWorklet = true;
      const chunks = [];
      let tap;
      if (kind === 'worklet') tap = await createCaptureTap(ctx, 2, (m) => { if (m.type === 'chunk') chunks.push(m); });
      else {
        // force the fallback on the same context
        const saved = ctx.audioWorklet; Object.defineProperty(ctx, 'audioWorklet', { value: undefined, configurable: true });
        const mod = await import('/src/record/inputs.js?fallback');
        tap = await mod.createCaptureTap(ctx, 2, (m) => { if (m.type === 'chunk') chunks.push(m); });
        Object.defineProperty(ctx, 'audioWorklet', { value: saved, configurable: true });
      }
      const sink = ctx.createGain(); sink.gain.value = 0; tap.node.connect(sink); sink.connect(ctx.destination);
      const results = [], gaps = [];
      for (let rep = 0; rep < 3; rep++) {
        const buf = ctx.createBuffer(2, 64, ctx.sampleRate); buf.getChannelData(0)[0] = 1; buf.getChannelData(1)[0] = -1;
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(tap.node);
        chunks.length = 0;
        tap.start();
        const F = Math.round((ctx.currentTime + 0.4) * ctx.sampleRate) + 37 + rep * 11; // not on a render-quantum edge
        src.start(F / ctx.sampleRate);
        await new Promise((r) => setTimeout(r, 900));
        tap.stop();
        await new Promise((r) => setTimeout(r, 100));
        let at = null;
        for (const c of chunks) { const d = c.data[0]; for (let i = 0; i < d.length; i++) if (d[i] > 0.5) { at = c.frame + i; break; } if (at != null) break; }
        results.push(at == null ? null : at - F);
        for (let i = 1; i < chunks.length; i++) if (chunks[i].frame !== chunks[i - 1].frame + chunks[i - 1].data[0].length) gaps.push(chunks[i].frame - chunks[i - 1].frame - chunks[i - 1].data[0].length);
        src.disconnect();
      }
      out[kind] = { kind: tap.kind, offsets: results, gaps };
      tap.node.disconnect(); tap.close?.();
    }
    await ctx.close();
    return out;
  });
  for (const [k, r] of Object.entries(res)) {
    // the worklet must be gap-free; a ScriptProcessor may drop whole render quanta under load (main thread late):
    // those must show up as gaps at the right place (never as overlaps / shifted audio)
    const ok = r.offsets.every((o) => o === 0) && (k === 'worklet' ? !r.gaps.length : r.gaps.every((g) => g > 0 && g % 128 === 0));
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${k} tap (${r.kind}): reported frame − true frame = ${r.offsets.join(', ')}; chunk gaps (+) / overlaps (−): ${r.gaps.length ? r.gaps.join(', ') + (k === 'script' ? ' (ScriptProcessor input dropouts, placed exactly)' : '') : 'none'}`);
  }
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
