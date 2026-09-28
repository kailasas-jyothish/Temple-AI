// @ts-check
// Stage 3 — turn word placements into the per-word timeline slides and render
// consume. alignForced() is the primary path (forced alignment, src/forced.js).
// align() below is the older fallback: Deepgram's Sanskrit output is an approximate roman
// transcription, so matching is on a phonetic key (Devanagari consonant skeleton
// ↔ roman consonant skeleton) via Needleman–Wunsch, exactly as the prototype
// proved. The prototype then collapsed to one start per verse; here we keep every
// matched word's start/end and interpolate the gaps, which is what lets the
// underline track the chant word by word instead of crawling per verse.
import fs from 'node:fs';
import path from 'node:path';
import { verseWords } from './tokens.js';
import { log, warn } from './log.js';

// ---- phonetic key (proven in the prototype) ----
const consonants = new Map();
const mapChars = (chars, value) => { for (const c of chars) consonants.set(c, value); };
mapChars('कख', 'k'); mapChars('गघ', 'g'); mapChars('ङ', 'n');
mapChars('चछ', 'c'); mapChars('जझ', 'j'); mapChars('ञ', 'n');
mapChars('टठ', 't'); mapChars('डढड़', 'd'); mapChars('णन', 'n');
mapChars('तथ', 't'); mapChars('दध', 'd');
mapChars('पफ', 'p'); mapChars('बभ', 'b'); mapChars('म', 'm');
mapChars('यर', 'r'); mapChars('लळ', 'l'); mapChars('व', 'v');
mapChars('शषस', 's'); mapChars('ह', 'h'); mapChars('क़ख़ग़', 'k');
mapChars('কখ', 'k'); mapChars('গঘ', 'g'); mapChars('ঙ', 'n');
mapChars('চছ', 'c'); mapChars('জঝ', 'j'); mapChars('ঞ', 'n');
mapChars('টঠ', 't'); mapChars('ডঢ', 'd'); mapChars('ণন', 'n');
mapChars('তথ', 't'); mapChars('দধ', 'd'); mapChars('পফ', 'p');
mapChars('বভ', 'b'); mapChars('ম', 'm'); mapChars('য', 'r');
mapChars('র', 'r'); mapChars('ল', 'l'); mapChars('শষস', 's'); mapChars('হ', 'h');

function phoneticKey(value) {
  let key = '';
  for (const char of value.normalize('NFKD').toLowerCase()) {
    if (consonants.has(char)) key += consonants.get(char);
    else if (char === 'ं' || char === 'ँ' || char === 'ং' || char === 'ঁ') key += 'n';
    else if (/[a-z]/u.test(char) && !/[aeiou]/u.test(char)) key += char;
  }
  return key;
}
function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left))) return 0.85;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

// A line's last word has no next word to hand over to, and CTC marks a word's
// end at its last character spike, so hold the underline a little past it.
const LINE_TAIL = 0.35;
// Switch a slide this far before its first chanted word (never into the previous
// verse's last word), so the crossfade has finished when the chanting starts.
const SLIDE_LEAD = 0.4;
// CTC models fire a little after a sound begins. Measured with aligner/verify.py
// on the Kavacham: blind-decoding each word's slice read the word best at -80ms
// (20/24 exact); at 0 the first consonant was cut off, at -160ms the previous
// word's tail crept in.
const ONSET_SHIFT = 0.08;
// Mean per-frame log-probability below which a word's placement is doubtful.
const WEAK_SCORE = -2;

/** Split [a,b] across tokens in proportion to their length. */
function spread(a, b, texts) {
  const total = texts.reduce((s, t) => s + Math.max(1, t.length), 0);
  let cur = a;
  return texts.map((t) => {
    const d = (b - a) * (Math.max(1, t.length) / total);
    const r = { start: cur, end: cur + d };
    cur += d;
    return r;
  });
}

/**
 * Timings from forced alignment (src/forced.js). Produces the same shape as the
 * Deepgram path below, so slides and render do not care which one ran.
 * @param {ReturnType<import('./extract.js').extract>} extracted
 * @param {ReturnType<import('./forced.js').forcedAlign>} forced
 * @param {string} outDir
 */
export function alignForced(extracted, forced, outDir) {
  const duration = Number(forced.duration);
  const placed = forced.words.map((w) => ({ ...w, start: Math.max(0, w.start - ONSET_SHIFT), end: Math.max(0, w.end - ONSET_SHIFT) }));
  const at = (i) => placed[i];
  const verseIdx = new Map();   // `${verse}:${gi}` -> seq index
  const preIdx = new Map();     // `${p}:${gi}` -> seq index
  const speakerIdx = new Map(); // verse -> first speaker seq index
  forced.seq.forEach((s, i) => {
    if (s.part === 'verse') verseIdx.set(`${s.verse}:${s.gi}`, i);
    else if (s.part === 'pre') preIdx.set(`${s.p}:${s.gi}`, i);
    else if (s.part === 'speaker' && !speakerIdx.has(s.verse)) speakerIdx.set(s.verse, i);
  });

  /** underline words in reading order: {group, text, start, rawEnd, score, ...ids} */
  const list = [];
  let weak = 0, spreadWords = 0;
  const take = (i) => { const w = at(i); if (w.score !== null && w.score < WEAK_SCORE) weak++; return w; };

  (extracted.preamble?.eng || []).forEach((engLine, p) => {
    const zip = verseWords([extracted.preamble.dev?.[p] || ''], [engLine]);
    const idx = zip.words.map((w) => preIdx.get(`${p}:${w.gi}`));
    let times;
    if (zip.parallel && idx.every((i) => i !== undefined)) times = idx.map((i) => take(i));
    else {
      // Dev and IAST disagree on word count: time the line as a whole, then share it out.
      const all = [...preIdx.entries()].filter(([k]) => k.startsWith(`${p}:`)).map(([, i]) => at(i));
      if (!all.length) return;
      times = spread(all[0].start, all.at(-1).end, zip.words.map((w) => w.iast));
      spreadWords += zip.words.length;
    }
    zip.words.forEach((w, k) => list.push({ kind: 'pre', p, wi: w.wi, text: w.iast, group: `p${p}`, start: times[k].start, rawEnd: times[k].end, score: times[k].score ?? null }));
  });

  const verseStart = new Map();
  for (const v of extracted.verses) {
    const zip = verseWords(v.dev, v.eng);
    const idx = zip.words.map((w) => verseIdx.get(`${v.number}:${w.gi}`));
    let times;
    if (zip.parallel && idx.every((i) => i !== undefined)) times = idx.map((i) => take(i));
    else {
      warn('align', `verse ${v.number}: dev(${zip.devCount}) vs translit(${zip.iastCount}) word count differ; its words share the verse's aligned span`);
      const all = [...verseIdx.entries()].filter(([k]) => k.startsWith(`${v.number}:`)).map(([, i]) => at(i));
      if (!all.length) continue;
      times = spread(all[0].start, all.at(-1).end, zip.words.map((w) => w.iast));
      spreadWords += zip.words.length;
    }
    zip.words.forEach((w, k) => list.push({ kind: 'verse', verse: v.number, li: w.li, wi: w.wi, gi: w.gi, text: w.iast, group: `v${v.number}:${w.li}`, start: times[k].start, rawEnd: times[k].end, score: times[k].score ?? null }));
    const sp = speakerIdx.get(v.number);
    const first = sp !== undefined ? at(sp).start : times[0]?.start;
    if (first !== undefined) verseStart.set(v.number, { spoken: first, seqFirst: sp ?? idx[0] });
  }

  // Monotonic in reading order, then each word holds until the next one starts
  // (within a line), or a short tail past its own end (at a line's end).
  let prev = 0;
  for (const w of list) { w.start = Math.min(duration, Math.max(prev, w.start)); prev = w.start; }
  list.forEach((w, k) => {
    const next = list[k + 1];
    const nextStart = next ? next.start : duration;
    w.end = next && next.group === w.group ? nextStart : Math.min(nextStart, Math.max(w.rawEnd, w.start) + LINE_TAIL);
    if (w.end <= w.start) w.end = Math.min(duration, w.start + 0.05);
  });

  const verseSummary = extracted.verses.filter((v) => verseStart.has(v.number)).map((v) => {
    const { spoken, seqFirst } = verseStart.get(v.number);
    const prevEnd = seqFirst > 0 ? at(seqFirst - 1).end : 0;
    const start = Math.max(prevEnd + 0.05, spoken - SLIDE_LEAD, 0);
    return { number: v.number, start: Number(Math.min(start, spoken).toFixed(3)), quality: 'aligned' };
  });

  const r3 = (n) => Number(n.toFixed(3));
  const verseWordsOut = list.filter((w) => w.kind === 'verse');
  const mode = spreadWords ? 'forced+spread' : 'forced';
  const timings = {
    duration,
    source: `forced:${forced.model}`,
    wordCount: forced.seq.length,
    mode,
    firstVerseStart: verseSummary[0]?.start ?? duration,
    verses: verseSummary,
    words: verseWordsOut.map((w) => ({
      verse: w.verse, li: w.li, wi: w.wi, gi: w.gi, text: w.text,
      start: r3(w.start), end: r3(w.end), quality: w.score !== null && w.score < WEAK_SCORE ? 'weak' : 'aligned',
    })),
    preamble: { words: list.filter((w) => w.kind === 'pre').map((w) => ({ p: w.p, wi: w.wi, text: w.text, start: r3(w.start), end: r3(w.end) })) },
  };
  fs.writeFileSync(path.join(outDir, 'timings.json'), JSON.stringify(timings, null, 2), 'utf8');
  log('align', `mode=${mode} words=${list.length} weak=${weak} spread=${spreadWords} firstVerse=${timings.firstVerseStart.toFixed(1)}s dur=${duration.toFixed(1)}s`);
  return timings;
}

/**
 * The older timing path: Deepgram ASR words fuzzy-matched to the text. Used
 * only when the forced aligner is not installed (ALIGNER=auto) or on request.
 * @param {ReturnType<import('./extract.js').extract>} extracted
 * @param {any} transcript  Deepgram JSON
 * @param {string} outDir
 */
export function align(extracted, transcript, outDir) {
  const heardRaw = transcript.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!heardRaw?.length) throw new Error('no transcript words');
  const duration = Number(transcript.metadata.duration);

  // Per-verse parallel word lists (IAST is what gets underlined; Dev is matched).
  const verses = extracted.verses.map((v, vi) => {
    const zip = verseWords(v.dev, v.eng);
    if (!zip.parallel) {
      warn('align', `verse ${v.number}: dev(${zip.devCount}) vs translit(${zip.iastCount}) word count differ; that verse falls back to weighted timing`);
    }
    return { vi, number: v.number, parallel: zip.parallel, words: zip.words };
  });

  // Flat reading-order list of every underline word.
  const flat = [];
  for (const verse of verses) {
    for (const w of verse.words) {
      flat.push({ vi: verse.vi, number: verse.number, li: w.li, wi: w.wi, gi: w.gi, text: w.iast, key: phoneticKey(w.dev), start: null, end: null, score: 0, conf: 0 });
    }
  }

  // NW over the subset of words that have a usable phonetic key.
  const src = flat.filter((w) => w.key.length >= 1);
  const heard = heardRaw.map((word) => ({
    key: phoneticKey(word.word ?? ''), start: Number(word.start), end: Number(word.end), confidence: Number(word.confidence ?? 0),
  }));
  const width = heard.length + 1;
  const gap = 0.8;
  const costs = new Float32Array((src.length + 1) * width);
  const moves = new Uint8Array(costs.length);
  for (let i = 1; i <= src.length; i++) { costs[i * width] = i * gap; moves[i * width] = 1; }
  for (let j = 1; j <= heard.length; j++) { costs[j] = j * gap; moves[j] = 2; }
  for (let i = 1; i <= src.length; i++) {
    for (let j = 1; j <= heard.length; j++) {
      const sim = similarity(src[i - 1].key, heard[j - 1].key);
      const substitution = costs[(i - 1) * width + j - 1] + (sim < 0.55 ? 2.4 : Math.max(0.15, 2 * (1 - sim)));
      const deletion = costs[(i - 1) * width + j] + gap;
      const insertion = costs[i * width + j - 1] + gap;
      const cell = i * width + j;
      if (substitution <= deletion && substitution <= insertion) { costs[cell] = substitution; moves[cell] = 0; }
      else if (deletion <= insertion) { costs[cell] = deletion; moves[cell] = 1; }
      else { costs[cell] = insertion; moves[cell] = 2; }
    }
  }
  let i = src.length, j = heard.length;
  while (i || j) {
    const move = moves[i * width + j];
    if (i && j && move === 0) {
      const s = src[i - 1], h = heard[j - 1];
      const score = similarity(s.key, h.key);
      if (score >= 0.6 && s.key.length >= 3 && h.key.length >= 3) {
        s.start = h.start; s.end = h.end; s.score = score; s.conf = h.confidence;
      }
      i--; j--;
    } else if (i && (!j || move === 1)) i--; else j--;
  }

  // Confident anchors, cleaned to be monotonic in reading order.
  const anchorIdx = [];
  for (let k = 0; k < flat.length; k++) {
    const w = flat[k];
    if (w.start !== null && w.score >= 0.7 && w.conf >= 0.4) {
      if (!anchorIdx.length || w.start >= flat[anchorIdx.at(-1)].start + 0.03) anchorIdx.push(k);
    }
  }
  if (!anchorIdx.length) warn('align', 'no confident anchors; the whole timeline is estimated by even spacing');

  // Interpolate a start for every word from the anchors.
  const AVG = anchorIdx.length >= 2
    ? (flat[anchorIdx.at(-1)].start - flat[anchorIdx[0]].start) / (anchorIdx.at(-1) - anchorIdx[0])
    : 0.55;
  for (let k = 0; k < flat.length; k++) {
    const before = anchorIdx.filter((a) => a <= k).at(-1);
    const after = anchorIdx.find((a) => a >= k);
    let start; let quality = 'estimated';
    if (before !== undefined && after !== undefined && before !== after) {
      const ratio = (k - before) / (after - before);
      start = flat[before].start + ratio * (flat[after].start - flat[before].start);
      quality = 'aligned';
    } else if (before === after && before !== undefined) { start = flat[before].start; quality = 'aligned'; }
    else if (before !== undefined) start = flat[before].start + (k - before) * AVG;
    else if (after !== undefined) start = Math.max(0, flat[after].start - (after - k) * AVG);
    else start = (k / Math.max(1, flat.length)) * duration;
    flat[k].startFinal = start;
    flat[k].quality = quality;
  }

  // Monotonic non-decreasing with a small floor, clamped to the audio.
  let prev = 0;
  for (const w of flat) {
    if (!(w.startFinal >= prev)) w.startFinal = prev;
    if (w.startFinal < 0) w.startFinal = 0;
    if (w.startFinal > duration) w.startFinal = duration;
    prev = w.startFinal;
  }
  for (let k = 0; k < flat.length; k++) {
    flat[k].endFinal = k + 1 < flat.length ? flat[k + 1].startFinal : duration;
  }

  // ---- preamble words: evenly distribute the lead-in window, char-weighted ----
  const leadIn = 0.4;
  const firstVerseStart = flat.length ? flat[0].startFinal : Math.min(2, duration);
  const preWords = [];
  const preEng = extracted.preamble.eng || [];
  const preTokens = [];
  for (let p = 0; p < preEng.length; p++) {
    const zip = verseWords([preEng[p]], [preEng[p]]); // tokenise the line's own words
    for (const w of zip.words) preTokens.push({ p, wi: w.wi, text: w.iast });
  }
  if (preTokens.length && firstVerseStart > leadIn + 0.2) {
    const total = preTokens.reduce((a, t) => a + Math.max(1, t.text.length), 0);
    let cur = leadIn;
    const span = firstVerseStart - leadIn;
    for (const t of preTokens) {
      const dur = span * (Math.max(1, t.text.length) / total);
      preWords.push({ p: t.p, wi: t.wi, text: t.text, start: Number(cur.toFixed(3)), end: Number((cur + dur).toFixed(3)) });
      cur += dur;
    }
  }

  // ---- verse-level summary ----
  const byVerse = new Map();
  for (const w of flat) {
    const e = byVerse.get(w.number) || { number: w.number, start: w.startFinal, aligned: 0, total: 0 };
    e.start = Math.min(e.start, w.startFinal);
    e.total++; if (w.quality === 'aligned') e.aligned++;
    byVerse.set(w.number, e);
  }
  const verseSummary = [...byVerse.values()].map((e) => ({
    number: e.number, start: Number(e.start.toFixed(3)), quality: e.aligned >= Math.max(1, e.total / 2) ? 'aligned' : 'estimated',
  }));

  const alignedWords = flat.filter((w) => w.quality === 'aligned').length;
  const mode = alignedWords > flat.length * 0.6 ? 'aligned' : alignedWords > 0 ? 'partial' : 'estimated';

  const timings = {
    duration,
    wordCount: heardRaw.length,
    mode,
    firstVerseStart: Number(firstVerseStart.toFixed(3)),
    verses: verseSummary,
    words: flat.map((w) => ({
      verse: w.number, li: w.li, wi: w.wi, gi: w.gi, text: w.text,
      start: Number(w.startFinal.toFixed(3)), end: Number(w.endFinal.toFixed(3)), quality: w.quality,
    })),
    preamble: { words: preWords },
  };
  const p = path.join(outDir, 'timings.json');
  fs.writeFileSync(p, JSON.stringify(timings, null, 2), 'utf8');
  log('align', `mode=${mode} words=${flat.length} aligned=${alignedWords} anchors=${anchorIdx.length} firstVerse=${firstVerseStart.toFixed(1)}s dur=${duration.toFixed(1)}s`);
  return timings;
}
