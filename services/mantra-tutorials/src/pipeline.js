// @ts-check
// The one engine both front ends drive (handover §7): extract -> transcribe ->
// align -> theme -> slides -> render. "transcribe" is forced alignment of the
// known text by default (Deepgram ASR only as a fallback). Each stage writes its artefact into the mantra's work dir, so a run can
// be inspected (verses.json, timings.json, theme.json, slides.json) and a stage
// can be re-run from a cache. `onStage` lets the web UI stream progress; the CLI
// passes a printer.
import path from 'node:path';
import { loadMantra, workDir } from './mantra.js';
import { extract } from './extract.js';
import { transcribe } from './transcribe.js';
import { align, alignForced } from './align.js';
import { forcedAlign, alignerPython } from './forced.js';
import { config } from './config.js';
import { deriveTheme } from './color.js';
import { buildSlides, groupSlides, slideCtx, fitScales, htmlFor } from './slides.js';
import { writeHtml, screenshot } from './browser.js';
import { render } from './render.js';
import { log, warn } from './log.js';

const STAGES = ['extract', 'transcribe', 'align', 'theme', 'slides', 'render'];

/**
 * Judge contrast against where the text actually sits, not the whole frame: a
 * figure on one side of the background would otherwise darken the average.
 * @param {import('./mantra.js').Mantra} mantra @param {string} out
 */
function themeFor(mantra, out) {
  const a = mantra.textArea;
  return deriveTheme(mantra.background, out, { band: { top: a.top + (mantra.title ? 236 : 96), bottom: 1080 - a.bottom, left: a.left, right: 1920 - a.right } });
}

/**
 * What the slides will look like with the current text box, without the audio
 * or a render: the preamble and the verse slide that decides the type size,
 * as PNGs in data/<id>/preview/. Fitting every slide takes minutes, so this
 * fits only the likeliest-tightest few (widest lines, most lines). The build
 * fits them all, so its size can come out a touch smaller, never larger.
 * @param {string} idOrPath
 */
export function previewLayout(idOrPath) {
  const mantra = loadMantra(idOrPath, { partial: true });
  const need = ['background', 'devanagari'].filter((k) => mantra.missing.includes(k));
  if (need.length) throw new Error(`a layout preview needs the ${need.join(' and the ')} first`);
  const out = workDir(mantra);
  const extracted = extract(mantra, out);
  const theme = themeFor(mantra, out);
  const fake = { verses: extracted.verses.map((v, i) => ({ number: v.number, start: (i + 1) * 10 })), duration: (extracted.verses.length + 1) * 10 };
  const { slides } = groupSlides(extracted, fake, mantra);

  const verseIdx = slides.map((_, i) => i).filter((i) => slides[i].kind === 'verses');
  const widest = (s, key) => Math.max(0, ...s.verses.flatMap((v) => v[key].map((l) => l.length)));
  const height = (s) => s.verses.reduce((n, v) => n + v.eng.length + (v.speaker ? 1 : 0), 0);
  const pick = new Set([0]);
  for (const f of [(s) => widest(s, 'dev'), (s) => widest(s, 'eng'), height]) {
    [...verseIdx].sort((a, b) => f(slides[b]) - f(slides[a])).slice(0, 2).forEach((i) => pick.add(i));
  }
  const cand = [...pick].sort((a, b) => a - b);
  const ctx = slideCtx(extracted, theme, mantra);
  const fits = fitScales(cand.map((i) => slides[i]), ctx, path.join(out, 'render'));
  const verseCand = cand.map((i, k) => ({ i, fit: fits[k] })).filter((c) => slides[c.i].kind === 'verses');
  const tight = verseCand.length ? verseCand.reduce((a, b) => (b.fit < a.fit ? b : a)) : null;
  const scale = tight ? tight.fit : fits[0];
  const preScale = Math.min(fits[0], scale);

  const dir = path.join(out, 'preview');
  const shots = {};
  for (const [name, i, s] of /** @type {[string, number, number][]} */ ([['preamble', 0, preScale], ...(tight ? [['verse', tight.i, scale]] : [])])) {
    const html = writeHtml(dir, `${name}.html`, htmlFor(slides[i], { ...ctx, fixedScale: s }));
    screenshot(html, path.join(dir, `${name}.png`));
    shots[name] = path.join(dir, `${name}.png`);
  }
  const problems = [];
  if (scale < 0.6) problems.push(`the text comes out small (scale ${scale}); widen or heighten the box, or show fewer verses per slide`);
  if (mantra.expectedVerses && extracted.verses.length !== mantra.expectedVerses) problems.push(`expected ${mantra.expectedVerses} verses, found ${extracted.verses.length}`);
  log('preview', `${extracted.verses.length} verses in ${slides.length} slides; type scale ~${scale} (tightest: verse ${tight ? slides[tight.i].verses.map((v) => v.number).join('-') : '-'}), preamble ${preScale}`);
  return {
    shots, scale, preambleScale: preScale, verses: extracted.verses.length, slides: slides.length,
    tightestVerses: tight ? slides[tight.i].verses.map((v) => v.number) : [], autoIast: mantra.autoIast, problems,
  };
}

/**
 * Run the whole pipeline for one mantra bundle.
 * @param {string} idOrPath  bundle id (folder under MANTRAS_DIR) or path to mantra.json
 * @param {{ onStage?: (s:{name:string,index:number,total:number,phase:'start'|'done',info?:any})=>void,
 *           overrides?: Partial<import('./mantra.js').Mantra['underline']> & { showMeaning?: boolean },
 *           force?: boolean, sample?: {from:number,to:number} }} [opts]
 */
export async function runPipeline(idOrPath, opts = {}) {
  const onStage = opts.onStage || (() => {});
  const mantra = loadMantra(idOrPath);
  // Per-run UI overrides (the six underline controls + meaning toggle) win over
  // the bundle's own settings without mutating the bundle on disk.
  if (opts.overrides) {
    const { showMeaning, ...u } = opts.overrides;
    for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== '') mantra.underline[k] = v;
    if (showMeaning !== undefined) mantra.showMeaning = showMeaning;
  }
  const out = workDir(mantra);
  const total = STAGES.length;
  const at = (i, phase, info) => onStage({ name: STAGES[i], index: i, total, phase, info });
  log('pipeline', `mantra "${mantra.id}" -> ${mantra.output}  (underline ${mantra.underline.color}/${mantra.underline.motion}, meaning ${mantra.showMeaning})`);

  at(0, 'start');
  const extracted = extract(mantra, out);
  at(0, 'done', { verses: extracted.verses.length });

  // Stage 1 places the words on the audio. Forced alignment of the known text
  // is the default; Deepgram ASR is the fallback when the aligner is not set up.
  at(1, 'start');
  const useForced = config.aligner === 'ctc' || (config.aligner === 'auto' && alignerPython());
  if (config.aligner === 'auto' && !useForced) warn('pipeline', 'forced aligner not installed (npm run setup); falling back to Deepgram timing, which is less accurate');
  const placed = useForced
    ? { forced: forcedAlign(mantra, extracted, out, { force: opts.force }) }
    : { transcript: await transcribe(mantra, out, { force: opts.force }) };
  at(1, 'done', { source: useForced ? 'forced' : 'deepgram' });

  at(2, 'start');
  const timings = placed.forced ? alignForced(extracted, placed.forced, out) : align(extracted, placed.transcript, out);
  at(2, 'done', { mode: timings.mode, words: timings.words.length });

  at(3, 'start');
  const theme = themeFor(mantra, out);
  at(3, 'done', { accent: theme.accent, text: theme.text });

  // A sample renders one stretch of the timeline to data/<id>/, never over the
  // bundle's output, and only screenshots the slides that stretch shows.
  const win = opts.sample;
  at(4, 'start');
  const slides = buildSlides(extracted, timings, theme, mantra, out,
    win ? { only: (_i, s) => s.end > win.from && s.start < win.to } : {});
  at(4, 'done', { slides: slides.slides.length });

  at(5, 'start');
  const result = render(slides, timings, theme, mantra, out, win
    ? { window: win, output: path.join(out, `sample-${Math.round(win.from)}-${Math.round(win.to)}.mp4`) }
    : {});
  at(5, 'done', { output: result.output, mb: +(result.bytes / 1e6).toFixed(1) });

  return { mantra, out, theme, timings, slides, output: result.output, bytes: result.bytes };
}

export { STAGES };
