// @ts-check
// The CLI runs the same core.js as the web UI, locally, with output in DATA_DIR/out.
import readline from 'node:readline/promises';
import { config, problems } from './config.js';
import { compare, csvPath, extract, getCatalog, listTexts, translate } from './core.js';
import { listModels } from './translate.js';

const HELP = `Scriptures: sanskritdocuments.org Upanishads -> Devanagari + IAST + translation CSV

  scriptures                       interactive menu
  scriptures catalog [word]        list the Upanishads on the site (filter by word)
  scriptures list                  texts already extracted, with progress
  scriptures extract <id..|all> [--refresh]
  scriptures translate <id> --model <openrouter id> [--limit N] [--force] [--prompt sph-v1]
  scriptures compare <id> --models a,b,c [--limit 5] [--prompt sph-v1]
  scriptures models [word]         OpenRouter models with prices (USD per million tokens)

Output: ${csvPath('<id>')}`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const pos = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const log = (/** @type {string} */ line) => console.log(line);
/** @param {number} done @param {number} total @param {string} detail */
const progress = (done, total, detail) => {
  if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${total} ${detail}`.padEnd(70).slice(0, 78) + '\r');
};

async function cmdCatalog(word = '') {
  const [catalog, texts] = await Promise.all([getCatalog(), listTexts()]);
  const done = new Set(texts.map((t) => t.id));
  const w = word.toLowerCase();
  const rows = catalog.filter((e) => !w || `${e.id} ${e.title} ${e.english}`.toLowerCase().includes(w));
  for (const e of rows) {
    const tags = [e.commentary && 'commentary', e.accented && 'accented', done.has(e.id) && 'extracted'].filter(Boolean).join(', ');
    console.log(`${e.id.padEnd(28)} ${e.title}${tags ? `  [${tags}]` : ''}`);
  }
  console.log(`\n${rows.length} of ${catalog.length} texts`);
}

async function cmdList() {
  const texts = await listTexts();
  if (!texts.length) return console.log('Nothing extracted yet. Try: scriptures extract iisha');
  for (const t of texts) {
    const check = t.checked ? `check ${t.checkOk}/${t.checked}` : 'not checked';
    console.log(`${t.id.padEnd(28)} ${String(t.rows).padStart(5)} rows  ${String(t.translated).padStart(5)}/${t.translatable} translated  ${check}  ${t.title}`);
  }
}

/** @param {string[]} ids @param {boolean} refresh */
async function cmdExtract(ids, refresh) {
  if (ids.includes('all')) ids = (await getCatalog()).map((e) => e.id);
  if (!ids.length) throw new Error('give one or more text ids, or "all"');
  let failed = 0;
  for (const id of ids) {
    try {
      await extract(id, { refresh, log });
    } catch (err) {
      failed++;
      console.log(`${id}: FAILED ${/** @type {Error} */ (err).message}`);
    }
  }
  if (ids.length === 1 && !failed) console.log(`CSV: ${csvPath(ids[0])}`);
  if (failed) process.exitCode = 1;
}

/** @param {AbortSignal} signal */
function interruptible(signal) {
  return { log, progress, signal };
}

async function cmdModels(word = '') {
  const w = word.toLowerCase();
  const models = (await listModels()).filter((m) => !w || m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w));
  const price = (/** @type {number | null} */ p) => (p == null ? '?' : `$${p.toFixed(2)}`);
  for (const m of models) console.log(`${m.id.padEnd(52)} in ${price(m.promptPrice).padStart(7)}  out ${price(m.completionPrice).padStart(7)}`);
  console.log(`\n${models.length} models`);
}

/** Ctrl+C stops a translation cleanly: finished passages are saved, nothing is half-written. */
function abortOnSigint() {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nStopping after the current passage (Ctrl+C again to kill)...');
    controller.abort(new Error('cancelled'));
    process.once('SIGINT', () => process.exit(130));
  });
  return controller.signal;
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (/** @type {string} */ q, def = '') => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
  try {
    for (const p of problems()) console.log(`note: ${p}`);
    for (;;) {
      console.log('\n1) Find a text   2) Extract   3) Translate   4) Compare models   5) Extracted texts   6) Models   q) Quit');
      const c = (await ask('Choose')).toLowerCase();
      if (c === 'q' || c === '') return;
      if (c === '1') await cmdCatalog(await ask('Word to search for (blank = all)'));
      else if (c === '2') await cmdExtract((await ask('Text id(s), space separated, or "all"')).split(/\s+/).filter(Boolean), (await ask('Re-download from the site? y/n', 'n')) === 'y');
      else if (c === '3') {
        const id = await ask('Text id');
        const model = await ask('OpenRouter model id', config.translationModel);
        const limit = Number(await ask('How many passages (0 = all)', '0')) || 0;
        const r = await translate(id, { ...interruptible(abortOnSigint()), model, limit });
        console.log(`\nDone: ${r.translated} translated, ${r.failed} failed, $${r.cost.toFixed(4)}. CSV: ${csvPath(id)}`);
      } else if (c === '4') {
        const id = await ask('Text id');
        const models = (await ask('Model ids, comma separated')).split(',').map((s) => s.trim()).filter(Boolean);
        const limit = Number(await ask('Passages', '5')) || 5;
        const r = await compare(id, models, { ...interruptible(abortOnSigint()), limit });
        console.log(`\nWritten: ${r.file}`);
      } else if (c === '5') await cmdList();
      else if (c === '6') await cmdModels(await ask('Filter (blank = all)'));
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (flags.help || cmd === 'help') return console.log(HELP);
  switch (cmd) {
    case undefined:
      return menu();
    case 'catalog':
      return cmdCatalog(rest[0]);
    case 'list':
    case 'status':
      return cmdList();
    case 'extract':
      return cmdExtract(rest, Boolean(flags.refresh));
    case 'translate': {
      if (!rest[0]) throw new Error('usage: scriptures translate <id> --model <id>');
      const r = await translate(rest[0], {
        ...interruptible(abortOnSigint()),
        model: typeof flags.model === 'string' ? flags.model : undefined,
        limit: Number(flags.limit) || 0,
        force: Boolean(flags.force),
        prompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
      });
      console.log(`\nDone: ${r.translated} translated, ${r.failed} failed, ${r.remaining} left, $${r.cost.toFixed(4)}. CSV: ${csvPath(rest[0])}`);
      return;
    }
    case 'compare': {
      if (!rest[0] || typeof flags.models !== 'string') throw new Error('usage: scriptures compare <id> --models a,b');
      const r = await compare(rest[0], flags.models.split(',').map((s) => s.trim()).filter(Boolean), {
        ...interruptible(abortOnSigint()),
        limit: Number(flags.limit) || 5,
        prompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
      });
      console.log(`\nWritten: ${r.file}`);
      for (const [m, c] of Object.entries(r.costs)) console.log(`  ${m}: $${c.toFixed(4)}`);
      return;
    }
    case 'models':
      return cmdModels(rest[0]);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message || err}`);
  process.exitCode = 1;
});
