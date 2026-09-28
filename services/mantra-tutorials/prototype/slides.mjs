import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = 'C:\\Users\\GD\\AppData\\Local\\Temp\\claude\\C--Users-GD-Desktop-GD-Temple-AI\\b59c9d39-eb61-4c17-b13f-e09daca89330\\scratchpad';
const RENDER = path.join(HERE, 'render');
const OUTDIR = 'C:\\Users\\GD\\Downloads\\Durga Saptashati\\Durga Kavacham Video';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const args = process.argv.slice(2);
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const noShot = args.includes('--no-shot');

const { preamble, verses } = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'verses.json'), 'utf8'));
const timings = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'timings.json'), 'utf8'));

// ---- group verses into slides ----
const MAX_VERSES = 3, MAX_ENG_LINES = 6;
const groups = [];
let cur = [];
let engLines = 0;
for (const v of verses) {
  const add = v.eng.length;
  if (cur.length && (cur.length >= MAX_VERSES || engLines + add > MAX_ENG_LINES)) {
    groups.push(cur); cur = []; engLines = 0;
  }
  cur.push(v); engLines += add;
}
if (cur.length) groups.push(cur);

// ---- build slide list with timing ----
const startOf = (n) => timings.verses[n - 1].start;
const slides = [];
// preamble slide
slides.push({ kind: 'preamble', start: 0, end: startOf(1), preamble });
for (let g = 0; g < groups.length; g++) {
  const grp = groups[g];
  const start = startOf(grp[0].number);
  const end = g + 1 < groups.length ? startOf(groups[g + 1][0].number) : timings.duration;
  slides.push({ kind: 'verses', start, end, verses: grp });
}

// ---- HTML ----
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// join a verse's devanagari half-lines into one line
const devLine = (v) => v.dev.join(' ');

function htmlFor(slide) {
  let title = '\u2016 \u015Br\u012B dev\u012B m\u0101hatmyam \u2016<br>\u2016 dev\u012B kavacam \u2016';
  let body = '';
  if (slide.kind === 'preamble') {
    const dev = slide.preamble.dev.map((l, idx) => `<div class="pline" data-pline="${idx}">${esc(l)}</div>`).join('');
    const eng = slide.preamble.eng.map((l) => `<div class="pline eng">${esc(l)}</div>`).join('');
    body = `<div class="dev preamble">${dev}</div><div class="iast preamble">${eng}</div>`;
  } else {
    const devBlocks = slide.verses.map((v) => {
      const sp = v.speaker && v.speaker.dev ? `<div class="speaker">${esc(v.speaker.dev)}</div>` : '';
      return `${sp}<div class="dline" data-verse="${v.number}">${esc(devLine(v))}</div>`;
    }).join('');
    const iastBlocks = slide.verses.map((v) => {
      const sp = v.speaker && v.speaker.eng ? `<div class="speaker eng">${esc(v.speaker.eng)}</div>` : '';
      const lines = v.eng.map((l) => `<div class="iline">${esc(l)}</div>`).join('');
      return `${sp}${lines}`;
    }).join('');
    body = `<div class="dev">${devBlocks}</div><div class="iast">${iastBlocks}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Deva';src:url('./assets/sanskrit2003.ttf');}
@font-face{font-family:'Serif';src:url('./assets/serif.ttf');font-weight:normal;}
@font-face{font-family:'Serif';src:url('./assets/serif-bold.ttf');font-weight:bold;}
@font-face{font-family:'Serif';src:url('./assets/serif-italic.ttf');font-style:italic;}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1920px;height:1080px;overflow:hidden;}
body{background:url('./assets/bg.png') no-repeat center/cover;position:relative;}
:root{--scale:1;}
.title{position:absolute;top:64px;left:0;right:0;text-align:center;font-family:'Serif';font-weight:bold;
  color:#241203;font-size:62px;line-height:1.28;letter-spacing:.5px;}
.content{position:absolute;top:300px;left:70px;right:70px;bottom:56px;display:flex;flex-direction:column;
  justify-content:center;align-items:center;gap:calc(38px*var(--scale));}
.dev{display:flex;flex-direction:column;align-items:center;gap:calc(14px*var(--scale));width:100%;}
.iast{display:flex;flex-direction:column;align-items:center;gap:calc(6px*var(--scale));width:100%;}
.dline{font-family:'Deva';color:#20140a;font-size:calc(52px*var(--scale));
  line-height:1.55;white-space:nowrap;}
.iline{font-family:'Serif';color:#3a2716;font-size:calc(33px*var(--scale));line-height:1.36;white-space:nowrap;}
.speaker{font-family:'Deva';color:#5a3a1e;font-size:calc(33px*var(--scale));margin-top:calc(8px*var(--scale));}
.speaker.eng{font-family:'Serif';font-style:italic;font-size:calc(26px*var(--scale));}
.preamble .pline{font-family:'Deva';color:#20140a;font-size:calc(38px*var(--scale));line-height:1.55;white-space:normal;text-align:center;max-width:1720px;}
.preamble.iast .pline{font-family:'Serif';color:#3a2716;font-size:calc(26px*var(--scale));line-height:1.4;}
.preamble .pline.eng{font-family:'Serif';}
</style></head><body>
<div class="title">${title}</div>
<div class="content">${body}</div>
<script>
(function(){
  var c=document.querySelector('.content');
  function overflow(){
    if(c.scrollHeight>c.clientHeight+1||c.scrollWidth>c.clientWidth+1)return true;
    var el=c.querySelectorAll('.dline,.iline,.pline');
    for(var i=0;i<el.length;i++){if(el[i].scrollWidth>el[i].clientWidth+1)return true;}
    return false;
  }
  var s=1;var n=0;
  while(overflow()&&s>0.55&&n<60){s-=0.02;document.documentElement.style.setProperty('--scale',s.toFixed(3));n++;}
  document.documentElement.setAttribute('data-scale',s.toFixed(3));
  var boxes=[];
  c.querySelectorAll('.dline').forEach(function(el){
    var r=el.getBoundingClientRect();
    boxes.push({v:+el.getAttribute('data-verse'),x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)});
  });
  document.documentElement.setAttribute('data-boxes', JSON.stringify(boxes));
  var pboxes=[];
  c.querySelectorAll('.dev.preamble .pline').forEach(function(el){
    var r=el.getBoundingClientRect();
    pboxes.push({p:+el.getAttribute('data-pline'),x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)});
  });
  document.documentElement.setAttribute('data-pboxes', JSON.stringify(pboxes));
})();
</script>
</body></html>`;
}

fs.mkdirSync(RENDER, { recursive: true });
fs.mkdirSync(path.join(OUTDIR, 'slides'), { recursive: true });

function measure(htmlPath) {
  const r = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', '--dump-dom', '--force-device-scale-factor=1',
    '--virtual-time-budget=1500', `file:///${htmlPath.replace(/\\/g, '/')}`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const dom = r.stdout || '';
  const parse = (re) => {
    const m = dom.match(re);
    if (!m) return [];
    try { return JSON.parse(m[1].replace(/&quot;/g, '"')); } catch { return []; }
  };
  return { lines: parse(/data-boxes="([^"]*)"/), plines: parse(/data-pboxes="([^"]*)"/) };
}

const manifest = [];
for (let i = 0; i < slides.length; i++) {
  const name = `slide${String(i).padStart(3, '0')}`;
  const htmlPath = path.join(RENDER, `${name}.html`);
  fs.writeFileSync(htmlPath, htmlFor(slides[i]), 'utf8');
  const png = path.join(OUTDIR, 'slides', `${name}.png`);
  const verses = slides[i].kind === 'verses' ? slides[i].verses.map((v) => v.number) : [];
  manifest.push({ index: i, name, html: htmlPath, png, start: slides[i].start, end: slides[i].end, kind: slides[i].kind, verses, lines: [], plines: [] });
}
console.log(`slides: ${slides.length} (1 preamble + ${groups.length} verse groups)`);
console.log('groups:', groups.map((g) => g.map((v) => v.number).join('-')).join('  '));

if (noShot) {
  fs.writeFileSync(path.join(OUTDIR, 'slides.json'), JSON.stringify({ duration: timings.duration, slides: manifest }, null, 2), 'utf8');
  process.exit(0);
}

const indices = onlyArg !== null ? [Number(onlyArg)] : manifest.map((m) => m.index);
for (const i of indices) {
  const m = manifest[i];
  const mm = measure(m.html);
  m.lines = mm.lines; m.plines = mm.plines;
  const r = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', `--screenshot=${m.png}`, '--window-size=1920,1080',
    '--force-device-scale-factor=1', '--hide-scrollbars', '--default-background-color=00000000',
    '--virtual-time-budget=1500', `file:///${m.html.replace(/\\/g, '/')}`,
  ], { stdio: 'pipe', windowsHide: true, timeout: 60000 });
  const ok = fs.existsSync(m.png);
  console.log(`${m.name} [${m.kind}] ${m.start.toFixed(1)}-${m.end.toFixed(1)}s lines=${m.lines.length} ${ok ? 'OK' : 'FAIL ' + r.status}`);
}
fs.writeFileSync(path.join(OUTDIR, 'slides.json'), JSON.stringify({ duration: timings.duration, slides: manifest }, null, 2), 'utf8');
