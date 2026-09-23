// @ts-check
/**
 * OpenAI through the Responses API and its hosted `web_search` tool. Chat
 * Completions has no general search tool, which is why this is not the same
 * request shape as Groq's. Evidence is the search call's own source list plus
 * the `url_citation` annotations on the answer.
 */
import { collectUrls, getJson, postJson, readKeys, withKeys } from './base.js';

const BASE = 'https://api.openai.com/v1';

// The general text families the hosted web_search tool accepts. Audio,
// realtime, image, TTS, transcription and embedding models do not.
const TEXT_FAMILY = /^(gpt-5|gpt-4\.1|gpt-4o|o3|o4)/;
const NOT_TEXT = /(audio|realtime|image|tts|transcribe|embedding|moderation|search-preview|codex|instruct)/;

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function openaiProvider(env) {
  const keys = readKeys(env, 'OPENAI');
  const defaultModel = env.OPENAI_RESEARCH_MODEL || 'gpt-5';
  return {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    model: defaultModel,
    configured: () => keys.length > 0,

    listModels: (signal) =>
      withKeys(keys, async (key) => {
        const body = await getJson(`${BASE}/models`, { headers: { authorization: `Bearer ${key}` }, signal });
        return (body?.data || [])
          .map((/** @type {any} */ m) => ({ id: String(m.id || '') }))
          .filter((/** @type {{ id: string }} */ m) => TEXT_FAMILY.test(m.id) && !NOT_TEXT.test(m.id))
          .sort((/** @type {{ id: string }} */ a, /** @type {{ id: string }} */ b) => b.id.localeCompare(a.id));
      }),

    search: ({ system, user, model, signal }) =>
      withKeys(keys, async (key) => {
        const body = await postJson(
          `${BASE}/responses`,
          {
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              instructions: system,
              input: user,
              tools: [{ type: 'web_search' }],
              include: ['web_search_call.action.sources'],
            }),
            signal,
          },
          /web_search|tool/i,
        );
        const output = Array.isArray(body?.output) ? body.output : [];
        const text = output
          .filter((/** @type {any} */ item) => item.type === 'message')
          .flatMap((/** @type {any} */ item) => item.content || [])
          .filter((/** @type {any} */ c) => c.type === 'output_text')
          .map((/** @type {any} */ c) => c.text)
          .join('');
        return { text, evidence: collectUrls(output), model: String(body?.model || model) };
      }),
  };
}
