// @ts-check
import { toDevanagari, toIast } from './itrans.js';

/**
 * @typedef {'invocation' | 'heading' | 'verse' | 'text' | 'colophon' | 'closing'} Kind
 * @typedef {{
 *   seq: number,
 *   kind: Kind,
 *   ref: string,
 *   section: string,
 *   verseNo: string,
 *   itrans: string,
 *   devanagari: string,
 *   iast: string,
 *   english?: string,
 *   check?: string,
 *   notes?: string,
 * }} Unit
 * @typedef {Omit<Unit, 'seq' | 'ref' | 'devanagari' | 'iast'> & { level?: number | null, label?: string }} RawUnit
 * @typedef {{ meta: Record<string, string>, title: { english: string, itrans: string }, units: Unit[], warnings: string[] }} Parsed
 */

// "|| 12||", ".. 1\.4..", "|| 14|| 1||" (Kanva Isha numbers the mantra and the
// adhyaya). The number is what makes it a verse end; an unnumbered "||" is
// just punctuation inside a longer passage.
const NUM = String.raw`\d+(?:\\?\.\d+)*`;
const TERM = new RegExp(String.raw`(?:\|\||\.\.|\|)\s*(${NUM})\s*(?:\|\||\.\.|\|)(?:\s*(${NUM})\s*(?:\|\||\.\.))?`, 'g');

// Layout-only TeX the site's HTML shows nothing for.
const LAYOUT = /\\(?:medskip|bigskip|smallskip|hrule|newpage|pagebreak|clearpage|obeylines|obeyspaceslines|endtitles|noindent|vfill|hfill|centering|par|item|begin\{[^}]*\}|end\{[^}]*\}|twocolumn|onecolumn)\b(?:\[[^\]]*\])?/g;

const HEADING_LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };

/** @param {string} raw */
function parseHeader(raw) {
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^%\s*([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1].trim()] = m[2].trim().replace(/\\_/g, '_');
  }
  return meta;
}

/** @param {string} s */
const englishText = (s) => s.replace(/##/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

/** Strip one wrapping macro call that owns the whole line: \centerline{…}, \yyy{…}. */
function unwrap(/** @type {string} */ line) {
  const m = /^\\([A-Za-z]+)\*?\s*\{(.*)\}\s*(?:##)?\s*$/.exec(line);
  return m ? { macro: m[1], inner: m[2].trim() } : null;
}

const COLOPHON_WORD = /upani[sS]h|adhyAy|vall[iI]|khaN[Dd]|anuvAk|brAhmaN|prapAThak|prashn|muND|samAp|kANDa|bhAShy/;

// A heading's own number, so "Part I" repeated before every canto, or
// "dvitIyo.adhyAyaH", give the right ref rather than a running count.
const ORDINALS = [
  ['ekādaś', 11], ['dvādaś', 12], ['trayodaś', 13], ['caturdaś', 14], ['pañcadaś', 15], ['ṣoḍaś', 16],
  ['saptadaś', 17], ['aṣṭādaś', 18], ['pratham', 1], ['dvitīy', 2], ['tṛtīy', 3], ['caturth', 4],
  ['pañcam', 5], ['ṣaṣṭh', 6], ['saptam', 7], ['aṣṭam', 8], ['navam', 9], ['daśam', 10],
];
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };

/** @param {string} label */
export function headingNumber(label) {
  // First digit run, so "ch1 {= SBM 10.6.4.1}" is chapter 1, not 10.
  const digits = /(\d+)/.exec(label);
  if (digits) return Number(digits[1]);
  const roman = /\b([ivxlc]+)\b\.?\s*$/i.exec(label.trim());
  if (roman) {
    const chars = roman[1].toLowerCase().split('').map((c) => ROMAN[/** @type {keyof typeof ROMAN} */ (c)]);
    return chars.reduce((sum, v, i) => sum + (v < (chars[i + 1] || 0) ? -v : v), 0);
  }
  const lower = label.toLowerCase();
  for (const [word, n] of ORDINALS) if (lower.includes(/** @type {string} */ (word))) return /** @type {number} */ (n);
  return null;
}

/** @param {string} s */
const dandaEnds = (s) => /(\|\||\||\.\.|\.)\s*$/.test(s);

/**
 * @param {string} itx full file contents
 * @returns {Parsed}
 */
export function parseItx(itx) {
  const meta = parseHeader(itx);
  const warnings = /** @type {string[]} */ ([]);
  const text = itx.replace(/\r\n?/g, '\n');
  const begin = text.indexOf('\\begin{document}');
  let body = begin >= 0 ? text.slice(begin + '\\begin{document}'.length) : text;
  const end = body.search(/\\end\{document\}|Please send corrections/);
  if (end >= 0) body = body.slice(0, end);

  const title = { english: '', itrans: '' };
  /** @type {RawUnit[]} */
  const raw = [];
  /** @type {string[]} */
  let buffer = [];
  let english = false;
  // Paragraph markers ("##{pMK3}##" in the Brihadaranyaka) number the passage that follows.
  let pendingNo = '';
  const credits = /** @type {string[]} */ ([]);
  const sectionPath = /** @type {string[]} */ ([]);
  const sectionLabel = () => sectionPath.filter(Boolean).join(' › ');

  const flush = (/** @type {string} */ verseNo = '') => {
    verseNo = verseNo || pendingNo;
    const lines = buffer.map((l) => l.trim()).filter(Boolean);
    buffer = [];
    if (!lines.length) return;
    pendingNo = '';
    raw.push({ kind: verseNo ? 'verse' : 'text', section: sectionLabel(), verseNo, itrans: lines.join('\n') });
  };
  /** @param {Kind} kind @param {string} itrans @param {number | null} level @param {string} [english] */
  const emit = (kind, itrans, level = null, english) => {
    flush();
    if (kind === 'heading' && level !== null) {
      const label = english || toIast(toDevanagari(itrans)).replace(/[|]+/g, '').trim();
      sectionPath.length = level;
      sectionPath[level] = label;
    }
    raw.push({ kind, section: sectionLabel(), verseNo: '', itrans, english, level, label: level !== null ? sectionPath[level] : undefined });
  };

  for (const original of body.split('\n')) {
    let line = original.replace(/\t/g, ' ').trim();
    if (!line || line.startsWith('%')) { flush(); continue; }

    const t = /^\\(engtitle|itxtitle)\{(.*)\}/.exec(line);
    if (t) {
      if (t[1] === 'engtitle') title.english = englishText(t[2]).replace(/^[.\s]+|[.\s]+$/g, '');
      else title.itrans = t[2].replace(/^[.\s]+|[.\s]+$/g, '');
      continue;
    }

    line = line.replace(LAYOUT, '').trim();
    // ## toggles ITRANS off and on, and a toggle can span lines: the closing
    // "##" before the encoder credits switches everything after it to English.
    // Each line is rebalanced so it carries its own mode.
    const startsEnglish = english;
    if ((line.match(/##/g) || []).length % 2) english = !english;
    if (startsEnglish) line = `##${line}`;
    if ((line.match(/##/g) || []).length % 2) line = `${line}##`;
    line = line.replace(/####/g, '').trim();
    if (!line || /^(##\s*)+$/.test(line)) { flush(); continue; }
    if (startsEnglish && english && /^##[^#]*##$/.test(line)) {
      // Prose in English mode across lines is the encoder's credit, not text.
      flush();
      credits.push(englishText(line));
      continue;
    }

    const h = /^\\(part|chapter|section|subsection|subsubsection)\*?\s*\{(.*)\}/.exec(line);
    if (h) {
      const inner = h[2].trim();
      const isEnglish = /^##.*##$/.test(inner);
      emit('heading', isEnglish ? '' : inner, HEADING_LEVEL[/** @type {keyof typeof HEADING_LEVEL} */ (h[1])], isEnglish ? englishText(inner) : undefined);
      continue;
    }

    if (/^##[^#]*##$/.test(line)) {
      const english = englishText(line);
      if (!english) { flush(); continue; }
      // "pM8/k7": paragraph 8 in the Madhyandina recension, 7 in the Kanva.
      const para = /^p[A-Za-z]{0,3}\s*(\d+)(?:\s*\/\s*k\s*(\d+))?\s*(.*)$/.exec(english);
      if (para) {
        flush();
        pendingNo = para[1] + (para[2] ? ` (K ${para[2]})` : '');
        continue;
      }
      // A critical edition's apparatus ("pro m3, K schribit…; vide infra") is a note, not a heading.
      if (/\b(schribit|vide (infra|supra)|variato|infine)\b|^K\s*(\d|add)/.test(english)) {
        const target = raw[raw.length - 1];
        if (target) target.notes = [target.notes, english].filter(Boolean).join('; ');
        continue;
      }
      emit('heading', '', /^part\b/i.test(english) ? 0 : 1, english);
      continue;
    }

    const w = unwrap(line);
    if (w) {
      if (/^iti/.test(w.macro)) { if (w.inner) emit('colophon', w.inner); else flush(); continue; }
      line = w.inner;
      if (!line) { flush(); continue; }
    } else if (/^\\iti(big)?\b/.test(line)) {
      const inner = line.replace(/^\\iti(big)?\s*/, '');
      if (inner) emit('colophon', inner); else flush();
      continue;
    }

    TERM.lastIndex = 0;
    const hasNumber = TERM.test(line);
    TERM.lastIndex = 0;
    if (!hasNumber && dandaEnds(line)) {
      const bare = line.replace(/^(\|\||\.\.|\|)\s*/, '');
      const wrapped = bare !== line;
      // "iti … vallI ||" closes a division; inside a passage a line can start
      // with iti too, so a bare one counts only after a verse or when it names
      // a division.
      if (/^iti\b/.test(bare) && (wrapped || !buffer.length || COLOPHON_WORD.test(bare))) { emit('colophon', line); continue; }
      if (/^atha\b/.test(bare) && wrapped) { emit('heading', line); continue; }
    }

    let rest = line;
    let m;
    let last = 0;
    while ((m = TERM.exec(line))) {
      buffer.push(line.slice(last, m.index + m[0].length));
      last = m.index + m[0].length;
      const no = m[1].replace(/\\/g, '') + (m[2] ? ` (${m[2].replace(/\\/g, '')})` : '');
      flush(no);
    }
    rest = line.slice(last);
    if (rest.trim()) buffer.push(rest);
    if (/\\[A-Za-z]{2,}/.test(rest)) warnings.push(`unknown macro kept as text: ${rest.trim().slice(0, 80)}`);
  }
  flush();

  if (credits.length) meta.Credits = credits.join(' ');
  return { meta, title, units: finish(raw), warnings };
}

/** Classify unnumbered passages and give every verse a citable reference. */
function finish(/** @type {RawUnit[]} */ raw) {
  const firstVerse = raw.findIndex((u) => u.kind === 'verse');
  const lastVerse = raw.findLastIndex((u) => u.kind === 'verse');

  // Ordinal of each heading among its siblings, for numeric refs (Katha 1.2.5).
  const counters = /** @type {number[]} */ ([]);
  let block = 1;
  let lastFirst = 0;
  const labels = /** @type {string[]} */ ([]);
  // Per heading path: has numbering restarted under it? Taittiriya restarts at
  // every anuvaka with no heading, so 1.1 must become 1.1.1 once 1.2.1 exists.
  /** @type {Map<string, boolean>} */
  const restarts = new Map();
  /** @type {{ unit: Unit, path: string, block: number }[]} */
  const verses = [];

  const units = raw.map(({ level, label, ...u }, i) => {
    /** @type {Unit} */
    const unit = { ...u, seq: i + 1, ref: '', devanagari: '', iast: '' };
    if (u.kind === 'heading' && typeof level === 'number') {
      const own = headingNumber(label || '');
      const same = labels[level] === label;
      const n = own ?? (same ? counters[level] : (counters[level] || 0) + 1);
      if (!same || own !== null) {
        counters.length = level + 1;
        labels.length = level + 1;
        block = 1;
        lastFirst = 0;
      }
      counters[level] = n;
      labels[level] = label || '';
    }
    // Unnumbered text before the first verse is the opening shanti; after the
    // last, the closing one. A text with no numbered verses keeps "text".
    if (u.kind === 'text' && firstVerse >= 0) {
      if (i < firstVerse) unit.kind = 'invocation';
      else if (i > lastVerse) unit.kind = 'closing';
    }
    if (u.kind === 'verse') {
      const first = Number(/^\d+/.exec(u.verseNo)?.[0] || 0);
      if (lastFirst && first <= lastFirst) block += 1;
      lastFirst = first;
      const path = counters.filter((c) => c !== undefined).join('.');
      if (block > 1) restarts.set(path, true);
      verses.push({ unit, path, block });
    }
    if (u.itrans) {
      unit.devanagari = toDevanagari(u.itrans);
      unit.iast = toIast(unit.devanagari);
    }
    return unit;
  });

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const { unit, path, block } of verses) {
    // A number that already carries its own path (Chandogya's 1.1.1) is kept as written.
    let ref = unit.verseNo.includes('.')
      ? unit.verseNo
      : [path, restarts.get(path) ? block : '', unit.verseNo].filter((p) => p !== '').join('.');
    const n = (seen.get(ref) || 0) + 1;
    seen.set(ref, n);
    if (n > 1) ref += ` #${n}`;
    unit.ref = ref;
  }
  return units;
}
