import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { snapshotDir, snapshotUrl } from '../attendance/snapshot.js';

/**
 * Presence frames live beside the attendance snapshots so the existing public
 * GET /snapshots/<file> route serves them to Google's =IMAGE() fetcher. The
 * name is flat and prefixed: express.static would serve a subdirectory too,
 * but the attendance prune counts only unprefixed files, and the prefix is
 * what keeps the two retention rules apart.
 */

export const PREFIX = 'presence-';

export const slug = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';

/** presence-2026-09-26-kailasa-usa-la-naivedyam-1145.jpg */
export const frameName = (entry, date) =>
  `${PREFIX}${date}-${slug(entry.templeRow)}-${slug(entry.ritual)}-${entry.time.replace(':', '')}.jpg`;

/**
 * Write a frame; returns its public URL (or null when nothing can serve it).
 * One file per slot, overwritten by each retry, so what is left is the frame
 * the verdict was taken on.
 */
export function saveFrame(name, jpeg) {
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, jpeg);
  fs.renameSync(tmp, path.join(dir, name));
  return snapshotUrl(name);
}

let lastPrune = 0;

/** Age out presence frames. At most hourly; never touches attendance frames. */
export function pruneFrames(now = Date.now()) {
  if (now - lastPrune < 3600_000) return;
  lastPrune = now;
  const cutoff = now - config.presence.frameRetentionDays * 86400_000;
  try {
    const dir = snapshotDir();
    if (!fs.existsSync(dir)) return;
    let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(PREFIX) || !f.endsWith('.jpg')) continue;
      const file = path.join(dir, f);
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed++;
      }
    }
    if (removed) log.info(`presence: pruned ${removed} frame(s) older than ${config.presence.frameRetentionDays} days`);
  } catch (err) {
    log.debug(`presence frame prune failed: ${err.message}`);
  }
}
