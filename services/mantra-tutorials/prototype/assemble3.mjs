import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = 'C:\\Users\\GD\\AppData\\Local\\Temp\\claude\\C--Users-GD-Desktop-GD-Temple-AI\\b59c9d39-eb61-4c17-b13f-e09daca89330\\scratchpad';
const OUTDIR = 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video';
const AUDIO = 'C:\\Users\\GD\\Downloads\\2. Kavacha Stotram.mp3';
const FFMPEG = 'C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe';
const T = 0.7;                 // crossfade duration (s)
const UCOLOR = '0xCE7A1Fe6';   // underline saffron w/ alpha
const UH = 7;                  // underline thickness (px)
const STEP = 0.1;             // sendcmd width-update cadence (s)
const YOFF = -2;             // underline top relative to line-box bottom

const { duration: D, slides } = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'slides.json'), 'utf8'));
const timings = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'timings.json'), 'utf8'));
const verseStart = (n) => timings.verses[n - 1].start;
const verseEnd = (n) => (n < 56 ? timings.verses[n].start : D);

const n = slides.length;
for (const s of slides) if (!fs.existsSync(s.png)) throw new Error('missing png ' + s.png);

// ---- window lengths and per-segment feed durations (audio-synced xfade) ----
const w = slides.map((s) => s.end - s.start);
const d = w.map((wi, i) => (i === 0 ? wi + T / 2 : i === n - 1 ? wi + T / 2 : wi + T));

// ---- per-segment scale/format then xfade chain -> [vbase] ----
const segParts = [];
for (let i = 0; i < n; i++) {
  segParts.push(`[${i}:v]scale=1920:1080,fps=30,format=yuv420p,setsar=1,settb=AVTB[s${i}]`);
}
const chain = [];
let prev = 's0';
for (let k = 1; k < n; k++) {
  const o = (slides[k].start - T / 2).toFixed(3);
  const out = k === n - 1 ? 'vbase' : `x${k}`;
  chain.push(`[${prev}][s${k}]xfade=transition=fade:duration=${T}:offset=${o}[${out}]`);
  prev = out;
}

// ---- growing underline segments: preamble lines + every verse ----
// One drawbox on the final stream, driven by sendcmd. drawbox w/x/y support
// runtime commands in this build (verified), so the bar grows left->right under
// the line being chanted and jumps to the next line at each boundary.
const seg = [];
// preamble: split its window across the dev lines, weighted by line width
const pre = slides[0];
if (pre.kind === 'preamble' && pre.plines && pre.plines.length) {
  const t0 = 0.4, t1 = verseStart(1);       // small lead-in before the first verse
  const plines = pre.plines.slice().sort((a, b) => a.p - b.p);
  const wsum = plines.reduce((a, b) => a + b.w, 0);
  let cur = t0;
  for (const p of plines) {
    const span = (t1 - t0) * (p.w / wsum);
    seg.push({ t0: cur, t1: cur + span, x0: p.x, wfull: p.w, y: p.y + p.h + YOFF });
    cur += span;
  }
}
// verses
for (let i = 1; i < n; i++) {
  const boxes = new Map((slides[i].lines || []).map((l) => [l.v, l]));
  for (const vn of slides[i].verses) {
    const b = boxes.get(vn);
    if (!b) continue;
    seg.push({ t0: verseStart(vn), t1: verseEnd(vn), x0: b.x, wfull: b.w, y: b.y + b.h + YOFF });
  }
}
seg.sort((a, b) => a.t0 - b.t0);

// ---- sendcmd command file ----
const cmds = [`0 drawbox color ${UCOLOR}`, '0 drawbox w 0'];
for (const s of seg) {
  const dur = Math.max(0.001, s.t1 - s.t0);
  cmds.push(`${s.t0.toFixed(3)} drawbox x ${Math.round(s.x0)}`);
  cmds.push(`${s.t0.toFixed(3)} drawbox y ${Math.round(s.y)}`);
  cmds.push(`${s.t0.toFixed(3)} drawbox w 0`);
  for (let t = s.t0 + STEP; t < s.t1; t += STEP) {
    const wv = Math.round(Math.min(1, (t - s.t0) / dur) * s.wfull);
    cmds.push(`${t.toFixed(3)} drawbox w ${wv}`);
  }
  cmds.push(`${s.t1.toFixed(3)} drawbox w ${Math.round(s.wfull)}`);
}
const cmdPath = path.join(HERE, 'ucmd.txt');
fs.writeFileSync(cmdPath, cmds.map((c) => c + ';').join('\n') + '\n', 'utf8');
const cmdEsc = cmdPath.replace(/\\/g, '/').replace(/:/g, '\\:');

const filter = segParts.concat(chain).join(';')
  + `;[vbase]sendcmd=f='${cmdEsc}',drawbox=x=0:y=0:w=0:h=${UH}:color=${UCOLOR}:t=fill[vout]`;
fs.writeFileSync(path.join(OUTDIR, 'filter.txt'), filter, 'utf8');

// ---- inputs ----
const args = ['-hide_banner', '-loglevel', 'error', '-y'];
for (let i = 0; i < n; i++) {
  args.push('-loop', '1', '-framerate', '30', '-t', d[i].toFixed(3), '-i', slides[i].png);
}
args.push('-i', AUDIO); // input n
args.push('-filter_complex', filter, '-map', '[vout]', '-map', `${n}:a:0`,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest',
  path.join(OUTDIR, 'Durga-Devi-Kavacham.mp4'));

console.log(`n=${n} T=${T}s D=${D.toFixed(1)}s; segs=${seg.length} cmds=${cmds.length}`);
const t0 = Date.now();
const r = spawnSync(FFMPEG, args, { stdio: 'inherit', windowsHide: true, timeout: 900000 });
if (r.error) throw r.error;
if (r.status !== 0) throw new Error('ffmpeg status ' + r.status);
const sz = fs.statSync(path.join(OUTDIR, 'Durga-Devi-Kavacham.mp4')).size;
console.log(`OK ${((Date.now() - t0) / 1000).toFixed(0)}s (${(sz / 1e6).toFixed(1)} MB)`);
