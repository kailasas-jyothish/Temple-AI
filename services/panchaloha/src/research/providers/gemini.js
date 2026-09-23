// @ts-check
/**
 * Google Gemini with Search grounding. The grounding chunks carry
 * `vertexaisearch…/grounding-api-redirect/…` links rather than the pages
 * themselves, so each is resolved to its real URL (one redirect, no body) —
 * otherwise no URL the model cites could ever be matched to a chunk.
 */
import { getJson, postJson, readKeys, withKeys } from './base.js';

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
  const defaultModel = env.GEMINI_RESEARCH_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash';
  return {
    id: 'gemini',
    label: 'Google Gemini',
    model: defaultModel,
    configured: () => keys.length > 0,

    // Every generateContent-capable Gemini text model; audio, image, TTS,
    // embedding and live variants cannot take the search tool.
    listModels: (signal) =>
      withKeys(keys, async (key) => {
        const body = await getJson(`${BASE}?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal });
        return (body?.models || [])
          .filter((/** @type {any} */ m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((/** @type {any} */ m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName }))
          .filter((/** @type {{ id: string }} */ m) => /^gemini-/.test(m.id) && !/(embedding|tts|image|audio|live|native|robotics|computer-use|transcribe|customtools)/i.test(m.id))
          .sort((/** @type {{ id: string }} */ a, /** @type {{ id: string }} */ b) => b.id.localeCompare(a.id));
      }),

    search: ({ system, user, model, signal }) =>
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
