// Extra drum layers (src/gen/orchestra.js: Percussion, Break Ghosts, Impacts) complement the main kit, never
// duplicate it: no kick / backbeat / hats in the ghost layer, a sparse 1–2 voice percussion part, a top-end density
// budget across all drum tracks with at most one 16th stream, fixed velocity families, no doubled backbeat snares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import { TOP_END, topEndBudget, topEndPerBar, PERC_MAX_HITS, PERC_MAX_VOICES } from '../src/gen/orchestra.js';

const SNARES = new Set([38, 39, 40]);

test('extra drum layers complement the main kit (every genre × 3 seeds)', () => {
  const problems = [];
  for (const genre of Object.keys(G.GENRES)) {
    const g = G.GENRES[genre];
    const bpb = (g.timeSig?.[0] || 4) * (4 / (g.timeSig?.[1] || 4));
    for (const seed of [1, 2, 3]) {
      const s = G.generateSong({ genre, seed, production: false });
      const tag = `${genre} s${seed}`;
      const main = s.tracks.find((t) => t.role === 'drums');
      const extra = s.tracks.filter((t) => t.instrument?.type === 'drums' && t !== main);
      if (!extra.length) continue;
      const bySection = new Map(); // clip start -> {trackId: notes}
      for (const c of s.clips) {
        const t = s.tracks.find((x) => x.id === c.trackId);
        if (t?.instrument?.type !== 'drums') continue;
        (bySection.get(c.start) || bySection.set(c.start, { len: c.length }).get(c.start))[t.id] = s.patterns[c.patternId].notes;
      }
      for (const [start, sec] of bySection) {
        const bars = Math.round(sec.len / bpb);
        const at = `${tag} @${start}`;
        const kit = sec[main?.id] || [];
        const kitTop = topEndPerBar(kit, bars, bpb);
        const allTop = topEndPerBar(Object.entries(sec).filter(([k]) => k !== 'len').flatMap(([, n]) => n), bars, bpb);
        for (let b = 0; b < bars; b++) {
          // (3) top-end budget: extras add nothing once the kit fills it; never a second 16th stream
          const cap = Math.max(topEndBudget(g), kitTop[b].hits);
          if (allTop[b].hits > cap) problems.push(`${at} bar ${b}: top end ${allTop[b].hits} > ${cap}`);
          if (allTop[b].streams > Math.max(1, kitTop[b].streams)) problems.push(`${at} bar ${b}: ${allTop[b].streams} 16th streams`);
        }
        for (const t of extra) {
          const ns = sec[t.id];
          if (!ns) continue;
          if (t.role === 'top') {
            // (1) the ghost layer: no kick, no snare on a beat, no hats / ride
            if (ns.some((n) => n.pitch === 36 || TOP_END.has(n.pitch))) problems.push(`${at} ${t.name}: kick / top end in the ghost layer`);
            if (ns.some((n) => SNARES.has(n.pitch) && Math.abs(n.start - Math.round(n.start)) < 0.06)) problems.push(`${at} ${t.name}: on-beat snare`);
          }
          if (t.role === 'perc') {
            // (2) sparse: <= 2 voices, <= 8 hits per bar
            const voices = new Set(ns.map((n) => n.pitch));
            if (voices.size > PERC_MAX_VOICES) problems.push(`${at} ${t.name}: ${voices.size} voices`);
            for (let b = 0; b < bars; b++) {
              const k = ns.filter((n) => Math.floor((n.start + 0.02) / bpb) === b).length;
              if (k > PERC_MAX_HITS) problems.push(`${at} ${t.name} bar ${b}: ${k} hits`);
            }
          }
          if (t.role === 'perc' || t.role === 'top') {
            // (4) velocity families (fixed accent / normal / ghost levels): ghosts >= 0.25
            if (ns.some((n) => n.vel < 0.25)) problems.push(`${at} ${t.name}: ghost < 0.25`);
          }
          // (5) no doubled backbeat snares across drum tracks
          const kitSn = new Set(kit.filter((n) => SNARES.has(n.pitch)).map((n) => Math.round(n.start * 4)));
          for (const n of ns) if (SNARES.has(n.pitch) && kitSn.has(Math.round(n.start * 4))) { problems.push(`${at} ${t.name}: snare doubles the kit @${n.start}`); break; }
        }
      }
    }
  }
  assert.deepEqual(problems.slice(0, 15), [], problems.slice(0, 15).join('\n'));
});

test('liquid dnb: no break layer, at most a light shaker', () => {
  for (const seed of [1, 2, 3]) {
    const s = G.generateSong({ genre: 'liquid-dnb', seed });
    assert.ok(!s.tracks.some((t) => t.role === 'top'), 'no top loop in liquid');
    const perc = s.tracks.find((t) => t.role === 'perc');
    if (perc) for (const p of Object.values(s.patterns)) if (p.trackId === perc.id) assert.ok(p.notes.every((n) => n.pitch === 70), 'shaker only');
  }
});
