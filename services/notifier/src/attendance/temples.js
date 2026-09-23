import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { matchesGarbhaMandir } from './match.js';

let registry = null;

const clean = (s) => String(s || '').trim().toLowerCase();
const list = (v) => (Array.isArray(v) ? v : []);

export function loadTemples() {
  if (registry) return registry;

  let parsed = { patterns: [], temples: [] };
  try {
    parsed = JSON.parse(fs.readFileSync(config.attendance.templesFile, 'utf8'));
  } catch (err) {
    log.error(`attendance: cannot read ${config.attendance.templesFile}: ${err.message}`);
  }

  const shared = list(parsed.patterns);
  const temples = (parsed.temples || []).map((t) => ({
    // The row label is the identity, not the channel: one channel can carry
    // more than one temple's Garbha Mandir (Tanjavur's streams Rwanda's).
    key: clean(t.row),
    handle: t.handle || '',
    channelId: t.channelId || '',
    row: String(t.row || '').trim(),
    tz: t.tz || 'UTC',
    // Shared patterns plus this temple's own. A temple with an unusual title
    // convention gets it listed against itself rather than widening the rule
    // for every channel.
    patterns: [...shared, ...list(t.patterns)],
    // For a shared channel: a title must name one of `requires` and none of
    // `excludes` to belong to this temple rather than its neighbour.
    requires: list(t.requires),
    excludes: list(t.excludes),
  }));

  registry = { patterns: shared, temples };
  return registry;
}

/** Only for tests and the selftest — forget the cached file. */
export function resetTemples() {
  registry = null;
}

export const allTemples = () => loadTemples().temples;

export const templeByKey = (key) => allTemples().find((t) => t.key === clean(key)) || null;

/** Every temple whose stream appears on this channel. */
export function templesForChannel(channelId) {
  const id = clean(channelId);
  return id ? allTemples().filter((t) => clean(t.channelId) === id) : [];
}

/** Whether `title` is `temple`'s Garbha Mandir stream: the pattern it matched, or null. */
export function matchTemple(temple, title) {
  if (temple.requires.length && !matchesGarbhaMandir(title, temple.requires)) return null;
  if (temple.excludes.length && matchesGarbhaMandir(title, temple.excludes)) return null;
  return matchesGarbhaMandir(title, temple.patterns);
}

/** The temple a live stream on this channel counts for, and why — or null. */
export function templeForStream(channelId, title) {
  for (const temple of templesForChannel(channelId)) {
    const matched = matchTemple(temple, title);
    if (matched) return { temple, matched };
  }
  return null;
}

/** Row labels that attendance is tracked for, lowercased for comparison. */
export const trackedRowLabels = () => new Set(allTemples().map((t) => t.key));

export { clean as normaliseLabel };
