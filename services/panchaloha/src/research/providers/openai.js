// @ts-check
/**
 * OpenAI through the Responses API and its hosted `web_search` tool. Chat
 * Completions has no general search tool, which is why this is not the same
 * request shape as Groq's. Evidence is the search call's own source list plus
 * the `url_citation` annotations on the answer.
 */
import { collectUrls, postJson, readKeys, withKeys } from './base.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function openaiProvider(env) {
  const keys = readKeys(env, 'OPENAI');
  const model = env.OPENAI_RESEARCH_MODEL || 'gpt-5';
  return {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    model,
    configured: () => keys.length > 0,
    search: ({ system, user, signal }) =>
      withKeys(keys, async (key) => {
        const body = await postJson(
          ENDPOINT,
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
