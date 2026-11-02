// @ts-check
// OpenRouter is the only model provider: one key reaches every model the user
// wants to test, and the model is a per-run choice, not a code change.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const API = 'https://openrouter.ai/api/v1';

/**
 * @typedef {{ name: string, text: string, hash: string }} Prompt
 * @typedef {{ ref: string, kind: string, devanagari: string, iast: string, translation?: string }} ContextVerse
 * @typedef {{
 *   model: string,
 *   prompt: Prompt,
 *   title: string,
 *   section: string,
 *   unit: { ref: string, kind: string, devanagari: string, iast: string },
 *   context: ContextVerse[],
 *   signal?: AbortSignal,
 * }} TranslateRequest
 * @typedef {{ translation: string, notes: string, cost: number, cached: boolean, model: string }} TranslateResult
 */

/** @param {string} name */
export async function loadPrompt(name = config.promptName) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad prompt name: ${name}`);
  const text = await fs.readFile(path.join(config.promptsDir, `${name}.md`), 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  return { name, text, hash };
}

/** @param {TranslateRequest} req */
export function buildMessages(req) {
  const lines = [`Text: ${req.title}`];
  if (req.section) lines.push(`Section: ${req.section}`);
  if (req.context.length) {
    lines.push('', 'Preceding passages, for continuity only (do not translate these again):');
    for (const c of req.context) {
      lines.push(`[${c.ref || c.kind}] ${c.devanagari}`, `IAST: ${c.iast}`);
      if (c.translation) lines.push(`Translation: ${c.translation}`);
    }
  }
  lines.push(
    '',
    `Translate this ${req.unit.kind}${req.unit.ref ? ` (${req.unit.ref})` : ''}:`,
    req.unit.devanagari,
    `IAST: ${req.unit.iast}`,
    '',
    'Answer with JSON only: {"translation": "...", "notes": "..."}',
  );
  return [
    { role: 'system', content: req.prompt.text },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * Models wrap JSON in prose or code fences often enough that strict parsing
 * would fail good answers. Scans forward only, so it always terminates.
 * @param {string} text
 * @returns {{ translation: string, notes: string } | null}
 */
export function parseAnswer(text) {
  const s = text.replace(/```(?:json)?/gi, '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    for (let end = s.lastIndexOf('}'); end > start; end = s.lastIndexOf('}', end - 1)) {
      try {
        const v = JSON.parse(s.slice(start, end + 1));
        if (v && typeof v.translation === 'string' && v.translation.trim()) {
          return { translation: v.translation.trim(), notes: typeof v.notes === 'string' ? v.notes.trim() : '' };
        }
      } catch {}
    }
  }
  return null;
}

/** @param {TranslateRequest} req */
function cacheKey(req) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([req.model, req.prompt.hash, req.unit.devanagari, req.unit.iast, config.temperature]))
    .digest('hex');
}
const cacheFile = (/** @type {string} */ key) => path.join(config.dataDir, 'translations', `${key}.json`);

/** @param {number} ms @param {AbortSignal} [signal] */
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export class TranslateError extends Error {
  /** @param {string} message @param {{ status?: number, retryable?: boolean }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.status = info.status;
    this.retryable = Boolean(info.retryable);
  }
}

/**
 * One passage, cached by (model, prompt version, text): re-running a job, or
 * a crash halfway through Chandogya, never pays twice for the same verse.
 * @param {TranslateRequest} req
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<TranslateResult>}
 */
export async function translateUnit(req, deps = {}) {
  if (!config.openrouterKey) throw new TranslateError('OPENROUTER_API_KEY is not set');
  if (!req.model) throw new TranslateError('no translation model chosen');
  const key = cacheKey(req);
  try {
    const hit = JSON.parse(await fs.readFile(cacheFile(key), 'utf8'));
    return { translation: hit.translation, notes: hit.notes || '', cost: 0, cached: true, model: hit.model || req.model };
  } catch {}

  const doFetch = deps.fetchImpl || fetch;
  const body = JSON.stringify({
    model: req.model,
    messages: buildMessages(req),
    temperature: config.temperature,
    usage: { include: true },
  });
  let lastError = /** @type {TranslateError | null} */ (null);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(lastError?.status === 429 ? 15_000 * attempt : 3000 * attempt, req.signal);
    let res;
    try {
      const timeout = AbortSignal.timeout(config.requestTimeoutMs);
      res = await doFetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.openrouterKey}`,
          'content-type': 'application/json',
          'x-title': config.appTitle,
        },
        body,
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      lastError = new TranslateError(`network: ${/** @type {Error} */ (err).message}`, { retryable: true });
      continue;
    }
    const text = await res.text();
    /** @type {any} */
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok || data?.error) {
      const message = data?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
      const status = data?.error?.code && Number(data.error.code) ? Number(data.error.code) : res.status;
      lastError = new TranslateError(`${req.model}: ${message}`, { status, retryable: status === 429 || status >= 500 });
      if (!lastError.retryable) throw lastError;
      continue;
    }
    const content = data?.choices?.[0]?.message?.content;
    const answer = typeof content === 'string' ? parseAnswer(content) : null;
    if (!answer) {
      // A malformed answer is worth one more try; models are not deterministic.
      lastError = new TranslateError(`${req.model}: answer was not the requested JSON: ${String(content).slice(0, 200)}`, {
        retryable: true,
      });
      continue;
    }
    const result = { ...answer, cost: Number(data?.usage?.cost) || 0, cached: false, model: data?.model || req.model };
    await fs.mkdir(path.dirname(cacheFile(key)), { recursive: true });
    await fs.writeFile(
      cacheFile(key),
      JSON.stringify({ ...answer, model: result.model, prompt: req.prompt.name, promptHash: req.prompt.hash, at: new Date().toISOString() }),
    );
    return result;
  }
  throw lastError || new TranslateError('translation failed');
}

/** @typedef {{ id: string, name: string, contextLength: number | null, promptPrice: number | null, completionPrice: number | null }} ModelInfo */
/** @type {{ at: number, models: ModelInfo[] } | null} */
let modelCache = null;

/**
 * Every text model OpenRouter offers, sorted by id.
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<ModelInfo[]>}
 */
export async function listModels(deps = {}) {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  const res = await (deps.fetchImpl || fetch)(`${API}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter model list: HTTP ${res.status}`);
  const data = /** @type {any} */ (await res.json());
  const models = (data.data || [])
    .filter((/** @type {any} */ m) => (m.architecture?.output_modalities || ['text']).includes('text'))
    .map((/** @type {any} */ m) => ({
      id: m.id,
      name: m.name || m.id,
      contextLength: m.context_length || null,
      // USD per million tokens, the unit people compare prices in.
      promptPrice: m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : null,
      completionPrice: m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : null,
    }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), models };
  return models;
}
