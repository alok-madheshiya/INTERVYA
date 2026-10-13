@echo off
rem  Debug launcher: same app, but the main-process log stays on screen.
rem  For everyday use double-click "Intervya.lnk" instead — that starts
rem  electron.exe directly, so Windows gives it no console window at all.
setlocal
title Intervya
cd /d "%~dp0"

rem  ELECTRON_RUN_AS_NODE is set system-wide on this machine, and with it set
rem  electron.exe boots as a plain Node runtime instead of a browser. main.cjs
rem  now detects that and re-launches itself, so this line is only a shortcut
rem  past the extra hop.
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=node_modules\electron\dist\electron.exe"

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found. Install it from https://nodejs.org, then run this again.
  goto :failed
)

if not exist "node_modules\" (
  echo [setup] node_modules is missing - installing. This is a one-time job.
  echo.
  rem HeadTTS's postinstall runs Linux's "mkdir -p -m 777", which fails on
  rem Windows and takes the whole install down with it.
  call npm install --ignore-scripts
  if errorlevel 1 goto :failed
  echo.
)

if not exist "%ELECTRON%" (
  echo [setup] Electron binary not found - downloading it...
  call node node_modules\electron\install.js
  if errorlevel 1 goto :failed
  echo.
)

if not exist "models\onnx-community\whisper-base.en\" (
  echo [warn] Local models not found.
  echo        TTS and speech-to-text will load over the internet - much slower.
  echo        Run "npm run fetch-models" once ^(about 541 MB, offline ever after^).
  echo.
)

echo [run] Starting Intervya...
echo       Leave this window open - the main process logs here.
echo.

rem %* forwards flags, so "run.bat --spike" opens the Phase 0 spike screen.
"%ELECTRON%" . %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [error] The app exited with code %CODE%. See the log above.
  goto :failed
)

exit /b 0

:failed
echo.
echo Press any key to close this window.
pause >nul
exit /b 1
