import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const FF = 'C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe';
const VID = 'C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\Argala Stotram - #DurgaSaptashati Series - Day2 [oYYP5eqXwSA].webm';
const OUT = 'C:\\Users\\GD\\AppData\\Local\\Temp\\claude\\C--Users-GD-Desktop-GD-Temple-AI\\b59c9d39-eb61-4c17-b13f-e09daca89330\\scratchpad\\ref';
fs.mkdirSync(OUT, { recursive: true });
// Sample several base times; at each, pull a short burst of consecutive frames to see the highlight motion.
const bursts = process.argv.slice(2).map(Number);
const base = bursts.length ? bursts : [90, 150, 210];
for (const b of base) {
  for (let k = 0; k < 8; k++) {
    const t = (b + k * 0.3).toFixed(2);
    const out = `${OUT}\\t${b}_${String(k).padStart(2, '0')}.png`;
    const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t, '-i', VID, '-frames:v', '1', out], { windowsHide: true, timeout: 60000 });
    if (r.status !== 0) console.log('FAIL', t, (r.stderr || '').toString().slice(0, 200));
  }
  console.log('burst', b, 'done');
}
