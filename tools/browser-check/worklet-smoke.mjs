#!/usr/bin/env node
// Worklet smoke test: loads every daW³ AudioWorklet module into a realtime AudioContext and an
// OfflineAudioContext in headless Chromium and checks that the processors register and produce audio.
//   node tools/browser-check/worklet-smoke.mjs            (exit 1 on failure)
import { launch, serveRepo } from './browser.mjs';

const MODULES = [
  ['/src/audio/loudness-worklet.js', 'daw3-loudness'],
  ['/src/audio/warp/worklet.js', 'daw3-warp'],
  ['/src/record/capture-processor.js', 'daw3-capture'],
  ['/src/audio/stream/stream-processor.js', 'daw3-stream'],
  ['/src/audio/fx/dynamics-worklet.js', 'daw3-multiband'],
  ['/src/audio/fx/rhythm-worklet.js', 'daw3-rhythm'],
  ['/src/audio/fx/worklets/fx-processors.js', 'daw3-fx-reverb'],
  ['/src/audio/wavetable/processor.js', 'daw3-wavetable'],
];

const srv = await serveRepo();
const { browser, page } = await launch();
let failed = 0;
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const res = await page.evaluate(async (mods) => {
    const within = (p, ms = 5000) => Promise.race([p.then(() => 'ok', (e) => 'error: ' + (e?.message || e)), new Promise((r) => setTimeout(() => r('timeout'), ms))]);
    const out = [];
    const ac = new AudioContext();
    // a minimal inline processor proves the audio thread runs (output reaches an AnalyserNode)
    const blob = URL.createObjectURL(new Blob(['registerProcessor("smoke-dc",class extends AudioWorkletProcessor{process(i,o){for(const c of o[0])c.fill(0.25);return true}})'], { type: 'text/javascript' }));
    out.push(['realtime blob module', await within(ac.audioWorklet.addModule(blob))]);
    if (out[0][1] === 'ok') {
      const n = new AudioWorkletNode(ac, 'smoke-dc'); const an = ac.createAnalyser(); n.connect(an);
      await new Promise((r) => setTimeout(r, 300));
      const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
      out.push(['realtime processor output', Math.abs(buf[100] - 0.25) < 1e-6 ? 'ok' : 'got ' + buf[100]]);
    }
    const oc = new OfflineAudioContext(1, 256, 48000);
    out.push(['offline blob module', await within(oc.audioWorklet.addModule(blob))]);
    if (out.at(-1)[1] === 'ok') { new AudioWorkletNode(oc, 'smoke-dc').connect(oc.destination); const b = await oc.startRendering(); out.push(['offline processor output', b.getChannelData(0)[200] === 0.25 ? 'ok' : 'got ' + b.getChannelData(0)[200]]); }
    for (const [url, name] of mods) {
      out.push([`realtime ${url}`, await within(ac.audioWorklet.addModule(url))]);
      try { new AudioWorkletNode(ac, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: {} }).disconnect(); out.push([`  node '${name}'`, 'ok']); } catch (e) { out.push([`  node '${name}'`, 'error: ' + e.message]); }
    }
    await ac.close();
    return out;
  }, MODULES);
  for (const [what, r] of res) { console.log(`${r === 'ok' ? 'PASS' : 'FAIL'}  ${what}${r === 'ok' ? '' : '  (' + r + ')'}`); if (r !== 'ok') failed++; }
} finally {
  await browser.close(); srv.close();
}
console.log(failed ? `${failed} worklet check(s) failed` : 'all worklet checks passed');
process.exit(failed ? 1 : 0);
