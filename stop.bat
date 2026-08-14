@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ============================================================
rem  Digital Journal - stop script
rem  Stops the backend started by start.bat (by PID in server.pid).
rem  Tip: closing the server console window also stops it.
rem ============================================================

if not exist server.pid goto NOPID

set /p SERVER_PID=<server.pid
echo Stopping server (PID %SERVER_PID%)...
taskkill /f /pid %SERVER_PID% >nul 2>&1
if errorlevel 1 (
  echo [WARN] Process %SERVER_PID% not found - it may already be stopped.
  echo        If a server console window is open, just close it.
) else (
  echo Server stopped.
)
del server.pid >nul 2>&1
goto DONE

:NOPID
echo server.pid not found - the server may not be running.
echo If a server console window is open, just close it.

:DONE
echo.
pause
