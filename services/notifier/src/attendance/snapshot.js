import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { log } from '../log.js';

const run = promisify(execFile);

/**
 * A still of the stream as it actually looked when it started.
 *
 * yt-dlp resolves the HLS manifest and ffmpeg takes one frame off it. This is
 * a youtube.com request from a datacenter IP, which §9 of CLAUDE.md is a
 * monument to — it may be throttled or bot-checked at any time. So it is
 * strictly best-effort: on any failure the caller falls back to the thumbnail
 * the Data API already gave us, and the log says which one the cell got.
 */

export const snapshotDir = () => path.join(config.dataDir, 'snapshots');

const safeName = (s) => String(s).replace(/[^\w.-]/g, '_');

/**
 * Capture a frame. Returns a path relative to the snapshot directory, or null.
 * Never throws: a missing picture must not cost the attendance mark.
 */
export async function captureFrame(videoId, dateLabel) {
  if (!config.attendance.snapshotEnabled) return null;

  const dir = snapshotDir();
  const name = `${safeName(dateLabel)}-${safeName(videoId)}.jpg`;
  const target = path.join(dir, name);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(target)) return name;

    const timeout = config.attendance.snapshotTimeoutSeconds * 1000;
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // -g prints the media URLs without downloading.
    //
    // The format selector must not name a container: a live broadcast is
    // served as HLS, so `best[ext=mp4]` matches nothing and yt-dlp exits with
    // "Requested format is not available" — which is what the first version of
    // this did against a real stream. `best` picks a pre-muxed rendition, and
    // bv* is the fallback because a single frame needs no audio anyway.
    const { stdout } = await run(
      config.attendance.ytDlpPath,
      ['-g', '--no-warnings', '--no-playlist', '-f', 'best/bv*', url],
      { timeout, maxBuffer: 1 << 20 },
    );
    const media = stdout.split('\n').map((l) => l.trim()).find(Boolean);
    if (!media) throw new Error('yt-dlp returned no media URL');

    await run(
      config.attendance.ffmpegPath,
      [
        '-y',
        '-loglevel', 'error',
        '-i', media,
        '-frames:v', '1',
        '-q:v', '4',
        // 16:9 at the width the sheet displays; a full-resolution frame would
        // be ~40x the bytes for a 120px-wide cell.
        '-vf', 'scale=480:-2',
        target,
      ],
      { timeout, maxBuffer: 1 << 20 },
    );

    if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
      throw new Error('ffmpeg produced no frame');
    }
    log.info(`attendance: captured live frame for ${videoId}`);
    prune();
    return name;
  } catch (err) {
    // ENOENT here means the binary is absent, which is a deployment fact
    // rather than a transient failure — worth a distinct message.
    const why = err.code === 'ENOENT' ? `${err.path || 'yt-dlp/ffmpeg'} is not installed` : err.message;
    log.warn(`attendance: live frame capture failed for ${videoId} (${why}); using the API thumbnail`);
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      /* best effort */
    }
    return null;
  }
}

/** Public URL for a captured frame, or null when nothing can serve it. */
export function snapshotUrl(name) {
  const base = (config.attendance.snapshotBaseUrl || config.publicUrl || '').replace(/\/+$/, '');
  if (!base || !name) return null;
  return `${base}/snapshots/${encodeURIComponent(name)}`;
}

/** Keep the newest N frames; this volume also holds the dedupe state. */
function prune(keep = 400) {
  try {
    const dir = snapshotDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(dir, f));
  } catch (err) {
    log.debug(`snapshot prune failed: ${err.message}`);
  }
}
