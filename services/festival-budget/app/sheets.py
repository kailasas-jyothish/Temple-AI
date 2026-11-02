"""Write a calculated budget into a Google Sheet as the service account.

The service account has no Drive storage of its own, so the Sheets API's
spreadsheets.create answers 403. A spreadsheet is instead created through the
Drive API *inside a Shared Drive folder* (the Shared Drive owns the file), or
an existing spreadsheet the account can edit is written into. Either way only
this service's tabs are touched; anything else in the file is left alone.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from . import config
from .core import NOT_BUILT, BudgetError

SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
DRIVE = "https://www.googleapis.com/drive/v3/files"
SUMMARY = "Summary"
MONEY = {"type": "NUMBER", "pattern": "₹#,##0.00"}


def open_session() -> Any:
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    if config.GOOGLE_SERVICE_ACCOUNT_JSON_B64:
        info = json.loads(base64.b64decode(config.GOOGLE_SERVICE_ACCOUNT_JSON_B64))
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    elif config.GOOGLE_SERVICE_ACCOUNT_FILE:
        creds = service_account.Credentials.from_service_account_file(config.GOOGLE_SERVICE_ACCOUNT_FILE, scopes=SCOPES)
    else:
        raise BudgetError("no Google service account configured (GOOGLE_SERVICE_ACCOUNT_FILE or _JSON_B64)")
    return AuthorizedSession(creds)


def account_email() -> str:
    try:
        if config.GOOGLE_SERVICE_ACCOUNT_JSON_B64:
            return json.loads(base64.b64decode(config.GOOGLE_SERVICE_ACCOUNT_JSON_B64))["client_email"]
        if config.GOOGLE_SERVICE_ACCOUNT_FILE:
            with open(config.GOOGLE_SERVICE_ACCOUNT_FILE, encoding="utf-8") as fh:
                return json.load(fh)["client_email"]
    except (OSError, ValueError, KeyError):
        pass
    return ""


def spreadsheet_id(text: str) -> str:
    """Accept a full docs.google.com link or a bare id."""
    m = re.search(r"/spreadsheets/d/([\w-]+)", text or "")
    sid = m.group(1) if m else (text or "").strip()
    if not re.fullmatch(r"[\w-]{20,}", sid):
        raise BudgetError(f"not a spreadsheet link or id: {text!r}")
    return sid


def _check(resp: Any, doing: str) -> dict:
    if resp.status_code >= 400:
        try:
            msg = resp.json().get("error", {}).get("message", resp.text)
        except ValueError:
            msg = resp.text
        hint = ""
        if resp.status_code in (403, 404):
            hint = (f" — share the spreadsheet or Shared Drive folder with {account_email() or 'the service account'}"
                    " as an editor")
        raise BudgetError(f"{doing}: Google answered {resp.status_code}: {msg[:300]}{hint}")
    return resp.json() if resp.content else {}


def create_spreadsheet(s: Any, title: str, folder_id: str) -> str:
    body = {"name": title, "mimeType": "application/vnd.google-apps.spreadsheet", "parents": [folder_id]}
    data = _check(s.post(DRIVE, params={"supportsAllDrives": "true", "fields": "id"}, json=body),
                  "creating the spreadsheet in the budget folder")
    return data["id"]


# ---------------------------------------------------------------- layout


def _n(d: Decimal | None) -> Any:
    if d is None:
        return ""
    return int(d) if d == d.to_integral_value() else float(d)


def section_grid(name: str, sec: dict, stamp: str) -> tuple[list[list[Any]], dict]:
    """Rows for one budget tab, plus where the formatting has to go."""
    head = ["Item", "Unit"]
    for c in sec["columns"]:
        if c["times"] > 1:
            head += [f"{c['name']} (1×)", f"{c['name']} (×{c['times']})"]
        else:
            head.append(c["name"])
    head += [sec["other_label"], "Total Required", "In Stock", "Net Required",
             "Purchase Qty", "Purchase Unit", "Rate", "Amount", sec["note_label"]]
    width = len(head)
    rate_col, amount_col = width - 3, width - 2
    rows: list[list[Any]] = [
        [f"{name} — {sec['title']}"] + [""] * (width - 1),
        [f"Written by Temple AI festival-budget on {stamp}. Edit the budget in the tool: "
         "writing again replaces this tab."] + [""] * (width - 1),
        head,
    ]
    marks = {"bold": [0, 2], "vendor": [], "total": [], "header": 2, "money_cols": (rate_col, amount_col + 1), "width": width}
    # Fruit has no vendor column in the library; a lone "Vendor: not set"
    # heading and a subtotal equal to the total would only be noise.
    grouped = any(row["vendor"] for row in sec["rows"])
    current = None
    for row in sec["rows"] + [None]:
        vendor = (row["vendor"] if row else None) if grouped else ("" if row else None)
        if grouped and current is not None and vendor != current:
            label = f"Subtotal — {current or 'No vendor'}"
            rows.append([label] + [""] * (amount_col - 1) + [_n(sec["vendors"][current]), ""])
            marks["total"].append(len(rows) - 1)
        if row is None:
            break
        if grouped and vendor != current:
            rows.append([f"Vendor: {vendor or 'not set'}"] + [""] * (width - 1))
            marks["vendor"].append(len(rows) - 1)
            current = vendor
        line = [row["name"], row["unit"]]
        for c, p in zip(sec["columns"], row["per"]):
            line += [_n(p["one"]), _n(p["total"])] if c["times"] > 1 else [_n(p["total"])]
        line += [_n(row["other"]), _n(row["required"]), _n(row["stock"]),
                 _n(row["net"]), _n(row["purchase"]), row["purchase_unit"], _n(row["rate"]),
                 _n(row["amount"]), row["note"]]
        rows.append(line)
    rows.append([""] * width)
    rows.append([f"TOTAL — {sec['title']}"] + [""] * (amount_col - 1) + [_n(sec["total"]), ""])
    marks["total"].append(len(rows) - 1)
    return rows, marks


def summary_grid(name: str, result: dict, stamp: str) -> tuple[list[list[Any]], dict]:
    rows: list[list[Any]] = [[f"{name} — Summary", ""], [f"Written on {stamp}", ""], ["Budget", "Amount"]]
    for sec in result["sections"].values():
        rows.append([sec["title"], _n(sec["total"])])
    for title in NOT_BUILT:
        rows.append([f"{title} (not included yet)", ""])
    rows.append(["TOTAL", _n(result["total"])])
    return rows, {"bold": [0, 2], "vendor": [], "total": [len(rows) - 1], "header": 2, "money_cols": (1, 2), "width": 2}


def _a1(tab: str) -> str:
    return "'" + tab.replace("'", "''") + "'!A1"


def _format_requests(sheet_id: int, rows: list[list[Any]], marks: dict) -> list[dict]:
    def rng(r0: int, r1: int, c0: int = 0, c1: int | None = None) -> dict:
        return {"sheetId": sheet_id, "startRowIndex": r0, "endRowIndex": r1,
                "startColumnIndex": c0, "endColumnIndex": c1 if c1 is not None else marks["width"]}

    def bold(r: int, bg: dict | None = None) -> dict:
        fmt: dict = {"textFormat": {"bold": True}}
        fields = "userEnteredFormat.textFormat.bold"
        if bg:
            fmt["backgroundColor"] = bg
            fields += ",userEnteredFormat.backgroundColor"
        return {"repeatCell": {"range": rng(r, r + 1), "cell": {"userEnteredFormat": fmt}, "fields": fields}}

    n = len(rows)
    h = marks["header"]
    m0, m1 = marks["money_cols"]
    reqs: list[dict] = [
        {"updateSheetProperties": {"properties": {"sheetId": sheet_id, "gridProperties": {
            "frozenRowCount": h + 1, "frozenColumnCount": 1}},
            "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}},
        {"repeatCell": {"range": rng(h + 1, n, m0, m1), "cell": {"userEnteredFormat": {"numberFormat": MONEY}},
                        "fields": "userEnteredFormat.numberFormat"}},
        {"repeatCell": {"range": rng(h, h + 1), "cell": {"userEnteredFormat": {"wrapStrategy": "WRAP",
                        "verticalAlignment": "MIDDLE"}},
                        "fields": "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment"}},
    ]
    reqs += [bold(r) for r in marks["bold"] if r != h]
    reqs.append(bold(h, {"red": 0.93, "green": 0.87, "blue": 0.75}))
    reqs += [bold(r, {"red": 0.96, "green": 0.96, "blue": 0.96}) for r in marks["vendor"]]
    reqs += [bold(r, {"red": 1, "green": 0.95, "blue": 0.8}) for r in marks["total"]]
    reqs.append({"autoResizeDimensions": {"dimensions": {"sheetId": sheet_id, "dimension": "COLUMNS",
                                                          "startIndex": 0, "endIndex": marks["width"]}}})
    # Autosize measures the long title and note rows too; cap the item column
    # by setting it explicitly afterwards.
    reqs.append({"updateDimensionProperties": {"range": {"sheetId": sheet_id, "dimension": "COLUMNS",
                                                         "startIndex": 0, "endIndex": 1},
                                               "properties": {"pixelSize": 220}, "fields": "pixelSize"}})
    return reqs


def write_budget(b: dict, result: dict, *, spreadsheet: str | None = None, session: Any = None) -> dict:
    s = session if session is not None else open_session()
    created = False
    if spreadsheet:
        sid = spreadsheet_id(spreadsheet)
    else:
        if not config.BUDGET_FOLDER_ID:
            raise BudgetError("no spreadsheet given and BUDGET_FOLDER_ID is not set, so there is nowhere to create one")
        sid = create_spreadsheet(s, f"{b['name']} — Festival Budget", config.BUDGET_FOLDER_ID)
        created = True

    stamp = datetime.now(timezone.utc).strftime("%d-%b-%Y %H:%M UTC")
    grids: dict[str, tuple[list[list[Any]], dict]] = {SUMMARY: summary_grid(b["name"], result, stamp)}
    for sec in result["sections"].values():
        grids[sec["title"]] = section_grid(b["name"], sec, stamp)

    meta = _check(s.get(f"{SHEETS}/{sid}", params={"fields": "sheets.properties(sheetId,title,index)"}),
                  "reading the spreadsheet")
    existing = {p["properties"]["title"]: p["properties"]["sheetId"] for p in meta.get("sheets", [])}

    # Our tabs are emptied (values and formatting) rather than deleted, so a
    # link someone bookmarked to a tab keeps working across rewrites.
    setup: list[dict] = []
    for index, title in enumerate(grids):
        if title in existing:
            setup.append({"updateCells": {"range": {"sheetId": existing[title]}, "fields": "*"}})
            setup.append({"unmergeCells": {"range": {"sheetId": existing[title]}}})
        else:
            setup.append({"addSheet": {"properties": {"title": title, "index": index}}})
    reply = _check(s.post(f"{SHEETS}/{sid}:batchUpdate", json={"requests": setup}), "preparing the tabs")
    for r in reply.get("replies", []):
        props = (r or {}).get("addSheet", {}).get("properties")
        if props:
            existing[props["title"]] = props["sheetId"]

    data = [{"range": _a1(t), "values": rows} for t, (rows, _) in grids.items()]
    _check(s.post(f"{SHEETS}/{sid}/values:batchUpdate", json={"valueInputOption": "RAW", "data": data}),
           "writing the values")

    fmt_reqs: list[dict] = []
    for title, (rows, marks) in grids.items():
        fmt_reqs += _format_requests(existing[title], rows, marks)
    if created:
        # A Drive-created spreadsheet starts with an empty "Sheet1"; nothing
        # else can be in it yet, so it goes.
        for title, sheet_id in existing.items():
            if title not in grids:
                fmt_reqs.append({"deleteSheet": {"sheetId": sheet_id}})
    _check(s.post(f"{SHEETS}/{sid}:batchUpdate", json={"requests": fmt_reqs}), "formatting the tabs")

    return {"id": sid, "url": f"https://docs.google.com/spreadsheets/d/{sid}/edit"}
