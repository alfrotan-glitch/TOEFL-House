@echo off
setlocal EnableExtensions
title TOEFL House ERP - Frontend (Vite)
cd /d "%~dp0"

echo ============================================
echo  TOEFL House ERP - Frontend Client
echo ============================================
echo  Folder: %CD%
echo  UI:     http://localhost:3000
echo  API:    http://localhost:4000/api
echo ============================================
echo.

if not exist "package.json" (
  echo [ERROR] package.json not found in project root.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [INFO] Installing frontend dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting frontend (Vite)...
echo [INFO] Press Ctrl+C to stop.
echo.
call npm run dev
echo.
echo Frontend stopped.
pause
endlocal
