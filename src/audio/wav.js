// Re-export of the WAV codec (src/io/wav.js) for audio-side callers: encodeWav(buffers, {bitDepth, dither,
// noiseShaping, seed}), decodeWav(arrayBuffer), wavBlob(). The true-peak limiter lives in ./dsp/truepeak.js.
export { encodeWav, decodeWav, wavInfo, readWavFrames, wavBlob } from '../io/wav.js';
export { truePeak, truePeakDb, limitTruePeak } from './dsp/truepeak.js';
