import json
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app import config, core, sheets
from app.main import app

LIB = {
    "items": [
        {"id": "ghee", "name": "Ghee", "unit": "kg", "section": "ritual", "vendor": "Dairy", "pack": None, "whole": False},
        {"id": "agarbathi", "name": "Agarbathi", "unit": "nos", "section": "ritual", "vendor": "Pooja Store",
         "pack": {"unit": "PKT", "size": 54}, "whole": True},
        {"id": "firewood", "name": "Firewood", "unit": "kg", "section": "ritual", "vendor": "",
         "pack": {"unit": "ton", "size": 1000}, "whole": False},
        {"id": "lamp", "name": "Lamp", "unit": "nos", "section": "ritual", "vendor": "", "pack": None, "whole": True},
        {"id": "banana", "name": "Banana", "unit": "nos", "section": "fruit", "vendor": "", "pack": None, "whole": True},
    ],
    "rituals": [
        {"id": "abhishekam", "name": "Abhishekam", "kind": "constant", "group": "",
         "items": {"ghee": 0.25, "agarbathi": 20, "banana": 12}},
        {"id": "durga_puja", "name": "Durga Puja", "kind": "variable", "group": "",
         "items": {"ghee": 1, "firewood": 30, "lamp": 2.5}},
        {"id": "agnikaryam", "name": "Agnikaryam", "kind": "constant", "group": "Homa", "items": {"ghee": 0.5}},
        {"id": "poornahuti", "name": "Poornahuti", "kind": "constant", "group": "Homa", "items": {"ghee": 0.1}},
    ],
}


@pytest.fixture(autouse=True)
def data(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "UI_PASSWORD", "")
    (tmp_path / "library.json").write_text(json.dumps(LIB), encoding="utf-8")
    return tmp_path


def rows(b):
    r = core.calculate(b)
    return {row["item_id"]: row for sec in r["sections"].values() for row in sec["rows"]}, r


def test_seed_library_has_no_rates_and_valid_references():
    seed = json.loads(core.SEED.read_text(encoding="utf-8"))
    ids = {i["id"] for i in seed["items"]}
    assert not any("rate" in i for i in seed["items"])
    for r in seed["rituals"]:
        assert set(r["items"]) <= ids, r["id"]


def test_new_budget_adds_constants_with_quantities_and_variables_empty():
    b = core.new_budget("Navaratri")
    assert [r["ritual_id"] for r in b["rituals"]] == ["abhishekam", "agnikaryam", "poornahuti"]
    core.add_ritual(b, "Durga Puja", 3)
    durga = b["rituals"][-1]
    assert durga["times"] == 3 and set(durga["qty"].values()) == {None}
    with pytest.raises(core.BudgetError):
        core.add_ritual(b, "durga_puja")
    _, r = rows(b)
    assert any("Durga Puja: quantity of Ghee not filled" in p for p in r["problems"])


def test_quantities_times_stock_and_pack_rounding():
    b = core.new_budget("Test")
    core.add_ritual(b, "durga_puja", 3)
    core.use_reference(b, "durga_puja")
    core.set_line(b, "ghee", stock="1")
    by, _ = rows(b)
    # 0.25 + 0.5 + 0.1 + 1×3 = 3.85 kg, less 1 kg in stock
    assert by["ghee"]["required"] == Decimal("3.85") and by["ghee"]["purchase"] == Decimal("2.85")
    # 20 sticks -> one whole packet of 54, never 0.37 of one
    assert by["agarbathi"]["purchase"] == 1 and by["agarbathi"]["purchase_unit"] == "PKT"
    # 90 kg of firewood is bought by the ton, by weight: 0.09 ton
    assert by["firewood"]["purchase"] == Decimal("0.090")
    # 2.5 lamps × 3 = 7.5 -> 8 whole lamps
    assert by["lamp"]["purchase"] == 8


def test_countable_pack_units():
    assert core.countable("Bundle of 60") and core.countable("1 g pkt") and core.countable("Box of 30")
    assert not core.countable("kg") and not core.countable("ton")


def test_every_rate_is_mandatory_and_amounts_round_per_line():
    b = core.new_budget("Test")
    _, r = rows(b)
    missing = [p for p in r["problems"] if "rate for" in p]
    assert len(missing) == 3  # ghee, agarbathi, banana
    core.set_line(b, "ghee", rate="333.333")
    core.set_line(b, "agarbathi", rate="45")
    core.set_line(b, "banana", rate="4")
    by, r = rows(b)
    assert r["problems"] == []
    assert by["ghee"]["amount"] == Decimal("283.33")  # 0.85 × 333.333 = 283.33305
    assert r["sections"]["ritual"]["total"] == Decimal("328.33")
    assert r["sections"]["fruit"]["total"] == Decimal("48.00")
    assert r["total"] == Decimal("376.33")


def test_stock_covering_need_means_no_rate_needed():
    b = core.new_budget("Test")
    core.set_line(b, "banana", stock="100")
    by, r = rows(b)
    assert by["banana"]["purchase"] == 0
    assert not any("Banana" in p for p in r["problems"])


def test_override_needs_a_reason_and_is_noted():
    b = core.new_budget("Test")
    core.set_line(b, "ghee", override="5", rate="600")
    _, r = rows(b)
    assert any("overridden without a reason" in p for p in r["problems"])
    core.set_line(b, "ghee", override_reason="5 L tins")
    by, r = rows(b)
    assert by["ghee"]["purchase"] == 5 and by["ghee"]["amount"] == Decimal("3000.00")
    assert "purchase set by hand: 5 L tins" in by["ghee"]["note"]


def test_miscellaneous_fruit_and_negative_rejected():
    b = core.new_budget("Test")
    core.set_other(b, "banana", "24", "naivedyam")
    by, _ = rows(b)
    assert by["banana"]["required"] == 36 and by["banana"]["note"] == "naivedyam"
    core.set_other(b, "banana", "0")
    assert b["others"] == []
    with pytest.raises(core.BudgetError):
        core.set_line(b, "ghee", stock="-1")
    with pytest.raises(core.BudgetError):
        core.set_times(b, "abhishekam", "1.5")


def test_empty_ritual_blocks_writing():
    b = core.new_budget("Test")
    core.add_ritual(b, "durga_puja")
    for item in list(b["rituals"][-1]["qty"]):
        core.drop_item(b, "durga_puja", item)
    with pytest.raises(core.BudgetError, match="no items yet"):
        core.write(b, session=object())


class FakeSession:
    """Answers just enough of the Sheets/Drive API to record what was sent."""

    def __init__(self, tabs=("Sheet1",)):
        self.tabs = {t: n for n, t in enumerate(tabs)}
        self.calls = []

    class R:
        def __init__(self, data, status=200):
            self.status_code, self._data = status, data
            self.content = b"x"
            self.text = json.dumps(data)

        def json(self):
            return self._data

    def get(self, url, params=None):
        self.calls.append(("GET", url, None))
        return self.R({"sheets": [{"properties": {"title": t, "sheetId": i}} for t, i in self.tabs.items()]})

    def post(self, url, params=None, json=None):
        self.calls.append(("POST", url, json))
        if url == sheets.DRIVE:
            return self.R({"id": "x" * 30})
        replies = []
        for req in (json or {}).get("requests", []):
            if "addSheet" in req:
                sid = 100 + len(self.tabs)
                self.tabs[req["addSheet"]["properties"]["title"]] = sid
                replies.append({"addSheet": {"properties": {"title": req["addSheet"]["properties"]["title"], "sheetId": sid}}})
            else:
                replies.append({})
        return self.R({"replies": replies})


def filled_budget():
    b = core.new_budget("Navaratri 2026")
    core.add_ritual(b, "durga_puja", 2)
    core.use_reference(b, "durga_puja")
    for item in ("ghee", "agarbathi", "firewood", "lamp", "banana"):
        core.set_line(b, item, rate="10")
    return b


def test_write_creates_in_folder_lays_out_tabs_and_drops_sheet1(monkeypatch):
    monkeypatch.setattr(config, "BUDGET_FOLDER_ID", "folder123")
    b = filled_budget()
    s = FakeSession()
    info = core.write(b, session=s)
    assert info["id"] == "x" * 30 and core.load_budget(b["id"])["spreadsheet"]["id"] == info["id"]
    drive = [c for c in s.calls if c[1] == sheets.DRIVE][0][2]
    assert drive["parents"] == ["folder123"]
    values = [c[2] for c in s.calls if c[1].endswith("values:batchUpdate")][0]
    assert values["valueInputOption"] == "RAW"
    grid = {d["range"]: d["values"] for d in values["data"]}
    ritual = grid["'Ritual Budget'!A1"]
    head = ritual[2]
    assert head[:2] == ["Item", "Unit"] and "Durga Puja (1×)" in head and "Durga Puja (×2)" in head
    assert head[-3:] == ["Rate", "Amount", "Notes"]
    assert ritual[-1][0] == "TOTAL — Ritual Budget"
    assert any(r[0] == "Vendor: Dairy" for r in ritual)
    fruit = grid["'Fruit Budget'!A1"]
    assert "Miscellaneous" in fruit[2] and fruit[2][-1] == "Purpose"
    assert not any(str(r[0]).startswith("Vendor:") for r in fruit)
    summary = grid["'Summary'!A1"]
    assert summary[-1][0] == "TOTAL" and any("Flowers Budget" in r[0] for r in summary)
    fmt = [c[2] for c in s.calls if c[1].endswith(":batchUpdate") and "values" not in c[1]][-1]["requests"]
    assert {"deleteSheet": {"sheetId": 0}} in fmt


def test_rewrite_clears_own_tabs_and_keeps_others():
    b = filled_budget()
    s = FakeSession(tabs=("Notes", "Summary", "Ritual Budget", "Fruit Budget"))
    core.write(b, spreadsheet="https://docs.google.com/spreadsheets/d/" + "y" * 30 + "/edit", session=s)
    setup = [c[2] for c in s.calls if c[1].endswith(":batchUpdate") and "values" not in c[1]][0]["requests"]
    assert not any("addSheet" in r for r in setup)
    cleared = {r["updateCells"]["range"]["sheetId"] for r in setup if "updateCells" in r}
    assert cleared == {1, 2, 3}  # never the user's own "Notes" tab
    fmt = [c[2] for c in s.calls if c[1].endswith(":batchUpdate") and "values" not in c[1]][-1]["requests"]
    assert not any("deleteSheet" in r for r in fmt)


def test_write_without_folder_or_link_says_so(monkeypatch):
    monkeypatch.setattr(config, "BUDGET_FOLDER_ID", "")
    with pytest.raises(core.BudgetError, match="BUDGET_FOLDER_ID"):
        core.write(filled_budget(), session=FakeSession())


def test_spreadsheet_id_parsing():
    assert sheets.spreadsheet_id("https://docs.google.com/spreadsheets/d/" + "a" * 44 + "/edit#gid=0") == "a" * 44
    with pytest.raises(core.BudgetError):
        sheets.spreadsheet_id("not a link")


# ---------------------------------------------------------------- HTTP


client = TestClient(app)


def test_healthz_is_open_even_with_password(monkeypatch):
    monkeypatch.setattr(config, "UI_PASSWORD", "secret")
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True and body["budgets"] == 0 and isinstance(body["problems"], list)
    assert client.get("/").status_code == 401
    assert client.get("/api/budgets").status_code == 401
    assert client.get("/api/budgets", auth=("any", "secret")).status_code == 200


def test_api_ops_apply_all_or_none():
    v = client.post("/api/budgets", json={"name": "Deepam"}).json()
    bid = v["budget"]["id"]
    assert client.get("/").status_code == 200
    ok = client.post(f"/api/budgets/{bid}/ops", json=[
        {"op": "add", "ritual": "durga_puja", "times": 2},
        {"op": "reference", "ritual": "durga_puja"},
        {"op": "line", "item": "ghee", "rate": "600"},
    ])
    assert ok.status_code == 200
    ghee = [r for r in ok.json()["calc"]["sections"]["ritual"]["rows"] if r["item_id"] == "ghee"][0]
    assert ghee["purchase"] == "2.85" and ghee["amount"] == "1710"
    bad = client.post(f"/api/budgets/{bid}/ops", json=[
        {"op": "line", "item": "lamp", "rate": "5"},
        {"op": "times", "ritual": "durga_puja", "times": 0},
    ])
    assert bad.status_code == 422
    after = client.get(f"/api/budgets/{bid}").json()["budget"]
    assert "lamp" not in after["lines"]
    w = client.post(f"/api/budgets/{bid}/write", json={})
    assert w.status_code == 422 and "rate for" in w.json()["detail"]
