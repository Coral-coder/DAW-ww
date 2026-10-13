// Strudel compatibility check: evaluates every tune of tests/fixtures/strudel-tunes/ with the vendored
// REAL Strudel engine through daW³'s facade (src/code/strudel.js) and queries 4 cycles of events.
//
//   node tests/strudel-compat.mjs [--verbose]        prints the pass rate per corpus, exit 1 on failures
//
// (tests/strudel-compat.test.js runs the same check under `npm test`.)
import fs from 'node:fs';
import { loadStrudel, evaluate, queryEvents, codeEngine } from '../src/code/strudel.js';

const DIR = new URL('./fixtures/strudel-tunes/', import.meta.url);
export const CORPORA = ['tunes', 'examples', 'docs', 'user-cases'];

export async function runCompat({ cycles = 4 } = {}) {
  if (!(await loadStrudel()) || codeEngine() !== 'strudel') throw new Error('vendored Strudel engine failed to load');
  const report = {};
  for (const name of CORPORA) {
    const { tunes } = JSON.parse(fs.readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
    const failures = [];
    const legacy = { total: 0, passed: 0, failures: [] };
    let events = 0;
    let total = 0;
    for (const t of tunes) {
      let err = null;
      try {
        const r = evaluate(t.code);
        err = r.error;
        if (!err) {
          events += queryEvents(r, 0, cycles).length;
          err = r.queryError || null;
        }
      } catch (e) { err = String(e?.message || e); }
      if (t.expectError) err = err ? null : 'expected a syntax error (intentionally broken example)';
      if (t.legacy) {
        legacy.total++;
        if (err) legacy.failures.push({ name: t.name, source: t.source, error: err }); else legacy.passed++;
        continue;
      }
      total++;
      if (err) failures.push({ name: t.name, source: t.source, error: err });
    }
    report[name] = { total, passed: total - failures.length, events, failures, legacy };
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const verbose = process.argv.includes('--verbose');
  const report = await runCompat();
  let total = 0;
  let passed = 0;
  for (const [name, r] of Object.entries(report)) {
    total += r.total;
    passed += r.passed;
    console.log(`${name.padEnd(11)} ${r.passed}/${r.total} evaluate + query 4 cycles without errors (${r.events} events)`);
    for (const f of r.failures) console.log(`   ✗ ${f.name} (${f.source}): ${f.error}`);
    if (r.legacy.total) {
      console.log(`  + legacy  ${r.legacy.passed}/${r.legacy.total} (Tone.js-era test tunes; not part of the target)`);
      for (const f of r.legacy.failures) console.log(`   ~ ${f.name}: ${f.error}`);
    }
  }
  console.log(`TOTAL       ${passed}/${total} = ${((passed / total) * 100).toFixed(1)}%`);
  if (verbose) console.log(JSON.stringify(report, null, 1));
  process.exit(passed === total ? 0 : 1);
}
