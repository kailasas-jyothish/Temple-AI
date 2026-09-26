# Temple AI

Automation for KAILASA temple work, in one repo. Each service is its own
container, deployed independently to the same Dokploy instance from this one git
source (`github.com/kailasas-jyothish/Temple-AI`).

| Service | What it does | Stack | Dokploy app |
|---|---|---|---|
| [`services/notifier`](services/notifier) | Posts every new YouTube video, Short, premiere and live stream across six temple channels into Slack the moment it goes out, and marks Garbha Mandir live-stream attendance in a Google Sheet. Facebook path written, dormant until a Page token exists. | Node 22 | `Social-media-notifications` |
| [`services/reels`](services/reels) | Turns a day's ritual photos from Google Drive into a branded vertical reel — an LLM picks the images, ffmpeg does every visual effect — and files it back into Drive with a Slack ping. | Python 3.12 | `Temple-reels` |
| [`services/panchaloha`](services/panchaloha) | Panchaloha murthy cost calculator: final manufacturing cost per kg from weight, composition, wax and material rates, with AI-researched, source-checked rates a person approves. | Node 22 | not deployed |
| [`services/youtube`](services/youtube) | The one service that talks to youtube.com itself. Other services call its HTTP API for live-stream frames. WireGuard with a kill switch, PO tokens, Deno, yt-dlp and ffmpeg in one container, because YouTube bot-blocks the server's own IP. | Python 3.12 | not deployed yet |

`CLAUDE.md` carries the full working history: the decisions, the dead ends, and
the traps that have already cost a day each. Read it before changing deployment
or detection behaviour.

---

## Layout

```
README.md                 this file
CLAUDE.md                 project context and hard-won operational lessons
.env                      Dokploy credentials only, gitignored
docker-compose.yml        local run of every service
scripts/dokploy.mjs       repo-level Dokploy driver, --app <service>
services/
  notifier/               Node app + its own .env, Dockerfile, README
  reels/                  Python app + its own .env, Dockerfile, README
  panchaloha/             Node app + its own .env, Dockerfile, README
  youtube/                YouTube gateway (VPN + yt-dlp) + its own .env, Dockerfile, README
```

**Each service owns its own `.env`.** The repo-root `.env` holds nothing but
`DOKPLOY_*`, so `scripts/dokploy.mjs` pushes exactly one service's secrets to
exactly one application — the notifier never receives Google Drive credentials
and the reels service never receives the YouTube API key.

**Each service's Docker build context is its own directory.** Dokploy keeps
`customGitBuildPath` at `/` and distinguishes the applications by Dockerfile
path, but it resolves the build context from the Dockerfile's own location — so
every `COPY` is relative to `services/<name>/`, and a service cannot reach files
outside its own directory at build time.

---

## Deploying

```bash
node scripts/dokploy.mjs show    --app notifier
node scripts/dokploy.mjs setup   --app reels     # configure, push env, deploy, verify
node scripts/dokploy.mjs verify  --app notifier  # container age
node scripts/dokploy.mjs source  --app reels     # re-point the git source only (after a repo rename)
```

`verify` exists because Dokploy's `deployment.all` reports `done` whether or not
anything was replaced. The age of the running container is the only evidence a
deploy actually took effect — `CLAUDE.md` §10 has the full story.

## Local development

```bash
docker compose up --build              # every service
docker compose up --build panchaloha   # one of them
```

Each service's README covers running it without Docker, e.g.

```bash
cd services/panchaloha && npm install && npm run start:local   # http://localhost:3100
```
