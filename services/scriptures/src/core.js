// @ts-check
// The one implementation: the CLI, the web UI and the API all call these.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { parseItx } from './parse.js';
import { toDevanagari, toIast } from './itrans.js';
import { verifyUnits } from './verify.js';
import { toCsv } from './csv.js';
import { getCatalog, getSource } from './source.js';
import { loadPrompt, translateUnit } from './translate.js';

/**
 * @typedef {import('./parse.js').Unit & {
 *   translation?: string,
 *   translationNotes?: string,
 *   translationModel?: string,
 *   translationStatus?: '' | 'translated' | 'failed' | 'skipped',
 *   translationError?: string,
 * }} Row
 * @typedef {{
 *   id: string,
 *   title: { english: string, devanagari: string, iast: string, itrans: string },
 *   source: { itx: string, html: string, notice: string },
 *   meta: Record<string, string>,
 *   extractedAt: string,
 *   verify: import('./verify.js').VerifyReport | null,
 *   warnings: string[],
 *   units: Row[],
 * }} TextDoc
 */

export const COLUMNS = [
  'seq',
  'ref',
  'kind',
  'section',
  'verse_no',
  'devanagari',
  'iast',
  'translation',
  'translation_notes',
  'translation_model',
  'translation_status',
  'check',
  'notes',
];

// The site's own terms, printed on every page. Kept in every CSV and JSON so
// the attribution travels with the text.
export const SOURCE_NOTICE =
  'Source: sanskritdocuments.org. Prepared by volunteers for personal study and research; ' +
  'not to be copied or reposted for promotion of any website or individuals or for commercial purpose without permission.';

export const outDir = () => path.join(config.dataDir, 'out');
const jsonPath = (/** @type {string} */ id) => path.join(outDir(), `${id}.json`);
export const csvPath = (/** @type {string} */ id) => path.join(outDir(), `${id}.csv`);

/** @param {string} id */
export function assertId(id) {
  if (!/^[\w.\-~]+$/.test(id)) throw Object.assign(new Error(`not a text id: ${id}`), { status: 400 });
  return id;
}

/** @param {string} id @returns {Promise<TextDoc | null>} */
export async function loadText(id) {
  try {
    return JSON.parse(await fs.readFile(jsonPath(assertId(id)), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {TextDoc} doc */
export function csvRows(doc) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [
    {
      seq: 0,
      kind: 'title',
      section: doc.title.english,
      devanagari: doc.title.devanagari,
      iast: doc.title.iast,
      notes: [doc.source.notice, doc.meta.Credits].filter(Boolean).join(' '),
    },
  ];
  for (const u of doc.units) {
    rows.push({
      seq: u.seq,
      ref: u.ref,
      kind: u.kind,
      section: u.section,
      verse_no: u.verseNo,
      devanagari: u.devanagari,
      iast: u.iast,
      translation: u.translation,
      translation_notes: u.translationNotes,
      translation_model: u.translationModel,
      translation_status: u.translationStatus || (needsTranslation(u) ? 'pending' : ''),
      check: u.check,
      notes: [u.notes, u.translationError].filter(Boolean).join(' | '),
    });
  }
  return rows;
}

/** @param {Row} u */
export function needsTranslation(u) {
  return Boolean(u.devanagari) && u.translationStatus !== 'translated';
}

/** @param {TextDoc} doc */
export async function saveText(doc) {
  await fs.mkdir(outDir(), { recursive: true });
  const j = jsonPath(doc.id);
  await fs.writeFile(j + '.tmp', JSON.stringify(doc, null, 1));
  await fs.rename(j + '.tmp', j);
  const c = csvPath(doc.id);
  await fs.writeFile(c + '.tmp', toCsv(COLUMNS, csvRows(doc)));
  // Excel holds an open CSV locked on Windows; the JSON is the source of
  // truth, so a locked CSV is reported, not fatal.
  try {
    await fs.rename(c + '.tmp', c);
  } catch (err) {
    await fs.rm(c + '.tmp', { force: true });
    throw Object.assign(new Error(`saved ${doc.id}.json but could not replace ${doc.id}.csv (is it open in Excel?)`), {
      cause: err,
    });
  }
}

/**
 * Re-extraction must never lose paid-for translations: they are carried over
 * by matching Devanagari, which survives renumbering and parser changes.
 * @param {Row[]} units
 * @param {TextDoc | null} previous
 */
function carryTranslations(units, previous) {
  if (!previous) return 0;
  /** @type {Map<string, Row[]>} */
  const byText = new Map();
  for (const u of previous.units) {
    if (u.translationStatus !== 'translated') continue;
    const list = byText.get(u.devanagari) || [];
    list.push(u);
    byText.set(u.devanagari, list);
  }
  let carried = 0;
  for (const u of units) {
    const old = byText.get(u.devanagari)?.shift();
    if (!old) continue;
    u.translation = old.translation;
    u.translationNotes = old.translationNotes;
    u.translationModel = old.translationModel;
    u.translationStatus = 'translated';
    carried++;
  }
  return carried;
}

/**
 * Fetch (or read from cache), parse, verify against the site's own rendering,
 * and write <id>.json and <id>.csv.
 * @param {string} id
 * @param {{ refresh?: boolean, log?: (line: string) => void }} [opts]
 */
export async function extract(id, opts = {}) {
  assertId(id);
  const log = opts.log || (() => {});
  const itx = await getSource(`${id}.itx`, opts);
  const parsed = parseItx(itx);
  /** @type {Row[]} */
  const units = parsed.units;

  let report = null;
  try {
    const html = await getSource(`${id}.html`, opts);
    report = verifyUnits(units, html);
  } catch (err) {
    log(`${id}: could not check against the site page (${/** @type {Error} */ (err).message})`);
  }
  if (!report) for (const u of units) if (u.devanagari) u.check = 'not checked';

  const catalog = await getCatalog().catch(() => []);
  const entry = catalog.find((e) => e.id === id);
  const titleDeva = entry?.devanagari || toDevanagari(parsed.title.itrans);
  const previous = await loadText(id);
  const carried = carryTranslations(units, previous);

  /** @type {TextDoc} */
  const doc = {
    id,
    title: {
      english: entry?.english || parsed.title.english,
      devanagari: titleDeva,
      iast: toIast(titleDeva),
      itrans: parsed.title.itrans,
    },
    source: {
      itx: `${config.sourceBase}${config.catalogPath}${id}.itx`,
      html: `${config.sourceBase}${config.catalogPath}${id}.html`,
      notice: SOURCE_NOTICE,
    },
    meta: parsed.meta,
    extractedAt: new Date().toISOString(),
    verify: report,
    warnings: parsed.warnings,
    units,
  };
  await saveText(doc);
  const verses = units.filter((u) => u.kind === 'verse').length;
  log(
    `${id}: ${units.length} rows, ${verses} verses` +
      (report
        ? `, site check ${report.ok}/${report.checked} ok, ${(report.coverage * 100).toFixed(1)}% of site text covered`
        : '') +
      (carried ? `, ${carried} translations carried over` : ''),
  );
  return doc;
}

/** Summary of every extracted text, for the UI and `status`. */
export async function listTexts() {
  /** @type {string[]} */
  let names = [];
  try {
    names = (await fs.readdir(outDir())).filter((n) => n.endsWith('.json'));
  } catch {}
  const out = [];
  for (const n of names) {
    const doc = await loadText(n.slice(0, -5));
    if (!doc) continue;
    const translatable = doc.units.filter((u) => u.devanagari);
    out.push({
      id: doc.id,
      title: doc.title.english,
      devanagari: doc.title.devanagari,
      rows: doc.units.length,
      verses: doc.units.filter((u) => u.kind === 'verse').length,
      translated: translatable.filter((u) => u.translationStatus === 'translated').length,
      translatable: translatable.length,
      checkOk: doc.verify ? doc.verify.ok : null,
      checked: doc.verify ? doc.verify.checked : null,
      coverage: doc.verify ? doc.verify.coverage : null,
      extractedAt: doc.extractedAt,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export { getCatalog };

/**
 * @typedef {{
 *   model?: string,
 *   prompt?: string,
 *   limit?: number,
 *   force?: boolean,
 *   maxCostUsd?: number,
 *   log?: (line: string) => void,
 *   progress?: (done: number, total: number, detail: string) => void,
 *   signal?: AbortSignal,
 * }} TranslateOptions
 */

/** @param {Row[]} units @param {number} i @param {(u: Row) => string | undefined} tr */
function contextFor(units, i, tr) {
  /** @type {import('./translate.js').ContextVerse[]} */
  const out = [];
  for (let j = i - 1; j >= 0 && out.length < config.contextVerses; j--) {
    const u = units[j];
    if (!u.devanagari || u.kind === 'heading' || u.kind === 'colophon') continue;
    out.unshift({ ref: u.ref, kind: u.kind, devanagari: u.devanagari, iast: u.iast, translation: tr(u) });
  }
  return out;
}

/** @param {string | undefined} model */
function requireModel(model) {
  const m = model || config.translationModel;
  if (!m) {
    throw Object.assign(
      new Error('No translation model chosen. Pass --model <openrouter id> or set TRANSLATION_MODEL once one is picked.'),
      { status: 400 },
    );
  }
  if (!config.openrouterKey) throw Object.assign(new Error('OPENROUTER_API_KEY is not set'), { status: 400 });
  return m;
}

/**
 * Translate the untranslated rows of one extracted text, in order, so each
 * passage sees the ones before it. Saves as it goes; a stop or a crash keeps
 * everything done so far, and a rerun picks up where it left off.
 * @param {string} id
 * @param {TranslateOptions} [opts]
 */
export async function translate(id, opts = {}) {
  const model = requireModel(opts.model);
  const log = opts.log || (() => {});
  const doc = (await loadText(id)) || (await extract(id, { log }));
  const prompt = await loadPrompt(opts.prompt);
  const budget = opts.maxCostUsd ?? config.maxCostUsd;
  const todo = doc.units
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.devanagari && (opts.force || u.translationStatus !== 'translated'))
    .slice(0, opts.limit && opts.limit > 0 ? opts.limit : undefined);

  log(`${id}: ${todo.length} passages to translate with ${model} (prompt ${prompt.name}, budget $${budget})`);
  let cost = 0;
  let done = 0;
  let failed = 0;
  let lastSave = Date.now();
  for (const { u, i } of todo) {
    if (opts.signal?.aborted) break;
    if (budget > 0 && cost >= budget) {
      log(`${id}: stopped at the $${budget} budget after ${done} passages; run again to continue`);
      break;
    }
    opts.progress?.(done + failed, todo.length, u.ref || u.kind);
    try {
      const r = await translateUnit({
        model,
        prompt,
        title: doc.title.english,
        section: u.section,
        unit: u,
        context: contextFor(doc.units, i, (c) => (c.translationStatus === 'translated' ? c.translation : undefined)),
        signal: opts.signal,
      });
      Object.assign(u, {
        translation: r.translation,
        translationNotes: r.notes,
        translationModel: `${r.model} · ${prompt.name}`,
        translationStatus: 'translated',
        translationError: '',
      });
      cost += r.cost;
      done++;
    } catch (err) {
      if (opts.signal?.aborted) break;
      u.translationStatus = 'failed';
      u.translationError = /** @type {Error} */ (err).message;
      failed++;
      log(`${id} ${u.ref || `#${u.seq}`}: ${u.translationError}`);
      // A key or model problem fails every passage the same way; stop paying for the attempts.
      const status = /** @type {{status?: number}} */ (err).status;
      if (status === 401 || status === 402 || status === 403 || status === 404) {
        await saveText(doc);
        throw err;
      }
    }
    if (Date.now() - lastSave > 10_000) {
      await saveText(doc);
      lastSave = Date.now();
    }
  }
  await saveText(doc);
  opts.progress?.(done + failed, todo.length, 'saved');
  log(`${id}: ${done} translated, ${failed} failed, $${cost.toFixed(4)} spent`);
  return { id, model, translated: done, failed, cost, remaining: todo.length - done - failed };
}

/**
 * The same opening passages translated by several models side by side, for
 * choosing a model. Each model gets its own earlier answers as context, as it
 * would in a real run. Writes out/compare-<id>.csv.
 * @param {string} id
 * @param {string[]} models
 * @param {TranslateOptions} [opts]
 */
export async function compare(id, models, opts = {}) {
  if (!models.length) throw Object.assign(new Error('give at least one model to compare'), { status: 400 });
  for (const m of models) requireModel(m);
  const log = opts.log || (() => {});
  const doc = (await loadText(id)) || (await extract(id, { log }));
  const prompt = await loadPrompt(opts.prompt);
  const picked = doc.units
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.devanagari && u.kind !== 'heading' && u.kind !== 'colophon')
    .slice(0, opts.limit && opts.limit > 0 ? opts.limit : 5);

  /** @type {Record<string, Map<number, string>>} */
  const answers = {};
  /** @type {Record<string, number>} */
  const costs = {};
  const total = picked.length * models.length;
  let step = 0;
  for (const model of models) {
    answers[model] = new Map();
    costs[model] = 0;
    for (const { u, i } of picked) {
      if (opts.signal?.aborted) break;
      opts.progress?.(step++, total, `${model} ${u.ref || u.kind}`);
      try {
        const r = await translateUnit({
          model,
          prompt,
          title: doc.title.english,
          section: u.section,
          unit: u,
          context: contextFor(doc.units, i, (c) => answers[model].get(c.seq)),
          signal: opts.signal,
        });
        answers[model].set(u.seq, r.notes ? `${r.translation}\n\n[notes] ${r.notes}` : r.translation);
        costs[model] += r.cost;
      } catch (err) {
        answers[model].set(u.seq, `ERROR: ${/** @type {Error} */ (err).message}`);
        log(`${model}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }
  const columns = ['seq', 'ref', 'devanagari', 'iast', ...models];
  /** @type {Array<Record<string, unknown>>} */
  const rows = picked.map(({ u }) => ({
    seq: u.seq,
    ref: u.ref || u.kind,
    devanagari: u.devanagari,
    iast: u.iast,
    ...Object.fromEntries(models.map((m) => [m, answers[m].get(u.seq) || ''])),
  }));
  rows.push({
    seq: '',
    ref: 'cost (USD)',
    devanagari: '',
    iast: `prompt ${prompt.name}`,
    ...Object.fromEntries(models.map((m) => [m, costs[m].toFixed(4)])),
  });
  await fs.mkdir(outDir(), { recursive: true });
  const file = path.join(outDir(), `compare-${id}.csv`);
  await fs.writeFile(file, toCsv(columns, rows));
  opts.progress?.(total, total, 'saved');
  log(`compare ${id}: ${picked.length} passages x ${models.length} models -> ${file}`);
  return { id, file, models, costs, passages: picked.length };
}
