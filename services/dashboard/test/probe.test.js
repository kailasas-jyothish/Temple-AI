import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProber } from '../src/probe.js';
import { SERVICES, duration } from '../src/services.js';

const config = {
  port: 0,
  uiPassword: '',
  publicHost: 'http://example.test',
  probeHost: 'http://probe.test',
  probeIntervalMs: 30_000,
  probeTimeoutMs: 1_000,
  notifierAdminToken: 'tok',
  env: {},
};

/** A fetch that answers from a table keyed by URL. */
function fakeFetch(table) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers || {} });
    const hit = table[url];
    if (hit instanceof Error) throw hit;
    if (!hit) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  };
  return { impl, calls };
}

const byId = (snap, id) => snap.services.find((s) => s.id === id);

test('reads every service and links to the public host', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { impl, calls } = fakeFetch({
    'http://probe.test:8478/healthz': { body: { ok: true, uptime: 7200 } },
    'http://probe.test:8478/status': {
      body: {
        youtube: { apiKey: true, configured: ['a', 'b'], channels: [{ id: 1 }, { id: 2 }] },
        state: { watch: { x: { scheduledStartTime: '2026-09-30T05:00:00Z' }, y: {} } },
      },
    },
    'http://probe.test:8478/admin/attendance': {
      body: { enabled: true, today: '30-Sep-2026', queued: [], live: { 'kailasa uganda': { videoId: 'mX8t9DxS8gM', startedAt: '2026-09-29T15:54:29Z' } } },
    },
    'http://probe.test:8479/healthz': { body: { ok: true, problems: [], queue: 0 } },
    'http://probe.test:8481/healthz': { body: { ok: false, busy: 'building durga', problems: ['GROQ key missing'], mantras: ['a'] } },
    'http://probe.test:8480/healthz': refused,
  });
  const prober = createProber({ config, services: SERVICES, fetchImpl: impl });
  await prober.probeAll();
  const snap = prober.snapshot();

  const notifier = byId(snap, 'notifier');
  assert.equal(notifier.state, 'up');
  assert.equal(notifier.url, 'http://example.test:8478');
  assert.deepEqual(notifier.details.facts.map((f) => [f.label, f.value]), [
    ['Up for', '2h'],
    ['Channels', '2'],
    ['Scheduled streams', 1],
    ['Live today (30-Sep-2026)', 1],
  ]);
  assert.equal(notifier.details.items[0].title, 'Kailasa Uganda');
  assert.equal(notifier.details.items[0].href, 'https://www.youtube.com/watch?v=mX8t9DxS8gM');
  assert.equal(calls.find((c) => c.url.endsWith('/status')).headers['x-admin-token'], 'tok');

  assert.equal(byId(snap, 'reels').state, 'up');

  const mantra = byId(snap, 'mantra-tutorials');
  assert.equal(mantra.state, 'degraded');
  assert.deepEqual(mantra.details.problems, ['GROQ key missing']);
  assert.equal(mantra.details.facts[1].value, 'building durga');

  const panchaloha = byId(snap, 'panchaloha');
  assert.equal(panchaloha.state, 'down');
  assert.equal(panchaloha.error, 'connection refused — not running');
  assert.equal(panchaloha.lastUpAt, undefined);
});

test('a failing admin call leaves the service up but says why', async () => {
  const { impl } = fakeFetch({
    'http://probe.test:8478/healthz': { body: { ok: true, uptime: 5 } },
    'http://probe.test:8478/status': { status: 403, body: {} },
  });
  const prober = createProber({ config, services: SERVICES.filter((s) => s.id === 'notifier'), fetchImpl: impl });
  await prober.probeAll();
  const notifier = byId(prober.snapshot(), 'notifier');
  assert.equal(notifier.state, 'degraded');
  assert.match(notifier.details.problems[0], /status answered 403/);
});

test('without an admin token the notifier shows health only', async () => {
  const { impl, calls } = fakeFetch({ 'http://probe.test:8478/healthz': { body: { ok: true, uptime: 5 } } });
  const prober = createProber({ config: { ...config, notifierAdminToken: '' }, services: SERVICES.filter((s) => s.id === 'notifier'), fetchImpl: impl });
  await prober.probeAll();
  assert.equal(calls.length, 1);
  assert.match(byId(prober.snapshot(), 'notifier').details.problems[0], /NOTIFIER_ADMIN_TOKEN/);
});

test('a service that recovers keeps lastUpAt and drops the error', async () => {
  let up = false;
  const impl = async () => (up ? new Response('{"ok":true}') : Promise.reject(new Error('boom')));
  const prober = createProber({ config, services: SERVICES.filter((s) => s.id === 'panchaloha'), fetchImpl: impl });
  await prober.probeAll();
  assert.equal(byId(prober.snapshot(), 'panchaloha').state, 'down');
  up = true;
  await prober.probeAll();
  const s = byId(prober.snapshot(), 'panchaloha');
  assert.equal(s.state, 'up');
  assert.equal(s.error, undefined);
  assert.ok(s.lastUpAt);
});

test('duration', () => {
  assert.equal(duration(30), '30s');
  assert.equal(duration(600), '10m');
  assert.equal(duration(7200), '2h');
  assert.equal(duration(300246), '3d');
});

test('PROBE_URL_<ID> overrides the host for that service only', async () => {
  const { impl, calls } = fakeFetch({
    'http://temple-mantra-tutorials-vka2v8:3200/healthz': { body: { ok: true, mantras: [] } },
    'http://probe.test:8479/healthz': { body: { ok: true, queue: 0 } },
  });
  const env = { PROBE_URL_MANTRA_TUTORIALS: 'http://temple-mantra-tutorials-vka2v8:3200/' };
  const services = SERVICES.filter((s) => s.id === 'mantra-tutorials' || s.id === 'reels');
  const prober = createProber({ config: { ...config, env }, services, fetchImpl: impl });
  await prober.probeAll();
  assert.deepEqual(calls.map((c) => c.url).sort(), ['http://probe.test:8479/healthz', 'http://temple-mantra-tutorials-vka2v8:3200/healthz']);
  const mantra = byId(prober.snapshot(), 'mantra-tutorials');
  assert.equal(mantra.state, 'up');
  assert.equal(mantra.url, 'http://example.test:8481');
});
