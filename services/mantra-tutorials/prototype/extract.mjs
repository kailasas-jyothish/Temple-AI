import fs from 'node:fs';

const DEV = 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\(For Projecting) Shri Durga Saptashati - Devanagari.md';
const ENG = 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\(For Projecting) Shri Durga Saptashati - English.md';
const OUT = process.argv[2] || 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video\\verses.json';

function sectionLines(file) {
  const md = fs.readFileSync(file, 'utf8');
  const start = md.indexOf('# Kavacha Stotram');
  if (start < 0) throw new Error(`no Kavacha heading in ${file}`);
  // next top-level heading after the Kavacha heading line
  const afterHeading = md.indexOf('\n', start) + 1;
  const nextIdx = md.indexOf('\n# ', afterHeading);
  const body = md.slice(afterHeading, nextIdx < 0 ? md.length : nextIdx);
  return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\{#/.test(l));
}

const isSpeaker = (l) => /(उवाच|ब्रह्मोवाच|ovāca|uvāca)\s*$/iu.test(l) && l.split(/\s+/).length <= 3 && !/\d/.test(l);
const marker = (l) => {
  const m = l.match(/॥\s*(\d{1,2})[\d\s]*॥\s*$/u);
  return m ? Number(m[1]) : null;
};
const isClosing = (l) => /^(इति|iti)\b/u.test(l);

function parse(file) {
  const lines = sectionLines(file);
  const preamble = [];
  const verses = [];
  let seenSpeaker = false;
  let pending = [];
  let pendingSpeaker = null;
  for (const line of lines) {
    if (isClosing(line)) break;
    if (isSpeaker(line)) {
      seenSpeaker = true;
      pendingSpeaker = line;
      continue;
    }
    if (!seenSpeaker) {
      preamble.push(line);
      continue;
    }
    pending.push(line);
    const n = marker(line);
    if (n !== null) {
      verses.push({ number: n, speaker: pendingSpeaker, lines: pending });
      pending = [];
      pendingSpeaker = null;
    }
  }
  return { preamble, verses };
}

const dev = parse(DEV);
const eng = parse(ENG);

if (dev.verses.length !== 56 || eng.verses.length !== 56) {
  throw new Error(`verse count dev=${dev.verses.length} eng=${eng.verses.length}`);
}
for (let i = 0; i < 56; i++) {
  if (dev.verses[i].number !== i + 1 || eng.verses[i].number !== i + 1) {
    throw new Error(`numbering mismatch at index ${i}: dev=${dev.verses[i].number} eng=${eng.verses[i].number}`);
  }
}

const verses = dev.verses.map((d, i) => ({
  number: d.number,
  speaker: d.speaker || eng.verses[i].speaker ? { dev: d.speaker, eng: eng.verses[i].speaker } : null,
  dev: d.lines,
  eng: eng.verses[i].lines,
}));

const out = { preamble: { dev: dev.preamble, eng: eng.preamble }, verses };
fs.mkdirSync(OUT.slice(0, OUT.lastIndexOf('\\')), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

console.log(`verses: ${verses.length}`);
console.log('preamble dev lines:', dev.preamble.length, '| eng lines:', eng.preamble.length);
console.log('--- preamble dev ---'); dev.preamble.forEach((l) => console.log('  ', l));
for (const n of [1, 2, 44, 56]) {
  const v = verses[n - 1];
  console.log(`--- verse ${n} (speaker ${v.speaker ? v.speaker.dev + ' / ' + v.speaker.eng : '-'}) ---`);
  v.dev.forEach((l) => console.log('  D', l));
  v.eng.forEach((l) => console.log('  E', l));
}
