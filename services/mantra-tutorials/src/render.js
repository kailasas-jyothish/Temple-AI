// @ts-check
// Stage 5 — assemble the video. Slides crossfade on the audio timeline (the
// prototype's proven xfade algebra), and a thin underline tracks the current
// transliteration word (handover §2/§5b).
//
// The underline is ONE drawbox driven by a sendcmd file. Three facts about this
// ffmpeg build (N-107417), each verified against it before trusting it, shape the
// code:
//   1. sendcmd drives only the FIRST drawbox instance; a second box (e.g. a halo
//      layer) cannot be animated, and `drawbox@label` targeting is ignored. So
//      the underline is a single box, and "halo" is expressed as a softer, taller
//      single line rather than a separate glow.
//   2. drawbox `w 0` means "extend to the input width", not "hide". To hide the
//      box (before the first word) we park it off-screen on y instead.
//   3. drawbox reads x,y,w commands in the order they arrive at a timestamp, so
//      each keyframe emits x, then y, then w (matching the working prototype).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegPath } from './paths.js';
import { config } from './config.js';
import { log, warn } from './log.js';

const HIDDEN_Y = 1130; // just below the 1080 frame — parks the box out of sight
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
  // "halo" has no second box available, so it reads as a softer, slightly taller
  // single underline; the crisp default is the thin reference line.
  const th = u.halo ? u.thicknessPx + 4 : u.thicknessPx;
  const opacity = u.halo ? Math.min(u.opacity, 0.55) : u.opacity;
  const lineHex = u.color === 'auto' ? theme.accent : (u.color.startsWith('#') ? u.color : '#' + u.color);
  const lineColor = colorArg(lineHex, opacity);
  const glide = u.motion === 'glide';
  const glideS = u.glideMs / 1000;

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
    if (b) targets.push({ t: pw.start, x: b.x, y: b.y + b.h + gap, w: b.w, slide: b.slide, li: -1 - pw.p });
  }
  for (const w of timings.words) {
    const si = slideOfVerse.get(w.verse);
    const b = onDev ? wordBox.get(`${w.verse}:${w.gi}`) : wordBox.get(`${w.verse}:${w.li}:${w.wi}`);
    if (si === undefined || !b) continue;
    // Glide group: a translit line is (verse,li); a dev verse is one line, so (verse).
    const li = onDev ? 1000 + w.verse : w.li;
    targets.push({ t: w.start, x: b.x, y: b.y + b.h + gap, w: b.w, slide: si, li });
  }
  targets.sort((a, b) => a.t - b.t);
  if (!targets.length) warn('render', 'no underline targets matched a measured box; the video will have no underline');

  // ---- sendcmd command file (single drawbox, x -> y -> w per keyframe) ----
  const cmds = [];
  const push = (t, param, val) => cmds.push({ t, o: cmds.length, s: `${t.toFixed(3)} drawbox ${param} ${Math.round(val)}` });
  cmds.push({ t: 0, o: -3, s: `0 drawbox color ${lineColor}` });
  cmds.push({ t: 0, o: -2, s: `0 drawbox w 8` });        // any non-zero; w 0 would span the frame
  cmds.push({ t: 0, o: -1, s: `0 drawbox y ${HIDDEN_Y}` }); // parked until the first word

  let prev = null;
  for (const cur of targets) {
    const t = cur.t;
    const sameLine = prev && glide && prev.slide === cur.slide && prev.li === cur.li;
    if (!sameLine) {
      push(t, 'x', cur.x);
      push(t, 'y', cur.y);
      push(t, 'w', cur.w);
    } else {
      push(t, 'y', cur.y); // vertical never glides
      const K = 4;
      for (let s = 1; s <= K; s++) {
        const tt = t + (glideS * s) / K;
        push(tt, 'x', prev.x + (cur.x - prev.x) * (s / K));
        push(tt, 'w', prev.w + (cur.w - prev.w) * (s / K));
      }
    }
    prev = cur;
  }
  // Stable sort: by time, then original emission order (keeps x->y->w at a tie).
  cmds.sort((a, b) => a.t - b.t || a.o - b.o);

  const cmdPath = path.join(outDir, 'underline.cmd');
  fs.writeFileSync(cmdPath, cmds.map((c) => c.s + ';').join('\n') + '\n', 'utf8');
  const cmdEsc = cmdPath.replace(/\\/g, '/').replace(/:/g, '\\:');

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

  const filter = parts.join(';')
    + `;[vbase]sendcmd=f='${cmdEsc}',drawbox=x=0:y=${HIDDEN_Y}:w=8:h=${th}:color=${lineColor}:t=fill[vout]`;
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
  log('render', `n=${n} T=${T}s D=${D.toFixed(1)}s targets=${targets.length} cmds=${cmds.length} color=${lineHex}@${opacity} th=${th}px motion=${u.motion} halo=${u.halo}`);
  log('render', `feed durations sum ${feedSum.toFixed(2)}s -> after xfade ${afterXfade.toFixed(2)}s (audio ${D.toFixed(2)}s)`);
  const t0 = Date.now();
  const r = spawnSync(ffmpegPath(), args, { stdio: 'inherit', windowsHide: true, timeout: 30 * 60 * 1000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('ffmpeg exited ' + r.status);
  const sz = fs.statSync(mantra.output).size;
  log('render', `OK ${((Date.now() - t0) / 1000).toFixed(0)}s (${(sz / 1e6).toFixed(1)} MB) -> ${mantra.output}`);
  return { output: mantra.output, seconds: (Date.now() - t0) / 1000, bytes: sz };
}
