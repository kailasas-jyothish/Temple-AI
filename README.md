# Temple Social Media App

Automation for KAILASA temple social media, in one repo. Each service is its own
container, deployed independently to the same Dokploy instance from this one git
source.

| Service | What it does | Stack | Dokploy app |
|---|---|---|---|
| [`services/notifier`](services/notifier) | Posts every new YouTube video, Short, premiere and live stream across six temple channels into Slack the moment it goes out. Facebook path written, dormant until a Page token exists. | Node 22 | `Social-media-notifications` |
| [`services/reels`](services/reels) | Turns a day's ritual photos from Google Drive into a branded vertical reel — an LLM picks the images, ffmpeg does every visual effect — and files it back into Drive with a Slack ping. | Python 3.12 | `Temple-reels` |

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
```

**Each service owns its own `.env`.** The repo-root `.env` holds nothing but
`DOKPLOY_*`, so `scripts/dokploy.mjs` pushes exactly one service's secrets to
exactly one application — the notifier never receives Google Drive credentials
and the reels service never receives the YouTube API key.

**Every Dockerfile builds from the repo root**, not from its own directory, and
addresses its files by full path (`COPY services/notifier/src ./src`). Dokploy
keeps `customGitBuildPath` at `/` for both applications and distinguishes them
only by the Dockerfile path.

---

## Deploying

```bash
node scripts/dokploy.mjs show    --app notifier
node scripts/dokploy.mjs setup   --app reels     # configure, push env, deploy, verify
node scripts/dokploy.mjs verify  --app notifier  # container age
```

`verify` exists because Dokploy's `deployment.all` reports `done` whether or not
anything was replaced. The age of the running container is the only evidence a
deploy actually took effect — `CLAUDE.md` §10 has the full story.

## Local development

```bash
docker compose up --build            # both services
docker compose up --build notifier   # one of them
```

Each service's README covers running it without Docker.
