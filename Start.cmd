@echo off
rem Start.cmd from older versions now does the same as Install.cmd: install once, then it runs by itself.
call "%~dp0Install.cmd" %*
