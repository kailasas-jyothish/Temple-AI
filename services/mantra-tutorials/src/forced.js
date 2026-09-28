// @ts-check
// Forced alignment: find when each *known* word is chanted. We already have the
// exact text, so this does not transcribe anything — a Sanskrit CTC acoustic
// model (via ctc-forced-aligner, aligner/align.py) places every written word on
// the audio. This replaced Deepgram + fuzzy matching as the timing source, which
// guessed at a romanised transcript and left words racing or stalling.
//
// The Python side runs once per (text, audio, model) and is cached as
// forced.json in the work dir: ~2 min for a 10-min chant on CPU.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config } from './config.js';
import { ffmpegPath } from './paths.js';
import { wordTokens } from './tokens.js';
import { log } from './log.js';

const alignerDir = path.join(config.serviceRoot, 'aligner');

/** The aligner's Python: explicit env, else the venv `npm run setup` creates. */
export function alignerPython() {
  if (config.alignPython) return config.alignPython;
  const venv = process.platform === 'win32'
    ? path.join(alignerDir, '.venv', 'Scripts', 'python.exe')
    : path.join(alignerDir, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : '';
}

/**
 * Everything that is chanted, in order, one entry per word: the preamble, each
 * verse's speaker line, the verse, and the closing. Speaker and closing words
 * are never underlined, but they are aligned so their audio is not attributed
 * to the neighbouring verse words.
 * @param {ReturnType<import('./extract.js').extract>} extracted
 */
export function chantSequence(extracted) {
  /** @type {{text:string, part:'pre'|'speaker'|'verse'|'closing', p?:number, verse?:number, gi?:number}[]} */
  const seq = [];
  /** indices of words that begin a line (where pauses and music live) */
  const breaks = [];
  const pre = extracted.preamble?.dev || [];
  pre.forEach((line, p) => {
    breaks.push(seq.length);
    wordTokens(line).forEach((text, gi) => seq.push({ text, part: 'pre', p, gi }));
  });
  for (const v of extracted.verses) {
    if (v.speaker?.dev) {
      breaks.push(seq.length);
      for (const text of wordTokens(v.speaker.dev)) seq.push({ text, part: 'speaker', verse: v.number });
    }
    let gi = 0;
    for (const line of v.dev) {
      breaks.push(seq.length);
      for (const text of wordTokens(line)) seq.push({ text, part: 'verse', verse: v.number, gi: gi++ });
    }
  }
  for (const line of extracted.closing?.dev || []) {
    breaks.push(seq.length);
    for (const text of wordTokens(line)) seq.push({ text, part: 'closing' });
  }
  return { seq, breaks };
}

/**
 * Run (or reuse) the forced aligner for this mantra.
 * @param {import('./mantra.js').Mantra} mantra
 * @param {ReturnType<import('./extract.js').extract>} extracted
 * @param {string} outDir
 * @param {{ force?: boolean }} [opts]
 * @returns {{ duration:number, model:string, words:{start:number,end:number,score:number|null}[], seq: ReturnType<typeof chantSequence>['seq'] }}
 */
export function forcedAlign(mantra, extracted, outDir, opts = {}) {
  const { seq, breaks } = chantSequence(extracted);
  if (!seq.length) throw new Error('no chantable words were extracted');
  const words = seq.map((s) => s.text);
  const audioStat = fs.statSync(mantra.audio);
  const key = crypto.createHash('sha256')
    .update(JSON.stringify({ words, breaks, model: config.alignModel, audio: [path.basename(mantra.audio), audioStat.size] }))
    .digest('hex').slice(0, 16);

  const cachePath = path.join(outDir, 'forced.json');
  if (!opts.force && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.key === key && cached.words?.length === seq.length) {
      log('align', `forced-alignment cache hit (${seq.length} words, ${cached.model})`);
      return { ...cached, seq };
    }
  }

  const py = alignerPython();
  if (!py) throw new Error('forced aligner not installed — run `npm run setup` once');
  const reqPath = path.join(outDir, 'forced-request.json');
  const resPath = path.join(outDir, 'forced-result.json');
  fs.writeFileSync(reqPath, JSON.stringify({ audio: mantra.audio, ffmpeg: ffmpegPath(), model: config.alignModel, words, breaks }), 'utf8');
  log('align', `forced alignment of ${seq.length} words with ${config.alignModel} (first run downloads the model; ~2 min per 10 min of audio)`);
  const t0 = Date.now();
  const r = spawnSync(py, [path.join(alignerDir, 'align.py'), reqPath, resPath], {
    stdio: ['ignore', 'inherit', 'pipe'], windowsHide: true, timeout: 60 * 60 * 1000,
    env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-8).join('\n');
    throw new Error(`forced aligner exited ${r.status}:\n${tail}`);
  }
  const result = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  if (result.words?.length !== seq.length) throw new Error(`aligner returned ${result.words?.length} words for ${seq.length}`);
  fs.writeFileSync(cachePath, JSON.stringify({ key, ...result }), 'utf8');
  log('align', `forced alignment done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> forced.json`);
  return { ...result, seq };
}
