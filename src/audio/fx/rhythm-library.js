// Factory content of the rhythm effects: trance-gate step patterns and volume-shaper curves (pure data, used by
// the effect presets in fx/defs/rhythm.js and the pattern / shape pickers of the card UIs).
// Pattern strings: see parsePattern (x = 100 %, - = off, 1…9 = 10…90 %). Curves: see parseCurve ("x,y,tension").

/** Euclidean rhythm: k hits spread as evenly as possible over n steps (Bjorklund), as a compact pattern string. */
export function euclid(k, n, rotate = 0) {
  const base = Array.from({ length: n }, (_, i) => (Math.floor((i * k) / n) !== Math.floor(((i - 1) * k) / n) ? 'x' : '-'));
  return base.map((_, i) => base[(((i - rotate) % n) + n) % n]).join('');
}

/**
 * Trance-gate patterns: { name: { pattern, steps?, division?, stereo?, stereoOffset?, patternR? } }.
 * Grouped loosely: classic trance, house / EDM, accents / swells, odd grids, stereo.
 */
export const GATE_PATTERNS = {
  'Classic Trance': { pattern: 'xx-xx-x-xx-xx-x-' },
  'Trance Lift': { pattern: 'x-xx-xx-x-xx-x-x' },
  'Straight 16ths': { pattern: 'xxxxxxxxxxxxxxxx' },
  'Offbeat 8ths': { pattern: '--x---x---x---x-' },
  'Rolling Offbeat': { pattern: '-xxx-xxx-xxx-xxx' },
  'Gallop': { pattern: 'x-xxx-xxx-xxx-xx' },
  'Three-Three-Two': { pattern: 'x--x--x-x--x--x-' },
  'Dotted 8ths': { pattern: 'x--x--x--x--x--x' },
  'Quarter Chop': { pattern: 'xxx-xxx-xxx-xxx-' },
  'Half-Bar Chop': { pattern: 'xxxxxxxx--------' },
  'Stutter Blocks': { pattern: 'xxxx----xx--xxxx' },
  'Dub Chop': { pattern: 'x---x-x-x---x-x-' },
  'House Organ': { pattern: '--x--x----x--x-x' },
  'Syncopated': { pattern: 'x-x--x-x--x-x-x-' },
  'Breakdown Sparse': { pattern: 'x-------x---x---' },
  'Accent Pump': { pattern: 'x575x575x575x575' },
  'Ramp Up': { pattern: '1357x1357x1357x-' },
  'Ramp Down': { pattern: 'x7531-x7531-x753' },
  'Echo Taps': { pattern: 'x-5-x-3-x-5-x-3-' },
  'Euclid 5/16': { pattern: euclid(5, 16) },
  'Euclid 7/16': { pattern: euclid(7, 16) },
  'Euclid 9/16': { pattern: euclid(9, 16) },
  'Triplet Gallop': { pattern: 'x-xx-xx-xx-x', steps: 12, division: '1/8T' },
  'Triplet 16ths': { pattern: 'xx-xx-xx-xx-', steps: 12, division: '1/16T' },
  '8th Pulse': { pattern: 'x-', steps: 8, division: '1/8' },
  '32-Step Build': { pattern: 'x---x---x---x---x-x-x-x-xxxxxxxx', steps: 32, division: '1/16' },
  '32nd Roll': { pattern: 'x-x-x-x-xxxxxxxx', steps: 16, division: '1/32' },
  'Ping-Pong 8ths': { pattern: 'x---x---x---x---', stereo: 'offset', stereoOffset: 2 },
  'Stereo Trance': { pattern: 'xx-xx-x-xx-xx-x-', stereo: 'offset', stereoOffset: 1 },
  'L/R Call & Response': { pattern: 'x-x-x-x---------', stereo: 'invert' },
  'Wide Weave': { pattern: 'x-xx-x-xx-xx-x-x', patternR: '-xx-xx-x-xx-x-xx', stereo: 'separate' },
};

/** Volume-shaper curves (x,y,tension points over one cycle). */
export const SHAPER_CURVES = {
  'Pump Classic': '0,0,-0.55 0.5,1',
  'Pump Hard': '0,0 0.06,0,-0.75 0.32,1',
  'Pump Soft': '0,0.35,-0.35 0.7,1',
  'Pump Long': '0,0,-0.45 0.92,1',
  'Pump Linear': '0,0 0.5,1',
  'Pump Late': '0,0,0.55 0.6,1',
  'Duck & Hold': '0,0 0.22,0,-0.6 0.45,1',
  'Gate 1/2': '0,1 0.5,1 0.5,0 1,0',
  'Gate 1/4 x2': '0,1 0.25,1 0.25,0 0.5,0 0.5,1 0.75,1 0.75,0 1,0',
  'Gate Short': '0,1 0.18,1,0.4 0.3,0 1,0',
  'Swell': '0,0,0.55 1,1',
  'Reverse Swell': '0,0,0.75 0.92,1 0.97,0',
  'Fade Out': '0,1,-0.4 1,0',
  'Triangle': '0,0 0.5,1 1,0',
  'Sine': '0,0.5,-0.35 0.25,1,0.35 0.5,0.5,-0.35 0.75,0,0.35',
  'Saw Up': '0,0 1,1',
  'Saw Down': '0,1 1,0',
  'Stair Steps': '0,0.25 0.25,0.25 0.25,0.5 0.5,0.5 0.5,0.75 0.75,0.75 0.75,1 1,1',
  'Double Pump': '0,0,-0.55 0.25,1 0.5,1 0.5,0,-0.55 0.75,1',
  'Half-Time Pump': '0,0,-0.5 0.4,1 0.5,1 0.5,0.55,-0.4 0.7,1',
};
