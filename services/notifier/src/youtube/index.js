import { config } from '../config.js';
import { log } from '../log.js';
import { every } from '../http.js';
import {
  isSeeded,
  setSeeded,
  setMeta,
  getMeta,
  watchIds,
  dropWatch,
  watchInfo,
  flushIfDirty,
} from '../store.js';
import { parseAtom } from './feed.js';
import { resolveChannelId, recentUploads, videosList } from './api.js';
import { handleItem, handleIds, alreadyHandled } from './detect.js';
import { subscribe } from './websub.js';

/**
 * Two API pollers, nothing else.
 *
 *   uploads  playlistItems.list — new videos, Shorts and streams all appear here
 *   pending  videos.list        — watch a scheduled stream flip to live
 *
 * Both cost 1 quota unit per call. There is deliberately no HTML scraping:
 * this container is served throttled and unparseable pages by youtube.com,
 * which is what made an earlier scrape-based probe post unrelated channels'
 * videos into Slack.
 *
 * Several channels are watched, and the uploads poll takes ONE of them per
 * tick rather than all of them. playlistItems accepts a single playlist per
 * call, so polling every channel every tick would multiply quota by the number
 * of channels — six channels at 30s is 17,280 units/day against a 10,000/day
 * ceiling. Round-robin keeps the cost flat and pays for it in latency: any one
 * channel is checked every uploadsPollSeconds x channelCount. Scheduled
 * streams don't suffer for it — once discovered they move to the watchlist,
 * which is polled for every channel at once (videos.list takes 50 ids per
 * unit) and so keeps its full precision at the moment of go-live.
 */

// [{ input, id }] for every channel that resolved.
let channels = [];
// Inputs that did not resolve yet; retried one per uploads tick.
let unresolved = [];
let cursor = 0;
const timers = [];

const seedKey = (channelId) => `youtube:${channelId}`;

export const getChannels = () => channels.map((c) => ({ ...c }));
export const getChannelIds = () => channels.map((c) => c.id);

export async function start() {
  channels = [];
  unresolved = [];
  cursor = 0;

  for (const input of config.youtube.channels) {
    if (!(await addChannel(input))) unresolved.push(input);
  }
  // Not fatal even when every channel failed. Resolution needs the API, and the
  // API can be down or out of daily quota at the moment the container happens
  // to boot; throwing here would leave no timers running at all, so nothing
  // would ever retry and YouTube would stay dead until someone restarted it by
  // hand. The pollers cope with an empty channel list and the retry below
  // brings them back on their own.
  if (!channels.length) {
    log.error(
      `no YouTube channel resolved yet (${unresolved.length} pending retry) — ` +
        'starting anyway; the uploads tick retries one per interval',
    );
  }

  migrateSeedFlag();

  // Push is a bonus, never the mechanism. Google's hub needs a public callback
  // it will accept and currently answers 503 to this deployment, so it stays
  // off unless explicitly enabled.
  if (config.youtube.websubEnabled) {
    await subscribeAll();
    timers.push(every(config.youtube.resubscribeSeconds, 'yt-resubscribe', subscribeAll));
  }

  const uploads = every(config.youtube.uploadsPollSeconds, 'yt-uploads', pollTick);
  const pending = every(config.youtube.livePollSeconds, 'yt-pending', pollPending);
  timers.push(uploads, pending);

  // Boot sweeps every channel once instead of waiting for the round-robin to
  // reach each in turn: a redeploy should not leave the last channel in the
  // rotation unseeded (and therefore unable to report anything) for minutes.
  for (const channel of channels) {
    await pollChannel(channel).catch((err) =>
      log.error(`[yt-uploads] ${channel.input}: ${err.message}`),
    );
  }
  pending.runNow();

  const cycle = config.youtube.uploadsPollSeconds * channels.length;
  log.info(
    `youtube detectors running: ${channels.length} channel(s), one checked every ` +
      `${config.youtube.uploadsPollSeconds}s (each every ~${cycle}s), ` +
      `pending streams every ${config.youtube.livePollSeconds}s`,
  );
}

export function stop() {
  timers.forEach((t) => t.stop());
  timers.length = 0;
}

async function addChannel(input) {
  try {
    const id = await resolveChannelId(input);
    if (channels.some((c) => c.id === id)) {
      log.warn(`youtube channel ${input} resolves to ${id}, already watched — skipping`);
      return true;
    }
    channels.push({ input, id });
    setMeta('youtubeChannelIds', getChannelIds());
    log.info(`youtube channel resolved: ${input} -> ${id}`);
    return true;
  } catch (err) {
    // Not fatal on its own: the other channels still work, and this input is
    // retried by the uploads tick rather than being dropped for the lifetime
    // of the process.
    log.error(`youtube channel ${input} could not be resolved: ${err.message}`);
    return false;
  }
}

/**
 * Honour the single 'youtube' seeded flag written when this project watched
 * one channel, so upgrading does not re-seed it. Re-seeding posts nothing —
 * which is the problem: a stream that is live right now would be recorded as
 * backlog and never announced.
 */
function migrateSeedFlag() {
  if (!isSeeded('youtube')) return;
  const prior = getMeta('youtubeChannelId');
  if (prior && !isSeeded(seedKey(prior))) {
    setSeeded(seedKey(prior));
    log.info(`carried the pre-multi-channel seed flag over to ${prior}`);
  }
}

async function subscribeAll() {
  for (const { id } of channels) {
    await subscribe(id).catch((err) => log.error(`websub subscribe failed for ${id}: ${err.message}`));
  }
}

/** Handle a WebSub push body (raw Atom XML). Only reachable when enabled. */
export async function handlePush(xml) {
  const { entries, deleted } = parseAtom(xml);
  try {
    for (const id of deleted) {
      dropWatch(id);
      log.debug(`feed reports deleted video ${id}`);
    }
    await handleIds(entries.map((e) => e.videoId), { source: 'websub push' });
    return entries.length;
  } finally {
    flushIfDirty();
  }
}

/** One tick of the rotation: at most one channel, plus one resolve retry. */
async function pollTick() {
  if (unresolved.length) {
    const input = unresolved.shift();
    if (!(await addChannel(input))) unresolved.push(input);
  }
  if (!channels.length) return;

  if (cursor >= channels.length) cursor = 0;
  const channel = channels[cursor];
  cursor = (cursor + 1) % channels.length;
  await pollChannel(channel);
}

/** Discovery for one channel. One call, plus one more only when something new showed up. */
async function pollChannel({ input, id }) {
  try {
    const uploads = await recentUploads(id);

    // Until the back catalogue has been recorded once, everything found is
    // history rather than news. Per channel, so adding a channel later seeds
    // that one alone instead of replaying its archive into Slack.
    const seeding = !isSeeded(seedKey(id));

    // A null channelId means playlistItems did not state the uploader; that is
    // "unknown", so let it through to the videos.list ownership check rather
    // than assuming either way. Only a known foreign owner is filtered here.
    const candidates = uploads
      .filter((u) => !u.channelId || u.channelId === id)
      .filter((u) => seeding || !alreadyHandled(u.videoId));

    if (candidates.length) {
      log.debug(`uploads poll ${input}: ${candidates.length} id(s) to ${seeding ? 'seed' : 'check'}`);
      await handleIds(
        candidates.map((u) => u.videoId),
        { source: seeding ? 'seed' : 'uploads poll' },
        seeding ? 'seed' : 'notify',
      );
    }

    if (seeding) {
      setSeeded(seedKey(id));
      log.info(`youtube seeded ${input} with ${uploads.length} existing uploads (no Slack posts)`);
    }
  } finally {
    flushIfDirty();
  }
}

/**
 * Scheduled streams and premieres, across every channel in one call. WebSub
 * fires when a broadcast is created, not when it starts, and the uploads
 * playlist can lag — so anything known to be upcoming is polled directly until
 * it goes live.
 */
async function pollPending() {
  const ids = watchIds();
  if (ids.length === 0) return;

  try {
    const items = await videosList(ids);
    const found = new Set();
    for (const item of items) {
      found.add(item.id);
      await handleItem(item, { source: 'stream watch' });
    }

    for (const id of ids) {
      // Gone from the API entirely: deleted or made private.
      if (!found.has(id)) {
        dropWatch(id);
        continue;
      }
      // Otherwise age out on when the stream is DUE, not when we found it. A
      // stream scheduled months ahead would be evicted long before it starts,
      // and its 'upcoming' dedupe key stops pollChannel rediscovering it — so
      // the go-live would be lost with nothing watching for it.
      const info = watchInfo(id);
      const scheduled = Date.parse(info?.scheduledStartTime ?? '');
      const expires = Number.isFinite(scheduled)
        ? scheduled + 7 * 24 * 3600 * 1000
        : (info?.addedAt ?? 0) + 30 * 24 * 3600 * 1000;
      if (expires < Date.now()) {
        log.debug(`dropping stale watch ${id}`);
        dropWatch(id);
      }
    }
  } finally {
    flushIfDirty();
  }
}

/**
 * What the API reports right now, for /admin/recent. Costs 2 units per
 * channel, so it is admin-only and accepts ?channel= to look at just one.
 */
export async function recentReport(filter = '') {
  // Report the pending list here too: "nothing resolved" is exactly the state
  // in which you want to see what it is still retrying.
  if (!channels.length) return { error: 'no channel resolved yet', unresolved };
  const wanted = String(filter).trim().toLowerCase();
  const selected = wanted
    ? channels.filter((c) => c.id.toLowerCase() === wanted || c.input.toLowerCase() === wanted)
    : channels;
  if (!selected.length) return { error: `no watched channel matches ${filter}` };

  const out = { watching: watchIds(), unresolved, channels: [] };
  for (const { input, id } of selected) {
    try {
      const uploads = await recentUploads(id);
      const items = await videosList(uploads.map((u) => u.videoId));
      out.channels.push({
        input,
        channelId: id,
        seeded: isSeeded(seedKey(id)),
        uploads: items.map((it) => ({
          id: it.id,
          title: it.snippet?.title,
          state: it.snippet?.liveBroadcastContent,
          duration: it.contentDetails?.duration,
          handled: alreadyHandled(it.id),
        })),
      });
    } catch (err) {
      out.channels.push({ input, channelId: id, error: err.message });
    }
  }
  return out;
}
