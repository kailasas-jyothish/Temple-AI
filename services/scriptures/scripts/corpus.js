// @ts-check
// Extract every text in the catalog (or the ids given) and report how well
// each one agrees with the site's own rendering. This is how parser changes
// are judged: the worst files are listed first.
//   node scripts/corpus.js [id ...] [--refresh]
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { extract, getCatalog } from '../src/core.js';

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const wanted = args.filter((a) => !a.startsWith('--'));
const ids = wanted.length ? wanted : (await getCatalog({ refresh })).map((e) => e.id);

const results = [];
for (const [i, id] of ids.entries()) {
  try {
    const doc = await extract(id, { refresh });
    const v = doc.verify;
    results.push({
      id,
      rows: doc.units.length,
      verses: doc.units.filter((u) => u.kind === 'verse').length,
      ok: v ? v.ok : null,
      checked: v ? v.checked : null,
      coverage: v ? Number(v.coverage.toFixed(4)) : null,
      gaps: v ? v.gaps.slice(0, 5) : [],
      firstBad: doc.units.find((u) => u.check && u.check !== 'ok')?.check || '',
      warnings: doc.warnings.length,
    });
  } catch (err) {
    results.push({ id, error: /** @type {Error} */ (err).message });
  }
  if ((i + 1) % 10 === 0) console.error(`${i + 1}/${ids.length}`);
}

const score = (/** @type {any} */ r) => (r.error ? -1 : r.checked ? (r.ok / r.checked) * Math.min(1, r.coverage + 0.02) : 0);
results.sort((a, b) => score(a) - score(b));
await fs.writeFile(path.join(config.dataDir, 'corpus-report.json'), JSON.stringify(results, null, 1));

const clean = results.filter((r) => !r.error && r.checked && r.ok === r.checked && (r.coverage ?? 0) >= 0.98);
console.log(`${results.length} texts; ${clean.length} fully clean; ${results.filter((r) => r.error).length} errors`);
for (const r of results.slice(0, 40)) {
  if (r.error) console.log(`ERR  ${r.id}: ${r.error}`);
  else if (r !== clean.find((c) => c.id === r.id))
    console.log(`${r.id}: ${r.ok}/${r.checked} ok, coverage ${r.coverage}, verses ${r.verses}  ${r.firstBad.slice(0, 120)}`);
}
