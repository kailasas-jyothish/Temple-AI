# Temple AI dashboard

One page for every Temple AI service. Each one gets a card with an **Open**
link, whether it is running, and the few numbers it reports about itself.

Deployed as the Dokploy app `Temple-dashboard` on
**http://157.180.15.165:8482**, behind `UI_PASSWORD` (any username).

## What each card shows

| Service | Port | Source | Shown |
|---|---|---|---|
| Notifier | 8478 | `/healthz`, `/status`, `/admin/attendance` (admin token) | uptime, channels resolved, scheduled streams, Garbha Mandir streams live today with links |
| Reels | 8479 | `/healthz` | jobs queued, config problems |
| Mantra tutorials | 8481 | `/healthz` | mantras, what is rendering, config problems |
| Panchaloha | 8480 | `/healthz` | up / down |

States: **Running** (health answered `ok`), **Needs attention** (it answered,
but reports a problem or the extra numbers could not be read), **Down** (no
answer). The server probes every `PROBE_INTERVAL_SECONDS` (30) on a timer, not
per page view, so a slow service cannot hold the page up. **Check now**
re-probes immediately, which is the quick way to see whether a deploy came back.

The page links to each service on its own port instead of embedding it:
proxying every UI through one port would break their own logins and paths.

## Adding a service

Add one entry to `SERVICES` in `src/services.js`: name, description, port,
health path, and a `read()` that turns its health JSON into facts. Keep the port
in step with `SERVICES` in `scripts/dokploy.mjs`.

## Running

```
npm install
cp .env.example .env     # UI_PASSWORD, NOTIFIER_ADMIN_TOKEN
npm run start:local      # http://localhost:3300
npm run check            # typecheck + tests
```

A local run probes the deployed services on `PUBLIC_HOST` unless `PROBE_HOST`
says otherwise.

## Deploying

```
node ../../scripts/dokploy.mjs create    --app dashboard
node ../../scripts/dokploy.mjs configure --app dashboard
node ../../scripts/dokploy.mjs push-env  --app dashboard
node ../../scripts/dokploy.mjs deploy    --app dashboard
node ../../scripts/dokploy.mjs verify    --app dashboard
```

## Why there is no "last deployed" time

Container age would need a Dokploy API key inside this container. That key can
redeploy or delete every app on the instance, and this is a password-protected
page on plain HTTP. It is not worth the risk for one timestamp:
`dokploy.mjs verify` gives the same answer from your own machine.
