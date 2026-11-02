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

# The service account: a key file on your own machine, base64 of the same file
# on the host (a PEM cannot be a single .env line otherwise).
GOOGLE_SERVICE_ACCOUNT_FILE = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "")
GOOGLE_SERVICE_ACCOUNT_JSON_B64 = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON_B64", "")

# Where a budget's new spreadsheet is created. It must be a folder in a Shared
# Drive: the service account has zero Drive storage of its own, so creating a
# spreadsheet anywhere else answers 403.
BUDGET_FOLDER_ID = os.environ.get("BUDGET_FOLDER_ID", "")


def has_credentials() -> bool:
    return bool(GOOGLE_SERVICE_ACCOUNT_JSON_B64 or GOOGLE_SERVICE_ACCOUNT_FILE)


def problems() -> list[str]:
    """Things that stop the service doing its job. Shown on /healthz and the dashboard."""
    found: list[str] = []
    if not has_credentials():
        found.append("no Google service account (GOOGLE_SERVICE_ACCOUNT_JSON_B64 or GOOGLE_SERVICE_ACCOUNT_FILE)")
    elif GOOGLE_SERVICE_ACCOUNT_FILE and not GOOGLE_SERVICE_ACCOUNT_JSON_B64 and not Path(GOOGLE_SERVICE_ACCOUNT_FILE).is_file():
        found.append(f"GOOGLE_SERVICE_ACCOUNT_FILE not found: {GOOGLE_SERVICE_ACCOUNT_FILE}")
    if not BUDGET_FOLDER_ID:
        found.append("BUDGET_FOLDER_ID not set: a budget can only be written into a spreadsheet given by link")
    return found
