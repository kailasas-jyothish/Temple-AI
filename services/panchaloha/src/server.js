// @ts-check
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { COMPOSITIONS, DEFAULTS, MARKETS, MATERIALS, WAX_TYPES, DEFAULT_COMPOSITION_ID, DEFAULT_WAX_TYPE } from './catalog.js';
import { CalculationError, calculateMurthyCost } from './calculator.js';
import { ResearchError } from './research/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The browser imports the engine itself so results update as you type; only
// these modules are exposed, never config or the research code.
const SHARED_MODULES = new Set(['decimal.js', 'catalog.js', 'calculator.js']);

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{ config: typeof import('./config.js').config, research: ReturnType<typeof import('./research/index.js').createResearch> }} deps
 */
export function createServer({ config, research }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  if (config.uiPassword) {
    app.use((req, res, next) => {
      const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
      const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
      if (password && safeEqual(password, config.uiPassword)) return next();
      res.set('www-authenticate', 'Basic realm="Panchaloha Calculator"').status(401).send('Authentication required');
    });
  }

  app.use(express.json({ limit: '32kb' }));

  app.get('/api/config', (_req, res) => {
    const providers = research.describe();
    const defaultProvider = config.defaultProvider || providers.find((p) => p.configured)?.id || providers[0].id;
    res.json({
      compositions: COMPOSITIONS,
      waxTypes: WAX_TYPES,
      materials: MATERIALS.map(({ id, rateKey, label, kind }) => ({ id, rateKey, label, kind })),
      markets: MARKETS,
      defaults: { ...DEFAULTS, compositionId: DEFAULT_COMPOSITION_ID, waxType: DEFAULT_WAX_TYPE, market: config.defaultMarket, provider: defaultProvider },
      providers,
    });
  });

  // The same engine the page runs, for scripts and for anyone who wants the
  // server's word on a number.
  app.post('/api/calculate', (req, res) => {
    try {
      res.json(calculateMurthyCost(req.body));
    } catch (err) {
      if (err instanceof CalculationError) return res.status(422).json({ error: { code: 'invalid_input', message: err.message, fields: err.errors } });
      throw err;
    }
  });

  app.get('/api/models', async (req, res) => {
    const provider = String(req.query.provider || '');
    try {
      res.json(await research.listModels(provider));
    } catch (err) {
      if (err instanceof ResearchError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      console.error('[models] unexpected', err);
      res.status(500).json({ error: { code: 'internal', message: 'Could not list models.' } });
    }
  });

  app.post('/api/research', async (req, res) => {
    const started = Date.now();
    const { provider, market, model } = req.body || {};
    try {
      const result = await research.research({ provider: String(provider || ''), market: String(market || ''), model: model ? String(model) : undefined });
      const verified = result.materials.filter((m) => m.status === 'verified').length;
      console.log(`[research] ${provider} ${result.model} ${market}: ${verified}/${result.materials.length} verified, ${result.evidence.length} pages, ${Math.round((Date.now() - started) / 1000)}s`);
      res.json(result);
    } catch (err) {
      if (err instanceof ResearchError) {
        console.warn(`[research] ${provider} ${market}: ${err.code} ${err.detail}`);
        return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      }
      console.error('[research] unexpected', err);
      res.status(500).json({ error: { code: 'internal', message: 'Rate research failed unexpectedly. Enter rates manually.' } });
    }
  });

  app.get('/lib/:file', (req, res, next) => {
    if (!SHARED_MODULES.has(req.params.file)) return next();
    res.type('text/javascript').sendFile(path.join(here, req.params.file));
  });

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

  return app;
}
