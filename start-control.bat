@echo off
title dsh-peak-scheduler control panel
rem One-click ON/OFF switch for the automatic peak/off-peak mode.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found in PATH. Install Node >= 22.19.
  pause
  exit /b 1
)

echo Starting peak-scheduler control panel ...
echo   Open http://127.0.0.1:3280 in your browser.
echo   Press Ctrl+C to stop.
echo.
node control.mjs "%~dp0config.json"
if errorlevel 1 pause
