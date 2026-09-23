#!/usr/bin/env node
/**
 * Offline sanity check — no deploy needed.
 *   node --env-file=.env scripts/selftest.mjs
 *
 * Verifies: YouTube API discovery and classification, Shorts detection, Slack
 * credentials, and (if configured) the Facebook Page token.
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

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push(['PASS', name, detail ?? '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};

// Newest upload of the first channel that yields one, for the videos.list and
// Shorts probes below.
let latest;

for (const channel of config.youtube.channels) {
  let channelId;

  await check(`resolve ${channel}`, async () => {
    channelId = await resolveChannelId(channel);
    return `-> ${channelId}`;
  });

  await check(`recent uploads ${channel}`, async () => {
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

await check('YouTube Data API key', async () => {
  if (!latest) throw new Error('no upload found on any channel to test with');
  const items = await videosList([latest.videoId]);
  const it = items[0];
  return it ? `videos.list ok: liveBroadcastContent=${it.snippet.liveBroadcastContent}, duration=${it.contentDetails?.duration}` : 'no items returned';
});

await check('Shorts redirect probe', async () => {
  if (!latest) throw new Error('no upload found on any channel to test with');
  const short = await isShort(latest.videoId);
  if (short === null) return `${latest.videoId}: inconclusive`;
  return `${latest.videoId} is ${short ? 'a Short' : 'not a Short'}`;
});

await check('Slack credentials', async () => {
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

await check('attendance sheet access', async () => {
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

await check('Facebook Page token', async () => {
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
