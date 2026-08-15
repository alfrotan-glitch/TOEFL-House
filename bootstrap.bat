@echo off
setlocal EnableExtensions
cd /d "%~dp0server"

echo ============================================
echo  TOEFL House ERP - First Install Bootstrap
echo ============================================
echo.

if not exist "package.json" (
  echo [ERROR] server\package.json not found.
  endlocal & exit /b 1
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo [INFO] Backend dependencies are missing or incomplete. Installing from lockfile...
  call npm ci --include=dev
  if errorlevel 1 (
    echo [ERROR] npm ci --include=dev failed.
    endlocal & exit /b 1
  )
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo [ERROR] TypeScript runtime "tsx" is still missing after npm install.
  echo [ERROR] Delete server\node_modules and rerun this installer.
  endlocal & exit /b 1
)

if not exist "data\" mkdir data

echo [INFO] Preparing secure first-install environment...
call npm run bootstrap:env
if errorlevel 1 (
  echo [ERROR] Environment bootstrap failed.
  endlocal & exit /b 1
)

echo.
echo [INFO] Running database and owner bootstrap...
call npm run seed
if errorlevel 1 (
  echo [ERROR] Database bootstrap failed.
  endlocal & exit /b 1
)

echo.
echo [SUCCESS] First-install bootstrap completed successfully.
echo.
endlocal & exit /b 0
