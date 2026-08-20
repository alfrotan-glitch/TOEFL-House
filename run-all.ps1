$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
Write-Host "TOEFL House ERP - Start All" -ForegroundColor Cyan

Write-Host "[1/3] Preparing backend environment and database..." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot "bootstrap.bat")
if ($LASTEXITCODE -ne 0) {
    throw "Backend bootstrap failed. Configure the required values shown above; frontend was not started."
}

$port = 4000
$envPath = Join-Path $PSScriptRoot "server\.env"
if (Test-Path $envPath) {
    $portLine = Get-Content $envPath | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
    if ($portLine) { [int]::TryParse(($portLine -replace '^PORT=', ''), [ref]$port) | Out-Null }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    throw "Port $port is already in use by PID $($listener.OwningProcess). Refusing to start a second backend instance."
}

Write-Host "[2/3] Starting backend on port $port..." -ForegroundColor Yellow
$backendScript = Join-Path $PSScriptRoot "run-backend.ps1"
$backendArguments = "-NoProfile -File `"$backendScript`""
$backend = Start-Process powershell -PassThru -ArgumentList $backendArguments

Write-Host "[INFO] Waiting up to 120 seconds for database and backup readiness..." -ForegroundColor Yellow
$ready = $false
for ($attempt = 1; $attempt -le 120; $attempt++) {
    if ($backend.HasExited) { break }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
        if ($health.ready -eq $true -and $health.backup.healthy -eq $true) {
            $ready = $true
            break
        }
    } catch {
        # The backend is still bootstrapping or has reported HTTP 503.
    }
    Start-Sleep -Seconds 1
}

if (-not $ready) {
    Write-Host "[ERROR] Backend did not become ready; frontend will not be started." -ForegroundColor Red
    $logPath = Join-Path $PSScriptRoot "server\logs\backend-startup.log"
    if (Test-Path $logPath) {
        Write-Host "[INFO] Last backend startup log lines:" -ForegroundColor Yellow
        Get-Content -LiteralPath $logPath -Tail 80
    }
    throw "Backend readiness failed. Check BACKUP_EXTERNAL_DIR and the startup log."
}

Write-Host "[3/3] Starting frontend..." -ForegroundColor Yellow
$frontendScript = Join-Path $PSScriptRoot "run-frontend.ps1"
$frontendArguments = "-NoProfile -NoExit -File `"$frontendScript`""
Start-Process powershell -ArgumentList $frontendArguments
Write-Host "[SUCCESS] Backend is healthy, required backups are verified, and frontend was launched." -ForegroundColor Green
