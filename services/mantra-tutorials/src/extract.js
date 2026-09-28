// @ts-check
// Stage 1 — parse the Devanagari + transliteration markdown into structured
// verses. Generalised from prototype/extract.mjs: the section heading, the file
// paths and the expected verse count are all inputs now, and speaker/marker/
// closing detection stays script-agnostic.
import fs from 'node:fs';
import path from 'node:path';
import { log, warn } from './log.js';

/** Slice out one '# <section>' block, or the whole file when section is ''. */
function sectionLines(file, section) {
  const md = fs.readFileSync(file, 'utf8');
  let body = md;
  if (section) {
    const start = md.indexOf(`# ${section}`);
    if (start < 0) throw new Error(`no "# ${section}" heading in ${file}`);
    const afterHeading = md.indexOf('\n', start) + 1;
    const nextIdx = md.indexOf('\n# ', afterHeading);
    body = md.slice(afterHeading, nextIdx < 0 ? md.length : nextIdx);
  }
  return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\{#/.test(l) && !/^#/.test(l));
}

const isSpeaker = (l) => /(उवाच|ब्रह्मोवाच|ovāca|uvāca)\s*$/iu.test(l) && l.split(/\s+/).length <= 3 && !/\d/.test(l);
const markerNum = (l) => {
  const m = l.match(/॥\s*([\d०-९]{1,3})[\d०-९\s]*॥\s*$/u);
  return m ? parseInt(m[1].replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)), 10) : null;
};
// `\b` is ASCII-only in JS regex, so it never fires after Devanagari इति; use an
// explicit whitespace/end lookahead so the closing line is caught in both scripts.
const isClosing = (l) => /^(इति|iti)(?=\s|$)/iu.test(l);

/** Parse one script's section into { preamble, verses, closing }. */
function parseScript(file, section) {
  const lines = sectionLines(file, section);
  const preamble = [];
  const closing = [];
  const verses = [];
  let seenSpeaker = false;
  let done = false;
  let pending = [];
  let pendingSpeaker = null;
  for (const line of lines) {
    if (done) { closing.push(line); continue; }
    if (isClosing(line)) { done = true; closing.push(line); continue; }
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
  const dev = parseScript(mantra.devMarkdown, mantra.section);
  const eng = parseScript(mantra.engMarkdown, mantra.section);

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
    const m = parseScript(mantra.meaningMarkdown, mantra.section);
    if (m.verses.length === dev.verses.length) meaning = m;
    else warn('extract', `meaning has ${m.verses.length} verses vs ${dev.verses.length}; ignoring meaning`);
  }

  const verses = dev.verses.map((d, i) => ({
    number: d.number,
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
