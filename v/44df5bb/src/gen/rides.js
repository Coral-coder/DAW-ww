// "Rides": the moves a producer makes by hand while mixing — written as sparse, editable automation lanes in the
// drawn-automation format (src/core/automation.js): one lane per target, a few points per section.
//   * volume rides on pad / lead / chords per section (verses tucked in, choruses up 1–2 dB, swell into the chorus)
//   * delay / reverb send throws on the last held note of a lead phrase (the echo tail without washing the line)
//   * stereo width of the pad (narrower verses, wide choruses / breakdowns)
//   * a filter dip that slowly re-opens through breakdowns (electronic), filter sweeps through builds
//   * 303-style cutoff / resonance riding on acid lines
import { clamp, dbToGain } from '../core/util.js';
import { rampPoints } from '../core/automation.js';

const r3 = (x) => Math.round(x * 1000) / 1000;

/** Section-level level offsets (dB) by role and section kind. */
const RIDE_DB = {
  bass: { intro: -1, verse: -1, build: -0.5, main: 0.5, break: 0, outro: -1 },
  lead: { intro: -1.5, verse: -1, build: 0, main: 1.2, break: 0.5, outro: -2 },
  pad: { intro: -1, verse: -2, build: 0.5, main: 0.5, break: 1.5, outro: -1 },
  chords: { intro: -1, verse: -0.5, build: 0, main: 0.8, break: 0.5, outro: -1 },
  arp: { intro: -1, verse: -1.5, build: 0.5, main: 0, break: 0, outro: -2 },
};

/**
 * Add rides to every track (mutates the AutomationBuilders in `auto`).
 * ctx: {genre, tracks, sections, bpb, auto: Map(trackId -> AutomationBuilder), notesBy: (sectionIndex, role) -> Note[],
 *       buses: [reverb, delay], electronic, rng, ensureFilter(track) -> fx, songEnd}
 */
export function addRides(ctx) {
  const { tracks, sections, bpb, auto, notesBy, buses, electronic, rng, ensureFilter } = ctx;
  const [rev, dly] = buses;
  for (const t of tracks) {
    const role = t.role;
    const b = auto.get(t.id);
    const playing = sections.filter((s) => s.roles.includes(role));
    if (!playing.length) continue;

    // ---- volume rides (sections where the track plays; ramps over the bar before a change)
    if (RIDE_DB[role]) {
      const pts = [];
      let prev = null;
      for (const s of sections) {
        if (!s.roles.includes(role)) continue;
        const db = RIDE_DB[role][s.kind] ?? 0;
        const occ = s.occurrence > 1 && s.kind !== 'outro' ? 0.5 : 0; // later sections lift a touch
        const v = r3(clamp(t.volume * dbToGain(db + occ + (rng() - 0.5) * 0.6), 0, 1.5));
        const a = s.start, z = s.start + s.bars * bpb;
        if (prev == null || Math.abs(prev - v) > 1e-3) {
          // ride into the new level over the last beat before the section (a swell into choruses)
          if (prev != null) pts.push({ beat: Math.max(0, a - (s.kind === 'main' ? bpb : 1)), value: prev });
          pts.push({ beat: a, value: v });
        }
        // pads breathe up into the chorus: +2 dB across the bar before it
        if (role === 'pad' && s.next?.kind === 'main' && s.bars >= 2) pts.push({ beat: z - bpb, value: v }, { beat: z - 0.01, value: r3(Math.min(1.5, v * dbToGain(2))) });
        prev = v;
      }
      if (pts.length >= 2) b.add('volume', pts);
    }

    // ---- send throws on lead phrase endings (delay; reverb for slow genres)
    if (role === 'lead' && (dly || rev)) {
      const bus = dly && t.sends[dly.id] != null ? dly : rev;
      const base = t.sends[bus.id] ?? 0;
      const pts = [];
      for (const s of playing) {
        if (s.kind === 'intro' || s.kind === 'outro') continue;
        const notes = notesBy(s.index, 'lead') || [];
        // the last held note of the section's phrases (cadences): longest note in the last 2 bars of each 4/8-bar period
        const len = s.bars * bpb;
        const period = Math.min(len, 8 * bpb);
        let throws = 0;
        for (let end = period; end <= len + 1e-6 && throws < 2; end += period) {
          const cand = notes.filter((n) => n.start >= end - 2 * bpb && n.start < end && n.dur >= 0.75).sort((x, y) => y.dur - x.dur || y.start - x.start)[0];
          if (!cand) continue;
          const t0 = s.start + cand.start;
          const hold = Math.min(cand.dur, 2);
          const peak = r3(clamp(base + 0.32 + rng() * 0.08, 0, 0.75));
          pts.push({ beat: r3(t0 - 0.05), value: base }, { beat: r3(t0), value: peak }, { beat: r3(t0 + hold), value: peak }, { beat: r3(t0 + hold + 0.5), value: base });
          throws++;
        }
      }
      if (pts.length) b.add(`send:${bus.id}`, pts);
    }

    // ---- pad width: narrower in verses, wide in choruses / breakdowns
    if (role === 'pad') {
      const wid = t.fx.find((f) => f.type === 'widener');
      if (wid) {
        const pts = [];
        for (const s of playing) {
          const w = { verse: 1.15, intro: 1.3, build: 1.4, main: 1.7, break: 1.85, outro: 1.4 }[s.kind] ?? 1.5;
          pts.push(...rampPoints(s.start, s.start + Math.max(1, s.bars * bpb - 1), w, w));
        }
        b.add(`fx:${wid.id}:width`, pts);
      }
    }

    // ---- breakdowns: filter dips and slowly re-opens (electronic chords / pads)
    if (electronic && (role === 'chords' || role === 'pad')) {
      for (const s of playing) {
        if (s.kind !== 'break' || s.bars < 4) continue;
        const fx = ensureFilter(t);
        const a = s.start, z = s.start + s.bars * bpb;
        b.add(`fx:${fx.id}:cutoff`, [{ beat: Math.max(0, a - 0.01), value: 20000 }, { beat: a, value: 1800 }, { beat: a + (z - a) * 0.5, value: 3500 }, { beat: z - 0.01, value: 12000 }, { beat: z, value: 20000 }]);
      }
    }

    // ---- acid lines: ride the 303 cutoff / resonance (instrument params)
    if (/acid/.test(t.instrument?.preset || '') && t.instrument.type === 'synth') {
      const cut = [], res = [];
      for (const s of playing) {
        const a = s.start, z = s.start + s.bars * bpb;
        // drops open the filter (never sit a 303 at a static few hundred Hz through the main section)
        const lo = s.kind === 'main' ? 650 : 380;
        const hi = s.kind === 'main' ? 2200 + rng() * 800 : 900 + rng() * 300;
        cut.push({ beat: a, value: lo }, { beat: a + (z - a) * 0.75, value: Math.round(hi) }, { beat: z - 0.01, value: Math.round(lo * 1.4) });
        res.push({ beat: a, value: s.kind === 'main' ? 0.88 : 0.78 }, { beat: z - 0.01, value: s.kind === 'main' ? 0.9 : 0.8 });
      }
      b.add('inst:cutoff', cut);
      b.add('inst:resonance', res);
    }

    // ---- club leads (electronic): fade in through a low-pass when they enter (no abrupt hook entrances);
    // techno / acid patches get a slow filter LFO (the hypnotic movement) through the sections they play
    if (role === 'lead' && electronic && !t.layerOf && t.instrument?.type !== 'synth') {
      const lfo = /^sd-(techno-pluck|acid-lead)$/.test(t.instrument?.preset || '') ? (t.instrument.preset === 'sd-acid-lead' ? [800, 3600] : [900, 4000]) : null;
      // the automation stays sparse (<= 64 points): the LFO is sampled every 2 bars, every 4 on long songs
      const build = (step) => {
        const pts = [];
        let prevPlays = false;
        for (const s of sections) {
          const plays = s.roles.includes(role);
          const a = s.start, z = s.start + s.bars * bpb;
          if (plays) {
            const entering = !prevPlays;
            // a drop opens fast (1 bar), elsewhere the hook rises over up to 4 bars
            const ramp = entering ? Math.min(s.kind === 'main' ? 1 : 4, Math.max(1, Math.floor(s.bars / 2))) * bpb : 0;
            if (entering) pts.push({ beat: r3(Math.max(0, a - 0.01)), value: 20000 }, { beat: a, value: s.kind === 'main' ? 1200 : 500 });
            if (lfo) {
              // one LFO cycle per 8 bars (sine), starting after the fade-in
              const period = 8 * bpb;
              for (let x = a + ramp; x < z - 0.01; x += step * bpb) {
                const ph = ((x - a) % period) / period;
                pts.push({ beat: r3(x), value: Math.round(lfo[0] * (lfo[1] / lfo[0]) ** (0.5 - 0.5 * Math.cos(2 * Math.PI * ph))) });
              }
            } else if (entering) {
              pts.push({ beat: r3(a + ramp), value: 20000 });
            }
          }
          prevPlays = plays;
        }
        return pts;
      };
      let pts = build(2);
      if (pts.length > 60) pts = build(4);
      if (pts.length > 60) pts = build(8);
      if (pts.length >= 2) {
        const fx = ensureFilter(t);
        b.add(`fx:${fx.id}:cutoff`, pts.sort((x, y) => x.beat - y.beat));
      }
    }
  }
}

