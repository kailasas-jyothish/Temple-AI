# notifier

One of the services in the [Temple Social Media App](../../README.md).

Watches a set of YouTube channels and a Facebook Page and drops the link into
Slack the moment anything goes out — a video, a Short/Reel, a post, or a live
stream starting.

No cookies. No browser session. No logged-in scraping.

Default targets → Slack channel `C0C0PGXT46L`:

| Channel | Id |
|---|---|
| [`@kailasasanjoseus`](https://www.youtube.com/@kailasasanjoseus) | `UCT08Oyc76TM1Cn84mzwuGaA` |
| [`@KailasaLA`](https://www.youtube.com/@KailasaLA) | `UCq4_WXUpm8ein5ou4qESDcQ` |
| [`@kailasahouston9302`](https://www.youtube.com/@kailasahouston9302) | `UCl2cPxGNvohKD012qhU_NVQ` |
| [`@kailasaohio7452`](https://www.youtube.com/@kailasaohio7452) | `UCQUOYoDKqvPTi0iXvytDyng` |
| [`@kailasatoronto8217`](https://www.youtube.com/@kailasatoronto8217) | `UCRg-BvocTHMhQfvGfpt3W1A` |
| [`@KailasaSG`](https://www.youtube.com/@KailasaSG) | `UC9GvlY2FoWOBEj0pz1hOCVw` |

Override with `YOUTUBE_CHANNELS` (comma-separated handles, channel URLs or raw
`UC…` ids). Every card names the channel it came from.

---

## Straight answer on what works

| Platform | Detection | Latency | What it needs |
|---|---|---|---|
| YouTube — new video / Short / premiere | `playlistItems.list` poll of each channel's uploads | ≤ 30 s × channel count (3 min for six) | a free YouTube Data API key |
| YouTube — **live stream start**, scheduled | `videos.list` poll of the watchlist, every channel in one call | ~20 s | the same key |
| YouTube — **live stream start**, unscheduled | picked up by the uploads poll | ≤ 30 s × channel count | the same key |
| Facebook — posts / photos / videos / reels | Graph API `feed` **webhook** | 1–5 s | a Page access token |
| Facebook — live start | Graph API `live_videos` webhook | 1–5 s | a Page access token |
| Facebook — missed webhooks | Graph edge poll | 60 s | a Page access token |

**The YouTube half is fully solved and needs nothing from you but a domain.**

**The Facebook half has one hard requirement and there is no way around it:**
a Page access token, which means someone with **admin (or editor) rights on the
Page** has to click through a one-time OAuth on a free Meta developer app. That
is *not* a cookie and *not* a scraped session — it is the official API — but it
does need Page rights.

Without that token, the honest options are:

1. **Get the token.** ~20 minutes, free, permanent, instant and reliable. See
   [Facebook setup](#facebook-setup) below. This is the recommendation.
2. **Bridge something else into `POST /ingest`.** Make.com / Zapier / IFTTT have
   Facebook Page triggers where *they* own the Meta app — you still OAuth as a
   Page admin, and you get 1–15 minute lag instead of seconds, but you write no
   Meta code. The `/ingest` endpoint exists exactly for this.
3. **Paid third-party scraper APIs** (Apify, ScrapeCreators, Bright Data). These
   do work on public Pages with no admin rights, but: they cost money per poll,
   they lag by minutes so live-start detection is poor, they break whenever
   Facebook changes its markup, and they violate Meta's Platform Terms. Not
   built in — deliberately.
4. **RSSHub / rss-bridge / mbasic.facebook.com.** These are dead. Facebook walls
   logged-out page content now. Don't waste a day on them.

The Facebook code path (option 1) is written and ready. It stays dormant until
`FACEBOOK_ENABLED=true` and a token are set, so YouTube ships today and Facebook
switches on the day the token exists.

---

## How it works

```
                    ┌──────────────────────────────────────────┐
  Google WebSub ───►│ POST /websub/youtube   (HMAC-SHA1 check) │
       hub          └──────────────────────────────────────────┘
                                     │
  /live probe ──────┐                │
  videos.list ──────┼──────────────► dedupe store ────► Slack Block Kit card
  RSS backstop ─────┘                │                  (chat.postMessage)
                                     │
  Meta webhooks ───►┌──────────────────────────────────────────┐
                    │ POST /webhooks/facebook (HMAC-SHA256)    │
  Graph poll ──────►└──────────────────────────────────────────┘
  Make/Zapier ─────► POST /ingest  (bearer token)
```

Every detector funnels through one `announce()` call keyed on
`platform:kind:id`, so overlapping detectors can never double-post. State lives
in a JSON file under `DATA_DIR`, so restarts and redeploys don't replay old
content. Seeding is silent and **per channel**, so a channel added later has its
own back catalogue recorded rather than replayed into Slack, and the channels
already being watched are untouched.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | container health check |
| `GET  /websub/youtube` | hub verification handshake |
| `POST /websub/youtube` | signed content push from Google |
| `GET  /webhooks/facebook` | Meta verification handshake |
| `POST /webhooks/facebook` | signed page events from Meta |
| `POST /ingest` | generic inbox (`x-ingest-token` header) |
| `GET  /status` | full runtime state, incl. resolved channels (`x-admin-token`) |
| `GET  /admin/recent` | what the API reports per channel now; `?channel=@handle` for one |
| `POST /admin/test` | post a test message to Slack |
| `POST /admin/resubscribe` | force a WebSub lease renewal |
| `GET  /admin/attendance` | queue, tracked live streams, day state (`x-admin-token`) |
| `POST /admin/attendance/sweep` | run the attendance sweep now |
| `GET  /snapshots/<file>` | captured live frames — **public**, because Google fetches them for `=IMAGE()` |

---

## Attendance: the 24/7 Garbha Mandir sheet

When a temple's Garbha Mandir live stream starts, the service marks it present
in the `24x7-Live-Stream-Monitoring` tab of the *2.0 Global Temples Attendance*
spreadsheet. Four columns per date, newest date at column B:

| | Status | Started | Link | Snapshot |
|---|---|---|---|---|
| Kailasa USA LA | `Started` | `11:10 AM PDT` | ▶ Watch | *(frame)* |
| Ohio Kailasa | `Yet to Start` | | | |
| Seattle | `—` | | | |

- **Only live streams count**, and only ones whose title names the Garbha
  Mandir stream (`24/7`, `24x7`, `garbha mandir`, `garbhamandir`, …). A
  festival puja or a satsang is not attendance however live it is. Patterns
  live in `temples.json` and are matched after Unicode NFKC folding, because
  these channels post titles in mathematical-bold characters.
- **A temple with no configured channel shows `—`**, never `Absent`. Nothing is
  watching it, and saying otherwise would make the sheet lie.
- **The date column is UTC** (the report is read from Guinea-Bissau, UTC+0).
  The clock time in the cell is the temple's own local time, with the right
  abbreviation for that date — `PDT` in summer, `PST` in winter.
- **First one wins**, and a cell a person has typed into is never overwritten.
- **A continuous stream keeps counting** for `ATTENDANCE_CONTINUATION_HOURS`
  (48) from when it started, then stops — the temples are expected to restart
  the broadcast. The cell says `11:10 AM PDT (since 21-Sep)` when the credit
  comes from an earlier day's stream.
- **Absent** is written when a UTC day closes with the cell still pending.
- The snapshot is a real frame off the live stream via yt-dlp + ffmpeg, served
  from `/snapshots/`. That is a youtube.com request from a datacenter IP, so it
  may fail at any time; it falls back to the Data API thumbnail and the log
  says which was used.

```bash
node --env-file=.env scripts/attendance.mjs inspect              # layout + channel→row map
node --env-file=.env scripts/attendance.mjs restructure --confirm # one-time migration
node --env-file=.env scripts/attendance.mjs sweep                 # roll the day, credit, close
node --env-file=.env scripts/attendance.mjs mark --video <id>     # test one stream
node --env-file=.env scripts/attendance.mjs drop --date 22-Sep-2026 --confirm
```

Adding a channel means two edits: `YOUTUBE_CHANNELS` in `.env`, and an entry in
`temples.json` giving its exact row label in column A and its IANA timezone.
The selftest fails if a row label no longer exists in the sheet.

---

## Setup

### 1. Slack

1. https://api.slack.com/apps → **Create New App** → From scratch.
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `links:read`.
3. **Install to Workspace**, copy the `xoxb-…` token → `SLACK_BOT_TOKEN`.
4. In Slack, open the target channel and run `/invite @YourBotName`.
5. `SLACK_CHANNEL_ID=C0C0PGXT46L` is already set.

### 2. YouTube API key (required)

https://console.cloud.google.com → new project → enable **YouTube Data API v3**
→ Credentials → **API key** → `YOUTUBE_API_KEY`.

Every call costs 1 quota unit (never `search.list`, which costs 100), and the
free allowance is 10,000 units/day. The uploads poll takes **one channel per
tick**, round-robin, so that cost does not grow with the number of channels —
86400/`YOUTUBE_UPLOADS_POLL_SECONDS` + 86400/`YOUTUBE_LIVE_POLL_SECONDS` ≈
7,200/day at the defaults, whatever the channel count. What grows instead is
how long it takes to come back round to any one channel: 30 s × 6 = 3 minutes.

Shortening the interval to buy latency is what would break the budget — six
channels polled every 30 s each would be 17,280 units/day. If you need faster
than 3 minutes on an *unscheduled* go-live, either request a quota increase for
the project or split the channels across two keys/deployments. Scheduled
streams and premieres are unaffected: once discovered they sit on the watchlist,
which is polled for all channels in a single call every 20 s.

### 3. Deploy on Dokploy

The app is named **`Social-media-notifications`** in your Dokploy instance.

1. Push this repo to GitHub, then in the Dokploy app:
   - **Provider** → GitHub (or Git URL) → this repo, branch `main`
   - **Build Path** → `/`
   - **Build Type** → `Dockerfile`, path `services/notifier/Dockerfile`
     (the build context is that directory, so every `COPY` inside is relative
     to it)
2. **Domains** → add a hostname, port `3000`, HTTPS on (Traefik gets the cert).
   Put that exact URL in `PUBLIC_URL` — WebSub and Meta call back to it.
3. **Advanced → Volumes** → mount a volume at `/data` so the dedupe store
   survives redeploys.
4. **Environment** → paste the contents of `services/notifier/.env`.
5. **Advanced → Swarm → Update Config** → `{"Parallelism":1,"Order":"stop-first"}`.
   Without it, deploys report success and change nothing — see `CLAUDE.md` §10.
6. Deploy. Then, from your machine:

```bash
curl -X POST "$PUBLIC_URL/admin/test" -H "x-admin-token: $ADMIN_TOKEN"
curl     "$PUBLIC_URL/status"      -H "x-admin-token: $ADMIN_TOKEN"
```

Or drive it through the API instead of the UI:

```bash
# from the repo root — --app notifier is the default
node scripts/dokploy.mjs probe                   # discover the API surface
node scripts/dokploy.mjs show   --app notifier   # find the app, print its config
node scripts/dokploy.mjs setup  --app notifier   # configure, push env, deploy, verify
node scripts/dokploy.mjs verify --app notifier   # container age — the only proof a deploy rolled
```

**Uptime:** Dokploy runs the container under Docker with a restart policy and
its own healthcheck, on your always-on server. Nothing depends on your laptop.

### 4. Facebook setup

Only after someone with Page admin rights is available.

1. https://developers.facebook.com/apps → **Create App** → *Business*.
   Leave it in **Development mode** — no App Review needed for your own Page.
2. Add the **Webhooks** product → object **Page**:
   - Callback URL: `https://<your-domain>/webhooks/facebook`
   - Verify Token: the `FACEBOOK_VERIFY_TOKEN` from `.env`
   - Subscribe to fields: **`feed`** and **`live_videos`**
3. Add **Facebook Login** → Graph API Explorer → request
   `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`.
4. Exchange for a long-lived token, then `GET /me/accounts` to get the Page
   token (Page tokens derived from a long-lived user token do not expire):
   ```bash
   curl "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN"
   curl "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN"
   ```
5. Subscribe the app to the Page:
   ```bash
   curl -X POST "https://graph.facebook.com/v21.0/PAGE_ID/subscribed_apps?subscribed_fields=feed,live_videos&access_token=PAGE_TOKEN"
   ```
6. Fill `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`, `FACEBOOK_APP_SECRET`,
   set `FACEBOOK_ENABLED=true`, redeploy.

### Bridging Facebook via Make/Zapier instead

Point the automation at:

```
POST https://<your-domain>/ingest
x-ingest-token: <INGEST_TOKENS value>
{"platform":"facebook","kind":"post","id":"{{post_id}}","url":"{{permalink}}","title":"{{message}}"}
```

`kind` is one of `post photo video reel live share link`. Same dedupe, same card.

---

## Local development

```bash
cd services/notifier
npm install
npm run selftest          # resolves every channel, lists uploads, Shorts probe, Slack
npm run dev               # runs with --env-file=.env and --watch

# from the repo root
docker compose up --build notifier
```

`npm run selftest` is the fastest way to confirm credentials before deploying —
it posts one message to Slack if a token is configured, and skips cleanly if not.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that
matter: `PUBLIC_URL`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `YOUTUBE_CHANNELS`,
`YOUTUBE_API_KEY`, and the Facebook block.

`YOUTUBE_CHANNELS` is comma-separated. The older single-channel
`YOUTUBE_CHANNEL` is still read and unioned in, so an existing deployment keeps
working — but a deployment whose env sets only `YOUTUBE_CHANNEL` watches only
that one channel. Check `GET /status` after deploying: `youtube.channels` should
list every channel you expect.

Notable defaults: live watchlist poll 20 s, uploads poll 30 s per tick (one
channel per tick), Facebook poll 60 s, WebSub off, and — when enabled — a
WebSub lease renewed every 12 h (Google caps leases at 5 days).
