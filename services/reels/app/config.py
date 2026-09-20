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
class Gemini:
    """Second opinion, and the fallback when Groq is rate-limited everywhere."""
    api_keys: list[str] = field(default_factory=lambda: _list("GEMINI_API_KEYS") or _list("GEMINI_API_KEY"))
    # A lite flash model: this is a scoring task, not a reasoning one, and it
    # runs over a hundred images a day.
    model: str = field(default_factory=lambda: _str("GEMINI_MODEL", "gemini-3.5-flash-lite"))
    batch_size: int = field(default_factory=lambda: _int("GEMINI_BATCH_SIZE", 4))
    timeout_seconds: float = field(default_factory=lambda: _float("GEMINI_TIMEOUT_SECONDS", 90.0))


@dataclass(frozen=True)
class Slack:
    bot_token: str = field(default_factory=lambda: _str("SLACK_BOT_TOKEN"))
    channel: str = field(default_factory=lambda: _str("SLACK_CHANNEL_ID"))
    upload_poster: bool = field(default_factory=lambda: _bool("SLACK_UPLOAD_POSTER", False))


@dataclass(frozen=True)
class Curation:
    # A whole festival day can be well over a thousand photographs. Only
    # max_candidates of them ever reach the model, so fetching every one is
    # gigabytes of waiting for nothing; above this the pool is sampled evenly
    # across the temple folders first.
    download_cap: int = field(default_factory=lambda: _int("DOWNLOAD_CAP", 400))
    max_candidates: int = field(default_factory=lambda: _int("MAX_CANDIDATES", 120))
    # Scoring is the slowest stage and its cost is per candidate, so the pool is
    # cut to what the chosen length can actually use: a 20-shot reel does not
    # need 120 scored images to pick from. max_candidates remains the ceiling.
    candidates_per_shot: int = field(default_factory=lambda: _int("CANDIDATES_PER_SHOT", 3))
    # Batches run concurrently. The binding constraint is the provider's rate
    # limit rather than the network, so this is deliberately modest.
    workers: int = field(default_factory=lambda: _int("CURATION_WORKERS", 4))
    # A wall clock on the whole curation stage. When it runs out the remaining
    # batches keep their heuristic scores and the reel still ships — a weaker
    # selection is a bad day, a job that never returns is a broken tool.
    budget_seconds: float = field(default_factory=lambda: _float("CURATION_BUDGET_SECONDS", 300.0))
    prefilter_workers: int = field(default_factory=lambda: _int("PREFILTER_WORKERS", 8))
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
    logo_opacity: float = field(default_factory=lambda: _float("LOGO_OPACITY", 1.0))
    # auto decides from the file's shape: an overlay cut to the output aspect is
    # a whole-screen frame, anything else is a corner mark.
    logo_mode: str = field(default_factory=lambda: _str("LOGO_MODE", "auto").lower())
    # auto finds the loudest sustained passage — the chorus, in practice —
    # rather than opening on whatever the first seconds of the file happen to
    # be. "start" restores the old behaviour; a per-run start time overrides both.
    music_pick: str = field(default_factory=lambda: _str("MUSIC_PICK", "auto").lower())
    # ffmpeg has no timeout of its own; a graph that stalls would hold the only
    # render worker for ever, and that is indistinguishable from a hung app.
    timeout_seconds: float = field(default_factory=lambda: _float("RENDER_TIMEOUT_SECONDS", 1800.0))
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
    # Which model scores the images first, and which covers for it.
    curation_provider: str = field(default_factory=lambda: _str("CURATION_PROVIDER", "groq").lower())
    curation_fallback: str = field(default_factory=lambda: _str("CURATION_FALLBACK_PROVIDER", "gemini").lower())
    google: Google = field(default_factory=Google)
    drive: Drive = field(default_factory=Drive)
    groq: Groq = field(default_factory=Groq)
    gemini: Gemini = field(default_factory=Gemini)
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
    if not (config.groq.api_keys or config.gemini.api_keys):
        out.append("No GROQ_API_KEYS or GEMINI_API_KEYS — image selection falls back to sharpness heuristics only.")
    elif not config.groq.api_keys:
        out.append("GROQ_API_KEYS is empty — selection will run on Gemini alone, with no fallback.")
    elif not config.gemini.api_keys:
        out.append("GEMINI_API_KEYS is empty — a Groq outage drops selection to sharpness heuristics.")
    if not (config.slack.bot_token and config.slack.channel):
        out.append("SLACK_BOT_TOKEN / SLACK_CHANNEL_ID unset — finished reels will not be announced.")
    if not config.public_url:
        out.append("PUBLIC_URL is empty — Slack cards will link to Drive but not back to this UI.")
    return out
