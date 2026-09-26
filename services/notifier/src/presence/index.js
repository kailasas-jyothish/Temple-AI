import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { every } from '../http.js';
import { getMeta, setMeta, flushIfDirty } from '../store.js';
import { postMessage } from '../slack.js';
import { watchUrl } from '../youtube/api.js';
import { templeByKey } from '../attendance/temples.js';
import { currentStream } from '../attendance/index.js';
import { parseSchedule, dueSlots, nextSlot, localDate, localClock, daysLabel } from './schedule.js';
import { nextStep, pruneFired, STATUS } from './scheduler.js';
import { fetchFrame } from './gateway.js';
import { classify } from './vision.js';
import { frameName, saveFrame, pruneFrames } from './frames.js';
import { readScheduleRows, appendResult } from './sheet.js';

/**
 * Pujari presence: at each scheduled ritual time, take a frame off the
 * temple's live stream and ask a vision model whether a pujari is at the
 * deity doing the puja.
 *
 * All progress lives in the JSON store — which slots have fired, which checks
 * are mid-window, which sheet rows are still unwritten — so a restart resumes
 * a check rather than losing it, and never fires the same slot twice.
 */

const FIRED_KEY = 'presenceFired'; // { slotKey: firedAtMs }
const ACTIVE_KEY = 'presenceActive'; // { slotKey: check }
const QUEUE_KEY = 'presenceQueue'; // [{ result, attempts, alerted }]
const RECENT_KEY = 'presenceRecent'; // newest first, for /admin/presence

const TICK_SECONDS = 30;
const RECENT_LIMIT = 50;
// Same as attendance: one Slack message per Sheets outage, not one per tick.
const ALERT_AFTER_ATTEMPTS = 3;

let schedule = { entries: null, errors: [], noTz: [], source: null, loadedAt: null };
let lastReported = '';
let timers = [];
let ticking = false;
const running = new Set();

export const isEnabled = () => config.presence.enabled;

export function start() {
  if (!isEnabled()) {
    log.info('presence: disabled (PRESENCE_ENABLED=false)');
    return;
  }
  const refresh = every(config.presence.scheduleRefreshSeconds, 'presence-schedule', loadSchedule);
  const tickTimer = every(TICK_SECONDS, 'presence-tick', tick);
  timers = [refresh, tickTimer];
  refresh.runNow().then(() => tickTimer.runNow());
  log.info(
    `presence: on — schedule every ${config.presence.scheduleRefreshSeconds}s, retry every ` +
      `${config.presence.retryMinutes} min within grace, results to ${config.presence.resultsTab}`,
  );
}

export function stop() {
  for (const t of timers) t.stop();
  timers = [];
}

/**
 * Re-read the schedule. A failed read keeps the previous one: a Sheets blip
 * should not cancel the day's checks.
 */
export async function loadSchedule() {
  const { source, rows } = await readScheduleRows();
  const parsed = parseSchedule(rows, {
    findTemple: templeByKey,
    defaultGrace: config.presence.defaultGraceMinutes,
  });
  schedule = { ...parsed, source, loadedAt: new Date().toISOString() };

  // Every ten minutes is too often to repeat the same complaint.
  const report = JSON.stringify([parsed.entries.length, parsed.errors, parsed.noTz]);
  if (report !== lastReported) {
    lastReported = report;
    log.info(`presence: ${parsed.entries.length} slot(s) from ${source}`);
    for (const e of parsed.errors) log.warn(`presence: schedule ${e} — skipped`);
    if (parsed.noTz.length) {
      log.warn(`presence: no timezone in temples.json for ${parsed.noTz.join(', ')} — their rows are skipped`);
    }
  }
  return schedule;
}

export const currentSchedule = () => schedule;

// ------------------------------------------------------------------- tick

async function tick() {
  if (ticking || !schedule.entries) return;
  ticking = true;
  try {
    const now = Date.now();
    const fired = pruneFired(getMeta(FIRED_KEY, {}), now);
    const active = getMeta(ACTIVE_KEY, {});

    const { fire, missed } = dueSlots(schedule.entries, now, new Set(Object.keys(fired)));
    for (const { slot } of missed) {
      // Only reachable after downtime. Checking now and calling it Late or
      // Absent would be reporting on the service, not the pujari.
      log.info(`presence: missed ${slot.key} — its grace window ended before the service could check`);
      fired[slot.key] = now;
    }
    for (const { entry, slot } of fire) {
      fired[slot.key] = now;
      active[slot.key] = newCheck(entry, slot, now);
      log.info(`presence: ${slot.key} is due — checking`);
    }
    setMeta(FIRED_KEY, fired);
    setMeta(ACTIVE_KEY, active);
    flushIfDirty();

    const retryMs = config.presence.retryMinutes * 60_000;
    for (const [key, check] of Object.entries(active)) {
      if (running.has(key) || check.nextAttemptAt > now) continue;
      if (now > check.graceEndsAt + retryMs) {
        // Resumed after downtime that swallowed the rest of the window.
        if (check.sawNegative) {
          await finalize(check, { kind: 'absent', ...check.lastNegative }, { status: STATUS.absent, minutesLate: null, basis: 'this' });
        } else {
          log.info(`presence: missed ${key} — the service was down for the rest of its window`);
          delete active[key];
          setMeta(ACTIVE_KEY, active);
        }
        continue;
      }
      // Not awaited: one slow gateway or model call must not hold up the
      // temples whose ritual is at the same minute.
      runAttempt(key).catch((err) => log.error(`presence: ${key} attempt crashed: ${err.message}`));
    }

    await flushQueue();
    pruneFrames(now);
  } finally {
    ticking = false;
    flushIfDirty();
  }
}

function newCheck(entry, slot, now) {
  return {
    key: slot.key,
    templeKey: entry.templeKey,
    templeRow: entry.templeRow,
    tz: entry.tz,
    ritual: entry.ritual,
    time: entry.time,
    date: slot.date,
    scheduledAt: slot.scheduledAt,
    graceEndsAt: slot.graceEndsAt,
    attempts: 0,
    nextAttemptAt: now,
    sawNegative: false,
    lastNegative: null,
    lastError: null,
  };
}

async function runAttempt(key) {
  const active = getMeta(ACTIVE_KEY, {});
  const check = active[key];
  if (!check) return;
  running.add(key);
  try {
    check.attempts += 1;
    const outcome = await attempt(check);
    const step = nextStep(check, outcome, Date.now(), config.presence.retryMinutes * 60_000);

    if (step.retryAt) {
      if (outcome.kind === 'absent') {
        check.sawNegative = true;
        check.lastNegative = pick(outcome);
      } else {
        check.lastError = outcome.reason;
      }
      check.nextAttemptAt = step.retryAt;
      log.info(
        `presence: ${key} attempt ${check.attempts}: ${outcome.kind === 'absent' ? 'no pujari' : outcome.reason} — ` +
          `retrying at ${localClock(step.retryAt, check.tz)}`,
      );
      setMeta(ACTIVE_KEY, active);
      return;
    }
    const evidence = step.basis === 'earlier' ? { kind: 'absent', ...check.lastNegative, lastError: outcome.reason } : outcome;
    await finalize(check, evidence, step);
  } finally {
    running.delete(key);
    flushIfDirty();
  }
}

// What survives into the store from a negative attempt. Not the JPEG.
const pick = (o) => ({ checkedAt: o.checkedAt, verdict: o.verdict, frameUrl: o.frameUrl, videoId: o.videoId, provider: o.provider });

/**
 * One look: stream -> frame -> verdict. Never throws; every failure becomes
 * an outcome the scheduler can decide on.
 */
async function attempt(check, { dryRun = false, videoId: forcedVideo = '' } = {}) {
  const now = Date.now();
  const videoId = forcedVideo || currentStream(check.templeKey)?.videoId;
  if (!videoId) {
    return { kind: 'no_stream', checkedAt: now, reason: 'no live stream is being tracked for this temple' };
  }

  let frame;
  try {
    frame = await fetchFrame(videoId, { width: 960 });
  } catch (err) {
    if (err.code === 'not_live') {
      return { kind: 'no_stream', checkedAt: now, videoId, reason: `stream ${videoId} is not live` };
    }
    return { kind: 'error', checkedAt: now, videoId, reason: err.message };
  }

  const name = frameName(check, check.date);
  let result;
  try {
    result = await classify(frame.jpeg, { ritual: check.ritual });
  } catch (err) {
    return { kind: 'error', checkedAt: frame.capturedAt, videoId, jpeg: frame.jpeg, name, reason: `vision: ${err.message}` };
  }

  const out = {
    kind: result.present ? 'present' : 'absent',
    checkedAt: frame.capturedAt,
    videoId,
    verdict: result.verdict,
    provider: `${result.provider}/${result.model}`,
  };
  Object.assign(out, storeFrame(name, frame.jpeg, dryRun));
  return out;
}

function storeFrame(name, jpeg, dryRun) {
  try {
    if (dryRun) {
      const file = path.join(os.tmpdir(), name);
      fs.writeFileSync(file, jpeg);
      return { framePath: file };
    }
    return { frameUrl: saveFrame(name, jpeg) };
  } catch (err) {
    log.warn(`presence: could not save frame ${name}: ${err.message}`);
    return {};
  }
}

// --------------------------------------------------------------- results

const zoneAbbr = (ms, tz) => {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date(ms))
        .find((p) => p.type === 'timeZoneName')?.value || ''
    );
  } catch {
    return '';
  }
};
const clockLabel = (ms, tz) => `${localClock(ms, tz)} ${zoneAbbr(ms, tz)}`.trim();

function detailOf(outcome) {
  const v = outcome.verdict;
  let text = v ? [v.activity, v.reason].filter(Boolean).join(' — ') : outcome.reason || '';
  if (outcome.lastError) text += ` (last attempt failed: ${outcome.lastError})`;
  return text.slice(0, 500);
}

function buildResult(check, outcome, step) {
  // An Error that did get a frame keeps it: the picture is often the
  // quickest way to see what went wrong.
  if (outcome.jpeg && !outcome.frameUrl && !outcome.framePath) {
    Object.assign(outcome, storeFrame(outcome.name, outcome.jpeg, outcome.dryRun));
  }
  const checkedAt = outcome.checkedAt || Date.now();
  return {
    key: check.key,
    date: check.date,
    templeRow: check.templeRow,
    ritual: check.ritual,
    tz: check.tz,
    scheduledAt: check.scheduledAt,
    scheduledLabel: clockLabel(check.scheduledAt, check.tz),
    checkedAt,
    checkedLabel: clockLabel(checkedAt, check.tz),
    status: step.status,
    minutesLate: step.minutesLate,
    confidence: outcome.verdict ? Number(outcome.verdict.confidence.toFixed(2)) : null,
    verdict: outcome.verdict || null,
    detail: detailOf(outcome),
    frameUrl: outcome.frameUrl || null,
    framePath: outcome.framePath || null,
    videoId: outcome.videoId || null,
    streamUrl: outcome.videoId ? watchUrl(outcome.videoId) : null,
    provider: outcome.provider || null,
    attempts: check.attempts,
  };
}

async function finalize(check, outcome, step) {
  const result = buildResult(check, outcome, step);
  log.info(`presence: ${check.key} -> ${result.status}${result.detail ? ` (${result.detail})` : ''}`);

  setMeta(RECENT_KEY, [result, ...getMeta(RECENT_KEY, [])].slice(0, RECENT_LIMIT));
  setMeta(QUEUE_KEY, [...getMeta(QUEUE_KEY, []), { result, attempts: 0 }]);
  const active = getMeta(ACTIVE_KEY, {});
  delete active[check.key];
  setMeta(ACTIVE_KEY, active);
  flushIfDirty();

  await notify(result).catch((err) => log.warn(`presence: Slack notice failed: ${err.message}`));
  await flushQueue();
  return result;
}

/** Write queued rows. A failure stays queued and is retried next tick. */
async function flushQueue() {
  const items = getMeta(QUEUE_KEY, []);
  if (!items.length) return;
  const remaining = [];
  for (const item of items) {
    try {
      await appendResult(item.result);
    } catch (err) {
      const attempts = (item.attempts || 0) + 1;
      log.error(`presence: sheet write failed for ${item.result.key} (attempt ${attempts}): ${err.message}`);
      if (attempts === ALERT_AFTER_ATTEMPTS && !item.alerted) {
        item.alerted = true;
        await post({
          text: `Puja attendance sheet write failed for ${item.result.templeRow} ${item.result.ritual}`,
          blocks: [
            section(
              `:x: *Puja attendance sheet write failed*\n*Slot:* ${esc(item.result.key)}\n` +
                `*Error:* \`${esc(String(err.message).slice(0, 300))}\`\nIt stays queued and will keep retrying.`,
            ),
          ],
        }).catch(() => {});
      }
      remaining.push({ ...item, attempts });
    }
  }
  // Rows finalised while this ran were appended to the stored queue; keep them.
  const added = getMeta(QUEUE_KEY, []).slice(items.length);
  setMeta(QUEUE_KEY, [...remaining, ...added]);
  flushIfDirty();
}

// ----------------------------------------------------------------- Slack

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

// The override only works with a bot token; a webhook posts where it was made.
const post = (payload) =>
  postMessage({
    ...(config.presence.slackChannel ? { channel: config.presence.slackChannel } : {}),
    unfurl_links: false,
    unfurl_media: false,
    ...payload,
  });

const ICON = {
  [STATUS.absent]: ':x:',
  [STATUS.noStream]: ':no_entry_sign:',
  [STATUS.error]: ':warning:',
};

async function notify(r) {
  const links = [r.frameUrl && `<${r.frameUrl}|frame>`, r.streamUrl && `<${r.streamUrl}|stream>`]
    .filter(Boolean)
    .join(' · ');

  if (r.status === STATUS.present) {
    if (!config.presence.notifyPresent) return;
    await post({
      text:
        `:white_check_mark: *${esc(r.templeRow)}* — ${esc(r.ritual)} ${r.scheduledLabel}: pujari present ` +
        `(checked ${r.checkedLabel})${links ? ` · ${links}` : ''}`,
    });
    return;
  }

  const icon = ICON[r.status] || ':hourglass_flowing_sand:';
  const body =
    `${icon} *${esc(r.templeRow)} — ${esc(r.ritual)}: ${esc(r.status)}*\n` +
    `*Scheduled:* ${r.scheduledLabel} · *Checked:* ${r.checkedLabel} (${r.date})\n` +
    (r.detail ? `*Reason:* ${esc(r.detail)}\n` : '') +
    (links || '_no frame_');
  await post({
    text: `${r.templeRow} ${r.ritual}: ${r.status}`,
    blocks: [
      {
        ...section(body),
        ...(r.frameUrl ? { accessory: { type: 'image', image_url: r.frameUrl, alt_text: 'frame at check time' } } : {}),
      },
    ],
  });
}

// -------------------------------------------------------- CLI and admin

/**
 * One immediate end-to-end look for the CLI: no retries, no grace window.
 * `dryRun` writes the frame to the temp dir and skips the sheet and Slack.
 *
 * It writes the sheet and Slack directly rather than through the store: the
 * CLI runs beside the service, and a second process saving state.json would
 * race the one that owns it.
 */
export async function checkNow(entry, { dryRun = false, videoId = '' } = {}) {
  const now = Date.now();
  const date = localDate(now, entry.tz);
  const slot = { key: `${entry.templeRow}|${entry.ritual}|${date}|${entry.time}`, date, scheduledAt: now, graceEndsAt: now };
  const check = { ...newCheck(entry, slot, now), attempts: 1 };
  const outcome = await attempt(check, { dryRun, videoId });
  outcome.dryRun = dryRun;
  // An infinite retry interval is past any grace window: always a final answer.
  const result = buildResult(check, outcome, nextStep(check, outcome, now, Infinity));
  if (dryRun) return result;

  await appendResult(result);
  await notify(result);
  return result;
}

/** Next occurrence of each row, for the CLI and /admin/presence. */
export function upcoming(now = Date.now()) {
  return (schedule.entries || []).map((e) => {
    const next = nextSlot(e, now);
    return {
      temple: e.templeRow,
      ritual: e.ritual,
      time: e.time,
      tz: e.tz,
      days: daysLabel(e.days),
      grace: e.grace,
      next: next
        ? { local: `${next.date} ${clockLabel(next.scheduledAt, e.tz)}`, utc: new Date(next.scheduledAt).toISOString() }
        : null,
    };
  });
}

export function statusReport() {
  return {
    enabled: isEnabled(),
    source: schedule.source,
    loadedAt: schedule.loadedAt,
    resultsTab: config.presence.resultsTab,
    schedule: upcoming(),
    errors: schedule.errors,
    noTimezone: schedule.noTz,
    active: Object.values(getMeta(ACTIVE_KEY, {})).map((c) => ({
      key: c.key,
      attempts: c.attempts,
      nextAttemptAt: new Date(c.nextAttemptAt).toISOString(),
      graceEndsAt: new Date(c.graceEndsAt).toISOString(),
      lastError: c.lastError,
    })),
    queued: getMeta(QUEUE_KEY, []).map((i) => ({ key: i.result.key, attempts: i.attempts })),
    recent: getMeta(RECENT_KEY, []).slice(0, 20),
  };
}

