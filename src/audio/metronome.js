// Metronome click: a short pitched blip with a fast exponential decay (accented downbeat).

/** Schedule one click at `time` into `dest`. */
export function scheduleClick(ctx, dest, time, accent = false, volume = 0.5) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = accent ? 1760 : 1175;
  const peak = volume * (accent ? 1 : 0.6);
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(peak, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  osc.connect(g);
  g.connect(dest);
  osc.start(time);
  osc.stop(time + 0.07);
  osc.onended = () => { try { g.disconnect(); } catch { /* */ } };
}
