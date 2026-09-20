@echo off
REM Build a reel from this machine. Double-click, or run `reels` from a terminal.
REM Everything after the command name is passed through, so `reels --no-upload`
REM renders to a local file without touching Drive.

setlocal
cd /d "%~dp0"

REM DATA_DIR in .env is the container's /data; locally it belongs beside the code.
set "DATA_DIR=%~dp0data"

if not exist ".venv\Scripts\python.exe" (
  echo First run — creating the Python environment. This takes a few minutes.
  py -3 -m venv .venv || goto :nopython
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :nodeps
)

where ffmpeg >nul 2>&1 || (
  echo.
  echo ffmpeg is not on your PATH. Install it from https://www.gyan.dev/ffmpeg/builds/
  echo and reopen this window.
  goto :end
)

".venv\Scripts\python.exe" -m app.cli %*
goto :end

:nopython
echo Python 3.12+ is needed. Install it from https://www.python.org/downloads/
goto :end

:nodeps
echo Could not install the Python dependencies. Check your internet connection.

:end
echo.
pause
