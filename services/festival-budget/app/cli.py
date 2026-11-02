"""Command line front end. Every command goes through app/core.py, as the web UI does.

Run with no arguments for the guided flow: pick or create a budget, fill in
what is missing, write it to the sheet.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from . import config, core
from .core import BudgetError, fmt

INR = "₹"


def money(d: Any) -> str:
    if d is None:
        return "—"
    return f"{INR}{float(d):,.2f}"


def ask(prompt: str, default: str = "") -> str:
    try:
        text = input(f"{prompt}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        raise SystemExit(1) from None
    return text or default


# ---------------------------------------------------------------- printing


def print_library(lib: dict, section: str | None = None) -> None:
    print("Rituals (quantities are per performance):")
    for r in lib["rituals"]:
        group = f" [{r['group']}]" if r.get("group") else ""
        print(f"  {r['id']:<40} {r['kind']:<9}{group}  {r['name']} — {len(r['items'])} items")
    print("\nItems:")
    for i in lib["items"]:
        if section and i["section"] != section:
            continue
        pack = f", bought as {i['pack']['unit']} of {fmt(core.dec(i['pack']['size']))}" if i.get("pack") else ""
        vendor = f"  ({i['vendor']})" if i.get("vendor") else ""
        print(f"  {i['id']:<32} {i['section']:<6} {i['name']} [{i['unit']}{pack}]{vendor}")


def print_budget(b: dict, lib: dict, *, detail: bool = True) -> dict:
    result = core.calculate(b, lib)
    print(f"\n{b['name']}  ({b['id']})")
    if b.get("spreadsheet"):
        print(f"  sheet: {b['spreadsheet']['url']}")
    print("  rituals: " + (", ".join(f"{r['name']} ×{r['times']}" for r in b["rituals"]) or "none"))
    for sec in result["sections"].values():
        print(f"\n  {sec['title']}  —  {money(sec['total'])}")
        if not detail:
            continue
        print(f"    {'item':<28}{'required':>10}{'stock':>9}{'buy':>9} {'unit':<10}{'rate':>11}{'amount':>13}")
        for row in sec["rows"]:
            print(f"    {row['name'][:27]:<28}{fmt(row['required']):>10}{fmt(row['stock']):>9}"
                  f"{fmt(row['purchase']):>9} {row['purchase_unit'][:9]:<10}"
                  f"{(money(row['rate']) if row['rate'] is not None else 'MISSING'):>11}{money(row['amount']):>13}")
    print(f"\n  TOTAL {money(result['total'])}")
    if result["problems"]:
        print(f"\n  {len(result['problems'])} thing(s) to fill before it can be written:")
        for p in result["problems"][:25]:
            print(f"    - {p}")
        if len(result["problems"]) > 25:
            print(f"    …and {len(result['problems']) - 25} more")
    return result


# ---------------------------------------------------------------- guided fill


def fill(b: dict, lib: dict) -> None:
    """Ask for everything still empty: variable quantities, then stock, then rates.
    Enter keeps the shown value; '-' skips an optional field."""
    items = core.items_by_id(lib)
    refs = core.rituals_by_id(lib)

    for r in b["rituals"]:
        empty = [i for i, q in r["qty"].items() if q is None]
        if not empty:
            continue
        ref = refs.get(r["ritual_id"], {}).get("items", {})
        print(f"\n{r['name']} (×{r['times']}): quantity per performance. Reference from past budgets in brackets.")
        if ref and ask("  Use all reference quantities? y/n", "n").lower().startswith("y"):
            core.use_reference(b, r["ritual_id"], lib=lib)
            core.save_budget(b)
            continue
        for item_id in empty:
            item = items[item_id]
            hint = fmt(core.dec(ref.get(item_id))) if item_id in ref else ""
            while True:
                value = ask(f"  {item['name']} ({item['unit']})", hint)
                try:
                    core.set_qty(b, r["ritual_id"], item_id, value or None, lib=lib)
                    break
                except BudgetError as exc:
                    print(f"    {exc}")
        core.save_budget(b)

    result = core.calculate(b, lib)
    rows = [row for sec in result["sections"].values() for row in sec["rows"] if row["required"] > 0]

    if rows and ask("\nEnter stock in hand now? y/n", "y").lower().startswith("y"):
        print("Stock in hand, in the item's own unit. Enter keeps the shown value.")
        for row in rows:
            current = b["lines"].get(row["item_id"], {}).get("stock") or "0"
            while True:
                value = ask(f"  {row['name']} — need {fmt(row['required'])} {row['unit']}, in stock", current)
                try:
                    core.set_line(b, row["item_id"], stock=value, lib=lib)
                    break
                except BudgetError as exc:
                    print(f"    {exc}")
        core.save_budget(b)

    result = core.calculate(b, lib)
    missing = [row for sec in result["sections"].values() for row in sec["rows"]
               if row["rate"] is None and row["purchase"] > 0]
    if missing:
        print("\nVendor rates — every item to be bought needs one. Per purchase unit.")
    for row in missing:
        while True:
            value = ask(f"  {row['name']} — buying {fmt(row['purchase'])} {row['purchase_unit']}, rate {INR} per "
                        f"{row['purchase_unit']}")
            if not value:
                print("    a rate is required (type 0 if it really costs nothing)")
                continue
            try:
                core.set_line(b, row["item_id"], rate=value, lib=lib)
                break
            except BudgetError as exc:
                print(f"    {exc}")
        core.save_budget(b)


def pick_budget(lib: dict) -> dict:
    budgets = core.list_budgets()
    print("\nBudgets:")
    for n, x in enumerate(budgets, 1):
        print(f"  {n}. {x['name']}  (updated {x['updated'][:10]})")
    print(f"  {len(budgets) + 1}. new budget")
    choice = ask("Choose", str(len(budgets) + 1) if not budgets else "1")
    if choice.isdigit() and 1 <= int(choice) <= len(budgets):
        return core.load_budget(budgets[int(choice) - 1]["id"])
    name = ask("Festival name (e.g. Karthigai Deepam 2026)")
    b = core.new_budget(name, lib=lib)
    pick_rituals(b, lib)
    return b


def ordered_rituals(lib: dict) -> list[dict]:
    """Standard (constant) rituals first, then festival (variable) ones, as on the UI's tile board."""
    return [r for r in lib["rituals"] if r["kind"] == "constant"] + \
           [r for r in lib["rituals"] if r["kind"] != "constant"]


def pick_rituals(b: dict, lib: dict) -> None:
    """The CLI's tile board: every ritual is listed, picked ones are ticked with
    their count, and one line toggles a ritual or sets its count."""
    while True:
        chosen = {r["ritual_id"]: r for r in b["rituals"]}
        rituals = ordered_rituals(lib)
        print()
        heading = None
        for n, r in enumerate(rituals, 1):
            h = "Standard rituals (bring their usual quantities)" if r["kind"] == "constant" \
                else "Festival rituals (you fill the quantities)"
            if h != heading:
                heading = h
                print(f"  {h}")
            got = chosen.get(r["id"])
            mark = f"[✓] ×{got['times']:<3}" if got else "[ ]     "
            group = f"  · {r['group']}" if r.get("group") else ""
            print(f"    {mark} {n:>2}. {r['name']}{group}")
        print('\n  "5" picks or unpicks ritual 5 · "5 x10" picks it performed 10 times'
              ' · "homa x3" picks a whole group · Enter when done')
        line = ask("Pick").strip().lower()
        if not line:
            core.save_budget(b)
            return
        target, _, times = line.replace("×", "x").partition(" x")
        target, times = target.strip(), times.strip() or None
        try:
            if target.isdigit():
                r = rituals[int(target) - 1]
                if r["id"] in chosen and times is None:
                    core.remove_ritual(b, r["id"])
                elif r["id"] in chosen:
                    core.set_times(b, r["id"], times)
                else:
                    core.add_ritual(b, r["id"], times or 1, lib=lib)
            else:
                core.add_group(b, target, times or 1, lib=lib)
            core.save_budget(b)
        except (BudgetError, IndexError) as exc:
            print(f"\n  {exc}")


def guided() -> int:
    lib = core.load_library()
    b = pick_budget(lib)
    while True:
        print_budget(b, lib, detail=False)
        print("\n  1. pick rituals and how many times   2. fill in what is missing"
              "\n  3. show every line   4. write to Google Sheet   5. quit")
        choice = ask("Choose", "2" if b["rituals"] else "1")
        try:
            if choice == "1":
                pick_rituals(b, lib)
            elif choice == "2":
                fill(b, lib)
            elif choice == "3":
                print_budget(b, lib)
                continue
            elif choice == "4":
                link = ""
                if not b.get("spreadsheet"):
                    link = ask("Existing spreadsheet link (Enter to create a new one in the budget folder)")
                info = core.write(b, spreadsheet=link or None, lib=lib)
                print(f"\nWritten: {info['url']}")
                continue
            else:
                return 0
            core.save_budget(b)
        except (BudgetError, IndexError) as exc:
            print(f"\n  {exc}")


# ---------------------------------------------------------------- commands


def main(argv: list[str] | None = None) -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        return guided()

    p = argparse.ArgumentParser(prog="festival-budget", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("library", help="list the rituals and items in the library")
    s.add_argument("--section", choices=list(core.SECTIONS))
    s = sub.add_parser("lib-item", help="add or change an item in the library")
    s.add_argument("name")
    s.add_argument("--unit", required=True)
    s.add_argument("--section", choices=list(core.SECTIONS), default="ritual")
    s.add_argument("--vendor", default="")
    s.add_argument("--pack-unit", default="", help="what it is bought in, e.g. Pkt")
    s.add_argument("--pack-size", help="how many of --unit are in one pack, e.g. 54")
    s = sub.add_parser("lib-ritual", help="add or change a ritual in the library")
    s.add_argument("name")
    s.add_argument("--kind", choices=["constant", "variable"], default="variable")
    s.add_argument("--group", default="")
    s.add_argument("--item", action="append", default=[], metavar="ITEM=QTY",
                   help="per-performance quantity; repeat. For a variable ritual this is only the reference")

    s = sub.add_parser("new", help="start an empty budget; then add rituals with their number of times")
    s.add_argument("name")
    s.add_argument("--constants", action="store_true", help="add every standard ritual once to start with")
    sub.add_parser("list", help="list budgets")
    s = sub.add_parser("show", help="print a budget and what is still missing")
    s.add_argument("budget")
    s = sub.add_parser("add", help="add a ritual (or a group, e.g. Homa) to a budget")
    s.add_argument("budget")
    s.add_argument("ritual")
    s.add_argument("--times", default="1")
    s = sub.add_parser("remove", help="remove a ritual from a budget")
    s.add_argument("budget")
    s.add_argument("ritual")
    s = sub.add_parser("times", help="set how many times a ritual is performed")
    s.add_argument("budget")
    s.add_argument("ritual")
    s.add_argument("times")
    s = sub.add_parser("qty", help="per-performance quantity of an item in a ritual ('' clears)")
    s.add_argument("budget")
    s.add_argument("ritual")
    s.add_argument("item")
    s.add_argument("qty")
    s = sub.add_parser("reference", help="fill a ritual's empty quantities from the library")
    s.add_argument("budget")
    s.add_argument("ritual")
    s = sub.add_parser("other", help="quantity outside any ritual (Miscellaneous fruit, say); 0 removes")
    s.add_argument("budget")
    s.add_argument("item")
    s.add_argument("qty")
    s.add_argument("--note", default="")
    s = sub.add_parser("set", help="stock / rate / purchase override / note for an item")
    s.add_argument("budget")
    s.add_argument("item")
    s.add_argument("--stock")
    s.add_argument("--rate")
    s.add_argument("--override", help="purchase quantity set by hand; needs --reason")
    s.add_argument("--reason")
    s.add_argument("--note")
    s = sub.add_parser("fill", help="ask for every missing quantity, stock and rate")
    s.add_argument("budget")
    s = sub.add_parser("write", help="write the budget to its Google Sheet")
    s.add_argument("budget")
    s.add_argument("--sheet", help="existing spreadsheet link; default: the budget's own, or a new one")
    s = sub.add_parser("delete", help="delete a budget (the sheet is left alone)")
    s.add_argument("budget")
    sub.add_parser("info", help="show configuration problems")
    sub.add_parser("serve", help="start the web UI on this machine")

    a = p.parse_args(argv)
    try:
        return run(a)
    except BudgetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def run(a: argparse.Namespace) -> int:
    if a.command == "info":
        problems = config.problems()
        print("\n".join(problems) if problems else "no problems")
        return 1 if problems else 0
    if a.command == "serve":
        import uvicorn

        uvicorn.run("app.main:app", host="127.0.0.1", port=config.PORT, workers=1)
        return 0

    lib = core.load_library()
    if a.command == "library":
        print_library(lib, a.section)
        return 0
    if a.command == "lib-item":
        item = core.save_item(lib, name=a.name, unit=a.unit, section=a.section, vendor=a.vendor,
                              pack_unit=a.pack_unit, pack_size=a.pack_size)
        core.save_library(lib)
        print(f"saved item {item['id']}")
        return 0
    if a.command == "lib-ritual":
        qty = {}
        for pair in a.item:
            key, _, value = pair.partition("=")
            qty[core.find(core.items_by_id(lib), key, "item")["id"]] = value
        r = core.save_ritual(lib, name=a.name, kind=a.kind, group=a.group, items=qty)
        core.save_library(lib)
        print(f"saved ritual {r['id']} ({len(r['items'])} items)")
        return 0
    if a.command == "new":
        b = core.new_budget(a.name, constants=a.constants, lib=lib)
        print(f"created {b['id']}")
        print_budget(b, lib, detail=False)
        return 0
    if a.command == "list":
        for x in core.list_budgets():
            sheet = f"  {x['spreadsheet']['url']}" if x.get("spreadsheet") else ""
            print(f"{x['id']:<36} {x['name']}  ({x['rituals']} rituals, updated {x['updated'][:10]}){sheet}")
        return 0

    b = core.load_budget(a.budget)
    if a.command == "show":
        result = print_budget(b, lib)
        return 1 if result["problems"] else 0
    if a.command == "add":
        if a.ritual.lower() in {r.get("group", "").lower() for r in lib["rituals"]} - {""}:
            added = core.add_group(b, a.ritual, a.times, lib=lib)
            print("added " + ", ".join(r["name"] for r in added) if added else f"every {a.ritual} ritual is already in this budget")
        else:
            print(f"added {core.add_ritual(b, a.ritual, a.times, lib=lib)['name']}")
    elif a.command == "remove":
        core.remove_ritual(b, a.ritual)
    elif a.command == "times":
        core.set_times(b, a.ritual, a.times)
    elif a.command == "qty":
        core.set_qty(b, a.ritual, a.item, a.qty or None, lib=lib)
    elif a.command == "reference":
        print(f"filled {core.use_reference(b, a.ritual, lib=lib)} quantities")
    elif a.command == "other":
        core.set_other(b, a.item, a.qty, a.note, lib=lib)
    elif a.command == "set":
        fields = {k: getattr(a, k) for k in ("stock", "rate", "override", "note") if getattr(a, k) is not None}
        if a.reason is not None:
            fields["override_reason"] = a.reason
        if not fields:
            raise BudgetError("nothing to set: give --stock, --rate, --override/--reason or --note")
        core.set_line(b, a.item, lib=lib, **fields)
    elif a.command == "fill":
        fill(b, lib)
        print_budget(b, lib, detail=False)
    elif a.command == "write":
        info = core.write(b, spreadsheet=a.sheet, lib=lib)
        print(info["url"])
        return 0
    elif a.command == "delete":
        core.delete_budget(b["id"])
        print(f"deleted {b['id']}")
        return 0
    core.save_budget(b)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
