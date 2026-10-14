// Metronome click: a short pitched blip with a fast exponential decay (accented downbeat).

/** Schedule one click at `time` into `dest`. */
// accent: true / 2 = bar downbeat, 1 = accent-group start (compound / odd meters, see time/tempo-map.js), false / 0 = other
export function scheduleClick(ctx, dest, time, accent = false, volume = 0.5) {
  const level = accent === true ? 2 : accent === false || accent == null ? 0 : Number(accent) || 0;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = level >= 2 ? 1760 : level === 1 ? 1480 : 1175;
  const peak = volume * (level >= 2 ? 1 : level === 1 ? 0.8 : 0.6);
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(peak, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  osc.connect(g);
  g.connect(dest);
  osc.start(time);
  osc.stop(time + 0.07);
  osc.onended = () => { try { g.disconnect(); } catch { /* */ } };
}
