// @ts-check
// Stage 5 — assemble the video. Slides crossfade on the audio timeline (the
// prototype's proven xfade algebra), and a soft underline tracks the current
// transliteration word (handover §2/§5b).
//
// The underline is an ASS/libass overlay (src/ass.js), rendered by ffmpeg's
// `ass` filter over the crossfaded slides. This replaced a single drawbox driven
// by sendcmd, which could only nudge one hard rectangle and could not glow or
// glide smoothly. libass does the tweening, softening and haloing for us; here
// we only turn the measured word boxes + timings into the overlay and stitch the
// slides. The text (Devanagari + serif transliteration) still comes from the
// Chromium slide PNGs underneath — the overlay is a vector line only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegPath } from './paths.js';
import { config } from './config.js';
import { buildAssUnderline } from './ass.js';
import { log, warn } from './log.js';

const toHex2 = (n) => ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
// ffmpeg drawbox colour: 0xRRGGBBAA. Exported so a test can pin the alpha byte.
export function colorArg(hex6, opacity) {
  return `0x${hex6.replace('#', '')}${toHex2(opacity * 255)}`;
}

/**
 * @param {ReturnType<import('./slides.js').buildSlides>} slidesData
 * @param {ReturnType<import('./align.js').align>} timings
 * @param {{accent:string,text:string,underline?:string,bandLuminance?:number}} theme
 * @param {import('./mantra.js').Mantra} mantra
 * @param {string} outDir
 * @param {{ window?: {from:number,to:number}, output?: string }} [opts]
 *   window: render only that stretch of the timeline (a sample), to `output`.
 */
export function render(slidesData, timings, theme, mantra, outDir, opts = {}) {
  const win = opts.window;
  const output = opts.output || mantra.output;
  const all = slidesData.slides;
  // A sample keeps the slides overlapping the window, clipped and shifted so
  // the window starts at 0; the audio is seeked to match below.
  const slides = win
    ? all.filter((s) => s.end > win.from && s.start < win.to)
      .map((s) => ({ ...s, start: Math.max(s.start, win.from) - win.from, end: Math.min(s.end, win.to) - win.from }))
    : all;
  const D = win ? win.to - win.from : slidesData.duration;
  const T = config.crossfadeSeconds;
  const n = slides.length;
  if (!n) throw new Error('no slides in the requested window');
  for (const s of slides) if (!fs.existsSync(s.png)) throw new Error('missing slide png ' + s.png);

  const u = mantra.underline;
  const gap = u.gapPx;
  // Under the glyph baseline when the slide measured it; older slides.json only
  // has the box, whose bottom includes the line's leading.
  const lineY = (b) => (typeof b.base === 'number' ? b.base + gap : b.y + b.h + gap);
  const opacity = u.opacity;
  // 'auto' uses the theme's dedicated underline colour (a luminous line colour,
  // distinct from the speaker-text accent — see color.js). A forced hex still wins.
  const lineHex = u.color === 'auto' ? (theme.underline || theme.accent) : (u.color.startsWith('#') ? u.color : '#' + u.color);
  // A soft outline in the opposite tone gives the hairline an edge on any
  // background (dark edge on a light slide, light edge on a dark one), so the
  // line reads even where its colour is close to the slide behind it.
  const bandLum = typeof theme.bandLuminance === 'number' ? theme.bandLuminance : 0.5;
  const outlineHex = bandLum > 0.5 ? '#1a1206' : '#fbf3e0';

  // Which line the underline follows. The reference (and the default) is the
  // transliteration; 'dev' underlines the Devanagari, which is measured too. A
  // verse's Devanagari is one visual line, so its words share a glide group.
  const onDev = u.target === 'dev';

  // ---- box lookup: which slide holds a verse, and each word's measured box ----
  const slideOfVerse = new Map();
  const wordBox = new Map(); // translit: `${v}:${li}:${wi}` ; dev: `${v}:${gi}`
  const preBox = new Map();  // `${p}:${wi}` -> box (preamble is slide 0)
  const spBox = new Map();   // speaker line: `${v}:${wi}` -> box (transliteration only)
  all.forEach((s, si) => {
    for (const vn of s.verses) slideOfVerse.set(vn, si);
    for (const b of s.swords || []) spBox.set(`${b.v}:${b.wi}`, { ...b, slide: si });
    if (onDev) {
      for (const b of s.dwords || []) wordBox.set(`${b.v}:${b.gi}`, { ...b, slide: si });
      for (const b of s.pdwords || []) preBox.set(`${b.p}:${b.wi}`, { ...b, slide: si });
    } else {
      for (const b of s.words) wordBox.set(`${b.v}:${b.li}:${b.wi}`, { ...b, slide: si });
      for (const b of s.pwords) preBox.set(`${b.p}:${b.wi}`, { ...b, slide: si });
    }
  });

  // ---- ordered underline targets (preamble words, then verse words) ----
  /** @type {{t:number,x:number,y:number,w:number,slide:number,li:number}[]} */
  const targets = [];
  for (const pw of timings.preamble?.words || []) {
    const b = preBox.get(`${pw.p}:${pw.wi}`);
    if (b) targets.push({ t: pw.start, end: pw.end, x: b.x, y: lineY(b), w: b.w, slide: b.slide, li: -1 - pw.p });
  }
  for (const sw of timings.speakers || []) {
    const b = spBox.get(`${sw.verse}:${sw.wi}`);
    if (b) targets.push({ t: sw.start, end: sw.end, x: b.x, y: lineY(b), w: b.w, slide: b.slide, li: -1000 - sw.verse });
  }
  for (const w of timings.words) {
    const si = slideOfVerse.get(w.verse);
    const b = onDev ? wordBox.get(`${w.verse}:${w.gi}`) : wordBox.get(`${w.verse}:${w.li}:${w.wi}`);
    if (si === undefined || !b) continue;
    // Glide group: a translit line is (verse,li); a dev verse is one line, so (verse).
    const li = onDev ? 1000 + w.verse : w.li;
    targets.push({ t: w.start, end: w.end, x: b.x, y: lineY(b), w: b.w, slide: si, li });
  }
  targets.sort((a, b) => a.t - b.t);
  if (win) {
    const kept = targets.filter((x) => x.end > win.from && x.t < win.to)
      .map((x) => ({ ...x, t: Math.max(0, x.t - win.from), end: Math.min(D, x.end - win.from) }));
    targets.length = 0;
    targets.push(...kept);
  }
  // A glide takes glideMs; start it that much early so the line *arrives* under
  // a word as the word is sung, rather than trailing the voice by the glide.
  if (u.motion === 'glide') {
    const lead = u.glideMs / 1000;
    for (let i = targets.length - 1; i > 0; i--) {
      const cur = targets[i], prev = targets[i - 1];
      if (cur.slide === prev.slide && cur.li === prev.li) cur.t = Math.max(prev.t + 0.05, cur.t - lead);
    }
  }
  if (!targets.length) warn('render', 'no underline targets matched a measured box; the video will have no underline');

  // ---- the underline overlay (.ass) ----
  const assStr = buildAssUnderline(targets, {
    colorHex: lineHex, outlineHex, opacity, thicknessPx: u.thicknessPx, halo: u.halo,
    motion: u.motion, glideMs: u.glideMs, lengthPx: u.lengthPx, playW: 1920, playH: 1080, duration: D,
  });
  const assPath = path.join(outDir, 'underline.ass');
  fs.writeFileSync(assPath, assStr, 'utf8');
  const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  fs.mkdirSync(path.dirname(output), { recursive: true });
  log('render', `n=${n} T=${T}s D=${D.toFixed(1)}s underline=${u.enabled ? 'on' : 'off'} targets=${targets.length} color=${lineHex}@${opacity} thickness=${u.thicknessPx}px motion=${u.motion} halo=${u.halo}`);
  const t0 = Date.now();

  // ---- slides -> silent video, in chunks (config.renderChunkSlides) ----
  // Each chunk is its own ffmpeg pass, because one pass holds a frame queue per
  // slide and a long chapter exhausted a 16 GB machine. Chunks are cut in the
  // middle of a slide, where the picture is still, so a seam cannot show. The
  // underline is not drawn here; it is one overlay over the joined video below.
  const cuts = chunkCuts(slides, D, T, config.fps, config.renderChunkSlides);
  const chunkDir = path.join(outDir, 'chunks');
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });
  const files = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const file = path.join(chunkDir, `chunk-${String(c).padStart(3, '0')}.mkv`);
    renderChunk(slides, cuts[c], cuts[c + 1], T, file);
    files.push(file);
    log('render', `chunk ${c + 1}/${cuts.length - 1} ${cuts[c].toFixed(2)}–${cuts[c + 1].toFixed(2)}s`);
  }
  const list = path.join(chunkDir, 'chunks.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');

  // ---- joined video + underline + audio -> output ----
  // libass tweens the underline over the crossfaded slides. The overlay is a
  // vector line only (no text), so this layer needs no font shaping. With the
  // underline off the slides go out untouched; underline.ass is still written,
  // so the timing can be inspected without a render.
  const filter = u.enabled ? `[0:v]ass='${assEsc}'[vout]` : '[0:v]null[vout]';
  fs.writeFileSync(path.join(outDir, 'filter.txt'), `cuts ${cuts.map((c) => c.toFixed(3)).join(' ')}\n${filter}\n`, 'utf8');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (win) args.push('-ss', win.from.toFixed(3), '-t', D.toFixed(3));
  args.push('-i', mantra.audio);
  args.push('-filter_complex', filter, '-map', '[vout]', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', config.preset, '-crf', String(config.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', config.audioBitrate, '-movflags', '+faststart', '-shortest', output);
  ffmpeg(args);
  fs.rmSync(chunkDir, { recursive: true, force: true });

  const sz = fs.statSync(output).size;
  log('render', `OK ${((Date.now() - t0) / 1000).toFixed(0)}s (${(sz / 1e6).toFixed(1)} MB) -> ${output}`);
  return { output, seconds: (Date.now() - t0) / 1000, bytes: sz };
}

function ffmpeg(args) {
  const r = spawnSync(ffmpegPath(), args, { stdio: 'inherit', windowsHide: true, timeout: 30 * 60 * 1000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('ffmpeg exited ' + r.status);
}

/**
 * Chunk boundaries on the output timeline: every `per` slides, at the middle of
 * the first slide from there that holds still for longer than a crossfade,
 * rounded to a frame so the chunks' frame counts add up to the whole.
 * @param {{start:number,end:number}[]} slides
 */
export function chunkCuts(slides, D, T, fps, per) {
  const cuts = [0];
  let j = per;
  while (j < slides.length - 1) {
    while (j < slides.length - 1 && slides[j].end - slides[j].start < T + 4 / fps) j++;
    if (j >= slides.length - 1) break;
    const c = Math.round(((slides[j].start + slides[j].end) / 2) * fps) / fps;
    if (c > cuts[cuts.length - 1]) cuts.push(c);
    j += per;
  }
  cuts.push(D);
  return cuts;
}

/** One stretch [from, to) of the crossfaded slides, video only, near-lossless. */
function renderChunk(all, from, to, T, file) {
  // Slides overlapping the stretch, clipped and shifted to start at 0.
  const slides = all.filter((s) => s.end > from && s.start < to)
    .map((s) => ({ ...s, start: Math.max(s.start, from) - from, end: Math.min(s.end, to) - from }));
  const n = slides.length;
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`[${i}:v]scale=1920:1080,fps=${config.fps},format=yuv420p,setsar=1,settb=AVTB[s${i}]`);
  let prevLabel = 's0';
  for (let k = 1; k < n; k++) {
    const o = (slides[k].start - T / 2).toFixed(3);
    const out = k === n - 1 ? 'vbase' : `x${k}`;
    parts.push(`[${prevLabel}][s${k}]xfade=transition=fade:duration=${T}:offset=${o}[${out}]`);
    prevLabel = out;
  }
  if (n === 1) parts.push(`[s0]copy[vbase]`);
  // Pad with the last frame and stop at an exact frame count, so rounding in
  // the xfade chain can never make one chunk short and shift every later one.
  parts.push('[vbase]tpad=stop_mode=clone:stop_duration=1[vout]');

  // Feed durations (audio-synced xfade): ends overlap once, interiors twice.
  const w = slides.map((s) => s.end - s.start);
  const d = w.map((wi, i) => (n === 1 ? wi : i === 0 || i === n - 1 ? wi + T / 2 : wi + T));
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (let i = 0; i < n; i++) args.push('-loop', '1', '-framerate', String(config.fps), '-t', d[i].toFixed(3), '-i', slides[i].png);
  args.push('-filter_complex', parts.join(';'), '-map', '[vout]', '-frames:v', String(Math.round((to - from) * config.fps)),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', file);
  ffmpeg(args);
}
