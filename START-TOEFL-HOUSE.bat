@echo off
setlocal EnableExtensions EnableDelayedExpansion
title The TOEFL House - One-Click Launcher
cd /d "%~dp0"

REM =============================================================================
REM The TOEFL House - START-TOEFL-HOUSE.bat
REM One-click local deployment for a Windows desktop (Windows 10/11, 64-bit).
REM
REM   Windows PC  ->  PostgreSQL  ->  Laravel  ->  localhost  ->  Tailscale Serve
REM   PRIVATE to the Tailnet only. Tailscale Funnel is never used.
REM
REM What this file does (every step fails loudly and says exactly what is
REM missing; nothing here fails silently):
REM   1.  Verifies prerequisites (Windows 10 1803+, built-in curl.exe)
REM   2.  Prepares runtimes into .runtime\ : PHP 8.2.27, Composer,
REM       PostgreSQL 18.3 - downloaded once from pinned official URLs and
REM       reused on every later run
REM   3.  Installs Composer dependencies (production, lock file authoritative)
REM   4.  Creates .env from the production template + generates APP_KEY
REM   5.  Initializes PostgreSQL (127.0.0.1 only, local trust auth) and
REM       creates the toefl_house database
REM   6.  Runs migrations from zero
REM   7.  FIRST RUN ONLY: creates the owner organization, the Owner role with
REM       the complete capability set, and the owner account - you are asked
REM       once for name, date of birth, username and password
REM   8.  Starts Laravel on http://127.0.0.1:8080
REM   9.  Verifies /health
REM   10. Installs Tailscale if missing, configures Tailscale SERVE and prints
REM       the private Tailnet address
REM
REM You never need PowerShell, Git, Composer, PHP or PostgreSQL commands.
REM Double-clicking this file is the entire operation.
REM =============================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RT=%ROOT%\.runtime"
set "PHP_DIR=%RT%\php"
set "PHP=%PHP_DIR%\php.exe"
set "COMPOSER_PHAR=%RT%\composer.phar"
set "PG_DIR=%RT%\pgsql"
set "PG_BIN=%PG_DIR%\bin"
set "PGDATA=%RT%\pgdata"
set "PG_LOG=%RT%\pg.log"
set "BACKUP_DIR=%ROOT%\backup"

set "PHP_VERSION=8.2.27"
set "PHP_ZIP_URL=https://windows.php.net/downloads/releases/php-8.2.27-Win32-vs16-x64.zip"
set "PG_VERSION_TAG=18.3-1"
set "PG_ZIP_URL=https://get.enterprisedb.com/postgresql/postgresql-18.3-1-windows-x64-binaries.zip"
set "COMPOSER_URL=https://getcomposer.org/Composer-stable.phar"
set "TAILSCALE_MSI_URL=https://download.tailscale.com/stable/tailscale-setup-latest.amd64.msi"

set "APP_PORT=8080"
set "PG_PORT=5432"
set "APP_URL_LOCAL=http://127.0.0.1:%APP_PORT%"

echo.
echo  =====================================================================
echo   The TOEFL House - one-click launcher
echo  =====================================================================
echo.

REM ---------------------------------------------------------------------------
REM Step 1 - prerequisites
REM ---------------------------------------------------------------------------
echo [1/10] Checking prerequisites...
where curl.exe >nul 2>nul
if errorlevel 1 call :fail "Built-in curl.exe not found. Windows 10 version 1803 or newer is required - update Windows and re-run this file."

REM ---------------------------------------------------------------------------
REM Step 2 - runtimes
REM ---------------------------------------------------------------------------
echo [2/10] Preparing runtimes into .runtime\ ...
if not exist "%RT%" mkdir "%RT%"
if not exist "%RT%\downloads" mkdir "%RT%\downloads"

if not exist "%PHP%" (
    echo       - PHP %PHP_VERSION% : downloading from the official PHP archive...
    curl.exe -fL --retry 3 -o "%RT%\downloads\php.zip" "%PHP_ZIP_URL%"
    if errorlevel 1 call :fail "PHP download failed. URL: %PHP_ZIP_URL% - check the internet connection and re-run. If it keeps failing, save the zip as .runtime\downloads\php.zip manually and re-run."
    tar -xf "%RT%\downloads\php.zip" -C "%RT%\downloads"
    if errorlevel 1 call :fail "Could not unpack the PHP archive. Re-run this file."
    move /y "%RT%\downloads\php-%PHP_VERSION%-Win32-vs16-x64" "%PHP_DIR%" >nul
    if errorlevel 1 call :fail "Could not place the PHP runtime. Re-run this file."
    call :write_php_ini
)
"%PHP%" -v >nul 2>nul
if errorlevel 1 call :fail "PHP is present but cannot start. Delete the folder .runtime\php and re-run this file."
"%PHP%" -m | findstr /i "pdo_pgsql" >nul 2>nul
if errorlevel 1 call :fail "PHP cannot load the pdo_pgsql extension. Delete the folder .runtime\php and re-run this file."

if not exist "%COMPOSER_PHAR%" (
    echo       - Composer : downloading...
    curl.exe -fL --retry 3 -o "%COMPOSER_PHAR%" "%COMPOSER_URL%"
    if errorlevel 1 call :fail "Composer download failed. URL: %COMPOSER_URL% - check the internet connection and re-run."
)
"%PHP%" "%COMPOSER_PHAR%" --version >nul 2>nul
if errorlevel 1 call :fail "Composer downloaded but cannot run. Delete .runtime\composer.phar and re-run this file."

if not exist "%PG_BIN%\initdb.exe" (
    echo       - PostgreSQL %PG_VERSION_TAG : downloading, about 300 MB, one time only...
    curl.exe -fL --retry 3 -o "%RT%\downloads\pgsql.zip" "%PG_ZIP_URL%"
    if errorlevel 1 call :fail "PostgreSQL download failed. URL: %PG_ZIP_URL% - check the internet connection and re-run. If it keeps failing, save the zip as .runtime\downloads\pgsql.zip manually and re-run."
    tar -xf "%RT%\downloads\pgsql.zip" -C "%RT%\downloads"
    if errorlevel 1 call :fail "Could not unpack the PostgreSQL archive. Re-run this file."
    move /y "%RT%\downloads\pgsql" "%PG_DIR%" >nul
    if errorlevel 1 call :fail "Could not place the PostgreSQL runtime. Re-run this file."
)
"%PG_BIN%\initdb.exe" --version >nul 2>nul
if errorlevel 1 call :fail "PostgreSQL is present but cannot start. Delete the folder .runtime\pgsql and re-run this file."
echo       - runtimes ready.

REM ---------------------------------------------------------------------------
REM Step 3 - Composer dependencies
REM ---------------------------------------------------------------------------
echo [3/10] Installing Composer dependencies, production mode...
if not exist "%ROOT%\vendor" (
    "%PHP%" "%COMPOSER_PHAR%" install --no-dev --no-interaction --prefer-dist --no-progress --optimize-autoloader
    if errorlevel 1 call :fail "Composer install failed. The internet connection must reach packagist.org. Re-run this file."
)
echo       - dependencies ready.

REM ---------------------------------------------------------------------------
REM Step 4 - .env + APP_KEY
REM ---------------------------------------------------------------------------
echo [4/10] Preparing .env from the production template...
if not exist "%ROOT%\.env" (
    if not exist "%ROOT%\.env.example" call :fail "The template file .env.example is missing from this clone. Re-clone the repository."
    copy /y "%ROOT%\.env.example" "%ROOT%\.env" >nul
    call :set_env DB_USERNAME postgres
    call :set_env DB_HOST 127.0.0.1
    call :set_env DB_PORT 5432
    call :set_env DB_DATABASE toefl_house
    call :set_env DB_PASSWORD ""
    call :set_env DB_SSLMODE disable
    call :set_env APP_URL %APP_URL_LOCAL%
    REM Localhost access on this PC is plain HTTP; the Tailnet side is HTTPS
    REM through Tailscale Serve. A secure-only cookie would break the local
    REM console, so the desktop deployment uses an http-only, same-site cookie.
    call :set_env SESSION_SECURE_COOKIE false
    echo       - .env created from .env.example with desktop overrides.
)
findstr /R /C:"^APP_KEY=base64:" "%ROOT%\.env" >nul 2>nul
if errorlevel 1 (
    echo       - generating APP_KEY...
    "%PHP%" artisan key:generate
    if errorlevel 1 call :fail "APP_KEY generation failed. Re-run this file."
)

REM ---------------------------------------------------------------------------
REM Step 5 - PostgreSQL initialize + start
REM ---------------------------------------------------------------------------
echo [5/10] Initializing and starting PostgreSQL, local only on 127.0.0.1...
if not exist "%PGDATA%\PG_VERSION" (
    echo       - first run: initializing the database cluster...
    "%PG_BIN%\initdb.exe" -U postgres -A trust --encoding=UTF8 --no-locale -D "%PGDATA%"
    if errorlevel 1 call :fail "PostgreSQL cluster initialization failed. If a previous run was interrupted, the cluster folder is incomplete: delete the whole folder .runtime\pgdata and re-run this file. Otherwise check .runtime\pg.log, and if another program owns port %PG_PORT%, close it and re-run."
)
"%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" status >nul 2>nul
if errorlevel 1 (
    echo       - starting PostgreSQL...
    "%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" -o "-p %PG_PORT% -h 127.0.0.1 -c log_timezone=UTC" -l "%PG_LOG%" start
    if errorlevel 1 call :fail "PostgreSQL could not start. Details in .runtime\pg.log. If another program owns port %PG_PORT%, close it and re-run."
)
echo       - PostgreSQL ready.

REM ---------------------------------------------------------------------------
REM Step 6 - database + migrations
REM ---------------------------------------------------------------------------
echo [6/10] Creating the toefl_house database and running migrations...
set "DB_EXISTS="
for /f "tokens=1" %%c in ('"%PG_BIN%\psql.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='toefl_house'" 2^>nul') do set "DB_EXISTS=%%c"
if not defined DB_EXISTS (
    "%PG_BIN%\createdb.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres toefl_house
    if errorlevel 1 call :fail "Could not create the toefl_house database. Re-run this file."
)
"%PHP%" artisan migrate --force
if errorlevel 1 goto migrate_recovered
goto migrate_ok
:migrate_recovered
REM A migrate that is killed mid-run can leave a partially applied schema:
REM the database record of the migration is written after its changes
REM commit, so a re-run can fail with "table already exists". The only
REM provably safe automatic recovery is a fresh deployment with no data:
REM user_accounts is the root of every record in this system, so zero
REM accounts (or a missing table) means nothing of value can exist.
set "HAS_TABLE=f"
for /f "tokens=1" %%c in ('"%PG_BIN%\psql.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres -d toefl_house -tAc "SELECT to_regclass('public.user_accounts') IS NOT NULL" 2^>nul') do set "HAS_TABLE=%%c"
set "ACCTS2=-1"
if "%HAS_TABLE%"=="t" for /f "tokens=1" %%c in ('"%PG_BIN%\psql.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres -d toefl_house -tAc "SELECT count(*) FROM user_accounts" 2^>nul') do set "ACCTS2=%%c"
if "%HAS_TABLE%"=="t" if not "%ACCTS2%"=="0" call :fail "Migrations failed and this deployment already has accounts and data. Run RESTORE-TOEFL-HOUSE.bat with your latest backup, then re-run this file. If no backup exists, contact the TOEFL House maintainer - do not delete the database."
echo       - a previous interrupted run left a partial schema; this is a fresh deployment with no data, rebuilding the database from scratch...
"%PG_BIN%\dropdb.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres --if-exists toefl_house
if errorlevel 1 call :fail "Could not drop the partially migrated database. Re-run this file."
"%PG_BIN%\createdb.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres toefl_house
if errorlevel 1 call :fail "Could not recreate the database. Re-run this file."
"%PHP%" artisan migrate --force
if errorlevel 1 call :fail "Migrations failed twice. The last log lines are in storage\logs\laravel.log."
echo       - migrations complete after rebuild.
goto migrate_done
:migrate_ok
echo       - migrations complete.
:migrate_done

REM ---------------------------------------------------------------------------
REM Step 7 - first-run bootstrap: owner account, only when none exists yet
REM ---------------------------------------------------------------------------
echo [7/10] Checking whether the first owner account needs to be created...
set "ACCTS=-1"
for /f "tokens=1" %%c in ('"%PG_BIN%\psql.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres -d toefl_house -tAc "SELECT count(*) FROM user_accounts" 2^>nul') do set "ACCTS=%%c"
if "%ACCTS%"=="-1" call :fail "Could not read the account count from the database. Re-run this file."
if "%ACCTS%"=="0" (
    echo.
    echo   FIRST RUN - create the owner account, the person who signs in first.
    echo   This is the only time you will ever be asked for anything; every
    echo   further account is created inside the application.
    echo.
    set /p "OWN_NAME=  Full name of the owner: "
    set /p "OWN_DOB=  Date of birth, format YYYY-MM-DD: "
    set /p "OWN_USER=  Login username: "
    set /p "OWN_PW1=  Choose a password, at least 12 characters: "
    set /p "OWN_PW2=  Repeat the password: "
    if "%OWN_NAME%"=="" call :fail "The owner name is required. Re-run this file."
    echo %OWN_DOB% | findstr /R "^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$">nul
    if errorlevel 1 call :fail "The date of birth must be YYYY-MM-DD, for example 1985-04-12. Re-run this file."
    if "%OWN_USER%"=="" call :fail "The username is required. Re-run this file."
    if "%OWN_PW1%"=="" call :fail "The password is required. Re-run this file."
    if not "%OWN_PW1%"=="%OWN_PW2%" call :fail "The two passwords do not match. Re-run this file."
    call :pwlen "%OWN_PW1%"
    if !PWLEN! lss 12 call :fail "The password must be at least 12 characters. Re-run this file."
    set "BOOTSTRAP_OWNER_NAME=%OWN_NAME%"
    set "BOOTSTRAP_OWNER_BIRTHDATE=%OWN_DOB%"
    set "BOOTSTRAP_OWNER_USERNAME=%OWN_USER%"
    set "BOOTSTRAP_OWNER_PASSWORD=%OWN_PW1%"
    "%PHP%" artisan db:seed --class=FirstRunBootstrapSeeder --force
    if errorlevel 1 call :fail "The first-run bootstrap failed. Re-run this file and re-enter the owner details."
    set "BOOTSTRAP_OWNER_PASSWORD="
    echo.
    echo       - owner account %OWN_USER% created.
) else (
    echo       - account already exists, nothing to bootstrap.
)

REM ---------------------------------------------------------------------------
REM Step 8 - start Laravel
REM ---------------------------------------------------------------------------
echo [8/10] Starting The TOEFL House on port %APP_PORT%...
call :port_in_use %APP_PORT%
if not errorlevel 1 (
    echo       - port %APP_PORT% already has a listener: the application appears to be running already.
    goto check_health
)
start "TOEFL-House-Server" /min "%PHP%" artisan serve --host=127.0.0.1 --port=%APP_PORT%
if errorlevel 1 call :fail "Could not start the Laravel server process. Re-run this file."
echo       - server starting in a minimized window titled TOEFL-House-Server...
goto check_health

:check_health
REM ---------------------------------------------------------------------------
REM Step 9 - health check
REM ---------------------------------------------------------------------------
echo [9/10] Verifying /health ...
set /a HEALTH_TRIES=0
:health_loop
set /a HEALTH_TRIES+=1
set "CODE=000"
for /f "tokens=*" %%c in ('curl.exe -s -o nul -w "%%{http_code}" --max-time 5 "%APP_URL_LOCAL%/health" 2^>nul') do set "CODE=%%c"
if "%CODE%"=="200" goto healthy
if %HEALTH_TRIES% lss 30 (
    timeout /t 2 /nobreak >nul
    goto health_loop
)
call :fail "The application was not healthy on %APP_URL_LOCAL% within 60 seconds. Check the minimized window titled TOEFL-House-Server and storage\logs\laravel.log."
:healthy
echo       - /health OK.

REM ---------------------------------------------------------------------------
REM Step 10 - Tailscale Serve, private to the Tailnet, never Funnel
REM ---------------------------------------------------------------------------
echo [10/10] Configuring private Tailscale access...
set "TAILSCALE_BIN="
where tailscale.exe >nul 2>nul && set "TAILSCALE_BIN=tailscale.exe"
if not defined TAILSCALE_BIN (
    echo       - Tailscale not found: installing the official client. A Windows
    echo         User Account Control prompt may appear - click Yes.
    curl.exe -fL --retry 3 -o "%RT%\downloads\tailscale-setup.msi" "%TAILSCALE_MSI_URL%"
    if errorlevel 1 call :fail "Tailscale download failed. URL: %TAILSCALE_MSI_URL% - you can also install Tailscale from https://tailscale.com/download/windows and re-run this file."
    start /wait "" msiexec /i "%RT%\downloads\tailscale-setup.msi" /qn /norestart
    if errorlevel 1 call :fail "The Tailscale installation failed. Install Tailscale from https://tailscale.com/download/windows and re-run this file."
    where tailscale.exe >nul 2>nul && set "TAILSCALE_BIN=tailscale.exe"
    if not defined TAILSCALE_BIN if exist "C:\Program Files (x86)\Tailscale\tailscale.exe" set "TAILSCALE_BIN=C:\Program Files (x86)\Tailscale\tailscale.exe"
    if not defined TAILSCALE_BIN if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TAILSCALE_BIN=%ProgramFiles%\Tailscale\tailscale.exe"
    if not defined TAILSCALE_BIN call :fail "Tailscale was installed but could not be located. Restart the computer, then re-run this file."
)
"%TAILSCALE_BIN%" status >nul 2>nul
if errorlevel 1 (
    echo.
    echo   ONE MANUAL STEP REMAINS - the only one ever needed:
    echo.
    echo     1. Tailscale is installed but not signed in on this machine yet.
    echo     2. Open https://login.tailscale.com in your browser.
    echo     3. Sign in with your TOEFL House Tailscale account. This machine
    echo        will ask for approval on your phone or another signed-in
    echo        device - approve it.
    echo     4. Double-click START-TOEFL-HOUSE.bat again. The application is
    echo        already running locally; that run finishes the Tailscale
    echo        configuration and prints the private address.
    echo.
    pause
    exit /b 0
)
"%TAILSCALE_BIN%" serve --bg %APP_PORT%
if not errorlevel 1 goto ts_serve_ok
echo       - Tailscale Serve could not be configured in the background, which
echo         usually means the one-time HTTPS setup for your tailnet has not
echo         been done yet. Opening a window that completes it:
echo         wait for the line "Available within your tailnet" (or follow
echo         the link shown there if one appears), then close that window
echo         and press any key here.
start "Tailscale Setup" cmd /k ""%TAILSCALE_BIN%" serve %APP_PORT%"
pause
"%TAILSCALE_BIN%" serve --bg %APP_PORT%
if errorlevel 1 call :fail "Tailscale Serve still could not be configured. Usually one of: the Tailscale client is not signed in (open the Tailscale tray app and sign in, then re-run this file), or the tailnet needs HTTPS certificates enabled (open https://login.tailscale.com/admin/dns, or ask the tailnet admin). The app itself is fully working at http://127.0.0.1:%APP_PORT% - only the tailnet address needs this fix."
:ts_serve_ok
echo.
echo  =====================================================================
echo   THE TOEFL HOUSE IS RUNNING
echo  =====================================================================
echo.
echo   On this computer:
echo        %APP_URL_LOCAL%
echo.
set "TAIL_URL="
for /f "tokens=*" %%a in ('"%TAILSCALE_BIN%" serve status 2^>nul ^| findstr /C:"https://"') do if not defined TAIL_URL set "TAIL_URL=%%a"
if defined TAIL_URL (
    echo   From other TOEFL House devices on your Tailnet:
    echo        %TAIL_URL%
) else (
    echo   From other TOEFL House devices on your Tailnet, open the address
    echo   shown in the Tailscale Serve status below.
)
echo.
echo   Access is PRIVATE to the Tailnet. Tailscale Funnel is NOT used and
echo   nothing is exposed to the public internet.
echo.
echo   Other files in this folder:
echo     STOP-TOEFL-HOUSE.bat    stop the application and the database
echo     BACKUP-TOEFL-HOUSE.bat  save a database backup into backup\
echo     RESTORE-TOEFL-HOUSE.bat restore a backup, asks for confirmation
echo.
pause
exit /b 0

REM ===========================================================================
REM Subroutines
REM ===========================================================================
:fail
echo.
echo  =====================================================================
echo   STOPPED - the launcher could not continue.
echo  =====================================================================
echo   %~1
echo.
pause
exit /b 1

:write_php_ini
REM A minimal, fully controlled php.ini for the desktop deployment. The stock
REM php.ini-production ships several required extensions commented out;
REM writing our own keeps the runtime deterministic.
> "%PHP_DIR%\php.ini" echo [PHP]
>>"%PHP_DIR%\php.ini" echo extension_dir = "ext"
>>"%PHP_DIR%\php.ini" echo date.timezone = UTC
>>"%PHP_DIR%\php.ini" echo display_errors = Off
>>"%PHP_DIR%\php.ini" echo log_errors = On
>>"%PHP_DIR%\php.ini" echo error_reporting = E_ALL
>>"%PHP_DIR%\php.ini" echo memory_limit = 256M
>>"%PHP_DIR%\php.ini" echo upload_max_filesize = 32M
>>"%PHP_DIR%\php.ini" echo post_max_size = 33M
>>"%PHP_DIR%\php.ini" echo max_execution_time = 120
>>"%PHP_DIR%\php.ini" echo extension=openssl
>>"%PHP_DIR%\php.ini" echo extension=mbstring
>>"%PHP_DIR%\php.ini" echo extension=pdo_pgsql
>>"%PHP_DIR%\php.ini" echo extension=pgsql
>>"%PHP_DIR%\php.ini" echo extension=fileinfo
>>"%PHP_DIR%\php.ini" echo extension=dom
>>"%PHP_DIR%\php.ini" echo extension=xml
>>"%PHP_DIR%\php.ini" echo extension=simplexml
>>"%PHP_DIR%\php.ini" echo extension=xmlreader
>>"%PHP_DIR%\php.ini" echo extension=xmlwriter
>>"%PHP_DIR%\php.ini" echo extension=zip
exit /b 0

:set_env
REM Usage: call :set_env KEY value   (replaces exactly one KEY= line in .env)
"%PHP%" -r "$k='%1';$v='%2';$f='%ROOT%\.env';$o='';foreach(file($f,FILE_IGNORE_NEW_LINES) as $l){if(preg_match('/^'.preg_quote($k,'/').'=/',$l)){$o.=$k.'='.$v.PHP_EOL;}else{$o.=$l.PHP_EOL;}}file_put_contents($f,$o);"
exit /b 0

:port_in_use
REM Errorlevel 0 when the given TCP port already has a listener.
netstat -ano | findstr /R /C:":%~1 " | findstr /I "LISTENING" >nul
goto :eof

:pwlen
REM Sets PWLEN to the length of %~1.
set "PWLEN=0"
set "PWREST=%~1"
:pwlen_loop
if "!PWREST!"=="" goto pwlen_done
set /a PWLEN+=1
set "PWREST=!PWREST:~1!"
goto pwlen_loop
:pwlen_done
exit /b 0
