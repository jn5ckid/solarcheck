$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $PSScriptRoot '.venv\tunnel\state.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output 'No saved SolarCheck tunnel.'; exit 0 }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$tunnelProcess = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
$expectedExe = Join-Path $PSScriptRoot 'tools\cloudflared.exe'
if (-not $tunnelProcess) { Write-Output 'Tunnel is already stopped.'; exit 0 }
if ($tunnelProcess.Path -ne $expectedExe -or $tunnelProcess.StartTime.ToUniversalTime().ToString('o') -ne $state.startedAt) {
    throw 'Process identity changed; no process was stopped.'
}
Stop-Process -Id $tunnelProcess.Id
Write-Output 'SolarCheck tunnel stopped. The API server was left running.'
