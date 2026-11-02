// @ts-check
// Written for Excel and Google Sheets first: a UTF-8 BOM (without it Excel
// reads the file as the local codepage and Devanagari turns to mojibake), CRLF
// between rows, and LF kept inside quoted cells so a verse keeps its lines.

/** @param {unknown} v */
function cell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  // A leading = + - @ makes a spreadsheet evaluate the cell as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * @param {string[]} columns
 * @param {Array<Record<string, unknown>>} rows
 */
export function toCsv(columns, rows) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Minimal reader for files this module wrote (used by tests and to read a
 * CSV a person edited and sent back).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
