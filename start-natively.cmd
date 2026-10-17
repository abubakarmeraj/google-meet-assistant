@echo off
setlocal
cd /d "%~dp0"
call npm.cmd run start:personal
if errorlevel 1 pause
