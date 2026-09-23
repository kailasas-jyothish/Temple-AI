import { config } from '../config.js';
import { log } from '../log.js';
import {
  tabs,
  getValues,
  batchGetValues,
  updateValues,
  batchUpdate,
  columnLetter,
  quoteTab,
} from '../google/sheets.js';
import { normaliseLabel, trackedRowLabels } from './temples.js';
import { parseDateLabel } from './match.js';

/**
 * The shape of the 24x7-Live-Stream-Monitoring tab.
 *
 *      A          B        C         D      E        F        G  ...
 *  1  Temple   | 22-Sep-2026 (merged across 4)  | 21-Sep-2026 ...
 *  2           | Status  Started   Link   Snapshot | Status ...
 *  3  Toronto  | Started 06:12 AM EDT  Watch  [img]| ...
 *
 * A date owns four columns, and a new date is inserted at column B so today is
 * always next to the temple names — otherwise the sheet grows four columns to
 * the right every day and the thing you want to read is the thing furthest
 * from the labels.
 */

export const GROUP_WIDTH = 4;
export const SUBHEADERS = ['Status', 'Started', 'Link', 'Snapshot'];
const HEADER_ROW = 1; // 1-based, as the sheet numbers them
const SUBHEADER_ROW = 2;
const FIRST_TEMPLE_ROW = 3;
const FIRST_DATE_COL = 1; // 0-based: column B

export const STATUS = {
  started: 'Started',
  pending: 'Yet to Start',
  absent: 'Absent',
  untracked: '—',
};

// The three values the service is allowed to overwrite. Anything else in a
// Status cell was put there by a person, and a person outranks this service.
const OVERWRITABLE = new Set(['', STATUS.pending, STATUS.absent, STATUS.untracked]);

const tabRange = (a1) => `${quoteTab(config.attendance.tab)}!${a1}`;

let layoutCache = null;
let layoutReadAt = 0;
const LAYOUT_TTL_MS = 60 * 1000;

export function invalidateLayout() {
  layoutCache = null;
}

/**
 * Where everything currently is. Cheap enough to re-read often (two ranges),
 * and re-read it must be — people insert rows in this sheet by hand.
 */
export async function readLayout({ force = false } = {}) {
  if (!force && layoutCache && Date.now() - layoutReadAt < LAYOUT_TTL_MS) return layoutCache;

  const { tabs: props } = await tabs(config.attendance.spreadsheetId);
  const tab = props.find((p) => p.title === config.attendance.tab);
  if (!tab) {
    throw new Error(
      `tab "${config.attendance.tab}" not found in the spreadsheet (tabs: ${props.map((p) => p.title).join(', ')})`,
    );
  }

  const lastCol = columnLetter(Math.max(tab.gridProperties.columnCount - 1, 0));
  const [headerRows, labelCol] = await batchGetValues(config.attendance.spreadsheetId, [
    tabRange(`A${HEADER_ROW}:${lastCol}${SUBHEADER_ROW}`),
    tabRange(`A1:A${tab.gridProperties.rowCount}`),
  ]);

  const header = headerRows[0] || [];
  const subheader = headerRows[1] || [];

  // A date group is a header cell holding a date with "Status" beneath it.
  // Requiring both means a stray label in row 1 cannot be mistaken for one.
  const groups = [];
  for (let col = FIRST_DATE_COL; col < header.length; col++) {
    const label = String(header[col] || '').trim();
    if (!label) continue;
    if (String(subheader[col] || '').trim() !== SUBHEADERS[0]) continue;
    groups.push({ date: label, startCol: col });
  }

  const rows = new Map();
  labelCol.forEach((row, i) => {
    const label = normaliseLabel(row?.[0]);
    // First occurrence wins: the summary block at the bottom repeats words
    // like "Started" in column A and must never be mistaken for a temple.
    if (label && i + 1 >= FIRST_TEMPLE_ROW && !rows.has(label)) rows.set(label, i + 1);
  });

  layoutCache = {
    tabId: tab.sheetId,
    rowCount: tab.gridProperties.rowCount,
    columnCount: tab.gridProperties.columnCount,
    restructured: String(subheader[FIRST_DATE_COL] || '').trim() === SUBHEADERS[0],
    groups,
    rows,
    lastTempleRow: lastTempleRow(labelCol),
    summaryRow: summaryRow(labelCol),
  };
  layoutReadAt = Date.now();
  return layoutCache;
}

/** The three labels that open the count block at the bottom of the tab. */
export const SUMMARY_LABELS = [STATUS.started, STATUS.pending, STATUS.absent];
const isSummaryLabel = (label) =>
  SUMMARY_LABELS.some((s) => normaliseLabel(s) === label);

/**
 * The last row that is a temple rather than part of the summary block. The
 * block is recognised by its own labels, so adding temples never needs this
 * touched.
 */
function lastTempleRow(labelCol) {
  let last = FIRST_TEMPLE_ROW;
  for (let i = FIRST_TEMPLE_ROW - 1; i < labelCol.length; i++) {
    const label = normaliseLabel(labelCol[i]?.[0]);
    if (!label) continue;
    if (isSummaryLabel(label)) break;
    last = i + 1;
  }
  return last;
}

/** Row of the first summary label, or 0 when the block is absent. */
function summaryRow(labelCol) {
  for (let i = FIRST_TEMPLE_ROW - 1; i < labelCol.length; i++) {
    if (normaliseLabel(labelCol[i]?.[0]) === normaliseLabel(STATUS.started)) return i + 1;
  }
  return 0;
}

export function groupFor(layout, date) {
  return layout.groups.find((g) => g.date === date) || null;
}

/**
 * Create the group for `date`, keeping the groups in newest-first order.
 *
 * Today's group therefore lands at column B and pushes yesterday right, which
 * is the whole point of the layout. It is not always column B though: the
 * first run against an already-running stream backfills the date that stream
 * started on, and that group belongs to the right of any newer one.
 */
export async function ensureGroup(date) {
  let layout = await readLayout({ force: true });
  const existing = groupFor(layout, date);
  if (existing) return { layout, group: existing, created: false };

  const when = parseDateLabel(date);
  const newer = layout.groups.filter((g) => {
    const other = parseDateLabel(g.date);
    // An unparseable header keeps its place rather than being sorted past.
    return Number.isFinite(other) && Number.isFinite(when) ? other > when : true;
  }).length;
  const startCol = FIRST_DATE_COL + newer * GROUP_WIDTH;

  const { spreadsheetId } = config.attendance;
  await batchUpdate(spreadsheetId, [
    {
      insertDimension: {
        range: {
          sheetId: layout.tabId,
          dimension: 'COLUMNS',
          startIndex: startCol,
          endIndex: startCol + GROUP_WIDTH,
        },
        inheritFromBefore: false,
      },
    },
    ...groupFormatRequests(layout.tabId, startCol),
  ]);

  layout = await readLayout({ force: true });
  await writeGroupContent(layout, date, startCol);
  layout = await readLayout({ force: true });

  log.info(`attendance: created column group for ${date} at ${columnLetter(startCol)}`);
  return { layout, group: groupFor(layout, date), created: true };
}

/** Header text, sub-headers and the starting status for every temple row. */
async function writeGroupContent(layout, date, startCol) {
  const tracked = trackedRowLabels();
  const first = columnLetter(startCol);
  const last = columnLetter(startCol + GROUP_WIDTH - 1);

  const bodyRows = [];
  for (let row = FIRST_TEMPLE_ROW; row <= layout.lastTempleRow; row++) {
    const label = [...layout.rows.entries()].find(([, r]) => r === row)?.[0];
    // A temple with no YouTube channel configured is not absent — nothing is
    // watching it. Saying "Absent" for 53 untracked temples every day would
    // make the sheet lie in the most confident possible way.
    const status = label && tracked.has(label) ? STATUS.pending : STATUS.untracked;
    bodyRows.push([status, '', '', '']);
  }

  await updateValues(config.attendance.spreadsheetId, [
    { range: tabRange(`${first}${HEADER_ROW}`), values: [[date]] },
    { range: tabRange(`${first}${SUBHEADER_ROW}:${last}${SUBHEADER_ROW}`), values: [SUBHEADERS] },
    {
      range: tabRange(`${first}${FIRST_TEMPLE_ROW}:${last}${layout.lastTempleRow}`),
      values: bodyRows,
    },
  ]);

  await writeSummary(layout, startCol);
}

/**
 * The count cells under each date group, one per summary label. They are
 * written per group rather than filled across, because each group's Status
 * column is four columns from the last.
 */
async function writeSummary(layout, startCol) {
  if (!layout.summaryRow) return;
  const col = columnLetter(startCol);
  const range = `${col}${FIRST_TEMPLE_ROW}:${col}${layout.lastTempleRow}`;
  await updateValues(config.attendance.spreadsheetId, [
    {
      range: tabRange(
        `${col}${layout.summaryRow}:${col}${layout.summaryRow + SUMMARY_LABELS.length - 1}`,
      ),
      values: SUMMARY_LABELS.map((label) => [`=COUNTIF(${range},"${label}")`]),
    },
  ]);
}

function groupFormatRequests(tabId, startCol) {
  const col = (offset) => startCol + offset;
  return [
    {
      mergeCells: {
        range: {
          sheetId: tabId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: startCol,
          endColumnIndex: startCol + GROUP_WIDTH,
        },
        mergeType: 'MERGE_ALL',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId: tabId,
          startRowIndex: 0,
          endRowIndex: 2,
          startColumnIndex: startCol,
          endColumnIndex: startCol + GROUP_WIDTH,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.95 },
          },
        },
        fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat,backgroundColor)',
      },
    },
    ...[
      [col(0), 110],
      [col(1), 135],
      [col(2), 70],
      [col(3), 120],
    ].map(([index, pixelSize]) => ({
      updateDimensionProperties: {
        range: { sheetId: tabId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
    {
      repeatCell: {
        range: {
          sheetId: tabId,
          startRowIndex: FIRST_TEMPLE_ROW - 1,
          startColumnIndex: startCol,
          endColumnIndex: startCol + GROUP_WIDTH,
        },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } },
        fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)',
      },
    },
  ];
}

/** What the Status cell for this temple and date says right now. */
export async function readStatus(layout, group, row) {
  const cell = `${columnLetter(group.startCol)}${row}`;
  const values = await getValues(config.attendance.spreadsheetId, tabRange(cell));
  return String(values?.[0]?.[0] || '').trim();
}

/**
 * Record a start. Refuses to overwrite anything a person typed, and refuses to
 * overwrite an earlier start — first one wins, as asked.
 */
export async function writeStarted(layout, group, row, { url, localTime, imageFormula }) {
  const current = await readStatus(layout, group, row);
  if (!OVERWRITABLE.has(current)) {
    log.info(`attendance: leaving ${group.date} row ${row} alone — it already reads "${current}"`);
    return false;
  }

  const first = columnLetter(group.startCol);
  const last = columnLetter(group.startCol + GROUP_WIDTH - 1);
  await updateValues(config.attendance.spreadsheetId, [
    {
      range: tabRange(`${first}${row}:${last}${row}`),
      values: [[STATUS.started, localTime, `=HYPERLINK("${url}","▶ Watch")`, imageFormula || '']],
    },
  ]);
  return true;
}

/**
 * A temple added to temples.json after `date`'s group was built reads "—"
 * there, and "—" is never closed to Absent. Give it the pending status now.
 * Only "—" and blank are touched, so nothing a person wrote is replaced.
 */
export async function markTrackedPending(date) {
  const layout = await readLayout();
  const group = groupFor(layout, date);
  if (!group) return 0;

  const col = columnLetter(group.startCol);
  const values = await getValues(
    config.attendance.spreadsheetId,
    tabRange(`${col}${FIRST_TEMPLE_ROW}:${col}${layout.lastTempleRow}`),
  );

  const tracked = trackedRowLabels();
  const data = [];
  for (const [label, row] of layout.rows) {
    if (!tracked.has(label) || row > layout.lastTempleRow) continue;
    const current = String(values[row - FIRST_TEMPLE_ROW]?.[0] || '').trim();
    if (current !== '' && current !== STATUS.untracked) continue;
    data.push({ range: tabRange(`${col}${row}`), values: [[STATUS.pending]] });
  }
  if (data.length) await updateValues(config.attendance.spreadsheetId, data);
  return data.length;
}

/** Close a finished day: everything still pending becomes Absent. */
export async function markAbsentees(date) {
  const layout = await readLayout({ force: true });
  const group = groupFor(layout, date);
  if (!group) return 0;

  const col = columnLetter(group.startCol);
  const values = await getValues(
    config.attendance.spreadsheetId,
    tabRange(`${col}${FIRST_TEMPLE_ROW}:${col}${layout.lastTempleRow}`),
  );

  const data = [];
  for (let i = 0; i < layout.lastTempleRow - FIRST_TEMPLE_ROW + 1; i++) {
    if (String(values[i]?.[0] || '').trim() !== STATUS.pending) continue;
    data.push({
      range: tabRange(`${col}${FIRST_TEMPLE_ROW + i}`),
      values: [[STATUS.absent]],
    });
  }
  if (data.length) await updateValues(config.attendance.spreadsheetId, data);
  return data.length;
}

export { FIRST_TEMPLE_ROW, HEADER_ROW, SUBHEADER_ROW, FIRST_DATE_COL, tabRange };
