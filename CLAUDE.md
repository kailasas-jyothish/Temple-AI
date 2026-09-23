# CLAUDE.md — project context for Temple AI

This file carries the full context of the conversations that built this repo, so
any future Claude Code session in this folder can pick up mid-stream without
re-deriving decisions or re-researching dead ends.

Created: 2026-09-05 → 2026-09-06 as `social-media-notifications`, a single Node
service. Renamed and restructured into a multi-service app on 2026-09-19 when the
reels pipeline was added. Renamed again on 2026-09-23 to **Temple AI** — the
home for all temple automation, not only social media — when the Panchaloha
calculator arrived (§14). GitHub repo: `kailasas-jyothish/Temple-AI`. The local
folder was `C:\Users\GD\Desktop\GD\social-media-notifications` and is meant to
become `…\GD\Temple-AI`; see §14 for whether that happened.

**Sections 1–10 are the notifier service** (`services/notifier`) and describe it
as it was when it lived at the repo root; the only thing that changed for it in
the restructure is where its files sit. §11 covers the restructure itself,
§12 the reels service, §13 attendance, §14 the Panchaloha calculator.

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
- **The GitHub repo was `kailasas-jyothish/temple-social-media`, and since
  2026-09-23 is `kailasas-jyothish/Temple-AI`** (§14). As `temple-social-media` (public;
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
- **`/n` and `\n` both mean a line break**, and `normalise_caption()` in
  `render.py` is the only place that decides so — the CLI, the web UI and the
  job API all go through `build_command`. The first version recognised `\n`
  alone; the user typed `/n` (same key, no shift), it stayed in the reel as
  visible text, and ordinary word-wrap happened to break at the same point, so
  it looked like the token had half worked. The CLI's pre-flight summary now
  prints the caption already broken, so a mistyped token shows up before the
  render rather than in the finished file.

### Video clips (2026-09-22)

The ask was that clips be used too, with the same pipeline that picks
photographs, and that shaky stretches be removed.

**A clip is never a candidate; its steady windows are.** `app/video.py` finds
them, and each window comes back carrying a full-resolution still at `path`.
From that line on nothing downstream can tell it from a photograph:
`prefilter.triage` measures it, the dHash collapses it against a near-identical
still, `curate.py` sends it to the model under the same rubric, and
`sequence.py` ranks it on the same 0–10 scale. `render.py` is the only module
that knows, and only to play the clip instead of panning the still. This is why
"use the same pipeline" needed almost no new pipeline.

- **A clip fills exactly one shot slot**, so `total = n*(d-t)+t` is untouched
  and a 30s reel is still 30s. Asserted: planned 19.20s, produced 19.20s.
- **Shake is a measurement, so it stays out of the model** — like the music
  window in `music.py`. It is the mean change in frame velocity across a
  window (not velocity itself: a steady pan is fast and fine, handheld jitter
  is slow and reverses constantly), by phase correlation between frames,
  normalised to frame height.
- **The sampling rate is load-bearing and nearly shipped wrong.** Handheld
  jitter is 2–6Hz, so at the first-guess 5/s it aliased: a 4.5Hz shake folded
  to 0.5Hz and measured *smoother* than a gentle walk, ranking the six
  calibration clips in the wrong order. At 15/s they rank correctly with a wide
  margin — locked off 0.0, smooth pan 0.26, gentle handheld 0.29, brisk walking
  3.3, shaky 25, violent 39. `VIDEO_SHAKE_THRESHOLD` is 1.6, inside the
  eleven-fold gap. Never lower `VIDEO_ANALYSIS_FPS` below ~12.
- **`MIN_IMAGE_PX` must not apply to video, and nor does a height rule.** The
  right measure is how far the 9:16 crop must stretch the source,
  `max(1080/w, 1920/h)`, because the binding side differs by orientation. A
  scan of the real archive settled it: most temple video is WhatsApp 480x848,
  whose *height* passes any sane height test while its *width* is what gets
  upscaled 2.25x. Real values — 1080x1920 1.0, 2160x3840 0.5, 720x1280 1.5,
  1920x1080 1.78, 480x848 2.26, then a cliff to 848x480 and 640x480 at 4.0.
  `VIDEO_MAX_UPSCALE` is 2.5, in that cliff. Drive reports the dimensions, so
  this is applied before download as well as in `analyse()`. The blur test
  still applies to both photographs and clips.
- **`walk_event` skips folders whose name contains "reel".** The service writes
  into a `Reels` folder inside the event folder, and the archive already holds
  `Final Diwali Reel`, `KB Final Reels` and `REELS` full of finished reels.
  This was harmless while only photographs were read — those folders hold none
  — but with clips ingested the service would splice last month's finished
  reels into this month's, which would read as a rendering fault rather than a
  sourcing one. Found by scanning the real Drive, not by testing.
- Windows from one clip need unique ids (`<fileId>#<n>`) — `sequence.py`
  dedupes on `id`, so every window of a clip would otherwise collapse into one.
- `-ss` before `-i` seeks by keyframe and can land a few frames short, and one
  short segment would shift every xfade offset after it. The clip filter ends
  `tpad=stop_mode=clone:stop_duration=1,trim=duration=<per>` so the length is
  exact regardless.
- Clips are cropped to fill, not letterboxed — the repo's rule is that content
  fills the frame and only branding is letterboxed. They are silent; the song
  carries the reel, and no clip audio is ever mapped.
- `VIDEO_SHARE` (0.5) caps the clip count, enforced inside `sequence.build` in
  *both* passes — the per-temple floor and the merit fill — or a temple that
  uploaded only video would spend the whole allowance before merit was reached.
- Cost is bounded the §12 way: clips are filtered on duration and size from the
  Drive listing before download, `VIDEO_MAX_CLIPS` caps the count,
  `VIDEO_MAX_ANALYSIS_SECONDS` caps how much of a long clip is examined, and
  analysis runs on a pool of 3. Measured: 11s to analyse a 120s clip.

### The copyright overlay is chosen per run (2026-09-22)

The end card was already selectable per run; the overlay was not, and a new
`2026-Copyright.png` arrived in `Elements`. `jobs.py` already applied an
override for *every* kind in `elements.KINDS`, so this was a picker, not a
mechanism: `pick_element(kind, …)` in `cli.py` (with `--logo`, which accepts
`none`) and a second `<select>` in the UI's Branding panel, both filled by one
`fillElementPicker()`.

Two things worth keeping:

- **Alias order decides the default, and it was pinning the wrong file.** The
  logo aliases ran `logo → frame → watermark → copyright`, and only the 2025
  overlay is called "…Frame…", so `frame` matched first and the newest file
  could never win however many were dropped in. `copyright` now comes before
  `frame`: both files land in the same tier and `modifiedTime` decides, which
  is the rule the end cards already followed. Verified — the default flipped
  from `ReelsFrame_2025_Copyright.png` to `2026-Copyright.png`.
- **`--logo none` must not go through `drive.parse_id()`.** That reads "none" as
  a malformed link and returns `""`, which `jobs.py` interprets as *no override*
  — i.e. asking for no overlay would have silently given the default one.
- The caption margin did not need moving: the 2026 overlay's own text occupies
  rows 1720–1817 against the 2025 file's 1722–1822, measured off the alpha, so
  `CAPTION_BOTTOM_MARGIN` 260 still clears it by ~60px. Worth re-measuring
  whenever a new overlay lands, because nothing enforces it.

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
- **Video against real temple footage.** The clip path is proven end to end on
  synthesised camera moves: shaky rejected, steady and panning kept, share cap
  held, reel length unchanged to 0.000s, frames looked at. The shake thresholds
  have never met a real handheld temple video, and that is the one number most
  likely to need moving — the job log prints the measured shake of every
  rejected clip, which is what to tune against.
- Whether the refresh token survives — the OAuth consent screen must be Internal
  or Production, or it dies after 7 days with `invalid_grant` as the only sign.

Outstanding, still needing the user:

1. The Caddy hostname, which becomes `PUBLIC_URL` (see "The edge, settled").
2. Confirmation that the OAuth consent screen is off *Testing*.

---

## 13. Attendance in Google Sheets (2026-09-22/23, notifier)

### The request

> "When the live stream of the respective temple starts, i need the automation
> to mark off attendance of temples that have started their live stream in a
> google sheet."

Specifically: only the **24/7 Garbha Mandir** stream counts, never a festival
puja or a satsang. Per date the sheet holds a Started / Yet to Start status,
the stream link, the local start time and a screenshot. The automation creates
its own rows and columns and depends on no human. Manual edits must survive.

### Decisions taken with the user

| Question | Answer |
|---|---|
| Credential | **Service account**, not the reels OAuth token — no 7-day `invalid_grant` expiry, no browser flow, access scoped to one shared sheet |
| Day boundary | **UTC**, which is also Guinea-Bissau local time, where the user reads the report |
| Clock in the cell | the **temple's** own timezone, correct abbreviation for the date (PDT vs PST) |
| Column order | **newest date at column B**, older pushed right |
| Duplicate starts | first one wins |
| Continuous stream | credited for **48h** from its start, then it must be restarted |
| Snapshot | real frame via **yt-dlp + ffmpeg**, thumbnail as fallback — and the fallback is what production uses, see below |

### The sheet as found

`1wk999_S72yIuUiQ70x3Ci-0h5TzzBenbeSjAmg9Z8_8`, tab
`24x7-Live-Stream-Monitoring` (id `471812663`) of *2.0 Global Temples
Attendance*: 59 temples in column A, six single date columns, and a summary
block whose COUNTIF formulas were **leftovers from a copied template** —
counting `"*Attended*"` and `"*Yes - Attended"` across 100+ columns that no
longer meant anything. Restructuring deleted the date columns and inserted a
sub-header row; the old formulas survived the shift and had to be cleared
separately (`F123:FO125`). Worth knowing that this workbook is full of such
copied-over leftovers.

Only 6 of the 59 temples have a YouTube channel. **They show `—`, never
`Absent`** — marking 53 unmonitored temples absent every day would be the
sheet lying confidently.

### No new dependencies

Service-account auth is one RS256 JWT exchanged for a bearer token, which
`node:crypto` signs natively (`src/google/auth.js`, ~40 lines). Pulling in
`google-auth-library` would have multiplied this service's dependency count for
that. `src/google/sheets.js` is a thin `fetch` wrapper over the v4 REST API.

### Naming is the real constraint, and it is not solved

300 real titles were pulled from the six channels before writing the matcher.
The result decided the design:

| Temple | How they title the 24/7 stream |
|---|---|
| LA | `Live Garbha Mandir 24/7`, `24/7 Garbha Mandir Livestream` |
| Toronto | `KAILASA TORONTO 24/7 LIVESTREAM` |
| San Jose | `#Live: Kailasa San Jose Garbhamandir Darshan` |
| Ohio | `🔴 LIVE  DARSHAN` — renaming to carry `Garbhamandir`, not yet used |
| Singapore | `Live Darshan of The Main Deities of Kailasa Singapore` — confirmed by the user 2026-09-23 as their Garbha Mandir stream |
| Houston | nothing live since April 2025 |

**Singapore needed a per-temple pattern, and it is deliberately the tail, not
the head.** `main deities of kailasa singapore` matches **1 of that channel's
22 live titles** — the right one — and ignores all 21 SPH satsangs
(`The SPH Reveals…`, `Live SPH Venkateshwara Darshan…`). A pattern of
`live darshan` would have counted every one of them as temple attendance.
It also leaks onto no other channel, which was asserted rather than assumed,
because per-temple patterns are only ever applied to their own channel.

Ohio needed **nothing**: `garbhamandir` is already shared, so their rename
takes effect with no deploy.

The shared patterns are `24/7`, `24x7`, `garbhamandir`, `garbha mandir`,
`garbha mandhir`. Measured against all 300 titles: **25 matches, all genuine,
zero false positives**. Houston and Singapore therefore read `Absent` every day
until their titles change — deliberately, because the alternative (matching
`Live Darshan …`) would count every ordinary satsang.

One title is genuinely ambiguous and was left matching:
`LIVE: 24/7 Adhika Maasam VENKATESHWARA PUJA` (LA). It carries `24/7`, so it
counts. Ask before narrowing this.

**Titles must be NFKC-normalised before matching.** These channels post
`𝟮𝟰/𝟳 𝗚𝗔𝗥𝗕𝗛𝗔 𝗠𝗔𝗡𝗗𝗜𝗥` in mathematical-bold characters, which are not the
letters they look like to any regex. Patterns are also matched against a
separator-stripped form, so one pattern covers `24/7`, `24 x 7` and `24-7`.

### Things that were got wrong first, and why they matter

- **A backfilled date must not be inserted at column B.** The first version
  always inserted at B, so marking a stream that started two days ago put
  `21-Sep` to the *left* of `23-Sep`. `ensureGroup` now counts how many
  existing groups are newer and inserts after them, which keeps the invariant
  "groups run newest-first, left to right" that everything else assumes.
- **`yt-dlp -f best[ext=mp4]` fails on every live stream.** A broadcast is
  served as HLS, so a container-named selector matches nothing and yt-dlp exits
  `Requested format is not available`. `-f best/bv*` works. Found by running it
  against a real stream, not by reading the docs.
- **Attendance would have come up blind on first deploy.** It learns about a
  stream from the live event, but that event only fires for a video the
  notifier has not seen — and after seeding, every already-running stream is
  already seen. A 24/7 stream up since yesterday would never be noticed and its
  temple would read Absent while visibly broadcasting. `discoverLiveStreams()`
  scans each channel once per UTC day (2 quota units per channel) and seeds the
  continuation memory. Verified from a completely fresh `DATA_DIR`.
- **A continuation credit must say it is one.** `11:10 AM PDT` in the 23-Sep
  column, for a stream that began on the 21st, reads as a start that morning.
  The cell now says `11:10 AM PDT (since 21-Sep)`.

### `=IMAGE()` cannot be verified through the API

A written `=IMAGE(...)` reads back as
`REF: "Please use a desktop web browser to allow access to fetch data from
external urls."` — Sheets does not evaluate it for an API client. **Whether the
picture renders can only be checked by opening the sheet in a browser.** There
is no `imageValue` in the v4 `CellData` schema, so `=IMAGE()` is the only
supported way to put a picture in a cell; the alternative (embedded objects) is
not per-cell.

Captured frames are served from `GET /snapshots/<file>`, **unauthenticated on
purpose** — Google fetches that URL server-side and carries no token. They are
frames of a public live stream. The base URL is
`http://157.180.15.165:8478` (`ATTENDANCE_SNAPSHOT_BASE_URL`), because the edge
is Caddy and there is no hostname for this app (§12, "The edge, settled").
Whether Google will fetch plain HTTP from a bare IP is moot in production,
because production does not use that URL — see the next section.

### yt-dlp cannot work from this host, and the fallback is better than expected

§9 predicted trouble and understated it. `POST /admin/attendance/snapshot`
against a real stream on the deployed container returns, verbatim:

```
ERROR: [youtube] mLcLd3AENdI: Sign in to confirm you're not a bot.
Use --cookies-from-browser or --cookies for the authentication.
```

**The only remedy yt-dlp offers is cookies, which is a load-bearing prohibition
of this project** (§1, §8). So the frame grab is off in production
(`ATTENDANCE_SNAPSHOT_ENABLED=false`) rather than running a doomed subprocess
every sweep. The code stays: it works from a residential IP — proven on the
user's laptop, where it captured a real frame that was extracted and looked at.

The fallback turned out to be the better answer anyway. **For a 24/7 broadcast
YouTube auto-generates the thumbnail from the stream itself**, so
`maxresdefault_live.jpg` is a 1280x720 frame of the garbha mandir — verified by
fetching and looking at it, side by side with the yt-dlp capture of the same
stream. It is served over HTTPS from `i.ytimg.com`, so `=IMAGE()` is pointed at
Google's own CDN and the bare-IP question disappears. `bestThumb(item.snippet)`
is carried on the queue entry, because only the API item knows which sizes
exist; `thumbUrl()` (hqdefault) is the last resort.

Diagnosis is permanent, not a one-off: the last attempt's outcome is in
`GET /admin/attendance` as `lastSnapshot`, and the probe endpoint forces one
and hands back stderr. "The cell shows a thumbnail" looks identical whether
yt-dlp was blocked, timed out, or was never installed.

### Deployed (2026-09-23)

Live on the Dokploy notifier, container rolled and verified by age three times
(`deployment.all` is still not evidence — §10). `GET /admin/attendance` on
`http://157.180.15.165:8478` reports attendance enabled, `23-Sep-2026` created,
and LA's stream tracked. The deployed service wrote LA's row itself.

**A git trap worth remembering: HEAD was on `caption-overlay`, not `main`.**
The session opened claiming `main`, and every attendance commit landed on the
feature branch; `git push origin main` then failed as "behind" for reasons that
had nothing to do with the push. `origin/main` had also moved (an empty merge
of PR #1 — `git diff --stat HEAD...origin/main` was empty, which is what made
rebasing obviously safe). Fixed by rebasing the branch onto `origin/main`,
fast-forwarding `main` to it, and resetting `caption-overlay` back to its
remote so the stale local branch cannot be force-pushed later by accident.
**Check `git rev-parse --abbrev-ref HEAD` before committing in this repo.**

Also: PowerShell 5.1's `Out-File -Encoding utf8` writes a **BOM**, which lands
in the commit subject as a leading `﻿`. Use
`[IO.File]::WriteAllText($p, $msg, (New-Object Text.UTF8Encoding $false))` and
`git commit -F`. An inline `-m @'…'@` here-string also mis-parses when the
message contains quotes.

### Quota

`discoverLiveStreams` is 12 units/day for six channels. The continuation check
is one `videos.list` per sweep — 144/day at the 600s default. `configProblems()`
now includes the sweep in its daily estimate. Negligible against §9's ~7,200.

### Verified

- Service account reads *and writes* (probe write to an unused cell, read back,
  cleared).
- The tab restructured: sub-header row, `Temple` in A1, frozen 2x1, 240px label
  column, 66px rows, three summary rows (`Started` / `Yet to Start` / `Absent`)
  with per-group COUNTIFs, and all six temples resolving to rows 3–39.
- Matcher: 25/143 live titles matched, zero false positives, NFKC cases pass,
  PDT↔PST switches by date, unknown timezone degrades to UTC rather than throwing.
- End to end against four genuinely-live streams: LA and San Jose taken, Ohio
  and Singapore correctly ignored, group placement sorted, a **real frame of the
  LA Garbha Mandir captured and looked at**, Slack success notice posted.
- The 48h rule firing for real: San Jose had been live 53h and was dropped from
  continuation with `it needs restarting` in the log.
- Fresh-`DATA_DIR` boot: discovery, credit, idempotent re-run, and the
  `yt-dlp is not installed` fallback path.
- Full app boot with the new imports; six channels seeded silently.

### Not verified

- **Whether the Snapshot cell actually shows a picture.** See above — Sheets
  will not evaluate `=IMAGE()` for an API client, so a human has to look. The
  URL itself is proven: HTTP 200, 318KB, a real frame.
- An `Absent` sweep at a real UTC midnight, and a first-ever go-live detected
  live by the poller rather than by a daily scan. Every mark so far came from
  the scan path, because all four live streams predate the feature.
- Ohio's and Singapore's patterns against a **live** match. Singapore's was
  measured against its own archive; Ohio's rename has not happened yet.

### The 48h rule is stricter than the goal, and should probably be revisited

On the first real day, **three of the four live temples read `Yet to Start`**:
San Jose (live 77h), Singapore (live 78h) and Ohio (title not renamed yet).
Only LA (31h) was credited.

The user's words were: *"we can mark them as present / live if they are
something like 48 hrs live. Cuz our main priority is to have them continuously
stream their garbhamandir live. Ideally they should be re-scheduling and
starting stream every once in 12 hrs, but for now it does not have to be the
caveat."* That reads as **leniency** — credit a stream even if it has been up
a long time — whereas the implementation treats 48h as an expiry, which
penalises exactly the temples that never stop streaming. That inverts the
stated priority. It is one value (`ATTENDANCE_CONTINUATION_HOURS`); raising it
effectively means "any currently-live matching stream counts". Flagged to the
user, awaiting their call.

### Credential hygiene

The key arrived as `complete-energy-507909-r5-6f7e0b3219f3.json` **in the repo
root and not gitignored** — the next `git add -A` would have published a live
credential to a public repo. Moved to `services/notifier/service-account.json`,
which is now gitignored, and delivered to the container as
`GOOGLE_SERVICE_ACCOUNT_JSON_B64` (base64 of the same file; a PEM cannot be a
single `.env` line otherwise). The service account is
`temple-attendance@complete-energy-507909-r5.iam.gserviceaccount.com`. The
Sheets API is enabled on that project; the **Drive API is not**, and is not
needed.

---

## 14. Panchaloha murthy calculator (`services/panchaloha`, 2026-09-23)

### The request

A calculator for the manufacturing cost **per kg** of a Panchaloha murthy, from
a step-by-step methodology the user supplied (a long spec pasted in the
session). The one number that matters is `FINAL RATE ₹__/kg`. Rules, fixed:
metals by composition (80:15:5 default, 70:25:5), wax = 10% of weight
(Beeswax/Thaenukku or Paraffin, separate rates), overhead 5% of raw material
only, labour = material rate after overhead, total = material + labour,
final = total ÷ weight. Rates typed in or researched by an LLM with web search
across Groq, Gemini, OpenAI and Claude — **the LLM never calculates**, never
invents a rate or source, and never overwrites a person's rate.

The same message asked to rename the repo, local and remote, to **Temple-AI**.
The pasted spec itself said to keep `temple-social-media`; the user's own
sentence won, because it was theirs and the spec was a template.

### Why it is a service and not a page in an existing one

Nothing to integrate into: there is no shared frontend, nav or settings system
across services, and the only LLM code (reels' `curate.py`) is Python behind a
build context the calculator cannot reach (§11). So it is a third service on
the notifier's pattern — Node 22, Express, its own `.env`, no build step — with
Groq and Gemini keys copied from `services/reels/.env` (same
`*_API_KEYS` comma-rotation convention). The Anthropic path uses the official
SDK (`@anthropic-ai/sdk`); the other three are plain `fetch`, as reels does.
`agent-native` was not adopted for the reasons in §12 ("Why not agent-native").

### Decisions worth not re-deriving

- **One engine, run in both places.** `src/calculator.js`, `decimal.js` and
  `catalog.js` have no Node imports; the server serves exactly those three at
  `/lib/` and the page imports them, so results update per keystroke and match
  `POST /api/calculate` by construction. Don't fork the maths into `app.js`.
- **BigInt fixed-point, rounded per money line.** Quantities exact; each line
  cost rounded half-up to the minor unit as produced; everything after is exact
  sums, so the on-screen breakdown adds up to the paisa. The per-kg rate is the
  only other rounding. The spec's §30 example is a test: ₹346.50/kg.
- **Only the selected wax rate is required.** The other is shown as reference
  and a blank there does not block a calculation that does not use it.
- **The model reports units as quoted; the server converts.** Unit conversion is
  arithmetic, so it stays out of the model like everything else.
- **Evidence gate.** Each provider returns the URLs its search tool actually
  produced (Groq `executed_tools`, Gemini grounding chunks resolved through
  their redirect, OpenAI `web_search_call` sources + `url_citation`s, Claude
  `web_search_tool_result` blocks + citations). A cited URL not among them is
  rejected as possibly invented; same site/different page passes with
  confidence capped at medium. Metals must be `scrap`; wax must be
  wholesale/supplier/retail. An answer with zero search results is
  `web_search_unavailable`, never a rate.
- **One research call at a time** (409 `busy`), and `UI_PASSWORD` basic auth,
  because each call is paid and takes 30s–2min.

### Found by running it, not by reading docs

- **`groq/compound` answers `model_not_found` for all six Groq keys.** None of
  the three Groq organisations has it. `openai/gpt-oss-120b` with
  `tools: [{type: "browser_search"}]` works and is the default; the provider
  still supports compound if an org gains it.
- **Gemini search grounding is unusable on the two current keys:** every
  grounded call is an immediate `429 exceeded your current quota`, and plain
  calls to `gemini-3.5-flash-lite` timed out at 25s. The Gemini provider is
  proven only against mocked responses.
- **OpenAI and Anthropic have no keys in this project**, so those two paths are
  also proven only by mocked tests (including the SDK's error classes and a
  `pause_turn` resume).
- **A verified source is not a correct number.** Two live Groq runs returned
  copper scrap at ₹607 and ₹650/kg, each from a real page the search returned,
  while a dated Delhi dealer list the same day showed armature copper at
  ₹1,468. The ₹650 page genuinely lists "Heavy Copper Scrap ₹650–780" — it is an
  undated generic page, and the model read it faithfully. Gun metal (₹1,085–1,138)
  and zinc (₹339–372) matched the dealer list. So `validate.js` now also warns
  when gun metal comes back dearer than copper (or paraffin dearer than
  beeswax), and the prompt asks for good-grade copper and cross-checking. This
  is why no researched rate is ever applied without a person pressing "Use".
- `extractJson` hung the test run: `lastIndexOf('{', -1)` clamps to 0, so a
  backwards scan over a string starting with `{` never terminates.
- `AbortSignal.timeout` does not hold Node's event loop open; a test of the
  timeout path needs its own timer (the listening server does it in the app).

### Verified

`npm run check` — `tsc` over the JSDoc types (strict) and 50 `node:test` tests:
both compositions, both waxes, decimal weights, both of the spec's worked
examples, every validation error, every research failure mode, all four
provider response shapes, the HTTP routes, and that `/api/config` never leaks a
key. Two live Groq research runs end to end (30s/50 pages, 116s/92 pages, all
five rates verified). The UI was rendered in headless Edge at desktop and
tablet widths, with a real research result in the review panel — that is how a
stray literal `null` in the panel was caught.

### Not done / open

- **Not deployed.** `scripts/dokploy.mjs` knows it (`--app panchaloha`, port
  8480, stateless) but no Dokploy application exists. The user's machine blocks
  bare IPs (§12), so it would be reached only once a Caddy hostname exists; it
  runs locally with `npm run start:local` meanwhile.
- The local folder rename: Windows will not rename a directory a running
  process holds as its working directory, so it could not be done from inside
  the session that did the GitHub rename.