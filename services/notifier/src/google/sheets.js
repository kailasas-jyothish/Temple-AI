import { accessToken, resetToken } from './auth.js';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function call(path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else if (v !== undefined) url.searchParams.set(k, v);
  }

  // One retry after clearing the token: the only 401 this can reasonably meet
  // is a token that expired between the check and the call.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
    if (res.ok) return payload;
    if (res.status === 401 && attempt === 0) {
      resetToken();
      continue;
    }
    const msg = payload?.error?.message || res.statusText;
    const err = new Error(`sheets ${method} ${path}: ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  throw new Error(`sheets ${method} ${path}: unauthorized after token refresh`);
}

/** Tab properties (id, title, grid size) for one spreadsheet. */
export async function tabs(spreadsheetId) {
  const body = await call(`/${spreadsheetId}`, {
    query: { fields: 'properties.title,sheets.properties' },
  });
  return {
    title: body.properties?.title,
    tabs: (body.sheets || []).map((s) => s.properties),
  };
}

export async function getValues(spreadsheetId, range, renderOption = 'FORMATTED_VALUE') {
  const body = await call(`/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
    query: { valueRenderOption: renderOption },
  });
  return body.values || [];
}

export async function batchGetValues(spreadsheetId, ranges, renderOption = 'FORMATTED_VALUE') {
  const body = await call(`/${spreadsheetId}/values:batchGet`, {
    query: { ranges, valueRenderOption: renderOption },
  });
  return (body.valueRanges || []).map((vr) => vr.values || []);
}

/**
 * Write cells. USER_ENTERED so an =IMAGE() formula and a =HYPERLINK() are
 * stored as formulas rather than as literal text.
 */
export async function updateValues(spreadsheetId, data) {
  return call(`/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: { valueInputOption: 'USER_ENTERED', data },
  });
}

/**
 * Add rows after the last non-empty row of `range`. INSERT_ROWS rather than
 * overwriting, so a note someone typed under the log is pushed down, not lost.
 */
export async function appendValues(spreadsheetId, range, values) {
  return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}:append`, {
    method: 'POST',
    query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
    body: { values },
  });
}

export async function clearValues(spreadsheetId, range) {
  return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, { method: 'POST' });
}

/** Structural operations: insert/delete columns, merge, format, freeze. */
export async function batchUpdate(spreadsheetId, requests) {
  if (!requests.length) return {};
  return call(`/${spreadsheetId}:batchUpdate`, { method: 'POST', body: { requests } });
}

/** 0-based column index to spreadsheet letters: 0 -> A, 26 -> AA. */
export function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Quote a tab name for use in an A1 range. */
export const quoteTab = (title) => `'${String(title).replace(/'/g, "''")}'`;
