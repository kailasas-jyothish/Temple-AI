"""YouTube gateway: the only service in the repo that talks to youtube.com.

Other containers call it over HTTP. It resolves a live stream through yt-dlp
(Deno for JS challenges, bgutil for PO tokens, all egress through WireGuard)
and returns a single JPEG frame taken by ffmpeg.

googlevideo manifest URLs are bound to the IP that requested them, so they are
useless outside this container. That is why the API returns frames, not URLs.
"""

import asyncio
import hmac
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query, Response

TOKEN = os.environ.get("GATEWAY_TOKEN", "")
PLAYER_CLIENTS = os.environ.get("PLAYER_CLIENTS", "web_safari,tv,default").split(",")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "3"))
MANIFEST_TTL = int(os.environ.get("MANIFEST_TTL_SECONDS", "1200"))
FFMPEG_TIMEOUT = int(os.environ.get("FFMPEG_TIMEOUT_SECONDS", "60"))
VPN_ENABLED = os.environ.get("VPN_ENABLED", "true") == "true"

if not TOKEN:
    raise SystemExit("GATEWAY_TOKEN is required")

VIDEO_ID = re.compile(r"^[\w-]{11}$")

app = FastAPI(title="YouTube gateway", docs_url=None, redoc_url=None)
_slots = asyncio.Semaphore(MAX_CONCURRENT)
# video_id -> (manifest_url, resolved_at, info subset)
_manifests: dict[str, tuple[str, float, dict]] = {}


class GatewayError(Exception):
    def __init__(self, status: int, code: str, detail: str, **extra):
        self.status, self.code, self.detail, self.extra = status, code, detail, extra


def _check_auth(authorization: str | None) -> None:
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given, TOKEN):
        raise HTTPException(401, {"error": "unauthorized"})


def _vpn_up() -> bool:
    return os.path.exists("/sys/class/net/wg0")


def _classify(message: str) -> GatewayError:
    m = message.lower()
    if "confirm you" in m and "not a bot" in m:
        return GatewayError(502, "bot_blocked", "YouTube bot-checked the VPN exit IP; try another VPN location")
    if "will begin" in m or "premieres in" in m or "not currently live" in m:
        return GatewayError(409, "not_live", message)
    if "private video" in m or "unavailable" in m or "removed" in m:
        return GatewayError(404, "unavailable", message)
    return GatewayError(502, "extract_failed", message)


def _resolve(video_id: str) -> tuple[str, dict]:
    cached = _manifests.get(video_id)
    if cached and time.time() - cached[1] < MANIFEST_TTL:
        return cached[0], cached[2]

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        # A live broadcast is HLS: never name a container here, `best[ext=mp4]`
        # matches nothing. One frame needs no audio, so video-only is fine.
        "format": "best/bv*",
        "extractor_args": {"youtube": {"player_client": PLAYER_CLIENTS}},
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise _classify(str(exc)) from None

    meta = {
        "title": info.get("title"),
        "channel_id": info.get("channel_id"),
        "live_status": info.get("live_status"),
    }
    if info.get("live_status") != "is_live":
        raise GatewayError(409, "not_live", "video is not live right now", **meta)
    url = info.get("url") or next(
        (f["url"] for f in info.get("requested_formats") or [] if f.get("vcodec") != "none"), None
    )
    if not url:
        raise GatewayError(502, "extract_failed", "no media URL in yt-dlp output", **meta)
    _manifests[video_id] = (url, time.time(), meta)
    return url, meta


def _grab(manifest: str, width: int) -> bytes:
    proc = subprocess.run(
        [
            "ffmpeg", "-loglevel", "error",
            "-i", manifest,
            "-frames:v", "1",
            "-vf", f"scale={width}:-2",
            "-q:v", "3",
            "-f", "image2pipe", "-vcodec", "mjpeg", "-",
        ],
        capture_output=True,
        timeout=FFMPEG_TIMEOUT,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise GatewayError(502, "ffmpeg_failed", proc.stderr.decode(errors="replace")[-300:])
    return proc.stdout


def _frame(video_id: str, width: int) -> tuple[bytes, dict]:
    if VPN_ENABLED and not _vpn_up():
        raise GatewayError(503, "vpn_down", "WireGuard interface is down; refusing to use the host IP")
    manifest, meta = _resolve(video_id)
    try:
        return _grab(manifest, width), meta
    except GatewayError:
        # A cached manifest can expire or rotate; resolve once more before failing.
        _manifests.pop(video_id, None)
        manifest, meta = _resolve(video_id)
        return _grab(manifest, width), meta


@app.get("/healthz")
def healthz():
    """Local-only liveness: VPN interface and PO-token server. Never calls out."""
    pot = False
    try:
        pot = urllib.request.urlopen("http://127.0.0.1:4416/ping", timeout=2).status == 200
    except Exception:
        pass
    vpn = _vpn_up() if VPN_ENABLED else None
    ok = pot and (vpn is not False)
    body = {"ok": ok, "vpn": vpn, "po_token_server": pot, "yt_dlp": yt_dlp.version.__version__}
    if not ok:
        raise HTTPException(503, body)
    return body


@app.get("/v1/egress")
def egress(authorization: str | None = Header(None)):
    """The IP YouTube sees. Calls out, so it is not part of the health probe."""
    _check_auth(authorization)
    ip = urllib.request.urlopen("https://ipinfo.io/ip", timeout=10).read().decode().strip()
    return {"egress_ip": ip, "host_ip": os.environ.get("HOST_IP"), "via_vpn": ip != os.environ.get("HOST_IP")}


@app.get("/v1/frame/{video_id}")
async def frame(
    video_id: str,
    width: int = Query(960, ge=160, le=1920),
    authorization: str | None = Header(None),
):
    """One JPEG frame from the live edge of a YouTube live stream."""
    _check_auth(authorization)
    if not VIDEO_ID.match(video_id):
        raise HTTPException(400, {"error": "bad_video_id"})

    async with _slots:
        try:
            jpeg, meta = await asyncio.to_thread(_frame, video_id, width)
        except GatewayError as e:
            raise HTTPException(e.status, {"error": e.code, "detail": e.detail, **e.extra})
        except subprocess.TimeoutExpired:
            raise HTTPException(504, {"error": "ffmpeg_timeout"})

    captured = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={
            "X-Video-Id": video_id,
            "X-Captured-At": captured,
            "X-Channel-Id": meta.get("channel_id") or "",
        },
    )
