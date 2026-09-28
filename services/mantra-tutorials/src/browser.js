// @ts-check
// Thin wrapper over a headless Chromium/Edge for two jobs: screenshot an HTML
// page to a 1920x1080 PNG, and read layout back after the page's own JS has
// written measured boxes into data-* attributes (via --dump-dom). Both flag sets
// are identical between Edge and chromium, so the same code drives either.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { browserPath } from './paths.js';

const COMMON = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--virtual-time-budget=2500',
];

function fileUrl(p) {
  return `file:///${p.replace(/\\/g, '/')}`;
}

/** Write html to disk and return its path (so relative asset urls resolve). */
export function writeHtml(dir, name, html) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

/** Screenshot an on-disk HTML file to `png`. Returns true on success. */
export function screenshot(htmlPath, png) {
  const r = spawnSync(browserPath(), [
    ...COMMON,
    `--screenshot=${png}`,
    '--window-size=1920,1080',
    '--default-background-color=00000000',
    fileUrl(htmlPath),
  ], { stdio: 'pipe', windowsHide: true, timeout: 60000 });
  if (!fs.existsSync(png)) {
    throw new Error(`screenshot failed (${r.status}) for ${htmlPath}: ${r.stderr || r.error}`);
  }
  return true;
}

/**
 * Load an on-disk HTML file and return the parsed values of the requested
 * data-* attributes on <html> (written by the page's own measuring script).
 * @param {string} htmlPath @param {string[]} attrs e.g. ['data-boxes','data-scale']
 * @returns {Record<string, any>}
 */
export function dumpData(htmlPath, attrs, extraArgs = []) {
  const r = spawnSync(browserPath(), [...COMMON, ...extraArgs, '--dump-dom', fileUrl(htmlPath)], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  const dom = r.stdout || '';
  const out = {};
  for (const a of attrs) {
    const m = dom.match(new RegExp(`${a}="([^"]*)"`));
    if (!m) { out[a] = null; continue; }
    const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    try { out[a] = JSON.parse(raw); } catch { out[a] = raw; }
  }
  return out;
}
