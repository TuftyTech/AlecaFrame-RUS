@echo off
setlocal
title AlecaFrame-RU uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Uninstall.ps1"
pause
