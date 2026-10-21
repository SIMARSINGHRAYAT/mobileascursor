@echo off
title Mobile as Cursor Desktop Companion
cd /d "%~dp0"
echo =======================================================
echo   Mobile as Cursor - Desktop Companion
echo =======================================================
echo.
"C:\Program Files\nodejs\node.exe" companion/dist/index.js
pause
