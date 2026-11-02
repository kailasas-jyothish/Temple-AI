@echo off
rem Double-click for the menu, or: scriptures extract iisha
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev --no-audit --no-fund
if exist .env (node --env-file=.env src/cli.js %*) else (node src/cli.js %*)
if "%~1"=="" pause
