import fs from 'node:fs';

const audio = 'C:\\Users\\GD\\Downloads\\2. Kavacha Stotram.mp3';
const out = process.argv[2] || 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\deepgram-kavacha-new.json';
const key = process.env.DEEPGRAM_API_KEY;
if (!key) throw new Error('no key');

const url = 'https://api.deepgram.com/v1/listen?model=whisper-large&language=sa&smart_format=false&punctuate=false&utterances=true';
const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/mpeg' },
  body: fs.readFileSync(audio),
});
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
const json = await res.json();
fs.writeFileSync(out, JSON.stringify(json, null, 2), 'utf8');
const words = json.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
console.log(`OK ${((Date.now()-t0)/1000).toFixed(0)}s duration=${json.metadata?.duration}s words=${words.length} -> ${out}`);
