import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Service-account access tokens, signed here rather than by googleapis.
 *
 * The whole flow is one RS256 JWT exchanged for a bearer token, which
 * node:crypto does natively — pulling in google-auth-library to do it would
 * multiply this service's dependency count for about forty lines of code.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
// Google's tokens last an hour; renew early so a request never races expiry.
const EARLY_RENEW_MS = 5 * 60 * 1000;

let cached = null; // { token, expiresAt }
let credentials = null;

/** The parsed key, or null when none is configured. Cached after first read. */
export function serviceAccount() {
  if (credentials !== null) return credentials || null;

  const { keyBase64, keyFile } = config.google;
  let raw = '';
  if (keyBase64) {
    // Dokploy delivers env vars, not files, and a PEM private key spans many
    // lines — base64 keeps it to the single line a .env can carry.
    raw = Buffer.from(keyBase64, 'base64').toString('utf8');
  } else if (keyFile && fs.existsSync(keyFile)) {
    raw = fs.readFileSync(keyFile, 'utf8');
  } else {
    credentials = false;
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('missing client_email / private_key');
    }
    credentials = parsed;
    return credentials;
  } catch (err) {
    credentials = false;
    throw new Error(`google service account key is unusable: ${err.message}`);
  }
}

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function accessToken() {
  if (cached && cached.expiresAt - EARLY_RENEW_MS > Date.now()) return cached.token;

  const sa = serviceAccount();
  if (!sa) throw new Error('no Google service account configured');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = b64url(
    crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key),
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`google token exchange failed: ${res.status} ${body.error_description || body.error || ''}`);
  }

  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  log.debug(`google access token obtained for ${sa.client_email}`);
  return cached.token;
}

/** Forget the cached token. Used when a call comes back 401. */
export function resetToken() {
  cached = null;
}
