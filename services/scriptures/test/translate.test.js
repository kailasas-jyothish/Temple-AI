// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// config is read at import time, so the environment is set first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptures-tr-'));
process.env.OPENROUTER_API_KEY = 'sk-test';
const { buildMessages, listModels, parseAnswer, translateUnit } = await import('../src/translate.js');

const prompt = { name: 'test', text: 'You translate.', hash: 'abc' };
const unit = { ref: '1', kind: 'verse', devanagari: 'ईशा वास्यम्', iast: 'īśā vāsyam' };

/** @param {number} status @param {unknown} body */
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('parseAnswer accepts fenced or prose-wrapped JSON and rejects empty translations', () => {
  assert.deepEqual(parseAnswer('```json\n{"translation": "All this", "notes": "n"}\n```'), { translation: 'All this', notes: 'n' });
  assert.deepEqual(parseAnswer('Here you go: {"translation": "x"} hope it helps {'), { translation: 'x', notes: '' });
  assert.equal(parseAnswer('{"translation": "  "}'), null);
  assert.equal(parseAnswer('{'), null);
  assert.equal(parseAnswer('no json'), null);
});

test('buildMessages carries context but asks for only the current unit', () => {
  const [sys, user] = buildMessages({
    model: 'm',
    prompt,
    title: 'Isha',
    section: '',
    unit,
    context: [{ ref: 'inv', kind: 'invocation', devanagari: 'ॐ', iast: 'oṃ', translation: 'Om' }],
  });
  assert.equal(sys.content, 'You translate.');
  assert.match(user.content, /do not translate these again/);
  assert.match(user.content, /Translation: Om/);
  assert.match(user.content, /Translate this verse \(1\):\nईशा वास्यम्/);
});

test('translateUnit records cost, caches, and never pays twice for a verse', async () => {
  let calls = 0;
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls++;
    assert.ok(url.endsWith('/chat/completions'));
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    return reply(200, {
      model: 'vendor/model',
      choices: [{ message: { content: '{"translation": "All this is pervaded by the Lord."}' } }],
      usage: { cost: 0.0012 },
    });
  };
  const req = { model: 'vendor/model', prompt, title: 'Isha', section: '', unit, context: [] };
  const first = await translateUnit(req, { fetchImpl });
  assert.equal(first.translation, 'All this is pervaded by the Lord.');
  assert.equal(first.cost, 0.0012);
  assert.equal(first.cached, false);
  const second = await translateUnit(req, { fetchImpl });
  assert.equal(second.cached, true);
  assert.equal(second.cost, 0);
  assert.equal(calls, 1);
});

test('translateUnit gives up at once on a non-retryable error', async () => {
  let calls = 0;
  /** @type {any} */
  const fetchImpl = async () => (calls++, reply(400, { error: { code: 400, message: 'model not found' } }));
  const req = { model: 'nope/model', prompt, title: 'Isha', section: '', unit: { ...unit, ref: '2' }, context: [] };
  await assert.rejects(translateUnit(req, { fetchImpl }), /model not found/);
  assert.equal(calls, 1);
});

test('listModels keeps text models and prices them per million tokens', async () => {
  /** @type {any} */
  const fetchImpl = async () =>
    reply(200, {
      data: [
        { id: 'z/text', name: 'Z', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'a/image', architecture: { output_modalities: ['image'] } },
        { id: 'b/text' },
      ],
    });
  const models = await listModels({ fetchImpl });
  assert.deepEqual(models.map((m) => m.id), ['b/text', 'z/text']);
  assert.equal(models[1].promptPrice, 1);
  assert.equal(models[1].completionPrice, 2);
  assert.equal(models[0].promptPrice, null);
});
