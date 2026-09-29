# services/mantra-tutorials

Turn a **mantra bundle** — a background slide, the Devanagari + transliteration
text, and the chant audio — into a 1080p tutorial MP4 where the transliteration
is **underlined word-by-word in sync with the chant**, styled like the reference
"Argala Stotram – #DurgaSaptashati" video but on your own background template.

> **The underline is on by default (2026-09-28).** A warm accent line glides
> under the transliteration word being chanted — placed from the word's exact
> laid-out box (not OCR) and timed by forced alignment, so it stays under the
> right word (verified frame by frame). It is drawn with a contrasting soft edge
> so it reads on any background. Turn it off per build with `--no-underline`,
> `UNDERLINE=false`, the first CLI question or the web-UI checkbox — you then get
> plain slides that change with the chant, with the text as large as the slide
> allows (`VERSES_PER_SLIDE`, default 2; `DEV_LAYOUT=source` keeps the Devanagari
> on its source half-lines, which is what lets it grow).

Nothing about Durga or the Kavacham is baked into the engine; every mantra is
just another bundle. One shared engine (`src/pipeline.js`) drives both a local
CLI and a hosted web UI, so a build from either is identical.

## Making a new video

| Input | Required? | Notes |
|---|---|---|
| Background image | **required** | png/jpg/webp, 16:9 (it is cover-cropped to 1920×1080) |
| Devanagari text | **required** | `.md`/`.txt`, one half-verse per line, each verse ending `॥ n ॥`. A line ending `उवाच` is a speaker line, a line starting `इति` closes the text |
| Chant audio | **required** | mp3/wav/m4a/flac/ogg |
| IAST | optional | generated from the Devanagari with [sanscript](https://github.com/indic-transliteration/sanscript.js) when absent. Upload your own to override it |
| Text box | optional | where the text may go, drawn on the background. Default: the whole frame less a small margin |
| Title | optional | shown at the top of every slide, inside the text box |
| Meaning | optional | a non-underlined translation block, off unless switched on |

**Web UI:** **+ New mantra**, then upload the three required inputs. Drag a
rectangle over the background to set the text box, and press **Save & preview
slides** to see the opening slide and the tightest verse slide. Render a clip
to check the underline, then render the full video.

**CLI:**

```powershell
node src/cli.js new devi-kavacham --title "Devi Kavacham" --background bg.png --dev devanagari.md --audio chant.mp3 --box 690,44,1770,1030
node src/cli.js preview devi-kavacham          # PNGs of the layout; no audio needed
node src/cli.js build devi-kavacham --sample 0-30
node src/cli.js build devi-kavacham            # the full video
```

Or run `node src/cli.js` with no arguments. It asks for each input and offers
the preview. `set <id>` changes any of the same flags later. `info <id>` shows
what is present and what is missing. `iast <id|file>` prints the generated
IAST, and `--out english.md` saves it for hand correction.

**Where things are kept:**

- Bundles are in `MANTRAS_DIR`: `./mantras` locally, `/data/mantras` in the
  container.
- Videos are written to `DATA_DIR/<id>/`, together with that mantra's caches:
  - the full video as `<id>.mp4`;
  - clips as `sample-<from>-<to>.mp4`;
  - `preview/*.png` for the layout preview;
  - `iast-auto.md` for the generated IAST.

  In the UI they can be played, downloaded and deleted. `DATA_DIR` is
  `./data` locally and `/data` in the container.
- The image seeds its shipped bundles into `/data/mantras` on first boot
  (`MANTRAS_SEED_DIR`). It never overwrites a bundle that is already there, so
  bundles made or edited in the UI survive redeploys.

The text box is stored in `mantra.json` as margins (`textArea`). The UI and
`--box` use corners `x1,y1,x2,y2` of the 1920×1080 frame. Every slide, the title
included, stays inside the box, and all verse slides share one type size, which
is set by the widest verse.

### Generated IAST

`src/translit.js` wraps the indic-transliteration project's `sanscript.js`,
which is vendored unmodified at `src/vendor/sanscript.cjs` (MIT, v1.3.3; licence
alongside). Vendoring keeps the service at zero runtime deps. The dandas `।`
and `॥` are kept as they are, because sanscript writes them as `|` and `||`. The
word splitter would then count those as words, and the IAST line would no
longer pair word for word with its Devanagari. On the Kavacham, the generated
IAST matches the hand-typed file on 114 of 118 lines, and every line pairs
word for word. The four differences are anusvāra spellings (`ṃ` against a
nasal). The layout and type size come out identical.

## The pipeline

Six stages, run in order by `runPipeline(idOrPath, { onStage, overrides, force })`:

| Stage | Does |
|---|---|
| `extract` | parse the Devanagari/transliteration markdown into verses + a preamble |
| `transcribe` | **forced alignment**: place every written word on the audio with a Sanskrit acoustic model (`src/forced.js` → `aligner/align.py`, cached as `forced.json`). Falls back to Deepgram ASR only if the aligner isn't installed |
| `align` | turn those placements into the per-word timeline (`timings.json`): each word holds until the next, slides switch when a verse's speaker line starts |
| `theme` | derive a legible text colour and an accent (the `auto` underline colour) from the background PNG |
| `slides` | group verses into slides (`VERSES_PER_SLIDE`), grow the text to the largest size that fits without re-wrapping any line, render each to a 1920×1080 PNG in headless Chromium (for correct Devanagari shaping), and measure the on-screen box of every word |
| `render` | crossfade the slides on the audio timeline; if the underline is on, glide an ASS/libass underline (`src/ass.js`) under the current word |

**No LLM is in this pipeline, and no manual one-off ffmpeg exists** — everything
is a script. The acoustic model only *places* the known words; it never decides
what they are, and the animation is deterministic.

## Word timing is forced alignment

We already have the exact text, so the timing problem is *"when is each known
word chanted?"*, not *"what is being said?"*. That is forced alignment, a
solved problem, and we use existing tools for it rather than our own matcher:

- **[ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner)**
  (BSD-2) does the alignment.
- The acoustic model is **Vakyansh's Sanskrit wav2vec2**
  (`Harveenchadha/vakyansh-wav2vec2-sanskrit-sam-60`, from Open-Speech-EkStep's
  MIT-licensed vakyansh-models; 60h of Sanskrit). Its vocabulary is Devanagari,
  so the written words are aligned as written, with no romanisation.
- The library's own default model (MMS) is **CC-BY-NC**, so it is deliberately
  not used. These videos may be used commercially.

It replaced Deepgram ASR + fuzzy matching, which guessed at a romanised
transcript. On the Kavacham, that squeezed verse 2 into 1.6s, smeared verse 1
over 21s, and gave single words anywhere from 0.05s to 10s. Those were the
"too fast / too slow" jumps. With forced alignment every verse takes 9–11s
and words take 0.2–4s.

Three details that matter, all in `aligner/align.py` / `src/align.js`:

- **The CTC blank is detected, not assumed.** Models converted from fairseq
  (Vakyansh included) use `<s>` as the blank, not the pad token the library
  assumes. The wrong blank silently yields garbage (mean log-prob −10 per frame
  instead of −0.06).
- **Silence is only allowed between lines.** A free "star" token between every
  word lets it swallow the chanting, and each word shrinks to a few frames.
- **An 80ms onset correction** (`ONSET_SHIFT`). CTC fires slightly after a sound
  starts. This was measured with `aligner/verify.py`, which cuts out each word's
  assigned audio and blind-decodes it. At −80ms, 20 of 24 sampled words read
  back as themselves.

To check a new mantra's timing without watching the whole video:

```powershell
aligner\.venv\Scripts\python aligner\verify.py data\<id>\timings.json mantras\<id>\audio.mp3 <ffmpeg> Harveenchadha/vakyansh-wav2vec2-sanskrit-sam-60 24
```

It prints each sampled word next to what the model hears in its slot.

`aligner/meter.py` is a second check that uses no model at all. In chant, the
gap from one word's start to the next tracks the word's syllable weight (short
1, long 2), so it flags words whose span breaks the metre. It runs on plain
Python:

```powershell
python aligner\meter.py data\<id>\forced-request.json data\<id>\forced-result.json -v
```

On the Kavacham, 0.9% of words break the metre, and those are the drawn-out
`ॐ`s. Adding ±0.25s of random error pushes that to 8.9%, and spacing words
evenly to 12.7%. Treat anything above ~3% as worth a look.

### Aligners that were tried and rejected (2026-09-28)

- **Montreal Forced Aligner** with AI4Bharat's IndicMFA Sanskrit model: 31% of
  words break the metre, 34% after adapting to the singer, and some words are
  seconds off. It was trained on read speech, and drawn-out chanting defeats it.
  Its weights also have no licence.
- **WhisperX**: its alignment step is the same wav2vec2 CTC method we use, and
  it has no Sanskrit model.
- Not tried, and the next things to try if a recording aligns badly:
  - separating the voice from the instruments with Demucs before aligning;
  - AI4Bharat's Sanskrit IndicConformer (MIT, gated on Hugging Face), used
    through NVIDIA's NeMo Forced Aligner as a second opinion.
`aligner/probe.py` greedy-decodes any slice. Use it to check that a model can
hear a new recording at all before trusting it.

## The underline is an ASS/libass overlay

The underline is a subtitle overlay (`src/ass.js`) rendered by ffmpeg's `ass`
filter over the crossfaded slides. libass is the karaoke/subtitle renderer
already inside ffmpeg, so instead of nudging a rectangle by hand it does the
per-frame tweening, softening and glow for us. This replaced an earlier
single-`drawbox`+`sendcmd` hack that could only move one hard box in a few coarse
steps and could not glow — which is what made the line "run around" harshly.

- The bar is a `\p1` **vector drawing** (`m 0 0 l 100 0 …`), 100 units wide;
  `\fscx=<px>` scales that width to the measured word box, so there is no glyph
  shaping in the underline — the Devanagari/serif text stays in the Chromium
  slide PNGs underneath.
- Coordinates are 1:1 with the video: `PlayResX/Y` = the frame size, so a word's
  measured pixel box maps straight onto `\pos`/`\move`/drawing units.
- A word that starts a line is a static `\pos` with a fade in; a following word
  on the same line **glides** (`\move`) and **resizes** (`\t(\fscx…)`) from the
  previous word, with no fade between — so the line flows rather than blinks.
- The core bar carries a **contrasting soft outline** (`\bord` + `\3c` in the
  opposite tone — a dark edge on a light slide, a light edge on a dark one). A
  thin coloured line can otherwise sit too close to the slide behind it (a gold
  line on a gold slide vanished); the outline gives it an edge on any background
  while keeping the reference's light feel. The line colour itself is a dedicated,
  higher-contrast `theme.underline` (color.js), not the softer speaker-text accent.
- `halo=true` adds a **real second glow layer** (layer 0): taller, `\blur5`,
  and more transparent behind the core bar — the thing one drawbox never could.
  Default is `halo=false`, the thin crisp reference line.

Colour is libass `&HBBGGRR&` (reversed) with inverse alpha (`00` opaque … `FF`
clear); timestamps are centiseconds. `src/ass.js` is pure and unit-tested
(`test/ass.test.js`) so these encodings can't drift silently.

## Bundle format

A bundle is a folder under `MANTRAS_DIR` (default `./mantras`) with a
`mantra.json`. The shipped example is `mantras/durga-kavacham/`:

```jsonc
{
  "id": "durga-kavacham",
  "title": "Devi Kavacham",          // "\n" for a second line
  "section": "Kavacha Stotram",     // which '# heading' of the markdown to use, or omit for the whole file
  "background": "background-devi-mahatmyam.png",   // 1920x1080 slide template
  // px margins from the frame edges where text may go; keeps a figure/logo clear.
  // The theme also judges contrast inside this area only. Default 70/70/64/56.
  "textArea": { "left": 690, "right": 150, "top": 44, "bottom": 50 },
  "versesPerSlide": 1,
  "expectedVerses": 56,             // optional check; a mismatch is flagged in the preview
  "devMarkdown": "devanagari.md",
  "engMarkdown": "english.md",      // optional: the IAST, which is what gets underlined; generated when absent
  "audio": "audio.mp3",             // the chant
  "deepgramCache": "deepgram.json", // optional; only used by the Deepgram fallback
  "fontsDir": "assets",
  "fonts": { "devanagari": "sanskrit2003.ttf" },  // serif faces fall back to prototype/assets
  "output": "durga-kavacham.mp4",   // file name inside DATA_DIR/<id>/
  "showMeaning": false,             // optional non-underlined meaning block, off by default
  "underline": { "color": "auto", "thicknessPx": 3, "motion": "sweep" }
}
```

Committed per bundle: `mantra.json`, the two `.md` files, `deepgram.json`,
`background.png`, and any bundle fonts. **Not committed** (gitignored, large or
non-redistributable): the chant `*.mp3`/`*.wav`/`*.m4a` and any rendered `*.mp4`.
A fresh clone of the sample therefore needs its `audio.mp3` added back before it
can render.

## The six underline controls

All exposed identically in the CLI and the web UI, all overridable per build,
all defaulting to the bundle's own settings (which default to house style):

| Control | Values | Default | Meaning |
|---|---|---|---|
| `color` | `auto` \| `#hex` | `auto` | `auto` derives a visible warm line colour (with a contrasting outline) from the background; or force a hex |
| `thicknessPx` | integer | `3` | line thickness (thin, 2–3px, like the reference) |
| `opacity` | 0–1 | `0.9` | line opacity (subtle) |
| `halo` | bool | `false` | adds a real second glow layer behind the core line (see above) |
| `motion` | `sweep` \| `glide` \| `step` | `sweep` | sweep: a short fixed-length bar (`lengthPx`, 64) moving steadily along the line from each word's start to the next, never holding mid-line. glide: word-width bar that glides then holds (read as "getting stuck"). step: jumps |
| `target` | `translit` \| `dev` | `translit` | underline the transliteration (reference) or the Devanagari |

Plus `lengthPx` (sweep bar length, `--length`), `gapPx` (vertical gap below the word), `glideMs` (glide duration), and the
`showMeaning` toggle.

## CLI (run it locally)

The CLI is the simplest way to use this — no server, no login. It renders the
sample in **two commands**, and the interactive mode never makes you remember a
flag: it lists the mantras, you pick a number, then press Enter through the
settings (each shows a sensible default). Open a terminal in this folder:

```powershell
npm run setup        # once: installs the word-timing aligner (needs Python 3; ~5 min)
npm run cli          # pick a mantra by number, press Enter through the settings
```

That's it. It finds ffmpeg and the browser it needs on its own, reads everything
else from `.env` automatically, and needs no API key. The first build downloads
the Sanskrit model once (~400 MB) and spends ~2 minutes timing a 10-minute chant.
After that the timing is cached, and rebuilding with a different look only
re-renders. When it's done it prints the path of the finished `.mp4`.

Prefer typing one line? Every setting is also a flag, and any flag you leave off
keeps the mantra's own default:

```powershell
npm run build durga-kavacham
npm run build durga-kavacham -- --target dev --thickness 2 --no-halo
npm run build durga-kavacham -- --color "#CE7A1F" --motion step
```

Flags: `--underline` / `--no-underline` (on unless `--no-underline`), `--color`, `--thickness`, `--opacity`, `--halo` / `--no-halo`, `--motion`,
`--target`, `--gap`, `--glide-ms`, `--meaning` / `--no-meaning`, and `--force`
(re-time the words, ignore the cache). `npm run list` prints the mantra ids.

**Two things a first-time user needs to know:**

- The chant `.mp3` is not in the repo (too large to commit), so a fresh clone of
  the sample needs it dropped back in as `mantras/durga-kavacham/audio.mp3`
  before it can render. Existing bundles on your machine already have theirs.
- To add your own mantra, use `node src/cli.js new …` or pick `n` in the
  interactive menu (see **Making a new video**). Nothing is hard-coded to the
  sample.

## Web UI

```
node src/index.js               # serves the UI on PORT (default 3200)
```

`http://localhost:3200` works in five steps:

1. **Inputs.** Upload, paste or edit each input. The IAST shows what will be
   generated, and **Use auto** drops a supplied one.
2. **Layout.** Title, verses per slide, and the text box. Drag on the image to
   draw it, drag inside it to move it, or drag the corners. Then preview.
3. **Underline.** The controls, which can be saved as the mantra's default.
4. **Render.** A clip or the full video, with stage progress. A page reload
   reattaches to a running render.
5. **Videos.** Play, download or delete.

Protect the UI with `UI_PASSWORD` (basic auth). Empty means open, which is fine
on localhost; set it in production. `/healthz` is unauthenticated for the
container healthcheck. Only one render or preview runs at a time, and a second
one gets "busy".

## On the host (the deployed service)

Deployed to Dokploy, the web UI above is served on the published port —
`http://157.180.15.165:8481` — behind `UI_PASSWORD` basic auth. It is the same
UI, driving the same engine, so everything under **Web UI** applies; these are
the differences that only matter on the server:

- **Reaching it.** The edge here is Caddy, which serves only hostnames written
  into its own config, so there is no `https://…` name for this app yet — it is
  the bare IP and port (CLAUDE.md §12, "The edge, settled"). If your own machine
  blocks bare IPs (Cold Turkey does), you won't be able to open that URL; run the
  **CLI locally** instead, which walks the same menus and produces the same MP4.
  A public hostname needs a Caddy vhost added on the host — the Dokploy Domains
  tab cannot do it.
- **Bundles live on the volume** (`/data/mantras`). Make new ones in the UI.
  Shipped bundles are copied in on first boot, but without their chant audio,
  which is gitignored. Upload that through the UI before rendering.
- **Word timing runs in the container.** The image installs the aligner (CPU
  torch). The Sanskrit model is downloaded on the first build and cached in
  `/data/hf`, so it survives redeploys. No API key is needed.
- **Where output lands.** Rendered MP4s and per-mantra caches (`forced.json`,
  slide PNGs) are written under `/data` (the `temple-mantra-data` volume), so a
  redeploy doesn't re-time or re-render. The finished file is playable
  in-page and served from `/out/<id>/<file>.mp4` (`?download` to save it).
- **Host env is `.env.deploy`, not `.env`.** The local `.env` holds a Windows
  `FFMPEG_PATH` and an empty `DATA_DIR`, which would break the container.
  `scripts/dokploy.mjs` pushes the gitignored `.env.deploy` instead when it
  exists (`PORT`, `DATA_DIR=/data`, `UI_PASSWORD`, …).
- **Deploy / verify.** `node scripts/dokploy.mjs create --app mantra-tutorials`
  (once), `configure`, `push-env`, then `deploy --app mantra-tutorials` from the repo root; confirm the container
  actually rolled with `verify --app mantra-tutorials` (container age — `deployment.all`
  says `done` regardless, CLAUDE.md §10).

> **Deployed 2026-09-28.** The image builds on Dokploy and the container is healthy:
> `/healthz` answers 200 and the UI answers 401 without the password. No render
> has run in the container yet. The bundle's chant audio is gitignored, so there
> is nothing to render there until audio is put on the `/data` volume.

## Configuration

**You don't have to configure anything to render the sample** beyond
`npm run setup`. ffmpeg and the browser are found automatically.

When you *do* want to change a default, put it in a `.env` file in this folder and
it's picked up automatically the next time you run — no flag, no `export`, nothing
to source. Everything *per mantra* lives in the bundle's `mantra.json`, not here;
`.env` is only machine-level and house-style: encode settings, `UI_PASSWORD`, the
`UNDERLINE_*` defaults, and the timing source (`ALIGNER=auto|ctc|deepgram`,
`ALIGN_MODEL`). `DEEPGRAM_API_KEY` is only for the old fallback. `.env.example` lists every variable with its default;
`src/config.js` is the source of truth (keep the two in sync).

`FFMPEG_PATH` / `BROWSER_PATH` are only needed if auto-discovery misses them
(ffmpeg not on `PATH`, or Edge/Chrome installed somewhere unusual).

## Deployment

Dokploy app `Temple-mantra-tutorials`, published port **8481 → 3200**, with a
`temple-mantra-data` volume at `/data` for rendered MP4s and per-mantra caches.
Registered in `scripts/dokploy.mjs` (`--app mantra-tutorials`). The image is
Debian-based because it needs ffmpeg **and** headless Chromium with Devanagari
fonts. As with every service here, the build context is this directory, not the
repo root (CLAUDE.md §11).

## Proven vs. not

**Proven** (built, then looked at — frames extracted and inspected):

- Forced-alignment timing on the Kavacham (2026-09-28): 572 words aligned in
  111s on CPU, median frame score −0.06, 4 weak words. A blind decode of each
  word's slot (`aligner/verify.py`) read the word back for 20 of 24 samples. A
  frame at t=249.4s shows the line under `cāparājitā`, the word being chanted.

- The ASS/libass underline renders, is clearly visible, and tracks the current
  word — a warm amber line (dedicated `theme.underline` colour with a contrasting
  soft outline) that glides between words. Verified frame by frame against each
  word's exact measured box: at t=123.85s the line sits between markers drawn at
  vārāhī's box edges (dead-on); the preamble line sits under `śrīcaṇḍīkavacasya`
  and verse 1 under `paramaṃ`. A static box-placement check landed each bar
  precisely under its word, so the placement is exact, not approximate. This is
  what let the underline be turned **on by default** (2026-09-28). libass
  HarfBuzz shaping confirmed present on the dev ffmpeg.
- `target=dev` underlines the Devanagari: dev words measured 1:1 with translit
  (29/29 per slide), frame at t=120s shows the line under `देवेशि`.
- The default translit build of `durga-kavacham` renders end to end (20 slides,
  ~644s = the audio duration).
- Both front ends drive the one engine; all server endpoints smoke-tested.
- The template flow (2026-09-29), run through the HTTP API:
  - a bundle was created from a title;
  - its background and a Devanagari-only text were uploaded;
  - the text box was set, and the incomplete bundle was refused for a build;
  - the preview gave 56 verses on 57 slides at the same type size (0.886) as
    the hand-typed IAST, with correct generated IAST on the slides;
  - a 20s clip rendered into `data/<id>/` and was served with byte ranges.

  The UI was rendered in headless Edge, and `list`/`info`/`set`/`iast` were
  run in the CLI.
- The unit tests (`npm test`): tokenizer parallelism (§3 invariant), flag
  parsing, override selection, config defaults, the ASS encodings, and the
  forced-alignment timeline (sequence order, hand-over, line tail, onset shift,
  speaker-led slide start, non-parallel spread). Plus 11 template tests in
  `test/template.test.js`:
  - generated IAST: dandas kept, word pairing, headings;
  - the text box: clamping, and corners to margins in both directions;
  - bundle creation, missing-input reporting, uploads and file replacement;
  - key whitelisting, auto against uploaded IAST, and the output listing;
  - CLI flags.

  41 tests in all.

**Not yet proven:**

- Any mantra other than the sample. The engine is bundle-driven, but only
  `durga-kavacham` has been run, including a Devanagari-only copy of it.
- The box picker's dragging by hand in a real browser. It rendered correctly
  headless, but the drag was not exercised there.
- A build inside the Docker container. Everything above was on the dev machine;
  the image (ffmpeg + Chromium + fonts) has not been built or run on Dokploy.
- The aligner on a recording with heavy instrumentation or a different chanter.
  The Kavacham is a clear voice. Run `aligner/probe.py` on a new recording first.
- `npm run setup` from a clean machine. The venv here was built by hand with the
  same commands.
- `step` motion, non-`auto` colours, and the `showMeaning` block against a real
  bundle (unit-covered and code-complete, not visually verified).
