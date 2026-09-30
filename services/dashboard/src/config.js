// @ts-check

const env = process.env;

/** @param {string | undefined} value @param {string} fallback */
const url = (value, fallback) => String(value || fallback).replace(/\/+$/, '');

export const config = {
  port: Number(env.PORT || 3300),
  // Basic-auth password for the whole page. Empty means open, which is right on
  // localhost and wrong anywhere public: the page shows admin-only numbers.
  uiPassword: env.UI_PASSWORD || '',
  // Where the browser is sent when "Open" is pressed. Every service is a
  // published port on the one host, because the edge is Caddy (CLAUDE.md §12).
  publicHost: url(env.PUBLIC_HOST, 'http://157.180.15.165'),
  // Where this container probes from. Usually the same host; a local run can
  // point it at localhost without changing the links.
  probeHost: url(env.PROBE_HOST, env.PUBLIC_HOST || 'http://157.180.15.165'),
  // setInterval clamps NaN to 1ms, which would hammer every service (CLAUDE.md §9).
  probeIntervalMs: Math.max(10, Number(env.PROBE_INTERVAL_SECONDS) || 30) * 1000,
  probeTimeoutMs: Math.max(2, Number(env.PROBE_TIMEOUT_SECONDS) || 8) * 1000,
  // The notifier's ADMIN_TOKEN. Without it the card shows health only.
  notifierAdminToken: env.NOTIFIER_ADMIN_TOKEN || '',
  /** @type {Record<string, string | undefined>} */
  env,
};
