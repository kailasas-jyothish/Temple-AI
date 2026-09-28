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
 * @param {{accent:string,text:string}} theme
 * @param {import('./mantra.js').Mantra} mantra
 * @param {string} outDir
 */
export function render(slidesData, timings, theme, mantra, outDir) {
  const slides = slidesData.slides;
  const D = slidesData.duration;
  const T = config.crossfadeSeconds;
  const n = slides.length;
  for (const s of slides) if (!fs.existsSync(s.png)) throw new Error('missing slide png ' + s.png);

  const u = mantra.underline;
  const gap = u.gapPx;
  const opacity = u.opacity;
  const lineHex = u.color === 'auto' ? theme.accent : (u.color.startsWith('#') ? u.color : '#' + u.color);

  // Which line the underline follows. The reference (and the default) is the
  // transliteration; 'dev' underlines the Devanagari, which is measured too. A
  // verse's Devanagari is one visual line, so its words share a glide group.
  const onDev = u.target === 'dev';

  // ---- box lookup: which slide holds a verse, and each word's measured box ----
  const slideOfVerse = new Map();
  const wordBox = new Map(); // translit: `${v}:${li}:${wi}` ; dev: `${v}:${gi}`
  const preBox = new Map();  // `${p}:${wi}` -> box (preamble is slide 0)
  slides.forEach((s, si) => {
    for (const vn of s.verses) slideOfVerse.set(vn, si);
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
    if (b) targets.push({ t: pw.start, end: pw.end, x: b.x, y: b.y + b.h + gap, w: b.w, slide: b.slide, li: -1 - pw.p });
  }
  for (const w of timings.words) {
    const si = slideOfVerse.get(w.verse);
    const b = onDev ? wordBox.get(`${w.verse}:${w.gi}`) : wordBox.get(`${w.verse}:${w.li}:${w.wi}`);
    if (si === undefined || !b) continue;
    // Glide group: a translit line is (verse,li); a dev verse is one line, so (verse).
    const li = onDev ? 1000 + w.verse : w.li;
    targets.push({ t: w.start, end: w.end, x: b.x, y: b.y + b.h + gap, w: b.w, slide: si, li });
  }
  targets.sort((a, b) => a.t - b.t);
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
    colorHex: lineHex, opacity, thicknessPx: u.thicknessPx, halo: u.halo,
    motion: u.motion, glideMs: u.glideMs, playW: 1920, playH: 1080, duration: D,
  });
  const assPath = path.join(outDir, 'underline.ass');
  fs.writeFileSync(assPath, assStr, 'utf8');
  const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // ---- per-segment scale/format + xfade chain -> [vbase] ----
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

  // libass tweens the underline over the crossfaded slides. The overlay is a
  // vector line only (no text), so this layer needs no font shaping. With the
  // underline off (the default) the slides go out untouched; underline.ass is
  // still written, so the timing can be inspected without a render.
  const filter = parts.join(';') + (u.enabled ? `;[vbase]ass='${assEsc}'[vout]` : ';[vbase]null[vout]');
  fs.writeFileSync(path.join(outDir, 'filter.txt'), filter, 'utf8');

  // ---- feed durations (audio-synced xfade): ends overlap once, interiors twice ----
  const w = slides.map((s) => s.end - s.start);
  const d = w.map((wi, i) => (n === 1 ? wi : i === 0 || i === n - 1 ? wi + T / 2 : wi + T));
  const feedSum = d.reduce((a, b) => a + b, 0);
  const afterXfade = feedSum - (n - 1) * T;

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (let i = 0; i < n; i++) args.push('-loop', '1', '-framerate', String(config.fps), '-t', d[i].toFixed(3), '-i', slides[i].png);
  args.push('-i', mantra.audio);
  args.push('-filter_complex', filter, '-map', '[vout]', '-map', `${n}:a:0`,
    '-c:v', 'libx264', '-preset', config.preset, '-crf', String(config.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', config.audioBitrate, '-movflags', '+faststart', '-shortest', mantra.output);

  fs.mkdirSync(path.dirname(mantra.output), { recursive: true });
  log('render', `n=${n} T=${T}s D=${D.toFixed(1)}s underline=${u.enabled ? 'on' : 'off'} targets=${targets.length} color=${lineHex}@${opacity} thickness=${u.thicknessPx}px motion=${u.motion} halo=${u.halo}`);
  log('render', `feed durations sum ${feedSum.toFixed(2)}s -> after xfade ${afterXfade.toFixed(2)}s (audio ${D.toFixed(2)}s)`);
  const t0 = Date.now();
  const r = spawnSync(ffmpegPath(), args, { stdio: 'inherit', windowsHide: true, timeout: 30 * 60 * 1000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('ffmpeg exited ' + r.status);
  const sz = fs.statSync(mantra.output).size;
  log('render', `OK ${((Date.now() - t0) / 1000).toFixed(0)}s (${(sz / 1e6).toFixed(1)} MB) -> ${mantra.output}`);
  return { output: mantra.output, seconds: (Date.now() - t0) / 1000, bytes: sz };
}
