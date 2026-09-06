@echo off
setlocal EnableExtensions EnableDelayedExpansion
title The TOEFL House - Stop
cd /d "%~dp0"

REM =============================================================================
REM The TOEFL House - STOP-TOEFL-HOUSE.bat
REM Clean shutdown: stops the Laravel server, stops PostgreSQL, and removes
REM the Tailscale Serve mapping so the application is no longer reachable on
REM the Tailnet while stopped. Nothing is deleted: the database and all data
REM remain on disk; START-TOEFL-HOUSE.bat brings everything back.
REM =============================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RT=%ROOT%\.runtime"
set "PG_BIN=%RT%\pgsql\bin"
set "PGDATA=%RT%\pgdata"
set "APP_PORT=8080"

echo.
echo  The TOEFL House - stopping...
echo.

echo [1/3] Stopping the web server on port %APP_PORT% ...
set "SRV_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%APP_PORT% " ^| findstr /I "LISTENING"') do if not defined SRV_PID set "SRV_PID=%%p"
if defined SRV_PID (
    taskkill /F /T /PID %SRV_PID% >nul 2>nul
    echo       - web server stopped, PID %SRV_PID%.
) else (
    echo       - no web server was running.
)

echo [2/3] Stopping PostgreSQL ...
if exist "%PG_BIN%\pg_ctl.exe" (
    "%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" status >nul 2>nul
    if not errorlevel 1 (
        "%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" -m fast stop
        if errorlevel 1 echo       - PostgreSQL did not stop cleanly; check .runtime\pg.log.
    ) else (
        echo       - PostgreSQL was not running.
    )
) else (
    echo       - no local PostgreSQL runtime found; nothing to stop.
)

echo [3/3] Removing the Tailscale Serve mapping ...
set "TAILSCALE_BIN="
where tailscale.exe >nul 2>nul && set "TAILSCALE_BIN=tailscale.exe"
if not defined TAILSCALE_BIN if exist "C:\Program Files (x86)\Tailscale\tailscale.exe" set "TAILSCALE_BIN=C:\Program Files (x86)\Tailscale\tailscale.exe"
if not defined TAILSCALE_BIN (
    echo       - Tailscale not found; nothing to remove.
    goto done
)
"%TAILSCALE_BIN%" status >nul 2>nul
    if errorlevel 1 (
        echo       - Tailscale is not signed in; nothing to remove.
    ) else (
        "%TAILSCALE_BIN%" serve --bg --delete=443 >nul 2>nul
        echo       - Tailscale Serve mapping removed; the application is now
        echo         reachable only on this computer.
    )
:done

echo.
echo  The TOEFL House is stopped. Your data is safe on disk.
echo  To start again, double-click START-TOEFL-HOUSE.bat.
echo.
pause
exit /b 0
