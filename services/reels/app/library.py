"""The shape of the Vision Pics archive.

    Vision Pics/
      Songs/                        <- one track dropped in per day
      Elements/                     <- logo, endcard, intro
      2026-09-18 Ganesha Chaturthi/ <- an event folder
        KAILASA LA/                 <- one folder per temple
        KAILASA Houston/
        Reels/                      <- written by this service

Only the two special folder names are assumed; everything else is discovered.
"""
from __future__ import annotations

import logging

from . import drive
from .config import config

log = logging.getLogger(__name__)

AUDIO_EXTS = (".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma")


def root_id() -> str:
    return drive.parse_id(config.drive.root_folder_id)


def special_folder(name: str) -> dict | None:
    root = root_id()
    if not root:
        return None
    return drive.find_child(root, name, folder=True)


def songs_folder() -> dict | None:
    return special_folder(config.drive.songs_folder)


def elements_folder() -> dict | None:
    return special_folder(config.drive.elements_folder)


def songs() -> list[dict]:
    folder = songs_folder()
    if not folder:
        return []
    files = drive.list_children(folder["id"])
    tracks = [
        f for f in files
        if str(f.get("mimeType", "")).startswith("audio/") or f["name"].lower().endswith(AUDIO_EXTS)
    ]
    # Newest first: "daily I'll put the song" means the one just uploaded is
    # almost always the one wanted.
    tracks.sort(key=lambda f: f.get("modifiedTime", ""), reverse=True)
    return tracks


def browse(folder_id: str | None = None) -> dict:
    """Folder listing for the UI's picker."""
    target = drive.parse_id(folder_id or "") or root_id()
    if not target:
        raise ValueError("DRIVE_ROOT_FOLDER_ID is not set")
    meta = drive.get_file(target)
    children = drive.list_children(target, folders_only=True)
    skip = {config.drive.songs_folder.lower(), config.drive.elements_folder.lower()}
    return {
        "folder": {"id": meta["id"], "name": meta["name"]},
        "is_root": meta["id"] == root_id(),
        "folders": [
            {"id": f["id"], "name": f["name"]}
            for f in children
            if not (meta["id"] == root_id() and f["name"].lower() in skip)
        ],
    }
