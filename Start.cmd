@echo off
setlocal
title AlecaFrame-RU
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Start.ps1"
set "code=%ERRORLEVEL%"
if not "%code%"=="0" pause
exit /b %code%
