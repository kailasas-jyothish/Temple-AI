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

### Creating the Slack app without a browser

The user cannot complete a browser OAuth (a site blocker cuts in the moment they
sign in), so the whole Slack app was created from the CLI. The route, which is
worth keeping:

1. Install the CLI. On Windows, `irm https://downloads.slack-edge.com/slack-cli/install-windows.ps1 | iex`
   — install it under an **alias** (`-Alias slackcli`), because `slack` already
   resolves to the Slack desktop app shim in `WindowsApps`.
2. `slackcli login --no-prompt` prints a `/slackauthticket <ticket>` slash
   command. Run that **inside Slack itself**, approve the modal, and Slack shows
   a challenge code. `slackcli login --ticket <t> --challenge <c>` finishes it.
   No browser at any point. Tickets expire within a few minutes — regenerate
   rather than debugging a failure.
3. The CLI stores an app configuration token (`xoxe.xoxp-…`) in
   `~/.slack/credentials.json`. `POST apps.manifest.create` with it and
   `services/reels/slack-app-manifest.json` creates the app.
4. `slackcli app install --app <app_id> -f` installs it. It needs a project
   directory, which for a non-Deno app is just `.slack/hooks.json` (`{"hooks":{}}`),
   `.slack/config.json` (`{"manifest":{"source":"remote"},"project_id":"<uuid>"}`)
   and `.slack/apps.json`. Do not pass `--environment` together with `--app`.
5. **The CLI never writes the bot token anywhere.** It comes from the endpoint
   the CLI itself calls: `POST apps.developerInstall` with the configuration
   token and **`app_id` alone** — adding `team_id` returns `invalid_argument`.
   The token is at `api_access_tokens.bot`. Re-running it is idempotent, so this
   is also how to recover the token later.

App `A0C2YM5Q6AZ` ("Temple Reels") in `kenya-kailasa`, posting to the private
channel `#temple-reel-notifier` (`C0C2U4GA16X`). A private channel returns
`channel_not_found` rather than `not_in_channel` until the bot is invited, which
looks like a wrong id and is not.

### Deployment

Dokploy application **`Temple-reels`** (`vtt6Wp3AV6yl95RaTUNBi`, swarm name
`temple-reels-6x6wbz`), created through `application.create` with
`{name, appName, description, environmentId}` against environment
`HHmD4d7IyTEhoeylNVwKt` — the same project as the notifier. Configured by
`node scripts/dokploy.mjs configure --app reels`: git source, Dockerfile path
`services/reels/Dockerfile`, stop-first swarm, `temple-reels-data` at `/data`,
and host port **8479 → 8000**.

Live and healthy as of 2026-09-19 — the ffmpeg image builds, the healthcheck
passes, and `/healthz` correctly reports the two credentials it is still
missing. The edge here is Caddy, which only serves hosts written into its own
config, so the UI is reached through a published port; the user is adding a
Caddy vhost in front of 8479 rather than exposing a login page over plain HTTP
on the IP. `PUBLIC_URL` stays empty until that hostname exists.

### The edge, settled (2026-09-20)

§10's note was right and worth stating in full, because the reels UI made it
matter and an afternoon went into re-deriving it:

**157.180.15.165 runs Caddy on 80 and 443, and Dokploy's Traefik is not in the
request path at all.** Evidence, not inference:

- Only 80, 443, 3000, 8478 and 8479 are open. There is no Traefik listener.
- Caddy answers port 80 for *every* Host with a blanket 308 to HTTPS —
  including hosts nothing has ever heard of.
- On 443 it has certificates for exactly two names, `panchanga.kailasa.ai` and
  `dock3.koogle.sk` (both real Let's Encrypt). Every other SNI fails the
  handshake. There is no wildcard for `kailasa.ai` or `koogle.sk`.
- A Dokploy domain record was created for the reels app on three hostnames that
  resolve to the server (`*.traefik.me`, `*.sslip.io`, `*.nip.io`). None got a
  certificate — Let's Encrypt will not issue for those shared suffixes, exactly
  as §10 recorded for sslip.io.
- A Dokploy domain with `path: /reels` on `panchanga.kailasa.ai` returned the
  **panchanga Next.js app's own 404**, proving Caddy proxies that hostname
  straight to its app rather than through Traefik. The record was deleted and
  panchanga was never affected (its root answered 200 throughout).

**So a new public hostname requires editing Caddy on the host.** The Dokploy API
cannot do it, whatever the Domains tab suggests. Neither can a DNS change alone.
Do not spend time on Dokploy domains, free wildcard DNS or path tricks again.

DNS facts worth not re-checking: `koogle.sk` has a wildcard to 88.99.208.109 (a
different machine that does not answer HTTP), `kailasa.ai` is Cloudflare with no
wildcard, and the user has access to neither zone.

The reels UI therefore sits on `http://157.180.15.165:8479` until someone adds a
Caddy vhost. The user's own machine blocks bare IPs (Cold Turkey), so **the CLI
is the way they actually use this**: `services/reels/reels.cmd`, or
`python -m app.cli`, which walks the same menus and runs the same pipeline
locally — Drive upload and Slack notification included. The hosted service stays
deployed and healthy; it is simply not the primary front end.

One ordering bug this shook out, worth not reintroducing: **a job's terminal
state is set last, after the Slack notification has been attempted.** Anything
watching a job stops the moment it reads `done`, and the CLI then exits, killing
the daemon worker thread mid-`chat.postMessage`. The first full CLI run uploaded
to Drive correctly and posted nothing at all.

### The big-folder stall (2026-09-20)

A run against `14-Sep-2026 Ganesha Chaturthi` — **1052 photographs across 40
temple folders** — was killed by hand after four minutes because it looked
hung. It was not hung; it was working at a rate that would have taken most of
an hour. The evidence is in `data/reels.log` for job `31edd111`: prefilter took
**104s serial** for 400 images, then curation started and Groq answered **429
Too Many Requests** on roughly every seventh call. The limit is real and is not
per key — it is `ITPM: Limit 7000` **per organisation**, and the six keys sit in
three organisations, so rotating keys buys only three parallel budgets.

The old `_retry` then slept Groq's `retry-after` (~45s) **inside Groq**, once
per batch, with Gemini configured and idle the whole time. Forty batches at
that rate is the whole afternoon.

Four changes, all about the same thing — the work must be bounded:

- **A rate limit is now a reason to switch models, not to wait.** `_retry`
  takes `patient`, false for every provider except the last in the chain: each
  key is still tried, but nothing sleeps while another model could take the
  batch. Groq 429s now cost milliseconds and Gemini answers.
- **Batches run concurrently** (`CURATION_WORKERS`, 4) and the stage has a wall
  clock (`CURATION_BUDGET_SECONDS`, 300). Whatever the budget does not cover
  keeps its heuristic score and says so in the log. A weaker selection is a bad
  day; a job that never returns is a broken tool.
- **The pool is sized from the reel, not from the event.** `_pool_size()` scores
  `CANDIDATES_PER_SHOT` (3) images per shot, capped by `MAX_CANDIDATES`, and the
  download cap follows at 5x that. An 11-shot reel now scores 33 images, not
  120, and downloads 165, not 400.
- **Prefilter runs on a pool** (`PREFILTER_WORKERS`, 8) and reports progress.
  Pillow and numpy both drop the GIL, so it is a straight win: 165 images in 12s.

Measured after, on the same folder, asking for 30s: **2m42s end to end** —
22s listing, 49s downloading 165 images, 12s prefilter, **14s curation**
(`groq+gemini`, 33/33 scored), 63s render, 32.7s of 1080x1920 h264 out.

Also, so that a long stage can never again be mistaken for a dead one:

- A job's progress is flushed to disk every 10s, not only at stage boundaries,
  so `reels --status` in a second window tells the truth mid-stage.
- A watchdog writes `still <stage> after Nm — <detail> (this is slow, not
  stuck)` into the job log every 3 minutes.
- ffmpeg gets `RENDER_TIMEOUT_SECONDS` (1800) and is killed past it; it had no
  timeout of its own, and the render worker is the only one.
- A failure message falls back to the exception class name. `str(MemoryError())`
  is `""`, and `FAILED:` with nothing after it is the worst line this can print.

### `Redirected but the response is missing a Location: header` (2026-09-20)

Every Drive upload over 8MB failed with this, at `drive.py`'s
`request.next_chunk()`. It is a regression from the Drive rewrite that added
parallel downloads, and the mechanism is worth knowing because nothing about the
message points at it:

- A resumable upload answers each intermediate chunk with **308 Resume
  Incomplete and no `Location` header**.
- httplib2 (0.32.0 here) lists **308 in `REDIRECT_CODES`**, so it raises
  `RedirectMissingLocation` before googleapiclient ever sees the progress.
- googleapiclient knows this and strips 308 in its own `build_http()`. Passing
  `build()` a hand-made `httplib2.Http` — which the rewrite did, to get a socket
  timeout — **opts out of that workaround**.

`service()` now does `inner.redirect_codes -= {308}` itself. Proven both ways: a
30MB probe uploads and deletes cleanly, and putting 308 back reproduces the
exact error. Note that **reads never notice**, which is why it survived a full
day of testing — the first upload since the rewrite was the one that failed.
`scripts/selftest.py` now asserts the exclusion, so it cannot come back quietly.

### The reel opens on the chorus, not on the first 15 seconds (2026-09-20)

`render.py` trimmed the song with `atrim=0:total`, so every reel used the
opening of the track. For `Ganesha Pancharatnam` that meant **the first ten
seconds are digital silence** (-70 LUFS, measured) followed by a quiet intro —
the reel opened on nothing.

The user asked whether ffmpeg can choose the section or whether an LLM is
needed. **It is a measurement problem, not a judgement one**, so it stays on the
ffmpeg side of the split, and `app/music.py` does it:

- `ebur128` reports momentary loudness every 100ms; the envelope is parsed off
  stderr. **Do not match `t:` and `M:` in one pattern** — builds put
  `TARGET:-23 LUFS` between them and the space after each colon is not
  guaranteed. That cost a debugging round.
- LUFS are converted to linear power before averaging; averaging decibels
  under-weights exactly the loud passages being looked for.
- Score is `0.7 x mean(whole window) + 0.3 x mean(first 3s)`, so a window that
  only blooms later does not win. Windows that run into the outro are penalised
  for free, because the quiet samples pull the mean down.
- The chosen start then snaps to the quietest sample within ±0.8s — a phrase
  boundary — so the reel does not begin mid-word.
- It fails to 0.0 (the old behaviour) for a track shorter than the reel, an
  unreadable file or a silent one, and the caller still loops the song.

Measured on the real track: picks 283.2s of 346s, -12.2 LUFS integrated against
-18.4 for the old first-15-seconds cut, and the first 3s of the finished reel
went from silence to -15.5 LUFS. The choice is written into the job log
(`song: using 283.2s–299.7s of 346s`) so a reel that sounds wrong can be
explained.

`MUSIC_PICK=start` restores the old behaviour; `--song-start 90` (or the
`song_start_seconds` job option) overrides both.

**Why not an LLM:** Gemini does accept audio, so it is technically possible, but
it would mean uploading the track on every run, it is unreliable about exact
timestamps, and it is not reproducible. Only worth revisiting if the ask becomes
semantic — "start on the line about Ganesha" — rather than energetic.

### Reel length is chosen per run

The web UI always had a target-length field; the CLI did not ask, so the `.env`
default was the only length anyone got. `pick_length()` now offers 15 / 20 / 30 /
45 / 60 / 90s — each shown with the number of photographs it will use — or any
value from 10 to 300 typed in. `--target` still skips the question, and an
explicit `SHOT_COUNT` says so rather than asking for something it will ignore.

Length is not only cosmetic any more: it sets the pool size, and therefore how
long the run takes.

### Captions (2026-09-22)

A caption is asked for per run and burnt over the photographs, under
`Overlay-gradient.png` from `Elements` — a 1080x1920 RGBA scrim, transparent at
the top and opaque at the base. Layer order is photos → scrim → text →
copyright frame, which is what was asked for and is also the only order in
which the type stays readable.

- **The text is the only new input; everything else is a standard.** White,
  Mart, centred, ≤3 lines, wrapped and shrunk from 76px towards 44px against
  the real font metrics via PIL. A characters-per-line rule overflows on a
  display face. This stays on the ffmpeg side of the §12 split: there is no
  judgement in it.
- **Scrim and text appear over the photographs only**, alpha-faded in and out
  across the transitions either side, so the intro and end cards stay clean.
  The window comes from each segment's start time on the output timeline, which
  `build_command` now records as it chains the xfades.
- **An empty caption is byte-identical to the old command** — asserted, not
  assumed. No gradient input, no drawtext, same duration.
- `drawtext` needs `expansion=none`. Without it a caption reading "100%
  attendance" fails the entire render, and one containing `%d` would silently
  become a date. Found by rendering one, not by reading the docs.
- Each line is its own `drawtext` with its own `x=(w-text_w)/2`. `text_align`
  would centre a block in one filter but only exists from ffmpeg 7.1, and the
  container runs Debian's 5.1.
- The caption text goes to a **file** per line and is passed as `textfile=`, so
  no user punctuation ever has to survive two levels of filter escaping.
  Verified with `Day 3: Nithya's 100% [special], see; more`. Paths still need
  escaping — `_escape_filter_path()` normalises separators and escapes `:` so a
  Windows drive letter is not read as an option separator.
- `CAPTION_BOTTOM_MARGIN` is 260 because the copyright frame's own text
  occupies rows **1722–1822** of 1920. That was measured off the asset's alpha
  channel, not judged by eye; at the old 220 the two nearly touched.
- **`overlay` is no longer a logo alias.** `Overlay-gradient.png` made it
  ambiguous, and the logo still resolves through `frame`/`copyright`. The font
  kind is in `FALLBACK_ANY`: `.otf`/`.ttf` belong to it alone, and no real font
  file is named after the word "font".
- **The font is a Devanagari cut, and its Latin glyphs carry the shirorekha** —
  a headline bar that reads as a strike-through on English words (digits are
  clean). This is the font, not the renderer: PIL draws it identically. The
  user chose Mart as the standard, so it is not worked around; a Latin cut
  dropped into `Elements`, or `CAPTION_FONT_FILE_ID`, replaces it.
- Falls back to DejaVu (installed in the image) if `Elements` has no font, and
  logs that it did. A missing font degrades the reel; it must not fail it.

### Why not agent-native for the UI (asked 2026-09-22)

`BuilderIO/agent-native` is TypeScript + React + Postgres (PGlite locally).
Adopting it would mean a second runtime, a database, a second Dokploy app and
an LLM key for its agent layer — and it would still be served on
`http://157.180.15.165:<port>`, because the blocker is Caddy on the host, not
the framework (see "The edge, settled"). It does not address the actual
problem. The CLI stays the front end.

### What is now proven, and what is not

Verified end to end against the real Drive (2026-09-19/20): Drive reads, two
uploads back into `Reels`, Groq and Gemini scoring on real photographs, the
branding assets resolving out of `Vision Pics/Elements`, renders from real
temple photographs at 1080x1920, and **the red failure card** reaching Slack
(`chat.postMessage` 200 at 21:47 on the 19th, after the ffmpeg failure).

Not yet proven:

- **The success card.** Both uploads pre-date the file log, so there is no
  record of `post_success` actually posting — only of `post_failure` doing so.
  Watch `#temple-reel-notifier` on the next real run.

- **The hosted service has never run a real job.** Everything above was the CLI
  on the user's machine; the container is healthy but only the UI has been
  exercised there. The Groq/Gemini failover in particular has only ever been
  watched locally.
- A run with a song attached against a large event, end to end.
- **A caption over real temple photographs.** It was proven against synthetic
  stills with the real gradient, font, logo and end card — frames extracted and
  looked at — but not yet on a real event, and never in the container.
- Whether the refresh token survives — the OAuth consent screen must be Internal
  or Production, or it dies after 7 days with `invalid_grant` as the only sign.

Outstanding, still needing the user:

1. The Caddy hostname, which becomes `PUBLIC_URL` (see "The edge, settled").
2. Confirmation that the OAuth consent screen is off *Testing*.
