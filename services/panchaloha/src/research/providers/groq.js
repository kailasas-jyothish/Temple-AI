// @ts-check
/**
 * Groq. Most Groq chat models cannot browse. Two families can, both reporting
 * every search in `message.executed_tools`, which is where the evidence comes
 * from: the `openai/gpt-oss-*` models with the built-in `browser_search` tool,
 * and the `groq/compound` systems, which search on their own. This project's
 * Groq organisations are not given `groq/compound` (it answers
 * model_not_found), so gpt-oss is the default.
 */
import { collectUrls, getJson, postJson, readKeys, withKeys } from './base.js';

const BASE = 'https://api.groq.com/openai/v1';
const SEARCH_CAPABLE = /^(openai\/gpt-oss|groq\/compound)/;

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function groqProvider(env) {
  const keys = readKeys(env, 'GROQ');
  const defaultModel = env.GROQ_RESEARCH_MODEL || 'openai/gpt-oss-120b';
  return {
    id: 'groq',
    label: 'Groq',
    model: defaultModel,
    configured: () => keys.length > 0,

    // Only the families above can search, so only they are offered; anything
    // else would fail as "web research unavailable" after the user picked it.
    // Keys are merged because each organisation may see different models.
    listModels: async (signal) => {
      const seen = new Map();
      /** @type {unknown} */
      let lastError;
      for (const key of keys) {
        try {
          const body = await getJson(`${BASE}/models`, { headers: { authorization: `Bearer ${key}` }, signal });
          for (const m of body?.data || []) {
            if (typeof m?.id === 'string' && SEARCH_CAPABLE.test(m.id) && !/safeguard/.test(m.id)) seen.set(m.id, { id: m.id });
          }
        } catch (err) {
          lastError = err;
        }
      }
      if (!seen.size && lastError) throw lastError;
      return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    search: ({ system, user, model, signal }) =>
      withKeys(keys, async (key) => {
        const body = await postJson(
          `${BASE}/chat/completions`,
          {
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              temperature: 0,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              tools: model.startsWith('groq/compound') ? undefined : [{ type: 'browser_search' }],
            }),
            signal,
          },
          /tool|search|compound/i,
        );
        const message = body?.choices?.[0]?.message || {};
        return {
          text: String(message.content || ''),
          evidence: collectUrls(message.executed_tools || []),
          model: String(body?.model || model),
        };
      }),
  };
}
