$ErrorActionPreference = "Stop"

function Invoke-GateStep {
    param([Parameter(Mandatory=$true)][string]$Name, [Parameter(Mandatory=$true)][scriptblock]$Action)
    Write-Host $Name -ForegroundColor Yellow
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Name FAILED with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
}

Write-Host "TOEFL House ERP Release Gate" -ForegroundColor Cyan

Invoke-GateStep '[0/7] High-assurance static audit' { npm run audit:static }

if (-not (Test-Path (Join-Path $PSScriptRoot 'package-lock.json'))) {
    Write-Error 'ROOT package-lock.json is missing. Generate and commit the frontend lockfile before release certification.'
    exit 20
}

# Prevent stale compiled JavaScript from contaminating tests/builds.
foreach ($artifact in @('server/dist', 'dist')) {
    $path = Join-Path $PSScriptRoot $artifact
    if (Test-Path $path) { Remove-Item $path -Recurse -Force -ErrorAction Stop }
}
Push-Location server
try {
    Invoke-GateStep "[1/6] Backend dependency install" { npm ci --include=dev }
    Invoke-GateStep "[2/6] Backend typecheck" { npm run typecheck }
    Invoke-GateStep "[3/6] Backend tests" { npm test }
    Invoke-GateStep "[4/6] Backend build" { npm run build }
} finally { Pop-Location }

Invoke-GateStep "[5/6] Frontend dependency install" { npm install --package-lock=false }
Invoke-GateStep "[6/6] Frontend validation" {
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "RELEASE GATE PASSED" -ForegroundColor Green
