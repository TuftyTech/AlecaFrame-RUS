@echo off
setlocal
title AlecaFrame-RUS
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Install.ps1" %*
set "code=%ERRORLEVEL%"
pause
exit /b %code%
