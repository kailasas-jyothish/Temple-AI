// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, problems } from './config.js';
import { assertId, csvPath, getCatalog, listTexts, loadText, outDir } from './core.js';
import { busy, cancel, enqueue, getJob, listJobs, queued } from './jobs.js';
import { listModels } from './translate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const started = Date.now();

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** @param {unknown} v */
const ids = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(String).filter(Boolean);

/** @param {express.Response} res @param {unknown} err */
function fail(res, err) {
  const e = /** @type {Error & { status?: number }} */ (err);
  res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message || String(err) });
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', async (_req, res) => {
    const texts = await listTexts().catch(() => []);
    res.json({
      ok: true,
      uptime: Math.round((Date.now() - started) / 1000),
      problems: problems(),
      extracted: texts.length,
      translated: texts.reduce((n, t) => n + t.translated, 0),
      translatable: texts.reduce((n, t) => n + t.translatable, 0),
      model: config.translationModel || null,
      busy: busy(),
      queue: queued(),
    });
  });

  if (config.uiPassword) {
    app.use((req, res, next) => {
      const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
      const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
      if (password && safeEqual(password, config.uiPassword)) return next();
      res.set('www-authenticate', 'Basic realm="Scriptures"').status(401).send('Authentication required');
    });
  }

  app.use(express.json({ limit: '64kb' }));

  app.get('/api/config', (_req, res) =>
    res.json({
      model: config.translationModel,
      prompt: config.promptName,
      maxCostUsd: config.maxCostUsd,
      keySet: Boolean(config.openrouterKey),
      problems: problems(),
    }),
  );

  app.get('/api/catalog', async (req, res) => {
    try {
      const [catalog, texts] = await Promise.all([getCatalog({ refresh: req.query.refresh === '1' }), listTexts()]);
      const byId = new Map(texts.map((t) => [t.id, t]));
      res.json(catalog.map((e) => ({ ...e, extracted: byId.get(e.id) || null })));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/texts/:id', async (req, res) => {
    try {
      const doc = await loadText(assertId(req.params.id));
      if (!doc) return res.status(404).json({ error: 'not extracted yet' });
      res.json(doc);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/download/:name', async (req, res) => {
    try {
      const m = /^((?:compare-)?[\w.\-~]+)\.(csv|json)$/.exec(req.params.name);
      if (!m) return res.status(400).send('bad file name');
      const file = m[2] === 'csv' && !m[1].startsWith('compare-') ? csvPath(m[1]) : path.join(outDir(), req.params.name);
      await fs.access(file);
      res.download(file, req.params.name);
    } catch {
      res.status(404).send('not found');
    }
  });

  app.get('/api/models', async (_req, res) => {
    try {
      res.json(await listModels());
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/extract', (req, res) => {
    try {
      const list = ids(req.body.ids).map(assertId);
      if (!list.length) return res.status(400).json({ error: 'no texts chosen' });
      res.json(enqueue('extract', { ids: list, refresh: Boolean(req.body.refresh) }));
    } catch (err) {
      fail(res, err);
    }
  });

  // Translation spends money: the model must be named on every request, or
  // configured once. Nothing defaults to a model nobody chose.
  app.post('/api/translate', (req, res) => {
    try {
      const id = assertId(String(req.body.id || ''));
      const model = String(req.body.model || config.translationModel || '');
      if (!model) return res.status(400).json({ error: 'choose a model first' });
      if (!config.openrouterKey) return res.status(400).json({ error: 'OPENROUTER_API_KEY is not set on the server' });
      const limit = Number(req.body.limit) || 0;
      res.json(enqueue('translate', { id, model, limit, force: Boolean(req.body.force), prompt: req.body.prompt || undefined }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/compare', (req, res) => {
    try {
      const id = assertId(String(req.body.id || ''));
      const models = ids(req.body.models);
      if (!models.length) return res.status(400).json({ error: 'choose at least one model' });
      if (!config.openrouterKey) return res.status(400).json({ error: 'OPENROUTER_API_KEY is not set on the server' });
      res.json(enqueue('compare', { id, models, limit: Number(req.body.limit) || 5, prompt: req.body.prompt || undefined }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/jobs', (_req, res) => res.json(listJobs().slice(0, 50)));
  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'no such job' });
    res.json(job);
  });
  app.post('/api/jobs/:id/cancel', (req, res) => res.json({ cancelled: cancel(req.params.id) }));

  app.use(express.static(path.join(here, '..', 'public')));
  return app;
}
