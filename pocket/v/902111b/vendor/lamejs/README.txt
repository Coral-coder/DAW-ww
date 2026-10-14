lamejs 1.2.1 — pure JavaScript MP3 encoder, a port of LAME 3.99 (via jump3r)
  upstream:  https://github.com/zhuker/lamejs  (npm: lamejs@1.2.1, file lame.all.js)
  LAME:      https://lame.sourceforge.io
  license:   LGPL-3.0 (LICENSE = the LGPL-3.0 text followed by the GPL-3.0 text it incorporates;
             LAME-NOTE.txt = the upstream LICENSE note)

daW³ (AGPL-3.0-or-later) uses it as a separate, unmodified-API library: LGPL-3.0 code may be combined with
AGPL-3.0 code (LGPL-3.0 §4/§5, and the GPL-3.0/AGPL-3.0 §13 compatibility); the library stays under the
LGPL-3.0 and users can replace this file. It is loaded lazily, only when an MP3 export runs
(src/audio/encode-worker.js -> src/io/mp3-encode.js).

lame.mjs = lame.all.js with the modifications in daw3-modifications.diff (released under the LGPL-3.0):
  * ES module: `export default lamejs;` at the end (the code runs in strict mode unchanged)
  * Mp3Encoder(channels, sampleRate, kbps, opts): opts.vbr === 'abr' = average-bitrate VBR; getEncoderInfo()
    returns the encoder delay / padding for the LAME info tag (gapless playback)
  * ABRIterationLoop ported from LAME 3.99 quantize.c ABR_iteration_loop (missing from lamejs 1.2.1)
  * `(int)(` casts left over from the Java port replaced with `0|(` (they threw in the ABR path)
