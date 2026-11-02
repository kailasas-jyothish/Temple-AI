// @ts-check
import http from 'node:http';
import https from 'node:https';
import { probeBase } from './probe.js';

/**
 * Every service behind one hostname: /<service-id>/... is forwarded to that
 * service's container with the prefix stripped. The edge cannot do this — Caddy
 * owns 80/443 and serves only hosts in its own config (CLAUDE.md §12) — so the
 * dashboard, which already reaches every container by Swarm name, does it.
 *
 * One login: the dashboard's own basic auth has run before this, and each
 * upstream gets its own credential injected, so nobody types six passwords.
 */

// Hop-by-hop headers, plus the visitor's credential, which is the dashboard's
// password and has no business reaching another service.
const DROP_REQUEST = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'host', 'authorization', 'x-admin-token']);
// An upstream 401 with its own realm would make the browser ask for a second
// password the visitor does not have; the 401 body is enough to say what broke.
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'www-authenticate']);

/** @param {string} id */
const envKey = (id) => id.toUpperCase().replace(/-/g, '_');

/**
 * @param {typeof import('./config.js').config} config
 * @param {import('./services.js').Service} service
 * @returns {Record<string, string>}
 */
export function upstreamAuth(config, service) {
  const key = envKey(service.id);
  /** @type {Record<string, string>} */
  const headers = {};
  const password = config.env[`UPSTREAM_PASSWORD_${key}`];
  if (password) headers.authorization = `Basic ${Buffer.from(`gateway:${password}`).toString('base64')}`;
  const token = config.env[`UPSTREAM_TOKEN_${key}`] || (service.id === 'notifier' ? config.notifierAdminToken : '');
  if (token) headers['x-admin-token'] = token;
  return headers;
}

/**
 * A redirect from the upstream points at its own root; put the prefix back so
 * the browser stays behind the gateway.
 * @param {string} location @param {string} prefix @param {URL} base
 */
export function rewriteLocation(location, prefix, base) {
  if (location.startsWith('/') && !location.startsWith('//')) return prefix + location;
  try {
    const u = new URL(location);
    if (u.host === base.host) return prefix + u.pathname + u.search + u.hash;
  } catch {}
  return location;
}

/**
 * @param {{ config: typeof import('./config.js').config, services: import('./services.js').Service[], timeoutMs?: number }} deps
 * @returns {import('express').RequestHandler}
 */
export function createGateway({ config, services, timeoutMs = 30 * 60 * 1000 }) {
  const byId = new Map(services.map((s) => [s.id, s]));

  return (req, res, next) => {
    const match = /^\/([a-z0-9-]+)(\/.*)?$/.exec(req.path);
    const service = match && byId.get(match[1]);
    if (!match || !service) return next();

    const prefix = `/${service.id}`;
    const query = req.originalUrl.slice(req.originalUrl.indexOf('?') === -1 ? req.originalUrl.length : req.originalUrl.indexOf('?'));
    // Relative links in a page only resolve under the prefix if the page's URL
    // ends in a slash.
    if (!match[2]) return res.redirect(301, `${prefix}/${query}`);

    const base = new URL(probeBase(config, service) + '/');
    const rest = req.originalUrl.slice(prefix.length);
    const target = new URL(rest.replace(/^\/+/, ''), base);

    /** @type {Record<string, string | string[]>} */
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROP_REQUEST.has(name)) headers[name] = value;
    }
    Object.assign(headers, upstreamAuth(config, service));
    headers.host = target.host;
    headers['x-forwarded-host'] = String(req.headers.host || '');
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-forwarded-prefix'] = prefix;
    const fwd = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = fwd ? `${fwd}, ${req.socket.remoteAddress}` : String(req.socket.remoteAddress || '');

    const client = target.protocol === 'https:' ? https : http;
    // Bodies stream both ways: uploads (songs, backgrounds) and rendered videos
    // are too large to buffer, and renders can take many minutes to answer.
    const upstream = client.request(target, { method: req.method, headers, timeout: timeoutMs }, (up) => {
      /** @type {Record<string, string | string[]>} */
      const out = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (value !== undefined && !DROP_RESPONSE.has(name)) out[name] = value;
      }
      if (typeof out.location === 'string') out.location = rewriteLocation(out.location, prefix, target);
      const cookies = out['set-cookie'];
      if (Array.isArray(cookies)) out['set-cookie'] = cookies.map((c) => c.replace(/;\s*path=\/(?=;|$)/i, `; Path=${prefix}/`));
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
    upstream.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      const code = /** @type {any} */ (err).code;
      const why = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'service name not found — is it deployed?' : code === 'ECONNREFUSED' ? 'not running' : err.message;
      res.status(502).type('text/plain').send(`${service.name} is unreachable: ${why}`);
    });
    req.pipe(upstream);
  };
}
