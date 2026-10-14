// Web Worker wrapper: postMessage({ id, channels: Float32Array[], sampleRate }) -> { id, result | error }.
import { analyzeTrack } from './index.js';

self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data || {};
  try {
    const result = analyzeTrack(channels, sampleRate, { onProgress: (p) => self.postMessage({ id, progress: p }) });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
