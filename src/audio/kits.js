// Drum kits: per-pad synthesis recipes consumed by drums.js (pure data, Node-safe).
// Voice recipe = { tones:[{wave,freq,pitchStart,pitchDecay,pitchEnd,decay,level,attack}],
//   noise:{color,filter:'hp'|'bp'|'lp',freq,q,hp,decay,level,attack,bursts,gap},
//   metal:{freqs,scale,wave,bp,q,hp,decay,level}, click:{level,freq,decay},
//   drive, crush (bits), lp, hp, gain, pan, choke }
// Kit = { name, description, fx?:{lp, crush, drive} (applied to every pad), voices:{padKey: recipe} }

const t = (freq, decay, o = {}) => ({ wave: 'sine', freq, decay, level: 0.9, ...o });

function kick(o = {}) {
  const v = {
    tones: [t(o.freq ?? 50, o.decay ?? 0.45, { wave: o.wave || 'sine', pitchStart: o.sweep ?? 3.5, pitchDecay: o.sweepTime ?? 0.035, level: o.level ?? 1, pitchEnd: o.pitchEnd })],
    drive: o.drive ?? 0, gain: o.gain ?? 1,
  };
  if (o.sub) v.tones.push(t((o.freq ?? 50) * 0.98, (o.decay ?? 0.45) * 1.25, { level: o.sub, pitchStart: 1.25, pitchDecay: 0.05, attack: 0.004 }));
  if (o.click !== 0) v.click = { level: o.click ?? 0.25, freq: o.clickFreq ?? 3500, decay: o.clickDecay ?? 0.006 };
  if (o.noise) v.noise = { color: 'pink', filter: 'lp', freq: o.noiseFreq ?? 1800, decay: o.noiseDecay ?? 0.04, level: o.noise };
  if (o.lp) v.lp = o.lp;
  if (o.crush) v.crush = o.crush;
  return v;
}
function snare(o = {}) {
  const tones = (o.tones ?? [185, 330]).map((f, i) => t(f, (o.toneDecay ?? 0.12) * (i ? 0.7 : 1), {
    wave: o.wave || (i ? 'triangle' : 'sine'), level: (o.toneLevel ?? 0.55) * (i ? 0.6 : 1), pitchStart: o.sweep ?? 1.4, pitchDecay: 0.02,
  }));
  const v = {
    tones,
    noise: { color: o.color || 'white', filter: o.noiseFilter || 'hp', freq: o.noiseFreq ?? 2500, q: o.q ?? 0.7, hp: o.noiseHp, decay: o.noiseDecay ?? 0.18, level: o.noiseLevel ?? 0.7, attack: o.attack ?? 0.0008 },
    drive: o.drive ?? 0, gain: o.gain ?? 1,
  };
  if (o.lp) v.lp = o.lp;
  if (o.crush) v.crush = o.crush;
  if (o.click) v.click = { level: o.click, freq: 4000, decay: 0.004 };
  if (o.metal) v.metal = { ...o.metal };
  return v;
}
function clap(o = {}) {
  return {
    noise: { color: 'white', filter: 'bp', freq: o.freq ?? 1200, q: o.q ?? 1.3, decay: o.tail ?? 0.22, level: o.level ?? 1.5, bursts: o.bursts ?? 4, gap: o.gap ?? 0.0105 },
    drive: o.drive ?? 0, gain: o.gain ?? 1, lp: o.lp, crush: o.crush,
  };
}
function rim(o = {}) {
  return {
    tones: [t(o.freq ?? 1700, o.decay ?? 0.025, { wave: 'triangle', level: 0.7 }), t((o.freq ?? 1700) * 0.29, (o.decay ?? 0.025) * 1.4, { level: 0.5 })],
    noise: { filter: 'hp', freq: 3000, decay: 0.01, level: o.noise ?? 0.25 },
    hp: o.hp ?? 200, gain: o.gain ?? 1, drive: o.drive ?? 0,
  };
}
function hat(o = {}) {
  const open = !!o.open;
  const decay = o.decay ?? (open ? 0.42 : 0.055);
  const v = { gain: o.gain ?? 1, choke: 'hat', lp: o.lp, crush: o.crush, drive: o.drive ?? 0 };
  if ((o.metal ?? 0.7) > 0) v.metal = { scale: o.scale ?? 1, bp: o.bp ?? 10000, q: o.q ?? 1.2, hp: o.hp ?? 7000, decay, level: o.metal ?? 0.7, freqs: o.freqs };
  if ((o.noise ?? 0.25) > 0) v.noise = { color: 'white', filter: 'hp', freq: o.noiseFreq ?? 8000, decay: decay * (o.noiseDecayMul ?? 0.9), level: o.noise ?? 0.25 };
  return v;
}
function tom(freq, o = {}) {
  const v = {
    tones: [t(freq, o.decay ?? 0.38, { pitchStart: o.sweep ?? 1.5, pitchDecay: o.sweepTime ?? 0.06, level: 0.95, pitchEnd: o.pitchEnd, wave: o.wave || 'sine' })],
    gain: o.gain ?? 1, drive: o.drive ?? 0, lp: o.lp, crush: o.crush,
  };
  if (o.noise) v.noise = { color: 'pink', filter: 'bp', freq: freq * 4, q: 0.8, decay: 0.08, level: o.noise };
  if (o.click) v.click = { level: o.click, freq: 2500, decay: 0.005 };
  return v;
}
function cymbal(o = {}) {
  const v = {
    metal: { scale: o.scale ?? 1.2, bp: o.bp ?? 8000, q: 0.6, hp: o.hp ?? 4000, decay: o.decay ?? 1.6, level: o.metal ?? 0.55, freqs: o.freqs },
    noise: { color: 'white', filter: 'hp', freq: o.noiseFreq ?? 6000, decay: (o.decay ?? 1.6) * (o.noiseDecayMul ?? 0.8), level: o.noise ?? 0.4, attack: o.attack ?? 0.001 },
    gain: o.gain ?? 0.85, lp: o.lp, crush: o.crush, drive: o.drive ?? 0,
  };
  if (o.bell) v.tones = [t(o.bellFreq ?? 2400, o.bellDecay ?? 0.6, { wave: 'sine', level: o.bell }), t((o.bellFreq ?? 2400) * 1.48, (o.bellDecay ?? 0.6) * 0.7, { level: o.bell * 0.5 })];
  return v;
}
function cowbell(o = {}) {
  return {
    metal: { freqs: o.freqs ?? [540, 800], scale: o.scale ?? 1, wave: 'square', bp: o.bp ?? 900, q: o.q ?? 1.4, decay: o.decay ?? 0.32, level: o.level ?? 1.1 },
    tones: o.body ? [t(800 * (o.scale ?? 1), 0.04, { level: o.body })] : undefined,
    gain: o.gain ?? 1, drive: o.drive ?? 0, lp: o.lp, crush: o.crush,
  };
}
function tambourine(o = {}) {
  return {
    metal: { freqs: [4100, 5600, 7300, 9100, 11200], wave: 'square', bp: 9000, q: 0.8, hp: 5000, decay: o.decay ?? 0.18, level: 0.4 },
    noise: { filter: 'hp', freq: 7000, decay: o.decay ?? 0.18, level: 0.55, attack: 0.002, bursts: 2, gap: 0.012 },
    gain: o.gain ?? 0.9, lp: o.lp, crush: o.crush,
  };
}
function shaker(o = {}) {
  return {
    noise: { color: 'white', filter: 'bp', freq: o.freq ?? 6500, q: 1.1, decay: o.decay ?? 0.08, level: o.level ?? 0.9, attack: o.attack ?? 0.018 },
    gain: o.gain ?? 0.9, lp: o.lp, crush: o.crush,
  };
}
function conga(freq = 220, o = {}) {
  return {
    tones: [t(freq, o.decay ?? 0.22, { pitchStart: o.sweep ?? 1.25, pitchDecay: 0.025, pitchEnd: o.pitchEnd, wave: o.wave || 'sine' })],
    click: { level: o.click ?? 0.35, freq: 2200, decay: 0.004 },
    gain: o.gain ?? 1, lp: o.lp, crush: o.crush,
  };
}
function clave(o = {}) {
  return {
    tones: [t(o.freq ?? 2500, o.decay ?? 0.045, { wave: o.wave || 'triangle', level: 0.8 })],
    gain: o.gain ?? 0.85, lp: o.lp, crush: o.crush,
  };
}

/** Assemble a kit from a base kit + per-pad overrides. */
function kit(name, description, voices, fx) {
  return { name, description, ...(fx ? { fx } : {}), voices };
}

const V808 = {
  kick: kick({ freq: 47, sweep: 2.6, sweepTime: 0.06, decay: 1.15, click: 0.08, drive: 0.08 }),
  snare: snare({ tones: [238, 476], toneDecay: 0.11, toneLevel: 0.6, noiseFreq: 1800, noiseDecay: 0.17, noiseLevel: 0.6 }),
  clap: clap({ freq: 1100, tail: 0.24 }),
  rim: rim({ freq: 1720, decay: 0.022 }),
  hihat: hat({ decay: 0.05, metal: 0.75, noise: 0.15 }),
  openhat: hat({ open: true, decay: 0.45, metal: 0.75, noise: 0.15 }),
  tomlow: tom(92, { decay: 0.55, sweep: 1.35 }),
  tommid: tom(132, { decay: 0.45, sweep: 1.35 }),
  tomhigh: tom(190, { decay: 0.38, sweep: 1.35 }),
  crash: cymbal({ decay: 1.6, scale: 1.25 }),
  ride: cymbal({ decay: 2.0, scale: 1.55, noise: 0.15, metal: 0.5, bp: 7000, bell: 0.15 }),
  cowbell: cowbell({ decay: 0.35 }),
  tambourine: tambourine(),
  shaker: shaker(),
  conga: conga(330, { decay: 0.25, click: 0.15 }),
  clave: clave({ freq: 2450, decay: 0.035 }),
};

const V909 = {
  ...V808,
  kick: kick({ freq: 54, sweep: 6, sweepTime: 0.022, decay: 0.5, click: 0.45, clickFreq: 4000, drive: 0.18, noise: 0.12 }),
  snare: snare({ tones: [195, 345], toneDecay: 0.1, toneLevel: 0.5, sweep: 1.6, noiseFreq: 3200, noiseDecay: 0.24, noiseLevel: 0.85, noiseFilter: 'hp' }),
  clap: clap({ freq: 1300, tail: 0.28, bursts: 4, gap: 0.009, q: 1.0 }),
  rim: rim({ freq: 1900, decay: 0.02, noise: 0.35 }),
  hihat: hat({ decay: 0.06, metal: 0.35, noise: 0.6, noiseFreq: 9000, scale: 1.4 }),
  openhat: hat({ open: true, decay: 0.38, metal: 0.35, noise: 0.6, noiseFreq: 9000, scale: 1.4 }),
  tomlow: tom(98, { decay: 0.32, sweep: 1.9, noise: 0.18 }),
  tommid: tom(140, { decay: 0.28, sweep: 1.9, noise: 0.18 }),
  tomhigh: tom(196, { decay: 0.24, sweep: 1.9, noise: 0.18 }),
  crash: cymbal({ decay: 1.4, scale: 1.4, noise: 0.6, metal: 0.4 }),
  ride: cymbal({ decay: 1.8, scale: 1.8, noise: 0.25, metal: 0.55, bp: 9000, bell: 0.2, bellFreq: 2900 }),
};

const VACOUSTIC = {
  kick: kick({ freq: 62, sweep: 2, sweepTime: 0.02, decay: 0.3, click: 0.6, clickFreq: 2500, noise: 0.35, noiseFreq: 1200, sub: 0.3 }),
  snare: snare({ tones: [200, 285], toneDecay: 0.09, toneLevel: 0.45, sweep: 1.2, color: 'white', noiseFilter: 'bp', noiseFreq: 3500, q: 0.5, noiseDecay: 0.26, noiseLevel: 1.0, click: 0.3 }),
  clap: clap({ freq: 1400, tail: 0.3, bursts: 5, gap: 0.012, q: 0.8 }),
  rim: rim({ freq: 1400, decay: 0.035, noise: 0.45 }),
  hihat: hat({ decay: 0.07, metal: 0.35, noise: 0.55, noiseFreq: 7000, freqs: [333, 465, 571, 683, 811, 1007], scale: 6 }),
  openhat: hat({ open: true, decay: 0.6, metal: 0.35, noise: 0.5, noiseFreq: 6500, freqs: [333, 465, 571, 683, 811, 1007], scale: 6 }),
  tomlow: tom(100, { decay: 0.5, sweep: 1.25, noise: 0.25, click: 0.3 }),
  tommid: tom(145, { decay: 0.42, sweep: 1.25, noise: 0.25, click: 0.3 }),
  tomhigh: tom(200, { decay: 0.36, sweep: 1.25, noise: 0.25, click: 0.3 }),
  crash: cymbal({ decay: 2.2, scale: 2.2, noise: 0.75, metal: 0.35, hp: 3000, freqs: [333, 465, 571, 683, 811, 1007] }),
  ride: cymbal({ decay: 2.6, scale: 3.5, noise: 0.2, metal: 0.5, bp: 5500, bell: 0.3, bellFreq: 2200, freqs: [333, 465, 571, 683, 811, 1007] }),
  cowbell: cowbell({ freqs: [587, 845], decay: 0.25, bp: 1100 }),
  tambourine: tambourine({ decay: 0.22 }),
  shaker: shaker({ decay: 0.1 }),
  conga: conga(210, { decay: 0.3, click: 0.4 }),
  clave: clave({ freq: 2200, decay: 0.06, wave: 'sine' }),
};

export const DRUM_KITS = {
  '808': kit('TR-808', 'Classic analog boom: long sine kick, metallic hats, snappy clap', V808),
  '909': kit('TR-909', 'Punchy clicky kick, noisy hats and crisp snare — house & techno staple', V909),
  trap: kit('Trap', 'Sub-heavy distorted 808 kick, tight crisp hats for rolls, sharp snare/clap', {
    ...V808,
    kick: kick({ freq: 44, sweep: 3.2, sweepTime: 0.04, decay: 1.7, click: 0.2, drive: 0.3 }),
    snare: snare({ tones: [220, 410], toneDecay: 0.08, toneLevel: 0.45, noiseFreq: 4000, noiseDecay: 0.16, noiseLevel: 0.9, click: 0.2, gain: 0.85 }),
    clap: clap({ freq: 1500, tail: 0.2, bursts: 3, gap: 0.008, level: 1.2 }),
    hihat: hat({ decay: 0.035, metal: 0.6, noise: 0.35, bp: 11000, hp: 8500 }),
    openhat: hat({ open: true, decay: 0.3, metal: 0.6, noise: 0.35, bp: 11000, hp: 8500 }),
    rim: rim({ freq: 2000, decay: 0.018 }),
  }),
  lofi: kit('Lo-Fi', 'Dusty, dull and bit-crushed — boom bap through a cassette', {
    ...VACOUSTIC,
    kick: kick({ freq: 56, sweep: 2.2, sweepTime: 0.03, decay: 0.38, click: 0.15, noise: 0.25 }),
    snare: snare({ tones: [190, 260], toneDecay: 0.1, toneLevel: 0.6, noiseFilter: 'bp', noiseFreq: 2200, q: 0.6, noiseDecay: 0.2, noiseLevel: 0.75, color: 'pink' }),
    hihat: hat({ decay: 0.05, metal: 0.2, noise: 0.6, noiseFreq: 6000 }),
    openhat: hat({ open: true, decay: 0.3, metal: 0.2, noise: 0.6, noiseFreq: 6000 }),
    rim: rim({ freq: 1300, decay: 0.03 }),
  }, { lp: 4200, crush: 9 }),
  acoustic: kit('Acoustic', 'Natural studio kit: beater thump, rattly snare, washy cymbals', VACOUSTIC),
  rock: kit('Rock', 'Big, loud and slightly driven arena kit', {
    ...VACOUSTIC,
    kick: kick({ freq: 58, sweep: 2.4, sweepTime: 0.025, decay: 0.4, click: 0.8, clickFreq: 3000, noise: 0.35, sub: 0.4, drive: 0.15 }),
    snare: snare({ tones: [190, 300], toneDecay: 0.14, toneLevel: 0.6, noiseFilter: 'bp', noiseFreq: 3000, q: 0.45, noiseDecay: 0.34, noiseLevel: 1.1, click: 0.35, drive: 0.2 }),
    tomlow: tom(85, { decay: 0.65, sweep: 1.3, noise: 0.3, click: 0.35 }),
    tommid: tom(120, { decay: 0.55, sweep: 1.3, noise: 0.3, click: 0.35 }),
    tomhigh: tom(165, { decay: 0.45, sweep: 1.3, noise: 0.3, click: 0.35 }),
    crash: cymbal({ decay: 2.8, scale: 2, noise: 0.85, metal: 0.4, hp: 2500, freqs: [333, 465, 571, 683, 811, 1007] }),
  }, { drive: 0.12 }),
  techno: kit('Techno', 'Driven rumble kick, tight metallic hats, industrial-leaning rim and clap', {
    ...V909,
    kick: kick({ freq: 50, sweep: 5, sweepTime: 0.025, decay: 0.55, click: 0.35, drive: 0.4, noise: 0.1 }),
    hihat: hat({ decay: 0.04, metal: 0.7, noise: 0.3, scale: 1.6, bp: 12000, hp: 9000 }),
    openhat: hat({ open: true, decay: 0.25, metal: 0.7, noise: 0.3, scale: 1.6, bp: 12000, hp: 9000 }),
    rim: rim({ freq: 1600, decay: 0.03, noise: 0.4, drive: 0.4 }),
    clap: clap({ freq: 1000, tail: 0.32, bursts: 4, gap: 0.011, drive: 0.25 }),
  }),
  house: kit('House', 'Round 909-style kick, sizzly open hats, roomy clap', {
    ...V909,
    kick: kick({ freq: 52, sweep: 4, sweepTime: 0.03, decay: 0.42, click: 0.3, drive: 0.1, sub: 0.2 }),
    openhat: hat({ open: true, decay: 0.32, metal: 0.4, noise: 0.65, noiseFreq: 8500, scale: 1.5 }),
    clap: clap({ freq: 1150, tail: 0.38, bursts: 4, gap: 0.012, q: 0.9 }),
    shaker: shaker({ decay: 0.07, freq: 7500 }),
  }),
  breaks: kit('Breaks', 'Crunchy sampled-break flavour: punchy, gritty, slightly crushed', {
    ...VACOUSTIC,
    kick: kick({ freq: 60, sweep: 2.6, sweepTime: 0.025, decay: 0.32, click: 0.7, noise: 0.3, drive: 0.3 }),
    snare: snare({ tones: [210, 320], toneDecay: 0.1, toneLevel: 0.55, noiseFilter: 'bp', noiseFreq: 3800, q: 0.55, noiseDecay: 0.22, noiseLevel: 1.1, click: 0.4, drive: 0.35 }),
  }, { crush: 11, lp: 9000 }),
  dnb: kit('Drum & Bass', 'Tight punchy kick, cracking high-tuned snare, crisp fast hats', {
    ...VACOUSTIC,
    kick: kick({ freq: 56, sweep: 3.2, sweepTime: 0.02, decay: 0.28, click: 0.6, clickFreq: 4500, noise: 0.15, drive: 0.15 }),
    snare: snare({ tones: [245, 430], toneDecay: 0.08, toneLevel: 0.55, sweep: 1.5, noiseFilter: 'hp', noiseFreq: 3500, noiseDecay: 0.2, noiseLevel: 1.0, click: 0.5, drive: 0.2 }),
    hihat: hat({ decay: 0.04, metal: 0.4, noise: 0.55, noiseFreq: 9500, scale: 1.5 }),
    openhat: hat({ open: true, decay: 0.28, metal: 0.4, noise: 0.55, noiseFreq: 9500, scale: 1.5 }),
  }),
  jazz: kit('Jazz', 'Soft feathered kick, brushy snare, singing ride and light hats', {
    ...VACOUSTIC,
    kick: kick({ freq: 66, sweep: 1.5, sweepTime: 0.02, decay: 0.35, click: 0.15, noise: 0.15, level: 0.75 }),
    snare: snare({ tones: [210, 300], toneDecay: 0.08, toneLevel: 0.25, noiseFilter: 'bp', noiseFreq: 4000, q: 0.4, noiseDecay: 0.3, noiseLevel: 0.6, attack: 0.012, color: 'pink' }),
    hihat: hat({ decay: 0.05, metal: 0.3, noise: 0.35, noiseFreq: 6000, freqs: [333, 465, 571, 683, 811, 1007], scale: 6, gain: 0.7 }),
    ride: cymbal({ decay: 3.2, scale: 3.2, noise: 0.15, metal: 0.55, bp: 5000, bell: 0.35, bellFreq: 2600, bellDecay: 1.0, freqs: [333, 465, 571, 683, 811, 1007] }),
    tomlow: tom(110, { decay: 0.5, sweep: 1.15, noise: 0.15 }),
    tommid: tom(160, { decay: 0.42, sweep: 1.15, noise: 0.15 }),
    tomhigh: tom(220, { decay: 0.36, sweep: 1.15, noise: 0.15 }),
  }),
  latin: kit('Latin Percussion', 'Congas, timbales, cowbell, clave and shaker up front', {
    ...VACOUSTIC,
    kick: kick({ freq: 60, sweep: 1.8, sweepTime: 0.02, decay: 0.3, click: 0.3, level: 0.8 }),
    tomlow: conga(180, { decay: 0.35, click: 0.4 }),
    tommid: conga(240, { decay: 0.3, click: 0.45 }),
    tomhigh: tom(420, { decay: 0.3, sweep: 1.1, noise: 0.4, click: 0.5 }), // timbale
    conga: conga(300, { decay: 0.25, click: 0.5, sweep: 1.15 }),
    cowbell: cowbell({ freqs: [640, 910], decay: 0.4, bp: 1200, q: 1.0 }),
    clave: clave({ freq: 2650, decay: 0.07, wave: 'sine' }),
    shaker: shaker({ decay: 0.09, freq: 5500 }),
    snare: snare({ tones: [330, 520], toneDecay: 0.18, toneLevel: 0.6, sweep: 1.05, noiseFreq: 4000, noiseDecay: 0.15, noiseLevel: 0.6 }),
  }),
  afro: kit('Afro', 'Talking drums, deep djembe-ish kick, shakers and bells', {
    ...VACOUSTIC,
    kick: kick({ freq: 68, sweep: 1.6, sweepTime: 0.03, decay: 0.38, click: 0.5, clickFreq: 1800, noise: 0.2 }),
    snare: snare({ tones: [300, 420], toneDecay: 0.12, toneLevel: 0.6, sweep: 1.1, noiseFilter: 'bp', noiseFreq: 2500, noiseDecay: 0.12, noiseLevel: 0.5, click: 0.4 }),
    tomlow: tom(120, { decay: 0.45, sweep: 0.8, sweepTime: 0.15, click: 0.4 }), // talking drum bend up
    tommid: tom(170, { decay: 0.4, sweep: 1.3, pitchEnd: 0.8, click: 0.4 }),
    tomhigh: tom(240, { decay: 0.3, sweep: 1.2, pitchEnd: 0.85, click: 0.4 }),
    conga: conga(260, { decay: 0.3, click: 0.5 }),
    cowbell: cowbell({ freqs: [720, 1010], decay: 0.5, bp: 1400, q: 2 }), // agogo-ish
    shaker: shaker({ decay: 0.12, freq: 5000, attack: 0.03 }),
  }),
  reggaeton: kit('Reggaeton', 'Dembow kit: punchy 808 kick, snappy timbale-like snare', {
    ...V808,
    kick: kick({ freq: 50, sweep: 3.5, sweepTime: 0.035, decay: 0.6, click: 0.3, drive: 0.15 }),
    snare: snare({ tones: [340, 560], toneDecay: 0.1, toneLevel: 0.65, sweep: 1.2, noiseFreq: 3000, noiseDecay: 0.14, noiseLevel: 0.75, click: 0.3 }),
    clap: clap({ freq: 1400, tail: 0.18, bursts: 3, gap: 0.009 }),
    hihat: hat({ decay: 0.04, metal: 0.5, noise: 0.45, noiseFreq: 9000 }),
  }),
  chip: kit('Chiptune', '8-bit console drums: square sweeps and crushed noise', {
    kick: kick({ wave: 'square', freq: 55, sweep: 5, sweepTime: 0.05, decay: 0.18, click: 0, level: 0.7 }),
    snare: { tones: [t(220, 0.06, { wave: 'square', level: 0.4, pitchStart: 2, pitchDecay: 0.03 })], noise: { filter: 'none', decay: 0.15, level: 0.6 }, crush: 3 },
    clap: { noise: { filter: 'bp', freq: 2500, q: 0.6, decay: 0.12, level: 0.8, bursts: 3, gap: 0.016 }, crush: 3 },
    rim: { tones: [t(1200, 0.03, { wave: 'square', level: 0.5 })] },
    hihat: { noise: { filter: 'hp', freq: 7000, decay: 0.03, level: 0.7 }, crush: 3, choke: 'hat' },
    openhat: { noise: { filter: 'hp', freq: 6000, decay: 0.22, level: 0.6 }, crush: 3, choke: 'hat' },
    tomlow: tom(110, { wave: 'triangle', decay: 0.2, sweep: 2.5, sweepTime: 0.12 }),
    tommid: tom(165, { wave: 'triangle', decay: 0.18, sweep: 2.5, sweepTime: 0.1 }),
    tomhigh: tom(240, { wave: 'triangle', decay: 0.16, sweep: 2.5, sweepTime: 0.08 }),
    crash: { noise: { filter: 'hp', freq: 3000, decay: 0.9, level: 0.6 }, crush: 3 },
    ride: { noise: { filter: 'bp', freq: 8000, q: 1, decay: 0.5, level: 0.5 }, metal: { freqs: [1800, 2650], wave: 'square', decay: 0.4, level: 0.15 }, crush: 4 },
    cowbell: { tones: [t(830, 0.12, { wave: 'square', level: 0.35 }), t(1245, 0.1, { wave: 'square', level: 0.25 })] },
    tambourine: { noise: { filter: 'hp', freq: 9000, decay: 0.12, level: 0.6, bursts: 2, gap: 0.02 }, crush: 3 },
    shaker: { noise: { filter: 'hp', freq: 8000, decay: 0.05, level: 0.5, attack: 0.012 }, crush: 3 },
    conga: tom(330, { wave: 'square', decay: 0.1, sweep: 1.3, gain: 0.6 }),
    clave: { tones: [t(2000, 0.04, { wave: 'square', level: 0.4 })] },
  }, { crush: 6 }),
  industrial: kit('Industrial', 'Distorted, metallic and abrasive — clangs and blown-out hits', {
    ...V909,
    kick: kick({ freq: 48, sweep: 5, sweepTime: 0.03, decay: 0.55, click: 0.7, noise: 0.4, drive: 0.75 }),
    snare: snare({ tones: [180, 250], toneDecay: 0.12, toneLevel: 0.5, noiseFilter: 'bp', noiseFreq: 2000, q: 0.6, noiseDecay: 0.3, noiseLevel: 1.0, drive: 0.6, metal: { freqs: [347, 523, 811, 1307], bp: 2200, q: 2, decay: 0.25, level: 0.45 } }),
    clap: clap({ freq: 900, tail: 0.35, drive: 0.7 }),
    hihat: hat({ decay: 0.06, metal: 0.9, noise: 0.2, scale: 2.3, bp: 7000, hp: 5000, drive: 0.4 }),
    openhat: hat({ open: true, decay: 0.4, metal: 0.9, noise: 0.2, scale: 2.3, bp: 7000, hp: 5000, drive: 0.4 }),
    rim: { metal: { freqs: [600, 937, 1411, 2003], bp: 2500, q: 3, decay: 0.12, level: 1 }, drive: 0.5 },
    cowbell: cowbell({ freqs: [431, 677, 1021], decay: 0.6, bp: 1500, q: 3, drive: 0.5 }),
  }, { drive: 0.25 }),
  hardstyle: kit('Hardstyle', 'Distorted tonal "pitch-tail" kick, huge claps, sharp hats', {
    ...V909,
    kick: kick({ freq: 54, sweep: 6, sweepTime: 0.03, pitchEnd: 0.8, decay: 0.55, click: 0.9, clickFreq: 2500, drive: 0.9, sub: 0.3 }),
    clap: clap({ freq: 1300, tail: 0.4, bursts: 4, gap: 0.01, level: 1.3, drive: 0.2 }),
    snare: snare({ tones: [220, 380], toneDecay: 0.12, toneLevel: 0.5, noiseFreq: 3000, noiseDecay: 0.3, noiseLevel: 1, drive: 0.3 }),
    crash: cymbal({ decay: 2.4, scale: 1.4, noise: 0.7, metal: 0.4 }),
  }),
  phonk: kit('Phonk', 'Memphis cowbell melodies, blown-out 808 kick, crunchy hats', {
    ...V808,
    kick: kick({ freq: 46, sweep: 3, sweepTime: 0.045, decay: 1.3, click: 0.3, drive: 0.6 }),
    cowbell: cowbell({ decay: 0.55, bp: 1000, q: 1.2, drive: 0.35, level: 1.2 }),
    snare: snare({ tones: [230, 440], toneDecay: 0.1, toneLevel: 0.45, noiseFreq: 2500, noiseDecay: 0.18, noiseLevel: 0.75, drive: 0.4, gain: 0.8 }),
    hihat: hat({ decay: 0.04, metal: 0.6, noise: 0.4, drive: 0.3 }),
    openhat: hat({ open: true, decay: 0.32, metal: 0.6, noise: 0.4, drive: 0.3 }),
  }, { crush: 12, lp: 11000 }),
  garage: kit('UK Garage', '2-step: short punchy kick, crisp snare & rim, shuffly shakers', {
    ...V909,
    kick: kick({ freq: 55, sweep: 4, sweepTime: 0.025, decay: 0.32, click: 0.35, drive: 0.12 }),
    snare: snare({ tones: [215, 380], toneDecay: 0.08, toneLevel: 0.45, noiseFreq: 4200, noiseDecay: 0.16, noiseLevel: 0.85, click: 0.25 }),
    rim: rim({ freq: 1850, decay: 0.03, noise: 0.35 }),
    hihat: hat({ decay: 0.035, metal: 0.4, noise: 0.5, noiseFreq: 10000, scale: 1.6 }),
    shaker: shaker({ decay: 0.06, freq: 8000, attack: 0.012 }),
  }),
  cinematic: kit('Cinematic', 'Huge boomy hits, taiko toms, long crashes and impacts', {
    ...VACOUSTIC,
    kick: kick({ freq: 42, sweep: 3, sweepTime: 0.08, decay: 1.6, click: 0.5, clickFreq: 1500, noise: 0.5, noiseDecay: 0.2, sub: 0.6, drive: 0.15 }),
    snare: snare({ tones: [160, 240], toneDecay: 0.25, toneLevel: 0.6, noiseFilter: 'bp', noiseFreq: 2200, q: 0.4, noiseDecay: 0.7, noiseLevel: 1.0, click: 0.3 }),
    clap: clap({ freq: 900, tail: 0.8, bursts: 5, gap: 0.016, q: 0.6 }),
    tomlow: tom(62, { decay: 1.2, sweep: 1.5, noise: 0.45, click: 0.5, sweepTime: 0.09 }),
    tommid: tom(88, { decay: 1.0, sweep: 1.5, noise: 0.45, click: 0.5, sweepTime: 0.08 }),
    tomhigh: tom(118, { decay: 0.85, sweep: 1.5, noise: 0.45, click: 0.5, sweepTime: 0.07 }),
    crash: cymbal({ decay: 4, scale: 1.8, noise: 0.8, metal: 0.4, hp: 2000, attack: 0.004 }),
    ride: cymbal({ decay: 3.5, scale: 3, noise: 0.3, metal: 0.5, bell: 0.4, bellFreq: 1800, bellDecay: 1.6 }),
  }),
};

export const DRUM_KIT_IDS = Object.keys(DRUM_KITS);
