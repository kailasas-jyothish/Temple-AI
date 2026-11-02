# {{title}}

{{description}}

Python 3.12, managed entirely with [uv](https://docs.astral.sh/uv/). Dokploy app
`{{appname}}`, UI at **http://157.180.15.165:{{port}}**, listed on the dashboard
(http://157.180.15.165:8482).

## Run it

```
cd services/{{id}}
copy .env.example .env
uv run python -m app.cli run --text "hello"     # the CLI  (or: {{id}}.cmd run --text hello)
uv run python -m app.cli serve                  # the web UI on http://localhost:{{port}}
uv run pytest                                   # tests
```

The CLI, the web UI and the HTTP API all call `app/core.py`, so they cannot
disagree. Change behaviour there.

## Layout

```
app/core.py      the actual work (pure, no HTTP, no argparse)
app/config.py    env parsing + problems() shown on /healthz and the dashboard card
app/main.py      FastAPI: /healthz (open), /api/* and the UI (basic auth when UI_PASSWORD is set)
app/cli.py       argparse front end over core.py
app/ui/          single-page UI, no build step
tests/           pytest
```

## Dependencies

`uv add <pkg>` / `uv remove <pkg>`, never `pip`. Commit `uv.lock`; the
Dockerfile installs with `uv sync --frozen`.

## Deploy

```
node scripts/dokploy.mjs setup --app {{id}}
```
