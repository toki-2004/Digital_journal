@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ============================================================
rem  Digital Journal - one-click launcher
rem  Double-click this file, or run "set PORT=8080" first to
rem  change the port (default 3000, same as server.js).
rem
rem  Behavior:
rem    1. If the server is already running -> just open browser.
rem    2. Otherwise open a VISIBLE server console window and
rem       open the browser once it is ready.
rem    Closing the server console window stops the backend.
rem    Or use stop.bat to stop it by PID (server.pid).
rem ============================================================

if not defined PORT set PORT=3000

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [SETUP] Installing dependencies, please wait...
  call npm install express socket.io
  if errorlevel 1 (
    echo [ERROR] Dependency install failed. Run manually: npm install express socket.io
    pause
    exit /b 1
  )
)

echo [CHECK] Is http://localhost:%PORT% already running...
curl -s -f -o nul http://localhost:%PORT%/api/health >nul 2>&1
if not errorlevel 1 goto OPEN

echo [START] Opening server console window (close it to stop the server)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Normal -PassThru; $p.Id | Set-Content -LiteralPath '%CD%\server.pid'"

echo [WAIT] Waiting for the server to become ready...
set /a TRIES=0
:WAIT
set /a TRIES+=1
curl -s -f -o nul http://localhost:%PORT%/api/health >nul 2>&1
if not errorlevel 1 goto OPEN
if %TRIES% GEQ 25 goto FAIL
ping -n 2 127.0.0.1 >nul
goto WAIT

:FAIL
echo.
echo [ERROR] Server did not become ready in 25 seconds.
echo         Please check the server console window for errors
echo         (e.g. the port %PORT% may already be in use by another program).
echo.
pause
exit /b 1

:OPEN
echo.
echo ============================================================
echo   Server is ready:  http://localhost:%PORT%
echo   Browser opened automatically.
echo   To stop: close the server console window, or run stop.bat
echo ============================================================
start "" http://localhost:%PORT%
ping -n 4 127.0.0.1 >nul
exit /b 0
