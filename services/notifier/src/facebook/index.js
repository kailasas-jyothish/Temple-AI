import { config } from '../config.js';
import { log } from '../log.js';
import { every } from '../http.js';
import { announce, suppress } from '../notify.js';
import { isSeeded, setSeeded, flushIfDirty } from '../store.js';
import { graph, absolutePermalink, postPermalink, reelPermalink } from './graph.js';

const timers = [];

const ITEM_KIND = {
  status: 'post',
  photo: 'photo',
  album: 'album',
  video: 'video',
  reel: 'reel',
  share: 'share',
  link: 'link',
};

// Engagement events are noise for this bot.
const IGNORED_ITEMS = new Set(['comment', 'like', 'reaction', 'mention']);

export async function start() {
  if (!config.facebook.enabled) {
    log.info('facebook disabled (set FACEBOOK_ENABLED=true with a Page token to turn it on)');
    return;
  }
  if (!config.facebook.pageId || !config.facebook.pageToken) {
    log.error('facebook enabled but FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN missing — skipping');
    return;
  }

  try {
    const me = await graph(config.facebook.pageId, { fields: 'id,name' });
    log.info(`facebook page: ${me.name} (${me.id})`);
  } catch (err) {
    log.error(`facebook token check failed: ${err.message}`);
  }

  if (!isSeeded('facebook')) {
    await sweep('seed').catch((err) => log.error(`facebook seeding failed: ${err.message}`));
    setSeeded('facebook');
    flushIfDirty();
    log.info('facebook seeded with existing content (no Slack posts)');
  }

  if (config.facebook.pollEnabled) {
    timers.push(every(config.facebook.pollSeconds, 'fb-poll', () => sweep('notify')));
  }
  log.info('facebook detectors running');
}

export function stop() {
  timers.forEach((t) => t.stop());
  timers.length = 0;
}

/**
 * Handle a Meta webhook body. Fields we subscribe to: `feed` (posts, photos,
 * videos, reels, shares) and `live_videos` (stream start/stop).
 */
export async function handleWebhook(body) {
  if (body?.object !== 'page') return 0;
  let handled = 0;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      if (change.field === 'feed') {
        if (value.verb && value.verb !== 'add') continue;
        const item = String(value.item || 'status').toLowerCase();
        if (IGNORED_ITEMS.has(item)) continue;

        const postId = value.post_id || value.share_id || value.video_id || value.photo_id;
        if (!postId) continue;

        const url = (await permalinkFor(postId)) || postPermalink(postId, entry.id);
        await announce({
          platform: 'facebook',
          kind: ITEM_KIND[item] || 'post',
          id: String(postId),
          url,
          title: value.message || value.story || '(no caption)',
          thumbnail: value.full_picture || value.link || undefined,
          publishedAt: value.created_time ? new Date(value.created_time * 1000).toISOString() : undefined,
          source: 'graph webhook',
        });
        handled++;
        continue;
      }

      if (change.field === 'live_videos') {
        const status = String(value.status || '').toLowerCase();
        const id = value.id;
        if (!id) continue;
        if (status === 'live') {
          const info = await safeGraph(id, 'permalink_url,title,description,status');
          await announce({
            platform: 'facebook',
            kind: 'live',
            id: String(id),
            url: absolutePermalink(info?.permalink_url) || `https://www.facebook.com/${id}`,
            title: info?.title || info?.description || 'Live now',
            source: 'graph webhook',
          });
          handled++;
        } else if (status === 'vod_ready') {
          log.debug(`live video ${id} VOD ready`);
        }
      }
    }
  }
  return handled;
}

/** Poll the Page's own edges — safety net for missed webhook deliveries. */
async function sweep(mode) {
  const pageId = config.facebook.pageId;
  const emit = mode === 'seed' ? suppress : announce;

  const feed = await safeGraph(`${pageId}/feed`, 'id,permalink_url,message,story,created_time,status_type,full_picture', 15);
  for (const p of feed?.data || []) {
    await emit({
      platform: 'facebook',
      kind: statusTypeKind(p.status_type),
      id: String(p.id),
      url: absolutePermalink(p.permalink_url) || postPermalink(p.id, pageId),
      title: p.message || p.story || '(no caption)',
      thumbnail: p.full_picture,
      publishedAt: p.created_time,
      source: 'graph poll',
    });
  }

  const reels = await safeGraph(`${pageId}/video_reels`, 'id,title,description,permalink_url,created_time', 10);
  for (const r of reels?.data || []) {
    await emit({
      platform: 'facebook',
      kind: 'reel',
      id: String(r.id),
      url: absolutePermalink(r.permalink_url) || reelPermalink(r.id),
      title: r.title || r.description || 'Reel',
      publishedAt: r.created_time,
      source: 'graph poll',
    });
  }

  const lives = await safeGraph(`${pageId}/live_videos`, 'id,status,permalink_url,title,description,creation_time', 5);
  for (const l of lives?.data || []) {
    if (String(l.status || '').toLowerCase() !== 'live') continue;
    await emit({
      platform: 'facebook',
      kind: 'live',
      id: String(l.id),
      url: absolutePermalink(l.permalink_url) || `https://www.facebook.com/${l.id}`,
      title: l.title || l.description || 'Live now',
      publishedAt: l.creation_time,
      source: 'graph poll',
    });
  }

  flushIfDirty();
}

function statusTypeKind(statusType) {
  switch (String(statusType || '').toLowerCase()) {
    case 'added_photos': return 'photo';
    case 'added_video': return 'video';
    case 'shared_story': return 'share';
    case 'mobile_status_update':
    case 'created_note':
    default: return 'post';
  }
}

async function permalinkFor(id) {
  const info = await safeGraph(id, 'permalink_url');
  return absolutePermalink(info?.permalink_url);
}

async function safeGraph(path, fields, limit) {
  try {
    const params = { fields };
    if (limit) params.limit = String(limit);
    return await graph(path, params);
  } catch (err) {
    log.debug(`graph ${path} failed: ${err.message}`);
    return null;
  }
}
