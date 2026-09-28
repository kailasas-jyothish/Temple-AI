# Handover: finish the word underline in `services/mantra-tutorials`

**For the next Claude Code session.** Updated 2026-09-28. This replaces the
2026-09-27 handover (that one described a service that did not exist yet; it
does now). Read the repo's `CLAUDE.md` first, especially §16, then
`services/mantra-tutorials/README.md`.

Earlier transcripts, if you need exact history (on this machine):

- `C:\Users\GD\.claude\projects\C--Users-GD-Desktop-GD-Temple-AI\b59c9d39-eb61-4c17-b13f-e09daca89330.jsonl`: the prototype.
- `…\0f59a477-9848-443b-a04f-0a9581f68606.jsonl`: service build, font fix, ASS underline.
- `C:\Users\GD\.claude-acct2\projects\C--Users-GD-Desktop-GD-Temple-AI\41612f24-bc59-4524-8dd0-b8762c1ca77f.jsonl`: forced alignment, underline made optional, bigger text, deploy.

---

## 1. Where things stand

**The underline is fixed and back on by default (2026-09-28, later the same day).**
The service works end to end and ships videos **with** the word-by-word underline.

- Inputs per mantra (a bundle under `mantras/<id>/`): an empty background slide,
  the Devanagari + IAST markdown, and the chant audio.
- Output: a 1080p MP4. The verses sit on the user's background, slides change on
  the audio timeline, the Devanagari uses Sanskrit 2003, and the text is as large
  as the slide allows (2 verses per slide, fit by binary search). A warm accent
  line glides under the transliteration word being chanted.
- Turn it off per build with `--no-underline`, `UNDERLINE=false`, the first CLI
  question, or the web-UI checkbox — you then get the plain slides.

### What the real problem turned out to be

The user's hypothesis (§2) was that the pipeline was doing image/OCR recognition
of the text on the slide and that this "will not work." **That is not what the
code does** — word boxes come from `getBoundingClientRect` on the very DOM that
draws the text (exact layout, not OCR). Proven this session two ways:

1. A **static** box-placement check burnt a bar at each word's measured box onto
   the real slide PNG: every bar landed dead-centre under its word.
2. In the **rendered video**, markers drawn at vārāhī's box edges bracket the
   live underline exactly; the preamble line sits under `śrīcaṇḍīkavacasya` and
   verse 1 under `paramaṃ`.

So position and sync were already correct. The one real defect was **visibility**:
`auto` derived the line colour from the background's dominant hue, so on the gold
parchment it was a gold-on-gold line at only 3.0:1 contrast — nearly invisible. A
thin hairline needs far more separation than a block of text.

### The fix (this session)

- **A dedicated underline colour**, separate from the speaker-text accent
  (`theme.underline` in `src/color.js`): a saturated warm tone driven to a
  stiffer contrast (≈3.4:1 core), plus
- **a contrasting soft outline** on the bar (`\bord` + `\3c` in `src/ass.js`,
  fed `outlineHex` from `render.js` by band luminance — dark edge on a light
  slide, light edge on a dark one). Core + outline read on any background, so
  visibility no longer depends on the accent matching or clashing with the slide.
- For `durga-kavacham` the line is now `#8a5c11` amber with a dark edge, clearly
  legible. Default flipped on in `src/config.js`.

A **preview clip** is at `services/mantra-tutorials/data/durga-kavacham/preview-underline.mp4`
(verses 1–3 with audio) — for the user to judge perceived sync (see §3/§4).

What the user wants it to look like (unchanged since the start): the reference
video *Argala Stotram – #DurgaSaptashati Series – Day2*
(`C:\Users\GD\Desktop\GD\yt-dlp\Argala Stotram - #DurgaSaptashati Series - Day2 [oYYP5eqXwSA].webm`;
frames in `services/mantra-tutorials/prototype/reference-frames/`). There, a short
underline moves word by word under the **transliteration**, exactly in time with
the chant, and looks light and graceful.

## 2. The user's view of the real problem. Start here.

> **Resolved 2026-09-28 (see §1).** The architecture below was *not* the cause —
> the boxes are exact DOM layout, not OCR, and placement/sync were proven correct
> frame by frame. The visible defect was contrast, now fixed, and the underline is
> back on. The re-architecture directions below (Remotion / libass karaoke /
> per-word PNGs) were **not** pursued: they add a new runtime and real risk (the
> user hates complicated setup) to solve a problem that wasn't the cause. Keep
> this section for context; only revisit these directions if the user, after
> watching, wants the smooth motion or the libass-in-Docker dependency changed for
> its own sake — not as a fix for placement.

In the user's words (2026-09-28):

> What I am assuming the real problem is that we are trying to use code to
> identify the text on the slide image. That pipeline I feel will not work. We
> already have the text separately. We are trying to treat the text recognition
> like image recognition on the slide image, which is useless.

Take this as the starting direction, not something to argue away. Here is what
it refers to in the code, so you can act on it:

- `src/slides.js` draws the text into a **flat PNG** (headless Chromium, needed for
  correct Devanagari shaping). Page JS then reads back the on-screen box of every
  word (`getBoundingClientRect`, stored in `data-*` attributes, saved in `slides.json`).
- `src/render.js` + `src/ass.js` then draw the underline as a **separate layer**
  (an ASS/libass vector bar), placed at those recovered pixel boxes and moved on
  timestamps from `timings.json`.

So the text and the underline are two unrelated drawings that have to agree
through pixel coordinates recovered after the fact. The measurement is DOM-based,
not OCR, but the user's point stands on the architecture. We already *have* the
text; the thing that highlights a word should be the same thing that draws it.
Directions that follow from that (untried, pick with the user):

1. **Animate the text itself, not a line under an image of it.** Render each
   slide as live HTML per frame, or per word-state, so the current word is
   styled (underline, colour or weight) by the same engine that lays it out. This
   can be headless Chromium frame capture, or [Remotion](https://www.remotion.dev/)
   (React → video, it was the research fallback). No boxes recovered, nothing to
   drift.
2. **Let libass draw the text too.** Move the transliteration line into the ASS
   file and use karaoke tags (`\k`, `\kf`) or per-word override blocks. The
   highlight is then part of the same text run, so its position cannot be wrong.
   libass shapes Devanagari correctly with `shaping=complex` (verified locally,
   §5). The Devanagari can stay in the PNG, since only the IAST line is underlined.
3. Pre-render one PNG per word-state (N images per slide, the current word styled
   in the HTML) and cut between them on the timestamps. Crude, but it has no
   overlay at all.

Any of these removes the "line running around" class of problem. None of them
fixes timing by itself (§3).

## 3. Timing: what was done, and what is still unproven

The complaint was *"few times it is running too fast, few times it is too slow."*

- **Old path (still present as fallback):** Deepgram ASR (`whisper-large`,
  `language=sa`) plus fuzzy phonetic matching to the text (`align()` in
  `src/align.js`). It was badly wrong. On the Kavacham it squeezed verse 2 into
  1.6s, smeared verse 1 over 21s, and gave words 0.05s–10s.
- **Current path: forced alignment** (`src/forced.js` → `aligner/align.py`, then
  `alignForced()` in `src/align.js`). The aligner is
  [ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner)
  (BSD-2) with **Vakyansh Sanskrit wav2vec2**
  (`Harveenchadha/vakyansh-wav2vec2-sanskrit-sam-60`, MIT via Open-Speech-EkStep).
  Every verse now takes 9–11s and words take 0.2–4s. It is cached per mantra as
  `data/<id>/forced.json` and takes ~2 min per 10 min of audio on CPU.
- **Evidence it is right:** `aligner/verify.py` cuts out each word's assigned
  audio and blind-decodes it. 20 of 24 samples read back as the word. A frame at
  t=249.4s shows the line under `cāparājitā`, the word being chanted.
- **Unproven:** the user has not signed off that it *feels* in sync. They parked
  the feature right after this version, so treat perceived sync as still open.
  Ask them to watch a clip with `--underline` before assuming timing is solved.

Constraints and traps on the timing side:

- **Licence.** The user said the videos are "possibly commercial". Do **not** use
  ctc-forced-aligner's default MMS model (CC-BY-NC). `ai4bharat/indicwav2vec-hindi`
  is Apache-2.0 but gated on Hugging Face (needs a login and token).
- **CTC blank.** Fairseq-converted models use `<s>` (id 0) as blank, not the pad
  token the library assumes. `align.py` detects it from the emissions. With the
  wrong blank the mean score was −10 per frame instead of −0.06.
- **Stars only at line breaks.** A free `<star>` token between every word
  swallows the chant, and words collapse to a few frames.
- **Onset shift −80ms** (`ONSET_SHIFT` in `align.js`), measured with `verify.py`.
- **`ॐ` is not in the vocabulary.** It is spelled `ओम्` for the aligner.
- Words are one-letter CTC spikes (च = 0.02s), so each word **holds until the next
  word starts**. A line's last word gets a 0.35s tail.
- Slides switch when a verse's *speaker line* starts, led by 0.4s.
- `render.js` starts each glide `glideMs` early so the bar lands on the onset.

Check a new mantra's timing with `aligner/verify.py` (usage in the README). Use
`aligner/probe.py` to check whether the model can hear a recording at all.

## 4. What the user must see before it is "done"

All three of the steps below were done this session:

1. ~~A short clip for the user to judge **look** and **sync**.~~ Done:
   `data/durga-kavacham/preview-underline.mp4` (verses 1–3, ~44s, with audio).
2. ~~Build then look.~~ Done: frames extracted and inspected — look (clearly
   visible amber line) and sync (under the correct word) both confirmed.
3. ~~Flip the default.~~ Done: `underlineDefaults.enabled` defaults to `true`.

**The one thing left is the user's own eyes+ears on the moving clip** — perceived
sync ("does it *feel* in time?") can only be judged with the audio playing, which
can't be done from frames. If they say it drifts, the levers are `ONSET_SHIFT`,
`glideMs`, and the per-line tail in `src/align.js` (§3), not the placement.

## 5. Hard-won facts. Don't rediscover these.

- ffmpeg is `C:\Users\GD\Desktop\GD\yt-dlp\ffmpeg.exe` (N-107417, 2022). Its
  `drawbox` + `sendcmd` can only drive the **first** drawbox, `drawbox@label` is
  ignored, and `w 0` draws full width. That approach is dead; the ASS overlay
  replaced it.
- The libass in that ffmpeg has HarfBuzz: `shaping=complex` shapes Devanagari
  conjuncts correctly and `simple` mangles them (verified by rendering both).
  **Not verified in the Docker image.**
- The bundle font `assets/deva.otf` is **Mart**, not Sanskrit 2003. Use
  `sanskrit2003.ttf` (1615 glyphs).
- Slide text is grown to fill the slide by binary search on a CSS `--scale`. Every
  line is `nowrap`, so the source line breaks never change. Two settings decide
  the letter size: `VERSES_PER_SLIDE` (default 2) and `DEV_LAYOUT` (default
  `source`: the Devanagari keeps the markdown's half-lines instead of one joined
  line per verse). Joined lines were the width limit: at 2/slide, joined reached
  about 1.05×; source reaches about 1.27× (Devanagari ~66px, IAST ~42px). One
  verse per slide reaches about 2×; the user chose 2.
- With `DEV_LAYOUT=source` a verse's Devanagari spans several `.dsub` lines, so
  underline `target=dev` glide groups (keyed per verse in `render.js`) now cross
  a line break. Fix that if you revive `target=dev`.
- xfade audio-sync algebra and encode settings are in `src/render.js` and have been
  stable since the prototype.
- The user is non-technical-facing. Setup must be `npm run setup` and
  `npm run cli`, `.env` is auto-loaded, and nothing needs copying. They objected
  strongly to complicated setup instructions.
- The user asked to use existing libraries and repos rather than hand-rolled
  solutions: *"don't try doing it urself. Look up for github-repos…"*

## 6. Files

```
services/mantra-tutorials/
  src/pipeline.js   extract -> transcribe (forced align) -> align -> theme -> slides -> render
  src/forced.js     chant sequence + runs aligner/align.py, caches forced.json
  src/align.js      alignForced() (primary) and align() (Deepgram fallback) -> timings.json
  src/slides.js     HTML -> PNG in Chromium, font fit, word-box measurement   <- §2 target
  src/render.js     xfade chain + optional ASS overlay                        <- §2 target
  src/ass.js        builds the .ass underline (pure, unit-tested)
  aligner/          align.py, verify.py, probe.py, requirements.txt (.venv gitignored)
  scripts/setup-aligner.mjs   `npm run setup`
  mantras/durga-kavacham/     the one real bundle (audio.mp3 gitignored)
  data/<id>/                  run artefacts: forced.json, timings.json, slides.json, underline.ass
```

Inputs that live only on the user's machine: the audio
`C:\Users\GD\Downloads\2. Kavacha Stotram.mp3` (copied into the bundle), and
`C:\Users\GD\Downloads\Durga Saptashati\` (source markdown, Elements, fonts).

## 7. Deployment

**Deployed and healthy since 2026-09-28** (commit `531fea1`). No render has run in
the container yet, and container-side Devanagari shaping and aligner imports are
unverified. Dokploy app `Temple-mantra-tutorials`, port **8481 → 3200**, volume
`temple-mantra-data` at `/data` (holds the HF model cache too). Its host env
comes from the gitignored `services/mantra-tutorials/.env.deploy`, not `.env`,
because the local `.env` has a Windows `FFMPEG_PATH`. The UI password is in that
file. Commands: `node scripts/dokploy.mjs create|configure|push-env|deploy|verify --app mantra-tutorials`.
The host edge is Caddy (CLAUDE.md §12), so the UI is only at
`http://157.180.15.165:8481`. The user's machine blocks bare IPs, so the CLI is
their real front end. Chant audio is gitignored, so bundles on the host have no
audio unless it is put on the volume.
