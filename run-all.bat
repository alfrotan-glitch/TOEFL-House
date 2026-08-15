@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title TOEFL House ERP - Start All

echo ============================================
echo  TOEFL House ERP - First Run / Start All
echo ============================================

echo [1/3] Preparing backend environment and database...
call "%~dp0bootstrap.bat"
if errorlevel 1 (
  echo [ERROR] Backend bootstrap failed. Frontend will not be started.
  pause
  exit /b 1
)

set "BACKEND_PORT=4000"
for /f "tokens=1,2 delims==" %%A in ('findstr /b "PORT=" "%~dp0server\.env" 2^>nul') do set "BACKEND_PORT=%%B"

echo [2/3] Starting backend on port %BACKEND_PORT%...

REM Fail closed if another process already owns the configured port.
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%BACKEND_PORT% .*LISTENING"') do (
  echo [ERROR] Port %BACKEND_PORT% is already in use by PID %%P.
  echo [ERROR] Refusing to start a second backend instance.
  echo [INFO] Stop the existing TOEFL House ERP backend window/process and rerun this launcher.
  pause
  exit /b 1
)

start "TOEFL House - Backend" cmd /k "%~dp0run-backend.bat"

echo [INFO] Waiting for backend readiness endpoint (up to 120 seconds)...
set "BACKEND_READY="
for /l %%I in (1,1,120) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%BACKEND_PORT%/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {} ; exit 1" >nul 2>&1
  if not errorlevel 1 (set "BACKEND_READY=1" & goto backend_ready)
  timeout /t 1 /nobreak >nul
)

:backend_ready
if not defined BACKEND_READY (
  echo [ERROR] Backend did not become ready within 120 seconds.
  echo [INFO] Diagnostic health response:
  powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:%BACKEND_PORT%/api/health' -TimeoutSec 3 | ConvertTo-Json -Depth 5 } catch { Write-Host $_.Exception.Message }"
  if exist "%~dp0server\logs\backend-startup.log" (
    echo [INFO] Last backend startup log lines:
    powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0server\logs\backend-startup.log' -Tail 80"
  )
  pause
  exit /b 1
)

echo [3/3] Starting frontend...
start "TOEFL House - Frontend" cmd /k "%~dp0run-frontend.bat"

echo.
echo [SUCCESS] Backend is healthy and frontend has been launched.
timeout /t 4 /nobreak >nul
endlocal
