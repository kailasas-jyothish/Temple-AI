# Festival Budget

Builds a festival's **Ritual Budget** and **Fruit Budget** from a reusable ritual
library, then writes them into a Google Sheet with a **Summary** tab that adds them up.
Flowers and Madappalli budgets are not built yet; the Summary lists them as "not
included yet" so the total never looks complete when it is not.

Python 3.12, managed entirely with [uv](https://docs.astral.sh/uv/). Dokploy app
`Temple-festival-budget`, UI at **http://157.180.15.165:8484**, listed on the dashboard
(http://157.180.15.165:8482).

## How a budget works

- **The library** (`DATA_DIR/library.json`, seeded from `app/seed/library.json`, which
  was taken from the *Chandi Homa Requirement* sheet) holds every item, with its
  unit, vendor and pack size ("PKT of 54", "Bundle of 60", "ton of 1000 kg"), and every
  ritual, with the quantity of each item for one performance.
- **Constant rituals** recur at every festival: Abhishekam, Deeparathana, Mandagappadi,
  Dhwajarohanam, the Homa group (Vighneshwara, Guru, Varuna, Pradhana Kalasha puja,
  Agnikaryam, Poornahuti), Vishesha Dravya Homa, Mangala Dravya Homa and Laghu Puja.
  A new budget starts **empty**: every ritual is a tile, and you tap the ones the
  festival has and set how many times each is performed (Deeparathana ×10). A constant
  brings its library quantities when it is picked.
- **Variable rituals** belong to one festival (Kanya Puja, Durga Puja, Navami Puja &
  Bali, …). Added to a budget, their quantities start **empty**. They are filled by hand,
  and the library figure is shown beside each one as a reference.
- **Times**: every ritual has a "number of times performed". The sheet shows the
  per-performance and the total column.
- **Others / Miscellaneous** are quantities outside any ritual, such as fruit for
  naivedyam.
- **Stock** is entered in the item's unit. Net required = total required − stock. The
  purchase quantity is then rounded up: to whole packs for a countable pack (a packet, a
  bundle, a box), to the gram for a pack sold by weight, and to whole units for a
  countable item.
- **Override**: the purchase quantity can be set by hand, for example "vendor sells 5 L
  tins". It needs a reason, and the reason is printed in the Notes column.
- **Rates are mandatory.** No rate is ever prefilled. Every item with something to buy
  needs the vendor's rate per purchase unit. Until each one is filled, the budget will not
  write. A budget with blank rates totals to a wrong number.

Amounts are Decimal and are rounded to the paisa once per line, so vendor subtotals and
totals add up exactly to the lines shown.

The web UI walks through four steps: ① tap the ritual tiles and set ×times, ② fill
the quantities, ③ enter stock and rates, ④ write. A bar at the top shows how much is
filled in, and how many quantities and rates are left, plus the running total. Each
step shows what is still missing. The guided CLI does the same with a numbered board:
`5` toggles ritual 5, `5 x10` sets it to ten times, `homa x3` adds the Homa group.

## Run it

```
cd services/festival-budget
copy .env.example .env          # then set GOOGLE_SERVICE_ACCOUNT_FILE and BUDGET_FOLDER_ID
festival-budget.cmd             # guided: pick or create a budget, add rituals, fill, write
uv run python -m app.cli serve  # the web UI on http://localhost:8484
uv run pytest                   # tests
```

CLI commands, for scripting (`festival-budget.cmd <command> --help` for each):

```
new "Navaratri 2026" [--constants]       list / show <budget> / delete <budget>
                                         (--constants pre-adds every standard ritual once)
add <budget> "Durga Puja" --times 9      add <budget> Homa          (a whole group)
remove <budget> <ritual>                 times <budget> <ritual> 3
qty <budget> <ritual> <item> 2.5         reference <budget> <ritual>   (fill empties from the library)
other <budget> <item> 24 --note naivedyam
set <budget> <item> --stock 2 --rate 640 --override 5 --reason "5 L tins" --note ...
fill <budget>                            (asks for every missing quantity, stock and rate)
write <budget> [--sheet <link>]
library / lib-item / lib-ritual          (view and extend the library)
```

The CLI, the web UI and the HTTP API all call `app/core.py`, so they cannot
disagree. Change behaviour there.

## Google Sheets access

The service account (`temple@teak-mix-489419-v1.iam.gserviceaccount.com`) has **no Drive
storage of its own**. Google answers 403 if it tries to create a spreadsheet in My Drive.
There are two ways to give it somewhere to write:

1. **A Shared Drive folder** (`BUDGET_FOLDER_ID`). Add the service account to the Shared
   Drive as a *Content manager*. Each budget then gets its own new spreadsheet there.
2. **An existing spreadsheet.** Share it with the service account as an *Editor* and paste
   its link into the write step (`--sheet`, or the field in the UI).

After the first write the budget remembers its spreadsheet, so later writes go into the
same file. Only the tool's own tabs (Summary, Ritual Budget, Fruit Budget) are cleared and
rewritten, and they keep their tab ids, so links to them keep working. Any other tab in the
file is left alone.

## Layout

```
app/core.py         library, budgets, calculation, validation (no HTTP, no argparse)
app/sheets.py       service-account session, spreadsheet creation, tab layout and formatting
app/config.py       env parsing + problems() shown on /healthz and the dashboard card
app/main.py         FastAPI: /healthz (open), /api/* and the UI (basic auth when UI_PASSWORD is set)
app/cli.py          argparse + guided front end over core.py
app/ui/index.html   single-page UI, no build step
app/seed/           the starting library
tests/              pytest, with a fake Sheets session
```

## Dependencies

`uv add <pkg>` / `uv remove <pkg>`, never `pip`. Commit `uv.lock`; the
Dockerfile installs with `uv sync --frozen`.

## Deploy

```
node scripts/dokploy.mjs setup --app festival-budget
```

On the host, set `GOOGLE_SERVICE_ACCOUNT_JSON_B64` (base64 of the key file) instead of the
file path, and a real `UI_PASSWORD`.
