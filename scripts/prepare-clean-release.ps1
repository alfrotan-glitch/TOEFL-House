$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$forbidden = @('node_modules','dist','server/dist','server/data','.env','server/.env','work_rc2','work_final','erp_ultimate_final','final_work','final_repair')
foreach($rel in $forbidden){
  $p = Join-Path $root $rel
  if(Test-Path $p){ Remove-Item $p -Recurse -Force }
}
Write-Host 'Clean release tree prepared.' -ForegroundColor Green
