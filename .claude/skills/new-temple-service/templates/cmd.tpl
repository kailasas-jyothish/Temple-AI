@echo off
REM Run {{id}} from this machine. Double-click, or run `{{id}}` from a terminal.
REM Everything after the command name is passed through: `{{id}} run --text hello`,
REM `{{id}} serve` for the web UI on http://localhost:{{port}}.
REM Needs uv (https://docs.astral.sh/uv/); it installs Python and the
REM dependencies itself on first run.

setlocal
cd /d "%~dp0"

REM DATA_DIR in .env is the container's /data; locally it belongs beside the code.
set "DATA_DIR=%~dp0data"

where uv >nul 2>&1 || (
  echo uv is not installed. Run:  powershell -c "irm https://astral.sh/uv/install.ps1 ^| iex"
  goto :end
)

uv run python -m app.cli %*

:end
