// @ts-check
// Stage 1 — parse the Devanagari + transliteration markdown into structured
// verses. Generalised from prototype/extract.mjs: the section heading, the file
// paths and the expected verse count are all inputs now, and speaker/marker/
// closing detection stays script-agnostic.
import fs from 'node:fs';
import path from 'node:path';
import { log, warn } from './log.js';
import { devMarkdownToIast } from './translit.js';

// "## **1st Chapter** {#1st-chapter}" -> "1st chapter": exported Google-Docs
// markdown dresses the same heading differently in the two scripts' files.
const headingText = (l) => l.replace(/^#+/, '').replace(/\{#[^}]*\}/g, '').replace(/[*\\]/g, '')
  .replace(/\s+-\s*$/, '').trim().toLowerCase();

/**
 * One heading's block, up to the next heading of the same or a higher level, so
 * "3rd Chapter" stops at "4th Chapter" and "Rahasya Trayam" keeps its three
 * sub-headings. The whole text when section is ''.
 */
export function sectionLines(md, section, label) {
  const all = md.split(/\r?\n/);
  let body = all;
  if (section) {
    const want = headingText(section);
    const start = all.findIndex((l) => /^#+\s/.test(l) && headingText(l) === want);
    if (start < 0) throw new Error(`no "# ${section}" heading in ${label}`);
    const level = all[start].match(/^#+/)[0].length;
    let end = all.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
    if (end < 0) end = all.length;
    body = all.slice(start + 1, end);
  }
  // Bold markup and markdown escapes ("**श‍ऋणु**", a stray "\*") are not text.
  return body.filter((l) => !/^\s*\{#/.test(l) && !/^\s*#/.test(l))
    .map((l) => l.replace(/\*\*/g, '').replace(/\\(.)/g, '$1').replace(/^\*$/, '').trim())
    .filter(Boolean);
}

// Speaker lines come as "मार्कण्डेय उवाच", "ऋषिरुवाच", "राजोवाच", often with a
// trailing danda and, in this edition, their own number ("ब्रह्मोवाच॥ 72॥").
const stripMarker = (l) => l.replace(/\s*॥\s*[\d०-९\s]*॥?\s*$/u, '').replace(/\s*[।|]+\s*$/u, '');
const isSpeaker = (l) => {
  const s = stripMarker(l).replace(/^(ॐ|ओं|oṃ|om)\s+(ऐं|aiṃ)\s+/iu, '');
  return /(वाच|vāca)$/iu.test(s) && s.split(/\s+/).length <= 3 && !/\d/.test(s);
};
const markerNum = (l) => {
  // The closing ॥ is sometimes dropped or followed by a stray "|" in this edition.
  const m = l.match(/॥\s*([\d०-९]{1,3})[\d०-९\s]*(॥\s*[।|]*)?\s*$/u);
  return m ? parseInt(m[1].replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)), 10) : null;
};
// `\b` is ASCII-only in JS regex, so it never fires after Devanagari इति; use an
// explicit whitespace/end lookahead so the closing line is caught in both scripts.
const isIti = (l) => /^(इति|iti)(?=\s|$)/iu.test(l);
// "इति प्राधानिकं रहस्यं सम्पूर्णम्" closes a sub-section mid-recording.
const isSubClosing = (l) => isIti(l) && /(सम्पूर्ण|समाप्त|sampūrṇ|samāpt)/iu.test(l);

/**
 * Where the section's colophon begins. Verses also open with इति ("इति
 * ध्यात्वा…"), and a chapter's colophon runs on into numbered lines ("…अध्यायः॥
 * 1॥", "उवाच 14, … ॥ 104॥"), so neither "first इति" nor "after the last marker"
 * works. It is the start of the last run of इति lines.
 */
function closingStart(lines) {
  let i = lines.length - 1;
  while (i >= 0 && !isIti(lines[i])) i--;
  if (i < 0) return lines.length;
  while (i > 0 && isIti(lines[i - 1])) i--;
  return i;
}

/** Parse one script's section into { preamble, verses, closing }. */
export function parseScript(md, section, label) {
  const all = sectionLines(md, section, label);
  const cut = closingStart(all);
  const lines = all.slice(0, cut);
  const closing = all.slice(cut);
  const preamble = [];
  const verses = [];
  // A hymn with no speaker line at all (Devi Suktam) is verses from the top, and
  // so is an excerpt that opens mid-numbering (Ratri Suktam starts at ॥ 70 ॥):
  // a viniyoga or dhyana is never numbered past 1.
  const firstSpeaker = lines.findIndex(isSpeaker);
  let seenSpeaker = firstSpeaker < 0
    || lines.slice(0, firstSpeaker).some((l) => (markerNum(l) ?? 0) > 1);
  let pending = [];
  let pendingSpeaker = null;
  for (const line of lines) {
    if (isSubClosing(line) && seenSpeaker) {
      if (pending.length) verses.push({ number: verses.length + 1, speaker: pendingSpeaker, lines: pending });
      verses.push({ number: verses.length + 1, speaker: null, lines: [line] });
      pending = [];
      pendingSpeaker = null;
      continue;
    }
    if (isSpeaker(line)) { seenSpeaker = true; pendingSpeaker = line; continue; }
    if (!seenSpeaker) { preamble.push(line); continue; }
    pending.push(line);
    const n = markerNum(line);
    if (n !== null) {
      verses.push({ number: n, speaker: pendingSpeaker, lines: pending });
      pending = [];
      pendingSpeaker = null;
    }
  }
  // A trailing block with no closing marker (some mantras omit "iti"): keep it
  // as a final verse-less group so nothing is silently dropped.
  if (pending.length) verses.push({ number: verses.length + 1, speaker: pendingSpeaker, lines: pending });
  return { preamble, verses, closing };
}

/**
 * @param {import('./mantra.js').Mantra} mantra
 * @param {string} outDir
 */
export function extract(mantra, outDir) {
  const devMd = fs.readFileSync(mantra.devMarkdown, 'utf8');
  let engMd;
  if (mantra.engMarkdown) {
    engMd = fs.readFileSync(mantra.engMarkdown, 'utf8');
  } else {
    // No transliteration supplied: generate it line for line from the
    // Devanagari, so the two scripts pair by construction. Written out so what
    // the video shows can be read and, if needed, corrected and uploaded.
    engMd = devMarkdownToIast(devMd);
    fs.writeFileSync(path.join(outDir, 'iast-auto.md'), engMd, 'utf8');
    log('extract', 'no transliteration file: IAST generated from the Devanagari -> iast-auto.md');
  }
  const dev = parseScript(devMd, mantra.section, path.basename(mantra.devMarkdown));
  const eng = parseScript(engMd, mantra.section, mantra.engMarkdown ? path.basename(mantra.engMarkdown) : 'the generated IAST');

  if (dev.verses.length !== eng.verses.length) {
    throw new Error(`verse count mismatch: dev=${dev.verses.length} translit=${eng.verses.length}`);
  }
  if (mantra.expectedVerses && dev.verses.length !== mantra.expectedVerses) {
    warn('extract', `expected ${mantra.expectedVerses} verses, parsed ${dev.verses.length}`);
  }
  for (let i = 0; i < dev.verses.length; i++) {
    if (dev.verses[i].number !== eng.verses[i].number) {
      warn('extract', `numbering mismatch at index ${i}: dev=${dev.verses[i].number} translit=${eng.verses[i].number}`);
    }
  }

  let meaning = null;
  if (mantra.showMeaning && mantra.meaningMarkdown && fs.existsSync(mantra.meaningMarkdown)) {
    const m = parseScript(fs.readFileSync(mantra.meaningMarkdown, 'utf8'), mantra.section, path.basename(mantra.meaningMarkdown));
    if (m.verses.length === dev.verses.length) meaning = m;
    else warn('extract', `meaning has ${m.verses.length} verses vs ${dev.verses.length}; ignoring meaning`);
  }

  // `number` is only a key for timings and slides, and the printed markers are in
  // the text itself. Rahasya Trayam restarts at 1 three times in one recording,
  // so key by position rather than by what the text says.
  const verses = dev.verses.map((d, i) => ({
    number: i + 1,
    label: d.number,
    speaker: (d.speaker || eng.verses[i].speaker)
      ? { dev: d.speaker, eng: eng.verses[i].speaker } : null,
    dev: d.lines,
    eng: eng.verses[i].lines,
    meaning: meaning ? meaning.verses[i].lines : null,
  }));

  const out = {
    title: mantra.title,
    preamble: { dev: dev.preamble, eng: eng.preamble, meaning: meaning ? meaning.preamble : null },
    verses,
    closing: { dev: dev.closing, eng: eng.closing },
  };
  const p = path.join(outDir, 'verses.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  log('extract', `${verses.length} verses, ${dev.preamble.length} preamble lines${meaning ? ', +meaning' : ''} -> ${path.basename(p)}`);
  return out;
}
