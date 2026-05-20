@echo off
title Canvas Proxy
cd /d "%~dp0"
echo Starting Canvas proxy on http://127.0.0.1:3001 ...
echo Keep this window open while using canvas-app.html
echo.
python canvas-proxy.py
pause
