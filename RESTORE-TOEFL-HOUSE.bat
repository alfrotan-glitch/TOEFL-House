@echo off
setlocal EnableExtensions EnableDelayedExpansion
title The TOEFL House - Restore
cd /d "%~dp0"

REM =============================================================================
REM The TOEFL House - RESTORE-TOEFL-HOUSE.bat
REM Disaster recovery for the Windows desktop deployment.
REM
REM Uses the same protocol as the production tool deploy/restore.sh:
REM   * the dump is verified with pg_restore --list BEFORE anything changes
REM   * an explicit typed confirmation is required (this overwrites the
REM     live database)
REM   * clean create + restore: --clean --if-exists --create --no-owner
REM     --no-privileges
REM   * post-restore verification: table count and organization count
REM
REM Usage:
REM   double-click RESTORE-TOEFL-HOUSE.bat              restores the LATEST
REM                                                     backup in backup\
REM   the file to restore can also be passed as a first
REM   command-line argument if run from a folder window
REM
REM After restoring, re-run START-TOEFL-HOUSE.bat.
REM =============================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RT=%ROOT%\.runtime"
set "PG_BIN=%RT%\pgsql\bin"
set "PGDATA=%RT%\pgdata"
set "BACKUP_DIR=%ROOT%\backup"
set "PG_PORT=5432"
set "APP_PORT=8080"

echo.
echo  The TOEFL House - database restore
echo  WARNING: this OVERWRITES the live toefl_house database.
echo.

if not exist "%PG_BIN%\pg_restore.exe" call :fail "The local PostgreSQL runtime is missing. Run START-TOEFL-HOUSE.bat first, then run this file."

echo [1/5] Selecting the backup file...
set "DUMP=%~1"
if defined DUMP (
    if not exist "%DUMP%" call :fail "Backup file not found: %DUMP%"
) else (
    set "DUMP="
    for /f "delims=" %%f in ('dir /b /o-w "%BACKUP_DIR%\toefl_house-*.dump" 2^>nul') do set "DUMP=%%f"
    if not defined DUMP call :fail "No backup found in backup\. Run BACKUP-TOEFL-HOUSE.bat first."
)
echo       - restoring from: %DUMP%

echo [2/5] Verifying the dump is intact before changing anything...
"%PG_BIN%\pg_restore.exe" --list "%DUMP%" >nul 2>nul
if errorlevel 1 call :fail "The backup failed its integrity check; nothing was changed. Check the file and re-run."
echo       - dump verified.

echo [3/5] Confirmation required...
set /p "CONFIRM=  Type RESTORE to overwrite the live database: "
if /I not "%CONFIRM%"=="RESTORE" (
    echo.
    echo   Refused: no change was made.
    echo.
    pause
    exit /b 0
)

echo [4/5] Stopping the web server, then restoring...
set "SRV_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%APP_PORT% " ^| findstr /I "LISTENING"') do if not defined SRV_PID set "SRV_PID=%%p"
if defined SRV_PID (
    taskkill /F /T /PID %SRV_PID% >nul 2>nul
    echo       - web server stopped, PID %SRV_PID%.
)
"%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" status >nul 2>nul
if errorlevel 1 (
    "%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" -o "-p %PG_PORT% -h 127.0.0.1" -l "%RT%\pg.log" start
    if errorlevel 1 call :fail "PostgreSQL could not start. Details in .runtime\pg.log."
)
"%PG_BIN%\pg_restore.exe" --host=127.0.0.1 --port=%PG_PORT% --username=postgres --clean --if-exists --create --no-owner --no-privileges --dbname=toefl_house "%DUMP%"
if errorlevel 1 call :fail "pg_restore failed partway. The database may be in the restored state of the dump; re-run this file once the cause is clear."
echo       - restore complete.

echo [5/5] Verifying the restored database...
set "TABLES=?"
for /f "tokens=1" %%c in ('"%PG_BIN%\psql.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres -d toefl_house -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2^>nul') do set "TABLES=%%c"
set "ORGS=?"
for /f "tokens=1" %%c in ('"%PG_BIN%\psql.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres -d toefl_house -tAc "SELECT count(*) FROM organizations" 2^>nul') do set "ORGS=%%c"
echo       - tables in public schema: %TABLES%
echo       - organizations: %ORGS%

echo.
echo  Restore complete. Double-click START-TOEFL-HOUSE.bat to bring the
echo  application back up.
echo.
pause
exit /b 0

:fail
echo.
echo  =====================================================================
echo   RESTORE STOPPED
echo  =====================================================================
echo   %~1
echo.
pause
exit /b 1
