#Requires -Version 5.1
<#
  Starts the Ade OS desktop avatar and detaches it, so it outlives this shell.

  A plain `npm start` from an agent tool call dies with the parent process --
  the Job Object takes the whole tree down. Start-Process gives it its own
  process group, which is why this script exists rather than a one-liner.

    .\run-avatar.ps1            start it (no-ops if already running)
    .\run-avatar.ps1 -Status    report whether it is up
    .\run-avatar.ps1 -Stop      stop it
    .\run-avatar.ps1 -Restart   close it if open, then start
#>
[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Stop,
  [switch]$Restart,
  [string]$AdeUrl = 'http://127.0.0.1:8300'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $here 'node_modules\electron\dist\electron.exe'

function Get-AvatarProcs {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$here*" }
}

if ($Status) {
  $p = Get-AvatarProcs
  if ($p) { "avatar: running (pid $($p.ProcessId -join ', '))" } else { 'avatar: not running' }
  try {
    $h = Invoke-RestMethod -Uri "$AdeUrl/v1/health" -TimeoutSec 4
    "ade os: $($h.status) - $($h.subsystems.inference.detail)"
  } catch { "ade os: unreachable at $AdeUrl" }
  return
}

function Stop-Avatar {
  $p = Get-AvatarProcs
  if (-not $p) {
    Write-Host 'avatar: not running'
    return $false
  }
  foreach ($proc in $p) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "avatar: stopped ($($p.ProcessId -join ', '))"
  return $true
}

if ($Stop) {
  [void](Stop-Avatar)
  return
}

if ($Restart) {
  # A second start no-ops and keeps the old process -- so a voice or
  # main.js change never loads. Close first when we mean restart.
  if (Stop-Avatar) { Start-Sleep -Seconds 2 }
}

if (-not (Test-Path $electron)) {
  throw "Electron is not installed. Run `npm install` in $here first."
}
$running = Get-AvatarProcs
if ($running) {
  "avatar: already running (pid $($running.ProcessId -join ', ')) - nothing to do"
  return
}

$env:ADEOS_URL = $AdeUrl
Start-Process -FilePath $electron -ArgumentList $here -WorkingDirectory $here -WindowStyle Hidden
Start-Sleep -Milliseconds 900
$p = Get-AvatarProcs
if ($p) { "avatar: started (pid $($p.ProcessId -join ', '))" }
else     { 'avatar: failed to start - run `npm start` here to see the error' }
