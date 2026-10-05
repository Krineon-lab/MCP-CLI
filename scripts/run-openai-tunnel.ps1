$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$LocalTunnel = Join-Path $Root ".rob-dc\bin\tunnel-client.exe"

if (-not $env:CONTROL_PLANE_API_KEY) { throw "Set CONTROL_PLANE_API_KEY to the runtime API key for tunnel-client." }
if (-not $env:ROB_DC_ALLOWED_DIRS) { $env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE }
if (-not $env:UV_THREADPOOL_SIZE) { $env:UV_THREADPOOL_SIZE = "8" }

if (Test-Path $LocalTunnel) {
    $TunnelClient = $LocalTunnel
} else {
    $cmd = Get-Command tunnel-client -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "tunnel-client was not found. Run .\scripts\install-tunnel-client.ps1 first." }
    $TunnelClient = $cmd.Source
}

Set-Location $Root
& $TunnelClient run --profile rob-desktop
