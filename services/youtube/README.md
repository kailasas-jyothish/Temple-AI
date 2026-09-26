# youtube

The one service in this repo that talks to youtube.com directly. Other
containers call it over HTTP. Anything the YouTube Data API can answer (what's
live, titles, thumbnails) still belongs in the notifier. This service is for
things that need the actual video, starting with frames from a live stream.

## Why it exists

YouTube bot-blocks the Dokploy server's own IP (157.180.15.165). Tested on
2026-09-26 against 9 live temple streams and 6 yt-dlp player clients, with and
without PO tokens: every request got "Sign in to confirm you're not a bot".
Through a WireGuard VPN, with no cookies, the same requests returned frames on
the first try.

Everything needed for that sits in this one image:

| Piece | Role |
|---|---|
| WireGuard (`wg-quick`) | all egress goes out through the VPN |
| iptables kill switch | rejects any egress not on the tunnel, so a dropped VPN never falls back to the server IP |
| bgutil PO-token server | runs natively inside the container on `127.0.0.1:4416`, no sidecar |
| Deno | yt-dlp's JS challenge solver, and the runtime for the bgutil server |
| yt-dlp (pre-release) + bgutil plugin | resolves the live HLS manifest |
| ffmpeg | takes the frame |

The setup follows `Youtube_Archiver/ship`, minus cookies and minus
`privileged`. The container only needs `NET_ADMIN` and one sysctl.

## API

Every `/v1` route needs `Authorization: Bearer $GATEWAY_TOKEN`.

| Route | Returns |
|---|---|
| `GET /healthz` | `200 {"ok":true,"vpn":true,"po_token_server":true,"yt_dlp":"…"}`, or `503`. Local checks only, never calls out. |
| `GET /v1/egress` | `{"egress_ip","host_ip","via_vpn","endpoint","rotations"}`: the IP YouTube sees, and the VPN server in use. |
| `POST /v1/rotate` | Moves the tunnel to another VPN server now. Returns `{"changed", "endpoint", "egress_ip", "rotations"}`. |
| `GET /v1/frame/{videoId}?width=960` | `image/jpeg` from the live edge, with `X-Captured-At` (UTC) and `X-Channel-Id` headers. `width` is 160–1920. |

`/v1/frame` returns JSON errors with a stable `error` code:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_video_id` | not an 11-character video ID |
| 401 | `unauthorized` | missing or wrong token |
| 404 | `unavailable` | private, removed or unavailable |
| 409 | `not_live` | upcoming, ended, or not a live stream |
| 502 | `bot_blocked` | still flagged after `VPN_BOT_BLOCK_RETRIES` rotations (see below) |
| 502 | `extract_failed` / `ffmpeg_failed` | anything else; `detail` has the message |
| 503 | `vpn_down` | tunnel is down; the request was refused, not sent |
| 504 | `ffmpeg_timeout` | no frame within `FFMPEG_TIMEOUT_SECONDS` |

The API returns frames, not stream URLs, on purpose. googlevideo URLs are
bound to the IP that requested them, so a URL resolved here would not play
from any other container.

Example from another container on the same network:

```sh
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://youtube:8090/v1/frame/aIf4XCakAJU -o frame.jpg
```

A resolved manifest is cached per video for `MANIFEST_TTL_SECONDS` (20 min by
default), so repeat frames of the same stream take about 1s instead of 3–4s.
At most `MAX_CONCURRENT` requests run at once.

### When YouTube flags the exit

YouTube bot-checks by IP, and a VPN hostname such as
`nl-ams.prod.surfshark.com` hides many servers that share one peer key, each
with its own exit IP. On `bot_blocked`, the gateway moves the tunnel to the
next server and retries, up to `VPN_BOT_BLOCK_RETRIES` times (default 2).

- **Switching server.** It uses `wg setconf` with the new endpoint. A plain
  `wg set … endpoint` does not stick: the old server keeps sending on the
  live session and WireGuard roams back to it. `setconf` drops the session
  keys. `wg0`, its routes and the kill switch stay up the whole time, so
  nothing leaves on the host IP.
- **Finding servers.** Server IPs are resolved at boot, before the kill
  switch is up. Each rotation also looks the hostname up again through the
  tunnel, because the provider's DNS returns only 2 servers per query. The
  pool grows over time; in testing it went from 2 to 8.
- **Bursts.** A burst of failures moves the tunnel once. Rotations within
  `VPN_ROTATE_COOLDOWN_SECONDS` (default 30) count for every waiting request.

## Configuration

See `.env.example`. The WireGuard config can be given three ways, checked in
this order:

1. **Field by field**: `WG_PRIVATE_KEY`, `WG_ADDRESS`, `WG_DNS`,
   `WG_PEER_PUBLIC_KEY`, `WG_ENDPOINT` (plus optional `WG_ALLOWED_IPS`,
   `WG_PRESHARED_KEY`, `WG_KEEPALIVE`). To switch VPN location, change
   `WG_ENDPOINT` and `WG_PEER_PUBLIC_KEY` only.
2. **`WG_CONF_B64`**: a whole `.conf` file, base64 on one line.
3. **`WG_CONF_FILE`**: path to a mounted `.conf`.

Boot fails, and the container exits, if no config is given, if the tunnel
doesn't carry traffic within 30s, or if the egress IP still equals the host
IP. `GATEWAY_TOKEN` is required.

## Deploying

Deploy it as a **Dokploy Compose app** with compose path
`services/youtube/docker-compose.yml`, not as an Application. The compose file:

- sets the `NET_ADMIN` capability and the
  `net.ipv4.conf.all.src_valid_mark=1` sysctl that WireGuard needs;
- **creates the network** `temple-ai-internal` (overlay, attachable,
  `10.20.0.0/24`) on first deploy, so nothing is made by hand;
- gives the service the alias `youtube` on that network, with no ports and no
  domain;
- defaults `ALLOWED_SOURCES` to the network's own subnet.

Put the `.env.example` values in Dokploy's Environment tab. To use another
name or subnet, set `TEMPLE_NETWORK` / `TEMPLE_NETWORK_SUBNET`. Keep
`ALLOWED_SOURCES` matching the subnet.

Callers (notifier, reels) join `temple-ai-internal`. In Dokploy that's the
app's Advanced → Swarm Settings → Network. They then use
`http://youtube:8090`.

Access is limited in two layers:

1. **The network.** Only apps that joined `temple-ai-internal` can route to
   the container.
2. **A firewall inside the container.** The API port accepts
   `ALLOWED_SOURCES` only. If the container is ever also on
   `dokploy-network`, other apps there are still dropped.

For local runs, the repo-root `docker-compose.yml` has a `youtube` service.

### Tested on the Dokploy host (2026-09-26)

These were run as plain Docker and as a swarm service on `dokploy-network`,
the runtime Dokploy apps use:

- VPN came up on Surfshark nl-ams, with an egress IP different from the host's.
- `/healthz` returned 200. A call without a token got 401.
- Frames from Kailasa Dubai and NJB: 200 in 3–4s cold, and 1s from cache.
- An upcoming LA event returned 409 `not_live`.
- Kill switch: after deleting `wg0`, direct egress was blocked, `/v1/frame`
  returned 503 `vpn_down`, and `/healthz` returned 503.
- Network isolation:
  - A container on the internal network got a frame.
  - Containers on `dokploy-network` and on the default bridge were blocked,
    and so was the host.
  - With the container on both networks, the firewall alone still blocked
    `dokploy-network`.
- `services/youtube/docker-compose.yml`:
  - created the overlay network automatically; its subnet overlapped nothing
    on the host;
  - the VPN came up.
- Rotation:
  - three manual rotations each got a new exit IP;
  - a simulated `bot_blocked` rotated and retried, and the frame came back.

## Traps

- **Rebuild to update yt-dlp.** YouTube breaks extraction often, and the fixes
  ship in yt-dlp pre-releases. When frames start failing with
  `extract_failed`, rebuild first.
- **Keep the bgutil versions in step.** The server version (`BGUTIL_VERSION`
  in the Dockerfile) must match the pip plugin in `requirements.txt`.
- **Switch location if `bot_blocked` persists.** The gateway rotates servers
  within one location on its own. If `bot_blocked` still comes back after
  rotating, the whole location is flagged. Set another location's
  `WG_ENDPOINT` + `WG_PEER_PUBLIC_KEY` and redeploy.
- **Watch for camera-clock drift.** The frame shows whatever the stream
  shows. Temple cameras sometimes burn in a wrong clock: NJB read 14:27 when
  it was 16:42 IST. Trust `X-Captured-At`, not the image.
