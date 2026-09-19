"""Branding assets — logo, end card, optional intro card.

The end card has to be swappable by pasting a Drive link, without a redeploy,
so three sources are consulted in order: a setting saved from the UI, an env
var, then a file of the expected name in Vision Pics/Elements. Each is cached
locally against its Drive modifiedTime, so changing the file in Drive is picked
up on the next run and an unchanged file costs nothing.
"""
from __future__ import annotations

import logging
import os
import re

from . import drive, store
from .config import config

log = logging.getLogger(__name__)

# kind -> (name aliases in preference order, accepted extensions).
# Nobody names the file "logo.png". The real overlay in this archive is
# "ReelsFrame_2025_Copyright.png" and the end cards are
# "Ganesha-Chaturthi-endcard-1.png", so matching has to cope with real names
# rather than the tidy ones a README would suggest.
KINDS = {
    "logo": (["logo", "frame", "watermark", "overlay", "copyright"], [".png", ".webp"]),
    "endcard": (["endcard", "end-card", "end_card", "outro", "closing"],
                [".mp4", ".mov", ".png", ".jpg", ".jpeg", ".webp"]),
    "intro": (["intro", "opening", "titlecard"],
              [".mp4", ".mov", ".png", ".jpg", ".jpeg", ".webp"]),
}

SETTING_KEYS = {kind: f"{kind}_file_id" for kind in KINDS}


def configured_id(kind: str) -> str:
    """UI setting beats env, env beats name lookup."""
    saved = store.settings().get(SETTING_KEYS[kind], "")
    if saved:
        return drive.parse_id(saved)
    from_env = {
        "logo": config.drive.logo_file_id,
        "endcard": config.drive.endcard_file_id,
        "intro": config.drive.intro_file_id,
    }[kind]
    return drive.parse_id(from_env) if from_env else ""


def _find_by_name(elements_folder_id: str, kind: str) -> dict | None:
    """Exact stem first, then any filename containing one of the aliases.

    Within a tier the newest file wins, so dropping a "…endcard-2.png" beside
    last month's replaces it without anyone renaming anything.
    """
    aliases, exts = KINDS[kind]
    candidates = [
        f for f in drive.list_children(elements_folder_id)
        if os.path.splitext(f["name"].lower())[1] in exts
    ]
    if not candidates:
        return None
    # Another kind's alias in the name wins it — "endcard" must not be taken by
    # the logo rules just because someone called it "closing-frame.png".
    others = {a for other, (al, _) in KINDS.items() if other != kind for a in al}

    for alias in aliases:
        matches = [
            f for f in candidates
            if alias in f["name"].lower()
            and not any(other in f["name"].lower() for other in others if other not in alias)
        ]
        if not matches:
            continue
        exact = [f for f in matches if os.path.splitext(f["name"].lower())[0] == alias]
        return max(exact or matches, key=lambda f: f.get("modifiedTime", ""))
    return None


def resolve(kind: str, elements_folder_id: str | None) -> str | None:
    """Return a local path to the asset, or None if there isn't one."""
    file_id = configured_id(kind)
    meta = None
    if file_id:
        try:
            meta = drive.get_file(file_id)
        except Exception as err:
            log.warning("%s file id %s could not be read (%s); falling back to name lookup", kind, file_id, err)
            meta = None
    if meta is None and elements_folder_id:
        meta = _find_by_name(elements_folder_id, kind)
    if meta is None:
        return None
    return fetch(meta)


def fetch(meta: dict) -> str:
    """Download unless the cached copy already matches Drive's modifiedTime."""
    stamp = re.sub(r"[^0-9]", "", str(meta.get("modifiedTime", "")))
    ext = os.path.splitext(meta["name"])[1].lower() or ".bin"
    path = os.path.join(config.cache_dir, f"{meta['id']}-{stamp}{ext}")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(config.cache_dir, exist_ok=True)
    drive.download(meta["id"], path)
    # A new version of the same asset makes older copies dead weight.
    for stale in os.listdir(config.cache_dir):
        if stale.startswith(f"{meta['id']}-") and os.path.join(config.cache_dir, stale) != path:
            try:
                os.unlink(os.path.join(config.cache_dir, stale))
            except OSError:
                pass
    return path


def resolve_all(elements_folder_id: str | None) -> dict[str, str | None]:
    return {kind: resolve(kind, elements_folder_id) for kind in KINDS}
