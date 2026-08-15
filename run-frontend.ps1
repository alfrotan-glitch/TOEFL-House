$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
Write-Host "TOEFL House ERP - Frontend" -ForegroundColor Cyan
Write-Host "UI: http://localhost:3000" -ForegroundColor Green
if (-not (Test-Path "node_modules")) { npm install }
npm run dev
