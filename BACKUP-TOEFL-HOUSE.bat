@echo off
setlocal EnableExtensions EnableDelayedExpansion
title The TOEFL House - Backup
cd /d "%~dp0"

REM =============================================================================
REM The TOEFL House - BACKUP-TOEFL-HOUSE.bat
REM Database backup for the Windows desktop deployment.
REM
REM Uses the same protocol as the production tool deploy/backup.sh:
REM   * PostgreSQL custom format, compressed, --no-owner --no-privileges
REM   * files named toefl_house-<timestamp>.dump in backup\
REM   * every dump is verified with pg_restore --list before it is accepted
REM   * retention keeps the 14 most recent dumps
REM
REM The custom-format .dump files are interchangeable with the production
REM bash tooling (pg_restore on any platform).
REM
REM Run this after anything important, and at least once a day.
REM =============================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RT=%ROOT%\.runtime"
set "PG_BIN=%RT%\pgsql\bin"
set "PGDATA=%RT%\pgdata"
set "BACKUP_DIR=%ROOT%\backup"
set "PG_PORT=5432"

echo.
echo  The TOEFL House - database backup
echo.

if not exist "%PG_BIN%\pg_dump.exe" call :fail "The local PostgreSQL runtime is missing. Run START-TOEFL-HOUSE.bat first, then run this file."

echo [1/4] Making sure PostgreSQL is running...
"%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" status >nul 2>nul
if errorlevel 1 (
    "%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" -o "-p %PG_PORT% -h 127.0.0.1" -l "%RT%\pg.log" start
    if errorlevel 1 call :fail "PostgreSQL could not start. Details in .runtime\pg.log."
)
echo       - PostgreSQL running.

echo [2/4] Taking the backup...
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
set "TS="
for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddTHHmmss" 2^>nul') do set "TS=%%t"
if not defined TS set "TS=local"
set "DUMP=%BACKUP_DIR%\toefl_house-%TS%.dump"
"%PG_BIN%\pg_dump.exe" --host=127.0.0.1 --port=%PG_PORT% --username=postgres --format=custom --compress=6 --no-owner --no-privileges --file="%DUMP%" toefl_house
if errorlevel 1 call :fail "pg_dump failed. The database connection is 127.0.0.1:%PG_PORT% as user postgres. Check that PostgreSQL is running, then re-run."
echo       - dump written: backup\toefl_house-%TS%.dump

echo [3/4] Verifying the dump is readable...
"%PG_BIN%\pg_restore.exe" --list "%DUMP%" >nul 2>nul
if errorlevel 1 call :fail "The dump failed its integrity check and was NOT accepted. Delete %DUMP% and re-run this file."
echo       - dump verified.

echo [4/4] Applying retention, keep the 14 most recent...
set /a KEPT=0
for /f "delims=" %%f in ('dir /b /o-w "%BACKUP_DIR%\toefl_house-*.dump" 2^>nul') do (
    set /a KEPT+=1
    if !KEPT! gtr 14 del "%%f"
)
echo       - %KEPT% dump(s) kept.

echo.
echo  Backup complete:  %DUMP%
echo.
pause
exit /b 0

:fail
echo.
echo  =====================================================================
echo   BACKUP FAILED
echo  =====================================================================
echo   %~1
echo.
pause
exit /b 1
