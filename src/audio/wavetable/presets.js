// Wavetable synth presets (pure data). Same format as src/audio/presets.js PRESETS (merged there):
// { name, category, roles, genres, instrument: { type: 'wavetable', params } }.
const P = (name, category, roles, genres, params) => ({ name, category, roles, genres, instrument: { type: 'wavetable', params } });

// building blocks
const A = (table, pos = 0, x = {}) => ({ osc1On: true, osc1Table: table, osc1Pos: pos, ...pre('osc1', x) });
const B = (table, pos = 0, x = {}) => ({ osc2On: true, osc2Table: table, osc2Pos: pos, ...pre('osc2', x) });
function pre(p, x) { const o = {}; for (const [k, v] of Object.entries(x)) o[p + k[0].toUpperCase() + k.slice(1)] = v; return o; }
const amp = (a, d, s, r) => ({ env1Attack: a, env1Decay: d, env1Sustain: s, env1Release: r });
const env2 = (a, d, s, r) => ({ env2Attack: a, env2Decay: d, env2Sustain: s, env2Release: r });
const env3 = (a, d, s, r) => ({ env3Attack: a, env3Decay: d, env3Sustain: s, env3Release: r });
const lp = (cutoff, resonance = 0.1, fEnvAmount = 0, x = {}) => ({ filterType: 'lp', cutoff, resonance, fEnvAmount, ...x });
const lfo = (k, shape, rate, x = {}) => ({ [`lfo${k}Shape`]: shape, ...(typeof rate === 'string' ? { [`lfo${k}Sync`]: true, [`lfo${k}Div`]: rate } : { [`lfo${k}Rate`]: rate }), ...pre(`lfo${k}`, x) });
/** mod matrix: m([src, dst, amt], ...) */
const m = (...slots) => Object.assign({}, ...slots.map(([src, dst, amt], i) => ({ [`mod${i + 1}Src`]: src, [`mod${i + 1}Dst`]: dst, [`mod${i + 1}Amt`]: amt })));
const mono = (glide = 0.04, legato = true) => ({ voiceMode: legato ? 'legato' : 'mono', glide, polyphony: 1 });

const EDM = ['edm', 'trance', 'progressive-house', 'future-bass', 'dubstep'];

export const WAVETABLE_PRESETS = {
  /* ------------------------------ BASS ------------------------------ */
  'wt-sub-bass': P('WT Sub Bass', 'Bass', ['bass'], ['trap', 'dubstep', 'drum-and-bass', 'future-bass', 'drill', 'uk-garage'], {
    ...A('basic', 0.08, { rand: 0 }), filterType: 'off', ...amp(0.004, 0.5, 1, 0.12), velToAmp: 0.25, ...mono(0.03), drive: 0.12, driveType: 'tube', gain: 1.1,
  }),
  'wt-growl-bass': P('WT Growl Bass', 'Bass', ['bass'], ['dubstep', 'brostep', 'drum-and-bass', 'trap'], {
    ...A('fm-growl', 0.3, { rand: 0, warp: 'mirror', warpAmt: 0.3 }), ...B('basic', 0.67, { octave: -1, level: 0.35, rand: 0 }),
    ...lp(900, 0.45, 2.2, { filterDrive: 0.45 }), ...env2(0.002, 0.25, 0.3, 0.1), ...amp(0.003, 0.4, 1, 0.08),
    ...lfo(1, 'sine', '1/8', { retrig: true }), ...m(['lfo1', 'pos1', 0.35], ['lfo1', 'cutoff', 0.35], ['env2', 'warp1', 0.4]),
    subLevel: 0.45, ...mono(0.03), drive: 0.35, gain: 0.75,
  }),
  'wt-wobble-bass': P('WT Wobble Bass', 'Bass', ['bass'], ['dubstep', 'brostep', 'trap', 'drum-and-bass'], {
    ...A('saw-lp', 0.35, { rand: 0, unison: 2, detune: 0.12 }), ...lp(600, 0.55, 0, { filterDrive: 0.3 }),
    ...amp(0.003, 0.3, 1, 0.1), ...lfo(1, 'sine', '1/8', { retrig: true }), ...m(['lfo1', 'cutoff', 0.5], ['lfo1', 'pos1', 0.5]),
    subLevel: 0.5, ...mono(0.04), drive: 0.3, gain: 0.8,
  }),
  'wt-reese': P('WT Reese', 'Bass', ['bass'], ['drum-and-bass', 'jungle', 'dubstep', 'uk-garage', 'techno'], {
    ...A('basic', 0.67, { unison: 3, detune: 0.22, rand: 1 }), ...B('saw-lp', 0.9, { fine: 11, level: 0.6 }),
    ...lp(1100, 0.2, 0.6, { filterDrive: 0.35 }), ...env2(0.01, 0.5, 0.6, 0.3), ...amp(0.01, 0.5, 1, 0.18),
    ...lfo(1, 'triangle', 0.18), ...m(['lfo1', 'pos2', 0.2], ['lfo1', 'detune1', 0.15]), subLevel: 0.4, ...mono(0.05), gain: 0.7,
  }),
  'wt-fm-bass': P('WT FM Bass', 'Bass', ['bass'], ['techno', 'tech-house', 'house', 'electro', 'synthwave'], {
    ...A('fm-1-2', 0.2, { rand: 0 }), ...lp(3500, 0.15, 1.2), ...env2(0.001, 0.18, 0.2, 0.1), ...amp(0.002, 0.35, 0.7, 0.08),
    ...m(['env2', 'pos1', 0.45]), subLevel: 0.3, ...mono(0.02), gain: 0.85,
  }),
  'wt-pluck-bass': P('WT Pluck Bass', 'Bass', ['bass'], ['house', 'deep-house', 'tech-house', 'disco', 'nu-disco', 'funk'], {
    ...A('saw-lp', 0.15, { rand: 0 }), filterType: 'lp', cutoff: 2400, resonance: 0.15, ...env2(0.001, 0.16, 0, 0.1),
    ...amp(0.002, 0.3, 0.35, 0.08), ...m(['env2', 'pos1', 0.6], ['vel', 'pos1', 0.15]), polyphony: 4, gain: 0.95,
  }),
  'wt-talking-bass': P('WT Talking Bass', 'Bass', ['bass'], ['dubstep', 'brostep', 'future-bass', 'drum-and-bass'], {
    ...A('vowel-aeiou', 0.1, { rand: 0 }), ...B('basic', 0.67, { octave: -1, level: 0.3 }), ...lp(2600, 0.3, 0, { filterDrive: 0.5 }),
    ...amp(0.005, 0.4, 1, 0.1), ...lfo(1, 'triangle', '1/4', { retrig: true }), ...m(['lfo1', 'pos1', 0.8]), subLevel: 0.4, ...mono(0.05), drive: 0.3, gain: 0.8,
  }),
  'wt-neuro-bass': P('WT Neuro Bass', 'Bass', ['bass'], ['drum-and-bass', 'jungle', 'dubstep'], {
    ...A('fm-feedback', 0.5, { rand: 0, warp: 'sync', warpAmt: 0.15 }), ...B('spectral-comb', 0.3, { level: 0.4, octave: -1 }),
    filterType: 'comb', cutoff: 180, resonance: 0.45, keytrack: 1, ...amp(0.002, 0.5, 1, 0.08),
    ...lfo(1, 'saw', '1/16'), ...lfo(2, 'smooth', '1/8'), ...m(['lfo1', 'warp1', 0.4], ['lfo2', 'pos1', 0.4], ['lfo2', 'pos2', 0.5]),
    subLevel: 0.5, ...mono(0.03), drive: 0.4, gain: 0.6,
  }),
  'wt-808': P('WT 808', 'Bass', ['bass'], ['trap', 'drill', 'phonk', 'hiphop', 'boom-bap'], {
    ...A('basic', 0.12, { rand: 0, phase: 0 }), filterType: 'off', ...amp(0.002, 1.6, 0.35, 0.3), ...env3(0, 0.07, 0, 0.05), ...m(['env3', 'pitch', 0.6]),
    velToAmp: 0.3, ...mono(0.08), drive: 0.45, driveType: 'tube', toneCut: 7000, gain: 0.95,
  }),
  'wt-acid-bass': P('WT Acid Bass', 'Bass', ['bass'], ['acid', 'techno', 'house', 'breakbeat', 'psytrance'], {
    ...A('basic', 0.7, { rand: 0 }), filterType: 'lp', filterSlope: '24', cutoff: 320, resonance: 0.82, filterDrive: 0.5, fEnvAmount: 4.2, velToFilter: 0.7,
    ...env2(0.002, 0.2, 0, 0.1), ...amp(0.002, 0.3, 0.9, 0.06), ...mono(0.06), gain: 0.85,
  }),
  'wt-donk': P('WT Donk', 'Bass', ['bass'], ['uk-garage', 'house', 'tech-house', 'footwork'], {
    ...A('harm-peak', 0.15, { rand: 0 }), ...lp(1800, 0.3), keytrack: 0.5, ...amp(0.001, 0.22, 0, 0.08),
    ...env3(0, 0.03, 0, 0.03), ...m(['env3', 'pitch', 0.35]), polyphony: 4, gain: 1.2,
  }),
  'wt-synthwave-bass': P('WT Synthwave Bass', 'Bass', ['bass'], ['synthwave', 'chillwave', 'pop', 'electro'], {
    ...A('pwm', 0.1, { rand: 0 }), ...B('basic', 0.67, { level: 0.5, fine: -5 }), ...lp(900, 0.3, 2.5), ...env2(0.002, 0.22, 0.15, 0.12),
    ...amp(0.002, 0.25, 0.6, 0.08), polyphony: 4, gain: 0.9,
  }),
  'wt-hollow-bass': P('WT Hollow Bass', 'Bass', ['bass'], ['drum-and-bass', 'liquid-dnb', 'uk-garage', 'two-step'], {
    ...A('square-lp', 0.4, { rand: 0 }), filterType: 'bp', cutoff: 700, resonance: 0.25, keytrack: 0.5, ...amp(0.004, 0.4, 0.8, 0.12),
    subLevel: 0.6, ...mono(0.03), gain: 1,
  }),
  'wt-tearout': P('WT Tearout', 'Bass', ['bass'], ['dubstep', 'brostep'], {
    ...A('fold', 0.25, { rand: 0, warp: 'bendp', warpAmt: 0.2 }), ...B('fm-1-3', 0.6, { level: 0.5 }), ...lp(2400, 0.35, 0, { filterDrive: 0.7 }),
    ...amp(0.002, 0.4, 1, 0.08), ...lfo(1, 'square', '1/16', { retrig: true }), ...lfo(2, 'ramp', '1/4', { retrig: true }),
    ...m(['lfo2', 'pos1', 0.6], ['lfo1', 'warp1', 0.4], ['lfo2', 'cutoff', 0.3]), subLevel: 0.5, ...mono(0.02), drive: 0.5, gain: 0.55,
  }),
  'wt-moog-bass': P('WT Ladder Bass', 'Bass', ['bass'], ['funk', 'disco', 'synthwave', 'rock', 'indie'], {
    ...A('saw-lp', 1, { rand: 0 }), ...B('square-lp', 1, { octave: -1, level: 0.5 }), ...lp(700, 0.4, 2.8, { filterDrive: 0.3 }),
    ...env2(0.002, 0.3, 0.2, 0.12), ...amp(0.002, 0.3, 0.8, 0.1), ...mono(0.03), gain: 0.85,
  }),
  'wt-digital-bass': P('WT Digital Bass', 'Bass', ['bass'], ['chiptune', 'glitch', 'idm', 'electro'], {
    ...A('digital-steps', 0.4, { rand: 0, warp: 'quantize', warpAmt: 0.3 }), filterType: 'off', ...amp(0.002, 0.3, 0.7, 0.06),
    ...m(['env2', 'pos1', 0.5]), ...env2(0, 0.3, 0, 0.1), ...mono(0), gain: 0.7,
  }),

  /* ------------------------------ LEAD ------------------------------ */
  'wt-supersaw-lead': P('WT Supersaw Lead', 'Lead', ['lead'], ['trance', 'edm', 'progressive-house', 'future-bass', 'eurobeat', 'hardstyle'], {
    ...A('basic', 0.67, { unison: 9, detune: 0.35, spread: 0.9 }), ...B('saw-square', 0.5, { level: 0.35, fine: 5 }),
    ...lp(9000, 0.1), ...amp(0.01, 0.4, 0.85, 0.3), ...lfo(1, 'sine', 5.5, { fade: 0.4 }), ...m(['lfo1', 'pitch', 0.012]), gain: 0.6,
  }),
  'wt-sync-lead': P('WT Sync Lead', 'Lead', ['lead'], ['synthwave', 'electro', 'edm', 'rock', 'trance'], {
    ...A('basic', 0.67, { warp: 'sync', warpAmt: 0.3, unison: 2, detune: 0.1 }), ...lp(7000, 0.15), ...env2(0.005, 0.5, 0.2, 0.3),
    ...amp(0.005, 0.3, 0.9, 0.2), ...m(['env2', 'warp1', 0.5]), ...mono(0.05), gain: 0.65,
  }),
  'wt-pwm-lead': P('WT PWM Lead', 'Lead', ['lead'], ['synthwave', 'pop', 'chiptune', 'funk'], {
    ...A('pwm', 0.3), ...lp(5000, 0.15, 1), ...env2(0.005, 0.4, 0.4, 0.2), ...amp(0.005, 0.3, 0.85, 0.2),
    ...lfo(1, 'triangle', 0.7), ...lfo(2, 'sine', 5.2, { fade: 0.35 }), ...m(['lfo1', 'pos1', 0.3], ['lfo2', 'pitch', 0.01]), ...mono(0.06), gain: 0.7,
  }),
  'wt-vocal-lead': P('WT Vocal Lead', 'Lead', ['lead'], ['future-bass', 'pop', 'kpop', 'edm', 'chillwave'], {
    ...A('vowel-aeiou', 0.2, { unison: 3, detune: 0.12 }), ...lp(8000, 0.1), ...amp(0.02, 0.3, 0.9, 0.3),
    ...lfo(1, 'triangle', 0.35), ...lfo(2, 'sine', 5.5, { fade: 0.5 }), ...m(['lfo1', 'pos1', 0.35], ['lfo2', 'pitch', 0.012]), ...mono(0.08), gain: 0.8,
  }),
  'wt-chip-lead': P('WT Chip Lead', 'Lead', ['lead'], ['chiptune', 'eurobeat', 'idm', 'glitch'], {
    ...A('nes-pulse', 0.3, { rand: 0 }), filterType: 'off', ...amp(0.001, 0.2, 0.8, 0.05), ...lfo(1, 'triangle', 6, { fade: 0.3 }),
    ...m(['lfo1', 'pitch', 0.02]), ...mono(0.02, false), gain: 0.55,
  }),
  'wt-fm-lead': P('WT FM Lead', 'Lead', ['lead'], ['synthwave', 'pop', 'funk', 'city-pop', 'jazz'], {
    ...A('fm-1-1', 0.35), ...lp(10000), ...env2(0.002, 0.6, 0.3, 0.3), ...amp(0.003, 0.5, 0.8, 0.25),
    ...lfo(1, 'sine', 5.2, { fade: 0.5 }), ...m(['env2', 'pos1', 0.3], ['lfo1', 'pitch', 0.01]), ...mono(0.04), gain: 0.75,
  }),
  'wt-formant-lead': P('WT Formant Lead', 'Lead', ['lead'], ['edm', 'dubstep', 'future-bass', 'electro'], {
    ...A('basic', 0.67, { warp: 'formant', warpAmt: 0.1 }), ...B('vowel-aeiou', 0.3, { level: 0.4 }), ...lp(9000), ...env2(0.02, 0.7, 0.3, 0.3),
    ...amp(0.01, 0.4, 0.9, 0.25), ...lfo(1, 'triangle', 0.4), ...m(['env2', 'warp1', 0.5], ['vel', 'warp1', 0.15], ['lfo1', 'pos2', 0.4]), ...mono(0.05), gain: 0.75,
  }),
  'wt-screamer': P('WT Screamer', 'Lead', ['lead'], ['dubstep', 'brostep', 'hardstyle', 'industrial', 'metal'], {
    ...A('fold', 0.5, { unison: 3, detune: 0.15 }), ...lp(6000, 0.25, 0, { filterDrive: 0.6 }), ...amp(0.005, 0.4, 0.9, 0.2),
    ...lfo(1, 'sine', '1/16'), ...m(['lfo1', 'pos1', 0.2]), ...mono(0.03), drive: 0.4, gain: 0.45,
  }),
  'wt-glass-lead': P('WT Glass Lead', 'Lead', ['lead'], ['ambient', 'chillwave', 'downtempo', 'pop', 'cinematic'], {
    ...A('pad-glass', 0.3), ...B('basic', 0, { octave: 1, level: 0.3 }), ...lp(12000), ...amp(0.01, 0.8, 0.6, 0.6),
    ...lfo(1, 'sine', 5, { fade: 0.6 }), ...m(['lfo1', 'pitch', 0.008]), gain: 0.85,
  }),
  'wt-bend-lead': P('WT Bend Lead', 'Lead', ['lead'], ['electro', 'edm', 'techno', 'idm'], {
    ...A('saw-square', 0.3, { warp: 'bendp', warpAmt: 0.4 }), ...lp(6500, 0.2), ...amp(0.005, 0.3, 0.85, 0.2),
    ...lfo(1, 'triangle', '1/2'), ...m(['lfo1', 'warp1', 0.4]), ...mono(0.05), gain: 0.65,
  }),
  'wt-trance-lead': P('WT Trance Lead', 'Lead', ['lead'], ['trance', 'psytrance', 'progressive-house', 'eurobeat'], {
    ...A('basic', 0.67, { unison: 7, detune: 0.3, spread: 0.85 }), ...B('basic', 1, { level: 0.4, octave: 1, unison: 3, detune: 0.2 }),
    ...lp(7000, 0.15, 1.5), ...env2(0.005, 0.35, 0.4, 0.3), ...amp(0.005, 0.35, 0.85, 0.35), gain: 0.55,
  }),
  'wt-whistle': P('WT Whistle', 'Lead', ['lead'], ['ambient', 'pop', 'lofi-hip-hop', 'folk', 'reggae'], {
    ...A('basic', 0.02), noiseLevel: 0.05, noiseType: 'pink', filterType: 'bp', filterSlope: '12', cutoff: 262, resonance: 0.35, keytrack: 1, velToFilter: 0,
    ...amp(0.03, 0.3, 0.9, 0.15),
    ...lfo(1, 'sine', 5.6, { fade: 0.45 }), ...m(['lfo1', 'pitch', 0.015]), ...mono(0.07), gain: 1.1,
  }),

  /* ------------------------------ KEYS / PLUCK / ARP ------------------------------ */
  'wt-pluck': P('WT Pluck', 'Pluck', ['chords', 'arp'], ['house', 'edm', 'future-bass', 'trance', 'pop', 'tropical'], {
    ...A('saw-lp', 0.05, { unison: 3, detune: 0.15 }), ...lp(12000), ...env2(0.001, 0.22, 0, 0.15), ...amp(0.001, 0.4, 0, 0.25),
    ...m(['env2', 'pos1', 0.85]), gain: 0.85,
  }),
  'wt-bell-pluck': P('WT Bell Pluck', 'Pluck', ['arp', 'lead'], ['ambient', 'trap', 'pop', 'cinematic', 'lofi-hip-hop'], {
    ...A('fm-bell', 0.4), ...lp(14000), ...env2(0.001, 0.8, 0, 0.5), ...amp(0.001, 1.4, 0, 1.2), ...m(['env2', 'pos1', 0.4]), gain: 0.85,
  }),
  'wt-mallet': P('WT Mallet', 'Keys', ['arp', 'chords'], ['ambient', 'downtempo', 'afrobeat', 'amapiano', 'idm'], {
    ...A('harm-peak', 0.12), ...lp(9000), ...env2(0.001, 0.15, 0, 0.1), ...amp(0.001, 0.7, 0, 0.5), ...m(['env2', 'pos1', 0.25]), gain: 1,
  }),
  'wt-ppg-keys': P('WT PPG Keys', 'Keys', ['chords', 'pad'], ['synthwave', '80s', 'pop', 'new-wave', 'idm'], {
    ...A('ppg-sweep', 0.2), ...B('ppg-sweep', 0.5, { level: 0.4, fine: 6 }), ...lp(6000, 0.15), ...env3(0.001, 1.2, 0.2, 0.5),
    ...amp(0.003, 1, 0.6, 0.5), ...m(['env3', 'pos1', 0.5], ['env3', 'pos2', 0.3]), gain: 0.7,
  }),
  'wt-epiano': P('WT E-Piano', 'Keys', ['chords'], ['neo-soul', 'rnb', 'lofi-hip-hop', 'jazz', 'funk', 'house'], {
    ...A('fm-1-2', 0.15, { rand: 0 }), ...B('basic', 0, { level: 0.5 }), ...lp(9000), ...env2(0.001, 0.6, 0, 0.3), ...amp(0.002, 1.8, 0.2, 0.4),
    ...lfo(1, 'sine', 4.5), ...m(['env2', 'pos1', 0.35], ['vel', 'pos1', 0.15], ['lfo1', 'amp', 0.12]), gain: 0.95,
  }),
  'wt-organ': P('WT Organ', 'Keys', ['chords', 'pad'], ['gospel', 'house', 'rock', 'blues', 'reggae', 'uk-garage'], {
    ...A('organ', 0.35, { rand: 0 }), filterType: 'off', ...amp(0.004, 0.2, 1, 0.05), ...lfo(1, 'sine', 6.5), ...m(['lfo1', 'pitch', 0.005], ['lfo1', 'pan', 0.15]), gain: 0.6,
  }),
  'wt-glass-keys': P('WT Glass Keys', 'Keys', ['chords'], ['ambient', 'chillwave', 'cinematic', 'downtempo', 'pop'], {
    ...A('pad-glass', 0.1), ...B('harm-add', 0.15, { octave: 1, level: 0.35 }), ...lp(11000), ...amp(0.003, 1.5, 0.3, 0.8), gain: 0.85,
  }),
  'wt-arp-saw': P('WT Arp Saw', 'Arp', ['arp'], ['trance', 'synthwave', 'techno', 'psytrance', 'edm'], {
    ...A('basic', 0.67, { unison: 2, detune: 0.1 }), ...lp(3000, 0.3, 2.5), ...env2(0.001, 0.15, 0, 0.1), ...amp(0.001, 0.2, 0.3, 0.12), gain: 0.75,
  }),
  'wt-arp-chip': P('WT Arp Chip', 'Arp', ['arp'], ['chiptune', 'eurobeat', 'idm', 'glitch'], {
    ...A('nes-pulse', 0.6, { rand: 0 }), filterType: 'off', ...amp(0.001, 0.12, 0.4, 0.04), gain: 0.5,
  }),
  'wt-arp-fm': P('WT Arp FM', 'Arp', ['arp'], ['techno', 'idm', 'electro', 'minimal', 'psytrance'], {
    ...A('fm-1-3', 0.1), ...lp(12000), ...env2(0.001, 0.12, 0, 0.1), ...amp(0.001, 0.25, 0.2, 0.15), ...m(['env2', 'pos1', 0.6], ['vel', 'pos1', 0.2]), gain: 0.75,
  }),
  'wt-future-pluck': P('WT Future Pluck', 'Pluck', ['chords', 'arp'], ['future-bass', 'edm', 'pop', 'kpop', 'tropical'], {
    ...A('basic', 0.67, { unison: 5, detune: 0.25 }), ...B('saw-square', 0.8, { level: 0.4, octave: 1 }), ...lp(1800, 0.25, 3.5),
    ...env2(0.001, 0.3, 0, 0.2), ...amp(0.001, 0.5, 0, 0.3), gain: 0.65,
  }),
  'wt-kalimba': P('WT Kalimba', 'Pluck', ['arp'], ['afrobeat', 'amapiano', 'lofi-hip-hop', 'ambient', 'folk'], {
    ...A('sine-saw', 0.08, { rand: 0 }), ...lp(6000), ...env2(0.001, 0.05, 0, 0.05), ...amp(0.001, 0.6, 0, 0.45), ...m(['env2', 'pos1', 0.3]), gain: 1.1,
  }),
  'wt-stab': P('WT Stab', 'Keys', ['chords'], ['house', 'tech-house', 'techno', 'uk-garage', 'deep-house'], {
    ...A('saw-square', 0.3, { unison: 3, detune: 0.15 }), ...lp(2200, 0.3, 2.5), ...env2(0.001, 0.2, 0, 0.12), ...amp(0.001, 0.25, 0, 0.15), gain: 0.75,
  }),
  'wt-future-chords': P('WT Future Chords', 'Keys', ['chords', 'pad'], ['future-bass', 'edm', 'trap', 'pop', 'kpop'], {
    ...A('basic', 0.67, { unison: 7, detune: 0.3, spread: 1 }), ...B('vowel-oa', 0.5, { level: 0.35 }), ...lp(5000, 0.15),
    ...amp(0.01, 0.4, 0.9, 0.25), ...lfo(1, 'ramp', '1/4', { retrig: true }), ...m(['lfo1', 'amp', 0.45], ['lfo1', 'cutoff', 0.1]), gain: 0.5,
  }),
  'wt-hoover': P('WT Hoover', 'Lead', ['lead', 'chords'], ['hardstyle', 'techno', 'breakbeat', 'jungle', 'industrial'], {
    ...A('pwm-saw', 0.5, { unison: 6, detune: 0.4 }), ...lp(6000, 0.2), ...env3(0, 0.15, 0, 0.1), ...amp(0.005, 0.3, 0.9, 0.35),
    ...lfo(1, 'sine', 0.8), ...m(['env3', 'pitch', -0.12], ['lfo1', 'pos1', 0.4]), ...mono(0.12), gain: 0.5,
  }),

  /* ------------------------------ PAD ------------------------------ */
  'wt-warm-pad': P('WT Warm Pad', 'Pad', ['pad', 'chords'], ['ambient', 'downtempo', 'lofi-hip-hop', 'rnb', 'neo-soul', 'deep-house'], {
    ...A('pad-warm', 0.2, { unison: 3, detune: 0.15 }), ...lp(3500, 0.1), ...amp(0.6, 1.5, 0.85, 1.6), ...lfo(1, 'triangle', 0.12),
    ...m(['lfo1', 'pos1', 0.6]), gain: 0.8,
  }),
  'wt-evolving-pad': P('WT Evolving Pad', 'Pad', ['pad'], ['ambient', 'cinematic', 'idm', 'downtempo', 'trip-hop'], {
    ...A('pad-evolve', 0, { unison: 4, detune: 0.2 }), ...B('formant-dual', 0.5, { level: 0.35, octave: 1 }), ...lp(5000, 0.15),
    ...amp(1.2, 2, 0.9, 2.5), ...env3(3, 4, 0.5, 3), ...lfo(1, 'smooth', 0.15), ...lfo(2, 'sine', 0.07),
    ...m(['env3', 'pos1', 0.7], ['lfo1', 'pos2', 0.5], ['lfo2', 'cutoff', 0.2]), gain: 0.75,
  }),
  'wt-choir-pad': P('WT Choir', 'Pad', ['pad', 'chords'], ['cinematic', 'ambient', 'gospel', 'trance', 'synthwave'], {
    ...A('choir', 0.3, { unison: 5, detune: 0.18 }), ...lp(6000), ...amp(0.4, 1, 0.9, 1.2), ...lfo(1, 'sine', 0.2), ...lfo(2, 'sine', 5, { fade: 0.8 }),
    ...m(['lfo1', 'pos1', 0.4], ['lfo2', 'pitch', 0.006]), gain: 0.8,
  }),
  'wt-vowel-pad': P('WT Vowel Pad', 'Pad', ['pad'], ['future-bass', 'chillwave', 'ambient', 'pop'], {
    ...A('vowel-oa', 0.2, { unison: 3, detune: 0.12 }), ...lp(7000), ...amp(0.3, 1, 0.9, 1), ...lfo(1, 'triangle', '2/1'),
    ...m(['lfo1', 'pos1', 0.6]), gain: 0.85,
  }),
  'wt-glass-pad': P('WT Glass Pad', 'Pad', ['pad'], ['ambient', 'cinematic', 'chillwave', 'downtempo'], {
    ...A('pad-glass', 0.5, { unison: 3, detune: 0.1 }), ...B('harm-peak', 0.6, { octave: 1, level: 0.3 }), ...lp(12000), ...amp(0.5, 1.5, 0.8, 2),
    ...lfo(1, 'sine', 0.1), ...m(['lfo1', 'pos2', 0.4]), gain: 0.8,
  }),
  'wt-dark-pad': P('WT Dark Pad', 'Pad', ['pad'], ['dubstep', 'trap', 'drum-and-bass', 'industrial', 'techno', 'phonk'], {
    ...A('saw-lp', 0.25, { unison: 4, detune: 0.2 }), ...B('pad-hollow', 0.3, { octave: -1, level: 0.5 }), ...lp(1400, 0.2),
    ...amp(0.8, 2, 0.8, 2), ...lfo(1, 'sine', 0.08), ...m(['lfo1', 'cutoff', 0.15], ['lfo1', 'pos1', 0.2]), gain: 0.8,
  }),
  'wt-shimmer-pad': P('WT Shimmer Pad', 'Pad', ['pad'], ['ambient', 'cinematic', 'trance', 'chillwave'], {
    ...A('harm-add', 0.6, { unison: 5, detune: 0.15 }), ...B('pad-bright', 0.5, { octave: 1, level: 0.4 }), ...lp(14000),
    ...amp(1, 2, 0.8, 2.5), ...lfo(1, 'triangle', 0.25), ...lfo(2, 'random', 6), ...m(['lfo1', 'pos1', 0.3], ['lfo2', 'pan', 0.2]), gain: 0.65,
  }),
  'wt-strings': P('WT Strings', 'Pad', ['pad', 'chords'], ['cinematic', 'pop', 'disco', 'synthwave', 'rnb'], {
    ...A('analog-saw', 0.5, { unison: 5, detune: 0.18 }), ...lp(4500, 0.1), ...amp(0.25, 1, 0.85, 0.8), ...lfo(1, 'sine', 5, { fade: 0.6 }),
    ...m(['lfo1', 'pitch', 0.005]), gain: 0.7,
  }),
  'wt-hollow-pad': P('WT Hollow Pad', 'Pad', ['pad'], ['ambient', 'trip-hop', 'downtempo', 'idm'], {
    ...A('pad-hollow', 0.4, { unison: 3, detune: 0.12 }), ...lp(5000, 0.2), ...amp(0.5, 1, 0.9, 1.5), ...lfo(1, 'sine', 0.2), ...m(['lfo1', 'pos1', 0.5]), gain: 0.85,
  }),
  'wt-noise-pad': P('WT Noise Pad', 'Pad', ['pad'], ['ambient', 'idm', 'glitch', 'cinematic'], {
    ...A('noise-cycle', 0.3, { unison: 4, detune: 0.3 }), noiseLevel: 0.15, noiseType: 'pink', ...lp(2500, 0.3), ...amp(1, 2, 0.8, 2),
    ...lfo(1, 'smooth', 0.3), ...m(['lfo1', 'pos1', 0.6], ['lfo1', 'cutoff', 0.25]), gain: 0.7,
  }),
  'wt-ppg-pad': P('WT PPG Pad', 'Pad', ['pad', 'chords'], ['synthwave', 'idm', 'new-wave', 'ambient'], {
    ...A('ppg-sweep', 0.1, { unison: 3, detune: 0.15 }), ...lp(7000, 0.1), ...env3(1.5, 3, 0.6, 2), ...amp(0.3, 1, 0.85, 1.4),
    ...m(['env3', 'pos1', 0.7]), gain: 0.75,
  }),
  'wt-ambient-pad': P('WT Ambient Pad', 'Pad', ['pad'], ['ambient', 'cinematic', 'downtempo', 'lofi-hip-hop'], {
    ...A('formant-dual', 0.3, { unison: 3, detune: 0.12 }), ...B('pad-warm', 0.6, { level: 0.5, octave: -1 }), ...lp(4000, 0.1),
    ...amp(1.5, 2, 0.9, 3), ...lfo(1, 'sine', 0.05), ...lfo(2, 'triangle', 0.13), ...m(['lfo1', 'pos1', 0.6], ['lfo2', 'pos2', 0.4]), gain: 0.8,
  }),

  /* ------------------------------ FX ------------------------------ */
  'wt-riser': P('WT Riser', 'FX', ['fx'], EDM.concat(['trap', 'drum-and-bass']), {
    ...A('saw-lp', 0, { unison: 7, detune: 0.4 }), noiseLevel: 0.3, ...lp(400, 0.3), ...env3(6, 0.1, 1, 0.5), ...amp(0.5, 1, 1, 0.8),
    ...m(['env3', 'pitch', 0.6], ['env3', 'cutoff', 0.9], ['env3', 'pos1', 1]), gain: 0.6,
  }),
  'wt-sweep': P('WT Sweep', 'FX', ['fx'], ['house', 'techno', 'trance', 'edm', 'breakbeat'], {
    ...A('formant-sweep', 0, { unison: 3, detune: 0.3 }), noiseLevel: 0.2, filterType: 'bp', cutoff: 1500, resonance: 0.4, ...amp(0.3, 1, 1, 1.5),
    ...lfo(1, 'triangle', '4/1', { retrig: true }), ...m(['lfo1', 'pos1', 1], ['lfo1', 'cutoff', 0.5]), gain: 0.7,
  }),
  'wt-laser': P('WT Laser', 'FX', ['fx'], ['dubstep', 'electro', 'psytrance', 'techno', 'drum-and-bass'], {
    ...A('fm-feedback', 0.8, { rand: 0 }), filterType: 'off', ...env3(0, 0.35, 0, 0.2), ...amp(0.001, 0.4, 0, 0.2),
    ...m(['env3', 'pitch', 1], ['env3', 'pos1', -0.6]), gain: 0.6,
  }),
  'wt-zap': P('WT Zap', 'FX', ['fx'], ['chiptune', 'electro', 'idm', 'glitch'], {
    ...A('digital-steps', 0.5, { rand: 0, warp: 'quantize', warpAmt: 0.4 }), filterType: 'off', ...env3(0, 0.12, 0, 0.1), ...amp(0.001, 0.15, 0, 0.1),
    ...m(['env3', 'pitch', 1]), gain: 0.55,
  }),
  'wt-drone': P('WT Drone', 'FX', ['fx', 'pad'], ['ambient', 'industrial', 'cinematic', 'idm'], {
    ...A('fold', 0.2, { unison: 4, detune: 0.1 }), ...B('fm-1-1', 0.5, { octave: -1, level: 0.5 }), ...lp(1800, 0.35), ...amp(2, 2, 1, 3),
    ...lfo(1, 'smooth', 0.05), ...lfo(2, 'sine', 0.11), ...m(['lfo1', 'pos1', 0.6], ['lfo2', 'cutoff', 0.3], ['lfo1', 'warp2', 0.3]), osc2Warp: 'fm', osc2WarpAmt: 0.3, gain: 0.6,
  }),
  'wt-alien': P('WT Alien Texture', 'FX', ['fx'], ['idm', 'glitch', 'ambient', 'cinematic'], {
    ...A('rust', 0.3, { unison: 2, detune: 0.3 }), filterType: 'comb', cutoff: 400, resonance: 0.6, keytrack: 1, ...amp(0.2, 1, 0.8, 1.5),
    ...lfo(1, 'random', '1/16'), ...lfo(2, 'smooth', 0.4), ...m(['lfo1', 'pos1', 0.8], ['lfo2', 'cutoff', 0.4]), gain: 0.6,
  }),
  'wt-grit-texture': P('WT Grit Texture', 'FX', ['fx'], ['industrial', 'techno', 'glitch', 'trip-hop'], {
    ...A('grit', 0.5, { unison: 3, detune: 0.25, warp: 'quantize', warpAmt: 0.2 }), noiseLevel: 0.2, noiseType: 'brown', ...lp(3000, 0.4),
    ...amp(0.1, 1, 0.8, 1), ...lfo(1, 'saw', '1/8'), ...m(['lfo1', 'pos1', 0.4]), gain: 0.6,
  }),
  'wt-sub-drop': P('WT Sub Drop', 'FX', ['fx'], ['trap', 'dubstep', 'edm', 'drum-and-bass', 'future-bass'], {
    ...A('basic', 0.05, { rand: 0 }), filterType: 'off', ...env3(0, 1.5, 0, 0.5), ...amp(0.001, 2, 0, 0.5), ...m(['env3', 'pitch', 1]),
    drive: 0.3, driveType: 'tube', gain: 1,
  }),
};

/* Loudness trims: output gains measured through the processor (gated level of a short phrase per role: bass −17,
   leads −18, chords −19, pads / FX −20 dB), capped so the phrase never clips before the output stage. */
const WT_GAIN = {
  'wt-sub-bass': 1.691, 'wt-growl-bass': 0.484, 'wt-wobble-bass': 0.776, 'wt-reese': 0.657, 'wt-fm-bass': 1.08,
  'wt-pluck-bass': 2, 'wt-talking-bass': 0.694, 'wt-neuro-bass': 0.94, 'wt-808': 2, 'wt-acid-bass': 0.596,
  'wt-donk': 2, 'wt-synthwave-bass': 1.608, 'wt-hollow-bass': 2, 'wt-tearout': 0.493, 'wt-moog-bass': 0.858,
  'wt-digital-bass': 1.609, 'wt-supersaw-lead': 0.943, 'wt-sync-lead': 1.039, 'wt-pwm-lead': 1.113,
  'wt-vocal-lead': 1.605, 'wt-chip-lead': 1.161, 'wt-fm-lead': 0.649, 'wt-formant-lead': 1.461, 'wt-screamer': 0.437,
  'wt-glass-lead': 2, 'wt-bend-lead': 0.897, 'wt-trance-lead': 0.909, 'wt-whistle': 1.161, 'wt-pluck': 0.812,
  'wt-bell-pluck': 1.378, 'wt-mallet': 2, 'wt-ppg-keys': 0.985, 'wt-epiano': 0.431, 'wt-organ': 0.565,
  'wt-glass-keys': 1.512, 'wt-arp-saw': 2, 'wt-arp-chip': 1.864, 'wt-arp-fm': 1.7, 'wt-future-pluck': 0.884,
  'wt-kalimba': 2, 'wt-stab': 0.999, 'wt-future-chords': 0.456, 'wt-hoover': 1.616, 'wt-warm-pad': 0.911,
  'wt-evolving-pad': 1.229, 'wt-choir-pad': 0.591, 'wt-vowel-pad': 0.738, 'wt-glass-pad': 1.459,
  'wt-dark-pad': 0.582, 'wt-shimmer-pad': 1.454, 'wt-strings': 0.437, 'wt-hollow-pad': 0.643, 'wt-noise-pad': 2,
  'wt-ppg-pad': 0.603, 'wt-ambient-pad': 1.75, 'wt-riser': 1.091, 'wt-sweep': 2, 'wt-laser': 1.452, 'wt-zap': 2,
  'wt-drone': 1.23, 'wt-alien': 2, 'wt-grit-texture': 2, 'wt-sub-drop': 1.342,
};
for (const [id, g] of Object.entries(WT_GAIN)) if (WAVETABLE_PRESETS[id]) WAVETABLE_PRESETS[id].instrument.params.gain = g;
