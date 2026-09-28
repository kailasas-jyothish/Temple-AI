import { spawnSync } from 'node:child_process';
const FF = 'C:\\Users\\GD\\Desktop\\GD\\yt-dlp\\ffmpeg.exe';
const W=1920,H=1080;
function load(png){ return spawnSync(FF,['-hide_banner','-loglevel','error','-i',png,'-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1e9}).stdout; }
const hit=(R,G,B)=> R>188&&R<224&&G>102&&G<142&&B>12&&B<58;
function scan(png){
  const b=load(png);
  let best=null;
  for(let y=0;y<H;y++){
    let run=0,rs=0,bestRun=0,bx0=0,bx1=0;
    for(let x=0;x<W;x++){ const i=(y*W+x)*3;
      if(hit(b[i],b[i+1],b[i+2])){ if(run===0)rs=x; run++; if(run>bestRun){bestRun=run;bx0=rs;bx1=x;} } else run=0; }
    if(bestRun>150 && (!best||bestRun>best.len||(Math.abs(bestRun-best.len)<30))) {
      if(!best||bestRun>best.len){best={y,len:bestRun,x0:bx0,x1:bx1};}
    }
  }
  return best;
}
for(const png of process.argv.slice(2)){
  const r=scan(png);
  console.log(png.split('\\').pop(), r?`underline row y=${r.y} x=${r.x0}..${r.x1} width=${r.len}`:'none');
}
