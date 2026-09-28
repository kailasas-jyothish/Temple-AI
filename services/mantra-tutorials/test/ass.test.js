// The ASS underline overlay (src/ass.js) replaced the drawbox+sendcmd hack.
// These pin the encoding facts libass depends on — colour is &HBBGGRR&, alpha is
// inverse (00 opaque), timestamps are centiseconds — and the two animation
// shapes: a first-in-group word is a static \pos, a following word glides with
// \move + \t(\fscx). A drift in any of these silently breaks the overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assTime, assBGR, assAlpha, buildAssUnderline } from '../src/ass.js';

test('assTime formats H:MM:SS.cs and rounds to centiseconds', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(1.5), '0:00:01.50');
  assert.equal(assTime(61.239), '0:01:01.24'); // 0.239 -> 24 cs
  assert.equal(assTime(3661.005), '1:01:01.01'); // hours roll over
  assert.equal(assTime(-3), '0:00:00.00'); // negatives clamp
});

test('assBGR reverses #RRGGBB to &HBBGGRR&', () => {
  assert.equal(assBGR('#8f6b2f'), '&H2F6B8F&');
  assert.equal(assBGR('ce7a1f'), '&H1F7ACE&'); // '#'-less input
  assert.equal(assBGR('#ffffff'), '&HFFFFFF&');
});

test('assAlpha is inverse opacity (00 opaque, FF clear)', () => {
  assert.equal(assAlpha(1), '&H00&');
  assert.equal(assAlpha(0), '&HFF&');
  assert.equal(assAlpha(0.85), '&H26&'); // (1-0.85)*255 = 38.25 -> 26
});

const opts = {
  colorHex: '#8f6b2f', opacity: 0.85, thicknessPx: 4, halo: false,
  motion: 'glide', glideMs: 140, playW: 1920, playH: 1080, duration: 4,
};

test('the header carries PlayRes matching the video and one Events section', () => {
  const ass = buildAssUnderline([], opts);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /PlayResY: 1080/);
  assert.match(ass, /\[Events\]/);
  // no targets -> no Dialogue lines
  assert.equal((ass.match(/^Dialogue:/gm) || []).length, 0);
});

test('a lone word is a static \\pos with the colour, alpha and a fade in+out', () => {
  const ass = buildAssUnderline([{ t: 1, end: 2, x: 400, y: 616, w: 120, slide: 0, li: 0 }], opts);
  const line = (ass.match(/^Dialogue:.*$/gm) || [])[0];
  assert.ok(line, 'one dialogue line');
  assert.match(line, /\\pos\(400,616\)/);
  assert.match(line, /\\fscx120/);            // \fscx = pixel width
  assert.match(line, /\\1c&H2F6B8F&/);        // BGR fill
  assert.match(line, /\\1a&H26&/);            // 0.85 opacity
  assert.match(line, /\\fad\(\d+,\d+\)/);     // fades in and out
  assert.match(line, /m 0 0 l 100 0 l 100 4 l 0 4$/); // 100-wide, 4px tall drawing
});

test('a following word on the same line glides and resizes, no fade between', () => {
  const targets = [
    { t: 0, end: 0.5, x: 400, y: 616, w: 120, slide: 0, li: 0 },
    { t: 0.5, end: 1.0, x: 540, y: 616, w: 200, slide: 0, li: 0 },
  ];
  const lines = buildAssUnderline(targets, opts).match(/^Dialogue:.*$/gm);
  const second = lines[1];
  assert.match(second, /\\move\(400,616,540,616,0,140\)/); // glides from prev x
  assert.match(second, /\\fscx120\\t\(0,140,\\fscx200\)/); // width tweens 120 -> 200
  assert.match(second, /\\fad\(0,\d+\)/); // no fade-in (mid-line), fade-out at line end
});

test('halo adds a second, softer layer-0 event per word', () => {
  const one = buildAssUnderline([{ t: 1, end: 2, x: 400, y: 616, w: 120, slide: 0, li: 0 }], { ...opts, halo: true });
  const lines = one.match(/^Dialogue:.*$/gm);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.startsWith('Dialogue: 0,')), 'a layer-0 glow');
  assert.ok(lines.some((l) => l.startsWith('Dialogue: 1,')), 'the core bar on layer 1');
  const halo = lines.find((l) => l.startsWith('Dialogue: 0,'));
  assert.match(halo, /\\blur5/);      // blurrier than the core \blur1.4
  assert.match(halo, /m 0 0 l 100 0 l 100 10 l 0 10$/); // taller (4+6)
});

test('an outlineHex adds a contrasting border (\\bord + \\3c + \\3a) to the core bar', () => {
  const withOutline = buildAssUnderline(
    [{ t: 1, end: 2, x: 400, y: 616, w: 120, slide: 0, li: 0 }],
    { ...opts, outlineHex: '#1a1206' },
  );
  const core = (withOutline.match(/^Dialogue: 1,.*$/gm) || [])[0];
  assert.match(core, /\\bord[1-9]/);           // a real border, not \bord0
  assert.match(core, /\\3c&H06121A&/);         // outline colour, BGR-reversed
  assert.match(core, /\\3a&H[0-9A-F]{2}&/);    // outline alpha
  // absent outlineHex -> no border drawn
  const none = buildAssUnderline([{ t: 1, end: 2, x: 400, y: 616, w: 120, slide: 0, li: 0 }], opts);
  assert.match((none.match(/^Dialogue: 1,.*$/gm) || [])[0], /\\bord0/);
});

test('a line\'s last word ends at its own end, not the next line\'s start', () => {
  const targets = [
    { t: 0, end: 0.5, x: 400, y: 616, w: 120, slide: 0, li: 0 }, // line 0, last word
    { t: 3.0, end: 3.6, x: 500, y: 776, w: 320, slide: 0, li: 1 }, // line 1
  ];
  const lines = buildAssUnderline(targets, opts).match(/^Dialogue:.*$/gm);
  // first word is alone on its line -> ends at 0.5 (its .end), fades out
  assert.match(lines[0], /0:00:00\.00,0:00:00\.50/);
});
