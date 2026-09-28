// @ts-check
// Derive an underline/text theme from the background PNG (handover §5b). The
// accent is the background's own dominant *saturated* colour, so a gold slide
// yields warm amber and a blue slide yields blue — nothing is hard-coded to
// saffron. Visibility is then guaranteed against the central text band with a
// WCAG-style contrast nudge. This is a measurement, so it runs in the same
// headless browser that renders slides (no PNG-decode dependency), reading the
// image back through a <canvas>.
import fs from 'node:fs';
import path from 'node:path';
import { writeHtml, dumpData } from './browser.js';
import { log } from './log.js';

/**
 * @param {string} bgPath
 * @param {string} outDir
 * @param {{ band?: {top:number,bottom:number,left:number,right:number} }} [opts]
 * @returns {{ accent:string, text:string, bandLuminance:number, contrast:number }}
 */
export function deriveTheme(bgPath, outDir, opts = {}) {
  const band = opts.band || { top: 300, bottom: 760, left: 70, right: 1850 };
  const url = `file:///${bgPath.replace(/\\/g, '/')}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
(function(){
  var W=200, H=Math.round(200*1080/1920);
  function done(obj){ document.documentElement.setAttribute('data-theme', JSON.stringify(obj)); }
  var img=new Image();
  img.onload=function(){
    try{
      var cv=document.createElement('canvas'); cv.width=W; cv.height=H;
      var g=cv.getContext('2d'); g.drawImage(img,0,0,W,H);
      var d=g.getImageData(0,0,W,H).data;
      // coarse 5-bit-per-channel histogram
      var buckets={};
      for(var i=0;i<d.length;i+=4){
        var r=d[i],gr=d[i+1],b=d[i+2];
        var key=(r>>3)+','+(gr>>3)+','+(b>>3);
        var e=buckets[key]||(buckets[key]={r:0,g:0,b:0,n:0});
        e.r+=r; e.g+=gr; e.b+=b; e.n++;
      }
      var total=0, best=null, bestScore=-1;
      for(var k in buckets){ total+=buckets[k].n; }
      for(var k in buckets){
        var e=buckets[k]; var r=e.r/e.n,gg=e.g/e.n,bb=e.b/e.n;
        var mx=Math.max(r,gg,bb),mn=Math.min(r,gg,bb);
        var sat=mx===0?0:(mx-mn)/mx;
        var cov=e.n/total;
        var score=sat*Math.sqrt(cov);
        if(score>bestScore){ bestScore=score; best={r:r,g:gg,b:bb,sat:sat}; }
      }
      if(!best) best={r:200,g:140,b:60,sat:0.5};
      // central band luminance (relative luminance, sRGB)
      function relLum(r,g,b){
        function ch(c){ c/=255; return c<=0.03928? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
        return 0.2126*ch(r)+0.7152*ch(g)+0.0722*ch(b);
      }
      var bx0=Math.round(${band.left}/1920*W), bx1=Math.round(${band.right}/1920*W);
      var by0=Math.round(${band.top}/1080*H), by1=Math.round(${band.bottom}/1080*H);
      var sum=0,cnt=0;
      for(var y=by0;y<by1;y++) for(var x=bx0;x<bx1;x++){
        var o=(y*W+x)*4; sum+=relLum(d[o],d[o+1],d[o+2]); cnt++;
      }
      var bandLum=cnt? sum/cnt : 0.5;
      // contrast nudge of the accent against the band
      function rgb2hsl(r,g,b){ r/=255;g/=255;b/=255; var mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,h,s;
        if(mx===mn){h=s=0;} else { var dd=mx-mn; s=l>0.5? dd/(2-mx-mn): dd/(mx+mn);
          h = mx===r? (g-b)/dd+(g<b?6:0) : mx===g? (b-r)/dd+2 : (r-g)/dd+4; h/=6; } return [h,s,l]; }
      function hsl2rgb(h,s,l){ function f(p,q,t){ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t;
          if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; }
        var q=l<0.5? l*(1+s): l+s-l*s, p=2*l-q; return [Math.round(f(p,q,h+1/3)*255),Math.round(f(p,q,h)*255),Math.round(f(p,q,h-1/3)*255)]; }
      function contrast(r,g,b){ var l1=relLum(r,g,b); var a=Math.max(l1,bandLum)+0.05,c=Math.min(l1,bandLum)+0.05; return a/c; }
      var hsl=rgb2hsl(best.r,best.g,best.b);
      // ensure it reads as a colour, not a wash
      hsl[1]=Math.max(0.45,hsl[1]);
      var rgb=hsl2rgb(hsl[0],hsl[1],hsl[2]);
      var guard=0;
      while(contrast(rgb[0],rgb[1],rgb[2])<3 && guard<60){
        hsl[2]+= bandLum>0.5? -0.02 : 0.02;
        hsl[2]=Math.min(0.95,Math.max(0.05,hsl[2]));
        rgb=hsl2rgb(hsl[0],hsl[1],hsl[2]); guard++;
      }
      function hex(a){ return '#'+a.map(function(v){return ('0'+Math.max(0,Math.min(255,v)).toString(16)).slice(-2);}).join(''); }
      done({ accent:hex(rgb), text: bandLum>0.5? '#20140a':'#f4ead6', bandLuminance:+bandLum.toFixed(3), contrast:+contrast(rgb[0],rgb[1],rgb[2]).toFixed(2) });
    }catch(err){ done({ accent:'#c8791f', text:'#20140a', bandLuminance:0.5, contrast:0, error:String(err) }); }
  };
  img.onerror=function(){ done({ accent:'#c8791f', text:'#20140a', bandLuminance:0.5, contrast:0, error:'image load failed' }); };
  img.src=${JSON.stringify(url)};
})();
</script></body></html>`;

  const p = writeHtml(outDir, 'theme.html', html);
  const data = dumpData(p, ['data-theme'], ['--allow-file-access-from-files', '--disable-web-security', `--user-data-dir=${path.join(outDir, 'chrome-profile')}`]);
  const theme = data['data-theme'] || { accent: '#c8791f', text: '#20140a', bandLuminance: 0.5, contrast: 0 };
  fs.writeFileSync(path.join(outDir, 'theme.json'), JSON.stringify(theme, null, 2), 'utf8');
  log('theme', `accent=${theme.accent} text=${theme.text} bandLum=${theme.bandLuminance} contrast=${theme.contrast}${theme.error ? ' (' + theme.error + ')' : ''}`);
  return theme;
}
