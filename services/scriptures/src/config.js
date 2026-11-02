// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string | undefined} v @param {number} fallback */
const num = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

export const config = {
  port: num(env.PORT, 3400),
  // Basic-auth password for the whole app except /healthz. Translation spends
  // OpenRouter credit, so it must be set anywhere public.
  uiPassword: env.UI_PASSWORD || '',
  dataDir: path.resolve(env.DATA_DIR || path.join(here, '..', 'data')),
  promptsDir: path.join(here, '..', 'prompts'),

  sourceBase: (env.SOURCE_BASE_URL || 'https://sanskritdocuments.org').replace(/\/$/, ''),
  catalogPath: env.SOURCE_CATALOG_PATH || '/doc_upanishhat/',
  // Volunteer-run site: one request at a time with a pause between, and every
  // file is cached forever after the first fetch.
  fetchDelayMs: num(env.FETCH_DELAY_MS, 1000),

  openrouterKey: env.OPENROUTER_API_KEY || '',
  // Deliberately empty by default: the model is chosen after side-by-side
  // tests (`compare`), and translation refuses to start until one is set.
  translationModel: env.TRANSLATION_MODEL || '',
  promptName: env.TRANSLATION_PROMPT || 'sph-v1',
  temperature: num(env.TRANSLATION_TEMPERATURE, 0.2),
  contextVerses: Math.max(0, Math.floor(num(env.TRANSLATION_CONTEXT_VERSES, 2))),
  maxCostUsd: num(env.MAX_COST_USD, 5),
  requestTimeoutMs: Math.max(10, num(env.TRANSLATION_TIMEOUT_SECONDS, 180)) * 1000,
  appTitle: env.OPENROUTER_APP_TITLE || 'Temple AI scriptures',
};

/** Things that stop part of the service working, shown on /healthz and the dashboard. */
export function problems(cfg = config) {
  /** @type {string[]} */
  const out = [];
  if (!cfg.openrouterKey) out.push('OPENROUTER_API_KEY not set: extraction works, translation does not');
  else if (!cfg.translationModel) out.push('TRANSLATION_MODEL not set: pick a model per run, or set it once chosen');
  return out;
}
