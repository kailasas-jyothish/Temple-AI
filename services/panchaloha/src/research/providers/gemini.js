// @ts-check
/**
 * Google Gemini with Search grounding. The grounding chunks carry
 * `vertexaisearch…/grounding-api-redirect/…` links rather than the pages
 * themselves, so each is resolved to its real URL (one redirect, no body) —
 * otherwise no URL the model cites could ever be matched to a chunk.
 */
import { postJson, readKeys, withKeys } from './base.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** @param {string} uri @param {AbortSignal} signal */
async function resolveRedirect(uri, signal) {
  if (!/grounding-api-redirect/.test(uri)) return uri;
  try {
    const res = await fetch(uri, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    return res.headers.get('location') || uri;
  } catch {
    return uri;
  }
}

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function geminiProvider(env) {
  const keys = readKeys(env, 'GEMINI');
  const model = env.GEMINI_RESEARCH_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash';
  return {
    id: 'gemini',
    label: 'Google Gemini',
    model,
    configured: () => keys.length > 0,
    search: ({ system, user, signal }) =>
      withKeys(keys, async (key) => {
        const body = await postJson(
          `${BASE}/${encodeURIComponent(model)}:generateContent`,
          {
            headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              tools: [{ google_search: {} }],
              generationConfig: { temperature: 0 },
            }),
            signal,
          },
          /google_search|grounding|tool/i,
        );
        const candidate = body?.candidates?.[0] || {};
        const text = (candidate.content?.parts || []).map((/** @type {any} */ p) => p.text || '').join('');
        const chunks = candidate.groundingMetadata?.groundingChunks || [];
        const evidence = await Promise.all(
          chunks
            .map((/** @type {any} */ c) => c.web)
            .filter((/** @type {any} */ w) => w?.uri)
            .map(async (/** @type {any} */ w) => {
              const url = await resolveRedirect(w.uri, signal);
              // The chunk title is the site's domain; keep it so an unresolved
              // redirect still identifies which site was read.
              return { url, title: w.title, host: w.domain || w.title };
            }),
        );
        return { text, evidence, model: String(body?.modelVersion || model) };
      }),
  };
}
