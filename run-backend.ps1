$ErrorActionPreference = "Stop"
Set-Location -Path (Join-Path $PSScriptRoot "server")
Write-Host "TOEFL House ERP - Backend" -ForegroundColor Cyan

if (-not (Test-Path "package.json")) { throw "server/package.json not found." }
if (-not (Test-Path "node_modules\.bin\tsx.cmd")) {
    Write-Host "[INFO] Backend dependencies are missing or incomplete. Installing from lockfile..." -ForegroundColor Yellow
    npm ci --include=dev --no-audit --no-fund
}
if (-not (Test-Path "node_modules\.bin\tsx.cmd")) { throw "tsx runtime is missing after npm ci." }

$port = 4000
if (Test-Path ".env") {
    $portLine = Get-Content ".env" | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
    if ($portLine) { [int]::TryParse(($portLine -replace '^PORT=',''), [ref]$port) | Out-Null }
}
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "Port $port is already in use by PID $($listener.OwningProcess). Stop the existing TOEFL House ERP backend before starting another instance."
}
if (-not (Test-Path ".env")) { npm run bootstrap:env }
if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" | Out-Null }
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }
if (Test-Path "logs\backend-startup.log") { Remove-Item "logs\backend-startup.log" -Force -ErrorAction SilentlyContinue }

Write-Host "[INFO] Starting backend; diagnostics: server\logs\backend-startup.log" -ForegroundColor Green
& npm run dev 2>&1 | Tee-Object -FilePath "logs\backend-startup.log"
exit $LASTEXITCODE
