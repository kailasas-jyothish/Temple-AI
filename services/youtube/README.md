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
| `GET /v1/egress` | `{"egress_ip","host_ip","via_vpn"}`: the IP YouTube sees. |
| `GET /v1/frame/{videoId}?width=960` | `image/jpeg` from the live edge, with `X-Captured-At` (UTC) and `X-Channel-Id` headers. `width` is 160–1920. |

`/v1/frame` returns JSON errors with a stable `error` code:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_video_id` | not an 11-character video ID |
| 401 | `unauthorized` | missing or wrong token |
| 404 | `unavailable` | private, removed or unavailable |
| 409 | `not_live` | upcoming, ended, or not a live stream |
| 502 | `bot_blocked` | YouTube flagged the VPN exit; switch location |
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

## Running it

The container needs `NET_ADMIN` and the `net.ipv4.conf.all.src_valid_mark=1`
sysctl:

```sh
docker build -t temple-youtube services/youtube
docker run -d --env-file services/youtube/.env \
  --cap-add NET_ADMIN --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -p 127.0.0.1:8090:8090 temple-youtube
```

Do not publish the port publicly. Other services reach it on the internal
network.

### Tested on the Dokploy host (2026-09-26)

These were run as plain Docker and as a swarm service on `dokploy-network`,
the runtime Dokploy apps use:

- VPN came up on Surfshark nl-ams, with an egress IP different from the host's.
- `/healthz` returned 200. A call without a token got 401.
- Frames from Kailasa Dubai and NJB: 200 in 3–4s cold, and 1s from cache.
- An upcoming LA event returned 409 `not_live`.
- Kill switch: after deleting `wg0`, direct egress was blocked, `/v1/frame`
  returned 503 `vpn_down`, and `/healthz` returned 503.
- Another container on `dokploy-network` called it by service name and got a
  frame.

It is not yet a Dokploy app. Deploying it needs `NET_ADMIN` and the sysctl on
the service. Check whether the Dokploy application settings expose these. If
they don't, deploy it as a Dokploy Compose app instead.

## Traps

- **Rebuild to update yt-dlp.** YouTube breaks extraction often, and the fixes
  ship in yt-dlp pre-releases. When frames start failing with
  `extract_failed`, rebuild first.
- **Keep the bgutil versions in step.** The server version (`BGUTIL_VERSION`
  in the Dockerfile) must match the pip plugin in `requirements.txt`.
- **Plan for VPN exits getting flagged.** A `bot_blocked` streak means the exit
  IP has been flagged. Keep a second location's endpoint and peer key ready.
- **Watch for camera-clock drift.** The frame shows whatever the stream
  shows. Temple cameras sometimes burn in a wrong clock: NJB read 14:27 when
  it was 16:42 IST. Trust `X-Captured-At`, not the image.
