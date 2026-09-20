@echo off
REM "Is it stuck?" — run this in a second window while a reel is building.
REM Reads the job's own state off disk; it does not disturb the run.

setlocal
cd /d "%~dp0"
set "DATA_DIR=%~dp0data"

".venv\Scripts\python.exe" -m app.cli --status

echo.
pause
