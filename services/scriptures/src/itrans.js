// @ts-check
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {{ t: (text: string, from: string, to: string, options?: object) => string }} */
const Sanscript = require('./vendor/sanscript.cjs');

// sanskritdocuments writes a dialect of ITRANS with LaTeX macros in it. Anything
// sanscript would mangle is swapped for a placeholder inside ##…##, which
// sanscript passes through untouched, and restored after conversion.
const PLACEHOLDERS = {
  '@ANUN@': 'ꣳ', // {\m+}: the Vedic anusvara ꣳ, as the site renders it (sanscript gives ँ)
  '@DSV@': '᳚', // \" dirgha svarita ᳚, which sanscript's ITRANS does not know
  '@LDQ@': '“',
  '@RDQ@': '”',
  '@LSQ@': '‘',
  '@RSQ@': '’',
  '@SEP@': '',
};
const hold = (/** @type {keyof typeof PLACEHOLDERS} */ key) => `##${key}##`;

const YOGAVAHA = 'ंःँꣳ'; // ं ः ँ ꣳ
const SVARA = /[॒॑᳚]/g; // ॑ ॒ ᳚

/**
 * Normalise one line of the site's ITRANS so sanscript can read it.
 * @param {string} line
 */
export function preprocess(line) {
  let s = line;
  s = s.replace(/\{\\(?:Large|LARGE|large|huge|Huge)dvng\s*/g, '{');
  s = s.replace(/\{\\m\+\}/g, hold('@ANUN@'));
  s = s.replace(/\\"/g, hold('@DSV@'));
  s = s.replace(/\\`/g, '\\_'); // the site's anudatta; sanscript spells it \_
  s = s.replace(/\\ldq(?:\{\})?/g, hold('@LDQ@'));
  s = s.replace(/\\rdq(?:\{\})?/g, hold('@RDQ@'));
  s = s.replace(/\\lsq(?:\{\})?/g, hold('@LSQ@'));
  s = s.replace(/\\rsq(?:\{\})?/g, hold('@RSQ@'));
  s = s.replace(/R\\\^/g, 'R^');
  s = s.replace(/\\-/g, '-'); // a word broken across lines; the site keeps the hyphen
  s = s.replace(/\\([,;:?!*])/g, (_m, p) => `##${p}##`);
  s = s.replace(/\\\\/g, ' ');
  // An empty group between letters is ITRANS's separator: pra{}uga is प्रउग,
  // not प्रौग. A passthrough breaks sanscript's syllable state the same way.
  s = s.replace(/(?<=[A-Za-z~^.])\{\}(?=[A-Za-z])/g, hold('@SEP@'));
  // Other stray grouping braces from the TeX source carry no text.
  s = s.replace(/(?<!#)\{\}/g, '');
  s = s.replace(/\{([^{}#]*)\}/g, '$1');
  return s;
}

/**
 * ITRANS (site dialect) to Devanagari.
 * @param {string} itrans
 */
export function toDevanagari(itrans) {
  let out = Sanscript.t(preprocess(itrans), 'itrans', 'devanagari');
  for (const [key, ch] of Object.entries(PLACEHOLDERS)) out = out.split(key).join(ch);
  // sanscript writes its own accents after a following yogavaha (वायुः॑); the
  // placeholder accent lands before it and is moved to match.
  out = out.replace(new RegExp(`᳚([${YOGAVAHA}])`, 'g'), '$1᳚');
  return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** @param {string} deva */
export function stripAccents(deva) {
  return deva.replace(SVARA, '');
}

/**
 * Devanagari to IAST. Always derived from the Devanagari, so the two columns
 * cannot disagree. Accents are dropped first: sanscript's IAST accent output
 * is not a convention any reader would recognise (॑ comes out as U+032D).
 * @param {string} deva
 */
export function toIast(deva) {
  // प्रउग and प्रौग would both come out "prauga". IAST writes the hiatus with a
  // diaeresis (praüga, aïkya), so the vowel after an inherent a is marked first.
  const marked = stripAccents(deva).replace(/([अक-हक़-य़]़?)([इउ])/g, '$1$2').replace(/ꣳ/g, '');
  const out = Sanscript.t(marked, 'devanagari', 'iast')
    .replace(/ai/g, 'aï')
    .replace(/au/g, 'aü')
    .replace(//g, '')
    // sanscript reads the Vedic anusvara ꣳ as candrabindu (m̐); ṁ keeps it
    // apart from both that and the ordinary anusvara ṃ.
    .replace(//g, 'ṁ')
    // Vedic ळ: ḻ is the usual spelling (ḷ is already vocalic ऌ).
    .replace(/l̤/g, 'ḻ');
  // sanscript writes candrabindu as "~"; m̐ is the IAST convention.
  return out.replace(/~/g, 'm̐').normalize('NFC');
}
