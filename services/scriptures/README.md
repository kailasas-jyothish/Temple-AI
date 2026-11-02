# Scriptures

Turns the Upanishads on [sanskritdocuments.org](https://sanskritdocuments.org/doc_upanishhat/)
into **one CSV per text**, verse by verse:

1. **Extract.** It downloads the site's ITRANS source (`.itx`) and converts it to Devanagari
   with [sanscript.js](https://github.com/sanskrit/sanscript). It then checks every passage
   against the site's own Devanagari page.
2. **IAST.** IAST is always derived from our Devanagari, so the two columns cannot disagree.
3. **Translate.** An OpenRouter model translates each passage using the prompt in
   `prompts/sph-v1.md` (per SPH's teachings), with the preceding verses as context.

No model is set by default. Translation refuses to start until a model is named per run
or set as `TRANSLATION_MODEL`. Use `compare` to test models side by side first.

## Use it

Double-click `scriptures.cmd` for a menu, or:

```
scriptures catalog [word]            list the site's Upanishads (231)
scriptures extract iisha kena        -> data/out/iisha.csv, kena.csv
scriptures extract all               the whole catalog (polite: 1 request/s, cached forever)
scriptures list                      what is extracted / translated so far
scriptures models [word]             OpenRouter models with prices (USD per 1M tokens)
scriptures compare iisha --models a/x,b/y --limit 5   -> data/out/compare-iisha.csv
scriptures translate iisha --model a/x [--limit 10] [--force] [--prompt sph-v1]
```

Web UI: `npm start` (or the container) on port 3400, behind basic auth (`UI_PASSWORD`, any
username). `/healthz` is open and feeds the dashboard card.

## The CSV

UTF-8 with BOM, so Excel opens Devanagari correctly. One row per passage:

| column | meaning |
|---|---|
| `seq` | order in the text. Row 0 is the title and carries the source notice. |
| `ref` | verse reference as the site numbers it (`1`, `2.3.4`, `ch1 …`) |
| `kind` | `title`, `invocation`, `heading`, `verse`, `prose`, `colophon` |
| `section` | the enclosing chapter/khaṇḍa heading |
| `verse_no` | the number alone, when there is one |
| `devanagari` | with Vedic accents where the source has them; line breaks kept |
| `iast` | unaccented IAST |
| `translation`, `translation_notes` | from the model |
| `translation_model`, `translation_status` | which model; `pending` / `translated` / `failed` / `skipped` |
| `check` | `ok`, `mismatch: …` or `not found` against the site's Devanagari page |
| `notes` | anything else |

Re-running `translate` fills only `pending`/`failed` rows. Every answer is cached by
(model, prompt version, text), so a re-run or a crash never pays twice for a verse.
`MAX_COST_USD` stops a job once the spend passes that amount.

## Conventions worth knowing

- **ꣳ (Vedic anusvāra) → ṁ**, kept apart from ordinary anusvāra ṃ and candrabindu m̐.
- **Hiatus → diaeresis**: प्रउग is `praüga`, so it cannot be confused with प्रौग `prauga`.
- **ळ → ḻ**. Dandas stay as `|` / `||` in IAST.
- `{}` between letters in the site's ITRANS is a separator (`pra{}uga`), not noise.
- Accents are dropped from IAST, because sanscript's IAST accent marks are not a
  convention readers know.

## Corpus check

`node scripts/corpus.js [ids…]` extracts every text and reports the site check. On
2026-11-02 the result was **226 of 231 texts fully clean**. The rest are typos in the
source (`|a`, `|na`), site-side garbage or omissions, or a commentary text (`Ishaa_bhaashhya`).
Each one's `check` column says where.

## Licences and source

- `src/vendor/sanscript.cjs` is sanscript.js at commit `24e15105bc60d319f0eda360d92575946bb5c669`
  (MIT, `src/vendor/LICENSE-sanscript`), built with that repo's own `scripts/build.js`. The
  commit is pinned so that the IAST cannot change under us. Never edit the file. To update it,
  rebuild at a newer commit, replace the file, and run `npm run check` and the corpus check.
- The texts are sanskritdocuments.org's: "for personal study and research; not to be copied or
  reposted … for commercial purpose without permission." Row 0 of every CSV carries that notice.
  Fetched sources and outputs live in `data/` (gitignored). Never commit them.

## Config

See `.env.example`. Secrets go in `.env` (gitignored): `OPENROUTER_API_KEY`, `UI_PASSWORD`.
