// @ts-check
/**
 * Rate research: web search -> sources -> model extraction -> validation ->
 * a list a person reviews. The pipeline is the same for every provider; each
 * provider only supplies the search-capable model call.
 */
import { findMarket } from '../catalog.js';
import { ResearchError } from './errors.js';
import { buildPrompt } from './prompt.js';
import { extractJson, validateResearch } from './validate.js';
import { anthropicProvider } from './providers/anthropic.js';
import { geminiProvider } from './providers/gemini.js';
import { groqProvider } from './providers/groq.js';
import { openaiProvider } from './providers/openai.js';

export { ResearchError } from './errors.js';

/** Order is the UI's order and the fallback order for the default provider. */
const FACTORIES = [groqProvider, geminiProvider, openaiProvider, anthropicProvider];

const MODEL_ID = /^[A-Za-z0-9][\w.\-/:@]{0,127}$/;
const MODEL_CACHE_MS = 10 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ timeoutMs: number }} opts
 */
export function createResearch(env, { timeoutMs }) {
  const providers = FACTORIES.map((make) => make(env));
  let running = false;
  /** @type {Map<string, { at: number, models: import('./providers/base.js').ModelInfo[] }>} */
  const modelCache = new Map();

  return {
    providers,

    /** Safe to show a browser: which providers exist and whether a key is set. Never the keys. */
    describe() {
      return providers.map((p) => ({ id: p.id, label: p.label, model: p.model, configured: p.configured() }));
    },

    /**
     * Models the provider says this key can use for searching. Cached briefly:
     * the list changes on the provider's schedule, not per click.
     * @param {string} providerId
     * @returns {Promise<{ models: import('./providers/base.js').ModelInfo[], default: string }>}
     */
    async listModels(providerId) {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) throw new ResearchError('unsupported_provider', String(providerId));
      if (!provider.configured()) throw new ResearchError('no_api_key', provider.label);
      const cached = modelCache.get(provider.id);
      if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return { models: cached.models, default: provider.model };
      const models = await provider.listModels(AbortSignal.timeout(20_000));
      modelCache.set(provider.id, { at: Date.now(), models });
      return { models, default: provider.model };
    },

    /**
     * @param {{ provider: string, market: string, model?: string }} req
     * @returns {Promise<import('./validate.js').RateResearchResult>}
     */
    async research({ provider: providerId, market: marketId, model: requested }) {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) throw new ResearchError('unsupported_provider', String(providerId));
      const market = findMarket(marketId);
      if (!market) throw new ResearchError('bad_request', `unknown market "${marketId}"`);
      if (!provider.configured()) throw new ResearchError('no_api_key', `${provider.label}`);
      // Any id is allowed, not only listed ones — the list can lag a new
      // release — but it goes into a URL path for Gemini, so shape-check it.
      const model = requested ? String(requested).trim() : provider.model;
      if (!MODEL_ID.test(model)) throw new ResearchError('bad_request', `"${model}" is not a model id`);
      // One search at a time: each is a paid, multi-minute call, and a double
      // click should not be two of them.
      if (running) throw new ResearchError('busy');
      running = true;
      const now = new Date();
      try {
        const { system, user } = buildPrompt(market, now);
        const result = await provider.search({ system, user, model, signal: AbortSignal.timeout(timeoutMs) });
        if (!result.evidence.length) {
          throw new ResearchError('web_search_unavailable', `${provider.label} ${model} answered without returning any web search results`);
        }
        const parsed = extractJson(result.text);
        if (!parsed) throw new ResearchError('invalid_response', 'no JSON object found in the answer');
        return validateResearch(parsed, { market, evidence: result.evidence, provider: provider.id, model: result.model, now });
      } finally {
        running = false;
      }
    },
  };
}
