"""HTTP front end. /healthz is open (Docker, Dokploy and the dashboard probe it);
everything else sits behind basic auth when UI_PASSWORD is set."""

from __future__ import annotations

import secrets
import time
from pathlib import Path

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import config, core

app = FastAPI(title="Temple {{title}}", docs_url=None, redoc_url=None)
_basic = HTTPBasic(auto_error=False)
_started = time.time()
UI_DIR = Path(__file__).resolve().parent / "ui"


def authed(creds: HTTPBasicCredentials | None = Depends(_basic)) -> bool:
    if not config.UI_PASSWORD:
        return True
    if creds and secrets.compare_digest(creds.password.encode(), config.UI_PASSWORD.encode()):
        return True
    raise HTTPException(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Temple {{title}}"'})


@app.get("/healthz")
def healthz() -> dict:
    # The dashboard card reads these keys: add facts here, then show them in
    # services/dashboard/src/services.js.
    return {"ok": True, "uptime": int(time.time() - _started), "problems": config.problems()}


@app.get("/api/info")
def info(_: bool = Depends(authed)) -> dict:
    return {"name": "{{id}}", "problems": config.problems()}


@app.post("/api/run")
def run(text: str = Body(..., embed=True), _: bool = Depends(authed)) -> dict:
    if not text.strip():
        raise HTTPException(status_code=422, detail="text is empty")
    return core.run(text)


@app.get("/")
def index(_: bool = Depends(authed)) -> FileResponse:
    return FileResponse(UI_DIR / "index.html")
