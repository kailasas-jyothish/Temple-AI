// @ts-check
import { DEFAULT_MARKET_ID, findMarket } from './catalog.js';

const env = process.env;

const PROVIDER_IDS = ['groq', 'gemini', 'openai', 'anthropic'];

export const config = {
  port: Number(env.PORT || 3100),
  // Basic-auth password for the whole app. Empty means open, which is right on
  // localhost and wrong anywhere public: /api/research spends paid API credit.
  uiPassword: env.UI_PASSWORD || '',
  defaultProvider: PROVIDER_IDS.includes(String(env.RESEARCH_DEFAULT_PROVIDER)) ? String(env.RESEARCH_DEFAULT_PROVIDER) : '',
  defaultMarket: findMarket(String(env.RESEARCH_DEFAULT_MARKET)) ? String(env.RESEARCH_DEFAULT_MARKET) : DEFAULT_MARKET_ID,
  // Web-searching models take minutes, not seconds, on five materials.
  researchTimeoutMs: Math.max(30, Number(env.RESEARCH_TIMEOUT_SECONDS) || 240) * 1000,
  env: /** @type {Record<string, string | undefined>} */ (env),
};
