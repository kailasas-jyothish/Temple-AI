// @ts-check
/**
 * Groq. Most Groq chat models cannot browse. Two families can, both reporting
 * every search in `message.executed_tools`, which is where the evidence comes
 * from: the `openai/gpt-oss-*` models with the built-in `browser_search` tool,
 * and the `groq/compound` systems, which search on their own. This project's
 * Groq organisations are not given `groq/compound` (it answers
 * model_not_found), so gpt-oss is the default.
 */
import { collectUrls, postJson, readKeys, withKeys } from './base.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function groqProvider(env) {
  const keys = readKeys(env, 'GROQ');
  const model = env.GROQ_RESEARCH_MODEL || 'openai/gpt-oss-120b';
  const tools = model.startsWith('groq/compound') ? undefined : [{ type: 'browser_search' }];
  return {
    id: 'groq',
    label: 'Groq',
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
              temperature: 0,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              tools,
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
