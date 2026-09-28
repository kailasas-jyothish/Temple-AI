import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const FF='C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe';
const PNG='C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video\\slides\\slide002.png';
const OUT='C:\\Users\\GD\\AppData\\Local\\Temp\\claude\\C--Users-GD-Desktop-GD-Temple-AI\\b59c9d39-eb61-4c17-b13f-e09daca89330\\scratchpad';
// grow w from 0 to 1600 over 12s under verse 4 (y ~ 433)
let cmds='';
for(let i=0;i<=48;i++){ const t=(i*0.25).toFixed(2); const w=Math.round((i/48)*1600); cmds+=`${t} drawbox w ${w};\n`; }
const cmdPath=`${OUT}\\cmd.txt`;
fs.writeFileSync(cmdPath,cmds,'utf8');
const vf=`sendcmd=f='${cmdPath.replace(/\\/g,'/').replace(/:/g,'\\:')}',drawbox=x=149:y=433:w=0:h=10:color=0xCE7A1Fe6:t=fill`;
const r=spawnSync(FF,['-hide_banner','-loglevel','error','-y','-loop','1','-framerate','30','-t','12','-i',PNG,'-vf',vf,'-c:v','libx264','-pix_fmt','yuv420p',`${OUT}\\sc_test.mp4`],{windowsHide:true});
if(r.status!==0){ console.log('ENCODE FAIL',r.status,(r.stderr||'').toString().slice(0,500)); process.exit(1); }
for(const t of [1,6,11]){ spawnSync(FF,['-hide_banner','-loglevel','error','-y','-ss',String(t),'-i',`${OUT}\\sc_test.mp4`,'-frames:v','1',`${OUT}\\sc_${t}.png`],{windowsHide:true}); }
console.log('OK - extracted sc_1 sc_6 sc_11');
