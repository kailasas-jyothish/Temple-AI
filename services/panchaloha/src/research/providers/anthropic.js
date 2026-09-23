// @ts-check
/**
 * Anthropic Claude with the server-side web search and web fetch tools. The
 * search results come back as `web_search_tool_result` blocks and the answer's
 * text blocks cite them, so both are gathered as evidence.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ResearchError } from '../errors.js';
import { collectUrls, networkError, readKeys, withKeys } from './base.js';

// A long research turn can pause mid-way; each resume is one more request.
const MAX_RESUMES = 4;

/** @param {unknown} err @param {AbortSignal} signal */
function mapError(err, signal) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ResearchError('invalid_api_key', err.message);
  }
  if (err instanceof Anthropic.RateLimitError) return new ResearchError('rate_limited', err.message);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ResearchError('timeout', err.message);
  if (err instanceof Anthropic.InternalServerError) return new ResearchError('provider_unavailable', err.message);
  if (err instanceof Anthropic.BadRequestError) {
    return /web_search|web_fetch|tool/i.test(err.message)
      ? new ResearchError('web_search_unavailable', err.message)
      : new ResearchError('provider_unavailable', err.message);
  }
  if (err instanceof Anthropic.APIError) return new ResearchError('provider_unavailable', err.message);
  return networkError(err, signal);
}

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function anthropicProvider(env) {
  const keys = readKeys(env, 'ANTHROPIC');
  const model = env.ANTHROPIC_RESEARCH_MODEL || 'claude-opus-5';
  return {
    id: 'anthropic',
    label: 'Anthropic Claude',
    model,
    configured: () => keys.length > 0,
    search: ({ system, user, signal }) =>
      withKeys(keys, async (apiKey) => {
        const client = new Anthropic({ apiKey });
        /** @type {any[]} */
        const messages = [{ role: 'user', content: user }];
        /** @type {any} */
        let response;
        try {
          for (let turn = 0; turn <= MAX_RESUMES; turn++) {
            response = await client.beta.messages.create(
              /** @type {any} */ ({
                model,
                max_tokens: 16000,
                thinking: { type: 'adaptive' },
                // A policy decline is re-run on a fallback model inside the same call.
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
                system,
                tools: [
                  { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
                  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
                ],
                messages,
              }),
              { signal },
            );
            if (response.stop_reason !== 'pause_turn') break;
            messages.push({ role: 'assistant', content: response.content });
          }
        } catch (err) {
          throw mapError(err, signal);
        }
        if (response.stop_reason === 'refusal') {
          throw new ResearchError('provider_unavailable', 'the model declined the request');
        }
        if (response.stop_reason === 'pause_turn') {
          throw new ResearchError('timeout', `research was still running after ${MAX_RESUMES + 1} turns`);
        }
        const text = (response.content || []).filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text).join('');
        // Paused turns ran searches too; their results are evidence as much as the last turn's.
        const content = [...messages.slice(1).flatMap((m) => m.content), ...(response.content || [])];
        // Search/fetch results, plus the citations on the answer's own text.
        // A search error arrives as an object rather than a list and carries no url.
        const evidence = collectUrls(
          content.filter((/** @type {any} */ b) => b.type !== 'text').concat(
            content.filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.citations || []),
          ),
        );
        return { text, evidence, model: String(response.model || model) };
      }),
  };
}
