"""Environment parsing and startup validation.

Mirrors the notifier's src/config.js: one frozen object, plus a problems()
function that surfaces misconfiguration at boot instead of at 3am.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _load_env_file() -> None:
    """Local convenience only.

    In the container every value arrives from Dokploy and this file does not
    exist. Values already in the environment always win, so exporting one in the
    shell overrides the file rather than the other way round.
    """
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)


_load_env_file()


def _str(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _int(name: str, default: int) -> int:
    try:
        return int(_str(name) or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(_str(name) or default)
    except ValueError:
        return default


def _bool(name: str, default: bool = False) -> bool:
    v = _str(name).lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _list(name: str) -> list[str]:
    return [p.strip() for p in _str(name).split(",") if p.strip()]


@dataclass(frozen=True)
class Google:
    client_id: str = field(default_factory=lambda: _str("GOOGLE_CLIENT_ID"))
    client_secret: str = field(default_factory=lambda: _str("GOOGLE_CLIENT_SECRET"))
    refresh_token: str = field(default_factory=lambda: _str("GOOGLE_REFRESH_TOKEN"))


@dataclass(frozen=True)
class Drive:
    root_folder_id: str = field(default_factory=lambda: _str("DRIVE_ROOT_FOLDER_ID"))
    songs_folder: str = field(default_factory=lambda: _str("DRIVE_SONGS_FOLDER_NAME", "Songs"))
    elements_folder: str = field(default_factory=lambda: _str("DRIVE_ELEMENTS_FOLDER_NAME", "Elements"))
    reels_folder: str = field(default_factory=lambda: _str("DRIVE_REELS_FOLDER_NAME", "Reels"))
    share_reel: bool = field(default_factory=lambda: _bool("DRIVE_SHARE_REEL", False))
    logo_file_id: str = field(default_factory=lambda: _str("LOGO_FILE_ID"))
    endcard_file_id: str = field(default_factory=lambda: _str("ENDCARD_FILE_ID"))
    intro_file_id: str = field(default_factory=lambda: _str("INTRO_FILE_ID"))


@dataclass(frozen=True)
class Groq:
    # Comma-separated so several keys can share the load; a 429 rotates to the
    # next one rather than failing the job.
    api_keys: list[str] = field(default_factory=lambda: _list("GROQ_API_KEYS") or _list("GROQ_API_KEY"))
    model: str = field(default_factory=lambda: _str("GROQ_MODEL", "qwen/qwen3.6-27b"))
    # The model accepts 5 images per request; 4 leaves headroom under the 20MB
    # request cap and keeps a malformed batch cheap to lose.
    batch_size: int = field(default_factory=lambda: _int("GROQ_BATCH_SIZE", 4))
    timeout_seconds: float = field(default_factory=lambda: _float("GROQ_TIMEOUT_SECONDS", 90.0))
    enabled: bool = field(default_factory=lambda: _bool("CURATION_ENABLED", True))


@dataclass(frozen=True)
class Slack:
    bot_token: str = field(default_factory=lambda: _str("SLACK_BOT_TOKEN"))
    channel: str = field(default_factory=lambda: _str("SLACK_CHANNEL_ID"))
    upload_poster: bool = field(default_factory=lambda: _bool("SLACK_UPLOAD_POSTER", False))


@dataclass(frozen=True)
class Curation:
    max_candidates: int = field(default_factory=lambda: _int("MAX_CANDIDATES", 120))
    min_image_px: int = field(default_factory=lambda: _int("MIN_IMAGE_PX", 1000))
    blur_threshold: float = field(default_factory=lambda: _float("BLUR_THRESHOLD", 40.0))
    dhash_distance: int = field(default_factory=lambda: _int("DHASH_DISTANCE", 5))
    min_per_temple: int = field(default_factory=lambda: _int("MIN_PER_TEMPLE", 2))


@dataclass(frozen=True)
class Render:
    width: int = field(default_factory=lambda: _int("VIDEO_WIDTH", 1080))
    height: int = field(default_factory=lambda: _int("VIDEO_HEIGHT", 1920))
    fps: int = field(default_factory=lambda: _int("VIDEO_FPS", 30))
    target_seconds: float = field(default_factory=lambda: _float("TARGET_DURATION_SECONDS", 60.0))
    seconds_per_image: float = field(default_factory=lambda: _float("SECONDS_PER_IMAGE", 3.2))
    transition_seconds: float = field(default_factory=lambda: _float("TRANSITION_SECONDS", 0.5))
    # 0 means "derive from target_seconds"; the UI can override per run.
    shot_count: int = field(default_factory=lambda: _int("SHOT_COUNT", 0))
    endcard_seconds: float = field(default_factory=lambda: _float("ENDCARD_SECONDS", 3.0))
    intro_seconds: float = field(default_factory=lambda: _float("INTRO_SECONDS", 2.5))
    logo_height: int = field(default_factory=lambda: _int("LOGO_HEIGHT", 110))
    logo_margin: int = field(default_factory=lambda: _int("LOGO_MARGIN", 48))
    logo_position: str = field(default_factory=lambda: _str("LOGO_POSITION", "top-right"))
    logo_opacity: float = field(default_factory=lambda: _float("LOGO_OPACITY", 0.9))
    crf: int = field(default_factory=lambda: _int("RENDER_CRF", 20))
    preset: str = field(default_factory=lambda: _str("RENDER_PRESET", "medium"))
    audio_bitrate: str = field(default_factory=lambda: _str("RENDER_AUDIO_BITRATE", "192k"))
    ffmpeg: str = field(default_factory=lambda: _str("FFMPEG_BIN", "ffmpeg"))
    ffprobe: str = field(default_factory=lambda: _str("FFPROBE_BIN", "ffprobe"))


@dataclass(frozen=True)
class Config:
    port: int = field(default_factory=lambda: _int("PORT", 8000))
    public_url: str = field(default_factory=lambda: _str("PUBLIC_URL").rstrip("/"))
    data_dir: str = field(default_factory=lambda: _str("DATA_DIR", "./data"))
    log_level: str = field(default_factory=lambda: _str("LOG_LEVEL", "info"))
    app_password: str = field(default_factory=lambda: _str("APP_PASSWORD"))
    admin_token: str = field(default_factory=lambda: _str("ADMIN_TOKEN"))
    google: Google = field(default_factory=Google)
    drive: Drive = field(default_factory=Drive)
    groq: Groq = field(default_factory=Groq)
    slack: Slack = field(default_factory=Slack)
    curation: Curation = field(default_factory=Curation)
    render: Render = field(default_factory=Render)

    @property
    def work_dir(self) -> str:
        return os.path.join(self.data_dir, "work")

    @property
    def cache_dir(self) -> str:
        return os.path.join(self.data_dir, "elements")


config = Config()


def problems() -> list[str]:
    """Blocking misconfiguration, worth refusing to start over."""
    out: list[str] = []
    g = config.google
    if not (g.client_id and g.client_secret):
        out.append("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are required.")
    if not g.refresh_token:
        out.append("GOOGLE_REFRESH_TOKEN is missing — run scripts/authorize.py locally and paste the result.")
    if not config.drive.root_folder_id:
        out.append("DRIVE_ROOT_FOLDER_ID is missing — it is the id of the 'Vision Pics' folder.")
    if not config.app_password:
        out.append("APP_PASSWORD is missing — the UI would be open to anyone who finds the URL.")
    r = config.render
    if r.seconds_per_image <= r.transition_seconds:
        out.append(
            f"SECONDS_PER_IMAGE ({r.seconds_per_image}) must exceed TRANSITION_SECONDS "
            f"({r.transition_seconds}); each xfade consumes the tail of one shot and the head of the next."
        )
    return out


def warnings() -> list[str]:
    """Things that degrade the result but should not stop the service."""
    out: list[str] = []
    if not config.groq.api_keys:
        out.append("GROQ_API_KEYS is empty — image selection falls back to sharpness heuristics only.")
    if not (config.slack.bot_token and config.slack.channel):
        out.append("SLACK_BOT_TOKEN / SLACK_CHANNEL_ID unset — finished reels will not be announced.")
    if not config.public_url:
        out.append("PUBLIC_URL is empty — Slack cards will link to Drive but not back to this UI.")
    return out
