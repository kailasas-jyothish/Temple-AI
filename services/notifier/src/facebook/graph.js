import crypto from 'node:crypto';
import { config } from '../config.js';
import { getJson } from '../http.js';

const base = () => `https://graph.facebook.com/${config.facebook.graphVersion}`;

/** Graph API GET with the Page access token. Never uses cookies. */
export async function graph(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: config.facebook.pageToken });
  return getJson(`${base()}/${String(path).replace(/^\//, '')}?${qs}`, { retries: 1 });
}

/** Meta signs webhook deliveries with HMAC-SHA256 over the raw body, keyed by the app secret. */
export function verifySignature(rawBody, header) {
  if (!config.facebook.appSecret) return true; // nothing to verify against
  if (!header) return false;
  const [, sig] = String(header).split('=');
  if (!sig) return false;
  const hash = crypto.createHmac('sha256', config.facebook.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(sig.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Graph returns permalink_url absolute for posts and relative for some videos. */
export function absolutePermalink(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `https://www.facebook.com${url}`;
}

/** post_id arrives as "<pageId>_<storyId>"; both forms resolve, this one is canonical. */
export function postPermalink(postId, pageId) {
  if (!postId) return null;
  const [left, right] = String(postId).split('_');
  if (right) return `https://www.facebook.com/${left}/posts/${right}`;
  return `https://www.facebook.com/${pageId || ''}/posts/${left}`.replace('//posts', '/posts');
}

export const reelPermalink = (videoId) => `https://www.facebook.com/reel/${videoId}`;
