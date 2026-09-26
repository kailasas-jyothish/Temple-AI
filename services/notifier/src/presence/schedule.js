/**
 * The puja schedule, and the clock arithmetic that turns "Naivedyam, 11:45,
 * Kailasa USA LA" into an instant.
 *
 * Everything here is pure — no config, no I/O — so the selftest can pin down
 * the parts that are easy to get subtly wrong: day matching, DST, and what
 * counts as the same slot twice.
 */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Sheet header text -> field. Matched on a lowercased prefix, so "Grace
// minutes", "Grace (min)" and "Grace" all land in the same place.
const HEADERS = [
  ['temple', 'temple'],
  ['ritual', 'ritual'],
  ['time', 'time'],
  ['day', 'days'],
  ['grace', 'grace'],
  ['enabled', 'enabled'],
  ['active', 'enabled'],
];

/** Map a header row to field names, by column index. */
export function headerMap(header) {
  const map = {};
  (header || []).forEach((cell, i) => {
    const h = String(cell || '').trim().toLowerCase();
    const hit = HEADERS.find(([prefix]) => h.startsWith(prefix));
    if (hit && !(hit[1] in map)) map[hit[1]] = i;
  });
  return map;
}

/** Sheet rows (header first) to plain objects, keeping the 1-based row number. */
export function rowsToObjects(values) {
  const [header, ...rows] = values || [];
  const map = headerMap(header);
  return rows.map((row, i) => {
    const out = { line: i + 2 };
    for (const [field, col] of Object.entries(map)) out[field] = row?.[col] ?? '';
    return out;
  });
}

/**
 * "11:45", "9:05", "11:45:00" or "11:45 AM" to minutes after midnight.
 *
 * The sheet asks for 24h HH:MM, but a cell someone formats as a time comes
 * back through the API as "11:45:00" or "11:45 AM" depending on its number
 * format — rejecting those would silently drop a correctly entered ritual.
 */
export function parseTime(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.[0]?.toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * "Daily" (or blank) -> null, meaning every day. Otherwise a sorted list of
 * weekday numbers (0 = Sunday). Ranges like "Mon-Fri" are accepted because
 * that is how people write them.
 */
export function parseDays(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'daily' || text === 'everyday' || text === 'every day' || text === 'all') return null;

  const dayIndex = (token) => {
    const i = token.length >= 3 ? DAY_FULL.findIndex((d) => d.startsWith(token)) : -1;
    if (i < 0) throw new Error(`"${token}" is not a weekday`);
    return i;
  };

  const days = new Set();
  for (const part of text.replace(/\s*-\s*/g, '-').split(/[,;/\s]+/).filter(Boolean)) {
    const range = part.split('-');
    if (range.length === 2) {
      let i = dayIndex(range[0]);
      const end = dayIndex(range[1]);
      days.add(i);
      while (i !== end) {
        i = (i + 1) % 7;
        days.add(i);
      }
    } else {
      days.add(dayIndex(part));
    }
  }
  return [...days].sort();
}

export const daysLabel = (days) => (days ? days.map((d) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1)).join(',') : 'Daily');

/** Blank means enabled; a checkbox comes back as TRUE/FALSE. */
export function parseEnabled(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '' || ['true', 'yes', 'y', '1', 'on'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(v)) return false;
  throw new Error(`Enabled must be TRUE or FALSE, not "${value}"`);
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate one row. Returns { entry } or { error } or { skip } — a disabled
 * row is not an error, and a temple with no timezone is a different problem
 * from a typo, so they are reported separately.
 *
 * `findTemple(label)` resolves a temples.json row label (case-insensitive).
 */
export function parseRow(raw, { findTemple, defaultGrace }) {
  const where = raw.line ? `row ${raw.line}` : 'entry';
  const label = String(raw.temple ?? '').trim();
  const ritual = String(raw.ritual ?? '').trim();
  if (!label && !ritual && !String(raw.time ?? '').trim()) return { skip: 'blank' };

  try {
    if (!parseEnabled(raw.enabled)) return { skip: 'disabled' };
  } catch (err) {
    return { error: `${where}: ${err.message}` };
  }
  if (!label) return { error: `${where}: Temple is empty` };
  if (!ritual) return { error: `${where}: Ritual is empty` };

  const temple = findTemple(label);
  if (!temple) return { error: `${where}: "${label}" is not a row label in temples.json` };
  if (!temple.tzConfigured || !validTimeZone(temple.tz)) {
    return { noTz: temple.row };
  }

  const minutes = parseTime(raw.time);
  if (minutes === null) return { error: `${where}: Time "${raw.time}" is not HH:MM (24h)` };

  let days;
  try {
    days = parseDays(raw.days);
  } catch (err) {
    return { error: `${where}: Days ${err.message}` };
  }

  const graceRaw = String(raw.grace ?? raw.graceMinutes ?? '').trim();
  const grace = graceRaw === '' ? defaultGrace : Number(graceRaw);
  if (!Number.isFinite(grace) || grace < 0 || grace > 180) {
    return { error: `${where}: Grace minutes "${graceRaw}" must be a number from 0 to 180` };
  }

  return {
    entry: {
      templeKey: temple.key,
      templeRow: temple.row,
      tz: temple.tz,
      ritual,
      minutes,
      time: hhmm(minutes),
      days,
      grace,
      line: raw.line || null,
    },
  };
}

/**
 * The whole schedule. Bad rows are collected rather than thrown: one typo in
 * a sheet the temple team edits must not switch off every other check.
 */
export function parseSchedule(rows, opts) {
  const entries = [];
  const errors = [];
  const noTz = new Set();
  const seen = new Set();
  for (const raw of rows) {
    const r = parseRow(raw, opts);
    if (r.error) errors.push(r.error);
    else if (r.noTz) noTz.add(r.noTz);
    else if (r.entry) {
      const id = `${r.entry.templeKey}|${r.entry.ritual.toLowerCase()}|${r.entry.time}`;
      if (seen.has(id)) {
        errors.push(`${raw.line ? `row ${raw.line}` : 'entry'}: duplicate of ${r.entry.templeRow} ${r.entry.ritual} ${r.entry.time}`);
        continue;
      }
      seen.add(id);
      entries.push(r.entry);
    }
  }
  return { entries, errors, noTz: [...noTz] };
}

// ------------------------------------------------------------------ clock

const partsFormatters = new Map();
function partsIn(ms, tz) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (LA in summer: -7h). */
function offsetAt(ms, tz) {
  const p = partsIn(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `tz`.
 *
 * Two passes because the offset depends on the answer: the first guess can
 * land on the other side of a DST change. A time that does not exist (02:30
 * on spring-forward night) comes out an hour off; no puja is scheduled in
 * that hour, so it is not worth special-casing.
 */
export function zonedTimeToUtc(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = naive - offsetAt(naive, tz);
  const second = naive - offsetAt(t, tz);
  if (second !== t) t = second;
  return t;
}

/** "2026-09-26" — the temple's own calendar date at instant `ms`. */
export function localDate(ms, tz) {
  const p = partsIn(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "11:47" in the temple's own clock. */
export function localClock(ms, tz) {
  const p = partsIn(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const weekdayOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

export const runsOn = (entry, dateStr) => !entry.days || entry.days.includes(weekdayOf(dateStr));

/** Dedupe key for one occurrence. Stable across restarts and schedule re-reads. */
export const slotKey = (entry, dateStr) => `${entry.templeRow}|${entry.ritual}|${dateStr}|${entry.time}`;

/** One occurrence of `entry` on the temple-local date `dateStr`. */
export function slotOn(entry, dateStr) {
  const scheduledAt = zonedTimeToUtc(dateStr, entry.minutes, entry.tz);
  return {
    key: slotKey(entry, dateStr),
    date: dateStr,
    scheduledAt,
    graceEndsAt: scheduledAt + entry.grace * 60_000,
  };
}

/**
 * Occurrences that have started by `now`: today's, and yesterday's too, so a
 * 23:55 ritual with 15 minutes' grace is still found after local midnight.
 */
export function startedSlots(entry, now) {
  const today = localDate(now, entry.tz);
  return [shiftDate(today, -1), today]
    .filter((d) => runsOn(entry, d))
    .map((d) => slotOn(entry, d))
    .filter((s) => s.scheduledAt <= now);
}

/** The next occurrence strictly after `now`, within a week; null if none. */
export function nextSlot(entry, now) {
  const today = localDate(now, entry.tz);
  for (let i = 0; i <= 8; i++) {
    const d = shiftDate(today, i);
    if (!runsOn(entry, d)) continue;
    const s = slotOn(entry, d);
    if (s.scheduledAt > now) return s;
  }
  return null;
}

/**
 * What to do with each started slot, given the keys already fired.
 * `fire` = start checking now; `missed` = its grace window ended before we
 * got to it (the service was down), so it is logged and never checked late.
 */
export function dueSlots(entries, now, fired) {
  const fire = [];
  const missed = [];
  for (const entry of entries) {
    for (const slot of startedSlots(entry, now)) {
      if (fired.has(slot.key)) continue;
      (now > slot.graceEndsAt ? missed : fire).push({ entry, slot });
    }
  }
  return { fire, missed };
}

/** Whole minutes after the scheduled time, never negative. */
export const minutesLate = (scheduledAt, checkedAt) => Math.max(0, Math.round((checkedAt - scheduledAt) / 60_000));
