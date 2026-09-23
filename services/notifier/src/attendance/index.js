import { config } from '../config.js';
import { log } from '../log.js';
import { every } from '../http.js';
import { getMeta, setMeta, flushIfDirty } from '../store.js';
import { postMessage, postPlain } from '../slack.js';
import { serviceAccount } from '../google/auth.js';
import { videosList, recentUploads, watchUrl, thumbUrl } from '../youtube/api.js';
import { templeForChannel, allTemples } from './temples.js';
import { matchesGarbhaMandir, utcDateLabel, utcDayStart, localTimeLabel } from './match.js';
import { readLayout, ensureGroup, groupFor, writeStarted, markAbsentees, STATUS } from './sheet.js';
import { captureFrame, snapshotUrl, lastCapture } from './snapshot.js';

/**
 * Attendance for the 24/7 Garbha Mandir streams.
 *
 * Only a live start whose title matches the Garbha Mandir naming counts — a
 * festival puja or a satsang is not attendance, however live it is. The date
 * column is UTC (the report is read from Guinea-Bissau, UTC+0); the time
 * written into the cell is the temple's own local clock.
 */

const QUEUE_KEY = 'attendanceQueue';
const LIVE_KEY = 'attendanceLive';
const CLOSED_KEY = 'attendanceClosedDate';
const SCANNED_KEY = 'attendanceScannedDate';

let timer = null;

const queue = () => getMeta(QUEUE_KEY, []);
const setQueue = (items) => setMeta(QUEUE_KEY, items);
const liveStreams = () => getMeta(LIVE_KEY, {});

export const isEnabled = () =>
  config.attendance.enabled && Boolean(config.attendance.spreadsheetId) && Boolean(serviceAccount());

export function start() {
  if (!isEnabled()) {
    log.info('attendance: disabled (needs ATTENDANCE_ENABLED, a spreadsheet id and a service account)');
    return;
  }
  timer = every(config.attendance.sweepSeconds, 'attendance-sweep', sweep);
  timer.runNow();
  log.info(
    `attendance: watching ${config.attendance.tab} — sweep every ${config.attendance.sweepSeconds}s, ` +
      `continuation credit ${config.attendance.continuationHours}h`,
  );
}

export function stop() {
  timer?.stop();
  timer = null;
}

/**
 * Called for every YouTube live event. Returns why it was ignored, or null
 * when it was taken — the caller only logs this.
 */
export async function recordLive(item, event) {
  if (!isEnabled()) return 'attendance disabled';

  const channelId = item.snippet?.channelId;
  const temple = templeForChannel(channelId);
  if (!temple) return `channel ${channelId} is not mapped to a temple`;

  const matched = matchesGarbhaMandir(event.title, temple.patterns);
  if (!matched) return `title does not name the Garbha Mandir stream: "${event.title}"`;

  const startedAt = item.liveStreamingDetails?.actualStartTime || event.publishedAt || new Date().toISOString();

  // Remembering the stream is what lets a genuinely continuous broadcast keep
  // counting tomorrow: it fires one live event and then stays up for days.
  setMeta(LIVE_KEY, {
    ...liveStreams(),
    [channelId]: { videoId: item.id, startedAt, title: event.title },
  });

  enqueue({
    channelId,
    videoId: item.id,
    date: utcDateLabel(startedAt),
    startedAt,
    title: event.title,
  });
  log.info(`attendance: ${temple.row} matched "${matched}" — queued for ${utcDateLabel(startedAt)}`);
  await flush();
  return null;
}

function enqueue(entry) {
  const items = queue();
  // One mark per temple per date. First one wins, so a second stream the same
  // day is not even queued.
  if (items.some((i) => i.channelId === entry.channelId && i.date === entry.date)) return;
  setQueue([...items, { ...entry, attempts: 0 }]);
  flushIfDirty();
}

/** Work the queue. Anything that fails stays on it and is retried next sweep. */
async function flush() {
  const items = queue();
  if (!items.length) return;

  const remaining = [];
  for (const item of items) {
    try {
      await applyMark(item);
    } catch (err) {
      const attempts = (item.attempts || 0) + 1;
      log.error(`attendance: write failed for ${item.date} (attempt ${attempts}): ${err.message}`);
      // Report once, then keep retrying quietly — a Sheets outage should cost
      // one message, not one per sweep.
      if (attempts === config.attendance.alertAfterAttempts && !item.alerted) {
        await reportFailure(item, err).catch(() => {});
        item.alerted = true;
      }
      remaining.push({ ...item, attempts });
    }
  }
  setQueue(remaining);
  flushIfDirty();
}

async function applyMark(item) {
  const temple = templeForChannel(item.channelId);
  if (!temple) throw new Error(`no temple mapped to ${item.channelId}`);

  const { layout, group } = await ensureGroup(item.date);
  if (!group) throw new Error(`could not create the column group for ${item.date}`);

  const row = layout.rows.get(temple.row.toLowerCase());
  if (!row) {
    // Failing closed matters here: writing to a guessed row would put one
    // temple's attendance against another's name.
    throw new Error(
      `"${temple.row}" is not in column A of ${config.attendance.tab} — was it renamed?`,
    );
  }

  const name = await captureFrame(item.videoId, item.date);
  const image = snapshotUrl(name) || thumbUrl(item.videoId);

  // A continuing stream is credited under today's date but started earlier, so
  // say so — "11:10 AM PDT" in the 23-Sep column, with no hint it began on the
  // 21st, is the kind of cell someone reasonably misreads.
  const startedOn = utcDateLabel(item.startedAt);
  const clock = localTimeLabel(item.startedAt, temple.tz);
  const localTime = startedOn === item.date ? clock : `${clock} (since ${startedOn.slice(0, 6)})`;

  const written = await writeStarted(layout, group, row, {
    url: watchUrl(item.videoId),
    localTime,
    imageFormula: image ? `=IMAGE("${image}",4,60,107)` : '',
  });

  if (written) {
    log.info(`attendance: ${temple.row} marked Started for ${item.date}`);
    await notifyMarked(temple, item, name ? 'live frame' : 'thumbnail').catch((err) =>
      log.warn(`attendance: Slack notice failed: ${err.message}`),
    );
  }
}

/** Periodic work: roll the day, keep continuing streams credited, close the past. */
async function sweep() {
  const today = utcDateLabel();

  await ensureGroup(today);
  await discoverLiveStreams(today);
  await creditContinuingStreams(today);
  await closePreviousDay(today);
  await flush();
}

/**
 * Find streams that are already live, once per UTC day.
 *
 * Without this the feature would come up blind. Attendance normally learns
 * about a stream from the live event, but that event only fires for a video
 * the notifier has not seen before — and on the first deploy every running
 * stream is already in the dedupe store from seeding. A 24/7 stream that has
 * been up since yesterday would therefore never be noticed, and its temple
 * would read Absent while visibly broadcasting. Costs two quota units per
 * channel, once a day.
 */
async function discoverLiveStreams(today) {
  if (getMeta(SCANNED_KEY) === today) return;

  const found = { ...liveStreams() };
  for (const temple of allTemples()) {
    if (!temple.channelId) continue;
    try {
      const uploads = await recentUploads(temple.channelId);
      const items = await videosList(uploads.map((u) => u.videoId).filter(Boolean));
      const live = items
        .filter(
          (i) =>
            i.snippet?.channelId === temple.channelId &&
            i.snippet?.liveBroadcastContent === 'live' &&
            !i.liveStreamingDetails?.actualEndTime &&
            matchesGarbhaMandir(i.snippet.title, temple.patterns),
        )
        // If they restarted the broadcast, the newest one is the current one,
        // and its fresher start time is what the credit window should run from.
        .sort(
          (a, b) =>
            Date.parse(b.liveStreamingDetails?.actualStartTime || 0) -
            Date.parse(a.liveStreamingDetails?.actualStartTime || 0),
        );

      if (!live.length) continue;
      const item = live[0];
      found[temple.channelId] = {
        videoId: item.id,
        startedAt: item.liveStreamingDetails?.actualStartTime || item.snippet.publishedAt,
        title: item.snippet.title,
      };
      log.info(`attendance: ${temple.row} is already live on ${item.id} — tracking it`);
    } catch (err) {
      // A channel that fails today is retried tomorrow; the rest still scan.
      log.warn(`attendance: live scan failed for ${temple.row}: ${err.message}`);
    }
  }
  setMeta(LIVE_KEY, found);
  setMeta(SCANNED_KEY, today);
}

/**
 * A stream that is still running counts for today too, up to the continuation
 * window. The temples are meant to restart the broadcast periodically; until
 * they do, a stream that has been up for two days is still a live Garbha
 * Mandir, and reporting it Absent would be wrong.
 */
async function creditContinuingStreams(today) {
  const active = liveStreams();
  const ids = Object.values(active).map((s) => s.videoId);
  if (!ids.length) return;

  // One quota unit for every tracked stream at once.
  const items = await videosList(ids);
  const byId = new Map(items.map((i) => [i.id, i]));
  const next = {};

  for (const [channelId, stream] of Object.entries(active)) {
    const item = byId.get(stream.videoId);
    const details = item?.liveStreamingDetails;
    const stillLive =
      item && !details?.actualEndTime && item.snippet?.liveBroadcastContent === 'live';
    if (!stillLive) {
      log.info(`attendance: ${stream.videoId} is no longer live — dropping it from continuation`);
      continue;
    }

    const ageHours = (Date.now() - Date.parse(stream.startedAt)) / 3600000;
    if (ageHours > config.attendance.continuationHours) {
      log.info(
        `attendance: ${stream.videoId} has been live ${Math.round(ageHours)}h, past the ` +
          `${config.attendance.continuationHours}h credit window — it needs restarting`,
      );
      continue;
    }

    next[channelId] = stream;
    enqueue({
      channelId,
      videoId: stream.videoId,
      date: today,
      startedAt: stream.startedAt,
      title: stream.title,
    });
  }
  setMeta(LIVE_KEY, next);
}

/** Once a UTC day is over, whatever is still pending was a no-show. */
async function closePreviousDay(today) {
  if (getMeta(CLOSED_KEY) === today) return;

  const yesterday = utcDateLabel(utcDayStart() - 1);
  const layout = await readLayout({ force: true });
  if (!groupFor(layout, yesterday)) {
    setMeta(CLOSED_KEY, today);
    return;
  }

  const n = await markAbsentees(yesterday);
  setMeta(CLOSED_KEY, today);
  if (n) log.info(`attendance: closed ${yesterday} — ${n} temple(s) marked ${STATUS.absent}`);
}

async function notifyMarked(temple, item, imageSource) {
  if (!config.attendance.notifySlack) return;
  await postPlain(
    `:white_check_mark: *${temple.row}* marked *Started* for ${item.date} — ` +
      `${localTimeLabel(item.startedAt, temple.tz)} · <${watchUrl(item.videoId)}|stream> (${imageSource})`,
  );
}

async function reportFailure(item, err) {
  const temple = templeForChannel(item.channelId);
  await postMessage({
    text: `Attendance sheet write failed for ${temple?.row || item.channelId} on ${item.date}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:x: *Attendance sheet write failed*\n` +
            `*Temple:* ${temple?.row || item.channelId}\n` +
            `*Date:* ${item.date}\n` +
            `*Error:* \`${String(err.message).slice(0, 300)}\`\n` +
            'It stays queued and will keep retrying.',
        },
      },
    ],
    unfurl_links: false,
  });
}

/** For /admin/attendance. */
export function statusReport() {
  return {
    enabled: isEnabled(),
    spreadsheetId: config.attendance.spreadsheetId || null,
    tab: config.attendance.tab,
    today: utcDateLabel(),
    queued: queue(),
    live: liveStreams(),
    closedThrough: getMeta(CLOSED_KEY, null),
    lastSnapshot: lastCapture(),
  };
}

/** Force one capture attempt and report exactly what happened. Admin only. */
export async function probeSnapshot(videoId) {
  const name = await captureFrame(videoId, utcDateLabel(), { force: true });
  return { name, url: name ? snapshotUrl(name) : null, result: lastCapture() };
}

export { sweep };
