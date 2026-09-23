#!/usr/bin/env node
/**
 * Attendance sheet tooling.
 *
 *   node --env-file=.env scripts/attendance.mjs inspect
 *   node --env-file=.env scripts/attendance.mjs restructure --confirm
 *   node --env-file=.env scripts/attendance.mjs sweep
 *   node --env-file=.env scripts/attendance.mjs mark --temple "Toronto Kailasa" --video <id>
 *
 * `restructure` is the one-time migration from one column per date to the four
 * columns each date now needs. It refuses to run if anything is already
 * written under the existing date columns, so it cannot eat real data.
 */
import { config } from '../src/config.js';
import {
  tabs,
  batchGetValues,
  getValues,
  updateValues,
  batchUpdate,
  columnLetter,
  quoteTab,
} from '../src/google/sheets.js';
import {
  readLayout,
  ensureGroup,
  groupFor,
  writeStarted,
  SUBHEADERS,
  SUMMARY_LABELS,
  GROUP_WIDTH,
  STATUS,
} from '../src/attendance/sheet.js';
import { allTemples, normaliseLabel } from '../src/attendance/temples.js';
import { utcDateLabel, localTimeLabel, matchesGarbhaMandir } from '../src/attendance/match.js';
import { sweep, statusReport } from '../src/attendance/index.js';
import { captureFrame, snapshotUrl } from '../src/attendance/snapshot.js';
import { serviceAccount } from '../src/google/auth.js';
import { videosList, watchUrl, thumbUrl } from '../src/youtube/api.js';

const args = process.argv.slice(2);
const command = args[0] || 'inspect';
const flag = (name, dflt = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const SHEET = () => config.attendance.spreadsheetId;
const range = (a1) => `${quoteTab(config.attendance.tab)}!${a1}`;

function requireConfig() {
  if (!SHEET()) throw new Error('ATTENDANCE_SPREADSHEET_ID is not set');
  if (!serviceAccount()) throw new Error('no Google service account configured');
}

async function inspect() {
  requireConfig();
  const layout = await readLayout({ force: true });
  console.log(`tab           ${config.attendance.tab} (id ${layout.tabId})`);
  console.log(`grid          ${layout.rowCount} rows x ${layout.columnCount} cols`);
  console.log(`restructured  ${layout.restructured}`);
  console.log(`temple rows   3..${layout.lastTempleRow} (${layout.rows.size} labels)`);
  console.log(`summary row   ${layout.summaryRow || '(none)'}`);
  console.log(`date groups   ${layout.groups.map((g) => `${g.date}@${columnLetter(g.startCol)}`).join(', ') || '(none)'}`);

  console.log('\nchannel -> row');
  for (const t of allTemples()) {
    const row = layout.rows.get(normaliseLabel(t.row));
    console.log(`  ${row ? String(row).padStart(4) : '  ??'}  ${t.handle.padEnd(22)} ${t.row}${row ? '' : '   <-- NOT FOUND in column A'}`);
  }
}

async function restructure() {
  requireConfig();
  const { tabs: props } = await tabs(SHEET());
  const tab = props.find((p) => p.title === config.attendance.tab);
  if (!tab) throw new Error(`tab ${config.attendance.tab} not found`);

  const lastCol = columnLetter(tab.gridProperties.columnCount - 1);
  const [header, colA] = await batchGetValues(SHEET(), [
    range(`A1:${lastCol}2`),
    range(`A1:A${tab.gridProperties.rowCount}`),
  ]);
  const row1 = header[0] || [];
  const row2 = header[1] || [];

  if (String(row2[1] || '').trim() === SUBHEADERS[0]) {
    console.log('already restructured — nothing to do');
    return;
  }

  // Where the old summary block starts, so the emptiness check does not trip
  // over its own COUNTIF values.
  const summaryAt = colA.findIndex(
    (r) => normaliseLabel(r?.[0]) === normaliseLabel(STATUS.started),
  );
  if (summaryAt < 0) throw new Error('could not find the "Started" summary row in column A');
  const lastTemple = summaryAt; // 1-based row number of the row above it, minus blanks

  const dateCols = [];
  for (let c = 1; c < row1.length; c++) if (String(row1[c] || '').trim()) dateCols.push(c);
  if (!dateCols.length) throw new Error('no date columns found in row 1');
  const maxDateCol = Math.max(...dateCols);

  const body = await getValues(
    SHEET(),
    range(`${columnLetter(1)}2:${columnLetter(maxDateCol)}${lastTemple - 1}`),
  );
  const filled = body.flat().filter((v) => String(v || '').trim());
  if (filled.length) {
    throw new Error(
      `refusing to restructure: ${filled.length} cell(s) under the existing date columns are not ` +
        `empty (e.g. "${filled[0]}"). Clear them or move them first.`,
    );
  }

  console.log(`current dates : ${dateCols.map((c) => row1[c]).join(', ')}`);
  console.log(`temple rows   : 2..${lastTemple - 1}`);
  console.log(`will          : delete columns B..${columnLetter(maxDateCol)}, insert a sub-header row,`);
  console.log(`                add an "${STATUS.absent}" summary row, freeze 2 rows, and build today's group`);
  if (!has('confirm')) {
    console.log('\nre-run with --confirm to apply');
    return;
  }

  await batchUpdate(SHEET(), [
    {
      deleteDimension: {
        range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: maxDateCol + 1 },
      },
    },
    {
      insertDimension: {
        range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
        inheritFromBefore: false,
      },
    },
  ]);

  // The old COUNTIF formulas pointed at the deleted columns and are now #REF.
  const summaryTop = summaryAt + 1 + 1; // +1 for 1-based, +1 for the inserted row
  await batchUpdate(SHEET(), [
    {
      appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: 2 },
    },
  ]);
  await updateValues(SHEET(), [
    { range: range('A1'), values: [['Temple']] },
    {
      range: range(`A${summaryTop}:A${summaryTop + SUMMARY_LABELS.length - 1}`),
      values: SUMMARY_LABELS.map((l) => [l]),
    },
  ]);

  const layout = await readLayout({ force: true });
  await batchUpdate(SHEET(), [
    {
      updateSheetProperties: {
        properties: {
          sheetId: tab.sheetId,
          gridProperties: { frozenRowCount: 2, frozenColumnCount: 1 },
        },
        fields: 'gridProperties(frozenRowCount,frozenColumnCount)',
      },
    },
    {
      repeatCell: {
        range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, verticalAlignment: 'MIDDLE' } },
        fields: 'userEnteredFormat(textFormat,verticalAlignment)',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 240 },
        fields: 'pixelSize',
      },
    },
    // Tall enough for the snapshot thumbnails to be readable.
    {
      updateDimensionProperties: {
        range: {
          sheetId: tab.sheetId,
          dimension: 'ROWS',
          startIndex: 2,
          endIndex: layout.lastTempleRow,
        },
        properties: { pixelSize: 66 },
        fields: 'pixelSize',
      },
    },
  ]);

  const today = utcDateLabel();
  await ensureGroup(today);
  console.log(`\ndone — ${config.attendance.tab} restructured and ${today} created`);
  await inspect();
}

async function mark() {
  requireConfig();
  const videoId = flag('video');
  if (!videoId) throw new Error('--video <id> is required');

  const [item] = await videosList([videoId]);
  if (!item) throw new Error(`video ${videoId} not found`);

  const wanted = flag('temple');
  const temple = wanted
    ? allTemples().find((t) => normaliseLabel(t.row) === normaliseLabel(wanted))
    : allTemples().find((t) => t.channelId === item.snippet?.channelId);
  if (!temple) throw new Error('no temple matched — pass --temple "<row label>"');

  const title = item.snippet?.title || '';
  const matched = matchesGarbhaMandir(title, temple.patterns);
  console.log(`title    ${title}`);
  console.log(`temple   ${temple.row} (${temple.tz})`);
  console.log(`matches  ${matched ? `yes, on "${matched}"` : 'NO — this would not be counted'}`);
  if (!matched && !has('force')) {
    console.log('\npass --force to write it anyway (testing only)');
    return;
  }

  const startedAt =
    item.liveStreamingDetails?.actualStartTime || item.snippet?.publishedAt || new Date().toISOString();
  const date = flag('date', utcDateLabel(startedAt));
  const { layout, group } = await ensureGroup(date);
  const row = layout.rows.get(normaliseLabel(temple.row));
  if (!row) throw new Error(`"${temple.row}" not found in column A`);

  const name = await captureFrame(videoId, date);
  const image = snapshotUrl(name) || thumbUrl(videoId);
  console.log(`snapshot ${name ? `captured frame -> ${image}` : `fell back to thumbnail -> ${image}`}`);

  const written = await writeStarted(layout, group, row, {
    url: watchUrl(videoId),
    localTime: localTimeLabel(startedAt, temple.tz),
    imageFormula: image ? `=IMAGE("${image}",4,60,107)` : '',
  });
  console.log(written ? `written to ${date} row ${row}` : 'left alone — the cell already holds a value');
}

/** Remove a date's four columns entirely. For a group created in error. */
async function drop() {
  requireConfig();
  const date = flag('date');
  if (!date) throw new Error('--date "22-Sep-2026" is required');

  const layout = await readLayout({ force: true });
  const group = groupFor(layout, date);
  if (!group) throw new Error(`no group for ${date}`);

  console.log(`dropping ${date} (columns ${columnLetter(group.startCol)}..${columnLetter(group.startCol + GROUP_WIDTH - 1)})`);
  if (!has('confirm')) return console.log('re-run with --confirm to apply');

  await batchUpdate(SHEET(), [
    {
      deleteDimension: {
        range: {
          sheetId: layout.tabId,
          dimension: 'COLUMNS',
          startIndex: group.startCol,
          endIndex: group.startCol + GROUP_WIDTH,
        },
      },
    },
  ]);
  console.log('dropped');
}

const commands = {
  inspect,
  restructure,
  mark,
  drop,
  sweep: async () => {
    requireConfig();
    await sweep();
    console.log(JSON.stringify(statusReport(), null, 2));
  },
  status: async () => console.log(JSON.stringify(statusReport(), null, 2)),
};

const fn = commands[command];
if (!fn) {
  console.error(`unknown command "${command}" — one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
