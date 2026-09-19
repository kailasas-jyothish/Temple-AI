import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { setMeta } from '../store.js';
import { topicUrls } from './feed.js';

export const CALLBACK_PATH = '/websub/youtube';

export const callbackUrl = () => `${config.publicUrl}${CALLBACK_PATH}`;

/**
 * Subscribe (or renew) the WebSub lease with Google's hub.
 * Re-subscribing is idempotent and simply resets the lease, so this is safe to
 * run on every boot and on a timer.
 */
export async function subscribe(channelId, mode = 'subscribe') {
  if (!config.publicUrl) {
    log.warn('PUBLIC_URL unset — skipping WebSub subscribe (polling still active)');
    return false;
  }

  let anyOk = false;
  for (const topic of topicUrls(channelId)) {
    const body = new URLSearchParams({
      'hub.mode': mode,
      'hub.topic': topic,
      'hub.callback': callbackUrl(),
      'hub.verify': 'async',
      'hub.secret': config.youtube.websubSecret,
      'hub.lease_seconds': String(config.youtube.leaseSeconds),
    });

    const res = await fetch(config.youtube.hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const ok = res.status === 202 || res.status === 204;
    if (ok) {
      anyOk = true;
      log.info(`websub ${mode} accepted (${res.status}) topic=${topic}`);
    } else {
      const text = await res.text().catch(() => '');
      log.warn(`websub ${mode} rejected (${res.status}) topic=${topic}: ${text.slice(0, 200)}`);
    }
  }

  if (anyOk) setMeta('websubLastSubscribe', new Date().toISOString());
  else log.error(`websub ${mode} failed for every topic form`);
  return anyOk;
}

/** Google's hub signs with HMAC-SHA1 over the raw body. */
export function verifySignature(rawBody, header) {
  if (!header) return false;
  const [algo, sig] = String(header).split('=');
  if (!sig) return false;
  const hash = crypto
    .createHmac(algo === 'sha256' ? 'sha256' : 'sha1', config.youtube.websubSecret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(sig.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
