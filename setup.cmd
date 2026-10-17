@echo off
setlocal
cd /d "%~dp0"
call npm.cmd run setup -- %*
if errorlevel 1 pause
