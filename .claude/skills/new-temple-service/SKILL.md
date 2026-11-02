---
name: new-temple-service
description: Create a new service in the Temple-AI repo (services/<name>) and wire it end to end - Python managed by uv, a CLI, a web UI, a dashboard card, Dokploy deploy on its own port at http://157.180.15.165:<port>. Use whenever the user asks for a new temple tool, automation, service, app, calculator, bot or pipeline to be added to Temple AI, even if they don't say "service".
---

# New Temple AI service

The user does not want to explain infrastructure. They describe *what the tool
does for the temple*; everything below is decided already. Ask only about the
tool's behaviour, and only what you cannot reasonably assume.

## What every service gets (non-negotiable)

1. **Python 3.12 + uv.** `uv add`, `uv run`, `uv sync`, `uv lock`. Never `pip`,
   never `python -m venv`, never `requirements.txt`. Commit `uv.lock`. The
   Dockerfile installs with `uv sync --frozen`. (Older services - reels,
   youtube, mantra-tutorials' aligner - still use pip; don't copy them.)
   Use **Node 22** only when the job genuinely needs it (a Node-only library,
   or extending an existing Node service). Say why in one line. A Node service
   copies `services/panchaloha` (Express, no build step, `npm run check`).
2. **A CLI** (`app/cli.py`, plus `<name>.cmd` so the user can double-click it
   on Windows). The user's own machine blocks the server's bare IP, so for them
   **the CLI is often the real front end**: it must run the full pipeline
   locally.
3. **A web UI** (`app/ui/index.html`, single page, no build step) served by
   FastAPI, behind basic auth (`UI_PASSWORD`, any username) except `/healthz`.
4. **One implementation.** The work lives in `app/core.py`; CLI, UI and API
   all call it. Never duplicate logic into a front end.
5. **A dashboard card** in `services/dashboard/src/services.js`, fed by
   `/healthz` (`ok`, `uptime`, `problems[]`, plus any facts worth showing).
6. **Hosted on the host at its own port**: `http://157.180.15.165:<port>`, a
   Dokploy app `Temple-<name>`. Ports run 8478, 8479, ... upward; the scaffold
   takes the next free one from `scripts/dokploy.mjs`.

## Step 1 - scaffold

```
uv run .claude/skills/new-temple-service/scaffold.py <kebab-id> "<one sentence: what it does>" [--state] [--title "Display Name"]
```

`--state` if it keeps files (outputs, caches, a queue): it gets a `/data`
volume. Stateless otherwise.

It creates `services/<id>/` (pyproject, uv.lock, Dockerfile, app/, UI, tests,
`.env.example`, `<id>.cmd`, README), runs `uv lock` and the generated tests, and
patches the shared files: `scripts/dokploy.mjs` (SERVICES registry),
`services/dashboard/src/services.js`, the dashboard `.env.example`
(`PROBE_URL_<ID>=`), `docker-compose.yml`, and the README service table. It
writes nothing if any anchor has moved; then do that file by hand.

## Step 2 - build the real thing

Replace the placeholder in `app/core.py`, then adapt, in this order:
`config.py` (env vars and `problems()`), `cli.py` (real flags),
`main.py` (real routes), `ui/index.html`, `tests/`. Rules from this repo that
apply to whatever it is:

- **Secrets** go in `services/<id>/.env` (gitignored), mirrored as names only in
  `.env.example`. Each service owns its `.env`; the root `.env` holds only
  `DOKPLOY_*`. Never commit a key, a service-account JSON, a song or any
  content file (audio, bundles, media). Never use cookies or a logged-in
  scraping session - an explicit project rule.
- **LLM use**: if a model is involved, it judges (scores, extracts, classifies);
  deterministic code does everything else (maths, rendering, timings). No LLM
  arithmetic. Have a non-LLM fallback so a model failure is not "no result".
- **Long jobs** (anything over a few seconds): follow `services/reels/app/jobs.py`
  - in-process queue, one uvicorn worker (already the Dockerfile default),
  progress flushed to disk, a watchdog log line, and the job's **terminal state
  set last** (after any Slack/Drive side effect, or the CLI exits and kills it).
  A failed job must announce itself, never go silent.
- Slack: each tool that posts gets its own bot/channel; use `chat.postMessage`
  via `fetch`/`urllib`, no SDK needed.
- Comments explain *why* (quota, a trap, a measurement), never *what*.
- Verify by looking at output, not just by a green test: run the CLI for real,
  load the UI, hit the API with and without the password.

Local run: `cd services/<id>; copy .env.example .env; uv run python -m app.cli run ...`
and `... serve` (UI on `http://localhost:<port>`).

## Step 3 - dashboard

If the tool has numbers worth showing, add them to `/healthz` and to the card's
`read()` in `services.js` (`facts`, `problems`, optional `items`). Then
`cd services/dashboard && npm test`.

## Step 4 - record it

Add a short section to `CLAUDE.md` (next number after the last) covering the
request, decisions and *why*, traps hit, what was verified and what was **not**.
The README table row is already added by the scaffold; make the description
accurate. Keep `.env.example` in sync with every variable.

## Step 5 - host it

Hosting needs the code on GitHub (`kailasas-jyothish/Temple-AI`, branch `main`),
because Dokploy clones it.

1. `git rev-parse --abbrev-ref HEAD` - this repo has been committed to the wrong
   branch before. Commit only this service's files plus the shared patches; the
   working tree usually holds the user's unrelated edits (leave them). On
   PowerShell write commit messages with `git commit -F <file>` saved as UTF-8
   **without BOM**.
2. **Ask the user before `git push`** (project rule: nothing is pushed without a
   go-ahead; this applies even though they asked for hosting). Everything after
   that needs no further questions.
3. Deploy, from the repo root:
   ```
   node scripts/dokploy.mjs create --app <id>      # once, makes the Dokploy app
   node scripts/dokploy.mjs setup  --app <id>      # configure + push env + deploy + verify
   ```
   `configure` sets the git source, Dockerfile path, **stop-first** swarm
   updates (without it every redeploy silently does nothing), the `/data`
   volume if stateful, and host port -> 8000. Put the real `UI_PASSWORD` in
   `services/<id>/.env` before `push-env`; `.env.deploy` (gitignored) wins over
   `.env` if the local file holds Windows paths.
4. **Do not trust `deployment.all` saying `done`.** Prove it:
   `node scripts/dokploy.mjs verify --app <id>` (container age: seconds or
   minutes means it rolled, hours means it did not), then
   `http://157.180.15.165:<port>/healthz` answers 200.
5. **Dashboard probe.** A container cannot reach its own host's public IP, so
   the dashboard probes by Swarm service name. Get it with
   `node scripts/dokploy.mjs show --app <id>`, add
   `PROBE_URL_<ID>=http://<swarm-name>:8000` to `services/dashboard/.env`, then
   `push-env` and `deploy` with `--app dashboard`. Until then the new card shows
   red. Confirm the card is green at `http://157.180.15.165:8482`.
6. Tell the user the URL, the CLI command, and anything unverified.

## Known limits to state honestly

- Ports are plain HTTP on the bare IP. A hostname needs a Caddy vhost on the
  host, which neither this repo nor the Dokploy API can add (CLAUDE.md §12).
  Don't spend time on Dokploy domains or path routing.
- The scaffolded Dockerfile has never been built on this machine (no Docker);
  the first Dokploy build is the proof. If it fails on the `uv` image tag,
  check `ghcr.io/astral-sh/uv` for a current tag and fix it in the template
  too (`templates/Dockerfile.tpl`).
- Anything the service needs from a third party (API keys, Drive/Sheets access,
  a Slack app) the user must supply; say exactly which, up front, and ship the
  parts that work without it (`problems()` reports what is missing).
