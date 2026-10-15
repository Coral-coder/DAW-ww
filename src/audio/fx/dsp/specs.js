// AudioWorklet processor specs shared by the processors (worklets/fx-processors.js) and the effect builders: the
// AudioParam names of each processor (all k-rate unless listed in aRate) and its number of inputs. Every value is a
// plain number (enums / bools are indices / 0-1), so automation and offline rendering go through AudioParams only —
// no port messages, which an OfflineAudioContext would not deliver deterministically.
export const FX_PROCESSORS = {
  'daw3-fx-reverb': { params: ['mode', 'size', 'decay', 'predelay', 'diffusion', 'damping', 'mod', 'balance', 'freeze', 'width', 'shimmer', 'interval', 'tone'] },
  'daw3-fx-grain': { params: ['time', 'size', 'density', 'pitch', 'pitchRand', 'spread', 'pan', 'reverse', 'feedback', 'freeze', 'window', 'tone', 'regular'] },
  'daw3-fx-pitch': { params: ['semis', 'cents', 'quality', 'formant', 'level1', 'v2On', 'v2Int', 'v2Level', 'v2Pan', 'v3On', 'v3Int', 'v3Level', 'v3Pan', 'scaleMode', 'key', 'scale'] },
  'daw3-fx-formant': { params: ['shift', 'pitch'] },
  'daw3-fx-vocoder': { inputs: 2, params: ['bands', 'lo', 'hi', 'bw', 'attack', 'release', 'formant', 'carrier', 'wave', 'note', 'chord', 'detune', 'noise', 'sibilance', 'spread', 'emphasis', 'output'] },
  'daw3-fx-freqshift': { params: ['shift', 'direction', 'feedback', 'mod'], aRate: ['mod'] },
  'daw3-fx-resonator': { params: ['note', 'chord', 'tune', 'decay', 'bright', 'type', 'spread'] },
  'daw3-fx-autowah': { params: ['sens', 'attack', 'release', 'cutoff', 'range', 'type', 'q'] },
};
