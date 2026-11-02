// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptures-srv-'));
process.env.UI_PASSWORD = 'pw';
process.env.OPENROUTER_API_KEY = 'sk-secret-never-shown';
process.env.TRANSLATION_MODEL = '';
const { createServer } = await import('../src/server.js');

const server = createServer().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
const auth = { authorization: `Basic ${Buffer.from('anyone:pw').toString('base64')}` };
test.after(() => server.close());

test('/healthz answers without a password', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.extracted, 0);
  assert.equal(body.model, null);
});

test('everything else needs the password', async () => {
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  const wrong = { authorization: `Basic ${Buffer.from('x:nope').toString('base64')}` };
  assert.equal((await fetch(`${base}/api/config`, { headers: wrong })).status, 401);
  assert.equal((await fetch(`${base}/api/config`, { headers: auth })).status, 200);
});

test('/api/config reports the key without revealing it', async () => {
  const text = await (await fetch(`${base}/api/config`, { headers: auth })).text();
  assert.equal(JSON.parse(text).keySet, true);
  assert.ok(!text.includes('sk-secret'));
});

test('translation refuses to start without a model', async () => {
  const res = await fetch(`${base}/api/translate`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'iisha' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /model/);
});

test('bad ids and file names are refused', async () => {
  const res = await fetch(`${base}/api/texts/..%2Fetc`, { headers: auth });
  assert.ok(res.status >= 400 && res.status < 500);
  assert.equal((await fetch(`${base}/download/x.exe`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${base}/download/missing.csv`, { headers: auth })).status, 404);
});
