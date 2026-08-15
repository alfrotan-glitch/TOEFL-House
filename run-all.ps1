$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
Write-Host "Starting Backend + Frontend..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-File", (Join-Path $PSScriptRoot "run-backend.ps1")
Start-Sleep -Seconds 3
Start-Process powershell -ArgumentList "-NoExit", "-File", (Join-Path $PSScriptRoot "run-frontend.ps1")
Write-Host "Launched. Backend :4000  Frontend :3000" -ForegroundColor Green
