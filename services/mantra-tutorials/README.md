# services/mantra-tutorials

Turn a **mantra bundle** — a background slide, the Devanagari + transliteration
text, and the chant audio — into a 1080p tutorial MP4 where the transliteration
is **underlined word-by-word in sync with the chant**, styled like the reference
"Argala Stotram – #DurgaSaptashati" video but on your own background template.

Nothing about Durga or the Kavacham is baked into the engine; every mantra is
just another bundle. One shared engine (`src/pipeline.js`) drives both a local
CLI and a hosted web UI, so a build from either is identical.

## The pipeline

Six stages, run in order by `runPipeline(idOrPath, { onStage, overrides, force })`:

| Stage | Does |
|---|---|
| `extract` | parse the Devanagari/transliteration markdown into verses + a preamble |
| `transcribe` | Deepgram ASR over the chant → word timings (cached per bundle as `deepgram.json`) |
| `align` | phonetic-key + Needleman–Wunsch match of ASR words to the written words; each word gets a `start`/`end` |
| `theme` | derive a legible text colour and an accent (the `auto` underline colour) from the background PNG |
| `slides` | group verses into slides, render each to a 1920×1080 PNG in headless Chromium (for correct Devanagari shaping), and **measure the on-screen box of every word** |
| `render` | crossfade the slides on the audio timeline and drive a single ffmpeg `drawbox` under the current word |

**No LLM is in this pipeline, and no manual one-off ffmpeg exists** — everything
is a script. The only ASR is Deepgram; the alignment and timing are deterministic.

## The underline is one ffmpeg drawbox

This is the load-bearing implementation fact for the render (verified against
this ffmpeg build, N-107417 — see the header of `src/render.js`):

- `sendcmd` drives only the **first** `drawbox` instance; `drawbox@label`
  targeting is silently ignored, and a second box (a halo layer) can't be
  independently animated. So the underline is a **single box**.
- `drawbox w 0` means *extend to the frame width*, not *hide*. The box is hidden
  before the first word by parking it **off-screen on y** (y=1130, below 1080).
- drawbox reads `x`, `y`, `w` commands in arrival order at a timestamp, so each
  keyframe emits x → y → w.

Because there's only one box, `halo=true` renders as a **softer, thicker single
line** rather than a separate glow. The default is `halo=false` — the thin crisp
reference line.

## Bundle format

A bundle is a folder under `MANTRAS_DIR` (default `./mantras`) with a
`mantra.json`. The shipped example is `mantras/durga-kavacham/`:

```jsonc
{
  "id": "durga-kavacham",
  "title": "Devi Kavacham\n#DurgaSaptashati Series",
  "section": "Kavacha Stotram",     // which '# heading' of the markdown to use, or omit for the whole file
  "background": "background.png",   // 1920x1080 slide template
  "devMarkdown": "devanagari.md",
  "engMarkdown": "english.md",      // the transliteration / IAST — this is what gets underlined
  "audio": "audio.mp3",             // the chant
  "deepgramCache": "deepgram.json", // optional pre-fetched ASR; lets a build run with no Deepgram key
  "fontsDir": "assets",
  "fonts": { "devanagari": "deva.otf" },  // serif faces fall back to prototype/assets
  "output": "durga-kavacham.mp4",
  "showMeaning": false,             // optional non-underlined meaning block, off by default
  "underline": { "color": "auto", "thicknessPx": 3, "motion": "glide" }
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
| `color` | `auto` \| `#hex` | `auto` | `auto` derives an accent from the background; or force a hex |
| `thicknessPx` | integer | `3` | line thickness (thin, 2–3px, like the reference) |
| `opacity` | 0–1 | `0.9` | line opacity (subtle) |
| `halo` | bool | `false` | softer/thicker single line (one-drawbox constraint above) |
| `motion` | `glide` \| `step` | `glide` | glide eases x/width between words on a line; step jumps |
| `target` | `translit` \| `dev` | `translit` | underline the transliteration (reference) or the Devanagari |

Plus `gapPx` (vertical gap below the word), `glideMs` (glide duration), and the
`showMeaning` toggle.

## CLI

```
node src/cli.js                 # interactive: pick a bundle, then set each control
node src/cli.js list            # list bundle ids
node src/cli.js build durga-kavacham
node src/cli.js build durga-kavacham --target dev --thickness 2 --no-halo
node src/cli.js build durga-kavacham --color '#CE7A1F' --motion step --force
```

`--force` re-runs Deepgram, ignoring the cache. The bin is also `mantra` (see
`package.json`), so `npm run build -- durga-kavacham` works.

## Web UI

```
node src/index.js               # serves the UI on PORT (default 3200)
```

`http://localhost:3200` — pick a bundle, set the same six controls, Build, watch
the stage dots, then play the result in-page. Protect it with `UI_PASSWORD`
(basic auth; empty means open — fine on localhost, set it in production).
`/healthz` is unauthenticated for the container healthcheck.

## Configuration

Copy `.env.example` to `.env`. Machine-level and house-style settings live there
(`FFMPEG_PATH`, `BROWSER_PATH`, encode settings, the `UNDERLINE_*` defaults);
everything *per mantra* lives in the bundle. `src/config.js` is the source of
truth — keep `.env.example` in sync with it.

Transcription needs `DEEPGRAM_API_KEY`, but a bundle that ships a `deepgram.json`
cache (the sample does) renders without one.

## Deployment

Dokploy app `Temple-mantra-tutorials`, published port **8481 → 3200**, with a
`temple-mantra-data` volume at `/data` for rendered MP4s and per-mantra caches.
Registered in `scripts/dokploy.mjs` (`--app mantra-tutorials`). The image is
Debian-based because it needs ffmpeg **and** headless Chromium with Devanagari
fonts. As with every service here, the build context is this directory, not the
repo root (CLAUDE.md §11).

## Proven vs. not

**Proven** (built, then looked at — frames extracted and inspected):

- The single-drawbox underline renders and tracks the current word. Verified at
  t=40/120/200s on the transliteration and t=25s on the preamble.
- `target=dev` underlines the Devanagari: dev words measured 1:1 with translit
  (29/29 per slide), frame at t=120s shows the line under `देवेशि`.
- The default translit build of `durga-kavacham` renders end to end (20 slides,
  ~644s = the audio duration).
- Both front ends drive the one engine; all server endpoints smoke-tested.
- The 16 unit tests (`npm test`): tokenizer parallelism (§3 invariant), flag
  parsing, override selection, config defaults, and `colorArg` alpha encoding.

**Not yet proven:**

- Any mantra other than the sample. The engine is bundle-driven, but only
  `durga-kavacham` has been run.
- A build inside the Docker container. Everything above was on the dev machine;
  the image (ffmpeg + Chromium + fonts) has not been built or run on Dokploy.
- Deepgram transcription from a cold start — the sample uses its cached
  `deepgram.json`, so the live ASR path hasn't been exercised here.
- `step` motion, non-`auto` colours, and the `showMeaning` block against a real
  bundle (unit-covered and code-complete, not visually verified).
