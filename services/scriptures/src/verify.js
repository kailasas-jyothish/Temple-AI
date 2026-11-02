// @ts-check
// Checks every extracted unit against the Devanagari the site itself renders
// for the same file. The site's HTML is generated from the same .itx by its
// own converter, so agreement here proves our ITRANS handling, and the gaps
// left over prove no passage was dropped.

/** Letters, vowel signs, virama, avagraha, Vedic signs: the text itself. Dandas, digits, spaces and punctuation are layout. */
const KEEP = /[ऀ-ॣ॰-ॿ᳐-᳿꣠-ꣿ]/u;
const SVARA = /[॒॑᳚]/g;

/**
 * Reduce Devanagari to the characters that carry text. Accents are dropped on
 * both sides: the site and sanscript order stacked marks differently, which is
 * not a difference in the text.
 * @param {string} s
 */
export function normalise(s) {
  let out = '';
  for (const ch of s.normalize('NFC').replace(SVARA, '')) {
    if (ch === '।' || ch === '॥') continue;
    if (KEEP.test(ch)) out += ch;
  }
  // ँ vs ꣳ before a consonant is a typographic choice the site makes per file.
  // The site's own converter sometimes renders R^i as ऱ्इ (seen in the
  // accented Brihadaranyaka); that is its bug, not a difference in the text.
  return out
    .replace(/ꣳ/g, 'ँ')
    .replace(/्ऱ्इ/g, 'ृ')
    .replace(/ऱ्इ/g, 'ऋ');
}

/** @param {string} s */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * The text block of a sanskritdocuments page: <pre id="content">…</pre>.
 * @param {string} html
 * @returns {string | null}
 */
export function siteText(html) {
  const m = /<pre\b[^>]*\bid="content"[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!m) return null;
  // The <h2> is the page title, which lives in the CSV's metadata, not in a row.
  return decodeEntities(m[1].replace(/<h2\b[\s\S]*?<\/h2>/i, '').replace(/<[^>]+>/g, '\n'));
}

const PROBE = 16;
const GAP_REPORT = 12;

/**
 * @typedef {{ devanagari: string, check?: string }} Checkable
 * @typedef {{ checked: number, ok: number, mismatched: number, notFound: number, coverage: number, gaps: string[] }} VerifyReport
 */

/**
 * Sets `check` on every unit ("ok", "mismatch: …", "not found on site", or ""
 * for units with no Devanagari) and reports site text no unit accounted for.
 * @param {Checkable[]} units
 * @param {string} html
 * @returns {VerifyReport | null} null when the page has no content block
 */
export function verifyUnits(units, html) {
  const text = siteText(html);
  if (text === null) return null;
  const site = normalise(text);
  /** @type {Array<[number, number]>} */
  const covered = [];
  const report = { checked: 0, ok: 0, mismatched: 0, notFound: 0, coverage: 0, gaps: /** @type {string[]} */ ([]) };
  let cursor = 0;

  for (const unit of units) {
    const mine = normalise(unit.devanagari || '');
    if (!mine) {
      unit.check = '';
      continue;
    }
    report.checked++;
    const whole = site.indexOf(mine, cursor);
    // A unit found far ahead means something in between was skipped; that is
    // reported as a gap below rather than hidden.
    if (whole >= 0) {
      unit.check = 'ok';
      report.ok++;
      covered.push([whole, whole + mine.length]);
      cursor = whole + mine.length;
      continue;
    }
    const at = site.indexOf(mine.slice(0, PROBE), cursor);
    if (at < 0) {
      unit.check = 'not found on site';
      report.notFound++;
      continue;
    }
    let k = 0;
    while (k < mine.length && at + k < site.length && mine[k] === site[at + k]) k++;
    const ours = mine.slice(Math.max(0, k - 6), k + 10);
    const theirs = site.slice(Math.max(at, at + k - 6), at + k + 10);
    unit.check = `mismatch at character ${k + 1}: ours "${ours}", site "${theirs}"`;
    report.mismatched++;
    covered.push([at, at + k]);
    cursor = at + Math.min(mine.length, k + 1);
  }

  covered.sort((a, b) => a[0] - b[0]);
  let end = 0;
  let used = 0;
  for (const [a, b] of covered) {
    if (a - end >= GAP_REPORT) report.gaps.push(site.slice(end, Math.min(a, end + 60)));
    if (b > end) {
      used += b - Math.max(a, end);
      end = b;
    }
  }
  if (site.length - end >= GAP_REPORT) report.gaps.push(site.slice(end, end + 60));
  report.coverage = site.length ? used / site.length : 1;
  return report;
}
