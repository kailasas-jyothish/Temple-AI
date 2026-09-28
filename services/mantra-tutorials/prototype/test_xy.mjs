import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const FF='C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe';
const PNG='C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video\\slides\\slide002.png';
const OUT='C:\\Users\\GD\\AppData\\Local\\Temp\\claude\\C--Users-GD-Desktop-GD-Temple-AI\\b59c9d39-eb61-4c17-b13f-e09daca89330\\scratchpad';
// seg1: (149,439) grow 0..1621 over 0..5s ; seg2: (135,534) grow 0..1650 over 5..10s
let cmds='0 drawbox color 0xCE7A1Fe6;\n0 drawbox x 149;\n0 drawbox y 439;\n';
for(let t=0;t<5;t+=0.1){ const w=Math.round((t/5)*1621); cmds+=`${t.toFixed(1)} drawbox w ${w};\n`; }
cmds+='5 drawbox x 135;\n5 drawbox y 534;\n5 drawbox w 0;\n';
for(let t=5;t<10;t+=0.1){ const w=Math.round(((t-5)/5)*1650); cmds+=`${t.toFixed(1)} drawbox w ${w};\n`; }
const cmdPath=`${OUT}\\cmd_xy.txt`;
fs.writeFileSync(cmdPath,cmds,'utf8');
const p=cmdPath.replace(/\\/g,'/').replace(/:/g,'\\:');
const vf=`sendcmd=f='${p}',drawbox=x=149:y=439:w=0:h=8:color=0xCE7A1Fe6:t=fill`;
const r=spawnSync(FF,['-hide_banner','-loglevel','error','-y','-loop','1','-framerate','30','-t','10','-i',PNG,'-vf',vf,'-c:v','libx264','-pix_fmt','yuv420p',`${OUT}\\xy_test.mp4`],{windowsHide:true});
if(r.status!==0){ console.log('FAIL',r.status,(r.stderr||'').toString().slice(0,500)); process.exit(1); }
for(const t of [2,4.5,7,9.5]){ spawnSync(FF,['-hide_banner','-loglevel','error','-y','-ss',String(t),'-i',`${OUT}\\xy_test.mp4`,'-frames:v','1',`${OUT}\\xy_${t}.png`],{windowsHide:true}); }
console.log('OK');
