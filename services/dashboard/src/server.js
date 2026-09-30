// @ts-check
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{ config: typeof import('./config.js').config, prober: ReturnType<typeof import('./probe.js').createProber> }} deps
 */
export function createServer({ config, prober }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  if (config.uiPassword) {
    app.use((req, res, next) => {
      const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
      const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
      if (password && safeEqual(password, config.uiPassword)) return next();
      res.set('www-authenticate', 'Basic realm="Temple AI"').status(401).send('Authentication required');
    });
  }

  app.get('/api/status', (_req, res) => {
    res.set('cache-control', 'no-store').json(prober.snapshot());
  });

  // Re-probe on demand, so "is it back?" after a deploy needs no 30s wait.
  app.post('/api/refresh', async (_req, res) => {
    await prober.probeAll();
    res.set('cache-control', 'no-store').json(prober.snapshot());
  });

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  return app;
}
