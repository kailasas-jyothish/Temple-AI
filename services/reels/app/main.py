"""HTTP surface: the builder UI, the job API, and a health check.

Guarded by one shared password because the app sits on a public domain and can
write into the temple Drive. An x-admin-token header is accepted as well, so a
script or a future Slack command can drive it without a browser session.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os

from fastapi import Body, Cookie, Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse

from . import config as config_module
from . import drive, elements, jobs, library, slack
from .config import config

log = logging.getLogger(__name__)

UI_FILE = os.path.join(os.path.dirname(__file__), "ui", "index.html")
COOKIE = "reels_session"

app = FastAPI(title="Temple Reels", docs_url=None, redoc_url=None)


def _session_value() -> str:
    """Deterministic, so a restart does not log everyone out, and derived from
    the password, so changing the password invalidates old cookies."""
    return hmac.new(config.app_password.encode(), b"reels-session-v1", hashlib.sha256).hexdigest()


def authed(
    session: str | None = Cookie(default=None, alias=COOKIE),
    x_admin_token: str | None = Header(default=None),
) -> bool:
    if config.admin_token and x_admin_token and hmac.compare_digest(x_admin_token, config.admin_token):
        return True
    if config.app_password and session and hmac.compare_digest(session, _session_value()):
        return True
    raise HTTPException(status_code=401, detail="not signed in")


@app.on_event("startup")
def startup() -> None:
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-5s %(name)s  %(message)s",
    )
    os.makedirs(config.data_dir, exist_ok=True)
    os.makedirs(config.work_dir, exist_ok=True)
    os.makedirs(config.cache_dir, exist_ok=True)
    for line in config_module.problems():
        log.error("config: %s", line)
    for line in config_module.warnings():
        log.warning("config: %s", line)
    jobs.load()
    jobs.ensure_worker()
    log.info("temple-reels listening on :%d", config.port)


# ------------------------------------------------------------------ pages


@app.get("/")
def index() -> FileResponse:
    return FileResponse(UI_FILE)


@app.get("/healthz")
def healthz() -> JSONResponse:
    issues = config_module.problems()
    # Still 200 when misconfigured: a crash-looping container on Dokploy hides
    # the very message that says what is wrong.
    return JSONResponse({"ok": not issues, "problems": issues, "queue": jobs.queue_depth()})


# ------------------------------------------------------------------- auth


@app.post("/api/login")
def login(response: Response, password: str = Body(..., embed=True)) -> dict:
    if not config.app_password or not hmac.compare_digest(password, config.app_password):
        raise HTTPException(status_code=401, detail="wrong password")
    response.set_cookie(
        COOKIE, _session_value(), httponly=True, samesite="lax",
        secure=config.public_url.startswith("https://"), max_age=60 * 60 * 24 * 30,
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(session: str | None = Cookie(default=None, alias=COOKIE)) -> dict:
    signed_in = bool(config.app_password and session and hmac.compare_digest(session, _session_value()))
    return {"signed_in": signed_in}


# ------------------------------------------------------------------- data


@app.get("/api/config")
def read_config(_: bool = Depends(authed)) -> dict:
    r = config.render
    return {
        "defaults": {
            "target_seconds": r.target_seconds,
            "seconds_per_image": r.seconds_per_image,
            "transition_seconds": r.transition_seconds,
            "shot_count": r.shot_count,
            "min_per_temple": config.curation.min_per_temple,
        },
        "problems": config_module.problems(),
        "warnings": config_module.warnings(),
        "curation": {"enabled": config.groq.enabled and bool(config.groq.api_keys),
                     "model": config.groq.model, "keys": len(config.groq.api_keys)},
        "slack": slack.configured(),
        "queue": jobs.queue_depth(),
    }


@app.get("/api/browse")
def browse(folder: str | None = None, _: bool = Depends(authed)) -> dict:
    try:
        return library.browse(folder)
    except Exception as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.get("/api/songs")
def songs(_: bool = Depends(authed)) -> dict:
    folder = library.songs_folder()
    if not folder:
        return {"folder": None, "songs": [],
                "note": f"no '{config.drive.songs_folder}' folder inside the Vision Pics root"}
    return {"folder": {"id": folder["id"], "name": folder["name"]},
            "songs": [{"id": f["id"], "name": f["name"], "modifiedTime": f.get("modifiedTime", "")}
                      for f in library.songs()]}


@app.get("/api/elements")
def read_elements(_: bool = Depends(authed)) -> dict:
    folder = library.elements_folder()
    out = {}
    for kind in elements.KINDS:
        file_id = elements.configured_id(kind)
        name, source = "", "none"
        if file_id:
            source = "override"
            try:
                name = drive.get_file(file_id)["name"]
            except Exception as err:
                name = f"(unreadable: {err.__class__.__name__})"
        elif folder:
            # Without an override the asset is found by name, so show which file
            # that actually lands on — otherwise the panel reads as "nothing
            # configured" while a perfectly good end card is being used.
            match = elements._find_by_name(folder["id"], kind)
            if match:
                name, source = match["name"], "by name"
        out[kind] = {"file_id": file_id, "name": name, "source": source}
    return {
        "folder": {"id": folder["id"], "name": folder["name"]} if folder else None,
        "elements": out,
        "available": elements.available(folder["id"] if folder else None),
    }


@app.post("/api/elements")
def write_element(kind: str = Body(...), link: str = Body(default=""), _: bool = Depends(authed)) -> dict:
    if kind not in elements.KINDS:
        raise HTTPException(status_code=400, detail=f"unknown element '{kind}'")
    file_id = drive.parse_id(link) if link else ""
    if link and not file_id:
        raise HTTPException(status_code=400, detail="that does not look like a Drive link or file id")
    from . import store
    store.save_setting(elements.SETTING_KEYS[kind], file_id)
    return {"ok": True, "kind": kind, "file_id": file_id}


# ------------------------------------------------------------------- jobs


@app.post("/api/jobs")
def create_job(
    event_folder_id: str = Body(...),
    song_file_id: str = Body(default=""),
    options: dict = Body(default={}),
    _: bool = Depends(authed),
) -> dict:
    problems = config_module.problems()
    if problems:
        raise HTTPException(status_code=503, detail="; ".join(problems))
    try:
        return jobs.submit(event_folder_id=event_folder_id, song_file_id=song_file_id, options=options)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.get("/api/jobs")
def list_jobs(_: bool = Depends(authed)) -> dict:
    rows = []
    for job in jobs.all_jobs():
        rows.append({k: v for k, v in job.items() if k != "log"})
    return {"jobs": rows, "queue": jobs.queue_depth()}


@app.get("/api/jobs/{job_id}")
def read_job(job_id: str, _: bool = Depends(authed)) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="no such job")
    return job
