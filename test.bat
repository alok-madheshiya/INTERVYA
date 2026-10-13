@echo off
setlocal
title Intervya - tests
cd /d "%~dp0"

rem Tests are plain Node, but the same stray env var breaks anything that
rem shells out to electron, so it is cleared here too.
set "ELECTRON_RUN_AS_NODE="

call npm test
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (echo [ok] All tests pass.) else (echo [fail] Some tests failed - see above.)
echo Press any key to close this window.
pause >nul
exit /b %CODE%
