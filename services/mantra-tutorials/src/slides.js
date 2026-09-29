// @ts-check
// Stage 4 — group verses into slides, render each to a 1920x1080 PNG in a
// headless browser (for correct Devanagari shaping), and measure the on-screen
// box of every transliteration *word* (handover §6.2) so the underline can sit
// exactly under the word being chanted. Text colour comes from the derived
// theme, so the type stays legible on whatever background the user supplied.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { segmentLine } from './tokens.js';
import { writeHtml, screenshot, dumpData } from './browser.js';
import { log } from './log.js';
import { config } from './config.js';

// Verses per slide decides the type size: the fit search below grows the text
// until the slide is full, so fewer verses means bigger letters. A bundle can
// set its own (`versesPerSlide` in mantra.json); the reference videos use 1.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render one transliteration line as HTML, wrapping words in measurable spans. */
function iastLineHtml(line, verse, li) {
  let wi = 0;
  const parts = [];
  for (const seg of segmentLine(line)) {
    if (seg.word) { parts.push(`<span class="w" data-v="${verse}" data-li="${li}" data-wi="${wi}">${esc(seg.text)}</span>`); wi++; }
    else parts.push(esc(seg.text));
  }
  return parts.join(' ');
}

/** The speaker's transliteration ("mārkaṇḍeya uvāca"), measurable like a verse line. */
function speakerEngHtml(line, verse) {
  let wi = 0;
  const parts = [];
  for (const seg of segmentLine(line)) {
    if (seg.word) { parts.push(`<span class="sw" data-v="${verse}" data-wi="${wi}">${esc(seg.text)}</span>`); wi++; }
    else parts.push(esc(seg.text));
  }
  return parts.join(' ');
}

function preambleLineHtml(line, p, cls) {
  let wi = 0;
  const parts = [];
  for (const seg of segmentLine(line)) {
    if (seg.word) { parts.push(`<span class="${cls}" data-p="${p}" data-wi="${wi}">${esc(seg.text)}</span>`); wi++; }
    else parts.push(esc(seg.text));
  }
  return parts.join(' ');
}

/** A counter-carrying renderer for one verse's Devanagari lines. gi runs across
 *  the whole verse so it matches the token's `gi` from align.js — the underline
 *  can then track the Devanagari word when target='dev'. */
function devWords(verse) {
  let gi = 0;
  return (text) => {
    const parts = [];
    for (const seg of segmentLine(text)) {
      if (seg.word) { parts.push(`<span class="dw" data-v="${verse}" data-gi="${gi}">${esc(seg.text)}</span>`); gi++; }
      else parts.push(esc(seg.text));
    }
    return parts.join(' ');
  };
}

/** The reference layout: each Devanagari half-line directly above its own
 *  transliteration, so an underline under the IAST reads as marking both. Needs
 *  the two scripts to have the same line count, which all but malformed verses do. */
function pairedVerseHtml(v) {
  const dev = devWords(v.number);
  const sp = v.speaker && (v.speaker.dev || v.speaker.eng)
    ? `<div class="speaker">${esc(v.speaker.dev || '')}${v.speaker.eng ? ` <span class="eng">${speakerEngHtml(v.speaker.eng, v.number)}</span>` : ''}</div>` : '';
  const pairs = v.eng.map((l, li) => `<div class="pair"><div class="pdev">${dev(v.dev[li])}</div><div class="iline">${iastLineHtml(l, v.number, li)}</div></div>`).join('');
  return `${sp}<div class="verse">${pairs}</div>`;
}

function devLineHtml(devLines, verse) {
  const line = devWords(verse);
  // 'source': one on-screen line per source line (the half-lines as written),
  // which halves the widest line and lets the text grow. 'joined': the whole
  // verse on one line, the original layout.
  if (config.devLayout === 'source') return devLines.map((l) => `<div class="dsub">${line(l)}</div>`).join('');
  return line(devLines.join(' '));
}

function fontFace(family, file, weight, style) {
  const url = file.replace(/\\/g, '/');
  return `@font-face{font-family:'${family}';src:url('file:///${url}');`
    + (weight ? `font-weight:${weight};` : '') + (style ? `font-style:${style};` : '') + '}';
}

function meaningHtml(slide, showMeaning) {
  if (!showMeaning) return '';
  const ml = slide.verses.flatMap((v) => v.meaning || []);
  return ml.length ? `<div class="meaning">${ml.map((l) => `<div class="mline">${esc(l)}</div>`).join('')}</div>` : '';
}

/** @param {any} slide @param {any} ctx  ctx.fixedScale renders at that scale instead of fitting. */
export function htmlFor(slide, ctx) {
  const { title, fonts, theme, bg, showMeaning } = ctx;
  const area = ctx.textArea || { left: 70, right: 70, top: 64, bottom: 56 };
  let body = '';
  const pre = slide.preamble;
  if (slide.kind === 'preamble' && pre.dev.length === pre.eng.length) {
    const pairs = pre.eng.map((l, idx) => `<div class="pair"><div class="pdev">${preambleLineHtml(pre.dev[idx], idx, 'pdw')}</div><div class="iline">${preambleLineHtml(l, idx, 'pw')}</div></div>`).join('');
    // Preamble lines are prose (one runs ~120 characters), so they may wrap;
    // held to one row, that line alone shrank the preamble to half size.
    body = `<div class="verse wrap">${pairs}</div>`;
  } else if (slide.kind === 'preamble') {
    const dev = pre.dev.map((l, idx) => `<div class="pline" data-pline="${idx}">${preambleLineHtml(l, idx, 'pdw')}</div>`).join('');
    const eng = pre.eng.map((l, idx) => `<div class="pline eng">${preambleLineHtml(l, idx, 'pw')}</div>`).join('');
    body = `<div class="dev preamble">${dev}</div><div class="iast preamble">${eng}</div>`;
  } else if (slide.verses.every((v) => v.dev.length === v.eng.length)) {
    body = slide.verses.map(pairedVerseHtml).join('') + meaningHtml(slide, showMeaning);
  } else {
    const dev = slide.verses.map((v) => {
      const sp = v.speaker && v.speaker.dev ? `<div class="speaker">${esc(v.speaker.dev)}</div>` : '';
      return `${sp}<div class="dline" data-verse="${v.number}">${devLineHtml(v.dev, v.number)}</div>`;
    }).join('');
    const iast = slide.verses.map((v) => {
      const sp = v.speaker && v.speaker.eng ? `<div class="speaker eng">${speakerEngHtml(v.speaker.eng, v.number)}</div>` : '';
      const lines = v.eng.map((l, li) => `<div class="iline">${iastLineHtml(l, v.number, li)}</div>`).join('');
      return `${sp}${lines}`;
    }).join('');
    body = `<div class="dev">${dev}</div><div class="iast">${iast}</div>${meaningHtml(slide, showMeaning)}`;
  }
  const titleHtml = title ? `<div class="title">${title.split(/\n/).map(esc).join('<br>')}</div>` : '';
  const contentTop = area.top + (title ? 236 : 96);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace('Deva', fonts.devanagari)}
${fontFace('Serif', fonts.serif, 'normal')}
${fontFace('Serif', fonts.serifBold, 'bold')}
${fontFace('Serif', fonts.serifItalic, '', 'italic')}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1920px;height:1080px;overflow:hidden;}
body{background:url('file:///${bg.replace(/\\/g, '/')}') no-repeat center/cover;position:relative;
  --deva:${theme.text};--iast:${theme.text};--accent:${theme.accent};}
:root{--scale:1;}
.title{position:absolute;top:${area.top}px;left:${area.left}px;right:${area.right}px;text-align:center;font-family:'Serif';font-weight:bold;
  color:var(--deva);font-size:58px;line-height:1.28;letter-spacing:.5px;}
.content{position:absolute;top:${contentTop}px;left:${area.left}px;right:${area.right}px;bottom:${area.bottom}px;display:flex;flex-direction:column;
  justify-content:center;align-items:center;gap:calc(38px*var(--scale));}
.dev{display:flex;flex-direction:column;align-items:center;gap:calc(14px*var(--scale));width:100%;}
.iast{display:flex;flex-direction:column;align-items:center;gap:calc(6px*var(--scale));width:100%;}
.dline{font-family:'Deva';color:var(--deva);font-size:calc(52px*var(--scale));line-height:1.55;white-space:nowrap;}
.iline{font-family:'Serif';color:var(--iast);font-size:calc(33px*var(--scale));line-height:1.36;white-space:nowrap;}
.iline .w{display:inline-block;}
.dline .dw{display:inline-block;}
.dline .dsub{white-space:nowrap;text-align:center;}
.speaker{font-family:'Deva';color:var(--accent);font-size:calc(33px*var(--scale));margin-top:calc(8px*var(--scale));white-space:nowrap;}
.speaker.eng{font-family:'Serif';font-style:italic;font-size:calc(26px*var(--scale));}
.meaning{margin-top:calc(26px*var(--scale));display:flex;flex-direction:column;align-items:center;gap:2px;}
.mline{font-family:'Serif';color:var(--iast);opacity:.92;font-size:calc(28px*var(--scale));line-height:1.34;text-align:center;}
.preamble .pline{font-family:'Deva';color:var(--deva);font-size:calc(38px*var(--scale));line-height:1.55;white-space:nowrap;text-align:center;}
.preamble.iast .pline{font-family:'Serif';color:var(--iast);font-size:calc(26px*var(--scale));line-height:1.4;}
.preamble .pw{display:inline-block;}
.preamble .pdw{display:inline-block;}
.verse{display:flex;flex-direction:column;align-items:center;gap:calc(30px*var(--scale));width:100%;}
.pair{display:flex;flex-direction:column;align-items:center;}
.pdev{font-family:'Deva';color:var(--deva);font-size:calc(62px*var(--scale));line-height:1.32;white-space:nowrap;}
.pdev .dw,.pdev .pdw,.pair .iline .pw{display:inline-block;}
.pair .iline{font-size:calc(40px*var(--scale));line-height:1.22;}
/* Paired layout: the speaker line reads like the verse — same ink, near-verse
   size. It used to be the accent colour at half size, which on the parchment
   was ~3:1 and all but vanished. */
.content > .speaker{color:var(--deva);font-size:calc(52px*var(--scale));line-height:1.3;}
.speaker .eng{font-family:'Serif';font-style:italic;font-size:.72em;margin-left:.3em;}
.speaker .sw{display:inline-block;}
.verse.wrap .pdev,.verse.wrap .iline{white-space:normal;text-align:center;max-width:100%;}
.bl{display:inline-block;width:0;height:0;vertical-align:baseline;}
</style></head><body>
${titleHtml}
<div class="content">${body}</div>
<script>
// Measure only once the web fonts are in: measured against a fallback face, a
// wrapped line broke in a different place than in the screenshot.
document.fonts.ready.then(function(){
  var c=document.querySelector('.content');
  var cr=c.getBoundingClientRect();
  function overflow(){
    if(c.scrollHeight>c.clientHeight+1||c.scrollWidth>c.clientWidth+1)return true;
    // centred flex content overflows upwards too, which scrollHeight misses
    var kids=c.children;
    for(var k=0;k<kids.length;k++){var r=kids[k].getBoundingClientRect();if(r.top<cr.top-1||r.bottom>cr.bottom+1)return true;}
    var el=c.querySelectorAll('.dline,.iline,.pline,.pdev,.speaker');
    for(var i=0;i<el.length;i++){var b=el[i].getBoundingClientRect();if(el[i].scrollWidth>el[i].clientWidth+1||b.left<cr.left-1||b.right>cr.right+1)return true;}
    return false;
  }
  // Text as large as the slide allows: binary-search the biggest scale at which
  // nothing overflows. Every line is nowrap, so growing the type never re-wraps
  // a verse; the source line breaks are kept exactly. A fixed scale (the smallest
  // fit across the whole mantra, see buildSlides) keeps one type size throughout.
  function setS(v){document.documentElement.style.setProperty('--scale',v.toFixed(3));}
  var FIXED=${Number(ctx.fixedScale) || 0};
  var s=FIXED;
  if(!s){
    var lo=0.3,hi=3;
    for(var n=0;n<22;n++){var mid=(lo+hi)/2;setS(mid);if(overflow())hi=mid;else lo=mid;}
    s=Math.floor(lo*1000)/1000;
  }
  setS(s);
  document.documentElement.setAttribute('data-scale',s.toFixed(3));
  // base = the glyph baseline, read off a zero-size probe; the word box's own
  // bottom includes line leading, which put the underline halfway to the next line.
  function boxesOf(sel,attrs){
    var out=[];
    c.querySelectorAll(sel).forEach(function(el){
      var r=el.getBoundingClientRect(); var o={x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};
      var p=document.createElement('i');p.className='bl';el.appendChild(p);
      o.base=Math.round(p.getBoundingClientRect().top);el.removeChild(p);
      o.fs=Math.round(parseFloat(getComputedStyle(el).fontSize));
      attrs.forEach(function(a){o[a]=+el.getAttribute('data-'+a);}); out.push(o);
    });
    return out;
  }
  document.documentElement.setAttribute('data-words', JSON.stringify(boxesOf('.iline .w',['v','li','wi'])));
  document.documentElement.setAttribute('data-pwords', JSON.stringify(boxesOf('.pw',['p','wi'])));
  document.documentElement.setAttribute('data-dwords', JSON.stringify(boxesOf('.dw',['v','gi'])));
  document.documentElement.setAttribute('data-pdwords', JSON.stringify(boxesOf('.pdw',['p','wi'])));
  document.documentElement.setAttribute('data-swords', JSON.stringify(boxesOf('.sw',['v','wi'])));
});
</script></body></html>`;
}

/**
 * @param {ReturnType<import('./extract.js').extract>} extracted
 * @param {ReturnType<import('./align.js').align>} timings
 * @param {{accent:string,text:string}} theme
 * @param {import('./mantra.js').Mantra} mantra
 * @param {string} outDir
 * @param {{ noShot?: boolean, only?: (i:number, s:{start:number,end:number})=>boolean }} [opts]
 *   only: screenshot just the slides it accepts (sample renders); the rest are
 *   still measured, because the shared type size depends on every slide.
 */
export function buildSlides(extracted, timings, theme, mantra, outDir, opts = {}) {
  const startByNumber = new Map(timings.verses.map((v) => [v.number, v.start]));
  const startOf = (n) => startByNumber.get(n) ?? 0;
  const MAX_VERSES = mantra.versesPerSlide || config.versesPerSlide;
  const MAX_ENG_LINES = 2 * MAX_VERSES;

  // group verses by size / translit-line budget
  const groups = [];
  let cur = [];
  let engLines = 0;
  for (const v of extracted.verses) {
    const add = v.eng.length;
    if (cur.length && (cur.length >= MAX_VERSES || engLines + add > MAX_ENG_LINES)) { groups.push(cur); cur = []; engLines = 0; }
    cur.push(v); engLines += add;
  }
  if (cur.length) groups.push(cur);

  const slides = [];
  const firstVerseStart = extracted.verses.length ? startOf(extracted.verses[0].number) : timings.duration;
  slides.push({ kind: 'preamble', start: 0, end: firstVerseStart, preamble: extracted.preamble });
  for (let g = 0; g < groups.length; g++) {
    const start = startOf(groups[g][0].number);
    const end = g + 1 < groups.length ? startOf(groups[g + 1][0].number) : timings.duration;
    slides.push({ kind: 'verses', start, end, verses: groups[g] });
  }

  const renderDir = path.join(outDir, 'render');
  const slidesDir = path.join(outDir, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  const ctx = { title: extracted.title, fonts: mantra.fonts, theme, bg: mantra.background, showMeaning: mantra.showMeaning, textArea: mantra.textArea };

  // One type size for the whole mantra: fit every slide on its own, then render
  // all of them at the smallest of those fits — the largest size at which every
  // slide still fits. Per-slide fitting made the letters jump from verse to verse.
  // The preamble (several lines under the title) is not held to the verses'
  // size: it takes its own fit, capped so it is never larger than the verses.
  let scales = slides.map(() => 0);
  if (!opts.noShot && mantra.uniformScale !== false) {
    const cachePath = path.join(renderDir, 'fits.json');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
    const fits = slides.map((s, i) => {
      const html = htmlFor(s, ctx);
      const key = crypto.createHash('sha1').update(html).digest('hex');
      if (!cache[key]) {
        const p = writeHtml(renderDir, `fit${String(i).padStart(3, '0')}.html`, html);
        cache[key] = Number(dumpData(p, ['data-scale'])['data-scale']) || 1;
      }
      return cache[key];
    });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
    const verseFits = fits.filter((_, i) => slides[i].kind === 'verses');
    const uniform = verseFits.length ? Math.min(...verseFits) : Math.min(...fits);
    scales = fits.map((f, i) => (slides[i].kind === 'verses' ? uniform : Math.min(f, uniform)));
    const sorted = [...verseFits].sort((a, b) => a - b);
    log('slides', `uniform verse scale ${uniform} (tightest slide ${fits.indexOf(uniform)}; verse fits ${sorted.slice(0, 5).join(', ')} … ${sorted[sorted.length - 1]}); preamble ${scales[0]}`);
  }

  const manifest = [];
  for (let i = 0; i < slides.length; i++) {
    const name = `slide${String(i).padStart(3, '0')}`;
    const htmlPath = writeHtml(renderDir, `${name}.html`, htmlFor(slides[i], { ...ctx, fixedScale: scales[i] }));
    const wanted = !opts.only || opts.only(i, slides[i]);
    const png = path.join(slidesDir, `${name}.png`);
    const entry = {
      index: i, name, html: htmlPath, png, start: slides[i].start, end: slides[i].end,
      kind: slides[i].kind, verses: slides[i].kind === 'verses' ? slides[i].verses.map((v) => v.number) : [],
      words: [], pwords: [], dwords: [], pdwords: [], swords: [], scale: 1,
    };
    if (!opts.noShot && wanted) {
      const measured = dumpData(htmlPath, ['data-words', 'data-pwords', 'data-dwords', 'data-pdwords', 'data-swords', 'data-scale']);
      entry.swords = measured['data-swords'] || [];
      entry.words = measured['data-words'] || [];
      entry.pwords = measured['data-pwords'] || [];
      entry.dwords = measured['data-dwords'] || [];
      entry.pdwords = measured['data-pdwords'] || [];
      entry.scale = Number(measured['data-scale']) || 1;
      screenshot(htmlPath, png);
    }
    manifest.push(entry);
    if (!opts.noShot && wanted) log('slides', `${name} [${entry.kind}] ${entry.start.toFixed(1)}-${entry.end.toFixed(1)}s translit=${entry.words.length || entry.pwords.length} dev=${entry.dwords.length || entry.pdwords.length} scale=${entry.scale}`);
  }

  const out = { duration: timings.duration, slides: manifest };
  fs.writeFileSync(path.join(outDir, 'slides.json'), JSON.stringify(out, null, 2), 'utf8');
  log('slides', `${slides.length} slides (1 preamble + ${groups.length} groups): ${groups.map((g) => g.map((v) => v.number).join('-')).join(' ')}`);
  return out;
}
