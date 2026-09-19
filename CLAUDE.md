# CLAUDE.md — project context for the Temple Social Media App

This file carries the full context of the conversations that built this repo, so
any future Claude Code session in this folder can pick up mid-stream without
re-deriving decisions or re-researching dead ends.

Created: 2026-09-05 → 2026-09-06 as `social-media-notifications`, a single Node
service. Renamed and restructured into a multi-service app on 2026-09-19 when the
reels pipeline was added. Working dir:
`C:\Users\GD\Desktop\GD\social-media-notifications`.

**Sections 1–10 are the notifier service** (`services/notifier`) and describe it
as it was when it lived at the repo root; the only thing that changed for it in
the restructure is where its files sit. §11 covers the restructure itself and
§12 onward the reels service.

---

## 1. The original request

> "I need you to create a repo which can give the link of any post / reel /
> video / live that happens on this channel. Moment the live stream starts /
> post is posted / reel is posted it should immediately send the link of that
> post / reel / live stream to the slack channel `C0C0PGXT46L`.
>
> Here is the reference yt channel — https://www.youtube.com/@kailasasanjoseus
>
> This repo should be able to do the same for facebook too, without the usage of
> any cookies / separate login.
>
> Use codex cli for your sub-agents."

Follow-ups, in order:

1. *"I want you to setup in Docker, but how do I run it continuously, it shd not
   be dependent on me"* — hosting had to be always-on and laptop-independent.
2. Slack delivery: **bot token + rich Block Kit cards**.
3. Facebook: **"Not an admin / public page only"** (this is the crux — see §3).
4. Triggers: **everything** — uploads, Shorts, premieres, live starts, FB posts,
   photos, videos, reels, live.
5. *"I have a dokploy instance. I'll give you the API key... I've created an
   application named `Social-media-notifications`, that is the one I need you to
   work with. Tell me if this solution will work or I'll have to figure out
   something else."*
6. *"First create the repo, then I'll give you the dokploy API key, so you can
   look around and see how to work it out."*

---

## 2. Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node 22 ESM, 2 deps (`express`, `fast-xml-parser`) | small attack surface, fast cold start, `fetch` is built in |
| Hosting | **Dokploy** app named `Social-media-notifications` | user already runs it; Traefik supplies the public HTTPS URL that webhooks require, Docker supplies 24/7 restart. This is what unblocked the whole design. |
| Slack | bot token `chat:write` + Block Kit cards, channel `C0C0PGXT46L` | user's explicit choice; richer than an incoming webhook and allows future editing/threading |
| State | JSON file under `DATA_DIR` (`/data` volume) | dedupe must survive redeploys; a DB would be overkill for a few hundred keys |
| Dedupe | single `announce()` keyed `platform:kind:id` | lets multiple overlapping detectors run without double-posting |
| Facebook | official Graph API path, written but **dormant** behind `FACEBOOK_ENABLED=false` | no Page admin today; see §3 |

---

## 3. The Facebook problem — read this before revisiting it

The user is **not a Page admin**. This is the one requirement that cannot be
engineered around, and it was stated plainly to them:

- A Graph API **Page access token** is the only instant + reliable + legitimate
  path. It is *not* a cookie and *not* a scraped session — it is the official
  API — but obtaining it requires someone with **admin or editor rights on the
  Page** to complete a one-time OAuth against a free Meta app (app can stay in
  Development mode; no App Review needed for a Page you administer).
- **Dokploy did not change this.** Hosting was never the FB blocker.

Cookie-free alternatives, evaluated and rejected:

| Option | Verdict |
|---|---|
| `mbasic.facebook.com` / `m.facebook.com` logged-out HTML | **dead** — Facebook walls logged-out Page content |
| RSSHub `/facebook/page/:id` | **broken** — blocked/rate-limited, self-hosting doesn't help |
| rss-bridge `FacebookBridge` | **broken** upstream |
| Paid scrapers (Apify, ScrapeCreators, Bright Data) | works, but costs per poll, lags minutes (poor for live starts), breaks on markup changes, and **violates Meta Platform Terms**. Deliberately not built in. |
| Page Public Content Access (PPCA) | *more* gated than a Page token — needs App Review + Business Verification |
| Make/Zapier/IFTTT Facebook Pages trigger | viable middle ground: they own the Meta app, but a Page admin still OAuths, and lag is 1–15 min. `POST /ingest` exists for exactly this. |

**Conclusion communicated to the user:** YouTube ships today and is fully
solved; Facebook is one env flag away from working the day a Page token exists.
Don't re-litigate this without new information (e.g. the user gains admin
rights).

---

## 4. Research findings worth keeping

Two `codex-delegate` subagents were dispatched (per the user's "use codex cli"
instruction) to research YouTube and Facebook detection. **Both failed to
actually invoke the `codex` CLI** — that agent type was provisioned without a
shell tool, so it fell back to its own knowledge. Flagged honestly to the user.
A later attempt to run `codex exec` directly was interrupted by the user, who
redirected to building the repo first. **The `codex` CLI has never actually run
in this project.** `codex-cli 0.152.1` is installed if a future session wants it.

Technical facts that were verified empirically and matter:

- **The documented YouTube feed URL is wrong now.** `https://www.youtube.com/xml/feeds/videos.xml?channel_id=…`
  returns a 463-byte **static placeholder with zero entries**. The working path
  is `https://www.youtube.com/feeds/videos.xml?channel_id=…` (confirmed: 15
  entries, correct `<link rel="self">`). This was a real bug caught by the
  selftest, not a theoretical one.
  - Mitigation: `topicUrls()` in `src/youtube/feed.js` registers **both** forms
    with the hub, since Google's hub has historically keyed on the `/xml/` form
    while the served document self-identifies as `/feeds/`. Duplicate pushes are
    deduped downstream, so subscribing to both is free insurance.
- **`search.list` is a quota trap** — 100 units/call means the default 10,000/day
  budget allows only one poll every 14.4 minutes. Never use it for polling.
  `videos.list` costs **1 unit** and accepts up to 50 ids per call; at a 20s
  interval that is ~4,300 units/day. This is why the watchlist design exists.
- **WebSub does not fire when a stream actually goes live.** It fires when the
  broadcast object is created/scheduled, then goes silent at `actualStartTime`.
  Hence the two supplements: a `videos.list` watchlist poll (for streams that
  existed as `upcoming`) and a free `/channel/<id>/live` HTML probe (for instant
  go-lives that were never scheduled).
- Google's hub signs with **HMAC-SHA1** (`X-Hub-Signature`), Meta with
  **HMAC-SHA256** (`X-Hub-Signature-256`). Both must be computed over the **raw
  request body bytes** — hence `express.raw()` on those two routes only.
- WebSub lease caps at 5 days; re-subscribe is idempotent, so it runs on boot
  and every 12h.
- **The `/live` probe flooded Slack, and this is the shape of the bug.** Its id
  extraction fell back to `/"videoId"\s*:\s*"([\w-]{11})"/` over the whole page
  when the canonical link didn't match. A live watch page carries ~30 unrelated
  `videoId`s in its recommendation rail, so that fallback returned strangers'
  videos — Sadhguru, handpan music, The Diary Of A CEO — each announced as
  "LIVE NOW" on this channel. ~113 such posts before it was caught (2026-09-07).
  Two independent things were wrong and both are now fixed:
  1. `readLivePage()` accepts an id only from a page-level marker (canonical
     link → `og:video:url` → `"videoDetails"`), never from a loose page-wide
     match. When the channel isn't live, `/live` doesn't redirect, so the
     absence of such a marker *is* the "not live" answer.
  2. `src/youtube/owner.js` is a hard ownership gate every YouTube event passes
     through. Feed/WebSub entries carry `yt:channelId` and are compared for
     free; bare ids are attributed via `videos.list` (with a key) or **oEmbed**
     (`/oembed?url=…` → `author_url` = the owning channel's `@handle`; free,
     keyless, cookieless, ~400 bytes). It **fails closed** — an id that cannot
     be attributed is not announced.
  - `GET /admin/probe` reports what the *container* reads off that page.
    YouTube serves datacenter IPs a different page shape than a laptop, so a
    local test is not evidence about production. Check it there, not here.
- Shorts have no API flag. Cheap filter: `contentDetails.duration` ≤ 180s (the
  limit rose from 60s in Oct 2024). Definitive test: `GET /shorts/<id>` with
  redirects disabled — 200 means Short, 303 means not.
- The channel resolves without any API key by scraping the public channel page
  for the canonical `/channel/UC…` link. `@kailasasanjoseus` → **`UCT08Oyc76TM1Cn84mzwuGaA`**.

---

## 5. What was built

```
src/index.js          boot, graceful shutdown, periodic state flush
src/config.js         env parsing + configProblems() warnings
src/server.js         all HTTP routes (raw-body handling for signed webhooks)
src/store.js          JSON dedupe/watchlist store, atomic writes, 400-day prune
src/notify.js         announce() — the single dedupe gate; re-arms on Slack failure
src/slack.js          chat.postMessage + Block Kit cards, rate-limit retry
src/http.js           fetch with timeout/retry/browser UA, every() safe interval
src/youtube/api.js    channels/playlistItems/videos.list — API only
src/youtube/feed.js   Atom parse + topicUrls, for WebSub payloads only
src/youtube/detect.js classify an API item -> live/upcoming/short/video, announce
src/youtube/websub.js subscribe/renew both topic forms, HMAC-SHA1 verify
src/youtube/index.js  orchestration: 2 pollers, seeding, /admin/recent report
src/facebook/graph.js Graph client, HMAC-SHA256 verify, permalink builders
src/facebook/index.js feed + live_videos webhook handling, Graph edge poll
scripts/selftest.mjs  offline credential/behaviour check
scripts/dokploy.mjs   Dokploy API driver: probe / show / push-env / deploy / setup
Dockerfile            node:22-alpine, /data volume, healthcheck on /healthz
```

**YouTube detection is API-only — two pollers, nothing else** (rewritten
2026-09-07, see §9):

| Poller | Call | Cost | Job |
|---|---|---|---|
| `yt-uploads` (30s) | `playlistItems.list` on one channel's `UU…`, round-robin | 1 unit | discovers every video, Short and stream |
| `yt-pending` (20s) | `videos.list` on the watchlist (all channels, one call) | 1 unit | catches a scheduled stream going live |

A second `videos.list` runs only when the uploads poll finds an unseen id.
WebSub is retained but **off by default** (`YOUTUBE_WEBSUB_ENABLED=false`):
Google's hub answers this deployment 503, and polling already meets the
requirement. Facebook: `feed` + `live_videos` webhooks (1–5s) → Graph edge poll
(60s).

**First boot seeds silently**, and seeding is owned by `pollChannel`, not
`start()`. A transient API error during a boot-time seed used to leave the flag
unset while the pollers ran anyway, so the next good poll would post the whole
back catalogue. Now it stays in seed mode until it actually succeeds. The flag
is per channel (`seeded['youtube:<UC…>']`) — see §10.

`scripts/dokploy.mjs` is written defensively on purpose — the Dokploy API shape
was never verified (no key yet). It first tries `/swagger`, `/swagger/json`,
`/api/openapi.json`, `/openapi.json` and dumps the spec to
`dokploy-openapi.json`; failing that it probes candidate tRPC-style routes
(`project.all`, `application.saveEnvironment`, `application.deploy`, …) and
prints every attempt with its status code. Auth is sent as both `x-api-key` and
`Authorization: Bearer`. Adjust once real responses are in hand.

---

## 6. Verification actually performed

`node --env-file=.env scripts/selftest.mjs` against the live channel:

```
ok  resolve YouTube channel     @kailasasanjoseus -> UCT08Oyc76TM1Cn84mzwuGaA
ok  fetch + parse Atom feed     15 entries, newest: Gb1nzSiN5HE "#live : SRI KRISHNA JANMASHTAMI CELEBRATIONS 2026"
ok  Shorts redirect probe       Gb1nzSiN5HE is not a Short
ok  channel /live probe         not currently live
ok  YouTube Data API key        skipped (unset)
ok  Slack credentials           skipped (no token yet)
ok  Facebook Page token         skipped (disabled)
```

Full boot also exercised: channel resolved, 15 entries seeded with no Slack
posts, detectors started, `/healthz` and `/status` both answered correctly.

**Not yet verified** (blocked on credentials/deploy): WebSub end-to-end handshake
and push delivery, live-start detection against a real stream, Slack posting,
the entire Facebook path, and every Dokploy API call.

---

## 7. Open items / next steps

0. ~~Dokploy setup~~ **done**: the app is deployed from
   `github.com/kailasas-jyothish/social-media-notifications` @ `main`, env is
   pushed (`YOUTUBE_CHANNELS`, no singular `YOUTUBE_CHANNEL`), and
   `node scripts/dokploy.mjs deploy` now genuinely rolls the container — see the
   start-first Swarm trap in §10 before trusting a `done` deployment again.
1. **YouTube API quota** is the live constraint, not hosting. The key was
   exhausted (403) on the first multi-channel deploy. Steady state for the new
   code is ~7,200 units/day of the 10,000 free allowance; if it exhausts again,
   check Cloud Console → APIs & Services → YouTube Data API v3 → Metrics for
   what else is spending it before shortening any interval.
2. **Slack bot token** — `xoxb-…` with `chat:write`, then `/invite` the bot into
   `C0C0PGXT46L`. Confirm with `POST /admin/test`.
3. **YouTube Data API key** — optional, free; makes live-start detection ~20s
   precise instead of ~30s and classifies Shorts reliably.
4. **Push to git** — Dokploy needs a git source. `gh` 2.83.0 is installed.
   **Nothing has been pushed anywhere yet** — the user was asked and has not
   answered. Do not push without explicit go-ahead.
5. **Facebook** — dormant until a Page token exists (§3).
6. Set `PUBLIC_URL` to the Dokploy domain and mount a volume at `/data`.

---

## 8. Conventions for future sessions

- Comment density is low and explanatory-only — comments justify *why*
  (quota math, the feed-URL trap, HMAC algorithm differences), never restate
  *what*. Match that.
- Every new detector must route through `announce()` in `src/notify.js`. Never
  call `postEvent`/`postMessage` directly from a detector.
- **Never scrape youtube.com.** Not the feed, not `/live`, not a watch page.
  That host serves this deployment throttled 404s, 500s and pages with no
  canonical link; `googleapis.com` with the API key is reliable. Every id must
  be expanded through `videos.list` and gated on
  `getMeta('youtubeChannelIds').includes(snippet.channelId)` before it can be
  announced — that comparison is the only thing standing between the Slack
  channel and another channel's video. It fails closed: an item with no
  `snippet.channelId` is dropped, never assumed to be ours.
- Treat an absent `videoOwnerChannelId` from `playlistItems` as *unknown*, never
  as ours. Falling back to `snippet.channelId` there means assuming ownership
  rather than establishing it.
- Never introduce a cookie-based or logged-in-scraping approach. That was an
  explicit, load-bearing constraint of the original request.
- Prefer 1-unit YouTube API calls. If a change would add a `search.list` poll,
  it's wrong — re-read §4.
- `.env` is gitignored and holds real secrets; keep `.env.example` in sync when
  adding a variable.
- Secrets generated for this project (already in `.env`): `YOUTUBE_WEBSUB_SECRET`,
  `FACEBOOK_VERIFY_TOKEN`, `ADMIN_TOKEN`, `INGEST_TOKENS`. Keep them stable —
  rotating `YOUTUBE_WEBSUB_SECRET` invalidates the current WebSub lease until the
  next re-subscribe.
- The user values a straight answer about what will and won't work over an
  optimistic one. They asked directly whether the approach would work; the
  honest split answer (YouTube yes, Facebook blocked on Page rights) is what
  they wanted.

---

## 9. The 2026-09-07 rewrite — why YouTube detection is API-only

The original design layered a scraped `/live` HTML probe and an RSS feed on top
of the API, as free fallbacks for running without an API key. Both turned out to
be actively harmful from the Dokploy host:

- `GET /admin/recent`'s predecessor showed the container receiving a 1.18 MB
  `/live` page containing `"isLive":true` but **no canonical link, no
  `og:video:url`, no `videoDetails`** — i.e. no trustworthy video id anywhere.
  A laptop gets a normal page for the same URL. Datacenter IPs are throttled.
- `https://www.youtube.com/feeds/videos.xml?channel_id=…` returned **404 and
  500** to the container on nearly every poll while working fine locally.

The old probe's fallback regex matched the first `"videoId"` in that HTML, which
is a recommendation, so ~113 unrelated videos (Sadhguru, handpan music, The
Diary Of A CEO, CANAL+ Sport) were posted to Slack as "LIVE NOW" on this
channel. **The lesson is not "parse the HTML better" — it is that youtube.com is
not a data source for this deployment.**

A YouTube Data API key was added, everything scraped was deleted, and discovery
became `playlistItems.list` on the uploads playlist. Shorts are now decided by
duration (≤180s) alone: the definitive `/shorts/<id>` redirect probe is a
youtube.com request, so on this host it returns no information while adding 8s
per candidate. A misjudged short clip gets the wrong label; the link works
either way.

### Bugs found in review that are worth not reintroducing

Both were caught by an adversarial review of the rewrite, not by testing:

- **`dropWatch()` before `announce()`.** A stream flipping to live was removed
  from the watchlist and only then posted. On a Slack 429/5xx, `announce()`
  re-arms the dedupe key for retry — but the watchlist was the only thing that
  would retry it. The live notification was lost. `dropWatch` now runs only
  once `hasSeen` confirms the key stuck.
- **Watchlist eviction on `addedAt`.** A stream scheduled >30 days out was
  evicted before starting, and its lingering `youtube:upcoming:<id>` key made
  `alreadyHandled()` refuse to rediscover it, so the go-live could never fire.
  Eviction is now based on `scheduledStartTime` + 7 days.

Also: `every()` in `src/http.js` refuses an interval below 1s. A missing config
value arrives as `undefined`, and `setInterval(NaN)` is clamped by Node to 1ms,
which would spend the entire 10,000-unit daily quota in well under a minute and
then 403 for the rest of the day. `store.js` keeps dedupe keys for 400 days, not
45: a pruned key on a video still inside the 50-item discovery window reads as
new and reposts it.

### Quota

Baseline ~2,880/day (uploads only, watchlist empty). With a stream pending all
day, ~7,200. The theoretical worst case — a new id on every single 30s poll —
is ~10,080, marginally over the free tier; it cannot be sustained in practice,
but that is the number to keep in mind before shortening any interval.

### Codex

`codex-cli 0.152.1` **has now actually run** in this project (threads
`01a07b84-afcd-76f1-ae1a-f3e59eda7225` for the refactor,
`01a07b85-139b-7ee2-8525-c246c44d0a71` for the review), correcting §4's note.
Two things to know:

- The `codex-subagent:codex-delegate` agent type is provisioned **without a
  shell tool**, so it silently cannot invoke the CLI and falls back to its own
  knowledge. Dispatch via a `general-purpose` agent instead.
- Passing `--task "@file"` to the wrapper from PowerShell breaks: the MSYS
  runtime expands `@path` as a response file and splats the prompt across argv.
  Wrap the call in `bash -lc '<full command>'` with POSIX paths.

Codex's review produced one confident false positive (claiming
`uploadsPollSeconds` was undefined when it is in `config.js`), so verify its
line-number claims against the file — the reasoning was sound, the coordinates
drifted.

---

## 10. Multi-channel YouTube (2026-09-07, later the same day)

The user asked to watch five more channels alongside San Jose:

| Handle | Channel id |
|---|---|
| `@kailasasanjoseus` | `UCT08Oyc76TM1Cn84mzwuGaA` |
| `@KailasaLA` | `UCq4_WXUpm8ein5ou4qESDcQ` |
| `@kailasahouston9302` | `UCl2cPxGNvohKD012qhU_NVQ` |
| `@kailasaohio7452` | `UCQUOYoDKqvPTi0iXvytDyng` |
| `@kailasatoronto8217` | `UCRg-BvocTHMhQfvGfpt3W1A` |
| `@KailasaSG` | `UC9GvlY2FoWOBEj0pz1hOCVw` |

All six verified live via `channels.list?forHandle` + `playlistItems.list`
(50 uploads each). `config.youtube.channel` became `config.youtube.channels`
(`YOUTUBE_CHANNELS`, comma-separated; the old singular `YOUTUBE_CHANNEL` is
unioned in, not replaced, so a deployment that still sets it keeps working).

**The quota ceiling is what shapes this design.** `playlistItems.list` takes one
playlist per call and there is no batched alternative — `search.list` is 100
units and `activities.list` is also per channel — so six channels polled every
30s each would be 17,280 units/day against a 10,000/day free allowance, and
going over means 403 for the rest of the day rather than slower polling. So the
uploads poller checks **one channel per tick, round-robin**: cost stays at
86400/`uploadsPollSeconds` regardless of channel count, and the price is
latency — any one channel comes round every `uploadsPollSeconds × channelCount`
(3 min for six). The watchlist poller is unaffected: `videos.list` takes 50 ids
per unit, so every channel's pending streams are checked in a single call and
scheduled go-lives keep their ~20s precision. Baseline is therefore unchanged
from §9: ~2,880/day plus ~4,320 when a stream is pending. `configProblems()`
now computes that sum and warns above 9,000/day.

To go faster than 3 min on an *unscheduled* go-live, the options are a quota
increase on the Cloud project or splitting channels across two keys — not a
shorter interval.

Three things that would break if changed carelessly:

- **The seed flag is per channel** (`seeded['youtube:<UC…>']`). A single shared
  flag would mean a channel added later is treated as already seeded, and its
  whole 50-item back catalogue posts to Slack. `migrateSeedFlag()` carries the
  old single `seeded.youtube` over to the id in `meta.youtubeChannelId` on
  first boot after the upgrade — without it San Jose re-seeds, and re-seeding
  posts nothing, which is the problem: a stream live at that moment would be
  recorded as backlog and never announced.
- **The ownership gate is now a list**, `meta.youtubeChannelIds`, written as
  each channel resolves. `detect.js` fails closed on an absent or unlisted
  `snippet.channelId`. This is the §9 flood guard; keep it a whitelist test.
- **A channel that fails to resolve at boot is not dropped.** It goes on an
  `unresolved` list and one entry is retried per uploads tick, so a transient
  `channels.list` error does not silently stop watching a channel for the
  lifetime of the container. Boot throws only if *no* channel resolves.

Slack cards now carry the channel title in the heading
(`🔴 YouTube · KAILASA LA — LIVE NOW`) instead of the small grey context line —
with six channels feeding one Slack channel, "which one is live" is the first
question a reader has.

### The deploy that never deployed (found while shipping this)

**Every Dokploy deploy since this app was created reported `done` in 1–4s and
never replaced the running container.** The app publishes host ports 8477 and
8478 (`publishMode: host`, both → 3000) with `replicas: 1`, and
`updateConfigSwarm` was `null`, so Swarm used **start-first**: the new task can
never bind ports the old task still holds, so it sat unschedulable while the
old container kept serving. `docker service update` returns immediately, so
Dokploy recorded success. What actually changed the running code was an
unrelated container restart picking up the last-built image — which is why
production was still running `a4d286d` (the pre-rewrite scrape code, with
`/admin/probe` present and `/admin/recent` absent) hours after §9's rewrite was
committed.

Fixed by setting `updateConfigSwarm` to `{"Parallelism":1,"Order":"stop-first"}`
via `application.update`. Note the shape: that endpoint's zod schema wants
Docker's **PascalCase** keys, and rejects `{parallelism, order}` with a bare
"Input validation failed". Deploys now roll the container properly, at the cost
of a few seconds of downtime — correct for one replica holding host ports.

Diagnosing this without shell access to the host: `docker.getContainersByAppNameMatch`
(`?appName=<app.appName>`) answers 200 for this API key and shows container
age, which is the only reliable proof a deploy took effect. Most other
`docker.*` and `traefikFiles` routes answer 401 for this key. `deployment.all`
reports `status: done` regardless, so **never trust it as evidence** — check
container age or `/status` on the app itself.

Also: port 8477 is a leftover duplicate of 8478 and nothing references it.
`autoDeploy` is off, so `POST /api/deploy/<refreshToken>` answers "Automatic
deployments are disabled" (and, once enabled, "Branch Not Match" unless the
body carries `ref: refs/heads/main`).

### Quota exhaustion on the first multi-channel boot

The first deploy came up with `403 exceeded your quota` on `channels.list`, so
five of six handles did not resolve. Two things came out of it:

- `start()` no longer throws when *no* channel resolves. It used to, which left
  no timers running at all — nothing would retry, and YouTube stayed dead until
  someone restarted the container by hand. It now starts anyway and the uploads
  tick retries one unresolved channel per interval, so the app heals itself when
  quota resets (midnight Pacific).
- **A stale-content guard was added** (`YOUTUBE_MAX_AGE_HOURS`, default 24).
  San Jose's stored dedupe set was built by the old code from a 15-entry feed,
  while discovery now reads 50 uploads — so the difference (~15–35 old videos)
  would have posted to Slack as new the moment quota returned. `isStale()` in
  `detect.js` records a finished video older than the cutoff via `suppress()`
  instead of announcing it. Live and upcoming are exempt: a broadcast can be
  created weeks before it starts, and a stream going live today is news however
  old its video object is. This also protects against a wiped `/data` volume
  replaying a back catalogue.

Verified: `scripts/selftest.mjs` resolves all six and lists uploads for each;
a full boot against a scratch `DATA_DIR` seeded all six silently (299 keys, one
upcoming stream on the watchlist, `meta.youtubeChannelIds` correct); and a boot
against a hand-written pre-multi-channel `state.json` logged the seed-flag
migration and skipped re-seeding San Jose. Not verified: behaviour in the
Dokploy container, and an actual go-live on one of the five new channels.

---

## 11. The 2026-09-19 restructure — one repo, many services

The user repositioned the repo as the **Temple Social Media App**: the single home
for all temple social-media automation, with more services planned. The notifier
is no longer the repo; it is one service in it.

**Every path in §§1–10 is now relative to `services/notifier/`.** `src/config.js`
means `services/notifier/src/config.js`, and so on. Nothing inside those files
changed in the move — the selftest resolved all six channels and posted to Slack
immediately afterwards, unmodified.

```
.env                      DOKPLOY_* only
.env.example
README.md                 service index
CLAUDE.md
docker-compose.yml        both services, build context = repo root
scripts/dokploy.mjs       repo-level, --app notifier|reels
services/notifier/        the Node app, its own .env / Dockerfile / README
services/reels/           the Python app (§12)
```

Three things about this layout that are load-bearing:

- **Each service's build context is its own directory, not the repo root.**
  Dokploy keeps `customGitBuildPath: '/'` and tells the applications apart by
  `dockerfile` (`services/notifier/Dockerfile` vs `services/reels/Dockerfile`),
  but it resolves the *build context* from the Dockerfile's own location. The
  first restructured deploy was written the other way — `COPY
  services/notifier/src ./src` — and failed with `"/services/notifier/src": not
  found` even though the path is correct in the repo, because inside the context
  that file is just `src`. Keep every COPY relative to the service directory, and
  keep `docker-compose.yml` on matching per-service contexts so a local build
  proves the hosted one. A service cannot share files with another service this
  way; if that is ever needed, publish them as a package rather than widening the
  context.
- **Each service owns its `.env`; the root `.env` holds only `DOKPLOY_*`.**
  `dokploy.mjs` pushes `services/<app>/.env` to that app and nothing else, so the
  notifier cannot receive Google Drive credentials and the reels service cannot
  receive the YouTube API key. The old single root `.env` was split on
  2026-09-19; `PORT`, `DATA_DIR` and `PUBLIC_URL` would have collided otherwise.
- **The GitHub repo is now `kailasas-jyothish/temple-social-media`** (public;
  Dokploy clones it with no deploy key). The name was already taken by a private
  placeholder repo holding one README, which was renamed to
  `temple-social-media-old` rather than deleted. After the rename, Dokploy's git
  source was updated explicitly with `application.saveGitProvider` — GitHub
  redirects the old URL, but a redirect is not something to leave a production
  deploy depending on — and a deploy was run to prove the new URL clones.
- **`scripts/dokploy.mjs` now takes `--app`** and has a `SERVICES` registry
  holding each app's Dokploy name, Dockerfile path, volume name and default port.
  `configure` also sets `updateConfigSwarm` to stop-first automatically now — §10
  explains why leaving it null makes every deploy a silent no-op — and a new
  `verify` command prints container age from `docker.getContainersByAppNameMatch`,
  because `deployment.all` says `done` regardless and is not evidence.

---

## 12. The reels service (`services/reels`, 2026-09-19)

### The request

> "I have the various temple teams uploading their pics of the daily and the
> special rituals that happen into a google drive… I need some automation that
> will create a video from those pictures using them as a slideshow with
> transitions, effects, animations etc. Now the important thing i want to
> mention here is I want an LLM to verify and pickup the best of images from the
> folders of the temples. But things such as adding transitions or animations
> the LLM must not do. We need to do that using ffmpeg."

Plus: daily the user drops a song in, selects the event folder, presses a start
button; the reel goes back into a `Reels` folder inside that same event folder;
branding elements (logo, end card) live in a `Vision Pics/Elements` folder and
the end card must be swappable by pasting a Drive link; a Slack notification
when the video is done, on a new channel with a new bot; Python; same Dokploy
instance.

**The LLM/ffmpeg split is a requirement, not an implementation detail.** The
model returns scores for images and nothing else — no transition names, no
durations, no effects. Keep it that way.

### Decisions taken with the user

| Question | Answer |
|---|---|
| Output | one combined reel per event; per-temple reels are a later flag, not built |
| Curation model | Groq, multi-key rotation. `qwen/qwen3.6-27b` — 5 images and 20MB per request, so batches of 4 at 512px |
| Trigger | a password-protected web UI; the only option that allows Drive folder browsing and a progress view |
| Drive auth | OAuth refresh token, not a service account — uploads are then owned by a real account with real storage quota |

### Facts established by building it

- **Renderer verified against synthetic footage** before any Drive access:
  6 stills + intro + end card + music planned to 21.2s and produced exactly
  21.2s, 1080x1920 h264 + 48kHz aac, and frame extraction confirmed the
  slideleft xfade, the Ken Burns zoom and the logo overlay. The same test lives
  in the approach `scripts/selftest.py` takes — build a thing, then look at it.
- **Timing algebra.** `total = n*(d - t) + t`, because each xfade overlaps the
  tail of one shot with the head of the next. Shot count is the inverse. `d`
  must exceed `t` and `config.problems()` refuses to start otherwise.
- **`zoompan` needs a 2x supersample.** Scaling up from the source drifts about
  a pixel per frame and reads as a stutter; pre-scale to 2160x3840 so zoompan
  only samples down. Motion expressions are written against `on` (the output
  frame index) rather than accumulating `zoom`, because the accumulation rounds
  and the rounding is visible mid-push.
- **Prefiltering before curation is what makes this affordable.** 8x8 dHash at
  Hamming distance <= 5 collapses upload bursts to the sharpest frame; Laplacian
  variance drops the soft ones. On synthetic folders it caught every planted
  tiny/blurry/duplicate and nothing else.
- **A Groq failure must not mean no reel.** Every image already carries a
  heuristic score, so a failed batch keeps it and the run continues; the Slack
  card names the mode used. A failed *job* posts a red card with the last 20
  lines of ffmpeg stderr — silence on failure is the worst outcome for a daily
  job.
- **`--workers 1` on uvicorn is load-bearing.** The job queue is in-process; a
  second worker would have its own queue and the UI would poll a process that
  knows nothing about the running job. One render worker is also correct on
  merit: zoompan uses every core it is given.
- **Google expires a refresh token after 7 days** while the OAuth consent screen
  is in *Testing*, with `invalid_grant` as the only symptom. The consent screen
  must be Internal or published to Production. Scope must be full
  `.../auth/drive`; `drive.file` only sees files the app itself created.

### Still unverified

Everything that needs credentials: Drive reads and writes, the Groq scores
themselves, Slack delivery, and a render from real photographs rather than
generated test cards. The renderer and the selection logic are proven; the
integrations are not.
