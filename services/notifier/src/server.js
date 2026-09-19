import express from 'express';
import { config } from './config.js';
import { log } from './log.js';
import { snapshot } from './store.js';
import { announce } from './notify.js';
import { postPlain } from './slack.js';
import * as youtube from './youtube/index.js';
import * as facebook from './facebook/index.js';
import { CALLBACK_PATH, verifySignature as verifyYouTube, subscribe } from './youtube/websub.js';
import { verifySignature as verifyFacebook } from './facebook/graph.js';

const raw = express.raw({ type: '*/*', limit: '3mb' });

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/', (_req, res) => res.type('text/plain').send('social-media-notifications: ok'));
  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // ---------------------------------------------------------------- YouTube
  // Hub verification handshake: echo hub.challenge verbatim.
  app.get(CALLBACK_PATH, (req, res) => {
    const challenge = req.query['hub.challenge'];
    if (!challenge) return res.status(400).send('missing hub.challenge');
    log.info(`websub ${req.query['hub.mode']} verification for ${req.query['hub.topic']}`);
    res.type('text/plain').send(String(challenge));
  });

  app.post(CALLBACK_PATH, raw, (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const sig = req.get('x-hub-signature') || req.get('x-hub-signature-256');
    if (!verifyYouTube(body, sig)) {
      log.warn('websub push rejected: bad signature');
      return res.status(403).send('bad signature');
    }
    // Ack immediately; the hub retries anything slow or non-2xx.
    res.status(204).end();
    youtube
      .handlePush(body.toString('utf8'))
      .then((n) => log.debug(`websub push handled: ${n} entries`))
      .catch((err) => log.error(`websub push handling failed: ${err.message}`));
  });

  // --------------------------------------------------------------- Facebook
  app.get('/webhooks/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === config.facebook.verifyToken) {
      log.info('facebook webhook verified');
      return res.type('text/plain').send(String(challenge));
    }
    log.warn('facebook webhook verification failed');
    return res.sendStatus(403);
  });

  app.post('/webhooks/facebook', raw, (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyFacebook(body, req.get('x-hub-signature-256'))) {
      log.warn('facebook webhook rejected: bad signature');
      return res.sendStatus(403);
    }
    res.status(200).send('EVENT_RECEIVED');
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch (err) {
      return log.error(`facebook webhook body not JSON: ${err.message}`);
    }
    facebook
      .handleWebhook(parsed)
      .then((n) => log.debug(`facebook webhook handled: ${n} events`))
      .catch((err) => log.error(`facebook webhook handling failed: ${err.message}`));
  });

  // ----------------------------------------------------------------- Ingest
  // Generic inbox so any external source (Make/Zapier/IFTTT/another script)
  // can push an event into the same dedupe + Slack pipeline.
  app.post('/ingest', express.json({ limit: '256kb' }), async (req, res) => {
    const token = req.get('x-ingest-token') || req.query.token;
    if (!config.ingest.tokens.length || !config.ingest.tokens.includes(String(token || ''))) {
      return res.status(403).json({ ok: false, error: 'bad token' });
    }
    const b = req.body || {};
    if (!b.url) return res.status(400).json({ ok: false, error: 'url is required' });
    const posted = await announce({
      platform: b.platform || 'facebook',
      kind: b.kind || 'post',
      id: String(b.id || b.url),
      url: b.url,
      title: b.title || '',
      author: b.author || '',
      thumbnail: b.thumbnail,
      publishedAt: b.publishedAt,
      source: b.source || 'ingest',
    });
    res.json({ ok: true, posted });
  });

  // ------------------------------------------------------------------ Admin
  const requireAdmin = (req, res, next) => {
    const token = req.get('x-admin-token') || req.query.token;
    if (!config.admin.token || token !== config.admin.token) return res.sendStatus(403);
    next();
  };

  app.get('/status', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      publicUrl: config.publicUrl,
      youtube: {
        enabled: config.youtube.enabled,
        configured: config.youtube.channels,
        channels: youtube.getChannels(),
        apiKey: Boolean(config.youtube.apiKey),
        callback: config.publicUrl ? `${config.publicUrl}${CALLBACK_PATH}` : null,
      },
      facebook: {
        enabled: config.facebook.enabled,
        pageId: config.facebook.pageId || null,
        webhook: config.publicUrl ? `${config.publicUrl}/webhooks/facebook` : null,
      },
      slack: { channel: config.slack.channel, mode: config.slack.botToken ? 'bot' : 'webhook' },
      state: snapshot(),
    });
  });

  app.post('/admin/test', requireAdmin, async (_req, res) => {
    try {
      await postPlain(':white_check_mark: social-media-notifications is connected and can post here.');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/admin/recent', requireAdmin, async (req, res) => {
    try {
      res.json({ ok: true, ...(await youtube.recentReport(req.query.channel || '')) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/admin/resubscribe', requireAdmin, async (_req, res) => {
    const ids = youtube.getChannelIds();
    if (!ids.length) return res.status(409).json({ ok: false, error: 'no channel resolved yet' });
    const results = {};
    for (const id of ids) results[id] = await subscribe(id).catch((err) => err.message);
    res.json({ ok: Object.values(results).some((v) => v === true), results });
  });

  app.use((req, res) => res.status(404).json({ ok: false, error: `no route ${req.method} ${req.path}` }));

  return app;
}
