"""Small JSON-file persistence under DATA_DIR.

Same reasoning as the notifier's store.js: job history and settings are a few
hundred rows at most, and a database would be more to deploy, back up and get
wrong than the problem justifies. Writes go through a temp file and a rename so
a container killed mid-write leaves the previous state intact rather than a
truncated file.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading

from .config import config

log = logging.getLogger(__name__)

_lock = threading.Lock()


def _path(name: str) -> str:
    return os.path.join(config.data_dir, name)


def read(name: str, default):
    path = _path(name)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, OSError) as err:
        log.warning("%s is unreadable (%s); starting from the default", path, err)
        return default


def write(name: str, data) -> None:
    os.makedirs(config.data_dir, exist_ok=True)
    path = _path(name)
    with _lock:
        fd, tmp = tempfile.mkstemp(dir=config.data_dir, prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, ensure_ascii=False)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


SETTINGS_FILE = "settings.json"


def settings() -> dict:
    return read(SETTINGS_FILE, {})


def save_setting(key: str, value) -> dict:
    data = settings()
    if value in (None, ""):
        data.pop(key, None)
    else:
        data[key] = value
    write(SETTINGS_FILE, data)
    return data
