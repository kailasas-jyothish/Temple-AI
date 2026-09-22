"""Google Drive v3 access.

Authenticates with an OAuth refresh token rather than a service account, so the
app sees exactly the folders the person who authorised it can see, and uploaded
reels are owned by a real account with real storage quota.
"""
from __future__ import annotations

import io
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import google_auth_httplib2
import httplib2
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

from .config import config

log = logging.getLogger(__name__)

# Full drive scope, not drive.file: drive.file only exposes files this app
# itself created, which is useless for reading photos the temple teams uploaded.
SCOPES = ["https://www.googleapis.com/auth/drive"]

TOKEN_URI = "https://oauth2.googleapis.com/token"

# Per-request socket timeout, and how many times a single file is retried.
SOCKET_TIMEOUT = 90
DOWNLOAD_ATTEMPTS = 3

# Fields worth having on every file we touch; Drive returns almost nothing by default.
FILE_FIELDS = ("id, name, mimeType, size, createdTime, modifiedTime, "
               "imageMediaMetadata(width,height,time), "
               # Duration lets a clip too short to fill one shot be dropped
               # before it is downloaded, which is the expensive part.
               "videoMediaMetadata(width,height,durationMillis), webViewLink")

_local = threading.local()


def credentials() -> Credentials:
    g = config.google
    return Credentials(
        token=None,
        refresh_token=g.refresh_token,
        client_id=g.client_id,
        client_secret=g.client_secret,
        token_uri=TOKEN_URI,
        scopes=SCOPES,
    )


def service():
    """One client per thread.

    googleapiclient's Resource wraps a single httplib2 connection and is not
    thread-safe; sharing one across a download pool produces truncated files and
    SSL errors that look like network flakiness. Each thread builds its own once
    and reuses it, so the cost is one discovery fetch per worker.
    """
    existing = getattr(_local, "service", None)
    if existing is None:
        creds = credentials()
        creds.refresh(Request())
        # An explicit socket timeout is the difference between a transient
        # network fault and a run that hangs forever with nothing to show for
        # it. httplib2 defaults to no timeout at all.
        inner = httplib2.Http(timeout=SOCKET_TIMEOUT)
        # Drive answers every intermediate chunk of a resumable upload with
        # "308 Resume Incomplete" and no Location header, and httplib2 counts
        # 308 as a redirect, so it raises RedirectMissingLocation instead of
        # letting googleapiclient read the progress. googleapiclient's own
        # build_http() strips 308 for exactly this reason — passing our own Http
        # (for the socket timeout) opts out of that, so it has to be done here.
        # Without it every upload over one chunk fails; downloads never notice.
        if hasattr(inner, "redirect_codes"):
            inner.redirect_codes = inner.redirect_codes - {308}
        http = google_auth_httplib2.AuthorizedHttp(creds, http=inner)
        existing = build("drive", "v3", http=http, cache_discovery=False)
        _local.service = existing
    return existing


def reset() -> None:
    _local.service = None


# ----------------------------------------------------------------- ids

_ID_PATTERNS = [
    re.compile(r"/folders/([A-Za-z0-9_-]{10,})"),
    re.compile(r"/file/d/([A-Za-z0-9_-]{10,})"),
    re.compile(r"[?&]id=([A-Za-z0-9_-]{10,})"),
]


def parse_id(text: str) -> str:
    """Accept a raw id or any of the Drive URL shapes people actually paste."""
    text = (text or "").strip()
    if not text:
        return ""
    for pattern in _ID_PATTERNS:
        m = pattern.search(text)
        if m:
            return m.group(1)
    # A bare id: Drive ids have no slashes and are comfortably long.
    if "/" not in text and len(text) >= 10:
        return text
    return ""


def _escape(name: str) -> str:
    return name.replace("\\", "\\\\").replace("'", "\\'")


# ----------------------------------------------------------------- reads


def get_file(file_id: str) -> dict:
    return (
        service()
        .files()
        .get(fileId=file_id, fields=FILE_FIELDS, supportsAllDrives=True)
        .execute()
    )


def list_children(folder_id: str, *, folders_only: bool = False, mime_prefix: str | None = None) -> list[dict]:
    q = [f"'{folder_id}' in parents", "trashed = false"]
    if folders_only:
        q.append("mimeType = 'application/vnd.google-apps.folder'")
    out: list[dict] = []
    page = None
    while True:
        resp = (
            service()
            .files()
            .list(
                q=" and ".join(q),
                fields=f"nextPageToken, files({FILE_FIELDS})",
                pageSize=1000,
                pageToken=page,
                orderBy="name_natural",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        out.extend(resp.get("files", []))
        page = resp.get("nextPageToken")
        if not page:
            break
    if mime_prefix:
        out = [f for f in out if str(f.get("mimeType", "")).startswith(mime_prefix)]
    return out


def find_child(parent_id: str, name: str, *, folder: bool = False) -> dict | None:
    q = [f"'{parent_id}' in parents", "trashed = false", f"name = '{_escape(name)}'"]
    if folder:
        q.append("mimeType = 'application/vnd.google-apps.folder'")
    resp = (
        service()
        .files()
        .list(
            q=" and ".join(q),
            fields=f"files({FILE_FIELDS})",
            pageSize=10,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
    )
    files = resp.get("files", [])
    return files[0] if files else None


def _is_video(f: dict) -> bool:
    """Drive's mimeType first, then the extension.

    Both are needed: a .mov uploaded from a phone occasionally arrives as
    application/octet-stream, and a file called "clip" with no extension is
    still a video if Drive says so.
    """
    from .video import is_video_name

    return str(f.get("mimeType", "")).startswith("video/") or is_video_name(f.get("name", ""))


def _is_output_folder(name: str) -> bool:
    """Is this a folder of finished reels rather than source material?

    It matters more than it looks. The service writes into a `Reels` folder
    inside the event folder, and the archive already holds hand-made ones —
    "Final Diwali Reel", "KB Final Reels", "REELS". Those were harmless while
    only photographs were read, because they contain none. Now that clips are
    ingested, a reel spliced from last month's finished reels is exactly what
    would happen, and it would look like a rendering fault rather than a
    sourcing one.
    """
    from .config import config

    lowered = name.strip().lower()
    return "reel" in lowered or lowered == config.drive.reels_folder.strip().lower()


def _split_media(files: list[dict]) -> tuple[list[dict], list[dict]]:
    images = [f for f in files if str(f.get("mimeType", "")).startswith("image/")]
    videos = [f for f in files if _is_video(f)]
    return images, videos


def walk_event(folder_id: str) -> list[dict]:
    """An event folder holds one sub-folder per temple.

    Images sitting loose in the event folder are not dropped — they become an
    unnamed group, because a team that uploaded without making a folder still
    took the photos. Video is collected the same way and kept in its own list:
    it costs far more to fetch than a photograph, so the caller caps it
    separately.
    """
    groups: list[dict] = []
    loose_images, loose_videos = _split_media(list_children(folder_id))
    for sub in list_children(folder_id, folders_only=True):
        if _is_output_folder(sub["name"]):
            continue
        images, videos = _split_media(list_children(sub["id"]))
        if images or videos:
            groups.append({"temple": sub["name"], "folder_id": sub["id"],
                           "images": images, "videos": videos})
    if loose_images or loose_videos:
        groups.append({"temple": "", "folder_id": folder_id,
                       "images": loose_images, "videos": loose_videos})
    return groups


def download_many(items: list[dict], *, workers: int = 6, on_progress=None) -> list[dict]:
    """Fetch many files at once.

    A day's event can be several hundred full-resolution photographs — nearly a
    gigabyte — and fetching them one at a time is the longest part of a run by
    far, spent waiting on the network rather than doing anything. Failures are
    recorded on the item instead of raised, so one bad file does not lose the
    other four hundred.
    """
    done = 0
    lock = threading.Lock()

    def fetch(item: dict) -> dict:
        nonlocal done
        try:
            download(item["id"], item["path"])
        except Exception as err:
            item["download_error"] = f"{err.__class__.__name__}: {err}"
        with lock:
            done += 1
            if on_progress:
                on_progress(done, len(items))
        return item

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(fetch, items))
    return [i for i in items if not i.get("download_error")]


def download(file_id: str, dest_path: str) -> str:
    """Fetch one file, retrying a timeout or a dropped connection.

    A partial file is deleted rather than left behind, because a truncated JPEG
    reads later as a corrupt upload and gets blamed on the temple team.
    """
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    last: Exception | None = None
    for attempt in range(DOWNLOAD_ATTEMPTS):
        try:
            request = service().files().get_media(fileId=file_id, supportsAllDrives=True)
            with io.FileIO(dest_path, "wb") as handle:
                downloader = MediaIoBaseDownload(handle, request, chunksize=8 * 1024 * 1024)
                done = False
                while not done:
                    _, done = downloader.next_chunk()
            return dest_path
        except Exception as err:
            last = err
            try:
                os.unlink(dest_path)
            except OSError:
                pass
            # A stale connection in this thread's client will keep failing.
            reset()
            if attempt + 1 < DOWNLOAD_ATTEMPTS:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"download failed after {DOWNLOAD_ATTEMPTS} attempts: {last}") from last


# ----------------------------------------------------------------- writes


def ensure_folder(parent_id: str, name: str) -> dict:
    """Idempotent: a second run must reuse the Reels folder, not make another."""
    existing = find_child(parent_id, name, folder=True)
    if existing:
        return existing
    return (
        service()
        .files()
        .create(
            body={"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]},
            fields=FILE_FIELDS,
            supportsAllDrives=True,
        )
        .execute()
    )


def upload(local_path: str, parent_id: str, name: str, mime_type: str = "video/mp4") -> dict:
    media = MediaFileUpload(local_path, mimetype=mime_type, resumable=True, chunksize=8 * 1024 * 1024)
    request = service().files().create(
        body={"name": name, "parents": [parent_id]},
        media_body=media,
        fields=FILE_FIELDS,
        supportsAllDrives=True,
    )
    response = None
    while response is None:
        _, response = request.next_chunk()
    return response


def share_anyone(file_id: str) -> None:
    service().permissions().create(
        fileId=file_id,
        body={"role": "reader", "type": "anyone"},
        supportsAllDrives=True,
    ).execute()
