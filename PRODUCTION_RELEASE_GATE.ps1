$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Invoke-GateStep {
    param([string]$Name, [scriptblock]$Action)
    Write-Host $Name -ForegroundColor Yellow
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Name FAILED with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
}

Write-Host '=== TOEFL House ERP Production Release Gate ===' -ForegroundColor Cyan

if (-not (Test-Path '.\server\package-lock.json')) {
    Write-Error 'server/package-lock.json is missing.'
    exit 21
}

foreach ($artifact in @('server/dist','dist')) {
    $path = Join-Path $Root $artifact
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}

# Install dependencies first. The root install creates a deterministic lockfile
# from the clean package manifest when one is not yet present.
Push-Location (Join-Path $Root 'server')
try {
    Invoke-GateStep '[0/8] Backend dependency install' { npm ci --include=dev --no-audit --no-fund }
} finally { Pop-Location }

Invoke-GateStep '[1/8] Frontend dependency install' { npm install --ignore-scripts --no-audit --no-fund }

if (-not (Test-Path '.\package-lock.json')) {
    Write-Error '[1/8] Frontend dependency install completed but root package-lock.json was not generated.'
    exit 22
}

Invoke-GateStep '[2/8] High-assurance static audit' { npm run audit:static }

Push-Location (Join-Path $Root 'server')
try {
    Invoke-GateStep '[3/8] Backend typecheck' { npm run typecheck }
    Invoke-GateStep '[4/8] Backend tests' { npm test }
    Invoke-GateStep '[5/8] Backend build' { npm run build }
    Invoke-GateStep '[6/8] Fresh schema preflight' { npm run preflight:fresh-schema }
} finally { Pop-Location }

Invoke-GateStep '[7/8] Frontend typecheck + lint + build' {
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run lint
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Invoke-GateStep '[8/8] Product integrity audit' { npm run audit:product }

Write-Host '=== RELEASE GATE PASSED ===' -ForegroundColor Green
