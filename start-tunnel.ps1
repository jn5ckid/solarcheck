param([int]$ApiPort = 8000)
$ErrorActionPreference = 'Stop'
$tunnelExe = Join-Path $PSScriptRoot 'tools\cloudflared.exe'
$runtimeDir = Join-Path $PSScriptRoot '.venv\tunnel'
$stateFile = Join-Path $runtimeDir 'state.json'
if (-not (Test-Path -LiteralPath $tunnelExe)) {
    throw 'Download official cloudflared to tools\cloudflared.exe first.'
}
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 5
if ($health.status -ne 'ok') { throw 'Start the SolarCheck API before opening the tunnel.' }
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if (Test-Path -LiteralPath $stateFile) {
    $old = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $old.processId -ErrorAction SilentlyContinue
    if ($existing -and $existing.Path -eq $tunnelExe -and $existing.StartTime.ToUniversalTime().ToString('o') -eq $old.startedAt) {
        if ($old.shareUrl) {
            Write-Output ('SolarCheck: https://jn5ckid.github.io/solarcheck/?api=' + [uri]::EscapeDataString($old.apiUrl))
            Write-Output ('Connection test: ' + $old.shareUrl)
            exit 0
        }
        throw 'The previous tunnel is still starting. Inspect .venv\tunnel\stderr.log.'
    }
}
$stderrFile = Join-Path $runtimeDir 'stderr.log'
$stdoutFile = Join-Path $runtimeDir 'stdout.log'
$tunnelProcess = Start-Process -FilePath $tunnelExe -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$ApiPort") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardError $stderrFile -RedirectStandardOutput $stdoutFile -PassThru
$state = [ordered]@{processId=$tunnelProcess.Id; startedAt=$tunnelProcess.StartTime.ToUniversalTime().ToString('o'); apiPort=$ApiPort; apiUrl=$null; shareUrl=$null}
$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Seconds 1
    $tunnelProcess.Refresh()
    if ($tunnelProcess.HasExited) { throw "Tunnel exited. Inspect $stderrFile" }
    $log = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
    $found = [regex]::Matches([string]$log, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($found.Count -gt 0) {
        $state.apiUrl = $found[$found.Count - 1].Value
        $state.shareUrl = 'https://jn5ckid.github.io/solarcheck/connection-test/?api=' + [uri]::EscapeDataString($state.apiUrl)
        $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
        Write-Output ('Tunnel PID: ' + $state.processId)
        Write-Output ('API: ' + $state.apiUrl)
        Write-Output ('Open: ' + $state.shareUrl)
        Write-Output ('SolarCheck: https://jn5ckid.github.io/solarcheck/?api=' + [uri]::EscapeDataString($state.apiUrl))
        exit 0
    }
}
throw "Tunnel URL was not ready within 45 seconds. Inspect $stderrFile"
