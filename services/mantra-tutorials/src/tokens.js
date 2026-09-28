// @ts-check
// Tokenisation is the one place that decides what a "word" is, so the underline
// (which follows transliteration words) and the alignment (which times them) can
// never drift apart. Both the Devanagari and the IAST line are tokenised the
// same way; §3 of the handover relies on token *i* of the Devanagari line being
// the same word as token *i* of the IAST line.

// Verse-boundary / danda / bullet markers that are shown but are not words.
const MARK = /[।॥|॰•]/gu;
// Punctuation trimmed off the ends of a token (kept for display, ignored for
// matching). Internal characters (e.g. an IAST diacritic) are left alone.
const EDGE_PUNCT = /^[.,;:!?—\-'"()[\]{}]+|[.,;:!?—\-'"()[\]{}]+$/gu;
// A pure number token — a verse number like "1" or "६". Shown, never a word.
const NUMBER = /^[\d०-९০-৯]+$/u;

/** Strip display punctuation to decide whether a raw token is a real word. */
function clean(tok) {
  return tok.replace(MARK, '').replace(EDGE_PUNCT, '').trim();
}

/** Is this raw whitespace-delimited token a timing word (not a marker/number)? */
export function isWordToken(raw) {
  const c = clean(raw);
  return c.length > 0 && !NUMBER.test(c);
}

/**
 * Split a line into ordered display segments, preserving punctuation and numbers
 * so the rendered slide reads exactly like the source, while flagging which
 * segments are real words (the ones that get an underline and a timestamp).
 * @param {string} line
 * @returns {{ text: string, word: boolean }[]}
 */
export function segmentLine(line) {
  const out = [];
  for (const raw of line.split(/\s+/u)) {
    if (!raw) continue;
    out.push({ text: raw, word: isWordToken(raw) });
  }
  return out;
}

/** The word segments of a line, in order. */
export function wordTokens(line) {
  return segmentLine(line).filter((s) => s.word).map((s) => clean(s.text));
}

/**
 * Zip a verse's Devanagari and IAST lines into a flat, parallel word list.
 * Returns one entry per displayed word, carrying its line index (`li`), its
 * index within that line (`wi`), its index within the verse (`gi`), the IAST
 * text (what is underlined) and the Devanagari text (what is phonetically
 * matched). `parallel` is false when the two scripts disagree on word count for
 * this verse — the caller then falls back to weighted timing for it.
 * @param {string[]} devLines @param {string[]} iastLines
 */
export function verseWords(devLines, iastLines) {
  const dev = devLines.map(wordTokens);
  const iast = iastLines.map(segmentLine);
  const words = [];
  let gi = 0;
  let devFlat = dev.flat();
  let iastCount = 0;
  for (let li = 0; li < iast.length; li++) {
    let wi = 0;
    for (const seg of iast[li]) {
      if (!seg.word) continue;
      words.push({ li, wi, gi, iast: clean(seg.text), dev: devFlat[gi] ?? '' });
      wi++;
      gi++;
      iastCount++;
    }
  }
  return { words, parallel: iastCount === devFlat.length, devCount: devFlat.length, iastCount };
}
