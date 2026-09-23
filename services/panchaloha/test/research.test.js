import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createResearch, ResearchError } from '../src/research/index.js';
import { extractJson, kgPerUnit, matchEvidence, validateResearch } from '../src/research/validate.js';
import { findMarket, MATERIALS } from '../src/catalog.js';

const INDIA = findMarket('IN');
const NOW = new Date('2026-09-23T10:00:00Z');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const EVIDENCE = [
  { url: 'https://www.scrapdealer.example/copper-rate-today', title: 'Copper scrap rate' },
  { url: 'https://metals.example/gunmetal', title: 'Gun metal' },
  { url: 'https://metals.example/zinc?utm_source=x', title: 'Zinc' },
  { url: 'https://wax.example/beeswax', title: 'Beeswax' },
  { url: 'https://wax.example/paraffin', title: 'Paraffin' },
];

const row = (material, over = {}) => ({
  material, rate: 800, unit: 'kg', currency: 'INR', rateType: material.includes('wax') ? 'wholesale' : 'scrap',
  rangeLow: null, rangeHigh: null, sourceName: 'Example', sourceUrl: '', sourceDate: '2026-09-20', notes: '', confidence: 'high', ...over,
});

const goodAnswer = () => ({
  market: 'India', currency: 'INR',
  materials: [
    row('copper_scrap', { sourceUrl: 'https://scrapdealer.example/copper-rate-today/', rangeLow: 780, rangeHigh: 820 }),
    row('gun_metal_scrap', { rate: 55000, unit: 'quintal', sourceUrl: 'https://metals.example/gunmetal' }),
    row('zinc_scrap', { rate: 210, sourceUrl: 'https://metals.example/zinc' }),
    row('beeswax_thaenukku', { rate: 650, sourceUrl: 'https://wax.example/beeswax' }),
    row('paraffin_wax', { rate: 120, sourceUrl: 'https://wax.example/paraffin' }),
  ],
});

const ctx = { market: INDIA, evidence: EVIDENCE, provider: 'test', model: 'm', now: NOW };
const byId = (result, id) => result.materials.find((m) => m.material === id);

// ------------------------------------------------------------------ validation

test('a well-evidenced answer verifies all five, separately for both waxes', () => {
  const r = validateResearch(goodAnswer(), ctx);
  assert.equal(r.materials.length, 5);
  for (const m of r.materials) assert.equal(m.status, 'verified', `${m.material}: ${m.problems.join('; ')}`);
  assert.equal(byId(r, 'beeswax_thaenukku').ratePerKg, 650);
  assert.equal(byId(r, 'paraffin_wax').ratePerKg, 120);
  assert.equal(byId(r, 'copper_scrap').rangeLowPerKg, 780);
  assert.equal(byId(r, 'copper_scrap').rangeHighPerKg, 820);
  assert.equal(r.currency, 'INR');
  assert.deepEqual(r.warnings, []);
});

test('units are converted by the server, not the model', () => {
  const r = validateResearch(goodAnswer(), ctx);
  const gm = byId(r, 'gun_metal_scrap');
  assert.equal(gm.ratePerKg, 550);
  assert.match(gm.notes, /Converted from 55000 per quintal/);
  assert.equal(kgPerUnit('per tonne'), '1000');
  assert.equal(kgPerUnit('/kg'), '1');
  assert.equal(kgPerUnit('bucket'), null);
});

test('a futures / commodity price is not accepted as a scrap rate', () => {
  const a = goodAnswer();
  a.materials[0] = row('copper_scrap', { rateType: 'futures', sourceUrl: 'https://scrapdealer.example/copper-rate-today' });
  const m = byId(validateResearch(a, ctx), 'copper_scrap');
  assert.equal(m.status, 'unverified');
  assert.match(m.problems.join(), /not a scrap rate/);
});

test('currency mismatch is rejected', () => {
  const a = goodAnswer();
  a.materials[2] = row('zinc_scrap', { currency: 'USD', rate: 2.6, sourceUrl: 'https://metals.example/zinc' });
  const m = byId(validateResearch(a, ctx), 'zinc_scrap');
  assert.equal(m.status, 'unverified');
  assert.match(m.problems.join(), /Currency mismatch/);
});

test('a rate without a source URL is rejected', () => {
  const a = goodAnswer();
  a.materials[3] = row('beeswax_thaenukku', { sourceUrl: '' });
  const m = byId(validateResearch(a, ctx), 'beeswax_thaenukku');
  assert.equal(m.status, 'unverified');
  assert.match(m.problems.join(), /No source URL/);
});

test('a source URL the search never returned is treated as possibly invented', () => {
  const a = goodAnswer();
  a.materials[4] = row('paraffin_wax', { sourceUrl: 'https://made-up-wax-prices.example/today' });
  const m = byId(validateResearch(a, ctx), 'paraffin_wax');
  assert.equal(m.status, 'unverified');
  assert.match(m.problems.join(), /may be invented/);
});

test('same site, different page: accepted but confidence capped', () => {
  const a = goodAnswer();
  a.materials[1] = row('gun_metal_scrap', { sourceUrl: 'https://metals.example/other-page' });
  const m = byId(validateResearch(a, ctx), 'gun_metal_scrap');
  assert.equal(m.status, 'verified');
  assert.equal(m.evidenceMatch, 'site');
  assert.equal(m.confidence, 'medium');
});

test('"could not verify" (null rate) and a missing material are both unverified, with warnings', () => {
  const a = goodAnswer();
  a.materials[0] = row('copper_scrap', { rate: null, notes: 'Only MCX futures found.' });
  a.materials.pop();
  const r = validateResearch(a, ctx);
  assert.equal(byId(r, 'copper_scrap').status, 'unverified');
  assert.match(byId(r, 'paraffin_wax').problems.join(), /did not return/);
  assert.match(r.warnings.join(), /2 of 5 rates could not be verified/);
});

test('implausible orderings are flagged for a person, not silently accepted', () => {
  const a = goodAnswer();
  a.materials[0] = row('copper_scrap', { rate: 607, sourceUrl: 'https://scrapdealer.example/copper-rate-today' });
  a.materials[1] = row('gun_metal_scrap', { rate: 1095, sourceUrl: 'https://metals.example/gunmetal' });
  a.materials[4] = row('paraffin_wax', { rate: 900, sourceUrl: 'https://wax.example/paraffin' });
  const r = validateResearch(a, ctx);
  assert.equal(byId(r, 'copper_scrap').status, 'verified');
  assert.match(r.warnings.join(), /Gun metal came back dearer than copper/);
  assert.match(r.warnings.join(), /Paraffin wax came back dearer than beeswax/);
});

test('a range that excludes the working rate is dropped, not trusted', () => {
  const a = goodAnswer();
  a.materials[0] = row('copper_scrap', { rate: 900, rangeLow: 700, rangeHigh: 800, sourceUrl: 'https://scrapdealer.example/copper-rate-today' });
  const m = byId(validateResearch(a, ctx), 'copper_scrap');
  assert.equal(m.rangeLowPerKg, null);
  assert.match(m.notes, /range did not contain/);
});

test('undated or stale sources lose "high" confidence', () => {
  const a = goodAnswer();
  a.materials[0] = row('copper_scrap', { sourceDate: '', sourceUrl: 'https://scrapdealer.example/copper-rate-today' });
  a.materials[2] = row('zinc_scrap', { sourceDate: '2026-05-01', sourceUrl: 'https://metals.example/zinc' });
  const r = validateResearch(a, ctx);
  assert.equal(byId(r, 'copper_scrap').confidence, 'medium');
  assert.equal(byId(r, 'zinc_scrap').confidence, 'medium');
  assert.match(byId(r, 'zinc_scrap').notes, /days old/);
});

test('malformed answers are refused', () => {
  assert.throws(() => validateResearch({ nope: true }, ctx), (e) => e instanceof ResearchError && e.code === 'invalid_response');
  assert.throws(() => validateResearch(null, ctx), (e) => e.code === 'invalid_response');
});

test('JSON is extracted from prose and fences, and garbage yields null', () => {
  const obj = goodAnswer();
  assert.deepEqual(extractJson(`Here you go:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``), obj);
  assert.deepEqual(extractJson(`I searched {a few} sites. ${JSON.stringify(obj)}`), obj);
  assert.equal(extractJson('Sorry, I could not find anything.'), null);
  assert.equal(extractJson('{"materials": [ broken'), null);
});

test('URL matching ignores www, trailing slash and tracking params', () => {
  assert.equal(matchEvidence('https://metals.example/zinc', EVIDENCE), 'page');
  assert.equal(matchEvidence('http://scrapdealer.example/copper-rate-today/', EVIDENCE), 'page');
  assert.equal(matchEvidence('https://nowhere.example/', EVIDENCE), 'none');
  assert.equal(matchEvidence('https://x.example/p', [{ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', host: 'x.example' }]), 'site');
});

// ------------------------------------------------------------------ pipeline + providers

const answerText = () => `Research notes...\n${JSON.stringify(goodAnswer())}`;

/** Route fetch by URL substring to a handler returning { status, body }. */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    calls.push({ url: u, init });
    for (const [match, handler] of routes) {
      if (u.includes(match)) {
        const out = await handler(u, init, calls);
        if (out instanceof Response) return out;
        return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {
          status: out.status || 200,
          headers: { 'content-type': 'application/json', ...(out.headers || {}) },
        });
      }
    }
    throw new Error(`unmocked fetch ${u}`);
  };
  return calls;
}

const env = (extra = {}) => ({ GROQ_API_KEYS: 'g1,g2', GEMINI_API_KEYS: 'gm1', OPENAI_API_KEYS: 'o1', ANTHROPIC_API_KEYS: 'a1', ...extra });
const make = (e = env()) => createResearch(e, { timeoutMs: 5000 });

const groqResponse = () => ({
  model: 'groq/compound',
  choices: [{ message: {
    content: answerText(),
    executed_tools: [{ type: 'search', arguments: '{"query":"copper scrap rate"}', search_results: { results: EVIDENCE.map((e) => ({ title: e.title, url: e.url, score: 0.9 })) } }],
  } }],
});

test('describe() reports configured providers and never the keys', () => {
  const d = make(env({ OPENAI_API_KEYS: '' })).describe();
  assert.deepEqual(d.map((p) => p.id), ['groq', 'gemini', 'openai', 'anthropic']);
  assert.equal(d.find((p) => p.id === 'openai').configured, false);
  assert.doesNotMatch(JSON.stringify(d), /g1|gm1|a1"/);
});

test('Groq: compound executed_tools become evidence, all verified', async () => {
  const calls = mockFetch([['api.groq.com', () => ({ body: groqResponse() })]]);
  const r = await make().research({ provider: 'groq', market: 'IN' });
  assert.equal(r.materials.filter((m) => m.status === 'verified').length, 5);
  assert.equal(r.evidence.length, 5);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'openai/gpt-oss-120b');
  assert.deepEqual(sent.tools, [{ type: 'browser_search' }]);
  assert.match(sent.messages[0].content, /Do not invent prices or sources/);
  assert.match(sent.messages[1].content, /India \(INR\)/);
});

test('key rotation: a 429 on the first key moves to the second', async () => {
  const calls = mockFetch([['api.groq.com', (_u, init) =>
    init.headers.authorization === 'Bearer g1' ? { status: 429, body: '{"error":"rate"}' } : { body: groqResponse() }]]);
  const r = await make().research({ provider: 'groq', market: 'IN' });
  assert.equal(calls.length, 2);
  assert.equal(r.materials.length, 5);
});

test('invalid key on every key -> invalid_api_key', async () => {
  mockFetch([['api.groq.com', () => ({ status: 401, body: '{"error":{"message":"Invalid API Key"}}' })]]);
  await assert.rejects(make().research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'invalid_api_key' && e.status === 502);
});

test('an answer with no search results -> web_search_unavailable, never a guessed rate', async () => {
  mockFetch([['api.groq.com', () => ({ body: { choices: [{ message: { content: answerText() } }] } })]]);
  await assert.rejects(make().research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'web_search_unavailable' && /web research is unavailable/.test(e.message));
});

test('a non-JSON answer -> invalid_response', async () => {
  const bad = groqResponse();
  bad.choices[0].message.content = 'Copper is about 800 rupees.';
  mockFetch([['api.groq.com', () => ({ body: bad })]]);
  await assert.rejects(make().research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'invalid_response');
});

test('timeouts surface as timeout', async () => {
  globalThis.fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const research = createResearch(env(), { timeoutMs: 50 });
  // AbortSignal.timeout does not hold the event loop open; in the app the
  // listening server does. Stand in for it here.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(research.research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'timeout');
  } finally {
    clearInterval(keepAlive);
  }
});

test('5xx -> provider_unavailable; unsupported provider; missing key; busy', async () => {
  mockFetch([['api.groq.com', () => ({ status: 503, body: 'down' })]]);
  await assert.rejects(make().research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'provider_unavailable');
  await assert.rejects(make().research({ provider: 'mistral', market: 'IN' }), (e) => e.code === 'unsupported_provider');
  await assert.rejects(make(env({ GROQ_API_KEYS: '' })).research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'no_api_key');

  let release;
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify(groqResponse()), { status: 200 })); });
  const research = make();
  const first = research.research({ provider: 'groq', market: 'IN' });
  await assert.rejects(research.research({ provider: 'groq', market: 'IN' }), (e) => e.code === 'busy');
  release();
  await first;
});

test('Gemini: grounding redirects are resolved to the real pages', async () => {
  const chunks = EVIDENCE.map((e, i) => ({ web: { uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/r${i}`, title: new URL(e.url).hostname } }));
  const calls = mockFetch([
    ['generativelanguage.googleapis.com', () => ({ body: { modelVersion: 'gemini-x', candidates: [{ content: { parts: [{ text: answerText() }] }, groundingMetadata: { groundingChunks: chunks } }] } })],
    ['grounding-api-redirect/r', (u) => new Response(null, { status: 302, headers: { location: EVIDENCE[Number(u.split('/r').pop())].url } })],
  ]);
  const r = await make().research({ provider: 'gemini', market: 'IN' });
  assert.equal(r.materials.filter((m) => m.status === 'verified').length, 5);
  assert.ok(r.evidence.every((e) => !e.url.includes('vertexaisearch')));
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.tools, [{ google_search: {} }]);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'gm1');
});

test('OpenAI: web_search sources and url_citations are evidence', async () => {
  const calls = mockFetch([['api.openai.com', () => ({ body: {
    model: 'gpt-5',
    output: [
      { type: 'web_search_call', action: { type: 'search', sources: EVIDENCE.slice(0, 3).map((e) => ({ type: 'url', url: e.url })) } },
      { type: 'message', content: [{ type: 'output_text', text: answerText(), annotations: EVIDENCE.slice(3).map((e) => ({ type: 'url_citation', url: e.url, title: e.title })) }] },
    ],
  } })]]);
  const r = await make().research({ provider: 'openai', market: 'IN' });
  assert.equal(r.materials.filter((m) => m.status === 'verified').length, 5);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.tools, [{ type: 'web_search' }]);
});

test('OpenAI: a model that cannot use web_search -> web_search_unavailable', async () => {
  mockFetch([['api.openai.com', () => ({ status: 400, body: '{"error":{"message":"Tool \'web_search\' is not supported with this model."}}' })]]);
  await assert.rejects(make().research({ provider: 'openai', market: 'IN' }), (e) => e.code === 'web_search_unavailable');
});

test('Anthropic: web_search_tool_result blocks are evidence; pause_turn is resumed', async () => {
  let n = 0;
  const calls = mockFetch([['api.anthropic.com', () => {
    n += 1;
    if (n === 1) {
      return { body: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'pause_turn', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'web_search_tool_result', tool_use_id: 't1', content: EVIDENCE.slice(0, 3).map((e) => ({ type: 'web_search_result', url: e.url, title: e.title })) }] } };
    }
    return { body: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'web_search_tool_result', tool_use_id: 't2', content: EVIDENCE.slice(3).map((e) => ({ type: 'web_search_result', url: e.url, title: e.title })) },
        { type: 'text', text: answerText() },
      ] } };
  }]]);
  const r = await make().research({ provider: 'anthropic', market: 'IN' });
  assert.equal(n, 2);
  assert.equal(r.materials.filter((m) => m.status === 'verified').length, 5);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'claude-opus-5');
  assert.equal(sent.tools[0].type, 'web_search_20260209');
});

test('Anthropic: 401 -> invalid_api_key', async () => {
  mockFetch([['api.anthropic.com', () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } })]]);
  await assert.rejects(make().research({ provider: 'anthropic', market: 'IN' }), (e) => e.code === 'invalid_api_key');
});

test('every catalog material appears in the prompt', async () => {
  const calls = mockFetch([['api.groq.com', () => ({ body: groqResponse() })]]);
  await make().research({ provider: 'groq', market: 'IN' });
  const prompt = JSON.parse(calls[0].init.body).messages.map((m) => m.content).join('\n');
  for (const m of MATERIALS) assert.ok(prompt.includes(m.id), m.id);
});

// ------------------------------------------------------------------ model choice

test('the chosen model is what gets called', async () => {
  const calls = mockFetch([['api.groq.com', () => ({ body: groqResponse() })]]);
  await make().research({ provider: 'groq', market: 'IN', model: 'openai/gpt-oss-20b' });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'openai/gpt-oss-20b');
  assert.deepEqual(sent.tools, [{ type: 'browser_search' }]);
});

test('groq/compound is called without a tools list (it searches by itself)', async () => {
  const calls = mockFetch([['api.groq.com', () => ({ body: groqResponse() })]]);
  await make().research({ provider: 'groq', market: 'IN', model: 'groq/compound' });
  assert.equal(JSON.parse(calls[0].init.body).tools, undefined);
});

test('a malformed model id is refused before any call', async () => {
  const calls = mockFetch([]);
  await assert.rejects(make().research({ provider: 'gemini', market: 'IN', model: '../../evil?x=1' }), (e) => e.code === 'bad_request');
  assert.equal(calls.length, 0);
});

test('a missing model -> model_unavailable, after trying every key', async () => {
  const calls = mockFetch([['api.groq.com', () => ({ status: 404, body: '{"error":{"message":"The model `groq/compound` does not exist or you do not have access to it.","code":"model_not_found"}}' })]]);
  await assert.rejects(make().research({ provider: 'groq', market: 'IN', model: 'groq/compound' }), (e) => e.code === 'model_unavailable' && e.status === 422 && /Choose another model/.test(e.message));
  assert.equal(calls.length, 2);
});

test('a missing model on one key falls through to a key that has it', async () => {
  mockFetch([['api.groq.com', (_u, init) => init.headers.authorization === 'Bearer g1'
    ? { status: 404, body: '{"error":{"code":"model_not_found"}}' }
    : { body: groqResponse() }]]);
  const r = await make().research({ provider: 'groq', market: 'IN', model: 'groq/compound' });
  assert.equal(r.materials.length, 5);
});

test('Gemini 404 "models/x is not found" -> model_unavailable', async () => {
  mockFetch([['generativelanguage.googleapis.com', () => ({ status: 404, body: '{"error":{"code":404,"message":"models/gemini-9 is not found for API version v1beta"}}' })]]);
  await assert.rejects(make().research({ provider: 'gemini', market: 'IN', model: 'gemini-9' }), (e) => e.code === 'model_unavailable');
});

test('Groq model list: search-capable only, merged across keys', async () => {
  mockFetch([['api.groq.com/openai/v1/models', (_u, init) => ({ body: { data: init.headers.authorization === 'Bearer g1'
    ? [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-safeguard-20b' }]
    : [{ id: 'openai/gpt-oss-20b' }, { id: 'groq/compound' }, { id: 'whisper-large-v3' }] } })]]);
  const r = await make().listModels('groq');
  assert.deepEqual(r.models.map((m) => m.id), ['groq/compound', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.equal(r.default, 'openai/gpt-oss-120b');
});

test('Gemini model list drops non-text variants', async () => {
  mockFetch([['generativelanguage.googleapis.com', () => ({ body: { models: [
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] },
  ] } })]]);
  const r = await make().listModels('gemini');
  assert.deepEqual(r.models.map((m) => m.id), ['gemini-3.5-flash-lite', 'gemini-3.5-flash']);
});

test('OpenAI model list keeps web_search-capable text models', async () => {
  mockFetch([['api.openai.com/v1/models', () => ({ body: { data: ['gpt-5', 'gpt-5-mini', 'gpt-4o-audio-preview', 'text-embedding-3-large', 'gpt-4.1', 'gpt-realtime', 'dall-e-3'].map((id) => ({ id })) } })]]);
  const r = await make().listModels('openai');
  assert.deepEqual(r.models.map((m) => m.id), ['gpt-5-mini', 'gpt-5', 'gpt-4.1']);
});

test('Anthropic model list comes from the Models API', async () => {
  mockFetch([['api.anthropic.com/v1/models', () => ({ body: { data: [
    { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-01-01T00:00:00Z' },
    { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
  ], has_more: false, first_id: 'claude-opus-5', last_id: 'claude-haiku-4-5' } })]]);
  const r = await make().listModels('anthropic');
  assert.deepEqual(r.models.map((m) => m.id), ['claude-opus-5', 'claude-haiku-4-5']);
});

test('Anthropic request adapts to the model generation', async () => {
  const { requestShape } = await import('../src/research/providers/anthropic.js');
  const current = requestShape('claude-opus-5');
  assert.deepEqual(current.thinking, { type: 'adaptive' });
  assert.equal(current.tools[0].type, 'web_search_20260209');
  assert.equal(current.fallbacks, 'default');
  const older = requestShape('claude-haiku-4-5');
  assert.equal(older.thinking, undefined);
  assert.equal(older.fallbacks, undefined);
  assert.equal(older.tools[0].type, 'web_search_20250305');
  assert.equal(older.tools[1].type, 'web_fetch_20250910');
  assert.equal(requestShape('claude-sonnet-5').fallbacks, undefined);
});

test('model lists are cached, and a missing key is reported', async () => {
  const calls = mockFetch([['api.openai.com/v1/models', () => ({ body: { data: [{ id: 'gpt-5' }] } })]]);
  const research = make();
  await research.listModels('openai');
  await research.listModels('openai');
  assert.equal(calls.length, 1);
  await assert.rejects(make(env({ OPENAI_API_KEYS: '' })).listModels('openai'), (e) => e.code === 'no_api_key');
});