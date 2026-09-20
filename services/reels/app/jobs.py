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


def _sample_evenly(candidates: list[dict], cap: int) -> list[dict]:
    """Trim a huge pool while keeping every folder represented.

    Round-robin across folders rather than taking the first N: the first N would
    be one or two temples in alphabetical order, and the rest of the world would
    never appear in the reel.
    """
    by_temple: dict[str, list[dict]] = {}
    for item in candidates:
        by_temple.setdefault(item.get("temple", ""), []).append(item)
    for rows in by_temple.values():
        rows.sort(key=lambda c: c.get("createdTime") or c["name"])

    picked: list[dict] = []
    index = 0
    while len(picked) < cap:
        took = False
        for rows in by_temple.values():
            if index < len(rows):
                picked.append(rows[index])
                took = True
                if len(picked) >= cap:
                    break
        if not took:
            break
        index += 1
    return picked


def _pool_size(wanted: int) -> int:
    """How many images are worth scoring for a reel of `wanted` shots.

    Scoring costs a model request per few images and is the slowest stage by a
    distance, so it is sized to the reel rather than to the event: a 20-shot
    reel choosing from 60 images is already a luxury, and choosing from 120 only
    doubles the wait. MAX_CANDIDATES remains the ceiling.
    """
    return max(24, min(config.curation.max_candidates, wanted * config.curation.candidates_per_shot))


def _safe(name: str) -> str:
    """A filename Windows will accept — event names carry slashes and colons."""
    cleaned = "".join("-" if c in '<>:"/\\|?*' else c for c in name).strip(" .")
    return cleaned[:120] or "reel"


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
        # Bookkeeping that only means something in this process.
        store.write(JOBS_FILE, [{k: v for k, v in row.items() if not k.startswith("_")} for row in rows])
    # A poster outlives its job otherwise, and nothing would ever delete it.
    for row in dropped:
        poster = row.get("poster_path")
        if poster and os.path.exists(poster):
            try:
                os.unlink(poster)
            except OSError:
                pass


def snapshot() -> list[dict]:
    """Jobs exactly as recorded on disk.

    Unlike load(), this does not rewrite queued or running jobs as failed — a
    reader in another window must not conclude that a job still in flight has
    died, which is the opposite of what a status check is for.
    """
    rows = store.read(JOBS_FILE, [])
    return sorted(rows, key=lambda j: j.get("created_at", ""), reverse=True)


def _public(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def all_jobs() -> list[dict]:
    with _lock:
        return sorted((_public(j) for j in _jobs.values()), key=lambda j: j["created_at"], reverse=True)


def get(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return _public(job) if job else None


# How often a running job's progress reaches disk. Every update would mean a
# file write per downloaded photo; only at stage changes means a reader in
# another window sees a five-minute-old picture of a stage that moves every
# second. Ten seconds is neither.
HEARTBEAT_SECONDS = 10.0

# Long enough that no healthy stage trips it, short enough to be seen: the point
# is to say "still working, this is what on" rather than to diagnose.
STALL_NOTICE_SECONDS = 180.0


def _update(job_id: str, **fields) -> None:
    flush = False
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(fields)
        job["updated_at"] = _now()
        if time.time() - job.get("_flushed", 0.0) >= HEARTBEAT_SECONDS:
            job["_flushed"] = time.time()
            flush = True
    if flush:
        _persist()


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
    with _lock:
        job = _jobs.get(job_id)
        if job:
            job["stage_started_at"] = _now()
            job["_stage_started"] = time.time()
    _update(job_id, stage=stage, progress=round(progress, 4), detail="")
    _log(job_id, f"— {stage}")
    # Persist on every stage change, so a second window can read the job's
    # state from disk while it runs rather than only after it ends.
    _persist()


def _watchdog(job_id: str, stop: threading.Event) -> None:
    """Say so, in the job's own log, when a stage is taking a long time.

    It does not intervene — every stage that can genuinely hang now has its own
    timeout. What it removes is the silence: a long stage and a dead one looked
    identical from the outside, and that is how a working run got killed.
    """
    told = 0.0
    while not stop.wait(15.0):
        with _lock:
            job = _jobs.get(job_id)
            if not job or job.get("state") != "running":
                return
            elapsed = time.time() - job.get("_stage_started", time.time())
            stage, detail = job.get("stage", ""), job.get("detail", "")
        if elapsed >= STALL_NOTICE_SECONDS and elapsed - told >= STALL_NOTICE_SECONDS:
            told = elapsed
            _log(job_id, f"still {stage} after {elapsed / 60:.0f}m"
                         + (f" — {detail}" if detail else "") + " (this is slow, not stuck)")
            _persist()


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
        # A short "what exactly is happening now", for the long silent stages.
        "detail": "",
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
        "local_path": "",
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

    stop = threading.Event()
    threading.Thread(target=_watchdog, args=(job_id, stop), name="reel-watchdog", daemon=True).start()

    # The terminal state is set last, after the notification has been attempted.
    # Anything watching a job stops watching the moment it reads done or failed
    # — and the CLI then exits, killing this daemon thread mid-Slack-call.
    try:
        _pipeline(job_id, work_dir)
        current = get(job_id) or {}
        # A local dry run has nothing to announce — there is no link to send.
        if current.get("reel_url"):
            try:
                slack.post_success(current)
            except Exception as err:
                _log(job_id, f"slack notification failed: {err}")
        _log(job_id, f"finished in {time.time() - started:.0f}s")
        _update(job_id, state="done", stage="done", progress=1.0, finished_at=_now())
        _persist()
    except Exception as err:
        detail = traceback.format_exc(limit=3)
        stderr = getattr(err, "stderr", "")
        # Some exceptions — MemoryError is the one that bites — stringify to
        # nothing, and "FAILED:" with nothing after it is the worst thing this
        # can print. The class name is always something.
        text = str(err) or err.__class__.__name__
        message = f"{text}\n{stderr}".strip() if stderr else text
        _update(job_id, error=message, finished_at=_now())
        _log(job_id, f"FAILED: {message}")
        log.error("job %s failed\n%s", job_id, detail)
        try:
            slack.post_failure(get(job_id) or {})
        except Exception as slack_err:
            _log(job_id, f"slack failure notice also failed: {slack_err}")
        _update(job_id, state="failed")
        _persist()
    finally:
        stop.set()
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

    pool = _pool_size(wanted)
    # Fetch several times the pool so the prefilter has real choice — a good
    # half of a festival upload is duplicates, screenshots and soft frames — but
    # not the whole thousand, which is gigabytes spent on photographs that
    # cannot reach the reel.
    cap = min(config.curation.download_cap, max(120, pool * 5)) if config.curation.download_cap else 0
    if cap and len(candidates) > cap:
        candidates = _sample_evenly(candidates, cap)
        _log(job_id, f"sampled {len(candidates)} of them, evenly across folders "
                     f"— a {wanted}-shot reel draws from a pool of {pool}")

    os.makedirs(work_dir, exist_ok=True)
    for index, item in enumerate(candidates, start=1):
        ext = os.path.splitext(item["name"])[1] or ".jpg"
        item["path"] = os.path.join(work_dir, f"{index:04d}{ext}")

    def downloaded(done: int, total: int) -> None:
        _update(job_id, progress=0.05 + 0.25 * done / total, detail=f"{done}/{total} downloaded")

    fetched = drive.download_many(candidates, on_progress=downloaded)
    failed = [c for c in candidates if c.get("download_error")]
    candidates = fetched
    _log(job_id, f"downloaded {len(candidates)} images" + (f", {len(failed)} FAILED" if failed else ""))
    # Named, not just counted: a silent shortfall is how a reel quietly loses a
    # whole temple's photographs.
    for item in failed[:5]:
        _log(job_id, f"  ! {item['name']}: {item['download_error']}")
    if len(failed) > 5:
        _log(job_id, f"  ! and {len(failed) - 5} more")
    if not candidates:
        raise RuntimeError(
            "every image failed to download — check the network and that the "
            "Google refresh token is still valid"
        )

    # -------------------------------------------------- prefilter
    _stage(job_id, "prefiltering", 0.30)
    kept, rejected = prefilter.triage(
        candidates, cap=pool,
        on_progress=lambda done, total: _update(
            job_id, progress=0.30 + 0.04 * done / max(total, 1), detail=f"{done}/{total} inspected"),
    )
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
    curation_started = time.time()
    mode = curate.curate(
        kept,
        on_progress=lambda done, total: _update(
            job_id, progress=0.34 + 0.26 * done / max(total, 1), detail=f"batch {done}/{total}"),
        on_warn=lambda message: _log(job_id, f"  ! {message}"),
        budget_seconds=float(options.get("curation_budget_seconds") or 0) or None,
    )
    scored = sum(1 for c in kept if c.get("scored_by") == "llm")
    _log(job_id, f"curation mode: {mode} ({scored}/{len(kept)} scored by the model) "
                 f"in {time.time() - curation_started:.0f}s")

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
    # A run may pin its own card — a Ganesha end card does not belong on a
    # Salakatla Brahmotsavam reel, and which one is right changes by festival.
    for kind in elements.KINDS:
        chosen = options.get(f"{kind}_file_id")
        if not chosen:
            continue
        if chosen == "none":
            assets[kind] = None
            continue
        try:
            assets[kind] = elements.resolve_file(chosen)
        except Exception as err:
            _log(job_id, f"chosen {kind} could not be fetched ({err}); falling back to the usual one")
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
        song_start=float(options["song_start_seconds"]) if options.get("song_start_seconds") not in (None, "") else None,
        on_note=lambda message: _log(job_id, message),
        on_progress=lambda p: _update(job_id, progress=0.62 + 0.28 * p),
        # A sixty-clip filtergraph runs to several thousand characters. It is
        # the first thing wanted when a reel looks wrong, and the last thing
        # wanted in a progress view, so it goes to the process log only.
        on_log=lambda line: log.info("[%s] ffmpeg %s", job_id[:8], line),
    )
    render_seconds = time.time() - render_started
    _log(job_id, f"rendered {total:.1f}s in {render_seconds:.0f}s "
                 f"({os.path.getsize(output) / 1_048_576:.1f} MB)")

    # -------------------------------------------------- upload
    _stage(job_id, "uploading", 0.90)
    base_stats = {
        "considered": len(candidates),
        "kept": len(kept),
        "used": len(shots),
        "temples": len(temples) or len(groups),
        "duration_seconds": round(duration, 1),
        "render_seconds": round(render_seconds, 1),
        "curation_mode": mode,
        "per_temple": picked,
    }

    if options.get("skip_upload"):
        # The CLI's dry run: keep the file where the person can watch it, and
        # leave Drive and Slack untouched.
        kept_path = os.path.abspath(os.path.join(os.getcwd(), f"{_safe(event['name'])}.mp4"))
        shutil.copyfile(output, kept_path)
        _update(job_id, local_path=kept_path, stats=base_stats)
        _log(job_id, f"saved locally to {kept_path} (nothing written to Drive)")
        return

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
        stats=base_stats,
    )
    _log(job_id, f"uploaded to {config.drive.reels_folder}/{name}")
