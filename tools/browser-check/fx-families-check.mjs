#!/usr/bin/env node
// Renders every space / character family effect (and its presets) in an OfflineAudioContext in headless Chromium:
// the worklet processors must load offline, every preset must produce finite, non-silent, non-exploding audio, and
// the latency-reporting effects must line up with their dry path (impulse peak at the reported latency).
//   node tools/browser-check/fx-families-check.mjs [type ...]       (exit 1 on failure)
//   FX_NO_WORKLET=1 node …   checks the native fallbacks instead (as in browsers without AudioWorklet)
import { launch, serveRepo } from './browser.mjs';

const TYPES = process.argv.slice(2).length ? process.argv.slice(2) : ['algoReverb', 'shimmer', 'tapeDelay', 'multitap', 'grainDelay', 'pitchShift', 'vocoder', 'formantShift', 'freqShift', 'ringMod', 'resonator', 'autoWah', 'distortionPlus', 'msTool', 'haas'];

const srv = await serveRepo();
const { browser, page } = await launch();
let failed = 0;
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  if (process.env.FX_NO_WORKLET) await page.evaluate(() => { globalThis.DAW3_NO_FX_WORKLET = true; });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [page]', m.text()); });
  const res = await page.evaluate(async (types) => {
    const { createEffect } = await import('/src/audio/effects.js');
    const { EFFECT_DEFS } = await import('/src/audio/effect-defs.js');
    const sr = 48000;
    const out = [];
    // test signal: a plucked saw note + a noise burst + a vowel-ish pulse train (2 s)
    const sig = (n) => {
      const x = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += 150 / sr; if (ph >= 1) ph -= 1;
        const env = t < 1.2 ? Math.exp(-t * 2) : 0;
        x[i] = (2 * ph - 1) * 0.3 * env + (t > 0.5 && t < 0.55 ? (Math.random() * 2 - 1) * 0.3 : 0);
      }
      return x;
    };
    const render = async (type, params, { secs = 2.5, impulse = false } = {}) => {
      const n = Math.round(sr * secs);
      const ctx = new OfflineAudioContext(2, n, sr);
      const fx = createEffect(ctx, { id: 'x', type, enabled: true, params }, { getBpm: () => 120, getBeatAt: () => 0 });
      if (fx.ready) await fx.ready;
      const b = ctx.createBuffer(1, n, sr);
      if (impulse) b.getChannelData(0)[1000] = 1; else b.getChannelData(0).set(sig(n));
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(fx.input); fx.output.connect(ctx.destination); s.start(0);
      // vocoder sidechain: a chord pad into the key input
      if (fx.keyInput) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 110; o.connect(fx.keyInput); o.start(0); }
      const t0 = performance.now();
      const buf = await ctx.startRendering();
      const ms = performance.now() - t0;
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      let peak = 0, s2 = 0, nan = false, peakAt = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(L[i]), c = Math.abs(R[i]);
        if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nan = true;
        if (a > peak) { peak = a; peakAt = i; } if (c > peak) { peak = c; peakAt = i; }
        s2 += L[i] * L[i] + R[i] * R[i];
      }
      return { peak, rms: Math.sqrt(s2 / (2 * n)), nan, peakAt, ms, latency: fx.latency * sr, worklet: fx.probe };
    };
    for (const type of types) {
      const def = EFFECT_DEFS[type];
      const sets = [['(defaults)', {}], ...Object.entries(def.presets || {})];
      for (const [name, params] of sets) {
        try {
          const r = await render(type, { ...params, mix: params.mix ?? 1 });
          const bad = r.nan ? 'NaN' : r.peak > 4 ? 'too loud ' + r.peak.toFixed(2) : r.rms < 1e-4 && !['msTool'].includes(type) ? 'silent' : '';
          out.push([`${type} / ${name}`, bad || 'ok', `peak ${r.peak.toFixed(3)} rms ${r.rms.toFixed(4)} ${r.ms.toFixed(0)} ms`]);
        } catch (e) { out.push([`${type} / ${name}`, 'error: ' + (e?.message || e), '']); }
      }
    }
    // latency alignment: dry (mix 0) impulse peak must sit at the reported latency
    // (and the wet impulse of a unity shift / clean drive sits there too)
    const LAT = [['pitchShift', {}, true], ['pitchShift', { latency: 'low' }, true], ['formantShift', { pitch: 5 }, false], ['distortionPlus', { oversample: '4x', shape: 'soft', drive: 0 }, true], ['distortionPlus', { oversample: '2x', shape: 'soft', drive: 0 }, true]];
    for (const [type, params, wet] of LAT) {
      for (const mix of wet ? [0, 1] : [0]) {
        const r = await render(type, { ...params, mix }, { secs: 0.5, impulse: true });
        const off = r.peakAt - 1000;
        out.push([`latency ${type} ${JSON.stringify(params)} ${mix ? 'wet' : 'dry'}`, Math.abs(off - Math.round(r.latency)) <= 2 ? 'ok' : `peak at +${off}, reported ${r.latency}`, `reported ${Math.round(r.latency)} frames`]);
      }
    }
    return out;
  }, TYPES);
  for (const [what, r, info] of res) { console.log(`${r === 'ok' ? 'PASS' : 'FAIL'}  ${what}  ${r === 'ok' ? '' : '(' + r + ') '}${info}`); if (r !== 'ok') failed++; }
} finally {
  await browser.close(); srv.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all effect checks passed');
process.exit(failed ? 1 : 0);
