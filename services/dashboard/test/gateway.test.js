import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createServer } from '../src/server.js';
import { SERVICES } from '../src/services.js';
import { rewriteLocation } from '../src/gateway.js';

/** @type {http.Server} */ let upstream;
/** @type {http.Server} */ let dashboard;
let base = '';
/** @type {any[]} */ const seen = [];

const basic = (p) => `Basic ${Buffer.from(`x:${p}`).toString('base64')}`;

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/go') {
        res.writeHead(303, { location: '/done?x=1', 'set-cookie': 'sid=1; Path=/; HttpOnly' });
        return res.end();
      }
      if (req.url === '/locked') {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="other"' });
        return res.end('nope');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, body }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}`;
  const config = {
    port: 0, uiPassword: 'dash', publicHost: 'http://example.test', probeHost: 'http://probe.test',
    probeIntervalMs: 30_000, probeTimeoutMs: 1_000, notifierAdminToken: 'ntok', tlsPort: 0, tlsCertFile: '', tlsKeyFile: '',
    env: {
      PROBE_URL_FESTIVAL_BUDGET: up, UPSTREAM_PASSWORD_FESTIVAL_BUDGET: 'fbpass',
      PROBE_URL_NOTIFIER: up,
      PROBE_URL_REELS: up, UPSTREAM_TOKEN_REELS: 'rtok',
      PROBE_URL_PANCHALOHA: 'http://127.0.0.1:1',
    },
  };
  const prober = { snapshot: () => ({ services: [] }), probeAll: async () => {} };
  const app = createServer({ config: /** @type {any} */ (config), prober: /** @type {any} */ (prober), services: SERVICES });
  dashboard = app.listen(0, '127.0.0.1');
  await new Promise((r) => dashboard.once('listening', r));
  base = `http://127.0.0.1:${/** @type {any} */ (dashboard.address()).port}`;
});

after(() => {
  upstream.close();
  dashboard.close();
});

const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init, headers: { authorization: basic('dash'), ...(init.headers || {}) } });

test('the gateway sits behind the dashboard login', async () => {
  const res = await fetch(base + '/festival-budget/');
  assert.equal(res.status, 401);
});

test('forwards with the prefix stripped and the upstream password swapped in', async () => {
  const res = await get('/festival-budget/api/library?q=1');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: '/api/library?q=1', body: '' });
  const hit = seen.at(-1);
  assert.equal(hit.headers.authorization, `Basic ${Buffer.from('gateway:fbpass').toString('base64')}`);
  assert.equal(hit.headers['x-forwarded-prefix'], '/festival-budget');
});

test('streams a request body through', async () => {
  const res = await get('/festival-budget/api/ops', { method: 'POST', body: 'x'.repeat(200_000), headers: { 'content-type': 'text/plain' } });
  assert.equal((await res.json()).body.length, 200_000);
});

test('admin tokens: reels from its own variable, notifier from NOTIFIER_ADMIN_TOKEN', async () => {
  await get('/reels/api/me');
  assert.equal(seen.at(-1).headers['x-admin-token'], 'rtok');
  assert.equal(seen.at(-1).headers.authorization, undefined, "the dashboard's password must not leak upstream");
  await get('/notifier/status');
  assert.equal(seen.at(-1).headers['x-admin-token'], 'ntok');
});

test('a bare prefix redirects to the slash form', async () => {
  const res = await get('/reels?a=b');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/reels/?a=b');
});

test('redirects and cookies are kept under the prefix', async () => {
  const res = await get('/reels/go');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/reels/done?x=1');
  assert.match(res.headers.get('set-cookie') || '', /Path=\/reels\//);
});

test("an upstream 401 does not make the browser ask for that service's password", async () => {
  const res = await get('/reels/locked');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), null);
});

test('an unreachable service answers 502 saying which', async () => {
  const res = await get('/panchaloha/');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Panchaloha.*not running/);
});

test('non-service paths fall through to the dashboard', async () => {
  const res = await get('/api/status');
  assert.equal(res.status, 200);
});

test('rewriteLocation', () => {
  const u = new URL('http://svc:8000/x');
  assert.equal(rewriteLocation('/a', '/p', u), '/p/a');
  assert.equal(rewriteLocation('http://svc:8000/a?b', '/p', u), '/p/a?b');
  assert.equal(rewriteLocation('https://accounts.google.com/x', '/p', u), 'https://accounts.google.com/x');
  assert.equal(rewriteLocation('//evil/x', '/p', u), '//evil/x');
});
