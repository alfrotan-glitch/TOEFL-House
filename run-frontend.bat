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

rem The DEV BINARY is the test, not the folder. `vite` is a devDependency, so a
rem node_modules installed in production mode exists but contains no vite, and a
rem folder-only check skipped the install and left `npm run dev` to fail with
rem "'vite' is not recognized". run-backend.bat already checks for tsx.cmd this
rem way; the frontend now matches it.
if not exist "node_modules\.bin\vite.cmd" (
  echo [INFO] Frontend dependencies are missing or incomplete. Installing...
  if exist "package-lock.json" (
    call npm ci --include=dev --no-audit --no-fund
  ) else (
    call npm install --include=dev --no-audit --no-fund
  )
  if errorlevel 1 (
    echo [ERROR] Frontend dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "node_modules\.bin\vite.cmd" (
  echo [ERROR] Vite is still missing after installation.
  echo [ERROR] This usually means npm ran in production mode and skipped
  echo [ERROR] devDependencies. Check: npm config get omit    ^(must not list "dev"^)
  echo [ERROR] and that NODE_ENV is not set to "production" in this shell.
  echo [ERROR] Then delete node_modules and run install-all.bat once.
  pause
  exit /b 1
)

echo [INFO] Starting frontend (Vite)...
echo [INFO] Press Ctrl+C to stop.
echo.
call npm run dev
echo.
echo Frontend stopped.
pause
endlocal
