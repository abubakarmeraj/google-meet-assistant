@echo off
cd /d "%~dp0.."
node local-search/manage.mjs docker start
if errorlevel 1 pause
