// @ts-check
// Stage 2 — Deepgram ASR for per-word timestamps. This is the only network
// dependency and it is ASR, not an LLM making creative choices, so it does not
// violate the repo's "no model in the animation path" rule. Run once per mantra
// and cache the JSON; a bundle may also ship a pre-fetched cache.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

/**
 * @param {import('./mantra.js').Mantra} mantra
 * @param {string} outDir
 * @param {{ force?: boolean }} [opts]
 */
export async function transcribe(mantra, outDir, opts = {}) {
  const cachePath = path.join(outDir, 'deepgram.json');
  // Prefer a bundle-shipped cache, then a previous run's cache.
  for (const src of [mantra.deepgramCache, cachePath]) {
    if (!opts.force && src && fs.existsSync(src)) {
      const json = JSON.parse(fs.readFileSync(src, 'utf8'));
      const words = json.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
      if (words.length) {
        if (src !== cachePath) fs.copyFileSync(src, cachePath);
        log('transcribe', `cache hit (${src === cachePath ? 'run cache' : 'bundle'}): ${words.length} words, ${json.metadata?.duration}s`);
        return json;
      }
    }
  }

  if (!config.deepgramKey) throw new Error('no cached transcript and DEEPGRAM_API_KEY is unset');

  const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(config.deepgramModel)}`
    + `&language=${encodeURIComponent(mantra.deepgramLanguage)}&smart_format=false&punctuate=false&utterances=true`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${config.deepgramKey}`, 'Content-Type': 'audio/mpeg' },
    body: fs.readFileSync(mantra.audio),
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  fs.writeFileSync(cachePath, JSON.stringify(json, null, 2), 'utf8');
  const words = json.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  log('transcribe', `Deepgram ${((Date.now() - t0) / 1000).toFixed(0)}s: ${words.length} words, ${json.metadata?.duration}s -> deepgram.json`);
  return json;
}
