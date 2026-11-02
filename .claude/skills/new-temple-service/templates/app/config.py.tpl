"""Environment parsing. Read once at import; problems() reports what is missing."""

from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    # Tiny loader so `uv run python -m app.cli` picks up .env with no extra
    # dependency. Real environment variables win, which is what the container uses.
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

PORT = int(os.environ.get("PORT") or 8000)
UI_PASSWORD = os.environ.get("UI_PASSWORD", "")
DATA_DIR = Path(os.environ.get("DATA_DIR") or "data")


def problems() -> list[str]:
    """Things that stop the service doing its job. Shown on /healthz and the dashboard."""
    found: list[str] = []
    # e.g. if not os.environ.get("SOME_API_KEY"): found.append("SOME_API_KEY not set")
    return found
