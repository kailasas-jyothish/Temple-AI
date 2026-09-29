// @ts-check
// Devanagari -> IAST, for bundles that supply only the Devanagari. The mapping
// is the indic-transliteration project's own sanscript.js (MIT), vendored
// unmodified in src/vendor so the service keeps zero runtime deps.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {{ t: (text: string, from: string, to: string, opts?: any) => string }} */
const Sanscript = require('./vendor/sanscript.cjs');

/** Transliterate one line of Devanagari to IAST. Latin text passes through. */
export function devToIast(line) {
  // The dandas stay as they are (। ॥), as in the hand-typed bundles. sanscript
  // would write "|" and "||", which the word splitter then counts as words, and
  // the IAST line would no longer pair word-for-word with its Devanagari.
  return line.split(/([।॥])/u)
    .map((part) => (part === '।' || part === '॥' ? part : Sanscript.t(part, 'devanagari', 'iast')))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Transliterate a whole markdown file's text, line by line, keeping headings. */
export function devMarkdownToIast(md) {
  return md.split(/\r?\n/).map((l) => (/^\s*#/.test(l) ? l : devToIast(l))).join('\n');
}
