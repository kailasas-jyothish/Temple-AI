// @ts-check
// The underline as an ASS/libass subtitle overlay (replaces the old single
// drawbox+sendcmd hack — see render.js history). libass is the battle-tested
// karaoke/subtitle renderer already inside ffmpeg's `ass` filter, so instead of
// nudging one rectangle with sendcmd we hand it real animation primitives:
//   - `\move` glides the bar smoothly along a line (libass tweens it per frame,
//     not in the 4 coarse steps sendcmd could afford);
//   - `\t(\fscx…)` resizes it to the next word's width during that same glide;
//   - `\blur` + a translucent `\1a` make it soft and light rather than a hard
//     bar "running around" the screen (the user's words);
//   - a second layer-0 event gives a real halo glow — the thing a single
//     drawbox could never do.
// The bar is a `\p1` vector drawing, so no glyph shaping is involved here; the
// Devanagari/serif text still comes from the Chromium slide PNGs underneath.
//
// Coordinates are 1:1 with the video: PlayResX/Y = the frame size, so a word's
// measured pixel box maps straight onto `\pos`/`\move`/drawing units.

const NATIVE_W = 100; // the drawing is 100 units wide; \fscx=<px> scales it to <px>

const pad2 = (n) => String(n).padStart(2, '0');
// ASS timestamps are H:MM:SS.cs (centiseconds), rounding up any cs overflow.
export function assTime(seconds) {
  const s = Math.max(0, seconds);
  let cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000); cs -= h * 360000;
  const m = Math.floor(cs / 6000); cs -= m * 6000;
  const sec = Math.floor(cs / 100); cs -= sec * 100;
  return `${h}:${pad2(m)}:${pad2(sec)}.${pad2(cs)}`;
}
// libass colour is &HBBGGRR& and alpha is &HAA& with AA=00 opaque … FF clear.
export function assBGR(hex6) {
  const h = hex6.replace('#', '');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
export function assAlpha(opacity) {
  const a = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)));
  return `&H${pad2(a.toString(16))}&`.toUpperCase();
}

/**
 * Build the .ass overlay for a whole video from ordered underline targets.
 * Each target is a word's placed underline: x/y are the top-left of the bar
 * (y already sits gap-below the word), w is its width.
 * @param {{t:number,end:number,x:number,y:number,w:number,slide:number,li:number}[]} targets
 * @param {{colorHex:string,opacity:number,thicknessPx:number,halo:boolean,motion:string,glideMs:number,playW?:number,playH?:number,duration:number}} opts
 * @returns {string}
 */
export function buildAssUnderline(targets, opts) {
  const playW = opts.playW ?? 1920;
  const playH = opts.playH ?? 1080;
  const glide = opts.motion === 'glide';
  const g = Math.max(0, Math.round(opts.glideMs));            // glide ms
  const fade = Math.max(60, Math.min(140, Math.round(opts.glideMs * 0.7)));
  const H = Math.max(1, Math.round(opts.thicknessPx));        // core bar height
  const fill = `\\1c${assBGR(opts.colorHex)}\\1a${assAlpha(opts.opacity)}`;
  const drawing = (h) => `m 0 0 l ${NATIVE_W} 0 l ${NATIVE_W} ${h} l 0 ${h}`;

  const sameGroup = (a, b) => glide && a && b && a.slide === b.slide && a.li === b.li;
  const dur = opts.duration;
  /** @type {string[]} */
  const events = [];

  for (let i = 0; i < targets.length; i++) {
    const cur = targets[i];
    const prev = targets[i - 1];
    const next = targets[i + 1];
    const firstIn = !sameGroup(prev, cur);
    const lastIn = !sameGroup(cur, next);

    const x = Math.round(cur.x);
    const y = Math.round(cur.y);
    const w = Math.max(2, Math.round(cur.w));
    // Live from this word's start to the next word's start (so the line flows
    // without a gap), but a line's final word fades out after its own end
    // rather than lingering across the slide crossfade to the next line.
    const start = cur.t;
    let end = lastIn ? cur.end : (next ? next.t : cur.end);
    end = Math.min(dur, Math.max(end, start + 0.08)); // never zero-length
    const fadeIn = firstIn ? fade : 0;
    const fadeOut = lastIn ? fade : 0;

    let pos;
    if (!firstIn) {
      // glide + resize from the previous word into this one over `g` ms
      const px = Math.round(prev.x);
      const pw = Math.max(2, Math.round(prev.w));
      pos = `\\move(${px},${y},${x},${y},0,${g})\\fscx${pw}\\t(0,${g},\\fscx${w})`;
    } else {
      pos = `\\pos(${x},${y})\\fscx${w}`;
    }
    const ov = `\\an7${pos}${fill}\\blur1.4\\fad(${fadeIn},${fadeOut})\\p1`;
    events.push(`Dialogue: 1,${assTime(start)},${assTime(end)},U,,0,0,0,,{${ov}}${drawing(H)}`);

    if (opts.halo) {
      // A soft glow one layer below: taller, blurrier, and more transparent,
      // sitting a few px above so it haloes both edges of the core line.
      const hy = y - 3;
      const hpos = firstIn
        ? `\\pos(${x},${hy})\\fscx${w}`
        : `\\move(${Math.round(prev.x)},${hy},${x},${hy},0,${g})\\fscx${Math.max(2, Math.round(prev.w))}\\t(0,${g},\\fscx${w})`;
      const hov = `\\an7${hpos}\\1c${assBGR(opts.colorHex)}\\1a${assAlpha(opts.opacity * 0.45)}\\blur5\\fad(${fadeIn},${fadeOut})\\p1`;
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},U,,0,0,0,,{${hov}}${drawing(H + 6)}`);
    }
  }

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playW}`,
    `PlayResY: ${playH}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: U,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  return header.concat(events).join('\n') + '\n';
}
