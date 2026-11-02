# Temple AI dashboard

One page for every Temple AI service. Each one gets a card with an **Open**
link, whether it is running, and the few numbers it reports about itself.

Deployed as the Dokploy app `Temple-dashboard` at
**https://temple.unclutch.dev:8443**. It is also reachable at
`http://temple.unclutch.dev:8080` and `http://157.180.15.165:8482`. All three
sit behind `UI_PASSWORD` (any username).

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

## The gateway: every tool from one hostname

The dashboard proxies each service at `/<service-id>/` (`src/gateway.js`). For
example, `/festival-budget/` and `/reels/` are forwarded to that service's
container (`PROBE_URL_*`, by its Swarm name) with the prefix stripped.

- **One password.** The dashboard's login runs first. The gateway then removes
  the visitor's credential and injects the service's own: `UPSTREAM_PASSWORD_<ID>`
  as basic auth, or `UPSTREAM_TOKEN_REELS` / `NOTIFIER_ADMIN_TOKEN` as
  `x-admin-token`.
- **Bodies stream both ways**, so uploads and rendered videos are never buffered.
- **Redirect `Location` headers and cookie `Path`s are rewritten** to keep the
  prefix. An upstream `WWW-Authenticate` header is dropped, so that the browser
  never asks for a second password.
- **Every service page uses relative URLs** (`api/...`, not `/api/...`), so it
  works on its own port and under a prefix. Keep it that way when editing a UI.

Why port 8443: `temple.unclutch.dev` is proxied by Cloudflare, and Caddy owns
80/443 on the host with no vhost for that name, so the bare hostname gives
**525**. Cloudflare forwards its alternate ports to the same port on the origin,
which bypasses Caddy. The app publishes:

- **8443 → 3443** for TLS. The certificate is self-signed and baked in at
  build. Cloudflare "Full" mode accepts it; "Full (strict)" would answer 526 and
  needs `TLS_CERT_PEM_B64`/`TLS_KEY_PEM_B64` from a Cloudflare Origin CA cert.
- **8080 → 3300** for plain HTTP.

The bare `https://temple.unclutch.dev` needs one Caddy site block on the host:

```
temple.unclutch.dev {
    reverse_proxy localhost:8482
}
```

Whoever administers Caddy can add it at any time, and nothing else changes.

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
