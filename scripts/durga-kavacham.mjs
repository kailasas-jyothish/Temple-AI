import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const defaults = {
  audio: 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Devi Kavacham.MP3',
  source: 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\(For Projecting) Shri Durga Saptashati - Devanagari.md',
  transcript: 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\deepgram-whisper.json',
  elements: 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Elements',
  ffmpeg: 'C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe',
  output: 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video',
};

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const args = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, option(`--${name}`, value)]));
const alignOnly = process.argv.includes('--align-only');
const preview = process.argv.includes('--preview');

function extractKavacham(markdown) {
  const start = markdown.indexOf('# Kavacha Stotram');
  const end = markdown.indexOf('# Argala Stotram', start);
  if (start < 0 || end < 0) throw new Error('Could not find the Kavacham section boundaries.');

  const lines = markdown.slice(start, end).split(/\r?\n/).slice(1);
  const intro = [];
  const verses = [];
  let inVerses = false;
  let pending = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{#')) continue;
    if (line === 'मार्कण्डेय उवाच') {
      inVerses = true;
      continue;
    }
    if (!inVerses) {
      intro.push(line);
      continue;
    }
    if (/उवाच\s*$/u.test(line)) continue;
    pending.push(line);
    const marker = line.match(/॥\s*(\d{1,2})\s*॥\s*$/u);
    if (marker) {
      const number = Number(marker[1]);
      verses.push({ number, lines: pending });
      pending = [];
    }
  }

  if (verses.length !== 56 || verses.some((verse, index) => verse.number !== index + 1)) {
    throw new Error(`Expected verses 1-56 in order; extracted ${verses.length}.`);
  }
  return { intro, verses };
}

const consonants = new Map();
function mapChars(chars, value) {
  for (const char of chars) consonants.set(char, value);
}
mapChars('कख', 'k'); mapChars('गघ', 'g'); mapChars('ङ', 'n');
mapChars('चछ', 'c'); mapChars('जझ', 'j'); mapChars('ञ', 'n');
mapChars('टठ', 't'); mapChars('डढड़', 'd'); mapChars('णन', 'n');
mapChars('तथ', 't'); mapChars('दध', 'd');
mapChars('पफ', 'p'); mapChars('बभ', 'b'); mapChars('म', 'm');
mapChars('यर', 'r'); mapChars('लळ', 'l'); mapChars('व', 'v');
mapChars('शषस', 's'); mapChars('ह', 'h'); mapChars('क़ख़ग़', 'k');
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
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function align(verses, recognizedWords) {
  const sourceTokens = [];
  const verseTokenCounts = Array(56).fill(0);
  for (const verse of verses) {
    const text = verse.lines.join(' ').replace(/॥|।|[,;|]/gu, ' ');
    for (const token of text.split(/\s+/u)) {
      const key = phoneticKey(token);
      if (key) sourceTokens.push({ key, verse: verse.number, tokenIndex: verseTokenCounts[verse.number - 1]++, text: token });
    }
  }
  const heard = recognizedWords.map((word) => ({
    key: phoneticKey(word.word ?? ''),
    text: word.word ?? '',
    start: Number(word.start),
    end: Number(word.end),
    confidence: Number(word.confidence ?? 0),
  }));
  const width = heard.length + 1;
  const gap = 0.8;
  const costs = new Float32Array((sourceTokens.length + 1) * width);
  const moves = new Uint8Array(costs.length);
  for (let i = 1; i <= sourceTokens.length; i++) {
    costs[i * width] = i * gap;
    moves[i * width] = 1;
  }
  for (let j = 1; j <= heard.length; j++) {
    costs[j] = j * gap;
    moves[j] = 2;
  }

  for (let i = 1; i <= sourceTokens.length; i++) {
    for (let j = 1; j <= heard.length; j++) {
      const sim = similarity(sourceTokens[i - 1].key, heard[j - 1].key);
      const substitution = costs[(i - 1) * width + j - 1] + (sim < 0.55 ? 2.4 : Math.max(0.15, 2 * (1 - sim)));
      const deletion = costs[(i - 1) * width + j] + gap;
      const insertion = costs[i * width + j - 1] + gap;
      const cell = i * width + j;
      if (substitution <= deletion && substitution <= insertion) {
        costs[cell] = substitution;
        moves[cell] = 0;
      } else if (deletion <= insertion) {
        costs[cell] = deletion;
        moves[cell] = 1;
      } else {
        costs[cell] = insertion;
        moves[cell] = 2;
      }
    }
  }

  const matches = Array.from({ length: 56 }, () => []);
  let i = sourceTokens.length;
  let j = heard.length;
  while (i || j) {
    const move = moves[i * width + j];
    if (i && j && move === 0) {
      const source = sourceTokens[i - 1];
      const heardWord = heard[j - 1];
      const score = similarity(source.key, heardWord.key);
      if (score >= 0.6 && source.key.length >= 3 && heardWord.key.length >= 3) {
        matches[source.verse - 1].push({ ...heardWord, score, source: source.text, tokenIndex: source.tokenIndex });
      }
      i--;
      j--;
    } else if (i && (!j || move === 1)) i--;
    else j--;
  }
  for (const verseMatches of matches) verseMatches.reverse();

  const starts = matches.map((items) => {
    const strong = items.filter((item) => item.score >= 0.75 && item.confidence >= 0.5);
    if (strong.length < 2) return null;
    const first = strong.reduce((left, right) => left.start <= right.start ? left : right);
    return Math.max(0, first.start - first.tokenIndex * 0.95);
  });
  const anchors = starts.map((start, index) => start === null ? null : index).filter((index) => index !== null);
  if (!anchors.length) throw new Error('No reliable source-to-transcript word matches were found.');

  for (let index = 0; index < starts.length; index++) {
    if (starts[index] !== null) continue;
    const before = anchors.filter((anchor) => anchor < index).at(-1);
    const after = anchors.find((anchor) => anchor > index);
    if (before !== undefined && after !== undefined) {
      const ratio = (index - before) / (after - before);
      starts[index] = starts[before] + ratio * (starts[after] - starts[before]);
    } else if (before !== undefined) starts[index] = starts[before] + 7 * (index - before);
    else starts[index] = Math.max(0, starts[after] - 7 * (after - index));
  }
  if (matches[0].filter((item) => item.score >= 0.75 && item.confidence >= 0.5).length < 2) starts[0] = 23;

  return verses.map((verse, index) => ({
    ...verse,
    start: starts[index],
    matchCount: matches[index].length,
    meanConfidence: matches[index].length
      ? matches[index].reduce((sum, item) => sum + item.confidence, 0) / matches[index].length
      : 0,
    timingQuality: starts[index] === null ? 'estimated' : matches[index].filter((item) => item.score >= 0.75 && item.confidence >= 0.5).length >= 2 ? 'aligned' : 'estimated',
    matchedWords: matches[index].map((item) => item.text),
    evidence: matches[index].map((item) => ({ source: item.source, transcript: item.text, at: item.start, similarity: item.score })),
  }));
}

function timecode(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((ms % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function wrapLines(lines, limit = 44) {
  const wrapped = [];
  for (const line of lines) {
    let current = '';
    for (const word of line.split(/\s+/u)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && candidate.length > limit) {
        wrapped.push(current);
        current = word;
      } else current = candidate;
    }
    if (current) wrapped.push(current);
  }
  return wrapped;
}

function writeSubtitles(intro, verses, duration, output) {
  const cues = [{ start: 0, end: verses[0].start, lines: intro }];
  for (let index = 0; index < verses.length; index++) {
    cues.push({
      start: verses[index].start,
      end: index + 1 < verses.length ? verses[index + 1].start : duration,
      lines: verses[index].lines,
    });
  }
  const srt = cues.map((cue, index) => {
    const start = Math.max(0, cue.start);
    const end = Math.min(duration, Math.max(start + 0.5, cue.end));
    return `${index + 1}\n${timecode(start)} --> ${timecode(end)}\n${wrapLines(cue.lines).join('\n')}`;
  }).join('\n\n') + '\n';
  fs.writeFileSync(output, srt, 'utf8');
}

async function main() {
  let transcript;
  if (fs.existsSync(args.transcript)) {
    transcript = JSON.parse(fs.readFileSync(args.transcript, 'utf8'));
  } else {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('Set DEEPGRAM_API_KEY or pass an existing --transcript JSON.');
    const response = await fetch('https://api.deepgram.com/v1/listen?model=whisper&language=sa&smart_format=false&punctuate=false&utterances=true', {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/mpeg' },
      body: fs.readFileSync(args.audio),
    });
    if (!response.ok) throw new Error(`Deepgram returned HTTP ${response.status}: ${await response.text()}`);
    transcript = await response.json();
  }

  const text = fs.readFileSync(args.source, 'utf8');
  const { intro, verses: sourceVerses } = extractKavacham(text);
  const words = transcript.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!words?.length) throw new Error('Deepgram response has no word timestamps.');
  const duration = Number(transcript.metadata.duration);
  const verses = align(sourceVerses, words);
  const report = verses.map((verse) => `${String(verse.number).padStart(2, '0')}  ${verse.start.toFixed(2)}s  ${String(verse.matchCount).padStart(2, ' ')} matches  ${verse.matchedWords.slice(0, 5).join(' ')}`).join('\n');

  fs.mkdirSync(args.output, { recursive: true });
  fs.writeFileSync(path.join(args.output, 'alignment.json'), JSON.stringify({ duration, intro, verses }, null, 2), 'utf8');
  fs.writeFileSync(path.join(args.output, 'alignment-report.txt'), `Duration ${duration.toFixed(2)}s; ${words.length} recognized words\n\n${report}\n`, 'utf8');
  console.log(`Duration ${duration.toFixed(2)}s; ${words.length} recognized words; intro ${verses[0].start.toFixed(2)}s`);
  console.log(report);
  if (alignOnly) return;

  const blank = path.join(args.elements, 'Empty Slide (without text).png');
  const font = path.join(args.elements, 'Mart-DevanagariBold.otf');
  const fontDir = path.join(args.output, 'Fonts');
  if (!fs.existsSync(blank) || !fs.existsSync(font)) throw new Error('Missing blank slide or Mart Devanagari font.');
  fs.mkdirSync(fontDir, { recursive: true });
  fs.copyFileSync(font, path.join(fontDir, path.basename(font)));
  const subtitlePath = path.join(args.output, 'verses.srt');
  writeSubtitles(intro, verses, duration, subtitlePath);
  const filter = "subtitles=verses.srt:fontsdir=Fonts:force_style='FontName=Mart Devanagari,FontSize=54,PrimaryColour=&H00000000,OutlineColour=&H00251A12,BorderStyle=1,Outline=0,Shadow=0,Alignment=5,MarginL=180,MarginR=180,MarginV=90'";
  const video = path.join(args.output, preview ? 'review.mp4' : 'Durga-Kavacham.mp4');
  const outputDuration = preview ? Math.min(duration, 40) : duration;
  const result = spawnSync(args.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-loop', '1', '-framerate', '30', '-i', blank,
    '-i', args.audio, '-vf', filter, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-r', '30',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', outputDuration.toFixed(3),
    '-movflags', '+faststart', video,
  ], { cwd: args.output, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FFmpeg exited with status ${result.status}.`);
  console.log(`Created ${video}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});