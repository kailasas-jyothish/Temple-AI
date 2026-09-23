import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';

let registry = null;

const clean = (s) => String(s || '').trim().toLowerCase();

export function loadTemples() {
  if (registry) return registry;

  let parsed = { patterns: [], temples: [] };
  try {
    parsed = JSON.parse(fs.readFileSync(config.attendance.templesFile, 'utf8'));
  } catch (err) {
    log.error(`attendance: cannot read ${config.attendance.templesFile}: ${err.message}`);
  }

  const shared = Array.isArray(parsed.patterns) ? parsed.patterns : [];
  const temples = (parsed.temples || []).map((t) => ({
    handle: t.handle || '',
    channelId: t.channelId || '',
    row: String(t.row || '').trim(),
    tz: t.tz || 'UTC',
    // Shared patterns plus this temple's own. A temple with an unusual title
    // convention gets it listed against itself rather than widening the rule
    // for every channel.
    patterns: [...shared, ...(Array.isArray(t.patterns) ? t.patterns : [])],
  }));

  registry = { patterns: shared, temples };
  return registry;
}

/** Only for tests and the selftest — forget the cached file. */
export function resetTemples() {
  registry = null;
}

export const allTemples = () => loadTemples().temples;

/** The temple a YouTube channel belongs to, or null if it is not tracked. */
export function templeForChannel(channelId, handle = '') {
  const id = clean(channelId);
  const h = clean(handle);
  return (
    allTemples().find((t) => clean(t.channelId) === id && id) ||
    allTemples().find((t) => clean(t.handle) === h && h) ||
    null
  );
}

/** Row labels that attendance is tracked for, lowercased for comparison. */
export const trackedRowLabels = () => new Set(allTemples().map((t) => clean(t.row)));

export { clean as normaliseLabel };
