# reels

One of the services in the [Temple Social Media App](../../README.md).

Turns a day's ritual photos from Google Drive into a branded vertical reel and
files it back into Drive, with a Slack ping when it lands.

Pick the event folder, pick the song, press Start.

**Run it from your own machine:** double-click `reels.cmd`, or run `reels` in a
terminal from this directory. It walks you through the same choices the web UI
offers and does the same work — downloads, curates, renders, uploads the reel
into the event folder and posts to Slack. Nothing about it needs the server.

```
reels                     menus for folder, song, end card and length
reels --no-upload         render to a local file, leave Drive and Slack alone
reels --event <link>      skip the folder menu
reels --target 45         a 45-second reel, without being asked
reels --status            what the last run is doing (run it in a second window)
reels --song-start 90      start the music 90s in, instead of letting it choose
```

**The music starts at the best part of the song, not the beginning.** ffmpeg
measures perceived loudness across the track and the reel takes the loudest
sustained passage — the chorus, in practice — snapped to a dip between phrases
so it never opens mid-word. No model is involved: this is measurement, and it
gives the same answer for the same song every time. The chosen window is written
into the job log. `--song-start` overrides it, `MUSIC_PICK=start` restores the
old first-N-seconds behaviour.

**The length is asked for on every run** — 15, 20, 30, 45, 60 or 90 seconds, or
any value you type between 10 and 300. Each option shows how many photographs it
will use. It is not only a cosmetic choice: the number of images sent to the
model is sized from it, so a shorter reel is also a faster run.

The hosted service is the same pipeline behind a web page. On the current server
the UI is only reachable at `http://157.180.15.165:8479`, because the edge proxy
serves two fixed hostnames and cannot be changed through the Dokploy API — see
`CLAUDE.md`. The CLI sidesteps that entirely.

---

## The division of labour

This is the rule the whole service is built around:

| | Decides |
|---|---|
| **The LLM** | which photographs are worth using, and which are blurry, duplicated, badly framed or not photographs of the event at all |
| **ffmpeg** | every visual decision — Ken Burns motion, transitions, timing, letterboxing, the logo, the end card, the audio fades |

The model is never asked for an effect, a transition name or a duration. It
returns scores. `sequence.py` turns scores into an order and `render.py` turns
an order into one deterministic ffmpeg filter graph, so the same shot list
renders the same reel every time — which is what makes a bad-looking result
reproducible, and therefore fixable.

---

## Expected Drive layout

```
Vision Pics/                       <- DRIVE_ROOT_FOLDER_ID
  Songs/                           <- one track dropped in per day
  Elements/                        <- logo.png, endcard.png|mp4, intro.png|mp4
  2026-09-18 Ganesha Chaturthi/    <- an event folder, chosen in the UI
    KAILASA LA/                    <- one folder per temple
    KAILASA Houston/
    Reels/                         <- created here, holds the finished reel
```

Only `Songs` and `Elements` are assumed by name (both configurable). Everything
else is discovered. Images sitting loose in an event folder are used too — a
team that uploaded without making a folder still took the photos.

---

## Pipeline

| Stage | What happens |
|---|---|
| `discovering` | walk the event folder, sample it evenly, download the sample |
| `prefiltering` | reject too-small, blurry and burst-duplicate frames, locally, on a pool |
| `curating` | Groq scores the survivors in concurrent batches; Gemini covers a rate limit |
| `sequencing` | pick the shots, guarantee each temple a floor, order as a tour |
| `rendering` | one ffmpeg filter graph: Ken Burns, xfades, logo, cards, music |
| `uploading` | create `Reels/`, upload, optionally share, post to Slack |

**Prefiltering exists to keep the model cheap and honest.** Teams upload in
bursts, so an 8×8 dHash at Hamming distance ≤ 5 collapses six near-identical
frames of the same arati to the sharpest one, and a Laplacian-variance focus
measure drops the soft ones. That typically halves the pool before a single
token is spent.

**A big event stays a short run.** A festival day can be a thousand photographs
across forty temple folders, and the run is bounded at every point rather than
growing with it: the event is sampled evenly across folders before anything is
downloaded, only `CANDIDATES_PER_SHOT` images per shot are ever scored, batches
are scored concurrently, and the whole curating stage gives up after
`CURATION_BUDGET_SECONDS` and keeps heuristic scores for the rest. A
rate-limited Groq hands the batch straight to Gemini instead of waiting out its
`retry-after` — waiting was what once turned a 1052-photo event into forty
minutes of apparent silence. That folder now renders a 30s reel in under three
minutes.

**Nothing is allowed to look stuck.** Progress reaches disk every ten seconds,
so `reels --status` from a second window is current mid-stage; a watchdog writes
`still <stage> after Nm` into the job log; ffmpeg is killed past
`RENDER_TIMEOUT_SECONDS`; and a failure always carries a message, even when the
exception itself has none.

**A Groq outage degrades the reel; it never cancels it.** Every image already
carries a heuristic score from the prefilter, so a failed batch keeps those
scores and the run continues. The Slack card says whether selection was by
`LLM`, `LLM (some batches fell back)` or `heuristics only`.

**Every temple that turned up is visible.** `MIN_PER_TEMPLE` shots are allocated
per temple before anything is allocated on merit — otherwise one temple with an
enthusiastic photographer takes the whole reel.

---

## Render details worth knowing before changing them

- **Timing.** Each xfade overlaps the tail of one shot with the head of the
  next, so a reel is `n × (seconds_per_image − transition) + transition`, not
  `n × seconds_per_image`. `SECONDS_PER_IMAGE` must exceed
  `TRANSITION_SECONDS`; the config refuses to start otherwise.
- **The 2× supersample before `zoompan` is not optional.** zoompan scaling up
  from the source drifts by about a pixel a frame, and the drift reads as a
  stutter in a slow zoom. Every still is pre-scaled to 2160×3840 so zoompan only
  ever samples down.
- **Motion is written against `on`, the output frame index**, rather than
  accumulating `zoom` frame by frame. Accumulation rounds, and the rounding is
  visible halfway through a slow push.
- **Photos are cropped to fill; branding cards are letterboxed.** A logo with
  its edge sliced off is worse than a black bar.
- **Transitions cycle deterministically by index**, and the joins to the intro
  and end cards are always plain fades — a circle-open into a logo card reads as
  a mistake.
- One filter graph, not per-shot intermediate files: no generation loss, and a
  render that dies halfway leaves nothing to clean up.

---

## Branding

`Vision Pics/Elements/` should hold `logo.png`, `endcard.png` or `endcard.mp4`,
and optionally `intro.png`/`intro.mp4`.

To swap the end card without a redeploy, paste a Drive link into the **Branding**
box in the UI. Resolution order is: the value saved from the UI, then
`ENDCARD_FILE_ID` in the environment, then the file named `endcard` in the
Elements folder. Each asset is cached under `DATA_DIR/elements/` keyed by file id
plus Drive's `modifiedTime`, so replacing the file in Drive is picked up on the
next run and an unchanged file costs nothing.

---

## Setup

### 1. Google

1. console.cloud.google.com → your project → enable the **Google Drive API**.
2. **OAuth consent screen** → set the user type to **Internal**, or publish the
   app to **Production**. This step is not optional: Google expires every refresh
   token issued while the consent screen is in *Testing* after exactly 7 days,
   and the only symptom is `invalid_grant` a week later.
3. Credentials → OAuth client. A **Desktop app** client is simplest; a Web
   application client needs `http://localhost:8765/` in its redirect URIs.
4. Put the id and secret in `.env`, then:

   ```bash
   python scripts/authorize.py
   ```

   Approve in the browser and paste the printed `GOOGLE_REFRESH_TOKEN` into `.env`.

The scope is full `https://www.googleapis.com/auth/drive`. `drive.file` would
only expose files this app itself created, which cannot read the temple uploads.

### 2. Groq

Create one or more keys at console.groq.com and set `GROQ_API_KEYS` to a
comma-separated list. A rate-limited key rotates to the next rather than failing
the job. `GROQ_MODEL` defaults to `qwen/qwen3.6-27b`, which accepts 5 images and
20MB per request; the code sends 4 images of 512px each, well inside both.

### 3. Slack

A **separate app and channel** from the notifier's. Bot token scopes:
`chat:write`, plus `files:write` only if you want `SLACK_UPLOAD_POSTER`. Install
it, then `/invite` the bot into the channel and set `SLACK_CHANNEL_ID`.

### 4. Deploy

```bash
# from the repo root
node scripts/dokploy.mjs configure --app reels
node scripts/dokploy.mjs push-env  --app reels
node scripts/dokploy.mjs deploy    --app reels
node scripts/dokploy.mjs verify    --app reels   # container age is the only proof
```

Mount a volume at `/data` — it holds job history, saved branding overrides and
the asset cache. Give the app at least 2 CPUs and 2 GB RAM: `zoompan` at
1080×1920 runs at roughly 1–3× realtime, so a 60s reel is a 1–3 minute render.

`uvicorn` runs with `--workers 1` deliberately. The job queue lives in the
process; a second worker would have its own queue and the UI would poll a
process that knows nothing about the running job.

---

## Local development

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
python scripts/selftest.py                 # credentials, ffmpeg, Drive, Groq, Slack — read-only
uvicorn app.main:app --reload --port 8000

# build one reel to disk without touching Drive
python -m app.cli --event <folder link> --song <file link> --out reel.mp4
```

`app/config.py` loads `services/reels/.env` when it exists, purely as a local
convenience; values already in the environment always win, and in the container
the file does not exist at all.

---

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | the builder UI |
| `GET /healthz` | container health; 200 even when misconfigured, with the problems listed |
| `POST /api/login` | shared-password session |
| `GET /api/browse?folder=` | folder picker |
| `GET /api/songs` | contents of `Songs`, newest first |
| `GET /api/elements`, `POST /api/elements` | read and override branding assets |
| `POST /api/jobs` | queue a build |
| `GET /api/jobs`, `GET /api/jobs/{id}` | history and live progress |

Everything under `/api` except login accepts `x-admin-token` in place of the
session cookie.
