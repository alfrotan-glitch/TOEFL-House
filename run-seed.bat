@echo off
setlocal EnableExtensions
title TOEFL House ERP - Production Bootstrap
cd /d "%~dp0"
call "%~dp0bootstrap.bat"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo [SUCCESS] Bootstrap completed successfully.
) else (
  echo [FAILED] Bootstrap did not complete successfully.
)
pause
endlocal & exit /b %EXIT_CODE%
