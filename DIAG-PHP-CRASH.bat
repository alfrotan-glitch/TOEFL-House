@echo off
REM ============================================================================
REM DIAG-PHP-CRASH.bat  -  READ-ONLY native PHP crash diagnosis.
REM
REM Purpose: find WHY php.exe terminates with 0xc0000005 (STATUS_ACCESS_VIOLATION)
REM on THIS Windows machine. It changes NOTHING:
REM   * does not modify, delete, or reinstall PHP / Composer / PostgreSQL
REM   * does not touch .runtime\pgdata or the toefl_house database
REM   * installs nothing (no VC++ redistributable, no package)
REM It only: runs read-only probes, reads the registry/event log, computes
REM SHA-256, and writes temporary .ini files into %TEMP%.
REM
REM Output is captured to  .runtime\diag-php-crash.txt  and shown on screen.
REM If a native crash popup appears, click OK - the script continues.
REM When it finishes, attach .runtime\diag-php-crash.txt in your reply.
REM ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
set "RT=%~dp0.runtime"
set "PHP_DIR=%RT%\php"
set "PHP=%PHP_DIR%\php.exe"
set "PG_DIR=%RT%\pgsql"
set "LOG=%RT%\diag-php-crash.txt"
set "D=%TEMP%\thdiag"
if not exist "%RT%" mkdir "%RT%"
REM Reproduce the launcher's process PATH: PHP folder first so PHP's bundled
REM libpq.dll (and friends) resolve exactly as they do under START-TOEFL-HOUSE.bat.
set "PATH=%PHP_DIR%;%PATH%"

if /i not "%~1"=="run" goto tee
goto body

:tee
echo Running the read-only PHP crash diagnosis...
echo Full output is captured to: %LOG%
call "%~f0" run > "%LOG%" 2>&1
echo.
echo =========================== DIAGNOSIS OUTPUT ===============================
type "%LOG%"
echo.
echo ================================ END =======================================
echo.
echo The complete report is saved at:
echo   %LOG%
echo Attach that file (or copy the text above) in your reply.
echo Nothing was changed on this machine.
echo.
pause
exit /b 0

:body
cd /d "%~dp0"
echo TOEFL House - native PHP crash (0xc0000005) READ-ONLY diagnosis
echo Date/time   : %date% %time%
echo Repo root   : %CD%
echo PHP target  : %PHP%
echo.

echo.
echo ### 1. EXECUTABLE PRESENCE + DLL LAYOUT
if exist "%PHP%" (echo [OK] php.exe exists) else (echo [!!] php.exe NOT FOUND at %PHP%)
dir "%PHP%" "%PHP_DIR%\libpq.dll" 2>nul | findstr /i /c:"php.exe" /c:"libpq.dll"
echo.
echo --- all DLLs shipped in the PHP folder:
dir /b "%PHP_DIR%\*.dll" 2>nul
echo.
echo --- PHP folder first on this process PATH (so PHP's own libpq loads):
echo PATH=%PATH%
echo.
echo --- is the PostgreSQL bin directory on PATH? (it should NOT be):
echo "%PATH%" | findstr /i /c:"pgsql" >nul && echo   [!!] pgsql IS on PATH || echo   [ok] pgsql NOT on PATH (PHP uses its bundled libpq)

echo.
echo ### 2. PHP WITH -n  (ignores php.ini AND all extensions - the key discriminator)
echo --- cmd: php.exe -n -v
"%PHP%" -n -v
echo [errorlevel=!ERRORLEVEL!]   (0=ran clean; -1073741819 / 3221225477 = 0xc0000005 native crash)
echo --- cmd: php.exe -n -m
"%PHP%" -n -m
echo [errorlevel=!ERRORLEVEL!]
echo --- cmd: php.exe -n -r "echo PHP_VERSION, PHP_EOL;"
"%PHP%" -n -r "echo PHP_VERSION, PHP_EOL;"
echo [errorlevel=!ERRORLEVEL!]

echo.
echo ### 3. PHP WITH the generated php.ini (normal launcher configuration)
echo --- cmd: php.exe -v
"%PHP%" -v
echo [errorlevel=!ERRORLEVEL!]
echo --- cmd: php.exe -m
"%PHP%" -m
echo [errorlevel=!ERRORLEVEL!]
echo --- which ini is loaded:
"%PHP%" --ini
echo [errorlevel=!ERRORLEVEL!]

echo.
echo ### 4. EXACT BUILD (version / arch / TS / compiler) - read with -n
"%PHP%" -n -i 2>nul | findstr /b /c:"PHP Version" /c:"System" /c:"Architecture" /c:"Thread Safety" /c:"PHP Extension Build" /c:"Debug Build"
echo [errorlevel=!ERRORLEVEL!]

echo.
echo ### 5. EXTENSION ISOLATION (temporary inis in %TEMP%; nothing installed)
mkdir "%D%" 2>nul
> "%D%\none.ini"  echo [PHP]
>> "%D%\none.ini" echo extension_dir="%PHP_DIR%\ext"
> "%D%\pdo.ini"   echo [PHP]
>> "%D%\pdo.ini"  echo extension_dir="%PHP_DIR%\ext"
>> "%D%\pdo.ini"  echo extension=pdo_pgsql
> "%D%\pgsql.ini" echo [PHP]
>> "%D%\pgsql.ini" echo extension_dir="%PHP_DIR%\ext"
>> "%D%\pgsql.ini" echo extension=pgsql
echo --- (a) NO extensions:
"%PHP%" -c "%D%\none.ini" -m
echo [errorlevel=!ERRORLEVEL!]
echo --- (b) pdo_pgsql ONLY:
"%PHP%" -c "%D%\pdo.ini" -m
echo [errorlevel=!ERRORLEVEL!]
echo --- (c) pgsql ONLY:
"%PHP%" -c "%D%\pgsql.ini" -m
echo [errorlevel=!ERRORLEVEL!]
echo --- (d) pdo_pgsql load + driver list (no network):
"%PHP%" -c "%D%\pdo.ini" -r "echo extension_loaded('pdo_pgsql') ? 'pdo_pgsql LOADED' : 'NOT loaded', PHP_EOL; echo 'drivers: ', implode(',', PDO::getAvailableDrivers()), PHP_EOL;"
echo [errorlevel=!ERRORLEVEL!]
echo --- (e) libpq in action: real PDO connect to 127.0.0.1:5432 (if Postgres is up; a caught PHP exception means the connect path itself did NOT crash):
"%PHP%" -c "%D%\pdo.ini" -r "try { new PDO('pgsql:host=127.0.0.1;port=5432;dbname=postgres', 'postgres', ''); echo 'CONNECT_OK - libpq native path works', PHP_EOL; } catch (Throwable $e) { echo 'CONNECT_THRREW (PHP-level): ', $e->getMessage(), PHP_EOL; }"
echo [errorlevel=!ERRORLEVEL!]

echo.
echo ### 5b. APPLICATION-WEIGHTED PROBE (full Laravel bootstrap with every extension, read-only)
echo --- cmd: php.exe artisan --version   (uses the normal php.ini, repo-root cwd like the launcher)
if exist "%CD%\artisan" (
  "%PHP%" artisan --version
  echo [errorlevel=!ERRORLEVEL!]   (0=framework boots clean; crash popup here = the fault is in the full-extension/bootstrap path)
) else (
  echo artisan not found in repo root - skipping.
)
echo --- composer phar --version with the launcher php (the path that previously crashed on the installer):
if exist "%RT%\composer.phar" (
  "%PHP%" "%RT%\composer.phar" --version
  echo [errorlevel=!ERRORLEVEL!]
)

echo.
echo ### 6. VISUAL C++ REDISTRIBUTABLE 2015-2022 x64 (registry read ONLY - nothing installed)
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" 2>nul
if errorlevel 1 (
  echo [!!] VC++ 2015-2022 x64 runtime REGISTRY KEY NOT FOUND - likely MISSING.
) else (
  echo [ok] VC++ 2015-2022 x64 runtime registry key present.
)
echo --- runtime DLLs in System32:
dir "%SystemRoot%\System32\vcruntime140.dll" "%SystemRoot%\System32\vcruntime140_1.dll" "%SystemRoot%\System32\msvcp140.dll" 2>nul | findstr /i /c:"vcruntime" /c:"msvcp"

echo.
echo ### 7. SHA-256 (local) + OFFICIAL checksum manifest
echo --- php.exe:
certutil -hashfile "%PHP%" SHA256 | findstr /v /c:"CertUtil"
echo --- cached download php.zip (if present):
if exist "%RT%\downloads\php.zip" (
  certutil -hashfile "%RT%\downloads\php.zip" SHA256 | findstr /v /c:"CertUtil"
) else (
  echo php.zip not cached in .runtime\downloads
)
echo --- fetching official SBOM manifest for php-8.2.27-Win32-vs16-x64.zip (read-only):
powershell -NoProfile -Command "try { $c = (Invoke-WebRequest -UseBasicParsing -Uri 'https://downloads.php.net/~windows/releases/archives/php-8.2.27-Win32-vs16-x64.zip.cdx.json' -TimeoutSec 40).Content; Set-Content -Path '%D%\cdx.json' -Value $c -Encoding utf8; Write-Output ('manifest fetched, bytes: ' + $c.Length) } catch { Write-Output ('manifest fetch failed: ' + $_.Exception.Message) }"
echo --- manifest content (look for the file name and its SHA-256):
type "%D%\cdx.json" 2>nul

echo.
echo ### 8. WINDOWS EVENT LOG - native crash details (faulting module / exception / offset)
echo Querying Application Error events that mention php.exe...
powershell -NoProfile -Command "$ev = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} -MaxEvents 40 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'php' } | Select-Object -First 5; if ($ev) { foreach ($x in $ev) { Write-Output ('---------------- ' + $x.TimeCreated); Write-Output $x.Message } } else { Write-Output 'No Application Error event mentioning php.exe found yet.'; Write-Output 'Re-run START-TOEFL-HOUSE.bat to produce a FRESH crash, leave the popup, then run this diagnosis again.' }"

echo.
echo ### 9. libpq / dependency DLL versions (the pdo_pgsql/pgsql dependency chain)
echo --- PHP-folder libpq.dll version:
powershell -NoProfile -Command "if (Test-Path '%PHP_DIR%\libpq.dll') { (Get-Item '%PHP_DIR%\libpq.dll').VersionInfo | Format-List FileDescription,FileVersion,ProductVersion } else { Write-Output 'libpq.dll NOT in PHP folder' }"
echo --- PostgreSQL-folder libpq.dll version (if PG is unpacked):
if exist "%PG_DIR%\bin\libpq.dll" (
  powershell -NoProfile -Command "(Get-Item '%PG_DIR%\bin\libpq.dll').VersionInfo | Format-List FileDescription,FileVersion,ProductVersion"
) else (
  echo PostgreSQL bin libpq.dll not present yet.
)
echo --- OpenSSL/other native deps shipped with PHP (versions):
powershell -NoProfile -Command "Get-ChildItem '%PHP_DIR%\*.dll' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'lib(ssl|crypto|pq|iconv|sasl|ssh2|xml|xslt|zip)' } | ForEach-Object { $v=$_.VersionInfo.FileVersion; Write-Output ($_.Name + '  ' + $v) }"

echo.
echo ### DONE. Re-run: if a popup appeared, click OK and attach %LOG%.
endlocal & exit /b 0
