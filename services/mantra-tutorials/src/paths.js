// @ts-check
// Locate the two external binaries this service shells out to: ffmpeg (encode)
// and a Chromium-family browser (Devanagari shaping — see the handover: naive
// text drawing does not shape conjuncts, a real complex-text shaper does). On
// Windows this is msedge; in the Docker image it is headless chromium. An
// explicit env path always wins.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config } from './config.js';

const WIN = process.platform === 'win32';

const FFMPEG_CANDIDATES = [
  config.ffmpegPath,
  'C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe',
  WIN ? 'ffmpeg.exe' : 'ffmpeg',
].filter(Boolean);

const BROWSER_CANDIDATES = [
  config.browserPath,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

function usable(bin) {
  if (!bin) return false;
  // An absolute path we can stat, or a bare name we trust the PATH to resolve.
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin);
  const probe = spawnSync(bin, ['-version'], { windowsHide: true, timeout: 8000 });
  return !probe.error;
}

let cachedFfmpeg = '';
let cachedBrowser = '';

export function ffmpegPath() {
  if (cachedFfmpeg) return cachedFfmpeg;
  for (const c of FFMPEG_CANDIDATES) if (usable(c)) return (cachedFfmpeg = c);
  throw new Error('ffmpeg not found. Set FFMPEG_PATH.');
}

export function browserPath() {
  if (cachedBrowser) return cachedBrowser;
  for (const c of BROWSER_CANDIDATES) if (c && fs.existsSync(c)) return (cachedBrowser = c);
  // Last resort: a bare name on PATH (the container installs `chromium`).
  for (const c of ['chromium', 'chromium-browser', 'google-chrome']) {
    const probe = spawnSync(c, ['--version'], { windowsHide: true, timeout: 8000 });
    if (!probe.error) return (cachedBrowser = c);
  }
  throw new Error('No Chromium/Edge browser found. Set BROWSER_PATH.');
}
