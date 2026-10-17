@echo off
cd /d "%~dp0.."
node local-search/manage.mjs wsl start
if errorlevel 1 pause
