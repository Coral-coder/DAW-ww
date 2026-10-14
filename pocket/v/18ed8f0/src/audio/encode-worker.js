// Module Worker: MP3 encoding off the main thread (src/io/mp3.js + the vendored LAME port, loaded on first use).
// message {id, channels: Float32Array[], sampleRate, opts} -> {id, progress} … {id, data: Uint8Array} | {id, error}
import { encodeMp3 } from '../io/mp3.js';

self.onmessage = async (e) => {
  const { id, channels, sampleRate, opts } = e.data || {};
  try {
    const data = await encodeMp3(channels, sampleRate, { ...opts, onProgress: (f) => self.postMessage({ id, progress: f }) });
    self.postMessage({ id, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
