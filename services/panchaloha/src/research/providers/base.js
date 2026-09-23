// @ts-check
/**
 * The contract every provider implements, and the key rotation they share.
 *
 * A provider's only job is: run one web-searching model call and hand back the
 * model's text together with the pages its search tool actually returned.
 * That second part is what makes a source checkable — a URL the model cites
 * that is not among those pages is treated as unverified (see validate.js).
 */
import { ResearchError } from '../errors.js';

/**
 * @typedef {object} Evidence
 * @property {string} url
 * @property {string} [title]
 * @property {string} [host] set when the provider only reports the site, not the page
 */

/**
 * @typedef {object} SearchResult
 * @property {string} text the model's final answer
 * @property {Evidence[]} evidence pages the provider's search tool returned
 * @property {string} model
 */

/**
 * @typedef {object} SearchRequest
 * @property {string} system
 * @property {string} user
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} LLMProvider
 * @property {string} id
 * @property {string} label
 * @property {string} model
 * @property {() => boolean} configured
 * @property {(req: SearchRequest) => Promise<SearchResult>} search
 */

/** Comma-separated keys, singular variable unioned in — the reels service's convention. */
export function readKeys(/** @type {Record<string, string | undefined>} */ env, /** @type {string} */ prefix) {
  const keys = [
    ...String(env[`${prefix}_API_KEYS`] || '').split(','),
    String(env[`${prefix}_API_KEY`] || ''),
  ].map((k) => k.trim()).filter(Boolean);
  return [...new Set(keys)];
}

/**
 * Try each key once. A rejected or rate-limited key moves on to the next; any
 * other failure is the provider's answer and is not worth repeating.
 * @template T
 * @param {string[]} keys
 * @param {(key: string) => Promise<T>} attempt
 * @returns {Promise<T>}
 */
export async function withKeys(keys, attempt) {
  if (!keys.length) throw new ResearchError('no_api_key');
  /** @type {unknown} */
  let last;
  for (const key of keys) {
    try {
      return await attempt(key);
    } catch (err) {
      last = err;
      if (err instanceof ResearchError && (err.code === 'invalid_api_key' || err.code === 'rate_limited')) continue;
      throw err;
    }
  }
  throw last;
}

/**
 * Map an HTTP failure onto the error vocabulary. `searchHint` recognises the
 * provider's way of saying the model cannot use its search tool.
 * @param {number} status
 * @param {string} body
 * @param {RegExp} [searchHint]
 */
export function httpError(status, body, searchHint) {
  const detail = `HTTP ${status}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`;
  if (status === 401 || status === 403) return new ResearchError('invalid_api_key', detail);
  if (status === 429) return new ResearchError('rate_limited', detail);
  if (status === 408 || status === 504) return new ResearchError('timeout', detail);
  if (status >= 500) return new ResearchError('provider_unavailable', detail);
  if (searchHint && searchHint.test(body)) return new ResearchError('web_search_unavailable', detail);
  return new ResearchError('provider_unavailable', detail);
}

/**
 * fetch + JSON with the error mapping applied, so each provider only states
 * its request and how to read its response.
 * @param {string} url
 * @param {RequestInit & { signal: AbortSignal }} init
 * @param {RegExp} [searchHint]
 * @returns {Promise<any>}
 */
export async function postJson(url, init, searchHint) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', ...init });
  } catch (err) {
    throw networkError(err, init.signal);
  }
  const text = await res.text();
  if (!res.ok) throw httpError(res.status, text, searchHint);
  try {
    return JSON.parse(text);
  } catch {
    throw new ResearchError('invalid_response', 'provider returned non-JSON');
  }
}

/** @param {unknown} err @param {AbortSignal} signal */
export function networkError(err, signal) {
  if (signal.aborted) return new ResearchError('timeout');
  const message = err instanceof Error ? err.message : String(err);
  return new ResearchError('provider_unavailable', message);
}

/** Collect every http(s) URL-valued `url`/`uri` field anywhere in a JSON value. */
export function collectUrls(/** @type {unknown} */ value, /** @type {Evidence[]} */ out = []) {
  if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out);
  } else if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'url' || k === 'uri') && typeof v === 'string' && /^https?:\/\//i.test(v)) {
        out.push({ url: v, title: typeof obj.title === 'string' ? obj.title : undefined });
      } else if (typeof v === 'string' && (k === 'arguments' || k === 'output') && v.trim().startsWith('{')) {
        try { collectUrls(JSON.parse(v), out); } catch { /* not JSON; nothing to collect */ }
      } else {
        collectUrls(v, out);
      }
    }
  }
  return out;
}
