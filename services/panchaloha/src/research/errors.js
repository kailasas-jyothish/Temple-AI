// @ts-check

/**
 * @typedef {'unsupported_provider' | 'no_api_key' | 'invalid_api_key' | 'model_unavailable' | 'rate_limited' | 'timeout'
 *   | 'provider_unavailable' | 'web_search_unavailable' | 'invalid_response' | 'busy' | 'bad_request'} ResearchErrorCode
 */

/** What the person sees for each failure; the provider's own detail is appended. */
export const MESSAGES = {
  unsupported_provider: 'That AI provider is not supported.',
  no_api_key: 'No API key is configured for this provider on the server. Add one to services/panchaloha/.env, or pick another provider.',
  invalid_api_key: 'The provider rejected the API key. Check the key in services/panchaloha/.env.',
  model_unavailable: 'That model is not available to this API key (retired, renamed, or not enabled for the account). Choose another model next to "Get latest rates".',
  rate_limited: 'The provider is rate-limiting or out of quota for this model. Try again later, or choose another model or provider.',
  timeout: 'The provider took too long to answer. Try again, or pick another provider.',
  provider_unavailable: 'The provider is unavailable right now. Try again later or pick another provider.',
  web_search_unavailable: 'Current web research is unavailable for this provider or model. Please enter the rate manually, or select another model or provider.',
  invalid_response: 'The provider answered, but not in the required format, so no rate from it can be trusted. Try again or pick another provider.',
  busy: 'A rate search is already running. Wait for it to finish.',
  bad_request: 'The research request was invalid.',
};

const STATUS = {
  unsupported_provider: 400,
  bad_request: 400,
  no_api_key: 412,
  invalid_api_key: 502,
  model_unavailable: 422,
  rate_limited: 429,
  timeout: 504,
  provider_unavailable: 502,
  web_search_unavailable: 502,
  invalid_response: 502,
  busy: 409,
};

export class ResearchError extends Error {
  /** @param {ResearchErrorCode} code @param {string} [detail] */
  constructor(code, detail) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);
    this.name = 'ResearchError';
    this.code = code;
    this.detail = detail || '';
    this.status = STATUS[code];
  }
}
