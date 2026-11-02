// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { parseCatalog } from './catalog.js';

// sanskritdocuments.org is run by volunteers. Requests go one at a time with a
// pause between them, and every file is kept forever once fetched, so a full
// corpus run touches the site once and every later run touches it not at all.

let lastFetch = 0;
/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
function politeFetch(url) {
  const run = async () => {
    const wait = lastFetch + config.fetchDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    let lastError = /** @type {unknown} */ (null);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'TempleAI-scriptures/1.0 (study texts; one request at a time)' },
          signal: AbortSignal.timeout(60_000),
        });
        lastFetch = Date.now();
        if (res.status === 404) throw Object.assign(new Error(`not found: ${url}`), { permanent: true });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        lastFetch = Date.now();
        lastError = err;
        if (/** @type {{permanent?: boolean}} */ (err).permanent) break;
        await sleep(2000 * (attempt + 1));
      }
    }
    throw lastError;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const sourcesDir = () => path.join(config.dataDir, 'sources');

/**
 * A file from the catalog directory, from cache unless `refresh`.
 * @param {string} name e.g. "iisha.itx"
 * @param {{ refresh?: boolean }} [opts]
 */
export async function getSource(name, opts = {}) {
  if (!/^[\w.\-~]+$/.test(name)) throw new Error(`bad source name: ${name}`);
  const file = path.join(sourcesDir(), name);
  if (!opts.refresh) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {}
  }
  const text = await politeFetch(`${config.sourceBase}${config.catalogPath}${encodeURIComponent(name)}`);
  await fs.mkdir(sourcesDir(), { recursive: true });
  await fs.writeFile(file + '.tmp', text);
  await fs.rename(file + '.tmp', file);
  return text;
}

/** @param {{ refresh?: boolean }} [opts] */
export async function getCatalog(opts = {}) {
  const file = path.join(config.dataDir, 'catalog.json');
  if (!opts.refresh) {
    try {
      return /** @type {import('./catalog.js').CatalogEntry[]} */ (JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {}
  }
  const html = await getSource('index.html', opts);
  const entries = parseCatalog(html, config.catalogPath);
  if (!entries.length) throw new Error('the catalog page listed no texts; has the site layout changed?');
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(entries, null, 1));
  return entries;
}
