"""HTTP front end. /healthz is open (Docker, Dokploy and the dashboard probe it);
everything else sits behind basic auth when UI_PASSWORD is set."""

from __future__ import annotations

import secrets
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import config, core
from .core import BudgetError

app = FastAPI(title="Temple Festival Budget", docs_url=None, redoc_url=None)
_basic = HTTPBasic(auto_error=False)
_started = time.time()
UI_DIR = Path(__file__).resolve().parent / "ui"
# Budgets are JSON files edited read-modify-write; two browser tabs saving at
# once must not interleave.
_lock = threading.Lock()


def authed(creds: HTTPBasicCredentials | None = Depends(_basic)) -> bool:
    if not config.UI_PASSWORD:
        return True
    if creds and secrets.compare_digest(creds.password.encode(), config.UI_PASSWORD.encode()):
        return True
    raise HTTPException(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Temple Festival Budget"'})


def _bad(exc: BudgetError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


@app.get("/healthz")
def healthz() -> dict:
    try:
        budgets = core.list_budgets()
    except (OSError, ValueError):
        budgets = []
    return {"ok": True, "uptime": int(time.time() - _started), "problems": config.problems(),
            "budgets": len(budgets), "written": sum(1 for b in budgets if b.get("spreadsheet"))}


@app.get("/api/info")
def info(_: bool = Depends(authed)) -> dict:
    from .sheets import account_email

    return {"name": "festival-budget", "problems": config.problems(), "service_account": account_email(),
            "folder": bool(config.BUDGET_FOLDER_ID)}


@app.get("/api/library")
def library(_: bool = Depends(authed)) -> dict:
    return core.load_library()


@app.post("/api/library/item")
def library_item(body: dict = Body(...), _: bool = Depends(authed)) -> dict:
    with _lock:
        lib = core.load_library()
        try:
            item = core.save_item(lib, name=body.get("name", ""), unit=body.get("unit", ""),
                                  section=body.get("section", "ritual"), vendor=body.get("vendor", ""),
                                  pack_unit=body.get("pack_unit", ""), pack_size=body.get("pack_size"),
                                  item_id=body.get("id") or None)
        except BudgetError as exc:
            raise _bad(exc) from None
        core.save_library(lib)
    return item


@app.post("/api/library/ritual")
def library_ritual(body: dict = Body(...), _: bool = Depends(authed)) -> dict:
    with _lock:
        lib = core.load_library()
        try:
            r = core.save_ritual(lib, name=body.get("name", ""), kind=body.get("kind", "variable"),
                                 group=body.get("group", ""), items=body.get("items") or {},
                                 ritual_id=body.get("id") or None)
        except BudgetError as exc:
            raise _bad(exc) from None
        core.save_library(lib)
    return r


@app.get("/api/budgets")
def budgets(_: bool = Depends(authed)) -> list[dict]:
    return core.list_budgets()


@app.post("/api/budgets")
def create(body: dict = Body(...), _: bool = Depends(authed)) -> dict:
    with _lock:
        try:
            b = core.new_budget(body.get("name", ""), constants=body.get("constants", True))
        except BudgetError as exc:
            raise _bad(exc) from None
    return _view(b)


def _view(b: dict) -> dict:
    return {"budget": b, "calc": core.plain(core.calculate(b))}


def _load(budget_id: str) -> dict:
    try:
        return core.load_budget(budget_id)
    except BudgetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


@app.get("/api/budgets/{budget_id}")
def show(budget_id: str, _: bool = Depends(authed)) -> dict:
    return _view(_load(budget_id))


@app.delete("/api/budgets/{budget_id}")
def delete(budget_id: str, _: bool = Depends(authed)) -> dict:
    with _lock:
        b = _load(budget_id)
        core.delete_budget(b["id"])
    return {"deleted": b["id"]}


def _apply(b: dict, op: dict, lib: dict) -> None:
    kind = op.get("op")
    ritual = op.get("ritual", "")
    item = op.get("item", "")
    if kind == "add":
        core.add_ritual(b, ritual, op.get("times", 1), lib=lib)
    elif kind == "add_group":
        core.add_group(b, op.get("group", ""), op.get("times", 1), lib=lib)
    elif kind == "remove":
        core.remove_ritual(b, ritual)
    elif kind == "times":
        core.set_times(b, ritual, op.get("times"))
    elif kind == "qty":
        core.set_qty(b, ritual, item, op.get("qty"), lib=lib)
    elif kind == "drop_item":
        core.drop_item(b, ritual, item)
    elif kind == "reference":
        core.use_reference(b, ritual, lib=lib)
    elif kind == "other":
        core.set_other(b, item, op.get("qty"), op.get("note", ""), lib=lib)
    elif kind == "line":
        fields = {k: op[k] for k in core.LINE_FIELDS if k in op}
        core.set_line(b, item, lib=lib, **fields)
    elif kind == "rename":
        name = str(op.get("name", "")).strip()
        if not name:
            raise BudgetError("a budget needs a name")
        b["name"] = name
    else:
        raise BudgetError(f"unknown operation {kind!r}")


@app.post("/api/budgets/{budget_id}/ops")
def ops(budget_id: str, body: Any = Body(...), _: bool = Depends(authed)) -> dict:
    """One or more edits, applied together: all of them or none."""
    batch = body if isinstance(body, list) else [body]
    with _lock:
        b = _load(budget_id)
        lib = core.load_library()
        try:
            for op in batch:
                _apply(b, op, lib)
        except BudgetError as exc:
            raise _bad(exc) from None
        core.save_budget(b)
    return _view(b)


@app.post("/api/budgets/{budget_id}/write")
def write(budget_id: str, body: dict = Body(default={}), _: bool = Depends(authed)) -> dict:
    with _lock:
        b = _load(budget_id)
        try:
            info = core.write(b, spreadsheet=(body or {}).get("spreadsheet") or None)
        except BudgetError as exc:
            raise _bad(exc) from None
    return {"spreadsheet": info, **_view(b)}


@app.get("/")
def index(_: bool = Depends(authed)) -> FileResponse:
    return FileResponse(UI_DIR / "index.html")
