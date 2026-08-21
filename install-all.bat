@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title TOEFL House ERP - Clean Dependency Install

echo ============================================
echo TOEFL House ERP - Clean Dependency Install
echo ============================================

if not exist "server\package-lock.json" (
  echo [ERROR] server\package-lock.json is missing.
  exit /b 1
)

if exist "server\node_modules" rmdir /s /q "server\node_modules"
if exist "node_modules" rmdir /s /q "node_modules"

pushd server
call npm ci --include=dev --no-audit --no-fund
if errorlevel 1 (echo [ERROR] Backend dependency installation failed.&popd&exit /b 1)
popd

rem Installed here directly. This step used to delegate to
rem scripts\install-frontend-clean.ps1, which is not present in the repository,
rem so the frontend half of a clean install always failed.
if exist "package-lock.json" (
  call npm ci --include=dev --no-audit --no-fund
) else (
  call npm install --include=dev --no-audit --no-fund
)
if errorlevel 1 (echo [ERROR] Frontend dependency installation failed.&exit /b 1)
if not exist "node_modules\.bin\vite.cmd" (echo [ERROR] Vite missing after install; npm may have omitted devDependencies.&exit /b 1)

echo.
echo [SUCCESS] Backend and frontend dependencies installed.
echo [INFO] Root package-lock.json is now present.
endlocal
exit /b 0
