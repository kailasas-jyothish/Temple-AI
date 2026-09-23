# Panchaloha Murthy Calculator

Works out the manufacturing cost **per kg of a Panchaloha murthy** from its
weight, alloy composition, wax type and current material rates. Rates can be
typed in, or researched on the web by an AI model — which only ever *proposes*
a rate with its source. A person approves every rate, and a deterministic
engine does all the arithmetic.

```
FINAL RATE
₹346.50 / kg
```

## Run it

```bash
cd services/panchaloha
cp .env.example .env        # add at least one provider key for research (optional)
npm install
npm run start:local         # http://localhost:3100
```

Or `docker compose up --build panchaloha` from the repo root.

| Command | What it does |
|---|---|
| `npm test` | the automated tests (engine, research validation, providers, HTTP) |
| `npm run typecheck` | `tsc` over the JSDoc types in `src/` |
| `npm run check` | both |

## The calculation

Implemented step by step in `src/calculator.js` (`calculateMurthyCost`), so
every line of the breakdown can be audited:

```
Copper qty    = W × copper%          Gun metal qty = W × gun metal%
Zinc qty      = W × zinc%            Wax qty       = W × 10%
Line cost     = qty × rate/kg        (each rounded to the paisa)
Raw material  = copper + gun metal + zinc + selected wax
Overhead      = raw material × 5%    (raw material only — never labour)
Material rate = raw material + overhead
Labour        = material rate
Final total   = material rate + labour
FINAL RATE    = final total ÷ W
```

Money is exact decimal arithmetic on BigInt (`src/decimal.js`), not
floating point. Each money line is rounded half-up to the currency's minor unit
as it is produced and everything after is an exact sum of those lines, so the
breakdown on screen adds up to the paisa. It never calculates with a missing or
invalid value: `validateInput()` lists what is wrong and the page shows that
list instead of a number.

Worked example (the test in `test/calculator.test.js`): 10 kg, 80:15:5,
beeswax, rates 100/200/300/400 → raw ₹1,650 → overhead ₹82.50 → material
₹1,732.50 → labour ₹1,732.50 → total ₹3,465 → **₹346.50/kg**.

The browser imports the same `src/calculator.js` (served at `/lib/`), so the
result updates as you type and is identical to `POST /api/calculate`.

## Compositions and wax

| Id | Copper | Gun metal | Zinc |
|---|---|---|---|
| `80:15:5` (default) | 80% | 15% | 5% |
| `70:25:5` | 70% | 25% | 5% |

Wax is **Beeswax (Thaenukku)** or **Paraffin Wax**, each with its own rate.
Only the selected one is priced; the other stays on screen as a reference.

## Rate research

"Get latest rates" asks the chosen provider to search the web for copper, gun
metal and zinc **scrap** rates and for beeswax and paraffin wax supplier prices
in the selected market (India / INR by default). The results appear in a review
panel. **Nothing changes in your rates until you press "Use this rate"** (or
"Use all verified", which asks before replacing any rate you typed).

A researched rate is shown as usable only if the server confirms all of:

- a positive rate in a recognised unit — the model reports the unit as the
  source quotes it (kg, quintal, tonne, g, lb) and the **server** converts to
  per-kg;
- the market's currency (no silent currency conversion);
- an honest rate type — a metal must be a scrap rate, never a futures, LME/MCX,
  refined or retail price; a wax must be wholesale, supplier or retail;
- a source URL that was **among the pages the provider's search tool actually
  returned**. A URL the search never produced is rejected as possibly invented;
  the same site but a different page is accepted with confidence capped at
  medium.

It also warns when the verified figures are implausible together (gun metal
dearer than copper, paraffin dearer than beeswax). A verified source proves the
page exists, not that the right row was read — on 2026-09-23 two Indian
"copper scrap" pages differed by more than 2× for the same day.

| Provider | How it searches | Default model | Keys |
|---|---|---|---|
| Groq | `browser_search` tool on gpt-oss (or `groq/compound`) | `openai/gpt-oss-120b` | `GROQ_API_KEYS` |
| Google Gemini | Google Search grounding | `gemini-3.5-flash` | `GEMINI_API_KEYS` |
| OpenAI | Responses API `web_search` tool | `gpt-5` | `OPENAI_API_KEYS` |
| Anthropic Claude | server-side `web_search` + `web_fetch` tools | `claude-opus-5` | `ANTHROPIC_API_KEYS` |

Keys live only in this service's `.env` (comma-separate several to rotate past
a rate-limited one) and are never sent to the browser. A provider without a
key is listed as unavailable. If a provider answers without searching, the
page says web research is unavailable for it rather than showing a guessed rate.

## Settings

The Settings dialog holds the AI provider, market (currency follows it),
default composition, overhead % and wax ratio %. They and the last rates you
used are saved in the browser's localStorage, per market. API keys are not.

Set `UI_PASSWORD` in `.env` before exposing the app beyond your own machine:
`/api/research` spends paid API credit.

## API

| Route | |
|---|---|
| `GET /api/config` | catalog, defaults, providers (`configured` flag, never keys) |
| `POST /api/calculate` | `CalculatorInput` → `CalculatorResult`, or 422 with `fields` |
| `POST /api/research` | `{ provider, market }` → reviewed-rate list, or `{ error: { code, message } }` |
| `GET /healthz` | liveness |

## Extending it

- **Another composition** — add an entry to `COMPOSITIONS` in `src/catalog.js`.
  Percentages must add to 100 (a test enforces it).
- **Another wax** — add it to `WAX_TYPES` and a matching entry to `MATERIALS`
  (with a new `rateKey`), then add that key to `RATE_KEYS` in `public/app.js`
  and to the `RateKey` typedef.
- **Another market** — add it to `MARKETS`; rates are stored per market.
- **Another LLM provider** — write `src/research/providers/<name>.js` exporting
  a factory that returns `{ id, label, model, configured, search }`, where
  `search` returns the answer text **and the URLs its search tool returned**
  (`base.js` has key rotation, HTTP error mapping and a URL collector). Add the
  factory to `FACTORIES` in `src/research/index.js`. A provider that cannot
  report its search results cannot pass validation, by design.
