import fs from 'node:fs';

const OUTDIR = 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video';
const versesPath = process.argv[2] || `${OUTDIR}\\verses.json`;
const transcriptPath = process.argv[3] || 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\deepgram-kavacha-new.json';

const { verses: paired } = JSON.parse(fs.readFileSync(versesPath, 'utf8'));
const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
const words = transcript.results?.channels?.[0]?.alternatives?.[0]?.words;
if (!words?.length) throw new Error('no transcript words');
const duration = Number(transcript.metadata.duration);

// verses in the shape the aligner expects: { number, lines:[devanagari] }
const verses = paired.map((v) => ({ number: v.number, lines: v.dev }));

// ---- phonetic key (copied from durga-kavacham.mjs, proven prior work) ----
const consonants = new Map();
function mapChars(chars, value) { for (const c of chars) consonants.set(c, value); }
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

function align(verses, recognizedWords) {
  const sourceTokens = [];
  const verseTokenCounts = Array(verses.length).fill(0);
  for (const verse of verses) {
    const text = verse.lines.join(' ').replace(/॥|।|[,;|]/gu, ' ');
    for (const token of text.split(/\s+/u)) {
      const key = phoneticKey(token);
      if (key) sourceTokens.push({ key, verse: verse.number, tokenIndex: verseTokenCounts[verse.number - 1]++, text: token });
    }
  }
  const heard = recognizedWords.map((word) => ({
    key: phoneticKey(word.word ?? ''), text: word.word ?? '',
    start: Number(word.start), end: Number(word.end), confidence: Number(word.confidence ?? 0),
  }));
  const width = heard.length + 1;
  const gap = 0.8;
  const costs = new Float32Array((sourceTokens.length + 1) * width);
  const moves = new Uint8Array(costs.length);
  for (let i = 1; i <= sourceTokens.length; i++) { costs[i * width] = i * gap; moves[i * width] = 1; }
  for (let j = 1; j <= heard.length; j++) { costs[j] = j * gap; moves[j] = 2; }
  for (let i = 1; i <= sourceTokens.length; i++) {
    for (let j = 1; j <= heard.length; j++) {
      const sim = similarity(sourceTokens[i - 1].key, heard[j - 1].key);
      const substitution = costs[(i - 1) * width + j - 1] + (sim < 0.55 ? 2.4 : Math.max(0.15, 2 * (1 - sim)));
      const deletion = costs[(i - 1) * width + j] + gap;
      const insertion = costs[i * width + j - 1] + gap;
      const cell = i * width + j;
      if (substitution <= deletion && substitution <= insertion) { costs[cell] = substitution; moves[cell] = 0; }
      else if (deletion <= insertion) { costs[cell] = deletion; moves[cell] = 1; }
      else { costs[cell] = insertion; moves[cell] = 2; }
    }
  }
  const matches = Array.from({ length: verses.length }, () => []);
  let i = sourceTokens.length, j = heard.length;
  while (i || j) {
    const move = moves[i * width + j];
    if (i && j && move === 0) {
      const source = sourceTokens[i - 1], heardWord = heard[j - 1];
      const score = similarity(source.key, heardWord.key);
      if (score >= 0.6 && source.key.length >= 3 && heardWord.key.length >= 3) {
        matches[source.verse - 1].push({ ...heardWord, score, source: source.text, tokenIndex: source.tokenIndex });
      }
      i--; j--;
    } else if (i && (!j || move === 1)) i--; else j--;
  }
  for (const m of matches) m.reverse();
  const starts = matches.map((items) => {
    const strong = items.filter((it) => it.score >= 0.75 && it.confidence >= 0.5);
    if (strong.length < 2) return null;
    const first = strong.reduce((l, r) => (l.start <= r.start ? l : r));
    return Math.max(0, first.start - first.tokenIndex * 0.95);
  });
  const anchors = starts.map((s, idx) => (s === null ? null : idx)).filter((idx) => idx !== null);
  if (!anchors.length) throw new Error('no reliable matches');
  for (let idx = 0; idx < starts.length; idx++) {
    if (starts[idx] !== null) continue;
    const before = anchors.filter((a) => a < idx).at(-1);
    const after = anchors.find((a) => a > idx);
    if (before !== undefined && after !== undefined) {
      const ratio = (idx - before) / (after - before);
      starts[idx] = starts[before] + ratio * (starts[after] - starts[before]);
    } else if (before !== undefined) starts[idx] = starts[before] + 7 * (idx - before);
    else starts[idx] = Math.max(0, starts[after] - 7 * (after - idx));
  }
  return verses.map((verse, idx) => ({
    number: verse.number,
    start: starts[idx],
    quality: matches[idx].filter((it) => it.score >= 0.75 && it.confidence >= 0.5).length >= 2 ? 'aligned' : 'estimated',
    matchCount: matches[idx].length,
    matched: matches[idx].slice(0, 5).map((it) => it.text),
  }));
}

const aligned = align(verses, words);

// enforce monotonic, non-negative, within duration
let prev = 0;
for (const v of aligned) {
  if (!(v.start >= prev + 0.4)) v.start = prev + 0.4;
  prev = v.start;
}
const firstStart = aligned[0].start;

const timings = {
  duration,
  wordCount: words.length,
  preambleStart: 0,
  firstVerseStart: firstStart,
  verses: aligned.map((v) => ({ number: v.number, start: Number(v.start.toFixed(3)), quality: v.quality })),
};
fs.writeFileSync(`${OUTDIR}\\timings.json`, JSON.stringify(timings, null, 2), 'utf8');

const alignedCount = aligned.filter((v) => v.quality === 'aligned').length;
console.log(`duration=${duration.toFixed(1)}s firstVerse=${firstStart.toFixed(1)}s aligned=${alignedCount}/56`);
for (const v of aligned) {
  console.log(`  v${String(v.number).padStart(2)} ${v.start.toFixed(1).padStart(6)}s [${v.quality[0]}] ${v.matched.join(' ')}`);
}
