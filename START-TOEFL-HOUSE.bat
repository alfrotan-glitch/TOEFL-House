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
REM   2.  Prepares runtimes into .runtime\ : PHP 8.2.x (pinned at the version
REM       in PHP_VERSION, derived artifacts in one place), Composer,
REM       PostgreSQL 18.3 - downloaded once from official URLs and reused on
REM       every later run. The PHP download tries /releases/ first and falls
REM       back to /releases/archives/ (where older patches live permanently),
REM       so a patch bump upstream never breaks a fresh clone
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
REM   10. OPTIONAL: installs Tailscale if missing and configures Tailscale SERVE
REM       so the app is reachable from the other devices on your private Tailnet,
REM       then prints that private address. This is a convenience on top of the
REM       already-running local server, never a requirement: if the download, the
REM       install (UAC declined), the Tailscale sign-in or the serve setup cannot
REM       complete, the launcher still finishes and reports the local address - it
REM       does NOT fail the deployment the way steps 1-9 do.
REM
REM You never need PowerShell, Git, Composer, PHP or PostgreSQL commands.
REM Double-clicking this file is the entire operation.
REM =============================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RT=%ROOT%\.runtime"
set "PHP_DIR=%RT%\php"
set "PHP=%PHP_DIR%\php.exe"
set "LAUNCHER_HELPER=%ROOT%\deploy\windows\launcher_helper.php"
set "COMPOSER_PHAR=%RT%\composer.phar"
set "PG_DIR=%RT%\pgsql"
set "PG_BIN=%PG_DIR%\bin"
set "PGDATA=%RT%\pgdata"
set "PG_LOG=%RT%\pg.log"
set "SERVER_LOG=%RT%\server.log"
set "FRAMEWORK_ROUTER=%ROOT%\vendor\laravel\framework\src\Illuminate\Foundation\resources\server.php"
set "BACKUP_DIR=%ROOT%\backup"

REM Use the Windows BUILT-IN bsdtar by absolute path, not whatever "tar"
REM resolves to on PATH. Git-for-Windows / MSYS2 / Cygwin ship a GNU tar that
REM (a) treats a "C:\..." archive as a remote "host:file" ("Cannot connect to
REM C: resolve failed") and (b) cannot read .zip archives at all. The built-in
REM System32\tar.exe is bsdtar (libarchive): it reads .zip and treats drive
REM letters as local paths. It ships on Windows 10 1803+, the same baseline as
REM the built-in curl.exe.
set "TAR=%SystemRoot%\System32\tar.exe"

REM PHP 8.2.x is the pinned runtime (x64, thread-safe, VS16 build). The
REM archive name, its extracted folder and both download URLs are derived
REM from PHP_VERSION so the pin lives in exactly one place.
set "PHP_VERSION=8.2.27"
set "PHP_ZIP=php-%PHP_VERSION%-Win32-vs16-x64.zip"
REM Windows builds only keep the newest patch of each branch under /releases/;
REM older patches (including a pinned one once a newer 8.2.x ships) are moved
REM permanently under /releases/archives/. Try the current-release URL first
REM (fast while the patch is brand new) and transparently fall back to the
REM archive URL, which never 404s - so this keeps working after patch bumps.
set "PHP_ZIP_URL=https://windows.php.net/downloads/releases/%PHP_ZIP%"
set "PHP_ARCHIVE_ZIP_URL=https://windows.php.net/downloads/releases/archives/%PHP_ZIP%"
set "PG_VERSION_TAG=18.3-1"
set "PG_ZIP_URL=https://get.enterprisedb.com/postgresql/postgresql-18.3-1-windows-x64-binaries.zip"
REM Composer is fetched as the official, PERMANENT versioned PHAR (not the
REM composer-setup.php bootstrapper). The bootstrapper runs its own embedded
REM HTTP/TLS client with bundled signature keys, which crashed php.exe with a
REM native STATUS_ACCESS_VIOLATION (exit 0xC0000005 / -1073741819) on this
REM runtime even though every extension loaded fine. The versioned PHAR is a
REM fixed download URL, is the standard CI method, and is verified by running
REM `composer.phar --version`. Pinned to a stable release (min PHP 7.2.5).
set "COMPOSER_VERSION=2.10.3"
set "COMPOSER_PHAR_URL=https://getcomposer.org/download/%COMPOSER_VERSION%/composer.phar"
REM Tailscale Windows packages are MSIs that live ONLY on the official package
REM host pkgs.tailscale.com and are ALWAYS version-pinned: the file name is
REM tailscale-setup-<version>-amd64.msi. There is no rolling "latest" MSI (only
REM the separate .exe bundle has that), and the plain www-style download host
REM is not a name that resolves on Tailscale's package servers, so an unversioned
REM MSI URL could never download. We pin a stable version exactly like
REM PHP/Composer/PostgreSQL; the installed client keeps itself up to date.
set "TAILSCALE_VERSION=1.102.3"
set "TAILSCALE_MSI_URL=https://pkgs.tailscale.com/stable/tailscale-setup-%TAILSCALE_VERSION%-amd64.msi"

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
if not exist "%TAR%" call :fail "Built-in tar.exe (bsdtar) not found at %TAR%. Windows 10 version 1803 or newer is required - update Windows and re-run this file. Do not rely on a Git/MSYS2/Cygwin tar on PATH, which cannot unpack the PHP/PostgreSQL .zip archives."

REM ---------------------------------------------------------------------------
REM Step 2 - runtimes
REM ---------------------------------------------------------------------------
echo [2/10] Preparing runtimes into .runtime\ ...
if not exist "%RT%" mkdir "%RT%"
if not exist "%RT%\downloads" mkdir "%RT%\downloads"

call :prepare_php


call :prepare_composer


if not exist "%PG_BIN%\initdb.exe" (
    echo       - PostgreSQL %PG_VERSION_TAG : downloading, about 300 MB, one time only...
    call :fetch_file "%RT%\downloads\pgsql.zip" "%PG_ZIP_URL%" "" "52428800"
    if errorlevel 1 call :fail "PostgreSQL download failed or was truncated from %PG_ZIP_URL%. The incomplete file was discarded. Check the internet connection and re-run this file."
    REM Verify archive integrity before extracting.
    "%TAR%" -tf "%RT%\downloads\pgsql.zip" >nul 2>nul
    if errorlevel 1 call :fail "The downloaded PostgreSQL archive %RT%\downloads\pgsql.zip is corrupt or truncated (integrity test failed). Delete it and re-run this file."
    "%TAR%" -xf "%RT%\downloads\pgsql.zip" -C "%RT%\downloads"
    if errorlevel 1 call :fail "Could not unpack the PostgreSQL archive. Re-run this file."
    move /y "%RT%\downloads\pgsql" "%PG_DIR%" >nul
    if errorlevel 1 call :fail "Could not place the PostgreSQL runtime (expected %RT%\downloads\pgsql after extraction). Re-run this file."
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
if not exist "%ROOT%\.env" goto make_env
goto env_ready
:make_env
if not exist "%ROOT%\.env.example" call :fail "The template file .env.example is missing from this clone. Re-clone the repository."
if not exist "%LAUNCHER_HELPER%" call :fail "The launcher helper is missing at %LAUNCHER_HELPER%. Re-clone the repository."
copy /y "%ROOT%\.env.example" "%ROOT%\.env" >nul
REM Apply desktop overrides with a plain-PHP helper. The previous inline
REM `php -r "...()"` was called from inside a parenthesized block and cmd's
REM block parser mangled the parentheses (PHP reported "Unclosed '('"), so
REM the overrides were silently skipped. An external script avoids that.
"%PHP%" "%LAUNCHER_HELPER%" env-set "%ROOT%\.env" DB_USERNAME=postgres DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=toefl_house DB_PASSWORD= DB_SSLMODE=disable "APP_URL=%APP_URL_LOCAL%" SESSION_SECURE_COOKIE=false
if errorlevel 1 call :fail "Could not write the desktop .env overrides via the launcher helper. Re-run this file."
echo       - .env created from .env.example with desktop overrides.
:env_ready
findstr /R /C:"^APP_KEY=base64:" "%ROOT%\.env" >nul 2>nul
if errorlevel 1 (
    echo       - generating APP_KEY...
    "%PHP%" artisan key:generate
    if errorlevel 1 call :fail "APP_KEY generation failed. Re-run this file."
)

REM Resolve the HTTP port BEFORE writing the final .env URL / starting the server.
REM The preferred port may be taken by a leftover process or reserved by the OS
REM (Windows excludes dynamic ranges used by Hyper-V/WinNAT; such a port has NO
REM listener in netstat yet PHP fails to bind it). This picks a verifiably
REM bindable port and keeps .env / serve / health / Tailscale consistent.
call :resolve_app_port

REM ---------------------------------------------------------------------------
REM Step 5 - PostgreSQL initialize + start
REM ---------------------------------------------------------------------------
echo [5/10] Initializing and starting PostgreSQL, local only on 127.0.0.1...
call :prepare_pg
if errorlevel 1 call :fail "PostgreSQL could not be started. Details in .runtime\pg.log. If another program owns port %PG_PORT%, close it and re-run."

REM ---------------------------------------------------------------------------
REM Step 6 - database + migrations
REM ---------------------------------------------------------------------------
echo [6/10] Ensuring the toefl_house database and running migrations...
call :ensure_app_db
if errorlevel 1 call :fail "Could not ensure the toefl_house database. Read the message above."
"%PHP%" artisan migrate --force
if errorlevel 1 call :fail "Database migrations failed. PostgreSQL wraps migrations in a transaction, so no partial schema is committed; the existing database and all data are untouched. Fix the reported migration error and re-run this file - it resumes from where it stopped. See storage\logs\laravel.log."
echo       - migrations complete.
REM ---------------------------------------------------------------------------
REM Step 7 - first-run bootstrap: owner account, only when none exists yet
REM ---------------------------------------------------------------------------
echo [7/10] Checking whether the first owner account needs to be created...
REM account-count exit codes: 0 = zero accounts (first run), 1 = accounts exist,
REM anything else = error. Direct call (no for/f) so cmd never re-quotes it.
"%PHP%" "%LAUNCHER_HELPER%" account-count "%APP_DSN%" postgres "" toefl_house
set "ACCT_RC=!ERRORLEVEL!"
if !ACCT_RC! GEQ 2 call :fail "Could not read the account count from the database. Re-run this file."
if !ACCT_RC! EQU 0 (
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
REM Variables filled by `set /p` inside this parenthesized block exist only at
REM run time, so they MUST be read with delayed expansion (!VAR!); %VAR% is
REM expanded when the block is parsed and is always empty here.
    if "!OWN_NAME!"=="" call :fail "The owner name is required. Re-run this file."
    echo !OWN_DOB!| findstr /R "^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$">nul
    if errorlevel 1 call :fail "The date of birth must be YYYY-MM-DD, for example 1985-04-12. Re-run this file."
    if "!OWN_USER!"=="" call :fail "The username is required. Re-run this file."
    if "!OWN_PW1!"=="" call :fail "The password is required. Re-run this file."
    if not "!OWN_PW1!"=="!OWN_PW2!" call :fail "The two passwords do not match. Re-run this file."
    call :pwlen "!OWN_PW1!"
    if !PWLEN! lss 12 call :fail "The password must be at least 12 characters. Re-run this file."
    set "BOOTSTRAP_OWNER_NAME=!OWN_NAME!"
    set "BOOTSTRAP_OWNER_BIRTHDATE=!OWN_DOB!"
    set "BOOTSTRAP_OWNER_USERNAME=!OWN_USER!"
    set "BOOTSTRAP_OWNER_PASSWORD=!OWN_PW1!"
    "%PHP%" artisan db:seed --class=FirstRunBootstrapSeeder --force
    if errorlevel 1 call :fail "The first-run bootstrap failed. Re-run this file and re-enter the owner details."
    set "BOOTSTRAP_OWNER_PASSWORD="
    echo.
    echo       - owner account !OWN_USER! created.
) else (
    echo       - account already exists, nothing to bootstrap.
)

REM ---------------------------------------------------------------------------
REM Step 8 - start Laravel
REM ---------------------------------------------------------------------------
echo [8/10] Starting The TOEFL House on port %APP_PORT%...
if "%PORTCAND_HOW%"=="health" (
    echo       - the application is already running and answering /health on port %APP_PORT%; reusing it.
    goto check_health
)
REM Launch the server in a separate, minimized window. `start` returns immediately
REM and does NOT reset ERRORLEVEL when it spawns a process, so we do not gate on it
REM (a stale level from earlier checks once caused a false "server start" failure).
REM APP_PORT was already verified bindable by :resolve_app_port; readiness is
REM decided by the /health loop. The server window writes to SERVER_LOG so a real
REM bind/crash is diagnosable.
if not exist "%FRAMEWORK_ROUTER%" call :fail "The Laravel development-server router is missing at %FRAMEWORK_ROUTER%. Run Composer install and re-run this file."
REM Run the PHP built-in server DIRECTLY with the same framework router `artisan
REM serve` uses. We intentionally do NOT use `artisan serve`: on Windows it spawns
REM the child with PHP_CLI_SERVER_WORKERS set (multi-worker mode uses fork(), which
REM Windows lacks) and a filtered environment, so the child never binds and reports
REM "Failed to listen ... (reason: ?)" on every port even though raw PHP binds fine.
REM -d variables_order=EGPCS makes the desktop DB/SERVER env reach the script.
REM /D sets the child's working directory to public\ (exactly what `artisan serve`
REM does): the framework router requires getcwd()."/index.php", so the cwd MUST be
REM public\ for it to resolve the real front controller public\index.php. With the
REM cwd at the repo root the router requires <root>\index.php (which does not exist)
REM and /health returns HTTP 500. -t sets the static document root.
start "TOEFL-House-Server" /D "%ROOT%\public" /min cmd /c ""%PHP%" -d variables_order=EGPCS -S 127.0.0.1:%APP_PORT% -t "%ROOT%\public" "%FRAMEWORK_ROUTER%" > "%SERVER_LOG%" 2>&1"
echo       - server starting in a minimized window titled TOEFL-House-Server (log: .runtime\server.log)...
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
echo.  ---- last server output (.runtime\server.log) ----
type "%SERVER_LOG%" 2>nul
echo  ----------------------------------------------------
call :fail "The application was not healthy on %APP_URL_LOCAL% within 60 seconds. The server output above (.runtime\server.log) shows why; also check the TOEFL-House-Server window and storage\logs\laravel.log."
:healthy
echo       - /health OK.

REM ---------------------------------------------------------------------------
REM Step 10 - Tailscale Serve, private to the Tailnet, never Funnel
REM ---------------------------------------------------------------------------
echo [10/10] Private Tailscale access (optional - never blocks the local app)...
REM Tailscale is a convenience layer on top of the already-healthy local server:
REM it makes the app reachable from the other devices on the private Tailnet.
REM If it cannot be installed, signed in, or have Serve configured, the launcher
REM does NOT call the fatal :fail path - it finishes and reports the local URL,
REM then tells how to set Tailscale up manually and re-run.
set "TAILSCALE_BIN="
where tailscale.exe >nul 2>nul && set "TAILSCALE_BIN=tailscale.exe"
if not defined TAILSCALE_BIN (
    echo       - Tailscale not found: downloading the official client.
    REM Fetch through the same atomic, retry/validated helper used for PHP,
    REM Composer and PostgreSQL (never a bare curl into the destination).
    call :fetch_file "%RT%\downloads\tailscale-setup.msi" "%TAILSCALE_MSI_URL%" "" "10485760"
    if errorlevel 1 (
        echo       - Tailscale could not be downloaded from %TAILSCALE_MSI_URL%.
        goto ts_unavailable
    )
    echo       - Installing Tailscale silently. A Windows User Account Control
    echo         prompt may appear - click Yes. Declining it simply skips Tailscale.
    start /wait "" msiexec /i "%RT%\downloads\tailscale-setup.msi" /qn /norestart
    if errorlevel 1 (
        echo       - The Tailscale MSI install did not complete - it may have been
        echo         cancelled at the User Account Control prompt.
        goto ts_unavailable
    )
)
REM Locate the freshly installed client. The MSI installs into Program Files on
REM 64-bit Windows; also check PATH and the legacy x86 path. The (x86) path
REM contains parentheses, so it is kept OUTSIDE the parenthesized block above
REM (an unquoted ) inside an echo/if block would close cmd's block early).
where tailscale.exe >nul 2>nul && set "TAILSCALE_BIN=tailscale.exe"
if not defined TAILSCALE_BIN if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TAILSCALE_BIN=%ProgramFiles%\Tailscale\tailscale.exe"
if not defined TAILSCALE_BIN if exist "%ProgramFiles(x86)%\Tailscale\tailscale.exe" set "TAILSCALE_BIN=%ProgramFiles(x86)%\Tailscale\tailscale.exe"
if not defined TAILSCALE_BIN (
    echo       - Tailscale was installed but tailscale.exe could not be located yet;
    echo         a sign-out or reboot may be needed for the install to register.
    goto ts_unavailable
)
"%TAILSCALE_BIN%" status >nul 2>nul
if errorlevel 1 goto ts_signin_required
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
if errorlevel 1 goto ts_serve_failed
goto ts_serve_ok

:ts_signin_required
echo.
echo   ONE MANUAL STEP REMAINS to enable private Tailnet access (optional):
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
goto ts_unavailable

:ts_serve_failed
echo.
echo   Tailscale Serve could not be finished. Usually one of: the Tailscale
echo   client is not signed in (open the Tailscale tray app and sign in), or
echo   the tailnet needs HTTPS certificates enabled
echo   (https://login.tailscale.com/admin/dns, or ask the tailnet admin).
echo.
goto ts_unavailable

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
goto ts_summary

:ts_unavailable
echo  =====================================================================
echo   THE TOEFL HOUSE IS RUNNING - private Tailnet access is not set up.
echo  =====================================================================
echo.
echo   The local server is healthy and fully usable on this computer:
echo        %APP_URL_LOCAL%
echo.
echo   Only the optional private Tailnet link to your other devices could
echo   not be configured now. To enable it later:
echo     1. Install Tailscale from https://tailscale.com/download/windows
echo        (or fix the download/network if it failed).
echo     2. Open the Tailscale tray app and sign in to your tailnet; approve
echo        this machine on a device already signed in.
echo     3. Double-click START-TOEFL-HOUSE.bat again - it finishes the
echo        Tailscale setup and prints the private address.
echo.
echo   Nothing is exposed to the public internet; Tailscale Funnel is unused.
echo.

:ts_summary
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
echo   This window stays open so you can read the exact failure above.
echo   The launcher exits NOW (non-zero); no later step runs, so the first
echo   error shown is the real root cause. Close the window or press Ctrl+C.
echo.
pause
REM A bare "exit" (no /b) terminates the ENTIRE cmd/launcher process and sets
REM the error level. "/b" would only return from this subroutine, so the caller
REM (and a parenthesized block) would keep going and mask the original failure.
exit 1

:prepare_pg
REM Idempotent PostgreSQL cluster + server bring-up. Never starts a server that
REM is already running, and after a start it waits until the server actually
REM accepts connections (authoritative pg_ctl status, then pg_isready).
if not exist "%PGDATA%\PG_VERSION" (
    echo       - first run: initializing the database cluster...
    "%PG_BIN%\initdb.exe" -U postgres -A trust --encoding=UTF8 --no-locale -D "%PGDATA%"
    if errorlevel 1 call :fail "PostgreSQL cluster initialization failed. If a previous run was interrupted, the cluster folder is incomplete: delete the whole folder .runtime\pgdata and re-run this file. Otherwise check .runtime\pg.log, and if another program owns port %PG_PORT%, close it and re-run."
)
REM pg_ctl status: exit 0 = our cluster's server is already running; 3 = not
REM running (the normal first-start case); 4 = data directory problem.
"%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" status >nul 2>nul
if errorlevel 1 (
    echo       - starting PostgreSQL...
    "%PG_BIN%\pg_ctl.exe" -D "%PGDATA%" -o "-p %PG_PORT% -h 127.0.0.1 -c log_timezone=UTC" -l "%PG_LOG%" start
    if errorlevel 1 exit /b 1
) else (
    echo       - PostgreSQL already running; reusing it.
)
REM Wait until the server genuinely accepts connections (up to ~30 seconds).
set /a PG_TRIES=0
:pg_wait_loop
set /a PG_TRIES+=1
"%PG_BIN%\pg_isready.exe" -h 127.0.0.1 -p %PG_PORT% -t 3 >nul 2>nul
if not errorlevel 1 goto pg_wait_done
if %PG_TRIES% GEQ 30 exit /b 1
timeout /t 1 /nobreak >nul
goto pg_wait_loop
:pg_wait_done
echo       - PostgreSQL ready.
exit /b 0

:ensure_app_db
REM Idempotent, data-preserving database ensure. Creates toefl_house only when
REM absent. When present it is NEVER dropped or overwritten: it is classified
REM by an authoritative catalog check and reused only if it belongs to this
REM application; an unrecognizable/foreign database stops the launcher.
REM Existence and identity are decided with PHP/PDO via the launcher helper.
REM Doing this through `for /f` over psql.exe with quoted paths/SQL was
REM mis-parsed by cmd (the command never ran and the result came back empty);
REM PHP/PDO is the same reliable stack the application already uses.
if not exist "%LAUNCHER_HELPER%" call :fail "The launcher helper is missing at %LAUNCHER_HELPER%. Re-clone the repository."
set "MAINT_DSN=pgsql:host=127.0.0.1;port=%PG_PORT%;dbname=postgres;sslmode=disable"
set "APP_DSN=pgsql:host=127.0.0.1;port=%PG_PORT%;dbname=toefl_house;sslmode=disable"
REM Decide from the helper's EXIT CODE, not its stdout. We intentionally do NOT
REM wrap this in a `for /f` loop: for /f runs the command via `cmd /c`, whose
REM quote-handling mangles a line with several quoted paths (it produced
REM "The filename, directory name, or volume label syntax is incorrect.").
REM   db-exists: 0 = present, 3 = absent, anything else = error.
"%PHP%" "%LAUNCHER_HELPER%" db-exists "%MAINT_DSN%" postgres "" toefl_house >nul
set "DBEX_RC=!ERRORLEVEL!"
if "!DBEX_RC!"=="3" goto db_create
if not "!DBEX_RC!"=="0" call :fail "Could not ask PostgreSQL whether toefl_house exists (helper failed or the server is unreachable). Check .runtime\pg.log and re-run this file."
goto db_present
:db_create
echo       - creating the toefl_house database...
"%PG_BIN%\createdb.exe" -h 127.0.0.1 -p %PG_PORT% -U postgres toefl_house
if errorlevel 1 call :fail "Could not create the toefl_house database. Re-run this file."
exit /b 0
:db_present
REM   db-app-valid: 0 = recognized TOEFL House DB, 3 = foreign, else = error.
"%PHP%" "%LAUNCHER_HELPER%" db-app-valid "%APP_DSN%" postgres "" toefl_house >nul
set "DBVAL_RC=!ERRORLEVEL!"
if "!DBVAL_RC!"=="3" goto db_foreign
if not "!DBVAL_RC!"=="0" call :fail "Could not verify whether toefl_house is a TOEFL House database (helper failed). Check .runtime\pg.log and re-run. Nothing has been dropped or overwritten."
:db_valid
echo       - toefl_house already exists and is a TOEFL House database; reusing it - no data is changed.
exit /b 0
:db_foreign
call :fail "A PostgreSQL database named 'toefl_house' already exists on port %PG_PORT% but is NOT recognized as the TOEFL House database (it has none of this application's tables or migrations). Nothing has been dropped or overwritten. To avoid destroying data, the launcher stops here. If this database belongs to a different program, rename it or remove it yourself; if you expected a TOEFL House database, contact the maintainer. Then re-run this file."
exit /b 1


:fetch_file
REM Atomic, validated download. Usage:
REM   call :fetch_file <destination> <primary_url> <fallback_url> <min_bytes>
REM Downloads to <destination>.part with bounded retries, verifies a minimum
REM size, and only then renames .part over the known-good destination (so a
REM partial download never clobbers a good file). Sets errorlevel 0 on success,
REM 1 on failure. The caller MUST :fail on errorlevel 1 (it must not continue).
setlocal
set "FF_DEST=%~1"
set "FF_URL1=%~2"
set "FF_URL2=%~3"
set "FF_MIN=%~4"
if exist "%FF_DEST%.part" del /q "%FF_DEST%.part" >nul 2>nul
call :fetch_try "%FF_URL1%"
if errorlevel 1 if not "%FF_URL2%"=="" (
    echo       - the first source failed; trying the alternate source...
    call :fetch_try "%FF_URL2%"
)
if errorlevel 1 (
    del /q "%FF_DEST%.part" >nul 2>nul
    endlocal & exit /b 1
)
for %%S in ("%FF_DEST%.part") do set "FF_BYTES=%%~zS"
if !FF_BYTES! LSS !FF_MIN! (
    echo       - download produced only !FF_BYTES! bytes, fewer than the !FF_MIN! bytes expected - rejected.
    del /q "%FF_DEST%.part" >nul 2>nul
    endlocal & exit /b 1
)
move /y "%FF_DEST%.part" "%FF_DEST%" >nul
endlocal & exit /b 0

:fetch_try
REM One download source with bounded retries. call :fetch_try <url>
set "FT_URL=%~1"
set /a FT_TRY=0
:ft_loop
set /a FT_TRY+=1
curl.exe -fL --connect-timeout 20 --retry 2 --retry-delay 2 -o "%FF_DEST%.part" "%FT_URL%"
if not errorlevel 1 goto ft_ok
echo       - download attempt %FT_TRY% of 3 failed: %FT_URL%
if %FT_TRY% LSS 3 (
    timeout /t 3 /nobreak >nul
    goto ft_loop
)
exit /b 1
:ft_ok
exit /b 0

:prepare_php
REM Self-healing PHP runtime preparation. Ensures a working PHP whose PDO
REM PostgreSQL driver is actually loaded. A valid runtime is reused as-is; a
REM missing/broken one is repaired from the cached archive or re-downloaded,
REM and the run stops (via :fail, which exits the launcher) if PHP cannot be
REM made healthy. No global PATH is changed; the PHP folder is prepended only
REM for this launcher process (inherited by the server it starts), so the
REM bundled libpq.dll etc. are discoverable without admin rights.
set "PATH=%PHP_DIR%;%PATH%"

if exist "%PHP_DIR%\php.exe" goto php_have
echo       - PHP %PHP_VERSION% not found yet: preparing the runtime...
call :php_download
goto php_configure
:php_have
call :php_health
if not errorlevel 1 goto php_ready
echo       - the existing PHP runtime cannot load PDO_PGSQL; attempting to repair it...
call :php_diagnose
if exist "%RT%\downloads\php.zip" (
    echo       - re-extracting PHP from the cached, verified archive...
    call :php_extract
    if not errorlevel 1 call :php_health
    if not errorlevel 1 goto php_ready
)
echo       - repair from cache failed; re-downloading the PHP runtime...
call :php_download
:php_configure
call :php_health
if errorlevel 1 (
    call :php_diagnose
    call :fail "PHP could not be prepared with a working PostgreSQL driver (pdo_pgsql). See the diagnostic block above for the exact php.ini, extension_dir and DLL state."
)
:php_ready
echo       - PHP runtime ready: PDO pdo_pgsql available.
exit /b 0

:php_download
REM Fetch the official PHP zip atomically (current-release URL, then the
REM permanent archive), verify integrity, and extract into %PHP_DIR%.
echo       - PHP %PHP_VERSION% : downloading the official runtime...
call :fetch_file "%RT%\downloads\php.zip" "%PHP_ZIP_URL%" "%PHP_ARCHIVE_ZIP_URL%" "10485760"
if errorlevel 1 call :fail "PHP download failed or was truncated from both %PHP_ZIP_URL% and %PHP_ARCHIVE_ZIP_URL%. The incomplete file was discarded. Check the internet connection and re-run this file."
"%TAR%" -tf "%RT%\downloads\php.zip" >nul 2>nul
if errorlevel 1 call :fail "The downloaded PHP archive %RT%\downloads\php.zip is corrupt or truncated (integrity test failed). Delete it and re-run this file."
call :php_extract
if errorlevel 1 call :fail "Could not unpack the PHP archive with %TAR%. Archive: %RT%\downloads\php.zip destination: %PHP_DIR%. Delete .runtime\php and re-run."
exit /b 0

:php_extract
REM Extract the flat official PHP zip straight into a clean %PHP_DIR% and write php.ini.
if exist "%PHP_DIR%" rd /q /s "%PHP_DIR%"
mkdir "%PHP_DIR%"
"%TAR%" -xf "%RT%\downloads\php.zip" -C "%PHP_DIR%"
if errorlevel 1 exit /b 1
if not exist "%PHP_DIR%\php.exe" exit /b 1
call :write_php_ini
exit /b 0

:php_health
REM Authoritative health check: PHP must run AND the pdo_pgsql driver must be a
REM reported available PDO driver. Returns errorlevel 0 when healthy, 1 otherwise.
REM (stderr is shown by the caller's diagnostic if this fails.)
"%PHP%" -r "exit(extension_loaded('PDO') && extension_loaded('pdo_pgsql') && in_array('pgsql', PDO::getAvailableDrivers(), true) ? 0 : 1);"
set "PHP_HEALTH=%ERRORLEVEL%"
exit /b %PHP_HEALTH%

:php_diagnose
REM Print a precise, secret-free diagnostic when PDO_PGSQL will not load.
echo.
echo  -----------------------------------------------------------------------
echo   PHP RUNTIME DIAGNOSTIC - PDO PostgreSQL driver is unavailable
echo  -----------------------------------------------------------------------
echo   PHP executable : %PHP%
echo   PHP folder     : %PHP_DIR%
"%PHP%" -v 2>nul
echo   --- configuration ---
echo   Loaded php.ini (Configuration File Path ^| Loaded Configuration File):
"%PHP%" --ini 2>nul
echo   extension_dir reported by PHP:
"%PHP%" -r "echo '    extension_dir = ', ini_get('extension_dir'), PHP_EOL;" 2>nul
echo   --- required files ^(present?^) ---
call :diag_file "%PHP_DIR%\php.exe"
call :diag_file "%PHP_DIR%\libpq.dll"
call :diag_file "%PHP_DIR%\ext\php_pdo.dll"
call :diag_file "%PHP_DIR%\ext\php_pdo_pgsql.dll"
call :diag_file "%PHP_DIR%\ext\php_pgsql.dll"
echo   --- PDO drivers PHP can actually load ---
"%PHP%" -r "echo '    extension_loaded PDO: ', var_export(extension_loaded('PDO'), true), PHP_EOL, '    extension_loaded pdo_pgsql: ', var_export(extension_loaded('pdo_pgsql'), true), PHP_EOL, '    PDO::getAvailableDrivers: ', implode(',', PDO::getAvailableDrivers()), PHP_EOL;" 2>&1
echo   --- raw PHP startup output (any 'Unable to load dynamic library' message
echo       names the missing DLL / wrong extension_dir / architecture mismatch) ---
"%PHP%" -m 2>&1
echo   Most common causes: extension_dir is not the absolute "%PHP_DIR%\ext",
echo   a dependency DLL such as libpq.dll is not on this process PATH, or the
echo   PHP architecture/thread-safety does not match the extension DLLs.
echo  -----------------------------------------------------------------------
echo.
exit /b 0

:diag_file
if exist "%~1" (echo     PRESENT : %~1) else (echo     MISSING : %~1)
exit /b 0

:prepare_composer
REM Reuse a working composer.phar (idempotent). Otherwise download the official
REM pinned PHAR directly (NOT the composer-setup.php bootstrapper, which crashed
REM php.exe with STATUS_ACCESS_VIOLATION 0xC0000005 / -1073741819 on this
REM runtime), verify it is non-trivial in size and actually runs --version.
if exist "%COMPOSER_PHAR%" (
    "%PHP%" "%COMPOSER_PHAR%" --version >nul 2>nul
    if not errorlevel 1 exit /b 0
    echo       - existing composer.phar cannot run; replacing it.
    del /q "%COMPOSER_PHAR%" >nul 2>nul
)
echo       - Composer : downloading composer.phar %COMPOSER_VERSION% ...
call :fetch_file "%COMPOSER_PHAR%" "%COMPOSER_PHAR_URL%" "" "1000000"
if errorlevel 1 call :fail "Composer download failed or was truncated from %COMPOSER_PHAR_URL%. The incomplete file was discarded. Check the internet connection and re-run."
for %%S in ("%COMPOSER_PHAR%") do set "CP_BYTES=%%~zS"
if !CP_BYTES! LSS 1000000 call :fail "Downloaded composer.phar is only !CP_BYTES! bytes (a valid PHAR is ~3 MB) - truncated/corrupt. Re-run this file."
"%PHP%" "%COMPOSER_PHAR%" --version >nul 2>nul
if errorlevel 1 call :fail "composer.phar was downloaded to %COMPOSER_PHAR% but cannot run with %PHP%. Delete .runtime\composer.phar and re-run."
echo       - Composer ready.
exit /b 0


:write_php_ini
REM A minimal, fully controlled php.ini for the desktop deployment. The stock
REM php.ini-production ships several required extensions commented out; writing
REM our own keeps the runtime deterministic.
REM
REM Two details are essential on Windows:
REM   1. extension_dir must be ABSOLUTE. A relative "ext" is resolved against the
REM      process current working directory (the repo root when the launcher runs),
REM      not the PHP folder, so no extension DLL is found and pdo_pgsql fails.
REM   2. The PDO shared core (php_pdo.dll, present in older/most Windows builds)
REM      must be loaded BEFORE pdo_pgsql; load pdo first when that DLL exists.
> "%PHP_DIR%\php.ini" echo [PHP]
>>"%PHP_DIR%\php.ini" echo extension_dir = "%PHP_DIR%\ext"
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
REM Load the PDO shared core before any PDO driver, but only where that DLL is
REM shipped (modern 8.x builds have PDO built into php8ts.dll; this line is then
REM skipped harmlessly).
if exist "%PHP_DIR%\ext\php_pdo.dll" >>"%PHP_DIR%\php.ini" echo extension=pdo
>>"%PHP_DIR%\php.ini" echo extension=pdo_pgsql
>>"%PHP_DIR%\php.ini" echo extension=pgsql
>>"%PHP_DIR%\php.ini" echo extension=fileinfo
REM dom, xml, simplexml, xmlreader and xmlwriter are compiled INTO the PHP
REM core on Windows (there is no php_dom.dll/php_xml.dll in ext). Listing them
REM as shared extensions produced "Unable to load dynamic library ... The
REM specified module could not be found" on every PHP invocation; the built-in
REM implementations are always present, so they are intentionally not written.
>>"%PHP_DIR%\php.ini" echo extension=zip
exit /b 0

:resolve_app_port
REM Pick the HTTP port. Sets APP_PORT, APP_URL_LOCAL and PORTCAND_HOW:
REM   PORTCAND_HOW=health  an instance is already answering /health (reuse it)
REM   PORTCAND_HOW=bind    the port was verified bindable and must be served.
if not exist "%LAUNCHER_HELPER%" call :fail "The launcher helper is missing at %LAUNCHER_HELPER%. Re-clone the repository."
call :probe_port %APP_PORT%
if defined PORTCAND_HOW goto port_resolved
for %%P in (8081 8082 8090 8181 9090 9091 9000 9001 18080 28080) do (
    if not defined PORTCAND_HOW call :probe_port %%P
)
:port_resolved
if not defined PORTCAND_HOW call :fail "Could not bind any web port starting from %APP_PORT%. A Windows reserved/excluded port range or another program is blocking them. Close the program holding the port (or restart to release dynamic Hyper-V/WinNAT reservations) and re-run this file."
set "APP_URL_LOCAL=http://127.0.0.1:%APP_PORT%"
"%PHP%" "%LAUNCHER_HELPER%" env-set "%ROOT%\.env" "APP_URL=%APP_URL_LOCAL%"
if errorlevel 1 call :fail "Could not write APP_URL to the .env file. Re-run this file."
if "%PORTCAND_HOW%"=="health" (
    echo       - application already responding on port %APP_PORT%; reusing it.
) else (
    echo       - using web port %APP_PORT%, verified available.
)
goto :eof

:probe_port
REM Sets PORTCAND_HOW if port %~1 already serves our app ("health") or is
REM bindable ("bind"). Uses goto :eof so it works when called inside a for loop.
set "PORTCAND_HOW="
for /f "tokens=*" %%c in ('curl.exe -s -o nul -w "%%{http_code}" --max-time 3 "http://127.0.0.1:%~1/health" 2^>nul') do if "%%c"=="200" set "PORTCAND_HOW=health"
if defined PORTCAND_HOW (
    set "APP_PORT=%~1"
    goto :eof
)
"%PHP%" "%LAUNCHER_HELPER%" port-bindable %~1
if errorlevel 1 goto :eof
set "PORTCAND_HOW=bind"
set "APP_PORT=%~1"
goto :eof

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
