// SETI Scope: pure signal searches (spike, gaussian, pulse, triplet, chirp), colour ramp, projection math and
// panel string formatting (src/audio/analysis/seti-signals.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/audio/analysis/seti-signals.js';

const SR = 48000, N = 4096;

/** dB spectrum with a noise floor and sinusoid peaks [{f, db}] (3-bin main lobe, like a windowed FFT). */
function spectrum(peaks, floor = -95, seed = 1) {
  const db = new Float32Array(N / 2);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < db.length; i++) db[i] = floor + rnd() * 6;
  const hz = SR / N;
  for (const p of peaks) {
    const x = p.f / hz;
    const i0 = Math.floor(x);
    for (let i = i0 - 2; i <= i0 + 3; i++) {
      const d = i - x;
      db[i] = Math.max(db[i], p.db - 6 * d * d * 4);
    }
  }
  return db;
}

test('seti: colour ramp goes blue -> green -> yellow -> red and clamps', () => {
  const lo = S.colorRamp(0), mid = S.colorRamp(0.48), hi74 = S.colorRamp(0.74), hi = S.colorRamp(1);
  assert.ok(lo[2] > lo[0] && lo[2] > lo[1], 'low power is blue');
  assert.ok(mid[1] > mid[0] && mid[1] > mid[2], 'middle is green');
  assert.ok(hi74[0] > 0.9 && hi74[1] > 0.85 && hi74[2] < 0.2, 'yellow');
  assert.ok(hi[0] > 0.9 && hi[1] < 0.2, 'top is red');
  assert.deepEqual(S.colorRamp(-3), S.colorRamp(0));
  assert.deepEqual(S.colorRamp(9), S.colorRamp(1));
  assert.deepEqual(S.colorRamp(NaN), S.colorRamp(0));
  for (let t = 0; t <= 1; t += 0.05) for (const c of S.colorRamp(t)) assert.ok(c >= 0 && c <= 1);
  assert.match(S.rampCss(1), /^rgba\(255,31,13,1\)$/);
  assert.equal(S.dbToUnit(-18), 1);
  assert.equal(S.dbToUnit(-200), 0);
});

test('seti: log band map covers the range with ≥1 bin per band', () => {
  const e = S.makeBandMap(48, N, SR, 30, 16000);
  assert.equal(e.length, 96);
  for (let b = 0; b < 48; b++) {
    assert.ok(e[b * 2 + 1] > e[b * 2], `band ${b} non-empty`);
    if (b) assert.ok(e[b * 2] >= e[b * 2 - 2], 'monotonic');
  }
  assert.ok(Math.abs(e[95] * SR / N - 16000) < 20);
  const db = spectrum([{ f: 1000, db: -20 }]);
  const bands = S.bandsFromDb(db, e);
  const loudest = bands.indexOf(Math.max(...bands));
  assert.ok(e[loudest * 2] * SR / N <= 1000 && e[loudest * 2 + 1] * SR / N >= 1000, 'the 1 kHz tone lands in its band');
});

test('seti: baseline smoothing is a centred running mean', () => {
  const x = new Float32Array([0, 0, 9, 0, 0]);
  const b = S.baselineSmooth(x, 1);
  assert.deepEqual([...b], [0, 3, 3, 3, 0]);
  const flat = S.baselineSmooth(new Float32Array(50).fill(2), 7);
  assert.ok(flat.every((v) => Math.abs(v - 2) < 1e-6));
});

test('seti: spike finder returns the strongest peak with interpolated frequency + note name', () => {
  const db = spectrum([{ f: 440, db: -24 }, { f: 3000, db: -40 }]);
  const sp = S.findBestSpike(db, { sampleRate: SR, fftSize: N });
  assert.ok(sp, 'found');
  assert.ok(Math.abs(sp.freq - 440) < 3, `freq ${sp.freq}`);
  assert.equal(sp.note.name, 'A4');
  assert.ok(sp.power > 20, `power ratio ${sp.power}`);
  assert.ok(Math.abs(sp.score - sp.power / S.SPIKE_THRESHOLD) < 1e-9);
  assert.equal(S.findBestSpike(new Float32Array(N / 2).fill(-Infinity), { sampleRate: SR, fftSize: N }), null, 'silence: no spike');
  assert.deepEqual(S.freqToNote(261.6256), { midi: 60, name: 'C4', cents: 0 });
  assert.equal(S.freqToNote(0), null);
  assert.equal(S.freqToNote(445).cents, 20);
});

test('seti: gaussian fit recovers centre, width and baseline; noise scores low', () => {
  const n = 200;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 3 * Math.exp(-((i - 120) ** 2) / (2 * 22 * 22)) + 0.5;
  const g = S.fitGaussian(y);
  assert.ok(Math.abs(g.mu - 120) < 2, `mu ${g.mu}`);
  assert.ok(Math.abs(g.sigma - 22) < 3, `sigma ${g.sigma}`);
  assert.ok(Math.abs(g.a - 3) < 0.2 && Math.abs(g.b - 0.5) < 0.1);
  assert.ok(g.r2 > 0.99, `r2 ${g.r2}`);
  assert.ok(Math.abs(S.gaussianAt(g, 120) - 3.5) < 0.2);
  let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const noise = Float32Array.from({ length: n }, () => rnd());
  const gn = S.fitGaussian(noise);
  assert.ok(!gn || gn.r2 < 0.3, `noise r2 ${gn?.r2}`);
  assert.equal(S.fitGaussian(new Float32Array(50).fill(1)), null, 'flat: nothing to fit');
  assert.equal(S.fitGaussian([1, 2]), null);
});

/** Onset envelope with clicks every `period` seconds (+ optional extra clicks) at ENV_FPS. */
function clickEnv(seconds, period, extra = []) {
  const fps = S.ENV_FPS;
  const env = new Float32Array(Math.round(seconds * fps));
  for (let t = 0.05; t < seconds; t += period) env[Math.round(t * fps)] += 1;
  for (const t of extra) env[Math.round(t * fps)] += 0.6;
  return env;
}

test('seti: pulse detection finds the BPM and the beat phase', () => {
  const env = clickEnv(6, 0.5); // 120 BPM
  const p = S.detectPulse(env, S.ENV_FPS);
  assert.ok(Math.abs(p.bpm - 120) < 2, `bpm ${p.bpm}`);
  assert.ok(Math.abs(p.period - 0.5) < 0.01);
  assert.ok(p.power > 0.5 && p.score > 1);
  // last click at 5.55 s, envelope ends at 5.98 s -> 0.43 s / 0.5 s into the beat
  assert.ok(Math.abs(p.phase - 0.86) < 0.06, `phase ${p.phase}`);
  const p2 = S.detectPulse(clickEnv(6, 60 / 95), S.ENV_FPS);
  assert.ok(Math.abs(p2.bpm - 95) < 2.5, `bpm ${p2.bpm}`);
  assert.equal(S.detectPulse(new Float32Array(20), S.ENV_FPS), null, 'too short');
});

test('seti: onset picking + triplet detector prefers triplets of the beat', () => {
  // straight quarter notes at 0.5 s plus a burst of three triplet-eighths (spacing 1/3 beat) at 2.0 s
  const env = clickEnv(4, 0.5, [2.05 + 0.5 / 3, 2.05 + 1 / 3]);
  const on = S.pickOnsets(env, S.ENV_FPS);
  assert.ok(on.length >= 9, `onsets ${on.length}`);
  for (let i = 1; i < on.length; i++) assert.ok(on[i].t > on[i - 1].t);
  const tr = S.findTriplet(on, { beatPeriod: 0.5 });
  assert.ok(tr.isTriplet, 'flagged as a rhythmic triplet');
  assert.ok(Math.abs(tr.period - 0.5 / 3) < 0.03, `period ${tr.period}`);
  // without a beat reference the evenly spaced quarters are still a valid (straight) triple
  const plain = S.findTriplet(S.pickOnsets(clickEnv(4, 0.5), S.ENV_FPS), { beatPeriod: 0.5 });
  assert.ok(plain && !plain.isTriplet && Math.abs(plain.period - 0.5) < 0.03);
  assert.equal(S.findTriplet([{ t: 0, strength: 1 }, { t: 0.3, strength: 1 }]), null);
  assert.equal(S.findTriplet([{ t: 0, strength: 1 }, { t: 0.3, strength: 1 }, { t: 0.9, strength: 1 }]), null, 'uneven: no triplet');
});

test('seti: chirp = drift of the latest continuous pitch run (octave jumps start a new run)', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ t: i * 0.05, f: 880 }); // older run an octave up
  for (let i = 0; i < 20; i++) pts.push({ t: 0.5 + i * 0.05, f: 440 + 4 * (i * 0.05) }); // +4 Hz/s glide
  const c = S.estimateChirp(pts);
  assert.ok(Math.abs(c.rate - 4) < 0.01, `rate ${c.rate}`);
  assert.equal(c.n, 20);
  assert.ok(c.r2 > 0.99);
  assert.equal(S.estimateChirp(pts.slice(0, 3)).rate, 0);
  assert.equal(S.estimateChirp([{ t: 0, f: 440 }, { t: 0.01, f: 440 }, { t: 0.02, f: 440 }, { t: 0.03, f: 440 }, { t: 0.04, f: 440 }]).rate, 0, 'span too short');
});

test('seti: perspective projection — centre maps to the screen centre, depth orders, behind is null', () => {
  const vp = S.mulMat4(S.perspective(Math.PI / 3, 2, 0.1, 100), S.lookAt([0, 0, 5], [0, 0, 0]));
  const c = S.projectPoint(vp, 0, 0, 0, 800, 400);
  assert.ok(Math.abs(c.x - 400) < 1e-3 && Math.abs(c.y - 200) < 1e-3);
  const up = S.projectPoint(vp, 0, 1, 0, 800, 400);
  assert.ok(up.y < 200, 'y up is screen up');
  const right = S.projectPoint(vp, 1, 0, 0, 800, 400);
  assert.ok(right.x > 400);
  const far = S.projectPoint(vp, 1, 0, -10, 800, 400);
  assert.ok(far.x < right.x && far.x > 400, 'farther points shrink toward the centre');
  assert.ok(far.z > c.z, 'NDC depth increases with distance');
  assert.equal(S.projectPoint(vp, 0, 0, 10, 800, 400), null, 'behind the camera');
  // f = 1/tan(30°): a point at x = tan(30°)·aspect·d from the axis reaches the right edge
  const edge = S.projectPoint(vp, Math.tan(Math.PI / 6) * 2 * 5, 0, 0, 800, 400);
  assert.ok(Math.abs(edge.x - 800) < 1e-2, `edge ${edge.x}`);
  const la = S.lookAt([0.3, 1, 2], [0, 0, 0]);
  const id = S.mulMat4(la, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  assert.ok([...id].every((v, i) => Math.abs(v - la[i]) < 1e-6), 'M · I = M');
  for (const mode of S.CAMERA_MODES) {
    for (const t of [0, 13.7, 300]) {
      const m = S.viewProjection(mode, t, 16 / 9);
      const p = S.projectPoint(m, 0, 0, -0.9, 1600, 900);
      assert.ok(p && p.x > 0 && p.x < 1600 && p.y > 0 && p.y < 900, `${mode} @${t}: plot centre on screen`);
    }
  }
  // portrait phone: the orbit / fixed views keep all four floor corners on screen
  for (const mode of ['orbit', 'fixed']) {
    for (const t of [0, 20, 45]) {
      const m = S.viewProjection(mode, t, 390 / 844);
      for (const [x, z] of [[-1, 0], [1, 0], [-1, -2], [1, -2]]) {
        const p = S.projectPoint(m, x, 0, z, 390, 844);
        assert.ok(p && p.x > -5 && p.x < 395, `${mode} @${t} corner ${x},${z} at ${p?.x}`);
      }
    }
  }
});

test('seti: panel strings', () => {
  assert.equal(S.formatHz(440), '440.00 Hz');
  assert.equal(S.formatHz(1234.5), '1.234 kHz');
  assert.equal(S.formatHz(S.skyFrequency(440)), '1.420845752 GHz');
  assert.equal(S.formatHz(0), '—');
  assert.equal(S.formatRA(12, 3, 1), "12 hr 03' 01''");
  assert.equal(S.keyToDec(0, 'major'), 7.5);
  assert.equal(S.keyToDec(11, 'major'), 90);
  assert.equal(S.keyToDec(9, 'minor'), -75);
  assert.equal(S.formatDec(-75), '−75.00°');
  assert.equal(S.formatDec(7.5), '+7.50°');
  assert.equal(S.formatCpuTime(3723.25), '1 hr 02 min 03.3 sec');
  assert.equal(S.formatCpuTime(-1), '0 hr 00 min 00.0 sec');
  assert.equal(S.julianDate(new Date(Date.UTC(2000, 0, 1, 12))), 2451545);
  assert.equal(S.formatRecordedOn(new Date(Date.UTC(2000, 0, 1, 12))), '2451545.00000 (Sat 01 Jan 2000 12:00:00)');
  assert.equal(S.formatChirp(-0.5), '−0.5000 Hz/s');
  assert.equal(S.formatChirp(0), '+0.0000 Hz/s');
  assert.equal(S.formatPercent(0.4567), '45.670%');
  assert.equal(S.formatPercent(2), '100.000%');
  assert.equal(S.formatPower(23.456), '23.46');
  assert.equal(S.formatPower(123456), '1.23e+5');
  assert.equal(S.formatNote({ name: 'A4', cents: -3 }), 'A4 −3¢');
  const rows = S.analysisRows({ stage: 'pulse', fftSize: 4096, chirp: { rate: 1.25 }, spike: { power: 30, score: 1.25, freq: 440, note: { name: 'A4', cents: 0 } }, pulse: { power: 0.8, score: 3, bpm: 120, period: 0.5, phase: 0.25 }, gaussian: null, triplet: { power: 0.9, score: 1.4, period: 0.1667, isTriplet: true } });
  const m = Object.fromEntries(rows.filter(([k]) => k));
  assert.equal(m.Doing, 'Searching for pulses');
  assert.equal(m['Chirp rate'], '+1.2500 Hz/s');
  assert.equal(m['Fft length'], '4096');
  assert.equal(m['Best spike'], 'power 30.00, score 1.250');
  assert.equal(m['Best gaussian'], 'power —, fit —');
  assert.ok(rows.some(([, v]) => v === '440.00 Hz A4 +0¢'));
  assert.ok(rows.some(([, v]) => v === '120.0 BPM, period 0.500 s, phase 0.25'));
  assert.ok(rows.some(([, v]) => v === 'period 0.167 s (triplet)'));
  assert.equal(rows.length, 10);
});

test('seti: streaming analyzer on a synthetic 120 BPM tone burst finds spike, pulse, gaussian and key', () => {
  const an = new S.SetiAnalyzer({ sampleRate: SR, fftSize: N });
  const time = new Float32Array(2048);
  const seen = new Set();
  const fps = 60;
  for (let f = 0; f < fps * 8; f++) {
    const t = f / fps;
    const beatPos = (t % 0.5) / 0.5;
    const level = beatPos < 0.15 ? 1 : 0.05; // a hit every half second
    const amp = level * (0.3 + 0.25 * Math.sin(t * 0.8)); // slow swell (the envelope the Gaussian fits)
    for (let i = 0; i < time.length; i++) time[i] = amp * Math.sin(2 * Math.PI * 220 * (i / SR));
    const db = spectrum([{ f: 220, db: 20 * Math.log10(amp + 1e-9) - 6 }, { f: 330, db: 20 * Math.log10(amp + 1e-9) - 14 }], -100, f + 1);
    const st = an.push(db, time, t);
    seen.add(st.stage);
  }
  const st = an.state;
  assert.deepEqual([...seen].sort(), [...S.STAGES].sort(), 'cycled through every stage');
  assert.ok(Math.abs(st.spike.freq - 220) < 4, `spike ${st.spike?.freq}`);
  assert.equal(st.spike.note.name, 'A3');
  assert.ok(st.pulse && Math.abs(st.pulse.bpm - 120) < 3, `bpm ${st.pulse?.bpm}`);
  assert.ok(st.gaussian && st.gaussian.r2 >= 0, 'gaussian fitted');
  assert.ok(st.onsets.length >= 4, `onsets ${st.onsets.length}`);
  assert.ok(st.key && [9, 4].includes(st.key.tonic), `key ${st.key?.name}`); // A / E (220 + 330 Hz = A–E fifth)
  assert.ok(Math.abs(st.chirp.rate) < 5, `steady tone: tiny chirp ${st.chirp.rate}`);
  assert.equal(an.envelope('loud', 2).length, 100);
});

test('seti: MixGraph strip analyser taps master / track / bus outputs, re-wires and releases', async () => {
  const { MixGraph } = await import('../src/audio/mixer.js');
  const { MockContext, latentEffectFactory } = await import('./lib/mock-audio.js');
  const { createProject, createTrack } = await import('../src/core/model.js');
  const p = createProject();
  p.master.fx = [];
  const tr = createTrack({ name: 'A', type: 'audio' });
  p.tracks = [tr];
  const ctx = new MockContext({ sampleRate: 48000 });
  const g = new MixGraph(ctx, { destination: ctx.destination, getBpm: () => 120, getBeatAt: () => 0, getSampleBuffer: () => null, createEffect: latentEffectFactory(() => 0), meters: true });
  g.sync(p);
  const m = g.stripAnalyser('master');
  assert.equal(m.fftSize, 4096);
  assert.equal(m.smoothingTimeConstant, 0);
  assert.notEqual(m, g.analyser, 'its own node: the shared master analyser keeps its smoothing');
  assert.ok(g.out.outs.includes(m), 'taps the master output');
  assert.equal(g.stripAnalyser('master'), m, 'cached');
  const strip = g.tracks.get(tr.id).strip;
  const t = g.stripAnalyser(tr.id);
  assert.ok(strip.meterDelay.outs.includes(t), 'taps the PDC-aligned post-fader point of the track');
  assert.ok(g.stripAnalyser(p.buses[0].id));
  assert.equal(g.stripAnalyser('nope'), null);
  const big = g.stripAnalyser(tr.id, { fftSize: 8192 });
  assert.notEqual(big, t);
  assert.ok(!strip.meterDelay.outs.includes(t), 'old tap disconnected');
  g.releaseStripAnalyser(tr.id);
  assert.ok(!strip.meterDelay.outs.includes(big));
  g.dispose();
  assert.equal(g.taps.size, 0);
});

test('seti: plot history ring, detail levels, frame budget, progress and session stats', async () => {
  const P = await import('../src/ui/visualizers/seti/plot.js');
  const h = new P.PlotHistory(4, 3);
  h.push([0, 0.5, 1, 2]);
  h.push([1, 1, 1, 1]);
  assert.deepEqual([...h.row(h.head)], [255, 255, 255, 255]);
  assert.equal(h.at(1, 1), 128 / 255);
  assert.equal(h.at(3, 1), 1, 'clamped');
  h.push([0, 0, 0, 0]); h.push([0.2, 0, 0, 0]);
  assert.equal(h.head, 1, 'ring wraps');
  assert.equal(h.at(0, 0), 51 / 255);
  assert.equal(h.at(0, 2), 1, 'two rows back');
  assert.ok(P.initialLevel({ width: 390, height: 844, coarse: true, dpr: 3 }) >= 3, 'phones start light');
  assert.ok(P.initialLevel({ width: 1920, height: 1080, dpr: 1 }) <= 2);
  for (const [b, r] of P.LEVELS) assert.ok(b * r * 30 < 2e5, 'vertex count stays modest');
  const fb = new P.FrameBudget({ budgetMs: 20, window: 1 });
  let drops = 0;
  for (let i = 0; i < 60; i++) drops += fb.tick(1 / 60);
  assert.equal(drops, 0, '60 fps is within budget');
  for (let i = 0; i < 40; i++) drops += fb.tick(1 / 30);
  assert.equal(drops, 1, '30 fps for a window drops one level');
  assert.equal(fb.tick(5), 0, 'a long pause (tab switch) is ignored');
  const fb2 = new P.FrameBudget({ budgetMs: 20, window: 10 });
  assert.equal(fb2.tick(0.5) + fb2.tick(0.5), 0);
  assert.equal(fb2.tick(0.5), 1, 'a device far over budget drops detail at once');
  const { createProject, createClip, createTrack } = await import('../src/core/model.js');
  const p = createProject();
  p.loop = { enabled: true, start: 4, end: 12 };
  assert.equal(P.songProgress(p, 8), 0.5);
  assert.equal(P.songProgress(p, 14), 0.25, 'pattern mode wraps in the loop');
  p.mode = 'song';
  const t = createTrack({ name: 'x' });
  p.tracks = [t];
  p.clips = [createClip(t.id, { start: 0, length: 32 })];
  assert.equal(P.songProgress(p, 8), 0.25);
  assert.equal(P.songProgress(p, 99), 1);
  assert.equal(P.songProgress(null, 1), 0);
  const s = new P.SessionStats();
  s.tick(0.5, true, 0); s.tick(0.5, true, 0); s.tick(0.5, true, 1); s.tick(0.5, false, null); s.tick(0.5, true, 1); s.tick(0.5, true, 2);
  assert.equal(s.bars, 2);
  assert.equal(s.cpu, 2.5);
});

test('seti: screensaver rule + prefs', async () => {
  const L = await import('../src/ui/visualizers/seti/launch.js');
  const base = { enabled: true, idleMinutes: 5, idleMs: 5 * 60000, playing: true, open: false, hidden: false };
  assert.equal(L.shouldStartScreensaver(base), true);
  assert.equal(L.shouldStartScreensaver({ ...base, enabled: false }), false, 'default off');
  assert.equal(L.shouldStartScreensaver({ ...base, playing: false }), false, 'only while playing');
  assert.equal(L.shouldStartScreensaver({ ...base, open: true }), false);
  assert.equal(L.shouldStartScreensaver({ ...base, hidden: true }), false);
  assert.equal(L.shouldStartScreensaver({ ...base, idleMs: 4 * 60000 }), false, 'not idle long enough');
  assert.equal(L.shouldStartScreensaver({ ...base, idleMinutes: 'x', idleMs: 5 * 60000 }), true, 'bad minutes fall back to 5');
  assert.equal(L.DEFAULT_PREFS.screensaver, false);
  assert.deepEqual(L.loadSetiPrefs(), L.DEFAULT_PREFS, 'no storage in Node: defaults');
  assert.equal(L.isSetiScopeOpen(), false);
  assert.equal(await L.openSetiScope({}), null, 'no DOM: nothing to open');
});

/** AnalyserNode-like frame: Blackman window, |FFT| / N in dB (radix-2, in place). */
function analyserFrame(x, out) {
  const n = x.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  for (let k = 0; k < n / 2; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / n + 1e-12);
  return out;
}

test('seti: analyzer on rendered audio (real FFT frames at 60 fps): BPM, note, triplet fill, gliding chirp', () => {
  const sr = 24000, n = 2048, fps = 60, seconds = 9, bpm = 120, beat = 60 / bpm;
  const len = Math.round(sr * seconds);
  const sig = new Float32Array(len);
  let ph1 = 0, ph2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const b = Math.floor(t / beat), tb = t - b * beat;
    // a plucked lead on every beat, a triplet fill (3 notes per beat) on every 4th beat; glide +3 Hz/s
    const hits = b % 4 === 3 ? [0, beat / 3, (2 * beat) / 3] : [0];
    let env = 0;
    for (const h of hits) if (tb >= h) env = Math.max(env, Math.exp(-(tb - h) / 0.06));
    const f = 440 + 3 * t;
    ph1 += (2 * Math.PI * f) / sr; ph2 += (2 * Math.PI * f * 1.5) / sr;
    sig[i] = env * (0.5 * Math.sin(ph1) + 0.15 * Math.sin(ph2)) * (0.6 + 0.4 * Math.sin(t * 0.7));
  }
  const an = new S.SetiAnalyzer({ sampleRate: sr, fftSize: n });
  const db = new Float32Array(n / 2);
  let triplets = 0, spikes = 0;
  for (let fr = Math.ceil((n / sr) * fps); fr < seconds * fps; fr++) {
    const end = Math.round((fr / fps) * sr);
    const block = sig.subarray(end - n, end);
    const st = an.push(analyserFrame(block, db), block, fr / fps);
    if (st.stage === 'triplet' && st.triplet?.isTriplet) triplets++;
    if (st.spike && Math.abs(st.spike.freq - (440 + 3 * fr / fps)) < 8) spikes++;
  }
  const st = an.state;
  assert.ok(Math.abs(st.pulse.bpm - 120) < 2, `pulse ${st.pulse.bpm}`);
  assert.ok(Math.abs(st.chirp.rate - 3) < 0.5 && st.chirp.r2 > 0.9, `chirp ${st.chirp.rate} Hz/s`);
  assert.ok(st.pulse.power > 0.3, `pulse power ${st.pulse.power}`);
  assert.ok(spikes > 200, `the lead is the best spike most of the time (${spikes})`);
  assert.ok(st.spike.note.name.startsWith('A') || st.spike.note.name.startsWith('Bb'), st.spike.note.name);
  assert.ok(triplets > 0, 'the triplet fill is found');
  assert.ok(st.gaussian && st.gaussian.r2 >= 0 && st.gaussian.sigma > 0);
  assert.ok(st.key, 'a key estimate exists');
});
