import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { tabs, getValues, updateValues, appendValues, batchUpdate, quoteTab } from '../google/sheets.js';
import { rowsToObjects } from './schedule.js';

/**
 * The two presence tabs.
 *
 *   Puja-Schedule    read-only to this service; the temple team edits it.
 *   Puja-Attendance  append-only log, one row per checked slot. Never
 *                    rewritten, so anything a person adds to a row survives.
 */

export const RESULT_HEADERS = [
  'Date (temple-local)',
  'Temple',
  'Ritual',
  'Scheduled (local)',
  'Checked at (local)',
  'Status',
  'Minutes late',
  'Confidence',
  'Activity / reason',
  'Frame',
  'Frame link',
  'Stream link',
];

const sheetId = () => config.presence.spreadsheetId;

/**
 * Raw schedule rows as objects: { line, temple, ritual, time, days, grace,
 * enabled }. From the JSON file when one is configured, else the sheet.
 */
export async function readScheduleRows() {
  const { scheduleFile, scheduleTab } = config.presence;
  if (scheduleFile) {
    const parsed = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed.schedule || [];
    return {
      source: `file ${scheduleFile}`,
      rows: rows.map((r, i) => ({ line: i + 1, ...r })),
    };
  }
  if (!sheetId()) throw new Error('no schedule source: set PRESENCE_SPREADSHEET_ID or PRESENCE_SCHEDULE_FILE');
  const values = await getValues(sheetId(), `${quoteTab(scheduleTab)}!A1:F`);
  return { source: `sheet tab ${scheduleTab}`, rows: rowsToObjects(values) };
}

let resultsReady = false;

/**
 * Create the results tab and its header row if either is missing. Done once
 * per process; the tab is only ever appended to after that.
 */
async function ensureResultsTab() {
  if (resultsReady) return;
  const { resultsTab } = config.presence;
  const { tabs: props } = await tabs(sheetId());
  let tab = props.find((p) => p.title === resultsTab);
  if (!tab) {
    const out = await batchUpdate(sheetId(), [
      { addSheet: { properties: { title: resultsTab, gridProperties: { frozenRowCount: 1 } } } },
    ]);
    tab = out?.replies?.[0]?.addSheet?.properties;
    log.info(`presence: created tab ${resultsTab}`);
    // Room for the frame thumbnail; rows appended below inherit the height.
    if (tab) {
      await batchUpdate(sheetId(), [
        {
          updateDimensionProperties: {
            range: { sheetId: tab.sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 },
            properties: { pixelSize: 170 },
            fields: 'pixelSize',
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: tab.gridProperties?.rowCount || 1000 },
            properties: { pixelSize: 96 },
            fields: 'pixelSize',
          },
        },
        {
          repeatCell: {
            range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat',
          },
        },
      ]);
    }
  }

  const range = `${quoteTab(resultsTab)}!A1:L1`;
  const header = (await getValues(sheetId(), range))[0] || [];
  if (!header.some((c) => String(c || '').trim())) {
    await updateValues(sheetId(), [{ range, values: [RESULT_HEADERS] }]);
  }
  resultsReady = true;
}

// Temple, ritual and the model's own words go into USER_ENTERED cells; a
// leading = + - @ would be read as a formula.
const text = (s) => {
  const v = String(s ?? '');
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
};

/** One result row, in RESULT_HEADERS order. */
export function resultRow(r) {
  return [
    r.date,
    text(r.templeRow),
    text(r.ritual),
    r.scheduledLabel,
    r.checkedLabel || '',
    r.status,
    r.minutesLate ?? '',
    r.confidence ?? '',
    text(r.detail),
    r.frameUrl ? `=IMAGE("${r.frameUrl}")` : '',
    r.frameUrl ? `=HYPERLINK("${r.frameUrl}","Frame")` : '',
    r.streamUrl ? `=HYPERLINK("${r.streamUrl}","▶ Watch")` : '',
  ];
}

export async function appendResult(result) {
  if (!sheetId()) throw new Error('no PRESENCE_SPREADSHEET_ID / ATTENDANCE_SPREADSHEET_ID');
  await ensureResultsTab();
  await appendValues(sheetId(), `${quoteTab(config.presence.resultsTab)}!A:L`, [resultRow(result)]);
}
