import { config } from '../config.js';
import { getJson, get } from '../http.js';
import { log } from '../log.js';

const API = 'https://www.googleapis.com/youtube/v3';

export const hasApiKey = () => Boolean(config.youtube.apiKey);

/**
 * Quota budget (default 10,000 units/day):
 *   playlistItems.list  1 unit  @30s = 2,880/day   discovers new content
 *   videos.list         1 unit  @20s = 4,320/day   only while a stream is pending
 *   videos.list         1 unit  per poll that finds new ids
 * Well inside the free tier. search.list costs 100 and is never used — one
 * poll every 14 minutes is all it would buy.
 */

/** Resolve "@handle", a channel URL, or a raw UC... id to a channel id. */
export async function resolveChannelId(input) {
  const raw = String(input || '').trim();

  const direct = raw.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];

  let handle = raw;
  const fromUrl = raw.match(/youtube\.com\/(@[\w.\-]+)/i);
  if (fromUrl) handle = fromUrl[1];
  if (!handle.startsWith('@')) handle = `@${handle.replace(/^\/+/, '')}`;

  const data = await getJson(
    `${API}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${config.youtube.apiKey}`,
  );
  const id = data?.items?.[0]?.id;
  if (!id) throw new Error(`channels.list returned no channel for ${handle}`);
  return id;
}

/** Every channel's uploads live in a playlist whose id is its own with UC->UU. */
export const uploadsPlaylistId = (channelId) => `UU${channelId.slice(2)}`;

/**
 * Recent uploads — this is the trigger for everything. New videos, Shorts and
 * live streams all land here, so one cheap call per poll is the whole
 * discovery mechanism.
 *
 * 50 is the page maximum and costs the same single unit as 15. The margin
 * matters: anything pushed out of this window between two successful polls is
 * never seen, and an outage or exhausted quota can mean a long gap.
 */
export async function recentUploads(channelId, max = 50) {
  const data = await getJson(
    `${API}/playlistItems?part=snippet,contentDetails&maxResults=${max}` +
      `&playlistId=${uploadsPlaylistId(channelId)}&key=${config.youtube.apiKey}`,
  );
  return (data.items || [])
    .map((it) => ({
      videoId: it.contentDetails?.videoId,
      title: it.snippet?.title,
      published: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt,
      // The uploader specifically, with no fall back to snippet.channelId —
      // that is the playlist's owner, so falling back would have the effect of
      // assuming ownership rather than establishing it. Absent means unknown,
      // and callers treat unknown as "ask videos.list", never as "ours".
      channelId: it.snippet?.videoOwnerChannelId ?? null,
    }))
    .filter((e) => e.videoId);
}

/** videos.list — 1 unit for up to 50 ids. Gives kind, duration and live state. */
export async function videosList(ids, parts = 'snippet,contentDetails,liveStreamingDetails') {
  if (ids.length === 0) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const url = `${API}/videos?part=${parts}&id=${ids.slice(i, i + 50).join(',')}&key=${config.youtube.apiKey}`;
    const data = await getJson(url);
    out.push(...(data.items || []));
  }
  return out;
}

/** Best thumbnail available from a snippet. */
export function bestThumb(snippet) {
  const t = snippet?.thumbnails || {};
  return (t.maxres || t.standard || t.high || t.medium || t.default || {}).url;
}

/** ISO-8601 duration (PT1M30S) -> seconds. */
export function isoDurationSeconds(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(min || 0) * 60) + Number(s || 0);
}

/**
 * The API has no Shorts flag, so this is the one call that isn't the API:
 * /shorts/<id> answers 200 for a real Short and redirects for anything else.
 * It reads the status code only — no page is downloaded or parsed.
 *
 * Returns true / false / null, and the null matters: youtube.com serves this
 * deployment throttled 404s and 500s, which say nothing about the video. A
 * throttled response must not be read as "not a Short" or every Short would be
 * posted as an ordinary video.
 */
export async function isShort(videoId) {
  try {
    const res = await get(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD',
      redirect: 'manual',
      retries: 0,
      timeoutMs: 8000,
    });
    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400) return false;
    log.debug(`shorts probe inconclusive for ${videoId}: ${res.status}`);
    return null;
  } catch (err) {
    log.debug(`shorts probe failed for ${videoId}: ${err.message}`);
    return null;
  }
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const shortsUrl = (id) => `https://www.youtube.com/shorts/${id}`;
export const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
