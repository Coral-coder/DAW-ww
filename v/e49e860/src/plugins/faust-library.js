// Faust DSP programs shipped with the plugin catalog (pure data, Node-safe).
// Instruments follow the Faust polyphony convention: `freq` (Hz), `gain` (0..1, from velocity) and
// `gate` (button) are driven by the host per voice; every other slider becomes a knob in the device
// panel. An optional `effect = …;` runs once after the voice mix. Effects are plain stereo DSPs.
// Labels: "[n]" orders controls, [unit:…] / [scale:log] are honoured by the knob UI.

const HEAD = 'import("stdfaust.lib");\n';
const VOICE = `freq = hslider("freq", 440, 20, 20000, 0.01);
gain = hslider("gain", 0.7, 0, 1, 0.01);
gate = button("gate");
`;

export const FAUST_INSTRUMENTS = {
  'va-poly': {
    name: 'VA Poly Synth',
    description: 'Virtual-analog polysynth: two detuned saws + square sub through a Moog ladder with filter envelope.',
    code: `${HEAD}declare name "VA Poly Synth";
declare author "daW³ (built on the Faust libraries)";
declare license "MIT";
${VOICE}detune = hslider("[1]Detune[style:knob]", 0.15, 0, 1, 0.01);
sub = hslider("[2]Sub[style:knob]", 0.4, 0, 1, 0.01);
cutoff = hslider("[3]Cutoff[style:knob][unit:Hz][scale:log]", 1600, 60, 16000, 1);
res = hslider("[4]Resonance[style:knob]", 0.45, 0, 0.95, 0.01);
envamt = hslider("[5]Filter env[style:knob]", 0.5, 0, 1, 0.01);
a = hslider("[6]Attack[style:knob][unit:s]", 0.005, 0.001, 3, 0.001);
d = hslider("[7]Decay[style:knob][unit:s]", 0.35, 0.01, 3, 0.01);
s = hslider("[8]Sustain[style:knob]", 0.7, 0, 1, 0.01);
r = hslider("[9]Release[style:knob][unit:s]", 0.35, 0.01, 6, 0.01);
dt = detune * 0.012;
osc = os.sawtooth(freq * (1 + dt)) + os.sawtooth(freq * (1 - dt)) + sub * os.square(freq * 0.5);
fenv = en.adsr(0.002, d, 0.15, r, gate);
fc = min(18000, cutoff * (1 + envamt * 7 * fenv));
process = osc * 0.3 : ve.moog_vcf_2b(res, fc) : *(en.adsr(a, d, s, r, gate) * gain) <: _, _;
`,
  },
  supersaw: {
    name: 'Supersaw',
    description: 'Seven detuned saws (JP-8000 style) with a stereo spread and a gentle low-pass — trance leads & stacks.',
    code: `${HEAD}declare name "Supersaw";
declare license "MIT";
${VOICE}detune = hslider("[1]Detune[style:knob]", 0.35, 0, 1, 0.01);
mix = hslider("[2]Side saws[style:knob]", 0.7, 0, 1, 0.01);
cutoff = hslider("[3]Cutoff[style:knob][unit:Hz][scale:log]", 7000, 200, 18000, 1);
a = hslider("[4]Attack[style:knob][unit:s]", 0.01, 0.001, 3, 0.001);
r = hslider("[5]Release[style:knob][unit:s]", 0.4, 0.01, 6, 0.01);
offs = (-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242);
saw(i) = os.sawtooth(freq * (1 + detune * 0.18 * ba.take(i + 1, offs)));
lvl(i) = ba.if(i == 3, 1 - 0.5 * mix, mix * 0.55);
left = sum(i, 7, saw(i) * lvl(i) * (1 - (i % 2) * 0.6));
right = sum(i, 7, saw(i) * lvl(i) * (1 - ((i + 1) % 2) * 0.6));
env = en.asr(a, 1, r, gate) * gain;
process = left, right : par(k, 2, fi.lowpass(2, cutoff) : *(env * 0.32));
`,
  },
  pluck: {
    name: 'Karplus-Strong Pluck',
    description: 'Physical plucked string (Karplus-Strong): noise burst into a tuned, damped delay loop — guitars, harps, kotos.',
    code: `${HEAD}declare name "KS Pluck";
declare license "MIT";
${VOICE}bright = hslider("[1]Brightness[style:knob]", 0.65, 0, 1, 0.01);
damp = hslider("[2]Damping[style:knob]", 0.25, 0, 1, 0.01);
pos = hslider("[3]Pick position[style:knob]", 0.2, 0.02, 0.5, 0.01);
burst = no.noise * en.ar(0.0005, 0.004 + 0.012 * (1 - bright), gate) : fi.lowpass(1, 600 + 12000 * bright * gain);
picked = burst - de.fdelay(4096, pos * ma.SR / freq, burst);
fb = ba.if(gate > 0, 0.9985 - damp * 0.02, 0.9);
loop(x) = 0.5 * (x + x');
string = + ~ (de.fdelay(4096, max(1, ma.SR / freq - 1.5)) : loop : *(fb));
process = picked * gain : string : fi.dcblocker : *(1.5) <: _, _;
`,
  },
  'modal-bell': {
    name: 'Modal Bell',
    description: 'Five inharmonic resonant modes struck by a mallet — bells, glass, gamelan-ish metal.',
    code: `${HEAD}declare name "Modal Bell";
declare license "MIT";
${VOICE}decay = hslider("[1]Decay[style:knob][unit:s]", 3, 0.1, 12, 0.01);
hard = hslider("[2]Hardness[style:knob]", 0.5, 0, 1, 0.01);
inharm = hslider("[3]Inharmonicity[style:knob]", 1, 0, 1.5, 0.01);
ratios = (1, 2.76, 5.40, 8.93, 13.34);
amps = (1, 0.6, 0.4, 0.25, 0.15);
ratio(i) = 1 + (ba.take(i + 1, ratios) - 1) * inharm;
mallet = no.noise * en.ar(0.0002, 0.0015 + 0.004 * (1 - hard), gate) : fi.lowpass(2, 800 + 14000 * hard);
fc(i) = min(19000, freq * ratio(i));
mode(i) = fi.resonbp(fc(i), max(2, ma.PI * fc(i) * decay / (1 + i * 0.7)), ba.take(i + 1, amps));
process = mallet * gain * 0.8 <: par(i, 5, mode(i)) :> *(0.5) : *(en.asr(0.0005, 1, decay * 0.5, gate) * 0.5 + 0.5 * en.asr(0.0005, 1, 0.15, gate)) <: _, _;
`,
  },
  flute: {
    name: 'Physical Flute',
    description: 'Waveguide flute from the Faust physical-modeling library (pm.fluteModel) with breath noise and vibrato.',
    code: `${HEAD}declare name "PM Flute";
declare license "MIT (Faust pm.lib: STK-4.3)";
${VOICE}breath = hslider("[1]Breath[style:knob]", 0.75, 0, 1, 0.01);
noise = hslider("[2]Breath noise[style:knob]", 0.08, 0, 0.5, 0.01);
vib = hslider("[3]Vibrato[style:knob]", 0.25, 0, 1, 0.01);
mouth = hslider("[4]Embouchure[style:knob]", 0.5, 0.2, 0.8, 0.01);
env = en.adsr(0.06, 0.1, 0.9, 0.12, gate);
pressure = env * (0.55 + 0.45 * breath) * (1 + no.noise * noise) * (1 + os.osc(5) * 0.04 * vib * en.adsr(0.5, 0.1, 1, 0.1, gate));
process = pm.fluteModel(pm.f2l(freq), mouth, pressure) : fi.dcblocker : *(gain * 0.6) <: _, _;
`,
  },
  clarinet: {
    name: 'Physical Clarinet',
    description: 'Reed + bore waveguide clarinet (pm.clarinetModel) — woody, breathy and expressive.',
    code: `${HEAD}declare name "PM Clarinet";
declare license "MIT (Faust pm.lib: STK-4.3)";
${VOICE}stiff = hslider("[1]Reed stiffness[style:knob]", 0.5, 0, 1, 0.01);
bell = hslider("[2]Bell opening[style:knob]", 0.5, 0, 1, 0.01);
breath = hslider("[3]Breath[style:knob]", 0.8, 0, 1, 0.01);
vib = hslider("[4]Vibrato[style:knob]", 0.15, 0, 1, 0.01);
env = en.adsr(0.03, 0.1, 0.92, 0.08, gate);
pressure = env * (0.6 + 0.4 * breath) * (1 + no.noise * 0.02) * (1 + os.osc(5.2) * 0.03 * vib);
process = pm.clarinetModel(pm.f2l(freq), pressure, stiff, bell) : fi.dcblocker : *(gain * 0.5) <: _, _;
`,
  },
  organ: {
    name: 'Tonewheel Organ',
    description: 'Additive drawbar organ (16′ 8′ 5⅓′ 4′ 2⅔′ 2′) with key click, percussion and a stereo vibrato/chorus.',
    code: `${HEAD}declare name "Tonewheel Organ";
declare license "MIT";
${VOICE}db1 = hslider("[1]16'[style:knob]", 0.8, 0, 1, 0.01);
db2 = hslider("[2]8'[style:knob]", 1, 0, 1, 0.01);
db3 = hslider("[3]5 1/3'[style:knob]", 0.6, 0, 1, 0.01);
db4 = hslider("[4]4'[style:knob]", 0.3, 0, 1, 0.01);
db5 = hslider("[5]2 2/3'[style:knob]", 0.2, 0, 1, 0.01);
db6 = hslider("[6]2'[style:knob]", 0.2, 0, 1, 0.01);
perc = hslider("[7]Percussion[style:knob]", 0.4, 0, 1, 0.01);
click = hslider("[8]Click[style:knob]", 0.3, 0, 1, 0.01);
tone = db1 * os.osc(freq * 0.5) + db2 * os.osc(freq) + db3 * os.osc(freq * 1.5) + db4 * os.osc(freq * 2) + db5 * os.osc(freq * 3) + db6 * os.osc(freq * 4);
percs = perc * os.osc(freq * 3) * en.ar(0.001, 0.25, gate);
clk = click * no.noise * en.ar(0.0003, 0.004, gate) : fi.bandpass(1, 1000, 6000);
env = en.asr(0.004, 1, 0.03, gate);
process = (tone * 0.16 + percs * 0.3) * env * (0.5 + 0.5 * gain) + clk * 0.2 <: _, _;
vibd = hslider("[9]Chorus[style:knob]", 0.5, 0, 1, 0.01);
cho(ph) = de.fdelay(1024, 48 * (1 + 0.7 * vibd * os.oscp(6.7, ph)));
effect = _, _ : (_ <: _ * 0.6, cho(0) * 0.6 :> _), (_ <: _ * 0.6, cho(1.5) * 0.6 :> _);
`,
  },
  'warm-pad': {
    name: 'Warm Pad',
    description: 'Slow PWM + saw pad with a drifting low-pass and a built-in stereo chorus (effect section).',
    code: `${HEAD}declare name "Warm Pad";
declare license "MIT";
${VOICE}cutoff = hslider("[1]Cutoff[style:knob][unit:Hz][scale:log]", 1400, 100, 12000, 1);
pwm = hslider("[2]PWM depth[style:knob]", 0.35, 0, 0.45, 0.01);
a = hslider("[3]Attack[style:knob][unit:s]", 0.8, 0.01, 6, 0.01);
r = hslider("[4]Release[style:knob][unit:s]", 1.6, 0.05, 8, 0.01);
osc = os.pulsetrain(freq * 1.003, 0.5 + pwm * os.osc(0.37)) * 0.5 + os.sawtooth(freq * 0.997) * 0.5;
process = osc : fi.lowpass(2, cutoff * (1 + 0.2 * os.osc(0.13))) : *(en.asr(a, 1, r, gate) * gain * 0.35) <: _, _;
width = hslider("[5]Chorus width[style:knob]", 0.6, 0, 1, 0.01);
ch(ph) = de.fdelay(2048, ma.SR * (0.012 + 0.004 * width * os.oscp(0.8, ph)));
effect = (_ <: _, ch(0) :> *(0.7)), (_ <: _, ch(2) :> *(0.7));
`,
  },
};

export const FAUST_EFFECTS = {
  'zita-reverb': {
    name: 'Zita Reverb',
    description: 'Fons Adriaensen’s zita-rev1 feedback-delay-network reverb (re.zita_rev1_stereo) — lush, natural tails.',
    code: `${HEAD}declare name "Zita Reverb";
declare license "MIT (zita-rev1 algorithm: Fons Adriaensen, Faust port: Julius O. Smith)";
pre = hslider("[1]Pre-delay[style:knob][unit:ms]", 30, 1, 120, 1);
lowT = hslider("[2]Low RT60[style:knob][unit:s]", 3, 0.5, 12, 0.1);
midT = hslider("[3]Mid RT60[style:knob][unit:s]", 2.4, 0.3, 12, 0.1);
damp = hslider("[4]HF damping[style:knob][unit:Hz][scale:log]", 6000, 1500, 20000, 1);
wet = hslider("[5]Mix[style:knob]", 0.3, 0, 1, 0.01);
rev = re.zita_rev1_stereo(pre, 200, damp, lowT, midT, 48000);
process = _, _ <: (*(1 - wet), *(1 - wet)), (rev : *(wet), *(wet)) :> _, _;
`,
  },
  'moog-ladder': {
    name: 'Moog Ladder Filter',
    description: 'Four-pole Moog ladder low-pass (ve.moog_vcf_2b) with drive and an LFO for sweeps.',
    code: `${HEAD}declare name "Moog Ladder";
declare license "MIT";
cutoff = hslider("[1]Cutoff[style:knob][unit:Hz][scale:log]", 1200, 40, 18000, 1);
res = hslider("[2]Resonance[style:knob]", 0.5, 0, 0.98, 0.01);
drive = hslider("[3]Drive[style:knob]", 1, 1, 8, 0.01);
rate = hslider("[4]LFO rate[style:knob][unit:Hz]", 0.5, 0.01, 10, 0.01);
depth = hslider("[5]LFO depth[style:knob]", 0, 0, 1, 0.01);
fc = min(19000, cutoff * pow(2, 3 * depth * os.osc(rate)));
chan = *(drive) : ma.tanh : ve.moog_vcf_2b(res, fc) : *(1 / sqrt(drive));
process = chan, chan;
`,
  },
  phaser: {
    name: 'Stereo Phaser',
    description: 'Classic notch-sweeping phaser (pf.phaser2_stereo) with feedback.',
    code: `${HEAD}declare name "Phaser";
declare license "MIT";
rate = hslider("[1]Rate[style:knob][unit:Hz]", 0.4, 0.01, 8, 0.01);
depth = hslider("[2]Depth[style:knob]", 1, 0, 1, 0.01);
fb = hslider("[3]Feedback[style:knob]", 0.5, -0.95, 0.95, 0.01);
width = hslider("[4]Notch width[style:knob][unit:Hz]", 1000, 50, 4000, 1);
process = pf.phaser2_stereo(4, width, 200, 1.5, 6000, rate, depth, fb, 0);
`,
  },
  compressor: {
    name: 'Faust Compressor',
    description: 'Feed-forward RMS-ish stereo compressor (co.compressor_stereo) with make-up gain.',
    code: `${HEAD}declare name "Compressor";
declare license "MIT";
thresh = hslider("[1]Threshold[style:knob][unit:dB]", -18, -60, 0, 0.1);
ratio = hslider("[2]Ratio[style:knob]", 4, 1, 20, 0.1);
att = hslider("[3]Attack[style:knob][unit:ms]", 10, 0.1, 200, 0.1) * 0.001;
rel = hslider("[4]Release[style:knob][unit:ms]", 120, 5, 1000, 1) * 0.001;
makeup = hslider("[5]Make-up[style:knob][unit:dB]", 4, 0, 24, 0.1) : ba.db2linear;
process = co.compressor_stereo(ratio, thresh, att, rel) : *(makeup), *(makeup);
`,
  },
  freeverb: {
    name: 'Freeverb',
    description: 'Jezar’s Freeverb (re.stereo_freeverb): eight comb + four all-pass filters per side.',
    code: `${HEAD}declare name "Freeverb";
declare license "MIT (Freeverb: Jezar at Dreampoint, public domain)";
size = hslider("[1]Room size[style:knob]", 0.7, 0, 1, 0.01);
damp = hslider("[2]Damping[style:knob]", 0.4, 0, 1, 0.01);
wet = hslider("[3]Mix[style:knob]", 0.3, 0, 1, 0.01);
fb1 = 0.7 + size * 0.28;
fb2 = 0.5;
rev = re.stereo_freeverb(fb1, fb2, damp, 23);
process = _, _ <: (*(1 - wet), *(1 - wet)), (rev : *(wet * 0.6), *(wet * 0.6)) :> _, _;
`,
  },
  'tape-echo': {
    name: 'Tape Echo',
    description: 'Space-echo style delay: saturating feedback loop, darkening repeats and wow & flutter.',
    code: `${HEAD}declare name "Tape Echo";
declare license "MIT";
time = hslider("[1]Time[style:knob][unit:ms]", 375, 20, 1500, 1) : si.smooth(0.9995);
fb = hslider("[2]Feedback[style:knob]", 0.45, 0, 1.05, 0.01);
tone = hslider("[3]Tone[style:knob][unit:Hz][scale:log]", 3500, 500, 12000, 1);
wow = hslider("[4]Wow & flutter[style:knob]", 0.3, 0, 1, 0.01);
wet = hslider("[5]Mix[style:knob]", 0.35, 0, 1, 0.01);
mod = wow * (0.0018 * os.osc(0.6) + 0.0004 * os.osc(7.3));
dly = de.fdelay(ma.SR * 2, ma.SR * (time * 0.001 + mod + 0.003));
loop = (+ : dly) ~ (*(fb) : fi.lowpass(2, tone) : fi.highpass(1, 80) : ma.tanh);
echo = loop;
process = _, _ <: (*(1 - wet * 0.5), *(1 - wet * 0.5)), (echo, echo : *(wet), *(wet)) :> _, _;
`,
  },
};

/** Default Faust source for the editor tab (a tiny, well-commented poly synth). */
export const FAUST_TEMPLATE = `import("stdfaust.lib");
declare name "My Synth";
// Polyphonic instrument: the host sets freq / gain / gate for every voice.
freq = hslider("freq", 440, 20, 20000, 0.01);
gain = hslider("gain", 0.7, 0, 1, 0.01);
gate = button("gate");
// Every other slider becomes a knob in the device panel.
cutoff = hslider("[1]Cutoff[style:knob][unit:Hz][scale:log]", 2500, 80, 16000, 1);
release = hslider("[2]Release[style:knob][unit:s]", 0.3, 0.01, 4, 0.01);
osc = os.sawtooth(freq) + os.square(freq * 1.005) * 0.5;
env = en.adsr(0.005, 0.2, 0.7, release, gate);
process = osc * 0.3 : fi.resonlp(cutoff, 2, 1) : *(env * gain) <: _, _;
`;
