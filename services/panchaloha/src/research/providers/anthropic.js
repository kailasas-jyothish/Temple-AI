// @ts-check
/**
 * Anthropic Claude with the server-side web search and web fetch tools. The
 * search results come back as `web_search_tool_result` blocks and the answer's
 * text blocks cite them, so both are gathered as evidence.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ResearchError } from '../errors.js';
import { collectUrls, MODEL_MISSING, networkError, readKeys, withKeys } from './base.js';

// A long research turn can pause mid-way; each resume is one more request.
const MAX_RESUMES = 4;

/** @param {unknown} err @param {AbortSignal} signal */
function mapError(err, signal) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ResearchError('invalid_api_key', err.message);
  }
  if (err instanceof Anthropic.NotFoundError) return new ResearchError('model_unavailable', err.message);
  if (err instanceof Anthropic.RateLimitError) return new ResearchError('rate_limited', err.message);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ResearchError('timeout', err.message);
  if (err instanceof Anthropic.InternalServerError) return new ResearchError('provider_unavailable', err.message);
  if (err instanceof Anthropic.BadRequestError) {
    if (MODEL_MISSING.test(err.message)) return new ResearchError('model_unavailable', err.message);
    return /web_search|web_fetch|tool/i.test(err.message)
      ? new ResearchError('web_search_unavailable', err.message)
      : new ResearchError('provider_unavailable', err.message);
  }
  if (err instanceof Anthropic.APIError) return new ResearchError('provider_unavailable', err.message);
  return networkError(err, signal);
}

// The dynamic-filtering tool versions and adaptive thinking exist from the
// 4.6 generation on; older models (Haiku 4.5, Sonnet 4.5, …) reject both and
// take the basic tool versions without thinking.
const CURRENT_GENERATION = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/;
// The server-side refusal fallback is documented for these models only.
const FALLBACK_MODELS = /^claude-(opus-5$|fable-5-1|mythos-5-1)/;

/** @param {string} model */
export function requestShape(model) {
  const current = CURRENT_GENERATION.test(model);
  return {
    ...(current ? { thinking: { type: 'adaptive' } } : {}),
    ...(FALLBACK_MODELS.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    tools: current
      ? [
          { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
        ]
      : [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 12 },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 6 },
        ],
  };
}

/** @param {Record<string, string | undefined>} env @returns {import('./base.js').LLMProvider} */
export function anthropicProvider(env) {
  const keys = readKeys(env, 'ANTHROPIC');
  const defaultModel = env.ANTHROPIC_RESEARCH_MODEL || 'claude-opus-5';
  return {
    id: 'anthropic',
    label: 'Anthropic Claude',
    model: defaultModel,
    configured: () => keys.length > 0,

    // Every Claude model on the Models API can use web search in one of its versions.
    listModels: (signal) =>
      withKeys(keys, async (apiKey) => {
        const client = new Anthropic({ apiKey });
        /** @type {import('./base.js').ModelInfo[]} */
        const out = [];
        try {
          for await (const m of client.models.list({ limit: 100 }, { signal })) {
            out.push({ id: m.id, label: m.display_name });
          }
        } catch (err) {
          throw mapError(err, signal);
        }
        return out;
      }),

    search: ({ system, user, model, signal }) =>
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
                system,
                messages,
                ...requestShape(model),
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
