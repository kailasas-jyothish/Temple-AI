/**
 * Deciding whether a live stream is the temple's Garbha Mandir stream.
 *
 * Attendance is only about the 24/7 Garbha Mandir darshan. These channels also
 * stream festival pujas, SPH satsangs and yoga sessions, none of which count,
 * so a title that does not say so is not attendance.
 */

/**
 * Titles arrive full of mathematical-bold and fullwidth characters — these
 * channels post things like "𝗚𝗔𝗡𝗘𝗦𝗛𝗔 𝗖𝗛𝗔𝗧𝗨𝗥𝗧𝗛𝗜", which is not the letters
 * GANESHA to any regex until NFKC folds it back to ASCII. Punctuation is
 * flattened too so "24 / 7", "24-7" and "24/7" are one thing.
 */
export function normaliseTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Collapse separators so one pattern covers "24/7", "24 x 7", "24-7". */
const flatten = (s) => s.replace(/[\s/\-_.:·•|]+/g, '');

/**
 * Patterns are matched against both the normalised title and a separator-free
 * form of it, so a pattern written without punctuation catches every spelling
 * the temples actually use. Matching is substring, not whole-title: real titles
 * carry prefixes ("LIVE:", "🔴") and suffixes (dates, hashtags).
 */
export function matchesGarbhaMandir(title, patterns) {
  const normal = normaliseTitle(title);
  if (!normal) return null;
  const flat = flatten(normal);

  for (const pattern of patterns) {
    const needle = normaliseTitle(pattern);
    if (!needle) continue;
    if (normal.includes(needle) || flat.includes(flatten(needle))) return pattern;
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The column header, e.g. "22-Sep-2026".
 *
 * Deliberately UTC: the user reads this report from Guinea-Bissau, which is
 * UTC+0, and one shared day boundary is the only way a row of temples spanning
 * Singapore to Los Angeles can be compared at a glance. The temple's own
 * timezone is used for the displayed clock time, not for which day it lands in.
 */
export function utcDateLabel(date = new Date()) {
  const d = new Date(date);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** Read a "22-Sep-2026" header back into epoch ms, or NaN if it is not one. */
export function parseDateLabel(label) {
  const m = String(label || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return NaN;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (month < 0) return NaN;
  return Date.UTC(Number(m[3]), month, Number(m[1]));
}

/** Start of the UTC day containing `date`, in epoch ms. */
export function utcDayStart(date = new Date()) {
  const d = new Date(date);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The Started cell. A continuing stream is credited under a later date than
 * it began on, so it says so — "11:10 AM PDT" in the 23-Sep column, with no
 * hint it began on the 21st, is the kind of cell someone reasonably misreads.
 */
export function startedCellLabel(startedAt, date, timeZone) {
  const startedOn = utcDateLabel(startedAt);
  const clock = localTimeLabel(startedAt, timeZone);
  return startedOn === date ? clock : `${clock} (since ${startedOn.slice(0, 6)})`;
}

/**
 * "04:02 AM PDT" in the temple's own timezone, with whichever abbreviation is
 * correct on that date — the user asked for PST, and for half the year the
 * honest answer is PDT.
 */
export function localTimeLabel(when, timeZone) {
  const date = new Date(when);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    // An unknown IANA zone must not cost the mark — record UTC and move on.
    return `${new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date)} UTC`;
  }
}
