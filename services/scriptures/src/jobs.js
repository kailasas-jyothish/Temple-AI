// @ts-check
// One job at a time, in process. Extraction is polite to a volunteer site and
// translation spends money, so neither should ever run twice in parallel.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { compare, extract, translate } from './core.js';

/**
 * @typedef {'extract' | 'translate' | 'compare'} JobType
 * @typedef {{
 *   id: string,
 *   type: JobType,
 *   args: { ids?: string[], id?: string, model?: string, models?: string[], limit?: number, force?: boolean, refresh?: boolean, prompt?: string },
 *   status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
 *   progress: { done: number, total: number, detail: string },
 *   log: string[],
 *   createdAt: string,
 *   startedAt?: string,
 *   finishedAt?: string,
 *   result?: unknown,
 *   error?: string,
 * }} Job
 */

const file = () => path.join(config.dataDir, 'jobs.json');
/** @type {Job[]} */
let jobs = [];
/** @type {Map<string, AbortController>} */
const controllers = new Map();
let running = false;
let dirty = false;

export async function loadJobs() {
  try {
    jobs = JSON.parse(await fs.readFile(file(), 'utf8'));
  } catch {
    jobs = [];
  }
  for (const j of jobs) {
    if (j.status === 'running' || j.status === 'queued') {
      j.status = 'failed';
      j.error = 'interrupted by a restart; run it again (finished passages are kept)';
      j.finishedAt = new Date().toISOString();
    }
  }
  await save();
  setInterval(() => dirty && save().catch(() => {}), 10_000).unref();
}

async function save() {
  dirty = false;
  await fs.mkdir(config.dataDir, { recursive: true });
  const keep = jobs.slice(-200);
  await fs.writeFile(file() + '.tmp', JSON.stringify(keep, null, 1));
  await fs.rename(file() + '.tmp', file());
}

export const listJobs = () => [...jobs].reverse();
export const getJob = (/** @type {string} */ id) => jobs.find((j) => j.id === id);
export const busy = () => running;
export const queued = () => jobs.filter((j) => j.status === 'queued').length;

/** @param {JobType} type @param {Job['args']} args */
export function enqueue(type, args) {
  /** @type {Job} */
  const job = {
    id: Math.random().toString(36).slice(2, 10),
    type,
    args,
    status: 'queued',
    progress: { done: 0, total: 0, detail: '' },
    log: [],
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  dirty = true;
  queueMicrotask(pump);
  return job;
}

/** @param {string} id */
export function cancel(id) {
  const job = getJob(id);
  if (!job) return false;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    dirty = true;
    return true;
  }
  const c = controllers.get(id);
  if (c) c.abort(new Error('cancelled'));
  return Boolean(c);
}

async function pump() {
  if (running) return;
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return;
  running = true;
  const controller = new AbortController();
  controllers.set(job.id, controller);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  const log = (/** @type {string} */ line) => {
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
    dirty = true;
    console.log(`[job ${job.id}] ${line}`);
  };
  const progress = (/** @type {number} */ done, /** @type {number} */ total, /** @type {string} */ detail) => {
    job.progress = { done, total, detail };
    dirty = true;
  };
  // A long translation run must never be mistaken for a dead one.
  const watchdog = setInterval(() => {
    const mins = Math.round((Date.now() - Date.parse(/** @type {string} */ (job.startedAt))) / 60_000);
    log(`still ${job.type === 'extract' ? 'extracting' : 'translating'} after ${mins}m: ${job.progress.done}/${job.progress.total} ${job.progress.detail} (slow, not stuck)`);
  }, 3 * 60_000);

  /** @type {Job['status']} */
  let status = 'done';
  try {
    const opts = { log, progress, signal: controller.signal };
    if (job.type === 'extract') {
      const ids = job.args.ids || [];
      const results = [];
      for (const [i, id] of ids.entries()) {
        if (controller.signal.aborted) break;
        progress(i, ids.length, id);
        try {
          const doc = await extract(id, { refresh: job.args.refresh, log });
          results.push({ id, rows: doc.units.length, ok: doc.verify?.ok ?? null, checked: doc.verify?.checked ?? null });
        } catch (err) {
          log(`${id}: FAILED ${/** @type {Error} */ (err).message}`);
          results.push({ id, error: /** @type {Error} */ (err).message });
        }
      }
      progress(ids.length, ids.length, 'done');
      job.result = results;
    } else if (job.type === 'translate') {
      job.result = await translate(/** @type {string} */ (job.args.id), { ...opts, model: job.args.model, limit: job.args.limit, force: job.args.force, prompt: job.args.prompt });
    } else {
      job.result = await compare(/** @type {string} */ (job.args.id), job.args.models || [], { ...opts, limit: job.args.limit, prompt: job.args.prompt });
    }
    if (controller.signal.aborted) status = 'cancelled';
  } catch (err) {
    status = controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = /** @type {Error} */ (err).message || /** @type {Error} */ (err).name;
    log(`FAILED: ${job.error}`);
  } finally {
    clearInterval(watchdog);
    controllers.delete(job.id);
    job.finishedAt = new Date().toISOString();
    // Terminal state last: anything polling stops the moment it reads it.
    job.status = status;
    dirty = true;
    await save().catch(() => {});
    running = false;
    queueMicrotask(pump);
  }
}
