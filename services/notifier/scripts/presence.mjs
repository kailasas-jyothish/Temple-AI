#!/usr/bin/env node
/**
 * Pujari presence tooling.
 *
 *   node --env-file=.env scripts/presence.mjs schedule
 *   node --env-file=.env scripts/presence.mjs check --temple "Kailasa USA LA" [--ritual Naivedyam] [--video <id>] [--dry-run]
 *   node --env-file=.env scripts/presence.mjs classify frame.jpg [--ritual Naivedyam]
 *
 * `check` takes one frame now and runs the whole path: without --dry-run it
 * appends a row to the results tab and posts to Slack, like a scheduled
 * check would. The live video id comes from the service's state.json under
 * DATA_DIR; --video overrides it when running away from the server.
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { load } from '../src/store.js';
import { templeByKey } from '../src/attendance/temples.js';
import { loadSchedule, upcoming, checkNow } from '../src/presence/index.js';
import { classify, isPresent } from '../src/presence/vision.js';
import { localClock, parseTime, validTimeZone } from '../src/presence/schedule.js';

const args = process.argv.slice(2);
const command = args[0] || 'schedule';
const flag = (name, dflt = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

async function schedule() {
  const s = await loadSchedule();
  console.log(`source      ${s.source}`);
  console.log(`slots       ${s.entries.length}`);
  console.log('');
  for (const r of upcoming()) {
    console.log(
      `  ${r.temple.padEnd(32)} ${r.ritual.padEnd(20)} ${r.time}  ${r.days.padEnd(14)} grace ${String(r.grace).padStart(3)}m  ` +
        `next ${r.next ? `${r.next.local.padEnd(22)} ${r.next.utc}` : '(none within a week)'}`,
    );
  }
  if (s.errors.length) {
    console.log('\nskipped rows');
    for (const e of s.errors) console.log(`  ${e}`);
  }
  if (s.noTz.length) console.log(`\nno timezone in temples.json (skipped): ${s.noTz.join(', ')}`);
}

async function check() {
  const wanted = flag('temple');
  if (!wanted) throw new Error('--temple "<row label from temples.json>" is required');
  const temple = templeByKey(wanted);
  if (!temple) throw new Error(`"${wanted}" is not a row label in ${config.attendance.templesFile}`);
  if (!temple.tzConfigured || !validTimeZone(temple.tz)) throw new Error(`${temple.row} has no usable tz in temples.json`);
  const ritual = flag('ritual');

  // Use the schedule row when there is one (for its ritual name and time);
  // an ad-hoc check needs neither the sheet nor a row.
  let entry = null;
  try {
    const s = await loadSchedule();
    entry = s.entries.find(
      (e) => e.templeKey === temple.key && (!ritual || e.ritual.toLowerCase() === ritual.toLowerCase()),
    );
  } catch (err) {
    console.log(`(schedule not read: ${err.message})`);
  }
  if (!entry) {
    const time = localClock(Date.now(), temple.tz);
    entry = {
      templeKey: temple.key,
      templeRow: temple.row,
      tz: temple.tz,
      ritual: ritual || 'Ad-hoc check',
      minutes: parseTime(time),
      time,
      days: null,
      grace: 0,
    };
  }

  // Read-only: the attendance state tells us which video is live. Nothing
  // here saves it back.
  load();
  const dryRun = has('dry-run');
  console.log(`temple   ${entry.templeRow} (${entry.tz})`);
  console.log(`ritual   ${entry.ritual} @ ${entry.time}`);
  console.log(`mode     ${dryRun ? 'dry run — no sheet, no Slack' : `writes ${config.presence.resultsTab} and Slack`}`);

  const r = await checkNow(entry, { dryRun, videoId: flag('video') });
  console.log('');
  console.log(`status   ${r.status}`);
  console.log(`checked  ${r.checkedLabel}${r.videoId ? ` on ${r.videoId}` : ''}`);
  if (r.verdict) console.log(`verdict  ${JSON.stringify(r.verdict)}`);
  if (r.provider) console.log(`model    ${r.provider}`);
  if (r.detail) console.log(`detail   ${r.detail}`);
  if (r.framePath || r.frameUrl) console.log(`frame    ${r.framePath || r.frameUrl}`);
}

async function classifyFile() {
  const file = args[1];
  if (!file || file.startsWith('--')) throw new Error('usage: classify <path.jpg> [--ritual <name>]');
  const jpeg = fs.readFileSync(file);
  const r = await classify(jpeg, { ritual: flag('ritual') });
  console.log(JSON.stringify(r.verdict, null, 2));
  console.log(`\nmodel    ${r.provider}/${r.model}`);
  console.log(
    `present  ${isPresent(r.verdict) ? 'YES' : 'no'} (needs pujari_present && performing_ritual && confidence >= ${config.presence.minConfidence})`,
  );
}

const commands = { schedule, check, classify: classifyFile };

const fn = commands[command];
if (!fn) {
  console.error(`unknown command "${command}" — one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
