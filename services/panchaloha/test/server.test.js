import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createResearch } from '../src/research/index.js';

let server;
let base;

function start(configOver = {}) {
  const config = { port: 0, uiPassword: '', defaultProvider: '', defaultMarket: 'IN', researchTimeoutMs: 5000, env: {}, ...configOver };
  const research = createResearch({ GEMINI_API_KEYS: 'secret-gemini-key' }, { timeoutMs: 5000 });
  const app = createServer({ config, research });
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

before(async () => { ({ s: server, url: base } = await start()); });
after(() => server.close());

test('GET /api/config lists providers without leaking keys, defaulting to one that has a key', async () => {
  const res = await fetch(`${base}/api/config`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.doesNotMatch(text, /secret-gemini-key/);
  const body = JSON.parse(text);
  assert.equal(body.defaults.provider, 'gemini');
  assert.equal(body.defaults.market, 'IN');
  assert.equal(body.defaults.compositionId, '80:15:5');
  assert.equal(body.defaults.overheadPercent, 5);
  assert.equal(body.waxTypes.length, 2);
});

test('POST /api/calculate returns the §30 answer', async () => {
  const res = await fetch(`${base}/api/calculate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      murthyWeightKg: '10',
      composition: { copper: '0.80', gunMetal: '0.15', zinc: '0.05' },
      wax: { type: 'beeswax' },
      rates: { copperPerKg: 100, gunMetalPerKg: 200, zincPerKg: 300, beeswaxPerKg: 400 },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.finalRatePerKg, 346.5);
});

test('POST /api/calculate refuses missing rates with field errors', async () => {
  const res = await fetch(`${base}/api/calculate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ murthyWeightKg: '0', composition: { copper: '0.8', gunMetal: '0.15', zinc: '0.05' }, wax: { type: 'paraffin' }, rates: {} }),
  });
  const body = await res.json();
  assert.equal(res.status, 422);
  const fields = body.error.fields.map((f) => f.field);
  for (const f of ['murthyWeightKg', 'rates.copperPerKg', 'rates.gunMetalPerKg', 'rates.zincPerKg', 'rates.paraffinWaxPerKg']) assert.ok(fields.includes(f), f);
});

test('POST /api/research maps errors to JSON with a code', async () => {
  const res = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', market: 'IN' }) });
  const body = await res.json();
  assert.equal(res.status, 412);
  assert.equal(body.error.code, 'no_api_key');
});

test('/lib serves only the shared engine modules', async () => {
  assert.equal((await fetch(`${base}/lib/calculator.js`)).status, 200);
  assert.equal((await fetch(`${base}/lib/config.js`)).status, 404);
  assert.equal((await fetch(`${base}/lib/..%2Fconfig.js`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('UI_PASSWORD gates everything but /healthz', async () => {
  const { s, url } = await start({ uiPassword: 'pw' });
  try {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/api/config`)).status, 401);
    const auth = { authorization: `Basic ${Buffer.from('any:pw').toString('base64')}` };
    assert.equal((await fetch(`${url}/api/config`, { headers: auth })).status, 200);
  } finally {
    s.close();
  }
});
