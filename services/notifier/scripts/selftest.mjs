#!/usr/bin/env node
/**
 * Offline sanity check — no deploy needed.
 *   node --env-file=.env scripts/selftest.mjs
 *   node scripts/selftest.mjs --offline      # pure-function checks only
 *
 * Verifies: YouTube API discovery and classification, Shorts detection, Slack
 * credentials, (if configured) the Facebook Page token, and the presence
 * monitor's schedule, clock and verdict logic. --offline skips everything
 * that needs a credential or the network, so the logic can be checked on a
 * machine with no .env at all.
 */
import { config } from '../src/config.js';
import {
  resolveChannelId,
  videosList,
  isShort,
  recentUploads,
} from '../src/youtube/api.js';
import { postPlain } from '../src/slack.js';
import { graph } from '../src/facebook/graph.js';
import { loadTemples, normaliseLabel } from '../src/attendance/temples.js';
import { matchesGarbhaMandir, localTimeLabel } from '../src/attendance/match.js';
import { readLayout } from '../src/attendance/sheet.js';
import { serviceAccount } from '../src/google/auth.js';
import {
  parseSchedule,
  parseDays,
  parseTime,
  runsOn,
  slotOn,
  startedSlots,
  dueSlots,
  zonedTimeToUtc,
  minutesLate,
} from '../src/presence/schedule.js';
import { nextStep, STATUS, MAX_ATTEMPTS } from '../src/presence/scheduler.js';
import { parseVerdict, isPresent } from '../src/presence/vision.js';

const offline = process.argv.includes('--offline');

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push(['PASS', name, detail ?? '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};
// A check that needs a credential or the network.
const net = (name, fn) => check(name, offline ? () => 'skipped (--offline)' : fn);

const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const throws = (label, fn) => {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected an error`);
};

// Newest upload of the first channel that yields one, for the videos.list and
// Shorts probes below.
let latest;

for (const channel of config.youtube.channels) {
  let channelId;

  await net(`resolve ${channel}`, async () => {
    channelId = await resolveChannelId(channel);
    return `-> ${channelId}`;
  });

  await net(`recent uploads ${channel}`, async () => {
    if (!channelId) throw new Error('skipped (channel did not resolve)');
    const items = await recentUploads(channelId);
    const foreign = items.filter((item) => item.channelId !== channelId);
    if (foreign.length) {
      throw new Error(
        `${foreign.length} item(s) are not from ${channelId}: ` +
          foreign.map((item) => `${item.videoId}:${item.channelId || 'missing'}`).join(', '),
      );
    }
    const newest = items[0];
    if (!newest) throw new Error('playlistItems.list returned no uploads');
    latest ??= newest;
    return `${items.length} uploads, newest: ${newest.videoId} "${newest.title}"`;
  });
}

await net('YouTube Data API key', async () => {
  if (!latest) throw new Error('no upload found on any channel to test with');
  const items = await videosList([latest.videoId]);
  const it = items[0];
  return it ? `videos.list ok: liveBroadcastContent=${it.snippet.liveBroadcastContent}, duration=${it.contentDetails?.duration}` : 'no items returned';
});

await net('Shorts redirect probe', async () => {
  if (!latest) throw new Error('no upload found on any channel to test with');
  const short = await isShort(latest.videoId);
  if (short === null) return `${latest.videoId}: inconclusive`;
  return `${latest.videoId} is ${short ? 'a Short' : 'not a Short'}`;
});

await net('Slack credentials', async () => {
  if (!config.slack.botToken && !config.slack.webhookUrl) return 'skipped (no Slack destination configured)';
  await postPlain(':white_check_mark: social-media-notifications selftest — Slack delivery works.');
  return `posted to ${config.slack.channel || 'incoming webhook'}`;
});

await check('attendance title matching', async () => {
  // The whole point of the feature is that a festival puja is not attendance.
  // Both directions are asserted, because a matcher that says yes to
  // everything would otherwise look healthy.
  const patterns = loadTemples().patterns;
  const shouldMatch = [
    '#Live: Kailasa San Jose Garbhamandir Darshan',
    'Live Garbha Mandir 24/7',
    'KAILASA TORONTO 24/7 LIVESTREAM',
    'LIVE: KAILASA OHIO GARBHA MANDIR',
    // Mathematical-bold characters: these channels really do post titles like
    // this, and without NFKC they are not the letters they look like.
    '𝟮𝟰/𝟳 𝗚𝗔𝗥𝗕𝗛𝗔 𝗠𝗔𝗡𝗗𝗜𝗥',
  ];
  const shouldIgnore = [
    'LIVE: Ganesha Chaturthi Puja',
    '🔴 LIVE  DARSHAN',
    'Live Darshan Of The Main Deities Of Kailasa Singapore',
    '#Live: KAILASA\u2019s SPECIAL Venkateshwara Bhava Samadhi Darshan',
  ];
  const wrong = [
    ...shouldMatch.filter((t) => !matchesGarbhaMandir(t, patterns)).map((t) => `missed "${t}"`),
    ...shouldIgnore.filter((t) => matchesGarbhaMandir(t, patterns)).map((t) => `false positive "${t}"`),
  ];
  if (wrong.length) throw new Error(wrong.join('; '));
  return `${shouldMatch.length} matched, ${shouldIgnore.length} correctly ignored`;
});

await check('attendance temple map', async () => {
  const temples = loadTemples().temples;
  if (!temples.length) throw new Error(`no temples in ${config.attendance.templesFile}`);
  const bad = temples.filter((t) => !t.row || !t.channelId);
  if (bad.length) throw new Error(`${bad.length} entr(y|ies) missing row or channelId`);
  // A bad IANA zone silently becomes UTC at render time, so catch it here.
  const badTz = temples.filter((t) => !localTimeLabel(Date.now(), t.tz).match(/\d\d:\d\d/));
  if (badTz.length) throw new Error(`unusable timezone: ${badTz.map((t) => t.tz).join(', ')}`);
  return `${temples.length} temples, ${new Set(temples.map((t) => t.tz)).size} timezones`;
});

await net('attendance sheet access', async () => {
  if (!config.attendance.enabled) return 'skipped (ATTENDANCE_ENABLED=false)';
  if (!config.attendance.spreadsheetId) return 'skipped (no ATTENDANCE_SPREADSHEET_ID)';
  if (!serviceAccount()) return 'skipped (no service account key)';

  const layout = await readLayout({ force: true });
  if (!layout.restructured) {
    throw new Error('the tab still has one column per date — run scripts/attendance.mjs restructure');
  }
  const missing = loadTemples()
    .temples.filter((t) => !layout.rows.get(normaliseLabel(t.row)))
    .map((t) => t.row);
  if (missing.length) {
    throw new Error(`not found in column A (renamed?): ${missing.join(', ')}`);
  }
  return `${layout.rows.size} rows, ${layout.groups.length} date group(s), newest ${layout.groups[0]?.date || 'none'}`;
});

// ------------------------------------------------------------ presence
// Pure functions only — none of these touch a sheet, the gateway or a model.

const TEMPLES = {
  'kailasa usa la': { key: 'kailasa usa la', row: 'Kailasa USA LA', tz: 'America/Los_Angeles', tzConfigured: true },
  njb: { key: 'njb', row: 'NJB', tz: 'Asia/Kolkata', tzConfigured: true },
  'no tz temple': { key: 'no tz temple', row: 'No Tz Temple', tz: 'UTC', tzConfigured: false },
};
const findTemple = (label) => TEMPLES[String(label).trim().toLowerCase()] || null;
const opts = { findTemple, defaultGrace: 15 };
const entryFor = (temple, time, extra = {}) =>
  parseSchedule([{ temple, ritual: 'Naivedyam', time, ...extra }], opts).entries[0];

await check('presence schedule parsing', async () => {
  eq('11:45', parseTime('11:45'), 705);
  eq('9:05', parseTime('9:05'), 545);
  eq('11:45:00', parseTime('11:45:00'), 705);
  eq('6:30 PM', parseTime('6:30 PM'), 1110);
  eq('12:00 AM', parseTime('12:00 AM'), 0);
  eq('24:00', parseTime('24:00'), null);
  eq('11.45', parseTime('11.45'), null);

  const { entries, errors, noTz } = parseSchedule(
    [
      { line: 2, temple: 'Kailasa USA LA', ritual: 'Naivedyam', time: '11:45', days: 'Daily', grace: '', enabled: '' },
      { line: 3, temple: ' njb ', ritual: 'Arati', time: '18:30', days: 'Mon,Wed,Fri', grace: '20', enabled: 'TRUE' },
      { line: 4, temple: 'Kailasa USA LA', ritual: 'Arati', time: '25:00' },
      { line: 5, temple: 'Nowhere Kailasa', ritual: 'Arati', time: '07:00' },
      { line: 6, temple: 'No Tz Temple', ritual: 'Arati', time: '07:00' },
      { line: 7, temple: 'NJB', ritual: 'Alankara', time: '08:00', enabled: 'FALSE' },
      { line: 8, temple: 'NJB', ritual: 'Abhishekam', time: '09:00', grace: 'soon' },
      { line: 9, temple: 'kailasa usa la', ritual: 'naivedyam', time: '11:45' },
      { line: 10, temple: '', ritual: '', time: '' },
      { line: 11, temple: 'NJB', ritual: 'Arati', time: '06:00', days: 'Funday' },
    ],
    opts,
  );
  eq('entries', entries.map((e) => `${e.templeRow}/${e.ritual}/${e.time}/${e.grace}`), [
    'Kailasa USA LA/Naivedyam/11:45/15',
    'NJB/Arati/18:30/20',
  ]);
  eq('error rows', errors.map((e) => e.split(':')[0]), ['row 4', 'row 5', 'row 8', 'row 9', 'row 11']);
  eq('no timezone', noTz, ['No Tz Temple']);
  return `${entries.length} valid, ${errors.length} rejected, no-tz and disabled rows skipped`;
});

await check('presence Days matching', async () => {
  eq('Daily', parseDays('Daily'), null);
  eq('blank', parseDays(''), null);
  eq('Mon,Wed,Fri', parseDays('Mon,Wed,Fri'), [1, 3, 5]);
  eq('Mon - Fri', parseDays('Mon - Fri'), [1, 2, 3, 4, 5]);
  eq('Fri-Mon wraps', parseDays('Fri-Mon'), [0, 1, 5, 6]);
  eq('full names', parseDays('tuesday thursday'), [2, 4]);
  throws('Funday', () => parseDays('Funday'));
  throws('M', () => parseDays('M'));
  const mwf = { days: [1, 3, 5] };
  // 2026-09-26 is a Saturday.
  eq('Sat', runsOn(mwf, '2026-09-26'), false);
  eq('Mon', runsOn(mwf, '2026-09-28'), true);
  eq('Daily', runsOn({ days: null }, '2026-09-26'), true);
  return 'lists, ranges, wrap-around, invalid names';
});

await check('presence slot times (tz + DST)', async () => {
  const iso = (d, m, tz) => new Date(zonedTimeToUtc(d, m, tz)).toISOString();
  // US DST begins 2026-03-08 and ends 2026-11-01: 11:45 LA moves an hour in UTC.
  eq('LA before spring', iso('2026-03-07', 705, 'America/Los_Angeles'), '2026-03-07T19:45:00.000Z');
  eq('LA after spring', iso('2026-03-08', 705, 'America/Los_Angeles'), '2026-03-08T18:45:00.000Z');
  eq('LA before fall', iso('2026-10-31', 705, 'America/Los_Angeles'), '2026-10-31T18:45:00.000Z');
  eq('LA after fall', iso('2026-11-01', 705, 'America/Los_Angeles'), '2026-11-01T19:45:00.000Z');
  // Sydney springs forward 2026-10-04, in the other hemisphere's direction.
  eq('Sydney before', iso('2026-10-03', 540, 'Australia/Sydney'), '2026-10-02T23:00:00.000Z');
  eq('Sydney after', iso('2026-10-04', 540, 'Australia/Sydney'), '2026-10-03T22:00:00.000Z');
  eq('Kolkata half-hour', iso('2026-09-26', 390, 'Asia/Kolkata'), '2026-09-26T01:00:00.000Z');

  // A 23:55 ritual whose grace runs past local midnight is still found, under
  // the date it was scheduled for.
  const sg = { templeRow: 'SG', ritual: 'Arati', time: '23:55', minutes: 1435, tz: 'Asia/Singapore', days: null, grace: 15 };
  const afterMidnight = Date.parse('2026-09-26T16:05:00Z'); // 00:05 SGT on the 27th
  const late = startedSlots(sg, afterMidnight).filter((s) => afterMidnight <= s.graceEndsAt);
  eq('midnight slot', late.map((s) => s.key), ['SG|Arati|2026-09-26|23:55']);

  // The weekday is the temple's, not UTC's: at 02:00Z on Monday it is still
  // Sunday evening in LA.
  const sundayInLa = Date.parse('2026-09-28T02:00:00Z');
  eq('Mon row, LA Sunday', startedSlots(entryFor('Kailasa USA LA', '06:30', { days: 'Mon' }), sundayInLa).length, 0);
  eq('Sun row, LA Sunday', startedSlots(entryFor('Kailasa USA LA', '11:45', { days: 'Sun' }), sundayInLa).map((s) => s.date), ['2026-09-27']);
  return 'LA/Sydney DST both ways, half-hour offset, midnight crossing';
});

await check('presence slot dedupe + missed', async () => {
  const e = entryFor('Kailasa USA LA', '11:45');
  const slot = slotOn(e, '2026-09-26');
  eq('key', slot.key, 'Kailasa USA LA|Naivedyam|2026-09-26|11:45');
  const at = slot.scheduledAt + 60_000;
  eq('fires once', dueSlots([e], at, new Set()).fire.map((f) => f.slot.key), [slot.key]);
  eq('never twice', dueSlots([e], at, new Set([slot.key])).fire.length, 0);
  eq('not early', dueSlots([e], slot.scheduledAt - 1000, new Set()).fire.filter((f) => f.slot.key === slot.key).length, 0);
  const afterGrace = dueSlots([e], slot.graceEndsAt + 1000, new Set());
  eq('past grace is missed, not fired', [afterGrace.fire.length, afterGrace.missed.map((m) => m.slot.key).includes(slot.key)], [0, true]);
  // The same slot re-read from a reloaded schedule has the same key.
  eq('stable key', slotOn(entryFor('kailasa usa la', '11:45'), '2026-09-26').key, slot.key);
  return 'fires once, not before time, missed after its window';
});

await check('presence retry/late/absent', async () => {
  const T = Date.parse('2026-09-26T18:45:00Z');
  const m = (n) => T + n * 60_000;
  const retry = 3 * 60_000;
  const base = { scheduledAt: T, graceEndsAt: m(15), sawNegative: false };

  eq('present first look', nextStep({ ...base, attempts: 1 }, { kind: 'present', checkedAt: m(1) }, m(1), retry), {
    status: STATUS.present, minutesLate: 0, basis: 'this',
  });
  eq('late on retry', nextStep({ ...base, attempts: 3 }, { kind: 'present', checkedAt: m(6) + 20_000 }, m(6), retry).status, 'Late (6 min)');
  eq('absent retries', nextStep({ ...base, attempts: 1 }, { kind: 'absent' }, T, retry), { retryAt: m(3) });
  eq('no stream is final', nextStep({ ...base, attempts: 1 }, { kind: 'no_stream' }, T, retry).status, STATUS.noStream);
  eq('error then Error', nextStep({ ...base, attempts: 6 }, { kind: 'error' }, m(15), retry).status, STATUS.error);
  eq('error after a negative is Absent', nextStep({ ...base, attempts: 6, sawNegative: true }, { kind: 'error' }, m(15), retry), {
    status: STATUS.absent, minutesLate: null, basis: 'earlier',
  });
  eq('attempt cap', nextStep({ ...base, graceEndsAt: m(600), attempts: MAX_ATTEMPTS }, { kind: 'absent' }, m(3), retry).status, STATUS.absent);

  // Walk a whole window with nobody there: looks at 0,3,6,9,12,15 then stops.
  let now = T;
  let attempts = 0;
  let step;
  do {
    attempts += 1;
    step = nextStep({ ...base, attempts }, { kind: 'absent' }, now, retry);
    if (step.retryAt) now = step.retryAt;
  } while (step.retryAt);
  eq('window walk', [attempts, step.status], [6, STATUS.absent]);

  eq('late math', minutesLate(T, m(7) + 29_000), 7);
  eq('late rounds', minutesLate(T, m(7) + 31_000), 8);
  eq('never negative', minutesLate(T, m(-1)), 0);
  return 'present, late, absent, no stream, error, bounded';
});

await check('presence vision JSON + threshold', async () => {
  const obj = '{"pujari_present": true, "performing_ritual": true, "activity": "waving arati", "confidence": 0.82, "reason": "priest with lamp"}';
  const want = { pujari_present: true, performing_ritual: true, activity: 'waving arati', confidence: 0.82, reason: 'priest with lamp' };
  eq('plain', parseVerdict(obj), want);
  eq('fenced', parseVerdict('```json\n' + obj + '\n```'), want);
  eq('prose', parseVerdict(`Here is my analysis of the frame:\n${obj}\nLet me know if you need more.`), want);
  eq('think block', parseVerdict(`<think>maybe {"pujari_present": false}</think>\n${obj}`), want);
  const loose = parseVerdict('{"pujari_present":"true","performing_ritual":"false","confidence":85}');
  eq('loose types', [loose.pujari_present, loose.performing_ritual, loose.confidence, loose.activity], [true, false, 0.85, '']);
  throws('no JSON', () => parseVerdict('I cannot see a pujari.'));

  eq('present', isPresent(want, 0.6), true);
  eq('low confidence', isPresent({ ...want, confidence: 0.5 }, 0.6), false);
  eq('not performing', isPresent({ ...want, performing_ritual: false }, 0.6), false);
  eq('no pujari', isPresent({ ...want, pujari_present: false }, 0.6), false);
  return 'fences, prose, think blocks, loose types, 3-way threshold';
});

await net('Facebook Page token', async () => {
  if (!config.facebook.enabled) return 'skipped (FACEBOOK_ENABLED=false)';
  const me = await graph(config.facebook.pageId, { fields: 'id,name,fan_count' });
  return `${me.name} (${me.id})`;
});

console.log('');
for (const [status, name, detail] of results) {
  console.log(`${status === 'PASS' ? '  ok  ' : ' FAIL '} ${name.padEnd(38)} ${detail}`);
}
console.log('');
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
