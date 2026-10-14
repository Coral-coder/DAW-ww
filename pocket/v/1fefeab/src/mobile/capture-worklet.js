// AudioWorklet: copies the microphone input to the main thread in blocks (hum / whistle to notes).
// Loaded with audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url)).
if (typeof AudioWorkletProcessor !== 'undefined') {
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.buf = new Float32Array(1024);
      this.n = 0;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (ch) {
        for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(1024); this.n = 0; }
        }
      }
      return true;
    }
  }
  registerProcessor('daw3-capture', CaptureProcessor);
}
