import { config } from '../config.js';
import { log } from '../log.js';
import { announce, suppress } from '../notify.js';
import { addWatch, dropWatch, hasSeen, getMeta } from '../store.js';
import {
  videosList,
  isoDurationSeconds,
  bestThumb,
  watchUrl,
  shortsUrl,
  thumbUrl,
} from './api.js';

const KINDS = ['live', 'upcoming', 'short', 'video'];

/** True once any classification of this video has been announced or seeded. */
export const alreadyHandled = (videoId) => KINDS.some((k) => hasSeen(`youtube:${k}:${videoId}`));

/**
 * Classify one videos.list item and announce it.
 * `mode` = 'notify' (default) or 'seed' (record as handled, post nothing).
 */
export async function handleItem(item, hint = {}, mode = 'notify') {
  // Fails closed: an id whose owner is absent, or is not one of the resolved
  // channels, is never announced. This comparison is the only thing standing
  // between the Slack channel and another channel's video.
  const watched = getMeta('youtubeChannelIds', []);
  const owner = item.snippet?.channelId;
  if (!owner || !watched.includes(owner)) {
    log.warn(`ignoring ${item.id}: published by ${owner || 'unknown'}, not a watched channel`);
    return false;
  }

  const event = await classify(item, hint);
  if (!event) return false;

  if (mode === 'seed' || isStale(event)) {
    suppress(event);
    return false;
  }

  // A stream already announced as LIVE must not re-announce as a plain video
  // when the VOD lands.
  if ((event.kind === 'video' || event.kind === 'upcoming') && hasSeen(`youtube:live:${item.id}`)) {
    log.debug(`skipping ${event.kind} for ${item.id}: already announced live`);
    return false;
  }

  const posted = await announce(event);

  // The watchlist is the only thing that retries a live start: announce()
  // re-arms the dedupe key when Slack fails, so keep polling this stream until
  // the key sticks. hasSeen covers both a fresh success and an earlier one.
  if (event.kind === 'live' && hasSeen(`youtube:live:${item.id}`)) dropWatch(item.id);

  return posted;
}

/**
 * A finished video old enough that announcing it would be reporting history.
 * Recorded as handled rather than dropped, so it is not re-judged every poll.
 * Streams are never stale by age — one can be scheduled weeks ahead, and a
 * broadcast that starts today is news however long ago it was created.
 */
function isStale(event) {
  if (event.kind === 'live' || event.kind === 'upcoming') return false;
  const published = Date.parse(event.publishedAt ?? '');
  if (!Number.isFinite(published)) return false;
  const age = Date.now() - published;
  if (age <= config.youtube.maxAgeHours * 3600 * 1000) return false;
  log.debug(`suppressing ${event.kind} ${event.id}: published ${Math.round(age / 3600000)}h ago`);
  return true;
}

/** Fetch details for ids and handle them. One quota unit per 50 ids. */
export async function handleIds(ids, hint = {}, mode = 'notify') {
  if (ids.length === 0) return 0;
  let posted = 0;
  for (const item of await videosList(ids)) {
    if (await handleItem(item, hint, mode)) posted++;
  }
  return posted;
}

async function classify(item, hint) {
  const snippet = item.snippet || {};
  const live = item.liveStreamingDetails;
  const lbc = snippet.liveBroadcastContent; // 'live' | 'upcoming' | 'none'
  const base = {
    platform: 'youtube',
    id: item.id,
    title: snippet.title || '',
    author: snippet.channelTitle || '',
    publishedAt: snippet.publishedAt,
    thumbnail: bestThumb(snippet) || thumbUrl(item.id),
    source: hint.source,
  };

  // Note this does NOT drop the watchlist entry — handleItem does that only
  // once the announcement has actually landed.
  if (lbc === 'live' || (live?.actualStartTime && !live?.actualEndTime)) {
    return { ...base, kind: 'live', url: watchUrl(item.id) };
  }

  if (lbc === 'upcoming') {
    addWatch(item.id, { title: base.title, scheduledStartTime: live?.scheduledStartTime });
    if (!config.youtube.notifyUpcoming) return null;
    return { ...base, kind: 'upcoming', url: watchUrl(item.id) };
  }

  dropWatch(item.id);

  // Finished broadcast: only interesting if we never caught the live start.
  if (live?.actualEndTime && hasSeen(`youtube:live:${item.id}`)) return null;

  // The API exposes no Shorts flag, so duration is the signal: a Short is
  // capped at 3 minutes. Deliberately a heuristic rather than the definitive
  // /shorts/<id> probe — that probe is a youtube.com request, and youtube.com
  // answers this deployment with throttled 404s and 500s, so it contributes no
  // information here while adding latency to every candidate. A misjudged
  // short clip gets the wrong label; the link works either way.
  const seconds = isoDurationSeconds(item.contentDetails?.duration);
  if (seconds !== null && seconds > 0 && seconds <= config.youtube.shortMaxSeconds) {
    return { ...base, kind: 'short', url: shortsUrl(item.id) };
  }

  return { ...base, kind: 'video', url: watchUrl(item.id) };
}
