@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0bump-and-reinstall.ps1" %*
exit /b %ERRORLEVEL%
