#!/usr/bin/env node
// Loudness worklet vs the Node / offline DSP (dsp/loudness.js measureLoudness) on reference signals.
// Plays each signal through MasterAnalysis (meters.js) in a realtime AudioContext and compares
// integrated LUFS (±0.2 LU) and true peak (±0.2 dB).   node tools/browser-check/loudness-check.mjs
import { launch, serveRepo } from './browser.mjs';
import { measureLoudness } from '../../src/audio/dsp/loudness.js';

const SR = 48000, DUR = 4;
// deterministic reference signals (stereo)
function signals() {
  const n = SR * DUR;
  const mk = (f) => { const l = new Float32Array(n), r = new Float32Array(n); for (let i = 0; i < n; i++) { const [a, b] = f(i, i / SR); l[i] = a; r[i] = b; } return [l, r]; };
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  return {
    'sine 1 kHz -18 dBFS': mk((i, t) => { const v = 0.1259 * Math.sin(2 * Math.PI * 1000 * t); return [v, v]; }),
    // fs/4 at 45° phase: sample peak 0.707·A, true peak A → +3 dB inter-sample over
    'fs/4 inter-sample peak': mk((i) => { const v = 0.9 * Math.sin(Math.PI / 2 * i + Math.PI / 4); return [v, v]; }),
    'noise + 100 Hz, wide stereo': mk((i, t) => [0.2 * rnd() + 0.3 * Math.sin(2 * Math.PI * 100 * t), 0.15 * rnd() - 0.2 * Math.sin(2 * Math.PI * 100 * t)]),
  };
}

const srv = await serveRepo();
const { browser, page } = await launch();
let fails = 0;
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  for (const [name, chans] of Object.entries(signals())) {
    const ref = measureLoudness(chans, SR);
    const got = await page.evaluate(async ({ data, SR }) => {
      const { MasterAnalysis } = await import('/src/audio/meters.js');
      const ctx = new AudioContext({ sampleRate: SR });
      const g = ctx.createGain();
      const ma = new MasterAnalysis(ctx, g, g);
      for (let i = 0; i < 100 && ma.mode === 'pending'; i++) await new Promise((r) => setTimeout(r, 50));
      const buf = ctx.createBuffer(2, data[0].length, SR);
      buf.copyToChannel(Float32Array.from(data[0]), 0); buf.copyToChannel(Float32Array.from(data[1]), 1);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(g);
      ma.reset();
      src.start(ctx.currentTime + 0.05);
      await new Promise((r) => { src.onended = r; });
      await new Promise((r) => setTimeout(r, 300));
      const out = ma.read(); ma.dispose(); await ctx.close();
      return { mode: out.mode, integrated: out.integrated, truePeakDb: out.truePeakDb };
    }, { data: chans.map((c) => Array.from(c)), SR });
    const dI = got.integrated - ref.integrated, dT = got.truePeakDb - ref.truePeakDb;
    const ok = got.mode === 'worklet' && Math.abs(dI) <= 0.2 && Math.abs(dT) <= 0.2;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: mode=${got.mode}  I ${got.integrated.toFixed(2)} vs ${ref.integrated.toFixed(2)} LUFS (Δ${dI.toFixed(3)})  TP ${got.truePeakDb.toFixed(2)} vs ${ref.truePeakDb.toFixed(2)} dBTP (Δ${dT.toFixed(3)})`);
  }
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
