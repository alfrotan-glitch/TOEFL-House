@echo off
setlocal EnableExtensions
cd /d "%~dp0server"
title TOEFL House ERP - Backend API
if not exist "package.json" (echo [ERROR] server\package.json not found.&pause&exit /b 1)
if not exist "node_modules\.bin\tsx.cmd" (
  echo [INFO] Backend dependencies are missing or incomplete. Installing from lockfile...
  call npm ci --include=dev --no-audit --no-fund --prefer-offline
  if errorlevel 1 (echo [ERROR] npm ci failed.&pause&exit /b 1)
)
if not exist "node_modules\.bin\tsx.cmd" (echo [ERROR] TypeScript runtime "tsx" is still missing.&pause&exit /b 1)

REM Prevent accidental duplicate backend instances.
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":4000 .*LISTENING"') do (
  echo [ERROR] Port 4000 is already in use by PID %%P.
  echo [INFO] Close the existing TOEFL House ERP backend window or terminate PID %%P, then retry.
  pause
  exit /b 1
)
if not exist ".env" (
  call npm run bootstrap:env
  if errorlevel 1 (echo [ERROR] Environment bootstrap failed.&pause&exit /b 1)
)
if exist "dist" rmdir /s /q "dist"
if not exist "logs" mkdir logs
if exist "logs\backend-startup.log" del /q "logs\backend-startup.log" >nul 2>&1

echo ============================================
echo  TOEFL House ERP - Backend Server
echo  API: http://127.0.0.1:4000
 echo ============================================
echo [INFO] Starting backend; startup diagnostics are logged to server\logs\backend-startup.log
powershell -NoProfile -Command "& { npm run dev 2>&1 | Tee-Object -FilePath 'logs\backend-startup.log' }"
set "EXITCODE=%ERRORLEVEL%"
echo [INFO] Backend process exited with code %EXITCODE%.
echo [INFO] Last startup log lines:
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "if (Test-Path 'logs\backend-startup.log') { Get-Content -LiteralPath 'logs\backend-startup.log' -Tail 80 }"`) do echo %%L
pause
exit /b %EXITCODE%
