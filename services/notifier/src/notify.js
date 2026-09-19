import { markSeen, unmarkSeen, seenWithoutNotifying, flushIfDirty } from './store.js';
import { postEvent } from './slack.js';
import { log } from './log.js';

export const dedupeKey = (event) => `${event.platform}:${event.kind}:${event.id}`;

/**
 * Announce an event exactly once, ever. Every detector (WebSub push, live
 * poller, RSS backstop, Graph webhook, Graph poller, generic ingest) funnels
 * through here, so overlapping detectors are safe by construction.
 */
export async function announce(event) {
  const key = dedupeKey(event);
  if (!markSeen(key)) {
    log.debug(`duplicate suppressed: ${key}`);
    return false;
  }
  try {
    await postEvent(event);
    log.info(`announced ${key} -> ${event.url}`);
    return true;
  } catch (err) {
    // Re-arm so a later detector pass retries instead of losing the event.
    unmarkSeen(key);
    log.error(`slack post failed for ${key} (will retry): ${err.message}`);
    return false;
  } finally {
    flushIfDirty();
  }
}

/** Record an event as already-handled without posting (used for backfill seeding). */
export function suppress(event) {
  seenWithoutNotifying(dedupeKey(event));
}
