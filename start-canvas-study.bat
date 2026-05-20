@echo off
title Canvas Study Launcher
cd /d "%~dp0"

echo Canvas Study — starting services...

REM --- Proxy (port 3001) ---
powershell -NoProfile -Command "try { $r = Invoke-RestMethod 'http://127.0.0.1:3001/proxy-health' -TimeoutSec 2; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Starting proxy on http://127.0.0.1:3001 ...
  start "Canvas Proxy" cmd /k "cd /d "%~dp0" && python canvas-proxy.py"
  timeout /t 3 /nobreak >nul
) else (
  echo Proxy already running.
)

REM --- Web server (port 8080) — must serve THIS folder (canvas-app.html) ---
powershell -NoProfile -Command "try { $r = Invoke-WebRequest 'http://127.0.0.1:8080/canvas-app.html' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Stopping wrong servers on port 8080...
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
  timeout /t 1 /nobreak >nul
  echo Starting app server on http://127.0.0.1:8080 ...
  start "Canvas App" cmd /k "cd /d "%~dp0" && python -m http.server 8080 --bind 127.0.0.1"
  timeout /t 2 /nobreak >nul
) else (
  echo App server already running.
)

echo Opening Canvas Study in your browser...
start "" "http://127.0.0.1:8080/canvas-app.html"

echo.
echo Done. Keep the "Canvas Proxy" and "Canvas App" windows open while you study.
echo Close those windows when finished.
