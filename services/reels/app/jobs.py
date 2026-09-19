"""The pipeline, and the single-worker queue that runs it.

One worker, deliberately. zoompan at 1080x1920 will use every core it is given,
so two concurrent renders do not finish twice as fast — they finish at the same
time, both slower, and the box stops answering the UI. Jobs queue instead.
"""
from __future__ import annotations

import logging
import os
import queue
import shutil
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone

from . import curate, drive, elements, library, prefilter, render, sequence, slack, store
from .config import config

log = logging.getLogger(__name__)

JOBS_FILE = "jobs.json"
HISTORY_LIMIT = 50
LOG_LIMIT = 400

STAGES = ["queued", "discovering", "prefiltering", "curating", "sequencing", "rendering", "uploading", "done"]

_queue: "queue.Queue[str]" = queue.Queue()
_jobs: dict[str, dict] = {}
_lock = threading.RLock()
_worker: threading.Thread | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------- job records


def load() -> None:
    with _lock:
        for job in store.read(JOBS_FILE, []):
            # A job that was mid-flight when the container stopped cannot be
            # resumed; showing it as failed beats showing it as running forever.
            if job.get("state") in ("running", "queued"):
                job["state"] = "failed"
                job["error"] = job.get("error") or "interrupted by a restart"
            _jobs[job["id"]] = job


def _persist() -> None:
    with _lock:
        ranked = sorted(_jobs.values(), key=lambda j: j["created_at"], reverse=True)
        rows, dropped = ranked[:HISTORY_LIMIT], ranked[HISTORY_LIMIT:]
        _jobs.clear()
        for row in rows:
            _jobs[row["id"]] = row
        store.write(JOBS_FILE, rows)
    # A poster outlives its job otherwise, and nothing would ever delete it.
    for row in dropped:
        poster = row.get("poster_path")
        if poster and os.path.exists(poster):
            try:
                os.unlink(poster)
            except OSError:
                pass


def all_jobs() -> list[dict]:
    with _lock:
        return sorted((dict(j) for j in _jobs.values()), key=lambda j: j["created_at"], reverse=True)


def get(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def _update(job_id: str, **fields) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(fields)


def _log(job_id: str, message: str) -> None:
    log.info("[%s] %s", job_id[:8], message)
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["log"].append(f"{_now()}  {message}")
        if len(job["log"]) > LOG_LIMIT:
            # Keep the head: the first lines say what was asked for, and that is
            # what you need when reading a failure days later.
            job["log"] = job["log"][:50] + ["…"] + job["log"][-(LOG_LIMIT - 51):]


def _stage(job_id: str, stage: str, progress: float = 0.0) -> None:
    _update(job_id, stage=stage, progress=round(progress, 4))
    _log(job_id, f"— {stage}")


# ----------------------------------------------------------------- submit


def submit(*, event_folder_id: str, song_file_id: str = "", options: dict | None = None) -> dict:
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "created_at": _now(),
        "started_at": None,
        "finished_at": None,
        "state": "queued",
        "stage": "queued",
        "progress": 0.0,
        "event_folder_id": drive.parse_id(event_folder_id),
        "event_name": "",
        "song_file_id": drive.parse_id(song_file_id) if song_file_id else "",
        "song_name": "",
        "options": options or {},
        "log": [],
        "stats": {},
        "reel_url": "",
        "reel_file_id": "",
        "poster_path": "",
        "error": "",
    }
    if not job["event_folder_id"]:
        raise ValueError("an event folder id or Drive link is required")
    with _lock:
        _jobs[job_id] = job
    _persist()
    _queue.put(job_id)
    ensure_worker()
    return dict(job)


def queue_depth() -> int:
    return _queue.qsize()


def ensure_worker() -> None:
    global _worker
    with _lock:
        if _worker and _worker.is_alive():
            return
        _worker = threading.Thread(target=_loop, name="reel-worker", daemon=True)
        _worker.start()


def _loop() -> None:
    while True:
        job_id = _queue.get()
        try:
            _execute(job_id)
        except Exception:
            log.exception("worker crashed on job %s", job_id)
        finally:
            _queue.task_done()


# --------------------------------------------------------------- pipeline


def _execute(job_id: str) -> None:
    job = get(job_id)
    if not job:
        return
    started = time.time()
    _update(job_id, state="running", started_at=_now())
    work_dir = os.path.join(config.work_dir, job_id)

    try:
        _pipeline(job_id, work_dir)
        _update(job_id, state="done", stage="done", progress=1.0, finished_at=_now())
        _log(job_id, f"finished in {time.time() - started:.0f}s")
        _persist()
        try:
            slack.post_success(get(job_id) or {})
        except Exception as err:
            _log(job_id, f"slack notification failed: {err}")
    except Exception as err:
        detail = traceback.format_exc(limit=3)
        stderr = getattr(err, "stderr", "")
        message = f"{err}\n{stderr}".strip() if stderr else str(err)
        _update(job_id, state="failed", error=message, finished_at=_now())
        _log(job_id, f"FAILED: {message}")
        log.error("job %s failed\n%s", job_id, detail)
        _persist()
        try:
            slack.post_failure(get(job_id) or {})
        except Exception as slack_err:
            _log(job_id, f"slack failure notice also failed: {slack_err}")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        _persist()


def _pipeline(job_id: str, work_dir: str) -> None:
    job = get(job_id) or {}
    options = job.get("options") or {}
    r = config.render
    per = float(options.get("seconds_per_image") or r.seconds_per_image)
    xt = float(options.get("transition_seconds") or r.transition_seconds)
    target = float(options.get("target_seconds") or r.target_seconds)
    wanted = sequence.shot_count(
        target_seconds=target, seconds_per_image=per, transition_seconds=xt,
        override=int(options.get("shot_count") or 0) or None,
    )

    # -------------------------------------------------- discover
    _stage(job_id, "discovering")
    event = drive.get_file(job["event_folder_id"])
    _update(job_id, event_name=event["name"])
    _log(job_id, f"event folder: {event['name']}")

    groups = drive.walk_event(event["id"])
    if not groups:
        raise RuntimeError("no images found — the event folder has no temple sub-folders with photos in them")

    candidates: list[dict] = []
    for group in groups:
        for f in group["images"]:
            candidates.append({
                "id": f["id"],
                "name": f["name"],
                "temple": group["temple"],
                "createdTime": f.get("createdTime", ""),
                "mimeType": f.get("mimeType", ""),
            })
    temples = sorted({c["temple"] for c in candidates if c["temple"]})
    _log(job_id, f"{len(candidates)} images across {len(groups)} folder(s): {', '.join(temples) or 'unnamed'}")

    os.makedirs(work_dir, exist_ok=True)
    for index, item in enumerate(candidates, start=1):
        ext = os.path.splitext(item["name"])[1] or ".jpg"
        item["path"] = os.path.join(work_dir, f"{index:04d}{ext}")
        drive.download(item["id"], item["path"])
        _update(job_id, progress=0.05 + 0.25 * index / len(candidates))
    _log(job_id, f"downloaded {len(candidates)} images")

    # -------------------------------------------------- prefilter
    _stage(job_id, "prefiltering", 0.30)
    kept, rejected = prefilter.triage(candidates)
    reasons: dict[str, int] = {}
    for item in rejected:
        key = str(item.get("reject", "rejected")).split(" (")[0].split(" of ")[0]
        reasons[key] = reasons.get(key, 0) + 1
    _log(job_id, f"prefilter kept {len(kept)}, dropped {len(rejected)}"
                 + (f" ({', '.join(f'{v} {k}' for k, v in sorted(reasons.items()))})" if reasons else ""))
    if not kept:
        raise RuntimeError(
            "every image was rejected by the prefilter — they may all be below "
            f"MIN_IMAGE_PX ({config.curation.min_image_px}px) or too soft"
        )

    # -------------------------------------------------- curate
    _stage(job_id, "curating", 0.34)
    mode = curate.curate(
        kept,
        on_progress=lambda done, total: _update(job_id, progress=0.34 + 0.26 * done / max(total, 1)),
    )
    scored = sum(1 for c in kept if c.get("scored_by") == "llm")
    _log(job_id, f"curation mode: {mode} ({scored}/{len(kept)} scored by the model)")

    # -------------------------------------------------- sequence
    _stage(job_id, "sequencing", 0.60)
    shots = sequence.build(kept, wanted, min_per_temple=int(options.get("min_per_temple") or 0) or None)
    duration = sequence.duration_for(len(shots), seconds_per_image=per, transition_seconds=xt)
    picked = {}
    for shot in shots:
        picked[shot["temple"] or "—"] = picked.get(shot["temple"] or "—", 0) + 1
    _log(job_id, f"selected {len(shots)} shots ({', '.join(f'{k}: {v}' for k, v in picked.items())})")

    # -------------------------------------------------- render
    _stage(job_id, "rendering", 0.62)
    folder = library.elements_folder()
    assets = elements.resolve_all(folder["id"] if folder else None)
    _log(job_id, "branding: " + ", ".join(
        f"{k}={os.path.basename(v) if v else 'none'}" for k, v in assets.items()))

    song_path = None
    if job["song_file_id"]:
        song_meta = drive.get_file(job["song_file_id"])
        song_path = os.path.join(work_dir, "song" + (os.path.splitext(song_meta["name"])[1] or ".mp3"))
        drive.download(song_meta["id"], song_path)
        _update(job_id, song_name=song_meta["name"])
        _log(job_id, f"song: {song_meta['name']}")
    else:
        _log(job_id, "no song selected — the reel will be silent")

    output = os.path.join(work_dir, "reel.mp4")
    render_started = time.time()
    total = render.render(
        shots, output,
        song_path=song_path, logo_path=assets.get("logo"),
        endcard_path=assets.get("endcard"), intro_path=assets.get("intro"),
        seconds_per_image=per, transition_seconds=xt,
        on_progress=lambda p: _update(job_id, progress=0.62 + 0.28 * p),
        on_log=lambda line: _log(job_id, f"ffmpeg: {line}"),
    )
    render_seconds = time.time() - render_started
    _log(job_id, f"rendered {total:.1f}s in {render_seconds:.0f}s "
                 f"({os.path.getsize(output) / 1_048_576:.1f} MB)")

    # -------------------------------------------------- upload
    _stage(job_id, "uploading", 0.90)
    reels_folder = drive.ensure_folder(event["id"], config.drive.reels_folder)
    name = f"{event['name']} — Reel.mp4"
    uploaded = drive.upload(output, reels_folder["id"], name)
    if config.drive.share_reel:
        try:
            drive.share_anyone(uploaded["id"])
        except Exception as err:
            _log(job_id, f"link sharing failed (the file is still uploaded): {err}")

    poster_path = os.path.join(config.cache_dir, f"poster-{job_id}.jpg")
    os.makedirs(config.cache_dir, exist_ok=True)
    poster = render.poster(output, poster_path)

    _update(
        job_id,
        reel_file_id=uploaded["id"],
        reel_url=uploaded.get("webViewLink", f"https://drive.google.com/file/d/{uploaded['id']}/view"),
        poster_path=poster or "",
        stats={
            "considered": len(candidates),
            "kept": len(kept),
            "used": len(shots),
            "temples": len(temples) or len(groups),
            "duration_seconds": round(duration, 1),
            "render_seconds": round(render_seconds, 1),
            "curation_mode": mode,
            "per_temple": picked,
        },
    )
    _log(job_id, f"uploaded to {config.drive.reels_folder}/{name}")
