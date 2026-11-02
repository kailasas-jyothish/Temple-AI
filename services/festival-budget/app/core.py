"""Festival budgets: the one implementation the CLI, the web UI and the API share.

A *library* holds every item (with its unit, vendor and pack size) and every
ritual (with the per-performance quantity of each item). A *budget* picks
rituals from it, says how many times each is performed, and carries the
festival's own figures: quantities for the variable rituals, stock in hand,
and the vendor's rate for every item. Nothing here invents a figure: a
variable ritual starts with empty quantities and every rate starts empty, and
a budget with any of those missing cannot be written to a sheet.

All arithmetic is Decimal. Money is rounded once per line, to the paisa, so a
sheet's subtotals add up exactly to what is shown on each line.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from . import config

SEED = Path(__file__).resolve().parent / "seed" / "library.json"
SECTIONS = {"ritual": "Ritual Budget", "fruit": "Fruit Budget"}
# Shown on the Summary tab so the total visibly excludes them, rather than
# silently looking complete.
NOT_BUILT = ["Flowers Budget", "Madappalli Budget"]
# A pack in one of these units can only be bought whole (3 packets, not 2.4).
# kg / ton / litre packs are bought by weight, so they are rounded up to the gram.
WHOLE_PACK_UNITS = {"pkt", "packet", "box", "bundle", "bundles", "bag", "sack", "set", "tin", "bottle", "can", "nos", "portion"}


def countable(unit: str) -> bool:
    """"Bundle of 60", "1 g pkt", "set of 12" are all bought whole."""
    return any(word in WHOLE_PACK_UNITS for word in re.findall(r"[a-z]+", unit.lower()))
PAISA = Decimal("0.01")
QTY_STEP = Decimal("0.001")


class BudgetError(ValueError):
    """Something the person asked for cannot be done; the message says why."""


# ---------------------------------------------------------------- numbers


def dec(value: Any, what: str = "value") -> Decimal | None:
    """Parse a user number. Empty means 'not given', which is not the same as 0."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    text = str(value).strip().replace(",", "")
    if text == "":
        return None
    try:
        d = Decimal(text)
    except InvalidOperation:
        raise BudgetError(f"{what}: {value!r} is not a number") from None
    if not d.is_finite():
        raise BudgetError(f"{what}: {value!r} is not a number")
    return d


def fmt(d: Decimal | None) -> str:
    """Plain decimal text: no exponent, no trailing zeros. '' for missing."""
    if d is None:
        return ""
    d = d.quantize(Decimal("0.0001"), ROUND_HALF_UP) if d.as_tuple().exponent < -4 else d
    text = format(d.normalize(), "f")
    return "0" if text in ("-0", "") else text


def _store(value: Any, what: str, *, negative: bool = False) -> str | None:
    d = dec(value, what)
    if d is None:
        return None
    if d < 0 and not negative:
        raise BudgetError(f"{what}: cannot be negative")
    return fmt(d)


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or "item"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- storage


def _write_json(path: Path, data: Any) -> None:
    # Atomic: a crash mid-write must not leave a half budget behind.
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def library_path() -> Path:
    return config.DATA_DIR / "library.json"


def budgets_dir() -> Path:
    return config.DATA_DIR / "budgets"


def load_library() -> dict:
    """The editable library. Copied from the bundled seed the first time."""
    path = library_path()
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SEED, path)
    return json.loads(path.read_text(encoding="utf-8"))


def save_library(lib: dict) -> None:
    _write_json(library_path(), lib)


def items_by_id(lib: dict) -> dict[str, dict]:
    return {i["id"]: i for i in lib["items"]}


def rituals_by_id(lib: dict) -> dict[str, dict]:
    return {r["id"]: r for r in lib["rituals"]}


def find(collection: dict[str, dict], key: str, what: str) -> dict:
    """Look up by id, or by name ignoring case, so the CLI can take either."""
    if key in collection:
        return collection[key]
    wanted = slug(key)
    for entry in collection.values():
        if entry["id"] == wanted or slug(entry["name"]) == wanted:
            return entry
    raise BudgetError(f"no {what} called {key!r}")


# ---------------------------------------------------------------- library edits


def save_item(lib: dict, *, name: str, unit: str, section: str = "ritual", vendor: str = "",
              pack_unit: str = "", pack_size: Any = None, whole: bool | None = None,
              item_id: str | None = None) -> dict:
    """Add an item, or replace the one with the same id."""
    name = name.strip()
    unit = unit.strip()
    if not name or not unit:
        raise BudgetError("an item needs a name and a unit")
    if section not in SECTIONS:
        raise BudgetError(f"section must be one of {', '.join(SECTIONS)}")
    pack = None
    if pack_unit.strip() or pack_size not in (None, ""):
        size = dec(pack_size, "pack size")
        if not pack_unit.strip() or size is None or size <= 0:
            raise BudgetError("a pack needs both a unit and a size above 0 (e.g. Pkt of 54)")
        pack = {"unit": pack_unit.strip(), "size": float(size)}
    item = {
        "id": item_id or slug(name),
        "name": name,
        "unit": unit,
        "section": section,
        "vendor": vendor.strip(),
        "pack": pack,
        "whole": bool(whole) if whole is not None else countable(unit),
    }
    lib["items"] = [i for i in lib["items"] if i["id"] != item["id"]] + [item]
    lib["items"].sort(key=lambda i: (i["section"], i["name"].lower()))
    return item


def save_ritual(lib: dict, *, name: str, kind: str = "variable", group: str = "",
                items: dict[str, Any] | None = None, ritual_id: str | None = None) -> dict:
    """Add a ritual, or replace the one with the same id. Quantities are per performance."""
    name = name.strip()
    if not name:
        raise BudgetError("a ritual needs a name")
    if kind not in ("constant", "variable"):
        raise BudgetError("kind must be constant or variable")
    known = items_by_id(lib)
    clean: dict[str, float] = {}
    for item_id, qty in (items or {}).items():
        if item_id not in known:
            raise BudgetError(f"{name}: unknown item {item_id!r}")
        d = dec(qty, f"{name} / {known[item_id]['name']}")
        if d is not None:
            if d < 0:
                raise BudgetError(f"{name} / {known[item_id]['name']}: cannot be negative")
            clean[item_id] = float(d)
    ritual = {"id": ritual_id or slug(name), "name": name, "kind": kind, "group": group.strip(), "items": clean}
    lib["rituals"] = [r for r in lib["rituals"] if r["id"] != ritual["id"]] + [ritual]
    return ritual


# ---------------------------------------------------------------- budgets


def list_budgets() -> list[dict]:
    out = []
    for path in sorted(budgets_dir().glob("*.json")):
        b = json.loads(path.read_text(encoding="utf-8"))
        out.append({"id": b["id"], "name": b["name"], "updated": b["updated"],
                    "rituals": len(b["rituals"]), "spreadsheet": b.get("spreadsheet")})
    return sorted(out, key=lambda b: b["updated"], reverse=True)


def load_budget(budget_id: str) -> dict:
    """By id, or by name ignoring case and punctuation."""
    if re.fullmatch(r"[a-z0-9-]+", budget_id or ""):
        path = budgets_dir() / f"{budget_id}.json"
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    for b in list_budgets():
        if slug(b["name"]) == slug(budget_id) or slug(b["id"]) == slug(budget_id):
            return json.loads((budgets_dir() / f"{b['id']}.json").read_text(encoding="utf-8"))
    raise BudgetError(f"no budget called {budget_id!r}")


def save_budget(b: dict) -> dict:
    b["updated"] = now()
    _write_json(budgets_dir() / f"{b['id']}.json", b)
    return b


def delete_budget(budget_id: str) -> None:
    b = load_budget(budget_id)
    (budgets_dir() / f"{b['id']}.json").unlink()


def new_budget(name: str, *, constants: bool = False, lib: dict | None = None) -> dict:
    """A new budget, empty by default: people pick each ritual and say how many
    times it is performed. Pre-adding the constants once each hid that choice."""
    name = name.strip()
    if not name:
        raise BudgetError("a budget needs a name")
    base = slug(name).replace("_", "-")
    bid, n = base, 2
    while (budgets_dir() / f"{bid}.json").exists():
        bid, n = f"{base}-{n}", n + 1
    b = {"id": bid, "name": name, "created": now(), "updated": now(), "spreadsheet": None,
         "rituals": [], "others": [], "lines": {}}
    if constants:
        lib = lib or load_library()
        for r in lib["rituals"]:
            if r["kind"] == "constant":
                add_ritual(b, r["id"], 1, lib=lib)
    return save_budget(b)


def _budget_ritual(b: dict, ritual_id: str) -> dict:
    for r in b["rituals"]:
        if r["ritual_id"] == ritual_id:
            return r
    for r in b["rituals"]:
        if slug(r["name"]) == slug(ritual_id):
            return r
    raise BudgetError(f"{ritual_id!r} is not in this budget")


def _times(value: Any) -> int:
    d = dec(value, "number of times")
    if d is None or d != d.to_integral_value() or d < 1:
        raise BudgetError("the number of times a ritual is performed must be a whole number, 1 or more")
    return int(d)


def add_ritual(b: dict, ritual_id: str, times: Any = 1, *, lib: dict | None = None) -> dict:
    """Add a library ritual. A constant brings its library quantities; a
    variable brings its item list with every quantity empty, to be filled for
    this festival (the library figures stay available as a reference)."""
    lib = lib or load_library()
    r = find(rituals_by_id(lib), ritual_id, "ritual")
    if any(x["ritual_id"] == r["id"] for x in b["rituals"]):
        raise BudgetError(f"{r['name']} is already in this budget; change its number of times instead")
    entry = {
        "ritual_id": r["id"],
        "name": r["name"],
        "kind": r["kind"],
        "group": r.get("group", ""),
        "times": _times(times),
        "qty": {i: (fmt(Decimal(str(q))) if r["kind"] == "constant" else None) for i, q in r["items"].items()},
    }
    b["rituals"].append(entry)
    return entry


def add_group(b: dict, group: str, times: Any = 1, *, lib: dict | None = None) -> list[dict]:
    """Add every ritual of a library group (e.g. Homa) that the budget lacks."""
    lib = lib or load_library()
    members = [r for r in lib["rituals"] if r.get("group", "").lower() == group.strip().lower()]
    if not members:
        raise BudgetError(f"no ritual group called {group!r}")
    have = {x["ritual_id"] for x in b["rituals"]}
    return [add_ritual(b, r["id"], times, lib=lib) for r in members if r["id"] not in have]


def remove_ritual(b: dict, ritual_id: str) -> None:
    r = _budget_ritual(b, ritual_id)
    b["rituals"].remove(r)


def set_times(b: dict, ritual_id: str, times: Any) -> None:
    _budget_ritual(b, ritual_id)["times"] = _times(times)


def set_qty(b: dict, ritual_id: str, item_id: str, qty: Any, *, lib: dict | None = None) -> None:
    """Per-performance quantity of one item in one ritual. Empty clears it;
    a new item id adds it to the ritual for this budget only."""
    lib = lib or load_library()
    r = _budget_ritual(b, ritual_id)
    item = find(items_by_id(lib), item_id, "item")
    r["qty"][item["id"]] = _store(qty, f"{r['name']} / {item['name']}")


def drop_item(b: dict, ritual_id: str, item_id: str) -> None:
    r = _budget_ritual(b, ritual_id)
    r["qty"].pop(item_id, None)


def use_reference(b: dict, ritual_id: str, *, lib: dict | None = None) -> int:
    """Fill a ritual's empty quantities from the library. Returns how many."""
    lib = lib or load_library()
    r = _budget_ritual(b, ritual_id)
    ref = rituals_by_id(lib).get(r["ritual_id"], {}).get("items", {})
    filled = 0
    for item_id, q in r["qty"].items():
        if q is None and item_id in ref:
            r["qty"][item_id] = fmt(Decimal(str(ref[item_id])))
            filled += 1
    return filled


def set_other(b: dict, item_id: str, qty: Any, note: str = "", *, lib: dict | None = None) -> None:
    """Quantity outside any ritual: 'Miscellaneous' on the fruit sheet (fruit
    for naivedyam, say), 'Others' on the ritual sheet. 0 or empty removes it."""
    lib = lib or load_library()
    item = find(items_by_id(lib), item_id, "item")
    value = _store(qty, f"{item['name']} (other)")
    b["others"] = [o for o in b["others"] if o["item_id"] != item["id"]]
    if value not in (None, "0"):
        b["others"].append({"item_id": item["id"], "qty": value, "note": note.strip()})


LINE_FIELDS = ("stock", "rate", "override", "override_reason", "note")


def set_line(b: dict, item_id: str, *, lib: dict | None = None, **fields: Any) -> dict:
    """Stock in hand (in the item's unit), the vendor's rate (per purchase
    unit), a purchase-quantity override with its reason, and a note."""
    lib = lib or load_library()
    item = find(items_by_id(lib), item_id, "item")
    line = b["lines"].setdefault(item["id"], {})
    for key, value in fields.items():
        if key not in LINE_FIELDS:
            raise BudgetError(f"unknown field {key!r}")
        if key in ("stock", "rate", "override"):
            line[key] = _store(value, f"{item['name']} {key}")
        else:
            line[key] = (value or "").strip() or None
    return line


# ---------------------------------------------------------------- calculation


def purchase_unit(item: dict) -> str:
    return item["pack"]["unit"] if item.get("pack") else item["unit"]


def _purchase(item: dict, net: Decimal) -> Decimal:
    if net <= 0:
        return Decimal(0)
    pack = item.get("pack")
    if pack:
        q = net / Decimal(str(pack["size"]))
        if countable(pack["unit"]):
            return q.to_integral_value(ROUND_CEILING)
        return q.quantize(QTY_STEP, ROUND_CEILING)
    if item.get("whole"):
        return net.to_integral_value(ROUND_CEILING)
    return net.quantize(QTY_STEP, ROUND_CEILING)


def calculate(b: dict, lib: dict | None = None) -> dict:
    """Every number the sheet shows, plus the list of what is still missing.

    required = sum(qty x times) + others; net = required - stock (not below 0);
    purchase = override, else net rounded up to whole packs / whole units;
    amount = purchase x rate, to the paisa.
    """
    lib = lib or load_library()
    items = items_by_id(lib)
    problems: list[str] = []
    others = {o["item_id"]: o for o in b["others"]}

    for r in b["rituals"]:
        if not r["qty"]:
            problems.append(f"{r['name']}: no items yet — add its items, or remove it from this budget")
        if not isinstance(r.get("times"), int) or r["times"] < 1:
            problems.append(f"{r['name']}: number of times must be 1 or more")
        for item_id, q in r["qty"].items():
            if item_id not in items:
                problems.append(f"{r['name']}: item {item_id!r} is no longer in the library")
            elif q is None:
                problems.append(f"{r['name']}: quantity of {items[item_id]['name']} not filled")

    sections: dict[str, dict] = {}
    for key, title in SECTIONS.items():
        columns = [r for r in b["rituals"]
                   if any(items.get(i, {}).get("section") == key for i in r["qty"])]
        used = {i for r in columns for i in r["qty"] if items.get(i, {}).get("section") == key}
        used |= {i for i in others if items.get(i, {}).get("section") == key}
        rows = []
        for item_id in used:
            item = items[item_id]
            line = b["lines"].get(item_id, {})
            per = []
            required = Decimal(0)
            for r in columns:
                q = dec(r["qty"].get(item_id))
                total = q * r["times"] if q is not None else None
                per.append({"one": q, "total": total})
                required += total or 0
            other = dec(others[item_id]["qty"]) if item_id in others else None
            required += other or 0
            stock = dec(line.get("stock")) or Decimal(0)
            net = max(Decimal(0), required - stock)
            override = dec(line.get("override"))
            purchase = override if override is not None else _purchase(item, net)
            rate = dec(line.get("rate"))
            amount = (purchase * rate).quantize(PAISA, ROUND_HALF_UP) if rate is not None else None
            if rate is None and purchase > 0:
                problems.append(f"{title}: rate for {item['name']} not filled")
            if override is not None and not line.get("override_reason"):
                problems.append(f"{title}: {item['name']} purchase quantity is overridden without a reason")
            note = line.get("note") or ""
            if item_id in others and others[item_id].get("note"):
                note = "; ".join(x for x in (others[item_id]["note"], note) if x)
            if override is not None and line.get("override_reason"):
                note = "; ".join(x for x in (note, f"purchase set by hand: {line['override_reason']}") if x)
            rows.append({
                "item_id": item_id, "name": item["name"], "unit": item["unit"],
                "vendor": item.get("vendor") or "", "per": per, "other": other,
                "required": required, "stock": stock, "net": net, "purchase": purchase,
                "purchase_unit": purchase_unit(item), "rate": rate, "amount": amount, "note": note,
                "has_stock": line.get("stock") is not None,
            })
        rows.sort(key=lambda x: (x["vendor"] == "", x["vendor"].lower(), x["name"].lower()))
        vendors: dict[str, Decimal] = {}
        for row in rows:
            vendors[row["vendor"]] = vendors.get(row["vendor"], Decimal(0)) + (row["amount"] or 0)
        sections[key] = {
            "title": title,
            "columns": [{"ritual_id": r["ritual_id"], "name": r["name"], "times": r["times"], "kind": r["kind"]}
                        for r in columns],
            "other_label": "Miscellaneous" if key == "fruit" else "Others",
            "note_label": "Purpose" if key == "fruit" else "Notes",
            "rows": rows,
            "vendors": vendors,
            "total": sum((row["amount"] or 0 for row in rows), Decimal(0)),
        }
    total = sum((s["total"] for s in sections.values()), Decimal(0))
    return {"sections": sections, "total": total, "problems": problems}


def plain(result: dict) -> dict:
    """The calculation with Decimals as text, for JSON."""
    def conv(x: Any) -> Any:
        if isinstance(x, Decimal):
            return fmt(x)
        if isinstance(x, dict):
            return {k: conv(v) for k, v in x.items()}
        if isinstance(x, list):
            return [conv(v) for v in x]
        return x
    return conv(result)


# ---------------------------------------------------------------- writing


def write(b: dict, *, spreadsheet: str | None = None, lib: dict | None = None, session: Any = None) -> dict:
    """Write the budget to its Google Sheet. Refuses while anything is missing,
    because a budget with blank rates totals to a number that is simply wrong."""
    from . import sheets

    lib = lib or load_library()
    result = calculate(b, lib)
    if result["problems"]:
        shown = "\n  ".join(result["problems"][:40])
        more = len(result["problems"]) - 40
        raise BudgetError("cannot write yet — fill these first:\n  " + shown + (f"\n  …and {more} more" if more > 0 else ""))
    target = spreadsheet or (b.get("spreadsheet") or {}).get("id")
    info = sheets.write_budget(b, result, spreadsheet=target, session=session)
    b["spreadsheet"] = info
    b["written"] = now()
    save_budget(b)
    return info


def summary_line(b: dict, lib: dict | None = None) -> dict:
    r = calculate(b, lib)
    return {"id": b["id"], "name": b["name"], "total": fmt(r["total"]),
            "sections": {k: fmt(s["total"]) for k, s in r["sections"].items()},
            "problems": len(r["problems"])}
